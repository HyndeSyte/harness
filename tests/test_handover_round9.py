"""0.24.0, ninth round: what the eighth outside review of the handover fixes asked for (Nov 16).

Each change on its own, against the fake calendars and a fake Discord: the smoke run owns only the requests
a step of it took (keeper.sh fastpath smoke-step, then a handover naming the run), so a real request during a
live run is held like any other and never tagged or swept; the conformance item proves each calendar refuses
a stale write (the run's own test event only) before its gate opens; a calendar opened without the check
that refuses an unchanged event gets no more Try again; the card binds what a read by id gives, the shape the
pre-write compare reads; held requests come back saying how long they waited, a past one is dropped with a
receipt, and many come with a summary first; the migration dry run is kept in the ledger by build; and the
build id covers every shipped file. All names and ids invented.
"""
import json
import pathlib
import shutil

import pytest

from harness import buildid, caldav, calendar_change, migrate
from harness.calendar_change import _print, _print_same
from harness.handover import Handover
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (FAMILY_PATH, GMAIL, TZ, Morning, at, ask, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round4 import DENTIST, dentists
from test_handover_round5 import HAIRCUT, MOVE_HAIRCUT, haircut_at, seed_haircut, settle
from test_handover_round6 import card_for, last_pid, smoke_step, state, step_card
from test_handover_round7 import _gmail_refuses_every_fence
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]
PIANO = change("gmail", "add", "Piano", dates="", start=at(13).isoformat(), end=at(14).isoformat())


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def last_card(m):
    m.c.outbox.flush()
    return m.link.cards[max(m.link.cards)]


def labels_of(card):
    return [c["label"] for r in card["rows"] for c in r["components"]]


def start(m):
    out = m.send(Handover(kind="fastpath", state="smoke-start"))
    assert out["status"] == "ok" and "smoke-step" in out["said"] and "--smoke" in out["said"]
    return out["run"]


def live_gmail(m, title):
    return [e for e in m.gmail.events.values() if e.get("summary") == title and e.get("status") != "cancelled"]


# -- 1. the smoke run owns only its own items --------------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_real_add_during_a_live_run_is_held_untagged_survives_the_cleanup_and_comes_back(m):
    run = start(m)
    m.tells("add the dentist at 3 today", ask(DENTIST))             # his own request, while the run is live
    held = last_card(m)
    assert held["text"].startswith("**Waiting for the check after installing on Gmail.**")
    assert "Approve" not in labels_of(held)
    # A step of the run: its add is tagged and let go at once, as the run's.
    step_card(m, run, "gmail-add", "add piano at 1 today", ask(PIANO))
    assert "Approve" in labels_of(last_card(m))
    m.tap("Approve")
    m.cc.join_abandoned()
    settle(m)
    piano = live_gmail(m, "Smoke test: Piano")
    assert piano and piano[0]["extendedProperties"]["private"]["harness_smoke"] == run
    assert not dentists(m)                                          # still held
    # The gate opens on Gmail: his request comes back on a fresh card, his title untouched.
    m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    again = last_card(m)
    assert "Approve" in labels_of(again) and "for the check after installing" in again["text"]
    m.tap("Approve")
    m.c.tick()
    got = dentists(m)
    assert len(got) == 1 and "extendedProperties" not in got[0]
    assert not live_gmail(m, "Smoke test: Dentist")
    # The leftover cleanup lists and takes off only what the run itself created, by id.
    assert [x["title"] for x in m.cc.smoke_leftovers(run)] == ["Smoke test: Piano"]
    m.cc.post_leftovers(run, "the test is over")
    m.c.outbox.flush()
    m.tap("Take them off")
    assert not live_gmail(m, "Smoke test: Piano") and len(dentists(m)) == 1


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_request_during_a_live_run_is_never_the_runs_even_when_its_calendar_is_open(m):
    """Precedence: an open gate lets it through as an ordinary card, never tagged, never let go."""
    run = start(m)
    m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    card_for(m, "add the dentist at 3 today", ask(DENTIST))
    m.tap("Approve")
    m.c.tick()
    assert len(dentists(m)) == 1 and not m.cc.created_by(run)
    plan = json.loads(m.ledger.db.execute("SELECT settle_json FROM calendar_changes ORDER BY rowid DESC").fetchone()[0])
    assert "smoke" not in plan


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_handover_naming_the_run_needs_an_open_step_and_takes_it_once(m):
    run = start(m)
    out = m.tells("add the dentist at 3 today", ask(DENTIST), smoke_run=run)
    assert out["status"] == "refused" and "no smoke step is open" in out["said"]
    smoke_step(m, run, "gmail-add")
    assert m.tells("add piano at 1 today", ask(PIANO), smoke_run=run)["status"] == "waiting for his tap"
    assert m.cc.owned_run(m.ledger.db.execute("SELECT job_id FROM proposals WHERE id=?",
                                              (last_pid(m),)).fetchone()[0]) == run
    again = m.tells("add the vet at 6 today", ask(change("gmail", "add", "Vet", dates="", start=at(18).isoformat(),
                                                         end=at(19).isoformat())), smoke_run=run)
    assert again["status"] == "refused"                           # the step was single use
    bad = m.send(Handover(kind="fastpath", state="smoke-step", run="0123456789ab", step="gmail-add"))
    assert bad["status"] == "refused" and "no smoke run with that id" in bad["said"].lower()


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_step_runs_out_after_thirty_minutes(m):
    run = start(m)
    smoke_step(m, run, "gmail-add")
    m.clock.t += calendar_change.timedelta(minutes=31)
    out = m.tells("add piano at 1 today", ask(PIANO), smoke_run=run)
    assert out["status"] == "refused" and "no smoke step is open" in out["said"]


