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
import re
import time
from concurrent.futures import Executor, Future
from datetime import datetime, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

from . import approvals, commands, effects, policy, prompts, render, rules, schema
from .config import Config
from .engines import CallOutcome, Engine, EngineError, EngineResult, call_with_retries
from .ledger import Ledger, iso

NOTE_HEAD = "\n\n[A suggestion from Cain"     # controller._note's fence

log = logging.getLogger("harness.runner")

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
    "internal_error": "a bug in the calendar specialist stopped it (it's logged)",
    "too_long": "the message is longer than I accept (12,000 characters)",
}


# Why a change from a handed-over message waits for a tap.
PROVENANCE = {
    "edited": "your message was edited after you sent it.",
    "forwarded": "it was a forwarded message, so the words may be someone else's.",
    "attachment": "your message had an attachment.",
    "foreign_reply": "it replied to a message that isn't yours or mine.",
    "suggestion": "it rests on something Cain suggested, not only your own words.",
    "cain_detail": "Cain spelled out the details for you.",
    "late": "it was handed over a while after you sent it.",
    "repaired": "my first reading of your message needed tidying before it fit.",
}

# Flags that mean Cain's words came with the request: a question for him goes to Cain first, who
# has them, never to a card asking him to say again what Cain already passed on (Nov 15).
CAIN_NOTE = frozenset({"suggestion", "cain_detail"})

# A question about what something means, one of the cards it posted included (P31: what a skating
# receipt meant, what a due date meant). It's answered in words, never taken for a change.
MEANING = re.compile(
    r"\bwhat (?:does|did|do|is|was) (?:this|that|it|the|your|you)\b[^?]{0,80}\bmean\b|"
    r"\bwhat do you mean\b|\bmeaning of\b|\bwhat(?:'s| is| was) (?:this|that) (?:card|message|receipt|notice|about)\b|"
    r"\bwhy did (?:i|you) get (?:this|that)\b", re.I)
# Words that point at something it posted: the cards are put in front of the model then.
CARD_WORDS = re.compile(r"\b(?:cards?|receipts?|notices?|that message|this message|your message|"
                        r"you (?:sent|posted|said)|it says|says due|due date)\b", re.I)
CARDS_BACK = timedelta(hours=24)
MAX_CARDS = 6


# A failure he didn't cause is never handed back to him as "send it again", with Cain in front or
# not: these are retried once, from the same message, on their own.
RETRYABLE = frozenset({"deadline", "interrupted", "internal_error", "rate_limited", "overloaded",
                       "server_error", "timeout", "network", "tls", "incomplete", "bad_output"})
RETRY_WINDOW_S = 24 * 3600
# A message that runs this long after he sent it (one sent while stopped, run at his tap, or run
# once more after a failure) is given to the model with the time he sent it.
SENT_NOTE_AFTER = timedelta(minutes=10)


def reason_text(reason: str, engine: str | None) -> str:
    spec = policy.MODELS.get(engine or "claude")
    name = PROVIDER_NAME.get(spec.provider, engine) if spec else "the model"
    return REASONS.get(reason, reason.replace("_", " ")).format(name=name)


