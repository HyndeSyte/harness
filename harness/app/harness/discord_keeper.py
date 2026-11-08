"""The calendar keeper's place in his Discord DM, as Cain.

It posts under Cain's bot in the owner's DM and hears presses on its own
buttons over its own gateway connection (discord_gateway.py). Every press is
checked here, in code:
- it's the owner (the bot's owner), in the DM with him, not a server;
- the button is one of the keeper's ("k:" ids) and the card is one it posted;
- the card still shows exactly what it posted (Cain can edit the bot's
  messages, so a rewritten card is refused);
- the card hasn't been used, and hasn't expired.
Presses on buttons that aren't the keeper's (Cain's own "perm:" buttons) are
left alone: Cain's plugin answers those.

Stage 1 (this file today): the probe. On first connection it posts one test
card; a press on it proves two connections on one bot, the owner check, the
card check and the 3-second answer, on the Pi.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import tempfile
import threading
import time
from typing import Callable

from .discord_api import PRIMARY, DiscordAPI, DiscordError, card_digest, components

log = logging.getLogger("harness.discord")

PREFIX = "k:"
COMPONENT = 3            # interaction type: a button press
UPDATE, ACK = 7, 6       # answer kinds


class KeeperStore:
    """The keeper's own small record (/data/discord.json): owner, DM, cards.

    Not the ledger: the ledger's SQLite connection belongs to the main thread,
    and presses arrive on the gateway thread. Locked, written atomically, 0600.
    """

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()

    def _load(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, ValueError):
            return {}

    def get(self, key: str) -> str | None:
        with self._lock:
            return self._load().get(key)

    def set(self, key: str, value: str) -> None:
        with self._lock:
            data = self._load()
            data[key] = value
            d = os.path.dirname(os.path.abspath(self.path))
            fd, tmp = tempfile.mkstemp(dir=d, prefix=".discord.", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, sort_keys=True)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except FileNotFoundError:
                    pass
                raise


class DiscordKeeper:
    def __init__(self, api: DiscordAPI, get_meta: Callable[[str], str | None],
                 set_meta: Callable[[str, str], None], *, clock=time.time):
        self.api = api
        self._get = get_meta
        self._set = set_meta
        self._clock = clock
        self._lock = threading.Lock()
        self.status: dict = {"gateway": "off"}

    # -- identity ------------------------------------------------------------
    def owner(self) -> str | None:
        cached = self._get("discord_owner")
        if cached:
            return cached
        oid = self.api.owner_id()
        if oid:
            self._set("discord_owner", oid)
        return oid

    def dm(self) -> str:
        cached = self._get("discord_dm")
        if cached:
            return cached
        owner = self.owner()
        if not owner:
            raise DiscordError(0, "the bot's owner is unknown")
        ch = self.api.dm_channel(owner)
        self._set("discord_dm", ch)
        return ch

    # -- cards ---------------------------------------------------------------
    def post_card(self, kind: str, text: str, buttons: list[tuple[str, str]], *,
                  ttl_s: int, data: dict | None = None) -> str:
        """Post a card; buttons are (label, action). Returns the message id."""
        nonce = secrets.token_urlsafe(9)
        rows = components([[(label, f"{PREFIX}{nonce}:{action}") for label, action in buttons]],
                          styles={f"{PREFIX}{nonce}:approve": PRIMARY})
        msg = self.api.send(self.dm(), text, rows)
        card = {"kind": kind, "nonce": nonce, "message_id": str(msg["id"]),
                "digest": card_digest(msg.get("content", ""), msg.get("components")),
                "expires": self._clock() + ttl_s, "used": False, "data": data or {}}
        self._set(f"discord_card:{nonce}", json.dumps(card))
        return str(msg["id"])

    def _check(self, it: dict) -> tuple[dict | None, str, str]:
        """(card, action, refusal). card is None when refused."""
        data = it.get("data") or {}
        cid = str(data.get("custom_id", ""))
        _, nonce, action = (cid.split(":", 2) + ["", ""])[:3]
        user = (it.get("user") or (it.get("member") or {}).get("user") or {}).get("id")
        if it.get("guild_id") or it.get("member"):
            return None, action, "not in the DM"
        if not user or str(user) != self.owner():
            return None, action, "not the owner"
        if str(it.get("channel_id", "")) != self.dm():
            return None, action, "not the DM"
        raw = self._get(f"discord_card:{nonce}")
        if not raw:
            return None, action, "unknown card"
        card = json.loads(raw)
        msg = it.get("message") or {}
        if str(msg.get("id")) != card["message_id"]:
            return None, action, "wrong message"
        if card_digest(msg.get("content", ""), msg.get("components")) != card["digest"]:
            return None, action, "card was changed after it was posted"
        if card["used"]:
            return None, action, "already used"
        if self._clock() > card["expires"]:
            return None, action, "expired"
        return card, action, ""

    def on_interaction(self, it: dict) -> None:
        """Called on the gateway thread. Answers within 3 seconds."""
        if it.get("type") != COMPONENT:
            return
        cid = str((it.get("data") or {}).get("custom_id", ""))
        if not cid.startswith(PREFIX):
            return                                    # not ours: Cain's plugin answers it
        with self._lock:
            try:
                card, action, refusal = self._check(it)
            except DiscordError as e:
                card, action, refusal = None, "", f"check failed: {e.code}"
            if card is None:
                log.warning("discord: press refused: %s", refusal)
                self.status["last_press"] = f"refused: {refusal}"
                self._answer(it, ACK)
                return
            card["used"] = True
            self._set(f"discord_card:{card['nonce']}", json.dumps(card))
        content = (it.get("message") or {}).get("content", "")
        self._answer(it, UPDATE, {"content": f"{content}\n\nDone: {self._label(action)}.",
                                  "components": [], "allowed_mentions": {"parse": []}})
        self.status["last_press"] = f"{card['kind']}: {action}"
        log.info("discord: press accepted (%s, %s)", card["kind"], action)

    @staticmethod
    def _label(action: str) -> str:
        return {"approve": "approved", "decline": "declined", "ok": "heard"}.get(action, action)

    def _answer(self, it: dict, kind: int, data: dict | None = None) -> None:
        try:
            self.api.answer(str(it.get("id")), str(it.get("token")), kind, data)
        except DiscordError as e:
            log.error("discord: could not answer the press in time: %s", e.code)

    # -- stage 1 probe -------------------------------------------------------
    def on_state(self, state: str) -> None:
        self.status["gateway"] = state
        log.info("discord: connection %s", state)
        if state == "ready" and not self._get("discord_probe"):
            threading.Thread(target=self._probe, name="discord-probe", daemon=True).start()

    def _probe(self) -> None:
        try:
            mid = self.post_card(
                "probe", "Calendar keeper: connected to Discord. Tap the button so I can check "
                "that your taps reach me. Nothing else happens.",
                [("Tap to test", "ok")], ttl_s=7 * 86400)
            self._set("discord_probe", mid)
            log.info("discord: probe card posted")
        except DiscordError as e:
            log.error("discord: probe card failed: %s", e.code)
