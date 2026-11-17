"""Entry point: `python3 -m harness` inside the add-on container.

Before anything else it removes credentials it was never meant to use
from its own environment. Supervisor injects SUPERVISOR_TOKEN into every
add-on, even one declared with hassio_api: false, and that token can still
reach /addons/self (its own options, even uninstalling itself). Nothing
in the harness needs it, so no library and no bug can use it either.
"""
from __future__ import annotations

import logging
import os
import queue
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import caldav, drive, family, family_rules, google_cal, meaning, meaning_live, policy
from .calendar_change import CalendarChange, changes_from_options
from .calendar_feed import CalendarFeeds
from .config import Config
from .controller import Controller
from .discord_api import DiscordAPI, DiscordTransport
from .cain_relay import CainLink
from .discord_chat import LinkChat
from .discord_keeper import DiscordKeeper, KeeperStore
from . import commands, handover, inputs, scrub, watch
from .engines import AnthropicEngine, OpenAIEngine
from .family_add import FamilyAdd
from .family_copy import AHEAD_DAYS, FamilyCopy, name_from_options
from .family_gmail import FamilyGmail, home_from_options, rules_from_options, school_address_from_options, school_from_options
from .ledger import Ledger, TransactionAborted
from .mail_dates import MailDates, option_on as mail_option_on
from .mirror_shadow import read_days
from .net import CalDavTransport, GoogleTransport, MapTransport, UrllibTransport
from .setup_web import SetupApp, serve
from .vault import Vault

SCRUB = ("SUPERVISOR_TOKEN", "HASSIO_TOKEN")
STAGE = "S1"


def scrub_environment() -> None:
    for k in SCRUB:
        os.environ.pop(k, None)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(scrub.ScrubFilter())    # twenty-sixth round: net's redaction and the shared scrub
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)


