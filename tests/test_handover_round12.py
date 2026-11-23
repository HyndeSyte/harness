"""0.24.0, twelfth round: what the eleventh outside review of the handover fixes asked for (Nov 16).

Fixes to the eleventh round's own additions, each on its own: every write sent without If-Match is labelled
Unprotected (a weak version on a protected calendar included), on approval cards too, and its read back is
compared for a lost update; the re-close rule leaves a calendar opened without protection and any
read-compare-write alone, with the ignored stamps pinned per provider; the dry run's copy and the backup are
taken with SQLite's online backup from a live WAL ledger, checked before anything moves, and deduplicated on
the backup file itself; the migration holds every other writer off, is one transaction, and a stop midway
leaves the old schema with the backup intact; the wait is never silent; time rules use the App's run time and
distrust a stepped clock; a backup can be restored by schema and build and migrated again; and the smoke run
records each calendar's version strength and a PUT with no If-Match on Family. All names and ids invented.
"""
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import threading
import time

import pytest

from harness import calendar_change, migrate
from harness.handover import Handover
from harness.ledger import Ledger
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (TZ, Morning, at, ask, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round4 import DENTIST
from test_handover_round5 import (DROP_SWIM, HAIRCUT, MOVE_HAIRCUT, SWIM_PATH, haircut_at, seed_haircut,
                                  swim_at, swim_ics)
from test_handover_round6 import card_for
from test_handover_round9 import _gmail_takes_any_if_match
from test_handover_round10 import _weak_etags, conform, seen_both, start
from test_handover_round11 import failing_dry_run, notices
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / "harness" / "app"


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def opened_gmail(m, monkeypatch):
    """Gmail found to take a stale write, and opened without protection by his tap."""
    seed_haircut(m)
    run = start(m)
    seen_both(m, "gmail")
    _gmail_takes_any_if_match(m, monkeypatch)
    conform(m, run, "gmail")
    m.tap("Open without protection")
    assert m.cc._unprotected("gmail")
    return run


# -- 1. every write sent without If-Match is labelled, and a lost update is told ----------------------------

@pytest.mark.card_only
def test_a_weak_version_on_a_protected_calendar_is_labelled_unprotected(m):
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    _weak_etags(m)
    assert not m.cc._unprotected("family")                     # not opened without protection
    card_for(m, "no swim today", ask(DROP_SWIM))
    m.tap("Approve")
    m.c.tick()
    m.c.outbox.flush()
    assert swim_at(m) is None
    done = [t for t in m.seen() if t.startswith("Done")]
    assert done and "Unprotected: Family was changed without the calendar's version check, since it gives only " \
                     "weak versions" in done[-1]
    assert "overwritten or deleted" in done[-1]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_lost_update_after_an_unfenced_write_is_told_with_the_values(m, monkeypatch):
    opened_gmail(m, monkeypatch)
    real = m.gmail.change

    def someone_else_too(address, uid, fields, etag):
        out = real(address, uid, fields, etag)
        m.gmail.events[uid]["location"] = "12 Other St"           # an edit that landed around ours
        return out
    monkeypatch.setattr(m.gmail, "change", someone_else_too)
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    m.c.tick()
    m.c.outbox.flush()
    assert haircut_at(m) == "10:30"
    lost = [t for t in m.seen() if t.startswith("Possibly overwritten on Gmail")]
    assert len(lost) == 1 and "Location: was nothing, now “12 Other St”" in lost[0]
    assert m.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='calendar_possible_lost_update'"
                               ).fetchone()[0] == 1


