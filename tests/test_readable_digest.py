"""His calendar digest (0.24.5). Nov 27, 7:47 AM, about the digest that went out on its own at 7:40:
"This digest is not digestible." It now has the shape of the Today section of Cain's morning message,
which he reads every day; the full digest is Cain's alone."""
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from harness import digest
from harness.discord_chat import to_markdown
from harness.ical import Occurrence

NY = ZoneInfo("America/New_York")
TZ = "America/New_York"
GMAIL = "dane.rickett@gmail.com"
NOW = datetime(2026, 11, 27, 7, 0, tzinfo=NY)

# What he should have got on Nov 27, exactly. PT ran into the coffee by half an hour: a real clash
# (fix round, first outside review). The merged lines take his own calendar's title.
CLASH = "8:00 PT, Synergy Buena Vista and 8:30 Coffee with Chris overlap: move one of them."
TARGET = ("**Today, Fri Nov 27**\n"
          "• **8:00** PT, Synergy Buena Vista\n"
          "• **8:30** Coffee with Chris\n"
          "• **1:00** Massage with Braden\n"
          "-# All day: Aunt Cindy birthday, Off work\n"
          "\n" + CLASH)


def at(h, m=0):
    return datetime(2026, 11, 27, h, m, tzinfo=NY)


def ev(h1, m1, h2, m2, title, cal=GMAIL, uid="", transparent=False):
    return Occurrence(at(h1, m1), at(h2, m2), False, title, cal, transparent, uid=uid)


def fam(h1, m1, h2, m2, title, uid=""):
    return ev(h1, m1, h2, m2, title, "Family", uid, transparent=True)   # as family.py reads it


def all_day(title, cal="Family", uid=""):
    return Occurrence(date(2026, 11, 27), date(2026, 11, 28), True, title, cal, True, uid=uid)


def nov27() -> digest.Agenda:
    """Nov 27 as read, in the order the digest had it. "Dane - Coffee" is Harness's copy on Family of
    his "Dane + Chris" event: a pair it keeps a record of."""
    return digest.Agenda([all_day("Aunt Cindy birthday", uid="f1"),
                          all_day("Dane - Off Work", uid="f2"),
                          fam(8, 0, 9, 0, "Dane - PT", uid="f3"),
                          ev(8, 0, 9, 0, "PT, Synergy Buena Vista", uid="g1"),
                          ev(8, 30, 10, 0, "Dane + Chris ☕️", uid="g2"),
                          fam(8, 30, 10, 0, "Dane - Coffee", uid="f4"),
                          ev(13, 0, 14, 0, "Massage with Braden", uid="g3")],
                         0, 2, 2, labels=True, pairs=frozenset({frozenset(("g2", "f4"))}), name="Dane")


def compose(agenda, **kw):
    base = dict(now=NOW, tz=TZ, inputs=[digest.InputCoverage("Discord", NOW, timedelta(minutes=15))],
                waiting=[], failures=[], low_balance=[], canary_ok=True,
                config_unchanged_since=NOW - timedelta(days=6))
    base.update(kw)
    return digest.compose(agenda=agenda, **base)


def shown(d) -> str:
    """What Discord shows him, as markdown source."""
    return to_markdown(d.owner)


def seen(text: str) -> str:
    """What he reads: the markdown source without its escapes."""
    return re.sub(r"\\(.)", r"\1", text)


def test_the_nov_27_digest_renders_exactly_the_target():
    d = compose(nov27(), extra=["Drive dry run since the last digest: 3 drive blocks would be written.",
                                "New on Gmail from what Family events mean: 19 blocks, each on its own card."])
    assert shown(d) == TARGET
    assert digest.as_markdown(d.owner) == TARGET               # what Cain folds in, the same
    for gone in ("inputs fresh", "need you", "dane rickett", "Family", "Dane - ", "⚠", "AM", "PM",
                 "Drive dry run", "each on its own card", "Clear"):
        assert gone not in shown(d), gone


HEAD = "**Today, Fri Nov 27**"


def bullets(text: str) -> list[str]:
    return [x for x in text.split("\n") if x.startswith("• ")]


