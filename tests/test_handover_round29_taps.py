"""0.24.0, twenty-ninth round: the defects the twenty-eighth outside review found in the twenty-eighth round's
additions.

1. A discard's rewrite of the tap journal holds the journal's exclusive append lock across its read, filter,
   temporary write, fsync, rename and folder fsync, so a tap appended meanwhile (another thread or process) waits
   and survives; with no lock to take it appends a tombstone that every reader honours instead.
2. Every path that lowers or resets a relist count (a requeue, a discard) changes or clears the tap's count beside
   the journal in the same step as its mark, so the larger of the two never brings a lowered count back.
3. An ended mark is terminal whatever its generation: the state is read first.
5. Marks written by earlier builds (an ended value at the old over-cap number, a struck mark written as nought)
   are put into this build's schema once, at a start.
6. The set-aside list unreadable for four hours: every calendar read and write, ledger read and log line counted.
7. When the waiting flag first sets, one once-keyed card for him.
All names and ids invented.
"""
import json
import logging
import os
import sqlite3
import subprocess
import sys
import threading

import pytest

from harness import handover, migrate
from harness.controller import Controller
from harness.handover import Handover, Inbox
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import m  # noqa: F401
from test_handover_round18_taps import later, real_restart
from test_handover_round23_taps import queued
from test_handover_round26_taps import reconfirms
from test_handover_round27_taps import RefusingConnection
from test_handover_round28_taps import intents, mark, refused, set_aside_started
from test_outbox_round24 import relisted
from fake_caldav import no_network  # noqa: F401  (autouse)

APP = os.path.join(os.path.dirname(__file__), "..", "harness", "app")


def tap(n):
    return {"id": str(n), "custom_id": f"k:a:r29{n}", "token": "t", "app": "999", "message_id": "5"}


def side(m):
    try:
        with open(m.c.handovers.journal + Controller.REREAD_SIDE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def set_side_gen(m, key, gen):
    got = side(m)
    got.setdefault("taps", {})
    got.setdefault("gens", {})[key] = gen
    with open(m.c.handovers.journal + Controller.REREAD_SIDE, "w", encoding="utf-8") as f:
        json.dump(got, f)


def quarantine(m, key):
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)


def journal_text(m):
    with open(m.c.handovers.journal, encoding="utf-8") as f:
        return f.read()


def orphaned(m, n):
    """A set-aside tap whose requeue the records refused, so its intent is in the journal (the twenty-eighth
    round's orphan), ready to be discarded."""
    press, key = set_aside_started(m, n)
    with pytest.MonkeyPatch.context() as mp:
        refused(m, mp, key, "requeue")
    assert len(intents(m, key)) == 1
    return press, key


# -- 1. the discard's rewrite holds the journal's append lock -----------------------------------------------------------

@pytest.mark.card_only
def test_a_tap_appended_by_another_thread_during_the_discard_rewrite_survives(m, monkeypatch):
    press, key = orphaned(m, 99101)
    late = tap(99102)
    real_replace, done = os.replace, {}

    def append():
        other = Inbox(lambda: "", journal=m.c.handovers.journal)               # another writer of the journal
        done["ok"] = other.journal_add(Handover(kind="press", press=late))

    def replace(src, dst, *a, **kw):
        if dst == m.c.handovers.journal and "t" not in done:
            done["t"] = threading.Thread(target=append)
            done["t"].start()
            done["t"].join(0.5)                                                # it waits on the lock, or lands
        return real_replace(src, dst, *a, **kw)
    monkeypatch.setattr(os, "replace", replace)
    got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)
    done["t"].join(5)
    assert got["ok"] and done["ok"]
    assert intents(m, key) == []                                               # the orphan intent is gone
    assert '"99102"' in journal_text(m)                                        # and his later tap survived
    assert m.c.handovers.key(late) in {m.c.handovers.key(r["press"]) for r in m.c.handovers.journaled()}