def test_the_lost_update_compare_leaves_the_change_and_the_stamps_out():
    before = swim_ics("20261111T210000Z", "20261111T220000Z")
    intended = swim_ics("20261111T220000Z", "20261111T230000Z")
    back = intended.replace("DTSTAMP:20261101T120000Z", "DTSTAMP:20261116T080000Z")
    f = calendar_change._ics_fields
    assert calendar_change._lost_fields(f(before), f(intended), f(back)) == []
    other = back.replace("END:VEVENT", "LOCATION:Pool B\r\nEND:VEVENT", 1)
    got = calendar_change._lost_fields(f(before), f(intended), f(other))
    assert [x["field"][1] for x in got] == ["LOCATION"]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_approval_cards_for_a_calendar_opened_without_protection_say_unprotected(m, monkeypatch):
    opened_gmail(m, monkeypatch)
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.c.outbox.flush()
    card = [t for t in m.seen() if "Haircut" in t and "Unprotected" in t]
    assert card and "edit made at the same time by someone else can be overwritten or deleted" in card[-1]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_the_open_without_protection_card_says_edits_can_be_overwritten_or_deleted_and_is_per_calendar(
        m, monkeypatch):
    seed_haircut(m)
    run = start(m)
    seen_both(m, "gmail")
    _gmail_takes_any_if_match(m, monkeypatch)
    conform(m, run, "gmail")
    m.c.outbox.flush()
    msg = [t for t in m.seen() if t.startswith("Harness can't change Gmail safely.")][-1]
    assert "edits made at the same time by someone else can be overwritten or deleted" in msg
    assert "opens Gmail only" in msg
    assert "prevent" not in msg.lower()                          # never described as preventing stale writes


# -- 2. no re-lockout loop -----------------------------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_an_ignoring_server_under_unprotected_mode_takes_two_writes_with_no_reclose(m, monkeypatch):
    opened_gmail(m, monkeypatch)
    real = m.gmail.change

    def keeps_its_version(address, uid, fields, etag):
        was = m.gmail.events[uid].get("etag")
        out = real(address, uid, fields, etag)
        m.gmail.events[uid]["etag"] = was                         # changed content, same version
        return out
    monkeypatch.setattr(m.gmail, "change", keeps_its_version)
    for to in ((10, 30), (11, 0)):
        move = change("gmail", "move", "Haircut", start=at(*to).isoformat(),
                      end=at(to[0] + 1, to[1]).isoformat())
        card_for(m, f"haircut moved to {to[0]}:{to[1]:02d} today", ask(move))
        m.tap("Approve")
        m.c.tick()
    assert haircut_at(m) == "11:00"
    assert "gmail" not in calendar_change.closed_providers(m.ledger)
    assert not m.ledger.db.execute("SELECT 1 FROM events WHERE kind='calendar_card_gate_reclosed'").fetchone()


def test_a_read_compare_write_never_recloses_even_on_a_protected_calendar(m):
    gate = {"version": "x", "build": "y", "verified": {"gmail": "t"}, "override": {}, "seen": {},
            "conformance": {"gmail": {"result": "enforced"}}}
    with m.ledger.tx() as db:
        m.ledger.set_meta(calendar_change.CARD_GATE, json.dumps(gate), db)
    m.cc._recording = ("p", {}, {"rcw": True}, None)
    m.cc._version_unmoved("gmail", "a move")
    m.cc._recording = None
    assert calendar_change.conformance_of(m.ledger, "gmail") == "enforced"
    m.cc._version_unmoved("gmail", "a move")                     # with If-Match: it does
    assert calendar_change.conformance_of(m.ledger, "gmail") == "ignored"


def test_the_ignored_stamps_are_pinned_per_provider():
    assert calendar_change.IGNORED_STAMPS == {
        "family": ("DTSTAMP", "LAST-MODIFIED", "SEQUENCE", "CREATED"),
        "gmail": ("etag", "updated", "sequence", "created", "htmlLink")}
    base = swim_ics("20261111T210000Z", "20261111T220000Z")
    for stamp in calendar_change.IGNORED_STAMPS["family"]:
        assert calendar_change._ics_content(base) == calendar_change._ics_content(
            base.replace("END:VEVENT", f"{stamp}:20261116T080000Z\r\nEND:VEVENT", 1)), stamp
    ev = {"id": "e1", "summary": "Swim"}
    for stamp in calendar_change.IGNORED_STAMPS["gmail"]:
        assert calendar_change._gmail_fields(ev) == calendar_change._gmail_fields({**ev, stamp: "2"}), stamp
    assert calendar_change._gmail_fields(ev) != calendar_change._gmail_fields({**ev, "location": "x"})


