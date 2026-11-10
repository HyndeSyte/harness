"""Phase 2 of what a Family event means: his answers, live blocks, receipts and Undo.

All names are invented. No network: Family, Google, Cain's link and the model are fakes.
"""
import hashlib
import json
import shutil
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

import pytest

from harness import caldav, choices, drive, family_rules, handover, ical, meaning, meaning_live
from harness.family_gmail import DROP_TITLE, FamilyGmail, _leg_title, home_from_options, leg_key
from harness.ledger import Ledger
from harness.net import HttpResponse, TransportError
from conftest import Clock
from fakes import FakeEngine, SyncExecutor, result
from fake_caldav import FAMILY_PATH, no_network  # noqa: F401  (autouse)
from test_family_add import Rig as FamilyRig, on, rig  # noqa: F401
from test_family_copy import Feeds, GMAIL, NY, TZ, occ, seed, when
from test_family_gmail import KEY, RULES, FakeGoogle, count, g  # noqa: F401
from harness import google_cal

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
    assert reply == "Thanks. Kid sitting is on your calendar as yours."
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
    assert "Kid sitting is on your calendar" in on.bot.sent[-1][1]
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
    assert live.live.send_receipts() == 1
    live.tick()                                               # the outbox sends it
    return live.with_button("Not mine")


def test_a_new_confirmed_block_gets_one_receipt_with_three_buttons(live):
    card = confirmed(live)
    _, text, buttons, _ = card
    assert labels(buttons) == ["Not mine", "Wrong time", "Just this once"]
    assert text.startswith("On your Gmail: Busy (watching kids), ") and text.endswith(", for Turkey harvest.")
    go(live)                                                  # a refresh is not a new receipt
    assert live.live.send_receipts() == 0
    assert "each on its own card with Undo" not in live.live.digest_line()


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


@pytest.mark.parametrize("place", ["Dr Patel's office", "https://example.com/visit", "Zoom call, 2 Clinic Rd"])
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
    assert "home in the add-on's settings doesn't look like" in drives.ledger.get_meta("family_gmail_problem")


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
    assert said.endswith("his answers for these words: 1 active, 1 overruled"), said
    assert old
