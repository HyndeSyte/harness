"""0.24.0, thirty-first round: the parts of the thirtieth outside review's findings that sit in the scrub, the records
sink and the owner-text scan.

4. A tag naming his words (scrub.OWNER_TAG) is honoured only in text the serialiser wrote (scrub.dumps): the records'
   sink drops it from anything else, so a tag forged in plain JSON, or in text from outside, gets the whole scrub and
   never reads back as his words; the scan flags a metadata write of plain JSON that carries his words or the tag.
10. The owner-text scan flags dynamic imports, module-table lookups, exec, eval, compile and function globals
    anywhere in the App, and knows the scrub module by its full dotted path, not its file name.
11. The words this round adds say nothing he shouldn't see.
All names and ids invented.
"""
import ast
import copy
import json
import pickle
import re

import pytest

from harness import handover, scrub
from harness.controller import Controller
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_outbox_round27 import APP
from test_outbox_round28 import owner_refusals
from test_outbox_round29 import HEAD, _imports, owner_scan
from test_outbox_round30 import access_scan, sources
from fake_caldav import no_network  # noqa: F401  (autouse)


def his_words(title):
    return scrub.OwnerText.template("“{t}” moved since the card", t=title)


# -- 4. the tag only from the serialiser ---------------------------------------------------------------------------

FORGED = [
    pytest.param({"words": "Token: pickup", scrub.OWNER_TAG: ["words"]}, id="field"),
    pytest.param({"words": ["Token: pickup"], scrub.OWNER_TAG: ["words[0]"]}, id="list-item"),
    pytest.param({"steps": [{"words": "Token: pickup", scrub.OWNER_TAG: ["words"]}]}, id="nested"),
]


def words_in(record):
    if isinstance(record, dict):
        out = [record["words"]] if "words" in record else []
        for v in record.values():
            out += words_in(v) if isinstance(v, (dict, list)) else []
        return [w for x in out for w in (x if isinstance(x, list) else [x])]
    if isinstance(record, list):
        return [w for x in record for w in words_in(x)]
    return []


def tags_in(text):
    return scrub.OWNER_TAG in text


@pytest.mark.parametrize("forged", FORGED)
def test_a_forged_tag_through_the_plain_metadata_write_is_fully_scrubbed_and_never_his_words(m, forged):
    with m.ledger.tx() as db:
        m.ledger.set_meta("cc_plan:r31forged", json.dumps(forged), db)        # plain serialisation
    raw = m.ledger.get_meta("cc_plan:r31forged")
    assert not tags_in(raw)                                                    # the tag isn't kept at rest
    assert words_in(json.loads(raw)) == [scrub.scrub("Token: pickup")]         # the whole scrub
    assert scrub.scrub("Token: pickup") != "Token: pickup"
    kept = m.ledger.meta_record("cc_plan:r31forged")
    assert all(not isinstance(w, scrub.OwnerText) for w in words_in(kept))     # never rehydrated as his words


@pytest.mark.parametrize("forged", FORGED)
def test_a_forged_tag_in_an_events_text_is_fully_scrubbed(m, forged):
    with m.ledger.tx() as db:
        m.ledger.event("cc_words_r31", json.dumps(forged), db=db)
    raw = m.ledger.db.execute("SELECT detail FROM events WHERE kind='cc_words_r31'").fetchone()[0]
    assert not tags_in(raw) and words_in(json.loads(raw)) == [scrub.scrub("Token: pickup")]


def test_serialised_text_that_lost_its_type_loses_its_tag(m):
    text = scrub.dumps({"words": his_words("Token: pickup")})
    assert scrub.serialised(text)
    for plain in (str(text), text + "", "".join([text]), pickle.loads(pickle.dumps(text)), copy.deepcopy(text)):
        assert not scrub.serialised(plain)
        with m.ledger.tx() as db:
            m.ledger.set_meta("cc_plan:r31plain", plain, db)
        assert not isinstance(m.ledger.meta_record("cc_plan:r31plain")["words"], scrub.OwnerText)
    with pytest.raises(TypeError):
        scrub._Serialised(text)                                                # its constructor is private


@pytest.mark.parametrize("title", ["Token: pickup", "Swim with Ava"])
def test_the_serialisers_own_text_still_keeps_his_words(m, title):
    with m.ledger.tx() as db:
        m.ledger.set_meta("cc_plan:r31ok", scrub.dumps({"steps": [{"words": his_words(title)}],
                                                        "error": "Token: abc123"}), db)
    kept = m.ledger.meta_record("cc_plan:r31ok")
    assert isinstance(kept["steps"][0]["words"], scrub.OwnerText)
    assert kept["steps"][0]["words"] == f"“{title}” moved since the card"
    assert kept["error"] == scrub.scrub("Token: abc123")


def test_untag_drops_every_tag_at_any_depth():
    got = scrub.untag({"a": [{"b": {scrub.OWNER_TAG: ["words"], "words": "x"}}], scrub.OWNER_TAG: ["words"]})
    assert scrub.OWNER_TAG not in json.dumps(got)