@pytest.mark.card_only
def test_a_read_back_mismatch_with_a_changed_version_fails_visibly_and_counts_toward_review(m, monkeypatch):
    seed_haircut(m)
    gate = {"version": "x", "build": "y", "verified": {"gmail": "t", "family": "t"}, "override": {}, "seen": {}}
    with m.ledger.tx() as db:
        m.ledger.set_meta(calendar_change.CARD_GATE, json.dumps(gate), db)
    real = m.gmail.events_between

    def old_time(address, s, e, fresh=False):
        return [({**ev, "start": {"dateTime": at(10).isoformat()}, "end": {"dateTime": at(11).isoformat()}}
                 if ev["id"] == HAIRCUT else ev) for ev in real(address, s, e)]
    monkeypatch.setattr(m.gmail, "events_between", old_time)
    was = m.gmail.events[HAIRCUT]["etag"]
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    m.c.tick()
    m.c.outbox.flush()
    assert m.gmail.events[HAIRCUT]["etag"] != was                    # its version moved
    assert any(t.startswith("Not confirmed.") for t in m.seen())
    review = calendar_change.card_gate(m.ledger)["review"]["gmail"]
    assert review["read_back_mismatch"] == 1
    assert "gmail" not in calendar_change.closed_providers(m.ledger)   # counted, never re-closed by itself


# -- 3. safe copies of a live WAL ledger ---------------------------------------------------------------------

def _uncheckpointed(ledger, tmp_path, n=40):
    ledger.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")          # the tables are in the file; these rows aren't
    ledger.db.execute("PRAGMA wal_autocheckpoint=0")
    with ledger.tx() as db:
        for i in range(n):
            ledger.event("wal_only", {"i": i}, db=db)
    assert os.path.getsize(ledger.path + "-wal") > 0
    raw = tmp_path / "raw-main-file.sqlite"
    shutil.copyfile(ledger.path, raw)                             # what a plain file copy would get
    c = sqlite3.connect(raw)
    try:
        plain = c.execute("SELECT COUNT(*) FROM events WHERE kind='wal_only'").fetchone()[0]
    finally:
        c.close()
    return plain


def test_the_dry_run_copy_contains_uncheckpointed_wal_content(ledger, tmp_path):
    plain = _uncheckpointed(ledger, tmp_path)
    assert plain < 40                                             # a plain copy misses it
    got = migrate.dry_run(ledger.path, version="0.24.0", build="b-wal")
    assert got["ok"] is True
    live = ledger.db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    assert got["rows_before"]["events"] == live


def test_the_backup_contains_uncheckpointed_wal_content_and_is_checked(ledger, tmp_path):
    _uncheckpointed(ledger, tmp_path)
    path = migrate.backup(ledger, "b-wal")
    assert path and migrate.verify_copy(path) == ""
    c = sqlite3.connect(path)
    try:
        assert c.execute("SELECT COUNT(*) FROM events WHERE kind='wal_only'").fetchone()[0] == 40
    finally:
        c.close()
    kept = migrate.backups(ledger)[-1]
    assert kept["checksum"] == migrate.content_checksum_file(path)     # computed on the backup itself
    assert not list(pathlib.Path(path).parent.glob("*.part"))


def test_a_copy_that_doesnt_match_the_ledger_is_refused(ledger, tmp_path, monkeypatch):
    real = migrate.table_counts
    monkeypatch.setattr(migrate, "table_counts",
                        lambda conn: {**real(conn), **({"events": -1} if conn is ledger.db else {})})
    assert migrate.backup(ledger, "b-off") == ""
    assert not list(tmp_path.glob("harness-before-*"))


# -- 4. migration under concurrent activity ------------------------------------------------------------------

