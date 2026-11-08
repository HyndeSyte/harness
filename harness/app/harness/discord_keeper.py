"""The calendar keeper's place in his Discord DM, as Cain.

It posts under Cain's bot in the owner's DM (discord_chat.py) and hears presses
on its own buttons over its own gateway connection (discord_gateway.py). Here,
on the gateway thread and within Discord's 3 seconds, every press is checked:
- it's the owner (the bot's owner), in the DM with him, not a server;
- the button is one of the keeper's ("k:" ids) on a message it posted;
- the message still shows exactly what it posted (Cain can edit the bot's
  messages, so a rewritten card is refused).
A press that passes is acknowledged at once and queued for the controller,
which owns the ledger and applies it: a card's own checks (that tap, on that
card, once, before it expires) are the ledger's, as they always were.
Presses on buttons that aren't the keeper's (Cain's own "perm:" buttons) are
left alone: Cain's plugin answers those.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import tempfile
import threading
import time
from typing import Callable

from .discord_api import DiscordAPI, DiscordError, card_digest

log = logging.getLogger("harness.discord")

PREFIX = "k:"
COMPONENT = 3            # interaction type: a button press
UPDATE, ACK = 7, 6       # answer kinds
REMEMBER_S = 35 * 86400  # longer than any card lives (Undo: 7 days, rules: 30)


def _drain(q: "queue.Queue") -> list:
    out = []
    while True:
        try:
            out.append(q.get_nowait())
        except queue.Empty:
            return out


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
    def __init__(self, api: DiscordAPI, get: Callable[[str], str | None],
                 set_: Callable[[str, str], None], *, clock=time.time):
        self.api = api
        self._get = get
        self._set = set_
        self._clock = clock
        self._lock = threading.Lock()
        self.presses: "queue.Queue[dict]" = queue.Queue()
        self.reactions: "queue.Queue[dict]" = queue.Queue()
        self.wake = threading.Event()        # set when there's something for the controller
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

    def bot(self) -> str | None:
        cached = self._get("discord_bot")
        if cached:
            return cached
        bid = self.api.bot_id()
        if bid:
            self._set("discord_bot", bid)
        return bid

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

    def forget_identity(self) -> None:
        """A new token may be a new bot: look everything up again."""
        for k in ("discord_owner", "discord_bot", "discord_dm"):
            self._set(k, "")

    # -- what each message showed ------------------------------------------------
    def remember(self, msg: dict) -> None:
        """Called after each post or edit, with the message Discord returned."""
        now = self._clock()
        with self._lock:
            raw = self._get("discord_messages")
            shown = json.loads(raw) if raw else {}
            shown = {k: v for k, v in shown.items() if v.get("until", 0) > now}
            shown[str(msg["id"])] = {"digest": card_digest(msg.get("content", ""),
                                                           msg.get("components")),
                                     "until": now + REMEMBER_S}
            self._set("discord_messages", json.dumps(shown))

    def posted(self, message_id: str) -> bool:
        raw = self._get("discord_messages")
        return bool(raw) and str(message_id) in json.loads(raw)

    def _shown(self, message_id: str) -> str | None:
        raw = self._get("discord_messages")
        entry = (json.loads(raw) if raw else {}).get(str(message_id))
        return entry["digest"] if entry and entry.get("until", 0) > self._clock() else None

    # -- presses -------------------------------------------------------------
    def _check(self, it: dict) -> str:
        """Why a press is refused, or "" when it may go on."""
        user = (it.get("user") or (it.get("member") or {}).get("user") or {}).get("id")
        if it.get("guild_id") or it.get("member"):
            return "not in the DM"
        if not user or str(user) != self.owner():
            return "not the owner"
        if str(it.get("channel_id", "")) != self.dm():
            return "not the DM"
        msg = it.get("message") or {}
        digest = self._shown(str(msg.get("id")))
        if digest is None:
            return "not a message the keeper posted"
        if card_digest(msg.get("content", ""), msg.get("components")) != digest:
            return "card was changed after it was posted"
        return ""

    def on_interaction(self, it: dict) -> None:
        """Called on the gateway thread. Answers within 3 seconds."""
        if it.get("type") != COMPONENT:
            return
        cid = str((it.get("data") or {}).get("custom_id", ""))
        if not cid.startswith(PREFIX):
            return                                    # not ours: Cain's plugin answers it
        try:
            refusal = self._check(it)
        except DiscordError as e:
            refusal = f"check failed: {e.code}"
        self._answer(it, ACK)
        if refusal:
            log.warning("discord: press refused: %s", refusal)
            self.status["last_press"] = f"refused: {refusal}"
            return
        self.status["last_press"] = "accepted"
        log.info("discord: press accepted")
        self.presses.put({"id": str(it.get("id")), "token": str(it.get("token")),
                          "app": str(it.get("application_id", "")),
                          "custom_id": cid, "message_id": str((it.get("message") or {}).get("id")),
                          "user": str(self.owner())})
        self.wake.set()

    def _answer(self, it: dict, kind: int, data: dict | None = None) -> None:
        try:
            self.api.answer(str(it.get("id")), str(it.get("token")), kind, data)
        except DiscordError as e:
            log.error("discord: could not answer the press in time: %s", e.code)

    def take_presses(self) -> list[dict]:
        return _drain(self.presses)

    def on_reaction(self, d: dict) -> None:
        """Gateway thread. His reaction in the DM: kept for the controller to pass to
        Cain. Anyone else's, or anywhere else, is dropped."""
        try:
            if d.get("guild_id") or str(d.get("user_id")) != self.owner() \
                    or str(d.get("channel_id")) != self.dm():
                return
        except DiscordError:
            return
        emoji = (d.get("emoji") or {}).get("name") or "?"
        self.reactions.put({"message_id": str(d.get("message_id")), "emoji": str(emoji)[:32]})
        self.wake.set()

    def take_reactions(self) -> list[dict]:
        return _drain(self.reactions)

    def on_state(self, state: str) -> None:
        self.status["gateway"] = state
        log.info("discord: connection %s", state)
        self.wake.set()
