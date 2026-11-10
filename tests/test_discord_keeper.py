"""The calendar specialist behind Cain: cards go to Cain's link, taps come back, Cain's
handover is acted on only from his own fresh words, Stop, and the morning digest."""
import http.client
import json
import queue
import threading
from datetime import date, timedelta
from zoneinfo import ZoneInfo

import pytest

from harness import commands
from harness.cain_relay import CainLink, LinkError
from harness.config import Config
from harness.controller import Controller
from harness.discord_chat import RESUME, STOP, LinkChat, to_markdown
from harness.discord_keeper import DiscordKeeper, KeeperStore
from harness.handover import Handover, Inbox, key_for, serve
from harness.vault import Vault
from fakes import own, FakeBot, FakeEngine, SyncExecutor, result

# Made up, and assembled at run time so secret scanners don't mistake it for a real one.
TOKEN = ".".join(["x" * 26, "y" * 6, "z" * 38])
OWNER, DM, BOT, CAIN_MSG = "4242", "5151", "999", "7000"


class FakeDiscord:
    """The REST calls the specialist still makes: identity and reading his DM."""

    def __init__(self):
        self.hist = []

    def owner_id(self):
        return OWNER

    def bot_id(self):
        return BOT

    def dm_channel(self, user):
        return DM

    def history(self, channel, limit=20):
        return list(self.hist)


class FakeLink:
    """Cain's link: holds cards until Cain shows them."""

    def __init__(self):
        self.cards, self.answers, self.edits = {}, [], []
        self.shown_as = {}            # Discord message id -> card id
        self.up = True
        self._next = 100

    def card(self, text, rows, kind):
        if not self.up:
            raise LinkError(0, "ConnectionRefusedError")
        self._next += 1
        self.cards[self._next] = {"text": text, "rows": rows, "kind": kind}
        return self._next

    def buttons(self, card, rows):
        self.cards[card]["rows"] = rows
        self.edits.append(card)

    def answer(self, callback, text):
        self.answers.append((callback, text))

    def card_of(self, message_id):
        return self.shown_as.get(str(message_id))

    def health(self):
        return self.up

    def status(self):
        return {"status": "ok"} if self.up else None

    def last(self):
        return self.cards[max(self.cards)] if self.cards else None


def ids(card):
    return [c["custom_id"] for r in card["rows"] for c in r["components"]]


# -- the chat, handed to Cain ----------------------------------------------------------

def test_html_becomes_markdown_and_his_text_cannot_format_or_link():
    out = to_markdown("<b>Moved</b> &lt;b&gt;*Dentist* [x](http://e.vil)&amp; @everyone")
    assert out.startswith("**Moved**")
    assert "\\*Dentist\\*" in out and "\\[x\\]\\(http://e.vil\\)" in out and "&" in out


def test_old_command_words_become_buttons():
    assert "/resume" not in to_markdown("I'm stopped. Send /resume to start again.")


def test_every_message_is_a_card_for_cain_and_buttons_carry_stop():
    link = FakeLink()
    chat = LinkChat(link)
    cid = chat.send_message(1, "Moved it.", [[("Undo", "c:abc")]])
    assert link.cards[cid]["kind"] == "reply" and ids(link.cards[cid]) == ["k:c:abc", STOP]
    chat.send_message(1, "Good morning.", None, kind="digest")
    assert ids(link.last()) == [STOP]
    chat.send_message(1, "Just words.")
    assert ids(link.last()) == []


def test_when_stopped_the_button_turns_it_back_on():
    link = FakeLink()
    LinkChat(link, paused=lambda: True).send_message(1, "x", None, kind="stopped")
    assert ids(link.last()) == [RESUME]


def test_cain_unreachable_means_retry_later_not_lost():
    link = FakeLink()
    link.up = False
    with pytest.raises(Exception) as e:
        LinkChat(link).send_message(1, "x")
    assert e.value.retryable


def test_the_link_client_refuses_without_a_token():
    assert not CainLink(lambda: "", host="127.0.0.1", port=1).health()


# -- the handover endpoint ---------------------------------------------------------------

