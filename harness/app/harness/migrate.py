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


def run(ledger: Ledger, cc, chat_id: int) -> dict:
    """Every step not done yet, in order. What it did, for the log and tests."""
    if ledger.get_meta(DONE) is not None:
        if schema(ledger) < HANDOVER:
            with ledger.tx() as db:
                ledger.set_meta(SCHEMA, str(HANDOVER), db)
        return {}
    reads = _read_in_flight(ledger, cc)
    with ledger.tx() as db:
        out = _sweep(ledger, cc, chat_id, reads, db)
        ledger.set_meta(DONE, iso(ledger.now()), db)
        ledger.set_meta(SCHEMA, str(max(schema(ledger), HANDOVER)), db)
    log.info("ledger schema %d: %d card(s) replaced, %d change(s) read back done, %d unverified",
             HANDOVER, out["replaced"], out["done"], out["unverified"])
    return out


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
