"""Commands: plain code, no model, always answered.

  /stop    kill switch. Nothing new starts; anything that arrives is
           recorded and cancelled with a receipt. The digest and these
           commands keep working, so /resume always does.
  /resume  undo /stop.
  /cancel  cancel everything pending: queued and running jobs, and open
           proposals (their buttons stop working).
  /status  what it is doing, in one screen.
  /rule    the standing rules, and any waiting for him to pick a side.
  /undo    retire the newest rule (or /undo R1a2b3c for a specific one).
  /checkadds  every Family calendar add needs his Approve tap again, at once.

Each command is a job of its own, so it gets a receipt like anything else.

What he asked while stopped isn't lost and isn't his to send again (org rule R-004): each request
not acted on is kept (note_stopped), and after /resume (Turn back on) comes back as a card of its
own, his words in short with "Do it now" and "Drop it". Do it now runs that message as if just
sent, with the time he sent it given to the model, so "tomorrow" still means his tomorrow.
"""
from __future__ import annotations

import json
from typing import Callable

from . import choices, render, rules
from .ledger import Ledger, iso

STOPPED = "stopped_requests"           # his requests not acted on while stopped: job ids, in order
STOPPED_CARD_TTL_S = 3 * 24 * 3600
FEW_WORDS = 60                         # his request on its card, in about this many characters


def is_paused(ledger: Ledger) -> bool:
    return ledger.get_meta("paused") == "1"


def note_stopped(ledger: Ledger, job_id: str, db) -> None:
    """A request of his that wasn't acted on because he'd stopped it: it comes back after /resume."""
    ids = json.loads(ledger.get_meta(STOPPED) or "[]")
    if job_id not in ids:
        ledger.set_meta(STOPPED, json.dumps(ids + [job_id]), db)


def _few_words(text: str) -> str:
    """His request, short enough for a card: whole words, his own."""
    words = " ".join(text.split("\n\n[A suggestion from Cain", 1)[0].split())
    if len(words) > FEW_WORDS:
        words = words[:FEW_WORDS].rsplit(" ", 1)[0].rstrip(",;:.") + "..."
    return render.escape(render.defang(render.no_dashes(words)))


def card_stopped(ledger: Ledger, chat_id: int, db) -> int:
    """One card per request he sent while stopped: a decision, never a chore."""
    ids = json.loads(ledger.get_meta(STOPPED) or "[]")
    n = 0
    for job_id in ids:
        job = db.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()
        text = ledger.job_text(job_id)
        if job is None or job["state"] not in ("cancelled", "failed") or not text.strip():
            continue
        redo = choices.mint(ledger, kind="stopped_redo", target=job_id, chat_id=chat_id,
                            ttl_s=STOPPED_CARD_TTL_S, db=db)
        drop = choices.mint(ledger, kind="stopped_drop", target=job_id, chat_id=chat_id,
                            ttl_s=STOPPED_CARD_TTL_S, db=db)
        ledger.enqueue(chat_id=chat_id, kind="card", job_id=job_id, db=db,
                       text=f"While I was stopped, you asked: \u201c{_few_words(text)}\u201d. Do it now?",
                       buttons=[[("Do it now", choices.callback_data(redo)),
                                 ("Drop it", choices.callback_data(drop))]],
                       binds=[{"type": "choice", "nonce": redo}, {"type": "choice", "nonce": drop}])
        n += 1
    db.execute("DELETE FROM meta WHERE key=?", (STOPPED,))
    return n


def on_stopped_choice(ledger: Ledger, kind: str, job_id: str) -> str:
    """His tap on one of those cards. Do it now: that message runs again, as if just sent."""
    job = ledger.job(job_id)
    receipts = ledger.receipts(job_id) if job is not None else []
    try:
        reason = json.loads(receipts[-1]["detail"] or "{}").get("reason") if receipts else None
    except (ValueError, TypeError, AttributeError):
        reason = None
    if job is None or job["state"] not in ("cancelled", "failed") or reason != "stopped":
        return "That isn't waiting any more, so nothing changed."
    if kind == "stopped_drop":
        with ledger.tx() as db:
            ledger.event("stopped_dropped", {"job": job_id}, db=db)
        return "Dropped. Nothing was done."
    if is_paused(ledger):
        with ledger.tx() as db:
            note_stopped(ledger, job_id, db)
        return "I'm stopped again, so it waits. Its card comes back after you turn me back on."
    with ledger.tx() as db:
        ledger.transition(job_id, "received", db=db)
        ledger.event("stopped_redone", {"job": job_id}, db=db)
    return "Doing it now."


def _args(text: str) -> tuple[str, str]:
    parts = text.strip().split(maxsplit=1)
    name = parts[0].split("@", 1)[0].lower()
    return name, (parts[1].strip() if len(parts) > 1 else "")


