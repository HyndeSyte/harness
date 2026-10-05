"""The job runner: one message in, one receipt out, every time.

    received -> running -> engine call (in a worker thread) -> schema
             -> answer | clarify | no_action | rule | proposal (S2+)
             -> a terminal state with a receipt, and a reply in the outbox,
                written together in one transaction

Worker threads only make the HTTP call. Every ledger read and write
happens on the controller's thread, so SQLite never sees two writers and
a job's state can't be changed behind the runner's back.

Time: he hears "still working" at 3 minutes and the job fails at 10, with
a receipt saying nothing was done. A reply that arrives after that is
recorded (it was billed) and discarded, never delivered late and out of
context. A retryable provider error is retried with back-off inside the
deadline on the same engine. There is no silent failover to another model.
"""
from __future__ import annotations

import json
import logging
import time
from concurrent.futures import Executor, Future
from datetime import datetime, timedelta
from typing import Callable

from . import approvals, choices, policy, prompts, render, rules, schema
from .config import Config
from .engines import CallOutcome, Engine, EngineError, EngineResult, call_with_retries
from .ledger import Ledger, iso

log = logging.getLogger("harness.runner")

CHOICE_TTL_S = 7 * 24 * 3600

PROVIDER_NAME = {"anthropic": "Claude", "openai": "GPT"}

# What a failure reason means, in words he can act on.
REASONS = {
    "budget": "this month's {name} budget is used up",
    "billing": "the {name} account is out of credit",
    "spend_limit": "the {name} account hit its spending limit",
    "auth": "the {name} API key was refused",
    "no_key": "no {name} API key is set",
    "model_missing": "the pinned {name} model isn't available",
    "rate_limited": "{name} is rate-limiting requests",
    "overloaded": "{name} is overloaded",
    "server_error": "{name} had a server error",
    "timeout": "{name} didn't answer in time",
    "network": "the Pi couldn't reach {name}",
    "tls": "the secure connection to {name} failed",
    "refused": "{name} declined to answer",
    "incomplete": "{name}'s reply was cut off",
    "bad_output": "{name}'s reply didn't fit the allowed shapes",
    "deadline": "it took longer than 10 minutes",
    "interrupted": "the harness restarted while working on it",
    "too_long": "the message is longer than I accept (12,000 characters)",
}


def reason_text(reason: str, engine: str | None) -> str:
    spec = policy.MODELS.get(engine or "claude")
    name = PROVIDER_NAME.get(spec.provider, engine) if spec else "the model"
    return REASONS.get(reason, reason.replace("_", " ")).format(name=name)


