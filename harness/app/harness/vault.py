"""/data/secrets.json: the keys, the owner, and nothing else.

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
  * the owner is write-once, and a reset (which forgets it) is announced
    to him first. The owner was set by pairing over Telegram, now retired;
    an install paired then keeps its owner;
  * while there is an owner, changing any key is a pending request that
    only his tap on a card (on Discord, through Cain) can apply.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from . import caldav, calendar_feed, google_cal, workmirror

# work_mirror: his work address, hours and rules for the work-hours mirror
# (workmirror.parse_settings). Not a key, but it names his employer's address
# and his family's events, so it is kept, shown and changed like one: entered
# once here, never in the repository or in add-on options.
# family_*: what the one calendar write needs (caldav.py). The address is
# checked strictly, because the password is sent wherever it points.
# google_service_key: what lets blocks reach his Gmail calendar (google_cal.py).
FIELDS = ("discord_bot_token", "anthropic_api_key", "openai_api_key", "calendar_feeds",
          "work_mirror", "family_apple_id", "family_app_password", "family_calendar_url",
          "google_service_key", "gmail_app_password")
FAMILY_FIELDS = ("family_apple_id", "family_app_password", "family_calendar_url")
TEXT_FIELDS = ("work_mirror",)          # several lines; a textarea on the page
LABELS = {"discord_bot_token": "Discord bot token (Cain's bot)",
          "anthropic_api_key": "Anthropic API key",
          "openai_api_key": "OpenAI API key",
          "calendar_feeds": "calendar addresses (secret iCal, space between several)",
          "work_mirror": "work mirror settings (work: address, days:, hours:, family: ...)",
          "family_apple_id": "Family calendar: Apple ID",
          "family_app_password": "Family calendar: app-specific password",
          "family_calendar_url": "Family calendar: iCloud calendar address",
          "google_service_key": "Gmail calendar: Google service account key (the whole file)",
          "gmail_app_password": "Gmail mail: app password (read-only, for dates from your mail)"}
# Formats are checked loosely: enough to catch a paste of the wrong thing
# (a URL, a sentence, a key in the wrong box), not a claim about validity.
PATTERNS = {
    "discord_bot_token": re.compile(r"[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{5,10}\.[A-Za-z0-9_-]{25,60}"),
    "anthropic_api_key": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,200}"),
    "openai_api_key": re.compile(r"sk-[A-Za-z0-9_-]{20,250}"),
    "family_apple_id": re.compile(r"[^\s@:]{1,100}@[^\s@:]{1,100}\.[^\s@:]{2,30}"),
    "family_app_password": re.compile(r"[A-Za-z]{4}-[A-Za-z]{4}-[A-Za-z]{4}-[A-Za-z]{4}"),
    "gmail_app_password": re.compile(r"[a-z]{4}\s?[a-z]{4}\s?[a-z]{4}\s?[a-z]{4}"),
}
# Keys for things that are gone. A copy left in secrets.json is dropped on the next write.
RETIRED = ("telegram_bot_token",)
CHANGE_TTL_S = 15 * 60


class VaultError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


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
            for f in RETIRED:
                (data.get("keys") or {}).pop(f, None)
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

    def family_stamp(self) -> str:
        """When the Family calendar credentials were last set. No secret in it:
        it changes when they change, which ends any authority earned on them."""
        status = self.key_status()
        return json.dumps([status[f] for f in FAMILY_FIELDS])

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
        if field == "work_mirror":
            try:
                return workmirror.settings_text(workmirror.parse_settings(v))
            except workmirror.MirrorConfigError as e:
                raise VaultError(f"work mirror settings: {e}") from None
        if field == "family_calendar_url":
            try:
                return caldav.check_url(v)
            except ValueError as e:
                raise VaultError(str(e)) from None
        if field == "google_service_key":
            try:
                return google_cal.check_key(v)
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

    # -- owner ----------------------------------------------------------------------
    def owner(self) -> dict | None:
        with self._lock:
            return self._load().get("owner")

    def owner_id(self) -> int | None:
        o = self.owner()
        return int(o["user_id"]) if o else None

    # -- changes while there is an owner: only his tap applies them ----------------
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

    def pending_field(self, change_id: str) -> str:
        """The key a pending change is for, read without letting an expired one go: the tap that
        resolves it says it expired (resolve_change)."""
        with self._lock:
            p = self._load().get("pending")
        return p["field"] if p and p.get("id") == change_id else ""

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
            label = LABELS.get(p["field"], p["field"])
            if decision != "approve":
                return f"Declined. The {label} was not changed."
            data.setdefault("keys", {})[p["field"]] = {
                "value": p["value"], "set_at": self.clock().isoformat(), "set_by": p["by"]}
            return f"Done. The {label} was replaced."
        return self._update(fn)

    # -- reset ------------------------------------------------------------------------
    def reset(self) -> None:
        """Forget the keys, the owner and anything pending. The ledger -- his
        record -- is not touched."""
        def fn(data):
            for k in ("keys", "owner", "pairing", "pending"):
                data.pop(k, None)
        self._update(fn)
