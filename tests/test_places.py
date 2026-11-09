"""Where a place named on Family is: his place book, sent by Cain, the map by name near home, and
asking him once (places.py, drive.find_place).

All names and places are invented. No network: Family, Google, the map and Cain's link are fakes.
"""
import json
import shutil
import subprocess
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from harness import drive, google_cal, handover, meaning_live, places
from harness.net import HttpResponse
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_family_add import on, rig  # noqa: F401
from test_family_copy import TZ, when
from test_family_gmail import g  # noqa: F401
from test_meaning_live import (CLINIC, M, PARK, ROOT, Feeds, Shadow, answer_ex, blocks, day, drives,  # noqa: F401
                               go, goes, judged, labels, live, lv, ob)

RINK = "HMLC"
FUNKYS = "Funky's Skate Center"
FUNKYS_AT = "Funky's Skate Center, 100 Miller Circle, Harrisonburg, VA 22801"   # what the block carries
FUNKYS_FOUND = {"name": FUNKYS, "lat": "38.4", "lon": "-78.4",                    # the clinic's point
                "address": {"house_number": "100", "road": "Miller Circle", "city": "Harrisonburg",
                            "county": "Rockingham County", "ISO3166-2-lvl4": "US-VA", "postcode": "22801",
                            "country_code": "us"}}


@pytest.fixture
def named(drives):
    """The map also knows places by name near home: the results it gives for each search."""
    drives.names = {}
    real = drives.maps.request

    def request(method, url, **kw):
        q = parse_qs(urlsplit(url).query)
        if drive.GEOCODE_HOST in url and q.get("bounded") == ["1"]:
            drives.maps.urls.append(url)
            return HttpResponse(200, {}, json.dumps(drives.names.get(q["q"][0], [])).encode())
        return real(method, url, **kw)
    drives.maps.request = request
    drives.names[FUNKYS] = [FUNKYS_FOUND]
    return drives


def book(rig, *rows):
    """His place book as Cain sends it: (place, address, said_on) rows, checked, then stored."""
    checked, why = places.validate_rows({"rows": [{"place": p, "address": a, "said_on": d} for p, a, d in rows]})
    assert checked is not None, why
    return rig.live.places.import_rows(checked)


def geocoded(rig):
    return [parse_qs(urlsplit(u).query)["q"][0] for u in rig.maps.urls if drive.GEOCODE_HOST in u]


def place_cards(rig):
    return [s for s in rig.bot.sent if s[1].startswith("Where is ")]


def at(rig, title, start, place, judged_place, hours=1):
    """goes(), with the place the judgment names (it may name none)."""
    path = goes(rig, title, start, place, hours)
    rig.judge.by[title] = judged(ob("presence", start, start + timedelta(hours=hours), place=judged_place),
                                 cites=[answer_ex(rig, title, ["presence"])])
    return path


def drove_to(start, place):
    return [("Busy (drive there)", start - 20 * M, start, ""),
            ("Busy (family)", start, start + 60 * M, place),
            ("Busy (drive back)", start + 60 * M, start + 80 * M, "")]


# -- what the book gives an event ----------------------------------------------------------------------

def test_a_book_row_gives_a_named_place_its_drive_and_address(drives):
    book(drives, (RINK, CLINIC, "2026-10-20"))
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating HMLC", start, RINK)
    go(drives)
    go(drives)
    assert blocks(drives) == drove_to(start, CLINIC)              # the book's address, for Maps
    assert geocoded(drives) == [CLINIC]                           # his word: the name isn't looked up
    assert place_cards(drives) == []                              # known: nothing to ask


@pytest.mark.parametrize("written", ["  hmlc ", "Hmlc.", "HMLC\n"])
def test_the_book_matches_whatever_the_case_spacing_or_dots(drives, written):
    book(drives, (" hMLc ", CLINIC, "2026-10-20"))
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating", start, written)
    go(drives)
    go(drives)
    assert blocks(drives) == drove_to(start, CLINIC)


def test_only_the_whole_location_matches_and_the_title_never_does(drives):
    book(drives, ("Pat", CLINIC, "2026-10-20"), ("Skating", PARK, "2026-10-20"))
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating", start, "Pat's house")
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "")]
    assert geocoded(drives) == ["Pat's house"]                    # the map didn't know it either


