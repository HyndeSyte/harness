"""Twenty-sixth round: one scrub for exception text, applied at the sinks.

Exception text can carry secrets: a key in a URL's query, an auth header, a JSON body echoed back with its token
fields, a bearer token. Before the twenty-sixth round the controller scrubbed it on its own paths only; now every
sink that keeps or shows such text goes through scrub() here:

- the tap journal's writer (handover.Inbox._append), on its "error" fields;
- the records' writers (Ledger.set_meta, Ledger.event, an input's last error), on exception-text fields;
- the set-aside tool's writer (migrate.set_aside_taps), on the copy it keeps beside the records;
- the log, through ScrubFilter on the root handler (__main__.configure_logging);
- and every other place exception text is turned into words (tests/test_outbox_round26.py checks the source: such
  text is only logged, scrubbed, or raised on).

What it replaces: every secret registered with net.REDACT, the secrets a provider names (the controller adds the keys
its vault holds and the link's token), auth headers and key=value secrets, JSON-quoted token, secret, password and
refresh-token fields, a URL's user part and its query, and long high-entropy strings (40 or more characters of
letters, digits and token punctuation, with upper case, lower case and digits all present).
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Callable, Iterable

from . import net

REDACTED = "[redacted]"

PATTERNS = (
    # key=value, key: value and 'Key': 'value' for the usual secret names (a value may be "Bot xxx", two words)
    (re.compile(r"(?i)\b(authorization|proxy-authorization|x-api-key|api[-_]?key|cookie|set-cookie|password|passwd|"
                r"access_token|refresh_token|id_token|client_secret|secret|token)(['\"]?\s*[:=]\s*['\"]?)"
                r"([^'\"\s,;}&]+(?:\s+[^'\"\s,;}&]+)?)"),
     r"\1\2" + REDACTED),
    # JSON-quoted fields whose name says token, secret, password or refresh token, whatever the value holds
    (re.compile(r"""(?i)(["'])([\w-]*(?:token|secret|password|passwd|api[-_]?key)[\w-]*)\1(\s*:\s*)(["'])"""
                r"""(?:\\.|(?!\4).)*\4"""),
     r"\1\2\1\3\4" + REDACTED + r"\4"),
    (re.compile(r"(?i)\b(bearer|basic|bot)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 " + REDACTED),
    (re.compile(r"(?i)\b((?:https?|webcals?)://)[^/\s@]+@"), r"\1" + REDACTED + "@"),
    (re.compile(r"(?i)\b((?:https?|webcals?)://[^\s?#'\"<>]*)\?[^\s#'\"<>]*"), r"\1?" + REDACTED),
)
_LONG = re.compile(r"[A-Za-z0-9_\-+/=.~]{40,}")

_lock = threading.Lock()
_providers: dict[str, Callable[[], Iterable[str]]] = {}


def set_provider(name: str, fn: Callable[[], Iterable[str]] | None) -> None:
    """A named source of secrets to replace, read at each scrub (so a key changed since is covered); a second one
    under the same name replaces the first, None removes it. The controller is "controller"."""
    with _lock:
        if fn is None:
            _providers.pop(name, None)
        else:
            _providers[name] = fn


def _high_entropy(m: re.Match) -> str:
    s = m.group(0)
    if any(c.isupper() for c in s) and any(c.islower() for c in s) and any(c.isdigit() for c in s):
        return REDACTED
    return s


def scrub(text) -> str:
    """Exception text with its secrets replaced (see the module's docstring)."""
    out = net.REDACT(str(text))
    with _lock:
        providers = list(_providers.values())
    secrets: set[str] = set()
    for fn in providers:
        try:
            secrets |= {str(s) for s in (fn() or ()) if s}
        except Exception:                       # noqa: BLE001: a source that can't be read adds nothing
            continue
    for sec in sorted((s for s in secrets if len(s) >= 8), key=len, reverse=True):
        out = out.replace(sec, REDACTED)
    for pattern, repl in PATTERNS:
        out = pattern.sub(repl, out)
    return _LONG.sub(_high_entropy, out)


# The fields of a record that hold exception text: scrubbed wherever a sink writes one.
ERROR_FIELDS = frozenset({"error", "errors", "last_error", "exception", "detail", "why", "words", "refused"})


def scrub_fields(value):
    """A record (dicts and lists, any depth) with every string under an ERROR_FIELDS key scrubbed."""
    if isinstance(value, dict):
        return {k: (scrub(v) if isinstance(v, str) and k in ERROR_FIELDS
                    else [scrub(x) if isinstance(x, str) else scrub_fields(x) for x in v]
                    if isinstance(v, list) and k in ERROR_FIELDS else scrub_fields(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_fields(x) for x in value]
    return value


class ScrubFilter(net.RedactingFilter):
    """The root log handler's filter: each record's message (and its exception summary) scrubbed."""

    def filter(self, record: logging.LogRecord) -> bool:
        super().filter(record)
        record.msg = scrub(record.msg)
        return True
