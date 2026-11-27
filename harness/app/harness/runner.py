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
from typing import Any, Callable
from zoneinfo import ZoneInfo

from . import approvals, choices, commands, effects, policy, prompts, provenance, render, rules, schema
from .scrub import scrub as scrubbed   # twenty-sixth round: exception text, scrubbed
from .config import Config
from .engines import CallOutcome, Engine, EngineError, EngineResult, call_with_retries
from .ledger import Ledger, iso

NOTE_HEAD = "\n\n[A suggestion from Cain"     # controller._note's fence


def _addresses(old: dict, old_targets: set, new: dict, new_targets: set) -> bool:
    """A rerun's change speaks to an open card's change: the same event (by calendar and id), or
    the same kind of change to an event of that name (one name holds the other's words)."""
    if old_targets and new_targets and old_targets & new_targets:
        return True
    if old.get("op") != new.get("op"):
        return False
    from .calendar_change import fit
    a, b = str(old.get("title", "")), str(new.get("title", ""))
    return bool(a and b and (fit(a, b) or fit(b, a)))


def _maybe_addresses(old: dict, new: dict) -> bool:
    """Whether a rerun's change might speak to an open card's change, where plain code can't tell
    (0.24.0, fifth round): one name holds the other's words but the kind of change differs, or the
    same kind of change on the same calendar and day. Then the card asking which is used, never a
    guess either way."""
    from .calendar_change import fit
    a, b = str(old.get("title", "")), str(new.get("title", ""))
    if a and b and (fit(a, b) or fit(b, a)):
        return True
    day = lambda c: (c.get("dates") or "")[:10] or (c.get("start") or "")[:10]   # noqa: E731
    return old.get("op") == new.get("op") and old.get("calendar") == new.get("calendar") \
        and bool(day(old)) and day(old) == day(new)


def _change_key(c: dict) -> tuple:
    """One change, however the model spaced or cased its title."""
    return (c.get("op"), c.get("calendar"), " ".join(str(c.get("title", "")).casefold().split()),
            c.get("dates", ""), c.get("start", ""), c.get("end", ""), c.get("days", ""), c.get("until", ""))

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
    "not_newest": "it acts on an earlier message of yours, not your newest.",
    "split": "it's one of several changes in one message, so each comes on its own card.",
    "correction": "you sent it while the change just before it was being made, so it's read as a correction of that change.",
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
# A Family copy of his Gmail event that's out of step, named with what's wrong with it: in his words or in
# Cain's note, a question or not ("why is the family mirrored event not updating", Nov 27). Plain code finds
# every such copy by its event's own identity and offers the fix on a card (calendar_change.copy_fixes).
COPY_NAMED = re.compile(r"\b(?:family\b[^.?!]{0,40}\b(?:cop(?:y|ies)|mirror\w*|duplicate)|mirror(?:ed|ing)?\b[^.?!]{0,20}"
                        r"\b(?:event|copy|copies|appointment)|cop(?:y|ies) (?:on|in) (?:the )?family)\b", re.I)
COPY_WRONG = re.compile(r"\b(?:fix\w*|wrong|stale|behind|out of (?:step|sync|date)|(?:not|n't|never) "
                        r"(?:updat|follow|match|mov|chang|sync)\w*|updat\w*|sync\w*|match\w*|correct\w*|left)\b", re.I)
# A drive block named in Cain's note: his own words may be only a question ("why is there no travel time").
DRIVE_NAMED = re.compile(r"\b(?:drive|driving|travel)[ -]?(?:blocks?|times?)\b|\bdrive (?:there|back|home)\b", re.I)
CARDS_BACK = timedelta(hours=24)
MAX_CARDS = 6


# A failure he didn't cause is never handed back to him as "send it again", with Cain in front or
# not: these are retried once, from the same message, on their own.
RETRYABLE = frozenset({"deadline", "interrupted", "internal_error", "rate_limited", "overloaded",
                       "server_error", "timeout", "network", "tls", "incomplete", "bad_output"})
