"""0.24.0, twenty-ninth round: the parts of the twenty-eighth outside review's findings that sit in the scrub and
its source scans.

4. The records and journal sinks give the light scrub to the owner-words field by type, not by position: only an
   OwnerText value there keeps his titles; plain text in that field, and a record kept as JSON text (where nothing
   has a type), gets the whole scrub. The owner-scrub scan finds the scrub by what it was imported from, whatever
   its local name. OwnerText's constructor is private: words for him are built by OwnerText.template (a literal
   template and his events' fields) or an owner refusal, and the scan flags any other construction.
9. The one new card he can get this round says nothing he shouldn't see.
All names and ids invented.
"""
import ast
import json
import re

import pytest

from harness import scrub
from harness.calendar_change import Refuse, Unclear
from harness.controller import Controller
from harness.handover import Inbox
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_outbox_round27 import APP, TITLES, _parents
from test_outbox_round28 import (PROVIDER_ATTRS, PROVIDER_NAMES, TRACEBACK, _handlers, _owner_ref, aliases,
                                 owner_refusals)
from fake_caldav import no_network  # noqa: F401  (autouse)


# -- 4. the sinks go by type ---------------------------------------------------------------------------------------

@pytest.mark.parametrize("title", TITLES)
def test_the_journal_sink_keeps_only_owner_text_as_written(tmp_path, title):
    inbox = Inbox(lambda: "", journal=str(tmp_path / "taps.jsonl"))
    words = scrub.OwnerText.template("“{t}” moved since the card", t=title)
    assert inbox._append({"check": "1|k", "words": words})
    assert inbox._append({"check": "2|k", "words": str(words)})               # the same text, not his words' type
    rows = [json.loads(x) for x in open(inbox.journal, encoding="utf-8")]
    assert rows[0]["words"] == f"“{title}” moved since the card"               # his words: the light scrub
    assert rows[1]["words"] == scrub.scrub(str(words)) != str(words)           # anything else: the whole scrub


@pytest.mark.parametrize("title", TITLES)
def test_the_records_sink_gives_plain_words_the_whole_scrub(m, title):
    with m.ledger.tx() as db:
        m.ledger.set_meta("cc_plan:r29", json.dumps({"words": f"“{title}” moved since the card"}), db)
    kept = json.loads(m.ledger.get_meta("cc_plan:r29"))
    assert kept["words"] == scrub.scrub(f"“{title}” moved since the card")


def test_scrub_fields_goes_by_type_in_lists_too():
    words = scrub.OwnerText.template("“{t}”", t="Token: pickup")
    got = scrub.scrub_fields({"words": [words, "Token: pickup"]})
    assert got["words"] == ["“Token: pickup”", scrub.scrub("Token: pickup")]


def test_owner_texts_constructor_is_private():
    with pytest.raises(TypeError):
        scrub.OwnerText("Nothing changed")
    built = scrub.OwnerText.template("Nothing changed: “{t}” isn't on your calendar", t="Token: pickup")
    assert isinstance(built, scrub.OwnerText)
    assert scrub.scrub_owner(built) == "Nothing changed: “Token: pickup” isn't on your calendar"


def test_an_unclear_question_is_still_owner_text():
    e = Unclear("more than one event fits", "Which one, “Token: pickup” at 8 or at 9?")
    assert isinstance(e.ask, scrub.OwnerText) and isinstance(e.owner, scrub.OwnerText)
    assert scrub.scrub_owner(e.ask) == "Which one, “Token: pickup” at 8 or at 9?"
    assert Unclear("none fits").ask == "" and isinstance(Refuse("x").owner, scrub.OwnerText)


# The scan, by import target. Every name bound to scrub.scrub_owner or scrub.OwnerText (imported under any name, or
# rebound), and every name for the scrub module itself, is found from the imports and assignments; a call through
# any of them is an owner scrub, or an OwnerText built.

SCRUB_MODULES = {"scrub", "harness.scrub"}


