"""0.24.0, eighteenth round: the defects the seventeenth outside review found in the seventeenth round's additions.

1. "Records own" had no mechanism: an unknown tap is settled by what the records hold of its decision. One whose
   decision never reached the records (an error between the update row and the approval) gets Go ahead, through a
   real restart; one whose change the records are still carrying out stays unknown until that settles.
2. Undo's read-back compares each event's version with the one the change left: any other version is "changed
   since", no Go ahead; the undo writer sends If-Match on that journaled version.
3. The specialist's relist cards never name a button; a link refusal for naming one isn't terminal in the outbox.
4. Go ahead only for kinds on an allow list: an unregistered writer kind gets none.
5. A Family add read absent is "can't tell whether it was added and taken off": no Go ahead.
6. The parts a Go ahead leaves out are read fresh for one execution, then cleared.
7. Two Gmail removals in one change are each read by their own bound event.
8. The forced Add anyway writer refuses when its read fails, and a Google 409 is "already there".
9. Unknown taps are read again in the running loop, on a bounded backoff.
12. Google answering 404 at a journaled fixed id is "absent", never re-added.
All names and ids invented.
"""
import json
import queue
import sqlite3
from datetime import date, timedelta

import pytest

from harness import caldav, choices, commands
from harness.cain_relay import LinkError
from harness.calendar_change import Refuse
from harness.config import Config
from harness.controller import Controller
from harness.discord_chat import LinkChat
from harness.discord_keeper import DiscordKeeper, KeeperStore
from harness.handover import Handover, Inbox
from fakes import FakeBot, FakeEngine, SyncExecutor
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import (GMAIL, PT_ID, TZ, ask, at, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round16_taps import (DENTIST, dentist_card, dentists, lines, m,  # noqa: F401
                                        press_for, restart_after_restore, tap_journaled)
from test_handover_round17_taps import (FAMILY_DINNER, LUNCH, REMOVE_PT, add_anyway_receipt, card_labels,
                                        landed_then_crashed, named, new_cards, new_said)
from fake_caldav import no_network  # noqa: F401  (autouse)

REMOVE_GYM = change("gmail", "remove", "Gym")
BUTTON_LABELS = ("Go ahead", "Approve", "Undo", "Add anyway", "Leave it", "Decline")


def real_restart(m, tmp_path):
    """The App started again: a new controller on the same records, journal and calendars, nothing in memory."""
    journal, answer = m.c.handovers.journal, m.c.handovers.answer
    c = Controller(ledger=m.ledger, vault=m.vault, api=FakeBot(),
                   engines={"claude": m.claude, "gpt": FakeEngine("gpt")}, executor=SyncExecutor(),
                   base_config=Config(owner_user_id=1, stage="S1", proactive_from=date(2026, 10, 20)),
                   sleep=lambda s: None, monotonic=lambda: 0.0, status_box={}, requests=queue.Queue(),
                   poll_timeout=0, family_add=m.fa, calendar_change=m.cc)
    c.discord = DiscordKeeper(m.d, KeeperStore(str(tmp_path / "discord.json")).get,
                              KeeperStore(str(tmp_path / "discord.json")).set)
    c.discord_chat = LinkChat(m.link, paused=lambda: commands.is_paused(m.ledger))
    c.handovers = Inbox.for_tests(lambda: TOKEN)
    c.handovers.journal, c.handovers.answer = journal, answer
    m.c = c
    c.startup()
    c.tick()
    c.outbox.flush()


def later(m, clock, seconds):
    clock.t = clock.t + timedelta(seconds=seconds)
    m.c.tick()
    m.c.outbox.flush()


def gym(m):
    m.gmail.events["gym1"] = {"id": "gym1", "iCalUID": "gym1@google.com", "etag": '"g1"', "status": "confirmed",
                              "summary": "Gym", "organizer": {"email": GMAIL, "self": True},
                              "start": {"dateTime": at(9).isoformat(), "timeZone": TZ},
                              "end": {"dateTime": at(10).isoformat(), "timeZone": TZ}}


# -- 1. an unknown tap is settled by what the records hold of it -----------------------------------------------------

@pytest.mark.card_only
def test_an_error_between_the_update_row_and_the_approval_gets_go_ahead_through_a_real_restart(m, monkeypatch,
                                                                                                 tmp_path):
    dentist_card(m)

    def handle(inc):
        raise RuntimeError("cut off after the update row, before the approval")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        out, press = tap_journaled(m, "Approve")
    assert out["outcome"] == "unknown"
    assert m.ledger.db.execute("SELECT 1 FROM updates WHERE update_id=?", (int(press["id"]),)).fetchone()
    assert m.ledger.db.execute("SELECT consumed_at FROM approvals WHERE consumed_update_id=?",
                               (int(press["id"]),)).fetchone() is None          # the approval never ran
    assert dentists(m) == []
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    cards = new_cards(m, before)
    said = " ".join(c["text"] for c in cards)
    assert "wasn't carried out: the error came before it was taken" in said
    assert "settle" not in said and "finish or settle" not in said
    assert "Go ahead" in card_labels(cards)
    assert m.c.handovers.journaled() == []
    out = m.tap("Go ahead")
    assert out["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    assert len(dentists(m)) == 1                                               # done now, once


@pytest.mark.card_only
def test_a_change_the_records_are_still_carrying_out_stays_unknown_until_it_settles(m, monkeypatch, tmp_path,
                                                                                    clock):
    dentist_card(m)
    real = m.c.callbacks.handle

    def handle(inc):
        real(inc)                                                              # the approval is used up
        raise RuntimeError("cut off before the change ran")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        mp.setattr(m.c, "_work", lambda: None)                                 # nothing runs before the stop
        out, press = tap_journaled(m, "Approve")
    assert out["outcome"] == "unknown" and dentists(m) == []
    hold = {}
    real_settle = Controller._settle_unknown

    def settle(self, rows):
        hold.update({r["press"]["id"]: self._records_hold(r["press"]) for r in rows})
        return real_settle(self, rows)
    monkeypatch.setattr(Controller, "_settle_unknown", settle)
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    assert hold[press["id"]] == "settling"
    said = [c["text"] for c in new_cards(m, before)]
    assert any("still carrying it out" in t and "at about" in t for t in said), said
    assert "Go ahead" not in card_labels(new_cards(m, before))
    assert [r["state"] for r in m.c.handovers.journaled()] == ["unknown"]      # kept, not struck
    for _ in range(3):
        m.c.tick()                                                             # the records settle it themselves
    m.c.outbox.flush()
    assert [r["state"] for r in m.c.handovers.journaled()] == ["unknown"]      # still kept until the next read
    seen = len(m.link.cards)
    later(m, clock, 121)                                                       # the next read (2 min, 19th round)
    assert m.c.handovers.journaled() == []
    cards = new_cards(m, seen)
    assert any("Harness's records took it" in c["text"] for c in cards)
    # Nineteenth round: the records' own job ended without sending the add, so it's a failed outcome, not "the
    # records took it": the card names Dentist as not done and offers it again (round19 tests cover the rest).
    assert any("Dentist: not on your calendar" in c["text"] for c in cards)
    assert "Go ahead" in card_labels(cards)
    assert dentists(m) == []                                                   # the records said nothing changed


# -- 2. Undo's read-back and writer, by the version the change left --------------------------------------------------

def added_then_undo_cut_off(m, monkeypatch):
    """Dentist added (his Approve), a backup, then his Undo tap cut off before anything ran."""
    dentist_card(m)
    assert m.tap("Approve")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    backup = sqlite3.connect(":memory:")
    m.ledger.db.backup(backup)

    def handle(inc):
        raise RuntimeError("cut off")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        tap_journaled(m, "Undo")
    op = next(r for r in lines(m.c.handovers.journal) if "intent" in r)["op"]
    return backup, op


@pytest.mark.card_only
def test_undo_read_back_finds_his_later_edit_changed_and_offers_no_go_ahead(m, monkeypatch):
    backup, op = added_then_undo_cut_off(m, monkeypatch)
    (ev,) = dentists(m)
    assert op["steps"][0]["etag"] == ev["etag"]                                # the version the add left, journaled
    m.gmail.events[ev["id"]]["summary"] = "Dentist (bring forms)"              # his edit on his phone
    m.gmail.events[ev["id"]]["etag"] = '"his-edit"'
    assert m.cc.undo_parts(op) == ["changed"]
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    cards = new_cards(m, before)
    assert any("changed on your calendar since" in c["text"] for c in cards)
    assert "Go ahead" not in card_labels(cards)
    assert m.gmail.events[ev["id"]]["status"] == "confirmed"                   # his edit stands


@pytest.mark.card_only
def test_undo_read_back_at_the_journaled_version_is_not_done_and_go_ahead_undoes_it(m, monkeypatch):
    backup, op = added_then_undo_cut_off(m, monkeypatch)
    assert m.cc.undo_parts(op) == ["not_done"]
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    assert "Go ahead" in card_labels(new_cards(m, before))
    assert m.tap("Go ahead")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    assert dentists(m) == []


@pytest.mark.card_only
def test_the_undo_writer_sends_if_match_on_the_journaled_version(m):
    dentist_card(m)
    assert m.tap("Approve")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    (ev,) = dentists(m)
    journaled = json.loads(m.ledger.db.execute("SELECT undo_json FROM calendar_changes").fetchone()[0])[0]["etag"]
    sent = []
    real = m.gmail.drop
    m.gmail.drop = lambda address, uid, etag: sent.append(etag) or real(address, uid, etag)
    assert m.tap("Undo")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    assert sent == [journaled] and dentists(m) == []


@pytest.mark.card_only
def test_the_undo_writer_leaves_an_event_whose_version_moved_alone(m):
    dentist_card(m)
    assert m.tap("Approve")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    (ev,) = dentists(m)
    m.gmail.events[ev["id"]]["etag"] = '"his-edit"'                            # same fields, a new version
    assert m.tap("Undo")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    assert len(dentists(m)) == 1
    assert not any(e[0] == "drop" for e in m.gmail.log)


# -- 3. no button named in prose; a link refusal isn't terminal ------------------------------------------------------

@pytest.mark.parametrize("seen", ["not_done", "unread", "unchecked", "mixed", "removed", "absent", "changed",
                                  "records_took", "records_unread", "settling", "no_identity", "untaken", "records"])
@pytest.mark.parametrize("state", ["committed", "unknown", "not_started"])
def test_the_relist_cards_never_name_a_button(seen, state):
    for restored in (True, False):
        text = Controller._relist_words(state, seen, [("Dentist", "done"), ("PT", "not_done")], restored=restored)
        assert not any(label in text for label in BUTTON_LABELS), text


def test_the_unknown_tap_note_names_no_button_and_says_when_it_reads():
    assert not any(label in Controller.TAP_UNKNOWN for label in BUTTON_LABELS)
    assert "in about a minute" in Controller.TAP_UNKNOWN


def test_a_link_refusal_for_a_named_button_falls_back_to_plain_words_and_is_recorded(m):
    real = m.link.card
    tried = []

    def card(text, rows, kind, expires=None, **kw):
        tried.append(text)
        if "Tap Go ahead" in text:
            raise LinkError(400, 'the card names "Go ahead", which it doesn\'t carry')
        return real(text, rows, kind, expires, **kw)
    m.link.card = card
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db,
                         text="It was on your calendar and has since been taken off. Tap Go ahead to see it.")
    before = len(m.link.cards)
    m.c.outbox.flush()
    (posted,) = [m.link.cards[c] for c in sorted(m.link.cards)[before:]]
    assert posted["text"].endswith("has since been taken off.") and "Go ahead" not in posted["text"]
    assert len(tried) == 2
    row = m.ledger.db.execute("SELECT state FROM outbox ORDER BY id DESC LIMIT 1").fetchone()
    assert row["state"] == "sent"                                              # not dead
    ev = m.ledger.db.execute("SELECT detail FROM events WHERE kind='link_refused_card'").fetchone()
    assert ev is not None and "Go ahead" in ev[0]


def test_any_other_link_refusal_is_still_terminal(m):
    m.link.card = lambda text, rows, kind, expires=None, **kw: (_ for _ in ()).throw(LinkError(400, "not a card"))
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="Something.")
    m.c.outbox.flush()
    assert m.ledger.db.execute("SELECT state FROM outbox ORDER BY id DESC LIMIT 1").fetchone()["state"] == "dead"


