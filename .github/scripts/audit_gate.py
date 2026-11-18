"""The audit job's gate (tests.yml, job `audit`): fails only on a high or critical
vulnerability that has a fix available, in pip-audit's JSON report.

pip-audit lists every known vulnerability with its fix versions but no severity, so each one
with a fix is looked up in OSV (api.osv.dev), its GitHub advisory alias first, for the
severity GitHub gave it. One with no fix, or below high, is printed and passes. One whose
severity can't be found (OSV doesn't answer, or no advisory rates it) is printed as unrated
and passes too: the job fails only on what it knows is high or critical with a fix.

  python audit_gate.py <pip-audit.json>
"""
import json
import sys
import urllib.request

FAILING = {"HIGH", "CRITICAL"}


def osv_severity(vuln_id, fetch=None):
    """GitHub's severity for one OSV id, upper case, or None."""
    fetch = fetch or _fetch
    try:
        rec = fetch(vuln_id)
    except Exception:  # noqa: BLE001 - no answer: unrated
        return None
    sev = (rec or {}).get("database_specific", {}).get("severity")
    return str(sev).upper() if sev else None


def _fetch(vuln_id):
    req = urllib.request.Request(f"https://api.osv.dev/v1/vulns/{vuln_id}", headers={"User-Agent": "audit-gate"})
    with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 - a fixed https host
        return json.load(r)


def judge(report, fetch=None):
    """(lines to print, whether the job fails) for a pip-audit JSON report."""
    lines, fail = [], False
    for dep in report.get("dependencies", []):
        for v in dep.get("vulns", []) or []:
            ids = [a for a in v.get("aliases", []) if str(a).startswith("GHSA-")] + [v.get("id")]
            fixes = v.get("fix_versions") or []
            sev = None
            if fixes:
                for i in ids:
                    sev = osv_severity(i, fetch) if i else None
                    if sev:
                        break
            where = f"{dep.get('name')} {dep.get('version')}: {v.get('id')}"
            if not fixes:
                lines.append(f"{where}, no fix yet (passes)")
            elif sev in FAILING:
                fail = True
                lines.append(f"{where}, {sev}, fixed in {', '.join(fixes)} (FAILS: update it)")
            else:
                lines.append(f"{where}, {sev or 'unrated'}, fixed in {', '.join(fixes)} (passes)")
    if not lines:
        lines.append("No known vulnerabilities.")
    return lines, fail


def main(argv):
    with open(argv[1], encoding="utf-8") as f:
        report = json.load(f)
    lines, fail = judge(report)
    for line in lines:
        print(line)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
