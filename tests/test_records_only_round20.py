"""0.24.0, twentieth round, item 10: every records-only choice kind, given a well-formed target, reaches its own records path and makes no calendar call. All names and ids invented."""
import json
import pathlib
import sqlite3
from datetime import datetime, timedelta

import pytest

from harness import calendar_change, choices, commands, family_add, meaning_live, migrate, rules
from harness.controller import Controller
from harness.handover import Handover
from harness.ledger import iso
from fakes import result
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (NY, TZ, ask, at, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round16_taps import dentist_card, dentists, m, restart_after_restore  # noqa: F401
from test_handover_round17_taps import FAMILY_DINNER, card_labels, landed_then_crashed, new_cards  # noqa: F401
from test_handover_round19_taps import calendar_writes
from fake_caldav import no_network  # noqa: F401  (autouse)

OWNER_ID = 1                                    # the Morning rig's owner_user_id
GMAIL_READS = ("events_between", "look", "really_gone", "gone_how", "list_ours", "read_back", "account")
RULE = {"rule_type": "drafting", "scope": "draft", "field": "length", "value": "short", "literal": "keep it short"}
BOOK_CLUB = {"title": "Book club", "start": "2026-11-12T15:00:00-05:00", "end": "2026-11-12T16:00:00-05:00",
             "location": ""}


# -- helpers -----------------------------------------------------------------------------------------------------------

def minted(m, kind, ending=""):
    """The target the minting code stored for this kind: the newest live choice of it."""
    rows = m.ledger.db.execute("SELECT target FROM choices WHERE kind=? AND consumed_at IS NULL ORDER BY rowid DESC",
                               (kind,)).fetchall()
    got = [r[0] for r in rows if r[0].endswith(ending)]
    assert got, f"nothing minted for {kind}"
    return got[0]


def count_reads(m, monkeypatch):
    """Every read the fake Gmail takes, counted (its writes are in m.gmail.log already)."""
    n = {"gmail": 0}
    for name in GMAIL_READS:
        real = getattr(m.gmail, name, None)
        if real is None:
            continue

        def wrap(*a, _real=real, **k):
            n["gmail"] += 1
            return _real(*a, **k)
        monkeypatch.setattr(m.gmail, name, wrap)
    return n


def calendar_reads(m, n):
    return n["gmail"], len([x for x in m.icloud.log if x[0] not in ("PUT", "DELETE")])


def event_count(m, kind):
    return m.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind=?", (kind,)).fetchone()[0]


def rule_state(m, rid):
    return m.ledger.db.execute("SELECT state FROM rules WHERE id=?", (rid,)).fetchone()[0]


# -- what each kind needs in the records, minted by its own code -------------------------------------------------------

SETUPS = {}


def setup(kind, *, reads="", marks=()):
    """`reads`: why this kind legitimately reads a calendar ("" means it must not read one at all)."""
    def deco(fn):
        SETUPS[kind] = {"fn": fn, "reads": reads, "marks": tuple(marks)}
        return fn
    return deco


def pending_rule(m):
    with m.ledger.tx() as db:
        rid = rules.hold(m.ledger, dict(RULE), job_id=None, db=db)
        rules.card_buttons(m.ledger, rid, OWNER_ID, db)               # mints rule_approve and rule_decline
    return rid


@setup("rule_approve")
def _rule_approve(m, mp):
    rid = pending_rule(m)
    target = minted(m, "rule_approve")
    assert target == rid

    def check(said):
        assert said == ""                                             # its card's own reply is queued instead
        assert rule_state(m, rid) == "active"
        assert minted(m, "rule_undo") == rid                          # and an Undo for it
    return target, check


@setup("rule_decline")
def _rule_decline(m, mp):
    rid = pending_rule(m)
    target = minted(m, "rule_decline")

    def check(said):
        assert said == "Dropped. That rule isn't used."
        assert rule_state(m, rid) == "retired" and event_count(m, "rule_declined") == 1
    return target, check


@setup("rule_undo")
def _rule_undo(m, mp):
    rid = pending_rule(m)
    assert m.c.callbacks._keep_rule(rid) == ""                         # mints rule_undo
    target = minted(m, "rule_undo")

    def check(said):
        assert said.startswith("Undone.") and f"({rid} retired)" in said
        assert rule_state(m, rid) == "retired"
    return target, check


def quarantined_rule(m):
    old = rules.propose(m.ledger, {**RULE, "scope": "all", "value": "long", "literal": "make it long"},
                        job_id=None).rule_id
    rid = pending_rule(m)
    assert m.c.callbacks._keep_rule(rid) == ""                         # clashes: mints rule_keep_new/_old
    assert rule_state(m, rid) == "quarantined"
    return old, rid


@setup("rule_keep_new")
def _rule_keep_new(m, mp):
    old, rid = quarantined_rule(m)
    target = minted(m, "rule_keep_new")
    assert target == rid

    def check(said):
        assert said == "Switched to the new rule."
        assert rule_state(m, rid) == "active" and rule_state(m, old) == "superseded"
    return target, check


@setup("rule_keep_old")
def _rule_keep_old(m, mp):
    old, rid = quarantined_rule(m)
    target = minted(m, "rule_keep_old")

    def check(said):
        assert said == "Kept the existing rule."
        assert rule_state(m, rid) == "retired" and rule_state(m, old) == "active"
    return target, check


NEW_KEY = "sk-" + "q" * 32


def settings_card(m):
    m.vault.request_change("openai_api_key", NEW_KEY, by="Page user")
    m.c._announce_settings()                                           # mints settings_approve/_decline
    return m.vault.pending()["id"]


@setup("settings_approve")
def _settings_approve(m, mp):
    cid = settings_card(m)
    target = minted(m, "settings_approve")
    assert target == cid

    def check(said):
        assert said.startswith("Done. The OpenAI API key was replaced.")
        assert m.vault.get("openai_api_key") == NEW_KEY and m.vault.pending() is None
    return target, check


@setup("settings_decline")
def _settings_decline(m, mp):
    cid = settings_card(m)
    target = minted(m, "settings_decline")
    assert target == cid

    def check(said):
        assert said.startswith("Declined.")
        assert m.vault.get("openai_api_key") != NEW_KEY and m.vault.pending() is None
    return target, check


def failing_dry_run(mp):
    real = migrate.dry_run

    def fails(path, version=None, build=None, **kw):
        return {**real(path, version, build, **kw), "ok": False, "said": "the rehearsal stopped on a test card"}
    mp.setattr(migrate, "dry_run", fails)
    return real


def waiting_migration(m, mp):
    """The live ledger waiting for a rehearsal of this build (tenth round), its Run check card posted."""
    real = failing_dry_run(mp)
    mp.setattr(calendar_change, "app_build", lambda: "b-twenty")
    migrate.run_live(m.ledger, m.cc, OWNER_ID)
    assert migrate.waiting(m.ledger)
    return real


@setup("migration_check", marks=(pytest.mark.migrate_gate,))
def _migration_check(m, mp):
    real = waiting_migration(m, mp)
    target = minted(m, "migration_check")
    mp.setattr(migrate, "dry_run", real)                               # the rehearsal passes this time

    def check(said):
        assert "passed" in said and not migrate.waiting(m.ledger)
        assert json.loads(m.ledger.get_meta(calendar_change.INSTALLED))["build"] == "b-twenty"
    return target, check


@setup("migration_override", marks=(pytest.mark.migrate_gate,))
def _migration_override(m, mp):
    waiting_migration(m, mp)
    assert migrate.request_override(m.ledger, OWNER_ID, by="cain")[0] == "ok"
    target = minted(m, "migration_override")
    assert target == "b-twenty failed"

    def check(said):
        assert said.startswith("Moved without a rehearsal") and not migrate.waiting(m.ledger)
        assert event_count(m, "migration_override") == 1
    return target, check


@setup("migration_restore", marks=(pytest.mark.migrate_gate,))
def _migration_restore(m, mp):
    migrate.run_live(m.ledger, m.cc, OWNER_ID, version="0.24.0", build="b-backup")     # a backup taken first
    newest = migrate.backups(m.ledger)[-1]
    key = f"{newest.get('schema')} {newest.get('build')}"
    assert migrate.request_restore(m.ledger, OWNER_ID, key, by="cain")[0] == "ok"
    target = minted(m, "migration_restore")
    assert target == key
    staged = pathlib.Path(m.ledger.path + migrate.RESTORE_SUFFIX)

    def check(said):
        try:
            assert said.startswith("Ready: restart Harness now") and staged.exists()
            assert event_count(m, "migration_restore_staged") == 1
        finally:
            if m.ledger.fenced:
                m.ledger.unfence()
            for p in (staged, pathlib.Path(str(staged) + ".json")):
                if p.exists():
                    p.unlink()
    return target, check


@setup("migration_clock")
def _migration_clock(m, mp):
    with m.ledger.tx() as db:                                          # a record stamped after the clock
        m.ledger.event("test_from_later", {}, db=db)
        db.execute("UPDATE events SET at=? WHERE id=(SELECT MAX(id) FROM events)",
                   (iso(m.clock() + timedelta(days=2)),))
    assert migrate.post_clock_card(m.ledger, OWNER_ID, force=True)     # mints migration_clock
    target = minted(m, "migration_clock")
    assert target == str(migrate.clock_stall(m.ledger)["event"])

    def check(said):
        assert said.startswith("Done: Harness takes the clock as it is now.")
        assert m.ledger.get_meta(migrate.CLOCK_ACCEPTED) and event_count(m, "migration_clock_accepted") == 1
    return target, check


def with_meanings(m):
    """The Morning rig has no meaning specialist; one is attached the way the meaning tests attach it."""
    from test_family_copy import Feeds
    from test_meaning_live import Shadow
    live = meaning_live.MeaningLive(m.ledger, Shadow(), Feeds(), tz=TZ, on_fn=lambda: True)
    m.c.meaning_live = live
    m.c.callbacks.meaning_live = live
    live.bind(OWNER_ID)
    return live


@setup("meaning_answer")
def _meaning_answer(m, mp):
    from test_meaning_live import item, judge, rel
    live = with_meanings(m)
    d = m.clock().astimezone(NY).date() + timedelta(days=1)
    it = item("Garden club", datetime(d.year, d.month, d.day, 9, tzinfo=NY))
    live.shadow.items.append(it)
    judge(m.ledger, it, rel("supervision"))
    live.tick(paused=False)                                            # asks: mints meaning_answer per button
    (q,) = m.ledger.db.execute("SELECT * FROM meaning_questions WHERE state='open'").fetchall()
    target = minted(m, "meaning_answer", ending=":yes")
    assert target == f"{q['id']}:yes"

    def check(said):
        assert said.startswith("Thanks. I'll put ") and said.endswith(" on your calendar as yours.")
        row = m.ledger.db.execute("SELECT state, answer FROM meaning_questions WHERE id=?", (q["id"],)).fetchone()
        assert (row["state"], row["answer"]) == ("answered", "yes")
    return target, check


@setup("meaning_undo")
def _meaning_undo(m, mp):
    live = with_meanings(m)
    start = at(10, day=12)
    now = iso(m.clock())
    with m.ledger.tx() as db:
        db.execute("INSERT INTO meaning_receipts(id, gmail_key, title, said, start, end, features, state, action,"
                   " created_at, updated_at) VALUES(?,?,?,?,?,?,?,'new','',?,?)",
                   ("k" * 24 + ".0", "k" * 32, "Busy (watching kids)", "Garden club", start.isoformat(),
                    (start + timedelta(hours=1)).isoformat(),
                    json.dumps({"said": "Garden club", "words": ["garden", "club"], "type": "supervision"}),
                    now, now))
    assert live.send_receipts() == 1                                   # mints meaning_undo per button
    target = minted(m, "meaning_undo", ending=":once")
    assert target == "k" * 24 + ".0:once"

    def check(said):
        assert said == "Taking it off your Gmail, this time only."
        # Records only: the receipt is marked for removal. Taking the block off Gmail is family_gmail's own sync
        # (meaning_live.removals), which this tap doesn't run and this rig doesn't wire.
        row = m.ledger.db.execute("SELECT state, action FROM meaning_receipts").fetchone()
        assert (row["state"], row["action"]) == ("removing", "once")
        assert live.removals() == [("k" * 24 + ".0", "k" * 32, "once")]
    return target, check


@setup("place_skip")
def _place_skip(m, mp):
    live = with_meanings(m)
    now = m.clock()
    live.places._send(OWNER_ID, "community hall", "Community Hall", "Garden club", now + timedelta(hours=3), now)
    (row,) = m.ledger.db.execute("SELECT * FROM place_asks").fetchall()
    target = minted(m, "place_skip")
    assert target == row["id"]

    def check(said):
        assert said.startswith("Got it. I won't ask where ")
        assert m.ledger.db.execute("SELECT state FROM place_asks").fetchone()[0] == "skipped"
    return target, check


def turn_on_card(m):
    """The smoke run passed and its card offers Turn on and Keep cards (sixth round)."""
    from test_handover_round6 import run_smoke
    run = run_smoke(m)
    out = m.send(Handover(kind="fastpath", state="on", run=run))
    assert out["status"] == "ok", out
    m.c.outbox.flush()
    return run


@setup("calendar_change_fast_keep")
def _fast_keep(m, mp):
    turn_on_card(m)
    offer = json.loads(m.ledger.get_meta(calendar_change.FAST_OFFER))
    target = minted(m, "calendar_change_fast_keep")
    assert target == offer["id"]

    def check(said):
        assert said.startswith("Kept: every calendar change still comes on a card")
        assert event_count(m, "calendar_fast_path_kept") == 1 and not calendar_change.fast_path_on(m.ledger)
    return target, check


@setup("calendar_change_fast_on")
def _fast_on(m, mp):
    run = turn_on_card(m)
    target = minted(m, "calendar_change_fast_on")
    assert target == json.loads(m.ledger.get_meta(calendar_change.FAST_OFFER))["id"]

    def check(said):
        assert said.startswith("Turned on:")
        kept = calendar_change.fast_path(m.ledger)
        assert kept["on"] is True and kept["smoke"]["run"] == run
        assert m.ledger.get_meta(calendar_change.FAST_OFFER) is None
    return target, check


@setup("calendar_change_fast_off")
def _fast_off(m, mp):
    run = turn_on_card(m)
    m.tap("Turn on")                                                   # mints Turn off on the same card
    m.c.outbox.flush()
    assert calendar_change.fast_path_on(m.ledger)
    target = minted(m, "calendar_change_fast_off")
    assert target == run

    def check(said):
        assert said.startswith("Turned off:") and not calendar_change.fast_path_on(m.ledger)
    return target, check


@setup("calendar_change_gate_open", marks=(pytest.mark.install_gate,))
def _gate_open(m, mp):
    from test_handover_round10 import _gmail_stale, conform, seen_both, start
    run = start(m)
    seen_both(m, "gmail")
    _gmail_stale(m, mp, on="drop", answer=None, apply=True)            # removals unprotected: the gate stays closed
    assert conform(m, run, "gmail")["result"] == "partial"
    assert "gmail" in calendar_change.closed_providers(m.ledger)
    target = minted(m, "calendar_change_gate_open")
    assert target == "gmail"

    def check(said):
        assert said.startswith("Gmail cards are open without the check after installing") and \
            said.endswith("Nothing was waiting.")
        assert "gmail" not in calendar_change.closed_providers(m.ledger)
        assert event_count(m, "calendar_card_gate_override") == 1
    return target, check


@setup("calendar_change_which", reads="his pick puts the corrected change on a new card, and a card's preview reads "
                                      "the calendar it would change")
def _which(m, mp):
    from test_handover_round4 import _two_cards
    mid, _ = _two_cards(m)
    m.claude.script = [ask(change("gmail", "add", "Dentist", dates="", start=at(16).isoformat(),
                                  end=at(17).isoformat()))]
    m.handover(paired=OWNER, message=mid, suggestion="He means the dentist at 4.")
    target = minted(m, "calendar_change_which", ending=":0")
    token = target.rsplit(":", 1)[0]
    assert m.ledger.get_meta(f"calendar_change_which:{token}")
    cards = m.ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0]

    def check(said):
        assert said == "The correction is on a new card. That card is off."
        assert m.ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == cards + 1
        assert dentists(m) == []                                       # a card, never applied
    return target, check


