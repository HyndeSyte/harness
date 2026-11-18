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
    assert any("pip-audit==" in str(s.get("run", "")) for s in audit["steps"])
    assert any("audit_gate.py" in str(s.get("run", "")) for s in audit["steps"])
    assert yaml.safe_load((ROOT / ".github/workflows/pr.yml").read_text())["jobs"]["pr"]

    dep = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text())
    assert dep["version"] == 2
    ecos = {u["package-ecosystem"]: u for u in dep["updates"]}
    assert set(ecos) == {"pip", "github-actions"}
    for u in ecos.values():
        assert u["schedule"]["interval"] == "weekly"
        assert set(u["groups"]["minor-and-patch"]["update-types"]) == {"minor", "patch"}
    assert (ROOT / ecos["pip"]["directory"].lstrip("/") / "requirements.txt").exists()


def test_ci_requirements_are_pinned():
    lines = [l for l in (ROOT / ".github/ci/requirements.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert lines and all("==" in l for l in lines)
