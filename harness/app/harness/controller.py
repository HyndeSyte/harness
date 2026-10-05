"""The controller loop: one thread owns the ledger and decides everything.

Each tick:
  1. take requests from the settings page (a reset, mostly);
  2. without a bot token, wait; without an owner, run pairing only;
  3. long-poll Telegram, screen, record (offset atomic with the records);
  4. tell him if continuity is unknown (a gap longer than Telegram keeps);
  5. commands, then button taps, then message jobs (started in workers,
     collected here), then their timers;
  6. announce any settings change waiting for his tap;
  7. the daily canary and digest;
  8. send what is due from the outbox;
  9. publish a status snapshot for the settings page.

Nothing in here calls a model directly and nothing in here can act on the
world: S1 has no effects at all.
"""
from __future__ import annotations

import hashlib
import logging
import queue
import re
import time
from concurrent.futures import Executor
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

from . import (callbacks, choices, commands, daily, ingress_filter, integrity, policy,
               render, telegram)
from .config import Config
from .engines import Engine
from .ledger import Ledger
from .outbox import Outbox
from .runner import Runner
from .telegram_api import TelegramError
from .vault import LABELS, Vault

log = logging.getLogger("harness.controller")

PAIR_RE = re.compile(r"/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})")
SETTINGS_TTL_S = 15 * 60


