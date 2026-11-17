"""Delivering what the controller decided to say.

Everything he receives goes through the outbox: written in the same
transaction as the job state it reports, then sent here, in order, with
retries. Cards and choice buttons are bound to the message id the chat
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
from .chat import ChatError
from .ledger import Ledger, LedgerError, iso

log = logging.getLogger("harness.outbox")

SPACING_S = 1.1        # about one message per second
DELAYED_AFTER_S = 600  # a reply this late says so


def _backoff(attempts: int) -> float:
    return min(600.0, 5.0 * (2 ** max(0, min(attempts, 12) - 1)))


def _plain(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text))


# Eighteenth round: Cain's link refuses a card that tells him to use a button it doesn't carry, with this reason
# (cain/rootfs/opt/cain/link/core.ts): `the card names "Go ahead", which it doesn't carry`.
_LINK_REFUSED = re.compile(r"the card names (.+), which it doesn't carry")


def refused_labels(e: ChatError) -> list[str]:
    """The button labels a link refusal names, or [] when the error isn't that refusal."""
    if getattr(e, "code", 0) != 400:
        return []
    m = _LINK_REFUSED.search(e.description or "")
    return re.findall(r'"([^"]{1,60})"', m.group(1)) if m else []


# Nineteenth round: the link's own imperative patterns, mirrored exactly from cain/rootfs/opt/cain/gate/rules.ts
# (Q, IMPERATIVE_BEFORE, IMPERATIVE_AFTER; tests/test_outbox_round19.py compares the sources and runs the shared
# cases in tests/imperative_cases.json, which cain/tests/imperative-cases.test.ts runs through the link's own code).
# A label is told to be used when the words right before it are "tap", "press", "click" or "hit" (or their -ing
# forms, "on" and "the" allowed between), or the word right after it is "button"; quotes or bold markup around it.
Q = "[\"\u201c\u201d'\u2018\u2019*_]*"
IMPERATIVE_BEFORE = re.compile(r"(?<![A-Za-z])(?:tap|tapping|press|pressing|click|clicking|hit|hitting)\s+(?:on\s+)?"
                               r"(?:the\s+)?" + Q + r"$", re.I)
IMPERATIVE_AFTER = re.compile(r"^" + Q + r"\s+buttons?(?![A-Za-z])", re.I)


def imperative(text: str, at: int, end: int) -> bool:
    """The link's imperative(): whether the label at text[at:end] is told to be used."""
    t = str(text or "")
    return bool(IMPERATIVE_BEFORE.search(t[:at]) or IMPERATIVE_AFTER.search(t[end:]))


def tells_to_use(text: str, label: str) -> bool:
    """Whether `text` (plain words) tells him to use the button `label`: an occurrence of the label, as a whole
    word, in an imperative position (imperative)."""
    for m in re.finditer(r"(?<![A-Za-z0-9])" + re.escape(label) + r"(?![A-Za-z0-9])", text or ""):
        if imperative(text, m.start(), m.end()):
            return True
    return False


def strip_button_words(text: str, labels: list[str]) -> str:
    """The card's text with every sentence that tells him to use one of `labels` taken out, line by line, so what's
    left says what happened without pointing at a button that isn't there. Nineteenth round: only a sentence that
    matches the link's own imperative patterns (tells_to_use) goes; a sentence that merely mentions the words ("we'll
    go ahead with it", "undo this later") stays."""
    out = []
    for line in text.split("\n"):
        parts = re.split(r"(?<=[.!?])\s+", line)
        keep = [x for x in parts if not any(tells_to_use(_plain(x), label) for label in labels)]
        if keep or not line.strip():
            out.append(" ".join(keep))
    return "\n".join(out).strip()


def _head(text: str) -> str:
    """A card's first line, its required fact: what it's about (its bold head, or its first sentence)."""
    first = next((x for x in (text or "").split("\n") if x.strip()), "")
    return _plain(re.split(r"(?<=[.!?])\s+", first)[0]).strip()


