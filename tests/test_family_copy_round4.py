"""Round 4 of the second review of PR 73 (Nov 28): the two last gaps, each on its own. All names, ids and places are
invented.

1. The three-404 take-it-off card takes the same approval as every removal of a copy left alone: it names the exact
   copy and what changed on it, says approving discards it, removes it only with If-Match on the version the card
   showed, and a newer version at his tap writes nothing and sends a fresh card.
2. A queued move only ever updates, with If-Match, never a create. A removal he approved, and a copy someone took
   off Family, are recorded as reasons never to make the copy again; queued work checks those records when it runs,
   and never acts on a copy whose removal he just approved.
"""
import json
import sqlite3

import pytest

from harness import caldav, family_copy
from fakes import result
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_family_copy_follows import (ALARM, DAY, INSTANCE, ORIGINAL, at, copy_path, copy_writes, m, moved_by_hand,
                                      row, sync, with_added)  # noqa: F401
from test_family_copy_round3 import purge


def purged_and_due(m):
    sync(m)
    purge(m)
    for _ in range(family_copy.MISSING_404S + 1):
        sync(m)
    assert m.copier.purged_due() == [m.key]
    m.c.family_copy = m.copier


def card(m):
    assert m.c._purged_copy_cards() == 1
    m.c.tick()
    return m.seen()[-1]


def deletes(m):
    return [x for x in copy_writes(m) if x[0] == "DELETE"]


# -- 1. the three-404 card --------------------------------------------------------------------------------------

def test_1_the_purged_card_names_the_copy_says_nothing_changed_and_that_approving_discards_it(m):
    purged_and_due(m)
    text = card(m)
    assert "Take the Family copy of “Alex - Coffee” on Nov 12 off (nothing on it changed since Harness " \
           "wrote it). Approving discards it as it is now" in text
    assert "approving discards what is on the Family copy of “Alex - Coffee” on Nov 12 now" in text
    assert "is no longer known to Google" in text and copy_path(m) in m.icloud.events
    shown = m.icloud.events[copy_path(m)][0]
    m.tap("Approve")
    assert deletes(m) and deletes(m)[-1][2]["If-Match"] == shown and copy_path(m) not in m.icloud.events
    assert row(m)["state"] == "asked_off"


def test_1_a_purged_copy_someone_changed_gets_its_card_naming_the_change(m):
    """Before this round a changed copy got no card at all; now it gets the same card as any copy left alone."""
    purged_and_due(m)
    m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    sync(m)
    assert row(m)["state"] == "hands_off"
    text = card(m)
    assert "Take the Family copy of “Alex - Coffee” on Nov 12 off (changed on Family: an alert). " \
           "Approving discards it as it is now" in text
    shown = m.icloud.events[copy_path(m)][0]
    m.tap("Approve")
    assert deletes(m)[-1][2]["If-Match"] == shown and copy_path(m) not in m.icloud.events


def test_1_a_newer_version_at_his_tap_writes_nothing_and_a_fresh_card_shows_it(m):
    purged_and_due(m)
    card(m)
    m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], "LOCATION:Corner Cafe"))
    m.tap("Approve")
    assert not deletes(m) and copy_path(m) in m.icloud.events          # nothing sent over the newer version
    assert any("that Family copy changed since your card. A fresh card follows" in x for x in m.seen())
    assert "(changed on Family: a place). Approving discards it as it is now" in m.seen()[-1]
    newer = m.icloud.events[copy_path(m)][0]
    m.tap("Approve")
    assert deletes(m)[-1][2]["If-Match"] == newer and copy_path(m) not in m.icloud.events


def test_1_the_removal_goes_only_over_the_version_the_card_showed(m):
    purged_and_due(m)
    card(m)
    x = m.cc._copy_by_record(row(m))
    x.copy_of = m.key
    read = m.cc._family_fetch(copy_path(m))
    with pytest.raises(Exception) as why:
        m.cc._copy_owned(m.key, read, "delete", take_back='"another"', live_ok=True)
    assert "changed since your card" in str(getattr(why.value, "words", why.value))
    assert not deletes(m)


# -- 2. queued work ---------------------------------------------------------------------------------------------

def queued_move(m):
    """His coffee's copy, with a move queued after a write (its Gmail event moved on while the copy was written)."""
    sync(m)
    family_copy.queue(m.ledger, m.key, "move", '"c1"')
    moved_by_hand(m, at(13, day=DAY), at(14, day=DAY))


def test_2_a_copy_change_with_no_version_is_never_sent_least_of_all_as_a_create(m):
    sync(m)
    before = len(copy_writes(m))
    r = row(m)
    want = family_copy.Want(m.key, r["word"], r["title"], at(13, day=DAY), at(14, day=DAY))
    for etag in (None, ""):
        verdict, out = m.copier._guarded(r, etag, m.icloud.events[copy_path(m)][1], want,
                                         (r["title"], ORIGINAL, ORIGINAL))
        assert verdict == "failed"
    assert len(copy_writes(m)) == before


