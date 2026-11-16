"""0.24.0, eighteenth round, item 11: the Subscribe & Save placement rule, two corrections.

(a) A leading line shaped like a salutation that holds a marker isn't passed over: it is the first block, so
    "Subscribe and Save," on its own line is still found as the marker.
(b) Promotion needs the explicit offer or more than two calls to action and links; boilerplate (unsubscribe,
    manage your account, privacy, help, preferences, view in browser) doesn't count toward it, neither as words
    nor as a link whose address or the words just before it are boilerplate.
All names are invented.
"""
from harness import mail_dates
from harness.mail_dates import marker_placed
from fake_caldav import no_network  # noqa: F401  (autouse)

MARKS = mail_dates.SAVE_MARKERS


def test_a_salutation_shaped_line_holding_the_marker_is_the_first_block():
    text = "Subscribe and Save,\nYour order ships Tuesday, Dec 3.\n\nItems in this delivery:\nCoffee beans  Qty: 2\n"
    assert marker_placed(text, MARKS) is True
    assert marker_placed(text.replace("Your order", "Get 20% off when your order"), MARKS) is False
    assert marker_placed("Hello Alex,\nYour Subscribe & Save delivery moves to Dec 3.", MARKS) is True


def test_boilerplate_links_and_one_call_to_action_are_not_promotion():
    text = ("Your Subscribe & Save delivery moves to Dec 3. Learn more about your delivery.\n"
            "Unsubscribe: https://example.com/unsubscribe?u=1\n"
            "Privacy notice https://example.com/privacy\n")
    assert marker_placed(text, MARKS) is True
    words = ("Your Subscribe & Save delivery moves to Dec 3. Learn more. Manage your account https://example.com/x "
             "or view in browser https://example.com/y. Unsubscribe.")
    assert marker_placed(words, MARKS) is True


def test_two_calls_to_action_are_not_promotion_but_three_are():
    two = "Your Subscribe & Save delivery moves to Dec 3. Learn more, or shop now."
    assert marker_placed(two, MARKS) is True
    three = "Your Subscribe & Save delivery moves to Dec 3. Learn more, shop now, or sign up."
    assert marker_placed(three, MARKS) is False


def test_the_marker_with_an_offer_is_promotion():
    assert marker_placed("Your Subscribe & Save delivery moves to Dec 3. Learn more.", MARKS) is True
    assert marker_placed("Your Subscribe & Save delivery moves to Dec 3. Learn more, or shop now.", MARKS) is True
    assert marker_placed("Your Subscribe & Save delivery moves to Dec 3. Take 20% off your next one.", MARKS) is False
