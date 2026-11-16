"""0.24.0, second round: what the outside review of the handover fixes found (Nov 15).

That night the specialist said "Done. Took off Wednesday's 8:00 School drop-off" while the block
stayed on his Gmail calendar: an earlier add into the slot that already held it had been recorded
as done, and the removal then rested on that record, not on the calendar. These replay it against
the fake calendars and check each must-fix on its own: a removal bound to the event the card names
and read back before Done; an add into a filled slot that adds nothing; no apply without a card for
anything but his own newest message, fresh and alone; a question for Cain that can't stall; reruns
that never do a thing twice; a shape repair that never touches what a change does; and dates from
mail that stay off his Gmail and never change a calendar on their own. All names and ids invented.
"""
from datetime import timedelta

import pytest

from harness import effects
from harness.calendar_change import CalendarChange
from harness.handover import Handover
from harness.provenance import date_in, detail_line, time_in
from fakes import result
from test_discord_keeper import OWNER
from test_plain_commands import (DROP_OFF, MOVE_PT, NY, PT_ID, Morning, at, ask, change,
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


ADD_DROP = change("gmail", "add", "School drop-off", dates="", start=at(8).isoformat(), end=at(8, 45).isoformat())
TAKE_OFF = change("gmail", "remove", "the 8:00 drop-off")


def press(m, card, label):
    """His tap on one card, the stale one included: m.tap takes the newest with that label."""
    custom = next(c["custom_id"] for r in m.link.cards[card]["rows"] for c in r["components"]
                  if c["label"] == label)
    return m.send(Handover(kind="press", press={"id": str(90000 + len(m.link.answers)), "token": "t",
                                                "app": "999", "custom_id": custom, "message_id": str(card)}))


def card_with(m, label):
    return max(cid for cid in m.link.cards
               if any(c["label"] == label for r in m.link.cards[cid]["rows"] for c in r["components"]))


def drops_on_gmail(m):
    return sorted(uid for uid, e in m.gmail.events.items()
                  if "drop" in (e.get("summary") or "").casefold() and e.get("status") != "cancelled")


# -- 1. read back before Done ----------------------------------------------------------------

def test_tonights_add_then_removal_replayed_ends_with_the_block_gone_and_true_receipts(m):
    before = set(m.gmail.events)
    # The add into the slot that already holds the drop-off block: only like it (third round), so
    # his decision, on a card naming the block, and nothing written until he taps.
    out = m.tells("add the school drop-off at 8 today", ask(ADD_DROP))
    assert out["status"] == "waiting for his tap" and set(m.gmail.events) == before
    card = m.seen()[-1]
    assert "Already on your Gmail calendar at that time: “Busy (school drop-off)”, today, 8:00 to 8:45" in card
    assert "Add anyway" in m.labels() and "Leave it" in m.labels() and "Approve" not in m.labels()
    m.tap("Leave it")
    assert "Left as it is. Nothing was added." in m.seen()[-1] or any(
        "Left as it is" in (a[1] or "") for a in m.link.answers)
    assert set(m.gmail.events) == before                     # no new event, nothing recorded as made
    assert m.ledger.db.execute("SELECT COUNT(*) FROM calendar_changes").fetchone()[0] == 0
    # Then the removal: it takes off the real block, and the receipt says so only once it's gone.
    out = m.tells("not doing the 8:00 drop-off today", ask(TAKE_OFF))
    assert out["status"] == "executed" and m.block_state("drop") == "cancelled"
    assert drops_on_gmail(m) == [] and "Took off today's 8:00 drop-off" in m.seen()[-1]
    assert "still" not in m.seen()[-1]
    nothing_he_shouldnt_see(m, out)


def test_a_removal_card_names_the_event_it_binds_to(m):
    m.he_says("not doing the 8:00 drop-off", ago=10 * 60)
    m.claude.script = [ask(TAKE_OFF)]
    out = m.handover(paired=OWNER, message=m.d.hist[0]["id"])
    assert out["status"] == "waiting for his tap"
    uid = m.blocks["drop"][1]
    line = m.seen()[-1]
    assert "the Gmail event “Busy (school drop-off)”, 8:00 AM Wed Nov 11" in line
    assert f"id ending {uid[-6:]}" in line


def test_a_removal_never_takes_off_another_event_than_the_card_named(m):
    m.he_says("not doing the 8:00 drop-off", ago=10 * 60)
    m.claude.script = [ask(TAKE_OFF)]
    m.handover(paired=OWNER, message=m.d.hist[0]["id"])
    # Before his tap, the block is replaced by another event with the same name and time.
    key, uid = m.blocks["drop"]
    other = dict(m.gmail.events.pop(uid), id="other0drop", etag='"9"')
    m.gmail.events["other0drop"] = other
    m.tap("Approve")
    assert m.seen()[-1].startswith("Nothing changed: the event to take off isn't the one that card named")
    assert m.gmail.events["other0drop"].get("status", "confirmed") == "confirmed"


def test_a_read_back_that_still_shows_the_event_is_said_and_not_done(m, monkeypatch):
    m.gmail.really_gone = lambda address, uid: True          # the delete's own check says gone
    real = m.gmail.drop

    def drops_nothing(address, uid, etag):
        out = real(address, uid, etag)
        m.gmail.events[uid]["status"] = "confirmed"           # ... but the calendar still lists it
        return out
    monkeypatch.setattr(m.gmail, "drop", drops_nothing)
    out = m.tells("not doing the 8:00 drop-off today", ask(TAKE_OFF))
    said = m.seen()[-1]
    assert out["status"] != "executed" and not said.startswith("Done.")
    assert "Not confirmed: Take off today's 8:00 drop-off" in said and "still shows it there" in said


def test_another_like_it_still_in_the_slot_is_named_on_the_receipt(m):
    m.gmail.events["dup0drop"] = {**m.gmail.events[m.blocks["drop"][1]], "id": "dup0drop", "etag": '"d"',
                                  "summary": "School drop-off run", "extendedProperties": {}}
    out = m.tells("not doing the 8:00 drop-off today", ask(change("gmail", "remove", "Busy (school drop-off)")))
    assert out["status"] == "executed" and m.block_state("drop") == "cancelled"
    assert "Took off today's 8:00 drop-off" in m.seen()[-1]
    assert "Another School drop-off run at that time is still on your Gmail calendar" in m.seen()[-1]
    assert m.gmail.events["dup0drop"].get("status", "confirmed") == "confirmed"


def test_undo_of_an_add_never_deletes_an_event_that_was_there_before(m):
    uid = m.blocks["drop"][1]
    assert m.cc._undo_step({"cal": "gmail", "how": "drop", "id": uid}, {}) == "not_made"
    assert m.cc._undo_step({"cal": "family", "how": "delete", "href": "/cal/school-1111.ics"}, {}) == "not_made"
    assert m.block_state("drop") == "confirmed"
    # An add's own Undo takes off only the event that add made, and reads the calendar back.
    out = m.tells("add the dentist at 3 today", ask(change("gmail", "add", "Dentist", dates="",
                                                            start=at(15).isoformat(), end=at(16).isoformat())))
    assert out["status"] == "executed"
    made = [u for u, e in m.gmail.events.items() if e.get("summary") == "Dentist"]
    assert len(made) == 1 and made[0].startswith("cm")
    m.tap("Undo")
    assert m.seen()[-1].startswith("Undone.") and m.gmail.events[made[0]]["status"] == "cancelled"
    assert m.block_state("drop") == "confirmed" and m.gmail.events[PT_ID].get("status", "confirmed") == "confirmed"


def test_an_undo_whose_read_back_disagrees_says_so(m, monkeypatch):
    m.tells("add the dentist at 3 today", ask(change("gmail", "add", "Dentist", dates="",
                                                      start=at(15).isoformat(), end=at(16).isoformat())))
    monkeypatch.setattr(CalendarChange, "_undone_reads", lambda self, step: "differs")
    m.tap("Undo")
    assert m.seen()[-1].startswith("Not confirmed: I put Dentist back, but a read of the calendar doesn't show it")


# -- 2. no apply without a card, but for his fresh clear words ----------------------------------

def test_an_old_named_message_followed_by_a_correction_gets_a_card_never_an_apply(m):
    first = m.he_says("not doing the 8:00 drop-off today", ago=40)
    m.he_says("actually never mind, I'll do it", ago=10)
    m.claude.script = [ask(TAKE_OFF)]
    out = m.handover(paired=OWNER, message=first)
    assert out["status"] == "waiting for his tap" and m.block_state("drop") == "confirmed"
    card = m.seen()[-1]
    assert "Your message: “not doing the 8:00 drop-off today” (sent just now)" in card
    assert "You sent 1 message after this." in card and "an earlier message of yours" in card
    nothing_he_shouldnt_see(m, out)


def test_his_own_newest_fresh_words_alone_still_go_through(m):
    out = m.tells("not doing the 8:00 drop-off today", ask(TAKE_OFF))
    assert out["status"] == "executed" and m.block_state("drop") == "cancelled"


def test_a_stale_button_after_a_rerun_is_refused(m):
    mid = m.he_says("not doing the drop-off", ago=10 * 60)
    m.claude.script = [ask(TAKE_OFF)]
    m.handover(paired=OWNER, message=mid, suggestion="He means today's drop-off.")
    old = card_with(m, "Approve")
    # Third round: a rerun replaces the card whose change it addresses (the same event, asked
    # differently); one repeating the very same change would leave that card standing.
    m.claude.script = [ask(change("gmail", "remove", "Busy (school drop-off)"))]
    again = m.handover(paired=OWNER, message=mid, suggestion="It's the 8:00 drop-off on his Gmail, today.")
    assert len(m.claude.calls) == 2 and again["status"] == "waiting for his tap"
    new = card_with(m, "Approve")
    assert new != old and m.link.cards[old]["rows"] == []        # the old card's buttons came off
    assert "Replaces the earlier card." in m.seen()[-1]
    # Its stale tap, as Discord would still deliver it from a client that hadn't redrawn.
    nonce = m.ledger.db.execute("SELECT nonce FROM approvals a JOIN proposals p ON p.id=a.proposal_id"
                                " WHERE p.state='superseded'").fetchone()[0]
    from harness import approvals
    custom = "k:" + approvals.callback_data("approve", nonce)
    m.send(Handover(kind="press", press={"id": "95001", "token": "t", "app": "999", "custom_id": custom,
                                         "message_id": str(old)}))
    assert m.block_state("drop") == "confirmed"
    assert any("Replaced by a newer card." in (a[1] or "") for a in m.link.answers)
    m.tap("Approve")
    assert m.block_state("drop") == "cancelled"


def test_a_date_from_cains_suggestion_is_marked_from_cain_and_forces_a_tap(m):
    m.he_says("add the field trip")
    m.claude.script = [ask(change("family", "add", "Field trip", dates="", start="2026-11-13T09:00:00-05:00",
                                  end="2026-11-13T14:00:00-05:00"))]
    out = m.handover(paired=OWNER, suggestion="Field trip Fri Nov 13, 9 AM to 2 PM, from the school's email.")
    assert out["status"] == "waiting for his tap"
    card = m.seen()[-1]
    assert "date Fri Nov 13 (from Cain)" in card and "time 9:00 AM (from Cain)" in card
    assert "event Field trip;" in card and "event Field trip (from Cain)" not in card


def test_which_fields_are_his_own():
    from datetime import date, datetime
    today = date(2026, 11, 11)
    assert date_in("not doing the drop-off today", today, today)
    # Sent on a Wednesday, "Wednesday" could be today or a week on: left open (0.24.0, fourth round).
    assert not date_in("not doing the Wednesday drop-off", today, today)
    assert date_in("dentist on Nov 13", date(2026, 11, 13), today) and date_in("the 13th", date(2026, 11, 13), today)
    assert not date_in("add the field trip", date(2026, 11, 13), today)
    assert time_in("at 9am", datetime(2026, 11, 13, 9, 0, tzinfo=NY)) and not time_in("at 10", datetime(2026, 11, 13, 9, 0, tzinfo=NY))
    line, cains = detail_line(change("family", "add", "Field trip", dates="", start="2026-11-13T09:00:00-05:00",
                                     end="2026-11-13T14:00:00-05:00"),
                              "add the field trip on the 13th at 9am", "Field trip Fri Nov 13, 9 AM", "America/New_York",
                              datetime(2026, 11, 11, 12, tzinfo=NY))
    assert not cains and "(from Cain)" not in line


# -- 3. the clarify path can't stall ----------------------------------------------------------

def test_a_question_cain_leaves_for_ten_minutes_goes_to_him_on_a_card(m):
    m.claude.script = [result({"type": "clarify", "question": "Which field trip do you mean?"})]
    mid = m.he_says("add the field trip")
    out = m.handover(paired=OWNER, suggestion="A field trip, from the school's email.")
    assert out["status"] == "needs_clarification" and out["said"].startswith("No card went to him.")
    assert f'keeper.sh handover --message {mid} "<the answer>"' in out["said"]
    assert "never ask him to repeat a change he already made in words" in out["said"]
    cards = len(m.link.cards)
    m.clock.t += timedelta(minutes=9)
    m.c.tick()
    assert len(m.link.cards) == cards                      # not yet
    m.clock.t += timedelta(minutes=2)
    m.c.tick()
    m.c.tick()
    assert len(m.link.cards) == cards + 1
    card = m.seen()[-1]
    assert "Which field trip do you mean?" in card and "Your message: “add the field trip”" in card
    assert "Cain passed on: “A field trip, from the school's email.”" in card
    assert "Cain didn't answer this within 10 minutes" in card
    m.clock.t += timedelta(minutes=30)
    m.c.tick()
    assert len(m.link.cards) == cards + 1                  # once
    nothing_he_shouldnt_see(m, out)


def test_a_note_from_cain_in_time_means_no_card(m):
    m.claude.script = [result({"type": "clarify", "question": "Which field trip do you mean?"})]
    mid = m.he_says("add the field trip")
    m.handover(paired=OWNER, message=mid, suggestion="A field trip, from the school's email.")
    m.clock.t += timedelta(minutes=5)
    m.claude.script = [result({"type": "no_action", "reason": "Nothing to add yet."})]
    m.handover(paired=OWNER, message=mid, suggestion="The Fri Nov 13 trip.")
    cards = len(m.link.cards)
    m.clock.t += timedelta(minutes=20)
    m.c.tick()
    assert len(m.link.cards) == cards


# -- 4. reruns never do a thing twice -------------------------------------------------------

def test_a_split_message_one_card_approved_then_a_note_reruns_with_no_duplicate(m):
    mid = m.he_says("PT is at 11:30 and I'm not doing the drop-off", ago=10 * 60)
    m.claude.script = [ask(MOVE_PT, DROP_OFF)]
    m.handover(paired=OWNER, message=mid)
    m.tap("Approve")                                    # the newest card: the drop-off
    assert m.block_state("drop") == "cancelled"
    pt_card = card_with(m, "Approve")
    m.claude.script = [ask(MOVE_PT, DROP_OFF)]
    out = m.handover(paired=OWNER, message=mid, suggestion="PT moved to 11:30 today, from the clinic.")
    # Third round: the drop-off is done (read back), and the PT card he hasn't tapped stands, still
    # offered: the rerun repeats its change, so nothing is replaced and nothing offered twice.
    assert len(m.claude.calls) == 2 and out["status"] == "waiting for his tap"
    assert "Already done, nothing new to change: Take off today's 8:00 drop-off" in out["said"]
    assert "Still waiting for your tap on its own card: Move PT to 11:30" in out["said"]
    assert m.link.cards[pt_card]["rows"] != [] and m.labels().count("Approve") == 1
    drops = m.ledger.db.execute("SELECT COUNT(*) FROM proposals WHERE params_json LIKE '%drop-off%'"
                                " AND state NOT IN ('superseded')").fetchone()[0]
    assert drops == 1                                   # the drop-off was never offered again
    m.tap("Approve")
    assert m.gmail_times(PT_ID) == ("11:30", "12:30") and m.block_state("drop") == "cancelled"


def test_a_note_after_every_part_is_done_offers_nothing_again(m):
    mid = m.he_says("PT is at 11:30 and I'm not doing the drop-off", ago=10 * 60)
    m.claude.script = [ask(MOVE_PT, DROP_OFF)]
    m.handover(paired=OWNER, message=mid)
    m.tap("Approve")
    m.tap("Approve")
    assert m.block_state("drop") == "cancelled" and m.gmail_times(PT_ID) == ("11:30", "12:30")
    m.claude.script = [ask(MOVE_PT, DROP_OFF)]
    out = m.handover(paired=OWNER, message=mid, suggestion="PT moved to 11:30 today, from the clinic.")
    assert len(m.claude.calls) == 1 and "Approve" not in m.labels() and out["status"] in ("executed", "card")


# -- 5. a shape repair never fills a load-bearing field ----------------------------------------

def _out(**c):
    return {"type": "proposal", "effect_type": "calendar_change", "summary": "s",
            "params": {"changes": [c]}}


MOVE = dict(MOVE_PT, kind="", every="")
REMOVE = dict(DROP_OFF, kind="", every="")


@pytest.mark.parametrize("base, key, value", [
    (REMOVE, "calendar", None), (REMOVE, "calendar", "work"), (REMOVE, "op", None),
    (REMOVE, "title", None), (REMOVE, "dates", None), (REMOVE, "dates", "Wednesday"),
    (REMOVE, "dates", " 2026-11-11"), (MOVE, "start", None), (MOVE, "start", "11:30"),
    (MOVE, "end", None), (MOVE, "end", "noon"), (MOVE, "dates", ""),
])
def test_a_missing_or_malformed_load_bearing_field_is_never_repaired(base, key, value):
    c = dict(base, location=None)              # something it could tidy, so only the field decides
    if value is None:
        c.pop(key)
    else:
        c[key] = value
    assert effects.repair_fields(_out(**c)) == (None, [])


def test_a_cosmetic_field_is_repaired_and_named():
    fixed, touched = effects.repair_fields(_out(**dict(REMOVE, location=None, start="2026-11-11T08:00:00-05:00")))
    assert touched == ["location", "start"] and fixed["params"]["changes"][0]["dates"] == REMOVE["dates"]


def test_a_repaired_reply_lists_the_tidied_fields_on_its_card(m):
    off = dict(DROP_OFF, start="2026-11-11T08:00:00-05:00", kind="me")
    out = m.tells("I'm not doing the drop-off", result({"type": "proposal", "effect_type": "calendar_change",
                                                        "params": {"changes": [off]}, "summary": "x"}))
    assert out["status"] == "waiting for his tap" and "fields tidied: kind, start" in m.seen()[-1]


def test_a_move_with_no_start_is_retried_not_repaired(m):
    bad = {k: v for k, v in MOVE_PT.items() if k != "start"}
    out = m.tells("PT moved to 11:30", result({"type": "proposal", "effect_type": "calendar_change",
                                               "params": {"changes": [bad]}, "summary": "x"}), ask(MOVE_PT))
    assert len(m.claude.calls) == 2 and out["status"] == "executed" and "tidied" not in " ".join(m.seen())


# -- 6. mail never changes a calendar on its own ------------------------------------------------

def test_mail_never_reaches_a_calendar_without_his_tap(m):
    """A proposal from mail that no tap of his is behind comes on a card; his tap on the mail card
    is the only way it runs (controller._mail_to_family)."""
    from datetime import date
    from harness import effects as fx
    d = fx.REGISTRY[fx.CALENDAR_CHANGE]
    c = {"calendar": "family", "op": "add", "title": "Due: Form", "dates": "", "start": "2026-11-13",
         "end": "2026-11-13", "days": "", "until": "", "location": "", "kind": "", "every": ""}
    with m.ledger.tx() as db:
        job = m.ledger.made_job(m.c.config.owner_user_id, "From his mail", kind="mail_family", db=db)
    m.c.runner._offer(m.ledger.job(job), d, d.validate({"changes": [c]}), {"source": "mail"}, [], None)
    m.c.tick()
    assert "it comes from your mail" in m.seen()[-1] and "Approve" in m.labels()
    assert not any("Due: Form" in ics for _, ics in m.icloud.events.values())
    # His tap on the mail card: that runs, with its receipt.
    assert m.c._mail_to_family("Due: Field trip form", date(2026, 11, 13), None)
    m.c.tick()
    assert m.seen()[-1].startswith("Done.")
