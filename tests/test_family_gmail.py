"""0.7.0: his Gmail calendar kept true to Family, with no tap and no model.

All names and addresses are invented. The key is made here, for this run only.
"""
import base64
import hashlib
import json
import random
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from urllib.parse import parse_qs, unquote, urlsplit
from zoneinfo import ZoneInfo

import pytest

from harness import drive, effects, family_rules, google_cal
from harness.family_copy import FamilyCopy, plan as copy_plan
from harness.family_gmail import (DROP_TITLE, GIVE_UP_READS, HOLD_READS, MAX_WRITES_PER_DAY, PICK_TITLE, PROBLEM, PROVEN, TEST_TITLE,
                                  FamilyGmail, Rule, parse_rules, parse_school, rules_from_options, school_address_from_options, school_from_options)
from harness.net import REDACT, GoogleTransport, HttpResponse, TransportError
from harness.vault import FIELDS, Vault, VaultError
from fake_caldav import FAMILY_PATH, FakeICloud, no_network, props  # noqa: F401
from test_family_add import Rig, on, rig  # noqa: F401
from test_family_copy import Feeds, GMAIL, NY, TZ, day_occ, occ, on_family, seed, titles, when

ACCOUNT = "harness@pi-project-1.iam.gserviceaccount.com"
RULES = (Rule("kid sitting", "Busy (watching kids)"),)


# -- a key for this run -------------------------------------------------------------

def _prime(rng, bits):
    while True:
        n = rng.getrandbits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if all(pow(a, n - 1, n) == 1 for a in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29)):
            return n


def _len(n):
    if n < 128:
        return bytes([n])
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def _tlv(tag, value):
    return bytes([tag]) + _len(len(value)) + value


def _int(n):
    raw = n.to_bytes(n.bit_length() // 8 + 1, "big")
    return _tlv(2, raw)


def _pem(der):
    text = base64.encodebytes(der).decode().replace("\n", "")
    lines = [text[i:i + 64] for i in range(0, len(text), 64)]
    return "-----BEGIN PRIVATE KEY-----\n" + "\n".join(lines) + "\n-----END PRIVATE KEY-----\n"


def make_key(seed_value=7):
    rng = random.Random(seed_value)
    e = 65537
    while True:
        p, q = _prime(rng, 1024), _prime(rng, 1024)
        phi = (p - 1) * (q - 1)
        if p != q and phi % e:
            break
    n, d = p * q, pow(e, -1, phi)
    rsa = _tlv(0x30, _int(0) + _int(n) + _int(e) + _int(d) + _int(p) + _int(q) + _int(d % (p - 1))
               + _int(d % (q - 1)) + _int(pow(q, -1, p)))
    algorithm = _tlv(0x30, _tlv(6, bytes.fromhex("2a864886f70d010101")) + _tlv(5, b""))
    return _pem(_tlv(0x30, _int(0) + algorithm + _tlv(4, rsa))), n, e


PEM, N, E = make_key()
PEM_BYTES = base64.b64decode("".join(PEM.splitlines()[1:-1]))
KEY = json.dumps({"type": "service_account", "project_id": "pi-project-1", "private_key_id": "abc",
                  "private_key": PEM, "client_email": ACCOUNT, "client_id": "123",
                  "token_uri": google_cal.TOKEN_URL})


def verifies(signature, message, n=N, e=E):
    size = (n.bit_length() + 7) // 8
    block = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(message).digest()
    padded = b"\x00\x01" + b"\xff" * (size - len(block) - 3) + b"\x00" + block
    return len(signature) == size and pow(int.from_bytes(signature, "big"), e, n) == int.from_bytes(padded, "big")


# -- a fake Google, as strict as the real one on what this code relies on -------------

class FakeGoogle:
    def __init__(self):
        self.events = {}          # id -> event
        self.calls = []           # (method, path)
        self.token_calls = 0
        self.fail = {}            # method -> status or "drop"
        self.token_status = 200
        self.lose_answer = False  # do the write, then lose the answer
        self.shared = True
        self.empty_first_page = False
        self.full_tombstones = False
        self.n = 0

    def _etag(self):
        self.n += 1
        return f'"{self.n}"'

    def writes(self):
        return [c for c in self.calls if c[0] in ("POST", "PUT", "DELETE")]

    def live(self):
        return {k: v for k, v in self.events.items() if v["status"] != "cancelled"}

    def titles(self):
        return sorted(v["summary"] for v in self.live().values())

    def hand_edit(self, uid, **fields):
        self.events[uid].update(fields)
        self.events[uid]["etag"] = self._etag()

    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=30):
        parts = urlsplit(url)
        assert parts.scheme == "https" and parts.hostname in google_cal.HOSTS
        if url == google_cal.TOKEN_URL:
            return self._token(method, body)
        assert headers["Authorization"] == "Bearer tok-abcdefgh", "needs the token"
        self.calls.append((method, parts.path))
        failure = self.fail.get(method)
        if failure == "drop":
            raise TransportError("timeout")
        if failure:
            return HttpResponse(failure, {}, b"secret-looking text from google")
        if not self.shared:
            return HttpResponse(404, {}, b"{}")
        path = unquote(parts.path)
        assert path.startswith(f"/calendar/v3/calendars/{GMAIL}/events"), path
        assert "primary" not in path
        rest = path.split("/events", 1)[1].strip("/")
        query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        if method == "GET" and not rest:
            return self._list(query)
        if method != "GET":
            assert query.get("sendUpdates") == "none", "an update could go out"
        if method == "POST":
            return self._insert(json.loads(body))
        return self._one(method, rest, headers, body)

    def _token(self, method, body):
        assert method == "POST"
        self.token_calls += 1
        if self.token_status != 200:
            return HttpResponse(self.token_status, {}, b"{}")
        form = parse_qs(body.decode())
        head, claims, sig = form["assertion"][0].split(".")
        pad = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        assert verifies(pad(sig), f"{head}.{claims}".encode())
        c = json.loads(pad(claims))
        assert c["iss"] == ACCOUNT and c["aud"] == google_cal.TOKEN_URL and c["scope"] == google_cal.SCOPE
        assert json.loads(pad(head))["alg"] == "RS256" and c["exp"] - c["iat"] == 3600
        return HttpResponse(200, {}, json.dumps({"access_token": "tok-abcdefgh", "expires_in": 3600}).encode())

    def _list(self, query):
        assert query["singleEvents"] == "true" and query["showDeleted"] == "false"
        assert query.get("privateExtendedProperty", "harness=family_gmail") == "harness=family_gmail"
        low = datetime.fromisoformat(query["timeMin"])
        high = datetime.fromisoformat(query["timeMax"])
        items = []
        for e in self.live().values():
            if "privateExtendedProperty" not in query:          # everything in the window
                if "dateTime" not in e["start"]:
                    if e["start"]["date"] < high.date().isoformat() \
                            and e["end"]["date"] > low.date().isoformat():
                        items.append(e)
                    continue
            if "dateTime" not in e["start"]:
                items.append(e)
            elif datetime.fromisoformat(e["end"]["dateTime"]) > low \
                    and datetime.fromisoformat(e["start"]["dateTime"]) < high:
                items.append(e)
        token = query.get("pageToken")
        if self.empty_first_page and not token:    # Google: "none at all, even if there are more"
            return HttpResponse(200, {}, json.dumps({"kind": "calendar#events",
                                                     "nextPageToken": "more"}).encode())
        answer = {"kind": "calendar#events"}
        if items:                                  # Google needn't send it when empty
            answer["items"] = items
        return HttpResponse(200, {}, json.dumps(answer).encode())

    def _insert(self, event):
        uid = event["id"]
        assert all(c in "abcdefghijklmnopqrstuv0123456789" for c in uid) and 5 <= len(uid) <= 1024
        if uid in self.events:
            return HttpResponse(409, {}, b"{}")   # Google keeps a deleted id too
        assert not {"attendees", "location", "description", "recurrence"} & set(event)
        assert event["reminders"] == {"useDefault": False} and event["visibility"] == "private"
        self.events[uid] = {**self._local(event), "etag": self._etag()}
        return self._maybe_lost(HttpResponse(200, {}, json.dumps(self.events[uid]).encode()))

    @staticmethod
    def _local(event):
        """Times come back in the calendar's own offset, not as they were sent."""
        out = dict(event)
        for side in ("start", "end"):
            if "date" in event[side]:
                continue                       # an all-day date comes back as it went
            when_ = datetime.fromisoformat(event[side]["dateTime"]).astimezone(ZoneInfo("America/Chicago"))
            out[side] = {"dateTime": when_.isoformat()}
        return out

    def _maybe_lost(self, answer):
        if self.lose_answer:
            self.lose_answer = False
            raise TransportError("timeout")
        return answer

    def _one(self, method, uid, headers, body):
        e = self.events.get(uid)
        if e is None:
            return HttpResponse(404, {}, b"{}")
        if method == "GET":
            if e["status"] == "cancelled" and not self.full_tombstones:   # "only guaranteed the id"
                return HttpResponse(200, {}, json.dumps({"id": uid, "status": "cancelled"}).encode())
            return HttpResponse(200, {}, json.dumps(e).encode())
        assert headers.get("If-Match"), "a change must be only to what was just read"
        if headers["If-Match"] != e["etag"]:
            return HttpResponse(412, {}, b"{}")
        if method == "DELETE":
            if e["status"] == "cancelled":
                return HttpResponse(410, {}, b"{}")
            e["status"] = "cancelled"
            e["etag"] = self._etag()
            return HttpResponse(204, {}, b"")
        self.events[uid] = {**self._local(json.loads(body)), "etag": self._etag()}
        return self._maybe_lost(HttpResponse(200, {}, json.dumps(self.events[uid]).encode()))


