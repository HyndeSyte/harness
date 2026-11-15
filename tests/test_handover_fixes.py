"""0.24.0: handovers from Cain act on what he asked (Nov 15).

That evening he sent Cain three messages within a minute: a therapy cancellation, a Wednesday
drop-off change, then a question about the Family calendar. Cain's handover for the drop-off ran
after the third, so the specialist read the question as his newest message, took Cain's spelled-out
suggestion for Cain's own idea, said "not a change", and gave the same cached answer to the next
handover. These replay it through Cain's handover, with the message Cain names, and check each fix
on its own: the freshness window, no clarification card when Cain's words answer it, one card per
change, a reply-shape failure repaired or retried with what went wrong, a meaning question answered
from the specialist's own cards, and dates from the kids' mail on Family, never his Gmail. All
names, places and ids are invented.
"""
from datetime import date

import pytest

from harness import effects
from harness.controller import echoes_message
from harness.handover import Handover
from harness.mail_dates import FAMILY_CAL, UNCLEAR, whose
from fakes import result
from test_discord_keeper import OWNER
from test_plain_commands import (DROP_OFF, MOVE_PT, PT_ID, Morning, ask, change, nothing_he_shouldnt_see,
                                 plain_prompt)  # noqa: F401  (autouse)
from fake_caldav import FAMILY_PATH, no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


THERAPY = "Therapy is cancelled today"
WEDNESDAY = "I'm not doing the Wednesday drop-off today"
QUESTION = "What's on the Family calendar this week?"
NO_DROP = change("gmail", "remove", "drop-off")


def three_messages(m):
    """The three, within a minute, oldest first: Discord lists the newest first."""
    return m.he_says(THERAPY, ago=50), m.he_says(WEDNESDAY, ago=35), m.he_says(QUESTION, ago=20)


def job_for(m, message_id):
    return m.ledger.db.execute("SELECT * FROM jobs WHERE message_id=?", (int(message_id),)).fetchone()


# -- e. the three crossed messages, replayed --------------------------------------------------------

def test_the_three_crossed_messages_of_nov_15_replayed(m):
    _, wednesday, question = three_messages(m)
    # Cain's handover for the drop-off names that message, and spells it out.
    m.claude.script = [ask(NO_DROP)]
    out = m.handover(paired=OWNER, message=wednesday,
                     suggestion="He's not doing the Wednesday drop-off today.")
    user = m.claude.calls[0]["user"]
    assert WEDNESDAY in user and QUESTION not in user and THERAPY not in user
    # Cain's words pass on his: they're fenced as Cain's reading, not as Cain's own idea.
    assert "passing on what he asks in this message" in user and "These are not his words" not in user
    assert job_for(m, wednesday) is not None and job_for(m, question) is None
    assert out["status"] == "waiting for his tap" and "Cain spelled out the details" in out["said"]
    assert "rests on something Cain suggested" not in out["said"]
    nothing_he_shouldnt_see(m, out)
    m.tap("Approve")
    assert m.block_state("drop") == "cancelled" and m.seen()[-1].startswith("Done.")
    # The same handover again finds that message's request: no second model call, no new answer.
    again = m.handover(paired=OWNER, message=wednesday,
                       suggestion="He's not doing the Wednesday drop-off today.")
    assert len(m.claude.calls) == 1 and job_for(m, question) is None and again["status"] == "executed"
    # His question, handed over on its own, is its own request, answered to Cain.
    m.claude.script = [result({"type": "answer", "text": "Swim on Thursday and the school days."})]
    q = m.handover(paired=OWNER, message=question)
    assert q["status"] == "not a change" and "Swim on Thursday" in q["said"]
    assert QUESTION in m.claude.calls[1]["user"] and WEDNESDAY not in m.claude.calls[1]["user"]


def test_without_the_flag_it_keeps_his_newest_message(m):
    three_messages(m)
    m.claude.script = [result({"type": "answer", "text": "Swim on Thursday."})]
    out = m.handover(paired=OWNER)
    assert QUESTION in m.claude.calls[0]["user"] and out["status"] == "not a change"


