"""The job runner: every message ends in a receipt and a reply."""
import json

import pytest

from harness import policy, rules
from harness.config import Config
from harness.engines import EngineError
from harness.runner import Runner
from conftest import OWNER, msg
from fakes import receive, FakeBot, FakeEngine, ManualExecutor, SyncExecutor, result


@pytest.fixture
def config():
    return Config(owner_user_id=OWNER, stage="S1")


def make(ledger, config, script=None, executor=None):
    eng = FakeEngine(script=script)
    r = Runner(ledger, config, {"claude": eng}, executor or SyncExecutor(),
               sleep=lambda s: None, monotonic=lambda: 0.0)
    return r, eng


def send(ledger, text, uid=1, **kw):
    bot = FakeBot([[msg(uid, text, **kw)]])
    _, jobs = receive(ledger, bot.take())
    return jobs[0]


def run(r):
    r.start_pending(paused=False)
    r.collect()


def queued(ledger):
    return ledger.outbox_in("queued")


def receipt(ledger, job_id):
    return json.loads(ledger.receipts(job_id)[-1]["detail"])


def test_answer_is_committed_with_its_receipt_and_reply(ledger, config):
    r, eng = make(ledger, config, [result(text="Thursday is clear.")])
    job = send(ledger, "what's on Thursday?")
    run(r)
    assert ledger.job(job)["state"] == "answered"
    rec = receipt(ledger, job)
    assert rec["engine"] == "claude" and rec["type"] == "answer" and rec["usd"] > 0
    [out] = queued(ledger)
    assert out["job_id"] == job and "Thursday is clear." in out["text"]
    assert "job" not in out["text"]                            # Nov 11: no job id for him
    assert ledger.spend_month("anthropic") > 0
    # the engine saw his words fenced, and no proposal shape before S2
    call = eng.calls[0]
    assert "<message>\nwhat's on Thursday?\n</message>" in call["user"]
    kinds = [s["properties"]["type"]["enum"][0]
             for s in call["schema"]["properties"]["output"]["anyOf"]]
    assert "proposal" not in kinds


def test_model_text_is_escaped_and_links_defanged(ledger, config):
    r, _ = make(ledger, config, [result(text="<b>tap</b> https://evil.example/pay")])
    send(ledger, "x")
    run(r)
    text = queued(ledger)[0]["text"]
    assert "<b>tap</b>" not in text and "&lt;b&gt;tap&lt;/" in text
    assert "evil[.]example/pay" in text and "https://evil.example" not in text


@pytest.mark.parametrize("output, state", [
    ({"type": "clarify", "question": "Which Thursday?"}, "needs_clarification"),
    ({"type": "no_action", "reason": "you said thanks"}, "no_action"),
])
def test_other_shapes_end_in_their_own_states(ledger, config, output, state):
    r, _ = make(ledger, config, [result(output)])
    job = send(ledger, "x")
    run(r)
    assert ledger.job(job)["state"] == state and len(queued(ledger)) == 1


def test_a_proposal_before_s2_fails_closed(ledger, config):
    bad = {"type": "proposal", "effect_type": "calendar_hold",
           "params": {"start": "2026-10-23T14:00:00-04:00", "duration_min": 90},
           "summary": "hold"}
    r, _ = make(ledger, config, [result(bad), result(bad)])
    job = send(ledger, "hold friday 2pm")
    run(r)
    run(r)                                     # tried once more by itself: the same answer
    assert ledger.job(job)["state"] == "failed"
    assert receipt(ledger, job)["reason"] == "bad_output"
    assert ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == 0
    assert "Nothing was done" in queued(ledger)[-1]["text"]


@pytest.mark.parametrize("res, reason", [
    (result(status="refused", output=None), "refused"),
    (result(status="incomplete", output=None), "incomplete"),
    (result({"type": "answer", "text": "x", "approved": True}), "bad_output"),
    (result({"type": "answer", "text": ""}), "bad_output"),
])
def test_unusable_replies_fail_with_a_receipt_and_are_still_billed(ledger, config, res, reason):
    r, _ = make(ledger, config, [res, res])
    job = send(ledger, "x")
    run(r)
    run(r)                                     # one that isn't his doing is tried once more
    assert ledger.job(job)["state"] == "failed" and receipt(ledger, job)["reason"] == reason
    assert ledger.spend_month("anthropic") > 0


