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


# Twentieth round: the link's own label finder too, mirrored from cain/rootfs/opt/cain/gate/rules.ts (VERB,
# STATIC_LABELS, WITH_LABELS, named() and the button part of check(), with hidden()), so the outbox strips exactly
# what the link refuses: the wider verb list (choose, pick, select), a label after a line break ("Tap" at a line's
# end, the label on the next), quoted and bold labels, and every label the link knows, not only the ones a refusal
# named. tests/test_outbox_round20.py compares these with the link's source, and both suites run the shared cases
# in tests/imperative_cases.json.
VERB = "(?:[Tt]ap|[Tt]apping|[Pp]ress|[Pp]ressing|[Hh]it|[Cc]lick|[Cc]hoose|[Pp]ick|[Ss]elect)"
STATIC_LABELS = (
    "Ship", "Not now", "Stop", "Turn back on", "Start", "Open connector settings", "Do it", "I'll do it", "Drop it",
    "Approve", "Decline", "Undo", "Undo both", "Undo these", "Use new", "Keep old", "Not mine", "Wrong time",
    "Not this time", "Yes", "No", "Depends", "All of it", "Part of it", "Skip", "Keep rule", "Drop rule",
    "Turn on", "None wrong: stop checking", "Something was off: keep checking", "Do it now",
)
WITH_LABELS = (
    "Undo", "Undo both", "Undo these", "Not mine", "Wrong time", "Not this time", "Turn back on", "Not now",
    "Use new", "Keep old", "Keep rule", "Drop rule", "All of it", "Part of it", "None wrong: stop checking",
    "Something was off: keep checking", "Open connector settings",
)
HIDE = "\u0000"


def hidden(text: str) -> str:
    """The link's hidden(text): link targets, code and bare links covered in place (same length, new lines kept)."""
    t = list(text)

    def cover(a: int, b: int) -> None:
        for i in range(a, b):
            if t[i] != "\n":
                t[i] = HIDE
    for m in re.finditer(r"\]\([^)\s]*\)", text):
        cover(m.start() + 1, m.end())
    for pat in (r"```[\s\S]*?```", r"`[^`\n]+`", r"<?https?://[^\s<>()]+>?"):
        for m in re.finditer(pat, text):
            cover(m.start(), m.end())
    return "".join(t)


def named(seen: str, label: str) -> list[tuple[int, int, int, int]]:
    """The link's named(seen, label): each place the label is named as a button, as (match start, match end,
    label start, label end), the first form to find a label's start keeping it."""
    lab = re.escape(label)
    forms = [
        re.compile(r"(?<![A-Za-z])" + VERB + r"\s+(?:(?:on\s+)?the\s+|on\s+)?" + Q + "(" + lab + ")" + Q
                   + r"(?![A-Za-z0-9])"),
        re.compile(r"(?<![A-Za-z0-9])" + Q + "(" + lab + ")" + Q + r"\s+[Bb]uttons?\b"),
    ]
    if label in WITH_LABELS:
        forms.append(re.compile(r"(?<![A-Za-z])[Ww]ith\s+(?:the\s+)?" + Q + "(" + lab + ")" + Q
                                + r"(?![A-Za-z0-9])"))
    out, starts = [], set()
    for rx in forms:
        for m in rx.finditer(seen):
            if m.start(1) not in starts:
                starts.add(m.start(1))
                out.append((m.start(), m.end(), m.start(1), m.end(1)))
    return out


def refused_spans(text: str, carried, known=()) -> list[tuple[int, int, str]]:
    """What the link refuses a specialist's card for (core.ts addCard with check()'s button rule): every known label
    (STATIC_LABELS and `known`, longest first, spans never overlapping) named as a button the card doesn't carry
    (`carried`), in an imperative position. Each as (start, end, label), start..end covering the verb (or "button")
    and the label."""
    t = str(text or "")
    seen = hidden(t)
    has = {str(x) for x in carried or ()}
    labels = sorted({str(x).strip() for x in (*STATIC_LABELS, *(known or ())) if str(x).strip()},
                    key=lambda x: -len(x))
    taken: list[tuple[int, int]] = []
    out = []
    for label in labels:
        for a, b, at, end in named(seen, label):
            if any(x < end and at < y for x, y in taken):
                continue
            taken.append((at, end))
            if label in has:
                continue
            if imperative(t, at, end):
                out.append((min(a, at), max(b, end), label))
    return sorted(out)


# A sentence ends at ".", "!" or "?", a closing bold or italic tag after it kept with it (twentieth round: "<b>Done.</b>
# Tap ..." is two sentences, so a head in bold isn't lost with the sentence after it).
SENTENCE_END = re.compile(r"(?<=[.!?])\s+|(?<=[.!?]</b>)\s+|(?<=[.!?]</i>)\s+")


