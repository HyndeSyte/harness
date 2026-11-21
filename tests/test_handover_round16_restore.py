"""0.24.0, sixteenth round: the restore's defects from the fifteenth outside review (Nov 16).

4. --set-aside moves only what the swap's validated state says is in the way (its own conflicting sidecars at the
   live name), never names read out of the marker: every protected file a marker names is refused explicitly, the
   whole set is checked before anything moves, each file is copied and checked before its original goes, and the
   folder's name is unique.
5. A post-back flag in the older format counts as done only when that set's outbox delivered the post.
7. Cards held while fenced survive the swap: a real restart with a swap posts them back, unbuttoned, once.
8. A refusal is looked at again at each start; the degraded note backs off and the page says when it never went.
9. A refusal that can't be written into the marker is said; the marker write leaves the old marker whole on failure.
12. The post-back pruning, through after_restore.
All names and ids invented.
"""
import json
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import sys

import pytest

from harness import migrate, render
from harness.ledger import Ledger
from harness.outbox import Outbox
from fakes import FakeBot
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_handover_round13 import CLI, APP, restorable
from test_handover_round14_restore import kept_with_held_in_wal, notices_text
from test_handover_round15_restore import Web, killed_at, refused_for_a_foreign_log, snapshot
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def copy_line(monkeypatch):
    from harness import calendar_change
    monkeypatch.setattr(calendar_change, "_copy_line", lambda c, tz: c["title"])


def mark_conflict(target, names, refused="a test refusal"):
    swap = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    plan = json.loads(swap.read_text())
    plan.update(refused=refused, conflict=list(names))
    swap.write_text(json.dumps(plan))


# -- 4. set-aside derived from the swap's state ------------------------------------------------------------------

PROTECTED = ["harness.sqlite", "harness.sqlite.restore", "harness.sqlite.swap.json",
             "harness-replaced-20261116T090000Z.sqlite", "../outside.sqlite", "/etc/hostname", "..", "sub/dir"]


@pytest.mark.parametrize("name", PROTECTED)
def test_a_marker_naming_a_protected_file_moves_nothing_and_says_why(tmp_path, clock, name):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bprot" + str(PROTECTED.index(name)))
    folder = target.parent
    if name.startswith("harness-replaced-"):
        (folder / name).write_bytes(b"a kept set")
    mark_conflict(target, ["harness.sqlite-wal", name])                      # the real one, and a protected one
    before = snapshot(folder)
    got = migrate.set_aside(str(target), confirm=lambda q: pytest.fail("asked before the set was checked"))
    assert got["ok"] is False and "nothing was moved" in got["said"]
    assert any(r.startswith(name + ":") for r in got["refused"]), got
    assert snapshot(folder) == before and stray.exists()                      # the whole set checked first
    assert not [p for p in folder.iterdir() if p.name.startswith("harness-set-aside-")]


def test_the_records_own_log_is_refused_when_the_swaps_state_doesnt_say_its_foreign(tmp_path, clock):
    target = killed_at(tmp_path, clock, "marker", build="bownlog")           # nothing moved yet: the log is its own
    assert os.path.exists(str(target) + "-wal")
    mark_conflict(target, ["harness.sqlite-wal"])
    before = snapshot(target.parent)
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False and "records' own log" in got["said"]
    assert snapshot(target.parent) == before


def test_the_move_set_comes_from_the_state_not_the_marker(tmp_path, clock):
    """A marker that names nothing (its refusal never written) still gets the swap's own foreign log moved, and a
    marker naming a file that isn't in the way (gone) doesn't add it."""
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bstate")
    swap = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    plan = json.loads(swap.read_text())
    plan.pop("refused"), plan.pop("conflict")
    swap.write_text(json.dumps(plan))
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is True and got["moved"] == ["harness.sqlite-wal"] and not stray.exists()


def test_each_file_is_copied_and_checked_before_its_original_goes(tmp_path, clock, monkeypatch):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bcopy")
    real = shutil.copy2

    def torn(src, dst):
        real(src, dst)
        with open(dst, "ab") as f:
            f.write(b"!")                                                     # a copy that doesn't match
    monkeypatch.setattr(shutil, "copy2", torn)
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False and "didn't match" in got["said"]
    assert stray.read_bytes() == b"not its log"                               # the original stays
    assert json.loads(pathlib.Path(str(target) + migrate.SWAP_MARKER).read_text())["refused"]