def problem_lines(text: str) -> list[str]:
    return text.split("\n\n", 1)[1].split("\n") if "\n\n" in text else []


# -- merges (finding 1) ---------------------------------------------------------------------------

def test_a_family_and_gmail_pair_is_one_line_with_no_overlap_mark():
    # No record of this pair: same start and end, "Dane - PT" says PT, and the other is the only
    # candidate on either side. PT is two letters but in capitals: an abbreviation, a real word.
    a = digest.Agenda([fam(8, 0, 9, 0, "Dane - PT", uid="f3"), ev(8, 0, 9, 0, "PT, Synergy Buena Vista", uid="g1")],
                      0, 2, 2, labels=True, name="Dane")
    assert shown(compose(a)) == HEAD + "\n• **8:00** PT, Synergy Buena Vista"
    # Harness's own copy with another word, kept in its record: one line too, his own title.
    a = digest.Agenda([ev(9, 0, 10, 0, "Checkup with Dr Lee", uid="g5"), fam(9, 0, 10, 0, "Dane - Doctor", uid="f5")],
                      0, 2, 2, labels=True, pairs=frozenset({frozenset(("g5", "f5"))}), name="Dane")
    assert shown(compose(a)) == HEAD + "\n• **9:00** Checkup with Dr Lee"
    # The same title on two of his calendars at the same time: one event, one line.
    a = digest.Agenda([ev(8, 0, 9, 0, "Board review", uid="g1"), ev(8, 0, 9, 0, "Board review", "work@example.com")],
                      0, 2, 2, labels=True, name="Dane")
    assert shown(compose(a)) == HEAD + "\n• **8:00** Board review"


def test_a_record_pair_whose_start_or_end_differs_stays_two_events():
    pairs = frozenset({frozenset(("g5", "f5"))})
    a = digest.Agenda([ev(9, 0, 10, 0, "Checkup", uid="g5"), fam(11, 0, 12, 0, "Dane - Doctor", uid="f5")],
                      0, 2, 2, pairs=pairs, name="Dane")
    assert bullets(shown(compose(a))) == ["• **9:00** Checkup", "• **11:00** Doctor"]
    # Same start, a different end: two lines, and a clash (both are his); the mismatch is Cain's.
    a = digest.Agenda([ev(9, 0, 10, 0, "Checkup", uid="g5"), fam(9, 0, 10, 30, "Dane - Doctor", uid="f5")],
                      0, 2, 2, pairs=pairs, name="Dane")
    d = compose(a)
    assert bullets(shown(d)) == ["• **9:00** Checkup", "• **9:00** Doctor"]
    assert "Family copy out of step: Checkup" in d.text and "out of step" not in d.owner


def test_someone_plus_him_alone_never_merges():
    # "Dane + Sam" and "Dane - Haircut" at the same time, no record: two events, both shown.
    a = digest.Agenda([ev(15, 0, 16, 0, "Dane + Sam", uid="g1"), fam(15, 0, 16, 0, "Dane - Haircut", uid="f1")],
                      0, 2, 2, name="Dane")
    text = shown(compose(a))
    assert bullets(text) == ["• **3:00** Dane + Sam", "• **3:00** Haircut"]
    assert problem_lines(text) == ["3:00 Dane + Sam and 3:00 Haircut overlap: move one of them."]


def test_a_lone_generic_word_or_short_words_never_merge():
    for word, other in (("Call", "Call with the bank"), ("Meeting", "Meeting, budget"), ("Lunch", "Lunch at Joe's"),
                        ("Appointment", "Appointment, dentist"), ("at it", "at it again")):
        a = digest.Agenda([fam(10, 0, 11, 0, f"Dane - {word}"), ev(10, 0, 11, 0, other)], 0, 2, 2, name="Dane")
        assert len(bullets(shown(compose(a)))) == 2, word
    # Two words, one of them generic: meaningful enough.
    a = digest.Agenda([fam(10, 0, 11, 0, "Dane - Bank call"), ev(10, 0, 11, 0, "Call with the bank")],
                      0, 2, 2, name="Dane")
    assert bullets(shown(compose(a))) == ["• **10:00** Call with the bank"]


