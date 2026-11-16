"""Cain hands a calendar request over to the keeper here.

Cain is the conversation; the keeper writes calendars. When he asks Cain for a
calendar change, Cain calls this endpoint and passes nothing he said: the
keeper reads the DM itself (controller._handover) and acts only on his own
words. Cain may name the message it rests on (keeper.sh handover --message <id>):
then it's that message, if it's his and from the last 30 minutes, whatever he
sent after it (Nov 15: three messages in a minute, and the handover for the
second read the third). Without one, it's his newest message, from the last 2
minutes. If Cain wants to pass a suggestion of its own (a date it found in an
email, say), it may, and then any change gets a card to tap: Cain's words never
change a calendar by themselves.

- Local only: the add-ons' own network on the Pi, port 8098, never published
  to the LAN (no "ports:" in config.yaml).
- Keyed: the caller must show HMAC-SHA256(bot token, KEY_CONTEXT). Both add-ons
  already hold the token, so there is nothing to set up, and resetting the
  token changes the key too. Without it, another add-on could read his rules
  or spend his messages.
- The answer waits for the result, up to WAIT_S, so Cain never says "done"
  before it is.

Also here: /digest (Cain takes today's calendar digest for his one morning
message), /morning-posted (Cain's link says that message is out), /press
(a tap on one of this add-on's cards, checked by Cain's link and passed back),
/meanings (what Dane told Cain kinds of Family events mean, from his record:
short rows, checked strictly here before anything is queued; meaning_live.py), and
/places (his place book, where the places named on Family are; checked the same way;
places.py). GET /health is for Cain's half of the mutual watch (watch.py): it
answers "ok" while the controller loop is turning, and "stuck" when it hasn't
for STUCK_S, so a hung loop counts as down. The clock starts at the loop's first
turn ("starting" until then), and the loop beats between its phases.

The HTTP thread never touches the ledger: it queues the request for the
controller and waits on an event.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import queue
import re
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

log = logging.getLogger("harness.handover")

PORT = 8098
KEY_CONTEXT = b"harness-handover-v1"
WAIT_S = 25
MAX_BODY = 4096
MAX_SUGGESTION = 1500
MAX_MEANINGS_BODY = 16384             # up to 60 short rows, or the place book
PRESS_WAIT_S = 8                      # a tap's answer to Cain's link waits this long at most (its own limit is 10 s)
TAP_JOURNAL = ".taps.jsonl"           # beside the ledger: taps written down before they're taken (fourteenth round)
FENCED_TAP = ("Not taken: Harness is waiting to restart so its records can be put back from a backup. Restart the "
              "Harness App in Home Assistant now. Nothing changed.")
# Fifteenth round: a tap that couldn't be written down is refused (never "working"), and he hears it.
UNRECORDED_TAP = "Not taken: Harness couldn't write your tap down, so nothing changed."
# Fifteenth round: the no-ledger degraded start refuses taps at once, through the link's answer route.
DEGRADED_TAP = ("Not taken: Harness started without its records, so it takes nothing until it starts normally. "
                "Nothing changed.")
ROUTES = ("/handover", "/digest", "/press", "/morning-posted", "/meanings", "/places", "/fastpath")
BIG = ("/meanings", "/places")
STUCK_S = 10 * 60


def _message_id(value) -> str:
    """A Discord message id, digits only, or nothing: anything else isn't one."""
    text = str(value or "").strip()
    return text if text.isdigit() and len(text) <= 24 else ""


def _run_id(value) -> str:
    """A smoke run's id (calendar_change.smoke_start: hex), or nothing."""
    text = str(value or "").strip().lower()
    return text if text and len(text) <= 32 and all(c in "0123456789abcdef" for c in text) else ""


def _calendar(value) -> str:
    """gate-open's calendar: gmail or family, or nothing."""
    text = str(value or "").strip().lower()
    return text if text in ("gmail", "family") else ""


def _step_name(value) -> str:
    """smoke-step's step name (ninth round): a short slug of lowercase letters, digits and dashes, or nothing."""
    text = str(value or "").strip().lower()
    return text if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", text) else ""


def _script(value) -> dict:
    """smoke-step's script (tenth round): only its known fields, as short strings; checked strictly by
    calendar_change.check_script."""
    if not isinstance(value, dict):
        return {}
    return {k: str(value.get(k) or "")[:80] for k in ("calendar", "kind", "day", "title", "times") if value.get(k)}