def test_the_set_aside_folder_name_is_unique(tmp_path, clock):
    from datetime import datetime, timezone
    when = datetime(2026, 11, 16, 9, 0, tzinfo=timezone.utc)
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bunique")
    (target.parent / "harness-set-aside-20261116T090000Z-1").mkdir()          # one already there, same second
    got = migrate.set_aside(str(target), confirm=lambda q: "yes", now=when)
    assert got["ok"] is True and got["into"] == "harness-set-aside-20261116T090000Z-2"


# -- 8. a refusal looked at again at each start ----------------------------------------------------------------------

def test_a_refusal_whose_files_are_gone_clears_and_the_swap_goes_on(tmp_path, clock):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bgone")
    stray.unlink()                                                            # sorted by hand
    done = migrate.apply_staged_restore(str(target))
    assert done["ok"] is True and not pathlib.Path(str(target) + migrate.SWAP_MARKER).exists()


def run_degraded_failing_note(monkeypatch, tmp_path, tries):
    from harness import __main__ as main_mod
    seen, sent = {}, []

    class Chat:
        def __init__(self, link):
            pass

        def send_message(self, chat_id, text, buttons=None, **kw):
            sent.append(main_mod.time.monotonic())
            raise OSError("Cain's link is down")

        def answer_callback(self, callback, text=None):
            pass
    monkeypatch.setattr(main_mod, "LinkChat", Chat)
    monkeypatch.setattr(main_mod, "serve", lambda app, port: seen.setdefault("status", app.status) and Web(app)
                        or Web(app))
    monkeypatch.setattr(main_mod.handover, "serve", lambda inbox, port: None)
    monkeypatch.setattr(main_mod, "NOTE_RETRY_S", 0.01)
    monkeypatch.setattr(main_mod, "NOTE_RETRY_MAX_S", 0.04)
    monkeypatch.setattr(main_mod, "NOTE_TRIES", tries)
    real_sleep = main_mod.time.sleep
    turns = []

    def tick(s):
        turns.append(1)
        if len(turns) > 200 or (seen.get("status", {}).get("migration", {}).get("note") == "not delivered"
                                and len(turns) > len(sent) + 3):
            os.kill(os.getpid(), signal.SIGTERM)
        real_sleep(0.002)
    monkeypatch.setattr(main_mod.time, "sleep", tick)
    old = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
    try:
        main_mod.degraded(str(tmp_path), 0, "a test reason")
    finally:
        signal.signal(signal.SIGTERM, old[0])
        signal.signal(signal.SIGINT, old[1])
    return seen["status"], sent


def test_the_degraded_note_backs_off_and_the_page_says_when_it_never_went(tmp_path, monkeypatch):
    import queue
    from harness.setup_web import SetupApp, render_page
    from harness.vault import Vault
    status, sent = run_degraded_failing_note(monkeypatch, tmp_path, tries=4)
    assert len(sent) == 4                                                     # ten in the App; four here
    gaps = [b - a for a, b in zip(sent, sent[1:])]
    assert gaps[0] >= 0.01 and gaps[1] >= 0.02 and gaps[2] >= 0.04           # each wait doubles, to the cap
    assert status["migration"]["note"] == "not delivered"
    page = render_page(SetupApp(Vault(str(tmp_path / "s.json")), status, queue.Queue()), "u1", "Owner")
    assert "Note not delivered" in page and "after 4 tries" in page


# -- 9. a refusal the marker couldn't take, and the marker written whole ---------------------------------------------

def test_a_refusal_that_cant_be_written_into_the_marker_is_said_and_the_marker_stays_whole(tmp_path, clock,
                                                                                         monkeypatch):
    import queue
    from harness.setup_web import SetupApp, render_page
    from harness.vault import Vault
    target = killed_at(tmp_path, clock, "renamed", build="bunwritten")
    pathlib.Path(str(target) + "-wal").write_bytes(b"not its log")
    swap = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    whole = swap.read_bytes()
    real = migrate._write_json
    monkeypatch.setattr(migrate, "_write_json", lambda path, data: (_ for _ in ()).throw(OSError("ENOSPC"))
                        if "refused" in data else real(path, data))
    with pytest.raises(migrate.SwapRefused) as e:
        migrate.apply_staged_restore(str(target))
    monkeypatch.undo()
    assert e.value.marker_unwritten == "OSError" and swap.read_bytes() == whole
    status = {"migration": {"degraded": True, "why": str(e.value), "files": e.value.files,
                            "marker_unwritten": e.value.marker_unwritten}}
    page = render_page(SetupApp(Vault(str(tmp_path / "s.json")), status, queue.Queue()), "u1", "Owner")
    assert "refusal couldn&#x27;t be written into its marker" in page or "refusal couldn't be written" in page
    out = subprocess.run([sys.executable, "-I", "-c", CLI, str(APP), str(target), "--swap"],
                         capture_output=True, text=True, timeout=120)
    got = json.loads(out.stdout)
    assert got["refusal_not_recorded"] is True and got["conflict_now"] == ["harness.sqlite-wal"]


