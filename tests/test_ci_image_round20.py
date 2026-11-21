"""0.24.0, twentieth round, item 5: the image job builds every layer in its own run (--no-cache, plain progress,
a CACHED layer fails it) and stamps the run's id as a label, checked before the build ids are compared, so it can't
pass on a stale or cached image. The required jobs stay as they were."""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = (ROOT / ".github" / "workflows" / "tests.yml").read_text()


def job(name: str) -> str:
    m = re.search(r"\n  " + name + r":\n(.*?)(?=\n  [a-z]+:\n|\Z)", WF, re.S)
    assert m, name
    return "".join(x + "\n" for x in m.group(1).split("\n") if not x.lstrip().startswith("#"))


def test_the_image_is_built_without_cache_and_every_layer_shows():
    image = job("image")
    build = re.search(r"docker build ([^\n]*)", image).group(1)
    assert "--no-cache" in build and "--progress=plain" in build
    assert "CACHED" in image and "exit 1" in image
    assert "pipefail" in image


def test_the_image_compared_must_carry_this_runs_stamp():
    image = job("image")
    assert '--label "harness.ci.run=$stamp"' in image
    assert image.count('stamp="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"') == 2
    check = image[image.index("The image's build id equals"):]
    assert check.index('test "$built" = "$stamp"') < check.index("/opt/harness/BUILD_ID")


def test_the_required_jobs_are_untouched():
    assert "- run: python -m pytest -q -p no:cacheprovider\n" in job("pytest")
    assert "- run: bun test cain/tests\n" in job("bun") and "--no-cache" not in job("pytest") + job("bun")
    assert "if:" not in job("pytest") + job("bun") and "continue-on-error" not in WF