def test_coordinates_in_the_book_are_used_as_they_are(drives):
    book(drives, (RINK, "38.4, -78.4", "2026-10-20"))             # the clinic's point
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating HMLC", start, RINK)
    go(drives)
    go(drives)
    assert blocks(drives) == drove_to(start, "38.4, -78.4")
    assert geocoded(drives) == []


def test_a_place_given_later_gets_its_drive_on_the_next_read(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating HMLC", start, RINK)
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "")]
    book(drives, (RINK, CLINIC, "2026-10-21"))
    go(drives)
    go(drives)
    assert blocks(drives) == drove_to(start, CLINIC)
    assert drives.ledger.db.execute("SELECT state FROM place_asks").fetchone()["state"] == "answered"


def test_a_presence_judged_with_no_place_still_goes_to_the_events_address(drives):
    start = when(drives, days=3, hour=10)
    at(drives, "Skating HMLC", start, "HMLC, " + CLINIC, judged_place="none")
    go(drives)
    go(drives)
    assert blocks(drives) == drove_to(start, CLINIC)


def test_a_presence_judged_with_no_place_takes_the_book_too(drives):
    book(drives, (RINK, CLINIC, "2026-10-20"))
    start = when(drives, days=3, hour=10)
    at(drives, "Skating HMLC", start, RINK, judged_place="none")
    go(drives)
    go(drives)
    assert blocks(drives) == drove_to(start, CLINIC)


@pytest.mark.parametrize("judged_place", ["home", "school"])
def test_a_presence_judged_at_home_or_school_takes_no_address(drives, judged_place):
    start = when(drives, days=3, hour=10)
    at(drives, "Call with Pat", start, CLINIC, judged_place=judged_place)
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "")]
    assert drives.maps.urls == [] and place_cards(drives) == []


# -- asking him once ----------------------------------------------------------------------------------

