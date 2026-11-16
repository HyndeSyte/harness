"""0.24.0, fifteenth round: the tap journal's defects from the fourteenth outside review (Nov 16).

1. A tap that can't be written down whole (a failed append, a short write, a failed fsync) is refused at once,
   never "working", and he's told nothing changed.
2. A tap's commit is in the journal itself; across a restore nothing is taken by itself: every tap written down is
   listed for him, each with a fresh button.
3. One terminal outcome and one note per tap, settled by the controller's loop behind a once-flag; a note that
   can't go now is kept in the journal and posted at the next start; the no-ledger degraded start refuses taps
   through the link's answer route.
8. No card with buttons goes out while fenced; it's sent and bound at the next unfenced start.
10. The heartbeat and the clock check run while fenced, marked fenced on the page and in /health.
12. A tap's age from Discord's own stamp; unknown (reported, not taken) while the clock is flagged; the queue read
    under its mutex; the fence's one exemption is the ledger's outbox-only method.
All names and ids invented.
"""
import inspect
import json
import os
import pathlib
import sqlite3
import threading
import time

import pytest

from harness import controller as controller_mod, handover, ledger as ledger_mod, migrate
from harness.handover import Handover
from harness.ledger import LedgerFenced
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import Morning, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round14_taps import TOKEN, allow_loopback, clock_card, post
from fake_caldav import no_network  # noqa: F401  (autouse)

PRESS = {"id": "1", "token": "t", "app": "9", "custom_id": "hx:1", "message_id": "5"}


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


@pytest.fixture
def loopback(monkeypatch):
    allow_loopback(monkeypatch)


def served(tmp_path, **kw):
    told = []
    inbox = handover.Inbox(lambda: TOKEN, journal=str(tmp_path / "taps.jsonl"),
                           answer=lambda callback, text: told.append((callback, text)), **kw)
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=30)
    return inbox, srv, told


# -- 1. a tap that can't be written down is refused ----------------------------------------------------------------

