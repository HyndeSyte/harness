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
from .ledger import Ledger, _null, iso

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
    if len(data.encode("utf-8")) > 64:          # room for the "k:" prefix in a Discord custom_id
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


def mint(ledger: Ledger, *, proposal_id: str, owner_user_id: int, ttl_s: int, db=None) -> str:
    """A fresh nonce bound to one proposal. Its message id is bound after
    the card is sent (bind_message); until then no tap can match it."""
    row = (db or ledger.db).execute("SELECT * FROM proposals WHERE id=?",
                                    (proposal_id,)).fetchone()
    if row is None or row["state"] != "proposed":
        raise ValueError("no open proposal to approve")
    nonce = secrets.token_urlsafe(18)                     # 24 chars
    now = ledger.now()
    expires = min(now + timedelta(seconds=ttl_s),
                  datetime.fromisoformat(row["expires_at"]))
    with (ledger.tx() if db is None else _null(db)) as d:
        d.execute(
            "INSERT INTO approvals(nonce, proposal_id, owner_user_id, chat_id, message_id,"
            " params_hash, policy_version, created_at, expires_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (nonce, proposal_id, owner_user_id, owner_user_id, None,
             row["params_hash"], row["policy_version"], iso(now), iso(expires)))
    return nonce


def bind_message(ledger: Ledger, nonce: str, message_id: int) -> None:
    if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id <= 0:
        # A card that is not a real message can never be tapped.
        raise ValueError("not a real message id")
    with ledger.tx() as db:
        cur = db.execute("UPDATE approvals SET message_id=? WHERE nonce=? AND message_id IS NULL",
                         (message_id, nonce))
        if cur.rowcount != 1:
            raise ValueError("approval already bound or missing")


class _Lost(Exception):
    """The button was used up between the read and the write: nothing is kept."""


def verify_and_consume(ledger: Ledger, inc, *, owner_user_id: int,
                       policy_version: str) -> Verdict:
    try:
        return _verify_and_consume(ledger, inc, owner_user_id=owner_user_id, policy_version=policy_version)
    except _Lost:
        return Verdict(False, "already used")


def _verify_and_consume(ledger: Ledger, inc, *, owner_user_id: int,
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
            if a["outcome"] == "replaced":           # its card was replaced by a newer one
                return Verdict(False, "replaced", proposal_id=a["proposal_id"])
            if a["outcome"] == "updated":            # replaced when this version was installed
                return Verdict(False, "replaced_by_update", proposal_id=a["proposal_id"])
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
        if p is not None and p["state"] == "superseded":
            return Verdict(False, "replaced", proposal_id=p["id"])
        if p is None or p["state"] != "proposed":
            return Verdict(False, "proposal is no longer open", proposal_id=a["proposal_id"])
        params = json.loads(p["params_json"])
        if canonical_hash(params) != p["params_hash"] or p["params_hash"] != a["params_hash"]:
            return Verdict(False, "proposal changed after the card was shown",
                           proposal_id=p["id"])
        if p["policy_version"] != policy_version or a["policy_version"] != policy_version:
            return Verdict(False, "policy changed since the card was shown",
                           proposal_id=p["id"])
        # One compare-and-set on the proposal decides it (0.24.0, third round): his tap and a
        # newer card replacing this one (supersede_open) can't both win, nor two taps on one
        # proposal. Only the winner uses up the button.
        new_state = "approved" if action == "approve" else "declined"
        if db.execute("UPDATE proposals SET state=? WHERE id=? AND state='proposed'",
                      (new_state, p["id"])).rowcount != 1:
            return Verdict(False, "proposal is no longer open", proposal_id=p["id"])
        cur = db.execute(
            "UPDATE approvals SET consumed_at=?, consumed_update_id=?, outcome=?"
            " WHERE nonce=? AND consumed_at IS NULL",
            (iso(now), inc.update_id, action, nonce))
        if cur.rowcount != 1:
            raise _Lost()                          # undone with the transaction: nothing moved
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


def supersede(ledger: Ledger, proposal_id: str, *, db, outcome: str = "replaced") -> bool:
    """One card replaced, by one compare-and-set on its proposal (0.24.0, third round): True when
    it was still open and is now replaced; False when his tap got there first (it's approved,
    declined, or being done), and then nothing about it changes. A replaced card's buttons are used
    up and come off (an "unbutton" in the outbox; a card not sent yet goes without them), and a tap
    on it is refused as replaced. Its request isn't moved: whoever replaces it does that."""
    if db.execute("UPDATE proposals SET state='superseded' WHERE id=? AND state='proposed'",
                  (proposal_id,)).rowcount != 1:
        return False
    now = iso(ledger.now())
    for a in db.execute("SELECT * FROM approvals WHERE proposal_id=? AND consumed_at IS NULL",
                        (proposal_id,)).fetchall():
        db.execute("UPDATE approvals SET consumed_at=?, outcome=? WHERE nonce=? AND consumed_at IS NULL",
                   (now, outcome, a["nonce"]))
        if a["message_id"]:
            ledger.enqueue(chat_id=a["chat_id"], kind="unbutton", text=str(a["message_id"]), db=db)
        else:
            for o in db.execute("SELECT id, binds_json FROM outbox WHERE state IN ('queued','held')"
                                " AND binds_json LIKE ?", (f'%{a["nonce"]}%',)).fetchall():
                db.execute("UPDATE outbox SET buttons_json=NULL, binds_json=NULL WHERE id=?", (o["id"],))
    ledger.event("proposal_replaced", {"proposal": proposal_id, "why": outcome}, db=db)
    return True


def supersede_open(ledger: Ledger, job_ids: list[str], *, db) -> int:
    """Every card still open for these requests is replaced (supersede, one at a time). How many."""
    if not job_ids:
        return 0
    marks = ",".join("?" * len(job_ids))
    rows = db.execute(f"SELECT id FROM proposals WHERE state='proposed' AND job_id IN ({marks})",
                      tuple(job_ids)).fetchall()
    return sum(1 for p in rows if supersede(ledger, p["id"], db=db))
