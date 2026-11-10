"""The controller loop, end to end with doubles: jobs, settings changes, reset,
and the daily canary and digest; and the same through Cain on Discord."""
import json
import queue
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from harness import approvals, commands
from harness.config import Config
from harness.discord_chat import STOP
from harness.vault import Vault
from conftest import OWNER, Clock, cb, msg
from fakes import FakeBot, FakeEngine, SyncExecutor, own, receive, result
from fakes import TestController as Controller
from test_discord_keeper import OWNER as DISCORD_OWNER, Rig as CainRig, ids

OKEY = "sk-proj-" + "B" * 40


class Rig:
    def __init__(self, ledger, tmp_path, clock, *, paired=True, proactive_from=date(2026, 10, 20),
                 daily=False):
        self.ledger = ledger
        self.clock = clock
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        self.vault.set_key("openai_api_key", OKEY, by="Owner")
        if paired:
            own(self.vault, OWNER)
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


def test_a_message_is_answered_in_one_tick(rig):
    rig.claude.script = [result(text="Thursday is clear.")]
    rig.say("what's on Thursday?")
    assert "Thursday is clear." in rig.texts()[-1]


def test_work_content_is_refused_before_it_is_stored(rig, ledger):
    rig.say("see attached DRMEncryptedDataSpace blob")
    assert ledger.db.execute("SELECT COUNT(*) FROM job_text").fetchone()[0] == 0
    assert "looks like work content (marker)" in rig.texts()[-1]
    assert rig.claude.calls == []


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
    assert rig.vault.owner() is None and rig.vault.get("openai_api_key") == ""


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


def test_a_missing_model_is_reported(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock)
    r.gpt.model_state = "missing"
    r.c.startup()
    assert "gpt-6.1-sol isn't available" in r.c.status_text()


def test_status_command_reads_the_controller(rig):
    rig.say("/status")
    assert rig.texts()[-1].startswith("<b>Status</b> · stage S1 · zero effects")


# -- the same, through Cain on Discord: cards to his link, taps back from it --------------

@pytest.fixture
def cain(ledger, tmp_path, clock):
    return CainRig(ledger, tmp_path, clock)


def test_through_cain_a_settings_change_applies_only_on_his_tap(cain):
    new = "sk-proj-" + "Z" * 40
    cain.vault.request_change("openai_api_key", new, by="Kid")
    cain.c.tick()
    card = cain.link.last()
    assert "Settings change requested" in card["text"] and "Kid" in card["text"]
    approve, decline, stop = ids(card)
    assert stop == STOP and cain.vault.get("openai_api_key") == ""
    cain.tap(max(cain.link.cards), approve)
    assert cain.vault.get("openai_api_key") == new
    assert "Done. The OpenAI API key was replaced." in cain.link.last()["text"]


def test_through_cain_reset_tells_him_first(cain):
    cain.c.requests.put({"type": "reset", "by": "Kid"})
    cain.c.tick()
    assert "The harness was reset" in cain.link.last()["text"]
    assert cain.vault.get("discord_bot_token") == "" and cain.c.config is None


def proposed_card(cain):
    """A proposed effect on a card, with Approve and Decline, shown through Cain."""
    ledger, owner = cain.ledger, int(DISCORD_OWNER)
    _, [jid] = receive(ledger, [msg(1, "hold Friday 2pm", user=owner, chat=owner)], owner=owner)
    ledger.transition(jid, "running")
    with ledger.tx() as db:
        pid = approvals.create_proposal(ledger, job_id=jid, effect_type="calendar_hold",
                                        params={"start": "2026-10-23T14:00:00-04:00",
                                                "duration_min": 60},
                                        policy_version=cain.c.config.policy_version,
                                        ttl_s=3600, db=db)
        ledger.transition(jid, "proposed", db=db)
        nonce = approvals.mint(ledger, proposal_id=pid, owner_user_id=owner, ttl_s=3600, db=db)
        ledger.enqueue(chat_id=owner, kind="card", text="Hold Friday 2 PM?", job_id=jid, db=db,
                       buttons=[[("Approve", approvals.callback_data("approve", nonce)),
                                 ("Decline", approvals.callback_data("decline", nonce))]],
                       binds=[{"type": "approval", "nonce": nonce}])
    cain.c.tick()
    return jid, max(cain.link.cards)


def test_through_cain_a_tap_on_a_proposal_card_decides_it_once(cain):
    jid, cid = proposed_card(cain)
    approve, decline, stop = ids(cain.link.cards[cid])
    assert approve.startswith("k:a:") and decline.startswith("k:d:") and stop == STOP
    cain.tap(cid, decline)
    assert cain.ledger.job(jid)["state"] == "declined"
    assert ids(cain.link.cards[cid]) == []                        # buttons taken off
    cain.tap(cid, approve)                                         # the card is spent
    assert cain.ledger.job(jid)["state"] == "declined"
    assert cain.link.answers[-1][1] == "Already done."


def test_through_cain_approve_runs_and_stop_still_wins(cain):
    jid, cid = proposed_card(cain)
    approve = ids(cain.link.cards[cid])[0]
    cain.tap(0, STOP)
    assert commands.is_paused(cain.ledger)
    cain.tap(cid, approve)
    assert cain.ledger.db.execute("SELECT COUNT(*) FROM approvals WHERE consumed_at IS NOT NULL"
                                  ).fetchone()[0] == 1
    assert cain.ledger.job(jid)["state"] != "proposed"
