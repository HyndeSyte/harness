"""The controller loop: one thread owns the ledger and decides everything.

Each tick:
  1. take requests from the settings page (a reset, mostly);
  2. without the Discord bot token, wait; identify the bot and its owner once;
  3. what Cain handed over: his taps on our cards, his requests (read from his
     own DM), the morning digest;
  4. commands, then message jobs (started in workers, collected here), then
     their timers;
  5. announce any settings change waiting for his tap;
  6. the daily canary and digest;
  7. send what is due from the outbox (cards go to Cain's link);
  8. publish a status snapshot for the settings page.

Nothing in here calls a model directly. The only thing it can do to the world
at S1 is the Family calendar add, which is off until his tap (family_add.py):
it runs after the commands, so a /stop in the same batch wins.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import re
import sqlite3
import time
from concurrent.futures import Executor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from . import (approvals, callbacks, choices, commands, daily, effects, ingress_filter, integrity, migrate,
               handover, policy, provenance, render, rules, scrub, vault, watch)
from .calendar_change import CalendarChange
from .chat import Decision, Incoming
from .config import Config
from .discord_api import DiscordError, escape
from .discord_chat import PREFIX as DISCORD_PREFIX, RESUME, STOP
from .engines import Engine
from .ledger import TERMINAL, Ledger, LedgerBusy, LedgerFenced, TransactionAborted, iso
from .outbox import Outbox
from .runner import CLARIFY_WAIT_S, Runner
from .vault import LABELS, Vault

log = logging.getLogger("harness.controller")

SETTINGS_TTL_S = 15 * 60
FRESH_S = 120              # a handed-over message must be this new, or the handover itself
NAMED_FRESH_S = 30 * 60    # a message Cain names, or one his suggestion rests on, this new
DIGEST_WAIT_S = 40 * 60    # Cain has this long to fold the digest into his morning update
PROBE_S = 5                # the watch's check of Cain and its message: short, never a stuck loop
HEARD_FLOOR_S = 1_420_070_400   # 2015-01-01: an older "last heard from Discord" is nonsense
# 0.24.0, fourth round: the fast path's re-check measures his message's age from the time inside its
# Discord id (a snowflake) against the Pi's clock, allowing them this far apart: fresh means under
# 2 minutes less this, and a message that seems to come from more than this ahead of the Pi's clock
# can't be timed, so it comes on a card.
DISCORD_EPOCH_MS = 1_420_070_400_000
CLOCK_TOLERANCE_S = 5
SNOWFLAKE_FLOOR = datetime(2020, 1, 1).timestamp()


def snowflake_time(message_id) -> datetime | None:
    """When Discord made a message, from its id. None when the id isn't a snowflake of this decade
    (a test's or a broken id), and then the message's own timestamp is used instead."""
    try:
        ms = (int(str(message_id)) >> 22) + DISCORD_EPOCH_MS
    except (TypeError, ValueError):
        return None
    if ms / 1000 < SNOWFLAKE_FLOOR:
        return None
    from datetime import timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


NOTE_HEAD = "\n\n[A suggestion from Cain"        # every fence starts so (calendar_change._his_words)
_NOTE_WORD = re.compile(r"[a-z0-9]+")
_NOTE_SKIP = frozenset("""a an and are as at be by for from he his i in is it its me my of off on or
    our so that the this to was we with you your him has have had not no but than then there they
    them do does did will would can could should cain dane owner asked asks says said wants change
    calendar please""".split())


def _note_words(text: str) -> set[str]:
    return {w for w in _NOTE_WORD.findall(text.casefold()) if len(w) > 1 and w not in _NOTE_SKIP}


def echoes_message(suggestion: str, message: str) -> bool:
    """Cain's suggestion passes on what this message of his says (Nov 15: Cain spelled out his
    Wednesday change, and it was read as Cain's own idea): most of its words are in his message.
    Some must be: a suggestion that only adds facts is Cain's."""
    said, his = _note_words(suggestion), _note_words(message)
    shared = said & his
    return len(shared) >= 2 and len(shared) * 2 >= len(said)


def _note(suggestion: str, *, echoes: bool = False) -> str:
    """Cain's own words with a request of his, fenced so they're never taken for his. When they
    pass on what his message says, the fence says so: the request is his, and the details are
    Cain's reading of it."""
    if echoes:
        return (NOTE_HEAD + ", his assistant, passing on what he asks in this message. Act on his "
                "message; these words only spell it out: " + suggestion + "]")
    return NOTE_HEAD + ", his assistant. These are not his words: " + suggestion + "]"


def family_line(st: dict, tz: ZoneInfo) -> str:
    """One status line about Family pushes. Counts and times only."""
    if st.get("received_at"):
        at = datetime.fromisoformat(st["received_at"]).astimezone(tz)
        line = f"last push {at:%a %-I:%M %p}, {st['events']} event(s)"
        if not st.get("ok"):
            line += ", Home Assistant couldn't read it"
    else:
        line = "no push from Home Assistant yet"
    if st.get("rejected_at") and (not st.get("received_at")
                                  or st["rejected_at"] > st["received_at"]):
        line += f" (last push refused: {st['rejected']})"
    return line


class Controller:
    def __init__(self, *, ledger: Ledger, vault: Vault, api, engines: dict[str, Engine],
                 executor: Executor, base_config: Config,
                 sleep: Callable[[float], None] = time.sleep,
                 monotonic: Callable[[], float] = time.monotonic,
                 status_box: dict | None = None, requests: "queue.Queue | None" = None,
                 poll_timeout: int = 25, calendar=None, family=None, mirror=None,
                 family_add=None, family_copy=None, family_gmail=None, calendar_change=None,
                 mail_dates=None, meaning=None, meaning_live=None):
        self.calendar_change = calendar_change   # changes he asks for (calendar_change.py), or None
        self.family_add = family_add       # the one calendar write (family_add.py), or None
        self.family_copy = family_copy     # Family kept true to Gmail (family_copy.py), or None
        self.family_gmail = family_gmail   # Gmail kept true to Family (family_gmail.py), or None
        self.mail_dates = mail_dates       # dates from his mail onto Gmail (mail_dates.py), or None
        self.meaning = meaning             # the shadow judging of Family events (meaning.py), or None
        self.meaning_live = meaning_live   # his answers, receipts and Undo (meaning_live.py), or None
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
        self.family = family               # Family pushes from Home Assistant, or None
        self.mirror = mirror               # MirrorShadow (computes, never writes), or None
        self.outbox = Outbox(ledger, api, sleep=sleep, tz=base_config.timezone)
        self.config: Config | None = None
        self.runner: Runner | None = None
        self.canary: daily.Canary | None = None
        self.commands: commands.Commands | None = None
        self.callbacks: callbacks.Callbacks | None = None
        self.notes: dict[str, str] = {}           # standing problems for the digest
        # Discord (set by __main__): the keeper, its chat, Cain's handovers.
        self.discord = None
        self.discord_chat = None
        self.handovers = None
        scrub.set_provider("controller", self._secrets)   # twenty-sixth round: its keys, for every sink's scrub
        self._discord_seen: str | None = None    # fingerprint of the token it identified with
        self._reconciled = False
        self._handover_jobs: dict[str, list] = {}
        # The mutual watch on Cain's add-on (watch.py, set by __main__), and the last
        # thing Cain's link said about itself, for the settings page.
        self.cain_watch = None
        self.cain_status: dict | None = None
        # The watch on what the Harness works from (inputs.py, set by __main__): an input that
        # stops is told, a refused key at once, anything else after six hours.
        self.inputs = None

    # -- set-up --------------------------------------------------------------
    def _bind_owner(self, owner: int) -> None:
        if self.config is not None and self.config.owner_user_id == owner:
            return
        self.config = replace(self.base_config, owner_user_id=owner)
        if self.family_add is not None:
            self.family_add.bind(owner)
        if self.calendar_change is not None:
            self.calendar_change.bind(owner)
        if self.mail_dates is not None:
            self.mail_dates.bind(owner)
        if self.meaning_live is not None:
            self.meaning_live.bind(owner)
        self.runner = Runner(self.ledger, self.config, self.engines, self.executor,
                             sleep=self.sleep, monotonic=self.monotonic,
                             budgets_ok=self._budget_ok, family_add=self.family_add,
                             calendar_change=self.calendar_change)
        if self.calendar_change is not None:
            self.calendar_change.fast_check = self._still_his
            self.calendar_change.after_fast = self._newer_since
        if self.mail_dates is not None:
            self.mail_dates.to_family = self._mail_to_family if self.calendar_change is not None else None
            cc = self.calendar_change
            self.mail_dates.family_on = (lambda: cc.on()) if cc is not None else (lambda: False)
        self.canary = daily.Canary(self.ledger, self.config, self.engines, self.executor,
                                   sleep=self.sleep, monotonic=self.monotonic,
                                   budget_ok=self._budget_ok)
        self.commands = commands.Commands(self.ledger, status_fn=self.status_text,
                                          cancel_fn=self.runner.cancel_in_flight,
                                          screen_fn=self._screen_text,
                                          checkadds_fn=(self._check_adds
                                                        if self.family_add else None))
        self.callbacks = callbacks.Callbacks(self.ledger, self.api, owner_user_id=owner,
                                             policy_version=self.config.policy_version,
                                             settings_fn=self._settings_decision,
                                             family_add=self.family_add,
                                             calendar_change=self.calendar_change,
                                             mail_dates=self.mail_dates,
                                             meaning_live=self.meaning_live)
        self.callbacks.migration_fn = self._migration_choice
        self.callbacks.reconfirm_fn = self._reconfirm_tap      # fifteenth round

    def _still_his(self, p) -> tuple[str, str]:
        """At the moment a change goes through with no tap (calendar_change._execute): ("", the
        newest message of his in the DM) when the message it rests on is still his newest and under
        2 minutes old, or (why not, ...). Its age is measured from the time inside its Discord id
        against the Pi's clock, with CLOCK_TOLERANCE_S allowed (0.24.0, fourth round). The newest id
        is recorded with the claim, and the DM is read again right after the write (_newer_since).
        A request that rests on no Discord message of his (his tap on a mail card) has nothing to
        check. A DM that can't be read is no pass."""
        job = self.ledger.job(p["job_id"])
        if job is None:
            return "its request is gone", ""
        root = self.ledger.get_meta(f"job_parent:{job['id']}") or job["id"]
        try:
            origin = json.loads(self.ledger.get_meta(f"job_origin:{job['id']}")
                                or self.ledger.get_meta(f"job_origin:{root}") or "{}")
        except ValueError:
            origin = {}
        if not origin.get("message"):
            return "", ""
        sent = snowflake_time(origin["message"])
        try:
            sent = sent or datetime.fromisoformat(origin["sent_at"])
            age = (self.ledger.now() - sent).total_seconds()
        except (KeyError, ValueError, TypeError):
            age = FRESH_S + 1
        if age < -CLOCK_TOLERANCE_S:
            return "the Pi's clock and Discord's disagree, so I can't tell how old your message is", ""
        if age > FRESH_S - CLOCK_TOLERANCE_S:
            return "your message is over 2 minutes old now", ""
        if not self._discord_mode():
            return "I couldn't read the DM to see that it's still your newest message", ""
        try:
            msgs = self.discord.api.history(self.discord.dm(), 10)
        except DiscordError:
            return "I couldn't read the DM to see that it's still your newest message", ""
        owner = str(self.config.owner_user_id if self.config else self.base_config.owner_user_id)
        mine = [m for m in msgs if str((m.get("author") or {}).get("id")) == owner]
        newest = str(mine[0].get("id")) if mine else str(origin["message"])
        if mine and newest != str(origin["message"]):
            return "you sent another message after it", newest
        return "", newest

    def _newer_since(self, p, seen: str) -> list[str]:
        """Right after a no-tap change is written: his messages that came in after the one recorded
        with its claim, newest first (0.24.0, fourth round). Each is read as a correction of that
        change (_handover). A DM that can't be read gives none, and that is logged."""
        if not self._discord_mode() or not seen:
            return []
        try:
            msgs = self.discord.api.history(self.discord.dm(), 10)
        except DiscordError as e:
            log.warning("after a no-tap change, the DM couldn't be read again (%s)", e.code)
            return []
        owner = str(self.config.owner_user_id if self.config else self.base_config.owner_user_id)
        out = []
        for m in msgs:
            if str((m.get("author") or {}).get("id")) != owner:
                continue
            if str(m.get("id")) == seen:
                break
            out.append(str(m.get("id")))
        return out

    def _mail_to_family(self, title: str, day, start) -> bool:
        """A date from his mail he tapped Add to Family on (mail_dates.py): one add on Family, as a
        calendar change his tap already approved, so its receipt and Undo come as for any other.
        A timed one is an hour long. True once it's handed over, or once it can't ever be."""
        if start is not None:
            first, last = start.isoformat(), (start + timedelta(hours=1)).isoformat()
        else:
            first = last = day.isoformat()
        change = {"calendar": "family", "op": "add", "title": title, "dates": "", "start": first,
                  "end": last, "days": "", "until": "", "location": "", "kind": "", "every": ""}
        d = effects.REGISTRY[effects.CALENDAR_CHANGE]
        try:
            params = d.validate({"changes": [change]})
        except effects.ParamError as e:
            log.warning("mail date for Family couldn't be offered: %s", str(e)[:80])
            return True
        owner = self.config.owner_user_id
        with self.ledger.tx() as db:
            job_id = self.ledger.made_job(owner, f"From his mail, for the Family calendar: {title}, "
                                                 f"{day:%a %b} {day.day}", kind="mail_family", db=db)
        # His tap on the mail card is the go, so it runs with its receipt and Undo; mail never
        # reaches a calendar any other way (runner._offer puts anything else from mail on a card).
        self.runner._offer(self.ledger.job(job_id), d, params, {"source": "mail", "tapped": True}, [], None)
        return True

    def _check_adds(self) -> str:
        words = self.family_add.check_adds()
        if self.calendar_change is not None and self.calendar_change.on():
            words += self.calendar_change.check_changes()
        return words

    def _family_note(self) -> None:
        """A failed write stays in /status and the digest until a write succeeds."""
        problem = self.family_add.problem() if self.family_add is not None else ""
        if problem:
            self.notes["family_add"] = problem
        else:
            self.notes.pop("family_add", None)

    def _budget_ok(self, provider: str) -> bool:
        budget = self.base_config.monthly_budget_usd.get(provider)
        return budget is None or self.ledger.spend_month(provider) < budget

    def startup(self) -> None:
        """Local checks must succeed; remote ones only report. A network
        hiccup at boot is a note in the digest, never a crash."""
        if not self.ledger.integrity_ok():
            self.notes["ledger"] = "the ledger failed its integrity check; restore a backup"
        integrity.check(self.ledger, self.base_config)
        self._family_note()
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

    def _reconcile(self) -> None:
        if self._reconciled:
            return
        self._reconciled = True
        # 0.24.0, fourth round: the ledger's handover sweep, keyed to the ledger's own schema version
        # (migrate.py), before anything else reads what the version before left: cards left open
        # are replaced, changes left in flight are read back and recorded (never written again), and
        # one message lists what was replaced, with Propose again.
        # Tenth round: only once a dry run of this very build is recorded in the ledger (or Cain's logged
        # override), and with a backup taken just before (migrate.run_live).
        swept = migrate.run_live(self.ledger, self.calendar_change, self.config.owner_user_id)
        if swept:
            log.info("ledger migrated: %s", swept)
        # Thirteenth round: after a restore, the requests held in the records it set aside are posted back once.
        try:
            migrate.after_restore(self.ledger, self.config.owner_user_id, self.config.timezone)
        except Exception as e:                 # noqa: BLE001: never stops the start
            log.warning("the held requests of the records set aside couldn't be posted back: %s", type(e).__name__)
        self.runner.reconcile_after_restart()
        if self.family_add is not None:
            self.family_add.reconcile_after_restart()
        if self.calendar_change is not None:
            self.calendar_change.reconcile_after_restart()
            # Fourteenth round: the conformance item's own test event, retried at every start until shown gone.
            try:
                self.status_box["test_events_left"] = self.calendar_change.sweep_test_events() or None
            except Exception as e:             # noqa: BLE001: never stops the start
                log.warning("the conformance test event sweep failed: %s", type(e).__name__)
        self._clarify_timeouts(restart=True)

    # -- the loop --------------------------------------------------------------
    def _beat(self) -> None:
        """Cain's watch asks whether this loop turns (handover /health). Beaten at the
        start of each tick, between its phases and around the long calls."""
        if self.handovers is not None:
            self.handovers.beat()

    def _tend_migration(self) -> None:
        """Twelfth round, each tick: the App's run time summed in the ledger (migrate.heartbeat: backups are
        kept by run time, not the wall clock); and while the ledger waits for its move, its Run check notice is
        posted again if Discord refused it, a reminder goes once a day, and the wait shows on the status page
        and in Cain's /health. Fifteenth round: while a staged restore fences the records the heartbeat and the
        clock check keep running (the run time is summed in memory, since the fence takes no write), and the page
        and /health say fenced beside the loop's own beat, so a stall or a dead loop never looks like a staged
        restore."""
        fenced = bool(self.ledger.fenced)
        try:
            if not fenced:
                migrate.heartbeat(self.ledger)
                if migrate.waiting(self.ledger) and self.config is not None:
                    migrate.tend_waiting(self.ledger, self.config.owner_user_id, self.config.timezone)
                if self.config is not None and not migrate.restore_staged(self.ledger.path):
                    migrate.post_clock_card(self.ledger, self.config.owner_user_id)   # thirteenth round
            else:
                migrate.heartbeat(self.ledger, write=False)
            summary = migrate.migration_summary(self.ledger)   # reads only: the clock check runs fenced too
        except Exception as e:                 # never stops the loop
            log.warning("migration upkeep failed: %s", type(e).__name__)
            return
        if fenced:
            summary = {**summary, "fenced": True, "fenced_beat": iso(self.ledger.now()),
                       "run_time_s": int(migrate.heartbeat(self.ledger, write=False))}
        self.status_box["migration"] = summary or None
        if self.handovers is not None:
            self.handovers.migration = summary

    def tick(self) -> None:
        self._beat()
        self._tend_migration()
        self._drain_requests()
        if self._discord_mode():
            self._discord_tick()
            return
        self._publish()
        self.sleep(2)

    def _work(self) -> None:
        """Everything after his input is recorded."""
        paused = commands.is_paused(self.ledger)
        self.commands.handle_pending()
        self.runner.start_pending(paused=commands.is_paused(self.ledger))
        self.runner.collect()
        self.runner.check_timers()
        self._beat()
        if not commands.is_paused(self.ledger):
            rules.sweep(self.ledger, self.config.owner_user_id, held=not self._proactive_ok())
        if self.family_add is not None:
            self.family_add.run_pending(paused=commands.is_paused(self.ledger),
                                        held=not self._proactive_ok())
            self._family_note()
        if self.calendar_change is not None:
            self.calendar_change.run_pending(paused=commands.is_paused(self.ledger))
            if self.calendar_change.touched and self.calendar is not None:
                self.calendar.read_soon()  # so Gmail and work follow in a minute, not half an hour
            self.calendar_change.touched = False
        self._announce_settings()
        self._beat()
        if self.calendar is not None:
            self.calendar.maybe_start()
            self.calendar.collect()
        self._beat()
        if self.family_copy is not None:
            self.family_copy.run(paused=commands.is_paused(self.ledger))
            self._beat()
        if self.family_gmail is not None:
            self.family_gmail.run(paused=commands.is_paused(self.ledger))
            self._beat()
        if self.mail_dates is not None:
            self.mail_dates.run(paused=commands.is_paused(self.ledger))
            self._beat()
        if self.meaning is not None:
            self.meaning.run(paused=commands.is_paused(self.ledger))   # judges; writes no calendar
            self._beat()
        if self.meaning_live is not None:
            self.meaning_live.tick(paused=commands.is_paused(self.ledger))   # questions, no model
        if self.mirror is not None and self.mirror.due():
            self.mirror.run()              # shadow only; its own failures are its record
            self._beat()
        self._clarify_timeouts()
        self._watch_inputs()
        self._daily(paused)
        self.outbox.flush()
        self._publish()

    def _clarify_timeouts(self, *, restart: bool = False) -> None:
        """A question that went to Cain (runner._on_clarify) and that no note from him has answered
        in 10 minutes goes to the owner after all, as the card it would have been: his message
        quoted, what Cain passed, and the question, which his reply answers. Once a request."""
        now = self.ledger.now()
        for job in self.ledger.jobs_in("needs_clarification"):
            if self.ledger.get_meta(f"clarify_card:{job['id']}"):
                continue
            receipts = self.ledger.receipts(job["id"])
            try:
                detail = json.loads(receipts[-1]["detail"] or "{}") if receipts else {}
            except ValueError:
                continue
            if not isinstance(detail, dict) or not detail.get("said_to_cain"):
                continue
            # 0.24.0, third round: its deadline is stored when the question goes to Cain
            # (runner._on_clarify) and checked every tick and at the first tick after a restart, so
            # a stalled tick can't lose it. A question from before kept none: its deadline is set
            # from when it was asked.
            due_raw = self.ledger.get_meta(f"clarify_due:{job['id']}")
            if due_raw is None:
                try:
                    asked = datetime.fromisoformat(receipts[-1]["created_at"])
                except (KeyError, ValueError, TypeError):
                    asked = datetime.fromisoformat(job["updated_at"])
                due_raw = iso(asked + timedelta(seconds=CLARIFY_WAIT_S))
                self.ledger.set_meta(f"clarify_due:{job['id']}", due_raw)
            try:
                due = datetime.fromisoformat(due_raw)
            except ValueError:
                due = now
            if now < due:
                continue
            late = (now - due).total_seconds()
            text = self.ledger.job_text(job["id"])
            his, _, note = text.partition(NOTE_HEAD)
            root = self.ledger.get_meta(f"job_parent:{job['id']}") or job["id"]
            try:
                origin = json.loads(self.ledger.get_meta(f"job_origin:{root}") or "{}")
            except ValueError:
                origin = {}
            lines = ["<b>A question about your calendar request</b>"]
            lines += provenance.origin_lines(origin or {"quote": his}, now)
            said = note.split(": ", 1)[-1].rstrip("]").strip() if note else ""
            if said:
                lines.append(f"Cain passed on: \u201c{render.escape(provenance.one_line(said))}\u201d")
            question = detail.get("question") or ""
            lines.append(render.escape(question) if question else
                         "I still need one detail to make this change.")
            lines.append("Cain didn't answer this within 10 minutes, so I'm asking you. Nothing has changed.")
            with self.ledger.tx() as db:
                self.ledger.set_meta(f"clarify_card:{job['id']}", iso(now), db)
                self.ledger.enqueue(chat_id=job["chat_id"], kind="answer", job_id=job["id"],
                                    text=render.fit("\n".join(lines)), db=db)
                self.ledger.release_held(db=db)
                self.ledger.event("clarify_to_owner", {"job": job["id"]}, db=db)
            log.info("job %s: Cain didn't answer its question in 10 minutes; asked the owner, %ds after "
                     "its deadline%s", render.short(job["id"]), int(late),
                     " (the first tick after a restart)" if restart else "")

    def _watch_inputs(self) -> None:
        """What the clients saw goes into the ledger, and an input that stopped is told, once an
        outage: a refused key at once, anything else after six hours with no success (inputs.py).
        Not while stopped or before proactive messages start, and never a stopped loop."""
        if self.inputs is None:
            return
        try:
            self.inputs.drain()
            if not commands.is_paused(self.ledger) and self._proactive_ok():
                self.inputs.tell(self.config.owner_user_id)
        except Exception as e:
            # Each tick tries again: said when the kind changes, or once an hour.
            now, last = self.ledger.now(), getattr(self, "_watch_warned", None)
            if last is None or last[0] != type(e).__name__ or now - last[1] >= timedelta(hours=1):
                log.warning("input watch failed: %s", type(e).__name__)
                self._watch_warned = (type(e).__name__, now)

    # -- Discord, through Cain ---------------------------------------------------------
    # The harness has no Discord connection of its own. It hands every card to Cain's
    # link (discord_chat.LinkChat), which holds it until Cain shows it; taps on its cards
    # come back from the link (handover.py /press). It still reads his DM itself (REST,
    # with the bot token) when Cain hands a request over, so it never relies on Cain's
    # account of what he said.
    def _discord_mode(self) -> bool:
        return self.discord is not None and bool(self.vault.get("discord_bot_token"))

    def _discord_tick(self) -> None:
        if not self._discord_ready():
            self._publish()
            self._wait(10)
            return
        if self.handovers is not None and self.handovers.answer is None:
            self.handovers.answer = lambda callback, text: self.api.answer_callback(callback, text)
        if self.ledger.fenced or migrate.restore_staged(self.ledger.path):
            self._fence()
            self._fenced_tick()
            return
        self._replay_taps()
        self._take_handovers()
        self._recheck_taps()
        self._beat()
        self._release_digest()
        self._link_health()
        self._beat()
        self._work()
        self._beat()
        self._finish_handovers()
        self._wait(0.3 if (self._busy() or self._handover_jobs) else 3)

    FENCED = handover.FENCED_TAP
    TAP_REPLAY_S = 14 * 60       # a tap written down this recently is taken at the next start (Discord's 15 minutes)
    BUSY_TAP = ("Your tap is waiting: Harness's records are busy for a moment. It goes through by itself once "
                "they're free; nothing to do.")

    def _fence(self) -> None:
        """Fourteenth round: a staged restore fences the ledger (a mode flag: every write but the outbox's
        delivery marks fails at once with the plain reason; no lock is held), and Cain's handover service answers
        taps at once without queueing them."""
        if not self.ledger.fenced:
            self.ledger.fence(self.FENCED)
        if self.handovers is not None:
            self.handovers.fenced = self.FENCED

    def _take_handovers(self) -> None:
        """Fourteenth round: each handover and tap is taken on its own. One the ledger can't take now (busy past
        the bounded wait) goes back to the front of the queue with everything after it, and a tap's owner is told
        once that it waits: never dropped. One the fence refuses gets the fence's plain reason. Any other failure
        is told, never silent. Fifteenth round: a tap's refusal here is its one terminal outcome, told to him by
        this loop (_refuse_tap, once), whatever the HTTP waiter already answered Cain's link."""
        items = self.handovers.take() if self.handovers is not None else []
        for i, h in enumerate(items):
            if self.ledger.fenced:             # his Put them back tap just staged one: the rest are refused
                self.handovers.give_back(items[i:])
                return
            try:
                {"press": self._press, "digest": self._cain_digest,
                 "morning-posted": self._morning_posted,
                 "meanings": self._meanings, "places": self._places,
                 "fastpath": self._fastpath}.get(h.kind, self._handover)(h)
            except LedgerBusy:
                if h.kind == "press" and h.intent and self._tap_ingested(h.press):
                    # Seventeenth round: acted on in part (its intent written and the tap taken into the records),
                    # so its outcome is unknown: never given back to run again, never called refused.
                    self._unknown_tap(h, "LedgerBusy")
                    continue
                log.warning("the ledger was busy past the bounded wait: %d item(s) stay queued", len(items) - i)
                if h.kind == "press" and not h.told:
                    h.told = self.handovers.tell(h, self.BUSY_TAP) or True
                self.handovers.give_back(items[i:])
                return
            except LedgerFenced as e:
                if h.kind == "press" and h.intent:
                    self._unknown_tap(h, "LedgerFenced")
                elif h.kind == "press":
                    self._refuse_tap(h, scrub.scrub_owner(e) or self.FENCED, restore_staged=True)
                else:
                    h.finish("refused", scrub.scrub_owner(e) or self.FENCED, restore_staged=True)
            except Exception as e:             # noqa: BLE001: told, and the rest still taken
                log.error("a %s couldn't be taken: %s: %s", h.kind, type(e).__name__, e)
                if h.kind == "press" and h.intent:
                    self._unknown_tap(h, type(e).__name__)
                elif h.kind == "press":
                    self._refuse_tap(h, "That tap couldn't be taken (an error in Harness, logged). Nothing changed.",
                                     status="error")
                else:
                    h.finish("error", "That couldn't be taken (an error in Harness, logged). Nothing changed.")
            if h.kind == "press" and migrate.restore_staged(self.ledger.path):
                self._fence()                  # fenced once the tap that staged it has its reply recorded

    TAP_UNKNOWN = ("That tap hit an error in Harness (logged) after it began, so Harness can't say yet whether it "
                   "went through. Harness reads your calendar for it in about a minute and tells you what it finds; "
                   "nothing is done twice.")
    # Eighteenth round: an unknown tap that can't settle yet is read again on this schedule (seconds after the read
    # before), in the running loop. Nineteenth round: exactly these six reads, the first a minute after the tap
    # (journaled as read 1, so no step is used twice); one whose change Harness's records are still carrying out is
    # read again every CHECK_CAP_S after the schedule runs out, and at every start, and is never struck while its
    # job isn't finished. One whose read can't answer gets its card once the schedule is used up, its outcome
    # recorded as unverified.
    CHECK_BACKOFF_S = (60, 120, 300, 900, 1800, 3600)
    CHECK_CAP_S = 3600

    def _unknown_tap(self, h, why: str) -> None:
        """Seventeenth round: an exception after the tap's execution intent was written. Its outcome is unknown, so
        nothing is recorded as its outcome: it isn't refused and isn't struck off, its intent stays in the journal,
        and the calendar is read for its effect by its identity before anything is done with it. He's told once,
        plainly, on the tap. Eighteenth round: that read comes in the running loop, a minute on (_recheck_taps), not
        only at the next start."""
        log.error("a tap was interrupted after its intent was written (%s): its outcome is unknown and it is kept",
                  why)
        h.finish("error", self.TAP_UNKNOWN, outcome="unknown")
        if self.handovers is not None:
            self.handovers.tell(h, self.TAP_UNKNOWN)
            if not self.handovers.journal_check(h.press, 1, self._clock() + self.CHECK_BACKOFF_S[0], False):
                log.error("an unknown tap's next read couldn't be written to the tap journal; it's read at the "
                          "next start")

    def _clock(self) -> float:
        return self.ledger.now().timestamp()

    def _tap_ingested(self, p: dict) -> bool:
        """Whether the records already took this tap (its update row), so it may have been acted on in part."""
        try:
            return self.ledger.db.execute(
                "SELECT 1 FROM updates WHERE bot_id=? AND update_id=? AND kind='callback'",
                (self.ledger.bot_id(), int(p.get("id")))).fetchone() is not None
        except (TypeError, ValueError, sqlite3.Error):
            return True                        # can't tell: counted as taken, so never run twice

    def _refuse_tap(self, h, text: str, *, status: str = "refused", **extra) -> None:
        """Fifteenth round: a queued tap's one terminal refusal. Sixteenth round: durable. Its outcome and note are
        appended (fsynced) to the journal before the note is posted (Inbox.notify), and its delivery after; it's
        struck off only once he's been told. A note that can't be posted now stays in the journal and goes at the
        next start, once; a tap with a terminal outcome is never taken again."""
        h.finish(status, text, **extra)
        if self.handovers is None:
            return
        if not h.journaled:
            self.handovers.tell(h, text)
            return
        if self.handovers.notify(h, text):
            self.handovers.journal_done(h.press)
            return
        row = self.handovers.row_for(h.press)
        if row is not None and row["outcome"]:
            log.warning("a note on a refused tap couldn't be posted now; it goes at the next start")
        else:
            # Neither the outcome nor the note could be kept: struck off, so it can never be taken again.
            log.error("a refused tap's outcome couldn't be written down and its note didn't go")
            self.handovers.journal_done(h.press)

    def _replay_taps(self) -> None:
        """Fourteenth round, once per start: taps written to the journal that the last run never finished (it
        stopped first).

        Sixteenth round, by the journal's own records: a tap with its outcome recorded is never taken again (done:
        struck off; refused: its note posted if it wasn't delivered, then struck off). Across a restore (a swap
        applied at this start, or a restore staged at it) nothing is taken by itself: every tap left is listed for
        him (_relist_taps), by what's recorded, after a read of the calendar for its effect. Otherwise a tap acted on
        (an intent, no outcome) is finished through the records' own checks (they say whether it went, so nothing
        is done twice); a tap never acted on is taken now if it's from the last TAP_REPLAY_S, else struck off and
        he's told nothing changed. A tap's age is unknown while the clock is flagged (then it's reported, not
        taken, and the clock card goes out again if that tap was on it). The queue is read under its own mutex."""
        if self.handovers is None:
            return
        if getattr(self, "_taps_replayed", False):
            # Twenty-fifth round: a start replay a tap's own boundary put off (or that an aborted transaction with
            # no working connection cut short) is taken up again from the main loop once its time comes. Taps it
            # already finished are gone from the journal or marked, so nothing is done twice.
            again = self.__dict__.get("_replay_again_at")
            if again is None or self._clock() < again:
                return
            self.__dict__["_replay_again_at"] = None
        self._taps_replayed = True
        self.__dict__["_in_replay"] = True
        # Twenty-sixth round: each pass gathers the due times of the rows only a start replay handles that it put off
        # (skipped as not due yet, or deferred during the pass), and re-arms itself for the earliest of them, so no
        # such row waits for the next restart. Cleared only when none is left; the failure count starts again after
        # a pass that finished.
        self.__dict__["_replay_put_off"] = []
        try:
            self._replay_body()
        except BaseException:
            n = self.__dict__["_replay_fails"] = self.__dict__.get("_replay_fails", 0) + 1
            self.__dict__["_replay_again_at"] = self._clock() + self._backoff(n)
            raise
        else:
            put_off = self.__dict__["_replay_put_off"]
            self.__dict__["_replay_again_at"] = min(put_off) if put_off else None
            if not put_off:
                self.__dict__["_replay_fails"] = 0
        finally:
            self.__dict__["_in_replay"] = False

    def _replay_body(self) -> None:
        queued = self.handovers.queued_keys()
        boundary = bool(getattr(self, "restored_at_start", False))
        try:
            stalled = bool(migrate.clock_stall(self.ledger))
        except Exception:                       # noqa: BLE001: an unreadable clock check counts as a stall
            stalled = True
        late, relist, unsure, unverified, clock_tap = [], [], [], [], False
        # Twenty-second round: strikes the records hold as pending are finished first (no card: it's queued), and
        # a tap whose next read the records put off waits for it, at a start as in the running loop.
        # Twenty-seventh round: the set-aside and discarded taps are read on their own first; a pass that can't
        # tell which they are does nothing and is taken up again on the back-off, so a set-aside tap's journal
        # lines (an intent a requeue appended before its transaction failed, say) never get a card or a strike.
        # Twenty-eighth round: consecutive failures of that read back off on SETASIDE_BACKOFF_S (1, 5, 15 minutes),
        # and from SETASIDE_ALARM_AT of them on, the App's health and status say the taps wait (said in the log at
        # most once an hour); cleared by the first pass that reads them.
        try:
            held = self._quarantined()
        except Exception as e:                  # noqa: BLE001: can't tell which are set aside: this pass waits
            self._setaside_unread(e)
            return
        self._setaside_read()
        if not self.__dict__.get("_legacy_checked"):
            self.__dict__["_legacy_checked"] = self._legacy_relist_marks()
        try:
            flags, rereads = self._flags(self.STRIKE_FLAG), self._flags(self.REREAD_FLAG)
            relists = self._relist_marks()
        except Exception as e:                  # noqa: BLE001: none read: each tap goes by its journal
            log.warning("the records' tap flags couldn't be read (%s)", type(e).__name__)
            flags, rereads, relists = {}, {}, {}
        if flags:
            self._resume_strikes(flags, skip=queued)
        # Twenty-fourth round: a relisted tap whose strike is pending is only struck, never read or relisted again.
        if relists:
            self._resume_relists(relists, skip=queued)
        now = self._clock()
        journaled = self.handovers.journaled()
        # Twenty-fourth round: deferrals the records refused, kept beside the journal, held again; and an unknown tap
        # whose last deferral was in memory only waits one schedule step after this start.
        if not self.__dict__.get("_side_started"):
            self.__dict__["_side_started"] = True   # twenty-fifth round: once per process, even when resumed
            self._side_start([r for r in journaled if self.handovers.key(r["press"]) not in held], rereads, now)
        mem = self.__dict__.get("_reread_mem", {})
        for row in journaled:
            p = row["press"]
            if self.handovers.key(p) in queued or self.handovers.key(p) in flags \
                    or self.handovers.key(p) in relists or self.handovers.key(p) in held:
                continue
            if row["state"] != "unknown" and not self._due(mem.get(self.handovers.key(p)), now):
                # Twenty-fifth round: put off at its own boundary; resumed later. Twenty-sixth round: at its due time.
                self.__dict__["_replay_put_off"].append(self._due_at(mem.get(self.handovers.key(p)), now))
                continue
            if row["state"] == "unknown" and not self._reread_due(self.handovers.key(p), rereads, now):
                # Read again by the running loop once its time comes. Twenty-seventh round: only a row with a next
                # read in the journal is the running loop's (it reads none without one); for any other the replay
                # re-arms itself for its due time, so it's settled without a restart.
                if row.get("next_check") is None:
                    k = self.handovers.key(p)
                    self.__dict__["_replay_put_off"].append(max(self._due_at(rereads.get(k), now),
                                                                self._due_at(mem.get(k), now)))
                continue
            if row["state"] in ("refused", "found"):
                try:
                    self._post_pending_notice(row)
                except (Exception, TransactionAborted) as e:  # noqa: BLE001: twenty-fifth round: this tap put off
                    self._reraise_dead(e)
                    self._defer_tap(self.handovers.key(p), e, "a tap's note couldn't be queued")
                continue
            if row["state"] in self.TAP_TERMINAL:
                # Twentieth round: terminal. Its approval was used up and its calendar couldn't be read; the last
                # run wrote that outcome but stopped before its card or its strike. It's never aged, taken or
                # relisted: its card says again that the calendar couldn't be read, and it's struck.
                unverified.append(row)
                continue
            if boundary:
                relist.append(row)
                continue
            if row["state"] == "committed":
                self.handovers.journal_done(p)  # done before the stop; only its strike was left
                continue
            if row["state"] == "unknown":
                # Seventeenth round: acted on with no outcome recorded (a stop, or an error after its intent). The
                # records may have taken it in part, so it's never run again through them by itself: the calendar
                # is read for its effect by its identity first, and he gets its card. Eighteenth round: settled by
                # what the records hold of it and that read, the same path the running loop takes
                # (_settle_unknown).
                log.warning("a tap the last run acted on without recording its outcome is read on the calendar "
                            "first")
                unsure.append(row)
                continue
            age = None if stalled else self._tap_age(row)
            if age is not None and age <= self.TAP_REPLAY_S:
                log.warning("a tap the last run didn't finish is taken now")
                self.handovers.give_back([handover.Handover(kind="press", press=p, journaled=True)])
            else:
                late.append(p)
                clock_tap = clock_tap or (stalled and self._choice_kind(p) == "migration_clock")
        if relist and self.config is not None:
            self._relist_guarded(relist)
        if unverified and self.config is not None:
            self._finish_terminal(unverified)
        if unsure and self.config is not None:
            self._settle_unknown(unsure)
        if late and self.config is not None:
            try:
                with self.ledger.tx() as db:
                    self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db, text=(
                        f"Harness stopped before it took {'a tap' if len(late) == 1 else f'{len(late)} taps'} of "
                        "yours, so nothing changed from "
                        f"{'it' if len(late) == 1 else 'them'}."
                        + (" The clock card follows again." if clock_tap
                           else " A card still works until it runs out.")))
                    self.ledger.event("taps_not_taken", {"count": len(late), "clock_stalled": stalled}, db=db)
            except (Exception, TransactionAborted) as e:  # noqa: BLE001: twenty-fifth round: these taps put off
                self._reraise_dead(e)
                for p in late:
                    self._defer_tap(self.handovers.key(p), e, "a note on taps not taken couldn't be queued")
                late = []
            for p in late:
                self.handovers.journal_done(p)
            if clock_tap:
                # Sixteenth round: the clock card's own tap can't be aged while the clock is flagged, so the card
                # is issued again rather than left dead.
                migrate.post_clock_card(self.ledger, self.config.owner_user_id, force=True)

    SETASIDE_BACKOFF_S = (60, 300, 900)         # twenty-eighth round: start replay waits on the set-aside list
    SETASIDE_ALARM_AT = 3                       # twenty-eighth round: failures in a row before health says so
    # Thirty-first round: an open outage closes only after this many good reads in a row (counted beside the journal,
    # never on the clock; a failed read starts the run again), so reads that flap give one card, not one per failure.
    SETASIDE_CLOSE_AFTER = 3
    SETASIDE_CLOSE_EVERY_S = 60                 # the next read while a run of good reads is under way
    SETASIDE_WORDS = ("Harness can't read its list of set-aside taps, so taps of yours from before its last start "
                      "wait until it can. Nothing is done twice.")
    # Twenty-ninth round: the one card he gets when the waiting flag first sets (once-keyed on that outage).
    SETASIDE_CARD_WORDS = ("Some taps of yours are waiting: Harness can't read part of its records just now, so it "
                           "keeps retrying by itself and takes them up once it can. Nothing is done twice, and "
                           "nothing is needed from you.")

    def _setaside_unread(self, e: BaseException) -> None:
        """Twenty-eighth round: the start replay couldn't read the set-aside taps. The pass waits on the back-off
        (SETASIDE_BACKOFF_S, by failures in a row), and from SETASIDE_ALARM_AT failures on the App's health (Cain's
        watch reads /health) and its status say the taps wait; the log says so at most once an hour."""
        n = self.__dict__["_setaside_fails"] = self.__dict__.get("_setaside_fails", 0) + 1
        delay = self.SETASIDE_BACKOFF_S[min(n, len(self.SETASIDE_BACKOFF_S)) - 1]
        now = self._clock()
        self.__dict__["_replay_put_off"].append(now + delay)
        # Thirty-first round: a failed read while an outage is still open starts its run of good reads again.
        side = self._side_load()
        outage = side.get("outage") if isinstance(side.get("outage"), dict) else {}
        if outage.get("open") and outage.get("good"):
            side["outage"] = dict(outage, good=0)
            if not self._side_save(side):
                log.error("the outage of the set-aside list couldn't be kept beside the tap journal")
        if n < self.SETASIDE_ALARM_AT:
            log.warning("the set-aside taps couldn't be read (%s); the start replay waits %d minutes",
                        type(e).__name__, delay // 60)
            return
        self.notes["tap_setaside"] = self.SETASIDE_WORDS
        if self.handovers is not None:
            self.handovers.waiting = "taps waiting: the records' set-aside list can't be read"
        self._setaside_card()
        if now - self.__dict__.get("_setaside_said", float("-inf")) >= 3600:
            self.__dict__["_setaside_said"] = now
            log.error("the set-aside taps still can't be read (%s, %d tries in a row); the start replay waits, and "
                      "Harness's health says so until they can", type(e).__name__, n)

    def _setaside_card(self) -> None:
        """Twenty-ninth round: when the waiting flag sets, one card for him, queued only where the outbox takes it: a
        refused write is logged, and the flag on /health and the status page stay (Cain's link polling those flags
        is a precondition of enabling this beyond the smoke run).

        Thirtieth round: once per outage, not per process. The outage is kept beside the tap journal (the side
        file's "outage": its number, whether it's open, whether its card is queued), since the records are what
        can't be read: a restart in the middle of one finds it open and its card queued, and sends none. Its number
        comes from a counter there, never the clock, so a clock step can't mint a second key; the card is once-keyed
        on it, and tried again at each alarm while the outbox refuses it, so exactly one goes. Closed (its number
        kept) at the first read that works."""
        side = self._side_load()
        outage = side.get("outage") if isinstance(side.get("outage"), dict) else {}
        try:
            n = int(outage.get("n") or 0)
        except (TypeError, ValueError):
            n = 0
        if not outage.get("open"):
            outage = {"n": n + 1, "open": True, "carded": False}
            side["outage"] = outage
            if not self._side_save(side):
                # Thirty-first round: said loudly; the flags on /health and the status page still say the taps wait.
                log.error("the outage of the set-aside list couldn't be recorded beside the tap journal, so no card "
                          "goes for it; /health and the status page still say the taps wait")
                return                          # no card without a kept outage: a restart can't send a second
        elif outage.get("carded"):
            return
        try:
            with self.ledger.tx() as db:
                self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db,
                                    text=render.fit(self.SETASIDE_CARD_WORDS), once=f"setaside_waiting:{outage['n']}")
        except (Exception, TransactionAborted) as e:  # noqa: BLE001: the flags still say it; tried at the next alarm
            self._reraise_dead(e)
            log.warning("the card that taps are waiting couldn't be queued (%s)", type(e).__name__)
            return
        side["outage"] = dict(outage, carded=True)
        if not self._side_save(side):
            log.warning("the waiting card's mark couldn't be kept beside the tap journal; its once-key holds it")

    def _setaside_read(self) -> None:
        """Twenty-eighth round: the set-aside taps read: the failure count starts again and the flag is cleared.
        Thirty-first round: an open outage closes only after SETASIDE_CLOSE_AFTER good reads in a row; until then the
        start replay reads again every SETASIDE_CLOSE_EVERY_S, and a failed read starts the run again."""
        self.__dict__["_setaside_fails"] = 0
        # Thirtieth round: the outage kept beside the journal is closed (its number kept for the next one).
        side = self._side_load()
        outage = side.get("outage") if isinstance(side.get("outage"), dict) else {}
        if outage.get("open"):
            try:
                good = int(outage.get("good") or 0) + 1
            except (TypeError, ValueError):
                good = 1
            if good >= self.SETASIDE_CLOSE_AFTER:
                side["outage"] = {"n": outage.get("n") or 0, "open": False, "carded": False}
            else:
                side["outage"] = dict(outage, good=good)
                self.__dict__.setdefault("_replay_put_off", []).append(self._clock() + self.SETASIDE_CLOSE_EVERY_S)
            if not self._side_save(side):
                log.error("the outage of the set-aside list couldn't be kept beside the tap journal")
        if self.notes.pop("tap_setaside", None) is not None and self.handovers is not None:
            self.handovers.waiting = ""

    def _choice_kind(self, p: dict) -> str:
        cid = str((p or {}).get("custom_id") or "")
        nonce = choices.parse(cid[len(DISCORD_PREFIX):]) if cid.startswith(DISCORD_PREFIX) else None
        return (choices.kind_of(self.ledger, nonce) or "") if nonce else ""

    TAP_STAMP_TOLERANCE_S = 120   # Discord's stamp and the journal's time agree within this, or the journal's wins

    @classmethod
    def _tap_age(cls, row: dict) -> float | None:
        """Seconds since the tap. Sixteenth round: the tap is written down within seconds of Discord's stamp in its
        interaction id, so where both read and they disagree by more than TAP_STAMP_TOLERANCE_S, the journal's own
        time bounds it and is used. Discord's stamp is used where the journal's time doesn't read; the journal's
        where the stamp doesn't read as a real time (after 2020, not ahead of now by more than a day). None when
        neither reads."""
        now = time.time()
        stamp = None
        when = snowflake_time((row.get("press") or {}).get("id"))
        if when is not None:
            t = when.timestamp()
            if datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp() <= t <= now + 86400:
                stamp = t
        try:
            at = float(row.get("at"))
        except (TypeError, ValueError):
            at = None
        if at is not None and (stamp is None or abs(stamp - at) > cls.TAP_STAMP_TOLERANCE_S):
            return now - at
        return None if stamp is None else now - stamp

    def _post_pending_notice(self, row: dict) -> None:
        """A tap with a terminal outcome recorded: never taken again. Its note is posted only if its delivery
        isn't recorded (on the tap while Discord still takes it, else as a message), then it's struck off."""
        p = row["press"]
        if row.get("delivered") or not row.get("note"):
            self.handovers.journal_done(p)
            return
        h = handover.Handover(kind="press", press=p, journaled=True)
        fresh = self._tap_age(row)
        if fresh is not None and fresh <= self.TAP_REPLAY_S and self.handovers.notify(h, row["note"]):
            self.handovers.journal_done(p)
            return
        if self.config is None:
            return
        with self.ledger.tx() as db:
            self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db,
                                text=render.fit("About a tap of yours: " + render.escape(row["note"])))
            self.ledger.event("tap_notice_posted", {}, db=db)
        if not self.handovers.journal_delivered(p):
            log.error("a note's delivery couldn't be written to the tap journal")
        self.handovers.journal_done(p)

    # -- a tap's calendar effect, by a stable identity (sixteenth round) -------------------------------------------

    # Eighteenth round: an allow list. A choice tap has a Go ahead once it may have run only when its kind carries a
    # readable identity in its intent (CHOICE_IDENTITY) or is declared here as changing only Harness's own records.
    # Any other kind, a new one included, is "no_identity": no Go ahead.
    CHOICE_IDENTITY = frozenset({"calendar_change_add_anyway", "calendar_change_undo", "family_add_undo",
                                 "tap_reconfirm"})
    CHOICE_RECORDS = frozenset({"rule_approve", "rule_decline", "rule_undo", "rule_keep_new", "rule_keep_old",
                                "settings_approve", "settings_decline", "migration_check", "migration_override",
                                "migration_restore", "migration_clock", "meaning_answer", "meaning_undo",
                                "place_skip", "calendar_change_fast_keep", "calendar_change_fast_on",
                                "calendar_change_fast_off", "calendar_change_gate_open", "calendar_change_which",
                                "calendar_change_propose_again", "family_add_keep", "family_add_enable",
                                "family_add_loosen", "stopped_drop"})

    def _tap_op(self, p: dict) -> dict:
        """What the tap leads to on a calendar, named by a stable identity read from the records before it's acted
        on: an Approve on a calendar change (its proposal, its changes and the key each add's fixed event id is
        made from, and each Gmail removal's bound event) or on a Family add (its proposal: the event's id comes from
        it). Seventeenth round, the choice kinds that write a calendar: Add anyway (its adds and the keys of their
        fixed ids), Undo and the Family Undo (each event's id, its version as the change left it, and the state it
        must read in afterwards). Eighteenth round: a Go ahead's own tap carries the identity of the tap it takes
        again; a kind declared records-only is {"effect": "records"}; every other kind, known or not, is
        {"effect": "calendar", "kind", "choice": True}, which has no Go ahead once it may have run.
        {"effect": "calendar", "kind"} for an Approve that may reach a calendar but carries no identity to check."""
        cid = str((p or {}).get("custom_id") or "")
        data = cid[len(DISCORD_PREFIX):] if cid.startswith(DISCORD_PREFIX) else ""
        try:
            nonce = choices.parse(data)
            if nonce is not None:
                row = self.ledger.db.execute("SELECT kind, target FROM choices WHERE nonce=?", (nonce,)).fetchone()
                if row is None:
                    return {"effect": "records", "kind": ""}    # no such button: the tap is refused, nothing runs
                kind, target = row["kind"], row["target"]
                if kind in self.CHOICE_RECORDS:
                    return {"effect": "records", "kind": kind}
                op = None
                if kind == "calendar_change_add_anyway" and self.calendar_change is not None:
                    op = self.calendar_change.add_anyway_op(target)
                elif kind == "calendar_change_undo" and self.calendar_change is not None:
                    op = self.calendar_change.undo_op(target)
                elif kind == "family_add_undo" and self.family_add is not None:
                    op = self.family_add.undo_op(target)
                elif kind == "tap_reconfirm":
                    inner = json.loads(target or "{}").get("op")
                    op = inner if isinstance(inner, dict) and inner else {"effect": "records"}
                if op is not None:
                    return op
                if kind in self.CHOICE_IDENTITY:
                    return {"effect": "records", "kind": kind}   # nothing open for it: it changes nothing
                return {"effect": "calendar", "kind": kind, "choice": True}
            parsed = approvals.parse_callback_data(data)
            if parsed is None:
                return {"effect": "records"}
            action, nonce = parsed
            row = self.ledger.db.execute(
                "SELECT p.id, p.effect_type, p.params_json FROM approvals a JOIN proposals p ON p.id=a.proposal_id"
                " WHERE a.nonce=?", (nonce,)).fetchone()
            if row is None or action != "approve":
                return {"effect": "records"}
            if row["effect_type"] == effects.CALENDAR_CHANGE and self.calendar_change is not None:
                params = json.loads(row["params_json"])
                return {"effect": effects.CALENDAR_CHANGE, "proposal": row["id"],
                        "changes": list(params.get("changes") or []),
                        "keys": self.calendar_change.keys_of(row["id"]),
                        "bound": (self.calendar_change.bound_of(row["id"]) or {}).get("bound", [])}
            if row["effect_type"] == effects.FAMILY_ADD:
                return {"effect": effects.FAMILY_ADD, "proposal": row["id"]}
            return {"effect": "calendar", "kind": row["effect_type"]}
        except (ValueError, TypeError, KeyError, AttributeError) as e:
            log.warning("a tap's calendar effect couldn't be read (%s)", type(e).__name__)
            return {"effect": "calendar", "kind": "unread"}

    def _tap_effect(self, op: dict) -> str:
        """A read of the calendar for the tap's effect, by its stable identity: "done" (the calendar shows it),
        "removed" (it landed and has since been taken off: nothing is done again), "absent" (an add not at its
        fixed id: Harness can't tell whether it was made and taken off since, so it isn't made again), "changed"
        (an Undo's event in a version neither the change nor Undo left), "mixed" (some parts settled, others
        not), "not_done" (a read answered and it isn't done), "unread" (a read couldn't tell), "unchecked" (an
        Approve that carries no identity to read by), "no_identity" (a choice tap with no identity to read: no Go
        ahead) or "records" (it changes only Harness's own records)."""
        return self._tap_read(op)[0]

    def _tap_read(self, op: dict) -> tuple[str, list[tuple[str, str]]]:
        """_tap_effect and, for a change of several parts, each part's name and verdict."""
        op = op or {}
        effect = op.get("effect") or "records"
        try:
            if effect == effects.CALENDAR_CHANGE and self.calendar_change is not None:
                got = self.calendar_change.tap_parts(op)
                names = [str((c or {}).get("title") or "that change") for c in op.get("changes") or []]
                return self.calendar_change.combine(got), list(zip(names, got))
            if effect == effects.FAMILY_ADD and self.family_add is not None:
                return self.family_add.tap_effect(op), []
            if effect == "undo":
                if op.get("kind") == "family_add_undo" and self.family_add is not None:
                    got = self.family_add.undo_parts(op)
                elif self.calendar_change is not None:
                    got = self.calendar_change.undo_parts(op)
                else:
                    return "unread", []
                return CalendarChange.combine(got), []
        except Exception as e:                  # noqa: BLE001: a read that fails says nothing about the calendar
            log.warning("a tap's effect couldn't be read on the calendar (%s)", type(e).__name__)
            return "unread", []
        if effect == "records":
            return "records", []
        return ("no_identity" if op.get("choice") else "unchecked"), []

    # -- an unknown tap, settled (eighteenth round) ----------------------------------------------------------------

    def _records_hold(self, p: dict) -> str:
        """What the records in use hold of this tap's decision: "untaken" (no approval or choice was used up by this
        tap: the error came before its decision was recorded, so nothing it leads to ran); "settling" (its
        approval was used up and the change's job is still being carried out: Harness's own executor finishes it,
        and its receipt follows); "ended" (nineteenth round: its approval was used up and the change's job has
        ended, done or not); "settled" (its choice was used up); "hold_unread" (twentieth round: the read itself
        failed; never taken as settled: the tap is kept and read again on the schedule and at every start, and
        struck only once a read answers with a terminal state). Twenty-first round: only a database or I/O error
        is "hold_unread"; a press whose id can't be read is "unidentified", a permanent outcome (one card, no Go
        ahead, then struck), never read again."""
        try:
            uid = int((p or {}).get("id"))
            if uid <= 0:
                raise ValueError("not a tap id")
        except (TypeError, ValueError, AttributeError) as e:
            log.error("a tap's id couldn't be read (%s); it can't be identified in the records", type(e).__name__)
            return "unidentified"
        try:
            a = self.ledger.db.execute(
                "SELECT j.state FROM approvals a JOIN proposals p ON p.id=a.proposal_id JOIN jobs j ON j.id=p.job_id"
                " WHERE a.consumed_update_id=?", (uid,)).fetchone()
            if a is not None:
                return "ended" if a["state"] in TERMINAL else "settling"
            if self.ledger.db.execute("SELECT 1 FROM approvals WHERE consumed_update_id=?", (uid,)).fetchone() \
                    or self.ledger.db.execute("SELECT 1 FROM choices WHERE consumed_update_id=?",
                                              (uid,)).fetchone():
                return "settled"
            return "untaken"
        except (sqlite3.Error, OSError) as e:   # twenty-first round: only the records' own read failing
            log.debug("a tap's hold couldn't be read in the records (%s); it's kept and read again",
                      type(e).__name__)
            return "hold_unread"

    def _settle_unknown(self, rows: list[dict]) -> None:
        """Eighteenth round: the one path that settles taps whose outcome is unknown (an error after the intent,
        or a stop), at a start and in the running loop alike. Each is judged by what the records hold of it
        (_records_hold) and by a read of the calendar by its identity, with the version checks of tap_parts and
        undo_parts:
        - untaken: its decision never reached the records, so nothing ran: unless the calendar already shows it,
          it gets a card with Go ahead, which reads the calendar again and takes it through the usual checks
          (nineteenth round: a read that can't answer says so, and Go ahead then does nothing until one does);
        - settling: the records are carrying it out; it stays unknown and is read again later. Nineteenth round:
          never struck while its job isn't finished: after the schedule it's read every CHECK_CAP_S, and at every
          start, and settled once its job reads finished;
        - ended (nineteenth round): its approval's job has ended. Done or taken off is said; parts the calendar
          reads as not done are a failed or partial outcome, never "the records took it": its card names each part
          not done, offers Go ahead for those safe to do again (CalendarChange.retry_safe) and says for the rest
          why they aren't done again (twentieth round: unreadable, no identity, or possibly sent), never asking him
          to send it again;
        - settled: its choice was used up: done, taken off since, or not shown, said truthfully, with no Go ahead.
        A read that can't answer keeps the tap unknown in the journal (never struck) and reads it again on
        CHECK_BACKOFF_S; he's told once when the next read is, by the time persisted for it. Once the schedule runs
        out it gets its card saying the calendar couldn't be read, its outcome recorded as unverified. A tap is
        struck only once its card is queued."""
        now, owner, final, waits, terminal = self._clock(), self.config.owner_user_id, [], [], []
        for row in rows:
            p, op = row["press"], row.get("op") or {}
            # Twenty-fifth round: a tap whose relist the records refused is tried again with the verdict its last
            # read gave, so the calendar isn't read again for it. Twenty-sixth round: for as long as it's put off
            # (until it settles or is set aside), not for a time.
            hit = self._kept_verdict(self.handovers.key(p))
            if hit is not None and self._verdict_read(hit):  # twenty-seventh round: only a read that answered
                seen_, parts_, *more_ = hit
                final.append((row, seen_, parts_, (more_[0] if more_ else None) or {}))
                continue
            try:
                hold = self._records_hold(p)
            except Exception as e:              # noqa: BLE001: a fault in Harness, not a state of the records
                # Twenty-second round: counted per tap, consecutive (the journal's "error" reads), on its own
                # six-read schedule; after that its outcome is a terminal internal error: one card with no Go
                # ahead saying so (never that the records couldn't be read), and it's struck. Never read hourly.
                errs = int(row.get("error_checks") or 0)
                # Twenty-fifth round: scrubbed of secrets (registered ones, auth headers, URL queries) before it's
                # journaled or kept.
                error = scrub.scrub(f"{type(e).__name__}: {e}")[:500]
                if errs >= len(self.CHECK_BACKOFF_S):
                    log.error("a tap's hold read kept hitting an error in Harness (%s); its outcome is recorded as "
                              "an internal error", type(e).__name__)
                    # Twenty-fourth round: the last exception is journaled with the outcome (and with each error
                    # read), so a copy built later from the journal alone still carries it.
                    if not self.handovers.journal_outcome(p, "internal_error", error=error):
                        log.error("a tap's internal error couldn't be written to the tap journal")
                    # Twenty-third round: the last exception goes with it, for the diagnostic copy in the records.
                    terminal.append(dict(row, state="internal_error", error=error))
                    continue
                if row.get("last_seen") != "hold_error":
                    log.error("a tap's hold read hit an error in Harness (%s); it's read again", type(e).__name__)
                self._wait_check(row, "hold_error", errs, now, waits, "error", error=error)
                continue
            if hold == "unidentified":
                # Twenty-first round: permanent. One card saying it couldn't be identified, no Go ahead, struck.
                if not self.handovers.journal_outcome(p, "unidentified"):
                    log.error("an unidentified tap's outcome couldn't be written to the tap journal")
                terminal.append(dict(row, state="unidentified"))
                continue
            if hold in ("settling", "hold_unread"):
                # Nineteenth round: never struck while its job is still being carried out. Twentieth round: nor
                # while the records can't be read to tell. Twenty-first round: on the hold schedule's own counter.
                self._wait_check(row, hold, int(row.get("hold_checks") or 0), now, waits, "hold")
                continue
            # Twenty-first round: the calendar's own counter, started again (as read 1) when the records read
            # again after hold reads, so the calendar always gets its own six reads.
            n = 1 if row.get("last_kind") == "hold" else int(row.get("checks") or 0)
            seen, parts = self._tap_read(op)
            extra: dict = {}
            if hold == "untaken":
                if seen == "unread":
                    seen = "untaken_unread"     # nineteenth round: said as it is; Go ahead reads first
                elif seen not in ("done", "removed", "records"):
                    seen = "untaken"
            elif seen == "unread" or any(v == "unread" for _, v in parts):
                if n < len(self.CHECK_BACKOFF_S):
                    self._wait_check(row, "unread", n, now, waits, "calendar")
                    continue
                seen = "records_unread"         # nothing read: its outcome is recorded as unverified
            elif hold == "ended" and seen in ("not_done", "mixed", "absent", "unchecked", "no_identity"):
                seen, extra = self._ended_verdict(op, seen, parts)
            elif hold in ("ended", "settled") and seen in ("not_done", "mixed", "unchecked", "no_identity",
                                                           "absent"):
                seen = "records_took" if seen in ("not_done", "mixed", "absent") else "records_noread"
            final.append((row, seen, parts, extra))
        if waits:
            tz = ZoneInfo(self.config.timezone)
            try:
                self._tell_waits(waits, tz, owner)
            except (Exception, TransactionAborted) as e:  # noqa: BLE001: not told now, so not marked: next read
                self._reraise_dead(e)
                log.error("a note that a tap waits couldn't be queued (%s); it goes at its next read",
                          type(e).__name__)
            else:
                # Twentieth round: marked told only once the note is queued (the records' commit), so a note that
                # couldn't be queued is never taken as said.
                for row, seen_, at, n_next, kind in waits:
                    if at is not None and not self.handovers.journal_check(row["press"], n_next, at, True, kind,
                                                                           seen_):
                        log.error("a tap's waiting note was queued but its mark couldn't be written; it may be "
                                  "said once more")
        for row, seen, _, _ in final:
            if seen == "records_unread":
                # Twenty-first round: recorded as unverified, then finished on the one per-tap path (its card and
                # its strike in one transaction), never relisted with the others.
                if not self.handovers.journal_outcome(row["press"], "unverified"):
                    self._defer_reread(row)     # twenty-second round: never read again at every tick
                terminal.append(dict(row, state="unverified"))
        final = [x for x in final if x[1] != "records_unread"]
        if final:
            self._relist_guarded([r for r, _, _, _ in final], restored=False,
                                 verdicts={self.handovers.key(r["press"]): (s, pt, x) for r, s, pt, x in final})
        if terminal:
            self._finish_terminal(terminal)

    def _tell_waits(self, waits: list, tz, owner: int) -> None:
        """The notes that taps wait, queued in one transaction (twentieth round: the caller marks them told only
        once this returns)."""
        with self.ledger.tx() as db:
            for row, seen, at, _n, _kind in waits:
                why = {"settling": "Harness's records are still carrying it out",
                       "hold_unread": "Harness's records couldn't be read just now",
                       "hold_error": "an error in Harness got in the way just now"}.get(
                           seen, "your calendar couldn't be read just now")
                if at is None:
                    next_read = "when Harness next starts"
                else:
                    when = datetime.fromtimestamp(at, timezone.utc).astimezone(tz)
                    next_read = f"at about {render.clock_words(when, suffix=True)}"
                # Twenty-third round: keyed on (tap, "note", "waiting"), so a note whose told mark can't be
                # written (an unwritable journal) is refused as a duplicate at every later read and every start.
                self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(
                    f"{self._tap_head(row)} Harness can't tell yet whether it went through: {why}. It reads "
                    f"your calendar for it again {next_read} and tells you what it finds; nothing is done "
                    "twice."), once=Ledger.once_key(self.handovers.key(row["press"]), "note", "waiting"))
            self.ledger.event("taps_waiting", {"count": len(waits)}, db=db)

    def _wait_check(self, row: dict, seen: str, n: int, now: float, waits: list, kind: str = "calendar",
                    error: str = "") -> None:
        """Nineteenth round: the next read of an unknown tap that can't settle yet, persisted before he's told of
        it: the schedule's step n, or CHECK_CAP_S once it's used up. He's told once, by the persisted time, or that
        it's read at the next start when the time couldn't be written. Twentieth round: the read is persisted here
        with the told mark as it stands; the mark is set only after the note is queued (_settle_unknown).
        Twenty-first round: `kind` names the schedule whose counter `n` is ("hold" or "calendar"), written with what
        the read found, and the log says a waiting state only when it changes, not at every hourly read."""
        delay = self.CHECK_BACKOFF_S[n] if n < len(self.CHECK_BACKOFF_S) else self.CHECK_CAP_S
        at = now + delay
        ok = self.handovers.journal_check(row["press"], n + 1, at, bool(row.get("told_check")), kind, seen,
                                          **({"error": error} if error else {}))
        if not ok:
            log.error("an unknown tap's next read couldn't be written to the tap journal; it's read at the next "
                      "start")
        if seen != row.get("last_seen"):
            log.warning("a tap waits: %s; it's read again in %d minutes, and every hour once its schedule is used up",
                        {"settling": "Harness's records are still carrying it out",
                         "hold_unread": "Harness's records couldn't be read",
                         "hold_error": "an error in Harness on checking it"}.get(
                             seen, "the calendar couldn't be read"),
                        delay // 60)
        if not row.get("told_check"):
            waits.append((row, seen, at if ok else None, n + 1, kind))

    def _ended_verdict(self, op: dict, seen: str, parts: list) -> tuple[str, dict]:
        """Nineteenth round: an approved change whose job ended while the calendar reads some of it not done. The
        parts not done (each by name and what was read), and which of them are safe to do again: "failed_retry"
        when at least one is (its card has Go ahead for those only), else "failed_ask" (no Go ahead).
        Nothing read ("unchecked", "no_identity") is "records_noread"."""
        if seen in ("unchecked", "no_identity"):
            return "records_noread", {}
        got = [v for _, v in parts] if parts else [seen]
        names = [n for n, _ in parts] if parts else [str(((op.get("changes") or [{}])[0] or {}).get("title")
                                                         or "that change")]
        safe: list[int] = []
        if op.get("effect") == effects.CALENDAR_CHANGE and self.calendar_change is not None:
            try:
                safe = self.calendar_change.retry_safe(op, got)
            except Exception as e:              # noqa: BLE001: nothing is offered on a read that fails
                log.warning("a failed change's parts couldn't be sorted for a retry (%s)", type(e).__name__)
                safe = []
        open_ = [i for i, v in enumerate(got) if v not in ("done", "removed", "changed")]
        ask = [i for i in open_ if i not in safe]
        # Twentieth round: each part not offered again, by why: its read failed ("unread"), it carries no identity
        # to read by (a Family removal: "no_identity"), or its write may have been sent, so absence or not-done
        # can't tell what happened ("maybe_sent"). None of them has Go ahead, and none asks him to send it again.
        why = {i: self._why_not_again(got[i]) for i in ask}
        extra = {"retry": safe, "names": names, "got": got, "ask": ask, "why": why}
        return ("failed_retry" if safe else "failed_ask"), extra

    @staticmethod
    def _why_not_again(got: str) -> str:
        """Twenty-first round: why a part read as not done isn't offered again, by what its read found: "unread"
        (its read failed), "no_identity" (nothing to read it by), "checked_not_done" (read definitely as not done,
        but not safe to do again by itself), or "maybe_sent" (reserved for an ambiguous read: absent at its fixed id,
        changed since, or anything else, where its write may have reached the calendar)."""
        if got == "unread":
            return "unread"
        if got in ("unchecked", "no_identity"):
            return "no_identity"
        if got == "not_done":
            return "checked_not_done"
        return "maybe_sent"

    def _recheck_taps(self) -> None:
        """Eighteenth round: in the running loop, the unknown taps whose next read is due are settled through the
        same path as at a start (_settle_unknown). One being taken now (queued) is left to its own run."""
        if self.handovers is None or self.config is None or not getattr(self, "_taps_replayed", False):
            return
        now = self._clock()
        try:
            queued = self.handovers.queued_keys()
            rows = [r for r in self.handovers.journaled() if self.handovers.key(r["press"]) not in queued]
            # Twenty-second round: a tap with a strike pending in the records has its card; it's only struck.
            flags = self._flags(self.STRIKE_FLAG)
            rereads = self._flags(self.REREAD_FLAG)
            # Twenty-fourth round: a relisted tap whose strike is pending has its cards; it's only struck. A tap
            # whose strike flag was set aside isn't taken again.
            relists, held = self._relist_marks(), self._quarantined()
            rows = [r for r in rows if self.handovers.key(r["press"]) not in flags
                    and self.handovers.key(r["press"]) not in relists and self.handovers.key(r["press"]) not in held]
            due = [r for r in rows
                   if r["state"] == "unknown" and r.get("next_check") is not None and r["next_check"] <= now
                   and self._reread_due(self.handovers.key(r["press"]), rereads, now)]
            # Twentieth round: one left recorded as unverified (its card or strike didn't happen) is finished too.
            # Twenty-first round: and one recorded as unidentified; each at most on its strike's back-off.
            unverified = [r for r in rows if r["state"] in self.TAP_TERMINAL]
        except Exception as e:                  # noqa: BLE001: a journal that can't be read now is read next tick
            # Twenty-ninth round: said once, then at most once an hour while it goes on (a long outage of the
            # records doesn't fill the log a line a minute); the next read that works starts it again.
            now_s = self._clock()
            if now_s - self.__dict__.get("_unknown_unread_said", float("-inf")) >= 3600:
                self.__dict__["_unknown_unread_said"] = now_s
                log.warning("the tap journal couldn't be read for unknown taps (%s); tried again each tick, said "
                            "again hourly", type(e).__name__)
            return
        self.__dict__.pop("_unknown_unread_said", None)
        if flags:
            self._resume_strikes(flags, skip=queued)
        if relists:
            self._resume_relists(relists, skip=queued)
        if unverified:
            self._finish_terminal(unverified)
        if due:
            self._settle_unknown(due)

    # Twenty-first round: the terminal states a tap's journal can hold that are finished on one per-tap path.
    # Twenty-second round: and "internal_error" (its hold read kept raising an error in Harness itself).
    TAP_TERMINAL = ("unverified", "unidentified", "internal_error")
    STRIKE_BACKOFF_S = (60, 120, 300, 900, 1800, 3600)
    STRIKE_FLAG = "tap_strike:"                 # twenty-second round: a strike pending, in the records
    REREAD_FLAG = "tap_reread:"                 # twenty-second round: an unverified outcome not journaled
    DIAG_FLAG = "tap_diag:"                     # twenty-third round: a struck internal error, kept for tracing
    RELIST_FLAG = "tap_relist:"                 # twenty-fourth round: a relisted tap, its strike pending or done
    QUARANTINE_FLAG = migrate.TAP_QUARANTINE    # twenty-fourth round: a strike flag set aside, kept for recovery
    REREAD_SIDE = ".reread"                     # twenty-fourth round: deferrals the records refused, by the journal
    RESTART_CARD_AT = 3                         # twenty-fourth round: starts while deferred before the operator card

    def _diagnostic(self, row: dict) -> dict:
        """Twenty-third round: what's kept of a tap struck as an internal error. Never the interaction token.
        Twenty-fourth round: built from the journal's own rows wherever it's queued (the last exception journaled
        with its error reads and its outcome), "unknown" when none was journaled."""
        press = row.get("press") or {}
        return {"state": row.get("state") or "internal_error", "at": self._clock(), "tapped_at": row.get("at"),
                "identity": {k: str(press.get(k, "")) for k in ("id", "custom_id", "message_id", "app")},
                "request": row.get("op") or {}, "error_checks": int(row.get("error_checks") or 0),
                "error": scrub.scrub(row.get("error") or "unknown")[:500]}

    def _secrets(self) -> list[str]:
        """Twenty-sixth round: the secrets the shared scrub replaces for this controller (scrub.add_provider): the
        keys its vault holds and the link's token."""
        out = []
        for f in (*vault.FIELDS, *vault.FAMILY_FIELDS):
            try:
                out.append(str(self.vault.get(f) or ""))
            except Exception:                   # noqa: BLE001: a key that can't be read isn't in the text
                pass
        try:
            out.append(str(self.handovers._token_fn() or "") if self.handovers is not None else "")
        except Exception:                       # noqa: BLE001: likewise
            pass
        return out

    def _backoff(self, fails: int) -> int:
        return self.STRIKE_BACKOFF_S[min(max(fails, 1), len(self.STRIKE_BACKOFF_S)) - 1]

    def _flags(self, prefix: str, unreadable: set | None = None) -> dict:
        """Twenty-second round: the records' per-tap flags under `prefix`, by tap key, each a dict (a value that
        can't be read is {}: due now). Twenty-seventh round: `unreadable`, a set, takes the keys whose value
        couldn't be read (not JSON, or not an object), so a caller that counts on a value (a relist's generation)
        can tell one that can't be read from one that's empty.

        Twenty-eighth round: a relist mark (RELIST_FLAG) is checked against its schema here too: an object whose
        "gen" is an integer from 0 to RELIST_GEN_CAP (_gen_of). One that isn't (missing, null, not an integer, out of
        range) is reported in `unreadable` as well, its object kept as it is (so its pending strike still reads)."""
        out = {}
        for r in self.ledger.db.execute("SELECT key, value FROM meta WHERE substr(key, 1, ?)=?",
                                        (len(prefix), prefix)).fetchall():
            try:
                v = json.loads(r["value"])
            except (TypeError, ValueError):
                v = None
            # Twenty-ninth round: an ended mark is terminal whatever its generation (a null one included), so it
            # reads by its state first and never counts as unreadable for its generation; an epoch (a requeue's
            # fresh count) must read too.
            # Thirtieth round: the state is decided before any other field is parsed: a mark with the ended state is
            # terminal whatever its epoch or generation (malformed, a string, a bool or missing), so it's never
            # unreadable and never falls through to the count beside the journal; its bad fields are only logged.
            if prefix == self.RELIST_FLAG and isinstance(v, dict) and v.get("ended") is True:
                if self._epoch_of(v.get("epoch", 0)) is None or ("gen" in v and v.get("gen") is not None
                                                                 and self._gen_of(v.get("gen")) is None):
                    log.warning("an ended relisted tap's mark has a field that doesn't read; it stays ended")
                out[r["key"][len(prefix):]] = v
                continue
            # Thirtieth round: a struck mark that keeps no count ("nocount") reads as that state, ahead of any count
            # beside the journal: never unreadable, so a side entry that appears later can't give it a count.
            if prefix == self.RELIST_FLAG and self._nocount(v):
                out[r["key"][len(prefix):]] = v
                continue
            bad = not isinstance(v, dict) or (prefix == self.RELIST_FLAG and (
                self._epoch_of(v.get("epoch", 0)) is None or self._gen_of(v.get("gen")) is None))
            if bad and unreadable is not None:
                unreadable.add(r["key"][len(prefix):])
            out[r["key"][len(prefix):]] = v if isinstance(v, dict) else {}
        return out

    @staticmethod
    def _nocount(mark) -> bool:
        """Thirtieth round: a relist mark that keeps no count for good: written with "nocount" (true) by the strike of
        a count that couldn't be read anywhere, or by the one-time repair of an earlier build's nought mark with no
        count beside it. Read ahead of any count beside the journal; only a requeue (a new epoch) clears it. A mark
        whose count is null without that state is damage, and counts on from beside the journal as before."""
        return isinstance(mark, dict) and mark.get("ended") is not True and mark.get("nocount") is True

    @classmethod
    def _gen_of(cls, value) -> int | None:
        """Twenty-eighth round: a relist generation as the records or the file beside the journal hold it, when it
        reads: an integer (never a bool) from 0 to RELIST_GEN_CAP. None for anything else."""
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value if 0 <= value <= cls.RELIST_GEN_CAP else None

    @staticmethod
    def _epoch_of(value) -> int | None:
        """Twenty-ninth round: a relist mark's epoch (how many requeues started its count afresh), when it reads: an
        integer (never a bool) of 0 or more. None for anything else."""
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value if value >= 0 else None

    @staticmethod
    def _relist_label(gen: int, epoch: int) -> str:
        """Twenty-ninth round: a relist's card label, its generation, with the epoch in front once a requeue started
        the count afresh, so a requeued tap's cards never reuse the once-keys of its earlier ones."""
        return str(gen) if not epoch else f"{epoch}.{gen}"

    def _relist_state(self, key: str, marks: dict | None, unreadable: set, side: dict) -> tuple[int | None, int, bool]:
        """Twenty-ninth round: a tap's relist count, its epoch and whether it was ended, from the records' mark
        (`marks`, None when they couldn't be read; `unreadable`, the keys whose mark failed its schema) and the
        side file beside the journal (`side`, its "gens" and "epochs"). The state is decided first: an ended mark is
        terminal whatever its generation. Otherwise the larger (epoch, count) of the mark and the side entry when
        both read; the one that reads otherwise; neither (no mark and no side entry) is 0. A mark that doesn't read
        with no side entry, or a side entry that doesn't read with no mark, gives no count (None).

        Invariant: every path that lowers or resets a count (a requeue, a discard) changes or clears the tap's side
        entry in the same step as its mark (the side file first, then the records, the side entry put back when
        the records refuse), so the larger of the two never brings back a count that was lowered."""
        side_gens = side.get("gens") if isinstance(side.get("gens"), dict) else {}
        side_epochs = side.get("epochs") if isinstance(side.get("epochs"), dict) else {}
        mark = (marks or {}).get(key) if marks is not None and key not in unreadable else None
        if isinstance(mark, dict) and mark.get("ended") is True:
            return self.RELIST_GEN_CAP, self._epoch_of(mark.get("epoch", 0)) or 0, True
        if self._nocount(mark):
            # Thirtieth round: no count for good, whatever the side file holds (only a requeue clears it).
            return None, self._epoch_of(mark.get("epoch", 0)) or 0, False
        lost = side.get("lost") if isinstance(side.get("lost"), list) else []
        had_mark = marks is None or key in unreadable or key in (marks or {})
        if key not in side_gens and (key in lost or (side.get("lost_all") is True and had_mark)):
            # Thirty-first round: an unreadable side file was moved aside, and a count of this tap's may have been
            # in it (its key is legible there or it had journal lines then; or nothing could be told and it has a
            # relist mark): no count (no Go ahead), whatever the mark says, until a requeue writes it one beside the
            # journal again.
            return None, self._epoch_of((mark or {}).get("epoch", 0)) or 0, False
        s_gen = self._gen_of(side_gens.get(key)) if key in side_gens else None
        s_epoch = self._epoch_of(side_epochs.get(key, 0))
        side_ok = s_gen is not None and s_epoch is not None
        side_bad = key in side_gens and not side_ok
        if marks is not None and key not in unreadable:
            if key not in marks:
                return (None, 0, False) if side_bad else ((s_gen, s_epoch, False) if side_ok else (0, 0, False))
            got = (self._epoch_of(mark.get("epoch", 0)) or 0, self._gen_of(mark.get("gen")))
            if side_ok and (s_epoch, s_gen) > got:
                return s_gen, s_epoch, False
            return got[1], got[0], False
        return (s_gen, s_epoch, False) if side_ok else (None, 0, False)

    LEGACY_CHECKED = "relist_marks_checked"     # twenty-ninth round: the one-time check of earlier builds' marks

    def _legacy_relist_marks(self) -> bool:
        """Twenty-ninth round: once, at a start, relist marks written by earlier builds are put into this build's
        schema, so none reads as unreadable or collides with a used once-key: an ended value at the old over-cap
        number (RELIST_GEN_CAP + 1) becomes the ended state (terminal, its generation the cap), and a struck mark
        written as nought (no epoch: the twenty-seventh round's strike of a generation it couldn't read) takes the
        count beside the journal, or, with none there, no count (so its next relist ends with UNKNOWN_COUNT_WORDS,
        never a card refused as a duplicate). A count beside the journal at the old over-cap number becomes the
        cap. Whether it's done (it's tried again at the next start when the records refuse it)."""
        try:
            if self.ledger.get_meta(self.LEGACY_CHECKED):
                return True
            side = self._side_load()
            side_gens = side.get("gens") if isinstance(side.get("gens"), dict) else {}
            fixed: dict = {}
            for r in self.ledger.db.execute("SELECT key, value FROM meta WHERE substr(key, 1, ?)=?",
                                            (len(self.RELIST_FLAG), self.RELIST_FLAG)).fetchall():
                try:
                    v = json.loads(r["value"])
                except (TypeError, ValueError):
                    continue
                if not isinstance(v, dict):
                    continue
                k, gen = r["key"][len(self.RELIST_FLAG):], v.get("gen")
                if isinstance(gen, int) and not isinstance(gen, bool) and gen > self.RELIST_GEN_CAP:
                    fixed[k] = dict(v, gen=self.RELIST_GEN_CAP, ended=True)
                elif gen == 0 and not isinstance(gen, bool) and not v.get("pending") and not v.get("epoch") \
                        and v.get("ended") is not True:
                    g = side_gens.get(k)
                    if isinstance(g, int) and not isinstance(g, bool) and g > self.RELIST_GEN_CAP:
                        # Thirtieth round: a nought mark beside an over-cap count is ended at the cap, as an
                        # over-cap mark is.
                        fixed[k] = dict(v, gen=self.RELIST_GEN_CAP, ended=True)
                    elif self._gen_of(g) is None:
                        fixed[k] = dict(v, gen=None, nocount=True)   # thirtieth round: no count, kept so
                    else:
                        fixed[k] = dict(v, gen=self._gen_of(g))
            over = {k: g for k, g in side_gens.items()
                    if isinstance(g, int) and not isinstance(g, bool) and g > self.RELIST_GEN_CAP}
            if over:
                side["gens"] = dict(side_gens, **{k: self.RELIST_GEN_CAP for k in over})
                if not self._side_save(side):
                    log.debug("an earlier build's relist count beside the journal couldn't be repaired")
            with self.ledger.tx() as db:
                for k, v in fixed.items():
                    self.ledger.set_meta(self.RELIST_FLAG + k, json.dumps(v), db)
                self.ledger.set_meta(self.LEGACY_CHECKED, "1", db)
            if fixed:
                log.warning("%d relisted tap mark(s) from an earlier build were repaired", len(fixed))
            return True
        except Exception as e:                  # noqa: BLE001: tried again at the next start
            log.warning("the earlier builds' relist marks couldn't be checked (%s)", type(e).__name__)
            return False

    def _relist_count(self, key: str, marks: dict | None, unreadable: set, side_gens: dict) -> int | None:
        """Twenty-eighth round: how many times a tap was relisted, or None when it can't be told (twenty-ninth
        round: _relist_state, with the side file's counts only)."""
        return self._relist_state(key, marks, unreadable, {"gens": side_gens})[0]

    @staticmethod
    def _due_at(flag: dict | None, now: float) -> float:
        """Twenty-sixth round: a deferral's due time (now when it can't be read)."""
        try:
            return float((flag or {}).get("due") or now)
        except (TypeError, ValueError):
            return now

    @staticmethod
    def _due(flag: dict | None, now: float) -> bool:
        try:
            return flag is None or now >= float(flag.get("due") or 0)
        except (TypeError, ValueError):
            return True

    # -- deferrals the records refused, kept beside the tap journal (twenty-fourth round) --------------------------

    def _side_path(self) -> str | None:
        journal = getattr(self.handovers, "journal", None) if self.handovers is not None else None
        return (journal + self.REREAD_SIDE) if journal else None

    def _side_load(self) -> dict:
        """The small next-read file beside the journal: {"taps": {key: {"fails", "due"}}, "restarts": n, "logged":
        t}. {} when there's none. Thirty-first round: one that can't be read is moved aside, never written over
        (handover.load_side): what's given then carries "unread", which _side_save refuses, and "lost", the taps whose
        counts it may have held."""
        path = self._side_path()
        if not path:
            return {}
        got = handover.load_side(path, self.handovers.line_keys)
        if not isinstance(got.get("taps"), dict):
            got["taps"] = {}
        return got

    def _side_save(self, data: dict) -> bool:
        """Written whole (a temporary file, fsynced, renamed); removed once it holds no tap. Whether it took.
        Thirty-first round: never over a file that couldn't be read (data loaded from one carries "unread"): that
        write is refused, said loudly, and the file was moved aside instead."""
        path = self._side_path()
        if not path:
            return False
        if data.get("unread"):
            log.error("the file beside the tap journal couldn't be read, so it isn't written over (it was moved "
                      "aside); this change to it is lost")
            return False
        try:
            if not handover.side_keeps(data):
                if os.path.exists(path):
                    os.remove(path)
                self._storage_clear()
                return True
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except OSError:
            return False
        self._storage_clear()
        return True

    SIDE_GENS_KEPT = 256                        # twenty-sixth round: relist counts kept beside the journal, at most

    def _side_gens(self, gens: dict, epochs: dict | None = None) -> None:
        """Twenty-sixth round: each relisted tap's generation, kept beside the journal too (the side file's
        "gens", newest last, at most SIDE_GENS_KEPT), so a relist whose records' marks can't be read still counts
        on from it. Best effort: a count that can't be kept here is taken as at the cap when it's needed."""
        side = self._side_load()
        kept = side.get("gens") if isinstance(side.get("gens"), dict) else {}
        eps = side.get("epochs") if isinstance(side.get("epochs"), dict) else {}
        for k, g in gens.items():
            kept.pop(k, None)
            kept[k] = g
            # Twenty-ninth round: the tap's epoch beside its count (none kept for epoch 0).
            e = (epochs or {}).get(k, 0)
            if e:
                eps[k] = e
            else:
                eps.pop(k, None)
        side["gens"] = dict(list(kept.items())[-self.SIDE_GENS_KEPT:])
        eps = {k: v for k, v in eps.items() if k in side["gens"]}
        if eps:
            side["epochs"] = eps
        else:
            side.pop("epochs", None)
        if not self._side_save(side):
            log.debug("a relist count couldn't be kept beside the journal")

    def _side_forget(self, key: str) -> None:
        """A settled tap's deferral beside the journal goes with it (nothing is written when there's none)."""
        side = self._side_load()
        if key in side.get("taps", {}):
            side["taps"].pop(key, None)
            if not self._side_save(side):
                log.debug("a settled tap's deferral beside the journal couldn't be cleared")

    def _side_start(self, rows: list[dict], rereads: dict, now: float) -> None:
        """At a start (memory is empty): a deferral the records refused, kept beside the journal, is held in memory
        again with its own due time. An unknown tap whose calendar schedule is used up (its next read records it
        as unverified) and that has no deferral anywhere (the last run held it in memory only) isn't read until
        one schedule step after this start, so a crash loop doesn't read the calendar at every start. Starts while
        a tap is deferred are counted in the file; past RESTART_CARD_AT, one operator card per tap (once-keyed)."""
        mem = self.__dict__.setdefault("_reread_mem", {})
        side = self._side_load()
        taps = side.get("taps", {})
        for key, v in list(taps.items()):
            if isinstance(v, dict):
                mem[key] = {"fails": v.get("fails") or 0, "due": v.get("due") or 0}
        unknown = [self.handovers.key(r["press"]) for r in rows if r.get("state") == "unknown"]
        for key in unknown:
            row = next(r for r in rows if self.handovers.key(r["press"]) == key)
            if key in mem or key in rereads or int(row.get("checks") or 0) < len(self.CHECK_BACKOFF_S):
                continue
            mem[key] = {"fails": 0, "due": now + self.STRIKE_BACKOFF_S[0]}
            taps.setdefault(key, {"fails": 0, "due": mem[key]["due"]})
        deferred = [k for k in taps if k in unknown]
        if not deferred:
            return
        side["taps"] = {k: taps[k] for k in deferred}
        side["restarts"] = int(side.get("restarts") or 0) + 1
        if not self._side_save(side):
            log.debug("a deferral couldn't be written beside the journal either; it's held in memory")
            self._storage_alarm()               # twenty-fifth round: the restart count can't persist: said elsewhere
        if side["restarts"] < self.RESTART_CARD_AT or self.config is None:
            return
        try:
            with self.ledger.tx() as db:
                for key in deferred:
                    self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db,
                                        text=render.fit(self.RESTARTS_WORDS),
                                        once=Ledger.once_key(key, "operator", "reread_restarts"))
        except (Exception, TransactionAborted) as e:  # noqa: BLE001: the records can't take it: at the next start
            # Twenty-fifth round: an aborted transaction too (after the savepoint's rollback or reopen), so the rest
            # of the start replay goes on.
            self._reraise_dead(e)
            log.error("Harness restarted several times with a tap's next read unsaved, and the card saying so "
                      "couldn't be queued (%s)", type(e).__name__)

    RESTARTS_WORDS = ("Harness couldn't save where it got to with a tap of yours and has restarted several times "
                      "since, so it reads your calendar for that tap only now and then. The tap is kept, and "
                      "nothing is done twice.")

    def _defer_reread(self, row: dict) -> None:
        """Twenty-second round: an unverified outcome that couldn't be journaled leaves the tap unknown with its
        next read past. So its next read is put off in the records instead, on STRIKE_BACKOFF_S (1, 2, 5, 15, 30
        and 60 minutes), and a start respects it too: the calendars aren't read for it at every tick."""
        key = self.handovers.key(row["press"])
        # Twenty-third round: the deferral is kept in memory too, on the same schedule, so when the records can't
        # take it either (a full or read-only card takes the journal and the records down together) the calendars
        # still aren't read at every tick: the running loop gates on whichever of the two is later.
        mem = self.__dict__.setdefault("_reread_mem", {})
        try:
            old = self._flags(self.REREAD_FLAG + key).get("", {})
            stored = int(old.get("fails") or 0)
        except Exception:                       # noqa: BLE001: unreadable: the count in memory goes on
            stored = 0
        try:
            held = int((mem.get(key) or {}).get("fails") or 0)
        except (TypeError, ValueError):
            held = 0
        fails = max(stored, held) + 1
        delay = self._backoff(fails)
        mem[key] = {"fails": fails, "due": self._clock() + delay}
        try:
            with self.ledger.tx() as db:
                self.ledger.set_meta(self.REREAD_FLAG + key, json.dumps(mem[key]), db)
            log.error("a tap's unverified outcome couldn't be written to the tap journal; it's read again in %d "
                      "minutes", delay // 60)
            self._side_forget(key)
        except Exception as e:                  # noqa: BLE001: the records too: held in memory and beside the journal
            # Twenty-fourth round: kept beside the journal too, so a start respects it, and the log line is said at
            # most once an hour against the time kept there (once per start when that can't be written either).
            self._hold_deferral(key, type(e).__name__, "a tap's next read couldn't be put off in the records either")

    def _hold_deferral(self, key: str, why: str, said: str) -> None:
        """Twenty-fifth round, shared by every deferral the records refused: the tap's next try, already in memory
        (_reread_mem), kept beside the journal (the side file) too, so a start respects it; the log line said at
        most once an hour against the time kept there (and in memory). When the side file can't be written either,
        the App's health and its status say so (_storage_alarm), since nothing written can carry it."""
        mem = self.__dict__.setdefault("_reread_mem", {})
        side = self._side_load()
        side.setdefault("taps", {})[key] = dict(mem.get(key) or {})
        now = self._clock()
        try:
            last = float(side.get("logged") or float("-inf"))
        except (TypeError, ValueError):
            last = float("-inf")
        last = max(last, self.__dict__.get("_reread_logged", float("-inf")))
        say = now - last >= 3600
        if say:
            side["logged"] = now
            self.__dict__["_reread_logged"] = now
        if not self._side_save(side):
            self._storage_alarm()
        if say:
            try:
                delay = max(0, int(float((mem.get(key) or {}).get("due") or now) - now))
            except (TypeError, ValueError):
                delay = 0
            log.error("%s (%s); it's held in memory and read again in %d minutes", said, why, delay // 60)

    STORAGE_WORDS = ("Harness can't save where it got to with a tap of yours, in its records or beside them, so it "
                     "goes back to that tap only now and then until it can. The tap is kept, and nothing is done "
                     "twice.")

    def _storage_alarm(self) -> None:
        """Twenty-fifth round: the side file refused too (the storage that refused the records), so a restart's
        count may never persist and its card never come. Said where no storage is needed: the App's health
        (Cain's watch reads /health), its status page and the digest's standing problems, and the log at most once
        an hour per process. Cleared once the side file takes a write again."""
        self.notes["tap_storage"] = self.STORAGE_WORDS
        if self.handovers is not None:
            self.handovers.storage = "taps unsaved: the records and the file beside the tap journal refused writes"
        now = self._clock()
        if now - self.__dict__.get("_storage_said", float("-inf")) >= 3600:
            self.__dict__["_storage_said"] = now
            log.error("neither the records nor the file beside the tap journal could be written; Harness's health "
                      "says so until one can")

    def _storage_clear(self) -> None:
        if self.notes.pop("tap_storage", None) is not None and self.handovers is not None:
            self.handovers.storage = ""

    def _reread_due(self, key: str, rereads: dict, now: float) -> bool:
        """Twenty-third round: a tap's next read is due only once both its deferral in the records and the one held
        in memory (when the records couldn't take it) have come."""
        return self._due(rereads.get(key), now) and self._due(self.__dict__.get("_reread_mem", {}).get(key), now)

    def _forget_deferral(self, key: str) -> None:
        self.__dict__.get("_reread_mem", {}).pop(key, None)
        self._side_forget(key)

    def _finish_terminal(self, rows: list[dict]) -> None:
        """Twentieth round: taps whose outcome is terminal (an approval used up and the calendar never readable;
        twenty-first round: or a press that can't be identified) but that weren't struck, finished: never aged or
        taken again, their card (no Go ahead) goes, and each is struck.

        Twenty-second round, the records first: the card, its "card queued" mark and a "strike pending" flag are
        committed in one ledger transaction (_queue_terminal), and only then is the tap struck from the journal (a
        rename), as an idempotent cleanup (_strike). A crash between any two steps leaves the flag, and every tick
        and every start strikes what it finds flagged, with no second card (the mark). A strike that can't be
        written is retried on STRIKE_BACKOFF_S, its next try persisted in the flag, so a restart respects it. The
        card is never rolled back: once the outcome is terminal it's true. One tap's failure never holds back the
        others."""
        now = self._clock()
        try:
            flags = self._flags(self.STRIKE_FLAG)
        except Exception as e:                  # noqa: BLE001: no flags read: each is finished as it stands
            log.warning("the records' strike flags couldn't be read (%s)", type(e).__name__)
            flags = {}
        backoff = self.__dict__.setdefault("_queue_retry", {})
        for row in rows:
            key = self.handovers.key(row["press"])
            if key in flags:
                if self._due(flags[key], now):
                    self._strike(key, row["press"], flags[key])
                continue
            fails, due = backoff.get(key, (0, 0.0))
            if now < due:
                continue
            try:
                flag = self._queue_terminal(row)
            except (Exception, TransactionAborted) as e:  # noqa: BLE001: the records refused: tried again later
                # Twenty-fifth round: an aborted transaction too (after the savepoint's rollback or reopen), so
                # one tap's failing cleanup never stops the taps after it.
                self._reraise_dead(e)
                fails += 1
                backoff[key] = (fails, now + self._backoff(fails))
                log.error("a finished tap's card couldn't be queued (%s); it's tried again in %d minutes",
                          type(e).__name__, self._backoff(fails) // 60)
                continue
            backoff.pop(key, None)
            self._strike(key, row["press"], flag)

    TERMINAL_WORDS = {
        # Twenty-second round: its own lead. A press whose id can't be read was never matched to a request.
        "unidentified": ("Harness couldn't tell which request this tap was for; nothing was changed. It couldn't "
                         "identify this tap in its records, so nothing more is done for it from here."),
        # Twenty-second round: an error in Harness itself, said as that, never as records that can't be read.
        # Twenty-third round: its write may have landed, in full or in part, so the card says plainly that Harness
        # couldn't confirm whether the change was made and asks him to look at his calendar (the one thing a card
        # may ask of him here; tests/imperative_cases.json "said").
        "internal_error": ("Harness hit an internal error while working out what came of it, so it couldn't "
                           "confirm whether the change was made. "
                           "Please check your calendar to see whether it's there. "
                           "It isn't taken again from here, and nothing more is done for it."),
    }

    def _queue_terminal(self, row: dict) -> dict:
        """Twenty-second round: one terminal tap's card, its "card queued" mark and its "strike pending" flag, in
        one ledger transaction; the card only if the mark isn't there yet. Returns the flag as it stands.
        Twenty-fourth round: an internal error's kept copy (_diagnostic) is written in that same transaction on
        every path that queues its card, whenever it isn't there yet, so the card and the copy commit together or
        not at all; the flag names the state, so its strike checks the copy is there first."""
        key = self.handovers.key(row["press"])
        mark = f"tap_card_queued:{key}"
        state = row.get("state")
        words = self.TERMINAL_WORDS.get(state) or (
            "Harness stopped or hit an error before it noted what came of it, so it was read on your calendar first "
            "and not taken again by itself. " + self._relist_words("unknown", "records_unread", [], restored=False))
        flag = {"press": dict(row["press"]), "fails": 0, "due": 0.0, "state": str(state or "")}
        with self.ledger.tx() as db:
            if db.execute("SELECT 1 FROM meta WHERE key=?", (mark,)).fetchone() is None:
                self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db,
                                    text=render.fit(f"{self._tap_head(row)} {words}"),
                                    once=Ledger.once_key(key, "outcome", str(state)), outcome="unverified")
                self.ledger.set_meta(mark, "1", db)
                self.ledger.event("tap_finished", {"state": state}, db=db)
            if state == "internal_error" and db.execute("SELECT 1 FROM meta WHERE key=?",
                                                        (self.DIAG_FLAG + key,)).fetchone() is None:
                # Twenty-third round: a durable diagnostic copy of the struck press (its request, its identity
                # without the interaction token, the last exception), so the fault can be traced and the request
                # recovered after the journal line is gone.
                self.ledger.set_meta(self.DIAG_FLAG + key, json.dumps(self._diagnostic(row)), db)
            had = db.execute("SELECT value FROM meta WHERE key=?", (self.STRIKE_FLAG + key,)).fetchone()
            if had is None:
                self.ledger.set_meta(self.STRIKE_FLAG + key, json.dumps(flag), db)
            else:
                try:
                    flag = dict(json.loads(had[0]))
                except (TypeError, ValueError):
                    pass
        return flag

    def _copy_failed(self, key: str, press: dict, flag: dict, e: Exception) -> bool:
        """Twenty-fifth round: a kept copy that couldn't be built or written. Counted in the strike flag (and in
        memory when the records refuse that too) and tried again on STRIKE_BACKOFF_S; after as many failures as
        that schedule has steps, the tap is set aside with its raw journal lines and one operator card, and never
        tried again. Returns False: nothing was struck."""
        now = self._clock()
        mem = self.__dict__.setdefault("_copy_fails", {})
        try:
            stored = int((flag or {}).get("copy_fails") or 0)
        except (TypeError, ValueError):
            stored = 0
        n = max(stored, mem.get(key, 0)) + 1
        mem[key] = n
        if n >= len(self.STRIKE_BACKOFF_S):
            log.error("a finished tap's kept copy couldn't be written after %d tries (%s); it's set aside", n,
                      type(e).__name__)
            try:
                self._quarantine_strike(key, operator=False, why="kept copy failed")
            except (Exception, TransactionAborted) as e2:  # noqa: BLE001: kept flagged; tried again on the back-off
                self._reraise_dead(e2)
                log.error("a tap whose kept copy failed couldn't be set aside (%s)", type(e2).__name__)
            else:
                mem.pop(key, None)
                return False
        fails = int((flag or {}).get("fails") or 0) + 1
        delay = self._backoff(fails)
        try:
            with self.ledger.tx() as db:
                self.ledger.set_meta(self.STRIKE_FLAG + key, json.dumps(
                    dict(flag or {}, press=dict(press), fails=fails, due=now + delay, copy_fails=n)), db)
        except Exception as e2:                 # noqa: BLE001: tried again at the next tick instead
            log.error("a strike's next try couldn't be written to the records (%s)", type(e2).__name__)
        log.error("a finished tap's kept copy couldn't be written (%s); it isn't struck, and it's tried again in %d "
                  "minutes", type(e).__name__, delay // 60)
        return False

    def _copy_kept(self, key: str, press: dict, flag: dict) -> bool:
        """Twenty-fourth round: before an internal error's tap is struck, its kept copy is there: written now from
        the journal's rows when it isn't (a flag from before this round, or one queued without it). Twenty-fifth
        round: it raises when the copy can't be built or written (the caller counts it, _copy_failed, and the tap
        isn't struck); True otherwise, including when there's nothing to copy."""
        state = str((flag or {}).get("state") or "")
        row = None
        if not state:
            row = self.handovers.row_for(press)
            state = str((row or {}).get("state") or "")
        if state != "internal_error":
            return True
        if self.ledger.db.execute("SELECT 1 FROM meta WHERE key=?", (self.DIAG_FLAG + key,)).fetchone() is not None:
            return True
        row = row or self.handovers.row_for(press)
        if row is None:
            return True                         # nothing left in the journal: nothing is struck
        with self.ledger.tx() as db:
            self.ledger.set_meta(self.DIAG_FLAG + key, json.dumps(self._diagnostic(dict(row,
                                                                                        state="internal_error"))), db)
        return True

    def _strike(self, key: str, press: dict, flag: dict) -> bool:
        """Twenty-second round: a flagged tap struck from the journal (striking one already gone does nothing),
        then its flag cleared. A strike that can't be written leaves the flag with its next try on
        STRIKE_BACKOFF_S. Twenty-fourth round: never an internal error's tap whose kept copy isn't committed."""
        now = self._clock()
        try:
            self._copy_kept(key, press, flag)
        except Exception as e:                  # noqa: BLE001: twenty-fifth round: counted; set aside past the cap
            return self._copy_failed(key, press, flag, e)
        try:
            self.handovers.journal_done(press, strict=True)
        except Exception as e:                  # noqa: BLE001: kept flagged; tried again on the back-off
            fails = int((flag or {}).get("fails") or 0) + 1
            delay = self._backoff(fails)
            try:
                with self.ledger.tx() as db:
                    self.ledger.set_meta(self.STRIKE_FLAG + key, json.dumps(
                        dict(flag or {}, press=dict(press), fails=fails, due=now + delay)), db)
            except Exception as e2:             # noqa: BLE001: tried again at the next tick instead
                log.error("a strike's next try couldn't be written to the records (%s)", type(e2).__name__)
            log.error("a finished tap couldn't be struck from the tap journal (%s); its card is queued once, and "
                      "the strike is tried again in %d minutes", type(e).__name__, delay // 60)
            return False
        try:
            with self.ledger.tx() as db:
                db.execute("DELETE FROM meta WHERE key IN (?, ?)", (self.STRIKE_FLAG + key, self.REREAD_FLAG + key))
            self._forget_deferral(key)
        except Exception as e:                  # noqa: BLE001: the next tick finds the flag, strikes nothing, clears it
            log.warning("a strike's flag couldn't be cleared (%s); it's cleared at the next tick", type(e).__name__)
        self.__dict__.get("_strike_mem", {}).pop(key, None)
        return True

    def _resume_strikes(self, flags: dict, skip=()) -> None:
        """Twenty-second round: every strike the records hold as pending and due, at each tick and at a start,
        whether or not its journal row still reads as terminal: no card, only the strike."""
        now = self._clock()
        held = self.__dict__.get("_strike_mem", {})
        try:
            # Twenty-sixth round: a discarded tap is never written for. Twenty-seventh round: nor a set-aside one.
            skip = set(skip) | self._quarantined()
        except Exception as e:                  # noqa: BLE001: can't tell which are set aside: none resumed now
            log.warning("the set-aside taps couldn't be read (%s); pending strikes wait for the next tick",
                        type(e).__name__)
            return
        for key, flag in flags.items():
            if key in skip or not self._due(flag, now) or not self._due(held.get(key), now):
                continue
            press = flag.get("press")
            try:
                if not isinstance(press, dict) or not press:
                    self._unreadable_strike(key, now)
                    continue
                self._strike(key, press, flag)
            except (Exception, TransactionAborted) as e:  # noqa: BLE001: twenty-fifth round: this tap put off
                self._reraise_dead(e)
                self._defer_strike(key, e)

    def _defer_strike(self, key: str, e: BaseException) -> None:
        """Twenty-fifth round: a strike flag whose handling the records refused (an operator card's aborted
        transaction), held back in memory on STRIKE_BACKOFF_S so it's not tried at every tick; the next flag goes on."""
        mem = self.__dict__.setdefault("_strike_mem", {})
        fails = int((mem.get(key) or {}).get("fails") or 0) + 1
        mem[key] = {"fails": fails, "due": self._clock() + self._backoff(fails)}
        log.error("a pending strike couldn't be handled (%s); it's tried again in %d minutes", type(e).__name__,
                  self._backoff(fails) // 60)

    # -- a relisted tap's strike, pending in the records (twenty-fourth round) -------------------------------------

    def _relist_marks(self) -> dict:
        """The relisted taps whose strike is still pending, by tap key: the records' marks, each held back by the
        later of its own next try and the one in memory (when the records couldn't take it)."""
        mem = self.__dict__.get("_relist_mem", {})
        # Twenty-eighth round: read with the schema check, and a pending mark whose generation doesn't read takes
        # the count beside the journal (None when there's none), so the strike settles it with that count, never
        # with a count of nought.
        unreadable: set = set()
        flags = self._flags(self.RELIST_FLAG, unreadable)
        out = {k: v for k, v in flags.items() if v.get("pending")}
        if unreadable & set(out):
            side = self._side_load()
            for k in unreadable & set(out):
                log.warning("a relisted tap's mark couldn't be read; its count beside the journal is used")
                gen, epoch, _ = self._relist_state(k, None, unreadable, side)
                out[k] = dict(out[k], gen=gen, **({"epoch": epoch} if epoch else {}))
        for k, v in mem.items():
            if v.get("pending"):
                out[k] = dict(out.get(k) or v, due=max(float((out.get(k) or {}).get("due") or 0),
                                                       float(v.get("due") or 0)))
        return out

    def _resume_relists(self, marks: dict, skip=()) -> None:
        """Each relisted tap whose strike is pending and due is struck, and only that: its cards are queued, so it's
        never read on the calendar or relisted again. Twenty-sixth round: never a discarded tap's."""
        now = self._clock()
        try:
            skip = set(skip) | self._quarantined()  # twenty-seventh round: set-aside taps too, as discarded ones
        except Exception as e:                  # noqa: BLE001: can't tell which are set aside: none resumed now
            log.warning("the set-aside taps couldn't be read (%s); pending strikes wait for the next tick",
                        type(e).__name__)
            return
        for key, mark in marks.items():
            if key in skip or not self._due(mark, now):
                continue
            press = mark.get("press")
            if not isinstance(press, dict) or not press:
                tap_id, _, custom = key.partition("|")
                press = {"id": tap_id, "custom_id": custom}
            self._strike_relisted(key, press, mark)

    def _strike_relisted(self, key: str, press: dict, mark: dict) -> bool:
        """A relisted tap struck from the journal (strictly: a failed rewrite raises). On a failure its next try goes
        on STRIKE_BACKOFF_S, in the records and in memory; once struck, its mark keeps only its generation."""
        now = self._clock()
        mem = self.__dict__.setdefault("_relist_mem", {})
        try:
            self.handovers.journal_done(press, strict=True)
        except Exception as e:                  # noqa: BLE001: kept pending; tried again on the back-off
            try:
                held = int((mem.get(key) or {}).get("fails") or 0)
            except (TypeError, ValueError):
                held = 0
            try:
                own = int(mark.get("fails") or 0)
            except (TypeError, ValueError):
                own = 0
            fails = max(own, held) + 1
            delay = self._backoff(fails)
            mem[key] = dict(mark, press=dict(press), pending=True, fails=fails, due=now + delay)
            try:
                with self.ledger.tx() as db:
                    self.ledger.set_meta(self.RELIST_FLAG + key, json.dumps(mem[key]), db)
            except Exception as e2:             # noqa: BLE001: held in memory on the same schedule
                log.error("a relisted tap's next strike couldn't be written to the records (%s)", type(e2).__name__)
            log.error("a relisted tap couldn't be struck from the tap journal (%s); its cards are queued once, and "
                      "the strike is tried again in %d minutes", type(e).__name__, delay // 60)
            return False
        mem.pop(key, None)
        try:
            with self.ledger.tx() as db:
                # Twenty-eighth round: the generation kept as it reads (None when it doesn't), never nought.
                # Twenty-ninth round: an ended mark stays ended once struck (its state read first, whatever its
                # generation), and a requeue's epoch is kept with the count.
                struck = {"gen": self._gen_of(mark.get("gen")), "pending": False}
                if self._epoch_of(mark.get("epoch", 0)):
                    struck["epoch"] = mark["epoch"]
                if mark.get("ended") is True:
                    struck["ended"] = True
                elif struck["gen"] is None:
                    struck["nocount"] = True    # thirtieth round: no count for good, ahead of any side entry
                self.ledger.set_meta(self.RELIST_FLAG + key, json.dumps(struck), db)
                db.execute("DELETE FROM meta WHERE key=?", (self.REREAD_FLAG + key,))
        except Exception as e:                  # noqa: BLE001: the next tick strikes nothing and settles it
            log.warning("a relisted tap's mark couldn't be settled (%s); it's settled at the next tick",
                        type(e).__name__)
        self._forget_deferral(key)
        return True

    # -- a strike flag that can't be read --------------------------------------------------------------------------

    # Twenty-fifth round: one text for every set-aside tap, naming the tool that exports, discards or requeues it.
    UNREADABLE_STRIKE_WORDS = ("Harness found a cleanup step in its records for a tap of yours that it couldn't "
                               "use, so it left the tap as it is and set it aside. It isn't taken again from here; "
                               "its record is kept for the set-aside taps tool on Harness's command line.")

    def _quarantined(self) -> set[str]:
        """Twenty-fourth round: the taps whose strike flag was set aside: never taken again, never written for.
        Twenty-fifth round: and the set-aside taps discarded with the set-aside tool (migrate.TAP_DISCARDED), whose
        journal lines stay: never read on the calendar or taken again."""
        out = set()
        for prefix in (self.QUARANTINE_FLAG, migrate.TAP_DISCARDED):
            out |= {r[0][len(prefix):] for r in self.ledger.db.execute(
                "SELECT key FROM meta WHERE substr(key, 1, ?)=?", (len(prefix), prefix))}
        return out

    def _discarded(self) -> set[str]:
        """Twenty-sixth round: the taps discarded with the set-aside tool (migrate.TAP_DISCARDED). Read before any
        strike is resumed, so a discarded tap's journal lines are never rewritten; a read that fails raises, and the
        resume waits for the next tick."""
        return {r[0][len(migrate.TAP_DISCARDED):] for r in self.ledger.db.execute(
            "SELECT key FROM meta WHERE substr(key, 1, ?)=?", (len(migrate.TAP_DISCARDED), migrate.TAP_DISCARDED))}

    def _quarantine_strike(self, key: str, *, operator: bool, why: str = "") -> None:
        """Twenty-fourth round: an unreadable strike flag set aside, in one transaction with its operator card when
        there's no card about the tap: the flag's text moved whole under QUARANTINE_FLAG (kept for recovery: the
        set-aside tooling lists, exports, discards or requeues it), so later ticks and starts skip it with no write.
        Twenty-fifth round: every set-aside tap gets that operator card (a press that doesn't match its journal
        lines, keyed on the tap and "quarantine", as a kept copy that can't be written), and the record keeps the
        tap's own journal lines, without the interaction token and with errors scrubbed."""
        raw = self.ledger.db.execute("SELECT value FROM meta WHERE key=?", (self.STRIKE_FLAG + key,)).fetchone()
        try:
            lines = [self._kept_line(r) for r in self.handovers.lines_for(key)]
        except Exception:                       # noqa: BLE001: the record without them; the journal keeps them
            lines = None
        with self.ledger.tx() as db:
            self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db,
                                text=render.fit(self.UNREADABLE_STRIKE_WORDS),
                                once=Ledger.once_key(key, "operator",
                                                     "unreadable_strike" if operator else "quarantine"))
            record = {"flag": raw[0] if raw is not None else None, "at": self._clock(),
                      "why": why or ("no card" if operator else "journal mismatch")}
            if lines is not None:
                record["rows"] = lines
            self.ledger.set_meta(self.QUARANTINE_FLAG + key, json.dumps(record), db)
            db.execute("DELETE FROM meta WHERE key=?", (self.STRIKE_FLAG + key,))
        self._drop_verdict(key)                 # twenty-sixth round: a set-aside tap's kept verdict goes with it

    def _kept_line(self, r: dict) -> dict:
        """Twenty-fifth round: a journal line as a kept copy holds it: no interaction token, errors scrubbed."""
        r = dict(r)
        if isinstance(r.get("press"), dict):
            r["press"] = {k: v for k, v in r["press"].items() if k != "token"}
        if r.get("error"):
            r["error"] = scrub.scrub(r["error"])
        return r

    def _journal_match(self, key: str, press: dict) -> bool | None:
        """Twenty-fourth round: the press rebuilt from a tap key (split on its first bar) checked against the tap
        journal's own lines for that key: True when its press lines carry that very id and custom id, None when
        the journal has no line for it (nothing to strike), False otherwise (lines with no press, or a press that
        differs: the key can't be trusted)."""
        rows = [r for r in self.handovers.journaled() if self.handovers.key(r["press"]) == key]
        if any(str(r["press"].get("id", "")) != press["id"] or str(r["press"].get("custom_id", "")) != press["custom_id"]
               for r in rows):
            return False
        if rows:
            return True
        return False if self.handovers.has_lines(key) else None

    def _unreadable_strike(self, key: str, now: float) -> None:
        """Twenty-third round: a strike-pending flag whose JSON can't be parsed or holds no press. If the tap's card
        is there (its "card queued" mark, or an outcome card under its once-key), the tap is struck by its id (the
        tap key is its id and custom id) and the flag is rewritten whole with the default back-off, so it's struck
        or settled, never skipped forever. If neither is there, one operator card says so (once-keyed). The log
        line says it at most once an hour per tap.

        Twenty-fourth round: the no-card branch sets the flag aside in the operator card's own transaction
        (_quarantine_strike), so it settles: later ticks find no flag and write nothing. The rebuilt press is checked
        against the journal's lines for that tap first (_journal_match); on a mismatch it's set aside, not struck."""
        seen = self.__dict__.setdefault("_unreadable_logged", {})
        if now - seen.get(key, float("-inf")) >= 3600:
            seen[key] = now
            log.error("a pending strike's tap couldn't be read from the records")
        tap_id, _, custom = key.partition("|")
        press = {"id": tap_id, "custom_id": custom}
        try:
            carded = (self.ledger.db.execute("SELECT 1 FROM meta WHERE key=?",
                                             (f"tap_card_queued:{key}",)).fetchone() is not None
                      or self.ledger.db.execute(
                          "SELECT 1 FROM meta WHERE substr(key, 1, ?)=?",
                          (len("outbox_once:" + Ledger.once_key(key, "outcome", "")),
                           "outbox_once:" + Ledger.once_key(key, "outcome", ""))).fetchone() is not None)
            if not carded:
                self._quarantine_strike(key, operator=True)
                return
            if self._journal_match(key, press) is False:
                log.error("a pending strike's tap didn't match its lines in the tap journal; it's set aside, not "
                          "struck")
                self._quarantine_strike(key, operator=False)
                return
            flag = {"press": press, "fails": 0, "due": 0.0}
            with self.ledger.tx() as db:
                self.ledger.set_meta(self.STRIKE_FLAG + key, json.dumps(flag), db)
        except Exception as e:                  # noqa: BLE001: the records can't take it now: the next tick
            log.debug("an unreadable strike flag couldn't be handled now (%s)", type(e).__name__)
            return
        self._strike(key, press, flag)

    def _tap_head(self, row: dict) -> str:
        try:
            t = datetime.fromtimestamp(float(row.get("at")), timezone.utc).astimezone(ZoneInfo(self.config.timezone))
            return f"A tap of yours from {render.escape(f'{t:%a %-I:%M %p}')}."
        except (TypeError, ValueError, OverflowError, OSError):
            return "A tap of yours (time unknown)."

    RELIST_MAX = 10
    TAP_STATE_WORDS = {"committed": "carried out before the records were put back",
                       "unknown": "Harness can't tell whether it was carried out",
                       "not_started": "not carried out",
                       "found": "already on your calendar",
                       # Twenty-first round: every state a journal row can hold has words here, so no list raises.
                       "unverified": "Harness couldn't read your calendar to tell how far it got",
                       "unidentified": "Harness couldn't tell which request it was for",
                       "internal_error": "Harness hit an internal error on it",
                       "refused": "not taken"}
    # Eighteenth round: what an Undo already read as done leaves, in his words.
    UNDO_FOUND = {"gone": "already undone on your calendar: the event is gone",
                  "restored": "already undone on your calendar: the event is back",
                  "reverted": "already undone on your calendar: the event is back as it was"}
    NO_GO_AHEAD = ("no_identity", "removed", "absent", "changed", "records_took", "records_unread", "settling",
                   "records_noread", "failed_ask")

    def _found_words(self, op: dict) -> str:
        if (op or {}).get("effect") == "undo":
            return self.UNDO_FOUND[CalendarChange.undo_expected(op)]
        return self.TAP_STATE_WORDS["found"]

    def _relist_taps(self, rows: list[dict], *, restored: bool = True,
                     verdicts: dict | None = None, reads: dict | None = None,
                     summary_into: list | None = None) -> None:
        """Fifteenth round: the records were put back from a backup at this start, so no tap written down before it
        is taken by itself. Sixteenth round, truthfully: each tap's recorded state (carried out before the records
        were put back; outcome unknown; not carried out) and, for one that reaches a calendar, a read of the
        calendar by the effect's own identity first: one the calendar already shows is marked done and gets no
        button. The rest are sorted by tap time; the newest RELIST_MAX get a card, and every older one is listed
        in a second message by its time and state (counts by state in the first), so none is out of reach.
        Seventeenth round: the first message points at the cards below it (a card has Go ahead only where it's
        safe); a tap whose time can't be read sorts as newest and always gets a card, marked "time unknown".
        restored=False: the taps a stop or an error left with their outcome unknown, at a start that put nothing
        back. Eighteenth round: those come here only through _settle_unknown, with their verdicts read there; an
        Undo already done is said by what it leaves (gone, back, as it was); and no card names a button.

        Twenty-fifth round: `reads` gathers each calendar read made here, so a relist the records refused is tried
        again without reading the calendar again (_relist_guarded). A tap relisted RELIST_GEN_CAP times already
        isn't relisted again: it gets one card saying nothing more is done for it, and it's struck.

        Twenty-sixth round: `summary_into`, a list, takes the batch summary's part for these taps instead of its own
        card (the per-tap fallback of _relist_guarded, which queues one summary for all the taps it settled)."""
        owner, tz = self.config.owner_user_id, ZoneInfo(self.config.timezone)
        # Twenty-fourth round: each tap's relist generation (one more than its last relist's), stored with its
        # relisted mark. Twenty-fifth round: read first, so a tap past the cap is never read on the calendar.
        # Twenty-sixth round: when the records' marks can't be read, the count kept beside the journal (the side
        # file's "gens") is used; a tap whose count can't be read there either is taken as at the cap, so it ends
        # with its one card instead of being counted from one again.
        # Twenty-seventh round: a mark whose value can't be read (not JSON) counts as unreadable too, not as empty,
        # so a corrupt mark goes to the count beside the journal as well; and a tap whose count can't be read
        # anywhere ends with its own card (UNKNOWN_COUNT_WORDS), which doesn't say it was brought back before.
        # Twenty-eighth round: each mark checked against its schema (_flags, _gen_of), and the count is the larger
        # of the mark and the count beside the journal whenever both read (_relist_count): a mark with a missing,
        # null, non-integer or out-of-range generation goes to the count beside the journal, and with neither the
        # tap ends with UNKNOWN_COUNT_WORDS.
        unreadable: set = set()
        try:
            old_marks = self._flags(self.RELIST_FLAG, unreadable)
        except Exception as e:                  # noqa: BLE001: the count beside the journal, else stopped
            log.warning("the relisted taps' marks couldn't be read (%s); their count beside the journal is used",
                        type(e).__name__)
            old_marks = None
        # Twenty-ninth round: the state first (_relist_state): an ended mark is terminal whatever its generation,
        # so a tap declared ended is struck again with no card and never counted on; a requeued tap counts afresh
        # in its own epoch, its cards keyed on that epoch too.
        side = self._side_load()
        gens, unknown, epochs, ended = {}, set(), {}, set()
        for row in rows:
            k = self.handovers.key(row["press"])
            if k in unreadable:
                log.warning("a relisted tap's mark couldn't be read; its count beside the journal is used")
            was, epochs[k], done = self._relist_state(k, old_marks, unreadable, side)
            if done:
                ended.add(k)
                gens[k] = self.RELIST_GEN_CAP + 1
                continue
            if was is None:
                unknown.add(k)                  # no count anywhere: stopped, never counted from one again
                gens[k] = self.RELIST_GEN_CAP + 1
                continue
            gens[k] = was + 1
        capped = [r for r in rows if gens[self.handovers.key(r["press"])] > self.RELIST_GEN_CAP]
        if capped:
            self._relist_ended(capped, gens, unknown=unknown, already=ended,
                               marks={k: (old_marks or {}).get(k) for k in ended}, epochs=epochs)
            rows = [r for r in rows if gens[self.handovers.key(r["press"])] <= self.RELIST_GEN_CAP]
            if not rows:
                return

        def stamp(row):
            try:
                t = float(row.get("at"))
                return t if t == t else float("inf")
            except (TypeError, ValueError):
                return float("inf")             # no readable time: newest, so it always gets a card

        def when(row):
            try:
                t = datetime.fromtimestamp(float(row.get("at")), timezone.utc).astimezone(tz)
                return f"{t:%a %-I:%M %p}"
            except (TypeError, ValueError, OverflowError, OSError):
                return ""
        checked = []
        extras: dict = {}
        for row in sorted(rows, key=stamp, reverse=True):
            seen, parts = "unchecked", []
            if verdicts is not None and self.handovers.key(row["press"]) in verdicts:
                seen, parts, *more = verdicts[self.handovers.key(row["press"])]
                extras[self.handovers.key(row["press"])] = (more[0] if more else None) or {}
            elif row["state"] in ("committed", "unknown"):
                seen, parts = self._tap_read(row.get("op") or {})
                if reads is not None:
                    reads[self.handovers.key(row["press"])] = (seen, parts, {})
            if seen == "done":
                # Twenty-seventh round: journaled as found only once the records take its relist (below), so a
                # relist the records refuse leaves the tap unknown in the journal, read again on its schedule.
                row = dict(row, state="found")
            checked.append((row, seen, parts))
        found = [r for r, _, _ in checked if r["state"] == "found"]
        open_ = [(r, seen, parts) for r, seen, parts in checked if r["state"] != "found"]
        untimed = [x for x in open_ if not when(x[0])]
        timed = [x for x in open_ if when(x[0])]
        shown = untimed + timed[:max(0, self.RELIST_MAX - len(untimed))]
        rest = timed[max(0, self.RELIST_MAX - len(untimed)):]
        counts = {k: sum(1 for r, _, _ in open_ if r["state"] == k) for k in ("committed", "unknown", "not_started")}
        n = len(rows)
        found_words: dict[str, int] = {}
        for r in found:
            w = self._found_words(r.get("op") or {})
            found_words[w] = found_words.get(w, 0) + 1
        parts = self._relist_summary_parts(n, counts, found_words, len(shown), len(rest), restored)
        # Twenty-fourth round: each tap's card is keyed on (tap, "relist", generation), and the summary and the list
        # on the batch's taps and generations, so a relist done again is refused as a duplicate and mints nothing.
        labels = {k: self._relist_label(gens[k], epochs.get(k, 0))
                  for k in (self.handovers.key(r["press"]) for r in rows)}
        batch = hashlib.sha256("\n".join(sorted(f"{k}#{g}" for k, g in labels.items())).encode()).hexdigest()[:24]
        marks = {k: {"press": dict(row["press"]), "gen": gens[k], "pending": True, "fails": 0, "due": 0.0,
                     **({"epoch": epochs[k]} if epochs.get(k) else {})}
                 for row in rows for k in [self.handovers.key(row["press"])]}
        with self.ledger.tx() as db:
            if summary_into is None:
                self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(" ".join(parts)),
                                    once=Ledger.once_key(f"batch:{batch}", "relist", "summary"))
            for row, seen, tparts in shown:
                p = row["press"]
                once = Ledger.once_key(self.handovers.key(p), "relist", labels[self.handovers.key(p)])
                if db.execute("SELECT 1 FROM meta WHERE key=?", (f"outbox_once:{once}",)).fetchone() is not None:
                    continue                    # this very relist's card is queued: nothing minted again
                extra = extras.get(self.handovers.key(p)) or {}
                text = self._relist_words(row["state"], seen, tparts, restored=restored, extra=extra)
                stamp_words = when(row)
                head = (f"A tap of yours from {render.escape(stamp_words)}." if stamp_words
                        else "A tap of yours (time unknown).")
                outcome = self._card_outcome(row["state"], seen)
                if row["state"] != "not_started" and seen in self.NO_GO_AHEAD:
                    self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(f"{head} {text}"),
                                        outcome=outcome, once=once)
                    continue
                nonce = choices.mint(self.ledger, kind="tap_reconfirm", chat_id=owner, ttl_s=self.TAP_RELIST_TTL_S,
                                     target=json.dumps({"id": p.get("id", ""), "custom_id": p.get("custom_id", ""),
                                                        "message_id": p.get("message_id", ""),
                                                        "op": row.get("op") or {},
                                                        "untaken": seen in ("untaken", "untaken_unread"),
                                                        # twenty-fourth round: the card its retries are counted on
                                                        "card": f"relist{labels[self.handovers.key(p)]}",
                                                        **({"retry": list(extra.get("retry") or [])}
                                                           if seen == "failed_retry" else {})}), db=db)
                self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(f"{head} {text}"),
                                    buttons=[[("Go ahead", choices.callback_data(nonce))]],
                                    binds=[{"type": "choice", "nonce": nonce}], outcome=outcome, once=once)
            if rest:
                lines = [f"• {render.escape(when(r))}: "
                         f"{self.TAP_STATE_WORDS.get(r['state'], self.TAP_STATE_WORDS['unknown'])}"
                         for r, _, _ in reversed(rest)]
                self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(
                    ("<b>Older taps from before the records were put back</b>, not taken by themselves:\n"
                     if restored else "<b>Older taps</b>, not taken again by themselves:\n")
                    + "\n".join(lines)), once=Ledger.once_key(f"batch:{batch}", "relist", "list"))
            self.ledger.event("taps_relisted", {"count": n, "shown": len(shown), "listed": len(rest),
                                                "found": len(found), "restored": restored, **counts}, db=db)
            # Twenty-third round: a settled tap's deferred re-read goes with its cards, in the same transaction.
            # Twenty-fourth round: and its relisted mark (its strike pending), so a later tick or start resumes the
            # strike from the mark and never reads the calendar or relists it again.
            for row in rows:
                k = self.handovers.key(row["press"])
                db.execute("DELETE FROM meta WHERE key=?", (self.REREAD_FLAG + k,))
                self.ledger.set_meta(self.RELIST_FLAG + k, json.dumps(marks[k]), db)
        for row in found:
            if not self.handovers.journal_outcome(row["press"], "found"):
                log.error("a tap's outcome couldn't be written to the tap journal")
        if summary_into is not None:
            summary_into.append({"gens": dict(labels), "counts": counts,
                                 "found": found_words, "shown": len(shown), "rest": len(rest)})
        self._side_gens({k: m["gen"] for k, m in marks.items()}, {k: epochs.get(k, 0) for k in marks})
        mem = self.__dict__.setdefault("_relist_mem", {})
        for row in rows:
            k = self.handovers.key(row["press"])
            mem[k] = dict(marks[k])
            self.__dict__.get("_reread_mem", {}).pop(k, None)
            self._drop_verdict(k)
            self._strike_relisted(k, row["press"], marks[k])

    def _relist_summary_parts(self, n: int, counts: dict, found_words: dict, shown: int, rest: int,
                              restored: bool) -> list[str]:
        """The batch summary's sentences for n relisted taps (twenty-sixth round: shared by a batch and by the
        per-tap fallback's one summary)."""
        if restored:
            parts = [f"<b>Harness's records were put back from a backup</b>, so "
                     f"{'a tap of yours from before it was' if n == 1 else f'{n} taps of yours from before it were'} "
                     "not taken by itself."]
        else:
            parts = [f"<b>Harness stopped or hit an error before it noted what came of "
                     f"{'a tap of yours' if n == 1 else f'{n} taps of yours'}</b>, so "
                     f"{'it was' if n == 1 else 'they were'} read on your calendar first and not taken again by "
                     f"{'itself' if n == 1 else 'themselves'}."]
        said = [f"{c} {self.TAP_STATE_WORDS[k]}" for k, c in counts.items() if c]
        for w, c in found_words.items():
            said.append(f"{c} {w}, so nothing is left to do for {'it' if c == 1 else 'them'}")
        if said:
            parts.append("Of " + ("it" if n == 1 else "them") + ": " + "; ".join(said) + ".")
        if shown:
            parts.append(("The newest one is on the card below" if shown == 1
                          else f"The newest {shown} are on the cards below")
                         + ", each saying what Harness found."
                         + (f" The other {rest} are listed after them by time and state." if rest else ""))
        return parts

    def _relist_summary(self, entries: list[dict], restored: bool) -> None:
        """Twenty-sixth round: one summary card for the taps the per-tap fallback settled, keyed as a batch's is (on
        those taps and their generations), queued after their own cards. One the records refuse is logged: each of
        those taps already has its own card."""
        gens: dict = {}
        counts: dict = {}
        found: dict = {}
        shown = rest = 0
        for e in entries:
            gens.update(e["gens"])
            for k, c in e["counts"].items():
                counts[k] = counts.get(k, 0) + c
            for w, c in e["found"].items():
                found[w] = found.get(w, 0) + c
            shown, rest = shown + e["shown"], rest + e["rest"]
        if not gens:
            return
        parts = self._relist_summary_parts(len(gens), counts, found, shown, rest, restored)
        if shown:                               # each tap here went alone, so each has its own card
            parts[-1] = ("It is on its own card" if shown == 1 else "Each is on its own card") \
                + ", saying what Harness found."
        batch = hashlib.sha256("\n".join(sorted(f"{k}#{g}" for k, g in gens.items())).encode()).hexdigest()[:24]
        try:
            with self.ledger.tx() as db:
                self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db,
                                    text=render.fit(" ".join(parts)),
                                    once=Ledger.once_key(f"batch:{batch}", "relist", "summary"))
        except (Exception, TransactionAborted) as e:  # noqa: BLE001: each tap has its own card already
            self._reraise_dead(e)
            log.error("a relist's summary couldn't be queued (%s); each tap has its own card", type(e).__name__)

    RELIST_GEN_CAP = 6                          # twenty-fifth round: relists of one tap before its ended card
    RELIST_ENDED_WORDS = ("Harness has brought this tap back to you several times without finishing it, so nothing "
                          "more is done for it from here.")
    # Twenty-seventh round: the end for a tap whose relist count can't be read anywhere (it may never have been
    # brought back): no Go ahead, since Harness can't tell how often it was offered.
    UNKNOWN_COUNT_WORDS = ("Harness couldn't safely try this tap again, so it was stopped and nothing more is done "
                           "for it from here.")

    def _relist_ended(self, rows: list[dict], gens: dict, unknown=(), already=(), marks: dict | None = None,
                      epochs: dict | None = None) -> None:
        """Twenty-fifth round: taps past RELIST_GEN_CAP generations. Each gets one card (once-keyed on the tap,
        "relist", "ended") with no Go ahead, in one transaction with its relisted mark (its strike pending), then
        it's struck: never read on the calendar or relisted again. Twenty-seventh round: a tap in `unknown` (no
        readable count anywhere) gets UNKNOWN_COUNT_WORDS instead, with no Go ahead either."""
        owner = self.config.owner_user_id
        # Twenty-eighth round: an ended mark holds the cap as its generation (a count that reads), or none when the
        # tap's count couldn't be read anywhere, so a later read of it ends it the same way again.
        # Twenty-ninth round: a tap in `already` was declared ended before (its mark in `marks`): it keeps that
        # mark's generation and gets no second card, only its strike.
        old = marks or {}

        def gen_for(k):
            if k in already:
                return self._gen_of((old.get(k) or {}).get("gen"))
            return None if k in unknown else self.RELIST_GEN_CAP
        marks = {self.handovers.key(r["press"]): {"press": dict(r["press"]), "gen": gen_for(self.handovers.key(
            r["press"])), "pending": True, "fails": 0, "due": 0.0, "ended": True,
            **({"epoch": (epochs or {})[self.handovers.key(r["press"])]}
               if (epochs or {}).get(self.handovers.key(r["press"])) else {})} for r in rows}
        with self.ledger.tx() as db:
            for row in rows:
                k = self.handovers.key(row["press"])
                if k not in already:
                    words = self.UNKNOWN_COUNT_WORDS if k in unknown else self.RELIST_ENDED_WORDS
                    self.ledger.enqueue(chat_id=owner, kind="notice", db=db, outcome="unverified",
                                        text=render.fit(f"{self._tap_head(row)} {words}"),
                                        once=Ledger.once_key(k, "relist", f"{marks[k]['epoch']}.ended"
                                                             if marks[k].get("epoch") else "ended"))
                db.execute("DELETE FROM meta WHERE key=?", (self.REREAD_FLAG + k,))
                self.ledger.set_meta(self.RELIST_FLAG + k, json.dumps(marks[k]), db)
            self.ledger.event("taps_relist_ended", {"count": len(rows)}, db=db)
        self._side_gens({k: m["gen"] for k, m in marks.items()}, {k: m.get("epoch", 0) for k, m in marks.items()})
        mem = self.__dict__.setdefault("_relist_mem", {})
        for row in rows:
            k = self.handovers.key(row["press"])
            mem[k] = dict(marks[k])
            self.__dict__.get("_reread_mem", {}).pop(k, None)
            self._drop_verdict(k)
            self._strike_relisted(k, row["press"], marks[k])

    def _relist_guarded(self, rows: list[dict], *, restored: bool = True, verdicts: dict | None = None) -> None:
        """Twenty-fifth round: each tap's relist is its own boundary. The batch goes as one (its summary, cards and
        marks in one transaction); if the records refuse it (an error, or TransactionAborted after the savepoint's
        rollback or reopen), each tap is tried alone, with the calendar reads already made, and a tap the records
        still refuse is put off on STRIKE_BACKOFF_S in memory and beside the journal (_defer_tap), its verdict kept
        in memory so its next try doesn't read the calendar again; the other taps go on. Only a TransactionAborted
        whose reopen failed (no working connection) still ends the tick."""
        if not rows:
            return
        verdicts = dict(verdicts) if verdicts is not None else None
        for row in rows:
            k = self.handovers.key(row["press"])
            hit = self._kept_verdict(k)
            if hit is not None and self._verdict_read(hit) and (verdicts is None or k not in verdicts):
                verdicts = {} if verdicts is None else verdicts
                verdicts[k] = hit
        reads: dict = {}
        try:
            self._relist_taps(rows, restored=restored, verdicts=verdicts, reads=reads)
        except (Exception, TransactionAborted) as e:  # noqa: BLE001: each tap alone below
            self._reraise_dead(e)
            log.warning("a relist couldn't be written to the records (%s); each tap is tried alone",
                        type(e).__name__)
            first = e
        else:
            for row in rows:
                self._drop_verdict(self.handovers.key(row["press"]))
            return
        known = dict(verdicts or {})
        known.update(reads)
        alone = len(rows) == 1
        settled: list[dict] = []                # twenty-sixth round: one summary for the taps settled below
        for row in rows:
            k = self.handovers.key(row["press"])
            try:
                if alone:
                    raise first
                self._relist_taps([row], restored=restored, verdicts=known if k in known else verdicts,
                                  summary_into=settled)
            except (Exception, TransactionAborted) as e:  # noqa: BLE001: this tap put off; the next goes on
                self._reraise_dead(e)
                if k in known:
                    self._keep_verdict(k, known[k])
                self._defer_tap(k, e, "a tap's relist couldn't be written to the records")
            else:
                self._drop_verdict(k)
        if settled:
            self._relist_summary(settled, restored)

    RELIST_VERDICTS_KEPT = 256                  # twenty-sixth round: kept relist verdicts, at most (oldest go first)

    def _kept_verdict(self, key: str):
        """Twenty-sixth round: the calendar verdict kept for a tap whose relist the records refused, or None. It's
        kept until the tap settles or is set aside (or discarded), never expired by the clock, so a tap put off on
        the hourly step doesn't read the calendar again; bounded by count (RELIST_VERDICTS_KEPT)."""
        hit = self.__dict__.get("_relist_verdicts", {}).get(key)
        return hit[1] if hit else None

    # Twenty-seventh round: verdicts that say the calendar couldn't be read. Never kept: the tap's next try goes
    # through the unread handling and the unknown re-read schedule again, so a read that failed in an outage isn't
    # carried past the calendar's recovery.
    UNREAD_VERDICTS = frozenset({"unread", "untaken_unread", "records_unread"})

    @classmethod
    def _verdict_read(cls, verdict) -> bool:
        """Twenty-seventh round: whether a verdict came from a read that answered (only those are kept)."""
        try:
            seen, parts = verdict[0], verdict[1]
            return seen not in cls.UNREAD_VERDICTS and not any(v == "unread" for _, v in (parts or []))
        except (TypeError, ValueError, IndexError):
            return False

    def _keep_verdict(self, key: str, verdict) -> None:
        if not self._verdict_read(verdict):
            self._drop_verdict(key)
            return
        cache = self.__dict__.setdefault("_relist_verdicts", {})
        cache.pop(key, None)
        cache[key] = (self._clock(), verdict)
        while len(cache) > self.RELIST_VERDICTS_KEPT:
            cache.pop(next(iter(cache)))

    def _drop_verdict(self, key: str) -> None:
        self.__dict__.get("_relist_verdicts", {}).pop(key, None)

    @staticmethod
    def _reraise_dead(e: BaseException) -> None:
        """Twenty-fifth round: the one error a per-tap boundary doesn't hold: the records left with no working
        connection (a TransactionAborted whose reopen failed), or anything that isn't an ordinary error."""
        if isinstance(e, TransactionAborted):
            if getattr(e, "reopen_failed", False):
                raise e
            return
        if not isinstance(e, Exception):
            raise e

    def _defer_tap(self, key: str, e: BaseException, said: str) -> None:
        """Twenty-fifth round: one tap the records refused at its own boundary, put off on STRIKE_BACKOFF_S (1, 2,
        5, 15, 30, 60 minutes) in memory (the running loop and a start replay gate on it) and beside the journal,
        logged at the deferrals' hourly rate. During a start replay, the replay is taken up again from the main
        loop once that tap is due."""
        mem = self.__dict__.setdefault("_reread_mem", {})
        try:
            fails = int((mem.get(key) or {}).get("fails") or 0) + 1
        except (TypeError, ValueError):
            fails = 1
        due = self._clock() + self._backoff(fails)
        mem[key] = {"fails": fails, "due": due}
        self._hold_deferral(key, type(e).__name__, said)
        if self.__dict__.get("_in_replay"):
            self.__dict__.setdefault("_replay_put_off", []).append(due)

    @staticmethod
    def _card_outcome(state: str, seen: str) -> str | None:
        """Twenty-first round: a relisted tap's outcome for the fixed template (Ledger.OUTCOMES), or None when it
        isn't one of them plainly."""
        if state == "found" or seen == "done":
            return "done"
        if state == "not_started" or seen in ("untaken", "untaken_unread", "not_done"):
            return "not_done"
        if seen in ("records_unread", "unread", "records_noread", "unchecked", "no_identity"):
            return "unverified"
        return None

    # Nineteenth round: what each part of a change whose job ended reads as, in his words.
    PART_WORDS = {"done": "on your calendar", "removed": "on your calendar before, since taken off",
                  "absent": "not on your calendar", "changed": "changed on your calendar since",
                  "not_done": "not done on your calendar", "unread": "couldn't be read just now",
                  "unchecked": "can't be read on your calendar"}

    # Twenty-second round: a part with no reason recorded and no read (tests/imperative_cases.json "said").
    CANT_TELL_PART = "For {names}, Harness can't tell how far {how} got; nothing more is done for {what} from here."

    @classmethod
    def _failed_words(cls, seen: str, extra: dict) -> str:
        """Nineteenth round: a change whose job ended with parts not done: each part not done by name, which of them
        the button below does again (read by its own identity first), and which he'd need to ask for again."""
        names, got = list(extra.get("names") or []), list(extra.get("got") or [])
        retry, ask = set(extra.get("retry") or []), list(extra.get("ask") or [])

        def name(i):
            return render.escape(names[i]) if i < len(names) else "that change"
        not_done = [f"{name(i)}: {cls.PART_WORDS.get(got[i], got[i])}" for i in range(len(got))
                    if got[i] not in ("done",)]
        out = ["Harness's records took it, but it didn't all go through: "
               + ("; ".join(not_done) if not_done else "part of it isn't done") + "."]
        if retry:
            out.append("The button below does " + ", ".join(name(i) for i in sorted(retry))
                       + " again on a new card for your approval, reading your calendar for "
                       + ("it" if len(retry) == 1 else "each") + " first so nothing is made twice.")
        why = {int(k): v for k, v in (extra.get("why") or {}).items()}
        groups = {"maybe_sent": [], "no_identity": [], "unread": [], "checked_not_done": [], "unknown": []}
        for i in ask:
            # Twenty-first round: a part with no reason recorded is sorted by its own read, never by default as
            # "may have been sent".
            # Twenty-second round: with no reason recorded and no read either, it's "can't tell", never "may have
            # been sent".
            w = why.get(i) or (cls._why_not_again(got[i]) if i < len(got) and got[i] else "unknown")
            groups.get(w, groups["unknown"]).append(i)

        def they(idx, one, many):
            return one if len(idx) == 1 else many
        if groups["maybe_sent"]:
            g = groups["maybe_sent"]
            out.append("For " + ", ".join(name(i) for i in g) + ", its write may have reached your calendar, so "
                       "Harness can't tell whether " + they(g, "it was", "they were") + " made and changed or taken "
                       "off since; " + they(g, "it isn't", "they aren't") + " done again from here.")
        if groups["no_identity"]:
            g = groups["no_identity"]
            out.append("For " + ", ".join(name(i) for i in g) + ", that kind of change leaves nothing Harness can "
                       "read on your calendar to tell whether it went through, so " + they(g, "it isn't", "they aren't")
                       + " done again from here.")
        if groups["unread"]:
            g = groups["unread"]
            out.append("For " + ", ".join(name(i) for i in g) + ", your calendar couldn't be read just now, so "
                       "Harness can't tell how far " + they(g, "it", "they") + " got; nothing more is done for "
                       + they(g, "it", "them") + " from here.")
        if groups["unknown"]:
            g = groups["unknown"]
            out.append(cls.CANT_TELL_PART.format(names=", ".join(name(i) for i in g), how=they(g, "it", "they"),
                                                 what=they(g, "it", "them")))
        if groups["checked_not_done"]:
            g = groups["checked_not_done"]
            out.append("For " + ", ".join(name(i) for i in g) + ", checked: not done; " + they(g, "it", "they")
                       + " can't be offered again automatically, so ask for " + they(g, "it", "them")
                       + " again if you still want " + they(g, "it.", "them."))
        return " ".join(out)

    @classmethod
    def _relist_words(cls, state: str, seen: str, parts: list | None = None, *, restored: bool = True,
                      extra: dict | None = None) -> str:
        """A relisted tap's card, by what was found. Eighteenth round: it never names a button; where it has one,
        it says what the button below does. Nineteenth round: a change whose job ended with parts not done says
        which (_failed_words); a read that failed says the calendar couldn't be read, never that it doesn't show
        it."""
        if state == "not_started":
            return "It wasn't carried out. The button below does it now."
        if seen == "untaken":
            return ("Harness's records show it wasn't carried out: the error came before it was taken. The button "
                    "below does it now, after reading your calendar for it first.")
        if seen == "untaken_unread":
            return ("Harness's records show it wasn't carried out: the error came before it was taken. Your calendar "
                    "couldn't be read just now, so the button below reads it first and does it only if it isn't "
                    "there; if your calendar still can't be read, nothing is done.")
        if seen in ("failed_retry", "failed_ask"):
            return cls._failed_words(seen, extra or {})
        if restored:
            first = ("It was carried out on the records before they were put back" if state == "committed"
                     else "Harness can't tell whether it was carried out before the records were put back")
        else:
            first = "Harness can't tell whether it was carried out"
        if seen == "removed":
            return (f"{first}. It was on your calendar and has since been taken off, so it isn't done again from "
                    "here.")
        if seen == "absent":
            return (f"{first}. Your calendar doesn't have it now, and Harness can't tell whether it was added and "
                    "taken off since, so it isn't added again from here.")
        if seen == "changed":
            return (f"{first}. That event changed on your calendar since, so Harness can't tell and leaves it as it "
                    "is.")
        if seen == "records_took":
            return ("Harness's records took it before the error, so it isn't taken again from here, and your "
                    "calendar doesn't show all of it done now.")
        if seen == "records_unread":
            return ("Harness's records took it before the error, so it isn't taken again from here. Harness couldn't "
                    "read your calendar to tell how far it got, so what came of it isn't known.")
        if seen == "records_noread":
            return ("Harness's records took it before the error, so it isn't taken again from here. This kind of "
                    "change leaves nothing Harness can read on your calendar, so it couldn't check how far it got.")
        if seen == "settling":
            return ("Harness's records took it and are still carrying it out; what comes of it reaches you on its "
                    "own receipt.")
        if seen == "no_identity":
            return (f"{first}, and this kind of tap leaves nothing Harness can read on your calendar to tell, so it "
                    "isn't offered again here.")
        if seen == "mixed":
            words = {"done": "on your calendar", "removed": "on your calendar before, since taken off",
                     "absent": "not on your calendar, and Harness can't tell whether it was added and taken off",
                     "changed": "changed on your calendar since",
                     "not_done": "not done on your calendar", "unread": "couldn't be read just now",
                     "unchecked": "can't be read on your calendar"}
            each = "; ".join(f"{render.escape(name)}: {words.get(v, v)}" for name, v in (parts or []))
            return (f"{first}. Part of it is settled on your calendar ({each}). The button below does only the "
                    "parts that aren't, reading each again first.")
        if seen == "not_done":
            return f"{first}, and your calendar doesn't show it now. The button below does it now."
        if seen == "unread":
            return (f"{first}, and your calendar couldn't be read just now. The button below reads it again and "
                    "does it only if it isn't there.")
        if seen == "unchecked":
            return (f"{first}, and this kind of tap leaves nothing Harness can read on your calendar. The button "
                    "below does it now, through the usual checks.")
        return f"{first}; the records in use now don't have it. The button below does it now."

    TAP_RELIST_TTL_S = 24 * 3600

    def _reconfirm_tap(self, target: str) -> str:
        """His Go ahead on a relisted tap (fifteenth round): the tap he made before the restore, taken now on the
        records in use, through the same checks as any tap (that card, once, before it expires). Sixteenth round:
        never blindly. A tap that reaches a calendar is read there first by its effect's identity: one the calendar
        shows is done, nothing written; otherwise it goes through the normal checks, and the write itself reads
        its fixed event id or its version before it writes, so nothing is made twice. Seventeenth round: one since
        taken off the calendar, or a choice tap with no identity to read, is never run again here; a change part of
        which is there runs only the parts that aren't (CalendarChange.skip_found). Eighteenth round: nor one
        absent where Harness can't tell whether it was made and taken off, nor an Undo whose event changed since,
        except a tap the records show never ran ("untaken"), which only the calendar showing it already stops."""
        try:
            t = json.loads(target or "{}")
            cid = str(t.get("custom_id") or "")
            mid = int(t.get("message_id") or 0)
            op = t.get("op") if isinstance(t.get("op"), dict) else {}
            untaken = bool(t.get("untaken"))
            retry = [int(i) for i in t.get("retry") or []] if "retry" in t else None
        except (ValueError, TypeError, AttributeError):
            return "That can't be read, so nothing changed."
        if not cid.startswith(DISCORD_PREFIX):
            return "That can't be read, so nothing changed."
        seen, parts = self._tap_read(op)
        if seen == "unread" or any(v == "unread" for _, v in parts):
            # Nineteenth round: the card said it reads first; a read that still can't answer does nothing.
            # Twentieth round: never asks him to send it again (the failure isn't his): the same Go ahead comes
            # back on a new card, which reads his calendar again when he uses it.
            # Twenty-third round: the retry card is keyed on (tap, "retry", attempt), the attempt counted in its
            # target: a retransmission of the same attempt is refused (and mints nothing), a new attempt goes.
            # Twenty-fourth round: and on the card the attempts are counted on (its relist's generation), so a tap
            # relisted again starts its own count; an attempt that can't be read is its own value, never 1; and
            # after RETRY_CAP attempts on one card its outcome is recorded instead, once, with no Go ahead.
            tap, card, attempt = f"{t.get('id', '')}|{cid}", str(t.get("card") or "relist0"), self._attempt(t)
            cap = len(self.CHECK_BACKOFF_S)
            if attempt is not None and attempt + 1 > cap:
                with self.ledger.tx() as db:
                    self.ledger.event("tap_reconfirm_ended", {}, db=db)
                    self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db,
                                        text=render.fit(self.RETRY_ENDED_WORDS), outcome="unverified",
                                        once=Ledger.once_key(tap, "retry", f"{card}:ended"))
                return ("Your calendar still couldn't be read, so nothing was done, and nothing more is done for "
                        "that tap from here.")
            nxt, purpose = (cap, "unreadable") if attempt is None else (attempt + 1, str(attempt + 1))
            once = Ledger.once_key(tap, "retry", f"{card}:{purpose}")
            with self.ledger.tx() as db:
                self.ledger.event("tap_reconfirm_unread", {}, db=db)
                if db.execute("SELECT 1 FROM meta WHERE key=?", (f"outbox_once:{once}",)).fetchone() is None:
                    again = choices.mint(self.ledger, kind="tap_reconfirm", chat_id=self.config.owner_user_id,
                                         ttl_s=self.TAP_RELIST_TTL_S,
                                         target=json.dumps(dict(t, attempt=nxt, card=card)), db=db)
                    self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db, text=render.fit(
                        "Your calendar still couldn't be read, so nothing was done for that tap. The button below "
                        "reads your calendar again first and does it only if it isn't there; if your calendar "
                        "still can't be read, nothing is done."),
                        buttons=[[("Go ahead", choices.callback_data(again))]],
                        binds=[{"type": "choice", "nonce": again}], once=once)
            return ("Your calendar still couldn't be read, so nothing was done. Harness reads it again when you tap "
                    "Go ahead on the card that follows.")
        if retry is not None:
            return self._retry_ended(op, parts, retry)
        if seen == "done":
            with self.ledger.tx() as db:
                self.ledger.event("tap_reconfirm_found", {}, db=db)
            if op.get("effect") == "undo":
                return f"That's {self.UNDO_FOUND[CalendarChange.undo_expected(op)]}, so nothing was done again."
            return "That's on your calendar already, so nothing was done again."
        if seen == "removed":
            return "That was on your calendar and has since been taken off, so nothing was done again."
        if seen == "no_identity":
            return "Harness can't read that kind of tap on your calendar, so nothing was done again."
        if seen == "changed":
            return "That event changed on your calendar since, so Harness left it as it is and nothing was done."
        if seen == "absent" and not untaken:
            return ("Your calendar doesn't have that, and Harness can't tell whether it was added and taken off "
                    "since, so nothing was done again.")
        if seen == "mixed" and op.get("proposal") and self.calendar_change is not None:
            self.calendar_change.skip_found(str(op["proposal"]), op)
        if cid in (STOP, RESUME):
            return render.escape(self.commands._stop("") if cid == STOP else self.commands._resume(""))
        inc = Incoming(update_id=-int(time.time() * 1000), kind="callback", user_id=self.config.owner_user_id,
                       chat_id=self.config.owner_user_id, chat_type="private", message_id=mid, callback_id="",
                       callback_data=cid[len(DISCORD_PREFIX):])
        got = self.callbacks.handle(inc)
        if got == "ok" or got == "stopped":
            return ""
        return render.escape(callbacks.REFUSALS.get(got, "Not valid.")) + " Nothing changed."

    RETRY_ENDED_WORDS = ("Your calendar still couldn't be read after several tries, so nothing was done for that "
                         "tap, and nothing more is done for it from here.")

    @staticmethod
    def _attempt(t: dict) -> int | None:
        """Twenty-third round: which retry card a Go ahead came from (0 for the first card). Twenty-fourth round:
        None when the attempt can't be read (its own value, never taken as the first)."""
        got = t.get("attempt", 0)
        if got is None:
            return 0
        if isinstance(got, bool):
            return None
        try:
            n = int(got)
        except (TypeError, ValueError):
            return None
        return n if n >= 0 else None

    def _retry_ended(self, op: dict, parts: list, retry: list[int]) -> str:
        """Nineteenth round: his Go ahead on a change whose job ended with parts not done. Each part offered is read
        again by its own identity now, and only those still safe (CalendarChange.retry_safe) come back, on a new
        card for his approval, writing to the very fixed ids of the first offer, so nothing is made twice."""
        if self.calendar_change is None or self.runner is None or not op.get("proposal"):
            return "That can't be done from here, so nothing changed."
        got = [v for _, v in parts]
        now_safe = [i for i in self.calendar_change.retry_safe(op, got) if i in retry]
        if not now_safe:
            return "Your calendar shows nothing left to do again there, so nothing was done."
        pid = str(op["proposal"])
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (pid,)).fetchone()
        changes = list(op.get("changes") or [])
        keys = [str(k) for k in op.get("keys") or []]
        if p is None:
            return "That can't be done from here, so nothing changed."
        pick = [changes[i] for i in now_safe if i < len(changes)]
        # Twentieth round: the first offer's keys go in with the new card, so its preview is read at the very fixed
        # ids the write will use, and they're set with its proposal, before it can be approved.
        fixed = [keys[i] if i < len(keys) else f"{pid}:{i}" for i in now_safe if i < len(changes)]
        new_job = self.runner.recard(p, pick, "you asked for the parts that didn't go through to be done again, so "
                                              "they're on a new card", keys=fixed)
        row = self.ledger.db.execute("SELECT id FROM proposals WHERE job_id=? ORDER BY created_at DESC, rowid DESC"
                                     " LIMIT 1", (new_job,)).fetchone() if new_job else None
        if row is None:
            return "Nothing could be put on a new card, so nothing changed."
        with self.ledger.tx() as db:
            self.ledger.event("tap_retry_ended", {"proposal": pid, "parts": len(now_safe)}, db=db)
        return "A new card follows for the parts that didn't go through."

    def drain_on_stop(self) -> dict:
        """Fourteenth round, as the App stops: whatever is still queued is answered, so nothing is dropped
        silently. A tap written down stays in the journal for the next start (and he's told it waits); one that
        couldn't be written down is told it wasn't taken; a handover is answered that it wasn't taken."""
        out = {"kept": 0, "told": 0, "refused": 0}
        if self.handovers is None:
            return out
        for h in self.handovers.take():
            if h.kind == "press":
                if h.journaled:
                    out["kept"] += 1
                    self.handovers.tell(h, "Harness is restarting. Your tap is kept and goes through once it's "
                                           "back.")
                else:
                    out["told"] += 1
                    self.handovers.notify(h, "Not taken: Harness stopped before it took your tap. Nothing "
                                             "changed.")
                h.finish("working" if h.journaled else "refused", "Harness is stopping.")
            else:
                out["refused"] += 1
                h.finish("refused", "Not taken: Harness is stopping. Nothing changed.")
        if any(out.values()):
            log.warning("stopping with queued items: %s", out)
        return out

    def _fenced_tick(self) -> None:
        """Thirteenth round: a restore is staged, so nothing new is taken until the restart (whatever is recorded
        now is set aside by it). Each handover gets a plain answer, each tap an answer on its button; the outbox
        still posts (the card that asks him to restart), and the page and Cain's /health say a restore waits.
        Fourteenth round: the fence is the ledger's mode flag, and the outbox's delivery marks are exempt."""
        for h in (self.handovers.take() if self.handovers is not None else []):
            if h.kind == "press":
                self._refuse_tap(h, self.FENCED, restore_staged=True)   # told once, then struck off
            else:
                h.finish("refused", self.FENCED, restore_staged=True)
        self._beat()
        self.outbox.flush()
        self._publish()
        self._wait(3)

    def _wait(self, seconds: float) -> None:
        if self.discord is None:
            self.sleep(seconds)
            return
        # poll_timeout 0 (tests) means never block.
        self.discord.wake.wait(seconds if self.poll_timeout else 0)
        self.discord.wake.clear()

    def _link_health(self) -> None:
        """Once a minute: is Cain's link there to take cards? It is how he hears us."""
        now = self.monotonic()
        if now - getattr(self, "_link_checked", -1e9) < 60:
            return
        self._link_checked = now
        status = self.discord_chat.link.status(timeout=PROBE_S)
        self.cain_status = status
        if status is not None:
            self.ledger.ingest([])                # proves the path to him, for the digest
            self.notes.pop("cain_link", None)
        else:
            self.notes["cain_link"] = ("Cain isn't answering, so cards wait. Calendar "
                                       "work goes on; you'll see them when Cain is back.")
        if self.cain_watch is not None:
            self._watch_cain(status)

    def _watch_cain(self, status: dict | None) -> None:
        """The mutual watch (watch.py): Cain down for the grace period is told once,
        straight to his DM with the bot token, since Cain is the usual path and is the
        one that's down; still down after 30 minutes, one line with how to restart it;
        back is told once, the same way (a card held by Cain might
        never be shown). Cain counts as down when its link doesn't answer, or when it
        says its Discord connection is down (newer links only say). A failed send is
        tried again at the next check. Nothing here may stop the loop."""
        try:
            discord_down = (isinstance(status, dict) and isinstance(status.get("discord"), dict)
                            and status["discord"].get("connected") is False)
            why = watch.DISCORD if discord_down else watch.LINK
            due = self.cain_watch.observe(status is not None and not discord_down)
            if due is None:
                return
            if self._discord_seen is None or self.config is None:
                log.info("watch: Cain is %s, but Discord isn't ready here yet; next check", due)
                return
            down_s = self.cain_watch.down_for()
            text = (watch.down_text(down_s, why) if due == watch.DOWN else watch.still_text(why)
                    if due == watch.STILL else watch.back_text(down_s))
            self.discord.api.send(self.discord.dm(), escape(text), timeout=PROBE_S)
            self.cain_watch.sent(due)
            log.info("watch: told him Cain's add-on is %s (%s, after %.0fs)", due, why, down_s)
        except Exception as e:                 # a due message stays due for the next check
            log.warning("watch: couldn't check or tell him about Cain: %s: %s", type(e).__name__,
                        str(getattr(e, "description", "") or "")[:80])

    def _discord_ready(self) -> bool:
        """Identify the bot and its owner once per token; on a new bot, move over."""
        print_ = hashlib.sha256(self.vault.get("discord_bot_token").encode()).hexdigest()[:16]
        if self._discord_seen == print_ and self.config is not None:
            return True
        try:
            if self._discord_seen is not None:
                self.discord.forget_identity()
            owner, bot = self.discord.owner(), self.discord.bot()
            self.discord.dm()
        except DiscordError as e:
            self.notes["discord"] = f"Discord check failed: {e.description or e.code}"
            return False
        if not owner or not bot:
            self.notes["discord"] = "Discord didn't say which bot this token belongs to, or whose"
            return False
        owner_i, bot_i = int(owner), int(bot)
        if self.ledger.bot_id() != bot_i:
            self.ledger.set_bot(bot_i)
            self.ledger.set_meta("chat_name", "Discord")
        self.api = self.discord_chat
        self.outbox.api = self.discord_chat
        self._bind_owner(owner_i)
        self.runner.answers_to_cain = True
        self._reconcile()
        retried = self.runner.retry_recent_failures()     # often an update that fixed the cause
        if retried:
            log.info("retrying %d recent failure(s) after the restart", retried)
        self._discord_seen = print_
        self.notes.pop("discord", None)
        log.info("discord: cards go to Cain for the bot's owner")
        return True

    def _press(self, h) -> None:
        """A tap on one of our cards, checked by Cain's link and passed back here. The
        card's own checks (that card, once, before it expires) are the ledger's."""
        p = h.press
        journaled = self.handovers is not None and h.journaled and bool(self.handovers.journal)
        if journaled and not self.handovers.journal_intent(p, self._tap_op(p)):
            # Sixteenth round: the intent is written before anything is acted on; one that can't be is a refusal.
            log.error("a tap's intent couldn't be written to the tap journal: not taken")
            self._refuse_tap(h, handover.UNRECORDED_TAP, journaled=False)
            return
        h.intent = journaled                   # seventeenth round: from here an exception leaves it unknown
        self._press_inner(h, p)
        # Fourteenth round: answered (and struck off the tap journal) only once what it did is committed.
        # Fifteenth round: the commit is written in the journal itself first, so a replay never acts twice, even
        # after the ledger is put back from a backup that predates it. Sixteenth round: its result is checked.
        if journaled and not self.handovers.journal_commit(p):
            log.error("a tap was carried out but its outcome couldn't be written to the tap journal")
            told = self.handovers.tell(h, self.COMMIT_UNRECORDED)
            h.finish("ok", self.COMMIT_UNRECORDED, journal_commit=False, told=told)
            return                             # kept: the next start settles it by the records and the calendar
        h.finish("ok")
        if self.handovers is not None:
            self.handovers.journal_done(p)

    COMMIT_UNRECORDED = ("Your tap went through, but Harness couldn't note that in its tap list (logged). If its "
                         "records are ever put back from a backup, it reads your calendar before doing anything with "
                         "this tap again.")

    def _press_inner(self, h, p) -> None:
        owner = self.config.owner_user_id
        cid = str(p.get("custom_id", ""))
        if not cid.startswith(DISCORD_PREFIX):
            return
        if cid in (STOP, RESUME):
            text = self.commands._stop("") if cid == STOP else self.commands._resume("")
            with self.ledger.tx() as db:
                self.ledger.enqueue(chat_id=owner, kind="stopped" if cid == STOP else "resumed",
                                    text=text, db=db)
                if cid == RESUME and not commands.is_paused(self.ledger):
                    commands.card_stopped(self.ledger, owner, db)   # what he asked meanwhile
            return
        try:
            inc = Incoming(update_id=int(p["id"]), kind="callback", user_id=owner,
                           chat_id=owner, chat_type="private",
                           message_id=int(p["message_id"]),
                           callback_id=f"{p.get('app', '')}:{p.get('token', '')}",
                           callback_data=cid[len(DISCORD_PREFIX):])
        except (KeyError, ValueError, TypeError):
            return
        if h.journaled and self.ledger.db.execute(
                "SELECT 1 FROM updates WHERE bot_id=? AND update_id=? AND kind='callback'",
                (self.ledger.bot_id(), inc.update_id)).fetchone():
            return                             # a journaled tap the last run already took: not taken twice
        self.ledger.ingest([Decision(inc, True, None, None)])
        self.callbacks.handle(inc)

    def _handover(self, h) -> None:
        """Cain says he asked for a calendar change. Read the DM and act on his own words, never
        on Cain's: the message Cain names (keeper.sh handover --message), if it's his and from the
        last 30 minutes, or else his newest message, if it's from the last 2 minutes. A message
        older than 2 minutes, named or carrying Cain's suggestion, is still acted on, with any
        change on a card: his Approve tap is his go (Nov 15: a handover that spelled the event out
        was refused as stale)."""
        owner = self.config.owner_user_id
        if h.paired and h.paired != str(owner):
            self.notes["discord_owner"] = ("Cain is paired with a different Discord account than "
                                           "the bot's owner, so the keeper won't act for Cain")
            h.finish("refused", "The specialist won't act: you're paired with a different "
                                "Discord account than the bot's owner.")
            return
        held = migrate.waiting(self.ledger)
        if held:
            # Tenth and eleventh rounds: the live ledger waits because its own dry run of this build failed;
            # nothing is taken meanwhile. He has Run check; keeper.sh fastpath migrate-check is the same.
            # Twelfth round: the answer carries the reason and where his Run check message is, so Cain can say so.
            notice = {"sent": "He has the message with Run check.",
                      "queued": "The message with Run check hasn't reached him yet; it's being sent again until "
                                "it does."}.get(migrate.notice_state(self.ledger),
                                                "The message with Run check is being posted to him again.")
            h.finish("refused", "Not taken: the specialist was updated, and its rehearsal of moving its records to "
                                f"the new build on a copy of them didn't pass ({held.get('why', 'see the log')}). "
                                f"{notice} Run check rehearses it again; keeper.sh fastpath "
                                "migrate-check does the same. keeper.sh fastpath migrate-override only sends him "
                                "a card to move them unrehearsed, on his tap. Nothing changed.",
                     waiting=migrate.waiting_summary(self.ledger))
            return
        if h.smoke_run:
            # Tenth round: a handover only ever reads his own messages, so one naming the smoke run cites a
            # real request of his: it's never the run's (steps run from their script on his Start step tap).
            # It goes on as an ordinary request, held like any other while a gate is closed, his title kept.
            log.info("a handover named the smoke run; it cites his own message, so it's an ordinary request")
            with self.ledger.tx() as db:
                self.ledger.event("calendar_smoke_handover_ordinary", {"run": h.smoke_run}, db=db)
        if time.monotonic() - h.arrived > FRESH_S:      # the window runs from the handover
            h.finish("stale", "That handover waited here over 2 minutes before it could be read, "
                              "so nothing was done with it. Nothing changed. Hand it over again.")
            return
        try:
            msgs = self.discord.api.history(self.discord.dm(), 50 if h.message else 20)
        except DiscordError as e:
            h.finish("error", f"The specialist couldn't read the DM ({scrub.scrub(e.code)}). Nothing changed.")
            return
        mine = [m for m in msgs if str((m.get("author") or {}).get("id")) == str(owner)]
        if h.message:
            m = next((x for x in msgs if str(x.get("id")) == h.message), None)
            if m is None or m not in mine:
                h.finish("nothing", "The message you named isn't one of his in the DM's last 50, so "
                                    "nothing was done. Nothing changed.")
                return
        elif not mine:
            h.finish("nothing", "There's no message from him to act on.")
            return
        else:
            m = mine[0]                                      # Discord lists newest first
        try:
            age = (self.ledger.now() - datetime.fromisoformat(m["timestamp"])).total_seconds()
        except (KeyError, ValueError, TypeError):
            age = NAMED_FRESH_S + 1
        h.age = max(0.0, age)
        limit = NAMED_FRESH_S if (h.message or h.suggestion) else FRESH_S
        if age > limit:
            h.finish("stale", (
                "The message you named is over 30 minutes old" if h.message else
                "His newest message is over 30 minutes old" if h.suggestion else
                "His newest message is over 2 minutes old")
                + ", so nothing was done with it. Nothing changed."
                + ("" if h.message else " Name the message it rests on with --message <its id>."))
            return
        text, flags, reply_to = self._discord_words(m, msgs, owner)
        later = mine.index(m) if m in mine else 0            # his messages after it, newest first
        if age > FRESH_S:
            flags.append("late")                             # his tap is the go, not the handover
        if later:
            flags.append("not_newest")                       # never without his tap (0.24.0)
        origin = {"quote": text, "sent_at": m.get("timestamp", ""), "after": later, "message": str(m["id"])}
        note = ""
        if h.suggestion:
            echoes = echoes_message(h.suggestion, text)
            flags.append("cain_detail" if echoes else "suggestion")
            note = _note(h.suggestion, echoes=echoes)
            text += note
        if not text.strip():
            h.finish("nothing", "His message has no words to act on.")
            return
        hit = self._screen_text(text)
        if hit:
            h.finish("refused", f"That message wasn't kept: it looks like {hit}. "
                                "Nothing was stored.")
            return
        inc = Incoming(update_id=int(m["id"]), kind="message", user_id=owner,
                       chat_id=owner, chat_type="private", message_id=int(m["id"]),
                       text=text, reply_to_message_id=reply_to)
        jobs = self.ledger.ingest([Decision(inc, True, None, "message")])
        if jobs:
            job_id = jobs[0]
            fixed = self.ledger.get_meta(f"correction_of:{m['id']}")
            if fixed:
                # Sent while a no-tap change of his was being written (calendar_change._finish): a
                # correction of that change, never a request of its own, and on a card.
                flags.append("correction")
                root = self.ledger.get_meta(f"job_parent:{fixed}") or fixed
                parts = json.loads(self.ledger.get_meta(f"job_parts:{root}") or "[]")
                with self.ledger.tx() as db:
                    self.ledger.set_meta(f"job_parent:{job_id}", root, db)
                    self.ledger.set_meta(f"job_parts:{root}", json.dumps(parts + [job_id]), db)
            if flags:
                self.ledger.set_meta(f"job_flags:{job_id}", json.dumps(sorted(set(flags))))
            self.ledger.set_meta(f"job_origin:{job_id}", json.dumps(origin))
        else:
            # The message acted on is the key: a later handover for the same message finds its
            # request, never the answer to whatever he said last.
            row = self.ledger.db.execute(
                "SELECT id FROM jobs WHERE bot_id=? AND chat_id=? AND message_id=?",
                (self.ledger.bot_id(), owner, int(m["id"]))).fetchone()
            if row is None:
                h.finish("error", "That couldn't be recorded. Nothing changed.")
                return
            job_id = row["id"]
            self.ledger.set_meta(f"job_origin:{job_id}", json.dumps(origin))   # how many after it, now
            if note:
                self._note_for_question(job_id, note, flags)
        h.job = render.short(job_id)                       # for the log only
        self._handover_jobs.setdefault(job_id, []).append(h)

    def _note_for_question(self, job_id: str, note: str, flags: list[str]) -> None:
        """A note from Cain for a request of his reaches it: one waiting on its question, one
        answered "not a change" to Cain alone, or one with a card still open or a change being done
        (one of its parts, when it was split). The note is fenced as Cain's (Nov 11: a second
        handover with the missing fact got the same question back; Nov 15: a later handover got the
        same cached answer). A request with no card open runs again with it. Beside open cards it
        runs as a request of its own, for the same message, and replaces only the cards whose change
        it addresses: the others stand, still offered (runner._address_open, 0.24.0, third round).
        While a change of that message is being done under its lease, it waits, then reads the
        result. What's already done isn't done again (runner._not_yet_done). A note it already has
        changes nothing, and any change resting on it still gets his tap."""
        job = self.ledger.job(job_id)
        if job is None:
            return
        parts = json.loads(self.ledger.get_meta(f"job_parts:{job_id}") or "[]")
        family = [job_id] + parts
        if any(note in self.ledger.job_text(j) for j in family):
            return
        states = {j: (self.ledger.job(j) or {"state": ""})["state"] for j in family}
        # 0.24.5: a request answered "not a change" (no card of it ever made) is read afresh with a new
        # note, whoever its answer went to: the outcome isn't sticky for the message, and a note with the
        # same words is still taken once (above). A repeated "Nothing changed" isn't sent twice
        # (calendar_change._nothing_once).
        in_place = job["state"] == "needs_clarification" or (
            job["state"] in ("no_action", "answered") and (self._answered_to_cain(job_id)
                                                           or self._no_card_ever(family, states)))
        beside = any(st in ("proposed", "approved") for st in states.values())
        if not in_place and not beside and not self._all_closed(family):
            return                       # a card he saw (a rule, a refusal) isn't sent again
        marks = ",".join("?" * len(family))
        last = self.ledger.db.execute(f"SELECT COALESCE(MAX(id), 0) FROM outbox WHERE job_id IN ({marks})",
                                      tuple(family)).fetchone()[0]
        text = self.ledger.job_text(job_id)
        flagged = json.loads(self.ledger.get_meta(f"job_flags:{job_id}") or "[]")
        with self.ledger.tx() as db:
            if in_place:
                target = job_id
                db.execute("UPDATE job_text SET text=? WHERE job_id=?", (text + note, target))
                self.ledger.set_meta(f"job_flags:{target}", json.dumps(sorted(set(flagged + flags))), db)
                self.ledger.transition(target, "received", db=db)
                db.execute("DELETE FROM meta WHERE key IN (?, ?)", (f"job_rerun:{job_id}", f"clarify_due:{target}"))
            else:
                target = self.ledger.made_job(job["chat_id"], text + note, kind="message", db=db,
                                              reply_to=job["reply_to_message_id"], created_at=job["created_at"],
                                              state="received")
                self.ledger.set_meta(f"job_flags:{target}", json.dumps(sorted(set(flagged + flags))), db)
                self.ledger.set_meta(f"job_parent:{target}", job_id, db)
                self.ledger.set_meta(f"job_parts:{job_id}", json.dumps(parts + [target]), db)
                self.ledger.set_meta(f"job_rerun:{job_id}", target, db)
            self.ledger.event("job_note", {"job": target}, db=db)
            db.execute("DELETE FROM meta WHERE key=?", (f"clarify_card:{target}",))
            # Kept in the ledger, so every later answer about it, after a restart too, starts here.
            self.ledger.set_meta(f"job_rerun_after:{job_id}", str(last), db)
        log.info("handover: a note for job %s: it runs again%s", render.short(job_id),
                 "" if in_place else " beside its open cards")

    def _no_card_ever(self, family: list[str], states: dict) -> bool:
        """Every request of this message was answered in words, and none of it ever came on a card."""
        marks = ",".join("?" * len(family))
        made = self.ledger.db.execute(f"SELECT COUNT(*) FROM proposals WHERE job_id IN ({marks})",
                                      tuple(family)).fetchone()[0]
        return not made and all(st in ("no_action", "answered") for st in states.values())

    def _all_closed(self, family: list[str]) -> bool:
        """Every card of this message was declined or ran out, and nothing of it was done: a note
        then runs it again as a new request of the same message, its quote and flags kept, and any
        change comes on a new card (0.24.0, fourth round)."""
        marks = ",".join("?" * len(family))
        got = [r[0] for r in self.ledger.db.execute(
            f"SELECT state FROM proposals WHERE job_id IN ({marks})", tuple(family)).fetchall()]
        return bool(got) and all(st in ("declined", "expired", "superseded") for st in got) \
            and any(st in ("declined", "expired") for st in got)

    def _answered_to_cain(self, job_id: str) -> bool:
        """Its last answer went to Cain alone, so running it again shows him nothing twice."""
        receipts = self.ledger.receipts(job_id)
        try:
            return bool(receipts) and bool(json.loads(receipts[-1]["detail"] or "{}").get("said_to_cain"))
        except ValueError:
            return False

    def _discord_words(self, m: dict, msgs: list[dict], owner: int):
        """His words, the signs they may not be his own, and our card he replied to."""
        flags: list[str] = []
        text = m.get("content") or ""
        ref = m.get("message_reference") or {}
        if m.get("edited_timestamp"):
            flags.append("edited")
        if ref.get("type") == 1 or m.get("message_snapshots"):
            flags.append("forwarded")
            snaps = m.get("message_snapshots") or []
            if not text and snaps:
                text = ((snaps[0] or {}).get("message") or {}).get("content") or ""
        if m.get("attachments"):
            flags.append("attachment")
        reply_to = None
        if ref.get("message_id") and ref.get("type", 0) == 0:
            rid = str(ref["message_id"])
            card = self.discord_chat.link.card_of(rid)
            if card:
                reply_to = int(card)                         # a reply to our card: still him
            else:
                target = m.get("referenced_message") or next(
                    (x for x in msgs if str(x.get("id")) == rid), None)
                if not target or str((target.get("author") or {}).get("id")) != str(owner):
                    flags.append("foreign_reply")
        return text, flags, reply_to

    # -- the morning: Cain folds the digest into his one message ----------------------------
    def _cain_digest(self, h) -> None:
        held = self.ledger.get_meta("digest_held_at")
        if not held:
            h.finish("none", "No calendar digest is waiting. Today's was already posted, "
                             "or it isn't 7:00 AM yet.")
            return
        h.finish("ok", render.plain(self.ledger.get_meta("last_digest_text") or ""))

    def _fastpath(self, h) -> None:
        """Cain's keeper.sh fastpath (0.24.0, fourth to sixth rounds). "smoke-start" starts a smoke run
        under an id issued here; "smoke-step" opens one step of it (ninth round), and only the next handover
        naming the run is recorded under that id, never anything else that arrives meanwhile. "on" names
        the run: its checklist is built here from this ledger alone (event ids, request and read-back
        times, the refusals for an older version, the listing lag), anything with no evidence is
        refused by name and nothing changes, and anything Cain sends as passed is ignored. A full one
        goes to him on a card with Turn on and Keep cards; only his Turn on tap turns on the no-card
        paths. "off" turns them off at once. Until his tap, every calendar change comes on a card."""
        from .calendar_change import fast_path, set_fast_path
        cc = self.calendar_change
        if h.state in ("smoke-start", "on", "smoke-step") and cc is None:
            h.finish("off", "Calendar changes aren't set up in the calendar specialist.")
            return
        if h.state == "smoke-start":
            run = cc.smoke_start()
            log.info("a smoke run started")
            h.finish("ok", f"Smoke run {run['id']} started. Offer each step of its checklist with keeper.sh fastpath "
                           f"smoke-step {run['id']} <step> <gmail|family> <add|move|remove> <YYYY-MM-DD> <test title> "
                           "[HH:MM-HH:MM]: he gets a card showing its script with Start step N, and his tap puts "
                           "the step's change on a card built from the script, for his Approve. Hand nothing over "
                           f"for a step. Run keeper.sh fastpath smoke-step {run['id']} conformance-gmail and "
                           f"conformance-family too. Then send keeper.sh fastpath on {run['id']}.", run=run["id"])
            return
        if h.state == "smoke-step":
            # Ninth round: only a change made under a step Cain opens is the run's.
            if commands.is_paused(self.ledger):
                h.finish("refused", "I'm stopped, so no smoke step was opened or run. Nothing changed.")
                return
            if not h.run:
                h.finish("refused", "Name the smoke run and the step: keeper.sh fastpath smoke-step <run id> <step>. "
                                    "Nothing changed.")
                return
            status, said, extra = cc.smoke_step(h.run, h.step, h.script)
            h.finish(status, said, **extra)
            return
        if h.state == "on":
            if h.record:
                log.info("a pass or fail record from Cain was ignored: the run is judged from the ledger")
            if not h.run:
                h.finish("refused", "Name the smoke run: keeper.sh fastpath on <run id>, from fastpath smoke-start. "
                                    "Nothing changed; every change still comes on a card.")
                return
            missing = cc.offer_fast_path(h.run)
            if missing:
                log.info("the smoke run was refused: %d item(s) with no evidence in the ledger", len(missing))
                h.finish("refused", "Not all shown in the record, so nothing changed and every change still comes on "
                                    "a card. No evidence for: " + "; ".join(missing) + ".")
                return
            log.info("the smoke run passed on the ledger's evidence: its card is with him")
            h.finish("ok", "All shown in the record. He has a card with the evidence, Turn on and Keep cards; changes "
                           "still come on a card until he taps Turn on.")
            return
        if h.state == "off":
            if cc is not None:
                cc.turn_off("cain")              # its run is over and any Turn on card comes off
            else:
                set_fast_path(self.ledger, False, fast_path(self.ledger).get("smoke", ""), by="cain")
            log.info("the no-card path is off")
            h.finish("ok", "Off: every calendar change comes on a card.")
            return
        if h.state == "gate-open":
            # Eighth round: a calendar's gate after an install opened without the check, when the check
            # can't complete there. Logged, with who; its held changes come back on fresh cards.
            if cc is None:
                h.finish("off", "Calendar changes aren't set up in the calendar specialist.")
                return
            if not h.calendar:
                h.finish("refused", "Name the calendar: keeper.sh fastpath gate-open gmail, or family. Nothing changed.")
                return
            said = cc.open_gate(h.calendar, by="cain")
            h.finish("ok", render.plain(said))
            return
        if h.state == "migrate-check":
            # Eighth round: the migration on a copy of a ledger file, never the file itself. Tenth round: with
            # a candidate (a source tree or an image path), the incoming build's own migration, recorded
            # under its own build id, which its install step looks for before touching the live ledger.
            path = h.path or self.ledger.path
            live = not h.candidate and path == self.ledger.path
            if live:
                migrate.checkpoint(self.ledger)        # twelfth round: copied from the live connection
            got = migrate.candidate_dry_run(path, h.candidate) if h.candidate else \
                migrate.dry_run(path, source=self.ledger.db if live else None)
            log.info("migration dry run%s on a copy of %s: %s", " of a candidate build" if h.candidate else "", path,
                     "ok" if got.get("ok") else got.get("said"))
            # Ninth round: the result is kept in the live ledger, keyed by the build that ran it and the
            # checksum of the copy it ran on.
            got["recorded"] = migrate.record_dry_run(self.ledger, got) if got.get("build") or not h.candidate else {}
            moved = self._migrate_if_waiting()
            said = ((f"The migration of build {got.get('build')} ran on a copy; the ledger itself wasn't touched, "
                     "and the result is recorded for that build." if h.candidate else
                     "The migration ran on a copy; the ledger itself wasn't touched.") if got.get("ok")
                    else got.get("said", "The dry run failed."))
            if moved:
                said += " This build was waiting for it, so the records are moved now, with a backup taken first."
            h.finish("ok" if got.get("ok") else "refused", said, result=got)
            return
        if h.state == "migrate-restore":
            # Twelfth round: Cain names a backup by schema and build; he gets a card, and only his tap stages it.
            status, said = migrate.request_restore(self.ledger, self.config.owner_user_id, h.restore, by="cain")
            h.finish(status, said)
            return
        if h.state == "migrate-clock":
            # Thirteenth round: only posts him the card with Use the clock as it is now, when the clock holds
            # backup pruning up; the clock is taken as right only on his tap.
            sent = migrate.post_clock_card(self.ledger, self.config.owner_user_id, force=True)
            stall = migrate.clock_stall(self.ledger)
            h.finish("ok" if sent else "refused",
                     (f"He has a card to take the clock as right; pruning is held up by a record stamped "
                      f"{stall.get('at', '')}. Nothing changed yet." if sent else
                      "The clock doesn't hold pruning up by a record, so there's no card to send. Nothing changed."),
                     pruning_stalled=stall)
            return
        if h.state == "migrate-override":
            # Eleventh round: the override is his alone. Cain's command only posts him a card saying the
            # migration is unrehearsed, why the dry run failed and that a backup is taken first; it runs only
            # on his tap, once, for this build (migrate.override_tapped).
            status, said = migrate.request_override(self.ledger, self.config.owner_user_id, by="cain")
            h.finish(status, said)
            return
        now = fast_path(self.ledger)
        h.finish("unknown", "Say smoke-start, smoke-step <run id> <step> [script], on <run id>, off, gate-open "
                 "<gmail|family>, migrate-check [path] [candidate], migrate-override, "
                 "migrate-restore <schema> <build> or migrate-clock. "
                 "It's " + ("on" if now.get("on") else "off (card only)") + " now.")

    def _migration_choice(self, kind: str, target: str) -> str:
        """His Run check, or his tap on the override card (eleventh round)."""
        owner = self.config.owner_user_id
        if kind == "migration_check":
            said = migrate.check_tapped(self.ledger, self.calendar_change, owner, target)
        elif kind == "migration_restore":
            said = migrate.restore_tapped(self.ledger, target, owner)
        elif kind == "migration_clock":
            said = migrate.accept_clock(self.ledger, by="owner tap")
        else:
            said = migrate.override_tapped(self.ledger, self.calendar_change, owner, target)
        return said

    def _migrate_if_waiting(self) -> bool:
        """Tenth round: the live ledger was waiting for a dry run of this build (or an override); once one
        is recorded, the records are moved now (migrate.run_live, backup first). Whether it moved them."""
        if not migrate.waiting(self.ledger):
            return False
        swept = migrate.run_live(self.ledger, self.calendar_change, self.config.owner_user_id)
        if swept.get("waiting"):
            return False
        log.info("ledger migrated after its dry run: %s", swept)
        return True

    def _meanings(self, h) -> None:
        """What he told Cain kinds of Family events mean, from his record, already checked
        (handover.py). Stored as his confirmed examples; the same table again stores nothing."""
        if self.meaning_live is None:
            h.finish("off", "Event meanings aren't set up in the calendar specialist.")
            return
        added, known = self.meaning_live.import_rows(h.rows)
        log.info("meanings from Cain: %d rows, %d new, %d already known", len(h.rows), added, known)
        h.finish("ok", f"Stored {added} new; {known} already known.", new=added, known=known)

    def _places(self, h) -> None:
        """His place book, from his record, already checked (handover.py): the whole book,
        replacing what was here. Events at those places get their address and drives on the
        next read of Family."""
        if self.meaning_live is None:
            h.finish("off", "Places aren't set up in the calendar specialist.")
            return
        n, skipped = self.meaning_live.places.import_rows(h.rows)
        h.finish("ok", f"Stored {n} place{'s' * (n != 1)}; {skipped} skipped.", places=n, skipped=skipped)

    def _morning_posted(self, h) -> None:
        self.ledger.set_meta("digest_held_at", "")          # the digest is in it now
        h.finish("ok")

    def _release_digest(self) -> None:
        """If Cain didn't post his morning message in time, the digest goes out on its own
        (one of the two things that bypass him), so a silent morning means something is wrong."""
        held = self.ledger.get_meta("digest_held_at")
        if not held:
            return
        if (self.ledger.now() - datetime.fromisoformat(held)).total_seconds() < DIGEST_WAIT_S:
            return
        with self.ledger.tx() as db:
            self.ledger.set_meta("digest_held_at", "", db)
            self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="alert", db=db,
                                text=("<i>Cain didn't post his morning message, so here is the "
                                      "calendar digest on its own.</i>\n"
                                      + (self.ledger.get_meta("last_digest_text") or "")))
        log.warning("digest posted without Cain's morning message")

    def _finish_handovers(self) -> None:
        """Answer Cain once the request has settled and its cards are with him."""
        for job_id, waiting in list(self._handover_jobs.items()):
            job = self.ledger.job(job_id)
            if job is None:
                for h in waiting:
                    h.finish("error", "Lost track of that. Nothing changed.")
                del self._handover_jobs[job_id]
                continue
            # A message split into one card per change (runner._split) answers once all are out.
            parts = json.loads(self.ledger.get_meta(f"job_parts:{job_id}") or "[]")
            states = [job["state"]] + [(self.ledger.job(j) or {"state": "failed"})["state"] for j in parts]
            if any(st in ("received", "running", "approved") for st in states):
                continue
            # A request that ran again for a note answers with what it said this time.
            ids = [job_id] + parts
            rows = self.ledger.db.execute(
                f"SELECT kind, text, state, message_id FROM outbox WHERE job_id IN ({','.join('?' * len(ids))})"
                " AND kind!='notice' AND id>? ORDER BY id",
                (*ids, int(self.ledger.get_meta(f"job_rerun_after:{job_id}") or 0))).fetchall()
            if any(r["state"] not in ("sent", "dead") for r in rows):
                continue                                      # not with Cain yet
            sent = [r for r in rows if r["state"] == "sent"]
            said = [render.plain(r["text"]) for r in sent]
            # A note that ran as its own request (a rerun beside open cards) answers for it.
            lead = self.ledger.job(self.ledger.get_meta(f"job_rerun:{job_id}") or job_id) or job
            receipts = self.ledger.receipts(lead["id"])
            to_cain = ""
            if receipts and lead["state"] in ("answered", "no_action", "needs_clarification"):
                try:
                    to_cain = json.loads(receipts[-1]["detail"] or "{}").get("said_to_cain", "")
                except ValueError:
                    to_cain = ""
            status = {"answered": "not a change" if to_cain else "card",
                      "no_action": "not a change",
                      "proposed": "waiting for his tap"}.get(lead["state"], lead["state"])
            if parts and "proposed" in states:
                status = "waiting for his tap"
            words = to_cain or "\n\n".join(said) or "Done."
            cards = [int(r["message_id"]) for r in sent if r["message_id"]]
            for h in waiting:
                h.finish(status, words, cards=cards)
            del self._handover_jobs[job_id]

    def _busy(self) -> bool:
        return bool(self.runner and self.runner.in_flight) or bool(
            self.canary and self.canary.pending) or bool(
            self.calendar and self.calendar.pending) or bool(self.ledger.due_outbox())

    def _screen_text(self, text: str) -> str | None:
        cfg = self.config or self.base_config
        hit = ingress_filter.check(text, work_domains=cfg.work_domains,
                                   markers=cfg.work_markers)
        return f"work content ({hit.kind})" if hit else None

    def _proactive_ok(self) -> bool:
        local = self.ledger.now().astimezone(ZoneInfo(self.config.timezone)).date()
        return local >= self.config.proactive_from

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
                text=(f"<b>Settings change requested</b> on the Harness page by "
                      f"{render.escape(p['by'])}: replace the {LABELS.get(p['field'], p['field'])}. "
                      "Only your tap applies it. <i>Expires in 15 min.</i>"),
                buttons=[[("Approve", choices.callback_data(ok)),
                          ("Decline", choices.callback_data(no))]],
                binds=[{"type": "choice", "nonce": ok}, {"type": "choice", "nonce": no}],
                db=db)
        self.vault.mark_announced(p["id"])

    def _settings_decision(self, change_id: str, decision: str) -> str:
        field = self.vault.pending_field(change_id)
        msg = self.vault.resolve_change(change_id, decision)
        self.ledger.event("settings_change", {"id": change_id, "decision": decision})
        if decision == "approve" and msg.startswith("Done.") and field and self.inputs is not None:
            try:                       # a new key: a refusal of it is told again (inputs.py)
                self.inputs.key_changed(field)
            except Exception as e:
                log.warning("input watch: after a new key: %s", type(e).__name__)
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
        owner = self.config.owner_user_id if self.config is not None else None
        if owner is not None:
            # Tell him first, while the token still works.
            with self.ledger.tx() as db:
                self.ledger.enqueue(chat_id=owner, kind="notice", text=(
                    f"<b>The harness was reset</b> from the Harness page by "
                    f"{render.escape(by)}. It no longer listens to this chat."), db=db)
            self.outbox.flush()
        self.vault.reset()
        if self.family is not None:
            self.family.forget()           # the pinned Home Assistant key goes too
        if self.family_add is not None:
            self.family_add.forget()       # off again, and the bake-in starts over
            self._family_note()
        if self.calendar_change is not None:
            self.calendar_change.forget()
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
            d = self._compose_digest(paused)
            if daily.deliver(self.ledger, cfg, d, hold=self._discord_mode()):
                if self.inputs is not None:
                    try:                               # what it named is known to him now
                        self.inputs.digest_sent(d.named)
                    except Exception as e:             # never at the cost of the receipts
                        log.warning("input watch: after the digest: %s", type(e).__name__)
                if self.meaning_live:
                    self.meaning_live.send_receipts()  # each new block's card, with Undo
                if self.family_gmail is not None:
                    self.family_gmail.send_drive_receipts()   # his own appointments' drives, with Undo

    def _compose_digest(self, paused: bool):
        """The morning digest as composed from every input (no write: delivering it is daily.deliver's).
        Twenty-seventh round: its own method, so the storage note's no-write check runs on this very path."""
        return daily.gather(self.ledger, self.config, paused=paused, notes=list(self.notes.values()),
                            calendar=self.calendar, family=self.family,
                            mirror_line=self.mirror.digest_line() if self.mirror else "",
                            family_add_line=" ".join(x for x in (
                                self.family_add.digest_line() if self.family_add else "",
                                self.family_copy.digest_line() if self.family_copy else "",
                                self.family_gmail.digest_line() if self.family_gmail else "",
                                self.calendar_change.digest_line() if self.calendar_change else "",
                                self.mail_dates.digest_line() if self.mail_dates else "",
                                self.meaning_live.digest_line() if self.meaning_live else "")
                                if x), watch=self.inputs)

    # -- status ------------------------------------------------------------------------------
    def status_text(self) -> str:
        cfg = self.config
        tz = ZoneInfo(cfg.timezone)
        now = self.ledger.now()
        last = self.ledger.last_poll_success()
        fa_on = self.family_add is not None and self.family_add.enabled()
        changes_on = self.calendar_change is not None and self.calendar_change.on()
        lines = [f"<b>Status</b> · stage {cfg.stage} · " +
                 ("calendar holds on" if cfg.stage_at_least("S2")
                  else "calendar changes on" if changes_on
                  else "one effect: Family calendar adds" if fa_on else "zero effects"),
                 "Stopped (/resume)" if commands.is_paused(self.ledger) else "Running"]
        if self.family_add is not None:
            lines.append(self.family_add.status_line())
            if fa_on and self.family_copy is not None:
                lines.append(self.family_copy.status_line())
            if fa_on and self.family_gmail is not None:
                lines.append(self.family_gmail.status_line())
        if self.calendar_change is not None:
            lines.append(self.calendar_change.status_line())
        if last:
            lines.append(f"{render.escape(self.ledger.get_meta('chat_name') or 'Chat')}: "
                         f"last contact {int((now - last).total_seconds())}s ago")
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
            for c in self.calendar.coverage():
                when = f"read {c.ok_at.astimezone(tz):%a %-I:%M %p}" if c.ok_at else "not read yet"
                lines.append(f"Calendar {render.escape(c.label or c.name[9:13])}: {when}" +
                             (f" (last problem: {render.escape(c.error)})" if c.error else ""))
        if self.family is not None and cfg.family_entity:
            lines.append("Family calendar: " + render.escape(family_line(self.family.status(), tz)))
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
            "stage": self.base_config.stage,
            "proactive_from": self.base_config.proactive_from.isoformat(),
            "last_poll": last.isoformat() if last else None,
            "paused": commands.is_paused(self.ledger),
            "integrity_since": (self.ledger.get_meta("integrity_since") or None),
            "notes": list(self.notes.values()),
            "calendar": ([{"label": c.label or f"calendar {c.name[9:13]}",
                           "ok_at": c.ok_at.isoformat() if c.ok_at else None,
                           "error": c.error} for c in self.calendar.coverage()]
                         if self.calendar is not None and self.calendar.configured else []),
            "family": (self.family.status() if self.family is not None
                       and self.base_config.family_entity else None),
            "last_digest": {"at": self.ledger.get_meta("last_digest_at"),
                            "sent": self.ledger.get_meta("last_digest_sent") == "yes",
                            "text": self.ledger.get_meta("last_digest_text") or ""},
            "meaning_shadow": self.meaning.status() if self.meaning is not None else None,
            "discord": self._discord_status(),
            # Fifteenth round: mail skipped by kind (sender, subject, rule), and why mail_skip.json was ignored.
            "mail_skipped": self.mail_dates.skipped_status() if self.mail_dates is not None else None,
            "mail_skip_problem": (getattr(self.mail_dates, "skip_problem", "") or None)
            if self.mail_dates is not None else None,
        })

    def _discord_status(self) -> dict | None:
        """The Discord link (it lives in Cain's add-on) and the watch on Cain, for the page.
        What Cain's link says is checked for shape here; the page escapes it again."""
        if self.discord_chat is None or not hasattr(self, "_link_checked"):
            return None                       # not checked yet: nothing to say
        link = None
        st = self.cain_status
        if isinstance(st, dict) and isinstance(st.get("discord"), dict):
            d = st["discord"]
            heard = watch.num(d.get("last_heard"))
            ceiling = (self.cain_watch.clock() if self.cain_watch is not None else time.time()) + 86400
            try:
                ok = heard is not None and HEARD_FLOOR_S <= heard / 1000 <= ceiling
                last_heard = watch.iso(heard / 1000) if ok else None
            except (OverflowError, ValueError, TypeError):
                last_heard = None
            link = {"connected": d.get("connected") is True, "last_heard": last_heard}
        return {"cain_answering": st is not None, "link": link,
                "cain": self.cain_watch.status() if self.cain_watch is not None else None}
