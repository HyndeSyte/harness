"""The calendar specialist's line to Cain's link (the Cain add-on, link/main.ts).

Cain is the gatekeeper: this add-on never posts to Dane itself. Every card it
makes goes to Cain's link, which holds it until Cain shows it unchanged (only
Stop notices and the 7:40 digest fallback go straight out). The other exception
is the mutual watch's "Cain's add-on is down" and "back" messages (watch.py),
which can't count on Cain. Taps on its cards
come back to handover.py /press, already checked by the link.

Local only: the add-ons' own network on the Pi. Keyed with
HMAC-SHA256(bot token, "harness-relay-v1"); both add-ons hold the token.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import logging
from typing import Callable
from urllib.parse import quote

log = logging.getLogger("harness.link")

HOST, PORT = "0fcc2575-cain", 8097
KEY_CONTEXT = b"harness-relay-v1"


def key_for(token: str) -> str:
    return hmac.new(token.encode(), KEY_CONTEXT, hashlib.sha256).hexdigest()


class LinkError(Exception):
    def __init__(self, code: int, description: str):
        self.code = code
        self.description = description
        super().__init__(f"link {code}: {description}")


class CainLink:
    def __init__(self, token_fn: Callable[[], str], *, host: str = HOST, port: int = PORT,
                 timeout: float = 8):
        self._token_fn = token_fn
        self.host, self.port, self.timeout = host, port, timeout

    def _call(self, method: str, path: str, body: dict | None = None, *,
              timeout: float | None = None):
        token = self._token_fn()
        if not token:
            raise LinkError(0, "no bot token set")
        try:
            c = http.client.HTTPConnection(self.host, self.port,
                                           timeout=timeout or self.timeout)
            c.request(method, path, body=json.dumps(body) if body is not None else None,
                      headers={"content-type": "application/json",
                               "x-harness-key": key_for(token)})
            r = c.getresponse()
            raw = r.read()
            c.close()
        except OSError as e:
            raise LinkError(0, type(e).__name__) from None
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            data = {}
        if r.status >= 400:
            raise LinkError(r.status, str(data.get("said") or data.get("status") or ""))
        return data

    def card(self, text: str, rows: list, kind: str) -> int:
        out = self._call("POST", "/card", {"text": text, "rows": rows, "kind": kind})
        if not isinstance(out.get("id"), int):
            raise LinkError(0, "no card id")
        return out["id"]

    def buttons(self, card: int, rows: list) -> None:
        self._call("POST", "/buttons", {"card": card, "rows": rows})

    def answer(self, callback: str, text: str) -> None:
        self._call("POST", "/answer", {"callback": callback, "text": text})

    def card_of(self, message_id: str) -> int | None:
        try:
            out = self._call("GET", f"/card-of?m={quote(str(message_id))}")
        except LinkError:
            return None
        return out.get("card") if isinstance(out.get("card"), int) else None

    def status(self, timeout: float | None = None) -> dict | None:
        """Cain's link's own answer to /health, or None when it doesn't answer. Sent with
        the key: newer links then also say whether their Discord connection is up
        (link/main.ts); without it they say only "ok"."""
        try:
            out = self._call("GET", "/health", timeout=timeout)
        except LinkError:
            return None
        return out if isinstance(out, dict) and out.get("status") == "ok" else None

    def health(self) -> bool:
        return self.status() is not None
