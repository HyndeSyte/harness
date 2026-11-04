"""The one client that can write to Google: blocks on his Gmail calendar.

He makes a Google service account and shares his calendar with it, so there is no
sign-in to go stale, and it reaches only what he shared. Its key is kept like any other
(vault.py). The standard library has no RSA, so signing the sign-in token is done here:
it is one modular exponent, and the only thing it signs is that token.

Nothing here can add an attendee, a reminder, a repeat, a place or a description: the
event is built here from a title and two times, and no update ever goes out. Every event
carries a mark, and an id of a form only this code makes, so nothing here can change or
delete an event it didn't write: list_ours returns only marked ones, and the writes
refuse any other id.

An Outcome says what Google answered and nothing more. No answer, or a 5xx, is "unknown":
the id is fixed per block, so the next read's try finds it instead of doubling.

Only TransportError is caught, as in caldav.py: the stop signal must get through.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable
from urllib.parse import quote, urlencode

from .net import REDACT, TransportError

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/calendar/v3/calendars"
HOSTS = frozenset({"oauth2.googleapis.com", "www.googleapis.com"})
SCOPE = "https://www.googleapis.com/auth/calendar.events"    # events only, no calendar settings
MARK = {"harness": "family_gmail"}
TIMEOUT_S = 20
MAX_PAGES = 20
_ID_RE = re.compile(r"hb[0-9a-f]{32}")      # Google allows a-v and 0-9 in an id it's given
_EMAIL_RE = re.compile(r"[a-z0-9-]{1,64}@[a-z0-9-]{1,64}\.iam\.gserviceaccount\.com")
_ADDRESS_RE = re.compile(r"[^\s@/?#]{1,100}@[^\s@/?#]{1,100}")
# 1.2.840.113549.1.1.1, rsaEncryption, as it sits in a PKCS#8 key.
_RSA_OID = bytes.fromhex("2a864886f70d010101")
# What PKCS#1 v1.5 puts before a SHA-256 hash.
_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def event_id(key: str) -> str:
    return "hb" + hashlib.sha256(f"family_gmail:{key}".encode()).hexdigest()[:32]


# -- the key ------------------------------------------------------------------------

def _der(data: bytes, at: int) -> tuple[int, bytes, int]:
    """One DER value at `at`: its tag, its contents, and where the next one starts."""
    tag, size = data[at], data[at + 1]
    at += 2
    if size & 0x80:
        count = size & 0x7f
        if not 1 <= count <= 4:
            raise ValueError("bad length")
        size = int.from_bytes(data[at:at + count], "big")
        at += count
    if at + size > len(data):
        raise ValueError("cut short")
    return tag, data[at:at + size], at + size


def _rsa_numbers(pem: str) -> tuple[int, int, int]:
    """The modulus, public and private exponents, from a PKCS#8 key. ValueError on
    anything else. Never echoes what it was given."""
    try:
        head, foot = "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"
        body = pem.strip()
        if not (body.startswith(head) and body.endswith(foot)):
            raise ValueError
        der = base64.b64decode("".join(body[len(head):-len(foot)].split()), validate=True)
        _, outer, _ = _der(der, 0)
        _, _, at = _der(outer, 0)                      # version
        _, algorithm, at = _der(outer, at)
        _, oid, _ = _der(algorithm, 0)
        if oid != _RSA_OID:
            raise ValueError
        _, wrapped, _ = _der(outer, at)
        _, rsa, _ = _der(wrapped, 0)
        _, _, at = _der(rsa, 0)                        # its version
        numbers = []
        for _ in range(3):
            tag, value, at = _der(rsa, at)
            if tag != 2:
                raise ValueError
            numbers.append(int.from_bytes(value, "big"))
    except (ValueError, IndexError):
        raise ValueError("not an RSA private key") from None
    n, e, d = numbers
    if n.bit_length() < 2048 or e < 3 or d < 2:
        raise ValueError("not an RSA private key")
    return n, e, d


def check_key(value: str) -> str:
    """The service account key as stored, or ValueError. Never echoes what was pasted,
    and sends the key nowhere but Google's token address."""
    try:
        data = json.loads(value)
    except ValueError:
        raise ValueError("that isn't a Google service account key (a JSON file)") from None
    if not isinstance(data, dict) or data.get("type") != "service_account" \
            or not _EMAIL_RE.fullmatch(str(data.get("client_email", ""))) \
            or data.get("token_uri", TOKEN_URL) != TOKEN_URL:
        raise ValueError("that isn't a Google service account key (a JSON file)")
    _rsa_numbers(str(data.get("private_key", "")))
    return json.dumps({"type": "service_account", "client_email": data["client_email"],
                       "private_key": data["private_key"]}, sort_keys=True)


