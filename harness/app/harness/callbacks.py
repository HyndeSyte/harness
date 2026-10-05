"""Button taps. Two kinds, two prefixes, two tables -- never confused.

  a:/d:<nonce>  approve or decline a proposed effect (approvals.py)
  c:<nonce>     a choice that changes nothing in the world (choices.py)

Every tap is answered (his client shows a spinner until it is). A tap
that fails a binding check gets a short reason and changes nothing. A tap
that counts gets a message saying what happened, and its buttons are
removed so the card can't be tapped again.
"""
from __future__ import annotations

import logging
from typing import Callable

from . import approvals, choices, render, rules
from .ledger import Ledger
from .telegram_api import TelegramError

log = logging.getLogger("harness.callbacks")

REFUSALS = {
    "already used": "Already done.",
    "expired": "That offer expired.",
    "tap is not on the card it belongs to": "That button isn't valid here.",
    "unknown approval": "That button isn't valid any more.",
    "unknown choice": "That button isn't valid any more.",
    "proposal is no longer open": "That's no longer open.",
    "proposal changed after the card was shown": "That changed after you saw it; not done.",
    "policy changed since the card was shown": "The rules changed since; not done.",
}


class Callbacks:
    def __init__(self, ledger: Ledger, api, *, owner_user_id: int, policy_version: str,
                 settings_fn: Callable[[str, str], str] | None = None):
        self.ledger = ledger
        self.api = api
        self.owner = owner_user_id
        self.policy_version = policy_version
        self.settings_fn = settings_fn     # (change_id, "approve"|"decline") -> message

    def handle(self, inc) -> str:
        """Returns what happened, for tests and the event log."""
        if choices.parse(inc.callback_data) is not None:
            v = choices.verify_and_consume(self.ledger, inc, owner_user_id=self.owner)
            if not v.ok:
                self._answer(inc, REFUSALS.get(v.reason, "Not valid."))
                return v.reason
            message = self._apply_choice(v.kind, v.target)
        else:
            v = approvals.verify_and_consume(self.ledger, inc, owner_user_id=self.owner,
                                             policy_version=self.policy_version)
            if not v.ok:
                self._answer(inc, REFUSALS.get(v.reason, "Not valid."))
                return v.reason
            message = ("Approved. It will run now." if v.action == "approve"
                       else "Declined. Nothing was done.")
        self._answer(inc, None)
        self._strip_buttons(inc)
        with self.ledger.tx() as db:
            self.ledger.enqueue(chat_id=inc.chat_id, kind="reply", text=render.fit(message),
                                db=db)
            self.ledger.release_held(db=db)
        return "ok"

    def _apply_choice(self, kind: str, target: str) -> str:
        try:
            if kind == "rule_undo":
                return render.escape(rules.undo(self.ledger, target)) + \
                    f" <i>({render.escape(target)} retired)</i>"
            if kind == "rule_keep_new":
                return render.escape(rules.resolve(self.ledger, target, "new"))
            if kind == "rule_keep_old":
                return render.escape(rules.resolve(self.ledger, target, "old"))
        except rules.RuleError as e:
            return render.escape(f"Nothing changed: {e}.")
        if kind in ("settings_approve", "settings_decline") and self.settings_fn:
            return render.escape(self.settings_fn(
                target, "approve" if kind == "settings_approve" else "decline"))
        return "Nothing changed."

    def _answer(self, inc, text: str | None) -> None:
        try:
            self.api.answer_callback(inc.callback_id, text)
        except TelegramError as e:
            log.info("answerCallbackQuery failed: %s", e)

    def _strip_buttons(self, inc) -> None:
        try:
            self.api.edit_reply_markup(inc.chat_id, inc.message_id, None)
        except TelegramError as e:
            log.info("removing buttons failed: %s", e)
