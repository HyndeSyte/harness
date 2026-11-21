"""0.24.0, twenty-fifth round: the defects the twenty-fourth outside review found in the twenty-fourth round's additions.

1. A relist the records refuse is held at each tap's own boundary: that tap is put off on the 1 to 60-minute back-off
   (in memory and beside the journal) without reading the calendar again, and the other taps in the same ticks settle.
2. The aborted-transaction error is held at the same boundary, in the running loop and at a start, and a start
   replay it put off is taken up again from the main loop.
3. The set-aside tool exports, discards or requeues: a discarded tap is never read or taken again across a restart;
   a requeued one is checked first and, with an outcome, only struck.
4. A tap set aside for a press that doesn't match its journal lines gets one operator card.
5. A kept copy that can't be written sets the tap aside after the schedule's six tries, with one operator card.
7. With the file beside the journal unwritable too, the App's health says so, at most once an hour in the log.
8. An exception's message is scrubbed of secrets before it's journaled or kept.
10. A tap relisted six times gets one card saying nothing more is done for it, and is struck.
All names and ids invented.
"""
import json
import logging
import sqlite3

import pytest

from harness import migrate
from harness.controller import Controller
from harness.handover import Handover, Inbox
from harness.ledger import Ledger, TransactionAborted
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import dentist_card, dentists, m, tap_journaled  # noqa: F401
from test_handover_round18_taps import later, real_restart
from test_handover_round19_taps import cut_after
from test_handover_round20_taps import states
from test_handover_round22_taps import counted_reads, flags, journal_unwritable, to_the_last_calendar_read
from test_handover_round23_taps import queued, raising_hold, unknown_tap
from test_handover_round24_taps import carded_unreadable, records_refuse
from test_outbox_round23 import RollbackFails
from test_outbox_round24 import relisted
from fake_caldav import no_network  # noqa: F401  (autouse)

UNTAKEN = "the error came before it was taken"


def per_tap(monkeypatch):
    """Every unknown tap's records say untaken and its calendar reads it as not done: each is relisted with Go
    ahead. The calendar reads and hold reads are counted per tap. (Twenty-seventh round: a read that answers, since
    only those verdicts are kept for a relist the records refuse; a failed read is read again.)"""
    reads, holds = {}, {}

    def hold(self, p):
        holds[p["id"]] = holds.get(p["id"], 0) + 1
        return "untaken"

    def read(self, op):
        tap = str(op.get("proposal", "")).removeprefix("p-")
        reads[tap] = reads.get(tap, 0) + 1
        return ("not_done", [])
    monkeypatch.setattr(Controller, "_records_hold", hold)
    monkeypatch.setattr(Controller, "_tap_read", read)
    return reads, holds


def relist_refused_for(mp, key):
    """The records refuse that one tap's relisted mark (its other writes too, being in one transaction)."""
    real_set = Ledger.set_meta

    def set_meta(self, k, value, db=None):
        if k == Controller.RELIST_FLAG + key:
            raise sqlite3.OperationalError("disk I/O error")
        return real_set(self, k, value, db)
    mp.setattr(Ledger, "set_meta", set_meta)


def settled(m, press):
    k = m.c.handovers.key(press)
    return (m.ledger.get_meta("outbox_once:" + Ledger.once_key(k, "relist", "1")) is not None
            and k not in [m.c.handovers.key(r["press"]) for r in m.c.handovers.journaled()])


# -- 1. a relist the records refuse, per tap ---------------------------------------------------------------------------

