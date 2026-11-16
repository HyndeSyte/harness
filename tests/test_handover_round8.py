"""0.24.0, eighth round: what the seventh outside review of the handover fixes asked for (Nov 16).

Each change on its own, against the fake calendars and a fake Discord: a write the calendar is expected to
refuse is never sent (the stale path goes straight to one fresh card, even on a calendar that ignores
If-Match); the fence-refused path only when the read by id gives back the very version that was sent, with
Try again; the install gate holds cards per calendar (no Approve) instead of refusing them, opens on a fenced
edit and a series-day edit read back there, and has a logged override (his tap, or keeper.sh); the install
step is keyed to a build identifier; the one-fresh-card cap ends with Start again from now; a series day
that reads as the whole series gets its own receipt; the auto-revert of a declined add says its outcome on
the same receipt; and the migration dry run on a copy of a ledger. All names and ids invented.
"""
import json

import pytest

from harness import caldav, calendar_change, choices, migrate
from harness.handover import Handover
from harness.ledger import Ledger
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (FAMILY_PATH, GMAIL, TZ, Morning, at, ask, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round4 import DENTIST, dentists
from test_handover_round5 import (DROP_SWIM, HAIRCUT, MOVE_HAIRCUT, SWIM_PATH, haircut_at, seed_haircut, settle,
                                  swim_ics)
from test_handover_round6 import (MOVE_POOL, MOVE_YOGA, POOL_PATH, card_for, correct_haircut, last_pid,
                                  pool_ics, seed_yoga, smoke_step, state, step_card, yoga_at)
from test_handover_round7 import (_declined_add_lands, _gmail_refuses_every_fence, _icloud_refuses_every_fence,
                                  fresh_cards, not_applied)
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def last_card(m):
    m.c.outbox.flush()
    cid = max(m.link.cards)
    return m.link.cards[cid]


def labels_of(card):
    return [c["label"] for r in card["rows"] for c in r["components"]]


# -- 1. a write expected to be refused is never sent ------------------------------------------------------

def _gmail_ignores_if_match(m, monkeypatch):
    """Google as a calendar that takes any write, whatever its If-Match: only the harness can stop a stale one."""
    real_change, real_drop = m.gmail.change, m.gmail.drop
    sent = []

    def change_(address, uid, fields, etag):
        sent.append(("change", etag))
        return real_change(address, uid, fields, None)

    def drop_(address, uid, etag):
        sent.append(("drop", etag))
        return real_drop(address, uid, None)
    monkeypatch.setattr(m.gmail, "change", change_)
    monkeypatch.setattr(m.gmail, "drop", drop_)
    return sent


def _icloud_ignores_if_match(m):
    real = m.icloud.request
    sent = []

    def request(method, url, *, headers=None, **kw):
        if method in ("PUT", "DELETE"):
            sent.append((method, (headers or {}).get("If-Match")))
            headers = {k: v for k, v in (headers or {}).items() if k != "If-Match"}
        return real(method, url, headers=headers, **kw)
    m.icloud.request = request
    return sent


@pytest.mark.card_only
def test_a_known_stale_gmail_move_sends_nothing_even_to_a_calendar_that_ignores_if_match(m, monkeypatch):
    seed_haircut(m)
    sent = _gmail_ignores_if_match(m, monkeypatch)
    pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    correct_haircut(m)                                # 9:30, and a new version, after the card
    m.tap("Approve")
    assert sent == [] and haircut_at(m) == "09:30"    # nothing sent, nothing landed
    assert state(m, pid) == "stale" and len(fresh_cards(m)) == 1
    said = not_applied(m)
    assert len(said) == 1 and "so nothing was sent to the calendar" in said[0]
    plan = json.loads(m.ledger.db.execute("SELECT settle_json FROM calendar_changes WHERE proposal_id=?",
                                          (pid,)).fetchone()[0])
    rec = plan["parts"][0]["steps"][0]
    assert rec["unsent"] is True and rec["if_match"] == "" and not rec.get("fence")   # never attempted


@pytest.mark.card_only
def test_a_known_stale_family_removal_sends_nothing_even_to_a_calendar_that_ignores_if_match(m):
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    pid = card_for(m, "no swim today", ask(DROP_SWIM))
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T200000Z", "20261111T210000Z"))    # moved after the card
    sent = _icloud_ignores_if_match(m)
    m.tap("Approve")
    assert sent == [] and SWIM_PATH in m.icloud.events
    assert state(m, pid) == "stale" and len(fresh_cards(m)) == 1


@pytest.mark.card_only
def test_a_gmail_event_whose_notes_changed_with_the_same_version_is_still_stale_and_not_sent(m, monkeypatch):
    """Any bound field read otherwise counts, even when the calendar kept the version (eighth round)."""
    seed_haircut(m)
    sent = _gmail_ignores_if_match(m, monkeypatch)
    pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.gmail.events[HAIRCUT]["description"] = "Bring the voucher"       # no new etag
    m.tap("Approve")
    assert sent == [] and haircut_at(m) == "10:00" and state(m, pid) == "stale"
    assert "its notes changed since your card" in not_applied(m)[0]


@pytest.mark.card_only
def test_another_days_edit_of_a_family_series_still_writes_with_the_version_just_read(m):
    """A shared resource whose version moved on with every bound field the same is written, guarded by the
    pre-write read's own version."""
    m.icloud.seed(POOL_PATH, pool_ics())
    pid = card_for(m, "pool at 5:30 today", ask(MOVE_POOL))
    m.icloud.seed(POOL_PATH, pool_ics(DESCRIPTION="DESCRIPTION:Bring goggles").replace(
        "RRULE:FREQ=WEEKLY;BYDAY=WE", "RRULE:FREQ=WEEKLY;BYDAY=WE\r\nEXDATE:20261125T220000Z"))
    sent = _icloud_ignores_if_match(m)
    read_etag = m.icloud.events[POOL_PATH][0]
    m.tap("Approve")
    assert sent == [("PUT", read_etag)] and state(m, pid) == "done"


# -- 2. fence-refused only on the very version sent --------------------------------------------------------

@pytest.mark.card_only
def test_try_again_after_a_refused_safety_check_makes_a_new_card_in_a_new_change_family(m, monkeypatch):
    seed_haircut(m)
    real_change, real_drop = m.gmail.change, m.gmail.drop
    _gmail_refuses_every_fence(m, monkeypatch)
    first = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    assert state(m, first) == "fence_refused" and "Try again" in labels_of(last_card(m))
    monkeypatch.setattr(m.gmail, "change", real_change)          # the calendar holds to it now
    monkeypatch.setattr(m.gmail, "drop", real_drop)
    m.tap("Try again")
    new = last_pid(m)
    assert new != first and m.cc.family_root(new) == new != m.cc.family_root(first)
    assert haircut_at(m) == "10:00"                    # a card, never applied by the tap itself
    assert any("you asked to start this again" in t for t in m.seen())
    m.tap("Approve")
    assert haircut_at(m) == "10:30" and m.seen()[-1].startswith("Done.")


@pytest.mark.card_only
def test_a_refusal_whose_read_gives_a_new_version_with_the_same_fields_is_stale_with_one_fresh_card(m, monkeypatch):
    seed_haircut(m)

    def change_(address, uid, fields, etag):
        m.gmail._bump(HAIRCUT)                         # a new version, nothing else, just before ours
        return caldav.Outcome("changed")
    pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    monkeypatch.setattr(m.gmail, "change", change_)
    m.tap("Approve")
    assert state(m, pid) == "stale" and len(fresh_cards(m)) == 1
    assert "Try again" not in m.labels()


# -- 3. the install gate holds, per calendar, with an override ------------------------------------------------

def _gate_seen(m):
    return calendar_change.card_gate(m.ledger).get("seen") or {}


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_request_during_the_gate_is_held_with_no_approve_then_offered_again_once_its_calendar_opens(m):
    seed_haircut(m)
    seed_yoga(m)
    assert calendar_change.closed_providers(m.ledger) == ["gmail", "family"]
    m.tells("add the dentist at 3 today", ask(DENTIST))
    card = last_card(m)
    assert card["text"].startswith("**Waiting for the check after installing on Gmail.**")
    assert "Approve" not in labels_of(card) and not dentists(m)
    held = last_pid(m)
    assert not m.ledger.db.execute("SELECT 1 FROM approvals WHERE proposal_id=?", (held,)).fetchone()
    m.clock.t += calendar_change.timedelta(hours=30)   # a held card doesn't run out
    m.c.tick()
    assert m.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (held,)).fetchone()[0] == "proposed"
    m.clock.t -= calendar_change.timedelta(hours=30)
    # The smoke run: on Gmail a fenced move of an event that was there, then a move of one day of a series,
    # each a step of the run (ninth round), then the conformance item.
    run = m.send(Handover(kind="fastpath", state="smoke-start"))["run"]
    assert run
    step_card(m, run, "gmail-move", "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    assert _gate_seen(m)["gmail"].get("fenced") and not _gate_seen(m)["gmail"].get("series")
    assert "gmail" in calendar_change.closed_providers(m.ledger)
    step_card(m, run, "gmail-series", "yoga at 6:30 today", ask(MOVE_YOGA))
    m.tap("Approve")
    assert yoga_at(m) == "18:30"
    assert "gmail" in calendar_change.closed_providers(m.ledger)              # the conformance item still to come
    smoke_step(m, run, "conformance-gmail")
    assert calendar_change.closed_providers(m.ledger) == ["family"]          # Gmail open, Family still held
    m.c.tick()
    again = last_card(m)
    assert "for the check after installing, which is done on Gmail" in again["text"]
    assert "Approve" in labels_of(again)
    assert m.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (held,)).fetchone()[0] == "superseded"
    m.tap("Approve")
    m.cc.join_abandoned()                              # the run's first add: its answer let go, read back
    settle(m)
    assert m.seen()[-1].startswith("Done.") and "Dentist" in m.seen()[-1]
    assert "Smoke test" not in m.seen()[-1]          # his own request, never the live run's (ninth round)
    # Once the run is over: a Gmail card is a normal card, a Family one is held.
    m.clock.t += calendar_change.timedelta(hours=25)
    m.c.tick()
    card_for(m, "add the vet at 6 today", ask(change("gmail", "add", "Vet", dates="", start=at(18, day=12).isoformat(),
                                                     end=at(19, day=12).isoformat())))
    assert "Approve" in labels_of(last_card(m))
    m.icloud.seed(SWIM_PATH, swim_ics("20261112T210000Z", "20261112T220000Z"))
    m.tells("no swim today", ask(change("family", "remove", "Swim", dates="2026-11-12")))
    family = last_card(m)
    assert family["text"].startswith("**Waiting for the check after installing on Family.**")
    assert "Approve" not in labels_of(family)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_card_from_before_the_install_tapped_during_the_gate_is_held_not_applied(m):
    seed_haircut(m)
    with m.ledger.tx() as db:                          # as if no gate yet: the card is offered normally
        db.execute("DELETE FROM meta WHERE key=?", (calendar_change.CARD_GATE,))
    pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    migrate.install(m.ledger, m.cc, build="a-newer-build")
    m.tap("Approve")
    assert haircut_at(m) == "10:00" and state(m, pid) is None
    card = last_card(m)
    assert card["text"].startswith("**Waiting for the check after installing on Gmail.**")
    assert "Approve" not in labels_of(card)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_refused_safety_check_during_the_run_keeps_that_calendar_held_and_says_so_with_the_override(m):
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    _icloud_refuses_every_fence(m)
    run = m.send(Handover(kind="fastpath", state="smoke-start"))["run"]
    pid = step_card(m, run, "family-remove", "no swim today", ask(DROP_SWIM))
    m.tap("Approve")
    assert state(m, pid) == "fence_refused"
    m.c.outbox.flush()
    told = [t for t in m.seen() if t.startswith("Edits on Family are blocked.")]
    assert len(told) == 1 and "turned down the safety check while the event hadn't changed" in told[0]
    assert "family" in calendar_change.closed_providers(m.ledger)
    assert calendar_change.card_gate(m.ledger)["blocked"].get("family")
    run = calendar_change.smoke_run(m.ledger)["id"]
    refused = m.send(Handover(kind="fastpath", state="on", run=run))
    assert refused["status"] == "refused" and "family.gate: the calendar turned down the safety check" in refused["said"]
    m.tap("Open cards without the check")
    assert "family" not in calendar_change.closed_providers(m.ledger)
    gate = calendar_change.card_gate(m.ledger)
    assert gate["override"]["family"]["by"] == "owner tap"
    logged = m.ledger.db.execute("SELECT detail FROM events WHERE kind='calendar_card_gate_override'").fetchall()
    assert len(logged) == 1 and json.loads(logged[0][0])["by"] == "owner tap"
    assert not calendar_change.fast_path_on(m.ledger)                  # the override opens cards, nothing more


