"""0.24.0, twenty-seventh round: the parts of the twenty-sixth outside review's findings that sit in the scrub, the
source scans and the digest.

5. Words he's shown (a "Nothing changed" refusal naming his events, a stopped part's words) get only the known
   secrets replaced, never the heuristic patterns, so an event called "Token: pickup" reaches him as written.
7. The exception-to-text scan also catches a format call, an attribute of the caught exception, and a simple
   rebinding of it, and a log or scrub call passes only when its receiver is the logger or the scrub module. The
   twenty-fifth round's allow-list scan is gone (tests/test_outbox_round26.py has the scan with no list).
8. The storage note's no-write check runs through the controller's own digest composition, with its inputs there.
All names and ids invented.
"""
import ast
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from harness import net, scrub
from harness.calendar_change import CalendarChange, Refuse
from harness.controller import Controller
from harness.ledger import Ledger
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, change, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_outbox_round26 import writes_refused
from fake_caldav import no_network  # noqa: F401  (autouse)

APP = Path(__file__).resolve().parent.parent / "harness" / "app" / "harness"
SECRET = "sEcReT0token0value0Abc123"
TAKE_OFF = change("gmail", "remove", "the 8:00 drop-off")

# Event titles and notes that look like secrets to the heuristic patterns.
TITLES = [
    "Token: pickup",
    "Wifi password=garden at the cabin",
    "PickupWithGrandmaAt4pmFromTheOldLibraryOnMain2026",
]


# -- 5. his own words keep their titles ---------------------------------------------------------------------------------

@pytest.mark.parametrize("title", TITLES)
def test_the_owner_scrub_leaves_his_titles(title):
    assert scrub.scrub(title) != title                                         # the heuristic would redact it
    # Twenty-eighth round: his words as the owner-text type (plain text now gets the whole scrub).
    # Twenty-ninth round: built with its factory (a literal template and his event's field).
    assert scrub.scrub_owner(scrub.OwnerText.template("Nothing changed: “{title}” isn't on your calendar.",
                                                      title=title)) == \
        f"Nothing changed: “{title}” isn't on your calendar."


def test_the_owner_scrub_still_replaces_known_secrets(m):
    m.c.handovers._token_fn = lambda: SECRET                                   # the link's token, from the provider
    net.REDACT.register("rEgIsTeReD0secret0value9")
    assert scrub.scrub_owner(f"Nothing changed: {SECRET}.") == f"Nothing changed: {scrub.REDACTED}."
    assert "rEgIsTeReD0secret0value9" not in scrub.scrub_owner("Nothing changed: rEgIsTeReD0secret0value9.")


@pytest.mark.parametrize("title", TITLES)
def test_a_refusal_card_names_his_event_as_written(m, monkeypatch, title):
    def refuse(self, params, pid, run=False):
        raise Refuse(f"“{title}” isn't on your calendar")
    monkeypatch.setattr(CalendarChange, "_plan_all", refuse)
    m.tells("not doing the 8:00 drop-off today", ask(TAKE_OFF))
    said = m.seen()[-1].replace("&quot;", '"').replace("&#x27;", "'")
    assert said.startswith("Nothing changed:")
    assert title in said and scrub.REDACTED not in said


def test_a_stopped_parts_words_are_kept_as_written_at_the_records_sink(m):
    # Twenty-ninth round: the sinks go by type. His words as OwnerText keep his titles at a sink that has them as
    # values (the tap journal's, scrub_fields); a record kept as JSON text has no types, so its words get the whole
    # scrub there, as anything that isn't his words does.
    words = scrub.OwnerText.template("“{t}” moved since the card", t="Token: pickup")
    got = scrub.scrub_fields({"words": words, "error": "Token: abc123"})
    assert got["words"] == "“Token: pickup” moved since the card"          # his words, as written
    assert got["error"] != "Token: abc123"                                     # exception text still scrubbed
    with m.ledger.tx() as db:
        m.ledger.set_meta("cc_plan:r27", json.dumps({"words": str(words), "error": "Token: abc123"}), db)
    kept = json.loads(m.ledger.get_meta("cc_plan:r27"))
    assert kept["words"] == scrub.scrub(str(words)) and kept["error"] != "Token: abc123"


# -- 7. the exception-to-text scan, extended -------------------------------------------------------------------------

LEVELS = {"debug", "info", "warning", "error", "exception", "critical", "log"}
SCRUB_NAMES = {"scrub", "scrub_owner", "scrub_fields", "REDACT"}
TEXT_ATTRS = {"args", "message", "msg", "words", "strerror", "reason", "text", "body", "detail", "ask"}


def _parents(tree):
    out = {}
    for n in ast.walk(tree):
        for c in ast.iter_child_nodes(n):
            out[c] = n
    return out


