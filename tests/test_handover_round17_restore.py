"""0.24.0, seventeenth round: the restore side's defects from the sixteenth outside review (Nov 16).

4. The not-used restore path through a real restart without a swap: the card held by the fence goes out from the
   records as they are with its buttons bound, and a tap on it is carried out once.
7. --set-aside catches copy and fsync errors: the partial copy and the empty folder are removed, a plain reason is
   printed, the exit is non-zero and the swap marker is unchanged.
8. Held cards posted back after a swap promise nothing more; one whose time has passed is marked so.
9. The remaining source inspections of the restore start replaced by behavioural tests.
All names and ids invented.
"""
import errno
import json
import os
import pathlib
import queue
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import pytest

from harness import choices, migrate
from harness.chat import Incoming
from harness.ledger import Ledger
from harness.outbox import Outbox
from fakes import FakeBot
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_handover_round13 import APP, restorable
from test_handover_round15_restore import refused_for_a_foreign_log, run_degraded, snapshot
from fake_caldav import no_network  # noqa: F401  (autouse)


def held_card(led, text="A card made in the same turn.", ttl_s=3600):
    with led.tx() as db:
        nonce = choices.mint(led, kind="migration_clock", target="0", chat_id=OWNER, ttl_s=ttl_s, db=db)
        led.enqueue(chat_id=OWNER, kind="notice", text=text,
                    buttons=[[("Card button", choices.callback_data(nonce))]],
                    binds=[{"type": "choice", "nonce": nonce}], db=db)
    return nonce


def tap(led, nonce, message_id, update_id):
    inc = Incoming(update_id=update_id, kind="callback", user_id=int(OWNER), chat_id=int(OWNER), chat_type="private",
                   message_id=message_id, callback_id="", callback_data=choices.callback_data(nonce))
    return choices.verify_and_consume(led, inc, owner_user_id=int(OWNER))


# -- 4. the restore not used: a real restart without a swap ------------------------------------------------------

def test_a_restore_not_used_sends_the_held_card_bound_and_its_tap_is_taken_once(tmp_path, clock):
    path, led = restorable(tmp_path, clock, build="bnotused")
    nonce = held_card(led)
    said = migrate.restore_tapped(led, "1 bnotused", chat_id=OWNER)           # stages it, posts the restart card
    assert said.startswith("Ready")
    led.fence("staged")
    bot = FakeBot()
    Outbox(led, bot, sleep=lambda s: None).flush()
    assert [t for _, t, b, _ in bot.sent if "Restart Harness now" in t]       # the restart card goes out
    assert not [t for _, t, b, _ in bot.sent if "same turn" in t]             # the card with buttons is held
    led.unfence()
    led.close()
    staged = pathlib.Path(str(path) + migrate.RESTORE_SUFFIX)
    staged.write_bytes(b"not a database any more")                            # the staged copy can't be used
    got = migrate.apply_staged_restore(str(path))                             # the real restart: no swap
    assert got["ok"] is False and not pathlib.Path(str(path) + migrate.SWAP_MARKER).exists()
    assert pathlib.Path(str(staged) + ".refused").exists()
    live = Ledger(str(path), clock=clock)
    bot2 = FakeBot()
    Outbox(live, bot2, sleep=lambda s: None).flush()
    out = [(t, b, mid) for mid, (_, t, b, _) in enumerate(bot2.sent) if "same turn" in t]
    assert len(out) == 1 and out[0][1]                                        # sent once, with its buttons
    assert not any("waiting to go out when the records were put back" in t for _, t, b, _ in bot2.sent)
    row = live.db.execute("SELECT message_id, consumed_at FROM choices WHERE nonce=?", (nonce,)).fetchone()
    assert row["message_id"] is not None and row["consumed_at"] is None       # bound to the message it went in
    first = tap(live, nonce, row["message_id"], 81001)
    assert first.ok, first                                                    # his tap is taken
    second = tap(live, nonce, row["message_id"], 81002)
    assert not second.ok                                                      # and only once
    assert live.db.execute("SELECT COUNT(*) FROM events WHERE kind='choice'").fetchone()[0] == 1
    live.close()


# -- 7. --set-aside and a copy that fails ------------------------------------------------------------------------

def test_a_disk_full_copy_takes_back_the_partial_copy_and_the_folder(tmp_path, clock, monkeypatch):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bfull")
    marker = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    before_marker = marker.read_bytes()

    def full(src, dst):
        with open(dst, "wb") as f:
            f.write(b"not")                                                   # a partial copy
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(shutil, "copy2", full)
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False and got["said"].startswith("the disk is full")
    assert "the swap marker is as it was" in got["said"]
    assert stray.read_bytes() == b"not its log"                               # the original stays
    assert not list(target.parent.glob("harness-set-aside-*"))                # no partial copy, no empty folder
    assert marker.read_bytes() == before_marker                               # the refusal still recorded


def test_a_failed_fsync_of_the_copy_is_caught_too(tmp_path, clock, monkeypatch):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bfsync")
    before = snapshot(target.parent)
    real = os.fsync

    def fsync(fd):
        if os.path.basename(os.readlink(f"/proc/self/fd/{fd}")).endswith("-wal"):
            raise OSError(errno.EIO, "Input/output error")
        return real(fd)
    monkeypatch.setattr(os, "fsync", fsync)
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False and "couldn't be made (OSError)" in got["said"]
    assert snapshot(target.parent) == before                                  # as it was, byte for byte


