"""0.24.0, sixteenth round, item 6: the mail skip marker from the fifteenth outside review (Nov 16).

A Subscribe & Save marker in the mail's text counts only where it says what the mail is: a header line at the top,
or the first block of text before the order's items. Never in a promotional footer or a quoted section; a first block
that reads as promotion is ambiguous and the mail is kept. mail_skip.json's entries and lists are capped.
All names are invented.
"""
import json

import pytest

from harness import mail_dates
from harness.mail_dates import SKIP_FILE, marker_placed, skip_file_check, skip_kinds, skipped_kind
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_family_add import on, rig  # noqa: F401
from test_family_gmail import g  # noqa: F401
from test_mail_dates import msg, read
from test_mail_skip import AMAZON, SAVE_DAY, rig_skip, rows

BUILT_IN = "Amazon delivery management"
DELAY = "Your delivery date has changed"
FOOTER = ("Your order of PC parts now arrives Nov 26.\n\nOrder #112-0000000-0000000\nPC parts  Qty: 1\n\n"
          "Save 15% on household essentials with Subscribe & Save. Learn more.")
REAL = ("Your Subscribe & Save delivery moves to Dec 3.\n\nItems in this delivery:\nCoffee beans  Qty: 2\n")


def test_an_order_delay_with_a_subscribe_and_save_footer_goes_through_end_to_end(g, tmp_path):
    day = [{"what": "PC parts arrive", "date": "2026-11-26", "kind": "event"}]
    rig_skip(g, tmp_path, [msg(1, DELAY, FOOTER, sender=AMAZON)], {DELAY: day})
    read(g)
    assert g.engine.asked == [DELAY]                                          # it went through
    assert g.md.skipped_status().get("count", 0) == 0


def test_a_real_subscribe_and_save_mail_is_still_skipped_end_to_end(g, tmp_path):
    rig_skip(g, tmp_path, [msg(1, DELAY, REAL, sender=AMAZON)], {DELAY: SAVE_DAY})
    read(g)
    assert g.engine.asked == [] and rows(g) == []


@pytest.mark.parametrize("text,counts", [
    (REAL, True),                                                             # the first block says so
    ("Program: Subscribe & Save\nDelivery: Dec 3\n\nYour items arrive soon.", True),   # a header line at the top
    (FOOTER, False),                                                          # a promotional footer
    ("Your order of PC parts now arrives Nov 26.\n\n> On Nov 1 you wrote:\n> my Subscribe & Save order", False),
    ("Your order arrives Nov 26.\nOrder #1\n... Subscribe & Save ...", False),   # after the order's items begin
    ("Try Subscribe & Save and save up to 15% on your next order.", False),   # a first block that's promotion
    ("", False),
])
def test_where_the_marker_sits_decides(text, counts):
    assert marker_placed(text, mail_dates.SAVE_MARKERS) is counts


def test_ambiguous_evidence_keeps_the_mail():
    kinds = skip_kinds(None)
    promo_lead = "Discover Subscribe & Save: deals on your favourites. Your delivery date has changed."
    assert skipped_kind(AMAZON, DELAY, kinds, body=lambda: promo_lead) == ""
    assert skipped_kind(AMAZON, DELAY, kinds, body=lambda: REAL) == BUILT_IN
    assert skipped_kind(AMAZON, "Subscribe & Save: " + DELAY, kinds, body=lambda: FOOTER) == BUILT_IN   # subject


@pytest.mark.parametrize("make,why", [
    (lambda good: [good] * (mail_dates.SKIP_MAX_ENTRIES + 1), "more than"),
    (lambda good: [dict(good, subject=[f"phrase {i}" for i in range(mail_dates.SKIP_MAX_WORDS + 1)])], "more than"),
    (lambda good: [dict(good, subject=["x" * (mail_dates.SKIP_MAX_WORD + 1)])], "longer than"),
    (lambda good: [dict(good, name="n" * (mail_dates.SKIP_MAX_NAME + 1))], "longer than"),
])
def test_the_file_is_capped_and_over_a_cap_it_is_ignored_with_why(tmp_path, make, why):
    good = {"name": "Pet shop points", "from": ["pawsclub.example"], "subject": ["points statement"]}
    (tmp_path / SKIP_FILE).write_text(json.dumps({"skip": make(good)}))
    kinds, problem = skip_file_check(str(tmp_path))
    assert [k["name"] for k in kinds] == [BUILT_IN] and why in problem


def test_a_file_at_the_caps_is_taken(tmp_path):
    good = {"name": "n" * mail_dates.SKIP_MAX_NAME, "from": ["pawsclub.example"],
            "subject": [f"phrase {i}" for i in range(mail_dates.SKIP_MAX_WORDS)]}
    (tmp_path / SKIP_FILE).write_text(json.dumps([good] * mail_dates.SKIP_MAX_ENTRIES))
    kinds, problem = skip_file_check(str(tmp_path))
    assert problem == "" and len(kinds) == 1 + mail_dates.SKIP_MAX_ENTRIES


def test_the_status_pages_skipped_list_stays_capped(g, tmp_path):
    many = [msg(i, f"Subscribe & Save delivery {i}", sender=AMAZON) for i in range(1, mail_dates.SKIP_RECENT + 6)]
    rig_skip(g, tmp_path, many, {})
    read(g)
    got = g.md.skipped_status()
    assert got["count"] == len(many) and len(got["recent"]) == mail_dates.SKIP_RECENT