@pytest.mark.parametrize("fault", ["write", "fsync", "rename"])
def test_a_failed_marker_write_leaves_the_old_marker_whole(tmp_path, monkeypatch, fault):
    path = tmp_path / "harness.sqlite.swap.json"
    migrate._write_json(str(path), {"kept": "old", "done": ["moved"]})
    whole = path.read_bytes()
    if fault == "write":
        monkeypatch.setattr(migrate.json, "dump", lambda data, f: (f.write('{"kept": "ne'),
                                                                   (_ for _ in ()).throw(OSError("EIO")))[1])
    elif fault == "fsync":
        monkeypatch.setattr(migrate.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("EIO")))
    else:
        monkeypatch.setattr(migrate.os, "replace", lambda a, b: (_ for _ in ()).throw(OSError("EXDEV")))
    with pytest.raises(OSError):
        migrate._write_json(str(path), {"kept": "new", "done": ["moved", "moved-wal"]})
    monkeypatch.undo()
    assert path.read_bytes() == whole                                         # the old marker, whole
    assert not pathlib.Path(str(path) + ".tmp").exists()


# -- 5. a post-back flag in the older format -----------------------------------------------------------------------

def later_set_with_legacy_flag(folder, first, delivered_text):
    """The records a second restore set aside, holding the first set's post-back flag in the older format (no outbox
    row), and in its outbox the post itself, delivered or still queued."""
    later = folder / "harness-replaced-20261116T100000Z.sqlite"
    led = Ledger(str(later))
    with led.tx() as db:
        led.set_meta(f"{migrate.POSTED}{first.name}:p-one", json.dumps({"at": "2026-11-16T09:30:00+00:00"}), db)
        row = led.enqueue(chat_id=OWNER, kind="notice", text=delivered_text[0], db=db)
        db.execute("UPDATE outbox SET state=? WHERE id=?", (delivered_text[1], row))
    led.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    led.close()
    migrate._write_json(str(later) + migrate.POSTBACK, {"posted": ["summary"], "pending": None, "done": True})
    return later


@pytest.mark.parametrize("state", ["queued", "sent"])
def test_an_older_format_flag_counts_as_done_only_when_its_post_was_delivered(tmp_path, clock, copy_line, state):
    first = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261116T090000Z.sqlite", ids=("p-one",))
    migrate._write_json(str(first) + migrate.POSTBACK, {"posted": ["summary"], "pending": "p-one", "done": False})
    text = render.fit("A request that was waiting in the records set aside; ready to copy into the calendar app:\n"
                      "• Copy me p-one")
    later = later_set_with_legacy_flag(tmp_path, first, (text, state))
    led = Ledger(str(tmp_path / "harness.sqlite"), clock=clock)
    migrate._write_json(str(tmp_path / "harness.sqlite") + migrate.RESTORED,
                        {"from": "harness-before-s2-b-x.sqlite", "kept": later.name, "at": "20261116T100000Z"})
    migrate.after_restore(led, OWNER, TZ)
    now = notices_text(led)
    assert sum("Copy me p-one" in t for t in now) == (0 if state == "sent" else 1)   # reposted unless delivered
    assert not first.exists()                                                 # done, so pruned (the latest is kept)
    migrate.after_restore(led, OWNER, TZ)
    assert sum("Copy me p-one" in t for t in notices_text(led)) == (0 if state == "sent" else 1)   # once


# -- 12. the post-back pruning, through after_restore ----------------------------------------------------------------

