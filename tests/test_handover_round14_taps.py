"""0.24.0, fourteenth round, item 4: taps are never lost (Nov 16).

Cain's link gives Discord its deferred answer to a tap at once; Harness writes the tap to a journal beside the
ledger (flushed to disk) before the link hears anything, answers only once the controller has committed what the
tap did (or "working" after a short wait, the tap written down), and takes a journaled tap the last run never
finished at the next start, or tells him it wasn't taken. While a restore is staged a tap is answered at once with
the restart ask and never queued; the fence is a mode flag on the ledger (writes fail at once, plainly), with the
outbox's delivery marks exempt. A tap the busy ledger can't take stays queued and he's told once; nothing queued
is dropped silently as the App stops. All names and ids invented.
"""
import json
import pathlib
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

import pytest

from harness import handover, ledger as ledger_mod, migrate
from harness.handover import Handover
from harness.ledger import LedgerFenced
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import Morning, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / "harness" / "app"
CLOCK_CARD = "Use the clock as it is now"
TOKEN = "test-bot-token"
# The real socket calls, saved before no_network refuses them: these tests talk to a loopback server only.
_REAL = {"getaddrinfo": socket.getaddrinfo, "create_connection": socket.create_connection,
         "connect": socket.socket.connect, "connect_ex": socket.socket.connect_ex}


def allow_loopback(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _REAL["getaddrinfo"])
    monkeypatch.setattr(socket, "create_connection", _REAL["create_connection"])
    monkeypatch.setattr(socket.socket, "connect", _REAL["connect"])
    monkeypatch.setattr(socket.socket, "connect_ex", _REAL["connect_ex"])

# A handover service with no controller behind it: it takes taps (written to the journal) and never acts on
# them, as when the App is killed between Cain's link hearing the tap was taken and the controller's write.
SERVER = """
import sys, time
sys.path.insert(0, sys.argv[1])
from harness import handover
handover.PRESS_WAIT_S = 0.3
inbox = handover.Inbox(lambda: sys.argv[3], journal=sys.argv[2])
srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=30)
print(srv.server_address[1], flush=True)
while True:
    time.sleep(1)
"""


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def clock_card(m, clock):
    """The clock card (thirteenth round): the clock behind the newest record by more than 10 minutes."""
    with m.ledger.tx() as db:
        m.ledger.event("from_the_future", {}, db=db)
    clock.advance(hours=-3)
    m.c.tick()
    m.c.outbox.flush()
    card = next(cid for cid in sorted(m.link.cards, reverse=True)
                if any(c["label"] == CLOCK_CARD for r in m.link.cards[cid]["rows"] for c in r["components"]))
    custom = next(c["custom_id"] for r in m.link.cards[card]["rows"] for c in r["components"]
                  if c["label"] == CLOCK_CARD)
    assert migrate.clock_stall(m.ledger)
    return {"id": "91001", "token": "t", "app": "999", "custom_id": custom, "message_id": str(card)}


def post(port, path, body, timeout=10):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"x-harness-key": handover.key_for(TOKEN), "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read())


def killed_after_the_tap(tmp_path, press):
    """A real process takes the tap over HTTP, says it's working, and is killed (SIGKILL) before any write."""
    journal = str(tmp_path / "harness.sqlite.taps.jsonl")
    proc = subprocess.Popen([sys.executable, "-c", SERVER, str(APP), journal, TOKEN], stdout=subprocess.PIPE,
                            text=True)
    try:
        port = int(proc.stdout.readline())
        status, answer = post(port, "/press", press)
    finally:
        proc.send_signal(signal.SIGKILL)
        proc.wait(10)
    assert status == 202 and answer == {"status": "working", "queued": True, "journaled": True}   # never "ok"
    return journal


@pytest.fixture
def loopback(monkeypatch):
    allow_loopback(monkeypatch)


# -- a tap acknowledged, then the process killed before the write ----------------------------------------------------

def test_a_tap_taken_then_killed_before_the_write_is_taken_at_the_next_start(m, clock, tmp_path, monkeypatch):
    press = clock_card(m, clock)
    allow_loopback(monkeypatch)
    journal = killed_after_the_tap(tmp_path, press)
    assert [r["press"]["custom_id"] for r in json.loads("[" + ",".join(open(journal)) + "]")] == [press["custom_id"]]
    assert migrate.clock_stall(m.ledger)                                    # nothing was written by the dead run
    m.c.handovers.journal = journal                                         # the next start
    m.c._taps_replayed = False
    m.c.tick()
    assert migrate.clock_stall(m.ledger) == {}                              # his tap took the clock as right
    assert m.c.handovers.journaled() == [] and not pathlib.Path(journal).exists()
    m.c._taps_replayed = False
    m.c.tick()                                                              # struck off: never taken twice
    assert m.ledger.db.execute("SELECT COUNT(*) FROM updates WHERE update_id=? AND kind='callback'",
                               (int(press["id"]),)).fetchone()[0] == 1