def test_held_by_gate_holds_every_request_but_the_runs_own(m, monkeypatch):
    monkeypatch.setattr(calendar_change, "closed_providers", lambda ledger: ["gmail"])
    monkeypatch.setattr(m.cc, "live_run", lambda: {"id": "abc123"})
    params = {"changes": [DENTIST]}
    assert m.cc.held_by_gate(params, None, job_id="job-not-owned") == ["gmail"]
    with m.ledger.tx() as db:
        m.ledger.set_meta(calendar_change.SMOKE_OWN + "job-owned", json.dumps({"run": "abc123", "step": "x"}), db)
    assert m.cc.held_by_gate(params, None, job_id="job-owned") == []


# -- 2. the conformance item ---------------------------------------------------------------------------------

def _gmail_takes_any_if_match(m, monkeypatch):
    real = m.gmail.change
    sent = []

    def change_(address, uid, fields, etag):
        sent.append(uid)
        return real(address, uid, fields, None)
    monkeypatch.setattr(m.gmail, "change", change_)
    return sent


def _icloud_takes_any_if_match(m):
    real = m.icloud.request
    sent = []

    def request(method, url, *, headers=None, **kw):
        if method == "PUT" and "If-Match" in (headers or {}):
            sent.append(url)
            headers = {k: v for k, v in headers.items() if k != "If-Match"}
        return real(method, url, headers=headers, **kw)
    m.icloud.request = request
    return sent