@pytest.fixture
def g(on):
    on.feeds = Feeds()
    on.google = FakeGoogle()
    on.key = KEY
    on.rules = RULES
    on.client = google_cal.GoogleCalendar(on.google, lambda: on.key, on.clock)
    on.gm = FamilyGmail(on.ledger, on.fa, on.feeds, on.client, rules_fn=lambda: on.rules, tz=TZ)
    on.c.family_gmail = on.gm
    on.bot.sent.clear()
    return on


def go(rig):
    """A new read lands, and a tick looks at it."""
    rig.feeds.generation += 1
    rig.tick()


def sit(rig, days=3, hour=9, title="Kid sitting", **kw):
    return seed(rig, title, when(rig, days=days, hour=hour), **kw)


def problem(rig):
    return rig.ledger.get_meta(PROBLEM)


def only(rig):
    events = rig.google.live()
    assert len(events) == 1
    return next(iter(events.values()))


def count(rig, kind):
    return rig.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind=?", (kind,)).fetchone()[0]


# -- the setting ----------------------------------------------------------------------

@pytest.mark.parametrize("text, n", [
    ("Kid sitting => Busy (watching kids)", 1), (" Kid sitting=>Busy ", 1),
    ("A => Busy; B => Busy (other) ;", 2), ("A => On a call", 1), ("", 0), ("  ", 0)])
def test_rules_read(text, n):
    assert len(parse_rules(text)) == n


@pytest.mark.parametrize("text", [
    "Kid sitting", "=> Busy", "Kid sitting =>", "A => Watching kids",  # would copy back to Family
    "A => Busy https://evil.example", "A => Busy\nX-THING:1", "A => <b>Busy</b>",
    "A => Busy; B", "A => Busy /resume", ";".join(f"K{i} => Busy" for i in range(6)),
    "A => Busy " + "x" * 80])
def test_anything_off_leaves_it_off(text):
    assert parse_rules(text) == ()


def test_the_setting_is_read_from_the_options(tmp_path):
    assert rules_from_options(str(tmp_path)) == ()
    (tmp_path / "options.json").write_text('{"family_to_gmail": "A => Busy"}')
    assert rules_from_options(str(tmp_path)) == (Rule("a", "Busy"),)
    for bad in ('{"family_to_gmail": 5}', "not json", "[1]"):
        (tmp_path / "options.json").write_text(bad)
        assert rules_from_options(str(tmp_path)) == ()


def test_a_block_can_never_copy_back_to_family():
    for r in parse_rules("A => Busy (watching kids)"), parse_rules("A => On a call"):
        assert copy_plan([occ(r[0].title)], "Sam", TZ) == {}
    assert copy_plan([occ(TEST_TITLE)], "Sam", TZ) == {}


# -- the key --------------------------------------------------------------------------

def test_the_signature_is_real_rsa():
    assert verifies(google_cal.sign(PEM, b"hello"), b"hello")
    assert not verifies(google_cal.sign(PEM, b"hello"), b"other")


@pytest.mark.skipif(not shutil.which("openssl"), reason="no openssl here")
def test_openssl_agrees_with_the_key_and_the_signature(tmp_path):
    made = subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"],
                          capture_output=True, text=True, check=True).stdout
    (tmp_path / "k.pem").write_text(made)
    pub = subprocess.run(["openssl", "pkey", "-in", str(tmp_path / "k.pem"), "-pubout"],
                         capture_output=True, text=True, check=True).stdout
    (tmp_path / "p.pem").write_text(pub)
    (tmp_path / "m").write_bytes(b"the message")
    (tmp_path / "s").write_bytes(google_cal.sign(made, b"the message"))
    out = subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(tmp_path / "p.pem"), "-signature",
                          str(tmp_path / "s"), str(tmp_path / "m")], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr


@pytest.mark.parametrize("bad", [
    "not json", "[]", '{"type": "authorized_user"}',
    json.dumps({"type": "service_account", "client_email": ACCOUNT, "private_key": "nope"}),
    json.dumps({"type": "service_account", "client_email": "me@evil.example", "private_key": PEM}),
    json.dumps({"type": "service_account", "client_email": ACCOUNT, "private_key": PEM,
                "token_uri": "https://evil.example/token"})])
def test_a_key_that_isnt_one_is_refused_without_echoing_it(bad):
    with pytest.raises(ValueError) as e:
        google_cal.check_key(bad)
    assert "nope" not in str(e.value) and "evil" not in str(e.value)


def test_only_what_is_needed_is_stored(tmp_path):
    stored = json.loads(google_cal.check_key(KEY))
    assert set(stored) == {"type", "client_email", "private_key"}


def test_a_pretty_key_pasted_into_one_line_still_reads():
    assert google_cal.check_key(json.dumps(json.loads(KEY), indent=2).replace("\n", ""))


def test_the_vault_keeps_it_like_any_key(tmp_path, clock):
    v = Vault(str(tmp_path / "s.json"), clock=clock)
    assert "google_service_key" in FIELDS
    v.set_key("google_service_key", KEY, by="him")
    assert json.loads(v.get("google_service_key"))["client_email"] == ACCOUNT
    with pytest.raises(VaultError):
        v.set_key("google_service_key", "nope", by="him")


def test_a_short_key_is_refused():
    small = _pem(_tlv(0x30, _int(0) + _tlv(0x30, _tlv(6, bytes.fromhex("2a864886f70d010101")) + _tlv(5, b""))
                      + _tlv(4, _tlv(0x30, _int(0) + _int(3233) + _int(17) + _int(2753)))))
    with pytest.raises(ValueError):
        google_cal.sign(small, b"x")


def test_a_1024_bit_key_is_refused():
    rng = random.Random(3)
    p, q = _prime(rng, 512), _prime(rng, 512)
    n, e = p * q, 65537
    d = pow(e, -1, (p - 1) * (q - 1))
    rsa = _tlv(0x30, _int(0) + _int(n) + _int(e) + _int(d))
    algorithm = _tlv(0x30, _tlv(6, bytes.fromhex("2a864886f70d010101")) + _tlv(5, b""))
    weak = _pem(_tlv(0x30, _int(0) + algorithm + _tlv(4, rsa)))
    with pytest.raises(ValueError):
        google_cal.check_key(json.dumps({"type": "service_account", "client_email": ACCOUNT,
                                         "private_key": weak}))


def test_a_key_of_another_kind_is_refused():
    other = PEM_BYTES.replace(bytes.fromhex("2a864886f70d010101"), bytes.fromhex("2a864886f70d010102"))
    with pytest.raises(ValueError):
        google_cal.sign(_pem(other), b"x")


