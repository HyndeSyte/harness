"""0.24.0, seventeenth round: the tap journal's defects from the sixteenth outside review (Nov 16).

1. The exception path keeps the tap invariant: once a tap's execution intent is written, an exception leaves it
   "outcome unknown" (not refused, not struck, its intent intact) and the next start reads the calendar for it by its
   identity first. Refused only for an exception before the intent.
2. Every choice tap that writes a calendar carries a readable identity in its intent (Add anyway: its fixed ids;
   Undo and the Family Undo: each event and the state it must read in afterwards), and one without has no Go ahead.
3. The calendar read by identity on the real read path: a Google event read as cancelled at its fixed id is its own
   state ("since taken off", no Go ahead); a change of several parts is reported per part, and Go ahead runs only the
   parts that aren't there.
4. The tap-age test's large-disagreement case (the journal's time wins at an hour) beside the within-tolerance case.
6. The relist's first message points at the cards below it; a tap whose time can't be read always gets a card,
   marked "time unknown".
All names and ids invented.
"""
import json
import pathlib
import sqlite3
import time

import pytest

from harness import handover
from harness.calendar_change import add_anyway_key
from harness.handover import Handover
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (PT_ID, TZ, ask, at, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round15_taps import snowflake
from test_handover_round16_taps import (DENTIST, Crash, dentist_card, dentists, lines, m,  # noqa: F401
                                        press_for, restart_after_restore, tap_journaled)
from fake_caldav import no_network  # noqa: F401  (autouse)

LUNCH = change("gmail", "add", "Lunch", dates="", start=at(17).isoformat(), end=at(18).isoformat())
FAMILY_DINNER = change("family", "add", "Family dinner", dates="", start=at(18).isoformat(), end=at(19).isoformat())
REMOVE_PT = change("gmail", "remove", "PT")


def named(m, title):
    return [e for e in m.gmail.events.values() if e.get("summary") == title and e.get("status") != "cancelled"]


def new_cards(m, before):
    return [m.link.cards[c] for c in sorted(m.link.cards)[before:]]


def new_said(m, before):
    return m.seen()[before:]


def card_labels(cards):
    return [c["label"] for card in cards for r in card["rows"] for c in r["components"]]


def keep_journal_after_intent(m, monkeypatch, on_disk):
    """Records the tap journal as it is on disk right after the intent: putting it back is the crash after it."""
    real_intent = m.c.handovers.journal_intent

    def intent(press, op=None):
        ok = real_intent(press, op)
        on_disk["after_intent"] = pathlib.Path(m.c.handovers.journal).read_bytes()
        return ok
    m.c.handovers.journal_intent = intent


def landed_then_crashed(m, monkeypatch, label="Approve"):
    """His tap acted on and its writes landed, then the App died before the journal recorded the outcome (the
    journal on disk as it was right after the intent). A backup from before the tap is returned."""
    backup = sqlite3.connect(":memory:")
    m.ledger.db.backup(backup)
    on_disk = {}
    keep_journal_after_intent(m, monkeypatch, on_disk)
    out, press = tap_journaled(m, label)
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    pathlib.Path(m.c.handovers.journal).write_bytes(on_disk["after_intent"])
    del m.c.handovers.journal_intent                                          # the real one again
    assert [r["state"] for r in m.c.handovers.journaled()] == ["unknown"]
    return backup, press


def relist_now(m):
    """A start that put the records back, with the records as they are (no restore needed for the listing)."""
    m.c._taps_replayed = False
    m.c.restored_at_start = True
    m.c.tick()
    m.c.outbox.flush()


def restart(m):
    """The App started again on the records as they are (nothing put back)."""
    m.c._taps_replayed = False
    m.c.restored_at_start = False
    m.c.tick()
    m.c.outbox.flush()


# -- 1. the exception path keeps the tap invariant ------------------------------------------------------------------

@pytest.mark.card_only
def test_a_calendar_write_that_lands_then_a_handler_exception_leaves_the_tap_unknown(m, monkeypatch):
    dentist_card(m)
    real = m.c.callbacks.handle

    def handle(inc):
        got = real(inc)
        m.cc.run_pending(paused=False)                                        # the write lands
        raise RuntimeError("the handler failed after the write")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        out, press = tap_journaled(m, "Approve")
    assert len(dentists(m)) == 1
    assert out["status"] == "error" and out["outcome"] == "unknown"          # never "refused"
    assert m.told == [m.c.TAP_UNKNOWN]
    rows = m.c.handovers.journaled()
    assert len(rows) == 1 and rows[0]["state"] == "unknown" and rows[0]["intent"]   # not struck, intent intact
    assert not any("outcome" in r for r in lines(m.c.handovers.journal))      # no refusal recorded
    for t in m.told:
        assert "again" not in t.lower().replace("nothing is done twice", "")
    before = len(m.link.cards)
    restart(m)                                                                # the next start reads it by identity
    for _ in range(2):
        m.c.tick()
    m.c.outbox.flush()
    said = [c["text"] for c in new_cards(m, before)]
    assert any("already on your calendar" in t for t in said), said
    assert "Go ahead" not in card_labels(new_cards(m, before))
    assert len(dentists(m)) == 1                                              # nothing written twice
    assert m.c.handovers.journaled() == []


@pytest.mark.card_only
def test_a_partly_done_change_of_several_parts_then_an_exception_is_unknown_not_refused(m, monkeypatch):
    out = m.tells("add the dentist 3 to 4 and lunch 5 to 6 today", ask(DENTIST, LUNCH))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    real = m.c.callbacks.handle
    real_insert = m.gmail.insert
    calls = []

    def insert(address, event):
        calls.append(event["summary"])
        if len(calls) > 1:
            raise RuntimeError("cut off after the first write")
        return real_insert(address, event)

    def handle(inc):
        got = real(inc)
        m.gmail.insert = insert
        m.cc.run_pending(paused=False)
        return got
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        out, press = tap_journaled(m, "Approve")
    m.gmail.insert = real_insert
    assert len(named(m, "Dentist")) == 1 and named(m, "Lunch") == []        # one part landed, one didn't
    assert out["status"] == "error" and out["outcome"] == "unknown"
    rows = m.c.handovers.journaled()
    assert [r["state"] for r in rows] == ["unknown"] and rows[0]["op"]["effect"] == "calendar_change"
    assert not any(r.get("kind") == "refused" for r in lines(m.c.handovers.journal))


@pytest.mark.card_only
def test_an_exception_before_the_intent_is_a_refusal(m, monkeypatch):
    dentist_card(m)
    with monkeypatch.context() as mp:
        mp.setattr(m.c, "_tap_op", lambda p: (_ for _ in ()).throw(RuntimeError("before the intent")))
        out, press = tap_journaled(m, "Approve")
    assert out["status"] == "error" and "Nothing changed" in out["said"]
    assert m.told == [out["said"]]                                            # told once, on the tap
    assert dentists(m) == []
    assert m.c.handovers.journaled() == []                                    # refused, told, struck off                                    # refused and told: struck off


# -- 2. a choice tap's readable identity -----------------------------------------------------------------------------

def add_anyway_receipt(m):
    """Dentist is already on his calendar under an id of its own; he asks for it anyway and gets Add anyway."""
    m.gmail.events["dentist-own"] = {"id": "dentist-own", "summary": "Dentist", "status": "confirmed", "etag": '"5"',
                                     "start": {"dateTime": at(15).isoformat(), "timeZone": TZ},
                                     "end": {"dateTime": at(16).isoformat(), "timeZone": TZ}}
    dentist_card(m)
    out = m.tap("Approve")
    assert out["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    assert "Add anyway" in m.labels()
    assert len(dentists(m)) == 1


@pytest.mark.card_only
def test_add_anyway_carries_its_fixed_id_in_the_intent_and_go_ahead_never_makes_a_second(m, monkeypatch):
    add_anyway_receipt(m)
    src = m.ledger.db.execute("SELECT target FROM choices WHERE kind='calendar_change_add_anyway'").fetchone()[0]
    backup, press = landed_then_crashed(m, monkeypatch, "Add anyway")
    assert len(dentists(m)) == 2                                              # the second one, as he asked
    intent = next(r for r in lines(m.c.handovers.journal) if "intent" in r)
    assert intent["op"]["keys"] == [add_anyway_key(src, 0)]                   # its fixed id, before execution
    anyway_id = m.cc._uid(add_anyway_key(src, 0), "cm")
    assert anyway_id in m.gmail.events
    # The records put back from a backup in which the Add anyway was never tapped (its nonce unused), and the
    # calendar can't be read at that start: the card offers Go ahead.
    m.gmail.down = True
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    m.gmail.down = False
    assert "Go ahead" in card_labels(new_cards(m, before))
    # Go ahead reads it first: there, nothing done.
    out = m.tap("Go ahead")
    assert out["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    assert len(dentists(m)) == 2
    assert [e for e in m.gmail.log if e[0] == "insert" and e[1]["id"] == anyway_id].__len__() == 1


@pytest.mark.card_only
def test_the_forced_writer_reads_its_fixed_id_before_writing(m, monkeypatch):
    add_anyway_receipt(m)
    backup, press = landed_then_crashed(m, monkeypatch, "Add anyway")
    assert len(dentists(m)) == 2
    m.gmail.down = True
    restart_after_restore(m, backup)
    m.gmail.down = False
    # Even past the Go ahead's own read (made to say it couldn't tell), the Add anyway taken again on the
    # restored records writes to the same fixed id, which its writer reads first: exactly one second event.
    monkeypatch.setattr(m.c, "_tap_read", lambda op: ("unread", []))
    out = m.tap("Go ahead")
    assert out["status"] == "ok"
    for _ in range(4):
        m.c.tick()
    m.c.outbox.flush()
    assert len(dentists(m)) == 2
    inserts = [e for e in m.gmail.log if e[0] == "insert" and e[1]["summary"] == "Dentist"]
    assert len(inserts) == 1                                                  # nothing sent a second time


@pytest.mark.card_only
def test_undo_carries_its_events_and_their_state_after_and_is_read_after_a_restore(m, monkeypatch):
    dentist_card(m)
    assert m.tap("Approve")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    assert len(dentists(m)) == 1 and "Undo" in m.labels()
    backup, press = landed_then_crashed(m, monkeypatch, "Undo")
    assert dentists(m) == []                                                  # the Undo ran
    intent = next(r for r in lines(m.c.handovers.journal) if "intent" in r)
    assert intent["op"]["effect"] == "undo" and intent["op"]["steps"][0]["how"] == "drop"
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    said = [c["text"] for c in new_cards(m, before)]
    assert any("already on your calendar" in t for t in said), said         # the calendar shows it undone
    assert "Go ahead" not in card_labels(new_cards(m, before))


def test_a_choice_tap_with_no_identity_gets_no_go_ahead_once_it_may_have_run(m):
    inbox = m.c.handovers
    press = {"id": "71001", "token": "t", "app": "9", "custom_id": "hx:c:clear", "message_id": "1"}
    assert inbox._append({"press": press, "at": time.time() - 60})
    assert inbox.journal_intent(press, {"effect": "calendar", "kind": "calendar_change_smoke_clear", "choice": True})
    before = len(m.link.cards)
    relist_now(m)
    cards = new_cards(m, before)
    said = [c["text"] for c in cards]
    assert any("isn't offered again here" in t for t in said), said
    assert "Go ahead" not in card_labels(cards)


def test_tap_op_names_the_choice_kinds_that_write_a_calendar(m):
    from harness import choices
    owner = m.c.config.owner_user_id
    with m.ledger.tx() as db:
        writes = choices.mint(m.ledger, kind="calendar_change_smoke_clear", target="r1", chat_id=owner, ttl_s=60, db=db)
        records = choices.mint(m.ledger, kind="calendar_change_fast_keep", target="o1", chat_id=owner, ttl_s=60, db=db)
        undo = choices.mint(m.ledger, kind="calendar_change_undo", target="nothing-open", chat_id=owner, ttl_s=60,
                            db=db)
    op = m.c._tap_op({"custom_id": "k:" + choices.callback_data(writes)})
    assert op == {"effect": "calendar", "kind": "calendar_change_smoke_clear", "choice": True}
    assert m.c._tap_op({"custom_id": "k:" + choices.callback_data(records)})["effect"] == "records"
    assert m.c._tap_op({"custom_id": "k:" + choices.callback_data(undo)})["effect"] == "records"   # nothing open


# -- 3. the read by identity, on the real read path --------------------------------------------------------------------

@pytest.mark.card_only
def test_a_gmail_removal_is_read_by_its_bound_id(m, monkeypatch):
    out = m.tells("take PT off today", ask(REMOVE_PT))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    backup, press = landed_then_crashed(m, monkeypatch)
    assert m.gmail.events[PT_ID]["status"] == "cancelled"
    op = m.c.handovers.journaled()[0]["op"]
    assert m.cc.tap_parts(op) == ["done"]
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    said = [c["text"] for c in new_cards(m, before)]
    assert any("already on your calendar" in t for t in said), said
    assert "Go ahead" not in card_labels(new_cards(m, before))


@pytest.mark.card_only
def test_a_family_add_is_read_by_its_fixed_address(m, monkeypatch):
    out = m.tells("add family dinner 6 to 7 today", ask(FAMILY_DINNER))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    backup, press = landed_then_crashed(m, monkeypatch)
    op = m.c.handovers.journaled()[0]["op"]
    assert m.cc.tap_parts(op) == ["done"]
    href = m.client.href_for(m.cc._uid(op["keys"][0] if op.get("keys") else f"{op['proposal']}:0", "hm-"))
    del m.icloud.events[next(k for k in m.icloud.events if k.endswith(pathlib.PurePosixPath(href).name))]
    assert m.cc.tap_parts(op) == ["not_done"]                                 # read, and answered: not there


@pytest.mark.card_only
def test_a_google_event_deleted_since_is_never_put_back(m, monkeypatch):
    dentist_card(m)
    backup, press = landed_then_crashed(m, monkeypatch)
    (ev,) = dentists(m)
    m.gmail.events[ev["id"]]["status"] = "cancelled"                          # he deleted it on his phone
    op = m.c.handovers.journaled()[0]["op"]
    assert m.cc.tap_parts(op) == ["removed"]
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    cards = new_cards(m, before)
    said = [c["text"] for c in cards]
    assert any("has since been taken off" in t for t in said), said
    assert not any("not carried out" in t or "doesn't show it" in t for t in said)
    assert "Go ahead" not in card_labels(cards)
    said = m.c._reconfirm_tap(json.dumps({"custom_id": press["custom_id"], "message_id": press["message_id"],
                                          "op": op}))                         # a re-confirm all the same
    assert "taken off" in said
    for _ in range(3):
        m.c.tick()
    assert dentists(m) == [] and m.gmail.events[ev["id"]]["status"] == "cancelled"   # nothing re-inserted
    assert len([e for e in m.gmail.log if e[0] == "insert"]) == 1


@pytest.mark.card_only
def test_a_mixed_change_is_said_per_part_and_go_ahead_does_only_whats_missing(m, monkeypatch):
    out = m.tells("add the dentist 3 to 4 and lunch 5 to 6 today", ask(DENTIST, LUNCH))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    backup, press = landed_then_crashed(m, monkeypatch)
    (lunch,) = named(m, "Lunch")
    del m.gmail.events[lunch["id"]]                                           # that write never landed
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    cards = new_cards(m, before)
    card = next(c["text"] for c in cards if "Part of it is on your calendar" in c["text"])
    assert "Dentist: on your calendar" in card and "Lunch: not on your calendar" in card
    assert "Go ahead does only the parts that aren't there" in card
    seen = len(m.link.cards)
    out = m.tap("Go ahead")
    assert out["status"] == "ok"
    for _ in range(4):
        m.c.tick()
    m.c.outbox.flush()
    assert len(named(m, "Dentist")) == 1 and len(named(m, "Lunch")) == 1
    dentist_inserts = [e for e in m.gmail.log if e[0] == "insert" and e[1]["summary"] == "Dentist"]
    assert len(dentist_inserts) == 1                                          # the part that was there: not run
    after = new_said(m, seen)
    assert any("Lunch" in t for t in after) and not any("Dentist" in t and "Already there" in t for t in after)


# -- 4. the tap's age: the journal's time wins on a large disagreement -----------------------------------------------

def test_a_taps_age_within_tolerance_is_discords_and_beyond_it_the_journals(m):
    near = {"press": {"id": snowflake(time.time() - 600)}, "at": time.time() - 560}
    assert 590 < m.c._tap_age(near) < 610                                     # they agree: Discord's own stamp
    far = {"press": {"id": snowflake(time.time() - 3600)}, "at": time.time()}   # an hour apart
    assert m.c._tap_age(far) < 60                                             # the journal's time wins
    behind = {"press": {"id": snowflake(time.time())}, "at": time.time() - 3600}
    assert 3500 < m.c._tap_age(behind) < 3700                                 # either way round


# -- 6. the relist's first message, and taps with no readable time --------------------------------------------------

def test_the_first_message_points_at_the_cards_and_an_untimed_tap_always_gets_one(m):
    inbox = m.c.handovers
    now = time.time()
    for i in range(12):
        press = {"id": str(72000 + i), "token": "t", "app": "9", "custom_id": f"hx:c:tap{i}", "message_id": "1"}
        assert inbox._append({"press": press, "at": now - 3600 + i * 60})
    untimed = {"id": "72999", "token": "t", "app": "9", "custom_id": "hx:c:untimed", "message_id": "1"}
    assert inbox._append({"press": untimed, "at": "not a time"})
    before = len(m.link.cards)
    relist_now(m)
    said = new_said(m, before)
    head = next(t for t in said if "records were put back from a backup" in t)
    assert "on the cards below" in head and "Go ahead of its own" not in head
    assert any("A tap of yours (time unknown)." in t for t in said)
    cards = [t for t in said if t.startswith("A tap of yours")]
    assert len(cards) == m.c.RELIST_MAX
    rest = next(t for t in said if t.startswith("Older taps"))
    assert len([x for x in rest.split("\n")[1:] if x.strip()]) == 3          # 13 taps, 10 cards, 3 listed


def test_a_card_without_a_go_ahead_is_never_promised_one(m):
    inbox = m.c.handovers
    press = {"id": "73001", "token": "t", "app": "9", "custom_id": "hx:c:clear", "message_id": "1"}
    assert inbox._append({"press": press, "at": time.time() - 60})
    assert inbox.journal_intent(press, {"effect": "calendar", "kind": "mail_dates_undo", "choice": True})
    before = len(m.link.cards)
    relist_now(m)
    said = [c["text"] for c in new_cards(m, before)]
    assert not any("Go ahead" in t for t in said if "records were put back" in t)
    assert "Go ahead" not in card_labels(new_cards(m, before))


def test_nothing_he_sees_on_an_unknown_tap_asks_him_to_tap_again(m):
    assert "again" not in m.c.TAP_UNKNOWN.lower().replace("nothing is done twice", "")
    assert "tap again" not in m.c.TAP_UNKNOWN.lower() and "send" not in m.c.TAP_UNKNOWN.lower()
