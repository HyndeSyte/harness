"""The shapes his chat input and the chat's errors take, whatever carries them.

Discord (through Cain, discord_chat.py and controller._press / _handover) turns
his words and taps into an Incoming, records it with ledger.ingest(), and hands
taps to callbacks.Callbacks. The outbox and callbacks know one error: ChatError.
"""
from __future__ import annotations

from dataclasses import dataclass

from .net import REDACT


class ChatError(Exception):
    """A send, edit or answer that didn't go through. Code 0, 429 and 5xx are retried."""

    def __init__(self, code: int, description: str, retry_after: float | None = None):
        self.code = code
        self.description = REDACT(description)[:300]
        self.retry_after = retry_after
        super().__init__(f"chat {code}: {self.description}")

    @property
    def retryable(self) -> bool:
        return self.code == 429 or self.code >= 500 or self.code == 0


@dataclass(frozen=True)
class Incoming:
    update_id: int
    kind: str                    # "message" | "callback" | "other"
    user_id: int | None = None
    is_bot: bool = False
    chat_id: int | None = None
    chat_type: str | None = None
    message_id: int | None = None
    text: str | None = None
    reply_to_message_id: int | None = None
    forwarded: bool = False
    callback_id: str | None = None
    callback_data: str | None = None


@dataclass(frozen=True)
class Decision:
    incoming: Incoming
    accepted: bool
    reason: str | None
    job_kind: str | None         # "message" | "command" | None (callbacks)
