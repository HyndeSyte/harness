"""Phase 2 of what a Family event means: his answers, live blocks, receipts and Undo.

All names are invented. No network: Family, Google, Cain's link and the model are fakes.
"""
import hashlib
import json
import logging
import re
import shutil
import subprocess
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

import pytest

from harness import caldav, choices, drive, family_rules, handover, ical, inputs, meaning, meaning_live, places
from harness.calendar_change import CalendarChange
from harness.family_copy import FamilyCopy
from harness.family_gmail import (DROP_TITLE, FamilyGmail, Want, _leg_title, home_from_options, leg_key,
                                  own_days_from_options)
from harness.mail_dates import MailDates
from harness.ledger import Ledger
from harness.engines import EngineError
from harness.net import HttpResponse, TransportError
from conftest import Clock
from fakes import FakeEngine, ManualExecutor, SyncExecutor, result
from fake_caldav import FAMILY_PATH, no_network  # noqa: F401  (autouse)
from test_family_add import Rig as FamilyRig, on, rig  # noqa: F401
from test_family_copy import Feeds, GMAIL, NY, TZ, occ, seed, when
from test_family_gmail import KEY, RULES, FakeGoogle, count, g, make_g  # noqa: F401
from test_mail_dates import Box
from harness import family_gmail, google_cal

ROOT = Path(__file__).resolve().parents[1]
OWNER_ID = 7


# -- helpers ---------------------------------------------------------------------------------------

class Shadow:
    """What MeaningLive needs of the judging: Family as last read, and a nudge."""
    def __init__(self):
        self.items = []
        self.pokes = 0

    def poke(self):
        self.pokes += 1


def item(title, start, hours=1, uid=None, all_day=False, instance=""):
    end = start + timedelta(hours=hours) if not all_day else start + timedelta(days=1)
    o = ical.Occurrence(start, end, all_day, title, "Family", False, uid or f"u-{title}-{start:%m%d%H}",
                        instance, (), "", "")
    return caldav.Item(o, f"/{o.uid}.ics", '"1"', "")


def rel(kind="supervision", s=0, e=60, certainty="medium", place="none", rs=None, re_=None):
    return meaning.Rel(kind, s, e, rs, re_, place, certainty)


def judge(ledger, it, *obs, cites=(), unsure=False, items=None):
    """A stored judgment for the event this item belongs to, as the judging would leave it."""
    evs = meaning.events_of(items or [it], TZ)
    ev = next(e for e in evs.values() if any(i.occ.uid == it.occ.uid for i in e.occurrences))
    feats = meaning.features_of(ev, it, TZ)
    cands = [c.id for c in meaning.candidates(meaning.active_examples(ledger), feats)]
    meaning.store(ledger, ev, it, TZ, meaning.Judgment(tuple(obs), tuple(cites), unsure),
                  examples_ver="v", model="m", features=feats, cands=cands)
    return ev


@pytest.fixture
def lv(ledger, clock):
    shadow = Shadow()
    feeds = Feeds()
    live = meaning_live.MeaningLive(ledger, shadow, feeds, tz=TZ, on_fn=lambda: True)
    live.bind(OWNER_ID)
    return SimpleNamespace(ledger=ledger, clock=clock, shadow=shadow, feeds=feeds, live=live)


def local(lv, days, hour=9):
    d = lv.clock().astimezone(NY).date() + timedelta(days=days)
    return datetime(d.year, d.month, d.day, hour, tzinfo=NY)


def cards(ledger):
    return [(r["text"], json.loads(r["buttons_json"] or "null"))
            for r in ledger.db.execute("SELECT * FROM outbox ORDER BY id")]


def labels(buttons):
    return [t for row in buttons for t, _ in row]


def add(lv, *its):
    lv.shadow.items.extend(its)


def open_q(ledger):
    return ledger.db.execute("SELECT * FROM meaning_questions WHERE state='open'").fetchall()


def day(d):
    return f"{d:%a %b} {d.day}"


# -- 1. questions: when one is worth his time ------------------------------------------------------------

def test_an_unsure_kids_judgment_within_two_weeks_gets_one_question_with_buttons(lv):
    start = local(lv, 5)
    it = item("Kid sitting", start)
    add(lv, it)
    judge(lv.ledger, it, rel("supervision", 0, 60))
    lv.live.tick(paused=False)
    [(text, buttons)] = cards(lv.ledger)
    assert text == f"Kid sitting, {day(start)} 9:00 AM: are you watching the kids?"
    assert labels(buttons) == ["Yes", "No", "Depends"]
    lv.live.tick(paused=False)
    assert len(cards(lv.ledger)) == 1                         # once


def test_driving_and_presence_have_their_own_templates(lv):
    a, b = local(lv, 4), local(lv, 6)
    drive, dentist = item("Swim meet", a), item("Dentist", b)
    add(lv, drive, dentist)
    judge(lv.ledger, drive, rel("transport", -30, 0, place="event_location"))
    judge(lv.ledger, dentist, unsure=True)                    # can't tell if it ties him up
    lv.live.tick(paused=False)
    got = cards(lv.ledger)
    assert got[0][0] == f"Swim meet, {day(a)} 9:00 AM: are you driving?"
    assert labels(got[0][1]) == ["Yes", "No", "Depends"]
    assert got[1][0] == f"Dentist, {day(b)}: does it tie you up?"
    assert labels(got[1][1]) == ["All of it", "Part of it", "No"]


def test_nothing_past_two_weeks_and_nothing_already_backed(lv):
    far = item("Kid sitting", local(lv, 20))
    eid, _ = meaning.add_example(lv.ledger, source="answer", said="piano", words=frozenset({"piano"}),
                                 types=["supervision"])
    sure = item("Piano", local(lv, 3))
    add(lv, far, sure)
    judge(lv.ledger, far, rel("supervision"))
    judge(lv.ledger, sure, rel("supervision", certainty="high"), cites=[eid])
    lv.live.tick(paused=False)
    assert cards(lv.ledger) == []


def test_within_48_hours_it_goes_at_once_otherwise_one_batch_a_day(lv):
    today = lv.clock().astimezone(NY).date().isoformat()
    with lv.ledger.tx() as db:
        lv.ledger.set_meta("meaning_question_batch", today, db)    # today's batch went
    soon, later = item("Kid sitting", local(lv, 1)), item("Book club", local(lv, 5))
    add(lv, soon, later)
    judge(lv.ledger, soon, rel("supervision"))
    judge(lv.ledger, later, rel("presence", certainty="high"))
    lv.live.tick(paused=False)
    assert [t.split(",")[0] for t, _ in cards(lv.ledger)] == ["Kid sitting"]
    lv.clock.advance(days=1)
    lv.live.tick(paused=False)
    assert [t.split(",")[0] for t, _ in cards(lv.ledger)] == ["Kid sitting", "Book club"]


def test_the_days_batch_waits_for_morning(lv):
    lv.clock.t = lv.clock().replace(hour=9)                  # 5 AM in New York
    it = item("Book club", local(lv, 5))
    add(lv, it)
    judge(lv.ledger, it, rel("presence", certainty="high"))
    lv.live.tick(paused=False)
    assert cards(lv.ledger) == []
    lv.clock.advance(hours=3)
    lv.live.tick(paused=False)
    assert len(cards(lv.ledger)) == 1


def test_three_open_at_most_and_one_per_kind(lv):
    its = [item(f"Event {w}", local(lv, 2 + n)) for n, w in enumerate(("apple", "bean", "corn", "dill", "egg"))]
    twin = item("Event apple", local(lv, 8), uid="other-a")   # the same kind as the first
    add(lv, *its, twin)
    for it in its + [twin]:
        judge(lv.ledger, it, rel("presence", certainty="high"))
    lv.live.tick(paused=False)
    assert len(cards(lv.ledger)) == meaning_live.MAX_OPEN == len(open_q(lv.ledger))
    assert len({q["kind_key"] for q in open_q(lv.ledger)}) == 3


def test_the_same_question_is_never_asked_twice(lv):
    first = item("Book club", local(lv, 3))
    add(lv, first)
    judge(lv.ledger, first, rel("presence", certainty="high"))
    lv.live.tick(paused=False)
    lv.clock.advance(days=4)                                  # unanswered, and it has passed
    nxt = item("Book club", local(lv, 3), uid="next-club")
    add(lv, nxt)
    judge(lv.ledger, nxt, rel("presence", certainty="high"))
    lv.live.tick(paused=False)
    assert len(cards(lv.ledger)) == 1
    assert lv.ledger.db.execute("SELECT state FROM meaning_questions").fetchone()["state"] == "expired"


def test_already_busy_on_gmail_isnt_asked_but_kids_soon_always_is(lv):
    later, soon = local(lv, 5), local(lv, 1)
    lv.feeds.window.occurrences = [occ("Work trip", later - timedelta(hours=1), hours=3),
                                   occ("Call", soon - timedelta(hours=1), hours=3)]
    a, b = item("Book club", later), item("Kid sitting", soon)
    add(lv, a, b)
    judge(lv.ledger, a, rel("presence", certainty="high"))
    judge(lv.ledger, b, rel("supervision"))
    lv.live.tick(paused=False)
    assert [t.split(",")[0] for t, _ in cards(lv.ledger)] == ["Kid sitting"]


def test_card_text_is_a_template_with_a_cleaned_short_title(lv):
    title = "Pat /cancel @everyone <b>dentist</b> at evil.example/win " + "x" * 40
    it = item(title, local(lv, 2))
    add(lv, it)
    judge(lv.ledger, it, rel("supervision"))
    lv.live.tick(paused=False)
    [(text, _)] = cards(lv.ledger)
    shown, _, tail = text.partition(", ")
    assert tail == f"{day(local(lv, 2))} 9:00 AM: are you watching the kids?"
    for bad in ("/cancel", "@everyone", "<b>", "evil.example", "x" * 20):
        assert bad not in text
    assert len(shown) <= 60


def test_off_stopped_or_unbound_asks_nothing(lv):
    it = item("Kid sitting", local(lv, 1))
    add(lv, it)
    judge(lv.ledger, it, rel("supervision"))
    lv.live.tick(paused=True)
    lv.live.on_fn = lambda: False
    lv.live.tick(paused=False)
    assert cards(lv.ledger) == []


# -- 2. his tap ------------------------------------------------------------------------------------------

def ask_one(lv, title="Kid sitting", days=5, *obs):
    it = item(title, local(lv, days))
    add(lv, it)
    judge(lv.ledger, it, *(obs or (rel("supervision"),)))
    lv.live.tick(paused=False)
    [q] = open_q(lv.ledger)
    return it, q


def test_a_yes_stores_a_confirmed_example_and_judges_again(lv):
    it, q = ask_one(lv)
    words = sorted(family_rules.words("Kid sitting"))
    reply = lv.live.on_choice("meaning_answer", f"{q['id']}:yes")
    assert reply == "Thanks. I'll put Kid sitting on your calendar as yours."    # what will happen
    [ex] = [e for e in meaning.active_examples(lv.ledger) if e.source == "answer"]
    assert ex.types == ("supervision",) and sorted(ex.words) == words and ex.confirmed and ex.trusted
    row = lv.ledger.db.execute("SELECT stale FROM meaning_judgments").fetchone()
    assert row["stale"] == 1 and lv.shadow.pokes == 1
    # The occurrence he answered about follows his answer at once.
    [w] = lv.live.wants([it], lv.clock()).values()
    assert (w.title, w.state) == ("Busy (watching kids)", "confirmed")


def test_the_judging_takes_the_new_example_as_a_candidate(lv):
    it, q = ask_one(lv)
    lv.live.on_choice("meaning_answer", f"{q['id']}:yes")
    ev = next(iter(meaning.events_of([it], TZ).values()))
    feats = meaning.features_of(ev, it, TZ)
    ids = [c.id for c in meaning.candidates(meaning.active_examples(lv.ledger), feats)]
    assert any(e.source == "answer" and e.id in ids for e in meaning.active_examples(lv.ledger))
    assert meaning.needs_judging(meaning.stored(lv.ledger, ev.key), ev, set(ids))


def test_depends_stores_nothing_and_asks_each_time(lv):
    first = local(lv, 1)
    its = [item("Kid sitting", first + timedelta(days=7 * n), uid=f"ks-{n}") for n in range(2)]
    add(lv, *its)
    for it in its:
        judge(lv.ledger, it, rel("supervision"))
    lv.live.tick(paused=False)
    [q] = open_q(lv.ledger)
    before = len(meaning.active_examples(lv.ledger))
    assert lv.live.on_choice("meaning_answer", f"{q['id']}:depends").startswith("Got it.")
    assert len(meaning.active_examples(lv.ledger)) == before and lv.shadow.pokes == 0
    assert lv.ledger.db.execute("SELECT ask_each_time FROM meaning_kinds").fetchone()[0] == 1
    lv.clock.advance(days=7)
    lv.live.tick(paused=False)
    assert len(cards(lv.ledger)) == 2                          # the next one is asked too
    [q2] = open_q(lv.ledger)
    assert q2["each"] == 1
    lv.live.on_choice("meaning_answer", f"{q2['id']}:yes")      # about that one only
    assert len(meaning.active_examples(lv.ledger)) == before


def test_no_and_part_store_what_they_say(lv):
    it, q = ask_one(lv, "Book club", 5, rel("presence", certainty="high"))
    lv.live.on_choice("meaning_answer", f"{q['id']}:no")
    [ex] = [e for e in meaning.active_examples(lv.ledger) if e.source == "answer"]
    assert ex.types == ()
    assert lv.live.wants([it], lv.clock()) == {}
    lv.clock.advance(days=1)                                  # the next day's batch
    it2, q2 = ask_one(lv, "Farm day", 6, rel("presence", certainty="high"))
    lv.live.on_choice("meaning_answer", f"{q2['id']}:part")
    ex2 = next(e for e in meaning.active_examples(lv.ledger) if "farm" in e.words)
    assert ex2.types == ("presence",) and ex2.scope == "part"


def test_a_closed_question_changes_nothing(lv):
    _, q = ask_one(lv)
    lv.live.on_choice("meaning_answer", f"{q['id']}:yes")
    assert lv.live.on_choice("meaning_answer", f"{q['id']}:no").startswith("That question is closed")
    assert lv.live.on_choice("meaning_answer", "nope:yes").startswith("That question is closed")
    assert lv.live.on_choice("meaning_answer", f"{q['id']}:delete everything") == "Nothing changed."


def test_a_newer_answer_overrules_an_older_one_for_the_kind_never_deletes(ledger):
    w = frozenset({"book", "club"})
    a, _ = meaning.add_example(ledger, source="answer", said="book club", words=w, types=["presence"])
    b, _ = meaning.add_example(ledger, source="answer", said="book club", words=w, types=[])
    states = dict(ledger.db.execute("SELECT id, state FROM meaning_examples").fetchall())
    assert states == {a: "overruled", b: "active"}


def test_an_answer_overrules_a_seeded_rule_and_the_next_read_doesnt_bring_it_back(ledger):
    rows = meaning.seed_rows((family_rules.Rule("Kid sitting", "kids"),), (), ())
    meaning.sync_examples(ledger, rows)
    meaning.add_example(ledger, source="answer", said="kid sitting", words=rows[0]["words"], types=[])
    meaning.sync_examples(ledger, rows)
    assert [e.source for e in meaning.active_examples(ledger)] == ["answer"]


# -- 3. through the real tap paths --------------------------------------------------------------------

def test_a_tap_goes_through_the_choice_binding(on):
    on.shadow = Shadow()
    on.live = meaning_live.MeaningLive(on.ledger, on.shadow, Feeds(), tz=TZ, on_fn=lambda: True)
    on.c.meaning_live = on.live
    on.c.callbacks.meaning_live = on.live
    on.live.bind(on.c.config.owner_user_id)
    it = item("Kid sitting", when(on, days=1))
    on.shadow.items.append(it)
    judge(on.ledger, it, rel("supervision"))
    on.tick()
    card = on.with_button("Depends")
    on.press(card, "Yes")
    assert any(e.source == "answer" for e in meaning.active_examples(on.ledger))
    assert "put Kid sitting on your calendar" in on.bot.sent[-1][1]
    on.press(card, "No")                                       # one tap per card
    assert [e.types for e in meaning.active_examples(on.ledger) if e.source == "answer"] == [("supervision",)]


def test_a_tap_through_cain_comes_back_as_a_press(ledger, tmp_path, clock):
    from test_discord_keeper import Rig as CainRig
    r = CainRig(ledger, tmp_path, clock)
    shadow = Shadow()
    live = meaning_live.MeaningLive(ledger, shadow, Feeds(), tz=TZ, on_fn=lambda: True)
    r.c.meaning_live = live
    r.c.callbacks.meaning_live = live
    live.bind(r.c.config.owner_user_id)
    d = clock().astimezone(NY).date() + timedelta(days=1)
    it = item("Kid sitting", datetime(d.year, d.month, d.day, 9, tzinfo=NY))
    shadow.items.append(it)
    judge(ledger, it, rel("supervision"))
    r.c.tick()
    cid, card = next((k, v) for k, v in r.link.cards.items() if "watching the kids" in v["text"])
    yes = next(b["custom_id"] for row in card["rows"] for b in row["components"] if b["label"] == "Yes")
    r.tap(cid, yes)
    assert any(e.source == "answer" for e in meaning.active_examples(ledger))


# -- 4. what he told Cain -------------------------------------------------------------------------------

ROW = {"kind": "Pat dentist", "meaning": "kids", "said_on": "2026-10-01"}


@pytest.mark.parametrize("body, why", [
    ({}, "rows must be a list"),
    ({"rows": "x"}, "rows must be a list"),
    ({"rows": [ROW] * (meaning_live.MAX_ROWS + 1)}, "at most"),
    ({"rows": [{**ROW, "note": "x"}]}, "row 1: needs exactly"),
    ({"rows": [{**ROW, "meaning": "babysit"}]}, "row 1: meaning must be one of"),
    ({"rows": [{**ROW, "kind": "x" * 81}]}, "row 1: kind must be"),
    ({"rows": [{**ROW, "kind": "!!! ???"}]}, "row 1: kind must be"),
    ({"rows": [{**ROW, "kind": " ".join(f"w{n}" for n in range(9))}]}, "row 1: kind must be"),
    ({"rows": [ROW, {**ROW, "said_on": "yesterday"}]}, "row 2: said_on"),
    ({"rows": [{**ROW, "said_on": "2099-01-01"}]}, "row 1: said_on must not be in the future"),
    ({"rows": [{**ROW, "kind": 5}]}, "row 1: kind must be"),
])
def test_rows_from_cain_are_checked_strictly(body, why):
    rows, reason = meaning_live.validate_rows(body)
    assert rows is None and reason.startswith(why)
    assert "babysit" not in reason and "w8" not in reason        # never an echo


def test_good_rows_are_cleaned_words():
    rows, _ = meaning_live.validate_rows({"rows": [{**ROW, "kind": "  PAT's   Dentist!! "}]})
    assert rows == [{"words": ["dentist", "pat"], "meaning": "kids", "said_on": "2026-10-01"}]


def test_the_table_imports_once_and_again_changes_nothing(lv):
    rows, _ = meaning_live.validate_rows({"rows": [
        ROW, {"kind": "School Day", "meaning": "school", "said_on": "2026-09-01"},
        {"kind": "Swim meet", "meaning": "drive", "said_on": "2026-09-02"},
        {"kind": "Book club", "meaning": "none", "said_on": "2026-09-03"},
        {"kind": "Book club", "meaning": "me", "said_on": "2026-10-03"}]})
    assert lv.live.import_rows(rows) == (5, 0)
    got = {(" ".join(sorted(e.words)), e.types, e.place) for e in meaning.active_examples(lv.ledger)}
    assert got == {("dentist pat", ("supervision",), "none"), ("day school", ("transport",), "school"),
                   ("meet swim", ("transport",), "event_location"), ("book club", ("presence",), "none")}
    assert {e.source for e in meaning.active_examples(lv.ledger)} == {meaning_live.SOURCE_CAIN}
    n = lv.ledger.db.execute("SELECT COUNT(*) FROM meaning_examples").fetchone()[0]
    assert lv.live.import_rows(rows) == (0, 5)
    assert lv.ledger.db.execute("SELECT COUNT(*) FROM meaning_examples").fetchone()[0] == n


def test_an_old_row_doesnt_overrule_a_newer_tap(lv):
    w = frozenset({"book", "club"})
    meaning.add_example(lv.ledger, source="answer", said="book club", words=w, types=[])
    rows, _ = meaning_live.validate_rows({"rows": [{"kind": "Book club", "meaning": "me",
                                                    "said_on": "2026-09-01"}]})
    lv.live.import_rows(rows)
    assert [e.source for e in meaning.active_examples(lv.ledger)] == ["answer"]


def test_the_controller_stores_what_cain_sends(ledger, tmp_path, clock):
    from test_discord_keeper import Rig as CainRig
    r = CainRig(ledger, tmp_path, clock)
    r.c.meaning_live = meaning_live.MeaningLive(ledger, Shadow(), Feeds(), tz=TZ, on_fn=lambda: False)
    rows, _ = meaning_live.validate_rows({"rows": [ROW]})
    out = r.send(handover.Handover(kind="meanings", rows=rows))
    assert out["status"] == "ok" and out["said"] == "Stored 1 new; 0 already known."
    out = r.send(handover.Handover(kind="meanings", rows=rows))
    assert out["said"] == "Stored 0 new; 1 already known."


def test_keeper_sh_posts_the_table(tmp_path):
    """bun and curl are stand-ins that record what they're given; the table is real."""
    bash, jq = shutil.which("bash"), shutil.which("jq")
    if not (bash and jq):
        pytest.skip("needs bash and jq")
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "bun").write_text("#!/bin/bash\nprintf fakekey\n")
    (bin_ / "curl").write_text(
        "#!/bin/bash\n"
        'while [ $# -gt 0 ]; do case "$1" in -H) cat "${2#@}" > "$OUT.hdr"; shift 2 ;;'
        ' -d) printf %s "$2" > "$OUT.body"; shift 2 ;; -m) shift 2 ;; -sS) shift ;;'
        ' *) printf %s "$1" > "$OUT.url"; shift ;; esac; done\n'
        "echo '{\"status\": \"ok\", \"said\": \"Stored 2 new; 0 already known.\"}'\n")
    for f in ("bun", "curl"):
        (bin_ / f).chmod(0o755)
    table = tmp_path / "calendar-meanings.md"
    table.write_text("# What Family events mean for Dane\n\n| Kind | Meaning | Said on |\n|---|---|---|\n"
                     "| Pat dentist | kids | 2026-10-01 |\n| School Day | school | 2026-09-01 |\n"
                     "| not a row |\n")
    out_ = tmp_path / "rec"
    env = {"PATH": f"{bin_}:" + __import__("os").environ["PATH"], "OUT": str(out_)}
    sh = str(ROOT / "cain/rootfs/opt/cain/keeper.sh")
    run = subprocess.run([bash, sh, "meanings", str(table)], env=env, capture_output=True, text=True,
                         timeout=30)
    assert json.loads(run.stdout)["said"].startswith("Stored 2 new")
    assert Path(f"{out_}.url").read_text() == "http://0fcc2575-harness:8098/meanings"
    assert "X-Harness-Key: fakekey" in Path(f"{out_}.hdr").read_text()
    assert json.loads(Path(f"{out_}.body").read_text()) == {"rows": [
        {"kind": "Pat dentist", "meaning": "kids", "said_on": "2026-10-01"},
        {"kind": "School Day", "meaning": "school", "said_on": "2026-09-01"}]}
    missing = subprocess.run([bash, sh, "meanings", str(tmp_path / "nope.md")], env=env,
                             capture_output=True, text=True, timeout=30)
    assert missing.returncode == 2 and "No table file" in missing.stdout