def test_a_journaled_tap_the_last_run_already_took_isnt_taken_twice(m, clock):
    press = clock_card(m, clock)
    m.send(Handover(kind="press", press=press))
    assert migrate.clock_stall(m.ledger) == {}
    before = len(m.link.answers)
    again = Handover(kind="press", press=press, journaled=True)            # its journal line outlived the commit
    assert m.send(again)["status"] == "ok"
    assert len(m.link.answers) == before                                    # no "already used" refusal to him


def test_a_tap_too_old_to_take_at_the_next_start_is_told_not_dropped(m, clock, tmp_path, monkeypatch):
    press = clock_card(m, clock)
    allow_loopback(monkeypatch)
    journal = killed_after_the_tap(tmp_path, press)
    rows = [json.loads(line) for line in open(journal)]
    rows[0]["at"] -= 3600                                                   # an hour before this start
    pathlib.Path(journal).write_text("".join(json.dumps(r) + "\n" for r in rows))
    m.c.handovers.journal = journal
    m.c._taps_replayed = False
    m.c.tick()
    m.c.outbox.flush()
    assert migrate.clock_stall(m.ledger)                                    # not acted on an hour late
    told = [t for t in m.seen() if t.startswith("Harness stopped before it took a tap of yours")]
    assert len(told) == 1 and "nothing changed" in told[0]
    assert m.c.handovers.journaled() == []


def test_a_tap_is_answered_only_after_the_controller_committed_it(m, clock, monkeypatch):
    """The real handover server, with the controller taking the queue: the answer to Cain's link comes after the
    write, and the journal line is struck off only then."""
    press = clock_card(m, clock)
    allow_loopback(monkeypatch)
    journal = str(pathlib.Path(m.ledger.path).parent / "taps.jsonl")
    inbox = handover.Inbox(lambda: TOKEN, journal=journal)
    m.c.handovers = inbox
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=30)
    seen = {}
    try:
        def tap():
            seen["answer"] = post(srv.server_address[1], "/press", press)
        t = threading.Thread(target=tap)
        t.start()
        deadline = time.monotonic() + 5
        while not inbox.pending() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert inbox.journaled() and "answer" not in seen                   # written down; nothing answered yet
        m.c.tick()
        t.join(10)
    finally:
        srv.shutdown()
    assert seen["answer"] == (200, {"status": "ok", "said": ""})
    assert migrate.clock_stall(m.ledger) == {} and inbox.journaled() == []


# -- while a restore is staged --------------------------------------------------------------------------------------

def test_a_tap_while_staged_gets_the_restart_ask_at_once_and_isnt_queued(loopback, tmp_path):
    told = []
    journal = str(tmp_path / "taps.jsonl")
    inbox = handover.Inbox(lambda: TOKEN, journal=journal, staged=lambda: True,
                           answer=lambda callback, text: told.append((callback, text)))
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=30)
    try:
        t0 = time.monotonic()
        status, answer = post(srv.server_address[1], "/press",
                              {"id": "1", "token": "t", "app": "9", "custom_id": "hx:1", "message_id": "5"})
        assert time.monotonic() - t0 < 2
    finally:
        srv.shutdown()
    assert status == 200 and answer["status"] == "refused" and answer["restore_staged"] is True
    assert answer["said"] == handover.FENCED_TAP and "Restart the Harness App" in answer["said"]
    assert told == [("9:t", handover.FENCED_TAP)]                            # the follow-up to his tap
    assert inbox.pending() == 0 and inbox.journaled() == []


def test_a_tap_the_controller_takes_while_fenced_gets_the_restart_ask(m, clock):
    press = clock_card(m, clock)
    m.ledger.fence(m.c.FENCED)
    try:
        out = m.send(Handover(kind="press", press=press))
        assert out["status"] == "refused" and out["said"] == m.c.FENCED
        assert any(t == m.c.FENCED for _, t in m.link.answers)
        assert migrate.clock_stall(m.ledger)                                # nothing taken
        assert m.c.handovers.fenced == m.c.FENCED                           # the service answers at once from now
    finally:
        m.ledger.unfence()


