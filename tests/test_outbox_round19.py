"""0.24.0, nineteenth round, item 4: the outbox's fallback for a card Cain's link refuses for telling him to use a
button it doesn't carry.

- Only sentences matching the link's own imperative patterns are stripped; the patterns are mirrored exactly from
  cain/rootfs/opt/cain/gate/rules.ts (compared here source to source) and both sides run the same shared cases
  (tests/imperative_cases.json; cain/tests/imperative-cases.test.ts runs them through the link's own code).
- A prose sentence that merely holds the words ("we'll go ahead with it") stays.
- If every sentence goes, or the card's head goes with them, a fixed template built from its structured fields
  (what it's about, when it was written, the outcome) is posted with the card's own buttons, and recorded.
All names invented.
"""
import json
import pathlib
import re

from harness import outbox
from harness.cain_relay import LinkError
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests" / "imperative_cases.json").read_text())["imperative"]


def _ts_regex(src: str, name: str, q: str) -> str:
    m = re.search(r"const " + name + r" = new RegExp\(`(.*?)`, \"i\"\);", src)
    assert m, name
    return m.group(1).replace("${Q}", q).replace("\\\\", "\\")


def test_the_patterns_are_the_links_own_source_for_source():
    src = (ROOT / "cain/rootfs/opt/cain/gate/rules.ts").read_text()
    q = re.search(r'^const Q = "(.*)";$', src, re.M).group(1).replace('\\"', '"')
    assert outbox.Q == q
    assert outbox.IMPERATIVE_BEFORE.pattern == _ts_regex(src, "IMPERATIVE_BEFORE", q)
    assert outbox.IMPERATIVE_AFTER.pattern == _ts_regex(src, "IMPERATIVE_AFTER", q)


def test_the_shared_cases_agree():
    for text, label, want in CASES:
        assert outbox.tells_to_use(text, label) is want, (text, label)


def refusing(m, when):
    real = m.link.card
    tried = []

    def card(text, rows, kind, expires=None):
        tried.append(text)
        if when(text.casefold()):
            raise LinkError(400, 'the card names "Go ahead", which it doesn\'t carry')
        return real(text, rows, kind, expires)
    m.link.card = card
    return tried


def posted(m, before):
    return [m.link.cards[c] for c in sorted(m.link.cards)[before:]]


def test_a_prose_go_ahead_sentence_is_kept(m):
    tried = refusing(m, lambda t: "tap go ahead" in t)
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db,
                         text="<b>Done.</b> We'll go ahead with the rest tomorrow. Tap Go ahead to see it.")
    before = len(m.link.cards)
    m.c.outbox.flush()
    (card,) = posted(m, before)
    assert "We'll go ahead with the rest tomorrow." in card["text"] and "Tap Go ahead" not in card["text"]
    assert len(tried) == 2


def test_every_sentence_stripped_posts_the_template_with_its_buttons_and_records_it(m):
    refusing(m, lambda t: "tap go ahead" in t)
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="Tap Go ahead to do it. Tap Go ahead to see it.",
                         buttons=[[("Leave it", "x:1")]])
    before = len(m.link.cards)
    m.c.outbox.flush()
    (card,) = posted(m, before)
    assert card["text"].startswith("**An update from Harness**, written ")
    assert "full words couldn't be shown" in card["text"] and "Go ahead" not in card["text"]
    assert "Leave it" in [c["label"] for r in card["rows"] for c in r["components"]]   # its own button kept
    row = m.ledger.db.execute("SELECT state FROM outbox ORDER BY id DESC LIMIT 1").fetchone()
    assert row["state"] == "sent"
    ev = json.loads(m.ledger.db.execute(
        "SELECT detail FROM events WHERE kind='link_refused_card' ORDER BY id DESC").fetchone()[0])
    assert ev["template"] is True


def test_a_card_whose_head_goes_with_the_stripped_sentence_gets_the_template(m):
    refusing(m, lambda t: "tap go ahead" in t)
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db,
                         text="Your dentist change is ready, tap Go ahead to add it.\nNothing else changed.")
    before = len(m.link.cards)
    m.c.outbox.flush()
    (card,) = posted(m, before)
    assert card["text"].startswith("**An update from Harness**")
    # Twentieth round: the template is fixed text only; what's left of the card's words isn't in it.
    assert "Nothing else changed." not in card["text"] and "full words couldn't be shown" in card["text"]
