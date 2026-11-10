"""Discord REST client for the calendar keeper, over its own narrow transport.

Facts it relies on (discord.com/developers/docs, API v10):
- Bot calls carry "Authorization: Bot <token>"; interaction callbacks are
  answered at /interactions/{id}/{token}/callback with the interaction's own
  token, and must be answered within 3 seconds.
- A message is at most 2000 characters. allowed_mentions {"parse": []} stops
  any @everyone, role or user ping; flag 4 (SUPPRESS_EMBEDS) stops link previews.
- Buttons are components: an action row (type 1) of up to 5 buttons (type 2),
  custom_id at most 100 characters.
- A 429 carries retry_after (seconds) in the JSON body.
- GET /oauth2/applications/@me names the bot's owner (or its team's owner).

The keeper uses Cain's bot. It only ever talks in the owner's DM.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable
from urllib.parse import urlsplit

from .net import REDACT, HttpResponse, Transport, TransportError, UrllibTransport

BASE = "https://discord.com/api/v10"
HOSTS = frozenset({"discord.com"})
LIMIT = 2000
SUPPRESS_EMBEDS = 1 << 2
TOKEN_FORMAT = re.compile(r"[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{5,10}\.[A-Za-z0-9_-]{25,60}")

# Button styles.
PRIMARY, SECONDARY, SUCCESS, DANGER = 1, 2, 3, 4


class DiscordTransport(UrllibTransport):
    """Https to discord.com only, no redirects, no proxy. The only transport
    that carries the bot token. Anything else never leaves."""

    METHODS = frozenset({"GET", "POST", "PATCH", "DELETE"})

    def __init__(self, *, cafile: str | None = None):
        super().__init__(use_env_proxy=False, cafile=cafile, follow_redirects=False)

    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=20):
        try:
            parts = urlsplit(url)
            plain_host = parts.username is None and parts.port is None
        except ValueError:
            raise TransportError("blocked") from None
        if (method not in self.METHODS or parts.scheme != "https" or not plain_host
                or parts.hostname not in HOSTS):
            raise TransportError("blocked")
        return super().request(method, url, headers=headers, json_body=json_body,
                               body=body, timeout=timeout)


class DiscordError(Exception):
    def __init__(self, code: int, description: str, retry_after: float | None = None):
        self.code = code
        self.description = REDACT(description)[:300]
        self.retry_after = retry_after
        super().__init__(f"discord {code}: {self.description}")

    @property
    def retryable(self) -> bool:
        return self.code == 429 or self.code >= 500 or self.code == 0


def escape(text: str) -> str:
    """Event titles and his words go into messages as plain text: no markdown,
    no masked links. Mentions are already off (allowed_mentions)."""
    return re.sub(r"([\\*_~`|>\[\]()#-])", r"\\\1", text)


def fit(text: str, limit: int = LIMIT) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 2].rstrip() + " …"


def components(buttons: list[list[tuple[str, str]]] | None,
               styles: dict[str, int] | None = None) -> list[dict]:
    """[[(label, custom_id), ...], ...] -> action rows. styles maps a custom_id
    prefix to a button style; default secondary."""
    rows = []
    for row in buttons or []:
        items = []
        for label, cid in row[:5]:
            style = SECONDARY
            for prefix, s in (styles or {}).items():
                if cid.startswith(prefix):
                    style = s
            items.append({"type": 2, "style": style, "label": label[:80], "custom_id": cid[:100]})
        if items:
            rows.append({"type": 1, "components": items})
    return rows[:5]


class DiscordAPI:
    def __init__(self, token_fn: Callable[[], str], transport: Transport, *, base: str = BASE):
        self._token_fn = token_fn
        self._t = transport
        self._base = base.rstrip("/")

    def configured(self) -> bool:
        return bool(self._token_fn())

    def _call(self, method: str, path: str, payload: Any = None, *, auth: bool = True,
              timeout: float = 20) -> Any:
        headers = {"user-agent": "DiscordBot (https://github.com/HyndeSyte/harness, 1)"}
        if auth:
            token = self._token_fn()
            if not token:
                raise DiscordError(0, "no bot token set")
            REDACT.register(token)
            headers["authorization"] = f"Bot {token}"
        try:
            resp: HttpResponse = self._t.request(method, f"{self._base}{path}", headers=headers,
                                                 json_body=payload, timeout=timeout)
        except TransportError as e:
            raise DiscordError(0, str(e)) from None
        if resp.status == 204:
            return None
        try:
            data = resp.json() if resp.body else None
        except Exception:
            raise DiscordError(resp.status, f"non-JSON reply ({resp.status})") from None
        if resp.status >= 400:
            retry = data.get("retry_after") if isinstance(data, dict) else None
            msg = data.get("message", "") if isinstance(data, dict) else ""
            raise DiscordError(resp.status, str(msg),
                               float(retry) if isinstance(retry, (int, float)) else None)
        return data

    # -- identity ------------------------------------------------------------
    def owner_id(self) -> str | None:
        """The person who owns the bot: the owner, or a team's owner."""
        app = self._call("GET", "/oauth2/applications/@me")
        if not isinstance(app, dict):
            return None
        team = app.get("team")
        if isinstance(team, dict) and team.get("owner_user_id"):
            return str(team["owner_user_id"])
        owner = app.get("owner")
        return str(owner["id"]) if isinstance(owner, dict) and owner.get("id") else None

    def bot_id(self) -> str | None:
        me = self._call("GET", "/users/@me")
        return str(me["id"]) if isinstance(me, dict) and me.get("id") else None

    def dm_channel(self, user_id: str) -> str:
        ch = self._call("POST", "/users/@me/channels", {"recipient_id": str(user_id)})
        if not isinstance(ch, dict) or not ch.get("id"):
            raise DiscordError(0, "no DM channel returned")
        return str(ch["id"])

    # -- messages ------------------------------------------------------------
    def send(self, channel_id: str, text: str, rows: list[dict] | None = None, *,
             timeout: float = 20) -> dict:
        payload = {"content": fit(text), "allowed_mentions": {"parse": []},
                   "flags": SUPPRESS_EMBEDS}
        if rows:
            payload["components"] = rows
        msg = self._call("POST", f"/channels/{channel_id}/messages", payload, timeout=timeout)
        if not isinstance(msg, dict) or not msg.get("id"):
            raise DiscordError(0, "no message returned")
        return msg

    def edit(self, channel_id: str, message_id: str, *, text: str | None = None,
             rows: list[dict] | None = None) -> dict:
        payload: dict = {"allowed_mentions": {"parse": []}}
        if text is not None:
            payload["content"] = fit(text)
        if rows is not None:
            payload["components"] = rows
        return self._call("PATCH", f"/channels/{channel_id}/messages/{message_id}", payload)

    def message(self, channel_id: str, message_id: str) -> dict:
        return self._call("GET", f"/channels/{channel_id}/messages/{message_id}")

    def history(self, channel_id: str, limit: int = 20) -> list[dict]:
        out = self._call("GET", f"/channels/{channel_id}/messages?limit={max(1, min(limit, 100))}")
        return out if isinstance(out, list) else []

    # -- interactions --------------------------------------------------------
    def answer(self, interaction_id: str, interaction_token: str, kind: int,
               data: dict | None = None) -> None:
        """kind 6 = acknowledge with no change; 7 = update the card it came from."""
        body: dict = {"type": kind}
        if data is not None:
            body["data"] = data
        REDACT.register(interaction_token)
        self._call("POST", f"/interactions/{interaction_id}/{interaction_token}/callback", body,
                   auth=False, timeout=3)

    def followup(self, application_id: str, interaction_token: str, text: str) -> None:
        """A short note after a press, shown only to him (ephemeral, flag 64). The
        interaction's token is good for 15 minutes."""
        REDACT.register(interaction_token)
        self._call("POST", f"/webhooks/{application_id}/{interaction_token}",
                   {"content": fit(text), "flags": 64, "allowed_mentions": {"parse": []}},
                   auth=False, timeout=10)


def check_token(value: str) -> bool:
    return bool(TOKEN_FORMAT.fullmatch(value.strip()))


def card_digest(text: str, rows: list[dict] | None) -> str:
    """What a card shows, reduced to a stable hash: its text and its buttons'
    labels and ids. A press counts only if the card still shows this."""
    import hashlib
    shown = {"t": text, "b": [[(c.get("label"), c.get("custom_id")) for c in r.get("components", [])]
                              for r in (rows or [])]}
    return hashlib.sha256(json.dumps(shown, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