def test_a_place_nothing_can_place_goes_to_the_map_once_and_is_asked_once(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating HMLC", start, RINK)
    goes(drives, "Hockey", start + timedelta(days=1), "hmlc")     # the same place, another event
    for _ in range(3):
        go(drives)
    assert blocks(drives)[0] == ("Busy (family)", start, start + 60 * M, "")
    assert geocoded(drives) == [RINK]                             # not found is kept too
    (card,) = place_cards(drives)
    _, text, buttons, _ = card
    assert text == f"Where is HMLC? (for Skating HMLC, {day(start)}) Reply with an address, or tap Skip."
    assert labels(buttons) == ["Skip"]
    assert [tuple(r) for r in drives.ledger.db.execute("SELECT key, state FROM place_asks")] == [("hmlc", "asked")]


def test_each_new_place_gets_its_own_card_named(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating HMLC", start, RINK)
    goes(drives, "Swim", start + timedelta(days=1), "Pine Ridge Pool")
    go(drives)
    go(drives)
    assert sorted(s[1].split("?")[0] for s in place_cards(drives)) == ["Where is HMLC", "Where is Pine Ridge Pool"]


def test_nothing_is_asked_past_two_weeks(drives):
    goes(drives, "Skating HMLC", when(drives, days=20, hour=10), RINK)
    go(drives)
    go(drives)
    assert place_cards(drives) == []


def test_skip_is_remembered_and_never_asked_again(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating HMLC", start, RINK)
    go(drives)
    go(drives)
    card = drives.with_button("Skip")
    drives.press(card, "Skip")
    assert "won't ask where HMLC is again" in drives.bot.sent[-1][1]
    goes(drives, "Skating HMLC", start + timedelta(days=1), RINK)  # moved: still the same place
    for _ in range(3):
        go(drives)
    assert len(place_cards(drives)) == 1
    assert drives.ledger.db.execute("SELECT state FROM place_asks").fetchone()["state"] == "skipped"
    book(drives, (RINK, CLINIC, "2026-10-21"))                    # he raised it himself
    go(drives)
    go(drives)
    assert blocks(drives) == drove_to(start + timedelta(days=1), CLINIC)


def test_skip_in_the_book_is_remembered_too(drives):
    assert book(drives, (RINK, "skip", "2026-10-20")) == (0, 1)
    start = when(drives, days=3, hour=10)
    goes(drives, "Skating HMLC", start, RINK)
    for _ in range(3):
        go(drives)
    assert place_cards(drives) == [] and drives.maps.urls == []


# -- the map, by name near home ----------------------------------------------------------------------

def test_a_name_the_map_finds_near_home_gets_its_drive_and_its_name_and_address(named):
    start = when(named, days=3, hour=10)
    goes(named, "Skating with Pat", start, FUNKYS)
    go(named)
    go(named)
    assert blocks(named) == drove_to(start, FUNKYS_AT)
    (url,) = named.maps.urls[:1]
    q = parse_qs(urlsplit(url).query)
    assert q["q"] == [FUNKYS] and q["bounded"] == ["1"] and q["addressdetails"] == ["1"]
    assert q["viewbox"] == ["-79.5,39.5,-77.5,37.5"]              # about a degree around home
    assert geocoded(named) == [FUNKYS]                            # only the location; the drive to it isn't a second lookup
    assert place_cards(named) == []


@pytest.mark.parametrize("written", ["funkys skate center", "  The Funky's  Skate Center "])
def test_the_name_matches_without_case_apostrophes_or_the(named, written):
    named.names[" ".join(written.split())] = [FUNKYS_FOUND]
    start = when(named, days=3, hour=10)
    goes(named, "Skating", start, written)
    go(named)
    go(named)
    assert [b[3] for b in blocks(named)] == ["", FUNKYS_AT, ""]


def test_a_near_miss_is_not_found_and_he_is_asked(named):
    named.names["Funky's Roller Rink"] = [FUNKYS_FOUND]           # "roller rink" isn't in its name
    start = when(named, days=3, hour=10)
    goes(named, "Skating", start, "Funky's Roller Rink")
    go(named)
    go(named)
    assert blocks(named) == [("Busy (family)", start, start + 60 * M, "")]
    (card,) = place_cards(named)
    assert card[1].startswith("Where is Funky's Roller Rink? (for Skating, ")


def test_each_name_goes_out_once_found_or_not(named):
    start = when(named, days=3, hour=10)
    goes(named, "Skating", start, FUNKYS)
    goes(named, "Hockey", start + timedelta(days=1), "funkys skate center")
    goes(named, "Swim", start + timedelta(days=2), "Nowhere Pool")
    for _ in range(3):
        go(named)
    assert sorted(geocoded(named)) == sorted([FUNKYS, "Nowhere Pool"])


def test_the_map_down_or_out_of_lookups_asks_nothing_and_tries_again_next_read(named, monkeypatch):
    start = when(named, days=3, hour=10)
    goes(named, "Skating", start, FUNKYS)
    monkeypatch.setattr(drive, "MAX_REQUESTS_PER_READ", 0)        # this read's lookups are spent
    go(named)
    go(named)
    assert blocks(named) == [("Busy (family)", start, start + 60 * M, "")]
    assert named.maps.urls == [] and place_cards(named) == []
    monkeypatch.setattr(drive, "MAX_REQUESTS_PER_READ", 10)
    named.maps.fail = "down"
    go(named)
    assert place_cards(named) == []                               # a failure isn't "not found"
    named.maps.fail = None
    go(named)
    go(named)
    assert blocks(named) == drove_to(start, FUNKYS_AT) and place_cards(named) == []


def test_a_place_the_map_has_no_street_for_is_its_map_point(named):
    named.names[FUNKYS] = [{**FUNKYS_FOUND, "address": {"city": "Harrisonburg"}}]
    start = when(named, days=3, hour=10)
    goes(named, "Skating", start, FUNKYS)
    go(named)
    go(named)
    assert blocks(named) == drove_to(start, "38.4, -78.4")


def test_no_home_no_search_by_name(named):
    named.home = ""
    start = when(named, days=3, hour=10)
    goes(named, "Skating", start, FUNKYS)
    go(named)
    go(named)
    assert named.maps.urls == [] and len(place_cards(named)) == 1


def test_a_long_note_is_never_sent_as_a_name(named):
    note = "Funky's Skate Center " + "bring the blue bag and call Pat when you get there " * 2
    start = when(named, days=3, hour=10)
    goes(named, "Skating", start, note)
    go(named)
    go(named)
    assert named.maps.urls == []


def test_what_a_block_may_carry_as_its_place():
    assert drive.sound_place(FUNKYS_AT) and google_cal._sound_place(FUNKYS_AT)
    assert drive.sound_place("100 Miller Circle, Harrisonburg, VA 22801") and drive.sound_place("38.4, -78.4")
    assert drive.sound_place("")
    for bad in ("Funky's Skate Center", "Call Pat: 555-0100, 100 Miller Circle, Harrisonburg, VA 22801",
                "https://x.example, 100 Miller Circle, Harrisonburg, VA 22801", ", 100 Miller Circle, Harrisonburg, VA"):
        assert not drive.sound_place(bad), bad


# -- what Cain sends --------------------------------------------------------------------------------

PLACE_ROW = {"place": "HMLC", "address": "12 Rink Rd, Leesburg, VA 20175", "said_on": "2026-10-01"}


@pytest.mark.parametrize("body, why", [
    ({}, "rows must be a list"),
    ({"rows": [PLACE_ROW] * (places.MAX_ROWS + 1)}, "at most"),
    ({"rows": [{**PLACE_ROW, "note": "x"}]}, "row 1: needs exactly"),
    ({"rows": [{**PLACE_ROW, "address": "the rink by Pat's"}]}, "row 1: address must be a street address"),
    ({"rows": [{**PLACE_ROW, "address": "HMLC"}]}, "row 1: address must be a street address"),
    ({"rows": [{**PLACE_ROW, "address": "91, 200"}]}, "row 1: address must be a street address"),
    ({"rows": [{**PLACE_ROW, "address": "x" * 201}]}, "row 1: address must be 1 to"),
    ({"rows": [{**PLACE_ROW, "address": 5}]}, "row 1: address must be 1 to"),
    ({"rows": [{**PLACE_ROW, "place": "x" * 81}]}, "row 1: place must be"),
    ({"rows": [{**PLACE_ROW, "place": "!!! ???"}]}, "row 1: place must be"),
    ({"rows": [{**PLACE_ROW, "place": "a\x00b"}]}, "row 1: place must be"),
    ({"rows": [{**PLACE_ROW, "place": " ".join(f"w{n}" for n in range(9))}]}, "row 1: place must be"),
    ({"rows": [PLACE_ROW, {**PLACE_ROW, "said_on": "soon"}]}, "row 2: said_on"),
    ({"rows": [{**PLACE_ROW, "said_on": "2099-01-01"}]}, "row 1: said_on must not be in the future"),
])
def test_the_place_book_is_checked_strictly(body, why):
    rows, reason = places.validate_rows(body)
    assert rows is None and reason.startswith(why)
    assert "Pat" not in reason and "w8" not in reason and "HMLC" not in reason   # never an echo


def test_a_book_row_keeps_only_the_recognized_address():
    rows, _ = places.validate_rows({"rows": [
        {**PLACE_ROW, "place": " H.M.L.C  Rink ", "address": "Front desk, 12 Rink Rd, Leesburg, VA 20175"},
        {**PLACE_ROW, "place": "Farm", "address": " 38.51 , -78.2 "},
        {**PLACE_ROW, "place": "Gym", "address": "Skip"}]})
    assert rows == [
        {"key": "h m l c rink", "address": "12 Rink Rd, Leesburg, VA 20175", "skip": False, "said_on": "2026-10-01"},
        {"key": "farm", "address": "38.51, -78.2", "skip": False, "said_on": "2026-10-01"},
        {"key": "gym", "address": "", "skip": True, "said_on": "2026-10-01"}]


def test_the_newest_row_for_a_place_wins_and_the_book_replaces_the_last(lv):
    pb = lv.live.places
    rows, _ = places.validate_rows({"rows": [
        {"place": "HMLC", "address": PARK, "said_on": "2026-10-05"},
        {"place": "hmlc", "address": CLINIC, "said_on": "2026-09-01"},       # older, though lower
        {"place": "Gym", "address": CLINIC, "said_on": "2026-10-01"},
        {"place": "gym", "address": PARK, "said_on": "2026-10-01"}]})        # same day: the lower row
    assert pb.import_rows(rows) == (2, 0)
    assert pb.resolve("HMLC")[0] == PARK and pb.resolve("Gym")[0] == PARK
    rows, _ = places.validate_rows({"rows": [{"place": "Gym", "address": CLINIC, "said_on": "2026-10-02"}]})
    pb.import_rows(rows)
    assert pb.resolve("Gym")[0] == CLINIC and pb.resolve("HMLC")[0] == ""          # out of the book now
    assert pb.resolve("Zoom with Gym") == ("", False) and pb.resolve("") == ("", False)
    assert pb.resolve("Nowhere") == ("", True)                                # nothing knows it: ask


def test_the_controller_stores_the_book_cain_sends(ledger, tmp_path, clock):
    from test_discord_keeper import Rig as CainRig
    r = CainRig(ledger, tmp_path, clock)
    r.c.meaning_live = meaning_live.MeaningLive(ledger, Shadow(), Feeds(), tz=TZ, on_fn=lambda: False)
    rows, _ = places.validate_rows({"rows": [PLACE_ROW, {**PLACE_ROW, "place": "Gym", "address": "skip"}]})
    out = r.send(handover.Handover(kind="places", rows=rows))
    assert out["status"] == "ok" and out["said"] == "Stored 1 place; 1 skipped."
    assert r.c.meaning_live.places.resolve("hmlc")[0] == "12 Rink Rd, Leesburg, VA 20175"


def test_keeper_sh_posts_the_place_book(tmp_path):
    """bun and curl are stand-ins that record what they're given; the table is real."""
    bash, jq = shutil.which("bash"), shutil.which("jq")
    if not (bash and jq):
        pytest.skip("needs bash and jq")
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "bun").write_text("#!/bin/bash\nprintf fakekey\n")
    (bin_ / "curl").write_text(
        "#!/bin/bash\n"
        'while [ $# -gt 0 ]; do case "$1" in -H) shift 2 ;;'
        ' -d) printf %s "$2" > "$OUT.body"; shift 2 ;; -m) shift 2 ;; -sS) shift ;;'
        ' *) printf %s "$1" > "$OUT.url"; shift ;; esac; done\n'
        "echo '{\"status\": \"ok\"}'\n")
    for f in ("bun", "curl"):
        (bin_ / f).chmod(0o755)
    table = tmp_path / "places.md"
    table.write_text("# Where places are\n\n| Place | Address | Said on |\n|---|---|---|\n"
                     "| HMLC | 12 Rink Rd, Leesburg, VA 20175 | 2026-10-01 |\n| Farm | 38.5, -78.2 | 2026-10-02 |\n"
                     "| not a row |\n")
    out_ = tmp_path / "rec"
    env = {"PATH": f"{bin_}:" + __import__("os").environ["PATH"], "OUT": str(out_)}
    sh = str(ROOT / "cain/rootfs/opt/cain/keeper.sh")
    run = subprocess.run([bash, sh, "places", str(table)], env=env, capture_output=True, text=True, timeout=30)
    assert json.loads(run.stdout)["status"] == "ok"
    assert Path(f"{out_}.url").read_text() == "http://0fcc2575-harness:8098/places"
    assert json.loads(Path(f"{out_}.body").read_text()) == {"rows": [
        {"place": "HMLC", "address": "12 Rink Rd, Leesburg, VA 20175", "said_on": "2026-10-01"},
        {"place": "Farm", "address": "38.5, -78.2", "said_on": "2026-10-02"}]}


def test_cains_rules_keep_the_place_book_and_answer_the_card():
    script = (ROOT / "cain/rootfs/opt/cain/keeper.sh").read_text()
    code = "\n".join(l for l in script.splitlines() if not l.strip().startswith("#"))
    assert "handover|digest|meanings|places)" in code
    rules = (ROOT / "cain/rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "areas/home/places.md" in rules and "/opt/cain/keeper.sh places" in rules
    assert "`| Place | Address | Said on |`" in rules and "Reply with an address, or tap Skip." in rules
    assert "/places" in handover.ROUTES
