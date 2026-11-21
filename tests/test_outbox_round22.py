"""0.24.0, twenty-second round: the outbox's once-key, its enqueue, and the end-to-end cases.

3. The once-key names a card's purpose (the tap, the card's kind, its outcome or attempt), not the tap alone: one tap's
   outcome card and then its retry card both go, while a true duplicate of either is refused.
5. The outcome is checked before anything is written, and the row, its once-key and its outcome are written together:
   a bad outcome (or a failing write) through the autocommit connection leaves no row and no once-key, inside and
   outside a transaction.
7. The owner-facing tap words added this round are the controller's own and are in tests/imperative_cases.json.
8. "Not done" and "couldn't verify" cards through the real outbox (the bun suite runs the same cases through the
   link's real check), and a card refused twice through the real mirror, ending as the fixed template with the card's
   own buttons.
All names invented.
"""
import json
import pathlib

import pytest

from harness import outbox
from harness.controller import Controller
from harness.discord_chat import to_markdown
from harness.ledger import Ledger
from harness.cain_relay import LinkError
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER  # noqa: F401
from test_outbox_round20 import posted
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]
SHARED = json.loads((ROOT / "tests" / "imperative_cases.json").read_text())
T = SHARED["template"]


def counts(m):
    rows = m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    keys = m.ledger.db.execute("SELECT COUNT(*) FROM meta WHERE key LIKE 'outbox_once:%'").fetchone()[0]
    outs = m.ledger.db.execute("SELECT COUNT(*) FROM meta WHERE key LIKE 'outbox_outcome:%'").fetchone()[0]
    return rows, keys, outs


# -- 3. the once-key names the card's purpose ---------------------------------------------------------------------------

def test_one_taps_outcome_card_and_its_retry_card_both_go_and_duplicates_are_refused(m):
    tap = "96100|k:a:two"
    outcome_key = Ledger.once_key(tap, "outcome", "failed_retry")
    retry_key = Ledger.once_key(tap, "retry", "1")
    assert outcome_key != retry_key
    with m.ledger.tx() as db:
        a = m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="Its outcome.", once=outcome_key,
                             outcome="not_done")
    with m.ledger.tx() as db:
        b = m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="Its retry card.", once=retry_key)
    assert a != b
    with m.ledger.tx() as db:                                                  # true duplicates of each
        assert m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="Its outcome again.", once=outcome_key) == a
        assert m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="Its retry again.", once=retry_key) == b
    before = len(m.link.cards)
    m.c.outbox.flush()
    texts = [c["text"] for c in posted(m, before)]
    assert texts == ["Its outcome.", "Its retry card."]                        # both sent, once each


def test_the_terminal_card_is_keyed_on_its_purpose(m):
    """The terminal card's key holds the tap, the card kind and the outcome, so another card for the same tap (a
    told-once note, say) isn't swallowed by it."""
    row = {"press": {"id": "96200", "custom_id": "k:a:term"}, "at": 1794000000.0, "state": "unverified", "op": {}}
    m.c._queue_terminal(row)
    key = m.c.handovers.key(row["press"])
    assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(key, "outcome", "unverified")) is not None
    assert m.ledger.get_meta(f"outbox_once:tap:{key}") is None                 # never the tap alone
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="A note.", once=Ledger.once_key(key, "note", "told"))
    assert counts(m)[0] >= 2


# -- 5. checked before any write, written together -------------------------------------------------------------------

@pytest.mark.parametrize("inside", [False, True], ids=["autocommit", "in-a-transaction"])
def test_a_bad_outcome_writes_nothing(m, inside):
    assert m.ledger.db.isolation_level is None                                 # the records' autocommit connection
    before = counts(m)
    with pytest.raises(ValueError):
        if inside:
            with m.ledger.tx() as db:
                m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="x", once="tap:1|outcome|x", outcome="fine")
        else:
            m.ledger.enqueue(chat_id=1, kind="notice", text="x", once="tap:1|outcome|x", outcome="fine")
    assert counts(m) == before
    # a corrected retry is not deduplicated away
    oid = m.ledger.enqueue(chat_id=1, kind="notice", text="x", once="tap:1|outcome|x", outcome="done")
    assert m.ledger.db.execute("SELECT text FROM outbox WHERE id=?", (oid,)).fetchone()[0] == "x"
    assert m.ledger.get_meta(f"outbox_outcome:{oid}") == "done"


@pytest.mark.parametrize("inside", [False, True], ids=["autocommit", "in-a-transaction"])
def test_a_failing_once_key_write_leaves_no_row(m, monkeypatch, inside):
    real = m.ledger.set_meta

    def set_meta(key, value, db=None):
        if key.startswith("outbox_once:"):
            raise RuntimeError("the write failed")
        return real(key, value, db)
    monkeypatch.setattr(m.ledger, "set_meta", set_meta)
    before = counts(m)
    with pytest.raises(RuntimeError):
        if inside:
            with m.ledger.tx() as db:
                m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="y", once="tap:2|outcome|y")
        else:
            m.ledger.enqueue(chat_id=1, kind="notice", text="y", once="tap:2|outcome|y")
    assert counts(m) == before


