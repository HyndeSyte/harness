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
WAITING = "migration_waiting"      # {"build", "version", "at", "told"}: the live ledger waits for a dry run
OVERRIDE = "migration_override:"   # + build: Cain's keeper.sh fastpath migrate-override, logged with who and when
BACKUP = "migration_backup"        # {"path", "build", "at"}: the copy taken just before the last migration
BACKUP_KEEP = 3                    # backups kept beside the ledger, newest first
CANDIDATE_TIMEOUT_S = 120


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


def dry_run_missing(ledger: Ledger, build: str) -> str:
    """Why the live ledger may not be migrated for this build (tenth round), or "": no dry run of this very
    build recorded (or it failed), and no logged override for it."""
    if dry_run_for(ledger, build).get("ok") or ledger.get_meta(OVERRIDE + build) is not None:
        return ""
    got = dry_run_for(ledger, build)
    return (f"the migration dry run recorded for build {build} failed" if got else
            f"no migration dry run is recorded for build {build}")


def waiting(ledger: Ledger) -> dict:
    from . import calendar_change as cal
    return cal._meta_json(ledger, WAITING)


def run_live(ledger: Ledger, cc, chat_id: int, version: str | None = None, build: str | None = None) -> dict:
    """The install step on the live ledger (tenth round): it migrates only once a dry run of this very build
    is recorded in this ledger (keeper.sh fastpath migrate-check, of the candidate before it ships or of
    this build once it runs), or Cain's logged override (keeper.sh fastpath migrate-override); until then
    nothing is migrated, calendar changes wait, and he and Cain are told why. Just before migrating, a
    restorable copy of the ledger is taken beside it (backup)."""
    from . import calendar_change as cal
    version, build = version or cal.app_version(), build or cal.app_build()
    if not needed(ledger, version, build):
        _clear_waiting(ledger)
        return run(ledger, cc, chat_id, version, build)
    why = dry_run_missing(ledger, build)
    if why:
        kept = waiting(ledger)
        with ledger.tx() as db:
            if kept.get("build") != build:
                ledger.set_meta(WAITING, json.dumps({"build": build, "version": version, "at": iso(ledger.now()),
                                                     "why": why}), db)
                ledger.event("migration_waiting", {"build": build, "why": why}, db=db)
                if chat_id:
                    ledger.enqueue(chat_id=chat_id, kind="notice", text=render.fit(
                        f"<b>Harness {render.escape(version)} is installed, but hasn't moved its records over yet.</b> "
                        "Its records are only moved after a rehearsal of this very update on a copy of them, and "
                        "none is recorded for it, so nothing was moved. Until it's done, calendar changes wait "
                        "and nothing on your calendars changes. Cain has been told: he runs the rehearsal (or, "
                        "only on your say, moves them without it), and they're moved then."), db=db)
        log.warning("the live ledger wasn't migrated for build %s: %s; calendar changes wait for keeper.sh "
                    "fastpath migrate-check, or migrate-override", build, why)
        return {"waiting": True, "build": build, "why": why}
    copy = backup(ledger, build)
    if not copy:
        with ledger.tx() as db:
            ledger.set_meta(WAITING, json.dumps({"build": build, "version": version, "at": iso(ledger.now()),
                                                 "why": "the ledger couldn't be backed up first"}), db)
        log.error("the live ledger wasn't migrated for build %s: the backup before it failed", build)
        return {"waiting": True, "build": build, "why": "the ledger couldn't be backed up first"}
    _clear_waiting(ledger)
    out = run(ledger, cc, chat_id, version, build)
    return {**out, "backup": copy}


def _clear_waiting(ledger: Ledger) -> None:
    if ledger.get_meta(WAITING) is not None:
        with ledger.tx() as db:
            db.execute("DELETE FROM meta WHERE key=?", (WAITING,))


def override(ledger: Ledger, by: str) -> dict:
    """Cain's keeper.sh fastpath migrate-override (tenth round): this build's migration may run on the live
    ledger without a dry run, logged with who and when. Only on Dane's say."""
    from . import calendar_change as cal
    build = cal.app_build()
    kept = {"build": build, "by": by, "at": iso(ledger.now())}
    with ledger.tx() as db:
        ledger.set_meta(OVERRIDE + build, json.dumps(kept), db)
        ledger.event("migration_override", kept, db=db)
    log.warning("the migration of build %s may run on the live ledger without a dry run: override by %s", build, by)
    return kept


