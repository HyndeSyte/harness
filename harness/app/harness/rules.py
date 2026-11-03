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
  * Nothing here takes effect from a model's word alone. A proposal waits as
    "pending" until his tap on a card showing its exact text, and only an
    "active" rule reaches a prompt. Rules stored before this existed were never
    tapped, so the ledger moved them to "legacy_pending" (and those they replaced
    to "legacy_superseded"), and each gets a card. A pending rule that goes
    unanswered is dropped; a legacy one is asked about again.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from datetime import timedelta

from . import choices, effects, render
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
MAX_LITERAL = 300
CARD_TTL_S = 7 * 24 * 3600
AWAITING = ("pending", "legacy_pending")


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


def _unshowable(r) -> str | None:
    """Why a card couldn't show this rule exactly, if so."""
    if len(r["literal"]) > MAX_LITERAL:
        return "the words are too long to show on a card"
    for text in (r["value"], r["literal"]):
        if not effects._plain_text(text):
            return "it has an invisible or special character"
        if render.has_link(text):
            return "it has a link or web address in it"
    return None


def hold(ledger: Ledger, rule: dict, *, job_id: str | None, db=None) -> str:
    """What a model's proposal becomes: a pending rule, inert until his tap. His
    card must show exactly what would be kept, so text it can't show is refused."""
    r = _check(rule)
    why = _unshowable(r)
    if why:
        raise RuleError(why)
    now = iso(ledger.now())
    rid = "R" + uuid.uuid4().hex[:6]
    (db or ledger.db).execute(
        "INSERT INTO rules(id, rule_type, scope, field, value, literal,"
        " provenance_job_id, version, supersedes, state, created_at, updated_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (rid, r["rule_type"], r["scope"], r["field"], r["value"], r["literal"],
         job_id, 1, None, "pending", now, now))
    return rid


def get(ledger: Ledger, rule_id: str):
    return ledger.db.execute("SELECT * FROM rules WHERE id=?", (rule_id,)).fetchone()


def card_text(row) -> str:
    """Plain code, from the stored row. The model's own "confirm" sentence isn't used."""
    where = "everything" if row["scope"] == "all" else f"{row['scope']} jobs"
    head = ("<b>A standing rule saved before this update.</b> It isn't used until you keep it."
            if row["state"] == "legacy_pending"
            else "<b>Keep this as a standing rule?</b> It isn't used until you keep it.")
    return "\n".join([
        head,
        f"For {render.escape(where)}: {render.escape(row['field'])} = "
        f"{render.family_text(row['value'])}",
        f"Words it came from: {render.family_text(row['literal'])}",
        "It would go into every later prompt. Pasted text can produce one of these, so keep "
        "it only if you meant it."])


def card_buttons(ledger: Ledger, rule_id: str, chat_id: int, db) -> tuple[list, list]:
    yes = choices.mint(ledger, kind="rule_approve", target=rule_id, chat_id=chat_id,
                       ttl_s=CARD_TTL_S, db=db)
    no = choices.mint(ledger, kind="rule_decline", target=rule_id, chat_id=chat_id,
                      ttl_s=CARD_TTL_S, db=db)
    return ([[("Keep rule", choices.callback_data(yes)), ("Drop rule", choices.callback_data(no))]],
            [{"type": "choice", "nonce": yes}, {"type": "choice", "nonce": no}])


def confirm(ledger: Ledger, rule_id: str, db=None) -> Outcome:
    """His tap. The rule now goes through what a correction always did: it replaces
    one of its scope, or waits in quarantine if it clashes."""
    with _tx(ledger, db) as db:
        row = db.execute("SELECT * FROM rules WHERE id=?", (rule_id,)).fetchone()
        if row is None or row["state"] not in AWAITING:
            raise RuleError("that rule is no longer waiting")
        why = _unshowable(row)
        if why:
            raise RuleError(why)
        db.execute("DELETE FROM rules WHERE id=?", (rule_id,))
        return propose(ledger, {k: row[k] for k in ("rule_type", "scope", "field", "value",
                                                    "literal")},
                       job_id=row["provenance_job_id"], db=db, rule_id=rule_id)