@pytest.mark.parametrize("fault", ["append", "short", "fsync"])
def test_a_tap_that_cant_be_written_down_is_refused_and_he_is_told(loopback, tmp_path, monkeypatch, fault):
    inbox, srv, told = served(tmp_path)
    real_write, real_fsync, real_open = os.write, os.fsync, os.open
    journal = str(tmp_path / "taps.jsonl")
    if fault == "append":
        monkeypatch.setattr(handover.os, "open", lambda path, *a, **k: (_ for _ in ()).throw(OSError("EIO"))
                            if str(path) == journal else real_open(path, *a, **k))
    elif fault == "short":
        def short(fd, data):
            if data.startswith(b'{"press"'):
                return real_write(fd, data[: len(data) // 2])      # half a line reaches the disk
            return real_write(fd, data)
        monkeypatch.setattr(handover.os, "write", short)
    else:
        def failing(fd):
            if os.path.realpath(f"/proc/self/fd/{fd}") == os.path.realpath(journal):
                raise OSError("EIO on fsync")
            return real_fsync(fd)
        monkeypatch.setattr(handover.os, "fsync", failing)
    try:
        status, answer = post(srv.server_address[1], "/press", PRESS)
    finally:
        srv.shutdown()
        monkeypatch.undo()
    assert status == 200 and answer["status"] == "refused"                   # never "working"
    assert answer["said"] == handover.UNRECORDED_TAP and "nothing changed" in answer["said"]
    assert told == [("9:t", handover.UNRECORDED_TAP)]                        # he's told, once
    assert inbox.pending() == 0                                              # not queued
    assert inbox.journaled() == []                                           # and nothing half-written is left
    if os.path.exists(journal):
        assert pathlib.Path(journal).read_bytes() == b""


def test_a_torn_journal_line_is_skipped_not_the_whole_journal(tmp_path):
    inbox = handover.Inbox(lambda: TOKEN, journal=str(tmp_path / "taps.jsonl"))
    assert inbox.journal_add(Handover(kind="press", press=PRESS))
    with open(inbox.journal, "a") as f:
        f.write('{"press": {"id": "2", "cus')                                # a torn tail
    assert [r["press"]["id"] for r in inbox.journaled()] == ["1"]


# -- 2. commits in the journal; nothing taken by itself across a restore ---------------------------------------------

def tapped_and_committed_then_restored(m, clock, tmp_path, monkeypatch):
    """The clock card tapped and committed, its strike cut off (a stop), then the records put back from a backup
    taken before the tap, and the clock right again, so a replay would act. The tap."""
    press = clock_card(m, clock)
    backup = sqlite3.connect(":memory:")
    m.ledger.db.backup(backup)                                               # the backup predates the tap
    m.c.handovers.journal = str(tmp_path / "taps.jsonl")
    h = Handover(kind="press", press=press)
    assert m.c.handovers.journal_add(h)
    monkeypatch.setattr(m.c.handovers, "journal_done", lambda press: None)   # stopped before the strike
    assert m.send(h)["status"] == "ok"
    monkeypatch.undo()
    assert migrate.clock_stall(m.ledger) == {}                               # the tap did its write
    rows = m.c.handovers.journaled()
    assert len(rows) == 1 and rows[0]["committed"] is True                   # its commit is in the journal itself
    backup.backup(m.ledger.db)                                               # the records put back
    clock.advance(hours=3)                                                   # the clock agrees again
    assert not migrate.clock_stall(m.ledger)
    return press


def taken(m, press):
    return m.ledger.db.execute("SELECT COUNT(*) FROM updates WHERE update_id=? AND kind='callback'",
                               (int(press["id"]),)).fetchone()[0]


def test_a_committed_tap_across_a_restore_is_listed_never_taken_again(m, clock, tmp_path, monkeypatch):
    press = tapped_and_committed_then_restored(m, clock, tmp_path, monkeypatch)
    m.c._taps_replayed = False
    m.c.restored_at_start = True                                             # the swap was applied at this start
    m.c.tick()
    m.c.outbox.flush()
    assert taken(m, press) == 0                                              # no second write
    said = m.seen()
    assert any("records were put back from a backup" in t and "a tap of yours" in t for t in said)
    card = [t for t in said if t.startswith("A tap of yours from")]
    assert len(card) == 1 and "carried out on the records before they were put back" in card[0]
    assert m.labels().count("Go ahead") == 1                                 # a fresh button of its own
    assert m.c.handovers.journaled() == []
    for t in said:
        assert "tap again" not in t.lower() and "send" not in t.lower()
    def clock_used():
        return m.ledger.db.execute("SELECT COUNT(*) FROM choices WHERE kind='migration_clock' AND consumed_at IS "
                                   "NOT NULL").fetchone()[0]
    assert clock_used() == 0                                                 # the restored records lack his tap
    out = m.tap("Go ahead")                                                  # he wants it: done now, once
    assert out["status"] == "ok"
    m.c.outbox.flush()
    assert clock_used() == 1 and taken(m, press) == 0


def test_a_committed_tap_is_never_taken_again_even_when_the_ledger_lacks_it(m, clock, tmp_path, monkeypatch):
    press = tapped_and_committed_then_restored(m, clock, tmp_path, monkeypatch)
    m.c._taps_replayed = False
    m.c.restored_at_start = False
    m.c.tick()
    m.c.outbox.flush()
    assert taken(m, press) == 0                                              # the journal's commit decides
    assert not any("Harness stopped before it took" in t for t in m.seen())
    assert m.c.handovers.journaled() == []


def test_an_uncommitted_tap_across_a_restore_is_listed_not_taken(m, clock, tmp_path):
    press = clock_card(m, clock)
    clock.advance(hours=3)
    m.c.handovers.journal = str(tmp_path / "taps.jsonl")
    assert m.c.handovers.journal_add(Handover(kind="press", press=press))
    m.c._taps_replayed = False
    m.c.restored_at_start = True
    m.c.tick()
    m.c.outbox.flush()
    assert taken(m, press) == 0
    assert any(t.startswith("A tap of yours from") and "It wasn't carried out." in t for t in m.seen())


def test_build_marks_a_start_that_swapped_a_restore_in():
    src = (pathlib.Path(controller_mod.__file__).parent / "__main__.py").read_text()
    assert "controller.restored_at_start = bool(swapped.get(\"ok\")) or migrate.restore_staged(path)" in src


# -- 3. one terminal outcome, one note, owned by the loop -------------------------------------------------------------

def test_a_tap_refused_by_the_fence_after_working_is_told_once_before_its_strike(m, clock, tmp_path, monkeypatch):
    """The fence engages mid-item: the HTTP waiter has long since said "working"; the loop tells him, once, and only
    then strikes the tap off."""
    press = clock_card(m, clock)
    told = []
    m.c.handovers.journal = str(tmp_path / "taps.jsonl")
    m.c.handovers.answer = lambda callback, text: told.append(text)
    h = Handover(kind="press", press=press)
    assert m.c.handovers.journal_add(h)
    order = []
    real_done = m.c.handovers.journal_done
    monkeypatch.setattr(m.c.handovers, "journal_done", lambda p: (order.append(("struck", len(told))),
                                                                  real_done(p)))
    m.ledger.fence(m.c.FENCED)
    try:
        m.c.handovers.submit(h)
        m.c._take_handovers()                                                # raises LedgerFenced inside: refused
        m.c._fenced_tick()                                                   # and the fenced loop sees it again
    finally:
        m.ledger.unfence()
    assert h.result["status"] == "refused" and told == [m.c.FENCED]          # once, never twice
    assert order and order[0] == ("struck", 1)                               # told before the strike
    assert m.c.handovers.journaled() == []


def test_the_http_waiter_never_tells_a_second_time(loopback, m, clock, tmp_path):
    """The race: the loop refuses inside the waiter's wait. He hears it once (the loop's), not again from the
    waiter."""
    press = clock_card(m, clock)
    told = []
    inbox = handover.Inbox(lambda: TOKEN, journal=str(tmp_path / "taps.jsonl"),
                           answer=lambda callback, text: told.append(text))
    m.c.handovers = inbox
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=30)
    seen = {}
    try:
        t = threading.Thread(target=lambda: seen.setdefault("answer", post(srv.server_address[1], "/press", press)))
        t.start()
        deadline = time.monotonic() + 5
        while not inbox.pending() and time.monotonic() < deadline:
            time.sleep(0.02)
        m.ledger.fence(m.c.FENCED)
        try:
            m.c.tick()
        finally:
            m.ledger.unfence()
        t.join(10)
    finally:
        srv.shutdown()
    assert seen["answer"][1]["status"] == "refused"
    assert told == [m.c.FENCED]


def test_a_note_that_cant_go_now_is_kept_and_posted_at_the_next_start(m, clock, tmp_path):
    press = clock_card(m, clock)
    m.c.handovers.journal = str(tmp_path / "taps.jsonl")
    m.c.handovers.answer = lambda callback, text: (_ for _ in ()).throw(OSError("link down"))
    h = Handover(kind="press", press=press)
    assert m.c.handovers.journal_add(h)
    m.ledger.fence(m.c.FENCED)
    try:
        m.c.handovers.submit(h)
        m.c._fenced_tick()
    finally:
        m.ledger.unfence()
    rows = m.c.handovers.journaled()
    assert len(rows) == 1 and rows[0]["notice"] == m.c.FENCED                # durable, not lost
    rows_on_disk = [json.loads(x) for x in open(m.c.handovers.journal)]
    assert any(r.get("notice") == m.c.FENCED for r in rows_on_disk)
    told = []
    m.c.handovers.answer = lambda callback, text: told.append(text)          # the next start, link back
    m.c._taps_replayed = False
    m.c.tick()
    m.c.outbox.flush()
    assert told == [m.c.FENCED] or any("About a tap of yours" in t for t in m.seen())
    assert m.c.handovers.journaled() == []
    assert migrate.clock_stall(m.ledger)                                     # the refused tap was never taken


def test_a_stale_pending_note_goes_as_a_message(m, clock, tmp_path):
    m.c.handovers.journal = str(tmp_path / "taps.jsonl")
    h = Handover(kind="press", press=dict(PRESS, custom_id="hx:zz"))
    assert m.c.handovers.journal_add(h)
    assert m.c.handovers.journal_notice(h.press, "Not taken: a test reason. Nothing changed.")
    rows = [json.loads(x) for x in open(m.c.handovers.journal)]
    for r in rows:
        r["at"] -= 3600
    pathlib.Path(m.c.handovers.journal).write_text("".join(json.dumps(r) + "\n" for r in rows))
    m.c._taps_replayed = False
    m.c.tick()
    m.c.outbox.flush()
    assert any(t.startswith("About a tap of yours: Not taken: a test reason.") for t in m.seen())
    assert m.c.handovers.journaled() == []


def test_the_degraded_start_refuses_a_tap_through_the_links_answer_route(loopback, tmp_path):
    told = []
    inbox = handover.Inbox(lambda: TOKEN, refusing="the records couldn't be opened (DatabaseError)",
                           answer=lambda callback, text: told.append((callback, text)))
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=30)
    try:
        status, answer = post(srv.server_address[1], "/press", PRESS)
    finally:
        srv.shutdown()
    assert status == 200 and answer["status"] == "refused" and answer["degraded"] is True
    assert told == [("9:t", handover.DEGRADED_TAP)] and inbox.pending() == 0


