"""The ledger's own schema version, and what each step to it does (0.24.0, fourth round).

The handover fixes change what a calendar card means, so cards and changes left by the version
before are swept once. That sweep is keyed to a version number kept in the ledger (meta
`ledger_schema`), never to the App's version: another change can ship the same App version first.
Each step also has its own done marker, so a ledger another change already moved to that version
still gets this step, once.

A step runs in one transaction with its done marker: a crash midway leaves the ledger as it was,
and the step runs again from the start. Each part of it is idempotent (it moves only rows still in
the state it moves from). The reads it needs (the calendar, for changes the version before left
approved or mid-write) come first, outside the transaction; a crash after them just reads again.

Step 2, the handover sweep:
  * every card still open from before is replaced: its buttons come off through the outbox, a tap
    on it is answered "Replaced when Harness updated. Nothing was done.", its request is closed;
  * every change the version before left approved or mid-write is read back from the calendar and
    recorded as done (with its receipt and Undo) or unverified (with a receipt saying so and Undo
    for what it wrote), and never written again;
  * then one message lists each request that was replaced or left unverified, a sentence each,
    with one Propose again button that puts each back on a card of its own, approved or declined
    on its own (after a read of its slot: one the calendar now shows is said as confirmed instead). An
    unverified one also joins the follow-up reads (calendar_change._recheck_unverified). One
    never started counts as done only if each part is an add whose event the calendar made after
    the approval (calendar_change.read_in_flight).
"""
from __future__ import annotations

import errno
import json
import logging
import os
import re
from datetime import datetime

from . import approvals, choices, effects, provenance, render
from .scrub import scrub as scrubbed   # twenty-sixth round: exception text, scrubbed
from .ledger import Ledger, iso

log = logging.getLogger("harness.migrate")

SCHEMA = "ledger_schema"           # meta: the ledger's schema version; none kept means 1
HANDOVER = 2
DONE = "migration_done:handover_sweep"
LISTED = "migration_listed:"       # + the batch: the proposals its Propose again brings back
PROPOSE_TTL_S = 7 * 24 * 3600
DRY_RUN = "migration_dry_run:"     # + build: the dry run's result for that build (ninth round)
DRY_RUN_LATEST = "migration_dry_run_latest"   # the newest dry run, whichever build ran it
# Tenth round: the install step won't migrate the live ledger without a dry run recorded for its own build.
# Eleventh round: it runs that dry run itself, on a copy of its own ledger, so a normal install never waits.
WAITING = "migration_waiting"      # {"build", "version", "at", "why"}: the live ledger waits (a failed dry run)
OVERRIDE = "migration_override:"   # + build: his tap on the override card, single use, logged with when
BACKUP = "migration_backup"        # {"path", "build", "schema", "at", "checksum"}: the newest backup
BACKUPS = "migration_backups"      # every backup kept beside the ledger, oldest first (eleventh round)
SUCCEEDED = "migration_succeeded"  # [{"build", "schema", "at"}]: the migrations that succeeded, newest last
BACKUP_KEEP = 3                    # backups kept beside the ledger, newest first, beyond the protected ones
DRY_RUN_WINDOW_S = 24 * 3600       # a dry run older than this counts as none (eleventh round)
RAN_A_DAY_S = 24 * 3600            # how long the ledger runs on a migration before its older backup may go
CANDIDATE_TIMEOUT_S = 120
CARD_TTL_S = 7 * 24 * 3600
# Twelfth round: time rules don't trust the wall clock alone.
UPTIME = "ledger_uptime_s"         # the App's run time, summed from monotonic heartbeats (heartbeat)
HEARTBEAT_S = 60                   # how often the run time is written to the ledger
CLOCK_FLOOR = (2026, 1, 1)         # a clock earlier than this day (UTC) hasn't been set: no time sync yet
REMINDED = "migration_waiting_reminded"     # the day the waiting reminder last went, in his zone
RESTORE_SUFFIX = ".restore"        # a staged restore beside the ledger, swapped in at the next start
# Thirteenth round: the restore swap, the process lock, free space, an interrupted move and the clock.
STAGE_MARKER = RESTORE_SUFFIX + ".json"   # written last when a restore is staged: the staged file is whole
SWAP_MARKER = ".swap.json"         # beside the ledger while a swap is under way: the next start finishes it
RESTORED = ".restored.json"        # beside the ledger after a swap, until the kept ledger's held requests are posted
MIGRATING = ".migrating"           # beside the ledger while the migration's transaction is open
LOCK_NAME = "harness.lock"         # the specialist holds it (flock) for as long as it runs
LOCK_WAIT_S = 120                  # fourteenth round: how long a start waits for a restore being staged to finish
POSTBACK = ".postback.json"        # beside a kept ledger: its held requests posted back, by key (fourteenth round)
SPACE_MARGIN = 16 * 1024 * 1024    # free space kept spare beyond two copies of the ledger
CLOCK_ACCEPTED = "migration_clock_accepted"   # {"at", "event_id"}: events up to that id don't count for the clock
CLOCK_TOLD = "migration_clock_told"            # the event id the clock card was last posted for
CLOCK_CARD_S = 600                 # a clock behind the newest event by more than this gets the card
FAILED_TOLD = "migration_failure_told:"        # + build: the failure was posted once

# The ledger's schema steps, in order: (number, name). A number is never reused for another step, and a ledger
# that records a step under a number with another name is refused (eleventh round): two changes that each
# claimed the same number would otherwise each take the other's step as done.
STEPS = ((HANDOVER, "handover_sweep"),)
STEP_DONE = "migration_step:"      # + number: the name of the step done under it


class StepConflict(Exception):
    pass


def check_steps(steps=STEPS, ledger: Ledger | None = None) -> None:
    """Refuses duplicate or conflicting schema step numbers: each number once, each name once, in rising order,
    above 1 (schema 1 is a ledger with none), and none the ledger recorded under another name."""
    seen_n: set = set()
    seen_name: set = set()
    last = 1
    for n, name in steps:
        if not isinstance(n, int) or n <= 1:
            raise StepConflict(f"schema step {n!r} ({name}) isn't a whole number above 1")
        if n in seen_n:
            raise StepConflict(f"schema step {n} is claimed twice")
        if name in seen_name:
            raise StepConflict(f"schema step {name} has two numbers")
        if n < last:
            raise StepConflict(f"schema step {n} ({name}) comes after step {last}")
        seen_n.add(n)
        seen_name.add(name)
        last = n
        if ledger is not None:
            kept = ledger.get_meta(f"{STEP_DONE}{n}")
            if kept is not None and kept != name:
                raise StepConflict(f"this ledger did schema step {n} as {kept}, not {name}")


def schema(ledger: Ledger) -> int:
    try:
        return int(ledger.get_meta(SCHEMA) or 1)
    except ValueError:
        return 1


def needed(ledger: Ledger, version: str | None = None, build: str | None = None) -> bool:
    """Whether a migration would change this ledger: a step not done yet, or the install step for a build
    this ledger hasn't been installed under."""
    from . import calendar_change as cal
    kept = cal._meta_json(ledger, cal.INSTALLED)
    return ledger.get_meta(DONE) is None or kept.get("version") != (version or cal.app_version()) \
        or kept.get("build") != (build or cal.app_build())


def dry_run_problem(ledger: Ledger, build: str) -> str:
    """Why the dry run kept for this build doesn't count (eleventh round), or "": it must have passed, have
    rehearsed the very schema version the live ledger is at, and be newer than DRY_RUN_WINDOW_S."""
    got = dry_run_for(ledger, build)
    if not got:
        return f"no migration dry run is recorded for build {build}"
    if not got.get("ok"):
        return f"the migration dry run recorded for build {build} failed ({got.get('said') or 'see the log'})"
    if got.get("source_schema") is None or str(got.get("source_schema")) != str(schema(ledger)):
        rehearsed = got.get("source_schema")
        return (f"the migration dry run for build {build} rehearsed schema "
                f"{'unknown' if rehearsed is None else rehearsed}, "
                f"and the ledger is at schema {schema(ledger)}")
    try:
        age = (ledger.now() - datetime.fromisoformat(got["at"])).total_seconds()
    except (KeyError, ValueError, TypeError):
        age = DRY_RUN_WINDOW_S + 1
    if age < 0:
        # Twelfth round: a record dated later than now means the clock moved; it doesn't count.
        return f"the migration dry run for build {build} is dated later than now, so the clock moved since"
    if age > DRY_RUN_WINDOW_S:
        return f"the migration dry run for build {build} is older than 24 hours"
    return ""


def failed_on_record(ledger: Ledger, build: str) -> dict:
    """The failed dry run kept for this build, {} when none (or it passed)."""
    got = dry_run_for(ledger, build)
    return got if got and not got.get("ok") else {}


def dry_run_missing(ledger: Ledger, build: str) -> str:
    """Why the live ledger may not be migrated for this build, or "": no valid dry run of this very build
    (dry_run_problem), and no override he tapped for it."""
    why = dry_run_problem(ledger, build)
    if not why or ledger.get_meta(OVERRIDE + build) is not None:
        return ""
    return why


def waiting(ledger: Ledger) -> dict:
    from . import calendar_change as cal
    return cal._meta_json(ledger, WAITING)


def self_dry_run(ledger: Ledger, version: str, build: str) -> dict:
    """Eleventh round: the specialist rehearses its own build's migration on a copy of its own ledger, inside
    its container (dry_run), and records it. What was kept. Thirteenth round: under the writer hold, the
    checkpoint and the copy both, before any transaction."""
    with ledger.hold_writers():
        checkpoint(ledger)
        got = dry_run(ledger.path, version=version, build=build, source=ledger.db)
    got.setdefault("build", build)
    got.setdefault("version", version)
    got["self_serve"] = True
    kept = record_dry_run(ledger, got)
    log.info("the migration dry run of build %s on a copy of the ledger: %s", build,
             "passed" if kept["ok"] else (got.get("said") or "failed"))
    return kept


def run_live(ledger: Ledger, cc, chat_id: int, version: str | None = None, build: str | None = None,
             tell: bool = False, retry: bool = False) -> dict:
    """The install step on the live ledger. Eleventh round: when a migration is needed and no valid dry run
    of this very build is recorded (dry_run_problem), the specialist runs one itself on a copy of its ledger
    and records it; on a pass it takes a backup and migrates at once, so a normal install never waits on
    anyone. Only a failed dry run leaves it waiting: calendar changes wait, and he's told once, with Run check
    (the dry run again) as the only button. His tap on an override card also lets it go (override_tapped).

    Twelfth round: all of it runs with every other writer of the ledger held off (Ledger.hold_writers: the
    poller, Discord taps and the handover service wait, open transactions drain first). The backup is taken
    with SQLite's online backup after a checkpoint, checked (integrity and row counts) before anything moves,
    and the migration is one transaction: it lands whole or not at all, and a stop midway leaves the ledger at
    its old schema with the backup beside it, so the next start migrates again."""
    from . import calendar_change as cal
    version, build = version or cal.app_version(), build or cal.app_build()
    try:
        with ledger.hold_writers():
            return _run_live(ledger, cc, chat_id, version, build, tell, retry)
    except TimeoutError as e:
        return _wait(ledger, chat_id, version, build, f"the ledger couldn't be held for the move ({scrubbed(e)})", tell)


def _run_live(ledger: Ledger, cc, chat_id: int, version: str, build: str, tell: bool,
              retry: bool = False) -> dict:
    marker = _side(ledger, MIGRATING)
    if marker and os.path.isfile(marker):
        damaged = _settle_marker(ledger, marker)
        if damaged:
            return _wait(ledger, chat_id, version, build, damaged, tell, degraded=True)
    if not needed(ledger, version, build):
        _remove_file(marker)
        _clear_waiting(ledger)
        return run(ledger, cc, chat_id, version, build)
    try:
        check_steps(STEPS, ledger)
    except StepConflict as e:
        return _wait(ledger, chat_id, version, build, f"the schema steps conflict: {scrubbed(e)}", tell)
    if marker and os.path.isfile(marker) and not retry:
        # Thirteenth round: the last start stopped in the middle of the move (its transaction never landed, so
        # the records are as they were). It isn't tried again by itself, so a move that kills the App can't
        # keep it from starting: it starts degraded, says so once, and waits for Run check or Put them back.
        return _wait(ledger, chat_id, version, build, "the last move of the records was interrupted before it "
                     "finished, so nothing was moved and the records are as they were before it", tell,
                     degraded=True)
    why = dry_run_missing(ledger, build)
    if why:
        self_dry_run(ledger, version, build)
        why = dry_run_missing(ledger, build)
    if why:
        return _wait(ledger, chat_id, version, build, why, tell)
    checkpoint(ledger)
    room = space_problem(ledger.path)
    if room:
        return _wait(ledger, chat_id, version, build, room, tell)
    copy = backup(ledger, build)
    if not copy:
        return _wait(ledger, chat_id, version, build, "the ledger couldn't be backed up and checked first", tell)
    _write_json(marker, {"build": build, "at": iso(ledger.now())})
    try:
        out = run(ledger, cc, chat_id, version, build,
                  finish=lambda db: (_clear_waiting(ledger, db), _succeeded(ledger, build, db)))
    except Exception as e:   # noqa: BLE001: a failed migration leaves the ledger as it was, and waits
        log.error("the migration of build %s failed: %s", build, type(e).__name__)
        _remove_file(marker)
        return _wait(ledger, chat_id, version, build, f"the migration failed ({type(e).__name__})", tell,
                     degraded=True)
    _remove_file(marker)
    if marker:
        prune_kept(os.path.dirname(marker))     # fourteenth round: older kept sets go once posted back and moved
    return {**out, "backup": copy}


def _settle_marker(ledger: Ledger, marker: str) -> str:
    """Fourteenth round: a migrating marker found at start. The ledger is checked whole (PRAGMA integrity_check);
    then, when the move it names had committed before the stop (the ledger's schema version is at the last step's
    and the install step is recorded for the marker's build), the marker is cleared and the start goes on as
    normal. Otherwise the marker stays and the interrupted move is handled as before. Why the ledger can't be
    used, or ""."""
    import sqlite3
    try:
        rows = ledger.db.execute("PRAGMA integrity_check").fetchall()
    except sqlite3.Error as e:
        return f"the records couldn't be checked after an interrupted move ({type(e).__name__})"
    if [r[0] for r in rows] != ["ok"]:
        return "the records failed their integrity check after an interrupted move"
    from . import calendar_change as cal
    said = _read_json(marker)
    target = max(n for n, _ in STEPS)
    kept = cal._meta_json(ledger, cal.INSTALLED)
    if schema(ledger) >= target and ledger.get_meta(DONE) is not None and said.get("build") \
            and kept.get("build") == said.get("build"):
        _remove_file(marker)
        log.warning("the move of build %s had finished before the App stopped; its marker was cleared",
                    said.get("build"))
        with ledger.tx() as db:
            ledger.event("migration_marker_settled", {"build": said.get("build")}, db=db)
    return ""


def _side(ledger: Ledger, suffix: str) -> str:
    """A file beside the ledger (thirteenth round), "" for a ledger in memory."""
    if not ledger.path or ledger.path == ":memory:":
        return ""
    return os.path.abspath(ledger.path) + suffix


def _write_json(path: str, data: dict) -> None:
    """Written whole or not at all: a temporary file, flushed to disk, renamed into place."""
    if not path:
        return
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        # Sixteenth round: a write, fsync or rename that fails leaves the file it would replace as it was.
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    _fsync_dir(os.path.dirname(os.path.abspath(path)))     # fourteenth round: the rename itself survives power loss


