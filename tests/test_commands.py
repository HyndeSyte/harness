"""Commands and button taps: plain code, always answered, bound like approvals."""
import json

import pytest

from harness import choices, rules
from harness.callbacks import Callbacks
from harness.commands import Commands, is_paused
from harness.config import Config
from harness.outbox import Outbox
from harness.runner import Runner
from conftest import OWNER, cb, msg
from fakes import FakeBot, FakeEngine, ManualExecutor, SyncExecutor, receive, result


@pytest.fixture
def config():
    return Config(owner_user_id=OWNER, stage="S1")


class World:
    def __init__(self, ledger, config, script=None, executor=None):
        self.ledger = ledger
        self.bot = FakeBot()
        self.eng = FakeEngine(script=script)
        self.runner = Runner(ledger, config, {"claude": self.eng}, executor or SyncExecutor(),
                             sleep=lambda s: None, monotonic=lambda: 0.0)
        self.cmds = Commands(ledger, status_fn=lambda: "STATUS",
                             cancel_fn=self.runner.cancel_in_flight)
        self.cbs = Callbacks(ledger, self.bot, owner_user_id=OWNER, policy_version="p1")
        self.outbox = Outbox(ledger, self.bot, sleep=lambda s: None)
        self.uid = 0

    def say(self, text, **kw):
        self.uid += 1
        self.bot.batches.append([msg(self.uid, text, **kw)])
        decisions, jobs = receive(self.ledger, self.bot.take())
        return decisions, jobs

    def tap(self, data, message_id, **kw):
        self.uid += 1
        self.bot.batches.append([cb(self.uid, data, message_id=message_id, **kw)])
        decisions, _ = receive(self.ledger, self.bot.take())
        d = decisions[0]
        return self.cbs.handle(d.incoming) if d.accepted else d.reason

    def step(self):
        self.cmds.handle_pending()
        self.runner.start_pending(paused=is_paused(self.ledger))
        self.runner.collect()
        self.outbox.flush()

    def last(self):
        return self.bot.texts()[-1]


def test_stop_cancels_new_work_and_resume_restores_it(ledger, config):
    w = World(ledger, config)
    w.say("/stop")
    w.step()
    assert is_paused(ledger) and "Stopped." in w.last()
    _, [job] = w.say("draft the coop email")
    w.step()
    assert ledger.job(job)["state"] == "cancelled" and w.eng.calls == []
    # Says it wasn't acted on, and asks nothing: no resend, no button this message lacks.
    assert w.last() == "I'm stopped, so I didn't act on that."
    w.say("/resume")
    w.step()
    assert not is_paused(ledger)
    assert "<b>Resumed.</b> What you asked while I was stopped comes next, one card each." in w.bot.texts()
    assert not any("resend" in t or "send it again" in t.lower() for t in w.bot.texts())
    _, [job2] = w.say("draft the coop email")
    w.step()
    assert ledger.job(job2)["state"] == "answered"


def stopped_card(w, words):
    return next(s for s in reversed(w.bot.sent) if s[2] and words in s[1])


def test_each_request_sent_while_stopped_comes_back_as_its_own_card(ledger, config, clock):
    w = World(ledger, config, [result(text="Here's the draft.")])
    w.say("/stop")
    w.step()
    _, [first] = w.say("draft the coop email")
    _, [second] = w.say("what's on Friday?")
    w.step()
    clock.advance(hours=2)
    w.say("/resume")
    w.step()
    one, two = stopped_card(w, "coop"), stopped_card(w, "Friday")
    assert one[1] == "While I was stopped, you asked: \u201cdraft the coop email\u201d. Do it now?"
    assert [b for b, _ in one[2][0]] == ["Do it now", "Drop it"] and one[3] != two[3]
    # Do it now: that message runs, and the model is told when he sent it.
    assert w.tap(one[2][0][0][1], message_id=one[3]) == "ok"
    w.step()
    assert ledger.job(first)["state"] == "answered" and "Here's the draft." in w.last()
    assert "He sent this message on Wednesday, October 21 at 9:00 AM." in w.eng.calls[-1]["user"]
    # Drop it: nothing runs.
    assert w.tap(two[2][0][1][1], message_id=two[3]) == "ok"
    w.step()
    assert ledger.job(second)["state"] == "cancelled" and len(w.eng.calls) == 1
    assert "Dropped. Nothing was done." in w.bot.texts()
    # Each card works once, and a second /resume brings none back.
    assert w.tap(one[2][0][0][1], message_id=one[3]) == "already used"
    w.say("/resume")
    w.step()
    assert "Not stopped. Nothing to resume." in w.last()


def test_nothing_sent_while_stopped_means_no_cards(ledger, config):
    w = World(ledger, config)
    w.say("/stop")
    w.step()
    w.say("/resume")
    w.step()
    assert w.last() == "<b>Resumed.</b>" and not any(s[2] for s in w.bot.sent)


