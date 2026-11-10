"""The harness's chat, handed to Cain: the shape its outbox and buttons already use.

Everything the harness says goes through the outbox, and every button tap
through callbacks. Both were written against a small chat interface:
send_message, edit_reply_markup and answer_callback. This is that interface,
but nothing goes to Dane directly: each message becomes a card handed to Cain's
link (cain_relay.py), which holds it until Cain shows it, unchanged.

- "chat id" keeps meaning "his chat": the owner's id. The message id it
  returns is the card's id; taps come back with it (controller._press).
- Text is written as simple HTML (<b>, <i>, escaped entities); it is
  turned into Discord markdown, with everything that was text escaped so an
  event title can't format, link or ping.
- Each button's id is the harness's callback data with a "k:" prefix, so
  Cain's plugin, which only answers its own "perm:" buttons, leaves them alone.
- A Stop button rides along with every set of buttons and on the digest. When
  stopped, a Turn back on button takes its place.
- Stop's notices and the 7:40 digest fallback are "direct": the link posts them
  at once, because they exist for when Cain can't be relied on.
"""
from __future__ import annotations

import html
import re
from typing import Callable

from .cain_relay import CainLink, LinkError
from .chat import ChatError
from .discord_api import PRIMARY, components, escape

PREFIX = "k:"
STOP, RESUME = "k:stop", "k:resume"
TOGGLE_KINDS = ("digest", "stopped", "resumed", "alert")   # carry Stop / Turn back on

# The words a few older messages use for commands that don't exist here.
WORDS = (
    ("Send /resume to start again", "Tap Turn back on to start again"),
    ("After /resume, tap", "After you turn me back on, tap"),
    ("Send /resume, then resend it", "Turn me back on, then ask again"),
    ("After /resume", "After you turn me back on"),
    ("until /resume", "until you turn me back on"),
    ("(/resume)", "(Turn back on)"),
    ("/resume", "Turn back on"),
    ("/checkadds", "\"check each change\""),
    ("/stop", "Stop"),
    ("/status", "the Harness page"),
)

_TAG = re.compile(r"<(/?)(b|i)>")


def to_markdown(text: str) -> str:
    """The harness's HTML (only <b> and <i> are used) to Discord markdown."""
    for old, new in WORDS:
        text = text.replace(old, new)
    out, pos = [], 0
    for m in _TAG.finditer(text):
        out.append(escape(html.unescape(re.sub(r"<[^>]+>", "", text[pos:m.start()]))))
        out.append("**" if m.group(2) == "b" else "*")
        pos = m.end()
    out.append(escape(html.unescape(re.sub(r"<[^>]+>", "", text[pos:]))))
    return "".join(out)


def _err(e: LinkError) -> ChatError:
    # The outbox and callbacks know one error shape: code, words. Unreachable is retried.
    return ChatError(e.code if e.code else 503, e.description)


class LinkChat:
    def __init__(self, link: CainLink, *, paused: Callable[[], bool] = lambda: False):
        self.link = link
        self.paused = paused

    def _rows(self, buttons, kind: str | None) -> list[dict]:
        rows = [[(label, PREFIX + data) for label, data in row] for row in (buttons or [])]
        if rows or kind in TOGGLE_KINDS:
            rows.append([("Turn back on", RESUME)] if self.paused() else [("Stop", STOP)])
        return components(rows, styles={"k:a:": PRIMARY})

    def send_message(self, chat_id: int, text: str, buttons=None, *, html: bool = True,
                     kind: str | None = None) -> int:
        content = to_markdown(text) if html else escape(text)
        try:
            return self.link.card(content, self._rows(buttons, kind), kind or "reply")
        except LinkError as e:
            raise _err(e) from None

    def edit_reply_markup(self, chat_id: int, message_id: int, buttons) -> None:
        try:
            self.link.buttons(int(message_id), self._rows(buttons, None) if buttons else [])
        except LinkError as e:
            raise _err(e) from None

    def answer_callback(self, callback_id: str, text: str | None = None) -> None:
        """The link already acknowledged the tap within Discord's 3 seconds. A refusal
        is shown to him alone."""
        if not text or not callback_id or ":" not in callback_id:
            return
        try:
            self.link.answer(callback_id, text)
        except LinkError as e:
            raise _err(e) from None
