"""The mutual watch (watch.py): Cain's add-on down for 5 minutes is told once, straight
to his DM; back is told once, through Cain's link. A restart or update says nothing.
Also the handover's /health that Cain's half of the watch asks, and the page."""
import http.client
import json
import queue
from http.server import ThreadingHTTPServer
import threading

import pytest

import fake_servers
from harness import handover, watch
from harness.cain_relay import CainLink
from harness.discord_api import DiscordError
from harness.discord_chat import LinkChat
from harness.discord_keeper import KeeperStore
from harness.setup_web import SetupApp, render_page
from harness.vault import Vault
from test_discord_keeper import DM, TOKEN, Rig


class Mem:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return self.d.get(k)

    def set(self, k, v):
        self.d[k] = v


class T:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def pw(mem=None, t=None):
    mem, t = mem or Mem(), t or T()
    return watch.PeerWatch(mem.get, mem.set, clock=t), mem, t


# -- the decision, alone ------------------------------------------------------------------

def test_a_restart_inside_the_grace_period_says_nothing():
    w, _, t = pw()
    assert w.observe(True) is None
    for _ in range(4):                       # four minutes down, then back
        t.t += 60
        assert w.observe(False) is None
    t.t += 60
    assert w.observe(True) is None and w.state() == "up"


def test_down_past_the_grace_period_is_told_once_and_back_once():
    w, _, t = pw()
    w.observe(True)
    seen = []
    for _ in range(30):                      # half an hour down, checked each minute
        t.t += 60
        due = w.observe(False)
        if due:
            seen.append(due)
            w.sent(due)
    assert seen == [watch.DOWN] and w.state() == "down"
    t.t += 60
    assert w.observe(True) == watch.BACK
    w.sent(watch.BACK)
    for _ in range(5):
        t.t += 60
        assert w.observe(True) is None
    assert w.state() == "up"


def test_the_first_failure_starts_the_clock():
    w, _, t = pw()
    assert w.observe(False) is None
    t.t += watch.GRACE_S - 1
    assert w.observe(False) is None
    t.t += 1
    assert w.observe(False) == watch.DOWN


def test_a_send_that_failed_is_tried_at_the_next_check_and_only_then():
    w, _, t = pw()
    w.observe(False)
    t.t += watch.GRACE_S
    assert w.observe(False) == watch.DOWN          # couldn't send: no sent()
    t.t += 60
    assert w.observe(False) == watch.DOWN
    w.sent(watch.DOWN)
    t.t += 60
    assert w.observe(False) is None
    t.t += 60
    assert w.observe(True) == watch.BACK           # couldn't send
    t.t += 60
    assert w.observe(True) == watch.BACK
    w.sent(watch.BACK)
    assert w.observe(True) is None


def test_a_restart_of_this_add_on_mid_outage_does_not_tell_him_twice():
    w, mem, t = pw()
    w.observe(False)
    t.t += watch.GRACE_S
    w.sent(w.observe(False))
    w2, _, _ = pw(mem, t)                          # this add-on restarted
    for _ in range(10):
        t.t += 60
        assert w2.observe(False) is None
    t.t += 60
    assert w2.observe(True) == watch.BACK          # and back is still told


def test_an_outage_not_yet_told_starts_over_after_a_restart():
    w, mem, t = pw()
    w.observe(False)
    t.t += watch.GRACE_S - 30
    w.observe(False)
    t.t += 3600                                    # this add-on was off itself for an hour
    w2, _, _ = pw(mem, t)
    assert w2.observe(False) is None
    t.t += watch.GRACE_S
    assert w2.observe(False) == watch.DOWN


def test_a_damaged_record_is_a_fresh_start():
    mem = Mem()
    mem.d["watch_cain"] = "{not json"
    w, _, _ = pw(mem)
    assert w.state() == "unknown" and w.observe(True) is None


def test_the_words_name_the_time_and_what_stops_working():
    assert "5 minutes" in watch.down_text(300) and "Stop" in watch.down_text(300)
    assert "after about 2 hours" in watch.back_text(7200)
    assert "about 1 minute." in watch.back_text(20)


# -- in the controller -----------------------------------------------------------------------

class Sent:
    def __init__(self):
        self.msgs, self.fail = [], False

    def __call__(self, channel, text, rows=None):
        if self.fail:
            raise DiscordError(0, "URLError")
        self.msgs.append((channel, text))
        return {"id": "1"}


def watched(rig, clock, tmp_path):
    store = KeeperStore(str(tmp_path / "discord.json"))
    rig.c.cain_watch = watch.PeerWatch(store.get, store.set,
                                       clock=lambda: clock().timestamp())
    rig.d.send = Sent()
    return rig.d.send


def minute(rig, clock, n=1):
    for _ in range(n):
        clock.advance(seconds=60)
        rig.c._link_checked = -1e9
        rig.c.tick()


@pytest.fixture
def rig(ledger, tmp_path, clock):
    return Rig(ledger, tmp_path, clock)


def test_cain_down_is_told_straight_to_his_dm_once_and_back_through_cain(rig, clock, tmp_path):
    sent = watched(rig, clock, tmp_path)
    minute(rig, clock)
    rig.link.up = False
    minute(rig, clock, 4)
    assert sent.msgs == []                                   # an update's restart: nothing
    minute(rig, clock, 2)
    assert len(sent.msgs) == 1 and sent.msgs[0][0] == DM
    assert "Cain's add" in sent.msgs[0][1] and "Stop" in sent.msgs[0][1]
    minute(rig, clock, 20)
    assert len(sent.msgs) == 1                               # not again
    assert rig.c.status_box["discord"]["cain"]["state"] == "down"
    rig.link.up = True
    before = dict(rig.link.cards)
    minute(rig, clock, 3)
    new = [c for k, c in rig.link.cards.items() if k not in before]
    assert len(new) == 1 and new[0]["kind"] == "alert" and "answering again" in new[0]["text"]
    assert new[0]["rows"] == []
    assert len(sent.msgs) == 1 and rig.c.status_box["discord"]["cain"]["state"] == "up"