def test_the_key_and_token_are_kept_out_of_logs(g):
    sit(g)
    go(g)
    assert "tok-abcdefgh" not in REDACT("Bearer tok-abcdefgh")
    assert "PRIVATE KEY" not in REDACT(f"x {PEM} y")


# -- the transport ----------------------------------------------------------------------

@pytest.mark.parametrize("method, url", [
    ("GET", "https://evil.example/x"), ("GET", "http://www.googleapis.com/x"),
    ("GET", "https://www.googleapis.com:444/x"), ("GET", "https://a@www.googleapis.com/x"),
    ("TRACE", "https://www.googleapis.com/x"), ("GET", "https://calendar.google.com/x")])
def test_the_transport_goes_nowhere_else(method, url):
    with pytest.raises(TransportError) as e:
        GoogleTransport(google_cal.HOSTS).request(method, url)
    assert e.value.kind == "blocked"


# -- the test write --------------------------------------------------------------------

def test_the_first_read_proves_writing_works_and_leaves_nothing(g):
    go(g)
    assert g.ledger.get_meta(PROVEN)
    assert g.google.live() == {} and [c[0] for c in g.google.writes()] == ["POST", "DELETE"]
    assert not problem(g)
    assert not g.bot.sent


def test_the_test_event_runs_once(g):
    go(g)
    n = len(g.google.writes())
    go(g)
    assert len(g.google.writes()) == n


def test_if_google_refuses_nothing_else_happens_and_it_says_who_to_share_with(g):
    sit(g)
    g.google.shared = False
    go(g)
    assert g.google.live() == {} and g.ledger.get_meta(PROVEN) is None
    assert ACCOUNT in problem(g) and "Make changes and see all event details" in problem(g)
    assert ACCOUNT in g.gm.digest_line()


def test_once_shared_it_starts_on_its_own(g):
    sit(g)
    g.google.shared = False
    go(g)
    g.google.shared = True
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"] and not problem(g)


def test_a_refused_key_says_so_and_nothing_is_written(g):
    sit(g)
    g.google.token_status = 400
    go(g)
    assert g.google.calls == [] and "refused the service account key" in problem(g)


def test_a_share_thats_read_only_says_so(g):
    sit(g)
    g.google.fail["POST"] = 403
    go(g)
    assert "Make changes and see all event details" in problem(g) and g.ledger.get_meta(PROVEN) is None


def test_a_test_event_that_wont_come_off_says_what_it_is_and_nothing_else_is_written(g):
    sit(g)
    g.google.fail["DELETE"] = 500
    go(g)
    assert TEST_TITLE in problem(g) and g.ledger.get_meta(PROVEN) is None
    assert g.google.titles() == [TEST_TITLE]
    del g.google.fail["DELETE"]
    go(g)                                      # the same id: it finds itself, not a second one
    assert g.ledger.get_meta(PROVEN)
    assert g.google.titles() == ["Busy (watching kids)"]


def test_a_test_write_whose_answer_was_lost_doesnt_leave_a_stray(g):
    g.google.lose_answer = True
    go(g)
    assert g.google.titles() == [TEST_TITLE] and g.ledger.get_meta(PROVEN) is None
    go(g)
    assert g.google.live() == {} and g.ledger.get_meta(PROVEN)


# -- what gets a block -------------------------------------------------------------------

def test_a_named_family_event_gets_a_block_with_no_tap_card_or_model(g):
    calls = len(g.claude.calls)
    start = when(g)
    sit(g)
    go(g)
    e = only(g)
    assert e["summary"] == "Busy (watching kids)"
    assert datetime.fromisoformat(e["start"]["dateTime"]) == start
    assert datetime.fromisoformat(e["end"]["dateTime"]) == start + timedelta(hours=1)
    assert not g.bot.sent and len(g.claude.calls) == calls


def test_no_text_from_family_reaches_gmail(g):
    sit(g, extra=["LOCATION:12 Secret St", "DESCRIPTION:secret"])
    go(g)
    e = only(g)
    assert "Secret" not in json.dumps(e) and "secret" not in json.dumps(e)


def test_no_guest_reminder_or_repeat(g):
    sit(g)
    go(g)                                      # the fake refuses anything else, too
    e = only(g)
    assert not {"attendees", "recurrence", "location", "description"} & set(e)
    assert e["reminders"] == {"useDefault": False} and e["transparency"] == "opaque"
    assert e["visibility"] == "private"


@pytest.mark.parametrize("title", ["Kid sitting!", "Kid sitting at noon", "Sitting", "Kid"])
def test_only_the_whole_title(g, title):
    sit(g, title=title)
    go(g)
    assert g.google.live() == {}


def test_capitals_and_spaces_dont_matter(g):
    sit(g, title="KID  SITTING".replace("  ", " "))
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"]


def test_a_weekly_family_event_gets_a_block_each_week_within_60_days(g):
    sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    blocks = sorted(datetime.fromisoformat(e["start"]["dateTime"]) for e in g.google.live().values())
    assert len(blocks) in (8, 9)
    assert all(b - a == timedelta(days=7) for a, b in zip(blocks, blocks[1:]))


def test_a_weekly_event_keeps_its_local_hour_across_the_clock_change(g):
    d = when(g, days=1).date()
    g.icloud.seed(f"{FAMILY_PATH}local.ics", "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:local", "DTSTAMP:20260101T000000Z",
        f"DTSTART;TZID=America/New_York:{d:%Y%m%d}T093000",
        f"DTEND;TZID=America/New_York:{d:%Y%m%d}T103000", "SUMMARY:Kid sitting", "RRULE:FREQ=WEEKLY",
        "END:VEVENT", "END:VCALENDAR"]) + "\r\n")
    go(g)
    local = [datetime.fromisoformat(e["start"]["dateTime"]).astimezone(NY) for e in g.google.live().values()]
    assert len(local) >= 8 and {(t.hour, t.minute) for t in local} == {(9, 30)}
    assert len({t.utcoffset() for t in local}) == 2    # it did cross one


def test_a_copy_on_family_never_gets_a_block(g):
    start = when(g).astimezone(ZoneInfo("UTC"))
    fmt = "%Y%m%dT%H%M%SZ"
    g.icloud.seed(f"{FAMILY_PATH}hx-abc.ics", "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:hx-abc", f"DTSTAMP:{start:{fmt}}",
        f"DTSTART:{start:{fmt}}", f"DTEND:{start + timedelta(hours=1):{fmt}}", "SUMMARY:Kid sitting",
        "END:VEVENT", "END:VCALENDAR"]) + "\r\n")
    go(g)
    assert g.google.live() == {}


def test_all_day_gets_none(g):
    d = g.clock().astimezone(NY).date() + timedelta(days=3)
    g.icloud.seed(f"{FAMILY_PATH}day.ics", "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:day", "DTSTAMP:20260101T000000Z",
        f"DTSTART;VALUE=DATE:{d:%Y%m%d}", f"DTEND;VALUE=DATE:{d + timedelta(days=1):%Y%m%d}",
        "SUMMARY:Kid sitting", "END:VEVENT", "END:VCALENDAR"]) + "\r\n")
    go(g)
    assert g.google.live() == {} and count(g, "family_gmail_failed") == 0


def test_a_deleted_id_is_never_brought_back_even_if_google_says_whose_it_was(g):
    go(g)
    uid = google_cal.event_id("x")
    g.google.full_tombstones = True
    g.google.events[uid] = {"id": uid, "status": "cancelled", "etag": '"1"',
                            "extendedProperties": {"private": dict(google_cal.MARK)}}
    assert g.client.add(GMAIL, uid, "Busy", when(g), when(g, hour=10)).kind == "exists"
    assert g.google.live() == {}


def test_a_gone_from_gmail_count_starts_over_after_a_read_with_an_unreadable_event(g):
    seed(g, "Mom at work", when(g, days=5))
    sit(g)
    go(g)
    del g.google.events[only(g)["id"]]
    go(g)                                      # the first of two good reads
    strange = seed(g, "Strange", when(g, days=6), extra=["RRULE:FREQ=HOURLY"])
    go(g)
    del g.icloud.events[strange]
    go(g)
    state = g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"]
    assert state == "live"                     # one good read since, not two
    go(g)
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "removed"