@pytest.mark.card_only
@pytest.mark.install_gate
def test_keeper_gate_open_opens_one_calendar_and_its_held_change_comes_back(m):
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    m.tells("no swim today", ask(DROP_SWIM))
    held = last_pid(m)
    assert "Approve" not in labels_of(last_card(m))
    refused = m.send(Handover(kind="fastpath", state="gate-open"))
    assert refused["status"] == "refused" and calendar_change.closed_providers(m.ledger) == ["gmail", "family"]
    out = m.send(Handover(kind="fastpath", state="gate-open", calendar="family"))
    assert out["status"] == "ok" and "1 waiting change came back on a fresh card" in out["said"]
    assert calendar_change.closed_providers(m.ledger) == ["gmail"]
    assert calendar_change.card_gate(m.ledger)["override"]["family"]["by"] == "cain"
    again = last_card(m)
    assert "Approve" in labels_of(again) and last_pid(m) != held
    m.tap("Approve")
    assert SWIM_PATH not in m.icloud.events
    out = m.send(Handover(kind="fastpath", state="gate-open", calendar="family"))
    assert "aren't waiting for the check" in out["said"]


# -- 4. the install step is keyed to a build ------------------------------------------------------------------

def test_an_install_runs_again_for_another_build_of_the_same_version(m):
    kept = json.loads(m.ledger.get_meta(calendar_change.INSTALLED))
    assert kept["version"] == calendar_change.app_version() and kept["build"] == calendar_change.app_build()
    assert migrate.install(m.ledger, m.cc) == {}
    with m.ledger.tx() as db:                          # the same version, shipped from another build
        m.ledger.set_meta(calendar_change.INSTALLED, json.dumps({**kept, "build": "an-earlier-build"}), db)
    out = migrate.install(m.ledger, m.cc)
    assert out["from"] == out["version"] == calendar_change.app_version()
    assert out["from_build"] == "an-earlier-build" and out["build"] == calendar_change.app_build()
    gate = calendar_change.card_gate(m.ledger)
    assert gate["build"] == calendar_change.app_build() and gate["verified"] == {}
    assert migrate.install(m.ledger, m.cc) == {}       # once per build


