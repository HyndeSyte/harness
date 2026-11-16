"""0.24.0, tenth round: what the ninth outside review of the handover fixes asked for (Nov 16).

Each change on its own, against the fake calendars and a fake Discord: the migration dry run rehearses the
incoming build (keeper.sh fastpath migrate-check with a candidate), and the install step won't migrate the
live ledger without one for its own build (or Cain's logged override), with a backup just before; a smoke
step runs from its own script after his Start step tap, and a handover naming the run is an ordinary
request; the conformance item checks an edit, a removal and an edit of one day of a series, each answered
with the documented stale answer and read back unapplied; a refused fresh edit is said as an
incompatibility, with Test again and no override; leftover test events are found by their exact nonce;
held requests are told at hold time and reminded daily; the first refusal on an overridden calendar offers
Start again from now; a calendar seen taking a write without changing its version closes again; and CI
builds the image and compares its build id with the tree's. All names and ids invented.
"""
import json
import pathlib
import shutil
import sqlite3

import pytest

from harness import buildid, caldav, calendar_change, migrate
from harness.handover import Handover
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (FAMILY_PATH, GMAIL, TZ, Morning, at, ask, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round4 import DENTIST, dentists
from test_handover_round5 import MOVE_HAIRCUT, haircut_at, seed_haircut, settle
from test_handover_round6 import card_for, last_pid, script_of, state, step_card
from test_handover_round7 import _gmail_refuses_every_fence
from fake_caldav import no_network  # noqa: F401  (autouse)
from fakes import HttpResponse

ROOT = pathlib.Path(__file__).resolve().parents[1]
PIANO = change("gmail", "add", "Piano", dates="", start=at(13).isoformat(), end=at(14).isoformat())


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def labels_of(card):
    return [c["label"] for r in card["rows"] for c in r["components"]]


def start(m):
    out = m.send(Handover(kind="fastpath", state="smoke-start"))
    assert out["status"] == "ok"
    return out["run"]


def conform(m, run, calendar):
    return m.send(Handover(kind="fastpath", state="smoke-step", run=run, step=f"conformance-{calendar}"))


def told(m, head):
    m.c.outbox.flush()
    return [t for t in m.seen() if t.startswith(head)]


def seen_both(m, calendar):
    """As if the smoke run had read back a fenced edit and a series-day edit there."""
    gate = calendar_change.card_gate(m.ledger)
    with m.ledger.tx() as db:
        gate["seen"][calendar] = {"fenced": "x", "series": "x"}
        m.ledger.set_meta(calendar_change.CARD_GATE, json.dumps(gate), db)


# -- 1. the dry run rehearses the incoming build ---------------------------------------------------------------

def candidate_tree(tmp_path):
    tree = tmp_path / "candidate" / "harness"
    shutil.copytree(ROOT / "harness", tree, ignore=shutil.ignore_patterns("__pycache__", "BUILD_ID"))
    f = tree / "app" / "harness" / "render.py"
    f.write_text(f.read_text() + "\n# the incoming build\n")
    return tree


def test_a_dry_run_of_a_candidate_build_is_recorded_under_the_candidates_build_id(m, tmp_path):
    tree = candidate_tree(tmp_path)
    want = buildid.compute(tree, tree / "app")
    assert want != calendar_change.app_build()
    before = pathlib.Path(m.ledger.path).read_bytes()
    out = m.send(Handover(kind="fastpath", state="migrate-check", candidate=str(tree)))
    assert out["status"] == "ok", out
    assert out["result"]["recorded"]["build"] == want and out["result"]["recorded"]["candidate"] == str(tree)
    assert migrate.dry_run_for(m.ledger, want)["ok"] is True
    assert not migrate.dry_run_for(m.ledger, calendar_change.app_build())     # the running build's isn't claimed
    got = json.loads(m.ledger.db.execute("SELECT detail FROM events WHERE kind='migration_dry_run' ORDER BY id DESC"
                                         ).fetchone()[0])
    assert got["build"] == want and got["ran_by"] == calendar_change.app_build()
    assert len(before) > 0


def test_a_candidate_path_with_no_build_is_refused_and_nothing_recorded(m, tmp_path):
    out = m.send(Handover(kind="fastpath", state="migrate-check", candidate=str(tmp_path)))
    assert out["status"] == "refused" and "no build to rehearse" in out["said"]
    assert not out["result"]["recorded"]


@pytest.mark.migrate_gate
def test_an_install_with_a_matching_dry_run_proceeds_with_a_backup_first(ledger, tmp_path):
    migrate.record_dry_run(ledger, {"build": "b-new", "version": "0.24.0", "ok": True, "checksum": "c" * 64})
    got = migrate.run_live(ledger, None, 0, version="0.24.0", build="b-new")
    assert not got.get("waiting")
    assert json.loads(ledger.get_meta(calendar_change.INSTALLED))["build"] == "b-new"
    copy = pathlib.Path(got["backup"])
    assert copy.is_file() and copy.parent == tmp_path and copy.name.startswith("harness-before-bnew-")
    # The backup is the ledger as it was just before: no install recorded in it, and it opens.
    db = sqlite3.connect(copy)
    assert db.execute("SELECT value FROM meta WHERE key=?", (calendar_change.INSTALLED,)).fetchone() is None
    db.close()
    assert json.loads(ledger.get_meta(migrate.BACKUP))["path"] == str(copy)


@pytest.mark.migrate_gate
def test_an_install_without_a_dry_run_refuses_and_says_so(ledger):
    got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-none")
    assert got["waiting"] is True and "no migration dry run is recorded for build b-none" in got["why"]
    assert ledger.get_meta(calendar_change.INSTALLED) is None and ledger.get_meta(migrate.DONE) is None
    notices = [r[0] for r in ledger.db.execute("SELECT text FROM outbox WHERE kind='notice'")]
    assert len(notices) == 1 and "hasn't moved its records over yet" in notices[0]
    migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-none")                  # told once
    assert ledger.db.execute("SELECT COUNT(*) FROM outbox WHERE kind='notice'").fetchone()[0] == 1
    # A failed dry run doesn't count either.
    migrate.record_dry_run(ledger, {"build": "b-none", "ok": False})
    assert "failed" in migrate.dry_run_missing(ledger, "b-none")


@pytest.mark.migrate_gate
def test_the_live_specialist_waits_tells_cain_and_moves_after_its_own_dry_run(m):
    assert migrate.waiting(m.ledger)                              # nothing recorded for this build
    m.c.outbox.flush()
    assert told(m, "Harness ") and "hasn't moved its records over yet" in told(m, "Harness ")[-1]
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    assert out["status"] == "refused" and "keeper.sh fastpath migrate-check" in out["said"]
    assert "migrate-override" in out["said"]
    out = m.send(Handover(kind="fastpath", state="migrate-check"))
    assert out["status"] == "ok" and "records are moved now" in out["said"]
    assert not migrate.waiting(m.ledger)
    assert json.loads(m.ledger.get_meta(calendar_change.INSTALLED))["build"] == calendar_change.app_build()
    assert pathlib.Path(json.loads(m.ledger.get_meta(migrate.BACKUP))["path"]).is_file()


@pytest.mark.migrate_gate
def test_cains_override_is_logged_and_moves_the_records_with_a_backup(m):
    out = m.send(Handover(kind="fastpath", state="migrate-override"))
    assert out["status"] == "ok" and "kept in the log" in out["said"]
    row = m.ledger.db.execute("SELECT detail FROM events WHERE kind='migration_override'").fetchone()
    assert json.loads(row[0])["by"] == "cain" and json.loads(row[0])["build"] == calendar_change.app_build()
    assert not migrate.waiting(m.ledger) and m.ledger.get_meta(migrate.BACKUP)
    again = m.send(Handover(kind="fastpath", state="migrate-override"))
    assert again["status"] == "refused" and "Nothing is waiting" in again["said"]


def test_python_m_harness_migrate_takes_a_candidate(tmp_path, ledger):
    tree = candidate_tree(tmp_path)
    got = migrate.candidate_dry_run(ledger.path, str(tree))
    assert got["ok"] is True and got["build"] == buildid.compute(tree, tree / "app")
    assert migrate.candidate_layout(str(tree)) == (str(tree / "app"), str(tree))


# -- 2. step ownership doesn't rest on the model ---------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_handover_naming_the_run_that_cites_a_real_request_is_held_with_his_title_never_the_runs(m):
    run = start(m)
    m.send(Handover(kind="fastpath", state="smoke-step", run=run, step="gmail-add", script=script_of(PIANO)))
    out = m.tells("add the dentist at 3 today", ask(DENTIST), smoke_run=run)
    assert out["status"] != "refused"
    pid = last_pid(m)
    job = m.ledger.db.execute("SELECT job_id FROM proposals WHERE id=?", (pid,)).fetchone()[0]
    assert m.cc.owned_run(job) == ""                              # never tagged as the run's
    assert m.ledger.get_meta(f"{calendar_change.HELD}{pid}")       # held like any other request
    assert "Start step 1" in m.labels()                          # the offered step is still his to start
    m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    m.tap("Approve")
    m.c.tick()
    got = dentists(m)
    assert len(got) == 1 and got[0]["summary"] == "Dentist" and "extendedProperties" not in got[0]
    assert not m.cc.created_by(run)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_the_start_step_card_shows_the_script_and_a_bad_script_is_refused(m):
    run = start(m)
    bad = m.send(Handover(kind="fastpath", state="smoke-step", run=run, step="gmail-add",
                          script={"calendar": "gmail", "kind": "add", "title": "Piano", "day": "2026-11-11"}))
    assert bad["status"] == "refused" and "HH:MM-HH:MM" in bad["said"]
    out = m.send(Handover(kind="fastpath", state="smoke-step", run=run, step="gmail-add", script=script_of(PIANO)))
    assert out["status"] == "ok"
    offer = told(m, "Check after installing, step 1")
    assert offer and "Gmail: add “Smoke test: Piano” on" in offer[-1] and "13:00 to 14:00" in offer[-1]
    assert "built from this script by Harness itself" in offer[-1]


# -- 3. the conformance item is specific and complete ----------------------------------------------------------

def _gmail_stale(m, monkeypatch, *, on, answer=None, apply=False):
    """The fake Gmail answers a stale write of kind `on` ("change" or "drop") otherwise."""
    real = getattr(m.gmail, on)

    def write(address, uid, *rest):
        etag = rest[-1]
        if m.gmail._stale(uid, etag) and (on == "drop" or "check 2" in str(rest[0]) or "check 4" in str(rest[0])):
            if apply:
                return real(address, uid, *rest[:-1], None)
            return answer
        return real(address, uid, *rest)
    monkeypatch.setattr(m.gmail, on, write)


@pytest.mark.card_only
@pytest.mark.install_gate
@pytest.mark.parametrize("answer", [caldav.Outcome("auth", 401), caldav.Outcome("failed", 400),
                                    caldav.Outcome("unknown", 429), caldav.Outcome("failed", 501),
                                    caldav.Outcome("changed", None)])
def test_a_stale_edit_refused_any_other_way_is_unknown_and_keeps_the_gate_closed(m, monkeypatch, answer):
    run = start(m)
    seen_both(m, "gmail")
    _gmail_stale(m, monkeypatch, on="change", answer=answer)
    out = conform(m, run, "gmail")
    assert out["result"] == "unknown" and out["kinds"]["edit"] == "unknown"
    assert "gmail" in calendar_change.closed_providers(m.ledger)
    assert "couldn't be told" in out["said"]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_412_whose_read_back_shows_the_stale_write_applied_is_ignored(m, monkeypatch):
    run = start(m)
    seen_both(m, "gmail")
    real = m.gmail.change

    def change_(address, uid, fields, etag):
        if m.gmail._stale(uid, etag):
            real(address, uid, fields, None)
            return caldav.Outcome("changed", 412)
        return real(address, uid, fields, etag)
    monkeypatch.setattr(m.gmail, "change", change_)
    out = conform(m, run, "gmail")
    assert out["result"] == "ignored" and out["kinds"]["edit"] == "ignored"
    assert "gmail" in calendar_change.closed_providers(m.ledger)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_gmails_409_for_a_stale_write_counts_as_its_stale_answer(m, monkeypatch):
    run = start(m)
    seen_both(m, "gmail")
    _gmail_stale(m, monkeypatch, on="change", answer=caldav.Outcome("exists", 409))
    _gmail_stale(m, monkeypatch, on="drop", answer=caldav.Outcome("exists", 409))
    out = conform(m, run, "gmail")
    assert out["result"] == "enforced" and "gmail" not in calendar_change.closed_providers(m.ledger)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_stale_removal_taken_keeps_removals_held_even_after_an_override(m, monkeypatch):
    run = start(m)
    seen_both(m, "gmail")
    _gmail_stale(m, monkeypatch, on="drop", answer=None, apply=True)
    out = conform(m, run, "gmail")
    assert out["result"] == "partial" and out["kinds"] == {"edit": "enforced", "remove": "ignored",
                                                           "instance": "enforced"}
    assert "gmail" in calendar_change.closed_providers(m.ledger)
    msg = told(m, "Gmail doesn't protect removals against edits made at the same time.")
    assert len(msg) == 1 and "removals on Gmail stay waiting even then" in msg[0]
    m.tap("Open cards without the check")
    assert "gmail" not in calendar_change.closed_providers(m.ledger)
    assert "Removals on Gmail still wait" in m.seen()[-1]
    seed_haircut(m)
    m.tells("no haircut today", ask(change("gmail", "remove", "Haircut")))
    assert m.ledger.get_meta(f"{calendar_change.HELD}{last_pid(m)}")      # a removal there is still held
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))         # a move goes to a card
    assert not m.ledger.get_meta(f"{calendar_change.HELD}{last_pid(m)}")


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_stale_edit_of_one_day_of_a_series_taken_is_ignored(m, monkeypatch):
    run = start(m)
    seen_both(m, "gmail")
    real = m.gmail.change

    def change_(address, uid, fields, etag):
        if "_" in uid and m.gmail._stale(uid, etag):              # only the instance ignores If-Match
            return real(address, uid, fields, None)
        return real(address, uid, fields, etag)
    monkeypatch.setattr(m.gmail, "change", change_)
    out = conform(m, run, "gmail")
    assert out["kinds"]["edit"] == "enforced" and out["kinds"]["instance"] == "ignored"
    assert out["result"] == "ignored" and "gmail" in calendar_change.closed_providers(m.ledger)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_family_checks_a_removal_and_one_day_of_its_own_series(m):
    run = start(m)
    seen_both(m, "family")
    out = conform(m, run, "family")
    assert out["kinds"] == {"edit": "enforced", "remove": "enforced", "instance": "enforced"}
    sent = [(meth, path, h.get("If-Match")) for meth, path, h, _ in m.icloud.log if meth in ("PUT", "DELETE")]
    own = {x["href"].rsplit("/", 1)[-1] for x in m.cc.created_by(run)}
    assert all(path.rsplit("/", 1)[-1] in own for _, path, _ in sent)         # only its own test events
    assert any(meth == "DELETE" for meth, _, _ in sent)
    assert not [p for p in m.icloud.events if p.rsplit("/", 1)[-1] in own]    # both taken off after


