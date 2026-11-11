"""Adding an event to the Family calendar: the only write to a family calendar.

Off until his tap on a bound card turns it on. That setting is its own: it
does not move the stage, and no other effect looks at it.

    his message -> a model's typed proposal -> a card from plain code
                -> his tap (approvals) -> this module -> caldav -> a receipt

Everything here runs on the controller's thread, after the tick's commands,
so a /stop in the same batch as a tap wins. A write is recorded as "sending"
before the request and its result after it, so a crash in between is never
silent: it is reported as unknown, and nothing is retried.

Plain code checks every proposal. An impossible one (over 24 hours, over a year
ahead, or text the card couldn't show exactly) is refused in words. Anything
else doubtful puts a warning on the card, and an add never skips the tap with
a warning on it.

Plain code also counts the bake-in (org rule R-002). When 10 adds and 14 days
are both reached with no undo, no failed write and no unknown write, one card
asks him, with the whole record, whether to stop checking each add. Only that
tap loosens anything, and it changes one thing: adds skip the Approve tap. The
receipt, the Undo button and /stop stay. Nothing else loosens.

The count and that authority are held only for the policy, the model and the
credentials they were earned on. Any of those changing restarts the count and
voids an open card. That, an undo, a failed or unknown write, an add with no Undo,
a reset or /checkadds brings the tap back, and only a fresh full count can ask
again. A tapless add is checked once more just before its write, so one already
queued is refused if the tap has come back. His tap on the card re-reads the record
first: if it changed, or can't be read, nothing loosens.
"""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from . import caldav, choices, commands, effects, policy, render, rules
from .canonical import canonical_hash
from .ledger import Ledger, iso

ENABLED = "family_add_enabled"
LOOSENED = "family_add_loosened"
PASTED_UNTIL = "family_add_pasted_until"
BAKE = "family_add_bake"
PROBLEM = "family_add_problem"
CREDS = "family_add_creds"
MANAGED = (ENABLED, LOOSENED, BAKE, PROBLEM, CREDS)

BAKE_ADDS = 10
BAKE_DAYS = 14
ENABLE_TTL_S = 15 * 60
UNDO_TTL_S = 7 * 24 * 3600
ASK_TTL_S = 3 * 24 * 3600
ASK_AGAIN_AFTER = timedelta(days=7)   # an ignored card, at most this often
MAX_DURATION = timedelta(hours=24)
MAX_TAPLESS_PER_DAY = 5
RECHECK_EVERY = timedelta(hours=1)    # a bake-in check that couldn't complete

# What the thread is told when a write did not end in a success.
FAILED_WORDS = {
    "unknown": ("<b>I don't know whether that was added.</b> The answer from iCloud was lost "
                "or it had a server error, so the event may or may not be there. Check the "
                "Family calendar before adding it again. I won't retry."),
    "exists": ("<b>Not added.</b> iCloud says an event with this id is already there, so I "
               "didn't write a second one. Check the Family calendar."),
    "auth": ("<b>Not added: iCloud rejected the password.</b> Make a new app-specific "
             "password and enter it on the Harness page."),
    "mismatch": ("<b>Not added: name mismatch.</b> The saved address isn't the calendar named "
                 "Family, so I refused to write to it. Check the address on the Harness page."),
    "no_credentials": ("<b>Not added.</b> The Apple ID, app-specific password or calendar "
                       "address isn't set on the Harness page."),
    "failed": "<b>Not added.</b> {detail} Nothing was changed.",
}
# The standing line for the digest and /status. Our words only, never a server's.
PROBLEM_WORDS = {
    "unknown": "Family calendar: the last write's outcome is unknown; check the calendar",
    "exists": "Family calendar: the last add found an event already there",
    "auth": "Family calendar: iCloud rejected the password",
    "mismatch": "Family calendar: name mismatch, the saved address isn't Family",
    "no_credentials": "Family calendar: credentials aren't set",
    "failed": "Family calendar: the last write failed",
}


def _detail(out: caldav.Outcome) -> str:
    return (f"iCloud answered HTTP {out.status}." if out.status
            else "I couldn't reach iCloud.")


def _one_year_after(dt: datetime) -> datetime:
    try:
        return dt.replace(year=dt.year + 1)
    except ValueError:                  # Feb 29
        return dt.replace(year=dt.year + 1, day=28)


# What pasted text carries and his own words don't. He dictates, often at length and over
# several lines (Nov 11), so length and line breaks are no sign at all: only these are.
_PASTE_SIGNS = (
    re.compile(r"(?m)^[ \t]*>"),                                      # a quoted line
    re.compile(r"```"),                                                 # a code block
    re.compile(r"(?im)^[ \t]*-*[ \t]*(?:original message|forwarded message|begin forwarded message)\b"),
    re.compile(r"(?im)^[ \t]*(?:fwd?|fw)\b"),                           # a forward's subject
    re.compile(r"(?im)^[ \t]*on\b[^\n]{4,160}\bwrote:[ \t]*$"),          # a reply's quote line
    re.compile(r"(?im)^[ \t]*sent from my\b"),                          # a mail app's signature
    re.compile(r"(?i)\b(?:https?://|www\.)\S"),                         # a link
    re.compile(r"(?i)\bunsubscribe\b"),                                 # a mailing's footer
)
_HEADER = re.compile(r"(?im)^[ \t]*(?:from|to|cc|bcc|sent|date|subject|reply-to)[ \t]*:[ \t]*\S")