def backup(ledger: Ledger, build: str) -> str:
    """A restorable copy of the live ledger, taken with SQLite's own backup just before a migration (tenth
    round): beside the ledger file, named for the build and the time; the newest BACKUP_KEEP are kept. Its
    path, or "" when it couldn't be made (then nothing is migrated). To restore: stop the App, copy it over
    the ledger file (harness.sqlite), start the App (DOCS.md)."""
    import glob
    import os
    import sqlite3
    if not ledger.path or ledger.path == ":memory:":
        return ""
    folder = os.path.dirname(os.path.abspath(ledger.path))
    stamp = ledger.now().strftime("%Y%m%dT%H%M%SZ")
    safe = "".join(c for c in build if c.isalnum())[:32] or "unknown"
    dest = os.path.join(folder, f"harness-before-{safe}-{stamp}.sqlite")
    try:
        dst = sqlite3.connect(dest)
        with dst:
            ledger.db.backup(dst)
        dst.close()
    except (sqlite3.Error, OSError) as e:
        log.error("the ledger backup before the migration failed: %s", type(e).__name__)
        return ""
    old = sorted(glob.glob(os.path.join(folder, "harness-before-*.sqlite")), key=os.path.getmtime, reverse=True)
    for extra in old[BACKUP_KEEP:]:
        try:
            os.remove(extra)
        except OSError:
            pass
    with ledger.tx() as db:
        ledger.set_meta(BACKUP, json.dumps({"path": dest, "build": build, "at": iso(ledger.now())}), db)
        ledger.event("migration_backup", {"path": os.path.basename(dest), "build": build}, db=db)
    log.info("ledger backed up before the migration of build %s: %s", build, os.path.basename(dest))
    return dest


def run(ledger: Ledger, cc, chat_id: int, version: str | None = None, build: str | None = None) -> dict:
    """Every step not done yet, in order, then the install step. What it did, for the log and tests."""
    if ledger.get_meta(DONE) is not None:
        if schema(ledger) < HANDOVER:
            with ledger.tx() as db:
                ledger.set_meta(SCHEMA, str(HANDOVER), db)
        out = {}
    else:
        reads = _read_in_flight(ledger, cc)
        with ledger.tx() as db:
            out = _sweep(ledger, cc, chat_id, reads, db)
            ledger.set_meta(DONE, iso(ledger.now()), db)
            ledger.set_meta(SCHEMA, str(max(schema(ledger), HANDOVER)), db)
        log.info("ledger schema %d: %d card(s) replaced, %d change(s) read back done, %d unverified",
                 HANDOVER, out["replaced"], out["done"], out["unverified"])
    done = install(ledger, cc, version, build)
    if done:
        out = {**out, "install": done}
    return out


def record_dry_run(ledger: Ledger, got: dict) -> dict:
    """keeper.sh fastpath migrate-check's result, kept in the live ledger (ninth round): keyed by the build
    that ran it, with the checksum of the ledger copy it ran on, whether it passed and when. What was kept."""
    from . import calendar_change as cal
    kept = {"build": got.get("build") or cal.app_build(), "version": got.get("version") or cal.app_version(),
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


def install(ledger: Ledger, cc, version: str | None = None, build: str | None = None) -> dict:
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
    with ledger.tx() as db:
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
    return out


def dry_run(path: str, version: str | None = None, build: str | None = None) -> dict:
    """The migration run on a copy of the ledger at `path`, never on the file itself (eighth round: a gate
    Cain runs on the Pi before a Ship card). The file is opened read only and copied with SQLite's own
    backup into a temporary file, which is migrated with no calendars (a change left in flight is counted,
    not read) and then deleted. What it found: the schema version, whether the no-card paths are off,
    the gate as set, how many Turn on cards are still open, and how many rows it touched."""
    import os
    import sqlite3
    import tempfile
    from . import calendar_change as cal
    if not path or not os.path.isfile(path):
        return {"ok": False, "said": f"no ledger file at {path or '(none given)'}"}
    tmp = tempfile.mkdtemp(prefix="harness-migrate-check-")
    copy = os.path.join(tmp, "ledger-copy.sqlite")
    try:
        src = sqlite3.connect(f"file:{os.path.abspath(path)}?mode=ro", uri=True)
        try:
            dst = sqlite3.connect(copy)
            with dst:
                src.backup(dst)
            dst.close()
        finally:
            src.close()
        import hashlib
        with open(copy, "rb") as f:
            checksum = hashlib.sha256(f.read()).hexdigest()   # the copy as it was before the migration ran
        led = Ledger(copy)
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
                  "install": out.get("install") or {}}
        led.db.close()
        return result
    except sqlite3.Error as e:
        return {"ok": False, "said": f"the ledger copy couldn't be read: {type(e).__name__}"}
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


if __name__ == "__main__":
    # python3 -m harness.migrate <ledger path>: this build's dry run on a copy. Tenth round:
    # python3 -m harness.migrate <ledger path> --candidate <tree or image path>: the candidate's own.
    import sys
    args = sys.argv[1:]
    if len(args) == 3 and args[1] == "--candidate":
        got = candidate_dry_run(args[0], args[2])
        print(json.dumps(got, indent=1, sort_keys=True))
        sys.exit(0 if got.get("ok") else 1)
    if len(args) != 1:
        print(json.dumps({"ok": False, "said": "usage: python3 -m harness.migrate <ledger file path> "
                                               "[--candidate <source tree or image path>]"}))
        sys.exit(2)
    got = dry_run(args[0])
    print(json.dumps(got, indent=1, sort_keys=True))
    sys.exit(0 if got.get("ok") else 1)
