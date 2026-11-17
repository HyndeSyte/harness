"""0.24.0, twenty-eighth round: the parts of the twenty-seventh outside review's findings that sit in the scrub, the
source scans and the digest.

5. Words for him are their own type (scrub.OwnerText), and the refusals that carry them (scrub.OwnerRefusal:
   calendar_change.Refuse, rules.RuleError, ics_edit.Cant, ledger.LedgerFenced) keep their message as it. The owner
   scrub takes only that type as his words; anything else gets the whole scrub. A source scan checks that no
   exception value, traceback or provider response flows into one, and that the owner scrub is only ever handed a
   caught owner refusal. The exception-to-text scan is extended to raise messages that are owner refusals,
   traceback formatting, joins over an exception's arguments, and tuple or augmented rebinding.
6. The composed digest's no-write test has the family inputs too, each line in the digest with every write refused.
All names and ids invented.
"""
import ast
import re
from pathlib import Path

import pytest

from harness import ics_edit, scrub
from harness.calendar_change import Refuse, Unclear
from harness.controller import Controller
from harness.ledger import LedgerFenced
from harness.rules import RuleError
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_outbox_round26 import writes_refused
from test_outbox_round27 import (APP, TITLES, Calendars, Line, Watch, _aliases as _aliases27, _fine_call,
                                 _module_names, _parents)
from fake_caldav import no_network  # noqa: F401  (autouse)


# -- 5. the owner-text type --------------------------------------------------------------------------------------------

@pytest.mark.parametrize("title", TITLES)
def test_only_owner_text_keeps_his_titles(title):
    words = f"Nothing changed: “{title}” isn't on your calendar."
    built = scrub.OwnerText.template("Nothing changed: “{title}” isn't on your calendar.", title=title)
    assert scrub.scrub_owner(built) == words                                   # his words, as written
    assert scrub.scrub_owner(words) == scrub.scrub(words) != words             # plain text: the whole scrub
    assert scrub.scrub_owner(Refuse(words)) == words                           # a refusal carries his words
    assert scrub.scrub_owner(ValueError(words)) == scrub.scrub(words)          # any other exception doesn't


@pytest.mark.parametrize("cls", [Refuse, RuleError, ics_edit.Cant, LedgerFenced])
def test_every_owner_refusal_keeps_its_message_as_owner_text(cls):
    e = cls("“Token: pickup” isn't on your calendar")
    assert isinstance(e, scrub.OwnerRefusal) and isinstance(e.owner, scrub.OwnerText)
    assert scrub.scrub_owner(e) == "“Token: pickup” isn't on your calendar"


def test_an_unclear_question_is_owner_text():
    e = Unclear("two events fit", "Which one, “Token: pickup” at 8 or at 9?")
    assert isinstance(e.ask, scrub.OwnerText)
    assert scrub.scrub_owner(e.ask) == "Which one, “Token: pickup” at 8 or at 9?"


def test_a_refusal_built_from_something_not_text_isnt_his_words():
    e = Refuse(ValueError("token=abc123def456"))
    assert e.owner is None and "abc123def456" not in scrub.scrub_owner(e)


# The scan. A name is tainted inside an except handler when it's the caught exception or bound from it (simply, by
# a tuple, or by an augmented assignment); a provider's response is an attribute that reads one (.text, .content,
# .json, .reason, .body, .headers, .read) or a name for one; traceback formatting is always exception text.

PROVIDER_ATTRS = {"text", "content", "json", "reason", "body", "headers", "read", "raw", "response"}
PROVIDER_NAMES = {"resp", "response", "reply", "payload", "raw_body"}
TRACEBACK = {"format_exc", "format_exception", "format_exception_only", "format_tb", "print_exc", "extract_tb",
             "format_stack", "TracebackException"}
OWNER_SCRUBS = {"scrub_owner"}


def _sources():
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(APP.glob("*.py"))}


def owner_refusals(sources: dict) -> set[str]:
    """Every class that is an owner refusal (scrub.OwnerRefusal, at any depth), by name, across the App."""
    names, grew = {"OwnerRefusal"}, True
    classes = [n for src in sources.values() for n in ast.walk(ast.parse(src)) if isinstance(n, ast.ClassDef)]
    while grew:
        grew = False
        for c in classes:
            bases = {b.id if isinstance(b, ast.Name) else b.attr if isinstance(b, ast.Attribute) else ""
                     for b in c.bases}
            if c.name not in names and bases & names:
                names.add(c.name)
                grew = True
    return names


def _last(f) -> str:
    return f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""


def _targets(t):
    if isinstance(t, ast.Name):
        return [t.id]
    if isinstance(t, (ast.Tuple, ast.List)):
        return [x for e in t.elts for x in _targets(e)]
    if isinstance(t, ast.Starred):
        return _targets(t.value)
    return []


