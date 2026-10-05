"""The real Telegram Bot API client, over net.Transport.

Facts it relies on (core.telegram.org/bots/api, read 2026-10-05, Bot API
10.3): getUpdates confirms everything below the offset passed and keeps
undelivered updates for at most 24 hours; allowed_updates persists, so it
is sent on every call; sendMessage text is 1-4096 characters after entity
parsing and returns the sent Message; callback_data is 1-64 bytes;
link_preview_options replaced disable_web_page_preview; a 429 carries
parameters.retry_after; answerCallbackQuery must be called or his client
shows a spinner.
"""
from __future__ import annotations

from typing import Any, Callable

from .net import REDACT, Transport, TransportError

BASE = "https://api.telegram.org"


class TelegramError(Exception):
    def __init__(self, code: int, description: str, retry_after: float | None = None):
        self.code = code
        self.description = REDACT(description)[:300]
        self.retry_after = retry_after
        super().__init__(f"telegram {code}: {self.description}")

    @property
    def retryable(self) -> bool:
        return self.code == 429 or self.code >= 500 or self.code == 0


def _markup(buttons: list[list[tuple[str, str]]] | None) -> dict:
    return {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in row]
                                for row in (buttons or [])]}


class TelegramBotAPI:
    def __init__(self, token_fn: Callable[[], str], transport: Transport, *,
                 base: str = BASE):
        self._token_fn = token_fn
        self._t = transport
        self._base = base.rstrip("/")

    def _call(self, method: str, payload: dict, *, timeout: float = 30) -> Any:
        token = self._token_fn()
        if not token:
            raise TelegramError(0, "no bot token set")
        REDACT.register(token)
        url = f"{self._base}/bot{token}/{method}"
        try:
            resp = self._t.request("POST", url, json_body=payload, timeout=timeout)
        except TransportError as e:
            raise TelegramError(0, str(e)) from None
        try:
            data = resp.json()
        except Exception:
            raise TelegramError(resp.status, f"non-JSON reply ({resp.status})") from None
        if not isinstance(data, dict):
            raise TelegramError(resp.status, f"unexpected reply ({resp.status})")
        if not data.get("ok"):
            params = data.get("parameters") if isinstance(data.get("parameters"), dict) else {}
            retry = params.get("retry_after")
            code = data.get("error_code") or resp.status
            raise TelegramError(int(code), str(data.get("description", "")),
                                float(retry) if isinstance(retry, (int, float)) else None)
        return data.get("result")

    # -- the BotAPI protocol ---------------------------------------------
    def get_updates(self, offset: int, timeout: int,
                    allowed_updates: tuple[str, ...]) -> list[dict]:
        payload = {"timeout": int(timeout), "allowed_updates": list(allowed_updates)}
        if offset:
            payload["offset"] = int(offset)
        result = self._call("getUpdates", payload, timeout=timeout + 15)
        return result if isinstance(result, list) else []

    def send_message(self, chat_id: int, text: str,
                     buttons: list[list[tuple[str, str]]] | None = None, *,
                     html: bool = True) -> int:
        payload: dict = {"chat_id": chat_id, "text": text,
                         "link_preview_options": {"is_disabled": True}}
        if html:
            payload["parse_mode"] = "HTML"
        if buttons:
            payload["reply_markup"] = _markup(buttons)
        result = self._call("sendMessage", payload)
        mid = (result or {}).get("message_id") if isinstance(result, dict) else None
        if not isinstance(mid, int):
            raise TelegramError(0, "sendMessage returned no message id")
        return mid

    def edit_reply_markup(self, chat_id: int, message_id: int,
                          buttons: list[list[tuple[str, str]]] | None) -> None:
        self._call("editMessageReplyMarkup", {"chat_id": chat_id, "message_id": message_id,
                                              "reply_markup": _markup(buttons)})

    def answer_callback(self, callback_id: str, text: str | None = None) -> None:
        payload: dict = {"callback_query_id": callback_id}
        if text:
            payload["text"] = text[:200]
        self._call("answerCallbackQuery", payload)

    # -- set-up and health -------------------------------------------------
    def get_me(self) -> dict:
        return self._call("getMe", {}) or {}

    def get_webhook_info(self) -> dict:
        return self._call("getWebhookInfo", {}) or {}

    def set_my_commands(self, commands: list[tuple[str, str]], chat_id: int) -> None:
        self._call("setMyCommands", {
            "commands": [{"command": c, "description": d} for c, d in commands],
            "scope": {"type": "chat", "chat_id": chat_id}})
