"""What he sees keeps to his standards (R-004): plain words, no em dash, Apps not add-ons,
nothing hidden behind a count, no machine ids, no button named that the message lacks, no
upkeep asks that the 30-minute line doesn't cover, and no chore handed to him: nothing asks him
to check something, send it again or report back (conftest.ASK, a rule of Python's own; its
short allowlist, each entry with its reason, is conftest.ASK_ALLOWED).

Two halves, so neither a template nor a message slips through:
  * static: every string literal in harness/app/harness, read with Python's ast (docstrings,
    logging calls, regular expressions, raised errors and the model's own prompts left out),
    each f-string with its values standing in as "3". A short allowlist below, each entry with
    its reason. A failure names the file and line.
  * dynamic: tests/conftest.py checks every message any test sends, as he'd see it.
The rules are Cain's (cain/rootfs/opt/cain/gate/rules.ts), ported in tests/message_rules.py and
kept equal by the shared cases in cain/tests/gate-cases.json, run here and by bun.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

import message_rules
from conftest import ASK_ALLOWED, asks_in, labels_of, rule_problems

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "harness" / "app" / "harness"
CASES = ROOT / "cain" / "tests" / "gate-cases.json"

LOG_NAMES = {"log", "logging", "logger"}
LOG_CALLS = {"debug", "info", "warning", "warn", "error", "exception", "critical"}
PROMPT_NAME = re.compile(r"(?i)system|prompt|instruction|schema")
RESTART_ASK = re.compile(r"(?i)\brestart(?:ing)?\s+(?:it|cain|harness|the|your|him|this|that|home)\b")
APP_WORD = re.compile(r"(?i)\badd[\\-]*ons?\b")
MACHINE_VALUE = re.compile(r"(?i)\b(?:job|http|uid|nonce)\s*\{\}")

# (file, words in the literal, why it may stay). Kept short: each one is a decision.
ALLOWED = [
    ("drive.py", "addon", "the HTTP User-Agent to OpenStreetMap: a header, never a message"),
    ("watch.py", "Restarting it should bring it back: Settings > Apps > Cain > Restart.",
     "the 30-minute line: sent once, only while Cain is still down, with the exact path"),
    ("watch.py", "Restarting Cain should bring it back: Settings > Apps > Cain > Restart.",
     "the 30-minute line, when Cain's Discord connection is the part that's down"),
    ("calendar_change.py", "restart Harness, then turn it on again",
     "his own step to allow changes again after a reset, on purpose (/checkadds)"),
    ("calendar_change.py", "restart Harness, then turn it on to allow them again",
     "the same reset step, on the status line"),
    ("inputs.py", "Restarting the Pi usually sets its clock right",
     "the fix for a wrong clock, sent only when only he can fix it, with the exact path"),
    ("meaning.py", " more)", "the shadow score's log lines, which stay on the Pi"),
    ("mail_dates.py", "UID ", "an IMAP command to the mail server, never a message"),
]


def _strings(tree: ast.AST):
    """(line, text) for each literal he might see; an f-string's values stand in as "{}"."""
    skip: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                skip.add(id(body[0].value))                         # a docstring
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and (
                    (isinstance(f.value, ast.Name) and f.value.id in LOG_NAMES and f.attr in LOG_CALLS)
                    or (isinstance(f.value, ast.Name) and f.value.id == "re")):
                for sub in ast.walk(node):                           # a log line or a pattern
                    skip.add(id(sub))
        if isinstance(node, ast.Raise):
            for sub in ast.walk(node):                               # an error, for the log
                skip.add(id(sub))
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(t, ast.Name) and PROMPT_NAME.search(t.id) for t in targets):
                for sub in ast.walk(node):                           # the model's prompt
                    skip.add(id(sub))
    for node in ast.walk(tree):
        if id(node) in skip:
            continue
        if isinstance(node, ast.JoinedStr):
            text = "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in node.values)
            for v in node.values:
                skip.add(id(v))
            yield node.lineno, text
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            yield node.lineno, node.value


