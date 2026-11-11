"""The pull request's own check, run by .github/workflows/pr.yml (RELEASING.md).

1. The branch is up to date: main is an ancestor of its head.
2. The description follows .github/pull_request_template.md: each of its four
   headings is there, with something written under it. In CI it is read live
   from the GitHub API, so a re-run sees the current text.
3. Each App whose shipped files changed goes up exactly one version step from
   main (patch, minor or major), and its CHANGELOG.md opens with a section for
   that version. An App whose shipped files didn't change keeps main's version.
   Shipped means anything in the App's folder except its tests/ and tools/
   (neither can reach the image: tests/test_check_pr.py checks the Dockerfiles).
   A change to a repo-root release file (repository.yaml) needs at least one App
   bumped. Versions fail closed: a config.yaml that exists must parse, with no
   duplicate keys, and carry a top-level string version X.Y.Z.
4. The required checks keep reporting: the pytest and bun jobs in tests.yml and
   the pr job in pr.yml keep their names, with no path or branch filters and no
   `if` or `continue-on-error`, and no other workflow reuses those names.

It reads the pull request only through git (diff, show, ls-tree) and never runs
or imports its files. In CI, pr.yml runs main's copy of this script:
  check_pr.py --base origin/main --head refs/remotes/pr/head --expect-head <sha>
              --pr <number> --repo <owner/name>      (GITHUB_TOKEN in the env)
By hand, from the repo (needs PyYAML):
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
import urllib.request

import yaml

APPS = ("harness", "cain")
NOT_SHIPPED = ("tests/", "tools/")
# Files outside the Apps that Home Assistant reads from main when it installs.
ROOT_RELEASE = ("repository.yaml",)
HEADINGS = ("What changed", "How it was tested", "Not verified", "Anything Dane must do")
SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
# The required checks (RELEASING.md): workflow file -> job ids that must stay as they are.
REQUIRED_JOBS = {".github/workflows/tests.yml": ("pytest", "bun"),
                 ".github/workflows/pr.yml": ("pr",)}
FILTER_KEYS = ("branches", "branches-ignore", "paths", "paths-ignore", "tags", "tags-ignore")
STALE = "The branch is not up to date with main, update it."

Version = tuple[int, int, int]


class VersionError(ValueError):
    pass


class _UniqueKeyLoader(yaml.SafeLoader):
    """SafeLoader that refuses a mapping with the same key twice."""


def _unique_mapping(loader, node, deep=False):
    seen = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key {key!r}", key_node.start_mark)
        seen.add(key)
    return loader.construct_mapping(node, deep=deep)


_UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _unique_mapping)


def load_yaml(text: str):
    return yaml.load(text, Loader=_UniqueKeyLoader)  # noqa: S506 (a SafeLoader)


def parse_version(config_text: str) -> Version:
    """The version in a config.yaml, or VersionError saying why there isn't one."""
    try:
        data = load_yaml(config_text)
    except yaml.YAMLError as e:
        raise VersionError(f"doesn't parse ({str(e).splitlines()[0]})") from None
    if not isinstance(data, dict):
        raise VersionError("isn't a mapping")
    if "version" not in data:
        raise VersionError("has no version")
    v = data["version"]
    m = SEMVER_RE.match(v) if isinstance(v, str) else None
    if not m:
        raise VersionError(f'has version {v!r}; it must be a string "X.Y.Z"')
    return int(m[1]), int(m[2]), int(m[3])


def next_steps(v: Version) -> list[Version]:
    major, minor, patch = v
    return [(major, minor, patch + 1), (major, minor + 1, 0), (major + 1, 0, 0)]


def show(v: Version | None) -> str:
    return ".".join(map(str, v)) if v else "none"


def changelog_top(text: str | None) -> str | None:
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


Snapshot = dict[str, tuple[str | None, str | None]]


