"""Mirror settings entry: entered once on the add-on page, kept in /data like a
key, parsed on every use, never committed. (Fable Job B, 2026-10-18.)"""
import socket

import pytest

from harness import workmirror
from harness.vault import FIELDS, TEXT_FIELDS, Vault, VaultError
from harness.workmirror import FamilyRule, MirrorConfigError, parse_settings, settings_text

GOOD = """# the work-hours mirror
work: me@work.example
days: mon-fri
hours: 08:00-18:00
zone: America/New_York
horizon: 14
skip: Lunch
family: Pat - (.+) => {1}
family: Sam lesson => Sam lesson (watching kids)
titles: busy
"""


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(address, *a, **k):
        host = address[0]
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise AssertionError(f"network call to {host}")
        return real(address, *a, **k)
    real = socket.create_connection
    monkeypatch.setattr(socket, "create_connection", refuse)


def test_parses_his_lines_into_a_config():
    c = parse_settings(GOOD)
    assert c.enabled and c.work_address == "me@work.example"
    assert c.workdays == (0, 1, 2, 3, 4) and (c.day_start, c.day_end) == ("08:00", "18:00")
    assert c.horizon_days == 14 and c.title_mode == "busy"
    assert c.skip_titles == ("Lunch",)
    assert c.family_rules == (FamilyRule("Pat - (.+)", "{1}"),
                              FamilyRule("Sam lesson", "Sam lesson (watching kids)"))
    assert c.google_calendars == ()          # primary only unless named


def test_normalized_text_round_trips():
    c = parse_settings(GOOD)
    assert parse_settings(settings_text(c)) == c
    assert "#" not in settings_text(c)


def test_days_forms():
    assert parse_settings("work: a@b.example\ndays: mon,wed-fri").workdays == (0, 2, 3, 4)
    assert parse_settings("work: a@b.example\ndays: sat").workdays == (5,)


def test_off_needs_nothing_else():
    c = parse_settings("enabled: no")
    assert not c.enabled and c.work_address == ""


@pytest.mark.parametrize("text, needle", [
    ("days: mon-fri", "work:"),
    ("work: not-an-address", "work_address"),
    ("work: a@b.example\nhours: 9-5", "HH:MM"),
    ("work: a@b.example\nhours: 18:00-08:00", "before"),
    ("work: a@b.example\ndays: funday", "mon..sun"),
    ("work: a@b.example\ndays: fri-mon", "backwards"),
    ("work: a@b.example\nzone: Nowhere/Zone", "Nowhere"),
    ("work: a@b.example\nhorizon: lots", "number"),
    ("work: a@b.example\nhorizon: 90", "1-60"),
    ("work: a@b.example\ntitles: public", "busy"),
    ("work: a@b.example\nfamily: (unclosed => x", "family rule"),
    ("work: a@b.example\nwork: c@d.example", "twice"),
    ("work: a@b.example\ncolour: blue", "line 2"),
    ("work: a@b.example\nenabled: maybe", "yes or no"),
    ("x" * 5000, "longer"),
])
def test_malformed_lines_are_refused_by_line(text, needle):
    with pytest.raises(MirrorConfigError, match=needle):
        parse_settings(text)


def test_the_vault_keeps_it_like_a_key_and_the_page_gets_a_textarea(tmp_path):
    assert "work_mirror" in FIELDS and "work_mirror" in TEXT_FIELDS
    v = Vault(str(tmp_path / "s.json"))
    v.set_key("work_mirror", GOOD, by="Owner")
    assert parse_settings(v.get("work_mirror")) == parse_settings(GOOD)
    assert v.key_status()["work_mirror"]
    with pytest.raises(VaultError, match="work mirror settings"):
        v.set_key("work_mirror", "hours: 08:00-18:00", by="Owner")
    # after pairing, a change is a request for his tap, like any key
    v.try_pair(v.new_pairing_code(), user_id=7, chat_id=7)
    v.request_change("work_mirror", "enabled: no", by="Owner")
    assert parse_settings(v.get("work_mirror")).enabled
    assert v.pending()["field"] == "work_mirror"
    v.resolve_change(v.pending()["id"], "approve")
    assert not parse_settings(v.get("work_mirror")).enabled


def test_nothing_personal_in_the_defaults():
    c = workmirror.MirrorConfig()
    assert not c.enabled and c.work_address == "" and c.family_rules == ()
