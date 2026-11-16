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

import json
import logging
from datetime import datetime

from . import approvals, choices, effects, provenance, render
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
    its container (dry_run), and records it. What was kept."""
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
             tell: bool = False) -> dict:
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
            return _run_live(ledger, cc, chat_id, version, build, tell)
    except TimeoutError as e:
        return _wait(ledger, chat_id, version, build, f"the ledger couldn't be held for the move ({e})", tell)


def _run_live(ledger: Ledger, cc, chat_id: int, version: str, build: str, tell: bool) -> dict:
    if not needed(ledger, version, build):
        _clear_waiting(ledger)
        return run(ledger, cc, chat_id, version, build)
    try:
        check_steps(STEPS, ledger)
    except StepConflict as e:
        return _wait(ledger, chat_id, version, build, f"the schema steps conflict: {e}", tell)
    why = dry_run_missing(ledger, build)
    if why:
        self_dry_run(ledger, version, build)
        why = dry_run_missing(ledger, build)
    if why:
        return _wait(ledger, chat_id, version, build, why, tell)
    copy = backup(ledger, build)
    if not copy:
        return _wait(ledger, chat_id, version, build, "the ledger couldn't be backed up and checked first", tell)
    try:
        out = run(ledger, cc, chat_id, version, build,
                  finish=lambda db: (_clear_waiting(ledger, db), _succeeded(ledger, build, db)))
    except Exception as e:   # noqa: BLE001: a failed migration leaves the ledger as it was, and waits
        log.error("the migration of build %s failed: %s", build, type(e).__name__)
        return _wait(ledger, chat_id, version, build, f"the migration failed ({type(e).__name__})", tell)
    return {**out, "backup": copy}


def _wait(ledger: Ledger, chat_id: int, version: str, build: str, why: str, tell: bool) -> dict:
    """Nothing is migrated: calendar changes wait. He's told once per build (and again after a Run check tap
    that failed too), with Run check as the only button. Twelfth round: the notice's outbox row is kept, so
    one Discord never took is posted again (tend_waiting), and a reminder goes once a day while it waits."""
    kept = waiting(ledger)
    with ledger.tx() as db:
        first = kept.get("build") != build
        rec = {"build": build, "version": version, "at": iso(ledger.now()), "why": why,
               "since": kept.get("since") if not first and kept.get("since") else iso(ledger.now()),
               "notice": kept.get("notice") if not first else None}
        if first:
            ledger.event("migration_waiting", {"build": build, "why": why}, db=db)
        if (first or tell) and chat_id:
            rec["notice"] = _post_waiting(ledger, chat_id, version, why, db)
        ledger.set_meta(WAITING, json.dumps(rec), db)
    log.warning("the live ledger wasn't migrated for build %s: %s; calendar changes wait for Run check (or "
                "keeper.sh fastpath migrate-check)", build, why)
    return {"waiting": True, "build": build, "why": why}


def _post_waiting(ledger: Ledger, chat_id: int, version: str, why: str, db, reminder: bool = False) -> int:
    """The Run check notice (or its daily reminder). Its outbox row id."""
    nonce = choices.mint(ledger, kind="migration_check", target=version, chat_id=chat_id, ttl_s=CARD_TTL_S, db=db)
    head = (f"<b>Still waiting: Harness {render.escape(version)} hasn't moved its records over yet.</b> "
            if reminder else
            f"<b>Harness {render.escape(version)} is installed, but hasn't moved its records over yet.</b> ")
    return ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit(
        head + "Before moving them it rehearses the move on a copy of them, and that rehearsal didn't pass: "
        f"{render.escape(why)}. So nothing was moved. Until it's done, calendar changes wait and nothing "
        "on your calendars changes. Run check rehearses it again, and if it passes the records are "
        "moved then, with a backup taken first."),
        buttons=[[("Run check", choices.callback_data(nonce))]],
        binds=[{"type": "choice", "nonce": nonce}], db=db)


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
                                       reminder=did == "reminded")
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
            "notice": notice_state(ledger) or "none"}


def _clear_waiting(ledger: Ledger, db=None) -> None:
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


def heartbeat(ledger: Ledger, mono: float | None = None, force: bool = False) -> float:
    """The App's run time, summed in the ledger from the monotonic clock, never the wall clock: each call adds
    the time since the last one (in this process), written at most every HEARTBEAT_S. The run time now."""
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
    if last[1] >= HEARTBEAT_S or (force and last[1] > 0):
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
    now = ledger.now()
    from datetime import timezone as _tz
    if now < datetime(*CLOCK_FLOOR, tzinfo=_tz.utc):
        return "the clock isn't set yet"
    row = ledger.db.execute("SELECT MAX(at) FROM events").fetchone()
    try:
        newest = datetime.fromisoformat(row[0]) if row and row[0] else None
    except ValueError:
        newest = None
    if newest is not None and now < newest:
        return "the clock is earlier than the newest time the ledger recorded"
    return ""


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
    out = run_live(ledger, cc, chat_id, tell=True) if got.get("ok") else \
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
    out = run_live(ledger, cc, chat_id)
    if out.get("waiting"):
        with ledger.tx() as db:
            db.execute("DELETE FROM meta WHERE key=?", (OVERRIDE + build,))
        return f"The records couldn't be moved: {render.escape(out.get('why', 'see the log'))}. Nothing changed."
    return "Moved without a rehearsal, as you asked, with a backup taken first. That's kept in the log."


def checkpoint(ledger: Ledger) -> None:
    """Folds the write-ahead log into the ledger file (twelfth round), so a copy starts from a settled file.
    The copy itself is still taken through SQLite (copy_ledger), which reads anything left in the log too."""
    import sqlite3
    try:
        ledger.db.execute("PRAGMA wal_checkpoint(FULL)").fetchall()
    except sqlite3.Error as e:
        log.warning("the ledger's checkpoint before its copy didn't run: %s", type(e).__name__)


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
            log.warning("no backup is pruned now: %s", clock)
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


# -- restore (twelfth round) ----------------------------------------------------------------------------------

def find_backup(ledger_path: str, schema_n: int, build: str) -> str:
    """The newest backup beside the ledger taken at that source schema version before that build's migration
    (named harness-before-s<schema>-<build>-<time>.sqlite), or "" when there's none."""
    import glob
    import os
    folder = os.path.dirname(os.path.abspath(ledger_path))
    found = sorted(p for p in glob.glob(os.path.join(folder, f"harness-before-s{int(schema_n)}-{_safe_build(build)}-*"
                                                                ".sqlite")) if not p.endswith(".part"))
    if found:
        return found[-1]
    # One taken for an earlier build whose content was the same (backup's dedup) is kept under this build too.
    import sqlite3
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