def sign(pem: str, message: bytes) -> bytes:
    """RSASSA-PKCS1-v1_5 with SHA-256. Checked with the public half before it's used, so
    a key that doesn't add up never goes out as a garbled request."""
    n, e, d = _rsa_numbers(pem)
    size = (n.bit_length() + 7) // 8
    block = _DIGEST_INFO + hashlib.sha256(message).digest()
    padded = b"\x00\x01" + b"\xff" * (size - len(block) - 3) + b"\x00" + block
    number = int.from_bytes(padded, "big")
    signature = pow(number, d, n)
    if pow(signature, e, n) != number:
        raise ValueError("not an RSA private key")
    return signature.to_bytes(size, "big")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def assertion(email: str, pem: str, now: datetime) -> str:
    """The signed token Google trades for an hour's access."""
    at = int(now.timestamp())
    head = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64(json.dumps({"iss": email, "scope": SCOPE, "aud": TOKEN_URL,
                              "iat": at, "exp": at + 3600}).encode())
    return f"{head}.{claims}.{_b64(sign(pem, f'{head}.{claims}'.encode()))}"


# -- the client ---------------------------------------------------------------------

@dataclass(frozen=True)
class Outcome:
    kind: str     # ok | gone | changed | exists | auth | denied | failed | unknown | no_key
    status: int | None = None


@dataclass(frozen=True)
class Block:
    id: str
    etag: str
    title: str
    start: datetime
    end: datetime
    plain: bool = True     # still only what this code wrote


def _plain(event: dict) -> bool:
    """A note, a place, a guest, a color, a reminder or a shown-as change makes it his."""
    if any(event.get(k) for k in ("description", "location", "attendees", "colorId")):
        return False
    if (event.get("reminders") or {}).get("overrides"):
        return False
    return event.get("visibility") in (None, "private") \
        and event.get("transparency") in (None, "opaque")


def _body(uid: str, title: str, start: datetime, end: datetime) -> dict:
    return {"id": uid, "summary": title, "status": "confirmed",
            "start": {"dateTime": start.isoformat()}, "end": {"dateTime": end.isoformat()},
            "visibility": "private", "transparency": "opaque",
            "reminders": {"useDefault": False},
            "guestsCanInviteOthers": False, "guestsCanSeeOtherGuests": False,
            "extendedProperties": {"private": dict(MARK)}}


def _ours(event: dict) -> bool:
    private = (event.get("extendedProperties") or {}).get("private") or {}
    return bool(_ID_RE.fullmatch(str(event.get("id", "")))) and private.get("harness") == MARK["harness"]


def _too_many(r) -> bool:
    """Google's 403 can mean slow down rather than no access. The reason is read, not shown."""
    try:
        errors = r.json()["error"]["errors"]
        return any(str(e.get("reason", "")).endswith(("ateLimitExceeded", "quotaExceeded"))
                   for e in errors)
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


