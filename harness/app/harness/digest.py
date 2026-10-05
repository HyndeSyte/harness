"""The daily digest: plain code, fixed time, fixed shape. No model.

It exists to prove function, not presence. A digest that says "Clear"
is a claim backed by evidence -- every input it depends on reported in
on time, nothing is waiting on him, nothing failed, the canary job made
it through the real model path. If any of that is unknown, the digest
says so. Unknown is never rendered as "nothing needs you."

Three states:
  Clear              inputs fresh · 0 need you · 0 failures
  Decision needed    at most three waiting items, oldest first
  Attention needed   a stale input, a failure, a dead canary, a low
                     balance -- each named, with since-when

After the state, today's calendar (S1): all-day items, then timed ones,
overlaps marked. A calendar not read today is said to be unread, never
shown as an empty day.

He is not the liveness monitor. If a digest does not arrive at all, the
external watchdog notices, not him.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .render import escape, model_text

MAX_ITEMS = 3
MAX_AGENDA = 12


@dataclass(frozen=True)
class InputCoverage:
    name: str
    last_success: datetime | None
    max_age: timedelta
    error: str = ""          # the last failure, said alongside "stale"


@dataclass(frozen=True)
class Agenda:
    """Today's calendar as read. `read` < `configured` means some
    calendars weren't read today; `read` == 0 means nothing is known."""
    occurrences: list
    unreadable: int
    read: int
    configured: int
    labels: bool = False     # name the calendar on each line (several calendars)


@dataclass(frozen=True)
class Waiting:
    summary: str
    since: datetime


@dataclass(frozen=True)
class Digest:
    state: str           # "clear" | "decision" | "attention"
    text: str
    facts: dict = field(default_factory=dict)


def _ago(now: datetime, then: datetime) -> str:
    s = int((now - then).total_seconds())
    if s < 3600:
        return f"{max(1, s // 60)}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def compose(*, now: datetime, tz: str, inputs: list[InputCoverage],
            waiting: list[Waiting], failures: list[str],
            low_balance: list[str], canary_ok: bool | None,
            config_unchanged_since: datetime | None,
            canary_notes: list[str] = (), notes: list[str] = (),
            agenda: Agenda | None = None) -> Digest:
    local = ZoneInfo(tz)
    problems: list[str] = []
    for c in sorted(inputs, key=lambda c: c.name):
        why = f" ({c.error})" if c.error else ""
        if c.last_success is None:
            problems.append(f"{c.name}: no successful read yet{why}")
        elif now - c.last_success > c.max_age:
            when = c.last_success.astimezone(local).strftime("%a %-I:%M %p")
            problems.append(f"{c.name}: stale since {when}{why}")
    if agenda is not None and agenda.read < agenda.configured:
        problems.append(f"calendar: {agenda.configured - agenda.read} of {agenda.configured} "
                        "not read today")
    if agenda is not None and agenda.unreadable:
        problems.append(f"calendar: {agenda.unreadable} event(s) I couldn't read; "
                        "check the calendar itself")
    if canary_ok is None:
        problems.append("canary: did not run")
    elif canary_ok is False:
        problems += list(canary_notes) or ["canary: failed"]
    problems += [f"failed: {f}" for f in failures]
    problems += list(notes)
    problems += [f"low balance: {b}" for b in low_balance]
    if config_unchanged_since is None:
        problems.append("config: changed or unverified")

    waits = sorted(waiting, key=lambda w: w.since)
    shown = waits[:MAX_ITEMS]
    more = len(waits) - len(shown)
    wait_lines = [f"{i}. {escape(w.summary)} (waiting {_ago(now, w.since)})"
                  for i, w in enumerate(shown, 1)]
    if more > 0:
        wait_lines.append(f"…and {more} more")

    facts = {"problems": len(problems), "waiting": len(waits),
             "failures": len(failures)}
    tail: list[str] = []
    if agenda is not None and agenda.configured:
        tail = [""] + agenda_lines(agenda, now=now, local=local)
        facts["events"] = len(agenda.occurrences)
        facts["calendars_read"] = agenda.read
    since = (config_unchanged_since.astimezone(local).strftime("%b %-d")
             if config_unchanged_since else "unverified")

    if problems:
        body = ["<b>Attention needed</b>"] + [f"• {escape(p)}" for p in problems]
        if wait_lines:
            body += ["", f"<b>Waiting on you ({len(waits)})</b>"] + wait_lines
        return Digest("attention", "\n".join(body + tail), facts)
    if waits:
        body = [f"<b>Decision needed</b> · {len(waits)} waiting"] + wait_lines
        return Digest("decision", "\n".join(body + tail), facts)
    text = (f"Clear · inputs fresh · 0 need you · 0 failures · "
            f"config unchanged since {since}")
    return Digest("clear", "\n".join([text] + tail), facts)


def _t(dt: datetime, local: ZoneInfo) -> str:
    return dt.astimezone(local).strftime("%-I:%M %p")


def _short(label: str) -> str:
    name = label.split("@", 1)[0] if "@" in label else label
    return name[:20]


def agenda_lines(a: Agenda, *, now: datetime, local: ZoneInfo) -> list[str]:
    """Plain code, no model. Unknown is never rendered as an empty day."""
    head = "<b>Today</b>"
    if a.read < a.configured:
        head += f" · from {a.read} of {a.configured} calendars"
    if a.read == 0:
        return [head, "Calendar not read today, so I can't say what's on it."]
    if not a.occurrences:
        return [head, "Nothing on the calendar." if a.read == a.configured
                else "Nothing on the calendars I could read."]
    day_start = datetime.combine(now.astimezone(local).date(), datetime.min.time(),
                                 tzinfo=local)
    timed = [o for o in a.occurrences if not o.all_day]
    clash: set[int] = set()
    busy = [(i, o) for i, o in enumerate(timed) if not o.transparent and o.end > o.start]
    for x in range(len(busy)):
        for y in range(x + 1, len(busy)):
            (i, p), (j, q) = busy[x], busy[y]
            if p.start < q.end and q.start < p.end:
                clash.update((i, j))
    lines = []
    for o in [o for o in a.occurrences if o.all_day]:
        lines.append(f"All day · {model_text(o.summary)}" +
                     (f" · {model_text(_short(o.calendar))}" if a.labels else ""))
    for i, o in enumerate(timed):
        if o.start < day_start:
            when = f"until {_t(o.end, local)}"
        elif o.end.astimezone(local).date() > day_start.date() and o.end > o.start:
            when = f"{_t(o.start, local)} to {o.end.astimezone(local):%a} {_t(o.end, local)}"
        elif o.end <= o.start:
            when = _t(o.start, local)
        else:
            when = f"{_t(o.start, local)}–{_t(o.end, local)}"
        line = f"{when} {model_text(o.summary)}"
        if a.labels:
            line += f" · {model_text(_short(o.calendar))}"
        if i in clash:
            line += " ⚠ overlaps"
        lines.append(line)
    shown = lines[:MAX_AGENDA]
    if len(lines) > MAX_AGENDA:
        shown.append(f"…and {len(lines) - MAX_AGENDA} more")
    return [head] + shown
