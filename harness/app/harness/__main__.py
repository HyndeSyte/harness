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
import time
from concurrent.futures import ThreadPoolExecutor

from . import caldav, drive, family, family_rules, google_cal, meaning, policy
from .calendar_change import CalendarChange, changes_from_options
from .calendar_feed import CalendarFeeds
from .config import Config
from .controller import Controller
from .discord_api import DiscordAPI, DiscordTransport
from .cain_relay import CainLink
from .discord_chat import LinkChat
from .discord_keeper import DiscordKeeper, KeeperStore
from . import commands, handover
from .engines import AnthropicEngine, OpenAIEngine
from .family_add import FamilyAdd
from .family_copy import AHEAD_DAYS, FamilyCopy, name_from_options
from .family_gmail import FamilyGmail, rules_from_options, school_address_from_options, school_from_options
from .ledger import Ledger
from .mail_dates import MailDates, option_on as mail_option_on
from .mirror_shadow import read_days
from .net import CalDavTransport, GoogleTransport, MapTransport, RedactingFilter, UrllibTransport
from .setup_web import SetupApp, serve
from .telegram_api import TelegramBotAPI
from .vault import Vault

SCRUB = ("SUPERVISOR_TOKEN", "HASSIO_TOKEN")
STAGE = "S1"


def scrub_environment() -> None:
    for k in SCRUB:
        os.environ.pop(k, None)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RedactingFilter())
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)


def build(data_dir: str, *, port: int = 8099, family_port: int = family.FAMILY_PORT):
    vault = Vault(os.path.join(data_dir, "secrets.json"))
    ledger = Ledger(os.path.join(data_dir, "harness.sqlite"))
    transport = UrllibTransport()
    api = TelegramBotAPI(lambda: vault.get("telegram_bot_token"), transport)
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
                                                     or meaning.option_on(data_dir)),
                             ahead_from=lambda address, start, until: (
                                 google.window(address, start, until) if google.configured() else None))
    listener = family.serve(inbox, port=family_port) if base.family_entity else None
    client = caldav.FamilyCalDav(
        CalDavTransport(lambda: caldav.host_of(vault.get("family_calendar_url"))),
        lambda: (vault.get("family_apple_id"), vault.get("family_app_password"),
                 vault.get("family_calendar_url")))
    adds = FamilyAdd(ledger, client, tz=base.timezone, policy_version=base.policy_version,
                     model=policy.MODELS[policy.engine_for("message")].model,
                     creds_stamp=vault.family_stamp)
    google = google_cal.GoogleCalendar(GoogleTransport(google_cal.HOSTS),
                                       lambda: vault.get("google_service_key"), ledger.now)
    family_gmail = FamilyGmail(ledger, adds, calendar, google,
                               rules_fn=lambda: rules_from_options(data_dir),
                               school_fn=lambda: school_from_options(data_dir),
                               said_fn=lambda: family_rules.load(ledger),
                               drives=drive.Drives(ledger, MapTransport(drive.HOSTS),
                                                   lambda: school_address_from_options(data_dir)),
                               tz=base.timezone)
    controller = Controller(ledger=ledger, vault=vault, api=api, engines=engines,
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
                            # Shadow only: judges Family events and scores them; writes no calendar.
                            meaning=meaning.MeaningShadow(
                                ledger, client, calendar,
                                ThreadPoolExecutor(max_workers=1, thread_name_prefix="meaning"),
                                engine_fn=lambda: judge_engine, on_fn=lambda: meaning.option_on(data_dir),
                                tz=base.timezone, rules_fn=lambda: rules_from_options(data_dir),
                                school_fn=lambda: school_from_options(data_dir),
                                said_fn=lambda: family_rules.load(ledger),
                                name_fn=lambda: name_from_options(data_dir),
                                budget_ok=lambda provider: controller._budget_ok(provider)))
    # Discord, through Cain: cards go to Cain's link, which shows them when Cain says;
    # taps come back to /press. The bot token reads his DM when Cain hands a request over.
    store = KeeperStore(os.path.join(data_dir, "discord.json"))
    discord_token = lambda: vault.get("discord_bot_token")          # noqa: E731
    keeper = DiscordKeeper(DiscordAPI(discord_token, DiscordTransport()), store.get, store.set)
    controller.discord = keeper
    controller.discord_chat = LinkChat(CainLink(discord_token),
                                       paused=lambda: commands.is_paused(ledger))
    # Cain hands calendar requests over here, keyed by the bot token both hold.
    controller.handovers = handover.Inbox(discord_token, wake=keeper.wake)
    try:
        handover.serve(controller.handovers,
                       port=int(os.environ.get("HARNESS_HANDOVER_PORT", handover.PORT)))
    except OSError as e:
        # Everything else still works; he hears about it in the digest and on the page.
        logging.getLogger("harness").error("handover: can't listen: %s", e)
        controller.notes["handover"] = "Cain can't hand requests to the keeper: its port is taken"
    return controller, web, listener


class Stop(Exception):
    """Raised from the signal handler so a blocking long poll is
    interrupted at once, not after its timeout: Home Assistant gives an
    add-on a limited time to stop before it kills it."""


def main() -> int:
    scrub_environment()
    os.umask(0o077)            # the ledger holds his words: owner-only files
    configure_logging()
    log = logging.getLogger("harness")
    data_dir = os.environ.get("HARNESS_DATA", "/data")
    port = int(os.environ.get("HARNESS_PORT", "8099"))
    controller, web, listener = build(data_dir, port=port)

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
            except Exception as e:                 # never die quietly; never spin
                failures += 1
                log.error("tick failed (%d in a row): %s: %s", failures, type(e).__name__, e)
                time.sleep(min(60, 2 ** min(failures, 6)))
    except Stop:
        pass
    log.info("harness stopping")
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
