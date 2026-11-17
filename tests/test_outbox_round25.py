"""0.24.0, twenty-fifth round: the parts of the twenty-fourth outside review's findings that sit in the records, the
source and the card text checks.

2. The aborted-transaction error is held at each tap's own boundary (after the savepoint's rollback or reopen); only
   a reopen that itself failed still ends the tick.
6. No catch of BaseException (or a bare except) anywhere in the App swallows it: each re-raises, or is on an explicit
   list with its reason; the reopen helper's cleanup catches ordinary errors only.
9. The "check your calendar" allowance is bound to the internal-error card's builder, not to its lead appearing in a
   text.
All names and ids invented.
"""
import ast
import json
import sqlite3
from pathlib import Path

import pytest

from conftest import asks_in, rule_problems
from harness.controller import Controller
from harness.handover import Handover
from harness.ledger import Ledger, TransactionAborted
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER  # noqa: F401
from test_outbox_round23 import RollbackFails
from test_outbox_round24 import ASK, RollbackAlsoFails, committed, outbox_once_fails
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

APP = Path(__file__).resolve().parent.parent / "harness" / "app" / "harness"


# -- 2. one tap's aborted transaction, held at its own boundary --------------------------------------------------------

def terminal(m, tap_id):
    press = {"id": tap_id, "custom_id": f"k:a:r25{tap_id}", "token": "t", "app": "999", "message_id": "5"}
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=press)) and h.journal_outcome(press, "unverified")
    return press


def cleanup_fails_for(m, monkeypatch, tap_id):
    """Every card write for that one tap fails, and its savepoint's cleanup fails too: TransactionAborted."""
    real_set = m.ledger.set_meta

    def set_meta(key, value, db=None):
        if key.startswith("outbox_once:") and tap_id in key:
            raise RuntimeError("the write failed")
        return real_set(key, value, db)
    monkeypatch.setattr(m.ledger, "set_meta", set_meta)
    m.ledger.db = RollbackFails(m.ledger.db)


def test_one_taps_aborted_transaction_puts_off_that_tap_and_the_others_settle(m, monkeypatch):
    a, b, c = terminal(m, "95201"), terminal(m, "95202"), terminal(m, "95203")
    real_conn = m.ledger.db
    cleanup_fails_for(m, monkeypatch, "95201")
    rows = m.c.handovers.journaled()
    m.c._finish_terminal(rows)                                                 # no TransactionAborted out of it
    m.c._finish_terminal(m.c.handovers.journaled())                            # a second tick: a is put off
    monkeypatch.undo()
    m.ledger.db = real_conn
    assert [r["press"]["id"] for r in m.c.handovers.journaled()] == ["95201"]  # b and c settled and struck
    for p in (b, c):
        assert committed(m, f"tap_card_queued:{m.c.handovers.key(p)}") == ("1",)
    assert committed(m, f"tap_card_queued:{m.c.handovers.key(a)}") is None
    assert m.c.__dict__["_queue_retry"][m.c.handovers.key(a)][0] == 1         # tried once, then on its back-off


def test_a_reopen_that_itself_fails_still_ends_the_tick(m, monkeypatch):
    terminal(m, "95211")
    real_conn = m.ledger.db
    outbox_once_fails(m, monkeypatch)
    m.ledger.db = RollbackAlsoFails(real_conn)
    monkeypatch.setattr("harness.ledger.sqlite3.connect",
                        lambda *a, **kw: (_ for _ in ()).throw(sqlite3.OperationalError("unable to open database")))
    with pytest.raises(TransactionAborted) as got:
        m.ledger.enqueue(chat_id=1, kind="notice", text="z25", once="tap:9|outcome|z25")
    assert got.value.reopen_failed is True
    with pytest.raises(TransactionAborted):
        Controller._reraise_dead(got.value)
    ok = TransactionAborted("held")
    assert Controller._reraise_dead(ok) is None                                # an ordinary one is held


# -- 6. every catch of BaseException re-raises -------------------------------------------------------------------------

