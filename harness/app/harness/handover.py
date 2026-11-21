"""Cain hands a calendar request over to the keeper here.

Cain is the conversation; the keeper writes calendars. When he asks Cain for a
calendar change, Cain calls this endpoint and passes nothing he said: the
keeper reads the DM itself (controller._handover) and acts only on his own
words. Cain may name the message it rests on (keeper.sh handover --message <id>):
then it's that message, if it's his and from the last 30 minutes, whatever he
sent after it (Nov 15: three messages in a minute, and the handover for the
second read the third). Without one, it's his newest message, from the last 2
minutes. If Cain wants to pass a suggestion of its own (a date it found in an
email, say), it may, and then any change gets a card to tap: Cain's words never
change a calendar by themselves.

- Local only: the add-ons' own network on the Pi, port 8098, never published
  to the LAN (no "ports:" in config.yaml).
- Keyed: the caller must show HMAC-SHA256(bot token, KEY_CONTEXT). Both add-ons
  already hold the token, so there is nothing to set up, and resetting the
  token changes the key too. Without it, another add-on could read his rules
  or spend his messages.
- The answer waits for the result, up to WAIT_S, so Cain never says "done"
  before it is.

Also here: /digest (Cain takes today's calendar digest for his one morning
message), /morning-posted (Cain's link says that message is out), /press
(a tap on one of this add-on's cards, checked by Cain's link and passed back),
/meanings (what Dane told Cain kinds of Family events mean, from his record:
short rows, checked strictly here before anything is queued; meaning_live.py), and
/places (his place book, where the places named on Family are; checked the same way;
places.py). GET /health is for Cain's half of the mutual watch (watch.py): it
answers "ok" while the controller loop is turning, and "stuck" when it hasn't
for STUCK_S, so a hung loop counts as down. The clock starts at the loop's first
turn ("starting" until then), and the loop beats between its phases.

The HTTP thread never touches the ledger: it queues the request for the
controller and waits on an event.
"""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import json
import logging
import os
import queue
import re
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from . import scrub as _scrub

log = logging.getLogger("harness.handover")

PORT = 8098
KEY_CONTEXT = b"harness-handover-v1"
WAIT_S = 25
MAX_BODY = 4096
MAX_SUGGESTION = 1500
MAX_MEANINGS_BODY = 16384             # up to 60 short rows, or the place book
PRESS_WAIT_S = 8                      # a tap's answer to Cain's link waits this long at most (its own limit is 10 s)
TAP_JOURNAL = ".taps.jsonl"           # beside the ledger: taps written down before they're taken (fourteenth round)
JOURNAL_LOCK = ".lock"                # twenty-ninth round: beside the journal, its exclusive append lock (flock)
FENCED_TAP = ("Not taken: Harness is waiting to restart so its records can be put back from a backup. Restart the "
              "Harness App in Home Assistant now. Nothing changed.")
# Fifteenth round: a tap that couldn't be written down is refused (never "working"), and he hears it.
UNRECORDED_TAP = "Not taken: Harness couldn't write your tap down, so nothing changed."
# Fifteenth round: the no-ledger degraded start refuses taps at once, through the link's answer route.
DEGRADED_TAP = ("Not taken: Harness started without its records, so it takes nothing until it starts normally. "
                "Nothing changed.")
ROUTES = ("/handover", "/digest", "/press", "/morning-posted", "/meanings", "/places", "/fastpath")
BIG = ("/meanings", "/places")
STUCK_S = 10 * 60


def _message_id(value) -> str:
    """A Discord message id, digits only, or nothing: anything else isn't one."""
    text = str(value or "").strip()
    return text if text.isdigit() and len(text) <= 24 else ""


def _run_id(value) -> str:
    """A smoke run's id (calendar_change.smoke_start: hex), or nothing."""
    text = str(value or "").strip().lower()
    return text if text and len(text) <= 32 and all(c in "0123456789abcdef" for c in text) else ""


def _calendar(value) -> str:
    """gate-open's calendar: gmail or family, or nothing."""
    text = str(value or "").strip().lower()
    return text if text in ("gmail", "family") else ""


def _step_name(value) -> str:
    """smoke-step's step name (ninth round): a short slug of lowercase letters, digits and dashes, or nothing."""
    text = str(value or "").strip().lower()
    return text if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", text) else ""


def _script(value) -> dict:
    """smoke-step's script (tenth round): only its known fields, as short strings; checked strictly by
    calendar_change.check_script."""
    if not isinstance(value, dict):
        return {}
    return {k: str(value.get(k) or "")[:80] for k in ("calendar", "kind", "day", "title", "times") if value.get(k)}


def _ledger_path(value) -> str:
    """migrate-check's ledger file: an absolute path of plain characters, or nothing (the live ledger)."""
    text = str(value or "").strip()
    if not text or len(text) > 256 or not text.startswith("/") or ".." in text.split("/"):
        return ""
    return text if all(c.isalnum() or c in "/._-" for c in text) else ""


def _restore_key(value) -> str:
    """migrate-restore's backup key (twelfth round): "<schema> <build>", a whole number and a build id of
    plain characters, or nothing."""
    text = " ".join(str(value or "").split())
    return text if re.fullmatch(r"[0-9]{1,4} [0-9A-Za-z._-]{4,64}", text) else ""


