"""The keeper on Discord: REST payloads, the gateway connection, and the press check."""
import base64
import hashlib
import json
import socket
import struct
import threading

import pytest

from harness.discord_api import (LIMIT, SUPPRESS_EMBEDS, DiscordAPI, DiscordError,
                                 DiscordTransport, card_digest, check_token, components)
from harness.discord_gateway import GUID, Closed, Gateway, WebSocket
from harness.discord_keeper import ACK, UPDATE, DiscordKeeper
from harness.net import TransportError
from harness.vault import Vault, VaultError
from fakes import FakeTransport

# Made up, and assembled at run time so secret scanners don't mistake it for a real one.
TOKEN = ".".join(["x" * 26, "y" * 6, "z" * 38])
OWNER, DM, BOT = "111", "222", "999"


def api(replies):
    t = FakeTransport(replies)
    return DiscordAPI(lambda: TOKEN, t), t


# -- REST --------------------------------------------------------------------

def test_send_turns_off_mentions_and_previews_and_fits_2000():
    a, t = api([(200, {"id": "5", "content": "x"})])
    a.send(DM, "y" * 2500, components([[("Undo", "k:n:undo")]]))
    req = t.requests[0]
    assert req["url"] == f"https://discord.com/api/v10/channels/{DM}/messages"
    assert req["headers"]["authorization"] == f"Bot {TOKEN}"
    body = req["json"]
    assert body["allowed_mentions"] == {"parse": []} and body["flags"] == SUPPRESS_EMBEDS
    assert len(body["content"]) <= LIMIT
    assert body["components"][0]["components"][0]["custom_id"] == "k:n:undo"


def test_owner_is_the_team_owner_for_a_team_app():
    a, _ = api([(200, {"team": {"owner_user_id": "77"}, "owner": {"id": "88"}})])
    assert a.owner_id() == "77"
    a, _ = api([(200, {"owner": {"id": "88"}})])
    assert a.owner_id() == "88"


def test_rate_limit_is_retryable_and_carries_wait():
    a, _ = api([(429, {"message": "slow down", "retry_after": 1.5})])
    with pytest.raises(DiscordError) as e:
        a.send(DM, "hi")
    assert e.value.retryable and e.value.retry_after == 1.5


def test_interaction_answer_uses_its_own_token_not_the_bot_token():
    a, t = api([(204, b"")])
    a.answer("1", "itoken", 6)
    req = t.requests[0]
    assert req["url"].endswith("/interactions/1/itoken/callback")
    assert "authorization" not in req["headers"]


def test_transport_only_reaches_discord():
    for url in ("https://evil.example/api", "http://discord.com/api", "https://discord.com:444/x"):
        with pytest.raises(TransportError):
            DiscordTransport().request("GET", url)


def test_vault_takes_a_discord_token_and_refuses_junk(tmp_path):
    v = Vault(str(tmp_path / "s.json"))
    assert check_token(TOKEN)
    assert v.check_format("discord_bot_token", TOKEN) == TOKEN
    with pytest.raises(VaultError):
        v.check_format("discord_bot_token", "https://discord.com/not-a-token")


# -- the press check ------------------------------------------------------------

class FakeAPI:
    def __init__(self):
        self.sent, self.answers = [], []

    def owner_id(self):
        return OWNER

    def dm_channel(self, user):
        return DM

    def send(self, channel, text, rows=None):
        msg = {"id": str(100 + len(self.sent)), "content": text, "components": rows or []}
        self.sent.append(msg)
        return msg

    def answer(self, iid, token, kind, data=None):
        self.answers.append((kind, data))


def keeper(now=[1000.0]):
    meta = {}
    k = DiscordKeeper(FakeAPI(), meta.get, meta.__setitem__, clock=lambda: now[0])
    return k, meta


def press(k, msg, action="approve", **over):
    cid = next(c["custom_id"] for r in msg["components"] for c in r["components"]
               if c["custom_id"].endswith(":" + action))
    it = {"type": 3, "id": "i1", "token": "t1", "channel_id": DM, "user": {"id": OWNER},
          "data": {"custom_id": cid}, "message": json.loads(json.dumps(msg))}
    it.update(over)
    k.on_interaction(it)
    return k.api.answers[-1] if k.api.answers else None


def card(k):
    k.post_card("change", "Calendar: move the dentist to Thu 2 PM?",
                [("Approve", "approve"), ("Decline", "decline")], ttl_s=600)
    return k.api.sent[-1]


def test_a_press_by_him_on_the_card_as_posted_is_accepted_once():
    k, _ = keeper()
    msg = card(k)
    kind, data = press(k, msg)
    assert kind == UPDATE and data["components"] == [] and "approved" in data["content"]
    assert press(k, msg)[0] == ACK and "already used" in k.status["last_press"]


def test_a_card_rewritten_after_posting_is_refused():
    k, _ = keeper()
    msg = card(k)
    msg["content"] = "Calendar: add lunch Friday?"          # what Cain could do
    assert press(k, msg)[0] == ACK
    assert "changed" in k.status["last_press"]