NOT_TEXT = {"type", "getattr", "isinstance", "hasattr", "id", "len", "bool", "callable"}


def _holds(value, names) -> bool:
    """Whether an expression holds one of `names` as a value: not only as the subject of type(), getattr(),
    isinstance() and the like, a comparison, or a condition's test."""
    par = _parents(value)
    for x in ast.walk(value):
        if not (isinstance(x, ast.Name) and x.id in names):
            continue
        p, child = par.get(x), x
        if isinstance(p, ast.Call) and isinstance(p.func, ast.Name) and p.func.id in NOT_TEXT:
            continue
        if isinstance(p, ast.Compare) or isinstance(p, ast.IfExp) and p.test is child:
            continue
        return True
    return False


def aliases(h, name: str) -> set[str]:
    """The handler's exception name and every name bound from it after: simply, an attribute, a tuple or list
    (either side), an augmented assignment, a walrus, or any expression that holds it."""
    names, grew = {name}, True
    while grew:
        grew = False
        for n in ast.walk(h):
            if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign, ast.NamedExpr)) and n.value is not None:
                if not _holds(n.value, names):
                    continue
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                for t in targets:
                    for x in _targets(t):
                        if x not in names:
                            names.add(x)
                            grew = True
    return names


def _handlers(par, node):
    q = par.get(node)
    while q is not None:
        if isinstance(q, ast.ExceptHandler) and q.name:
            yield q
        q = par.get(q)


def _caught(h) -> set[str]:
    t = h.type
    return {_last(x) for x in (t.elts if isinstance(t, ast.Tuple) else [t])} if t is not None else {""}


def _owner_ref(arg, par, refusals) -> bool:
    """A caught owner refusal (a handler's own name, every type it catches one), or its question (.ask)."""
    if isinstance(arg, ast.Attribute) and arg.attr == "ask":
        arg = arg.value
    if not isinstance(arg, ast.Name):
        return False
    return any(h.name == arg.id and _caught(h) <= refusals for h in _handlers(par, arg))


def owner_text_tainted(name: str, source: str, refusals: set[str]) -> list[str]:
    """Each owner text built (OwnerText(...), an owner refusal called) from an exception value, a traceback or a
    provider's response, and each owner scrub handed anything but a caught owner refusal."""
    tree, lines, out = ast.parse(source), source.splitlines(), []
    par = _parents(tree)
    builders = refusals | {"OwnerText"}
    for call in ast.walk(tree):
        if not isinstance(call, ast.Call):
            continue
        fn = _last(call.func)
        if fn in OWNER_SCRUBS or (isinstance(call.func, ast.Name) and call.func.id == "owner_scrubbed"):
            if len(call.args) != 1 or call.keywords or not _owner_ref(call.args[0], par, refusals):
                out.append(f"{name}:{call.lineno}: owner scrub of something else: {lines[call.lineno - 1].strip()}")
            continue
        if fn not in builders or isinstance(par.get(call), ast.ClassDef):
            continue
        tainted = set()
        for h in _handlers(par, call):
            tainted |= aliases(h, h.name)
        for arg in [*call.args, *(k.value for k in call.keywords)]:
            for x in ast.walk(arg):
                bad = (isinstance(x, ast.Name) and (x.id in tainted or x.id in PROVIDER_NAMES)
                       or isinstance(x, ast.Attribute) and (x.attr in PROVIDER_ATTRS or x.attr in TRACEBACK
                                                            or x.attr == "__traceback__")
                       or isinstance(x, ast.Name) and x.id in TRACEBACK)
                if bad:
                    out.append(f"{name}:{call.lineno}: {lines[call.lineno - 1].strip()}")
                    break
            else:
                continue
            break
    return out


def test_no_exception_or_provider_text_is_built_into_words_for_him():
    sources = _sources()
    refusals = owner_refusals(sources)
    assert {"Refuse", "Unclear", "RuleError", "Cant", "LedgerFenced"} <= refusals
    found = []
    for name, src in sources.items():
        found += owner_text_tainted(name, src, refusals)
    assert not found, "\n".join(found)


OWN = "from .scrub import OwnerText, scrub_owner\nclass Refuse(OwnerRefusal):\n    pass\n"


