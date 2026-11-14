"""The calendar specialist's line to Cain's link (the Cain add-on, link/main.ts).

Cain is the gatekeeper: this add-on never posts to Dane itself. Every card it
makes goes to Cain's link, which holds it until Cain shows it unchanged (only
Stop notices and the 7:40 digest fallback go straight out). The other exception
is the mutual watch's "Cain's add-on is down" and "back" messages (watch.py),
which can't count on Cain. Taps on its cards
come back to handover.py /press, already checked by the link.

Local only: the add-ons' own network on the Pi. Both add-ons hold the bot token, and only
their root sides can derive the signing key from it.

Signed both ways, the key never sent (Harness 0.24.0, with Cain 0.12.0): Cain's session
runs as its own user since then, and could hold the link's port while the link restarts.
A request carries x-harness-sig: id=<its id>,t=<ms>,s=HMAC(K_sign, "request", method,
path, id, t, body); the link answers with x-harness-sig: s=HMAC(K_sign, "response", id,
status, body). An answer without a good signature is no answer: retried like one that
never came. K_sign = HMAC(bot token, "harness-link-sign-v2") is not the old relay key,
HMAC(bot token, "harness-relay-v1"), which 0.23.0 sent as a header: a captured old key
signs nothing (C1 plan 3.9). One operation keeps one id across every retry: a card's comes
from its outbox row (the outbox adds a "Delayed" line after 10 minutes, so its body
changes), anything else's from the request itself; the link does each id once.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import logging
import time
from typing import Callable
from urllib.parse import quote

log = logging.getLogger("harness.link")

HOST, PORT = "0fcc2575-cain", 8097
KEY_CONTEXT = b"harness-relay-v1"          # the old key: 0.24.0 never sends or signs with it
SIGN_CONTEXT = b"harness-link-sign-v2"
SIG_HEADER = "x-harness-sig"


def key_for(token: str) -> str:
    """The old relay key (Harness 0.23.0's header). Kept only for the tests' vectors."""
    return hmac.new(token.encode(), KEY_CONTEXT, hashlib.sha256).hexdigest()


def sign_key_for(token: str) -> str:
    """K_sign: what both sides sign with, domain-separated from the old key."""
    return hmac.new(token.encode(), SIGN_CONTEXT, hashlib.sha256).hexdigest()


def _mac(key: str, parts: list) -> str:
    return hmac.new(key.encode(), "\n".join(str(p) for p in parts).encode(), hashlib.sha256).hexdigest()


def request_id(method: str, path: str, body: str, op: str | None = None) -> str:
    """One operation's id, kept across its retries: from its operation key when it has one
    (an outbox row), else from the request itself (link/auth.ts requestId)."""
    if op:
        return hashlib.sha256(f"op\n{method.upper()}\n{path}\n{op}".encode()).hexdigest()[:32]
    return hashlib.sha256(f"{method.upper()}\n{path}\n{body}".encode()).hexdigest()[:32]


def sign_request(key: str, method: str, path: str, body: str, t: int | None = None,
                 op: str | None = None) -> tuple[str, str]:
    """The request's id and its x-harness-sig header."""
    rid = request_id(method, path, body, op)
    t = int(time.time() * 1000) if t is None else t
    return rid, f"id={rid},t={t},s={_mac(key, ['request', method.upper(), path, rid, t, body])}"


def sign_response(key: str, rid: str, status: int, body: str) -> str:
    return "s=" + _mac(key, ["response", rid, status, body])


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
              timeout: float | None = None, op: str | None = None):
        token = self._token_fn()
        if not token:
            raise LinkError(0, "no bot token set")
        key = sign_key_for(token)
        text = json.dumps(body) if body is not None else ""
        rid, sig = sign_request(key, method, path, text, op=op)
        try:
            c = http.client.HTTPConnection(self.host, self.port,
                                           timeout=timeout or self.timeout)
            c.request(method, path, body=text.encode() if body is not None else None,
                      headers={"content-type": "application/json", SIG_HEADER: sig})
            r = c.getresponse()
            raw = r.read()
            got = r.getheader(SIG_HEADER) or ""
            c.close()
        except (OSError, http.client.HTTPException) as e:
            # A broken answer (BadStatusLine, IncompleteRead) is the link failing too: tried again
            # later like no answer, never a stop that strands the outbox (Nov 11 review).
            raise LinkError(0, type(e).__name__) from None
        # Only the link can sign its answer: anything else holding its port isn't it.
        if not hmac.compare_digest(got, sign_response(key, rid, r.status, raw.decode("utf-8", "replace"))):
            raise LinkError(0, "an answer the link didn't sign")
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            data = {}
        if r.status >= 400:
            raise LinkError(r.status, str(data.get("said") or data.get("status") or ""))
        return data

    def card(self, text: str, rows: list, kind: str, *, expires: str | None = None,
             op: str | None = None) -> int:
        """A card for Cain to show. `expires` (ISO time): when its buttons lapse, so the link takes
        them off then instead of leaving dead buttons for days (Cain 0.7.0; older links ignore it).
        `op`: the operation it is (its outbox row), so every retry is the same request to the link."""
        body = {"text": text, "rows": rows, "kind": kind}
        if expires:
            body["expires"] = expires
        out = self._call("POST", "/card", body, op=op)
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