def post(port, path, body, key):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request("POST", path, body=json.dumps(body),
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
        assert post(port, "/handover", {}, "wrong")[0] == 403
        assert post(port, "/handover", {}, key_for("another" + TOKEN))[0] == 403
        assert post(port, "/ask", {}, key_for(TOKEN))[0] == 404      # Cain asks through his link

        def answer():
            h = inbox.queue.get(timeout=3)
            assert h.kind == "press" and h.press["custom_id"] == "k:c:1"
            h.finish("ok")
        threading.Thread(target=answer, daemon=True).start()
        code, _ = post(port, "/press", {"custom_id": "k:c:1", "message_id": "5"}, key_for(TOKEN))
        assert code == 200
    finally:
        srv.shutdown()


def test_no_token_no_handover():
    assert not Inbox(lambda: "").key_ok(key_for(""))


# -- the controller, behind Cain ------------------------------------------------------------

class Rig:
    def __init__(self, ledger, tmp_path, clock, engine_script=()):
        self.ledger, self.clock = ledger, clock
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        self.vault.set_key("discord_bot_token", TOKEN, by="Owner")
        self.claude = FakeEngine("claude", list(engine_script))
        store = KeeperStore(str(tmp_path / "discord.json"))
        self.d = FakeDiscord()
        self.keeper = DiscordKeeper(self.d, store.get, store.set)
        self.link = FakeLink()
        self.c = Controller(ledger=ledger, vault=self.vault, api=FakeBot(),
                            engines={"claude": self.claude, "gpt": FakeEngine("gpt")},
                            executor=SyncExecutor(),
                            base_config=Config(owner_user_id=1, stage="S1",
                                               proactive_from=date(2026, 10, 20)),
                            sleep=lambda s: None, monotonic=lambda: 0.0,
                            status_box={}, requests=queue.Queue(), poll_timeout=0)
        self.c.discord = self.keeper
        self.c.discord_chat = LinkChat(self.link, paused=lambda: commands.is_paused(ledger))
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

    def send(self, h):
        self.c.handovers.submit(h)
        for _ in range(5):
            self.c.tick()
            if h.done.is_set():
                break
        return h.result

    def handover(self, **kw):
        return self.send(Handover(**kw))

    def tap(self, card_id, custom_id):
        return self.send(Handover(kind="press", press={
            "id": "11", "token": "t", "app": BOT, "custom_id": custom_id, "message_id": str(card_id)}))


@pytest.fixture
def rig(ledger, tmp_path, clock):
    return Rig(ledger, tmp_path, clock)


def test_the_owner_is_the_bots_owner_and_the_ledger_moves_to_the_bot(rig):
    assert rig.c.config.owner_user_id == int(OWNER)
    assert rig.ledger.bot_id() == int(BOT) and rig.ledger.get_meta("chat_name") == "Discord"


def test_a_question_goes_back_to_cain_and_nothing_is_made_for_him(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [result(text="Thursday is clear.")])
    r.he_says("is thursday free?")
    out = r.handover(paired=OWNER)
    assert out["status"] == "not a change" and "Thursday is clear" in out["said"]
    assert r.link.cards == {} and out["cards"] == []


def test_a_question_back_to_him_is_a_card_cain_shows(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [result({"type": "clarify", "question": "Which dentist?"})])
    r.he_says("move the dentist")
    out = r.handover()
    [cid] = out["cards"]
    assert "Which dentist" in r.link.cards[cid]["text"] and "Which dentist" in out["said"]


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


def test_a_reply_to_one_of_our_cards_is_still_him(rig):
    cid = rig.c.discord_chat.send_message(int(OWNER), "Moved the dentist.", [[("Undo", "c:x")]])
    rig.link.shown_as["777000"] = cid                          # Cain showed it as this message
    rig.he_says("actually make it 3", message_reference={"message_id": "777000"})
    rig.handover()
    job = rig.ledger.db.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchone()
    assert rig.ledger.get_meta(f"job_flags:{job['id']}") is None
    assert job["reply_to_message_id"] == cid


def test_cain_paired_with_someone_else_is_refused(rig):
    rig.he_says("move the dentist")
    assert rig.handover(paired="31337")["status"] == "refused"


def test_stop_and_turn_back_on_go_straight_out(rig):
    rig.tap(0, STOP)
    assert commands.is_paused(rig.ledger)
    stopped = rig.link.last()
    assert stopped["kind"] == "stopped" and ids(stopped) == [RESUME]
    rig.tap(0, RESUME)
    assert not commands.is_paused(rig.ledger) and rig.link.last()["kind"] == "resumed"


def test_while_stopped_a_handover_changes_nothing(rig):
    rig.c.commands._stop("")
    rig.he_says("move the dentist to thursday")
    out = rig.handover()
    assert rig.claude.calls == [] and "stopped" in out["said"].lower()


def test_a_tap_on_a_card_is_checked_by_the_ledger_as_always(rig):
    from harness import choices
    with rig.ledger.tx() as db:
        n = choices.mint(rig.ledger, kind="settings_decline", target="x", chat_id=int(OWNER),
                         ttl_s=600, db=db)
        rig.ledger.enqueue(chat_id=int(OWNER), kind="card", text="Replace the key?", db=db,
                           buttons=[[("Decline", choices.callback_data(n))]],
                           binds=[{"type": "choice", "nonce": n}])
    rig.c.tick()
    cid = max(rig.link.cards)
    rig.tap(cid, "k:" + choices.callback_data(n))
    assert rig.link.edits == [cid] and ids(rig.link.cards[cid]) == []      # buttons taken off
    rig.tap(cid, "k:" + choices.callback_data(n))                          # used once
    assert rig.link.answers and "Already done" in rig.link.answers[-1][1]


def test_without_cain_the_link_note_shows(rig):
    rig.link.up = False
    rig.c._link_checked = -1e9
    rig.c.tick()
    assert "cain_link" in rig.c.notes


# -- the morning ----------------------------------------------------------------------------

def held(rig):
    with rig.ledger.tx() as db:
        rig.ledger.set_meta("last_digest_text", "<b>Today</b>: dentist 2 PM", db)
        rig.ledger.set_meta("digest_held_at", rig.clock().isoformat(), db)


def test_cain_takes_the_digest_for_his_one_morning_message(rig):
    held(rig)
    out = rig.handover(kind="digest")
    assert out["status"] == "ok" and out["said"] == "Today: dentist 2 PM"
    rig.handover(kind="morning-posted")
    rig.clock.advance(minutes=50)
    rig.c.tick()
    assert rig.link.cards == {}                                  # not sent again


def test_without_cains_morning_message_the_digest_goes_out_on_its_own(rig):
    held(rig)
    rig.clock.advance(minutes=39)
    rig.c.tick()
    assert rig.link.cards == {}
    rig.clock.advance(minutes=2)
    rig.c.tick()
    card = rig.link.last()
    assert card["kind"] == "alert" and "didn't post his morning message" in card["text"]
    assert ids(card) == [STOP]


# -- what Dane told Cain kinds of Family events mean (meaning_live.py) --------------------

MEANING_ROW = {"kind": "Pat dentist", "meaning": "kids", "said_on": "2026-10-01"}


def test_the_meanings_route_needs_the_key_and_good_rows():
    from harness import handover
    token = "tok-" + "a" * 30
    inbox = handover.Inbox(lambda: token)
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=2)
    port = srv.server_address[1]
    try:
        assert post(port, "/meanings", {"rows": [MEANING_ROW]}, "wrong")[0] == 403
        code, out = post(port, "/meanings", {"rows": [{**MEANING_ROW, "meaning": "<script>"}]},
                         handover.key_for(token))
        assert code == 400 and "script" not in json.dumps(out) and inbox.queue.empty()

        def answer():
            h = inbox.queue.get(timeout=3)
            assert h.kind == "meanings" and h.rows == [{"words": ["dentist", "pat"], "meaning": "kids",
                                                        "said_on": "2026-10-01"}]
            h.finish("ok", "Stored 1 new; 0 already known.")
        threading.Thread(target=answer, daemon=True).start()
        code, out = post(port, "/meanings", {"rows": [MEANING_ROW]}, handover.key_for(token))
        assert code == 200 and out["said"] == "Stored 1 new; 0 already known."
    finally:
        srv.shutdown()


