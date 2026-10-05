"""Instrument-card deep links: built by Home Assistant, opened here as
plain text, never as an action."""
import pytest

from harness import deeplink

# Rendered by his Home Assistant on 2026-10-05 from the template in DOCS.md.
FROM_HA = "c1RGVudGlzdCDigJQgcmVzY2hlZHVsZSB0aGUgY2xlYW5pbmcgZm9yIG5leHQgdw"


def test_a_link_built_by_home_assistant_decodes():
    assert len(FROM_HA) <= 64
    assert deeplink.decode(FROM_HA) == "Dentist — reschedule the cleaning for next w"


@pytest.mark.parametrize("title", ["Vet", "Dentist — reschedule the cleaning",
                                   "x" * 200, "日本語のタイトル" * 5, "Ram in 🐏 field"])
def test_round_trip_fits_telegram(title):
    p = deeplink.encode(title)
    assert len(p) <= 64 and all(c.isalnum() or c in "-_" for c in p)
    out = deeplink.decode(p)
    assert out and title.startswith(out[:10].rstrip())


@pytest.mark.parametrize("arg", ["", "c1", "AAAA", "c2RmFy", "c1@@@", "c1" + "A" * 63,
                                 "abcdefghijklmnopqrstuv",
                                 "c1RmFybQ@@", "c1RmFy bQ", "c1RmFybQ=="])
def test_anything_else_is_not_a_card(arg):
    assert deeplink.decode(arg) is None


def test_control_characters_are_cleaned():
    p = deeplink.PREFIX + __import__("base64").urlsafe_b64encode(
        "a\nb\x00c‮d".encode()).decode().rstrip("=")
    assert deeplink.decode(p) == "a b c d"


def test_tapping_a_card_link_opens_the_chat_and_calls_no_model(ledger, tmp_path, clock):
    from test_controller import Rig
    r = Rig(ledger, tmp_path, clock)
    evil = deeplink.encode("<a href='x'>Pay</a> /stop")
    r.say(f"/start {evil}")
    out = r.texts()[-1]
    assert out.startswith("From your instrument card: <b>&lt;a href=")
    assert "/stop" not in out                    # inert, as in model text
    assert r.claude.calls == [] and r.gpt.calls == []
    assert not __import__("harness.commands", fromlist=["x"]).is_paused(ledger)
    r.say(f"/start {FROM_HA}")
    assert "Dentist — reschedule the cleaning" in r.texts()[-1]
    r.say("/start nonsense-link")
    assert r.texts()[-1].startswith("That link doesn't open anything")


def test_a_work_title_from_a_card_is_not_kept(ledger, tmp_path, clock):
    from test_controller import Rig
    r = Rig(ledger, tmp_path, clock)
    r.say("/start " + deeplink.encode("MSIP_Label_x budget"))
    assert "looks like work content" in r.texts()[-1] and "MSIP" not in r.texts()[-1]