def _fsync_dir(folder: str) -> None:
    """Fourteenth round: a rename or removal is durable only once its folder's entry is on disk."""
    try:
        fd = os.open(folder, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _remove_file(path: str) -> None:
    if path:
        try:
            os.remove(path)
        except OSError:
            return
        _fsync_dir(os.path.dirname(os.path.abspath(path)))


# -- free space (thirteenth round) ------------------------------------------------------------------------------

def _free_bytes(folder: str) -> int:
    import shutil
    return shutil.disk_usage(folder).free


def space_problem(ledger_path: str, folder: str | None = None) -> str:
    """Why a copy of the ledger can't be made in `folder` (beside the ledger when none), or "": checked before the
    dry run's copy and the backup, so a full disk is said plainly and never leaves a half-written file. Room for
    two copies of the ledger and its log, plus SPACE_MARGIN. Fourteenth round: the size is the main file plus its
    -wal (callers checkpoint with TRUNCATE first, so the log is folded in and measured once), and the records set
    aside by restores (kept sets) are counted and named, since they take room until they're pruned."""
    if not ledger_path or ledger_path == ":memory:":
        return ""
    size = _set_size(os.path.abspath(ledger_path))
    need = 2 * size + SPACE_MARGIN
    where = folder or os.path.dirname(os.path.abspath(ledger_path))
    try:
        free = _free_bytes(where)
    except OSError:
        return "the free space for a copy of the records couldn't be read"
    if free < need:
        kept = sum(_set_size(p) for p in kept_sets(os.path.dirname(os.path.abspath(ledger_path))))
        held = (f"; {-(-kept // (1024 * 1024))} MB of it is records set aside by a restore (harness-replaced-*)"
                if kept else "")
        return (f"there isn't enough free space for a copy of the records ({free // (1024 * 1024)} MB free, "
                f"{-(-need // (1024 * 1024))} MB needed{held})")
    return ""


def _set_size(path: str) -> int:
    """A SQLite file with its -wal (fourteenth round: both, not the main file alone)."""
    size = 0
    for extra in ("", "-wal"):
        try:
            size += os.path.getsize(path + extra)
        except OSError:
            pass
    return size


def kept_sets(folder: str) -> list[str]:
    """The ledgers a restore set aside beside the records (harness-replaced-<time>[-n].sqlite), oldest first."""
    import glob
    return sorted(p for p in glob.glob(os.path.join(folder, "harness-replaced-*.sqlite")) if os.path.isfile(p))


def prune_kept(folder: str) -> list[str]:
    """Fourteenth round: older kept sets go, with their -wal, -shm and marker; the latest is always kept.
    Fifteenth round: a kept set goes only once its own post-back marker says done (every request held in it posted
    back); one that isn't is kept, counted in the space check, and posted back (oldest first) at the next start.
    What was removed."""
    sets = kept_sets(folder)
    gone = []
    for p in sets[:-1]:
        if not _read_json(p + POSTBACK).get("done"):
            continue
        for x in ("", "-wal", "-shm", POSTBACK):
            try:
                os.remove(p + x)
            except OSError:
                pass
        gone.append(os.path.basename(p))
    if gone:
        _fsync_dir(folder)
        log.info("records set aside by earlier restores were pruned: %s", ", ".join(gone))
    return gone


def _wait(ledger: Ledger, chat_id: int, version: str, build: str, why: str, tell: bool,
          degraded: bool = False) -> dict:
    """Nothing is migrated: calendar changes wait. He's told once per build (and again after a Run check tap
    that failed too), with Run check as the only button. Twelfth round: the notice's outbox row is kept, so
    one Discord never took is posted again (tend_waiting), and a reminder goes once a day while it waits."""
    kept = waiting(ledger)
    with ledger.tx() as db:
        first = kept.get("build") != build
        rec = {"build": build, "version": version, "at": iso(ledger.now()), "why": why,
               "since": kept.get("since") if not first and kept.get("since") else iso(ledger.now()),
               "notice": kept.get("notice") if not first else None, "degraded": degraded}
        if first:
            ledger.event("migration_waiting", {"build": build, "why": why, "degraded": degraded}, db=db)
        # Thirteenth round: a failed or interrupted move is posted once per build (and again only on his tap).
        told = degraded and ledger.get_meta(FAILED_TOLD + build) is not None
        if (first or tell) and chat_id and not (told and not tell):
            rec["notice"] = _post_waiting(ledger, chat_id, version, why, db, degraded=degraded)
            if degraded:
                ledger.set_meta(FAILED_TOLD + build, iso(ledger.now()), db)
        ledger.set_meta(WAITING, json.dumps(rec), db)
    log.warning("the live ledger wasn't migrated for build %s: %s; calendar changes wait for Run check (or "
                "keeper.sh fastpath migrate-check)", build, why)
    return {"waiting": True, "build": build, "why": why}


def _post_waiting(ledger: Ledger, chat_id: int, version: str, why: str, db, reminder: bool = False,
                  degraded: bool = False) -> int:
    """The Run check notice (or its daily reminder). Its outbox row id. Thirteenth round: a move that failed or
    was interrupted says so, and carries Put them back too when a backup of these records is kept."""
    nonce = choices.mint(ledger, kind="migration_check", target=version, chat_id=chat_id, ttl_s=CARD_TTL_S, db=db)
    buttons = [("Run check", choices.callback_data(nonce))]
    binds = [{"type": "choice", "nonce": nonce}]
    if degraded:
        newest = next((b for b in reversed(backups(ledger)) if os.path.isfile(str(b.get("path", "")))), None)
        if newest is not None:
            back = choices.mint(ledger, kind="migration_restore",
                                target=f"{newest.get('schema')} {newest.get('build')}",
                                chat_id=chat_id, ttl_s=CARD_TTL_S, db=db)
            buttons.append(("Put them back", choices.callback_data(back)))
            binds.append({"type": "choice", "nonce": back})
        head = (f"<b>Harness {render.escape(version)} couldn't move its records over.</b> "
                f"{render.escape(why[:1].upper() + why[1:])}. It runs on without them moved: the status page and "
                "Cain's health check say so, and calendar changes wait. Run check rehearses the move again and, if "
                "it passes, moves them, with a backup taken first."
                + (" Put them back restores the records from their newest backup instead." if len(buttons) > 1
                   else ""))
        return ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit(head), buttons=[buttons],
                              binds=binds, db=db)
    head = (f"<b>Still waiting: Harness {render.escape(version)} hasn't moved its records over yet.</b> "
            if reminder else
            f"<b>Harness {render.escape(version)} is installed, but hasn't moved its records over yet.</b> ")
    return ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit(
        head + "Before moving them it rehearses the move on a copy of them, and that rehearsal didn't pass: "
        f"{render.escape(why)}. So nothing was moved. Until it's done, calendar changes wait and nothing "
        "on your calendars changes. Run check rehearses it again, and if it passes the records are "
        "moved then, with a backup taken first."),
        buttons=[buttons], binds=binds, db=db)


def notice_state(ledger: Ledger) -> str:
    """Where the waiting notice is (twelfth round): "sent" (Discord took it), "queued" (being retried),
    "dead" (refused, posted again by tend_waiting), or "" when there's none."""
    rid = waiting(ledger).get("notice")
    if not rid:
        return ""
    row = ledger.db.execute("SELECT state FROM outbox WHERE id=?", (rid,)).fetchone()
    return "" if row is None else ("queued" if row["state"] in ("queued", "held") else row["state"])


def tend_waiting(ledger: Ledger, chat_id: int, tz: str = "UTC") -> str:
    """Each turn of the loop while the ledger waits (twelfth round): the outbox retries the notice with backoff
    while Cain's link or Discord doesn't answer; one refused for good (or never posted) is posted again; and
    once a day after the day it began (his day, in `tz`) a reminder with Run check goes. What it did: "",
    "reposted" or "reminded"."""
    from zoneinfo import ZoneInfo
    kept = waiting(ledger)
    if not kept or not chat_id:
        return ""
    zone = ZoneInfo(tz)
    today = ledger.now().astimezone(zone).date().isoformat()
    try:
        began = datetime.fromisoformat(kept.get("since") or kept["at"]).astimezone(zone).date().isoformat()
    except (KeyError, ValueError, TypeError):
        began = today
    state = notice_state(ledger)
    if state == "dead" or not kept.get("notice"):
        did = "reposted"
    elif began < today and ledger.get_meta(REMINDED) != today:
        did = "reminded"
    else:
        return ""
    with ledger.tx() as db:
        kept["notice"] = _post_waiting(ledger, chat_id, kept.get("version", ""), kept.get("why", ""), db,
                                       reminder=did == "reminded", degraded=bool(kept.get("degraded")))
        ledger.set_meta(WAITING, json.dumps(kept), db)
        if did == "reminded":
            ledger.set_meta(REMINDED, today, db)
        ledger.event(f"migration_waiting_{did}", {"build": kept.get("build", ""), "day": today}, db=db)
    log.info("the ledger still waits for its move: the Run check notice was %s", did)
    return did


def waiting_summary(ledger: Ledger) -> dict:
    """What the status page and Cain's /health show while the ledger waits (twelfth round); {} when not."""
    kept = waiting(ledger)
    if not kept:
        return {}
    return {"waiting": True, "build": kept.get("build", ""), "version": kept.get("version", ""),
            "why": kept.get("why", ""), "since": kept.get("since") or kept.get("at", ""),
            "notice": notice_state(ledger) or "none", "degraded": bool(kept.get("degraded"))}


def migration_summary(ledger: Ledger) -> dict:
    """Thirteenth round: what the status page and Cain's /health show: the wait (waiting_summary), a restore
    staged for the next start, and a pruning stall with the event that holds it. {} when none."""
    out = dict(waiting_summary(ledger))
    stall = clock_stall(ledger)
    if stall:
        out["pruning_stalled"] = stall
    if restore_staged(ledger.path):
        out["restore_staged"] = True
    return out


def _clear_waiting(ledger: Ledger, db=None) -> None:
    _remove_file(_side(ledger, MIGRATING))
    if ledger.get_meta(WAITING) is not None or ledger.get_meta(REMINDED) is not None:
        if db is not None:
            db.execute("DELETE FROM meta WHERE key IN (?, ?)", (WAITING, REMINDED))
            return
        with ledger.tx() as d:
            d.execute("DELETE FROM meta WHERE key IN (?, ?)", (WAITING, REMINDED))


def _succeeded(ledger: Ledger, build: str, db=None) -> None:
    """A migration that went through: kept with the run time then (for when an older backup may go), and its
    override used up."""
    done = _list(ledger, SUCCEEDED)
    done = (done + [{"build": build, "schema": schema(ledger), "at": iso(ledger.now()),
                     "uptime": uptime(ledger)}])[-10:]

    def write(d) -> None:
        ledger.set_meta(SUCCEEDED, json.dumps(done), d)
        if ledger.get_meta(OVERRIDE + build) is not None:
            d.execute("DELETE FROM meta WHERE key=?", (OVERRIDE + build,))   # single use
            ledger.event("migration_override_used", {"build": build}, db=d)
    if db is not None:
        write(db)
    else:
        with ledger.tx() as d:
            write(d)


# -- run time and the clock (twelfth round) -----------------------------------------------------------------

_BEAT: dict = {}


def heartbeat(ledger: Ledger, mono: float | None = None, force: bool = False, write: bool = True) -> float:
    """The App's run time, summed in the ledger from the monotonic clock, never the wall clock: each call adds
    the time since the last one (in this process), written at most every HEARTBEAT_S. The run time now.
    Fifteenth round: write=False (a staged restore fences the records) keeps summing in memory only."""
    import time as _t
    now = _t.monotonic() if mono is None else mono
    key = id(ledger)
    last = _BEAT.get(key)
    if last is None:
        _BEAT[key] = [now, 0.0]
        return uptime(ledger)
    step = max(0.0, now - last[0])
    last[0] = now
    last[1] += step
    if write and (last[1] >= HEARTBEAT_S or (force and last[1] > 0)):
        add, last[1] = last[1], 0.0
        total = uptime(ledger) + add
        with ledger.tx() as db:
            ledger.set_meta(UPTIME, f"{total:.1f}", db)
        return total
    return uptime(ledger) + last[1]


def uptime(ledger: Ledger) -> float:
    try:
        return max(0.0, float(ledger.get_meta(UPTIME) or 0))
    except ValueError:
        return 0.0


def clock_problem(ledger: Ledger) -> str:
    """Why the wall clock can't be trusted now, or "": earlier than the newest time the ledger recorded (the
    clock stepped back), or earlier than CLOCK_FLOOR (no time sync yet after a boot)."""
    return clock_stall(ledger).get("why", "")


def _floor():
    from datetime import timezone as _tz
    return datetime(*CLOCK_FLOOR, tzinfo=_tz.utc)


def clock_stall(ledger: Ledger) -> dict:
    """Thirteenth round: why the clock stops backup pruning, with the event that holds it: {"why", "event", "kind",
    "at", "now"} ({} when none). Events stamped earlier than CLOCK_FLOOR (written before a time sync) never count,
    nor events up to the one he accepted the clock over (accept_clock)."""
    now = ledger.now()
    if now < _floor():
        return {"why": "the clock isn't set yet", "event": None, "kind": "", "at": "", "now": iso(now)}
    try:
        upto = int(json.loads(ledger.get_meta(CLOCK_ACCEPTED) or "{}").get("event_id") or 0)
    except (ValueError, TypeError, AttributeError):
        upto = 0
    row = ledger.db.execute("SELECT id, kind, at FROM events WHERE id > ? AND at >= ? ORDER BY at DESC, id DESC "
                            "LIMIT 1", (upto, iso(_floor()))).fetchone()
    try:
        newest = datetime.fromisoformat(row[2]) if row and row[2] else None
    except ValueError:
        newest = None
    if newest is not None and now < newest:
        return {"why": "the clock is earlier than the newest time the ledger recorded", "event": row[0],
                "kind": row[1], "at": row[2], "now": iso(now), "behind_s": int((newest - now).total_seconds())}
    return {}


def accept_clock(ledger: Ledger, by: str) -> str:
    """His tap (or keeper.sh fastpath migrate-clock's card): the clock as it is now is taken as right; every event
    recorded so far stops counting for the clock rule, so pruning goes on. What to tell him."""
    stall = clock_stall(ledger)
    if not stall or stall.get("event") is None:
        return "The clock agrees with the records now, so nothing changed."
    top = ledger.db.execute("SELECT MAX(id) FROM events").fetchone()[0] or 0
    kept = {"at": iso(ledger.now()), "event_id": top, "over": stall.get("at", ""), "by": by}
    with ledger.tx() as db:
        ledger.set_meta(CLOCK_ACCEPTED, json.dumps(kept), db)
        ledger.event("migration_clock_accepted", kept, db=db)
    log.warning("the clock is taken as right by %s (it was behind the record stamped %s); backups are pruned again",
                by, stall.get("at", ""))
    return ("Done: Harness takes the clock as it is now. Older backups are pruned again from the next one, and "
            "records stamped later than now no longer hold it up.")


def post_clock_card(ledger: Ledger, chat_id: int, force: bool = False) -> bool:
    """The card with Use the clock as it is now (thirteenth round): once per event that holds the clock up, when
    it's behind by more than CLOCK_CARD_S (or on keeper.sh fastpath migrate-clock, force). Whether it went."""
    stall = clock_stall(ledger)
    if not chat_id or not stall or stall.get("event") is None:
        return False
    if not force and (stall.get("behind_s", 0) < CLOCK_CARD_S or ledger.get_meta(CLOCK_TOLD) == str(stall["event"])):
        return False
    with ledger.tx() as db:
        nonce = choices.mint(ledger, kind="migration_clock", target=str(stall["event"]), chat_id=chat_id,
                             ttl_s=CARD_TTL_S, db=db)
        ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit(
            "<b>Harness's clock is behind its own records, so old backups aren't pruned.</b> The clock says "
            f"{render.escape(stall['now'][:16].replace('T', ' '))} UTC, and a record "
            f"({render.escape(stall['kind'])}) is stamped {render.escape(stall['at'][:16].replace('T', ' '))} UTC. "
            "If the clock is right now, Use the clock as it is now lets pruning go on; nothing else changes."),
            buttons=[[("Use the clock as it is now", choices.callback_data(nonce))]],
            binds=[{"type": "choice", "nonce": nonce}], db=db)
        ledger.set_meta(CLOCK_TOLD, str(stall["event"]), db)
        ledger.event("migration_clock_card", {"event": stall["event"], "at": stall["at"]}, db=db)
    return True


def _list(ledger: Ledger, key: str) -> list:
    try:
        got = json.loads(ledger.get_meta(key) or "[]")
    except ValueError:
        return []
    return [x for x in got if isinstance(x, dict)] if isinstance(got, list) else []


def check_tapped(ledger: Ledger, cc, chat_id: int, target: str = "") -> str:
    """His Run check: the dry run of the running build again, inside the specialist, and on a pass the records
    are moved, backup first. What to tell him."""
    from . import calendar_change as cal
    if not waiting(ledger):
        return "Nothing is waiting for its records to move, so nothing changed."
    build = cal.app_build()
    got = self_dry_run(ledger, cal.app_version(), build)
    out = run_live(ledger, cc, chat_id, tell=True, retry=True) if got.get("ok") else \
        _wait(ledger, chat_id, cal.app_version(), build, dry_run_problem(ledger, build), True)
    if out.get("waiting"):
        return "The rehearsal didn't pass again, so nothing was moved; the message below says why."
    return "The rehearsal passed, so the records are moved now, with a backup taken first."


def request_override(ledger: Ledger, chat_id: int, by: str) -> tuple[str, str]:
    """Cain's keeper.sh fastpath migrate-override (eleventh round): it only posts him a card. The card says
    the migration is unrehearsed, why the dry run failed (when one is on record), and that a backup is taken
    first; the migration runs only on his tap, once, for this build. (status, said)."""
    from . import calendar_change as cal
    if not waiting(ledger):
        return "refused", "Nothing is waiting for a migration, so nothing changed."
    if not chat_id:
        return "refused", "There's no owner to ask, so nothing changed."
    build = cal.app_build()
    failed = failed_on_record(ledger, build)
    why = waiting(ledger).get("why") or dry_run_problem(ledger, build)
    target = f"{build} {'failed' if failed else 'none'}"
    with ledger.tx() as db:
        nonce = choices.mint(ledger, kind="migration_override", target=target, chat_id=chat_id,
                             ttl_s=CARD_TTL_S, db=db)
        said = (f"The rehearsal of this update on a copy of your records failed: {render.escape(why)}. "
                if failed else f"There's no passing rehearsal of this update on a copy of your records: "
                               f"{render.escape(why)}. ")
        ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit(
            "<b>Move Harness's records without a rehearsal?</b> " + said +
            "Move them anyway runs the move unrehearsed, for this update only and just once. A backup of the "
            "records is taken first, so they can be put back from it. Until then calendar changes wait."),
            buttons=[[("Move them anyway", choices.callback_data(nonce))]],
            binds=[{"type": "choice", "nonce": nonce}], db=db)
        ledger.event("migration_override_asked", {"build": build, "by": by, "failed_on_record": bool(failed)}, db=db)
    log.warning("migrate-override by %s: the owner has a card to move build %s's records unrehearsed", by, build)
    return "ok", ("He has a card to move the records without a rehearsal; they move only on his tap, with a "
                  "backup first. Nothing moved yet.")


def override_tapped(ledger: Ledger, cc, chat_id: int, target: str) -> str:
    """His tap on the override card: single use (the choice is consumed), tied to the build it was for, and
    refused when a failed dry run for that build is on record that the card didn't say."""
    from . import calendar_change as cal
    build, _, flag = (target or "").partition(" ")
    if build != cal.app_build():
        return "That card was for another update of Harness, so nothing moved."
    if not waiting(ledger):
        return "Nothing is waiting for its records to move, so nothing changed."
    if failed_on_record(ledger, build) and flag != "failed":
        with ledger.tx() as db:
            ledger.event("migration_override_refused", {"build": build}, db=db)
        return ("Not moved: a rehearsal failed after that card was made, and the card didn't say so. Nothing "
                "changed.")
    kept = {"build": build, "by": "owner tap", "at": iso(ledger.now()), "failed_on_record": flag == "failed"}
    with ledger.tx() as db:
        ledger.set_meta(OVERRIDE + build, json.dumps(kept), db)
        ledger.event("migration_override", kept, db=db)
    log.warning("the migration of build %s runs without a passing dry run: his tap on the override card", build)
    out = run_live(ledger, cc, chat_id, retry=True)
    if out.get("waiting"):
        with ledger.tx() as db:
            db.execute("DELETE FROM meta WHERE key=?", (OVERRIDE + build,))
        return f"The records couldn't be moved: {render.escape(out.get('why', 'see the log'))}. Nothing changed."
    return "Moved without a rehearsal, as you asked, with a backup taken first. That's kept in the log."