@setup("calendar_change_propose_again", reads="each request is read on its calendar first (one shown there is said "
                                              "as confirmed), then comes back on a new card, whose preview reads")
def _propose_again(m, mp):
    dentist_card(m)
    (pid,) = [r[0] for r in m.ledger.db.execute("SELECT id FROM proposals")]
    with m.ledger.tx() as db:                                          # as the update's sweep leaves it
        db.execute("UPDATE proposals SET state='superseded' WHERE id=?", (pid,))
        migrate._listing(m.ledger, OWNER_ID, [(pid, "Your message: Add Dentist (its card was replaced).")], db)
    target = minted(m, "calendar_change_propose_again")
    assert migrate.listed(m.ledger, target) == [pid]

    def check(said):
        assert said == "Back on 1 new card, each waiting for your tap."
        assert m.ledger.db.execute("SELECT COUNT(*) FROM proposals WHERE state='proposed'").fetchone()[0] == 1
        assert dentists(m) == []
    return target, check


def family_add_off_card(m):
    m.ledger.db.execute("DELETE FROM meta WHERE key=?", (family_add.ENABLED,))
    out = m.tells("add book club tomorrow at 3 to family",
                  result({"type": "proposal", "effect_type": "family_event_add", "params": dict(BOOK_CLUB),
                          "summary": "ignored"}))
    assert out["status"] != "waiting for his tap", out
    m.c.outbox.flush()