def _allowed(name: str, text: str) -> bool:
    return any(name == f and words in text for f, words, _ in ALLOWED)


def problems_in(name: str, source: str) -> list[str]:
    out = []
    for line, text in _strings(ast.parse(source)):
        if _allowed(name, text):
            continue
        shown = text.replace("{}", "3")
        found = []
        if "—" in text:
            found.append("an em dash")
        if APP_WORD.search(text):
            found.append('"add-on" (they\'re Apps)')
        if message_rules.check(shown, rules=("count",)).hits:
            found.append("a hidden count")
        if message_rules.check(shown, rules=("machine",)).hits or MACHINE_VALUE.search(text):
            found.append("a machine id")
        if RESTART_ASK.search(text):
            found.append("a restart ask")
        if asks_in(text):
            found.append("a check, resend or report-back ask")
        out += [f"{name}:{line}: {what}: {text[:80]!r}" for what in found]
    return out


def test_no_template_he_sees_breaks_his_standards():
    found = []
    for path in sorted(APP.glob("*.py")):
        if path.name == "prompts.py":          # the model's own instructions, never shown to him
            continue
        found += problems_in(path.name, path.read_text(encoding="utf-8"))
    assert not found, "\n".join(found)


def test_every_allowed_literal_is_still_there_and_has_its_reason():
    for name, words, why in ALLOWED:
        texts = [text for _, text in _strings(ast.parse((APP / name).read_text(encoding="utf-8")))]
        assert why and any(words in text for text in texts), (name, words)
    every = [text for path in sorted(APP.glob("*.py"))
             for _, text in _strings(ast.parse(path.read_text(encoding="utf-8")))]
    for words, why in ASK_ALLOWED:
        assert why and any(words in text for text in every), words


@pytest.mark.parametrize("source, what", [
    ('x = "Moved it — done."', "an em dash"),
    ('x = "Restart the add-on."', '"add-on"'),
    ('x = f"{n} more changes wait for tomorrow"', "a hidden count"),
    ('x = f"Lunch and {n} more"', "a hidden count"),
    ('x = f"<i>job {short(job_id)}</i>"', "a machine id"),
    ('x = f"iCloud answered HTTP {out.status}."', "a machine id"),
    ('x = "If it doesn\'t come back, restart Cain in Home Assistant."', "a restart ask"),
    ('x = "It may or may not have gone through. Check the calendar."', "a check"),
    ('x = "I don\'t know whether that was added. Check the Family calendar."', "a check"),
    ('x = "Something I can\'t read, so check that nothing else keeps going."', "a check"),
    ('x = "Nothing was done. Send it again to retry."', "resend"),
    ('x = "Send /resume, then resend it"', "resend"),
    ('x = "Turn me back on, then ask again"', "resend"),
    ('x = "Say it again without that."', "resend"),
    ('x = "Let me know if it shows up."', "report-back"),
    ('x = "Tell me if the block is there."', "report-back"),
    ('x = "Look, then report back."', "report-back"),
])
def test_the_scan_finds_each_kind(source, what):
    assert any(what in p for p in problems_in("x.py", source)), source


@pytest.mark.parametrize("words", [
    "I won't ask again.", "before I'd ask again.", "I'll try again at the next read.",
    "Undo tries what's left again.", "I couldn't read the calendar just now, so nothing changed.",
    "⚠ Check before approving: it ends Piano.", "I couldn't confirm yet whether PT changed; I'm still checking.",
])
def test_its_own_words_about_itself_are_not_asks(words):
    assert asks_in(words) == [], words


def test_the_scan_leaves_logs_patterns_docstrings_and_prompts_alone():
    source = '\n'.join([
        '"""A docstring may say add-on and 3 more."""',
        'log.info("the add-on restarted — job %s", 1)',
        'X = re.compile(r"[—–]")',
        'SYSTEM = "You read the add-on\'s mail and 3 more items."',
        'def f():',
        '    """Restart the add-on."""',
        '    raise ValueError(f"job {job_id}: bad")',
    ])
    assert problems_in("x.py", source) == []


