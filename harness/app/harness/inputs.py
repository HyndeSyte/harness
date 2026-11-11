"""When something the Harness works from stops, he hears it (Nov 11).

From Nov 8 to Nov 11 Gmail refused the Harness's app password (changing his Google password
revoked it), and nothing said so: no dates or addresses came from his mail, the failed reads went
unlogged, and the digest named only the calendar feeds. Now:

- Each input's tries are kept in the ledger (`inputs`): the last success, the last failure and
  its kind, and the outage, which runs from a failure to the next success.
- A key turned down (Gmail's app password, Family's app-specific password, the Google service
  key): he is told at once, once an outage, with the fix he can do from his phone.
- Any other failure (no answer, an engine that won't answer): told once an outage, after six
  hours with no success. A refusal later in the same outage is still told: it needs him.
- The morning digest names every input with no success since its last error, and one line says
  which of the ones he knew about came back since the last digest. No separate "it's back".

A message has no buttons, since there's nothing to decide. It goes out at once through Cain's
link, like his other alerts (the "input" kind, discord_chat.py), and says times as he reads
them, never stamps or ids. Plain code, no model.

The clients (google_cal.py, caldav.py) can be called from worker threads, so what they see goes
through `Seen`, and the controller writes it down on its own thread (`Watch.drain`).
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

from . import render
from .ledger import Ledger, iso

log = logging.getLogger("harness.inputs")

MAIL, FAMILY, GOOGLE, MEANING = "mail", "family", "google", "meaning"
FEED = "calendar:"                 # one per calendar address: calendar:<feed id>
OK, REFUSED = "ok", "refused"      # REFUSED: a key or password turned down
AFTER = timedelta(hours=6)         # any other failure: told after this long with no success
KIND = "input"                     # its outbox kind: straight out, no buttons (discord_chat.py)


@dataclass(frozen=True)
class Spec:
    title: str             # the message's first line
    stopped: str           # what hasn't happened, said before "since"
    cost: str              # what it costs him
    fix: str = ""          # a refusal: what he can do about it, from his phone
    name: str = ""         # in the digest


SPECS = {
    MAIL: Spec(
        "Harness can't read your email",
        "No email has been read",
        "Dates and addresses from your email aren't being added.",
        "To fix it from your phone: make a new app password at "
        "https://myaccount.google.com/apppasswords named Harness, then paste it into the Harness "
        "page in Home Assistant, in the Gmail mail field, and approve the card that follows.",
        "Email from Gmail"),
    FAMILY: Spec(
        "Harness can't reach the Family calendar",
        "The Family calendar hasn't been read or changed",
        "Copies of your events to Family, blocks on your Gmail calendar from Family, and adds you "
        "ask for wait until it works.",
        "To fix it from your phone: make a new app-specific password at https://account.apple.com "
        "(Sign-In and Security, then App-Specific Passwords) named Harness, then paste it into the "
        "Harness page in Home Assistant, in the Family calendar app-specific password field, and "
        "approve the card that follows.",
        "Family calendar through iCloud"),
    GOOGLE: Spec(
        "Harness can't change your Gmail calendar",
        "Harness hasn't been able to change your Gmail calendar",
        "Blocks from Family, dates from your email and changes you ask for aren't reaching it.",
        "To fix it from your phone's browser: in Google Cloud console "
        "(https://console.cloud.google.com), open IAM and admin, then Service accounts, pick the one "
        "Harness uses, then Keys, Add key, Create new key, JSON. Paste the whole file into the "
        "Harness page in Home Assistant, in the Gmail calendar key field, and approve the card that "
        "follows.",
        "Gmail calendar through Google"),
    MEANING: Spec(
        "Harness can't judge Family events",
        "No Family event has been judged",
        "New and changed Family events aren't being judged.",
        name="Judging Family events"),
}
FEED_SPEC = Spec("Harness can't read one of your calendars", "The calendar {label} hasn't been read",
                 "Its events may be out of date in the digest, and in copies and blocks made from it.")
# What he can do about a failure that isn't a refusal, by its kind.
ADVICE = {
    "engine": "Harness keeps trying. If it goes on, check the Anthropic account's billing, or put a "
              "new Anthropic API key on the Harness page.",
    "limit": "It picks up again when the monthly limit resets.",
    "denied": "To fix it: in Google Calendar on the web, open your calendar's settings, Share with "
              "specific people, and give {account} \"Make changes and see all event details\".",
}
KEEPS_TRYING = "Harness keeps trying, and the morning digest will say when it works again."


def since(t: datetime, now: datetime, tz: str) -> str:
    """When, as he reads it: 4:53 PM today, 4:53 PM yesterday, Sun Nov 8 at 4:53 PM."""
    zone = ZoneInfo(tz)
    local, today = t.astimezone(zone), now.astimezone(zone).date()
    clock = render.clock_words(local, suffix=True)
    if local.date() == today:
        return f"{clock} today"
    if local.date() == today - timedelta(days=1):
        return f"{clock} yesterday"
    return f"{render.date_words(local.date(), today)} at {clock}"


def down(row) -> bool:
    """In an outage: failed since its last success (or never succeeded)."""
    return bool(row["failing_since"] and row["last_error_at"]
                and (not row["last_success_at"] or row["last_error_at"] > row["last_success_at"]))


class Seen:
    """What the clients saw, from any thread: the last answer for each input, until the
    controller writes it down on its own (Watch.drain). A client with none says nothing."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last: dict[str, tuple[str, str]] = {}

    def __call__(self, name: str, kind: str = OK, words: str = "") -> None:
        with self._lock:
            self._last[name] = (kind, words)

    def take(self) -> dict[str, tuple[str, str]]:
        with self._lock:
            out, self._last = self._last, {}
        return out


