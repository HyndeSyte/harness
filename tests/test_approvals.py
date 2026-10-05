"""A tap authorizes exactly one card, once -- and nothing else does."""
import pytest

from harness import approvals, telegram
from harness.ledger import LedgerError
from conftest import OWNER, cb, msg

POLICY = "p1"
PARAMS = {"start": "2026-10-23T14:00:00-04:00", "duration_min": 60}


def proposed_job(ledger):
    _, jobs = telegram.poll_once(_api([msg(1, "hold Friday 2pm")]), ledger, OWNER)
    jid = jobs[0]
    ledger.transition(jid, "running")
    with ledger.tx() as db:
        pid = approvals.create_proposal(ledger, job_id=jid, effect_type="calendar_hold",
                                        params=PARAMS, policy_version=POLICY,
                                        ttl_s=3600, db=db)
        ledger.transition(jid, "proposed", db=db)
    nonce = approvals.mint(ledger, proposal_id=pid, owner_user_id=OWNER, ttl_s=3600)
    approvals.bind_message(ledger, nonce, 777)
    return jid, pid, nonce


def _api(batch):
    from conftest import FakeAPI
    return FakeAPI([batch])


def tap(ledger, data, *, message_id=777, user=OWNER, chat=OWNER, update_id=100,
        chat_type="private"):
    inc = telegram.parse(cb(update_id, data, message_id=message_id, user=user,
                            chat=chat, chat_type=chat_type))
    return approvals.verify_and_consume(ledger, inc, owner_user_id=OWNER,
                                        policy_version=POLICY)


def test_his_tap_on_the_card_approves_once(ledger):
    jid, pid, nonce = proposed_job(ledger)
    v = tap(ledger, f"a:{nonce}")
    assert v.ok and v.action == "approve" and v.proposal_id == pid
    assert ledger.job(jid)["state"] == "approved"
    again = tap(ledger, f"a:{nonce}", update_id=101)
    assert not again.ok and again.reason == "already used"


def test_decline_closes_the_job_with_a_receipt(ledger):
    jid, _, nonce = proposed_job(ledger)
    assert tap(ledger, f"d:{nonce}").ok
    assert ledger.job(jid)["state"] == "declined"
    assert [r["kind"] for r in ledger.receipts(jid)] == ["declined"]


def test_approve_after_decline_is_refused(ledger):
    _, _, nonce = proposed_job(ledger)
    tap(ledger, f"d:{nonce}")
    assert tap(ledger, f"a:{nonce}", update_id=101).reason == "already used"


@pytest.mark.parametrize("kw, reason", [
    ({"user": 999}, "not his tap"),
    ({"chat": 999}, "not his tap"),
    ({"chat_type": "group"}, "not his tap"),
    ({"message_id": 778}, "tap is not on the card it belongs to"),
])
def test_a_tap_from_anywhere_else_is_refused(ledger, kw, reason):
    jid, _, nonce = proposed_job(ledger)
    v = tap(ledger, f"a:{nonce}", **kw)
    assert not v.ok and v.reason == reason
    assert ledger.job(jid)["state"] == "proposed"


@pytest.mark.parametrize("data", ["a:forged", "approve", "", None, "x:abc", "a:",
                                  "a:" + "z" * 60])
def test_forged_or_malformed_callback_data_does_nothing(ledger, data):
    jid, _, _ = proposed_job(ledger)
    assert not tap(ledger, data).ok
    assert ledger.job(jid)["state"] == "proposed"


def test_unbound_card_cannot_be_approved(ledger):
    """Minted but the send never returned a message id (crash between):
    fails closed."""
    _, jobs = telegram.poll_once(_api([msg(1, "x")]), ledger, OWNER)
    jid = jobs[0]
    ledger.transition(jid, "running")
    with ledger.tx() as db:
        pid = approvals.create_proposal(ledger, job_id=jid, effect_type="calendar_hold",
                                        params=PARAMS, policy_version=POLICY, ttl_s=3600, db=db)
        ledger.transition(jid, "proposed", db=db)
    nonce = approvals.mint(ledger, proposal_id=pid, owner_user_id=OWNER, ttl_s=3600)
    assert tap(ledger, f"a:{nonce}").reason == "tap is not on the card it belongs to"


def test_expired_offer_cannot_be_approved_and_closes_with_receipt(ledger, clock):
    jid, _, nonce = proposed_job(ledger)
    clock.advance(hours=2)
    v = tap(ledger, f"a:{nonce}")
    assert not v.ok and v.reason == "expired"
    assert ledger.job(jid)["state"] == "expired"
    assert [r["kind"] for r in ledger.receipts(jid)] == ["expired"]


def test_params_changed_after_the_card_was_shown(ledger):
    jid, pid, nonce = proposed_job(ledger)
    ledger.db.execute("UPDATE proposals SET params_json=? WHERE id=?",
                      ('{"duration_min":480,"start":"2026-10-23T14:00:00-04:00"}', pid))
    v = tap(ledger, f"a:{nonce}")
    assert not v.ok and v.reason == "proposal changed after the card was shown"
    assert ledger.job(jid)["state"] == "proposed"


def test_policy_change_voids_open_cards(ledger):
    _, _, nonce = proposed_job(ledger)
    inc = telegram.parse(cb(100, f"a:{nonce}", message_id=777))
    v = approvals.verify_and_consume(ledger, inc, owner_user_id=OWNER, policy_version="p2")
    assert not v.ok and v.reason == "policy changed since the card was shown"


def test_callback_data_fits_telegram(ledger):
    _, _, nonce = proposed_job(ledger)
    for action in ("approve", "decline"):
        assert len(approvals.callback_data(action, nonce).encode()) <= 64


def test_typed_yes_is_just_a_message(ledger):
    """No path from text to an approval: a 'yes' is a new job, and the
    proposal stays open."""
    jid, _, _ = proposed_job(ledger)
    _, jobs = telegram.poll_once(_api([msg(2, "yes, approve it")]), ledger, OWNER)
    assert ledger.job(jobs[0])["kind"] == "message"
    assert ledger.job(jid)["state"] == "proposed"
    assert ledger.db.execute(
        "SELECT COUNT(*) FROM approvals WHERE consumed_at IS NOT NULL").fetchone()[0] == 0


def test_bind_is_once(ledger):
    _, _, nonce = proposed_job(ledger)
    with pytest.raises(ValueError):
        approvals.bind_message(ledger, nonce, 999)


def test_terminal_states_need_receipts(ledger):
    _, jobs = telegram.poll_once(_api([msg(1, "x")]), ledger, OWNER)
    ledger.transition(jobs[0], "running")
    with pytest.raises(LedgerError):
        ledger.transition(jobs[0], "answered")
    with pytest.raises(LedgerError):
        ledger.transition(jobs[0], "executed", receipt="nope")


@pytest.mark.parametrize("data", ["a:", "d:", "a:" + "z" * 49, "q:abc", "abc", None])
def test_callback_data_parser_rejects_junk_before_any_lookup(data):
    assert approvals.parse_callback_data(data) is None


def test_callback_data_parser_reads_a_real_token():
    assert approvals.parse_callback_data("a:" + "z" * 24) == ("approve", "z" * 24)