class OrderError(RuntimeError):
    """Thirteenth round: a checkpoint or a backup asked for inside a transaction, where it can't be done whole."""


def checkpoint(ledger: Ledger) -> None:
    """Folds the write-ahead log into the ledger file (twelfth round), so a copy starts from a settled file.
    The copy itself is still taken through SQLite (copy_ledger), which reads anything left in the log too.
    Thirteenth round: always under the writer hold and strictly before the migration's transaction, never inside
    one (OrderError), so the checkpoint can't find the ledger locked."""
    import sqlite3
    if ledger.db.in_transaction:
        raise OrderError("the checkpoint runs before the migration's transaction, never inside it")
    with ledger.hold_writers():
        try:
            # Fourteenth round: TRUNCATE, so the log is folded in and emptied and the space check measures once.
            row = ledger.db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        except sqlite3.Error as e:
            log.warning("the ledger's checkpoint before its copy didn't run: %s", type(e).__name__)
            return
    if row is not None and row[0]:
        log.warning("the ledger's checkpoint before its copy was busy; the copy still reads the log")


def copy_ledger(source, dest: str) -> None:
    """A copy of a live ledger with SQLite's online backup API (twelfth round): `source` an open connection
    or a file path (opened read only). Never a plain file copy, which could miss what's still in the log."""
    import os
    import sqlite3
    own = isinstance(source, str)
    src = sqlite3.connect(f"file:{os.path.abspath(source)}?mode=ro", uri=True) if own else source
    try:
        dst = sqlite3.connect(dest)
        try:
            with dst:
                src.backup(dst)
            dst.execute("PRAGMA journal_mode=DELETE")    # one self-contained file, with no log beside it
        finally:
            dst.close()
    finally:
        if own:
            src.close()


def table_counts(conn) -> dict:
    """Rows per table, for checking a copy against the live ledger."""
    names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE "
                                        "'sqlite_%' ORDER BY name").fetchall()]
    return {n: conn.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names}


def verify_copy(path: str, want: dict | None = None) -> str:
    """Why a copy can't be trusted, or "": SQLite's integrity check on it, and its rows per table against
    `want` (the live ledger's, taken under the same hold)."""
    import sqlite3
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error as e:
        return f"the copy couldn't be opened ({type(e).__name__})"
    try:
        got = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if got != "ok":
            return f"the copy failed its integrity check ({str(got)[:60]})"
        if want is not None:
            have = table_counts(conn)
            off = sorted(t for t in set(want) | set(have) if want.get(t) != have.get(t))
            if off:
                return "the copy's rows don't match the ledger's in " + ", ".join(off[:5])
        return ""
    except sqlite3.Error as e:
        return f"the copy couldn't be checked ({type(e).__name__})"
    finally:
        conn.close()


def _checksum_of(conn) -> str:
    import hashlib
    import sqlite3
    mem = sqlite3.connect(":memory:")
    try:
        conn.backup(mem)
        mem.execute("DELETE FROM meta WHERE key LIKE 'migration_%'")
        try:     # the migration's own messages to him (Run check, the override card) and their buttons
            for (nonce,) in mem.execute("SELECT nonce FROM choices WHERE kind LIKE 'migration_%'").fetchall():
                mem.execute("DELETE FROM outbox WHERE binds_json LIKE ?", (f"%{nonce}%",))
            mem.execute("DELETE FROM choices WHERE kind LIKE 'migration_%'")
        except sqlite3.Error:
            pass
        for sql in ("DELETE FROM events WHERE kind LIKE 'migration_%'", "DELETE FROM sqlite_sequence",
                    f"DELETE FROM meta WHERE key='{UPTIME}'"):
            try:
                mem.execute(sql)
            except sqlite3.Error:
                pass
        h = hashlib.sha256()
        for line in mem.iterdump():
            h.update(line.encode("utf-8", "replace"))
        return h.hexdigest()
    finally:
        mem.close()


def content_checksum(ledger: Ledger) -> str:
    """The ledger's content, without the migration's own bookkeeping (backups, dry runs, waiting, its run
    time, and its own messages and buttons): so a ledger nothing else changed in reads the same across
    repeated attempts."""
    return _checksum_of(ledger.db)


def content_checksum_file(path: str) -> str:
    """The same content checksum, of a backup file itself (twelfth round: dedup is computed on the backup)."""
    import sqlite3
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return _checksum_of(conn)
    finally:
        conn.close()


def backups(ledger: Ledger) -> list[dict]:
    return _list(ledger, BACKUPS)


def _protected(ledger: Ledger, kept: list[dict]) -> set[str]:
    """Eleventh round: for each source schema version, its oldest backup stays until a later migration has
    succeeded and the ledger has run on it for a day. Twelfth round: that day is the App's run time summed in
    the ledger (heartbeat), never the wall clock; a migration recorded without it never counts as settled."""
    done = _list(ledger, SUCCEEDED)
    ran = uptime(ledger)
    out: set[str] = set()
    oldest: dict = {}
    for b in kept:
        oldest.setdefault(str(b.get("schema")), b)
    for b in oldest.values():
        settled = False
        for d in done:
            try:
                after = d["at"] > b["at"] and ran - float(d["uptime"]) >= RAN_A_DAY_S
            except (KeyError, ValueError, TypeError):
                after = False
            settled = settled or after
        if not settled:
            out.add(b["path"])
    return out


def backup(ledger: Ledger, build: str) -> str:
    """A restorable copy of the live ledger, taken just before a migration: beside the ledger file, named for
    the source schema version, the build and the time (eleventh round). Twelfth round: taken with every other
    writer held off (Ledger.hold_writers), after a checkpoint, with SQLite's online backup API (copy_ledger),
    then checked (integrity, and rows per table against the live ledger) before anything moves; its content
    checksum is computed on the backup file itself. No new one when that matches the newest backup's
    (repeated attempts). The newest BACKUP_KEEP are kept, and for each schema version its oldest until a later
    migration has run a day of run time (_protected); nothing is pruned while the clock can't be trusted
    (clock_problem). Its path, or "" when it couldn't be made and checked (then nothing is migrated). To
    restore: restore_backup (python3 -m harness.migrate <ledger> --restore <schema> <build>), DOCS.md."""
    import os
    import sqlite3
    if not ledger.path or ledger.path == ":memory:":
        return ""
    if ledger.db.in_transaction:
        raise OrderError("the backup is taken before the migration's transaction, never inside it")
    checkpoint(ledger)                       # fourteenth round: the log folded in before the room is measured
    room = space_problem(ledger.path)
    if room:
        log.error("the ledger backup before the migration wasn't made: %s", room)
        return ""
    with ledger.hold_writers():
        src_schema = schema(ledger)
        folder = os.path.dirname(os.path.abspath(ledger.path))
        stamp = ledger.now().strftime("%Y%m%dT%H%M%SZ")
        safe = _safe_build(build)
        dest = os.path.join(folder, f"harness-before-s{src_schema}-{safe}-{stamp}.sqlite")
        n = 1
        while os.path.exists(dest):
            n += 1
            dest = os.path.join(folder, f"harness-before-s{src_schema}-{safe}-{stamp}-{n}.sqlite")
        part = dest + ".part"
        checkpoint(ledger)
        try:
            copy_ledger(ledger.db, part)
            problem = verify_copy(part, table_counts(ledger.db))
            checksum = "" if problem else content_checksum_file(part)
        except (sqlite3.Error, OSError) as e:
            problem, checksum = f"the backup couldn't be made ({type(e).__name__})", ""
        if problem:
            _remove(part)
            log.error("the ledger backup before the migration failed: %s", problem)
            return ""
        kept = [b for b in backups(ledger) if os.path.isfile(b.get("path", ""))]
        if kept and kept[-1].get("checksum") == checksum:
            _remove(part)
            newest = kept[-1]
            newest["builds"] = sorted(set(newest.get("builds") or []) | {build})   # restore finds it by this build too
            with ledger.tx() as db:
                ledger.set_meta(BACKUPS, json.dumps(kept), db)
                ledger.event("migration_backup_same", {"path": os.path.basename(newest["path"]), "build": build},
                             db=db)
            log.info("the ledger matches its newest backup (%s): no new backup", os.path.basename(newest["path"]))
            return newest["path"]
        os.replace(part, dest)
        entry = {"path": dest, "build": build, "schema": src_schema, "at": iso(ledger.now()), "checksum": checksum,
                 "uptime": uptime(ledger)}
        kept.append(entry)
        clock = clock_problem(ledger)
        keep = {b["path"] for b in kept} if clock else \
            {b["path"] for b in kept[-BACKUP_KEEP:]} | _protected(ledger, kept)
        if clock:
            stall = clock_stall(ledger)
            log.warning("no backup is pruned now: %s (record %s, stamped %s)", clock, stall.get("event"),
                        stall.get("at", ""))
        for b in kept:
            if b["path"] not in keep:
                _remove(b["path"])
        kept = [b for b in kept if b["path"] in keep]
        with ledger.tx() as db:
            ledger.set_meta(BACKUPS, json.dumps(kept), db)
            ledger.set_meta(BACKUP, json.dumps(entry), db)
            ledger.event("migration_backup", {"path": os.path.basename(dest), "build": build, "schema": src_schema,
                                              "checked": True}, db=db)
    log.info("ledger backed up and checked before the migration of build %s (schema %d): %s", build, src_schema,
             os.path.basename(dest))
    return dest


def _safe_build(build: str) -> str:
    return "".join(c for c in (build or "") if c.isalnum())[:32] or "unknown"


def _remove(path: str) -> None:
    import os
    for p in (path, path + "-wal", path + "-shm", path + "-journal"):
        try:
            os.remove(p)
        except OSError:
            pass


def run(ledger: Ledger, cc, chat_id: int, version: str | None = None, build: str | None = None,
        finish=None) -> dict:
    """Every step not done yet, in order, then the install step. What it did, for the log and tests.
    Twelfth round: one transaction for all of it (the steps, the schema version, the install step and
    `finish`, run_live's own bookkeeping), so it lands whole or is rolled back whole. The calendar reads it
    needs come first, outside it."""
    check_steps(STEPS, ledger)
    sweep = ledger.get_meta(DONE) is None
    reads = _read_in_flight(ledger, cc) if sweep else {}
    with ledger.tx() as db:
        if sweep:
            out = _sweep(ledger, cc, chat_id, reads, db)
            ledger.set_meta(DONE, iso(ledger.now()), db)
            ledger.set_meta(f"{STEP_DONE}{HANDOVER}", "handover_sweep", db)
            ledger.set_meta(SCHEMA, str(max(schema(ledger), HANDOVER)), db)
        else:
            if schema(ledger) < HANDOVER:
                ledger.set_meta(SCHEMA, str(HANDOVER), db)
            out = {}
        done = install(ledger, cc, version, build, db=db)
        if finish is not None:
            finish(db)
    if sweep:
        log.info("ledger schema %d: %d card(s) replaced, %d change(s) read back done, %d unverified",
                 HANDOVER, out["replaced"], out["done"], out["unverified"])
    if done:
        _install_log(ledger, done)
        out = {**out, "install": done}
    return out


def record_dry_run(ledger: Ledger, got: dict) -> dict:
    """A dry run's result, kept in the live ledger (ninth round): keyed by the build it rehearsed, with the
    checksum of the ledger copy it ran on, whether it passed and when. Eleventh round: with the schema version
    of the copy it ran on (source_schema), which the live ledger must still be at for it to count. What was
    kept."""
    from . import calendar_change as cal
    kept = {"source_schema": got.get("schema_before"), "said": got.get("said", ""),
            "self_serve": bool(got.get("self_serve")),"build": got.get("build") or cal.app_build(), "version": got.get("version") or cal.app_version(),
            "checksum": got.get("checksum", ""), "ok": bool(got.get("ok")), "at": iso(ledger.now()),
            "copy_of": got.get("copy_of", ""), "candidate": got.get("candidate", ""),
            "ran_by": cal.app_build()}
    with ledger.tx() as db:
        ledger.set_meta(DRY_RUN + kept["build"], json.dumps(kept), db)
        ledger.set_meta(DRY_RUN_LATEST, json.dumps(kept), db)
        ledger.event("migration_dry_run", kept, db=db)
    return kept


def dry_run_for(ledger: Ledger, build: str) -> dict:
    """The dry run kept for a build (record_dry_run), {} when none."""
    try:
        got = json.loads(ledger.get_meta(DRY_RUN + build) or "{}")
    except ValueError:
        return {}
    return got if isinstance(got, dict) else {}


def install(ledger: Ledger, cc, version: str | None = None, build: str | None = None, db=None) -> dict:
    """Once per build the ledger starts under (0.24.0, seventh and eighth rounds), keyed to the version and
    the build identifier kept in the ledger (calendar_change.INSTALLED), so every install gets it, a
    rebuild of the same version included, and a restart doesn't: the no-card paths go off if they were on,
    a smoke run started before ends (its id gives no Turn on), every Turn on card still open comes off,
    and the card path's gate is set: each calendar's cards are held until the smoke run has read back a
    fenced edit and a series-day edit there (calendar_change.closed_providers). {} when this build was
    already installed here."""
    from . import calendar_change as cal
    version = version or cal.app_version()
    build = build or cal.app_build()
    kept = cal._meta_json(ledger, cal.INSTALLED)
    if kept.get("version") == version and kept.get("build") == build:
        return {}
    now = iso(ledger.now())
    dry = dry_run_for(ledger, build)
    latest = cal._meta_json(ledger, DRY_RUN_LATEST)
    out = {"version": version, "build": build, "from": kept.get("version", ""), "from_build": kept.get("build", ""),
           "fast_path_off": False, "run_closed": False, "cards_retired": 0,
           "dry_run": bool(dry.get("ok")), "dry_run_checksum": dry.get("checksum", ""),
           "latest_dry_run": {k: latest.get(k) for k in ("build", "ok", "at", "checksum")} if latest else {}}
    if db is None:
        with ledger.tx() as d:
            got = install(ledger, cc, version, build, db=d)
        if got:
            _install_log(ledger, got)
        return got
    if cal.fast_path(ledger).get("on") is True:
        cal.set_fast_path(ledger, False, cal.fast_path(ledger).get("smoke", ""), by="install", db=db)
        out["fast_path_off"] = True
    run = cal.smoke_run(ledger)
    if run.get("id") and not run.get("closed"):
        run.update(closed=now, closed_why="install")
        if run.get("late_probe") == "pending":
            run["late_probe"] = ""
        ledger.set_meta(cal.SMOKE_RUN, json.dumps(run), db)
        out["run_closed"] = True
    out["cards_retired"] = cal.retire_turn_on(ledger, db)
    ledger.set_meta(cal.CARD_GATE, json.dumps({"version": version, "build": build, "at": now, "verified": {},
                                               "seen": {}, "blocked": {}, "override": {}}), db)
    ledger.set_meta(cal.INSTALLED, json.dumps({"version": version, "build": build, "schema": schema(ledger),
                                               "at": now}), db)
    ledger.event("calendar_install", out, db=db)
    return out


def _install_log(ledger: Ledger, out: dict) -> None:
    from . import calendar_change as cal  # noqa: F401
    version, build = out["version"], out["build"]
    dry = dry_run_for(ledger, build)
    latest = cal._meta_json(ledger, DRY_RUN_LATEST)
    log.info("installed %s (build %s): no-card paths %s, smoke run %s, %d Turn on button(s) off; cards are held "
             "for the smoke run", version, build, "off" if out["fast_path_off"] else "unchanged",
             "ended" if out["run_closed"] else "none open", out["cards_retired"])
    # Ninth round: whether a migration dry run was recorded in this ledger for this very build.
    if out["dry_run"]:
        log.info("a migration dry run was recorded for build %s (ledger copy checksum %s, %s)", build,
                 dry.get("checksum", "")[:16], dry.get("at", ""))
    elif latest:
        # The dry run runs the migration of the build installed when it ran, so before an update it's
        # usually the build before's: said with its build, its result and when.
        log.warning("no migration dry run was recorded for build %s itself; the latest was by build %s, %s, at %s",
                    build, latest.get("build", ""), "ok" if latest.get("ok") else "not ok", latest.get("at", ""))
    else:
        log.warning("no migration dry run was recorded before build %s was installed", build)


def dry_run(path: str, version: str | None = None, build: str | None = None, source=None) -> dict:
    """The migration run on a copy of the ledger at `path`, never on the file itself (eighth round: a gate
    Cain runs on the Pi before a Ship card). The file is opened read only and copied with SQLite's own
    backup into a temporary file, which is migrated with no calendars (a change left in flight is counted,
    not read) and then deleted. What it found: the schema version, whether the no-card paths are off,
    the gate as set, how many Turn on cards are still open, and how many rows it touched.

    Twelfth round: the copy is taken with SQLite's online backup API (copy_ledger), from `source` (the live
    connection, after a checkpoint, when the specialist rehearses itself) or else the file opened read only,
    which still reads anything left in the write-ahead log; never a plain file copy. The copy is checked
    (integrity) before it's migrated, and its rows per table before the migration are in the answer."""
    import os
    import sqlite3
    import tempfile
    from . import calendar_change as cal
    if not path or not os.path.isfile(path):
        return {"ok": False, "said": f"no ledger file at {path or '(none given)'}"}
    room = space_problem(path, tempfile.gettempdir())     # thirteenth round: before any copy is started
    if room:
        return {"ok": False, "said": room, "build": build or cal.app_build(), "version": version or cal.app_version()}
    tmp = tempfile.mkdtemp(prefix="harness-migrate-check-")
    copy = os.path.join(tmp, "ledger-copy.sqlite")
    try:
        copy_ledger(source if source is not None else path, copy)
        problem = verify_copy(copy)
        if problem:
            return {"ok": False, "said": problem}
        import hashlib
        with open(copy, "rb") as f:
            checksum = hashlib.sha256(f.read()).hexdigest()   # the copy as it was before the migration ran
        led = Ledger(copy)
        rows_before = table_counts(led.db)
        before_schema = schema(led)
        before = led.db.total_changes
        in_flight = len(_in_flight(led.db))
        out = run(led, None, 0, version=version, build=build)
        touched = led.db.total_changes - before
        gate = cal.card_gate(led)
        open_turn_on = led.db.execute("SELECT COUNT(*) FROM choices WHERE kind='calendar_change_fast_on' AND"
                                      " consumed_at IS NULL").fetchone()[0]
        result = {"ok": True, "copy_of": path, "checksum": checksum, "build": build or cal.app_build(),
                  "version": version or cal.app_version(), "schema_before": before_schema, "schema": schema(led),
                  "fast_path_on": cal.fast_path_on(led), "gate_set": bool(gate),
                  "gate_closed": cal.closed_providers(led) if gate else [],
                  "open_turn_on_cards": open_turn_on, "rows_touched": touched,
                  "cards_replaced": (out.get("replaced") or 0), "in_flight_not_read": in_flight,
                  "install": out.get("install") or {}, "rows_before": rows_before}
        led.db.close()
        return result
    except sqlite3.Error as e:
        return {"ok": False, "said": f"the ledger copy couldn't be read: {type(e).__name__}"}
    except Exception as e:   # noqa: BLE001: a migration that breaks on the copy is a failed dry run
        return {"ok": False, "said": f"the migration broke on the copy ({type(e).__name__})",
                "build": build or cal.app_build(), "version": version or cal.app_version()}
    finally:
        for f in os.listdir(tmp):
            try:
                os.remove(os.path.join(tmp, f))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass


def candidate_layout(path: str) -> tuple[str, str] | None:
    """Where a candidate build's package is (tenth round): (the folder holding the harness package, the App
    folder or ""). A source tree is the App folder (harness/, with app/harness/migrate.py); an image path
    is its /opt/harness (harness/migrate.py and BUILD_ID beside it). None when neither."""
    import os
    if os.path.isfile(os.path.join(path, "app", "harness", "migrate.py")):
        return os.path.join(path, "app"), path
    if os.path.isfile(os.path.join(path, "harness", "migrate.py")):
        return path, ""
    return None


def candidate_dry_run(path: str, candidate: str) -> dict:
    """The incoming build's own migration rehearsed on a copy of the ledger at `path` (tenth round): the
    candidate's package (a source tree or an image path, candidate_layout) is run in a separate Python,
    isolated from this one (-I), as python3 -m harness.migrate <path>, which copies the ledger and migrates
    only the copy. Its answer carries the candidate's own build id, computed by its own code, which is what
    that build's install step looks for. The ledger file itself is only read."""
    import os
    import subprocess
    import sys
    where = candidate_layout(candidate) if candidate and os.path.isdir(candidate) else None
    if where is None:
        return {"ok": False, "said": f"no build to rehearse at {candidate or '(none given)'}: give the App folder "
                                     "of a source tree, or an image's /opt/harness"}
    app, _ = where
    code = ("import sys, runpy; sys.path.insert(0, sys.argv[1]); sys.argv = ['harness.migrate', sys.argv[2]]; "
            "runpy.run_module('harness.migrate', run_name='__main__', alter_sys=True)")
    try:
        done = subprocess.run([sys.executable, "-I", "-c", code, app, path], capture_output=True, text=True,
                              timeout=CANDIDATE_TIMEOUT_S, cwd=app)
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "said": f"the candidate's migration couldn't be run ({type(e).__name__})"}
    try:
        got = json.loads(done.stdout or "{}")
    except ValueError:
        got = {}
    if not isinstance(got, dict) or not got.get("build"):
        return {"ok": False, "said": "the candidate's migration gave no answer it could read (exit "
                                     f"{done.returncode})", "candidate": candidate}
    got["candidate"] = candidate
    got["ok"] = bool(got.get("ok")) and done.returncode == 0
    return got


def _in_flight(db) -> list:
    """Changes the version before left approved (not started) or mid-write."""
    return db.execute(
        "SELECT p.*, x.state AS x_state, x.settle_json, x.undo_json FROM proposals p"
        " LEFT JOIN calendar_changes x ON x.proposal_id=p.id WHERE p.effect_type=? AND"
        " (p.state IN ('approved','auto_approved') OR (p.state='executing' AND x.state IN ('sending','settling')))"
        " ORDER BY p.created_at", (effects.CALENDAR_CHANGE,)).fetchall()


def _read_in_flight(ledger: Ledger, cc) -> dict:
    """{proposal: ("done" | "unverified", the undo entries a read found landed)}. Reads only."""
    out = {}
    if cc is None:
        return out
    for p in _in_flight(ledger.db):
        out[p["id"]] = cc.read_in_flight(p)
    return out


def _sweep(ledger: Ledger, cc, chat_id: int, reads: dict, db) -> dict:
    listed: list[tuple[str, str]] = []           # (proposal, its sentence)
    replaced = done = unverified = 0
    for p in db.execute("SELECT * FROM proposals WHERE state='proposed' ORDER BY created_at").fetchall():
        if not approvals.supersede(ledger, p["id"], db=db, outcome="updated"):
            continue
        replaced += 1
        job = db.execute("SELECT state FROM jobs WHERE id=?", (p["job_id"],)).fetchone()
        if job is not None and job["state"] == "proposed":
            ledger.transition(p["job_id"], "cancelled", db=db,
                              receipt=json.dumps({"reason": "replaced_by_update"}))
        if p["effect_type"] == effects.CALENDAR_CHANGE:
            listed.append((p["id"], _sentence(ledger, p, cc, "its card was replaced")))
    for p in _in_flight(db):
        verdict, landed, parts = reads.get(p["id"], ("unverified", [], []))
        if cc is None:
            continue
        cc.record_in_flight(db, p, verdict, landed, parts)
        if verdict == "done":
            done += 1
        else:
            unverified += 1
            listed.append((p["id"], _sentence(ledger, p, cc, "not confirmed after the update, so not written again")))
    if listed and cc is not None:
        _listing(ledger, chat_id, listed, db)
    return {"replaced": replaced, "done": done, "unverified": unverified, "listed": len(listed)}


def _sentence(ledger: Ledger, p, cc, why: str) -> str:
    """One request, as he'd know it: his message quoted, what it was for, and what happened."""
    root = ledger.get_meta(f"job_parent:{p['job_id']}") or p["job_id"]
    text = ledger.job_text(root) or ledger.job_text(p["job_id"])
    his = text.split("\n\n[A suggestion from Cain", 1)[0]
    try:
        changes = json.loads(p["params_json"])["changes"]
        what = "; ".join(render.change_line(c, cc.tz, ledger.now()) for c in changes)
    except (ValueError, KeyError, TypeError):
        what = "a calendar change"
    quote = provenance.one_line(his, 100)
    head = f"Your message “{render.escape(quote)}”: " if quote else ""
    return f"{head}{render.escape(render.plain(what))} ({why})."


def _listing(ledger: Ledger, chat_id: int, listed: list[tuple[str, str]], db) -> None:
    """One message listing each request, with one Propose again button: a tap consumes every button on
    its message (choices.py), so the choice per request is on the cards it brings back (0.24.0, fifth
    round): each request comes back on its own card, approved or declined on its own, and the listing
    says so."""
    batch = f"{len(listed)}-{iso(ledger.now())}"
    ledger.set_meta(LISTED + batch, json.dumps([pid for pid, _ in listed]), db)
    nonce = choices.mint(ledger, kind="calendar_change_propose_again", target=batch, chat_id=chat_id,
                         ttl_s=PROPOSE_TTL_S, db=db)
    lines = ["<b>Harness updated.</b> These calendar requests were left from the version before, and "
             "nothing more was done with them:"]
    lines += [f"{i}. {s}" for i, (_, s) in enumerate(listed, 1)]
    lines.append("Propose again puts each one back on a card of its own, so you can approve one and decline "
                 "another. One the calendar already shows by then is said as confirmed instead.")
    ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit("\n".join(lines)),
                   buttons=[[("Propose again", choices.callback_data(nonce))]],
                   binds=[{"type": "choice", "nonce": nonce}], db=db)


def listed(ledger: Ledger, batch: str) -> list[str]:
    try:
        got = json.loads(ledger.get_meta(LISTED + batch) or "[]")
    except ValueError:
        return []
    return [str(x) for x in got] if isinstance(got, list) else []


# -- the process lock (thirteenth round) ----------------------------------------------------------------------

_LOCK: dict = {}                   # folder -> the open lock file the specialist holds


def _try_lock(folder: str):
    """The lock file beside the records, flocked exclusively, or None when another open file holds it."""
    import fcntl
    f = open(os.path.join(folder, LOCK_NAME), "a+")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def hold_process_lock(ledger_path: str, wait_s: float = 0) -> bool:
    """The specialist takes LOCK_NAME beside the ledger (an exclusive flock) before it reads any marker or swaps,
    and keeps it while it runs. Fourteenth round: the restore command line takes the same lock while it stages
    (stage_restore), so a start waits up to `wait_s` for a staging under way to finish. Whether it has it."""
    import time as _time
    folder = os.path.dirname(os.path.abspath(ledger_path))
    if folder in _LOCK:
        return True
    until = _time.monotonic() + max(0.0, wait_s)
    told = False
    while True:
        f = _try_lock(folder)
        if f is not None:
            _LOCK[folder] = f
            return True
        if _time.monotonic() >= until:
            log.error("another process holds %s beside the ledger", LOCK_NAME)
            return False
        if not told:
            log.warning("a restore is being staged beside the records (%s is held): waiting for it", LOCK_NAME)
            told = True
        _time.sleep(0.2)


def release_process_lock(ledger_path: str) -> None:
    f = _LOCK.pop(os.path.dirname(os.path.abspath(ledger_path)), None)
    if f is not None:
        f.close()


def specialist_running(ledger_path: str) -> bool:
    """Whether a process holds the specialist's lock file beside this ledger (not this one's own hold). Only a
    hint for status: stage_restore takes the lock itself rather than asking this first."""
    folder = os.path.dirname(os.path.abspath(ledger_path))
    if folder in _LOCK:
        return True
    if not os.path.isfile(os.path.join(folder, LOCK_NAME)):
        return False
    f = _try_lock(folder)
    if f is None:
        return True
    f.close()
    return False


def _stage_step(phase: str) -> None:
    """A point in the staging a test can pause or stop at (fourteenth round). Nothing in production."""


# -- restore (twelfth and thirteenth rounds) --------------------------------------------------------------------

def find_backup(ledger_path: str, schema_n: int, build: str) -> str:
    """The newest backup beside the ledger taken at that source schema version before that build's migration
    (named harness-before-s<schema>-<build>-<time>.sqlite), or "" when there's none. The ledger itself is only
    read (opened read only), for a backup kept under another build (backup's dedup)."""
    import glob
    folder = os.path.dirname(os.path.abspath(ledger_path))
    found = sorted(p for p in glob.glob(os.path.join(folder, f"harness-before-s{int(schema_n)}-{_safe_build(build)}-*"
                                                                ".sqlite")) if not p.endswith(".part"))
    if found:
        return found[-1]
    import sqlite3
    if not os.path.isfile(ledger_path):
        return ""
    try:
        conn = sqlite3.connect(f"file:{os.path.abspath(ledger_path)}?mode=ro", uri=True)
        try:
            row = conn.execute("SELECT value FROM meta WHERE key=?", (BACKUPS,)).fetchone()
        finally:
            conn.close()
        kept = json.loads(row[0]) if row else []
    except (sqlite3.Error, ValueError, TypeError):
        kept = []
    for b in reversed(kept if isinstance(kept, list) else []):
        if isinstance(b, dict) and str(b.get("schema")) == str(int(schema_n)) and build in (b.get("builds") or []) \
                and os.path.dirname(os.path.abspath(str(b.get("path", "")))) == folder \
                and os.path.isfile(str(b.get("path", ""))):
            return str(b["path"])
    return ""


def restore_staged(ledger_path: str) -> bool:
    """A restore is staged whole for the next start: its file and, written last, its marker."""
    if not ledger_path or ledger_path == ":memory:":
        return False
    staged = os.path.abspath(ledger_path) + RESTORE_SUFFIX
    return os.path.isfile(staged) and os.path.isfile(os.path.abspath(ledger_path) + STAGE_MARKER)


def stage_restore(ledger_path: str, schema_n: int, build: str, cli: bool = False) -> dict:
    """Restore, keyed by schema and build: the backup find_backup names is checked (integrity) and copied with
    SQLite's backup API to <ledger>.restore beside the ledger, then its marker <ledger>.restore.json is written
    last. Thirteenth round: it never touches the live ledger (it only reads it, for find_backup), and all swapping
    is done by the specialist at its next start, before it opens the ledger (apply_staged_restore). From the
    command line (cli) it refuses while the specialist runs, which holds LOCK_NAME."""
    try:
        n = int(schema_n)
    except (TypeError, ValueError):
        return {"ok": False, "said": "the schema version is a whole number"}
    # Fourteenth round: the same kernel lock as the specialist (an exclusive flock on harness.lock beside the
    # records, so on the same volume), held from finding the backup until the marker is on disk. The specialist
    # itself already holds it (its own tap); anyone else takes it or is refused, never only asks whether it's held.
    folder = os.path.dirname(os.path.abspath(ledger_path))
    if folder in _LOCK:
        return _stage_locked(ledger_path, n, build)
    lock = _try_lock(folder)
    if lock is None:
        return {"ok": False, "said": "Harness is running (it holds harness.lock beside the records), so nothing was "
                                     "staged: while it runs, ask through Cain (keeper.sh fastpath migrate-restore), "
                                     "which puts a card to the owner; or stop the App first"}
    try:
        return _stage_locked(ledger_path, n, build)
    finally:
        lock.close()


def _stage_locked(ledger_path: str, n: int, build: str) -> dict:
    """stage_restore with harness.lock held."""
    import sqlite3
    base = os.path.abspath(ledger_path)
    if os.path.isfile(base + SWAP_MARKER):
        return {"ok": False, "said": "a restore swap beside the records hasn't finished; Harness finishes it when it "
                                     "starts, so nothing new was staged"}
    _stage_step("locked")
    chosen = find_backup(ledger_path, n, build)
    if not chosen:
        return {"ok": False, "said": f"no backup beside the ledger for schema {n} and build {build}"}
    problem = verify_copy(chosen)
    if problem:
        return {"ok": False, "said": f"that backup can't be used: {problem}", "backup": os.path.basename(chosen)}
    staged, marker = base + RESTORE_SUFFIX, base + STAGE_MARKER
    _remove_file(marker)
    _remove(staged)
    room = space_problem(chosen)
    if room:
        return {"ok": False, "said": room, "backup": os.path.basename(chosen)}
    part = staged + ".part"
    try:
        copy_ledger(chosen, part)
        problem = verify_copy(part)
        if problem:
            raise OSError(problem)
        os.replace(part, staged)
        _fsync_dir(os.path.dirname(base))
        _stage_step("staged")
        _write_json(marker, {"from": os.path.basename(chosen), "schema": n, "build": build})   # fsynced, dir too
    except (sqlite3.Error, OSError) as e:
        _remove(part)
        _remove(staged)
        return {"ok": False, "said": f"the backup couldn't be staged ({type(e).__name__})"}
    log.warning("restore staged from %s: it replaces the ledger at the App's next start", os.path.basename(chosen))
    return {"ok": True, "staged": os.path.basename(staged), "backup": os.path.basename(chosen),
            "said": "Staged. It replaces the records the next time Harness starts, before it opens them; the records "
                    "it replaces are kept beside them, and the restored ones move to this build again."}


class SwapRefused(RuntimeError):
    """Fourteenth round: the swap found files at the live name it doesn't own, or both ends of a move present. The
    App then starts degraded with this reason instead of opening the records beside a log that isn't theirs.
    Fifteenth round: `files` lists what's at the live and kept names (for the status page and the command line),
    and `conflict` the files that stopped it, which `--set-aside` moves into a dated folder."""

    def __init__(self, why: str, *, files: list | None = None, conflict: list | None = None,
                 marker_unwritten: str = ""):
        super().__init__(why)
        self.files = list(files or [])
        self.conflict = list(conflict or [])
        self.marker_unwritten = marker_unwritten   # sixteenth round: why the refusal isn't in the marker, or ""


class LockBusy(SwapRefused):
    """Fifteenth round: harness.lock was still held after LOCK_WAIT_S (a restore being staged): the start waits
    degraded and tries the lock again on a timer."""


def swap_files(ledger_path: str) -> list[str]:
    """Fifteenth round: the files at the records' live name, the staged restore's, the swap's markers and every
    kept set beside them, each with its size, for sorting a swap out by hand. Nothing is opened or moved."""
    import glob
    base = os.path.abspath(ledger_path)
    folder = os.path.dirname(base)
    names = [base + x for x in SIDECARS] + [base + RESTORE_SUFFIX, base + STAGE_MARKER, base + SWAP_MARKER,
                                            base + RESTORED, base + RESTORE_SUFFIX + ".refused"]
    names += sorted(glob.glob(os.path.join(folder, "harness-replaced-*")))
    out = []
    for n in names:
        if os.path.lexists(n):
            try:
                size = os.path.getsize(n)
            except OSError:
                size = -1
            out.append(f"{os.path.basename(n)} ({size} bytes)")
    return out


def _refused(base: str, plan: dict | None, why: str, conflict: list[str]) -> SwapRefused:
    """A SwapRefused with the listing; the reason and the conflicting files are recorded in a readable marker
    (atomically), so the command line's --set-aside knows what was refused. An unreadable marker is never touched.
    Sixteenth round: a refusal that couldn't be written into the marker is said (marker_unwritten), on the degraded
    page and in the command line's listing, which derives the conflict from the swap's state either way."""
    swap = base + SWAP_MARKER
    unwritten = ""
    if plan is not None and plan.get("kept"):
        plan = dict(plan, refused=why, conflict=[os.path.basename(c) for c in conflict])
        try:
            _write_json(swap, plan)
        except OSError as e:
            unwritten = type(e).__name__
            log.error("the swap's refusal couldn't be written into its marker (%s); the old marker stays as it was",
                      unwritten)
    return SwapRefused(why, files=swap_files(base), conflict=[os.path.basename(c) for c in conflict],
                       marker_unwritten=unwritten)


def _swap_step(phase: str) -> None:
    """A point in the swap a test can stop at, as a crash would (thirteenth round). Nothing in production."""


SIDECARS = ("", "-wal", "-shm")          # a SQLite file and its log, paired by name the way SQLite pairs them