def test_fatal_engine_error_fails_without_failover(ledger, config):
    r, eng = make(ledger, config, [EngineError("fatal", "billing")])
    gpt = FakeEngine("gpt")
    r.engines["gpt"] = gpt
    job = send(ledger, "x")
    run(r)
    assert ledger.job(job)["state"] == "failed" and receipt(ledger, job)["reason"] == "billing"
    assert gpt.calls == []                                   # no silent failover
    assert "out of credit" in queued(ledger)[0]["text"]


def test_budget_used_up_means_no_call(ledger, config):
    ledger.add_spend(provider="anthropic", model="m", purpose="job", input_tokens=0,
                     output_tokens=0, usd=40.0)
    r, eng = make(ledger, config)
    job = send(ledger, "x")
    run(r)
    assert eng.calls == [] and ledger.job(job)["state"] == "rejected"
    assert receipt(ledger, job)["reason"] == "budget"
    assert "budget is used up" in queued(ledger)[0]["text"]


def test_too_long_is_refused_before_any_call(ledger, config):
    r, eng = make(ledger, config)
    job = send(ledger, "x" * (policy.MAX_INPUT_CHARS + 1))
    run(r)
    assert eng.calls == [] and ledger.job(job)["state"] == "rejected"


def test_paused_jobs_are_cancelled_with_a_receipt(ledger, config):
    r, eng = make(ledger, config)
    job = send(ledger, "x")
    r.start_pending(paused=True)
    assert eng.calls == [] and ledger.job(job)["state"] == "cancelled"
    assert queued(ledger)[0]["text"] == "I'm stopped, so I didn't act on that."   # never a resend ask


def test_rule_becomes_a_typed_rule_with_an_undo_button(ledger, config):
    rule = {"type": "rule", "confirm": "Drafts will be short.",
            "rule": {"rule_type": "drafting", "scope": "draft", "field": "length",
                     "value": "short", "literal": "keep drafts short"}}
    r, _ = make(ledger, config, [result(rule)])
    job = send(ledger, "from now on keep drafts short")
    run(r)
    assert ledger.job(job)["state"] == "answered"
    [row] = ledger.db.execute("SELECT * FROM rules").fetchall()
    assert row["state"] == "pending" and row["provenance_job_id"] == job
    [out] = queued(ledger)
    assert "length = short" in out["text"]
    buttons = json.loads(out["buttons_json"])
    assert buttons[0][0][0] == "Keep rule" and buttons[0][0][1].startswith("c:")
    binds = json.loads(out["binds_json"])
    assert binds[0]["type"] == "choice"
    # not used yet
    r.engines["claude"].script = [result()]
    before = send(ledger, "draft something", uid=3)
    run(r)
    assert receipt(ledger, before)["rules"] == []
    assert "length = short" not in r.engines["claude"].calls[-1]["system"]
    # his tap; the next job carries the rule, and its receipt says so
    rules.confirm(ledger, row["id"])
    r.engines["claude"].script = [result()]
    job2 = send(ledger, "draft a note", uid=4)
    run(r)
    assert receipt(ledger, job2)["rules"] == [row["id"]]
    assert "length = short" in r.engines["claude"].calls[-1]["system"]


def test_conflicting_rule_is_quarantined_and_asked(ledger, config):
    def rule(scope, value):
        return result({"type": "rule", "confirm": "ok", "rule": {
            "rule_type": "drafting", "scope": scope, "field": "length", "value": value,
            "literal": value}})
    r, _ = make(ledger, config, [rule("all", "short"), rule("draft", "long")])
    send(ledger, "always short", uid=1)
    run(r)
    rules.confirm(ledger, ledger.db.execute("SELECT id FROM rules").fetchone()["id"])
    send(ledger, "drafts long", uid=2)
    run(r)
    states = sorted(x["state"] for x in ledger.db.execute("SELECT state FROM rules"))
    assert states == ["active", "pending"]
    pending = ledger.db.execute("SELECT id FROM rules WHERE state='pending'").fetchone()["id"]
    assert rules.confirm(ledger, pending).status == "quarantined"