def test_a_move_past_the_days_cap_says_so(g):
    path = sit(g)
    go(g)
    for i in range(MAX_WRITES_PER_DAY):
        g.ledger.event("family_gmail_moved", {"key": str(i)})
    _move(g, path, when(g, days=5))
    n = len(g.google.writes())
    go(g)
    assert len(g.google.writes()) == n and "wait for tomorrow" in problem(g)


def test_past_the_window_or_over_gets_none(g):
    sit(g, days=70)
    seed(g, "Kid sitting", g.clock().astimezone(NY) - timedelta(hours=3))
    go(g)
    assert g.google.live() == {}


def test_nothing_on_family_touches_family(g):
    path = sit(g)
    before = dict(on_family(g))
    go(g)
    assert on_family(g) == before and path in before


# -- moves and cancels -----------------------------------------------------------------

def _move(rig, path, start, title="Kid sitting"):
    utc, fmt = start.astimezone(ZoneInfo("UTC")), "%Y%m%dT%H%M%SZ"
    ics = on_family(rig)[path]
    p = props(ics)
    uid = p["UID"][0].split(":", 1)[1]
    rig.icloud.seed(path, "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{utc:{fmt}}",
        f"DTSTART:{utc:{fmt}}", f"DTEND:{utc + timedelta(hours=1):{fmt}}", f"SUMMARY:{title}",
        "END:VEVENT", "END:VCALENDAR"]) + "\r\n")


def test_moved_on_family_the_block_follows(g):
    path = sit(g)
    go(g)
    first = only(g)["id"]
    later = when(g, days=4, hour=14)
    _move(g, path, later)
    go(g)
    e = only(g)
    assert e["id"] == first and datetime.fromisoformat(e["start"]["dateTime"]) == later
    assert count(g, "family_gmail_moved") == 1


def test_one_day_of_a_series_moved_only_that_block_moves(g):
    start = when(g, days=3, hour=9)
    utc, fmt = start.astimezone(ZoneInfo("UTC")), "%Y%m%dT%H%M%SZ"
    next_week = utc + timedelta(days=7)
    moved = next_week + timedelta(hours=5)
    g.icloud.seed(f"{FAMILY_PATH}series.ics", "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0",
        "BEGIN:VEVENT", "UID:series", f"DTSTAMP:{utc:{fmt}}", f"DTSTART:{utc:{fmt}}",
        f"DTEND:{utc + timedelta(hours=1):{fmt}}", "SUMMARY:Kid sitting", "RRULE:FREQ=WEEKLY;COUNT=3",
        "END:VEVENT", "END:VCALENDAR"]) + "\r\n")
    go(g)
    assert len(g.google.live()) == 3
    g.icloud.seed(f"{FAMILY_PATH}series.ics", "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0",
        "BEGIN:VEVENT", "UID:series", f"DTSTAMP:{utc:{fmt}}", f"DTSTART:{utc:{fmt}}",
        f"DTEND:{utc + timedelta(hours=1):{fmt}}", "SUMMARY:Kid sitting", "RRULE:FREQ=WEEKLY;COUNT=3",
        "END:VEVENT",
        "BEGIN:VEVENT", "UID:series", f"DTSTAMP:{utc:{fmt}}", f"RECURRENCE-ID:{next_week:{fmt}}",
        f"DTSTART:{moved:{fmt}}", f"DTEND:{moved + timedelta(hours=1):{fmt}}", "SUMMARY:Kid sitting",
        "END:VEVENT", "END:VCALENDAR"]) + "\r\n")
    before = set(g.google.live())
    go(g)
    assert set(g.google.live()) == before
    assert count(g, "family_gmail_moved") == 1
    hours = sorted(datetime.fromisoformat(e["start"]["dateTime"]).astimezone(ZoneInfo("UTC"))
                   for e in g.google.live().values())
    assert moved in hours and next_week not in hours


def test_cancelled_takes_two_good_reads(g):
    seed(g, "Mom at work", when(g, days=5))
    path = sit(g)
    go(g)
    del g.icloud.events[path]
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"]
    go(g)
    assert g.google.live() == {} and count(g, "family_gmail_cancelled") == 1


def test_back_after_one_bad_read_nothing_changes(g):
    path = sit(g)
    go(g)
    keep = g.icloud.events.pop(path)
    go(g)
    g.icloud.events[path] = keep
    n = len(g.google.writes())
    go(g)
    go(g)
    assert len(g.google.live()) == 1 and len(g.google.writes()) == n


def test_cancelled_then_back_finds_its_old_id(g):
    seed(g, "Mom at work", when(g, days=5))
    path = sit(g)
    go(g)
    uid = only(g)["id"]
    keep = g.icloud.events.pop(path)
    go(g)
    go(g)
    assert g.google.live() == {}
    g.icloud.events[path] = keep
    go(g)                                      # Google keeps a deleted id, so a new one
    assert only(g)["id"] != uid and only(g)["status"] == "confirmed"
    assert not problem(g)


def test_an_id_that_cant_be_used_gets_the_next_one_on_the_next_read(g):
    go(g)
    want = when(g)
    used = google_cal.event_id(f"{_key_of(g, sit(g))}:0")
    g.google.events[used] = {"id": used, "status": "cancelled", "etag": '"1"'}
    go(g)
    assert g.google.live() == {}
    go(g)
    assert datetime.fromisoformat(only(g)["start"]["dateTime"]) == want and only(g)["id"] != used


def _key_of(rig, path):
    from harness.family_gmail import plan
    return next(iter(plan(rig.fa.client.items_between(rig.clock(), rig.clock() + timedelta(days=9), TZ).items, RULES)))


def test_a_restart_between_the_test_coming_off_and_the_record_doesnt_wedge_it(g):
    uid = google_cal.event_id("test:0")
    g.google.events[uid] = {"id": uid, "status": "cancelled", "etag": '"1"'}
    sit(g)
    go(g)
    go(g)
    go(g)
    assert g.ledger.get_meta(PROVEN) and g.google.titles() == ["Busy (watching kids)"]


def test_a_whole_series_ending_takes_all_its_blocks(g):
    """What 0.6's rule would have held forever as a bad read."""
    for i in range(6):
        sit(g, title="Mom at work", days=2 + i)    # the rest of Family
    path = sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    assert len(g.google.live()) >= 8
    del g.icloud.events[path]
    go(g)
    assert len(g.google.live()) >= 8
    go(g)
    assert g.google.live() == {} and not problem(g)


def test_a_read_that_comes_back_thin_is_held(g):
    paths = [sit(g, title="Mom at work", days=2 + i) for i in range(6)]
    path = sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    n = len(g.google.live())
    for p in paths:
        del g.icloud.events[p]
    del g.icloud.events[path]
    seed(g, "One left", when(g, days=5))
    go(g)
    go(g)
    assert len(g.google.live()) == n and "bad read" in problem(g)


def test_a_thin_read_that_stays_thin_is_just_family_now(g):
    paths = [sit(g, title="Mom at work", days=2 + i) for i in range(6)]
    path = sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    for p in paths:
        del g.icloud.events[p]
    del g.icloud.events[path]
    seed(g, "One left", when(g, days=5))
    for _ in range(HOLD_READS + 1):
        go(g)
    assert g.google.live() == {} and not problem(g)


def test_adds_still_go_during_a_hold(g):
    paths = [sit(g, title="Mom at work", days=2 + i) for i in range(6)]
    path = sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    n = len(g.google.live())
    for p in paths:
        del g.icloud.events[p]
    del g.icloud.events[path]
    sit(g, days=4, hour=15)
    go(g)
    go(g)
    assert "bad read" in problem(g) and len(g.google.live()) == n + 1


def test_a_family_event_it_cant_read_holds_removals_and_says_so(g):
    seed(g, "Mom at work", when(g, days=5))
    path = sit(g)
    go(g)
    del g.icloud.events[path]
    seed(g, "Strange", when(g, days=6), extra=["RRULE:FREQ=HOURLY"])
    for _ in range(3):
        go(g)
    assert len(g.google.live()) == 1
    assert "couldn't be read" in problem(g) and "couldn't be read" in g.gm.digest_line()