# (module, the line's own text, why it may keep the error without a raise in its body)
BASE_ALLOWED = [
    ("ledger.py", "except BaseException as rb:", "the savepoint's rollback-to failing: kept, and raised chained to "
                                                  "the original right after (Ledger.enqueue)"),
    ("ledger.py", "except BaseException as rel:", "the savepoint's release failing: kept, and raised chained to the "
                                                   "original right after (Ledger.enqueue)"),
    ("calendar_change.py", "except BaseException as e:", "a calendar write's thread hands its error to the caller "
                                                         "that waits on it, or logs it once abandoned"),
]


def _raises(body) -> bool:
    """A raise in the handler's own code (a raise inside a function or class defined there doesn't count)."""
    todo = list(body)
    while todo:
        node = todo.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        if isinstance(node, ast.Raise):
            return True
        todo.extend(ast.iter_child_nodes(node))
    return False


def _base(handler) -> bool:
    t = handler.type
    if t is None:
        return True
    names = t.elts if isinstance(t, ast.Tuple) else [t]
    return any(isinstance(n, ast.Name) and n.id == "BaseException" for n in names)


def base_catches_without_a_raise(name: str, source: str) -> list[str]:
    lines = source.splitlines()
    out = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ExceptHandler) and _base(node) and not _raises(node.body):
            text = lines[node.lineno - 1].strip()
            if not any(name == f and text.startswith(words) for f, words, _ in BASE_ALLOWED):
                out.append(f"{name}:{node.lineno}: {text}")
    return out


def test_no_catch_of_base_exception_swallows_it():
    found = []
    for path in sorted(APP.glob("*.py")):
        found += base_catches_without_a_raise(path.name, path.read_text(encoding="utf-8"))
    assert not found, "\n".join(found)


def test_the_allowed_base_catches_are_still_there_and_have_their_reason():
    for name, words, why in BASE_ALLOWED:
        assert why and any(line.strip().startswith(words)
                           for line in (APP / name).read_text(encoding="utf-8").splitlines()), (name, words)


@pytest.mark.parametrize("source", [
    "try:\n    f()\nexcept BaseException:\n    pass\n",
    "try:\n    f()\nexcept:\n    log()\n",
    "try:\n    f()\nexcept (ValueError, BaseException) as e:\n    keep(e)\n",
    "try:\n    f()\nexcept BaseException:\n    def g():\n        raise\n",
])
def test_the_scan_finds_a_swallowed_base_catch(source):
    assert base_catches_without_a_raise("x.py", source)


def test_the_reopen_helpers_cleanup_lets_an_interrupt_through(m, monkeypatch):
    class Interrupting:
        in_transaction = True

        def rollback(self):
            raise KeyboardInterrupt

        def close(self):
            raise KeyboardInterrupt
    with pytest.raises(KeyboardInterrupt):
        m.ledger._unstick(Interrupting(), False)


# -- 9. the one allowed ask, bound to its card's builder ----------------------------------------------------------------

def test_the_ask_passes_only_in_the_internal_error_cards_own_text():
    lead = "Harness hit an internal error while working out what came of it"
    card = "A tap of yours from Tue 3:00 PM. " + Controller.TERMINAL_WORDS["internal_error"]
    assert rule_problems("card", card, []) == []
    assert rule_problems("card", "A tap of yours (time unknown). " + Controller.TERMINAL_WORDS["internal_error"],
                         []) == []
    quoting = (f"A tap of yours from Tue 3:00 PM. {lead}, so it was set aside. {ASK} Nothing else is done for it.")
    assert lead in quoting and quoting.count(ASK) == 1
    assert rule_problems("card", quoting, [])                                  # another card quoting the lead
    tacked = card + " Your calendar couldn't be read either."
    assert rule_problems("card", tacked, [])                                   # more than the builder's text
    assert asks_in(card + " " + ASK)                                           # still said once only


def test_the_internal_error_card_as_queued_passes(m, monkeypatch):
    press = {"id": "95901", "custom_id": "k:a:r25card", "token": "t", "app": "999", "message_id": "5"}
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=press)) and h.journal_outcome(press, "internal_error")
    m.c._finish_terminal(h.journaled())
    (text,) = [r[0] for r in m.ledger.db.execute("SELECT text FROM outbox").fetchall() if "internal error" in r[0]]
    assert rule_problems("card", text, []) == []
    assert json.loads(m.ledger.get_meta(Controller.DIAG_FLAG + h.key(press)))["error"] == "unknown"
    assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(h.key(press), "outcome", "internal_error"))