def test_the_degraded_start_wires_the_links_answer_route():
    from harness import __main__ as main_mod
    src = inspect.getsource(main_mod.degraded)
    assert "handover.Inbox(token, refusing=why, answer=chat.answer_callback)" in src


# -- 8. no dead buttons from cards held while fenced ----------------------------------------------------------------

def test_a_card_due_while_fenced_is_held_then_sent_and_bound_and_its_tap_is_answered(m, clock):
    """On the real dispatch path: the card isn't sent while fenced (a tap then gets the staged-restore line from the
    service), and once unfenced it's sent with its buttons bound, and a tap on it is taken."""
    from harness import choices
    owner = m.c.config.owner_user_id
    with m.ledger.tx() as db:
        nonce = choices.mint(m.ledger, kind="migration_clock", target="0", chat_id=owner, ttl_s=3600, db=db)
        m.ledger.enqueue(chat_id=owner, kind="notice", text="A card made just before the fence.",
                         buttons=[[("Card button", choices.callback_data(nonce))]],
                         binds=[{"type": "choice", "nonce": nonce}], db=db)
        m.ledger.enqueue(chat_id=owner, kind="notice", text="Restart Harness now to put its records back.", db=db)
    m.ledger.fence(m.c.FENCED)
    try:
        m.c._fence()
        m.c.outbox.flush()
        assert any("Restart Harness now" in t for t in m.seen())             # the restart card still goes
        assert "Card button" not in m.labels()                              # the card with buttons waits
        out = m.send(Handover(kind="press", press={"id": "77", "token": "t", "app": "9",
                                                   "custom_id": "hx:c:whatever", "message_id": "1"}))
        assert out["status"] == "refused" and out["said"] == m.c.FENCED     # a definite answer
    finally:
        m.ledger.unfence()
        m.c.handovers.fenced = ""
    m.c.outbox.flush()
    assert "Card button" in m.labels()
    before = len(m.link.answers)
    out = m.tap("Card button")
    assert out["status"] == "ok", m.link.answers[before:]
    assert not [a for _, a in m.link.answers if a in ("That button isn't valid here.", "That button isn't valid "
                                                                                       "any more.")]