@pytest.mark.card_only
def test_a_relist_the_records_refuse_puts_off_that_tap_and_the_others_settle(m, monkeypatch, clock):
    a, b, c = unknown_tap(m, "95101"), unknown_tap(m, "95102"), unknown_tap(m, "95103")
    reads, _ = per_tap(monkeypatch)
    with monkeypatch.context() as mp:
        relist_refused_for(mp, m.c.handovers.key(a))
        later(m, clock, 61)                                                    # no error out of the tick
        assert settled(m, b) and settled(m, c)                                 # the others in that very tick
        for _ in range(200):                                                   # ten minutes of ticks
            later(m, clock, 3)
        assert reads["95101"] <= len(Controller.CHECK_BACKOFF_S)               # the back-off's reads at most
        assert reads["95101"] == 1                                             # the completed read isn't repeated
        assert reads["95102"] == 1 and reads["95103"] == 1
        assert [r["press"]["id"] for r in m.c.handovers.journaled()] == ["95101"]
        side = json.loads(open(m.c.handovers.journal + Controller.REREAD_SIDE).read())
        assert m.c.handovers.key(a) in side["taps"]                            # kept beside the journal too
        assert len(queued(m, UNTAKEN)) == 2
    for _ in range(3):                                                         # the records write again
        later(m, clock, 3601)
    assert settled(m, a) and m.c.handovers.journaled() == []
    assert len(queued(m, UNTAKEN)) == 3                                        # one card each, never twice


# -- 2. an aborted transaction, held per tap ---------------------------------------------------------------------------

def cleanup_fails_for(m, mp, tap_id):
    """That one tap's card write fails, and its savepoint's cleanup fails too: TransactionAborted, every time."""
    real_set = Ledger.set_meta

    def set_meta(self, key, value, db=None):
        if key.startswith("outbox_once:") and tap_id in key:
            raise RuntimeError("the write failed")
        return real_set(self, key, value, db)
    mp.setattr(Ledger, "set_meta", set_meta)
    real_conn = m.ledger.db
    m.ledger.db = RollbackFails(real_conn)
    return real_conn


@pytest.mark.card_only
def test_a_tap_whose_cleanup_always_fails_doesnt_stop_the_others_in_the_running_loop(m, monkeypatch, clock):
    a, b, c = unknown_tap(m, "95301"), unknown_tap(m, "95302"), unknown_tap(m, "95303")
    reads, _ = per_tap(monkeypatch)
    with monkeypatch.context() as mp:
        real_conn = cleanup_fails_for(m, mp, "95301")
        later(m, clock, 61)
        assert settled(m, b) and settled(m, c)
        for _ in range(100):
            later(m, clock, 3)
        assert reads["95301"] == 1
        assert [r["press"]["id"] for r in m.c.handovers.journaled()] == ["95301"]
    m.ledger.db = real_conn
    for _ in range(3):
        later(m, clock, 3601)
    assert settled(m, a)


@pytest.mark.card_only
def test_a_tap_whose_cleanup_always_fails_doesnt_stop_the_others_at_a_start(m, monkeypatch, clock, tmp_path):
    a, b, c = unknown_tap(m, "95311"), unknown_tap(m, "95312"), unknown_tap(m, "95313")
    reads, _ = per_tap(monkeypatch)
    with monkeypatch.context() as mp:
        real_conn = cleanup_fails_for(m, mp, "95311")
        real_restart(m, tmp_path)                                              # the start replay settles them
        assert settled(m, b) and settled(m, c)
        for _ in range(100):
            later(m, clock, 3)
        assert reads["95311"] == 1
    m.ledger.db = real_conn
    for _ in range(3):
        later(m, clock, 3601)
    assert settled(m, a)


@pytest.mark.card_only
def test_a_start_replay_put_off_is_taken_up_again_from_the_main_loop(m, monkeypatch, clock, tmp_path):
    h = m.c.handovers
    notes = []
    for tap_id in ("95321", "95322"):
        press = {"id": tap_id, "custom_id": f"k:a:r25{tap_id}", "token": "t", "app": "999", "message_id": "5"}
        assert h.journal_add(Handover(kind="press", press=press))
        assert h.journal_outcome(press, "refused", note=f"Not taken {tap_id[-1]}.")
        notes.append(f"Not taken {tap_id[-1]}.")
    monkeypatch.setattr(Inbox, "notify", lambda self, hv, text: False)       # posted as a message
    real = Controller._post_pending_notice
    calls = {"n": 0}

    def post(self, row):
        calls["n"] += 1
        if row["press"]["id"] == "95321" and calls["n"] == 1:
            raise TransactionAborted("the records' transaction was aborted")
        return real(self, row)
    monkeypatch.setattr(Controller, "_post_pending_notice", post)
    real_restart(m, tmp_path)                                                  # no error out of the start
    assert len(queued(m, notes[1])) == 1 and queued(m, notes[0]) == []
    later(m, clock, 61)                                                        # the main loop takes it up again
    assert len(queued(m, notes[0])) == 1 and len(queued(m, notes[1])) == 1   # each once
    assert m.c.handovers.journaled() == []


