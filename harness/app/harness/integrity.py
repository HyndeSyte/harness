"""Code and config integrity: the digest's "config unchanged since".

At start the controller hashes its own source files and its non-secret
configuration. If the hash matches the last run, the "unchanged since"
date carries over; if not, it resets to now and the change is logged, so
an update -- intended or not -- is always visible in the next digest.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from datetime import date
from pathlib import Path

from .ledger import Ledger, iso

PKG = Path(__file__).resolve().parent


def code_hash(root: Path = PKG) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*.py")):
        h.update(p.relative_to(root).as_posix().encode())
        h.update(b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def config_hash(config) -> str:
    def default(o):
        if isinstance(o, date):
            return o.isoformat()
        return str(o)
    return hashlib.sha256(json.dumps(asdict(config), sort_keys=True, default=default)
                          .encode()).hexdigest()


def check(ledger: Ledger, config, *, root: Path = PKG) -> tuple[str, bool]:
    """Returns (combined hash, changed?) and records it."""
    combined = hashlib.sha256((code_hash(root) + config_hash(config)).encode()).hexdigest()
    prev = ledger.get_meta("integrity_hash")
    changed = prev != combined
    with ledger.tx() as db:
        if changed:
            ledger.set_meta("integrity_hash", combined, db)
            ledger.set_meta("integrity_since", iso(ledger.now()), db)
            ledger.event("integrity_changed", {"from": (prev or "")[:12], "to": combined[:12]},
                         db=db)
    return combined, changed
