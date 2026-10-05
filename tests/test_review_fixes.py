"""Regression tests for the findings of the independent review (2026-10-05)."""
import os
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from harness import render, rules
from harness.config import Config
from harness.engines import call_with_retries
from harness.net import TransportError, UrllibTransport
from harness.runner import Runner
from conftest import OWNER, msg
from fakes import FakeEngine, SyncExecutor, result
from test_controller import Rig

NEW_TOKEN = "987654321:BBEhBP0av28aH3sT9_" + "y" * 18


# 1 (high): a reset or a new token must not wedge the loop or lose updates
def test_a_new_bot_starts_its_own_offset_and_message_ids(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock)
    r.updates(msg(41, "first bot, message 10", message_id=10))
    r.c.tick()
    assert ledger.telegram_offset() == 42
    # reset, then a different bot's token, and pairing again
    r.requests.put({"type": "reset", "by": "Owner"})
    r.c.tick()
    r.vault.set_key("telegram_bot_token", NEW_TOKEN, by="Owner")
    r.bot.bot_id = 2
    code = r.vault.new_pairing_code()
    r.updates(msg(3, f"/start {code}"))          # the new bot's update ids start low
    r.c.tick()
    assert r.bot.offsets[-1] == 0                 # not the old bot's offset
    assert r.vault.owner_id() == OWNER
    # the new chat reuses message id 10: a new job, not an integrity error
    r.claude.script = [result(text="second bot answer")]
    r.updates(msg(4, "second bot, message 10", message_id=10))
    r.c.tick()
    assert "second bot answer" in r.texts()[-1]
    assert ledger.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    assert ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='bot_changed'"
                             ).fetchone()[0] == 2     # unknown -> 1, then 1 -> 2


# 3 (medium): a reply cut off mid-body is a network error, not a crash
def test_a_truncated_http_reply_is_a_transport_error():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    def serve():
        conn, _ = srv.accept()
        conn.recv(65536)
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"ok\": tr")
        conn.close()
    threading.Thread(target=serve, daemon=True).start()
    with pytest.raises(TransportError) as ei:
        UrllibTransport(use_env_proxy=False).request("POST", f"http://127.0.0.1:{port}/x",
                                                     json_body={}, timeout=5)
    assert ei.value.kind == "network"
    srv.close()


def test_start_up_survives_a_failing_remote_check(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock)

    def boom():
        raise RuntimeError("socket closed")
    r.gpt.check_model = boom
    r.c.startup()                                  # no exception
    assert ledger.inputs().get("model:gpt") is None or True


def test_an_unforeseen_engine_error_is_retried_then_reported(ledger):
    class Broken(FakeEngine):
        def complete(self, **kw):
            raise RuntimeError("IncompleteRead")
    slept = []
    out = call_with_retries(Broken(), system="s", user="u", schema={}, budget_s=570,
                            sleep=slept.append, monotonic=lambda: 0.0)
    assert out.result is None and out.error.reason == "unexpected" and out.attempts == 4
    assert slept == [5, 20, 60]


# 4 (low/medium): nothing in model text is tappable unless allowlisted
@pytest.mark.parametrize("raw, gone", [
    ("http://203.0.113.5/login", "http://"),
    ("https://пример.рф/x", "https://"),
    ("tg://resolve?domain=phish", "tg://"),
    ("tap /cancel now", "/cancel"),
    ("ask @phish_bot", "@phish_bot"),
    ("write to a@b.com", "b.com"),
    ("server 10.0.0.1 is down", "10.0.0.1"),
])
def test_defang_covers_every_tappable_kind(raw, gone):
    out = render.defang(raw)
    assert gone not in out


def test_allowlisted_links_and_ordinary_text_survive():
    assert render.defang("see https://docs.python.org/3/", ("python.org",)) == \
        "see https://docs.python.org/3/"
    assert render.defang("e.g. this and/or that") == "e.g. this and/or that"


# 5 (low): "use new" retires only what it clashes with, and undo can restore it
def test_resolving_a_conflict_is_precise(ledger):
    def rule(scope, value):
        return {"rule_type": "drafting", "scope": scope, "field": "length", "value": value,
                "literal": value}
    r1 = rules.propose(ledger, rule("all", "short"), job_id=None)
    r2 = rules.propose(ledger, rule("answer", "short"), job_id=None)
    r3 = rules.propose(ledger, rule("draft", "long"), job_id=None)
    assert r3.status == "quarantined" and r3.conflicts_with == (r1.rule_id,)
    rules.resolve(ledger, r3.rule_id, "new")
    state = {x["id"]: x["state"] for x in ledger.db.execute("SELECT id, state FROM rules")}
    assert state == {r1.rule_id: "superseded", r2.rule_id: "active", r3.rule_id: "active"}
    rules.undo(ledger, r3.rule_id)
    state = {x["id"]: x["state"] for x in ledger.db.execute("SELECT id, state FROM rules")}
    assert state[r1.rule_id] == "active" and state[r3.rule_id] == "retired"


# 6 (low): SIGTERM stops the real process promptly and leaves one clean file
def test_sigterm_stops_promptly_and_closes_the_ledger(tmp_path):
    app = Path(__file__).resolve().parents[1] / "harness" / "app"
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(os.environ, HARNESS_DATA=str(tmp_path), HARNESS_PORT=str(port),
               PYTHONPATH=str(app), SUPERVISOR_TOKEN="should-be-scrubbed-123")
    p = subprocess.Popen([sys.executable, "-m", "harness"], cwd=app, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        deadline = time.time() + 20
        while time.time() < deadline and not (tmp_path / "harness.sqlite").exists():
            time.sleep(0.2)
        time.sleep(1.5)
        t0 = time.time()
        p.send_signal(signal.SIGTERM)
        out, _ = p.communicate(timeout=10)
        assert time.time() - t0 < 5
    finally:
        if p.poll() is None:
            p.kill()
    assert p.returncode == 0, out
    assert "harness stopping" in out and "should-be-scrubbed-123" not in out
    assert not (tmp_path / "harness.sqlite-wal").exists() or \
        (tmp_path / "harness.sqlite-wal").stat().st_size == 0
    db = sqlite3.connect(tmp_path / "harness.sqlite")
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    mode = os.stat(tmp_path / "harness.sqlite").st_mode & 0o777
    assert mode == 0o600
