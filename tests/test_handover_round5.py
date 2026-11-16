"""0.24.0, fifth round: what the fourth outside review of the handover fixes asked for (Nov 16).

Each must-fix on its own, against the fake calendars and a fake Discord: every no-card path behind
the one flag, provider-side fencing of moves and removals, a bounded write lifetime with follow-up
reads after a lapse, not seen yet instead of not done, the flag turned on only by a passing record
and his tap, migration reporting, supersede edges, and the owner's time zone for open days. All
names and ids invented.
"""
import json

import pytest

from harness import calendar_change
from test_family_add import (ask_cards, count_up, fresh, loose, on, rig, STOP)  # noqa: F401  (fixtures)


# -- 1. every no-card path behind the flag ---------------------------------------------------------

@pytest.mark.card_only
def test_the_bake_in_opt_in_is_a_normal_card_while_the_flag_is_off(loose):
    """His tap on the bake-in card is already in the ledger, and the smoke test's flag isn't on: an
    add comes on a card and nothing is written."""
    assert loose.fa.loosened() and not loose.fa.tapless()
    assert calendar_change.fast_path(loose.ledger) == {}
    loose.ask(**fresh())
    assert "PUT" not in loose.icloud.methods()
    assert "Add to the Family calendar?" in loose.last()[1]
    assert "each needs your tap until" in loose.fa.status_line()


def test_the_bake_in_opt_in_is_checked_against_the_flag_at_write_time(loose, monkeypatch):
    """On when the add was offered, turned off before its write: it comes back as a card."""
    real = loose.fa.auto_approve

    def then_off(proposal_id, job_id, db):
        took = real(proposal_id, job_id, db)
        if took:
            loose.ledger.set_meta(calendar_change.FAST_PATH, json.dumps({"on": False}), db)
        return took
    monkeypatch.setattr(loose.fa, "auto_approve", then_off)
    loose.ask(**fresh())
    assert "PUT" not in loose.icloud.methods()
    assert any("the Approve tap came back before I added it" in t for t in loose.texts())


def test_the_bake_in_opt_in_goes_without_a_tap_once_the_flag_is_on(loose):
    calendar_change.set_fast_path(loose.ledger, True, "passed")
    assert loose.fa.tapless()
    loose.ask(**fresh())
    assert "PUT" in loose.icloud.methods()