APPEND = """
import sys
sys.path.insert(0, sys.argv[1])
from harness.handover import Handover, Inbox
ok = Inbox(lambda: "", journal=sys.argv[2]).journal_add(Handover(kind="press", press={"id": "99112",
           "custom_id": "k:a:r2999112", "token": "t", "app": "999", "message_id": "5"}))
sys.exit(0 if ok else 3)
"""


@pytest.mark.card_only
def test_a_tap_appended_by_another_process_during_the_discard_rewrite_survives(m, monkeypatch):
    press, key = orphaned(m, 99111)
    real_replace, proc = os.replace, {}

    def replace(src, dst, *a, **kw):
        if dst == m.c.handovers.journal and "p" not in proc:
            proc["p"] = subprocess.Popen([sys.executable, "-c", APPEND, os.path.abspath(APP),
                                          m.c.handovers.journal])
            try:
                proc["p"].wait(3)                                              # it lands now, or waits on the lock
            except subprocess.TimeoutExpired:
                proc["waited"] = True
        return real_replace(src, dst, *a, **kw)
    monkeypatch.setattr(os, "replace", replace)
    got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)
    assert proc["p"].wait(10) == 0
    assert got["ok"] and proc.get("waited")                                    # it waited for the rewrite
    assert intents(m, key) == []
    assert '"99112"' in journal_text(m)                                        # his tap survived


class Killed(BaseException):
    """The process killed (a power cut, a kill -9) at that point."""


@pytest.mark.card_only
def test_the_rewrite_syncs_its_folder_after_the_rename_and_a_kill_there_leaves_nothing_to_act_on(m, monkeypatch,
                                                                                                  clock, tmp_path):
    press, key = orphaned(m, 99121)
    real_sync, seen = handover._fsync_dir, {}

    def sync(folder):
        if not os.path.exists(m.c.handovers.journal + ".tmp") and "killed" not in seen \
                and not intents(m, key):                                       # after the rename, before the lock goes
            seen["killed"] = True
            raise Killed()
        return real_sync(folder)
    monkeypatch.setattr(handover, "_fsync_dir", sync)
    with pytest.raises(Killed):
        migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)
    monkeypatch.setattr(handover, "_fsync_dir", real_sync)
    assert m.ledger.get_meta(migrate.TAP_DISCARDED + key) is not None           # the discard committed
    assert intents(m, key) == []
    assert m.c.handovers.journal_add(Handover(kind="press", press=tap(99122)))  # the lock went with the process
    reads = {"n": 0}

    def read(self, op):
        reads["n"] += 1
        return ("not_done", [])
    monkeypatch.setattr(Controller, "_tap_read", read)
    before = reconfirms(m)
    real_restart(m, tmp_path)
    for _ in range(6):
        later(m, clock, 3601)
    assert reconfirms(m) == before
    assert not any("99121" in t for t in queued(m, ""))


@pytest.mark.card_only
def test_the_old_journal_back_after_a_committed_discard_is_skipped_by_every_resume(m, monkeypatch, clock, tmp_path):
    """Power lost after the rename's commit but before its folder was on disk: the journal from before the rewrite
    comes back, the orphan intent in it, while the records keep the discard."""
    press, key = orphaned(m, 99131)
    old = journal_text(m)
    got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)
    assert got["ok"] and intents(m, key) == []
    with open(m.c.handovers.journal, "w", encoding="utf-8") as f:              # the old inode back
        f.write(old)
    assert len(intents(m, key)) == 1
    reads = {"n": 0}

    def read(self, op):
        reads["n"] += 1
        return ("not_done", [])
    monkeypatch.setattr(Controller, "_tap_read", read)
    monkeypatch.setattr(Controller, "_records_hold", lambda self, p: "untaken")
    before, cards = reconfirms(m), m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    real_restart(m, tmp_path)                                                  # the start replay
    m.c._resume_relists(m.c._relist_marks())                                   # the running loop's resumes
    m.c._resume_strikes(m.c._flags(Controller.STRIKE_FLAG))
    for _ in range(8):                                                         # and the running loop
        later(m, clock, 3601)
    assert reads["n"] == 0                                                     # never read on the calendar
    assert reconfirms(m) == before                                             # no Go ahead
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == cards   # no card
    assert m.ledger.get_meta(Controller.STRIKE_FLAG + key) is None
    assert m.ledger.get_meta(Controller.RELIST_FLAG + key) is None