# -- 4. Go ahead only on an allow list -------------------------------------------------------------------------------

def unregistered(m, kind):
    """A choice of a kind nothing has registered yet, as a newer build might leave in the records."""
    with m.ledger.tx() as db:
        nonce = choices.mint(m.ledger, kind="calendar_change_fast_keep", target="x",
                             chat_id=m.c.config.owner_user_id, ttl_s=60, db=db)
        db.execute("UPDATE choices SET kind=? WHERE nonce=?", (kind, nonce))
    return nonce


def test_an_unregistered_writer_kind_is_denied_go_ahead_by_default(m):
    owner = m.c.config.owner_user_id
    future = unregistered(m, "calendar_change_some_future_writer")
    with m.ledger.tx() as db:
        mail = choices.mint(m.ledger, kind="mail_dates_family", target="x", chat_id=owner, ttl_s=60, db=db)
        rule = choices.mint(m.ledger, kind="rule_approve", target="r", chat_id=owner, ttl_s=60, db=db)
    for nonce in (future, mail):
        op = m.c._tap_op({"custom_id": "k:" + choices.callback_data(nonce)})
        assert op["choice"] is True and m.c._tap_effect(op) == "no_identity"
    assert m.c._tap_op({"custom_id": "k:" + choices.callback_data(rule)})["effect"] == "records"