# -- 10. heartbeat and clock check while fenced ---------------------------------------------------------------------

def test_the_heartbeat_and_clock_check_run_while_fenced_and_say_so(m, clock):
    m.ledger.fence(m.c.FENCED)
    m.c.handovers.fenced = m.c.FENCED
    try:
        m.c.tick()
        health = m.c.handovers.health()
        assert health["status"] == "ok" and health["fenced"] is True          # the loop's own beat, marked fenced
        mig = m.c.status_box["migration"]
        assert mig["fenced"] is True and mig["fenced_beat"] and "run_time_s" in mig
        with pytest.raises(LedgerFenced):
            with m.ledger.tx():
                pass                                                         # still fenced: no write went
        m.c.handovers.beat_at = time.monotonic() - handover.STUCK_S - 5       # a dead loop while fenced
        assert m.c.handovers.health()["status"] == "stuck"                   # never passes for a staged restore
    finally:
        m.ledger.unfence()
        m.c.handovers.fenced = ""


def test_the_status_page_marks_fenced():
    from harness import setup_web
    src = inspect.getsource(setup_web)
    assert 'mig.get("fenced")' in src and "The clock check still runs" in src


def test_a_clock_stall_shows_while_fenced(m, clock):
    with m.ledger.tx() as db:
        m.ledger.event("from_the_future", {}, db=db)
    clock.advance(hours=-3)
    m.ledger.fence(m.c.FENCED)
    try:
        m.c._tend_migration()
    finally:
        m.ledger.unfence()
    mig = m.c.status_box["migration"]
    assert mig["fenced"] is True and mig["pruning_stalled"]["why"]