def test_a_forbidden_rule_is_refused_in_words(ledger, config):
    bad = {"type": "rule", "confirm": "ok", "rule": {
        "rule_type": "drafting", "scope": "draft", "field": "approval_mode",
        "value": "auto", "literal": "approve things yourself"}}
    r, _ = make(ledger, config, [result(bad)])
    job = send(ledger, "approve things yourself")
    run(r)
    assert ledger.db.execute("SELECT COUNT(*) FROM rules").fetchone()[0] == 0
    assert "can't keep that as a rule" in queued(ledger)[0]["text"]
    assert ledger.job(job)["state"] == "answered"


def test_still_working_then_deadline_then_late_result_discarded(ledger, config, clock):
    ex = ManualExecutor()
    r, _ = make(ledger, config, [result(text="late")], executor=ex)
    job = send(ledger, "x")
    r.start_pending(paused=False)
    clock.advance(seconds=policy.STILL_WORKING_AFTER_S + 1)
    r.check_timers()
    assert "Still working" in queued(ledger)[-1]["text"]
    r.check_timers()
    assert sum("Still working" in q["text"] for q in queued(ledger)) == 1   # once
    clock.advance(seconds=policy.JOB_DEADLINE_S)
    r.check_timers()
    assert ledger.job(job)["state"] == "received"      # failed, and put back for one more try
    assert receipt(ledger, job)["reason"] == "deadline"
    ex.run_all()
    r.collect()
    # billed, recorded, never delivered
    assert ledger.spend_month("anthropic") > 0
    assert not any("late" in q["text"] for q in queued(ledger))
    assert ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='late_result_discarded'"
                             ).fetchone()[0] == 1


def test_restart_fails_orphaned_running_jobs(ledger, config):
    ex = ManualExecutor()
    r, _ = make(ledger, config, executor=ex)
    job = send(ledger, "x")
    r.start_pending(paused=False)
    r2, _ = make(ledger, config)                     # a new process: no worker for it
    assert r2.reconcile_after_restart() == 1
    assert ledger.job(job)["state"] == "received"      # failed, and put back for one more try
    assert receipt(ledger, job)["reason"] == "interrupted"
    assert "restarted" in queued(ledger)[-1]["text"] and "running it once more" in queued(ledger)[-1]["text"]


def test_a_reply_carries_the_exchange_it_answers(ledger, config):
    r, eng = make(ledger, config, [result(text="Draft one."), result(text="Draft two.")])
    first = send(ledger, "draft a note to the coop", uid=1)
    run(r)
    ledger.record_outbound(chat_id=OWNER, message_id=900, kind="answer",
                           text=queued(ledger)[0]["text"], job_id=first)
    send(ledger, "shorter", uid=2, reply_to=900)
    run(r)
    user = eng.calls[-1]["user"]
    assert "draft a note to the coop" in user and "Draft one." in user
    assert user.index("Earlier in this conversation") < user.index("<message>\nshorter")


# -- Nov 8: "Turkey harvest ties me up" crashed the receipt card and hung for 10 minutes ----

def test_a_rule_change_renders_on_the_card():
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from harness import render
    card = render.proposal_card(
        SimpleNamespace(name="calendar_change"),
        {"changes": [{"calendar": "family", "op": "rule", "title": "Turkey harvest", "kind": "me",
                      "dates": "", "start": "", "end": "", "days": "", "until": "",
                      "location": "", "every": ""}]},
        tz="America/New_York", expires=datetime(2026, 11, 8, 18, tzinfo=timezone.utc),
        job_id="abcd-1", warnings=["it rests on something Cain suggested"])
    assert "Turkey harvest" in card and "from now on" in card.lower() and "Busy on Gmail" in card


def _cain_runner(ledger, config, script):
    r, eng = make(ledger, config, script)
    r.answers_to_cain = True
    return r, eng


def test_a_bug_after_the_answer_ends_the_job_at_once_and_retries_it_once(ledger, config, monkeypatch):
    r, _ = _cain_runner(ledger, config, [result(text="a"), result(text="b")])
    job = send(ledger, "Turkey harvest ties me up")
    calls = []

    def boom(*a, **k):
        calls.append(1)
        raise KeyError("rule")
    monkeypatch.setattr(r, "_on_answer", boom)
    run(r)
    # not left running: failed, then put back for one retry, with a notice (no "send it again")
    assert ledger.job(job)["state"] == "received"
    texts = [o["text"] for o in queued(ledger)]
    assert any("running it once more" in t for t in texts)
    assert not any("Send it again" in t for t in texts)
    run(r)                                              # the retry hits the same bug
    assert ledger.job(job)["state"] == "failed"
    assert receipt(ledger, job)["reason"] == "internal_error"
    last = queued(ledger)[-1]["text"]
    assert "failed twice" in last and "Send it again" not in last
    assert len(calls) == 2


