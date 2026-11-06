"""1.0: what a Family event means for him, as he says it, in place of title lists.

All names are invented.
"""
from datetime import datetime, timedelta

from harness import family_rules
from harness.family_gmail import DROP_TITLE, FamilyGmail, PICK_TITLE
from harness.family_rules import Rule, pick
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_family_add import on, rig  # noqa: F401
from test_family_copy import TZ, occ, seed, when
from test_family_gmail import g, go  # noqa: F401
from test_calendar_change import CRig, change, r  # noqa: F401


def said(rig, *pairs):
    with rig.ledger.tx() as db:
        for words, kind in pairs:
            family_rules.put(rig.ledger, words, kind, db)


# -- which rule ---------------------------------------------------------------------------------

def test_a_rule_goes_by_its_words_and_the_most_words_win():
    rules = (Rule("School Day", "school"), Rule("School Day Pictures", "none"), Rule("dentist", "kids"))
    assert pick("Sam & Ivy School Day \U0001f4da", rules).kind == "school"
    assert pick("School Day Pictures", rules).kind == "none"
    assert pick("Homeschool day", rules) is None
    assert pick("Pat dentist", rules).kind == "kids"


def test_two_rules_that_disagree_give_the_busier_kind():
    rules = (Rule("Pat dentist", "none"), Rule("dentist Thursday", "kids"))
    assert pick("Pat dentist Thursday", rules).kind == "kids"


def test_a_lone_letter_doesnt_count():
    assert pick("Pat dentist", (Rule("Pat\u2019s dentist", "kids"),)).kind == "kids"


def test_saying_it_again_replaces_it(g):
    said(g, ("Pat dentist", "kids"), ("pat  DENTIST", "none"))
    assert family_rules.load(g.ledger) == (Rule("pat  DENTIST", "none"),)


# -- what Gmail gets -------------------------------------------------------------------------------

def rules_rig(g):
    g.gm = FamilyGmail(g.ledger, g.fa, g.feeds, g.client, rules_fn=lambda: g.rules,
                       said_fn=lambda: family_rules.load(g.ledger), tz=TZ)
    g.c.family_gmail = g.gm
    return g


def test_a_kids_rule_gets_a_watching_kids_block(g):
    rules_rig(g)
    said(g, ("Pat dentist", "kids"))
    seed(g, "Pat dentist \U0001f9b7", when(g))
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"]


def test_a_rule_he_said_beats_the_setting(g):
    rules_rig(g)
    said(g, ("Kid sitting", "none"))
    seed(g, "Kid sitting", when(g))
    go(g)
    assert g.google.titles() == []


def test_a_school_rule_gives_both_runs(g):
    rules_rig(g)
    said(g, ("School Day", "school"))
    seed(g, "Sam & Ivy School Day", when(g, hour=8, minute=30), hours=6)
    g.feeds.window.occurrences.append(occ("Far away", start=when(g, days=20)))   # Gmail was read
    go(g)
    assert g.google.titles() == sorted([DROP_TITLE, PICK_TITLE])


def test_his_own_event_gets_a_block_unless_gmail_has_him_busy(g):
    rules_rig(g)
    said(g, ("Lee - Doctor", "me"))
    start = when(g)
    seed(g, "Lee - Doctor", start)
    later = when(g, days=5)
    seed(g, "Lee - Doctor", later)
    g.feeds.window.occurrences.append(occ("Doctor", start=start - timedelta(minutes=15), hours=2))
    go(g)
    blocks = list(g.google.live().values())
    assert [b["summary"] for b in blocks] == ["Busy (family)"]
    assert datetime.fromisoformat(blocks[0]["start"]["dateTime"]) == later


def test_events_with_no_rule_are_asked_about_once_each_soonest_first(g):
    rules_rig(g)
    seed(g, "Book club", when(g, days=4))
    seed(g, "Book club", when(g, days=2))
    seed(g, "Piano recital", when(g, days=3))
    seed(g, "Far off", when(g, days=30))
    seed(g, "Kid sitting", when(g))                 # the setting covers it
    go(g)
    line = g.gm.digest_line()
    assert "no rule yet: Book club" in line and "Piano recital" in line
    assert line.index("Book club") < line.index("Piano recital")
    assert "Far off" not in line and "Kid sitting" not in line and line.count("Book club") == 1
    go(g)
    assert "no rule yet" not in g.gm.digest_line()        # each one is asked about once


