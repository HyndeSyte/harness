"""When something the Harness works from stops, he hears it (Nov 11).

From Nov 8 to Nov 11 Gmail refused the Harness's app password (changing his Google password
revoked it), and nothing said so: no dates or addresses came from his mail, the failed reads went
unlogged, and the digest named only the calendar feeds. Now:

- Each input's tries are kept in the ledger (`inputs`): the last success, the last failure and its
  kind, and the outage, which runs from a failure to the next success, with how many failures and
  refusals were seen in it.
- What only he can fix (Gmail's app password, Family's app-specific password or the Google service
  key turned down, Gmail wanting a sign-in on the web, or his calendar not shared with Harness) is
  told at once from its second in an outage, so a stray refusal with a success after it never makes
  him replace a working password. He's told once an outage, with the fix he can do from his phone;
  a new key starts that over, its clock and counts too.
- Anything else is told once a failure is seen six hours or more after the first: a pause, a stop
  or a clock jump alone never does it. It's looked at on the quarter hour (:00, :15, :30, :45), and
  everything due then goes in one message, with whatever else has been unreachable for an hour or
  more: a home internet outage is one message.
- A message still waiting to go, never tried, says only what's still down: what came back is taken
  out of it, and nothing else in it changes; it's dropped once nothing it tells of is down. A message
  about one input alone is never rewritten.
- The morning digest names an input that has failed for an hour or twice, or that he was told
  about, and one line says which of the ones he knew about came back since the last digest. No
  separate "it's back".

A message has no buttons, since there's nothing to decide. It goes out at once through Cain's link,
like his other alerts (the "input" kind, discord_chat.py), and says times as he reads them, never
stamps, ids or codes. Plain code, no model.

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

from . import render
from .ledger import NEEDS_HIM, Ledger, iso, told

log = logging.getLogger("harness.inputs")

MAIL, FAMILY, GOOGLE, MEANING = "mail", "family", "google", "meaning"
FEED = "calendar:"                    # one per calendar address: calendar:<feed id>
OK, REFUSED, WEB, DENIED, UNREACHABLE = "ok", "refused", "web", "denied", "unreachable"
AFTER = timedelta(hours=6)            # anything else: told once a failure is seen this long after the first
NAMED_AFTER = timedelta(hours=1)      # the digest names one failing this long, or failed twice
QUARTER = 15                          # anything else is looked at on the quarter hour, in minutes
KIND = "input"                        # its outbox kind: straight out, no buttons (discord_chat.py)
# The vault's keys and the input each is for: a new one starts what he was told over.
KEYS = {"gmail_app_password": MAIL, "family_apple_id": FAMILY, "family_app_password": FAMILY,
        "family_calendar_url": FAMILY, "google_service_key": GOOGLE}
# How a new key gets in: the Harness page (setup_web.py), then his tap on its card (controller.py,
# SETTINGS_TTL_S), as each fix ends.
TAIL = (' In Home Assistant open Settings > Apps > Harness > Open Web UI. Under "Replace a key", paste '
        'it into "{field}" and save. Then confirm it on the card that follows, within 15 minutes.')
GMAIL_TAIL = TAIL.format(field="Gmail mail: app password")


@dataclass(frozen=True)
class Spec:
    title: str             # the message's first line
    stopped: str           # what hasn't happened, said before "since"
    cost: str              # what it costs him
    name: str              # in the digest
    fix: str = ""          # a refusal: what he can do about it, from his phone
    cause: str = ""        # a refused password: what turns it off


SPECS = {
    MAIL: Spec(
        "Harness can't read your email", "No email has been read",
        "Dates and addresses from your email aren't being added.", "Email from Gmail",
        fix="To fix it from your phone: make a new app password at "
            "https://myaccount.google.com/apppasswords and name it Harness, then copy it." + GMAIL_TAIL,
        cause="Changing your Google password turns it off."),
    FAMILY: Spec(
        "Harness can't reach the Family calendar", "The Family calendar hasn't been read or changed",
        "Copies of your events to Family, blocks on your Gmail calendar from Family, and adds you ask "
        "for wait until it works.", "Family calendar through iCloud",
        fix="To fix it from your phone: at https://account.apple.com open Sign-In and Security, then "
            "App-Specific Passwords, make one named Harness and copy it."
            + TAIL.format(field="Family calendar: app-specific password"),
        cause="Changing your Apple Account password turns it off."),
    GOOGLE: Spec(
        "Harness can't change your Gmail calendar",
        "Harness hasn't been able to change your Gmail calendar",
        "Blocks from Family, dates from your email and changes you ask for aren't reaching it.",
        "Gmail calendar through Google",
        fix="To fix it from your phone's browser: at https://console.cloud.google.com open IAM & Admin, "
            "then Service Accounts, then {account}, then Keys, Add key, Create new key, JSON. It "
            "downloads a file: open it, select all and copy."
            + TAIL.format(field="Gmail calendar: Google service account key")),
    MEANING: Spec(
        "Harness can't sort Family events", "No Family event has been sorted",
        "Blocks on your Gmail calendar for new or changed Family events wait until it works.",
        "Sorting Family events"),
}
FEED_SPEC = Spec("Harness can't read one of your calendars", "The calendar {label} hasn't been read",
                 "Its events may be out of date in the digest, and in copies and blocks made from it.",
                 "Calendar {label}")
UNNAMED = "One of your calendars"     # a calendar address not read under its own name yet
# What he can do, by the failure's kind, where it isn't a refused key (Spec.fix).
ADVICE = {
    WEB: "To fix it from your phone: sign in to Gmail in your browser once at https://mail.google.com . "
         "If it's still not working in an hour, make a new app password named Harness at "
         "https://myaccount.google.com/apppasswords and copy it." + GMAIL_TAIL,
    DENIED: "To fix it: open https://calendar.google.com in your phone's browser and switch to the "
            "desktop site. Open Settings, pick your calendar, then Shared with, Add people and groups. "
            "Add {account} and choose Make changes and see event details.",
    "engine": "Harness keeps trying. If it goes on, check Claude's billing at "
              "https://platform.claude.com/settings/billing . If that's fine, paste a new Anthropic API "
              "key on the Harness page (Settings > Apps > Harness > Open Web UI).",
    "limit": "It picks up again when the monthly limit resets.",
    "clock": "Restarting the Pi usually sets its clock right. In Home Assistant open Settings > System, "
             "tap the power button at the top right, then Advanced options, then Reboot system.",
}
KEEPS_TRYING = "Harness keeps trying, and the morning digest will say when it works again."


def down(row) -> bool:
    """In an outage: failed since its last success (or never succeeded)."""
    return bool(row["failing_since"] and row["last_error_at"]
                and (not row["last_success_at"] or row["last_error_at"] > row["last_success_at"]))


def seen_for(row) -> timedelta:
    """How long it has been seen failing: first failure to last, not the clock since the first."""
    return datetime.fromisoformat(row["last_error_at"]) - datetime.fromisoformat(row["failing_since"])


def worth_naming(row) -> bool:
    """Down, and not a single blip: failed twice or for an hour, or he was told."""
    return down(row) and (told(row) or row["failures"] >= 2 or seen_for(row) >= NAMED_AFTER)


class Seen:
    """What the clients saw, from any thread: the last answer for each input, until the
    controller writes it down on its own (Watch.drain). A client with none says nothing.
    Several answers between two ticks count as one: a run's calls are one look."""

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
    `active`: {input: is it set up now}; `feeds`: [(input, label)] for each calendar address set up,
    "" for one not read under its own name yet; `account`: the Google service account's address.
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
        self.account = account
        self._quarter: datetime | None = None      # the quarter hour anything else was last looked at

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

    def key_changed(self, field: str) -> None:
        """A new key for an input: what he was told about the old one no longer counts, so a refusal
        of the new one is told again from its second, and the outage's clock and counts start over,
        so one blip of the new key isn't told at once. That he knew stays known (`named`), so the
        digest still says when it works again. A message about the old key still waiting to go, never
        tried, is dropped, unless it tells of something else still down."""
        name = KEYS.get(field)
        if name is None:
            return
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            row = db.execute("SELECT * FROM inputs WHERE name=?", (name,)).fetchone()
            if row is None or row["failing_since"] is None:
                return
            knew = bool(row["named"])
            if told(row):
                box = db.execute("SELECT state, attempts FROM outbox WHERE id=?",
                                 (row["told_outbox"],)).fetchone() if row["told_outbox"] else None
                waiting = box is not None and box["state"] == "queued" and not box["attempts"]
                knew = knew or not waiting
                if waiting and db.execute(
                        "SELECT 1 FROM inputs WHERE told_outbox=? AND name<>? AND failing_since IS NOT NULL",
                        (row["told_outbox"], name)).fetchone() is None:
                    db.execute("UPDATE outbox SET state='dropped' WHERE id=?", (row["told_outbox"],))
            db.execute("UPDATE inputs SET failing_since=?, failures=0, refusals=0, told_at=NULL,"
                       " told_kind='', told_outbox=NULL, named=? WHERE name=?",
                       (now, 1 if knew else 0, name))
        log.info("input %s: a new key, so its outage starts over", name)

    def tell(self, chat_id: int) -> int:
        """Each outage he hasn't heard about, once. What only he can fix: from its second in the
        outage, at once. Anything else: on the quarter hour, once a failure is seen six hours after
        the first, all in one message with everything else that can't be reached. Then each message
        still waiting is said again for what's down now (refresh). Returns how many went."""
        now = self.ledger.now()
        sent = 0
        rows = self._down()
        due = []
        for row, label in rows:
            kinds = self._told(row)
            if row["kind"] in NEEDS_HIM:
                if row["refusals"] >= 2 and row["kind"] not in kinds:
                    self._send(chat_id, [(row, label)], row["kind"], now)
                    sent += 1
            elif not kinds and seen_for(row) >= AFTER:
                due.append((row, label))
        quarter = now.replace(minute=now.minute - now.minute % QUARTER, second=0, microsecond=0)
        if quarter != self._quarter:
            self._quarter = quarter
            if due:
                names = {r["name"] for r, _ in due}
                # Whatever else can't be reached, failing an hour or more too: the same outage, told
                # with it. A blip of a few minutes isn't.
                due += [(r, label) for r, label in rows if r["name"] not in names
                        and r["kind"] == UNREACHABLE and not self._told(r) and seen_for(r) >= NAMED_AFTER]
                self._send(chat_id, due, "other", now)
                sent += 1
        self.refresh(now)                  # after: a message that just took one over lets it go
        return sent

    @staticmethod
    def _told(row) -> set[str]:
        return set(row["told_kind"].split(",")) - {""} if told(row) else set()

    def _send(self, chat_id: int, group: list[tuple[sqlite3.Row, str]], what: str, now: datetime) -> None:
        with self.ledger.tx() as db:
            box = self.ledger.enqueue(chat_id=chat_id, kind=KIND, text=self.message(group, now), db=db)
            for row, _ in group:
                kinds = ",".join(sorted(self._told(row) | {what}))
                db.execute("UPDATE inputs SET told_at=?, told_kind=?, told_outbox=? WHERE name=?",
                           (iso(now), kinds, box, row["name"]))
        log.info("input %s: told him it stopped (%s)", ", ".join(r["name"] for r, _ in group), what)

    def refresh(self, now: datetime) -> None:
        """Each message still waiting to go, never tried, says only what is still down. What came back
        is taken out of it, its line and its own advice, and nothing else changes, so what he was
        told is never weakened: a refusal never becomes "Harness keeps trying". A message about one
        input alone is never rewritten (one that came back is dropped: Ledger._reached). One that
        tells of nothing still down is dropped."""
        waiting = self.ledger.db.execute("SELECT id, text FROM outbox WHERE kind=? AND state='queued'"
                                         " AND attempts=0", (KIND,)).fetchall()
        if not waiting:
            return
        rows = self.ledger.inputs()
        labels = self.watched()
        for box in waiting:
            group = [(r, labels.get(r["name"], "")) for r in rows.values()
                     if r["told_outbox"] == box["id"] and down(r) and told(r)]
            if not group:
                with self.ledger.tx() as db:
                    db.execute("UPDATE outbox SET state='dropped' WHERE id=? AND state='queued'"
                               " AND attempts=0", (box["id"],))
                continue
            text = self._without_the_rest(box["text"], group)
            if text != box["text"]:
                with self.ledger.tx() as db:
                    db.execute("UPDATE outbox SET text=? WHERE id=? AND state='queued' AND attempts=0",
                               (text, box["id"]))

    def _without_the_rest(self, text: str, group: list[tuple[sqlite3.Row, str]]) -> str:
        """A folded message with only the lines of those in `group`: their bullets and their own
        advice lines, as told. The title follows what's left; the rest stays as written."""
        lines = text.split("\n")
        if not any(line.startswith("• ") for line in lines):
            return text                                    # one input alone: never rewritten
        bullets = tuple(f"• {self._named(r['name'], label, self._spec(r['name']).stopped)} since "
                        for r, label in group)
        own = tuple(f"{self._spec(r['name']).name}: " for r, _ in group)
        theirs = tuple(f"{s.name}: " for s in SPECS.values())          # one input's own advice line
        kept = [line for line in lines[1:]
                if (line.startswith(bullets) if line.startswith("• ")
                    else line.startswith(own) if line.startswith(theirs) else True)]
        title = f"<b>{self._spec(group[0][0]['name']).title}</b>" if len(group) == 1 else lines[0]
        return "\n".join([title] + kept)

    # -- what he reads ---------------------------------------------------------------------
    def _spec(self, name: str) -> Spec:
        return FEED_SPEC if name.startswith(FEED) else SPECS[name]

    def _since(self, row, now: datetime) -> str:
        """Since it last worked; one that never has, since its first failure."""
        return render.since_words(datetime.fromisoformat(row["last_success_at"] or row["failing_since"]),
                                  now, self.tz)

    def _named(self, name: str, label: str, what: str) -> str:
        """A calendar address by its own name, defanged: anyone can name a calendar."""
        if not name.startswith(FEED):
            return what
        if not label:
            return UNNAMED if what.startswith("Calendar") else f"{UNNAMED} hasn't been read"
        return what.format(label=render.model_text(label))

    def _line(self, row, label: str, now: datetime) -> str:
        spec = self._spec(row["name"])
        why = render.escape(row["last_error"] or "it stopped working")
        cause = f" {spec.cause}" if row["kind"] == REFUSED and spec.cause and "password" in why else ""
        return (f"{self._named(row['name'], label, spec.stopped)} since {self._since(row, now)}: {why}."
                f"{cause} {spec.cost}")

    def _advice(self, row) -> str:
        spec = self._spec(row["name"])
        advice = spec.fix if row["kind"] == REFUSED and spec.fix else ADVICE.get(row["kind"], KEEPS_TRYING)
        return advice.replace("{account}", render.escape(self.account() or "the service account Harness uses"))

    def message(self, group: list[tuple[sqlite3.Row, str]], now: datetime) -> str:
        if len(group) == 1:
            row, label = group[0]
            return render.no_dashes(f"<b>{self._spec(row['name']).title}</b>\n{self._line(row, label, now)}"
                                    f"\n\n{self._advice(row)}")
        title = ("Harness can't reach a few things it uses" if all(r["kind"] == UNREACHABLE for r, _ in group)
                 else "A few things Harness uses have stopped working")
        body = "\n".join(f"• {self._line(row, label, now)}" for row, label in group)
        # Each input's own advice on its own line, starting with its name; "Harness keeps trying" once,
        # at the end.
        advice = []
        for row, label in group:
            said = self._advice(row)
            if said == KEEPS_TRYING:
                continue
            said = said.removeprefix("Harness keeps trying. ")
            line = f"{self._named(row['name'], label, self._spec(row['name']).name)}: {said[0].lower()}{said[1:]}"
            if line not in advice:
                advice.append(line)
        return render.no_dashes(f"<b>{title}</b>\n{body}\n\n" + "\n".join(advice + [KEEPS_TRYING]))

    # -- the morning digest ------------------------------------------------------------------
    def digest_lines(self) -> tuple[list[str], list[str]]:
        """(lines, inputs named): each input worth naming, as "{name}: not working since {when};
        {reason}". A calendar address has its own line already (digest.InputCoverage)."""
        now = self.ledger.now()
        lines, names = [], []
        for row, _ in self._down():
            if row["name"].startswith(FEED) or not worth_naming(row):
                continue
            lines.append(f"{self._spec(row['name']).name}: not working since {self._since(row, now)}; "
                         f"{row['last_error'] or 'it stopped working'}")
            names.append(row["name"])
        return lines, names

    def back_line(self) -> str:
        """One line for those he knew were down (told, or named in a digest) that came back."""
        now = self.ledger.now()
        rows = self.ledger.inputs()
        back = []
        for name, label in self.watched().items():
            row = rows.get(name)
            if row is None or not row["back_at"] or down(row):
                continue
            what = self._named(name, label, self._spec(name).name)
            back.append(f"{what} since {render.since_words(datetime.fromisoformat(row['back_at']), now, self.tz)}")
        return f"Working again: {'; '.join(back)}." if back else ""

    def digest_sent(self, named: tuple[str, ...] | list[str] = ()) -> None:
        """The digest went out: what it named is known to him now, and what came back has been said."""
        with self.ledger.tx() as db:
            db.executemany("UPDATE inputs SET named=1 WHERE name=? AND failing_since IS NOT NULL",
                           [(n,) for n in named])
            db.execute("UPDATE inputs SET back_at=NULL WHERE back_at IS NOT NULL")
