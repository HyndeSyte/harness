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
  /start   hello; a link on an instrument card opens here with the card's
           title (deeplink.py). It opens a conversation, nothing more.

Each command is a job of its own, so it gets a receipt like anything else.
"""
from __future__ import annotations

import json
from typing import Callable

from . import deeplink, render, rules
from .ledger import Ledger, iso

HELP = [("stop", "Stop: start nothing new"), ("resume", "Resume after /stop"),
        ("cancel", "Cancel everything pending"), ("status", "What it's doing"),
        ("rule", "Your standing rules"), ("undo", "Undo the newest rule")]


def is_paused(ledger: Ledger) -> bool:
    return ledger.get_meta("paused") == "1"


def _args(text: str) -> tuple[str, str]:
    parts = text.strip().split(maxsplit=1)
    name = parts[0].split("@", 1)[0].lower()
    return name, (parts[1].strip() if len(parts) > 1 else "")


class Commands:
    def __init__(self, ledger: Ledger, *, status_fn: Callable[[], str],
                 cancel_fn: Callable[[str], None],
                 screen_fn: Callable[[str], str | None] = lambda text: None):
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
        return "<b>Resumed.</b> Anything you sent while stopped was not acted on; resend it."

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

    def _rule(self, arg: str) -> str:
        active, quarantined = rules.listing(self.ledger)
        if not active and not quarantined:
            return ("No standing rules yet. Correct me in plain words "
                    "(\"keep drafts shorter\") and I'll offer to keep it.")
        lines = ["<b>Standing rules</b>"] if active else []
        for r in active:
            where = "everything" if r["scope"] == "all" else r["scope"]
            lines.append(f"{render.escape(r['id'])} · {render.escape(where)}: "
                         f"{render.escape(r['field'])} = {render.escape(r['value'])}")
        if quarantined:
            lines.append("<b>Waiting for you to pick a side</b>")
            for r in quarantined:
                lines.append(f"{render.escape(r['id'])} · {render.escape(r['scope'])}: "
                             f"{render.escape(r['field'])} = {render.escape(r['value'])}")
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

    def _start(self, arg: str) -> str:
        if arg:
            title = deeplink.decode(arg)
            if title is None:
                return "That link doesn't open anything."
            if self.screen_fn(title):
                self.ledger.event("deeplink", {"kind": "card", "refused": "work content"})
                return "That card's title looks like work content, so I didn't keep it."
            self.ledger.event("deeplink", {"kind": "card"})
            return (f"From your instrument card: <b>{render.model_text(title)}</b>\n"
                    "Tell me what happened, or what you want done about it.")
        return ("This is your harness. Send me anything: a question, a draft to write, "
                "a decision to think through. /status shows what I'm doing.")