# -- 4. unknown has a defined experience -----------------------------------------------------------------------

def _weak_etags(m):
    """iCloud handing out weak versions and comparing them strongly: a fresh If-Match is refused too."""
    real = m.icloud.request

    def request(method, url, *, headers=None, **kw):
        headers = dict(headers or {})
        if method in ("PUT", "DELETE") and str(headers.get("If-Match", "")).startswith("W/"):
            return HttpResponse(412)
        got = real(method, url, headers=headers, **kw)
        if method == "GET" and got.headers.get("etag"):
            got = HttpResponse(got.status, {**got.headers, "etag": "W/" + got.headers["etag"]}, got.body)
        return got
    m.icloud.request = request
    return real


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_refused_fresh_edit_is_said_as_an_incompatibility_with_test_again_and_no_override(m):
    run = start(m)
    seen_both(m, "family")
    real = _weak_etags(m)
    out = conform(m, run, "family")
    assert out["result"] == "unknown" and out["kinds"]["edit"] == "incompatible"
    assert "don't agree on versions" in out["said"] and "gate-open is refused" in out["said"]
    msg = told(m, "Harness and Family don't agree on event versions.")
    assert len(msg) == 1 and "the fresh edit was answered changed (412)" in msg[0]
    assert "Test again" in m.labels() and "Open cards without the check" not in m.labels()
    refused = m.send(Handover(kind="fastpath", state="gate-open", calendar="family"))
    assert "Not opened" in refused["said"] and "family" in calendar_change.closed_providers(m.ledger)
    assert m.ledger.db.execute("SELECT 1 FROM events WHERE kind='calendar_card_gate_override_refused'").fetchone()
    assert "Not opened" in m.cc.open_gate("family", by="owner tap")
    # Test again once iCloud's versions behave: it passes and the cards open.
    m.icloud.request = real
    m.tap("Test again")
    assert calendar_change.conformance_of(m.ledger, "family") == "enforced"
    assert "family" not in calendar_change.closed_providers(m.ledger)