def _imports(tree, own: bool) -> tuple[dict, set]:
    """({local name: 'scrub_owner' | 'OwnerText' | '_owner' | '_MINT'}, {local names for the scrub module})."""
    names, modules = {}, set()
    if own:
        names.update({n: n for n in ("scrub_owner", "OwnerText", "_owner", "_MINT")})
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            mod = ("." * n.level) + (n.module or "")
            for a in n.names:
                if mod.lstrip(".") in SCRUB_MODULES or mod.endswith(".scrub") or (mod.lstrip(".") == "scrub"):
                    if a.name in ("scrub_owner", "OwnerText", "_owner", "_MINT"):
                        names[a.asname or a.name] = a.name
                elif a.name == "scrub" and (n.level or mod in ("harness",)):
                    modules.add(a.asname or a.name)
        elif isinstance(n, ast.Import):
            for a in n.names:
                if a.name in SCRUB_MODULES:
                    modules.add(a.asname or a.name.split(".")[0])
    grew = True
    while grew:                                                                # rebinding: x = scrub_owner
        grew = False
        for n in ast.walk(tree):
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                target = _target_of(n.value, names, modules)
                if target and n.targets[0].id not in names:
                    names[n.targets[0].id] = target
                    grew = True
    return names, modules


def _target_of(f, names, modules) -> str:
    """What a callee resolves to in the scrub module ('' for anything else)."""
    if isinstance(f, ast.Name):
        return names.get(f.id, "")
    if isinstance(f, ast.Attribute):
        if isinstance(f.value, ast.Name) and f.value.id in modules:
            return f.attr if f.attr in ("scrub_owner", "OwnerText", "_owner", "_MINT") else ""
        if isinstance(f.value, ast.Attribute) and f.value.attr == "scrub" \
                and f.attr in ("scrub_owner", "OwnerText", "_owner", "_MINT"):
            return f.attr                                                      # harness.scrub.X
    return ""


def _tainted(arg, tainted) -> bool:
    for x in ast.walk(arg):
        if isinstance(x, ast.Name) and (x.id in tainted or x.id in PROVIDER_NAMES or x.id in TRACEBACK) \
                or isinstance(x, ast.Attribute) and (x.attr in PROVIDER_ATTRS or x.attr in TRACEBACK
                                                     or x.attr == "__traceback__"):
            return True
    return False


def _enclosing_function(par, node) -> str:
    q = par.get(node)
    while q is not None:
        if isinstance(q, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return q.name
        q = par.get(q)
    return ""


def owner_scan(name: str, source: str, refusals: set[str]) -> list[str]:
    """Each owner scrub (found by its import target) handed anything but a caught owner refusal or its question,
    and each OwnerText built other than by OwnerText.template with a literal template and untainted fields (the scrub
    module's own _owner and the template's own construction excepted)."""
    tree, lines, out = ast.parse(source), source.splitlines(), []
    par = _parents(tree)
    own = name == "scrub.py"
    names, modules = _imports(tree, own)

    def flag(node, why):
        out.append(f"{name}:{node.lineno}: {why}: {lines[node.lineno - 1].strip()}")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Name, ast.Attribute)) and _target_of(node, names, modules) in ("_owner", "_MINT") \
                and not own:
            flag(node, "the scrub module's private minting used outside it")
            continue
        if isinstance(node, ast.Attribute) and node.attr == "__new__" \
                and _target_of(node.value, names, modules) == "OwnerText":
            flag(node, "OwnerText built around its factory")
            continue
        if not isinstance(node, ast.Call):
            continue
        callee = _target_of(node.func, names, modules)
        if isinstance(node.func, ast.Attribute) and node.func.attr == "__new__" and any(
                _target_of(a, names, modules) == "OwnerText" for a in node.args):
            flag(node, "OwnerText built around its factory")
        elif callee == "scrub_owner":
            if len(node.args) != 1 or node.keywords or not _owner_ref(node.args[0], par, refusals):
                flag(node, "owner scrub of something else")
        elif callee == "OwnerText":
            if not (own and _enclosing_function(par, node) == "_owner"):
                flag(node, "OwnerText built directly")
        elif isinstance(node.func, ast.Attribute) and node.func.attr == "template" \
                and _target_of(node.func.value, names, modules) == "OwnerText":
            tainted = set()
            for h in _handlers(par, node):
                tainted |= aliases(h, h.name)
            literal = node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)
            if not literal or len(node.args) != 1 or any(k.arg is None for k in node.keywords) \
                    or any(_tainted(k.value, tainted) for k in node.keywords):
                flag(node, "OwnerText.template with no literal template, or with exception or provider text")
    return out