@pytest.mark.card_only
def test_a_smoke_run_from_another_build_is_refused(m):
    run = m.send(Handover(kind="fastpath", state="smoke-start"))["run"]
    kept = calendar_change.smoke_run(m.ledger)
    with m.ledger.tx() as db:
        m.ledger.set_meta(calendar_change.SMOKE_RUN, json.dumps({**kept, "build": "an-earlier-build"}), db)
    out = m.send(Handover(kind="fastpath", state="on", run=run))
    assert out["status"] == "refused" and "started under another build" in out["said"]


# -- 5. the cap, a series day that reads as the series, and the declined add's revert -----------------------------

@pytest.mark.card_only
def test_start_again_from_now_after_the_cap_makes_a_new_card_in_a_new_family(m):
    seed_haircut(m)
    first = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))

    def someone_moves(hour):
        m.gmail.events[HAIRCUT].update(start={"dateTime": at(hour).isoformat(), "timeZone": TZ},
                                       end={"dateTime": at(hour, 30).isoformat(), "timeZone": TZ})
        m.gmail._bump(HAIRCUT)
    someone_moves(9)
    m.tap("Approve")
    fresh = last_pid(m)
    someone_moves(8)
    m.tap("Approve")
    last = not_applied(m)[-1]
    assert "its start time and end time changed since your card" in last and "now shows “Haircut” at 8:00" in last
    m.tap("Start again from now")
    new = last_pid(m)
    assert new not in (first, fresh) and m.cc.family_root(new) == new
    assert haircut_at(m) == "08:00"
    m.tap("Approve")
    assert haircut_at(m) == "10:30" and m.seen()[-1].startswith("Done.")