@pytest.mark.migrate_gate
def test_a_writer_racing_the_migration_waits_for_it_and_loses_nothing(ledger, clock):
    stop = threading.Event()
    wrote, errors = [], []

    def racer():
        led = Ledger(ledger.path, clock=clock)
        i = 0
        try:
            while not stop.is_set():
                with led.tx() as db:
                    led.event("racer", {"i": i}, db=db)
                wrote.append(i)
                i += 1
                time.sleep(0.002)
        except Exception as e:                                    # noqa: BLE001
            errors.append(repr(e))
        finally:
            led.db.close()
    t = threading.Thread(target=racer)
    t.start()
    while len(wrote) < 5:
        time.sleep(0.005)
    got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-race")
    time.sleep(0.05)
    stop.set()
    t.join(10)
    assert not errors and not got.get("waiting")
    assert migrate.schema(ledger) == migrate.HANDOVER
    ids = [r[0] for r in ledger.db.execute("SELECT id FROM events WHERE kind='racer' ORDER BY id")]
    assert len(ids) == len(wrote)                                  # every racing write landed
    first = ledger.db.execute("SELECT MIN(id) FROM events WHERE kind='migration_dry_run'").fetchone()[0]
    last = ledger.db.execute("SELECT MAX(id) FROM events WHERE kind='calendar_install'").fetchone()[0]
    assert not [i for i in ids if first < i < last]               # none inside the held window
    assert [i for i in ids if i < first] and [i for i in ids if i > last]
    assert migrate.verify_copy(got["backup"]) == ""


CRASH = r"""
import os, sys
sys.path.insert(0, sys.argv[1])
from harness import migrate
from harness.ledger import Ledger
real = migrate.install
def dies(led, *a, **kw):
    if os.path.abspath(led.path) == os.path.abspath(sys.argv[2]):
        led.event("halfway", {"x": 1}, db=kw.get("db"))
        os._exit(9)                                               # killed in the middle of the migration
    return real(led, *a, **kw)
migrate.install = dies
led = Ledger(sys.argv[2])
migrate.run_live(led, None, 424242, version="0.24.0", build="bcrash")
"""


@pytest.mark.migrate_gate
def test_a_kill_mid_migration_leaves_the_old_schema_and_the_backup_and_run_check_migrates(tmp_path, clock):
    path = tmp_path / "harness.sqlite"
    led = Ledger(str(path), clock=clock)
    with led.tx() as db:
        led.event("precious", {"keep": True}, db=db)
    led.close()
    done = subprocess.run([sys.executable, "-I", "-c", CRASH, str(APP), str(path)], capture_output=True, text=True,
                          timeout=120)
    assert done.returncode == 9, done.stderr
    led = Ledger(str(path), clock=clock)
    assert migrate.schema(led) == 1 and led.get_meta(migrate.DONE) is None
    assert led.get_meta(calendar_change.INSTALLED) is None
    assert not led.db.execute("SELECT 1 FROM events WHERE kind='halfway'").fetchone()   # rolled back whole
    files = list(tmp_path.glob("harness-before-s1-bcrash-*.sqlite"))
    assert len(files) == 1 and migrate.verify_copy(str(files[0])) == ""
    # Thirteenth round: the next start doesn't try again by itself; it starts degraded and waits for Run check.
    got = migrate.run_live(led, None, OWNER, version="0.24.0", build="bcrash")
    assert got.get("waiting") and "interrupted" in got["why"] and migrate.waiting(led)["degraded"] is True
    got = migrate.run_live(led, None, OWNER, version="0.24.0", build="bcrash", retry=True)
    assert not got.get("waiting") and migrate.schema(led) == migrate.HANDOVER
    assert not (tmp_path / ("harness.sqlite" + migrate.MIGRATING)).exists()
    assert led.db.execute("SELECT COUNT(*) FROM events WHERE kind='precious'").fetchone()[0] == 1


