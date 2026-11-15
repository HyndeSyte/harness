"""The two-App update of C1 (plan 3.9), with Harness 0.23.0's own code: its link client,
chat and outbox as released (tests/fixtures/*_0_23_0.py, checked by sha256 against
the release, 4746b67), against a link that answers its old header as Cain 0.12.0's does
(503, nothing done). Then 0.24.0's code on the same database: every card delivered
once, one request id per card across all its retries, though its text gains the
"Delayed" line after 10 minutes. And the keys: the old relay key and the signing key
differ, and nothing signed with the old one is taken."""
import hashlib
import hmac
import importlib.util
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from conftest import OWNER

FIXTURES = Path(__file__).parent / "fixtures"
RELEASED = {   # sha256 of each file as released in Harness 0.23.0 (line ends as LF)
    "cain_relay_0_23_0.py": "24e224af9a7ce47d0659e63a54d92835bf68619d0d1dbeefc9c58059b228ec5d",
    "discord_chat_0_23_0.py": "a26e49c884aef5640796907fae8bfa038c243759e6e58778fad5a73168a7b52e",
    "outbox_0_23_0.py": "d6e5ef14825e0a04a7b9a6d40e245cee3af3b26fefc8998134029dba2a9c685e",
}
TOKEN = "test-bot-token-1234567890"
K_LEGACY = "636dcdfdc711234bb9fbc23475329e9e677ff695800ccea0035729b2ed4c1f43"
K_SIGN = "c04290ba7e3e31a6ec5a22a087eb898518b103206b9ec54b604d976972306b73"


def released(name):
    """A Harness 0.23.0 module, loaded inside the harness package (its relative imports
    resolve there), after its bytes are checked against the release."""
    path = FIXTURES / f"{name}_0_23_0.py"
    assert hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest() == RELEASED[path.name]
    spec = importlib.util.spec_from_file_location(f"harness.{name}_0_23_0", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class Link:
    """Cain 0.12.0's link, as far as the specialist sees it (link/main.ts, c1/contract.ts):
    the old header 503 and nothing done; a request signed with K_sign done once per id,
    its answer signed back; anything else refused."""

    def __init__(self):
        self.cards = {}             # card id -> (request id, text)
        self.done = {}              # request id -> (status, body)
        self.ids = []               # every signed request's id, in order
        self.legacy_503 = 0
        self.refused = 0
        self.lose_first_answer = False
        self.lock = threading.Lock()


def serve(link):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, body, rid=None):
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if rid is not None:
                mac = hmac.new(K_SIGN.encode(), "\n".join(["response", rid, str(status), body]).encode(), hashlib.sha256).hexdigest()
                self.send_header("x-harness-sig", "s=" + mac)
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(n).decode() if n else ""
            if hmac.compare_digest(self.headers.get("x-harness-key", ""), K_LEGACY):
                with link.lock:
                    link.legacy_503 += 1
                return self._send(503, json.dumps({"status": "upgrading"}))
            m = re.match(r"^id=([0-9a-f]{32}),t=([0-9]+),s=([0-9a-f]{64})$", self.headers.get("x-harness-sig") or "")
            want = m and hmac.new(K_SIGN.encode(), "\n".join(["request", "POST", self.path, m.group(1), m.group(2), raw]).encode(), hashlib.sha256).hexdigest()
            if not m or not hmac.compare_digest(m.group(3), want):
                with link.lock:
                    link.refused += 1
                return self._send(403, json.dumps({"status": "refused"}))
            rid = m.group(1)
            with link.lock:
                link.ids.append(rid)
                if rid in link.done:
                    return self._send(*link.done[rid], rid=rid)
                cid = len(link.cards) + 1
                link.cards[cid] = (rid, json.loads(raw)["text"])
                link.done[rid] = (200, json.dumps({"id": cid}))
                lose = link.lose_first_answer
            if lose:   # done, but the answer never verifies: the specialist must try again
                return self._send(200, json.dumps({"id": cid}))
            return self._send(*link.done[rid], rid=rid)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def enqueue(ledger, text):
    with ledger.tx() as db:
        return ledger.enqueue(chat_id=OWNER, kind="reply", text=text, db=db)


@pytest.fixture
def link():
    link = Link()
    httpd = serve(link)
    link.port = httpd.server_address[1]
    yield link
    httpd.shutdown()


def test_the_keys_differ_and_both_languages_agree():
    from harness.cain_relay import key_for, sign_key_for
    assert key_for(TOKEN) == K_LEGACY and sign_key_for(TOKEN) == K_SIGN and K_LEGACY != K_SIGN


def test_an_operation_keeps_its_id_whatever_its_body():
    from harness.cain_relay import request_id
    op = "outbox-7-2026-11-14T12:00:00+00:00"
    assert request_id("POST", "/card", '{"text": "a"}', op) == request_id("POST", "/card", '{"text": "Delayed. a"}', op)
    assert request_id("POST", "/card", '{"text": "a"}', op) == "ceb3c99fa1cad97f73e5e23b63cf5046"
    assert request_id("POST", "/card", '{"text": "a"}') != request_id("POST", "/card", '{"text": "b"}')


