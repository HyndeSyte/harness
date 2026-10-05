"""Standing rules: corrections that stick, typed and scoped.

Every round-4 reviewer flagged the same failure: free-form "from now on"
sentences accumulate into a second, invisible operating system that no
one can reconstruct six weeks later. So a rule here is a typed record:

    rule_type · scope · field · value · his literal words · provenance ·
    version · supersedes · state

  * A model may PROPOSE a rule from his words; this module decides
    whether it may exist. Only a closed set of fields is learnable, and
    none of them touches effects, approvals, credentials, recipients,
    calendars, budgets or policy -- learned rules shape how answers are
    written, never what the harness is allowed to do.
  * Same scope and field: the new rule supersedes the old one at once,
    shown back with an undo.
  * Overlapping scope with a different value (a rule for "all" against a
    rule for "drafts"): never resolved silently. The new rule waits in
    quarantine and he is asked which one he meant.
  * Receipts list the rule ids that fired, so behavior is traceable.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from .ledger import Ledger, _null, iso

RULE_TYPES = frozenset({"presentation", "drafting", "routing_preference",
                        "prohibition"})
SCOPES = frozenset({"all", "answer", "summarize", "draft", "options",
                    "digest"})
# The only things a correction can change. Deliberately small.
FIELDS = frozenset({"length", "tone", "format", "greeting", "sign_off",
                    "detail_level", "avoid_phrase", "prefer_phrase",
                    "units", "language", "preferred_model"})
# Never learnable, whatever the wording. Checked as substrings too, so a
# field like "effect_scope" or "approval_mode" cannot sneak through.
FORBIDDEN = ("effect", "approv", "credential", "token", "key", "recipient",
             "attendee", "calendar", "budget", "policy", "permission", "scope",
             "send", "pay", "account")
MAX_VALUE = 200


class RuleError(ValueError):
    pass


@dataclass(frozen=True)
class Outcome:
    status: str          # "active" | "superseded_previous" | "quarantined"
    rule_id: str
    conflicts_with: tuple[str, ...] = ()
    message: str = ""


def _check(rule: dict) -> dict:
    allowed = {"rule_type", "scope", "field", "value", "literal"}
    extra = set(rule) - allowed
    if extra:
        raise RuleError(f"unexpected rule keys: {sorted(extra)}")
    for k in allowed:
        if not isinstance(rule.get(k), str) or not rule[k].strip():
            raise RuleError(f"{k}: required text")
    rt, scope, fld = rule["rule_type"], rule["scope"], rule["field"]
    if rt not in RULE_TYPES:
        raise RuleError(f"unknown rule type {rt!r}")
    if scope not in SCOPES:
        raise RuleError(f"unknown scope {scope!r}")
    low = fld.lower()
    if any(f in low for f in FORBIDDEN):
        raise RuleError(f"{fld!r} can never be changed by a correction")
    if fld not in FIELDS:
        raise RuleError(f"{fld!r} is not a learnable field")
    if len(rule["value"]) > MAX_VALUE:
        raise RuleError("value too long")
    return {k: rule[k].strip() for k in allowed}


def _overlaps(a: str, b: str) -> bool:
    return a == b or "all" in (a, b)


def _tx(ledger: Ledger, db):
    return ledger.tx() if db is None else _null(db)


def propose(ledger: Ledger, rule: dict, *, job_id: str | None, db=None) -> Outcome:
    r = _check(rule)
    now = iso(ledger.now())
    rid = "R" + uuid.uuid4().hex[:6]
    with _tx(ledger, db) as db:
        active = db.execute(
            "SELECT * FROM rules WHERE state='active' AND field=?", (r["field"],)).fetchall()
        same = [x for x in active if x["scope"] == r["scope"]]
        overlapping = [x for x in active
                       if x["scope"] != r["scope"] and _overlaps(x["scope"], r["scope"])
                       and x["value"] != r["value"]]
        if overlapping:
            db.execute(
                "INSERT INTO rules(id, rule_type, scope, field, value, literal,"
                " provenance_job_id, version, supersedes, state, created_at, updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (rid, r["rule_type"], r["scope"], r["field"], r["value"], r["literal"],
                 job_id, 1, None, "quarantined", now, now))
            ids = tuple(x["id"] for x in overlapping)
            return Outcome("quarantined", rid, ids,
                           f"This clashes with {', '.join(ids)}. Which should win?")
        version, supersedes = 1, None
        if same:
            prev = same[0]
            version, supersedes = prev["version"] + 1, prev["id"]
            db.execute("UPDATE rules SET state='superseded', updated_at=? WHERE id=?",
                       (now, prev["id"]))
        db.execute(
            "INSERT INTO rules(id, rule_type, scope, field, value, literal,"
            " provenance_job_id, version, supersedes, state, created_at, updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, r["rule_type"], r["scope"], r["field"], r["value"], r["literal"],
             job_id, version, supersedes, "active", now, now))
        ledger.event("rule", {"id": rid, "supersedes": supersedes}, db=db)
    where = "everything" if r["scope"] == "all" else f"{r['scope']} jobs"
    msg = f"Saved for {where}: {r['field']} = {r['value']}."
    return Outcome("superseded_previous" if supersedes else "active", rid, (), msg)


def undo(ledger: Ledger, rule_id: str, db=None) -> str:
    """Retire a rule and bring back the one it replaced, if any."""
    now = iso(ledger.now())
    with _tx(ledger, db) as db:
        row = db.execute("SELECT * FROM rules WHERE id=?", (rule_id,)).fetchone()
        if row is None or row["state"] not in ("active", "quarantined"):
            raise RuleError("nothing to undo")
        db.execute("UPDATE rules SET state='retired', updated_at=? WHERE id=?", (now, rule_id))
        if row["state"] == "active" and row["supersedes"]:
            db.execute("UPDATE rules SET state='active', updated_at=? WHERE id=?",
                       (now, row["supersedes"]))
            return f"Undone. Back to {row['supersedes']}."
    return "Undone."


def resolve(ledger: Ledger, quarantined_id: str, keep: str, db=None) -> str:
    """He picked a side. `keep` is 'new' or 'old'."""
    now = iso(ledger.now())
    with _tx(ledger, db) as db:
        q = db.execute("SELECT * FROM rules WHERE id=? AND state='quarantined'",
                       (quarantined_id,)).fetchone()
        if q is None:
            raise RuleError("no such quarantined rule")
        if keep == "old":
            db.execute("UPDATE rules SET state='retired', updated_at=? WHERE id=?",
                       (now, quarantined_id))
            return "Kept the existing rule."
        if keep != "new":
            raise RuleError("keep must be 'new' or 'old'")
        # Only the rules it actually clashes with (or shares a scope with)
        # step aside -- not every rule on the same field.
        active = db.execute("SELECT * FROM rules WHERE state='active' AND field=?",
                            (q["field"],)).fetchall()
        losers = [r["id"] for r in active
                  if r["scope"] == q["scope"]
                  or (_overlaps(r["scope"], q["scope"]) and r["value"] != q["value"])]
        for rid in losers:
            db.execute("UPDATE rules SET state='superseded', updated_at=? WHERE id=?",
                       (now, rid))
        db.execute("UPDATE rules SET state='active', supersedes=?, updated_at=? WHERE id=?",
                   (losers[0] if losers else None, now, quarantined_id))
        ledger.event("rule_resolved", {"kept": quarantined_id, "superseded": losers}, db=db)
    return "Switched to the new rule."


def active_for(ledger: Ledger, job_kind: str) -> list:
    """The rules a job of this kind runs under, most specific scope last
    so it reads as the stronger instruction."""
    rows = ledger.db.execute(
        "SELECT * FROM rules WHERE state='active' AND scope IN ('all', ?)"
        " ORDER BY CASE scope WHEN 'all' THEN 0 ELSE 1 END, id", (job_kind,)).fetchall()
    return rows


def active_for_message(ledger: Ledger, limit: int) -> list:
    """A free-text message may turn into an answer, a summary, a draft or
    options, so it carries every non-digest rule -- the newest `limit` of
    them, 'all' first, so a scoped rule reads as the stronger one."""
    rows = ledger.db.execute(
        "SELECT * FROM rules WHERE state='active' AND scope<>'digest'"
        " ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)).fetchall()
    return sorted(rows, key=lambda r: (r["scope"] != "all", r["created_at"], r["id"]))


def listing(ledger: Ledger) -> tuple[list, list]:
    active = ledger.db.execute("SELECT * FROM rules WHERE state='active'"
                               " ORDER BY created_at").fetchall()
    quarantined = ledger.db.execute("SELECT * FROM rules WHERE state='quarantined'"
                                    " ORDER BY created_at").fetchall()
    return active, quarantined


def latest_active(ledger: Ledger):
    return ledger.db.execute("SELECT * FROM rules WHERE state='active'"
                             " ORDER BY created_at DESC, id DESC LIMIT 1").fetchone()
