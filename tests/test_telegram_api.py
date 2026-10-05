"""The real Bot API client: payloads, errors, and the token never leaking."""
import pytest

from harness.net import RedactingFilter, TransportError
from harness.telegram_api import TelegramBotAPI, TelegramError
from fakes import FakeTransport

TOKEN = "123456789:AAEhBP0av28aH3sT9_" + "x" * 18


def bot(replies):
    t = FakeTransport(replies)
    return TelegramBotAPI(lambda: TOKEN, t), t


def test_send_message_payload_and_message_id():
    api, t = bot([(200, {"ok": True, "result": {"message_id": 77}})])
    mid = api.send_message(42, "<b>hi</b>", [[("Undo", "c:abc")]])
    assert mid == 77
    req = t.requests[0]
    assert req["url"] == f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    body = req["json"]
    assert body["parse_mode"] == "HTML" and body["chat_id"] == 42
    assert body["link_preview_options"] == {"is_disabled": True}
    assert "disable_web_page_preview" not in body
    assert body["reply_markup"] == {"inline_keyboard": [[{"text": "Undo",
                                                          "callback_data": "c:abc"}]]}


def test_get_updates_omits_offset_zero_and_always_sends_allowed_updates():
    api, t = bot([(200, {"ok": True, "result": []}), (200, {"ok": True, "result": []})])
    api.get_updates(0, 25, ("message", "callback_query"))
    api.get_updates(10, 25, ("message", "callback_query"))
    assert "offset" not in t.requests[0]["json"]
    assert t.requests[1]["json"]["offset"] == 10
    for r in t.requests:
        assert r["json"]["allowed_updates"] == ["message", "callback_query"]
        assert r["timeout"] > 25            # the HTTP timeout outlasts the long poll


def test_errors_carry_code_and_retry_after():
    api, _ = bot([(429, {"ok": False, "error_code": 429, "description": "Too Many Requests",
                         "parameters": {"retry_after": 14}})])
    with pytest.raises(TelegramError) as ei:
        api.send_message(1, "x")
    assert ei.value.code == 429 and ei.value.retry_after == 14 and ei.value.retryable


def test_a_network_failure_never_shows_the_token():
    api, _ = bot([TransportError("network", "gaierror")])
    with pytest.raises(TelegramError) as ei:
        api.get_me()
    assert TOKEN not in str(ei.value) and ei.value.retryable


def test_a_description_echoing_the_token_is_redacted():
    api, _ = bot([(400, {"ok": False, "error_code": 400, "description": f"bad {TOKEN}"})])
    with pytest.raises(TelegramError) as ei:
        api.get_me()
    assert TOKEN not in str(ei.value)


def test_log_lines_with_the_token_are_redacted(caplog):
    import logging
    api, _ = bot([(200, {"ok": True, "result": {"username": "b"}})])
    api.get_me()                      # registers the token with the redactor
    rec = logging.LogRecord("x", logging.INFO, "f", 1, "url %s", (f"/bot{TOKEN}/x",), None)
    RedactingFilter().filter(rec)
    assert TOKEN not in rec.getMessage()


def test_no_token_no_call():
    t = FakeTransport([])
    api = TelegramBotAPI(lambda: "", t)
    with pytest.raises(TelegramError):
        api.get_me()
    assert t.requests == []


def test_send_without_message_id_is_an_error():
    api, _ = bot([(200, {"ok": True, "result": {}})])
    with pytest.raises(TelegramError):
        api.send_message(1, "x")
