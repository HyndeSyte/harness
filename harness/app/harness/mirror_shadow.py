"""Work-hours mirror, shadow mode: computes what it would write, writes nothing.

Agreed 2026-10-16: before the mirror ever writes, it runs in shadow against
the real calendars from about Oct 21 and is judged on Nov 3 against the
thresholds pre-registered in the private mirror spec. This module is that shadow.

After each calendar read the controller calls `run()`. It rebuilds the
complete source state (every Google feed's ahead window, the last Family
push), runs `workmirror.plan` and `workmirror.reconcile` against the shadow
copy of everything the mirror would have written so far (ledger table
`mirror_shadow`), applies the would-be operations to that shadow copy, and
records one `mirror_shadow_run` event with counts: operations, skips by
reason, read completeness, and agreement with the ground truth that is
visible (Google events already carrying his work address as a guest; Family
events that match a rule).

What this module can reach: the ledger, the calendar snapshot, the Family
inbox and the planner. It imports no transport, no API client and no
effect. It never asks him anything: a mismatch is reconciled from calendar
data on the next run. Its only voice is one digest line, counts only, which
can never change the digest's state.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import replace
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import calendar_feed, workmirror
from .ledger import Ledger, iso
from .workmirror import Busy, MirrorConfig, MirrorConfigError, event_id

log = logging.getLogger("harness.mirror")

EXTRA_DAYS = 7           # read this much past the horizon, so a moved copy is followed
RUN_EVENT = "mirror_shadow_run"
MAX_IDS = 50             # id lists kept per run record


def read_days(cfg: MirrorConfig | None) -> int:
    return (cfg.horizon_days if cfg else MirrorConfig().horizon_days) + EXTRA_DAYS


def family_source_id(title: str, start, end) -> str:
    """A Family push carries no UID (family.py schema 1), so identity is the
    whole event: a moved Family block is a delete plus an add, by design."""
    raw = f"{title}|{start.isoformat()}|{end.isoformat()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def google_busy(occ, *, primary_name: str = "primary") -> Busy:
    """A feed occurrence as the planner sees it. Google names a primary
    calendar's feed by its address (ical.py); the planner calls it "primary"."""
    cal = "primary" if "@" in occ.calendar else occ.calendar
    sid = f"{occ.uid}|{occ.instance}" if occ.instance else occ.uid
    return Busy("google", sid, cal, occ.start, occ.end, occ.all_day, occ.summary,
                transparent=occ.transparent, attendees=tuple(occ.attendees))


def family_busy(title: str, start, end) -> Busy:
    return Busy("family", family_source_id(title, start, end), "Family", start, end,
                not isinstance(start, datetime), title)