def build(data_dir: str, *, port: int = 8099, family_port: int = family.FAMILY_PORT):
    vault = Vault(os.path.join(data_dir, "secrets.json"))
    # Twelfth round: a restore he tapped (migrate.stage_restore) is swapped in before the ledger opens.
    # Thirteenth round: the specialist holds its lock file first (the restore command line refuses while it's
    # held), and all swapping is done here, before the ledger opens.
    from . import migrate
    path = os.path.join(data_dir, "harness.sqlite")
    # Thirtieth round: the tap journal's lock and fsynced renames hold only on local storage, so a journal folder on
    # a network mount is refused at the start (degraded: every tap refused, the status page says why).
    handover.check_local(path + handover.TAP_JOURNAL)
    # Fourteenth round: the lock is taken before any marker is read, waiting while the restore command line
    # stages (it holds the same lock); a swap that can't finish safely starts degraded rather than open the
    # records beside a log that isn't theirs.
    if not migrate.hold_process_lock(path, wait_s=migrate.LOCK_WAIT_S):
        # Fifteenth round: a staging slower than LOCK_WAIT_S: degraded for now, and the lock is tried again on a
        # timer (degraded(lock_wait=True)); the start goes on by itself once the staging has finished.
        raise migrate.LockBusy("another process holds harness.lock beside the records (a restore being staged)")
    swapped: dict = {}
    try:
        swapped = migrate.apply_staged_restore(path) or {}
    except migrate.SwapRefused:
        raise
    except OSError as e:
        logging.getLogger("harness").error("the staged restore couldn't be swapped in: %s", type(e).__name__)
        if os.path.exists(path + migrate.SWAP_MARKER):
            raise migrate.SwapRefused(f"a restore swap couldn't finish ({type(e).__name__})") from e
    ledger = Ledger(path)
    transport = UrllibTransport()
    # Discord, through Cain: cards go to Cain's link, which shows them when Cain says;
    # taps come back to /press. The bot token reads his DM when Cain hands a request over.
    discord_token = lambda: vault.get("discord_bot_token")          # noqa: E731
    chat = LinkChat(CainLink(discord_token), paused=lambda: commands.is_paused(ledger))
    engines = {
        "claude": AnthropicEngine(policy.MODELS["claude"],
                                  lambda: vault.get("anthropic_api_key"), transport,
                                  effort=policy.EFFORT["claude"]),
        "gpt": OpenAIEngine(policy.MODELS["gpt"], lambda: vault.get("openai_api_key"),
                            transport, effort=policy.EFFORT["gpt"]),
    }
    # The same pinned Sonnet for judging Family events (meaning.py), at its own effort.
    judge_engine = AnthropicEngine(policy.MODELS[policy.engine_for(meaning.PURPOSE)],
                                   lambda: vault.get("anthropic_api_key"), transport,
                                   effort=policy.MEANING_EFFORT)
    status: dict = {}
    requests: queue.Queue = queue.Queue()
    # owner_user_id is a placeholder until pairing binds the real one.
    base = Config(owner_user_id=1, stage=STAGE)
    inbox = family.FamilyInbox(os.path.join(data_dir, "family.json"), ledger.now,
                               entity=base.family_entity or "calendar.family")
    web = serve(SetupApp(vault, status, requests,
                         family=inbox if base.family_entity else None), port=port)
    executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="worker")
    # Copies to Family and blocks on Gmail need the feeds read well ahead; the
    # settings that decide it are read on every run.
    calendar = CalendarFeeds(ledger, transport, executor,
                             lambda: vault.get("calendar_feeds"), base.timezone,
                             ahead_days=max(read_days(None), AHEAD_DAYS),
                             ahead_when=lambda: bool(name_from_options(data_dir)
                                                     or school_from_options(data_dir)
                                                     or family_rules.load(ledger)
                                                     or meaning.option_on(data_dir)
                                                     or meaning_live.live_on(data_dir)),
                             ahead_from=lambda address, start, until: (
                                 google.window(address, start, until) if google.configured() else None))
    listener = family.serve(inbox, port=family_port) if base.family_entity else None
    # What iCloud and Google answer, from any thread, for the watch on inputs (inputs.py).
    seen = inputs.Seen()
    client = caldav.FamilyCalDav(
        CalDavTransport(lambda: caldav.host_of(vault.get("family_calendar_url"))),
        lambda: (vault.get("family_apple_id"), vault.get("family_app_password"),
                 vault.get("family_calendar_url")), seen=seen)
    adds = FamilyAdd(ledger, client, tz=base.timezone, policy_version=base.policy_version,
                     model=policy.MODELS[policy.engine_for("message")].model,
                     creds_stamp=vault.family_stamp)
    google = google_cal.GoogleCalendar(GoogleTransport(google_cal.HOSTS),
                                       lambda: vault.get("google_service_key"), ledger.now, seen=seen)
    # Judges Family events (meaning.py): in shadow it only scores; with meaning_live on, its
    # judgments decide the Gmail blocks (meaning_live.py) and the old title rules stand aside.
    judging = meaning.MeaningShadow(
        ledger, client, calendar, ThreadPoolExecutor(max_workers=1, thread_name_prefix="meaning"),
        engine_fn=lambda: judge_engine,
        on_fn=lambda: meaning.option_on(data_dir) or meaning_live.live_on(data_dir),
        tz=base.timezone, rules_fn=lambda: rules_from_options(data_dir),
        school_fn=lambda: school_from_options(data_dir),
        said_fn=lambda: family_rules.load(ledger),
        name_fn=lambda: name_from_options(data_dir),
        budget_ok=lambda provider: controller._budget_ok(provider))
    live = meaning_live.MeaningLive(ledger, judging, calendar, tz=base.timezone,
                                    on_fn=lambda: meaning_live.live_on(data_dir),
                                    name_fn=lambda: name_from_options(data_dir))
    family_gmail = FamilyGmail(ledger, adds, calendar, google,
                               rules_fn=lambda: rules_from_options(data_dir),
                               school_fn=lambda: school_from_options(data_dir),
                               said_fn=lambda: family_rules.load(ledger),
                               drives=drive.Drives(ledger, MapTransport(drive.HOSTS),
                                                   lambda: school_address_from_options(data_dir),
                                                   home_fn=lambda: home_from_options(data_dir)),
                               tz=base.timezone, live=live,
                               live_fn=lambda: meaning_live.live_on(data_dir))
    controller = Controller(ledger=ledger, vault=vault, api=chat, engines=engines,
                            executor=executor, base_config=base, status_box=status,
                            requests=requests, calendar=calendar,
                            family=inbox if base.family_entity else None, mirror=None,   # retired: the work holds script does it
                            family_add=adds,
                            family_copy=FamilyCopy(ledger, adds, calendar, tz=base.timezone,
                                                   name_fn=lambda: name_from_options(data_dir)),
                            family_gmail=family_gmail,
                            calendar_change=CalendarChange(
                                ledger, client, google,
                                enabled=lambda: changes_from_options(data_dir),
                                address=family_gmail._address, tz=base.timezone),
                            mail_dates=MailDates(
                                ledger, google, executor, address=family_gmail._address,
                                password=lambda: "".join((vault.get("gmail_app_password") or "").split()),
                                engine_fn=lambda: engines.get(policy.engine_for("message")),
                                writes_on=lambda: mail_option_on(data_dir), tz=base.timezone,
                                family=client,
                                budget_ok=lambda provider: controller._budget_ok(provider)),
                            meaning=judging, meaning_live=live)
    # An input that stops is told: what only he can fix at once, anything else after six hours,
    # and the digest names each one down. Only what's set up is watched: mail once its password is
    # in (whatever the feeds say today), and the sorting of Family events only when its judgments
    # decide his blocks (meaning_live), since in shadow it costs him nothing.
    controller.inputs = inputs.Watch(ledger, seen, tz=base.timezone, active={
        inputs.MAIL: lambda: bool(controller.mail_dates.password()),
        inputs.FAMILY: client.configured,
        inputs.GOOGLE: google.configured,
        inputs.MEANING: lambda: meaning_live.live_on(data_dir),
    }, feeds=calendar.inputs, account=google.account)
    google.mine = family_gmail._address         # what Google says about his calendar, not another's
    store = KeeperStore(os.path.join(data_dir, "discord.json"))
    keeper = DiscordKeeper(DiscordAPI(discord_token, DiscordTransport()), store.get, store.set)
    controller.discord = keeper
    controller.discord_chat = chat
    # The mutual watch on Cain's add-on: told once if it's down 5 minutes, once when back.
    controller.cain_watch = watch.PeerWatch(store.get, store.set)
    # Cain hands calendar requests over here, keyed by the bot token both hold.
    # Fourteenth round: taps are written to a journal beside the ledger before Cain's link hears they're taken,
    # and answered at once (not queued) while a restore is staged.
    controller.handovers = handover.Inbox(discord_token, wake=keeper.wake, journal=path + handover.TAP_JOURNAL,
                                          staged=lambda: migrate.restore_staged(path),
                                          answer=chat.answer_callback)
    # Fifteenth round: across a restore (swapped in at this start, or staged at it) no tap written down before is
    # taken by itself; they're listed for him instead (Controller._replay_taps).
    controller.restored_at_start = bool(swapped.get("ok")) or migrate.restore_staged(path)
    try:
        handover.serve(controller.handovers,
                       port=int(os.environ.get("HARNESS_HANDOVER_PORT", handover.PORT)))
    except OSError as e:
        # Everything else still works; he hears about it in the digest and on the page.
        logging.getLogger("harness").error("handover: can't listen: %s", e)
        controller.notes["handover"] = "Cain can't hand requests to the keeper: its port is taken"
    return controller, web, listener


