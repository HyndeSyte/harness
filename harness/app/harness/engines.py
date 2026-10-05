"""Engines: Claude and GPT behind one contract. They read, they answer.

An engine gets a system prompt, his message and the JSON schema of what
it may say back, and returns one JSON object or an error. It holds no
credential beyond the API key used for its own call, touches no state,
and never decides what happens next -- the runner and the controller do.

Provider facts (verified 2026-10-05):
  Anthropic  POST /v1/messages, anthropic-version 2023-06-01; structured
             output via output_config.format (GA, no beta header);
             Sonnet 5.5 thinks by default (adaptive, effort high), and
             thinking counts toward max_tokens; refusals arrive as HTTP 200
             with stop_reason "refusal" and are billed; low credit has been
             reported as 400 or 402.
  OpenAI     POST /v1/responses with store:false; text.format json_schema
             strict; reasoning.effort floor for gpt-6.1-sol is "low";
             max_output_tokens includes reasoning, and hitting it yields
             status "incomplete"; out-of-credit is 429 with code
             credit_balance_exhausted (older: insufficient_quota).
  Both       GET /v1/models/{id} answers 404 for a model that doesn't exist.

Prepaid balances are not an instant cutoff (OpenAI says so in writing), so
spend is counted here from each response's usage and the budget is
enforced by the runner before any call.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable, Protocol

from . import policy
from .net import REDACT, Transport, TransportError


@dataclass(frozen=True)
class EngineResult:
    status: str                 # "ok" | "refused" | "incomplete" | "bad_output"
    output: dict | None
    engine: str
    model: str
    input_tokens: int
    output_tokens: int
    usd: float
    detail: str = ""


class EngineError(Exception):
    """No billed answer came back. `kind` is "retryable" or "fatal";
    `reason` is a short machine word for receipts and the digest."""

    def __init__(self, kind: str, reason: str, message: str = "", *,
                 retry_after: float | None = None, status: int | None = None):
        self.kind = kind
        self.reason = reason
        self.retry_after = retry_after
        self.status = status
        super().__init__(REDACT(f"{reason}: {message}" if message else reason)[:300])

    @property
    def retryable(self) -> bool:
        return self.kind == "retryable"


class Engine(Protocol):
    name: str

    def complete(self, *, system: str, user: str, schema: dict) -> EngineResult: ...

    def check_model(self) -> str: ...      # "ok" | "missing" | "unknown"


def _retry_after(headers: dict) -> float | None:
    v = headers.get("retry-after")
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def _error_body(raw: bytes) -> dict:
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {}
    err = data.get("error") if isinstance(data, dict) else None
    return err if isinstance(err, dict) else {}


def _unwrap(text: str) -> dict | None:
    """The schema wraps the answer as {"output": {...}} so both providers
    accept it (OpenAI's strict mode does not allow a union at the root)."""
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(obj, dict) or set(obj) != {"output"} or not isinstance(obj["output"], dict):
        return None
    return obj["output"]


class AnthropicEngine:
    VERSION = "2023-06-01"

    def __init__(self, spec: policy.ModelSpec, key_fn: Callable[[], str],
                 transport: Transport, *, base: str = "https://api.anthropic.com",
                 effort: str = "high"):
        self.name = spec.engine
        self.spec = spec
        self._key_fn = key_fn
        self._t = transport
        self._base = base.rstrip("/")
        self._effort = effort

    def _headers(self) -> dict:
        key = self._key_fn()
        if not key:
            raise EngineError("fatal", "no_key", "no Anthropic API key set")
        REDACT.register(key)
        return {"x-api-key": key, "anthropic-version": self.VERSION,
                "content-type": "application/json"}

    def cost(self, usage: dict) -> float:
        s = self.spec
        i = int(usage.get("input_tokens") or 0)
        o = int(usage.get("output_tokens") or 0)
        cw = int(usage.get("cache_creation_input_tokens") or 0)
        cr = int(usage.get("cache_read_input_tokens") or 0)
        return (i * s.usd_in_per_mtok + o * s.usd_out_per_mtok
                + cw * s.usd_in_per_mtok * 1.25 + cr * s.usd_in_per_mtok * 0.1) / 1e6

    def complete(self, *, system: str, user: str, schema: dict) -> EngineResult:
        body = {
            "model": self.spec.model,
            "max_tokens": self.spec.max_output_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "output_config": {"effort": self._effort,
                              "format": {"type": "json_schema", "schema": schema}},
        }
        try:
            resp = self._t.request("POST", f"{self._base}/v1/messages",
                                   headers=self._headers(), json_body=body,
                                   timeout=policy.HTTP_TIMEOUT_S)
        except TransportError as e:
            raise EngineError("retryable", e.kind, str(e)) from None
        if resp.status != 200:
            raise self._error(resp)
        try:
            data = resp.json()
        except Exception:
            raise EngineError("retryable", "bad_json", "unparseable 200 reply") from None
        usage = data.get("usage") or {}
        res = dict(engine=self.name, model=str(data.get("model") or self.spec.model),
                   input_tokens=int(usage.get("input_tokens") or 0)
                   + int(usage.get("cache_creation_input_tokens") or 0)
                   + int(usage.get("cache_read_input_tokens") or 0),
                   output_tokens=int(usage.get("output_tokens") or 0),
                   usd=self.cost(usage))
        stop = data.get("stop_reason")
        if stop == "refusal":
            return EngineResult("refused", None, detail="model refused", **res)
        if stop in ("max_tokens", "model_context_window_exceeded"):
            return EngineResult("incomplete", None, detail=str(stop), **res)
        if stop not in ("end_turn", "stop_sequence"):
            return EngineResult("bad_output", None, detail=f"stop_reason {stop}", **res)
        text = next((b.get("text") for b in data.get("content") or []
                     if isinstance(b, dict) and b.get("type") == "text"), None)
        out = _unwrap(text) if text is not None else None
        if out is None:
            return EngineResult("bad_output", None, detail="no JSON object", **res)
        return EngineResult("ok", out, **res)

    def _error(self, resp) -> EngineError:
        err = _error_body(resp.body)
        etype = str(err.get("type", ""))
        msg = str(err.get("message", ""))[:200]
        details = err.get("details") if isinstance(err.get("details"), dict) else {}
        st = resp.status
        if st == 429:
            if details.get("error_code") == "enforced_spend_limit_reached":
                return EngineError("fatal", "spend_limit", msg, status=st)
            return EngineError("retryable", "rate_limited", msg,
                               retry_after=_retry_after(resp.headers), status=st)
        if st in (500, 502, 503, 504, 529):
            return EngineError("retryable", "overloaded" if st == 529 else "server_error",
                               msg, retry_after=_retry_after(resp.headers), status=st)
        if st == 402 or etype == "billing_error" or "credit balance" in msg.lower():
            return EngineError("fatal", "billing", msg, status=st)
        if st == 401:
            return EngineError("fatal", "auth", msg, status=st)
        if st == 404:
            return EngineError("fatal", "model_missing", msg, status=st)
        return EngineError("fatal", f"http_{st}", msg, status=st)

    def check_model(self) -> str:
        try:
            resp = self._t.request("GET", f"{self._base}/v1/models/{self.spec.model}",
                                   headers=self._headers(), timeout=30)
        except Exception:
            return "unknown"
        return {200: "ok", 404: "missing"}.get(resp.status, "unknown")


class OpenAIEngine:
    def __init__(self, spec: policy.ModelSpec, key_fn: Callable[[], str],
                 transport: Transport, *, base: str = "https://api.openai.com",
                 effort: str = "low"):
        self.name = spec.engine
        self.spec = spec
        self._key_fn = key_fn
        self._t = transport
        self._base = base.rstrip("/")
        self._effort = effort

    def _headers(self) -> dict:
        key = self._key_fn()
        if not key:
            raise EngineError("fatal", "no_key", "no OpenAI API key set")
        REDACT.register(key)
        return {"authorization": f"Bearer {key}", "content-type": "application/json"}

    def cost(self, usage: dict) -> float:
        s = self.spec
        i = int(usage.get("input_tokens") or 0)          # includes cached tokens
        o = int(usage.get("output_tokens") or 0)         # includes reasoning
        details = usage.get("input_tokens_details") or {}
        cw = int(details.get("cache_write_tokens") or 0)
        # Cached reads are charged at the full input price: an overcount,
        # on purpose. The counter is a ceiling, not an invoice.
        return (i * s.usd_in_per_mtok + o * s.usd_out_per_mtok
                + cw * s.usd_in_per_mtok * 0.25) / 1e6

    def complete(self, *, system: str, user: str, schema: dict) -> EngineResult:
        body = {
            "model": self.spec.model,
            "instructions": system,
            "input": user,
            "max_output_tokens": self.spec.max_output_tokens,
            "store": False,
            "reasoning": {"effort": self._effort},
            "text": {"format": {"type": "json_schema", "name": "harness_output",
                                "schema": schema, "strict": True}},
        }
        try:
            resp = self._t.request("POST", f"{self._base}/v1/responses",
                                   headers=self._headers(), json_body=body,
                                   timeout=policy.HTTP_TIMEOUT_S)
        except TransportError as e:
            raise EngineError("retryable", e.kind, str(e)) from None
        if resp.status != 200:
            raise self._error(resp)
        try:
            data = resp.json()
        except Exception:
            raise EngineError("retryable", "bad_json", "unparseable 200 reply") from None
        usage = data.get("usage") or {}
        res = dict(engine=self.name, model=str(data.get("model") or self.spec.model),
                   input_tokens=int(usage.get("input_tokens") or 0),
                   output_tokens=int(usage.get("output_tokens") or 0),
                   usd=self.cost(usage))
        status = data.get("status")
        if status == "incomplete":
            reason = (data.get("incomplete_details") or {}).get("reason", "incomplete")
            return EngineResult("incomplete", None, detail=str(reason), **res)
        if status != "completed":
            return EngineResult("bad_output", None, detail=f"status {status}", **res)
        text = None
        for item in data.get("output") or []:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            for part in item.get("content") or []:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "refusal":
                    return EngineResult("refused", None, detail="model refused", **res)
                if part.get("type") == "output_text" and text is None:
                    text = part.get("text")
        out = _unwrap(text) if text is not None else None
        if out is None:
            return EngineResult("bad_output", None, detail="no JSON object", **res)
        return EngineResult("ok", out, **res)

    def _error(self, resp) -> EngineError:
        err = _error_body(resp.body)
        code = str(err.get("code") or "")
        etype = str(err.get("type") or "")
        msg = str(err.get("message", ""))[:200]
        st = resp.status
        if code in ("credit_balance_exhausted", "insufficient_quota") \
                or etype == "insufficient_quota":
            return EngineError("fatal", "billing", msg, status=st)
        if code in ("organization_spend_limit_exceeded", "project_spend_limit_exceeded",
                    "organization_usage_limit_exceeded"):
            return EngineError("fatal", "spend_limit", msg, status=st)
        if st == 429:
            return EngineError("retryable", "rate_limited", msg,
                               retry_after=_retry_after(resp.headers), status=st)
        if st in (500, 502, 503, 504):
            return EngineError("retryable", "server_error", msg,
                               retry_after=_retry_after(resp.headers), status=st)
        if st == 401:
            return EngineError("fatal", "auth", msg, status=st)
        if st == 404:
            return EngineError("fatal", "model_missing", msg, status=st)
        return EngineError("fatal", f"http_{st}", msg, status=st)

    def check_model(self) -> str:
        try:
            resp = self._t.request("GET", f"{self._base}/v1/models/{self.spec.model}",
                                   headers=self._headers(), timeout=30)
        except Exception:
            return "unknown"
        return {200: "ok", 404: "missing"}.get(resp.status, "unknown")


@dataclass
class CallOutcome:
    """What a worker thread hands back to the main thread."""
    result: EngineResult | None = None
    error: EngineError | None = None
    attempts: int = 0
    waits: list = field(default_factory=list)


def call_with_retries(engine: Engine, *, system: str, user: str, schema: dict,
                      budget_s: float, sleep: Callable[[float], None],
                      monotonic: Callable[[], float]) -> CallOutcome:
    """Run one engine call, retrying retryable errors with back-off while
    time remains. Never switches engine: no silent failover."""
    start = monotonic()
    out = CallOutcome()
    backoffs = list(policy.RETRY_BACKOFF_S)
    while True:
        out.attempts += 1
        try:
            out.result = engine.complete(system=system, user=user, schema=schema)
            return out
        except EngineError as e:
            out.error = e
        except Exception as e:                  # anything unforeseen: bounded retries
            out.error = EngineError("retryable", "unexpected", type(e).__name__)
        e = out.error
        if not e.retryable or not backoffs:
            return out
        wait = max(backoffs.pop(0), min(e.retry_after or 0, 120))
        if monotonic() - start + wait + policy.HTTP_TIMEOUT_S > budget_s:
            return out
        out.waits.append(wait)
        sleep(wait)