@pytest.mark.card_only
def test_with_no_lock_to_take_the_discard_appends_a_tombstone_every_reader_honours(m, monkeypatch):
    press, key = orphaned(m, 99141)
    other = tap(99142)
    assert m.c.handovers.journal_add(Handover(kind="press", press=other))

    def no_lock(journal):
        raise PermissionError("read-only")
    monkeypatch.setattr(handover, "journal_lock", no_lock)
    before = journal_text(m)
    got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)
    assert got["ok"]
    after = journal_text(m)
    assert after.startswith(before)                                            # not rewritten: appended to
    assert '"cleared"' in after
    row = next(r for r in m.c.handovers.journaled() if m.c.handovers.key(r["press"]) == key)
    assert not row["intent"] and row["state"] != "unknown"                     # the tombstone is honoured
    lines, _ = migrate._tap_lines(m.c.handovers.journal, key)
    assert migrate._requeue_intents(lines, key) == 0


# -- 2. a requeue or a discard changes the count beside the journal in the same step as the mark ---------------------

def back_to_set_aside(m, press):
    """A tap brought back again (its journal lines put back) and set aside."""
    h = m.c.handovers
    key = h.key(press)
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_delivered(press)
    quarantine(m, key)
    return key


@pytest.mark.card_only
def test_a_requeue_after_six_relists_then_a_relist_gives_a_fresh_go_ahead_and_no_ended_card(m):
    press = tap(99201)
    for _ in range(Controller.RELIST_GEN_CAP):
        relisted(m, press)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP
    key = back_to_set_aside(m, press)
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=m.c.handovers.journal)
    assert got["ok"], got
    assert mark(m, key)["gen"] == 0 and side(m)["gens"][key] == 0             # both reset, in one step
    relisted(m, press)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP + 1                      # a fresh Go ahead
    assert queued(m, Controller.RELIST_ENDED_WORDS) == []                      # and no ended card
    assert mark(m, key)["gen"] == 1
    for _ in range(Controller.RELIST_GEN_CAP):                                 # its new count runs to the cap
        relisted(m, press)
    assert reconfirms(m) == 2 * Controller.RELIST_GEN_CAP
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1


@pytest.mark.card_only
def test_a_refused_requeue_puts_the_count_beside_the_journal_back(m, monkeypatch):
    press = tap(99202)
    for _ in range(4):
        relisted(m, press)
    key = back_to_set_aside(m, press)
    before = side(m)
    with monkeypatch.context() as mp:
        refused(m, mp, key, "requeue")
    assert side(m) == before and mark(m, key)["gen"] == 4                      # nothing lowered


@pytest.mark.card_only
def test_a_discard_clears_the_count_beside_the_journal_with_the_mark(m):
    press = tap(99203)
    for _ in range(3):
        relisted(m, press)
    key = back_to_set_aside(m, press)
    assert side(m)["gens"][key] == 3
    got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)
    assert got["ok"]
    assert key not in side(m).get("gens", {}) and m.ledger.get_meta(Controller.RELIST_FLAG + key) is None


@pytest.mark.card_only
def test_the_count_beside_the_journal_one_ahead_skips_one_generation_and_no_more(m):
    """A crash between the count beside the journal and the mark: the side entry one ahead."""
    press = tap(99204)
    for _ in range(3):
        relisted(m, press)
    key = m.c.handovers.key(press)
    set_side_gen(m, key, 4)
    for _ in range(3):
        relisted(m, press)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP - 1                      # one generation skipped, no more
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1