LOCK_RETRY_S = 5            # fifteenth round: how often a start waiting on a restore being staged tries the lock again
NOTE_RETRY_S = 60           # fifteenth round: the degraded note's first wait before it's tried again
NOTE_RETRY_MAX_S = 30 * 60  # sixteenth round: the wait doubles after each failed try, up to this
NOTE_TRIES = 10             # sixteenth round: then the page says "note not delivered" and it stops trying


def degraded(data_dir: str, port: int, why: str, *, lock_wait: bool = False, files: list | None = None,
             handover_port: int | None = None, marker_unwritten: str = ""):
    """Thirteenth round: when the records can't be opened at all, the specialist still serves its status page and
    Cain's health check (status "degraded", with why), so it's seen and said, and waits to be stopped. A restore
    staged by the command line (with the App stopped) or from a Home Assistant backup is the way back.

    Fifteenth round: a tap is refused at once and he hears it through the link's answer route (never silent); one
    best-effort note goes to him through Cain's link, tried again until it goes; the files beside the records are
    listed on the page when a swap can't be sorted by itself. With lock_wait (a restore being staged took longer
    than LOCK_WAIT_S) the lock is tried again every LOCK_RETRY_S and "retry" is returned once it's free: main then
    starts normally. Otherwise the exit code once stopped."""
    log = logging.getLogger("harness")
    # Fourteenth round: nothing here touches the records, so the lock is let go: a restore can be staged from the
    # command line (python3 -m harness.migrate <records> --restore <schema> <build>) without stopping the App,
    # and the next start swaps it in.
    from . import migrate
    path = os.path.join(data_dir, "harness.sqlite")
    migrate.release_process_lock(path)
    vault = Vault(os.path.join(data_dir, "secrets.json"))
    token = lambda: vault.get("discord_bot_token")          # noqa: E731
    mig = {"degraded": True, "why": why}
    if lock_wait:
        from datetime import datetime, timezone
        mig.update({"lock_wait": True, "lock_wait_since": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "lock_retry_s": LOCK_RETRY_S})
    if files:
        mig["files"] = list(files)
    if marker_unwritten:
        # Sixteenth round: the swap's refusal couldn't be written into its marker; the page says so.
        mig["marker_unwritten"] = marker_unwritten
    mig["note"] = "trying"
    status: dict = {"notes": [f"Harness started degraded: {why}. Calendar work is off until it starts normally."],
                    "migration": mig}
    web = serve(SetupApp(vault, status, queue.Queue()), port=port)
    chat = LinkChat(CainLink(token))
    inbox = handover.Inbox(token, journal="", refusing=why, answer=chat.answer_callback)   # refuses every tap: none is written down
    inbox.migration = dict(mig)
    inbox.degraded = why
    srv = None
    try:
        srv = handover.serve(inbox, port=int(handover_port if handover_port is not None
                                             else os.environ.get("HARNESS_HANDOVER_PORT", handover.PORT)))
    except OSError as e:
        log.error("handover: can't listen: %s", e)
    stop_now = []
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, lambda *_: stop_now.append(1))
        signal.signal(signal.SIGINT, lambda *_: stop_now.append(1))
    note = ("Harness started without its records, so calendar work is off until it starts normally: "
            f"{why}. Its status page in Home Assistant says what's beside the records.")
    if lock_wait:
        note = ("Harness is waiting for a restore being staged beside its records before it starts; calendar work "
                "is off until then and it starts by itself once the staging is done.")
    note_tries, note_due, lock_at = 0, time.monotonic(), time.monotonic()
    out: int | str = 1
    while not stop_now:
        now = time.monotonic()
        if mig["note"] == "trying" and now >= note_due:
            note_tries += 1
            try:
                chat.send_message(0, note, kind="notice")       # best effort: Cain's link may be down too
                mig["note"] = "delivered"
            except Exception as e:                              # noqa: BLE001
                if note_tries >= NOTE_TRIES:
                    mig["note"] = "not delivered"
                    log.error("the degraded note couldn't be posted after %d tries (%s)", note_tries,
                              type(e).__name__)
                else:
                    wait = min(NOTE_RETRY_MAX_S, NOTE_RETRY_S * 2 ** (note_tries - 1))
                    note_due = now + wait
                    log.info("the degraded note couldn't be posted (%s); tried again in %.0fs", type(e).__name__, wait)
            mig["note_tries"] = note_tries
            status["migration"] = mig
            inbox.migration = dict(mig)
        if lock_wait and now - lock_at >= LOCK_RETRY_S:
            lock_at = now
            if migrate.hold_process_lock(path, wait_s=0):
                log.warning("the restore being staged has finished: starting normally")
                out = "retry"
                break
        for h in inbox.take():
            h.finish("refused", f"Not taken: Harness started degraded ({why}). Nothing changed.")
        time.sleep(1)
    web.shutdown()
    if srv is not None and hasattr(srv, "server_close"):
        srv.shutdown()
        srv.server_close()
    if hasattr(web, "server_close"):
        web.server_close()
    return out


