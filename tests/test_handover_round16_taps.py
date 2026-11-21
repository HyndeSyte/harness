"""0.24.0, sixteenth round: the tap journal's defects from the fifteenth outside review (Nov 16).

1. One durable step for a tap's outcome: an execution intent is written (fsynced) before anything is acted on, and
   every journal write is checked; a tap with an intent and no outcome is "outcome unknown", and across a restore
   the calendar is read for its effect, by its own fixed id, before any Go ahead is offered.
2. The relist after a restore is truthful: sorted by tap time, the newest shown, every other one listed by its state.
3. Terminal outcomes and their notes are durable: written before the note, delivery recorded after it.
10. A tap's age is bounded by the journal's own time; the clock card's own tap gets the card again; the fence's
    exemption is checked at run time.
11. The tap journal is a required argument of the Inbox.
12. The restore flag at start and the degraded start's answer route, behaviourally.
All names and ids invented.
"""
import json
import os
import pathlib
import signal
import sqlite3
import time
import urllib.request

import pytest

from harness import handover, ledger as ledger_mod, migrate
from harness.handover import Handover
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (TZ, Morning, ask, at, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round14_taps import TOKEN, allow_loopback, clock_card, post
from test_handover_round15_taps import snowflake
from fake_caldav import no_network  # noqa: F401  (autouse)

DENTIST = change("gmail", "add", "Dentist", dates="", start=at(15).isoformat(), end=at(16).isoformat())


@pytest.fixture
def m(ledger, tmp_path, clock):
    m = Morning(ledger, tmp_path, clock)
    m.told = []
    m.c.handovers.journal = str(tmp_path / "taps.jsonl")
    m.c.handovers.answer = lambda callback, text: m.told.append(text)
    return m


@pytest.fixture
def loopback(monkeypatch):
    allow_loopback(monkeypatch)


def press_for(m, label):
    card = next(cid for cid in sorted(m.link.cards, reverse=True)
                if any(c["label"] == label for r in m.link.cards[cid]["rows"] for c in r["components"]))
    custom = next(c["custom_id"] for r in m.link.cards[card]["rows"] for c in r["components"] if c["label"] == label)
    return {"id": str(91000 + len(m.link.answers)), "token": "t", "app": "999", "custom_id": custom,
            "message_id": str(card)}


def tap_journaled(m, label):
    """His tap, as the handover service takes it: written to the journal, then queued for the loop."""
    h = Handover(kind="press", press=press_for(m, label))
    assert m.c.handovers.journal_add(h)
    return m.send(h), h.press


def dentists(m):
    return [e for e in m.gmail.events.values() if e.get("summary") == "Dentist" and e.get("status") != "cancelled"]


def dentist_card(m):
    out = m.tells("add the dentist 3 to 4 today", ask(DENTIST))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()


def restart_after_restore(m, backup):
    """The records put back from a backup and the App started again on them."""
    backup.backup(m.ledger.db)
    m.c._taps_replayed = False
    m.c.restored_at_start = True
    m.c.tick()
    m.c.outbox.flush()


def lines(path):
    return [json.loads(x) for x in pathlib.Path(path).read_text().splitlines() if x.strip()]


# -- 1. one durable step for a tap's outcome ---------------------------------------------------------------------

@pytest.mark.card_only
def test_the_intent_is_on_disk_before_anything_is_acted_on(m, monkeypatch):
    dentist_card(m)
    seen = {}
    real = m.c._press_inner

    def inner(h, p):
        seen["journal"] = lines(m.c.handovers.journal)
        return real(h, p)
    monkeypatch.setattr(m.c, "_press_inner", inner)
    out, press = tap_journaled(m, "Approve")
    assert out["status"] == "ok"
    intent = [r for r in seen["journal"] if "intent" in r]
    assert len(intent) == 1 and intent[0]["op"]["effect"] == "calendar_change"
    assert intent[0]["op"]["changes"][0]["title"] == "Dentist" and intent[0]["op"]["proposal"]


@pytest.mark.card_only
def test_an_intent_that_cant_be_written_is_a_refusal_and_nothing_is_done(m, monkeypatch):
    dentist_card(m)
    real = m.c.handovers._append
    monkeypatch.setattr(m.c.handovers, "_append", lambda row: False if "intent" in row else real(row))
    out, press = tap_journaled(m, "Approve")
    m.c.tick()
    assert out["status"] == "refused" and out["said"] == handover.UNRECORDED_TAP
    assert m.told == [handover.UNRECORDED_TAP]
    assert dentists(m) == []                                                  # nothing acted on
    assert m.ledger.db.execute("SELECT COUNT(*) FROM approvals WHERE consumed_at IS NOT NULL").fetchone()[0] == 0


@pytest.mark.card_only
def test_a_failed_commit_append_is_logged_and_told_never_ignored(m, monkeypatch, caplog):
    dentist_card(m)
    real = m.c.handovers._append
    monkeypatch.setattr(m.c.handovers, "_append", lambda row: False if "committed" in row else real(row))
    out, press = tap_journaled(m, "Approve")
    assert out["status"] == "ok" and out["journal_commit"] is False
    assert m.told == [m.c.COMMIT_UNRECORDED]                                  # he's told
    assert "couldn't be written to the tap journal" in caplog.text            # and it's logged
    rows = m.c.handovers.journaled()
    assert len(rows) == 1 and rows[0]["state"] == "unknown"                    # kept: outcome unknown, not struck
    for t in m.told:
        assert "again" not in t.lower().replace("anything with this tap again", "")


@pytest.mark.card_only
def test_a_crash_between_the_write_and_the_journal_commit_then_a_restore_never_writes_twice(m, monkeypatch):
    """The Approve was acted on and the event written, but the App died before the journal recorded the outcome
    (the journal on disk as it was right after the intent); then the records were put back from a backup taken before
    the tap, and the App started again. The calendar is read for the event by its own fixed id: it's there, so the
    tap is marked done, no Go ahead is offered and nothing is written again."""
    dentist_card(m)
    backup = sqlite3.connect(":memory:")
    m.ledger.db.backup(backup)                                                # the backup predates the tap
    on_disk = {}
    real_intent = m.c.handovers.journal_intent

    def intent(press, op=None):
        ok = real_intent(press, op)
        on_disk["after_intent"] = pathlib.Path(m.c.handovers.journal).read_bytes()
        return ok
    monkeypatch.setattr(m.c.handovers, "journal_intent", intent)
    out, press = tap_journaled(m, "Approve")
    m.c.tick()
    m.c.outbox.flush()
    assert len(dentists(m)) == 1                                              # the write landed
    pathlib.Path(m.c.handovers.journal).write_bytes(on_disk["after_intent"])  # the crash: no outcome on disk
    monkeypatch.undo()
    assert [r["state"] for r in m.c.handovers.journaled()] == ["unknown"]
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    m.c.tick()
    m.c.outbox.flush()
    assert len(dentists(m)) == 1                                              # no second write
    said = [m.link.cards[c]["text"] for c in sorted(m.link.cards)[before:]]
    assert any("already on your calendar" in t for t in said), said
    assert not any("wasn't carried out" in t or "not carried out" in t for t in said)
    assert "Go ahead" not in [c["label"] for cid in sorted(m.link.cards)[before:]
                              for r in m.link.cards[cid]["rows"] for c in r["components"]]
    assert m.c.handovers.journaled() == []


@pytest.mark.card_only
def test_an_unknown_tap_whose_write_never_landed_across_a_restore_is_said_and_not_added_blind(m, monkeypatch):
    dentist_card(m)
    backup = sqlite3.connect(":memory:")
    m.ledger.db.backup(backup)
    real_commit = m.c.handovers.journal_commit
    monkeypatch.setattr(m.c.handovers, "journal_commit", lambda press: (_ for _ in ()).throw(Crash("died")))
    with pytest.raises(Crash):
        tap_journaled(m, "Approve")                                           # died before the calendar write
    monkeypatch.setattr(m.c.handovers, "journal_commit", real_commit)
    assert dentists(m) == []
    restart_after_restore(m, backup)
    card = [t for t in m.seen() if t.startswith("A tap of yours from")]
    assert len(card) == 1 and "can't tell whether it was carried out" in card[-1]
    # Eighteenth round: Google answers 404 at its fixed id, and across a restore Harness can't tell whether it was
    # added and taken off since, so it's said so and not added again from here (no Go ahead).
    assert "can't tell whether it was added and taken off since" in card[-1]
    assert "Go ahead" not in m.labels()
    for _ in range(3):
        m.c.tick()
    assert dentists(m) == []                                                  # nothing written


class Crash(BaseException):
    """Stands for the App being killed at that point: nothing after it runs."""


def test_go_ahead_reads_the_calendar_first_and_never_blindly_reruns(m, monkeypatch):
    calls = []
    monkeypatch.setattr(m.c.callbacks, "handle", lambda inc: calls.append(inc) or "ok")
    monkeypatch.setattr(m.c, "_tap_read", lambda op: ("done", []))
    said = m.c._reconfirm_tap(json.dumps({"custom_id": "k:a:whatever", "message_id": "5",
                                          "op": {"effect": "calendar_change"}}))
    assert calls == [] and "on your calendar already" in said
    monkeypatch.setattr(m.c, "_tap_read", lambda op: ("not_done", []))
    m.c._reconfirm_tap(json.dumps({"custom_id": "k:a:whatever", "message_id": "5",
                                   "op": {"effect": "calendar_change"}}))
    assert len(calls) == 1                                                    # only once it isn't there


# -- 2. the relist is truthful ------------------------------------------------------------------------------------

def test_more_than_ten_taps_of_mixed_state_are_sorted_shown_and_none_out_of_reach(m):
    inbox = m.c.handovers
    now = time.time()
    states = {}
    for i in range(13):
        press = {"id": str(70000 + i), "token": "t", "app": "9", "custom_id": f"hx:c:tap{i}", "message_id": "1"}
        kind = ("committed", "unknown", "not_started")[i % 3]
        states[press["id"]] = kind
        assert inbox._append({"press": press, "at": now - 3600 + i * 60})     # tap i is i minutes newer
        if kind in ("committed", "unknown"):
            assert inbox.journal_intent(press, {"effect": "records"})
        if kind == "committed":
            assert inbox.journal_commit(press)
    m.c._taps_replayed = False
    m.c.restored_at_start = True
    m.c.tick()
    m.c.outbox.flush()
    said = m.seen()
    head = next(t for t in said if "records were put back from a backup" in t)
    assert "13 taps of yours" in head
    assert "5 carried out before the records were put back" in head          # 0, 3, 6, 9, 12
    assert "4 Harness can't tell whether it was carried out" in head
    assert "4 not carried out" in head
    cards = [t for t in said if t.startswith("A tap of yours from")]
    assert len(cards) == m.c.RELIST_MAX and m.labels().count("Go ahead") == m.c.RELIST_MAX
    rest = next(t for t in said if t.startswith("Older taps from before the records were put back"))
    listed = [x for x in rest.split("\n")[1:] if x.strip()]
    assert len(listed) == 3                                                   # taps 0, 1, 2: the oldest
    assert [x.split(": ", 1)[1] for x in listed] == ["carried out before the records were put back",
                                                     "Harness can't tell whether it was carried out",
                                                     "not carried out"]
    committed_cards = [t for t in cards if "carried out on the records before they were put back" in t]
    assert len(committed_cards) == 4                                          # 3, 6, 9, 12: never "wasn't"
    assert inbox.journaled() == []


# -- 3. terminal outcomes and notes are durable --------------------------------------------------------------------

def test_a_crash_between_the_note_and_the_strike_then_a_restart_neither_replays_nor_tells_twice(m, clock,
                                                                                                monkeypatch):
    press = clock_card(m, clock)
    h = Handover(kind="press", press=press)
    assert m.c.handovers.journal_add(h)
    order = []
    real_append = m.c.handovers._append
    monkeypatch.setattr(m.c.handovers, "_append", lambda row: order.append(next(iter(row))) or real_append(row))
    monkeypatch.setattr(m.c.handovers, "answer", lambda cb, text: order.append("note") or m.told.append(text))
    monkeypatch.setattr(m.c.handovers, "journal_done", lambda p: (_ for _ in ()).throw(Crash("before the strike")))
    m.ledger.fence(m.c.FENCED)
    try:
        m.c.handovers.submit(h)
        with pytest.raises(Crash):
            m.c._fenced_tick()
    finally:
        m.ledger.unfence()
    monkeypatch.undo()
    assert order == ["outcome", "note", "delivered"]                           # written before the note
    m.c.handovers.answer = lambda cb, text: m.told.append(text)
    clock.advance(hours=3)                                                    # the clock agrees: a replay would act
    m.c._taps_replayed = False
    m.c.restored_at_start = False
    m.c.tick()
    m.c.outbox.flush()
    assert m.told == [m.c.FENCED]                                             # at most one note
    assert not any("About a tap of yours" in t for t in m.seen())
    assert m.ledger.db.execute("SELECT COUNT(*) FROM updates WHERE update_id=?",
                               (int(press["id"]),)).fetchone()[0] == 0        # never replayed
    assert m.c.handovers.journaled() == []


def test_a_note_whose_delivery_isnt_recorded_goes_once_at_the_next_start(m, clock):
    press = clock_card(m, clock)
    h = Handover(kind="press", press=press)
    assert m.c.handovers.journal_add(h)
    assert m.c.handovers.journal_outcome(press, "refused", "Not taken: a test reason. Nothing changed.")
    clock.advance(hours=3)
    m.c._taps_replayed = False
    m.c.tick()
    m.c.tick()
    m.c.outbox.flush()
    assert m.told == ["Not taken: a test reason. Nothing changed."]
    assert m.ledger.db.execute("SELECT COUNT(*) FROM updates WHERE update_id=?",
                               (int(press["id"]),)).fetchone()[0] == 0


def test_there_is_no_in_memory_once_flag():
    assert "notified" not in Handover.__dataclass_fields__ and "_note_lock" not in Handover.__dataclass_fields__


# -- 10. ages, the clock card's own tap, the fence's exemption -------------------------------------------------------

def test_a_taps_age_is_bounded_by_the_journals_time(m):
    future = {"press": {"id": snowflake(time.time() + 3000)}, "at": time.time() - 60}  # a stamp ahead of the journal
    assert 50 < m.c._tap_age(future) < 70
    old = {"press": {"id": snowflake(time.time() - 3600)}, "at": time.time() - 30}    # a stamp far behind it
    assert 20 < m.c._tap_age(old) < 40
    near = {"press": {"id": snowflake(time.time() - 100)}, "at": time.time() - 90}     # within tolerance: Discord's
    assert 95 < m.c._tap_age(near) < 105


def test_the_clock_cards_own_tap_while_flagged_brings_the_card_again(m, clock):
    press = clock_card(m, clock)
    assert m.c.handovers.journal_add(Handover(kind="press", press=press))
    before = sum(1 for t in m.seen() if "clock" in t.lower())
    m.c._taps_replayed = False
    m.c.tick()
    m.c.outbox.flush()
    said = m.seen()
    assert any("The clock card follows again." in t for t in said)
    assert sum(1 for t in said if "clock" in t.lower()) >= before + 2         # the note and the card again
    assert migrate.clock_stall(m.ledger)
    out = m.tap(next(c["label"] for cid in sorted(m.link.cards, reverse=True)[:1]
                     for r in m.link.cards[cid]["rows"] for c in r["components"]))
    assert out["status"] == "ok" and not migrate.clock_stall(m.ledger)       # the fresh card works


def test_the_fence_exemption_is_checked_at_run_time(m):
    m.ledger.fence("staged")
    try:
        for passed in (True, 1, "outbox", object()):
            with pytest.raises(TypeError):
                with m.ledger._tx(passed):
                    pass
        with pytest.raises(ledger_mod.LedgerFenced):
            with m.ledger._tx(None):
                pass
        with m.ledger.outbox_tx():
            pass
    finally:
        m.ledger.unfence()


# -- 11. the journal is required -------------------------------------------------------------------------------------

def test_an_inbox_without_its_journal_refuses_to_be_made():
    with pytest.raises(TypeError):
        handover.Inbox(lambda: TOKEN)                                         # no journal argument at all
    with pytest.raises(ValueError):
        handover.Inbox(lambda: TOKEN, journal="")
    assert handover.Inbox.for_tests(lambda: TOKEN).journal == ""              # tests only, by name
    assert handover.Inbox(lambda: TOKEN, journal="", refusing="degraded").refusing   # the degraded start's


# -- 12. through the real paths --------------------------------------------------------------------------------------

def built(folder, monkeypatch):
    from harness import __main__ as main_mod
    monkeypatch.setenv("HARNESS_HANDOVER_PORT", "0")
    monkeypatch.setattr(main_mod, "serve", lambda app, port: type("W", (), {"shutdown": lambda self: None})())
    monkeypatch.setattr(main_mod.family, "serve", lambda inbox, port: None)
    monkeypatch.setattr(main_mod.handover, "serve", lambda inbox, port: None)
    try:
        controller, web, listener = main_mod.build(str(folder), port=0, family_port=0)
    finally:
        migrate.release_process_lock(os.path.join(str(folder), "harness.sqlite"))
    return controller


def test_the_app_builds_its_inbox_with_the_journal_and_marks_a_start_that_swapped_a_restore_in(tmp_path, clock,
                                                                                              monkeypatch):
    from test_handover_round13 import restorable
    plain = tmp_path / "plain"
    plain.mkdir()
    c = built(plain, monkeypatch)
    assert c.handovers.journal == str(plain / "harness.sqlite") + handover.TAP_JOURNAL
    assert c.restored_at_start is False
    c.ledger.close()
    work = tmp_path / "restored"
    work.mkdir()
    path, led = restorable(work, clock, build="bflag16")
    assert migrate.stage_restore(str(path), 1, "bflag16")["ok"]
    led.close()
    c = built(work, monkeypatch)
    assert c.restored_at_start is True                                        # the swap was applied at this start
    assert not os.path.exists(str(path) + migrate.RESTORE_SUFFIX)
    c.ledger.close()


def test_the_degraded_start_refuses_a_tap_through_the_links_answer_route(loopback, tmp_path, monkeypatch):
    """degraded() as main runs it, with its handover service listening for real: a tap is refused at once and the
    refusal goes through the link's answer route."""
    from harness import __main__ as main_mod
    answered, ports = [], []

    class Chat:
        def __init__(self, link):
            pass

        def send_message(self, chat_id, text, buttons=None, **kw):
            return 1

        def answer_callback(self, callback, text=None):
            answered.append((callback, text))
    monkeypatch.setattr(main_mod, "LinkChat", Chat)
    monkeypatch.setattr(main_mod, "serve", lambda app, port: type("W", (), {"shutdown": lambda self: None})())
    real_serve = handover.serve

    def serve(inbox, port):
        srv = real_serve(inbox, port=0, host="127.0.0.1")
        ports.append(srv.server_address[1])
        return srv
    monkeypatch.setattr(main_mod.handover, "serve", serve)
    monkeypatch.setattr(main_mod.Vault, "get", lambda self, k: TOKEN if k == "discord_bot_token" else "")
    got = {}
    turns = []
    real_sleep = main_mod.time.sleep

    def tick(s):
        turns.append(1)
        if len(turns) == 2:
            got["answer"] = post(ports[0], "/press", {"id": "1", "token": "t", "app": "9", "custom_id": "hx:1",
                                                      "message_id": "5"})
        if len(turns) > 4:
            os.kill(os.getpid(), signal.SIGTERM)
        real_sleep(0.01)
    monkeypatch.setattr(main_mod.time, "sleep", tick)
    old = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
    try:
        main_mod.degraded(str(tmp_path), 0, "the records couldn't be opened (a test)")
    finally:
        signal.signal(signal.SIGTERM, old[0])
        signal.signal(signal.SIGINT, old[1])
    status, answer = got["answer"]
    assert status == 200 and answer["status"] == "refused" and answer["degraded"] is True
    assert answered == [("9:t", handover.DEGRADED_TAP)]


def test_an_unreachable_answer_route_never_breaks_the_refusal(loopback, tmp_path):
    inbox = handover.Inbox(lambda: TOKEN, journal="", refusing="a test",
                           answer=lambda cb, text: (_ for _ in ()).throw(urllib.request.URLError("down")))
    srv = handover.serve(inbox, port=0, host="127.0.0.1")
    try:
        status, answer = post(srv.server_address[1], "/press", {"id": "1", "token": "t", "app": "9",
                                                                "custom_id": "hx:1", "message_id": "5"})
    finally:
        srv.shutdown()
    assert status == 200 and answer["status"] == "refused"