def test_an_enqueue_inside_a_transaction_still_commits_with_it(m):
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="kept", once="tap:3|outcome|z", outcome="done")
        m.ledger.set_meta("round22_probe", "1", db)
    assert m.ledger.get_meta("round22_probe") == "1"
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox WHERE text='kept'").fetchone()[0] == 1


# -- 7. the words are the controller's own and checked by both suites --------------------------------------------------

def test_the_shared_tap_words_are_the_controllers_own():
    texts = SHARED["said"]["texts"]
    assert Controller.TERMINAL_WORDS["unidentified"] in texts
    assert Controller.TERMINAL_WORDS["internal_error"] in texts
    assert Controller.CANT_TELL_PART.format(names="Swim", how="it", what="it") in texts
    assert Controller.TERMINAL_WORDS["unidentified"].startswith(
        "Harness couldn't tell which request this tap was for; nothing was changed.")
    assert "stopped or hit an error" not in Controller.TERMINAL_WORDS["unidentified"]
    assert "couldn't be read" not in Controller.TERMINAL_WORDS["internal_error"]


@pytest.mark.parametrize("line", SHARED["said"]["texts"])
def test_each_tap_line_is_refused_for_no_known_label(line):
    assert outbox.refused_spans(line, [], T["known"]) == []


def test_a_part_with_no_reason_and_no_read_says_cant_tell():
    extra = {"names": ["Dinner", "Swim"], "got": ["done"], "retry": [], "ask": [1]}   # Swim: no read at all
    text = Controller._relist_words("unknown", "failed_ask", [], restored=False, extra=extra)
    assert Controller.CANT_TELL_PART.format(names="Swim", how="it", what="it") in text
    assert "may have reached your calendar" not in text
    extra["got"] = ["done", ""]                                                # an empty read too
    text = Controller._relist_words("unknown", "failed_ask", [], restored=False, extra=extra)
    assert "may have reached your calendar" not in text and "can't tell how far it got" in text


# -- 8. end to end --------------------------------------------------------------------------------------------------

def link_knowing(m, known_by_try):
    """A fake link that refuses as the link's rule does (the mirrored finder), knowing the labels of each try: its live
    labels may change between two tries."""
    real = m.link.card
    tried = []

    def card(text, rows, kind, expires=None, op=None):
        known = known_by_try[min(len(tried), len(known_by_try) - 1)]
        tried.append(text)
        carried = [c["label"] for r in rows or [] for c in r.get("components", [])]
        spans = outbox.refused_spans(text, carried, known)
        if spans:
            said = ", ".join(f'"{lab}"' for lab in dict.fromkeys(lab for _, _, lab in spans))
            raise LinkError(400, f"the card names {said}, which it doesn't carry")
        return real(text, rows, kind, expires=expires, op=op)
    m.link.card = card
    return tried


def test_the_end_to_end_cases_cover_every_outcome():
    assert {c["outcome"] for c in SHARED["end_to_end"]} == {"done", "not_done", "unverified"}


@pytest.mark.parametrize("case", [c for c in SHARED["end_to_end"] if c["outcome"] != "done"], ids=lambda c: c["name"])
def test_not_done_and_couldnt_verify_cards_end_to_end(m, case):
    carried = case["buttons"] + ["Stop"]
    assert to_markdown(case["html"]) == case["first"]
    tried = link_knowing(m, [case["known"]])
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text=case["html"], outcome=case["outcome"],
                         buttons=[[(lab, f"x:{i}") for i, lab in enumerate(case["buttons"])]])
    before = len(m.link.cards)
    m.c.outbox.flush()
    (card,) = posted(m, before)
    assert tried[0] == case["first"] and len(tried) == 2
    assert card["text"].split("\n")[1:] == [T["outcomes"][case["outcome"]], T["body"]]
    assert [c["label"] for r in card["rows"] for c in r["components"]] == carried


@pytest.mark.parametrize("case", SHARED["refused_twice"], ids=lambda c: c["name"])
def test_a_card_refused_twice_ends_as_the_template_with_its_own_buttons(m, case):
    carried = case["buttons"] + ["Stop"]
    assert to_markdown(case["html"]) == case["first"]
    assert sorted({lab for _, _, lab in outbox.refused_spans(case["first"], carried, case["known_first"])}) == \
        case["refused_first"]
    assert to_markdown(outbox.strip_button_words(case["html"], case["refused_first"], carried)) == case["second"]
    assert sorted({lab for _, _, lab in outbox.refused_spans(case["second"], carried, case["known_second"])}) == \
        case["refused_second"]
    tried = link_knowing(m, [case["known_first"], case["known_second"]])
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text=case["html"], outcome=case["outcome"],
                         buttons=[[(lab, f"x:{i}") for i, lab in enumerate(case["buttons"])]])
    before = len(m.link.cards)
    m.c.outbox.flush()
    (card,) = posted(m, before)
    assert tried[:2] == [case["first"], case["second"]] and len(tried) == 3    # refused twice, then the template
    lines = card["text"].split("\n")
    assert lines[0].startswith("**An update from Harness**, written ")
    assert lines[1:] == [T["outcomes"][case["outcome"]], T["body"]]
    assert [c["label"] for r in card["rows"] for c in r["components"]] == carried
    assert m.ledger.db.execute("SELECT state FROM outbox ORDER BY id DESC LIMIT 1").fetchone()["state"] == "sent"