class Stop(Exception):
    """Raised from the signal handler so a blocking wait is interrupted at
    once, not after its timeout: Home Assistant gives an add-on a limited
    time to stop before it kills it."""


def main() -> int:
    scrub_environment()
    os.umask(0o077)            # the ledger holds his words: owner-only files
    configure_logging()
    log = logging.getLogger("harness")
    data_dir = os.environ.get("HARNESS_DATA", "/data")
    port = int(os.environ.get("HARNESS_PORT", "8099"))
    while True:
        try:
            controller, web, listener = build(data_dir, port=port)
            break
        except Exception as e:                 # noqa: BLE001: thirteenth round, never a start that can't recover
            log.error("the specialist couldn't start (%s): serving the status page and health only", type(e).__name__)
            from . import migrate
            why = (f"the records weren't opened: {scrub.scrub(e)}" if isinstance(e, migrate.SwapRefused)
                   else "the tap journal must be on local storage, and its folder is a network mount"
                   if isinstance(e, handover.NetworkJournal)
                   else f"the records couldn't be opened ({type(e).__name__})")
            got = degraded(data_dir, port, why, lock_wait=isinstance(e, migrate.LockBusy),
                           files=getattr(e, "files", None), marker_unwritten=getattr(e, "marker_unwritten", ""))
            if got != "retry":                 # fifteenth round: the lock came free, so the start goes on
                return got

    def stop(*_):
        raise Stop()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    log.info("harness starting (stage %s, policy %s)", STAGE, policy.POLICY_VERSION)
    started = False
    failures = 0
    try:
        while True:
            try:
                if not started:
                    controller.startup()
                    started = True
                controller.tick()
                failures = 0
            except Stop:
                raise
            except (Exception, TransactionAborted) as e:   # never die quietly; never spin
                failures += 1
                log.error("tick failed (%d in a row): %s: %s", failures, type(e).__name__, e)
                time.sleep(min(60, 2 ** min(failures, 6)))
    except Stop:
        pass
    log.info("harness stopping")
    try:
        controller.drain_on_stop()             # fourteenth round: nothing queued is dropped silently
    except Exception as e:                     # noqa: BLE001: stopping goes on
        log.error("the queue couldn't be drained as it stopped: %s", type(e).__name__)
    web.shutdown()
    if listener is not None:
        listener.shutdown()
    controller.executor.shutdown(wait=False, cancel_futures=True)
    if controller.meaning is not None:
        controller.meaning.executor.shutdown(wait=False, cancel_futures=True)
    # Home Assistant's cold backup stops the add-on before copying /data;
    # closing here leaves a single consistent database file behind.
    controller.ledger.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
