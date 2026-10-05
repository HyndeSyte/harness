"""The ledger: the harness's only system of record.

Chat history is not state. Model sessions are not state. This SQLite file
is. Every inbound update, every job, every proposal, approval and receipt
lives here, so a restart, a model outage or a vendor change loses nothing
and nothing has to be reconstructed from a conversation.

Two rules carry most of the weight:

  * INGRESS IS ATOMIC WITH THE TELEGRAM OFFSET. Telegram confirms updates
    when the next getUpdates call passes a higher offset. So the offset
    may only advance in the same transaction that durably records the
    updates it confirms. Crash before commit: Telegram re-delivers and
    the update_id primary key absorbs the duplicate. Crash after commit:
    nothing is lost because it is already here.
  * EVERY JOB ENDS IN A RECEIPT. A job with no terminal receipt is, by
    definition, something the digest must surface.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Callable, Iterable

from .canonical import canonical_hash

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS updates(
  bot_id INTEGER NOT NULL DEFAULT 0,
  update_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  user_id INTEGER,
  chat_id INTEGER,
  message_id INTEGER,
  accepted INTEGER NOT NULL,
  reason TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, update_id)
);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY,
  bot_id INTEGER NOT NULL DEFAULT 0,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  reply_to_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  engine TEXT,
  started_at TEXT,
  slow_notice_at TEXT,
  UNIQUE(bot_id, chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS outbound(
  bot_id INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  job_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  job_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  buttons_json TEXT,
  binds_json TEXT,
  state TEXT NOT NULL,
  not_before TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS choices(
  nonce TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_update_id INTEGER
);
CREATE TABLE IF NOT EXISTS spend(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  month TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  job_id TEXT,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS job_text(
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  effect_type TEXT NOT NULL,
  params_json TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals(
  nonce TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
  owner_user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  params_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_update_id INTEGER,
  outcome TEXT
);
CREATE TABLE IF NOT EXISTS rules(
  id TEXT PRIMARY KEY,
  rule_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  literal TEXT NOT NULL,
  provenance_job_id TEXT,
  version INTEGER NOT NULL,
  supersedes TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inputs(
  name TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
"""

# Job states and the only transitions allowed between them. Anything else
# is a bug, refused loudly rather than written quietly.
TERMINAL = frozenset({"answered", "no_action", "needs_clarification",
                      "failed", "rejected", "declined", "expired",
                      "executed", "cancelled"})
