"""Telegram ingress: parse, decide, record. Owner-only by construction.

The bot is public: anyone who finds its username can message it. So the
controller -- not Home Assistant, not a prompt -- decides what counts:

  * only `message` and `callback_query` updates are requested at all
    (`allowed_updates`), and anything else that arrives is ignored;
  * the sender must be his Telegram user id, the chat must be his private
    chat with the bot (a private chat's id equals the user's id), and the
    sender must not be a bot;
  * a message must carry text. Photos, files and forwards are refused
    until a job type exists for them.

Rejected updates are recorded by id and reason only. Their text is never
stored, so a stranger's message cannot reach a model, the ledger, or him.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable, Protocol

ALLOWED_UPDATES = ("message", "callback_query")

COMMANDS = frozenset({"/stop", "/resume", "/cancel", "/status", "/rule", "/undo",
                      "/start"})


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


def parse(update: dict[str, Any]) -> Incoming:
    uid = int(update["update_id"])
    if "message" in update:
        m = update["message"] or {}
        frm = m.get("from") or {}
        chat = m.get("chat") or {}
        reply = m.get("reply_to_message") or {}
        return Incoming(
            update_id=uid, kind="message",
            user_id=frm.get("id"), is_bot=bool(frm.get("is_bot")),
            chat_id=chat.get("id"), chat_type=chat.get("type"),
            message_id=m.get("message_id"),
            text=m.get("text"),
            reply_to_message_id=reply.get("message_id"),
            forwarded=any(k in m for k in ("forward_origin", "forward_from",
                                           "forward_from_chat", "forward_date")),
        )
    if "callback_query" in update:
        q = update["callback_query"] or {}
        frm = q.get("from") or {}
        msg = q.get("message") or {}
        chat = msg.get("chat") or {}
        return Incoming(
            update_id=uid, kind="callback",
            user_id=frm.get("id"), is_bot=bool(frm.get("is_bot")),
            chat_id=chat.get("id"), chat_type=chat.get("type"),
            message_id=msg.get("message_id"),
            callback_id=q.get("id"), callback_data=q.get("data"),
        )
    return Incoming(update_id=uid, kind="other")


def decide(inc: Incoming, owner_user_id: int) -> Decision:
    def no(reason: str) -> Decision:
        return Decision(inc, False, reason, None)

    if inc.kind == "other":
        return no("unsupported update type")
    if inc.is_bot:
        return no("sender is a bot")
    if inc.user_id != owner_user_id:
        return no("not the owner")
    if inc.chat_type != "private" or inc.chat_id != owner_user_id:
        return no("not his private chat")
    if inc.kind == "callback":
        if not inc.callback_data or not inc.callback_id or inc.message_id is None:
            return no("malformed callback")
        return Decision(inc, True, None, None)
    # a message
    if inc.message_id is None:
        return no("message without id")
    if inc.forwarded:
        # Forwarded content is someone else's words wearing his chat. It
        # gets its own job type later, with provenance; until then, no.
        return no("forwarded message")
    text = inc.text
    if not text or not text.strip():
        return no("no text")
    first = text.strip().split(maxsplit=1)[0].lower()
    if first.startswith("/"):
        name = first.split("@", 1)[0]
        if name in COMMANDS:
            return Decision(inc, True, None, "command")
        return no("unknown command")
    return Decision(inc, True, None, "message")


class BotAPI(Protocol):
    """The four Bot API calls the controller makes. The real client lives
    behind this so every test runs without a network or a token."""
    def get_updates(self, offset: int, timeout: int,
                    allowed_updates: tuple[str, ...]) -> list[dict]: ...
    def send_message(self, chat_id: int, text: str,
                     buttons: list[list[tuple[str, str]]] | None = None, *,
                     html: bool = True) -> int: ...
    def edit_reply_markup(self, chat_id: int, message_id: int,
                          buttons: list[list[tuple[str, str]]] | None) -> None: ...
    def answer_callback(self, callback_id: str, text: str | None = None) -> None: ...


# Telegram: "If there are no new updates for at least a week, then
# identifier of the next update will be chosen randomly instead of
# sequentially." After a quiet spell the stored offset may sit above the
# next id, and polling with it would confirm -- drop -- his next message.
# So after six quiet days the poll asks for the earliest unconfirmed update
# instead (offset omitted), and the ledger accepts the offset moving back.
IDLE_RESET_AFTER = timedelta(days=6)


def poll_once(api: BotAPI, ledger, owner_user_id: int, *, timeout: int = 25,
              screen: Callable[[Incoming], str | None] | None = None,
              decide_fn: Callable[[Incoming], Decision] | None = None):
    """One long-poll. Returns (decisions, new_job_ids).

    The offset sent is the ledger's; the offset stored is advanced only by
    ledger.ingest(), in the same transaction that records the updates.
    `screen` may turn an accepted message into a refusal before anything
    is stored (the work-content filter); its text is then never kept."""
    stored = ledger.telegram_offset()
    last = ledger.last_update_received()
    idle = last is not None and ledger.now() - last >= IDLE_RESET_AFTER
    updates = api.get_updates(offset=0 if idle else stored, timeout=timeout,
                              allowed_updates=ALLOWED_UPDATES)
    decisions = []
    for u in updates:
        inc = parse(u)
        d = decide_fn(inc) if decide_fn else decide(inc, owner_user_id)
        if screen is not None and d.accepted and d.job_kind == "message":
            why = screen(d.incoming)
            if why:
                d = Decision(d.incoming, False, why, None)
        decisions.append(d)
    next_offset = (max(d.incoming.update_id for d in decisions) + 1
                   if decisions else None)
    reset = idle or bool(decisions) and min(d.incoming.update_id for d in decisions) < stored
    new_jobs = ledger.ingest(decisions, next_offset, reset=reset)
    return decisions, new_jobs
