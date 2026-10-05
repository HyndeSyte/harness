import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "harness" / "app"))

from harness.ledger import Ledger  # noqa: E402

OWNER = 424242


class Clock:
    def __init__(self, start=datetime(2026, 10, 21, 13, 0, tzinfo=timezone.utc)):
        self.t = start

    def __call__(self):
        return self.t

    def advance(self, **kw):
        self.t = self.t + timedelta(**kw)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def ledger(tmp_path, clock):
    return Ledger(str(tmp_path / "harness.sqlite"), clock=clock)


def msg(update_id, text="hello", *, user=OWNER, chat=OWNER, chat_type="private",
        message_id=None, is_bot=False, reply_to=None, **extra):
    m = {"message_id": message_id or update_id * 10,
         "from": {"id": user, "is_bot": is_bot},
         "chat": {"id": chat, "type": chat_type},
         "text": text}
    if reply_to is not None:
        m["reply_to_message"] = {"message_id": reply_to}
    m.update(extra)
    return {"update_id": update_id, "message": m}


def cb(update_id, data, *, message_id, user=OWNER, chat=OWNER, chat_type="private"):
    return {"update_id": update_id, "callback_query": {
        "id": f"cq{update_id}", "data": data,
        "from": {"id": user, "is_bot": False},
        "message": {"message_id": message_id, "chat": {"id": chat, "type": chat_type}}}}


class FakeAPI:
    def __init__(self, batches=None):
        self.batches = list(batches or [])
        self.offsets = []
        self.sent = []
        self.next_message_id = 9000

    def get_updates(self, offset, timeout, allowed_updates):
        self.offsets.append(offset)
        assert tuple(allowed_updates) == ("message", "callback_query")
        return self.batches.pop(0) if self.batches else []

    def send_message(self, chat_id, text, buttons=None, *, html=True):
        self.next_message_id += 1
        self.sent.append((chat_id, text, buttons, self.next_message_id))
        return self.next_message_id

    def edit_reply_markup(self, chat_id, message_id, buttons):
        self.sent.append(("edit", chat_id, message_id, buttons))

    def answer_callback(self, callback_id, text=None):
        self.sent.append(("answer", callback_id, text))