def strip_button_words(text: str, labels: list[str], carried=()) -> str:
    """The card's text with every sentence the link would refuse it for taken out (refused_spans, read across line
    breaks, against every label the link knows and the refusal's own `labels`), keeping its lines, so what's left
    says what happened without pointing at a button that isn't there. A sentence that merely holds the words ("we'll
    go ahead with it", "undo this later") stays."""
    segs: list[tuple[int, str]] = []            # (line number, sentence), in order
    lines = text.split("\n")
    for n, line in enumerate(lines):
        for x in SENTENCE_END.split(line):
            segs.append((n, x))
    plain, spans = "", []
    for i, (n, x) in enumerate(segs):
        if i:
            plain += "\n" if segs[i - 1][0] != n else " "
        a = len(plain)
        plain += _plain(x)
        spans.append((a, len(plain)))
    hits = refused_spans(plain, carried, known=labels)
    drop = {i for i, (a, b) in enumerate(spans) for x, y, _ in hits if x < max(b, a + 1) and a < y}
    out = []
    for n, line in enumerate(lines):
        keep = [x for i, (ln, x) in enumerate(segs) if ln == n and i not in drop]
        if keep or not line.strip():
            out.append(" ".join(keep))
    return "\n".join(out).strip()


def _head(text: str) -> str:
    """A card's first line, its required fact: what it's about (its bold head, or its first sentence)."""
    first = next((x for x in (text or "").split("\n") if x.strip()), "")
    return _plain(SENTENCE_END.split(first)[0]).strip()


class Outbox:
    def __init__(self, ledger: Ledger, api, *, sleep: Callable[[float], None] = time.sleep,
                 tz: str = "America/New_York"):
        self.ledger = ledger
        self.api = api
        self.sleep = sleep
        self.tz = ZoneInfo(tz)

    # Twentieth round: the fixed card for a refusal: fixed words only, no quoted message and nothing the model or a
    # calendar wrote, checked in tests against every label the link knows (refused_spans), so it can't be refused.
    TEMPLATE_HEAD = "<b>An update from Harness</b>, written {when}."
    TEMPLATE_BODY = "Harness has an update on this; its full words couldn't be shown here."
    TEMPLATE_JOB = "It's about a message of yours."

    # Twenty-first round: what happened, in one of a few pre-vetted phrases chosen by the card's outcome (an enum,
    # Ledger.OUTCOMES, set when it was queued), never its own words. Each is in tests/imperative_cases.json, which
    # both suites check against the link's filter.
    TEMPLATE_OUTCOMES = {"done": "What it was about is done.",
                         "not_done": "What it was about isn't done.",
                         "unverified": "Harness couldn't verify how it went."}

    def _outcome(self, row) -> str:
        try:
            got = self.ledger.get_meta(f"outbox_outcome:{row['id']}")
        except Exception:                       # noqa: BLE001: no outcome read: the template says none
            return ""
        return self.TEMPLATE_OUTCOMES.get(got or "", "")

    def _template(self, row) -> str:
        """Twentieth round: the fixed card posted when a refused card's stripped words would lose its head, leave
        nothing, or are refused again: when it was written, whether it's about a message of his, and that its full
        words couldn't be shown, all fixed text. The card keeps its own buttons. Twenty-first round: with what
        happened (TEMPLATE_OUTCOMES) when the card carries an outcome; each use is logged and recorded."""
        when = datetime.fromisoformat(row["created_at"]).astimezone(self.tz).strftime("%a %-I:%M %p")
        outcome = self._outcome(row)
        log.warning("a card went as the fixed template (outcome: %s)", outcome and "given" or "none")
        if not self.ledger.fenced:
            try:
                self.ledger.event("outbox_template", {"outbox": row["id"], "outcome": bool(outcome)})
            except Exception:                   # noqa: BLE001: the card still goes
                pass
        return "\n".join(x for x in (self.TEMPLATE_HEAD.format(when=when),
                                      self.TEMPLATE_JOB if row["job_id"] else "", outcome,
                                      self.TEMPLATE_BODY) if x)

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
            carried = [str(b[0]) for r in (buttons or []) for b in r]
            stripped = strip_button_words(text, labels, carried)
            head = _head(text)
            templated = not stripped.strip() or bool(head and head not in _plain(stripped))
            text = render.fit(self._template(row) if templated else stripped)
            log.error("Cain's link refused a card for naming %s; it goes %s", ", ".join(labels),
                      "as a fixed template" if templated else "without those words")
            if not self.ledger.fenced:
                self.ledger.event("link_refused_card", {"outbox": row["id"], "labels": labels[:5],
                                                        "said": e.description[:200], "template": bool(templated)})
            try:
                mid = self._deliver(row["chat_id"], text, buttons, row["kind"], self._expires(binds))
            except ChatError as e2:
                again = refused_labels(e2)
                if not again or templated:
                    self._failed(row, e2)
                    return False
                # Twentieth round: refused a second time (it named a label the first refusal didn't): the fixed
                # template goes, its buttons kept, never a dead card.
                log.error("Cain's link refused the card again for naming %s; it goes as a fixed template",
                          ", ".join(again))
                if not self.ledger.fenced:
                    self.ledger.event("link_refused_card", {"outbox": row["id"], "labels": again[:5],
                                                            "said": e2.description[:200], "template": True,
                                                            "second": True})
                try:
                    mid = self._deliver(row["chat_id"], render.fit(self._template(row)), buttons, row["kind"],
                                        self._expires(binds))
                except ChatError as e3:
                    self._failed(row, e3)
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
