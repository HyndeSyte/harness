"""The harness's chat on Discord, in the shape its outbox and buttons already use.

Everything the harness says goes through the outbox, and every button tap
through callbacks. Both were written against a small chat interface:
send_message, edit_reply_markup and answer_callback. This is that interface
on Discord, posting as Cain's bot in his DM.

- "chat id" keeps meaning "his chat": the owner's id. Here it maps to the DM.
- Text is written as Telegram-style HTML (<b>, <i>, escaped entities); it is
  turned into Discord markdown, with everything that was text escaped so an
  event title can't format, link or ping.
- Each button's id is the harness's callback data with a "k:" prefix, so
  Cain's plugin, which only answers its own "perm:" buttons, leaves them alone.
- A Stop button rides along with every set of buttons and on the digest. When
  stopped, a Turn back on button takes its place.
- Every message it posts is remembered with a digest of what it shows, so a
  tap on a message someone changed afterwards (Cain can edit the bot's
  messages) is refused before it reaches anything (discord_keeper.py).
"""
from __future__ import annotations

import html
import re
from typing import Callable

from .discord_api import PRIMARY, DiscordAPI, DiscordError, components, escape
from .telegram_api import TelegramError

PREFIX = "k:"
STOP, RESUME = "k:stop", "k:resume"

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
    """Telegram HTML (only <b> and <i> are used) to Discord markdown."""
    for old, new in WORDS:
        text = text.replace(old, new)
    out, pos = [], 0
    for m in _TAG.finditer(text):
        out.append(escape(html.unescape(re.sub(r"<[^>]+>", "", text[pos:m.start()]))))
        out.append("**" if m.group(2) == "b" else "*")
        pos = m.end()
    out.append(escape(html.unescape(re.sub(r"<[^>]+>", "", text[pos:]))))
    return "".join(out)


def _err(e: DiscordError) -> TelegramError:
    # The outbox and callbacks know one error shape: code, words, retry_after.
    return TelegramError(e.code, e.description, e.retry_after)


class DiscordChat:
    def __init__(self, api: DiscordAPI, keeper, *, paused: Callable[[], bool] = lambda: False):
        self.api = api
        self.keeper = keeper          # where the DM is, and what each message showed
        self.paused = paused

    def _rows(self, buttons, kind: str | None) -> list[dict]:
        rows = [[(label, PREFIX + data) for label, data in row] for row in (buttons or [])]
        if rows or kind in ("digest", "stopped"):
            rows.append([("Turn back on", RESUME)] if self.paused() else [("Stop", STOP)])
        return components(rows, styles={"k:a:": PRIMARY})

    def send_message(self, chat_id: int, text: str, buttons=None, *, html: bool = True,
                     kind: str | None = None) -> int:
        content = to_markdown(text) if html else escape(text)
        try:
            msg = self.api.send(self.keeper.dm(), content, self._rows(buttons, kind))
        except DiscordError as e:
            raise _err(e) from None
        self.keeper.remember(msg)
        return int(msg["id"])

    def post(self, text: str, buttons=None) -> int:
        """Something the keeper itself says (stopped, turned back on)."""
        return self.send_message(0, text, buttons, kind="notice")

    def edit_reply_markup(self, chat_id: int, message_id: int, buttons) -> None:
        try:
            msg = self.api.edit(self.keeper.dm(), str(message_id),
                                rows=self._rows(buttons, None) if buttons else [])
        except DiscordError as e:
            raise _err(e) from None
        if isinstance(msg, dict):
            self.keeper.remember(msg)

    def answer_callback(self, callback_id: str, text: str | None = None) -> None:
        """The press was already acknowledged on the gateway thread, within Discord's
        3 seconds. A refusal is shown to him alone."""
        if not text or not callback_id or ":" not in callback_id:
            return
        app, token = callback_id.split(":", 1)
        try:
            self.api.followup(app, token, text)
        except DiscordError as e:
            raise _err(e) from None