def test_keeper_sh_meanings_is_wired_like_the_other_routes():
    script = (ROOT / "cain/rootfs/opt/cain/keeper.sh").read_text()
    code = "\n".join(l for l in script.splitlines() if not l.strip().startswith("#"))
    assert "handover|digest|meanings|places)" in code and "ctx=harness-handover-v1" in code
    assert "/meanings" in handover.ROUTES
    rules = (ROOT / "cain/rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "areas/family/calendar-meanings.md" in rules and "/opt/cain/keeper.sh meanings" in rules


# -- 5. live mode on his Gmail --------------------------------------------------------------------------

def judged(*obligations, cites=(), unsure=False):
    return result({"obligations": list(obligations), "cites": list(cites), "unsure": unsure}, usd=0.001)


def ob(kind, start, end, certainty="high", place="none", rstart="", rend=""):
    return {"type": kind, "start": start.isoformat(), "end": end.isoformat(),
            "return_start": rstart, "return_end": rend, "place": place, "certainty": certainty}


@pytest.fixture
def live(g):
    return make_live(g)


def make_live(g):
    g.judge = FakeEngine("claude")
    g.live_on = True
    g.m = meaning.MeaningShadow(g.ledger, g.fa.client, g.feeds, SyncExecutor(), engine_fn=lambda: g.judge,
                                on_fn=lambda: True, tz=TZ, rules_fn=lambda: g.rules,
                                said_fn=lambda: family_rules.load(g.ledger), name_fn=lambda: "Lee")
    g.live = meaning_live.MeaningLive(g.ledger, g.m, g.feeds, tz=TZ, on_fn=lambda: g.live_on,
                                      name_fn=lambda: "Lee")
    g.gm.live, g.gm.live_fn = g.live, lambda: g.live_on
    g.c.meaning, g.c.meaning_live = g.m, g.live
    g.c.callbacks.meaning_live = g.live
    g.live.bind(g.c.config.owner_user_id)
    return g


def go(rig):
    rig.feeds.generation += 1
    rig.tick()


def answer_ex(rig, title, types):
    eid, _ = meaning.add_example(rig.ledger, source="answer", said=title.casefold(),
                                 words=family_rules.words(title), types=types)
    return eid


def test_live_on_takes_the_judgments_not_the_title_rules(live):
    sitting, harvest = when(live, days=3), when(live, days=4, hour=7)
    seed(live, "Kid sitting", sitting)                       # the old rule: watching kids
    seed(live, "Turkey harvest", harvest, hours=4)
    eid = answer_ex(live, "Turkey harvest", ["supervision"])
    live.judge.script = [judged(),                            # kid sitting: nothing
                         judged(ob("supervision", harvest, harvest + timedelta(hours=4)), cites=[eid])]
    go(live)                                                  # judged
    go(live)                                                  # Gmail follows
    assert live.google.titles() == ["Busy (watching kids)"]
    [e] = live.google.live().values()
    assert datetime.fromisoformat(e["start"]["dateTime"]) == harvest
    assert e["transparency"] == "opaque"
    assert len(live.judge.calls) == 2


def test_provisional_only_within_48_hours_and_shown_free(live):
    soon, later = when(live, days=1), when(live, days=5)
    seed(live, "Kid sitting", soon)
    seed(live, "Kid sitting", later)
    live.judge.script = [judged(ob("supervision", soon, soon + timedelta(hours=1), certainty="medium")),
                         judged(ob("supervision", later, later + timedelta(hours=1), certainty="medium"))]
    go(live)
    go(live)
    [e] = live.google.live().values()
    assert e["summary"] == "Maybe busy (watching kids)" and e["transparency"] == "transparent"
    assert datetime.fromisoformat(e["start"]["dateTime"]) == soon
    # A free block is still ours and still plain: the next read leaves it be.
    writes = len(live.google.writes())
    go(live)
    assert len(live.google.writes()) == writes
    assert live.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "live"


def test_a_maybe_that_he_confirms_becomes_busy_and_gets_a_receipt(live):
    soon = when(live, days=1)
    seed(live, "Kid sitting", soon)
    live.judge.script = [judged(ob("supervision", soon, soon + timedelta(hours=1), certainty="medium"))]
    go(live)
    go(live)
    card = live.with_button("Depends")
    live.press(card, "Yes")
    go(live)
    [e] = live.google.live().values()
    assert e["summary"] == "Busy (watching kids)" and e["transparency"] == "opaque"
    assert live.ledger.db.execute("SELECT COUNT(*) FROM meaning_receipts").fetchone()[0] == 1


def test_his_copies_holds_and_own_name_still_get_nothing(live):
    seed(live, "Busy", when(live, days=1))
    seed(live, "Lee - Doctor", when(live, days=1, hour=13))
    go(live)
    go(live)
    assert live.judge.calls == [] and live.google.live() == {}


def test_off_switches_straight_back_to_the_title_rules(live):
    sitting = when(live, days=3)
    seed(live, "Kid sitting", sitting)
    live.judge.script = [judged()]
    go(live)
    go(live)
    assert live.google.live() == {}
    live.live_on = False
    go(live)
    assert live.google.titles() == ["Busy (watching kids)"]


def fresh_rig(tmp_path, name, attach_live_off):
    clock = Clock()
    ledger = Ledger(str(tmp_path / f"{name}.sqlite"), clock)
    sub = tmp_path / name
    sub.mkdir()
    r = FamilyRig(ledger, sub, clock)
    r.turn_on()
    r.feeds = Feeds()
    r.google = FakeGoogle()
    r.client = google_cal.GoogleCalendar(r.google, lambda: KEY, r.clock)
    r.gm = FamilyGmail(r.ledger, r.fa, r.feeds, r.client, rules_fn=lambda: RULES,
                       school_fn=lambda: ("school day",), tz=TZ)
    if attach_live_off:
        r.gm.live = meaning_live.MeaningLive(ledger, Shadow(), r.feeds, tz=TZ, on_fn=lambda: False)
        r.gm.live_fn = lambda: False
    r.c.family_gmail = r.gm
    return r


def scenario(r):
    r.feeds.window.occurrences = [occ("Errand", when(r, days=9, hour=15))]
    seed(r, "Kid sitting", when(r, days=2))
    path = seed(r, "Kid sitting", when(r, days=5, hour=13))
    seed(r, "Kid sitting", when(r, days=1, hour=10), extra=("RRULE:FREQ=WEEKLY;COUNT=4",))
    seed(r, "School day", when(r, days=3, hour=9), hours=6)
    go(r)
    r.icloud.human_edit(path, "SUMMARY:Kid sitting", "SUMMARY:Kid sitting moved")
    go(r)
    go(r)
    r.clock.advance(days=2)
    go(r)
    events = {k: {f: v for f, v in e.items() if f != "etag"} for k, e in r.google.events.items()}
    rows = [tuple(x) for x in r.ledger.db.execute(
        "SELECT key, event_id, title, start, end, state FROM family_gmail ORDER BY key")]
    return events, r.google.calls, rows


def test_live_off_writes_exactly_what_it_wrote_before(tmp_path):
    before = scenario(fresh_rig(tmp_path, "before", False))
    after = scenario(fresh_rig(tmp_path, "after", True))
    assert before[0] and before == after


# -- 6. receipts and Undo ---------------------------------------------------------------------------------

def confirmed(live, title="Turkey harvest", days=3):
    start = when(live, days=days)
    seed(live, title, start)
    eid = answer_ex(live, title, ["supervision"])
    live.judge.script = [judged(ob("supervision", start, start + timedelta(hours=1)), cites=[eid])]
    go(live)
    go(live)
    assert live.google.titles() == ["Busy (watching kids)"]
    assert live.live.send_receipts() == 0                     # written, not read back yet
    go(live)                                                  # a later read finds it as written
    assert live.live.send_receipts() == 1
    live.tick()                                               # the outbox sends it
    return live.with_button("Not mine")


def test_a_new_confirmed_block_gets_one_receipt_with_three_buttons(live):
    card = confirmed(live)
    _, text, buttons, _ = card
    assert labels(buttons) == ["Not mine", "Wrong time", "Just this once"]
    # A notice, not a question (Nov 10), with the block's whole time.
    assert text.startswith("Added to your Gmail: Busy (watching kids), ")
    assert ", for Turkey harvest on Family. Nothing to do if that's right; tap a button only if it's wrong." in text
    assert " to " in text and "?" not in text
    go(live)                                                  # a refresh is not a new receipt
    assert live.live.send_receipts() == 0
    assert "Undo" not in live.live.digest_line()


def test_the_receipt_waits_for_a_read_that_finds_the_block_as_written(live):
    start = when(live, days=3)
    seed(live, "Turkey harvest", start)
    eid = answer_ex(live, "Turkey harvest", ["supervision"])
    live.judge.script = [judged(ob("supervision", start, start + timedelta(hours=1)), cites=[eid])]
    go(live)
    go(live)                                                  # written: Google said ok
    [r] = live.ledger.db.execute("SELECT * FROM meaning_receipts").fetchall()
    assert r["state"] == "written" and live.live.digest_line() == ""
    [uid] = live.google.live()
    live.google.hand_edit(uid, summary="Busy (watching kids)", start={"dateTime": (start + timedelta(hours=2)).isoformat()},
                          end={"dateTime": (start + timedelta(hours=3)).isoformat()})
    go(live)                                                  # read back: not as written
    r = live.ledger.db.execute("SELECT * FROM meaning_receipts").fetchone()
    assert r["state"] == "written" and r["reads"] == 1
    assert live.live.send_receipts() == 0


def test_a_block_google_never_had_is_written_once_more_and_its_receipt_waits(live):
    """D1's open edge: a block Google answered "ok" but never had (404 by its id) isn't his
    removal. It's written once more, and its receipt waits for the read that finds it."""
    start = when(live, days=3)
    seed(live, "Turkey harvest", start)
    eid = answer_ex(live, "Turkey harvest", ["supervision"])
    live.judge.script = [judged(ob("supervision", start, start + timedelta(hours=1)), cites=[eid])]
    go(live)
    go(live)                                                  # written: Google said ok
    [uid] = live.google.live()
    del live.google.events[uid]                               # but it has nothing by that id
    go(live)
    go(live)                                                  # by its id, never there: once more
    assert uid in live.google.live() and count(live, "family_gmail_removed") == 0
    r = live.ledger.db.execute("SELECT * FROM meaning_receipts").fetchone()
    assert r["state"] == "written"                            # still waiting, not dropped
    go(live)                                                  # the read that finds it
    r = live.ledger.db.execute("SELECT * FROM meaning_receipts").fetchone()
    assert r["state"] == "new" and live.live.send_receipts() == 1


def test_a_block_never_found_gets_the_not_confirmed_line_with_its_buttons(live):
    start = when(live, days=3)
    seed(live, "Turkey harvest", start)
    eid = answer_ex(live, "Turkey harvest", ["supervision"])
    live.judge.script = [judged(ob("supervision", start, start + timedelta(hours=1)), cites=[eid])]
    go(live)
    go(live)
    [rid] = [r["id"] for r in live.live.written()]
    for _ in range(meaning_live.READS_TO_CONFIRM):             # three reads that don't find it
        live.live.read_back(rid, False)
    r = live.ledger.db.execute("SELECT * FROM meaning_receipts").fetchone()
    assert r["state"] == "unconfirmed"
    line = live.live.digest_line()
    assert "Written but not confirmed by a read of your calendar: Busy (watching kids)" in line
    assert live.live.send_receipts() == 1
    live.tick()
    _, text, buttons, _ = live.with_button("Not mine")
    assert text.startswith("Written to your Gmail but not confirmed: Busy (watching kids), ")
    assert labels(buttons) == ["Not mine", "Wrong time", "Just this once"]   # it keeps its buttons
    assert not text.startswith("Added")


def test_a_read_that_cant_tell_leaves_the_receipt_waiting(live):
    start = when(live, days=3)
    seed(live, "Turkey harvest", start)
    eid = answer_ex(live, "Turkey harvest", ["supervision"])
    live.judge.script = [judged(ob("supervision", start, start + timedelta(hours=1)), cites=[eid])]
    go(live)
    go(live)
    live.google.fail["GET"] = 503                             # Gmail can't be read: nothing is decided
    go(live)
    r = live.ledger.db.execute("SELECT * FROM meaning_receipts").fetchone()
    assert r["state"] == "written" and r["reads"] == 0
    del live.google.fail["GET"]
    go(live)                                                  # tried again inside the specialist
    assert live.ledger.db.execute("SELECT state FROM meaning_receipts").fetchone()["state"] == "new"


def test_every_reply_to_a_choice_tap_says_what_will_happen_not_a_done_calendar(lv):
    """Section 7: a tap reply never claims a calendar is already so before a read finds it."""
    done = re.compile(r"(?i)\b(?:is|are|stays?)\s+(?:now\s+)?(?:on|off)\s+(?:your|the)\b"
                      r"|\b(?:added|moved|removed|undone|taken off)\s+(?:to|from|on|off)\s+your\b")
    replies = []
    for n, code in enumerate(("yes", "all", "part", "no", "depends")):
        if n:
            lv.clock.advance(days=1)                          # the next day's batch
        it, q = ask_one(lv, f"Swim {code}", 5)
        replies.append(lv.live.on_choice("meaning_answer", f"{q['id']}:{code}"))
    replies.append(lv.live.on_choice("meaning_answer", "nothing:yes"))
    replies.append(lv.live.on_choice("meaning_undo", "nothing:not_mine"))
    for reply in replies:
        assert not done.search(reply), reply


def test_not_mine_removes_it_and_learns_nothing_ties_him_up(live):
    card = confirmed(live)
    live.press(card, "Not mine")
    assert "I'll leave Turkey harvest off" in live.bot.sent[-1][1]
    live.tick()                                               # the Undo goes without a new read
    assert live.google.live() == {}
    ex = next(e for e in meaning.active_examples(live.ledger) if e.source == "undo")
    assert ex.types == () and "turkey" in ex.words
    assert live.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "undone"
    live.judge.script = [judged()]
    go(live)
    go(live)
    assert live.google.live() == {}


def test_wrong_time_removes_it_and_the_next_one_asks(live):
    card = confirmed(live)
    live.press(card, "Wrong time")
    live.tick()
    assert live.google.live() == {}
    ex = next(e for e in meaning.active_examples(live.ledger) if e.source == "undo")
    assert ex.types == ("supervision",) and not ex.trusted
    assert live.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "cancelled"
    start = when(live, days=3)
    live.judge.script = [judged(ob("supervision", start, start + timedelta(hours=1)), cites=[ex.id])]
    go(live)                                                  # judged again: backed by nothing trusted
    go(live)
    assert live.google.live() == {}
    assert any("are you watching the kids?" in s[1] for s in live.bot.sent)


def test_just_this_once_removes_only_that_block_and_stores_nothing(live):
    card = confirmed(live)
    n = len(meaning.active_examples(live.ledger))
    live.press(card, "Just this once")
    live.tick()
    assert live.google.live() == {} and len(meaning.active_examples(live.ledger)) == n
    go(live)
    go(live)
    assert live.google.live() == {}                           # not put back


def test_removing_it_by_hand_on_google_teaches_nothing(live):
    confirmed(live)
    n = len(meaning.active_examples(live.ledger))
    [uid] = live.google.live()
    live.google.events[uid]["status"] = "cancelled"
    for _ in range(3):
        go(live)
    assert live.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "removed"
    assert len(meaning.active_examples(live.ledger)) == n


def test_undo_leaves_a_block_he_edited_alone(live):
    card = confirmed(live)
    [uid] = live.google.live()
    live.google.hand_edit(uid, description="mine now")
    live.press(card, "Not mine")
    live.tick()
    assert list(live.google.live()) == [uid]
    assert live.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "hands_off"


def test_a_cancelled_family_event_still_takes_two_reads_in_live_mode(live):
    start = when(live, days=3)
    path = seed(live, "Turkey harvest", start)
    seed(live, "Book club", when(live, days=9))               # Family isn't otherwise empty
    eid = answer_ex(live, "Turkey harvest", ["supervision"])
    live.judge.script = [judged(ob("supervision", start, start + timedelta(hours=1)), cites=[eid]),
                         judged()]
    go(live)
    go(live)
    del live.icloud.events[path]
    go(live)
    assert live.google.titles() == ["Busy (watching kids)"]   # never on one read
    go(live)
    assert live.google.live() == {}


def test_questions_and_undo_cost_no_model_calls(live):
    card = confirmed(live)
    calls = len(live.judge.calls)
    live.press(card, "Just this once")
    live.tick()
    live.live.tick(paused=False)
    assert len(live.judge.calls) == calls


def test_a_seeded_rule_read_in_after_he_said_it_doesnt_overrule_his_answer(lv):
    rows = meaning.seed_rows((family_rules.Rule("Pat dentist", "kids"),), (), ())
    meaning.sync_examples(lv.ledger, rows)                 # read in today, after 2026-10-01
    got, _ = meaning_live.validate_rows({"rows": [ROW]})
    lv.live.import_rows(got)
    assert [e.source for e in meaning.active_examples(lv.ledger)] == [meaning_live.SOURCE_CAIN]


def test_his_answer_wrongly_overruled_before_is_back_in_use_once(lv):
    rows = meaning.seed_rows((family_rules.Rule("Pat dentist", "kids"),), (), ())
    meaning.sync_examples(lv.ledger, rows)
    got, _ = meaning_live.validate_rows({"rows": [ROW]})
    lv.live.import_rows(got)
    lv.ledger.db.execute("UPDATE meaning_examples SET state=CASE source WHEN ? THEN 'overruled'"
                         " ELSE 'active' END", (meaning_live.SOURCE_CAIN,))   # as the old code left it
    lv.ledger.set_meta("meaning_revived", "")
    lv.live.tick(paused=True)
    assert [e.source for e in meaning.active_examples(lv.ledger)] == [meaning_live.SOURCE_CAIN]
    meaning.sync_examples(lv.ledger, rows)                 # the next Family read keeps it so
    assert [e.source for e in meaning.active_examples(lv.ledger)] == [meaning_live.SOURCE_CAIN]
    lv.ledger.db.execute("UPDATE meaning_examples SET state='overruled' WHERE source=?",
                         (meaning_live.SOURCE_CAIN,))
    lv.live.tick(paused=True)
    assert meaning.active_examples(lv.ledger) == []        # once only


def test_an_answer_a_newer_answer_overruled_stays_overruled(lv):
    w = frozenset({"book", "club"})
    a, _ = meaning.add_example(lv.ledger, source="answer", said="book club", words=w, types=["presence"])
    b, _ = meaning.add_example(lv.ledger, source="answer", said="book club", words=w, types=[])
    assert meaning.revive_answers(lv.ledger) == []
    states = dict(lv.ledger.db.execute("SELECT id, state FROM meaning_examples").fetchall())
    assert states == {a: "overruled", b: "active"}


def test_a_judgment_from_before_features_were_kept_is_made_again_for_his_answer(lv):
    got, _ = meaning_live.validate_rows({"rows": [ROW]})
    lv.live.import_rows(got)
    lv.ledger.db.execute(
        "INSERT INTO meaning_judgments(key, kind, fingerprint, anchor, obligations, cites, unsure, status,"
        " failure, tries, policy_version, examples_version, model, judged_at)"
        " VALUES('e:old','single','fp','2026-12-15','[]','[]',1,'ok','',1,'p','v','m','2026-11-08')")
    lv.ledger.set_meta("meaning_revived", "")
    lv.live.tick(paused=True)
    row = lv.ledger.db.execute("SELECT stale FROM meaning_judgments WHERE key='e:old'").fetchone()
    assert row["stale"] == 1


# -- 7. drive blocks around an event he goes to (0.19.6) --------------------------------------------------

HOME = "38.5, -78.5"                                          # map points: never looked up
CLINIC = "2 Clinic Rd, Town, VA"
PARK = "9 Park Ave, Town, VA"
POINTS = {"home": "-78.5,38.5", CLINIC: "-78.4,38.4", PARK: "-78.3,38.3"}


class Maps:
    """OpenStreetMap's two services: an address to a point, and minutes between two points."""

    def __init__(self):
        self.minutes = {frozenset({"home", CLINIC}): 20, frozenset({"home", PARK}): 25,
                        frozenset({CLINIC, PARK}): 15}
        self.urls = []
        self.fail = None

    def request(self, method, url, *, headers=None, timeout=30):
        self.urls.append(url)
        if self.fail:
            raise TransportError(self.fail)
        parts = urlsplit(url)
        named = {v: k for k, v in reversed(POINTS.items())}   # "home" names its point
        if parts.hostname == drive.GEOCODE_HOST:
            q = parse_qs(parts.query)["q"][0]
            lon, lat = POINTS[q].split(",") if q in POINTS else (None, None)
            body = f'[{{"lat": "{lat}", "lon": "{lon}"}}]' if lat else "[]"
        else:
            a, b = parts.path.split("/driving/")[1].split(";")
            body = f'{{"routes": [{{"duration": {self.minutes[frozenset({named[a], named[b]})] * 60}}}]}}'
        return HttpResponse(200, {}, body.encode())


class ByTitle(FakeEngine):
    """A judgment for each event, by its title, whatever order they're judged in."""

    def __init__(self):
        super().__init__("claude")
        self.by = {}

    def complete(self, *, system, user, schema):
        self.calls.append({"system": system, "user": user, "schema": schema})
        return next(r for title, r in self.by.items() if f"title: {title}" in user)


@pytest.fixture
def drives(live):
    return make_drives(live)


def make_drives(live):
    live.maps = Maps()
    live.home = HOME
    live.judge = ByTitle()
    live.gm.drives = drive.Drives(live.ledger, live.maps, lambda: "", home_fn=lambda: live.home,
                                  sleep=lambda s: None)
    live.feeds.window.occurrences = [occ("Errand", when(live, days=20, hour=15))]   # Gmail is read
    return live


def _ics(uid, title, start, hours, place):
    utc, fmt = start.astimezone(timezone.utc), "%Y%m%dT%H%M%SZ"
    where = ["LOCATION:" + place.replace(",", "\\,")] if place else []
    return "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{utc:{fmt}}",
                        f"DTSTART:{utc:{fmt}}", f"DTEND:{utc + timedelta(hours=hours):{fmt}}",
                        f"SUMMARY:{title}", *where, "END:VEVENT", "END:VCALENDAR"]) + "\r\n"


def goes(rig, title, start, place, hours=1):
    """A Family event he goes to himself, judged so, at a place. Seeded again, it moves."""
    uid = "goes-" + hashlib.sha256(title.encode()).hexdigest()[:12]
    path = f"{FAMILY_PATH}{uid}.ics"
    rig.icloud.seed(path, _ics(uid, title, start, hours, place))
    eid = answer_ex(rig, title, ["presence"])
    rig.judge.by[title] = judged(ob("presence", start, start + timedelta(hours=hours), place="event_location"),
                                 cites=[eid])
    return path


def blocks(rig):
    """(title, start, end, place) on Gmail, by start."""
    return sorted(((e["summary"], datetime.fromisoformat(e["start"]["dateTime"]),
                    datetime.fromisoformat(e["end"]["dateTime"]), e.get("location", ""))
                   for e in rig.google.live().values()), key=lambda b: (b[1], b[0]))


def states(rig):
    return {r["state"] for r in rig.ledger.db.execute("SELECT state FROM family_gmail")}


M = timedelta(minutes=1)