def test_a_failed_dm_is_tried_again_next_minute(rig, clock, tmp_path):
    sent = watched(rig, clock, tmp_path)
    sent.fail = True
    rig.link.up = False
    minute(rig, clock, 6)
    assert sent.msgs == []
    sent.fail = False
    minute(rig, clock)
    minute(rig, clock, 5)
    assert len(sent.msgs) == 1


def test_without_a_watch_nothing_changes(rig, clock):
    rig.link.up = False
    minute(rig, clock, 10)
    assert "cain_link" in rig.c.notes and rig.c.status_box["discord"]["cain"] is None


# -- over real HTTP: Cain's add-on stopped and started again ----------------------------------

def test_a_stopped_cain_link_over_http_is_told_once_and_back(rig, clock, tmp_path):
    """Cain's add-on is simulated by the stand-in link server; stopping it closes its port
    (what the Supervisor stopping the add-on looks like from here)."""
    srv, st = fake_servers.cain_link(TOKEN)
    port = srv.server_address[1]
    st.discord = {"connected": True, "last_heard": 1_790_000_000_000}
    rig.c.discord_chat = LinkChat(CainLink(lambda: TOKEN, host="127.0.0.1", port=port, timeout=2))
    sent = watched(rig, clock, tmp_path)
    minute(rig, clock)
    d = rig.c.status_box["discord"]
    assert d["cain_answering"] and d["link"]["connected"] and d["link"]["last_heard"].startswith("2026")
    srv.shutdown()
    srv.server_close()
    minute(rig, clock, 7)
    assert len(sent.msgs) == 1
    assert rig.c.status_box["discord"]["cain_answering"] is False
    srv2 = ThreadingHTTPServer(("127.0.0.1", port), fake_servers.LinkHandler)
    srv2.state = st
    srv2.daemon_threads = True
    threading.Thread(target=srv2.serve_forever, daemon=True).start()
    try:
        cards = len(st.cards)
        minute(rig, clock, 2)
        backs = [c for c in list(st.cards.values())[cards:] if "answering again" in c["text"]]
        assert len(backs) == 1 and backs[0]["kind"] == "alert" and len(sent.msgs) == 1
    finally:
        srv2.shutdown()
        srv2.server_close()


# -- the handover's /health, for Cain's half --------------------------------------------------

def get(port, path, key):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request("GET", path, headers={"x-harness-key": key})
    r = c.getresponse()
    out = r.status, json.loads(r.read() or b"{}")
    c.close()
    return out


def test_health_needs_the_key_and_says_whether_the_loop_turns(monkeypatch):
    inbox = handover.Inbox(lambda: TOKEN)
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=1)
    port = srv.server_address[1]
    try:
        assert get(port, "/health", "wrong")[0] == 403
        assert get(port, "/nothing", handover.key_for(TOKEN))[0] == 404
        code, body = get(port, "/health", handover.key_for(TOKEN))
        assert code == 200 and body["status"] == "ok"
        inbox.beat_at -= handover.STUCK_S + 1
        assert get(port, "/health", handover.key_for(TOKEN))[1]["status"] == "stuck"
        inbox.beat()
        assert get(port, "/health", handover.key_for(TOKEN))[1]["status"] == "ok"
    finally:
        srv.shutdown()


def test_the_controller_loop_beats(rig):
    rig.c.handovers.beat_at = 0
    rig.c.tick()
    assert rig.c.handovers.health()["status"] == "ok"


# -- the page ---------------------------------------------------------------------------------

def page(tmp_path, discord):
    app = SetupApp(Vault(str(tmp_path / "s.json")), {"stage": "S1", "discord": discord},
                   queue.Queue())
    return render_page(app, "u1", "Owner")


def test_the_page_shows_the_link_and_the_watch(tmp_path):
    out = page(tmp_path, {"cain_answering": True,
                          "link": {"connected": True, "last_heard": "2026-11-10T14:02:09+00:00"},
                          "cain": {"state": "up", "checked_at": "2026-11-10T14:03:00+00:00",
                                   "grace_minutes": 5}})
    assert "<h2>Discord</h2>" in out and ">connected<" in out
    assert "last heard from Discord 2026-11-10 14:02 UTC" in out
    assert "Watch on Cain's add-on" in out and ">answering<" in out


def test_the_page_when_cain_is_down(tmp_path):
    out = page(tmp_path, {"cain_answering": False, "link": None,
                          "cain": {"state": "down", "down_since": "2026-11-10T14:00:00+00:00",
                                   "alerted_at": "2026-11-10T14:05:00+00:00",
                                   "checked_at": "2026-11-10T14:30:00+00:00", "grace_minutes": 5}})
    assert "Discord link: unknown" in out
    assert "not answering since 2026-11-10 14:00 UTC" in out and "you were told 2026-11-10 14:05" in out


def test_the_page_escapes_what_cain_says(tmp_path):
    out = page(tmp_path, {"cain_answering": True,
                          "link": {"connected": False, "last_heard": "<script>"}, "cain": None})
    assert "<script>" not in out and "not connected" in out


def test_odd_answers_from_cain_are_not_trusted(rig):
    rig.c.cain_status = {"status": "ok", "discord": {"connected": "yes", "last_heard": "soon"}}
    assert rig.c._discord_status()["link"] == {"connected": False, "last_heard": None}
    rig.c.cain_status = {"status": "ok"}
    assert rig.c._discord_status()["link"] is None
