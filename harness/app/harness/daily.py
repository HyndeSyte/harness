"""The daily rhythm: a canary through the real model path, then the digest.

The canary runs each engine through exactly what a job uses -- system
prompt, schema, structured output, the parser -- with a fixed question,
and records the result as an input the digest depends on. The digest is
composed by plain code (digest.compose) from the ledger: what is waiting
on him, what failed since the last digest, budgets, the canary, whether
the chat has been reachable, and since when the code and config are
unchanged.

Before proactive_from the digest is composed and recorded but not sent.
That is a rule enforced here, in the sender path, not in any prompt.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import replace
from concurrent.futures import Executor, Future
from datetime import datetime, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

from . import calendar_feed, digest, ingress_filter, policy, prompts, render, schema
from .config import Config
from .engines import CallOutcome, Engine, call_with_retries
from .ledger import Ledger, iso

log = logging.getLogger("harness.daily")

CANARY_TIME = "06:40"
CHAT_MAX_AGE = timedelta(minutes=15)
CANARY_MAX_AGE = timedelta(hours=26)
PROVIDER_NAME = {"anthropic": "Claude", "openai": "GPT"}


def due(now: datetime, tz: str, at: str, last_date: str | None) -> bool:
    """Fires once per local day, at or after `at` (HH:MM)."""
    local = now.astimezone(ZoneInfo(tz))
    hh, mm = (int(x) for x in at.split(":"))
    if (local.hour, local.minute) < (hh, mm):
        return False
    return last_date != local.date().isoformat()


def later(at: str, minutes: int) -> str:
    """HH:MM plus some minutes, capped at 23:59 (the digest is a morning thing)."""
    hh, mm = (int(x) for x in at.split(":"))
    total = min(hh * 60 + mm + minutes, 23 * 60 + 59)
    return f"{total // 60:02d}:{total % 60:02d}"


def local_date(now: datetime, tz: str) -> str:
    return now.astimezone(ZoneInfo(tz)).date().isoformat()


class Canary:
    def __init__(self, ledger: Ledger, config: Config, engines: dict[str, Engine],
                 executor: Executor, *, sleep: Callable[[float], None] = time.sleep,
                 monotonic: Callable[[], float] = time.monotonic,
                 budget_ok: Callable[[str], bool] = lambda provider: True):
        self.ledger = ledger
        self.config = config
        self.engines = engines
        self.executor = executor
        self.sleep = sleep
        self.monotonic = monotonic
        self.budget_ok = budget_ok
        self._futures: dict[str, Future] = {}

    @property
    def pending(self) -> bool:
        return bool(self._futures)

    def start(self) -> None:
        now = self.ledger.now()
        system = prompts.system_prompt(now=now, tz=self.config.timezone, rules=[],
                                       stage_at_least=self.config.stage_at_least)
        out_schema = prompts.output_schema(self.config.stage_at_least)
        user = prompts.user_content(prompts.CANARY)
        for name in policy.CANARY_ENGINES:
            spec = policy.MODELS[name]
            if name in self._futures:
                continue
            if name not in self.engines:
                self.ledger.input_failed(f"canary:{name}", "no engine")
                continue
            if not self.budget_ok(spec.provider):
                self.ledger.input_failed(f"canary:{name}", "budget used up")
                continue
            self._futures[name] = self.executor.submit(
                call_with_retries, self.engines[name], system=system, user=user,
                schema=out_schema, budget_s=300, sleep=self.sleep, monotonic=self.monotonic)

    def collect(self) -> None:
        for name, fut in list(self._futures.items()):
            if not fut.done():
                continue
            del self._futures[name]
            try:
                outcome: CallOutcome = fut.result()
            except Exception as e:
                self.ledger.input_failed(f"canary:{name}", type(e).__name__)
                continue
            res = outcome.result
            if res is not None:
                self.ledger.add_spend(provider=policy.MODELS[name].provider, model=res.model,
                                      purpose="canary", input_tokens=res.input_tokens,
                                      output_tokens=res.output_tokens, usd=res.usd)
            ok, why = self._judge(outcome)
            if ok:
                self.ledger.input_ok(f"canary:{name}")
            else:
                self.ledger.input_failed(f"canary:{name}", why)

    def _judge(self, outcome: CallOutcome) -> tuple[bool, str]:
        res = outcome.result
        if res is None:
            return False, outcome.error.reason if outcome.error else "no result"
        if res.status != "ok":
            return False, res.status
        try:
            out = schema.parse_output(res.output, stage_at_least=self.config.stage_at_least)
        except schema.OutputError as e:
            return False, f"bad output: {e}"
        if out.type != "answer" or "canary ok" not in out.body["text"].lower():
            return False, "wrong answer"
        return True, ""


def _screened(o, config: Config):
    """Work content stops at the door here too: a title (or a calendar)
    that hits the work filter is kept as a slot, not as words."""
    hit = (ingress_filter.check(o.summary, work_domains=config.work_domains,
                                markers=config.work_markers)
           or ingress_filter.check(o.calendar, work_domains=config.work_domains,
                                   markers=config.work_markers))
    return replace(o, summary="(work item, title not kept)") if hit else o


def _since(ledger: Ledger) -> datetime:
    last = ledger.meta_time("last_digest_at")
    return last or (ledger.now() - timedelta(days=1))


def _order(o):
    """All-day first, then by start. Several calendars arrive unsorted."""
    if o.all_day:
        return (0, o.start.isoformat(), o.summary)
    return (1, o.start.timestamp(), o.summary)


def family_problem(view, tz: str) -> str:
    """The one line the digest says about Family, or "" when it was read."""
    local = ZoneInfo(tz)
    refused = f" (last push refused: {view.rejected})" if view.rejected else ""
    if view.status == "never":
        return f"Family calendar: nothing from Home Assistant yet{refused}"
    when = view.received_at.astimezone(local).strftime("%a %-I:%M %p")
    if view.status == "stale":
        return f"Family calendar: not updated since {when}{refused}"
    if view.status == "unavailable":
        return f"Family calendar: Home Assistant couldn't read it (as of {when})"
    if view.status == "window":
        return ("Family calendar: the last push isn't about today, so Home Assistant's time "
                "zone may not be yours")
    return ""


def gather(ledger: Ledger, config: Config, *, paused: bool,
           notes: list[str] = (), calendar=None, family=None,
           mirror_line: str = "", family_add_line: str = "", watch=None) -> digest.Digest:
    """`mirror_line`: the work-hours mirror's one line (shadow mode), counts
    only. It is appended as information and can never make the digest
    anything but what the inputs, waits and failures say it is.
    `family_add_line`: said on every digest, Clear included, while Family
    calendar adds skip his tap.
    `watch` (inputs.Watch): each input with no success since its last error,
    mail included, and one line for those that came back since the last digest."""
    now = ledger.now()
    since = _since(ledger)
    inputs = [digest.InputCoverage(ledger.get_meta("chat_name") or "Discord", ledger.last_poll_success(),
                                   CHAT_MAX_AGE)]
    agenda = None
    notes = list(notes)
    watched: list[str] = []
    back = ""
    if watch is not None:
        try:                          # the inputs' lines never cost him the day's digest
            lines, watched = watch.digest_lines()
            notes += lines
            back = watch.back_line()
        except Exception as e:
            log.warning("digest: couldn't check the inputs: %s", type(e).__name__)
            notes.append("Couldn't tell this morning whether email, Family and Google are working")
    day_start, day_end, day = calendar_feed.today_bounds(now, config.timezone)
    occ: list = []
    unreadable = read = configured = 0
    if calendar is not None and calendar.configured:
        cov = calendar.coverage()
        for c in cov:
            inputs.append(digest.InputCoverage(f"Calendar {c.label}" if c.label else "One of your calendars",
                                               c.ok_at, calendar_feed.MAX_AGE, c.error, c.failing, c.name))
        occ, unreadable, read, configured = calendar.agenda(day)
        occ = list(occ)
    fam_status = None
    if family is not None and config.family_entity:
        view = family.view(now, config.timezone, day_start, day_end, since=since)
        fam_status = view.status
        configured += 1
        problem = family_problem(view, config.timezone)
        if problem:
            notes.append(problem)
        else:
            read += 1
            occ += view.occurrences
        if view.wrong_keys:
            # Loud even while good pushes keep arriving: someone else is trying.
            notes.append(f"Family calendar: {view.wrong_keys} push(es) with the wrong key")
    if configured:
        occ = sorted((_screened(o, config) for o in occ), key=_order)
        agenda = digest.Agenda(occ, unreadable, read, configured, labels=configured > 1)
    rows = ledger.inputs()
    canary_ok: bool | None = True
    canary_notes: list[str] = []
    for name in policy.CANARY_ENGINES:
        row = rows.get(f"canary:{name}")
        label = PROVIDER_NAME[policy.MODELS[name].provider]
        ok_at = (datetime.fromisoformat(row["last_success_at"])
                 if row is not None and row["last_success_at"] else None)
        err_at = (datetime.fromisoformat(row["last_error_at"])
                  if row is not None and row["last_error_at"] else None)
        if ok_at is None and err_at is None:
            if canary_ok is True:
                canary_ok = None              # never ran: unknown, not fine
            continue
        if err_at and (ok_at is None or err_at > ok_at):
            canary_ok = False
            canary_notes.append(f"{label} canary failed: {row['last_error']}")
        elif now - ok_at > CANARY_MAX_AGE:
            canary_ok = False
            canary_notes.append(f"{label} canary: no success since "
                                f"{ok_at.astimezone(ZoneInfo(config.timezone)):%a %-I:%M %p}")

    waiting: list[digest.Waiting] = []
    for job in ledger.jobs_in("proposed"):
        # What it is and when he asked, never a job number (Nov 11).
        asked = datetime.fromisoformat(job["created_at"]).astimezone(ZoneInfo(config.timezone))
        waiting.append(digest.Waiting(f"a change you asked for at {asked.hour % 12 or 12}:{asked:%M} "
                                      f"{'AM' if asked.hour < 12 else 'PM'} {asked:%a}, waiting for your tap",
                                      datetime.fromisoformat(job["updated_at"])))
    for r in ledger.db.execute("SELECT * FROM rules WHERE state='quarantined'"):
        waiting.append(digest.Waiting(f"rule {r['id']} clashes with another; pick one",
                                      datetime.fromisoformat(r["created_at"])))
    for r in ledger.db.execute("SELECT * FROM rules WHERE state IN ('pending','legacy_pending')"):
        waiting.append(digest.Waiting(f"rule {r['id']} isn't used until you tap its card",
                                      datetime.fromisoformat(r["created_at"])))

    failures: list[str] = []
    for job in ledger.jobs_since(since, "failed"):
        rec = ledger.receipts(job["id"])
        detail: dict = {}
        if rec:
            try:
                detail = json.loads(rec[-1]["detail"])
            except (ValueError, TypeError):
                detail = {}
        failures.append(_failed(ledger, job, detail if isinstance(detail, dict) else {}, config.timezone))
    dead = ledger.db.execute("SELECT COUNT(*) AS n FROM outbox WHERE state='dead'"
                             " AND created_at>=?", (iso(since),)).fetchone()["n"]
    if dead:
        failures.append(f"{dead} message(s) couldn't be delivered")

    low: list[str] = []
    for provider, budget in config.monthly_budget_usd.items():
        left = budget - ledger.spend_month(provider)
        if left < config.low_balance_usd.get(provider, 0):
            low.append(f"{PROVIDER_NAME.get(provider, provider)} ${max(left, 0):.2f} of "
                       f"${budget} left this month")

    if paused:
        at = ledger.meta_time("paused_at")
        when = f" since {at.astimezone(ZoneInfo(config.timezone)):%a %-I:%M %p}" if at else ""
        notes.append(f"stopped{when} (/resume)")
    d = digest.compose(now=now, tz=config.timezone, inputs=inputs, waiting=waiting,
                       failures=failures, low_balance=low, canary_ok=canary_ok,
                       config_unchanged_since=ledger.meta_time("integrity_since"),
                       canary_notes=canary_notes, notes=notes, agenda=agenda,
                       extra=[x for x in (family_add_line, mirror_line, back) if x])
    if fam_status is not None:
        d.facts["family"] = fam_status
    return replace(d, named=d.named + tuple(watched))


def deliver(ledger: Ledger, config: Config, d: digest.Digest, *, hold: bool = False) -> bool:
    """Send the digest if proactive messages are allowed today; otherwise
    record it silently. Returns whether it was queued for sending."""
    now = ledger.now()
    allowed = now.astimezone(ZoneInfo(config.timezone)).date() >= config.proactive_from
    with ledger.tx() as db:
        ledger.set_meta("last_digest_at", iso(now), db)
        # Kept for the add-on page, so a silent (pre-launch) digest can be
        # read there and checked against the real calendar.
        ledger.set_meta("last_digest_text", d.text, db)
        ledger.set_meta("last_digest_sent", "yes" if allowed else "no", db)
        ledger.event("digest", {"state": d.state, "sent": allowed, **d.facts}, db=db)
        if allowed and hold:
            # On Discord, Cain folds it into his one morning update; if he doesn't
            # take it, the controller posts it on its own (controller._release_digest).
            ledger.set_meta("digest_held_at", iso(now), db)
        elif allowed:
            ledger.enqueue(chat_id=config.owner_user_id, kind="digest", text=d.text, db=db)
    # The external watchdog reads this line from the add-on log (Supervisor),
    # so a missing digest is noticed without giving the add-on any API.
    # Counts only: no titles, no text.
    log.info("DIGEST %s state=%s sent=%s problems=%s waiting=%s events=%s family=%s",
             local_date(now, config.timezone), d.state, "yes" if allowed else "no",
             d.facts.get("problems", 0), d.facts.get("waiting", 0), d.facts.get("events", "-"),
             d.facts.get("family", "-"))
    return allowed


# Why a request didn't happen, in his words, not the ledger's.
WHY = {
    "not_found": "I couldn't find that event",
    "changed": "it changed after you saw it",
    "stopped": "I was stopped",
    "off": "changing calendars was off",
    "interrupted": "the harness restarted first",
    "expired": "it waited too long for a tap",
    "calendar_unknown": "not confirmed yet, still checking",
    "partway": "it stopped partway",
    "calendar_change_impossible": "the calendar refused it",
    "family_add_off": "adding to Family was off",
    "family_add_impossible": "Family refused it",
    "family_unknown": "not confirmed yet, still checking",
    "family_not_added": "it didn't go through",
    "not_landed": "it didn't go through",
    "put_back": "half of it went through, so that was put back",
    "unknown": "not confirmed yet, still checking",
    "failed": "the calendar refused it",
    "cut_short": "a restart cut it short while it was writing, so it wasn't written again",
    "unconfirmed": "reads couldn't tell whether it went through, so I stopped reading it",
    "family_unconfirmed": "reads couldn't tell whether it went in, so I stopped reading it",
}


def _failed(ledger: Ledger, job, detail: dict, tz: str) -> str:
    """What he asked for and when, so the line means something without a job number."""
    p = ledger.db.execute("SELECT effect_type, params_json FROM proposals WHERE job_id=?"
                          " ORDER BY created_at DESC LIMIT 1", (job["id"],)).fetchone()
    what = "a request"
    if p is not None:
        try:
            params = json.loads(p["params_json"])
            titles = [c["title"] for c in params.get("changes", [])] or [params.get("title", "")]
            titles = [render.defang(t.strip()[:40]) for t in titles if t and t.strip()]
            if titles:
                what = "your change to " + ", ".join(chr(0x201c) + t + chr(0x201d) for t in titles[:3])
        except (ValueError, AttributeError, KeyError, TypeError):
            pass
    t = datetime.fromisoformat(job["created_at"]).astimezone(ZoneInfo(tz))
    when = f"{t:%a} {t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'}"
    reason = str(detail.get("reason") or detail.get("outcome") or "")
    if reason in ("calendar_unknown", "family_unknown", "unknown"):
        return f"{what} ({when}): {WHY[reason]}."   # never "check the calendar" (org rule R-004)
    if reason in ("cut_short", "unconfirmed", "family_unconfirmed") and not detail.get("steps"):
        return f"{what} ({when}): {WHY[reason]}."   # not known either way: never "Nothing changed"
    partway = bool(detail.get("steps"))
    if partway:
        reason = "partway"                     # some of it landed, then it stopped: the receipt said what
    why = WHY.get(reason) or (reason.replace("_", " ") if reason else "it didn't finish")
    tail = "" if partway else " Nothing changed."
    done = "only partly went through" if partway else "wasn't done"
    return f"{what} ({when}) {done}: {why}.{tail}"
