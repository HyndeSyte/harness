"""Cain hands a calendar request over to the keeper here.

Cain is the conversation; the keeper writes calendars. When he asks Cain for a
calendar change, Cain calls this endpoint and passes nothing he said: the
keeper reads the DM itself (controller._handover) and acts only on his newest
message, from the last 2 minutes. If Cain wants to pass a suggestion of its own
(a date it found in an email, say), it may, and then any change gets a card to
tap: Cain's words never change a calendar by themselves.

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
import queue
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
ROUTES = ("/handover", "/digest", "/press", "/morning-posted", "/meanings", "/places")
BIG = ("/meanings", "/places")
STUCK_S = 10 * 60


def key_for(token: str) -> str:
    return hmac.new(token.encode(), KEY_CONTEXT, hashlib.sha256).hexdigest()


@dataclass
class Handover:
    kind: str = "handover"               # or digest, press, morning-posted, meanings, places
    suggestion: str = ""
    rows: list = field(default_factory=list)   # /meanings, /places: already checked
    press: dict = field(default_factory=dict)
    paired: str = ""                     # the Discord user Cain is paired with
    done: threading.Event = field(default_factory=threading.Event)
    result: dict = field(default_factory=dict)
    arrived: float = field(default_factory=time.monotonic)
    age: float | None = None             # how old his message was when Cain handed it over

    def finish(self, status: str, said: str = "", **extra) -> None:
        if not self.done.is_set():
            self.result = {"status": status, "said": said, **extra}
            took = time.monotonic() - self.arrived
            # Outcome and timing only: never his words. The target is 20 s from his message.
            log.info("%s: %s, %.1fs here%s", self.kind, status, took,
                     f", {self.age + took:.0f}s after his message" if self.age is not None else "")
            self.done.set()


class Inbox:
    def __init__(self, token_fn: Callable[[], str], wake: threading.Event | None = None):
        self._token_fn = token_fn
        self.queue: "queue.Queue[Handover]" = queue.Queue()
        self.wake = wake
        self.beat_at: float | None = None    # the controller loop's last turn; None: not yet

    def beat(self) -> None:
        self.beat_at = time.monotonic()

    def health(self) -> dict:
        if self.beat_at is None:
            return {"status": "starting", "loop_age_s": None}
        age = time.monotonic() - self.beat_at
        return {"status": "ok" if age < STUCK_S else "stuck", "loop_age_s": int(age)}

    def key_ok(self, presented: str) -> bool:
        token = self._token_fn()
        return bool(token) and bool(presented) and hmac.compare_digest(key_for(token), presented)

    def submit(self, h: Handover) -> None:
        self.queue.put(h)
        if self.wake is not None:
            self.wake.set()

    def take(self) -> list[Handover]:
        out = []
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
                         press={k: str(body.get(k, "")) for k in
                                ("id", "token", "app", "custom_id", "message_id")})
            inbox.submit(h)
            if not h.done.wait(wait_s):
                return self._reply(202, {"status": "working", "said": (
                    "Still working on it. The keeper will post the result in the DM.")})
            self._reply(200, h.result)

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