class Commands:
    def __init__(self, ledger: Ledger, *, status_fn: Callable[[], str],
                 cancel_fn: Callable[[str], None],
                 screen_fn: Callable[[str], str | None] = lambda text: None,
                 checkadds_fn: Callable[[], str] | None = None):
        self.checkadds_fn = checkadds_fn  # family_add.FamilyAdd.check_adds, or None
        self.ledger = ledger
        self.screen_fn = screen_fn        # the work-content filter, for decoded text
        self.status_fn = status_fn
        self.cancel_fn = cancel_fn        # tells the runner to drop a worker

    def handle_pending(self) -> int:
        n = 0
        for job in self.ledger.jobs_in("received"):
            if job["kind"] != "command":
                continue
            self.handle(job)
            n += 1
        return n

    def handle(self, job) -> None:
        name, arg = _args(self.ledger.job_text(job["id"]))
        fn = getattr(self, "_" + name.lstrip("/"), None)
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "running", db=db)
        reply = fn(arg) if fn else "Unknown command."
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "answered",
                                   receipt=json.dumps({"command": name}), db=db)
            self.ledger.enqueue(chat_id=job["chat_id"], kind="reply", job_id=job["id"],
                                text=render.fit(reply), db=db)
            if name == "/resume" and not is_paused(self.ledger):
                card_stopped(self.ledger, job["chat_id"], db)
            self.ledger.release_held(db=db)

    # -- the commands ---------------------------------------------------------
    def _stop(self, arg: str) -> str:
        with self.ledger.tx() as db:
            self.ledger.set_meta("paused", "1", db)
            self.ledger.set_meta("paused_at", iso(self.ledger.now()), db)
            self.ledger.event("paused", {}, db=db)
        running = len(self.ledger.jobs_in("running"))
        tail = (f" {running} job already running will finish or time out."
                if running else "")
        return ("<b>Stopped.</b> I won't start anything new until /resume. "
                "The morning digest keeps coming." + tail)

    def _resume(self, arg: str) -> str:
        if not is_paused(self.ledger):
            return "Not stopped. Nothing to resume."
        with self.ledger.tx() as db:
            self.ledger.set_meta("paused", "0", db)
            self.ledger.event("resumed", {}, db=db)
        if json.loads(self.ledger.get_meta(STOPPED) or "[]"):
            return "<b>Resumed.</b> What you asked while I was stopped comes next, one card each."
        return "<b>Resumed.</b>"

    def _cancel(self, arg: str) -> str:
        cancelled: list[str] = []
        with self.ledger.tx() as db:
            for job in self.ledger.jobs_in("received", "running", "proposed"):
                if job["kind"] == "command":
                    continue
                if job["state"] == "proposed":
                    db.execute("UPDATE proposals SET state='cancelled' WHERE job_id=?"
                               " AND state='proposed'", (job["id"],))
                    db.execute("UPDATE approvals SET consumed_at=?, outcome='cancelled'"
                               " WHERE consumed_at IS NULL AND proposal_id IN"
                               " (SELECT id FROM proposals WHERE job_id=?)",
                               (iso(self.ledger.now()), job["id"]))
                self.ledger.transition(job["id"], "cancelled",
                                       receipt=json.dumps({"reason": "/cancel"}), db=db)
                cancelled.append(job["id"])
        for job_id in cancelled:
            self.cancel_fn(job_id)
        n = len(cancelled)
        approved = len(self.ledger.jobs_in("approved"))
        tail = (f" {approved} approved action is already executing and can't be cancelled."
                if approved else "")
        return (f"Cancelled {n}." if n else "Nothing pending.") + tail

    def _status(self, arg: str) -> str:
        return self.status_fn()

    def _checkadds(self, arg: str) -> str:
        return self.checkadds_fn() if self.checkadds_fn else "Nothing changed: no adds here."

    def _rule(self, arg: str) -> str:
        active, quarantined = rules.listing(self.ledger)
        waiting = rules.awaiting(self.ledger)
        if not active and not quarantined and not waiting:
            return ("No standing rules yet. Correct me in plain words "
                    "(\"keep drafts shorter\") and I'll offer to keep it.")
        lines = ["<b>Standing rules</b>"] if active else []
        for r in active:
            where = "everything" if r["scope"] == "all" else r["scope"]
            lines.append(f"{render.escape(r['id'])} · {render.escape(where)}: "
                         f"{render.escape(r['field'])} = {render.family_text(r['value'])}")
        if quarantined:
            lines.append("<b>Waiting for you to pick a side</b>")
            for r in quarantined:
                lines.append(f"{render.escape(r['id'])} · {render.escape(r['scope'])}: "
                             f"{render.escape(r['field'])} = {render.family_text(r['value'])}")
        if waiting:
            lines.append("<b>Not in use, waiting for your tap on its card</b>")
            for r in waiting:
                lines.append(f"{render.escape(r['id'])} · {render.escape(r['scope'])}: "
                             f"{render.escape(r['field'])} = {render.family_text(r['value'])}")
        lines.append("<i>/undo retires the newest; /undo R1a2b3c a specific one.</i>")
        return "\n".join(lines)

    def _undo(self, arg: str) -> str:
        if arg:
            target = arg.split()[0]
        else:
            row = rules.latest_active(self.ledger)
            if row is None:
                return "No rule to undo."
            target = row["id"]
        try:
            return render.escape(rules.undo(self.ledger, target)) + \
                f" <i>({render.escape(target)} retired)</i>"
        except rules.RuleError as e:
            return render.escape(f"Couldn't undo {target}: {e}.")
