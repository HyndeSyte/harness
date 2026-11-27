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

That full text is Cain's (Digest.text, "detail" on keeper.sh digest). What
he sees on his phone is Digest.owner (0.24.5, Nov 27: "This digest is not
digestible"): the shape of Cain's Today section and nothing else. One line
per timed event, its start in bold; an event on two calendars said once;
all-day items on one small line; then at most three plain lines for a real
problem (a clash, a change that didn't go through, a calendar not read).

He is not the liveness monitor. If a digest does not arrive at all, the
external watchdog notices, not him.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .render import clock_words, escape, model_text, since_words, units



@dataclass(frozen=True)
class InputCoverage:
    name: str
    last_success: datetime | None
    max_age: timedelta
    error: str = ""          # the last failure, said with it
    failing: bool = False    # down, and not a single blip: named even before it's stale
    key: str = ""            # the ledger input it stands for, if any: Digest.named says it was named


@dataclass(frozen=True)
class Agenda:
    """Today's calendar as read. `read` < `configured` means some
    calendars weren't read today; `read` == 0 means nothing is known."""
    occurrences: list
    unreadable: int
    read: int
    configured: int
    labels: bool = False     # name the calendar on each line (several calendars)
    # Pairs of event uids Harness keeps a record of as one event on two calendars (its copies on
    # Family of his Gmail events): each a frozenset of two uids. Said once on his digest.
    pairs: frozenset = frozenset()
    name: str = ""           # his first name: "Dane - PT" on Family is his PT


@dataclass(frozen=True)
class Waiting:
    summary: str
    since: datetime


@dataclass(frozen=True)
class Digest:
    state: str           # "clear" | "decision" | "attention"
    text: str
    facts: dict = field(default_factory=dict)
    named: tuple = ()    # the ledger inputs it named as not working (inputs.Watch.digest_sent)
    owner: str = ""      # what he sees (owner_text); `text` is the full detail, Cain's alone


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
            agenda: Agenda | None = None, extra: list[str] = (),
            asked_failures: list[str] | None = None) -> Digest:
    """`extra`: informational lines appended after the agenda. They never
    count as a problem and never change the state (the mirror's shadow line).
    `asked_failures`: the changes he asked for that didn't go through, for his own
    digest (all of `failures` when not given); the rest of `failures` is Cain's."""
    local = ZoneInfo(tz)
    owner = owner_text(agenda, now=now, local=local,
                       failures=list(failures if asked_failures is None else asked_failures))
    problems: list[str] = []
    named: list[str] = []
    # One shape for every input (inputs.py too): "{name}: not working since {when}; {reason}".
    for c in sorted(inputs, key=lambda c: c.name):
        why = f"; {c.error}" if c.error else ""
        if c.last_success is None:
            problems.append(f"{c.name}: not read yet{why}")
        elif now - c.last_success > c.max_age or c.failing:
            problems.append(f"{c.name}: not working since {since_words(c.last_success, now, tz)}{why}")
        else:
            continue
        if c.key:
            named.append(c.key)
    if agenda is not None and agenda.read < agenda.configured:
        problems.append(f"calendar: {agenda.configured - agenda.read} of {agenda.configured} "
                        "not read today")
    if agenda is not None and agenda.unreadable:
        problems.append(f"calendar: {agenda.unreadable} event(s) I couldn't read, so they aren't "
                        "listed below")
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
    # Every one, never "and N more": a count he can't open is no use to him.
    wait_lines = [f"{i}. {escape(w.summary)} (waiting {_ago(now, w.since)})"
                  for i, w in enumerate(waits, 1)]

    facts = {"problems": len(problems), "waiting": len(waits),
             "failures": len(failures)}
    tail: list[str] = []
    if agenda is not None and agenda.configured:
        tail = [""] + agenda_lines(agenda, now=now, local=local)
        facts["events"] = len(agenda.occurrences)
        facts["calendars_read"] = agenda.read
    since = (config_unchanged_since.astimezone(local).strftime("%b %-d")
             if config_unchanged_since else "unverified")
    info = [escape(x) for x in extra if x]
    if info:
        tail += [""] + info

    if problems:
        body = ["<b>Attention needed</b>"] + [f"• {escape(p)}" for p in problems]
        if wait_lines:
            body += ["", f"<b>Waiting on you ({len(waits)})</b>"] + wait_lines
        return Digest("attention", "\n".join(body + tail), facts, tuple(named), owner)
    if waits:
        body = [f"<b>Decision needed</b> · {len(waits)} waiting"] + wait_lines
        return Digest("decision", "\n".join(body + tail), facts, tuple(named), owner)
    text = (f"Clear · inputs fresh · 0 need you · 0 failures · "
            f"config unchanged since {since}")
    return Digest("clear", "\n".join([text] + tail), facts, tuple(named), owner)


def _t(dt: datetime, local: ZoneInfo) -> str:
    return dt.astimezone(local).strftime("%-I:%M %p")


def _short(label: str) -> str:
    # An address's local part, dots as spaces: "first.last" would otherwise
    # be defanged into "first[.]last" as if it were a link.
    name = label.split("@", 1)[0].replace(".", " ") if "@" in label else label
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
    return [head] + lines                  # all of the day, never "and N more"


# -- his digest (0.24.5) -------------------------------------------------------------------------
# Nov 27, 7:47 AM, about the digest that went out on its own at 7:40: "This digest is not
# digestible." What he reads every day is Cain's Today section, so his digest is that shape:
#
#   **Today, Fri Nov 27**
#   • **8:00** PT
#   • **8:30** Coffee with Chris
#   • **1:00** Massage with Braden
#   -# All day: Aunt Cindy birthday, Off work
#
# then at most three plain lines for a real problem, each saying what to do. No status, no counts,
# no other days: all of that stays in Digest.text, for Cain.

OWNER_LIMIT = 1800          # what he sees, as Discord counts it
MAX_PROBLEMS = 3
TITLE_CUTS = (None, 48, 40, 32, 26, 20, 16, 12, 8)   # shorter titles first, never fewer events
_EM_DASH = re.compile(r"\s*—\s*")
# Words a "Dane - Off Work" title says in title case that read as plain words: "Off work".
COMMON = frozenset("""off work day appointment appt school pickup drop dropoff lunch dinner breakfast
    coffee call meeting run practice birthday visit class lesson shift game trip party out home
    errands drive time session check checkup cleaning""".split())


@dataclass(frozen=True)
class _Item:
    start: object
    end: object
    title: str
    busy: bool
    all_day: bool


def _bare(text: str) -> str:
    """Without emoji and the like: "Chris ☕️" -> "Chris"."""
    return "".join(ch for ch in text if unicodedata.category(ch) not in ("So", "Sk", "Cs", "Co", "Me")
                   and ch not in "️︎‍").strip()


def _words(text: str) -> set[str]:
    return set(re.findall(r"\w+", _bare(text).lower()))


def _own(title: str, name: str) -> str | None:
    """"Dane - PT" -> "PT" when his name is Dane (a Family event that is his); None otherwise."""
    if not name:
        return None
    m = re.match(rf"\s*{re.escape(name)}\s+[-–—]\s+(.+)$", title, re.I)
    return m.group(1).strip() if m and m.group(1).strip() else None


def _with(title: str, name: str) -> str | None:
    """"Dane + Chris ☕️" -> "Chris": his own event, with someone."""
    if not name:
        return None
    m = re.match(rf"\s*{re.escape(name)}\s*(?:\+|&|\band\b)\s*(.+)$", title, re.I)
    who = _bare(m.group(1)) if m else ""
    return who or None


def _plain_case(rest: str) -> str:
    words = rest.split(" ")
    return " ".join(w.lower() if k and w.lower() in COMMON and not w.isupper() else w
                    for k, w in enumerate(words))


def _clean(title: str, name: str) -> str:
    own = _own(title, name)
    return _EM_DASH.sub(", ", _plain_case(own) if own is not None else title.strip())


def _same(x, y, pairs: frozenset, name: str) -> bool:
    """One event on two calendars: a pair Harness keeps a record of (at the same start), or two
    with the same start and end on two calendars where one is "Dane - X" and the other says X, or is
    "Dane + someone", or they say the same words."""
    if x.uid and y.uid and frozenset((x.uid, y.uid)) in pairs and x.start == y.start:
        return True
    if x.start != y.start or x.end != y.end or x.calendar == y.calendar:
        return False                    # two on one calendar are two events
    if _words(x.summary) and _words(x.summary) == _words(y.summary):
        return True
    for a, b in ((x, y), (y, x)):
        rest = _own(a.summary, name)
        if rest is None or _own(b.summary, name) is not None:
            continue
        if (_words(rest) and _words(rest) <= _words(b.summary)) or _with(b.summary, name):
            return True
    return False


def _title(group: list, name: str) -> str:
    """The clearer title of one event said on two calendars."""
    mine = [o for o in group if _own(o.summary, name) is not None]
    others = [o for o in group if _own(o.summary, name) is None]
    if not mine or not others:
        return _clean((others or group)[0].summary, name)
    what = _clean(mine[0].summary, name)                    # "Coffee", "PT"
    g = others[0].summary
    who = _with(g, name)
    if who:
        return f"{what} with {who}"                         # "Dane + Chris ☕️" -> "Coffee with Chris"
    head = _bare(g.split(",")[0])                           # "PT, Synergy Buena Vista" -> "PT"
    if head and _words(what) <= _words(head):
        return _EM_DASH.sub(", ", head)
    return _clean(g, name)


def _collapse(occurrences: list, pairs: frozenset, name: str) -> list[_Item]:
    """Each event once, in the order read (all-day first, then by start)."""
    occ = list(occurrences)
    group = list(range(len(occ)))

    def root(i: int) -> int:
        while group[i] != i:
            i = group[i]
        return i
    for i in range(len(occ)):
        for j in range(i + 1, len(occ)):
            if occ[i].all_day == occ[j].all_day and root(i) != root(j) and _same(occ[i], occ[j], pairs, name):
                group[root(j)] = root(i)
    items, seen = [], set()
    for i in range(len(occ)):
        r = root(i)
        if r in seen:
            continue
        seen.add(r)
        members = [o for k, o in enumerate(occ) if root(k) == r]
        items.append(_Item(min(o.start for o in members), max(o.end for o in members),
                           _title(members, name),
                           any(not o.transparent and o.end > o.start for o in members), occ[i].all_day))
    return items


def _clash(p: _Item, q: _Item) -> bool:
    """A true clash: two different busy events at once, starting together, one inside the other, or
    overlapping by more than half the shorter one. A short overlap (one runs into the next) isn't."""
    if not (p.busy and q.busy) or not (p.start < q.end and q.start < p.end):
        return False
    if p.start == q.start:
        return True
    if (p.start <= q.start and q.end <= p.end) or (q.start <= p.start and p.end <= q.end):
        return True
    over = min(p.end, q.end) - max(p.start, q.start)
    return over * 2 > min(p.end - p.start, q.end - q.start)


def _cut(title: str, cut: int | None) -> str:
    return title if cut is None or len(title) <= cut else title[:cut - 1].rstrip(" ,") + "…"


def _shown(text: str) -> int:
    from .discord_chat import to_markdown                   # what Discord shows, as it counts it
    return units(to_markdown(text))


def owner_text(a: Agenda | None, *, now: datetime, local: ZoneInfo, failures: list[str] = ()) -> str:
    """His digest, plain code: today's events, each once, and at most three real problems."""
    today = now.astimezone(local)
    head = f"<b>Today, {today:%a %b} {today.day}</b>"
    if a is None or not a.configured:
        return head + "\nNo calendar is set up yet."
    if a.read == 0:
        return head + "\nYour calendars weren't read today, so I can't say what's on them."
    day_start = datetime.combine(today.date(), datetime.min.time(), tzinfo=local)
    items = _collapse(a.occurrences, a.pairs, a.name)
    timed = [i for i in items if not i.all_day]
    all_day = [i for i in items if i.all_day]

    def when(i: _Item) -> str:
        if i.start < day_start:
            return f"until {clock_words(i.end.astimezone(local))}"
        return clock_words(i.start.astimezone(local))

    def problems(cut: int | None) -> list[str]:
        out = []
        for x in range(len(timed)):
            for y in range(x + 1, len(timed)):
                p, q = timed[x], timed[y]
                if _clash(p, q):
                    out.append(f"{when(p)} {model_text(_cut(p.title, cut))} and {when(q)} "
                               f"{model_text(_cut(q.title, cut))} are at the same time: move one of them.")
        for f in failures:                 # what he asked for, when, and what came of it (daily._failed)
            out.append(escape(f[:1].upper() + f[1:]))
        if a.read < a.configured:
            out.append(f"{a.configured - a.read} of {a.configured} calendars weren't read today, so this "
                       "list may be missing events.")
        if a.unreadable:
            out.append(f"{a.unreadable} event{'s' * (a.unreadable != 1)} couldn't be read, so "
                       f"{'they are' if a.unreadable != 1 else 'it is'} not listed.")
        return out[:MAX_PROBLEMS]

    text = ""
    for cut in TITLE_CUTS:
        lines = [head]
        if not items:
            lines.append("Nothing on the calendar." if a.read == a.configured
                         else "Nothing on the calendars I could read.")
        lines += [f"• <b>{when(i)}</b> {model_text(_cut(i.title, cut))}" for i in timed]   # every one
        if all_day:
            lines.append("<small>All day: " + ", ".join(model_text(_cut(i.title, cut)) for i in all_day)
                         + "</small>")
        said = problems(cut)
        if said:
            lines += [""] + said
        text = _EM_DASH.sub(", ", "\n".join(lines))
        if _shown(text) <= OWNER_LIMIT:
            break
    return text


def as_markdown(text: str) -> str:
    """His digest as Discord shows it, unescaped: what Cain folds into his morning message."""
    import html
    text = re.sub(r"</?b>", "**", text).replace("<small>", "-# ").replace("</small>", "")
    return html.unescape(re.sub(r"<[^>]+>", "", text))
