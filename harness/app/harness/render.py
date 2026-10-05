"""Rendering: the controller decides every character he can tap.

Model text is shown escaped and with its links defanged, so a model --
or an email it summarized -- can never put a clickable link, a button or
a destination in front of him. Links he can tap (re-consent, an event he
just approved) are built here from canonical fields. Cards for proposals
are rendered from the canonical parameters and the effect definition,
never from the model's own description of what it wants to do.

Messages use Telegram's HTML parse mode; only &, < and > need escaping.
"""
from __future__ import annotations

import html
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from . import approvals
from .effects import EffectDef

TELEGRAM_LIMIT = 4096

# Anything Telegram may turn into something he can tap, in model text:
#   scheme URLs with any host -- names, IP literals, internationalized
#   names -- including tg:// links;
#   bare domains, with Unicode-aware labels and letter-only TLDs;
#   bare IPv4 addresses;
#   /commands (tapping one sends it from his account) and @mentions.
_SCHEME = re.compile(r"(?i)\b(?:https?|ftp|tg)://([^\s/<>\"'?#]+)([^\s<>\"']*)")
_BARE = re.compile(r"(?<![\w.\[])((?:[^\W_][\w-]*\.)+[^\W\d_]{2,})\b(/[^\s<>\"']*)?")
_IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_COMMAND = re.compile(r"(?<![\w/])/([A-Za-z0-9_]{1,32})")
_MENTION = re.compile(r"(?<![\w@])@([A-Za-z0-9_]{3,32})")
WORD_JOINER = "\u2060"     # invisible; breaks Telegram's command and mention detection


def escape(text: str) -> str:
    return html.escape(text, quote=False)


def _allowed(host: str, allowed: tuple[str, ...]) -> bool:
    h = host.lower().split("@")[-1].split(":")[0]
    return any(h == d or h.endswith("." + d) for d in allowed)


def defang(text: str, allowlist: tuple[str, ...] = ()) -> str:
    """Make every link, bare domain, IP, /command and @mention in model text
    untappable unless its domain is on the allowlist:
    `https://evil.example/x` -> `evil[.]example/x`, `/cancel` -> `/\u2060cancel`."""
    allowed = tuple(d.lower().lstrip(".") for d in allowlist)

    def scheme(m: re.Match) -> str:
        if _allowed(m.group(1), allowed):
            return m.group(0)
        return m.group(1).replace(".", "[.]") + m.group(2)

    def bare(m: re.Match) -> str:
        if _allowed(m.group(1), allowed):
            return m.group(0)
        return m.group(1).replace(".", "[.]") + (m.group(2) or "")

    text = _SCHEME.sub(scheme, text)
    text = _BARE.sub(bare, text)
    text = _IPV4.sub(lambda m: m.group(0).replace(".", "[.]"), text)
    text = _COMMAND.sub(lambda m: "/" + WORD_JOINER + m.group(1), text)
    text = _MENTION.sub(lambda m: "@" + WORD_JOINER + m.group(1), text)
    return text


def model_text(text: str, allowlist: tuple[str, ...] = ()) -> str:
    return escape(defang(text, allowlist))


def units(text: str) -> int:
    """Length as Telegram may count it: UTF-16 code units. Measuring the
    HTML source this way over-counts, never under-counts."""
    return len(text.encode("utf-16-le")) // 2


def fit(text: str, footer: str = "") -> str:
    """Never exceed Telegram's limit; say so when cut. Never cuts inside
    an HTML entity or tag."""
    room = TELEGRAM_LIMIT - units(footer)
    if units(text) <= room:
        return text + footer
    marker = "\n… (cut to fit)"
    budget = room - units(marker)
    limit = budget
    while limit > 0:
        closed = _close_tags(_cut(text, limit))
        over = units(closed) - budget
        if over <= 0:                  # the closing tags fit too
            return closed + marker + footer
        limit -= over
    return marker.lstrip() + footer


def _cut(text: str, limit: int) -> str:
    out, used = [], 0
    for ch in text:
        u = units(ch)
        if used + u > limit:
            break
        out.append(ch)
        used += u
    cut = "".join(out)
    # don't leave half an entity (&am) or half a tag (<i) behind
    amp, semi = cut.rfind("&"), cut.rfind(";")
    if amp > semi:
        cut = cut[:amp]
    lt, gt = cut.rfind("<"), cut.rfind(">")
    if lt > gt:
        cut = cut[:lt]
    return cut


_TAG = re.compile(r"<(/?)([a-z]+)[^>]*>")


def _close_tags(text: str) -> str:
    """Close any tag the cut left open, so Telegram can still parse it."""
    stack: list[str] = []
    for m in _TAG.finditer(text):
        closing, name = m.group(1), m.group(2)
        if closing:
            if stack and stack[-1] == name:
                stack.pop()
        else:
            stack.append(name)
    return text + "".join(f"</{n}>" for n in reversed(stack))


def plain(text: str) -> str:
    """What he saw, without the markup: for showing an earlier exchange
    back to a model as context."""
    return html.unescape(re.sub(r"<[^>]+>", "", text))


def short(job_id: str) -> str:
    return job_id.split("-", 1)[0]


def answer(job_id: str, text: str, *, rules_fired: tuple[str, ...] = (),
           allowlist: tuple[str, ...] = ()) -> str:
    footer = f"\n\n<i>job {short(job_id)}"
    if rules_fired:
        footer += " · rules " + ", ".join(escape(r) for r in rules_fired)
    footer += "</i>"
    return fit(model_text(text, allowlist), footer)


def _when(start_iso: str, minutes: int, tz: str) -> str:
    start = datetime.fromisoformat(start_iso).astimezone(ZoneInfo(tz))
    end_minutes = start.hour * 60 + start.minute + minutes
    end_h, end_m = divmod(end_minutes % (24 * 60), 60)
    day = start.strftime("%a %b %-d")
    begin = start.strftime("%-I:%M %p")
    endt = datetime(2000, 1, 1, end_h, end_m).strftime("%-I:%M %p")
    zone = start.strftime("%Z")
    return f"{day}, {begin}–{endt} {zone} ({minutes} min)"


def proposal_card(effect: EffectDef, params: dict, *, tz: str, expires: datetime,
                  job_id: str) -> str:
    """Rendered from canonical params and the definition. The model's own
    summary is not used here on purpose."""
    if effect.name == "calendar_hold":
        lines = [
            "<b>Hold on your harness calendar</b>",
            escape(_when(params["start"], params["duration_min"], tz)),
            f"Title: {escape(effect.fixed['title'])} · no attendees · private",
            f"Undo: {escape(effect.undo)}",
        ]
    else:
        lines = [f"<b>{escape(effect.name)}</b>"] + [
            f"{escape(k)}: {escape(str(v))}" for k, v in sorted(params.items())]
    lines.append("Reversible." if effect.reversible
                 else "<b>Not reversible.</b>")
    exp = expires.astimezone(ZoneInfo(tz)).strftime("%a %-I:%M %p")
    lines.append(f"<i>Offer ends {escape(exp)} · job {short(job_id)}</i>")
    return fit("\n".join(lines))


def proposal_buttons(nonce: str) -> list[list[tuple[str, str]]]:
    return [[("Approve", approvals.callback_data("approve", nonce)),
             ("Decline", approvals.callback_data("decline", nonce))]]
