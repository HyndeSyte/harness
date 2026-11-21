"""0.24.0, twenty-first round, item 9: the records-only kinds, counted at the transport boundary.

- Every call that could reach Google or iCloud is counted, not a named few: every call the specialist makes on its
  Google calendar client (the card rig's Google stand-in, every public method), every CalDAV request (reads and
  writes), every Google client request (google_cal.GoogleCalendar._call) and every request on a real transport class
  (net's urllib, CalDAV, Google and maps transports). A records-only kind makes none, but for the four that
  legitimately preview a card, each with an explicit allowance of what it may read (and never a write).
- One integration test runs the real Gmail sync after the receipt-state kind (meaning_undo: its records change later
  takes a block off Gmail) and checks exactly which block is lifted.
All names and ids invented.
"""
import pytest

from harness import google_cal, net
from harness.controller import Controller
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import m  # noqa: F401
from test_records_only_round20 import PARAMS, SETUPS
from fake_caldav import no_network  # noqa: F401  (autouse)

# The four kinds that preview a card, and what each may read: Google calendar client reads by name, and CalDAV
# request methods. Anything else, and any write, fails the test.
GOOGLE_READS = {"events_between", "look", "really_gone", "gone_how", "list_ours", "read_back", "account",
                "configured"}
ALLOW = {
    "calendar_change_which": {"google": GOOGLE_READS, "caldav": {"PROPFIND", "REPORT", "GET"}},
    "calendar_change_propose_again": {"google": GOOGLE_READS, "caldav": {"PROPFIND", "REPORT", "GET"}},
    "family_add_enable": {"google": GOOGLE_READS, "caldav": {"PROPFIND", "REPORT", "GET"}},
    "family_add_loosen": {"google": {"configured"}, "caldav": {"PROPFIND", "REPORT", "GET"}},
}
NONE = {"google": set(), "caldav": set()}


class Boundary:
    """Every call that could reach a calendar, by where and what."""

    def __init__(self, m, monkeypatch):
        self.calls: list[tuple[str, str]] = []
        g = m.gmail
        names = {n for n in dir(type(g)) if not n.startswith("_") and callable(getattr(g, n, None))}
        for name in sorted(names):
            real = getattr(g, name)

            def wrap(*a, _real=real, _name=name, **k):
                self.calls.append(("google", _name))
                return _real(*a, **k)
            monkeypatch.setattr(g, name, wrap)
        real_req = m.icloud.request

        def caldav(method, url, **kw):
            self.calls.append(("caldav", str(method).upper()))
            return real_req(method, url, **kw)
        monkeypatch.setattr(m.icloud, "request", caldav)

        def counted(where, real):
            def call(*a, **k):
                self.calls.append((where, "request"))
                return real(*a, **k)
            return call
        monkeypatch.setattr(google_cal.GoogleCalendar, "_call", counted("google_http", google_cal.GoogleCalendar._call))
        for cls in (net.UrllibTransport, net.CalDavTransport, net.MapTransport, net.GoogleTransport):
            monkeypatch.setattr(cls, "request", counted("transport", cls.request))

    def outside(self, allow: dict) -> list[tuple[str, str]]:
        return [(w, n) for w, n in self.calls if n not in allow.get(w, set())]


def test_the_allowances_name_only_the_four_preview_kinds():
    assert set(ALLOW) == {k for k, s in SETUPS.items() if s["reads"]}
    assert set(ALLOW) <= set(Controller.CHOICE_RECORDS)
    for allow in ALLOW.values():
        assert not ({"insert", "change", "drop", "remove", "write"} & allow["google"])
        assert not ({"PUT", "DELETE", "POST", "MOVE"} & allow["caldav"])


@pytest.mark.card_only
@pytest.mark.parametrize("kind", PARAMS)
def test_each_records_only_kind_makes_no_call_outside_its_allowance(m, monkeypatch, kind):
    spec = SETUPS[kind]
    target, check = spec["fn"](m, monkeypatch)
    m.c.outbox.flush()
    seen = Boundary(m, monkeypatch)
    said = m.c.callbacks._apply_choice(kind, target)
    for _ in range(3):
        m.c.tick()
    check(said)
    allow = ALLOW.get(kind, NONE)
    assert seen.outside(allow) == [], (kind, seen.calls)
    if kind not in ALLOW:
        assert seen.calls == [], (kind, seen.calls)                            # nothing at all
    assert not [c for c in seen.calls if c[0] in ("google_http", "transport")]  # never past the stand-ins


# -- the receipt-state kind, then the real Gmail sync -----------------------------------------------------------------

def test_meaning_undo_then_the_real_gmail_sync_lifts_exactly_that_block(live):
    """Two blocks on Gmail, each with its receipt; his Undo on one (records only), then the real family_gmail sync:
    only that block comes off, the other stays, and its receipt is marked done."""
    from datetime import timedelta
    from test_meaning_live import answer_ex, go, judged, ob, seed, when
    first, second = when(live, days=3, hour=9), when(live, days=4, hour=14)
    seed(live, "Turkey harvest", first)
    seed(live, "Hay ride", second)
    eid = answer_ex(live, "Turkey harvest", ["supervision"])
    eid2 = answer_ex(live, "Hay ride", ["supervision"])
    live.judge.script = [judged(ob("supervision", first, first + timedelta(hours=1)), cites=[eid]),
                         judged(ob("supervision", second, second + timedelta(hours=1)), cites=[eid2])]
    go(live)
    go(live)                                                  # both written
    go(live)                                                  # both read back as written
    assert live.live.send_receipts() == 2                     # both receipts go out, each with its Undo
    live.tick()
    rows = live.ledger.db.execute("SELECT id, gmail_key, start FROM meaning_receipts ORDER BY start").fetchall()
    assert len(rows) == 2
    keep, lift = rows[1], rows[0]
    blocks = {r["key"]: r["event_id"] for r in live.ledger.db.execute("SELECT key, event_id FROM family_gmail")}
    before = dict(live.google.live())
    assert set(before) == {blocks[keep["gmail_key"]], blocks[lift["gmail_key"]]}
    said = live.c.callbacks._apply_choice("meaning_undo", f"{lift['id']}:once")
    assert said == "Taking it off your Gmail, this time only."
    assert set(live.google.live()) == set(before)             # the tap itself changes no calendar
    live.tick()                                               # the real Gmail sync
    assert set(live.google.live()) == {blocks[keep["gmail_key"]]}          # exactly that block lifted
    state = dict(live.ledger.db.execute("SELECT id, state FROM meaning_receipts").fetchall())
    assert state[lift["id"]] == "undone" and state[keep["id"]] != "undone"
    gm = dict(live.ledger.db.execute("SELECT key, state FROM family_gmail").fetchall())
    assert gm[lift["gmail_key"]] == "undone" and gm[keep["gmail_key"]] == "live"


from test_family_add import on, rig  # noqa: E402,F401  (the Gmail sync's rig)
from test_meaning_live import g, live  # noqa: E402,F401