def decline(ledger: Ledger, rule_id: str, db=None) -> str:
    with _tx(ledger, db) as db:
        cur = db.execute("UPDATE rules SET state='retired', updated_at=? WHERE id=? AND state IN"
                         " ('pending','legacy_pending')", (iso(ledger.now()), rule_id))
        if cur.rowcount != 1:
            raise RuleError("that rule is no longer waiting")
        ledger.event("rule_declined", {"id": rule_id}, db=db)
    return "Dropped. That rule isn't used."


def awaiting(ledger: Ledger) -> list:
    return ledger.db.execute("SELECT * FROM rules WHERE state IN ('pending','legacy_pending')"
                             " ORDER BY created_at, id").fetchall()


def blocking(ledger: Ledger) -> int:
    """Rules not yet settled by his tap. Adds can't start skipping the tap while any exist."""
    return ledger.db.execute("SELECT COUNT(*) FROM rules WHERE state IN"
                             " ('pending','legacy_pending','quarantined')").fetchone()[0]


def legacy_waiting(ledger: Ledger) -> bool:
    return ledger.db.execute("SELECT 1 FROM rules WHERE state='legacy_pending' LIMIT 1"
                             ).fetchone() is not None


def sweep(ledger: Ledger, chat_id: int, *, held: bool) -> None:
    """Each tick: an unanswered new rule, or a clash nobody picked a side on, is dropped
    when its card ends; a rule from before the tap existed gets a card whenever it has no
    live one, unless a card couldn't show it exactly, and then it is retired and he's told."""
    now = ledger.now()
    cutoff = iso(now - timedelta(seconds=CARD_TTL_S))
    stale = ledger.db.execute("SELECT id FROM rules WHERE state='pending' AND created_at<=?",
                              (cutoff,)).fetchall()
    stale += ledger.db.execute(
        "SELECT r.id FROM rules r WHERE r.state='quarantined' AND"
        " (SELECT MAX(c.expires_at) FROM choices c WHERE c.kind='rule_keep_new'"
        " AND c.target=r.id)<=?", (iso(now),)).fetchall()
    for row in stale:
        with ledger.tx() as db:
            db.execute("UPDATE rules SET state='retired', updated_at=? WHERE id=?",
                       (iso(now), row["id"]))
            ledger.event("rule_expired", {"id": row["id"]}, db=db)
    for row in ledger.db.execute("SELECT * FROM rules WHERE state='legacy_pending'").fetchall():
        if _unshowable(row):
            with ledger.tx() as db:
                db.execute("UPDATE rules SET state='retired', updated_at=? WHERE id=?",
                           (iso(now), row["id"]))
                ledger.event("rule_declined", {"id": row["id"], "why": "unshowable"}, db=db)
                ledger.enqueue(chat_id=chat_id, kind="notice", held=held, db=db, text=(
                    f"A standing rule saved before this update ({render.escape(row['id'])}) "
                    "has text a card can't show exactly, so I've stopped using it. Tell me "
                    "again in plain words if you still want it."))
            continue
        live = ledger.db.execute(
            "SELECT 1 FROM choices WHERE kind='rule_approve' AND target=? AND consumed_at IS NULL"
            " AND expires_at>? LIMIT 1", (row["id"], iso(now))).fetchone()
        if live:
            continue
        with ledger.tx() as db:
            buttons, binds = card_buttons(ledger, row["id"], chat_id, db)
            ledger.enqueue(chat_id=chat_id, kind="card", text=render.fit(card_text(row)),
                           buttons=buttons, binds=binds, held=held, db=db)


def propose(ledger: Ledger, rule: dict, *, job_id: str | None, db=None,
            rule_id: str | None = None) -> Outcome:
    """Applies a rule at once: only for his confirmed tap (confirm)."""
    r = _check(rule)
    now = iso(ledger.now())
    rid = rule_id or "R" + uuid.uuid4().hex[:6]
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
        if row is None or row["state"] not in ("active", "quarantined", *AWAITING):
            raise RuleError("nothing to undo")
        db.execute("UPDATE rules SET state='retired', updated_at=? WHERE id=?", (now, rule_id))
        if row["state"] == "active" and row["supersedes"]:
            prev = db.execute("SELECT state FROM rules WHERE id=?",
                              (row["supersedes"],)).fetchone()
            if prev is not None and prev["state"] == "legacy_superseded":
                # It was never tapped, so it comes back only as far as asking.
                db.execute("UPDATE rules SET state='legacy_pending', updated_at=? WHERE id=?",
                           (now, row["supersedes"]))
                return f"Undone. {row['supersedes']} waits for your tap before it is used."
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