def test_the_drive_is_its_own_blocks_and_the_event_keeps_its_times(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, "The Eye Clinic, " + CLINIC)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", start - 30 * M, start, ""),
        ("Busy (family)", start, start + 60 * M, CLINIC),             # the street address only
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    # Home is map points: only the clinic's street address was looked up, never its name.
    asked = [parse_qs(urlsplit(u).query)["q"][0] for u in drives.maps.urls if drive.GEOCODE_HOST in u]
    assert asked == [CLINIC]


def test_too_close_to_go_home_drives_straight_on(drives):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    goes(drives, "Eye doctor", a, CLINIC)
    goes(drives, "Swim lesson", b, PARK)
    go(drives)
    go(drives)
    # Home and out again is 30 + 30 minutes (20 and 25 rounded up to quarter hours), more than
    # the half hour between: clinic to park.
    assert blocks(drives) == [
        ("Busy (drive there)", a - 30 * M, a, ""),
        ("Busy (family)", a, a + 60 * M, CLINIC),
        ("Busy (drive there)", b - 15 * M, b, ""),
        ("Busy (family)", b, b + 60 * M, PARK),
        ("Busy (drive back)", b + 60 * M, b + 90 * M, "")]


def test_time_enough_goes_home_between(drives):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=14)
    goes(drives, "Eye doctor", a, CLINIC)
    goes(drives, "Swim lesson", b, PARK)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", a - 30 * M, a, ""),
        ("Busy (family)", a, a + 60 * M, CLINIC),
        ("Busy (drive back)", a + 60 * M, a + 90 * M, ""),
        ("Busy (drive there)", b - 30 * M, b, ""),
        ("Busy (family)", b, b + 60 * M, PARK),
        ("Busy (drive back)", b + 60 * M, b + 90 * M, "")]


def receipts(rig):
    return rig.ledger.db.execute("SELECT * FROM meaning_receipts").fetchall()


def test_a_block_moved_before_a_read_found_it_is_told_where_it_is(drives):
    """Written, then moved by us (a move whose answer came late), then found: one Added receipt,
    at the new time, never a false "not confirmed"."""
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)                                                # written: its receipt waits for a read
    [r] = drives.live.written()
    row = drives.ledger.db.execute("SELECT * FROM family_gmail WHERE key=?", (r["gmail_key"],)).fetchone()
    later = when(drives, days=4, hour=13)
    drives.gm._moved(row, Want(row["key"], row["title"], later, later + timedelta(hours=1),
                               place=CLINIC, state="confirmed"))
    block = google_cal.Block(row["event_id"], '"9"', row["title"], later, later + timedelta(hours=1), True, CLINIC)
    drives.gm._read_back({row["event_id"]: block}, drives.clock(), later + timedelta(days=30))
    [r] = receipts(drives)
    assert r["state"] == "new" and r["reads"] == 0
    assert datetime.fromisoformat(r["start"]) == later and datetime.fromisoformat(r["end"]) == later + timedelta(hours=1)
    assert drives.live.send_receipts() == 1
    drives.tick()
    _, text, _, _ = drives.with_button("Not mine")
    assert text.startswith("Added to your Gmail: Busy (family), ") and ", 1:00 PM to 2:00 PM, " in text


def test_a_block_moved_after_a_read_found_it_is_read_again_where_it_is(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    seed(drives, "Book club", when(drives, days=9))           # Family isn't otherwise empty
    drives.judge.by["Book club"] = judged()
    go(drives)
    go(drives)
    go(drives)                                                # found: waits for the digest
    assert [r["state"] for r in receipts(drives)] == ["new"]
    later = when(drives, days=4, hour=13)
    goes(drives, "Eye doctor", later, CLINIC)                 # moved on Family before it went out
    go(drives)
    go(drives)                                                # the block follows: read again there
    go(drives)
    [r] = receipts(drives)
    assert r["state"] == "new" and datetime.fromisoformat(r["start"]) == later
    assert drives.live.send_receipts() == 1


def not_confirmed_then_moved(rig, *, sent: bool):
    """A block three reads didn't find (its receipt sent with the digest, or not yet), then moved
    by us to 1:00 PM the next day. Returns the block's row and its new start."""
    start = when(rig, days=3, hour=10)
    goes(rig, "Eye doctor", start, CLINIC)
    go(rig)
    go(rig)                                                   # written: its receipt waits for a read
    [r] = rig.live.written()
    for _ in range(meaning_live.READS_TO_CONFIRM):
        rig.live.read_back(r["id"], False)
    assert [x["state"] for x in receipts(rig)] == ["unconfirmed"]
    if sent:
        assert rig.live.send_receipts() == 1                  # out with the digest, as not confirmed
    row = rig.ledger.db.execute("SELECT * FROM family_gmail WHERE key=?", (r["gmail_key"],)).fetchone()
    later = when(rig, days=4, hour=13)
    rig.gm._moved(row, Want(row["key"], row["title"], later, later + timedelta(hours=1),
                            place=CLINIC, state="confirmed"))
    return row, later


def test_a_block_not_confirmed_then_moved_is_read_again_where_it_is(drives):
    """Its receipt hadn't gone out: its reads start over where the block is now, and once a read
    finds it there, it says Added, at the new time."""
    row, later = not_confirmed_then_moved(drives, sent=False)
    [r] = receipts(drives)
    assert r["state"] == "written" and r["reads"] == 0
    block = google_cal.Block(row["event_id"], '"9"', row["title"], later, later + timedelta(hours=1), True, CLINIC)
    drives.gm._read_back({row["event_id"]: block}, drives.clock(), later + timedelta(days=30))
    [r] = receipts(drives)
    assert r["state"] == "new" and datetime.fromisoformat(r["start"]) == later
    assert "not confirmed" not in drives.live.digest_line()
    assert drives.live.send_receipts() == 1
    drives.tick()
    _, text, _, _ = drives.with_button("Not mine")
    assert text.startswith("Added to your Gmail: Busy (family), ") and ", 1:00 PM to 2:00 PM, " in text


def test_a_not_confirmed_receipt_already_sent_stays_as_it_went_after_a_move(drives):
    not_confirmed_then_moved(drives, sent=True)
    [r] = receipts(drives)
    assert r["state"] == "shown" and r["reads"] == meaning_live.READS_TO_CONFIRM
    assert drives.live.written() == [] and drives.live.send_receipts() == 0


def test_receipts_waiting_from_before_wait_for_a_read(tmp_path):
    """Unsent receipts from before 0.22.0 were never read back: the first open makes them wait for a
    read like a new one, once."""
    path = str(tmp_path / "old.sqlite")
    old = Ledger(path)
    for rid, state in (("k.0", "new"), ("k.1", "shown")):
        old.db.execute("INSERT INTO meaning_receipts(id, gmail_key, title, said, start, end, features, state,"
                       " action, created_at, updated_at) VALUES(?,'k','Busy (watching kids)','Swim',"
                       " '2026-11-20T13:00:00+00:00','2026-11-20T14:00:00+00:00','{}',?,'','x','x')", (rid, state))
    old.db.execute("ALTER TABLE meaning_receipts DROP COLUMN reads")
    old.db.close()
    again = Ledger(path)
    assert dict(again.db.execute("SELECT id, state FROM meaning_receipts").fetchall()) == {"k.0": "written",
                                                                                         "k.1": "shown"}
    again.db.execute("UPDATE meaning_receipts SET state='new' WHERE id='k.0'")   # found since
    again.db.close()
    third = Ledger(path)
    assert third.db.execute("SELECT state FROM meaning_receipts WHERE id='k.0'").fetchone()[0] == "new"   # once


def test_the_place_is_ours_so_the_block_still_follows_and_goes(drives):
    start = when(drives, days=3, hour=10)
    path = goes(drives, "Eye doctor", start, CLINIC)
    seed(drives, "Book club", when(drives, days=9))           # Family isn't otherwise empty
    drives.judge.by["Book club"] = judged()
    go(drives)
    go(drives)
    writes = len(drives.google.writes())
    go(drives)                                               # the place we wrote isn't his edit
    assert len(drives.google.writes()) == writes and states(drives) == {"live"}
    later = when(drives, days=4, hour=13)
    goes(drives, "Eye doctor", later, CLINIC)                 # moved on Family
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", later - 30 * M, later, ""),
        ("Busy (family)", later, later + 60 * M, CLINIC),
        ("Busy (drive back)", later + 60 * M, later + 90 * M, "")]
    assert states(drives) == {"live"} and count(drives, "family_gmail_moved") == 3
    del drives.icloud.events[path]                            # cancelled on Family
    go(drives)
    assert len(blocks(drives)) == 3                           # never on one read
    go(drives)
    assert blocks(drives) == [] and states(drives) == {"cancelled"}


def test_a_new_address_moves_the_place_with_it(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    goes(drives, "Eye doctor", start, PARK)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", start - 30 * M, start, ""),
        ("Busy (family)", start, start + 60 * M, PARK),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    assert states(drives) == {"live"}


def test_a_place_he_types_on_the_block_makes_it_his(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    uid = next(k for k, e in drives.google.live().items() if e["summary"] == "Busy (family)")
    drives.google.hand_edit(uid, location="Back entrance, 2 Clinic Rd")
    goes(drives, "Eye doctor", start + timedelta(hours=2), CLINIC)
    go(drives)
    go(drives)
    row = drives.ledger.db.execute("SELECT state FROM family_gmail WHERE event_id=?", (uid,)).fetchone()
    assert row["state"] == "hands_off"
    assert drives.google.live()[uid]["location"] == "Back entrance, 2 Clinic Rd"


@pytest.mark.parametrize("place", ["Dr Patel's office", "https://example.com/visit", "Zoom call"])
def test_a_name_link_or_call_writes_no_place_and_no_drive(drives, place):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, place)
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "")]
    # A name the map doesn't know near home (places.py, test_places.py) is looked up once, by
    # itself; a link or a call never is.
    sent = [parse_qs(urlsplit(u).query)["q"][0] for u in drives.maps.urls]
    assert sent == ([place] if place.startswith("Dr") else [])


def test_no_home_no_drive_but_the_place_still_goes_on(drives):
    drives.home = ""
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, CLINIC)]
    assert drives.maps.urls == []


def test_a_home_it_cant_read_says_so(drives):
    drives.home = "the farm"
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    assert [b[0] for b in blocks(drives)] == ["Busy (family)"]
    assert "home in Harness's settings doesn't look like" in drives.ledger.get_meta("family_gmail_problem")


def test_home_as_a_street_address_is_looked_up_once(drives):
    drives.home = "5 Farm Ln, Town, VA"
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    POINTS["5 Farm Ln, Town, VA"] = POINTS["home"]            # the map finds home where it is
    try:
        go(drives)
        go(drives)
    finally:
        del POINTS["5 Farm Ln, Town, VA"]
    assert [b[0] for b in blocks(drives)] == ["Busy (drive there)", "Busy (family)", "Busy (drive back)"]
    asked = [parse_qs(urlsplit(u).query)["q"][0] for u in drives.maps.urls if drive.GEOCODE_HOST in u]
    assert sorted(asked) == sorted({CLINIC, "5 Farm Ln, Town, VA"})


def test_a_lookup_that_fails_leaves_the_drive_off_and_says_so(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    drives.maps.fail = "timeout"
    go(drives)
    go(drives)
    assert [b[0] for b in blocks(drives)] == ["Busy (family)"]
    note = drives.ledger.get_meta("family_gmail_problem")
    local = start.astimezone(NY)
    assert note == ("Blocks on Gmail from Family: couldn't look up the drive for the event at "
                    f"{local:%b} {local.day}, {local.hour % 12 or 12}:{local:%M}, so a drive block is missing. "
                    "I'll try again at the next read.")
    assert "Eye" not in note and "Clinic" not in note and "more" not in note
    drives.maps.fail = None
    go(drives)
    assert [b[0] for b in blocks(drives)] == ["Busy (drive there)", "Busy (family)", "Busy (drive back)"]
    assert not drives.ledger.get_meta("family_gmail_problem")


def test_a_place_the_map_cant_find_leaves_the_drive_off_and_says_so(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, "40 Nowhere Rd, Town, VA")
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "40 Nowhere Rd, Town, VA")]
    assert "couldn't find a drive to the event at" in drives.ledger.get_meta("family_gmail_problem")


def test_the_drive_keys_are_fixed_and_not_the_events():
    k = "a" * 32
    assert leg_key(k, "there") == leg_key(k, "there") != leg_key(k, "back") != k
    assert len(leg_key(k, "there")) == 32


def test_a_maybe_events_drives_are_maybe_too():
    assert _leg_title("there", "provisional") == meaning.MAYBE[meaning.TITLE["drive_there"]]
    assert _leg_title("back", "confirmed") == meaning.TITLE["drive_back"]


def test_home_is_read_from_the_options(tmp_path):
    assert home_from_options(str(tmp_path)) == ""
    (tmp_path / "options.json").write_text('{"home_location": " 38.5, -78.5 "}')
    assert home_from_options(str(tmp_path)) == "38.5, -78.5"


def test_home_and_places_as_the_drive_service_takes_them():
    assert drive.coordinates("38.5, -78.5") == "-78.5,38.5"
    assert drive.coordinates("38.5,-78.5") == "-78.5,38.5"
    assert drive.coordinates("138.5, -78.5") == "" and drive.coordinates("5 Farm Ln") == ""


