"""His calendar digest (0.24.5). Nov 27, 7:47 AM, about the digest that went out on its own at 7:40:
"This digest is not digestible." It now has the shape of the Today section of Cain's morning message,
which he reads every day; the full digest is Cain's alone."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from harness import digest
from harness.discord_chat import to_markdown
from harness.ical import Occurrence

NY = ZoneInfo("America/New_York")
TZ = "America/New_York"
GMAIL = "dane.rickett@gmail.com"
NOW = datetime(2026, 11, 27, 7, 0, tzinfo=NY)

# What he should have got on Nov 27, exactly.
TARGET = ("**Today, Fri Nov 27**\n"
          "• **8:00** PT\n"
          "• **8:30** Coffee with Chris\n"
          "• **1:00** Massage with Braden\n"
          "-# All day: Aunt Cindy birthday, Off work")


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
    """What Discord shows him."""
    return to_markdown(d.owner)


def test_the_nov_27_digest_renders_exactly_the_target():
    d = compose(nov27(), extra=["Drive dry run since the last digest: 3 drive blocks would be written.",
                                "New on Gmail from what Family events mean: 19 blocks, each on its own card."])
    assert shown(d) == TARGET
    assert digest.as_markdown(d.owner) == TARGET               # what Cain folds in, the same
    for gone in ("inputs fresh", "need you", "dane rickett", "Family", "Dane - ", "overlaps", "AM", "PM",
                 "Drive dry run", "each on its own card", "Clear"):
        assert gone not in shown(d), gone


def test_a_family_and_gmail_pair_is_one_line_with_no_overlap_mark():
    # No record of this pair: same start and end, and "Dane - PT" says a word of the other.
    a = digest.Agenda([fam(8, 0, 9, 0, "Dane - PT", uid="f3"), ev(8, 0, 9, 0, "PT, Synergy Buena Vista", uid="g1")],
                      0, 2, 2, labels=True, name="Dane")
    d = compose(a)
    assert shown(d) == "**Today, Fri Nov 27**\n• **8:00** PT"
    # Harness's own copy with another word, kept in its record: one line too, at the same start.
    a = digest.Agenda([ev(9, 0, 10, 0, "Checkup with Dr Lee", uid="g5"), fam(9, 0, 10, 0, "Dane - Doctor", uid="f5")],
                      0, 2, 2, labels=True, pairs=frozenset({frozenset(("g5", "f5"))}), name="Dane")
    assert shown(compose(a)) == "**Today, Fri Nov 27**\n• **9:00** Checkup with Dr Lee"
    # Two of his own Gmail events at the same time with the Family copy collapse to one, not a clash.
    a = digest.Agenda([ev(8, 0, 9, 0, "PT, Synergy Buena Vista", uid="g1"), fam(8, 0, 9, 0, "Dane - PT", uid="f3"),
                       ev(8, 0, 9, 0, "PT", "work@example.com", uid="g9")], 0, 3, 3, labels=True, name="Dane")
    assert shown(compose(a)) == "**Today, Fri Nov 27**\n• **8:00** PT"


def test_a_record_pair_at_different_starts_stays_two_events():
    a = digest.Agenda([ev(9, 0, 10, 0, "Checkup", uid="g5"), fam(11, 0, 12, 0, "Dane - Doctor", uid="f5")],
                      0, 2, 2, pairs=frozenset({frozenset(("g5", "f5"))}), name="Dane")
    assert shown(compose(a)) == "**Today, Fri Nov 27**\n• **9:00** Checkup\n• **11:00** Doctor"


def test_a_true_clash_of_two_different_events_is_one_problem_line():
    a = digest.Agenda([ev(10, 0, 11, 0, "Dentist"), ev(10, 0, 10, 30, "School call"),
                       ev(13, 0, 14, 0, "Massage with Braden")], 0, 1, 1, name="Dane")
    lines = shown(compose(a)).split("\n")
    assert lines == ["**Today, Fri Nov 27**", "• **10:00** Dentist", "• **10:00** School call",
                     "• **1:00** Massage with Braden", "",
                     "10:00 Dentist and 10:00 School call are at the same time: move one of them."]
    # A short overlap, one running into the next, is not a clash: nothing to do.
    a = digest.Agenda([ev(10, 0, 11, 0, "Dentist"), ev(10, 45, 11, 30, "School call")], 0, 1, 1)
    assert "same time" not in shown(compose(a))
    # Family's own events are context, never a clash.
    a = digest.Agenda([ev(10, 0, 11, 0, "Dentist"), fam(10, 0, 11, 0, "Sam - Soccer")], 0, 2, 2, name="Dane")
    assert "same time" not in shown(compose(a))


def test_at_most_three_problem_lines():
    a = digest.Agenda([ev(9, 0, 10, 0, "A"), ev(9, 0, 10, 0, "B"), ev(9, 0, 10, 0, "C"), ev(9, 0, 10, 0, "D")],
                      0, 1, 2)
    d = compose(a, failures=["your change to “Lunch” (Thu 3:00 PM) wasn't done: the calendar refused "
                             "it. Nothing changed."])
    text = shown(d)
    problems = text.split("\n\n", 1)[1].split("\n")
    assert len(problems) == 3 and all("same time" in p for p in problems)
    # A change he asked for that didn't go through: what it was, when, and what came of it.
    d = compose(digest.Agenda([ev(9, 0, 10, 0, "A")], 0, 1, 1),
                failures=["your change to “Lunch” (Thu 3:00 PM) wasn't done: the calendar refused it. "
                          "Nothing changed."])
    assert shown(d).endswith("wasn't done: the calendar refused it. Nothing changed.")
    assert shown(d).split("\n")[-1].startswith("Your change to")


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
    text = shown(compose(a))
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


def test_a_day_of_twelve_events_lists_all_twelve_under_the_cap():
    long = "Planning {} with the whole extended family about the holiday schedule and who drives "
    a = digest.Agenda([ev(7 + k, 0, 7 + k, 30, long.format(k) * 2) for k in range(12)]
                      + [all_day("A very long all-day item that goes on and on " * 3, GMAIL)], 0, 1, 1)
    text = shown(compose(a))
    assert len(compose(a).text) > 1800 and len(text) < 1800      # it had to shorten titles
    lines = [line for line in text.split("\n") if line.startswith("• **")]
    assert len(lines) == 12 and all(f"Planning {k} " in lines[k] for k in range(12))
    assert lines[-1].startswith("• **6:00** ") and "more" not in text
    assert lines[0].endswith("\u2026") and text.split("\n")[-1].startswith("-# All day: A very long")
    # A short day keeps its titles whole.
    assert "Massage with Braden" in shown(compose(nov27()))


def test_an_unread_day_is_never_shown_as_empty():
    none = shown(compose(digest.Agenda([], 0, 0, 2)))
    assert "can't say what's on them" in none and "Nothing" not in none
    part = shown(compose(digest.Agenda([ev(9, 0, 10, 0, "Vet visit")], 0, 1, 2)))
    assert part.endswith("1 of 2 calendars weren't read today, so this list may be missing events.")
    assert shown(compose(digest.Agenda([], 0, 2, 2))) == "**Today, Fri Nov 27**\nNothing on the calendar."


def test_titles_cant_format_or_ping():
    a = digest.Agenda([ev(9, 0, 10, 0, "**Bold** @everyone [x](y)")], 0, 1, 1)
    text = shown(compose(a))
    assert "\\*\\*Bold\\*\\*" in text and "\\[x\\]" in text and "@⁠everyone" in text


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


def test_two_events_on_one_calendar_are_never_one():
    a = digest.Agenda([ev(10, 0, 11, 0, "(work item, title not kept)"), ev(10, 0, 11, 0, "(work item, title not kept)")],
                      0, 1, 1)
    lines = shown(compose(a)).split("\n")
    assert len([x for x in lines if x.startswith("•")]) == 2 and "same time" in lines[-1]