@setup("family_add_enable", reads="Turn on brings his message back as if just sent, so it runs again, and its new "
                                  "card's preview reads the calendars (Gmail, for clashes)")
def _family_add_enable(m, mp):
    family_add_off_card(m)
    target = minted(m, "family_add_enable")
    job = m.ledger.job(target)
    assert job is not None and job["state"] == "no_action"
    m.claude.script = [result({"type": "proposal", "effect_type": "family_event_add", "params": dict(BOOK_CLUB),
                               "summary": "ignored"})]

    def check(said):
        assert said.startswith("Adding to the Family calendar is on.") and "The card for your event comes next." in said
        assert m.fa.enabled() and event_count(m, "family_add_asked_again") == 1
        assert not any("Book club" in ics for _, ics in m.icloud.events.values())
    return target, check


def bake_card(m):
    """The bake-in record is due: its card offers None wrong and Keep checking (family_add._send_card)."""
    with m.ledger.tx() as db:
        m.ledger.set_meta(family_add.ENABLED, "1", db)
    b = {"n": family_add.BAKE_ADDS, "first": iso(m.clock() - timedelta(days=family_add.BAKE_DAYS + 1)),
         "epoch": "e1e2e3e4e5e6e7e8", "asked_at": None, "marks": [0, 0, 0], "floor": [0, 0, 0],
         "on": m.fa._earning()}
    with m.ledger.tx() as db:
        m.ledger.set_meta(family_add.BAKE, json.dumps(b), db)
    m.fa._send_card(b, family_add.BAKE_DAYS + 1, 0, held=False)
    return b


