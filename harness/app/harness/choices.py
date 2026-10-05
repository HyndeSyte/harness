"""Choices: taps that change no part of the world.

Undoing a rule, picking a side in a rule conflict, confirming a settings
change made on the add-on page: none of these is an effect, but each is
still a decision only he may make. They get the same binding an approval
gets -- his account, his private chat, the exact message the buttons were
sent on, unexpired, single use -- in their own table and with their own
callback prefix, so a choice can never be confused with an approval.

One tap per card: consuming any button on a message consumes all of its
siblings, so "keep new" and "keep old" cannot both happen.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from .ledger import Ledger, iso

KINDS = frozenset({"rule_undo", "rule_keep_new", "rule_keep_old",
                   "settings_approve", "settings_decline"})
PREFIX = "c"


@dataclass(frozen=True)
class ChoiceVerdict:
    ok: bool
    reason: str
    kind: str | None = None
    target: str | None = None


def callback_data(nonce: str) -> str:
    data = f"{PREFIX}:{nonce}"
    if len(data.encode("utf-8")) > 64:
        raise ValueError("callback_data over 64 bytes")
    return data


def parse(data: str | None) -> str | None:
    if not data or not data.startswith(PREFIX + ":"):
        return None
    nonce = data[len(PREFIX) + 1:]
    if not nonce or len(nonce) > 48:
        return None
    return nonce


def mint(ledger: Ledger, *, kind: str, target: str, chat_id: int, ttl_s: int,
         db=None) -> str:
    if kind not in KINDS:
        raise ValueError(f"unknown choice kind {kind!r}")
    nonce = secrets.token_urlsafe(18)
    now = ledger.now()
    (db or ledger.db).execute(
        "INSERT INTO choices(nonce, kind, target, chat_id, message_id, created_at,"
        " expires_at) VALUES(?,?,?,?,?,?,?)",
        (nonce, kind, target, chat_id, None, iso(now), iso(now + timedelta(seconds=ttl_s))))
    return nonce


def bind(ledger: Ledger, nonce: str, message_id: int) -> None:
    if not isinstance(message_id, int) or message_id <= 0:
        raise ValueError("not a real message id")
    with ledger.tx() as db:
        cur = db.execute("UPDATE choices SET message_id=? WHERE nonce=? AND message_id IS NULL",
                         (message_id, nonce))
        if cur.rowcount != 1:
            raise ValueError("choice already bound or missing")


def verify_and_consume(ledger: Ledger, inc, *, owner_user_id: int) -> ChoiceVerdict:
    nonce = parse(inc.callback_data)
    if nonce is None:
        return ChoiceVerdict(False, "unrecognized callback")
    if inc.user_id != owner_user_id or inc.chat_id != owner_user_id \
            or inc.chat_type != "private":
        return ChoiceVerdict(False, "not his tap")
    now = ledger.now()
    with ledger.tx() as db:
        c = db.execute("SELECT * FROM choices WHERE nonce=?", (nonce,)).fetchone()
        if c is None:
            return ChoiceVerdict(False, "unknown choice")
        if c["consumed_at"] is not None:
            return ChoiceVerdict(False, "already used")
        if c["message_id"] is None or c["message_id"] != inc.message_id \
                or c["chat_id"] != inc.chat_id:
            return ChoiceVerdict(False, "tap is not on the card it belongs to")
        if datetime.fromisoformat(c["expires_at"]) <= now:
            return ChoiceVerdict(False, "expired")
        cur = db.execute(
            "UPDATE choices SET consumed_at=?, consumed_update_id=?"
            " WHERE chat_id=? AND message_id=? AND consumed_at IS NULL",
            (iso(now), inc.update_id, c["chat_id"], c["message_id"]))
        if cur.rowcount < 1:
            return ChoiceVerdict(False, "already used")
        ledger.event("choice", {"kind": c["kind"], "target": c["target"],
                                "update": inc.update_id}, db=db)
    return ChoiceVerdict(True, c["kind"], c["kind"], c["target"])
