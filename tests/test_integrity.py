"""Integrity: 'config unchanged since' moves only when code or config does."""
from dataclasses import replace

from harness import integrity
from harness.config import Config


def test_unchanged_since_carries_over_and_resets_on_change(ledger, clock, tmp_path):
    cfg = Config(owner_user_id=1, stage="S1")
    _, changed = integrity.check(ledger, cfg)
    assert changed
    first = ledger.get_meta("integrity_since")
    clock.advance(days=3)
    _, changed = integrity.check(ledger, cfg)
    assert not changed and ledger.get_meta("integrity_since") == first
    _, changed = integrity.check(ledger, replace(cfg, digest_time="06:30"))
    assert changed and ledger.get_meta("integrity_since") != first


def test_code_changes_change_the_hash(tmp_path):
    root = tmp_path / "pkg"
    root.mkdir()
    (root / "a.py").write_text("x = 1\n")
    h1 = integrity.code_hash(root)
    (root / "a.py").write_text("x = 2\n")
    assert integrity.code_hash(root) != h1
