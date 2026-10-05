"""Test doubles: engines, executors, an HTTP transport, a Telegram API."""
from __future__ import annotations

import json
from concurrent.futures import Future

from harness.engines import EngineError, EngineResult
from harness.net import HttpResponse
from harness.telegram_api import TelegramError


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
    """A Telegram Bot API double with real send semantics: message ids,
    scripted failures, update batches."""

    def __init__(self, batches=None, username="example_harness_bot"):
        self.batches = list(batches or [])
        self.offsets = []
        self.sent = []          # (chat_id, text, buttons, message_id)
        self.edits = []
        self.answers = []
        self.commands = []
        self.next_message_id = 500
        self.fail_sends = []    # TelegramErrors to raise on the next sends
        self.username = username
        self.webhook_url = ""
        self.timeouts = []
        self.modes = []
        self.bot_id = 1

    def get_updates(self, offset, timeout, allowed_updates):
        self.offsets.append(offset)
        self.timeouts.append(timeout)
        assert tuple(allowed_updates) == ("message", "callback_query")
        item = self.batches.pop(0) if self.batches else []
        if isinstance(item, Exception):
            raise item
        return item

    def send_message(self, chat_id, text, buttons=None, *, html=True):
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

    def get_me(self):
        return {"id": self.bot_id, "is_bot": True, "username": self.username}

    def get_webhook_info(self):
        return {"url": self.webhook_url}

    def set_my_commands(self, commands, chat_id):
        self.commands.append((chat_id, commands))

    def texts(self):
        return [t for _, t, _, _ in self.sent]


def tg_error(code=429, desc="Too Many Requests", retry_after=None):
    return TelegramError(code, desc, retry_after)
