"""The security watch's repository checks: the audit gate (.github/scripts/audit_gate.py),
and the workflow and Dependabot files parse with the jobs the release rules name intact."""
import importlib.util
import pathlib

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("audit_gate", ROOT / ".github" / "scripts" / "audit_gate.py")
audit_gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit_gate)

SEVERITY = {"GHSA-high-1111-aaaa": "HIGH", "GHSA-crit-2222-bbbb": "CRITICAL", "GHSA-mod-3333-cccc": "MODERATE"}


def fake_osv(vuln_id):
    if vuln_id == "GHSA-down-0000-0000":
        raise OSError("no answer")
    sev = SEVERITY.get(vuln_id)
    return {"database_specific": {"severity": sev}} if sev else {}


def report(*vulns):
    return {"dependencies": [{"name": "pkg", "version": "1.0", "vulns": list(vulns)}]}


def vuln(alias, fixes):
    return {"id": "PYSEC-2026-1", "aliases": [alias, "CVE-2026-1"], "fix_versions": fixes}


def test_fails_on_high_or_critical_with_a_fix():
    for alias in ("GHSA-high-1111-aaaa", "GHSA-crit-2222-bbbb"):
        lines, fail = audit_gate.judge(report(vuln(alias, ["1.1"])), fake_osv)
        assert fail, lines
        assert "FAILS" in lines[0]


def test_passes_without_a_fix_below_high_or_unrated():
    for v in (vuln("GHSA-high-1111-aaaa", []), vuln("GHSA-mod-3333-cccc", ["1.1"]),
              vuln("GHSA-none-9999-dddd", ["1.1"]), vuln("GHSA-down-0000-0000", ["1.1"])):
        lines, fail = audit_gate.judge(report(v), fake_osv)
        assert not fail, lines
    assert audit_gate.judge({"dependencies": []}, fake_osv) == (["No known vulnerabilities."], False)


def test_one_failing_finding_fails_the_whole_report():
    lines, fail = audit_gate.judge(report(vuln("GHSA-mod-3333-cccc", ["1.1"]), vuln("GHSA-high-1111-aaaa", ["2.0"])), fake_osv)
    assert fail and len(lines) == 2


def test_workflows_and_dependabot_parse():
    tests = yaml.safe_load((ROOT / ".github/workflows/tests.yml").read_text())
    jobs = tests["jobs"]
    # The required checks and the Windows gate keep their names; the new jobs are there, unrequired.
    for name in ("pytest", "bun", "pcjobs-windows", "audit", "secrets"):
        assert name in jobs
    for name in ("audit", "secrets"):
        assert "if" not in jobs[name] and "continue-on-error" not in jobs[name]
    sec = jobs["secrets"]
    assert sec["env"]["GITLEAKS_VERSION"] and len(sec["env"]["GITLEAKS_SHA256"]) == 64
    assert any("sha256sum -c" in str(s.get("run", "")) for s in sec["steps"])
    assert any("--exit-code 1" in str(s.get("run", "")) for s in sec["steps"])
    audit = jobs["audit"]
    assert any("--require-hashes -r .github/ci/audit-requirements.txt" in str(s.get("run", "")) for s in audit["steps"])
    assert any("audit_gate.py pip-audit.json --unrated audit-unrated.txt" in str(s.get("run", "")) for s in audit["steps"])
    assert any("GITHUB_STEP_SUMMARY" in str(s.get("run", "")) for s in audit["steps"])
    assert any(str(s.get("uses", "")).startswith("actions/upload-artifact@") for s in audit["steps"])
    assert yaml.safe_load((ROOT / ".github/workflows/pr.yml").read_text())["jobs"]["pr"]

    dep = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text())
    assert dep["version"] == 2
    ecos = [(u["package-ecosystem"], u["directory"]) for u in dep["updates"]]
    assert sorted(ecos) == [("docker", "/cain"), ("docker", "/harness"), ("github-actions", "/"), ("pip", "/.github/ci")]
    for u in dep["updates"]:
        assert u["schedule"]["interval"] == "weekly"
        if u["package-ecosystem"] != "docker":
            assert set(u["groups"]["minor-and-patch"]["update-types"]) == {"minor", "patch"}
        assert (ROOT / u["directory"].lstrip("/")).is_dir()
    assert (ROOT / ".github/ci/requirements.txt").exists()
    for app in ("cain", "harness"):
        assert (ROOT / app / "Dockerfile").exists()


def test_the_new_jobs_read_only_and_the_scan_sees_its_whole_range():
    tests = yaml.safe_load((ROOT / ".github/workflows/tests.yml").read_text())
    on = tests.get("on", tests.get(True))
    assert "schedule" in on and "workflow_dispatch" in on and "push" in on      # main's whole history, weekly or by hand
    for name in ("audit", "secrets"):
        assert tests["jobs"][name]["permissions"] == {"contents": "read"}
    sec = tests["jobs"]["secrets"]
    checkout = next(s for s in sec["steps"] if str(s.get("uses", "")).startswith("actions/checkout@"))
    assert checkout["with"]["fetch-depth"] == 0
    scan = next(s for s in sec["steps"] if s.get("name") == "Scan")["run"]
    assert 'range="$BASE..$HEAD"' in scan and "refs/heads/main" in scan and "origin/main..HEAD" in scan
    assert not any("if" in s for s in sec["steps"])     # a required check: no step is skipped


def test_every_action_is_pinned_to_a_commit():
    import re
    for wf in (ROOT / ".github/workflows").glob("*.yml"):
        for line in wf.read_text().splitlines():
            m = re.search(r"uses:\s*(\S+)", line)
            if m:
                assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", m.group(1)), (wf.name, line)
                assert re.search(r"# v\d+\.\d+\.\d+$", line), (wf.name, line)


def test_the_audit_tools_are_pinned_with_hashes():
    text = (ROOT / ".github/ci/audit-requirements.txt").read_text()
    pins = [l for l in text.splitlines() if l and not l.startswith((" ", "#"))]
    assert any(p.startswith("pip-audit==2.10.1 ") for p in pins)
    assert len(pins) > 10 and all("==" in p and p.endswith("\\") for p in pins)
    body = "\n".join(l for l in text.splitlines() if not l.startswith("#"))
    blocks = body.split("==")[1:]
    assert all("--hash=sha256:" in b for b in blocks)


def test_unrated_findings_go_to_a_file(tmp_path):
    import json
    rep = tmp_path / "r.json"
    rep.write_text(json.dumps(report(vuln("GHSA-none-9999-dddd", ["1.1"]), vuln("GHSA-mod-3333-cccc", ["1.1"]))))
    lines, _ = audit_gate.judge(json.loads(rep.read_text()), fake_osv)
    assert audit_gate.unrated(lines) == [l for l in lines if "unrated" in l] and len(audit_gate.unrated(lines)) == 1
    out = tmp_path / "unrated.txt"
    orig = audit_gate.judge
    audit_gate.judge = lambda r, fetch=None: orig(r, fake_osv)
    try:
        assert audit_gate.main(["x", str(rep), "--unrated", str(out)]) == 0
    finally:
        audit_gate.judge = orig
    assert out.read_text().count("\n") == 1 and "unrated" in out.read_text()


def test_ci_requirements_are_pinned():
    lines = [l for l in (ROOT / ".github/ci/requirements.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert lines and all("==" in l for l in lines)