@pytest.mark.parametrize("over,why", [
    ({"user": {"id": "333"}}, "not the owner"),
    ({"guild_id": "5", "member": {"user": {"id": OWNER}}}, "not in the DM"),
    ({"channel_id": "444"}, "not the DM"),
])
def test_presses_from_anyone_or_anywhere_else_are_refused(over, why):
    k, _ = keeper()
    msg = card(k)
    assert press(k, msg, **over)[0] == ACK
    assert why in k.status["last_press"]


def test_an_expired_card_is_refused():
    now = [1000.0]
    k, _ = keeper(now)
    msg = card(k)
    now[0] += 601
    assert press(k, msg)[0] == ACK and "expired" in k.status["last_press"]


def test_buttons_that_are_not_the_keepers_are_left_to_cain():
    k, _ = keeper()
    k.on_interaction({"type": 3, "id": "i", "token": "t", "channel_id": DM, "user": {"id": OWNER},
                      "data": {"custom_id": "perm:allow:abcde"}, "message": {}})
    assert k.api.answers == []


def test_digest_covers_text_and_buttons():
    rows = components([[("Approve", "k:a:approve")]])
    assert card_digest("x", rows) != card_digest("y", rows)
    assert card_digest("x", rows) != card_digest("x", components([[("Approve", "k:a:decline")]]))


# -- the WebSocket and the gateway ---------------------------------------------

class FakeServer:
    """One end of a socketpair speaking the server side of RFC 6455."""

    def __init__(self):
        self.client, self.server = socket.socketpair()
        self.received = []

    def connect(self, host):
        return self.client

    def handshake(self):
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.server.recv(4096)
        key = next(l.split(":", 1)[1].strip() for l in buf.decode().split("\r\n")
                   if l.lower().startswith("sec-websocket-key"))
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        self.server.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                            f"Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode())

    def send(self, obj):
        data = json.dumps(obj).encode()
        head = bytes([0x81]) + (bytes([len(data)]) if len(data) < 126 else
                                bytes([126]) + struct.pack("!H", len(data)))
        self.server.sendall(head + data)

    def close(self, code):
        self.server.sendall(bytes([0x88, 2]) + struct.pack("!H", code))

    def recv(self):
        def read(n):
            out = b""
            while len(out) < n:
                out += self.server.recv(n - len(out))
            return out
        b1, b2 = read(2)
        assert b2 & 0x80, "client frames must be masked"
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack("!H", read(2))[0]
        mask, data = read(4), read(n)
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        if b1 & 0x0F == 0x8:
            return None
        return json.loads(data)


def test_gateway_identifies_with_no_intents_and_hands_presses_over():
    srv = FakeServer()
    presses, states = [], []
    gw = Gateway(lambda: TOKEN, presses.append, on_state=states.append, connect=srv.connect)
    done = threading.Event()

    def server():
        srv.handshake()
        srv.send({"op": 10, "d": {"heartbeat_interval": 60000}})
        ident = srv.recv()
        srv.received.append(ident)
        srv.send({"op": 0, "s": 1, "t": "READY", "d": {"session_id": "s",
                  "resume_gateway_url": "wss://gateway-x.discord.gg"}})
        srv.send({"op": 0, "s": 2, "t": "INTERACTION_CREATE", "d": {"type": 3, "id": "i"}})
        srv.close(4004)
        done.set()

    threading.Thread(target=server, daemon=True).start()
    with pytest.raises(Closed) as e:
        gw._session(TOKEN)
    assert e.value.code == 4004
    ident = srv.received[0]
    assert ident["op"] == 2 and ident["d"]["intents"] == 0
    assert presses == [{"type": 3, "id": "i"}]
    assert "ready" in states and gw.session_id == "s" and gw.seq == 2


def test_websocket_refuses_hosts_other_than_discords_gateway():
    with pytest.raises(Closed):
        WebSocket("wss://evil.example/?v=10")


def test_the_keepers_record_works_from_the_gateway_thread(tmp_path):
    # Presses and the probe run on the gateway thread; the keeper's record must not be
    # tied to the thread that opened it (the ledger's SQLite connection is).
    from harness.discord_keeper import KeeperStore
    store = KeeperStore(str(tmp_path / "discord.json"))
    k = DiscordKeeper(FakeAPI(), store.get, store.set, clock=lambda: 1000.0)
    errors = []

    def other():
        try:
            k.on_state("ready")
            msg = card(k)
            press(k, msg)
        except Exception as e:                     # pragma: no cover - the failure we guard
            errors.append(e)
    t = threading.Thread(target=other)
    t.start()
    t.join(5)
    assert not errors and store.get("discord_owner") == OWNER
    assert KeeperStore(str(tmp_path / "discord.json")).get("discord_dm") == DM


def test_a_failing_state_listener_does_not_drop_the_connection():
    def boom(state):
        raise RuntimeError("listener broke")
    gw = Gateway(lambda: TOKEN, lambda it: None, on_state=boom)
    gw._set("ready")
    assert gw.state == "ready"