def test_a_long_title_is_cut_short(g):
    rules_rig(g)
    seed(g, "Bake sale " + "x" * 300, when(g))
    go(g)
    assert len(g.gm.digest_line()) < 400


def test_with_part_of_gmail_unreadable_his_own_events_dont_change(g):
    rules_rig(g)
    said(g, ("Lee - Doctor", "me"))
    seed(g, "Lee - Doctor", when(g))
    g.feeds.window.occurrences.append(occ("Far away", start=when(g, days=20)))
    g.feeds.window.unreadable = 1
    go(g)
    assert g.google.titles() == [] and "your own Family events" in g.gm.digest_line()


def test_a_title_asked_about_cant_be_a_link(g):
    rules_rig(g)
    seed(g, "Claim at evil.example/x", when(g))
    go(g)
    assert "evil.example" not in g.gm.digest_line()


# -- saying it -------------------------------------------------------------------------------------

def rule(title="Pat dentist", kind="kids"):
    return {**change(op="rule", title=title), "kind": kind}


def test_he_says_what_it_means_and_its_kept_with_undo(r):
    r.tell(rule(), words="Pat dentist means I have the kids")
    assert family_rules.load(r.ledger) == (Rule("Pat dentist", "kids"),)
    assert "have the kids" in r.texts()[-1] and r.with_button("Undo")
    r.press(r.with_button("Undo"), "Undo")
    assert family_rules.load(r.ledger) == () and "Undone" in r.texts()[-1]


def test_undo_puts_back_what_it_said_before(r):
    r.tell(rule(kind="none"))
    r.tell(rule(title="pat dentist"))
    r.press(r.with_button("Undo"), "Undo")
    assert family_rules.load(r.ledger) == (Rule("Pat dentist", "none"),)


def test_a_rule_with_dates_or_on_gmail_is_refused():
    from harness import effects, schema
    from test_family_add import at_least
    import pytest
    for bad in ({**rule(), "calendar": "gmail"}, {**rule(), "dates": "2026-12-01"}, {**rule(), "kind": "boss"}):
        with pytest.raises(schema.OutputError):
            schema.parse_output({"type": "proposal", "effect_type": "calendar_change",
                                 "params": {"changes": [bad]}, "summary": "x"}, stage_at_least=at_least("S1"))
    assert effects  # imported for the registry


class Soon:
    """A calendar reader that only notes when it's asked to read early."""
    pending = False
    configured = False
    generation = 0

    def __init__(self):
        self.asked = 0

    def read_soon(self, after=timedelta(0)):
        self.asked += 1

    def maybe_start(self, **kw):
        pass

    def collect(self):
        pass


def test_a_rule_and_its_undo_each_get_a_read_at_once(r):
    r.tell(rule(), words="Pat dentist means I have the kids")
    r.c.calendar = Soon()
    r.tell(rule(kind="none"), words="Pat dentist means nothing")
    assert r.c.calendar.asked == 1
    r.press(r.with_button("Undo"), "Undo")
    assert r.c.calendar.asked == 2
    r.tick()
    assert r.c.calendar.asked == 2             # once per change, not every tick


def test_one_rule_can_cover_a_person():
    rules = (Rule("Pat", "kids"), Rule("Pat + kids", "none"))
    assert pick("Pat dentist", rules).kind == "kids" and pick("Pat doctor", rules).kind == "kids"
    assert pick("Pat + kids at the zoo", rules).kind == "none"       # more words win
    assert pick("Patio day", rules) is None


def test_the_receipt_says_how_many_events_it_covers(r):
    r.tell(rule(title="School", kind="school"), words="School is a school day")
    said = r.texts()[-1]
    assert "with School in the name" in said and "events on Family in the next two months" in said
    r.tell(rule(title="Book club", kind="none"), words="Book club means nothing")
    assert "Nothing on Family has those words" in r.texts()[-1]
