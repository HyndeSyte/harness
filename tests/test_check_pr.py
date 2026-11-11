"""The pull request check (.github/scripts/check_pr.py): description and versions."""
import importlib.util
import pathlib
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


# -- end to end, on a real git history ------------------------------------------------

def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def test_end_to_end_on_git(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "r"
    (repo / "harness").mkdir(parents=True)
    (repo / "cain").mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    for app, v in (("harness", "0.19.13"), ("cain", "0.4.5")):
        (repo / app / "config.yaml").write_text(cfg(v))
        (repo / app / "CHANGELOG.md").write_text(log(v))
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "checkout", "-q", "-b", "pr")
    (repo / "cain" / "run.sh").write_text("echo hi\n")
    (repo / "cain" / "config.yaml").write_text(cfg("0.4.6"))
    (repo / "cain" / "CHANGELOG.md").write_text(log("0.4.6", "0.4.5"))
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "change")
    body = tmp_path / "body.md"
    body.write_text(GOOD_BODY)
    monkeypatch.chdir(repo)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    assert check_pr.main(["--base", "main", "--head", "pr", "--body-file", str(body)]) == 0
    assert capsys.readouterr().out.startswith("ok:")
    body.write_text(GOOD_BODY.replace("## Not verified", "## Unverified"))
    assert check_pr.main(["--base", "main", "--head", "pr", "--body-file", str(body)]) == 1
    assert '"## Not verified"' in capsys.readouterr().out