def test_a_later_handover_with_a_new_note_runs_a_not_a_change_answer_again(m):
    """The cached answer is keyed on the message acted on, and a note it hasn't seen reaches it."""
    _, wednesday, _ = three_messages(m)
    m.claude.script = [result({"type": "no_action", "reason": "He's only telling you."})]
    first = m.handover(paired=OWNER, message=wednesday)
    assert first["status"] == "not a change"
    m.claude.script = [ask(NO_DROP)]
    again = m.handover(paired=OWNER, message=wednesday,
                       suggestion="Take the Wednesday drop-off off his calendar today.")
    assert len(m.claude.calls) == 2 and again["status"] == "waiting for his tap"


def test_a_named_message_that_isnt_his_or_is_old_is_never_acted_on(m):
    m.d.hist.insert(0, {"id": "70001", "content": "move PT", "timestamp": m.clock().isoformat(),
                        "author": {"id": "5555"}})
    out = m.handover(paired=OWNER, message="70001")
    assert out["status"] == "nothing" and not m.claude.calls
    old = m.he_says("take off the drop-off", ago=31 * 60)
    out = m.handover(paired=OWNER, message=old)
    assert out["status"] == "stale" and "30 minutes" in out["said"] and not m.claude.calls


def test_a_named_message_from_ten_minutes_ago_is_acted_on_with_his_tap(m):
    mid = m.he_says("not doing the drop-off today", ago=10 * 60)
    m.claude.script = [ask(NO_DROP)]
    out = m.handover(paired=OWNER, message=mid)
    assert out["status"] == "waiting for his tap" and "handed over a while after you sent it" in out["said"]
    assert m.block_state("drop") == "confirmed"
    m.tap("Approve")
    assert m.block_state("drop") == "cancelled"


def test_cains_suggestion_that_only_adds_facts_is_still_cains():
    assert echoes_message("He's not doing the Wednesday drop-off today.", WEDNESDAY)
    assert not echoes_message("Dentist Thu Nov 12 2 PM, from the office's email", "Add the dentist")
    assert not echoes_message("Dentist Thu Nov 12 2 PM", "yes")


# -- b. the 2-minute window runs from the handover ----------------------------------------------

def test_a_suggestion_that_spells_it_out_is_acted_on_after_two_minutes(m):
    m.claude.script = [ask(MOVE_PT)]
    m.he_says("my appointment moved", ago=8 * 60)
    out = m.handover(paired=OWNER, suggestion="PT moved to 11:30 today, from the clinic's email.")
    assert out["status"] == "waiting for his tap" and m.gmail_times(PT_ID) == ("12:00", "13:00")
    m.tap("Approve")
    assert m.gmail_times(PT_ID) == ("11:30", "12:30")


def test_his_newest_message_alone_still_has_two_minutes(m):
    m.he_says("not doing the drop-off today", ago=3 * 60)
    out = m.handover(paired=OWNER)
    assert out["status"] == "stale" and "2 minutes" in out["said"] and "--message" in out["said"]
    assert not m.claude.calls


def test_a_handover_that_waited_here_too_long_is_stale(m):
    m.he_says("not doing the drop-off today")
    h = Handover(paired=OWNER)
    h.arrived -= 200
    out = m.send(h)
    assert out["status"] == "stale" and not m.claude.calls


# -- c. no card asking him for what Cain already passed on -------------------------------------

def test_a_question_on_a_request_with_cains_words_goes_to_cain_not_to_a_card(m):
    m.claude.script = [result({"type": "clarify", "question": "Can you paste the email?"})]
    m.he_says("add the field trip")
    cards = len(m.link.cards)
    out = m.handover(paired=OWNER, suggestion="Field trip Fri Nov 13, 9 AM to 2 PM, from the school's email.")
    assert out["status"] == "needs_clarification" and out["said"].startswith("No card went to him.")
    assert "Can you paste the email?" in out["said"] and len(m.link.cards) == cards
    # Cain answers with a note: it runs again and the card comes then.
    m.claude.script = [ask(change("family", "add", "Field trip", dates="", start="2026-11-13T09:00:00-05:00",
                                  end="2026-11-13T14:00:00-05:00"))]
    again = m.handover(paired=OWNER, suggestion="It's on the Family calendar, Fri Nov 13, 9 AM to 2 PM.")
    assert again["status"] == "waiting for his tap" and len(m.claude.calls) == 2


