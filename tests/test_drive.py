"""Drive times: what's sent, what's kept, and what happens when the map services fail."""
from __future__ import annotations

from urllib.parse import parse_qs, unquote_plus, urlsplit

import pytest

from harness import drive
from harness.drive import FAILED, NO_ADDRESS, Drives, street_address
from harness.ledger import Ledger
from harness.net import HttpResponse, MapTransport, TransportError

SCHOOL = "1 School St, Town, VA"


class FakeMaps:
    def __init__(self, places=None, seconds=660.0):
        self.places = places if places is not None else {SCHOOL: (1.0, 2.0), "2 Clinic Rd, Town, VA": (3.0, 4.0)}
        self.seconds = seconds
        self.urls = []
        self.fail = None
        self.status = 200

    def request(self, method, url, *, headers=None, timeout=30):
        assert method == "GET"
        self.urls.append(url)
        if self.fail:
            raise TransportError(self.fail)
        if self.status != 200:
            return HttpResponse(self.status, {}, b"")
        parts = urlsplit(url)
        if parts.hostname == drive.GEOCODE_HOST:
            found = self.places.get(parse_qs(parts.query)["q"][0])
            body = f'[{{"lat": "{found[0]}", "lon": "{found[1]}"}}]' if found else "[]"
        else:
            body = f'{{"routes": [{{"duration": {self.seconds}}}]}}'
        return HttpResponse(200, {}, body.encode())


@pytest.fixture
def maps():
    return FakeMaps()


@pytest.fixture
def drives(tmp_path, maps):
    return Drives(Ledger(str(tmp_path / "ledger.db")), maps, lambda: SCHOOL, sleep=lambda s: None)


@pytest.mark.parametrize("place,want", [
    ("1 School St, Town, VA", "1 School St, Town, VA"),
    ("Clinic, 88 Elm Ave, Town, VA 12345-6789", "88 Elm Ave, Town, VA 12345"),
    ("Cafe - Tasting Room (500 N Main Hwy, Town, VA 12345)", "500 N Main Hwy, Town, VA 12345"),
    ("A Church\n12 W Park St, Town, VA  12345, United States", "12 W Park St, Town, VA 12345"),
    ("Clinic-Town, 88 Elm Ave, Town, VA 12345-6789", "88 Elm Ave, Town, VA 12345"),
    ("40 Oak St\nTown, VA, United States", "40 Oak St, Town, VA"),
    ("12B Mill Rd, Town", "12B Mill Rd"),
    ("500 US-11, Town, VA", "500 US-11, Town, VA"),
    ("Bob's house", ""),
    ("Downtown", ""),
    ("", ""),
    ("Suite 4", ""),
    ("1 Long Rd, " + "x" * 300, "1 Long Rd"),
])
def test_only_the_street_address_is_kept(place, want):
    assert street_address(place) == want


@pytest.mark.parametrize("place,want", [
    ("1 on 1 with Sarah", ""),
    ("540 555 1212", ""),
    ("2 Clinic Rd (Dr Patel oncology)", "2 Clinic Rd"),
    ("2 Clinic Rd, Attn Dr Patel", "2 Clinic Rd"),
    ("Dr Patel, 2 Clinic Rd, Suite 4, Town, VA", "2 Clinic Rd"),
    ("3 people from Sarah's team", ""),
])
def test_a_name_or_note_never_goes_along(place, want):
    assert street_address(place) == want


def test_it_finds_the_drive_in_minutes(drives):
    assert drives.minutes("2 Clinic Rd, Town, VA") == 11


def test_only_the_address_goes_out(drives, maps):
    drives.minutes("The Clinic, 2 Clinic Rd, Town, VA")
    looked_up = [parse_qs(urlsplit(u).query)["q"][0] for u in maps.urls if drive.GEOCODE_HOST in u]
    assert looked_up == [SCHOOL, "2 Clinic Rd, Town, VA"]
    assert not any("The" in unquote_plus(u) for u in maps.urls)


def test_the_route_asks_from_the_school_in_lon_lat_order(drives, maps):
    drives.minutes("2 Clinic Rd, Town, VA")
    assert maps.urls[-1].split("/driving/")[1].split("?")[0] == "2.0,1.0;4.0,3.0"


def test_an_address_is_matched_near_the_school_first(drives, maps):
    drives.minutes("2 Clinic Rd, Town, VA")
    assert parse_qs(urlsplit(maps.urls[1]).query)["viewbox"] == ["1.0,2.0,3.0,0.0"]


def test_a_drive_too_long_to_be_true_is_no_answer(drives, maps):
    maps.seconds = 60 * 60 * 30
    assert drives.minutes("2 Clinic Rd, Town, VA") == NO_ADDRESS


def test_no_road_between_two_places_is_kept_and_doesnt_stop_other_lookups(drives, maps):
    maps.places["3 Mill Rd, Town, VA"] = (5.0, 6.0)
    real = maps.request

    def no_road(method, url, **kw):
        return HttpResponse(400, {}, b"") if "/route/" in url and "2.0,1.0;4.0,3.0" in url else real(method, url, **kw)

    maps.request = no_road
    assert drives.minutes("2 Clinic Rd, Town, VA") == NO_ADDRESS
    assert drives.minutes("3 Mill Rd, Town, VA") == 11
    drives.begin()
    assert drives.minutes("2 Clinic Rd, Town, VA") == NO_ADDRESS


