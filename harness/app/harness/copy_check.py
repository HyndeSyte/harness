"""The first-day check of Family copies, the other way round (round 3 of the second review of Nov 27).

DOCS step 3d has people's edits on real copies read as edits. This is the other direction: one untouched copy of
Harness's own, made on the real Family calendar, read back, moved and taken off, must read as the App's own at each
step, so iCloud's real way of keeping a copy never makes Harness leave its own copies alone. Run once per install,
by hand, in the App's container (DOCS 3e):

    python3 -m harness.copy_check /data --out /data/copy-check

It writes only its own throwaway copy, under a fresh address of its own (a fixed title, "Harness check - Copy",
tomorrow at noon for an hour, then moved to 1 PM), through the same guarded writes the App uses (If-None-Match on
the create, If-Match on the version just read for the move and the removal), and takes it off at the end whatever
happened. Each body iCloud hands back is saved under --out (created.ics, moved.ics) with summary.json: what was
written and, for each step, whether it read as the App's own and if not which lines differ (their names only).
Those files hold the copy's address, its fixed title, its times and iCloud's own lines, nothing of his; read them
before copying them into tests/fixtures/family_copy_icloud/ in a build, where the tests judge them like the
modelled shapes. Prints one line per step and exits 0 only when every step read as the App's own.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import caldav

TITLE = "Harness check - Copy"


def run(client, out_dir: str, now: datetime, tz: str) -> dict:
    """The four steps against `client` (a caldav.FamilyCalDav). Returns the summary also written to out_dir."""
    zone = ZoneInfo(tz)
    day = (now.astimezone(zone) + timedelta(days=1)).date()
    start = datetime(day.year, day.month, day.day, 12, tzinfo=zone)
    end, later, later_end = start + timedelta(hours=1), start + timedelta(hours=1), start + timedelta(hours=2)
    uid = "hx-firstday-" + secrets.token_hex(8)
    href = client.href_for(uid)
    steps: list[dict] = []
    summary = {"uid": uid, "title": TITLE, "tz": tz, "created": {"start": start.isoformat(), "end": end.isoformat()},
               "moved": {"start": later.isoformat(), "end": later_end.isoformat()}, "steps": steps}
    os.makedirs(out_dir, exist_ok=True)

    def step(name: str, ok: bool, **more) -> bool:
        steps.append({"step": name, "ok": bool(ok), **more})
        verdict = "ok" if ok else "not the App's own"
        print(f"{name}: {verdict}"
              + (f" ({', '.join(more['differs'])})" if more.get("differs") else "")
              + (f" [{more['answer']}]" if more.get("answer") else ""))
        return ok

    def read_as(name: str, fields: tuple) -> tuple[bool, str]:
        back, body = client.fetch(href)
        if back.kind != "ok" or not body:
            step(name, False, answer=back.kind)
            return False, ""
        with open(os.path.join(out_dir, f"{name.split()[0]}.ics"), "w", encoding="utf-8", newline="") as f:
            f.write(body)
        differs = caldav.copy_differences(body, uid, *fields)
        step(name, not differs, differs=differs)
        return not differs, back.etag or ""

    try:
        out = client.copy_write(uid, caldav.build_copy_ics(uid, TITLE, start, end, now), None)
        if step("create", out.kind == "ok", answer=out.kind):
            ok, etag = read_as("created read back", (TITLE, start, end))
            if ok and etag:
                out = client.copy_write(uid, caldav.build_copy_ics(uid, TITLE, later, later_end, now), etag)
                if step("move", out.kind == "ok", answer=out.kind):
                    ok, etag = read_as("moved read back", (TITLE, later, later_end))
                    if etag:
                        out = client.copy_delete(uid, etag)
                        if step("delete", out.kind in ("ok", "gone"), answer=out.kind):
                            back, _ = client.fetch(href)
                            step("deleted read back", back.kind == "gone", answer=back.kind)
    finally:
        _clean(client, href, uid, steps)
        summary["all_ok"] = bool(steps) and all(s["ok"] for s in steps) and len(steps) == 6
        with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=1, sort_keys=True)
    return summary


def _clean(client, href: str, uid: str, steps: list[dict]) -> None:
    """Its own throwaway copy off, whatever happened (only this run's own fresh address is ever touched)."""
    if steps and steps[-1]["step"] == "deleted read back" and steps[-1]["ok"]:
        return
    try:
        back, _ = client.fetch(href)
        if back.kind == "ok" and back.etag:
            got = client.copy_delete(uid, back.etag)
            print(f"cleanup: {got.kind}")
    except Exception as e:                    # noqa: BLE001: the check's result stands; say the cleanup failed
        print(f"cleanup failed: {type(e).__name__}; take off “{TITLE}” tomorrow on Family by hand")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python3 -m harness.copy_check")
    p.add_argument("data_dir")
    p.add_argument("--out", default="")
    a = p.parse_args(argv)
    from .net import CalDavTransport
    from .vault import Vault
    vault = Vault(os.path.join(a.data_dir, "secrets.json"))
    client = caldav.FamilyCalDav(CalDavTransport(lambda: caldav.host_of(vault.get("family_calendar_url"))),
                                 lambda: (vault.get("family_apple_id"), vault.get("family_app_password"),
                                          vault.get("family_calendar_url")))
    if not client.configured():
        print("the Family calendar isn't set up on the Harness page")
        return 2
    try:
        with open(os.path.join(a.data_dir, "options.json"), encoding="utf-8") as f:
            tz = str(json.load(f).get("timezone") or "UTC")
        ZoneInfo(tz)
    except (OSError, ValueError, KeyError, AttributeError):
        tz = "UTC"
    got = run(client, a.out or os.path.join(a.data_dir, "copy-check"), datetime.now(timezone.utc), tz)
    return 0 if got["all_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