class Watch:
    """The controller's side: writes down what was seen, tells him, and gives the digest its lines.
    `active`: {input: is it set up now}; `feeds`: [(input, label)] for each calendar address set up.
    An input that isn't set up any more is never told or named."""

    def __init__(self, ledger: Ledger, seen: Seen | None = None, *, tz: str,
                 active: dict[str, Callable[[], bool]] | None = None,
                 feeds: Callable[[], list[tuple[str, str]]] = lambda: [],
                 account: Callable[[], str] = lambda: ""):
        self.ledger = ledger
        self.seen = seen
        self.tz = tz
        self.active = active or {}
        self.feeds = feeds
        self.account = account             # the service account's address, to share with again

    def drain(self) -> None:
        for name, (kind, words) in (self.seen.take() if self.seen is not None else {}).items():
            if kind == OK:
                self.ledger.input_ok(name)
            else:
                self.ledger.input_failed(name, words, kind)

    def watched(self) -> dict[str, str]:
        """{input: its label} for what's set up now."""
        out: dict[str, str] = {}
        for name, on in self.active.items():
            try:
                if on():
                    out[name] = ""
            except Exception:                      # can't say: left out this time, asked again next
                continue
        for name, label in self.feeds():
            out[name] = label
        return out

    def _down(self) -> list[tuple[sqlite3.Row, str]]:
        """Those set up and in an outage. Asked every tick: with none down, one small read."""
        rows = [r for r in self.ledger.inputs().values() if down(r)]
        if not rows:
            return []
        watched = self.watched()
        return [(r, watched[r["name"]]) for r in rows if r["name"] in watched]

    def tell(self, chat_id: int) -> int:
        """Each outage he hasn't heard about, once: a refusal at once, anything else after six
        hours with no success. Returns how many were told."""
        now = self.ledger.now()
        told = 0
        for row, label in self._down():
            if row["kind"] == REFUSED:
                if row["told_kind"] == REFUSED:
                    continue
                what = REFUSED
            elif row["told_at"] or now - datetime.fromisoformat(row["failing_since"]) < AFTER:
                continue
            else:
                what = "other"
            with self.ledger.tx() as db:
                self.ledger.enqueue(chat_id=chat_id, kind=KIND, text=self.message(row, label, now), db=db)
                db.execute("UPDATE inputs SET told_at=?, told_kind=? WHERE name=?",
                           (iso(now), what, row["name"]))
            log.info("input %s: told him it stopped (%s)", row["name"], what)
            told += 1
        return told

    def _spec(self, name: str) -> Spec:
        return FEED_SPEC if name.startswith(FEED) else SPECS[name]

    def _since(self, row, now: datetime) -> str:
        """Since it last worked; one that never has, since its first failure."""
        return since(datetime.fromisoformat(row["last_success_at"] or row["failing_since"]), now, self.tz)

    def message(self, row, label: str, now: datetime) -> str:
        spec = self._spec(row["name"])
        stopped = spec.stopped.format(label=render.escape(label))
        why = render.escape(row["last_error"] or "it failed")
        advice = spec.fix if row["kind"] == REFUSED and spec.fix else ADVICE.get(row["kind"], KEEPS_TRYING)
        if row["kind"] == "denied":
            advice = advice.format(account=render.escape(self.account() or "the service account Harness uses"))
        return render.no_dashes(f"<b>{spec.title}</b>\n{stopped} since {self._since(row, now)}: {why}. "
                                f"{spec.cost}\n\n{advice}")

    # -- the morning digest ------------------------------------------------------------------
    def digest_lines(self) -> list[str]:
        """Each input with no success since its last error, plainly. A calendar address has its
        own line already (digest.InputCoverage)."""
        now = self.ledger.now()
        return [f"{self._spec(row['name']).name}: not working since {self._since(row, now)}; "
                f"{row['last_error'] or 'it failed'}"
                for row, _ in self._down() if not row["name"].startswith(FEED)]

    def back_line(self) -> str:
        """One line for those he knew were down (told, or named in a digest) that came back."""
        now = self.ledger.now()
        rows = self.ledger.inputs()
        back = []
        for name, label in self.watched().items():
            row = rows.get(name)
            if row is None or not row["back_at"] or down(row):
                continue
            what = f"Calendar {label}" if name.startswith(FEED) else self._spec(name).name
            back.append(f"{what} since {since(datetime.fromisoformat(row['back_at']), now, self.tz)}")
        return f"Working again: {'; '.join(back)}." if back else ""

    def digest_sent(self) -> None:
        """The digest went out: what it named as down is known to him, and what came back is said."""
        names = [row["name"] for row, _ in self._down()]
        with self.ledger.tx() as db:
            db.executemany("UPDATE inputs SET named=1 WHERE name=?", [(n,) for n in names])
            db.execute("UPDATE inputs SET back_at=NULL WHERE back_at IS NOT NULL")
