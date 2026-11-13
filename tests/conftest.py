import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "harness" / "app"))

from harness.ledger import Ledger  # noqa: E402

import message_rules  # noqa: E402

OWNER = 424242


def pytest_configure(config):
    config.addinivalue_line("markers", "raw_words: the test sends words the message rules refuse, on purpose "
                                       "(a test of escaping or of the rules themselves)")


# -- what he sees keeps to his standards (test_message_text.py has the static half) -------------
# Every message any test sends through the chat (FakeBot, or LinkChat to a fake link, in-process
# or over HTTP) and every note after a tap is checked as he'd see it: the words after
# to_markdown, and its buttons with the Stop row LinkChat adds. No em dash, no app word, no
# hidden count, no machine id, and no button named that the message lacks.
TOGGLE = ("Stop", "Turn back on")


def labels_of(buttons) -> list[str]:
    """Button labels from either shape: [[(label, data), ...]] or Discord's components."""
    out = []
    for row in buttons or []:
        if isinstance(row, dict):
            out += [str(c.get("label", "")) for c in row.get("components", [])]
        else:
            out += [str(b[0]) for b in row]
    return out


# A chore handed to him instead of done (org rule R-004): check something, send it again, report
# back. The harness reads to settle what it doesn't know and retries what failed by itself. Its
# own "I won't ask again", "I'd ask again" and "I'll try again" are about itself, not asks.
# Python's own rule: not one of Cain's (message_rules.py mirrors those).
ASK = re.compile(r"""(?ix)
    \bcheck(?:ing)?\s+(?:the|that|this|these|your|it|its|whether|if|on|first|back|again|before)\b
  | \bdouble[\s-]check
  | \bre-?send\b
  | \b(?:send|say|type|post)\s+(?:it|that|this|them|one)\s+again\b
  | (?<!I'd\s)(?<!won't\s)(?<!I'll\s)\b(?:ask|try)\s+(?:it\s+|that\s+|me\s+)?again\b
  | \blet\s+me\s+know\b
  | \btell\s+me\s+(?:if|whether|when|what|how|once)\b
  | \breport(?:ing)?\s+back\b
  | \bget\s+back\s+to\s+me\b
  | \b(?:run|do)\s+(?:a|the)\s+(?:test|drill)\b
""")
# Asks that may stay, each a decision: (words, why). Checked against what he sees (below) and
# against the literals (test_message_text.py).
ASK_ALLOWED = [
    ("Check before approving:", "a card's own warning, read before the tap it asks for: part of "
                                "that decision, not a chore after it"),
    ("you asked to check these with", "says what his own /checkadds asked for: a tap on each change"),
]


def asks_in(text: str) -> list[str]:
    for words, _ in ASK_ALLOWED:
        text = text.replace(words, "")
    return [m.group(0) for m in ASK.finditer(text)]


def rule_problems(where: str, text: str, labels) -> list[str]:
    report = message_rules.check(text, buttons=list(labels))
    return [f"{where}: {h.rule} ({h.result}{', ' + h.label if h.label else ''}) in {h.around!r}"
            for h in report.hits] + [f"{where}: a check, resend or report-back ask in {a!r}"
                                     for a in asks_in(text)]


@pytest.fixture(autouse=True)
def he_sees_no_broken_rule(request, monkeypatch):
    if request.node.get_closest_marker("raw_words"):
        yield
        return
    import fakes
    from harness import discord_chat
    from harness.discord_api import escape
    found: list[str] = []

    real_bot = fakes.FakeBot.send_message

    def bot_send(self, chat_id, text, buttons=None, *, html=True, kind=None, expires=None):
        shown = discord_chat.to_markdown(text) if html else escape(text)
        toggle = TOGGLE if buttons or kind in discord_chat.TOGGLE_KINDS else ()
        found.extend(rule_problems("message", shown, [*labels_of(buttons), *toggle]))
        return real_bot(self, chat_id, text, buttons, html=html, kind=kind, expires=expires)

    real_card = discord_chat.LinkChat.send_message

    def card_send(self, chat_id, text, buttons=None, *, html=True, kind=None, expires=None):
        shown = discord_chat.to_markdown(text) if html else escape(text)
        found.extend(rule_problems("card", shown, labels_of(self._rows(buttons, kind))))
        return real_card(self, chat_id, text, buttons, html=html, kind=kind, expires=expires)

    real_note = discord_chat.LinkChat.answer_callback

    def tap_note(self, callback_id, text=None):
        if text:
            found.extend(rule_problems("note after a tap", text, ()))
        return real_note(self, callback_id, text)

    monkeypatch.setattr(fakes.FakeBot, "send_message", bot_send)
    monkeypatch.setattr(discord_chat.LinkChat, "send_message", card_send)
    monkeypatch.setattr(discord_chat.LinkChat, "answer_callback", tap_note)
    yield
    assert not found, "A message breaks his standards:\n" + "\n".join(dict.fromkeys(found))


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
