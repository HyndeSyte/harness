"""Canonical form. A tap approves bytes, not prose.

Every proposal's parameters are reduced to one canonical JSON string and
hashed. The card he sees is rendered from those parameters, the approval
binds that hash, and the executor re-hashes before it acts. If anything
changed in between -- a parameter, a normalization, a policy version --
the hashes disagree and nothing happens.
"""
from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Any


def _normalize(value: Any) -> Any:
    if isinstance(value, str):
        # NFC so that visually identical strings hash identically; a
        # decomposed "é" must not become a different approval.
        return unicodedata.normalize("NFC", value)
    if isinstance(value, bool) or value is None or isinstance(value, int):
        return value
    if isinstance(value, float):
        # 0.1 + 0.2 is not a thing a person can approve. Times, durations
        # and amounts are integers or strings, always.
        raise TypeError("floats are not canonical; use int or str")
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if not isinstance(k, str):
                raise TypeError("canonical keys must be strings")
            nk = unicodedata.normalize("NFC", k)
            if nk in out:
                raise ValueError(f"duplicate key after normalization: {nk!r}")
            out[nk] = _normalize(v)
        return out
    if isinstance(value, (list, tuple)):
        return [_normalize(v) for v in value]
    raise TypeError(f"not canonical: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(_normalize(value), sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False)


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
