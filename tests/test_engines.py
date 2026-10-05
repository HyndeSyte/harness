"""Engine adapters: request shape, response parsing, errors, spend, retries."""
import json

import pytest

from harness import policy, prompts
from harness.config import Config
from harness.engines import (AnthropicEngine, EngineError, OpenAIEngine,
                             call_with_retries)
from harness.net import REDACT, TransportError
from fakes import FakeEngine, FakeTransport, result

AKEY = "sk-ant-api03-" + "A" * 40
OKEY = "sk-proj-" + "B" * 40
SCHEMA = prompts.output_schema(Config(owner_user_id=1, stage="S1").stage_at_least)


def wrap(obj):
    return json.dumps({"output": obj})


def anthropic(replies):
    t = FakeTransport(replies)
    return AnthropicEngine(policy.MODELS["claude"], lambda: AKEY, t), t


def openai(replies):
    t = FakeTransport(replies)
    return OpenAIEngine(policy.MODELS["gpt"], lambda: OKEY, t), t


def a_ok(obj, stop="end_turn", usage=None, thinking=True):
    content = [{"type": "thinking", "thinking": ""}] if thinking else []
    content.append({"type": "text", "text": wrap(obj) if not isinstance(obj, str) else obj})
    return (200, {"model": "claude-sonnet-5-5", "stop_reason": stop, "content": content,
                  "usage": usage or {"input_tokens": 1000, "output_tokens": 500}})


def test_anthropic_request_shape_and_answer():
    eng, t = anthropic([a_ok({"type": "answer", "text": "hi"})])
    res = eng.complete(system="S", user="U", schema=SCHEMA)
    assert res.status == "ok" and res.output == {"type": "answer", "text": "hi"}
    req = t.requests[0]
    assert req["url"] == "https://api.anthropic.com/v1/messages"
    assert req["headers"]["x-api-key"] == AKEY
    assert req["headers"]["anthropic-version"] == "2023-06-01"
    body = req["json"]
    assert body["model"] == "claude-sonnet-5-5" and body["system"] == "S"
    assert body["messages"] == [{"role": "user", "content": "U"}]
    assert body["output_config"]["format"] == {"type": "json_schema", "schema": SCHEMA}
    assert body["output_config"]["effort"] == "high"
    assert "temperature" not in body            # rejected on current models
    # spend: 1000 in at $2/M + 500 out at $10/M
    assert res.usd == pytest.approx(0.002 + 0.005)


@pytest.mark.parametrize("stop, status", [("refusal", "refused"), ("max_tokens", "incomplete"),
                                          ("model_context_window_exceeded", "incomplete"),
                                          ("tool_use", "bad_output")])
def test_anthropic_non_answers_are_billed_results_not_answers(stop, status):
    eng, _ = anthropic([a_ok({"type": "answer", "text": "x"}, stop=stop)])
    res = eng.complete(system="S", user="U", schema=SCHEMA)
    assert res.status == status and res.output is None and res.usd > 0


@pytest.mark.parametrize("text", ["not json", json.dumps({"type": "answer", "text": "x"}),
                                  json.dumps({"output": "x"}),
                                  json.dumps({"output": {"type": "answer"}, "extra": 1})])
def test_anthropic_unwrapped_or_garbled_output_is_bad_output(text):
    eng, _ = anthropic([a_ok(text)])
    assert eng.complete(system="S", user="U", schema=SCHEMA).status == "bad_output"


def test_anthropic_cache_tokens_are_priced():
    eng, _ = anthropic([a_ok({"type": "answer", "text": "x"}, usage={
        "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 1_000_000,
        "cache_read_input_tokens": 1_000_000})])
    assert eng.complete(system="S", user="U", schema=SCHEMA).usd == pytest.approx(2.5 + 0.2)


@pytest.mark.parametrize("status, body, headers, kind, reason", [
    (429, {"error": {"type": "rate_limit_error", "message": "slow"}}, {"retry-after": "7"},
     "retryable", "rate_limited"),
    (429, {"error": {"type": "rate_limit_error", "message": "cap",
                     "details": {"error_code": "enforced_spend_limit_reached"}}}, {},
     "fatal", "spend_limit"),
    (529, {"error": {"type": "overloaded_error"}}, {}, "retryable", "overloaded"),
    (500, {"error": {"type": "api_error"}}, {}, "retryable", "server_error"),
    (402, {"error": {"type": "billing_error", "message": "pay"}}, {}, "fatal", "billing"),
    (400, {"error": {"type": "invalid_request_error",
                     "message": "Your credit balance is too low to access the Anthropic API"}},
     {}, "fatal", "billing"),
    (401, {"error": {"type": "authentication_error"}}, {}, "fatal", "auth"),
    (404, {"error": {"type": "not_found_error"}}, {}, "fatal", "model_missing"),
    (400, {"error": {"type": "invalid_request_error", "message": "bad"}}, {}, "fatal",
     "http_400"),
])
def test_anthropic_errors(status, body, headers, kind, reason):
    eng, _ = anthropic([(status, body, headers)])
    with pytest.raises(EngineError) as ei:
        eng.complete(system="S", user="U", schema=SCHEMA)
    assert ei.value.kind == kind and ei.value.reason == reason
    if headers.get("retry-after"):
        assert ei.value.retry_after == 7


def test_transport_failure_is_retryable_and_never_carries_the_key():
    eng, _ = anthropic([TransportError("timeout")])
    with pytest.raises(EngineError) as ei:
        eng.complete(system="S", user="U", schema=SCHEMA)
    assert ei.value.retryable and AKEY not in str(ei.value)