# -- tap replies say what will happen (section 7) ------------------------------------------------
# What every choice tap can get back, by module and function (callbacks.py routes them). None may
# say a calendar is already so: that's for the receipt, once a read finds it.
TAP_REPLIES = {"callbacks.py": ("handle", "_apply_choice"), "meaning_live.py": ("on_choice", "_answer", "_undo"),
               "family_add.py": ("on_choice",), "mail_dates.py": ("on_choice",),
               "calendar_change.py": ("on_choice",), "places.py": ("on_choice",)}
DONE_CLAIM = re.compile(r"(?i)\b(?:is|are|stays?)\s+(?:now\s+)?(?:on|off)\s+(?:your|the)\b"
                        r"|\b(?:added|moved|removed|undone|taken off)\s+(?:it\s+)?(?:to|from|on|off)\s+your\b")


def tap_replies() -> list[tuple[str, int, str]]:
    out = []
    for name, funcs in TAP_REPLIES.items():
        tree = ast.parse((APP / name).read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name in funcs:
                out += [(name, line, text) for line, text in _strings(fn)]
    return out


def test_no_reply_to_a_tap_says_a_calendar_is_already_so():
    replies = tap_replies()
    assert any("I'll put" in text for _, _, text in replies)           # the scan reads the replies
    found = [f"{name}:{line}: {text!r}" for name, line, text in replies if DONE_CLAIM.search(text)]
    assert not found, "\n".join(found)


def test_the_done_claim_check_catches_one():
    assert DONE_CLAIM.search("Thanks. Swim is on your calendar as yours.")
    assert DONE_CLAIM.search("Thanks. Swim stays off your calendar.")
    assert not DONE_CLAIM.search("Thanks. I'll put Swim on your calendar as yours.")
    assert not DONE_CLAIM.search("Taking it off your Gmail, just this once.")


# -- the rules, equal on both sides ------------------------------------------------------------

def cases():
    return json.loads(CASES.read_text(encoding="utf-8"))


def test_the_port_has_the_same_labels_as_cains_rules():
    assert list(message_rules.STATIC_LABELS) == cases()["static_labels"]
    rules_ts = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "gate" / "rules.ts").read_text(encoding="utf-8")
    for label in message_rules.STATIC_LABELS:
        assert f'"{label}"' in rules_ts, label


