"""The pull request check (.github/scripts/check_pr.py): description and versions."""
import importlib.util
import io
import json
import pathlib
import re
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("check_pr", ROOT / ".github" / "scripts" / "check_pr.py")
check_pr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_pr)

GOOD_BODY = """## What changed

The add-ons watch each other.

## Review fixes

1. A fix.

## How it was tested

pytest and bun.

## Not verified

Nothing ran on the Pi.

## Anything Dane must do

Nothing.
"""


def cfg(v):
    return f'name: X\nversion: "{v}"\nslug: x\n'


def log(*versions):
    return "# Changelog\n\n" + "".join(f"## {v}\n\n- a change\n\n" for v in versions)


def state(harness=("0.19.13",), cain=("0.4.5",)):
    return {"harness": (cfg(harness[0]), log(*harness)), "cain": (cfg(cain[0]), log(*cain))}


# -- the description ------------------------------------------------------------

def test_a_full_description_passes_extra_sections_and_all():
    assert check_pr.check_body(GOOD_BODY) == []


def test_the_template_itself_fails_until_filled_in():
    template = (ROOT / ".github" / "pull_request_template.md").read_text(encoding="utf-8")
    problems = check_pr.check_body(template)
    assert len(problems) == 4 and all("is empty" in p for p in problems)


def test_a_missing_section_is_named():
    body = GOOD_BODY.replace("## Not verified\n\nNothing ran on the Pi.\n\n", "")
    assert check_pr.check_body(body) == [
        'The description has no "## Not verified" section (see .github/pull_request_template.md).']


def test_an_empty_section_is_named_and_windows_line_ends_are_fine():
    body = GOOD_BODY.replace("Nothing.\n", "").replace("\n", "\r\n")
    assert check_pr.check_body(body) == [
        'The "## Anything Dane must do" section is empty. Write something, even "Nothing."']


def test_no_description_at_all():
    assert len(check_pr.check_body("")) == 4


# -- versions ---------------------------------------------------------------------

@pytest.mark.parametrize("new", ["0.19.14", "0.20.0", "1.0.0"])
def test_one_step_up_with_its_changelog_passes(new):
    head = state(harness=(new, "0.19.13"))
    assert check_pr.check_versions(["harness/app/harness/x.py"], state(), head) == []


@pytest.mark.parametrize("new", ["0.19.15", "0.21.0", "0.19.13", "0.19.12", "0.20.1"])
def test_anything_but_one_step_fails(new):
    head = state(harness=(new, "0.19.13"))
    problems = check_pr.check_versions(["harness/app/harness/x.py"], state(), head)
    assert len(problems) == 1 and "one step up from main's 0.19.13" in problems[0]


def test_a_bump_without_its_changelog_section_fails():
    head = {"harness": (cfg("0.19.14"), log("0.19.13")), "cain": state()["cain"]}
    assert check_pr.check_versions(["harness/config.yaml"], state(), head) == [
        'harness/CHANGELOG.md should open with "## 0.19.14"; its first section is "0.19.13".']


def test_an_untouched_app_keeps_mains_version():
    head = state(harness=("0.19.14", "0.19.13"), cain=("0.4.6", "0.4.5"))
    assert check_pr.check_versions(["harness/app/harness/x.py"], state(), head) == [
        "cain says 0.4.6, but none of its shipped files changed. Keep main's 0.4.5."]


def test_tests_and_tools_are_not_shipped():
    changed = ["cain/tests/link.test.ts", "cain/tools/record-preflight.ts", "tests/test_x.py",
               ".github/workflows/tests.yml", "RELEASING.md"]
    assert check_pr.check_versions(changed, state(), state()) == []


def test_both_apps_changed_both_step_up():
    changed = ["harness/app/harness/watch.py", "cain/rootfs/opt/cain/link/watch.ts"]
    head = state(harness=("0.20.0", "0.19.13"), cain=("0.5.0", "0.4.5"))
    assert check_pr.check_versions(changed, state(), head) == []
    stale = state(harness=("0.20.0", "0.19.13"))
    assert len(check_pr.check_versions(changed, state(), stale)) == 1


def test_main_moved_past_the_branch():
    # The branch bumped cain to 0.4.6, but main is at 0.5.0 by now: rebase, then 0.5.1.
    problems = check_pr.check_versions(["cain/rootfs/etc/nginx/nginx.conf"], state(cain=("0.5.0",)),
                                       state(cain=("0.4.6", "0.4.5")))
    assert problems == ["cain changed, so its version goes one step up from main's 0.5.0 "
                        "(0.5.1, 0.6.0, 1.0.0). It says 0.4.6.",
                        ]


