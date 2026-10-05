"""HTTPS for the controller: one small transport, secrets kept out of logs.

The controller talks to exactly four hosts -- Telegram, Anthropic,
OpenAI and (S1, read-only) calendar.google.com -- with the standard
library only, so the add-on has no
third-party dependencies to pin, audit or break on update.

The Telegram bot token travels in the URL path, which is where secrets
leak: an exception message, a traceback, a log line. So nothing here ever
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
from typing import Any, Protocol


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


class UrllibTransport:
    def __init__(self, *, use_env_proxy: bool = True, cafile: str | None = None):
        handlers: list = []
        if not use_env_proxy:
            handlers.append(urllib.request.ProxyHandler({}))
        ctx = ssl.create_default_context(cafile=cafile)
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
        self._opener = urllib.request.build_opener(*handlers)

    def request(self, method, url, *, headers=None, json_body=None, timeout=30):
        data = None
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
