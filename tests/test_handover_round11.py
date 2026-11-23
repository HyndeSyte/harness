"""0.24.0, eleventh round: what the tenth outside review of the handover fixes asked for (Nov 16).

Each change on its own, against the fake calendars and a fake Discord: the install rehearsal is self-serve
(the specialist runs its own dry run on a copy of its ledger and, on a pass, backs up and migrates with no
command; only a failed dry run waits, with Run check; Cain's override only posts the owner a card, and the
migration runs only on his tap); a dry run counts only at the live schema version and within 24 hours;
backups are keyed by schema version and build, deduplicated by content, and the oldest at a schema version
stays until a later migration has run a day; weak versions are compared weakly and never sent as If-Match,
and a calendar the specialist can't protect gets one plain message, its held requests passed back ready to
copy, and Open without protection (every receipt then says Unprotected); leftovers are searched from the
day before to the day after, and a series over its whole span; the gate re-closes only on a write that
changed content and kept its version, naming it; a ledger as the other open pull request leaves it migrates
up; and duplicate or conflicting schema step numbers are refused. All names and ids invented.
"""
import json
import pathlib
from datetime import date, datetime, timedelta, timezone

import pytest

from harness import calendar_change, migrate
from harness.handover import Handover
from harness.ledger import Ledger
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (FAMILY_PATH, GMAIL, TZ, Morning, at, ask, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round4 import DENTIST
from test_handover_round5 import (DROP_SWIM, HAIRCUT, MOVE_HAIRCUT, SWIM_PATH, haircut_at, seed_haircut,
                                  swim_at, swim_ics)
from test_handover_round6 import card_for, last_pid
from test_handover_round9 import _gmail_takes_any_if_match
from test_handover_round10 import _weak_etags, conform, seen_both, start, told
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def failing_dry_run(monkeypatch, said="the copy's sweep stopped on a card it couldn't read"):
    real = migrate.dry_run

    def fails(path, version=None, build=None, **kw):
        got = real(path, version, build, **kw)
        return {**got, "ok": False, "said": said}
    monkeypatch.setattr(migrate, "dry_run", fails)
    return real


def notices(ledger):
    return [(r[0], json.loads(r[1]) if r[1] else []) for r in
            ledger.db.execute("SELECT text, buttons_json FROM outbox WHERE kind='notice' ORDER BY id")]


# -- 1. the install rehearsal is self-serve --------------------------------------------------------------------

@pytest.mark.migrate_gate
def test_a_clean_install_migrates_without_any_command(ledger, tmp_path):
    got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-clean")
    assert not got.get("waiting")
    kept = migrate.dry_run_for(ledger, "b-clean")
    assert kept["ok"] is True and kept["self_serve"] is True and kept["source_schema"] == 1
    assert json.loads(ledger.get_meta(calendar_change.INSTALLED))["build"] == "b-clean"
    assert pathlib.Path(got["backup"]).is_file() and pathlib.Path(got["backup"]).parent == tmp_path
    assert not notices(ledger) and not migrate.waiting(ledger)


@pytest.mark.migrate_gate
def test_the_live_specialist_migrates_at_startup_on_its_own(m):
    assert not migrate.waiting(m.ledger)
    assert migrate.dry_run_for(m.ledger, calendar_change.app_build())["self_serve"] is True
    assert json.loads(m.ledger.get_meta(calendar_change.INSTALLED))["build"] == calendar_change.app_build()
    m.c.outbox.flush()
    assert not [t for t in m.seen() if "hasn't moved its records" in t]


@pytest.mark.migrate_gate
def test_a_failed_dry_run_waits_with_only_a_run_check_button(ledger, monkeypatch):
    real = failing_dry_run(monkeypatch)
    got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-fail")
    assert got["waiting"] is True and "failed" in got["why"]
    assert ledger.get_meta(calendar_change.INSTALLED) is None and ledger.get_meta(migrate.BACKUP) is None
    said = notices(ledger)
    assert len(said) == 1 and "hasn't moved its records over yet" in said[0][0]
    assert "couldn't read" in said[0][0]
    assert [b[0] for row in said[0][1] for b in row] == ["Run check"]           # that button and nothing else
    migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-fail")     # a restart: told once
    assert len(notices(ledger)) == 1
    # Run check re-runs the dry run in the specialist; once it passes, the records move, backup first.
    monkeypatch.setattr(migrate, "dry_run", real)
    monkeypatch.setattr(calendar_change, "app_build", lambda: "b-fail")
    monkeypatch.setattr(calendar_change, "app_version", lambda: "0.24.0")
    said = migrate.check_tapped(ledger, None, OWNER)
    assert "passed" in said and not migrate.waiting(ledger)
    assert json.loads(ledger.get_meta(calendar_change.INSTALLED))["build"] == "b-fail"


@pytest.mark.migrate_gate
def test_run_check_that_fails_again_says_so_with_a_new_run_check(ledger, monkeypatch):
    failing_dry_run(monkeypatch)
    monkeypatch.setattr(calendar_change, "app_build", lambda: "b-fail")
    migrate.run_live(ledger, None, OWNER)
    said = migrate.check_tapped(ledger, None, OWNER)
    assert "didn't pass again" in said and migrate.waiting(ledger)
    assert len(notices(ledger)) == 2 and all(n[1] for n in notices(ledger))


@pytest.mark.migrate_gate
def test_the_run_check_button_works_through_the_live_specialist(m, monkeypatch):
    real = failing_dry_run(monkeypatch)
    monkeypatch.setattr(calendar_change, "app_build", lambda: "b-next")
    migrate.run_live(m.ledger, m.cc, OWNER)
    m.c.outbox.flush()
    assert "Run check" in m.labels()
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    assert out["status"] == "refused" and "Run check" in out["said"]
    monkeypatch.setattr(migrate, "dry_run", real)
    m.tap("Run check")
    assert not migrate.waiting(m.ledger)
    assert json.loads(m.ledger.get_meta(calendar_change.INSTALLED))["build"] == "b-next"


@pytest.mark.migrate_gate
def test_cains_override_posts_a_card_and_migrates_only_on_his_tap(m, monkeypatch):
    failing_dry_run(monkeypatch)
    monkeypatch.setattr(calendar_change, "app_build", lambda: "b-next")
    migrate.run_live(m.ledger, m.cc, OWNER)
    assert migrate.waiting(m.ledger)
    out = m.send(Handover(kind="fastpath", state="migrate-override"))
    assert out["status"] == "ok" and "only on his tap" in out["said"]
    assert migrate.waiting(m.ledger)                                       # nothing moved yet
    assert m.ledger.get_meta(migrate.OVERRIDE + "b-next") is None
    card = told(m, "Move Harness's records without a rehearsal?")
    assert len(card) == 1 and "failed" in card[-1] and "couldn't read" in card[-1]
    assert "A backup of the records is taken first" in card[-1] and "just once" in card[-1]
    m.tap("Move them anyway")
    assert not migrate.waiting(m.ledger)
    assert json.loads(m.ledger.get_meta(calendar_change.INSTALLED))["build"] == "b-next"
    assert pathlib.Path(json.loads(m.ledger.get_meta(migrate.BACKUP))["path"]).is_file()
    row = m.ledger.db.execute("SELECT detail FROM events WHERE kind='migration_override'").fetchone()
    assert json.loads(row[0])["by"] == "owner tap" and json.loads(row[0])["build"] == "b-next"
    assert m.ledger.get_meta(migrate.OVERRIDE + "b-next") is None           # single use
    assert m.ledger.db.execute("SELECT 1 FROM events WHERE kind='migration_override_used'").fetchone()


@pytest.mark.migrate_gate
def test_the_override_is_tied_to_its_build_and_refused_past_an_unsaid_failed_dry_run(ledger, monkeypatch):
    monkeypatch.setattr(calendar_change, "app_build", lambda: "b-now")
    with ledger.tx() as db:            # waiting for another reason (a backup that couldn't be made)
        ledger.set_meta(migrate.WAITING, json.dumps({"build": "b-now", "why": "the ledger couldn't be backed up "
                                                                              "first"}), db)
    assert migrate.request_override(ledger, OWNER, by="cain")[0] == "ok"
    target = ledger.db.execute("SELECT target FROM choices WHERE kind='migration_override'").fetchone()[0]
    assert target == "b-now none"
    assert "another update" in migrate.override_tapped(ledger, None, OWNER, "b-old none")
    migrate.record_dry_run(ledger, {"build": "b-now", "ok": False, "schema_before": 1, "said": "it broke"})
    said = migrate.override_tapped(ledger, None, OWNER, target)
    assert said.startswith("Not moved") and ledger.get_meta(calendar_change.INSTALLED) is None
    assert ledger.get_meta(migrate.OVERRIDE + "b-now") is None
    # A card that says so explicitly may go ahead.
    assert "Moved without a rehearsal" in migrate.override_tapped(ledger, None, OWNER, "b-now failed")
    assert json.loads(ledger.get_meta(calendar_change.INSTALLED))["build"] == "b-now"


def test_the_override_with_nothing_waiting_is_refused(ledger):
    assert migrate.request_override(ledger, OWNER, by="cain")[0] == "refused"


# -- 2. a dry run counts only at the live schema version and within 24 hours --------------------------------------

def test_a_dry_run_carries_its_source_schema_and_time(ledger, clock):
    kept = migrate.record_dry_run(ledger, {"build": "b1", "ok": True, "schema_before": 1})
    assert kept["source_schema"] == 1 and kept["at"] == clock().isoformat().replace("+00:00", "Z") \
        or kept["at"].startswith(clock().strftime("%Y-%m-%dT%H:%M"))
    assert migrate.dry_run_problem(ledger, "b1") == ""


@pytest.mark.migrate_gate
def test_a_dry_run_at_another_schema_version_counts_as_none(ledger):
    migrate.record_dry_run(ledger, {"build": "b1", "ok": True, "schema_before": 1})
    with ledger.tx() as db:
        ledger.set_meta(migrate.SCHEMA, "2", db)
    assert "rehearsed schema 1, and the ledger is at schema 2" in migrate.dry_run_problem(ledger, "b1")
    assert migrate.dry_run_missing(ledger, "b1")


def test_a_dry_run_older_than_a_day_counts_as_none(ledger, clock):
    migrate.record_dry_run(ledger, {"build": "b1", "ok": True, "schema_before": 1})
    clock.advance(hours=23)
    assert migrate.dry_run_problem(ledger, "b1") == ""
    clock.advance(hours=2)
    assert "older than 24 hours" in migrate.dry_run_problem(ledger, "b1")


def test_a_dry_run_with_no_source_schema_counts_as_none(ledger):
    migrate.record_dry_run(ledger, {"build": "b1", "ok": True})
    assert "rehearsed schema unknown" in migrate.dry_run_problem(ledger, "b1")


@pytest.mark.migrate_gate
def test_a_stale_dry_run_is_rehearsed_again_before_the_install(ledger, clock):
    migrate.record_dry_run(ledger, {"build": "b1", "ok": True, "schema_before": 1})
    clock.advance(hours=30)
    got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b1")
    assert not got.get("waiting") and migrate.dry_run_for(ledger, "b1")["self_serve"] is True


# -- 3. backups: keyed, deduplicated, and the oldest at a schema version kept ------------------------------------

@pytest.mark.migrate_gate
def test_repeated_failed_attempts_take_one_backup(ledger, monkeypatch, clock):
    real = migrate.run

    def breaks(led, *a, **kw):              # the rehearsal on a copy passes; the live ledger's run breaks
        if led.path == ledger.path:
            raise RuntimeError("a step broke")
        return real(led, *a, **kw)
    monkeypatch.setattr(migrate, "run", breaks)
    for _ in range(4):
        got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-broken")
        assert got["waiting"] is True and "the migration failed (RuntimeError)" in got["why"]
        clock.advance(minutes=5)
    files = sorted(pathlib.Path(ledger.path).parent.glob("harness-before-*.sqlite"))
    assert len(files) == 1 and files[0].name.startswith("harness-before-s1-bbroken-")
    assert len(migrate.backups(ledger)) == 1
    assert ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='migration_backup_same'").fetchone()[0] == 3
    assert ledger.get_meta(calendar_change.INSTALLED) is None              # nothing moved
    assert len(notices(ledger)) == 1                                       # told once


def test_the_oldest_backup_at_a_schema_version_is_kept_until_a_later_migration_ran_a_day(ledger, clock):
    made = []
    for i in range(6):
        with ledger.tx() as db:
            ledger.set_meta("test_content", str(i), db)               # each attempt on different content
        made.append(migrate.backup(ledger, f"b{i}"))
        clock.advance(minutes=1)
    kept = [b["path"] for b in migrate.backups(ledger)]
    assert made[0] in kept and kept[-migrate.BACKUP_KEEP:] == made[-migrate.BACKUP_KEEP:]
    assert len(kept) == migrate.BACKUP_KEEP + 1
    assert all(pathlib.Path(p).is_file() for p in kept)
    assert not pathlib.Path(made[1]).exists()
    # A later migration succeeded, but the ledger hasn't run on it a day: the oldest stays.
    migrate._succeeded(ledger, "b-later")
    with ledger.tx() as db:
        ledger.set_meta("test_content", "later", db)
    migrate.backup(ledger, "b-later2")
    assert made[0] in [b["path"] for b in migrate.backups(ledger)]
    clock.advance(hours=25)
    with ledger.tx() as db:          # twelfth round: a day of the App's run time, not of the wall clock
        ledger.set_meta(migrate.UPTIME, str(migrate.uptime(ledger) + 25 * 3600), db)
        ledger.set_meta("test_content", "a day on", db)
    migrate.backup(ledger, "b-later3")
    kept = [b["path"] for b in migrate.backups(ledger)]
    assert made[0] not in kept and not pathlib.Path(made[0]).exists()
    assert len(kept) == migrate.BACKUP_KEEP          # each older one predates the migration that ran a day


def test_no_new_backup_when_the_ledger_matches_the_newest(ledger, clock):
    first = migrate.backup(ledger, "b1")
    clock.advance(minutes=1)
    assert migrate.backup(ledger, "b2") == first
    with ledger.tx() as db:
        ledger.set_meta("test_content", "changed", db)
    assert migrate.backup(ledger, "b3") != first


# -- 4. weak versions, and calendars the specialist can't protect ------------------------------------------------

@pytest.mark.card_only
def test_a_weak_version_is_compared_weakly_and_the_write_goes_as_read_compare_write(m, caplog):
    import logging
    caplog.set_level(logging.INFO, logger="harness.calendar_change")
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    _weak_etags(m)              # reads give W/ versions, and a W/ If-Match is refused (a strong compare)
    pid = card_for(m, "no swim today", ask(DROP_SWIM))
    m.tap("Approve")
    m.c.tick()
    assert swim_at(m) is None
    sent = [h.get("If-Match") for meth, path, h, _ in m.icloud.log if meth == "DELETE" and path == SWIM_PATH]
    assert sent == [None]
    assert "read-compare-write (it gives only a weak version)" in caplog.text
    assert m.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()[0] \
        == "done"


def test_etags_compare_weakly_for_reads():
    assert calendar_change._etag_same('W/"a1"', '"a1"') and calendar_change._etag_same('"a1"', '"a1"')
    assert not calendar_change._etag_same('W/"a1"', '"a2"') and not calendar_change._etag_same("", "")
    assert calendar_change._weak('W/"a1"') and not calendar_change._weak('"a1"')


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_calendar_that_ignores_versions_is_told_once_passes_back_held_requests_and_opens_unprotected(
        m, monkeypatch):
    seed_haircut(m)
    run = start(m)
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    assert out["status"] != "refused"
    held = last_pid(m)
    assert m.ledger.get_meta(f"{calendar_change.HELD}{held}")
    seen_both(m, "gmail")
    _gmail_takes_any_if_match(m, monkeypatch)
    assert conform(m, run, "gmail")["result"] == "ignored"
    msg = told(m, "Harness can't change Gmail safely.")
    assert len(msg) == 1 and "by hand in the calendar app" in msg[0]
    assert "ready to copy" in msg[0] and "Gmail | Add | “Dentist”" in msg[0] and "15:00 to 16:00" in msg[0]
    assert "Open without protection" in m.labels()
    assert m.ledger.get_meta(f"{calendar_change.HELD}{held}")             # still held, so it can come back
    conform(m, run, "gmail")
    assert len(told(m, "Harness can't change Gmail safely.")) == 1        # told once
    # Held later: passed back at once, ready to copy.
    m.tells("haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    assert told(m, "Waiting for Gmail") and "Gmail | Move | “Haircut”" in told(m, "Waiting for Gmail")[-1]
    m.tap("Open without protection")
    assert "gmail" not in calendar_change.closed_providers(m.ledger)
    assert "open without protection" in m.seen()[-1] or any("open without protection" in t for t in m.seen())


@pytest.mark.card_only
@pytest.mark.install_gate
def test_writes_on_a_calendar_opened_without_protection_go_unguarded_and_every_receipt_says_so(m, monkeypatch):
    seed_haircut(m)
    run = start(m)
    seen_both(m, "gmail")
    _gmail_takes_any_if_match(m, monkeypatch)
    conform(m, run, "gmail")
    m.tap("Open without protection")
    sent = []
    real = m.gmail.change
    monkeypatch.setattr(m.gmail, "change", lambda a, uid, f, etag: sent.append(etag) or real(a, uid, f, etag))
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    m.c.tick()
    m.c.outbox.flush()
    assert haircut_at(m) == "10:30" and sent == [None]
    done = [t for t in m.seen() if t.startswith("Done")]
    assert done and "Unprotected: Gmail was changed without the calendar's version check" in done[-1]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_an_incompatible_calendar_is_never_a_dead_end(m):
    run = start(m)
    seen_both(m, "family")
    _weak_etags(m)
    conform(m, run, "family")
    assert "Open without protection" in m.labels() and "Test again" in m.labels()
    said = m.cc.open_gate("family", by="owner tap")
    assert "open without protection" in said and "family" not in calendar_change.closed_providers(m.ledger)


# -- 5. leftovers by nonce: the day before to the day after, and a series's whole span ----------------------------

def test_a_step_near_midnight_in_his_zone_records_his_day(m):
    # 00:30 UTC on the 12th is 19:30 on the 11th in New York.
    assert m.cc._smoke_days({"op": "add", "start": "2026-11-12T00:30:00+00:00"}) == {"day": "2026-11-11"}
    got = m.cc._smoke_days({"op": "add_series", "start": "2026-11-12T00:30:00+00:00", "until": "2026-11-30"})
    assert got == {"day": "2026-11-11", "until": "2026-11-30"}


@pytest.mark.parametrize("when", ["2026-11-10T23:45:00-05:00", "2026-11-12T00:15:00-05:00"])
def test_a_leftover_just_either_side_of_midnight_is_found_by_its_nonce(m, when):
    with m.ledger.tx() as db:
        m.ledger.set_meta(calendar_change.SMOKE_RUN, json.dumps({"id": "run1", "at": "2026-11-11T12:00:00Z"}), db)
    m.gmail.events["cmlost1"] = {
        "id": "cmlost1", "summary": "Smoke test: Piano", "status": "confirmed",
        "extendedProperties": {"private": {calendar_change.SMOKE_PROP: "run1",
                                           calendar_change.SMOKE_NONCE_PROP: "n0nce"}},
        "start": {"dateTime": when, "timeZone": TZ},
        "end": {"dateTime": (datetime.fromisoformat(when) + timedelta(minutes=30)).isoformat(), "timeZone": TZ}}
    got = m.cc._leftover_by_nonce({"cal": "gmail", "nonce": "n0nce", "day": "2026-11-11"}, "run1")
    assert got and got["id"] == "cmlost1"
    assert m.cc._leftover_by_nonce({"cal": "gmail", "nonce": "other", "day": "2026-11-11"}, "run1") is None


def test_a_series_leftover_is_found_over_its_whole_span(m):
    m.gmail.events["cmseries1_20261119T000000Z"] = {
        "id": "cmseries1_20261119T000000Z", "recurringEventId": "cmseries1", "summary": "Smoke test: Piano",
        "status": "confirmed",
        "extendedProperties": {"private": {calendar_change.SMOKE_PROP: "run1",
                                           calendar_change.SMOKE_NONCE_PROP: "n0nce"}},
        "start": {"dateTime": "2026-11-18T19:00:00-05:00", "timeZone": TZ},
        "end": {"dateTime": "2026-11-18T19:30:00-05:00", "timeZone": TZ}}
    entry = {"cal": "gmail", "nonce": "n0nce", "day": "2026-11-11"}
    assert m.cc._leftover_by_nonce(entry, "run1") is None                    # a week on: outside one day
    got = m.cc._leftover_by_nonce({**entry, "until": "2026-11-25"}, "run1")
    assert got and got["id"] == "cmseries1"                                  # the series, not one day of it


# -- 6. the gate re-closes only on changed content under an unchanged version ------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_no_op_write_that_keeps_its_version_never_closes_the_gate(m):
    seed_haircut(m)
    run = start(m)
    seen_both(m, "gmail")
    conform(m, run, "gmail")
    assert "gmail" not in calendar_change.closed_providers(m.ledger)
    now = m.gmail.events[HAIRCUT]
    entry = {"cal": "gmail", "how": "change", "id": HAIRCUT, "was": now["etag"],
             "fields": {"start": dict(now["start"]), "end": dict(now["end"])},
             "wrote": {"start": dict(now["start"]), "end": dict(now["end"])},
             "check": {"kind": "starts", "start": now["start"]["dateTime"], "end": now["end"]["dateTime"]}}
    m.cc._gmail_reread(m.cc._gmail_address(), HAIRCUT, entry)
    assert "gmail" not in calendar_change.closed_providers(m.ledger)
    assert calendar_change.conformance_of(m.ledger, "gmail") == "enforced"
    assert not told(m, "Harness can't change Gmail safely.")


def test_an_ics_body_that_only_changed_its_stamps_is_the_same_content():
    a = swim_ics("20261111T210000Z", "20261111T220000Z")
    b = a.replace("DTSTAMP:20261101T120000Z", "DTSTAMP:20261116T080000Z")
    assert calendar_change._ics_content(a) == calendar_change._ics_content(b)
    assert calendar_change._ics_content(a) != calendar_change._ics_content(swim_ics("20261111T220000Z",
                                                                                     "20261111T230000Z"))


# -- 7. the other open pull request's ledger, and schema step numbers ---------------------------------------------

def _ledger_as_pull_request_20_leaves_it(path, clock):
    """Pull request 20 (Cain runs as his own user) changes no ledger schema: it keeps main's, with no
    ledger_schema kept (1), and adds outbox rows dropped as dead after 7 days unsent, each with a
    delivery_expired event. Its App version is 0.24.0 too."""
    led = Ledger(str(path), clock=clock)
    with led.tx() as db:
        led.enqueue(chat_id=OWNER, kind="reply", text="An old reply", db=db)
        db.execute("UPDATE outbox SET state='dead', last_error=?",
                   ("unsent after 7 days: dropped, never retried as new",))
        led.event("delivery_expired", {"outbox": 1, "kind": "reply"}, db=db)
    return led


@pytest.mark.migrate_gate
def test_a_ledger_at_the_other_pull_requests_final_schema_migrates_up(tmp_path, clock):
    led = _ledger_as_pull_request_20_leaves_it(tmp_path / "harness.sqlite", clock)
    assert migrate.schema(led) == 1
    got = migrate.run_live(led, None, OWNER, version="0.24.0", build="b-after-20")
    assert not got.get("waiting")
    assert migrate.schema(led) == migrate.HANDOVER and led.get_meta(f"{migrate.STEP_DONE}2") == "handover_sweep"
    row = led.db.execute("SELECT state, last_error FROM outbox").fetchone()
    assert row[0] == "dead" and row[1].startswith("unsent after 7 days")
    assert led.db.execute("SELECT COUNT(*) FROM events WHERE kind='delivery_expired'").fetchone()[0] == 1
    assert migrate.dry_run_for(led, "b-after-20")["source_schema"] == 1


def test_duplicate_or_conflicting_schema_step_numbers_are_refused(ledger):
    migrate.check_steps()                                         # this build's own
    for steps in (((2, "a"), (2, "b")), ((2, "a"), (3, "a")), ((3, "a"), (2, "b")), ((1, "a"),)):
        with pytest.raises(migrate.StepConflict):
            migrate.check_steps(steps)
    with ledger.tx() as db:
        ledger.set_meta(f"{migrate.STEP_DONE}2", "another_change", db)
    with pytest.raises(migrate.StepConflict):
        migrate.check_steps(migrate.STEPS, ledger)


@pytest.mark.migrate_gate
def test_a_ledger_that_did_another_step_under_this_number_waits(ledger):
    with ledger.tx() as db:
        ledger.set_meta(f"{migrate.STEP_DONE}2", "another_change", db)
    got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-x")
    assert got["waiting"] is True and "schema step 2 as another_change" in got["why"]
    assert ledger.get_meta(calendar_change.INSTALLED) is None


# -- 8. what Cain is told, and the docs ------------------------------------------------------------------------

def test_cains_rules_keeper_and_docs_name_this_rounds_behaviour():
    rules = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "CLAUDE.md").read_text()
    keeper = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "keeper.sh").read_text()
    docs = (ROOT / "harness" / "DOCS.md").read_text()
    for text in (rules, docs):
        for words in ("Run check", "Open without protection", "Unprotected", "ready to copy"):
            assert words in text, words
    assert "posts him a card" in keeper and "migrate-override" in keeper
    # Harness's side is the section this round shipped in, Harness 0.24.4, found by its version heading
    # (newer Harness sections need not repeat it).
    log = (ROOT / "harness" / "CHANGELOG.md").read_text().split("\n## 0.24.4\n", 1)[1].split("\n## ", 1)[0]
    assert "rehears" in log
