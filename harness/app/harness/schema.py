"""What a model is allowed to say back. Anything else fails closed.

A model returns exactly one JSON object of one of five shapes. Unknown
keys anywhere at the top level are a refusal of the whole output, not a
field to ignore: a model that writes `"approved": true`, a chat id, a
button, a URL to tap or a recipient is either confused or injected, and
neither should be half-trusted.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from . import effects

SHAPES: dict[str, dict[str, tuple[type, int]]] = {
    # key -> (type, max length)
    "answer": {"text": (str, 3500)},
    "proposal": {"effect_type": (str, 64), "params": (dict, 0), "summary": (str, 300)},
    "rule": {"rule": (dict, 0), "confirm": (str, 300)},
    "clarify": {"question": (str, 500)},
    "no_action": {"reason": (str, 300)},
}


class OutputError(ValueError):
    pass


@dataclass(frozen=True)
class ModelOutput:
    type: str
    body: dict


def parse_output(raw: str | dict, *, stage_at_least: Callable[[str], bool]) -> ModelOutput:
    if isinstance(raw, str):
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise OutputError("not JSON") from exc
    else:
        obj = raw
    if not isinstance(obj, dict):
        raise OutputError("not an object")
    kind = obj.get("type")
    if kind not in SHAPES:
        raise OutputError(f"unknown output type {kind!r}")
    shape = SHAPES[kind]
    extra = set(obj) - set(shape) - {"type"}
    if extra:
        raise OutputError(f"unexpected keys: {sorted(extra)}")
    body: dict[str, Any] = {}
    for key, (typ, max_len) in shape.items():
        if key not in obj:
            raise OutputError(f"missing {key}")
        val = obj[key]
        if not isinstance(val, typ) or isinstance(val, bool) and typ is not bool:
            raise OutputError(f"{key}: wrong type")
        if typ is str:
            if not val.strip():
                raise OutputError(f"{key}: empty")
            if max_len and len(val) > max_len:
                raise OutputError(f"{key}: too long")
        body[key] = val
    if kind == "proposal":
        try:
            d = effects.lookup(body["effect_type"], stage_at_least)
            body["params"] = d.validate(body["params"])
        except effects.ParamError as exc:
            raise OutputError(str(exc)) from exc
    return ModelOutput(kind, body)