@pytest.mark.card_only
@pytest.mark.install_gate
@pytest.mark.parametrize("calendar", ["gmail", "family"])
def test_a_calendar_that_enforces_if_match_passes_the_conformance_item(m, calendar):
    run = start(m)
    out = m.send(Handover(kind="fastpath", state="smoke-step", run=run, step=f"conformance-{calendar}"))
    assert out["status"] == "ok" and out["result"] == "enforced"
    assert calendar_change.conformance_of(m.ledger, calendar) == "enforced"
    created = m.cc.created_by(run)
    assert len(created) == 1 and created[0]["cal"] == calendar
    assert not m.cc.smoke_leftovers(run)                         # its test event is taken off after
    gate = calendar_change.card_gate(m.ledger)
    assert calendar in calendar_change.closed_providers(m.ledger)   # the fenced and series-day edits still to come
    with m.ledger.tx() as db:                                    # as if both had read back there
        gate["seen"][calendar] = {"fenced": "x", "series": "x"}
        m.ledger.set_meta(calendar_change.CARD_GATE, json.dumps(gate), db)
    m.send(Handover(kind="fastpath", state="smoke-step", run=run, step=f"conformance-{calendar}"))
    assert calendar not in calendar_change.closed_providers(m.ledger)
    items, _, _ = m.cc.smoke_evidence(run)
    assert f"{calendar}.conformance" in [i["item"] for i in items]


@pytest.mark.card_only
@pytest.mark.install_gate
@pytest.mark.parametrize("calendar", ["gmail", "family"])
def test_a_calendar_that_ignores_if_match_never_opens_and_he_is_told(m, monkeypatch, calendar):
    seed_haircut(m)
    run = start(m)
    sent = _gmail_takes_any_if_match(m, monkeypatch) if calendar == "gmail" else _icloud_takes_any_if_match(m)
    gate = calendar_change.card_gate(m.ledger)
    with m.ledger.tx() as db:                                    # the other two edits already read back
        gate["seen"][calendar] = {"fenced": "x", "series": "x"}
        m.ledger.set_meta(calendar_change.CARD_GATE, json.dumps(gate), db)
    out = m.send(Handover(kind="fastpath", state="smoke-step", run=run, step=f"conformance-{calendar}"))
    assert out["status"] == "refused" and out["result"] == "ignored"
    assert "doesn't protect against concurrent edits" in out["said"]
    assert calendar in calendar_change.closed_providers(m.ledger)
    # Only the run's own test event was written with the stale version, never one of his.
    own = m.cc.created_by(run)[0]
    assert sent and all((own.get("id") or own.get("href")) in str(x) for x in sent)
    assert HAIRCUT not in " ".join(map(str, sent)) and haircut_at(m) == "10:00"
    name = "Gmail" if calendar == "gmail" else "Family"
    told = [t for t in m.seen() if t.startswith(f"{name} doesn't protect against edits made at the same time.")]
    assert len(told) == 1 and "may then overwrite changes made elsewhere" in told[0]
    _, missing, _ = m.cc.smoke_evidence(run)
    assert any(x.startswith(f"{calendar}.conformance: the calendar accepted a write sent with an out of date version")
               for x in missing)
    m.tap("Open cards without the check")
    assert calendar not in calendar_change.closed_providers(m.ledger)
    said = m.seen()[-1]
    assert "edits there may overwrite changes made elsewhere" in said


@pytest.mark.card_only
@pytest.mark.install_gate
def test_keeper_gate_open_on_a_calendar_that_ignores_if_match_says_what_it_risks(m, monkeypatch):
    run = start(m)
    _gmail_takes_any_if_match(m, monkeypatch)
    m.send(Handover(kind="fastpath", state="smoke-step", run=run, step="conformance-gmail"))
    out = m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    assert "edits there may overwrite changes made elsewhere" in out["said"]


# -- 3. refusals on unchanged events after an override ------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_after_an_override_a_refused_safety_check_offers_no_try_again_and_says_why_once(m, monkeypatch):
    seed_haircut(m)
    m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    _gmail_refuses_every_fence(m, monkeypatch)
    first = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    assert state(m, first) == "fence_refused"
    receipts = [t for t in m.seen() if t.startswith("Not applied.")]
    assert "Edits on Gmail can't be applied safely" in receipts[-1] and "Try again" not in m.labels()
    told = [t for t in m.seen() if t.startswith("Edits on Gmail can't be applied safely.")]
    assert len(told) == 1 and "weak or rewritten version (etag)" in told[0]
    second = card_for(m, "haircut moved to 10:45 today", ask(change("gmail", "move", "Haircut",
                                                                    start=at(10, 45).isoformat(),
                                                                    end=at(11, 15).isoformat())))
    m.tap("Approve")
    assert state(m, second) == "fence_refused" and "Try again" not in m.labels()
    assert len([t for t in m.seen() if t.startswith("Edits on Gmail can't be applied safely.")]) == 1
    assert calendar_change.card_gate(m.ledger)["override_refused"]["gmail"] == 2
    assert haircut_at(m) == "10:00"