@pytest.mark.parametrize("body", [
    "try:\n    f()\nexcept ValueError as e:\n    raise Refuse(str(e))\n",                    # its message
    "try:\n    f()\nexcept ValueError as e:\n    raise Refuse(f'Nothing changed: {e}') from e\n",
    "try:\n    f()\nexcept ValueError as e:\n    words, n = e.args[0], 1\n    raise Refuse(words)\n",   # a tuple
    "try:\n    f()\nexcept ValueError as e:\n    why = 'no'\n    why += str(e)\n    keep(OwnerText(why))\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(OwnerText(' '.join(map(str, e.args))))\n",   # a join
    "try:\n    f()\nexcept ValueError:\n    keep(OwnerText(traceback.format_exc()))\n",       # a traceback
    "resp = get()\nraise Refuse(resp.text)\n",                                                # a provider's answer
    "raise Refuse(f'Nothing changed: {r.json()[\"error\"]}')\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(scrub_owner(e))\n",                    # not an owner refusal
    "keep(scrub_owner(f'Nothing changed: {title}'))\n",                                       # not owner text
    "try:\n    f()\nexcept (Refuse, ValueError) as e:\n    keep(scrub_owner(e))\n",
])
def test_the_owner_scan_finds_tainted_words(body):
    assert owner_text_tainted("x.py", OWN + body, {"OwnerRefusal", "Refuse"})


@pytest.mark.parametrize("body", [
    "raise Refuse(f'“{title}” isn\\'t on your calendar')\n",                                 # his event's field
    "try:\n    f()\nexcept ValueError:\n    raise Refuse('Nothing changed') from None\n",
    "try:\n    f()\nexcept Refuse as e:\n    keep(scrub_owner(e))\n",                        # a caught refusal
    "try:\n    f()\nexcept Refuse as why:\n    keep(scrub_owner(why.ask))\n",
])
def test_the_owner_scan_passes_his_words(body):
    assert not owner_text_tainted("x.py", OWN + body, {"OwnerRefusal", "Refuse"})


# The exception-to-text scan, extended again: a raise of an owner refusal is no longer a safe place for exception
# text, traceback formatting is exception text wherever it's written, a join or a starred use of an exception's
# arguments is text, and a tuple or augmented rebinding is followed like a simple one.

TEXT_ATTRS = {"args", "message", "msg", "words", "strerror", "reason", "text", "body", "detail", "ask"}


def exception_text_unscrubbed(name: str, source: str, refusals: set[str] | None = None) -> list[str]:
    tree, lines, out = ast.parse(source), source.splitlines(), []
    par = _parents(tree)
    loggers, scrub_mods, scrub_funcs = _module_names(tree)
    refusals = refusals if refusals is not None else owner_refusals(_sources())

    def fine_from(p, stop):
        q = p
        while q is not None and q is not stop:
            if isinstance(q, ast.Compare):
                return True
            if isinstance(q, ast.Call) and _fine_call(q, loggers, scrub_mods, scrub_funcs):
                return True
            if isinstance(q, ast.Raise):
                exc = q.exc.func if isinstance(q.exc, ast.Call) else q.exc
                return _last(exc) not in refusals                          # an owner refusal's message isn't
            q = par.get(q)
        return False

    for call in ast.walk(tree):                                            # traceback formatting, anywhere
        if isinstance(call, ast.Call) and _last(call.func) in TRACEBACK and not fine_from(par.get(call), None):
            out.append(f"{name}:{call.lineno}: {lines[call.lineno - 1].strip()}")
    for h in ast.walk(tree):
        if not isinstance(h, ast.ExceptHandler) or not h.name:
            continue
        names = aliases(h, h.name)
        for n in ast.walk(h):
            if not (isinstance(n, ast.Name) and n.id in names and isinstance(n.ctx, ast.Load)):
                continue
            node, p = n, par.get(n)
            attr_text = False
            if isinstance(p, ast.Attribute) and p.value is n:
                node, attr_text = p, p.attr in TEXT_ATTRS or p.attr == "__traceback__"
                p = par.get(p)
                if isinstance(p, ast.Call) and p.func is node:
                    continue                                               # a method call on it: not its text
            if isinstance(p, (ast.Assign, ast.AugAssign, ast.NamedExpr)) and p.value is node:
                continue                                                   # a rebinding: followed as an alias
            if isinstance(p, (ast.Tuple, ast.List)) and isinstance(par.get(p), (ast.Assign, ast.AugAssign)) \
                    and par.get(p).value is p:
                continue                                                   # a tuple rebinding: followed too
            text = (attr_text and not isinstance(p, (ast.Compare, ast.BoolOp, ast.If, ast.IfExp))
                    or isinstance(p, ast.FormattedValue)
                    or isinstance(p, ast.Starred)
                    or isinstance(p, ast.Call) and isinstance(p.func, ast.Name)
                    and p.func.id in ("str", "repr", "format")
                    or isinstance(p, ast.Call) and isinstance(p.func, ast.Attribute)
                    and p.func.attr in ("format", "join")
                    or isinstance(p, ast.BinOp) and isinstance(p.op, (ast.Mod, ast.Add))
                    or isinstance(p, ast.AugAssign) and p.value is node
                    or isinstance(p, ast.Tuple) and isinstance(par.get(p), ast.BinOp)
                    or isinstance(p, ast.Call) and _last(p.func) in refusals)
            if text and not fine_from(p, h):
                out.append(f"{name}:{n.lineno}: {lines[n.lineno - 1].strip()}")
    return out