# -- 5. leftover cleanup can't miss the run's own events -------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_step_add_that_times_out_is_still_listed_and_carries_the_steps_nonce(m, monkeypatch):
    run = start(m)
    real = m.gmail.insert

    def lands_then_times_out(address, event):
        real(address, event)
        return caldav.Outcome("unknown")
    monkeypatch.setattr(m.gmail, "insert", lands_then_times_out)
    step_card(m, run, "gmail-add", "", ask(PIANO))
    m.tap("Approve")
    m.cc.join_abandoned()
    settle(m)
    entry = m.cc.created_by(run)[0]
    assert entry["nonce"] and entry["day"] == "2026-11-11"
    ev = m.gmail.events[entry["id"]]
    assert ev["extendedProperties"]["private"] == {"harness_smoke": run, "harness_smoke_nonce": entry["nonce"]}
    assert [x["title"] for x in m.cc.smoke_leftovers(run)] == ["Smoke test: Piano"]


@pytest.mark.card_only
def test_an_event_not_found_by_its_id_is_found_by_its_exact_nonce_never_by_tag_alone(m):
    run = start(m)
    m.cc._note_created(run, {"cal": "gmail", "id": "cm" + "a" * 32, "nonce": "0123abcd", "day": "2026-11-11"})
    base = {"status": "confirmed", "start": {"dateTime": at(13).isoformat()}, "end": {"dateTime": at(14).isoformat()}}
    m.gmail.events["rewritten1"] = {**base, "id": "rewritten1", "summary": "Smoke test: Piano", "etag": '"1"',
                                    "extendedProperties": {"private": {"harness_smoke": run,
                                                                       "harness_smoke_nonce": "0123abcd"}}}
    m.gmail.events["othertag2"] = {**base, "id": "othertag2", "summary": "Smoke test: Vet", "etag": '"1"',
                                   "extendedProperties": {"private": {"harness_smoke": run}}}
    assert m.cc.smoke_leftovers(run) == [{"cal": "gmail", "id": "rewritten1", "title": "Smoke test: Piano",
                                          "nonce": "0123abcd"}]