def _module_names(tree):
    """The names this module binds to the logger (logging, or a getLogger result), to the scrub module (and net,
    for REDACT), and to the scrub's functions imported by name."""
    loggers, scrub_mods, scrub_funcs = {"logging"}, set(), set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call):
            f = n.value.func
            if isinstance(f, ast.Attribute) and f.attr == "getLogger":
                loggers |= {t.id for t in n.targets if isinstance(t, ast.Name)}
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name.split(".")[-1] in ("scrub", "net"):
                    scrub_mods.add(a.asname or a.name)
        if isinstance(n, ast.ImportFrom):
            for a in n.names:
                if (n.module or "").split(".")[-1] == "scrub" and a.name in SCRUB_NAMES:
                    scrub_funcs.add(a.asname or a.name)
                elif a.name in ("scrub", "net") and (n.module is None or n.level):
                    scrub_mods.add(a.asname or a.name)
                elif (n.module or "").split(".")[-1] == "net" and a.name == "REDACT":
                    scrub_funcs.add(a.asname or a.name)
    return loggers, scrub_mods, scrub_funcs


def _fine_call(call, loggers, scrub_mods, scrub_funcs) -> bool:
    """A logging call on the logger, or a scrub call on the scrub module (or a scrub function imported by name)."""
    f = call.func
    if isinstance(f, ast.Name):
        return f.id in scrub_funcs
    if not isinstance(f, ast.Attribute):
        return False
    recv = f.value
    if f.attr in LEVELS:
        return isinstance(recv, ast.Name) and recv.id in loggers
    if f.attr in SCRUB_NAMES:
        return isinstance(recv, ast.Name) and recv.id in scrub_mods
    return False


def _aliases(h, name):
    """The handler's exception name and the names it's simply rebound to (x = e, x = e.attr), anywhere after."""
    names = {name}
    grew = True
    while grew:
        grew = False
        for n in ast.walk(h):
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                v = n.value
                src = v.id if isinstance(v, ast.Name) else (v.value.id if isinstance(v, ast.Attribute)
                                                            and isinstance(v.value, ast.Name) else None)
                if src in names and n.targets[0].id not in names:
                    names.add(n.targets[0].id)
                    grew = True
    return names


def exception_text_unscrubbed(name: str, source: str) -> list[str]:
    """Each place an exception caught by name, a simple rebinding of it, or an attribute of either, is turned into
    text (str, repr, format, an f-string, a % format, a .format call, or a text attribute such as .args or .words
    used as a value) that isn't inside a logging call on the logger, a scrub call on the scrub module, or a raise. A
    comparison is not a write."""
    tree, lines, out = ast.parse(source), source.splitlines(), []
    par = _parents(tree)
    loggers, scrub_mods, scrub_funcs = _module_names(tree)
    for h in ast.walk(tree):
        if not isinstance(h, ast.ExceptHandler) or not h.name:
            continue
        names = _aliases(h, h.name)
        for n in ast.walk(h):
            if not (isinstance(n, ast.Name) and n.id in names and isinstance(n.ctx, ast.Load)):
                continue
            node, p = n, par.get(n)
            attr_text = False
            if isinstance(p, ast.Attribute) and p.value is n:
                node, attr_text = p, p.attr in TEXT_ATTRS
                p = par.get(p)
                if isinstance(p, ast.Call) and p.func is node:
                    continue                                               # a method call on it: not its text
            if isinstance(p, ast.Assign) and p.value is node and len(p.targets) == 1 \
                    and isinstance(p.targets[0], ast.Name):
                continue                                                   # a rebinding: followed as an alias
            text = (attr_text and not isinstance(p, (ast.Compare, ast.BoolOp, ast.If, ast.IfExp))
                    or isinstance(p, ast.FormattedValue)
                    or isinstance(p, ast.Call) and isinstance(p.func, ast.Name)
                    and p.func.id in ("str", "repr", "format")
                    or isinstance(p, ast.Call) and isinstance(p.func, ast.Attribute) and p.func.attr == "format"
                    or isinstance(p, ast.BinOp) and isinstance(p.op, ast.Mod)
                    or isinstance(p, ast.Tuple) and isinstance(par.get(p), ast.BinOp))
            if not text:
                continue
            q, fine = p, False
            while q is not None and q is not h:
                if isinstance(q, ast.Compare):
                    fine = True
                    break
                if isinstance(q, ast.Call) and _fine_call(q, loggers, scrub_mods, scrub_funcs):
                    fine = True
                    break
                if isinstance(q, ast.Raise):
                    fine = True
                    break
                q = par.get(q)
            if not fine:
                out.append(f"{name}:{n.lineno}: {lines[n.lineno - 1].strip()}")
    return out


def test_every_exception_text_write_goes_through_the_scrub_extended():
    found = []
    for path in sorted(APP.glob("*.py")):
        found += exception_text_unscrubbed(path.name, path.read_text(encoding="utf-8"))
    assert not found, "\n".join(found)


