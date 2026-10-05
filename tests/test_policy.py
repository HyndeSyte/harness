"""Model output, effects, rendering, rules, digest, work-content filter."""
from datetime import datetime, timedelta, timezone

import pytest

from harness import digest, effects, ingress_filter, render, rules, schema
from harness.canonical import canonical_hash, canonical_json
from harness.config import Config


def at_least(stage):
    return lambda s: ("S0", "S1", "S2", "S3").index(stage) >= ("S0", "S1", "S2", "S3").index(s)


# -- canonical ---------------------------------------------------------------

def test_canonical_is_order_and_normalization_independent():
    a = {"b": 1, "a": "é"}            # decomposed é
    b = {"a": "é", "b": 1}             # composed é
    assert canonical_json(a) == canonical_json(b)
    assert canonical_hash(a) == canonical_hash(b)


def test_floats_are_not_approvable():
    with pytest.raises(TypeError):
        canonical_hash({"amount": 0.1})


# -- model output --------------------------------------------------------------

def test_answer_is_accepted():
    out = schema.parse_output('{"type":"answer","text":"Thursday is clear after 2."}',
                              stage_at_least=at_least("S1"))
    assert out.type == "answer"


@pytest.mark.parametrize("raw", [
    '{"type":"answer","text":"ok","approved":true}',
    '{"type":"answer","text":"ok","chat_id":1}',
    '{"type":"answer","text":"ok","buttons":[["Pay","x"]]}',
    '{"type":"proposal","effect_type":"send_email","params":{},"summary":"s"}',
    '{"type":"execute","what":"x"}',
    '{"type":"answer"}',
    '{"type":"answer","text":""}',
    '[1,2]',
    'not json',
])
def test_anything_off_shape_fails_closed(raw):
    with pytest.raises(schema.OutputError):
        schema.parse_output(raw, stage_at_least=at_least("S3"))


def test_no_effect_before_its_stage():
    raw = {"type": "proposal", "effect_type": "calendar_hold",
           "params": {"start": "2026-10-23T14:00:00-04:00", "duration_min": 60},
           "summary": "hold"}
    with pytest.raises(schema.OutputError):
        schema.parse_output(raw, stage_at_least=at_least("S1"))
    out = schema.parse_output(raw, stage_at_least=at_least("S2"))
    assert out.body["params"]["duration_min"] == 60


@pytest.mark.parametrize("params", [
    {"start": "2026-10-23T14:00:00-04:00", "duration_min": 60, "calendar": "primary"},
    {"start": "2026-10-23T14:00:00-04:00", "duration_min": 60, "title": "Board call"},
    {"start": "2026-10-23T14:00:00-04:00", "duration_min": 60, "attendees": ["x@y.z"]},
    {"start": "2026-10-23T14:00:00", "duration_min": 60},           # no timezone
    {"start": "2026-10-23T14:00:00-04:00", "duration_min": 5},      # too short
    {"start": "2026-10-23T14:00:00-04:00", "duration_min": 600},    # too long
    {"start": "2026-10-23T14:00:00-04:00", "duration_min": True},
    {"start": "tomorrow", "duration_min": 60},
    {"duration_min": 60},
])
def test_the_model_cannot_choose_where_what_or_who(params):
    raw = {"type": "proposal", "effect_type": "calendar_hold", "params": params,
           "summary": "hold"}
    with pytest.raises(schema.OutputError):
        schema.parse_output(raw, stage_at_least=at_least("S3"))


def test_unknown_effect_is_impossible():
    with pytest.raises(effects.ParamError):
        effects.lookup("buy_something", at_least("S3"))


# -- rendering -------------------------------------------------------------------

def test_model_links_are_defanged_and_html_escaped():
    t = render.model_text("Re-consent here: https://evil.example/login <b>now</b> or acct.evil.example")
    assert "https://" not in t and "evil[.]example/login" in t
    assert "acct[.]evil[.]example" in t
    assert "<b>" not in t and "&lt;b&gt;" in t


def test_allowlisted_domains_stay_clickable():
    t = render.model_text("see https://calendar.google.com/x", ("google.com",))
    assert "https://calendar.google.com/x" in t


def test_long_answers_are_cut_and_say_so():
    t = render.answer("abcdef12-0000", "x" * 10000)
    assert len(t) <= render.TELEGRAM_LIMIT and "(cut to fit)" in t and "job abcdef12" in t


def test_card_comes_from_params_not_model_prose():
    d = effects.REGISTRY["calendar_hold"]
    card = render.proposal_card(d, {"start": "2026-10-23T14:00:00-04:00", "duration_min": 90},
                                tz="America/New_York",
                                expires=datetime(2026, 10, 23, 2, 0, tzinfo=timezone.utc),
                                job_id="abcdef12-1")
    assert "Fri Oct 23, 2:00 PM–3:30 PM EDT (90 min)" in card
    assert "Reserved" in card and "no attendees" in card and "Reversible." in card


def test_buttons_carry_only_opaque_tokens():
    [[a, d]] = render.proposal_buttons("N0nce-123")
    assert a == ("Approve", "a:N0nce-123") and d == ("Decline", "d:N0nce-123")


# -- rules --------------------------------------------------------------------------

