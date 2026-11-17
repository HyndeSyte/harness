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

Twenty-seventh round: words shown to him (a "Nothing changed" refusal naming his events, a stopped part's words) go
through scrub_owner(), which replaces only the registered and providers' secrets, so his event titles and notes are
never redacted by a pattern.
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


def _known(text) -> str:
    """Text with the registered secrets (net.REDACT) and the providers' secrets replaced, and nothing else."""
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
    return out


_MINT = object()                        # twenty-ninth round: OwnerText's private constructor key


class OwnerText(str):
    """Twenty-eighth round: words for him, built by the specialist from its own word constants and his events' own
    fields (a title, a time), never from an exception's text or a provider's response (tests/test_outbox_round28.py
    checks every place one is built). The one type scrub_owner takes as his words.

    Twenty-ninth round: its constructor is private. Words for him are built only by OwnerText.template (a literal
    template and his events' fields), by an owner refusal's message (OwnerRefusal, its .owner and .ask), or by
    scrub_owner's own result; OwnerText(...) called directly raises, and tests/test_outbox_round29.py's scan flags
    any other construction."""
    __slots__ = ()

    def __new__(cls, value="", key=None):
        if key is not _MINT:
            raise TypeError("words for him are built with OwnerText.template or an owner refusal")
        return super().__new__(cls, value)

    # Thirtieth round: copy, deep copy and pickling go through the private minting path (a plan or an outbox row
    # holding his words is copied or pickled like any other text, and never raises on its constructor).
    def __reduce__(self):
        return (_owner, (str(self),))

    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        return self

    @classmethod
    def template(cls, fmt: str, /, **fields) -> "OwnerText":
        """A literal template (the scan checks it's a string literal at every call) filled with his events' own
        fields (a title, a time, a day), each as text."""
        return cls(fmt.format(**{k: str(v) for k, v in fields.items()}) if fields else fmt, _MINT)


def _owner(text: str) -> OwnerText:
    """The scrub module's own minting: an owner refusal's message, and scrub_owner's result."""
    return OwnerText(text, _MINT)


class OwnerRefusal(Exception):
    """Twenty-eighth round: a refusal whose message is words for him (calendar_change.Refuse, rules.RuleError,
    ics_edit.Cant, ledger.LedgerFenced): its message kept as OwnerText (.owner) when it's given as text. Every place
    one is raised is checked like an OwnerText built (tests/test_outbox_round28.py). Twenty-ninth round: `ask`, a
    question for him (calendar_change.Unclear), kept as OwnerText (.ask) too."""

    def __init__(self, *args, ask: str | None = None):
        super().__init__(*args)
        self.owner = _owner(args[0]) if args and isinstance(args[0], str) else None
        if ask is not None:
            self.ask = _owner(ask if isinstance(ask, str) else "")


def scrub_owner(text) -> str:
    """Twenty-seventh round: owner-facing words (a "Nothing changed" refusal, which names his events) with only the
    registered and providers' secrets replaced. The heuristic patterns are left out here, so an event called
    "Token: pickup", a note that reads like key=value, or a long mixed-case word reaches him as written.

    Twenty-eighth round: only OwnerText, or an OwnerRefusal carrying it, is taken as his words. Anything else
    (exception text, a provider's answer, plain text) gets the whole scrub, as scrub() does."""
    if isinstance(text, OwnerRefusal) and text.owner is not None:
        text = text.owner
    if isinstance(text, OwnerText):
        return _owner(_known(text))
    return scrub(text)


def scrub(text) -> str:
    """Exception text with its secrets replaced (see the module's docstring)."""
    out = _known(text)
    for pattern, repl in PATTERNS:
        out = pattern.sub(repl, out)
    return _LONG.sub(_high_entropy, out)


# The fields of a record that hold exception text: scrubbed wherever a sink writes one. Twenty-seventh round:
# "words" holds a refusal in his own words (a change's part that stopped, naming his event), so it gets only the
# known secrets replaced (OWNER_FIELDS, scrub_owner), never the heuristic patterns. Twenty-ninth round: by type,
# not by position: only an OwnerText value there gets the light scrub; anything else in that field (plain text,
# and a record kept as JSON text, where no value has a type) gets the whole scrub.
ERROR_FIELDS = frozenset({"error", "errors", "last_error", "exception", "detail", "why", "words", "refused"})
OWNER_FIELDS = frozenset({"words"})


# Thirtieth round: a record kept as JSON text keeps the type of his words with a tag: the key OWNER_TAG beside them,
# listing which owner fields hold his words ("words" for the field, "words[2]" for one item of a list there). Only
# dumps() writes it, from OwnerText values (any tag already in what it's handed is dropped); the records' sink gives
# a tagged field the light scrub and anything else the whole scrub; loads() gives tagged fields back as OwnerText.
OWNER_TAG = "__owner__"


def _tags(value: dict) -> set:
    tags = value.get(OWNER_TAG)
    return {t for t in tags if isinstance(t, str)} if isinstance(tags, list) else set()


def scrub_fields(value):
    """A record (dicts and lists, any depth) with every string under an ERROR_FIELDS key scrubbed (an OWNER_FIELDS
    key's OwnerText with scrub_owner, anything else there with the whole scrub). Thirtieth round: in a record read
    back from JSON text, an owner field its tag names (OWNER_TAG) is his words too, and keeps its tag."""
    if isinstance(value, dict):
        tags = _tags(value)

        def one(k, x, at):
            # Twenty-ninth round: type-gated: the light scrub only for OwnerText in an owner field (thirtieth round:
            # or one its tag names, in a record kept as JSON text).
            if k in OWNER_FIELDS and (isinstance(x, OwnerText) or at in tags):
                return _owner(_known(x))
            return scrub(x)
        return {k: (one(k, v, k) if isinstance(v, str) and k in ERROR_FIELDS
                    else [one(k, x, f"{k}[{i}]") if isinstance(x, str) else scrub_fields(x) for i, x in enumerate(v)]
                    if isinstance(v, list) and k in ERROR_FIELDS else v if k == OWNER_TAG else scrub_fields(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_fields(x) for x in value]
    return value


def _for_storage(value):
    """Thirtieth round: a record made ready to be kept as JSON text: every ERROR_FIELDS string scrubbed (his words,
    OwnerText in an owner field, with the light scrub, anything else with the whole scrub, before it's serialised),
    and his words tagged (OWNER_TAG) so they read back as his words. Any tag already in it is dropped."""
    if isinstance(value, dict):
        out, tags = {}, []
        for k, v in value.items():
            if k == OWNER_TAG:
                continue
            if isinstance(v, str) and k in ERROR_FIELDS:
                if k in OWNER_FIELDS and isinstance(v, OwnerText):
                    out[k] = str(_known(v))
                    tags.append(k)
                else:
                    out[k] = scrub(v)
            elif isinstance(v, list) and k in ERROR_FIELDS:
                items = []
                for i, x in enumerate(v):
                    if isinstance(x, str) and k in OWNER_FIELDS and isinstance(x, OwnerText):
                        items.append(str(_known(x)))
                        tags.append(f"{k}[{i}]")
                    elif isinstance(x, str):
                        items.append(scrub(x))
                    else:
                        items.append(_for_storage(x))
                out[k] = items
            else:
                out[k] = _for_storage(v)
        if tags:
            out[OWNER_TAG] = tags
        return out
    if isinstance(value, (list, tuple)):
        return [_for_storage(x) for x in value]
    return str(value) if isinstance(value, OwnerText) else value


def dumps(value, **kw) -> str:
    """Thirtieth round: a record as JSON text for the records, scrubbed and with his words tagged (_for_storage)."""
    import json
    return json.dumps(_for_storage(value), **kw)


def _rehydrate(value):
    if isinstance(value, dict):
        tags = _tags(value)
        out = {}
        for k, v in value.items():
            if k == OWNER_TAG:
                continue
            if k in OWNER_FIELDS and isinstance(v, str) and k in tags:
                out[k] = _owner(v)
            elif k in OWNER_FIELDS and isinstance(v, list):
                out[k] = [_owner(x) if isinstance(x, str) and f"{k}[{i}]" in tags else _rehydrate(x)
                          for i, x in enumerate(v)]
            else:
                out[k] = _rehydrate(v)
        return out
    if isinstance(value, list):
        return [_rehydrate(x) for x in value]
    return value


def loads(text):
    """Thirtieth round: a record kept as JSON text read back, its tagged fields his words again (OwnerText, through
    the module's own minting), the tags themselves left out."""
    import json
    return _rehydrate(json.loads(text))


class ScrubFilter(net.RedactingFilter):
    """The root log handler's filter: each record's message (and its exception summary) scrubbed."""

    def filter(self, record: logging.LogRecord) -> bool:
        super().filter(record)
        record.msg = scrub(record.msg)
        return True