def test_two_candidates_on_one_side_means_both_are_shown():
    a = digest.Agenda([ev(8, 0, 9, 0, "PT, Synergy Buena Vista", uid="g1"), fam(8, 0, 9, 0, "Dane - PT", uid="f3"),
                       ev(8, 0, 9, 0, "PT session", "work@example.com", uid="g9")], 0, 3, 3, labels=True, name="Dane")
    assert len(bullets(shown(compose(a)))) == 3
    # And two "Dane - X" on Family that both fit one event of his: none merges.
    a = digest.Agenda([fam(8, 0, 9, 0, "Dane - PT"), fam(8, 0, 9, 0, "Dane - PT Synergy"),
                       ev(8, 0, 9, 0, "PT, Synergy Buena Vista")], 0, 2, 2, name="Dane")
    assert len(bullets(shown(compose(a)))) == 3


def test_a_three_event_chain_never_puts_two_from_one_calendar_in_a_group():
    # A (his own) and B (Family) are a record pair; C (his own again) says B's words too.
    a = digest.Agenda([ev(9, 0, 10, 0, "Dentist", uid="a"), fam(9, 0, 10, 0, "Dane - Dentist", uid="b"),
                       ev(9, 0, 10, 0, "Dentist", uid="c")],
                      0, 2, 2, pairs=frozenset({frozenset(("a", "b"))}), name="Dane")
    text = shown(compose(a))
    assert bullets(text) == ["• **9:00** Dentist", "• **9:00** Dentist"]       # A with B, and C
    assert len(problem_lines(text)) == 1
    groups, _ = digest._groups(list(a.occurrences), a.pairs, "Dane")
    assert sorted(map(sorted, groups)) == [[0, 1], [2]]
    for g in groups:
        cals = [a.occurrences[k].calendar for k in g]
        assert len(cals) == len(set(cals))


# -- titles (finding 2) ---------------------------------------------------------------------------

def test_the_merged_title_is_his_own_or_x_with_y_from_both_titles():
    pairs = frozenset({frozenset(("g2", "f4"))})
    a = digest.Agenda([ev(8, 30, 10, 0, "Dane + Chris ☕️", uid="g2"), fam(8, 30, 10, 0, "Dane - Coffee", uid="f4")],
                      0, 2, 2, pairs=pairs, name="Dane")
    assert bullets(shown(compose(a))) == ["• **8:30** Coffee with Chris"]
    a = digest.Agenda([ev(8, 30, 10, 0, "Vet 🐶 visit", uid="g2"), fam(8, 30, 10, 0, "Dane - Vet", uid="f4")],
                      0, 2, 2, pairs=pairs, name="Dane")
    assert bullets(shown(compose(a))) == ["• **8:30** Vet visit"]


# -- clashes (finding 3) --------------------------------------------------------------------------

def clash_count(*events, name="Dane") -> int:
    return sum("overlap" in x for x in problem_lines(shown(compose(digest.Agenda(list(events), 0, 2, 2, name=name)))))


def test_a_true_clash_of_two_different_events_is_one_problem_line():
    a = digest.Agenda([ev(10, 0, 11, 0, "Dentist"), ev(10, 0, 10, 30, "School call"),
                       ev(13, 0, 14, 0, "Massage with Braden")], 0, 1, 1, name="Dane")
    lines = shown(compose(a)).split("\n")
    assert lines == [HEAD, "• **10:00** Dentist", "• **10:00** School call",
                     "• **1:00** Massage with Braden", "",
                     "10:00 Dentist and 10:00 School call overlap: move one of them."]