def test_the_fence_is_a_mode_flag_writes_fail_at_once_and_the_outbox_still_flushes(m):
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", text="Restart Harness now to put its records back.", db=db)
    m.ledger.fence("a restore is staged")
    try:
        assert not m.ledger.writers_held()                                  # no lock is held
        t0 = time.monotonic()
        with pytest.raises(LedgerFenced, match="a restore is staged"):
            with m.ledger.tx():
                pass
        assert time.monotonic() - t0 < 0.5                                  # at once, never a wait
        errs = []

        def other_thread():
            try:
                with m.ledger.tx():
                    pass
            except LedgerFenced as e:
                errs.append(e)
        th = threading.Thread(target=other_thread)
        th.start()
        th.join(5)
        assert not th.is_alive() and len(errs) == 1                         # another thread isn't held either
        assert m.c.outbox.flush() >= 1                                      # the restart card still goes out
        assert any("Restart Harness now" in t for t in m.seen())
        assert not m.ledger.due_outbox()                                    # marked sent: never posted twice
        m.c.tick()                                                          # a fenced tick raises nothing
    finally:
        m.ledger.unfence()
    with m.ledger.tx():
        pass                                                                # writes again once unfenced


def test_put_them_back_fences_with_the_mode_flag_not_a_held_lock():
    import inspect
    src = inspect.getsource(migrate.restore_tapped)
    assert "engage_hold" not in src
    from harness import controller
    assert "self.ledger.fence(" in inspect.getsource(controller.Controller._fence)


# -- the busy ledger: given back, told once, never dropped ------------------------------------------------------------

def test_a_tap_the_busy_ledger_cant_take_stays_queued_and_is_told_once(m, clock, monkeypatch):
    press = clock_card(m, clock)
    monkeypatch.setattr(ledger_mod, "WRITER_WAIT_S", 0.02)
    monkeypatch.setattr(ledger_mod, "WRITER_WAIT_MAX_S", 0.1)
    held, release = threading.Event(), threading.Event()

    def holder():
        with m.ledger.hold_writers():
            held.set()
            release.wait(30)
    t = threading.Thread(target=holder)
    t.start()
    held.wait(5)
    tap, ask = Handover(kind="press", press=press), Handover(kind="digest")
    try:
        m.c.handovers.submit(tap)
        m.c.handovers.submit(ask)
        for _ in range(2):
            try:
                m.c.tick()
            except ledger_mod.LedgerBusy:
                pass                                                        # the rest of the tick, not the queue
        assert not tap.done.is_set() and m.c.handovers.pending() == 2       # kept, in order
        waits = [a for _, a in m.link.answers if a == m.c.BUSY_TAP]
        assert len(waits) == 1                                              # told once
    finally:
        release.set()
        t.join(10)
    m.c.tick()
    assert tap.done.is_set() and tap.result["status"] == "ok"
    assert migrate.clock_stall(m.ledger) == {}                              # taken once the ledger was free
    assert ask.done.is_set()


# -- shutdown ---------------------------------------------------------------------------------------------------------

def test_what_is_queued_as_the_app_stops_is_kept_or_told(m, tmp_path):
    told = []
    m.c.handovers.journal = str(tmp_path / "taps.jsonl")
    m.c.handovers.answer = lambda callback, text: told.append(text)
    kept = Handover(kind="press", press={"id": "1", "token": "a", "app": "9", "custom_id": "hx:1"})
    m.c.handovers.journal_add(kept)
    lost = Handover(kind="press", press={"id": "2", "token": "b", "app": "9", "custom_id": "hx:2"})
    ask = Handover(kind="handover")
    for h in (kept, lost, ask):
        m.c.handovers.submit(h)
    out = m.c.drain_on_stop()
    assert out == {"kept": 1, "told": 1, "refused": 1}
    assert m.c.handovers.pending() == 0 and all(h.done.is_set() for h in (kept, lost, ask))
    assert [r["press"]["id"] for r in m.c.handovers.journaled()] == ["1"]  # taken at the next start
    assert any("kept and goes through" in t for t in told) and any("before it took your tap" in t for t in told)
    assert ask.result["status"] == "refused" and "Harness is stopping" in ask.result["said"]


def test_main_drains_the_queue_as_it_stops():
    src = (APP / "harness" / "__main__.py").read_text()
    stop = src[src.index('log.info("harness stopping")'):]
    assert "controller.drain_on_stop()" in stop.split("controller.ledger.close()")[0]
    assert "journal=path + handover.TAP_JOURNAL" in src and "staged=lambda: migrate.restore_staged(path)" in src
