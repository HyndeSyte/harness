"""The controller loop, end to end with doubles: pairing, jobs, continuity,
settings changes, reset, and the daily canary and digest."""
import json
import queue
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from harness.config import Config
from harness.controller import Controller
from harness.ledger import iso
from harness.vault import Vault
from conftest import OWNER, Clock, cb, msg
from fakes import FakeBot, FakeEngine, SyncExecutor, result, tg_error

TOKEN = "123456789:AAEhBP0av28aH3sT9_" + "x" * 18
OKEY = "sk-proj-" + "B" * 40


class Rig:
    def __init__(self, ledger, tmp_path, clock, *, paired=True, proactive_from=date(2026, 10, 20),
                 daily=False):
        self.ledger = ledger
        self.clock = clock
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        self.vault.set_key("telegram_bot_token", TOKEN, by="Owner")
        self.vault.set_key("openai_api_key", OKEY, by="Owner")
        if paired:
            self.vault.try_pair(self.vault.new_pairing_code(), user_id=OWNER, chat_id=OWNER)
        self.bot = FakeBot()
        self.claude = FakeEngine("claude")
        self.gpt = FakeEngine("gpt")
        self.requests = queue.Queue()
        self.status = {}
        self.c = Controller(ledger=ledger, vault=self.vault, api=self.bot,
                            engines={"claude": self.claude, "gpt": self.gpt},
                            executor=SyncExecutor(),
                            base_config=Config(owner_user_id=1, stage="S1",
                                               proactive_from=proactive_from),
                            sleep=lambda s: None, monotonic=lambda: 0.0,
                            status_box=self.status, requests=self.requests, poll_timeout=0)
        self.uid = 100
        if not daily:
            # today's canary and digest count as done unless a test is about them
            today = clock().astimezone(ZoneInfo("America/New_York")).date().isoformat()
            with ledger.tx() as db:
                ledger.set_meta("canary_date", today, db)
                ledger.set_meta("digest_date", today, db)
        self.c.startup()

    def updates(self, *items):
        self.bot.batches.append(list(items))

    def say(self, text, **kw):
        self.uid += 1
        self.updates(msg(self.uid, text, **kw))
        self.c.tick()

    def tap(self, data, message_id):
        self.uid += 1
        self.updates(cb(self.uid, data, message_id=message_id))
        self.c.tick()

    def texts(self):
        return self.bot.texts()


@pytest.fixture
def rig(ledger, tmp_path, clock):
    return Rig(ledger, tmp_path, clock)


def test_pairing_binds_only_the_sender_of_the_code(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, paired=False)
    code = r.vault.new_pairing_code()
    r.updates(msg(1, "hi bot", user=999, chat=999), msg(2, f"/start {code}"))
    r.c.tick()
    assert r.vault.owner_id() == OWNER
    assert r.bot.sent[0][0] == OWNER and "Paired." in r.bot.sent[0][1]
    assert r.bot.commands and r.bot.commands[0][0] == OWNER
    # nothing said before pairing is kept, not even the code
    assert ledger.db.execute("SELECT COUNT(*) FROM job_text").fetchone()[0] == 0
    reasons = [x["reason"] for x in ledger.db.execute("SELECT reason FROM updates")]
    assert reasons == ["pairing: not paired", "pairing: paired"]
    # and from now on he is the owner: a message becomes a job
    r.say("what's on Thursday?")
    assert ledger.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


def test_wrong_codes_do_not_pair(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, paired=False)
    r.vault.new_pairing_code()
    r.updates(msg(1, "/start AAAAAAAAAAAAAAAAAAAAAA", user=999, chat=999))
    r.c.tick()
    assert r.vault.owner() is None and r.bot.sent == []


def test_a_message_is_answered_in_one_tick(rig):
    rig.claude.script = [result(text="Thursday is clear.")]
    rig.say("what's on Thursday?")
    assert "Thursday is clear." in rig.texts()[-1]


def test_work_content_is_refused_before_it_is_stored(rig, ledger):
    rig.say("see attached DRMEncryptedDataSpace blob")
    assert ledger.db.execute("SELECT COUNT(*) FROM job_text").fetchone()[0] == 0
    assert "looks like work content (marker)" in rig.texts()[-1]
    assert rig.claude.calls == []


def test_a_long_outage_says_continuity_is_unknown(rig, ledger, clock):
    rig.c.tick()
    with ledger.tx() as db:
        ledger.set_meta("last_poll_success", iso(clock() - timedelta(hours=30)), db)
    rig.c.tick()
    assert "Continuity unknown" in rig.texts()[-1]


def test_before_proactive_messages_are_allowed_the_notice_waits_for_him(ledger, tmp_path):
    clock = Clock(datetime(2026, 10, 12, 15, 0, tzinfo=timezone.utc))
    ledger.clock = clock
    r = Rig(ledger, tmp_path, clock)
    r.c.tick()
    with ledger.tx() as db:
        ledger.set_meta("last_poll_success", iso(clock() - timedelta(hours=30)), db)
    r.c.tick()
    assert r.bot.sent == []                       # held: nothing proactive before Oct 20
    r.claude.script = [result(text="answer")]
    r.say("hello")
    assert "Continuity unknown" in r.texts()[0] and "answer" in r.texts()[1]