class Outbox:
    def __init__(self, ledger: Ledger, api, *, sleep: Callable[[float], None] = time.sleep,
                 tz: str = "America/New_York"):
        self.ledger = ledger
        self.api = api
        self.sleep = sleep
        self.tz = ZoneInfo(tz)

    def _template(self, row, stripped: str, labels: list[str]) -> str:
        """Nineteenth round: the fixed card for a refusal that left nothing usable: what it's about (his message,
        quoted, when it's for one), when it was written, and the outcome (what's left of its words, or that its
        full words couldn't be shown). Nothing in it can tell him to use a button."""
        what = ""
        if row["job_id"]:
            asked = " ".join(self.ledger.job_text(row["job_id"]).split())[:120]
            if asked and not any(tells_to_use(asked, x) for x in labels):
                what = f"About your message \u201c{render.escape(asked)}\u201d."
        when = datetime.fromisoformat(row["created_at"]).astimezone(self.tz).strftime("%a %-I:%M %p")
        outcome = stripped.strip() or "Harness has an update on this; its full words couldn't be shown here."
        return "\n".join(x for x in (f"<b>An update from Harness</b>, written {when}.", what, outcome) if x)

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
        if row["kind"] in ("unbutton", "rebutton"):
            return self._unbutton(row)
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
        binds = json.loads(row["binds_json"]) if row["binds_json"] else []
        if binds and self.ledger.fenced:
            # Fifteenth round: no card with buttons goes out while a staged restore fences the records, so no
            # button is ever left unbound. It stays queued; at the next unfenced start it's sent and bound as
            # usual (the fence is engaged and lifted only on the controller's thread, which also runs this).
            return False
        try:
            mid = self._deliver(row["chat_id"], text, buttons, row["kind"], self._expires(binds))
        except ChatError as e:
            labels = refused_labels(e)
            if not labels:
                self._failed(row, e)
                return False
            # Eighteenth round: the link refused it for naming a button it doesn't carry. Not dead: it goes once
            # more as plain words with those sentences taken out, its own buttons kept, and the refusal is
            # recorded here (the link writes its gate-report entry), so the relay's "logged for a fix" holds.
            # Nineteenth round: only the sentences matching the link's own imperative patterns go; if nothing is
            # left, or the card's head (its required fact) went with them, a fixed template from its structured
            # fields goes instead (_template), its buttons kept.
            stripped = strip_button_words(text, labels)
            head = _head(text)
            templated = not stripped.strip() or bool(head and head not in _plain(stripped))
            text = render.fit(self._template(row, stripped, labels) if templated else stripped)
            log.error("Cain's link refused a card for naming %s; it goes %s", ", ".join(labels),
                      "as a fixed template" if templated else "without those words")
            if not self.ledger.fenced:
                self.ledger.event("link_refused_card", {"outbox": row["id"], "labels": labels[:5],
                                                        "said": e.description[:200], "template": bool(templated)})
            try:
                mid = self._deliver(row["chat_id"], text, buttons, row["kind"], self._expires(binds))
            except ChatError as e2:
                self._failed(row, e2)
                return False
        now = self.ledger.now()
        # Fourteenth round: the delivery marks are exempt from a staged restore's fence (the restart card goes
        # out and isn't sent twice). Fifteenth round: through the ledger's outbox-only method.
        with self.ledger.outbox_tx() as db:
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

    def _unbutton(self, row) -> bool:
        """A card replaced by a newer one (approvals.supersede_open): its buttons come off. Its
        approval is already used up, so a tap that beats this is refused anyway."""
        buttons = json.loads(row["buttons_json"]) if row["kind"] == "rebutton" and row["buttons_json"] else None
        if buttons:
            buttons = [[tuple(b) for b in r] for r in buttons]
        try:
            self.api.edit_reply_markup(row["chat_id"], int(row["text"]), buttons)
        except ChatError as e:
            self._failed(row, e)
            return False
        except ValueError:
            pass
        with self.ledger.outbox_tx() as db:
            db.execute("UPDATE outbox SET state='sent', sent_at=?, attempts=attempts+1, last_error=NULL"
                       " WHERE id=?", (iso(self.ledger.now()), row["id"]))
        return True

    def _expires(self, binds: list) -> str | None:
        """When a card's buttons lapse: the last of its own approvals and choices to expire, so
        Cain's link can take them off then (Cain 0.7.0; an older link ignores it). None for a
        card with no buttons of its own, or one whose expiry can't be read."""
        ends = []
        for b in binds:
            table = {"approval": "approvals", "choice": "choices"}.get(b.get("type"))
            row = self.ledger.db.execute(f"SELECT expires_at FROM {table} WHERE nonce=?",
                                         (b.get("nonce"),)).fetchone() if table else None
            if row is None:
                return None
            ends.append(datetime.fromisoformat(row["expires_at"]))
        return max(ends).isoformat() if ends else None

    def _deliver(self, chat_id: int, text: str, buttons, kind: str | None = None,
                 expires: str | None = None) -> int:
        lapse = {"expires": expires} if expires else {}
        try:
            return self.api.send_message(chat_id, text, buttons, kind=kind, **lapse)
        except ChatError as e:
            # Every character is escaped by render, so a markup error means
            # a bug there. Deliver it plainly rather than not at all.
            if e.code == 400 and "parse" in e.description.lower():
                if not self.ledger.fenced:
                    self.ledger.event("html_fallback", {"error": e.description[:100]})
                return self.api.send_message(chat_id, _plain(text), buttons, html=False, kind=kind, **lapse)
            raise

    def _failed(self, row, e: ChatError) -> None:
        attempts = row["attempts"] + 1
        now = self.ledger.now()
        if e.retryable:
            # An outage delays a reply; it never loses one. Only a refusal
            # that will never change (blocked bot, bad request) is final.
            wait = max(e.retry_after or 0, _backoff(attempts))
            with self.ledger.outbox_tx() as db:
                db.execute("UPDATE outbox SET attempts=?, last_error=?, not_before=?"
                           " WHERE id=?", (attempts, str(e)[:200],
                                           iso(now + timedelta(seconds=wait)), row["id"]))
            return
        with self.ledger.outbox_tx() as db:
            db.execute("UPDATE outbox SET state='dead', attempts=?, last_error=? WHERE id=?",
                       (attempts, str(e)[:200], row["id"]))
            self.ledger.event("delivery_failed", {"outbox": row["id"], "kind": row["kind"],
                                                  "error": str(e)[:200]}, db=db)
        log.warning("message %s undeliverable: %s", row["id"], e)
