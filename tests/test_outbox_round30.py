"""0.24.0, thirtieth round: the parts of the twenty-ninth outside review's findings that sit in the scrub, the records
sink and the owner-text scan.

3. A record kept as JSON text keeps his words' type with a tag (scrub.OWNER_TAG), written only by scrub.dumps from
   OwnerText: the records' sink gives a tagged field the light scrub and anything else the whole scrub, and
   scrub.loads (Ledger.meta_record) gives it back as OwnerText, so a save, reload and card shows his titles as
   written. Untrusted fields are fully scrubbed before they're serialised.
7. OwnerText copies, deep-copies and pickles through its private minting path.
8. The owner-text scan rejects the access forms it can't follow (a star import, getattr or vars on the scrub module,
   the module or a protected name rebound by a tuple or onto an attribute, passed as an argument, or subclassed),
   and reads subpackages too.
10. The cards this round touches say nothing he shouldn't see.
All names and ids invented.
"""
import ast
import copy
import json
import pickle
import re

import pytest

from harness import render, scrub
from harness.calendar_change import Refuse
from harness.controller import Controller
from harness.handover import Inbox
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_outbox_round27 import APP, TITLES, _parents
from test_outbox_round28 import owner_refusals
from test_outbox_round29 import HEAD, _imports, _target_of, owner_scan
from fake_caldav import no_network  # noqa: F401  (autouse)


def his_words(title):
    return scrub.OwnerText.template("“{t}” moved since the card", t=title)


# -- 3. the records sink keeps his words' type ---------------------------------------------------------------------

@pytest.mark.parametrize("title", TITLES)
def test_his_words_saved_in_the_records_read_back_as_his_words(m, title):
    with m.ledger.tx() as db:
        m.ledger.set_meta("cc_plan:r30", scrub.dumps({"words": his_words(title), "error": "Token: abc123"}), db)
    raw = json.loads(m.ledger.get_meta("cc_plan:r30"))
    assert raw["words"] == f"“{title}” moved since the card"                   # at rest, as written
    assert raw["error"] == scrub.scrub("Token: abc123") != "Token: abc123"     # untrusted text, the whole scrub
    kept = m.ledger.meta_record("cc_plan:r30")
    assert isinstance(kept["words"], scrub.OwnerText) and scrub.OWNER_TAG not in kept
    assert scrub.scrub_owner(kept["words"]) == f"“{title}” moved since the card"