def test_clash_rule_overlaps_and_run_overs():
    assert clash_count(ev(10, 0, 11, 0, "A"), ev(10, 30, 11, 30, "B")) == 1          # exactly half
    assert clash_count(ev(9, 0, 12, 0, "A"), ev(11, 0, 14, 0, "B")) == 1             # long on long
    assert clash_count(ev(9, 0, 12, 0, "A"), ev(10, 0, 10, 15, "B")) == 1            # one inside the other
    assert clash_count(fam(10, 0, 11, 0, "Dane - Gym"), ev(10, 30, 11, 30, "Dentist")) == 1   # Family's own vs own
    assert clash_count(ev(10, 0, 11, 0, "A"), ev(10, 50, 11, 30, "B")) == 0          # 10-minute run-over
    assert clash_count(ev(10, 0, 11, 0, "A"), ev(10, 49, 11, 30, "B")) == 1          # 11 minutes is a clash
    assert clash_count(ev(10, 0, 11, 0, "A"), ev(11, 0, 12, 0, "B")) == 0            # back to back
    # Family's other events are context, never a clash; a free event of his is none either.
    assert clash_count(ev(10, 0, 11, 0, "Dentist"), fam(10, 0, 11, 0, "Sam - Soccer")) == 0
    assert clash_count(ev(10, 0, 11, 0, "Dentist"), ev(10, 0, 11, 0, "Hold", transparent=True)) == 0


def test_two_events_on_one_calendar_are_never_one():
    a = digest.Agenda([ev(10, 0, 11, 0, "(work item, title not kept)"), ev(10, 0, 11, 0, "(work item, title not kept)")],
                      0, 1, 1)
    lines = shown(compose(a)).split("\n")
    assert len(bullets("\n".join(lines))) == 2 and "overlap" in lines[-1]


# -- problems (finding 4) -------------------------------------------------------------------------

FAILED = ("your change to “Lunch” (Thu 3:00 PM) wasn't done: the calendar refused it. Nothing changed.")


def test_up_to_three_problems_all_show():
    d = compose(digest.Agenda([ev(9, 0, 10, 0, "A")], 0, 1, 1), failures=[FAILED])
    assert seen(shown(d)).split("\n")[-1] == "Your change to “Lunch” (Thu 3:00 PM) wasn't done: the calendar refused it. Nothing changed."
    a = digest.Agenda([ev(9, 0, 10, 0, "A"), ev(9, 0, 10, 0, "B"), ev(13, 0, 14, 0, "C")], 0, 1, 2)
    lines = problem_lines(shown(compose(a, failures=[FAILED])))
    assert len(lines) == 3 and "A and 9:00 B overlap" in lines[0]
    assert lines[1].startswith("Your change") and lines[2].startswith("1 of 2 calendars")


def test_more_than_three_problems_fold_only_the_clashes():
    a = digest.Agenda([ev(9, 0, 10, 0, "A"), ev(9, 0, 10, 0, "B"), ev(10, 0, 11, 0, "C"), ev(10, 0, 11, 0, "D"),
                       ev(13, 30, 14, 0, "E"), ev(13, 30, 14, 0, "F"), ev(16, 0, 17, 0, "G"), ev(16, 0, 17, 0, "H")],
                      2, 1, 2)
    lines = problem_lines(shown(compose(a, failures=[FAILED])))
    # Three that are never dropped (the change, the unread calendar, the unread events), and the
    # four clashes in one line.
    assert lines[0] == "4 clashes: 9:00, 10:00, 1:30, 4:00. Move one event of each."
    assert lines[1].startswith("Your change") and lines[2].startswith("1 of 2 calendars")
    assert lines[3] == "2 events couldn't be read, so they are not listed."
    assert len(lines) == 4
    # One problem besides: one clash in full, then the rest in one line.
    lines = problem_lines(seen(shown(compose(digest.Agenda(list(a.occurrences), 0, 2, 2), failures=[FAILED]))))
    assert lines == ["9:00 A and 9:00 B overlap: move one of them.",
                     "3 more clashes: 10:00, 1:30, 4:00. Move one event of each.",
                     "Your change to “Lunch” (Thu 3:00 PM) wasn't done: the calendar refused it. Nothing changed."]
    # Five changes that didn't go through: every one is said.
    lines = problem_lines(shown(compose(digest.Agenda([ev(9, 0, 10, 0, "A")], 0, 1, 1),
                                        failures=[FAILED.replace("Lunch", f"Lunch {k}") for k in range(5)])))
    assert len(lines) == 5 and all(f"Lunch {k}" in lines[k] for k in range(5))