def test_an_unregistered_writer_kind_gets_no_go_ahead_on_its_card(m):
    inbox = m.c.handovers
    nonce = unregistered(m, "calendar_change_some_future_writer")
    press = {"id": "81001", "token": "t", "app": "9", "custom_id": "k:" + choices.callback_data(nonce),
             "message_id": "1"}
    assert inbox._append({"press": press, "at": 1.0e9})
    assert inbox.journal_intent(press, m.c._tap_op(press))
    before = len(m.link.cards)
    m.c._taps_replayed, m.c.restored_at_start = False, True
    m.c.tick()
    m.c.outbox.flush()
    assert "Go ahead" not in card_labels(new_cards(m, before))


# -- 5 and 12. an add absent at its fixed id: can't tell, never re-added -------------------------------------------

@pytest.mark.card_only
def test_a_family_add_deleted_since_reads_as_cant_tell_and_gets_no_go_ahead(m, monkeypatch):
    out = m.tells("add family dinner 6 to 7 today", ask(FAMILY_DINNER))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    backup, press = landed_then_crashed(m, monkeypatch)
    for path in [p for p, (_, ics) in m.icloud.events.items() if "Family dinner" in ics]:
        del m.icloud.events[path]                                              # he deleted it on his phone
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    cards = new_cards(m, before)
    assert any("can't tell whether it was added and taken off since" in c["text"] for c in cards)
    assert "Go ahead" not in card_labels(cards)
    for _ in range(3):
        m.c.tick()
    assert not any("Family dinner" in ics for _, ics in m.icloud.events.values())