def test_a_link_in_an_excerpt_is_its_scheme_and_host_alone():
    """No user name, password, port, path, query or fragment, nothing after the host at all; one
    that can't be read is "a link" (rules.ts linkHost, gate.test.ts)."""
    cut = "https://example.com/\u2026"
    assert message_rules.link_host("https://user:secret@example.com/private?key=abc") == cut
    assert message_rules.link_host("https://a@b@Example.COM:8443/x#frag") == cut
    assert message_rules.link_host("http://example.com") == "http://example.com"
    assert message_rules.link_host("https://[::1]:80/x") == "https://[::1]/\u2026"
    # A browser reads a backslash as "/": the authority ends there, and what follows is path.
    assert message_rules.link_host("https://public.example\\@secret-token/private") == "https://public.example/\u2026"
    assert message_rules.link_host("https://h\\SECRET") == "https://h/\u2026"
    for bad in ("https://", "https://user:secret@", "https://exa%mple.com/x", "https://b\xfccher.example/x",
                "https://example.com:port/x", "https://example.com,", "https://\\SECRET@example.com/x"):
        assert message_rules.link_host(bad) == "a link", bad
    for tail in ("__", "~~", "!!", '"x"', "'x'", "[x]", "x)", "x.", "x,"):
        assert message_rules.link_host("https://example.com/private?token=" + tail) == cut, tail
    assert message_rules.hosts_only("See https://user:p(ss)@example.com/private?key=abc now.") == "See " + cut + " now."
    assert message_rules.hosts_only("See https://en.wikipedia.org/wiki/Foo_(bar)?token=X now.") == "See https://en.wikipedia.org/\u2026 now."
    assert message_rules.hosts_only("See HTTPS://user:pw@Host.example/x?key=1 now.") == "See https://host.example/\u2026 now."
    for text, whole in (("Call https://user:secret@example.com:8443/reset?token=abc today.", cut + " today."),
                        ("Call HTTPS://user:p(se)cret@example.com:8443/reset?token=abc__ today.", cut + " to")):
        for start in range(len(text)):
            for stop in (start + 1, start + 9, len(text)):
                assert not re.search(r"user|secret|se\)|8443|reset|token|abc", message_rules.hosts_only(text, start, stop))
        assert message_rules.around(text, 30, 40) == whole
    # Any scheme, or none ("www.", a domain with a path), to a space or a line break alone.
    for text, whole in (("See https://example.com/cb?next=<SECRET> now.", "See " + cut + " now."),
                        ("Open wss://h.example/x?token=SECRET now.", "Open wss://h.example/… now."),
                        ("Open www.example.com/reset?token=SECRET now.", "Open www.example.com/… now."),
                        ("Open example.com/reset?token=SECRET now.", "Open example.com/… now."),
                        ("Open b\xfccher.example/x?token=SECRET now.", "Open a link now."),
                        ("Lanes 1.5/2 and 4:30/5:00 now.", "Lanes 1.5/2 and 4:30/5:00 now.")):
        assert message_rules.hosts_only(text) == whole, text
        assert message_rules.around(text, 0, len(text)) == whole, text


def test_the_port_reads_javascripts_spaces():
    """JavaScript's \\s takes U+00A0, U+202F and the other Unicode spaces even without the u flag; next to
    a dash, any of them but a new line goes with it, leaving one ordinary space."""
    assert message_rules.check("6\u202fPM \u2014 8\u202fPM").rules("refuse") == ["dash"]
    assert message_rules.check("Away 2026\u202f\u2014\u202f2027.").rules("refuse") == ["dash"]
    assert message_rules.check("Moved swim\xa0\u2014\xa0it's at 4:30.").fixed == "Moved swim, it's at 4:30."
    assert message_rules.check("Two blocks and\xa03 more.").rules("refuse") == ["count"]
    assert message_rules.check("Two blocks and\u200b3 more.").hits == []      # U+200B isn't a space in either
    assert message_rules.around("\x85a\ufeff", 1, 2) == "\x85a"                 # trim() keeps U+0085, takes U+FEFF


def test_the_port_keeps_a_dash_beside_the_same_words():
    """The words that keep a dash in words never refused are the same list on both sides."""
    assert list(message_rules.DASH_WORDS) == cases()["dash_words"]
    assert len(set(message_rules.DASH_WORDS)) == len(message_rules.DASH_WORDS)
    rules_ts = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "gate" / "rules.ts").read_text(encoding="utf-8")
    for word in message_rules.DASH_WORDS:
        assert json.dumps(word, ensure_ascii=True) in rules_ts, word


def test_cains_em_dashes_are_refused_and_the_others_kept_or_fixed():
    """refusable=True (Cain's words): every em dash refused, none fixed. Otherwise a dash becomes ", "
    only between plain words, two on each side, and any other stays, flagged (rules.ts, gate.test.ts)."""
    for text in ("Swim is **5** \u2014 **6 PM**.", "Swim takes 30 min \u2014 1 hr.", "Week 1 \u2014 Week 3 are booked.",
                 "Moved swim \u2014 it's at 4:30 now."):
        r = message_rules.check(text, refusable=True)
        assert [(h.rule, h.result, h.kept) for h in r.hits] == [("dash", "refuse", "")] and r.fixed == text, text
    assert [h.kept for h in message_rules.check("Swim is **5** \u2014 **6 PM**.").hits] == ["range"]
    assert [h.kept for h in message_rules.check("See https://example.com/a \u2014 then reply.").hits] == ["link"]
    assert message_rules.check("We march \u2014 all of us together.").fixed == "We march, all of us together."
    for text in ("We march \u2014 5 of us.", "Moved \u2014 swim starts now.", "Open all morning \u2014 until we close.",
                 "Rooms A \u2014 C are free.", "Done, \u2014 nothing else."):
        assert [(h.result, h.kept) for h in message_rules.check(text).hits] == [("refuse", "range")], text
    assert message_rules.check("Restarted the add-on \u2014 all set.", refusable=True).fixed == "Restarted the App \u2014 all set."