def _ledger_path(value) -> str:
    """migrate-check's ledger file: an absolute path of plain characters, or nothing (the live ledger)."""
    text = str(value or "").strip()
    if not text or len(text) > 256 or not text.startswith("/") or ".." in text.split("/"):
        return ""
    return text if all(c.isalnum() or c in "/._-" for c in text) else ""


def _restore_key(value) -> str:
    """migrate-restore's backup key (twelfth round): "<schema> <build>", a whole number and a build id of
    plain characters, or nothing."""
    text = " ".join(str(value or "").split())
    return text if re.fullmatch(r"[0-9]{1,4} [0-9A-Za-z._-]{4,64}", text) else ""


def _fsync_dir(folder: str) -> None:
    """A file's creation, rename or removal is durable only once its folder's entry is on disk."""
    try:
        fd = os.open(folder, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def key_for(token: str) -> str:
    return hmac.new(token.encode(), KEY_CONTEXT, hashlib.sha256).hexdigest()


@dataclass
class Handover:
    kind: str = "handover"               # or digest, press, morning-posted, meanings, places
    suggestion: str = ""
    rows: list = field(default_factory=list)   # /meanings, /places: already checked
    press: dict = field(default_factory=dict)
    paired: str = ""                     # the Discord user Cain is paired with
    message: str = ""                    # the Discord message of his it rests on, when Cain names one
    state: str = ""                      # /fastpath: "smoke-start", "on" or "off"
    run: str = ""                        # /fastpath on: the smoke run's id, from smoke-start
    smoke: str = ""                      # /fastpath: free text from before 0.24.0's fifth round: refused
    record: dict = field(default_factory=dict)   # /fastpath: a pass or fail record from before the sixth round: ignored
    calendar: str = ""                   # /fastpath gate-open: "gmail" or "family" (eighth round)
    path: str = ""                       # /fastpath migrate-check: a ledger file to copy and migrate (eighth round)
    step: str = ""                       # /fastpath smoke-step: the step's name (ninth round)
    smoke_run: str = ""                  # /handover: names the smoke run; never its step (tenth round)
    script: dict = field(default_factory=dict)   # /fastpath smoke-step: the step's script (tenth round)
    candidate: str = ""                  # /fastpath migrate-check: the incoming build's tree or image (tenth round)
    restore: str = ""                    # /fastpath migrate-restore: "<schema> <build>" of a backup (twelfth round)
    done: threading.Event = field(default_factory=threading.Event)
    result: dict = field(default_factory=dict)
    arrived: float = field(default_factory=time.monotonic)
    age: float | None = None             # how old his message was when Cain handed it over
    job: str = ""                        # the job's short id: for the log, never for him
    journaled: bool = False              # /press: written to the tap journal (fourteenth round)
    told: bool = False                   # /press: he was told once that it waits (fourteenth round)
    intent: bool = False                 # /press: its execution intent is in the journal (seventeenth round)

    def finish(self, status: str, said: str = "", **extra) -> None:
        if not self.done.is_set():
            self.result = {"status": status, "said": said, **extra}
            took = time.monotonic() - self.arrived
            # Outcome and timing only: never his words. The target is 20 s from his message.
            log.info("%s: %s, %.1fs here%s%s", self.kind, status, took,
                     f", {self.age + took:.0f}s after his message" if self.age is not None else "",
                     f", job {self.job}" if self.job else "")
            self.done.set()


def _row_key(r: dict, key: Callable[[dict], str]) -> str:
    """The tap a journal line belongs to."""
    if isinstance(r.get("press"), dict):
        return key(r["press"])
    for field_ in ("intent", "committed", "outcome", "delivered", "check"):
        if field_ in r:
            return str(r.get(field_) or "")
    return str(r.get("key") or "")


class Inbox:
    def __init__(self, token_fn: Callable[[], str], wake: threading.Event | None = None, *, journal: str,
                 staged: Callable[[], bool] | None = None,
                 answer: Callable[[str, str], None] | None = None, refusing: str = "",
                 _journal_less: bool = False):
        # Sixteenth round: the tap journal is a required argument. Only the no-ledger degraded start (which refuses
        # every tap at once and queues nothing) and tests (Inbox.for_tests) may go without one.
        if not journal and not refusing and not _journal_less:
            raise ValueError("the tap journal's path is required")
        self._token_fn = token_fn
        self.queue: "queue.Queue[Handover]" = queue.Queue()
        self._front: list[Handover] = []     # fourteenth round: items given back by the controller, taken first
        self._lock = threading.Lock()
        self.wake = wake
        # Fourteenth round: every tap is written to this journal (one JSON line, flushed to disk) before Cain's
        # link hears it was taken, and struck off only once the controller has committed what it did; a tap
        # left in it at the next start is taken then, or he is told (Controller._replay_taps). "" for none.
        self.journal = journal
        self.staged = staged or (lambda: False)   # a restore is staged: a tap is answered at once, not queued
        self.fenced = ""                          # the controller's fence reason, once it has seen the staged restore
        self.answer = answer                      # posts a short note to him on a tap (the link's /answer)
        # Fifteenth round: the no-ledger degraded start: every tap is refused at once with DEGRADED_TAP, and he
        # hears it through the link's answer route; never queued.
        self.refusing = refusing
        self.beat_at: float | None = None    # the controller loop's last turn; None: not yet
        self.migration: dict = {}            # twelfth round: the ledger waiting for its move (migrate.waiting_summary)
        self.degraded = ""                   # thirteenth round: why it started without its records, or ""

    @classmethod
    def for_tests(cls, token_fn: Callable[[], str], wake: threading.Event | None = None, **kw) -> "Inbox":
        """Sixteenth round: tests only. An inbox with no tap journal (taps are queued, never written down)."""
        kw.setdefault("journal", "")
        return cls(token_fn, wake, _journal_less=True, **kw)

    def beat(self) -> None:
        self.beat_at = time.monotonic()

    def health(self) -> dict:
        extra = {"migration": dict(self.migration)} if self.migration else {}
        if self.degraded:
            return {"status": "degraded", "why": self.degraded, "loop_age_s": None, **extra}
        if self.beat_at is None:
            return {"status": "starting", "loop_age_s": None, **extra}
        age = time.monotonic() - self.beat_at
        # Fifteenth round: while a staged restore fences the records the loop still turns and is judged by its own
        # beat, marked fenced beside it, so a stall or a dead loop never passes for a staged restore.
        fenced = {"fenced": True} if self.fenced else {}
        return {"status": "ok" if age < STUCK_S else "stuck", "loop_age_s": int(age), **fenced, **extra}

    def key_ok(self, presented: str) -> bool:
        token = self._token_fn()
        return bool(token) and bool(presented) and hmac.compare_digest(key_for(token), presented)

    def submit(self, h: Handover) -> None:
        self.queue.put(h)
        if self.wake is not None:
            self.wake.set()

    def pending(self) -> int:
        """Handovers and taps queued for the controller's thread, not taken yet (thirteenth round)."""
        with self._lock:
            front = len(self._front)
        return front + self.queue.qsize()

    def give_back(self, items: list[Handover]) -> None:
        """Fourteenth round: items the controller couldn't take now (the ledger busy) go back to the front of
        the queue, in order, to be taken first next time. Never dropped."""
        if not items:
            return
        with self._lock:
            self._front[:0] = list(items)

    # -- the tap journal (fourteenth round; fifteenth: commits in the journal itself; sixteenth: intents, outcomes)
    #
    # One JSON line per record, appended and fsynced, each write's result checked:
    #   {"press", "at"}                     the tap, written down before Cain's link hears it was taken;
    #   {"intent": key, "op", "at"}         sixteenth round: about to act on it (before the records change and before
    #                                       any calendar write it leads to); "op" names its calendar effect by a
    #                                       stable identity (the proposal and its fixed event ids), or none;
    #   {"committed": key, "at"}            what it did is committed in the records: its outcome, done;
    #   {"outcome": key, "kind", "note"}    sixteenth round: a terminal outcome other than done ("refused", or
    #                                       "found": the calendar already shows it), written before the note;
    #   {"delivered": key, "at"}            sixteenth round: that note reached him.
    # A tap with an intent and no outcome is "outcome unknown", never "not carried out". A tap's lines are struck
    # off (the file rewritten without them) only once its outcome is recorded and, for a note, delivered. A line
    # that can't be read (a torn tail) is skipped, never the whole file. {"notice", "key"} lines from the fifteenth
    # round read as a refusal whose note wasn't delivered.

    @staticmethod
    def key(press: dict) -> str:
        return f"{str((press or {}).get('id', ''))}|{str((press or {}).get('custom_id', ''))}"

    def _journal_lines(self) -> list[dict]:
        rows = []
        try:
            with open(self.journal, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        log.error("a line of the tap journal couldn't be read; skipped")
                        continue
                    if isinstance(row, dict):
                        rows.append(row)
        except FileNotFoundError:
            return []
        except OSError:
            log.error("the tap journal couldn't be read")
            return []
        return rows

    def _append(self, row: dict) -> bool:
        """One line appended, written whole and fsynced, or not at all: a short write or a failed fsync is cut
        back off (best effort) and counts as not written."""
        data = (json.dumps(row) + "\n").encode()
        with self._lock:
            try:
                new = not os.path.exists(self.journal)
                fd = os.open(self.journal, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            except OSError as e:
                log.error("the tap journal couldn't be opened: %s", type(e).__name__)
                return False
            try:
                size = os.fstat(fd).st_size
                try:
                    wrote = os.write(fd, data)
                    if wrote != len(data):
                        raise OSError(f"short write ({wrote} of {len(data)} bytes)")
                    os.fsync(fd)
                except OSError as e:
                    log.error("the tap journal couldn't be written: %s", e)
                    try:
                        os.ftruncate(fd, size)
                        os.fsync(fd)
                    except OSError:
                        pass
                    return False
            finally:
                os.close(fd)
            if new:
                _fsync_dir(os.path.dirname(os.path.abspath(self.journal)))
        return True

    def journal_add(self, h: Handover) -> bool:
        """Writes the tap down (appended and fsynced) before Cain's link hears it was taken. Whether it was
        written whole: fifteenth round, a tap that wasn't is refused, never queued."""
        if not self.journal:
            return False
        if not self._append({"press": {k: str(v) for k, v in h.press.items()}, "at": time.time()}):
            return False
        h.journaled = True
        return True

    def journal_intent(self, press: dict, op: dict | None = None) -> bool:
        """Sixteenth round: about to act on the tap, written (fsynced) before the records change and before any
        calendar write it leads to. Whether it was written: a tap whose intent can't be written isn't acted on."""
        if not self.journal or not press:
            return False
        return self._append({"intent": self.key(press), "op": dict(op or {}), "at": time.time()})

    def journal_commit(self, press: dict) -> bool:
        """Fifteenth round: what the tap did is committed in the ledger. Recorded in the journal itself, before
        the tap is struck off, so a replay never acts twice even when the ledger is later put back from a backup
        that predates it. Sixteenth round: the caller checks the result; a failure is logged and told."""
        if not self.journal or not press:
            return False
        return self._append({"committed": self.key(press), "at": time.time()})

    def journal_outcome(self, press: dict, kind: str, note: str = "") -> bool:
        """Sixteenth round: the tap's terminal outcome ("refused", or "found": the calendar already shows it) and the
        note owed to him, written (fsynced) before the note is posted, so a tap with one is never taken again."""
        if not self.journal or not press:
            return False
        return self._append({"outcome": self.key(press), "kind": kind, "note": note, "at": time.time()})

    def journal_check(self, press: dict, n: int, next_at: float, told: bool) -> bool:
        """Eighteenth round: an unknown tap read on the calendar by its identity that couldn't settle yet (the read
        couldn't answer, or Harness's own records are still carrying it out): how many reads it has had, when the
        next one is (seconds since the epoch, on the records' clock), and whether he's been told it waits."""
        if not self.journal or not press:
            return False
        return self._append({"check": self.key(press), "n": int(n), "next": float(next_at), "told": bool(told),
                             "at": time.time()})

    def journal_delivered(self, press: dict) -> bool:
        """Sixteenth round: the note on that tap reached him; at the next start it isn't posted again."""
        if not self.journal or not press:
            return False
        return self._append({"delivered": self.key(press), "at": time.time()})

    def journal_done(self, press: dict) -> None:
        """Strikes a tap off (all its lines) once what it did is committed, or he has been told it wasn't taken."""
        if not self.journal or not press:
            return
        key = self.key(press)

        def mine(r: dict) -> bool:
            return _row_key(r, self.key) == key
        with self._lock:
            rows = self._journal_lines()
            keep = [r for r in rows if not mine(r)]
            if len(keep) == len(rows):
                return
            try:
                if not keep:
                    os.remove(self.journal)
                else:
                    tmp = self.journal + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as f:
                        f.write("".join(json.dumps(r) + "\n" for r in keep))
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(tmp, self.journal)
                _fsync_dir(os.path.dirname(os.path.abspath(self.journal)))
            except OSError as e:
                log.error("the tap journal couldn't be updated: %s", type(e).__name__)

    def journaled(self) -> list[dict]:
        """The taps written down and not yet struck off, oldest first, each {"press", "at", "intent", "op",
        "committed", "outcome", "note", "delivered", "state"}. state: "committed" (its outcome, done, is recorded),
        "refused" or "found" (a terminal outcome other than done), "unknown" (an intent and no outcome: it may or may
        not have been carried out), or "not_started" (written down, never acted on)."""
        if not self.journal:
            return []
        with self._lock:
            rows = self._journal_lines()
        taps: dict[str, dict] = {}
        for r in rows:
            if isinstance(r.get("press"), dict):
                k = self.key(r["press"])
                taps.setdefault(k, {"press": {a: str(b) for a, b in r["press"].items()}, "at": r.get("at"),
                                    "intent": False, "op": {}, "committed": False, "outcome": "", "note": "",
                                    "delivered": False, "checks": 0, "next_check": None, "told_check": False})
                continue
            k = _row_key(r, self.key)
            t = taps.get(k)
            if t is None:
                continue
            if "intent" in r:
                t["intent"] = True
                t["op"] = r.get("op") if isinstance(r.get("op"), dict) else {}
            elif "committed" in r:
                t["committed"] = True
            elif "outcome" in r and not t["outcome"]:
                t["outcome"] = str(r.get("kind") or "refused")
                t["note"] = str(r.get("note") or "")
            elif "notice" in r and not t["outcome"]:      # the fifteenth round's pending note
                t["outcome"], t["note"] = "refused", str(r.get("notice") or "")
            elif "delivered" in r:
                t["delivered"] = True
            elif "check" in r:
                try:
                    t["checks"], t["next_check"] = int(r.get("n") or 0), float(r.get("next"))
                except (TypeError, ValueError):
                    t["checks"], t["next_check"] = t["checks"] + 1, 0.0
                t["told_check"] = t["told_check"] or bool(r.get("told"))
        for t in taps.values():
            t["state"] = ("committed" if t["committed"] else t["outcome"] if t["outcome"]
                          else "unknown" if t["intent"] else "not_started")
        return list(taps.values())

    def row_for(self, press: dict) -> dict | None:
        """One tap's journal entry (journaled), or None."""
        key = self.key(press)
        return next((t for t in self.journaled() if self.key(t["press"]) == key), None)

    def queued_keys(self) -> set[str]:
        """Fifteenth round: the taps queued for the controller now, read under the queue's own mutex."""
        with self._lock, self.queue.mutex:
            items = list(self._front) + list(self.queue.queue)
        return {self.key(h.press) for h in items if h.kind == "press"}

    def notify(self, h: Handover, text: str, kind: str = "refused") -> bool:
        """The one terminal note to him on a tap. Sixteenth round: durable, not an in-memory flag. For a tap written
        down, its outcome and note are appended (fsynced) to the journal first; a note already recorded there is
        the one posted, and one already delivered isn't posted again; once it goes, its delivery is recorded.
        Whether he has been told."""
        if not (h.journaled and self.journal):
            return self.tell(h, text)
        row = self.row_for(h.press)
        if row is not None and row["outcome"]:
            if row["delivered"]:
                return True
            text = row["note"] or text
        elif not self.journal_outcome(h.press, kind, text):
            log.error("a tap's outcome couldn't be written to the tap journal; he's told all the same")
        if not self.tell(h, text):
            return False
        if not self.journal_delivered(h.press):
            log.error("a note's delivery couldn't be written to the tap journal")
        return True

    def tell(self, h: Handover, text: str) -> bool:
        """A short note to him on that tap (the link's follow-up to its deferred answer). Whether it went."""
        p = h.press
        if self.answer is None or not p.get("token"):
            return False
        try:
            self.answer(f"{p.get('app', '')}:{p.get('token', '')}", text)
            return True
        except Exception as e:                 # noqa: BLE001: a note that didn't go changes nothing
            log.info("a note on a tap couldn't be posted: %s", type(e).__name__)
            return False

    def take(self) -> list[Handover]:
        with self._lock:
            out, self._front = self._front, []
        while True:
            try:
                out.append(self.queue.get_nowait())
            except queue.Empty:
                return out


def _handler(inbox: Inbox, wait_s: float):
    class H(BaseHTTPRequestHandler):
        server_version = "harness"

        def log_message(self, *a):          # no request lines with addresses in the log
            pass

        def _reply(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path not in ROUTES:
                return self._reply(404, {"status": "not found"})
            if not inbox.key_ok(self.headers.get("x-harness-key", "")):
                log.warning("handover refused: wrong key")
                return self._reply(403, {"status": "refused"})
            try:
                n = int(self.headers.get("content-length") or 0)
            except ValueError:
                n = -1
            if n < 0 or n > (MAX_MEANINGS_BODY if self.path in BIG else MAX_BODY):
                return self._reply(413, {"status": "too large"})
            try:
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            except ValueError:
                return self._reply(400, {"status": "not JSON"})
            if not isinstance(body, dict):
                return self._reply(400, {"status": "not JSON"})
            rows: list = []
            if self.path == "/meanings":
                from .meaning_live import validate_rows
                checked, why = validate_rows(body)
                if checked is None:
                    return self._reply(400, {"status": "refused", "said": why})
                rows = checked
            elif self.path == "/places":
                from .places import validate_rows as validate_places
                checked, why = validate_places(body)
                if checked is None:
                    return self._reply(400, {"status": "refused", "said": why})
                rows = checked
            h = Handover(kind=self.path.strip("/"), rows=rows,
                         suggestion=str(body.get("suggestion") or "")[:MAX_SUGGESTION].strip(),
                         paired=str(body.get("paired") or "").strip(),
                         message=_message_id(body.get("message")),
                         state=str(body.get("state") or "").strip().lower()[:16],
                         run=_run_id(body.get("run")),
                         smoke=str(body.get("smoke") or "")[:MAX_SUGGESTION].strip(),
                         record=body.get("record") if isinstance(body.get("record"), dict) else {},
                         calendar=_calendar(body.get("calendar")),
                         path=_ledger_path(body.get("path")),
                         step=_step_name(body.get("step")),
                         smoke_run=_run_id(body.get("smoke_run")),
                         script=_script(body.get("script")),
                         candidate=_ledger_path(body.get("candidate")),
                         restore=_restore_key(body.get("restore")),
                         press={k: str(body.get(k, "")) for k in
                                ("id", "token", "app", "custom_id", "message_id")})
            if h.kind == "press":
                return self._press(h)
            inbox.submit(h)
            if not h.done.wait(wait_s):
                return self._reply(202, {"status": "working", "said": (
                    "Still working on it. The keeper will post the result in the DM.")})
            self._reply(200, h.result)

        def _press(self, h: Handover):
            """Fourteenth round: Cain's link has already given Discord its deferred answer (the tap is seen,
            nothing said yet). While a restore is staged the tap is answered at once that nothing is taken until
            the restart, and never queued. Otherwise it's written to the tap journal first, then queued for the
            controller's thread, and this answers once the controller has committed what it did (its note to
            him is the follow-up), or after PRESS_WAIT_S with "working": the tap is then written down, so a stop
            before the controller takes it loses nothing (the next start takes it, or tells him).

            Fifteenth round: a tap that couldn't be written down whole (a failed append, a short write, a failed
            fsync) is refused, never "working", and he's told nothing changed; in the no-ledger degraded start
            every tap is refused at once the same way. Once a tap is queued, the controller alone settles what he
            hears about it (Inbox.notify, once), never this waiter."""
            refused = (DEGRADED_TAP if inbox.refusing else (inbox.fenced or FENCED_TAP)
                       if inbox.fenced or inbox.staged() else "")
            if refused:
                h.finish("refused", refused, **({"degraded": True} if inbox.refusing else {"restore_staged": True}))
                inbox.notify(h, refused)
                return self._reply(200, h.result)
            if inbox.journal and not inbox.journal_add(h):
                h.finish("refused", UNRECORDED_TAP, journaled=False)
                inbox.notify(h, UNRECORDED_TAP)
                return self._reply(200, h.result)
            inbox.submit(h)
            if not h.done.wait(min(wait_s, PRESS_WAIT_S)):
                return self._reply(202, {"status": "working", "queued": True, "journaled": h.journaled})
            return self._reply(200, h.result)

        def do_GET(self):
            if self.path != "/health":
                return self._reply(404, {"status": "not found"})
            if not inbox.key_ok(self.headers.get("x-harness-key", "")):
                return self._reply(403, {"status": "refused"})
            self._reply(200, inbox.health())
    return H


def serve(inbox: Inbox, *, port: int = PORT, host: str = "0.0.0.0", wait_s: float = WAIT_S):
    srv = ThreadingHTTPServer((host, port), _handler(inbox, wait_s))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, name="handover", daemon=True).start()
    return srv