# -- his place book (places.py) -------------------------------------------------------------

PLACE_ROW = {"place": "HMLC", "address": "Front desk, 12 Rink Rd, Leesburg, VA 20175", "said_on": "2026-10-01"}


def test_the_places_route_needs_the_key_and_a_real_address():
    from harness import handover
    token = "tok-" + "b" * 30
    inbox = handover.Inbox(lambda: token)
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=2)
    port = srv.server_address[1]
    try:
        assert post(port, "/places", {"rows": [PLACE_ROW]}, "wrong")[0] == 403
        code, out = post(port, "/places", {"rows": [{**PLACE_ROW, "address": "behind Pat's barn"}]},
                         handover.key_for(token))
        assert code == 400 and out["said"].startswith("row 1: address must be")
        assert "Pat" not in json.dumps(out) and inbox.queue.empty()

        def answer():
            h = inbox.queue.get(timeout=3)
            assert h.kind == "places" and h.rows == [{"key": "hmlc", "address": "12 Rink Rd, Leesburg, VA 20175",
                                                      "skip": False, "said_on": "2026-10-01"}]
            h.finish("ok", "Stored 1 place; 0 skipped.")
        threading.Thread(target=answer, daemon=True).start()
        code, out = post(port, "/places", {"rows": [PLACE_ROW]}, handover.key_for(token))
        assert code == 200 and out["said"] == "Stored 1 place; 0 skipped."
    finally:
        srv.shutdown()