def test_a_write_from_another_thread_waits_while_writers_are_held(ledger):
    order = []

    def other():
        led = Ledger(ledger.path)
        with led.tx() as db:
            order.append("other")
            led.event("other", {}, db=db)
        led.db.close()
    with ledger.hold_writers():
        t = threading.Thread(target=other)
        t.start()
        time.sleep(0.2)
        order.append("held")
        assert ledger.writers_held()
    t.join(5)
    assert order == ["held", "other"]


# -- 5. the wait is never silent ----------------------------------------------------------------------------

@pytest.mark.migrate_gate
def test_the_run_check_notice_is_posted_again_and_reminded_daily(ledger, monkeypatch, clock):
    failing_dry_run(monkeypatch)
    migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-wait")
    assert migrate.notice_state(ledger) == "queued"
    assert migrate.tend_waiting(ledger, OWNER, TZ) == ""            # the outbox retries it with backoff
    with ledger.tx() as db:
        db.execute("UPDATE outbox SET state='dead'")                 # Discord refused it for good
    assert migrate.tend_waiting(ledger, OWNER, TZ) == "reposted"
    assert migrate.notice_state(ledger) == "queued" and len(notices(ledger)) == 2
    with ledger.tx() as db:
        db.execute("UPDATE outbox SET state='sent', message_id=7")
    assert migrate.tend_waiting(ledger, OWNER, TZ) == ""
    clock.advance(days=1)
    assert migrate.tend_waiting(ledger, OWNER, TZ) == "reminded"
    said = notices(ledger)[-1]
    assert said[0].startswith("<b>Still waiting") and [b[0] for r in said[1] for b in r] == ["Run check"]
    assert migrate.tend_waiting(ledger, OWNER, TZ) == ""            # once a day
    summary = migrate.waiting_summary(ledger)
    assert summary["waiting"] and summary["build"] == "b-wait" and summary["notice"] == "queued"


@pytest.mark.migrate_gate
def test_a_handover_while_waiting_says_why_and_where_the_notice_is_and_health_shows_it(m, monkeypatch):
    failing_dry_run(monkeypatch)
    monkeypatch.setattr(calendar_change, "app_build", lambda: "b-next")
    migrate.run_live(m.ledger, m.cc, OWNER)
    m.c.tick()
    m.c.outbox.flush()
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    assert out["status"] == "refused" and "He has the message with Run check." in out["said"]
    assert "couldn't read" in out["said"] or "didn't pass" in out["said"]
    assert out["waiting"]["build"] == "b-next"
    health = m.c.handovers.health()
    assert health["migration"]["waiting"] is True and health["migration"]["build"] == "b-next"
    assert m.c.status_box["migration"]["waiting"] is True


# -- 6. time rules don't trust the wall clock alone -------------------------------------------------------------

def test_run_time_is_summed_from_the_monotonic_clock(ledger, clock):
    migrate._BEAT.pop(id(ledger), None)
    migrate.heartbeat(ledger, mono=1000.0)
    clock.advance(days=3)                                          # the wall clock jumps; the run time doesn't
    migrate.heartbeat(ledger, mono=1030.0)
    migrate.heartbeat(ledger, mono=1100.0)
    assert 99 <= migrate.uptime(ledger) <= 101
    migrate.heartbeat(ledger, mono=900.0)                          # never runs backwards
    assert migrate.uptime(ledger) >= 99


def _six_backups(ledger, clock):
    made = []
    for i in range(6):
        with ledger.tx() as db:
            ledger.set_meta("test_content", str(i), db)
        made.append(migrate.backup(ledger, f"b{i}"))
        clock.advance(minutes=1)
    return made


def test_a_day_on_the_wall_clock_without_the_run_time_prunes_nothing_protected(ledger, clock):
    made = _six_backups(ledger, clock)
    migrate._succeeded(ledger, "b-later")
    clock.advance(days=2)                                          # wall clock only
    with ledger.tx() as db:
        ledger.set_meta("test_content", "later", db)
    migrate.backup(ledger, "b-later2")
    assert made[0] in [b["path"] for b in migrate.backups(ledger)] and pathlib.Path(made[0]).exists()