def stage_restore(ledger_path: str, schema_n: int, build: str) -> dict:
    """Restore, keyed by schema and build: the backup find_backup names is checked (integrity) and copied with
    SQLite's backup API to <ledger>.restore beside the ledger. Nothing is replaced while the App runs: the
    staged copy is swapped in at its next start (apply_staged_restore), the ledger it replaces kept beside it.
    Then the App migrates it again as on any install (run_live)."""
    import os
    import sqlite3
    try:
        n = int(schema_n)
    except (TypeError, ValueError):
        return {"ok": False, "said": "the schema version is a whole number"}
    chosen = find_backup(ledger_path, n, build)
    if not chosen:
        return {"ok": False, "said": f"no backup beside the ledger for schema {n} and build {build}"}
    problem = verify_copy(chosen)
    if problem:
        return {"ok": False, "said": f"that backup can't be used: {problem}", "backup": os.path.basename(chosen)}
    staged = os.path.abspath(ledger_path) + RESTORE_SUFFIX
    _remove(staged)
    try:
        copy_ledger(chosen, staged)
    except (sqlite3.Error, OSError) as e:
        _remove(staged)
        return {"ok": False, "said": f"the backup couldn't be staged ({type(e).__name__})"}
    with open(staged + ".json", "w", encoding="utf-8") as f:
        json.dump({"from": os.path.basename(chosen), "schema": n, "build": build}, f)
    log.warning("restore staged from %s: it replaces the ledger at the App's next start", os.path.basename(chosen))
    return {"ok": True, "staged": os.path.basename(staged), "backup": os.path.basename(chosen),
            "said": "Staged. It replaces the records the next time Harness starts; the records it replaces are "
                    "kept beside them, and the restored ones move to this build again."}


