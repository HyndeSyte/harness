"""The pull request's own check, run by .github/workflows/pr.yml (RELEASING.md).

1. The description follows .github/pull_request_template.md: each of its four
   headings is there, with something written under it.
2. Each App whose shipped files changed goes up exactly one version step from
   main (patch, minor or major), and its CHANGELOG.md opens with a section for
   that version. An App whose shipped files didn't change keeps main's version.
   Shipped means anything in the App's folder except its tests/ and tools/.

In CI it reads the pull request from GITHUB_EVENT_PATH. By hand, from the repo:
  python .github/scripts/check_pr.py --base origin/main --head HEAD --body-file body.md
Exit 0 when everything passes; otherwise one line per problem and exit 1.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

APPS = ("harness", "cain")
NOT_SHIPPED = ("tests/", "tools/")
HEADINGS = ("What changed", "How it was tested", "Not verified", "Anything Dane must do")
VERSION_RE = re.compile(r'^version:\s*"?(\d+)\.(\d+)\.(\d+)"?\s*$', re.M)

Version = tuple[int, int, int]


def parse_version(config_text: str) -> Version | None:
    m = VERSION_RE.search(config_text or "")
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def next_steps(v: Version) -> list[Version]:
    major, minor, patch = v
    return [(major, minor, patch + 1), (major, minor + 1, 0), (major + 1, 0, 0)]


def show(v: Version | None) -> str:
    return ".".join(map(str, v)) if v else "none"


def changelog_top(text: str) -> str | None:
    for line in (text or "").splitlines():
        if line.startswith("## "):
            return line[3:].strip()
    return None


def shipped(app: str, path: str) -> bool:
    if not path.startswith(app + "/"):
        return False
    return not path[len(app) + 1:].startswith(NOT_SHIPPED)


def check_body(body: str) -> list[str]:
    sections: dict[str, list[str]] = {}
    current = None
    for line in (body or "").replace("\r\n", "\n").split("\n"):
        if line.startswith("## "):
            current = line[3:].strip()
            sections.setdefault(current, [])
        elif current is not None:
            sections[current].append(line)
    problems = []
    for h in HEADINGS:
        if h not in sections:
            problems.append(f'The description has no "## {h}" section '
                            "(see .github/pull_request_template.md).")
        elif not "\n".join(sections[h]).strip():
            problems.append(f'The "## {h}" section is empty. Write something, even "Nothing."')
    return problems


def check_versions(changed: list[str], base: dict[str, tuple[str, str]],
                   head: dict[str, tuple[str, str]]) -> list[str]:
    """base and head: {app: (config.yaml text, CHANGELOG.md text)} on main and in the pull request."""
    problems = []
    for app in APPS:
        old = parse_version(base.get(app, ("", ""))[0])
        new = parse_version(head.get(app, ("", ""))[0])
        log = head.get(app, ("", ""))[1]
        if old is None and new is None:
            continue
        if new is None:
            problems.append(f"{app}/config.yaml has no version.")
            continue
        touched = any(shipped(app, p) for p in changed)
        if old is not None and not touched:
            if new != old:
                problems.append(f"{app} says {show(new)}, but none of its shipped files changed. "
                                f"Keep main's {show(old)}.")
            continue
        if old is not None and new not in next_steps(old):
            steps = ", ".join(show(s) for s in next_steps(old))
            problems.append(f"{app} changed, so its version goes one step up from main's {show(old)} "
                            f"({steps}). It says {show(new)}.")
        top = changelog_top(log)
        if top != show(new):
            problems.append(f'{app}/CHANGELOG.md should open with "## {show(new)}"; '
                            f'its first section is "{top or "missing"}".')
    return problems


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def file_at(ref: str, path: str) -> str:
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def snapshot(ref: str) -> dict[str, tuple[str, str]]:
    return {app: (file_at(ref, f"{app}/config.yaml"), file_at(ref, f"{app}/CHANGELOG.md"))
            for app in APPS}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base", help="main, as a git ref")
    ap.add_argument("--head", default="HEAD", help="the pull request's head, as a git ref")
    ap.add_argument("--body-file", help="the description, to check it too")
    a = ap.parse_args(argv)
    if a.base:
        base, head = a.base, a.head
        body = open(a.body_file, encoding="utf-8").read() if a.body_file else None
    else:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
            pr = json.load(f)["pull_request"]
        base, head, body = pr["base"]["sha"], pr["head"]["sha"], pr.get("body") or ""
    problems = check_body(body) if body is not None else []
    changed = [p for p in git("diff", "--name-only", f"{base}...{head}").splitlines() if p]
    problems += check_versions(changed, snapshot(base), snapshot(head))
    for p in problems:
        print(f"::error::{p}" if os.environ.get("GITHUB_ACTIONS") else p)
    if not problems:
        print("ok: the description follows the template, and versions step up where Apps changed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