@pytest.mark.card_only
def test_a_google_404_at_a_journaled_fixed_id_is_absent(m, monkeypatch):
    dentist_card(m)
    backup, press = landed_then_crashed(m, monkeypatch)
    (ev,) = dentists(m)
    del m.gmail.events[ev["id"]]                                               # Google answers 404 there now
    op = m.c.handovers.journaled()[0]["op"]
    assert m.cc.tap_parts(op) == ["absent"]
    said = m.c._reconfirm_tap(json.dumps({"custom_id": press["custom_id"], "message_id": press["message_id"],
                                          "op": op}))
    assert "can't tell whether it was added and taken off" in said
    assert len([e for e in m.gmail.log if e[0] == "insert"]) == 1


# -- 6. the skipped parts: one execution, read fresh ----------------------------------------------------------------

@pytest.mark.card_only
def test_the_skip_is_read_fresh_for_one_execution_and_a_second_skips_nothing(m):
    out = m.tells("add the dentist 3 to 4 and lunch 5 to 6 today", ask(DENTIST, LUNCH))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    op = m.c._tap_op(press_for(m, "Approve"))
    pid = op["proposal"]
    params = json.loads(m.ledger.db.execute("SELECT params_json FROM proposals WHERE id=?", (pid,)).fetchone()[0])
    keys = op["keys"] or [f"{pid}:0", f"{pid}:1"]
    dentist_id = m.cc._uid(keys[0], "cm")
    lunch_id = m.cc._uid(keys[1], "cm")
    m.gmail.events[dentist_id] = {"id": dentist_id, "summary": "Dentist", "status": "confirmed", "etag": '"d"',
                                  "start": {"dateTime": at(15).isoformat(), "timeZone": TZ},
                                  "end": {"dateTime": at(16).isoformat(), "timeZone": TZ}}
    assert m.cc.tap_parts(op) == ["done", "absent"]                            # at the card: only Dentist settled
    m.cc.skip_found(pid, op)
    # The calendar changes before the run: Lunch lands there too.
    m.gmail.events[lunch_id] = {"id": lunch_id, "summary": "Lunch", "status": "confirmed", "etag": '"l"',
                                "start": {"dateTime": at(17).isoformat(), "timeZone": TZ},
                                "end": {"dateTime": at(18).isoformat(), "timeZone": TZ}}
    parts, _ = m.cc._plan_all(params, pid, run=True)
    assert parts == []                                                         # read now: both settled
    assert m.ledger.get_meta(f"calendar_change_skip:{pid}") is None           # cleared with that execution
    parts, _ = m.cc._plan_all(params, pid, run=True)                          # a second execution
    assert len(parts) == 2                                                     # skips nothing on an old read