def _looks_pasted(text: str) -> bool:
    """Real signs of text from elsewhere: a quote, an email's header lines, a forward, a link."""
    text = text or ""
    if any(sign.search(text) for sign in _PASTE_SIGNS):
        return True
    return len(_HEADER.findall(text)) >= 2


class FamilyAdd:
    def __init__(self, ledger: Ledger, client: caldav.FamilyCalDav, *, tz: str,
                 policy_version: str, model: str, creds_stamp: Callable[[], str]):
        self.ledger = ledger
        self.client = client
        self.tz = tz
        self.policy_version = policy_version
        self.model = model
        self.creds_stamp = creds_stamp
        self.chat_id: int | None = None

    def bind(self, owner: int) -> None:
        self.chat_id = owner

    # -- settings: only a tap on a bound card reaches these ------------------------
    def enabled(self) -> bool:
        return self.ledger.get_meta(ENABLED) == "1"

    def _authority(self) -> dict:
        return {"policy": self.policy_version, "model": self.model,
                "creds": self.creds_stamp()}

    def loosened(self) -> bool:
        """True only for the exact policy, model and credentials he said yes on."""
        raw = self.ledger.get_meta(LOOSENED)
        if not raw:
            return False
        try:
            return json.loads(raw) == self._authority()
        except ValueError:
            return False

    def problem(self) -> str:
        return self.ledger.get_meta(PROBLEM) or ""

    def forget(self) -> None:
        """A reset forgets the keys and the owner, so also this authority, every
        button that could bring it back, every open offer, and the record so far."""
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            for key in MANAGED:
                db.execute("DELETE FROM meta WHERE key=?", (key,))
            db.execute("UPDATE choices SET consumed_at=? WHERE consumed_at IS NULL"
                       " AND kind LIKE 'family_add_%'", (now,))
            db.execute("UPDATE approvals SET consumed_at=?, outcome='reset' WHERE consumed_at"
                       " IS NULL AND proposal_id IN (SELECT id FROM proposals WHERE"
                       " effect_type=?)", (now, effects.FAMILY_ADD))
            for p in db.execute("SELECT id, job_id FROM proposals WHERE effect_type=? AND"
                                " state='proposed'", (effects.FAMILY_ADD,)).fetchall():
                db.execute("UPDATE proposals SET state='cancelled' WHERE id=?", (p["id"],))
                self.ledger.transition(p["job_id"], "cancelled", db=db,
                                       receipt=json.dumps({"reason": "reset"}))
            self._restart_count(db, floor=self._marks(db))

    def status_line(self) -> str:
        if not self.enabled():
            return "Family calendar adds: off"
        if self.loosened():
            return ("Family calendar adds: on, skipping the Approve tap "
                    "(receipt, Undo and /stop stay; /checkadds brings the tap back)")
        b = self._bake()
        return f"Family calendar adds: on, each needs your tap ({b['n']} since the last problem)"

    def digest_line(self) -> str:
        """On every digest while adds skip the tap, so Clear can't hide it."""
        if not (self.enabled() and self.loosened()):
            return ""
        since = self.ledger.meta_time("last_digest_at")
        n = self.ledger.db.execute(
            "SELECT COUNT(*) FROM family_adds WHERE state='created' AND created_at>=?",
            (iso(since) if since else "",)).fetchone()[0]
        return (f"Family calendar adds skip the Approve tap: {n} added since the last digest. "
                "/checkadds brings the tap back.")

    def check_adds(self) -> str:
        """/checkadds: plain code, at once, and only a fresh count can undo it."""
        if not self.ledger.get_meta(LOOSENED):
            if not self._bake()["asked_at"]:
                return "Every Family calendar add already needs your Approve tap. Nothing changed."
            with self.ledger.tx() as db:      # same as answering the card "keep checking"
                self._restart_count(db)
                self.ledger.event("family_add_kept", {"why": "/checkadds"}, db=db)
            return ("Every Family calendar add already needs your Approve tap, and it still does. "
                    "I've closed the question about stopping that, so that card no longer works "
                    f"and won't come back. The count starts over: {BAKE_ADDS} adds and "
                    f"{BAKE_DAYS} days before I'd ask again.")
        with self.ledger.tx() as db:
            db.execute("DELETE FROM meta WHERE key=?", (LOOSENED,))
            self._restart_count(db)
            self.ledger.event("family_add_tightened", {"why": "/checkadds"}, db=db)
        return ("<b>Done.</b> Every Family calendar add needs your Approve tap again. "
                f"Going without it takes a fresh count of {BAKE_ADDS} adds and {BAKE_DAYS} days.")

    def _setback(self, db, why: str) -> None:
        """An undo, or a failed or unknown write: the count starts over, and if
        adds were skipping the tap, the tap is back and he is told why."""
        self._restart_count(db)
        if self.ledger.get_meta(LOOSENED):
            db.execute("DELETE FROM meta WHERE key=?", (LOOSENED,))
            self.ledger.event("family_add_tightened", {"why": why}, db=db)
            self._say(db, self.chat_id, None,
                      f"<b>Family calendar adds need your Approve tap again:</b> {why}. Going "
                      f"without it takes a fresh count of {BAKE_ADDS} adds and {BAKE_DAYS} days.")

    def _check_authority(self) -> None:
        """Credentials, policy or model changed: what was earned on them ends."""
        stamp, seen = self.creds_stamp(), self.ledger.get_meta(CREDS)
        if stamp != seen:
            with self.ledger.tx() as db:
                self.ledger.set_meta(CREDS, stamp, db)
                if seen is not None:
                    self._setback(db, "the Family calendar address, Apple ID or password changed")
        earned_on = self._bake().get("on")
        if (self.ledger.get_meta(LOOSENED) and not self.loosened()) \
                or (earned_on and earned_on != self._earning()):
            with self.ledger.tx() as db:
                self._setback(db, "the policy or the model changed since this was earned")
        if self.ledger.get_meta(LOOSENED) and rules.legacy_waiting(self.ledger):
            with self.ledger.tx() as db:
                self._setback(db, "a standing rule saved before this update never had your tap")

    # -- the bake-in count -----------------------------------------------------------
    def _bake(self) -> dict:
        raw = self.ledger.get_meta(BAKE)
        return json.loads(raw) if raw else {"n": 0, "first": None, "epoch": None,
                                            "asked_at": None, "marks": [0, 0, 0],
                                            "floor": [0, 0, 0], "on": None}

    def _earning(self) -> dict:
        return {"policy": self.policy_version, "model": self.model}

    def _count_add(self, db) -> None:
        b = self._bake()
        b["n"] += 1
        b["first"] = b["first"] or iso(self.ledger.now())
        b["epoch"] = b["epoch"] or secrets.token_hex(8)
        b["on"] = b["on"] or self._earning()
        self.ledger.set_meta(BAKE, json.dumps(b), db)

    def _restart_count(self, db, floor: list[int] | None = None) -> None:
        # Random, so a card from any earlier count, even before a reset, can
        # never match this one.
        self.ledger.set_meta(BAKE, json.dumps(
            {"n": 0, "first": None, "epoch": secrets.token_hex(8), "asked_at": None,
             "marks": self._marks(db), "floor": floor or self._bake()["floor"],
             "on": self._earning()}), db)

    @staticmethod
    def _marks(db) -> list[int]:
        """Where this count begins, as row numbers: no clock can tie or reorder them."""
        return [db.execute("SELECT COALESCE(MAX(rowid), 0) FROM proposals").fetchone()[0],
                db.execute("SELECT COALESCE(MAX(rowid), 0) FROM family_adds").fetchone()[0],
                db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]]

    def _tally(self, marks: list[int]) -> dict:
        db = self.ledger.db
        states = dict(db.execute(
            "SELECT state, COUNT(*) FROM proposals WHERE effect_type=? AND rowid>?"
            " GROUP BY state", (effects.FAMILY_ADD, marks[0])).fetchall())

        def adds(where: str) -> int:
            return db.execute(f"SELECT COUNT(*) FROM family_adds WHERE ({where})"
                              " AND rowid>?", (marks[1],)).fetchone()[0]

        def events(kind: str) -> int:
            return db.execute("SELECT COUNT(*) FROM events WHERE kind=? AND id>?",
                              (kind, marks[2])).fetchone()[0]
        return {"declined": states.get("declined", 0), "expired": states.get("expired", 0),
                "cancelled": states.get("cancelled", 0),
                "refused": states.get("refused", 0) + events("family_add_refused"),
                "warned": events("family_add_warned"),
                "undone": adds("undo_state='undone'"),
                "failed": adds("state NOT IN ('created','sending','unknown')"),
                "unknown": adds("state='unknown' OR undo_state='unknown'")}

    def _record(self, b: dict, days: int, missing: int) -> str:
        first = datetime.fromisoformat(b["first"]).astimezone(ZoneInfo(self.tz))
        now, ever = self._tally(b["marks"]), self._tally(b["floor"])

        def counts(t: dict) -> str:
            return (f"{t['declined']} declined, {t['expired']} expired, {t['cancelled']} "
                    f"cancelled, {t['refused']} refused, {t['undone']} undone, {t['failed']} "
                    f"failed, {t['unknown']} unknown, {t['warned']} shown with a warning")
        lines = [f"The record since {first:%b} {first.day} ({days} days): {b['n']} approved and "
                 f"added, {counts(now)}.",
                 f"Checked just now: {missing} of those {b['n']} added are no longer on the "
                 "calendar."]
        earlier = {k: ever[k] - now[k] for k in ever}
        if any(earlier.values()):
            lines.append(f"Before this count: {counts(earlier)}.")
        return "\n".join(lines)

    def _counted_uids(self, b: dict) -> list[str]:
        return [r["uid"] for r in self.ledger.db.execute(
            "SELECT uid FROM family_adds WHERE state='created' AND rowid>?", (b["marks"][1],))]

    def _snapshot(self, b: dict, missing: int) -> dict:
        """What a card says, to compare with the truth when he taps it."""
        return {"n": b["n"], "tally": self._tally(b["marks"]), "missing": missing}

    def _maybe_ask(self, *, held: bool) -> None:
        b = self._bake()
        if not self.enabled() or self.loosened() or b["n"] < BAKE_ADDS or not b["first"]:
            return
        first = datetime.fromisoformat(b["first"])
        now = self.ledger.now()
        days = (now - first).days
        if days < BAKE_DAYS:
            return
        if rules.blocking(self.ledger):
            if not b.get("rules_told"):
                with self.ledger.tx() as db:
                    self.ledger.set_meta(BAKE, json.dumps({**b, "rules_told": True}), db)
                    self.ledger.enqueue(
                        chat_id=self.chat_id, kind="notice", held=held, db=db,
                        text=("<b>Stop checking each Family calendar add?</b> That's due, but I "
                              "won't offer it yet: a standing rule is still waiting for your tap. "
                              "/rule lists them. Keep or drop each one on its card, and I'll "
                              "send this with the record."))
            return
        if b["asked_at"] and now - datetime.fromisoformat(b["asked_at"]) < ASK_AGAIN_AFTER:
            return
        tried = b.get("tried")
        if tried and now - datetime.fromisoformat(tried) < RECHECK_EVERY:
            return
        missing = self.client.missing(self._counted_uids(b))
        if missing is None:
            with self.ledger.tx() as db:
                said = b.get("told")
                self.ledger.set_meta(BAKE, json.dumps({**b, "tried": iso(now), "told": True}), db)
                if not said:
                    self.ledger.enqueue(
                        chat_id=self.chat_id, kind="notice", held=held, db=db,
                        text=("The Family calendar record is due for your review, but I couldn't "
                              "check the calendar to complete it, so I'm not offering any change "
                              "yet. I'll keep trying."))
            return
        self._send_card(b, days, missing, held=held)

    def _send_card(self, b: dict, days: int, missing: int, *, held: bool) -> None:
        record = self._record(b, days, missing)
        now = self.ledger.now()
        with self.ledger.tx() as db:
            target = b["epoch"]
            yes = choices.mint(self.ledger, kind="family_add_loosen", target=target,
                               chat_id=self.chat_id, ttl_s=ASK_TTL_S, db=db)
            no = choices.mint(self.ledger, kind="family_add_keep", target=target,
                              chat_id=self.chat_id, ttl_s=ASK_TTL_S, db=db)
            self.ledger.set_meta(BAKE, json.dumps({**b, "asked_at": iso(now),
                                                   "shown": self._snapshot(b, missing)}), db)
            self.ledger.event("family_add_asked", {"adds": b["n"], "days": days,
                                                   "missing": missing}, db=db)
            self.ledger.enqueue(
                chat_id=self.chat_id, kind="card", held=held,
                text=(f"<b>Stop checking each Family calendar add?</b>\n{record}\n"
                      "Every standing rule in use has your tap.\n"
                      "Adds alert family phones that have notifications on for the Family "
                      "calendar. Without the Approve tap, that alert can arrive with nothing "
                      "approved first.\n"
                      "<b>Were any of these adds wrong?</b>\n"
                      "If none were, you can say yes: an add then goes straight to the Family "
                      "calendar without the Approve tap, unless a check finds something off. You "
                      "still get the receipt, the Undo button and /stop, though Undo can't recall "
                      "an alert already delivered. Nothing else changes: "
                      "edits, deletes and messages to people still need your go. Only your tap "
                      "changes this."),
                buttons=[[("None wrong: stop checking", choices.callback_data(yes))],
                         [("Something was off: keep checking", choices.callback_data(no))]],
                binds=[{"type": "choice", "nonce": yes}, {"type": "choice", "nonce": no}],
                db=db)

    # -- what plain code checks on every proposal ---------------------------------------
    def _impossible(self, params: dict) -> str | None:
        """Words for what is refused outright, with or without a tap."""
        start = datetime.fromisoformat(params["start"])
        if datetime.fromisoformat(params["end"]) - start > MAX_DURATION:
            return "it would run longer than 24 hours"
        if start > _one_year_after(self.ledger.now()):
            return "it starts more than a year from now"
        for text in (params["title"], params.get("location", "")):
            if render.has_link(text):
                return ("the title or location has a link or web address in it, and I don't "
                        "put those on the family calendar. Say it again without that")
        return None

    def warnings(self, params: dict, *, message: str = "", replied: bool = False) -> list[str]:
        """What goes on the card. With any of these, an add never skips the tap."""
        out = []
        local = ZoneInfo(self.tz)
        for key in ("start", "end"):
            dt = datetime.fromisoformat(params[key])
            if dt.utcoffset() != dt.astimezone(local).utcoffset():
                out.append(f"the {key} was written with a different UTC offset than your zone "
                           "has at that moment, so the time shown may not be what you meant.")
        if any(render.maybe_host(params.get(key, "")) for key in ("title", "location")):
            out.append("the title or location has a word.word, a word:word or a phone number in "
                       "it. If that's an address, it may show as a link on family phones.")
        loose = self.loosened()
        if self._is_duplicate(params, any_title=loose):
            out.append("this looks like a duplicate: another add has the same start"
                       + ("." if loose else " and title."))
        if loose and self._tapless_today() >= MAX_TAPLESS_PER_DAY:
            out.append(f"{MAX_TAPLESS_PER_DAY} adds have already gone in without a tap today.")
        if loose and (_looks_pasted(message) or self._pasted_recently()):
            out.append("your message or a recent one may be pasted text: it has a quoted line, an "
                       "email's header lines, a forward or a link.")
        elif loose and replied:
            out.append("it's a reply, and the message you replied to may be pasted text.")
        return out

    def note_message(self, text: str) -> None:
        """Each message, before the model reads it. A paste stays in the conversation
        through the model's own replies, so every message in its window extends it. In
        the ledger, so a restart can't lose it."""
        if _looks_pasted(text) or self._pasted_recently():
            until = self.ledger.now() + timedelta(seconds=policy.CONTEXT_WINDOW_S)
            self.ledger.set_meta(PASTED_UNTIL, iso(until))

    def _pasted_recently(self) -> bool:
        until = self.ledger.get_meta(PASTED_UNTIL)
        return bool(until) and datetime.fromisoformat(until) > self.ledger.now()

    def note_warned(self, proposal_id: str, db) -> None:
        self.ledger.event("family_add_warned", {"proposal": proposal_id}, db=db)

    def _is_duplicate(self, params: dict, *, any_title: bool = False) -> bool:
        title = params["title"].strip().casefold()
        start = datetime.fromisoformat(params["start"])
        for r in self.ledger.db.execute(
                "SELECT p.params_json FROM proposals p"
                " LEFT JOIN family_adds a ON a.proposal_id=p.id"
                " WHERE p.effect_type=? AND (p.state IN ('proposed','approved',"
                "'auto_approved','executing',"
                "'executed') OR a.state='unknown')"
                " AND COALESCE(a.undo_state,'none') NOT IN ('undone','gone')",
                (effects.FAMILY_ADD,)):
            other = json.loads(r["params_json"])
            if datetime.fromisoformat(other["start"]) == start \
                    and (any_title or other["title"].strip().casefold() == title):
                return True
        return False

    def _tapless_today(self) -> int:
        local = self.ledger.now().astimezone(ZoneInfo(self.tz))
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return self.ledger.db.execute(
            "SELECT COUNT(*) FROM events WHERE kind='family_add_auto' AND at>=?",
            (iso(midnight.astimezone(timezone.utc)),)).fetchone()[0]

    # -- a proposal arrives ------------------------------------------------------------
    def refuse(self, job, receipt: dict, params: dict) -> bool:
        """True when this proposal goes no further; the words are queued."""
        if commands.is_paused(self.ledger):
            with self.ledger.tx() as db:
                self.ledger.transition(job["id"], "cancelled", db=db,
                                       receipt=json.dumps({**receipt, "reason": "stopped"}))
                self._say(db, job["chat_id"], job["id"],
                          "I'm stopped, so nothing was added. Send /resume to start again, "
                          "then resend it.")
            return True
        if self.enabled():
            why = self._impossible(params)
            if not why:
                return False
            self.refuse_in_words(job, receipt, why)
            return True
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "no_action", db=db,
                                   receipt=json.dumps({**receipt, "reason": "family_add_off"}))
            if self.client.configured():
                nonce = choices.mint(self.ledger, kind="family_add_enable", target="on",
                                     chat_id=job["chat_id"], ttl_s=ENABLE_TTL_S, db=db)
                self._say(db, job["chat_id"], job["id"],
                          "Adding to the Family calendar is off, so nothing was added. Turn it "
                          "on? Each add will still show you a card to approve, and each add "
                          "alerts family phones that have notifications on for this calendar.",
                          buttons=[[("Turn on", choices.callback_data(nonce))]],
                          binds=[{"type": "choice", "nonce": nonce}])
            else:
                self._say(db, job["chat_id"], job["id"],
                          "Adding to the Family calendar is off, so nothing was added. It needs "
                          "the Apple ID, an app-specific password and the calendar address on "
                          "the Harness page first.")
        return True

    def refuse_in_words(self, job, receipt: dict, why: str) -> None:
        """The checks said no. Plain words, a receipt, and a mark on the record."""
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "no_action", db=db, receipt=json.dumps(
                {**receipt, "reason": "family_add_impossible"}))
            self.ledger.event("family_add_refused", {"job": job["id"]}, db=db)
            self._say(db, job["chat_id"], job["id"], f"I didn't add that: {why}.")

    def auto_approve(self, proposal_id: str, job_id: str, db) -> bool:
        """After his tap on the bake-in card, an add needs no tap of its own.
        Nothing else can come through here."""
        row = db.execute("SELECT effect_type FROM proposals WHERE id=?", (proposal_id,)).fetchone()
        if not self.loosened() or row["effect_type"] != effects.FAMILY_ADD:
            return False
        # Its own state: checked again just before the write (_blocked).
        db.execute("UPDATE proposals SET state='auto_approved' WHERE id=? AND state='proposed'",
                   (proposal_id,))
        self.ledger.transition(job_id, "approved", db=db)
        self.ledger.event("family_add_auto", {"proposal": proposal_id}, db=db)
        return True

    def stopped(self) -> bool:
        """Stopped, or a /stop already in from this same poll: taps run before commands."""
        return commands.is_paused(self.ledger) or self.ledger.db.execute(
            "SELECT 1 FROM jobs j JOIN job_text t ON t.job_id=j.id WHERE j.kind='command'"
            " AND j.state='received' AND LOWER(TRIM(t.text)) LIKE '/stop%' LIMIT 1"
        ).fetchone() is not None

    # -- his taps ---------------------------------------------------------------------
    def on_choice(self, kind: str, target: str) -> str:
        if kind == "family_add_enable":
            with self.ledger.tx() as db:
                self.ledger.set_meta(ENABLED, "1", db)
                self.ledger.event("family_add_enabled", {}, db=db)
            return ("Adding to the Family calendar is on. Each add shows you a card to approve, "
                    "and /stop blocks it. Send the event again.")
        if kind == "family_add_loosen":
            self._check_authority()
            b = self._bake()
            if not self.enabled() or target != b["epoch"]:
                return "The record changed after that card was sent, so nothing changed."
            if rules.blocking(self.ledger):
                with self.ledger.tx() as db:
                    self.ledger.set_meta(BAKE, json.dumps({**b, "asked_at": None,
                                                           "rules_told": False}), db)
                return ("A standing rule is waiting for your tap, so nothing changed and I didn't "
                        "check the calendar. Keep or drop it on its card, and I'll send a fresh "
                        "card.")
            missing = self.client.missing(self._counted_uids(b))
            if missing is None:
                with self.ledger.tx() as db:
                    self.ledger.set_meta(BAKE, json.dumps(
                        {**b, "asked_at": None, "tried": iso(self.ledger.now()), "told": True}), db)
                return ("I couldn't check the calendar just now, so nothing changed. I'll send a "
                        "fresh card when I can.")
            if b.get("shown") != self._snapshot(b, missing):
                days = (self.ledger.now() - datetime.fromisoformat(b["first"])).days
                self._send_card(b, days, missing, held=False)
                return "The record changed since that card, so nothing changed. Read the fresh card."
            with self.ledger.tx() as db:
                self.ledger.set_meta(LOOSENED, json.dumps(self._authority()), db)
                self.ledger.event("family_add_loosened", {"adds": b["n"]}, db=db)
            return ("Done. Adds to the Family calendar no longer wait for your tap, unless a "
                    "check finds something off. You still get the receipt and the Undo button, "
                    "/stop still blocks them, and /checkadds brings the tap back. Nothing else "
                    "changed.")
        if kind == "family_add_keep":
            if target == self._bake()["epoch"]:
                with self.ledger.tx() as db:
                    self._restart_count(db)
            return "Each add still needs your tap, and the count starts over."
        if kind == "family_add_undo":
            with self.ledger.tx() as db:
                cur = db.execute("UPDATE family_adds SET undo_state='requested', updated_at=?"
                                 " WHERE proposal_id=? AND undo_state='open'",
                                 (iso(self.ledger.now()), target))
                if cur.rowcount != 1:
                    return "There's nothing to undo there."
                self._setback(db, "you undid an event")   # whatever happens next
            return "Undoing it now."
        return "Nothing changed."

    # -- each tick ----------------------------------------------------------------------
    def run_pending(self, *, paused: bool, held: bool = False) -> None:
        self._check_authority()
        self._expire_offers()
        self._fail_orphans()
        for p in self._approved():
            self._execute(p, paused)
        for row in self.ledger.db.execute(
                "SELECT * FROM family_adds WHERE undo_state='requested'").fetchall():
            self._undo(row, paused)
        if not paused:
            self._maybe_ask(held=held)

    def reconcile_after_restart(self) -> None:
        """Whatever a previous process left unfinished fails, loudly."""
        self._check_authority()
        self._fail_orphans()
        for p in self._approved():
            self._refused(p, "interrupted", "The harness restarted before it wrote that, so "
                                            "nothing was added. Send it again.")
        for row in self.ledger.db.execute(
                "SELECT * FROM family_adds WHERE undo_state='requested'").fetchall():
            self._reoffer(row, "The harness restarted before it could undo that, so it's still "
                               "on the Family calendar.")

    def _approved(self) -> list:
        return self.ledger.db.execute(
            "SELECT * FROM proposals WHERE effect_type=? AND state IN ('approved','auto_approved')"
            " ORDER BY created_at", (effects.FAMILY_ADD,)).fetchall()

    def _expire_offers(self) -> None:
        """An unanswered card closes, so the digest stops calling it waiting."""
        now = iso(self.ledger.now())
        rows = self.ledger.db.execute(
            "SELECT * FROM proposals WHERE effect_type=? AND state='proposed' AND expires_at<=?",
            (effects.FAMILY_ADD, now)).fetchall()
        for p in rows:
            with self.ledger.tx() as db:
                db.execute("UPDATE proposals SET state='expired' WHERE id=?", (p["id"],))
                self.ledger.transition(p["job_id"], "expired",
                                       receipt="expired before it was approved", db=db)
                self._say(db, self.chat_id, p["job_id"],
                          "That offer expired, so nothing was added.")

    def _fail_orphans(self) -> None:
        """Writes are synchronous, so a row still "sending" here belongs to a run
        that died mid-request. The request may have landed."""
        now = iso(self.ledger.now())
        for row in self.ledger.db.execute(
                "SELECT * FROM family_adds WHERE state='sending'").fetchall():
            with self.ledger.tx() as db:
                db.execute("UPDATE family_adds SET state='unknown', updated_at=? WHERE"
                           " proposal_id=?", (now, row["proposal_id"]))
                db.execute("UPDATE proposals SET state='failed' WHERE id=?", (row["proposal_id"],))
                self.ledger.transition(row["job_id"], "failed", db=db, receipt=json.dumps(
                    {"reason": "family_unknown", "detail": "interrupted during the write"}))
                self._setback(db, "a write's outcome is unknown")
                self._set_problem(db, "unknown")
                self._say(db, self.chat_id, row["job_id"],
                          "<b>I don't know whether that was added.</b> The harness stopped "
                          "during the write. Check the Family calendar before adding it again. "
                          "I won't retry.")
        for row in self.ledger.db.execute(
                "SELECT * FROM family_adds WHERE undo_state='deleting'").fetchall():
            with self.ledger.tx() as db:
                db.execute("UPDATE family_adds SET undo_state='unknown', updated_at=? WHERE"
                           " proposal_id=?", (now, row["proposal_id"]))
                self._set_problem(db, "unknown")
                self._say(db, self.chat_id, row["job_id"],
                          "<b>I don't know whether that was undone.</b> The harness stopped "
                          "during the delete. Check the Family calendar. I won't retry.")

    # -- the write ----------------------------------------------------------------------
    def _blocked(self, p, params: dict, paused: bool) -> tuple[str, str] | None:
        """Checked last thing before the request. No request has been sent, so
        none of these is a failed write."""
        if paused:
            return "stopped", "I'm stopped, so nothing was added. Send /resume, then resend it."
        if not self.enabled():
            return "family_add_off", "Adding to the Family calendar is off, so nothing was added."
        if p["state"] == "auto_approved" and not self.loosened():
            return "tap_restored", ("The Approve tap came back before I wrote this, so it was not "
                                    "added:\n" + render.family_event_text(params, self.tz)
                                    + "\nSend it again for a card.")
        try:
            checked = effects.REGISTRY[effects.FAMILY_ADD].validate(params)
        except effects.ParamError:
            checked = None
        if checked != params or canonical_hash(params) != p["params_hash"]:
            return "changed", "That changed after you saw it, so nothing was added."
        if datetime.fromisoformat(params["start"]) <= self.ledger.now():
            return "past", "That time has already passed, so nothing was added."
        why = self._impossible(params)
        if why:
            return "impossible", f"I didn't add that: {why}."
        return None

    def _refused(self, p, reason: str, words: str) -> None:
        with self.ledger.tx() as db:
            db.execute("UPDATE proposals SET state='refused' WHERE id=?", (p["id"],))
            self.ledger.transition(p["job_id"], "failed", db=db,
                                   receipt=json.dumps({"reason": reason}))
            self._say(db, self.chat_id, p["job_id"], words)

    def _execute(self, p, paused: bool) -> None:
        params = json.loads(p["params_json"])
        blocked = self._blocked(p, params, paused)
        if blocked:
            self._refused(p, *blocked)
            return
        uid = caldav.uid_for(p["id"])
        now = self.ledger.now()
        with self.ledger.tx() as db:
            db.execute("INSERT INTO family_adds(proposal_id, job_id, uid, state, created_at,"
                       " updated_at) VALUES(?,?,?,?,?,?)",
                       (p["id"], p["job_id"], uid, "sending", iso(now), iso(now)))
            db.execute("UPDATE proposals SET state='executing' WHERE id=?", (p["id"],))
        out = self.client.create(uid, params, now)
        self._record_add(p, params, uid, out)

    def _record_add(self, p, params: dict, uid: str, out: caldav.Outcome) -> None:
        now = iso(self.ledger.now())
        job_id = p["job_id"]
        with self.ledger.tx() as db:
            ok = out.kind == "ok"
            db.execute("UPDATE proposals SET state=? WHERE id=?",
                       ("executed" if ok else "failed", p["id"]))
            db.execute("UPDATE family_adds SET state=?, http_status=?, etag=?, undo_state=?,"
                       " updated_at=? WHERE proposal_id=?",
                       ("created" if ok else out.kind, out.status, out.etag,
                        "open" if ok and out.etag else "none", now, p["id"]))
            if not ok:
                self.ledger.transition(job_id, "failed", db=db, receipt=json.dumps(
                    {"reason": f"family_{out.kind}", "http_status": out.status}))
                self._setback(db, "a write's outcome is unknown" if out.kind == "unknown"
                              else "a write failed")
                self._set_problem(db, out.kind)
                self._say(db, self.chat_id, job_id,
                          FAILED_WORDS.get(out.kind, FAILED_WORDS["failed"])
                          .format(detail=_detail(out)))
                return
            self.ledger.transition(job_id, "executed", db=db, receipt=json.dumps(
                {"effect": effects.FAMILY_ADD, "uid": uid, "http_status": out.status}))
            self._count_add(db)
            db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
            text = (f"<b>Added to the Family calendar.</b> iCloud answered HTTP {out.status}.\n"
                    f"{render.family_event_text(params, self.tz)}\n"
                    f"<i>job {render.short(job_id)}</i>")
            if out.etag:
                buttons, binds = self._undo_button(db, p["id"])
                self._say(db, self.chat_id, job_id, text, buttons=buttons, binds=binds)
            else:
                self._say(db, self.chat_id, job_id, text + "\niCloud gave no version tag for "
                          "it, so I can't offer Undo safely. Delete it on the calendar if needed.")
                if p["state"] == "auto_approved":
                    self._setback(db, "an add went in with no Undo available")

    # -- undo ---------------------------------------------------------------------------
    def _undo_button(self, db, proposal_id: str) -> tuple[list, list]:
        nonce = choices.mint(self.ledger, kind="family_add_undo", target=proposal_id,
                             chat_id=self.chat_id, ttl_s=UNDO_TTL_S, db=db)
        return ([[("Undo", choices.callback_data(nonce))]],
                [{"type": "choice", "nonce": nonce}])

    def _reoffer(self, row, words: str) -> None:
        """Nothing was deleted, so the Undo is still his to use."""
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET undo_state='open', updated_at=? WHERE"
                       " proposal_id=?", (iso(self.ledger.now()), row["proposal_id"]))
            buttons, binds = self._undo_button(db, row["proposal_id"])
            self._say(db, self.chat_id, row["job_id"], words, buttons=buttons, binds=binds)

    def _undo(self, row, paused: bool) -> None:
        if paused:
            self._reoffer(row, "I'm stopped, so I didn't undo that. It's still on the Family "
                               "calendar. After /resume, tap Undo here.")
            return
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET undo_state='deleting', updated_at=? WHERE"
                       " proposal_id=?", (iso(self.ledger.now()), row["proposal_id"]))
        out = self.client.undo(row["uid"], row["etag"])
        final = {"ok": ("undone", "<b>Undone.</b> That event is off the Family calendar."),
                 "gone": ("gone", "That event isn't at its place on the calendar any more, so "
                                  "nothing was deleted."),
                 "changed": ("changed", "<b>Not undone.</b> The event changed since I wrote it, "
                                        "so someone may have edited it. I left it alone; check "
                                        "the Family calendar."),
                 "unknown": ("unknown", "<b>I don't know whether that was undone.</b> The answer "
                                        "from iCloud was lost or it had a server error. Check "
                                        "the Family calendar. I won't retry.")}.get(out.kind)
        if final is None:
            with self.ledger.tx() as db:
                self._set_problem(db, out.kind)
            words = FAILED_WORDS.get(out.kind, FAILED_WORDS["failed"]).format(detail=_detail(out))
            self._reoffer(row, words.replace("Not added", "Not undone"))
            return
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET undo_state=?, updated_at=? WHERE proposal_id=?",
                       (final[0], iso(self.ledger.now()), row["proposal_id"]))
            self.ledger.event("family_add_undo", {"proposal": row["proposal_id"],
                                                  "outcome": out.kind,
                                                  "http_status": out.status}, db=db)
            if out.kind == "ok":
                db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
            elif out.kind == "unknown":
                self._set_problem(db, "unknown")
            self._say(db, self.chat_id, row["job_id"], final[1])

    # -- output ---------------------------------------------------------------------------
    def _set_problem(self, db, kind: str) -> None:
        self.ledger.set_meta(PROBLEM, PROBLEM_WORDS.get(kind, PROBLEM_WORDS["failed"]), db)

    def _say(self, db, chat_id: int | None, job_id: str | None, text: str, *, buttons=None,
             binds=None) -> None:
        self.ledger.enqueue(chat_id=chat_id, kind="reply", job_id=job_id,
                            text=render.fit(text), buttons=buttons, binds=binds, db=db)
        self.ledger.release_held(db=db)

