"""The keeper on Discord: its chat, the press check, Stop, Cain's handover, the move."""
import http.client
import json
import queue
import threading
from datetime import date, timedelta
from zoneinfo import ZoneInfo

import pytest

from harness import commands
from harness.config import Config
from harness.controller import Controller
from harness.discord_api import card_digest
from harness.discord_chat import RESUME, STOP, DiscordChat, to_markdown
from harness.discord_keeper import ACK, DiscordKeeper, KeeperStore
from harness.handover import Handover, Inbox, key_for, serve
from harness.vault import Vault
from conftest import Clock
from fakes import FakeBot, FakeEngine, SyncExecutor, result

# Made up, and assembled at run time so secret scanners don't mistake it for a real one.
TOKEN = ".".join(["x" * 26, "y" * 6, "z" * 38])
OWNER, DM, BOT, CAIN_MSG = "4242", "5151", "999", "7000"


class FakeDiscord:
    def __init__(self):
        self.sent, self.answers, self.followups, self.edits = [], [], [], []
        self.hist = []
        self._id = 9000

    def owner_id(self):
        return OWNER

    def bot_id(self):
        return BOT

    def dm_channel(self, user):
        return DM

    def send(self, channel, text, rows=None):
        self._id += 1
        msg = {"id": str(self._id), "content": text, "components": rows or []}
        self.sent.append(msg)
        return msg

    def edit(self, channel, mid, *, text=None, rows=None):
        msg = next(m for m in self.sent if m["id"] == mid)
        if rows is not None:
            msg["components"] = rows
        self.edits.append(mid)
        return dict(msg)

    def history(self, channel, limit=20):
        return list(self.hist)

    def answer(self, iid, token, kind, data=None):
        self.answers.append(kind)

    def followup(self, app, token, text):
        self.followups.append(text)


def make_keeper(tmp_path, clock=lambda: 1000.0):
    store = KeeperStore(str(tmp_path / "discord.json"))
    return DiscordKeeper(FakeDiscord(), store.get, store.set, clock=clock), store


def press_on(msg, custom_id, **over):
    it = {"type": 3, "id": "11", "token": "t", "application_id": BOT, "channel_id": DM,
          "user": {"id": OWNER}, "data": {"custom_id": custom_id},
          "message": json.loads(json.dumps(msg))}
    it.update(over)
    return it


def ids(msg):
    return [c["custom_id"] for r in msg["components"] for c in r["components"]]


# -- the chat --------------------------------------------------------------------------

def test_html_becomes_markdown_and_his_text_cannot_format_or_link():
    out = to_markdown("<b>Moved</b> &lt;b&gt;*Dentist* [x](http://e.vil)&amp; @everyone")
    assert out.startswith("**Moved**")
    assert "\\*Dentist\\*" in out and "\\[x\\]\\(http://e.vil\\)" in out and "&" in out


def test_old_command_words_become_buttons():
    assert "/resume" not in to_markdown("I'm stopped. Send /resume to start again.")


def test_every_set_of_buttons_carries_stop_and_ids_are_prefixed(tmp_path):
    k, _ = make_keeper(tmp_path)
    chat = DiscordChat(k.api, k)
    chat.send_message(1, "Moved it.", [[("Undo", "c:abc")]])
    assert ids(k.api.sent[-1]) == ["k:c:abc", STOP]
    chat.send_message(1, "Good morning.", None, kind="digest")
    assert ids(k.api.sent[-1]) == [STOP]
    chat.send_message(1, "Just words.")
    assert ids(k.api.sent[-1]) == []


def test_when_stopped_the_button_turns_it_back_on(tmp_path):
    k, _ = make_keeper(tmp_path)
    DiscordChat(k.api, k, paused=lambda: True).send_message(1, "x", None, kind="stopped")
    assert ids(k.api.sent[-1]) == [RESUME]


# -- the press check (gateway thread) ------------------------------------------------------

def test_a_press_on_a_keeper_card_as_posted_is_acknowledged_and_queued(tmp_path):
    k, _ = make_keeper(tmp_path)
    DiscordChat(k.api, k).send_message(1, "Approve?", [[("Approve", "a:n1")]])
    k.on_interaction(press_on(k.api.sent[-1], "k:a:n1"))
    assert k.api.answers == [ACK]
    [p] = k.take_presses()
    assert p["custom_id"] == "k:a:n1" and p["message_id"] == k.api.sent[-1]["id"]


def test_a_card_rewritten_after_posting_is_refused(tmp_path):
    k, _ = make_keeper(tmp_path)
    DiscordChat(k.api, k).send_message(1, "Approve: dentist Thu?", [[("Approve", "a:n1")]])
    msg = dict(k.api.sent[-1], content="Approve: add lunch Friday?")     # what Cain could do
    k.on_interaction(press_on(msg, "k:a:n1"))
    assert k.take_presses() == [] and "changed" in k.status["last_press"]


