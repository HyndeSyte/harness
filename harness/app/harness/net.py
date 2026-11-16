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
import time
import urllib.error
from contextlib import contextmanager
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


# 0.24.0, fifth round: one total deadline for everything a calendar write sends from its thread
# (calendar_change._bounded): connect, TLS, the request and the whole answer, every request it makes
# (a sign-in, a name check, the write), and no retries. Set per thread; each request gets only what's
# left, and a watchdog shuts its socket at the deadline, so a server that answers a byte at a time
# can't keep the thread past it.
_DEADLINE = threading.local()


@contextmanager
def deadline(seconds: float):
    """Everything this thread sends inside it ends by `seconds` from now, answered or not."""
    before = getattr(_DEADLINE, "at", None)
    at = time.monotonic() + seconds
    _DEADLINE.at = at if before is None else min(before, at)
    try:
        yield
    finally:
        _DEADLINE.at = before


def remaining() -> float | None:
    """Seconds left before this thread's deadline, or None when it has none."""
    at = getattr(_DEADLINE, "at", None)
    return None if at is None else at - time.monotonic()


class _Watched:
    """The sockets one request opened, shut by its watchdog at the deadline."""

    def __init__(self):
        self.socks: list = []
        self.fired = False
        self.lock = threading.Lock()

    def add(self, sock) -> None:
        with self.lock:
            self.socks.append(sock)
            fired = self.fired
        if fired:
            self._shut(sock)

    def fire(self) -> None:
        with self.lock:
            self.fired = True
            socks = list(self.socks)
        for sock in socks:
            self._shut(sock)

    @staticmethod
    def _shut(sock) -> None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass


_WATCHED = threading.local()


def _watch(sock) -> None:
    w = getattr(_WATCHED, "w", None)
    if w is not None:
        w.add(sock)


class _WatchedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        super().connect()
        _watch(self.sock)


class _WatchedHTTP(http.client.HTTPConnection):
    def connect(self):
        super().connect()
        _watch(self.sock)


class _WatchedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_WatchedHTTPS, req, context=self._context)


class _WatchedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_WatchedHTTP, req)


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
        handlers.append(_WatchedHTTPSHandler(context=ctx))
        handlers.append(_WatchedHTTPHandler())
        self._opener = urllib.request.build_opener(*handlers)

    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=30):
        left = remaining()
        if left is None:
            return self._request(method, url, headers=headers, json_body=json_body, body=body, timeout=timeout)
        if left <= 0:
            raise TransportError("timeout", "deadline")      # nothing was sent
        w = _Watched()
        _WATCHED.w = w
        timer = threading.Timer(left, w.fire)
        timer.daemon = True
        timer.start()
        try:
            answer = self._request(method, url, headers=headers, json_body=json_body, body=body,
                                   timeout=min(timeout, left))
            if w.fired:                      # cut off at the deadline: what came isn't a whole answer
                raise TransportError("timeout", "deadline")
            return answer
        except Exception:                    # a socket shut under a read can surface as anything
            if w.fired:
                raise TransportError("timeout", "deadline") from None
            raise
        finally:
            timer.cancel()
            _WATCHED.w = None

    def _request(self, method, url, *, headers=None, json_body=None, body=None, timeout=30):
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