def test_after_restore_posts_back_every_set_not_done_oldest_first_and_prunes_only_done_ones(tmp_path, clock,
                                                                                           copy_line):
    old = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261101T090000Z.sqlite", ids=("p-old",))
    mid = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261108T090000Z.sqlite", ids=("p-mid",))
    new = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261116T090000Z.sqlite", ids=("p-new",))
    migrate._write_json(str(mid) + migrate.POSTBACK, {"posted": ["summary", "p-mid"], "pending": None,
                                                      "done": True})
    led = Ledger(str(tmp_path / "harness.sqlite"), clock=clock)
    migrate._write_json(str(tmp_path / "harness.sqlite") + migrate.RESTORED,
                        {"from": "harness-before-s2-b-x.sqlite", "kept": new.name, "at": "20261116T090000Z"})
    real = migrate._post_back
    order = []

    def post_back(ledger, chat_id, tz, kept, frm):
        order.append(pathlib.Path(kept).name)
        return real(ledger, chat_id, tz, kept, frm)
    migrate._post_back = post_back
    try:
        got = migrate.after_restore(led, OWNER, TZ)
    finally:
        migrate._post_back = real
    assert order == [old.name, new.name]                                      # not the one already done
    said = notices_text(led)
    assert [t for t in said if "Copy me" in t] == [t for t in said if "Copy me p-old" in t] + \
        [t for t in said if "Copy me p-new" in t]                             # the older set first
    assert got["held"] == 2
    assert not old.exists() and not mid.exists() and new.exists()            # done ones pruned; the latest kept


def test_a_set_whose_post_back_fails_is_kept_for_the_next_start(tmp_path, clock, copy_line, monkeypatch):
    old = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261101T090000Z.sqlite", ids=("p-old",))
    new = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261116T090000Z.sqlite", ids=())
    migrate._write_json(str(new) + migrate.POSTBACK, {"posted": ["summary"], "pending": None, "done": True})
    led = Ledger(str(tmp_path / "harness.sqlite"), clock=clock)
    monkeypatch.setattr(migrate, "_swap_step", lambda phase: (_ for _ in ()).throw(RuntimeError(phase))
                        if phase == "posted:p-old" else None)
    with pytest.raises(RuntimeError):
        migrate.after_restore(led, OWNER, TZ)
    assert migrate.prune_kept(str(tmp_path)) == [] and old.exists()          # not done: never pruned
    monkeypatch.undo()
    monkeypatch.setattr(__import__("harness.calendar_change").calendar_change, "_copy_line", lambda c, tz: c["title"])
    migrate.after_restore(led, OWNER, TZ)
    assert sum("Copy me p-old" in t for t in notices_text(led)) == 1 and not old.exists()


# -- 7. cards held while fenced survive the swap ---------------------------------------------------------------------

def test_a_card_held_while_fenced_comes_back_after_a_real_restart_with_a_swap(tmp_path, clock):
    """A card with buttons queued in the same turn as the tap that staged the restore (before the fence), held by the
    fence; the App restarts, the swap sets those records aside, and the card's words come back once, unbuttoned
    (its buttons belonged to the records set aside), alongside the restart card that went out while fenced."""
    from harness import choices
    path, led = restorable(tmp_path, clock, build="bheld16")
    with led.tx() as db:
        nonce = choices.mint(led, kind="migration_clock", target="0", chat_id=OWNER, ttl_s=3600, db=db)
        led.enqueue(chat_id=OWNER, kind="notice", text="A card made in the same turn.",
                    buttons=[[("Card button", choices.callback_data(nonce))]],
                    binds=[{"type": "choice", "nonce": nonce}], db=db)
    said = migrate.restore_tapped(led, "1 bheld16", chat_id=OWNER)            # stages it, posts the restart card
    assert said.startswith("Ready")
    led.fence("staged")
    bot = FakeBot()
    Outbox(led, bot, sleep=lambda s: None).flush()
    assert [t for _, t, b, _ in bot.sent if "Restart Harness now" in t]       # the restart card goes out
    assert not [t for _, t, b, _ in bot.sent if "same turn" in t]             # the card with buttons is held
    led.unfence()
    led.close()
    swapped = migrate.apply_staged_restore(str(path))                         # the real restart: the swap
    assert swapped["ok"] is True
    new = Ledger(str(path), clock=clock)
    migrate.after_restore(new, OWNER, TZ)
    migrate.after_restore(new, OWNER, TZ)                                     # and a second start: still once
    bot2 = FakeBot()
    Outbox(new, bot2, sleep=lambda s: None).flush()
    back = [(t, b) for _, t, b, _ in bot2.sent if "A card made in the same turn." in t]
    assert len(back) == 1 and not back[0][1]                                  # once, unbuttoned
    assert "waiting to go out when the records were put back" in back[0][0]
    assert not [t for _, t, b, _ in bot2.sent if "Restart Harness now" in t]  # what went out isn't posted again
    new.close()