@pytest.mark.parametrize("case", cases()["cases"], ids=lambda c: c["name"])
def test_each_shared_case(case):
    ctx = case.get("context", {})
    r = message_rules.check(case["text"], rules=ctx.get("rules"),
                            buttons=ctx["buttons"] if "buttons" in ctx else (),
                            known=ctx.get("known", ()), answers_him=ctx.get("answers_him", False),
                            refusable=ctx.get("refusable", False))
    assert {k: r.rules(k) for k in ("fix", "refuse", "unsure")} == \
        {k: sorted(case.get(k, [])) for k in ("fix", "refuse", "unsure")}
    assert r.fixed == case.get("fixed", case["text"])
    assert all(len(h.around) <= 60 for h in r.hits)
    if "around" in case:
        assert [h.around for h in r.hits] == case["around"]


# -- the dynamic half's own checks ---------------------------------------------------------------

def test_the_check_reads_both_shapes_of_buttons():
    assert labels_of([[("Undo", "c:1"), ("Stop", "k:stop")]]) == ["Undo", "Stop"]
    assert labels_of([{"type": 1, "components": [{"type": 2, "label": "Undo", "custom_id": "k:c:1"}]}]) == ["Undo"]
    assert rule_problems("card", "Tap Undo if it's wrong.", ["Undo"]) == []
    assert rule_problems("card", "Tap Undo if it's wrong.", ["Stop"])


@pytest.mark.raw_words
def test_a_message_that_breaks_a_rule_fails_the_test_that_sent_it(request):
    """The fixture's own check, run here by hand: a card naming a button it lacks."""
    from harness.discord_chat import LinkChat, to_markdown
    sent = []

    class Link:
        def card(self, text, rows, kind, expires=None):
            sent.append((text, rows))
            return 1

    chat = LinkChat(Link())
    chat.send_message(1, "Moved swim — tap Undo if it's wrong.", None)
    text, rows = sent[0]
    found = rule_problems("card", text, labels_of(rows))
    assert any("button" in f and "Undo" in f for f in found) and any("dash" in f for f in found)
    assert to_markdown("<b>x</b>") == "**x**"


# -- the asks D left: each one gone from every message (0.23.0) ---------------------------------
OLD_ASKS = ("Check the calendar", "check the calendar", "Check the Family calendar", "check the Family",
            "Send it again", "send it again", "resend", "ask again", "I won't retry", "Say it again",
            "check that nothing else", "Check your Gmail calendar", "Check the address",
            "reload and try again", "tap Undo again", "tap that card again")


def test_nothing_emits_the_old_asks():
    found = []
    for path in sorted(APP.glob("*.py")):
        for line, text in _strings(ast.parse(path.read_text(encoding="utf-8"))):
            found += [f"{path.name}:{line}: {old!r}" for old in OLD_ASKS
                      if old in text and old not in ("ask again",)]
            if "ask again" in text and asks_in(text):
                found.append(f"{path.name}:{line}: 'ask again'")
    assert not found, "\n".join(found)


def test_the_discord_words_hold_no_resend_and_only_what_something_says():
    from harness import discord_chat
    every = [text for path in sorted(APP.glob("*.py")) if path.name != "discord_chat.py"
             for _, text in _strings(ast.parse(path.read_text(encoding="utf-8")))]
    for old, new in discord_chat.WORDS:
        assert not asks_in(new), new
        assert any(old in text for text in every), f"nothing says {old!r} any more"