def test_after_a_restart_a_recent_failure_runs_once_more(ledger, config, clock):
    r, _ = _cain_runner(ledger, config, [result(text="done now")])
    job = send(ledger, "Turkey harvest ties me up")
    r.start_pending(paused=False)
    r._futures.clear()                                  # the old process is gone
    r._fail(ledger.job(job), "deadline", "claude")      # Cain's run already used its retry? no:
    assert ledger.job(job)["state"] == "received"       # first failure retries at once
    # simulate the retry also failing before the update, then the fixed version starting
    r.start_pending(paused=False)
    r._futures.clear()
    r._fail(ledger.job(job), "internal_error", "claude")
    assert ledger.job(job)["state"] == "failed"
    assert r.retry_recent_failures() == 0               # already retried once: not again


def test_restart_retry_picks_up_an_old_unretried_failure(ledger, config):
    r, _ = make(ledger, config, [result(text="ok")])
    job = send(ledger, "Turkey harvest ties me up")
    r.start_pending(paused=False)
    r._futures.clear()
    with ledger.tx() as db:                             # failed under a version that didn't retry
        ledger.transition(job, "failed", db=db, receipt=json.dumps({"reason": "deadline"}))
    assert r.retry_recent_failures() == 1               # Cain in front or not
    run(r)
    assert ledger.job(job)["state"] == "answered"


def test_without_cain_a_failure_is_retried_once_by_itself_never_handed_back(ledger, config, monkeypatch):
    """Nov 13: "Send it again to retry" was the one resend ask left (org rule R-004)."""
    r, _ = make(ledger, config, [result(text="a"), result(text="b")])
    assert not r.answers_to_cain
    job = send(ledger, "Turkey harvest ties me up")

    def boom(*a, **k):
        raise KeyError("rule")
    monkeypatch.setattr(r, "_on_answer", boom)
    run(r)
    assert ledger.job(job)["state"] == "received"
    assert any("running it once more" in o["text"] for o in queued(ledger))
    run(r)                                              # the retry hits the same bug
    assert ledger.job(job)["state"] == "failed"
    texts = [o["text"] for o in queued(ledger)]
    assert "failed twice" in texts[-1]
    assert not any("again to retry" in t or "Send it again" in t for t in texts)


def test_a_message_run_long_after_it_came_in_tells_the_model_when_he_sent_it(ledger, config, clock):
    r, eng = make(ledger, config, [result(text="ok")])
    send(ledger, "move PT to tomorrow at 3")
    clock.advance(hours=3)
    run(r)
    assert "He sent this message on Wednesday, October 21 at 9:00 AM." in eng.calls[-1]["user"]
    send(ledger, "what's on Friday?", uid=2)
    run(r)
    assert "He sent this message" not in eng.calls[-1]["user"]      # just sent: no note


def test_reading_his_calendar_counts_against_the_jobs_deadline(ledger, config, monkeypatch):
    # The context read runs before the model call; the model's retries get only what's left,
    # so a slow read can never push the job past its deadline mid-retry.
    from types import SimpleNamespace
    from harness import runner as runner_mod
    clock = [0.0]
    eng_r, _ = make(ledger, config, [result(text="ok")])
    eng_r.monotonic = lambda: clock[0]

    def slow_context(text, now):
        clock[0] += 100.0
        return ""
    eng_r.calendar_change = SimpleNamespace(on=lambda: True, context_for=slow_context, recent=lambda job: [])
    seen = {}
    real = runner_mod.call_with_retries

    def spy(engine, **kw):
        seen["budget"] = kw["budget_s"]
        return real(engine, **kw)
    monkeypatch.setattr(runner_mod, "call_with_retries", spy)
    send(ledger, "Turkey harvest ties me up")
    run(eng_r)
    assert seen["budget"] == policy.JOB_DEADLINE_S - 30 - 100