HEAD = "import logging\nfrom . import scrub\nfrom .scrub import scrub as scrubbed\nlog = logging.getLogger(__name__)\n"


@pytest.mark.parametrize("body", [
    "try:\n    f()\nexcept ValueError as e:\n    keep('{}'.format(e))\n",                    # a .format call
    "try:\n    f()\nexcept ValueError as e:\n    keep(format(e))\n",                         # format()
    "try:\n    f()\nexcept ValueError as e:\n    keep(e.args)\n",                            # an exception attribute
    "try:\n    f()\nexcept ValueError as e:\n    keep(f'{e.words}')\n",
    "try:\n    f()\nexcept ValueError as e:\n    err = e\n    keep(str(err))\n",             # a simple rebinding
    "try:\n    f()\nexcept ValueError as e:\n    err = e\n    box['x'] = f'{err}'\n",
    "try:\n    f()\nexcept ValueError as e:\n    other.error(str(e))\n",                     # not the logger
    "try:\n    f()\nexcept ValueError as e:\n    self.scrub(str(e))\n",                      # not the scrub module
    "try:\n    f()\nexcept ValueError as e:\n    keep(log.error and str(e))\n",
])
def test_the_extended_scan_finds_an_unscrubbed_write(body):
    assert exception_text_unscrubbed("x.py", HEAD + body)


@pytest.mark.parametrize("body", [
    "try:\n    f()\nexcept ValueError as e:\n    log.error('failed: %s', e)\n",
    "try:\n    f()\nexcept ValueError as e:\n    logging.warning('failed: %s', str(e))\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(scrubbed(e))\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(scrub.scrub(f'{e}'))\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(scrub.scrub_owner('{}'.format(e)))\n",
    "try:\n    f()\nexcept ValueError as e:\n    err = e\n    keep(scrubbed(str(err)))\n",
    "try:\n    f()\nexcept ValueError as e:\n    raise Other(str(e)) from None\n",
    "try:\n    f()\nexcept ValueError as e:\n    if str(e) == 'gone':\n        pass\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(e.status)\n",                          # not text
    "try:\n    f()\nexcept ValueError as e:\n    if e.reason:\n        pass\n",
])
def test_the_extended_scan_passes_a_scrubbed_one(body):
    assert not exception_text_unscrubbed("x.py", HEAD + body)


def test_the_round25_allow_list_scan_is_gone():
    src = (Path(__file__).resolve().parent / "test_outbox_round25.py").read_text(encoding="utf-8")
    assert "BASE_ALLOWED" not in src and "base_catches_without_a_raise" not in src


# -- 8. the storage note, through the controller's own digest composition ---------------------------------------------

class Calendars:
    configured = True

    def coverage(self):
        return [SimpleNamespace(label="Work", ok_at=datetime(2026, 11, 17, 6, tzinfo=timezone.utc), error="",
                                failing=False, name="work")]

    def agenda(self, day):
        return [], 0, 1, 1


class Watch:
    def digest_lines(self):
        return ["Email hasn't answered since 6:00 AM"], ["gmail"]

    def back_line(self):
        return "Family is working again"


class Line:
    def __init__(self, text):
        self.text = text

    def digest_line(self):
        return self.text


def test_the_storage_note_is_in_the_composed_digest_with_its_inputs_and_no_write(m, monkeypatch):
    c = m.c
    monkeypatch.setattr(c, "calendar", Calendars(), raising=False)
    monkeypatch.setattr(c, "inputs", Watch(), raising=False)
    monkeypatch.setattr(c, "mirror", Line("Work mirror: 2 blocks today"), raising=False)
    monkeypatch.setattr(c, "mail_dates", Line("Mail dates: 1 waiting"), raising=False)
    monkeypatch.setattr(c, "meaning_live", Line("Meanings: 3 learned"), raising=False)
    n = writes_refused(monkeypatch)
    c._storage_alarm()
    n["writes"] = 0
    d = c._compose_digest(paused=False)
    assert Controller.STORAGE_WORDS in d.text
    for line in ("Work mirror: 2 blocks today", "Mail dates: 1 waiting", "Email hasn't answered",
                 "Family is working again"):
        assert line in d.text                                                  # the inputs are all composed in
    assert n["writes"] == 0


def test_the_daily_path_composes_through_the_same_method():
    tree = ast.parse((APP / "controller.py").read_text(encoding="utf-8"))
    daily_ = next(f for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and f.name == "_daily")
    src = ast.unparse(daily_)
    assert "self._compose_digest(paused)" in src and "daily.gather" not in src


def test_writes_refused_refuses_every_ledger_write(m, monkeypatch):
    writes_refused(monkeypatch)
    with pytest.raises(sqlite3.OperationalError):
        Ledger.set_meta(m.ledger, "x", "y")