def test_his_own_words_alone_still_get_their_question(m):
    out = m.tells("move my appointment", result({"type": "clarify", "question": "Which appointment?"}))
    assert out["status"] == "needs_clarification" and "Which appointment?" in m.seen()[-1]


def test_the_model_is_told_to_work_from_cains_words():
    from harness import prompts
    assert "never ask him for what it already says" in prompts.SYSTEM
    assert "the kids' school, a teacher, a coach or the kids' doctor is always family" in prompts.PROPOSAL_CHANGE


# -- d. two changes, two cards; a reply that didn't fit ------------------------------------------

def test_two_changes_that_need_his_tap_come_on_a_card_each(m):
    m.he_says("PT is at 11:30 and I'm not doing the drop-off", ago=10 * 60)
    m.claude.script = [ask(MOVE_PT, DROP_OFF)]
    out = m.handover(paired=OWNER, message=m.d.hist[0]["id"])
    approvals = [t for t in m.seen() if "Approve" in t or "Move PT" in t or "drop-off" in t]
    assert out["status"] == "waiting for his tap" and m.labels().count("Approve") == 2
    assert sum("Move PT" in t for t in approvals) == 1 and sum("drop-off" in t for t in approvals) == 1
    assert len(out["cards"]) == 2
    m.tap("Approve")                                    # the newest card: the drop-off
    assert m.block_state("drop") == "cancelled" and m.gmail_times(PT_ID) == ("12:00", "13:00")
    m.tap("Approve")
    assert m.gmail_times(PT_ID) == ("11:30", "12:30")
    nothing_he_shouldnt_see(m, out)


def test_two_clear_changes_still_land_in_one_receipt(m):
    out = m.tells("PT moved to 11:30 and no drop-off today", ask(MOVE_PT, DROP_OFF))
    assert out["status"] == "executed" and m.labels().count("Undo") == 1


def _bad(*changes):
    return result({"type": "proposal", "effect_type": "calendar_change", "params": {"changes": list(changes)},
                   "summary": "ignored"})


def test_a_field_its_op_doesnt_use_is_repaired_and_the_change_waits_for_his_tap(m):
    off = dict(DROP_OFF, start="2026-11-11T08:00:00-05:00", kind="me")    # what remove doesn't use
    out = m.tells("I'm not doing the drop-off today", _bad(off))
    assert out["status"] == "waiting for his tap" and "needed tidying" in out["said"]
    assert len(m.claude.calls) == 1
    m.tap("Approve")
    assert m.block_state("drop") == "cancelled"


def test_repair_never_touches_what_a_change_does():
    good = {"type": "proposal", "effect_type": "calendar_change", "summary": "s",
            "params": {"changes": [dict(DROP_OFF, kind="", every="")]}}
    assert effects.repair(good) is None                              # nothing to repair
    assert effects.repair(dict(good, params={"changes": [dict(DROP_OFF, op="teleport")]})) is None
    assert effects.repair({"type": "answer", "text": "x"}) is None
    fixed = effects.repair(dict(good, params={"changes": [{**DROP_OFF, "until": None, "extra": "x"}]}))
    one = fixed["params"]["changes"][0]
    assert "extra" not in one and one["until"] == "" and one["dates"] == DROP_OFF["dates"]
    assert one["title"] == DROP_OFF["title"] and one["op"] == "remove"


def test_a_reply_that_cant_be_repaired_is_retried_once_told_what_didnt_fit(m):
    wrong = dict(DROP_OFF, op="teleport")
    out = m.tells("not doing the drop-off today", _bad(wrong), ask(DROP_OFF))
    assert len(m.claude.calls) == 2
    assert "didn't fit the allowed shapes" in m.claude.calls[1]["system"]
    assert "didn't fit" not in m.claude.calls[0]["system"]
    assert any("running it once more by itself, from your message" in t for t in m.seen())
    assert out["status"] == "executed" and m.block_state("drop") == "cancelled"


