"""Configuration. Non-secret, versioned, and part of the integrity hash.

Secrets never live here. The three keys (Telegram bot token, Anthropic
key, OpenAI key) are entered once on the add-on's own page and stored in
/data, never in add-on options: the Supervisor API exposes options, and
his Home Assistant connector can read and rewrite them (round-4 finding).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

STAGES = ("S0", "S1", "S2", "S3")

# Corporate-content markers seen in the wild. "DRMEncryptedDataSpace" is
# what a rights-protected (Purview) document looks like when it arrives.
# The filter is defense in depth, not a guarantee: no work account is
# ever connected.
DEFAULT_WORK_MARKERS = (
    "DRMEncryptedDataSpace",
    "MSIP_Label_",
    "Microsoft Purview",
)


@dataclass(frozen=True)
class Config:
    owner_user_id: int
    timezone: str = "America/New_York"
    stage: str = "S0"
    policy_version: str = "p1"
    # Nothing proactive reaches his phone before this date. Enforced in
    # the sender, never in a prompt.
    proactive_from: date = date(2026, 10, 20)
    digest_time: str = "07:00"
    # The Home Assistant calendar whose pushes the harness expects (family.py).
    # Empty: none expected. Set: the digest is never Clear while it is missing.
    family_entity: str = "calendar.family"
    approval_ttl_s: int = 12 * 3600
    work_domains: tuple[str, ...] = ()
    work_markers: tuple[str, ...] = DEFAULT_WORK_MARKERS
    # Domains whose links may stay clickable in model text. Everything
    # else is defanged; links he can tap are rendered by the controller.
    link_allowlist: tuple[str, ...] = ()
    # Telegram keeps undelivered updates for at most 24 hours. After a
    # longer silence the thread is told continuity is unknown.
    continuity_window_s: int = 24 * 3600
    monthly_budget_usd: dict = field(default_factory=lambda: {
        "anthropic": 40, "openai": 10})
    low_balance_usd: dict = field(default_factory=lambda: {
        "anthropic": 10, "openai": 3})

    def __post_init__(self):
        if self.stage not in STAGES:
            raise ValueError(f"unknown stage {self.stage!r}")
        if not isinstance(self.owner_user_id, int) or self.owner_user_id <= 0:
            raise ValueError("owner_user_id must be his positive Telegram user id")

    def stage_at_least(self, stage: str) -> bool:
        return STAGES.index(self.stage) >= STAGES.index(stage)