def apply_staged_restore(ledger_path: str, now: datetime | None = None) -> dict:
    """At startup, with harness.lock held and before the ledger opens (thirteenth round): a staged restore is
    swapped in. A swap marker is written first, so a stop between any two steps is finished at the next start.
    The staged file is checked (PRAGMA integrity_check) at swap time; the ledger it replaces moves with its -wal
    and -shm files to harness-replaced-<time>.sqlite beside it, each keeping SQLite's pairing (the kept name, then
    the kept name with -wal and -shm); then the staged file is renamed into place, which is atomic. {} when nothing
    is staged.

    Fourteenth round: durable across power loss, not only a stop. The folder is fsynced after the marker's rename,
    after each of the three moves, after the final rename and before the marker is cleared; each completed step is
    recorded in the marker, so a resume never repeats a move. Raises SwapRefused rather than leave the records
    beside a log they don't own."""
    from datetime import timezone as _tz
    base = os.path.abspath(ledger_path)
    staged, marker, swap = base + RESTORE_SUFFIX, base + STAGE_MARKER, base + SWAP_MARKER
    if os.path.lexists(swap):
        plan = _read_json(swap)
        if not _plan_ok(base, plan):
            # Fifteenth round: never deleted, nothing moved: which step it stopped at can't be known.
            log.error("the restore swap's marker can't be read: nothing is moved; the files are listed for sorting")
            raise SwapRefused("a restore swap was under way but its marker can't be read, so nothing was moved",
                              files=swap_files(base))
        if plan.get("refused"):
            # Sixteenth round: re-evaluated at each start. Once the files that stopped it are gone (sorted by hand,
            # or by --set-aside), the refusal clears and the swap goes on from where it stopped.
            movable, protected = swap_conflicts(base, plan)
            named = [str(n) for n in plan.get("conflict") or []]
            if movable or protected or any(os.path.lexists(os.path.join(os.path.dirname(base), n))
                                           for n in named if _plain_name(n)):
                raise SwapRefused(f"a restore swap was refused earlier: {plan['refused']}", files=swap_files(base),
                                  conflict=named)
            log.warning("the files that stopped the restore swap are gone: the refusal is cleared and the swap goes on")
            plan = {k: v for k, v in plan.items() if k not in ("refused", "conflict")}
            try:
                _write_json(swap, plan)
            except OSError as e:
                log.error("the cleared refusal couldn't be written into the swap marker (%s); the swap goes on",
                          type(e).__name__)
        log.warning("a restore swap was under way when the App stopped: finishing it")
        return _finish_swap(base, plan)
    if not os.path.isfile(staged):
        _remove_file(marker)
        return {}
    if not os.path.isfile(marker):
        log.error("a staged restore without its marker (staging stopped midway) wasn't used")
        os.replace(staged, staged + ".refused")
        _fsync_dir(os.path.dirname(base))
        return {"ok": False, "said": "the staged restore wasn't finished being staged"}
    problem = verify_copy(staged)
    if problem:
        log.error("the staged restore wasn't used: %s", problem)
        os.replace(staged, staged + ".refused")
        _fsync_dir(os.path.dirname(base))
        _remove_file(marker)
        return {"ok": False, "said": problem}
    stamp = (now or datetime.now(_tz.utc)).strftime("%Y%m%dT%H%M%SZ")
    folder = os.path.dirname(base)
    kept = os.path.join(folder, f"harness-replaced-{stamp}.sqlite")
    n = 1
    while any(os.path.lexists(kept + x) for x in SIDECARS + (POSTBACK,)):
        n += 1
        kept = os.path.join(folder, f"harness-replaced-{stamp}-{n}.sqlite")
    plan = {"kept": kept, "from": _read_json(marker).get("from", ""), "at": stamp, "done": []}
    _write_json(swap, plan)                     # fsynced, and its folder
    _swap_step("marker")
    return _finish_swap(base, plan)


_STEPS = {"moved" + x for x in SIDECARS} | {"back" + x for x in SIDECARS} | {"renamed"}


def _plan_ok(base: str, plan) -> bool:
    """Fifteenth round: a swap marker that reads whole: a kept name beside the records and known steps only."""
    if not isinstance(plan, dict):
        return False
    kept = plan.get("kept")
    if not isinstance(kept, str) or not kept or os.path.dirname(os.path.abspath(kept)) != os.path.dirname(base):
        return False
    if not os.path.basename(kept).startswith("harness-replaced-"):
        return False
    done = plan.get("done", [])
    return isinstance(done, list) and all(isinstance(d, str) and d in _STEPS for d in done)


def _record(swap: str, plan: dict, step: str) -> None:
    """A step of the swap done, on disk: the folder first (the rename itself), then the marker that says so."""
    _fsync_dir(os.path.dirname(swap))
    plan.setdefault("done", []).append(step)
    _write_json(swap, plan)


def _move(src: str, dst: str) -> None:
    """One rename of the swap, never over something: both ends present means a resume can't tell which is which."""
    if os.path.lexists(dst):
        raise SwapRefused(f"{os.path.basename(src)} can't move: {os.path.basename(dst)} is already there")
    os.replace(src, dst)


def _unowned(base: str) -> list[str]:
    return [os.path.basename(base + x) for x in ("-wal", "-shm") if os.path.lexists(base + x)]


def _finish_swap(base: str, plan: dict) -> dict:
    """The swap from wherever it stopped (thirteenth round), step by step from the marker's record (fourteenth):
    before the rename it's rolled forward (the old files moved, then the staged file renamed into place), after it
    only the markers are left to clear. A staged file that fails its check here is set aside and the old ledger
    moved back: rolled back, also step by step."""
    staged, marker, swap = base + RESTORE_SUFFIX, base + STAGE_MARKER, base + SWAP_MARKER
    folder = os.path.dirname(base)
    kept = str(plan.get("kept") or "")
    if not _plan_ok(base, plan):
        raise SwapRefused("a restore swap was under way but its marker can't be read, so nothing was moved",
                          files=swap_files(base))       # fifteenth round: never deleted
    done = set(plan.get("done") or [])
    if plan.get("rollback"):
        return _roll_back(base, plan, str(plan.get("why") or "the staged restore was set aside"))
    if "renamed" not in done:
        if os.path.isfile(staged):
            problem = verify_copy(staged)
            if problem:
                return _roll_back(base, plan, problem)
        elif not any("moved" + x in done for x in SIDECARS) and os.path.isfile(base):
            return _roll_back(base, plan, "the staged restore was gone")
        for x in SIDECARS:                      # the old ledger and its log move together, one recorded step each
            step = "moved" + x
            if step in done:
                continue
            if os.path.lexists(base + x):
                if os.path.lexists(kept + x):
                    raise _refused(base, plan, f"{os.path.basename(base + x)} can't move: "
                                               f"{os.path.basename(kept + x)} is already there", [kept + x])
                _move(base + x, kept + x)
            _record(swap, plan, step)
            _swap_step(step)
        if os.path.isfile(staged):
            left = [base + x for x in SIDECARS if os.path.lexists(base + x)]
            if left:                            # asserted before the final rename: nothing at the live name
                raise _refused(base, plan, f"{', '.join(map(os.path.basename, left))} appeared at the records' "
                                           "name during the swap", left)
            os.replace(staged, base)            # atomic: the ledger is the old one or the restored one
        elif not os.path.isfile(base):
            return _roll_back(base, plan, "the staged restore was gone")
        # else: the rename was done but not yet recorded when the App stopped
        _record(swap, plan, "renamed")
        _swap_step("renamed")
    left = _unowned(base)
    if left:
        # Nothing has opened the restored file since its rename (the marker is still here), so a log beside it
        # isn't its own: never opened together.
        raise _refused(base, plan, f"{', '.join(left)} beside the restored records isn't theirs",
                       [os.path.join(folder, n) for n in left])
    _write_json(base + RESTORED, {"from": plan.get("from", ""), "kept": os.path.basename(kept), "at": plan.get("at")})
    _remove_file(base + MIGRATING)              # a move interrupted on the old ledger isn't this one's
    _remove_file(marker)
    _fsync_dir(folder)
    _remove_file(swap)
    log.warning("restored the ledger from %s; the one it replaced is %s", plan.get("from") or "a staged backup",
                os.path.basename(kept))
    return {"ok": True, "from": plan.get("from", ""), "replaced": os.path.basename(kept)}


def _roll_back(base: str, plan: dict, why: str) -> dict:
    """The old ledger moved back from the kept name, each move recorded like the swap's own (fourteenth round)."""
    staged, marker, swap = base + RESTORE_SUFFIX, base + STAGE_MARKER, base + SWAP_MARKER
    kept = str(plan["kept"])
    if not plan.get("rollback"):
        plan["rollback"], plan["why"] = True, why
        _write_json(swap, plan)
    done = set(plan.get("done") or [])
    for x in SIDECARS:
        step = "back" + x
        if step in done:
            continue
        if os.path.lexists(kept + x):
            _move(kept + x, base + x)
        _record(swap, plan, step)
        _swap_step(step)
    if os.path.lexists(staged):
        os.replace(staged, staged + ".refused")
    _remove_file(marker)
    _fsync_dir(os.path.dirname(base))
    _remove_file(swap)
    log.error("the staged restore wasn't used (%s): rolled back to the ledger as it was", why)
    return {"ok": False, "said": why, "rolled_back": True}


def _plain_name(n: str) -> bool:
    return bool(n) and "/" not in n and "\\" not in n and n not in (".", "..")


def swap_conflicts(base: str, plan: dict) -> tuple[list[str], list[tuple[str, str]]]:
    """Sixteenth round: what stops a swap now, derived from its validated state (the marker's recorded steps and
    what's on disk), never from names read out of the marker. (movable, protected): movable are the swap's own
    conflicting sidecars at the records' live name (a -wal or -shm there after its own move was recorded, or beside
    the restored records); protected are files in the way that are never moved by --set-aside (the records' own
    file at the live name, a kept set's file at the kept name), each with why."""
    done = set(plan.get("done") or [])
    kept = str(plan.get("kept") or "")
    movable: list[str] = []
    protected: list[tuple[str, str]] = []
    staged = os.path.isfile(base + RESTORE_SUFFIX)
    for x in ("-wal", "-shm"):
        if not os.path.lexists(base + x):
            continue
        if "renamed" in done or ("moved" + x in done and staged):
            movable.append(os.path.basename(base + x))
    if "renamed" not in done:
        if "moved" in done and staged and os.path.lexists(base):
            protected.append((os.path.basename(base), "the records' own file at the live name"))
        for x in SIDECARS:
            if "moved" + x not in done and os.path.lexists(base + x) and kept and os.path.lexists(kept + x):
                protected.append((os.path.basename(kept + x), "a kept set's file"))
    return movable, protected


def _protected_why(base: str, name: str) -> str:
    """Why a name the marker gives isn't one --set-aside moves (sixteenth round), or "" when it's an ordinary name."""
    b = os.path.basename(base)
    if not _plain_name(name):
        return "it isn't a plain name in the records' folder"
    if name == b:
        return "it's the records' own file"
    if name in (b + "-wal", b + "-shm"):
        return "it's the records' own log, and the swap's state doesn't say it's foreign"
    if name.startswith(b + RESTORE_SUFFIX) or name in (b + STAGE_MARKER, b + SWAP_MARKER, b + RESTORED):
        return "it's the staged restore or one of the swap's markers"
    if name.startswith("harness-replaced-"):
        return "it's part of a kept set"
    if name.startswith("harness-set-aside-") or name.startswith("harness-before-"):
        return "it's a set-aside folder or a backup"
    return "the swap's state doesn't name it"


SET_ASIDE_PROGRESS = ".set-aside"      # beside the swap marker while --set-aside is part way (eighteenth round)


def _sha256(path: str) -> str:
    """The file's SHA-256, read in chunks (eighteenth round: shared by --set-aside's checks and its progress key)."""
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


SET_ASIDE_DIGEST = ".digest"           # beside each checked copy in the set-aside folder (nineteenth round)
SET_ASIDE_ACCEPTED = ".accepted"       # beside a lost copy he accepted as not needed (twenty-first round)


def _digest_note(dest: str, name: str) -> str:
    return os.path.join(dest, "." + name + SET_ASIDE_DIGEST)


def _rebuild_progress(folder: str, swap: str) -> dict:
    """Nineteenth round: the progress record beside the swap marker is there but unreadable or truncated. It's
    rebuilt from what's on disk rather than stopping: the newest set-aside folder beside the records holding copies
    whose digest notes name this very swap marker and whose bytes still match the digest noted when each was
    checked; for each, whether its original is still beside the records. {} when there's nothing to rebuild from."""
    try:
        marker = _sha256(swap)
        names = sorted((n for n in os.listdir(folder) if n.startswith("harness-set-aside-") and _plain_name(n)
                        and os.path.isdir(os.path.join(folder, n))), reverse=True)
    except OSError:
        return {}
    for dest in names:
        files, lost, unverified, accepted = {}, [], [], []
        try:
            entries = os.listdir(os.path.join(folder, dest))
        except OSError:
            continue
        noted = {e[1:-len(SET_ASIDE_DIGEST)] for e in entries if e.startswith(".") and e.endswith(SET_ASIDE_DIGEST)}
        for e in entries:
            if e.startswith(".") and e.endswith(SET_ASIDE_ACCEPTED) and _plain_name(e[1:-len(SET_ASIDE_ACCEPTED)]):
                if _read_json(os.path.join(folder, dest, e)).get("marker") == marker:
                    accepted.append(e[1:-len(SET_ASIDE_ACCEPTED)])
        for e in entries:
            # Twenty-first round: a copy with no digest note can't be checked, so it's unverified; when its original
            # is gone too, it's named (as lost, and why), never skipped.
            if (not e.startswith(".") and _plain_name(e) and e not in noted
                    and os.path.isfile(os.path.join(folder, dest, e))
                    and not os.path.lexists(os.path.join(folder, e))):
                unverified.append(e)
        for note in entries:
            if not (note.startswith(".") and note.endswith(SET_ASIDE_DIGEST)):
                continue
            name = note[1:-len(SET_ASIDE_DIGEST)]
            if not _plain_name(name):
                continue
            rec = _read_json(os.path.join(folder, dest, note))
            copy = os.path.join(folder, dest, name)
            try:
                ok = (rec.get("marker") == marker and isinstance(rec.get("digest"), str) and os.path.isfile(copy)
                      and _sha256(copy) == rec["digest"])
            except OSError:
                ok = False
            if ok:
                files[name] = {"digest": rec["digest"], "removed": not os.path.lexists(os.path.join(folder, name))}
            elif rec.get("marker") == marker and not os.path.lexists(os.path.join(folder, name)):
                # Twentieth round: noted for this swap, but its copy is damaged (or gone) and its original is gone
                # too: neither a good copy nor an original. Never dropped silently: it's named as lost.
                lost.append(name)
        if files or lost or unverified:
            log.warning("the set-aside progress record couldn't be read; rebuilt from %s's checked copies", dest)
            return {"marker": marker, "dest": dest, "files": files, "lost": sorted(set(lost) | set(unverified)),
                    "unverified": sorted(unverified), "accepted": sorted(accepted)}
    return {}


def _set_aside_progress(folder: str, swap: str, path: str) -> dict:
    """Eighteenth round: the progress an earlier --set-aside left for this same swap, or {} when there's none to
    use. It counts only while the swap marker is byte for byte the one it was made against (the marker is updated
    only once every removal is done), and only when the folder it names is a plain set-aside folder beside the
    records; anything else is ignored and a fresh folder is chosen. Nineteenth round: one that's there but can't be
    read whole (truncated, torn) is rebuilt from the copies' noted digests and the originals' presence
    (_rebuild_progress)."""
    try:
        if not os.path.lexists(path):
            return {}
        with open(path, encoding="utf-8") as f:
            rec = json.load(f)
        if not isinstance(rec, dict) or not isinstance(rec.get("files"), dict):
            return _rebuild_progress(folder, swap)
        if rec.get("marker") != _sha256(swap):
            return {}
    except ValueError:
        return _rebuild_progress(folder, swap)
    except OSError:
        return _rebuild_progress(folder, swap)
    dest, files = rec.get("dest"), rec.get("files")
    if not (isinstance(dest, str) and _plain_name(dest) and dest.startswith("harness-set-aside-")
            and isinstance(files, dict)):
        return {}
    if os.path.lexists(os.path.join(folder, dest)) and not os.path.isdir(os.path.join(folder, dest)):
        return {}
    clean = {}
    for name, r in files.items():
        if not (isinstance(name, str) and _plain_name(name) and isinstance(r, dict)):
            return {}
        d = r.get("digest")
        clean[name] = {"digest": d if isinstance(d, str) else None, "removed": bool(r.get("removed"))}
    lost = [str(n) for n in rec.get("lost") or [] if isinstance(n, str) and _plain_name(n)]
    accepted = [str(n) for n in rec.get("accepted") or [] if isinstance(n, str) and _plain_name(n)]
    unverified = [str(n) for n in rec.get("unverified") or [] if isinstance(n, str) and _plain_name(n)]
    return {"marker": rec["marker"], "dest": dest, "files": clean, "lost": lost, "accepted": accepted,
            "unverified": unverified}


def _set_aside_lost(base: str, progress: dict, lost: list[str], progress_path: str) -> dict:
    """Twentieth round: files a set-aside run accounted for that now have neither a good copy (never checked, or no
    longer matching what was checked) nor their original beside the records. The loss is recorded in the progress
    record (written whole) and in the log, and the answer names each one; nothing else is moved, the swap marker and
    the live records are left exactly as they are. This runs only from the command line (--set-aside, with the App
    stopped), never at a start."""
    log.error("set-aside: %s has neither a good copy in %s/ nor its original beside the records", ", ".join(lost),
              progress.get("dest"))
    unverified = sorted(set(progress.get("unverified") or []) & set(lost))
    try:
        _write_json(progress_path, {"marker": progress.get("marker"), "dest": progress.get("dest"),
                                    "files": progress.get("files") or {}, "lost": lost,
                                    "accepted": list(progress.get("accepted") or []), "unverified": unverified})
    except OSError as e:
        log.error("set-aside: the loss couldn't be written to the progress record (%s)", type(e).__name__)
    each = ", ".join(lost)
    # Twenty-first round: a copy with no digest note is named as unverified, and the answer gives the command that
    # accepts a loss that isn't needed (--accept-lost), so later runs can go on.
    why = (f" ({', '.join(unverified)}: the copy has no digest note, so it can't be checked)" if unverified else "")
    return {"ok": False, "lost": lost, "unverified": unverified,
            "said": f"{each} {'has' if len(lost) == 1 else 'have'} neither a good copy in {progress.get('dest')}/ "
                    f"(its copy there was never checked or no longer matches){why} nor "
                    f"{'its original' if len(lost) == 1 else 'their originals'} beside the records. That's recorded "
                    "in the progress record beside the swap marker; nothing more was moved, the swap marker is as it "
                    "was and the live records are untouched. Sort it by hand: restore it from a backup, or, if it "
                    "isn't needed, accept its loss with python3 -m harness.migrate <records> --set-aside "
                    "--accept-lost <name>, and run --set-aside again to finish the rest",
            "files": swap_files(base)}