# -- 3. the set-aside tool: export, discard, requeue ------------------------------------------------------------------

def touched(monkeypatch, tap_id):
    """Everything that reads the calendar for a tap, or takes it (a write), counted for that tap."""
    n = {"reads": 0, "holds": 0, "taken": 0}
    real_read, real_hold, real_give = Controller._tap_read, Controller._records_hold, Inbox.give_back

    def read(self, op):
        if tap_id in json.dumps(op):
            n["reads"] += 1
        return real_read(self, op)

    def hold(self, p):
        if p.get("id") == tap_id:
            n["holds"] += 1
        return real_hold(self, p)

    def give(self, hs):
        n["taken"] += sum(1 for hv in hs if hv.press.get("id") == tap_id)
        return real_give(self, hs)
    monkeypatch.setattr(Controller, "_tap_read", read)
    monkeypatch.setattr(Controller, "_records_hold", hold)
    monkeypatch.setattr(Inbox, "give_back", give)
    return n


def set_aside_unknown(m, clock, tap_id):
    press = unknown_tap(m, tap_id)
    key = m.c.handovers.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, "{not json", db)
    later(m, clock, 3)
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None
    return press, key


@pytest.mark.card_only
def test_a_discarded_tap_is_never_read_or_taken_again_across_a_restart(m, monkeypatch, clock, tmp_path):
    press, key = set_aside_unknown(m, clock, "95401")
    journal = m.c.handovers.journal
    got = migrate.set_aside_taps(m.ledger.path, key, "export", journal=journal)
    assert got["ok"] and m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None   # still set aside
    kept = json.loads((tmp_path / migrate.SET_ASIDE_TAPS).read_text())[key]
    assert kept["journal"] and all("token" not in (r.get("press") or {}) for r in kept["journal"])
    got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=journal)
    assert got["ok"] and m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is None
    assert m.ledger.get_meta(migrate.TAP_DISCARDED + key) is not None
    n = touched(monkeypatch, "95401")
    real_restart(m, tmp_path)
    for _ in range(20):
        later(m, clock, 3601)
    assert n == {"reads": 0, "holds": 0, "taken": 0}                          # no read, no write, ever
    assert len(queued(m, Controller.UNREADABLE_STRIKE_WORDS)) == 1
    assert [r["press"]["id"] for r in m.c.handovers.journaled()] == ["95401"]  # its lines stay, inert
    assert migrate.set_aside_taps(m.ledger.path)["discarded"] == [key]


@pytest.mark.card_only
def test_a_requeued_tap_with_an_outcome_is_only_struck(m, monkeypatch, clock, tmp_path):
    press = {"id": "12|34", "custom_id": "k:c:Ab25", "token": "t", "app": "999", "message_id": "12"}
    key = carded_unreadable(m, press)
    later(m, clock, 3)                                                         # set aside: the press didn't match
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None
    cards = m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=m.c.handovers.journal)
    assert got["ok"] and "struck" in got["said"]
    flag = json.loads(m.ledger.get_meta(Controller.STRIKE_FLAG + key))
    assert flag["press"]["id"] == "12|34" and flag["state"] == "unverified"   # the journal's own press
    n = touched(monkeypatch, "12|34")
    real_restart(m, tmp_path)
    later(m, clock, 3)
    assert m.c.handovers.journaled() == [] and flags(m) == []                  # struck, nothing else
    assert n == {"reads": 0, "holds": 0, "taken": 0}
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == cards


@pytest.mark.card_only
def test_a_requeue_whose_press_doesnt_check_out_is_refused(m, clock):
    h = m.c.handovers
    press = {"id": "95411", "custom_id": "k:c:r25odd"}
    assert h.journal_outcome(press, "unverified")                              # a line with no press of its own
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=h.journal)
    assert not got["ok"] and m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None
    assert m.ledger.get_meta(Controller.STRIKE_FLAG + key) is None