def _fsync_dir(folder: str) -> None:
    """A file's creation, rename or removal is durable only once its folder's entry is on disk."""
    try:
        fd = os.open(folder, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def key_for(token: str) -> str:
    return hmac.new(token.encode(), KEY_CONTEXT, hashlib.sha256).hexdigest()


@dataclass
class Handover:
    kind: str = "handover"               # or digest, press, morning-posted, meanings, places
    suggestion: str = ""
    rows: list = field(default_factory=list)   # /meanings, /places: already checked
    press: dict = field(default_factory=dict)
    paired: str = ""                     # the Discord user Cain is paired with
    message: str = ""                    # the Discord message of his it rests on, when Cain names one
    state: str = ""                      # /fastpath: "smoke-start", "on" or "off"
    run: str = ""                        # /fastpath on: the smoke run's id, from smoke-start
    smoke: str = ""                      # /fastpath: free text from before 0.24.0's fifth round: refused
    record: dict = field(default_factory=dict)   # /fastpath: a pass or fail record from before the sixth round: ignored
    calendar: str = ""                   # /fastpath gate-open: "gmail" or "family" (eighth round)
    path: str = ""                       # /fastpath migrate-check: a ledger file to copy and migrate (eighth round)
    step: str = ""                       # /fastpath smoke-step: the step's name (ninth round)
    smoke_run: str = ""                  # /handover: names the smoke run; never its step (tenth round)
    script: dict = field(default_factory=dict)   # /fastpath smoke-step: the step's script (tenth round)
    candidate: str = ""                  # /fastpath migrate-check: the incoming build's tree or image (tenth round)
    restore: str = ""                    # /fastpath migrate-restore: "<schema> <build>" of a backup (twelfth round)
    done: threading.Event = field(default_factory=threading.Event)
    result: dict = field(default_factory=dict)
    arrived: float = field(default_factory=time.monotonic)
    age: float | None = None             # how old his message was when Cain handed it over
    job: str = ""                        # the job's short id: for the log, never for him
    journaled: bool = False              # /press: written to the tap journal (fourteenth round)
    told: bool = False                   # /press: he was told once that it waits (fourteenth round)
    intent: bool = False                 # /press: its execution intent is in the journal (seventeenth round)

    def finish(self, status: str, said: str = "", **extra) -> None:
        if not self.done.is_set():
            self.result = {"status": status, "said": said, **extra}
            took = time.monotonic() - self.arrived
            # Outcome and timing only: never his words. The target is 20 s from his message.
            log.info("%s: %s, %.1fs here%s%s", self.kind, status, took,
                     f", {self.age + took:.0f}s after his message" if self.age is not None else "",
                     f", job {self.job}" if self.job else "")
            self.done.set()


@contextlib.contextmanager
def journal_lock(journal: str):
    """Twenty-ninth round: the tap journal's exclusive lock, shared by every process that writes it (an flock on
    the file beside it, JOURNAL_LOCK, which a rename of the journal never replaces): each append, each strike's
    rewrite and the set-aside tool's rewrite hold it, so an append blocks until a rewrite has read, filtered,
    written, fsynced, renamed and synced the folder. Raises OSError when the lock file can't be opened.

    Thirtieth round: the lock file is the App's, group-writable (0o660 whatever the umask), and owned like the
    journal beside it, so a tool run by root never leaves the App unable to open it."""
    import fcntl
    fd = os.open(journal + JOURNAL_LOCK, os.O_RDWR | os.O_CREAT, 0o660)
    try:
        _lock_file_owned(fd, journal)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)                      # closing the last descriptor releases the flock


def _lock_file_owned(fd: int, journal: str) -> None:
    """Thirtieth round: the lock file group-writable, and, when root holds it, owned by the journal's owner
    (thirty-first round: by its folder's owner while there's no journal)."""
    try:
        st = os.fstat(fd)
        if st.st_uid == os.geteuid() and (st.st_mode & 0o777) != 0o660:
            os.fchmod(fd, 0o660)
        if os.geteuid() == 0:
            # Thirty-first round: with no journal yet, the owner of the journal's folder (the App's data folder), so
            # a lock file root creates first is never left root's.
            try:
                j = os.stat(journal)
            except FileNotFoundError:
                j = os.stat(os.path.dirname(os.path.abspath(journal)) or ".")
            if (st.st_uid, st.st_gid) != (j.st_uid, j.st_gid):
                os.fchown(fd, j.st_uid, j.st_gid)
    except OSError:
        pass                              # best effort: an flock needs only the open descriptor


LOCK_STORAGE = "taps unsaved: the tap journal's lock can't be taken"   # thirtieth round: /health's storage flag
JOURNAL_WRITE_STORAGE = "taps unsaved: the tap journal can't be written"   # thirty-first round: its own reason
# Thirty-first round: beside the journal, the strike tombstones written when its lock can't be taken. Only ever
# appended to (never rewritten, replaced or removed), so no rewrite of the journal can drop one; every reader honours
# them, and the next strike that takes the lock compacts them into the journal and appends {"consumed": n}, the
# length of the file it applied, after which only the tombstones past that point still count.
STRUCK_SIDE = ".struck"

# Thirty-first round: the file systems the tap journal may sit on, an allowlist. Its flock and its fsynced renames
# are only sound on local storage, so the App starts degraded (every tap refused) when the journal's folder is on
# anything else: a network file system, a fuse mount of any kind, a type it doesn't know, or a mount table it can't
# read. Home Assistant OS keeps the App's data on ext4.
LOCAL_FS = frozenset({"ext4", "xfs", "btrfs", "f2fs", "overlay", "tmpfs", "vfat"})


class NetworkJournal(RuntimeError):
    """Thirtieth round: the tap journal's folder isn't on local storage (thirty-first round: on no type of LOCAL_FS,
    or on one that can't be told)."""


