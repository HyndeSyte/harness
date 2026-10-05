"""The vault: keys, the paired owner, and changes only his tap can apply."""
import os
import stat
from datetime import datetime, timedelta, timezone

import pytest

from harness.vault import PAIRING_MAX_FAILURES, Vault, VaultError

TOKEN = "123456789:AAEhBP0av28aH3sT9_" + "x" * 18
AKEY = "sk-ant-api03-" + "A" * 40
OKEY = "sk-proj-" + "B" * 40


class Clock:
    def __init__(self):
        self.t = datetime(2026, 10, 19, 23, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def vault(tmp_path, clock):
    return Vault(str(tmp_path / "secrets.json"), clock=clock)


def test_keys_are_stored_privately_and_never_listed(vault, tmp_path):
    vault.set_key("telegram_bot_token", TOKEN, by="Owner")
    mode = stat.S_IMODE(os.stat(tmp_path / "secrets.json").st_mode)
    assert mode == 0o600
    assert vault.get("telegram_bot_token") == TOKEN
    status = vault.key_status()
    assert status["telegram_bot_token"] and status["openai_api_key"] is None
    assert TOKEN not in repr(status)


@pytest.mark.parametrize("field, value", [
    ("telegram_bot_token", "https://t.me/example_harness_bot"),
    ("telegram_bot_token", AKEY),
    ("anthropic_api_key", OKEY),
    ("openai_api_key", "my key"),
    ("anthropic_api_key", ""),
])
def test_wrong_things_in_the_wrong_box_are_refused(vault, field, value):
    with pytest.raises(VaultError):
        vault.set_key(field, value, by="Owner")


def test_first_saver_becomes_the_only_setup_user(vault):
    assert vault.claim_setup_user("u1", "Owner")
    assert vault.claim_setup_user("u1", "Owner")
    assert not vault.claim_setup_user("u2", "Someone else")


def test_pairing_is_write_once(vault):
    code = vault.new_pairing_code()
    assert vault.try_pair("wrong-code-0000000000", user_id=5, chat_id=5) == "wrong code"
    assert vault.try_pair(code, user_id=424242, chat_id=424242) == "paired"
    assert vault.owner_id() == 424242
    assert vault.try_pair(code, user_id=6, chat_id=6) == "already paired"
    with pytest.raises(VaultError):
        vault.new_pairing_code()


def test_pairing_codes_expire_and_burn_after_guessing(vault, clock):
    code = vault.new_pairing_code()
    clock.t += timedelta(minutes=16)
    assert vault.try_pair(code, user_id=5, chat_id=5) == "pairing code expired"
    code = vault.new_pairing_code()
    for _ in range(PAIRING_MAX_FAILURES):
        vault.try_pair("x" * 22, user_id=7, chat_id=7)
    assert vault.try_pair(code, user_id=5, chat_id=5) == "no pairing code"
    assert vault.owner() is None


def test_after_pairing_a_change_waits_for_his_tap(vault, clock):
    vault.set_key("openai_api_key", OKEY, by="Owner")
    code = vault.new_pairing_code()
    vault.try_pair(code, user_id=1, chat_id=1)
    new = "sk-proj-" + "C" * 40
    cid = vault.request_change("openai_api_key", new, by="Owner")
    assert vault.get("openai_api_key") == OKEY             # not applied yet
    assert vault.resolve_change(cid, "decline").startswith("Declined")
    assert vault.get("openai_api_key") == OKEY
    cid = vault.request_change("openai_api_key", new, by="Owner")
    assert vault.resolve_change(cid, "approve").startswith("Done")
    assert vault.get("openai_api_key") == new
    cid = vault.request_change("openai_api_key", OKEY, by="Owner")
    clock.t += timedelta(minutes=16)
    assert vault.pending() is None
    assert "no longer pending" in vault.resolve_change(cid, "approve")
    assert vault.get("openai_api_key") == new


def test_reset_forgets_keys_and_owner_but_not_who_set_it_up(vault):
    vault.claim_setup_user("u1", "Owner")
    vault.set_key("telegram_bot_token", TOKEN, by="Owner")
    vault.try_pair(vault.new_pairing_code(), user_id=1, chat_id=1)
    vault.reset()
    assert vault.owner() is None and vault.get("telegram_bot_token") == ""
    assert vault.setup_user()["id"] == "u1"


def test_a_torn_write_leaves_the_old_file(vault, tmp_path, monkeypatch):
    vault.set_key("telegram_bot_token", TOKEN, by="Owner")
    import harness.vault as vmod

    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(vmod.os, "replace", boom)
    with pytest.raises(OSError):
        vault.set_key("anthropic_api_key", AKEY, by="Owner")
    monkeypatch.undo()
    assert vault.get("telegram_bot_token") == TOKEN and vault.get("anthropic_api_key") == ""
    assert [p.name for p in tmp_path.iterdir()] == ["secrets.json"]
