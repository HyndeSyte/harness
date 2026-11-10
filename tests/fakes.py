"""Test doubles: engines, executors, an HTTP transport, a chat, a controller fed by it."""
from __future__ import annotations

import json
from concurrent.futures import Future

from harness import controller as _controller
from harness.chat import ChatError, Decision, Incoming
from harness.engines import EngineError, EngineResult
from harness.net import HttpResponse


def result(output=None, *, status="ok", engine="claude", usd=0.001, text=None):
    if output is None and status == "ok":
        output = {"type": "answer", "text": text or "Thursday is clear."}
    return EngineResult(status, output, engine, "fake-model", 100, 50, usd)


class FakeEngine:
    """Returns scripted results (or raises scripted EngineErrors), in order."""

    def __init__(self, name="claude", script=None, model_state="ok"):
        self.name = name
        self.script = list(script or [])
        self.calls = []
        self.model_state = model_state

    def complete(self, *, system, user, schema):
        self.calls.append({"system": system, "user": user, "schema": schema})
        item = self.script.pop(0) if self.script else result(engine=self.name)
        if isinstance(item, EngineError):
            raise item
        return item

    def check_model(self):
        return self.model_state


class SyncExecutor:
    """Runs submitted work immediately."""

    def submit(self, fn, *args, **kwargs):
        fut = Future()
        try:
            fut.set_result(fn(*args, **kwargs))
        except BaseException as e:      # pragma: no cover - surfaced via result()
            fut.set_exception(e)
        return fut

    def shutdown(self, **kw):
        pass


class ManualExecutor:
    """Holds work until the test releases it."""

    def __init__(self):
        self.pending = []

    def submit(self, fn, *args, **kwargs):
        fut = Future()
        self.pending.append((fut, fn, args, kwargs))
        return fut

    def run_all(self):
        while self.pending:
            fut, fn, args, kwargs = self.pending.pop(0)
            if fut.cancelled():
                continue
            fut.set_running_or_notify_cancel()
            fut.set_result(fn(*args, **kwargs))

    def shutdown(self, **kw):
        pass


class FakeTransport:
    """Records requests; answers from a list of (status, body, headers)."""

    def __init__(self, replies=None):
        self.replies = list(replies or [])
        self.requests = []

    def request(self, method, url, *, headers=None, json_body=None, timeout=30):
        self.requests.append({"method": method, "url": url, "headers": headers or {},
                              "json": json_body, "timeout": timeout})
        if not self.replies:
            return HttpResponse(500, {}, b"{}")
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        status, body, hdrs = (item + ({},))[:3] if len(item) == 2 else item
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        return HttpResponse(status, {k.lower(): v for k, v in hdrs.items()}, raw)


class FakeBot:
    """The chat the controller talks to (send, edit buttons, answer taps), with real
    send semantics: message ids, scripted failures. `batches` holds his input as
    update dicts (conftest.msg / conftest.cb); TestController reads one batch a tick,
    as Cain's handovers bring his words and taps."""

    def __init__(self, batches=None):
        self.batches = list(batches or [])
        self.sent = []          # (chat_id, text, buttons, message_id)
        self.edits = []
        self.answers = []
        self.next_message_id = 500
        self.fail_sends = []    # ChatErrors to raise on the next sends
        self.modes = []

    def take(self):
        item = self.batches.pop(0) if self.batches else []
        if isinstance(item, Exception):
            raise item
        return item

    def send_message(self, chat_id, text, buttons=None, *, html=True, kind=None):
        if self.fail_sends:
            raise self.fail_sends.pop(0)
        self.next_message_id += 1
        self.sent.append((chat_id, text, buttons, self.next_message_id))
        self.modes.append("html" if html else "plain")
        return self.next_message_id

    def edit_reply_markup(self, chat_id, message_id, buttons):
        self.edits.append((chat_id, message_id, buttons))

    def answer_callback(self, callback_id, text=None):
        self.answers.append((callback_id, text))

    def texts(self):
        return [t for _, t, _, _ in self.sent]


def chat_error(code=429, desc="Too Many Requests", retry_after=None):
    return ChatError(code, desc, retry_after)


