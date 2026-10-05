"""Policy pinned in code: which engine runs what, at what price, how long
anything may take. Changing any of it is a code change -- reviewed,
versioned, part of the integrity hash -- never a setting a model, a rule
or an add-on option can reach.

Model ids and prices were verified against the providers' own docs on
2026-10-05 (platform.claude.com pricing and models pages; OpenAI pricing
and model pages). At start-up the controller also asks each provider
whether the pinned model exists; a missing model is reported, never
silently swapped for another.
"""
from __future__ import annotations

from dataclasses import dataclass

POLICY_VERSION = "p1"


@dataclass(frozen=True)
class ModelSpec:
    engine: str            # the name used in routing and receipts
    provider: str          # "anthropic" | "openai"
    model: str             # exact API model id
    usd_in_per_mtok: float
    usd_out_per_mtok: float
    max_output_tokens: int


# max_output_tokens includes thinking/reasoning on both providers, and a
# truncated reply is a failed job, so leave room (the providers' own
# examples use 16k). At $10 per million output tokens the ceiling is $0.16
# per call.
MODELS: dict[str, ModelSpec] = {
    "claude": ModelSpec("claude", "anthropic", "claude-sonnet-5-5", 2.0, 10.0, 16000),
    "gpt": ModelSpec("gpt", "openai", "gpt-6.1-sol", 2.0, 10.0, 16000),
}
# Sonnet 5.5's default is adaptive thinking at "high"; pinned explicitly so
# a provider default change can't silently change cost or behavior. GPT
# runs at its floor: it is a second opinion, not the main engine.
EFFORT = {"claude": "high", "gpt": "low"}

# Every S1 job goes to Claude. GPT is wired, tested and canaried so it can
# be routed to later by measured trial -- never as a silent fallback.
ROUTING: dict[str, str] = {
    "message": "claude",
}
CANARY_ENGINES = ("claude", "gpt")

# Time limits (seconds).
HTTP_TIMEOUT_S = 120            # one model call
STILL_WORKING_AFTER_S = 180     # tell him it's still going
JOB_DEADLINE_S = 600            # then it fails, with a receipt
RETRY_BACKOFF_S = (5, 20, 60)   # for retryable engine errors, within the deadline

# Lean context: what one call may carry.
MAX_RULES_PER_CALL = 12
MAX_CONTEXT_CHARS = 4000        # earlier exchange shown for continuity
CONTEXT_WINDOW_S = 30 * 60      # only exchanges this recent count as "the conversation"
MAX_INPUT_CHARS = 12000         # his message; longer is refused with a receipt


def spec(engine: str) -> ModelSpec:
    return MODELS[engine]


def engine_for(job_kind: str) -> str:
    return ROUTING.get(job_kind, "claude")