def test_a_request_signed_with_the_old_key_is_refused(link):
    from harness.cain_relay import CainLink, LinkError
    old = CainLink(lambda: TOKEN, host="127.0.0.1", port=link.port)
    import harness.cain_relay as relay
    real = relay.sign_key_for
    relay.sign_key_for = relay.key_for          # a caller that signs with the captured old key
    try:
        with pytest.raises(LinkError):
            old.card("x", [], "reply")
    finally:
        relay.sign_key_for = real
    assert link.refused == 1 and link.cards == {}


def test_old_harness_waits_through_503s_and_new_harness_delivers_each_card_once(ledger, clock, link):
    relay23, chat23, outbox23 = released("cain_relay"), released("discord_chat"), released("outbox")
    chat23.LinkError = relay23.LinkError        # its own client's errors, as in its own package
    rows = [enqueue(ledger, t) for t in ("one", "two", "three")]

    # Harness 0.23.0 against Cain 0.12.0's link: 503 every time, nothing done, nothing lost,
    # through repeated flushes, past 10 minutes, and a restart (a new outbox on the same database).
    ob = outbox23.Outbox(ledger, chat23.LinkChat(relay23.CainLink(lambda: TOKEN, host="127.0.0.1", port=link.port)),
                         sleep=lambda s: None)
    for i in range(6):
        if i == 3:
            ob = outbox23.Outbox(ledger, ob.api, sleep=lambda s: None)
        assert ob.flush() == 0
        clock.advance(seconds=601)
    for r in rows:
        row = ledger.outbox_row(r)
        assert row["state"] == "queued" and row["attempts"] >= 5, dict(row)
    assert link.legacy_503 >= 15 and link.cards == {} and link.ids == []

    # Harness 0.24.0 on the same database, with each first answer lost after the card was made:
    # the retry is the same request id, the link answers what it did, and no card is made twice.
    from harness.cain_relay import CainLink
    from harness.discord_chat import LinkChat
    from harness.outbox import Outbox
    late = enqueue(ledger, "four")              # one whose first try comes before 10 minutes
    link.lose_first_answer = True
    ob = Outbox(ledger, LinkChat(CainLink(lambda: TOKEN, host="127.0.0.1", port=link.port)), sleep=lambda s: None)
    assert ob.flush() == 0                      # every answer lost
    assert len(link.cards) == 4
    link.lose_first_answer = False
    clock.advance(seconds=700)                  # past the backoff, and "four" past 10 minutes
    assert ob.flush() == 4
    assert all(ledger.outbox_row(r)["state"] == "sent" for r in rows + [late])
    assert len(link.cards) == 4                 # once each
    assert len(set(link.ids)) == 4 and len(link.ids) == 8
    texts = [t for _, t in link.cards.values()]
    assert any(t.endswith("four") and "Delayed" not in t for t in texts)   # made on its first try
    assert sum("Delayed" in t for t in texts) == 3


def test_a_card_unsent_after_seven_days_is_dropped_never_retried_as_new(ledger, clock):
    """Cain's link remembers an operation 8 days (link/auth.ts KEEP_MS); the outbox stops after
    7, so a retry is never mistaken for a new card (C1 code review, C1-8). Before then it keeps
    trying, as it always has."""
    from harness.outbox import MAX_AGE_S, Outbox
    from fakes import FakeBot, chat_error
    assert MAX_AGE_S == 7 * 24 * 3600
    bot = FakeBot()
    bot.fail_sends = [chat_error(503, "down")] * 1000
    rid = enqueue(ledger, "an old card")
    ob = Outbox(ledger, bot, sleep=lambda s: None)
    assert ob.flush() == 0
    clock.advance(seconds=MAX_AGE_S - 3600)
    assert ob.flush() == 0 and ledger.outbox_row(rid)["state"] == "queued"     # still tried
    clock.advance(seconds=7200)
    tries = len(bot.fail_sends)
    assert ob.flush() == 0
    row = ledger.outbox_row(rid)
    assert row["state"] == "dead" and "7 days" in row["last_error"]
    assert len(bot.fail_sends) == tries                                         # not tried again
    kinds = [r["kind"] for r in ledger.db.execute("SELECT kind FROM events").fetchall()]
    assert "delivery_expired" in kinds


def test_a_card_dropped_after_seven_days_is_on_the_next_digest(ledger, clock):
    """Not only an event in the database: the digest Cain reads each morning (it is his to tell
    him) counts it by when it was dropped, though it was written a week before (C1 re-check)."""
    from harness import daily
    from harness.config import Config
    from harness.outbox import MAX_AGE_S, Outbox
    from fakes import FakeBot, chat_error
    bot = FakeBot()
    bot.fail_sends = [chat_error(503, "down")] * 1000
    enqueue(ledger, "an old card")
    ob = Outbox(ledger, bot, sleep=lambda s: None)
    config = Config(owner_user_id=OWNER, stage="S1")
    assert "couldn't be delivered" not in daily.gather(ledger, config, paused=False).text
    clock.advance(seconds=MAX_AGE_S + 3600)
    ob.flush()
    assert "1 message(s) couldn't be delivered" in daily.gather(ledger, config, paused=False).text
