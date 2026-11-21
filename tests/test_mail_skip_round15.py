"""0.24.0, fifteenth round, item 5: the mail skip list from the fourteenth outside review (Nov 16).

mail_skip.json is checked strictly (one entry that doesn't fit and the whole file is ignored, the built-in kinds
hold, and the page says why); Amazon's built-in kind is Subscribe & Save delivery management only (the Amazon
sender and a Subscribe & Save marker in the subject or the mail's text before any phrase counts; "return" only as a
whole word); skipped mail is counted on the status page by sender, subject and rule. All names are invented.
"""
import json

import pytest

from harness.mail_dates import SKIP_FILE, skip_file_check, skip_kinds, skipped_kind
from harness.setup_web import SetupApp
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_family_add import on, rig  # noqa: F401
from test_family_gmail import g  # noqa: F401
from test_mail_dates import msg, read
from test_mail_skip import AMAZON, SAVE, SAVE_DAY, rig_skip, rows

BUILT_IN = ["Amazon delivery management"]
GOOD = {"name": "Pet shop points", "from": ["pawsclub.example"], "subject": ["points statement"]}


# -- a strict file ------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("entry,why", [
    ({"name": "Strings", "from": "pawsclub.example", "subject": ["points statement"]}, '"from"'),
    ({"name": "Empty", "from": [""], "subject": ["points statement"]}, "shorter than 3"),
    ({"name": "Short", "from": ["pawsclub.example"], "subject": ["ab"]}, "shorter than 3"),
    ({"name": "Wrong type", "from": ["pawsclub.example"], "subject": [42]}, "isn't text"),
    ({"name": "Unless", "from": ["pawsclub.example"], "subject": ["points"], "unless": "sale"}, '"unless"'),
    ({"name": "No subject", "from": ["pawsclub.example"]}, '"subject"'),
    ({"from": ["pawsclub.example"], "subject": ["points"]}, "no name"),
    ("odd", "isn't a mapping"),
    ({"name": "Extra", "from": ["pawsclub.example"], "subject": ["points"], "body": ["x"]}, "doesn't know"),
])
def test_one_entry_that_doesnt_fit_ignores_the_whole_file_and_says_why(tmp_path, entry, why):
    (tmp_path / SKIP_FILE).write_text(json.dumps({"skip": [GOOD, entry]}))
    kinds, problem = skip_file_check(str(tmp_path))
    assert [k["name"] for k in kinds] == BUILT_IN                         # not even the good entry
    assert problem.startswith("entry 2 ") and why in problem


def test_a_good_file_adds_its_kinds_and_says_nothing(tmp_path):
    (tmp_path / SKIP_FILE).write_text(json.dumps([GOOD]))
    kinds, problem = skip_file_check(str(tmp_path))
    assert [k["name"] for k in kinds] == BUILT_IN + ["Pet shop points"] and problem == ""


def test_the_reason_shows_on_the_status_page(g, tmp_path):
    (tmp_path / SKIP_FILE).write_text(json.dumps({"skip": [{"name": "Bad", "from": "x", "subject": ["y"]}]}))
    rig_skip(g, tmp_path, [msg(1, SAVE, sender=AMAZON)], {SAVE: SAVE_DAY})
    read(g)
    assert g.engine.asked == []                                            # the built-in kind still holds
    assert g.md.skip_problem.startswith("entry 1 ")
    from harness import setup_web
    import inspect
    src = inspect.getsource(setup_web)
    assert "mail_skip.json is ignored" in src and 'st.get("mail_skip_problem")' in src
    from harness import controller
    assert '"mail_skip_problem"' in inspect.getsource(controller.Controller._publish)


# -- Amazon's kind, narrowed ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("subject", [
    "Your Amazon Prime membership renews soon: manage your subscription",
    "Your Audible membership will renew on Dec 2",
    "Kindle Unlimited: manage your subscription before it renews",
    "Your package has a new delivery date",
    "Delivery update: your order's delivery date has changed",
    "Your upcoming delivery: arriving Tuesday",
    "Delivery day changed for your order",
])
def test_renewals_and_ordinary_order_delays_go_through(subject):
    assert skipped_kind(AMAZON, subject, skip_kinds(None), body=lambda: "Your order of PC parts.") == ""