def test_every_exception_text_write_goes_through_the_scrub_extended_again():
    sources = _sources()
    refusals = owner_refusals(sources)
    found = []
    for name, src in sources.items():
        found += exception_text_unscrubbed(name, src, refusals)
    assert not found, "\n".join(found)


HEAD = ("import logging\nimport traceback\nfrom . import scrub\nfrom .scrub import scrub as scrubbed\n"
        "log = logging.getLogger(__name__)\n")


@pytest.mark.parametrize("body", [
    "try:\n    f()\nexcept ValueError as e:\n    raise Refuse(str(e))\n",                    # an owner refusal's message
    "try:\n    f()\nexcept ValueError as e:\n    raise Refuse(f'no: {e}') from None\n",
    "try:\n    f()\nexcept ValueError:\n    keep(traceback.format_exc())\n",                 # traceback formatting
    "try:\n    f()\nexcept ValueError as e:\n    keep(''.join(traceback.format_exception(e)))\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(' '.join(e.args))\n",                  # a join over its args
    "try:\n    f()\nexcept ValueError as e:\n    keep(', '.join(str(a) for a in e.args))\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(*e.args)\n",
    "try:\n    f()\nexcept ValueError as e:\n    err, n = e, 1\n    keep(str(err))\n",      # a tuple rebinding
    "try:\n    f()\nexcept ValueError as e:\n    (err,) = (e,)\n    keep(f'{err}')\n",
    "try:\n    f()\nexcept ValueError as e:\n    errs = []\n    errs += [e]\n    keep(str(errs))\n",   # augmented
    "try:\n    f()\nexcept ValueError as e:\n    msg = 'no: '\n    msg += str(e)\n    keep(msg)\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep('no: ' + str(e))\n",
])
def test_the_scan_finds_these_writes_too(body):
    assert exception_text_unscrubbed("x.py", HEAD + body, {"OwnerRefusal", "Refuse"})


@pytest.mark.parametrize("body", [
    "try:\n    f()\nexcept ValueError as e:\n    raise RuntimeError(str(e)) from None\n",    # not owner words
    "try:\n    f()\nexcept ValueError:\n    log.error('failed: %s', traceback.format_exc())\n",
    "try:\n    f()\nexcept ValueError as e:\n    keep(scrubbed(' '.join(map(str, e.args))))\n",
    "try:\n    f()\nexcept ValueError as e:\n    err, n = e, 1\n    log.warning('%s', err)\n",
    "try:\n    f()\nexcept ValueError as e:\n    raise Refuse('Nothing changed') from e\n",
])
def test_the_scan_passes_these(body):
    assert not exception_text_unscrubbed("x.py", HEAD + body, {"OwnerRefusal", "Refuse"})


# -- 6. the composed digest with the family inputs, no write ----------------------------------------------------------

def test_the_composed_digest_has_the_family_inputs_with_every_write_refused(m, monkeypatch):
    c = m.c
    monkeypatch.setattr(c, "calendar", Calendars(), raising=False)
    monkeypatch.setattr(c, "inputs", Watch(), raising=False)
    monkeypatch.setattr(c, "mirror", Line("Work mirror: 2 blocks today"), raising=False)
    monkeypatch.setattr(c, "mail_dates", Line("Mail dates: 1 waiting"), raising=False)
    monkeypatch.setattr(c, "meaning_live", Line("Meanings: 3 learned"), raising=False)
    family = {"family_add": Line("Family adds: 2 added this week"),
              "family_copy": Line("Family copies: 1 copied"),
              "family_gmail": Line("Family email: 3 dates found"),
              "calendar_change": Line("Calendar changes: 1 moved")}
    for attr, line in family.items():
        monkeypatch.setattr(c, attr, line, raising=False)
    n = writes_refused(monkeypatch)
    c._storage_alarm()
    n["writes"] = 0
    d = c._compose_digest(paused=False)
    assert Controller.STORAGE_WORDS in d.text
    for line in ("Work mirror: 2 blocks today", "Mail dates: 1 waiting", "Email hasn't answered",
                 "Family is working again", *(x.text for x in family.values())):
        assert line in d.text                                                  # every input composed in
    assert n["writes"] == 0