def test_a_key_in_a_provider_error_message_is_redacted():
    eng, _ = anthropic([(400, {"error": {"type": "invalid_request_error",
                                         "message": f"bad key {AKEY}"}})])
    with pytest.raises(EngineError) as ei:
        eng.complete(system="S", user="U", schema=SCHEMA)
    assert AKEY not in str(ei.value) and "[redacted]" in str(ei.value)


def test_no_key_means_no_call():
    t = FakeTransport([])
    eng = AnthropicEngine(policy.MODELS["claude"], lambda: "", t)
    with pytest.raises(EngineError) as ei:
        eng.complete(system="S", user="U", schema=SCHEMA)
    assert ei.value.reason == "no_key" and not ei.value.retryable and t.requests == []


def o_ok(obj, status="completed", usage=None, refusal=False):
    content = ([{"type": "refusal", "refusal": "no"}] if refusal
               else [{"type": "output_text", "text": wrap(obj)}])
    return (200, {"model": "gpt-6.1-sol", "status": status,
                  "output": [{"type": "reasoning", "summary": []},
                             {"type": "message", "content": content}],
                  "usage": usage or {"input_tokens": 2000, "output_tokens": 1000,
                                     "input_tokens_details": {"cached_tokens": 1000}}})


def test_openai_request_shape_and_answer():
    eng, t = openai([o_ok({"type": "answer", "text": "hi"})])
    res = eng.complete(system="S", user="U", schema=SCHEMA)
    assert res.status == "ok" and res.output["text"] == "hi"
    req = t.requests[0]
    assert req["url"] == "https://api.openai.com/v1/responses"
    assert req["headers"]["authorization"] == f"Bearer {OKEY}"
    body = req["json"]
    assert body["store"] is False and body["instructions"] == "S" and body["input"] == "U"
    assert body["reasoning"] == {"effort": "low"}
    fmt = body["text"]["format"]
    assert fmt["type"] == "json_schema" and fmt["strict"] is True and fmt["schema"] == SCHEMA
    # cached reads are deliberately charged at full price: 2000 in, 1000 out
    assert res.usd == pytest.approx(0.004 + 0.01)


def test_openai_refusal_and_incomplete():
    eng, _ = openai([o_ok(None, refusal=True),
                     (200, {"status": "incomplete",
                            "incomplete_details": {"reason": "max_output_tokens"},
                            "output": [], "usage": {"input_tokens": 1, "output_tokens": 9}})])
    assert eng.complete(system="S", user="U", schema=SCHEMA).status == "refused"
    r = eng.complete(system="S", user="U", schema=SCHEMA)
    assert r.status == "incomplete" and r.detail == "max_output_tokens"


@pytest.mark.parametrize("status, err, headers, kind, reason", [
    (429, {"code": "credit_balance_exhausted", "type": "insufficient_quota"}, {}, "fatal",
     "billing"),
    (429, {"code": "insufficient_quota"}, {}, "fatal", "billing"),
    (429, {"code": "project_spend_limit_exceeded"}, {}, "fatal", "spend_limit"),
    (429, {"code": "rate_limit_exceeded"}, {"Retry-After": "3"}, "retryable", "rate_limited"),
    (503, {"code": "server_is_overloaded"}, {}, "retryable", "server_error"),
    (401, {"code": "invalid_api_key"}, {}, "fatal", "auth"),
    (404, {"code": "model_not_found"}, {}, "fatal", "model_missing"),
])
def test_openai_errors(status, err, headers, kind, reason):
    eng, _ = openai([(status, {"error": err}, headers)])
    with pytest.raises(EngineError) as ei:
        eng.complete(system="S", user="U", schema=SCHEMA)
    assert ei.value.kind == kind and ei.value.reason == reason


def test_check_model():
    eng, _ = anthropic([(200, {"id": "claude-sonnet-5-5"}), (404, {})])
    assert eng.check_model() == "ok" and eng.check_model() == "missing"
    eng, t = openai([(200, {"id": "gpt-6.1-sol"})])
    assert eng.check_model() == "ok"
    assert t.requests[0]["url"].endswith("/v1/models/gpt-6.1-sol")


class Clock:
    def __init__(self):
        self.t = 0.0
        self.slept = []

    def sleep(self, s):
        self.slept.append(s)
        self.t += s

    def mono(self):
        return self.t


def test_retries_retryable_errors_on_the_same_engine_only():
    c = Clock()
    eng = FakeEngine(script=[EngineError("retryable", "overloaded"),
                             EngineError("retryable", "rate_limited", retry_after=30),
                             result()])
    out = call_with_retries(eng, system="S", user="U", schema={}, budget_s=570,
                            sleep=c.sleep, monotonic=c.mono)
    assert out.result is not None and out.attempts == 3
    assert c.slept == [5, 30]          # back-off, then the provider's retry-after


def test_fatal_errors_are_not_retried():
    c = Clock()
    eng = FakeEngine(script=[EngineError("fatal", "billing")])
    out = call_with_retries(eng, system="S", user="U", schema={}, budget_s=570,
                            sleep=c.sleep, monotonic=c.mono)
    assert out.result is None and out.error.reason == "billing" and out.attempts == 1


def test_retries_stop_when_the_deadline_cannot_fit_another_call():
    c = Clock()
    eng = FakeEngine(script=[EngineError("retryable", "overloaded")] * 10)
    out = call_with_retries(eng, system="S", user="U", schema={}, budget_s=150,
                            sleep=c.sleep, monotonic=c.mono)
    # waits of 5 and 20 s still leave room for a full 120 s call inside 150 s;
    # a 60 s wait would not, so it stops there with the last error
    assert out.result is None and out.attempts == 3 and c.slept == [5, 20]
    assert out.error.reason == "overloaded"


def test_redactor_never_leaks_registered_secrets():
    REDACT.register(AKEY)
    assert AKEY not in REDACT(f"url https://x/{AKEY}/y")