def test_an_unreadable_read_starts_the_two_reads_over(g):
    seed(g, "Mom at work", when(g, days=5))
    path = sit(g)
    go(g)
    del g.icloud.events[path]
    go(g)
    strange = seed(g, "Strange", when(g, days=6), extra=["RRULE:FREQ=HOURLY"])
    go(g)
    del g.icloud.events[strange]
    go(g)
    assert len(g.google.live()) == 1
    go(g)
    assert g.google.live() == {}


def test_an_empty_family_read_changes_nothing(g):
    path = sit(g)
    go(g)
    del g.icloud.events[path]
    for _ in range(3):
        go(g)
    assert len(g.google.live()) == 1 and "couldn't read the Family calendar" in problem(g)


def test_family_unreachable_changes_nothing(g):
    sit(g)
    go(g)
    g.fa.client = g.gm.client = _NoRead()
    n = len(g.google.writes())
    for _ in range(3):
        go(g)
    assert len(g.google.writes()) == n and "couldn't read" in problem(g)


class _NoRead:
    def items_between(self, *a):
        return None


def test_a_series_changing_time_moves_all_its_blocks(g):
    path = sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    n = len(g.google.live())
    g.icloud.events.pop(path)
    sit(g, hour=14, extra=["RRULE:FREQ=WEEKLY"])
    go(g)                                      # new ones first, old ones after two reads
    go(g)
    live = g.google.live().values()
    assert len(live) == n
    want = when(g, hour=14).astimezone(ZoneInfo("UTC")).hour     # seeded in UTC, so fixed there
    assert {datetime.fromisoformat(e["start"]["dateTime"]).astimezone(ZoneInfo("UTC")).hour
            for e in live} == {want}


# -- only its own -----------------------------------------------------------------------

def test_his_own_events_cant_be_changed(g):
    for uid in ("his-event", "abcd1234", "hb123"):
        block = google_cal.Block(uid, '"1"', "Dentist", when(g), when(g))
        assert g.client.remove(GMAIL, block).kind == "failed"
        assert g.client.move(GMAIL, block, "x", when(g), when(g)).kind == "failed"
        assert g.client.add(GMAIL, uid, "x", when(g), when(g)).kind == "failed"
    assert g.google.calls == []


def test_an_unmarked_event_with_our_kind_of_id_is_not_ours(g):
    go(g)
    uid = google_cal.event_id("x")
    g.google.events[uid] = {"id": uid, "status": "confirmed", "summary": "Dentist", "etag": '"9"',
                            "start": {"dateTime": when(g).isoformat()},
                            "end": {"dateTime": when(g).isoformat()}}
    assert g.client.add(GMAIL, uid, "Busy", when(g), when(g)).kind == "exists"
    assert g.google.events[uid]["summary"] == "Dentist"
    blocks, _ = g.client.list_ours(GMAIL, when(g, days=-1), when(g, days=9))
    assert blocks == []


def test_never_the_service_accounts_own_calendar(g):
    assert g.client.add("primary", google_cal.event_id("x"), "Busy", when(g), when(g)).kind == "failed"
    assert g.client.list_ours("primary", when(g), when(g))[0] is None
    assert g.google.calls == []


def test_a_block_he_edited_is_left_alone(g):
    path = sit(g)
    go(g)
    uid = only(g)["id"]
    g.google.hand_edit(uid, summary="Busy, moved to the park")
    n = len(g.google.writes())
    _move(g, path, when(g, days=5))
    go(g)
    del g.icloud.events[path]
    seed(g, "Other", when(g, days=4))
    go(g)
    go(g)
    assert only(g)["summary"] == "Busy, moved to the park" and len(g.google.writes()) == n
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "hands_off"


@pytest.mark.parametrize("edit", [
    {"description": "bring snacks"}, {"location": "the park"}, {"colorId": "5"},
    {"attendees": [{"email": "friend@example.com"}]}, {"visibility": "default"},
    {"transparency": "transparent"}, {"reminders": {"useDefault": False, "overrides": [{"minutes": 5}]}}])
def test_anything_he_added_keeps_the_block_his(g, edit):
    seed(g, "Mom at work", when(g, days=7))
    path = sit(g)
    go(g)
    uid = only(g)["id"]
    g.google.hand_edit(uid, **edit)
    n = len(g.google.writes())
    _move(g, path, when(g, days=5))
    go(g)
    del g.icloud.events[path]
    go(g)
    go(g)
    assert len(g.google.writes()) == n and next(iter(edit)) in only(g)
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "hands_off"


def test_a_list_that_comes_back_empty_for_hours_doesnt_orphan_the_blocks(g):
    sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    n = len(g.google.live())
    real = g.google.request

    def empty(method, url, **kw):
        if method == "GET" and "events?" in url:
            return HttpResponse(200, {}, b'{"kind": "calendar#events"}')
        return real(method, url, **kw)
    g.google.request = empty
    for _ in range(HOLD_READS + 3):
        go(g)
    assert problem(g)
    g.google.request = real
    go(g)
    states = {r["state"] for r in g.ledger.db.execute("SELECT state FROM family_gmail").fetchall()}
    assert states == {"live"} and len(g.google.live()) == n and not problem(g)
    assert count(g, "family_gmail_removed") == 0


def test_a_short_list_with_one_block_missing_doesnt_lose_it(g):
    sit(g)
    go(g)
    real = g.google.request

    def empty(method, url, **kw):
        if method == "GET" and "events?" in url:
            return HttpResponse(200, {}, b'{"kind": "calendar#events"}')
        return real(method, url, **kw)
    g.google.request = empty
    for _ in range(3):
        go(g)
    g.google.request = real
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "live"


def test_a_block_he_dragged_out_of_what_is_read_becomes_his_and_the_message_stops(g):
    sit(g)
    go(g)
    uid = only(g)["id"]
    far = datetime(2030, 1, 1, 9, tzinfo=NY)
    g.google.hand_edit(uid, start={"dateTime": far.isoformat()},
                       end={"dateTime": (far + timedelta(hours=1)).isoformat()})
    for _ in range(GIVE_UP_READS + 1):
        go(g)
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "hands_off"
    assert not problem(g)


def test_google_not_answering_about_one_block_keeps_it(g):
    sit(g)
    go(g)
    del g.google.events[only(g)["id"]]
    g.google.fail["GET"] = 500
    go(g)
    del g.google.fail["GET"]
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "live"


def test_a_note_he_added_after_a_lost_add_isnt_wiped(g):
    go(g)
    sit(g)
    g.google.lose_answer = True
    go(g)
    g.google.hand_edit(only(g)["id"], description="bring snacks")
    n = len(g.google.writes())
    go(g)
    writes = g.google.writes()[n:]
    assert all(c[0] == "POST" for c in writes) and only(g)["description"] == "bring snacks"
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "hands_off"
    assert not problem(g)


def test_a_lost_move_and_a_second_move_still_follows(g):
    path = sit(g)
    go(g)
    g.google.lose_answer = True
    _move(g, path, when(g, days=4))
    go(g)
    assert "didn't go through" in problem(g)
    later = when(g, days=5)
    _move(g, path, later)
    go(g)
    assert datetime.fromisoformat(only(g)["start"]["dateTime"]) == later
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "live"


def test_a_lost_add_and_a_move_puts_it_right(g):
    go(g)
    path = sit(g)
    g.google.lose_answer = True
    go(g)
    later = when(g, days=5)
    _move(g, path, later)
    go(g)
    assert datetime.fromisoformat(only(g)["start"]["dateTime"]) == later and not problem(g)


def test_a_block_he_removed_isnt_put_back(g):
    sit(g)
    go(g)
    del g.google.events[only(g)["id"]]
    n = len(g.google.writes())
    go(g)
    assert count(g, "family_gmail_removed") == 0   # one read can be wrong
    for _ in range(3):
        go(g)
    assert g.google.live() == {} and len(g.google.writes()) == n
    assert count(g, "family_gmail_removed") == 1


def test_a_block_he_made_all_day_is_his_and_doesnt_stop_the_rest(g):
    sit(g)
    go(g)
    uid = only(g)["id"]
    g.google.hand_edit(uid, start={"date": "2030-01-01"}, end={"date": "2030-01-02"})
    n = len(g.google.writes())
    sit(g, days=5)
    go(g)
    go(g)
    assert len(g.google.live()) == 2 and len(g.google.writes()) == n + 1 and not problem(g)
    states = {r["state"] for r in g.ledger.db.execute("SELECT state FROM family_gmail").fetchall()}
    assert states == {"hands_off", "live"}