@setup("family_add_loosen", reads="it checks the record against the Family calendar before it loosens anything "
                                  "(FamilyCalDav.missing, a read only)")
def _family_add_loosen(m, mp):
    b = bake_card(m)
    target = minted(m, "family_add_loosen")
    assert target == b["epoch"]

    def check(said):
        assert said.startswith("Done. Adds to the Family calendar no longer wait for your tap")
        assert m.fa.loosened() and event_count(m, "family_add_loosened") == 1
    return target, check


@setup("family_add_keep")
def _family_add_keep(m, mp):
    b = bake_card(m)
    target = minted(m, "family_add_keep")
    assert target == b["epoch"]

    def check(said):
        assert said == "Each add still needs your tap, and the count starts over."
        now = json.loads(m.ledger.get_meta(family_add.BAKE))
        assert now["epoch"] != b["epoch"] and now["n"] == 0 and not m.fa.loosened()
    return target, check


@setup("stopped_drop")
def _stopped_drop(m, mp):
    m.c.commands._stop("")
    m.tells("add the dentist 3 to 4 today", ask(change("gmail", "add", "Dentist", dates="",
                                                       start=at(15).isoformat(), end=at(16).isoformat())))
    m.c.commands._resume("")
    with m.ledger.tx() as db:
        commands.card_stopped(m.ledger, OWNER_ID, db)                  # mints stopped_redo and stopped_drop
    target = minted(m, "stopped_drop")
    job = m.ledger.job(target)
    assert job is not None and job["state"] in ("cancelled", "failed")

    def check(said):
        assert said == "Dropped. Nothing was done."
        assert event_count(m, "stopped_dropped") == 1 and m.ledger.job(target)["state"] == job["state"]
    return target, check


