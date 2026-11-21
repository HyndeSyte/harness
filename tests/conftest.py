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
    config.addinivalue_line("markers", "card_only: the ledger as installed, with the no-card paths off "
                                       "until the smoke test is recorded")
    config.addinivalue_line("markers", "migrate_gate: the live ledger is migrated only after a dry run of its "
                                       "own build is recorded (tenth round)")
    config.addinivalue_line("markers", "install_gate: the ledger as installed, with cards that aren't the smoke "
                                       "run's refused until the run reads back a change on each calendar")


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


# A chore handed to him instead of done (org rule R-004): check, look, verify, confirm or make sure
# of something, send, retry or tap it again, delete it "if needed", report back, or a hedge that
# sends him to look ("it may not be there"). The harness reads to settle what it doesn't know and
# retries what failed by itself. Its own "I won't ask again", "I'd ask again", "I'll try again" and
# "I couldn't confirm yet" are about itself, not asks. Python's own rule: not one of Cain's
# (message_rules.py mirrors those).
# A chore's verb said to him: a sentence that starts with it, capitalized, or one led in by
# "please", "then", "you can", "be sure to" and the like.
_START = r"(?:^|(?<=[.!?:;]\s)|(?<=\n))\s*(?-i:Check|Look|Confirm|Verify|Delete|Remove|Retry|Make\s+sure)\b"
_LEAD = (r"\b(?:please|then|be\s+sure\s+to|you\s+(?:can|could|should|may|might|must|need\s+to|have\s+to"
         r"|'ll\s+want\s+to))\s+(?:check|look|confirm|verify|delete|remove|retry|make\s+sure)\b")
ASK = re.compile(r"""(?imx)
    \bcheck(?:ing)?\s+(?:the|that|this|these|your|it|its|whether|if|on|first|back|again|before|for|by\s+hand
                       |family|gmail|google|icloud|home\s+assistant|cain|harness|outlook)\b
  | """ + _START + r"""(?!\s+before\s+approving)
  | """ + _LEAD + r"""
  | \bdouble[\s-]check
  | \bre-?send\b
  | \b(?:send|say|type|post)\s+(?:it|that|this|them|one)\s+again\b
  | (?<!I'd\s)(?<!won't\s)(?<!I'll\s)\b(?:ask|try)\s+(?:it\s+|that\s+|me\s+)?again\b
  | (?<!won't\s)(?<!I'll\s)\bre-?try\s+(?:it|that|this|them|again|later|in|after|once|the|your)\b
  | \btap\s+(?:(?:the|that|this|on)\s+)?(?:(?-i:[A-Z])\w*|it|that|this|card)(?:\s+\w+){0,3}?\s+(?:again|here)\b
  | (?<!I'll\s)(?<!I\s)\blook\s+(?:at|for|in)\s+(?:the|your|it|family|gmail|google|icloud)\b
  | (?<!I'll\s)(?<!I\s)\bmake\s+sure\b
  | (?<!couldn't\s)(?<!can't\s)(?<!cannot\s)(?<!to\s)\bverify\b
  | (?<!couldn't\s)(?<!can't\s)(?<!cannot\s)(?<!not\s)\bconfirm\s+(?:it|that|this|these|them|whether|if|the|your)\b
  | \bif\s+(?:needed|necessary|you\s+need\s+to)\b
  | \b(?:may|might|could)\s+not\s+(?:be\s+(?:there|on\s+(?:the|your))|have\s+(?:gone|landed|been\s+(?:added|written|made)))\b
  | \blet\s+me\s+know\b
  | \btell\s+me\s+(?:if|whether|when|what|how|once)\b
  | \breport(?:ing)?\s+back\b
  | \bget\s+back\s+to\s+me\b
  | \b(?:run|do)\s+(?:a|the)\s+(?:test|drill)\b
""")
# Asks that may stay, each a decision: (words, why). Checked against what he sees (below) and
# against the literals (test_message_text.py).
ASK_ALLOWED = [
    ("Try again makes a new card", "names the button that offers the change on a new card read from the calendar "
                                   "just now, for his tap: a decision, not a resend ask (eighth round)"),
    ("Check before approving:", "a card's own warning, read before the tap it asks for: part of "
                                "that decision, not a chore after it"),
    ("you asked to check these with", "says what his own /checkadds asked for: a tap on each change"),
    ("Then confirm it on the card that follows", "the last step of replacing a key only he can make (a "
                                                 "password, a service account key): his tap on the card "
                                                 "that stores it, a decision, not a check"),
]
# Twenty-fourth round: asks allowed only on one kind of card, never by a substring removal from every message.
# Twenty-fifth round: bound to that card's builder, not to its lead appearing somewhere: each entry is the ask, the
# card it's allowed on (named), a pattern the whole text must match (that builder's output: the card's head, then
# its own words, or its words alone as the literal), and why. The ask is let through only in such a text, said
# exactly once; anywhere else (another card that quotes the lead, or said twice) it's reported.
def _internal_error_card():
    from harness.controller import Controller
    head = r"(?:A tap of yours (?:from [^.\n]{1,40}|\(time unknown\))\.\s+)?"
    return re.compile(head + re.escape(Controller.TERMINAL_WORDS["internal_error"]).replace(r"\ ", r"\s+"))