def test_no_backup_is_pruned_while_the_clock_is_earlier_than_the_ledger(ledger, clock):
    made = _six_backups(ledger, clock)
    assert not pathlib.Path(made[1]).exists()                      # pruned as usual
    with ledger.tx() as db:
        ledger.event("seen_later", {}, db=db)
    clock.advance(hours=-3)                                        # the clock stepped back
    assert migrate.clock_problem(ledger)
    before = {b["path"] for b in migrate.backups(ledger)}
    with ledger.tx() as db:
        ledger.set_meta("test_content", "stepped", db)
    migrate.backup(ledger, "b-stepped")
    after = {b["path"] for b in migrate.backups(ledger)}
    assert before <= after and all(pathlib.Path(p).exists() for p in after)


def test_a_clock_before_time_sync_is_implausible(ledger, clock):
    from datetime import datetime, timezone
    clock.t = datetime(1970, 1, 2, tzinfo=timezone.utc)
    assert migrate.clock_problem(ledger) == "the clock isn't set yet"


def test_a_dry_run_dated_later_than_now_is_stale(ledger, clock):
    got = migrate.dry_run(ledger.path, version="0.24.0", build="b-future")
    migrate.record_dry_run(ledger, got)
    assert migrate.dry_run_problem(ledger, "b-future") == ""
    clock.advance(minutes=-2)
    assert "dated later than now" in migrate.dry_run_problem(ledger, "b-future")


# -- 7. restore, by schema and build ----------------------------------------------------------------------------

@pytest.mark.migrate_gate
def test_a_backup_restores_at_the_old_schema_and_migrates_again_with_its_rows(tmp_path, clock):
    path = tmp_path / "harness.sqlite"
    led = Ledger(str(path), clock=clock)
    with led.tx() as db:
        led.event("precious", {"keep": True}, db=db)
    got = migrate.run_live(led, None, OWNER, version="0.24.0", build="brestore")
    assert migrate.schema(led) == migrate.HANDOVER and got["backup"]
    with led.tx() as db:
        led.event("after_the_move", {}, db=db)
    staged = migrate.stage_restore(str(path), 1, "brestore")
    assert staged["ok"] is True and (tmp_path / "harness.sqlite.restore").is_file()
    led.close()
    applied = migrate.apply_staged_restore(str(path))
    assert applied["ok"] is True and list(tmp_path.glob("harness-replaced-*.sqlite"))
    led = Ledger(str(path), clock=clock)
    assert migrate.schema(led) == 1 and led.get_meta(calendar_change.INSTALLED) is None
    assert led.db.execute("SELECT COUNT(*) FROM events WHERE kind='precious'").fetchone()[0] == 1
    assert not led.db.execute("SELECT 1 FROM events WHERE kind='after_the_move'").fetchone()
    got = migrate.run_live(led, None, OWNER, version="0.24.0", build="brestore")
    assert not got.get("waiting") and migrate.schema(led) == migrate.HANDOVER
    assert led.db.execute("SELECT COUNT(*) FROM events WHERE kind='precious'").fetchone()[0] == 1
    assert migrate.apply_staged_restore(str(path)) == {}             # nothing staged now


def test_restore_refuses_an_unknown_backup(tmp_path):
    got = migrate.stage_restore(str(tmp_path / "harness.sqlite"), 1, "bnone")
    assert got["ok"] is False and "no backup" in got["said"]


@pytest.mark.migrate_gate
def test_the_restore_command_in_the_specialists_cli(tmp_path, clock):
    path = tmp_path / "harness.sqlite"
    led = Ledger(str(path), clock=clock)
    migrate.run_live(led, None, OWNER, version="0.24.0", build="bcli")
    led.close()
    done = subprocess.run([sys.executable, "-I", "-c",
                           "import sys, runpy; sys.path.insert(0, sys.argv[1]); sys.argv = sys.argv[1:]; "
                           "runpy.run_module('harness.migrate', run_name='__main__', alter_sys=True)",
                           str(APP), str(path), "--restore", "1", "bcli"], capture_output=True, text=True, timeout=120)
    got = json.loads(done.stdout)
    assert done.returncode == 0 and got["ok"] is True and got["backup"].startswith("harness-before-s1-bcli-")


