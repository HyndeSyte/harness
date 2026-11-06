"""What a Family event means for him, by its name, as he says it.

"Pat dentist means I watch the kids" is a rule: every Family event whose title has those
words gets a block on Gmail, and from there one at work. Four kinds, and nothing else:

  * me: his own commitment. "Busy (family)" on Gmail, unless Gmail already has him busy then.
  * kids: the other parent is away, so he has the kids. "Busy (watching kids)".
  * school: a program day. Drop-off and pickup runs, from the event's own days and hours.
  * none: it doesn't tie him up. Nothing on Gmail, and no more asking about it.

A rule goes by words, not the exact title, so emoji and a child's name in front don't matter.
When several fit, the one with the most words wins: "School Day" and "School Day Pictures"
can both be rules. Two with as many words that disagree give the busier kind. The add-on's older title settings still count, under any rule he says.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .ledger import Ledger, iso

KINDS = ("kids", "me", "school", "none")      # busiest first
TITLES = {"me": "Busy (family)", "kids": "Busy (watching kids)"}
MAX_RULES = 60
_WORD = re.compile(r"[^\W_]+")


def words(text: str) -> frozenset[str]:
    """Single letters don't count, so "Pat's dentist" is "Pat dentist"."""
    return frozenset(w.casefold() for w in _WORD.findall(text or "") if len(w) > 1)


@dataclass(frozen=True)
class Rule:
    said: str
    kind: str

    @property
    def words(self) -> frozenset[str]:
        return words(self.said)


def load(ledger: Ledger) -> tuple[Rule, ...]:
    rows = ledger.db.execute("SELECT said, kind FROM family_rules ORDER BY said").fetchall()
    return tuple(Rule(r["said"], r["kind"]) for r in rows if r["kind"] in KINDS and words(r["said"]))


def pick(title: str, rules: tuple[Rule, ...]) -> Rule | None:
    """The rule for this title: the one with the most of its words."""
    have = words(title)
    fits = [r for r in rules if r.words and r.words <= have]
    if not fits:
        return None
    most = max(len(r.words) for r in fits)
    best = [r for r in fits if len(r.words) == most]
    # Two that disagree: the busier one. A block too many only shows him busy.
    return min(best, key=lambda r: KINDS.index(r.kind))


def find(ledger: Ledger, said: str) -> Rule | None:
    """The stored rule for the same words, however he wrote them this time."""
    want = words(said)
    return next((r for r in load(ledger) if r.words == want), None)


def put(ledger: Ledger, said: str, kind: str | None, db) -> None:
    """Set, change or (kind None) drop the rule for these words."""
    want = words(said)
    for r in db.execute("SELECT said FROM family_rules").fetchall():
        if words(r["said"]) == want:
            db.execute("DELETE FROM family_rules WHERE said=?", (r["said"],))
    if kind is not None:
        db.execute("INSERT INTO family_rules(said, kind, created_at) VALUES(?,?,?)",
                   (said.strip(), kind, iso(ledger.now())))


def room(ledger: Ledger, said: str, kind: str) -> bool:
    """Saying something means nothing is how he stops being asked, so those don't count."""
    return kind == "none" or find(ledger, said) is not None \
        or sum(r.kind != "none" for r in load(ledger)) < MAX_RULES


ASKED = "family_rules_asked"
MAX_ASKED_KEPT = 500


def asked(ledger: Ledger) -> set[str]:
    raw = ledger.get_meta(ASKED) or ""
    return set(x for x in raw.split("\n") if x)


def mark_asked(ledger: Ledger, titles: list[str]) -> None:
    """Each title is asked about once. Newest kept when the list is long."""
    keys = [" ".join(sorted(words(t))) for t in titles]
    old = [x for x in (ledger.get_meta(ASKED) or "").split("\n") if x and x not in keys]
    with ledger.tx() as db:
        ledger.set_meta(ASKED, "\n".join((old + keys)[-MAX_ASKED_KEPT:]), db)