def test_an_event_already_on_gmail_still_gets_its_drives(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    drives.feeds.window.occurrences.append(occ("Eye doctor", start))   # he put it on Gmail himself
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", start - 30 * M, start, ""),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]


def test_an_event_judged_as_his_drive_gets_no_second_drive(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    drives.judge.by["Eye doctor"] = judged(
        ob("presence", start, start + 60 * M, place="event_location"),
        ob("transport", start - 30 * M, start, place="event_location",
           rstart=(start + 60 * M).isoformat(), rend=(start + 90 * M).isoformat()),
        cites=[answer_ex(drives, "Eye doctor", ["presence"])])
    go(drives)
    go(drives)
    titles = [b[0] for b in blocks(drives)]
    assert titles.count("Busy (drive there)") == 1 and titles.count("Busy (drive back)") == 1


def test_undo_takes_the_events_drives_off_with_it_at_once(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    assert [b[0] for b in blocks(drives)] == ["Busy (drive there)", "Busy (family)", "Busy (drive back)"]
    go(drives)                                                # the read that finds it as written
    assert drives.live.send_receipts() == 1
    drives.tick()
    card = drives.with_button("Not mine")
    drives.press(card, "Not mine")
    drives.tick()                                             # no new read: the tap does it
    assert drives.google.live() == {}



def test_drive_time_rounds_up_to_the_quarter_hour(drives):
    # 31 minutes each way shows as 45, so the drive starts on a quarter hour and never cuts it
    # fine (Dane, Nov 9). Exactly 15 stays 15.
    drives.maps.minutes[frozenset({"home", CLINIC})] = 31
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", start - 45 * M, start, ""),
        ("Busy (family)", start, start + 60 * M, CLINIC),
        ("Busy (drive back)", start + 60 * M, start + 105 * M, "")]


def test_an_event_with_no_block_says_why_once(live, caplog):
    # Nov 10: the turkey harvest had his answer yet no block, and nothing said why.
    harvest = when(live, days=4, hour=9)
    seed(live, "Turkey harvest", harvest, hours=7)
    answer_ex(live, "Turkey harvest", ["presence"])
    live.judge.script = [judged(ob("presence", harvest, harvest + timedelta(hours=7), certainty="medium"))]
    caplog.set_level("INFO", logger="harness.meaning_live")
    go(live)
    go(live)
    assert live.google.titles() == []
    said = [r.getMessage() for r in caplog.records if r.getMessage().startswith("no block for")]
    assert len(said) == 1, said                                # once, not every read
    assert "Turkey harvest" in said[0] and "not backed by one of his answers" in said[0]
    assert "presence medium" in said[0]
    go(live)
    assert sum(r.getMessage().startswith("no block for") for r in caplog.records) == 1


def test_why_names_each_gate():
    from harness.meaning import Judgment, Rel
    sure = Rel("presence", 0, 60, certainty="high")
    unsure = Rel("presence", 0, 60, certainty="medium")
    j = lambda *obs, u=False: Judgment(tuple(obs), (), u)
    assert meaning_live.no_block_why(j(sure), True, {}, ("presence", "no")).startswith("he answered no")
    assert meaning_live.no_block_why(j(), True, {}, None).startswith("judged as nothing")
    assert meaning_live.no_block_why(j(sure), False, {}, None).startswith("not backed")
    assert meaning_live.no_block_why(j(unsure), True, {}, None).startswith("the judge wasn't sure")
    assert meaning_live.no_block_why(j(sure, u=True), True, {}, None).startswith("the judge wasn't sure")


def test_the_why_counts_his_answers_for_the_words(live, caplog):
    harvest = when(live, days=4, hour=9)
    seed(live, "Turkey harvest", harvest, hours=7)
    old = answer_ex(live, "Turkey harvest", ["supervision"])
    meaning.add_example(live.ledger, source="answer", said="turkey harvest", words=family_rules.words("Turkey harvest"),
                        types=["presence"])                   # newer: overrules the first
    live.judge.script = [judged(ob("presence", harvest, harvest + timedelta(hours=7), certainty="medium"))]
    caplog.set_level("INFO", logger="harness.meaning_live")
    go(live)
    go(live)
    [said] = [r.getMessage() for r in caplog.records if r.getMessage().startswith("no block for")]
    assert said.endswith("his answers for these words: 1 active, 1 overruled; the judge saw it"), said
    assert old




def test_a_judgment_that_never_saw_his_answer_is_made_again_on_its_own(drives):
    # Nov 10: judged before his answer was in use; Cain's re-send was "already known", so
    # nothing re-judged it. Each read now re-judges what never saw a fitting answer of his.
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    sure = drives.judge.by["Eye doctor"]
    drives.judge.by["Eye doctor"] = judged(ob("presence", start, start + 60 * M, certainty="medium"), unsure=True)
    go(drives)
    go(drives)
    assert blocks(drives) == []
    drives.ledger.db.execute("UPDATE meaning_judgments SET candidates='[]'")   # judged without it
    drives.ledger.db.commit()
    drives.judge.by["Eye doctor"] = sure
    for _ in range(4):
        go(drives)
    assert [b[0] for b in blocks(drives)] == ["Busy (drive there)", "Busy (family)", "Busy (drive back)"]
    calls = len(drives.judge.calls)
    go(drives)
    go(drives)
    assert len(drives.judge.calls) == calls                   # seen now: never again


def test_his_dated_answer_decides_that_event_whatever_the_judge_says(drives):
    # Nov 10: the judge had his "ties me up" for the turkey harvest in front of it and stayed
    # unsure. An answer about that very event (a dated row) now decides it, like a card answer.
    harvest = when(drives, days=4, hour=9)
    goes(drives, "Turkey harvest", harvest, CLINIC, hours=7)
    drives.judge.by["Turkey harvest"] = judged(
        ob("presence", harvest, harvest + timedelta(hours=7), certainty="medium"), unsure=True)
    go(drives)
    go(drives)
    assert blocks(drives) == []

    def send(meaning_, day):
        rows, why = meaning_live.validate_rows({"rows": [
            {"kind": "Turkey harvest", "meaning": meaning_, "said_on": date.today().isoformat(),
             "for": day.date().isoformat()}]})
        assert why == ""
        drives.live.import_rows(rows)
        for _ in range(3):
            go(drives)
        return [b[0] for b in blocks(drives)]

    assert send("me", harvest + timedelta(days=7)) == []      # another day: still the judge's
    assert "Busy (family)" in send("me", harvest)
    assert [b for b in blocks(drives) if b[0] == "Busy (family)"][0][1:3] == (
        harvest, harvest + timedelta(hours=7))
    assert send("none", harvest) == []                        # his newer word wins


def test_a_dated_row_must_be_a_real_date():
    for bad in ("Nov 21", "2026-13-01", 20261121):
        rows, why = meaning_live.validate_rows({"rows": [{**ROW, "for": bad}]})
        assert rows is None and "for must be a date" in why
    rows, _ = meaning_live.validate_rows({"rows": [{**ROW, "for": "2026-11-21"}]})
    assert rows[0]["for"] == "2026-11-21"


# -- 8. a judgment already waiting is flagged once, not on every pass (0.21.2) ---------------------------

ONCE = "meaning: 1 judgments made again with an answer of his they hadn't seen"


def made_again(caplog):
    return [r.getMessage() for r in caplog.records if "made again with an answer" in r.getMessage()]


def revive_done(ledger):
    with ledger.tx() as db:
        ledger.set_meta("meaning_revived", "2", db)            # long done, as on the Pi


class Family:
    """Family as the judge reads it: the events in the window it asks for."""

    def __init__(self, *items):
        self.items = list(items)

    def items_between(self, start, end, tz):
        return caldav.Read([i for i in self.items if i.occ.end > start and i.occ.start < end], 0)


@pytest.fixture
def judging(lv):
    """The judge itself over Family, with a fake engine. Its work is held until released, as a
    model call takes a while and passes go on meanwhile."""
    lv.judge = FakeEngine("claude")
    lv.work = ManualExecutor()
    lv.family = Family()
    lv.m = meaning.MeaningShadow(lv.ledger, lv.family, lv.feeds, lv.work, engine_fn=lambda: lv.judge,
                                 on_fn=lambda: True, tz=TZ)
    lv.live = meaning_live.MeaningLive(lv.ledger, lv.m, lv.feeds, tz=TZ, on_fn=lambda: True)
    lv.live.bind(OWNER_ID)
    return lv


def turn(lv):
    """One controller pass, in its order: the judge, then the questions."""
    lv.m.run(paused=False)
    lv.live.tick(paused=False)


def test_a_judgment_the_judge_doesnt_reach_is_flagged_once_not_every_pass(lv, caplog):
    # Nov 11: a judgment the judge doesn't reach stays waiting (its event is outside the read or
    # gone, or a limit is hit), and every pass, about every 3 seconds, flagged it again: a log
    # line, a poke and a database write each time.
    far = item("Book club", local(lv, meaning.AHEAD_DAYS + 30))     # past what the judge reads
    key = judge(lv.ledger, far, rel("presence")).key                 # judged before his answer
    answer_ex(lv, "Book club", ["presence"])                         # in use; it never saw it
    revive_done(lv.ledger)
    caplog.set_level("INFO", logger="harness.meaning_live")
    lv.live.tick(paused=False)
    assert made_again(caplog) == [ONCE] and lv.shadow.pokes == 1
    assert meaning.stored(lv.ledger, key)["stale"] == 1
    writes = lv.ledger.db.total_changes
    lv.live.tick(paused=False)
    lv.live.tick(paused=False)
    assert made_again(caplog) == [ONCE] and lv.shadow.pokes == 1     # no line and no poke
    assert lv.ledger.db.total_changes == writes                      # and nothing written
    assert meaning.stored(lv.ledger, key)["stale"] == 1              # still waiting for the judge


def shadow_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("meaning shadow")]


@pytest.mark.parametrize("why", ["outside the read", "the day's calls used up"])
def test_the_real_judge_stays_quiet_while_a_judgment_waits_for_it(judging, caplog, why):
    # Nov 11 review: the judge itself, not a fake: while a judgment waits for it, passes log no
    # score line and write nothing.
    it = item("Book club", local(judging, meaning.AHEAD_DAYS + 30 if why == "outside the read" else 5))
    judging.family.items.append(it)
    judge(judging.ledger, it, rel("presence"))                     # judged before his answer
    answer_ex(judging, "Book club", ["presence"])                  # in use; it never saw it
    if why == "the day's calls used up":
        today = judging.clock().astimezone(NY).date().isoformat()
        with judging.ledger.tx() as db:
            judging.ledger.set_meta("meaning_calls", f"{today}:{meaning.MAX_PER_DAY}", db)
    revive_done(judging.ledger)
    caplog.set_level("INFO", logger="harness")
    turn(judging)                                                  # read, and flagged
    turn(judging)                                                  # the judge looks: nothing it may do
    scores, writes = shadow_lines(caplog), judging.ledger.db.total_changes
    for _ in range(3):
        turn(judging)
    assert shadow_lines(caplog) == scores and judging.ledger.db.total_changes == writes
    assert made_again(caplog) == [ONCE] and judging.judge.calls == []


def test_a_judgment_in_the_read_is_flagged_once_and_made_again_with_his_answer(judging, caplog):
    start = local(judging, 5)
    it = item("Book club", start)
    judging.family.items.append(it)
    key = judge(judging.ledger, it, rel("presence")).key            # judged before his answer
    eid = answer_ex(judging, "Book club", ["presence"])             # in use; it never saw it
    judging.judge.script = [judged(ob("presence", start, start + timedelta(hours=1)), cites=[eid])]
    revive_done(judging.ledger)
    caplog.set_level("INFO", logger="harness.meaning_live")
    turn(judging)                                                   # flagged
    turn(judging)                                                   # the judge is at it
    turn(judging)                                                   # and still is
    assert made_again(caplog) == [ONCE]
    judging.work.run_all()                                          # its answer comes back
    turn(judging)
    row = meaning.stored(judging.ledger, key)
    assert row["stale"] == 0 and json.loads(row["cites"]) == [eid]
    assert eid in json.loads(row["candidates"])                     # made again with it in front
    assert len(judging.judge.calls) == 1 and f"[{eid}]" in judging.judge.calls[0]["user"]
    turn(judging)
    assert made_again(caplog) == [ONCE]                             # seen now: never again
    assert meaning.rejudge_for(judging.ledger, [eid], only_unseen=True) == 0


def test_a_new_answer_still_marks_each_judgment_it_fits_but_not_one_already_waiting(lv):
    # Kept: a new answer of his marks each judgment it fits, when it comes in (a tap, an Undo,
    # Cain's table) and when a pass finds judgments that never saw it. Only what it newly marks
    # is counted: one already waiting, with features or from before they were kept, is left.
    swims = [item("Swim meet", local(lv, days)) for days in (3, 10, 17)]
    keys = [judge(lv.ledger, it, rel()).key for it in swims]
    judge(lv.ledger, item("Book club", local(lv, 4)), rel())        # one it doesn't fit
    lv.ledger.db.execute("UPDATE meaning_judgments SET stale=1 WHERE key=?", (keys[2],))   # waiting
    lv.ledger.db.execute(                                           # waiting, from before features
        "INSERT INTO meaning_judgments(key, kind, fingerprint, anchor, obligations, cites, unsure, status,"
        " failure, tries, policy_version, examples_version, model, judged_at, stale)"
        " VALUES('e:old','single','fp','2026-08-15','[]','[]',1,'ok','',1,'p','v','m','2026-08-01',1)")

    def waiting():
        return {r["key"] for r in lv.ledger.db.execute("SELECT key FROM meaning_judgments WHERE stale=1")}

    first = answer_ex(lv, "Swim meet", ["transport"])               # in use; none of them saw it
    assert meaning.rejudge_for(lv.ledger, [first], only_unseen=True) == 2
    assert waiting() == {*keys, "e:old"}
    for it in swims[:2]:
        judge(lv.ledger, it, rel())                                 # made again, with it in front
    newer = answer_ex(lv, "Swim meet", [])                          # his newer word, just in
    assert meaning.rejudge_for(lv.ledger, [newer]) == 2
    assert waiting() == {*keys, "e:old"}


def test_a_revive_that_fails_is_tried_again_at_the_next_read_not_every_pass(lv, caplog, monkeypatch):
    # Nov 11 review sweep: the one-time revive stayed pending after a failure, so every pass tried
    # it again, with a warning and a recorded failure each time, and the rest of the pass never ran.
    judge(lv.ledger, item("Book club", local(lv, meaning.AHEAD_DAYS + 30)), rel("presence"))
    answer_ex(lv, "Book club", ["presence"])                        # in use; it never saw it
    revive = meaning.revive_answers

    def stopped(ledger):
        raise RuntimeError("the revive stopped")

    monkeypatch.setattr(meaning, "revive_answers", stopped)
    caplog.set_level("INFO", logger="harness.meaning_live")
    for _ in range(3):
        lv.live.tick(paused=False)
    warned = [r for r in caplog.records if r.getMessage().startswith("meaning questions failed")]
    assert len(warned) == 1 and count(lv, "meaning_live_failed") == 1
    assert made_again(caplog) == [ONCE] and lv.shadow.pokes == 1    # the rest of the pass runs
    monkeypatch.setattr(meaning, "revive_answers", revive)
    lv.feeds.generation += 1                                        # the next read
    lv.live.tick(paused=False)
    assert lv.ledger.get_meta("meaning_revived") == "2"


# -- 9. idle passes are quiet (0.21.2) -------------------------------------------------------------------

def test_idle_passes_are_quiet(live, caplog):
    # Nov 11: with nothing new, the Pi logged and wrote its database every 3 seconds. A gate: with
    # what runs on every pass in place and settled, a pass with nothing new logs nothing at INFO or
    # above and writes nothing. Not here: the calendar reads themselves (the rig's are fakes) and
    # what only runs with Discord (Cain's link, once a minute).
    seen = inputs.Seen()
    live.fa.client.seen = live.client.seen = seen                  # what iCloud and Google answer
    live.c.inputs = inputs.Watch(live.ledger, seen, tz=TZ, active={
        inputs.MAIL: lambda: True, inputs.FAMILY: lambda: True, inputs.GOOGLE: lambda: True,
        inputs.MEANING: lambda: live.live_on})
    live.c.family_copy = FamilyCopy(live.ledger, live.fa, live.feeds, name_fn=lambda: "Lee", tz=TZ)
    live.c.calendar_change = CalendarChange(live.ledger, live.fa.client, live.client, enabled=lambda: True,
                                            address=live.gm._address, tz=TZ)
    live.c.mail_dates = MailDates(live.ledger, live.client, SyncExecutor(), address=live.gm._address,
                                  password=lambda: "abcdefghijklmnop", engine_fn=lambda: live.claude,
                                  writes_on=lambda: True, tz=TZ, mailbox=Box([]), sleep=lambda s: None,
                                  family=live.fa.client)            # nothing new in his mail
    live.c.config = None                                           # the controller binds them all
    # On Family: a block on Gmail from his answer, a question waiting on him, and a judgment the
    # judge doesn't reach with an answer of his it never saw (Nov 11 on the Pi).
    live.feeds.window.occurrences = [occ("Errand", when(live, days=20, hour=15))]   # Gmail is read
    club, sitting = when(live, days=3), when(live, days=2, hour=15)
    seed(live, "Book club", club)
    seed(live, "Kid sitting", sitting)
    eid = answer_ex(live, "Book club", ["presence"])
    live.judge = ByTitle()
    live.judge.by["Book club"] = judged(ob("presence", club, club + timedelta(hours=1)), cites=[eid])
    live.judge.by["Kid sitting"] = judged(ob("supervision", sitting, sitting + timedelta(hours=2),
                                             certainty="medium"))
    judge(live.ledger, item("Swim meet", local(live, meaning.AHEAD_DAYS + 30)), rel("presence"))
    answer_ex(live, "Swim meet", ["presence"])
    for _ in range(3):
        go(live)                                                   # read, judged, on Gmail, asked
    live.tick()
    assert live.google.titles() == ["Busy (family)"] and len(open_q(live.ledger)) == 1
    caplog.clear()
    caplog.set_level(logging.INFO)
    writes = live.ledger.db.total_changes
    for _ in range(5):
        live.clock.advance(seconds=3)                              # a pass every 3 seconds
        live.tick()
    assert [f"{r.name}: {r.getMessage()}" for r in caplog.records if r.levelno >= logging.INFO] == []
    assert live.ledger.db.total_changes == writes


# -- 8. drive blocks for his own appointments on Gmail (0.24.0) --------------------------------------------

def mine(rig, title, start, location, hours=1, **kw):
    """An appointment of his own on his Gmail calendar (he's its organizer)."""
    o = occ(title, start, hours=hours, location=location, **kw)
    rig.feeds.window.occurrences.append(o)
    return o


def quiet_family(rig):
    """Family isn't empty, and nothing on it ties him up."""
    seed(rig, "Book club", when(rig, days=9))
    rig.judge.by["Book club"] = judged()


def family_snapshot(rig):
    return dict(rig.icloud.family())


def drive_cards_sent(rig):
    return [s for s in rig.bot.sent if s[1].startswith("No drive blocks")]


def test_his_own_appointment_with_a_street_address_gets_two_drive_blocks(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, "Smile Dental\n" + CLINIC)        # a name, then the street line
    before = family_snapshot(drives)
    go(drives)
    go(drives)
    # Drive blocks only: the appointment is already on his calendar, so it gets no block of its own.
    assert blocks(drives) == [
        ("Busy (drive there)", start - 30 * M, start, ""),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    asked = [parse_qs(urlsplit(u).query)["q"][0] for u in drives.maps.urls if drive.GEOCODE_HOST in u]
    assert asked == [CLINIC]                                        # the street line only, never the name
    # Nothing new on Family, from any of it.
    assert family_snapshot(drives) == before
    assert not [x for x in drives.icloud.log if x[0] in ("PUT", "DELETE")]


def test_his_appointment_moving_or_going_takes_its_drives_with_it(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    o = mine(drives, "Dentist", start, CLINIC)
    go(drives)
    go(drives)
    later = when(drives, days=4, hour=13)
    drives.feeds.window.occurrences.remove(o)
    o = mine(drives, "Dentist", later, CLINIC)                      # moved: same event, same uid
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", later - 30 * M, later, ""),
        ("Busy (drive back)", later + 60 * M, later + 90 * M, "")]
    drives.feeds.window.occurrences.remove(o)                       # cancelled
    go(drives)
    assert len(blocks(drives)) == 2                                 # never on one read
    go(drives)
    assert blocks(drives) == []


def test_his_appointments_drives_get_a_card_with_undo(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, CLINIC)
    go(drives)                                                      # written: the card waits for a read
    assert drives.gm.send_drive_receipts() == 0
    go(drives)                                                      # the read that finds them
    assert drives.gm.send_drive_receipts() == 1
    drives.tick()
    card = drives.with_button("Undo")
    assert card[1].startswith("Added to your Gmail: Busy (drive there) 9:30 AM to 10:00 AM and "
                              "Busy (drive back) 11:00 AM to 11:30 AM, ")
    local = start.astimezone(NY)
    assert card[1].endswith(f", {local:%a %b} {local.day}, for Dentist at 10:00 AM on your calendar. Nothing to "
                            "do if that's right; tap Undo only if it's wrong.")
    drives.press(card, "Undo")
    drives.tick()                                                   # no new read: the tap does it
    assert blocks(drives) == []
    go(drives)
    go(drives)
    assert blocks(drives) == []                                     # off for that event from now on
    assert drives.gm.send_drive_receipts() == 0


def test_a_moved_appointments_drives_get_a_moved_card(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    o = mine(drives, "Dentist", start, CLINIC)
    go(drives)
    go(drives)
    go(drives)
    assert drives.gm.send_drive_receipts() == 1
    drives.feeds.window.occurrences.remove(o)
    later = when(drives, days=4, hour=13)
    mine(drives, "Dentist", later, CLINIC)
    go(drives)
    go(drives)
    assert drives.gm.send_drive_receipts() == 1
    drives.tick()
    card = drives.with_button("Undo")
    assert card[1].startswith("Moved on your Gmail: Busy (drive there) 12:30 PM to 1:00 PM and ")


def test_back_to_back_his_drive_starts_at_the_place_before(drives):
    # A Family event he goes to at the clinic, then his own appointment at the park half an hour
    # after: no time to go home between, so the drive is clinic to park, and only the last goes home.
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    goes(drives, "Eye doctor", a, CLINIC)
    mine(drives, "Haircut", b, "Shear Joy, " + PARK)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", a - 30 * M, a, ""),
        ("Busy (family)", a, a + 60 * M, CLINIC),
        ("Busy (drive there)", b - 15 * M, b, ""),
        ("Busy (drive back)", b + 60 * M, b + 90 * M, "")]


def test_two_of_his_own_back_to_back_chain_too(drives):
    quiet_family(drives)
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    mine(drives, "Dentist", a, CLINIC)
    mine(drives, "Haircut", b, PARK)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", a - 30 * M, a, ""),
        ("Busy (drive there)", b - 15 * M, b, ""),
        ("Busy (drive back)", b + 60 * M, b + 90 * M, "")]


@pytest.mark.parametrize("kw", [
    dict(location="https://example.com/visit"),                     # a link
    dict(location="Telehealth"),                                    # a call
    dict(title="Telehealth check-in"),
    dict(location=""),                                              # nowhere to drive to
    dict(organizer="someone@example.com"),                          # someone else's invitation
    dict(transparent=True),                                         # shown free
    dict(title="Busy"),                                             # a hold
])
def test_what_gets_no_drive_of_its_own(drives, kw):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    title = kw.pop("title", "Dentist")
    kw.setdefault("location", CLINIC)
    mine(drives, title, start, **kw)
    go(drives)
    go(drives)
    assert blocks(drives) == []
    assert drive_cards_sent(drives) == []


def test_an_all_day_event_gets_no_drive(drives):
    quiet_family(drives)
    d = when(drives, days=3).date()
    drives.feeds.window.occurrences.append(ical.Occurrence(d, d + timedelta(days=1), True, "Conference", GMAIL,
                                                           False, "conf", "", (), CLINIC, GMAIL))
    go(drives)
    go(drives)
    assert blocks(drives) == []


def test_a_failed_lookup_is_named_in_the_digest_and_gets_one_card(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, CLINIC)
    drives.maps.fail = "timeout"
    go(drives)
    go(drives)
    local = start.astimezone(NY)
    note = drives.gm.digest_line()
    assert (f"couldn't look up the drive for the event at {local:%b} {local.day}, 10:00, so a drive "
            "block is missing") in note
    assert "Dentist" not in note and "Clinic" not in note
    go(drives)
    go(drives)
    drives.tick()
    [card] = drive_cards_sent(drives)                               # one, however many reads fail
    assert card[1] == (f"No drive blocks for the event on {local:%a %b} {local.day} at 10:00 AM: the drive "
                       "lookup failed. I'll keep trying at each read; tap Skip to leave it without drive blocks.")
    assert labels(card[2]) == ["Skip"]
    drives.press(card, "Skip")
    drives.maps.fail = None
    go(drives)
    go(drives)
    assert blocks(drives) == []                                     # skipped: no drives, no more cards
    assert len(drive_cards_sent(drives)) == 1
    assert "couldn't look up" not in (drives.ledger.get_meta("family_gmail_problem") or "")


def test_one_failed_read_alone_sends_no_card(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, CLINIC)
    go(drives)                                                      # Family judged; no lookups yet
    drives.maps.fail = "timeout"
    go(drives)
    drives.maps.fail = None
    go(drives)
    drives.tick()
    assert drive_cards_sent(drives) == []
    assert [b[0] for b in blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]


def test_a_place_the_map_cant_find_gets_one_card_naming_no_usable_address(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, "40 Nowhere Rd, Town, VA")
    for _ in range(4):
        go(drives)
    drives.tick()
    local = start.astimezone(NY)
    [card] = drive_cards_sent(drives)
    assert card[1].startswith(f"No drive blocks for the event on {local:%a %b} {local.day} at 10:00 AM: "
                              "no usable address.")
    assert "couldn't find a drive to the event at" in drives.gm.digest_line()


def test_a_place_book_question_is_the_card_never_a_second(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, "Dr Patel's office")             # a name the map doesn't know
    for _ in range(4):
        go(drives)
    drives.tick()
    asks = [s for s in drives.bot.sent if s[1].startswith("Where is")]
    assert len(asks) == 1 and "Dr Patel" in asks[0][1]
    assert drive_cards_sent(drives) == []
    assert "couldn't find a drive to the event at" in drives.gm.digest_line()


def test_a_family_event_with_a_two_line_location_gets_its_address_and_drives(drives):
    # Nov 19: the venue's name on the first line, its street address on the second.
    start = when(drives, days=3, hour=14)
    goes(drives, "Concert", start, "Blue Ridge Music Hall\\n" + CLINIC)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", start - 30 * M, start, ""),
        ("Busy (family)", start, start + 60 * M, CLINIC),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]


def test_a_family_event_whose_drive_fails_gets_one_card_too(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)                                                      # judged
    drives.maps.fail = "timeout"
    go(drives)
    go(drives)
    go(drives)
    drives.tick()
    assert len(drive_cards_sent(drives)) == 1
    assert [b[0] for b in blocks(drives)] == ["Busy (family)"]


def test_his_own_appointment_at_a_family_events_time_is_that_event(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    mine(drives, "Eye doctor", start, CLINIC)                       # he put it on Gmail too
    go(drives)
    go(drives)
    titles = [b[0] for b in blocks(drives)]
    assert titles.count("Busy (drive there)") == 1 and titles.count("Busy (drive back)") == 1


def test_a_gmail_read_that_fails_keeps_his_drives(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, CLINIC)
    go(drives)
    go(drives)
    assert len(blocks(drives)) == 2
    drives.feeds.window.unreadable = 1                              # not all of Gmail could be read
    go(drives)
    go(drives)
    go(drives)
    assert len(blocks(drives)) == 2


# -- 9. drive blocks for his own appointments, second round (0.24.0) ---------------------------------------

class AnyMaps(Maps):
    """The map services, for any street address: a point of its own, and 20 minutes from home."""

    def request(self, method, url, *, headers=None, timeout=30):
        parts = urlsplit(url)
        if parts.hostname == drive.GEOCODE_HOST and not self.fail:
            q = parse_qs(parts.query)["q"][0]
            if q not in POINTS:
                self.urls.append(url)
                n = int(hashlib.sha256(q.encode()).hexdigest()[:4], 16) / 1e6
                return HttpResponse(200, {}, f'[{{"lat": "{38 + n}", "lon": "{-78 - n}"}}]'.encode())
        if parts.hostname == drive.ROUTE_HOST and not self.fail:
            self.urls.append(url)
            return HttpResponse(200, {}, b'{"routes": [{"duration": 1200}]}')
        return super().request(method, url, headers=headers, timeout=timeout)


@pytest.mark.parametrize("title,location", [
    ("Dr Patel", "540-555-1212"),                                   # a phone number for a place
    ("Dr Patel", "(540) 555-1212"),
    ("Phone call with Dr Patel", "Dr Patel's office"),              # a title naming a call
    ("Dr Patel", "Phone: Dr Patel's office"),                       # a location naming one
    ("Call with Sam", "Sam's office"),                            # a call, and no street address
])
def test_a_phone_call_gets_no_drive_and_no_card(drives, title, location):
    quiet_family(drives)
    mine(drives, title, when(drives, days=1, hour=10), location)
    for _ in range(4):
        go(drives)
    drives.tick()
    assert blocks(drives) == []
    assert drive_cards_sent(drives) == []
    assert [s for s in drives.bot.sent if s[1].startswith("Where is")] == []
    assert "drive" not in (drives.gm.digest_line() or "")


def test_a_chained_pair_whose_first_cant_be_placed_drives_the_second_from_home(drives):
    quiet_family(drives)
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    mine(drives, "Dentist", a, "40 Nowhere Rd, Town, VA")           # a street the map doesn't know
    mine(drives, "Haircut", b, PARK)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", b - 30 * M, b, ""),                  # from home: 25 minutes, rounded up
        ("Busy (drive back)", b + 60 * M, b + 90 * M, "")]
    local = a.astimezone(NY)
    note = drives.gm.digest_line()
    assert f"couldn't find a drive to the event at {local:%b} {local.day}, 10:00" in note
    assert "11:30" not in note


def test_a_chained_pair_whose_first_lookup_fails_names_the_second_too(drives):
    quiet_family(drives)
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    mine(drives, "Dentist", a, CLINIC)
    mine(drives, "Haircut", b, PARK)
    go(drives)                                                      # Family judged
    real = drives.gm.drives.between

    def between(origin, destination):                               # only the clinic's way home fails
        if origin == CLINIC and destination == drive.HOME:
            return drive.FAILED
        return real(origin, destination)
    drives.gm.drives.between = between
    for _ in range(3):
        go(drives)
    drives.tick()
    note = drives.gm.digest_line()
    assert "10:00" in note and "11:30" in note                      # both named, never one silently
    assert len(drive_cards_sent(drives)) == 2


def test_new_addresses_past_the_lookup_allowance_wait_then_are_named_by_their_own_count(drives):
    """Past the allowance, a lookup waits for the next read, quietly for its first reads. Since 0.24.1's
    fourth round each leg counts its own reads waiting (others getting through don't start it again), so
    one still waiting at its third read is named; every drive is written once the queue drains."""
    drives.maps = AnyMaps()
    drives.gm.drives.transport = drives.maps
    quiet_family(drives)
    starts = [when(drives, days=2 + n, hour=10) for n in range(11)]
    for n, start in enumerate(starts):
        mine(drives, f"Visit {n}", start, f"{n + 10} Oak St, Town, VA")
    for _ in range(2):
        go(drives)
        assert drive_cards_sent(drives) == []
        assert "couldn't look up" not in (drives.gm.digest_line() or "")
    for _ in range(6):
        go(drives)
        waits = json.loads(drives.ledger.get_meta(family_gmail.WAIT_COUNTS) or "{}")
        assert all(n <= 8 for n in waits.values())
    drives.tick()
    assert [b[1] for b in blocks(drives) if b[0] == "Busy (drive there)"] == [s - 30 * M for s in starts]
    assert json.loads(drives.ledger.get_meta(family_gmail.WAIT_COUNTS) or "{}") == {}   # all through


def test_a_partial_gmail_read_keeps_his_drives_but_never_chains_the_family_event_to_them(drives):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    goes(drives, "Eye doctor", a, CLINIC)
    mine(drives, "Haircut", b, PARK)
    go(drives)
    go(drives)
    before = blocks(drives)
    assert [x[0] for x in before] == ["Busy (drive there)", "Busy (family)", "Busy (drive there)",
                                      "Busy (drive back)"]
    drives.feeds.window.unreadable = 1                              # not all of Gmail could be read
    for _ in range(3):
        go(drives)
        # The eye doctor, read in full on Family, gets its own drive home: the haircut wasn't read, so
        # its place is no stop for it. The haircut's drive there it crosses stays exactly as it was, busy.
        assert blocks(drives) == [before[0], before[1],
                                  ("Busy (drive back)", a + 60 * M, a + 90 * M, ""), before[2], before[3]]
        assert not [b for b in blocks(drives) if b[0].startswith("Maybe busy")]
    drives.feeds.window.unreadable = 0
    go(drives)
    go(drives)
    assert blocks(drives) == before


def test_after_the_place_book_answers_a_failing_lookup_gets_its_card(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, "Dr Patel's office")             # a name the map doesn't know
    for _ in range(4):
        go(drives)
    drives.tick()
    assert len([s for s in drives.bot.sent if s[1].startswith("Where is")]) == 1
    drives.live.places.import_rows([{"key": places.place_key("Dr Patel's office"), "address": PARK,
                                     "skip": False, "said_on": "2026-11-01"}])
    drives.maps.fail = "timeout"
    for _ in range(3):
        go(drives)
    drives.tick()
    [card] = drive_cards_sent(drives)
    assert "the drive lookup failed" in card[1]


