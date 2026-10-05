"""/data/secrets.json: the keys, the paired owner, and nothing else.

The keys are the three API keys and, from S1, his calendars' secret iCal
addresses: each grants read access to something of his, so each is kept,
shown and changed exactly like a key.

Why not add-on options: the Supervisor API can read and rewrite options,
and his Home Assistant connector can call it. /data is mounted only into
this add-on (it does travel in HA backups, which is how a restore brings
it back).

Rules this file keeps:
  * written atomically (temp file, fsync, rename), mode 0600;
  * keys are never returned to the settings page -- only whether each is
    set, and when;
  * the owner is write-once. Re-pairing needs a reset, and a reset is
    announced to the old owner first;
  * after pairing, changing any key is a pending request that only his
    tap in Telegram can apply.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from . import calendar_feed

FIELDS = ("telegram_bot_token", "anthropic_api_key", "openai_api_key", "calendar_feeds")
LABELS = {"telegram_bot_token": "Telegram bot token",
          "anthropic_api_key": "Anthropic API key",
          "openai_api_key": "OpenAI API key",
          "calendar_feeds": "calendar addresses (secret iCal, space between several)"}
# Formats are checked loosely: enough to catch a paste of the wrong thing
# (a URL, a sentence, a key in the wrong box), not a claim about validity.
PATTERNS = {
    "telegram_bot_token": re.compile(r"\d{5,15}:[A-Za-z0-9_-]{30,64}"),
    "anthropic_api_key": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,200}"),
    "openai_api_key": re.compile(r"sk-[A-Za-z0-9_-]{20,250}"),
}
PAIRING_TTL_S = 15 * 60
PAIRING_MAX_FAILURES = 10
CHANGE_TTL_S = 15 * 60


class VaultError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


class Vault:
    def __init__(self, path: str, clock=_now):
        self.path = path
        self.clock = clock
        self._lock = threading.RLock()

    # -- storage ------------------------------------------------------------
    def _load(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}

    def _save(self, data: dict) -> None:
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".secrets.", suffix=".tmp")
        try:
            os.fchmod(fd, 0o600)
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

    def _update(self, fn) -> Any:
        with self._lock:
            data = self._load()
            result = fn(data)
            self._save(data)
            return result

    # -- keys -----------------------------------------------------------------
    def get(self, field: str) -> str:
        with self._lock:
            return (self._load().get("keys", {}).get(field) or {}).get("value", "")

    def key_status(self) -> dict[str, str | None]:
        with self._lock:
            keys = self._load().get("keys", {})
        return {f: (keys.get(f) or {}).get("set_at") for f in FIELDS}

    @staticmethod
    def check_format(field: str, value: str) -> str:
        if field not in FIELDS:
            raise VaultError("unknown field")
        v = (value or "").strip()
        if not v:
            raise VaultError(f"{LABELS[field]} is empty")
        if field == "calendar_feeds":
            try:
                return calendar_feed.check_urls(v)
            except ValueError as e:
                raise VaultError(str(e)) from None
        if not PATTERNS[field].fullmatch(v):
            raise VaultError(f"that doesn't look like a {LABELS[field]}")
        return v

    def set_key(self, field: str, value: str, *, by: str) -> None:
        v = self.check_format(field, value)

        def fn(data):
            data.setdefault("keys", {})[field] = {"value": v, "set_at": self.clock().isoformat(),
                                                   "set_by": by}
        self._update(fn)

    # -- the settings page's owner (a Home Assistant user) -----------------------
    def setup_user(self) -> dict | None:
        with self._lock:
            return self._load().get("setup_user")

    def claim_setup_user(self, user_id: str, name: str) -> bool:
        """The first Home Assistant user to save settings becomes the only
        one who may change them. Returns whether `user_id` is that user."""
        def fn(data):
            cur = data.get("setup_user")
            if cur is None:
                data["setup_user"] = {"id": user_id, "name": name,
                                      "at": self.clock().isoformat()}
                return True
            return cur.get("id") == user_id
        return self._update(fn)

    # -- owner (his Telegram account) ---------------------------------------------
    def owner(self) -> dict | None:
        with self._lock:
            return self._load().get("owner")

    def owner_id(self) -> int | None:
        o = self.owner()
        return int(o["user_id"]) if o else None

    # -- pairing --------------------------------------------------------------------
    def new_pairing_code(self) -> str:
        code = secrets.token_urlsafe(16)          # 22 chars, [A-Za-z0-9_-]

        def fn(data):
            if data.get("owner"):
                raise VaultError("already paired")
            data["pairing"] = {"hash": _hash(code), "failures": 0,
                               "expires_at": (self.clock() + timedelta(seconds=PAIRING_TTL_S))
                               .isoformat()}
            return code
        return self._update(fn)

    def pairing_active(self) -> bool:
        with self._lock:
            p = self._load().get("pairing")
        return bool(p) and datetime.fromisoformat(p["expires_at"]) > self.clock()

    def try_pair(self, code: str, *, user_id: int, chat_id: int) -> str:
        """Returns "paired", or why not. Write-once: an owner, once set,
        is never replaced here."""
        def fn(data):
            if data.get("owner"):
                return "already paired"
            p = data.get("pairing")
            if not p:
                return "no pairing code"
            if datetime.fromisoformat(p["expires_at"]) <= self.clock():
                data.pop("pairing", None)
                return "pairing code expired"
            if not hmac.compare_digest(p["hash"], _hash(code)):
                p["failures"] = int(p.get("failures", 0)) + 1
                if p["failures"] >= PAIRING_MAX_FAILURES:
                    data.pop("pairing", None)
                return "wrong code"
            data["owner"] = {"user_id": int(user_id), "chat_id": int(chat_id),
                             "paired_at": self.clock().isoformat()}
            data.pop("pairing", None)
            return "paired"
        return self._update(fn)

    # -- changes after pairing: only his tap applies them -------------------------
    def request_change(self, field: str, value: str, *, by: str) -> str:
        v = self.check_format(field, value)
        change_id = secrets.token_hex(4)

        def fn(data):
            data["pending"] = {"id": change_id, "field": field, "value": v, "by": by,
                               "at": self.clock().isoformat(), "announced": False,
                               "expires_at": (self.clock() + timedelta(seconds=CHANGE_TTL_S))
                               .isoformat()}
            return change_id
        return self._update(fn)

    def pending(self) -> dict | None:
        with self._lock:
            p = self._load().get("pending")
        if p and datetime.fromisoformat(p["expires_at"]) <= self.clock():
            self._update(lambda d: d.pop("pending", None))
            return None
        return p

    def mark_announced(self, change_id: str) -> None:
        def fn(data):
            p = data.get("pending")
            if p and p["id"] == change_id:
                p["announced"] = True
        self._update(fn)

    def resolve_change(self, change_id: str, decision: str) -> str:
        def fn(data):
            p = data.get("pending")
            if not p or p["id"] != change_id:
                return "That request is no longer pending."
            if datetime.fromisoformat(p["expires_at"]) <= self.clock():
                data.pop("pending", None)
                return "That request expired. Nothing changed."
            data.pop("pending", None)
            if decision != "approve":
                return f"Declined. The {LABELS[p['field']]} was not changed."
            data.setdefault("keys", {})[p["field"]] = {
                "value": p["value"], "set_at": self.clock().isoformat(), "set_by": p["by"]}
            return f"Done. The {LABELS[p['field']]} was replaced."
        return self._update(fn)

    # -- reset ------------------------------------------------------------------------
    def reset(self) -> None:
        """Forget the keys, the owner and any pairing. The ledger -- his
        record -- is not touched."""
        def fn(data):
            for k in ("keys", "owner", "pairing", "pending"):
                data.pop(k, None)
        self._update(fn)