def R(**kw):
    base = {"rule_type": "drafting", "scope": "draft", "field": "length",
            "value": "short", "literal": "keep drafts short"}
    base.update(kw)
    return base


def test_rule_saved_with_its_scope_stated(ledger):
    o = rules.propose(ledger, R(), job_id=None)
    assert o.status == "active" and o.message == "Saved for draft jobs: length = short."


def test_same_scope_supersedes_and_undo_restores(ledger):
    first = rules.propose(ledger, R(value="short"), job_id=None)
    second = rules.propose(ledger, R(value="very short"), job_id=None)
    assert second.status == "superseded_previous"
    active = [r["id"] for r in rules.active_for(ledger, "draft")]
    assert active == [second.rule_id]
    rules.undo(ledger, second.rule_id)
    assert [r["id"] for r in rules.active_for(ledger, "draft")] == [first.rule_id]


def test_overlapping_conflict_is_quarantined_not_guessed(ledger):
    specific = rules.propose(ledger, R(scope="draft", value="short"), job_id=None)
    general = rules.propose(ledger, R(scope="all", value="long"), job_id=None)
    assert general.status == "quarantined" and general.conflicts_with == (specific.rule_id,)
    assert [r["value"] for r in rules.active_for(ledger, "draft")] == ["short"]
    rules.resolve(ledger, general.rule_id, "new")
    assert [r["value"] for r in rules.active_for(ledger, "draft")] == ["long"]


def test_same_value_across_scopes_is_not_a_conflict(ledger):
    rules.propose(ledger, R(scope="draft", value="short"), job_id=None)
    o = rules.propose(ledger, R(scope="all", value="short"), job_id=None)
    assert o.status == "active"


@pytest.mark.parametrize("field", ["approval_mode", "effect_scope", "calendar",
                                   "recipients", "budget", "send_without_asking",
                                   "api_key", "policy", "pay_limit", "not_a_field"])
def test_rules_can_never_touch_authority(ledger, field):
    with pytest.raises(rules.RuleError):
        rules.propose(ledger, R(field=field), job_id=None)


def test_rule_shape_is_closed(ledger):
    with pytest.raises(rules.RuleError):
        rules.propose(ledger, R(execute="yes"), job_id=None)
    with pytest.raises(rules.RuleError):
        rules.propose(ledger, R(scope="email_send"), job_id=None)


# -- digest ---------------------------------------------------------------------------

NOW = datetime(2026, 10, 21, 11, 0, tzinfo=timezone.utc)
FRESH = [digest.InputCoverage("calendar", NOW - timedelta(minutes=20), timedelta(hours=2))]


def compose(**kw):
    base = dict(now=NOW, tz="America/New_York", inputs=FRESH, waiting=[], failures=[],
                low_balance=[], canary_ok=True,
                config_unchanged_since=datetime(2026, 10, 20, tzinfo=timezone.utc))
    base.update(kw)
    return digest.compose(**base)


def test_clear_only_with_evidence():
    d = compose()
    assert d.state == "clear"
    assert d.text.startswith("Clear · inputs fresh · 0 need you · 0 failures")


@pytest.mark.parametrize("kw, expect", [
    ({"canary_ok": None}, "canary: did not run"),
    ({"canary_ok": False}, "canary: failed"),
    ({"inputs": [digest.InputCoverage("calendar", None, timedelta(hours=2))]},
     "calendar: no successful read yet"),
    ({"inputs": [digest.InputCoverage("calendar", NOW - timedelta(hours=5),
                                      timedelta(hours=2))]}, "calendar: stale since"),
    ({"failures": ["job 1a2b: model timed out"]}, "failed: job 1a2b"),
    ({"low_balance": ["anthropic $6 left"]}, "low balance: anthropic"),
    ({"config_unchanged_since": None}, "config: changed or unverified"),
])
def test_unknown_is_never_clear(kw, expect):
    d = compose(**kw)
    assert d.state == "attention" and expect in d.text and "Clear" not in d.text


def test_decision_lists_at_most_three_oldest_first():
    waits = [digest.Waiting(f"item {i}", NOW - timedelta(hours=i)) for i in range(1, 6)]
    d = compose(waiting=waits)
    assert d.state == "decision"
    lines = d.text.splitlines()
    assert lines[1].startswith("1. item 5") and "…and 2 more" in d.text


def test_digest_is_deterministic():
    assert compose().text == compose().text


# -- work-content filter ---------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "fw from jane.doe@salesforce.com about the QBR",
    "see https://acme.my.salesforce.com/lightning/r/Account",
    "attachment: DRMEncryptedDataSpace",
    "MSIP_Label_1234_Enabled=true",
])
def test_work_content_is_stopped(text):
    assert ingress_filter.check(text, work_domains=("salesforce.com",),
                                markers=Config(owner_user_id=1).work_markers)


@pytest.mark.parametrize("text", [
    "is the feed store open saturday?",
    "notsalesforce.com.example is a different domain",
    "my salesforcecareer notes",
])
def test_personal_content_passes(text):
    assert ingress_filter.check(text, work_domains=("salesforce.com",),
                                markers=Config(owner_user_id=1).work_markers) is None
