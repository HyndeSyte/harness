"""0.24.0, twentieth round, item 3: the outbox's fallback for a card Cain's link refuses can't lose a card.

- The link's label finder is mirrored too (VERB with choose, pick and select; STATIC_LABELS; WITH_LABELS; named(),
  spanning line breaks, with quoted and bold labels; check()'s button rule), compared source to source, and both
  suites run the shared refusal cases in tests/imperative_cases.json (a line-break case and a foreign-label case
  among them).
- The template is fixed text only (no quoted message) and is refused for no label the link knows.
- A card refused a second time goes as the template with its own buttons, never as a dead card.
All names invented.
"""
import json
import pathlib
import re

import pytest

from harness import outbox
from harness.cain_relay import LinkError
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]
RULES = (ROOT / "cain/rootfs/opt/cain/gate/rules.ts").read_text()
SHARED = json.loads((ROOT / "tests" / "imperative_cases.json").read_text())


def _ts_list(name: str) -> list[str]:
    body = re.search(r"export const " + name + r": readonly string\[\] = \[(.*?)\];", RULES, re.S).group(1)
    body = re.sub(r"//[^\n]*", "", body)
    return re.findall(r'"([^"]*)"', body)


def test_the_label_finder_is_the_links_own_source_for_source():
    verb = re.search(r'^const VERB = "(.*)";$', RULES, re.M).group(1)
    assert outbox.VERB == verb
    assert list(outbox.STATIC_LABELS) == _ts_list("STATIC_LABELS")
    assert list(outbox.WITH_LABELS) == _ts_list("WITH_LABELS")
    named = RULES[RULES.index("function named("):RULES.index("// Whether a button hit")]
    forms = re.findall(r"new RegExp\(`(.*?)`, \"gd\"\)", named)
    assert forms == [
        "(?<![A-Za-z])${VERB}\\\\s+(?:(?:on\\\\s+)?the\\\\s+|on\\\\s+)?${Q}(${L})${Q}(?![A-Za-z0-9])",
        "(?<![A-Za-z0-9])${Q}(${L})${Q}\\\\s+[Bb]uttons?\\\\b",
        "(?<![A-Za-z])[Ww]ith\\\\s+(?:the\\\\s+)?${Q}(${L})${Q}(?![A-Za-z0-9])",
    ]
    mine = [rx.pattern for rx in (lambda lab: [
        re.compile(r"(?<![A-Za-z])" + outbox.VERB + r"\s+(?:(?:on\s+)?the\s+|on\s+)?" + outbox.Q + "(" + lab + ")"
                   + outbox.Q + r"(?![A-Za-z0-9])"),
        re.compile(r"(?<![A-Za-z0-9])" + outbox.Q + "(" + lab + ")" + outbox.Q + r"\s+[Bb]uttons?\b"),
        re.compile(r"(?<![A-Za-z])[Ww]ith\s+(?:the\s+)?" + outbox.Q + "(" + lab + ")" + outbox.Q
                   + r"(?![A-Za-z0-9])")])("L")]
    theirs = [f.replace("${VERB}", verb).replace("${Q}", outbox.Q).replace("${L}", "L").replace("\\\\", "\\")
              for f in forms]
    assert mine == theirs
    src = (ROOT / "harness/app/harness/outbox.py").read_text()
    assert "re.compile(r\"(?<![A-Za-z])\" + VERB" in src and "[Bb]uttons?" in src and "[Ww]ith" in src
    # longest label first, spans never overlapping, a carried label skipped, then imperative(): check() and addCard
    assert ".sort((a, b) => b.length - a.length)" in RULES and "key=lambda x: -len(x)" in src


@pytest.mark.parametrize("case", SHARED["refusal"], ids=lambda c: c["text"][:30])
def test_the_shared_refusal_cases_agree(case):
    got = sorted({lab for _, _, lab in outbox.refused_spans(case["text"], case["buttons"], case["known"])})
    assert got == sorted(case["refused"])
    left = outbox.strip_button_words(case["text"], case["known"], case["buttons"])
    assert outbox.refused_spans(left, case["buttons"], case["known"]) == []   # nothing the link refuses is left


def test_the_shared_cases_hold_a_line_break_and_a_foreign_label():
    texts = [c["text"] for c in SHARED["refusal"]]
    assert any(re.search(r"Tap\n", t) for t in texts)
    assert any(c["refused"] and not set(c["refused"]) & set(c["known"]) and c["buttons"] for c in SHARED["refusal"])