def test_all_day_items_on_one_small_line_at_the_end():
    a = digest.Agenda([all_day("Aunt Cindy birthday"), all_day("Dane - Off Work"),
                       all_day("Azure Standard order cutoff", GMAIL), ev(9, 0, 10, 0, "Vet visit")], 0, 2, 2,
                      name="Dane")
    lines = shown(compose(a)).split("\n")
    assert lines[-1] == "-# All day: Aunt Cindy birthday, Off work, Azure Standard order cutoff"
    assert sum(line.startswith("-#") for line in lines) == 1 and "All day" not in "\n".join(lines[:-1])


def test_no_em_dash_in_what_he_sees():
    a = digest.Agenda([ev(9, 0, 10, 0, "Lunch — Chris"), all_day("Trip—Boston", GMAIL),
                       ev(11, 0, 12, 0, "Call— Sam")], 0, 1, 1)
    text = shown(compose(a, failures=["your change to “A — B” wasn't done."]))
    assert "—" not in text
    assert "• **9:00** Lunch, Chris" in text and "• **11:00** Call, Sam" in text and "Trip, Boston" in text


def test_the_detail_cain_needs_stays_in_the_full_digest():
    extra = ["Drive dry run since the last digest: 3 drive blocks would be written and 1 appointment "
             "would lose its drive blocks.",
             "Blocks on Gmail from Family: 2 added."]
    d = compose(nov27(), extra=extra, waiting=[digest.Waiting("a change you asked for", NOW - timedelta(hours=1))])
    assert d.state == "decision"
    for kept in ["Decision needed", "1 waiting", "All day · Dane - Off Work · Family",
                 "8:00 AM–9:00 AM PT, Synergy Buena Vista · dane rickett ⚠ overlaps", *extra]:
        assert kept in d.text, kept
    assert "Decision needed" not in d.owner and "Drive dry run" not in d.owner and "waiting" not in d.owner


# -- length (finding 5) ---------------------------------------------------------------------------

def every_line_once(parts: list[str], expected: list[str]) -> None:
    joined = seen("\n".join(to_markdown(p) for p in parts))
    for e in expected:
        assert joined.count(e) == 1, e


def test_a_day_of_twelve_events_lists_all_twelve_in_one_message():
    long = "Planning {} with the whole extended family about the holiday schedule and who drives "
    a = digest.Agenda([ev(7 + k, 0, 7 + k, 30, long.format(k) * 2) for k in range(12)]
                      + [all_day("A very long all-day item that goes on and on " * 3, GMAIL)], 0, 1, 1)
    d = compose(a)
    assert len(d.owner_parts) == 1
    text = shown(d)
    assert len(d.text) > 1800 and len(text) <= 1800      # it had to shorten titles
    lines = bullets(text)
    assert len(lines) == 12 and all(f"Planning {k} " in lines[k] for k in range(12))
    assert lines[-1].startswith("• **6:00** ") and "more" not in text
    assert lines[0].endswith("\u2026") and text.split("\n")[-1].startswith("-# All day: A very long")
    assert "Massage with Braden" in shown(compose(nov27()))          # a short day keeps its titles whole


def test_the_worst_case_day_is_two_messages_with_everything_once():
    events = [ev(6 + k // 2, 30 * (k % 2), 6 + k // 2, 30 * (k % 2) + 20,
                 f"Event {k:02d} with a long title about the plans of the whole family ") for k in range(30)]
    days = [all_day(f"All-day item {k} that goes on and on about the trip and the packing list", GMAIL)
            for k in range(6)]
    fails = [f"your change to “Long title {k} {'x' * 400}” (Thu 3:00 PM) wasn't done." for k in range(3)]
    d = compose(digest.Agenda(events + days, 1, 1, 2), failures=fails)
    parts = list(d.owner_parts)
    assert len(parts) == 2
    assert all(len(to_markdown(p)) <= 1800 for p in parts)
    assert to_markdown(parts[0]).startswith(HEAD) and to_markdown(parts[1]).startswith("**Today, continued**")
    every_line_once(parts, [f"Event {k:02d} " for k in range(30)] + [f"All-day item {k} " for k in range(6)]
                    + [f"Long title {k} " for k in range(3)]
                    + ["1 of 2 calendars weren't read", "1 event couldn't be read"])
    # Split only between two events: the first message ends on an event line, the second goes on
    # with the next one, and the all-day line and the problems close the day.
    first, second = (to_markdown(p).split("\n") for p in parts)
    assert first[-1].startswith("• **") and second[1].startswith("• **")
    assert len(bullets(to_markdown(parts[0]))) + len(bullets(to_markdown(parts[1]))) == 30
    # A problem line is bounded, and so is each all-day item.
    lines = [x for p in parts for x in to_markdown(p).split("\n")]
    assert all(len(x) < 300 for x in lines if x.startswith("Your change"))
    small = next(x for x in lines if x.startswith("-# All day: "))
    assert all(len(item) <= 64 for item in seen(small)[len("-# All day: "):].split(", "))


