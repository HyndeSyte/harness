"""Deep links from instrument cards: t.me/<bot>?start=c1<payload>.

A card on his Lock Screen or dashboard can carry a link that opens this
chat with the card's title. Telegram allows 64 characters from
[A-Za-z0-9_-] in a start parameter, so the payload is "c1" plus the
title's UTF-8 bytes in unpadded base64url (at most 46 bytes). Home
Assistant builds it with base64_encode and two replaces; see DOCS.md.

The title is untrusted text: it is decoded strictly, cleaned of control
characters, capped, and escaped before he sees it. A link only opens a
conversation. It never starts an action and never reaches a model on its
own -- what happens next is whatever he writes.
"""
from __future__ import annotations

import base64
import binascii
import re

PREFIX = "c1"
MAX_BYTES = 46
MAX_TITLE = 60
_PAYLOAD = re.compile(r"[A-Za-z0-9_-]{1,62}")          # 62 base64 chars = 46 bytes


def encode(title: str) -> str:
    t = title
    while len(t.encode("utf-8")) > MAX_BYTES:
        t = t[:-1]
    return PREFIX + base64.urlsafe_b64encode(t.encode("utf-8")).decode().rstrip("=")


def decode(arg: str) -> str | None:
    """The card title, or None if this isn't a card link."""
    arg = (arg or "").strip()
    if not arg.startswith(PREFIX) or not _PAYLOAD.fullmatch(arg[len(PREFIX):]):
        return None
    body = arg[len(PREFIX):]
    try:
        raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    except (binascii.Error, ValueError):
        return None
    # A title cut mid-character by the byte limit loses only that character.
    text = raw.decode("utf-8", "ignore")
    text = "".join(ch if ch.isprintable() else " " for ch in text)
    text = " ".join(text.split())[:MAX_TITLE]
    return text or None