def test_failing_twice_says_what_happens_next(m):
    wrong = dict(DROP_OFF, op="teleport")
    m.tells("not doing the drop-off today", _bad(wrong), _bad(wrong))
    last = m.seen()[-1]
    assert "It failed twice, so it's logged for a fix, and nothing more happens with it on its own." in last
    assert "Cain has been told." in last


# -- f. what one of its own cards meant ---------------------------------------------------------

def test_asked_what_a_card_meant_it_reads_its_own_cards_and_answers(m):
    m.tells("PT moved to 11:30", ask(MOVE_PT))                       # a receipt he then asks about
    m.claude.script = [result({"type": "answer", "text": "It moved your PT to 11:30, on Gmail and Family."})]
    m.he_says("what does that receipt mean?")
    out = m.handover(paired=OWNER)
    user = m.claude.calls[-1]["user"]
    assert "<your_cards>" in user and "Moved PT to 11:30 to 12:30 today" in user
    assert out["status"] == "not a change" and "It moved your PT" in out["said"]


def test_a_meaning_question_is_never_a_change(m):
    m.claude.script = [ask(DROP_OFF)]
    m.he_says("what does that due date mean?")
    out = m.handover(paired=OWNER)
    assert out["status"] == "not a change" and "what something means" in out["said"]
    assert m.block_state("drop") == "confirmed" and "Approve" not in m.labels()


def test_a_meaning_question_never_gets_a_card_asking_him_to_restate(m):
    cards = len(m.link.cards)
    m.claude.script = [result({"type": "clarify", "question": "Which card do you mean?"})]
    m.he_says("what does the skating card mean?")
    out = m.handover(paired=OWNER)
    assert out["status"] == "needs_clarification" and len(m.link.cards) == cards


def test_plain_requests_carry_no_cards():
    from harness.runner import CARD_WORDS, MEANING
    assert not MEANING.search("move PT to 11:30") and not CARD_WORDS.search("move PT to 11:30")
    assert MEANING.search("What does that receipt mean?") and MEANING.search("what does it mean")


# -- a. the kids' mail goes on Family ------------------------------------------------------------

@pytest.mark.parametrize("sender, subject, what, expected", [
    ("Oak Elementary <office@oakelementary.example>", "Field trip permission slip", "Field trip form", FAMILY_CAL),
    ("Ms. Rivera <teacher@school.example>", "Reminder", "Parent-teacher conference", FAMILY_CAL),
    ("Coach Sam <sam@club.example>", "Practice moved", "Soccer practice", FAMILY_CAL),
    ("Pediatric Associates <desk@peds.example>", "Your child's checkup", "Checkup", FAMILY_CAL),
    ("Riverside School <news@riverside-school.example>", "Bake sale", "Bake sale", UNCLEAR),
    ("Shop <orders@shop.example>", "Your order of PC parts", "Amazon return: PC parts", ""),
    ("Dental Care <desk@dental.example>", "Appointment reminder", "Cleaning", ""),
])
def test_whose_date_it_is(sender, subject, what, expected):
    assert whose(sender, subject, what) == expected


def test_a_date_from_mail_he_sends_to_family_lands_there_with_its_receipt(m):
    before = set(m.icloud.events)
    assert m.c.mail_dates is None                       # this rig wires only the hand-off itself
    assert m.c._mail_to_family("Due: Field trip form", date(2026, 11, 13), None)
    m.c.tick()
    added = set(m.icloud.events) - before
    assert len(added) == 1 and all(p.startswith(FAMILY_PATH) for p in added)
    ics = m.icloud.events[added.pop()][1]
    assert "SUMMARY:Due: Field trip form" in ics and "20261113" in ics
    assert m.seen()[-1].startswith("Done.") and "Undo" in m.labels()
    assert not any("Field trip" in (e.get("summary") or "") for e in m.gmail.events.values())