def test_many_gone_from_gmail_at_once_is_held_for_a_while(g):
    sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    for uid in list(g.google.live()):
        del g.google.events[uid]
    go(g)
    assert "look gone from Gmail" in problem(g)
    rows = g.ledger.db.execute("SELECT state FROM family_gmail").fetchall()
    assert {r["state"] for r in rows} == {"live"}
    for _ in range(HOLD_READS):
        go(g)
    rows = g.ledger.db.execute("SELECT state FROM family_gmail").fetchall()
    assert {r["state"] for r in rows} == {"removed"} and not problem(g) and g.google.live() == {}


def test_many_gone_for_a_read_and_back_changes_nothing(g):
    sit(g, extra=["RRULE:FREQ=WEEKLY"])
    go(g)
    keep = dict(g.google.events)
    g.google.events.clear()
    go(g)
    g.google.events.update(keep)
    go(g)
    rows = g.ledger.db.execute("SELECT state, missing FROM family_gmail").fetchall()
    assert {r["state"] for r in rows} == {"live"} and not problem(g)


def test_a_changed_block_at_write_time_is_left_alone(g):
    path = sit(g)
    go(g)
    real = g.client.move
    g.client.move = lambda *a: google_cal.Outcome("changed")
    _move(g, path, when(g, days=5))
    go(g)
    g.client.move = real
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "hands_off"


# -- trouble ----------------------------------------------------------------------------

def test_a_lost_answer_doesnt_double(g):
    go(g)
    sit(g)
    g.google.lose_answer = True
    go(g)
    assert "didn't go through" in problem(g)
    go(g)
    assert len(g.google.live()) == 1 and not problem(g)


def test_a_list_that_fails_changes_nothing(g):
    path = sit(g)
    go(g)
    del g.icloud.events[path]
    seed(g, "Other", when(g, days=5))
    g.google.fail["GET"] = 500
    n = len(g.google.writes())
    for _ in range(3):
        go(g)
    assert len(g.google.writes()) == n and problem(g)
    del g.google.fail["GET"]
    go(g)
    assert len(g.google.writes()) == n     # one good read so far


def test_a_garbled_list_is_not_an_empty_one(g):
    sit(g)
    go(g)
    real = g.google.request

    def garbled(method, url, **kw):
        if method == "GET" and "events?" in url:
            return HttpResponse(200, {}, b'{"nothing": []}')   # not a list of events at all
        return real(method, url, **kw)
    g.google.request = garbled
    for _ in range(3):
        go(g)
    assert len(g.google.live()) == 1
    assert g.ledger.db.execute("SELECT state FROM family_gmail").fetchone()["state"] == "live"


def test_googles_words_never_reach_him(g):
    sit(g)
    go(g)
    sit(g, days=5)
    g.google.fail["POST"] = 500
    go(g)
    assert "secret-looking" not in problem(g) and "secret-looking" not in g.gm.digest_line()
    assert "500" not in problem(g)


def test_a_list_with_no_items_or_an_empty_page_still_reads(g):
    sit(g)
    g.google.empty_first_page = True
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"] and not problem(g)
    n = len(g.google.writes())
    go(g)
    assert len(g.google.writes()) == n     # it found the block on the second page


def test_one_refused_event_doesnt_stop_the_others(g):
    go(g)
    sit(g, days=3)
    sit(g, days=4)
    real = g.google.request
    seen = []

    def refuse_first(method, url, **kw):
        if method == "POST" and url.startswith(google_cal.API) and not seen:
            seen.append(1)
            return HttpResponse(400, {}, b"{}")
        return real(method, url, **kw)
    g.google.request = refuse_first
    go(g)
    assert len(g.google.live()) == 1 and "didn't go through" in problem(g)


def test_a_backwards_family_event_gets_none(g):
    seed(g, "Kid sitting", when(g), hours=0)
    go(g)
    assert g.google.live() == {} and not problem(g)


def test_google_saying_slow_down_isnt_taken_for_no_share(g):
    sit(g)
    go(g)
    sit(g, days=5)
    real = g.google.request

    def slow(method, url, **kw):
        if method == "POST" and url.startswith(google_cal.API):
            return HttpResponse(403, {}, json.dumps({"error": {"errors": [{"reason": "rateLimitExceeded"}]}}).encode())
        return real(method, url, **kw)
    g.google.request = slow
    go(g)
    assert "try again" in problem(g) and "Make changes" not in problem(g)


def test_a_stay_title_is_refused():
    assert parse_rules("A => Stay at Moms") == ()
    assert parse_rules("A => Stay at home")         # not a trip to family_copy.py either


def test_two_gmail_calendars_says_so(g):
    second = Feeds()
    second.window.calendar = "other@gmail.com"
    g.feeds.snapshot.feeds["b"] = second.snapshot.feeds["a"]
    assert "exactly one" in g.gm.status_line()


def test_the_days_cap_holds_and_says_so(g):
    for i in range(MAX_WRITES_PER_DAY + 4):
        sit(g, days=2 + i % 50, hour=6 + i % 12)
    go(g)
    assert len(g.google.live()) == MAX_WRITES_PER_DAY
    assert "4 more changes wait" in problem(g)
    g.advance(days=1)
    go(g)
    assert len(g.google.live()) > MAX_WRITES_PER_DAY - 3


def test_a_bug_is_a_record_not_a_stopped_loop(g):
    sit(g)
    g.gm.rules_fn = lambda: 1 / 0
    go(g)
    assert count(g, "family_gmail_failed") == 1


# -- when it runs ---------------------------------------------------------------------

def test_stop_stops_it(g):
    sit(g)
    g.say("/stop")
    go(g)
    assert g.google.calls == []
    g.say("/resume")
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"]


def test_only_after_a_new_read(g):
    sit(g)
    go(g)
    n = len(g.google.calls)
    g.tick()
    assert len(g.google.calls) == n


def test_off_with_no_rule(g):
    sit(g)
    g.rules = ()
    go(g)
    assert g.google.calls == [] and g.google.token_calls == 0
    assert "off" in g.gm.status_line()


def test_off_with_no_key(g):
    sit(g)
    g.key = ""
    go(g)
    assert g.google.token_calls == 0 and "waiting" in g.gm.status_line()


def test_off_while_adds_are_off(rig):
    rig.feeds = Feeds()
    rig.google = FakeGoogle()
    client = google_cal.GoogleCalendar(rig.google, lambda: KEY, rig.clock)
    rig.c.family_gmail = FamilyGmail(rig.ledger, rig.fa, rig.feeds, client, rules_fn=lambda: RULES, tz=TZ)
    go(rig)
    assert rig.google.token_calls == 0


def test_two_gmail_calendars_is_a_guess_so_nothing(g):
    second = Feeds()
    second.window.calendar = "other@gmail.com"
    g.feeds.snapshot.feeds["b"] = second.snapshot.feeds["a"]
    sit(g)
    go(g)
    assert g.google.token_calls == 0


def test_a_title_change_in_the_setting_retitles_the_blocks(g):
    sit(g)
    go(g)
    g.rules = (Rule("kid sitting", "Busy (kids)"),)
    go(g)
    assert g.google.titles() == ["Busy (kids)"]


def test_a_token_is_reused_until_it_runs_out(g):
    go(g)
    go(g)
    assert g.google.token_calls == 1
    g.advance(hours=2)
    go(g)
    assert g.google.token_calls == 2


def test_a_new_key_gets_a_new_token(g):
    go(g)
    g.key = KEY.replace('"abc"', '"def"')
    go(g)
    assert g.google.token_calls == 2


# -- what he sees --------------------------------------------------------------------

def test_status_and_digest_say_it(g):
    sit(g)
    go(g)
    assert g.gm.status_line() == "Blocks on Gmail from Family: on, 1 on Gmail now"
    assert g.gm.digest_line() == "Blocks on Gmail from Family: 1 added."


@pytest.mark.skipif(sys.platform == "win32", reason="status text uses a Linux date format")
def test_status_carries_it(g):
    assert "Blocks on Gmail" in g.c.status_text()


def test_silent_when_nothing_changed(g):
    go(g)
    assert g.gm.digest_line() == ""