class GoogleCalendar:
    def __init__(self, transport, key: Callable[[], str], clock: Callable[[], datetime]):
        self.transport = transport
        self.key = key                     # the stored service account key
        self.clock = clock
        self._token: tuple[str, str, datetime] | None = None   # (key it came from, token, until)

    def configured(self) -> bool:
        return bool(self.key())

    def account(self) -> str:
        """The address he shares the calendar with. Not a secret."""
        try:
            return json.loads(self.key()).get("client_email", "")
        except ValueError:
            return ""

    def _access(self) -> tuple[str | None, Outcome | None]:
        stored = self.key()
        if not stored:
            return None, Outcome("no_key")
        now = self.clock()
        if self._token and self._token[0] == stored and self._token[2] > now:
            return self._token[1], None
        try:
            data = json.loads(stored)
            REDACT.register(data["private_key"])
            jwt = assertion(data["client_email"], data["private_key"], now)
        except (ValueError, KeyError):
            return None, Outcome("auth")
        body = urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                          "assertion": jwt}).encode("ascii")
        try:
            r = self.transport.request("POST", TOKEN_URL, body=body, timeout=TIMEOUT_S, headers={
                "Content-Type": "application/x-www-form-urlencoded"})
        except TransportError:
            return None, Outcome("failed")     # no write has been sent
        if r.status != 200:
            return None, Outcome("unknown" if r.status >= 500 else "auth", r.status)
        try:
            answer = r.json()
            token = answer["access_token"]
            lasts = int(answer.get("expires_in", 3600))
        except (ValueError, KeyError, TypeError, AttributeError):
            return None, Outcome("failed", r.status)
        if not isinstance(token, str) or not token:
            return None, Outcome("failed", r.status)
        REDACT.register(token)
        self._token = (stored, token, now + timedelta(seconds=max(lasts - 60, 0)))
        return token, None

    def _call(self, token: str, method: str, url: str, *, body: dict | None = None,
              etag: str | None = None):
        headers = {"Authorization": "Bearer " + token}
        if etag:
            headers["If-Match"] = etag
        if body is not None:
            headers["Content-Type"] = "application/json"
        return self.transport.request(method, url, headers=headers, timeout=TIMEOUT_S,
                                      body=json.dumps(body).encode("utf-8") if body else None)

    @staticmethod
    def _events(address: str) -> str | None:
        """Never "primary": for a service account that is its own empty calendar."""
        if not _ADDRESS_RE.fullmatch(address or ""):
            return None
        return f"{API}/{quote(address, safe='')}/events"

    def _answer(self, r) -> Outcome:
        status = r.status
        if status == 401:
            self._token = None
            return Outcome("auth", status)
        if status == 429 or (status == 403 and _too_many(r)):
            return Outcome("unknown", status)  # the next read tries again
        if status in (403, 404):
            return Outcome("denied", status)   # not shared, or shared read-only
        return Outcome("unknown" if status >= 500 else "failed", status)

    def list_ours(self, address: str, start: datetime, end: datetime) -> tuple[list[Block] | None, Outcome | None]:
        """Our blocks in this window, as Google has them now. Reads only. No list when that
        can't be said, with why."""
        url = self._events(address)
        if url is None:
            return None, Outcome("failed")
        token, problem = self._access()
        if token is None:
            return None, problem
        out: list[Block] = []
        query = {"privateExtendedProperty": "harness=" + MARK["harness"], "singleEvents": "true",
                 "showDeleted": "false", "maxResults": "250",
                 "timeMin": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                 "timeMax": end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
        for _ in range(MAX_PAGES):
            try:
                r = self._call(token, "GET", f"{url}?{urlencode(query)}")
            except TransportError:
                return None, Outcome("failed")
            if r.status != 200:
                return None, self._answer(r)
            try:
                page = r.json()
                if page["kind"] != "calendar#events":
                    return None, Outcome("failed", r.status)
                for event in page.get("items", []):    # a page can hold none, and more follow
                    if _ours(event) and event.get("status") != "cancelled":
                        # One someone made all-day has a date for each time, and is his now.
                        timed = "dateTime" in event["start"]
                        side = "dateTime" if timed else "date"
                        out.append(Block(event["id"], event["etag"], event.get("summary", ""),
                                         datetime.fromisoformat(event["start"][side]),
                                         datetime.fromisoformat(event["end"][side]),
                                         timed and _plain(event)))
                following = page.get("nextPageToken")
            except (ValueError, KeyError, TypeError, AttributeError):
                return None, Outcome("failed", r.status)   # not read is not empty
            if not following:
                return out, None
            query["pageToken"] = following
        return None, Outcome("failed")         # more than it should ever be: don't guess

    def add(self, address: str, uid: str, title: str, start: datetime, end: datetime) -> Outcome:
        """A new block. Its id is fixed, so a write whose answer was lost finds itself rather
        than doubling, and is put right if the block has moved on since. "exists" is an id
        that can't be used: Google keeps a deleted one, and keeps next to nothing about it,
        so a block that comes back needs a new id (family_gmail.py)."""
        url = self._events(address)
        if url is None or not _ID_RE.fullmatch(uid):
            return Outcome("failed")
        token, problem = self._access()
        if token is None:
            return problem
        body = _body(uid, title, start, end)
        try:
            r = self._call(token, "POST", f"{url}?sendUpdates=none", body=body)
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status == 200:
            return Outcome("ok", r.status)
        if r.status != 409:
            return self._answer(r)
        try:
            r = self._call(token, "GET", f"{url}/{uid}")
            if r.status in (404, 410):
                return Outcome("exists", r.status)
            if r.status != 200:
                return self._answer(r)
            found = r.json()
            if not isinstance(found, dict) or not _ours(found) or found.get("status") == "cancelled":
                return Outcome("exists", r.status)
            if not _plain(found):
                return Outcome("changed", r.status)    # he got to it first: his now
            r = self._call(token, "PUT", f"{url}/{uid}?sendUpdates=none", body=body,
                           etag=found.get("etag"))
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        except ValueError:
            return Outcome("exists", r.status)
        if r.status == 412:
            return Outcome("unknown", r.status)
        return Outcome("ok", r.status) if r.status == 200 else self._answer(r)

    def really_gone(self, address: str, uid: str) -> bool:
        """Asked by id, because a list can come back short. Only a clear yes is a yes."""
        url = self._events(address)
        if url is None:
            return False
        token, _ = self._access()
        if token is None:
            return False
        try:
            r = self._call(token, "GET", f"{url}/{uid}")
            if r.status in (404, 410):
                return True
            return r.status == 200 and r.json().get("status") == "cancelled"
        except (TransportError, ValueError, AttributeError):
            return False

    def move(self, address: str, block: Block, title: str, start: datetime, end: datetime) -> Outcome:
        """Only as it was just read."""
        url = self._events(address)
        if url is None or not _ID_RE.fullmatch(block.id) or not block.etag:
            return Outcome("failed")
        token, problem = self._access()
        if token is None:
            return problem
        try:
            r = self._call(token, "PUT", f"{url}/{block.id}?sendUpdates=none",
                           body=_body(block.id, title, start, end), etag=block.etag)
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status == 200:
            return Outcome("ok", r.status)
        if r.status == 412:
            return Outcome("changed", r.status)
        if r.status == 410:
            return Outcome("gone", r.status)
        return self._answer(r)

    def remove(self, address: str, block: Block) -> Outcome:
        """Only as it was just read."""
        url = self._events(address)
        if url is None or not _ID_RE.fullmatch(block.id) or not block.etag:
            return Outcome("failed")
        token, problem = self._access()
        if token is None:
            return problem
        try:
            r = self._call(token, "DELETE", f"{url}/{block.id}?sendUpdates=none", etag=block.etag)
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 204):
            return Outcome("ok", r.status)
        if r.status == 410:
            return Outcome("gone", r.status)
        if r.status == 412:
            return Outcome("changed", r.status)
        return self._answer(r)