@pytest.mark.card_only
def test_a_gmail_day_that_reads_as_the_whole_series_gets_its_own_receipt(m, monkeypatch):
    seed_yoga(m)
    from test_handover_round6 import yoga_id
    pid = card_for(m, "yoga at 6:30 today", ask(MOVE_YOGA))
    real = m.gmail.look

    def look(address, uid):                            # the day's own read gives back the whole series
        kind, ev = real(address, uid)
        if uid == yoga_id(11) and ev:
            ev.pop("recurringEventId", None)
            ev["recurrence"] = ["RRULE:FREQ=WEEKLY;BYDAY=WE"]
        return kind, ev
    monkeypatch.setattr(m.gmail, "look", look)
    m.tap("Approve")
    assert state(m, pid) == "whole_series" and yoga_at(m) == "18:00"
    assert not [e for e in m.gmail.log if e[0] == "change"]
    said = not_applied(m)[-1]
    assert "The calendar returned the whole series for that day, not the one day, so nothing was changed." in said
    assert "say to Cain whether you mean only that day or the whole series" in said


def test_a_declined_add_whose_revert_is_turned_down_says_so_on_the_same_receipt_with_undo(m, monkeypatch):
    def refuse(address, uid, etag):
        return caldav.Outcome("failed", 500)
    real = m.gmail.drop
    monkeypatch.setattr(m.gmail, "drop", refuse)
    first, newer = _declined_add_lands(m, monkeypatch)
    said = [t for t in m.seen() if t.startswith("Applied despite your Decline")]
    assert len(said) == 1 and "the calendar turned that down, so it's still there" in said[0]
    assert len(dentists(m)) == 1 and "Undo" in labels_of(last_card(m))
    row = m.ledger.db.execute("SELECT undo_state FROM calendar_changes WHERE proposal_id=?", (first,)).fetchone()
    assert row[0] == "open"
    monkeypatch.setattr(m.gmail, "drop", real)
    m.tap("Undo")
    m.c.tick()
    assert not dentists(m)