def mount_type(path: str, mountinfo: str = "/proc/self/mountinfo") -> str:
    """The file system type of the mount holding `path` ("" when it can't be told)."""
    real = os.path.realpath(path)
    best, kind = "", ""
    try:
        with open(mountinfo, encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if " - " not in line or len(parts) < 5:
                    continue
                point = parts[4].replace("\\040", " ")
                fstype = (line.split(" - ", 1)[1].split() or [""])[0]
                if (real == point or real.startswith(point.rstrip("/") + "/")) and len(point) >= len(best):
                    best, kind = point, fstype
    except (OSError, ValueError):
        return ""
    return kind


def check_local(journal: str, mountinfo: str = "/proc/self/mountinfo") -> None:
    """Raises NetworkJournal unless the tap journal's folder is on a file system of LOCAL_FS (thirty-first round:
    an allowlist; an unreadable mount table, an unknown type and any fuse type are refused)."""
    kind = mount_type(os.path.dirname(os.path.abspath(journal)) or ".", mountinfo)
    if kind not in LOCAL_FS:
        raise NetworkJournal(f"the tap journal isn't on local storage ({kind or 'its file system unknown'}); it "
                             f"must be on one of {', '.join(sorted(LOCAL_FS))}")


# Thirty-first round: the file beside the journal that holds relist counts, epochs, deferrals and the outage
# (Controller.REREAD_SIDE, migrate._side_file) is never written over contents that couldn't be read: an unreadable
# one is moved aside (to <file>.unreadable, or .unreadable.<n> when that's taken) and the write that found it is
# refused. Which taps' counts it may have held is kept as "lost": every tap key that can still be picked out of its
# text, and every tap with journal lines then; when its text can't be read at all, or no key can be picked out of
# it, "lost_all". A lost tap with no count of its own beside the journal again gets no count (no Go ahead) until a
# requeue gives it one; with "lost_all", so does every tap that had a relist mark.
SIDE_ASIDE = ".unreadable"
_TAP_KEY = re.compile(r'"((?:[^"\\]|\\.)*\|(?:[^"\\]|\\.)*)"')


def side_aside(path: str) -> bool:
    """Whether an unreadable side file was moved aside from `path` (and is still there)."""
    folder, name = os.path.split(os.path.abspath(path))
    try:
        return any(n.startswith(name + SIDE_ASIDE) for n in os.listdir(folder or "."))
    except OSError:
        return False


def _move_aside(path: str) -> None:
    dest, n = path + SIDE_ASIDE, 1
    while os.path.exists(dest):
        n += 1
        dest = f"{path}{SIDE_ASIDE}.{n}"
    try:
        os.rename(path, dest)
        _fsync_dir(os.path.dirname(os.path.abspath(path)))
        log.error("the file beside the tap journal couldn't be read; it was moved aside to %s and isn't written over",
                  os.path.basename(dest))
    except OSError as e:
        log.error("the file beside the tap journal couldn't be read or moved aside (%s); it isn't written over",
                  type(e).__name__)


def _salvaged(raw: bytes | None) -> tuple[set, bool]:
    """The tap keys still legible in an unreadable side file's text, and whether that's all of them can't be told."""
    if raw is None:
        return set(), True
    text = raw.decode("utf-8", errors="replace")
    keys = set()
    for m in _TAP_KEY.finditer(text):
        try:
            keys.add(json.loads(f'"{m.group(1)}"'))
        except ValueError:
            continue
    return keys, not keys and bool(text.strip())


def _aside_lost(path: str) -> tuple[set, bool]:
    """What the side files moved aside from `path` may have held (their legible keys, or all)."""
    folder, name = os.path.split(os.path.abspath(path))
    keys, every = set(), False
    try:
        names = [n for n in os.listdir(folder or ".") if n.startswith(name + SIDE_ASIDE)]
    except OSError:
        return set(), True
    for n in names:
        try:
            with open(os.path.join(folder, n), "rb") as f:
                got = _salvaged(f.read())
        except OSError:
            got = (set(), True)
        keys |= got[0]
        every = every or got[1]
    return keys, every


def load_side(path: str, keys: Callable[[], list]) -> dict:
    """Thirty-first round: the side file beside the journal, read: {} when there's none; its object when it reads.
    One that doesn't read (not JSON, not an object, or a read error) is moved aside and given as {"lost": the taps
    it may have held, "lost_all" when that can't be told, "unread": True}: a writer handed that refuses to write.
    With none there but one moved aside, the same without "unread", so the first write after it keeps them."""
    raw = None
    try:
        with open(path, "rb") as f:
            raw = f.read()
        got = json.loads(raw.decode("utf-8"))
    except FileNotFoundError:
        if not side_aside(path):
            return {}
        lost, every = _aside_lost(path)
        return {"lost": sorted(lost | set(keys())), **({"lost_all": True} if every else {})}
    except (OSError, ValueError):
        got = None
    if isinstance(got, dict):
        return got
    lost, every = _salvaged(raw) if not (raw is not None and got is not None) else (set(), False)
    _move_aside(path)
    return {"lost": sorted(lost | set(keys())), **({"lost_all": True} if every else {}), "unread": True}


def side_keeps(data: dict) -> bool:
    """Whether a side file's contents are worth a file (else it's removed)."""
    return bool(data.get("taps") or data.get("gens") or data.get("outage") or data.get("lost")
                or data.get("lost_all"))


def _row_key(r: dict, key: Callable[[dict], str]) -> str:
    """The tap a journal line belongs to."""
    if isinstance(r.get("press"), dict):
        return key(r["press"])
    for field_ in ("intent", "committed", "outcome", "delivered", "check", "cleared", "struck"):
        if field_ in r:
            return str(r.get(field_) or "")
    return str(r.get("key") or "")


class Inbox:
    def __init__(self, token_fn: Callable[[], str], wake: threading.Event | None = None, *, journal: str,
                 staged: Callable[[], bool] | None = None,
                 answer: Callable[[str, str], None] | None = None, refusing: str = "",
                 _journal_less: bool = False):
        # Sixteenth round: the tap journal is a required argument. Only the no-ledger degraded start (which refuses
        # every tap at once and queues nothing) and tests (Inbox.for_tests) may go without one.
        if not journal and not refusing and not _journal_less:
            raise ValueError("the tap journal's path is required")
        self._token_fn = token_fn
        self.queue: "queue.Queue[Handover]" = queue.Queue()
        self._front: list[Handover] = []     # fourteenth round: items given back by the controller, taken first
        self._lock = threading.Lock()
        self.wake = wake
        # Fourteenth round: every tap is written to this journal (one JSON line, flushed to disk) before Cain's
        # link hears it was taken, and struck off only once the controller has committed what it did; a tap
        # left in it at the next start is taken then, or he is told (Controller._replay_taps). "" for none.
        self.journal = journal
        self.staged = staged or (lambda: False)   # a restore is staged: a tap is answered at once, not queued
        self.fenced = ""                          # the controller's fence reason, once it has seen the staged restore
        self.answer = answer                      # posts a short note to him on a tap (the link's /answer)
        # Fifteenth round: the no-ledger degraded start: every tap is refused at once with DEGRADED_TAP, and he
        # hears it through the link's answer route; never queued.
        self.refusing = refusing
        self.beat_at: float | None = None    # the controller loop's last turn; None: not yet
        self.migration: dict = {}            # twelfth round: the ledger waiting for its move (migrate.waiting_summary)
        self.degraded = ""                   # thirteenth round: why it started without its records, or ""
        self.storage = ""                    # twenty-fifth round: taps' progress can't be saved anywhere, or ""
        self.waiting = ""                    # twenty-eighth round: the start replay can't read the set-aside taps
        self.lock_storage = ""               # thirtieth round: an append refused for want of the journal's lock
        self.write_storage = ""              # thirty-first round: the journal itself refused a write

    @classmethod
    def for_tests(cls, token_fn: Callable[[], str], wake: threading.Event | None = None, **kw) -> "Inbox":
        """Sixteenth round: tests only. An inbox with no tap journal (taps are queued, never written down)."""
        kw.setdefault("journal", "")
        return cls(token_fn, wake, _journal_less=True, **kw)

    def beat(self) -> None:
        self.beat_at = time.monotonic()

    def health(self) -> dict:
        extra = {"migration": dict(self.migration)} if self.migration else {}
        if self.storage or self.lock_storage or self.write_storage:
            # twenty-fifth round: said where no storage is needed; thirtieth round: or the journal's lock refused;
            # thirty-first round: or the journal refused a write, each with its own words
            extra["storage"] = self.storage or self.lock_storage or self.write_storage
        if self.waiting:
            extra["waiting"] = self.waiting     # twenty-eighth round: the start replay's taps wait on the records
        if self.degraded:
            return {"status": "degraded", "why": self.degraded, "loop_age_s": None, **extra}
        if self.beat_at is None:
            return {"status": "starting", "loop_age_s": None, **extra}
        age = time.monotonic() - self.beat_at
        # Fifteenth round: while a staged restore fences the records the loop still turns and is judged by its own
        # beat, marked fenced beside it, so a stall or a dead loop never passes for a staged restore.
        fenced = {"fenced": True} if self.fenced else {}
        return {"status": "ok" if age < STUCK_S else "stuck", "loop_age_s": int(age), **fenced, **extra}

    def key_ok(self, presented: str) -> bool:
        token = self._token_fn()
        return bool(token) and bool(presented) and hmac.compare_digest(key_for(token), presented)

    def submit(self, h: Handover) -> None:
        self.queue.put(h)
        if self.wake is not None:
            self.wake.set()

    def pending(self) -> int:
        """Handovers and taps queued for the controller's thread, not taken yet (thirteenth round)."""
        with self._lock:
            front = len(self._front)
        return front + self.queue.qsize()

    def give_back(self, items: list[Handover]) -> None:
        """Fourteenth round: items the controller couldn't take now (the ledger busy) go back to the front of
        the queue, in order, to be taken first next time. Never dropped."""
        if not items:
            return
        with self._lock:
            self._front[:0] = list(items)

    # -- the tap journal (fourteenth round; fifteenth: commits in the journal itself; sixteenth: intents, outcomes)
    #
    # One JSON line per record, appended and fsynced, each write's result checked:
    #   {"press", "at"}                     the tap, written down before Cain's link hears it was taken;
    #   {"intent": key, "op", "at"}         sixteenth round: about to act on it (before the records change and before
    #                                       any calendar write it leads to); "op" names its calendar effect by a
    #                                       stable identity (the proposal and its fixed event ids), or none;
    #   {"committed": key, "at"}            what it did is committed in the records: its outcome, done;
    #   {"outcome": key, "kind", "note"}    sixteenth round: a terminal outcome other than done ("refused", or
    #                                       "found": the calendar already shows it), written before the note;
    #   {"delivered": key, "at"}            sixteenth round: that note reached him.
    # A tap with an intent and no outcome is "outcome unknown", never "not carried out". A tap's lines are struck
    # off (the file rewritten without them) only once its outcome is recorded and, for a note, delivered. A line
    # that can't be read (a torn tail) is skipped, never the whole file. {"notice", "key"} lines from the fifteenth
    # round read as a refusal whose note wasn't delivered.

    @staticmethod
    def key(press: dict) -> str:
        return f"{str((press or {}).get('id', ''))}|{str((press or {}).get('custom_id', ''))}"

    def _journal_lines(self) -> list[dict]:
        rows = []
        try:
            with open(self.journal, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        log.error("a line of the tap journal couldn't be read; skipped")
                        continue
                    if isinstance(row, dict):
                        rows.append(row)
        except FileNotFoundError:
            return []
        except OSError:
            log.error("the tap journal couldn't be read")
            return []
        return self._unstruck(rows, self._side_tombstones()[0])

    def _unstruck(self, rows: list[dict], side: list[dict] = ()) -> list[dict]:
        """Thirtieth round: a strike tombstone in the journal ({"struck": key}, as the thirtieth round's builds
        appended it) takes out every line of that tap written before it, and itself. Thirty-first round: and the
        tombstones in the file beside it (STRUCK_SIDE, `side`, the ones not yet compacted): a strike takes out every
        line of that tap, a cleared intent every intent of that tap with that op. Every reader honours both."""
        if any("struck" in r for r in rows):
            out: list[dict] = []
            for r in rows:
                if "struck" in r:
                    k = str(r.get("struck") or "")
                    out = [x for x in out if _row_key(x, self.key) != k]
                    continue
                out.append(r)
            rows = out
        if side:
            hidden = self._hidden_by(side)
            rows = [r for r in rows if not hidden(r)]
        return rows

    def _hidden_by(self, side: list[dict]) -> Callable[[dict], bool]:
        """Thirty-first round: whether a journal line is taken out by one of the tombstones beside the journal."""
        struck = {str(t.get("struck") or "") for t in side if "struck" in t}
        cleared = [(str(t.get("cleared") or ""), t.get("op")) for t in side if "cleared" in t]

        def hidden(r: dict) -> bool:
            if _row_key(r, self.key) in struck:
                return True
            return "intent" in r and any(r.get("intent") == k and r.get("op") == op for k, op in cleared)
        return hidden

    def _side_tombstones(self) -> tuple[list[dict], int]:
        """Thirty-first round: the tombstones beside the journal (STRUCK_SIDE) that still count (those past the last
        {"consumed": n}), and the length of its whole lines (what a compaction now applies)."""
        try:
            with open(self.journal + STRUCK_SIDE, "rb") as f:
                raw = f.read()
        except FileNotFoundError:
            return [], 0
        except OSError:
            log.error("the tap journal's strikes beside it couldn't be read")
            return [], 0
        found, consumed, at = [], 0, 0
        whole = raw.rfind(b"\n") + 1
        for chunk in raw[:whole].split(b"\n")[:-1]:
            start, at = at, at + len(chunk) + 1
            if not chunk.strip():
                continue
            try:
                row = json.loads(chunk.decode("utf-8", errors="replace"))
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            if "consumed" in row:
                try:
                    consumed = max(consumed, int(row["consumed"]))
                except (TypeError, ValueError):
                    pass
                continue
            if "struck" in row or "cleared" in row:
                found.append((start, row))
        return [r for start, r in found if start >= consumed], whole

    def _side_tombstone(self, row: dict) -> bool:
        """Thirty-first round: a tombstone recorded beside the journal (STRUCK_SIDE) when the journal's lock can't be
        taken: appended (O_APPEND, one write, fsynced), never written into the journal, so no rewrite of the journal
        can drop it; there's nothing to read back. The caller holds self._lock."""
        path = self.journal + STRUCK_SIDE
        data = ("\n" + _scrub.dumps(dict(row, at=time.time())) + "\n").encode()   # a torn line before it stays apart
        try:
            new = not os.path.exists(path)
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        except OSError as e:
            log.error("the tap journal's strike couldn't be written beside it: %s", type(e).__name__)
            self.write_storage = JOURNAL_WRITE_STORAGE
            return False
        try:
            if os.write(fd, data) != len(data):
                raise OSError("short write")
            os.fsync(fd)
        except OSError as e:
            log.error("the tap journal's strike couldn't be written beside it: %s", e)
            self.write_storage = JOURNAL_WRITE_STORAGE
            return False
        finally:
            os.close(fd)
        if new:
            try:
                _fsync_dir(os.path.dirname(os.path.abspath(path)))
            except OSError:
                pass
        return True

    def _consumed(self, n: int) -> None:
        """Thirty-first round: after a compaction under the lock, the tombstones beside the journal up to `n` bytes
        are applied: said by appending {"consumed": n} there (the file is never rewritten). A marker that can't be
        written leaves them counting, which only takes out lines already gone."""
        if n <= 0:
            return
        try:
            fd = os.open(self.journal + STRUCK_SIDE, os.O_WRONLY | os.O_APPEND)
        except OSError:
            return
        try:
            os.write(fd, ("\n" + json.dumps({"consumed": n}) + "\n").encode())
            os.fsync(fd)
        except OSError as e:
            log.warning("the tap journal's compacted strikes couldn't be marked beside it: %s", type(e).__name__)
        finally:
            os.close(fd)

    def _take_lock(self):
        """Thirtieth round: the journal's lock entered, or None when it can't be taken (logged). Thirty-first round:
        any lock that can't be taken (an append's, a strike's, a rewrite's) raises /health's storage flag, and any
        lock taken clears that cause."""
        try:
            cm = journal_lock(self.journal)
            cm.__enter__()
        except OSError as e:
            log.error("the tap journal's lock couldn't be taken: %s", type(e).__name__)
            self.lock_storage = LOCK_STORAGE
            return None
        self.lock_storage = ""
        return cm

    def _append(self, row: dict) -> bool:
        """One line appended, written whole and fsynced, or not at all: a short write or a failed fsync is cut
        back off (best effort) and counts as not written."""
        data = (_scrub.dumps(row) + "\n").encode()   # twenty-sixth round: scrubbed at the sink
        with self._lock:
            # Thirtieth round: fail closed. An append that can't take the journal's lock is refused (the journal is
            # left as it is) and /health's storage flag says so, never written unlocked beside a rewrite.
            cm = self._take_lock()
            if cm is None:
                return False
            try:
                return self._append_locked(data)
            finally:
                cm.__exit__(None, None, None)

    def _append_locked(self, data: bytes) -> bool:
        try:
            new = not os.path.exists(self.journal)
            fd = os.open(self.journal, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        except OSError as e:
            log.error("the tap journal couldn't be opened: %s", type(e).__name__)
            self.write_storage = JOURNAL_WRITE_STORAGE
            return False
        try:
            size = os.fstat(fd).st_size
            try:
                wrote = os.write(fd, data)
                if wrote != len(data):
                    raise OSError(f"short write ({wrote} of {len(data)} bytes)")
                os.fsync(fd)
            except OSError as e:
                log.error("the tap journal couldn't be written: %s", e)
                try:
                    os.ftruncate(fd, size)
                    os.fsync(fd)
                except OSError:
                    pass
                self.write_storage = JOURNAL_WRITE_STORAGE
                return False
        finally:
            os.close(fd)
        if new:
            _fsync_dir(os.path.dirname(os.path.abspath(self.journal)))
        self.write_storage = ""
        return True

    def journal_add(self, h: Handover) -> bool:
        """Writes the tap down (appended and fsynced) before Cain's link hears it was taken. Whether it was
        written whole: fifteenth round, a tap that wasn't is refused, never queued."""
        if not self.journal:
            return False
        if not self._append({"press": {k: str(v) for k, v in h.press.items()}, "at": time.time()}):
            return False
        h.journaled = True
        return True

    def journal_intent(self, press: dict, op: dict | None = None) -> bool:
        """Sixteenth round: about to act on the tap, written (fsynced) before the records change and before any
        calendar write it leads to. Whether it was written: a tap whose intent can't be written isn't acted on."""
        if not self.journal or not press:
            return False
        return self._append({"intent": self.key(press), "op": dict(op or {}), "at": time.time()})

    def journal_commit(self, press: dict) -> bool:
        """Fifteenth round: what the tap did is committed in the ledger. Recorded in the journal itself, before
        the tap is struck off, so a replay never acts twice even when the ledger is later put back from a backup
        that predates it. Sixteenth round: the caller checks the result; a failure is logged and told."""
        if not self.journal or not press:
            return False
        return self._append({"committed": self.key(press), "at": time.time()})

    def journal_outcome(self, press: dict, kind: str, note: str = "", error: str = "") -> bool:
        """Sixteenth round: the tap's terminal outcome ("refused", or "found": the calendar already shows it) and the
        note owed to him, written (fsynced) before the note is posted, so a tap with one is never taken again.
        Twenty-fourth round: `error`, an internal error's last exception (never shown to him), kept for the copy of
        the tap the records keep when it's struck."""
        if not self.journal or not press:
            return False
        row = {"outcome": self.key(press), "kind": kind, "note": note, "at": time.time()}
        if error:
            row["error"] = str(error)[:500]
        return self._append(row)

    def journal_check(self, press: dict, n: int, next_at: float, told: bool, kind: str = "first",
                      seen: str = "", error: str = "") -> bool:
        """Eighteenth round: an unknown tap read on the calendar by its identity that couldn't settle yet (the read
        couldn't answer, or Harness's own records are still carrying it out): how many reads it has had, when the
        next one is (seconds since the epoch, on the records' clock), and whether he's been told it waits.
        Twenty-first round: `kind`, whose schedule the read counts on: "hold" (the records couldn't be read, or are
        still carrying it out), "calendar" (the calendar couldn't be read), or "first" (the tap's first read,
        counted on both); twenty-second round: "error" (an error in Harness itself on its hold read, on a
        counter of its own that any other read starts again); and `seen`, what that read found, so the log says a
        state only when it changes."""
        if not self.journal or not press:
            return False
        row = {"check": self.key(press), "n": int(n), "next": float(next_at), "told": bool(told),
               "kind": str(kind), "seen": str(seen), "at": time.time()}
        if error:
            row["error"] = str(error)[:500]     # twenty-fourth round: an error read's last exception, for the copy
        return self._append(row)

    def journal_delivered(self, press: dict) -> bool:
        """Sixteenth round: the note on that tap reached him; at the next start it isn't posted again."""
        if not self.journal or not press:
            return False
        return self._append({"delivered": self.key(press), "at": time.time()})

    def journal_done(self, press: dict, *, strict: bool = False) -> None:
        """Strikes a tap off (all its lines) once what it did is committed, or he has been told it wasn't taken.
        Twenty-first round: strict=True raises the OSError when the journal couldn't be rewritten without it (the
        caller's transaction rolls back what it queued with the strike); once the file is replaced the strike holds,
        and a failed folder sync after that is only logged."""
        if not self.journal or not press:
            return
        key = self.key(press)

        def mine(r: dict) -> bool:
            return _row_key(r, self.key) == key
        with self._lock:
            # Thirtieth round: fail closed. With no lock to take the journal isn't rewritten. Thirty-first round: and
            # nothing is written to it unlocked: the strike's tombstone goes beside it (STRUCK_SIDE, only ever
            # appended), which every reader honours and no rewrite of the journal can drop.
            cm = self._take_lock()
            if cm is None:
                if self._side_tombstone({"struck": key}):
                    return
                log.error("the tap journal's lock couldn't be taken and its strike couldn't be written")
                if strict:
                    raise OSError("the tap journal's strike couldn't be written")
                return
            try:
                self._strike_locked(mine, strict)
            finally:
                cm.__exit__(None, None, None)

    def _strike_locked(self, mine, strict: bool) -> None:
        """Under the journal's lock: the journal rewritten without the tap's lines, and (thirty-first round) without
        the lines the tombstones beside it take out, which are then marked applied there."""
        side, upto = self._side_tombstones()
        raw = self._raw_rows()
        rows = self._unstruck(raw, side)
        keep = [r for r in rows if not mine(r)]
        if len(keep) == len(raw):
            if side:
                self._consumed(upto)          # nothing of theirs is left in the journal
            return
        try:
            self._rewrite(keep)
        except OSError as e:
            log.error("the tap journal couldn't be updated: %s", type(e).__name__)
            self.write_storage = JOURNAL_WRITE_STORAGE
            if strict:
                raise
            return
        self.write_storage = ""
        try:
            _fsync_dir(os.path.dirname(os.path.abspath(self.journal)))
        except OSError as e:
            log.error("the tap journal's folder couldn't be synced: %s", type(e).__name__)
        if side:
            self._consumed(upto)

    def _raw_rows(self) -> list[dict]:
        """The journal's lines as written (no tombstone applied); a line that can't be read is skipped."""
        rows = []
        try:
            with open(self.journal, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(row, dict):
                        rows.append(row)
        except FileNotFoundError:
            return []
        except OSError:
            log.error("the tap journal couldn't be read")
            return []
        return rows

    def _rewrite(self, keep: list[dict]) -> None:
        """The journal rewritten with only `keep` (removed when empty), whole: a temporary file, fsynced, renamed
        into place. Raises OSError when it couldn't be."""
        if not keep:
            os.remove(self.journal)
            return
        tmp = self.journal + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(r) + "\n" for r in keep))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.journal)

    def drop_lines(self, drop: Callable[[dict], bool], tombstone: dict | None = None) -> bool:
        """Twenty-ninth round: the journal rewritten without the lines `drop` picks, every other line (torn ones
        included) kept byte for byte, under the journal's exclusive lock held across the whole read, filter,
        temporary write, fsync, rename and folder fsync, so a tap appended meanwhile (by this process or another)
        waits and is never lost, and the rename is on disk before the lock goes. When the lock can't be taken the
        journal isn't rewritten: `tombstone` (a line every reader honours) is appended instead. Whether the lines
        are gone or tombstoned."""
        if not self.journal:
            return True
        with self._lock:
            cm = self._take_lock()
            if cm is None:
                # Thirty-first round: the tombstone goes beside the journal (STRUCK_SIDE), never into it unlocked.
                return bool(tombstone) and self._side_tombstone(tombstone)
            try:
                return self._drop_locked(drop)
            finally:
                cm.__exit__(None, None, None)

    def _drop_locked(self, drop: Callable[[dict], bool]) -> bool:
        side, upto = self._side_tombstones()          # thirty-first round: compacted here too
        hidden = self._hidden_by(side)
        try:
            with open(self.journal, encoding="utf-8", errors="surrogateescape", newline="") as f:
                raw = f.readlines()
        except FileNotFoundError:
            return True
        except OSError:
            return False
        keep = []
        for line in raw:
            try:
                r = json.loads(line)
            except ValueError:
                keep.append(line)
                continue
            if isinstance(r, dict) and (drop(r) or hidden(r)):
                continue
            keep.append(line)
        if len(keep) == len(raw):
            if side:
                self._consumed(upto)
            return True
        tmp = self.journal + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
                f.write("".join(keep))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.journal)
        except OSError:
            self.write_storage = JOURNAL_WRITE_STORAGE
            return False
        _fsync_dir(os.path.dirname(os.path.abspath(self.journal)))
        if side:
            self._consumed(upto)
        return True

    def journaled(self) -> list[dict]:
        """The taps written down and not yet struck off, oldest first, each {"press", "at", "intent", "op",
        "committed", "outcome", "note", "delivered", "state"}. state: "committed" (its outcome, done, is recorded),
        "refused" or "found" (a terminal outcome other than done), "unknown" (an intent and no outcome: it may or may
        not have been carried out), or "not_started" (written down, never acted on)."""
        if not self.journal:
            return []
        with self._lock:
            rows = self._journal_lines()
        taps: dict[str, dict] = {}
        for r in rows:
            if isinstance(r.get("press"), dict):
                k = self.key(r["press"])
                taps.setdefault(k, {"press": {a: str(b) for a, b in r["press"].items()}, "at": r.get("at"),
                                    "intent": False, "op": {}, "committed": False, "outcome": "", "note": "",
                                    "delivered": False, "checks": 0, "next_check": None, "told_check": False,
                                    "hold_checks": 0, "last_kind": "", "last_seen": "", "error_checks": 0,
                                    "error": ""})
                continue
            k = _row_key(r, self.key)
            t = taps.get(k)
            if t is None:
                continue
            if "cleared" in r:
                # Twenty-ninth round: a tombstone the set-aside tool appends when it can't take the journal's lock
                # to rewrite it: the intents with that op written before it no longer count.
                if t["intent"] and t["op"] == (r.get("op") if isinstance(r.get("op"), dict) else None):
                    t["intent"], t["op"] = False, {}
            elif "intent" in r:
                t["intent"] = True
                t["op"] = r.get("op") if isinstance(r.get("op"), dict) else {}
            elif "committed" in r:
                t["committed"] = True
            elif "outcome" in r and not t["outcome"]:
                t["outcome"] = str(r.get("kind") or "refused")
                t["note"] = str(r.get("note") or "")
                t["error"] = str(r.get("error") or t["error"])
            elif "notice" in r and not t["outcome"]:      # the fifteenth round's pending note
                t["outcome"], t["note"] = "refused", str(r.get("notice") or "")
            elif "delivered" in r:
                t["delivered"] = True
            elif "check" in r:
                # Twenty-first round: two counters. The hold schedule (the records couldn't be read, or are still
                # carrying it out) and the calendar's own; the tap's first read (and a line from before this round,
                # which had one counter) counts on both.
                kind = str(r.get("kind") or "first")
                try:
                    n, nxt = int(r.get("n") or 0), float(r.get("next"))
                except (TypeError, ValueError):
                    n, nxt = max(t["checks"], t["hold_checks"]) + 1, 0.0
                if kind in ("hold", "first"):
                    t["hold_checks"] = n
                if kind in ("calendar", "first"):
                    t["checks"] = n
                # Twenty-second round: reads that hit an error in Harness itself, on their own counter.
                # Twenty-third round: per tap (only this tap's own lines reach here). Twenty-fourth round: started
                # again only by a read whose calendar answered, and such a read settles the tap (its card, then the
                # strike), so it never writes a check line: no check line starts it again. A read that answered the
                # records but not the calendar (still carrying it out, or the calendar unreadable) leaves it as it is.
                if kind == "error":
                    t["error_checks"] = n
                    t["error"] = str(r.get("error") or t["error"])
                t["next_check"], t["last_kind"], t["last_seen"] = nxt, kind, str(r.get("seen") or "")
                t["told_check"] = t["told_check"] or bool(r.get("told"))
        for t in taps.values():
            t["state"] = ("committed" if t["committed"] else t["outcome"] if t["outcome"]
                          else "unknown" if t["intent"] else "not_started")
        return list(taps.values())

    def lines_for(self, key: str) -> list[dict]:
        """Twenty-fifth round: that tap key's own journal lines, of any kind, as written."""
        if not self.journal:
            return []
        with self._lock:
            rows = self._journal_lines()
        return [r for r in rows if _row_key(r, self.key) == key]

    def has_lines(self, key: str) -> bool:
        """Twenty-fourth round: whether any journal line, of any kind, belongs to that tap key."""
        if not self.journal:
            return False
        with self._lock:
            rows = self._journal_lines()
        return any(_row_key(r, self.key) == key for r in rows)

    def line_keys(self) -> list[str]:
        """Thirty-first round: every tap key with a journal line now (the taps whose counts an unreadable side file may
        have held)."""
        if not self.journal:
            return []
        with self._lock:
            rows = self._journal_lines()
        return sorted({_row_key(r, self.key) for r in rows} - {""})

    def row_for(self, press: dict) -> dict | None:
        """One tap's journal entry (journaled), or None."""
        key = self.key(press)
        return next((t for t in self.journaled() if self.key(t["press"]) == key), None)

    def queued_keys(self) -> set[str]:
        """Fifteenth round: the taps queued for the controller now, read under the queue's own mutex."""
        with self._lock, self.queue.mutex:
            items = list(self._front) + list(self.queue.queue)
        return {self.key(h.press) for h in items if h.kind == "press"}

    def notify(self, h: Handover, text: str, kind: str = "refused") -> bool:
        """The one terminal note to him on a tap. Sixteenth round: durable, not an in-memory flag. For a tap written
        down, its outcome and note are appended (fsynced) to the journal first; a note already recorded there is
        the one posted, and one already delivered isn't posted again; once it goes, its delivery is recorded.
        Whether he has been told."""
        if not (h.journaled and self.journal):
            return self.tell(h, text)
        row = self.row_for(h.press)
        if row is not None and row["outcome"]:
            if row["delivered"]:
                return True
            text = row["note"] or text
        elif not self.journal_outcome(h.press, kind, text):
            log.error("a tap's outcome couldn't be written to the tap journal; he's told all the same")
        if not self.tell(h, text):
            return False
        if not self.journal_delivered(h.press):
            log.error("a note's delivery couldn't be written to the tap journal")
        return True

    def tell(self, h: Handover, text: str) -> bool:
        """A short note to him on that tap (the link's follow-up to its deferred answer). Whether it went."""
        p = h.press
        if self.answer is None or not p.get("token"):
            return False
        try:
            self.answer(f"{p.get('app', '')}:{p.get('token', '')}", text)
            return True
        except Exception as e:                 # noqa: BLE001: a note that didn't go changes nothing
            log.info("a note on a tap couldn't be posted: %s", type(e).__name__)
            return False

    def take(self) -> list[Handover]:
        with self._lock:
            out, self._front = self._front, []
        while True:
            try:
                out.append(self.queue.get_nowait())
            except queue.Empty:
                return out


