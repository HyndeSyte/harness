"""0.24.0, seventeenth round, item 5: the Subscribe & Save placement rule from the sixteenth outside review (Nov 16).

Leading salutation-only lines are passed over before the first block is chosen, and promotion is told by its
structure (an offer, or a block of calls to action and links), never by one common word such as "deals".
All names are invented.
"""
import pytest

from harness import mail_dates
from harness.mail_dates import marker_placed, skip_kinds, skipped_kind
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_family_add import on, rig  # noqa: F401
from test_family_gmail import g  # noqa: F401
from test_mail_dates import msg, read
from test_mail_skip import AMAZON, SAVE_DAY, rig_skip, rows

BUILT_IN = "Amazon delivery management"
DELAY = "Your delivery date has changed"
GREETING = ("Hello Alex,\n\nYour Subscribe & Save delivery moves to Dec 3.\n\nItems in this delivery:\n"
            "Coffee beans  Qty: 2\n")
GREETING_SAME_BLOCK = "Hi Alex,\nYour Subscribe & Save delivery moves to Dec 3.\n\nItems in this delivery:\n"
WORDY = ("Your Subscribe & Save delivery moves to Dec 3. Discover what's in this month's delivery and the deals "
         "you've set up.\n\nItems in this delivery:\nCoffee beans  Qty: 2\n")
DELAY_WITH_PROMO = ("Hello Alex,\n\nYour order of PC parts now arrives Nov 26. Save 15% on household essentials "
                    "with Subscribe & Save.\n\nOrder #112-0000000-0000000\nPC parts  Qty: 1\n")


@pytest.mark.parametrize("text,counts", [
    (GREETING, True),                                                         # the greeting is passed over
    (GREETING_SAME_BLOCK, True),
    ("Dear Alex Doe,\n\nYour Subscribe & Save delivery moves to Dec 3.", True),
    (WORDY, True),                                                            # "discover", "deals": not promotion
    (DELAY_WITH_PROMO, False),                                                # an offer: promotion, the mail kept
    ("Your Subscribe & Save delivery. Shop now https://example.com/a and https://example.com/b", False),
    ("Hello Alex,\n\nYour order of PC parts now arrives Nov 26.\n\nSubscribe & Save: learn more.", False),
])
def test_where_the_marker_sits_after_a_greeting_and_what_counts_as_promotion(text, counts):
    assert marker_placed(text, mail_dates.SAVE_MARKERS) is counts


def test_a_greeting_then_the_marker_is_skipped_end_to_end(g, tmp_path):
    rig_skip(g, tmp_path, [msg(1, DELAY, GREETING, sender=AMAZON)], {DELAY: SAVE_DAY})
    read(g)
    assert g.engine.asked == [] and rows(g) == []


def test_genuine_subscription_text_with_a_promotion_word_is_skipped(g, tmp_path):
    assert skipped_kind(AMAZON, DELAY, skip_kinds(None), body=lambda: WORDY) == BUILT_IN
    rig_skip(g, tmp_path, [msg(1, DELAY, WORDY, sender=AMAZON)], {DELAY: SAVE_DAY})
    read(g)
    assert g.engine.asked == [] and rows(g) == []


def test_an_order_delay_with_a_promotional_line_still_goes_through_end_to_end(g, tmp_path):
    day = [{"what": "PC parts arrive", "date": "2026-11-26", "kind": "event"}]
    rig_skip(g, tmp_path, [msg(1, DELAY, DELAY_WITH_PROMO, sender=AMAZON)], {DELAY: day})
    read(g)
    assert g.engine.asked == [DELAY]                                          # it went through
    assert g.md.skipped_status().get("count", 0) == 0