class MirrorShadow:
    def __init__(self, ledger: Ledger, settings_fn, *, calendar=None, family=None,
                 tz: str = "America/New_York"):
        self.ledger = ledger
        self.settings_fn = settings_fn        # the vault's work_mirror text, or ""
        self.calendar = calendar              # CalendarFeeds (reads ahead when ahead_days > 0)
        self.family = family                  # FamilyInbox or None
        self.tz = tz
        self.last: dict | None = None         # the last run's record (also in the ledger)
        self._seen: tuple | None = None       # (calendar generation, family push) last run on

    # -- settings ----------------------------------------------------------------
    def config(self) -> MirrorConfig | None:
        """None when nothing is entered. Raises MirrorConfigError on bad text."""
        text = (self.settings_fn() or "").strip()
        return workmirror.parse_settings(text) if text else None

    # -- the shadow copy (ledger) ------------------------------------------------------
    def live(self) -> workmirror.Live:
        return {r["event_id"]: (datetime.fromisoformat(r["start"]),
                                datetime.fromisoformat(r["end"]), r["title"])
                for r in self.ledger.db.execute("SELECT * FROM mirror_shadow")}

    def sources(self) -> dict[str, tuple[str, str]]:
        return {r["event_id"]: (r["source"], r["source_id"])
                for r in self.ledger.db.execute("SELECT event_id, source, source_id"
                                                " FROM mirror_shadow")}

    def _apply(self, d: workmirror.Delta, db) -> None:
        now = iso(self.ledger.now())
        for c in d.add + d.update:
            db.execute("INSERT INTO mirror_shadow(event_id, source, source_id, start, end,"
                       " title, label, updated_at) VALUES(?,?,?,?,?,?,?,?)"
                       " ON CONFLICT(event_id) DO UPDATE SET start=excluded.start,"
                       " end=excluded.end, title=excluded.title, label=excluded.label,"
                       " updated_at=excluded.updated_at",
                       (c.event_id, c.source, c.source_id, iso(c.start), iso(c.end), c.title,
                        c.label, now))
        for i in d.delete:
            db.execute("DELETE FROM mirror_shadow WHERE event_id=?", (i,))

    # -- one run -------------------------------------------------------------------------
    def due(self) -> bool:
        """Only after something new was read: a feed result or a Family push."""
        gen = getattr(self.calendar, "generation", 0) if self.calendar is not None else 0
        fam = self.family.status().get("received_at") if self.family is not None else None
        return (gen, fam) != self._seen

    def run(self, now: datetime | None = None) -> dict:
        """Never raises: a failure is a record (and the digest line), not a crash.
        With no settings entered it records nothing at all."""
        now = now or self.ledger.now()
        gen = getattr(self.calendar, "generation", 0) if self.calendar is not None else 0
        fam = self.family.status().get("received_at") if self.family is not None else None
        self._seen = (gen, fam)
        try:
            rec = self._run(now)
        except Exception as e:                  # a shadow bug must not reach the loop
            log.warning("mirror shadow failed: %s", type(e).__name__)
            rec = {"status": "failed", "error": type(e).__name__}
        rec["at"] = iso(now)
        if rec.get("status") == "no settings":
            return rec                          # nothing entered: nothing recorded
        self.last = rec
        self.ledger.event(RUN_EVENT, rec)
        return rec

    def _run(self, now: datetime) -> dict:
        try:
            cfg = self.config()
        except MirrorConfigError as e:
            return {"status": "bad settings", "error": str(e)[:200]}
        if cfg is None:
            return {"status": "no settings"}
        if not cfg.enabled:
            return {"status": "off"}

        # -- the complete source state -----------------------------------------------
        day_start, _, day = calendar_feed.today_bounds(now, self.tz)
        # The feeds are parsed as far as the reader was told to look; a
        # horizon longer than that is capped here rather than planned blind
        # (a day that wasn't read is not an empty day, invariant 19).
        ahead = getattr(self.calendar, "ahead_days", 0) or read_days(None)
        if cfg.horizon_days > ahead - EXTRA_DAYS:
            cfg = replace(cfg, horizon_days=max(1, ahead - EXTRA_DAYS))
        read_until = day_start + timedelta(days=ahead + 1)
        events: list[Busy] = []
        unreadable = read = configured = 0
        if self.calendar is not None and self.calendar.configured:
            occ, unreadable, read, configured = self.calendar.ahead(day)
            events += [google_busy(o) for o in occ]
        fam_status, fam_until = "none", None
        if self.family is not None:
            fam_status, fam_until, fam_events = self.family.recent(now)
            events += [family_busy(t, s, e) for t, s, e in fam_events]
        complete = (configured > 0 and read == configured and unreadable == 0
                    and (self.family is None or fam_status == "fresh"))

        # -- plan and reconcile against the shadow copy ---------------------------------
        live_all = self.live()
        srcs = self.sources()
        live = dict(live_all)
        if fam_until is not None:
            # A Family copy beyond the last push's window is unread, not gone.
            for i, (s, _, _) in live_all.items():
                if srcs.get(i, ("",))[0] == "family" and s >= fam_until:
                    live.pop(i, None)
        p = workmirror.plan(events, cfg, now, complete=complete, tracked=frozenset(live),
                            read_until=read_until)
        d = workmirror.reconcile(p, live)
        with self.ledger.tx() as db:
            self._apply(d, db)

        # -- what the thresholds are judged on --------------------------------------------
        want = {c.event_id: c for c in p.copies}
        skipped: dict[str, int] = {}
        for _, why in p.skipped:
            skipped[why] = skipped.get(why, 0) + 1
        slots: dict[tuple, set] = {}
        for c in p.copies:
            slots.setdefault((c.start, c.end), set()).add(c.source)
        duplicates = sum(1 for s in slots.values() if len(s) > 1)
        leaks = sum(1 for c in p.copies if cfg.title_mode == "busy" and c.title != "Busy")
        truth = self._truth(events, cfg, now, want, read_until)
        prev = self._previous()
        flaps = 0
        if prev:
            flaps = (len({c.event_id for c in d.add} & set(prev.get("deleted", [])))
                     + len(set(d.delete) & set(prev.get("added", []))))
        return {
            "status": "ok", "complete": complete, "read": read, "configured": configured,
            "unreadable": unreadable, "family": fam_status,
            "copies": len(p.copies), "add": len(d.add), "update": len(d.update),
            "delete": len(d.delete), "skipped": skipped, "plan_hash": p.plan_hash[:16],
            "duplicates": duplicates, "leaks": leaks, "flaps": flaps,
            "partial_delete": len(d.delete) if not complete else 0,
            "partial_family_add": (sum(1 for c in d.add if c.source == "family")
                                   if not complete else 0),
            "deleted_still_blocks": len(set(d.delete) & set(want)),
            "added": [c.event_id for c in d.add][:MAX_IDS],
            "deleted": list(d.delete)[:MAX_IDS],
            **truth,
        }

    def _truth(self, events, cfg, now, want, read_until) -> dict:
        """Agreement with what can be seen (spec section 8)."""
        addr = cfg.work_address.lower()
        stripped = [replace(e, attendees=()) for e in events]
        would = {c.event_id for c in workmirror.plan(stripped, cfg, now, read_until=read_until).copies
                 if c.source == "google"}
        # Hand-marked: his work address is a guest, and the block touches work
        # hours on any calendar, skip rules aside (a skip rule hiding one he
        # mirrored by hand is exactly a "missed").
        marked = [e for e in events if e.source == "google" and addr in (a.lower() for a in e.attendees)]
        names = tuple({e.calendar for e in marked}) or ("primary",)
        wide = replace(cfg, skip_titles=(), google_calendars=names)
        hand = {c.event_id for c in workmirror.plan([replace(e, attendees=()) for e in marked],
                                                    wide, now, read_until=read_until).copies}
        started = {c.event_id for c in want.values() if c.start <= now}
        extra = (would - hand) & started
        fam = [e for e in events if e.source == "family"]
        rules = [re.compile(r.pattern, re.I) for r in cfg.family_rules]
        google_slots = {(e.start, e.end) for e in events if e.source == "google"}
        matches = [e for e in fam if any(rx.fullmatch(workmirror._clean(e.title)) for rx in rules)]
        twins = sum(1 for e in matches if (e.start, e.end) in google_slots)
        return {"would": len(would), "hand": len(hand), "agree": len(hand & would),
                "missed": sorted(hand - would)[:MAX_IDS], "extra": sorted(extra)[:MAX_IDS],
                "family_matches": len(matches), "family_twins": twins,
                "family_only": len(matches) - twins}

    def _previous(self) -> dict | None:
        row = self.ledger.db.execute("SELECT detail FROM events WHERE kind=? ORDER BY id DESC"
                                     " LIMIT 1", (RUN_EVENT,)).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row["detail"])
        except ValueError:
            return None

    # -- the one line --------------------------------------------------------------------
    def digest_line(self) -> str:
        """Counts only, never a title. Always starts the same way, so a reader
        of the digest knows the mirror is not writing.

        "" (no line at all) when no settings are entered or the shadow has
        not run yet: until he enters settings the digest is byte for byte
        what it was before the shadow existed."""
        head = "Mirror: shadow only, not writing"
        try:
            text = self.settings_fn()
        except Exception:                       # unknown; the last record speaks
            text = None
        if text is not None and not (text or "").strip():
            return ""
        r = self.last or self._previous()
        if r is None or r.get("status") == "no settings":
            return ""
        st = r.get("status")
        if st == "off":
            return head + " · off in settings"
        if st == "bad settings":
            return head + " · settings refused"
        if st != "ok":
            return head + f" · last run failed ({r.get('error', '?')})"
        read = f"read {r['read']}/{r['configured']}" + ("" if r["complete"] else ", partial")
        if r.get("family") not in ("none", None):
            read += f", Family {r['family']}"
        truth = (f"ground truth: {r['hand']} hand-marked, {len(r['missed'])} missed, "
                 f"{len(r['extra'])} extra, Family {r['family_twins']} twins/"
                 f"{r['family_only']} only")
        return (f"{head} · {r['copies']} copies · would add {r['add']}, change {r['update']}, "
                f"remove {r['delete']} · {sum(r['skipped'].values())} skipped · {read} · {truth}")