@pytest.mark.card_only
def test_without_an_override_try_again_is_still_offered(m, monkeypatch):
    seed_haircut(m)
    _gmail_refuses_every_fence(m, monkeypatch)
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    assert "Try again" in m.labels()


# -- 4. the card binds what the pre-write compare reads -----------------------------------------------------------

@pytest.mark.card_only
def test_a_listing_and_a_read_by_id_that_differ_harmlessly_still_apply(m, monkeypatch):
    seed_haircut(m)
    m.gmail.events[HAIRCUT].update(location="Main  St", description="Bring cash")
    real = m.gmail.look

    def look(address, uid):                         # a read by id: defaults spelled out, spacing evened
        kind, ev = real(address, uid)
        if uid == HAIRCUT and ev:
            ev = dict(ev, location=" Main St ", description="Bring cash\r\n", transparency="opaque",
                      reminders={"useDefault": True}, attendees=[])
        return kind, ev
    monkeypatch.setattr(m.gmail, "look", look)
    pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    assert haircut_at(m) == "10:30" and state(m, pid) == "done"


def test_the_print_is_one_shape_whichever_read_gave_it():
    from datetime import datetime, timezone, timedelta
    t = datetime(2026, 11, 11, 15, tzinfo=timezone.utc)
    a = _print(" Haircut ", t, t + timedelta(minutes=30), ["EXDATE:1", "RRULE:FREQ=WEEKLY"], "Main  St", "x\r\n",
               [("B@example.com", "accepted"), ("a@example.com", "")], "", "")
    b = _print("Haircut", t.astimezone(timezone(timedelta(hours=-5))), t + timedelta(minutes=30),
               ["RRULE:FREQ=WEEKLY", "EXDATE:1"], "Main St", "x", [("a@example.com", "needsAction"),
                                                                   ("b@example.com", "ACCEPTED")], "", "opaque")
    assert a == b and _print_same(a, b)
    assert _print_same(dict(b, extra="field"), a)                 # only the fields the card bound are compared
    assert not _print_same(dict(b, title="other"), a)


# -- 5. held requests come back with how long they waited ---------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_held_request_comes_back_saying_how_long_it_waited_and_quoting_his_message(m):
    m.tells("add the dentist at 3 today", ask(DENTIST))
    m.clock.t += calendar_change.timedelta(hours=3)
    m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    card = last_card(m)
    assert "it waited 3 hours for the check after installing" in card["text"]
    assert "add the dentist at 3 today" in card["text"] and "Approve" in labels_of(card)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_held_request_whose_day_has_passed_is_dropped_with_a_receipt(m):
    m.tells("add the dentist at 3 today", ask(DENTIST))
    held = last_pid(m)
    m.clock.t += calendar_change.timedelta(days=2)
    cards = len(m.link.cards)
    m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    m.c.outbox.flush()
    new = [m.link.cards[c] for c in sorted(m.link.cards)[cards:]]
    assert len(new) == 1 and "Approve" not in labels_of(new[0])
    said = m.seen()[-1]
    assert said.startswith("Dropped.") and "its day has passed" in said and "waited 2 days" in said
    assert m.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (held,)).fetchone()[0] == "superseded"
    assert not dentists(m)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_more_than_three_held_requests_come_back_after_one_summary(m):
    for i, title in enumerate(("Dentist", "Vet", "Cat", "Piano")):
        m.tells(f"add the {title.lower()} today", ask(change("gmail", "add", title, dates="",
                                                             start=at(15 + i).isoformat(), end=at(16 + i).isoformat())))
    cards = len(m.link.cards)
    out = m.send(Handover(kind="fastpath", state="gate-open", calendar="gmail"))
    assert "4 waiting changes came back" in out["said"]
    m.c.outbox.flush()
    new = [m.link.cards[c] for c in sorted(m.link.cards)[cards:]]
    assert new[0]["text"].startswith("**4 changes waited for the check after installing**")
    assert [("Approve" in labels_of(c)) for c in new[1:]] == [True] * 4