def test_2_a_queued_move_over_a_listing_without_a_version_waits_and_sends_nothing(m):
    queued_move(m)
    before = len(copy_writes(m))
    item = caldav.Item(occ=None, href=copy_path(m), etag=None, data=m.icloud.events[copy_path(m)][1])
    want = family_copy.Want(m.key, row(m)["word"], row(m)["title"], at(13, day=DAY), at(14, day=DAY))
    assert m.copier._work_queue(row(m), item, want) is True
    assert len(copy_writes(m)) == before
    assert not any(x[2].get("If-None-Match") for x in copy_writes(m)[before:])


def test_2_a_queued_move_is_an_update_with_if_match(m):
    queued_move(m)
    before = len(copy_writes(m))
    shown = m.icloud.events[copy_path(m)][0]
    sync(m)
    sent = copy_writes(m)[before:]
    assert sent and sent[0][0] == "PUT" and sent[0][2].get("If-Match") == shown
    assert not any(x[2].get("If-None-Match") for x in sent)


def test_2_an_approved_removal_drops_queued_work_and_the_copy_is_never_made_again(m):
    sync(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    family_copy.queue(m.ledger, m.key, "move", '"c1"')                 # queued before his tap
    m.tap("Approve")
    assert copy_path(m) not in m.icloud.events
    assert family_copy.queued(m.ledger, m.key) is None
    assert family_copy.suppressed(m.ledger, m.key)["why"] == "asked_off"
    m.gmail.events[INSTANCE]["status"] = "confirmed"                   # the event comes back, by his own hand
    before = len(copy_writes(m))
    for _ in range(3):
        sync(m)
    assert copy_path(m) not in m.icloud.events and len(copy_writes(m)) == before


def test_2_his_undo_of_the_removal_clears_the_record(m):
    sync(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    m.tap("Approve")
    assert family_copy.suppressed(m.ledger, m.key) is not None
    m.tap("Undo")
    assert family_copy.suppressed(m.ledger, m.key) is None


def test_2_a_copy_someone_took_off_family_is_recorded_and_never_made_again(m):
    sync(m)
    del m.icloud.events[copy_path(m)]
    for _ in range(family_copy.READS_BEFORE_REMOVING + 1):
        sync(m)
    assert family_copy.suppressed(m.ledger, m.key)["why"] == "household"
    moved_by_hand(m, at(13, day=DAY), at(14, day=DAY))
    with m.ledger.tx() as db:                                           # even if its record were to say cancelled
        db.execute("UPDATE family_copies SET state='cancelled' WHERE key=?", (m.key,))
    before = len(copy_writes(m))
    for _ in range(3):
        sync(m)
    assert copy_path(m) not in m.icloud.events and len(copy_writes(m)) == before


@pytest.mark.parametrize("why", ["approving", "asked_off", "household"])
def test_2_queued_work_rechecks_the_records_and_never_acts_on_the_copy(m, why):
    queued_move(m)
    family_copy.suppress(m.ledger, m.key, why)
    before = len(copy_writes(m))
    sync(m)
    assert len(copy_writes(m)) == before
    assert family_copy.queued(m.ledger, m.key) is None


def test_2_an_approved_removal_is_marked_before_its_delete_is_sent(m):
    """The mark goes in before the write, so a reconciliation running meanwhile leaves the copy alone."""
    sync(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    family_copy.queue(m.ledger, m.key, "move", '"c1"')
    seen = {}

    def look():                                    # the write runs on its own thread: its own connection
        with sqlite3.connect(m.ledger.path) as db:
            got = dict(db.execute("SELECT key, value FROM meta WHERE key IN (?, ?)",
                                  (family_copy.SUPPRESS + m.key, family_copy.RECONCILE + m.key)).fetchall())
        seen["mark"] = json.loads(got.get(family_copy.SUPPRESS + m.key) or "null")
        seen["queued"] = got.get(family_copy.RECONCILE + m.key)
    m.icloud.before_write = look
    m.tap("Approve")
    assert seen["mark"]["why"] == "approving" and seen["queued"] is None


def test_2_an_approving_mark_lapses_and_an_unreadable_record_counts(m):
    family_copy.suppress(m.ledger, m.key, "approving")
    assert family_copy.suppressed(m.ledger, m.key)["why"] == "approving"
    m.clock.advance(hours=2)
    assert family_copy.suppressed(m.ledger, m.key) is None
    family_copy.suppress(m.ledger, m.key, "household")
    family_copy.suppress(m.ledger, m.key, "approving")                  # never outranks a removal
    assert family_copy.suppressed(m.ledger, m.key)["why"] == "household"
    family_copy._set_meta(m.ledger, family_copy.SUPPRESS + m.key, "{not json")
    assert family_copy.suppressed(m.ledger, m.key) == {"why": "unreadable"}