def accept_lost(ledger_path: str, name: str) -> dict:
    """Twenty-first round, from the command line (python3 -m harness.migrate <records> --set-aside --accept-lost
    <name>, with the App stopped): a file an earlier --set-aside recorded as lost (neither a good copy nor its
    original) is acknowledged as not needed. It's recorded as accepted in the progress record (and in a note beside
    the copies, so a torn record keeps it), so the next --set-aside goes on without it. Nothing is moved: the live
    records and the swap marker are left exactly as they are. Refused for a name that isn't recorded as lost."""
    base = os.path.abspath(ledger_path)
    folder = os.path.dirname(base)
    swap = base + SWAP_MARKER
    lock = None
    if folder not in _LOCK:
        lock = _try_lock(folder)
        if lock is None:
            return {"ok": False, "said": "Harness is running (it holds harness.lock beside the records), so nothing "
                                         "was recorded; stop the App first"}
    try:
        if not _plan_ok(base, _read_json(swap)):
            return {"ok": False, "said": "there's no readable restore swap beside the records to sort"}
        progress_path = swap + SET_ASIDE_PROGRESS
        progress = _set_aside_progress(folder, swap, progress_path)
        lost = list(progress.get("lost") or []) if progress else []
        if not _plain_name(str(name or "")) or name not in lost:
            return {"ok": False, "said": f"{name} isn't recorded as lost by an earlier --set-aside, so nothing was "
                                         "recorded", "lost": lost}
        accepted = sorted(set(progress.get("accepted") or []) | {name})
        record = {"marker": progress["marker"], "dest": progress["dest"], "files": progress.get("files") or {},
                  "lost": [n for n in lost if n != name], "accepted": accepted,
                  "unverified": [n for n in progress.get("unverified") or [] if n != name]}
        try:
            _write_json(progress_path, record)
            dest = os.path.join(folder, progress["dest"])
            if os.path.isdir(dest):
                _write_json(os.path.join(dest, "." + name + SET_ASIDE_ACCEPTED), {"marker": progress["marker"]})
        except OSError as e:
            return {"ok": False, "said": f"the acceptance couldn't be written ({type(e).__name__}), so nothing was "
                                         "recorded"}
        log.warning("set-aside: %s is accepted as lost; the next --set-aside goes on without it", name)
        return {"ok": True, "accepted": accepted,
                "said": f"{name} is recorded as accepted as lost. Nothing was moved; the swap marker and the live "
                        "records are untouched. Run --set-aside again to finish the rest"}
    finally:
        if lock is not None:
            lock.close()


TAP_QUARANTINE = "tap_quarantine:"         # twenty-fourth round: the controller's set-aside strike flags
TAP_DISCARDED = "tap_discarded:"           # twenty-fifth round: set-aside taps discarded: never taken again
SET_ASIDE_TAPS = "harness-set-aside-taps.json"
SET_ASIDE_ACTIONS = ("export", "discard", "requeue")
_TAP_OUTCOMES = ("committed", "refused", "found", "unverified", "unidentified", "internal_error")


def _tap_lines(journal: str, key: str) -> tuple[list[dict], list[dict]]:
    """One tap's own lines in the tap journal (any kind, the interaction token left out) and its journaled entry
    (handover.Inbox.journaled), read with the App stopped."""
    from . import handover
    inbox = handover.Inbox(lambda: "", journal=journal)
    lines = []
    for r in inbox.lines_for(key):
        r = dict(r)
        if isinstance(r.get("press"), dict):
            r["press"] = {k: v for k, v in r["press"].items() if k != "token"}
        lines.append(r)
    return lines, [r for r in inbox.journaled() if inbox.key(r["press"]) == key]


def _requeue_route(journal: str, key: str, lines: list[dict], entry: list[dict]) -> str:
    """Twenty-sixth round: how a requeued tap with no outcome goes back, by its journal alone. "unknown" when the
    journal holds an intent, or any other sign it was started (a line naming the tap that isn't its press: a read,
    a delivery, or a line that can't be read); "not_started" only when the journal reads whole and its lines are
    that tap's press and nothing else; "gone" when nothing of it is left; "refuse:<why>" for anything ambiguous (the
    journal can't be read, or lines with no journaled entry)."""
    torn = False
    try:
        with open(journal, encoding="utf-8", errors="replace") as f:
            for raw in f:
                if not raw.strip():
                    continue
                try:
                    json.loads(raw)
                except ValueError:
                    torn = torn or _torn_names(raw, key)
    except FileNotFoundError:
        pass
    except OSError as e:
        return f"refuse:the tap journal couldn't be read ({type(e).__name__})"
    if not lines and not torn:
        return "gone"
    if not entry:
        return "refuse:its journal lines have no tap entry to go back to"
    started = torn or any(not isinstance(r.get("press"), dict) for r in lines) or entry[0].get("state") != "not_started"
    return "unknown" if started else "not_started"


def _field(name: str, value: str) -> "re.Pattern":
    """Twenty-seventh round: a JSON field whose whole value is exactly `value` (a delimited match, never a part of
    a longer value). `name` empty: any field."""
    v = re.escape(json.dumps(value)[1:-1])
    return re.compile((r'"' + re.escape(name) + r'"' if name else r'"[^"\\]*"') + r'\s*:\s*"' + v + r'"')


def _torn_names(raw: str, key: str) -> bool:
    """Twenty-seventh round: whether a torn journal line names that very tap, by delimited fields only: its whole
    key as a field's value (an intent, a read, a delivery), or a press whose id is exactly the tap's (its custom id,
    where the line still holds it whole, exactly the tap's too), or, with the id torn off, its custom id exactly. A
    custom id that only contains the tap's, or another tap's line, never matches."""
    tap_id, _, custom = key.partition("|")
    if _field("", key).search(raw):
        return True
    has_id = bool(tap_id) and _field("id", tap_id).search(raw) is not None
    other_id = re.search(r'"id"\s*:\s*"', raw) is not None and not has_id
    whole_custom = re.search(r'"custom_id"\s*:\s*"(?:[^"\\]|\\.)*"', raw)
    same_custom = bool(custom) and _field("custom_id", custom).search(raw) is not None
    if has_id:
        return same_custom or whole_custom is None
    return same_custom and not other_id


def _journal_intent(journal: str, press: dict) -> bool:
    """Twenty-sixth round: an intent with no calendar effect named appended for a requeued tap that was started
    without one readable, so it reads as unknown (read first, never taken by itself)."""
    from . import handover
    return handover.Inbox(lambda: "", journal=journal).journal_intent(press, dict(REQUEUE_OP))


REQUEUE_OP = {"requeued": True}


def _requeue_intents(lines: list[dict], key: str) -> int:
    """Twenty-eighth round: the intents a requeue appended for that tap (REQUEUE_OP) among its journal lines.
    Twenty-ninth round: only those after the last tombstone for them (a discard that couldn't take the journal's
    lock), which every reader honours."""
    n = 0
    for r in lines:
        if r.get("intent") == key and r.get("op") == REQUEUE_OP:
            n += 1
        elif r.get("cleared") == key and r.get("op") == REQUEUE_OP:
            n = 0
    return n


def _drop_requeue_intents(journal: str, key: str) -> bool:
    """Twenty-eighth round: a discarded tap's intents that a refused requeue left (REQUEUE_OP, that very key) taken
    out of the tap journal; every other line kept byte for byte, torn ones included.

    Twenty-ninth round: through handover.Inbox.drop_lines, under the journal's exclusive append lock (the one every
    append takes, in the App and here) held across the read, filter, temporary write, fsync, rename and folder fsync,
    so a tap appended meanwhile is never lost and the rename is durable; when the lock can't be taken the journal
    isn't rewritten and a tombstone ({"cleared": key, "op": REQUEUE_OP}) is appended instead, which every reader
    honours. Whether the journal holds none of them now (or they're tombstoned)."""
    import time as _time
    from . import handover
    inbox = handover.Inbox(lambda: "", journal=journal)
    return inbox.drop_lines(lambda r: r.get("intent") == key and r.get("op") == REQUEUE_OP,
                            tombstone={"cleared": key, "op": dict(REQUEUE_OP), "at": _time.time()})


def _not_journal_owner(journal: str) -> str:
    """Thirtieth round: why the set-aside tool won't run as this user ("" when it may): its user isn't the tap
    journal's owner (nor its lock file's)."""
    me = os.geteuid()
    for path in (journal, journal + ".lock"):
        try:
            owner = os.stat(path).st_uid
        except FileNotFoundError:
            continue
        except OSError:
            return "the tap journal couldn't be checked, so nothing was done"
        if owner != me:
            return ("it must run as the tap journal's owner (the App's own user), and this user isn't, so nothing "
                    "was done")
    return ""


def _side_file(journal: str) -> str:
    """Twenty-ninth round: the controller's file beside the journal (Controller.REREAD_SIDE)."""
    return journal + ".reread"


def _side_relist(journal: str, key: str, gen: int | None, epoch: int = 0) -> tuple[bool, object]:
    """Twenty-ninth round: the tap's relist count beside the journal set (gen, with its epoch) or cleared (gen None),
    written whole (a temporary file, fsynced, renamed, the folder synced). Returns whether it took and the file's
    previous content (None when there was none), so a refused transaction can put it back. A file that doesn't
    read is left alone: the controller reads none of it, so it can't bring back a count."""
    path = _side_file(journal)
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
    except FileNotFoundError:
        old = None
    except (OSError, ValueError):
        return True, False
    if old is not None and not isinstance(old, dict):
        return True, False
    side = json.loads(json.dumps(old)) if old else {}
    gens = side.get("gens") if isinstance(side.get("gens"), dict) else {}
    eps = side.get("epochs") if isinstance(side.get("epochs"), dict) else {}
    if gen is None:
        if key not in gens and key not in eps:
            return True, False
        gens.pop(key, None)
        eps.pop(key, None)
    else:
        gens.pop(key, None)
        gens[key] = gen
        if epoch:
            eps[key] = epoch
        else:
            eps.pop(key, None)
    side["gens"] = gens
    if eps:
        side["epochs"] = eps
    else:
        side.pop("epochs", None)
    return _side_write(path, side), old


def _side_write(path: str, data) -> bool:
    from . import handover
    try:
        if data is None or (isinstance(data, dict) and not data.get("taps") and not data.get("gens")
                            and not data.get("outage")):
            if os.path.exists(path):
                os.remove(path)
        else:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        handover._fsync_dir(os.path.dirname(os.path.abspath(path)))
    except OSError:
        return False
    return True


RELIST_EPOCHS = "tap_relist_epochs"     # thirtieth round: the last epoch a requeue drew, for every tap


def _epoch_counter(db) -> int:
    """Thirtieth round: the last epoch any requeue drew (RELIST_EPOCHS in the records; 0 when there's none or it
    doesn't read). Raised in the requeue's own transaction, never lowered or pruned."""
    row = db.execute("SELECT value FROM meta WHERE key=?", (RELIST_EPOCHS,)).fetchone()
    try:
        n = int(row[0]) if row else 0
    except (TypeError, ValueError):
        return 0
    return max(n, 0)


def _side_epoch(journal: str, key: str) -> int:
    """Twenty-ninth round: the tap's epoch beside the journal (0 when there's none or it doesn't read)."""
    try:
        with open(_side_file(journal), encoding="utf-8") as f:
            got = json.load(f)
        e = (got.get("epochs") or {}).get(key, 0)
    except (OSError, ValueError, AttributeError):
        return 0
    return e if isinstance(e, int) and not isinstance(e, bool) and e > 0 else 0