def test_a_slow_read_stops_looking(tmp_path, maps):
    ticks = iter(range(0, 1000, 30))
    d = Drives(Ledger(str(tmp_path / "ledger.db")), maps, lambda: SCHOOL, sleep=lambda s: None,
               clock=lambda: next(ticks))
    assert d.minutes("2 Clinic Rd, Town, VA") == FAILED
    assert maps.urls == []


@pytest.mark.parametrize("place", ["", "Bob's house", "Downtown"])
def test_a_place_with_no_street_address_is_never_sent(drives, maps, place):
    assert drives.minutes(place) == NO_ADDRESS
    assert maps.urls == []


@pytest.mark.parametrize("place", ["https://zoom.us/j/123", "Zoom", "Microsoft Teams Meeting", "Google Meet",
                                   "Telehealth", "Virtual visit", "Online"])
def test_an_online_meeting_is_no_drive_and_never_sent(drives, maps, place):
    assert drives.minutes(place) == 0
    assert maps.urls == []


def test_an_answer_is_kept_so_an_address_goes_out_once(drives, maps):
    drives.minutes("2 Clinic Rd, Town, VA")
    sent = len(maps.urls)
    drives.begin()
    assert drives.minutes("2 Clinic Rd, Town, VA") == 11
    assert len(maps.urls) == sent


def test_the_school_is_looked_up_once_for_two_events(drives, maps):
    maps.places["3 Mill Rd, Town, VA"] = (5.0, 6.0)
    drives.minutes("2 Clinic Rd, Town, VA")
    drives.minutes("3 Mill Rd, Town, VA")
    assert sum(SCHOOL.split(",")[0].replace(" ", "+") in u for u in maps.urls) == 1


def test_an_address_the_map_doesnt_know_counts_as_no_address_and_isnt_asked_again(drives, maps):
    assert drives.minutes("9 Nowhere Ln, Town, VA") == NO_ADDRESS
    sent = len(maps.urls)
    drives.begin()
    assert drives.minutes("9 Nowhere Ln, Town, VA") == NO_ADDRESS
    assert len(maps.urls) == sent


def test_a_school_the_map_doesnt_know_is_a_failure_not_a_missing_address(tmp_path, maps):
    d = Drives(Ledger(str(tmp_path / "ledger.db")), maps, lambda: "9 Nowhere Ln, Town", sleep=lambda s: None)
    assert d.minutes("2 Clinic Rd, Town, VA") == FAILED


def test_a_failure_isnt_kept_and_ends_lookups_until_the_next_read(drives, maps):
    maps.fail = "network"
    assert drives.minutes("2 Clinic Rd, Town, VA") == FAILED
    sent = len(maps.urls)
    assert drives.minutes("3 Mill Rd, Town, VA") == FAILED
    assert len(maps.urls) == sent
    maps.fail = None
    drives.begin()
    assert drives.minutes("2 Clinic Rd, Town, VA") == 11


@pytest.mark.parametrize("status", [429, 500, 403])
def test_a_refusal_is_a_failure(drives, maps, status):
    maps.status = status
    assert drives.minutes("2 Clinic Rd, Town, VA") == FAILED


def test_a_garbled_answer_is_a_failure(drives, maps):
    maps.request = lambda *a, **k: HttpResponse(200, {}, b"not json")
    assert drives.minutes("2 Clinic Rd, Town, VA") == FAILED


def test_an_answer_of_the_wrong_shape_is_a_failure(drives, maps):
    maps.request = lambda *a, **k: HttpResponse(200, {}, b'{"routes": []}')
    assert drives.minutes("2 Clinic Rd, Town, VA") == FAILED


def test_one_read_sends_only_so_many_requests(drives, maps):
    for n in range(30):
        maps.places[f"{n + 10} Mill Rd, Town, VA"] = (5.0, float(n))
        drives.minutes(f"{n + 10} Mill Rd, Town, VA")
    assert len(maps.urls) <= drive.MAX_REQUESTS_PER_READ


def test_it_waits_between_requests(tmp_path, maps):
    waits = []
    d = Drives(Ledger(str(tmp_path / "ledger.db")), maps, lambda: SCHOOL, sleep=waits.append)
    d.minutes("2 Clinic Rd, Town, VA")
    assert waits == [1, 1]            # three requests, so two gaps


def test_no_school_address_means_off():
    assert not Drives(None, None, lambda: "").on()
    assert not Drives(None, None, lambda: "Downtown").on()
    assert Drives(None, None, lambda: SCHOOL).on()


@pytest.mark.parametrize("method,url", [
    ("POST", f"https://{drive.GEOCODE_HOST}/search"),
    ("GET", f"http://{drive.GEOCODE_HOST}/search"),
    ("GET", "https://example.com/search"),
    ("GET", f"https://user@{drive.GEOCODE_HOST}/search"),
    ("GET", f"https://{drive.GEOCODE_HOST}:8443/search"),
])
def test_the_transport_goes_nowhere_else(method, url):
    with pytest.raises(TransportError) as e:
        MapTransport(drive.HOSTS).request(method, url)
    assert e.value.kind == "blocked"