# -- 3. an ended mark is terminal whatever its generation ------------------------------------------------------------

@pytest.mark.card_only
def test_an_ended_mark_with_a_null_generation_and_a_side_entry_is_never_relisted(m, monkeypatch):
    press = tap(99301)
    key = m.c.handovers.key(press)
    relisted(m, press)
    with monkeypatch.context() as mp:                                          # no count anywhere: ended, unknown
        mp.setattr(Controller, "_side_load", lambda self: {})
        m.ledger.db.execute("UPDATE meta SET value=? WHERE key=?", ('{"gen": "x", "pending": false}',
                                                                   Controller.RELIST_FLAG + key))
        relisted(m, press)
    assert len(queued(m, Controller.UNKNOWN_COUNT_WORDS)) == 1
    assert mark(m, key)["gen"] is None and mark(m, key)["ended"] is True
    set_side_gen(m, key, 3)                                                    # a stale count beside the journal
    cards = m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    for _ in range(3):
        relisted(m, press)
    assert reconfirms(m) == 1                                                  # no Go ahead after it ended
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == cards   # no second ended card
    assert len(queued(m, Controller.UNKNOWN_COUNT_WORDS) + queued(m, Controller.RELIST_ENDED_WORDS)) == 1


# -- 5. marks written by earlier builds -----------------------------------------------------------------------------

@pytest.mark.card_only
def test_earlier_builds_marks_load_with_no_extra_go_ahead_and_one_card(m, tmp_path):
    """The records and journal as the earlier code left them: an ended tap's struck mark at the old over-cap number
    (with a stale count of 3 beside the journal), and a struck mark written as nought with no count beside it."""
    h = m.c.handovers
    ended, zero = tap(99501), tap(99502)
    ke, kz = h.key(ended), h.key(zero)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.RELIST_FLAG + ke, json.dumps({"gen": Controller.RELIST_GEN_CAP + 1,
                                                                   "pending": False}), db)
        m.ledger.set_meta(Controller.RELIST_FLAG + kz, json.dumps({"gen": 0, "pending": False}), db)
        for k, purposes in ((ke, ["1", "2", "3", "4", "5", "6", "ended"]), (kz, ["1", "2"])):
            for p in purposes:                                                 # the cards they had
                m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="earlier", once=f"tap:{k}|relist|{p}")
        db.execute("DELETE FROM meta WHERE key=?", (Controller.LEGACY_CHECKED,))
    set_side_gen(m, ke, 3)
    real_restart(m, tmp_path)                                                  # loaded by this round
    assert mark(m, ke)["ended"] is True and mark(m, ke)["gen"] == Controller.RELIST_GEN_CAP
    assert mark(m, kz)["gen"] is None
    before, cards = reconfirms(m), m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    relisted(m, ended)
    relisted(m, zero)
    assert reconfirms(m) == before                                             # no extra Go ahead
    new = [r[0] for r in m.ledger.db.execute("SELECT text FROM outbox WHERE id>?", (cards,))]
    assert new == [new[0]] and Controller.UNKNOWN_COUNT_WORDS in new[0]        # exactly one card


@pytest.mark.card_only
def test_a_zero_struck_mark_with_a_count_beside_the_journal_takes_that_count(m, tmp_path):
    h = m.c.handovers
    zero = tap(99503)
    kz = h.key(zero)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.RELIST_FLAG + kz, json.dumps({"gen": 0, "pending": False}), db)
        db.execute("DELETE FROM meta WHERE key=?", (Controller.LEGACY_CHECKED,))
    set_side_gen(m, kz, 2)
    real_restart(m, tmp_path)
    assert mark(m, kz)["gen"] == 2
    relisted(m, zero)
    assert reconfirms(m) == 1 and mark(m, kz)["gen"] == 3


# -- 6 and 7. four hours with the set-aside list unreadable, everything counted ---------------------------------------

