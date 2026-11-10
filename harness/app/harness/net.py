"""HTTPS for the controller: one small transport, secrets kept out of logs.

The controller talks to fixed hosts -- Anthropic, OpenAI, Discord (discord_api.py)
and (S1, read-only) calendar.google.com -- and one configured host,
the iCloud calendar host in the Family calendar address, with the standard
library only, so the add-on has no
third-party dependencies to pin, audit or break on update. The iCloud host
is enforced here, request by request, by CalDavTransport, which also refuses
redirects: it is the only transport that carries a family password.
GoogleTransport does the same for the two Google hosts that write to his Gmail
calendar (google_cal.py), when he has entered a key for that. MapTransport does the same
for the two map hosts, when he has entered the school's address (drive.py).

Secrets can end up in a URL, which is where they leak: an exception
message, a traceback, a log line. So nothing here ever
puts a URL into an error, and every string that may be logged passes
through the redactor, which knows every secret currently loaded.
"""
from __future__ import annotations

import http.client
import json
import logging
import socket
import ssl
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit


class Redactor:
    """Replaces every registered secret with [redacted]. Process-wide."""

    def __init__(self):
        self._lock = threading.Lock()
        self._secrets: set[str] = set()

    def register(self, *secrets: str | None) -> None:
        with self._lock:
            for s in secrets:
                if s and len(s) >= 8:
                    self._secrets.add(s)

    def clear(self) -> None:
        with self._lock:
            self._secrets.clear()

    def __call__(self, text: Any) -> str:
        out = str(text)
        with self._lock:
            secrets = sorted(self._secrets, key=len, reverse=True)
        for s in secrets:
            if s in out:
                out = out.replace(s, "[redacted]")
        return out


REDACT = Redactor()


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = REDACT(record.getMessage())
        record.args = ()
        if record.exc_info:
            # Tracebacks can carry URLs; keep only the redacted summary.
            exc = record.exc_info[1]
            record.msg = f"{record.msg} [{type(exc).__name__}: {REDACT(exc)}]"
            record.exc_info = None
            record.exc_text = None
        return True


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: dict = field(default_factory=dict)      # lower-case keys
    body: bytes = b""

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


class TransportError(Exception):
    """A request that never produced an HTTP status: DNS, TLS, timeout,
    connection reset. The message never contains the URL."""

    def __init__(self, kind: str, detail: str = ""):
        self.kind = kind
        super().__init__(REDACT(f"{kind}: {detail}" if detail else kind))


class Transport(Protocol):
    def request(self, method: str, url: str, *, headers: dict | None = None,
                json_body: Any = None, timeout: float = 30) -> HttpResponse: ...


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None                     # the 3xx comes back as an answer, not a new request


class UrllibTransport:
    def __init__(self, *, use_env_proxy: bool = True, cafile: str | None = None,
                 follow_redirects: bool = True):
        handlers: list = []
        if not use_env_proxy:
            handlers.append(urllib.request.ProxyHandler({}))
        if not follow_redirects:
            handlers.append(_NoRedirect())
        ctx = ssl.create_default_context(cafile=cafile)
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
        self._opener = urllib.request.build_opener(*handlers)

    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=30):
        data = body
        hdrs = dict(headers or {})
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            hdrs.setdefault("content-type", "application/json")
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                return HttpResponse(resp.status, {k.lower(): v for k, v in resp.headers.items()},
                                    resp.read())
        except urllib.error.HTTPError as e:
            # An HTTP status is an answer, not a transport failure.
            try:
                body = e.read()
            except Exception:
                body = b""
            hdrs_out = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
            return HttpResponse(e.code, hdrs_out, body)
        except (socket.timeout, TimeoutError):
            raise TransportError("timeout") from None
        except http.client.HTTPException as e:
            # A reply cut off mid-body or a garbled status line: the request
            # may or may not have landed; either way it is a network failure.
            raise TransportError("network", type(e).__name__) from None
        except ssl.SSLError as e:
            raise TransportError("tls", type(e).__name__) from None
        except urllib.error.URLError as e:
            reason = e.reason
            raise TransportError("network", type(reason).__name__
                                 if not isinstance(reason, str) else "unreachable") from None
        except (ConnectionError, OSError) as e:
            raise TransportError("network", type(e).__name__) from None


class CalDavTransport(UrllibTransport):
    """Https to the one configured iCloud host, five methods, no redirects and
    no proxy. Anything else never leaves: kind "blocked" means nothing was sent."""

    METHODS = frozenset({"PROPFIND", "REPORT", "GET", "PUT", "DELETE"})

    def __init__(self, allowed_host: Callable[[], str], *, cafile: str | None = None):
        super().__init__(use_env_proxy=False, cafile=cafile, follow_redirects=False)
        self.allowed_host = allowed_host

    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=20):
        try:
            parts = urlsplit(url)
            plain_host = parts.username is None and parts.port is None
        except ValueError:
            raise TransportError("blocked") from None
        host = self.allowed_host()
        if (method not in self.METHODS or parts.scheme != "https" or not plain_host
                or not host or parts.hostname != host or json_body is not None):
            raise TransportError("blocked")
        return super().request(method, url, headers=headers, body=body, timeout=timeout)


class MapTransport(UrllibTransport):
    """Https GET to the two map hosts (drive.py), no redirects and no proxy. It carries no
    sign-in of any kind. Anything else never leaves."""

    def __init__(self, hosts: frozenset[str], *, cafile: str | None = None):
        super().__init__(use_env_proxy=False, cafile=cafile, follow_redirects=False)
        self.hosts = hosts

    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=10):
        try:
            parts = urlsplit(url)
            plain_host = parts.username is None and parts.port is None
        except ValueError:
            raise TransportError("blocked") from None
        if (method != "GET" or parts.scheme != "https" or not plain_host
                or parts.hostname not in self.hosts or json_body is not None or body is not None):
            raise TransportError("blocked")
        return super().request(method, url, headers=headers, timeout=timeout)


class GoogleTransport(UrllibTransport):
    """Https to Google's token and calendar hosts, no redirects and no proxy. It is the only
    transport that carries the service account's sign-in. Anything else never leaves."""

    METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})

    def __init__(self, hosts: frozenset[str], *, cafile: str | None = None):
        super().__init__(use_env_proxy=False, cafile=cafile, follow_redirects=False)
        self.hosts = hosts

    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=20):
        try:
            parts = urlsplit(url)
            plain_host = parts.username is None and parts.port is None
        except ValueError:
            raise TransportError("blocked") from None
        if (method not in self.METHODS or parts.scheme != "https" or not plain_host
                or parts.hostname not in self.hosts or json_body is not None):
            raise TransportError("blocked")
        return super().request(method, url, headers=headers, body=body, timeout=timeout)
