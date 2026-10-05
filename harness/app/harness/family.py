"""The iCloud Family calendar, pushed in by Home Assistant. Stores only.

Why a push: the Family Sharing calendar has no public or secret link, and
the harness may not use the Home Assistant API (that token could unlock
doors). Home Assistant already reads the calendar, so an automation there
sends a minimized copy here every 30 minutes: title, start, end. The
harness keeps the newest copy, lists it in the digest as Family context,
and does nothing else with it. It never interprets a Family event as his
obligation, never marks it as an overlap, and never answers the sender
with anything but a status code.

The listener is its own server on its own port (FAMILY_PORT), separate
from the Ingress page, on the add-on's internal network only: config.yaml
maps no host port. What it accepts, and nothing else:

  * POST /family from Home Assistant's address on that network;
  * Content-Type application/json, at most MAX_BODY bytes;
  * header X-Harness-Key, the shared key. It is generated inside Home
    Assistant and never travels anywhere else. While no key is pinned, the
    first well-formed key that arrives during an arming window is pinned
    (only its hash is kept): the window opens for ARM_FOR when the add-on
    starts unpinned, or from a button on the add-on page. Every later push
    must carry the same key. Any wrong-key push is counted and named in
    the next digest, even if good pushes keep arriving, so a squatter is
    loud. A full reset forgets the key;
  * a body that is exactly schema version 1 (below), whose generated_at
    is recent and newer than the last accepted one (no replays).

Schema 1, every key required, no others:
  {"v": 1, "entity": "calendar.family", "state": "<entity state>",
   "ok": true, "generated_at": "<ISO 8601 with offset>",
   "window_start": "<ISO>", "window_end": "<ISO>",
   "events": [{"summary": "...", "start": "<date or ISO>", "end": "<date or ISO>"}]}
`ok` false means Home Assistant could not read the calendar; events is
then empty and the digest says the source is unavailable.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import tempfile
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

from . import ical

log = logging.getLogger("harness.family")

FAMILY_PORT = 8100
PATH = "/family"
# Home Assistant Core runs in the host's network and reaches add-ons from the
# internal bridge's gateway address. Other host-network add-ons share it,
# which is why the key, not the address, is the authentication.
HA_PEER = "172.30.32.1"
ARM_FOR = timedelta(minutes=30)
MAX_CONCURRENT = 2
SAVE_REFUSALS_EVERY = timedelta(minutes=1)
MAX_BODY = 64 * 1024
MAX_EVENTS = 300
MAX_TITLE_IN = 1000
MAX_AGE = timedelta(hours=2)    # pushes come every 30 min; older than this is stale
MAX_SKEW_AHEAD = timedelta(minutes=2)
MAX_DELAY = timedelta(minutes=15)
MAX_WINDOW = timedelta(days=4)
KEY_RE = re.compile(r"[A-Za-z0-9_-]{32,128}")
KEYS = {"v", "entity", "state", "ok", "generated_at", "window_start", "window_end", "events"}
EVENT_KEYS = {"summary", "start", "end"}
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
LABEL = "Family"


class Rejected(ValueError):
    """A push that was refused. str(e) is a short reason, safe to show him."""


def _aware(s, what: str) -> datetime:
    if not isinstance(s, str) or len(s) > 40:
        raise Rejected(f"{what} is not a time")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        raise Rejected(f"{what} is not a time") from None
    if dt.tzinfo is None:
        raise Rejected(f"{what} has no time zone")
    return dt


def _when(s, what: str) -> date | datetime:
    if isinstance(s, str) and DATE_RE.fullmatch(s):
        try:
            return date.fromisoformat(s)
        except ValueError:
            raise Rejected(f"{what} is not a date") from None
    return _aware(s, what)


@dataclass(frozen=True)
class Push:
    generated_at: datetime
    entity: str
    state: str
    ok: bool
    window_start: datetime
    window_end: datetime
    events: tuple            # ((summary, start, end), ...) start/end date or datetime


def parse(body: bytes, *, entity: str, now: datetime,
          last_generated: datetime | None) -> Push:
    """Strict: anything unexpected is refused, never guessed at."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Rejected("not JSON") from None
    if not isinstance(data, dict) or set(data) != KEYS:
        raise Rejected("wrong shape")
    if data["v"] != 1 or isinstance(data["v"], bool):
        raise Rejected("unknown version")
    if data["entity"] != entity:
        raise Rejected("wrong calendar")
    if not isinstance(data["state"], str) or len(data["state"]) > 32:
        raise Rejected("bad state")
    if not isinstance(data["ok"], bool):
        raise Rejected("bad ok flag")
    gen = _aware(data["generated_at"], "generated_at")
    if gen > now + MAX_SKEW_AHEAD:
        raise Rejected("from the future")
    if now - gen > MAX_DELAY:
        raise Rejected("too old")
    if last_generated is not None and gen <= last_generated:
        raise Rejected("replayed")
    ws = _aware(data["window_start"], "window_start")
    we = _aware(data["window_end"], "window_end")
    if not ws < we or we - ws > MAX_WINDOW:
        raise Rejected("bad window")
    evs = data["events"]
    if not isinstance(evs, list) or len(evs) > MAX_EVENTS:
        raise Rejected("bad events")
    if not data["ok"] and evs:
        raise Rejected("events without a read")
    out = []
    for e in evs:
        if not isinstance(e, dict) or set(e) != EVENT_KEYS:
            raise Rejected("bad event")
        title = e["summary"]
        if title is None:
            title = ""
        if not isinstance(title, str) or len(title) > MAX_TITLE_IN:
            raise Rejected("bad title")
        s, t = _when(e["start"], "start"), _when(e["end"], "end")
        if isinstance(s, datetime) != isinstance(t, datetime):
            raise Rejected("mixed all-day and timed")
        if t < s:
            raise Rejected("ends before it starts")
        out.append((title, s, t))
    return Push(gen, data["entity"], data["state"], data["ok"], ws, we, tuple(out))


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode("ascii")).hexdigest()