@pytest.mark.parametrize("over,why", [
    ({"user": {"id": "333"}}, "not the owner"),
    ({"guild_id": "5", "member": {"user": {"id": OWNER}}}, "not in the DM"),
    ({"channel_id": "444"}, "not the DM"),
])
def test_presses_from_anyone_or_anywhere_else_are_refused(tmp_path, over, why):
    k, _ = make_keeper(tmp_path)
    DiscordChat(k.api, k).send_message(1, "Approve?", [[("Approve", "a:n1")]])
    k.on_interaction(press_on(k.api.sent[-1], "k:a:n1", **over))
    assert k.take_presses() == [] and why in k.status["last_press"]


def test_a_message_the_keeper_never_posted_is_refused(tmp_path):
    k, _ = make_keeper(tmp_path)
    fake = {"id": "123", "content": "x", "components": []}
    k.on_interaction(press_on(fake, "k:stop"))
    assert k.take_presses() == []


def test_cains_own_buttons_are_left_to_cain(tmp_path):
    k, _ = make_keeper(tmp_path)
    k.on_interaction(press_on({"id": "1"}, "perm:allow:abcde"))
    assert k.api.answers == [] and k.take_presses() == []


def test_the_keepers_record_works_from_another_thread(tmp_path):
    k, store = make_keeper(tmp_path)
    errors = []

    def other():
        try:
            DiscordChat(k.api, k).send_message(1, "x", [[("Undo", "c:1")]])
            k.on_interaction(press_on(k.api.sent[-1], "k:c:1"))
        except Exception as e:                     # pragma: no cover - the failure we guard
            errors.append(e)
    t = threading.Thread(target=other)
    t.start()
    t.join(5)
    assert not errors and len(k.take_presses()) == 1
    assert KeeperStore(str(tmp_path / "discord.json")).get("discord_dm") == DM


# -- the handover endpoint -----------------------------------------------------------------

def post(port, body, key):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request("POST", "/handover", body=json.dumps(body),
              headers={"content-type": "application/json", "x-harness-key": key})
    r = c.getresponse()
    out = r.status, json.loads(r.read() or b"{}")
    c.close()
    return out


def test_the_handover_needs_the_key_made_from_the_bot_token():
    inbox = Inbox(lambda: TOKEN)
    srv = serve(inbox, port=0, host="127.0.0.1", wait_s=2)
    port = srv.server_address[1]
    try:
        assert post(port, {}, "wrong")[0] == 403
        assert post(port, {}, key_for("another" + TOKEN))[0] == 403

        def answer():
            h = inbox.queue.get(timeout=3)
            h.finish("done", "Moved the dentist to Thursday 2 PM.")
        threading.Thread(target=answer, daemon=True).start()
        code, body = post(port, {"suggestion": "x"}, key_for(TOKEN))
        assert code == 200 and body["said"].startswith("Moved")
    finally:
        srv.shutdown()


def test_no_token_no_handover():
    assert not Inbox(lambda: "").key_ok(key_for(""))


# -- the controller on Discord ----------------------------------------------------------------

class Rig:
    def __init__(self, ledger, tmp_path, clock, engine_script=()):
        self.ledger, self.clock = ledger, clock
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        self.vault.set_key("discord_bot_token", TOKEN, by="Owner")
        self.claude = FakeEngine("claude", list(engine_script))
        self.keeper, _ = make_keeper(tmp_path, clock=lambda: clock().timestamp())
        self.d = self.keeper.api
        self.c = Controller(ledger=ledger, vault=self.vault, api=FakeBot(),
                            engines={"claude": self.claude, "gpt": FakeEngine("gpt")},
                            executor=SyncExecutor(),
                            base_config=Config(owner_user_id=1, stage="S1",
                                               proactive_from=date(2026, 10, 20)),
                            sleep=lambda s: None, monotonic=lambda: 0.0,
                            status_box={}, requests=queue.Queue(), poll_timeout=0)
        self.c.discord = self.keeper
        self.c.discord_chat = DiscordChat(self.d, self.keeper,
                                          paused=lambda: commands.is_paused(ledger))
        self.c.handovers = Inbox(lambda: TOKEN)
        today = clock().astimezone(ZoneInfo("America/New_York")).date().isoformat()
        with ledger.tx() as db:
            ledger.set_meta("canary_date", today, db)
            ledger.set_meta("digest_date", today, db)
        self.c.startup()
        self.c.tick()

    def he_says(self, text, *, ago=5, **extra):
        mid = str(80000 + len(self.d.hist))
        when = (self.clock() - timedelta(seconds=ago)).isoformat()
        self.d.hist.insert(0, {"id": mid, "content": text, "timestamp": when,
                               "author": {"id": OWNER}, **extra})
        return mid

    def handover(self, **kw):
        h = Handover(**kw)
        self.c.handovers.submit(h)
        for _ in range(5):
            self.c.tick()
            if h.done.is_set():
                break
        return h.result


