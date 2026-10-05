"""Restore drill: back up cold, keep working, restore, reconcile.

What a restore must do -- and say -- when Home Assistant restores the
add-on's /data from a backup:
  * the database is intact (integrity check);
  * work that was in flight at backup time fails loudly, with a receipt and
    a message, never hangs or silently resumes;
  * replies that were queued but unsent at backup time are still delivered;
  * rules and the pairing come back as they were;
  * anything after the backup is gone, and if the gap is longer than
    Telegram keeps updates, he is told continuity is unknown.
"""
import json
import shutil
from datetime import date, timedelta

from harness.config import Config
from harness.controller import Controller
from harness.ledger import Ledger
from harness.vault import Vault
from conftest import OWNER, msg
from fakes import FakeBot, FakeEngine, ManualExecutor, SyncExecutor, result, tg_error

TOKEN = "123456789:AAEhBP0av28aH3sT9_" + "x" * 18


def boot(data, clock, executor, bot, script=()):
    ledger = Ledger(str(data / "harness.sqlite"), clock=clock)
    vault = Vault(str(data / "secrets.json"), clock=clock)
    eng = FakeEngine("claude", script=list(script))
    c = Controller(ledger=ledger, vault=vault, api=bot,
                   engines={"claude": eng, "gpt": FakeEngine("gpt")}, executor=executor,
                   base_config=Config(owner_user_id=1, stage="S1",
                                      proactive_from=date(2026, 10, 20)),
                   sleep=lambda s: None, poll_timeout=0)
    today = clock().date().isoformat()
    with ledger.tx() as db:        # keep the daily canary and digest out of this drill
        ledger.set_meta("canary_date", today, db)
        ledger.set_meta("digest_date", today, db)
    c.startup()
    return c, ledger, vault, eng


def test_restore_drill(tmp_path, clock):
    data = tmp_path / "data"
    data.mkdir()
    v = Vault(str(data / "secrets.json"), clock=clock)
    v.set_key("telegram_bot_token", TOKEN, by="Owner")
    v.try_pair(v.new_pairing_code(), user_id=OWNER, chat_id=OWNER)

    # --- before the backup: one answered, one rule, one in flight, one unsent
    ex = ManualExecutor()
    bot = FakeBot()
    c, ledger, _, eng = boot(data, clock, ex, bot, script=[
        result({"type": "rule", "confirm": "ok", "rule": {
            "rule_type": "drafting", "scope": "draft", "field": "length",
            "value": "short", "literal": "short drafts"}})])
    bot.batches.append([msg(1, "keep drafts short")])
    c.tick()
    ex.run_all()
    c.tick()                                         # rule saved, reply sent
    assert len(bot.sent) == 1
    bot.batches.append([msg(2, "a slow question")])
    c.tick()                                         # running, worker held
    in_flight = ledger.jobs_in("running")[0]["id"]
    bot.fail_sends = [tg_error(502, "Bad Gateway")]
    with ledger.tx() as db:
        ledger.enqueue(chat_id=OWNER, kind="reply", text="queued before backup", db=db)
    c.outbox.flush()                                 # fails: stays queued
    offset_at_backup = ledger.telegram_offset()

    # --- cold backup: Home Assistant stops the add-on, then copies /data
    ledger.close()
    backup = tmp_path / "backup"
    shutil.copytree(data, backup)
    assert sorted(p.name for p in backup.iterdir()) == ["harness.sqlite", "secrets.json"]

    # --- life goes on after the backup (this work will be lost)
    c, ledger, _, _ = boot(data, clock, SyncExecutor(), FakeBot([[msg(3, "after backup")]]),
                           script=[result()])
    c.tick()
    assert ledger.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 3
    ledger.close()

    # --- two days later the backup is restored over /data
    clock.advance(days=2)
    shutil.rmtree(data)
    shutil.copytree(backup, data)
    bot2 = FakeBot()
    c, ledger, vault, _ = boot(data, clock, SyncExecutor(), bot2)
    assert ledger.integrity_ok()
    assert vault.owner_id() == OWNER                              # pairing came back
    assert ledger.telegram_offset() == offset_at_backup
    assert ledger.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    # in-flight work failed loudly at start-up, with a receipt
    assert ledger.job(in_flight)["state"] == "failed"
    assert json.loads(ledger.receipts(in_flight)[-1]["detail"])["reason"] == "interrupted"
    # the rule is intact
    [rule] = ledger.db.execute("SELECT * FROM rules WHERE state='active'").fetchall()
    assert rule["field"] == "length"
    c.tick()
    texts = bot2.texts()
    late = [t for t in texts if t.endswith("queued before backup")]   # unsent reply delivered,
    assert late and late[0].startswith("<i>Delayed: written ")        # marked as late
    assert any("restarted while working on it" in t for t in texts)
    assert any("Continuity unknown" in t for t in texts)         # the gap is > 24 h
    # every job has a terminal state with a receipt, or is still legitimately open
    for job in ledger.db.execute("SELECT * FROM jobs"):
        assert job["state"] in ("answered", "failed")
        assert ledger.receipts(job["id"])