# -- 6. held requests are told at hold time ----------------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_held_requests_get_one_message_per_calendar_saying_why_and_what_unblocks(m):
    m.tells("add the dentist at 3 today", ask(DENTIST))
    m.tells("add the vet at 6 today", ask(change("gmail", "add", "Vet", dates="", start=at(18).isoformat(),
                                                 end=at(19).isoformat())))
    msg = told(m, "Calendar changes on Gmail are held for now.")
    assert len(msg) == 1
    assert "the check after installing hasn't finished there yet" in msg[0]
    assert "What lets them through: Cain finishing the check after installing for Gmail" in msg[0]
    m.tells("add piano at 1 today to family", ask(change("family", "add", "Piano", dates="",
                                                         start=at(13).isoformat(), end=at(14).isoformat())))
    assert len(told(m, "Calendar changes on Family are held for now.")) == 1


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_daily_reminder_counts_what_is_still_held_and_a_held_requests_day_gets_one(m):
    m.tells("add the vet tomorrow at 6", ask(change("gmail", "add", "Vet", dates="", start=at(18, day=12).isoformat(),
                                                    end=at(19, day=12).isoformat())))
    m.c.tick()
    assert not told(m, "1 calendar request still held")              # not again the day it was told
    m.clock.t += calendar_change.timedelta(days=1)
    m.c.tick()
    got = told(m, "1 calendar request still held")
    assert len(got) == 1 and "1 for Gmail" in got[0] and "Held, and for today:" in got[0]
    assert "add the vet tomorrow at 6" in got[0] and "dropped with a receipt" in got[0]
    m.c.tick()
    assert len(told(m, "1 calendar request still held")) == 1        # once a day


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_held_move_of_a_past_event_is_offered_again_not_dropped(m):
    seed_haircut(m)
    m.tells("haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    held = last_pid(m)
    m.clock.t += calendar_change.timedelta(days=2)
    m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    m.c.outbox.flush()
    assert not [t for t in m.seen() if t.startswith("Dropped.")]
    assert m.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (held,)).fetchone()[0] == "superseded"
    assert not m.ledger.db.execute("SELECT 1 FROM events WHERE kind='calendar_change_held_dropped'").fetchone()
    assert last_pid(m) != held                                       # a fresh card was made for it