@pytest.mark.parametrize("title", TITLES)
def test_a_save_reload_and_card_shows_his_title_as_written(m, title):
    with m.ledger.tx() as db:
        m.ledger.set_meta("cc_plan:r30card", scrub.dumps({"steps": [{"words": his_words(title)}]}), db)
        m.ledger.event("cc_words_r30", {"words": his_words(title)}, db=db)
    step = m.ledger.meta_record("cc_plan:r30card")["steps"][0]
    event = scrub.loads(m.ledger.db.execute("SELECT detail FROM events WHERE kind='cc_words_r30'").fetchone()[0])
    assert isinstance(event["words"], scrub.OwnerText)
    with m.ledger.tx() as db:
        m.ledger.enqueue(chat_id=OWNER, kind="notice", db=db, once="r30:card",
                         text=render.fit(f"Not done: {render.escape(scrub.scrub_owner(step['words']))}."))
    shown = m.ledger.db.execute("SELECT text FROM outbox ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert render.escape(title) in shown and scrub.REDACTED not in shown


def test_the_light_scrub_still_replaces_known_secrets_in_tagged_words(m):
    m.c.handovers._token_fn = lambda: "sEcReT0token0value0Abc123"
    words = scrub.OwnerText.template("“{t}” moved", t="sEcReT0token0value0Abc123")
    with m.ledger.tx() as db:
        m.ledger.set_meta("cc_plan:r30secret", scrub.dumps({"words": words}), db)
    assert "sEcReT0token0value0Abc123" not in m.ledger.get_meta("cc_plan:r30secret")


def test_a_tag_handed_in_isnt_kept_and_plain_words_get_the_whole_scrub():
    forged = {"words": "Token: pickup", scrub.OWNER_TAG: ["words"]}            # not his words' type: no tag
    got = json.loads(scrub.dumps(forged))
    assert scrub.OWNER_TAG not in got and got["words"] == scrub.scrub("Token: pickup")
    assert not isinstance(scrub.loads(scrub.dumps(forged))["words"], scrub.OwnerText)


def test_lists_of_his_words_keep_their_type_item_by_item():
    got = scrub.loads(scrub.dumps({"words": [his_words("Token: pickup"), "Token: pickup"]}))
    assert isinstance(got["words"][0], scrub.OwnerText) and got["words"][0] == "“Token: pickup” moved since the card"
    assert got["words"][1] == scrub.scrub("Token: pickup") and not isinstance(got["words"][1], scrub.OwnerText)


@pytest.mark.parametrize("title", TITLES)
def test_the_journal_keeps_his_words_tag_too(tmp_path, title):
    inbox = Inbox(lambda: "", journal=str(tmp_path / "taps.jsonl"))
    assert inbox._append({"check": "1|k", "words": his_words(title)})
    line = open(inbox.journal, encoding="utf-8").read()
    assert isinstance(scrub.loads(line)["words"], scrub.OwnerText)


# -- 7. copy, deep copy and pickling ----------------------------------------------------------------------------------

def plan():
    return {"steps": [{"words": his_words("Token: pickup"), "kind": "stale"}], "refusal": Refuse("“Swim” isn't there")}


def test_a_plan_holding_his_words_deep_copies():
    p = plan()
    got = copy.deepcopy(p)
    assert isinstance(got["steps"][0]["words"], scrub.OwnerText)
    assert got["steps"][0]["words"] == p["steps"][0]["words"]
    assert isinstance(copy.copy(p["steps"][0]["words"]), scrub.OwnerText)


def test_a_plan_holding_his_words_pickles():
    p = plan()
    got = pickle.loads(pickle.dumps(p))
    assert isinstance(got["steps"][0]["words"], scrub.OwnerText)
    assert got["steps"][0]["words"] == "“Token: pickup” moved since the card"
    assert isinstance(got["refusal"].owner, scrub.OwnerText)
    with pytest.raises(TypeError):
        scrub.OwnerText("still private")                                       # the constructor stays private


# -- 8. the owner-text scan rejects what it can't follow ------------------------------------------------------------

PROTECTED = ("scrub_owner", "OwnerText")


def access_scan(name: str, source: str) -> list[str]:
    """Each access to the scrub module, scrub_owner or OwnerText that owner_scan can't follow: a star import from the
    scrub module; getattr, vars or __dict__ on it; the module, or a protected name, used other than by a direct call,
    `.template`, an isinstance or issubclass check, an attribute read off the module, or a plain one-name rebinding
    (which owner_scan follows)."""
    tree, lines, out = ast.parse(source), source.splitlines(), []
    if name.endswith("scrub.py"):
        return out
    par = _parents(tree)
    names, modules = _imports(tree, False)

    def flag(node, why):
        out.append(f"{name}:{node.lineno}: {why}: {lines[node.lineno - 1].strip()}")
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and any(a.name == "*" for a in node.names):
            mod = node.module or ""
            if mod == "scrub" or mod.endswith(".scrub") or (node.level and mod == "") or mod == "harness":
                flag(node, "a star import from the scrub module")
            continue
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("getattr", "vars") \
                and node.args and _is_module(node.args[0], modules):
            flag(node, "the scrub module read by name")
            continue
        if isinstance(node, ast.Attribute) and node.attr == "__dict__" and _is_module(node.value, modules):
            flag(node, "the scrub module read by name")
            continue
        p = par.get(node)
        if _is_module(node, modules) and not isinstance(par.get(node), ast.Attribute):
            if not (isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)):
                flag(node, "the scrub module used other than for one of its attributes")
            continue
        if isinstance(node, (ast.Name, ast.Attribute)) and _target_of(node, names, modules) in PROTECTED:
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                continue
            if isinstance(p, ast.Call) and p.func is node:
                continue                                                       # a direct call
            if isinstance(p, ast.Attribute) and p.value is node and p.attr in ("template", "__name__"):
                continue                                                       # OwnerText.template(...)
            if isinstance(p, ast.Call) and isinstance(p.func, ast.Name) and p.func.id in ("isinstance", "issubclass") \
                    and node in p.args[1:]:
                continue
            if isinstance(p, ast.Tuple) and isinstance(par.get(p), ast.Call) \
                    and isinstance(par[p].func, ast.Name) and par[p].func.id in ("isinstance", "issubclass") \
                    and p in par[p].args[1:]:
                continue
            if isinstance(p, ast.Assign) and p.value is node and len(p.targets) == 1 \
                    and isinstance(p.targets[0], ast.Name):
                continue                                                       # x = scrub_owner: followed
            flag(node, "a protected name used other than by a direct call")
    return out


def _is_module(node, modules) -> bool:
    if isinstance(node, ast.Name):
        return node.id in modules and node.id != "harness"
    return isinstance(node, ast.Attribute) and node.attr == "scrub" and isinstance(node.value, ast.Name) \
        and node.value.id == "harness"