WRITERS = ("set_meta", "event")
OWNER_MAKERS = ("template", "scrub_owner", "owner", "ask")


def plain_meta_writes(name: str, source: str) -> list[str]:
    """Each metadata write (set_meta, or event with text) whose value is plain serialisation (json.dumps, not
    scrub.dumps) of something holding his words (OwnerText made there, an owner refusal's .owner or .ask) or the
    tag; and the tag's literal, or the serialiser's private type, anywhere outside the scrub module."""
    tree, lines, out = ast.parse(source), source.splitlines(), []

    def flag(node, why):
        out.append(f"{name}:{node.lineno}: {why}: {lines[node.lineno - 1].strip()}")
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and node.value == scrub.OWNER_TAG:
            flag(node, "the owner tag written by hand")
        elif isinstance(node, (ast.Name, ast.Attribute)) and (getattr(node, "id", None) == "_Serialised"
                                                               or getattr(node, "attr", None) == "_Serialised"):
            flag(node, "the serialiser's private type used")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in WRITERS \
                and len(node.args) >= 2:
            value = node.args[1]
            if not (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute)
                    and value.func.attr == "dumps" and isinstance(value.func.value, ast.Name)
                    and value.func.value.id == "json"):
                continue
            for x in ast.walk(value):
                if isinstance(x, ast.Attribute) and (x.attr in OWNER_MAKERS or x.attr == "OWNER_TAG") \
                        or isinstance(x, ast.Name) and x.id in ("scrub_owner", "owner_scrubbed", "OWNER_TAG"):
                    flag(node, "his words or the tag written with plain serialisation")
                    break
    return out


def test_the_app_writes_no_tag_or_his_words_with_plain_serialisation():
    found = []
    for rel, src in sources().items():
        if dotted(rel) != "harness.scrub":
            found += plain_meta_writes(rel, src)
    assert not found, "\n".join(found)


@pytest.mark.parametrize("body", [
    "keep.set_meta('k', json.dumps({'words': OwnerText.template('“{t}”', t=x)}), db)\n",
    "keep.set_meta('k', json.dumps({'words': e.owner}), db)\n",
    "keep.event('k', json.dumps({'words': owner_scrubbed(e)}), db=db)\n",
    "keep.set_meta('k', json.dumps({'words': w, scrub.OWNER_TAG: ['words']}), db)\n",
    "keep.set_meta('k', json.dumps({'words': w, '__owner__': ['words']}), db)\n",
    "keep.set_meta('k', scrub._Serialised(text, key), db)\n",
])
def test_the_plain_write_scan_finds_these(body):
    assert plain_meta_writes("x.py", "import json\n" + body)


@pytest.mark.parametrize("body", [
    "keep.set_meta('k', scrub.dumps({'words': OwnerText.template('“{t}”', t=x)}), db)\n",
    "keep.set_meta('k', json.dumps({'n': 1}), db)\n",
    "keep.event('k', {'words': e.owner}, db=db)\n",
])
def test_the_plain_write_scan_passes_these(body):
    assert not plain_meta_writes("x.py", "import json\n" + body)


# -- 10. dynamic access anywhere, and the scrub module by its dotted path -------------------------------------------

def dotted(rel: str) -> str:
    """A file's module path under the App's package ("harness.scrub", "harness.sub.scrub")."""
    parts = rel[:-3].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(["harness", *parts])


DYNAMIC_CALLS = ("exec", "eval", "compile", "__import__")
DYNAMIC_ATTRS = ("__globals__", "__func__", "__code__", "__closure__", "__builtins__", "import_module", "modules")


def dynamic_scan(name: str, source: str) -> list[str]:
    """Each form that reaches a module or a function's globals around the import scan, anywhere in the App: exec,
    eval, compile and __import__ (called, or read off builtins); importlib (imported, or import_module); sys.modules
    (read, or imported by name); and a function's __globals__, __func__, __code__, __closure__ or __builtins__."""
    tree, lines, out = ast.parse(source), source.splitlines(), []

    def flag(node, why):
        out.append(f"{name}:{node.lineno}: {why}: {lines[node.lineno - 1].strip()}")
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in DYNAMIC_CALLS:
            flag(node, "dynamic code or import")
        elif isinstance(node, ast.Attribute) and node.attr in DYNAMIC_CALLS \
                and isinstance(node.value, ast.Name) and node.value.id in ("builtins", "__builtins__"):
            flag(node, "dynamic code or import")
        elif isinstance(node, ast.Attribute) and node.attr in DYNAMIC_ATTRS:
            if node.attr == "modules" and not (isinstance(node.value, ast.Name) and node.value.id == "sys"):
                continue
            flag(node, "a module table or a function's globals read")
        elif isinstance(node, ast.Import) and any(a.name.split(".")[0] == "importlib" for a in node.names):
            flag(node, "importlib imported")
        elif isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "importlib":
            flag(node, "importlib imported")
        elif isinstance(node, ast.ImportFrom) and node.module == "sys" and any(a.name == "modules"
                                                                               for a in node.names):
            flag(node, "the module table imported")
    return out