@pytest.mark.card_only
def test_a_requeued_tap_with_no_outcome_is_read_on_the_calendar_before_anything(m, monkeypatch, clock):
    press, key = set_aside_unknown(m, clock, "95421")
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=m.c.handovers.journal)
    assert got["ok"] and "reads your calendar" in got["said"]
    assert m.ledger.get_meta(Controller.STRIKE_FLAG + key) is None
    n = touched(monkeypatch, "95421")
    later(m, clock, 61)
    assert n["holds"] >= 1 and n["taken"] == 0                                 # read first, never taken by itself


def test_the_set_aside_tool_names_its_operations(m):
    got = migrate.set_aside_taps(m.ledger.path, "1|x", "clear")
    assert not got["ok"] and "export, discard or requeue" in got["said"]


# -- 4. a press that doesn't match its journal: one operator card ------------------------------------------------------

@pytest.mark.card_only
def test_a_press_mismatch_set_aside_gets_one_operator_card(m, clock, tmp_path):
    press = {"id": "56|78", "custom_id": "k:c:Mm25", "token": "t", "app": "999", "message_id": "12"}
    key = carded_unreadable(m, press)
    later(m, clock, 3)
    for _ in range(20):
        later(m, clock, 61)
    real_restart(m, tmp_path)
    later(m, clock, 61)
    assert len(queued(m, Controller.UNREADABLE_STRIKE_WORDS)) == 1
    assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(key, "operator", "quarantine")) is not None
    record = json.loads(m.ledger.get_meta(Controller.QUARANTINE_FLAG + key))
    assert record["why"] == "journal mismatch" and record["rows"]


@pytest.mark.card_only
def test_the_mismatch_card_and_the_set_aside_go_together(m, monkeypatch, clock):
    press = {"id": "56|79", "custom_id": "k:c:Mm25b", "token": "t", "app": "999", "message_id": "12"}
    key = carded_unreadable(m, press)
    with monkeypatch.context() as mp:
        real = Ledger.enqueue

        def enqueue(self, *a, **kw):
            if "quarantine" in str(kw.get("once") or ""):
                raise sqlite3.OperationalError("database is locked")
            return real(self, *a, **kw)
        mp.setattr(Ledger, "enqueue", enqueue)
        later(m, clock, 3)
        assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is None   # neither without the other
        assert m.ledger.get_meta(Controller.STRIKE_FLAG + key) is not None
    for _ in range(3):
        later(m, clock, 3601)
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None
    assert len(queued(m, Controller.UNREADABLE_STRIKE_WORDS)) == 1


# -- 5. a kept copy that can never be written --------------------------------------------------------------------------

@pytest.mark.card_only
def test_a_kept_copy_that_always_fails_sets_the_tap_aside_after_six_tries(m, monkeypatch, clock, tmp_path):
    h = m.c.handovers
    press = {"id": "95501", "custom_id": "k:a:r25copy", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_outcome(press, "internal_error", error="ValueError: bad value")
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(f"tap_card_queued:{key}", "1", db)
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, json.dumps({"press": press, "fails": 0, "due": 0,
                                                                    "state": "internal_error"}), db)
    tries = {"n": 0}
    real_set = Ledger.set_meta

    def set_meta(self, k, value, db=None):
        if k.startswith(Controller.DIAG_FLAG):
            tries["n"] += 1
            raise sqlite3.OperationalError("database or disk is full")
        return real_set(self, k, value, db)
    monkeypatch.setattr(Ledger, "set_meta", set_meta)
    for _ in range(12):
        later(m, clock, 3601)
    real_restart(m, tmp_path)
    for _ in range(12):
        later(m, clock, 3601)
    assert tries["n"] == len(Controller.STRIKE_BACKOFF_S)                      # then never tried again
    assert m.ledger.get_meta(Controller.STRIKE_FLAG + key) is None
    record = json.loads(m.ledger.get_meta(Controller.QUARANTINE_FLAG + key))
    assert record["why"] == "kept copy failed"
    assert record["rows"] and all("token" not in (r.get("press") or {}) for r in record["rows"])
    assert any(r.get("error") == "ValueError: bad value" for r in record["rows"])
    assert len(queued(m, Controller.UNREADABLE_STRIKE_WORDS)) == 1
    assert [r["press"]["id"] for r in h.journaled()] == ["95501"]              # never struck without its copy