def like_the_link(m, extra_known=("Go ahead", "Add anyway")):
    """A fake link that refuses a card exactly as the link's rule does (the mirrored finder)."""
    real = m.link.card
    tried = []

    def card(text, rows, kind, expires=None):
        tried.append(text)
        carried = [c["label"] for r in rows or [] for c in r.get("components", [])]
        spans = outbox.refused_spans(text, carried, extra_known)
        if spans:
            said = ", ".join(f'"{lab}"' for lab in dict.fromkeys(lab for _, _, lab in spans))
            raise LinkError(400, f"the card names {said}, which it doesn't carry")
        return real(text, rows, kind, expires)
    m.link.card = card
    return tried


def posted(m, before):
    return [m.link.cards[c] for c in sorted(m.link.cards)[before:]]


def test_a_label_after_a_line_break_is_stripped_and_the_card_goes(m):
    tried = like_the_link(m)
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="<b>Your change is ready.</b> Tap\nGo ahead to add it."
                                                                "\nNothing else changed.")
    before = len(m.link.cards)
    m.c.outbox.flush()
    (card,) = posted(m, before)
    assert "Go ahead" not in card["text"] and "Nothing else changed." in card["text"]
    assert "Your change is ready." in card["text"] and len(tried) == 2
    assert m.ledger.db.execute("SELECT state FROM outbox ORDER BY id DESC LIMIT 1").fetchone()["state"] == "sent"


def test_a_second_refusal_for_a_label_the_first_didnt_name_posts_the_template_not_a_dead_card(m):
    tried = like_the_link(m)
    with m.ledger.tx() as db:
        # The first refusal names "Go ahead" only (this fake link reports one label at a time); "Add anyway" is the
        # label the stripped text still names, which the first refusal didn't.
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="<b>Done.</b> Tap Go ahead to see it. Tap Add anyway "
                                                                "to add it.", buttons=[[("Leave it", "x:1")]])
    real_spans = outbox.refused_spans
    calls = {"n": 0}

    def one_at_a_time(text, carried, known=()):
        calls["n"] += 1
        got = real_spans(text, carried, known)
        return got[:1]
    outbox_strip = outbox.strip_button_words
    try:
        outbox.refused_spans = one_at_a_time
        outbox.strip_button_words = lambda text, labels, carried=(): text.replace(" Tap Go ahead to see it.", "")
        before = len(m.link.cards)
        m.c.outbox.flush()
    finally:
        outbox.refused_spans = real_spans
        outbox.strip_button_words = outbox_strip
    (card,) = posted(m, before)
    assert len(tried) == 3                                                    # refused, refused again, template
    assert card["text"].startswith("**An update from Harness**") and "Add anyway" not in card["text"]
    assert "Leave it" in [c["label"] for r in card["rows"] for c in r["components"]]
    row = m.ledger.db.execute("SELECT state FROM outbox ORDER BY id DESC LIMIT 1").fetchone()
    assert row["state"] == "sent"                                             # never dead
    ev = [json.loads(r[0]) for r in m.ledger.db.execute(
        "SELECT detail FROM events WHERE kind='link_refused_card' ORDER BY id").fetchall()]
    assert ev[-1].get("second") is True and ev[-1]["template"] is True


def test_the_template_quotes_nothing_and_is_refused_for_no_known_label(m):
    harness_labels = set()
    for f in (ROOT / "harness/app/harness").glob("*.py"):
        harness_labels |= set(re.findall(r'\(\s*"([A-Z][A-Za-z ,:\']{1,40})",\s*(?:choices|approvals|f?"|render)',
                                         f.read_text()))
    known = sorted(set(outbox.STATIC_LABELS) | harness_labels | {"Go ahead", "Add anyway", "Leave it"})
    with m.ledger.tx() as db:
        jid = m.ledger.made_job(1, "tap Approve and press the Undo button", kind="message", db=db)
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="x", job_id=jid)
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="y")
    for row in m.ledger.db.execute("SELECT * FROM outbox ORDER BY id DESC LIMIT 2").fetchall():
        text = m.c.outbox._template(row)
        assert "tap Approve" not in text and "“" not in text             # nothing quoted
        assert outbox.refused_spans(outbox._plain(text), [], known) == []
        for label in known:
            assert not outbox.tells_to_use(outbox._plain(text), label)
