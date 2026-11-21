"""0.24.0, twenty-sixth round: the parts of the twenty-fifth outside review's findings that sit in the records, the
source, the sinks and the status paths.

5. The storage alarm renders on the App's health, its status page, its status text and the digest's composition
   with no write to the records or the file beside the journal.
6. Exception text is scrubbed at the sinks (the tap journal's writer, the records' writers, the set-aside tool's
   writer, the root log handler), with JSON-quoted secret fields and long high-entropy strings; anywhere else the
   App turns an exception into words, the source shows it logged, scrubbed or raised on.
7. A catch of BaseException (or a bare except) ends with an unconditional raise or an explicit hand-off call, with
   no list of exceptions; the calendar write thread hands its error off and sets its completion signal in a
   finally, so its caller returns even when the thread is interrupted.
All names and ids invented.
"""
import ast
import json
import logging
import queue
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from harness import daily, migrate, scrub, setup_web
from harness.controller import Controller
from harness.handover import Handover
from harness.ledger import Ledger
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

APP = Path(__file__).resolve().parent.parent / "harness" / "app" / "harness"
SECRET = "sEcReT0token0value0Abc123"
LONG = "ya29.a0AfB_byC9xYzQw8RtUvW3k4L5m6N7o8P9q0R1s2T3u4"


# -- 5. the storage alarm, rendered with no write ---------------------------------------------------------------------

def writes_refused(monkeypatch):
    """Every write to the records and to the file beside the journal refused, and counted."""
    n = {"writes": 0}

    def refuse(*a, **kw):
        n["writes"] += 1
        raise sqlite3.OperationalError("disk I/O error")
    for name in ("set_meta", "event", "enqueue", "tx", "input_failed"):
        monkeypatch.setattr(Ledger, name, refuse)

    def side(self, data):
        n["writes"] += 1
        return False
    monkeypatch.setattr(Controller, "_side_save", side)
    return n


def test_the_storage_note_renders_everywhere_with_no_write(m, monkeypatch):
    n = writes_refused(monkeypatch)
    m.c._storage_alarm()
    n["writes"] = 0
    assert "storage" in m.c.handovers.health()                                 # the App's health
    assert Controller.STORAGE_WORDS in m.c.status_text()                       # the status text
    m.c._publish()
    assert Controller.STORAGE_WORDS in m.c.status_box["notes"]
    app = setup_web.SetupApp(m.vault, m.c.status_box, queue.Queue())
    page = setup_web.render_page(app, str(OWNER), "owner")                     # the status page
    assert "go back to that tap only now and then" in page.replace("&#x27;", "'") \
        or "goes back to that tap only now and then" in page
    d = daily.gather(m.ledger, m.c.config, paused=False, notes=list(m.c.notes.values()))
    assert Controller.STORAGE_WORDS in d.text                                  # the digest as composed
    assert n["writes"] == 0


# -- 6. exception text scrubbed at the sinks --------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    f'{{"access_token": "{SECRET}", "expires_in": 3599}}',
    f'{{"refresh_token":"{SECRET}"}}',
    f"{{'client_secret': '{SECRET}'}}",
    f'{{"password": "{SECRET}"}}',
    f'{{"secret": "{SECRET}"}}',
    f'{{"id_token": "{SECRET}"}}',
    f"an answer that echoed {LONG} back",
])
def test_the_scrub_replaces_json_quoted_secrets_and_long_tokens(text):
    out = scrub.scrub(text)
    assert SECRET not in out and LONG not in out and scrub.REDACTED in out


@pytest.mark.parametrize("text", [
    "a calendar id 0123456789abcdef0123456789abcdef01234567@group.calendar.google.com",
    "Nothing changed: the event moved since the card.",
    "3 tokens: none of them shown",
])
def test_the_scrub_leaves_ordinary_words(text):
    assert scrub.scrub(text) == text