# -- 7. the side file refusing too ------------------------------------------------------------------------------------

@pytest.mark.card_only
def test_with_the_side_file_unwritable_too_the_apps_health_says_so(m, monkeypatch, clock, tmp_path, caplog):
    to_the_last_calendar_read(m, monkeypatch, clock)
    journal_unwritable(monkeypatch)
    records_refuse(monkeypatch)
    monkeypatch.setattr(Controller, "_side_save", lambda self, data: False)
    caplog.set_level(logging.ERROR, logger="harness.controller")
    later(m, clock, 3601)                                                      # the last read: unverified, unsaved
    assert "storage" in m.c.handovers.health()
    assert m.c.notes["tap_storage"] == Controller.STORAGE_WORDS
    for _ in range(200):
        later(m, clock, 3)
    said = [r for r in caplog.records if "neither the records nor the file beside" in r.getMessage()]
    assert len(said) == 1                                                      # once an hour, in memory
    real_restart(m, tmp_path)                                                  # a start that can't count itself
    assert "storage" in m.c.handovers.health() and "tap_storage" in m.c.notes


def test_the_alarm_clears_once_the_side_file_takes_a_write(m):
    m.c._storage_alarm()
    assert "storage" in m.c.handovers.health()
    assert m.c._side_save({"taps": {"1|x": {"fails": 1, "due": 0}}})
    assert "storage" not in m.c.handovers.health() and "tap_storage" not in m.c.notes


# -- 8. secrets scrubbed from errors -----------------------------------------------------------------------------------

@pytest.mark.card_only
def test_an_errors_secrets_are_scrubbed_before_they_are_journaled_or_kept(m, monkeypatch, clock):
    dentist_card(m)
    press = cut_after(m, monkeypatch)
    key = m.c.handovers.key(press)
    message = (f"GET https://calendar.example/feeds/x?key={TOKEN}&alt=json failed with headers "
               f"{{'Authorization': 'Bot {TOKEN}'}} and {TOKEN}")
    raising_hold(m, monkeypatch, exc=ValueError(message))
    for _ in range(14):
        later(m, clock, 3601)
    assert states(m) == []                                                     # struck as an internal error
    diag = m.ledger.get_meta(Controller.DIAG_FLAG + key)
    assert TOKEN not in diag and "[redacted]" in json.loads(diag)["error"]
    assert "calendar.example/feeds/x?[redacted]" in json.loads(diag)["error"]


@pytest.mark.card_only
def test_a_legacy_journal_error_is_scrubbed_when_it_is_copied(m, clock):
    h = m.c.handovers
    press = {"id": "95801", "custom_id": "k:a:r25legacy", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_outcome(press, "internal_error", error=f"HTTPError: https://x.example/a?token={TOKEN}")
    later(m, clock, 3)
    diag = m.ledger.get_meta(Controller.DIAG_FLAG + h.key(press))
    assert diag is not None and TOKEN not in diag


# -- 10. relist generations are capped ---------------------------------------------------------------------------------

def test_a_tap_relisted_past_the_cap_gets_one_ended_card_and_is_struck(m, monkeypatch):
    press = {"id": "96501", "custom_id": "k:a:r25cap", "token": "t", "app": "999", "message_id": "5"}
    for _ in range(Controller.RELIST_GEN_CAP):
        relisted(m, press)
    n = m.ledger.db.execute("SELECT COUNT(*) FROM choices WHERE kind='tap_reconfirm'").fetchone()[0]
    assert n == Controller.RELIST_GEN_CAP
    reads = counted_reads(monkeypatch)
    relisted(m, press)                                                         # the seventh: ended, struck
    relisted(m, press)
    assert m.ledger.db.execute("SELECT COUNT(*) FROM choices WHERE kind='tap_reconfirm'").fetchone()[0] == n
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1
    assert reads["n"] == 0
    key = m.c.handovers.key(press)
    assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(key, "relist", "ended")) is not None
