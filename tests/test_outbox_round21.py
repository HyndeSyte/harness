"""0.24.0, twenty-first round, items 6 and 7: the outbox's fixed template for a card Cain's link refuses.

6. The template says what happened in one of a few pre-vetted phrases chosen by the card's outcome (done, not done,
   couldn't verify), never its own words; each phrase and line is in tests/imperative_cases.json, which both suites
   check against the link's filter; each use of the template is logged and recorded.
7. Cases built from real differences between the outbox's mirror and the link (a code span holding a label, a bold
   head without terminal punctuation, a label in a link's text), run through the real outbox here; the bun suite runs
   the same cases through the link's real check. The template goes, with the card's own buttons.
All names invented.
"""
import json
import logging
import pathlib
import re

import pytest

from harness import outbox
from harness.discord_chat import to_markdown
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER  # noqa: F401
from test_outbox_round20 import like_the_link, posted
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]
SHARED = json.loads((ROOT / "tests" / "imperative_cases.json").read_text())
T = SHARED["template"]


def harness_labels():
    found = set()
    for f in (ROOT / "harness/app/harness").glob("*.py"):
        found |= set(re.findall(r'\(\s*"([A-Z][A-Za-z ,:\']{1,40})",\s*(?:choices|approvals|f?"|render)',
                                f.read_text()))
    return sorted(set(outbox.STATIC_LABELS) | found | set(T["known"]))


def test_the_shared_template_is_the_outboxs_own():
    O = outbox.Outbox
    assert T["outcomes"] == O.TEMPLATE_OUTCOMES
    assert set(T["outcomes"]) == {"done", "not_done", "unverified"}
    assert T["head"] == to_markdown(O.TEMPLATE_HEAD.format(when="Mon 9:00 AM"))
    assert (T["job"], T["body"]) == (O.TEMPLATE_JOB, O.TEMPLATE_BODY)
    from harness.ledger import Ledger
    assert tuple(T["outcomes"]) == Ledger.OUTCOMES


@pytest.mark.parametrize("line", [T["head"], T["job"], T["body"], *T["outcomes"].values()])
def test_each_template_line_is_refused_for_no_known_label(line):
    known = harness_labels()
    assert outbox.refused_spans(line, [], known) == []
    for label in known:
        assert not outbox.tells_to_use(line, label)


@pytest.mark.parametrize("outcome", ["done", "not_done", "unverified", None])
def test_the_template_says_the_cards_outcome(m, outcome, caplog):
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="x", outcome=outcome)
    row = m.ledger.db.execute("SELECT * FROM outbox ORDER BY id DESC LIMIT 1").fetchone()
    with caplog.at_level(logging.WARNING, logger="harness.outbox"):
        text = m.c.outbox._template(row)
    lines = text.split("\n")
    if outcome:
        assert lines[1] == outbox.Outbox.TEMPLATE_OUTCOMES[outcome]
    else:
        assert not set(lines) & set(outbox.Outbox.TEMPLATE_OUTCOMES.values())
    assert lines[-1] == outbox.Outbox.TEMPLATE_BODY
    assert any("fixed template" in r.getMessage() for r in caplog.records)    # its use is logged
    assert m.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='outbox_template'").fetchone()[0] == 1


def test_an_outcome_outside_the_enum_is_refused_when_queued(m):
    with pytest.raises(ValueError):
        with m.ledger.tx() as db:
            m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="x", outcome="it went fine, tap Undo")


@pytest.mark.parametrize("case", SHARED["end_to_end"], ids=lambda c: c["name"])
def test_real_mirror_and_link_differences_go_as_the_template_with_the_cards_buttons(m, case):
    carried = case["buttons"] + ["Stop"]
    assert to_markdown(case["html"]) == case["first"]                          # what the link reads first
    assert sorted({lab for _, _, lab in outbox.refused_spans(case["first"], carried, case["known"])}) == \
        sorted(case["refused_first"])                                          # the mirror reads it as the link does
    tried = like_the_link(m, extra_known=tuple(case["known"]))
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text=case["html"], outcome=case["outcome"],
                         buttons=[[(lab, f"x:{i}") for i, lab in enumerate(case["buttons"])]])
    before = len(m.link.cards)
    m.c.outbox.flush()
    (card,) = posted(m, before)
    assert tried[0] == case["first"] and len(tried) == 2                       # refused once, then the template
    lines = card["text"].split("\n")
    assert lines[0].startswith("**An update from Harness**, written ")
    assert lines[1:] == [T["outcomes"][case["outcome"]], T["body"]]           # the very lines the bun suite passes
    assert [c["label"] for r in card["rows"] for c in r["components"]] == carried
    row = m.ledger.db.execute("SELECT state FROM outbox ORDER BY id DESC LIMIT 1").fetchone()
    assert row["state"] == "sent"


def test_the_shared_end_to_end_cases_cover_each_difference():
    names = {c["name"] for c in SHARED["end_to_end"]}
    assert names == {"bold head without terminal punctuation", "code span holding a label",
                     "link with a label in its text"}
    assert any("`" in c["html"] for c in SHARED["end_to_end"])
    assert any("](" in c["html"] for c in SHARED["end_to_end"])