# -- his input, as the controller records it ---------------------------------------------
COMMANDS = frozenset({"/stop", "/resume", "/cancel", "/status", "/rule", "/undo", "/checkadds"})


def parse(update: dict) -> Incoming:
    uid = int(update["update_id"])
    if "message" in update:
        m = update["message"] or {}
        frm, chat = m.get("from") or {}, m.get("chat") or {}
        reply = m.get("reply_to_message") or {}
        return Incoming(update_id=uid, kind="message", user_id=frm.get("id"),
                        is_bot=bool(frm.get("is_bot")), chat_id=chat.get("id"),
                        chat_type=chat.get("type"), message_id=m.get("message_id"),
                        text=m.get("text"), reply_to_message_id=reply.get("message_id"))
    if "callback_query" in update:
        q = update["callback_query"] or {}
        frm, msg = q.get("from") or {}, q.get("message") or {}
        chat = msg.get("chat") or {}
        return Incoming(update_id=uid, kind="callback", user_id=frm.get("id"),
                        is_bot=bool(frm.get("is_bot")), chat_id=chat.get("id"),
                        chat_type=chat.get("type"), message_id=msg.get("message_id"),
                        callback_id=q.get("id"), callback_data=q.get("data"))
    return Incoming(update_id=uid, kind="other")


def decide(inc: Incoming, owner: int, screen=None) -> Decision:
    """Only his own words and taps count (on Discord: the bot owner's DM, and taps
    Cain's link checked). A command word is a command job; work content is refused."""
    if inc.kind == "other" or inc.user_id != owner or inc.chat_id != owner:
        return Decision(inc, False, "not his", None)
    if inc.kind == "callback":
        return Decision(inc, True, None, None)
    text = (inc.text or "").strip()
    if not text:
        return Decision(inc, False, "no text", None)
    first = text.split(maxsplit=1)[0].lower().split("@", 1)[0]
    if first in COMMANDS:
        return Decision(inc, True, None, "command")
    why = screen(text) if screen else None
    if why:
        return Decision(inc, False, why, None)
    return Decision(inc, True, None, "message")


def own(vault, user_id, *, at="2026-10-21T13:00:00+00:00"):
    """Give the vault an owner, as an install paired before has (vault.py)."""
    vault._update(lambda d: d.__setitem__("owner", {"user_id": int(user_id),
                                                    "chat_id": int(user_id),
                                                    "paired_at": at}))


class TestController(_controller.Controller):
    """The controller with a chat handed in directly, no Discord keeper: the owner is
    the vault's, and his words and taps come from the chat double's batches."""
    __test__ = False

    def _bind_from_vault(self) -> bool:
        if self.config is None and self.vault.owner_id() is not None:
            self._bind_owner(self.vault.owner_id())
            self._reconcile()
        return self.config is not None

    def startup(self):
        if self.discord is None:
            self._bind_from_vault()
        super().startup()

    def tick(self):
        if self.discord is not None:
            return super().tick()
        self._drain_requests()
        if not self._bind_from_vault():
            self._publish()
            self.sleep(2)
            return
        take = getattr(self.api, "take", None)
        updates = take() if take else []
        decisions = [decide(parse(u), self.config.owner_user_id, self._screen_text)
                     for u in updates]
        self.ledger.ingest(decisions)
        for d in decisions:
            inc = d.incoming
            if d.accepted and inc.kind == "callback":
                self.callbacks.handle(inc)
            elif not d.accepted and d.reason and d.reason.startswith("work content"):
                with self.ledger.tx() as db:
                    self.ledger.enqueue(chat_id=inc.chat_id, kind="reply", db=db,
                                        text="I didn't keep that message: it looks like "
                                             f"{d.reason}. Nothing was stored or sent to a model.")
        self._work()


def receive(ledger, updates, owner=424242, screen=None):
    """Record his input straight into the ledger, as the controller does. Returns
    (decisions, new job ids)."""
    decisions = [decide(parse(u), owner, screen) for u in updates]
    return decisions, ledger.ingest(decisions)
