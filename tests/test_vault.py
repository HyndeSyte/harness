"""The vault: keys, the owner, and changes only his tap can apply."""
import json
import os
import stat
from datetime import datetime, timedelta, timezone

import pytest

from fakes import own
from harness.vault import FIELDS, Vault, VaultError

# Made up, and assembled at run time so secret scanners don't mistake it for a real one.
TOKEN = ".".join(["x" * 26, "y" * 6, "z" * 38])
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
    v = Vault(str(tmp_path / "secrets.json"), clock=clock)
    v.set_key("discord_bot_token", TOKEN, by="Owner")
    return v


def test_keys_are_stored_privately_and_never_listed(vault, tmp_path):
    mode = stat.S_IMODE(os.stat(tmp_path / "secrets.json").st_mode)
    assert mode == 0o600
    assert vault.get("discord_bot_token") == TOKEN
    status = vault.key_status()
    assert status["discord_bot_token"] and status["openai_api_key"] is None
    assert TOKEN not in repr(status)


@pytest.mark.parametrize("field, value", [
    ("discord_bot_token", "https://discord.com/users/1"),
    ("discord_bot_token", AKEY),
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


def test_with_an_owner_a_change_waits_for_his_tap(vault, clock):
    vault.set_key("openai_api_key", OKEY, by="Owner")
    own(vault, 1)
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
    own(vault, 1)
    vault.reset()
    assert vault.owner() is None and vault.get("discord_bot_token") == ""
    assert vault.setup_user()["id"] == "u1"


def test_a_torn_write_leaves_the_old_file(vault, tmp_path, monkeypatch):
    import harness.vault as vmod

    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(vmod.os, "replace", boom)
    with pytest.raises(OSError):
        vault.set_key("anthropic_api_key", AKEY, by="Owner")
    monkeypatch.undo()
    assert vault.get("discord_bot_token") == TOKEN and vault.get("anthropic_api_key") == ""
    assert [p.name for p in tmp_path.iterdir()] == ["secrets.json"]


def test_a_telegram_token_left_from_before_is_ignored_then_dropped(vault, tmp_path):
    path = tmp_path / "secrets.json"
    data = json.loads(path.read_text())
    data["keys"]["telegram_bot_token"] = {"value": "123:abc", "set_at": "2026-10-01T00:00:00+00:00"}
    data["pending"] = {"id": "ab12", "field": "telegram_bot_token", "value": "1:x", "by": "Owner",
                       "at": "2026-10-19T23:00:00+00:00", "announced": True,
                       "expires_at": "2026-10-19T23:10:00+00:00"}
    path.write_text(json.dumps(data))
    assert "telegram_bot_token" not in FIELDS and "telegram_bot_token" not in vault.key_status()
    assert vault.resolve_change("ab12", "decline").startswith("Declined")
    assert "telegram_bot_token" not in json.loads(path.read_text())["keys"]
    assert vault.get("discord_bot_token") == TOKEN