def test_a_place_he_skipped_isnt_named_in_the_digest(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, "Dr Patel's office")
    for _ in range(4):
        go(drives)
    drives.tick()
    [ask] = [s for s in drives.bot.sent if s[1].startswith("Where is")]
    assert "couldn't find a drive" in drives.gm.digest_line()
    drives.press(ask, "Skip")
    go(drives)
    go(drives)
    assert "couldn't find a drive" not in (drives.gm.digest_line() or "")
    assert drive_cards_sent(drives) == []


# -- 10. drive blocks for his own appointments, third round (0.24.0) ---------------------------------------

def weekly(rig, title, first, location, weeks=4, uid="weekly-pt", hours=1):
    """A weekly series of his own on Gmail: one uid, each instance its own (its original start), its
    master read in full (ical.Window.series), as the feed's expander gives it."""
    rig.feeds.window.series.add(uid)
    out = []
    for n in range(weeks):
        start = first + timedelta(weeks=n)
        out.append(mine(rig, title, start, location, hours=hours, uid=uid,
                        instance=start.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
    return out


def legs_by_day(rig):
    """Drive blocks on Gmail, each day's (title, start) list."""
    out = {}
    for title, start, end, _ in blocks(rig):
        if "drive" in title:
            out.setdefault(start.astimezone(NY).date(), []).append((title, start))
    return out


def no_two_overlap(rig):
    """No drive block on Gmail overlaps another: never two sets for one trip."""
    legs = [(s, e) for t, s, e, _ in blocks(rig) if "drive" in t]
    return all(not (a[0] < b[1] and b[0] < a[1]) for i, a in enumerate(legs) for b in legs[i + 1:])


def own_key(o):
    return hashlib.sha256(f"{o.uid}|{o.instance}|own".encode()).hexdigest()[:32]


def test_a_weekly_series_gets_one_drive_pair_per_instance_keyed_by_its_full_instance(drives):
    quiet_family(drives)
    occs = weekly(drives, "PT", when(drives, days=2, hour=10), CLINIC)
    go(drives)
    go(drives)
    there = [b for b in blocks(drives) if b[0] == "Busy (drive there)"]
    back = [b for b in blocks(drives) if b[0] == "Busy (drive back)"]
    assert [b[2] for b in there] == [o.start for o in occs]
    assert [b[1] for b in back] == [o.end for o in occs]
    keys = {r["key"] for r in drives.ledger.db.execute("SELECT key FROM drive_cards WHERE kind='own'")}
    assert keys == {own_key(o) for o in occs} and len(keys) == 4      # uid and the whole instance id


def test_one_moved_instance_takes_its_drives_with_it_and_gets_one_card(drives):
    quiet_family(drives)
    occs = weekly(drives, "PT", when(drives, days=2, hour=10), CLINIC)
    for _ in range(3):
        go(drives)
    assert drives.gm.send_drive_receipts() == 4
    moved = occs[1]
    later = moved.start + timedelta(days=1, hours=4)
    drives.feeds.window.occurrences.remove(moved)
    mine(drives, "PT", later, CLINIC, uid=moved.uid, instance=moved.instance)   # same instance, new time
    for _ in range(3):
        go(drives)
        assert len([b for b in blocks(drives) if b[0] == "Busy (drive there)"]) == 4
        assert no_two_overlap(drives)
    starts = [b[2] for b in blocks(drives) if b[0] == "Busy (drive there)"]
    assert later in starts and moved.start not in starts
    assert drives.gm.send_drive_receipts() == 1                         # exactly one card, for the move
    drives.tick()
    assert drives.with_button("Undo")[1].startswith("Moved on your Gmail: Busy (drive there) 1:30 PM to 2:00 PM")
    assert drives.gm.send_drive_receipts() == 0


def test_one_cancelled_instance_loses_its_drives_and_the_rest_stay(drives):
    quiet_family(drives)
    occs = weekly(drives, "PT", when(drives, days=2, hour=10), CLINIC)
    go(drives)
    go(drives)
    drives.feeds.window.occurrences.remove(occs[2])                     # that week cancelled
    go(drives)
    go(drives)
    starts = [b[2] for b in blocks(drives) if b[0] == "Busy (drive there)"]
    assert starts == [occs[0].start, occs[1].start, occs[3].start]
    assert len([b for b in blocks(drives) if b[0] == "Busy (drive back)"]) == 3


def test_the_whole_series_edited_never_leaves_two_drive_sets_for_a_day(drives):
    quiet_family(drives)
    occs = weekly(drives, "PT", when(drives, days=2, hour=10), CLINIC)
    go(drives)
    go(drives)
    for o in occs:
        drives.feeds.window.occurrences.remove(o)
    new = weekly(drives, "PT", when(drives, days=2, hour=12), CLINIC)    # every week now at noon: new instances
    removed = len([w for w in drives.google.writes() if w[0] == "DELETE"])
    for n in range(7):
        go(drives)
        # Each week's lost instance and its new one that day are one appointment, moved: no removal,
        # so nothing to hold or ask about.
        assert "look gone" not in (drives.gm.digest_line() or "")
        for day, legs in legs_by_day(drives).items():
            assert [t for t, _ in legs].count("Busy (drive there)") <= 1, day
            assert [t for t, _ in legs].count("Busy (drive back)") <= 1, day
    assert [b[2] for b in blocks(drives) if b[0] == "Busy (drive there)"] == [o.start for o in new]
    assert len([w for w in drives.google.writes() if w[0] == "DELETE"]) == removed
    assert not [s for s in drives.bot.sent if "Should their drive blocks come off" in s[1]]


def test_a_family_event_moved_or_cancelled_in_a_partial_read_leaves_one_drive_set(drives):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    c = when(drives, days=4, hour=10)
    goes(drives, "Eye doctor", a, CLINIC)
    mine(drives, "Haircut", b, PARK)
    goes(drives, "Swim lesson", c, PARK)
    go(drives)
    go(drives)
    drives.feeds.window.unreadable = 1                              # not all of Gmail could be read
    moved = when(drives, days=5, hour=13)
    goes(drives, "Eye doctor", moved, CLINIC)                       # across days, on Family
    goes(drives, "Swim lesson", a - timedelta(hours=2), PARK)       # into the haircut's day
    for _ in range(3):
        go(drives)
        assert no_two_overlap(drives)
    got = blocks(drives)
    eye = [x for x in got if moved - 60 * M <= x[1] <= moved + 120 * M]
    assert [x[0] for x in eye] == ["Busy (drive there)", "Busy (family)", "Busy (drive back)"]
    swim = a - timedelta(hours=2)
    assert ("Busy (drive there)", swim - 30 * M, swim, "") in got   # its drives came with it
    # The haircut's own drives are as they were: his appointment wasn't read.
    assert ("Busy (drive back)", b + 60 * M, b + 90 * M, "") in got
    # Nothing is left of the eye doctor's old day but the haircut's drives and the swim lesson.
    old_day = [x for x in got if x[1].astimezone(NY).date() == a.astimezone(NY).date()]
    assert not [x for x in old_day if a - 60 * M <= x[1] <= a + 60 * M and x[0] != "Busy (family)"
                and x[2] > swim + 60 * M + 30 * M]
    assert [x[1] for x in got if x[0] == "Busy (family)"].count(a) == 0
    # Cancelled on Family while Gmail is still partly read: its drives go too.
    del drives.icloud.events[f"{FAMILY_PATH}goes-{hashlib.sha256(b'Swim lesson').hexdigest()[:12]}.ics"]
    for _ in range(3):
        go(drives)
    assert not [x for x in blocks(drives) if swim - 60 * M <= x[1] <= swim + 90 * M]
    assert ("Busy (drive back)", b + 60 * M, b + 90 * M, "") in blocks(drives)


def test_partial_reads_through_a_departure_then_a_clean_read_add_no_second_leg(drives):
    quiet_family(drives)
    start = when(drives, days=0, hour=15)
    mine(drives, "Dentist", start, CLINIC)
    go(drives)
    go(drives)
    assert len(blocks(drives)) == 2
    added = count(drives, "family_gmail_added")
    drives.feeds.window.unreadable = 1
    for _ in range(8):                                              # 9:00 to 17:00, an hour a read
        drives.clock.advance(hours=1)
        go(drives)
        assert no_two_overlap(drives)
    drives.feeds.window.unreadable = 0
    drives.clock.advance(minutes=30)
    go(drives)
    go(drives)
    assert count(drives, "family_gmail_added") == added      # nothing written twice
    assert len(drives.google.live()) == 2


def test_a_day_with_no_clean_read_of_gmail_is_said_in_the_digest(drives):
    quiet_family(drives)
    mine(drives, "Dentist", when(drives, days=3, hour=10), CLINIC)
    go(drives)
    go(drives)
    drives.feeds.window.unreadable = 1
    go(drives)
    assert "hasn't been read in full" not in (drives.gm.digest_line() or "")
    drives.clock.advance(hours=25)
    go(drives)
    assert ("your Gmail calendar hasn't been read in full for a day, so the drives around your own "
            "appointments haven't changed") in drives.gm.digest_line()
    drives.feeds.window.unreadable = 0
    go(drives)
    assert "hasn't been read in full" not in (drives.gm.digest_line() or "")


@pytest.mark.parametrize("title,location", [
    ("Curtain call", "Town Theater, " + PARK),                      # an outing: the address wins
    ("Call of the Wild (play)", PARK),
    ("Recall clinic", PARK),
])
def test_a_place_to_go_with_call_in_its_title_keeps_its_drives(drives, title, location):
    quiet_family(drives)
    start = when(drives, days=3, hour=19)
    mine(drives, title, start, location)
    go(drives)
    go(drives)
    assert [b[0] for b in blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]


@pytest.mark.parametrize("location", [
    "5405551212",                                                   # a bare number
    "+1 540 555 1212",
    "+44 20 7946 0958",                                             # a country code
    "(540) 555-1212 ext. 12",                                       # extensions
    "540.555.1212 x12",
    "1-800-FLOWERS",                                                # a vanity number
    "Dial-in: +1 540 555 1212, PIN: 4433#",                         # a labelled dial-in
    "Conference line 540-555-1212 access code 998877",
    "+1 540-555-1212,,123456#",
    "tel:+1-540-555-1212",                                          # a tel: address
    "tel:+15405551212;ext=55",
])
def test_a_phone_number_location_in_any_shape_gets_no_drive_and_no_card(drives, location):
    quiet_family(drives)
    mine(drives, "Dr Patel", when(drives, days=1, hour=10), location)
    for _ in range(4):
        go(drives)
    drives.tick()
    assert blocks(drives) == []
    assert drive_cards_sent(drives) == []
    assert [s for s in drives.bot.sent if s[1].startswith("Where is")] == []
    assert "drive" not in (drives.gm.digest_line() or "")
    assert not [u for u in drives.maps.urls if drive.GEOCODE_HOST in u]   # never sent to the map


def test_is_call_reads_numbers_not_addresses():
    assert drive.is_call("540-555-1212") and drive.is_call("Phone: Dr Patel's office")
    assert not drive.is_call(CLINIC) and not drive.is_call("Callahan's Pub, " + PARK)
    assert not drive.is_call("38.5, -78.5") and not drive.is_call("Suite 1200, 9 Park Ave, Town, VA 22901")
    assert not drive.is_call("Room 101")


class Undecided(ByTitle):
    """A judge that never manages to judge the titles named in `never`."""

    def __init__(self):
        super().__init__()
        self.never = set()

    def complete(self, *, system, user, schema):
        if any(f"title: {t}" in user for t in self.never):
            self.calls.append({"system": system, "user": user, "schema": schema})
            raise EngineError("timeout")
        return super().complete(system=system, user=user, schema=schema)


def test_an_appointment_beside_a_family_event_never_judged_gets_drives_from_home_in_time(drives):
    drives.judge = Undecided()
    quiet_family(drives)
    start = when(drives, days=1, hour=16)                           # 31 hours off
    seed(drives, "Mystery thing", start)
    drives.judge.never.add("Mystery thing")
    mine(drives, "Dentist", start, CLINIC)
    go(drives)
    go(drives)
    assert blocks(drives) == []                                     # waits for the judgment, at first
    drives.clock.advance(hours=20)                                  # 11 hours before it starts
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", start - 30 * M, start, ""),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    for _ in range(6):                                              # through his departure, still undecided
        drives.clock.advance(hours=1)
        go(drives)
    assert [b[0] for b in blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]
    assert count(drives, "family_gmail_added") == 2


def test_the_judgment_landing_late_recalculates_the_drives(drives):
    drives.judge = Undecided()
    quiet_family(drives)
    start = when(drives, days=0, hour=20)                           # within 12 hours: no waiting
    seed(drives, "Eye doctor", start, extra=["LOCATION:" + CLINIC.replace(",", "\\,")])
    drives.judge.never.add("Eye doctor")
    mine_occ = mine(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    assert [b[0] for b in blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]
    drives.judge.never.clear()                                      # judged at last: he goes himself
    eid = answer_ex(drives, "Eye doctor", ["presence"])
    drives.judge.by["Eye doctor"] = judged(ob("presence", start, start + timedelta(hours=1),
                                              place="event_location"), cites=[eid])
    for _ in range(3):
        go(drives)
        assert no_two_overlap(drives)
    # One set of drives, now the Family event's (Gmail already has him busy, so no block of its own).
    assert blocks(drives) == [
        ("Busy (drive there)", start - 30 * M, start, ""),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    own = own_key(mine_occ)
    live = {r["key"] for r in drives.ledger.db.execute("SELECT key FROM family_gmail WHERE state='live'")}
    assert live and not live & {leg_key(own, "there"), leg_key(own, "back")}


def test_lookups_go_soonest_first_and_a_near_one_still_waiting_is_named(drives, monkeypatch):
    drives.maps = AnyMaps()
    drives.gm.drives.transport = drives.maps
    quiet_family(drives)
    soon = when(drives, days=0, hour=17)                            # 8 hours off
    starts = [soon] + [when(drives, days=2 + n, hour=10) for n in range(14)]
    for n, start in reversed(list(enumerate(starts))):             # the feed lists the far ones first
        mine(drives, f"Visit {n}", start, f"{n + 10} Oak St, Town, VA")
    go(drives)
    go(drives)
    there = sorted(b[2] for b in blocks(drives) if b[0] == "Busy (drive there)")
    assert there and there == starts[:len(there)]                   # the soonest, in order
    # With no allowance left before the near one is asked, the digest names it.
    monkeypatch.setattr(drive, "MAX_REQUESTS_PER_READ", 0)
    near = when(drives, days=0, hour=18)
    mine(drives, "Quick one", near, "77 Elm St, Town, VA")
    go(drives)
    local = near.astimezone(NY)
    # The 5:00 visit's drive back waits on the same lookup (home or straight on), so it's named with it.
    assert (f"couldn't look up the drive for the events at {local:%b} {local.day}, 5:00; "
            f"{local:%b} {local.day}, 6:00") in drives.gm.digest_line()
    far = starts[-1].astimezone(NY)
    assert f"{far:%b} {far.day}, 10:00" not in drives.gm.digest_line()


def test_a_tight_pair_whose_first_cant_be_placed_doesnt_get_an_impossible_drive_from_home(drives):
    quiet_family(drives)
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=15)
    mine(drives, "Dentist", a, "40 Nowhere Rd, Town, VA")           # its way home can't be found
    mine(drives, "Haircut", b, PARK)                                # from home is 30 minutes: 10:45
    for _ in range(3):
        go(drives)
    drives.tick()
    assert blocks(drives) == [("Busy (drive back)", b + 60 * M, b + 90 * M, "")]
    local = b.astimezone(NY)
    assert f"the event at {local:%b} {local.day}, 11:15" in drives.gm.digest_line()
    cards = [s[1] for s in drive_cards_sent(drives)]
    assert any(f"at 11:15 AM: the drive from the event before it can't be worked out" in t for t in cards)


def test_a_drive_from_home_that_would_cross_a_kept_drive_isnt_written(drives):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=12)
    goes(drives, "Eye doctor", a, CLINIC, hours=1.5)
    go(drives)
    go(drives)
    mine(drives, "Haircut", b, PARK)
    real = drives.gm.drives.between

    def between(origin, destination):                               # the clinic's way home: no address
        if origin == CLINIC and destination == drive.HOME:
            return drive.NO_ADDRESS
        return real(origin, destination)
    drives.gm.drives.between = between
    for _ in range(3):
        go(drives)
        assert no_two_overlap(drives)                               # not even for one read
    # Once the clinic's drive home is off Gmail, the haircut's drive from home fits.
    assert ("Busy (drive there)", b - 30 * M, b, "") in blocks(drives)


def test_drive_blocks_have_no_guests_no_updates_and_the_add_ons_mark(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    mine(drives, "Dentist", start, CLINIC)
    before = family_snapshot(drives)
    go(drives)
    go(drives)
    assert family_snapshot(drives) == before
    assert not [x for x in drives.icloud.log if x[0] in ("PUT", "DELETE")]
    made = list(drives.google.live().values())
    assert len(made) == 2
    for e in made:
        assert not e.get("attendees")
        assert e["extendedProperties"]["private"] == {"harness": "family_gmail", "harness_kind": "own_drive"}
        assert e["guestsCanInviteOthers"] is False and e["guestsCanSeeOtherGuests"] is False
    assert drives.google.queries and all(q.get("sendUpdates") == "none" for m, q in drives.google.queries
                                         if m != "GET")
    # A block titled exactly as the add-on's, even his own at a street address: never an appointment (sixth round).
    hand = when(drives, days=4, hour=10)
    mine(drives, "Busy (drive there)", hand, PARK, uid="his-own-block")
    # The add-on's own blocks read back from his calendar: never an appointment of his.
    for e in made:
        drives.feeds.window.occurrences.append(occ(e["summary"], datetime.fromisoformat(e["start"]["dateTime"]),
                                                   hours=0.5, uid=e["id"] + "@google.com", location=CLINIC))
    go(drives)
    go(drives)
    go(drives)
    titles = [b[0] for b in blocks(drives)]
    assert titles.count("Busy (drive there)") == 1 and titles.count("Busy (drive back)") == 1
    assert ("Busy (drive there)", hand - 30 * M, hand, "") not in blocks(drives)


def test_his_own_appointments_get_drives_only_as_far_ahead_as_the_option_says(drives, tmp_path):
    quiet_family(drives)
    near, far = when(drives, days=2, hour=10), when(drives, days=5, hour=10)
    mine(drives, "Dentist", near, CLINIC)
    mine(drives, "Haircut", far, PARK)
    (tmp_path / "options.json").write_text(json.dumps({"own_drive_days": 3}))
    drives.gm.own_days_fn = lambda: own_days_from_options(str(tmp_path))
    go(drives)
    go(drives)
    assert [b[2] for b in blocks(drives) if b[0] == "Busy (drive there)"] == [near]
    (tmp_path / "options.json").write_text(json.dumps({"own_drive_days": 7}))   # widened
    go(drives)
    assert [b[2] for b in blocks(drives) if b[0] == "Busy (drive there)"] == [near, far]


@pytest.mark.parametrize("text,days", [("{}", 3), ('{"own_drive_days": 10}', 10), ('{"own_drive_days": 0}', 1),
                                       ('{"own_drive_days": 99}', 60), ('{"own_drive_days": "x"}', 3),
                                       ('{"own_drive_days": true}', 3), ("not json", 3)])
def test_the_own_drive_days_option_is_read_short_by_default(tmp_path, text, days):
    (tmp_path / "options.json").write_text(text)
    assert own_days_from_options(str(tmp_path)) == days
    assert own_days_from_options(str(tmp_path / "missing")) == 3


# -- 11. drive blocks for his own appointments, fourth round (0.24.0) -------------------------------------
# Through the real reader of his calendar's secret iCal feed (calendar_feed.fetch_one and ical.window: repeat
# rules, excluded dates, overrides) and the real sync loop. Only Google's answers are fakes.

from harness import calendar_feed                                     # noqa: E402
from harness.family_gmail import own_dry_run_from_options            # noqa: E402

FEED_URL = "https://calendar.google.com/calendar/ical/parent%40gmail.com/private-0123456789abcdef/basic.ics"
UTC_FMT = "%Y%m%dT%H%M%SZ"


def _u(t):
    return t.astimezone(timezone.utc).strftime(UTC_FMT)


def vev(uid, title, start, hours=1, place="", rrule="", exdates=(), rid=None, extra=()):
    """One VEVENT as Google's feed writes it."""
    lines = ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{_u(start)}", f"DTSTART:{_u(start)}",
             f"DTEND:{_u(start + timedelta(hours=hours))}", f"SUMMARY:{title}"]
    if place:
        lines.append("LOCATION:" + place.replace(",", "\\,"))
    if rrule:
        lines.append("RRULE:" + rrule)
    lines += [f"EXDATE:{_u(x)}" for x in exdates]
    if rid is not None:
        lines.append(f"RECURRENCE-ID:{_u(rid)}")
    return "\r\n".join([*lines, *extra, "END:VEVENT"])


def padding(n):
    """Old events, long over: what makes a real feed's size."""
    return [vev(f"old-{i}", f"Old thing {i}", datetime(2020, 1, 1, 9, tzinfo=NY) + timedelta(days=i))
            for i in range(n)]


class FeedServer:
    """Google's secret-address server: one answer, as set."""

    def __init__(self):
        self.status, self.headers, self.body = 200, {}, b""

    def request(self, method, url, *, headers=None, timeout=30, **kw):
        return HttpResponse(self.status, dict(self.headers), self.body)


def feed_rig(rig, api=None, headers_fn=lambda: False):
    """His Gmail calendar read by the add-on's own feed reader, not set by hand."""
    rig.server = FeedServer()
    rig.cal = calendar_feed.CalendarFeeds(rig.ledger, rig.server, SyncExecutor(), lambda: FEED_URL, TZ,
                                          ahead_days=60, ahead_from=api, headers_fn=headers_fn)
    return rig


def fetch(rig, *events, pad=40, cut=False, headers=None):
    """One download of the feed, read as the add-on reads it, then a tick that looks at it."""
    body = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:" + GMAIL, *events, *padding(pad),
                        "END:VCALENDAR"]) + "\r\n"
    if cut:
        body = body[:len(body) * 3 // 5]       # the download stopped part way: it still parses
    rig.server.body = body.encode()
    rig.server.headers = headers or {}
    rig.server.status = 200
    rig.cal.start()
    rig.cal.collect()
    rig.feeds.snapshot = rig.cal.snapshot
    rig.feeds.generation += 1
    rig.tick()


def drives_each_day(rig):
    """Each day's (drive there, drive back) count on Gmail."""
    out = {}
    for title, start, _, _ in blocks(rig):
        if title in ("Busy (drive there)", "Busy (drive back)"):
            there, back = out.get(start.astimezone(NY).date(), (0, 0))
            out[start.astimezone(NY).date()] = (there + (title == "Busy (drive there)"),
                                                back + (title == "Busy (drive back)"))
    return out


def flush_receipts(rig):
    while rig.gm.send_drive_receipts():
        pass
    rig.tick()


def outbox(rig):
    return rig.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]


def gmail_writes(rig):
    return len(rig.google.writes())