CAL_WRITES = ("insert", "patch", "update", "delete", "move", "put", "create", "remove", "add")


@pytest.mark.card_only
def test_four_hours_with_the_set_aside_list_down_counts_every_read_write_and_log_line(m, monkeypatch, clock,
                                                                                      tmp_path, caplog):
    h = m.c.handovers
    a, held = tap(99601), tap(99603)
    for p in (a, held):
        assert h.journal_add(Handover(kind="press", press=p))
        assert h.journal_intent(p, {"effect": "calendar_change", "proposal": f"p-{p['id']}", "changes": [],
                                    "keys": []})
    quarantine(m, h.key(held))
    reads = {"tap": [], "gmail": 0, "gmail_writes": 0}

    def tap_read(self, op):
        reads["tap"].append(op.get("proposal"))
        return ("not_done", [])
    monkeypatch.setattr(Controller, "_tap_read", tap_read)
    monkeypatch.setattr(Controller, "_records_hold", lambda self, p: "untaken")
    gmail_cls = type(m.gmail)
    for name in [n for n in dir(gmail_cls) if not n.startswith("_") and callable(getattr(gmail_cls, n))]:
        def counted(self, *a, __real=getattr(gmail_cls, name), __name=name, **kw):
            reads["gmail"] += 1
            if any(w in __name.lower() for w in CAL_WRITES):
                reads["gmail_writes"] += 1
            return __real(self, *a, **kw)
        monkeypatch.setattr(gmail_cls, name, counted)
    real_q = Controller._quarantined
    state = {"down": True}

    def quarantined(self):
        if state["down"]:
            raise sqlite3.OperationalError("unable to open database file")
        return real_q(self)
    monkeypatch.setattr(Controller, "_quarantined", quarantined)
    real_restart(m, tmp_path)
    icloud_before, cards = len(m.icloud.log), m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    selects = {"n": 0}
    m.ledger.db.set_trace_callback(lambda sql: selects.__setitem__("n", selects["n"] + sql.lstrip().upper()
                                                                   .startswith("SELECT")))
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        for _ in range(4 * 60):                                                # four hours down, a tick a minute
            later(m, clock, 60)
    m.ledger.db.set_trace_callback(None)
    assert reads["tap"] == []                                                  # no tap read on the calendar
    assert reads["gmail_writes"] == 0                                          # no calendar write
    assert [x for x in m.icloud.log[icloud_before:] if x[0] in ("PUT", "DELETE", "POST")] == []
    assert reads["gmail"] == 0                                                 # no calendar read of any kind
    assert selects["n"] <= 4 * 60 * 70                                         # ledger reads bounded per tick
    assert len(caplog.records) <= 12                                           # a few lines, then hourly at most
    new = [r[0] for r in m.ledger.db.execute("SELECT text FROM outbox WHERE id>?", (cards,))]
    assert new == [Controller.SETASIDE_CARD_WORDS]                             # one card that taps wait, only that
    assert "waiting" in m.c.handovers.health()
    state["down"] = False                                                      # the list reads again
    for _ in range(20):
        later(m, clock, 60)
    assert "waiting" not in m.c.handovers.health()
    assert "p-99603" not in reads["tap"]                                       # the set-aside tap left alone
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + h.key(held)) is not None


@pytest.mark.card_only
def test_the_waiting_card_isnt_queued_when_the_outbox_refuses_it_and_the_flag_stays(m, monkeypatch, clock,
                                                                                     tmp_path):
    def down(self):
        raise sqlite3.OperationalError("unable to open database file")
    monkeypatch.setattr(Controller, "_quarantined", down)

    def refuse(*a, **kw):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(m.ledger, "enqueue", refuse)
    real_restart(m, tmp_path)
    for _ in range(30):
        later(m, clock, 60)
    assert "waiting" in m.c.handovers.health()
    assert m.c.notes.get("tap_setaside")
