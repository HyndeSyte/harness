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
               handover, policy, provenance, render, rules, watch)
from .calendar_change import CalendarChange
from .chat import Decision, Incoming
from .config import Config
from .discord_api import DiscordError, escape
from .discord_chat import PREFIX as DISCORD_PREFIX, RESUME, STOP
from .engines import Engine
from .ledger import Ledger, LedgerBusy, LedgerFenced, iso
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
                    self._refuse_tap(h, str(e) or self.FENCED, restore_staged=True)
                else:
                    h.finish("refused", str(e) or self.FENCED, restore_staged=True)
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
                   "went through. It's kept: when Harness next starts it reads your calendar for it first and "
                   "tells you what it finds, and nothing is done twice.")

    def _unknown_tap(self, h, why: str) -> None:
        """Seventeenth round: an exception after the tap's execution intent was written. Its outcome is unknown, so
        nothing is recorded as its outcome: it isn't refused and isn't struck off, its intent stays in the journal,
        and the next start reads the calendar for its effect by its identity before anything is done with it
        (_replay_taps). He's told once, plainly, on the tap."""
        log.error("a tap was interrupted after its intent was written (%s): its outcome is unknown and it is kept",
                  why)
        h.finish("error", self.TAP_UNKNOWN, outcome="unknown")
        if self.handovers is not None:
            self.handovers.tell(h, self.TAP_UNKNOWN)

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
        if getattr(self, "_taps_replayed", False) or self.handovers is None:
            return
        self._taps_replayed = True
        queued = self.handovers.queued_keys()
        boundary = bool(getattr(self, "restored_at_start", False))
        try:
            stalled = bool(migrate.clock_stall(self.ledger))
        except Exception:                       # noqa: BLE001: an unreadable clock check counts as a stall
            stalled = True
        late, relist, unsure, clock_tap = [], [], [], False
        for row in self.handovers.journaled():
            p = row["press"]
            if self.handovers.key(p) in queued:
                continue
            if row["state"] in ("refused", "found"):
                self._post_pending_notice(row)
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
                # is read for its effect by its identity first, and he gets its card (_relist_taps).
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
            self._relist_taps(relist)
        if unsure and self.config is not None:
            self._relist_taps(unsure, restored=False)
        if late and self.config is not None:
            with self.ledger.tx() as db:
                self.ledger.enqueue(chat_id=self.config.owner_user_id, kind="notice", db=db, text=(
                    f"Harness stopped before it took {'a tap' if len(late) == 1 else f'{len(late)} taps'} of yours, "
                    "so nothing changed from "
                    f"{'it' if len(late) == 1 else 'them'}."
                    + (" The clock card follows again." if clock_tap else " A card still works until it runs out.")))
                self.ledger.event("taps_not_taken", {"count": len(late), "clock_stalled": stalled}, db=db)
            for p in late:
                self.handovers.journal_done(p)
            if clock_tap:
                # Sixteenth round: the clock card's own tap can't be aged while the clock is flagged, so the card
                # is issued again rather than left dead.
                migrate.post_clock_card(self.ledger, self.config.owner_user_id, force=True)

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

    # Seventeenth round: the choice kinds whose tap leads to a calendar write. Each either carries a readable identity
    # in its intent (CHOICE_IDENTITY) or its re-confirm card offers no Go ahead once it may have been carried out.
    CHOICE_WRITES = frozenset({"calendar_change_add_anyway", "calendar_change_undo", "family_add_undo",
                               "calendar_change_step_start", "calendar_change_smoke_clear",
                               "calendar_change_conform_again", "mail_dates_undo", "mail_dates_family"})
    CHOICE_IDENTITY = frozenset({"calendar_change_add_anyway", "calendar_change_undo", "family_add_undo"})

    def _tap_op(self, p: dict) -> dict:
        """What the tap leads to on a calendar, named by a stable identity read from the records before it's acted
        on: an Approve on a calendar change (its proposal, its changes and the key each add's fixed event id is
        made from) or on a Family add (its proposal: the event's id comes from it). Seventeenth round, the choice
        kinds that write a calendar: Add anyway (its adds and the keys of their fixed ids), Undo and the Family
        Undo (each event's id and the state it must read in afterwards); any other such kind is
        {"effect": "calendar", "kind", "choice": True}, which has no Go ahead once it may have run.
        {"effect": "records"} for a tap that changes only Harness's own records; {"effect": "calendar", "kind"} for
        an Approve that may reach a calendar but carries no identity to check."""
        cid = str((p or {}).get("custom_id") or "")
        data = cid[len(DISCORD_PREFIX):] if cid.startswith(DISCORD_PREFIX) else ""
        try:
            nonce = choices.parse(data)
            if nonce is not None:
                row = self.ledger.db.execute("SELECT kind, target FROM choices WHERE nonce=?", (nonce,)).fetchone()
                kind, target = (row["kind"], row["target"]) if row is not None else ("", "")
                if kind not in self.CHOICE_WRITES:
                    return {"effect": "records", "kind": kind}
                op = None
                if kind == "calendar_change_add_anyway" and self.calendar_change is not None:
                    op = self.calendar_change.add_anyway_op(target)
                elif kind == "calendar_change_undo" and self.calendar_change is not None:
                    op = self.calendar_change.undo_op(target)
                elif kind == "family_add_undo" and self.family_add is not None:
                    op = self.family_add.undo_op(target)
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
        "removed" (it landed and has since been taken off: nothing is done again), "mixed" (some parts are there,
        others aren't), "not_done" (a read answered and it isn't there), "unread" (a read couldn't tell),
        "unchecked" (an Approve that carries no identity to read by), "no_identity" (a choice tap that writes a
        calendar with no identity to read by: no Go ahead) or "records" (it changes only Harness's own records)."""
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

    RELIST_MAX = 10
    TAP_STATE_WORDS = {"committed": "carried out before the records were put back",
                       "unknown": "Harness can't tell whether it was carried out",
                       "not_started": "not carried out",
                       "found": "already on your calendar"}
    NO_GO_AHEAD = ("no_identity", "removed", "records_own")

    def _relist_taps(self, rows: list[dict], *, restored: bool = True) -> None:
        """Fifteenth round: the records were put back from a backup at this start, so no tap written down before it
        is taken by itself. Sixteenth round, truthfully: each tap's recorded state (carried out before the records
        were put back; outcome unknown; not carried out) and, for one that reaches a calendar, a read of the
        calendar by the effect's own identity first: one the calendar already shows is marked done and gets no
        button. The rest are sorted by tap time; the newest RELIST_MAX get a card, and every older one is listed
        in a second message by its time and state (counts by state in the first), so none is out of reach.
        Seventeenth round: the first message points at the cards below it (a card has Go ahead only where it's
        safe: never for a change since taken off the calendar, nor for a choice tap with no identity to read once
        it may have run); a tap whose time can't be read sorts as newest and always gets a card, marked "time
        unknown". restored=False: the taps a stop or an error left with their outcome unknown, at a start that
        put nothing back."""
        owner, tz = self.config.owner_user_id, ZoneInfo(self.config.timezone)

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
        for row in sorted(rows, key=stamp, reverse=True):
            seen, parts = "unchecked", []
            if row["state"] in ("committed", "unknown"):
                seen, parts = self._tap_read(row.get("op") or {})
            if not restored and seen != "done" and self._tap_ingested(row["press"]):
                # Not put back: the records in use took this tap before the stop or the error, so they finish or
                # settle what it started by their own reads; a Go ahead here could only be refused or act twice.
                seen = "records_own"
            if seen == "done":
                if not self.handovers.journal_outcome(row["press"], "found"):
                    log.error("a tap's outcome couldn't be written to the tap journal")
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
        if found:
            said.append(f"{len(found)} {self.TAP_STATE_WORDS['found']}, so nothing is left to do for "
                        f"{'it' if len(found) == 1 else 'them'}")
        if said:
            parts.append("Of " + ("it" if n == 1 else "them") + ": " + "; ".join(said) + ".")
        if shown:
            parts.append(("The newest one is on the card below" if len(shown) == 1
                          else f"The newest {len(shown)} are on the cards below")
                         + ", each saying what Harness found."
                         + (f" The other {len(rest)} are listed after them by time and state." if rest else ""))
        with self.ledger.tx() as db:
            self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(" ".join(parts)))
            for row, seen, tparts in shown:
                p = row["press"]
                text = self._relist_words(row["state"], seen, tparts, restored=restored)
                stamp_words = when(row)
                head = (f"A tap of yours from {render.escape(stamp_words)}." if stamp_words
                        else "A tap of yours (time unknown).")
                if row["state"] != "not_started" and seen in self.NO_GO_AHEAD:
                    self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(f"{head} {text}"))
                    continue
                nonce = choices.mint(self.ledger, kind="tap_reconfirm", chat_id=owner, ttl_s=self.TAP_RELIST_TTL_S,
                                     target=json.dumps({"id": p.get("id", ""), "custom_id": p.get("custom_id", ""),
                                                        "message_id": p.get("message_id", ""),
                                                        "op": row.get("op") or {}}), db=db)
                self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(f"{head} {text}"),
                                    buttons=[[("Go ahead", choices.callback_data(nonce))]],
                                    binds=[{"type": "choice", "nonce": nonce}])
            if rest:
                lines = [f"• {render.escape(when(r))}: {self.TAP_STATE_WORDS[r['state']]}" for r, _, _ in reversed(rest)]
                self.ledger.enqueue(chat_id=owner, kind="notice", db=db, text=render.fit(
                    ("<b>Older taps from before the records were put back</b>, not taken by themselves:\n"
                     if restored else "<b>Older taps</b>, not taken again by themselves:\n")
                    + "\n".join(lines)))
            self.ledger.event("taps_relisted", {"count": n, "shown": len(shown), "listed": len(rest),
                                                "found": len(found), "restored": restored, **counts}, db=db)
        for row in rows:
            self.handovers.journal_done(row["press"])

    @staticmethod
    def _relist_words(state: str, seen: str, parts: list | None = None, *, restored: bool = True) -> str:
        if state == "not_started":
            return "It wasn't carried out. Go ahead does it now."
        if restored:
            first = ("It was carried out on the records before they were put back" if state == "committed"
                     else "Harness can't tell whether it was carried out before the records were put back")
        else:
            first = "Harness can't tell whether it was carried out"
        if seen == "removed":
            return (f"{first}. It was on your calendar and has since been taken off, so it isn't done again and "
                    "there's no Go ahead.")
        if seen == "records_own":
            return (f"{first}. Harness's records took it before that, so they finish or settle it themselves by "
                    "reading your calendar, and nothing is done twice.")
        if seen == "no_identity":
            return (f"{first}, and this kind of tap leaves nothing Harness can read on your calendar to tell, so it "
                    "isn't offered again here.")
        if seen == "mixed":
            words = {"done": "on your calendar", "removed": "on your calendar before, since taken off",
                     "not_done": "not on your calendar", "unread": "couldn't be read just now",
                     "unchecked": "can't be read on your calendar"}
            each = "; ".join(f"{render.escape(name)}: {words.get(v, v)}" for name, v in (parts or []))
            return (f"{first}. Part of it is on your calendar ({each}). Go ahead does only the parts that "
                    "aren't there.")
        if seen == "not_done":
            return f"{first}, and your calendar doesn't show it now. Go ahead does it now."
        if seen == "unread":
            return (f"{first}, and your calendar couldn't be read just now. Go ahead reads it again and does it "
                    "only if it isn't there.")
        if seen == "unchecked":
            return f"{first}, and this kind of tap leaves nothing Harness can read on your calendar. Go ahead does it now."
        return f"{first}; the records in use now don't have it. Go ahead does it now."

    TAP_RELIST_TTL_S = 24 * 3600

    def _reconfirm_tap(self, target: str) -> str:
        """His Go ahead on a relisted tap (fifteenth round): the tap he made before the restore, taken now on the
        records in use, through the same checks as any tap (that card, once, before it expires). Sixteenth round:
        never blindly. A tap that reaches a calendar is read there first by its effect's identity: one the calendar
        shows is done, nothing written; otherwise it goes through the normal checks, and the write itself reads
        its fixed event id or its version before it writes, so nothing is made twice. Seventeenth round: one since
        taken off the calendar, or a choice tap with no identity to read, is never run again here; a change part of
        which is there runs only the parts that aren't (CalendarChange.skip_found)."""
        try:
            t = json.loads(target or "{}")
            cid = str(t.get("custom_id") or "")
            mid = int(t.get("message_id") or 0)
            op = t.get("op") if isinstance(t.get("op"), dict) else {}
        except (ValueError, TypeError, AttributeError):
            return "That can't be read, so nothing changed."
        if not cid.startswith(DISCORD_PREFIX):
            return "That can't be read, so nothing changed."
        seen, parts = self._tap_read(op)
        if seen == "done":
            with self.ledger.tx() as db:
                self.ledger.event("tap_reconfirm_found", {}, db=db)
            return "That's on your calendar already, so nothing was done again."
        if seen == "removed":
            return "That was on your calendar and has since been taken off, so nothing was done again."
        if seen == "no_identity":
            return "Harness can't read that kind of tap on your calendar, so nothing was done again."
        if seen == "mixed" and op.get("proposal") and self.calendar_change is not None:
            self.calendar_change.skip_found(str(op["proposal"]), [i for i, (_, v) in enumerate(parts)
                                                                  if v in ("done", "removed")])
        if cid in (STOP, RESUME):
            return render.escape(self.commands._stop("") if cid == STOP else self.commands._resume(""))
        inc = Incoming(update_id=-int(time.time() * 1000), kind="callback", user_id=self.config.owner_user_id,
                       chat_id=self.config.owner_user_id, chat_type="private", message_id=mid, callback_id="",
                       callback_data=cid[len(DISCORD_PREFIX):])
        got = self.callbacks.handle(inc)
        if got == "ok" or got == "stopped":
            return ""
        return render.escape(callbacks.REFUSALS.get(got, "Not valid.")) + " Nothing changed."

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
            h.finish("error", f"The specialist couldn't read the DM ({e.code}). Nothing changed.")
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
        in_place = job["state"] == "needs_clarification" or (
            job["state"] in ("no_action", "answered") and self._answered_to_cain(job_id))
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
            d = daily.gather(self.ledger, cfg, paused=paused, notes=list(self.notes.values()),
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
            if daily.deliver(self.ledger, cfg, d, hold=self._discord_mode()):
                if self.inputs is not None:
                    try:                               # what it named is known to him now
                        self.inputs.digest_sent(d.named)
                    except Exception as e:             # never at the cost of the receipts
                        log.warning("input watch: after the digest: %s", type(e).__name__)
                if self.meaning_live:
                    self.meaning_live.send_receipts()  # each new block's card, with Undo

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