class Controller:
    def __init__(self, *, ledger: Ledger, vault: Vault, api, engines: dict[str, Engine],
                 executor: Executor, base_config: Config,
                 sleep: Callable[[float], None] = time.sleep,
                 monotonic: Callable[[], float] = time.monotonic,
                 status_box: dict | None = None, requests: "queue.Queue | None" = None,
                 poll_timeout: int = 25, calendar=None):
        self.ledger = ledger
        self.vault = vault
        self.api = api
        self.engines = engines
        self.executor = executor
        self.base_config = base_config
        self.sleep = sleep
        self.monotonic = monotonic
        self.status_box = status_box if status_box is not None else {}
        self.requests = requests or queue.Queue()
        self.poll_timeout = poll_timeout
        self.calendar = calendar           # S1: read-only calendar feeds, or None
        self.outbox = Outbox(ledger, api, sleep=sleep, tz=base_config.timezone)
        self.config: Config | None = None
        self.runner: Runner | None = None
        self.canary: daily.Canary | None = None
        self.commands: commands.Commands | None = None
        self.callbacks: callbacks.Callbacks | None = None
        self.bot_username: str | None = None
        self.notes: dict[str, str] = {}           # standing problems for the digest
        self._poll_failures = 0
        self._token_seen: str | None = None      # fingerprint of the token getMe confirmed

    # -- set-up --------------------------------------------------------------
    def _bind_owner(self, owner: int) -> None:
        if self.config is not None and self.config.owner_user_id == owner:
            return
        self.config = replace(self.base_config, owner_user_id=owner)
        self.runner = Runner(self.ledger, self.config, self.engines, self.executor,
                             sleep=self.sleep, monotonic=self.monotonic,
                             budgets_ok=self._budget_ok)
        self.canary = daily.Canary(self.ledger, self.config, self.engines, self.executor,
                                   sleep=self.sleep, monotonic=self.monotonic,
                                   budget_ok=self._budget_ok)
        self.commands = commands.Commands(self.ledger, status_fn=self.status_text,
                                          cancel_fn=self.runner.cancel_in_flight,
                                          screen_fn=self._screen_text)
        self.callbacks = callbacks.Callbacks(self.ledger, self.api, owner_user_id=owner,
                                             policy_version=self.config.policy_version,
                                             settings_fn=self._settings_decision)

    def _budget_ok(self, provider: str) -> bool:
        budget = self.base_config.monthly_budget_usd.get(provider)
        return budget is None or self.ledger.spend_month(provider) < budget

    def startup(self) -> None:
        """Local checks must succeed; remote ones only report. A network
        hiccup at boot is a note in the digest, never a crash."""
        if not self.ledger.integrity_ok():
            self.notes["ledger"] = "the ledger failed its integrity check; restore a backup"
        integrity.check(self.ledger, self.base_config)
        owner = self.vault.owner_id()
        if owner is not None:
            self._bind_owner(owner)
            self.runner.reconcile_after_restart()
        if self.vault.get("telegram_bot_token"):
            if self._telegram_health() and owner is not None:
                self._set_commands()
        for name, engine in self.engines.items():
            try:
                state = engine.check_model()
            except Exception as e:                       # report, don't crash
                log.warning("model check for %s failed: %s", name, type(e).__name__)
                state = "unknown"
            if state == "ok":
                self.ledger.input_ok(f"model:{name}")
                self.notes.pop(f"model:{name}", None)
            elif state == "missing":
                self.ledger.input_failed(f"model:{name}", "pinned model not found")
                self.notes[f"model:{name}"] = (f"{policy.MODELS[name].model} isn't available "
                                               "from the provider")
        self._publish()

    def _token_print(self) -> str:
        return hashlib.sha256(self.vault.get("telegram_bot_token").encode()).hexdigest()[:16]

    def _telegram_ready(self) -> bool:
        """Poll only a bot we have identified. A new token means a new bot,
        whose update and message ids start over: the ledger is told, so it
        resets the offset rather than confirming the new bot's updates away."""
        if self._token_seen == self._token_print() and self.ledger.bot_id():
            return True
        return self._telegram_health()

    def _telegram_health(self) -> bool:
        try:
            me = self.api.get_me()
            bot_id = me.get("id")
            if not isinstance(bot_id, int) or bot_id <= 0:
                self.notes["telegram"] = "Telegram didn't say which bot this token belongs to"
                return False
            if self.ledger.set_bot(bot_id):
                log.info("now talking to bot %s", bot_id)
            self._token_seen = self._token_print()
            self._poll_failures = 0
            self.bot_username = me.get("username")
            self.notes.pop("telegram", None)
            hook = self.api.get_webhook_info()
            if hook.get("url"):
                # Something else is receiving this bot's updates. Don't
                # delete it -- that would break whatever set it -- say so.
                self.notes["webhook"] = ("a webhook is set on the bot, so polling is "
                                         "blocked; the token is in use elsewhere")
            else:
                self.notes.pop("webhook", None)
            return True
        except TelegramError as e:
            self.notes["telegram"] = f"Telegram check failed: {e.description or e.code}"
            return False

    def _set_commands(self) -> None:
        try:
            self.api.set_my_commands(commands.HELP, chat_id=self.config.owner_user_id)
        except TelegramError as e:
            log.info("setMyCommands failed: %s", e)

    # -- the loop --------------------------------------------------------------
    def tick(self) -> None:
        self._drain_requests()
        if not self.vault.get("telegram_bot_token"):
            self._publish()
            self.sleep(2)
            return
        if not self._telegram_ready():
            self._publish()
            self.sleep(min(60.0, 5.0 * (1 + self._poll_failures)))
            self._poll_failures += 1
            return
        owner = self.vault.owner_id()
        if owner is None:
            self._pairing_tick()
            self.outbox.flush()
            self._publish()
            return
        self._bind_owner(owner)
        prev_poll = self.ledger.last_poll_success()
        decisions = self._poll()
        if decisions is not None:
            self._continuity(prev_poll)
            self._after_poll(decisions)
        paused = commands.is_paused(self.ledger)
        self.commands.handle_pending()
        self.runner.start_pending(paused=commands.is_paused(self.ledger))
        self.runner.collect()
        self.runner.check_timers()
        self._announce_settings()
        if self.calendar is not None:
            self.calendar.maybe_start()
            self.calendar.collect()
        self._daily(paused)
        self.outbox.flush()
        self._publish()

    def _busy(self) -> bool:
        return bool(self.runner and self.runner.in_flight) or bool(
            self.canary and self.canary.pending) or bool(
            self.calendar and self.calendar.pending) or bool(self.ledger.due_outbox())

    def _poll(self):
        timeout = 1 if self._busy() else self.poll_timeout
        owner = self.config.owner_user_id
        screen = self._screen
        try:
            decisions, _ = telegram.poll_once(self.api, self.ledger, owner, timeout=timeout,
                                              screen=screen)
        except TelegramError as e:
            self._poll_failed(e)
            return None
        self._poll_failures = 0
        self.notes.pop("telegram", None)
        return decisions

    def _poll_failed(self, e: TelegramError) -> None:
        self._poll_failures += 1
        self.ledger.input_failed("telegram", str(e))
        if e.code == 409:
            self.notes["telegram"] = "another program is reading this bot's updates"
        elif e.code == 401:
            self.notes["telegram"] = "Telegram refused the bot token"
        wait = min(60.0, max(e.retry_after or 0, 2.0 * self._poll_failures))
        self.sleep(wait)

    def _screen(self, inc) -> str | None:
        return self._screen_text(inc.text or "")

    def _screen_text(self, text: str) -> str | None:
        cfg = self.config or self.base_config
        hit = ingress_filter.check(text, work_domains=cfg.work_domains,
                                   markers=cfg.work_markers)
        return f"work content ({hit.kind})" if hit else None

    def _after_poll(self, decisions) -> None:
        for d in decisions:
            inc = d.incoming
            if d.accepted and inc.kind == "callback":
                self.callbacks.handle(inc)
            elif not d.accepted and d.reason and d.reason.startswith("work content") \
                    and inc.chat_id == self.config.owner_user_id:
                with self.ledger.tx() as db:
                    self.ledger.enqueue(
                        chat_id=inc.chat_id, kind="reply",
                        text=("I didn't keep that message: it looks like work content "
                              f"({render.escape(d.reason[14:-1])}). Nothing was stored or "
                              "sent to a model."), db=db)

    # -- continuity --------------------------------------------------------------
    def _proactive_ok(self) -> bool:
        local = self.ledger.now().astimezone(ZoneInfo(self.config.timezone)).date()
        return local >= self.config.proactive_from

    def _continuity(self, prev: datetime | None) -> None:
        now = self.ledger.now()
        if prev is None:
            return
        gap = (now - prev).total_seconds()
        if gap <= self.config.continuity_window_s:
            return
        tz = ZoneInfo(self.config.timezone)
        lost_before = now - timedelta(seconds=self.config.continuity_window_s)
        text = (f"<b>Continuity unknown.</b> I couldn't reach Telegram from "
                f"{prev.astimezone(tz):%a %b %-d %-I:%M %p} until now. Telegram keeps "
                f"messages for 24 hours, so anything you sent before "
                f"{lost_before.astimezone(tz):%a %-I:%M %p} may be lost. Resend anything "
                "that matters.")
        with self.ledger.tx() as db:
            self.ledger.event("continuity_unknown", {"gap_s": int(gap)}, db=db)
            # Held until he next writes if proactive messages aren't allowed yet.
            self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", text=text,
                                held=not self._proactive_ok(), db=db)

    # -- pairing -------------------------------------------------------------------
    def _pairing_tick(self) -> None:
        paired = None

        def decide_pairing(inc):
            nonlocal paired
            result = "not paired"
            if (inc.kind == "message" and not inc.is_bot and inc.chat_type == "private"
                    and inc.user_id is not None and inc.chat_id == inc.user_id and inc.text):
                m = PAIR_RE.fullmatch(inc.text.strip())
                if m:
                    result = self.vault.try_pair(m.group(1), user_id=inc.user_id,
                                                 chat_id=inc.chat_id)
                    if result == "paired":
                        paired = inc
            # Nothing said to the bot before pairing is kept, including the
            # code itself: every update is recorded as a refusal, by id.
            return telegram.Decision(inc, False, f"pairing: {result}", None)

        try:
            telegram.poll_once(self.api, self.ledger, 0, timeout=self.poll_timeout,
                               decide_fn=decide_pairing)
        except TelegramError as e:
            self._poll_failed(e)
            return
        if paired is not None:
            self._bind_owner(paired.user_id)
            with self.ledger.tx() as db:
                self.ledger.event("paired", {"user": paired.user_id}, db=db)
                self.ledger.enqueue(chat_id=paired.chat_id, kind="notice", text=(
                    "<b>Paired.</b> This chat is now the only place the harness listens. "
                    "It answers when you write; it can't change anything in the world yet. "
                    "/status shows what it's doing; /stop stops it."), db=db)
            self._set_commands()

    # -- settings changes from the add-on page -------------------------------------------
    def _announce_settings(self) -> None:
        p = self.vault.pending()
        if not p or p.get("announced"):
            return
        with self.ledger.tx() as db:
            ok = choices.mint(self.ledger, kind="settings_approve", target=p["id"],
                              chat_id=self.config.owner_user_id, ttl_s=SETTINGS_TTL_S, db=db)
            no = choices.mint(self.ledger, kind="settings_decline", target=p["id"],
                              chat_id=self.config.owner_user_id, ttl_s=SETTINGS_TTL_S, db=db)
            self.ledger.enqueue(
                chat_id=self.config.owner_user_id, kind="card",
                text=(f"<b>Settings change requested</b> on the add-on page by "
                      f"{render.escape(p['by'])}: replace the {LABELS[p['field']]}. "
                      "Only your tap applies it. <i>Expires in 15 min.</i>"),
                buttons=[[("Approve", choices.callback_data(ok)),
                          ("Decline", choices.callback_data(no))]],
                binds=[{"type": "choice", "nonce": ok}, {"type": "choice", "nonce": no}],
                db=db)
        self.vault.mark_announced(p["id"])

    def _settings_decision(self, change_id: str, decision: str) -> str:
        msg = self.vault.resolve_change(change_id, decision)
        self.ledger.event("settings_change", {"id": change_id, "decision": decision})
        return msg

    def _drain_requests(self) -> None:
        while True:
            try:
                req = self.requests.get_nowait()
            except queue.Empty:
                return
            if req.get("type") == "reset":
                self._reset(req.get("by", "someone"))

    def _reset(self, by: str) -> None:
        owner = self.vault.owner_id()
        if owner is not None and self.vault.get("telegram_bot_token"):
            # Tell the old owner first, while the token still works.
            with self.ledger.tx() as db:
                self.ledger.enqueue(chat_id=owner, kind="notice", text=(
                    f"<b>The harness was reset</b> from the add-on page by "
                    f"{render.escape(by)}. It no longer listens to this chat."), db=db)
            self.outbox.flush()
        self.vault.reset()
        self.ledger.event("reset", {"by": by})
        self.config = None
        self.runner = None

    # -- daily ---------------------------------------------------------------------------
    def _daily(self, paused: bool) -> None:
        cfg = self.config
        now = self.ledger.now()
        if daily.due(now, cfg.timezone, daily.CANARY_TIME, self.ledger.get_meta("canary_date")):
            self.ledger.set_meta("canary_date", daily.local_date(now, cfg.timezone))
            self.canary.start()
        self.canary.collect()
        if daily.due(now, cfg.timezone, cfg.digest_time, self.ledger.get_meta("digest_date")):
            if self.canary.pending:
                return          # wait for this morning's canary, then compose
            if self.calendar is not None and self.calendar.configured:
                self.calendar.maybe_start(before_digest=True)
                self.calendar.collect()
                if self.calendar.pending and not daily.due(now, cfg.timezone,
                                                           daily.later(cfg.digest_time, 5),
                                                           self.ledger.get_meta("digest_date")):
                    return      # a fresh read is on its way; give it up to 5 minutes
            self.ledger.set_meta("digest_date", daily.local_date(now, cfg.timezone))
            d = daily.gather(self.ledger, cfg, paused=paused, notes=list(self.notes.values()),
                             calendar=self.calendar)
            daily.deliver(self.ledger, cfg, d)

    # -- status ------------------------------------------------------------------------------
    def status_text(self) -> str:
        cfg = self.config
        tz = ZoneInfo(cfg.timezone)
        now = self.ledger.now()
        last = self.ledger.last_poll_success()
        lines = [f"<b>Status</b> · stage {cfg.stage} · " +
                 ("zero effects" if not cfg.stage_at_least("S2") else "calendar holds on"),
                 "Stopped (/resume)" if commands.is_paused(self.ledger) else "Running"]
        if last:
            lines.append(f"Telegram: last contact {int((now - last).total_seconds())}s ago")
        lines.append(f"Jobs: {len(self.ledger.jobs_in('running'))} running · "
                     f"{len(self.ledger.jobs_in('proposed'))} waiting on you")
        spend = []
        for provider, budget in cfg.monthly_budget_usd.items():
            name = daily.PROVIDER_NAME.get(provider, provider)
            spend.append(f"{name} ${self.ledger.spend_month(provider):.2f} of ${budget}")
        lines.append("Spend this month: " + " · ".join(spend))
        inputs = self.ledger.inputs()
        for name in policy.CANARY_ENGINES:
            row = inputs.get(f"canary:{name}")
            label = daily.PROVIDER_NAME[policy.MODELS[name].provider]
            if row is None:
                lines.append(f"{label} canary: not run yet")
            elif row["last_error_at"] and (not row["last_success_at"]
                                           or row["last_error_at"] > row["last_success_at"]):
                lines.append(f"{label} canary: failed ({render.escape(row['last_error'])})")
            else:
                ok = datetime.fromisoformat(row["last_success_at"]).astimezone(tz)
                lines.append(f"{label} canary: ok {ok:%a %-I:%M %p}")
        if self.calendar is not None and self.calendar.configured:
            for label, ok_at, err in self.calendar.coverage():
                when = f"read {ok_at.astimezone(tz):%a %-I:%M %p}" if ok_at else "not read yet"
                lines.append(f"Calendar {render.escape(label)}: {when}" +
                             (f" (last problem: {render.escape(err)})" if err else ""))
        start = cfg.proactive_from
        lines.append(f"Digest: {cfg.digest_time} daily" +
                     ("" if self._proactive_ok() else f", from {start:%b %-d}"))
        since = self.ledger.meta_time("integrity_since")
        if since:
            lines.append(f"Code and config unchanged since {since.astimezone(tz):%b %-d}")
        for note in self.notes.values():
            lines.append("⚠ " + render.escape(note))
        return "\n".join(lines)

    def _publish(self) -> None:
        owner = self.vault.owner()
        last = self.ledger.last_poll_success()
        self.status_box.update({
            "paired": owner is not None,
            "owner_since": owner.get("paired_at") if owner else None,
            "bot": self.bot_username,
            "stage": self.base_config.stage,
            "proactive_from": self.base_config.proactive_from.isoformat(),
            "last_poll": last.isoformat() if last else None,
            "paused": commands.is_paused(self.ledger),
            "integrity_since": (self.ledger.get_meta("integrity_since") or None),
            "notes": list(self.notes.values()),
            "calendar": ([{"label": label, "ok_at": ok_at.isoformat() if ok_at else None,
                           "error": err} for label, ok_at, err in self.calendar.coverage()]
                         if self.calendar is not None and self.calendar.configured else []),
            "last_digest": {"at": self.ledger.get_meta("last_digest_at"),
                            "sent": self.ledger.get_meta("last_digest_sent") == "yes",
                            "text": self.ledger.get_meta("last_digest_text") or ""},
        })