def set_aside_taps(ledger_path: str, key: str | None = None, action: str = "discard", *,
                   journal: str | None = None) -> dict:
    """Twenty-fourth round, from the command line with the App stopped (python3 -m harness.migrate <records>
    --set-aside --taps [export|discard|requeue <tap key>]): the taps the controller set aside (a cleanup step it
    couldn't use), each with what was kept of it. Refused while Harness runs (it holds harness.lock).

    Twenty-fifth round, three operations on one tap, each writing its copy first (the record and the tap's own
    journal lines, without the interaction token) whole beside the records (harness-set-aside-taps.json, by key):
    - export: only that copy; the tap stays set aside.
    - discard: then, in one transaction of the records, the set-aside record is replaced by a lasting discard record
      (TAP_DISCARDED), so the controller never reads the calendar for that tap or takes it again, even though its
      journal lines stay.
    - requeue: the tap's journal lines are checked first: they must carry one press whose id and custom id make that
      very key. A tap with an outcome (in the journal, or its card in the records) gets a strike flag with that
      press, so the controller only strikes it and never acts on it again; one with none is handed back to the
      running loop, which reads the calendar for it before anything. A press that doesn't check out is refused and
      the tap stays set aside.

    Twenty-ninth round, what the operations leave:
    - a requeue leaves at most one intent for the tap in the journal (a refused requeue's is reused, never added
      again), and starts the tap's relist count afresh (a new epoch, so its cards get a fresh Go ahead, up to the
      cap again); a discard clears that intent and the count. Each changes the count beside the journal first and
      the records second, and puts the count back when the records refuse.
    - a discard's journal rewrite holds the journal's append lock (<journal>.lock) from its read to its rename and
      folder sync; with no lock to take it appends a tombstone line instead, which every reader honours.
    - if that rewrite fails after the discard committed, the intent is an orphan: never read, carded or acted on
      (the discard record skips it everywhere), and the result says so; the same discard run again clears it.
    - a struck relist mark whose count couldn't be read keeps no count for good (thirtieth round: written as the
      "nocount" state, read ahead of any count beside the journal): if that tap is ever listed again it's stopped
      with its own card, never counted from one or from a count beside the journal; only a requeue clears it.

    Thirtieth round:
    - the tool runs only as the tap journal's owner (the App's own user); as any other user it refuses and does
      nothing, so a lock file or journal it leaves is always one the App can open.
    - a requeue's epoch comes from one counter in the records for every tap (RELIST_EPOCHS), never pruned, so a
      requeued tap's new cards never reuse an earlier once-key even when its mark and its count beside the journal
      were both lost. Each requeue gives the tap up to six Go aheads again, and requeues have no limit: unbounded
      runs of six per tap are acceptable because each requeue is an operator's explicit act."""
    import sqlite3 as _sqlite3
    import time as _time
    if action not in SET_ASIDE_ACTIONS:
        return {"ok": False, "said": "the operation must be export, discard or requeue, so nothing was done"}
    base = os.path.abspath(ledger_path)
    folder = os.path.dirname(base)
    lock = None
    if folder not in _LOCK:
        lock = _try_lock(folder)
        if lock is None:
            return {"ok": False, "said": "Harness is running (it holds harness.lock beside the records), so nothing "
                                         "was read or cleared; stop the App first"}
    try:
        if not os.path.exists(base):
            return {"ok": False, "said": "there are no records at that path"}
        db = _sqlite3.connect(base, isolation_level=None)
        try:
            rows = {k[len(TAP_QUARANTINE):]: v for k, v in db.execute(
                "SELECT key, value FROM meta WHERE substr(key, 1, ?)=?", (len(TAP_QUARANTINE), TAP_QUARANTINE))}
            if key is None:
                gone = [k[len(TAP_DISCARDED):] for (k,) in db.execute(
                    "SELECT key FROM meta WHERE substr(key, 1, ?)=?", (len(TAP_DISCARDED), TAP_DISCARDED))]
                return {"ok": True, "taps": rows, "discarded": gone, "said": f"{len(rows)} set-aside tap record(s)"}
            from . import handover
            jpath = journal or base + handover.TAP_JOURNAL
            # Thirtieth round: the tool runs as the tap journal's owner (the App's user) or not at all, so a lock file
            # or a rewritten journal it leaves is never one the App can't open.
            stranger = _not_journal_owner(jpath)
            if stranger:
                return {"ok": False, "said": stranger}
            if key not in rows and action == "discard" and db.execute(
                    "SELECT 1 FROM meta WHERE key=?", (TAP_DISCARDED + key,)).fetchone() is not None:
                # Twenty-ninth round: a discard done again on a discarded tap only clears what the first one
                # couldn't: its count beside the journal and an intent a refused requeue left in the journal.
                ok, _ = _side_relist(jpath, key, None)
                if not ok or not _drop_requeue_intents(jpath, key):
                    return {"ok": False, "said": "it was discarded before, and what it left in the tap journal "
                                                 "still couldn't be cleared"}
                return {"ok": True, "discarded": key, "said": "it was discarded before; what it left in the tap "
                                                             "journal is cleared now"}
            if key not in rows:
                return {"ok": False, "taps": rows, "said": "that tap isn't set aside, so nothing was done"}
            lines, entry = _tap_lines(jpath, key)
            kept_path = os.path.join(folder, SET_ASIDE_TAPS)
            kept = _read_json(kept_path) or {}
            # Twenty-sixth round: the copy's exception text scrubbed at this writer too (scrub.scrub_fields), the
            # set-aside record's own text included.
            from . import scrub
            from .ledger import _scrubbed_json
            record = _scrubbed_json(rows[key])
            kept[key] = scrub.scrub_fields({"record": record, "journal": lines, "at": _time.time(), "action": action})
            try:
                _write_json(kept_path, kept)
            except OSError as e:
                return {"ok": False, "said": f"its record couldn't be kept beside the records ({type(e).__name__}), "
                                             "so nothing was done"}
            if action == "export":
                return {"ok": True, "exported": key, "kept_in": SET_ASIDE_TAPS, "said": "kept beside the records; "
                                                                                       "still set aside"}
            if action == "requeue":
                presses = [r["press"] for r in lines if isinstance(r.get("press"), dict)]
                tap_id, custom = (str(presses[0].get("id", "")), str(presses[0].get("custom_id", ""))) \
                    if presses else ("", "")
                if lines and (not presses or not tap_id or not custom or f"{tap_id}|{custom}" != key
                              or any((str(p.get("id", "")), str(p.get("custom_id", ""))) != (tap_id, custom)
                                     for p in presses)):
                    return {"ok": False, "said": "its journal lines don't carry one press for that tap, so it stays "
                                                 "set aside"}
                state = entry[0]["state"] if entry else ""
                route = _requeue_route(jpath, key, lines, entry)
                if route.startswith("refuse:"):
                    return {"ok": False, "said": route[len("refuse:"):] + ", so it stays set aside"}
                carded = db.execute("SELECT 1 FROM meta WHERE key=? OR substr(key, 1, ?)=?",
                                    (f"tap_card_queued:{key}", len(f"outbox_once:tap:{key}|outcome|"),
                                     f"outbox_once:tap:{key}|outcome|")).fetchone() is not None
                # Twenty-eighth round: an intent a refused requeue left for this tap stands for this requeue too
                # (it's never appended twice), so the tap holds one intent whichever requeue goes through.
                if route == "unknown" and not (state in _TAP_OUTCOMES or carded) and state != "unknown" \
                        and not _requeue_intents(lines, key) and not _journal_intent(jpath, entry[0]["press"]):
                    return {"ok": False, "said": "its intent couldn't be written to the tap journal, so it stays set "
                                                 "aside"}
            # Twenty-ninth round: a requeue starts the tap's relist count afresh (a new epoch, so its cards never reuse
            # an earlier relist's once-keys) and a discard clears it, each in the same step as its mark: the count
            # beside the journal first, then the records; a transaction the records refuse puts it back. So the
            # larger of the mark and the count beside the journal never brings back a count that was lowered.
            had = db.execute("SELECT value FROM meta WHERE key=?", ("tap_relist:" + key,)).fetchone()
            try:
                old_mark = json.loads(had[0]) if had else None
            except (TypeError, ValueError):
                old_mark = None
            old_mark = old_mark if isinstance(old_mark, dict) else ({} if had else None)
            new_mark = None
            if action == "discard":
                side_ok, side_old = _side_relist(jpath, key, None)
            else:
                e = old_mark.get("epoch", 0) if old_mark else 0
                e = e if isinstance(e, int) and not isinstance(e, bool) and e > 0 else 0
                # Thirtieth round: drawn from one counter in the records for every tap (RELIST_EPOCHS), never
                # pruned and never lowered, so a requeued tap whose mark and count beside the journal were both
                # lost still gets an epoch it never had, and its new cards never reuse an earlier once-key.
                epoch = max(e, _side_epoch(jpath, key), _epoch_counter(db)) + 1
                new_mark = {k: v for k, v in (old_mark or {}).items() if k not in ("ended", "nocount")}
                new_mark.update(gen=0, epoch=epoch, pending=bool(new_mark.get("pending")))
                side_ok, side_old = _side_relist(jpath, key, 0, epoch)
            if not side_ok:
                return {"ok": False, "said": "its count beside the tap journal couldn't be changed, so it stays set "
                                             "aside"}
            # Twenty-seventh round: a transaction the records refuse leaves the tap set aside and says so (an intent
            # appended for it above stays in the journal, and the controller skips every set-aside tap's lines).
            try:
                db.execute("BEGIN IMMEDIATE")
                try:
                    if action == "discard":
                        db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
                                   (TAP_DISCARDED + key, json.dumps({"at": _time.time(), "record": record})))
                        # Twenty-sixth round: every state that could still act on it goes in the same transaction: its
                        # strike pending, its next read, and its relist mark (with its generation and pending strike).
                        db.execute("DELETE FROM meta WHERE key IN (?, ?, ?)",
                                   ("tap_strike:" + key, "tap_reread:" + key, "tap_relist:" + key))
                        said = "discarded: it's never taken again, and its copy is kept beside the records"
                    elif entry and (state in _TAP_OUTCOMES or carded):
                        full = next(dict(r["press"]) for r in entry if r.get("press"))
                        db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", ("tap_strike:" + key, json.dumps(
                            {"press": full, "fails": 0, "due": 0.0, "state": state if state in _TAP_OUTCOMES else ""})))
                        said = "requeued to be struck: it has an outcome, so it's only crossed off"
                    elif route == "unknown":
                        # Twenty-sixth round: an intent (or any start) in the journal: outcome unknown. Harness reads
                        # the calendar for it first and gives a card (Go ahead at most), never acting by itself.
                        said = "requeued as unknown: Harness reads your calendar for it first and never takes it by itself"
                    elif route == "not_started":
                        said = "requeued: the tap journal shows it was never acted on"
                    else:
                        said = "requeued: nothing of it is left in the tap journal"
                    if new_mark is not None:
                        db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
                                   ("tap_relist:" + key, json.dumps(new_mark)))
                        db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
                                   (RELIST_EPOCHS, str(new_mark["epoch"])))
                    db.execute("DELETE FROM meta WHERE key=?", (TAP_QUARANTINE + key,))
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
            except _sqlite3.Error as e:
                if side_old is not False and not _side_write(_side_file(jpath), side_old):
                    log.error("set-aside: a tap's count beside the journal couldn't be put back")
                return {"ok": False, "said": f"the records refused it ({type(e).__name__}), so it stays set aside"}
            # Twenty-eighth round: a discarded tap keeps no intent a refused requeue left, so nothing (a later
            # change to the discard record included) has an intent of his to act on. Its other lines stay.
            if action == "discard" and not _drop_requeue_intents(jpath, key):
                log.error("set-aside: a discarded tap's requeue intent couldn't be cleared from the tap journal")
                said += ("; an intent a refused requeue left in the tap journal couldn't be cleared (it's never acted "
                         "on; run the discard again to clear it)")
        finally:
            db.close()
        log.warning("set-aside: a set-aside tap was handled (%s); its copy is kept in %s", action, SET_ASIDE_TAPS)
        return {"ok": True, {"discard": "discarded", "requeue": "requeued"}[action]: key, "kept_in": SET_ASIDE_TAPS,
                "said": said}
    finally:
        if lock is not None:
            lock.close()


def set_aside(ledger_path: str, confirm=None, now: datetime | None = None) -> dict:
    """Fifteenth round, from the command line (python3 -m harness.migrate <records> --set-aside): a swap refused for
    files it doesn't own is sorted by moving them into a folder beside the records (harness-set-aside-<time>-<n>/),
    after the listing is shown and `confirm` (a typed yes) agrees; then the refusal is cleared from the swap marker,
    so the next start finishes the swap. Under harness.lock: refused while Harness runs normally.

    Sixteenth round: the move set is derived from the swap's validated state (swap_conflicts), never from names
    read out of the marker: only the swap's own conflicting sidecars at the live name. A marker naming anything
    else (the live ledger, its own log, the staged restore, a kept set, anything outside the folder) is refused
    explicitly, and so is a conflict that's a protected file; the whole set is checked before anything moves; each
    file is copied, the copy checked byte for byte and fsynced, and only then is the original removed. The folder's
    name is unique (time plus a counter).

    Eighteenth round: resumable. Progress is kept beside the swap marker (<records>.swap.json.set-aside, written
    whole and fsynced): the folder chosen and, per file, the copy's digest once checked and whether the original
    was removed. A run after one cut short (a removal that failed, a kill) uses the same folder, accepts a checked
    copy whose original is gone, and finishes the rest; the marker is updated only once every removal is done, and
    the progress record is then removed. Twentieth round: a copy never checked (or no longer matching) whose original
    is gone is recorded as lost and named in the answer (_set_aside_lost), the marker and the live records left as
    they were; command line only, never at a start."""
    from datetime import timezone as _tz
    import shutil
    base = os.path.abspath(ledger_path)
    folder = os.path.dirname(base)
    swap = base + SWAP_MARKER
    lock = None
    if folder not in _LOCK:
        lock = _try_lock(folder)
        if lock is None:
            return {"ok": False, "said": "Harness is running (it holds harness.lock beside the records), so nothing "
                                         "was moved; stop the App first"}
    try:
        plan = _read_json(swap)
        if not _plan_ok(base, plan):
            return {"ok": False, "said": "there's no readable restore swap beside the records to sort",
                    "files": swap_files(base)}
        movable, protected = swap_conflicts(base, plan)
        # Eighteenth round: an earlier run for this same swap (the marker byte for byte as it was) left its progress
        # beside the marker: the folder it chose and, per file, the copy's digest once checked and whether the
        # original was removed. A checked copy whose original is gone is taken as moved; one never checked (or no
        # longer matching) whose original is gone is a hard stop.
        progress_path = swap + SET_ASIDE_PROGRESS
        progress = _set_aside_progress(folder, swap, progress_path)
        settled: list[str] = []
        if progress:
            dest = os.path.join(folder, progress["dest"])
            accepted = set(progress.get("accepted") or [])
            lost = [n for n in progress.get("lost") or [] if n not in accepted]
            settled.extend(sorted(accepted))       # twenty-first round: a loss he accepted no longer stops a run
            unverified_now: list[str] = []
            for name, rec in progress["files"].items():
                if name in movable or os.path.lexists(os.path.join(folder, name)) or name in accepted:
                    continue
                d = rec.get("digest") if isinstance(rec, dict) else None
                copy = os.path.join(dest, name)
                if not isinstance(d, str) or not d:
                    # Twenty-second round: the digest rule on every loaded record, readable or rebuilt: a null or
                    # missing digest is unverified, never trusted, and named in the answer.
                    unverified_now.append(name)
                    lost.append(name)
                    continue
                if not os.path.isfile(copy) or _sha256(copy) != d:
                    lost.append(name)
                    continue
                settled.append(name)
            if lost:
                if unverified_now:
                    progress = dict(progress, unverified=sorted(set(progress.get("unverified") or [])
                                                                | set(unverified_now)))
                return _set_aside_lost(base, progress, sorted(set(lost)), progress_path)
        named = [str(n) for n in plan.get("conflict") or []]
        refusals = [f"{n}: {_protected_why(base, n)}" for n in named if n not in movable and n not in settled and
                    (not _plain_name(n) or os.path.lexists(os.path.join(folder, n)) or _protected_why(base, n)
                     != "the swap's state doesn't name it")]
        refusals += [f"{n}: {why}" for n, why in protected]
        if refusals:
            return {"ok": False, "said": "nothing was moved: these can't be set aside by this command and need "
                                         "sorting by hand: " + "; ".join(refusals),
                    "refused": refusals, "files": swap_files(base)}
        if not movable and not settled and not plan.get("refused"):
            return {"ok": False, "said": "there's no refused restore swap beside the records to sort",
                    "files": swap_files(base)}
        if not progress:
            stamp = (now or datetime.now(_tz.utc)).strftime("%Y%m%dT%H%M%SZ")
            n = 1
            dest = os.path.join(folder, f"harness-set-aside-{stamp}-{n}")
            while os.path.lexists(dest):
                n += 1
                dest = os.path.join(folder, f"harness-set-aside-{stamp}-{n}")
        why = plan.get("refused") or "files at the records' name it doesn't own (the refusal wasn't recorded)"
        already = f" ({', '.join(settled)} already moved there)" if settled else ""
        ask = (f"The restore swap was refused: {why}. Move {', '.join(movable) or 'nothing'} into "
               f"{os.path.basename(dest)}/{already} and let the next start finish the swap? Type yes to go ahead: ")
        answer = (confirm or input)(ask)
        if str(answer or "").strip().lower() != "yes":
            return {"ok": False, "said": "not confirmed, so nothing was moved", "files": swap_files(base)}
        digest = _sha256
        if movable:
            files = dict(progress["files"]) if progress else {}
            for name in movable:
                files[name] = {"digest": None, "removed": False}
            record = {"marker": _sha256(swap), "dest": os.path.basename(dest), "files": files,
                      "accepted": list(progress.get("accepted") or []) if progress else []}
            # Seventeenth round: a copy or fsync that fails (a full disk, most likely) or a copy that doesn't match
            # takes back what it made (the partial copies, then the folder while empty) and leaves the originals
            # and the marker as they were, with a plain reason; the command line then exits non-zero. Eighteenth
            # round: copies an earlier run already accounted for (originals gone) are never taken back.
            copied: list[str] = []

            def take_back() -> None:
                for c in copied:
                    for gone in (c, _digest_note(os.path.dirname(c), os.path.basename(c))):
                        try:
                            os.remove(gone)
                        except OSError:
                            pass
                try:
                    os.rmdir(dest)
                except OSError:
                    pass
                try:
                    if not os.path.isdir(dest):
                        os.remove(progress_path)
                    else:
                        for name in movable:
                            record["files"][name] = {"digest": None, "removed": False}
                        _write_json(progress_path, record)
                except OSError:
                    pass
            try:
                _write_json(progress_path, record)              # before the folder: a run cut off here is found again
                os.makedirs(dest, exist_ok=True)
                for name in movable:
                    src, dst = os.path.join(folder, name), os.path.join(dest, name)
                    copied.append(dst)
                    shutil.copy2(src, dst)
                    with open(dst, "rb") as f:
                        os.fsync(f.fileno())
                    d = digest(src)
                    if d != digest(dst):
                        take_back()
                        return {"ok": False, "said": f"the copy of {name} didn't match it, so nothing was moved and "
                                                     "the swap marker is as it was", "files": swap_files(base)}
                    record["files"][name] = {"digest": d, "removed": False}
                    # Nineteenth round: the checked digest beside the copy too, so a progress record that's lost or
                    # torn can be rebuilt from the folder itself (_rebuild_progress).
                    _write_json(_digest_note(dest, name), {"marker": record["marker"], "digest": d})
                _fsync_dir(dest)
                _fsync_dir(folder)
                _write_json(progress_path, record)              # every copy checked, recorded before any removal
            except OSError as e:
                take_back()
                reason = ("the disk is full" if getattr(e, "errno", None) in (errno.ENOSPC, errno.EDQUOT)
                          else f"a copy couldn't be made ({type(e).__name__})")
                log.error("setting the swap's files aside failed: %s", reason)
                return {"ok": False, "said": f"{reason}, so nothing was moved and the swap marker is as it was",
                        "files": swap_files(base)}
            try:
                for name in movable:
                    try:
                        os.remove(os.path.join(folder, name))
                    except FileNotFoundError:
                        pass                                    # gone already: its copy is checked
                    record["files"][name]["removed"] = True
                    _write_json(progress_path, record)          # each removal recorded as it's done
                _fsync_dir(folder)
            except OSError as e:
                # The copies are whole and checked, so they stay (the folder holds what was taken off); the marker
                # is left as it was, so the swap isn't finished on a half-moved set. Eighteenth round: the next run
                # finds this folder through the progress record and finishes the removals.
                log.error("an original couldn't be removed after its copy was made (%s)", type(e).__name__)
                return {"ok": False, "said": f"the copies are in {os.path.basename(dest)}/, but an original couldn't be "
                                             f"removed ({type(e).__name__}), so the swap marker is as it was; run "
                                             "--set-aside again to finish",
                        "files": swap_files(base)}
        movable = list(settled) + [m for m in movable if m not in settled]
        plan = {k: v for k, v in plan.items() if k not in ("refused", "conflict")}
        _write_json(swap, plan)
        try:
            os.remove(progress_path)                            # eighteenth round: the set is done with
        except OSError:
            pass
        log.warning("files the restore swap refused were set aside in %s", os.path.basename(dest))
        return {"ok": True, "moved": movable, "into": os.path.basename(dest) if movable else "",
                "said": "Set aside. The next start of Harness finishes the restore swap."}
    finally:
        if lock is not None:
            lock.close()


def _lost_counts(ledger: Ledger, since: str) -> dict:
    """What the records set aside by a restore hold that the backup doesn't (recorded after `since`): held
    requests, buttons not tapped yet, writes whose outcome is still being read, and writes he could still undo."""
    import sqlite3
    now = iso(ledger.now())

    def count(sql: str, *args) -> int:
        try:
            return int(ledger.db.execute(sql, args).fetchone()[0] or 0)
        except sqlite3.Error:
            return 0
    from . import calendar_change as cal
    held = 0
    for _, value in ledger.db.execute("SELECT key, value FROM meta WHERE key LIKE ?", (f"{cal.HELD}%",)):
        try:
            held += (json.loads(value).get("at") or "") > since
        except (ValueError, AttributeError):
            held += 1
    return {
        "held": held,
        "taps": count("SELECT COUNT(*) FROM choices WHERE consumed_at IS NULL AND expires_at > ? AND created_at > ? "
                      "AND kind NOT LIKE 'migration_%'", now, since)
        + count("SELECT COUNT(*) FROM approvals WHERE consumed_at IS NULL AND expires_at > ? AND created_at > ?",
                now, since),
        "watches": count("SELECT COUNT(*) FROM calendar_changes WHERE (state IN ('sending','settling') OR "
                         "undo_state='settling') AND created_at > ?", since)
        + count("SELECT COUNT(*) FROM family_adds WHERE (state IN ('sending','settling') OR undo_state IN "
                "('settling','unknown')) AND created_at > ?", since),
        "undoable": count("SELECT COUNT(*) FROM calendar_changes WHERE undo_state='open' AND created_at > ?", since)
        + count("SELECT COUNT(*) FROM family_adds WHERE undo_state='open' AND created_at > ?", since),
    }


def _age(ledger: Ledger, at: str) -> str:
    try:
        s = max(0, int((ledger.now() - datetime.fromisoformat(at)).total_seconds()))
    except (ValueError, TypeError):
        return "an unknown time"
    if s < 2 * 3600:
        return f"{max(1, s // 60)} minute{'s' if s // 60 != 1 else ''}"
    if s < 2 * 86400:
        return f"{s // 3600} hours"
    return f"{s // 86400} days"