# -- the tests ---------------------------------------------------------------------------------------------------------

def test_every_records_only_kind_has_a_well_formed_setup():
    assert set(SETUPS) == set(Controller.CHOICE_RECORDS)


PARAMS = [pytest.param(k, marks=SETUPS[k]["marks"] if k in SETUPS else (), id=k)
          for k in sorted(Controller.CHOICE_RECORDS)]


@pytest.mark.card_only
@pytest.mark.parametrize("kind", PARAMS)
def test_each_records_only_kind_reaches_its_records_path_and_calls_no_calendar(m, monkeypatch, kind):
    assert kind in choices.KINDS                                               # a real kind, not a stale name
    spec = SETUPS[kind]
    target, check = spec["fn"](m, monkeypatch)
    assert target                                                              # shaped as its minting code shapes it
    m.c.outbox.flush()
    writes = calendar_writes(m)
    reads = count_reads(m, monkeypatch)
    read_before = calendar_reads(m, reads)
    said = m.c.callbacks._apply_choice(kind, target)
    for _ in range(3):
        m.c.tick()
    assert "Nothing changed" not in said and "can't be read" not in said, said
    check(said)
    assert calendar_writes(m) == writes, kind
    if not spec["reads"]:
        assert calendar_reads(m, reads) == read_before, kind


