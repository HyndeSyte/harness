"""Who the calendar specialist works for on Discord, and its own small record.

The specialist has no Discord connection of its own: Cain's link holds it, and
cards go through Cain (cain_relay.py, discord_chat.py). It keeps the bot's
identity here, so it can read Dane's DM itself when Cain hands a request over
and know whose words are his. The record is its own file, not the ledger, so
any thread may read it.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from typing import Callable

from .discord_api import DiscordAPI, DiscordError


class KeeperStore:
    """The keeper's own small record (/data/discord.json): owner, DM, cards.

    Not the ledger: the ledger's SQLite connection belongs to the main thread,
    and Cain's handovers arrive on their own threads. Locked, written atomically, 0600.
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
        self.wake = threading.Event()        # set when there's something for the controller

    def _cached(self, key: str, fetch) -> str | None:
        cached = self._get(key)
        if cached:
            return cached
        value = fetch()
        if value:
            self._set(key, value)
        return value

    def owner(self) -> str | None:
        return self._cached("discord_owner", self.api.owner_id)

    def bot(self) -> str | None:
        return self._cached("discord_bot", self.api.bot_id)

    def dm(self) -> str:
        def fetch():
            owner = self.owner()
            if not owner:
                raise DiscordError(0, "the bot's owner is unknown")
            return self.api.dm_channel(owner)
        return self._cached("discord_dm", fetch)

    def forget_identity(self) -> None:
        """A new token may be a new bot: look everything up again."""
        for k in ("discord_owner", "discord_bot", "discord_dm"):
            self._set(k, "")