def test_a_series_split_this_and_following_keeps_one_drive_pair_a_day_and_sends_no_card(drives):
    feed_rig(drives)
    quiet_family(drives)
    day1 = when(drives, days=1, hour=10)
    whole = vev("series-u", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=6")
    fetch(drives, whole)
    fetch(drives, whole)
    assert list(drives_each_day(drives).values()) == [(1, 1)] * 6
    flush_receipts(drives)
    sent, written = outbox(drives), gmail_writes(drives)
    # "This and following" from day 4: the old series ends after day 3, a new uid has days 4 to 6.
    old = vev("series-u", "PT", day1, place=CLINIC, rrule=f"FREQ=DAILY;UNTIL={_u(day1 + timedelta(days=2, hours=1))}")
    new = vev("series-v", "PT", day1 + timedelta(days=3), place=CLINIC, rrule="FREQ=DAILY;COUNT=3")
    for _ in range(3):
        fetch(drives, old, new)
        assert list(drives_each_day(drives).values()) == [(1, 1)] * 6     # exactly one pair a day, every read
        assert drives.gm.send_drive_receipts() == 0
    drives.tick()
    assert outbox(drives) == sent and not drive_cards_sent(drives)[sent:]
    assert gmail_writes(drives) == written                               # nothing written or taken off


@pytest.mark.parametrize("how", ["cut", "small"])
def test_a_feed_cut_short_or_much_smaller_than_the_last_keeps_his_drives(drives, how):
    feed_rig(drives)
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    dentist = vev("dentist", "Dentist", start, place=CLINIC)
    fetch(drives, dentist)
    fetch(drives, dentist)
    before = blocks(drives)
    assert len(before) == 2
    flush_receipts(drives)
    sent, written = outbox(drives), gmail_writes(drives)
    for _ in range(4):
        if how == "cut":
            fetch(drives, cut=True)                 # no END:VCALENDAR: the download was cut off
        else:
            # Ends as it should and has this month's events, but it's a quarter of the last one's size.
            fetch(drives, vev("errand", "Errand", when(drives, days=20, hour=15)), pad=10)
        assert blocks(drives) == before
    fetch(drives, dentist)
    fetch(drives, dentist)
    assert blocks(drives) == before and gmail_writes(drives) == written
    drives.tick()
    assert outbox(drives) == sent


def test_an_instance_missing_from_one_read_and_back_on_the_next_keeps_its_drives_and_sends_no_card(drives):
    feed_rig(drives)
    quiet_family(drives)
    first = when(drives, days=2, hour=10)
    master = vev("weekly-pt", "PT", first, place=CLINIC, rrule="FREQ=WEEKLY;COUNT=4")
    week2 = first.astimezone(timezone.utc) + timedelta(weeks=1)
    moved = vev("weekly-pt", "PT", week2 + timedelta(hours=4), place=CLINIC, rid=week2)   # week 2 moved to 2 PM
    fetch(drives, master, moved)
    fetch(drives, master, moved)
    before = blocks(drives)
    assert len(before) == 8
    flush_receipts(drives)
    sent, written = outbox(drives), gmail_writes(drives)
    fetch(drives, moved)                            # the master missing from this one read; its override kept
    assert blocks(drives) == before
    fetch(drives, master, moved)                    # back
    fetch(drives, master, moved)
    assert blocks(drives) == before and gmail_writes(drives) == written
    assert drives.gm.send_drive_receipts() == 0
    drives.tick()
    assert outbox(drives) == sent


def test_an_override_with_no_master_is_kept_and_gets_its_drives(drives):
    feed_rig(drives)
    quiet_family(drives)
    orig = when(drives, days=3, hour=10)
    alone = vev("lone-series", "PT", orig + timedelta(hours=3), place=CLINIC, rid=orig)
    fetch(drives, alone)
    fetch(drives, alone)
    start = orig + timedelta(hours=3)
    assert blocks(drives) == [("Busy (drive there)", start - 30 * M, start, ""),
                              ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    keys = {r["key"] for r in drives.ledger.db.execute("SELECT key FROM drive_cards WHERE kind='own'")}
    # Keyed by the series uid and its original start (its recurrence id).
    assert keys == {hashlib.sha256(f"lone-series|{_u(orig)}|own".encode()).hexdigest()[:32]}


@pytest.mark.parametrize("week", [1, 3])
def test_an_excluded_date_takes_that_instances_drives_off_at_that_read(drives, week):
    feed_rig(drives)
    quiet_family(drives)
    first = when(drives, days=2, hour=10)
    fetch(drives, vev("weekly-pt", "PT", first, place=CLINIC, rrule="FREQ=WEEKLY;COUNT=4"))
    fetch(drives, vev("weekly-pt", "PT", first, place=CLINIC, rrule="FREQ=WEEKLY;COUNT=4"))
    assert len(blocks(drives)) == 8
    utc = first.astimezone(timezone.utc)                                # the series is in UTC, as Google sends it
    gone = utc + timedelta(weeks=week)
    fetch(drives, vev("weekly-pt", "PT", first, place=CLINIC, rrule="FREQ=WEEKLY;COUNT=4", exdates=[gone]))
    starts = [b[2] for b in blocks(drives) if b[0] == "Busy (drive there)"]
    assert starts == [utc + timedelta(weeks=n) for n in range(4) if n != week]      # off at that one read


def test_his_own_appointments_are_read_from_the_feed_never_the_api(drives):
    a, b = when(drives, days=3, hour=10), when(drives, days=4, hour=10)
    api_only = ical.Window(GMAIL, [occ("Dentist", a, location=CLINIC, uid="api-only")])
    feed_rig(drives, api=lambda address, start, until: api_only)
    quiet_family(drives)
    fetch(drives, vev("feed-only", "Haircut", b, place=PARK))
    fetch(drives, vev("feed-only", "Haircut", b, place=PARK))
    res = drives.cal.snapshot.feeds[calendar_feed.feed_id(FEED_URL)]
    assert res.ahead is api_only                                    # elsewhere, the API read stands in
    assert [x[2] for x in blocks(drives) if x[0] == "Busy (drive there)"] == [b]     # his drives: the feed


def test_a_stale_appointment_is_never_a_stop_for_a_family_events_drive(drives):
    feed_rig(drives)
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    haircut = vev("haircut", "Haircut", a, place=PARK)
    goes(drives, "Eye doctor", b, CLINIC)
    fetch(drives, haircut)
    fetch(drives, haircut)
    assert ("Busy (drive there)", b - 15 * M, b, "") in blocks(drives)       # straight on from the haircut
    for _ in range(3):
        fetch(drives, haircut, cut=True)                                     # Gmail not read in full
        got = blocks(drives)
        assert ("Busy (drive there)", b - 30 * M, b, "") in got              # from home: 20 minutes, rounded
        assert ("Busy (drive there)", b - 15 * M, b, "") not in got
        assert ("Busy (drive there)", a - 30 * M, a, "") in got              # the haircut's own, kept


def test_a_drive_left_off_within_a_day_gets_its_card_at_once(drives):
    quiet_family(drives)
    soon = when(drives, days=1, hour=8)                                      # 23 hours away
    mine(drives, "Dentist", soon, CLINIC)
    drives.maps.fail = "down"
    go(drives)                                                               # one failed lookup is enough
    drives.tick()
    texts = [s[1] for s in drive_cards_sent(drives)]
    assert texts == [f"No drive blocks for the event on {day(soon)} at 8:00 AM: the drive lookup failed. "
                     "I'll keep trying at each read; tap Skip to leave it without drive blocks."]


def test_a_lookup_still_waiting_within_a_day_gets_its_card(drives, monkeypatch):
    quiet_family(drives)
    monkeypatch.setattr(drive, "MAX_REQUESTS_PER_READ", 0)
    soon = when(drives, days=0, hour=20)
    mine(drives, "Dentist", soon, CLINIC)
    go(drives)
    drives.tick()
    texts = [s[1] for s in drive_cards_sent(drives)]
    assert texts == [f"No drive blocks for the event on {day(soon)} at 8:00 PM: its drive time hasn't been "
                     "looked up yet. I'll keep trying at each read; tap Skip to leave it without drive blocks."]
    far = when(drives, days=3, hour=10)
    mine(drives, "Haircut", far, PARK)                                       # days away: a quiet wait
    go(drives)
    drives.tick()
    assert len(drive_cards_sent(drives)) == 1


def test_with_no_state_the_add_ons_own_blocks_get_no_drives_and_no_card(drives):
    """The state file deleted: what the add-on wrote is still on Gmail, and comes back in the feed."""
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    old = [("Busy (drive there)", start - 30 * M, start), ("Busy (drive back)", start + 60 * M, start + 90 * M),
           ("Maybe busy (drive there)", start + 5 * 60 * M, start + 5 * 60 * M + 30 * M)]
    for n, (title, s, e) in enumerate(old):
        uid = google_cal.event_id(f"before:{n}")
        assert drives.gm.google.add(GMAIL, uid, title, s, e, "").kind == "ok"
        drives.feeds.window.occurrences.append(occ(title, s, hours=0.5, uid=uid + "@google.com"))
    # A drive's title with no place and an id the feed spells otherwise, and a plain "Busy" hold.
    drives.feeds.window.occurrences.append(occ("Busy (drive back)", start + 3 * 60 * M, hours=0.5, uid="x9@google.com"))
    drives.feeds.window.occurrences.append(occ("Busy", start + 6 * 60 * M, hours=1, uid="hold@google.com"))
    before = sorted(drives.google.titles())
    for _ in range(3):
        go(drives)
    assert sorted(drives.google.titles()) == before                          # no drive written on a drive block
    assert drives.gm.send_drive_receipts() == 0
    drives.tick()
    assert not drive_cards_sent(drives)
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM drive_cards").fetchone()[0] == 0
    assert not [r for r in drives.ledger.db.execute("SELECT text FROM outbox")
                if r["text"].startswith(("Added to your Gmail", "Moved on your Gmail", "No drive blocks", "Where is"))]


@pytest.mark.parametrize("extra,all_day", [
    (("ORGANIZER:mailto:" + GMAIL, "ATTENDEE;PARTSTAT=DECLINED:mailto:" + GMAIL), False),
    (("ORGANIZER:mailto:" + GMAIL, "ATTENDEE;PARTSTAT=TENTATIVE:mailto:" + GMAIL), False),
    (("TRANSP:TRANSPARENT",), False),                                       # shown free
    ((), True),
])
def test_declined_tentative_free_and_all_day_get_no_drives(drives, extra, all_day):
    feed_rig(drives)
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    if all_day:
        d = start.date()
        event = "\r\n".join(["BEGIN:VEVENT", "UID:allday", f"DTSTAMP:{_u(start)}", f"DTSTART;VALUE=DATE:{d:%Y%m%d}",
                             f"DTEND;VALUE=DATE:{d + timedelta(days=1):%Y%m%d}", "SUMMARY:Conference",
                             "LOCATION:" + CLINIC.replace(",", "\\,"), "END:VEVENT"])
    else:
        event = vev("one", "Dentist", start, place=CLINIC, extra=extra)
    accepted = vev("two", "Haircut", when(drives, days=4, hour=10), place=PARK,
                   extra=("ORGANIZER:mailto:" + GMAIL, "ATTENDEE;PARTSTAT=ACCEPTED:mailto:" + GMAIL))
    fetch(drives, event, accepted)
    fetch(drives, event, accepted)
    assert [b[2] for b in blocks(drives) if b[0] == "Busy (drive there)"] == [when(drives, days=4, hour=10)]
    drives.tick()
    assert not drive_cards_sent(drives)


def email_date(t):
    import email.utils
    return email.utils.format_datetime(t.astimezone(timezone.utc), usegmt=True)


def test_the_dry_run_logs_his_drives_writes_nothing_for_them_and_sends_no_card(drives, caplog, tmp_path):
    (tmp_path / "options.json").write_text("{}")
    drives.gm.own_dry_fn = lambda: own_dry_run_from_options(str(tmp_path))   # on by default
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=12)
    goes(drives, "Eye doctor", b, CLINIC)
    dentist = mine(drives, "Dentist", a, PARK)
    mine(drives, "Checkup", when(drives, days=1, hour=8), "Dr Patel's office")   # a place to ask about
    assert drives.gm.drives.between(drive.HOME, PARK) == 25         # kept from before: the dry run looks nothing up
    caplog.set_level(logging.INFO, logger="harness.family_gmail")
    go(drives)
    go(drives)
    titles = [x[0] for x in blocks(drives)]
    assert titles == ["Busy (drive there)", "Busy (family)", "Busy (drive back)"]   # the Family event's only
    assert [x[1] for x in blocks(drives)][0] == b - 30 * M
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("drive dry run")]
    local = a.astimezone(NY)
    assert (f"drive dry run: would write Busy (drive there), {local:%a %b} {local.day} 9:30 AM to "
            f"{local:%a %b} {local.day} 10:00 AM, for the appointment on {local:%a %b} {local.day} 10:00 AM") in lines
    assert drives.gm.send_drive_receipts() == 0
    drives.tick()
    assert not drive_cards_sent(drives) and not [s for s in drives.bot.sent if s[1].startswith("Where is")]
    drives.feeds.window.occurrences.remove(dentist)                          # cancelled
    go(drives)
    go(drives)
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("drive dry run")]
    assert f"drive dry run: would remove the drive blocks for the appointment on {local:%a %b} {local.day} 10:00 AM" \
        in lines
    assert len([x for x in lines if x.startswith("drive dry run: would remove")]) == 1     # said once
    go(drives)
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("drive dry run: would remove")]
    assert len(lines) == 1
    (tmp_path / "options.json").write_text('{"own_drive_dry_run": false}')   # he's read the log: off
    drives.feeds.window.occurrences.append(dentist)
    go(drives)
    assert ("Busy (drive there)", a - 30 * M, a, "") in blocks(drives)


@pytest.mark.parametrize("text,dry", [("{}", True), ('{"own_drive_dry_run": false}', False),
                                      ('{"own_drive_dry_run": true}', True), ('{"own_drive_dry_run": "no"}', True),
                                      ("not json", True)])
def test_the_dry_run_option_is_on_unless_it_reads_as_off(tmp_path, text, dry):
    (tmp_path / "options.json").write_text(text)
    assert own_dry_run_from_options(str(tmp_path)) is dry


def test_drives_put_back_as_he_was_told_send_no_second_card(drives):
    quiet_family(drives)
    start = when(drives, days=3, hour=10)
    dentist = mine(drives, "Dentist", start, CLINIC)
    go(drives)
    go(drives)
    assert drives.gm.send_drive_receipts() == 1
    drives.tick()
    before = blocks(drives)
    drives.feeds.window.occurrences.remove(dentist)
    go(drives)
    assert blocks(drives) == before                                          # one read says nothing
    go(drives)
    assert blocks(drives) == []                                              # two full reads in a row do
    drives.feeds.window.occurrences.append(dentist)                          # back, as it was
    for _ in range(3):
        go(drives)
    assert blocks(drives) == before
    assert drives.gm.send_drive_receipts() == 0
    assert drives_cards_receipt_states(drives) == {"shown"}


def drives_cards_receipt_states(rig):
    return {r["receipt"] for r in rig.ledger.db.execute("SELECT receipt FROM drive_cards WHERE kind='own'")}


# -- the fifth round: a dry run that writes nothing for him, no writes on partial reads, adoption after a
#    lost state, his go before odd removals, splits by continuity, and the feed's age (0.24.0) ------------

def fetch_status(rig, status):
    """One answer from Google with no calendar in it (a 304, a 500), then a tick that looks at it."""
    rig.server.status, rig.server.body, rig.server.headers = status, b"", {}
    rig.cal.start()
    rig.cal.collect()
    rig.feeds.snapshot = rig.cal.snapshot
    rig.feeds.generation += 1
    rig.tick()


def record_writes(rig):
    """Every write to Google, as (method, title, start, end) of the event it touched."""
    seen, orig = [], rig.google.request

    def request(method, url, *, headers=None, json_body=None, body=None, timeout=30):
        answer = orig(method, url, headers=headers, json_body=json_body, body=body, timeout=timeout)
        if method in ("POST", "PUT", "PATCH", "DELETE") and url != google_cal.TOKEN_URL:
            sent = json.loads(body) if body else {}
            event = rig.google.events.get(sent.get("id") or unquote_path(url), {})
            seen.append((method, event.get("summary"), (event.get("start") or {}).get("dateTime"),
                         (event.get("end") or {}).get("dateTime")))
        return answer

    rig.google.request = request
    return seen


def unquote_path(url):
    from urllib.parse import unquote
    return unquote(urlsplit(url).path).rsplit("/", 1)[-1]


def drives_rig(tmp_path):
    """A second rig of its own (ledger, Family, Gmail, maps), for running the same reads twice."""
    from conftest import Clock
    clock = Clock()
    tmp_path.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(str(tmp_path / "harness.sqlite"), clock=clock)
    rig_ = FamilyRig(ledger, tmp_path, clock)
    rig_.turn_on()
    return make_drives(make_live(make_g(rig_)))


def dry_scenario(rig, monkeypatch):
    """Reads of a recorded feed: full reads, one cut short, a split, a cancellation, and more than 3
    appointments gone at once. Each read's writes to Google, in order."""
    monkeypatch.setattr(drive, "MAX_REQUESTS_PER_READ", 2)       # lookups scarce: who goes first matters
    feed_rig(rig)
    quiet_family(rig)
    writes = record_writes(rig)
    day1 = when(rig, days=1, hour=8)                              # within a day: looked up first, if his
    goes(rig, "Eye doctor", when(rig, days=3, hour=11, minute=30), CLINIC)
    haircut = vev("haircut", "Haircut", when(rig, days=3, hour=10), place=PARK)
    series = vev("series-u", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=6")
    old = vev("series-u", "PT", day1, place=CLINIC, rrule=f"FREQ=DAILY;UNTIL={_u(day1 + timedelta(days=2, hours=12))}")
    new = vev("series-u_R1", "PT", day1 + timedelta(days=3, hours=6), place=CLINIC, rrule="FREQ=DAILY;COUNT=3")
    dentist = vev("dentist", "Dentist", when(rig, days=2, hour=14), place=CLINIC)
    many = [vev(f"one-{i}", f"Thing {i}", when(rig, days=4 + i, hour=9), place=PARK) for i in range(5)]
    reads = [dict(events=[haircut, series, dentist, *many]),
             dict(events=[haircut, series, dentist, *many]),
             dict(events=[haircut, series, dentist, *many], cut=True),       # cut short
             dict(events=[haircut, old, new, dentist, *many]),               # split, at a new time
             dict(events=[haircut, old, new, *many]),                        # the dentist cancelled
             dict(events=[haircut, old, new, *many]),
             dict(events=[haircut, old, new]),                               # five gone at once
             dict(events=[haircut, old, new]),
             dict(events=[haircut, old, new], advance=3),
             dict(events=[haircut, old, new], advance=3),
             dict(events=[haircut, old, new], cut=True)]
    out = []
    for n, r in enumerate(reads):
        if r.get("advance"):
            rig.clock.advance(hours=r["advance"])
        fetch(rig, *r["events"], cut=r.get("cut", False), headers={"etag": f'"v{n}"'})
        out.append(list(writes))
        writes.clear()
    return out


def test_the_dry_run_writes_to_google_exactly_what_family_events_alone_did(drives, tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="harness.family_gmail")
    drives.gm.own_dry_fn = lambda: True
    dry = dry_scenario(drives, monkeypatch)
    alone = drives_rig(tmp_path / "alone")
    # Family events alone, as before his own appointments had drives: none of his is near enough to
    # get any (a horizon of no time at all), and nothing of his is looked up.
    alone.gm.own_days_fn = lambda: 0
    alone.gm._warm_near = lambda now: None
    expected = dry_scenario(alone, monkeypatch)
    assert dry == expected
    assert any("Busy (drive there)" == w[1] for step in expected for w in step)    # Family's drives were written
    assert [r.getMessage() for r in caplog.records if r.getMessage().startswith("drive dry run: would write")]
    # Nothing his appointments would get was kept as written, and no card went out for them.
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM drive_cards WHERE kind='own'").fetchone()[0] == 0
    assert drives.gm.send_drive_receipts() == 0
    assert not [s for s in drives.bot.sent if "Should their drive blocks come off" in s[1]
                or s[1].startswith(("Added to your Gmail", "Moved on your Gmail"))]


def test_nothing_the_dry_run_counted_carries_into_live_mode(drives):
    feed_rig(drives)
    quiet_family(drives)
    dry = [True]
    drives.gm.own_dry_fn = lambda: dry[0]
    start = when(drives, days=3, hour=10)
    dentist = vev("dentist", "Dentist", start, place=CLINIC)
    fetch(drives, dentist, pad=40)
    fetch(drives, dentist, pad=40)
    fetch(drives, pad=40, headers={"etag": '"gone"'})                # missing from one read: counted, in the dry run
    assert blocks(drives) == []
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM family_gmail").fetchone()[0] == 0
    assert {r["kind"] for r in drives.ledger.db.execute("SELECT kind FROM drive_cards")} == {"dry"}
    dry[0] = False                                                   # he's read the log: live
    fetch(drives, dentist, pad=5)                                    # far smaller than the dry run's reads
    fetch(drives, dentist, pad=5)
    assert ("Busy (drive there)", start - 30 * M, start, "") in blocks(drives)
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM drive_cards WHERE kind='dry'").fetchone()[0] == 0
    assert not drives.ledger.db.execute("SELECT key FROM meta WHERE key LIKE '%:dry' AND value!=''").fetchall()


def test_a_partial_read_never_retitles_a_kept_drive_and_a_crossing_is_told(drives):
    a, b = when(drives, days=1, hour=6), when(drives, days=1, hour=7, minute=30)     # within a day
    goes(drives, "Eye doctor", a, CLINIC)
    mine(drives, "Haircut", b, PARK)
    go(drives)
    go(drives)
    before = blocks(drives)
    haircut_there = ("Busy (drive there)", b - 15 * M, b, "")                       # straight on from the clinic
    assert haircut_there in before
    writes = list(drives.google.writes())
    drives.feeds.window.unreadable = 1                                              # Gmail not read in full
    # Sixth round: a new appointment of his appears, and a duplicate of a kept drive block (the add-on's mark,
    # no record) is there: neither gets any write while the read isn't full.
    mine(drives, "Checkup", when(drives, days=2, hour=10), CLINIC)
    assert drives.gm.google.add(GMAIL, google_cal.event_id("duplicate:0"), *haircut_there[:3], "",
                                google_cal.OWN_DRIVE).kind == "ok"
    writes = list(drives.google.writes())
    for _ in range(3):
        go(drives)
    got = blocks(drives)
    assert got.count(haircut_there) == 2 and not [x for x in got if x[0].startswith("Maybe busy")]
    assert not [x for x in got if x[1].astimezone(NY).date() == when(drives, days=2).date()]   # nothing for the checkup
    assert ("Busy (drive back)", a + 60 * M, a + 90 * M, "") in got                 # the eye doctor's, from home
    new = drives.google.writes()[len(writes):]
    assert [w[0] for w in new] == ["POST"]                                          # that one drive, nothing else
    assert "crosses a drive block kept for one of your own appointments" in drives.gm.digest_line()
    drives.tick()
    told = [s[1] for s in drives.bot.sent if s[1].startswith("The drive for the event on")]
    local = a.astimezone(NY)
    assert told == [f"The drive for the event on {local:%a %b} {local.day} at 6:00 AM crosses a drive block kept "
                    "for your own appointment (7:15 AM), because your Gmail calendar couldn't be read in full. Both "
                    "stay on your calendar as busy until it reads in full."]


def test_nothing_changes_for_his_appointments_on_a_day_one_of_them_is_unsettled(drives):
    quiet_family(drives)
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=15)
    dentist = mine(drives, "Dentist", a, CLINIC)
    go(drives)
    go(drives)
    before, written = blocks(drives), len(drives.google.writes())
    drives.feeds.window.occurrences.remove(dentist)                 # missing from one read
    mine(drives, "Haircut", b, PARK)                                # and a new one that day
    go(drives)
    assert blocks(drives) == before and len(drives.google.writes()) == written
    go(drives)                                                      # a second full read settles the day
    assert blocks(drives) == [("Busy (drive there)", b - 30 * M, b, ""),
                              ("Busy (drive back)", b + 60 * M, b + 90 * M, "")]


