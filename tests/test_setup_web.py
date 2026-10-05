"""The settings page: who may reach it, who may change it, what it never shows."""
import http.client
import queue
import re
from urllib.parse import urlencode

import pytest

from harness.setup_web import SetupApp, serve
from harness.vault import Vault

TOKEN = "123456789:AAEhBP0av28aH3sT9_" + "x" * 18
AKEY = "sk-ant-api03-" + "A" * 40
OKEY = "sk-proj-" + "B" * 40
OWNER_HA = {"X-Remote-User-Id": "u-owner", "X-Remote-User-Display-Name": "Owner"}
KID = {"X-Remote-User-Id": "u-kid", "X-Remote-User-Display-Name": "Kid"}


@pytest.fixture
def site(tmp_path):
    vault = Vault(str(tmp_path / "secrets.json"))
    status = {"stage": "S1", "bot": "example_harness_bot"}
    reqs = queue.Queue()
    app = SetupApp(vault, status, reqs, allowed_peers=("127.0.0.1",))
    httpd = serve(app, host="127.0.0.1", port=0)
    yield app, httpd.server_address[1], vault, reqs
    httpd.shutdown()


def call(port, method, path="/", headers=None, form=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    body = urlencode(form) if form is not None else None
    h = dict(headers or {})
    if body is not None:
        h["Content-Type"] = "application/x-www-form-urlencoded"
    c.request(method, path, body=body, headers=h)
    r = c.getresponse()
    data = r.read().decode()
    loc = r.getheader("Location")
    csp = r.getheader("Content-Security-Policy")
    c.close()
    return r.status, data, loc, csp


def csrf(page):
    return re.search(r'name="csrf" value="([^"]+)"', page).group(1)


def test_requests_without_an_ingress_user_are_refused(site):
    _, port, _, _ = site
    assert call(port, "GET")[0] == 403


def test_requests_from_anywhere_but_the_ingress_proxy_are_refused(tmp_path):
    app = SetupApp(Vault(str(tmp_path / "s.json")), {}, queue.Queue(),
                   allowed_peers=("172.30.32.2",))
    httpd = serve(app, host="127.0.0.1", port=0)
    try:
        assert call(httpd.server_address[1], "GET", headers=OWNER_HA)[0] == 403
    finally:
        httpd.shutdown()


def test_save_needs_the_page_token(site):
    _, port, vault, _ = site
    status, *_ = call(port, "POST", "/save", OWNER_HA, {"telegram_bot_token": TOKEN})
    assert status == 403 and vault.get("telegram_bot_token") == ""


def test_first_saver_owns_the_page_and_keys_are_never_shown_back(site):
    _, port, vault, _ = site
    status, page, _, csp = call(port, "GET", headers=OWNER_HA)
    assert status == 200 and "default-src 'none'" in csp
    status, _, loc, _ = call(port, "POST", "/save", OWNER_HA,
                             {"csrf": csrf(page), "telegram_bot_token": TOKEN,
                              "anthropic_api_key": AKEY, "openai_api_key": OKEY})
    assert status == 303 and loc.startswith("./?m=")
    assert vault.get("anthropic_api_key") == AKEY
    _, page, _, _ = call(port, "GET", headers=OWNER_HA)
    for secret in (TOKEN, AKEY, OKEY):
        assert secret not in page
    assert page.count("set 20") == 3
    # someone else logged into Home Assistant can look, not change
    _, kid_page, _, _ = call(port, "GET", headers=KID)
    assert "Only Owner can change settings here" in kid_page and "<form" not in kid_page
    status, *_ = call(port, "POST", "/save", KID, {"csrf": csrf(page), "openai_api_key": OKEY})
    assert status == 403


def test_pairing_link_appears_once_the_token_is_set(site):
    _, port, vault, _ = site
    _, page, _, _ = call(port, "GET", headers=OWNER_HA)
    assert "t.me/" not in page
    call(port, "POST", "/save", OWNER_HA, {"csrf": csrf(page), "telegram_bot_token": TOKEN})
    _, page, _, _ = call(port, "GET", headers=OWNER_HA)
    m = re.search(r"https://t\.me/example_harness_bot\?start=([A-Za-z0-9_-]{22})", page)
    assert m and vault.pairing_active()
    assert vault.try_pair(m.group(1), user_id=5, chat_id=5) == "paired"


def test_after_pairing_saves_become_requests_for_his_tap(site):
    _, port, vault, _ = site
    vault.claim_setup_user("u-owner", "Owner")
    vault.set_key("openai_api_key", OKEY, by="Owner")
    vault.try_pair(vault.new_pairing_code(), user_id=5, chat_id=5)
    _, page, _, _ = call(port, "GET", headers=OWNER_HA)
    new = "sk-proj-" + "D" * 40
    _, _, loc, _ = call(port, "POST", "/save", OWNER_HA, {"csrf": csrf(page), "openai_api_key": new})
    assert "approval" in loc
    assert vault.get("openai_api_key") == OKEY and vault.pending()["field"] == "openai_api_key"
    _, _, loc, _ = call(port, "POST", "/save", OWNER_HA, {"csrf": csrf(page), "openai_api_key": new,
                                                      "anthropic_api_key": AKEY})
    assert "one key at a time" in loc.replace("%20", " ")


def test_reset_is_confirmed_and_handed_to_the_controller(site):
    _, port, vault, reqs = site
    _, page, _, _ = call(port, "GET", headers=OWNER_HA)
    call(port, "POST", "/save", OWNER_HA, {"csrf": csrf(page), "telegram_bot_token": TOKEN})
    call(port, "POST", "/reset", OWNER_HA, {"csrf": csrf(page), "confirm": "yes"})
    assert reqs.empty()
    call(port, "POST", "/reset", OWNER_HA, {"csrf": csrf(page), "confirm": "RESET"})
    assert reqs.get_nowait() == {"type": "reset", "by": "Owner"}


def test_oversized_bodies_are_refused(site):
    _, port, _, _ = site
    status, *_ = call(port, "POST", "/save", OWNER_HA, {"csrf": "x", "pad": "y" * 20000})
    assert status == 400