def test_a_two_message_digest_reaches_him_and_cain_in_order(ledger, tmp_path):
    from harness import daily
    from harness.config import Config
    events = [ev(6 + k // 3, 20 * (k % 3), 6 + k // 3, 20 * (k % 3) + 15,
                 f"Event {k:02d} with a long title about the plans of the whole family " * 3) for k in range(40)]
    d = compose(digest.Agenda(events, 0, 1, 1))
    assert len(d.owner_parts) == 2
    ledger.set_meta("last_digest_owner_parts", "")
    with ledger.tx() as db:
        ledger.set_meta("last_digest_owner_parts", __import__("json").dumps(list(d.owner_parts)), db)
        ledger.set_meta("last_digest_owner", d.owner, db)
    assert daily.owner_parts(ledger) == list(d.owner_parts)
    said = digest.said(daily.owner_parts(ledger))
    assert said.startswith("[Message 1 of 2]\n**Today, Fri Nov 27**")
    assert "\n\n[Message 2 of 2]\n**Today, continued**" in said


# -- yesterday and the clock (findings 6 and 7) ---------------------------------------------------

def test_an_event_from_yesterday_that_runs_into_today_is_listed():
    night = Occurrence(datetime(2026, 11, 26, 22, 0, tzinfo=NY), at(2, 0), False, "Night shift", GMAIL)
    older = Occurrence(datetime(2026, 11, 25, 9, 0, tzinfo=NY), at(12, 0), False, "Conference", GMAIL)
    text = seen(shown(compose(digest.Agenda([older, night, ev(9, 0, 10, 0, "Vet")], 0, 1, 1))))
    assert bullets(text) == ["• **9:00 AM** Conference (since Wed Nov 25)",
                             "• **10:00 PM** Night shift (since yesterday)", "• **9:00** Vet"]
    assert "overlap" in text                                   # the conference runs over the vet


def test_the_seven_pm_boundary():
    text = shown(compose(digest.Agenda([ev(6, 30, 6, 45, "Early"), ev(18, 59, 19, 30, "Late call"),
                                        ev(19, 30, 20, 0, "Dinner")], 0, 1, 1)))
    assert bullets(text) == ["• **6:30 AM** Early", "• **6:59** Late call", "• **7:30 PM** Dinner"]


def test_an_event_in_another_time_zone_is_shown_in_his():
    la = ZoneInfo("America/Los_Angeles")
    o = Occurrence(datetime(2026, 11, 27, 9, 0, tzinfo=la), datetime(2026, 11, 27, 10, 0, tzinfo=la), False,
                   "Call with Seattle", GMAIL)
    text = shown(compose(digest.Agenda([o, ev(12, 30, 13, 30, "Lunch")], 0, 1, 1)))
    assert bullets(text) == ["• **12:00** Call with Seattle", "• **12:30** Lunch"]
    assert "overlap" in text                                   # 12:00 to 1:00 against 12:30