def test_a_move_out_of_the_app_counts_as_a_shipped_change():
    # The diff runs with --no-renames: a move shows at its old path too.
    changed = ["cain/rootfs/opt/cain/keeper.sh", "cain/tests/keeper.sh"]
    problems = check_pr.check_versions(changed, state(), state())
    assert problems == ["cain changed, so its version goes one step up from main's 0.4.5 "
                        "(0.4.6, 0.5.0, 1.0.0). It says 0.4.5."]


# -- versions fail closed ------------------------------------------------------------

@pytest.mark.parametrize("text, why", [
    ('name: X\nversion: "0.4.5"\nversion: "0.4.6"\n', "duplicate key"),
    ('name: X\nversion: "0.4.5\n', "doesn't parse"),
    ("name: X\nslug: x\n", "has no version"),
    ("name: X\nversion: 0.4\n", "must be a string"),
    ('name: X\nversion: "0.4.5-beta"\n', "must be a string"),
    ('name: X\nversion: "v0.4.5"\n', "must be a string"),
    ('options:\n  version: "0.4.5"\n', "has no version"),
    ("- a list\n", "isn't a mapping"),
])
def test_a_bad_version_on_main_is_a_problem_not_a_skip(text, why):
    base = {"harness": state()["harness"], "cain": (text, log("0.4.5"))}
    problems = check_pr.check_versions(["cain/run.sh"], base, state(cain=("0.4.6", "0.4.5")))
    assert len(problems) == 1 and problems[0].startswith("main's cain/config.yaml") and why in problems[0]
    # Even when the App's files didn't change.
    assert len(check_pr.check_versions([], base, state())) == 1


def test_a_bad_version_on_the_branch_is_a_problem():
    head = {"harness": state()["harness"],
            "cain": ('version: "0.4.6"\nversion: "0.4.5"\n', log("0.4.6", "0.4.5"))}
    problems = check_pr.check_versions(["cain/run.sh"], state(), head)
    assert len(problems) == 1 and problems[0].startswith("cain/config.yaml doesn't parse")
    head["cain"] = ("name: X\n", log("0.4.5"))
    assert check_pr.check_versions([], state(), head) == ["cain/config.yaml has no version."]


def test_only_a_new_app_has_no_old_version():
    head = dict(state(), lamp=(cfg("0.1.0"), log("0.1.0")))
    assert check_pr.check_versions(["lamp/config.yaml"], state(), head) == []
    head["lamp"] = (cfg("0.1.0"), None)
    assert check_pr.check_versions(["lamp/config.yaml"], state(), head) == [
        'lamp/CHANGELOG.md should open with "## 0.1.0"; its first section is "missing".']


def test_an_app_removed_on_the_branch_is_a_problem():
    head = dict(state(), cain=(None, None))
    assert check_pr.check_versions(["cain/config.yaml"], state(), head) == [
        "cain/config.yaml is on main but not on this branch."]


# -- repo-root release files ---------------------------------------------------------

def test_repository_yaml_alone_fails():
    assert check_pr.check_versions(["repository.yaml"], state(), state()) == [
        "repository.yaml changed, which ships from main, so at least one App goes one version "
        "step up with a CHANGELOG section."]


def test_repository_yaml_with_an_app_bumped_passes():
    head = state(cain=("0.4.6", "0.4.5"))
    assert check_pr.check_versions(["repository.yaml"], state(), head) == []
    head = state(cain=("0.4.7", "0.4.5"))
    assert len(check_pr.check_versions(["repository.yaml"], state(), head)) == 1


# -- what ships: tests/ and tools/ can't reach an App's image -----------------------------

def _dockerfile_instructions(text):
    joined = re.sub(r"\\\n", " ", text)
    for line in joined.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            yield line.split(None, 1)[0].upper(), (line.split(None, 1) + [""])[1]


