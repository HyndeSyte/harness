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
all-day items on one small line; then a plain line for each real
problem (a clash, a change that didn't go through, a calendar not read), past
three the clashes on one line, and a long day in two messages.

He is not the liveness monitor. If a digest does not arrive at all, the
external watchdog notices, not him.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
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
    owner_parts: tuple = ()   # what he sees, one message or two (owner_parts); `text` is Cain's alone

    @property
    def owner(self) -> str:
        """His digest as one text (the add-on page): its messages, a blank line apart."""
        return "\n\n".join(self.owner_parts)


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
    parts, mismatched = _owner(agenda, now=now, local=local,
                               failures=list(failures if asked_failures is None else asked_failures))
    owner = tuple(parts)
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
    info = [escape(x) for x in extra if x] + [model_text(x) for x in mismatched]
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
#   • **8:00** PT, Synergy Buena Vista
#   • **8:30** Coffee with Chris
#   • **1:00** Massage with Braden
#   -# All day: Aunt Cindy birthday, Off work
#
#   8:00 PT, Synergy Buena Vista and 8:30 Coffee with Chris overlap: move one of them.
#
# then the plain lines for a real problem, each saying what to do. No status, no counts, no other
# days: all of that stays in Digest.text, for Cain.
#
# Fix round (first outside review): a merge never joins two different events (a record pair needs
# the same start and end, a "Dane - X" event needs X's own words in the other title and one
# candidate on each side, and a group holds at most one event from each calendar); any overlap of
# two of his busy events is a clash but a run-over of 10 minutes or less; a problem line is never
# dropped (only clashes fold into one line); and a day too long for one message goes out as two.

OWNER_LIMIT = 1800          # what he sees, per message, as Discord counts it
MAX_PROBLEMS = 3            # beyond this the clashes fold into one line; nothing else is dropped
RUN_OVER = timedelta(minutes=10)
ONE_PART_CUTS = (120, 64, 48, 40, 32)                 # titles shortened this far before a split
TITLE_CUTS = ONE_PART_CUTS + (26, 20, 16, 12, 8)      # and then, in two messages, further
PROBLEM_CUT = 240           # a failed change's line, at most
CONTINUED = "<b>Today, continued</b>"
_EM_DASH = re.compile(r"\s*—\s*")
# Words a "Dane - Off Work" title says in title case that read as plain words: "Off work".
COMMON = frozenset("""off work day appointment appt school pickup drop dropoff lunch dinner breakfast
    coffee call meeting run practice birthday visit class lesson shift game trip party out home
    errands drive time session check checkup cleaning""".split())
# Words that say nothing about which event it is, never enough for a "Dane - X" to merge.
STOPWORDS = frozenset("""the and with for from about into onto our your his her their this that are was
    has have will not but via off out per""".split())
GENERIC = frozenset("""call meeting lunch appointment appt dinner breakfast coffee event busy hold block
    session visit class time work""".split())


@dataclass(frozen=True)
class _Item:
    start: object               # UTC for a timed event (a daylight-saving day counts true minutes)
    end: object
    title: str
    busy: bool
    all_day: bool


def _family() -> str:
    from .family import LABEL                               # "Family"
    return LABEL


def _bare(text: str) -> str:
    """Without emoji and the like: "Chris ☕️" -> "Chris"."""
    return "".join(ch for ch in text if unicodedata.category(ch) not in ("So", "Sk", "Cs", "Co", "Me", "Cc")
                   and ch not in "️︎‍").strip()


def _words(text: str) -> set[str]:
    return set(re.findall(r"\w+", _bare(text).lower()))


def _meaningful(text: str) -> set[str]:
    """X's own words: no stopwords, no word under 3 letters unless it is in capitals (PT, ER), and
    nothing at all when X is one generic word (Call, Meeting, Lunch)."""
    out = {w.lower() for w in re.findall(r"\w+", _bare(text))
           if (len(w) >= 3 or (len(w) >= 2 and w.isupper() and w.isalpha())) and w.lower() not in STOPWORDS}
    return set() if len(out) == 1 and out <= GENERIC else out


def _own(title: str, name: str) -> str | None:
    """"Dane - PT" -> "PT" when his name is Dane (an event that is his); None otherwise."""
    if not name:
        return None
    m = re.match(rf"\s*{re.escape(name)}\s+[-–—]\s+(.+)$", title, re.I | re.S)
    return m.group(1).strip() if m and m.group(1).strip() else None


def _with(title: str, name: str) -> str | None:
    """"Dane + Chris ☕️" -> "Chris": his own event, with someone."""
    if not name:
        return None
    m = re.match(rf"\s*{re.escape(name)}\s*(?:\+|&|\band\b)\s*(.+)$", title, re.I | re.S)
    who = _bare(m.group(1)) if m else ""
    return who or None


def _plain_case(rest: str) -> str:
    words = rest.split(" ")
    return " ".join(w.lower() if k and w.lower() in COMMON and not w.isupper() else w
                    for k, w in enumerate(words))


def _clean(title: str, name: str) -> str:
    own = _own(title, name)
    text = _plain_case(own) if own is not None else title.strip()
    text = " ".join((_bare(text) or text).split())          # emoji off, one line
    return _EM_DASH.sub(", ", text)


def _family_own(o, name: str) -> bool:
    """A "<Name> - X" event on Family: his commitment."""
    return o.calendar == _family() and _own(o.summary, name) is not None


def _slot(o) -> tuple:
    return (o.all_day, o.start, o.end)


def _groups(occ: list, pairs: frozenset, name: str) -> tuple[list[list[int]], list[str]]:
    """Each event once: groups of indexes into `occ`, in the order read, and Cain's lines about the
    record pairs whose two events no longer agree. A group holds at most one event from each calendar,
    and only events with the same start and end."""
    group = list(range(len(occ)))
    members = {i: [i] for i in range(len(occ))}

    def root(i: int) -> int:
        while group[i] != i:
            i = group[i]
        return i

    def join(i: int, j: int) -> None:
        a, b = root(i), root(j)
        if a == b or _slot(occ[i]) != _slot(occ[j]):
            return
        if {occ[k].calendar for k in members[a]} & {occ[k].calendar for k in members[b]}:
            return                      # one-to-one per calendar pair: never two from one calendar
        a, b = min(a, b), max(a, b)
        group[b] = a
        members[a] += members.pop(b)

    n = len(occ)
    mismatched: list[str] = []
    # 1. A pair Harness keeps a record of: the same start and the same end, or two lines.
    for i in range(n):
        for j in range(i + 1, n):
            x, y = occ[i], occ[j]
            if not (x.uid and y.uid and x.calendar != y.calendar and frozenset((x.uid, y.uid)) in pairs):
                continue
            if _slot(x) == _slot(y):
                join(i, j)
            else:
                mismatched.append(f"Family copy out of step: {x.summary} ({x.calendar}) and {y.summary} "
                                  f"({y.calendar}) don't start and end together, so both are listed")
    # 2. The same words at the same start and end on two calendars, one of each on either side.
    for i in range(n):
        for j in range(i + 1, n):
            x, y = occ[i], occ[j]
            w = _words(x.summary)
            if x.calendar == y.calendar or _slot(x) != _slot(y) or not w or w != _words(y.summary):
                continue
            alike = [k for k in range(n) if _slot(occ[k]) == _slot(x) and _words(occ[k].summary) == w]
            if (sum(occ[k].calendar == x.calendar for k in alike) == 1
                    and sum(occ[k].calendar == y.calendar for k in alike) == 1):
                join(i, j)
    # 3. "Dane - X" on Family and his own event that says X's words, the only candidate either way.
    for i in range(n):
        f = occ[i]
        if not _family_own(f, name):
            continue
        what = _meaningful(_own(f.summary, name))
        if not what:
            continue
        cands = [k for k in range(n) if k != i and occ[k].calendar != f.calendar and _slot(occ[k]) == _slot(f)
                 and _own(occ[k].summary, name) is None and what <= _words(occ[k].summary)]
        if len(cands) != 1:
            continue                    # none, or two that could be it: both shown
        c = occ[cands[0]]
        back = [k for k in range(n) if _slot(occ[k]) == _slot(c) and _family_own(occ[k], name)
                and _meaningful(_own(occ[k].summary, name))
                and _meaningful(_own(occ[k].summary, name)) <= _words(c.summary)]
        if back == [i]:
            join(i, cands[0])
    seen, out = set(), []
    for i in range(n):
        r = root(i)
        if r not in seen:
            seen.add(r)
            out.append(sorted(members[r]))
    return out, mismatched


def _title(group: list, name: str) -> str:
    """The title of one event said on two calendars: his own calendar's, emoji off; "X with Y" only
    when "Dane - X" on Family and "Dane + Y" on his own calendar say both."""
    family = _family()
    own = [o for o in group if o.calendar != family]
    mine = [o for o in group if _family_own(o, name)]
    if own:
        who = _with(own[0].summary, name) if mine else None
        what = _clean(mine[0].summary, name) if mine else ""
        if who and what:
            return _EM_DASH.sub(", ", f"{what} with {who}")  # "Dane - Coffee" + "Dane + Chris ☕️"
        return _clean(own[0].summary, "")                     # his own title as he wrote it
    return _clean(group[0].summary, name)


def _collapse(occurrences: list, pairs: frozenset, name: str) -> tuple[list[_Item], list[str]]:
    occ = list(occurrences)
    groups, mismatched = _groups(occ, pairs, name)
    items = []
    for g in groups:
        ms = [occ[k] for k in g]
        o = ms[0]
        busy = not o.all_day and o.end > o.start and any(
            not m.transparent or _family_own(m, name) for m in ms)
        start, end = (o.start, o.end) if o.all_day else (o.start.astimezone(UTC), o.end.astimezone(UTC))
        items.append(_Item(start, end, _title(ms, name), busy, o.all_day))
    return items, mismatched


def _clash(p: _Item, q: _Item) -> bool:
    """Two of his busy events at once. Any overlap is a clash, but one running over into the next by
    10 minutes or less at one boundary."""
    if not (p.busy and q.busy) or not (p.start < q.end and q.start < p.end):
        return False
    first, second = (p, q) if p.start <= q.start else (q, p)
    if first.start < second.start and first.end < second.end:      # staggered: a run-over?
        return first.end - second.start > RUN_OVER
    return True                                                   # same start, or one inside the other


def _cut(title: str, cut: int | None) -> str:
    return title if cut is None or len(title) <= cut else title[:cut - 1].rstrip(" ,") + "…"


def _shown(text: str) -> int:
    from .discord_chat import to_markdown                   # what Discord shows, as it counts it
    return units(to_markdown(text))


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def owner_parts(a: Agenda | None, *, now: datetime, local: ZoneInfo,
                failures: list[str] = ()) -> list[str]:
    """His digest, plain code: one message, or two when the day is too long for one."""
    return _owner(a, now=now, local=local, failures=failures)[0]


def owner_text(a: Agenda | None, *, now: datetime, local: ZoneInfo, failures: list[str] = ()) -> str:
    return "\n\n".join(owner_parts(a, now=now, local=local, failures=failures))


def _owner(a: Agenda | None, *, now: datetime, local: ZoneInfo,
           failures: list[str] = ()) -> tuple[list[str], list[str]]:
    today = now.astimezone(local)
    head = f"<b>Today, {today:%a %b} {today.day}</b>"
    if a is None or not a.configured:
        return [head + "\nNo calendar is set up yet."], []
    if a.read == 0:
        return [head + "\nYour calendars weren't read today, so I can't say what's on them."], []
    day_start = datetime.combine(today.date(), datetime.min.time(), tzinfo=local)
    items, mismatched = _collapse(a.occurrences, a.pairs, a.name)
    timed = [i for i in items if not i.all_day]
    all_day = [i for i in items if i.all_day]

    def when(i: _Item) -> str:
        start = i.start.astimezone(local)
        if i.start < day_start:                             # started before today, runs into it
            return clock_words(start, suffix=True)
        return clock_words(start)

    def since(i: _Item) -> str:
        if i.start >= day_start:
            return ""
        day = i.start.astimezone(local).date()
        return (" (since yesterday)" if day == today.date() - timedelta(days=1)
                else f" (since {day:%a %b} {day.day})")

    clashes = [(p, q) for x, p in enumerate(timed) for q in timed[x + 1:] if _clash(p, q)]
    others = [model_text(_cut(_EM_DASH.sub(", ", " ".join(f.split())), PROBLEM_CUT))
              for f in failures if f.strip()]
    others = [f[:1].upper() + f[1:] for f in others]       # what he asked for, when, what came of it
    if a.read < a.configured:
        others.append(f"{a.configured - a.read} of {a.configured} calendars weren't read today, so this "
                      "list may be missing events.")
    if a.unreadable:
        others.append(f"{a.unreadable} {_plural(a.unreadable, 'event', 'events')} couldn't be read, so "
                      f"{_plural(a.unreadable, 'it is', 'they are')} not listed.")

    def problems(cut: int) -> list[str]:
        lines = [f"{when(p)} {model_text(_cut(p.title, cut))} and {when(q)} {model_text(_cut(q.title, cut))} "
                 "overlap: move one of them." for p, q in clashes]
        if len(lines) <= 1 or len(lines) + len(others) <= MAX_PROBLEMS:
            return lines + others
        room = MAX_PROBLEMS - len(others)
        keep = max(room - 1, 0)
        rest = clashes[keep:]
        times = []
        for p, q in rest:                                   # when each one starts to clash
            t = when(max(p, q, key=lambda i: i.start))
            if t not in times:
                times.append(t)
        word = "more clashes" if keep else "clashes"
        return lines[:keep] + [f"{len(rest)} {word}: {', '.join(times)}. Move one event of each."] + others

    def build(cut: int, split: bool) -> list[str]:
        body = [f"• <b>{when(i)}</b> {model_text(_cut(i.title, cut))}{since(i)}" for i in timed]   # every one
        if not items:
            body.append("Nothing on the calendar." if a.read == a.configured
                        else "Nothing on the calendars I could read.")
        tail = []
        if all_day:
            tail.append("<small>All day: " + ", ".join(model_text(_cut(i.title, cut)) for i in all_day)
                        + "</small>")
        said = problems(cut)
        if said:
            tail += [""] + said
        if not split:
            return ["\n".join([head] + body + tail)]
        parts, cur = [], [head]
        for line in body:                                   # split only between two events
            if len(cur) > 1 and _shown("\n".join(cur + [line])) > OWNER_LIMIT:
                parts.append(cur)
                cur = [CONTINUED]
            cur.append(line)
        if tail and len(cur) > 1 and _shown("\n".join(cur + tail)) > OWNER_LIMIT:
            parts.append(cur)
            cur = [CONTINUED] + (tail[1:] if tail[0] == "" else tail)
        else:
            cur += tail
        parts.append(cur)
        return ["\n".join(p) for p in parts]

    def fits(parts: list[str]) -> bool:
        return all(_shown(p) <= OWNER_LIMIT for p in parts)

    for cut in ONE_PART_CUTS:
        parts = build(cut, split=False)
        if fits(parts):
            return parts, mismatched
    for cut in TITLE_CUTS:
        parts = build(cut, split=True)
        if len(parts) <= 2 and fits(parts):
            return parts, mismatched
    return build(TITLE_CUTS[-1], split=True), mismatched   # a day longer than two messages: every one


def as_markdown(text: str) -> str:
    """His digest as Discord shows it: what Cain folds into his morning message, escaped the same way,
    so a title can't format or ping there either."""
    from .discord_chat import to_markdown
    return to_markdown(text)


def said(parts: list[str]) -> str:
    """keeper.sh digest's "said": his digest as Discord shows it, each message marked when there are two."""
    shown = [as_markdown(p) for p in parts]
    if len(shown) <= 1:
        return shown[0] if shown else ""
    return "\n\n".join(f"[Message {k} of {len(shown)}]\n{p}" for k, p in enumerate(shown, 1))