def full_scan(rel: str, source: str, refusals) -> list[str]:
    """The owner-text scans with the scrub module known by its dotted path: only harness.scrub is the scrub module
    (exempt from the access scan, its own minting allowed); a file of the same name anywhere else is scanned as any
    other, and its own OwnerText calls are flagged."""
    mod = dotted(rel)
    own = mod == "harness.scrub"
    found = dynamic_scan(rel, source)
    if not own:
        found += access_scan(mod, source)                                     # never skipped by its file name
    found += owner_scan("scrub.py" if own else mod, source, refusals)
    return found


def test_the_app_passes_the_scans_with_the_scrub_module_by_its_dotted_path():
    srcs = sources()
    refusals = owner_refusals({k.rsplit("/", 1)[-1]: v for k, v in srcs.items()})
    found = []
    for rel, src in srcs.items():
        found += full_scan(rel, src, refusals)
    assert not found, "\n".join(found)


@pytest.mark.parametrize("body", [
    "keep(exec('from .scrub import _MINT'))\n",
    "keep(eval('OwnerText')(words))\n",
    "code = compile(src, 'x', 'exec')\n",
    "mod = __import__('harness.scrub', fromlist=['x'])\n",
    "import builtins\nkeep(builtins.eval(text))\n",
    "import importlib\nmod = importlib.import_module('harness.scrub')\n",
    "from importlib import import_module\nmod = import_module('harness.scrub')\n",
    "import sys\nmod = sys.modules['harness.scrub']\n",
    "import sys\nmod = sys.modules.get('harness.scrub')\n",
    "from sys import modules\nmod = modules['harness.scrub']\n",
    "from .scrub import OwnerText\nmint = OwnerText.template.__func__.__globals__['_MINT']\n",
    "from .scrub import OwnerText\ng = OwnerText.template.__globals__\n",
    "from .scrub import scrub_owner\nc = scrub_owner.__code__\n",
])
def test_the_dynamic_scan_finds_these(body):
    assert dynamic_scan("x.py", HEAD + body)


@pytest.mark.parametrize("body", [
    "import re\npat = re.compile(r'x')\n",
    "from .scrub import OwnerText\nkeep(OwnerText.template('“{t}” moved', t=title))\n",
    "import sys\nsys.exit(0)\n",
    "keep(self.modules)\n",
])
def test_the_dynamic_scan_passes_these(body):
    assert not dynamic_scan("x.py", HEAD + body)


SAME_NAMED = "from ..scrub import OwnerText\nkeep(OwnerText(words))\nkeep(getattr(scrub, 'x'))\n"


def test_a_same_named_file_in_a_subpackage_isnt_taken_for_the_scrub_module():
    src = "from .. import scrub\n" + SAME_NAMED
    assert dotted("sub/scrub.py") == "harness.sub.scrub" and dotted("scrub.py") == "harness.scrub"
    found = full_scan("sub/scrub.py", src, {"OwnerRefusal"})
    assert any("OwnerText built directly" in f for f in found)                 # its own minting isn't allowed
    assert any("read by name" in f for f in found)                             # nor is it exempt from access
    assert owner_scan("harness.sub.scrub", "from .scrub import _owner\nkeep(_owner(x))\n", set())   # private minting


def test_the_scrub_module_itself_is_still_exempt_by_its_dotted_path():
    src = (APP / "scrub.py").read_text(encoding="utf-8")
    assert not full_scan("scrub.py", src, {"OwnerRefusal"})


def test_the_import_resolution_reads_the_module_names():
    names, modules = _imports(ast.parse("from harness import scrub as s\nfrom .scrub import OwnerText as O\n"),
                              False)
    assert "s" in modules and names.get("O") == "OwnerText"


# -- 11. what he sees ----------------------------------------------------------------------------------------------

@pytest.mark.parametrize("which", ["JOURNAL_WRITE_STORAGE", "LOCK_STORAGE", "SETASIDE_CARD_WORDS", "network"])
def test_this_rounds_words_carry_no_id_sha_time_or_ask_to_send_again(which):
    words = {"SETASIDE_CARD_WORDS": Controller.SETASIDE_CARD_WORDS,
             "network": str(handover.NetworkJournal("x"))}.get(which) or getattr(handover, which)
    assert not re.search(r"\b[0-9a-f]{7,40}\b", words)
    assert not re.search(r"\d{4}-\d{2}-\d{2}", words)
    assert not re.search(r"(?i)\bjob\b|\bid\b", words)
    assert not re.search(r"(?i)\b(send|tap|press|try)\b[^.]*\bagain\b", words)
    assert "check your calendar" not in words.lower()


def test_the_network_refusal_names_the_local_types(tmp_path):
    info = tmp_path / "mountinfo"
    info.write_text("22 1 0:21 / / rw - nfs4 server:/x rw\n")
    with pytest.raises(handover.NetworkJournal) as got:
        handover.check_local("/data/x" + handover.TAP_JOURNAL, str(info))
    said = str(got.value)
    assert "local storage" in said and "ext4" in said
    assert not re.search(r"\d{4}-\d{2}-\d{2}|\b[0-9a-f]{7,40}\b", said)