@pytest.mark.parametrize("app", check_pr.APPS)
def test_tests_and_tools_never_reach_the_image(app):
    """The build context is the App's folder. check_pr.NOT_SHIPPED holds only if the
    Dockerfile copies named folders other than tests/ and tools/, with nothing that
    could pull in the whole context."""
    folder = ROOT / app
    assert check_pr.NOT_SHIPPED == ("tests/", "tools/")
    for op, args in _dockerfile_instructions((folder / "Dockerfile").read_text(encoding="utf-8")):
        assert "--mount" not in args, f"{app}: RUN --mount can read the whole build context"
        if op not in ("COPY", "ADD"):
            continue
        parts = [p for p in args.split() if not p.startswith("--")]
        if any(p.startswith("--from") for p in args.split()):
            continue
        for src in parts[:-1]:
            src = src.strip('"[],')
            top = src.lstrip("./").split("/")[0]
            assert top and not any(c in src for c in "*?["), f"{app}: {op} {src} copies too much"
            assert f"{top}/" not in check_pr.NOT_SHIPPED, f"{app}: {op} {src} ships {top}/"
            assert (folder / src).exists(), f"{app}: {op} {src} isn't in the App's folder"
    ignore = folder / ".dockerignore"
    if ignore.exists():
        lines = {ln.strip().strip("/") for ln in ignore.read_text(encoding="utf-8").splitlines()}
        for d in check_pr.NOT_SHIPPED:
            assert d.strip("/") not in {ln.lstrip("!") for ln in lines if ln.startswith("!")}


# -- the required checks keep reporting -------------------------------------------------

def _workflows():
    return {p: (ROOT / p).read_text(encoding="utf-8") for p in check_pr.REQUIRED_JOBS}


def test_this_repos_workflows_pass():
    assert check_pr.check_workflows(_workflows()) == []


def test_a_path_filter_on_a_required_check_fails():
    w = _workflows()
    w[".github/workflows/tests.yml"] = w[".github/workflows/tests.yml"].replace(
        "  pull_request:\n", "  pull_request:\n    paths: ['harness/**']\n")
    assert check_pr.check_workflows(w) == [
        ".github/workflows/tests.yml filters its trigger (pull_request.paths); the required "
        "checks must run on every pull request."]
    w = _workflows()
    w[".github/workflows/pr.yml"] = w[".github/workflows/pr.yml"].replace(
        "    types: [opened", "    branches: [main]\n    types: [opened")
    assert len(check_pr.check_workflows(w)) == 1


def test_renaming_or_skipping_a_required_job_fails():
    w = _workflows()
    w[".github/workflows/tests.yml"] = w[".github/workflows/tests.yml"].replace("  bun:\n", "  bunx:\n")
    assert check_pr.check_workflows(w) == [
        ".github/workflows/tests.yml has no bun job; it's a required check, keep its name."]
    w = _workflows()
    w[".github/workflows/tests.yml"] = w[".github/workflows/tests.yml"].replace(
        "  pytest:\n    runs-on", "  pytest:\n    name: py\n    runs-on")
    assert "renamed" in check_pr.check_workflows(w)[0]
    w = _workflows()
    w[".github/workflows/pr.yml"] = w[".github/workflows/pr.yml"].replace(
        "  pr:\n    runs-on", "  pr:\n    if: false\n    runs-on")
    assert check_pr.check_workflows(w) == [
        ".github/workflows/pr.yml: job pr has `if`; a required check must always run and report."]


def test_another_workflow_cant_borrow_a_required_name():
    w = dict(_workflows(), **{".github/workflows/x.yml": "on: push\njobs:\n  fake:\n    name: pytest\n"
                                                           "    runs-on: ubuntu-latest\n"})
    assert check_pr.check_workflows(w) == [
        ".github/workflows/x.yml: job fake reports as 'pytest', the name of a required check "
        "from another workflow."]


def test_a_missing_required_workflow_fails():
    w = dict(_workflows(), **{".github/workflows/pr.yml": None})
    assert check_pr.check_workflows(w) == [".github/workflows/pr.yml is gone; it runs the "
                                           "required check(s) pr."]


# -- the description, live ---------------------------------------------------------------

class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_the_description_is_read_live_from_the_api():
    seen = {}

    def opener(req, timeout):
        seen["url"], seen["auth"] = req.full_url, req.get_header("Authorization")
        return _Resp(json.dumps({"body": "## What changed\n\nnow\n"}).encode())

    assert check_pr.fetch_body("o/r", 2, "t0k", opener=opener) == "## What changed\n\nnow\n"
    assert seen == {"url": "https://api.github.com/repos/o/r/pulls/2", "auth": "Bearer t0k"}
    assert check_pr.fetch_body("o/r", 2, "t", opener=lambda req, timeout: _Resp(b'{"body": null}')) == ""


# -- end to end, on a real git history ------------------------------------------------

def _git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout


def _write(repo, files):
    for path, text in files.items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_text(text)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    repo = tmp_path / "r"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    files = dict(_workflows())
    for app, v in (("harness", "0.19.13"), ("cain", "0.4.5")):
        files[f"{app}/config.yaml"] = cfg(v)
        files[f"{app}/CHANGELOG.md"] = log(v)
    files["cain/run.sh"] = "echo hi\n"
    _write(repo, files)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "checkout", "-q", "-b", "pr")
    monkeypatch.chdir(repo)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    return repo