def test_a_model_cant_propose_it():
    with pytest.raises(effects.ParamError):
        effects.lookup("family_gmail_sync", lambda s: True)


def test_both_directions_run_together_without_chasing(g):
    """Copies to Family and blocks to Gmail, side by side, read after read."""
    g.name = "Sam"
    copier = FamilyCopy(g.ledger, g.fa, g.feeds, name_fn=lambda: g.name, tz=TZ)
    g.c.family_copy = copier
    sit(g)
    g.feeds.window.occurrences = [occ("PT at the clinic", start=when(g, days=4))]
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"]
    block = only(g)
    g.feeds.window.occurrences.append(occ(block["summary"], start=when(g), uid=block["id"]))
    for _ in range(3):
        go(g)
    assert sorted(titles(g)) == ["Kid sitting", "Sam - PT"]
    assert g.google.titles() == ["Busy (watching kids)"]


# -- school runs ----------------------------------------------------------------------

@pytest.fixture
def school(g):
    g.rules = ()
    g.gm.school_fn = lambda: ("school day",)
    g.feeds.window.occurrences.append(occ("Filler", start=when(g, days=40, hour=20)))
    return g


def school_day(rig, days=3):
    return seed(rig, "School Day", when(rig, days=days, hour=8, minute=30), hours=6.75)


def mine(rig, title, days=3, hour=8, minute=0, hours=1):
    event = occ(title, start=when(rig, days=days, hour=hour, minute=minute), hours=hours)
    rig.feeds.window.occurrences.append(event)
    return event


def local(rig):
    """Times as the fake hands them back may carry any offset, so compare moments."""
    out = []
    for v in rig.google.live().values():
        out.append((v["summary"], datetime.fromisoformat(v["start"]["dateTime"]).astimezone(NY).strftime("%H:%M"),
                    datetime.fromisoformat(v["end"]["dateTime"]).astimezone(NY).strftime("%H:%M")))
    return sorted(out)


def test_a_school_day_gets_a_drop_off_and_a_pickup(school):
    school_day(school)
    go(school)
    assert local(school) == [("Busy (school drop-off)", "08:00", "08:45"), ("Busy (school pickup)", "15:00", "15:45")]


def test_a_closed_day_has_no_blocks(school):
    seed(school, "No School", when(school, days=3, hour=8, minute=30), hours=6.75)
    go(school)
    assert school.google.live() == {}


def test_blocks_follow_a_school_day_that_moves(school):
    path = school_day(school)
    go(school)
    del school.icloud.events[path]
    seed(school, "School Day", when(school, days=3, hour=9, minute=30), hours=6.75)
    go(school)
    go(school)
    assert ("Busy (school drop-off)", "09:00", "09:45") in local(school)
    assert len(local(school)) == 2


def test_blocks_come_off_when_the_school_day_is_cancelled(school):
    path = school_day(school)
    seed(school, "Someone else's event", when(school, days=5))
    go(school)
    del school.icloud.events[path]
    go(school)
    assert len(school.google.live()) == 2      # one read is never enough
    go(school)
    assert school.google.live() == {}


def test_an_event_of_his_over_drop_off_leaves_pickup(school):
    school_day(school)
    mine(school, "PT at the clinic", hour=8)
    go(school)
    assert [r[0] for r in local(school)] == ["Busy (school pickup)"]


def test_an_event_of_his_over_pickup_leaves_drop_off(school):
    school_day(school)
    mine(school, "Eye doctor", hour=15, hours=2)
    go(school)
    assert [r[0] for r in local(school)] == ["Busy (school drop-off)"]


def test_an_event_ending_as_the_run_starts_is_no_conflict(school):
    school_day(school)
    mine(school, "PT at the clinic", hour=14)      # over at 3:00, and pickup starts at 3:00
    go(school)
    assert len(local(school)) == 2


@pytest.mark.parametrize("title", ["Busy (interim)", "Busy", "busy (watching kids)"])
def test_a_busy_hold_is_no_conflict(school, title):
    school_day(school)
    mine(school, title, hour=14, hours=2)
    go(school)
    assert len(local(school)) == 2


def test_an_event_marked_free_is_no_conflict(school):
    school_day(school)
    school.feeds.window.occurrences.append(occ("Webinar", start=when(school, hour=8), transparent=True))
    go(school)
    assert len(local(school)) == 2


def test_its_own_blocks_never_count_as_a_conflict(school):
    school_day(school)
    go(school)
    for v in list(school.google.live().values()):
        start = datetime.fromisoformat(v["start"]["dateTime"])
        school.feeds.window.occurrences.append(occ(v["summary"], start=start, uid=v["id"] + "@google.com"))
    go(school)
    go(school)
    assert len(local(school)) == 2


def test_a_birthday_is_no_conflict_but_a_trip_is(school):
    school_day(school)
    day = when(school).date()
    school.feeds.window.occurrences.append(day_occ("Cousin's birthday", day, day))
    go(school)
    assert len(local(school)) == 2
    school.feeds.window.occurrences.append(day_occ("Stay at Hotel", day - timedelta(days=1), day))
    go(school)
    go(school)
    assert school.google.live() == {}


def test_a_trip_ending_the_day_before_is_no_conflict(school):
    school_day(school)
    day = when(school).date()
    school.feeds.window.occurrences.append(day_occ("Stay at Hotel", day - timedelta(days=2), day - timedelta(days=1)))
    go(school)
    assert len(local(school)) == 2


def test_a_block_comes_off_for_a_new_conflict_and_returns_when_it_goes(school):
    school_day(school)
    go(school)
    event = mine(school, "PT at the clinic", hour=8)
    go(school)
    go(school)
    assert [r[0] for r in local(school)] == ["Busy (school pickup)"]
    school.feeds.window.occurrences.remove(event)
    go(school)
    assert len(local(school)) == 2


def test_one_unreadable_event_keeps_what_is_there_and_still_adds(school):
    school_day(school)
    school.feeds.window.unreadable = 1
    go(school)
    assert len(local(school)) == 2             # or one odd old event stops new blocks for good
    mine(school, "PT at the clinic", hour=8)
    go(school)
    go(school)
    assert len(local(school)) == 2             # kept while part of it can't be read
    school.feeds.window.unreadable = 0
    go(school)
    go(school)
    assert [r[0] for r in local(school)] == ["Busy (school pickup)"]


def test_with_no_read_of_gmail_it_adds_nothing_and_says_so(school):
    school_day(school)
    school.feeds.snapshot.feeds["a"].ahead = None
    go(school)
    assert school.google.live() == {}
    assert "couldn't read your Gmail" in problem(school)


def test_a_real_event_whose_id_starts_like_a_block_still_counts(school):
    school_day(school)
    school.feeds.window.occurrences.append(occ("PT at the clinic", start=when(school, hour=8), uid="hbreal123@google.com"))
    go(school)
    assert [r[0] for r in local(school)] == ["Busy (school pickup)"]


def test_two_school_events_on_one_day_are_one_pair_of_blocks(school):
    school_day(school)
    seed(school, "school day", when(school, days=3, hour=8, minute=30), hours=6.75)
    go(school)
    go(school)
    assert len(local(school)) == 2


def test_an_empty_gmail_read_removes_nothing(school):
    school_day(school)
    go(school)
    school.feeds.window.occurrences.clear()
    go(school)
    go(school)
    assert len(local(school)) == 2


def test_a_block_he_removed_stays_removed(school):
    school_day(school)
    go(school)
    uid = next(iter(school.google.live()))
    school.google.events[uid]["status"] = "cancelled"
    for _ in range(3):
        go(school)
    assert len(school.google.live()) == 1


def test_a_school_run_can_never_copy_back_to_family():
    assert copy_plan([occ(DROP_TITLE), occ(PICK_TITLE)], "Sam", TZ) == {}


def test_a_school_setting_alone_turns_it_on(school):
    assert "on, 0" in school.gm.status_line()


@pytest.mark.parametrize("text, want", [
    ("School Day", ("school day",)), (" A ; B ;", ("a", "b")), ("", ()), ("  ", ()),
    (";".join(f"K{i}" for i in range(6)), ()), ("x" * 101, ())])
def test_the_school_setting(text, want):
    assert parse_school(text) == want