CLI_FULL = (
    "import sys, runpy, shutil, errno, builtins\n"
    "sys.path.insert(0, sys.argv[1]); sys.argv = sys.argv[1:]\n"
    "def full(src, dst):\n"
    "    open(dst, 'wb').write(b'not')\n"
    "    raise OSError(errno.ENOSPC, 'No space left on device')\n"
    "shutil.copy2 = full\n"
    "builtins.input = lambda q: 'yes'\n"
    "runpy.run_module('harness.migrate', run_name='__main__', alter_sys=True)\n")


def test_the_command_line_says_why_and_exits_non_zero_on_a_full_disk(tmp_path, clock):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bclifull")
    marker = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    before_marker = marker.read_bytes()
    out = subprocess.run([sys.executable, "-I", "-c", CLI_FULL, str(APP), str(target), "--set-aside"],
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 1, out.stderr
    got = json.loads(out.stdout)
    assert got["ok"] is False and got["said"].startswith("the disk is full")
    assert marker.read_bytes() == before_marker and stray.exists()
    assert not list(target.parent.glob("harness-set-aside-*"))


# -- 8. held cards posted back after a swap ----------------------------------------------------------------------

def swapped_with(tmp_path, clock, build, cards):
    """Cards queued (held by the fence) in records that a restore then replaces; the restored ledger, started."""
    path, led = restorable(tmp_path, clock, build=build)
    for text, ttl in cards:
        held_card(led, text, ttl)
    assert migrate.restore_tapped(led, f"1 {build}", chat_id=OWNER).startswith("Ready")
    led.fence("staged")
    Outbox(led, FakeBot(), sleep=lambda s: None).flush()
    led.unfence()
    led.close()
    assert migrate.apply_staged_restore(str(path))["ok"] is True
    return Ledger(str(path), clock=clock)


def test_a_held_card_posted_back_promises_nothing_more(tmp_path, clock):
    new = swapped_with(tmp_path, clock, "bnopromise", [("Still current card.", 6 * 3600)])
    migrate.after_restore(new, OWNER, TZ)
    bot = FakeBot()
    Outbox(new, bot, sleep=lambda s: None).flush()
    (text,) = [t for _, t, b, _ in bot.sent if "Still current card." in t]
    assert "left off" in text
    for words in ("asks again", "ask again", "tap again", "send it again"):
        assert words not in text
    new.close()


def test_a_held_card_whose_time_has_passed_is_marked_so(tmp_path, clock):
    new = swapped_with(tmp_path, clock, "bexpired", [("A card that ran out.", 60), ("A card still good.", 6 * 3600)])
    clock.advance(hours=1)                                                    # the short one's buttons ran out
    migrate.after_restore(new, OWNER, TZ)
    bot = FakeBot()
    Outbox(new, bot, sleep=lambda s: None).flush()
    (gone,) = [t for _, t, b, _ in bot.sent if "A card that ran out." in t]
    (good,) = [t for _, t, b, _ in bot.sent if "A card still good." in t]
    assert "Its time has passed" in gone and "only for the record" in gone
    assert "Its time has passed" not in good
    new.close()


# -- 9. the restore start, behaviourally -------------------------------------------------------------------------

def test_main_hands_the_refusals_files_to_the_degraded_start(tmp_path, monkeypatch):
    from harness import __main__ as main_mod
    calls = []
    monkeypatch.setenv("HARNESS_DATA", str(tmp_path))
    monkeypatch.setattr(main_mod, "configure_logging", lambda: None)
    monkeypatch.setattr(main_mod, "scrub_environment", lambda: None)
    monkeypatch.setattr(main_mod, "build", lambda data_dir, port: (_ for _ in ()).throw(
        migrate.SwapRefused("a test refusal", files=["harness.sqlite-wal (5 bytes)"], marker_unwritten="EIO")))
    monkeypatch.setattr(main_mod, "degraded", lambda *a, **kw: calls.append((a, kw)) or 3)
    assert main_mod.main() == 3
    (args, kw), = calls
    assert kw["files"] == ["harness.sqlite-wal (5 bytes)"] and kw["marker_unwritten"] == "EIO"
    assert kw["lock_wait"] is False and "a test refusal" in args[2]


def test_main_starts_again_once_the_lock_comes_free(tmp_path, monkeypatch):
    from harness import __main__ as main_mod
    calls, builds = [], []
    monkeypatch.setenv("HARNESS_DATA", str(tmp_path))
    monkeypatch.setattr(main_mod, "configure_logging", lambda: None)
    monkeypatch.setattr(main_mod, "scrub_environment", lambda: None)

    def build(data_dir, port):
        builds.append(1)
        if len(builds) == 1:
            raise migrate.LockBusy("a restore is being staged")
        raise migrate.SwapRefused("then a refusal")
    monkeypatch.setattr(main_mod, "build", build)
    monkeypatch.setattr(main_mod, "degraded",
                        lambda *a, **kw: calls.append(kw) or ("retry" if len(calls) == 1 else 7))
    assert main_mod.main() == 7
    assert len(builds) == 2                                                   # the start went on by itself
    assert calls[0]["lock_wait"] is True and calls[1]["lock_wait"] is False


def test_the_page_shows_the_lock_wait(tmp_path):
    from harness.setup_web import SetupApp, render_page
    from harness.vault import Vault
    v = Vault(str(tmp_path / "s.json"))
    status = {"stage": "degraded", "migration": {"lock_wait": True, "lock_wait_since": "2026-11-16T09:00:00+00:00",
                                                 "lock_retry_s": 30}}
    page = render_page(SetupApp(v, status, queue.Queue()), "u1", "Owner")
    assert "Waiting for a restore being staged" in page and "tried again every 30 s" in page
    status["migration"] = {}
    assert "Waiting for a restore being staged" not in render_page(SetupApp(v, status, queue.Queue()), "u1", "Owner")