# -- 12. ages, the queue's mutex, the outbox-only exemption ---------------------------------------------------------

def snowflake(when: float) -> str:
    return str((int(when * 1000) - 1420070400000) << 22)


def test_a_taps_age_comes_from_discords_own_stamp(m):
    old = {"press": {"id": snowflake(time.time() - 3600)}, "at": time.time()}   # written down just now
    assert 3500 < m.c._tap_age(old) < 3700                                    # but Discord says an hour ago
    plain = {"press": {"id": "91001"}, "at": time.time() - 60}               # not a real stamp: when written
    assert 50 < m.c._tap_age(plain) < 70


def test_while_the_clock_is_flagged_a_tap_is_reported_not_taken(m, clock, tmp_path):
    press = clock_card(m, clock)                                             # the clock is flagged behind
    m.c.handovers.journal = str(tmp_path / "taps.jsonl")
    assert m.c.handovers.journal_add(Handover(kind="press", press=press))
    m.c._taps_replayed = False
    m.c.tick()
    m.c.outbox.flush()
    assert taken(m, press) == 0 and migrate.clock_stall(m.ledger)
    assert any(t.startswith("Harness stopped before it took a tap of yours") for t in m.seen())
    assert m.c.handovers.journaled() == []


def test_the_replay_reads_the_queue_under_its_mutex():
    src = inspect.getsource(controller_mod.Controller._replay_taps)
    assert "self.handovers.queued_keys()" in src and "_front" not in src
    assert "self.queue.mutex" in inspect.getsource(handover.Inbox.queued_keys)


def test_the_fence_exemption_is_the_ledgers_outbox_only_method(m):
    assert "fence_exempt" not in inspect.signature(ledger_mod.Ledger.tx).parameters
    m.ledger.fence("staged")
    try:
        with pytest.raises(TypeError):
            m.ledger.tx(fence_exempt=True)
        with m.ledger.outbox_tx():
            pass
    finally:
        m.ledger.unfence()
    from harness import outbox
    assert "outbox_tx()" in inspect.getsource(outbox) and "fence_exempt" not in inspect.getsource(outbox)
    import harness
    callers = [p.name for p in pathlib.Path(harness.__file__).parent.glob("*.py")
               if "outbox_tx(" in p.read_text() and p.name not in ("ledger.py", "outbox.py")]
    assert callers == []