def _sources():
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(APP.glob("*.py"))}


def test_the_owner_scan_by_import_target_passes_the_app():
    sources = _sources()
    refusals = owner_refusals(sources)
    found = []
    for name, src in sources.items():
        found += owner_scan(name, src, refusals)
    assert not found, "\n".join(found)


HEAD = "class Refuse(OwnerRefusal):\n    pass\n"


@pytest.mark.parametrize("body", [
    # the owner scrub under another name, or through the module under another name
    "from .scrub import scrub_owner as clean\ntry:\n    f()\nexcept ValueError as e:\n    keep(clean(e))\n",
    "from . import scrub as s\ntry:\n    f()\nexcept ValueError as e:\n    keep(s.scrub_owner(e))\n",
    "import harness.scrub as hs\nkeep(hs.scrub_owner(text))\n",
    "from harness.scrub import scrub_owner as tidy\nlight = tidy\nkeep(light(f'Nothing changed: {title}'))\n",
    # OwnerText built any other way than its factory with a literal template
    "from .scrub import OwnerText\nkeep(OwnerText('Nothing changed'))\n",
    "from .scrub import OwnerText as OT\nkeep(OT(words))\n",
    "from . import scrub\nkeep(scrub.OwnerText(words))\n",
    "from .scrub import OwnerText\nkeep(OwnerText.template(fmt, t=title))\n",
    "from .scrub import OwnerText\nkeep(OwnerText.template(f'{title} moved'))\n",
    "from .scrub import OwnerText\ntry:\n    f()\nexcept ValueError as e:\n"
    "    keep(OwnerText.template('{w}', w=e))\n",
    "from .scrub import OwnerText\nkeep(OwnerText.template('{w}', w=resp.text))\n",
    "from .scrub import OwnerText\nkeep(OwnerText.template('{w}', **fields))\n",
    "from .scrub import OwnerText\nkeep(str.__new__(OwnerText, words))\n",
    "from .scrub import OwnerText\nkeep(OwnerText.__new__(OwnerText, words))\n",
    "from . import scrub\nkeep(scrub._owner(words))\n",
    "from .scrub import _MINT, OwnerText\nkeep(OwnerText(words, _MINT))\n",
])
def test_the_owner_scan_finds_these(body):
    assert owner_scan("x.py", HEAD + body, {"OwnerRefusal", "Refuse"})


@pytest.mark.parametrize("body", [
    "from .scrub import OwnerText\nkeep(OwnerText.template('“{t}” moved since the card', t=title))\n",
    "from .scrub import OwnerText as OT\nkeep(OT.template('Which one?'))\n",
    "from .scrub import scrub_owner as clean\ntry:\n    f()\nexcept Refuse as e:\n    keep(clean(e))\n",
    "from . import scrub as s\ntry:\n    f()\nexcept Refuse as why:\n    keep(s.scrub_owner(why.ask))\n",
    "from .other import scrub_owner\nkeep(scrub_owner(text))\n",                    # not the scrub module's
])
def test_the_owner_scan_passes_these(body):
    assert not owner_scan("x.py", HEAD + body, {"OwnerRefusal", "Refuse"})


# -- 9. the one new card says nothing he shouldn't see -------------------------------------------------------------

def test_the_waiting_card_carries_no_id_sha_time_or_ask_to_send_again():
    words = Controller.SETASIDE_CARD_WORDS
    assert not re.search(r"\b[0-9a-f]{7,40}\b", words)                         # no sha
    assert not re.search(r"\d{4}-\d{2}-\d{2}", words)                          # no ISO time
    assert not re.search(r"(?i)\bjob\b|\bid\b", words)                         # no job id
    assert not re.search(r"(?i)\b(send|tap|press|try)\b[^.]*\bagain\b", words)   # no ask to send or tap again
    assert "check your calendar" not in words.lower()
