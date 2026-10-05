"""The outbox: committed with the job, sent in order, retried, bound after."""
import json

from harness import approvals, choices
from harness.outbox import Outbox
from harness.telegram_api import TelegramError
from conftest import OWNER
from fakes import FakeBot, tg_error


def enqueue(ledger, text, **kw):
    with ledger.tx() as db:
        return ledger.enqueue(chat_id=OWNER, kind=kw.pop("kind", "reply"), text=text, db=db,
                              **kw)


def test_sends_in_order_and_records_what_was_said(ledger):
    bot = FakeBot()
    enqueue(ledger, "one")
    enqueue(ledger, "two")
    assert Outbox(ledger, bot, sleep=lambda s: None).flush() == 2
    assert bot.texts() == ["one", "two"]
    assert {r["state"] for r in ledger.outbox_in("sent")} == {"sent"}
    assert ledger.outbound(OWNER, bot.sent[0][3])["text"] == "one"


def test_buttons_are_bound_only_after_the_send(ledger):
    with ledger.tx() as db:
        nonce = choices.mint(ledger, kind="rule_undo", target="R1", chat_id=OWNER,
                             ttl_s=600, db=db)
    enqueue(ledger, "Saved.", buttons=[[["Undo", choices.callback_data(nonce)]]],
            binds=[{"type": "choice", "nonce": nonce}])
    row = ledger.db.execute("SELECT * FROM choices WHERE nonce=?", (nonce,)).fetchone()
    assert row["message_id"] is None                   # not tappable before it exists
    bot = FakeBot()
    Outbox(ledger, bot, sleep=lambda s: None).flush()
    row = ledger.db.execute("SELECT * FROM choices WHERE nonce=?", (nonce,)).fetchone()
    assert row["message_id"] == bot.sent[0][3]
    assert bot.sent[0][2] == [[("Undo", f"c:{nonce}")]]


def test_rate_limit_waits_for_retry_after(ledger, clock):
    bot = FakeBot()
    bot.fail_sends = [tg_error(429, "Too Many Requests", retry_after=30)]
    rid = enqueue(ledger, "hello")
    ob = Outbox(ledger, bot, sleep=lambda s: None)
    assert ob.flush() == 0
    row = ledger.outbox_row(rid)
    assert row["state"] == "queued" and row["attempts"] == 1
    clock.advance(seconds=10)
    assert ob.flush() == 0 and bot.sent == []          # not due yet
    clock.advance(seconds=25)
    assert ob.flush() == 1 and bot.texts() == ["hello"]


def test_an_outage_delays_a_reply_but_never_drops_it(ledger, clock):
    bot = FakeBot()
    bot.fail_sends = [tg_error(0, "network: timeout")] * 15 + [tg_error(502, "Bad Gateway")] * 5
    rid = enqueue(ledger, "your answer")
    ob = Outbox(ledger, bot, sleep=lambda s: None)
    for _ in range(21):                    # about three hours of failures, then it's back
        ob.flush()
        clock.advance(seconds=601)
    row = ledger.outbox_row(rid)
    assert row["state"] == "sent" and bot.texts()[-1].endswith("your answer")
    assert bot.texts()[-1].startswith("<i>Delayed: written ")
    assert ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='delivery_failed'"
                             ).fetchone()[0] == 0


def test_permanent_errors_are_not_retried(ledger):
    bot = FakeBot()
    bot.fail_sends = [tg_error(403, "Forbidden: bot was blocked by the user")]
    rid = enqueue(ledger, "hello")
    Outbox(ledger, bot, sleep=lambda s: None).flush()
    assert ledger.outbox_row(rid)["state"] == "dead"


def test_markup_error_falls_back_to_plain_text(ledger):
    bot = FakeBot()
    bot.fail_sends = [tg_error(400, "Bad Request: can't parse entities")]
    enqueue(ledger, "<b>Stopped.</b> a &amp; b")
    Outbox(ledger, bot, sleep=lambda s: None).flush()
    assert bot.texts() == ["Stopped. a & b"] and bot.modes == ["plain"]


def test_message_id_zero_is_never_bound(ledger):
    class ZeroBot(FakeBot):
        def send_message(self, chat_id, text, buttons=None):
            self.sent.append((chat_id, text, buttons, 0))
            return 0
    with ledger.tx() as db:
        nonce = choices.mint(ledger, kind="rule_undo", target="R1", chat_id=OWNER,
                             ttl_s=600, db=db)
    enqueue(ledger, "card", buttons=[[["Undo", f"c:{nonce}"]]],
            binds=[{"type": "choice", "nonce": nonce}])
    Outbox(ledger, ZeroBot(), sleep=lambda s: None).flush()
    row = ledger.db.execute("SELECT * FROM choices WHERE nonce=?", (nonce,)).fetchone()
    assert row["message_id"] is None
    assert ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='unbindable_message'"
                             ).fetchone()[0] == 1


def test_held_notices_wait_for_the_next_reply_and_go_first(ledger):
    with ledger.tx() as db:
        ledger.enqueue(chat_id=OWNER, kind="notice", text="continuity unknown", held=True,
                       db=db)
    bot = FakeBot()
    ob = Outbox(ledger, bot, sleep=lambda s: None)
    assert ob.flush() == 0                              # held: proactive not allowed
    with ledger.tx() as db:
        ledger.enqueue(chat_id=OWNER, kind="reply", text="your answer", db=db)
        ledger.release_held(db=db)
    ob.flush()
    assert bot.texts() == ["continuity unknown", "your answer"]


def test_approval_cards_bind_like_choices(ledger, clock):
    # A minimal proposal path, as S2 will use it.
    from conftest import msg
    from harness import telegram
    _, [job] = telegram.poll_once(FakeBot([[msg(1, "hold")]]), ledger, OWNER, timeout=0)
    with ledger.tx() as db:
        ledger.transition(job, "running", db=db)
        pid = approvals.create_proposal(ledger, job_id=job, effect_type="calendar_hold",
                                        params={"start": "2026-10-23T14:00:00-04:00",
                                                "duration_min": 90},
                                        policy_version="p1", ttl_s=3600, db=db)
        ledger.transition(job, "proposed", db=db)
    nonce = approvals.mint(ledger, proposal_id=pid, owner_user_id=OWNER, ttl_s=3600)
    enqueue(ledger, "card", buttons=[[["Approve", f"a:{nonce}"]]],
            binds=[{"type": "approval", "nonce": nonce}])
    bot = FakeBot()
    Outbox(ledger, bot, sleep=lambda s: None).flush()
    a = ledger.db.execute("SELECT * FROM approvals WHERE nonce=?", (nonce,)).fetchone()
    assert a["message_id"] == bot.sent[0][3]