# -- 7. two removals, each read by its own bound event ---------------------------------------------------------------

@pytest.mark.card_only
def test_two_removals_with_one_landed_go_ahead_removes_only_the_other(m, monkeypatch):
    gym(m)
    out = m.tells("take PT and gym off today", ask(REMOVE_PT, REMOVE_GYM))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    was = dict(m.gmail.events["gym1"])
    backup, press = landed_then_crashed(m, monkeypatch)
    assert m.gmail.events[PT_ID]["status"] == "cancelled"
    m.gmail.events["gym1"] = was                                               # that removal never landed
    op = m.c.handovers.journaled()[0]["op"]
    assert sorted(b["change"] for b in op["bound"] if b["calendar"] == "gmail") == [0, 1]
    assert m.cc.tap_parts(op) == ["done", "not_done"]
    before = len(m.link.cards)
    restart_after_restore(m, backup)
    assert "Go ahead" in card_labels(new_cards(m, before))
    drops = len([e for e in m.gmail.log if e[0] == "drop" and e[1] == PT_ID])
    assert m.tap("Go ahead")["status"] == "ok"
    for _ in range(4):
        m.c.tick()
    assert m.gmail.events["gym1"]["status"] == "cancelled"
    assert len([e for e in m.gmail.log if e[0] == "drop" and e[1] == PT_ID]) == drops   # PT not touched again


def test_a_bound_entry_without_its_change_never_stands_in_for_a_sibling(m):
    gym(m)
    m.gmail.events[PT_ID]["status"] = "cancelled"                              # one removal landed
    op = {"effect": "calendar_change", "proposal": "p1", "keys": [],
          "changes": [REMOVE_PT, REMOVE_GYM],
          "bound": [{"op": "remove", "calendar": "gmail", "id": PT_ID, "instance": PT_ID},
                    {"op": "remove", "calendar": "gmail", "id": "gym1", "instance": "gym1"}]}
    assert m.cc.tap_parts(op) == ["unchecked", "unchecked"]                    # legacy entries: can't tell whose


# -- 8. the forced Add anyway writer ---------------------------------------------------------------------------------

def test_the_forced_writer_refuses_when_its_read_fails_on_gmail(m):
    m.gmail.down = True
    c = dict(DENTIST, start=at(15).isoformat(), end=at(16).isoformat())
    with pytest.raises(Refuse) as why:
        m.cc._add_part(c, "anyway:p1:0", force=True)
    assert "couldn't be read just now" in str(why.value) and "nothing was added" in str(why.value)
    assert not any(e[0] == "insert" for e in m.gmail.log)


