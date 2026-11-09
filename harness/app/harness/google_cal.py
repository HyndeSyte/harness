"""The one client that can write to Google: blocks on his Gmail calendar, and what he asks for.

He makes a Google service account and shares his calendar with it, so there is no
sign-in to go stale, and it reaches only what he shared. Its key is kept like any other
(vault.py). The standard library has no RSA, so signing the sign-in token is done here:
it is one modular exponent, and the only thing it signs is that token.

Nothing here can add an attendee, a repeat, a place or a description: the event is built
here from a title and two times, and no update ever goes out. It asks for no reminder, but
Google still applies his defaults, which a service account can't change. Every event
carries a mark, and an id of a form only this code makes, so the sync can't change or
delete an event it didn't write: list_ours returns only marked ones, and its writes
refuse any other id. Only the methods marked for calendar_change.py reach other events, and
only for a change he asked for. No update goes out from those either.

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
from datetime import date, datetime, timedelta, timezone
from typing import Callable
from urllib.parse import quote, urlencode

from . import ical
from .net import REDACT, TransportError

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/calendar/v3/calendars"
HOSTS = frozenset({"oauth2.googleapis.com", "www.googleapis.com"})
SCOPE = "https://www.googleapis.com/auth/calendar.events"    # events only, no calendar settings
MARK = {"harness": "family_gmail"}
TIMEOUT_S = 20
MAX_PAGES = 20
_ID_RE = re.compile(r"hb[0-9a-f]{32}")      # Google allows a-v and 0-9 in an id it's given
_ANY_ID_RE = re.compile(r"[a-zA-Z0-9_-]{1,1024}")     # one day of a series is its id, _, a time
_EMAIL_RE = re.compile(r"[a-z0-9-]{1,64}@[a-z0-9-]{1,64}\.iam\.gserviceaccount\.com")
_ADDRESS_RE = re.compile(r"[^\s@/?#]{1,100}@[^\s@/?#]{1,100}")
# 1.2.840.113549.1.1.1, rsaEncryption, as it sits in a PKCS#8 key.
_RSA_OID = bytes.fromhex("2a864886f70d010101")
# What PKCS#1 v1.5 puts before a SHA-256 hash.
_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def is_ours(uid: str) -> bool:
    """An id of the form only this code makes."""
    return bool(_ID_RE.fullmatch(uid))


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


FREE_PREFIX = "Maybe busy"                  # a provisional block (meaning.py): shown free
FREE_TITLES = frozenset({"Busy for travel (farm)"})   # stops travel, not a meeting


def shown_free(title: str) -> bool:
    """A block written free ("transparent"), so the work holds script, which skips free
    events, never copies it to work. Every other block is busy, as it always was."""
    return title.startswith(FREE_PREFIX) or title in FREE_TITLES


def _plain(event: dict) -> bool:
    """A note, a place, a guest, a color, a reminder or a shown-as change makes it his."""
    if any(event.get(k) for k in ("description", "location", "attendees", "colorId")):
        return False
    if (event.get("reminders") or {}).get("overrides"):
        return False
    shown_as = ("transparent",) if shown_free(str(event.get("summary") or "")) else (None, "opaque")
    return event.get("visibility") in (None, "private") and event.get("transparency") in shown_as


def _body(uid: str, title: str, start: datetime, end: datetime) -> dict:
    return {"id": uid, "summary": title, "status": "confirmed",
            "start": {"dateTime": start.isoformat()}, "end": {"dateTime": end.isoformat()},
            "visibility": "private", "transparency": "transparent" if shown_free(title) else "opaque",
            "reminders": {"useDefault": False},
            "guestsCanInviteOthers": False, "guestsCanSeeOtherGuests": False,
            "extendedProperties": {"private": dict(MARK)}}


NOTE_MARK = {"harness": "mail_dates"}    # a date from his mail (mail_dates.py): never a block


NOTE_HOURS = timedelta(hours=1)


def note_span(day: date, start: datetime | None = None) -> dict:
    """All day, or at the time the email gives, for an hour."""
    if start is None:
        return {"start": {"date": day.isoformat()}, "end": {"date": (day + timedelta(days=1)).isoformat()}}
    span = {"start": {"dateTime": start.isoformat()}, "end": {"dateTime": (start + NOTE_HOURS).isoformat()}}
    zone = getattr(start.tzinfo, "key", None)
    if zone:
        span["start"]["timeZone"] = span["end"]["timeZone"] = zone
    return span


def note_placed(event: dict, day: date, start: datetime | None = None) -> bool:
    """Still where we put it: the same day, or the same start."""
    s = event.get("start") or {}
    if start is None:
        return "dateTime" not in s and s.get("date") == day.isoformat()
    try:
        return datetime.fromisoformat(str(s["dateTime"]).replace("Z", "+00:00")) == start
    except (KeyError, ValueError):
        return False


def _note_body(uid: str, title: str, day: date, start: datetime | None = None) -> dict:
    """Free, so nothing reaches work. All day with no reminder, or, when the email gives the time
    he has to be there, at that time with his usual reminder."""
    return {"id": uid, "summary": title, "status": "confirmed", **note_span(day, start),
            "visibility": "private", "transparency": "transparent",
            "reminders": {"useDefault": start is not None},
            "guestsCanInviteOthers": False, "guestsCanSeeOtherGuests": False,
            "extendedProperties": {"private": dict(NOTE_MARK)}}


def _a_note(event: dict) -> bool:
    private = (event.get("extendedProperties") or {}).get("private") or {}
    return bool(_ID_RE.fullmatch(str(event.get("id", "")))) and private.get("harness") == NOTE_MARK["harness"]


KEPT_TYPES = frozenset({"default", "outOfOffice", "focusTime", "fromGmail"})   # what the feed has too


def _when(part: dict) -> datetime | date:
    if "dateTime" in part:
        t = datetime.fromisoformat(part["dateTime"].replace("Z", "+00:00"))
        if t.tzinfo is None:
            raise ValueError("no offset")
        return t
    return date.fromisoformat(part["date"])


def _occurrence(e: dict, address: str, me: str) -> "ical.Occurrence | None":
    """One event as ical.py makes it from the feed: the UID and the instance's original start
    are what copies are keyed on."""
    people = [a for a in e.get("attendees") or [] if isinstance(a, dict)]
    if any(a.get("self") and a.get("responseStatus") == "declined" for a in people):
        return None
    start, end = _when(e["start"]), _when(e["end"])
    if isinstance(start, datetime) != isinstance(end, datetime):
        raise ValueError("mixed times")
    original = e.get("originalStartTime")
    instance = ical._key(_when(original)) if e.get("recurringEventId") and original else ""
    summary = " ".join(str(e.get("summary") or "").split())[:ical.MAX_SUMMARY] or "(no title)"
    return ical.Occurrence(
        start, end, not isinstance(start, datetime), summary, address,
        e.get("transparency") == "transparent", str(e["iCalUID"]), instance,
        tuple(str(a.get("email", "")).lower() for a in people),
        str(e.get("location") or "").strip(), str((e.get("organizer") or {}).get("email", "")).lower())


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

    # -- what he asks for (calendar_change.py): the one way to touch an event not ours -------
    def events_between(self, address: str, start: datetime, end: datetime) -> list[dict] | None:
        """Everything in this window, each day of a series on its own. None when that can't
        be said."""
        url = self._events(address)
        token, _ = self._access()
        if url is None or token is None:
            return None
        out: list[dict] = []
        query = {"singleEvents": "true", "showDeleted": "false", "maxResults": "250",
                 "timeMin": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                 "timeMax": end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
        for _ in range(MAX_PAGES):
            try:
                r = self._call(token, "GET", f"{url}?{urlencode(query)}")
                if r.status != 200:
                    return None
                page = r.json()
                out += [e for e in page.get("items", []) if isinstance(e, dict)]
                following = page.get("nextPageToken")
            except (TransportError, ValueError, TypeError, AttributeError):
                return None
            if not following:
                return out
            query["pageToken"] = following
        return None

    def window(self, address: str, start: datetime, end: datetime) -> "ical.Window | None":
        """His calendar as the secret-address feed would give it, read now: that feed is Google's
        cache and can be an hour behind. The same identities as the feed, so nothing built on
        it moves. None when it can't be read."""
        events = self.events_between(address, start, end)
        if events is None:
            return None
        out = ical.Window(address)
        me = address.casefold()
        if any(not e.get("iCalUID") for e in events if e.get("status") != "cancelled"):
            return None                    # can't name it as the feed does: the feed's copy stands
        for e in events:
            if e.get("status") == "cancelled" or e.get("eventType", "default") not in KEPT_TYPES:
                continue
            try:
                occ = _occurrence(e, address, me)
            except (KeyError, ValueError, TypeError, AttributeError):
                out.unreadable += 1
                continue
            if occ is not None:
                out.occurrences.append(occ)
        out.occurrences.sort(key=lambda o: (not o.all_day, ical._sort_key(o.start, timezone.utc), o.summary))
        return out

    def look(self, address: str, uid: str) -> tuple[str, dict | None]:
        """One event: "ok" and it, "gone", or "unknown". No answer says nothing about whether
        it's there."""
        url = self._events(address)
        token, _ = self._access()
        if url is None or token is None or not _ANY_ID_RE.fullmatch(uid):
            return "unknown", None
        try:
            r = self._call(token, "GET", f"{url}/{uid}")
            if r.status in (404, 410):
                return "gone", None
            found = r.json() if r.status == 200 else None
        except (TransportError, ValueError):
            return "unknown", None
        return ("ok", found) if isinstance(found, dict) else ("unknown", None)

    def _ask(self, address: str, method: str, uid: str, body: dict | None, etag: str | None) -> Outcome:
        url = self._events(address)
        if url is None or (uid and not _ANY_ID_RE.fullmatch(uid)):
            return Outcome("failed")
        token, problem = self._access()
        if token is None:
            return problem
        where = f"{url}/{uid}?sendUpdates=none" if uid else f"{url}?sendUpdates=none"
        try:
            r = self._call(token, method, where, body=body, etag=etag)
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 204):
            return Outcome("ok", r.status)
        if r.status == 412:
            return Outcome("changed", r.status)
        if r.status == 410:
            return Outcome("gone", r.status)
        if r.status == 409:
            return Outcome("exists", r.status)
        return self._answer(r)

    def change(self, address: str, uid: str, fields: dict, etag: str | None) -> Outcome:
        return self._ask(address, "PATCH", uid, fields, etag)

    def drop(self, address: str, uid: str, etag: str | None) -> Outcome:
        return self._ask(address, "DELETE", uid, None, etag)

    def insert(self, address: str, event: dict) -> Outcome:
        """Its id is fixed per request, so a lost answer can't become a second one."""
        return self._ask(address, "POST", "", event, None)

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

    # -- dates from his mail (mail_dates.py): their own mark, so the sync never sees them -----
    def add_note(self, address: str, uid: str, title: str, day: date,
                 start: datetime | None = None) -> Outcome:
        """A fixed id, so a lost answer finds itself. "exists": that id can't be used."""
        url = self._events(address)
        if url is None or not _ID_RE.fullmatch(uid):
            return Outcome("failed")
        token, problem = self._access()
        if token is None:
            return problem
        try:
            r = self._call(token, "POST", f"{url}?sendUpdates=none", body=_note_body(uid, title, day, start))
            if r.status == 200:
                return Outcome("ok", r.status)
            if r.status != 409:
                return self._answer(r)
            r = self._call(token, "GET", f"{url}/{uid}")
            found = r.json() if r.status == 200 else None
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        except ValueError:
            return Outcome("exists")
        if isinstance(found, dict) and _a_note(found) and found.get("status") != "cancelled":
            return Outcome("ok", 200)              # the earlier try landed
        return Outcome("exists")

    def remove_note(self, address: str, uid: str, title: str, day: date,
                    start: datetime | None = None) -> Outcome:
        """Only a note of ours that he hasn't changed: a title or time he edited makes it his."""
        url = self._events(address)
        if url is None or not _ID_RE.fullmatch(uid):
            return Outcome("failed")
        token, problem = self._access()
        if token is None:
            return problem
        try:
            r = self._call(token, "GET", f"{url}/{uid}")
            if r.status in (404, 410):
                return Outcome("gone", r.status)
            if r.status != 200:
                return self._answer(r)
            found = r.json()
            if not isinstance(found, dict) or not _a_note(found):
                return Outcome("changed", r.status)
            if found.get("status") == "cancelled":
                return Outcome("gone", r.status)
            if any(found.get(k) for k in ("description", "location", "attendees")) \
                    or found.get("transparency") != "transparent" or found.get("summary") != title \
                    or not note_placed(found, day, start):
                return Outcome("changed", r.status)
            r = self._call(token, "DELETE", f"{url}/{uid}?sendUpdates=none", etag=found.get("etag"))
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        except ValueError:
            return Outcome("unknown")
        if r.status in (200, 204):
            return Outcome("ok", r.status)
        if r.status == 410:
            return Outcome("gone", r.status)
        if r.status == 412:
            return Outcome("changed", r.status)
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