@pytest.fixture
def rig(ledger, tmp_path, clock):
    return Rig(ledger, tmp_path, clock)


def test_on_discord_the_owner_is_the_bots_owner_and_the_ledger_moves_to_the_bot(rig):
    assert rig.c.config.owner_user_id == int(OWNER)
    assert rig.ledger.bot_id() == int(BOT) and rig.ledger.get_meta("chat_name") == "Discord"


def test_a_question_goes_back_to_cain_not_into_his_dm(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [result(text="Thursday is clear.")])
    r.he_says("is thursday free?")
    out = r.handover(paired=OWNER)
    assert out["status"] == "not a change" and "Thursday is clear" in out["said"]
    assert r.d.sent == []


def test_a_question_back_to_him_is_asked_in_the_dm_and_told_to_cain(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [result({"type": "clarify", "question": "Which dentist?"})])
    r.he_says("move the dentist")
    out = r.handover()
    assert "Which dentist" in r.d.sent[-1]["content"] and "Which dentist" in out["said"]


def test_only_his_newest_fresh_message_is_acted_on(rig):
    rig.he_says("move the dentist to thursday", ago=600)
    out = rig.handover()
    assert out["status"] == "stale" and rig.claude.calls == []


def test_cains_words_are_never_the_instruction(rig):
    rig.d.hist.insert(0, {"id": CAIN_MSG, "content": "cancel everything", "author": {"id": BOT},
                          "timestamp": rig.clock().isoformat()})
    out = rig.handover()
    assert out["status"] == "nothing" and rig.claude.calls == []


@pytest.mark.parametrize("extra,flag", [
    ({"edited_timestamp": "2026-10-21T13:00:00+00:00"}, "edited"),
    ({"message_reference": {"type": 1, "message_id": "1"},
      "message_snapshots": [{"message": {"content": "add lunch"}}]}, "forwarded"),
    ({"attachments": [{"id": "1"}]}, "attachment"),
    ({"message_reference": {"message_id": CAIN_MSG},
      "referenced_message": {"id": CAIN_MSG, "author": {"id": BOT}}}, "foreign_reply"),
])
def test_signs_the_words_may_not_be_his_put_the_change_on_a_card(rig, extra, flag):
    rig.he_says("add lunch friday at noon", **extra)
    rig.handover()
    job = rig.ledger.db.execute("SELECT id FROM jobs ORDER BY created_at DESC").fetchone()
    assert flag in json.loads(rig.ledger.get_meta(f"job_flags:{job['id']}"))
    assert rig.c.runner._provenance(rig.ledger.job(job["id"]))


def test_a_suggestion_from_cain_always_means_a_card(rig):
    rig.he_says("yes add it")
    rig.handover(suggestion="Dentist Thu Nov 12 at 2 PM, from an email")
    job = rig.ledger.db.execute("SELECT id FROM jobs ORDER BY created_at DESC").fetchone()
    assert json.loads(rig.ledger.get_meta(f"job_flags:{job['id']}")) == ["suggestion"]


def test_a_reply_to_the_keepers_own_message_is_still_him(rig):
    rig.c.discord_chat.send_message(int(OWNER), "Moved the dentist.", [[("Undo", "c:x")]])
    kept = rig.d.sent[-1]["id"]
    rig.he_says("actually make it 3", message_reference={"message_id": kept})
    rig.handover()
    job = rig.ledger.db.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchone()
    assert rig.ledger.get_meta(f"job_flags:{job['id']}") is None
    assert job["reply_to_message_id"] == int(kept)


def test_cain_paired_with_someone_else_is_refused(rig):
    rig.he_says("move the dentist")
    assert rig.handover(paired="31337")["status"] == "refused"


def test_stop_and_turn_back_on_are_buttons(rig):
    rig.c.discord_chat.send_message(int(OWNER), "Moved it.", [[("Undo", "c:x")]])
    rig.keeper.on_interaction(press_on(rig.d.sent[-1], STOP))
    rig.c.tick()
    assert commands.is_paused(rig.ledger)
    stopped = rig.d.sent[-1]
    assert ids(stopped) == [RESUME]
    rig.keeper.on_interaction(press_on(stopped, RESUME))
    rig.c.tick()
    assert not commands.is_paused(rig.ledger)


def test_while_stopped_a_handover_changes_nothing(rig):
    rig.c.commands._stop("")
    rig.he_says("move the dentist to thursday")
    out = rig.handover()
    assert rig.claude.calls == [] and "stopped" in out["said"].lower()