TRANSITIONS = {
    "received": {"running", "rejected", "cancelled"},
    "running": {"answered", "proposed", "needs_clarification", "no_action",
                "failed", "cancelled"},
    "proposed": {"approved", "declined", "expired", "cancelled"},
    "approved": {"executed", "failed"},
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        raise ValueError("naive datetime in the ledger")
    return dt.astimezone(timezone.utc).isoformat()


class LedgerError(RuntimeError):
    pass


class Ledger:
    def __init__(self, path: str, clock: Callable[[], datetime] = utcnow):
        self.path = path
        self.clock = clock
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        cur = self.get_meta("schema_version")
        if cur is None:
            self.set_meta("schema_version", str(SCHEMA_VERSION))
        elif int(cur) != SCHEMA_VERSION:
            raise LedgerError(f"ledger schema {cur}, code expects {SCHEMA_VERSION}")

    # -- plumbing ------------------------------------------------------
    @contextmanager
    def tx(self):
        """One write transaction. BEGIN IMMEDIATE so two writers can never
        interleave a read-check-write."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self.db
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        else:
            self.db.execute("COMMIT")

    def now(self) -> datetime:
        return self.clock()

    def close(self) -> None:
        """Fold the write-ahead log into the main file and close, so a cold
        backup taken after the add-on stops is one self-contained file."""
        try:
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            self.db.close()

    def integrity_ok(self) -> bool:
        return self.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"

    def get_meta(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str, db=None) -> None:
        (db or self.db).execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def event(self, kind: str, detail: dict | str, db=None) -> None:
        text = detail if isinstance(detail, str) else json.dumps(detail, sort_keys=True)
        (db or self.db).execute(
            "INSERT INTO events(at, kind, detail) VALUES(?, ?, ?)",
            (iso(self.now()), kind, text))

    # -- Telegram ingress ---------------------------------------------
    # Update ids, message ids and the offset all belong to ONE bot. A new
    # bot token (after a reset, or a replaced token) starts every counter
    # again, so they are scoped by the bot's id, and switching bots resets
    # the offset instead of confirming -- dropping -- the new bot's updates.
    def bot_id(self) -> int:
        return int(self.get_meta("bot_id") or 0)

    def set_bot(self, bot_id: int) -> bool:
        """Record which bot this ledger is talking to. Returns True if it
        changed (and the offset was reset)."""
        if not isinstance(bot_id, int) or bot_id <= 0:
            raise LedgerError(f"not a bot id: {bot_id!r}")
        old = self.bot_id()
        if old == bot_id:
            return False
        with self.tx() as db:
            self.set_meta("bot_id", str(bot_id), db)
            self.set_meta("telegram_offset", "0", db)
            db.execute("DELETE FROM meta WHERE key='last_update_received'")
            self.event("bot_changed", {"from": old, "to": bot_id}, db=db)
        return True

    def telegram_offset(self) -> int:
        return int(self.get_meta("telegram_offset") or 0)

    def ingest(self, batch: Iterable, next_offset: int | None, *,
               reset: bool = False) -> list[str]:
        """Record a batch of parsed updates and advance the offset in ONE
        transaction. `batch` items are (Incoming, accepted, reason, kind)
        decisions from telegram.decide(). Returns new job ids.

        Rejected updates are recorded minimally -- ids and the reason --
        and their text is never stored. Accepted messages become jobs.

        `reset` is the one sanctioned way for the offset to move backwards:
        Telegram picks the next update id at random after a week with no
        updates, so after a long quiet spell the new ids may be lower than
        the stored offset. Anything else moving it backwards is a bug."""
        batch = list(batch)
        now = iso(self.now())
        new_jobs: list[str] = []
        received_any = False
        if not batch and next_offset is None:
            # An empty long-poll. Recording every one of them would be
            # thousands of writes a day to the Pi's storage for nothing;
            # once a minute is enough to prove Telegram is reachable.
            last = self.last_poll_success()
            if last is not None and (self.now() - last).total_seconds() < 60:
                return []
            with self.tx() as db:
                self.set_meta("last_poll_success", now, db)
            return []
        bot = self.bot_id()
        with self.tx() as db:
            current = self.telegram_offset()
            for d in batch:
                inc = d.incoming
                cur = db.execute(
                    "INSERT OR IGNORE INTO updates(bot_id, update_id, kind, user_id, chat_id,"
                    " message_id, accepted, reason, received_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?)",
                    (bot, inc.update_id, inc.kind, inc.user_id, inc.chat_id,
                     inc.message_id, int(d.accepted), d.reason, now))
                if cur.rowcount == 0:
                    continue        # a re-delivery after a crash: already here
                received_any = True
                if d.accepted and d.job_kind is not None:
                    job_id = str(uuid.uuid4())
                    db.execute(
                        "INSERT INTO jobs(id, bot_id, chat_id, message_id, kind, state,"
                        " text_hash, reply_to_message_id, created_at, updated_at)"
                        " VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (job_id, bot, inc.chat_id, inc.message_id, d.job_kind, "received",
                         canonical_hash(inc.text or ""), inc.reply_to_message_id,
                         now, now))
                    db.execute("INSERT INTO job_text(job_id, text) VALUES(?, ?)",
                               (job_id, inc.text or ""))
                    new_jobs.append(job_id)
            if next_offset is not None:
                if next_offset < current:
                    if not reset:
                        raise LedgerError(
                            f"offset would move backwards ({current} -> {next_offset})")
                    self.event("update_ids_reset",
                               {"from": current, "to": next_offset}, db=db)
                self.set_meta("telegram_offset", str(next_offset), db)
            if received_any:
                self.set_meta("last_update_received", now, db)
            self.set_meta("last_poll_success", now, db)
        return new_jobs

    def last_poll_success(self) -> datetime | None:
        v = self.get_meta("last_poll_success")
        return datetime.fromisoformat(v) if v else None

    def last_update_received(self) -> datetime | None:
        v = self.get_meta("last_update_received")
        return datetime.fromisoformat(v) if v else None

    def meta_time(self, key: str) -> datetime | None:
        v = self.get_meta(key)
        return datetime.fromisoformat(v) if v else None

    def set_meta_time(self, key: str, when: datetime, db=None) -> None:
        self.set_meta(key, iso(when), db)

    # -- jobs -----------------------------------------------------------
    def job(self, job_id: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()

    def job_text(self, job_id: str) -> str:
        row = self.db.execute("SELECT text FROM job_text WHERE job_id=?",
                              (job_id,)).fetchone()
        return row["text"] if row else ""

    def transition(self, job_id: str, new_state: str, *, receipt: str | None = None,
                   db=None) -> None:
        """Move a job along the state machine. A terminal state requires a
        receipt, so no job can end silently."""
        own = db is None
        ctx = self.tx() if own else _null(db)
        with ctx as d:
            row = d.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise LedgerError(f"no job {job_id}")
            old = row["state"]
            if new_state not in TRANSITIONS.get(old, set()):
                raise LedgerError(f"job {job_id}: {old} -> {new_state} not allowed")
            if new_state in TERMINAL and not receipt:
                raise LedgerError(f"job {job_id}: terminal {new_state} needs a receipt")
            d.execute("UPDATE jobs SET state=?, updated_at=? WHERE id=?",
                      (new_state, iso(self.now()), job_id))
            if receipt:
                d.execute("INSERT INTO receipts(job_id, kind, detail, created_at)"
                          " VALUES(?,?,?,?)",
                          (job_id, new_state, receipt, iso(self.now())))

    def open_jobs(self) -> list[sqlite3.Row]:
        marks = ",".join("?" * len(TERMINAL))
        return self.db.execute(
            f"SELECT * FROM jobs WHERE state NOT IN ({marks}) ORDER BY created_at",
            tuple(TERMINAL)).fetchall()

    def receipts(self, job_id: str) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM receipts WHERE job_id=? ORDER BY id",
                               (job_id,)).fetchall()

    _JOB_FIELDS = frozenset({"engine", "started_at", "slow_notice_at"})

    def job_set(self, job_id: str, db=None, **fields) -> None:
        bad = set(fields) - self._JOB_FIELDS
        if bad:
            raise LedgerError(f"not settable on a job: {sorted(bad)}")
        sets = ", ".join(f"{k}=?" for k in fields)
        vals = [iso(v) if isinstance(v, datetime) else v for v in fields.values()]
        (db or self.db).execute(f"UPDATE jobs SET {sets} WHERE id=?", (*vals, job_id))

    def jobs_in(self, *states: str) -> list[sqlite3.Row]:
        marks = ",".join("?" * len(states))
        return self.db.execute(
            f"SELECT * FROM jobs WHERE state IN ({marks}) ORDER BY created_at",
            states).fetchall()

    def jobs_since(self, since: datetime, *states: str) -> list[sqlite3.Row]:
        marks = ",".join("?" * len(states))
        return self.db.execute(
            f"SELECT * FROM jobs WHERE state IN ({marks}) AND updated_at>=?"
            " ORDER BY updated_at", (*states, iso(since))).fetchall()

    # -- what the controller said (cards bind to these ids) ---------------
    def record_outbound(self, *, chat_id: int, message_id: int, kind: str,
                        text: str, job_id: str | None = None, db=None) -> None:
        if not isinstance(message_id, int) or message_id <= 0:
            # Telegram returns 0 for ephemeral or scheduled messages. A card
            # that is not a real message can never be tapped, so never bound.
            raise LedgerError(f"not a real message id: {message_id!r}")
        (db or self.db).execute(
            "INSERT OR REPLACE INTO outbound(bot_id, message_id, chat_id, job_id, kind, text,"
            " created_at) VALUES(?,?,?,?,?,?,?)",
            (self.bot_id(), message_id, chat_id, job_id, kind, text[:4096], iso(self.now())))

    def outbound(self, chat_id: int, message_id: int) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM outbound WHERE bot_id=? AND chat_id=?"
                               " AND message_id=?",
                               (self.bot_id(), chat_id, message_id)).fetchone()

    # -- the outbox: replies are committed with the job, sent after ----------
    # A job's terminal state and the message that tells him about it are
    # written in ONE transaction. Sending happens afterwards and is retried,
    # so a Telegram outage delays a reply but never loses one, and a crash
    # between the two leaves a queued message, not a silent job.
    def enqueue(self, *, chat_id: int, kind: str, text: str, job_id: str | None = None,
                buttons: list | None = None, binds: list | None = None,
                held: bool = False, db=None) -> int:
        now = iso(self.now())
        cur = (db or self.db).execute(
            "INSERT INTO outbox(chat_id, job_id, kind, text, buttons_json, binds_json,"
            " state, not_before, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (chat_id, job_id, kind, text,
             json.dumps(buttons) if buttons else None,
             json.dumps(binds) if binds else None,
             "held" if held else "queued", now, now))
        return int(cur.lastrowid)

    def release_held(self, db=None) -> int:
        cur = (db or self.db).execute(
            "UPDATE outbox SET state='queued', not_before=? WHERE state='held'",
            (iso(self.now()),))
        return cur.rowcount

    def due_outbox(self) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT * FROM outbox WHERE state='queued' AND not_before<=? ORDER BY id",
            (iso(self.now()),)).fetchall()

    def outbox_row(self, row_id: int) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM outbox WHERE id=?", (row_id,)).fetchone()

    def outbox_in(self, *states: str) -> list[sqlite3.Row]:
        marks = ",".join("?" * len(states))
        return self.db.execute(f"SELECT * FROM outbox WHERE state IN ({marks}) ORDER BY id",
                               states).fetchall()

    def last_outbound(self, kind: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM outbound WHERE kind=? ORDER BY created_at DESC"
                               " LIMIT 1", (kind,)).fetchone()

    # -- spend (counted locally; prepaid balances are not an instant cutoff) --
    def add_spend(self, *, provider: str, model: str, purpose: str, input_tokens: int,
                  output_tokens: int, usd: float, job_id: str | None = None) -> None:
        now = self.now()
        with self.tx() as db:
            db.execute(
                "INSERT INTO spend(at, month, provider, model, job_id, purpose,"
                " input_tokens, output_tokens, usd) VALUES(?,?,?,?,?,?,?,?,?)",
                (iso(now), now.strftime("%Y-%m"), provider, model, job_id, purpose,
                 int(input_tokens), int(output_tokens), float(usd)))

    def spend_month(self, provider: str, month: str | None = None) -> float:
        month = month or self.now().strftime("%Y-%m")
        row = self.db.execute("SELECT COALESCE(SUM(usd), 0) AS s FROM spend"
                              " WHERE provider=? AND month=?", (provider, month)).fetchone()
        return float(row["s"])

    # -- inputs (for the digest's coverage) --------------------------------
    def input_ok(self, name: str) -> None:
        with self.tx() as db:
            db.execute("INSERT INTO inputs(name, last_success_at) VALUES(?, ?)"
                       " ON CONFLICT(name) DO UPDATE SET last_success_at=excluded.last_success_at",
                       (name, iso(self.now())))

    def input_failed(self, name: str, error: str) -> None:
        with self.tx() as db:
            db.execute("INSERT INTO inputs(name, last_error_at, last_error) VALUES(?, ?, ?)"
                       " ON CONFLICT(name) DO UPDATE SET last_error_at=excluded.last_error_at,"
                       " last_error=excluded.last_error",
                       (name, iso(self.now()), error[:300]))

    def inputs(self) -> dict[str, sqlite3.Row]:
        return {r["name"]: r for r in self.db.execute("SELECT * FROM inputs")}


class _null:
    """Context manager that reuses an open transaction."""
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self.db

    def __exit__(self, *exc):
        return False