def sources(root=APP) -> dict:
    """Every Python file under the App's package, subpackages included, by its path there."""
    return {str(p.relative_to(root)): p.read_text(encoding="utf-8") for p in sorted(root.rglob("*.py"))}


def test_the_app_uses_no_access_form_the_scan_cant_follow():
    found = []
    for name, src in sources().items():
        found += access_scan(name, src)
    assert not found, "\n".join(found)


def test_the_owner_scan_reads_subpackages(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "deep.py").write_text("from ..scrub import OwnerText\nkeep(OwnerText(words))\n")
    (tmp_path / "top.py").write_text("x = 1\n")
    got = sources(tmp_path)
    assert "sub/deep.py" in got
    assert owner_scan("sub/deep.py", HEAD + got["sub/deep.py"], {"OwnerRefusal", "Refuse"})


def test_the_owner_scan_passes_the_app_with_subpackages():
    srcs = sources()
    refusals = owner_refusals({k.rsplit("/", 1)[-1]: v for k, v in srcs.items()})
    found = []
    for name, src in srcs.items():
        found += owner_scan(name.rsplit("/", 1)[-1], src, refusals)
    assert not found, "\n".join(found)


@pytest.mark.parametrize("body", [
    # attribute-style module access the scan can't follow
    "from . import scrub\nkeep(getattr(scrub, 'OwnerText')(words))\n",
    "from . import scrub\nkeep(vars(scrub)['scrub_owner'](text))\n",
    "from . import scrub\nkeep(scrub.__dict__['OwnerText'](words))\n",
    "import harness.scrub\nkeep(getattr(harness.scrub, 'scrub_owner')(text))\n",
    # the module rebound, or handed on
    "from . import scrub\ns2 = (scrub, 1)[0]\nkeep(s2.OwnerText(words))\n",
    "from . import scrub\nholder.mod = scrub\nkeep(holder.mod.scrub_owner(text))\n",
    "from . import scrub\nkeep(use(scrub))\n",
    # star imports
    "from .scrub import *\nkeep(OwnerText(words))\n",
    "from harness.scrub import *\nkeep(scrub_owner(text))\n",
    # tuple or attribute rebinding
    "from .scrub import scrub_owner\nclean, other = scrub_owner, None\nkeep(clean(text))\n",
    "from .scrub import OwnerText\nself.make = OwnerText\nkeep(self.make(words))\n",
    "from .scrub import scrub_owner\n(clean,) = (scrub_owner,)\nkeep(clean(text))\n",
    # a class (or the scrub) passed as an argument, or subclassed
    "from .scrub import OwnerText\nkeep(build(OwnerText, words))\n",
    "from .scrub import OwnerText\nimport functools\nmk = functools.partial(OwnerText, key=k)\nkeep(mk(words))\n",
    "from .scrub import scrub_owner\nkeep(list(map(scrub_owner, texts)))\n",
    "from .scrub import OwnerText\nclass Mine(OwnerText):\n    pass\n",
    "from .scrub import OwnerText\nmake = lambda: OwnerText\nkeep(make()(words))\n",
])
def test_the_access_scan_finds_these(body):
    assert access_scan("x.py", HEAD + body)


@pytest.mark.parametrize("body", [
    "from .scrub import OwnerText\nkeep(OwnerText.template('“{t}” moved', t=title))\n",
    "from .scrub import OwnerText\nok = isinstance(x, OwnerText)\n",
    "from .scrub import OwnerText, OwnerRefusal\nok = isinstance(x, (OwnerText, OwnerRefusal))\n",
    "from .scrub import scrub_owner as clean\ntry:\n    f()\nexcept Refuse as e:\n    keep(clean(e))\n",
    "from .scrub import scrub_owner\nlight = scrub_owner\ntry:\n    f()\nexcept Refuse as e:\n    keep(light(e))\n",
    "from . import scrub\nkeep(scrub.scrub(text))\nscrub.set_provider('x', None)\n",
    "import harness.scrub\nkeep(harness.scrub.scrub(text))\n",
])
def test_the_access_scan_passes_these(body):
    assert not access_scan("x.py", HEAD + body)


# -- 10. what he sees ----------------------------------------------------------------------------------------------

@pytest.mark.parametrize("words", [Controller.SETASIDE_CARD_WORDS, Controller.RELIST_ENDED_WORDS])
def test_these_cards_carry_no_id_sha_time_or_ask_to_send_again(words):
    assert not re.search(r"\b[0-9a-f]{7,40}\b", words)
    assert not re.search(r"\d{4}-\d{2}-\d{2}", words)
    assert not re.search(r"(?i)\bjob\b|\bid\b", words)
    assert not re.search(r"(?i)\b(send|tap|press|try)\b[^.]*\bagain\b", words)
    assert "check your calendar" not in words.lower()