def test_the_journal_writer_scrubs_error_fields(m):
    h = m.c.handovers
    press = {"id": "97601", "custom_id": "k:a:r26sink", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_outcome(press, "internal_error", error=f'HTTPError: {{"refresh_token": "{SECRET}"}}')
    assert h.journal_check(press, 1, 0.0, False, "error", "hold_error", error=f"Bearer {SECRET}")
    raw = open(h.journal, encoding="utf-8").read()
    assert SECRET not in raw and raw.count(scrub.REDACTED) == 2
    assert '"token": "t"' in raw                                               # the press itself as it was


def test_the_records_writers_scrub_exception_text(m):
    with m.ledger.tx() as db:
        m.ledger.set_meta("tap_diag:97602|x", json.dumps({"error": f"GET https://x.example/a?key={SECRET}"}), db)
        m.ledger.event("bind_failed", {"outbox": 1, "error": f"Authorization: Bot {SECRET}"}, db=db)
    m.ledger.input_failed("gmail", f"refused: {LONG}")
    assert SECRET not in m.ledger.get_meta("tap_diag:97602|x")
    assert not [r for r in m.ledger.db.execute("SELECT detail FROM events") if SECRET in r[0]]
    assert LONG not in m.ledger.inputs()["gmail"]["last_error"]


def test_a_value_with_nothing_to_scrub_is_written_as_it_was(m):
    value = json.dumps({"press": {"token": "t" * 50}, "fails": 1}, separators=(",", ":"))
    m.ledger.set_meta("tap_strike:97603|x", value)
    assert m.ledger.get_meta("tap_strike:97603|x") == value


def test_the_set_aside_writer_scrubs_its_copy(m, tmp_path):
    key = "97604|k:c:r26copy"
    with m.ledger.tx() as db:
        m.ledger.db.execute("INSERT INTO meta(key, value) VALUES(?, ?)", (
            Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json", "why": f"token={SECRET}"})))
    got = migrate.set_aside_taps(m.ledger.path, key, "export", journal=m.c.handovers.journal)
    assert got["ok"]
    assert SECRET not in (tmp_path / migrate.SET_ASIDE_TAPS).read_text()


def test_the_root_log_filter_scrubs(caplog):
    record = logging.LogRecord("harness.x", logging.ERROR, __file__, 1, "the answer was %s", (
        f'{{"refresh_token": "{SECRET}"}}',), None)
    scrub.ScrubFilter().filter(record)
    assert SECRET not in record.getMessage()


def test_the_main_log_handler_uses_the_scrub():
    src = (APP / "__main__.py").read_text(encoding="utf-8")
    assert "handler.addFilter(scrub.ScrubFilter())" in src


def test_the_controllers_secrets_are_scrubbed_at_every_sink(m):
    m.c.handovers._token_fn = lambda: SECRET                                   # the link's token
    assert scrub.scrub(f"failed with {SECRET} in it") == f"failed with {scrub.REDACTED} in it"


LOGGING = {"debug", "info", "warning", "error", "exception", "critical", "log"}
SCRUBS = {"scrub", "_scrub", "scrubbed", "REDACT"}


def _parents(tree):
    out = {}
    for n in ast.walk(tree):
        for c in ast.iter_child_nodes(n):
            out[c] = n
    return out


def exception_text_unscrubbed(name: str, source: str) -> list[str]:
    """Each place an exception caught by name is turned into text (str(e), repr(e), an f-string's {e}, a % format)
    that isn't inside a logging call (the root handler scrubs), a scrub call, or a raise (its text is caught and
    checked again where it lands). A comparison is not a write."""
    tree, lines, out = ast.parse(source), source.splitlines(), []
    par = _parents(tree)
    for h in ast.walk(tree):
        if not isinstance(h, ast.ExceptHandler) or not h.name:
            continue
        for n in ast.walk(h):
            if not (isinstance(n, ast.Name) and n.id == h.name and isinstance(n.ctx, ast.Load)):
                continue
            p = par.get(n)
            text = (isinstance(p, ast.FormattedValue)
                    or isinstance(p, ast.Call) and isinstance(p.func, ast.Name) and p.func.id in ("str", "repr")
                    or isinstance(p, ast.BinOp) and isinstance(p.op, ast.Mod)
                    or isinstance(p, ast.Tuple) and isinstance(par.get(p), ast.BinOp))
            if not text:
                continue
            q, fine = p, False
            while q is not None and q is not h:
                if isinstance(q, ast.Compare):
                    fine = True
                    break
                if isinstance(q, ast.Call):
                    f = q.func
                    called = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
                    if called in LOGGING or called in SCRUBS:
                        fine = True
                        break
                if isinstance(q, ast.Raise):
                    fine = True
                    break
                q = par.get(q)
            if not fine:
                out.append(f"{name}:{n.lineno}: {lines[n.lineno - 1].strip()}")
    return out


def test_every_exception_text_write_goes_through_the_scrub():
    found = []
    for path in sorted(APP.glob("*.py")):
        found += exception_text_unscrubbed(path.name, path.read_text(encoding="utf-8"))
    assert not found, "\n".join(found)


@pytest.mark.parametrize("source", [
    "try:\n    f()\nexcept ValueError as e:\n    keep(str(e))\n",
    "try:\n    f()\nexcept ValueError as e:\n    db.event('x', {'error': f'{e}'})\n",
    "try:\n    f()\nexcept ValueError as e:\n    out = 'failed: %s' % e\n",
])
def test_the_exception_text_scan_finds_an_unscrubbed_write(source):
    assert exception_text_unscrubbed("x.py", source)


@pytest.mark.parametrize("source", [
    "try:\n    f()\nexcept ValueError as e:\n    log.error('failed: %s', e)\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(scrubbed(e))\n",
    "try:\n    f()\nexcept ValueError as e:\n    raise Other(str(e)) from None\n",
])
def test_the_exception_text_scan_passes_a_scrubbed_one(source):
    assert not exception_text_unscrubbed("x.py", source)


# -- 7. a catch of BaseException ends with a raise or a hand-off --------------------------------------------------------

HANDOFFS = {"_hand_off"}


def _base(handler) -> bool:
    t = handler.type
    if t is None:
        return True
    names = t.elts if isinstance(t, ast.Tuple) else [t]
    return any(isinstance(n, ast.Name) and n.id == "BaseException" for n in names)


def _ends_well(body) -> bool:
    last = body[-1]
    if isinstance(last, ast.Raise):
        return True
    if isinstance(last, ast.Expr) and isinstance(last.value, ast.Call):
        f = last.value.func
        return (f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")) in HANDOFFS
    return False


def base_catches_that_dont_end_well(name: str, source: str) -> list[str]:
    lines = source.splitlines()
    return [f"{name}:{node.lineno}: {lines[node.lineno - 1].strip()}" for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.ExceptHandler) and _base(node) and not _ends_well(node.body)]


def test_every_base_catch_ends_with_a_raise_or_a_hand_off_and_there_is_no_list():
    found = []
    for path in sorted(APP.glob("*.py")):
        found += base_catches_that_dont_end_well(path.name, path.read_text(encoding="utf-8"))
    assert not found, "\n".join(found)


@pytest.mark.parametrize("source", [
    "try:\n    f()\nexcept BaseException:\n    pass\n",
    "try:\n    f()\nexcept:\n    log()\n",
    "try:\n    f()\nexcept BaseException as e:\n    if fatal(e):\n        raise\n",     # a conditional raise
    "try:\n    f()\nexcept BaseException as e:\n    raise\n    keep(e)\n",
    "try:\n    f()\nexcept (ValueError, BaseException) as e:\n    box['err'] = e\n",
    "try:\n    f()\nexcept BaseException as e:\n    keep(e)\n",                         # not a hand-off by name
])
def test_the_scan_refuses_a_base_catch_that_may_swallow(source):
    assert base_catches_that_dont_end_well("x.py", source)


@pytest.mark.parametrize("source", [
    "try:\n    f()\nexcept BaseException:\n    undo()\n    raise\n",
    "try:\n    f()\nexcept BaseException as e:\n    _hand_off(e)\n",
    "try:\n    f()\nexcept BaseException as e:\n    _hand_off(box, e)\n",
])
def test_the_scan_passes_a_raise_or_a_hand_off(source):
    assert not base_catches_that_dont_end_well("x.py", source)


def test_the_write_threads_catch_hands_off_and_signals_in_a_finally():
    tree = ast.parse((APP / "calendar_change.py").read_text(encoding="utf-8"))
    bounded = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_bounded")
    run = next(n for n in ast.walk(bounded) if isinstance(n, ast.FunctionDef) and n.name == "run")
    outer = run.body[1]
    assert isinstance(outer, ast.Try) and outer.finalbody                       # the completion in a finally
    assert "done.set()" in ast.unparse(outer.finalbody[-1].finalbody)
    inner = outer.body[0]
    assert isinstance(inner, ast.Try) and _base(inner.handlers[0])
    assert ast.unparse(inner.handlers[0].body[-1]) == "_hand_off(e)"


class InterruptedLock:
    """A lock whose first taking on the write's own thread is interrupted (as a KeyboardInterrupt would be)."""

    def __init__(self):
        self._lock = threading.Lock()
        self.hit = False

    def __enter__(self):
        if threading.current_thread().name.startswith("calendar-write") and not self.hit:
            self.hit = True
            raise KeyboardInterrupt
        return self._lock.__enter__()

    def __exit__(self, *a):
        return self._lock.__exit__(*a)

    def acquire(self, *a, **kw):
        return self._lock.acquire(*a, **kw)

    def release(self):
        return self._lock.release()


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_an_interrupted_write_thread_still_lets_its_caller_return(m, monkeypatch):
    lock, real = InterruptedLock(), threading.Lock
    made = {"n": 0}

    def factory():                                                             # _bounded's own lock, made first
        made["n"] += 1
        return lock if made["n"] == 1 else real()
    monkeypatch.setattr("harness.calendar_change.threading.Lock", factory)
    m.cc.write_timeout_s = 5
    m.cc._recording = None

    def insert():
        return "landed"
    started = time.monotonic()
    out = m.cc._bounded("gmail", insert)
    assert lock.hit
    assert out == "landed"                                                     # its answer, not "unknown"
    assert time.monotonic() - started < 4                                      # without waiting out the timeout


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_a_write_interrupted_in_its_call_hands_the_interrupt_to_the_caller(m):
    m.cc.write_timeout_s = 5
    m.cc._recording = None

    def insert():
        raise KeyboardInterrupt
    started = time.monotonic()
    with pytest.raises(KeyboardInterrupt):
        m.cc._bounded("gmail", insert)
    assert time.monotonic() - started < 4
