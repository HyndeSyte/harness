"""Delivering what the controller decided to say.

Everything he receives goes through the outbox: written in the same
transaction as the job state it reports, then sent here, in order, with
retries. Cards and choice buttons are bound to the message id Telegram
returns -- after the send, never before -- so a button can only ever
match the exact message it was sent on. If the process dies between the
send and the bind, the buttons simply never work (fail closed) and the
offer expires; nothing is ever approved by accident.
"""
from __future__ import annotations

import html
import json
import logging
import re
import time
from datetime import datetime, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

from . import approvals, choices, render
from .ledger import Ledger, LedgerError, iso
from .telegram_api import TelegramError

log = logging.getLogger("harness.outbox")

SPACING_S = 1.1        # Telegram: about one message per second per chat
DELAYED_AFTER_S = 600  # a reply this late says so


def _backoff(attempts: int) -> float:
    return min(600.0, 5.0 * (2 ** max(0, min(attempts, 12) - 1)))


def _plain(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text))


class Outbox:
    def __init__(self, ledger: Ledger, api, *, sleep: Callable[[float], None] = time.sleep,
                 tz: str = "America/New_York"):
        self.ledger = ledger
        self.api = api
        self.sleep = sleep
        self.tz = ZoneInfo(tz)

    def flush(self, *, limit: int = 20) -> int:
        """Send what is due. Returns how many were delivered."""
        sent = 0
        for row in self.ledger.due_outbox()[:limit]:
            if sent:
                self.sleep(SPACING_S)
            if self._send(row):
                sent += 1
        return sent

    def _send(self, row) -> bool:
        buttons = json.loads(row["buttons_json"]) if row["buttons_json"] else None
        if buttons:
            buttons = [[tuple(b) for b in r] for r in buttons]
        text = row["text"]
        written = datetime.fromisoformat(row["created_at"])
        if (self.ledger.now() - written).total_seconds() > DELAYED_AFTER_S and \
                row["kind"] != "digest":
            # He should know this isn't fresh: say when it was written.
            when = written.astimezone(self.tz).strftime("%a %-I:%M %p")
            text = render.fit(f"<i>Delayed: written {when}.</i>\n" + text)
        try:
            mid = self._deliver(row["chat_id"], text, buttons)
        except TelegramError as e:
            self._failed(row, e)
            return False
        now = self.ledger.now()
        binds = json.loads(row["binds_json"]) if row["binds_json"] else []
        with self.ledger.tx() as db:
            db.execute("UPDATE outbox SET state='sent', sent_at=?, message_id=?,"
                       " attempts=attempts+1, last_error=NULL WHERE id=?",
                       (iso(now), mid, row["id"]))
            try:
                self.ledger.record_outbound(chat_id=row["chat_id"], message_id=mid,
                                            kind=row["kind"], text=row["text"],
                                            job_id=row["job_id"], db=db)
            except LedgerError:
                # message id 0: nothing can bind to it; leave the buttons dead
                binds = []
                self.ledger.event("unbindable_message", {"outbox": row["id"]}, db=db)
        for b in binds:
            try:
                if b["type"] == "approval":
                    approvals.bind_message(self.ledger, b["nonce"], mid)
                elif b["type"] == "choice":
                    choices.bind(self.ledger, b["nonce"], mid)
            except (ValueError, LedgerError) as e:
                self.ledger.event("bind_failed", {"outbox": row["id"], "error": str(e)[:100]})
        return True

    def _deliver(self, chat_id: int, text: str, buttons) -> int:
        try:
            return self.api.send_message(chat_id, text, buttons)
        except TelegramError as e:
            # Every character is escaped by render, so a markup error means
            # a bug there. Deliver it plainly rather than not at all.
            if e.code == 400 and "parse" in e.description.lower():
                self.ledger.event("html_fallback", {"error": e.description[:100]})
                return self.api.send_message(chat_id, _plain(text), buttons, html=False)
            raise

    def _failed(self, row, e: TelegramError) -> None:
        attempts = row["attempts"] + 1
        now = self.ledger.now()
        if e.retryable:
            # An outage delays a reply; it never loses one. Only a refusal
            # that will never change (blocked bot, bad request) is final.
            wait = max(e.retry_after or 0, _backoff(attempts))
            with self.ledger.tx() as db:
                db.execute("UPDATE outbox SET attempts=?, last_error=?, not_before=?"
                           " WHERE id=?", (attempts, str(e)[:200],
                                           iso(now + timedelta(seconds=wait)), row["id"]))
            return
        with self.ledger.tx() as db:
            db.execute("UPDATE outbox SET state='dead', attempts=?, last_error=? WHERE id=?",
                       (attempts, str(e)[:200], row["id"]))
            self.ledger.event("delivery_failed", {"outbox": row["id"], "kind": row["kind"],
                                                  "error": str(e)[:200]}, db=db)
        log.warning("message %s undeliverable: %s", row["id"], e)