def _commit(repo, files=None, moves=()):
    _write(repo, files or {})
    for a, b in moves:
        (repo / b).parent.mkdir(parents=True, exist_ok=True)
        _git(repo, "mv", a, b)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "change")


def test_end_to_end_on_git(repo, tmp_path, capsys):
    _commit(repo, {"cain/run.sh": "echo hello\n", "cain/config.yaml": cfg("0.4.6"),
                   "cain/CHANGELOG.md": log("0.4.6", "0.4.5")})
    body = tmp_path / "body.md"
    body.write_text(GOOD_BODY)
    assert check_pr.main(["--base", "main", "--head", "pr", "--body-file", str(body)]) == 0
    assert capsys.readouterr().out.startswith("ok:")
    body.write_text(GOOD_BODY.replace("## Not verified", "## Unverified"))
    assert check_pr.main(["--base", "main", "--head", "pr", "--body-file", str(body)]) == 1
    assert '"## Not verified"' in capsys.readouterr().out


def test_a_rename_into_tests_counts_on_git(repo, capsys):
    _commit(repo, moves=[("cain/run.sh", "cain/tests/run.sh")])
    assert check_pr.changed_files("main", "pr") == ["cain/run.sh", "cain/tests/run.sh"]
    assert check_pr.main(["--base", "main", "--head", "pr"]) == 1
    assert "cain changed, so its version goes one step up" in capsys.readouterr().out


def test_a_stale_branch_fails_until_updated(repo, capsys):
    _commit(repo, {"cain/run.sh": "echo hello\n", "cain/config.yaml": cfg("0.4.6"),
                   "cain/CHANGELOG.md": log("0.4.6", "0.4.5")})
    _git(repo, "checkout", "-q", "main")
    _commit(repo, {"harness/notes.md": "main moved\n"})
    _git(repo, "checkout", "-q", "pr")
    assert check_pr.main(["--base", "main", "--head", "pr"]) == 1
    assert capsys.readouterr().out.strip() == check_pr.STALE
    _git(repo, "merge", "-q", "--no-edit", "main")
    assert check_pr.main(["--base", "main", "--head", "pr"]) == 0


def test_main_with_a_duplicate_version_fails_closed_on_git(repo, capsys):
    _git(repo, "checkout", "-q", "main")
    _commit(repo, {"harness/config.yaml": cfg("0.19.13") + 'version: "9.9.9"\n'})
    _git(repo, "checkout", "-q", "pr")
    _git(repo, "merge", "-q", "--no-edit", "main")
    assert check_pr.main(["--base", "main", "--head", "pr"]) == 1
    assert "main's harness/config.yaml doesn't parse" in capsys.readouterr().out


def test_the_head_must_be_the_one_the_run_is_for(repo, capsys):
    head = _git(repo, "rev-parse", "pr").strip()
    assert check_pr.main(["--base", "main", "--head", "pr", "--expect-head", head]) == 0
    capsys.readouterr()
    assert check_pr.main(["--base", "main", "--head", "pr", "--expect-head", "0" * 40]) == 1
    assert "not 000000000000" in capsys.readouterr().out


def test_ci_reads_the_live_body_not_the_event(repo, monkeypatch, capsys):
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    calls = []

    def live(repo_name, number, token):
        calls.append((repo_name, number))
        return live.body

    monkeypatch.setattr(check_pr, "fetch_body", live)
    live.body = GOOD_BODY.replace("## Not verified", "## Unverified")
    assert check_pr.main(["--base", "main", "--head", "pr", "--pr", "2", "--repo", "o/r"]) == 1
    assert '"## Not verified"' in capsys.readouterr().out
    live.body = GOOD_BODY  # the description was fixed; a re-run sees it
    assert check_pr.main(["--base", "main", "--head", "pr", "--pr", "2", "--repo", "o/r"]) == 0
    assert calls == [("o/r", 2), ("o/r", 2)]


def test_ci_fails_closed_when_the_body_cant_be_read(repo, monkeypatch, capsys):
    monkeypatch.setenv("GITHUB_TOKEN", "t")

    def down(*a):
        raise OSError("no network")

    monkeypatch.setattr(check_pr, "fetch_body", down)
    assert check_pr.main(["--base", "main", "--head", "pr", "--pr", "2", "--repo", "o/r"]) == 1
    assert "Couldn't read the description" in capsys.readouterr().out
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    assert check_pr.main(["--base", "main", "--head", "pr"]) == 1
