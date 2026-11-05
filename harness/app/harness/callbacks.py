"""Button taps. Two kinds, two prefixes, two tables -- never confused.

  a:/d:<nonce>  approve or decline a proposed effect (approvals.py)
  c:<nonce>     a choice (choices.py); only a Family calendar Undo reaches the world

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
                 settings_fn: Callable[[str, str], str] | None = None, family_add=None,
                 calendar_change=None):
        self.calendar_change = calendar_change   # calendar_change.CalendarChange, or None
        self.ledger = ledger
        self.api = api
        self.owner = owner_user_id
        self.policy_version = policy_version
        self.settings_fn = settings_fn     # (change_id, "approve"|"decline") -> message
        self.family_add = family_add       # family_add.FamilyAdd, or None

    def handle(self, inc) -> str:
        """Returns what happened, for tests and the event log."""
        nonce = choices.parse(inc.callback_data)
        if nonce is not None and self.family_add is not None \
                and choices.kind_of(self.ledger, nonce) == "family_add_loosen" \
                and self.family_add.stopped():
            # Nothing is consumed, so this same card still works after /resume.
            self._answer(inc, "Stopped. Nothing changed.")
            with self.ledger.tx() as db:
                self.ledger.enqueue(chat_id=inc.chat_id, kind="reply", db=db, text=(
                    "I'm stopped, so nothing changed and I didn't check the calendar. After "
                    "/resume, tap that card again."))
            return "stopped"
        if nonce is not None:
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
            if message:                    # a rule's own card has already said it
                self.ledger.enqueue(chat_id=inc.chat_id, kind="reply", text=render.fit(message),
                                    db=db)
            self.ledger.release_held(db=db)
        return "ok"

    def _apply_choice(self, kind: str, target: str) -> str:
        try:
            if kind == "rule_approve":
                return self._keep_rule(target)
            if kind == "rule_decline":
                return render.escape(rules.decline(self.ledger, target))
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
        if kind.startswith("family_add_") and self.family_add is not None:
            return self.family_add.on_choice(kind, target)   # plain text, no model words
        if kind == "calendar_change_undo" and self.calendar_change is not None:
            return self.calendar_change.on_choice(kind, target)
        return "Nothing changed."

    def _keep_rule(self, target: str) -> str:
        """His tap on a rule's card. It now behaves as a correction always has: an
        Undo button, or a question if it clashes."""
        with self.ledger.tx() as db:
            out = rules.confirm(self.ledger, target, db=db)
            if out.status == "quarantined":
                old = out.conflicts_with[0]
                new_n = choices.mint(self.ledger, kind="rule_keep_new", target=out.rule_id,
                                     chat_id=self.owner, ttl_s=rules.CARD_TTL_S, db=db)
                old_n = choices.mint(self.ledger, kind="rule_keep_old", target=out.rule_id,
                                     chat_id=self.owner, ttl_s=rules.CARD_TTL_S, db=db)
                self.ledger.enqueue(
                    chat_id=self.owner, kind="reply", db=db,
                    text=(f"That clashes with rule {render.escape(old)}. "
                          f"Use the new one ({render.escape(out.rule_id)}) or keep the old?"),
                    buttons=[[("Use new", choices.callback_data(new_n)),
                              ("Keep old", choices.callback_data(old_n))]],
                    binds=[{"type": "choice", "nonce": new_n}, {"type": "choice", "nonce": old_n}])
                return ""
            undo_n = choices.mint(self.ledger, kind="rule_undo", target=out.rule_id,
                                  chat_id=self.owner, ttl_s=rules.CARD_TTL_S, db=db)
            self.ledger.enqueue(
                chat_id=self.owner, kind="reply", db=db,
                text=render.fit(render.family_text(out.message)
                                + f" <i>({render.escape(out.rule_id)})</i>"),
                buttons=[[("Undo", choices.callback_data(undo_n))]],
                binds=[{"type": "choice", "nonce": undo_n}])
        return ""

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