def test_the_forced_writer_refuses_when_its_read_fails_on_family(m):
    m.icloud.down = True
    with pytest.raises(Refuse) as why:
        m.cc._add_part(FAMILY_DINNER, "anyway:p2:0", force=True)
    assert "couldn't be read just now" in str(why.value)
    m.icloud.down = False
    assert not any(method == "PUT" for method, *_ in m.icloud.log)


@pytest.mark.card_only
def test_a_google_409_on_the_forced_add_is_already_there_and_nothing_is_written(m, monkeypatch):
    add_anyway_receipt(m)
    src = m.ledger.db.execute("SELECT target FROM choices WHERE kind='calendar_change_add_anyway'").fetchone()[0]
    from harness.calendar_change import add_anyway_key
    anyway_id = m.cc._uid(add_anyway_key(src, 0), "cm")
    m.gmail.events[anyway_id] = {"id": anyway_id, "summary": "Dentist", "status": "confirmed", "etag": '"a"',
                                 "start": {"dateTime": at(15).isoformat(), "timeZone": TZ},
                                 "end": {"dateTime": at(16).isoformat(), "timeZone": TZ}}
    real = m.cc._there_by_id
    monkeypatch.setattr(m.cc, "_there_by_id", lambda cal, ident: "not_done" if ident == anyway_id
                        else real(cal, ident))                                 # its read raced the write
    before = len(m.link.cards)
    assert m.tap("Add anyway")["status"] == "ok"
    for _ in range(4):
        m.c.tick()
    m.c.outbox.flush()
    assert len(dentists(m)) == 2                                               # the one there, nothing more
    said = " ".join(new_said(m, before))
    assert "already there, so nothing was written" in said


def test_a_family_add_put_carries_if_none_match(m):
    step = m.cc._add_part(FAMILY_DINNER, "p3:0").steps[0]
    step.run()
    puts = [h for method, path, h, _ in m.icloud.log if method == "PUT"]
    assert puts and all(h.get("If-None-Match") == "*" for h in puts)


# -- 9. unknown taps are read again in the running loop --------------------------------------------------------------

@pytest.mark.card_only
def test_an_unknown_tap_is_read_again_in_the_running_loop_on_a_backoff(m, monkeypatch, clock):
    dentist_card(m)
    real = m.c.callbacks.handle

    def handle(inc):
        got = real(inc)
        m.cc.run_pending(paused=False)                                         # the write lands
        raise RuntimeError("the handler failed after the write")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        out, press = tap_journaled(m, "Approve")
    assert out["outcome"] == "unknown"
    before = len(m.link.cards)
    m.c.tick()
    m.c.outbox.flush()
    assert new_cards(m, before) == []                                          # not due yet
    m.gmail.down = True
    later(m, clock, 61)                                                        # due, but the read can't answer
    waits = [c["text"] for c in new_cards(m, before)]
    assert len(waits) == 1 and "reads your calendar for it again at about" in waits[0]
    assert not any(label in waits[0] for label in BUTTON_LABELS)
    assert [r["state"] for r in m.c.handovers.journaled()] == ["unknown"]
    later(m, clock, 30)                                                        # not due again yet: nothing more
    assert len(new_cards(m, before)) == 1
    m.gmail.down = False
    later(m, clock, 121)                                                       # read, and found
    said = new_said(m, before)
    assert any("already on your calendar" in t for t in said), said
    assert "Go ahead" not in card_labels(new_cards(m, before))
    assert m.c.handovers.journaled() == [] and len(dentists(m)) == 1


@pytest.mark.card_only
def test_the_backoff_is_bounded(m, monkeypatch, clock):
    dentist_card(m)
    real = m.c.callbacks.handle

    def handle(inc):
        real(inc)
        m.cc.run_pending(paused=False)
        raise RuntimeError("failed after the write")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        tap_journaled(m, "Approve")
    m.gmail.down = True
    for wait in (61,) + tuple(s + 1 for s in m.c.CHECK_BACKOFF_S[1:]) + (3601,):
        later(m, clock, wait)
    assert m.c.handovers.journaled() == []                                     # given its card for good
    said = new_said(m, 0)
    assert any("couldn't read your calendar to tell how far it got" in t for t in said), said