def test_a_declined_add_whose_revert_answer_is_lost_says_its_still_being_read(m, monkeypatch):
    def lost(address, uid, etag):
        return caldav.Outcome("unknown")
    monkeypatch.setattr(m.gmail, "drop", lost)
    first, newer = _declined_add_lands(m, monkeypatch)
    said = [t for t in m.seen() if t.startswith("Applied despite your Decline")]
    assert len(said) == 1 and "whether it's off isn't known yet. I'm reading it, and the outcome follows" in said[0]
    row = m.ledger.db.execute("SELECT undo_state FROM calendar_changes WHERE proposal_id=?", (first,)).fetchone()
    assert row[0] in ("requested", "settling", "undoing", "undone", "open")


# -- 6. the migration dry run on a copy of a ledger ----------------------------------------------------------------

def _old_ledger(path, clock):
    """A ledger as a version before left it: the no-card paths on, a Turn on card still open, and an install
    recorded for another version."""
    led = Ledger(str(path), clock=clock)
    with led.tx() as db:
        calendar_change.set_fast_path(led, True, {"run": "abc123"}, by="test", db=db)
        led.set_meta(calendar_change.INSTALLED, json.dumps({"version": "0.23.0", "build": "old", "at": "x"}), db)
        db.execute("DELETE FROM meta WHERE key=?", (calendar_change.CARD_GATE,))
        choices.mint(led, kind="calendar_change_fast_on", target="offer1", chat_id=OWNER, ttl_s=3600, db=db)
    led.db.close()


@pytest.mark.install_gate
def test_the_migration_dry_run_works_on_a_copy_and_never_touches_the_ledger(tmp_path, clock):
    path = tmp_path / "live.sqlite"
    _old_ledger(path, clock)
    got = migrate.dry_run(str(path))
    assert got["ok"] is True and got["schema"] == migrate.HANDOVER
    assert got["fast_path_on"] is False and got["gate_set"] is True and got["gate_closed"] == ["gmail", "family"]
    assert got["open_turn_on_cards"] == 0 and got["rows_touched"] > 0
    assert got["install"]["fast_path_off"] is True and got["install"]["cards_retired"] == 1
    led = Ledger(str(path), clock=clock)             # the file itself, as it was
    assert calendar_change.fast_path(led).get("on") is True
    assert json.loads(led.get_meta(calendar_change.INSTALLED))["version"] == "0.23.0"
    assert not led.get_meta(calendar_change.CARD_GATE)
    assert led.db.execute("SELECT COUNT(*) FROM choices WHERE kind='calendar_change_fast_on' AND consumed_at IS NULL"
                          ).fetchone()[0] == 1
    assert not list(tmp_path.glob("**/ledger-copy*"))
    assert migrate.dry_run(str(tmp_path / "missing.sqlite"))["ok"] is False


def test_keeper_migrate_check_runs_the_dry_run_on_the_path_it_names(m, tmp_path, clock):
    path = tmp_path / "copy-of-live.sqlite"
    _old_ledger(path, clock)
    out = m.send(Handover(kind="fastpath", state="migrate-check", path=str(path)))
    assert out["status"] == "ok" and "the ledger itself wasn't touched" in out["said"]
    assert out["result"]["open_turn_on_cards"] == 0 and out["result"]["fast_path_on"] is False
    live = m.send(Handover(kind="fastpath", state="migrate-check"))          # the live ledger, copied
    assert live["status"] == "ok" and live["result"]["copy_of"] == m.ledger.path


# -- 7. the docs say it -----------------------------------------------------------------------------------------------

def test_the_docs_and_cains_rules_name_the_eighth_round():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    docs = (root / "harness" / "DOCS.md").read_text()
    rules = (root / "cain" / "rootfs" / "opt" / "cain" / "CLAUDE.md").read_text()
    for words in ("Open cards without the check", "keeper.sh fastpath gate-open", "keeper.sh fastpath migrate-check",
                  "Try again", "Start again from now"):
        assert words in docs, words
        assert words in rules, words