def check_versions(changed: list[str], base: Snapshot, head: Snapshot) -> list[str]:
    """base and head: {app: (config.yaml text, CHANGELOG.md text)} on main and in the
    pull request, None where the file doesn't exist."""
    problems = []
    root_changed = sorted(p for p in changed if p in ROOT_RELEASE)
    bumped = []
    for app in sorted(set(APPS) | set(base) | set(head)):
        old_cfg = base.get(app, (None, None))[0]
        new_cfg, log = head.get(app, (None, None))
        if old_cfg is None and new_cfg is None:
            continue
        if new_cfg is None:
            problems.append(f"{app}/config.yaml is on main but not on this branch.")
            continue
        try:
            old = parse_version(old_cfg) if old_cfg is not None else None
        except VersionError as e:
            problems.append(f"main's {app}/config.yaml {e}; fix main before this can pass.")
            continue
        try:
            new = parse_version(new_cfg)
        except VersionError as e:
            problems.append(f"{app}/config.yaml {e}.")
            continue
        touched = any(shipped(app, p) for p in changed)
        if old is not None and not touched and (new == old or not root_changed):
            if new != old:
                problems.append(f"{app} says {show(new)}, but none of its shipped files changed. "
                                f"Keep main's {show(old)}.")
            continue
        if new != old:
            bumped.append(app)
        if old is not None and new not in next_steps(old):
            steps = ", ".join(show(s) for s in next_steps(old))
            problems.append(f"{app} changed, so its version goes one step up from main's {show(old)} "
                            f"({steps}). It says {show(new)}.")
        top = changelog_top(log)
        if top != show(new):
            problems.append(f'{app}/CHANGELOG.md should open with "## {show(new)}"; '
                            f'its first section is "{top or "missing"}".')
    if root_changed and not bumped:
        problems.append(f"{', '.join(root_changed)} changed, which ships from main, so at least one "
                        "App goes one version step up with a CHANGELOG section.")
    return problems


def _on(doc: dict):
    # YAML 1.1 reads a bare `on:` key as True.
    return doc.get("on", doc.get(True))


def _filters(on) -> list[str]:
    found = []
    if isinstance(on, dict):
        for event, cfg in on.items():
            if isinstance(cfg, dict):
                found += [f"{event}.{k}" for k in FILTER_KEYS if k in cfg]
    return found


def check_workflows(workflows: dict[str, str | None]) -> list[str]:
    """workflows: {path: text} for every workflow file on the branch, with the
    required ones present as None when they're missing."""
    problems = []
    names = {j for jobs in REQUIRED_JOBS.values() for j in jobs}
    for path in sorted(workflows):
        text = workflows[path]
        required = REQUIRED_JOBS.get(path, ())
        if text is None:
            problems.append(f"{path} is gone; it runs the required check(s) {', '.join(required)}.")
            continue
        try:
            doc = load_yaml(text)
        except yaml.YAMLError as e:
            problems.append(f"{path} doesn't parse ({str(e).splitlines()[0]}).")
            continue
        if not isinstance(doc, dict):
            problems.append(f"{path} isn't a workflow mapping.")
            continue
        jobs = doc.get("jobs") if isinstance(doc.get("jobs"), dict) else {}
        if required:
            for f in _filters(_on(doc)):
                problems.append(f"{path} filters its trigger ({f}); the required checks must "
                                "run on every pull request.")
        for job_id, job in jobs.items():
            job = job if isinstance(job, dict) else {}
            shown = job.get("name", job_id)
            if job_id in required:
                if "name" in job and job["name"] != job_id:
                    problems.append(f"{path}: job {job_id} is renamed to {job['name']!r}; "
                                    "the required check names stay fixed.")
                for key in ("if", "continue-on-error"):
                    if key in job:
                        problems.append(f"{path}: job {job_id} has `{key}`; a required check "
                                        "must always run and report.")
                for i, step in enumerate(job.get("steps") or []):
                    if isinstance(step, dict):
                        for key in ("if", "continue-on-error"):
                            if key in step:
                                problems.append(f"{path}: job {job_id} step {i + 1} has `{key}`.")
            elif job_id in names or shown in names:
                problems.append(f"{path}: job {job_id} reports as {shown!r}, the name of a "
                                "required check from another workflow.")
        for job_id in required:
            if job_id not in jobs:
                problems.append(f"{path} has no {job_id} job; it's a required check, keep its name.")
    return problems


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def changed_files(base: str, head: str) -> list[str]:
    """Every path added, deleted or modified. No rename detection, so a move
    counts at both its old and its new path."""
    out = git("diff", "--no-renames", "--name-only", "-z", base, head)
    return [p for p in out.split("\0") if p]