ASK_SCOPED = [
    ("Please check your calendar to see whether it's there", "internal_error", _internal_error_card(),
     "twenty-third round: the internal-error card (Controller._queue_terminal with TERMINAL_WORDS[\"internal_error\"]), "
     "where Harness can't confirm whether a change it may have made was made; the one card that asks him to look at "
     "his calendar (tests/imperative_cases.json \"said\")"),
]


def asks_in(text: str) -> list[str]:
    for words, _ in ASK_ALLOWED:
        text = text.replace(words, "")
    out = []
    for words, _card, builder, _ in ASK_SCOPED:
        n = text.count(words)
        if n == 1 and builder.fullmatch(text.strip()):
            text = text.replace(words, "")
        elif n > 1:
            out.append(f"{words} (said {n} times)")
    return out + [m.group(0) for m in ASK.finditer(text)]


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

    def bot_send(self, chat_id, text, buttons=None, *, html=True, kind=None, expires=None, op=None):
        shown = discord_chat.to_markdown(text) if html else escape(text)
        toggle = TOGGLE if buttons or kind in discord_chat.TOGGLE_KINDS else ()
        found.extend(rule_problems("message", shown, [*labels_of(buttons), *toggle]))
        return real_bot(self, chat_id, text, buttons, html=html, kind=kind, expires=expires, op=op)

    real_card = discord_chat.LinkChat.send_message

    def card_send(self, chat_id, text, buttons=None, *, html=True, kind=None, expires=None, op=None):
        shown = discord_chat.to_markdown(text) if html else escape(text)
        found.extend(rule_problems("card", shown, labels_of(self._rows(buttons, kind))))
        return real_card(self, chat_id, text, buttons, html=html, kind=kind, expires=expires, op=op)

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


@pytest.fixture(autouse=True)
def no_read_back_pause(monkeypatch):
    """A read back read once more waits a few seconds on the Pi; not in tests."""
    from harness import calendar_change
    monkeypatch.setattr(calendar_change, "READ_BACK_PAUSE_S", 0)


@pytest.fixture(autouse=True)
def smoke_test_passed(request, monkeypatch):
    """The no-card paths are off until Cain records the post-install smoke test (keeper.sh fastpath
    on, 0.24.0 fourth round). Tests written before that run as on a Pi where it passed: nothing
    recorded counts as on. A test marked card_only sees the ledger as installed, where nothing
    recorded is card only; a recorded "off" is off everywhere."""
    if request.node.get_closest_marker("card_only"):
        return
    from harness import calendar_change
    monkeypatch.setattr(calendar_change, "fast_path_on",
                        lambda ledger: calendar_change.fast_path(ledger).get("on", True) is True)


@pytest.fixture(autouse=True)
def card_path_verified(request, monkeypatch):
    """After an install, a calendar's cards are held until the smoke run reads back a fenced edit and a
    series-day edit there (0.24.0, seventh and eighth rounds). Tests written before that run as on a Pi where it has: the gate is
    open. A test marked install_gate sees the ledger as installed, gate and all."""
    if request.node.get_closest_marker("install_gate"):
        return
    from harness import calendar_change
    monkeypatch.setattr(calendar_change, "closed_providers", lambda ledger: [])


@pytest.fixture(autouse=True)
def migration_dry_run_recorded(request, monkeypatch):
    """Tenth round: the live ledger is migrated only once a dry run of this very build is recorded in it.
    Tests written before that run as on a Pi where it was. A test marked migrate_gate sees it as installed."""
    if request.node.get_closest_marker("migrate_gate"):
        return
    from harness import migrate
    monkeypatch.setattr(migrate, "dry_run_missing", lambda ledger, build: "")