def _handler(inbox: Inbox, wait_s: float):
    class H(BaseHTTPRequestHandler):
        server_version = "harness"

        def log_message(self, *a):          # no request lines with addresses in the log
            pass

        def _reply(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path not in ROUTES:
                return self._reply(404, {"status": "not found"})
            if not inbox.key_ok(self.headers.get("x-harness-key", "")):
                log.warning("handover refused: wrong key")
                return self._reply(403, {"status": "refused"})
            try:
                n = int(self.headers.get("content-length") or 0)
            except ValueError:
                n = -1
            if n < 0 or n > (MAX_MEANINGS_BODY if self.path in BIG else MAX_BODY):
                return self._reply(413, {"status": "too large"})
            try:
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            except ValueError:
                return self._reply(400, {"status": "not JSON"})
            if not isinstance(body, dict):
                return self._reply(400, {"status": "not JSON"})
            rows: list = []
            if self.path == "/meanings":
                from .meaning_live import validate_rows
                checked, why = validate_rows(body)
                if checked is None:
                    return self._reply(400, {"status": "refused", "said": why})
                rows = checked
            elif self.path == "/places":
                from .places import validate_rows as validate_places
                checked, why = validate_places(body)
                if checked is None:
                    return self._reply(400, {"status": "refused", "said": why})
                rows = checked
            h = Handover(kind=self.path.strip("/"), rows=rows,
                         suggestion=str(body.get("suggestion") or "")[:MAX_SUGGESTION].strip(),
                         paired=str(body.get("paired") or "").strip(),
                         message=_message_id(body.get("message")),
                         state=str(body.get("state") or "").strip().lower()[:16],
                         run=_run_id(body.get("run")),
                         smoke=str(body.get("smoke") or "")[:MAX_SUGGESTION].strip(),
                         record=body.get("record") if isinstance(body.get("record"), dict) else {},
                         calendar=_calendar(body.get("calendar")),
                         path=_ledger_path(body.get("path")),
                         step=_step_name(body.get("step")),
                         smoke_run=_run_id(body.get("smoke_run")),
                         script=_script(body.get("script")),
                         candidate=_ledger_path(body.get("candidate")),
                         restore=_restore_key(body.get("restore")),
                         press={k: str(body.get(k, "")) for k in
                                ("id", "token", "app", "custom_id", "message_id")})
            if h.kind == "press":
                return self._press(h)
            inbox.submit(h)
            if not h.done.wait(wait_s):
                return self._reply(202, {"status": "working", "said": (
                    "Still working on it. The keeper will post the result in the DM.")})
            self._reply(200, h.result)

        def _press(self, h: Handover):
            """Fourteenth round: Cain's link has already given Discord its deferred answer (the tap is seen,
            nothing said yet). While a restore is staged the tap is answered at once that nothing is taken until
            the restart, and never queued. Otherwise it's written to the tap journal first, then queued for the
            controller's thread, and this answers once the controller has committed what it did (its note to
            him is the follow-up), or after PRESS_WAIT_S with "working": the tap is then written down, so a stop
            before the controller takes it loses nothing (the next start takes it, or tells him).

            Fifteenth round: a tap that couldn't be written down whole (a failed append, a short write, a failed
            fsync) is refused, never "working", and he's told nothing changed; in the no-ledger degraded start
            every tap is refused at once the same way. Once a tap is queued, the controller alone settles what he
            hears about it (Inbox.notify, once), never this waiter."""
            refused = (DEGRADED_TAP if inbox.refusing else (inbox.fenced or FENCED_TAP)
                       if inbox.fenced or inbox.staged() else "")
            if refused:
                h.finish("refused", refused, **({"degraded": True} if inbox.refusing else {"restore_staged": True}))
                inbox.notify(h, refused)
                return self._reply(200, h.result)
            if inbox.journal and not inbox.journal_add(h):
                h.finish("refused", UNRECORDED_TAP, journaled=False)
                inbox.notify(h, UNRECORDED_TAP)
                return self._reply(200, h.result)
            inbox.submit(h)
            if not h.done.wait(min(wait_s, PRESS_WAIT_S)):
                return self._reply(202, {"status": "working", "queued": True, "journaled": h.journaled})
            return self._reply(200, h.result)

        def do_GET(self):
            if self.path != "/health":
                return self._reply(404, {"status": "not found"})
            if not inbox.key_ok(self.headers.get("x-harness-key", "")):
                return self._reply(403, {"status": "refused"})
            self._reply(200, inbox.health())
    return H


def serve(inbox: Inbox, *, port: int = PORT, host: str = "0.0.0.0", wait_s: float = WAIT_S):
    srv = ThreadingHTTPServer((host, port), _handler(inbox, wait_s))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, name="handover", daemon=True).start()
    return srv
