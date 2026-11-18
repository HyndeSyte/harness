"""Family writes against the installed release (Harness 0.24.0, sixth round).

One scenario of recorded reads of his Gmail calendar's secret feed (full reads, one cut short, a
"this and following" split, a single cancellation, five appointments gone at once), with a Family
event he goes to, through the real sync loop. What it records: every write to Google (method,
title, start, end), read by read, and how many map lookups were made.

Run on main's code it is what the installed release writes for Family. Run on this head with the
drive dry run on, it must be exactly the same: his own appointments' drives are only logged.

The installed release's package can't be imported in the CI test run (the checkout there has only
the pull request's commit), so the test (tests/test_family_replay.py) compares this head with a
fixture of the release's recorded writes, family_replay_main.json, made by this script:

    python tests/tools/family_replay.py --record     # the release's writes into the fixture
    python tests/tools/family_replay.py --compare    # the release and this head, both run now, compared

Both modes take the installed release's harness package and tests (git archive of RELEASE_TAG when
that tag exists in the checkout, else of RELEASE_COMMIT; never of main) into a temporary folder, put
this file beside them and run it there with pytest, so the release's code runs with its own test
doubles. The fixture's header names the release, the tag and the commit it was recorded from.
Nothing here touches the network: Google, the map and Family are the tests' fakes.

Only the Family path is compared: writes of blocks marked as his own appointments' drives, and the
map lookups made for his own appointments (drive.Drives.lookups, per path), are reported apart.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURE = HERE / "family_replay_main.json"
# The installed release. The repository has no release tags yet, so its commit is hard-coded: the last
# commit on main that changed harness/ (its config.yaml says 0.23.0). Once the tag exists it's used.
RELEASE = "Harness 0.23.0"
RELEASE_TAG = "harness-0.23.0"
RELEASE_COMMIT = "e448e6db20746524238f11010f55924228279a26"
OUT_ENV = "FAMILY_REPLAY_OUT"
FEED_URL = "https://calendar.google.com/calendar/ical/parent%40gmail.com/private-0123456789abcdef/basic.ics"


def scenario(rig, monkeypatch, *, dry: bool = True) -> dict:
    """The recorded reads through the rig's real sync loop: {"writes": [[...], ...], "lookups": n}."""
    from urllib.parse import unquote, urlsplit

    from harness import calendar_feed, drive, google_cal
    from harness.net import HttpResponse
    from fakes import SyncExecutor
    from test_family_copy import GMAIL, NY, TZ, seed, when
    from test_meaning_live import CLINIC, PARK, goes, judged

    monkeypatch.setattr(drive, "MAX_REQUESTS_PER_READ", 2)       # lookups scarce: who goes first matters
    if dry:
        rig.gm.own_dry_fn = lambda: True                          # this head only: main has no such option

    def u(t):
        return t.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    def vev(uid, title, start, hours=1, place="", rrule=""):
        lines = ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{u(start)}", f"DTSTART:{u(start)}",
                 f"DTEND:{u(start + timedelta(hours=hours))}", f"SUMMARY:{title}"]
        if place:
            lines.append("LOCATION:" + place.replace(",", "\\,"))
        if rrule:
            lines.append("RRULE:" + rrule)
        return "\r\n".join([*lines, "END:VEVENT"])

    padding = [vev(f"old-{i}", f"Old thing {i}", datetime(2020, 1, 1, 9, tzinfo=NY) + timedelta(days=i))
               for i in range(40)]

    class FeedServer:
        status, headers, body = 200, {}, b""

        def request(self, method, url, *, headers=None, timeout=30, **kw):
            return HttpResponse(self.status, dict(self.headers), self.body)

    server = FeedServer()
    cal = calendar_feed.CalendarFeeds(rig.ledger, server, SyncExecutor(), lambda: FEED_URL, TZ, ahead_days=60)

    seen, orig = [], rig.google.request

    def request(method, url, *, headers=None, json_body=None, body=None, timeout=30):
        answer = orig(method, url, headers=headers, json_body=json_body, body=body, timeout=timeout)
        if method in ("POST", "PUT", "PATCH", "DELETE") and url != google_cal.TOKEN_URL:
            sent = json.loads(body) if body else {}
            key = sent.get("id") or unquote(urlsplit(url).path).rsplit("/", 1)[-1]
            event = rig.google.events.get(key, {})
            kind = ((event.get("extendedProperties") or {}).get("private") or {}).get("harness_kind", "")
            seen.append([method, event.get("summary"), (event.get("start") or {}).get("dateTime"),
                         (event.get("end") or {}).get("dateTime"), kind])
        return answer

    rig.google.request = request

    def fetch(events, cut, etag):
        body = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:" + GMAIL, *events, *padding,
                            "END:VCALENDAR"]) + "\r\n"
        if cut:
            body = body[:len(body) * 3 // 5]
        server.body, server.headers, server.status = body.encode(), {"etag": etag}, 200
        cal.start()
        cal.collect()
        rig.feeds.snapshot = cal.snapshot
        rig.feeds.generation += 1
        rig.tick()

    seed(rig, "Book club", when(rig, days=9))                       # Family isn't empty
    rig.judge.by["Book club"] = judged()
    day1 = when(rig, days=1, hour=8)
    goes(rig, "Eye doctor", when(rig, days=3, hour=11, minute=30), CLINIC)
    haircut = vev("haircut", "Haircut", when(rig, days=3, hour=10), place=PARK)
    series = vev("series-u", "PT", day1, place=CLINIC, rrule="FREQ=DAILY;COUNT=6")
    old = vev("series-u", "PT", day1, place=CLINIC, rrule=f"FREQ=DAILY;UNTIL={u(day1 + timedelta(days=2, hours=12))}")
    new = vev("series-u_R1", "PT", day1 + timedelta(days=3, hours=6), place=CLINIC, rrule="FREQ=DAILY;COUNT=3")
    dentist = vev("dentist", "Dentist", when(rig, days=2, hour=14), place=CLINIC)
    many = [vev(f"one-{i}", f"Thing {i}", when(rig, days=4 + i, hour=9), place=PARK) for i in range(5)]
    reads = [dict(events=[haircut, series, dentist, *many]),                # full
             dict(events=[haircut, series, dentist, *many]),
             dict(events=[haircut, series, dentist, *many], cut=True),      # cut short
             dict(events=[haircut, old, new, dentist, *many]),              # split, at a new time
             dict(events=[haircut, old, new, *many]),                       # the dentist cancelled
             dict(events=[haircut, old, new, *many]),
             dict(events=[haircut, old, new]),                              # five gone at once
             dict(events=[haircut, old, new]),
             dict(events=[haircut, old, new], advance=3),
             dict(events=[haircut, old, new], advance=3),
             dict(events=[haircut, old, new], cut=True)]
    counted = getattr(rig.gm.drives, "lookups", None)     # per path on this head; main counts them all as one
    before = len(rig.maps.urls)
    family_before = dict(counted) if counted is not None else {}
    out, own = [], []
    for n, r in enumerate(reads):
        if r.get("advance"):
            rig.clock.advance(hours=r["advance"])
        fetch(r["events"], r.get("cut", False), f'"v{n}"')
        out.append([w[:4] for w in seen if w[4] != "own_drive"])
        own.extend(w[:4] for w in seen if w[4] == "own_drive")
        seen.clear()
    if counted is None:
        return {"writes": out, "lookups": len(rig.maps.urls) - before}
    return {"writes": out, "lookups": counted["family"] - family_before.get("family", 0),
            "own_lookups": counted["own"] - family_before.get("own", 0), "own_writes": own}


# -- run inside a tree's tests folder by pytest (main's, for the fixture) -----------------------------------

if os.environ.get(OUT_ENV):
    from fake_caldav import no_network  # noqa: F401,E402  (autouse)
    from test_family_add import on, plain_prompt, rig  # noqa: F401,E402
    from test_family_gmail import g  # noqa: F401,E402
    from test_meaning_live import drives, live  # noqa: F401,E402

    def test_record(drives, monkeypatch):  # noqa: F811
        Path(os.environ[OUT_ENV]).write_text(json.dumps(scenario(drives, monkeypatch), indent=1) + "\n")


def _run_in(tree: Path, out: Path) -> dict:
    """This file run by pytest inside a tree's tests folder, its result read back."""
    target = tree / "tests" / "family_replay_case.py"
    shutil.copy(__file__, target)
    env = {**os.environ, OUT_ENV: str(out), "PYTHONHASHSEED": "0"}
    done = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(target)],
                          cwd=tree, env=env, capture_output=True, text=True)
    if done.returncode:
        sys.stderr.write(done.stdout[-4000:] + done.stderr[-4000:])
        raise SystemExit(f"the replay failed in {tree}")
    return json.loads(out.read_text())


