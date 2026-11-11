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
bot token it already holds, and the "back" message the same way: these two are
the only things besides Stop's notices that reach him without Cain
(GATEKEEPER.md). A "back" held as a card by Cain might never be shown.

The 5-minute grace is timed on the monotonic clock, so a clock jump at boot (the
Pi has no real-time clock) can't make an outage look long. Wall-clock times are
only for the page and for the persisted "already told him" flag.
"""
from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from typing import Callable

GRACE_S = 5 * 60
CHECK_S = 60
DOWN, BACK = "down", "back"
MAX_SHOWN_S = 30 * 24 * 3600          # a shown duration longer than this is a clock jump
LINK, DISCORD = "link", "discord"     # why Cain counts as down


def num(v) -> float | None:
    """A stored timestamp: a finite number, or None (like num() in watch.ts)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) else None


def iso(t: float | None) -> str | None:
    try:
        return datetime.fromtimestamp(t, timezone.utc).isoformat() if t else None
    except (OverflowError, OSError, ValueError):
        return None


def clamp(seconds: float) -> float:
    return min(max(0.0, seconds), MAX_SHOWN_S)


def minutes(seconds: float) -> str:
    m = max(1, round(clamp(seconds) / 60))
    if m < 90:
        return f"{m} minute{'s' if m != 1 else ''}"
    return f"{m / 60:.1f} hours".replace(".0 ", " ")


class PeerWatch:
    """One add-on's watch on the other. The caller probes and sends; this decides."""

    def __init__(self, get: Callable[[str], str | None], set_: Callable[[str, str], None],
                 *, key: str = "watch_cain", grace_s: float = GRACE_S,
                 clock: Callable[[], float] = time.time,
                 mono: Callable[[], float] = time.monotonic):
        self._get, self._set, self.key = get, set_, key
        self.grace_s = grace_s
        self.clock = clock                  # wall: shown, and the persisted flag
        self.mono = mono                    # monotonic: the grace period
        self.down_mono: float | None = None  # when this run saw the outage start
        self.last_ok_result: bool | None = None
        self.s = self._load()

    def _load(self) -> dict:
        try:
            raw = json.loads(self._get(self.key) or "{}")
        except (TypeError, ValueError):
            raw = {}
        raw = raw if isinstance(raw, dict) else {}
        s = {k: num(raw.get(k)) for k in ("down_since", "alerted_at", "last_ok")}
        if not s["alerted_at"]:
            s["down_since"] = None          # not told yet: start the outage over
        s["last_check"] = None
        return s

    def _save(self) -> None:
        self._set(self.key, json.dumps({k: self.s.get(k) for k in
                                        ("down_since", "alerted_at", "last_ok")}))

    def observe(self, ok: bool) -> str | None:
        """One check's result. Returns what he should be told now, if anything."""
        now, mono = self.clock(), self.mono()
        self.s["last_check"] = now
        self.last_ok_result = ok
        if ok:
            self.s["last_ok"] = now
            self.down_mono = None
            if self.s.get("alerted_at"):
                return BACK                 # stays due until sent()
            if self.s.get("down_since"):
                self.s["down_since"] = None
                self._save()
            return None
        if self.down_mono is None:
            self.down_mono = mono
        if not self.s.get("down_since"):
            self.s["down_since"] = now
            self._save()
        if not self.s.get("alerted_at") and mono - self.down_mono >= self.grace_s:
            return DOWN
        return None

    def sent(self, what: str) -> None:
        """He has been told."""
        if what == DOWN:
            self.s["alerted_at"] = self.clock()
        elif what == BACK:
            self.s["alerted_at"] = None
            self.s["down_since"] = None
            self.down_mono = None
        self._save()

    def down_for(self) -> float:
        """How long the outage has lasted, for the message: monotonic when this run saw
        it start, else wall clock (after a restart), clamped either way."""
        if self.down_mono is not None:
            return clamp(self.mono() - self.down_mono)
        since = self.s.get("down_since")
        return clamp(self.clock() - since) if since else 0.0

    def state(self) -> str:
        if self.s.get("last_check") is None:
            return "unknown"
        if self.s.get("alerted_at"):
            return "back" if self.last_ok_result else "down"
        return "waiting" if self.s.get("down_since") else "up"

    def status(self) -> dict:
        """For the settings page: times as ISO strings, UTC."""
        return {"state": self.state(), "checked_at": iso(self.s.get("last_check")),
                "last_ok": iso(self.s.get("last_ok")),
                "down_since": iso(self.s.get("down_since")),
                "alerted_at": iso(self.s.get("alerted_at")),
                "grace_minutes": round(self.grace_s / 60)}


def down_text(down_s: float, why: str = LINK) -> str:
    if why == DISCORD:
        return (f"Cain is running, but his Discord connection has been down for "
                f"{minutes(down_s)}. Until it's back, Stop and the buttons on cards don't "
                "work, and Cain can't see your messages. Calendar work goes on and its cards "
                "wait. If it doesn't come back by itself, restart Cain in Home Assistant. "
                "(From the calendar specialist; I'll say once when it's back.)")
    return (f"Cain hasn't answered for {minutes(down_s)}. Until he's back, "
            "Stop and the buttons on cards don't work, and Cain can't reply. Calendar work "
            "goes on and its cards wait. If it doesn't come back by itself, restart Cain "
            "in Home Assistant. (From the calendar specialist; I'll say once when it's back.)")


def back_text(down_s: float) -> str:
    return (f"Cain is answering again, after about {minutes(down_s)}. Stop and the "
            "buttons work again. (From the calendar specialist.)")