class FamilyInbox:
    """The newest accepted push, the pinned key's hash, and the last
    refusal. Shared by the listener threads and the controller; persisted
    in one small file in /data so a restart keeps it."""

    def __init__(self, path: str, clock, *, entity: str = "calendar.family"):
        self.path = path
        self.clock = clock
        self.entity = entity
        self._lock = threading.Lock()
        self._d = self._load()
        self._armed_until = None
        self._refusal_saved_at = None
        if not self._d.get("key_hash"):
            self.arm()

    # -- storage ---------------------------------------------------------------
    def _load(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            return {}
        if not isinstance(d, dict):
            return {}
        try:                                  # a damaged file is a fresh start, not a crash
            last = d.get("last")
            if last is not None:
                datetime.fromisoformat(last["received_at"])
                datetime.fromisoformat(last["generated_at"])
                datetime.fromisoformat(last["window_start"])
                datetime.fromisoformat(last["window_end"])
                assert isinstance(last["ok"], bool) and isinstance(last["state"], str)
                for t, a, b in last["events"]:
                    assert isinstance(t, str)
                    _when(a, "start"), _when(b, "end")
            for k in ("rejected", "wrong_key"):
                if d.get(k) is not None:
                    datetime.fromisoformat(d[k]["at"])
            for t in (d.get("wrong_key") or {"times": []})["times"]:
                datetime.fromisoformat(t)
            if d.get("key_hash") is not None:
                assert isinstance(d["key_hash"], str) and len(d["key_hash"]) == 64
        except (KeyError, TypeError, ValueError, AssertionError, Rejected):
            return {}
        return d

    def _save(self) -> None:
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".family.", suffix=".tmp")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._d, f, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
            dfd = os.open(d, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise

    # -- the listener's side -----------------------------------------------------
    def arm(self) -> None:
        """Open the window in which an unpinned key may be pinned."""
        with self._lock:
            self._armed_until = self.clock() + ARM_FOR

    def refuse(self, reason: str) -> None:
        """Record a refusal that happened before a body was read."""
        with self._lock:
            self._refused(self.clock(), reason)

    def _refused(self, now: datetime, reason: str) -> None:
        self._d["rejected"] = {"at": now.isoformat(), "reason": reason}
        if reason == "wrong key":
            times = ((self._d.get("wrong_key") or {}).get("times") or [])[-49:]
            self._d["wrong_key"] = {"at": now.isoformat(), "times": times + [now.isoformat()]}
        # Kept in memory at once; written at most once a minute, so a
        # flood of bad pushes can't wear out the Pi's storage.
        if (self._refusal_saved_at is None
                or now - self._refusal_saved_at >= SAVE_REFUSALS_EVERY):
            self._refusal_saved_at = now
            self._save()

    def receive(self, key: str, body: bytes) -> None:
        """Accept a push or raise Rejected. Records refusals too."""
        now = self.clock()
        with self._lock:
            try:
                if not KEY_RE.fullmatch(key or ""):
                    raise Rejected("no key")
                pinned = self._d.get("key_hash")
                if pinned and not hmac.compare_digest(pinned, _hash(key)):
                    raise Rejected("wrong key")
                if not pinned and (self._armed_until is None or now > self._armed_until):
                    raise Rejected("not accepting a new key")
                last = self._d.get("last", {}).get("generated_at")
                push = parse(body, entity=self.entity, now=now,
                             last_generated=datetime.fromisoformat(last) if last else None)
            except Rejected as e:
                self._refused(now, str(e))
                raise
            if not pinned:
                self._d["key_hash"] = _hash(key)
                self._d["key_pinned_at"] = now.isoformat()
                log.info("family: key pinned")
            self._d["last"] = {
                "received_at": now.isoformat(),
                "generated_at": push.generated_at.isoformat(),
                "state": push.state, "ok": push.ok,
                "window_start": push.window_start.isoformat(),
                "window_end": push.window_end.isoformat(),
                "events": [[t, s.isoformat(), e.isoformat()] for t, s, e in push.events],
            }
            self._save()

    def forget(self) -> None:
        """Reset: drop the key and the events. Not armed: a new key needs
        the button on the add-on page (or a restart of the add-on)."""
        with self._lock:
            self._d = {}
            self._armed_until = None
            self._save()

    # -- the controller's side ------------------------------------------------------
    def status(self) -> dict:
        """received_at / generated_at / ok / state / events count, the
        last refusal, and when the key was pinned. No titles."""
        with self._lock:
            last = dict(self._d.get("last") or {})
            rej = dict(self._d.get("rejected") or {})
            pinned = self._d.get("key_pinned_at")
            armed = (self._armed_until is not None and not pinned
                     and self.clock() <= self._armed_until)
        return {"received_at": last.get("received_at"), "ok": last.get("ok"),
                "state": last.get("state"), "events": len(last.get("events") or []),
                "rejected_at": rej.get("at"), "rejected": rej.get("reason"),
                "key_pinned_at": pinned, "armed": armed}

    def view(self, now: datetime, tz: str, day_start: datetime, day_end: datetime,
             since: datetime | None = None):
        """What the digest may say about Family today: FamilyView.
        `wrong_keys` counts wrong-key pushes after `since` (the last digest)."""
        with self._lock:
            last = self._d.get("last")
            rej = self._d.get("rejected")
            wk = self._d.get("wrong_key")
        rejected = ""
        if rej and (not last or rej["at"] > last["received_at"]):
            rejected = rej["reason"]
        wrong = 0
        if wk:
            wrong = sum(1 for t in wk["times"]
                        if since is None or datetime.fromisoformat(t) > since)
        if not last:
            return FamilyView("never", None, rejected, [], wrong)
        received = datetime.fromisoformat(last["received_at"])
        if now - received > MAX_AGE:
            return FamilyView("stale", received, rejected, [], wrong)
        if not last["ok"] or last["state"] in ("unavailable", "unknown"):
            return FamilyView("unavailable", received, rejected, [], wrong)
        ws = datetime.fromisoformat(last["window_start"])
        we = datetime.fromisoformat(last["window_end"])
        if ws > day_start or we < day_end:
            # Fresh, but not about today: most likely a time zone mismatch.
            return FamilyView("window", received, rejected, [], wrong)
        local = ZoneInfo(tz)
        occ = []
        for title, s, e in last["events"]:
            s, e = _when(s, "start"), _when(e, "end")
            all_day = not isinstance(s, datetime)
            if not ical._overlaps(s, e, day_start, day_end, local):
                continue
            title = " ".join(str(title).split())[:ical.MAX_SUMMARY] or "(no title)"
            # transparent: Family is context; it never counts as an overlap.
            occ.append(ical.Occurrence(s, e, all_day, title, LABEL, True))
        return FamilyView("fresh", received, rejected, occ, wrong)


@dataclass(frozen=True)
class FamilyView:
    status: str                  # "never" | "stale" | "unavailable" | "window" | "fresh"
    received_at: datetime | None
    rejected: str                # the last refusal, if it came after the last push
    occurrences: list
    wrong_keys: int = 0          # wrong-key pushes since the last digest


def make_handler(inbox: FamilyInbox, allowed_peers: tuple[str, ...]):
    class Handler(BaseHTTPRequestHandler):
        server_version = "harness"
        sys_version = ""
        timeout = 10                            # a stalled sender is dropped, not waited on

        def log_message(self, fmt, *args):      # never the body, never the key
            pass

        def _send(self, status: int, text: str = ""):
            data = text.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            if data:
                self.wfile.write(data)

        def do_GET(self):
            return self._send(HTTPStatus.METHOD_NOT_ALLOWED)

        do_PUT = do_DELETE = do_PATCH = do_HEAD = do_GET

        def do_POST(self):
            if self.path != PATH:
                inbox.refuse("wrong path")
                return self._send(HTTPStatus.NOT_FOUND)
            ctype = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if ctype != "application/json":
                inbox.refuse("not JSON")
                return self._send(HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            try:
                n = int(self.headers.get("Content-Length", ""))
            except ValueError:
                inbox.refuse("no length")
                return self._send(HTTPStatus.LENGTH_REQUIRED)
            if n <= 0 or n > MAX_BODY:
                inbox.refuse("too big")
                return self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            body = self.rfile.read(n)
            try:
                inbox.receive(self.headers.get("X-Harness-Key", "").strip(), body)
            except Rejected as e:
                log.warning("family: refused a push (%s)", e)
                code = (HTTPStatus.UNAUTHORIZED if str(e) in ("no key", "wrong key")
                        else HTTPStatus.CONFLICT if str(e) == "replayed"
                        else HTTPStatus.BAD_REQUEST)
                return self._send(code, str(e))
            return self._send(HTTPStatus.NO_CONTENT)

    return Handler


class _Server(ThreadingHTTPServer):
    """Checks the address before a thread is started for a connection, and
    runs at most MAX_CONCURRENT at once: one push every 30 minutes needs
    no more, and a stalled or hostile sender can't pile up threads."""
    daemon_threads = True
    request_queue_size = 4

    def __init__(self, addr, handler, allowed_peers):
        self.allowed_peers = allowed_peers
        self.slots = threading.BoundedSemaphore(MAX_CONCURRENT)
        super().__init__(addr, handler)

    def verify_request(self, request, client_address):
        if client_address[0] not in self.allowed_peers:
            log.warning("family: refused a connection from %s", client_address[0])
            return False
        if not self.slots.acquire(blocking=False):
            return False
        return True

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def serve(inbox: FamilyInbox, host: str = "0.0.0.0", port: int = FAMILY_PORT, *,
          allowed_peers: tuple[str, ...] = (HA_PEER,)) -> ThreadingHTTPServer:
    httpd = _Server((host, port), make_handler(inbox, allowed_peers), allowed_peers)
    httpd.timeout = 10
    t = threading.Thread(target=httpd.serve_forever, name="family", daemon=True)
    t.start()
    return httpd