# -- the round-eighteen case where Go ahead must still be absent -----------------------------------------------------

@pytest.mark.card_only
def test_an_approve_the_records_took_whose_google_add_is_absent_after_a_restore_gets_no_go_ahead(m, monkeypatch):
    """His Approve used up (the records took it and its add was sent), the outcome lost; then Google answers 404 at
    the add's fixed id, and the records are put back from a backup taken after the tap. Absent can't tell whether it
    was added and taken off, so the card has no Go ahead and nothing is added again."""
    dentist_card(m)
    landed_then_crashed(m, monkeypatch)
    (ev,) = dentists(m)
    del m.gmail.events[ev["id"]]                                               # Google answers 404 there now
    op = m.c.handovers.journaled()[0]["op"]
    assert m.cc.tap_parts(op) == ["absent"]
    assert m.ledger.db.execute("SELECT COUNT(*) FROM approvals WHERE consumed_at IS NOT NULL").fetchone()[0] == 1
    after_tap = sqlite3.connect(":memory:")
    m.ledger.db.backup(after_tap)                                              # the records hold his tap
    before = len(m.link.cards)
    restart_after_restore(m, after_tap)
    cards = new_cards(m, before)
    said = " ".join(c["text"] for c in cards)
    assert "can't tell whether it was added and taken off since" in said, said
    assert "Go ahead" not in card_labels(cards)
    for _ in range(3):
        m.c.tick()
    assert len([e for e in m.gmail.log if e[0] == "insert"]) == 1             # never added again
    assert dentists(m) == []
