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


def schema(ledger: Ledger) -> int:
    try:
        return int(ledger.get_meta(SCHEMA) or 1)
    except ValueError:
        return 1


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
    out = {"version": version, "build": build, "from": kept.get("version", ""), "from_build": kept.get("build", ""),
           "fast_path_off": False, "run_closed": False, "cards_retired": 0}
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
        led = Ledger(copy)
        before_schema = schema(led)
        before = led.db.total_changes
        in_flight = len(_in_flight(led.db))
        out = run(led, None, 0, version=version, build=build)
        touched = led.db.total_changes - before
        gate = cal.card_gate(led)
        open_turn_on = led.db.execute("SELECT COUNT(*) FROM choices WHERE kind='calendar_change_fast_on' AND"
                                      " consumed_at IS NULL").fetchone()[0]
        result = {"ok": True, "copy_of": path, "schema_before": before_schema, "schema": schema(led),
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


if __name__ == "__main__":                       # python3 -m harness.migrate <ledger path>: the dry run
    import sys
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "said": "usage: python3 -m harness.migrate <ledger file path>"}))
        sys.exit(2)
    got = dry_run(sys.argv[1])
    print(json.dumps(got, indent=1, sort_keys=True))
    sys.exit(0 if got.get("ok") else 1)
