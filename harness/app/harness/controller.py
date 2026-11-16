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
import time
from concurrent.futures import Executor
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

from . import (callbacks, choices, commands, daily, effects, ingress_filter, integrity, migrate,
               policy, provenance, render, rules, watch)
from .chat import Decision, Incoming
from .config import Config
from .discord_api import DiscordError, escape
from .discord_chat import PREFIX as DISCORD_PREFIX, RESUME, STOP
from .engines import Engine
from .ledger import Ledger, iso
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
        swept = migrate.run(self.ledger, self.calendar_change, self.config.owner_user_id)
        if swept:
            log.info("ledger migrated: %s", swept)
        self.runner.reconcile_after_restart()
        if self.family_add is not None:
            self.family_add.reconcile_after_restart()
        if self.calendar_change is not None:
            self.calendar_change.reconcile_after_restart()
        self._clarify_timeouts(restart=True)

    # -- the loop --------------------------------------------------------------
    def _beat(self) -> None:
        """Cain's watch asks whether this loop turns (handover /health). Beaten at the
        start of each tick, between its phases and around the long calls."""
        if self.handovers is not None:
            self.handovers.beat()

    def tick(self) -> None:
        self._beat()
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
        for h in (self.handovers.take() if self.handovers is not None else []):
            {"press": self._press, "digest": self._cain_digest,
             "morning-posted": self._morning_posted,
             "meanings": self._meanings, "places": self._places,
             "fastpath": self._fastpath}.get(h.kind, self._handover)(h)
        self._beat()
        self._release_digest()
        self._link_health()
        self._beat()
        self._work()
        self._beat()
        self._finish_handovers()
        self._wait(0.3 if (self._busy() or self._handover_jobs) else 3)

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
        h.finish("ok")
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
        under an id issued here; each change approved after it is recorded under that id. "on" names
        the run: its checklist is built here from this ledger alone (event ids, request and read-back
        times, the refusals for an older version, the listing lag), anything with no evidence is
        refused by name and nothing changes, and anything Cain sends as passed is ignored. A full one
        goes to him on a card with Turn on and Keep cards; only his Turn on tap turns on the no-card
        paths. "off" turns them off at once. Until his tap, every calendar change comes on a card."""
        from .calendar_change import fast_path, set_fast_path
        cc = self.calendar_change
        if h.state in ("smoke-start", "on") and cc is None:
            h.finish("off", "Calendar changes aren't set up in the calendar specialist.")
            return
        if h.state == "smoke-start":
            run = cc.smoke_start()
            log.info("a smoke run started")
            h.finish("ok", f"Smoke run {run['id']} started. Run its checklist through the normal card path, each "
                           f"change on its card and tapped, then send keeper.sh fastpath on {run['id']}.", run=run["id"])
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
            set_fast_path(self.ledger, False, fast_path(self.ledger).get("smoke", ""), by="cain")
            log.info("the no-card path is off")
            h.finish("ok", "Off: every calendar change comes on a card.")
            return
        now = fast_path(self.ledger)
        h.finish("unknown", "Say smoke-start, on <run id> or off. It's " + ("on" if now.get("on") else "off (card only)")
                 + " now.")

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
