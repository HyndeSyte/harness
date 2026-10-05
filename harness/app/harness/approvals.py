"""Approvals: a tap authorizes exactly one card, once.

Callback data is not authority -- any client can send arbitrary callback
data. A tap counts only if ALL of these hold, checked by code:

  * the nonce exists, was minted by the controller, and is unconsumed;
  * it has not expired;
  * the tap came from his user id, in his private chat;
  * it was pressed on the very message the card was sent as;
  * the proposal is still open, its parameters still hash to what the
    card showed, and the policy version has not changed since.

Consumption is atomic and happens BEFORE any remote call: the approval
is marked used, then the executor acts. A crash in between leaves an
approved-but-unexecuted effect for the reconciler, never a second
execution. Typed text ("yes", "/approve 12") and model output can never
create or consume an approval; only this module can, and only from a
callback.
"""
from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from .canonical import canonical_hash, canonical_json
from .ledger import Ledger, iso

ACTIONS = {"a": "approve", "d": "decline"}
_PREFIX = {v: k for k, v in ACTIONS.items()}


@dataclass(frozen=True)
class Verdict:
    ok: bool
    reason: str
    action: str | None = None
    proposal_id: str | None = None


def callback_data(action: str, nonce: str) -> str:
    data = f"{_PREFIX[action]}:{nonce}"
    if len(data.encode("utf-8")) > 64:          # Telegram's hard limit
        raise ValueError("callback_data over 64 bytes")
    return data


def parse_callback_data(data: str | None) -> tuple[str, str] | None:
    if not data or ":" not in data:
        return None
    prefix, nonce = data.split(":", 1)
    if prefix not in ACTIONS or not nonce or len(nonce) > 48:
        return None
    return ACTIONS[prefix], nonce


def create_proposal(ledger: Ledger, *, job_id: str, effect_type: str, params: dict,
                    policy_version: str, ttl_s: int, db=None) -> str:
    import uuid
    pid = str(uuid.uuid4())
    now = ledger.now()
    (db or ledger.db).execute(
        "INSERT INTO proposals(id, job_id, effect_type, params_json, params_hash,"
        " policy_version, state, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (pid, job_id, effect_type, canonical_json(params), canonical_hash(params),
         policy_version, "proposed", iso(now), iso(now + timedelta(seconds=ttl_s))))
    return pid


def mint(ledger: Ledger, *, proposal_id: str, owner_user_id: int, ttl_s: int) -> str:
    """A fresh nonce bound to one proposal. Its message id is bound after
    the card is sent (bind_message); until then no tap can match it."""
    row = ledger.db.execute("SELECT * FROM proposals WHERE id=?", (proposal_id,)).fetchone()
    if row is None or row["state"] != "proposed":
        raise ValueError("no open proposal to approve")
    nonce = secrets.token_urlsafe(18)                     # 24 chars
    now = ledger.now()
    expires = min(now + timedelta(seconds=ttl_s),
                  datetime.fromisoformat(row["expires_at"]))
    with ledger.tx() as db:
        db.execute(
            "INSERT INTO approvals(nonce, proposal_id, owner_user_id, chat_id, message_id,"
            " params_hash, policy_version, created_at, expires_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (nonce, proposal_id, owner_user_id, owner_user_id, None,
             row["params_hash"], row["policy_version"], iso(now), iso(expires)))
    return nonce


def bind_message(ledger: Ledger, nonce: str, message_id: int) -> None:
    if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id <= 0:
        # Telegram returns message_id 0 for ephemeral and scheduled
        # messages; a card that is not a real message can never be tapped.
        raise ValueError("not a real message id")
    with ledger.tx() as db:
        cur = db.execute("UPDATE approvals SET message_id=? WHERE nonce=? AND message_id IS NULL",
                         (message_id, nonce))
        if cur.rowcount != 1:
            raise ValueError("approval already bound or missing")


def verify_and_consume(ledger: Ledger, inc, *, owner_user_id: int,
                       policy_version: str) -> Verdict:
    """Check every binding, then consume the approval and move the
    proposal in one transaction. Returns why, whichever way it goes."""
    parsed = parse_callback_data(inc.callback_data)
    if parsed is None:
        return Verdict(False, "unrecognized callback")
    action, nonce = parsed
    if inc.user_id != owner_user_id or inc.chat_id != owner_user_id \
            or inc.chat_type != "private":
        return Verdict(False, "not his tap")
    now = ledger.now()
    with ledger.tx() as db:
        a = db.execute("SELECT * FROM approvals WHERE nonce=?", (nonce,)).fetchone()
        if a is None:
            return Verdict(False, "unknown approval")
        if a["consumed_at"] is not None:
            return Verdict(False, "already used", proposal_id=a["proposal_id"])
        if a["message_id"] is None or a["message_id"] != inc.message_id:
            return Verdict(False, "tap is not on the card it belongs to",
                           proposal_id=a["proposal_id"])
        if a["owner_user_id"] != owner_user_id or a["chat_id"] != inc.chat_id:
            return Verdict(False, "approval belongs to another chat")
        if datetime.fromisoformat(a["expires_at"]) <= now:
            _expire(ledger, db, a, now)
            return Verdict(False, "expired", proposal_id=a["proposal_id"])
        p = db.execute("SELECT * FROM proposals WHERE id=?", (a["proposal_id"],)).fetchone()
        if p is None or p["state"] != "proposed":
            return Verdict(False, "proposal is no longer open", proposal_id=a["proposal_id"])
        params = json.loads(p["params_json"])
        if canonical_hash(params) != p["params_hash"] or p["params_hash"] != a["params_hash"]:
            return Verdict(False, "proposal changed after the card was shown",
                           proposal_id=p["id"])
        if p["policy_version"] != policy_version or a["policy_version"] != policy_version:
            return Verdict(False, "policy changed since the card was shown",
                           proposal_id=p["id"])
        cur = db.execute(
            "UPDATE approvals SET consumed_at=?, consumed_update_id=?, outcome=?"
            " WHERE nonce=? AND consumed_at IS NULL",
            (iso(now), inc.update_id, action, nonce))
        if cur.rowcount != 1:
            return Verdict(False, "already used", proposal_id=p["id"])
        new_state = "approved" if action == "approve" else "declined"
        db.execute("UPDATE proposals SET state=? WHERE id=? AND state='proposed'",
                   (new_state, p["id"]))
        if action == "approve":
            ledger.transition(p["job_id"], "approved", db=db)
        else:
            ledger.transition(p["job_id"], "declined",
                              receipt="declined by his tap", db=db)
        ledger.event("approval", {"proposal": p["id"], "action": action,
                                  "update": inc.update_id}, db=db)
    return Verdict(True, action, action=action, proposal_id=p["id"])


def _expire(ledger: Ledger, db, a, now) -> None:
    db.execute("UPDATE approvals SET consumed_at=?, outcome='expired' WHERE nonce=?"
               " AND consumed_at IS NULL", (iso(now), a["nonce"]))
    p = db.execute("SELECT * FROM proposals WHERE id=?", (a["proposal_id"],)).fetchone()
    if p is not None and p["state"] == "proposed":
        db.execute("UPDATE proposals SET state='expired' WHERE id=?", (p["id"],))
        ledger.transition(p["job_id"], "expired",
                          receipt="expired before it was approved", db=db)