def request_restore(ledger: Ledger, chat_id: int, key: str, by: str) -> tuple[str, str]:
    """Cain's keeper.sh fastpath migrate-restore <schema> <build> (twelfth round): only posts him a card naming
    the backup; it's staged only on his tap (restore_tapped). (status, said)."""
    try:
        n_text, build = key.split(" ", 1)
        n = int(n_text)
    except ValueError:
        return "refused", "Name the backup by its schema version and build. Nothing changed."
    chosen = find_backup(ledger.path, n, build)
    if not chosen:
        return "refused", f"There's no backup beside the records for schema {n} and build {build}. Nothing changed."
    if not chat_id:
        return "refused", "There's no owner to ask, so nothing changed."
    with ledger.tx() as db:
        nonce = choices.mint(ledger, kind="migration_restore", target=f"{n} {build}", chat_id=chat_id,
                             ttl_s=CARD_TTL_S, db=db)
        ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit(
            "<b>Put Harness's records back from a backup?</b> The backup was taken just before an update moved "
            "them. Put them back gets it ready and stops taking anything new; a restart of the App then replaces "
            "the records with it: anything recorded since that backup is set aside (kept beside them, not "
            "deleted), and the records then move to the running build again, with a new backup first."),
            buttons=[[("Put them back", choices.callback_data(nonce))]],
            binds=[{"type": "choice", "nonce": nonce}], db=db)
        ledger.event("migration_restore_asked", {"backup": os.path.basename(chosen), "by": by}, db=db)
    return "ok", ("He has a card to put the records back from that backup; it's staged only on his tap and used "
                  "the next time Harness starts. Nothing changed yet.")


def restore_tapped(ledger: Ledger, target: str, chat_id: int = 0) -> str:
    """His tap on Put them back: stages it (stage_restore). Thirteenth round: nothing new is taken until the
    restart (the controller answers requests and taps plainly), and one card tells him to restart the App now,
    with the backup's age and what the records set aside hold that it doesn't. Fourteenth round: that's the
    controller's fence (a mode flag on the ledger), not a held lock. What to tell him."""
    try:
        n_text, build = (target or "").split(" ", 1)
    except ValueError:
        return "That card can't be read, so nothing changed."
    got = stage_restore(ledger.path, n_text, build)
    with ledger.tx() as db:
        ledger.event("migration_restore_staged" if got.get("ok") else "migration_restore_refused",
                     {k: got.get(k, "") for k in ("backup", "said")}, db=db)
    if not got.get("ok"):
        return f"Not put back: {render.escape(got.get('said', 'see the log'))}. Nothing changed."
    entry = next((b for b in backups(ledger) if os.path.basename(str(b.get("path", ""))) == got.get("backup")), {})
    since = str(entry.get("at") or "")
    if not since:
        try:
            from datetime import timezone as _tz
            mtime = os.path.getmtime(os.path.join(os.path.dirname(os.path.abspath(ledger.path)), got["backup"]))
            since = iso(datetime.fromtimestamp(mtime, _tz.utc))
        except (OSError, KeyError):
            since = ""
    lost = _lost_counts(ledger, since)
    if chat_id:
        with ledger.tx() as db:
            ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit(
                "<b>Restart Harness now to put its records back.</b> In Home Assistant: Settings, Apps, Harness, "
                f"Restart. The backup it goes back to was taken {_age(ledger, since)} ago. Until the restart Harness "
                "takes nothing new: requests and taps are answered that it's waiting to restart. Set aside with the "
                "records it replaces (kept beside them, not deleted), so not in the restored ones: "
                f"{lost['held']} held request{'s' if lost['held'] != 1 else ''} (passed back to you ready to copy "
                f"after the restart), {lost['taps']} button{'s' if lost['taps'] != 1 else ''} not tapped yet, "
                f"{lost['watches']} write{'s' if lost['watches'] != 1 else ''} still being confirmed, and "
                f"{lost['undoable']} change{'s' if lost['undoable'] != 1 else ''} you could still undo."), db=db)
            ledger.event("migration_restore_fenced", {"backup": got.get("backup", ""), **lost}, db=db)
    # Fourteenth round: no writer hold. The controller fences the ledger (Ledger.fence, a mode flag: writes fail at
    # once with a plain reason, the outbox's delivery marks excepted) as soon as this tap's own reply is recorded,
    # and Cain's handover service answers taps at once from then on (restore_staged).
    log.warning("a restore is staged: nothing new is taken until the App restarts")
    return "Ready: restart Harness now and the records are put back from that backup. The message below says what's set aside."


POSTED = "migration_restored_item:"     # + kept file name + ":" + item key: that held request was posted back


def held_items(kept_path: str, tz: str) -> list[tuple[str, list[str]]]:
    """The requests held in a ledger a restore set aside, each with its key (the proposal id) and its
    ready-to-copy lines. Fourteenth round: the kept ledger is opened read-write once to fold its -wal in
    (wal_checkpoint TRUNCATE; its files keep SQLite's pairing), so a request committed only in the log comes back;
    then it's read through a read-only connection."""
    import sqlite3
    from . import calendar_change as cal
    out: list[tuple[str, list[str]]] = []
    if not os.path.isfile(kept_path):
        return out
    try:
        rw = sqlite3.connect(kept_path)
        try:
            rw.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        finally:
            rw.close()
    except sqlite3.Error as e:
        log.warning("the records a restore set aside couldn't be checkpointed (%s); read as they are",
                    type(e).__name__)
    try:
        conn = sqlite3.connect(f"file:{kept_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return out
    try:
        for key, _ in conn.execute("SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key",
                                   (f"{cal.HELD}%",)).fetchall():
            pid = key[len(cal.HELD):]
            row = conn.execute("SELECT params_json FROM proposals WHERE id=?", (pid,)).fetchone()
            try:
                changes = json.loads(row[0])["changes"] if row else []
            except (ValueError, KeyError, TypeError):
                continue
            lines = ["• " + render.escape(cal._copy_line(c, tz)) for c in changes]
            if lines:
                out.append((pid, lines))
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    return out


def held_in_kept(ledger: Ledger, kept_path: str, tz: str) -> list[str]:
    """The requests held in a ledger a restore set aside, as ready-to-copy lines."""
    return [line for _, lines in held_items(kept_path, tz) for line in lines]


def after_restore(ledger: Ledger, chat_id: int, tz: str) -> dict:
    """Once the restored ledger is open (thirteenth round): the requests held in the records it set aside are
    posted back, ready to copy, once. {} when there's nothing to post back.

    Fourteenth round: one message per held request, keyed by its id. A post-back marker beside the kept files
    (<kept>.postback.json) names the item about to go before it's posted; the post and its record in the ledger
    are one transaction, so after a stop at any point the marker and the ledger together say whether it went:
    nothing is posted twice and nothing is lost. Once all are posted, older kept sets are pruned (the latest is
    kept) if the records aren't waiting on a move.

    Fifteenth round: every kept set whose own marker doesn't say done is posted back, oldest first, not only the
    newest swap's: two restores in a row with the first post-back cut short bring both sets' held requests back,
    once each."""
    if not ledger.path or ledger.path == ":memory:" or not chat_id:
        return {}
    side = _side(ledger, RESTORED)
    info = _read_json(side) if side and os.path.isfile(side) else {}
    folder = os.path.dirname(os.path.abspath(ledger.path))
    newest = os.path.basename(str(info.get("kept") or ""))
    pending = [k for k in kept_sets(folder) if not _read_json(k + POSTBACK).get("done")]
    if newest and os.path.isfile(os.path.join(folder, newest)) and os.path.join(folder, newest) not in pending \
            and not _read_json(os.path.join(folder, newest) + POSTBACK).get("done"):
        pending.append(os.path.join(folder, newest))
    if not pending and not info:
        return {}
    held = 0
    for kept in pending:
        frm = (info.get("from") if os.path.basename(kept) == newest else "") or \
            _read_json(kept + POSTBACK).get("from") or ""
        held += _post_back(ledger, chat_id, tz, kept, str(frm))
    if side:
        _remove_file(side)
    if not waiting(ledger):
        prune_kept(folder)
    return {"held": held, **info}


def _went_in_kept(kept: str, flag: str, text: str = "") -> bool:
    """Fifteenth round: a post-back cut short and then set aside by another restore: whether the records set aside
    after this kept set recorded that item's post and delivered it (its outbox row sent). Delivered there: not
    posted again; recorded but never delivered (it was set aside queued): posted again, so it's neither lost nor
    doubled. Each later kept set is only read.

    Sixteenth round: a flag in the older format (no outbox row) counts as done only when that later set's outbox
    shows a delivered row for this very post (its text, `text`); otherwise the item is posted again under the
    once-each guard and the set is kept until it's done."""
    import sqlite3
    folder = os.path.dirname(os.path.abspath(kept))
    for later in kept_sets(folder):
        if later <= kept:
            continue
        try:
            conn = sqlite3.connect(f"file:{later}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            got = conn.execute("SELECT value FROM meta WHERE key=?", (flag,)).fetchone()
            if not got:
                continue
            try:
                row = int(json.loads(got[0]).get("outbox"))
            except (ValueError, TypeError, AttributeError):
                if not text:
                    return False
                sent = conn.execute("SELECT 1 FROM outbox WHERE state='sent' AND text=?", (text,)).fetchone()
                return sent is not None        # recorded the older way: done only if delivered there
            state = conn.execute("SELECT state FROM outbox WHERE id=?", (row,)).fetchone()
            return bool(state) and state[0] == "sent"
        except sqlite3.Error:
            continue
        finally:
            conn.close()
    return False


def held_messages(kept_path: str, now: str = "") -> list[tuple[str, str, bool, bool]]:
    """Sixteenth round: the messages a kept set still had queued when the records were put back (cards held by the
    fence among them, the restart card's own turn included), not its own post-backs: (key, text, had buttons,
    expired). Seventeenth round: a card whose buttons all ran out by `now` (an ISO time; the choices and approvals
    it was bound to, read in the kept set) is time-bound and its time has passed: expired."""
    import sqlite3
    out: list[tuple[str, str, bool, bool]] = []
    if not os.path.isfile(kept_path):
        return out
    try:
        conn = sqlite3.connect(f"file:{kept_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return out

    def ran_out(binds_json) -> bool:
        try:
            binds = json.loads(binds_json or "[]")
        except ValueError:
            return False
        ends = []
        for b in binds if isinstance(binds, list) else []:
            table = {"choice": "choices", "approval": "approvals"}.get((b or {}).get("type"))
            if table is None:
                return False
            try:
                row = conn.execute(f"SELECT expires_at FROM {table} WHERE nonce=?", (b.get("nonce"),)).fetchone()
            except sqlite3.Error:
                return False
            if row is None or not row[0]:
                return False
            ends.append(str(row[0]))
        return bool(ends) and bool(now) and all(_before(e, now) for e in ends)
    try:
        ours = set()
        for (value,) in conn.execute("SELECT value FROM meta WHERE key LIKE ?", (POSTED + "%",)).fetchall():
            try:
                ours.add(int(json.loads(value).get("outbox")))
            except (ValueError, TypeError, AttributeError):
                pass
        for rid, text, buttons, binds in conn.execute(
                "SELECT id, text, buttons_json, binds_json FROM outbox WHERE state='queued' ORDER BY id").fetchall():
            post_back = str(text).startswith(("<b>Harness's records are back from the backup</b>",
                                              "A request that was waiting in the records set aside",
                                              "<i>A message that was waiting to go out"))
            if rid not in ours and text and not post_back:
                out.append((f"outbox:{rid}", str(text), bool(buttons), ran_out(binds)))
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    return out


def _before(a: str, b: str) -> bool:
    """Whether ISO time `a` is at or before ISO time `b`; False when either can't be read."""
    try:
        return datetime.fromisoformat(a) <= datetime.fromisoformat(b)
    except (TypeError, ValueError):
        return False


def _held_message_text(text: str, buttons: bool, expired: bool = False) -> str:
    """Seventeenth round: no promise that Harness asks again (nothing re-raises it); a card whose time has passed
    says so, for the record only."""
    if expired:
        head = ("<i>A message that was waiting to go out when the records were put back. Its time has passed, so "
                "it's here only for the record" + (" and its buttons are left off" if buttons else "") + ":</i>\n")
    else:
        head = ("<i>A message that was waiting to go out when the records were put back"
                + (" (its buttons belonged to the records set aside, so they're left off)" if buttons else "")
                + ":</i>\n")
    return render.fit(head + text)


def _post_back(ledger: Ledger, chat_id: int, tz: str, kept: str, frm: str) -> int:
    """One kept set's post-back (after_restore): its summary, each held request and (sixteenth round) each message it
    still had queued, once. How many requests it holds."""
    name = os.path.basename(kept)
    items = held_items(kept, tz)
    messages = held_messages(kept, iso(ledger.now()))
    mark_path = kept + POSTBACK
    mark = _read_json(mark_path)
    posted = list(mark.get("posted") or [])
    sent = 0

    def text_for(key: str, lines) -> str:
        if key == "summary":
            return render.fit(
                f"<b>Harness's records are back from the backup</b> "
                f"({render.escape(frm or 'a backup')}). The records they replaced are "
                f"kept as {render.escape(name)}. "
                + (f"{len(items)} request{'s were' if len(items) != 1 else ' was'} waiting there; each "
                   "follows, ready to copy into the calendar app." if items
                   else "No requests were waiting there."))
        if key.startswith("outbox:"):
            return _held_message_text(lines[0], lines[1], lines[2])
        return render.fit("A request that was waiting in the records set aside; ready to copy into the calendar "
                          "app:\n" + "\n".join(lines))
    todo = [("summary", [])] + items + [(k, (t, b, x)) for k, t, b, x in messages]
    for key, lines in todo:
        if key in posted:
            continue
        flag = f"{POSTED}{name}:{key}"
        text = text_for(key, lines)
        if mark.get("pending") == key and (ledger.get_meta(flag) is not None or _went_in_kept(kept, flag, text)):
            posted.append(key)                 # it went; the stop came before the marker said so
            continue
        mark = {"posted": posted, "pending": key, "done": False, "from": frm}
        _write_json(mark_path, mark)
        with ledger.tx() as db:
            dup = key.startswith("outbox:") and db.execute(
                "SELECT 1 FROM outbox WHERE text IN (?, ?)", (text, lines[0])).fetchone() is not None
            if ledger.get_meta(flag) is None and not dup:
                row = ledger.enqueue(chat_id=chat_id, kind="notice", text=text, db=db)
                ledger.set_meta(flag, json.dumps({"at": iso(ledger.now()), "outbox": row}), db)
                sent += key != "summary"
        _swap_step("posted:" + key)
        posted.append(key)
        _write_json(mark_path, {"posted": posted, "pending": None, "done": False, "from": frm})
    with ledger.tx() as db:
        ledger.event("migration_restored", {"from": frm, "kept": name, "held_passed_back": len(items),
                                            "messages_passed_back": len(messages), "sent_now": sent}, db=db)
    _write_json(mark_path, {"posted": posted, "pending": None, "done": True, "from": frm})
    return len(items)


if __name__ == "__main__":
    # python3 -m harness.migrate <ledger path>: this build's dry run on a copy. Tenth round:
    # python3 -m harness.migrate <ledger path> --candidate <tree or image path>: the candidate's own.
    # Twelfth round: python3 -m harness.migrate <ledger path> --restore <schema> <build>: stage that backup.
    # Thirteenth round: it writes only the staged file and its marker, never the ledger, and refuses while the
    # specialist runs (it holds harness.lock); the specialist swaps it in at its next start.
    import sys
    args = sys.argv[1:]
    # Fifteenth round: --swap lists what's at the records' live and kept names (nothing is moved); --set-aside moves
    # the files a refused swap named into a dated folder, after a typed yes, and clears the refusal.
    if len(args) == 2 and args[1] == "--swap":
        base_ = os.path.abspath(args[0])
        plan = _read_json(base_ + SWAP_MARKER)
        readable = _plan_ok(base_, plan)
        movable, protected = swap_conflicts(base_, plan) if readable else ([], [])
        # Sixteenth round: the conflict as the swap's state shows it now, and whether the refusal reached the marker.
        print(json.dumps({"ok": True, "swap_marker": os.path.lexists(base_ + SWAP_MARKER),
                          "marker_readable": readable,
                          "refused": plan.get("refused", ""), "conflict": plan.get("conflict", []),
                          "conflict_now": movable, "protected_now": [f"{n}: {w}" for n, w in protected],
                          "refusal_not_recorded": bool(readable and (movable or protected) and not plan.get("refused")),
                          "files": swap_files(args[0])}, indent=1, sort_keys=True))
        sys.exit(0)
    if len(args) == 4 and args[1] == "--set-aside" and args[2] == "--accept-lost":
        got = accept_lost(args[0], args[3])                     # twenty-first round: records it; moves nothing
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) in (3, 5) and args[1] == "--set-aside" and args[2] == "--taps":
        # twenty-fourth round; twenty-fifth round: an operation (export, discard or requeue) and the tap key
        got = set_aside_taps(args[0], args[4], args[3]) if len(args) == 5 else set_aside_taps(args[0])
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) == 4 and args[1] == "--set-aside" and args[2] == "--taps":
        got = {"ok": False, "said": "name an operation first: --taps export|discard|requeue <tap key> (discard "
                                    "again on a discarded tap clears what its first discard couldn't; run it as the "
                                    "App's own user, the tap journal's owner; each requeue gives the tap up to six "
                                    "Go aheads again, with no limit on requeues, since each is your own explicit act)"}
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) == 2 and args[1] == "--set-aside":
        got = set_aside(args[0])
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) == 4 and args[1] == "--restore":
        got = stage_restore(args[0], args[2], args[3], cli=True)   # refused while the specialist runs
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) == 3 and args[1] == "--candidate":
        got = candidate_dry_run(args[0], args[2])
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) != 1:
        print(json.dumps({"ok": False, "said": "usage: python3 -m harness.migrate <ledger file path> "
                                               "[--candidate <source tree or image path>] "
                                               "[--restore <schema> <build>] [--swap] [--set-aside "
                                               "[--accept-lost <name>]]"}))
        sys.exit(2)
    got = dry_run(args[0])
    print(json.dumps(got, indent=1, sort_keys=True))
    sys.exit(0 if got.get("ok") else 1)
