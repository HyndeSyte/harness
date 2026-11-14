"""The message gate's rules, for the calendar specialist's tests only: a port of Cain's
cain/rootfs/opt/cain/gate/rules.ts, kept equal to it by the shared cases in
cain/tests/gate-cases.json (test_message_text.py runs them here, cain/tests/gate.test.ts
runs them there). Nothing in harness/app imports this: what he sees is kept clean by the
tests that use it.

  dash     an em dash, never inside code or a link. A writer the gate refuses (refusable=True:
           Cain's own words): every one       refuse: rewrite it without one.
           Words that are never refused       fix: ", " (removed at a line's start or end, or
                                              before a stop), never " to ". One with a number
                                              right on both sides (a digit, a clock time, a day
                                              or a month by name, noon or midnight, past
                                              markdown: "2026" and "2027", "**6 PM**" and "8",
                                              "Monday" and "Friday"), or right after a link,
                                              stays as it is, flagged (kept)
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
# JavaScript's \s takes Unicode's spaces even without the u flag (U+00A0, and U+202F, which
# clocks print before AM and PM), where Python's ASCII \s is only " \t\n\r\f\v": so the port
# spells it out. _SC goes inside a class, _S is \s, _NS is \S, and _SPACES is what
# JavaScript's trim() takes off.
_SC = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_S, _NS = "[" + _SC + "]", "[^" + _SC + "]"
_SPACES = "\t\n\v\f\r \u00a0\u1680" + "".join(map(chr, range(0x2000, 0x200B))) + "\u2028\u2029\u202f\u205f\u3000\ufeff"


def _js(pattern: str) -> str:
    """A pattern with \\s (outside a class) as JavaScript reads it."""
    return pattern.replace(r"\s", _S)


@dataclass(frozen=True)
class Hit:
    rule: str
    result: str                   # fix | refuse | unsure
    at: int
    end: int
    around: str
    label: str = ""
    kept: str = ""                # a dash in words never refused that stays: "range" or "link"


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

    each(r"\]\([^)" + _SC + r"]*\)", 1)
    if only_targets is not True:
        each("```(?:" + _S + "|" + _NS + ")*?```")
        each(r"`[^`\n]+`")
    if only_targets is False:
        each(r"<?https?://[^" + _SC + r"<>()]+>?")
    return "".join(t)


# A link has any scheme ("https://", "wss://", in any case), or none and starts with "www." or is
# a domain with a path; it runs to the next space or line break, whatever stands between ("<",
# ">" and brackets included; the zero-width U+FEFF too). Its authority runs to the first "/",
# "?", "#" or backslash (rules.ts GAP, LABEL, SCHEMED, BARE, LINK).
_GAP = "\\t-\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
_LABEL = "[^" + _GAP + "\\x00-\\x2c\\x2e\\x2f\\x3a-\\x40\\x5b-\\x5e\\x60\\x7b-\\x7f]"
_SCHEMED = "(?<![A-Za-z0-9+.\\-])[A-Za-z0-9+.\\-]+:\\/\\/[^" + _GAP + "]+"
_BARE = ("(?<![A-Za-z0-9_\\-.@])(?:[^" + _GAP + "\\/?#\\\\]*@)?"
         + "(?:[Ww][Ww][Ww]\\.|(?:" + _LABEL + "+\\.)+(?:[A-Za-z]|[^" + _GAP + "\\x00-\\x7f])" + _LABEL
         + "+(?::\\d*)?(?=[\\/\\\\]|[?#][^" + _GAP + "]))[^" + _GAP + "]*")
_LINK = re.compile(_SCHEMED + "|" + _BARE, A)


def around(text: str, at: int, end: int, n: int = 60) -> str:
    """Up to n characters around a hit, on one line; a link keeps only its scheme and host
    (rules.ts)."""
    pad = max(0, (n - min(end - at, n)) // 2)
    start = max(0, at - pad)
    stop = min(len(text), start + n)
    start = max(0, stop - n)
    return re.sub(_S + "+", " ", hosts_only(text, start, stop)).strip(_SPACES)[:n]


_HOST = re.compile(r"(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?)(?::\d*)?\Z", A)


def link_host(link: str) -> str:
    """A link as its scheme and host alone, with "/\u2026" when anything else was cut: never a user
    name, password, port, path, query or fragment. Its authority runs to the first "/", "?", "#"
    or backslash; its host is what follows the authority's last "@", less any port; one that
    isn't a plain name or address is "a link". Nothing after the host comes back (rules.ts
    linkHost)."""
    s = str(link or "")
    m = re.match(r"([A-Za-z0-9+.\-]+://)?([^/?#\\]*)", s, A)
    scheme, auth = m.group(1) or "", m.group(2)
    h = _HOST.match(auth[auth.rfind("@") + 1:])
    if not h:
        return "a link"
    return scheme.lower() + h.group(1).lower() + ("/\u2026" if len(s) > len(scheme) + len(h.group(1)) else "")


def hosts_only(text: str, start: int = 0, stop: int | None = None) -> str:
    """text[start:stop] with each link as link_host has it. A link that runs past either end of
    the window still comes out whole, as its host (rules.ts hostsOnly)."""
    t = str(text or "")
    stop = len(t) if stop is None else min(stop, len(t))
    out, i = [], start
    for m in _LINK.finditer(t):
        a, b = m.start(), m.end()
        if b <= i:
            continue
        if a >= stop:
            break
        out.append(t[i:max(i, a)] + link_host(m.group(0)))
        i = b
    out.append(t[i:max(i, stop)])
    return "".join(out)


# In Cain's words (refusable) every em dash is refused, none fixed in place (rules.ts dashes). In
# words that are never refused it's never read as "to": one with a number right on both sides
# stays as it is, flagged, and so does one right after a link (or in one). A number: a digit;
# before the dash also a clock time ending in AM or PM, an ordinal or a percentage; after it also
# a currency sign and its digits; on either side a day or a month by name (full or short, any
# case, with or without a period, though lower-case "may", "march", "sat", "sun" and "wed" are
# words), noon or midnight, past markdown's "*", "_", "~" and "`" too. Every other one gets ", " or
# goes. The spaces around it, any but a new line, go with it, and so does another dash with only
# spaces between.
_DASH = re.compile("(?:[\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]*\u2014+)+[\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]*")
_MERIDIEM = _S + r"?[AaPp]\.?[Mm]\.?"
_CLOCK = r"(?:\d{1,2}:\d{2}(?:" + _MERIDIEM + r")?|\d{1,2}" + _MERIDIEM + r")"


def _any_case(s: str) -> str:
    """Any case, spelled out letter by letter, so lower case alone can be told apart (rules.ts anyCase)."""
    return re.sub("[a-z]", lambda m: "[" + m.group(0).upper() + m.group(0) + "]", s)


_NAMES = ("(?!(?:may|march|sat|sun|wed)(?![A-Za-z]))" + _any_case(
    "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|january|february"
    "|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov"
    "|dec|noon|midnight)") + r"\.?")
# Past what can stand between a number and the dash (rules.ts PAST_LEFT, PAST_RIGHT).
_PAST_LEFT = "[)\\]}\"'\\u2018\\u2019\\u201c\\u201d!.*_~`\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff\\u200b-\\u200d\\u2060\\ufeff\\n\\r\\u2028\\u2029]*"
_PAST_RIGHT = "[(\\[{\"'\\u2018\\u2019\\u201c\\u201d*_~`\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff\\u200b-\\u200d\\u2060\\ufeff\\n\\r\\u2028\\u2029]*"
_NUMBER_BEFORE = re.compile(r"(?:\d(?:[Ss][Tt]|[Nn][Dd]|[Rr][Dd]|[Tt][Hh]|%)?|(?<![\d:.])" + _CLOCK + r"|(?<![A-Za-z])" + _NAMES
                            + ")" + _PAST_LEFT + r"\Z", A)
_NUMBER_AFTER = re.compile("^" + _PAST_RIGHT + "(?:[$\\u20ac\\u00a3]?\\d|" + _NAMES + r"(?![A-Za-z]))", A)


def _dashes(text: str, seen: str, refusable: bool) -> list[tuple[int, int, str | None, str]]:
    """Each em dash, what goes in its place (None: it stays, refused or kept and flagged), and why
    one is kept."""
    out: list[tuple[int, int, str | None, str]] = []
    # The links a comma could run into: any but a masked link's target, which its brackets close.
    links = [] if refusable else [(m.start(), m.end()) for m in _LINK.finditer(text)
                                  if text[max(0, m.start() - 2):m.start()] != "]("]
    for m in _DASH.finditer(seen):
        at, end = m.start(), m.end()
        if refusable:
            out.append((at, end, None, ""))
            continue
        if any(a < at <= b for a, b in links):
            out.append((at, end, None, "link"))
            continue
        if _NUMBER_BEFORE.search(text[:at]) and _NUMBER_AFTER.search(text[end:]):
            out.append((at, end, None, "range"))
            continue
        before = "\n" if at == 0 else text[at - 1]
        after = "\n" if end >= len(text) else text[end]
        put = ", "
        if before == "\n" or after == "\n" or re.match(r"[,.;:!?)]", after):
            put = ""
        elif re.match(r"[,;:]", before):
            put = " "
        out.append((at, end, put, ""))
    return out


# Only the words that make it one of these two Apps: "your add-on order" is something else.
_OWNERS = "the|cain['\u2019]s|cain|harness['\u2019]s|harness['\u2019]|harness"
_APP = re.compile(_js(r"(?:\b(?:" + _OWNERS + r")|>)[*_~]*\s+[*_~]*(add\\?-?ons?(?:['\u2019]s?)?)(?![A-Za-z0-9])"),
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


_NUM = _js(r"(?:\d+|a\s+few|a\s+couple(?:\s+of)?|several|two|three|four|five|six|seven|eight|nine|ten"
           r"|a\s+dozen)")
_UNIT = r"(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?|secs?|times?|tries)"
# Not "questions": "two more questions after this" is how he's told a few asks follow.
_ITEMS = (r"(?:changes|events|blocks|cards|items|messages|notes|places|things|ones"
          r"|appointments|receipts)")
_COUNTS = (
    re.compile(_js(r"\band\s+") + _NUM + _js(r"\s+(?:more|others?)\b(?!\s+") + _UNIT + r"\b)", re.I | A),
    re.compile(_js(r"\+\s?\d+\s+more\b"), re.I | A),
    re.compile(_js(r"\\?\(\s*\+\s?\d+\s*\\?\)"), A),
    re.compile(r"\b" + _NUM + _js(r"\s+more\s+") + _ITEMS + r"\b", re.I | A),
)
_MACHINE = (   # (pattern, a Discord-id-like digit run)
    (re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{40}(?![0-9A-Fa-f])", A), False),
    (re.compile(r"\bcse\\?_[A-Za-z0-9]", A), False),
    (re.compile(r"\b\d{4}\\?-\d{2}\\?-\d{2}T\d{2}:\d{2}", A), False),
    (re.compile(r"(?<!\d)\d{17,20}(?!\d)", A), True),
)
_JOB = re.compile(_js(r"\bjob\s+(?:id\s+)?#?([0-9a-f]{6,})\b"), re.I | A)

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
        r"(?<![A-Za-z])" + _VERB + _js(r"\s+(?:(?:on\s+)?the\s+|on\s+)?") + _Q + "(" + L + ")" + _Q + r"(?![A-Za-z0-9])",
        r"(?<![A-Za-z0-9])" + _Q + "(" + L + ")" + _Q + _js(r"\s+[Bb]uttons?\b"),
    ) + ((_js(r"(?<![A-Za-z])[Ww]ith\s+(?:the\s+)?") + _Q + "(" + L + ")" + _Q + r"(?![A-Za-z0-9])",)
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


def check(text: str, *, rules=None, buttons=(), known=(), answers_him: bool = False, refusable: bool = False) -> Report:
    """buttons: the labels on this message; None when which buttons are up can't be told.
    refusable: a writer the gate refuses (Cain), whose every em dash is refused."""
    t = str(text or "")
    on = set(RULES if rules is None else rules)
    # The machine rule reads code too, except in a reply to his own message.
    seen, targets_only = hidden(t), hidden(t, "code" if answers_him else True)
    hits: list[Hit] = []

    def add(rule: str, result: str, at: int, end: int, label: str = "", kept: str = "") -> None:
        if any(h.rule == rule and _overlaps((h.at, h.end), (at, end)) for h in hits):
            return
        hits.append(Hit(rule, result, at, end, around(t, at, end), label, kept))

    edits: list[tuple[int, int, str]] = []
    if "dash" in on:
        for at, end, put, kept in _dashes(t, seen, refusable):
            if put is None:
                add("dash", "refuse", at, end, kept=kept)
                continue
            add("dash", "fix", at, end)
            edits.append((at, end, put))
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
        labels = list(dict.fromkeys(x for x in (str(l).strip(_SPACES) for l in (*STATIC_LABELS, *known)) if x))
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