def test_a_daylight_saving_day_counts_true_minutes():
    now = datetime(2026, 11, 1, 7, 0, tzinfo=NY)               # clocks went back at 2:00 AM
    a = Occurrence(datetime(2026, 11, 1, 0, 30, tzinfo=NY), datetime(2026, 11, 1, 1, 30, tzinfo=NY),
                   False, "Late party", GMAIL)                 # ends 1:30 EDT
    b = Occurrence(datetime(2026, 11, 1, 1, 15, fold=1, tzinfo=NY), datetime(2026, 11, 1, 2, 30, tzinfo=NY),
                   False, "Drive home", GMAIL)                 # starts 1:15 EST, 45 minutes later
    c = Occurrence(datetime(2026, 11, 1, 9, 0, tzinfo=NY), datetime(2026, 11, 1, 10, 0, tzinfo=NY), False,
                   "Church", GMAIL)
    text = shown(compose(digest.Agenda([a, b, c], 0, 1, 1), now=now))
    assert text.startswith("**Today, Sun Nov 1**")
    assert bullets(text) == ["• **12:30 AM** Late party", "• **1:15 AM** Drive home", "• **9:00** Church"]
    assert "overlap" not in text                               # wall clocks overlap; true time doesn't


# -- what can't format or ping ----------------------------------------------------------------------

def test_an_unread_day_is_never_shown_as_empty():
    none = shown(compose(digest.Agenda([], 0, 0, 2)))
    assert "can't say what's on them" in none and "Nothing" not in none
    part = shown(compose(digest.Agenda([ev(9, 0, 10, 0, "Vet visit")], 0, 1, 2)))
    assert part.endswith("1 of 2 calendars weren't read today, so this list may be missing events.")
    assert shown(compose(digest.Agenda([], 0, 2, 2))) == HEAD + "\nNothing on the calendar."


def test_titles_cant_format_or_ping():
    a = digest.Agenda([ev(9, 0, 10, 0, "**Bold** @everyone [x](y)")], 0, 1, 1)
    text = shown(compose(a))
    assert "\\*\\*Bold\\*\\*" in text and "\\[x\\]" in text and "@⁠everyone" in text


def test_all_day_and_problem_lines_cant_format_or_ping():
    a = digest.Agenda([all_day("-# Big **news** @everyone"), all_day("# Heading [x](https://evil.example/y)", GMAIL),
                       ev(9, 0, 10, 0, "> quote <@123>"), ev(9, 0, 10, 0, "`code` @here")], 0, 2, 2, name="Dane")
    d = compose(a, failures=["your change to “**Lunch** @everyone https://evil.example/z” wasn't done."])
    for text in (shown(d), digest.as_markdown(d.owner)):
        small = [x for x in text.split("\n") if x.startswith("-# ")]
        assert len(small) == 1 and small[0].startswith("-# All day: \\-\\# Big \\*\\*news\\*\\*")
        assert "\\# Heading" in small[0] and "evil\\[.\\]example" in small[0] and "](" not in small[0]
        assert "@everyone" not in text and "@here" not in text and "https://evil" not in text
        assert "**Lunch**" not in text and "\\*\\*Lunch\\*\\*" in text
        assert not any(x.startswith(("#", ">", "-#  ", "`")) for x in text.split("\n") if not x.startswith("-# All day"))


def test_the_copies_record_names_the_pairs_it_keeps(ledger):
    from harness.family_copy import FamilyCopy, _key
    mine = ev(8, 30, 10, 0, "Dane + Chris ☕️", uid="g2")
    with ledger.tx() as db:
        for key, uid, state in ((_key(mine), "f4", "live"), (_key(ev(9, 0, 10, 0, "x", uid="g8")), "f8", "removed")):
            db.execute("INSERT INTO family_copies(key, uid, href, hand, seen, word, title, start, end, state, missing,"
                       " created_at, updated_at) VALUES(?,?,'',0,'','Coffee','Dane - Coffee','','',?,0,'','')",
                       (key, uid, state))
    copy = FamilyCopy(ledger, type("FamilyAdd", (), {"client": None})(), None, name_fn=lambda: "Dane", tz=TZ)
    today = [mine, fam(8, 30, 10, 0, "Dane - Coffee", uid="f4"), ev(9, 0, 10, 0, "x", uid="g8")]
    assert copy.pairs(today) == {frozenset(("g2", "f4"))}         # a removed copy is no pair
