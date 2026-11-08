"""Cain's bot over REST, as the calendar specialist uses it: payloads, owner, limits, vault."""

import pytest

from harness.discord_api import (LIMIT, SUPPRESS_EMBEDS, DiscordAPI, DiscordError,
                                 DiscordTransport, card_digest, check_token, components)
from harness.net import TransportError
from harness.vault import Vault, VaultError
from fakes import FakeTransport

# Made up, and assembled at run time so secret scanners don't mistake it for a real one.
TOKEN = ".".join(["x" * 26, "y" * 6, "z" * 38])
OWNER, DM, BOT = "111", "222", "999"


def api(replies):
    t = FakeTransport(replies)
    return DiscordAPI(lambda: TOKEN, t), t


# -- REST --------------------------------------------------------------------

def test_send_turns_off_mentions_and_previews_and_fits_2000():
    a, t = api([(200, {"id": "5", "content": "x"})])
    a.send(DM, "y" * 2500, components([[("Undo", "k:n:undo")]]))
    req = t.requests[0]
    assert req["url"] == f"https://discord.com/api/v10/channels/{DM}/messages"
    assert req["headers"]["authorization"] == f"Bot {TOKEN}"
    body = req["json"]
    assert body["allowed_mentions"] == {"parse": []} and body["flags"] == SUPPRESS_EMBEDS
    assert len(body["content"]) <= LIMIT
    assert body["components"][0]["components"][0]["custom_id"] == "k:n:undo"


def test_owner_is_the_team_owner_for_a_team_app():
    a, _ = api([(200, {"team": {"owner_user_id": "77"}, "owner": {"id": "88"}})])
    assert a.owner_id() == "77"
    a, _ = api([(200, {"owner": {"id": "88"}})])
    assert a.owner_id() == "88"


def test_rate_limit_is_retryable_and_carries_wait():
    a, _ = api([(429, {"message": "slow down", "retry_after": 1.5})])
    with pytest.raises(DiscordError) as e:
        a.send(DM, "hi")
    assert e.value.retryable and e.value.retry_after == 1.5


def test_interaction_answer_uses_its_own_token_not_the_bot_token():
    a, t = api([(204, b"")])
    a.answer("1", "itoken", 6)
    req = t.requests[0]
    assert req["url"].endswith("/interactions/1/itoken/callback")
    assert "authorization" not in req["headers"]


def test_transport_only_reaches_discord():
    for url in ("https://evil.example/api", "http://discord.com/api", "https://discord.com:444/x"):
        with pytest.raises(TransportError):
            DiscordTransport().request("GET", url)


def test_vault_takes_a_discord_token_and_refuses_junk(tmp_path):
    v = Vault(str(tmp_path / "s.json"))
    assert check_token(TOKEN)
    assert v.check_format("discord_bot_token", TOKEN) == TOKEN
    with pytest.raises(VaultError):
        v.check_format("discord_bot_token", "https://discord.com/not-a-token")


