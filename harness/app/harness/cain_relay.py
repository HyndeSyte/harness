"""Passing his taps and reactions to Cain.

Cain's Discord plugin only hears his messages: not presses on buttons, not
reactions. The keeper's connection hears both and checks them (it's him, in the
DM, on the message as posted). This passes what he did to the Cain add-on,
which types it into Cain's session once Cain is idle (cain: relay.ts, checkin.sh).

Local only: the add-ons' own network on the Pi. Keyed like the handover, with
HMAC-SHA256(bot token, "harness-relay-v1"), so nothing else can speak for him.
Short words only: what he chose or the emoji, and a short excerpt of the
message it was on. Never anything from a calendar or mail.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import logging

log = logging.getLogger("harness.relay")

HOST, PORT = "0fcc2575-cain", 8097
KEY_CONTEXT = b"harness-relay-v1"
MAX_TEXT = 600


def key_for(token: str) -> str:
    return hmac.new(token.encode(), KEY_CONTEXT, hashlib.sha256).hexdigest()


def send(token: str, text: str, *, host: str = HOST, port: int = PORT, timeout: float = 10) -> bool:
    if not token:
        return False
    body = json.dumps({"text": text[:MAX_TEXT]})
    try:
        c = http.client.HTTPConnection(host, port, timeout=timeout)
        c.request("POST", "/relay", body=body,
                  headers={"content-type": "application/json", "x-harness-key": key_for(token)})
        status = c.getresponse().status
        c.close()
    except OSError as e:
        log.warning("relay to Cain failed: %s", type(e).__name__)
        return False
    if status != 200:
        log.warning("relay to Cain refused: %s", status)
    return status == 200