def test_a_return_is_matched_as_a_whole_word():
    kinds = skip_kinds(None)
    assert skipped_kind(AMAZON, "Subscribe & Save: returning customers save more", kinds) == BUILT_IN[0]
    assert skipped_kind(AMAZON, "Subscribe & Save: start a return", kinds) == ""
    assert skipped_kind(AMAZON, "Subscribe & Save returns policy", kinds) == ""


def test_a_subscribe_and_save_mail_is_still_skipped_by_subject_or_by_its_text():
    kinds = skip_kinds(None)
    assert skipped_kind(AMAZON, SAVE, kinds) == BUILT_IN[0]
    assert skipped_kind(AMAZON, "Your delivery date has changed", kinds,
                        body=lambda: "Your Subscribe & Save delivery moves to Dec 3.") == BUILT_IN[0]
    assert skipped_kind(AMAZON, "Your delivery date has changed", kinds,
                        body=lambda: "Your order of PC parts.") == ""
    assert skipped_kind("Shop <orders@shop.example>", SAVE, kinds) == ""


def test_an_order_delay_goes_through_end_to_end_and_its_text_is_read_once(g, tmp_path):
    delay = "Your delivery date has changed"
    day = [{"what": "PC parts arrive", "date": "2026-11-26", "kind": "event"}]
    rig_skip(g, tmp_path, [msg(1, delay, "Your order of PC parts now arrives Nov 26.", sender=AMAZON)],
             {delay: day})
    read(g)
    assert g.engine.asked == [delay]
    assert g.box.texts_read == [1]                                         # read once: for the marker and the engine


def test_a_subscribe_and_save_mail_with_the_marker_in_its_text_is_skipped_before_the_engine(g, tmp_path):
    subject = "Your delivery date has changed"
    rig_skip(g, tmp_path, [msg(1, subject, "Your Subscribe & Save delivery moves to Dec 3.", sender=AMAZON)],
             {subject: SAVE_DAY})
    read(g)
    assert g.engine.asked == [] and rows(g) == []


# -- skipped mail is counted on the status page ---------------------------------------------------------------------

def test_skipped_mail_is_counted_by_sender_subject_and_rule(g, tmp_path):
    rig_skip(g, tmp_path, [msg(1, SAVE, sender=AMAZON), msg(2, "Review your Subscribe & Save items", sender=AMAZON)],
             {SAVE: SAVE_DAY})
    read(g)
    got = g.md.skipped_status()
    assert got["count"] == 2
    assert got["recent"][0] == {"sender": AMAZON, "subject": SAVE, "rule": BUILT_IN[0]}
    assert "Subscribe" not in g.md.digest_line()                           # never the digest


def test_the_status_page_shows_skipped_mail_the_files_fencing_and_the_lock_wait(tmp_path):
    import queue
    from harness.setup_web import render_page
    from harness.vault import Vault
    status = {"mail_skipped": {"count": 3, "recent": [{"sender": AMAZON, "subject": SAVE, "rule": BUILT_IN[0]}]},
              "mail_skip_problem": "entry 1 has no name",
              "migration": {"degraded": True, "why": "a test", "files": ["harness.sqlite.swap.json (9 bytes)"],
                            "lock_wait": True, "lock_wait_since": "2026-11-16T09:00:00+00:00", "lock_retry_s": 5,
                            "fenced": True, "fenced_beat": "2026-11-16T09:00:01+00:00", "run_time_s": 12}}
    page = render_page(SetupApp(Vault(str(tmp_path / "s.json")), status, queue.Queue()), "u1", "Owner")
    assert "Mail skipped by kind: 3 so far" in page and "Last day to manage your Subscribe &amp; Save" in page
    assert "mail_skip.json is ignored: entry 1 has no name" in page
    assert "Beside the records: harness.sqlite.swap.json (9 bytes)" in page
    assert "tried again every 5 s" in page and "Fenced for the staged restore" in page