def test_after_a_quiet_week_it_asks_for_the_earliest_update(rig, ledger, clock):
    with ledger.tx() as db:
        ledger.set_meta("telegram_offset", "1000", db)
        ledger.set_meta("last_update_received", iso(clock() - timedelta(days=7)), db)
    rig.updates(msg(5, "back from vacation"))     # ids restarted below the offset
    rig.c.tick()
    assert rig.bot.offsets[-1] == 0
    assert ledger.telegram_offset() == 6
    assert ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='update_ids_reset'"
                             ).fetchone()[0] == 1
    rig.c.tick()
    assert rig.bot.offsets[-1] == 6               # back to normal


def test_a_settings_change_applies_only_on_his_tap(rig):
    new = "sk-proj-" + "Z" * 40
    rig.vault.request_change("openai_api_key", new, by="Kid")
    rig.c.tick()
    _, text, buttons, mid = rig.bot.sent[-1]
    assert "Settings change requested" in text and "Kid" in text
    assert rig.vault.get("openai_api_key") == OKEY
    rig.c.tick()
    assert sum("Settings change" in t for t in rig.texts()) == 1     # announced once
    rig.tap(buttons[0][0][1], mid)
    assert rig.vault.get("openai_api_key") == new
    assert "Done. The OpenAI API key was replaced." in rig.texts()[-1]


def test_reset_tells_the_old_owner_first(rig):
    rig.requests.put({"type": "reset", "by": "Kid"})
    rig.c.tick()
    assert "The harness was reset" in rig.texts()[-1] and "Kid" in rig.texts()[-1]
    assert rig.vault.owner() is None and rig.vault.get("telegram_bot_token") == ""


def at_local(clock, hh, mm, day=21):
    # America/New_York is UTC-4 in October
    clock.t = datetime(2026, 10, day, hh + 4, mm, tzinfo=timezone.utc)


def canary_ok():
    return result({"type": "answer", "text": "canary ok"})


def test_canary_then_clear_digest(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    rig = Rig(ledger, tmp_path, clock, daily=True)
    rig.claude.script = [canary_ok()]
    rig.gpt.script = [result({"type": "answer", "text": "canary ok"}, engine="gpt")]
    rig.c.tick()
    inputs = ledger.inputs()
    assert inputs["canary:claude"]["last_success_at"] and inputs["canary:gpt"]["last_success_at"]
    assert "canary ok" not in " ".join(rig.texts())          # silent when fine
    at_local(clock, 7, 0)
    rig.c.tick()
    assert rig.texts()[-1].startswith("Clear · inputs fresh · 0 need you · 0 failures")
    at_local(clock, 7, 30)
    rig.c.tick()
    assert sum(t.startswith("Clear") for t in rig.texts()) == 1       # once a day


def test_a_failed_canary_makes_the_digest_say_so(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    rig = Rig(ledger, tmp_path, clock, daily=True)
    rig.claude.script = [result({"type": "answer", "text": "hello"})]
    rig.gpt.script = [canary_ok()]
    rig.c.tick()
    at_local(clock, 7, 1)
    rig.c.tick()
    digest = rig.texts()[-1]
    assert digest.startswith("<b>Attention needed</b>")
    assert "Claude canary failed: wrong answer" in digest


def test_no_digest_reaches_him_before_proactive_from(ledger, tmp_path):
    clock = Clock(datetime(2026, 10, 15, 10, 41, tzinfo=timezone.utc))
    ledger.clock = clock
    r = Rig(ledger, tmp_path, clock, daily=True)
    r.claude.script = [canary_ok()]
    r.gpt.script = [canary_ok()]
    r.c.tick()
    clock.t = datetime(2026, 10, 15, 11, 5, tzinfo=timezone.utc)
    r.c.tick()
    assert r.bot.sent == []
    ev = ledger.db.execute("SELECT detail FROM events WHERE kind='digest'").fetchone()
    assert json.loads(ev["detail"])["sent"] is False


def test_a_webhook_on_the_bot_is_reported_not_deleted(ledger, tmp_path, clock):
    r = Rig.__new__(Rig)
    bot = FakeBot()
    bot.webhook_url = "https://elsewhere.example/hook"
    vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
    vault.set_key("telegram_bot_token", TOKEN, by="Owner")
    vault.try_pair(vault.new_pairing_code(), user_id=OWNER, chat_id=OWNER)
    c = Controller(ledger=ledger, vault=vault, api=bot, engines={}, executor=SyncExecutor(),
                   base_config=Config(owner_user_id=1, stage="S1"), sleep=lambda s: None,
                   poll_timeout=0)
    c.startup()
    assert "webhook is set" in " ".join(c.notes.values())


def test_a_missing_model_is_reported(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock)
    r.gpt.model_state = "missing"
    r.c.startup()
    assert "gpt-6.1-sol isn't available" in r.c.status_text()


def test_telegram_conflict_is_noted_and_backs_off(rig):
    rig.bot.batches.append(tg_error(409, "Conflict: terminated by other getUpdates request"))
    rig.c.tick()
    assert "another program" in rig.c.status_text()
    rig.c.tick()                                   # recovers on the next good poll
    assert "another program" not in rig.c.status_text()


def test_status_command_reads_the_controller(rig):
    rig.say("/status")
    assert rig.texts()[-1].startswith("<b>Status</b> · stage S1 · zero effects")