# -- 6. the migration dry run is kept by build ---------------------------------------------------------------------

def test_migrate_check_is_kept_in_the_live_ledger_by_build_and_the_install_logs_it(m, caplog):
    out = m.send(Handover(kind="fastpath", state="migrate-check"))
    assert out["status"] == "ok"
    kept = out["result"]["recorded"]
    assert kept["build"] == calendar_change.app_build() and kept["ok"] is True and len(kept["checksum"]) == 64
    assert migrate.dry_run_for(m.ledger, calendar_change.app_build())["checksum"] == kept["checksum"]
    installed = json.loads(m.ledger.get_meta(calendar_change.INSTALLED))
    with m.ledger.tx() as db:
        m.ledger.set_meta(calendar_change.INSTALLED, json.dumps({**installed, "build": "an-earlier-build"}), db)
    caplog.set_level("INFO")
    got = migrate.install(m.ledger, m.cc)
    assert got["dry_run"] is True and got["dry_run_checksum"] == kept["checksum"]
    assert "a migration dry run was recorded for build" in caplog.text


def test_an_install_with_no_dry_run_for_its_build_says_so(m, caplog):
    caplog.set_level("INFO")
    got = migrate.install(m.ledger, m.cc, build="a-build-never-checked")
    assert got["dry_run"] is False
    assert "no migration dry run was recorded" in caplog.text


# -- 7. the build id covers every shipped file ----------------------------------------------------------------------

def test_the_build_id_covers_the_dockerfile_config_and_run_scripts(tmp_path):
    addon = tmp_path / "harness"
    shutil.copytree(ROOT / "harness", addon, ignore=shutil.ignore_patterns("__pycache__"))
    first = buildid.compute(addon, addon / "app")
    assert first == buildid.compute(ROOT / "harness", ROOT / "harness" / "app")
    for rel in ("rootfs/etc/services.d/harness/run", "Dockerfile", "config.yaml", "app/harness/render.py"):
        f = addon / rel
        was = f.read_text()
        f.write_text(was + "\n# changed\n")
        assert buildid.compute(addon, addon / "app") != first, rel
        f.write_text(was)
    assert buildid.compute(addon, addon / "app") == first
    (addon / "CHANGELOG.md").write_text("not shipped in the image")
    assert buildid.compute(addon, addon / "app") == first


def test_the_image_keeps_the_build_id_from_every_shipped_file():
    docker = (ROOT / "harness" / "Dockerfile").read_text()
    assert "COPY Dockerfile config.yaml /tmp/harness-build/" in docker
    assert "buildid.py /tmp/harness-build /opt/harness > /opt/harness/BUILD_ID" in docker


# -- 8. the docs say it ------------------------------------------------------------------------------------------------

def test_the_docs_and_cains_rules_name_the_ninth_round():
    docs = (ROOT / "harness" / "DOCS.md").read_text()
    rules = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "CLAUDE.md").read_text()
    keeper = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "keeper.sh").read_text()
    for words in ("keeper.sh fastpath smoke-step", "--smoke", "conformance-gmail", "conformance-family",
                  "a closed gate holds every request", "harness-migrate-check.json"):
        assert words in docs, words
        assert words in rules, words
    for words in ("fastpath smoke-step <run id> <step>", "--smoke <run id>", "harness-migrate-check.json"):
        assert words in keeper, words