def wipe_state(rig):
    """The state file lost: no record of any block on Gmail, and no test event remembered."""
    with rig.ledger.tx() as db:
        db.execute("DELETE FROM family_gmail")
        db.execute("DELETE FROM drive_cards")
        db.execute("DELETE FROM meta WHERE key LIKE 'family_gmail%'")


def test_after_the_state_is_lost_a_sync_takes_its_blocks_back_and_writes_nothing(drives):
    quiet_family(drives)
    a = when(drives, days=3, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    goes(drives, "Eye doctor", when(drives, days=4, hour=10), CLINIC)
    go(drives)
    go(drives)
    flush_receipts(drives)
    before, written, sent = blocks(drives), len(drives.google.writes()), len(drives.bot.sent)
    assert len(before) == 5
    wipe_state(drives)
    for _ in range(3):
        go(drives)
    assert blocks(drives) == before                                 # no duplicates
    assert len(drives.google.writes()) == written                   # no new writes, not even a test event
    assert drives.gm.send_drive_receipts() == 0
    drives.tick()
    assert not [s for s in drives.bot.sent[sent:] if s[1].startswith(("Added to your Gmail", "No drive blocks"))]


def test_with_no_state_blocks_beside_his_appointment_are_taken_back_and_an_exact_duplicate_comes_off(drives):
    quiet_family(drives)
    a = when(drives, days=3, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    for n, (title, s, e) in enumerate([("Busy (drive there)", a - 30 * M, a), ("Busy (drive back)", a + 60 * M, a + 90 * M)]):
        assert drives.gm.google.add(GMAIL, google_cal.event_id(f"from-before:{n}"), title, s, e, "",
                                    google_cal.OWN_DRIVE).kind == "ok"
    written = len(drives.google.writes())
    for _ in range(3):
        go(drives)
    assert blocks(drives) == [("Busy (drive there)", a - 30 * M, a, ""), ("Busy (drive back)", a + 60 * M, a + 90 * M, "")]
    assert len(drives.google.writes()) == written                    # taken back: nothing written
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM family_gmail WHERE state='live'").fetchone()[0] == 2
    # A duplicate of a block kept (same title, times and place, the add-on's mark) comes off.
    assert drives.gm.google.add(GMAIL, google_cal.event_id("from-before:9"), "Busy (drive there)", a - 30 * M, a, "",
                                google_cal.OWN_DRIVE).kind == "ok"
    written = len(drives.google.writes())
    go(drives)
    assert blocks(drives) == [("Busy (drive there)", a - 30 * M, a, ""), ("Busy (drive back)", a + 60 * M, a + 90 * M, "")]
    assert [w[0] for w in drives.google.writes()[written:]] == ["DELETE"]           # the duplicate only


def test_the_remove_all_blocks_option_takes_off_every_marked_block_and_writes_nothing_new(drives, tmp_path):
    from harness.family_gmail import cleanup_from_options
    quiet_family(drives)
    a = when(drives, days=3, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    goes(drives, "Eye doctor", when(drives, days=4, hour=10), CLINIC)
    go(drives)
    go(drives)
    assert len(blocks(drives)) == 5
    family = [b for b in blocks(drives) if b[1] >= when(drives, days=4, hour=0)]
    assert len(family) == 3
    (tmp_path / "options.json").write_text('{"remove_all_blocks": true, "own_drive_dry_run": false}')
    drives.gm.cleanup_fn = lambda: cleanup_from_options(str(tmp_path))
    for _ in range(3):
        go(drives)
    assert blocks(drives) == family                                 # his own appointment's drives only (sixth round)
    assert drives.gm.status_line().startswith("Blocks on Gmail from Family: clearing.")
    (tmp_path / "options.json").write_text('{"remove_all_blocks": false}')
    go(drives)
    go(drives)
    assert len(blocks(drives)) == 5                                 # off again: written as before


@pytest.mark.parametrize("text,on", [("{}", False), ('{"remove_all_blocks": true}', True),
                                     ('{"remove_all_blocks": "yes"}', False), ("not json", False)])
def test_the_remove_all_blocks_option_is_off_unless_plainly_on(tmp_path, text, on):
    from harness.family_gmail import cleanup_from_options
    (tmp_path / "options.json").write_text(text)
    assert cleanup_from_options(str(tmp_path)) is on


@pytest.mark.parametrize("tap", ["Take them off", "Keep them"])
def test_more_than_three_gone_at_once_asks_him_first_and_nothing_comes_off_before_his_go(drives, tap):
    feed_rig(drives)
    quiet_family(drives)
    dentist = vev("dentist", "Dentist", when(drives, days=2, hour=10), place=CLINIC)
    things = [vev(f"one-{i}", f"Thing {i}", when(drives, days=3 + i, hour=10), place=PARK) for i in range(5)]
    fetch(drives, dentist, *things, headers={"etag": '"v1"'})
    fetch(drives, dentist, *things, headers={"etag": '"v2"'})
    assert len(blocks(drives)) == 12
    flush_receipts(drives)
    before, written = blocks(drives), len(drives.google.writes())

    def asked():
        return [s for s in drives.bot.sent if "Should their drive blocks come off" in s[1]]

    fetch(drives, dentist, headers={"etag": '"v3"'})               # missing from one read
    fetch(drives, dentist, headers={"etag": '"v4"'})               # and a second: five at once
    drives.tick()
    assert not asked() and "may be a bad read" in drives.gm.digest_line()
    drives.clock.advance(hours=1)
    fetch_status(drives, 304)                                       # the same state, only an hour on: not yet
    drives.tick()
    assert not asked() and blocks(drives) == before
    drives.clock.advance(hours=2)
    fetch(drives, dentist, headers={"etag": '"v4"'})               # the same state again, 3 hours after the first
    drives.tick()
    assert len(asked()) == 1
    card = drives.with_button("Take them off")
    whens = "; ".join(f"{day(when(drives, days=3 + i, hour=10))} at 10:00 AM" for i in range(5))
    assert card[1] == (f"5 of your appointments look gone from your Gmail calendar at once. Should their drive blocks "
                       f"come off? {whens}. They stay until you tap Take them off.")
    for n in range(3):
        fetch(drives, dentist, headers={"etag": f'"w{n}"'})
    drives.tick()
    assert len(asked()) == 1 and blocks(drives) == before and len(drives.google.writes()) == written
    drives.press(card, tap)
    fetch(drives, dentist, headers={"etag": '"x1"'})
    fetch(drives, dentist, headers={"etag": '"x2"'})
    drives.tick()
    if tap == "Take them off":
        assert len(blocks(drives)) == 2                             # the dentist's only
    else:
        assert blocks(drives) == before
    assert len(asked()) == 1


def test_a_believed_shrink_asks_before_any_drive_comes_off(drives):
    feed_rig(drives)
    quiet_family(drives)
    a = vev("dentist", "Dentist", when(drives, days=2, hour=10), place=CLINIC)
    b = vev("haircut", "Haircut", when(drives, days=3, hour=10), place=PARK)
    fetch(drives, a, b, pad=40, headers={"etag": '"v1"'})
    fetch(drives, a, b, pad=40, headers={"etag": '"v2"'})
    before = blocks(drives)
    assert len(before) == 4
    fetch(drives, a, pad=5, headers={"etag": '"v3"'})              # far smaller, and the haircut missing
    assert blocks(drives) == before
    drives.clock.advance(hours=3)
    for n in range(4):                                              # the smaller size is believed now
        fetch(drives, a, pad=5, headers={"etag": f'"s{n}"'})
    drives.tick()
    cards = [s for s in drives.bot.sent if "Should their drive blocks come off" in s[1]]
    local = when(drives, days=3, hour=10)
    assert [s[1] for s in cards] == [f"Your Gmail calendar came back much smaller than before. Should their drive "
                                     f"blocks come off? {day(local)} at 10:00 AM. They stay until you tap Take them off."]
    assert blocks(drives) == before
    drives.press(drives.with_button("Take them off"), "Take them off")
    fetch(drives, a, pad=5, headers={"etag": '"t1"'})
    assert blocks(drives) == before[:2]


@pytest.mark.parametrize("change", ["same", "time", "place"])
def test_a_split_by_continuity_keeps_or_moves_the_drives_and_removes_none(drives, change):
    feed_rig(drives)
    quiet_family(drives)
    drives.maps.minutes[frozenset({"home", PARK})] = 40             # a new place, a longer drive
    day1 = when(drives, days=1, hour=10)
    moved = day1 + timedelta(days=5)
    whole = vev("series-u", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=10")
    override = vev("series-u", "PT", moved + timedelta(hours=1), place=CLINIC, rid=moved)   # one week moved by hand
    fetch(drives, whole, override)
    fetch(drives, whole, override)
    assert len(drives_each_day(drives)) == 10
    flush_receipts(drives)
    written = len(drives.google.writes())
    before = sorted(b[1:3] for b in blocks(drives) if b[0] == "Busy (drive there)")
    # "This and following" from day 4: the old series ends after day 3 (its override vanishes with it), a new
    # series has days 4 to 10, at the same time and place, a new time, or a new place.
    hour, place = {"same": (0, CLINIC), "time": (4, CLINIC), "place": (0, PARK)}[change]
    old = vev("series-u", "PT", day1, place=CLINIC, rrule=f"FREQ=DAILY;UNTIL={_u(day1 + timedelta(days=2, hours=13))}")
    new = vev("series-u_R20261025", "PT", day1 + timedelta(days=3, hours=hour), place=place, rrule="FREQ=DAILY;COUNT=7")
    for _ in range(3):
        fetch(drives, old, new)
        assert list(drives_each_day(drives).values()) == [(1, 1)] * 10
    drives.tick()
    methods = [w[0] for w in drives.google.writes()[written:]]
    assert "DELETE" not in methods and "POST" not in methods       # never removed and made again unasked

    def asked():
        return [s for s in drives.bot.sent if "Should their drive blocks come off" in s[1]]

    there = sorted(b[1:3] for b in blocks(drives) if b[0] == "Busy (drive there)")
    lead = 45 * M if change == "place" else 30 * M
    if change == "same":                                            # moved in place
        for n in range(3, 10):
            start = day1 + timedelta(days=n, hours=hour)
            assert (start - lead, start) in there
        assert not asked() and "look gone" not in (drives.gm.digest_line() or "")
        return
    # Sixth round: 7 instances moved more than 2 hours, or to a new place, aren't moved unasked: they count
    # toward the gate, as removals and new ones, and wait for his go.
    assert there == before
    drives.clock.advance(hours=2)
    fetch(drives, old, new)
    drives.tick()
    assert len(asked()) == 1 and there == sorted(b[1:3] for b in blocks(drives) if b[0] == "Busy (drive there)")
    drives.press(drives.with_button("Take them off"), "Take them off")
    fetch(drives, old, new)
    fetch(drives, old, new)
    assert list(drives_each_day(drives).values()) == [(1, 1)] * 10
    there = sorted(b[1:3] for b in blocks(drives) if b[0] == "Busy (drive there)")
    for n in range(3, 10):
        start = day1 + timedelta(days=n, hours=hour)
        assert (start - lead, start) in there


def test_the_feeds_age_is_from_the_last_full_download_not_last_modified(drives):
    feed_rig(drives)
    quiet_family(drives)
    dentist = vev("dentist", "Dentist", when(drives, days=3, hour=10), place=CLINIC)
    old = email_date(drives.clock() - timedelta(hours=30))          # Google's copy last changed long ago
    fetch(drives, dentist, headers={"etag": '"v1"', "last-modified": old})
    kept = json.loads(drives.ledger.get_meta(f"calendar_headers:{calendar_feed.feed_id(FEED_URL)}"))
    assert kept["etag"] == '"v1"' and kept["last_modified"] == old and kept["size"] > 0
    assert "hours ago" not in (drives.gm.digest_line() or "")       # downloaded just now: not old
    for status in (500, 304, 500, 500, 500, 500, 500):
        drives.clock.advance(hours=1)
        fetch_status(drives, status)
    assert ("your Gmail calendar was last downloaded in full 7 hours ago, so the drives around your own "
            "appointments may be behind it.") in drives.gm.digest_line()
    fetch(drives, dentist, headers={"etag": '"v2"', "last-modified": old})
    assert "hours ago" not in (drives.gm.digest_line() or "")


def test_the_dry_run_logs_each_answers_headers_and_keeps_anonymised_samples(drives, tmp_path, caplog):
    feed_rig(drives, headers_fn=lambda: True)
    quiet_family(drives)
    drives.gm.own_dry_fn = lambda: True
    drives.gm.samples_dir = str(tmp_path)
    caplog.set_level(logging.INFO)
    day1 = when(drives, days=1, hour=10)
    secret_place = "2 Clinic Rd, Town, VA"
    whole = vev("series-u", "Physio with Dr Smith", day1, place=secret_place, rrule="FREQ=DAILY;COUNT=8")
    headers = {"etag": '"v1"', "content-type": "text/calendar; charset=UTF-8", "set-cookie": "NID=cookievalue"}
    fetch(drives, whole, headers=headers)
    lines = [r.getMessage() for r in caplog.records if "headers" in r.getMessage()]
    assert lines and lines[-1].endswith(f'headers 200; etag: {calendar_feed.etag_print(chr(34) + "v1" + chr(34))}; '
                                        'content-type: text/calendar; charset=UTF-8')
    assert not [r for r in caplog.records if "cookievalue" in r.getMessage() or "BEGIN:VCALENDAR" in r.getMessage()]
    second = day1 + timedelta(days=1)
    edit = vev("series-u", "Physio with Dr Smith", second + timedelta(hours=5), place=secret_place, rid=second)
    fetch(drives, whole, edit)                                      # one week moved
    third = day1 + timedelta(days=2)
    cancelled = vev("series-u", "Physio with Dr Smith", day1, place=secret_place, rrule="FREQ=DAILY;COUNT=8",
                    exdates=[third])
    fetch(drives, cancelled, edit)                                  # one week taken out
    old = vev("series-u", "Physio with Dr Smith", day1, place=secret_place, exdates=[third],
              rrule=f"FREQ=DAILY;UNTIL={_u(day1 + timedelta(days=4, hours=13))}")
    new = vev("series-u_R20261026", "Physio with Dr Smith", day1 + timedelta(days=5), place=secret_place,
              rrule="FREQ=DAILY;COUNT=3")
    fetch(drives, old, new, edit)                                   # this and following
    folder = tmp_path / "drive_samples"
    kinds = sorted(f.name.split("-")[0] for f in folder.iterdir())
    assert kinds == ["cancel", "edit", "split"]
    for f in folder.iterdir():
        text = f.read_text()
        assert "BEGIN:VEVENT" in text and "SUMMARY:Appointment" in text
        assert not re.search(r"Physio|Smith|Clinic|series-u|gmail", text)
    assert blocks(drives) == []                                     # and nothing written for him


def test_the_digest_counts_the_dry_runs_would_write_and_would_remove(drives):
    quiet_family(drives)
    drives.gm.own_dry_fn = lambda: True
    dentist = mine(drives, "Dentist", when(drives, days=3, hour=10), CLINIC)
    mine(drives, "Haircut", when(drives, days=4, hour=10), PARK)
    for place in (CLINIC, PARK):                                    # kept from before: the dry run looks nothing up
        drives.gm.drives.between(drive.HOME, place)
        drives.gm.drives.between(place, drive.HOME)
    go(drives)
    go(drives)
    assert ("Drive dry run since the last digest: 4 drive blocks would be written and 0 appointments would lose "
            "their drive blocks.") in drives.gm.digest_line()
    drives.feeds.window.occurrences.remove(dentist)
    go(drives)
    go(drives)
    assert ("Drive dry run since the last digest: 2 drive blocks would be written and 1 appointment would lose its "
            "drive blocks.") in drives.gm.digest_line()


# -- the sixth round: the header log's allowlist, remove-all for his own drives only, evidence on a normalised
#    body, family writes as the installed release (test_family_replay.py), the add-on's own blocks in the feed,
#    unambiguous splits, adoption for any unknown marked block, and no writes on partial reads (0.24.0) -----

def test_the_header_log_keeps_only_its_allowlist_never_a_redirects_address_or_a_cookie(drives, caplog):
    feed_rig(drives, headers_fn=lambda: True)
    quiet_family(drives)
    drives.gm.own_dry_fn = lambda: True
    caplog.set_level(logging.INFO)
    drives.server.status, drives.server.body = 302, b""
    drives.server.headers = {"location": FEED_URL + "?redirected=1", "set-cookie": "NID=cookievalue; path=/",
                             "cookie": "SID=othercookie", "authorization": "Bearer tokenvalue",
                             "etag": '"v1"', "date": "Wed, 18 Nov 2026 13:00:00 GMT", "x-other": "kept-out"}
    drives.cal.start()
    drives.cal.collect()
    lines = [r.getMessage() for r in caplog.records if "headers" in r.getMessage()]
    assert lines == [f"calendar {calendar_feed.feed_id(FEED_URL)[:4]}: headers 302; "
                     f"etag: {calendar_feed.etag_print(chr(34) + 'v1' + chr(34))}; "
                     "date: Wed, 18 Nov 2026 13:00:00 GMT"]
    text = " ".join(r.getMessage() for r in caplog.records)
    for secret in ("private-0123456789abcdef", "parent%40gmail.com", "cookievalue", "othercookie", "tokenvalue",
                   "location", "set-cookie", "kept-out"):
        assert secret not in text


def test_the_samples_folder_goes_when_the_dry_run_is_turned_off(drives, tmp_path):
    quiet_family(drives)
    dry = [True]
    drives.gm.own_dry_fn = lambda: dry[0]
    drives.gm.samples_dir = str(tmp_path)
    mine(drives, "Dentist", when(drives, days=3, hour=10), CLINIC)
    go(drives)
    folder = tmp_path / "drive_samples"
    folder.mkdir()
    (folder / "split-abc.ics").write_text("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")   # one kept by the dry run
    go(drives)
    assert folder.exists()
    dry[0] = False
    go(drives)
    assert not folder.exists()


def own_and_family(rig):
    """His dentist (his own appointment) and a Family event he goes to, written live: 2 + 3 blocks."""
    quiet_family(rig)
    a = when(rig, days=3, hour=10)
    mine(rig, "Dentist", a, CLINIC)
    goes(rig, "Eye doctor", when(rig, days=4, hour=10), CLINIC)
    go(rig)
    go(rig)
    assert len(blocks(rig)) == 5
    return a


def test_remove_all_under_the_dry_run_only_logs_what_it_would_remove(drives, caplog):
    a = own_and_family(drives)
    before, written = blocks(drives), len(drives.google.writes())
    drives.gm.own_dry_fn = lambda: True
    drives.gm.cleanup_fn = lambda: True
    caplog.set_level(logging.INFO, logger="harness.family_gmail")
    go(drives)
    assert blocks(drives) == before and len(drives.google.writes()) == written
    local = a.astimezone(NY)
    lines = [r.getMessage() for r in caplog.records if "would remove" in r.getMessage()]
    assert lines == [f"drive dry run: would remove Busy (drive there), {local:%a %b} {local.day} 9:30 AM to "
                     f"{local:%a %b} {local.day} 10:00 AM (remove_all_blocks)",
                     f"drive dry run: would remove Busy (drive back), {local:%a %b} {local.day} 11:00 AM to "
                     f"{local:%a %b} {local.day} 11:30 AM (remove_all_blocks)"]
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM family_gmail WHERE state='live'").fetchone()[0] == 5


def test_remove_all_spares_a_drive_block_he_edited_and_names_it(drives):
    a = own_and_family(drives)
    there = next(k for k, e in drives.google.live().items() if e["summary"] == "Busy (drive there)"
                 and datetime.fromisoformat(e["start"]["dateTime"]) == a - 30 * M)
    drives.google.hand_edit(there, summary="Busy (drive there, via the bank)")
    drives.gm.cleanup_fn = lambda: True
    go(drives)
    got = blocks(drives)
    assert ("Busy (drive there, via the bank)", a - 30 * M, a, "") in got        # his: stays
    assert ("Busy (drive back)", a + 60 * M, a + 90 * M, "") not in got          # the other comes off
    assert len(got) == 4                                                          # Family's three stay
    local = a.astimezone(NY)
    assert (f"remove_all_blocks left 1 drive block you changed on Gmail: {local:%a %b} {local.day} 9:30 AM."
            in drives.gm.digest_line())


def odd_rig(rig):
    """His dentist and five other appointments with drives, then a feed that has the dentist only, read twice:
    the second read is the first with all five gone (each missing from two full reads)."""
    feed_rig(rig)
    quiet_family(rig)
    dentist = vev("dentist", "Dentist", when(rig, days=2, hour=10), place=CLINIC)
    things = [vev(f"one-{i}", f"Thing {i}", when(rig, days=3 + i, hour=10), place=PARK) for i in range(5)]
    fetch(rig, dentist, *things, headers={"etag": '"v1"'})
    fetch(rig, dentist, *things, headers={"etag": '"v2"'})
    assert len(blocks(rig)) == 12
    flush_receipts(rig)
    fetch(rig, dentist, headers={"etag": '"cut"'})
    fetch(rig, dentist, headers={"etag": '"cut"'})                  # the same corrected body and ETag
    rig.tick()
    return dentist, things


def removal_cards(rig):
    return [s for s in rig.bot.sent if "Should their drive blocks come off" in s[1]]


def test_a_stable_reduced_body_and_etag_gets_the_card_at_the_second_read_two_hours_later(drives):
    dentist, _ = odd_rig(drives)
    before, written = blocks(drives), len(drives.google.writes())
    assert not removal_cards(drives)
    drives.clock.advance(hours=1)
    fetch(drives, dentist, headers={"etag": '"cut"'})
    drives.tick()
    assert not removal_cards(drives)                                # an hour on: not yet
    drives.clock.advance(hours=1)
    fetch(drives, dentist, headers={"etag": '"cut"'})               # 2 hours after the first: the same state
    drives.tick()
    assert len(removal_cards(drives)) == 1
    assert blocks(drives) == before and len(drives.google.writes()) == written


def test_repeated_304s_count_as_reads_of_the_same_state(drives):
    odd_rig(drives)
    before = blocks(drives)
    drives.clock.advance(hours=1)
    fetch_status(drives, 304)
    drives.tick()
    assert not removal_cards(drives)
    drives.clock.advance(hours=1)
    fetch_status(drives, 304)
    drives.tick()
    assert len(removal_cards(drives)) == 1 and blocks(drives) == before


def test_an_approval_after_the_feed_recovers_deletes_nothing(drives):
    dentist, things = odd_rig(drives)
    before = blocks(drives)
    drives.clock.advance(hours=2)
    fetch_status(drives, 304)
    drives.tick()
    card = drives.with_button("Take them off")
    written = len(drives.google.writes())
    fetch(drives, dentist, *things, headers={"etag": '"v3"'})      # the feed is whole again
    drives.press(card, "Take them off")
    for n in range(3):
        fetch(drives, dentist, *things, headers={"etag": f'"v{4 + n}"'})
    assert blocks(drives) == before
    assert not [w for w in drives.google.writes()[written:] if w[0] == "DELETE"]


def test_an_anomaly_that_persists_a_day_gets_its_card_whatever_it_shows(drives):
    dentist, _ = odd_rig(drives)
    before = blocks(drives)
    for n in range(7):                                              # every 3 hours a different body, still odd
        drives.clock.advance(hours=3)
        fetch(drives, dentist, pad=41 + n, headers={"etag": f'"c{n}"'})
        drives.tick()
        assert not removal_cards(drives), n
    drives.clock.advance(hours=3)                                   # 24 hours since it was first seen
    fetch(drives, dentist, pad=50, headers={"etag": '"c9"'})
    drives.tick()
    assert len(removal_cards(drives)) == 1 and blocks(drives) == before


@pytest.mark.parametrize("wiped", [False, True])
def test_the_add_ons_own_blocks_in_the_feed_never_count_as_his_appointments(drives, wiped):
    feed_rig(drives)
    quiet_family(drives)
    a = when(drives, days=3, hour=10)
    dentist = vev("dentist", "Dentist", a, place=CLINIC)
    ours = [vev("typed-1", "Busy (drive there)", when(drives, days=5, hour=10), place=PARK),
            vev("typed-2", "Maybe busy (drive back)", when(drives, days=6, hour=10), place=PARK),
            vev("typed-3", " busy (school pickup) ", when(drives, days=7, hour=10), place=PARK)]
    fetch(drives, dentist, *ours)
    fetch(drives, dentist, *ours)
    expected = [("Busy (drive there)", a - 30 * M, a, ""), ("Busy (drive back)", a + 60 * M, a + 90 * M, "")]
    assert blocks(drives) == expected
    written = len(drives.google.writes())
    if wiped:
        wipe_state(drives)
    for n in range(3):
        fetch(drives, dentist, *ours, headers={"etag": f'"w{n}"'})
    assert blocks(drives) == expected and len(drives.google.writes()) == written


def test_two_series_ending_the_same_day_are_removals_and_new_ones_through_the_card(drives):
    feed_rig(drives)
    quiet_family(drives)
    day1 = when(drives, days=1, hour=10)
    pt = vev("series-pt", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=6")
    yoga = vev("series-yoga", "Yoga", day1 + timedelta(hours=5), place=PARK, rrule="FREQ=DAILY;COUNT=6")
    fetch(drives, pt, yoga)
    fetch(drives, pt, yoga)
    flush_receipts(drives)
    before, written = blocks(drives), len(drives.google.writes())
    until = f"FREQ=DAILY;UNTIL={_u(day1 + timedelta(days=2, hours=13))}"
    pt_old = vev("series-pt", "PT", day1, place=CLINIC, rrule=until)
    yoga_old = vev("series-yoga", "Yoga", day1 + timedelta(hours=5), place=PARK, rrule=until)
    new = vev("series-pt_R20261024", "PT", day1 + timedelta(days=3), place=CLINIC, rrule="FREQ=DAILY;COUNT=3")
    fetch(drives, pt_old, yoga_old, new)
    drives.tick()
    cards = removal_cards(drives)
    assert [s[1].split(".")[0] for s in cards] == ["A repeating appointment of yours changed in a way I can't match "
                                                   "to the new one"]
    assert blocks(drives) == before and len(drives.google.writes()) == written   # nothing moved, removed or made
    drives.press(drives.with_button("Take them off"), "Take them off")
    fetch(drives, pt_old, yoga_old, new)
    fetch(drives, pt_old, yoga_old, new)
    got = blocks(drives)
    for n in range(3, 6):                                           # PT's new days get drives; Yoga's go
        start = day1 + timedelta(days=n)
        assert ("Busy (drive there)", start - 30 * M, start, "") in got
        assert not [b for b in got if b[1] == start + timedelta(hours=5) - 30 * M]


def test_an_unrelated_series_starting_as_another_ends_isnt_a_split(drives):
    feed_rig(drives)
    quiet_family(drives)
    day1 = when(drives, days=1, hour=10)
    pt = vev("series-pt", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=5")
    fetch(drives, pt)
    fetch(drives, pt)
    flush_receipts(drives)
    before, written = blocks(drives), len(drives.google.writes())
    pt_old = vev("series-pt", "PT", day1, place=CLINIC, rrule=f"FREQ=DAILY;UNTIL={_u(day1 + timedelta(days=2, hours=13))}")
    guitar = vev("series-guitar", "Guitar lesson", day1 + timedelta(days=3), place=CLINIC, rrule="FREQ=DAILY;COUNT=2")
    fetch(drives, pt_old, guitar)
    drives.tick()
    assert len(removal_cards(drives)) == 1                          # asked, not taken for PT moved
    assert blocks(drives) == before and len(drives.google.writes()) == written
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM drive_cards WHERE uid='series-guitar'").fetchone()[0] == 0


def test_a_split_with_a_missing_middle_instance_pairs_by_the_schedule_not_by_count(drives):
    feed_rig(drives)
    quiet_family(drives)
    day1 = when(drives, days=1, hour=10)
    whole = vev("series-u", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=8")
    fetch(drives, whole)
    fetch(drives, whole)
    flush_receipts(drives)

    def ids_by_day():
        return {datetime.fromisoformat(e["end"]["dateTime"]).astimezone(NY).date(): k
                for k, e in drives.google.live().items() if e["summary"] == "Busy (drive there)"}

    before, written = ids_by_day(), len(drives.google.writes())
    old = vev("series-u", "PT", day1, place=CLINIC, rrule=f"FREQ=DAILY;UNTIL={_u(day1 + timedelta(days=2, hours=13))}")
    sixth = day1 + timedelta(days=5)
    new = vev("series-u_R20261024", "PT", day1 + timedelta(days=3), place=CLINIC, rrule="FREQ=DAILY;COUNT=5",
              exdates=[sixth])                                      # the split, with its middle day taken out
    fetch(drives, old, new)
    fetch(drives, old, new)
    after = ids_by_day()
    assert sixth.date() not in after
    assert after == {d: k for d, k in before.items() if d != sixth.date()}      # each day keeps its own blocks
    assert [w[0] for w in drives.google.writes()[written:]] == ["DELETE", "DELETE"]   # the middle day's only
    assert not removal_cards(drives)


def test_an_older_state_file_restored_takes_back_the_blocks_it_doesnt_know(drives):
    quiet_family(drives)
    a, b = when(drives, days=3, hour=10), when(drives, days=4, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    go(drives)
    go(drives)
    assert len(blocks(drives)) == 2                                 # the state file knows these
    # Written after that copy of the state was kept, under ids it can't work out: the haircut's drives.
    mine(drives, "Haircut", b, PARK)
    for n, (title, s, e) in enumerate([("Busy (drive there)", b - 30 * M, b), ("Busy (drive back)", b + 60 * M, b + 90 * M)]):
        assert drives.gm.google.add(GMAIL, google_cal.event_id(f"restored:{n}"), title, s, e, "",
                                    google_cal.OWN_DRIVE).kind == "ok"
    written = len(drives.google.writes())
    for _ in range(3):
        go(drives)
    assert len(blocks(drives)) == 4 and len(drives.google.writes()) == written
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM family_gmail WHERE state='live'").fetchone()[0] == 4


def test_two_marked_blocks_for_one_slot_adopt_nothing_and_are_named(drives):
    quiet_family(drives)
    a = when(drives, days=3, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    for n, (title, s, e) in enumerate([("Busy (drive there)", a - 30 * M, a), ("Busy (drive there)", a - 45 * M, a),
                                       ("Busy (drive back)", a + 60 * M, a + 90 * M)]):
        assert drives.gm.google.add(GMAIL, google_cal.event_id(f"lost:{n}"), title, s, e, "",
                                    google_cal.OWN_DRIVE).kind == "ok"
    before, written = blocks(drives), len(drives.google.writes())
    for _ in range(3):
        go(drives)
    assert blocks(drives) == before and len(drives.google.writes()) == written    # none taken off, none written
    live = drives.ledger.db.execute("SELECT title FROM family_gmail WHERE state='live'").fetchall()
    assert [r["title"] for r in live] == ["Busy (drive back)"]                     # the other slot, taken back
    local = a.astimezone(NY)
    assert (f"two blocks Harness made fit the same place on your calendar ({local:%a %b} {local.day} 9:30 AM)"
            in drives.gm.digest_line())


def test_an_unmarked_lookalike_is_never_touched(drives):
    quiet_family(drives)
    a = when(drives, days=3, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    drives.google.events["hislookalike1"] = {
        "id": "hislookalike1", "status": "confirmed", "summary": "Busy (drive there)", "etag": '"0"',
        "start": {"dateTime": (a - 30 * M).isoformat()}, "end": {"dateTime": a.isoformat()},
        "visibility": "private", "transparency": "opaque", "reminders": {"useDefault": False}}
    lookalike = dict(drives.google.events["hislookalike1"])
    for _ in range(3):
        go(drives)
    assert drives.google.events["hislookalike1"] == lookalike
    assert not [c for c in drives.google.calls if c[0] != "GET" and c[1].endswith("hislookalike1")]
    assert ("Busy (drive back)", a + 60 * M, a + 90 * M, "") in blocks(drives)


# -- the seventh round: the dry run looks drives up again, a tie rule for splits, drives for entries from his
#    mail, approvals that expire and match exactly, and no feed secret in any log line (0.24.0) -------------

def test_the_dry_run_looks_up_a_drive_never_kept_and_logs_it_with_real_times_writing_nothing(drives, caplog):
    quiet_family(drives)
    drives.gm.own_dry_fn = lambda: True
    a = when(drives, days=3, hour=10)
    mine(drives, "Haircut", a, PARK)                                # no drive time kept for this address
    assert drives.ledger.db.execute("SELECT COUNT(*) FROM meta WHERE key LIKE '%drive_between%'").fetchone()[0] == 0
    writes = record_writes(drives)
    caplog.set_level(logging.INFO, logger="harness.family_gmail")
    go(drives)
    go(drives)
    local = a.astimezone(NY)
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("drive dry run")]
    assert (f"drive dry run: would write Busy (drive there), {local:%a %b} {local.day} 9:30 AM to "
            f"{local:%a %b} {local.day} 10:00 AM, for the appointment on {local:%a %b} {local.day} 10:00 AM") in lines
    assert (f"drive dry run: would write Busy (drive back), {local:%a %b} {local.day} 11:00 AM to "
            f"{local:%a %b} {local.day} 11:30 AM, for the appointment on {local:%a %b} {local.day} 10:00 AM") in lines
    assert not [x for x in lines if "no drive" in x]
    assert drives.gm.drives.lookups["own"] > 0 and drives.gm.drives.lookups["family"] == 0
    assert not [w for w in writes if "harness test" not in (w[1] or "")]   # no Google write for him
    assert not [b for b in blocks(drives) if "drive" in b[0]]


def test_a_split_whose_shifts_tie_is_asked_on_the_card_and_its_new_days_wait(drives):
    feed_rig(drives)
    quiet_family(drives)
    day1 = when(drives, days=1, hour=10)
    whole = vev("series-u", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;INTERVAL=2;COUNT=5")   # days 1 3 5 7 9
    fetch(drives, whole)
    fetch(drives, whole)
    flush_receipts(drives)
    before, written = blocks(drives), len(drives.google.writes())
    assert len(before) == 10
    # Split after day 3; the new series is every other day from day 4 (4 6 8): one day earlier and one day later
    # match the lost days 5, 7 and 9 equally often (day 4 is before the old tail and doesn't vote).
    old = vev("series-u", "PT", day1, place=CLINIC,
              rrule=f"FREQ=DAILY;INTERVAL=2;UNTIL={_u(day1 + timedelta(days=2, hours=13))}")
    new = vev("series-u_R20261024", "PT", day1 + timedelta(days=3), place=CLINIC, rrule="FREQ=DAILY;INTERVAL=2;COUNT=3")
    fetch(drives, old, new)
    drives.tick()
    cards = removal_cards(drives)
    assert [s[1].split(".")[0] for s in cards] == ["A repeating appointment of yours changed in a way I can't match "
                                                   "to the new one"]
    got = blocks(drives)

    def on(n):
        return [b for b in got if b[1].astimezone(NY).date() == (day1 + timedelta(days=n - 1)).astimezone(NY).date()]

    for n in (6, 8):                                                # inside the tail: nothing moved or made there
        assert not on(n)
    assert len(on(4)) == 2                                          # before it: a new appointment, as usual
    assert not [w for w in drives.google.writes()[written:] if w[0] != "POST"]   # nothing moved or removed
    assert [b for b in got if b in before] == before                # every old drive still there
    drives.press(drives.with_button("Take them off"), "Take them off")
    fetch(drives, old, new)
    fetch(drives, old, new)
    days = sorted({b[2].astimezone(NY).date() for b in blocks(drives) if b[0] == "Busy (drive there)"})
    assert days == [(day1 + timedelta(days=n - 1)).astimezone(NY).date() for n in (1, 3, 4, 6, 8)]


def test_a_new_series_longer_than_the_lost_tail_pairs_only_inside_it(drives):
    feed_rig(drives)
    quiet_family(drives)
    day1 = when(drives, days=1, hour=10)
    whole = vev("series-u", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=6")    # days 1 to 6
    fetch(drives, whole)
    fetch(drives, whole)
    flush_receipts(drives)

    def ids_by_day():
        return {datetime.fromisoformat(e["end"]["dateTime"]).astimezone(NY).date(): k
                for k, e in drives.google.live().items() if e["summary"] == "Busy (drive there)"}

    before, written = ids_by_day(), len(drives.google.writes())
    # Split after day 3 into a series from day 4 to day 10, with day 5 taken out: inside the lost tail (days 4 to
    # 6) days 4 and 6 stay where they were; days 7 to 10 are new appointments and don't take part in the vote.
    old = vev("series-u", "PT", day1, place=CLINIC, rrule=f"FREQ=DAILY;UNTIL={_u(day1 + timedelta(days=2, hours=13))}")
    fifth = day1 + timedelta(days=4)
    new = vev("series-u_R20261024", "PT", day1 + timedelta(days=3), place=CLINIC, rrule="FREQ=DAILY;COUNT=7",
              exdates=[fifth])
    fetch(drives, old, new)
    fetch(drives, old, new)
    after = ids_by_day()
    local = lambda n: (day1 + timedelta(days=n - 1)).astimezone(NY).date()   # noqa: E731
    for n in (1, 2, 3, 4, 6):
        assert after[local(n)] == before[local(n)]                  # each kept day keeps its own blocks
    assert local(5) not in after
    assert sorted(after) == [local(n) for n in (1, 2, 3, 4, 6, 7, 8, 9, 10)]
    methods = [w[0] for w in drives.google.writes()[written:]]
    assert methods.count("DELETE") == 2 and methods.count("POST") == 8 and set(methods) == {"DELETE", "POST"}
    assert not removal_cards(drives)


def test_a_timed_entry_made_from_his_mail_gets_drives_and_a_drive_block_after_state_loss_still_doesnt(drives):
    from harness import mail_dates
    feed_rig(drives)
    quiet_family(drives)
    a = when(drives, days=3, hour=10)
    appt = vev(mail_dates.note_id("msg-1:appointment") + "@google.com", "Appt: Dentist", a, place=CLINIC)
    fetch(drives, appt)
    fetch(drives, appt)
    expected = [("Busy (drive there)", a - 30 * M, a, ""), ("Busy (drive back)", a + 60 * M, a + 90 * M, "")]
    assert blocks(drives) == expected                               # the add-on's id form, and his appointment
    flush_receipts(drives)
    written = len(drives.google.writes())
    # The state lost, and the feed showing the drive blocks themselves (one with a title and a place that would
    # otherwise pass for an appointment): known by their kind on Gmail, never his.
    ids = {e["summary"]: k for k, e in drives.google.live().items()}
    wipe_state(drives)
    there = vev(ids["Busy (drive there)"] + "@google.com", "Busy (drive there)", a - 30 * M, hours=0.5)
    back = vev(ids["Busy (drive back)"] + "@google.com", "Drive home from the clinic", a + 60 * M, hours=0.5,
               place=PARK)
    for n in range(3):
        fetch(drives, appt, there, back, headers={"etag": f'"w{n}"'})
    assert blocks(drives) == expected and len(drives.google.writes()) == written


def asked_rig(rig, first_day=3):
    """odd_rig, with the six further out if asked, and its card sent: (dentist, things, card)."""
    feed_rig(rig)
    quiet_family(rig)
    dentist = vev("dentist", "Dentist", when(rig, days=2 if first_day == 3 else first_day + 6, hour=10), place=CLINIC)
    things = [vev(f"one-{i}", f"Thing {i}", when(rig, days=first_day + i, hour=10), place=PARK) for i in range(5)]
    fetch(rig, dentist, *things, headers={"etag": '"v1"'})
    fetch(rig, dentist, *things, headers={"etag": '"v2"'})
    assert len(blocks(rig)) == 12
    flush_receipts(rig)
    fetch(rig, dentist, headers={"etag": '"cut"'})
    fetch(rig, dentist, headers={"etag": '"cut"'})
    rig.clock.advance(hours=2)
    fetch(rig, dentist, headers={"etag": '"cut"'})
    rig.tick()
    assert len(removal_cards(rig)) == 1
    return dentist, things, rig.with_button("Take them off")


def test_an_approval_older_than_72_hours_deletes_nothing_and_the_card_asks_again(drives):
    dentist, _, card = asked_rig(drives, first_day=8)
    before, written = blocks(drives), len(drives.google.writes())
    drives.press(card, "Take them off")
    drives.clock.advance(hours=73)
    fetch(drives, dentist, headers={"etag": '"cut"'})
    drives.tick()
    assert blocks(drives) == before
    assert not [w for w in drives.google.writes()[written:] if w[0] == "DELETE"]
    assert len(removal_cards(drives)) == 2                          # asked again
    drives.press(drives.with_button("Take them off"), "Take them off")   # a fresh go is acted on
    fetch(drives, dentist, headers={"etag": '"cut"'})
    assert len(blocks(drives)) == 2


def test_a_drive_moved_since_the_card_is_spared_and_named(drives):
    dentist, _, card = asked_rig(drives)
    first = when(drives, days=3, hour=10)
    there = next(k for k, e in drives.google.live().items() if e["summary"] == "Busy (drive there)"
                 and datetime.fromisoformat(e["end"]["dateTime"]) == first)
    drives.google.hand_edit(there, start={"dateTime": (first - 45 * M).isoformat()},
                            end={"dateTime": (first - 15 * M).isoformat()})
    drives.press(card, "Take them off")
    fetch(drives, dentist, headers={"etag": '"cut"'})
    got = blocks(drives)
    assert ("Busy (drive there)", first - 45 * M, first - 15 * M, "") in got     # moved since: spared
    assert len(got) == 3                                                         # the rest came off
    local = (first - 45 * M).astimezone(NY)
    assert (f"1 drive block changed on Gmail since you said to take it off, so it stays: "
            f"{local:%a %b} {local.day} 9:15 AM." in drives.gm.digest_line())


def test_remove_all_fetches_by_id_and_spares_a_block_whose_title_or_times_read_back_differently(drives):
    a = own_and_family(drives)
    there = next(k for k, e in drives.google.live().items() if e["summary"] == "Busy (drive there)"
                 and datetime.fromisoformat(e["end"]["dateTime"]) == a)
    orig = drives.google.request

    def request(method, url, **kw):                                 # read by id: retitled, the etag the same
        answer = orig(method, url, **kw)
        if method == "GET" and unquote_path(url) == there:
            found = json.loads(answer.body)
            found["summary"] = "Busy (drive there, via the bank)"
            return HttpResponse(answer.status, dict(answer.headers), json.dumps(found).encode())
        return answer

    drives.google.request = request
    drives.gm.cleanup_fn = lambda: True
    go(drives)
    got = blocks(drives)
    assert ("Busy (drive there)", a - 30 * M, a, "") in got                     # not deleted
    assert ("Busy (drive back)", a + 60 * M, a + 90 * M, "") not in got


SECRETS_OF_THE_FEED = ("private-0123456789abcdef", "parent%40gmail.com", "/calendar/ical/", "basic.ics")


@pytest.mark.parametrize("how", ["connection", "text", "500"])
def test_a_failed_feed_read_logs_the_host_only_never_the_feeds_path(drives, caplog, how):
    feed_rig(drives, headers_fn=lambda: True)
    quiet_family(drives)
    drives.gm.own_dry_fn = lambda: True
    caplog.set_level(logging.DEBUG)
    if how == "500":
        fetch_status(drives, 500)
    else:
        def refuse(method, url, **kw):
            if how == "connection":
                raise TransportError("network", "ConnectionRefusedError")
            raise ValueError(f"bad answer from {url}?x=1")          # an exception whose text holds the address
        drives.server.request = refuse
        drives.cal.start()
        drives.cal.collect()
        drives.feeds.snapshot = drives.cal.snapshot
        drives.feeds.generation += 1
        drives.tick()
    lines = [r.getMessage() for r in caplog.records]
    named = [x for x in lines if x.startswith(f"calendar {calendar_feed.feed_id(FEED_URL)[:4]}:")]
    word = "answered 500" if how == "500" else "no answer from"
    assert [x for x in named if word in x and "calendar.google.com" in x]       # the host, by name
    for secret in SECRETS_OF_THE_FEED:
        assert not [x for x in lines if secret in x], secret


def test_the_feeds_address_in_an_etag_never_reaches_the_log(drives, caplog):
    feed_rig(drives, headers_fn=lambda: True)
    quiet_family(drives)
    drives.gm.own_dry_fn = lambda: True
    caplog.set_level(logging.DEBUG)
    etag = f'"{FEED_URL}"'
    fetch(drives, vev("dentist", "Dentist", when(drives, days=2, hour=10), place=CLINIC), headers={"etag": etag})
    lines = [r.getMessage() for r in caplog.records]
    assert [x for x in lines if f"etag: {hashlib.sha256(etag.encode()).hexdigest()[:8]}" in x]   # a fingerprint
    for secret in SECRETS_OF_THE_FEED:
        assert not [x for x in lines if secret in x], secret


def test_samples_from_an_earlier_build_go_when_the_dry_run_starts_and_the_rest_are_capped(drives, tmp_path):
    from harness import family_gmail
    feed_rig(drives)
    quiet_family(drives)
    dry = [False]
    drives.gm.own_dry_fn = lambda: dry[0]
    drives.gm.samples_dir = str(tmp_path)
    folder = tmp_path / "drive_samples"
    folder.mkdir()
    (folder / "split-0123456789.ics").write_text("BEGIN:VCALENDAR\r\nSUMMARY:Physio\r\nEND:VCALENDAR\r\n")  # an earlier build's
    day1 = when(drives, days=1, hour=10)
    whole = vev("series-u", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=8")
    dry[0] = True
    fetch(drives, whole)
    assert not (folder / "split-0123456789.ics").exists()
    today = drives.ledger.now().strftime("%Y%m%d")
    old = (drives.ledger.now() - timedelta(days=15)).strftime("%Y%m%d")
    names = [f"edit-{old}-aaaaaaaaaa.ics"] + [f"edit-{today}-{c * 10}.ics" for c in "bcde"]
    folder.mkdir(exist_ok=True)
    for name in names:
        (folder / name).write_text("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
    second = day1 + timedelta(days=1)
    fetch(drives, whole, vev("series-u", "PT", second + timedelta(hours=5), place=CLINIC, rid=second))  # an edit
    kept = sorted(f.name for f in folder.iterdir())
    assert f"edit-{old}-aaaaaaaaaa.ics" not in kept                 # over 14 days old
    assert len([k for k in kept if k.startswith("edit-")]) == family_gmail.MAX_SAMPLES == 3