# -- 7. an overridden calendar, and a calendar that stops enforcing ---------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_the_first_refusal_after_an_override_offers_start_again_from_now_which_makes_a_new_card(m, monkeypatch):
    seed_haircut(m)
    m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    _gmail_refuses_every_fence(m, monkeypatch)
    pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    receipt = told(m, "Not applied.")[-1]
    assert "Your request: “haircut moved to 10:30 today”" in receipt
    assert len(told(m, "Edits on Gmail can't be applied safely.")) == 1
    m.tap("Start again from now")
    m.c.outbox.flush()
    assert last_pid(m) != pid and state(m, pid) == "fence_refused"
    assert haircut_at(m) == "10:00"


@pytest.mark.card_only
@pytest.mark.install_gate
def test_the_conformance_item_is_run_again_on_each_install(m):
    run = start(m)
    conform(m, run, "gmail")
    assert calendar_change.conformance_of(m.ledger, "gmail") == "enforced"
    migrate.install(m.ledger, m.cc, build="a-later-build")
    assert calendar_change.conformance_of(m.ledger, "gmail") == ""
    assert "gmail" in calendar_change.closed_providers(m.ledger)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_calendar_that_once_enforced_and_then_takes_a_write_without_a_new_version_closes_again(m, monkeypatch):
    seed_haircut(m)
    run = start(m)
    seen_both(m, "gmail")
    conform(m, run, "gmail")
    assert "gmail" not in calendar_change.closed_providers(m.ledger)
    real = m.gmail.change

    def keeps_its_version(address, uid, fields, etag):
        was = m.gmail.events[uid].get("etag")
        out = real(address, uid, fields, etag)
        m.gmail.events[uid]["etag"] = was
        return out
    monkeypatch.setattr(m.gmail, "change", keeps_its_version)
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    m.c.tick()
    assert "gmail" in calendar_change.closed_providers(m.ledger)
    assert calendar_change.conformance_of(m.ledger, "gmail") == "ignored"
    assert len(told(m, "Gmail doesn't protect against edits made at the same time.")) == 1