def release_ref() -> str:
    """RELEASE_TAG when the checkout has it (and it is RELEASE_COMMIT), else RELEASE_COMMIT."""
    found = subprocess.run(["git", "rev-parse", "-q", "--verify", f"refs/tags/{RELEASE_TAG}^{{commit}}"], cwd=ROOT,
                           capture_output=True, text=True)
    if found.returncode == 0:
        if found.stdout.strip() != RELEASE_COMMIT:
            raise SystemExit(f"{RELEASE_TAG} points at {found.stdout.strip()}, not {RELEASE_COMMIT}")
        return RELEASE_TAG
    return RELEASE_COMMIT


def _release_tree(into: Path) -> Path:
    tree = into / "release"
    tree.mkdir()
    archive = subprocess.run(["git", "archive", release_ref(), "harness/app", "tests"], cwd=ROOT,
                             capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", str(tree)], input=archive, check=True)
    return tree


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "--compare"
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        installed = _run_in(_release_tree(tmp), tmp / "main.json")
        if mode == "--record":
            header = {"release": RELEASE, "tag": RELEASE_TAG, "commit": RELEASE_COMMIT,
                      "archived_from": release_ref()}
            FIXTURE.write_text(json.dumps({"recorded_from": header, **installed}, indent=1) + "\n")
            print(f"recorded {RELEASE}'s writes into {FIXTURE.relative_to(ROOT)}")
            return 0
        head_tree = tmp / "head"
        head_tree.mkdir()
        shutil.copytree(ROOT / "harness" / "app", head_tree / "harness" / "app")
        shutil.copytree(ROOT / "tests", head_tree / "tests", ignore=shutil.ignore_patterns("__pycache__"))
        head = _run_in(head_tree, tmp / "head.json")
    own = head.get("own_writes") or []                               # the dry run writes nothing for him
    head = {"writes": head["writes"], "lookups": head["lookups"]}     # the Family path only
    installed = {"writes": installed["writes"], "lookups": installed["lookups"]}
    same = head == installed and not own
    print("identical" if same else "DIFFERENT")
    if not same:
        print(json.dumps({"release": installed, "head": head, "head_own_writes": own}, indent=1))
    return 0 if same else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
