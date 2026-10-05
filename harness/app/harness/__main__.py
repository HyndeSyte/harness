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

from . import family, policy
from .calendar_feed import CalendarFeeds
from .config import Config
from .controller import Controller
from .engines import AnthropicEngine, OpenAIEngine
from .ledger import Ledger
from .net import RedactingFilter, UrllibTransport
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
    status: dict = {}
    requests: queue.Queue = queue.Queue()
    # owner_user_id is a placeholder until pairing binds the real one.
    base = Config(owner_user_id=1, stage=STAGE)
    inbox = family.FamilyInbox(os.path.join(data_dir, "family.json"), ledger.now,
                               entity=base.family_entity or "calendar.family")
    web = serve(SetupApp(vault, status, requests,
                         family=inbox if base.family_entity else None), port=port)
    executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="worker")
    calendar = CalendarFeeds(ledger, transport, executor,
                             lambda: vault.get("calendar_feeds"), base.timezone)
    listener = family.serve(inbox, port=family_port) if base.family_entity else None
    controller = Controller(ledger=ledger, vault=vault, api=api, engines=engines,
                            executor=executor, base_config=base, status_box=status,
                            requests=requests, calendar=calendar,
                            family=inbox if base.family_entity else None)
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
    # Home Assistant's cold backup stops the add-on before copying /data;
    # closing here leaves a single consistent database file behind.
    controller.ledger.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
