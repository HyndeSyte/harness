"""The daily rhythm: a canary through the real model path, then the digest.

The canary runs each engine through exactly what a job uses -- system
prompt, schema, structured output, the parser -- with a fixed question,
and records the result as an input the digest depends on. The digest is
composed by plain code (digest.compose) from the ledger: what is waiting
on him, what failed since the last digest, budgets, the canary, whether
Telegram has been reachable, and since when the code and config are
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

from . import calendar_feed, digest, ingress_filter, policy, prompts, schema
from .config import Config
from .engines import CallOutcome, Engine, call_with_retries
from .ledger import Ledger, iso

log = logging.getLogger("harness.daily")

CANARY_TIME = "06:40"
TELEGRAM_MAX_AGE = timedelta(minutes=15)
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
        return ("Family calendar: the last push isn't about today "
                "(check Home Assistant's time zone)")
    return ""


def gather(ledger: Ledger, config: Config, *, paused: bool,
           notes: list[str] = (), calendar=None, family=None) -> digest.Digest:
    now = ledger.now()
    since = _since(ledger)
    inputs = [digest.InputCoverage("Telegram", ledger.last_poll_success(), TELEGRAM_MAX_AGE)]
    agenda = None
    notes = list(notes)
    day_start, day_end, day = calendar_feed.today_bounds(now, config.timezone)
    occ: list = []
    unreadable = read = configured = 0
    if calendar is not None and calendar.configured:
        cov = calendar.coverage()
        for label, ok_at, err in cov:
            inputs.append(digest.InputCoverage(f"Calendar {label}", ok_at,
                                               calendar_feed.MAX_AGE, err))
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
        waiting.append(digest.Waiting(f"proposal waiting for your tap (job {job['id'][:8]})",
                                      datetime.fromisoformat(job["updated_at"])))
    for r in ledger.db.execute("SELECT * FROM rules WHERE state='quarantined'"):
        waiting.append(digest.Waiting(f"rule {r['id']} clashes with another; pick one",
                                      datetime.fromisoformat(r["created_at"])))

    failures: list[str] = []
    for job in ledger.jobs_since(since, "failed"):
        rec = ledger.receipts(job["id"])
        reason = ""
        if rec:
            try:
                reason = json.loads(rec[-1]["detail"]).get("reason", "")
            except (ValueError, AttributeError):
                reason = ""
        failures.append(f"job {job['id'][:8]}: {reason or 'failed'}")
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
                       canary_notes=canary_notes, notes=notes, agenda=agenda)
    if fam_status is not None:
        d.facts["family"] = fam_status
    return d


def deliver(ledger: Ledger, config: Config, d: digest.Digest) -> bool:
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
        if allowed:
            ledger.enqueue(chat_id=config.owner_user_id, kind="digest", text=d.text, db=db)
    # The external watchdog reads this line from the add-on log (Supervisor),
    # so a missing digest is noticed without giving the add-on any API.
    # Counts only: no titles, no text.
    log.info("DIGEST %s state=%s sent=%s problems=%s waiting=%s events=%s family=%s",
             local_date(now, config.timezone), d.state, "yes" if allowed else "no",
             d.facts.get("problems", 0), d.facts.get("waiting", 0), d.facts.get("events", "-"),
             d.facts.get("family", "-"))
    return allowed
