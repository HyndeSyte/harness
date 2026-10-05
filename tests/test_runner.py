"""The job runner: every message ends in a receipt and a reply."""
import json

import pytest

from harness import policy, telegram
from harness.config import Config
from harness.engines import EngineError
from harness.runner import Runner
from conftest import OWNER, msg
from fakes import FakeBot, FakeEngine, ManualExecutor, SyncExecutor, result


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
    _, jobs = telegram.poll_once(bot, ledger, OWNER, timeout=0)
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
    assert f"job {job.split('-')[0]}" in out["text"]           # footer
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
    r, _ = make(ledger, config, [result(bad)])
    job = send(ledger, "hold friday 2pm")
    run(r)
    assert ledger.job(job)["state"] == "failed"
    assert receipt(ledger, job)["reason"] == "bad_output"
    assert ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == 0
    assert "Nothing was done" in queued(ledger)[0]["text"]


@pytest.mark.parametrize("res, reason", [
    (result(status="refused", output=None), "refused"),
    (result(status="incomplete", output=None), "incomplete"),
    (result({"type": "answer", "text": "x", "approved": True}), "bad_output"),
    (result({"type": "answer", "text": ""}), "bad_output"),
])
def test_unusable_replies_fail_with_a_receipt_and_are_still_billed(ledger, config, res, reason):
    r, _ = make(ledger, config, [res])
    job = send(ledger, "x")
    run(r)
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
    assert "/resume" in queued(ledger)[0]["text"]


def test_rule_becomes_a_typed_rule_with_an_undo_button(ledger, config):
    rule = {"type": "rule", "confirm": "Drafts will be short.",
            "rule": {"rule_type": "drafting", "scope": "draft", "field": "length",
                     "value": "short", "literal": "keep drafts short"}}
    r, _ = make(ledger, config, [result(rule)])
    job = send(ledger, "from now on keep drafts short")
    run(r)
    assert ledger.job(job)["state"] == "answered"
    [row] = ledger.db.execute("SELECT * FROM rules").fetchall()
    assert row["state"] == "active" and row["provenance_job_id"] == job
    [out] = queued(ledger)
    assert "Saved for draft jobs: length = short." in out["text"]
    buttons = json.loads(out["buttons_json"])
    assert buttons[0][0][0] == "Undo" and buttons[0][0][1].startswith("c:")
    binds = json.loads(out["binds_json"])
    assert binds[0]["type"] == "choice"
    # the next job carries the rule, and its receipt says so
    r.engines["claude"].script = [result()]
    job2 = send(ledger, "draft a note", uid=2)
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
    send(ledger, "drafts long", uid=2)
    run(r)
    states = sorted(x["state"] for x in ledger.db.execute("SELECT state FROM rules"))
    assert states == ["active", "quarantined"]
    last = queued(ledger)[-1]
    assert "clashes" in last["text"]
    labels = [b[0] for b in json.loads(last["buttons_json"])[0]]
    assert labels == ["Use new", "Keep old"]


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
    assert ledger.job(job)["state"] == "failed"
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
    assert ledger.job(job)["state"] == "failed"
    assert receipt(ledger, job)["reason"] == "interrupted"
    assert "restarted" in queued(ledger)[-1]["text"]


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