def test_do_it_now_while_stopped_again_waits_for_the_next_resume(ledger, config):
    w = World(ledger, config)
    w.say("/stop")
    w.step()
    _, [job] = w.say("draft the coop email")
    w.step()
    w.say("/resume")
    w.step()
    card = stopped_card(w, "coop")
    w.say("/stop")
    w.step()
    assert w.tap(card[2][0][0][1], message_id=card[3]) == "ok"
    w.step()
    assert ledger.job(job)["state"] == "cancelled" and w.eng.calls == []
    w.say("/resume")
    w.step()
    assert stopped_card(w, "coop")[3] != card[3]          # its card again, fresh


def test_every_command_is_a_job_with_a_receipt(ledger, config):
    w = World(ledger, config)
    for c in ("/status", "/rule", "/undo", "/resume"):
        _, [job] = w.say(c)
        w.step()
        assert ledger.job(job)["state"] == "answered"
        assert json.loads(ledger.receipts(job)[-1]["detail"])["command"] == c
    assert w.bot.texts()[0] == "STATUS"


def test_cancel_drops_running_work_and_its_late_result(ledger, config):
    ex = ManualExecutor()
    w = World(ledger, config, [result(text="too late")], executor=ex)
    _, [job] = w.say("long question")
    w.step()
    assert ledger.job(job)["state"] == "running"
    w.say("/cancel")
    w.step()
    assert ledger.job(job)["state"] == "cancelled" and "Cancelled 1." in w.last()
    ex.run_all()
    w.step()
    assert not any("too late" in t for t in w.bot.texts())


def test_rule_listing_and_undo(ledger, config):
    w = World(ledger, config)
    r1 = rules.propose(ledger, {"rule_type": "drafting", "scope": "draft", "field": "length",
                                "value": "short", "literal": "short"}, job_id=None)
    rules.propose(ledger, {"rule_type": "presentation", "scope": "all", "field": "tone",
                           "value": "plain", "literal": "plain"}, job_id=None)
    w.say("/rule")
    w.step()
    assert r1.rule_id in w.last() and "tone = plain" in w.last()
    w.say(f"/undo {r1.rule_id}")
    w.step()
    assert "retired" in w.last()
    active, _ = rules.listing(ledger)
    assert [r["field"] for r in active] == ["tone"]
    w.say("/undo")                    # newest active
    w.step()
    assert rules.listing(ledger) == ([], [])


def make_undo_card(w, config):
    w.eng.script = [result({"type": "rule", "confirm": "ok", "rule": {
        "rule_type": "drafting", "scope": "draft", "field": "length", "value": "short",
        "literal": "keep drafts short"}})]
    w.say("keep drafts short")
    w.step()
    _, _, buttons, mid = w.bot.sent[-1]
    assert w.tap(buttons[0][0][1], message_id=mid) == "ok"      # his tap keeps the rule
    w.outbox.flush()
    _, text, buttons, mid = w.bot.sent[-1]
    return buttons[0][0][1], mid


def test_undo_button_works_once_on_its_own_card(ledger, config):
    w = World(ledger, config)
    data, mid = make_undo_card(w, config)
    assert w.tap(data, message_id=mid + 1) == "tap is not on the card it belongs to"
    assert w.tap(data, message_id=mid) == "ok"
    assert rules.listing(ledger) == ([], [])
    assert w.bot.edits[-1] == (OWNER, mid, None)            # buttons removed
    w.outbox.flush()
    assert "retired" in w.last()
    assert w.tap(data, message_id=mid) == "already used"
    assert all(a[0] for a in w.bot.answers)                 # every tap answered


def test_choice_expires(ledger, config, clock):
    w = World(ledger, config)
    data, mid = make_undo_card(w, config)
    clock.advance(days=8)
    assert w.tap(data, message_id=mid) == "expired"
    assert len(rules.listing(ledger)[0]) == 1


def test_one_tap_per_card_for_conflict_choices(ledger, config):
    w = World(ledger, config)
    rules.propose(ledger, {"rule_type": "drafting", "scope": "all", "field": "length",
                           "value": "short", "literal": "short"}, job_id=None)
    w.eng.script = [result({"type": "rule", "confirm": "ok", "rule": {
        "rule_type": "drafting", "scope": "draft", "field": "length", "value": "long",
        "literal": "long drafts"}})]
    w.say("long drafts")
    w.step()
    _, _, buttons, mid = w.bot.sent[-1]
    assert w.tap(buttons[0][0][1], message_id=mid) == "ok"      # his tap keeps the rule
    w.outbox.flush()
    _, _, buttons, mid = w.bot.sent[-1]
    use_new, keep_old = buttons[0][0][1], buttons[0][1][1]
    assert w.tap(use_new, message_id=mid) == "ok"
    assert w.tap(keep_old, message_id=mid) == "already used"   # sibling consumed
    active, quarantined = rules.listing(ledger)
    assert [r["value"] for r in active] == ["long"] and quarantined == []


def test_a_choice_nonce_cannot_be_used_as_an_approval(ledger, config):
    w = World(ledger, config)
    data, mid = make_undo_card(w, config)
    nonce = choices.parse(data)
    assert w.tap(f"a:{nonce}", message_id=mid) == "unknown approval"
    assert len(rules.listing(ledger)[0]) == 1