# -- 8. CI builds the image and compares its build id -------------------------------------------------------------

def test_ci_builds_the_image_and_compares_its_build_id_with_the_trees():
    wf = (ROOT / ".github" / "workflows" / "tests.yml").read_text()
    assert "\n  image:\n" in wf and "docker build" in wf and "/opt/harness/BUILD_ID" in wf
    assert "harness/app/harness/buildid.py harness harness/app" in wf
    for job in ("pytest", "bun"):
        assert f"\n  {job}:\n" in wf
    docker = (ROOT / "harness" / ".dockerignore")
    assert docker.is_file() and "__pycache__" in docker.read_text()


# -- 9. the docs say it ------------------------------------------------------------------------------------------

def test_the_docs_and_cains_rules_name_the_tenth_round():
    docs = (ROOT / "harness" / "DOCS.md").read_text()
    rules = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "CLAUDE.md").read_text()
    keeper = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "keeper.sh").read_text()
    for words in ("Start step", "--candidate", "migrate-override", "harness-before-", "held for now",
                  "Test again", "a removal and an edit of one day of a series"):
        assert words in docs, words
    for words in ("Start step", "--candidate", "migrate-override", "held for now", "Test again"):
        assert words in rules, words
    for words in ("fastpath smoke-step <run id> <step> <gmail|family> <add|move|remove> <YYYY-MM-DD> <title>",
                  "migrate-check [path] [--candidate <path>]", "fastpath migrate-override"):
        assert words in keeper, words
