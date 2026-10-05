"""Effects: the only things the harness can ever do to the world.

Default-deny. An effect type that is not defined here does not exist,
whatever a model writes. The model supplies only `effect_type` and the
small set of parameters a definition declares; everything that decides
safety -- reversibility, preconditions, expiry, the resource it may
touch, whether a second model must review it, how to undo it, and what
happens if the remote call succeeded but the Pi died before recording
it -- is fixed here, in code, and versioned with the policy.

v1.4 staging: S0 and S1 have no live effects. The first, a private hold
on the calendar the harness itself created, unlocks at S2.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable


class ParamError(ValueError):
    pass


@dataclass(frozen=True)
class Param:
    kind: str                                # "datetime" | "int" | "str"
    required: bool = True
    minimum: int | None = None
    maximum: int | None = None
    max_len: int | None = None
    pattern: str | None = None

    def check(self, name: str, value: Any) -> Any:
        if self.kind == "int":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ParamError(f"{name}: integer required")
            if self.minimum is not None and value < self.minimum:
                raise ParamError(f"{name}: below {self.minimum}")
            if self.maximum is not None and value > self.maximum:
                raise ParamError(f"{name}: above {self.maximum}")
            return value
        if self.kind == "str":
            if not isinstance(value, str):
                raise ParamError(f"{name}: string required")
            if self.max_len is not None and len(value) > self.max_len:
                raise ParamError(f"{name}: longer than {self.max_len}")
            if self.pattern and not re.fullmatch(self.pattern, value):
                raise ParamError(f"{name}: wrong format")
            return value
        if self.kind == "datetime":
            if not isinstance(value, str):
                raise ParamError(f"{name}: ISO datetime string required")
            try:
                dt = datetime.fromisoformat(value)
            except ValueError as exc:
                raise ParamError(f"{name}: not an ISO datetime") from exc
            if dt.tzinfo is None:
                # A time without a zone is two different times on a
                # travel week. Refused rather than guessed.
                raise ParamError(f"{name}: timezone required")
            return value
        raise ParamError(f"{name}: unknown param kind {self.kind}")


@dataclass(frozen=True)
class EffectDef:
    name: str
    min_stage: str
    reversible: bool
    ttl_s: int
    reviewer_required: bool
    params: dict[str, Param]
    # Fixed by the controller, never by the model:
    fixed: dict[str, Any] = field(default_factory=dict)
    undo: str = ""
    idempotency: str = ""
    preconditions: tuple[Callable[[dict], str | None], ...] = ()

    def validate(self, params: Any) -> dict:
        if not isinstance(params, dict):
            raise ParamError("params must be an object")
        unknown = set(params) - set(self.params)
        if unknown:
            # A model that tries to set the calendar, the title, the
            # attendees or anything else not declared here is refused
            # whole, not trimmed.
            raise ParamError(f"undeclared params: {sorted(unknown)}")
        out = {}
        for name, spec in self.params.items():
            if name not in params:
                if spec.required:
                    raise ParamError(f"{name}: required")
                continue
            out[name] = spec.check(name, params[name])
        return out


def _future(params: dict) -> str | None:
    # Evaluated by the executor against its own clock at execution time.
    return None


REGISTRY: dict[str, EffectDef] = {
    "calendar_hold": EffectDef(
        name="calendar_hold",
        min_stage="S2",
        reversible=True,
        ttl_s=12 * 3600,
        reviewer_required=False,
        params={
            "start": Param("datetime"),
            "duration_min": Param("int", minimum=15, maximum=480),
        },
        # The model never chooses where or what: one calendar the harness
        # created (scope calendar.app.created makes Google enforce it), a
        # non-sensitive title, no attendees, no recurrence.
        fixed={"calendar": "harness-created", "title": "Reserved",
               "attendees": (), "recurrence": ()},
        undo="delete the event by its id within 24 h",
        idempotency=("event id derived from the effect id; before any retry, "
                     "look the event up by id; a re-create after an undo gets "
                     "a new id because deleted ids leave a tombstone"),
    ),
}


def lookup(effect_type: str, stage_at_least: Callable[[str], bool]) -> EffectDef:
    d = REGISTRY.get(effect_type)
    if d is None:
        raise ParamError(f"unknown effect type {effect_type!r}")
    if not stage_at_least(d.min_stage):
        raise ParamError(f"{effect_type} is not enabled before {d.min_stage}")
    return d