class Runner:
    def __init__(self, ledger: Ledger, config: Config, engines: dict[str, Engine],
                 executor: Executor, *, sleep: Callable[[float], None] = time.sleep,
                 monotonic: Callable[[], float] = time.monotonic,
                 budgets_ok: Callable[[str], bool] | None = None):
        self.ledger = ledger
        self.config = config
        self.engines = engines
        self.executor = executor
        self.sleep = sleep
        self.monotonic = monotonic
        self._futures: dict[str, Future] = {}
        self._fired: dict[str, list[str]] = {}
        self._budgets_ok = budgets_ok or self._budget_ok

    # -- budget -----------------------------------------------------------
    def _budget_ok(self, provider: str) -> bool:
        budget = self.config.monthly_budget_usd.get(provider)
        if budget is None:
            return True
        return self.ledger.spend_month(provider) < budget

    @property
    def in_flight(self) -> int:
        return len(self._futures)

    # -- start ---------------------------------------------------------------
    def start_pending(self, *, paused: bool) -> list[str]:
        started = []
        for job in self.ledger.jobs_in("received"):
            if job["kind"] != "message":
                continue
            if paused:
                self._stopped(job)
                continue
            if self._start(job):
                started.append(job["id"])
        return started

    def _stopped(self, job) -> None:
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "cancelled",
                                   receipt=json.dumps({"reason": "stopped"}), db=db)
            self._reply(db, job, "I'm stopped, so I didn't act on that. Send /resume to "
                                 "start again, then resend it.")

    def _start(self, job) -> bool:
        text = self.ledger.job_text(job["id"])
        engine_name = policy.engine_for(job["kind"])
        engine = self.engines.get(engine_name)
        spec = policy.MODELS[engine_name]
        if len(text) > policy.MAX_INPUT_CHARS:
            self._refuse(job, "too_long", engine_name)
            return False
        if engine is None:
            self._refuse(job, "no_key", engine_name)
            return False
        if not self._budgets_ok(spec.provider):
            self._refuse(job, "budget", engine_name)
            return False
        now = self.ledger.now()
        fired = rules.active_for_message(self.ledger, policy.MAX_RULES_PER_CALL)
        system = prompts.system_prompt(now=now, tz=self.config.timezone, rules=fired,
                                       stage_at_least=self.config.stage_at_least)
        user = prompts.user_content(text, earlier=self._earlier(job))
        out_schema = prompts.output_schema(self.config.stage_at_least)
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "running", db=db)
            self.ledger.job_set(job["id"], db=db, engine=engine_name, started_at=now)
        self._fired[job["id"]] = [r["id"] for r in fired]
        self._futures[job["id"]] = self.executor.submit(
            call_with_retries, engine, system=system, user=user, schema=out_schema,
            budget_s=policy.JOB_DEADLINE_S - 30, sleep=self.sleep, monotonic=self.monotonic)
        return True

    def _refuse(self, job, reason: str, engine_name: str) -> None:
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "rejected",
                                   receipt=json.dumps({"reason": reason,
                                                       "engine": engine_name}), db=db)
            self._reply(db, job, f"I didn't run that: {reason_text(reason, engine_name)}. "
                                 "Nothing was sent to a model.")

    def _earlier(self, job) -> list[tuple[str, str]]:
        """The exchange this message continues: the one he replied to, or
        else the last one if it was recent. Capped."""
        prev = None
        if job["reply_to_message_id"]:
            prev = self.ledger.outbound(job["chat_id"], job["reply_to_message_id"])
        if prev is None:
            prev = self.ledger.db.execute(
                "SELECT * FROM outbound WHERE bot_id=? AND chat_id=? AND kind='answer'"
                " AND created_at>=? ORDER BY created_at DESC LIMIT 1",
                (self.ledger.bot_id(), job["chat_id"],
                 iso(self.ledger.now() - timedelta(seconds=policy.CONTEXT_WINDOW_S)))).fetchone()
        if prev is None or not prev["job_id"] or prev["job_id"] == job["id"]:
            return []
        asked = self.ledger.job_text(prev["job_id"])
        said = render.plain(prev["text"])
        half = policy.MAX_CONTEXT_CHARS // 2
        return [("he", asked[:half]), ("you", said[:half])]

    # -- finish ------------------------------------------------------------------
    def collect(self) -> int:
        done = 0
        for job_id, fut in list(self._futures.items()):
            if not fut.done():
                continue
            del self._futures[job_id]
            try:
                outcome = fut.result()
            except Exception as e:          # a bug in a worker, not a provider answer
                log.error("worker crashed on %s: %s", job_id, type(e).__name__)
                outcome = CallOutcome(error=EngineError("fatal", "bad_output", type(e).__name__))
            self._finish(job_id, outcome)
            done += 1
        return done

    def _finish(self, job_id: str, outcome: CallOutcome) -> None:
        job = self.ledger.job(job_id)
        fired = self._fired.pop(job_id, [])
        res = outcome.result
        if res is not None:
            spec = policy.MODELS.get(res.engine)
            self.ledger.add_spend(provider=spec.provider if spec else res.engine,
                                  model=res.model, purpose="job", job_id=job_id,
                                  input_tokens=res.input_tokens,
                                  output_tokens=res.output_tokens, usd=res.usd)
        if job is None or job["state"] != "running":
            self.ledger.event("late_result_discarded",
                              {"job": job_id, "state": job["state"] if job else None})
            return
        engine = job["engine"]
        if res is None:
            e = outcome.error or EngineError("fatal", "bad_output")
            self._fail(job, e.reason, engine, attempts=outcome.attempts)
            return
        if res.status != "ok":
            self._fail(job, res.status, engine, result=res)
            return
        try:
            out = schema.parse_output(res.output, stage_at_least=self.config.stage_at_least)
        except schema.OutputError as e:
            self._fail(job, "bad_output", engine, result=res, detail=str(e)[:120])
            return
        receipt = {"engine": engine, "model": res.model, "usd": round(res.usd, 5),
                   "tokens": [res.input_tokens, res.output_tokens], "rules": fired,
                   "type": out.type}
        handler = getattr(self, f"_on_{out.type}")
        handler(job, out.body, receipt, fired)

    def _footer_args(self, fired):
        return dict(rules_fired=tuple(fired), allowlist=self.config.link_allowlist)

    def _on_answer(self, job, body, receipt, fired):
        text = render.answer(job["id"], body["text"], **self._footer_args(fired))
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
            self._reply(db, job, text, kind="answer", raw=True)

    def _on_clarify(self, job, body, receipt, fired):
        text = render.answer(job["id"], body["question"], **self._footer_args(fired))
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "needs_clarification",
                                   receipt=json.dumps(receipt), db=db)
            self._reply(db, job, text, kind="answer", raw=True)

    def _on_no_action(self, job, body, receipt, fired):
        text = render.answer(job["id"], "Nothing to do: " + body["reason"],
                             **self._footer_args(fired))
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "no_action", receipt=json.dumps(receipt), db=db)
            self._reply(db, job, text, kind="answer", raw=True)

    def _on_rule(self, job, body, receipt, fired):
        with self.ledger.tx() as db:
            try:
                outcome = rules.propose(self.ledger, body["rule"], job_id=job["id"], db=db)
            except rules.RuleError as e:
                receipt["rule"] = {"refused": str(e)[:120]}
                self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
                self._reply(db, job, f"I can't keep that as a rule: {e}.")
                return
            receipt["rule"] = {"id": outcome.rule_id, "status": outcome.status}
            self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
            if outcome.status == "quarantined":
                old = outcome.conflicts_with[0]
                new_n = choices.mint(self.ledger, kind="rule_keep_new", target=outcome.rule_id,
                                     chat_id=job["chat_id"], ttl_s=CHOICE_TTL_S, db=db)
                old_n = choices.mint(self.ledger, kind="rule_keep_old", target=outcome.rule_id,
                                     chat_id=job["chat_id"], ttl_s=CHOICE_TTL_S, db=db)
                text = (f"That clashes with rule {render.escape(old)}. "
                        f"Use the new one ({render.escape(outcome.rule_id)}) or keep the old?")
                self._reply(db, job, text, raw=True,
                            buttons=[[("Use new", choices.callback_data(new_n)),
                                      ("Keep old", choices.callback_data(old_n))]],
                            binds=[{"type": "choice", "nonce": new_n},
                                   {"type": "choice", "nonce": old_n}])
                return
            undo_n = choices.mint(self.ledger, kind="rule_undo", target=outcome.rule_id,
                                  chat_id=job["chat_id"], ttl_s=CHOICE_TTL_S, db=db)
            self._reply(db, job, render.escape(outcome.message) +
                        f" <i>({render.escape(outcome.rule_id)})</i>", raw=True,
                        buttons=[[("Undo", choices.callback_data(undo_n))]],
                        binds=[{"type": "choice", "nonce": undo_n}])

    def _on_proposal(self, job, body, receipt, fired):
        # Reachable only from S2: before that the schema has no proposal
        # shape and effects.lookup refuses calendar_hold.
        from . import effects
        d = effects.lookup(body["effect_type"], self.config.stage_at_least)
        params = body["params"]
        with self.ledger.tx() as db:
            pid = approvals.create_proposal(self.ledger, job_id=job["id"],
                                            effect_type=d.name, params=params,
                                            policy_version=self.config.policy_version,
                                            ttl_s=min(d.ttl_s, self.config.approval_ttl_s),
                                            db=db)
            self.ledger.transition(job["id"], "proposed", db=db)
        nonce = approvals.mint(self.ledger, proposal_id=pid,
                               owner_user_id=self.config.owner_user_id,
                               ttl_s=self.config.approval_ttl_s)
        row = self.ledger.db.execute("SELECT expires_at FROM approvals WHERE nonce=?",
                                     (nonce,)).fetchone()
        card = render.proposal_card(d, params, tz=self.config.timezone,
                                    expires=datetime.fromisoformat(row["expires_at"]),
                                    job_id=job["id"])
        with self.ledger.tx() as db:
            self.ledger.event("proposal", {"job": job["id"], "proposal": pid,
                                           "receipt": receipt}, db=db)
            self.ledger.enqueue(chat_id=job["chat_id"], kind="card", text=card,
                                job_id=job["id"], buttons=render.proposal_buttons(nonce),
                                binds=[{"type": "approval", "nonce": nonce}], db=db)

    # -- failure and time ------------------------------------------------------------
    def _fail(self, job, reason: str, engine: str | None, *, result: EngineResult | None = None,
              attempts: int = 0, detail: str = "") -> None:
        receipt = {"reason": reason, "engine": engine}
        if result is not None:
            receipt.update(model=result.model, usd=round(result.usd, 5),
                           detail=result.detail or detail)
        elif detail:
            receipt["detail"] = detail
        if attempts:
            receipt["attempts"] = attempts
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "failed", receipt=json.dumps(receipt), db=db)
            self._reply(db, job, f"I couldn't finish that: {reason_text(reason, engine)}. "
                                 "Nothing was done. Send it again to retry.")

    def check_timers(self) -> None:
        now = self.ledger.now()
        for job in self.ledger.jobs_in("running"):
            if not job["started_at"]:
                continue
            age = (now - datetime.fromisoformat(job["started_at"])).total_seconds()
            if age >= policy.JOB_DEADLINE_S:
                self._fail(job, "deadline", job["engine"])
            elif age >= policy.STILL_WORKING_AFTER_S and not job["slow_notice_at"]:
                with self.ledger.tx() as db:
                    self.ledger.job_set(job["id"], db=db, slow_notice_at=now)
                    self._reply(db, job, f"Still working on that ({int(age // 60)} min so far).",
                                kind="notice")

    def reconcile_after_restart(self) -> int:
        """A job left running by a previous process has no worker any more.
        It fails, loudly, rather than hanging forever."""
        n = 0
        for job in self.ledger.jobs_in("running"):
            if job["id"] in self._futures:
                continue
            self._fail(job, "interrupted", job["engine"])
            n += 1
        return n

    def cancel_in_flight(self, job_id: str) -> None:
        fut = self._futures.get(job_id)
        if fut is not None:
            fut.cancel()        # if already running, its result will be discarded

    # -- output ----------------------------------------------------------------
    def _reply(self, db, job, text: str, *, kind: str = "reply", raw: bool = False,
               buttons=None, binds=None) -> None:
        body = text if raw else render.escape(text)
        self.ledger.enqueue(chat_id=job["chat_id"], kind=kind, text=render.fit(body),
                            job_id=job["id"], buttons=buttons, binds=binds, db=db)
        # He is talking to it right now, so anything held for "the next
        # reply" (a continuity notice before proactive messages are
        # allowed) goes out with this one.
        self.ledger.release_held(db=db)