@pytest.mark.migrate_gate
def test_cains_restore_only_posts_him_a_card_and_his_tap_stages_it(m, monkeypatch):
    migrate.run_live(m.ledger, m.cc, OWNER, version="0.24.0", build="bcard")   # the ledger is at schema 2 here
    out = m.send(Handover(kind="fastpath", state="migrate-restore", restore="2 bcard"))
    assert out["status"] == "ok" and "only on his tap" in out["said"], out
    staged = pathlib.Path(m.ledger.path + migrate.RESTORE_SUFFIX)
    assert not staged.exists()
    m.c.outbox.flush()
    assert "Put them back" in m.labels()
    m.tap("Put them back")
    assert staged.exists()
    staged.unlink()


# -- 8. the smoke run records version strength and an unguarded PUT on Family ---------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_the_smoke_run_records_version_strength_and_a_put_with_no_if_match(m):
    run = start(m)
    _, missing, _ = m.cc.smoke_evidence(run)
    assert any(x.startswith("gmail.etag_strength") for x in missing)
    assert any(x.startswith("family.unguarded_put") for x in missing)
    conform(m, run, "family")
    conform(m, run, "gmail")
    rec = calendar_change.card_gate(m.ledger)["conformance"]
    assert rec["family"]["etag_strength"] == "strong" and rec["gmail"]["etag_strength"] == "strong"
    assert rec["family"]["unguarded_put"] in ("taken", "refused")
    puts = [h for meth, path, h, _ in m.icloud.log if meth == "PUT" and "If-Match" not in (h or {})
            and "If-None-Match" not in (h or {})]
    assert puts                                                    # a PUT with no If-Match went to Family
    _, missing, _ = m.cc.smoke_evidence(run)
    assert not [x for x in missing if "etag_strength" in x or "unguarded_put" in x]
    assert not m.cc.smoke_leftovers(run)


def test_a_weak_calendar_is_recorded_as_weak():
    assert calendar_change._strength(['W/"a"', '"b"']) == "weak"
    assert calendar_change._strength(['"a"']) == "strong"
    assert calendar_change._strength([""]) == "none" and calendar_change._strength([]) == ""


# -- 9. what Cain is told, and the docs --------------------------------------------------------------------------

def test_cains_rules_keeper_and_docs_name_this_rounds_behaviour():
    rules = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "CLAUDE.md").read_text()
    keeper = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "keeper.sh").read_text()
    docs = (ROOT / "harness" / "DOCS.md").read_text()
    for text in (rules, docs):
        for words in ("Possibly overwritten", "overwritten or deleted", "migrate-restore", "run time"):
            assert words in text, words
    for words in ("online backup", "integrity", "etag strength", "If-Match", "--restore",
                  "Home Assistant backup"):
        assert words in docs, words
    assert "migrate-restore <schema> <build>" in keeper
    # Cain's side is the section that introduced the calendar specialist's restore, restart and clock
    # behaviour, Cain 0.17.0, found by its version heading (newer Cain sections need not repeat it).
    # Harness's side is likewise its 0.24.4 section, found by its version heading.
    for log in ((ROOT / "harness" / "CHANGELOG.md").read_text().split("\n## 0.24.4\n", 1)[1].split("\n## ", 1)[0],
                cain_changelog_section("0.17.0")):
        assert "Unprotected" in log or "restore" in log.lower()


def cain_changelog_section(version):
    """The Cain CHANGELOG section headed "## <version>", through the line before the next heading."""
    text = (ROOT / "cain" / "CHANGELOG.md").read_text()
    head = f"\n## {version}\n"
    assert head in text, f"Cain's CHANGELOG has no {version} section"
    return text.split(head, 1)[1].split("\n## ", 1)[0]
