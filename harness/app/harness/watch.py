"""The mutual watch: is the other add-on still there?

Cain and the calendar specialist run side by side on the Pi, and each checks
the other about once a minute (Cain's link /health from here; this add-on's
handover /health from Cain). Nobody else would notice one of them stopping.

When the other has not answered for GRACE_S, he is told once. When it answers
again, he is told once more. A restart or an update takes well under GRACE_S,
so it tells him nothing. A message that couldn't be sent is tried again at the
next check, and only then: a failing send is the only thing that repeats.

Plain code, no model. The state is a few timestamps in the keeper's own small
file (discord.json), so a restart of this add-on during an outage doesn't tell
him a second time. A restart forgets an outage it hadn't told him about yet:
it may have been off itself for longer than the other was, so it starts over.

If Cain is down, this add-on posts the "Cain is down" message itself, with the
bot token it already holds: the one thing besides Stop's notices that reaches
him without Cain (GATEKEEPER.md). The "back" message goes through Cain's link.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Callable

GRACE_S = 5 * 60
CHECK_S = 60
DOWN, BACK = "down", "back"


def iso(t: float | None) -> str | None:
    return datetime.fromtimestamp(t, timezone.utc).isoformat() if t else None


def minutes(seconds: float) -> str:
    m = max(1, round(seconds / 60))
    if m < 90:
        return f"{m} minute{'s' if m != 1 else ''}"
    return f"{m / 60:.1f} hours".replace(".0 ", " ")


class PeerWatch:
    """One add-on's watch on the other. The caller probes and sends; this decides."""

    def __init__(self, get: Callable[[str], str | None], set_: Callable[[str, str], None],
                 *, key: str = "watch_cain", grace_s: float = GRACE_S,
                 clock: Callable[[], float] = time.time):
        self._get, self._set, self.key = get, set_, key
        self.grace_s = grace_s
        self.clock = clock
        self.s = self._load()

    def _load(self) -> dict:
        try:
            s = json.loads(self._get(self.key) or "{}")
        except (TypeError, ValueError):
            s = {}
        s = s if isinstance(s, dict) else {}
        if not s.get("alerted_at"):
            s["down_since"] = None          # not told yet: start the outage over
        s["last_check"] = None
        return s

    def _save(self) -> None:
        self._set(self.key, json.dumps({k: self.s.get(k) for k in
                                        ("down_since", "alerted_at", "last_ok")}))

    def observe(self, ok: bool) -> str | None:
        """One check's result. Returns what he should be told now, if anything."""
        now = self.clock()
        self.s["last_check"] = now
        if ok:
            self.s["last_ok"] = now
            if self.s.get("alerted_at"):
                return BACK                 # stays due until sent()
            if self.s.get("down_since"):
                self.s["down_since"] = None
                self._save()
            return None
        if not self.s.get("down_since"):
            self.s["down_since"] = now
            self._save()
        if not self.s.get("alerted_at") and now - self.s["down_since"] >= self.grace_s:
            return DOWN
        return None

    def sent(self, what: str) -> None:
        """He has been told."""
        if what == DOWN:
            self.s["alerted_at"] = self.clock()
        elif what == BACK:
            self.s["alerted_at"] = None
            self.s["down_since"] = None
        self._save()

    def down_for(self) -> float:
        since = self.s.get("down_since")
        return self.clock() - since if since else 0.0

    def state(self) -> str:
        if self.s.get("last_check") is None:
            return "unknown"
        if self.s.get("alerted_at"):
            return "down" if self.s.get("last_ok", 0) < self.s["alerted_at"] else "back"
        return "waiting" if self.s.get("down_since") else "up"

    def status(self) -> dict:
        """For the settings page: times as ISO strings, UTC."""
        return {"state": self.state(), "checked_at": iso(self.s.get("last_check")),
                "last_ok": iso(self.s.get("last_ok")),
                "down_since": iso(self.s.get("down_since")),
                "alerted_at": iso(self.s.get("alerted_at")),
                "grace_minutes": round(self.grace_s / 60)}


def down_text(down_s: float) -> str:
    return (f"Cain's add-on hasn't answered for {minutes(down_s)}. Until it's back, "
            "Stop and the buttons on cards don't work, and Cain can't reply. Calendar work "
            "goes on and its cards wait. If it doesn't come back by itself, restart Cain "
            "in Home Assistant. (From the calendar specialist; I'll say once when it's back.)")


def back_text(down_s: float) -> str:
    return (f"Cain's add-on is answering again, after about {minutes(down_s)}. Stop and the "
            "buttons work again. (From the calendar specialist.)")