def is_up_to_date(base: str, head: str) -> bool:
    r = subprocess.run(["git", "merge-base", "--is-ancestor", base, head], capture_output=True)
    return r.returncode == 0


def file_at(ref: str, path: str) -> str | None:
    """The file's text at ref, or None when the file isn't there."""
    r = subprocess.run(["git", "cat-file", "-e", f"{ref}:{path}"], capture_output=True)
    if r.returncode != 0:
        return None
    return git("show", f"{ref}:{path}")


def tree(ref: str) -> list[str]:
    return [p for p in git("ls-tree", "-r", "-z", "--name-only", ref).split("\0") if p]


def snapshot(ref: str) -> Snapshot:
    # Home Assistant takes any top-level folder with a config.yaml as an App.
    apps = set(APPS) | {p.split("/")[0] for p in tree(ref) if re.fullmatch(r"[^/]+/config\.yaml", p)}
    return {app: (file_at(ref, f"{app}/config.yaml"), file_at(ref, f"{app}/CHANGELOG.md"))
            for app in apps}


def workflows_at(ref: str) -> dict[str, str | None]:
    paths = {p for p in tree(ref) if re.fullmatch(r"\.github/workflows/[^/]+\.ya?ml", p)}
    return {p: file_at(ref, p) for p in paths | set(REQUIRED_JOBS)}


def fetch_body(repo: str, number: int, token: str, opener=urllib.request.urlopen) -> str:
    """The description as it is now, from the GitHub API (not the event payload)."""
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/pulls/{int(number)}",
        headers={"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "check-pr"})
    with opener(req, timeout=30) as r:
        return json.load(r).get("body") or ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base", required=True, help="main, as a git ref (in CI, origin/main fetched now)")
    ap.add_argument("--head", default="HEAD", help="the pull request's head, as a git ref")
    ap.add_argument("--expect-head", help="the head sha this run is for; fail if the ref moved")
    ap.add_argument("--body-file", help="the description, to check it too")
    ap.add_argument("--pr", type=int, help="pull request number: read its description live")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"), help="owner/name")
    a = ap.parse_args(argv)
    problems: list[str] = []

    body = None
    if a.body_file:
        body = open(a.body_file, encoding="utf-8").read()
    elif a.pr is not None:
        try:
            body = fetch_body(a.repo, a.pr, os.environ["GITHUB_TOKEN"])
        except Exception as e:  # noqa: BLE001 (fail closed, whatever went wrong)
            problems.append(f"Couldn't read the description from GitHub ({type(e).__name__}). Re-run.")
    elif os.environ.get("GITHUB_ACTIONS"):
        problems.append("No pull request number, so the description can't be checked.")
    if body is not None:
        problems += check_body(body)

    head = git("rev-parse", "--verify", f"{a.head}^{{commit}}").strip()
    if a.expect_head and head != a.expect_head:
        problems.append(f"The pull request head is {head[:12]}, not {a.expect_head[:12]} as this "
                        "run expected. The run for the newer head checks it.")
    elif not is_up_to_date(a.base, head):
        problems.append(STALE)
    else:
        problems += check_versions(changed_files(a.base, head), snapshot(a.base), snapshot(head))
        problems += check_workflows(workflows_at(head))

    for p in problems:
        print(f"::error::{p}" if os.environ.get("GITHUB_ACTIONS") else p)
    if not problems:
        print("ok: up to date with main, the description follows the template, versions step up "
              "where Apps changed, and the required checks are intact")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