RETRY_WINDOW_S = 24 * 3600
CLARIFY_WAIT_S = 10 * 60   # a question for Cain he hasn't answered by then goes to the owner, on a card
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
        # Posts the drive blocks' card to that chat (meaning_live.drive_card), True when it went: set by the
        # controller once drive blocks are wired.
        self.drive_card: Callable[[int, str], bool] | None = None
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
        if calendar_change is not None:
            calendar_change.to_card = self.card_instead
            calendar_change.reoffer = self.reoffer
            calendar_change.recard = self.recard
            calendar_change.start_again = self.start_again
            calendar_change.script_card = self.script_card

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
            if self._waits(job):
                continue
            if self._start(job):
                started.append(job["id"])
        return started

    def _waits(self, job) -> bool:
        """A correction for a message whose change his tap is having done right now waits until
        that settles, then reads the result (0.24.0, third round): it runs once nothing of its
        message is being written under a live lease."""
        if self.calendar_change is None or not self.ledger.get_meta(f"job_parent:{job['id']}"):
            return False
        ids = self._family_of(job)
        marks = ",".join("?" * len(ids))
        for (pid,) in self.ledger.db.execute(
                f"SELECT id FROM proposals WHERE effect_type=? AND job_id IN ({marks}) AND job_id<>?",
                (effects.CALENDAR_CHANGE, *ids, job["id"])).fetchall():
            if self.calendar_change.in_flight(pid) and self.calendar_change.lease_state(pid) == "live":
                return True
        return False

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
        # Which calendar is his, found here too: finding it reads the record, and SQLite refuses
        # a read from the worker's thread (Nov 19: "I cancelled PT today" crashed twice before
        # Claude was called, from 0.24.1, when finding his calendar began to read the record).
        address = cc.context_address() if cc else None

        t0 = self.monotonic()
        job_id = job["id"]

        def call():
            # In the worker: what his calendar says about the events he names is a Google read.
            # It counts against the job's own deadline, so retries never outlive the job
            # (Nov 8: a message with Cain's context ran past 10 minutes and was cut off).
            # The read is a help, never a stop: one that fails leaves the model without it.
            calendar: list[str] = []
            if cc:
                try:
                    calendar = cc.context_for(text, now, address)
                except Exception as e:
                    log.warning("job %s: reading his calendar for context failed: %s", job_id, type(e).__name__)
            with_calendar = prompts.user_content(text, earlier=earlier, recent=recent, cards=cards,
                                                 calendar=calendar, sent=sent) if cc else user
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
            except Exception as e:          # a bug in a worker, not a provider answer: said as ours
                log.error("worker crashed on %s: %s", job_id, type(e).__name__)
                outcome = CallOutcome(error=EngineError("fatal", "internal_error", type(e).__name__))
            try:
                self._finish(job_id, outcome)
            except Exception as e:          # a bug after the answer: end the job now, never hang
                log.exception("finishing %s failed", job_id)
                job = self.ledger.job(job_id)
                if job is not None and job["state"] == "running":
                    self._fail(job, "internal_error", job["engine"],
                               detail=scrubbed(f"{type(e).__name__}: {e}")[:120])
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
                                                           "usd": round(res.usd, 5)}, scrubbed(e))
                return
            if self.family_add is not None and isinstance(e.__cause__, effects.PlainRefusal):
                self.family_add.refuse_in_words(job, {"engine": engine, "model": res.model,
                                                      "usd": round(res.usd, 5)}, scrubbed(e))
                return
            repaired, touched = effects.repair_fields(res.output)
            try:
                out = schema.parse_output(repaired, stage_at_least=self.config.stage_at_least) \
                    if repaired is not None else None
            except schema.OutputError:
                out = None
            if out is None:
                self._fail(job, "bad_output", engine, result=res, detail=scrubbed(e)[:120])
                return
            log.info("job %s: the reply's shape was repaired (%s)", job_id, str(e)[:80])
            # Whatever was set right, a change from it waits for his tap.
            with self.ledger.tx() as db:
                self.ledger.set_meta(f"job_flags:{job_id}", json.dumps(sorted(self._flags(job) | {"repaired"})), db)
                self.ledger.set_meta(f"job_repaired:{job_id}", json.dumps(touched), db)
        receipt = {"engine": engine, "model": res.model, "usd": round(res.usd, 5),
                   "tokens": [res.input_tokens, res.output_tokens], "rules": fired,
                   "type": out.type}
        if out.type != "proposal" and self._plain_fix(job, receipt, fired):
            return
        handler = getattr(self, f"_on_{out.type}")
        handler(job, out.body, receipt, fired)

    def _plain_fix(self, job, receipt: dict, fired) -> bool:
        """A copy fix or a drive block that the model answered in words, or asked about, still gets its card
        (Nov 27: "not a change", twice, when his words were a question). A copy fix in his words or Cain's
        note: plain code finds each Family copy out of step with its Gmail event and offers to bring it
        back, on a card like any change. A drive block in Cain's note: the drive blocks' card. A card from
        Cain's note says so, as every change resting on his words does. True when it's handled here."""
        text = self.ledger.job_text(job["id"]) or ""
        his, _, note = text.partition(NOTE_HEAD)
        if self.calendar_change is not None and any(
                COPY_NAMED.search(t) and COPY_WRONG.search(t) for t in (his, note) if t):
            changes = self.calendar_change.copy_fixes()
            if changes is None:
                return False               # a calendar can't be read: the model's own reply stands
            receipt["plain"] = "copy_fix"
            if changes:
                receipt["type"] = "proposal"
                self._on_proposal(job, {"effect_type": "calendar_change", "params": {"changes": changes},
                                        "summary": "Bring the Family copies back to their Gmail events"},
                                  receipt, fired)
            else:
                self._on_answer(job, {"text": "Every Family copy of your Gmail events matches its event now, "
                                              "so there's nothing to fix."}, receipt, fired)
            return True
        if note and DRIVE_NAMED.search(note) and self.drive_card is not None:
            if not self.drive_card(job["chat_id"], job["id"]):
                return False
            receipt["plain"] = "drive_card"     # the card is its answer, to Cain as to him
            with self.ledger.tx() as db:
                self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
            return True
        return False

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
            receipt["question"] = body["question"][:500]
            mid = self._message_id(job)
            again = f"keeper.sh handover --message {mid} \"<the answer>\"" if mid else \
                "keeper.sh handover \"<the answer>\""
            self._to_cain(job, "needs_clarification", receipt,
                          "No card went to him. The specialist still needs this: " + body["question"]
                          + f" Answer it now with a note: {again}. If only he can answer, ask him with"
                          " one card; never ask him to repeat a change he already made in words. With"
                          " no note in 10 minutes, the specialist asks him itself, on a card.")
            with self.ledger.tx() as db:      # its deadline, kept: checked every tick and after a restart
                self.ledger.set_meta(f"clarify_due:{job['id']}",
                                     iso(self.ledger.now() + timedelta(seconds=CLARIFY_WAIT_S)), db)
            return
        text = render.answer(job["id"], body["question"], **self._footer_args(fired))
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "needs_clarification",
                                   receipt=json.dumps(receipt), db=db)
            self._reply(db, job, text, kind="answer", raw=True)

    def _message_id(self, job) -> str:
        """The Discord message of his a request rests on, for Cain's note: its parts' too."""
        root = self.ledger.job(self.ledger.get_meta(f"job_parent:{job['id']}") or job["id"]) or job
        return str(root["message_id"]) if (root["message_id"] or 0) > 0 else ""

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
        out = [PROVENANCE[f] for f in (json.loads(raw) if raw else []) if f in PROVENANCE]
        touched = json.loads(self.ledger.get_meta(f"job_repaired:{job['id']}") or "[]")
        if touched and PROVENANCE["repaired"] in out:
            out[out.index(PROVENANCE["repaired"])] = (
                PROVENANCE["repaired"].rstrip(".") + f" (fields tidied: {', '.join(touched)}).")
        return out

    def _on_rule(self, job, body, receipt, fired):
        with self.ledger.tx() as db:
            try:
                rule_id = rules.hold(self.ledger, body["rule"], job_id=job["id"], db=db)
            except rules.RuleError as e:
                receipt["rule"] = {"refused": scrubbed(e)[:120]}
                self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
                self._reply(db, job, f"I can't keep that as a rule: {scrubbed(e)}.")
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
        seen = None
        head: list[str] = []
        replaced_keys: set = set()
        racing = False
        if change:
            if self.calendar_change is None:
                self._fail(job, "calendar_change_not_wired", job["engine"])
                return
            if self.calendar_change.refuse(job, receipt, params):
                return
            # A request run again (a note from Cain) never does twice what's done or being done:
            # those are said as done, and only the rest is offered.
            done_lines, busy_lines, params = self._not_yet_done(job, params)
            # A later note or rerun replaces only the open cards whose change it addresses; the
            # others stay as they are, still offered on their own cards (0.24.0, third round).
            waiting_lines, params, replaced_keys, racing, asks, quiet = self._address_open(job, params)
            # A note that speaks to none of the open cards is never dropped (0.24.0, fifth round): its
            # change runs as a request of its own, and the line about the cards that stand, quoting
            # the note, goes on that one response, so the note gets exactly one.
            notice = self._newer_note(job, quiet) if quiet else ""
            for c, pids in asks:
                self._ask_which(job, c, pids)
            if not params["changes"]:
                if asks and not (done_lines or busy_lines):
                    with self.ledger.tx() as db:      # its answer is the card asking which
                        receipt["reason"] = "asked_which"
                        self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
                    return
                self._all_done(job, receipt, done_lines, busy_lines, waiting_lines)
                return
            head = ([notice] if notice else []) \
                + [f"Already done: {x}" for x in done_lines] + [f"In progress: {x}" for x in busy_lines] \
                + [f"Still on its own card: {x}" for x in waiting_lines]
            # Each event he names, found before anything is offered or done (Nov 11): clear goes
            # straight through, unclear is asked once, by name.
            seen = self.calendar_change.preview(job, receipt, params)
            if seen is None:
                if notice:                           # its question or refusal is out; the cards' line follows
                    with self.ledger.tx() as db:
                        self._reply(db, job, render.escape(notice), raw=True, kind="notice")
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
        if change and head:
            warnings.append("part of this message was already done or is on another card, so only the "
                            "rest is here.")
        if change and racing:
            warnings.append("your tap on the earlier card for this is being carried out; this one is "
                            "checked against what that does.")
        if change and warnings and len(params["changes"]) > 1:
            self._split(job, d, params, receipt, head, replaced=replaced_keys)
            return
        self._offer(job, d, params, receipt, warnings, lines, seen=seen, head=head,
                    replaced=bool(replaced_keys) or None if change else None)

    def _offer(self, job, d, params, receipt, warnings, lines, *, seen=None, head=(),
               replaced: bool | None = None, keep_versions: bool = True, new_family: bool = False,
               keys: list[str] | None = None) -> None:
        """The proposal, and the card that tells him about it, or its run with no tap. Only his
        own newest message, under 2 minutes old, with nothing of Cain's and not split, runs with
        no tap: anything else carries a flag (_provenance) and comes on a card."""
        family = d.name == effects.FAMILY_ADD
        change = d.name == effects.CALENDAR_CHANGE
        top: list[str] = []
        if receipt.get("source") == "mail" and not receipt.get("tapped") and not warnings:
            warnings = ["it comes from your mail, and mail never changes a calendar without your tap."]
        if change:
            top, cains = self._origin(job, params)
            if cains and not warnings:
                warnings = ["a detail on this card is from Cain or isn't in your own words."]
        # One transaction: the proposal and the card that tells him about it
        # are written together, so a crash can't leave a job with no words.
        with self.ledger.tx() as db:
            # A rerun's card replaces any card still open for this request: its buttons come off,
            # so a tap binds only to the proposal it shows.
            gone = approvals.supersede_open(self.ledger, [job["id"]], db=db)
            if replaced is None:
                replaced = bool(gone) or db.execute(
                    "SELECT 1 FROM proposals WHERE job_id=? AND state='superseded' LIMIT 1", (job["id"],)).fetchone()
            pid = approvals.create_proposal(self.ledger, job_id=job["id"],
                                            effect_type=d.name, params=params,
                                            policy_version=self.config.policy_version,
                                            ttl_s=min(d.ttl_s, self.config.approval_ttl_s),
                                            db=db)
            self.ledger.transition(job["id"], "proposed", db=db)
            if warnings and family:
                self.family_add.note_warned(pid, db)
            if change:
                # A change offered again keeps the fixed id of its first offer (0.24.0, fourth round); one he
                # started again is a new change family and keeps nothing (eighth round).
                olds = self.calendar_change.inherit_keys(pid, params["changes"],
                                                         {} if new_family else self._earlier_keys(job), db)
                if keys is not None:
                    # Twentieth round: a retry's fixed ids, set with its proposal (the very ids its preview read),
                    # so no card is ever approvable while its write would go to another id.
                    self.ledger.set_meta(f"calendar_change_keys:{pid}", json.dumps([str(k) for k in keys]), db)
            if change:                      # what it says it will do, for his tap and the record
                self.calendar_change.note_lines(
                    pid, lines or [render.change_line(c, self.config.timezone, self.ledger.now())
                                   for c in params["changes"]], db, seen=seen)
                if keep_versions and olds:
                    # And, for a move or removal, the version its first card was bound to (sixth round),
                    # so the first write landing just before or after this one's can't make two. Not
                    # for the fresh card after a refused write: that one is bound to the event as it is.
                    self.calendar_change.inherit_versions(pid, olds, db)
            # The no-card paths only once the smoke test is recorded as passed (keeper.sh fastpath
            # on, 0.24.0 fourth round); until then this is a normal card.
            if change and not warnings and self.calendar_change.fast_path_ok():
                self.calendar_change.auto_approve(pid, job["id"], db)
                self.ledger.event("proposal", {"job": job["id"], "proposal": pid,
                                               "receipt": receipt}, db=db)
                return                      # the controller does it this tick
            if family and not warnings and self.family_add.auto_approve(pid, job["id"], db):
                self.ledger.event("proposal", {"job": job["id"], "proposal": pid,
                                               "receipt": receipt}, db=db)
                return                      # the controller writes it this tick
            # Eighth round: after an install, a card for a calendar whose check hasn't finished is held:
            # it says so, with no Approve, and comes back on a fresh card once that calendar's gate opens.
            held = self.calendar_change.held_by_gate(params, seen.bound if seen is not None else None,
                                                     job_id=job["id"]) if change else []
            if held:
                self.calendar_change.note_held(pid, job["id"], held, db)
                self.calendar_change.tell_held(held, db)      # tenth round: once per calendar, why and what unblocks
                from .calendar_change import provider_name
                names = " and ".join(provider_name(x) for x in held)
                body = lines or [render.change_line(c, self.config.timezone, self.ledger.now())
                                 for c in params["changes"]]
                text = (f"<b>Waiting for the check after installing on {names}.</b> Harness was updated, and "
                        f"calendar changes on {names} wait until that check has finished there, so this has no "
                        "Approve yet. Nothing has changed. Once it's done, this comes back on a fresh card, read "
                        "again then, for your tap.\n" + "\n".join(top + [render.escape(x) for x in head] + body))
                self.ledger.event("proposal", {"job": job["id"], "proposal": pid, "receipt": receipt,
                                               "held": held}, db=db)
                self.ledger.enqueue(chat_id=job["chat_id"], kind="card", text=render.fit(text), job_id=job["id"],
                                    db=db)
                return
            loose = bool(change and seen is not None and seen.loose and len(params["changes"]) == 1)
            nonce = approvals.mint(self.ledger, proposal_id=pid,
                                   owner_user_id=self.config.owner_user_id,
                                   ttl_s=self.config.approval_ttl_s, db=db)
            row = db.execute("SELECT expires_at FROM approvals WHERE nonce=?",
                             (nonce,)).fetchone()
            if change:
                body = lines or [render.change_line(c, self.config.timezone, self.ledger.now())
                                 for c in params["changes"]]
                lines = (["Replaces the earlier card."] if replaced else []) + top \
                    + [render.escape(x) for x in head] + body
                # Twelfth round: a card for a calendar written without its version check says so before his tap.
                note = self.calendar_change.unprotected_note(params, seen.bound if seen is not None else None)
                if note:
                    lines = lines + [note]
            card = render.proposal_card(d, params, tz=self.config.timezone,
                                        expires=datetime.fromisoformat(row["expires_at"]),
                                        job_id=job["id"], warnings=warnings, lines=lines or None,
                                        now=self.ledger.now())
            self.ledger.event("proposal", {"job": job["id"], "proposal": pid,
                                           "receipt": receipt}, db=db)
            self.ledger.enqueue(chat_id=job["chat_id"], kind="card", text=card,
                                job_id=job["id"], buttons=render.proposal_buttons(
                                    nonce, **({"approve": "Add anyway", "decline": "Leave it"} if loose else {})),
                                binds=[{"type": "approval", "nonce": nonce}], db=db)

    def reoffer(self, kind: str, target: str) -> str:
        """His tap on a card that offers requests again (0.24.0, fourth round): Propose again on the
        message listing what the ledger migration replaced, or his pick of which card a note
        corrects. Each comes back as a new card for his tap, quoting his message, never applied."""
        if kind == "calendar_change_which":
            return self._which_picked(target)
        from . import migrate
        n = found = 0
        for pid in migrate.listed(self.ledger, target):
            p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (pid,)).fetchone()
            if p is None or p["state"] not in ("superseded", "failed"):
                continue
            # A read of its slot first (0.24.0, fifth round): one the calendar now shows is said as
            # confirmed, not offered again.
            if self.calendar_change.found_now(pid):
                found += 1
                continue
            if self._again(p, "you tapped Propose again after Harness updated, so this is your request from "
                              "before, on a new card."):
                n += 1
        if not n:
            return "Already on the calendar, so nothing to bring back." if found else "Nothing to bring back there."
        return f"Back on {n} new card{'s' * (n != 1)}, each waiting for your tap."

    def recard(self, p, changes: list, why: str, keep_versions: bool = False, keys: list[str] | None = None) -> str:
        """A change on a fresh card for the same message (sixth round): one the calendar refused for
        its version (calendar_change._finish), read anew so the card is bound to the event's version
        now, never to the old card's; or one that waited on a card while writes were paused
        (calendar_change._resume_paused), keeping the version its card was bound to. Its request's id,
        or "" when there's none to offer. Twentieth round: `keys`, the keys of the fixed ids it must
        write to (a retry's, from its first offer): set with its proposal, and its preview read at them."""
        old = self.ledger.job(p["job_id"])
        if old is None or not changes:
            return ""
        return self._offer_new(old, {"changes": list(changes)}, why, replaced=True if keep_versions else False,
                               keep_versions=keep_versions, keys=keys)

    def script_card(self, chat_id: int, text: str, params: dict, own: Callable[[str, Any], None]) -> str:
        """A smoke run's step, from its own script (tenth round): a request the specialist makes itself
        (never from his DM), owned by the run (`own`, in the same transaction), on a card for his Approve.
        Its request's id."""
        with self.ledger.tx() as db:
            new = self.ledger.made_job(chat_id, text, kind="smoke_step", db=db)
            own(new, db)
        job = self.ledger.job(new)
        seen = self.calendar_change.preview_quiet(job, params)
        self._offer(job, effects.REGISTRY[effects.CALENDAR_CHANGE], params, {"reason": "smoke_step"},
                    seen.checks if seen else [], seen.lines if seen else None, seen=seen, replaced=False,
                    keep_versions=False, new_family=True)
        return new

    def start_again(self, p, changes: list, why: str) -> str:
        """His Try again or Start again from now (eighth round): the change on a new card for the same
        message, read anew and bound to the event as it is now, as a new change family: it inherits no
        fixed ids or versions, so it has its own one fresh card. Its request's id, or ""."""
        old = self.ledger.job(p["job_id"])
        if old is None or not changes:
            return ""
        return self._offer_new(old, {"changes": list(changes)}, why, replaced=False, keep_versions=False,
                               new_family=True)

    def _again(self, p, why: str) -> str:
        """One earlier request's change, as a new request of the same message, on a card."""
        old = self.ledger.job(p["job_id"])
        try:
            params = json.loads(p["params_json"])
        except (ValueError, TypeError):
            return ""
        return self._offer_new(old, params, why, replaced=False) if old is not None else ""

    def card_instead(self, p, why: str) -> None:
        """A change that was going through with no tap, found at the moment of its write to need
        one after all (calendar_change._execute): it comes on his card, saying why, and nothing is
        written. The proposal it was is replaced by one compare-and-set, so it can't also run."""
        with self.ledger.tx() as db:
            # Also his tapped change when writes are paused (0.24.0, fifth round: too many writes still
            # running), by the same compare-and-set on the state it was read in.
            took = db.execute("UPDATE proposals SET state='superseded' WHERE id=? AND state=? AND state IN"
                              " ('auto_approved','approved')", (p["id"], p["state"])).rowcount == 1
            if took:
                self.ledger.event("fast_path_to_card", {"proposal": p["id"], "why": why[:80]}, db=db)
        if not took:
            return
        job = self.ledger.job(p["job_id"])
        if job is None or job["state"] != "approved":
            return
        d = effects.REGISTRY[effects.CALENDAR_CHANGE]
        params = json.loads(p["params_json"])
        cc = self.calendar_change
        kept = cc.bound_of(p["id"]) or {}
        raw = self.ledger.get_meta(f"calendar_change_lines:{p['id']}")
        lines = json.loads(raw) if raw else None
        from .calendar_change import Preview
        seen = Preview(lines or [], [], kept.get("bound", []), kept.get("loose", []))
        self._offer(job, d, params, {"reason": "fast_path_recheck"},
                    [f"{why}, so this waits for your tap. Nothing has changed."], lines, seen=seen,
                    replaced=False)

    def _split(self, job, d, params, receipt, head=(), replaced: set | frozenset = frozenset()) -> None:
        """A message with several changes that needs his tap: each change on its own card, so he
        can take one and not the other (Nov 15: a drop-off removal and a term schedule change in
        one message). Every part of a split comes on a card, even one clear on its own: the
        message as a whole wasn't. The first stays with his message's request; each other one is a
        part of it (ledger.part_job). A rerun reuses the parts it already has."""
        cc = self.calendar_change
        pasted = self.family_add is not None and self.family_add._pasted_recently()
        parts = []
        for c in params["changes"]:
            sub = {"changes": [c]}
            seen = cc.preview_quiet(job, sub)
            warnings = list(cc.warnings(job, sub, pasted_recently=pasted)) + (seen.checks if seen else [])
            flags = self._provenance(job)
            if PROVENANCE["split"] not in flags:
                flags.append(PROVENANCE["split"])
            parts.append((sub, warnings + flags, seen.lines if seen else None, seen))
        log.info("job %s: %d changes, each on its own card", job["id"], len(parts))
        root = self.ledger.get_meta(f"job_parent:{job['id']}") or job["id"]
        known = json.loads(self.ledger.get_meta(f"job_parts:{root}") or "[]")
        # Parts it already has and that are open again (a rerun) are used before new ones.
        # A part still on an open card isn't reused: that card stands (_address_open).
        free = [j for j in known if j != job["id"] and (self.ledger.job(j) or {"state": ""})["state"]
                in ("received", "running", "cancelled")]
        others = []
        with self.ledger.tx() as db:
            for _ in parts[1:]:
                if free:
                    jid = free.pop(0)
                    st = self.ledger.job(jid)["state"]
                    for nxt in {"cancelled": ("received", "running"), "received": ("running",)}.get(st, ()):
                        self.ledger.transition(jid, nxt, db=db)
                    others.append(jid)
                else:
                    others.append(self.ledger.part_job(job["id"], db=db))
            self.ledger.set_meta(f"job_parts:{root}", json.dumps(list(dict.fromkeys(known + others))), db)
        for (sub, warnings, lines, seen), jid in zip(parts, [job["id"]] + others):
            self._offer(self.ledger.job(jid), d, sub, dict(receipt, part=True), warnings, lines,
                        seen=seen, head=head if jid == job["id"] else (),
                        replaced=_change_key(sub["changes"][0]) in replaced or None)

    # -- where it came from, and what's already done --------------------------------------------
    def _origin(self, job, params) -> tuple[list[str], bool]:
        """The card's first lines: the message of his it acts on, quoted, with its age and how many
        he sent after it, and each change field by field, with what came from Cain marked so.
        (lines, HTML-safe; whether any field is Cain's and not his)."""
        root = self.ledger.get_meta(f"job_parent:{job['id']}") or job["id"]
        raw = self.ledger.get_meta(f"job_origin:{job['id']}") or self.ledger.get_meta(f"job_origin:{root}")
        try:
            origin = json.loads(raw) if raw else {}
        except ValueError:
            origin = {}
        text = self.ledger.job_text(job["id"])
        his, _, note = text.partition(NOTE_HEAD)
        if not origin and not note:
            # No handover to quote, but a day his words leave open still needs his tap (0.24.0).
            try:
                sent = datetime.fromisoformat(job["created_at"]).astimezone(ZoneInfo(self.config.timezone))
            except (ValueError, TypeError):
                sent = None
            return [], bool(provenance.open_day(his, sent, self.config.timezone))
        out = provenance.origin_lines(origin, self.ledger.now()) if origin else []
        cains = False
        try:                                   # his day, for "tomorrow" sent just before midnight
            sent = datetime.fromisoformat(origin.get("sent_at") or job["created_at"])
        except (ValueError, TypeError):
            sent = None
        for c in params.get("changes", []):
            line, theirs = provenance.detail_line(c, his, note, self.config.timezone, self.ledger.now(), sent)
            out.append(line)
            cains = cains or theirs
        return out, cains

    def _family_of(self, job) -> list[str]:
        root = self.ledger.get_meta(f"job_parent:{job['id']}") or job["id"]
        return [root] + json.loads(self.ledger.get_meta(f"job_parts:{root}") or "[]")

    def _earlier_keys(self, job) -> dict:
        """Each change of this message offered before and not done (its lease ran out, it read back
        as not confirmed, the calendar refused it as stale, or its card was replaced), to the key its
        fixed id was made from, so the
        same change offered again writes to the same address (calendar_change.inherit_keys)."""
        ids = self._family_of(job)
        marks = ",".join("?" * len(ids))
        out: dict = {}
        for r in self.ledger.db.execute(
                f"SELECT p.id FROM proposals p LEFT JOIN calendar_changes x ON x.proposal_id=p.id"
                f" WHERE p.effect_type=? AND p.job_id IN ({marks}) AND (x.state IN ('lapsed','unverified','absent','stale')"
                " OR p.state='superseded') ORDER BY p.created_at", (effects.CALENDAR_CHANGE, *ids)).fetchall():
            for k, v in self.calendar_change.keys_by_change(r["id"]).items():
                out.setdefault(k, v)
        return out

    def _not_yet_done(self, job, params) -> tuple[list[str], list[str], dict]:
        """Changes of this message already done, or being done, under any of its requests (its
        parts included), said in the words they were done in; and what's left to offer (0.24.0,
        third round). Done is only what the calendar was read back showing (or an add the read
        found already there), or an add whose slot held one like it that he looked at and left.
        One being written counts as in progress only while its lease runs; past it the calendar is
        read, and what isn't done is offered again. The same change is the same op on the same
        calendar, title, days and times, or a removal of an event one already took off (by
        calendar and id). (done, in progress, params left)."""
        ids = self._family_of(job)
        marks = ",".join("?" * len(ids))
        rows = self.ledger.db.execute(
            f"SELECT p.id, p.params_json, p.state, x.undo_state, x.state AS done_state FROM proposals p"
            f" LEFT JOIN calendar_changes x ON x.proposal_id=p.id WHERE p.effect_type=? AND p.job_id IN ({marks})"
            " AND p.state IN ('approved','auto_approved','executing','executed','failed','declined')",
            (effects.CALENDAR_CHANGE, *ids)).fetchall()
        rows = [r for r in rows if (r["undo_state"] or "none") != "undone"]
        if not rows:
            return [], [], params
        done_keys, busy_keys, done_targets, done_names = {}, {}, {}, []
        for r in rows:
            if r["state"] == "declined":
                if not self.ledger.get_meta(f"calendar_change_left:{r['id']}"):
                    continue
                into = done_keys
            elif r["state"] in ("executed", "failed"):
                # Done is what the calendar was read showing: a change confirmed by a later read, or a
                # write that landed after its lease ran out, counts; not confirmed or lapsed doesn't.
                if (r["done_state"] or ("done" if r["state"] == "executed" else "")) not in ("done", "landed_late"):
                    continue
                into = done_keys
            else:
                lease = self.calendar_change.lease_state(r["id"])
                if lease in ("live", "unsure"):          # a read that can't tell never lapses it
                    into = busy_keys
                elif lease == "done":
                    into = done_keys
                else:
                    continue                 # read and not done: offered again
            try:
                changes = json.loads(r["params_json"])["changes"]
                raw = self.ledger.get_meta(f"calendar_change_lines:{r['id']}")
                said = json.loads(raw) if raw else []
            except (ValueError, KeyError, TypeError):
                continue
            for i, c in enumerate(changes):
                said_i = said[i] if i < len(said) and len(said) == len(changes) else \
                    render.change_line(c, self.config.timezone, self.ledger.now())
                if r["state"] == "declined":
                    said_i = "Left as it is: " + said_i
                into[_change_key(c)] = said_i
            if into is done_keys:
                bound = (self.calendar_change.bound_of(r["id"]) or {}).get("bound", [])
                for b in bound:
                    if b.get("op", "remove") == "remove":
                        done_targets[(b["calendar"], b["series"], b["instance"])] = said[0] if said else "a removal"
                        days = {c.get("dates", "") for c in changes if c.get("op") == "remove"}
                        done_names.append((b["title"], days, said[0] if said else "a removal"))
        left, done, busy = [], [], []
        for c in params["changes"]:
            key = _change_key(c)
            if key in done_keys:
                done.append(done_keys[key])
                continue
            if key in busy_keys:
                busy.append(busy_keys[key])
                continue
            if c["op"] == "remove" and done_targets:
                seen = self.calendar_change.preview_quiet(job, {"changes": [c]})
                hit = [done_targets[k] for k in ((b["calendar"], b["series"], b["instance"])
                                                 for b in (seen.bound if seen else [])) if k in done_targets]
                if not hit and seen is None:
                    # Gone already, so a read can't find it: the removal done on those days of an
                    # event of that name (one name holding the other's words) is this one.
                    from .calendar_change import block_name, fit
                    hit = [w for title, days, w in done_names if c.get("dates", "") in days and any(
                        fit(c["title"], n) or fit(n, c["title"]) for n in (title, block_name(title)))]
                if hit:
                    done.append(hit[0])
                    continue
            left.append(c)
        if done or busy:
            log.info("job %s: %d change(s) already done, %d in progress, %d left", job["id"], len(done),
                     len(busy), len(left))
        return ([render.plain(x) for x in dict.fromkeys(done)], [render.plain(x) for x in dict.fromkeys(busy)],
                {**params, "changes": left})

    def _address_open(self, job, params) -> tuple[list[str], dict, set, bool, list, list]:
        """The open cards of this message, against a rerun's changes (0.24.0, third and fourth
        rounds). A rerun's change replaces an open card, by one compare-and-set, when it speaks to
        that card's change: the same event (by calendar and id), or else, by name only (the same
        kind of change to an event one name holds the other's words of), when exactly one open card
        matches; when several match by name, none is replaced and a card asks which one it corrects.
        A card offering exactly a change the rerun repeats stands (unless it's replaced anyway), and
        that change isn't offered twice; a card the rerun doesn't speak to stands, still offered. A
        card his tap took first isn't replaced: the new change is checked against what that does.
        (lines for the cards that stand, params left, keys of changes that replaced a card, whether
        one raced his tap, [(a change, the cards it may correct)] to ask about, and the open cards
        when the rerun speaks to none of them)."""
        ids = [j for j in self._family_of(job) if j != job["id"]]
        if not ids or not params["changes"]:
            return [], params, set(), False, [], []
        marks = ",".join("?" * len(ids))
        open_rows = self.ledger.db.execute(
            f"SELECT id, job_id, params_json FROM proposals WHERE effect_type=? AND state='proposed'"
            f" AND job_id IN ({marks}) ORDER BY created_at", (effects.CALENDAR_CHANGE, *ids)).fetchall()
        if not open_rows:
            return [], params, set(), False, [], []
        cc = self.calendar_change
        mine = []
        for c in params["changes"]:
            seen = cc.preview_quiet(job, {"changes": [c]})
            mine.append((c, {(b["calendar"], b["series"], b["instance"]) for b in (seen.bound if seen else [])}))
        cards = []
        for r in open_rows:
            try:
                theirs = json.loads(r["params_json"])["changes"]
            except (ValueError, KeyError, TypeError):
                continue
            kept = cc.bound_of(r["id"]) or {}
            raw = self.ledger.get_meta(f"calendar_change_lines:{r['id']}")
            said = (json.loads(raw) if raw else []) or [render.change_line(t, self.config.timezone,
                                                                           self.ledger.now()) for t in theirs]
            cards.append({"row": r, "theirs": theirs, "said": render.plain(said[0]),
                          "targets": {(b["calendar"], b["series"], b["instance"]) for b in kept.get("bound", [])}})
        replace: dict[str, set] = {}
        repeats: dict[int, list] = {}
        asks, unclear = [], set()
        for i, (c, targets) in enumerate(mine):
            again = [k for k in cards if any(_change_key(c) == _change_key(t) for t in k["theirs"])]
            if again:
                repeats[i] = again
                continue
            by_id = [k for k in cards if targets and k["targets"] and targets & k["targets"]]
            by_name = [k for k in cards if k not in by_id and any(_addresses(t, set(), c, set()) for t in k["theirs"])]
            hit = by_id or (by_name if len(by_name) == 1 else [])
            for k in hit:
                replace.setdefault(k["row"]["id"], set()).add(i)
            if not hit and len(by_name) > 1:
                asks.append((c, [k["row"]["id"] for k in by_name]))
                unclear.add(i)
            elif not hit:
                maybe = [k for k in cards if any(_maybe_addresses(t, c) for t in k["theirs"])]
                if maybe:                            # can't tell: ask (Card 1, ..., Neither), never guess
                    asks.append((c, [k["row"]["id"] for k in maybe]))
                    unclear.add(i)
        drop = set(unclear)
        for i, again in repeats.items():
            if any(k["row"]["id"] in replace for k in again):
                for k in again:
                    if k["row"]["id"] in replace:
                        replace[k["row"]["id"]].add(i)
            else:
                drop.add(i)                          # offered already, on a card that stands
        stands, replaced_keys, racing = [], set(), False
        for k in cards:
            r = k["row"]
            if r["id"] not in replace:
                stands.append(k["said"])             # not spoken to (or asked about): it stands
                continue
            with self.ledger.tx() as db:
                won = approvals.supersede(self.ledger, r["id"], db=db)
                if won:
                    other = db.execute("SELECT state FROM jobs WHERE id=?", (r["job_id"],)).fetchone()
                    if other is not None and other["state"] == "proposed":
                        self.ledger.transition(r["job_id"], "cancelled", db=db,
                                               receipt=json.dumps({"reason": "replaced"}))
            if won:
                replaced_keys |= {_change_key(mine[i][0]) for i in replace[r["id"]]}
                log.info("job %s: a card it speaks to was replaced", job["id"])
            else:
                racing = True                         # his tap got there first
        left = [c for i, (c, _) in enumerate(mine) if i not in drop]
        spoke = bool(replace or repeats or asks)
        quiet = [] if spoke else [k["row"]["id"] for k in cards]
        return list(dict.fromkeys(stands)), {**params, "changes": left}, replaced_keys, racing, asks, quiet

    # -- a note that can't say which card it corrects, or speaks to none ------------------------------
    def _ask_which(self, job, change: dict, pids: list[str]) -> None:
        """A note whose change may correct several open cards by name: none is replaced, and one card
        asks which (0.24.0, fourth round). His pick replaces that card with the corrected change, on
        a new card; Neither puts the change on a card of its own, beside the others."""
        import secrets
        token = secrets.token_hex(6)
        said = []
        for pid in pids[:4]:
            raw = self.ledger.get_meta(f"calendar_change_lines:{pid}")
            p = self.ledger.db.execute("SELECT params_json FROM proposals WHERE id=?", (pid,)).fetchone()
            first = (json.loads(raw) if raw else []) or [render.change_line(json.loads(p[0])["changes"][0],
                                                                            self.config.timezone, self.ledger.now())]
            said.append(render.plain(first[0]))
        what = render.plain(render.change_line(change, self.config.timezone, self.ledger.now()))
        lines = ["<b>Which card does the newer note correct?</b> It could be more than one, so nothing was "
                 f"replaced yet. The correction: {render.escape(what)}."]
        lines += [f"Card {i}: {render.escape(x)}" for i, x in enumerate(said, 1)]
        lines.append("Pick the card it replaces, or Neither to put it on a card of its own and leave these as they are.")
        with self.ledger.tx() as db:
            self.ledger.set_meta(f"calendar_change_which:{token}", json.dumps(
                {"job": job["id"], "change": change, "cards": pids[:4]}), db)
            buttons, binds = [], []
            for i in list(range(len(said))) + [-1]:
                nonce = choices.mint(self.ledger, kind="calendar_change_which", target=f"{token}:{i}",
                                     chat_id=job["chat_id"], ttl_s=self.config.approval_ttl_s, db=db)
                buttons.append((f"Card {i + 1}" if i >= 0 else "Neither", choices.callback_data(nonce)))
                binds.append({"type": "choice", "nonce": nonce})
            self._reply(db, job, "\n".join(lines), raw=True, kind="card", buttons=[buttons], binds=binds)
        log.info("job %s: its note may correct %d cards; asked which", job["id"], len(said))

    def _which_picked(self, target: str) -> str:
        token, _, pick = target.rpartition(":")
        try:
            data = json.loads(self.ledger.get_meta(f"calendar_change_which:{token}") or "{}")
            index = int(pick)
        except ValueError:
            return "Nothing changed."
        if not data:
            return "Nothing changed."
        job = self.ledger.job(data["job"])
        if job is None:
            return "Nothing changed."
        params = {"changes": [data["change"]]}
        if index < 0:
            self._offer_new(job, params, "you said the newer note corrects none of the earlier cards, so this "
                                         "is a card of its own and they stand.", replaced=False)
            return "Put on a card of its own; the other cards stay as they are."
        pid = data["cards"][index] if index < len(data["cards"]) else ""
        with self.ledger.tx() as db:
            won = bool(pid) and approvals.supersede(self.ledger, pid, db=db)
            if won:
                p = db.execute("SELECT job_id FROM proposals WHERE id=?", (pid,)).fetchone()
                st = db.execute("SELECT state FROM jobs WHERE id=?", (p[0],)).fetchone()
                if st is not None and st["state"] == "proposed":
                    self.ledger.transition(p[0], "cancelled", db=db, receipt=json.dumps({"reason": "replaced"}))
        why = ("you picked the card this corrects, so it replaces that one." if won else
               "your tap on the card it corrects came first; this one is checked against what that does.")
        self._offer_new(job, params, why, replaced=won)
        return "The correction is on a new card." + (" That card is off." if won else "")

    def _offer_new(self, src, params: dict, why: str, *, replaced: bool, keep_versions: bool = True,
                   new_family: bool = False, keys: list[str] | None = None) -> str:
        """A change for the same message as `src` (its quote, flags and fixed ids kept), as a new
        request, on a card: never applied without his tap. Its request's id."""
        root = self.ledger.get_meta(f"job_parent:{src['id']}") or src["id"]
        with self.ledger.tx() as db:
            new = self.ledger.made_job(src["chat_id"], self.ledger.job_text(src["id"]), kind="message_again",
                                       db=db, reply_to=src["reply_to_message_id"], created_at=src["created_at"])
            self.ledger.set_meta(f"job_parent:{new}", root, db)
            flags = self.ledger.get_meta(f"job_flags:{src['id']}") or self.ledger.get_meta(f"job_flags:{root}")
            if flags:
                self.ledger.set_meta(f"job_flags:{new}", flags, db)
            parts = json.loads(self.ledger.get_meta(f"job_parts:{root}") or "[]")
            self.ledger.set_meta(f"job_parts:{root}", json.dumps(parts + [new]), db)
        job = self.ledger.job(new)
        seen = self.calendar_change.preview_quiet(job, params, keys=keys)
        warnings = [why] + (seen.checks if seen else [])
        self._offer(job, effects.REGISTRY[effects.CALENDAR_CHANGE], params, {"reason": "offered_again"}, warnings,
                    seen.lines if seen else None, seen=seen, replaced=replaced, keep_versions=keep_versions,
                    new_family=new_family, keys=keys)
        return new

    def _newer_note(self, job, pids: list[str]) -> str:
        """A note ran on this message and speaks to none of its open cards (0.24.0, fourth and fifth
        rounds): each stands, its Approve relabeled "Approve as shown", and Approve on each then asks
        once more before it does anything (approvals: calendar_change_note_check). The line saying so,
        quoting the note, is returned for the note's own response (its card)."""
        said = []
        text = self.ledger.job_text(job["id"])
        seg = text.rsplit(NOTE_HEAD, 1)[1] if NOTE_HEAD in text else ""   # the newest note, as fenced
        note = (seg.split(": ", 1)[1] if ": " in seg else "").rstrip().removesuffix("]")
        quote = provenance.one_line(note, 100) if note.strip() else ""
        with self.ledger.tx() as db:
            for pid in pids:
                self.ledger.set_meta(f"calendar_change_note_check:{pid}", "pending", db)
                raw = self.ledger.get_meta(f"calendar_change_lines:{pid}")
                if raw:
                    said.append(render.plain(json.loads(raw)[0]))
                for a in db.execute("SELECT nonce, message_id FROM approvals WHERE proposal_id=? AND consumed_at IS NULL",
                                    (pid,)).fetchall():
                    buttons = render.proposal_buttons(a["nonce"], approve="Approve as shown")
                    if a["message_id"]:
                        self.ledger.enqueue(chat_id=job["chat_id"], kind="rebutton", text=str(a["message_id"]),
                                            buttons=buttons, db=db)
                    else:
                        db.execute("UPDATE outbox SET buttons_json=? WHERE state IN ('queued','held') AND binds_json LIKE ?",
                                   (json.dumps(buttons), f'%{a["nonce"]}%'))
        log.info("job %s: a note that speaks to none of its %d open card(s): each asks once more", job["id"], len(pids))
        return ("A newer note" + (f", \u201c{quote}\u201d," if quote else "") + " doesn't speak to "
                + ("the earlier card" if len(pids) == 1 else "the earlier cards") + (" (" + "; ".join(said) + ")" if said else "")
                + ", so " + ("it stays" if len(pids) == 1 else "they stay") + " as shown, Approve there asks once more, "
                "and the note is this request of its own.")

    def _all_done(self, job, receipt, done_lines, busy_lines=(), waiting_lines=()) -> None:
        receipt["reason"] = "already_done"
        parts = []
        if done_lines:
            parts.append("Already done, nothing new to change: " + "; ".join(done_lines) + ".")
        if busy_lines:
            parts.append("Being done now: " + "; ".join(busy_lines) + ".")
        if waiting_lines:
            parts.append("Still waiting for your tap on its own card: " + "; ".join(waiting_lines) + ".")
        words = " ".join(parts) or "Nothing new to change."
        if self.answers_to_cain:
            self._to_cain(job, "answered", receipt, words + " Nothing was offered again.")
            return
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "answered", receipt=json.dumps(receipt), db=db)
            self._reply(db, job, words)

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
                # Said only after a ten-minute wait, when the retry may take as long again. Any
                # other retry runs within seconds and its outcome is what he hears: a notice of it
                # reached him after that outcome (Nov 19), and Cain then had to explain it.
                if reason == "deadline":
                    self._reply(db, job, f"That didn't finish ({reason_text(reason, engine)}), "
                                         "so I'm running it once more.", kind="notice")
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