def apply_staged_restore(ledger_path: str, now: datetime | None = None) -> dict:
    """At startup, before the ledger opens: a staged restore (stage_restore) is checked again and swapped in.
    The ledger it replaces is copied first with SQLite's backup API (its log included) to
    harness-replaced-<time>.sqlite beside it. {} when nothing is staged."""
    import os
    import sqlite3
    from datetime import timezone as _tz
    staged = os.path.abspath(ledger_path) + RESTORE_SUFFIX
    if not os.path.isfile(staged):
        return {}
    problem = verify_copy(staged)
    if problem:
        log.error("the staged restore wasn't used: %s", problem)
        os.replace(staged, staged + ".refused")
        return {"ok": False, "said": problem}
    stamp = (now or datetime.now(_tz.utc)).strftime("%Y%m%dT%H%M%SZ")
    folder = os.path.dirname(os.path.abspath(ledger_path))
    kept = os.path.join(folder, f"harness-replaced-{stamp}.sqlite")
    if os.path.isfile(ledger_path):
        try:
            copy_ledger(ledger_path, kept)
        except (sqlite3.Error, OSError) as e:
            log.error("the staged restore wasn't used: the ledger it replaces couldn't be kept (%s)",
                      type(e).__name__)
            return {"ok": False, "said": "the ledger it replaces couldn't be kept"}
    for extra in ("-wal", "-shm"):
        _remove(os.path.abspath(ledger_path) + extra)
    os.replace(staged, ledger_path)
    info = {}
    try:
        with open(staged + ".json", encoding="utf-8") as f:
            info = json.load(f)
    except (OSError, ValueError):
        pass
    _remove(staged + ".json")
    log.warning("restored the ledger from %s; the one it replaced is %s", info.get("from", "a staged backup"),
                os.path.basename(kept))
    return {"ok": True, "from": info.get("from", ""), "replaced": os.path.basename(kept)}


def request_restore(ledger: Ledger, chat_id: int, key: str, by: str) -> tuple[str, str]:
    """Cain's keeper.sh fastpath migrate-restore <schema> <build> (twelfth round): only posts him a card naming
    the backup; it's staged only on his tap (restore_tapped). (status, said)."""
    import os
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
            "them. Put them back replaces the records with it the next time Harness starts: anything recorded "
            "since that backup is set aside (kept beside them, not deleted), and the records then move to the "
            "running build again, with a new backup first."),
            buttons=[[("Put them back", choices.callback_data(nonce))]],
            binds=[{"type": "choice", "nonce": nonce}], db=db)
        ledger.event("migration_restore_asked", {"backup": os.path.basename(chosen), "by": by}, db=db)
    return "ok", ("He has a card to put the records back from that backup; it's staged only on his tap and used "
                  "the next time Harness starts. Nothing changed yet.")


def restore_tapped(ledger: Ledger, target: str) -> str:
    """His tap on the restore card: stages it (stage_restore). What to tell him."""
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
    return ("Ready: the records are put back from that backup the next time Harness starts, which an update or "
            "a restart of the Home Assistant host does. What they replace is kept beside them.")


if __name__ == "__main__":
    # python3 -m harness.migrate <ledger path>: this build's dry run on a copy. Tenth round:
    # python3 -m harness.migrate <ledger path> --candidate <tree or image path>: the candidate's own.
    # Twelfth round: python3 -m harness.migrate <ledger path> --restore <schema> <build>: stage that backup.
    import sys
    args = sys.argv[1:]
    if len(args) == 4 and args[1] == "--restore":
        got = stage_restore(args[0], args[2], args[3])
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) == 3 and args[1] == "--candidate":
        got = candidate_dry_run(args[0], args[2])
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) != 1:
        print(json.dumps({"ok": False, "said": "usage: python3 -m harness.migrate <ledger file path> "
                                               "[--candidate <source tree or image path>] "
                                               "[--restore <schema> <build>]"}))
        sys.exit(2)
    got = dry_run(args[0])
    print(json.dumps(got, indent=1, sort_keys=True))
    sys.exit(0 if got.get("ok") else 1)