def test_the_school_setting_is_read_from_the_options(tmp_path):
    assert school_from_options(str(tmp_path)) == ()
    (tmp_path / "options.json").write_text('{"family_school": "School Day"}')
    assert school_from_options(str(tmp_path)) == ("school day",)
    for bad in ('{"family_school": 5}', "not json", "[1]"):
        (tmp_path / "options.json").write_text(bad)
        assert school_from_options(str(tmp_path)) == ()

# -- how far an event is from a school run ------------------------------------------

class FakeDrives:
    """Minutes by place, and what was asked."""

    def __init__(self, places):
        self.places = places
        self.asked = []

    def begin(self):
        pass

    def on(self):
        return True

    def misread(self):
        return False

    def minutes(self, place):
        self.asked.append(place)
        return self.places.get(place, drive.NO_ADDRESS)


def at_place(rig, title, place, hour, minute=0, hours=1):
    event = occ(title, start=when(rig, days=3, hour=hour, minute=minute), hours=hours, location=place)
    rig.feeds.window.occurrences.append(event)
    return event


def runs(rig):
    return [r[0] for r in local(rig)]


def test_going_straight_on_to_a_nearby_appointment_keeps_the_run(school):
    school.gm.drives = FakeDrives({"Near": 11})
    school_day(school)
    at_place(school, "Eye doctor", "Near", 8, 30)      # off at 8:15, there by 8:26
    go(school)
    assert len(runs(school)) == 2
    assert not problem(school)


def test_an_appointment_too_far_to_reach_after_drop_off_takes_the_run(school):
    school.gm.drives = FakeDrives({"Far": 60})
    school_day(school)
    at_place(school, "Specialist", "Far", 8, 30)
    go(school)
    assert runs(school) == ["Busy (school pickup)"]


def test_an_appointment_too_far_to_get_back_from_takes_the_pickup(school):
    school.gm.drives = FakeDrives({"Far": 60})
    school_day(school)
    at_place(school, "Specialist", "Far", 13, 30)      # over at 2:30, school by 3:15 needs 45 minutes
    go(school)
    assert runs(school) == ["Busy (school drop-off)"]


def test_an_appointment_ending_at_three_nearby_keeps_the_pickup(school):
    school.gm.drives = FakeDrives({"Near": 11})
    school_day(school)
    at_place(school, "PT at the clinic", "Near", 14)
    go(school)
    assert len(runs(school)) == 2


def test_exactly_enough_time_is_enough(school):
    school.gm.drives = FakeDrives({"Exact": 15})
    school_day(school)
    at_place(school, "Eye doctor", "Exact", 8, 30)
    go(school)
    assert len(runs(school)) == 2


def test_during_the_trip_to_school_takes_the_run_whatever_the_address(school):
    school.gm.drives = FakeDrives({"Near": 1})
    school_day(school)
    at_place(school, "Quick one", "Near", 8, 10)
    go(school)
    assert runs(school) == ["Busy (school pickup)"]


def test_with_no_address_the_run_stays_and_the_digest_gives_only_the_time(school):
    school.gm.drives = FakeDrives({})
    school_day(school)
    event = at_place(school, "Secret visit", "", 8, 30)
    go(school)
    assert len(runs(school)) == 2
    assert "no address" in problem(school)
    assert f"{event.start.day}, 8:30" in problem(school)
    assert "Secret" not in problem(school)


def test_a_failed_lookup_keeps_the_run_and_says_so(school):
    school.gm.drives = FakeDrives({"Somewhere": drive.FAILED})
    school_day(school)
    at_place(school, "Specialist", "Somewhere", 8, 30)
    go(school)
    assert len(runs(school)) == 2
    assert "couldn't look up a drive time" in problem(school)


def test_an_event_far_from_any_run_is_never_looked_up(school):
    drives = FakeDrives({"Far": 60})
    school.gm.drives = drives
    school_day(school)
    at_place(school, "Lunch", "Far", 11, 30, hours=0.5)  # more than three hours from both
    go(school)
    assert drives.asked == []
    assert len(runs(school)) == 2


@pytest.mark.parametrize("title,free", [("Busy (interim)", False), ("Webinar", True)])
def test_holds_and_free_events_are_never_looked_up(school, title, free):
    drives = FakeDrives({"Far": 60})
    school.gm.drives = drives
    school_day(school)
    school.feeds.window.occurrences.append(occ(title, start=when(school, days=3, hour=8, minute=30),
                                               location="Far", transparent=free))
    go(school)
    assert drives.asked == []
    assert len(runs(school)) == 2


def test_with_no_school_address_nothing_is_looked_up(school):
    drives = FakeDrives({"Far": 60})
    drives.on = lambda: False
    school.gm.drives = drives
    school_day(school)
    at_place(school, "Specialist", "Far", 8, 30)
    go(school)
    assert drives.asked == []
    assert len(runs(school)) == 2
    assert not problem(school)


def test_the_school_address_is_read_from_the_options(tmp_path):
    assert school_address_from_options(str(tmp_path)) == ""
    (tmp_path / "options.json").write_text('{"family_school_address": " 1 Main St, Town "}')
    assert school_address_from_options(str(tmp_path)) == "1 Main St, Town"
    (tmp_path / "options.json").write_text('{"family_school_address": 5}')
    assert school_address_from_options(str(tmp_path)) == ""


def test_a_school_address_it_cant_use_says_so(school):
    drives = FakeDrives({})
    drives.on = lambda: False
    drives.misread = lambda: True
    school.gm.drives = drives
    school_day(school)
    go(school)
    assert "doesn't look like a street address" in problem(school)


def test_a_finished_event_is_not_named_as_missing_an_address(school):
    school.gm.drives = FakeDrives({})
    school_day(school, days=0)
    school.feeds.window.occurrences.append(occ("Done", start=school.clock() - timedelta(hours=1), location=""))
    go(school)
    assert "no address" not in problem(school)


def test_real_lookups_reach_the_decision(school, tmp_path):
    from harness.net import HttpResponse as Answer

    class Maps:
        def request(self, method, url, *, headers=None, timeout=30):
            if "/route/" in url:
                return Answer(200, {}, b'{"routes": [{"duration": 3600}]}')
            return Answer(200, {}, b'[{"lat": "1.0", "lon": "2.0"}]')

    school.gm.drives = drive.Drives(school.ledger, Maps(), lambda: "1 School St, Town, VA", sleep=lambda s: None)
    school_day(school)
    at_place(school, "Specialist", "The Clinic, 2 Clinic Rd, Town, VA 12345", 8, 30)
    go(school)
    assert runs(school) == ["Busy (school pickup)"]


# -- 0.10.1: no hour's wait -------------------------------------------------------------------

def test_a_cancelled_event_gets_its_second_look_in_minutes(g):
    seed(g, "Mom at work", when(g, days=5))
    path = sit(g)
    go(g)
    assert g.feeds.soon == []                  # nothing waiting: the usual reads
    del g.icloud.events[path]
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"] and g.feeds.soon == [timedelta(minutes=2)]
    go(g)
    assert g.google.live() == {}


def test_many_cancelled_at_once_wait_for_the_usual_reads(g):
    paths = [sit(g, days=d) for d in (2, 3, 4, 5)]
    seed(g, "Mom at work", when(g, days=6))
    go(g)
    for path in paths:
        del g.icloud.events[path]
    go(g)
    assert g.feeds.soon == []                  # that's the guard against a bad read


def test_a_block_no_rule_wants_comes_off_on_the_first_read(g):
    said = [family_rules.Rule("kid sitting", "kids")]
    g.gm.said_fn = lambda: tuple(said)
    sit(g)
    go(g)
    said[0] = family_rules.Rule("kid sitting", "none")      # he says it means nothing; the event stays on Family
    go(g)
    assert g.google.live() == {} and count(g, "family_gmail_cancelled") == 1


def test_a_setting_that_reads_empty_takes_nothing_off_at_once(g):
    g.gm.said_fn = lambda: (family_rules.Rule("Book club", "none"),)    # so it still runs
    seed(g, "Mom at work", when(g, days=5))
    sit(g)
    go(g)
    g.rules = ()                               # the add-on's options failed to read
    go(g)
    assert g.google.titles() == ["Busy (watching kids)"]