class Runner:
    def __init__(self, ledger: Ledger, config: Config, engines: dict[str, Engine],
                 executor: Executor, *, sleep: Callable[[float], None] = time.sleep,
                 monotonic: Callable[[], float] = time.monotonic,
                 budgets_ok: Callable[[str], bool] | None = None, family_add=None,
                 calendar_change=None):
        self.family_add = family_add       # family_add.FamilyAdd, or None
        self.calendar_change = calendar_change   # calendar_change.CalendarChange, or None
        self.ledger = ledger
        self.config = config
        self.engines = engines
        self.executor = executor
        self.sleep = sleep
        self.monotonic = monotonic
        self._futures: dict[str, Future] = {}
        # On Discord, Cain is the conversation: an answer or "nothing to do" goes
        # back to Cain in the handover's reply, not into his DM.
        self.answers_to_cain = False
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
            # Never a resend ask: it comes back on its own card after /resume (commands.py).
            commands.note_stopped(self.ledger, job["id"], db)
            self._reply(db, job, "I'm stopped, so I didn't act on that.")

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
        family = self.family_add is not None
        change = self.calendar_change is not None and self.calendar_change.on()
        system = prompts.system_prompt(now=now, tz=self.config.timezone, rules=fired,
                                       stage_at_least=self.config.stage_at_least,
                                       family_add=family, calendar_change=change)
        shape = self.ledger.get_meta(f"job_shape:{job['id']}")
        if shape:
            system += prompts.shape_note(shape)
        if self.family_add is not None:
            self.family_add.note_message(text)
        sent = self._sent(job, now)
        cards = self.cards_for(job, text)
        user = prompts.user_content(text, earlier=self._earlier(job), sent=sent, cards=cards)
        out_schema = prompts.output_schema(self.config.stage_at_least, family_add=family,
                                           calendar_change=change)
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "running", db=db)
            self.ledger.job_set(job["id"], db=db, engine=engine_name, started_at=now)
        self._fired[job["id"]] = [r["id"] for r in fired]
        cc = self.calendar_change if change else None
        earlier = self._earlier(job)
        # What became of his last calendar requests, from the record (Nov 11: an answer said no
        # proposal had been sent when one had been approved). Read here: the worker has no ledger.
        recent = cc.recent(job["id"]) if cc else []

        t0 = self.monotonic()
        job_id = job["id"]

        def call():
            # In the worker: what his calendar says about the events he names is a Google read.
            # It counts against the job's own deadline, so retries never outlive the job
            # (Nov 8: a message with Cain's context ran past 10 minutes and was cut off).
            with_calendar = prompts.user_content(text, earlier=earlier, recent=recent, cards=cards,
                                                 calendar=cc.context_for(text, now), sent=sent) if cc else user
            spent = self.monotonic() - t0
            if spent > 20:
                log.info("job %s: reading his calendar for context took %d s", job_id, spent)
            return call_with_retries(engine, system=system, user=with_calendar, schema=out_schema,
                                     budget_s=policy.JOB_DEADLINE_S - 30 - spent, sleep=self.sleep,
                                     monotonic=self.monotonic)
        self._futures[job["id"]] = self.executor.submit(call)
        return True

    def cards_for(self, job, text: str) -> list[str]:
        """Its own recent cards, as he read them, when his message points at one: the one he
        replied to first, then the newest. It posted them, so it can say what one meant instead
        of asking him to say it again (P31)."""
        replied = self.ledger.outbound(job["chat_id"], job["reply_to_message_id"]) \
            if job["reply_to_message_id"] else None
        words = text.split(NOTE_HEAD, 1)[0]
        if replied is None and not MEANING.search(words) and not CARD_WORDS.search(words):
            return []
        out = []
        if replied is not None:
            out.append("(the one he replied to) " + render.plain(replied["text"])[:600])
        for r in self.ledger.db.execute(
                "SELECT text, created_at FROM outbound WHERE bot_id=? AND chat_id=? AND created_at>=?"
                " AND (job_id IS NULL OR job_id<>?) ORDER BY created_at DESC LIMIT ?",
                (self.ledger.bot_id(), job["chat_id"], iso(self.ledger.now() - CARDS_BACK), job["id"],
                 MAX_CARDS)).fetchall():
            said = render.plain(r["text"])[:600]
            if replied is None or said != render.plain(replied["text"])[:600]:
                out.append(said)
        return out[:MAX_CARDS]

    def _sent(self, job, now: datetime) -> str:
        """When he sent a message that runs well after it came in, in words the model reads."""
        sent = datetime.fromisoformat(job["created_at"])
        if now - sent < SENT_NOTE_AFTER:
            return ""
        local = sent.astimezone(ZoneInfo(self.config.timezone))
        return f"on {local:%A, %B} {local.day} at {render.clock_words(local, suffix=True)}"

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
            try:
                self._finish(job_id, outcome)
            except Exception as e:          # a bug after the answer: end the job now, never hang
                log.exception("finishing %s failed", job_id)
                job = self.ledger.job(job_id)
                if job is not None and job["state"] == "running":
                    self._fail(job, "internal_error", job["engine"],
                               detail=f"{type(e).__name__}: {e}"[:120])
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
            if self.calendar_change is not None and isinstance(e.__cause__, effects.ChangeRefusal):
                self.calendar_change.refuse_in_words(job, {"engine": engine, "model": res.model,
                                                           "usd": round(res.usd, 5)}, str(e))
                return
            if self.family_add is not None and isinstance(e.__cause__, effects.PlainRefusal):
                self.family_add.refuse_in_words(job, {"engine": engine, "model": res.model,
                                                      "usd": round(res.usd, 5)}, str(e))
                return
            repaired = effects.repair(res.output)
            try:
                out = schema.parse_output(repaired, stage_at_least=self.config.stage_at_least) \
                    if repaired is not None else None
            except schema.OutputError:
                out = None
            if out is None:
                self._fail(job, "bad_output", engine, result=res, detail=str(e)[:120])
                return
            log.info("job %s: the reply's shape was repaired (%s)", job_id, str(e)[:80])
            # Whatever was set right, a change from it waits for his tap.
            self.ledger.set_meta(f"job_flags:{job_id}", json.dumps(sorted(self._flags(job) | {"repaired"})))
        receipt = {"engine": engine, "model": res.model, "usd": round(res.usd, 5),
                   "tokens": [res.input_tokens, res.output_tokens], "rules": fired,
                   "type": out.type}
        handler = getattr(self, f"_on_{out.type}")
        handler(job, out.body, receipt, fired)

    def _footer_args(self, fired):
        return dict(rules_fired=tuple(fired), allowlist=self.config.link_allowlist)

    def _on_answer(self, job, body, receipt, fired):
        if self.answers_to_cain:
            self._to_cain(job, "answered", receipt, body["text"])
            return
        text = render.answer(job["id"], body["text"], **self._footer_args(fired))
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
            self._reply(db, job, text, kind="answer", raw=True)

    def _flags(self, job) -> set[str]:
        raw = self.ledger.get_meta(f"job_flags:{job['id']}")
        try:
            return set(json.loads(raw)) if raw else set()
        except ValueError:
            return set()

    def _meaning_question(self, job) -> bool:
        return bool(MEANING.search(self.ledger.job_text(job["id"]).split(NOTE_HEAD, 1)[0]))

    def _on_clarify(self, job, body, receipt, fired):
        if self.answers_to_cain and (self._flags(job) & CAIN_NOTE or self._meaning_question(job)):
            # Cain passed words with it, or he asked what something means: the question goes to
            # Cain, who has them, never to a card asking him to repeat himself (Nov 15, P31).
            self._to_cain(job, "needs_clarification", receipt,
                          "No card went to him. The specialist still needs this: " + body["question"]
                          + " If what you passed or found answers it, hand it over again with that"
                          " as the suggestion; if not, ask him in your own words.")
            return
        text = render.answer(job["id"], body["question"], **self._footer_args(fired))
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "needs_clarification",
                                   receipt=json.dumps(receipt), db=db)
            self._reply(db, job, text, kind="answer", raw=True)

    def _on_no_action(self, job, body, receipt, fired):
        if self.answers_to_cain:
            self._to_cain(job, "no_action", receipt, "Not a calendar change: " + body["reason"])
            return
        text = render.answer(job["id"], "Nothing to do: " + body["reason"],
                             **self._footer_args(fired))
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "no_action", receipt=json.dumps(receipt), db=db)
            self._reply(db, job, text, kind="answer", raw=True)

    def _to_cain(self, job, state: str, receipt: dict, words: str) -> None:
        receipt["said_to_cain"] = words[:1500]
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], state, receipt=json.dumps(receipt), db=db)

    def _provenance(self, job) -> list[str]:
        """Discord's own signs that the words may not be his own, fresh ones
        (controller._handover). Any of them puts the change on a card to tap."""
        raw = self.ledger.get_meta(f"job_flags:{job['id']}")
        return [PROVENANCE[f] for f in (json.loads(raw) if raw else []) if f in PROVENANCE]

    def _on_rule(self, job, body, receipt, fired):
        with self.ledger.tx() as db:
            try:
                rule_id = rules.hold(self.ledger, body["rule"], job_id=job["id"], db=db)
            except rules.RuleError as e:
                receipt["rule"] = {"refused": str(e)[:120]}
                self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
                self._reply(db, job, f"I can't keep that as a rule: {e}.")
                return
            receipt["rule"] = {"id": rule_id, "status": "pending"}
            self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
            row = db.execute("SELECT * FROM rules WHERE id=?", (rule_id,)).fetchone()
            buttons, binds = rules.card_buttons(self.ledger, rule_id, job["chat_id"], db)
            self._reply(db, job, rules.card_text(row), raw=True, buttons=buttons, binds=binds)

    def _on_proposal(self, job, body, receipt, fired):
        if self._meaning_question(job):
            # Asking what something means is never a change (P31): nothing is offered.
            receipt["reason"] = "meaning_question"
            if self.answers_to_cain:
                self._to_cain(job, "no_action", receipt, "Not a calendar change: he asked what "
                              "something means. Nothing was offered or changed. Answer him in words.")
                return
            with self.ledger.tx() as db:
                self.ledger.transition(job["id"], "no_action", receipt=json.dumps(receipt), db=db)
                self._reply(db, job, "That reads as a question about what something means, so I "
                                     "didn't change anything.")
            return
        # From S2 for calendar_hold: before that the schema has no such shape
        # and effects.lookup refuses it. family_event_add has its own switch.
        d = effects.lookup(body["effect_type"], self.config.stage_at_least)
        params = body["params"]
        family = d.name == effects.FAMILY_ADD
        change = d.name == effects.CALENDAR_CHANGE
        lines = None
        if change:
            if self.calendar_change is None:
                self._fail(job, "calendar_change_not_wired", job["engine"])
                return
            if self.calendar_change.refuse(job, receipt, params):
                return
            # Each event he names, found before anything is offered or done (Nov 11): clear goes
            # straight through, unclear is asked once, by name.
            seen = self.calendar_change.preview(job, receipt, params)
            if seen is None:
                return
            lines = seen.lines
            warnings = self.calendar_change.warnings(
                job, params, pasted_recently=self.family_add is not None and self.family_add._pasted_recently())
            warnings = list(warnings) + seen.checks   # what it does, not only whose words they are
        elif family:
            if self.family_add is None:
                self._fail(job, "family_add_not_wired", job["engine"])
                return
            if self.family_add.refuse(job, receipt, params):
                return
            warnings = self.family_add.warnings(params, message=self.ledger.job_text(job["id"]),
                                                replied=bool(job["reply_to_message_id"]))
        else:
            warnings = []
        warnings = list(warnings) + self._provenance(job)
        if change and warnings and len(params["changes"]) > 1:
            self._split(job, d, params, receipt)
            return
        self._offer(job, d, params, receipt, warnings, lines)

    def _offer(self, job, d, params, receipt, warnings, lines) -> None:
        """The proposal, and the card that tells him about it, or its run with no tap."""
        family = d.name == effects.FAMILY_ADD
        change = d.name == effects.CALENDAR_CHANGE
        # One transaction: the proposal and the card that tells him about it
        # are written together, so a crash can't leave a job with no words.
        with self.ledger.tx() as db:
            pid = approvals.create_proposal(self.ledger, job_id=job["id"],
                                            effect_type=d.name, params=params,
                                            policy_version=self.config.policy_version,
                                            ttl_s=min(d.ttl_s, self.config.approval_ttl_s),
                                            db=db)
            self.ledger.transition(job["id"], "proposed", db=db)
            if warnings and family:
                self.family_add.note_warned(pid, db)
            if change:                      # what it says it will do, for his tap and the record
                self.calendar_change.note_lines(
                    pid, lines or [render.change_line(c, self.config.timezone, self.ledger.now())
                                   for c in params["changes"]], db)
            if change and not warnings:
                self.calendar_change.auto_approve(pid, job["id"], db)
                self.ledger.event("proposal", {"job": job["id"], "proposal": pid,
                                               "receipt": receipt}, db=db)
                return                      # the controller does it this tick
            if family and not warnings and self.family_add.auto_approve(pid, job["id"], db):
                self.ledger.event("proposal", {"job": job["id"], "proposal": pid,
                                               "receipt": receipt}, db=db)
                return                      # the controller writes it this tick
            nonce = approvals.mint(self.ledger, proposal_id=pid,
                                   owner_user_id=self.config.owner_user_id,
                                   ttl_s=self.config.approval_ttl_s, db=db)
            row = db.execute("SELECT expires_at FROM approvals WHERE nonce=?",
                             (nonce,)).fetchone()
            card = render.proposal_card(d, params, tz=self.config.timezone,
                                        expires=datetime.fromisoformat(row["expires_at"]),
                                        job_id=job["id"], warnings=warnings, lines=lines or None,
                                        now=self.ledger.now())
            self.ledger.event("proposal", {"job": job["id"], "proposal": pid,
                                           "receipt": receipt}, db=db)
            self.ledger.enqueue(chat_id=job["chat_id"], kind="card", text=card,
                                job_id=job["id"], buttons=render.proposal_buttons(nonce),
                                binds=[{"type": "approval", "nonce": nonce}], db=db)

    def _split(self, job, d, params, receipt) -> None:
        """A message with several changes that needs his tap: each change on its own card, so he
        can take one and not the other, and one that's clear on its own goes through with its
        receipt (Nov 15: a drop-off removal and a term schedule change in one message). The first
        stays with his message's request; each other one is a part of it (ledger.part_job)."""
        cc = self.calendar_change
        pasted = self.family_add is not None and self.family_add._pasted_recently()
        parts = []
        for c in params["changes"]:
            sub = {"changes": [c]}
            seen = cc.preview_quiet(job, sub)
            warnings = list(cc.warnings(job, sub, pasted_recently=pasted)) + (seen.checks if seen else [])
            parts.append((sub, warnings + self._provenance(job), seen.lines if seen else None))
        log.info("job %s: %d changes, each on its own card or receipt", job["id"], len(parts))
        others = []
        with self.ledger.tx() as db:
            for _ in parts[1:]:
                others.append(self.ledger.part_job(job["id"], db=db))
            self.ledger.set_meta(f"job_parts:{job['id']}", json.dumps(others), db)
        for (sub, warnings, lines), jid in zip(parts, [job["id"]] + others):
            self._offer(self.ledger.job(jid), d, sub, dict(receipt, part=True), warnings, lines)

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
        started = job["started_at"] if "started_at" in job.keys() else None
        ran = ""
        if started:
            try:
                ran = f", {int((self.ledger.now() - datetime.fromisoformat(started)).total_seconds())} s after it started"
            except (TypeError, ValueError):
                ran = ""
        log.warning("job %s failed: %s (engine %s, %d attempts%s)", job["id"], reason, engine,
                    attempts, ran)
        retry = self._may_retry(job, reason)
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "failed", receipt=json.dumps(receipt), db=db)
            if retry:
                self.ledger.set_meta(f"job_retried:{job['id']}", self.ledger.now().isoformat(), db)
                if reason == "bad_output" and receipt.get("detail"):
                    # The second try is told what didn't fit, so it answers in shape.
                    self.ledger.set_meta(f"job_shape:{job['id']}", str(receipt["detail"])[:120], db)
                self.ledger.transition(job["id"], "received", db=db)
                self.ledger.event("job_retry", {"job": job["id"], "reason": reason}, db=db)
                self._reply(db, job, f"That didn't finish ({reason_text(reason, engine)}), "
                                     "so I'm running it once more by itself, from your message. Its "
                                     "answer comes here; nothing for you to do.", kind="notice")
            else:
                self._reply(db, job, f"I couldn't finish that: {reason_text(reason, engine)}. "
                                     f"Nothing was done. {self._next_after_fail(job, reason)}")

    def _next_after_fail(self, job, reason: str) -> str:
        """What happens next, never only that it failed (Nov 15)."""
        if self.ledger.get_meta(f"job_retried:{job['id']}"):
            return ("It failed twice, so it's logged for a fix, and nothing more happens with it on "
                    "its own." + (" Cain has been told." if self.answers_to_cain else ""))
        if reason in RETRYABLE:
            return "It's too old to run again by itself, so nothing more happens with it."
        return "Nothing more happens with it until that's fixed."

    def _may_retry(self, job, reason: str) -> bool:
        """Once per message, only for failures that aren't his doing, whoever is in front:
        a resend is never his to make (org rule R-004)."""
        if reason not in RETRYABLE or job["kind"] != "message":
            return False
        if self.ledger.get_meta(f"job_retried:{job['id']}"):
            return False
        age = (self.ledger.now() - datetime.fromisoformat(job["created_at"])).total_seconds()
        return age <= RETRY_WINDOW_S

    def retry_recent_failures(self) -> int:
        """After a restart (often an update with a fix): a message that failed for a
        reason that wasn't his, in the last day and never retried, runs once more.
        A change from it still waits for his tap."""
        n = 0
        for job in self.ledger.jobs_in("failed"):
            try:
                reason = json.loads(self.ledger.receipts(job["id"])[-1]["detail"] or "{}").get("reason")
            except (IndexError, ValueError):
                continue
            if self._may_retry(job, reason or ""):
                with self.ledger.tx() as db:
                    self.ledger.set_meta(f"job_retried:{job['id']}", self.ledger.now().isoformat(), db)
                    self.ledger.transition(job["id"], "received", db=db)
                    self.ledger.event("job_retry", {"job": job["id"], "reason": reason,
                                                    "after": "restart"}, db=db)
                n += 1
        return n

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
