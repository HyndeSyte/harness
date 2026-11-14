"""The message gate's rules, for the calendar specialist's tests only: a port of Cain's
cain/rootfs/opt/cain/gate/rules.ts, kept equal to it by the shared cases in
cain/tests/gate-cases.json (test_message_text.py runs them here, cain/tests/gate.test.ts
runs them there). Nothing in harness/app imports this: what he sees is kept clean by the
tests that use it.

  dash     an em dash                         fix: ", " (removed at a line's start or end, or
                                              before a stop; " to " only between two clock
                                              times), never inside code or a link
  app      "the add-on", "Cain's add-on", "Settings > Add-ons" and the like, also "addon" and
           the escaped "add\\-on"             fix: "App", "Apps", "App's". A bare "add-on" (a
                                              browser add-on in a calendar title) is left alone.
  count    "and 3 more", "+2 more", "(+2)", "4 more changes"     refuse: name each one
  machine  a full sha, a cloud job id, an ISO date-time, a Discord id (17 to 20 digits), "job"
           and a hex id                                          refuse. In a reply to his own
                                                                  message a long number, and
                                                                  anything in code, passes.
  button   a known button label named as one ("tap Undo", "the Stop button", "with Undo"), exact
           case, when the message doesn't have it                refuse; "unsure" when which
                                                                  buttons are up can't be told
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

RULES = ("dash", "app", "count", "machine", "button")

# Both Apps' own button labels (rules.ts STATIC_LABELS).
STATIC_LABELS = (
    # Cain's link, and his own asks (CLAUDE.md, Check-ins)
    "Ship", "Not now", "Stop", "Turn back on", "Start", "Open connector settings", "Do it", "I'll do it", "Drop it",
    # the calendar specialist
    "Approve", "Decline", "Undo", "Undo both", "Undo these", "Use new", "Keep old", "Not mine", "Wrong time",
    "Just this once", "Yes", "No", "Depends", "All of it", "Part of it", "Skip", "Keep rule", "Drop rule",
    "Turn on", "None wrong: stop checking", "Something was off: keep checking", "Do it now",
)

# Which rules each send point applies (rules.ts AT).
AT = {"cain": RULES, "card": ("dash", "app", "count", "button"), "answer": ("dash", "app"),
      "link": ("dash", "app")}

HIDE = "\u0000"
A = re.ASCII                      # JavaScript's \b, \d and \w are ASCII-only


@dataclass(frozen=True)
class Hit:
    rule: str
    result: str                   # fix | refuse | unsure
    at: int
    end: int
    around: str
    label: str = ""


@dataclass
class Report:
    hits: list[Hit] = field(default_factory=list)
    fixed: str = ""

    def rules(self, result: str) -> list[str]:
        return sorted({h.rule for h in self.hits if h.result == result})


def hidden(text: str, only_targets: bool | str = False) -> str:
    """What isn't visible text, hidden in place (same length, new lines kept). "code" hides
    link targets and code but not bare links: what the machine rule reads in a reply to his
    own message."""
    t = list(text)

    def cover(start: int, end: int) -> None:
        for i in range(start, end):
            if t[i] != "\n":
                t[i] = HIDE

    def each(pattern: str, offset: int = 0) -> None:
        for m in re.finditer(pattern, text, A):
            cover(m.start() + offset, m.end())

    each(r"\]\([^)\s]*\)", 1)
    if only_targets is not True:
        each(r"```[\s\S]*?```")
        each(r"`[^`\n]+`")
    if only_targets is False:
        each(r"<?https?://[^\s<>()]+>?")
    return "".join(t)


def around(text: str, at: int, end: int, n: int = 60) -> str:
    pad = max(0, (n - min(end - at, n)) // 2)
    start = max(0, at - pad)
    stop = min(len(text), start + n)
    start = max(0, stop - n)
    return re.sub(r"\s+", " ", text[start:stop]).strip()[:n]


# " to " only between two clock times (rules.ts clockRange): one side says it's a time (a
# colon, or AM or PM) and the other is a time or a bare hour. Any other pair of numbers gets ", ".
_MERIDIEM = r"\s?[AaPp]\.?[Mm]\.?"
_CLOCK_END = re.compile(r"(?<![\d:.])(?:\d{1,2}:\d{2}(?:" + _MERIDIEM + r")?|\d{1,2}" + _MERIDIEM + r")$", A)
_HOUR_END = re.compile(r"(?<![\d:])(?<!\d[.,])\d{1,2}$", A)                 # not "1.5" or "2026"
_CLOCK_START = re.compile(r"^(?:\d{1,2}:\d{2}(?:" + _MERIDIEM + r")?|\d{1,2}" + _MERIDIEM + r")(?![A-Za-z0-9:])", A)
_HOUR_START = re.compile(r"^\d{1,2}(?![A-Za-z0-9:]|[.,]\d)", A)


def _clock_range(left: str, right: str) -> bool:
    lt, rt = bool(_CLOCK_END.search(left)), bool(_CLOCK_START.search(right))
    return (lt and (rt or bool(_HOUR_START.search(right)))) or (rt and bool(_HOUR_END.search(left)))


def _dashes(text: str, seen: str) -> list[tuple[int, int, str]]:
    out = []
    for m in re.finditer("[ \t]*\u2014+[ \t]*", seen):
        at, end = m.start(), m.end()
        before = "\n" if at == 0 else text[at - 1]
        after = "\n" if end >= len(text) else text[end]
        put = ", "
        if _clock_range(text[max(0, at - 12):at], text[end:end + 12]):
            put = " to "                  # "9:30 to 10:15", never "Room 4 to 5"
        elif before == "\n" or after == "\n" or re.match(r"[,.;:!?)]", after):
            put = ""
        elif re.match(r"[,;:]", before):
            put = " "
        out.append((at, end, put))
    return out


# Only the words that make it one of these two Apps: "your add-on order" is something else.
_OWNERS = "the|cain['\u2019]s|cain|harness['\u2019]s|harness['\u2019]|harness"
_APP = re.compile(r"(?:\b(?:" + _OWNERS + r")|>)[*_~]*\s+[*_~]*(add\\?-?ons?(?:['\u2019]s?)?)(?![A-Za-z0-9])",
                  re.I | A)


def _apps(seen: str) -> list[tuple[int, int, str]]:
    out = []
    for m in _APP.finditer(seen):
        word, at = m.group(1), m.start(1)
        plural = re.search("ons", word, re.I) is not None
        if re.search("['\u2019]s$", word, re.I):
            tail = word[-2] + "s"
        elif re.search("['\u2019]$", word):
            tail = word[-1]
        else:
            tail = ""
        out.append((at, at + len(word), ("Apps" if plural else "App") + tail))
    return out


_NUM = (r"(?:\d+|a\s+few|a\s+couple(?:\s+of)?|several|two|three|four|five|six|seven|eight|nine|ten"
        r"|a\s+dozen)")
_UNIT = r"(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?|secs?|times?|tries)"
# Not "questions": "two more questions after this" is how he's told a few asks follow.
_ITEMS = (r"(?:changes|events|blocks|cards|items|messages|notes|places|things|ones"
          r"|appointments|receipts)")
_COUNTS = (
    re.compile(r"\band\s+" + _NUM + r"\s+(?:more|others?)\b(?!\s+" + _UNIT + r"\b)", re.I | A),
    re.compile(r"\+\s?\d+\s+more\b", re.I | A),
    re.compile(r"\\?\(\s*\+\s?\d+\s*\\?\)", A),
    re.compile(r"\b" + _NUM + r"\s+more\s+" + _ITEMS + r"\b", re.I | A),
)
_MACHINE = (   # (pattern, a Discord-id-like digit run)
    (re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{40}(?![0-9A-Fa-f])", A), False),
    (re.compile(r"\bcse\\?_[A-Za-z0-9]", A), False),
    (re.compile(r"\b\d{4}\\?-\d{2}\\?-\d{2}T\d{2}:\d{2}", A), False),
    (re.compile(r"(?<!\d)\d{17,20}(?!\d)", A), True),
)
_JOB = re.compile(r"\bjob\s+(?:id\s+)?#?([0-9a-f]{6,})\b", re.I | A)

_Q = "[\"\u201c\u201d'\u2018\u2019*_]*"
_VERB = "(?:[Tt]ap|[Tt]apping|[Pp]ress|[Pp]ressing|[Hh]it|[Cc]lick|[Cc]hoose|[Pp]ick|[Ss]elect)"


# "with X" names a button only for labels that are never plain words (rules.ts WITH_LABELS):
# "ends with Stop", "go with No" and "syncs with Gmail" (a live card's option) are just words.
WITH_LABELS = (
    "Undo", "Undo both", "Undo these", "Not mine", "Wrong time", "Just this once", "Turn back on", "Not now",
    "Use new", "Keep old", "Keep rule", "Drop rule", "All of it", "Part of it", "None wrong: stop checking",
    "Something was off: keep checking", "Open connector settings",
)


def _named(seen: str, label: str) -> list[tuple[int, int]]:
    L = re.escape(label)
    forms = (
        r"(?<![A-Za-z])" + _VERB + r"\s+(?:(?:on\s+)?the\s+|on\s+)?" + _Q + "(" + L + ")" + _Q + r"(?![A-Za-z0-9])",
        r"(?<![A-Za-z0-9])" + _Q + "(" + L + ")" + _Q + r"\s+[Bb]uttons?\b",
    ) + ((r"(?<![A-Za-z])[Ww]ith\s+(?:the\s+)?" + _Q + "(" + L + ")" + _Q + r"(?![A-Za-z0-9])",)
         if label in WITH_LABELS else ())
    out: list[tuple[int, int]] = []
    for form in forms:
        for m in re.finditer(form, seen, A):
            at, end = m.start(1), m.end(1)
            if not any(x[0] == at for x in out):
                out.append((at, end))
    return out


def _overlaps(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return a[0] < b[1] and b[0] < a[1]


def check(text: str, *, rules=None, buttons=(), known=(), answers_him: bool = False) -> Report:
    """buttons: the labels on this message; None when which buttons are up can't be told."""
    t = str(text or "")
    on = set(RULES if rules is None else rules)
    # The machine rule reads code too, except in a reply to his own message.
    seen, targets_only = hidden(t), hidden(t, "code" if answers_him else True)
    hits: list[Hit] = []

    def add(rule: str, result: str, at: int, end: int, label: str = "") -> None:
        if any(h.rule == rule and _overlaps((h.at, h.end), (at, end)) for h in hits):
            return
        hits.append(Hit(rule, result, at, end, around(t, at, end), label))

    edits: list[tuple[int, int, str]] = []
    if "dash" in on:
        for e in _dashes(t, seen):
            add("dash", "fix", e[0], e[1])
            edits.append(e)
    if "app" in on:
        for e in _apps(seen):
            add("app", "fix", e[0], e[1])
            edits.append(e)
    if "count" in on:
        for pattern in _COUNTS:
            for m in pattern.finditer(seen):
                add("count", "refuse", m.start(), m.end())
    if "machine" in on:
        for pattern, digits in _MACHINE:
            if digits and answers_him:
                continue
            for m in pattern.finditer(targets_only):
                add("machine", "refuse", m.start(), m.end())
        for m in _JOB.finditer(targets_only):
            if re.search(r"\d", m.group(1)):
                add("machine", "refuse", m.start(), m.end())
    if "button" in on:
        has = None if buttons is None else set(buttons)
        labels = list(dict.fromkeys(x for x in (str(l).strip() for l in (*STATIC_LABELS, *known)) if x))
        labels = sorted(labels, key=lambda l: -len(l))
        taken: list[tuple[int, int]] = []
        for label in labels:
            for span in _named(seen, label):
                if any(_overlaps(x, span) for x in taken):
                    continue
                taken.append(span)
                if has is not None and label in has:
                    continue
                add("button", "unsure" if has is None else "refuse", span[0], span[1], label)
    hits.sort(key=lambda h: (h.at, RULES.index(h.rule)))
    fixed = t
    for at, end, put in sorted(edits, key=lambda e: -e[0]):
        fixed = fixed[:at] + put + fixed[end:]
    return Report(hits, fixed)


def verdict(report: Report) -> str:
    """The one word for a report: refuse beats fix, fix beats unsure."""
    results = {h.result for h in report.hits}
    for r in ("refuse", "fix", "unsure"):
        if r in results:
            return r
    return "pass"
