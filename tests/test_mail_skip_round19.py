"""0.24.0, nineteenth round, item 11: the boilerplate link filter matches help, account or manage only in a link's
path (or the words before it), never its host, so a promotional link whose domain holds "account" still counts as a
call to action. All names and addresses are invented.
"""
from harness import mail_dates
from harness.mail_dates import _real_links, marker_placed
from fake_caldav import no_network  # noqa: F401  (autouse)

MARKS = mail_dates.SAVE_MARKERS


def test_a_promotional_link_whose_domain_holds_account_still_counts():
    assert _real_links("Deals at https://myaccountdeals.example.com/sale today") == 1
    assert _real_links("Shop https://helpfulstore.example.com/now") == 1
    text = ("Your Subscribe & Save delivery moves to Dec 3. Learn more, or shop now at "
            "https://bestaccount.example.com/spring")
    assert marker_placed(text, MARKS) is False                                 # three calls to action: promotion


def test_help_account_and_manage_in_the_path_are_still_boilerplate():
    assert _real_links("See https://store.example.com/account/settings") == 0
    assert _real_links("See https://store.example.com/help?topic=1") == 0
    assert _real_links("See https://store.example.com/manage") == 0
    assert _real_links("See https://store.example.com/x and manage your account there") == 1
    assert _real_links("Manage your account https://store.example.com/x") == 0   # the words before it


def test_unsubscribe_and_privacy_still_count_anywhere_in_the_address():
    assert _real_links("https://unsubscribe.example.com/u") == 0
    assert _real_links("https://example.com/privacy") == 0
