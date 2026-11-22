"""The add-on package keeps the boundary the design promised."""
import os
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "harness"


def flat_yaml(path: Path) -> dict:
    """Enough YAML for a flat config: key: value, and key: followed by - items."""
    out, key = {}, None
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("  - ") and key:
            out.setdefault(key, []).append(line[4:].strip())
            continue
        if line.startswith(" "):
            continue                        # folded description text
        k, _, v = line.partition(":")
        key = k.strip()
        v = v.strip()
        out[key] = v.strip('"') if v and v not in (">-", "|") else out.get(key, [])
    return out


def test_config_denies_every_api_and_mapping():
    cfg = flat_yaml(ADDON / "config.yaml")
    assert cfg["slug"] == "harness"
    assert cfg["homeassistant_api"] == "false"
    assert cfg["hassio_api"] == "false"
    assert cfg["auth_api"] == "false"
    for risky in ("map", "ports", "host_network", "privileged", "full_access", "docker_api",
                  "devices", "hassio_role", "image"):
        assert risky not in cfg, risky
    # One setting that isn't secret, and no key ever: Home Assistant can read and rewrite these.
    text = (ADDON / "config.yaml").read_text()
    assert text.split("options:\n")[1] == ('  family_copy_name: ""\n  family_to_gmail: ""\n  family_school: ""\n'
                                           '  family_school_address: ""\n  calendar_changes: false\n'
                                           '  mail_dates: false\n  meaning_shadow: false\n  meaning_live: false\n'
                                           '  home_location: ""\n  own_drive_days: 3\n  own_drive_dry_run: true\n  remove_all_blocks: false\n'
                                           '  his_calendar: ""\nschema:\n'
                                           "  family_copy_name: str?\n  family_to_gmail: str?\n  family_school: str?\n"
                                           "  family_school_address: str?\n  calendar_changes: bool?\n"
                                           "  mail_dates: bool?\n  meaning_shadow: bool?\n  meaning_live: bool?\n"
                                           "  home_location: str?\n  own_drive_days: int(1,60)?\n  own_drive_dry_run: bool?\n"
                                           "  remove_all_blocks: bool?\n  his_calendar: str?\n")
    assert cfg["ingress"] == "true" and cfg["ingress_port"] == "8099"
    assert cfg["panel_admin"] == "true"
    assert cfg["backup"] == "cold"                 # SQLite is copied with the add-on stopped
    assert cfg["init"] == "false"                  # s6-overlay base image is PID 1
    assert "aarch64" in cfg["arch"]


def test_versions_agree():
    cfg = flat_yaml(ADDON / "config.yaml")
    docker = (ADDON / "Dockerfile").read_text()
    changelog = (ADDON / "CHANGELOG.md").read_text()
    assert f'io.hass.version="{cfg["version"]}"' in docker
    assert f"## {cfg['version']}" in changelog


def test_dockerfile_pins_its_base_and_installs_nothing():
    docker = (ADDON / "Dockerfile").read_text()
    m = re.search(r"ARG BUILD_FROM=(\S+)", docker)
    assert m and re.fullmatch(r"ghcr\.io/home-assistant/base-python:3\.13-alpine3\.\d+-\d{4}\.\d{2}\.\d+",
                              m.group(1))
    for fetch in ("pip ", "apk add", "curl", "wget", "ADD http"):
        assert fetch not in docker, fetch


def test_only_the_standard_library_is_imported():
    import ast
    import sys
    stdlib = set(sys.stdlib_module_names)
    for py in (ADDON / "app" / "harness").glob("*.py"):
        for node in ast.walk(ast.parse(py.read_text())):
            if isinstance(node, ast.Import):
                mods = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:              # relative: inside the package
                    continue
                mods = [(node.module or "").split(".")[0]]
            else:
                continue
            for mod in mods:
                assert mod in stdlib or mod in ("harness", "__future__"), f"{py.name}: {mod}"


def test_service_runs_the_package_and_scrubs_nothing_by_shell():
    run = (ADDON / "rootfs/etc/services.d/harness/run").read_text()
    assert "exec python3 -m harness" in run
    assert "SUPERVISOR_TOKEN" not in run           # scrubbed inside the program instead
    main = (ADDON / "app/harness/__main__.py").read_text()
    assert '"SUPERVISOR_TOKEN"' in main


def test_repository_layout():
    repo = flat_yaml(ROOT / "repository.yaml")
    assert repo["name"] and (ADDON / "config.yaml").exists()
    # exactly two add-ons: the harness, and Cain (which holds no harness keys)
    addons = sorted(p.name for p in ROOT.iterdir() if p.is_dir() and (p / "config.yaml").exists())
    assert addons == ["cain", "harness"]


CAIN = ROOT / "cain"


def test_cain_config_denies_every_api_and_mapping():
    cfg = flat_yaml(CAIN / "config.yaml")
    assert cfg["slug"] == "cain"
    for api in ("homeassistant_api", "hassio_api", "auth_api"):
        assert cfg[api] == "false", api
    # Cain 0.14.0 asks for no Supervisor API and no mapping: the restore waits for its own release.
    for risky in ("map", "ports", "host_network", "privileged", "full_access", "docker_api",
                  "devices", "hassio_role", "image"):
        assert risky not in cfg, risky
    assert cfg["ingress"] == "true" and cfg["ingress_port"] == "8099" and cfg["panel_admin"] == "true"
    assert cfg["init"] == "false"
    # Keys (the record keeper's GitHub token, the review runner's three API keys) as
    # password fields, the review caps as bounded numbers, the panel's owner (a Home
    # Assistant user id, not a key), the alarms' webhook id, hidden like a key (C1
    # second review: the App's alarms reach Home Assistant without its API), the PC
    # job keeper's token and repo name, the security watch's and the probe's heartbeat URLs
    # (secrets like keys: password fields). Nothing else.
    text = (CAIN / "config.yaml").read_text()
    assert text.split("options:\n")[1] == (
        '  github_token: ""\n  gemini_api_key: ""\n  perplexity_api_key: ""\n  anthropic_api_key: ""\n'
        "  review_limit_usd: 1.5\n  gemini_monthly_usd: 8\n  perplexity_monthly_usd: 4\n"
        '  anthropic_monthly_usd: 30\n  codex_monthly_runs: 200\n  review_round_cap: 3\n  usage_reserve_percent: 25\n'
        '  owner_user_id: ""\n  notice_hook: ""\n'
        '  pc_jobs_token: ""\n  pc_jobs_repo: "HyndeSyte/pc-jobs"\n  heartbeat_url: ""\n  probe_heartbeat_url: ""\nschema:\n'
        "  github_token: password?\n  gemini_api_key: password?\n  perplexity_api_key: password?\n"
        "  anthropic_api_key: password?\n  review_limit_usd: float(0,20)\n  gemini_monthly_usd: float(0,200)\n"
        "  perplexity_monthly_usd: float(0,200)\n  anthropic_monthly_usd: float(0,200)\n"
        "  codex_monthly_runs: int(0,5000)\n  review_round_cap: int(1,10)\n  usage_reserve_percent: int(0,90)\n"
        "  owner_user_id: match(^([0-9a-f]{32})?$)?\n  notice_hook: password?\n"
        "  pc_jobs_token: password?\n  pc_jobs_repo: match(^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$)?\n"
        "  heartbeat_url: password?\n  probe_heartbeat_url: password?\n")


def test_cain_owner_user_id_takes_a_user_id_or_nothing():
    # Configuration checks owner_user_id when it's saved. Supervisor runs match() on any
    # value that's there, optional or not, so the pattern takes the default "" too.
    text = (CAIN / "config.yaml").read_text()
    pattern = re.search(r"^  owner_user_id: match\((.*)\)\?$", text, re.M).group(1)
    owner = "0123456789abcdef0123456789abcdef"
    for ok in ("", owner):
        assert re.match(pattern, ok), ok                      # voluptuous' Match is re.match
    for bad in (owner[1:], owner + "0", owner.upper(), owner[:31] + "g", owner + '";}', " " + owner):
        assert not re.match(pattern, bad), bad


def test_cain_writes_the_record_only_through_the_keeper(tmp_path):
    import json, shutil, subprocess
    s = json.loads((CAIN / "rootfs/opt/cain/settings.json").read_text())["permissions"]
    for tool in ("create_or_update_file", "push_files", "delete_file", "create_branch", "merge_pull_request"):
        assert f"mcp__claude_ai_GitHub__{tool}" in s["deny"]
    assert "Bash(/opt/cain/record.sh:*)" in s["allow"]
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "/opt/cain/record.sh submit" in rules and "only through the record keeper" in rules
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert 'bun "$OPT/record/main.ts"' in run and "bashio::config 'github_token'" in run
    printed = [l for l in run.splitlines() if "RECORD_TOKEN" in l and re.search(r"echo|printf|log\.", l)]
    assert not printed   # the token is never printed
    bash, jq = shutil.which("bash"), shutil.which("jq")
    if not bash or not jq:
        import pytest
        pytest.skip("no bash or jq")
    env = {"PATH": __import__("os").environ["PATH"], "RECORD_DIR": str(tmp_path / "rec"),
           "RECORD_QUEUE": str(tmp_path / "q"), "RECORD_OUTCOMES": str(tmp_path / "o")}
    (tmp_path / "rec").mkdir()
    sh = str(CAIN / "rootfs/opt/cain/record.sh")
    run_ = lambda *a: subprocess.run([bash, sh, *a], env=env, capture_output=True, text=True, timeout=20)
    assert run_("sha", "areas/x.md").stdout.strip() == "new"
    req = tmp_path / "r.json"
    req.write_text(json.dumps({"id": "cain-test-1", "from": "cain", "kind": "change", "summary": "s", "ops": []}))
    assert run_("submit", str(req)).stdout.strip() == "cain-test-1"
    assert len(list((tmp_path / "q").glob("*.json"))) == 1
    assert run_("status", "cain-test-1").stdout.strip() == "waiting"
    (tmp_path / "o").mkdir()
    (tmp_path / "o" / "cain-test-1.json").write_text(json.dumps({"state": "conflict", "reason": "changed"}))
    assert run_("status", "cain-test-1").stdout.strip() == "conflict: changed"
    req.write_text("{}")
    assert run_("submit", str(req)).returncode == 2


def test_cain_gets_a_rows_base_and_the_holds_from_record_sh(tmp_path):
    # A row edit's base is sha1 of the open row's line, the same as the keeper's rowHash.
    import hashlib, json, shutil, subprocess
    bash = shutil.which("bash")
    if not bash or not shutil.which("sha1sum"):
        import pytest
        pytest.skip("no bash or sha1sum")
    rec = tmp_path / "rec"
    (rec / "state").mkdir(parents=True)
    rows = ["| P11 | Watch | Build | Ship | | Alerts | Nov 7 |", "| P33 | Wave 1 | Build | Laptop holds it |  | Drills | Nov 10 |"]
    text = "# Pending\n\n## Open\n\n| ID | Item | Who | Next step | Waits for | Done when | Since |\n|---|---|---|---|---|---|---|\n"
    text += "\n".join(rows) + "\n\n## Done\n\n| Item | Date |\n|---|---|\n| P33 old: a done row that starts with the same id | Nov 1 |\n"
    (rec / "state" / "PENDING.md").write_bytes(text.replace("\n", "\r\n").encode())
    env = {"PATH": __import__("os").environ["PATH"], "RECORD_DIR": str(rec)}
    run_ = lambda *a: subprocess.run([bash, str(CAIN / "rootfs/opt/cain/record.sh"), *a], env=env, capture_output=True, text=True, timeout=20)
    for line in rows:
        assert run_("rowsha", line.split("|")[1].strip()).stdout.strip() == hashlib.sha1(line.encode()).hexdigest()
    assert run_("rowsha", "P99").returncode == 1
    assert run_("holds").stdout.strip() == "{}"   # nothing pushed yet: nobody holds anything
    # Notes on an item, oldest first, one table row each; only those after a time if given.
    (rec / "state" / "notes").mkdir()
    notes = ["| 2026-11-11T13:00:00.000Z | laptop:abc | Dane, other chat: rebase PR #3 after the fix |",
             "| 2026-11-11T14:00:00.000Z | cain | Dane in Discord: hold the ship until the drill |"]
    (rec / "state" / "notes" / "P33.md").write_bytes(("# Notes on P33\n\nWords about P33.\n\n| When | From | Note |\n|---|---|---|\n"
                                                      + "\n".join(notes) + "\n").replace("\n", "\r\n").encode())
    assert run_("notes", "P33").stdout.splitlines() == notes
    assert run_("notes", "p33").stdout.splitlines() == notes      # ids are one case
    assert run_("notes", "P33", "2026-11-11T13:00:00.000Z").stdout.splitlines() == notes[1:]
    assert run_("notes", "P33", "2026-11-11T08:30:00-05:00").stdout.splitlines() == notes[1:]   # any offset
    assert run_("notes", "P33", "2026-11-11T13:00Z").stdout.splitlines() == notes[1:]           # any ISO form
    assert run_("notes", "P33", "not a time").returncode == 2
    assert run_("notes", "P44").stdout == ""        # none filed
    assert run_("notes", "../P33").returncode == 2
    # No item: every item's notes but those someone other than Cain holds, each led by its item.
    if shutil.which("jq"):
        (rec / "state" / "notes" / "P44.md").write_text("| When | From | Note |\n|---|---|---|\n| 2026-11-11T15:00:00.000Z | cain | for the laptop |\n")
        (rec / "state" / "notes" / "P11.md").write_text("| When | From | Note |\n|---|---|---|\n| 2026-11-11T16:00:00.000Z | page | for Cain |\n")
        (rec / "state" / "holds.json").write_text(json.dumps({
            "P33": {"holder": "cain", "for": "x", "branches": [], "taken": "2026-11-11T12:00:00.000Z", "renewed": "2026-11-11T12:00:00.000Z"},
            "P44": {"holder": "laptop:abc", "for": "x", "branches": [], "taken": "2026-11-11T12:00:00.000Z", "renewed": "2026-11-11T12:00:00.000Z"}}))
        assert run_("notes").stdout.splitlines() == ["P11 | 2026-11-11T16:00:00.000Z | page | for Cain |"] + ["P33 " + n for n in notes]
        assert run_("notes", "-", "2026-11-11T13:30:00Z").stdout.splitlines() == ["P11 | 2026-11-11T16:00:00.000Z | page | for Cain |", "P33 " + notes[1]]


def test_cain_versions_agree_and_everything_is_pinned():
    cfg = flat_yaml(CAIN / "config.yaml")
    docker = (CAIN / "Dockerfile").read_text()
    assert f'io.hass.version="{cfg["version"]}"' in docker
    assert f"## {cfg['version']}" in (CAIN / "CHANGELOG.md").read_text()
    base = re.search(r"ARG BUILD_FROM=(\S+)", docker).group(1)
    assert re.fullmatch(r"ghcr\.io/home-assistant/base-debian:trixie-\d{4}\.\d{2}\.\d+", base)
    assert (CAIN / "build.yaml").read_text().count(base) == 2
    # Claude Code's own updater stays off (the image pins its version), so its fixes arrive with App
    # releases; the bun job's "Claude Code's pinned version" step warns when a newer one is out.
    assert re.search(r"ARG CLAUDE_VERSION=\d+\.\d+\.\d+$", docker, re.M)
    assert re.search(r"ARG BUN_VERSION=\d+\.\d+\.\d+$", docker, re.M)
    assert "sha256sum -c" in docker and "ENV DISABLE_AUTOUPDATER=1" in docker


def test_cain_terminal_is_reachable_only_through_ingress():
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    assert "allow 172.30.32.2;" in nginx and "deny all;" in nginx
    # Cain 0.15.0: a second server, for the Supervisor's watchdog only: /health, from the Supervisor
    # alone, and nothing else (every other path 404). Third round: the hassio network as a whole
    # (172.30.32.0/23), since the probe's address was never seen on the device; the panel stays the
    # Ingress proxy's alone. Its address is checked inside the location, since a return runs before
    # allow and deny, and each refused /health is noted with its address for the run script's log.
    assert nginx.count("listen ") == 2 and "listen 8099 " in nginx and "listen 8098;" in nginx
    panel = nginx.split("listen 8099 ")[1].split("  # The Supervisor's watchdog")[0]
    assert "172.30.32.0/23" not in panel
    health = nginx.split("listen 8098;")[1].split("  server {")[0]
    assert "geo $cain_health_from { default 0; 172.30.32.0/23 1; }" in nginx
    assert "map $status $cain_health_miss { 404 1; default 0; }" in nginx and "log_format cain_health_miss '$remote_addr';" in nginx
    assert "allow 172.30.32.0/23;" in health and "deny all;" in health and "location = /health {" in health
    loc = health.split("location = /health {")[1].split("location / {")[0]
    assert "access_log /run/cain-web/health-miss.log cain_health_miss if=$cain_health_miss;" in loc
    assert loc.index("if ($cain_health_from != 1) { return 404;") < loc.index("health-down")
    assert "location / { return 404; }" in health and "proxy_pass" not in health and "alias" not in health
    term = (CAIN / "rootfs/etc/services.d/terminal/run").read_text()
    # C1: ttyd listens on a unix socket only nginx's workers and root can open, never a port
    # Cain's own user could take while it's down; it attaches as the session's own user.
    assert "--interface /run/cain-web/upstream/ttyd.sock --socket-owner root:nogroup" in term
    assert "proxy_pass http://unix:/run/cain-web/upstream/ttyd.sock;" in nginx
    attach = (CAIN / "rootfs/opt/cain/terminal-attach.sh").read_text()
    assert "/opt/cain/as-cain bash -c" in attach and "attach-session -E -t cain" in attach


def test_cain_start_survives_bashio_errexit():
    # bashio runs with errexit: a command that fails on a clean start (no old
    # session to kill) must not end the script. 0.1.0 and 0.1.1 died here.
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert "kill-session -t cain 2>/dev/null || true" in run
    # And no status is read on the line after its command ("cmd; rc=$?"): errexit ends the
    # script at cmd first. C1's switch did that once, before it shipped.
    assert not re.search(r";\s*[A-Za-z_]+=\$\?", run)


def test_cain_start_decides_every_switch_outcome_under_errexit(tmp_path):
    """The start's switch decision (C1), run as bashio runs it (errexit, nounset, pipefail),
    with each answer the switch can give: it carries on to the right way of running instead
    of ending the start."""
    import shutil
    import subprocess
    if not shutil.which("bash"):
        import pytest
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    block = run[run.index('relay() {'):run.index('[ -z "$stopped_why" ] || bashio::log.error')]
    data = tmp_path / "data"
    opt = tmp_path / "opt"
    (data / "link").mkdir(parents=True)
    (data / "link/specialist-signs").write_text("1")
    (opt / "c1").mkdir(parents=True)
    stub = {
        "c1/state.sh": 'cat "$STUB_DIR/state" 2>/dev/null || echo fresh',
        "c1/cutover.sh": 'echo cutover >> "$STUB_DIR/calls"; [ "$STUB_RC" = 1 ] && echo x >> "$STUB_DATA/c1/failed"; exit "$STUB_RC"',
        "c1/lock.sh": 'echo "lock $1" >> "$STUB_DIR/calls"; exit 0',
        # The App's alarms to his phone shown to work, or not (STUB_UNPROVEN): Cain's fourth service
        # review, must-fix 6.
        "notice.sh": 'case "$1" in proven) [ -z "${STUB_UNPROVEN:-}" ] ;; *) exit 0 ;; esac',
    }
    for name, body in stub.items():
        f = opt / name
        f.write_text("#!/bin/bash\n" + body + "\n")
        f.chmod(0o755)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "bun").write_text('#!/bin/bash\ncase "$2" in container-id) echo "boot:1";; may-retry) exit 1;;'
                                ' write-state) printf %s "$4" > "$3";; *) exit 0;; esac\n')
    (bindir / "bun").chmod(0o755)
    (bindir / "jq").write_text("#!/bin/bash\ncat >/dev/null; echo '{}'\n")
    (bindir / "jq").chmod(0o755)
    body = (block.replace("/data/", f"{data.as_posix()}/")
                 .replace("install -d -m 0700 -o root -g root", "mkdir -p"))
    script = ("set -o errexit -o nounset -o pipefail\n"
              "bashio::log.info() { :; }; bashio::log.warning() { :; }; bashio::log.error() { :; }\n"
              f'OPT="{opt.as_posix()}"\n' + body + '\necho "mode=$mode restart=$restart_first stopped=$switch_stopped kind=$stop_kind"\n')
    (tmp_path / "start.sh").write_text(script)
    want = {"0": "mode=own restart= stopped= kind=", "1": "mode=old restart= stopped= kind=",
            "2": "mode=none restart= stopped=1 kind=switch-stopped",
            "3": "mode=old restart= stopped= kind=", "4": "mode=none restart=1 stopped= kind=switch-restart"}
    for rc, expect in want.items():
        (data / "c1").mkdir(exist_ok=True)
        for f in ("failed", "uid1000-ran", "legacy-ran"):
            (data / "c1" / f).unlink(missing_ok=True)
        env = {**os.environ, "STUB_RC": rc, "STUB_DIR": tmp_path.as_posix(), "STUB_DATA": data.as_posix(),
               "PATH": f"{bindir.as_posix()}:{os.environ.get('PATH', '')}"}
        out = subprocess.run(["bash", (tmp_path / "start.sh").as_posix()], capture_output=True, text=True, env=env)
        assert out.returncode == 0, (rc, out.stderr[-500:])
        assert out.stdout.strip().startswith(expect), (rc, out.stdout, out.stderr[-300:])
    # His alarms to Dane's phone not shown to work yet: no new switch begins (the old way runs); one
    # begun (switching) is finished all the same.
    for state, expect, began in (("fresh", "mode=old restart= stopped= kind=", False), ("switching", "mode=own", True)):
        (tmp_path / "state").write_text(state)
        (tmp_path / "calls").unlink(missing_ok=True)
        env = {**os.environ, "STUB_RC": "0", "STUB_DIR": tmp_path.as_posix(), "STUB_DATA": data.as_posix(),
               "STUB_UNPROVEN": "1", "PATH": f"{bindir.as_posix()}:{os.environ.get('PATH', '')}"}
        out = subprocess.run(["bash", (tmp_path / "start.sh").as_posix()], capture_output=True, text=True, env=env)
        assert out.returncode == 0 and out.stdout.strip().startswith(expect), (state, out.stdout, out.stderr[-300:])
        calls = (tmp_path / "calls").read_text() if (tmp_path / "calls").exists() else ""
        assert ("cutover" in calls) == began, (state, calls)
    (tmp_path / "state").unlink()


def test_a_breach_found_by_the_check_keeps_cain_stopped_on_that_version_only(tmp_path):
    """C1 review service, theme 8: a failed check of his own user is a stop, not a line. The
    start keeps him stopped while the App is the version it failed on (or its version can't be
    read), and a new version clears it and gets its own check."""
    import shutil
    import subprocess
    if not shutil.which("bash"):
        import pytest
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    block = run[run.index('relay() {'):run.index('[ -z "$stopped_why" ] || bashio::log.error')]
    data = tmp_path / "data"
    opt = tmp_path / "opt"
    (data / "c1").mkdir(parents=True)
    (opt / "c1").mkdir(parents=True)
    for name, body in {"c1/state.sh": "echo cut", "c1/lock.sh": "exit 0"}.items():
        (opt / name).write_text("#!/bin/bash\n" + body + "\n")
        (opt / name).chmod(0o755)
    body = block.replace("/data/", f"{data.as_posix()}/")
    script = ("set -o errexit -o nounset -o pipefail\n"
              "bashio::log.info() { :; }; bashio::log.warning() { :; }; bashio::log.error() { :; }\n"
              'bashio::addon.version() { [ -n "$STUB_VERSION" ] && echo "$STUB_VERSION"; }\n'
              f'OPT="{opt.as_posix()}"\n' + body + '\necho "mode=$mode check=$check_stopped why=$stopped_why"\n')
    (tmp_path / "start.sh").write_text(script)
    mark = data / "c1/check-failed"

    def start(version):
        env = {**os.environ, "STUB_VERSION": version}
        out = subprocess.run(["bash", (tmp_path / "start.sh").as_posix()], capture_output=True, text=True, env=env)
        assert out.returncode == 0, out.stderr[-400:]
        return out.stdout.strip()

    assert start("0.12.0").startswith("mode=own check= ")
    mark.write_text("0.12.0 can't read /data/link/discord.env\n")
    out = start("0.12.0")
    assert out.startswith("mode=none check=1 ") and "can't read /data/link/discord.env" in out
    assert start("").startswith("mode=none check=1 ")                    # the version can't be read
    assert start("0.12.1").startswith("mode=own check= ") and not mark.exists()


def test_the_check_stops_cain_on_a_breach_and_holds_him_when_it_cant_finish(tmp_path):
    """c1/check.sh: a breach writes the stop for this version, ends his session and tells Dane at
    once (exit 3). A check that couldn't be tried, or gave no answer: with C1_UNTRIED=retry, exit 5
    and nothing written or ended (the start tries again); otherwise it holds his session (C1
    second review, must-fix 1): the hold for this version, his session ended, Dane told it's a
    pause (exit 4). Run on its own, it tries C1_CHECK_TRIES times first. Held, no session to end. A
    stop or hold that can't be kept in /data is kept in /run/cain; if neither can be written, the
    exit status still says it."""
    import json
    import shutil
    import subprocess
    if not shutil.which("bash") or not shutil.which("jq"):
        pytest.skip("no bash or jq")
    opt = tmp_path / "opt"
    (opt / "c1").mkdir(parents=True)
    shutil.copy(CAIN / "rootfs/opt/cain/c1/check.sh", opt / "c1/check.sh")
    (opt / "as-cain").write_text('#!/bin/bash\nif [ "$1" = tmux ]; then echo killed >> "$STUB/calls"; exit 0; fi\n'
                                 'n=$(cat "$STUB/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB/n"\n'
                                 'sed -n "$((n + 1))p" "$STUB/answers"\nexit "${STUB_RC:-0}"\n')
    (opt / "notice.sh").write_text('#!/bin/bash\necho "notice $*" >> "$STUB/calls"\n')
    for f in ("as-cain", "notice.sh"):
        (opt / f).chmod(0o755)

    def check(*answers, held=False, marks=None, runmarks=None, **more):
        stub = tmp_path / f"s{len(list(tmp_path.iterdir()))}"
        (stub / "run").mkdir(parents=True)
        (stub / "answers").write_text("\n".join(answers) + "\n")
        marks = marks or stub
        runmarks = runmarks or stub / "run"
        env = {**os.environ, "STUB": stub.as_posix(), "C1_OPT": opt.as_posix(), "C1_CHECK_OUT": (stub / "out.json").as_posix(),
               "C1_CHECK_FAILED": (marks / "failed").as_posix(), "C1_CHECK_HELD": (marks / "held").as_posix(),
               "C1_RUN_MARKS": runmarks.as_posix(), "C1_VERSION": "0.12.0", "C1_CHECK_RETRY_S": "0", **more}
        if held:                                   # the start's tries while he's held
            (stub / "held").write_text("0.12.0 his key on /card: the link didn't answer\n")
            env.update(C1_HELD="1")
        out = subprocess.run(["bash", (opt / "c1/check.sh").as_posix()], capture_output=True, text=True, env=env)
        read = lambda f: f.read_text() if f.exists() else ""
        line = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
        return out.returncode, line, read(marks / "failed"), read(marks / "held"), read(stub / "calls"), int(read(stub / "n") or 0)

    good = json.dumps({"ok": True, "failed": [], "unchecked": [], "checks": 45})
    later = json.dumps({"ok": True, "failed": [], "unchecked": ["his key on /card: the link didn't answer"], "checks": 29})
    breach = json.dumps({"ok": False, "failed": ["can't read /data/link/discord.env"], "unchecked": [], "checks": 30})
    assert check(good) == (0, "[c1] check: all 45 held", "", "", "", 1)
    # An answer that says all held with fewer checks than it makes is no pass (C1 third outside round).
    vacuous = json.dumps({"ok": True, "failed": [], "unchecked": [], "checks": 0})
    rc, line, failed, held, calls, n = check(vacuous, C1_UNTRIED="retry")
    assert (rc, failed, held, calls) == (5, "", "", "") and "the check ran only 0 of its 45 checks" in line
    # A check it names as failed is a breach whatever "ok" says; "not ok" naming none is no answer.
    rc, line, failed, held, calls, n = check(json.dumps({"ok": True, "failed": ["uid1000 read a root secret"], "unchecked": [], "checks": 45}))
    assert (rc, failed, calls) == (3, "0.12.0 uid1000 read a root secret\n", "killed\nnotice tell breach\n")
    rc, line, failed, held, calls, n = check(json.dumps({"ok": False, "failed": [], "unchecked": [], "checks": 45}), C1_UNTRIED="retry")
    assert (rc, failed, held) == (5, "", "") and "said not all held but named no check" in line
    # A check that answered and then failed, or ran out of time, didn't pass; a breach it reported stands.
    rc, line, failed, held, calls, n = check(good, C1_UNTRIED="retry", STUB_RC="37")
    assert (rc, failed, held, calls) == (5, "", "", "") and "the check ended with 37 after its answer" in line
    rc, line, failed, held, calls, n = check(good, STUB_RC="124")
    assert (rc, held) == (4, "0.12.0 the check ended with 124 after its answer\n")
    rc, line, failed, held, calls, n = check(breach, STUB_RC="37")
    assert (rc, failed) == (3, "0.12.0 can't read /data/link/discord.env\n")
    rc, line, failed, held, calls, n = check(json.dumps({"ok": True, "failed": [], "unchecked": [], "checks": 44}))
    assert (rc, held, calls) == (4, "0.12.0 the check ran only 44 of its 45 checks\n", "killed\nnotice tell held\n")
    rc, line, failed, held, calls, n = check(breach)
    assert (rc, failed, held, calls, n) == (3, "0.12.0 can't read /data/link/discord.env\n", "", "killed\nnotice tell breach\n", 1)
    assert "FAILED" in line
    # One try, as the start runs it: not yet, to be tried again, nothing written or ended.
    rc, line, failed, held, calls, n = check(later, C1_UNTRIED="retry")
    assert (rc, failed, held, calls, n) == (5, "", "", "", 1) and "not tried yet" in line
    # Its last try: held, his session ended, Dane told it's a pause.
    rc, line, failed, held, calls, n = check("not json")
    assert (rc, failed, held, calls, n) == (4, "", "0.12.0 the check gave no answer\n", "killed\nnotice tell held\n", 1)
    assert "held (not a breach)" in line
    # On its own, five tries a minute apart before deciding.
    assert check(later, later, good, C1_CHECK_TRIES="5") == (0, "[c1] check: all 45 held", "", "", "", 3)
    rc, line, failed, held, calls, n = check(*[later] * 5, C1_CHECK_TRIES="5")
    assert (rc, held, calls, n) == (4, "0.12.0 his key on /card: the link didn't answer\n", "killed\nnotice tell held\n", 5)
    # Held: no session to end.
    assert check(good, held=True) == (0, "[c1] check: all 45 held", "", "", "", 1)
    rc, line, failed, held, calls, n = check(later, held=True)
    assert (rc, failed, calls, n) == (4, "", "notice tell held\n", 1) and held.startswith("0.12.0 his key on /card")
    rc, line, failed, held, calls, n = check(breach, held=True)
    assert (rc, failed, held, calls, n) == (3, "0.12.0 can't read /data/link/discord.env\n", "", "notice tell breach\n", 1)
    # /data can't be written: the stop and the hold are kept in /run/cain for this container.
    gone = tmp_path / "no-such-dir"
    for answers, name, want in (([breach], "failed", 3), (["not json"], "held", 4)):
        rc, line, failed, held, calls, n = check(*answers, marks=gone)
        run = tmp_path / f"s{len(list(tmp_path.iterdir())) - 1}" / "run"
        assert rc == want and (run / name).read_text().startswith("0.12.0 ") and "killed\n" in calls, (name, rc)
    # Neither can be written: still the exit status (the start acts on it), and it says so.
    for answers, want in (([breach], 3), (["not json"], 4)):
        stub_run = tmp_path / "no-run-dir"
        rc, line, failed, held, calls, n = check(*answers, marks=gone, runmarks=stub_run)
        assert rc == want and "killed\n" in calls, (answers, rc)


def _start_block(tmp_path, stubs, extra_echo):
    """The start's decision (services.d/cain/run, from relay() up to its log line), run as bashio
    runs it (errexit, nounset, pipefail) on a fake /data, with stub scripts under a fake /opt/cain."""
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    block = run[run.index('relay() {'):run.index('[ -z "$stopped_why" ] || bashio::log.error')]
    data, opt = tmp_path / "data", tmp_path / "opt"
    (data / "c1").mkdir(parents=True, exist_ok=True)
    (data / "link").mkdir(exist_ok=True)
    (opt / "c1").mkdir(parents=True, exist_ok=True)
    for name, body in stubs.items():
        (opt / name).write_text("#!/bin/bash\n" + body + "\n")
        (opt / name).chmod(0o755)
    body = (block.replace("/data/", f"{data.as_posix()}/")
                 .replace("install -d -m 0700 -o root -g root", "mkdir -p"))
    script = ("set -o errexit -o nounset -o pipefail\n"
              "bashio::log.info() { :; }; bashio::log.warning() { :; }; bashio::log.error() { :; }\n"
              'bashio::addon.version() { [ -n "${STUB_VERSION:-}" ] && echo "$STUB_VERSION"; }\n'
              f'OPT="{opt.as_posix()}"\n' + body + "\n" + extra_echo + "\n")
    (tmp_path / "start.sh").write_text(script)
    return data, opt


def _run_start(tmp_path, **env):
    import subprocess
    out = subprocess.run(["bash", (tmp_path / "start.sh").as_posix()], capture_output=True, text=True,
                         env={**os.environ, **env})
    assert out.returncode == 0, out.stderr[-500:]
    return out.stdout.strip()


def test_a_held_start_runs_everything_but_his_session(tmp_path):
    """A hold of his session (c1/check.sh couldn't finish) is for the version it happened on: the
    start runs the new way's services but not his session or check-ins, and tries the check again
    until it finishes (hold). A breach on record wins over a hold; a new version starts afresh."""
    import shutil
    if not shutil.which("bash"):
        pytest.skip("no bash")
    data, _ = _start_block(tmp_path, {"c1/state.sh": "echo cut", "c1/lock.sh": '[ -z "${STUB_LOCK_FAIL:-}" ]'},
                           'echo "mode=$mode held=$held kind=$stop_kind"')
    mark = data / "c1/check-held"
    assert _run_start(tmp_path, STUB_VERSION="0.12.0") == "mode=own held= kind="
    mark.write_text("0.12.0 his key on /card: the link didn't answer\n")
    assert _run_start(tmp_path, STUB_VERSION="0.12.0") == "mode=own held=1 kind="
    assert _run_start(tmp_path, STUB_VERSION="") == "mode=own held=1 kind="            # the version can't be read
    assert _run_start(tmp_path, STUB_VERSION="0.12.0", STUB_LOCK_FAIL="1") == "mode=none held= kind=setup"
    (data / "c1/check-failed").write_text("0.12.0 can't read /data/link/discord.env\n")
    assert _run_start(tmp_path, STUB_VERSION="0.12.0") == "mode=none held= kind=breach"
    (data / "c1/check-failed").unlink()
    assert _run_start(tmp_path, STUB_VERSION="0.12.1") == "mode=own held= kind=" and not mark.exists()
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert 'if [ "$mode" != none ] && [ -z "$held" ]; then start_his_session || true; fi' in run
    assert 'if [ "$mode" != none ] && [ -z "$held" ] && session_up; then with_session; fi' in run
    assert 'if [ "$mode" != none ] && [ -z "$held" ]; then checkins; fi' in run
    assert 'if [ -n "$held" ]; then hold; fi' in run


def _run_fns(run, first, last):
    """The run script's text from the line starting `first` up to the one starting `last`."""
    a = run.index(first)
    return run[a:run.index(last, a)]


def test_the_held_start_tries_the_check_until_it_finishes(tmp_path):
    """hold (services.d/cain/run): no session of his runs while held; Dane hears it's a pause; the
    check is tried once at a time, without his session, until it finishes, and then the loop starts
    his session (Cain hears he was held, for the laptop session). Its exit status decides: a breach
    turns the hold into a stop here, with no restart needed to tell him."""
    import shutil
    import subprocess
    if not shutil.which("bash"):
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    fns = _run_fns(run, "# A stop or a hold the check of his own user recorded at an earlier start", "# The check of his own user, for the session")
    data, runc, opt = tmp_path / "data", tmp_path / "runcain", tmp_path / "opt"
    for d in (data / "c1", runc, opt / "c1"):
        d.mkdir(parents=True)
    (opt / "notice.sh").write_text('#!/bin/bash\necho "notice $*" >> "$CALLS"\n')
    (opt / "c1/check.sh").write_text('#!/bin/bash\necho "check held=$C1_HELD tries=$C1_CHECK_TRIES version=$C1_VERSION" >> "$CALLS"\n'
                                     'n=$(cat "$CALLS.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$CALLS.n"\n'
                                     'rc=$(sed -n "$((n + 1))p" "$CODES")\n'
                                     'case "$rc" in 0) rm -f "$HELD";; 3) rm -f "$HELD"; echo "0.12.0 cant read x" > "$FAILED_AT";; esac\n'
                                     'echo "[c1] the check said $rc"; exit "$rc"\n')
    for f in ("notice.sh", "c1/check.sh"):
        (opt / f).chmod(0o755)
    script = ("set -o errexit -o nounset -o pipefail\n"
              "bashio::log.info() { :; }; bashio::log.warning() { :; }; bashio::log.error() { :; }\n"
              'relay() { echo "relay $1" >> "$CALLS"; }; has_session() { [ -f "$CALLS.session" ]; }\n'
              'end_his_session() { echo ended >> "$CALLS"; rm -f "$CALLS.session"; }\n'
              f'OPT="{opt.as_posix()}"; SOCK_TMUX=/x; version=0.12.0; held=1; mode=own; check_stopped=""; stop_kind=""; stop_cause=""; stopped_why=""\n'
              + fns.replace("/data/", f"{data.as_posix()}/").replace("/run/cain/", f"{runc.as_posix()}/")
              + 'hold\necho "mode=$mode held=$held kind=$stop_kind why=$stopped_why"\n')
    (tmp_path / "hold.sh").write_text(script)

    def hold(*codes, failed_at=None, session=False):
        calls = tmp_path / f"calls{len(list(tmp_path.glob('calls*')))}"
        (data / "c1/check-held").write_text("0.12.0 his key on /card: the link didn't answer\n")
        if session:
            (tmp_path / f"{calls.name}.session").write_text("up")
        (tmp_path / "codes").write_text("\n".join(map(str, codes)) + "\n")
        env = {**os.environ, "CALLS": calls.as_posix(), "CODES": (tmp_path / "codes").as_posix(),
               "HELD": (data / "c1/check-held").as_posix(), "FAILED_AT": (failed_at or data / "c1/check-failed").as_posix(),
               "C1_HELD_FIRST_S": "0", "C1_HELD_EVERY_S": "0"}
        out = subprocess.run(["bash", (tmp_path / "hold.sh").as_posix()], capture_output=True, text=True, env=env, timeout=30)
        assert out.returncode == 0, out.stderr[-500:]
        return out.stdout.strip().splitlines(), calls.read_text().splitlines()

    tried = "check held=1 tries=1 version=0.12.0"
    out, all_calls = hold(4, 4, 0)
    # No session of his while he's held: ended and shown ended first, and again before each try.
    assert all_calls[:2] == ["ended", "notice tell held"]
    assert all(all_calls[i - 1] == "ended" for i, c in enumerate(all_calls) if c == tried)
    calls = [c for c in all_calls if c != "ended"]
    assert calls[:6] == ["notice tell held", tried, "notice tell held", tried, "notice tell held", tried]
    assert calls[6].startswith("relay Your session was held because the check of your own user couldn't finish "
                               "(his key on /card: the link didn't answer)") and "P33" in calls[6] and len(calls) == 7
    assert out[-1].startswith("mode=own held= kind= ")
    out, calls = hold(4, 3)
    assert [c for c in calls if c != "ended"] == ["notice tell held", tried, "notice tell held", tried]
    assert out[-1] == "mode=none held= kind=breach why=a check of his own user found a breach: cant read x"
    (data / "c1/check-failed").unlink()
    out, calls = hold(3, failed_at=runc / "check-failed")             # kept only in /run/cain
    assert out[-1] == "mode=none held= kind=breach why=a check of his own user found a breach: cant read x"


def test_his_session_is_ended_even_when_tmux_wont_end_it(tmp_path):
    """end_his_session (services.d/cain/run). His own user's session: tmux first, then every
    process of his user, until /proc shows none of his (three tries); tmux's answers prove nothing
    either way. The old way's root session: ended only when tmux answers there's no such session;
    a timeout or any other answer is no proof, so it answers 1 (C1 third outside round)."""
    import shutil
    import subprocess
    if not shutil.which("bash"):
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    fns = _run_fns(run, "his_procs() {", "# When his session can't be shown ended")
    procs, bindir = tmp_path / "proc", tmp_path / "bin"
    bindir.mkdir()
    (bindir / "fake-tmux").write_text('#!/bin/bash\necho "tmux $*" >> "$CALLS"\ncase "$*" in *kill-session*) exit 1;; '
                                      '*has-session*) exit "$HAS";; esac\n')
    (bindir / "tmux").write_text('#!/bin/bash\necho "tmux $*" >> "$CALLS"\ncase "$*" in *has-session*) exit "$HAS";; esac; exit 1\n')
    (bindir / "setpriv").write_text('#!/bin/bash\necho "setpriv $*" >> "$CALLS"\n[ -n "$STUCK" ] || rm -rf "$PROCS"/*\n')
    for f in ("fake-tmux", "tmux", "setpriv"):
        (bindir / f).chmod(0o755)

    def end(tmux, has, procs_of_his=True, stuck="", unreadable=""):
        calls = tmp_path / f"calls-{len(list(tmp_path.glob('calls-*')))}"
        shutil.rmtree(procs, ignore_errors=True)
        procs.mkdir()
        if unreadable:
            (procs / unreadable).mkdir()                                  # there, with no status to read
        if procs_of_his:
            (procs / "4242").mkdir()
            (procs / "4242/status").write_text("Name:\tclaude\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\n")
        (procs / "1").mkdir()
        (procs / "1/status").write_text("Name:\tinit\nState:\tS (sleeping)\nUid:\t0\t0\t0\t0\n")
        script = ("set -o errexit -o nounset -o pipefail\n"
                  "bashio::log.warning() { :; }; bashio::log.error() { :; }\n"
                  f'TMUX_CMD="{tmux}"; mode=own\n' + fns + 'if end_his_session; then echo ended; else echo runs; fi\n')
        (tmp_path / "end.sh").write_text(script)
        env = {**os.environ, "CALLS": calls.as_posix(), "HAS": str(has), "STUCK": stuck, "PROCS": procs.as_posix(),
               "C1_PROC_ROOT": procs.as_posix(), "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}"}
        out = subprocess.run(["bash", (tmp_path / "end.sh").as_posix()], capture_output=True, text=True, env=env, timeout=60)
        assert out.returncode == 0, out.stderr[-400:]
        return out.stdout.strip(), (calls.read_text().splitlines() if calls.exists() else [])

    own = (bindir / "fake-tmux").as_posix()
    # His own user: tmux won't end it and even says it's gone (or times out); /proc decides.
    for has in (1, 124, 0):
        said, calls = end(own, has)
        assert said == "ended" and calls[0].endswith("kill-session -t cain"), has
        assert any(c.startswith("setpriv --reuid=1000 --regid=1000 --clear-groups bash -c kill -9 -1") for c in calls), has
    said, calls = end(own, 1, stuck="1")
    assert said == "runs" and sum(c.startswith("setpriv") for c in calls) == 3
    said, calls = end(own, 124, procs_of_his=False)
    assert said == "ended" and not any(c.startswith("setpriv") for c in calls)
    # A process whose status can't be read while it's there is no proof it isn't his: it's ended too.
    said, calls = end(own, 1, procs_of_his=False, unreadable="777")
    assert said == "ended" and any(c.startswith("setpriv") for c in calls)
    said, calls = end(own, 1, procs_of_his=False, unreadable="777", stuck="1")
    assert said == "runs"
    # The old way's root session: only tmux's "no such session" is proof.
    assert end("tmux", 1, procs_of_his=False)[0] == "ended"
    assert end("tmux", 124, procs_of_his=False)[0] == "runs"
    assert end("tmux", 0, procs_of_his=False)[0] == "runs"
    # A session that can't be shown ended stops the App: the one exit of the start, told by its trap.
    fail = _run_fns(run, "fail_closed() {", "\n")
    assert fail.strip().endswith("exit 1; }") and "no_session() { end_his_session || fail_closed; }" in run


def test_no_stop_is_silent(tmp_path):
    """C1 second review, must-fix 2, made general: every way the start decides he isn't started
    names the alarm Dane gets (notice.sh), told at once, before any later step can end the start;
    the stop raises it again at every turn of its wait. The start never ends itself (his session
    is started again instead), and should it end anyway, the exit is told too
    (test_an_end_of_the_start_is_told_but_not_a_stop_by_signal)."""
    import shutil
    import subprocess
    if not shutil.which("bash"):
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    code = [l for l in run.splitlines() if not l.lstrip().startswith("#")]
    sets = [l for l in code if re.search(r"(^|[\s;)])mode=none\b", l)]
    assert len(sets) >= 9
    for line in sets:
        assert re.search(r"\bstop_kind=[a-z-]+", line), line
    kinds = set(re.findall(r"\bstop_kind=([a-z-]+)", run))
    assert kinds == {"setup", "breach", "switch-stopped", "switch-blocked", "switch-restart", "restart", "damaged"}
    told = set(re.findall(r'notice\.sh" tell ([a-z-]+)', run)) | set(re.findall(r"\bkind=(switch-[a-z]+)", run))
    # Cain 0.15.0: the channel watchdog names the plugin's server apart from his channel going down.
    assert told == {"exited", "switch-failed", "switch-waits", "held", "session", "breach", "channel", "server-gone"}
    for kind in kinds | told:
        out = subprocess.run(["bash", (CAIN / "rootfs/opt/cain/notice.sh").as_posix(), "text", kind], capture_output=True, text=True)
        assert out.returncode == 0 and out.stdout.count("\n") == 2, kind
    assert 'if [ "$mode" = none ]; then "$OPT/notice.sh" tell "${stop_kind:-setup}" "$stop_cause" || true; fi' in run
    decided = run.index('[ -z "$stopped_why" ] || bashio::log.error')
    assert run.index('"$OPT/notice.sh" tell "${stop_kind:-setup}"', decided) < run.index("/run/cain/mode.tmp", decided)
    fn = _run_fns(run, "stopped() {", "# His session held")
    assert fn.count('"$OPT/notice.sh" tell "${stop_kind:-setup}" "$stop_cause" || true') == 3 and fn.count("no_session") == 3
    assert 'if [ "$mode" = none ]; then stopped; fi' in run
    exits = [l for l in code if re.search(r"\bexit \d", l)]
    # And (Cain 0.15.0) the App restarting itself: exit 3, only from self_restart, after the probe said
    # "restart" (the switch on, marks kept) and his session was ended; told, so the EXIT trap stays quiet.
    # Second round: exit 3 lives in self_exit (the exit route), reached from self_restart's restart
    # decision after the Supervisor's restart call, and from the Pi drill's root-only mark.
    assert exits == ['fail_closed() { bashio::log.error "Cain couldn\'t be shown stopped, so the App stops itself"; exit 1; }', "  exit 3"]
    exit_fn = _run_fns(run, "self_exit() {", "self_tried=0")
    # Fourth round: the mark holds the time it was written (self_mark). Fifth round: the exit route writes
    # it with the word fallback, which finish and the EXIT trap need before they take a 3 for the fallback.
    assert exit_fn.index("""printf '%s fallback\\n' "$(date +%s)" > /run/cain/self-restart""") < exit_fn.index("health_down") < exit_fn.index("exit 3")
    assert "self_mark() { { date +%s > /run/cain/self-restart; } 2>/dev/null || true; }" in run
    self_fn = _run_fns(run, "self_restart() {", "# When his channel went down")
    assert self_fn.index("    restart)") < self_fn.index("      self_mark") < self_fn.index("end_his_session || true") \
        < self_fn.index("bashio::addon.restart") < self_fn.index("self_exit ;;")
    assert self_fn.count("health_down") == 0 and self_fn.count("health_up") == 3
    # Third round: the line the log really shows on a success comes before the call; "took" only when the
    # answer comes first; the exit-route fallback waits 2 minutes, past the Supervisor's 30 second stop.
    assert self_fn.index('"Asking the Supervisor for the App\'s restart"') < self_fn.index("bashio::addon.restart")
    assert 'nap "${C1_SELF_STOP_WAIT_S:-120}"' in self_fn and "timeout: 30" in (CAIN / "config.yaml").read_text()
    # And the self-restart mark (with the health page's) is cleared at the very top, before both traps.
    top = run.index("rm -f /run/cain/self-restart /run/cain-web/www/health-down")
    assert top < run.index("trap 'rc=$?;") < run.index("trap 'term_caught=1; stop_asked;")
    fin = (CAIN / "rootfs/etc/services.d/cain/finish").read_text()
    assert fin.index("[ -e /run/cain/self-restart ]") < fin.index("rm -f /run/cain/self-restart") < fin.index("heartbeat_fail \"restarting itself")
    assert run.count("self_exit\n") == 1 and "drill-exit-route" in run
    assert "[ ! -e /run/cain/self-restart ]" in run.split("trap 'rc=$?;")[1].split("\n")[0]
    assert "check-told" not in run and "stopped-told" not in run and '"$OPT/alert.sh" "Cain is stopped' not in run
    # The check runs in the foreground only, one try at a time: never in the background.
    assert run.count('"$OPT/c1/check.sh"') == 2 and "C1_UNTRIED" in run
    assert not re.search(r"\(\s*sleep 45;", run)
    # The start's decision, for each stop it can reach.
    _start_block(tmp_path, {"c1/state.sh": 'cat "$STUB_STATE"', "c1/lock.sh": '[ "$1" != "${STUB_LOCK_FAIL:-}" ]',
                            "c1/cutover.sh": 'exit "$STUB_RC"'}, 'echo "mode=$mode kind=$stop_kind"')
    (tmp_path / "state").write_text("broken\n")
    env = {"STUB_STATE": (tmp_path / "state").as_posix(), "STUB_VERSION": "0.12.0", "STUB_RC": "0"}
    assert _run_start(tmp_path, **env) == "mode=none kind=damaged"
    (tmp_path / "state").write_text("cut\n")
    assert _run_start(tmp_path, **env) == "mode=own kind="
    assert _run_start(tmp_path, **env, STUB_LOCK_FAIL="verify") == "mode=none kind=setup"
    assert _run_start(tmp_path, **env, STUB_LOCK_FAIL="run") == "mode=none kind=setup"


def _whole_start(tmp_path, **stubs):
    """The whole start (services.d/cain/run) as bashio runs it, on a fake /data, /run/cain, /opt/cain
    and /proc, with every command it runs stubbed: each stub and notice.sh call is noted in calls,
    and sleep is short. A stop file makes every sleep end its caller, so it all winds down. The
    stubbed setpriv (ending every process of his user) empties the fake /proc of his processes."""
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    data, runc, opt, bindir = tmp_path / "data", tmp_path / "run" / "cain", tmp_path / "opt", tmp_path / "bin"
    procs = tmp_path / "proc"
    for d in (data / "c1", data / "link", opt / "c1", opt / "discord", bindir, procs, data / "cain" / ".claude"):
        d.mkdir(parents=True, exist_ok=True)
    # He is signed in to Claude (Cain 0.15.0: a session waiting on the owner's sign-in is never
    # restarted for its channel; tests/test_cain_stays_on.py takes this away for that case).
    (data / "cain" / ".claude" / ".credentials.json").write_text('{"signed": "in"}\n')
    calls, stop = tmp_path / "calls", tmp_path / "stop"
    note = f'echo "$(basename "$0") $*" >> {calls.as_posix()}'
    scripts = {"c1/lock.sh": "exit 0", "c1/state.sh": "echo cut", "notice.sh": "exit 0", "as-cain": "exit 1",
               "checkin.sh": "exit 0", "signin-url.sh": "exit 0", "alert.sh": "exit 0", "session.sh": "exit 0",
               "c1/check.sh": "exit 0"}
    scripts.update(stubs)
    for name, body in scripts.items():
        (opt / name).write_text(f"#!/bin/bash\n{note}\n{body}\n")
        (opt / name).chmod(0o755)
    for name, body in {"bun": 'case "$2" in container-id) echo boot:1;; esac; exit 0', "tmux": "exit 1", "claude": "exit 0",
                       "setpriv": f'{note}\nrm -f {(tmp_path / "session").as_posix()}; rm -rf {procs.as_posix()}/4242',
                       "sleep": (f'[ -f {stop.as_posix()} ] && kill -TERM "$PPID" 2>/dev/null\n'
                                 'case "$1" in 3600|600) echo "sleep $1" >> ' + calls.as_posix() + ';; esac\n'
                                 'exec /bin/sleep 0.05')}.items():
        (bindir / name).write_text(f"#!/bin/bash\n{body}\n")
        (bindir / name).chmod(0o755)
    body = run.split("\n", 1)[1]
    body = (body.replace("OPT=/opt/cain", f"OPT={opt.as_posix()}").replace("/data/", f"{data.as_posix()}/")
                .replace("/run/cain", runc.as_posix()).replace("export HOME=/data", f"export HOME={data.as_posix()}"))
    prelude = ("set -o errexit -o nounset -o pipefail\n"
               "bashio::log.info() { :; }; bashio::log.warning() { :; }; bashio::log.error() { :; }\n"
               "bashio::addon.version() { echo 0.12.0; }; bashio::addon.restart() { echo restart >> " + calls.as_posix() + "; }\n"
               "bashio::config() { echo ''; }\n"
               f"export C1_PROC_ROOT={procs.as_posix()}\n")
    (tmp_path / "whole.sh").write_text(prelude + body)
    return calls, stop, bindir, runc


def _run_whole(tmp_path, calls, stop, bindir, until, timeout=60, **env):
    import subprocess
    import time
    env = {**os.environ, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}", **env}
    p = subprocess.Popen(["bash", (tmp_path / "whole.sh").as_posix()], env=env, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True)
    lines = []
    try:
        end = time.time() + timeout
        while time.time() < end:
            lines = [l.rstrip() for l in calls.read_text().splitlines()] if calls.exists() else []
            if until(lines) or p.poll() is not None:
                break
            time.sleep(0.2)
        alive = p.poll() is None
    finally:
        stop.touch()
        try:
            p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            p.kill()
    return alive, lines, p.stderr.read()[-800:]


def test_the_whole_start_tells_dane_and_stays_up_through_an_early_failure(tmp_path):
    """The reviewer's case: the start's first step fails and /run/cain can't be written. The whole
    run script, not a block of it: Dane is told it's stopped before anything else is tried, the
    steps after it that can't write /run/cain don't end the start, and it reaches the stop's
    hourly loop, alive, with no exit to tell."""
    import shutil
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")
    calls, stop, bindir, runc = _whole_start(tmp_path, **{"c1/lock.sh": "exit 1"})
    assert not runc.exists()                                              # /run/cain isn't there at all
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: "sleep 3600" in l)
    assert alive, err
    assert "notice.sh tell setup" in lines and "sleep 3600" in lines, lines[:20]
    assert lines.index("notice.sh tell setup") < lines.index("sleep 3600")
    assert "notice.sh tell exited" not in lines


def test_the_whole_start_keeps_starting_a_session_that_wont_start_and_says_so(tmp_path):
    """His session won't start (tmux fails as his user): the start doesn't end; it starts it again,
    later each time, and at the third failure in a row Dane hears it isn't answering."""
    import shutil
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")
    calls, stop, bindir, _ = _whole_start(tmp_path)
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: any(x.startswith("notice.sh tell session ") for x in l))
    assert alive, err
    tries = [l for l in lines if l.startswith("as-cain env CAIN_MODE=own tmux -u -S") and "new-session" in l]
    assert len(tries) >= 3 and any(x.startswith("notice.sh tell session ") for x in lines) and "notice.sh tell exited" not in lines, lines[:30]


def _session_up(tmp_path):
    """as-cain for a session that starts (a process of his in the fake /proc) and runs until every
    process of his user is ended (the stubbed setpriv); tmux's own kill-session fails."""
    up, proc = (tmp_path / "session").as_posix(), (tmp_path / "proc" / "4242").as_posix()
    return (f'case "$*" in *new-session*) touch {up}; mkdir -p {proc}; '
            f'printf "State:\\tS (sleeping)\\nUid:\\t1000\\t1000\\t1000\\t1000\\n" > {proc}/status;; '
            f'*has-session*) [ -f {up} ] || exit 1;; *kill-session*) exit 1;; esac; exit 0')


def test_the_whole_start_acts_on_a_breach_at_once_even_when_tmux_wont_end_him(tmp_path):
    """The check of his own user runs in the start's own loop, for the session it started with, and
    its answer is the authority: a breach ends his session even when tmux won't (every process of
    his user, till /proc shows none), and he's stopped there, alive and told, without waiting on
    any record or restart."""
    import shutil
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")
    calls, stop, bindir, _ = _whole_start(tmp_path, **{"as-cain": _session_up(tmp_path), "c1/check.sh": "exit 3"})
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: "sleep 3600" in l, C1_CHECK_FIRST_S="0")
    assert alive, err
    checks = [i for i, l in enumerate(lines) if l.startswith("check.sh")]
    assert len(checks) == 1, lines[:30]
    ended = next(i for i, l in enumerate(lines) if l.startswith("setpriv --reuid=1000"))
    assert checks[0] < lines.index("notice.sh tell breach") < ended, lines[:40]    # told first, then ended
    assert "sleep 3600" in lines and not (tmp_path / "session").exists() and not (tmp_path / "proc/4242").exists()


def test_the_whole_start_holds_him_after_five_tries_that_cant_finish(tmp_path):
    """Four tries that can't try everything yet are tried again a minute apart; the fifth holds him:
    his session ended, the hold's own loop next, never his session left running unchecked."""
    import shutil
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")
    check = 'echo "untried=$C1_UNTRIED" >> ' + (tmp_path / "calls").as_posix() + '\n[ "$C1_UNTRIED" = hold ] && exit 4\nexit 5'
    calls, stop, bindir, _ = _whole_start(tmp_path, **{"as-cain": _session_up(tmp_path), "c1/check.sh": check})
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: "notice.sh tell held" in l,
                                   C1_CHECK_FIRST_S="0", C1_CHECK_EVERY_S="0", C1_HELD_FIRST_S="3600")
    assert alive, err
    assert [l for l in lines if l.startswith("untried=")][:5] == ["untried=retry"] * 4 + ["untried=hold"], lines[:40]
    assert "notice.sh tell held" in lines and not (tmp_path / "proc/4242").exists()


def test_the_whole_start_holds_him_when_the_check_ends_unexpectedly(tmp_path):
    """A check that ends with anything but its four answers (here it isn't there to run: 127) holds
    him at once, never tried again forever: his session ended, the hold recorded with why, and
    Dane told it's a pause."""
    import shutil
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")
    calls, stop, bindir, _ = _whole_start(tmp_path, **{"as-cain": _session_up(tmp_path), "c1/check.sh": "exit 127"})
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: "notice.sh tell held" in l,
                                   C1_CHECK_FIRST_S="0", C1_HELD_FIRST_S="3600")
    assert alive, err
    assert "notice.sh tell held" in lines, lines[:40]
    before = lines[:lines.index("notice.sh tell held")]                  # the hold's own tries come after
    assert sum(l.startswith("check.sh") for l in before) == 1, lines[:40]
    held = (tmp_path / "data/c1/check-held").read_text()
    assert held.startswith("0.12.0 the check ended with 127") and not (tmp_path / "proc/4242").exists()


def test_the_whole_start_never_leaves_him_unchecked_when_tmux_hangs(tmp_path):
    """tmux stops answering (has-session times out) while his session's processes run: that's no
    proof either way, so his session is ended, shown ended in /proc, and started again, and while
    tmux keeps hanging it never runs unchecked: it's ended each time, and Dane hears it isn't
    answering."""
    import shutil
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")
    up, proc = (tmp_path / "session").as_posix(), (tmp_path / "proc" / "4242").as_posix()
    hung = (f'case "$*" in *new-session*) touch {up}; mkdir -p {proc}; '
            f'printf "State:\\tS (sleeping)\\nUid:\\t1000\\t1000\\t1000\\t1000\\n" > {proc}/status;; '
            '*has-session*) exit 124;; *kill-session*) exit 1;; esac; exit 0')
    calls, stop, bindir, _ = _whole_start(tmp_path, **{"as-cain": hung, "c1/check.sh": "exit 0"})
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: any(x.startswith("notice.sh tell session ") for x in l), C1_CHECK_FIRST_S="0")
    assert alive, err
    starts = [i for i, l in enumerate(lines) if "new-session" in l]
    kills = [i for i, l in enumerate(lines) if l.startswith("setpriv --reuid=1000")]
    assert len(starts) >= 3 and len(kills) >= len(starts) - 1 and any(x.startswith("notice.sh tell session ") for x in lines), lines[:40]
    assert not any(l.startswith("check.sh") for l in lines)              # never counted as running, never passed


def test_the_whole_start_tells_dane_when_his_channel_keeps_going_down(tmp_path):
    """Nov 19: his session started, passed its check and ran two minutes, but its Discord channel
    was down by then every time, so the watchdog restarted him every two and a half minutes all
    day. Two minutes of running reset the count of quick ends each time, and Dane never heard.
    A session counts as running only while its channel is connected: one that keeps losing it is
    restarted later each time, and at the third Dane hears Cain isn't answering."""
    import shutil
    import time
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")
    calls, stop, bindir, runc = _whole_start(tmp_path, **{"as-cain": _session_up(tmp_path), "c1/check.sh": "exit 0"})
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 600}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: any(x.startswith("notice.sh tell channel ") for x in l),
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1")
    assert alive, err
    starts = [l for l in lines if "new-session" in l]
    assert len(starts) >= 3 and any(x.startswith("notice.sh tell channel ") for x in lines), lines[:40]
    assert "notice.sh clear switched" not in lines, lines[:40]           # never counted as running
    # A connected channel does count: the alarm comes down and nothing is restarted.
    calls.unlink()
    stop.unlink()
    (runc / "discord.state").write_text(f"connected {int(time.time())}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: "notice.sh clear switched" in l,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1")
    assert alive, err
    assert "notice.sh clear switched" in lines and sum("new-session" in l for l in lines) == 1, lines[:40]


def test_the_whole_start_tells_dane_when_his_channel_drops_after_he_counts_as_running(tmp_path):
    """The outside review's case: the channel is connected when the session is counted as running,
    then drops. Channel restarts are counted apart from quick ends, so that reset doesn't hide them:
    at the third Dane hears it, and the alarm isn't taken down again by the next session's two
    minutes while restarts are still counted."""
    import shutil
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")
    state = (tmp_path / "run" / "cain" / "discord.state").as_posix()
    seen = (tmp_path / "watched").as_posix()
    up, proc = (tmp_path / "session").as_posix(), (tmp_path / "proc" / "4242").as_posix()
    # Each start connects the channel (and forgets how often the loop has looked); the loop's
    # second look in a session finds it dropped, long ago.
    as_cain = (f'case "$*" in *new-session*) touch {up}; mkdir -p {proc}; rm -f {seen}; '
               f'printf "State:\\tS (sleeping)\\nUid:\\t1000\\t1000\\t1000\\t1000\\n" > {proc}/status; '
               f'echo "connected $(date +%s)" > {state};; '
               f'*has-session*) [ -f {up} ] || exit 1;; *kill-session*) exit 1;; esac; exit 0')
    watch = (f'echo x >> {seen}\n'
             f'[ "$(wc -l < {seen})" = 2 ] && echo "down $(( $(date +%s) - 600 ))" > {state}\nexit 0')
    calls, stop, bindir, runc = _whole_start(tmp_path, **{"as-cain": as_cain, "c1/check.sh": "exit 0", "watch.sh": watch})
    runc.mkdir(parents=True, exist_ok=True)
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: any(x.startswith("notice.sh tell channel ") for x in l),
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1")
    assert alive, err
    assert any(x.startswith("notice.sh tell channel ") for x in lines), lines[:60]
    starts = [i for i, l in enumerate(lines) if "new-session" in l]
    told = next(i for i, x in enumerate(lines) if x.startswith("notice.sh tell channel "))
    assert len([i for i in starts if i < told]) == 3, lines[:60]
    clears = [i for i, l in enumerate(lines) if l == "notice.sh clear switched"]
    assert clears and clears[0] < starts[1], lines[:60]                 # the first session did count as running
    assert not any(starts[1] < i for i in clears), lines[:60]           # none after a channel restart


def test_his_connectors_are_never_listed_while_he_runs_as_his_own_user(tmp_path):
    """Nov 19: `claude mcp list` starts every connector to check it, his Discord link too, and the
    broker gives the channel to the newest connection, so the listing 30 seconds after each start
    took the channel from his running session. The new way never runs it; the old way still does
    (the switch needs the names)."""
    import shutil
    import subprocess
    if not shutil.which("bash"):
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    start = run.index("list_connectors() {")
    fn = run[start:run.index("\n}\n", start) + 3]
    assert "mcp list" not in fn[:fn.index('if [ "$mode" != old ]')]
    bindir = tmp_path / "bin"
    bindir.mkdir()
    ran = tmp_path / "ran"
    (bindir / "claude").write_text(f'#!/bin/bash\necho "$*" >> {ran.as_posix()}\n')
    (bindir / "claude").chmod(0o755)
    (tmp_path / "opt").mkdir()
    (tmp_path / "opt/as-cain").write_text(f'#!/bin/bash\necho "as-cain $*" >> {ran.as_posix()}\n')
    (tmp_path / "opt/as-cain").chmod(0o755)
    data = tmp_path / "data"
    (data / "c1").mkdir(parents=True)
    for mode in ("own", "none"):
        (tmp_path / "list.sh").write_text(f"set -o errexit -o nounset -o pipefail\nmode={mode}\nOPT={(tmp_path / 'opt').as_posix()}\n"
                                          + fn.replace("/data/", f"{data.as_posix()}/") + "\nlist_connectors\n")
        env = {**os.environ, "PATH": f"{bindir.as_posix()}:{os.environ.get('PATH', '')}"}
        out = subprocess.run(["bash", (tmp_path / "list.sh").as_posix()], capture_output=True, text=True, env=env)
        assert out.returncode == 0 and "not listed" in out.stdout, (mode, out.stdout, out.stderr[-300:])
        assert not ran.exists(), mode
    assert not (data / "c1/connectors-before").exists()


def test_an_end_of_the_start_is_told_but_not_a_stop_by_signal(tmp_path):
    """The start's exit trap: should it ever end on a fault (errexit) or an exit, Dane hears his App
    stopped itself (the finish script halts the container next); when a signal ends it, as when the
    Supervisor stops or updates the App, nothing is told."""
    import shutil
    import subprocess
    if not shutil.which("bash"):
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    trap = next(l for l in run.splitlines() if l.startswith("trap ") and l.endswith(" EXIT"))
    lines = run.splitlines()
    assert lines.index(trap) < lines.index("relay() { printf '%s\\n' \"$(jq -cn --arg t \"$1\" '{text: $t}')\" >> /data/relay.queue; }")
    opt = tmp_path / "opt"
    opt.mkdir()
    (opt / "notice.sh").write_text('#!/bin/bash\necho "$*" >> "$CALLS"\n')
    (opt / "notice.sh").chmod(0o755)
    for case, tail, want in (("fault", "false", ["tell exited"]), ("exit", "exit 3", ["tell exited"]), ("clean", "exit 0", []),
                             ("signal", "kill -TERM $$; sleep 5", [])):
        calls = tmp_path / f"calls-{case}"
        script = f"set -o errexit\nOPT={opt.as_posix()}\n{trap}\n{tail}\n"
        subprocess.run(["bash", "-c", script], env={**os.environ, "CALLS": calls.as_posix()}, capture_output=True, timeout=20)
        assert (calls.read_text().splitlines() if calls.exists() else []) == want, case


def test_each_failed_switch_reaches_dane_once_as_he_really_runs(tmp_path):
    """C1 second review: a try of the switch that fails reaches Dane from root, the first included,
    and Cain for the laptop session, once, as he really runs after it. Waiting for a new container
    (exit 4): nothing told there (he isn't running, so never "he still answers"); the start in the
    next container tells it, as it runs. Switched by a later try: Cain only."""
    import shutil
    if not shutil.which("bash") or not shutil.which("jq"):
        pytest.skip("no bash or jq")
    data, opt = _start_block(tmp_path, {
        "c1/state.sh": "echo fresh",
        "c1/lock.sh": '[ "$1" = old ] && [ -f "$STUB_DATA/old-fails" ] && exit 1; exit 0',
        # 0.12.0's switch, each call answering from a script: 4 (its validation failed, so it waits
        # for a new container), 1f (failed and undone here), 1 (waits, begins nothing), 0 (done). A
        # failure adds a line to the failed file; once three stand it waits and begins nothing.
        "c1/cutover.sh": ('f="$STUB_DATA/c1/failed"; n=$(wc -l < "$f" 2>/dev/null || echo 0); [ "$n" -ge 3 ] && exit 1\n'
                          'k=$(cat "$STUB_DATA/k" 2>/dev/null || echo 0); echo $((k + 1)) > "$STUB_DATA/k"\n'
                          'a=$(sed -n "$((k + 1))p" "$STUB_DATA/answers"); a=${a:-1}\n'
                          'case "$a" in 4|1f) echo "2026-11-15T23:00:0${n}Z the smoke test failed" >> "$f";; esac\n'
                          'exit "${a%f}"'),
        # Its alarms to Dane's phone shown to work (Cain's fourth service review, must-fix 6): the start
        # asks before a switch, and that question isn't an alarm.
        "notice.sh": 'case "$1" in proven|hooked) exit 0 ;; esac; echo "notice $*" >> "$STUB_DATA/calls"',
    }, 'echo "mode=$mode kind=$stop_kind"')
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "bun").write_text('#!/bin/bash\ncase "$2" in container-id) echo "boot:1";;\n'
                                'may-retry) [ "$(wc -l < "$3" 2>/dev/null || echo 0)" -lt 3 ];; write-state) printf %s "$4" > "$3";; *) exit 0;; esac\n')
    (bindir / "bun").chmod(0o755)
    (data / "link/specialist-signs").write_text("1")
    env = {"STUB_DATA": data.as_posix(), "STUB_VERSION": "0.12.0", "PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}"}
    calls, queue = data / "calls", data / "relay.queue"
    read = lambda f: f.read_text().splitlines() if f.exists() else []

    def fresh(*answers):
        for f in ("failed", "failed-told", "uid1000-ran", "legacy-ran", "a-since"):
            (data / "c1" / f).unlink(missing_ok=True)
        for f in (calls, queue, data / "k"):
            f.unlink(missing_ok=True)
        (data / "answers").write_text("\n".join(map(str, answers)) + "\n")

    # Three validations fail, each waiting for a new container: nothing told in those starts;
    # the start that then runs the old way tells it once, as the six-hour wait.
    fresh(4, 4, 4)
    for _ in range(3):
        assert _run_start(tmp_path, **env) == "mode=none kind=switch-restart"
        assert read(calls) == [] and read(queue) == []
    assert _run_start(tmp_path, **env) == "mode=old kind="
    assert read(calls) == ["notice tell switch-waits the smoke test failed"] and len(read(queue)) == 1
    assert "the old way" in read(queue)[0] and "the smoke test failed" in read(queue)[0] and "P33" in read(queue)[0]
    assert _run_start(tmp_path, **env) == "mode=old kind=" and len(read(calls)) == 1      # nothing new
    # One fails and waits for a new container; there the switch waits for something else, and he
    # runs the old way: told then, as a try the App makes again.
    fresh(4, 1, 1, 1)
    assert _run_start(tmp_path, **env) == "mode=none kind=switch-restart" and read(calls) == []
    assert _run_start(tmp_path, **env) == "mode=old kind="
    assert read(calls) == ["notice tell switch-failed the smoke test failed"] and "the old way" in read(queue)[0]
    # The alarm couldn't be kept (the lock busy): not counted as told, so the next start tells it.
    fresh("1f")
    (opt / "notice.sh").write_text('#!/bin/bash\ncase "$1" in proven|hooked) exit 0 ;; esac\necho "notice $*" >> "$STUB_DATA/calls"\n'
                                   '[ -f "$STUB_DATA/lock-busy" ] && exit 75; exit 0\n')
    (data / "lock-busy").write_text("1")
    assert _run_start(tmp_path, **env) == "mode=old kind=" and not (data / "c1/failed-told").exists() and read(queue) == []
    (data / "lock-busy").unlink()
    assert _run_start(tmp_path, **env) == "mode=old kind=" and (data / "c1/failed-told").read_text().strip() == "1"
    assert read(calls) == ["notice tell switch-failed the smoke test failed"] * 2 and len(read(queue)) == 1
    # The switch couldn't even run (127) and nothing was begun: the old way, the try on record as
    # failed with its cause, and told as such.
    fresh(127)
    assert _run_start(tmp_path, **env) == "mode=old kind="
    assert read(calls) == ["notice tell switch-failed the switch ended with 127 before it began"]
    assert (data / "c1/failed").read_text().count("\n") == 1 and "the old way" in read(queue)[0]
    # The same, and the try can't be put on record (its file isn't one): it stops him instead, with
    # its own alarm, never the old way untold.
    fresh(127)
    (data / "c1/failed").mkdir()
    assert _run_start(tmp_path, **env) == "mode=none kind=switch-blocked" and read(calls) == []
    (data / "c1/failed").rmdir()
    # A try fails and is undone, but the old way doesn't pass its own checks: he's stopped (its
    # alarm says so), and the failed try isn't told as "he still answers", nor counted as told.
    fresh("1f")
    (data / "old-fails").write_text("1")
    assert _run_start(tmp_path, **env) == "mode=none kind=setup" and read(calls) == [] and read(queue) == []
    assert not (data / "c1/failed-told").exists()
    (data / "old-fails").unlink()
    # A try fails and is undone, and the next in the same start goes through: he runs as his own
    # user, so only Cain hears.
    fresh("1f", 0)
    assert _run_start(tmp_path, **env) == "mode=own kind="
    assert read(calls) == [] and len(read(queue)) == 1 and "switched you to your own user after a try" in read(queue)[0]


def test_the_apps_alarms_reach_the_owner_from_root_by_his_bot_and_home_assistant(tmp_path):
    """notice.sh (C1 second review, must-fix 2): an alarm goes to his bot once, retried until it
    goes through, and to Home Assistant's webhook (the notice_hook option, a random id) daily while
    it lasts and at once when the hook is set or changed, even while Discord is down; the hook
    stays off every command line, and nothing is ever made from another value. Alarms are kept per
    group, so one never erases another; within a group a newer one replaces the last. One that
    clears takes its notification down and says so, and stays to be taken down while it can't
    be. An alarm whose state can't be kept says so and fails, for its caller to raise again. A
    probe shows the channel works. Every alarm is plain words for him, with the way back."""
    import hashlib
    import json
    import shutil
    import subprocess
    if not shutil.which("bash") or not shutil.which("jq") or not shutil.which("sha256sum"):
        pytest.skip("no bash, jq or sha256sum")
    notice = (CAIN / "rootfs/opt/cain/notice.sh").as_posix()
    opt, data, stub, bindir = (tmp_path / d for d in ("opt", "data", "stub", "bin"))
    for d in (opt, data, stub, bindir):
        d.mkdir()
    (opt / "alert.sh").write_text('#!/bin/bash\n[ -f "$STUB/discord-up" ] || exit 1\n'
                                  'printf "%s | %s | %s\\n" "$TOKEN_FILE" "$ACCESS_FILE" "$1" >> "$STUB/discord"\n')
    # Home Assistant's side: curl, which reads its address from stdin; what it was given is kept.
    (bindir / "curl").write_text('#!/bin/bash\n[ -f "$STUB/ha-up" ] || exit 7\ncat > "$STUB/curl-stdin"\n'
                                 'printf "%s\\n" "$@" > "$STUB/curl-args"\nfor a in "$@"; do last="$a"; done\n'
                                 'printf "%s\\n" "$(grep -o "url = .*" "$STUB/curl-stdin") $last" >> "$STUB/ha"\n')
    for f in (opt / "alert.sh", bindir / "curl"):
        f.chmod(0o755)
    if not shutil.which("flock"):                                         # this laptop: the image has util-linux
        (bindir / "flock").write_text("#!/bin/bash\nexit 0\n")
        (bindir / "flock").chmod(0o755)
    hook = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    owner = "0123456789abcdef0123456789abcdef"
    options = data / "options.json"
    options.write_text(json.dumps({"github_token": "x", "notice_hook": "", "owner_user_id": owner}))
    env = {**os.environ, "STUB": stub.as_posix(), "NOTICE_OPT": opt.as_posix(), "NOTICE_DATA": data.as_posix(),
           "NOTICE_URL": "http://ha.test:8123", "NOTICE_DAY_S": "100000",
           "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}"}
    groups = data / "c1/notice.d"

    def call(*args, want=0, **more):
        out = subprocess.run(["bash", notice, *args], capture_output=True, text=True, env={**env, **more}, timeout=30)
        assert out.returncode == want, (args, out.returncode, out.stderr[-400:])
        return out.stdout + out.stderr

    read = lambda f: (stub / f).read_text().splitlines() if (stub / f).exists() else []
    posted = lambda: json.loads(read("ha")[-1].split('" ', 1)[1])

    def field(group, k):
        for line in (groups / group).read_text().splitlines():
            key, _, value = line.partition(" ")
            if key == k:
                return value
        return ""

    # Every alarm: plain words for him, the way back, nothing he can't read; a cause in its words.
    for kind in ("breach", "switch-stopped", "switch-blocked", "damaged", "setup", "restart", "switch-restart", "exited", "session", "held",
                 "switch-failed", "switch-waits", "waiting", "stalled", "signin", "phone"):
        title, text = call("text", kind, "the smoke test failed").splitlines()
        for words in (title, text):
            assert "—" not in words and "add-on" not in words.lower(), kind
            assert not re.search(r"\b([PQ]\d+|[CDF]\d|wave \d)\b", words), kind
        # Cain 0.15.0: what the App does itself, or the way back named in its documentation; his own
        # sign-in names where its link is. Never a step of his (cain/tests/stays-on.test.ts).
        assert ("Nothing for you to do" in text or "by itself" in text or "If Cain stops" in text
                or "Only you can sign him in" in text), kind
        assert "Settings, " not in text and "restart the Cain App" not in text, kind
    # The App restarts itself in both of these (Cain 0.13.3): each ends at "Nothing for you to do."
    for kind in ("restart", "switch-restart"):
        text = call("text", kind, "x").splitlines()[1]
        assert text.endswith("Nothing for you to do.") and "restart the Cain App" not in text and "If he isn't back" not in text, kind
    assert "didn't pass its checks (the smoke test failed), so it was undone" in call("text", "switch-failed", "the smoke test failed")
    # A failed switch is told before his session has started: it says where his App went, never
    # that he answers (C1 sixth outside round); and a move that never began isn't "part way".
    for kind in ("switch-failed", "switch-waits"):
        assert "answers you" not in call("text", kind, "x") and "went back to the old way" in call("text", kind, "x"), kind
    blocked = call("text", "switch-blocked", "the switch ended with 127 before it began")
    assert "couldn't begin (the switch ended with 127 before it began)" in blocked and "The move changed nothing" in blocked
    assert "part way" not in blocked
    assert "(the last: a, b, the App more)" in call("text", "switch-waits", "a — b, the add-on\nmore")

    # Raised while Discord is down and no hook is set: kept, nothing lost, and nothing is made
    # from owner_user_id (Cain could read that through his Home Assistant connector).
    call("tell", "held")
    assert field("stop", "kind") == "held" and field("stop", "discord") == "0" and field("stop", "sent") == "0" and read("ha") == []
    (stub / "ha-up").touch()
    call("tick", NOTICE_DAY_S="0")
    assert read("ha") == []
    # The hook is set: Home Assistant has the alarm at once, by stdin, never on a command line.
    options.write_text(json.dumps({"github_token": "x", "notice_hook": hook, "owner_user_id": owner}))
    call("tick")
    alarms = [l for l in read("ha") if '"state":"on"' in l]
    assert alarms and alarms[-1].startswith(f'url = "http://ha.test:8123/api/webhook/{hook}"')
    sent = json.loads(alarms[-1].split('" ', 1)[1])
    assert (sent["group"], sent["alarm"], sent["title"]) == ("stop", "held", "Cain is paused") and "isn't a breach" in sent["message"]
    assert not any(hook in a for a in read("curl-args"))
    assert field("stop", "fp") == hashlib.sha256(hook.encode()).hexdigest()[:16] and field("stop", "discord") == "0"
    assert any('"state":"test","group":"probe"' in l for l in read("ha")) and (data / "c1/notice-probed").exists()
    # Discord comes back: his bot posts it once, from root's copy of the token.
    (stub / "discord-up").touch()
    (data / "link").mkdir()
    (data / "link/discord.env").write_text("DISCORD_BOT_TOKEN=x\n")
    call("tick")
    assert len(read("discord")) == 1 and read("discord")[0].startswith(f"{data.as_posix()}/link/discord.env | ")
    assert read("discord")[0].endswith("isn't a breach. The App tries the check again every 10 minutes, and he comes back by himself once it finishes. "
                                       "The App keeps his link and the calendar App's cards running meanwhile, and the way back is in the App's "
                                       "documentation, under If Cain stops. The Cain App's log has the details.")
    n = len(read("ha"))
    call("tick"); call("tell", "held")
    assert len(read("discord")) == 1 and len(read("ha")) == n            # raised already: nothing new
    call("tick", NOTICE_DAY_S="0")
    assert len(read("discord")) == 1 and posted()["state"] == "on"        # Home Assistant daily, Discord once
    # Another group's alarm stands beside it; the same group's replaces it.
    call("tell", "switch-failed", "the smoke test failed")
    call("tell", "session")
    call("tell", "breach")
    assert (field("stop", "kind"), field("session", "kind"), field("switch", "kind")) == ("breach", "session", "switch-failed")
    assert field("switch", "cause") == "the smoke test failed" and "(the smoke test failed)" in read("discord")[-3]
    assert read("discord")[-1].endswith("| Cain is stopped: a safety check of his own user failed after his update, so he won't run on this version. "
                                        "A fixed update brings him back by itself. The App keeps his link and the calendar App's cards running meanwhile, "
                                        "and the way back is in the App's documentation, under If Cain stops. The Cain App's log has the details.")
    # A lesser alarm doesn't replace a greater one in its group: the App stopping itself after a breach.
    call("tell", "exited")
    assert field("stop", "kind") == "breach"
    # He runs again: the stop and session alarms come down, both ways; the failed switch stays.
    call("clear", "running")
    assert not (groups / "stop").exists() and not (groups / "session").exists() and field("switch", "kind") == "switch-failed"
    cleared = [json.loads(l.split('" ', 1)[1]) for l in read("ha") if '"state":"clear"' in l]
    assert {(c["group"], c["title"]) for c in cleared} == {("stop", "Cain is back"), ("session", "Cain is back")}
    assert read("discord")[-1].endswith("| Cain is running again.")
    # The same group's alarm replaced while Home Assistant is away: what it showed still comes down.
    call("tell", "held")
    os.remove(stub / "ha-up")
    call("tell", "breach")
    assert field("stop", "kind") == "breach" and field("stop", "shown") == "1" and field("stop", "fp") == ""
    call("clear", "running", want=1)
    assert field("stop", "clear") == "1"                                  # still to come down
    (stub / "ha-up").touch()
    call("tick")
    assert not (groups / "stop").exists() and (posted()["state"], posted()["group"]) == ("clear", "stop")
    # The same alarm with another cause is a new alarm.
    n = len(read("discord"))
    call("tell", "switch-failed", "his connectors wouldn't all load")
    assert len(read("discord")) == n + 1 and "(his connectors wouldn't all load)" in read("discord")[-1]
    # Only his running as his own user clears it; Home Assistant away, the clearing waits.
    os.remove(stub / "ha-up")
    call("clear", "switched", want=1)
    assert field("switch", "clear") == "1" and read("discord")[-1].endswith("| Cain now runs as his own user, the safer setup in his update.")
    (stub / "ha-up").touch()
    call("tick")
    assert not (groups / "switch").exists() and posted()["title"] == "Cain moved to his own user"
    # A question that keeps coming back on his screen (unstick.sh): its own group, which neither his
    # running again nor his move clears, only his prompt back (clear screen).
    call("tell", "waiting")
    assert field("screen", "kind") == "waiting" and (posted()["group"], posted()["alarm"]) == ("screen", "waiting")
    assert read("discord")[-1].endswith("| Cain isn't answering: a question is waiting on his screen, where no one answers it, "
                                        "and Esc didn't clear it. The App starts his session fresh by itself. The Cain App's log has the details.")
    call("clear", "running")
    call("clear", "switched")
    assert field("screen", "kind") == "waiting"
    call("clear", "screen")
    assert not (groups / "screen").exists() and (posted()["state"], posted()["group"], posted()["title"]) == ("clear", "screen", "Cain is back")
    assert read("discord")[-1].endswith("| Cain is answering again: nothing waits on his screen.")
    call("clear", "other", want=2)
    # A clearing with no hook to take it down stays, said, until one can.
    call("tell", "session")
    options.write_text(json.dumps({"notice_hook": "../x"}))
    assert "still up" in call("clear", "running", want=1) and field("session", "clear") == "1"
    options.write_text(json.dumps({"notice_hook": hook}))
    call("tick")
    assert not (groups / "session").exists() and posted()["state"] == "clear"
    # A hook that isn't one is never used.
    for bad in ("../../api/services", "short", hook + "/x"):
        options.write_text(json.dumps({"notice_hook": bad}))
        n = len(read("ha"))
        call("tell", "damaged"); call("tick", NOTICE_DAY_S="0")
        assert len(read("ha")) == n, bad
        (groups / "stop").unlink()
    # An alarm whose state can't be kept: said, and a failure for its caller to raise again.
    (groups / "stop").mkdir()                                             # the state's place isn't a file
    assert "couldn't be kept" in call("tell", "setup", want=1)
    (groups / "stop").rmdir()


def test_the_apps_alarms_never_write_without_the_lock(tmp_path):
    """notice.sh holds the lock for everything it changes: a writer that can't have it within its
    wait changes nothing and exits 75 (raised again by its caller or the next tick)."""
    import shutil
    import subprocess
    import time
    if not shutil.which("bash") or not shutil.which("flock") or not shutil.which("jq"):
        pytest.skip("needs bash, flock and jq")
    data = tmp_path / "data"
    (data / "c1/notice.d").mkdir(parents=True)
    (data / "options.json").write_text("{}")
    env = {**os.environ, "NOTICE_DATA": data.as_posix(), "NOTICE_OPT": tmp_path.as_posix(), "NOTICE_LOCK_S": "1"}
    holder = subprocess.Popen(["flock", (data / "c1/notice.d/.lock").as_posix(), "sleep", "5"])
    try:
        time.sleep(0.5)
        out = subprocess.run(["bash", (CAIN / "rootfs/opt/cain/notice.sh").as_posix(), "tell", "held"],
                             capture_output=True, text=True, env=env, timeout=20)
        assert out.returncode == 75 and "kept the lock" in out.stderr and not (data / "c1/notice.d/stop").exists()
    finally:
        holder.kill()


def test_the_old_way_keeps_his_connectors_only_from_a_listing_that_went_through(tmp_path):
    """C1 re-check: the switch checks every claude.ai connector of his still loads under his new
    rules. The old way keeps their names only from a listing that went through, its first line
    saying so (without it the switch waits); each listing's names join the last's, so a moment
    when claude.ai didn't answer can't empty it; and a long listing doesn't end it under
    pipefail. The start's loop lists again until one goes through, and asks for the restart
    that switches only once one has."""
    import shutil
    import subprocess
    if not shutil.which("bash"):
        import pytest
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    start = run.index("list_connectors() {")
    fn = run[start:run.index("\n}\n", start) + 3]
    data = tmp_path / "data"
    (data / "c1").mkdir(parents=True)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "claude").write_text('#!/bin/bash\ncat "$STUB_OUT"; exit "$STUB_RC"\n')
    (bindir / "claude").chmod(0o755)
    (tmp_path / "list.sh").write_text("set -o errexit -o nounset -o pipefail\nmode=old\nOPT=/nowhere\n"
                                      + fn.replace("/data/", f"{data.as_posix()}/") + "\nlist_connectors\n")
    base = data / "c1/connectors-before"

    def listing(lines, rc=0):
        (tmp_path / "out").write_text("\n".join(lines) + "\n")
        env = {**os.environ, "STUB_OUT": (tmp_path / "out").as_posix(), "STUB_RC": str(rc),
               "PATH": f"{bindir.as_posix()}:{os.environ.get('PATH', '')}"}
        out = subprocess.run(["bash", (tmp_path / "list.sh").as_posix()], capture_output=True, text=True, env=env)
        assert out.returncode == 0, out.stderr[-500:]
        return out.stdout

    assert "isn't kept for the switch" in listing(["claude.ai Gmail: https://x - Connected"], rc=1)
    assert not base.exists()
    listing(["Checking MCP server health...", "",
             "claude.ai Gmail: https://mcp-proxy.anthropic.com/v1/mcp/a - Connected",
             "claude.ai Google Calendar: https://mcp-proxy.anthropic.com/v1/mcp/b - Connected",
             "plugin:discord:discord: bun run start - Connected"])
    names = ["listed", "claude.ai Gmail", "claude.ai Google Calendar"]
    assert base.read_text().splitlines() == names
    listing(["Checking MCP server health..."])                       # claude.ai didn't answer
    assert base.read_text().splitlines() == names
    listing([f"server{i}: cmd - Connected" for i in range(60)] + ["claude.ai Home: https://x - Connected"])
    assert base.read_text().splitlines() == names + ["claude.ai Home"]
    loop = run[run.index("asked=0; listed_at="):run.index('bashio::log.warning "Cain\'s session ended.')]
    assert '( list_connectors ) &' in loop and loop.index("list_connectors") < loop.index("bashio::addon.restart")
    ask = loop[loop.index('if [ "$mode" = old ] && [ -f /data/link/specialist-signs ]'):loop.index("bashio::addon.restart")]
    assert '[ "$(head -n 1 /data/c1/connectors-before 2>/dev/null || true)" = listed ]' in ask


def test_cain_scripts_unset_the_supervisor_token_before_starting_anything():
    # Supervisor's token reaches /addons/self: this App's own options, owner_user_id
    # included. Both service scripts unset it before they start anything, so nothing
    # they start (Cain's session, nginx, ttyd, the helpers) has it in its environment.
    # bashio keeps its own unexported copy (bashio.sh declares __BASHIO_SUPERVISOR_TOKEN
    # when it loads), so their option reads, in subshells too, still work.
    import os, shutil, subprocess
    unset = "unset SUPERVISOR_TOKEN HASSIO_TOKEN"
    prefixes = {}
    for name in ("cain", "terminal"):
        lines = (CAIN / f"rootfs/etc/services.d/{name}/run").read_text().splitlines()
        assert unset in lines, name
        at = lines.index(unset)
        ran = [l for l in lines[1:at] if l.strip() and not l.lstrip().startswith("#")]
        assert all(l.startswith("export ") for l in ran), (name, ran)       # nothing starts before it
        after = [l for l in lines[at + 1:] if not l.lstrip().startswith("#")]
        assert not any(re.search(r"SUPERVISOR_TOKEN|HASSIO_TOKEN", l) for l in after), name  # nor puts it back
        prefixes[name] = "\n".join(lines[1:at + 1])
    bash = shutil.which("bash")
    if not bash:
        import pytest
        pytest.skip("no bash")
    env = dict(os.environ, SUPERVISOR_TOKEN="supervisor-secret", HASSIO_TOKEN="hassio-secret")
    for name, prefix in prefixes.items():
        script = ("declare __BASHIO_SUPERVISOR_TOKEN=${SUPERVISOR_TOKEN:-}\n"   # as bashio.sh does at load
                  f"{prefix}\n"
                  'echo "shell:$__BASHIO_SUPERVISOR_TOKEN"; ( echo "subshell:$__BASHIO_SUPERVISOR_TOKEN" )\n'
                  "env\n")
        out = subprocess.run([bash, "-c", script], env=env, capture_output=True, text=True,
                             timeout=20, check=True).stdout
        assert "shell:supervisor-secret\nsubshell:supervisor-secret\n" in out, name
        started = out.split("subshell:supervisor-secret\n", 1)[1]           # what a started program gets
        assert not re.search(r"^(SUPERVISOR_TOKEN|HASSIO_TOKEN|__BASHIO_SUPERVISOR_TOKEN)=", started, re.M), name
        assert "-secret" not in started, name


def test_cain_signin_link_is_rejoined(tmp_path):
    import shutil, subprocess
    bash = shutil.which("bash")
    if not bash:
        return
    screen = ("Browser didn't open? Use the url below to sign in:\n\n"
              "  https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44\n"
              "  d9-88ed&response_type=code&redirect_uri=https%3A%2F%2Fplatform\n"
              "  .claude.com%2Foauth%2Fcode%2Fcallback&state=abc123\n\n"
              "  Paste code here if prompted >\n")
    out = subprocess.run([bash, str(CAIN / "rootfs/opt/cain/signin-url.sh")], input=screen,
                         capture_output=True, text=True, check=True).stdout.strip()
    assert out == ("https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed"
                   "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode"
                   "%2Fcallback&state=abc123")


def test_cain_signin_page_is_served_from_roots_folder_for_nginx():
    # C1: root's pages live in /run/cain-web/www (root:nogroup), never at a fixed name in /tmp.
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    assert "location = /signin" in nginx and "alias /run/cain-web/www/signin.html;" in nginx
    assert "/tmp/" not in nginx


def test_cain_page_shows_signin_over_the_terminal_with_relative_paths():
    page = (CAIN / "rootfs/opt/cain/index.html").read_text()
    assert 'src="tty/"' in page and 'fetch("signin"' in page
    assert "/api/" not in page and 'src="/' not in page     # must work under the Ingress prefix
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    assert "location = /" in nginx and "location /tty/" in nginx
    assert "--base-path /tty" in (CAIN / "rootfs/etc/services.d/terminal/run").read_text()


def test_cain_page_root_is_not_an_alias():
    # alias on "location = /" makes nginx look for "index.htmlindex.html" (0.1.4 gave 500).
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    block = nginx.split("location = / {")[1].split("}")[0]
    code = " ".join(l for l in block.splitlines() if not l.strip().startswith("#"))
    assert "alias" not in code and "try_files /index.html =404;" in code


def test_cain_page_has_a_paste_box_that_types_into_the_terminal():
    # On a phone there is no way to paste into the terminal itself (0.1.5).
    page = (CAIN / "rootfs/opt/cain/index.html").read_text()
    assert '<input id="code"' in page and "contentWindow.term" in page
    assert r'type("\r")' in page                           # Enter is sent after the code
    bar = page.split('<div id="bar">')[1].split("</div>")[0]
    assert '<form id="send">' not in bar                     # the box shows even with no sign-in waiting


def test_cain_status_gives_facts_not_the_screen():
    # /status lets setup be checked from outside; the screen may hold a token, so
    # only yes/no facts and a fixed state word leave the add-on.
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    status = run.split("printf '{\"signed_in\"")[1].split("> /run/cain-web/www/status.tmp")[0]
    assert "$screen" not in status and "$last" not in status
    assert status.count("$(flag ") == 4 and '"$state"' in status
    states = {line.split("state=")[1].split(";")[0].strip() for line in run.splitlines() if "state=" in line and "then state=" in line}
    assert states == {"login_needed", "waiting_for_code", "trust_prompt", "first_run_menu", "ready", "dialog"}
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    assert "location = /status {" in nginx and "alias /run/cain-web/www/status.json;" in nginx


def test_cain_tells_the_owner_once_when_its_signin_expires():
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert 'state" = login_needed ] && [ ! -f /data/alerted-login ]' in run
    assert "touch /data/alerted-login" in run and "rm -f /data/alerted-login" in run
    alert = (CAIN / "rootfs/opt/cain/alert.sh").read_text()
    code = "\n".join(l for l in alert.splitlines() if not l.strip().startswith("#"))
    # The token is only written to a private header file, then dropped.
    assert len(re.findall(r"\$token\b", code)) == 2 and "umask 077" in code and "unset token" in code
    assert code.index("unset token") < code.index("curl ")
    assert '-H "@$hdr"' in code and "set -x" not in code
    assert " jq " in (CAIN / "Dockerfile").read_text()


def test_cain_hands_calendar_changes_to_the_keeper_with_the_shared_key():
    import sys
    sys.path.insert(0, str(ADDON / "app"))
    from harness import handover
    script = (CAIN / "rootfs/opt/cain/keeper.sh").read_text()
    code = "\n".join(l for l in script.splitlines() if not l.strip().startswith("#"))
    # The same key the harness checks, made from the token inside bun, never on a command line.
    assert f"ctx={handover.KEY_CONTEXT.decode()}" in code and 'createHmac("sha256"' in code
    assert "process.env.ENV_FILE" in code and "$token" not in code
    assert "umask 077" in code and '-H "@$hdr"' in code and "unset key" in code
    assert code.index("unset key") < code.index("curl ")
    # To the specialist: requests and the digest. To Cain's own link, on this machine only:
    # showing a card, asking with buttons, the morning message.
    assert f'harness="http://0fcc2575-harness:{handover.PORT}"' in code
    # A test may move it only with the test flag too, and that's logged (0.24.0 review).
    assert 'if [ "${CAIN_KEEPER_TEST:-}" = 1 ]; then' in code and "test override in use" in code
    assert 'url="$harness/$cmd"' in code
    assert 'link="${CAIN_LINK:-http://127.0.0.1:8097}"' in code and 'url="$link/$cmd"; ctx=harness-relay-v1' in code
    assert 'card) url="$link/look"; ctx=harness-relay-v1' in code
    for route in ("handover", "digest"):
        assert f"/{route}" in handover.ROUTES
    # Nothing of his is passed: only Cain's own suggestion and who Cain is paired with.
    assert "{suggestion: $s, paired: $p}" in code
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "/opt/cain/keeper.sh handover" in rules and "never change a calendar yourself" in rules
    assert "exec /opt/cain/keeper.sh handover" in (CAIN / "rootfs/opt/cain/handover.sh").read_text()
    # C1: his rules are managed files (lock.sh managed), and the old way gets 0.11.0's own.
    lock = (CAIN / "rootfs/opt/cain/c1/lock.sh").read_text()
    assert 'install -m 0644 -o root -g root "$OPT/settings.json" /etc/claude-code/managed-settings.json' in lock
    assert 'install -m 0644 "$OPT/legacy/settings.json" "$D/work/.claude/settings.json"' in lock


def test_keeper_sends_cards_with_their_item_question_and_thread(tmp_path):
    import json, os, shutil, subprocess
    bash, jq = shutil.which("bash"), shutil.which("jq")
    if not bash or not jq:
        import pytest
        pytest.skip("no bash or jq")
    stub = tmp_path / "bin"
    stub.mkdir()
    (stub / "bun").write_text("#!/bin/bash\nprintf deadbeef\n", newline="\n")     # the key, made from no token
    (stub / "curl").write_text('#!/bin/bash\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$CURL_ARGS"\n'
                               "echo '{\"status\":\"posted\"}'\n", newline="\n")
    for f in ("bun", "curl"):
        (stub / f).chmod(0o755)
    env = dict(os.environ, PATH=f"{stub}{os.pathsep}{os.environ['PATH']}", CURL_ARGS=str(tmp_path / "args"))
    keeper = str(CAIN / "rootfs/opt/cain/keeper.sh")

    def call(*a):
        out = subprocess.run([bash, keeper, *a], env=env, capture_output=True, text=True, timeout=20)
        args = (tmp_path / "args").read_text().splitlines()
        return out, json.loads(args[args.index("-d") + 1]), args[-1]

    sha = "0123456789abcdef0123456789abcdef01234567"
    out, body, url = call("ask", "--item", "P08", "--question", "Q2", "--reply-to", "1234567890123456789",
                          "P08 Q2: Is the packet filed?", "Filed", "Not filed", "Not sure")
    assert url == "http://127.0.0.1:8097/ask" and json.loads(out.stdout) == {"status": "posted"}
    assert body == {"item": "P08", "question": "Q2", "reply_to": "1234567890123456789",
                    "text": "P08 Q2: Is the packet filed?", "options": ["Filed", "Not filed", "Not sure"]}
    assert call("ask", "Filed?", "Yes", "--item", "none")[1] == {"item": "none", "text": "Filed?", "options": ["Yes"]}
    assert call("ask", "Filed?", "Yes")[1]["item"] == ""                             # the link refuses it
    assert call("show", "1794112807413", "--item", "none", "--reply-to", "99999999999999999")[1] == {
        "item": "none", "reply_to": "99999999999999999", "id": 1794112807413}
    _, body, url = call("ship", "--item", "P41", "--pr", "https://github.com/HyndeSyte/harness/pull/5",
                        "--head", sha, "Cain 0.7.0 ready.")
    assert url.endswith("/ship") and body == {"item": "P41", "text": "Cain 0.7.0 ready.",
                                              "pr": "https://github.com/HyndeSyte/harness/pull/5", "head": sha}
    assert call("answered", "--item", "P08", "--question", "Q2")[1] == {"item": "P08", "question": "Q2"}
    assert call("replied", "1234567890123456789")[1] == {"m": "1234567890123456789"}
    assert call("morning", "## Wed")[1] == {"text": "## Wed", "options": []}
    # Piece D: look at a message now, check a reply against the gate, replay, the connector notice.
    out, body, url = call("card", "1234567890123456789")
    assert url == "http://127.0.0.1:8097/look" and body == {"m": "1234567890123456789"}
    _, body, url = call("check", "--reply-to", "1234567890123456789", "Tap Undo if it's wrong.")
    assert url.endswith("/check") and body == {"text": "Tap Undo if it's wrong.", "reply_to": "1234567890123456789"}
    assert call("check", "--edit", "99999999999999999", "Fixed.")[1] == {"text": "Fixed.", "edit": "99999999999999999"}
    assert call("replay")[1] == {"days": 14} and call("replay", "30")[1] == {"days": 30}
    _, body, url = call("connector", "--item", "P41", "Installing Harness 0.22.0")
    assert url.endswith("/connector") and body == {"item": "P41", "text": "Installing Harness 0.22.0"}
    missing = subprocess.run([bash, keeper, "ask", "--item"], env=env, capture_output=True, text=True, timeout=20)
    assert missing.returncode == 2 and "--item needs a value" in missing.stdout


def test_cains_remote_trigger_hook_is_wired_and_shipped():
    import json
    hooks = json.loads((CAIN / "rootfs/opt/cain/settings.json").read_text())["hooks"]["PreToolUse"]
    pre = [h for h in hooks if h["matcher"] == "RemoteTrigger"]
    # A hook that crashes refuses (exit 2), rather than letting the run through.
    assert len(pre) == 1 and pre[0]["hooks"][0]["command"] == "bun /opt/cain/hooks/remote-trigger.ts || exit 2"
    hook = (CAIN / "rootfs/opt/cain/hooks/remote-trigger.ts").read_text(encoding="utf-8")
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    for trig in re.findall(r"trig_[A-Za-z0-9]+", hook):
        assert trig in rules, trig
    assert 'permissionDecision: "deny"' in hook and '"/data/record-holds.json"' in hook and '"/data/trust/ship.pub"' in hook
    assert "COPY rootfs /" in (CAIN / "Dockerfile").read_text()                       # ships with the add-on


def test_cloud_jobs_in_this_repo_cannot_notify_him():
    import json
    deny = json.loads((ROOT / ".claude/settings.json").read_text())["permissions"]["deny"]
    assert "PushNotification" in deny


def test_cain_cannot_edit_the_keepers_own_holds():
    import json
    deny = json.loads((CAIN / "rootfs/opt/cain/settings.json").read_text())["permissions"]["deny"]
    assert {"Edit(//data/record-holds.json)", "Edit(//data/record-holds.json.next)"} <= set(deny)


def test_cain_knows_the_keepers_item_ops():
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    record = rules.split("## Your record")[1].split("\n## ")[0]
    for op in ('"op": "row"', '"op": "row-add"', '"op": "row-close"', '"op": "take"', '"op": "pass"',
               '"op": "release"', '"op": "renew"', '"op": "note"', "record.sh rowsha", "record.sh holds",
               "record.sh notes <item>", "record.sh notes -", '"for": "dane: <his words>"', '"job": "<title>"',
               "refused", "upper-cased"):
        assert op in record, op
    jobs = rules.split("## Cloud jobs")[1].split("\n## ")[0]
    assert "`take` it with\n   `\"job\": \"<title>\"`" in jobs and "`release` the job's item" in jobs


def test_cains_cards_are_exact_and_his_words_true():
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    asking = rules.split("## Asking him")[1].split("\n## ")[0]
    for must in ("--item", "--question", '"Filed", "Not filed", "Not sure"', 'never "Not', "One ask is open at a time",
                 '"held"', "keeper.sh answered", "Record what he tapped exactly", "Never record a fact you",
                 "reply_to", "overrides your plugin's note", "keeper.sh replied"):
        assert must in asking, must
    holds = rules.split("## Who holds what")[1].split("\n## ")[0]
    for must in ("state/holds.json", "Ask him only about items you hold", "Never tell him who holds what",
                 "never pass his Discord work to a laptop session", "(P43)", '"Got it"', "in a `note`",
                 "as a `note` on its item", "read its notes"):
        assert must in holds, must
    timing = rules.split("## Timing and truth")[1].split("\n## ")[0]
    for must in ("happens before it", '"asked", "sent", "started" or "done" only once', "ISO timestamps",
                 "job, session, card, request or commit ids"):
        assert must in timing, must
    assert "starting with\n  its item and question id" in rules
    assert "—" not in rules


def test_the_handover_port_is_never_published():
    cfg = (ADDON / "config.yaml").read_text()
    assert not re.search(r"^ports", cfg, re.M) and "8098" not in cfg


def test_cain_cannot_write_calendars_send_messages_or_change_home_assistant():
    import json
    deny = set(json.loads((CAIN / "rootfs/opt/cain/settings.json").read_text())["permissions"]["deny"])
    for tool in ("create_event", "update_event", "delete_event", "respond_to_event"):
        assert f"mcp__claude_ai_Google_Calendar__{tool}" in deny
    for tool in ("create-events", "update-events", "cancel-events"):
        assert f"mcp__claude_ai_Notion__notion-calendar-{tool}" in deny
    for tool in ("send_message", "reply", "forward"):
        assert f"mcp__claude_ai_Gmail__{tool}" in deny
    assert {"mcp__claude_ai_Slack__slack_send_message",
            "mcp__claude_ai_Slack__slack_schedule_message"} <= deny
    assert "mcp__claude_ai_HASS_MCP" in deny          # the whole read-write connector
    assert not any("read-only" in d for d in deny)    # reading stays


def _checkin(tmp_path, now, screen, runs=None, checked=True, after=None, day="2026-11-08", **more):
    """checkin.sh `runs` times, or by default until it sends something, at most twice (it types only
    on a second read of his prompt, so one call is one step), with a stand-in tmux and Claude Code.
    His screen is `screen` until something is typed; then his input box holds what was typed (each
    typing adds to it, as Claude Code's does), or the screen is `after` (a question that opened
    meanwhile; {mark} stands for the try's mark). A file box/dialog puts a question on screen over
    everything. Enter sends what the box holds: it goes into his transcript (CAIN_TRANSCRIPTS, as
    Claude Code writes it) and the box empties. With STUB_ENTER_DIALOG a question takes the first
    Enter instead and goes (the box keeps the try), or stays on screen with STUB_ENTER_STAYS; with
    STUB_LOSE the try goes with the Enter, written nowhere. Ctrl+U empties the box; STUB_DOWN makes
    tmux fail to read the screen. `checked`: the run script's mark that his session passed its
    check, holding his pane's process (STUB_PID, 4242). Every run exits 0 (Cain's fourth service
    review, must-fix 3). Returns all that was sent."""
    import shutil
    import subprocess
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("no bash")
    stub, box, trans = tmp_path / "bin", tmp_path / "box", tmp_path / "transcripts"
    for d in (stub, box, trans):
        d.mkdir(exist_ok=True)
    (stub / "tmux").write_text(
        "#!/bin/bash\n"
        'if [ "$2" = display ]; then case "$*" in *pane_pid*) echo "${STUB_PID:-4242}" ;; *) echo "${STUB_WIDTH:-120}" ;; esac; exit 0; fi\n'
        'if [ "$2" = capture-pane ]; then\n'
        '  [ -z "${STUB_DOWN:-}" ] || exit 1\n'
        '  if [ -f "$STUB_BOX/dialog" ]; then cat "$STUB_BOX/dialog"\n'
        '  elif [ ! -f "$STUB_BOX/typed" ]; then printf "%s\\n" "$STUB_SCREEN"\n'
        '  elif [ -n "${STUB_AFTER:-}" ]; then m=$(head -c 10 "$STUB_BOX/typed"); printf "%s\\n" "${STUB_AFTER//\\{mark\\}/$m}"\n'
        '  else printf "\\342\\235\\257 %s\\n  ? for shortcuts\\n" "$(cat "$STUB_BOX/typed")"; fi\n'
        '  exit 0\n'
        'fi\n'
        'printf "%s\\n" "$*" >> "$STUB_SENT"\n'
        'case "$*" in\n'
        '  *" -l "*) printf "%s" "${@: -1}" >> "$STUB_BOX/typed" ;;\n'
        '  *" Enter")\n'
        '    if [ -n "${STUB_ENTER_DIALOG:-}" ] && [ ! -f "$STUB_BOX/took" ]; then\n'
        '      touch "$STUB_BOX/took"\n'
        '      [ -z "${STUB_ENTER_STAYS:-}" ] || printf "%s\\n" "$STUB_DIALOG" > "$STUB_BOX/dialog"\n'
        '    elif [ -n "${STUB_LOSE:-}" ]; then rm -f "$STUB_BOX/typed"\n'
        '    elif [ -f "$STUB_BOX/typed" ]; then\n'
        "      printf '{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"%s\"}}\\n' \"$(cat \"$STUB_BOX/typed\")\" >> \"$STUB_TRANSCRIPTS/session.jsonl\"\n"
        '      rm -f "$STUB_BOX/typed"\n'
        '    fi ;;\n'
        '  *" C-u"*) rm -f "$STUB_BOX/typed" ;;\n'
        'esac\n', encoding="utf-8", newline="\n")
    (stub / "tmux").chmod(0o755)
    mark = tmp_path / "session-checked"
    if checked and not (mark.exists() and mark.read_text() == "4242\n"):   # kept as it is: its time counts
        mark.write_text("4242\n", newline="\n")
    elif not checked and mark.exists():
        mark.unlink()
    sent = tmp_path / "sent.txt"
    env = dict(os.environ, PATH=f"{stub}{os.pathsep}{os.environ['PATH']}",
               CHECKIN_DIR=str(tmp_path / "done"), CHECKIN_NOW=now, CHECKIN_DAY=day,
               STUB_SCREEN=screen, STUB_SENT=str(sent), STUB_BOX=box.as_posix(), STUB_TRANSCRIPTS=trans.as_posix(),
               STUB_DIALOG=AUTO_MODE_OFFER, CAIN_TRANSCRIPTS=trans.as_posix(),
               CAIN_FROM_APP=(tmp_path / "from-app").as_posix(), CHECKIN_TRY=(tmp_path / "checkin.try").as_posix(),
               CHECKIN_DELIVERED=(tmp_path / "checkin.delivered").as_posix(),
               CHECKIN_LAST=(tmp_path / "checkin.last").as_posix(),
               CHECKIN_STATE=str(tmp_path / "state"), SESSION_CHECKED=str(mark), CHECKIN_STEADY_S="0",
               CHECKIN_PAUSE_S="0", TYPING_SH=(CAIN / "rootfs/opt/cain/typing.sh").as_posix(),
               PROMPT_STATE=(CAIN / "rootfs/opt/cain/prompt-state.sh").as_posix(), **more)
    for k in ("STUB_AFTER", "CAIN_AS"):
        if k not in more:
            env.pop(k, None)
    if after is not None:
        env["STUB_AFTER"] = after
    # Run from a file with plain line ends: a long script passed whole on Windows' command line can
    # lose a quote on its way to Git Bash (never on the Pi or the CI runner).
    script = tmp_path / "checkin.sh"
    script.write_text((CAIN / "rootfs/opt/cain/checkin.sh").read_text(encoding="utf-8").replace("\r\n", "\n"),
                      encoding="utf-8", newline="\n")
    size = lambda: sent.stat().st_size if sent.exists() else 0
    before = size()
    for _ in range(runs or 2):
        r = subprocess.run([bash, script.as_posix()], env=env, timeout=60, capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        assert r.returncode == 0, (r.returncode, r.stdout[-600:], r.stderr[-600:])
        if runs is None and size() > before:
            break
    return sent.read_text(encoding="utf-8") if sent.exists() else ""

IDLE = "> \n  ? for shortcuts            auto mode on"


def _typed(sent_line):
    """What a send-keys -l line typed, the try's own mark (eight hex digits in brackets) taken off."""
    text = sent_line.split(" -l ", 1)[1]
    assert re.match(r"\[[0-9a-f]{8}\] ", text), text
    return text[11:]


def _said(tmp_path, sent_line):
    """What Cain gets from a typed line: the line itself, or, for one naming a file of his (a text too
    long or unusual to type as it is), that file's text."""
    text = _typed(sent_line)
    m = re.search(r"too long(?: or unusual)? to type here.*?/from-app/(\S+?\.txt)\b", text)
    return (tmp_path / "from-app" / m.group(1)).read_text(encoding="utf-8").rstrip("\n") if m else text


def _in(tmp_path):
    """His transcript as the stand-in Claude Code wrote it: each line sent, its mark taken off."""
    f = tmp_path / "transcripts" / "session.jsonl"
    lines = f.read_text(encoding="utf-8").splitlines() if f.exists() else []
    return [re.sub(r'^\{"type":"user","message":\{"role":"user","content":"\[[0-9a-f]{8}\] (.*)"\}\}$', r"\1", l) for l in lines]


def test_checkin_ends_the_morning_prompt_with_the_security_watch_line(tmp_path):
    """Main's Cain 0.13.0 line (security/main.ts lines), on the branch's check-in (Cain 0.13.1): the
    morning prompt ends with it, the others carry only what the watch says for them."""
    stub = tmp_path / "bin"
    stub.mkdir()
    # The watch as checkin.sh runs it (bun <SECURITY_MAIN> lines <kind>): a stand-in that says its kind.
    (stub / "bun").write_text('#!/bin/bash\n[ "$2" = lines ] && echo "Security watch (nothing here acts): $3 line."\nexit 0\n',
                              encoding="utf-8", newline="\n")
    (stub / "bun").chmod(0o755)
    out = _checkin(tmp_path, "0712", IDLE, SECURITY_MAIN="watch.ts")
    said = [_said(tmp_path, l) for l in out.splitlines() if " -l " in l]
    assert any(t.rstrip().endswith("post Dane his one morning update. Security watch (nothing here acts): morning line.") for t in said), said


def test_checkin_fires_once_in_its_hour_and_only_when_cain_is_idle(tmp_path):
    out = _checkin(tmp_path, "0712", IDLE)
    assert "morning" in out and "Not a message from Dane" in out and "Enter" in out
    assert _checkin(tmp_path, "0730", IDLE) == out                 # once a day per slot
    assert "1230" in _checkin(tmp_path, "1240", IDLE).splitlines()[-2]


def test_checkin_lists_items_held_by_others_first(tmp_path):
    import json
    import os
    import shutil
    if not shutil.which("jq"):
        import pytest
        pytest.skip("no jq")
    # The record keeper's own holds file (/data/record-holds.json), holds under "holds".
    holds = tmp_path / "record-holds.json"
    holds.write_text(json.dumps({"holds": {
        "P33": {"holder": "laptop:9f2c", "for": "his chat", "branches": ["claude/x"],
                "taken": "2026-11-11T13:00:00Z", "renewed": "2026-11-11T13:00:00Z"},
        "P12": {"holder": "laptop:a1;rm -rf", "for": "his chat", "branches": []},
        "P41": {"holder": "cain", "for": "Build job", "branches": ["claude/y"]},
        "P4$(x)5": {"holder": "laptop:b2", "for": "his chat", "branches": []},
    }, "waiting": [], "downtime": []}))
    os.environ["HOLDS_FILE"] = str(holds)
    try:
        out = _checkin(tmp_path, "0712", IDLE)
        line = out.splitlines()[-2]
        assert _typed(line).startswith("Held by others, skip these: P12, P33, P4x5. Scheduled check-in")
        assert "P41" not in line and "laptop" not in line and "$(" not in line
        (tmp_path / "sent.txt").unlink()
        holds.write_text('{"holds": {}, "waiting": [], "downtime": []}')
        assert "Held by others" not in _checkin(tmp_path, "1240", IDLE)
        (tmp_path / "sent.txt").unlink()
        holds.write_text("{broken")
        assert "holds file can't be read" in _checkin(tmp_path, "1740", IDLE)
    finally:
        del os.environ["HOLDS_FILE"]
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    out = _checkin(fresh, "0712", IDLE)                         # no holds file yet: nothing said
    assert "Scheduled check-in" in out and "Held by others" not in out and "can't be read" not in out


def test_checkin_lists_new_notes_on_cains_items_once_newest_first(tmp_path):
    # Against the record keeper's own `record.sh notes -` and its notes files.
    import json
    import os
    import shutil
    if not shutil.which("jq"):
        import pytest
        pytest.skip("no jq")
    rec = tmp_path / "record"
    (rec / "state" / "notes").mkdir(parents=True)

    def notes(item, rows):   # as the keeper's addNote writes them
        f = rec / "state" / "notes" / f"{item}.md"
        nl = chr(10)
        head = nl.join([f"# Notes on {item}", "", f"Words about {item} for whoever holds it, oldest first, filed by "
                        f"the record keeper from note requests. Its holder reads new ones before changing {item}.", "",
                        "| When | From | Note |", "|---|---|---|", ""])
        body = "".join(f"| {w} | {by} | {t} |{nl}" for w, by, t in rows)
        f.write_text((f.read_text() if f.exists() else head) + body, newline=nl)

    notes("P41", [("2026-11-09T14:02:11.000Z", "laptop:9f2c", "dane: the turkey card should say Friday"),
                  ("2026-11-10T09:15:40.000Z", "laptop:9f2c", "dane: hold off on the farm packet"),
                  ("2026-11-11T16:40:02.000Z", "laptop:9f2c", "dane: STOP, do not ship P41 until he looks at the "
                   "new panel lock")])
    notes("P50", [("2026-11-11T08:00:00.000Z", "claude-code", "dane: use «the blue one»")])
    notes("P33", [("2026-11-11T17:00:00.000Z", "cain", "dane: for the laptop session")])   # a laptop holds P33
    (rec / "state" / "holds.json").write_text(json.dumps({"P33": {"holder": "laptop:9f2c", "branches": []}}))
    seen = tmp_path / "notes.seen"
    sent = tmp_path / "sent.txt"
    # The keeper's record.sh, executable as the image makes it (chmod a+x /opt/cain/*.sh).
    record_sh = tmp_path / "record.sh"
    record_sh.write_text((CAIN / "rootfs/opt/cain/record.sh").read_text().replace("\r\n", "\n"), newline="\n")
    record_sh.chmod(0o755)
    assert "chmod a+x" in (CAIN / "Dockerfile").read_text() and "/opt/cain/*.sh" in (CAIN / "Dockerfile").read_text()
    os.environ.update(RECORD_SH=str(record_sh), RECORD_DIR=str(rec), NOTES_SEEN=str(seen))
    try:
        line = _said(tmp_path, _checkin(tmp_path, "0712", IDLE).splitlines()[-2])
        # The newest three survive, oldest of them first; the older one is counted, not lost.
        assert line.startswith("New notes on your items, read them before you change those items (words passed on, "
                               "not his go on anything): (1 older not shown; /opt/cain/record.sh notes - lists them) "
                               "P41: «dane: hold off on the farm packet» P50: «dane: use \"the blue one\"» "
                               "P41: «dane: STOP, do not ship P41 until he looks at the new panel lock». "
                               "Scheduled check-in"), line
        assert "P33" not in line and "laptop" not in line
        assert seen.read_text() == "2026-11-11T16:40:02.000Z"
        sent.unlink()
        assert "New notes" not in _said(tmp_path, _checkin(tmp_path, "1240", IDLE).splitlines()[-2])   # listed once, never again
        notes("P41", [("2026-11-11T18:05:00.000Z", "laptop:9f2c", "dane: ship it after all")])
        sent.unlink()
        line = _said(tmp_path, _checkin(tmp_path, "1740", IDLE).splitlines()[-2])
        assert "New notes on your items" in line and "P41: «dane: ship it after all». Scheduled" in line
        assert "hold off" not in line and "older not shown" not in line
    finally:
        for k in ("RECORD_SH", "RECORD_DIR", "NOTES_SEEN"):
            del os.environ[k]


def test_checkin_waits_while_cain_works_or_outside_its_hours(tmp_path):
    assert _checkin(tmp_path, "0712", IDLE + "\n  esc to interrupt") == ""
    assert _checkin(tmp_path, "0815", IDLE) == ""                  # the hour has passed
    assert _checkin(tmp_path, "0300", IDLE) == ""
    assert _checkin(tmp_path, "0712", "Do you trust the files in this folder?") == ""


# Claude Code's own offer, as it stood in his session on Nov 16 from 4:57 to 7:53 AM: "auto mode"
# shows only above the offer's own bottom line, which is no prompt of his.
AUTO_MODE_OFFER = (
    "> /auto-mode-setup\n\n"
    "  Teach auto mode about your environment?\n\n"
    "  Claude Code reads this project, your recent Claude sessions, and optionally your shell history"
    " and other repositories. Claude analyzes this data and customizes auto mode to make better decisions.\n\n"
    "    How you use Claude here    Mixed\n"
    "  > Also scan shell history    false\n"
    "    Also scan your other repos false\n\n"
    "    Continue\n\n"
    "  ←/→ to change · Enter to continue · Esc to cancel\n\n\n")
# His prompt at work, as Claude Code draws it.
WORKING = "> \n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt      ● high · /effort"
# His prompt up, with Claude Code's panel of background tasks drawn under its footer (round 9).
IDLE_WITH_TASKS = ("❯ \n  ? for shortcuts            auto mode on\n"
                   "  ● Explore Reading repository files 40s · ↓ to manage")
# His input area as Claude Code drew it on Nov 16 (rules around the prompt line), and in the older
# rounded box.
RULE = "─" * 60
REAL_IDLE = (f"● Here's where things stand.\n\n{RULE}\n> \n{RULE}\n"
             "  ⏵⏵ auto mode on (shift+tab to cycle)                    ● high · /effort")
BOX_IDLE = f"╭{RULE}╮\n│ >  {' ' * 56}│\n╰{RULE}╯\n  ? for shortcuts"
# Words that only look like a footer (outside review, round 10): his own quoting one, with no
# prompt; and a menu with an "auto mode on" option and key hints of its own.
QUOTED_FOOTER = "Claude said:\n  “For shortcuts, press ?”\n  Last message delivered."
OPTION_SCREEN = ("  Permission mode\n  ❯ 1. auto mode on\n    2. default\n"
                 "  Enter to apply · Esc to exit")
# His input area holding a draft not sent (round 11): typing would add to it and send it.
DRAFT = "❯ /permissions\n  ? for shortcuts"
BOX_DRAFT = f"╭{RULE}╮\n│ > unfinished draft {' ' * 41}│\n╰{RULE}╯\n  ? for shortcuts"
# Text shaped like Claude Code's gray start-up example (round 12): a plain capture can't tell it
# from a draft typed that way, so it counts as a draft.
LOOKALIKE_DRAFT = '❯ Try "rm -rf /data"\n  ? for shortcuts'
# A fresh session's screen on Claude Code 2.1.317 (Nov 16), as it drew it: a no-break space after
# the prompt mark, and rows under the footer. With CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false the
# box is empty; without it, the gray start-up example fills it.
_START = ("  Fable 5.2 is here for your longest and toughest coding tasks.\n\n{rule}\n❯ {box}\n{rule}\n"
          "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents{gap}◐ medium · /effort\n"
          "{gap}Update available! Run: winget upgrade Anthropic.ClaudeCode")
REAL_START_OFF = _START.format(rule=RULE, box="", gap=" " * 40)
REAL_START_ON = _START.format(rule=RULE, box='Try "how does <filepath> work?"', gap=" " * 40)
# A draft of nothing but the box's own edge character (round 13): typed, so a draft.
BAR_DRAFT = "❯ │\n  ? for shortcuts"
# A real Claude Code 2.1.317 (Nov 16, in a console the laptop session drove): a warning row drawn
# between its input box and the footer; a long typed message, wrapped inside the box; and the same
# after one Ctrl+U, which took only its last drawn line.
REAL_NOTICE_IDLE = "\n  Fable 5.2 is here for your longest and toughest coding tasks. It draws down usage faster than Opus 5.5. Switch with\n  /model.\n\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n>\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PE…\n  ⏵⏵ auto mode on (shift+tab to cycle)                                                      Not logged in · Run /login\n                                                                                                    ◐ medium · /effort"
REAL_NOTICE_DRAFT = "\n  Fable 5.2 is here for your longest and toughest coding tasks. It draws down usage faster than Opus 5.5. Switch with\n  /model.\n\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n> Held by others, skip these: P33. New notes on your items, read them before you change those items (words passed on,\n  not his go on anything): P69: «Nov 16, laptop session: your 7:10 check-in never reached you. The offer opened in\n  your session at 4:57 AM, and the App took it for your prompt, so your taps went into it...». Scheduled check-in from\n  the Cain add-on (1230). Not a message from the owner, and not his go on anything. Follow the Check-ins section of your\n  CLAUDE.md. Post to the owner only if something finished or needs his decision.\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PE…\n  ⏵⏵ auto mode on (shift+tab to cycle)                                                      Not logged in · Run /login"
REAL_NOTICE_HALF = "\n  Fable 5.2 is here for your longest and toughest coding tasks. It draws down usage faster than Opus 5.5. Switch with\n  /model.\n\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n> Held by others, skip these: P33. New notes on your items, read them before you change those items (words passed on,\n  not his go on anything): P69: «Nov 16, laptop session: your 7:10 check-in never reached you. The offer opened in\n  your session at 4:57 AM, and the App took it for your prompt, so your taps went into it...». Scheduled check-in from\n  the Cain add-on (1230). Not a message from the owner, and not his go on anything. Follow the Check-ins section of your\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PE…\n  ⏵⏵ auto mode on (shift+tab to cycle)                                                      Not logged in · Run /login\n                                                                                          Ctrl+Y to paste deleted text"
# A real Claude Code 2.1.317 (Nov 16, a console at 60 columns the laptop session drove): a text with
# wide and joined characters typed into his box (its emoji read back from the console as a stand-in
# character), and, after an Enter, the line sent shown above his empty input box while he works.
REAL_UNUSUAL_DRAFT = ' ▐▛███▛█   Claude Code v2.1.317\n▝▜██████▀  Opus 5.5 · API Usage Billing\n ▝▝   ▝▝   ~\\Claude\\personal-harness\n\n\n────────────────────────────────────────────────────────────\n>\xa0[a1b2c3] Relayed by the add-on: Dane tapped «Ship» on\n  the card “Install Cain’s update — café naïve” ✓ 日本語\n  � and then a long word: abcdefghijklmnopqrstuvwxyzabcde\n  fghijklmnopqrstuvwxyzabcdefghij end.\n────────────────────────────────────────────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n                                Not logged in · Run /login'
REAL_SENT = ' ▐▛███▛█   Claude Code v2.1.317\n▝▜██████▀  Opus 5.5 · API Usage Billing\n ▝▝   ▝▝   ~\\Claude\\personal-harness\n\n\n> [ba6e8f] hello there, this is a test line that goes\n  nowhere\n\n✽ Osmosing… (running UserPromptSubmit hook · 0s)\n\n────────────────────────────────────────────────────────────\n>\n────────────────────────────────────────────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt\n                                Not logged in · Run /login'
# What the App types, longer than a line, in his input box as Claude Code draws it: from the prompt
# line under the top border down to the bottom border (Cain's third service review: Enter only on
# this).
LONG_DRAFT = (f"● Done.\n\n{RULE}\n❯ Relayed by the add-on: Dane tapped \"Ship\" on the card for\n"
              f"  the update, a line long enough to go on\n{RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)")
BOX_LONG_DRAFT = (f"╭{RULE}╮\n│ > Relayed by the add-on: Dane tapped \"Ship\" on the card {' ' * 3}│\n"
                  f"│   for the update {' ' * 41}│\n╰{RULE}╯\n  ? for shortcuts")
BOX_BAR_DRAFT = f"╭{RULE}╮\n│ > │ {' ' * 54}│\n╰{RULE}╯\n  ? for shortcuts"


def _prompt_state(screen, **env):
    import shutil
    import subprocess
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("no bash")
    out = subprocess.run([bash, (CAIN / "rootfs/opt/cain/prompt-state.sh").as_posix()], input=screen,
                         capture_output=True, text=True, encoding="utf-8", timeout=20, env={**os.environ, **env})
    assert out.returncode == 0
    return out.stdout.strip()


def test_prompt_state_reads_his_prompt_and_a_screen_waiting_for_an_answer():
    """prompt-state.sh: ready only when his input area is on screen by its shape: a line starting
    with Claude Code's footer, right under the prompt line (borders between), in the bottom lines,
    with no dialog's key hints below it. Rows under the footer (background tasks) don't matter;
    words that only look like a footer or a hint count for nothing. Never fails."""
    for screen in (IDLE, WORKING, IDLE_WITH_TASKS, REAL_IDLE, BOX_IDLE, REAL_START_OFF, REAL_NOTICE_IDLE,
                   "To stop it, press Esc to cancel.\n" + IDLE):
        assert _prompt_state(screen) == "ready", screen
    for screen in (DRAFT, BOX_DRAFT, LOOKALIKE_DRAFT, REAL_START_ON, BAR_DRAFT, BOX_BAR_DRAFT,
                   "❯ ││\n  ? for shortcuts", "> Try this instead\n  ? for shortcuts", LONG_DRAFT, BOX_LONG_DRAFT, REAL_NOTICE_DRAFT, REAL_NOTICE_HALF,
                   "❯ x \n  ? for shortcuts"):
        assert _prompt_state(screen) == "draft", screen                             # a draft not sent
    # Words above a footer with no prompt line holding text over them, under a top border: no draft.
    assert _prompt_state(f"  Notes:\n{RULE}\n  ? for shortcuts") == "other"
    assert _prompt_state(f"{RULE}\n> \n  some words\n{RULE}\n  ? for shortcuts") == "other"
    assert _prompt_state(f"❯ words\n  more words\n{RULE}\n  ? for shortcuts") == "other"   # no top border
    assert _prompt_state(f"{RULE}\n> \n  a warning\n  ? for shortcuts") == "other"      # a row, no border under the box
    assert _prompt_state(f"{RULE}\n> \n{RULE}\n  one\n  two\n  three\n  four\n  ? for shortcuts") == "other"   # over three
    assert _prompt_state(AUTO_MODE_OFFER) == "dialog"
    # The whole of a draft (PROMPT_DRAFT_TEXT), one drawn line a line, case and the spaces within kept:
    # on the real screen, joined by single spaces, exactly what was typed; after one Ctrl+U, only its
    # start (outside review, rounds 17 and 18).
    typed = ("Held by others, skip these: P33. New notes on your items, read them before you change those items (words "
             "passed on, not his go on anything): P69: «Nov 16, laptop session: your 7:10 check-in never reached you. The "
             "offer opened in your session at 4:57 AM, and the App took it for your prompt, so your taps went into it...». "
             "Scheduled check-in from the Cain add-on (1230). Not a message from the owner, and not his go on anything. "
             "Follow the Check-ins section of your CLAUDE.md. Post to the owner only if something finished or needs his "
             "decision.")
    whole = _prompt_state(REAL_NOTICE_DRAFT, PROMPT_DRAFT_TEXT="1").split("\n")
    assert whole[0] == "draft" and " ".join(whole[1:]) == typed and len(whole) == 6
    part = " ".join(_prompt_state(REAL_NOTICE_HALF, PROMPT_DRAFT_TEXT="1").split("\n")[1:])
    assert typed.startswith(part) and len(part) < len(typed)
    assert _prompt_state(BOX_LONG_DRAFT, PROMPT_DRAFT_TEXT="1").split("\n")[1:] == \
        ['Relayed by the add-on: Dane tapped "Ship" on the card', "for the update"]
    # Only what the box draws comes off: a bar ending a draft outside a box stays, spaces within stay.
    assert _prompt_state("❯ a  draft ending in │\n  ? for shortcuts", PROMPT_DRAFT_TEXT="1").split("\n")[1] == "a  draft ending in │"
    for screen, first in ((REAL_NOTICE_DRAFT, "held by others, skip these: p33."), (BOX_LONG_DRAFT, "relayed by the add-on:"),
                          (DRAFT, "/permissions"), (LONG_DRAFT, "relayed by the add-on: dane tapped")):
        out = _prompt_state(screen, PROMPT_DRAFT_LINE="1").split("\n")
        assert out[0] == "draft" and out[1].startswith(first), (screen, out)
    assert _prompt_state(IDLE, PROMPT_DRAFT_LINE="1") == "ready"                     # nothing more when empty
    assert _prompt_state("He said: auto mode on, ? for shortcuts.\n" + AUTO_MODE_OFFER) == "dialog"
    assert _prompt_state("  Select model\n  > Opus\n  Enter to confirm · Esc to exit") == "dialog"
    assert _prompt_state(OPTION_SCREEN) == "dialog"
    assert _prompt_state("> \n  ? for shortcuts  Esc to cancel") == "dialog"      # both on one line: no
    assert _prompt_state(QUOTED_FOOTER) == "other"                                  # no input area
    assert _prompt_state("  Notes:\n  ? for shortcuts, see the docs") == "other"   # no prompt above it
    assert _prompt_state("> \n  some words\n  ? for shortcuts") == "other"         # not right under it
    assert _prompt_state("  ⏵⏵ auto mode on (shift+tab to cycle)") == "other"
    assert _prompt_state(IDLE + "\n" + "\n".join(f"line {i}" for i in range(12))) == "other"   # footer gone by
    assert _prompt_state("") == "other" and _prompt_state("\n  \n") == "other"
    assert _prompt_state("Welcome to Claude Code\n Select login method:") == "other"


def test_prompt_state_shows_what_was_sent_above_his_input_box():
    """PROMPT_ABOVE (Cain's fourth service review, must-fix 1): every line above his input box, as drawn,
    its top border left out, never the box itself: where Claude Code shows a line once it's sent. On a
    real Claude Code 2.1.317 screen half a second after an Enter: the line sent, with its mark, above
    his empty box while he works."""
    out = _prompt_state(REAL_SENT, PROMPT_ABOVE="1").split("\n")
    assert out[0] == "ready" and "> [ba6e8f] hello there, this is a test line that goes" in out
    assert "─" * 60 not in out and ">" not in out
    assert _prompt_state(REAL_SENT) == "ready"
    out = _prompt_state(REAL_UNUSUAL_DRAFT, PROMPT_ABOVE="1").split("\n")
    assert out[0] == "draft" and not any("[a1b2c3]" in l for l in out)          # the box itself is never above
    assert _prompt_state(AUTO_MODE_OFFER, PROMPT_ABOVE="1") == "dialog"           # no box: nothing above


def test_checkin_never_types_into_a_screen_waiting_for_an_answer(tmp_path):
    """Nov 16: Claude Code's auto mode offer said "auto mode" in its own text, the check took it for
    his prompt, and his taps, the cloud job checks and the morning check-in went into the offer,
    each with an Enter, for three hours. Now only his prompt lets anything be typed (prompt-state.sh),
    and his taps wait for it, as the check-in does within its hour."""
    import os
    import shutil
    for screen in (AUTO_MODE_OFFER, QUOTED_FOOTER, OPTION_SCREEN, DRAFT, BOX_DRAFT, LOOKALIKE_DRAFT,
                   BAR_DRAFT, BOX_BAR_DRAFT, WORKING):
        assert _checkin(tmp_path, "0712", screen) == "", screen       # (WORKING: at work, later)
    assert list((tmp_path / "done").glob("*")) == []                  # the morning one still to come
    out = _checkin(tmp_path, "0712", "To stop it, press Esc to cancel.\n" + IDLE_WITH_TASKS)
    assert "morning" in out and "Enter" in out                        # back at his prompt: it goes in
    if shutil.which("jq"):
        q = tmp_path / "relay.queue"
        q.write_text('{"text": "Dane tapped \\"Ship\\""}\n', newline="\n")
        os.environ["RELAY_QUEUE"] = str(q)
        try:
            (tmp_path / "sent.txt").unlink()
            for screen in (AUTO_MODE_OFFER, DRAFT, BOX_DRAFT, LOOKALIKE_DRAFT, BAR_DRAFT):   # his tap waits,
                assert _checkin(tmp_path, "0712", screen) == "", screen
                assert q.exists() and not (tmp_path / "relay.queue.work").exists()   # untouched
            assert 'Dane tapped "Ship"' in _checkin(tmp_path, "0712", IDLE)
        finally:
            del os.environ["RELAY_QUEUE"]


def test_the_status_page_tells_a_waiting_screen_from_his_prompt():
    """The panel's /status reads the screen as checkin.sh does (prompt-state.sh, Nov 16): ready only
    at his prompt, a dialog for a screen waiting for an answer. Its loop runs under errexit and
    pipefail, and an empty capture (no session, tmux down) leaves it running (round 9)."""
    import shutil
    import subprocess
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("no bash")
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text().replace("\r\n", "\n")
    block = _run_fns(run, "    last=$(printf '%s\\n' \"$screen\" | tail -n 30)", "    printf '{\"signed_in\"")
    opt = (CAIN / "rootfs/opt/cain").as_posix()

    def state(screen):
        script = f'set -o errexit -o nounset -o pipefail\nOPT="{opt}"\nscreen="$1"\n' + block + 'echo "$state"\n'
        out = subprocess.run([bash, "-c", script, "state", screen],
                             capture_output=True, text=True, encoding="utf-8", timeout=20)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()
    assert state(AUTO_MODE_OFFER) == "dialog"
    assert state(IDLE) == "ready" and state(WORKING) == "ready" and state(IDLE_WITH_TASKS) == "ready"
    assert state("Earlier he said auto mode was on.\n\n  Choose an option\n  > Yes") == "unknown"
    assert state("Invalid API key · Please run /login") == "login_needed"
    assert state("") == "unknown" and state("\n \n") == "unknown"      # and the loop goes on


def _unstick(tmp_path, now, screen, **more):
    """unstick.sh once, at `now`, with his screen as given: the real screen readers, a stand-in tmux
    that notes the keys sent, and a stand-in notice.sh that notes its calls ($NOTICE_RC its answer).
    Returns what it printed ("restart" or nothing)."""
    import shutil
    import subprocess
    bash = shutil.which("bash")
    if not bash or not shutil.which("jq"):
        pytest.skip("no bash or jq")
    stub, opt = tmp_path / "bin", tmp_path / "opt"
    if not opt.exists():
        stub.mkdir()
        opt.mkdir()
        (stub / "tmux").write_text(
            '#!/bin/bash\n'
            'if [ "$2" = display ]; then case "$*" in *pane_pid*) echo "${STUB_PID:-4242}" ;; *) echo 120 ;; esac; exit 0; fi\n'
            'if [ "$2" = capture-pane ]; then [ -z "${STUB_DOWN:-}" ] || exit 1\n'
            '  [ -z "${STUB_HANG:-}" ] || exec sleep 20\n'
            '  if [ -f "$STUB_CLEARED" ]; then printf "%s\\n" "${STUB_AFTER_CLEAR:-$STUB_SCREEN}"; else printf "%s\\n" "$STUB_SCREEN"; fi\n'
            '  exit 0; fi\nprintf "%s\\n" "$*" >> "$STUB_SENT"\n'
            '[ -z "${STUB_KEYS_FAIL:-}" ] || exit 1\n'
            'case "$*" in *" C-u"*) [ -z "${STUB_AFTER_CLEAR:-}" ] || touch "$STUB_CLEARED" ;; esac\n', newline="\n")
        (opt / "notice.sh").write_text('#!/bin/bash\necho "$NOTICE_LOCK_S $*" >> "$STUB_NOTICE"\nexit "${NOTICE_RC:-0}"\n', newline="\n")
        for f in ("prompt-state.sh", "unstick.sh", "typing.sh"):
            (opt / f).write_text((CAIN / "rootfs/opt/cain" / f).read_text(encoding="utf-8").replace("\r\n", "\n"),
                                 encoding="utf-8", newline="\n")
        for f in (stub / "tmux", *opt.iterdir()):
            f.chmod(0o755)
        (tmp_path / "checked").write_text("4242\n", newline="\n")
    env = dict(os.environ, PATH=f"{stub}{os.pathsep}{os.environ['PATH']}", UNSTICK_OPT=opt.as_posix(),
               UNSTICK_DIR=(tmp_path / "state").as_posix(), RELAY_QUEUE=(tmp_path / "queue").as_posix(),
               UNSTICK_NOW=str(now), STUB_SCREEN=screen, STUB_SENT=(tmp_path / "sent").as_posix(),
               STUB_NOTICE=(tmp_path / "notice").as_posix(), PROMPT_STATE=(opt / "prompt-state.sh").as_posix(),
               SESSION_CHECKED=(tmp_path / "checked").as_posix(), CHECKIN_TRY=(tmp_path / "checkin.try").as_posix(),
               CAIN_FROM_APP=(tmp_path / "from-app").as_posix(), STUB_CLEARED=(tmp_path / "cleared").as_posix(),
               UNSTICK_PAUSE_S="0")
    env.pop("CAIN_AS", None)
    env.update(more)
    out = subprocess.run([bash, (opt / "unstick.sh").as_posix()], env=env, capture_output=True, text=True,
                         encoding="utf-8", timeout=30)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


def test_a_question_no_one_answers_is_closed_and_then_his_session_starts_fresh(tmp_path):
    """unstick.sh (Nov 16: Claude Code's offer to set up auto mode sat on his screen from 4:57 to 7:53
    AM, and nothing reached him): a question that has waited 5 minutes gets one Esc and a line for
    Cain; still there 5 minutes after the Esc, his session starts fresh (the run script ends it on
    "restart"), with a line telling him to read what Dane sent meanwhile. At most one fresh start an
    hour: one that would come sooner tells Dane instead, once, and the fresh start waits for the
    hour. His prompt back 5 minutes takes the alarm down, once a stretch. Nothing ever goes into
    his prompt, a draft, a sign-in or a screen it can't read; a gap of over a minute counts again."""
    import json
    read = lambda f: (tmp_path / f).read_text(encoding="utf-8").splitlines() if (tmp_path / f).exists() else []
    lines = lambda: [json.loads(l)["text"] for l in read("queue")]
    t = 1_000_000
    run = lambda dt, screen=AUTO_MODE_OFFER, **more: _unstick(tmp_path, t + dt, screen, **more)

    # His prompt, working or not, a draft, a sign-in, an unreadable screen: nothing, however long.
    for screen in (IDLE, WORKING, DRAFT, "Paste code here if prompted >\n  Esc to cancel",
                   "  Select login method:\n  ❯ 1. Claude account with subscription\n  Enter to confirm · Esc to cancel"):
        assert [run(dt, screen) for dt in (0, 400, 800)] == ["", "", ""], screen
    assert run(900, STUB_DOWN="1") == "" and read("sent") == [] and lines() == []
    assert not [c for c in read("notice") if "tell" in c]          # at most a clearing of nothing raised
    (tmp_path / "notice").unlink(missing_ok=True)

    # A question: nothing for 5 minutes, then one Esc and a line for Cain.
    t += 2000
    assert [run(dt) for dt in (0, 50, 100, 150, 200, 250)] == [""] * 6 and read("sent") == []
    assert run(300) == "" and read("sent") == ["-u send-keys -t cain Escape"]
    assert len(lines()) == 1 and "pressed Esc" in lines()[0] and "Ask him things in Discord" in lines()[0]
    assert lines()[0].endswith("Nothing to tell him.") and "—" not in lines()[0]
    # Still there: no second Esc, and 5 minutes after the Esc, his session starts fresh.
    assert [run(dt) for dt in (350, 400, 450, 500, 550)] == [""] * 5 and len(read("sent")) == 1
    assert run(600) == "restart" and len(read("sent")) == 1
    assert "started fresh" in lines()[-1] and "fetch_messages" in lines()[-1] and read("notice") == []

    # It comes back after the fresh start: counted again from its first sight, Esc at 5 minutes;
    # 5 minutes on, within the hour of the fresh start, Dane hears once and nothing restarts.
    assert [run(dt) for dt in (650, 700, 750, 800, 850, 900)] == [""] * 6 and len(read("sent")) == 1
    assert run(950) == "" and len(read("sent")) == 2
    assert [run(dt) for dt in (1000, 1050, 1100, 1150, 1200)] == [""] * 5 and read("notice") == []
    assert run(1250) == "" and read("notice") == ["5 tell waiting"]
    assert [run(dt) for dt in (1300, 1350)] == ["", ""] and read("notice") == ["5 tell waiting"]
    # The hour since the fresh start is up: the next one.
    assert run(1400, UNSTICK_GAP_S="5000") == "" and run(4199, UNSTICK_GAP_S="5000") == ""
    assert run(4200, UNSTICK_GAP_S="5000") == "restart"

    # His prompt back: the alarm comes down after 5 minutes of it, once in that stretch.
    assert [run(dt, IDLE) for dt in (4300, 4500, 4599)] == ["", "", ""] and read("notice") == ["5 tell waiting"]
    assert run(4600, IDLE) == "" and read("notice")[-1] == "5 clear screen"
    assert run(4900, IDLE) == "" and len(read("notice")) == 2
    # A clearing that couldn't have the lock is tried again; once through, not again.
    assert run(5000, DRAFT) == "" and run(5010, IDLE) == "" and run(5310, IDLE, NOTICE_RC="75") == ""
    assert run(5320, IDLE) == "" and run(5330, IDLE) == "" and read("notice")[-3:] == ["5 clear screen"] * 3

    # A question that goes and another that comes: the new one gets its own 5 minutes and its own
    # Esc, never the old one's count (outside review, round 1).
    t += 10_000
    assert [run(dt) for dt in (0, 50, 100, 150, 200, 250)] == [""] * 6
    sent = len(read("sent"))
    assert run(300) == "" and len(read("sent")) == sent + 1                      # Esc for the first
    assert run(310, IDLE) == "" and run(320) == ""                                # gone; another
    assert [run(dt) for dt in (370, 420, 470, 520, 570, 600)] == [""] * 6 and len(read("sent")) == sent + 1
    assert run(620) == "" and len(read("sent")) == sent + 2                      # its own Esc
    assert run(920, UNSTICK_GAP_S="5000") == "restart"

    # A gap of over a minute between waiting screens starts the count again: no Esc at 5 minutes.
    t += 10_000
    assert [run(dt) for dt in (0, 50, 100)] == ["", "", ""] and run(170, IDLE) == ""
    sent = len(read("sent"))
    assert [run(dt) for dt in (240, 290, 340, 390, 440, 490)] == [""] * 6 and len(read("sent")) == sent
    assert run(540) == "" and len(read("sent")) == sent + 1


def test_the_way_out_of_a_question_holds_when_its_own_steps_fail(tmp_path):
    """unstick.sh, outside review round 1: an Esc that can't be sent still leads on to a fresh start;
    a hung tmux never holds it (or the run script's loop) past its bound; a step whose state can't
    be kept isn't taken, and Dane hears instead, so no limit is skipped and no Esc repeats; a
    sign-in on screen now is left alone, but old sign-in words above a question aren't."""
    import json
    import time
    read = lambda f: (tmp_path / f).read_text(encoding="utf-8").splitlines() if (tmp_path / f).exists() else []
    t = 2_000_000
    run = lambda dt, screen=AUTO_MODE_OFFER, **more: _unstick(tmp_path, t + dt, screen, UNSTICK_GAP_S="5000", **more)

    # Esc can't be sent: the try is kept all the same, and 5 minutes on, the fresh start.
    assert run(0, STUB_KEYS_FAIL="1") == "" and run(300, STUB_KEYS_FAIL="1") == ""
    assert read("sent") == ["-u send-keys -t cain Escape"] and read("queue") == []
    assert run(599, STUB_KEYS_FAIL="1") == "" and run(600, STUB_KEYS_FAIL="1") == "restart"
    # A hung tmux: bounded, nothing known, nothing done.
    began = time.monotonic()
    assert run(700, STUB_HANG="1", UNSTICK_TMUX_S="1") == "" and time.monotonic() - began < 15
    # The hourly limit can't be read (its file is a directory): no fresh start; Dane hears, once.
    state = tmp_path / "state"
    (state / "restarted").unlink()
    (state / "restarted").mkdir()
    assert [run(dt) for dt in (1000, 1300, 1600)] == ["", "", ""] and read("notice") == ["5 tell waiting"]
    assert run(1700) == "" and read("notice") == ["5 tell waiting"]
    (state / "restarted").rmdir()
    # The Esc's own mark can't be kept: no Esc goes (nothing could stop it repeating); Dane hears.
    for f in ("since", "seen", "esc", "told"):
        (state / f).unlink(missing_ok=True)
    (state / "esc").mkdir()
    sent = len(read("sent"))
    assert [run(dt) for dt in (2000, 2300, 2310, 2320)] == ["", "", "", ""] and len(read("sent")) == sent
    assert read("notice") == ["5 tell waiting"] * 2
    (state / "esc").rmdir()

    # Three questions closed with Esc within an hour tell Dane (the sign-in's own 15 minutes: a test
    # of its own, below).
    t += 10_000
    (state / "told").unlink(missing_ok=True)
    told = len(read("notice"))
    sent = len(read("sent"))
    for start in (0, 1000):
        assert run(start) == "" and run(start + 300) == "" and run(start + 310, IDLE) == ""
    assert run(2000) == "" and run(2300) == ""
    assert len(read("sent")) == sent + 3 and read("notice")[told:] == ["5 tell waiting"]
    # A count's history that isn't times, one a line: Dane hears at the next Esc (outside round 17).
    t += 10_000
    (state / "told").unlink(missing_ok=True)
    (state / "escs").write_text("12345\nnot a time\n")
    told = len(read("notice"))
    assert run(0, IDLE) == "" and run(10) == "" and run(310) == "" and read("notice")[told:] == ["5 tell waiting"]
    # An empty one too: it's never written empty, so one was cut (outside round 18).
    (state / "told").unlink(missing_ok=True)
    (state / "escs").write_text("")
    told = len(read("notice"))
    assert run(400, IDLE) == "" and run(410) == "" and run(710) == "" and read("notice")[told:] == ["5 tell waiting"]
    # No place for its state: a question on screen is told at once, and taken down at his prompt.
    (tmp_path / "file").write_text("x")
    nowhere = (tmp_path / "file" / "state").as_posix()
    told = len(read("notice"))
    assert run(3000, UNSTICK_DIR=nowhere) == "" and read("notice")[told:] == ["5 tell waiting"]
    assert run(3010, IDLE, UNSTICK_DIR=nowhere) == "" and read("notice")[-1] == "5 clear screen"


def test_a_sign_in_screen_gets_its_esc_after_15_minutes_on_purpose(tmp_path):
    """Cain's fourth service review, must-fix 3: a screen like a sign-in or his folder's trust question
    gets its Esc after 15 minutes, not 5: a decision kept on purpose (unstick.sh says why), with a test
    of its own. If he's at the panel signing in, it's his to answer; if no one is, its Esc closes it,
    and a real sign-in stays known (the panel's status, its own alarm). A question with a sign-in's
    line just above it gets the 15 minutes too (outside round 16); a line like one in older output
    gives nothing."""
    read = lambda f: (tmp_path / f).read_text(encoding="utf-8").splitlines() if (tmp_path / f).exists() else []
    assert "a decision kept on purpose" in (CAIN / "rootfs/opt/cain/unstick.sh").read_text(encoding="utf-8")
    t = 4_000_000
    run = lambda dt, screen, **more: _unstick(tmp_path, t + dt, screen, UNSTICK_GAP_S="5000", **more)
    signin = "  Browser didn't open? Use the url below to sign in:\n  Paste code here if prompted >\n  Esc to cancel"
    trust = "  Do you trust the files in this folder?\n  ❯ 1. Yes, proceed\n    2. No, exit\n  Enter to confirm · Esc to cancel"
    for start, screen in ((0, signin), (2000, trust)):
        sent = len(read("sent"))
        assert [run(start + dt, screen) for dt in (0, 300, 600, 899)] == [""] * 4 and len(read("sent")) == sent
        assert run(start + 900, screen) == "" and read("sent")[sent:] == ["-u send-keys -t cain Escape"]
        assert run(start + 1000, IDLE) == ""
    near = "Paste code here if prompted >\nUsage limit options\n  ❯ 1. Continue\n  Enter to confirm · Esc to cancel"
    sent = len(read("sent"))
    assert [run(dt, near) for dt in (4000, 4300, 4899)] == ["", "", ""] and len(read("sent")) == sent
    assert run(4900, near) == "" and len(read("sent")) == sent + 1
    old = "Earlier output: Paste code here if prompted >\n"
    assert run(6000, IDLE) == "" and run(6010, old + AUTO_MODE_OFFER) == "" and run(6310, old + AUTO_MODE_OFFER) == ""
    assert len(read("sent")) == sent + 2


def test_an_esc_waits_for_his_screen_to_read_alike_twice(tmp_path):
    """Cain's fourth service review, fix soon 7: the Esc goes only when the screen reads as it did at the
    read before: a question still changing, or one someone is working in, isn't closed under them."""
    read = lambda f: (tmp_path / f).read_text(encoding="utf-8").splitlines() if (tmp_path / f).exists() else []
    t = 5_000_000
    other = AUTO_MODE_OFFER.replace("Mixed", "Some")
    assert [_unstick(tmp_path, t + dt, AUTO_MODE_OFFER) for dt in (0, 50, 100, 150, 200, 250)] == [""] * 6
    assert _unstick(tmp_path, t + 300, other) == "" and read("sent") == []          # changed: no Esc yet
    assert _unstick(tmp_path, t + 310, other) == "" and read("sent") == ["-u send-keys -t cain Escape"]


def test_the_way_out_sends_nothing_before_his_session_is_checked(tmp_path):
    """Cain's fourth service review, fix soon 10: no key (Esc, Ctrl+U) goes to a session that hasn't
    passed its check of his own user as it runs now: no mark, or the mark of another pane's process."""
    read = lambda f: (tmp_path / f).read_text(encoding="utf-8").splitlines() if (tmp_path / f).exists() else []
    t = 6_000_000
    assert [_unstick(tmp_path, t + dt, AUTO_MODE_OFFER, STUB_PID="9") for dt in (0, 300, 600, 900)] == [""] * 4
    assert [_unstick(tmp_path, t + dt, DRAFT, STUB_PID="9") for dt in (1000, 2000, 3000)] == [""] * 3
    (tmp_path / "checked").unlink()
    assert [_unstick(tmp_path, t + dt, AUTO_MODE_OFFER) for dt in (4000, 4300, 4600)] == [""] * 3
    assert read("sent") == [] and read("queue") == []


def test_the_way_out_saves_and_clears_a_draft_that_stays(tmp_path):
    """Cain's fourth service review, must-fix 2: a draft in his input box that isn't the App's own try,
    unchanged for 15 minutes, is saved in a file of his and cleared (Ctrl+U), and Cain is told; one
    that changes (someone typing) starts its count again; one Ctrl+U doesn't clear starts his session
    fresh, at most once an hour. The App's own try in his box is never touched here (checkin.sh's). A
    screen the App doesn't know, 15 minutes on, is saved and his session started fresh; a sign-in's
    isn't (it has its own alarm)."""
    import json
    read = lambda f: (tmp_path / f).read_text(encoding="utf-8").splitlines() if (tmp_path / f).exists() else []
    lines = lambda: [json.loads(l)["text"] for l in read("queue")]
    t = 8_000_000
    run = lambda dt, screen=DRAFT, **more: _unstick(tmp_path, t + dt, screen, **more)
    assert [run(dt) for dt in (0, 300, 899)] == ["", "", ""] and read("sent") == []
    assert run(900, STUB_AFTER_CLEAR=IDLE) == "" and read("sent") == ["-u send-keys -t cain" + " C-u" * 20]
    saved = sorted((tmp_path / "from-app").glob("draft-*.txt"))
    assert len(saved) == 1 and saved[0].read_text() == "/permissions\n"
    assert "A draft sat unsent in your input box for 15 minutes" in lines()[-1] and saved[0].name in lines()[-1]
    assert "answer him in Discord" in lines()[-1] and read("notice") == []
    # One that changes starts its count again.
    (tmp_path / "cleared").unlink()
    typing = "❯ /permissions and more\n  ? for shortcuts"
    assert run(1000) == "" and run(1500, typing) == "" and run(2300, typing) == "" and len(read("sent")) == 1
    # The App's own try: never touched here, however long.
    (tmp_path / "checkin.try").write_text("mark 1a2b3c4d\ntyped 1\nentered 0\nkind relay\nkey 1\nfin -\n"
                                          "want [1a2b3c4d] Relayed by the add-on: x\n", newline="\n")
    mine = "❯ [1a2b3c4d] Relayed by the add-on: x\n  ? for shortcuts"
    assert [run(dt, mine) for dt in (3000, 4000, 5000)] == ["", "", ""] and len(read("sent")) == 1
    (tmp_path / "checkin.try").unlink()
    # Ctrl+U doesn't clear it: his session starts fresh, once an hour.
    assert run(6000) == "" and run(6900) == "restart" and read("sent")[1:] == ["-u send-keys -t cain" + " C-u" * 20] * 3
    assert "Ctrl+U didn't clear your box, so your session was started fresh" in lines()[-1]
    assert run(7000) == "" and run(7900) == "" and len(lines()) == 2                 # within the hour: no more
    # A screen the App doesn't know: saved, and his session started fresh; a sign-in's: nothing.
    odd = "Some view the App doesn't know\n  with rows of its own"
    signin = "Welcome to Claude Code\n Select login method:"
    assert [run(dt, signin) for dt in (11000, 12000, 13000)] == ["", "", ""]
    assert run(14000, odd) == "" and run(14899, odd) == "" and run(14900, odd) == "restart"
    shot = sorted((tmp_path / "from-app").glob("screen-*.txt"))
    assert len(shot) == 1 and "Some view the App doesn't know" in shot[0].read_text() and shot[0].name in lines()[-1]
    assert "Your screen showed something the App doesn't know for 15 minutes" in lines()[-1]


def _watch(tmp_path, now, screen, **more):
    """watch.sh once, at `now`, with his screen as given: the real screen readers, a stand-in tmux and
    a stand-in notice.sh that notes its calls ($NOTICE_RC its answer). It prints nothing and exits 0."""
    import shutil
    import subprocess
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("no bash")
    stub, opt = tmp_path / "wbin", tmp_path / "wopt"
    if not opt.exists():
        stub.mkdir()
        opt.mkdir()
        (stub / "tmux").write_text('#!/bin/bash\nif [ "$2" = display ]; then case "$*" in *pane_pid*) echo 4242 ;; *) echo 120 ;; esac; exit 0; fi\n'
                                   'if [ "$2" = capture-pane ]; then printf "%s\\n" "$STUB_SCREEN"; exit 0; fi\nexit 0\n', newline="\n")
        (opt / "notice.sh").write_text('#!/bin/bash\necho "$*" >> "$STUB_NOTICE"\nexit "${NOTICE_RC:-0}"\n', newline="\n")
        for f in ("prompt-state.sh", "watch.sh", "typing.sh"):
            (opt / f).write_text((CAIN / "rootfs/opt/cain" / f).read_text(encoding="utf-8").replace("\r\n", "\n"),
                                 encoding="utf-8", newline="\n")
        for f in (stub / "tmux", *opt.iterdir()):
            f.chmod(0o755)
    env = dict(os.environ, PATH=f"{stub}{os.pathsep}{os.environ['PATH']}", WATCH_OPT=opt.as_posix(),
               WATCH_DIR=(tmp_path / "watch").as_posix(), RELAY_QUEUE=(tmp_path / "queue").as_posix(),
               CHECKIN_DIR=(tmp_path / "done").as_posix(), CHECKIN_DELIVERED=(tmp_path / "delivered").as_posix(),
               CHECKIN_TRY=(tmp_path / "try").as_posix(), WATCH_NOW=str(now), WATCH_HM="0300", WATCH_DAY="2026-11-16",
               STUB_SCREEN=screen, STUB_NOTICE=(tmp_path / "notice").as_posix(), PROMPT_STATE=(opt / "prompt-state.sh").as_posix())
    env.pop("CAIN_AS", None)
    env.update(more)
    out = subprocess.run([bash, (opt / "watch.sh").as_posix()], env=env, capture_output=True, text=True,
                         encoding="utf-8", timeout=30)
    assert out.returncode == 0 and out.stdout == "", (out.returncode, out.stdout, out.stderr)


def test_the_watchdog_tells_dane_when_nothing_goes_in(tmp_path):
    """watch.sh (Cain's fourth service review, must-fix 2): root's, outside his session. Something waits to
    go in and nothing has gone in for 30 minutes in which his screen was neither at work nor on a
    question (or 2 hours in all): Dane is told once (notice.sh tell stalled: his bot, root's own token,
    and Home Assistant's push), and once something goes in, told it's back (clear delivered). A draft
    that isn't the App's own try, unchanged, or a screen the App doesn't know, for 30 minutes: told
    too. A sign-in isn't (it has its own alarm). Nothing waiting counts nothing, and a gap between its
    reads counts a minute at most."""
    read = lambda: (tmp_path / "notice").read_text().splitlines() if (tmp_path / "notice").exists() else []
    t = 9_000_000
    w = lambda dt, screen=IDLE, **m: _watch(tmp_path, t + dt, screen, **m)
    step = {"WATCH_STEP_S": "600"}
    # Nothing waiting: nothing, however long.
    for dt in (0, 600, 1200, 1800, 2400):
        w(dt, **step)
    assert read() == []
    # A line waits at his idle prompt: told at 30 minutes of it, once.
    (tmp_path / "queue").write_text('{"text": "x"}\n')
    for dt in (3000, 3600, 4200):
        w(dt, **step)
    assert read() == []
    w(4800, **step)
    assert len(read()) == 1 and read()[0].startswith("tell stalled nothing has gone in for 30 minutes")
    w(5400, **step)
    assert len(read()) == 1
    # Something went in and nothing waits: told it's back, once.
    (tmp_path / "delivered").write_text(f"{t + 5500}\n")
    (tmp_path / "queue").unlink()
    w(5600, **step)
    w(6200, **step)
    assert read()[1:] == ["clear delivered"]
    # At work, or on a question: no idle time counts; 2 hours in all still tells him.
    (tmp_path / "queue").write_text('{"text": "y"}\n')
    for dt in (7000, 7600, 8200, 8800):
        w(dt, WORKING, **step)
    w(9400, AUTO_MODE_OFFER, **step)
    assert len(read()) == 2
    w(7000 + 7200, WORKING, **step)
    assert read()[2].startswith("tell stalled nothing has gone in for 120 minutes")
    (tmp_path / "queue").unlink()
    (tmp_path / "delivered").write_text(f"{t + 20000}\n")
    w(20100)
    assert read()[3] == "clear delivered"
    # A gap between reads counts a minute at most.
    (tmp_path / "queue").write_text('{"text": "z"}\n')
    for dt in range(21000, 21000 + 600 * 5, 600):
        w(dt)
    assert len(read()) == 4 and (tmp_path / "watch" / "idle").read_text().strip() == "240"   # 4 minutes, not 40
    (tmp_path / "queue").unlink()
    w(40000)
    # A draft that isn't the App's own, unchanged 30 minutes: told; the App's own try or a sign-in: not.
    import shutil
    shutil.rmtree(tmp_path / "watch")
    (tmp_path / "notice").unlink()
    w(50000, DRAFT)
    w(51799, DRAFT)
    assert read() == []
    w(51800, DRAFT)
    assert read() == ["tell stalled a draft has sat in his input box for 30 minutes"]
    w(51900, IDLE)
    assert read()[-1] == "clear delivered"
    (tmp_path / "try").write_text("mark 1a2b3c4d\ntyped 1\nentered 0\nkind relay\nkey 1\nfin -\n"
                                  "want [1a2b3c4d] Relayed by the add-on: x\n", newline="\n")
    mine = "❯ [1a2b3c4d] Relayed by the add-on: x\n  ? for shortcuts"
    for dt in (60000, 62000, 64000):
        w(dt, mine, WATCH_HM="0000")
    # A sign-in waiting on his screen (a login menu, no question's keys): with the run script's own
    # sign-in alarm out, nothing more; without it, told at 30 minutes, with the way to sign in
    # (outside round 24).
    signin = "Welcome to Claude Code\n Select login method:"
    (tmp_path / "try").unlink()
    (tmp_path / "alerted-login").touch()
    for dt in (70000, 72000, 74000):
        w(dt, signin, WATCH_ALERTED=(tmp_path / "alerted-login").as_posix())
    assert len(read()) == 2
    (tmp_path / "alerted-login").unlink()
    for dt in (75000, 76799):
        w(dt, signin, WATCH_ALERTED=(tmp_path / "alerted-login").as_posix())
    assert len(read()) == 2
    w(76800, signin, WATCH_ALERTED=(tmp_path / "alerted-login").as_posix())
    assert read()[-1] == "tell signin for 30 minutes"
    w(76900, IDLE)
    assert read()[-1] == "clear delivered"
    odd = "Some view the App doesn't know\n  with rows of its own"
    w(80000, odd)
    w(81800, odd)
    assert read()[-1] == "tell stalled his screen has shown something the App doesn't know for 30 minutes"
    # A check-in within its hour, not yet in, waits too.
    shutil.rmtree(tmp_path / "watch")
    (tmp_path / "notice").unlink()
    for dt in (90000, 90600, 91200, 91800):
        w(dt, WATCH_HM="0715", **step)
    assert read() == ["tell stalled nothing has gone in for 30 minutes"]
    (tmp_path / "done").mkdir()
    (tmp_path / "done" / "2026-11-16-0710").touch()
    w(92400, WATCH_HM="0745", **step)
    assert read()[-1] == "clear delivered"


def test_the_alarm_channel_is_read_back_without_dane(tmp_path):
    """notice.sh, Cain's fourth service review, must-fix 6: the App can't read Home Assistant (no API
    access, on purpose), so each probe asks Cain to read the helper it moves, through his read-only
    connector, and write what it says into his folder; the App checks that against the probe's time.
    Moved: the channel is proven (notice.sh proven, which the move to his own user waits for). Read
    and not moved: Dane hears from his bot, once a probe, and Cain files it. Nothing read since the
    probe: nothing yet. A probe goes at once when the hook is set or changed, and daily."""
    import json
    import shutil
    import subprocess
    from datetime import datetime, timedelta, timezone
    if not shutil.which("bash") or not shutil.which("jq") or not shutil.which("sha256sum"):
        pytest.skip("no bash, jq or sha256sum")
    notice = (CAIN / "rootfs/opt/cain/notice.sh").as_posix()
    opt, data, stub, bindir = (tmp_path / d for d in ("opt", "data", "stub", "bin"))
    for d in (opt, data, stub, bindir, data / "work", data / "link"):
        d.mkdir()
    (data / "link/discord.env").write_text("DISCORD_BOT_TOKEN=x\n")
    (opt / "alert.sh").write_text('#!/bin/bash\nprintf "%s\\n" "$1" >> "$STUB/discord"\n')
    (bindir / "curl").write_text('#!/bin/bash\ncat > /dev/null\nfor a in "$@"; do last="$a"; done\n'
                                 'printf "%s\\n" "$last" >> "$STUB/ha"\n')
    for f in (opt / "alert.sh", bindir / "curl"):
        f.chmod(0o755)
    if not shutil.which("flock"):
        (bindir / "flock").write_text("#!/bin/bash\nexit 0\n")
        (bindir / "flock").chmod(0o755)
    options = data / "options.json"
    options.write_text(json.dumps({"notice_hook": ""}))
    env = {**os.environ, "STUB": stub.as_posix(), "NOTICE_OPT": opt.as_posix(), "NOTICE_DATA": data.as_posix(),
           "NOTICE_URL": "http://ha.test:8123", "NOTICE_DAY_S": "100000", "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}"}
    env.pop("CAIN_AS", None)

    def call(*args, want=0):
        out = subprocess.run(["bash", notice, *args], capture_output=True, text=True, env=env, timeout=30)
        assert out.returncode == want, (args, out.returncode, out.stderr[-400:])
        return out.stdout + out.stderr

    asked = lambda: [json.loads(l)["text"] for l in (data / "relay.queue").read_text().splitlines()] if (data / "relay.queue").exists() else []
    said = lambda: (stub / "discord").read_text().splitlines() if (stub / "discord").exists() else []
    reading = data / "work" / "alarms-checked"
    call("hooked", want=1)
    call("proven", want=1)
    call("tick")
    assert asked() == [] and not (data / "c1/notice-probed").exists()           # no hook: no probe
    options.write_text(json.dumps({"notice_hook": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"}))
    call("hooked")
    call("tick")                                                                    # set: a probe at once
    probed = int((data / "c1/notice-probed").read_text().split()[0])
    assert len(asked()) == 1 and "read input_datetime.cain_alarms_checked" in asked()[0]
    assert f"into {reading.as_posix()} (the whole file)" in asked()[0] and asked()[0].endswith("Nothing to tell him.")
    call("tick")
    call("proven", want=1)                                                         # nothing read yet
    reading.write_text((datetime.now(timezone.utc) + timedelta(days=1)).isoformat() + "\n")
    call("tick")
    call("proven", want=1)                                    # a time later than his file proves nothing
    assert said() == [] and len(asked()) == 1
    reading.write_text(datetime.now(timezone.utc).isoformat() + "\n")
    call("tick")
    call("proven")
    import hashlib
    fp = lambda h: hashlib.sha256(h.encode()).hexdigest()[:16]
    assert (data / "c1/notice-proven").read_text() == f"{probed} {fp('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')}\n"
    assert said() == [] and len(asked()) == 1
    # The proof is the hook's it was made with: with the hook removed, or another set, it proves nothing
    # (outside round 24).
    options.write_text(json.dumps({"notice_hook": ""}))
    call("proven", want=1)
    # A new hook: not proven until its own probe is read back; read back and not moved, Dane hears
    # from his bot, once; Cain files it.
    options.write_text(json.dumps({"notice_hook": "f" * 32}))
    call("proven", want=1)
    call("tick")
    assert len(asked()) == 2
    # The helper still at a time half a minute before this probe (an earlier one's): not moved, with
    # no slack to pass it (outside round 24).
    probed2 = int((data / "c1/notice-probed").read_text().split()[0])
    reading.write_text(datetime.fromtimestamp(probed2 - 30, timezone.utc).isoformat() + "\n")
    call("tick")
    call("tick")
    assert len(said()) == 1 and "Cain's alarms to your phone through Home Assistant didn't pass their test (the helper didn't move)" in said()[0]
    assert "File it as a note on P33 for the laptop session" in asked()[-1] and len(asked()) == 3
    # Read back moved after all: proven again, and Dane hears the alarm is down.
    reading.write_text(datetime.now(timezone.utc).isoformat() + "\n")
    call("tick")
    call("proven")
    assert said()[-1] == "Cain's alarms to your phone through Home Assistant passed their test again."
    assert (data / "c1/notice-proven").read_text().split()[1] == fp("f" * 32)
    # A proof older than two days doesn't count.
    (data / "c1/notice-proven").write_text(f"{probed - 3 * 86400} {fp('f' * 32)}\n")
    env["NOTICE_DAY_S"] = "86400"
    call("proven", want=1)


def test_the_switch_waits_until_the_alarm_channel_is_shown_to_work():
    """Cain's fourth service review, must-fix 6: a switch to his own user begins only once the App's
    alarms to his phone are shown to work (notice.sh proven), so his move never leaves Dane with one way
    to hear of it; a switch begun is finished or undone, always. With no notice_hook set, Cain hears
    once a day, to file it for the laptop session. The probe and its readback start a minute in. The
    watchdog runs with his session, every 10 seconds."""
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text(encoding="utf-8").replace("\r\n", "\n")
    assert 'if [ "$state" = switching ] || { [ -f /data/link/specialist-signs ] && "$OPT/notice.sh" proven; }; then' in run
    assert '[ -f /data/link/specialist-signs ] && "$OPT/notice.sh" proven && bun "$OPT/c1/tools.ts" may-retry /data/c1/failed || break' in run
    loop = run.split("while session_up; do", 1)[1]
    gate = loop.index('= listed ] && ! "$OPT/notice.sh" proven; then')
    assert gate < loop.index("bashio::addon.restart || bashio::log.warning")
    assert '"$OPT/notice.sh" hooked' in loop and "File it as a note on P33 for the laptop session" in loop
    assert "find /data/c1/hook-told -mmin -1440" in loop
    assert '( sleep 60; while true; do "$OPT/notice.sh" tick 2>&1 || true; sleep 600; done ) &' in run
    assert 'timeout -k 5 60 "$OPT/watch.sh" || true' in loop
    assert loop.index('"$OPT/unstick.sh"') < loop.index('"$OPT/watch.sh"')
    assert 'export CAIN_AS="$OPT/as-cain"' in run and 'export CAIN_AS=""' in run


def test_nothing_is_typed_into_a_session_before_its_check_passes():
    """Cain's third service review (must-fix 4): every start of his session, the App's own restarts
    included, is checked as his own user before anything is typed into it. session.sh starts Claude
    Code once, so a new one is always the run script's start, with its check; the mark checkin.sh
    reads is taken away before every start and at every end, and set only where the check passes
    (at once the old way, which has none, as 0.11.0 ran)."""
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text(encoding="utf-8").replace("\r\n", "\n")
    session = (CAIN / "rootfs/opt/cain/session.sh").read_text(encoding="utf-8")
    assert "while true" not in session and session.count("claude --permission-mode") == 1
    assert "export SESSION_CHECKED=/run/cain/session-checked" in run
    for fn in ("start_his_session() {\n", "end_his_session() {\n"):
        assert run.split(fn, 1)[1].lstrip().startswith("unchecked\n"), fn
    marks = [l.strip() for l in run.splitlines() if "checked_now" in l and "checked_now()" not in l]
    assert marks == ['if [ -n "$checked" ]; then checked_now; else unchecked; fi', "0) checked=1; checked_now ;;",
                     'if [ -n "$checked" ] && [ ! -s "$SESSION_CHECKED" ]; then checked_now; fi']
    fn = run.split("checked_now() {\n", 1)[1].split("\n}\n", 1)[0]
    assert "'#{pane_pid}'" in fn and 'mv -f "$SESSION_CHECKED.tmp" "$SESSION_CHECKED"' in fn
    assert run.index('[ "$mode" = own ] || checked=1\nif [ -n "$checked" ]; then checked_now; else unchecked; fi') > 0
    checkin = (CAIN / "rootfs/opt/cain/checkin.sh").read_text(encoding="utf-8")
    gate = checkin.index('checked_mark="${SESSION_CHECKED:-/run/cain/session-checked}"\nchecked "$checked_mark" || exit 0')
    assert gate < checkin.index("screen=$(screen_now)") and gate < checkin.index("type_try() {")
    typing = (CAIN / "rootfs/opt/cain/typing.sh").read_text(encoding="utf-8")
    assert '[ -n "$m" ] && [ "$(pane_pid)" = "$m" ]' in typing


def test_cain_checks_in_on_his_own_record():
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert '"$OPT/checkin.sh"' in run
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "## Check-ins" in rules and "state/PENDING.md" in rules
    assert "never his go on anything" in rules
    assert " tzdata " in (CAIN / "Dockerfile").read_text()


def test_taps_and_reactions_reach_cain_with_the_relay_key():
    import sys
    sys.path.insert(0, str(ADDON / "app"))
    from harness import cain_relay
    link = (CAIN / "rootfs/opt/cain/link/main.ts").read_text(encoding="utf-8")
    auth = (CAIN / "rootfs/opt/cain/link/auth.ts").read_text(encoding="utf-8")
    # The specialist signs with K_sign, not the old relay key (C1 plan 3.9): the link checks it,
    # signs its answers with it, and only recognizes the old key to refuse it (503).
    assert f'SIG_CONTEXT = "{cain_relay.SIGN_CONTEXT.decode()}"' in auth
    assert "const signKey = key(SIG_CONTEXT);" in link
    assert "checkRequest(req.headers.get(SIG_HEADER), signKey" in link and "signResponse(signKey, id" in link
    assert f'sameKey(bare, key("{cain_relay.KEY_CONTEXT.decode()}"))' in link
    assert "timingSafeEqual" in auth and f'SIG_HEADER = "{cain_relay.SIG_HEADER}"' in auth
    assert f"?? {cain_relay.PORT})" in link and cain_relay.HOST == "0fcc2575-cain"
    # The specialist's routes only: it can't show its own cards, ask, put up a Ship card, or
    # close Cain's questions; those are Cain's, from this machine, with his own key.
    assert ('SPECIALIST_ROUTES = new Set(["/card", "/buttons", "/answer", "/relay", "/card-of"])' in auth)
    assert ('CAIN_ROUTES = new Set(["/show", "/ask", "/morning", "/ship", "/answered", "/replied", "/stopped",\n'
            '  "/look", "/cards", "/check", "/reply", "/key-note", "/replay", "/connector", "/guard-hold", "/review-grant"])'
            in auth.replace("\r\n", "\n"))
    # Cain 0.18.0: /review-grant is Cain's card asking Dane for extra review rounds; only his tap writes one.
    # Root's own (its unix socket): the broker's /sent, and the PC job keeper's /reuse and
    # /pc-notice (the keeper runs as root, so being root is its key), and (Cain 0.16.0) the
    # review runner's decision card at the round cap, so Cain can't post it; and (its second round)
    # the usage guard's hold, which the link decides again before it writes root's guard log.
    # Cain 0.18.1 (fifth review): and the runner's Keep or Drop card for an earlier grant's unused rounds.
    assert 'ROOT_ROUTES = new Set(["/sent", "/cards", "/check", "/reuse", "/pc-notice", "/decision", "/guard-hold", "/legacy-grant"])' in auth
    from harness import handover
    assert f'key("{handover.KEY_CONTEXT.decode()}")' in link
    assert 'toHarness("/press"' in (CAIN / "rootfs/opt/cain/link/core.ts").read_text(encoding="utf-8")
    assert "http://0fcc2575-harness:8098" in link
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert 'bun "$OPT/link/main.ts"' in run
    assert not re.search(r"^ports", (CAIN / "config.yaml").read_text(), re.M)


def test_checkin_presses_enter_only_while_what_it_typed_sits_in_his_input_box(tmp_path):
    """Cain's third and fourth service reviews: a question can open between the read and the Enter
    (the fault that kept his prompts from him for three hours on Nov 16). checkin.sh types nothing
    into a session that hasn't passed its check of his own user, as it runs now (the mark holds its
    pane's process), nor on a single read of his prompt; it types, reads the screen again, and
    presses Enter only while his input box holds the whole try, mark first. The try is kept until
    it's known to be in (its mark in his transcript), and only then does its line leave the queue;
    until then nothing else is typed. A try still whole in his box gets its Enter once read so
    twice; one known not to be in is typed again with a new mark; anyone else's draft is left be."""
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")

    def fresh(name, *lines):
        d = tmp_path / name
        d.mkdir()
        (d / "relay.queue").write_text("".join(l + "\n" for l in lines), newline="\n")
        os.environ["RELAY_QUEUE"] = str(d / "relay.queue")
        return d, d / "relay.queue.work", d / "checkin.try"
    try:
        d, work, tr = fresh("a", '{"text": "Dane tapped \\"Ship\\""}')
        # No mark from the run script, or the mark of another session (another pane process): nothing.
        assert _checkin(d, "0300", IDLE, checked=False) == "" and not work.exists()
        assert _checkin(d, "0300", IDLE, runs=3, STUB_PID="5555") == "" and not work.exists()
        # One read of his prompt: nothing yet.
        assert _checkin(d, "0300", IDLE, runs=1) == ""
        # A question opens as it types: no Enter, the tap kept, the try kept with what it's for.
        out = _checkin(d, "0300", IDLE, runs=1, after=AUTO_MODE_OFFER)
        assert re.match(r'-u send-keys -t cain -l \[[0-9a-f]{8}\] Relayed by the add-on: Dane tapped "Ship"$', out.splitlines()[-1])
        assert "Enter" not in out and "Dane tapped" in work.read_text() and "\nentered 0\n" in tr.read_text()
        # While the question stands: nothing more is typed, nothing dropped.
        assert _checkin(d, "0300", IDLE, runs=3, after=AUTO_MODE_OFFER) == out and tr.exists()
        # The question gone, the try whole in his box: its Enter once read so twice; in, once.
        assert _checkin(d, "0300", IDLE, runs=1) == out
        out = _checkin(d, "0300", IDLE, runs=1).splitlines()
        assert out[-1] == "-u send-keys -t cain Enter" and out.count("-u send-keys -t cain Enter") == 1
        assert _in(d) == ['Relayed by the add-on: Dane tapped "Ship"'] and work.read_text() == "" and not tr.exists()

        # Typed, and it never stayed in his box (his box read empty after): no Enter, the tap kept;
        # his box empty and steady 30 seconds on, it's known not to be in and typed again, new mark.
        d, work, tr = fresh("b", '{"text": "Dane reacted"}')
        out = _checkin(d, "0300", IDLE, runs=2, after=IDLE)
        assert "Enter" not in out and "Dane reacted" in work.read_text() and tr.exists()
        first = re.search(r"\[([0-9a-f]{8})\]", out).group(1)
        (d / "box/typed").unlink()
        assert _checkin(d, "0300", IDLE, runs=2) == out and tr.exists()          # not 30 seconds yet
        out = _checkin(d, "0300", IDLE, runs=4, CHECKIN_GRACE_S="0").splitlines()
        assert out[-1] == "-u send-keys -t cain Enter" and first not in out[-2] and _in(d) == ["Relayed by the add-on: Dane reacted"]
        assert work.read_text() == ""

        # Twice typed and never in: the third time it goes as a file of his, a short line naming it.
        d, work, tr = fresh("c", '{"text": "first"}', '{"text": "second"}')
        for _ in range(2):
            _checkin(d, "0300", IDLE, runs=3, after=IDLE, CHECKIN_GRACE_S="0")
            (d / "box/typed").unlink(missing_ok=True)
            _checkin(d, "0300", IDLE, runs=1, after=IDLE, CHECKIN_GRACE_S="0")
        _checkin(d, "0300", IDLE, runs=2, CHECKIN_GRACE_S="0")
        typed = [l for l in (d / "sent.txt").read_text().splitlines() if " -l " in l]
        assert [_typed(l) for l in typed[:2]] == ["Relayed by the add-on: first"] * 2
        assert "too long or unusual to type here" in typed[2] and _said(d, typed[2]) == "Relayed by the add-on: first"
        assert _in(d)[0].startswith("Relayed by the add-on: a relayed line too long or unusual") and "second" in work.read_text()
        assert _checkin(d, "0300", IDLE, runs=2) and _in(d)[-1] == "Relayed by the add-on: second"   # the next as it is

        # After a delivery, the next waits for two reads again; a read from before his session's check
        # (its mark set since) doesn't count (outside review, round 15).
        d, work, tr = fresh("d", '{"text": "one"}', '{"text": "two"}')
        assert "one" in _checkin(d, "0300", IDLE, runs=2)
        assert "two" not in _checkin(d, "0300", IDLE, runs=1)                   # the read after it only counts as one
        import time
        time.sleep(0.05)
        (d / "session-checked").write_text("4242\n")                             # his session checked anew since
        assert "two" not in _checkin(d, "0300", IDLE, runs=1)
        assert "two" in _checkin(d, "0300", IDLE, runs=1)

        # His box holding a draft that isn't the try: no Enter, the try kept, the draft left as it is
        # (no Ctrl+U); once that draft is gone and his box steady, typed again (outside review, round 15).
        d, work, tr = fresh("e", '{"text": "three"}')
        out = _checkin(d, "0300", IDLE, runs=2, after=DRAFT)
        assert "three" in out and "Enter" not in out and tr.exists()
        assert _checkin(d, "0300", IDLE, runs=4, after=DRAFT, CHECKIN_GRACE_S="0") == out and tr.exists()
        (d / "box/typed").unlink()
        out = _checkin(d, "0300", IDLE, runs=4, CHECKIN_GRACE_S="0")
        assert "C-u" not in out and out.splitlines()[-1] == "-u send-keys -t cain Enter" and _in(d) == ["Relayed by the add-on: three"]

        # His box drawn otherwise than the try: another try's mark, a space more, a cut short of a full
        # line, or only its mark: no Enter (outside review, rounds 16 to 19). Drawn as typed, it goes in.
        url = "https://github.com/HyndeSyte/harness/pull/20/commits/5b04ee668bce81645c2439e3f0d5eb9b3aef342a"
        cases = [
            ("the specialist asks to ship pull request 18",
             "❯ [0a0b0c0d] Relayed by the add-on: the specialist asks to ship pull request 18\n  ? for shortcuts"),
            ("Ship PR 18", "❯ {mark} Relayed by the add-on: Ship PR 1 8\n  ? for shortcuts"),
            ("Ship PR 18 after review", f"{RULE}\n❯ {{mark}} Relayed by the add-on: Ship PR 1\n  8 after review\n{RULE}\n  ? for shortcuts"),
            ("Ship pull request 18 only after review", "❯ {mark}\n  ? for shortcuts"),
        ]
        for i, (text, shown) in enumerate(cases):
            d, work, tr = fresh(f"f{i}", '{"text": "' + text + '"}')
            out = _checkin(d, "0300", IDLE, runs=2, after=shown, STUB_WIDTH="60")
            assert text in out and "Enter" not in out and tr.exists(), (text, out)
            out = _checkin(d, "0300", IDLE, runs=4, CHECKIN_DRAW_S="0", CHECKIN_GRACE_S="0", STUB_WIDTH="60")
            assert out.splitlines()[-1] == "-u send-keys -t cain Enter" and _in(d) == ["Relayed by the add-on: " + text], (text, out)
            assert work.read_text() == ""
        # Only the start of the try in his box, 10 seconds on: taken back out (Ctrl+U), typed again.
        d, work, tr = fresh("g", '{"text": "Ship pull request 18 only after review"}')
        _checkin(d, "0300", IDLE, runs=2, after="❯ {mark}\n  ? for shortcuts")
        out = _checkin(d, "0300", IDLE, runs=1, after="❯ {mark}\n  ? for shortcuts", CHECKIN_DRAW_S="0")
        assert out.splitlines()[-1] == "-u send-keys -t cain" + " C-u" * 20 and not tr.exists()
        # The text as it is: a long address goes as written, and his box cuts it where it's too long
        # for a line, at a full line (a real Claude Code 2.1.317 at 60 columns cut one at exactly 56,
        # the width less 4): that goes in.
        d, work, tr = fresh("h", '{"text": "see  ' + url + ' for the head"}')
        typed = "Relayed by the add-on: see  " + url + " for the head"
        shown = f"{RULE}\n❯ {{mark}} Relayed by the add-on: see\n  {url[:56]}\n  {url[56:]} for the head\n{RULE}\n  ? for shortcuts"
        out = _checkin(d, "0300", IDLE, runs=2, after=shown, STUB_WIDTH="60")
        assert _typed(out.splitlines()[-2]) == typed and out.splitlines()[-1] == "-u send-keys -t cain Enter"
        assert _in(d) == [typed] and work.read_text() == ""
        # A control character is never typed (an Esc would be a key): left out, a tab a space.
        d, work, tr = fresh("i", '{"text": "Undo\\u001b the move,\\tplease"}')
        out = _checkin(d, "0300", IDLE, runs=2)
        assert _typed(out.splitlines()[-2]) == "Relayed by the add-on: Undo the move, please" and "\x1b" not in out
        # A text whose last character is ";" gets a space after it: tmux takes an argument's last ";"
        # for the end of its command.
        d, work, tr = fresh("j", '{"text": "first; second;"}')
        out = _checkin(d, "0300", IDLE, runs=2)
        assert out.splitlines()[-2].endswith("first; second; ") and _in(d) == ["Relayed by the add-on: first; second; "]
    finally:
        del os.environ["RELAY_QUEUE"]


def test_a_question_that_takes_the_enter_leaves_the_line_to_go_in_once(tmp_path):
    """Cain's fourth service review, must-fix 1: a question that opens between the App's last read and
    its Enter takes the Enter (here it answers it and goes), and the try stays in his box. The line
    stays queued and the try kept, neither dropped nor forgotten; still whole in his box, the try gets
    its Enter once read so twice, goes in once, and only then leaves the queue. A question that stays
    on screen after taking it holds everything until it goes; the try is recognised by its own mark
    when his box is back."""
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")
    q, work, tr = tmp_path / "relay.queue", tmp_path / "relay.queue.work", tmp_path / "checkin.try"
    q.write_text('{"text": "Dane tapped \\"Approve\\""}\n{"text": "next"}\n', newline="\n")
    os.environ["RELAY_QUEUE"] = str(q)
    try:
        out = _checkin(tmp_path, "0300", IDLE, runs=2, STUB_ENTER_DIALOG="1")
        assert out.count("Enter") == 1 and _in(tmp_path) == [] and work.read_text().startswith('{"text": "Dane tapped')
        assert re.search(r"\nentered [1-9][0-9]+\n", tr.read_text())               # kept: it had its Enter
        out = _checkin(tmp_path, "0300", IDLE, runs=2, STUB_ENTER_DIALOG="1")
        assert out.count("Enter") == 2 and out.count(" -l ") == 1                   # the same try, never retyped
        assert _in(tmp_path) == ['Relayed by the add-on: Dane tapped "Approve"'] and work.read_text() == '{"text": "next"}\n'
        assert not tr.exists()
        # The question stays after taking the Enter: nothing goes in or is typed while it stands.
        (tmp_path / "box/took").unlink()
        out = _checkin(tmp_path, "0300", IDLE, runs=3, STUB_ENTER_DIALOG="1", STUB_ENTER_STAYS="1")
        assert out.count(" -l ") == 2 and out.count("Enter") == 3 and (tmp_path / "box/dialog").exists()
        assert _checkin(tmp_path, "0300", IDLE, runs=4, STUB_ENTER_DIALOG="1") == out and tr.exists()
        (tmp_path / "box/dialog").unlink()
        out = _checkin(tmp_path, "0300", IDLE, runs=2, STUB_ENTER_DIALOG="1")
        assert out.count(" -l ") == 2 and _in(tmp_path)[-1] == "Relayed by the add-on: next" and work.read_text() == ""
        assert len(_in(tmp_path)) == 2
    finally:
        del os.environ["RELAY_QUEUE"]


def test_a_try_seen_in_is_never_typed_again(tmp_path):
    """Cain's fourth service review, must-fix 5: the try's random mark is its proof. A try that had its
    Enter and wasn't seen in before the App moved on (here its container restarted: only /data kept)
    is looked for again first, in his transcript and on his screen above his input box; found, its
    line leaves the queue and is never typed again. A new try's mark is never one his transcripts
    already hold."""
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")
    q, work, tr = tmp_path / "relay.queue", tmp_path / "relay.queue.work", tmp_path / "checkin.try"
    os.environ["RELAY_QUEUE"] = str(q)
    import subprocess
    key = lambda line: subprocess.run(["cksum"], input=(line + "\n").encode(), capture_output=True).stdout.decode().split()[0]
    try:
        for where in ("transcript", "screen"):
            work.write_text('{"text": "Approve"}\n{"text": "next"}\n', newline="\n")
            tr.write_text(f"mark 1a2b3c4d\ntyped 1000\nentered 1001\nkind relay\nkey {key('{\"text\": \"Approve\"}')}\n"
                          "fin -\nwant [1a2b3c4d] Relayed by the add-on: Approve\n", newline="\n")
            screen = IDLE
            if where == "transcript":
                (tmp_path / "transcripts").mkdir(exist_ok=True)
                (tmp_path / "transcripts/old.jsonl").write_text('{"content":"[1a2b3c4d] Relayed by the add-on: Approve"}\n')
            else:
                (tmp_path / "transcripts/old.jsonl").unlink()
                screen = f"> [1a2b3c4d] Relayed by the add-on: Approve\n\n● Done.\n{RULE}\n> \n{RULE}\n  ? for shortcuts"
            out = _checkin(tmp_path, "0300", screen, runs=1)
            assert out.count(" -l ") == 0 and work.read_text() == '{"text": "next"}\n' and not tr.exists(), where
            (tmp_path / "sent.txt").unlink(missing_ok=True)
        # Seen in, but its line can't leave the queue (the work file can't be rewritten): the try is
        # kept, so it's found in again next time and the line is never typed again.
        work.write_text('{"text": "Approve"}\n{"text": "next"}\n', newline="\n")
        tr.write_text(f"mark 1a2b3c4d\ntyped 1000\nentered 1001\nkind relay\nkey {key('{\"text\": \"Approve\"}')}\n"
                      "fin -\nwant [1a2b3c4d] Relayed by the add-on: Approve\n", newline="\n")
        (tmp_path / "relay.queue.work.tmp").mkdir()
        assert _checkin(tmp_path, "0300", screen, runs=2) == "" and tr.exists() and work.read_text().startswith('{"text": "Approve"}')
        (tmp_path / "relay.queue.work.tmp").rmdir()
        assert _checkin(tmp_path, "0300", screen, runs=1) == "" and not tr.exists() and work.read_text() == '{"text": "next"}\n'
        # A mark the transcripts hold already is never a new try's: the App draws another.
        t = (CAIN / "rootfs/opt/cain/typing.sh").read_text(encoding="utf-8")
        assert 'in_transcript "$m" $(( $(date +%s) - 172800 )) || { printf' in t and "-N4 -tx1" in t
    finally:
        del os.environ["RELAY_QUEUE"]


def test_a_try_that_cant_be_known_in_is_set_aside_for_cain_never_typed_again(tmp_path):
    """Cain's fourth service review, must-fix 5: a try that had its Enter and can't be known in or not
    (his box empty, his screen idle, its mark in neither his transcript nor his screen, two minutes
    on) is never typed again as new. Its text goes to a file of his, and a line saying it may already
    have reached him, to check before acting on it, takes its place first in the queue; what came
    after waits its turn."""
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")
    q, work, tr = tmp_path / "relay.queue", tmp_path / "relay.queue.work", tmp_path / "checkin.try"
    q.write_text('{"text": "Dane tapped \\"Approve\\""}\n{"text": "later"}\n', newline="\n")
    os.environ["RELAY_QUEUE"] = str(q)
    try:
        out = _checkin(tmp_path, "0300", IDLE, runs=2, STUB_LOSE="1")
        assert out.count("Enter") == 1 and _in(tmp_path) == [] and tr.exists()
        kept = tr.read_text()
        assert _checkin(tmp_path, "0300", IDLE, runs=3) == out and tr.exists()       # not two minutes yet
        _checkin(tmp_path, "0300", IDLE, runs=2, CHECKIN_CONFIRM_S="0")
        assert not tr.exists() and out.count(" -l ") == 1
        head = work.read_text().splitlines()
        assert len(head) == 2 and head[1] == '{"text": "later"}' and "can't tell whether it reached you" in head[0]
        f = re.search(r"/from-app/(unsure-[0-9a-f]{8}\.txt)", head[0]).group(1)
        assert (tmp_path / "from-app" / f).read_text() == 'Relayed by the add-on: Dane tapped "Approve"\n'
        # The App stopped after the line took its place, before the try was forgotten: the next run
        # finds the line there and only finishes, never blocking what comes after (outside round 24).
        tr.write_text(kept, newline="\n")
        assert _checkin(tmp_path, "0300", IDLE, runs=2, CHECKIN_CONFIRM_S="0") == out and not tr.exists()
        assert work.read_text().splitlines() == head
        out = _checkin(tmp_path, "0300", IDLE, runs=4)
        typed = [l for l in out.splitlines() if " -l " in l]
        assert len(typed) == 3 and "If you've already acted on it, leave it" in _said(tmp_path, typed[1])
        assert _in(tmp_path)[1] == "Relayed by the add-on: later" and work.read_text() == ""
    finally:
        del os.environ["RELAY_QUEUE"]


def test_a_try_set_aside_finishes_after_a_stop_for_every_kind(tmp_path):
    """Outside round 24: setting aside a try that can't be known in or not runs again over its own work.
    Stopped after its line about it went first in the queue and before the try was forgotten (for a
    nudge and a check-in as for a relayed line, tested above), the next run finds that line, puts in
    no second one, finishes what the try was for, and forgets the try: nothing after it is held up."""
    import json
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")
    for kind, key, fin in (("jobs", "jobs", "-"), ("checkin", "2026-11-08-0710", "2026-11-08-0710 0 -")):
        d = tmp_path / kind
        d.mkdir()
        q, work, tr = d / "relay.queue", d / "relay.queue.work", d / "checkin.try"
        os.environ["RELAY_QUEUE"], os.environ["JOBS_NUDGED"] = str(q), str(d / "jobs.nudged")
        try:
            tr.write_text(f"mark 1a2b3c4d\ntyped 1000\nentered 1001\nkind {kind}\nkey {key}\nfin {fin}\n"
                          "want [1a2b3c4d] the line itself\n", newline="\n")
            (d / "from-app").mkdir()
            (d / "from-app/unsure-1a2b3c4d.txt").write_text("the line itself\n")
            line = json.dumps({"text": f"A line ... Its text is in {(d / 'from-app').as_posix()}/unsure-1a2b3c4d.txt. If ..."})
            work.write_text(line + "\n" + '{"text": "after it"}\n', newline="\n")
            assert _checkin(d, "0300", IDLE, runs=2, CHECKIN_CONFIRM_S="0") == "" and not tr.exists(), kind
            assert work.read_text().splitlines() == [line, '{"text": "after it"}'], kind
            assert (d / "jobs.nudged").exists() if kind == "jobs" else (d / "done/2026-11-08-0710").exists()
            out = _checkin(d, "0300", IDLE, runs=4)
            assert [l.split("] ", 1)[1] for l in out.splitlines() if " -l " in l][-1] == "Relayed by the add-on: after it"
        finally:
            del os.environ["RELAY_QUEUE"], os.environ["JOBS_NUDGED"]


def test_his_transcripts_and_files_are_found_where_his_session_keeps_them():
    """Outside round 24: checkin.sh, unstick.sh, watch.sh and notice.sh find his transcripts and his
    files where his session, as it runs, keeps them. The run script exports their places for each way
    of running (the old way: root, HOME /data; his own user: HOME /data/cain, read as him) before it
    starts anything that types or reads them; typing.sh's own default is his own user's."""
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text(encoding="utf-8").replace("\r\n", "\n")
    old = run.split('if [ "$mode" = old ]; then\n  export LINK_MODE=old', 1)[1].split("\nelse\n", 1)[0]
    new = run.split("\nelse\n  export CAIN_GATE_LOG=", 1)[1].split("export TMUX_CMD\n", 1)[0]
    assert "CAIN_TRANSCRIPTS=/data/.claude/projects" in old and 'export CAIN_AS=""' in old
    assert "CAIN_TRANSCRIPTS=/data/cain/.claude/projects" in new and 'export CAIN_AS="$OPT/as-cain"' in new
    exported = run.index("export TMUX_CMD\n")
    for start in ('"$OPT/checkin.sh" || true; sleep 5', '"$OPT/unstick.sh"', '"$OPT/watch.sh"', '"$OPT/notice.sh" tick'):
        assert run.index(start) > exported, start
    session = (CAIN / "rootfs/opt/cain/session.sh").read_text(encoding="utf-8")
    assert "export HOME=/data/cain" in session and "export HOME=/data\n" in session and "cd /data/work" in session
    typing = (CAIN / "rootfs/opt/cain/typing.sh").read_text(encoding="utf-8")
    assert 'TRANSCRIPTS="${CAIN_TRANSCRIPTS:-/data/cain/.claude/projects}"' in typing
    assert 'FROM_APP="${CAIN_FROM_APP:-/data/work/from-app}"' in typing


def test_a_checkin_finished_twice_moves_on_only_what_it_named(tmp_path):
    """Outside round 24: what's done once a check-in is in can run again over its own work (the App
    stopped after it, before its try was forgotten). The records it named move on once; one set aside
    since stays to be named at the next."""
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")
    bad = tmp_path / "relay.bad"
    os.environ["RELAY_BAD"] = str(bad)
    try:
        bad.write_text('{"text": 1}\n', newline="\n")
        line = _said(tmp_path, _checkin(tmp_path, "0712", IDLE, day="2026-11-09").splitlines()[-2])
        assert "Relayed records the App couldn't read: 1" in line and bad.read_text() == ""
        mark = re.search(r'"content":"\[([0-9a-f]{8})\]', (tmp_path / "transcripts/session.jsonl").read_text()).group(1)
        bad.write_text('{"text": 2}\n', newline="\n")                       # set aside since
        (tmp_path / "checkin.try").write_text(
            f"mark {mark}\ntyped 1000\nentered 1001\nkind checkin\nkey 2026-11-09-0710\nfin 2026-11-09-0710 1 -\n"
            f"want [{mark}] x\n", newline="\n")
        assert _checkin(tmp_path, "0712", IDLE, day="2026-11-09", runs=1).count(" -l ") == 1
        assert not (tmp_path / "checkin.try").exists() and bad.read_text() == '{"text": 2}\n'
        assert (tmp_path / "relay.bad.named").read_text() == '{"text": 1}\n'
        line = _said(tmp_path, _checkin(tmp_path, "1240", IDLE, day="2026-11-09").splitlines()[-2])
        assert "Relayed records the App couldn't read: 1" in line and bad.read_text() == ""
    finally:
        del os.environ["RELAY_BAD"]


def test_a_long_or_unusual_text_goes_as_a_file_of_his(tmp_path):
    """Cain's fourth service review, must-fix 4: only plain printable ASCII, 400 characters at most, is
    typed as it is: well under Claude Code's paste folding and his 40-row window, and drawn in widths
    the App can count. Any other text (a wide or joined character draws in a width no count of
    characters gives: a real Claude Code 2.1.317 cut a line one short of the width; real screens
    below) goes to a file of his, and a short line naming it is typed instead, which always draws
    as typed."""
    import json
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")
    q, work = tmp_path / "relay.queue", tmp_path / "relay.queue.work"
    texts = ["Dane tapped «Ship» on “Install Cain’s update — café naïve” ✓ 日本語 👍", "x" * 377, "y" * 378]
    q.write_text("".join(json.dumps({"text": t}, ensure_ascii=False) + "\n" for t in texts), encoding="utf-8", newline="\n")
    os.environ["RELAY_QUEUE"] = str(q)
    try:
        out = _checkin(tmp_path, "0300", IDLE, runs=8)
        typed = [l for l in out.splitlines() if " -l " in l]
        assert len(typed) == 3 and all(re.fullmatch(r"[ -~]+", l) for l in typed)
        assert [_said(tmp_path, l) for l in typed] == ["Relayed by the add-on: " + t for t in texts]
        assert "too long or unusual" in typed[0] and _typed(typed[1]) == "Relayed by the add-on: " + "x" * 377
        assert "too long or unusual" in typed[2]                                  # 401 characters with its lead
        assert len(_in(tmp_path)) == 3 and work.read_text() == ""
    finally:
        del os.environ["RELAY_QUEUE"]
    # A real Claude Code 2.1.317 (Nov 16, a console at 60 columns): that text, drawn: a draft whose lines
    # never match it, wrapped by width (its wide characters), its emoji read back as a stand-in.
    lines = _prompt_state(REAL_UNUSUAL_DRAFT, PROMPT_DRAFT_TEXT="1").split("\n")
    assert lines[0] == "draft" and lines[1].startswith("[a1b2c3] Relayed by the add-on: Dane tapped «Ship» on")
    assert len(lines) == 5 and lines[3].endswith("abcdefghijklmnopqrstuvwxyzabcde")


def test_checkin_exits_0_on_every_path(tmp_path):
    """Cain's fourth service review, must-fix 3: the run script runs checkin.sh every 5 seconds and
    takes nothing from its exit status, so it always exits 0, and every run in these tests must
    (_checkin asserts it): no mark, another session's mark, tmux failing, a record that can't be
    read, a try that can't be read back, a question, a draft, nothing to do."""
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")
    text = (CAIN / "rootfs/opt/cain/checkin.sh").read_text(encoding="utf-8")
    assert "exit 1" not in text and "Always exits 0" in text
    q, tr = tmp_path / "relay.queue", tmp_path / "checkin.try"
    os.environ["RELAY_QUEUE"], os.environ["RELAY_BAD"] = str(q), str(tmp_path / "relay.bad")
    try:
        q.write_text('{"text": "x"\n{"text": "y"}\n', newline="\n")
        for screen, more in ((IDLE, {"STUB_DOWN": "1"}), (IDLE, {"STUB_PID": "1"}), (AUTO_MODE_OFFER, {}), (DRAFT, {}),
                             (WORKING, {}), (IDLE, {})):
            _checkin(tmp_path, "0300", screen, runs=2, **more)
        _checkin(tmp_path, "0300", IDLE, runs=1, checked=False)
        tr.write_text("not a try\n")
        _checkin(tmp_path, "0300", IDLE, runs=1)
        assert (tmp_path / "checkin.try.unread").exists() and not tr.exists()
        _checkin(tmp_path, "0300", IDLE, runs=3)
    finally:
        del os.environ["RELAY_QUEUE"], os.environ["RELAY_BAD"]


def test_a_checkin_that_missed_its_hour_is_named_in_the_next(tmp_path):
    """Never silent (Cain's third service review): check-ins that couldn't go in within their hour (his
    screen wasn't at his prompt) are named in the next one, as a count and a range, from the last one
    that went in (kept apart from the week-old marks, so no gap is too long to name: Cain's fourth
    service review, fix soon 9). A first start, with no check-in yet, names none."""
    first = _checkin(tmp_path, "1740", IDLE, day="2026-11-07")
    assert "Scheduled check-in" in first and "didn't reach you" not in first        # the first ever
    assert (tmp_path / "checkin.last").read_text() == "2026-11-07-1730\n"
    assert _checkin(tmp_path, "0712", AUTO_MODE_OFFER) == first                    # not at his prompt
    line = _said(tmp_path, _checkin(tmp_path, "1240", IDLE).splitlines()[-2])
    assert ("Check-ins that didn't reach you (your screen wasn't at your prompt within their hour): 1, today at 7:10 AM."
            in line) and "(1230)" in line
    assert "didn't reach you" not in _said(tmp_path, _checkin(tmp_path, "1740", IDLE).splitlines()[-2])   # once
    assert "didn't reach you" not in _said(tmp_path, _checkin(tmp_path, "0712", IDLE, day="2026-11-09").splitlines()[-2])
    # Two missed in a row: a count and a range.
    assert _checkin(tmp_path, "1240", AUTO_MODE_OFFER, day="2026-11-09").count(" -l ") == 4
    line = _said(tmp_path, _checkin(tmp_path, "0712", IDLE, day="2026-11-10").splitlines()[-2])
    assert "didn't reach you (your screen wasn't at your prompt within their hour): 2, from yesterday at 12:30 PM to yesterday at 5:30 PM." in line
    assert "didn't reach you" not in _said(tmp_path, _checkin(tmp_path, "1240", IDLE, day="2026-11-10").splitlines()[-2])
    # A long gap (the App down for days, the week-old marks gone): all of it, counted.
    import shutil as _sh
    _sh.rmtree(tmp_path / "done")
    line = _said(tmp_path, _checkin(tmp_path, "1740", IDLE, day="2026-11-24").splitlines()[-2])
    assert "within their hour): 42, from Nov 10 at 5:30 PM to today at 12:30 PM." in line
    # Before this App kept the last one: the newest check-in mark stands in for it.
    (tmp_path / "checkin.last").unlink()
    line = _said(tmp_path, _checkin(tmp_path, "1240", IDLE, day="2026-11-25").splitlines()[-2])
    assert "within their hour): 2, from yesterday at 5:30 PM to today at 7:10 AM." not in line   # 1730 went in
    assert "within their hour): 1, today at 7:10 AM." in line


def test_a_relayed_record_is_typed_as_written_or_set_aside(tmp_path):
    """Outside round 20: a relayed record's text goes as written, a line end in it a space, never
    words run together; a record that can't be read is never dropped: set aside, kept in relay.bad,
    and Cain hears at the next check-in, once."""
    import json
    import os
    import shutil
    if not shutil.which("jq"):
        pytest.skip("no jq")
    q, work, bad = tmp_path / "relay.queue", tmp_path / "relay.queue.work", tmp_path / "relay.bad"
    os.environ["RELAY_QUEUE"], os.environ["RELAY_BAD"] = str(q), str(bad)
    try:
        q.write_text(json.dumps({"text": "Approve\nNOT approve"}) + "\n", newline="\n")
        out = _checkin(tmp_path, "0300", IDLE)
        assert _typed(out.splitlines()[-2]) == "Relayed by the add-on: Approve NOT approve"
        q.write_text('{"text": "Ship PR 18"\n{"text": "after it"}\n', newline="\n")
        out = _checkin(tmp_path, "0300", IDLE, runs=4)
        assert bad.read_text() == '{"text": "Ship PR 18"\n' and work.read_text().strip() == ""
        assert "after it" in out and "Ship PR 18" not in out
        line = _said(tmp_path, _checkin(tmp_path, "1240", IDLE).splitlines()[-2])
        assert "Relayed records the App couldn't read: 1, set aside unread" in line
        assert "couldn't read" not in _said(tmp_path, _checkin(tmp_path, "1740", IDLE).splitlines()[-2])
        # Two records on one line are no record: set aside whole, nothing of them typed (round 21).
        (tmp_path / "sent.txt").unlink()
        q.write_text('{"text":"Approve"}{"text":"NOT approve"}\n', newline="\n")
        assert _checkin(tmp_path, "0300", IDLE, runs=3) == "" and work.read_text().strip() == ""
        assert bad.read_text().splitlines()[-1] == '{"text":"Approve"}{"text":"NOT approve"}'
        # Its naming survives the App's restart (this container's state gone): the next check-in names
        # it, once (round 21).
        import shutil as _sh
        _sh.rmtree(tmp_path / "state")
        line = _said(tmp_path, _checkin(tmp_path, "0712", IDLE, day="2026-11-09").splitlines()[-2])
        assert "Relayed records the App couldn't read: 1, set aside unread" in line
        assert "couldn't read" not in _said(tmp_path, _checkin(tmp_path, "1240", IDLE, day="2026-11-09").splitlines()[-2])
        # Named ones move on, kept; what's set aside after, even with the file emptied meanwhile, is
        # still named (round 22).
        assert bad.read_text() == "" and len((tmp_path / "relay.bad.named").read_text().splitlines()) == 2
        bad.write_text("")
        q.write_text('{"text": 5}\n', newline="\n")
        _checkin(tmp_path, "0300", IDLE, day="2026-11-09", runs=3)
        assert bad.read_text() == '{"text": 5}\n'
        line = _said(tmp_path, _checkin(tmp_path, "1740", IDLE, day="2026-11-09").splitlines()[-2])
        assert "Relayed records the App couldn't read: 1, set aside unread" in line and bad.read_text() == ""
        assert (tmp_path / "relay.bad.named").read_text().splitlines()[-1] == '{"text": 5}'
    finally:
        del os.environ["RELAY_QUEUE"], os.environ["RELAY_BAD"]


def test_a_relayed_tap_is_typed_in_before_any_checkin(tmp_path):
    import shutil
    if not shutil.which("jq"):
        import pytest
        pytest.skip("no jq")
    q = tmp_path / "relay.queue"
    q.write_text('{"text": "Dane tapped \\"Yes\\" on your question: \\"Book it?\\""}\n'
                 '{"text": "second"}\n', newline="\n")
    import os
    os.environ["RELAY_QUEUE"] = str(q)
    sent = tmp_path / "sent.txt"
    try:
        out = _checkin(tmp_path, "0712", IDLE)
        assert "Relayed by the add-on" in out and 'tapped "Yes"' in out and "morning" not in out
        # The queue was moved aside whole before reading, so a line the link adds now
        # starts a fresh queue instead of being lost, and waits its turn.
        assert not q.exists() and (tmp_path / "relay.queue.work").read_text().strip() == '{"text": "second"}'
        q.write_text('{"text": "third"}\n', newline="\n")
        sent.unlink()
        assert "Relayed by the add-on: second" in _checkin(tmp_path, "0712", IDLE)
        sent.unlink()
        assert "Relayed by the add-on: third" in _checkin(tmp_path, "0712", IDLE)
    finally:
        del os.environ["RELAY_QUEUE"]


def test_cains_morning_update_folds_in_the_digest():
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "/opt/cain/keeper.sh digest" in rules and '/opt/cain/keeper.sh morning "text"' in rules
    assert "ONE summary message, then one message per decision" in rules and "Relayed by the add-on" in rules
    assert "section with \"and N more\"" not in rules        # nothing hidden behind a count
    assert "never in the morning message" in rules and "Never show a card without buttons" in rules
    import json
    allow = json.loads((CAIN / "rootfs/opt/cain/settings.json").read_text())["permissions"]["allow"]
    assert "Bash(/opt/cain/keeper.sh:*)" in allow


def test_cains_addon_sends_calendar_meanings_when_the_file_changes(tmp_path):
    import os, shutil, subprocess
    bash = shutil.which("bash")
    if not bash:
        import pytest
        pytest.skip("no bash")
    f = tmp_path / "calendar-meanings.md"
    f.write_text("| Date | Kind | Meaning |\n|---|---|---|\n| 2026-11-08 | dentist | kids |\n")
    calls = tmp_path / "calls"
    keeper = tmp_path / "keeper.sh"
    keeper.write_text(f"#!/bin/bash\necho \"$@\" >> {calls.as_posix()}\n")
    keeper.chmod(0o755)
    env = {**os.environ, "MEANINGS_FILE": str(f), "MEANINGS_SENT": str(tmp_path / "sent"),
           "MEANINGS_TRIED": str(tmp_path / "tried"), "KEEPER": str(keeper),
           "CHECKIN_DIR": str(tmp_path / "c"), "RELAY_QUEUE": str(tmp_path / "q"),
           "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    script = str(CAIN / "rootfs/opt/cain/checkin.sh")
    for _ in range(2):          # unchanged file: sent once
        subprocess.run([bash, script], env=env, timeout=20)
    assert len(calls.read_text().splitlines()) == 1
    f.write_text(f.read_text() + "| 2026-11-09 | harvest | me |\n")
    subprocess.run([bash, script], env=env, timeout=20)
    assert len(calls.read_text().splitlines()) == 2


def test_cains_addon_sends_the_place_book_when_it_changes(tmp_path):
    import os, shutil, subprocess
    bash = shutil.which("bash")
    if not bash:
        import pytest
        pytest.skip("no bash")
    f = tmp_path / "places.md"
    f.write_text("| Place | Address | Said on |\n|---|---|---|\n| HMLC | 12 Rink Rd, Leesburg, VA | 2026-11-08 |\n")
    calls = tmp_path / "calls"
    keeper = tmp_path / "keeper.sh"
    keeper.write_text(f"#!/bin/bash\necho \"$@\" >> {calls.as_posix()}\n")
    keeper.chmod(0o755)
    env = {**os.environ, "PLACES_FILE": str(f), "PLACES_SENT": str(tmp_path / "sent"),
           "PLACES_TRIED": str(tmp_path / "tried"), "MEANINGS_FILE": str(tmp_path / "none.md"),
           "KEEPER": str(keeper), "CHECKIN_DIR": str(tmp_path / "c"), "RELAY_QUEUE": str(tmp_path / "q"),
           "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    script = str(CAIN / "rootfs/opt/cain/checkin.sh")
    for _ in range(2):          # unchanged file: sent once
        subprocess.run([bash, script], env=env, timeout=20)
    assert [l.split()[0] for l in calls.read_text().splitlines()] == ["places"]
    f.write_text(f.read_text() + "| Gym | skip | 2026-11-09 |\n")
    subprocess.run([bash, script], env=env, timeout=20)
    assert [l.split()[0] for l in calls.read_text().splitlines()] == ["places", "places"]


def test_cain_installs_codex_pinned_and_checked():
    docker = (CAIN / "Dockerfile").read_text()
    assert re.search(r"^ARG CODEX_VERSION=\d+\.\d+\.\d+$", docker, re.M)
    for arch in ("AARCH64", "X86_64"):
        assert re.search(rf"^ARG CODEX_SHA_{arch}=[0-9a-f]{{64}}$", docker, re.M), arch
    assert "releases/download/rust-v${CODEX_VERSION}/codex-${TT}-unknown-linux-musl.tar.gz" in docker
    check = docker.index('echo "${CS}  /tmp/codex.tgz" | sha256sum -c -')
    assert check < docker.index("tar -xzf /tmp/codex.tgz")                    # checked before unpacking
    assert "codex --version" in docker and " bubblewrap" in docker
    assert "npm" not in docker                                                # the release binary, not a registry


def test_cain_runs_the_review_runner_with_keys_only_in_its_environment():
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert 'bun "$OPT/review/main.ts"' in run
    block = run.split("# The review runner")[1].split(") &")[0]
    for opt in ("gemini_api_key", "perplexity_api_key", "anthropic_api_key", "review_limit_usd",
                "gemini_monthly_usd", "perplexity_monthly_usd", "anthropic_monthly_usd", "codex_monthly_runs"):
        assert f"opt {opt}" in block, opt
    # Names no other tool reads: Claude Code would switch to an ANTHROPIC_API_KEY.
    assert "ANTHROPIC_API_KEY=" not in run and "export ANTHROPIC_API_KEY" not in run
    assert "GEMINI_API_KEY=" not in run and "PERPLEXITY_API_KEY=" not in run
    for line in run.splitlines():
        if "_KEY" in line:
            assert not re.search(r"\becho\b|\bprintf\b|log\.|set -x", line), line
    assert "set -x" not in run
    main = (CAIN / "rootfs/opt/cain/review/main.ts").read_text(encoding="utf-8")
    assert "delete env[k]" in main and '"REVIEW_ANTHROPIC_KEY"' in main
    codex = (CAIN / "rootfs/opt/cain/review/seats/openai.ts").read_text(encoding="utf-8")
    # Codex gets a fresh environment: no keys, no record, no home of Cain's.
    assert "const env = { PATH:" in codex and "...process.env" not in codex
    assert '"--sandbox", "read-only"' in codex and '"--ephemeral"' in codex and '"--output-schema"' in codex


def test_cain_review_keys_never_reach_logs_or_cain():
    import json
    for name in ("main.ts", "runner.ts", "cli.ts", "seats/common.ts", "seats/gemini.ts",
                 "seats/perplexity.ts", "seats/claude.ts"):
        src = (CAIN / "rootfs/opt/cain/review" / name).read_text(encoding="utf-8")
        for line in src.splitlines():
            if "console.log" in line or "log(" in line:
                assert not re.search(r"keys\.|o\.key|_KEY", line), f"{name}: {line}"
    settings = json.loads((CAIN / "rootfs/opt/cain/settings.json").read_text())["permissions"]
    assert "Read(//data/options.json)" in settings["deny"] and "Read(//data/codex/**)" in settings["deny"]
    assert "Bash(/opt/cain/review.sh:*)" in settings["allow"]
    assert "exec bun /opt/cain/review/cli.ts" in (CAIN / "rootfs/opt/cain/review.sh").read_text()


def test_cain_chatgpt_signin_is_on_the_ingress_page():
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    block = nginx.split("location /codex {")[1].split("}")[0]
    assert "proxy_pass http://unix:/run/cain-web/upstream/codex.sock;" in block       # C1: no port he could take
    # Still Ingress only; the second listen (Cain 0.15.0) serves the Supervisor's /health alone.
    assert nginx.count("listen ") == 2 and "allow 172.30.32.2;" in nginx and block.count("listen") == 0
    page = (CAIN / "rootfs/opt/cain/index.html").read_text()
    assert 'href="codex"' in page and 'href="/codex' not in page
    main = (CAIN / "rootfs/opt/cain/review/main.ts").read_text(encoding="utf-8")
    assert '"/run/cain-web/upstream/codex.sock"' in main
    signin = (CAIN / "rootfs/opt/cain/review/signin.ts").read_text(encoding="utf-8")
    assert '"login", "--device-auth"' in signin and 'cli_auth_credentials_store = "file"' in signin


def test_cain_knows_when_and_how_to_use_reviews():
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    section = rules.split("## Outside reviews")[1].split("\n## ")[0]
    for must in ("/opt/cain/review.sh submit", "/data/review-private-terms.txt", "blocked: privacy",
                 "building, planning, research", "Reviewed: ", "Never ask him to run or check a review",
                 "substituted", "consequential", "needs_facts"):
        assert must in section, must
    assert "reviews/" in rules.split("Rules the keeper enforces")[1].split(";")[0]
    keeper = (CAIN / "rootfs/opt/cain/record/core.ts").read_text(encoding="utf-8")
    assert "projects|reviews)" in keeper


def test_open_cloud_jobs_get_a_nudge_every_15_minutes(tmp_path):
    import os
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    os.environ.update(JOBS_DIR=str(jobs), JOBS_NUDGED=str(tmp_path / "nudged"))
    try:
        assert _checkin(tmp_path, "0300", IDLE) == ""                 # no open job: quiet
        (jobs / "cse_01ABC").write_text("build | Fix the turkey card\n")
        out = _checkin(tmp_path, "0300", IDLE)
        assert "cloud job check" in out and "Not a message from Dane" in out
        assert _checkin(tmp_path, "0301", IDLE) == out                 # not again within 15 min
        (tmp_path / "sent.txt").unlink()
        assert _checkin(tmp_path, "0300", IDLE + "\n  esc to interrupt") == ""   # never mid-task
    finally:
        del os.environ["JOBS_DIR"], os.environ["JOBS_NUDGED"]


def test_build_work_runs_as_cloud_jobs_with_his_go():
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "## Cloud jobs" in rules and "trig_015FTxexzFDZyjYjzw39bPv8" in rules
    assert "trig_015NTtUUC5DN82zDJBwmcq1r" in rules and "SHIP_ROUTINE" not in rules
    assert '"Start" "Not now"' in rules and '"Ship" "Not now"' in rules
    assert "Never\ncreate, update or run any other routine" in rules
    assert "laptop build session" not in rules
    releasing = (ROOT / "RELEASING.md").read_text(encoding="utf-8")
    assert "## Build" in releasing and "## Ship (only after Dane's go)" in releasing
    assert "Never read Cain's App info" in releasing
    # A Build job names its branch; a Ship card carries the full head sha, his tap lands
    # exactly that commit in main (the link, with the one key main takes), and the Ship
    # job only installs it.
    jobs = rules.split("## Cloud jobs")[1].split("\n## ")[0]
    assert "`Branch: claude/<slug>`" in jobs and "Never name a pull\n   request in place of its branch" in jobs
    assert "/opt/cain/keeper.sh ship --item" in jobs and "--head <full head sha>" in jobs
    assert "landed in main at <full head sha>" in jobs and "Never merge or push to main any other way" in jobs
    assert "gh pr merge" not in jobs
    ship = releasing.split("## Ship (only after Dane's go)")[1].split("\n## ")[0]
    assert "full head sha" in ship and "deploy key" in ship and "gh pr merge" not in ship


# The link's signatures, both ways (link/auth.ts and cain_relay.py, C1): one vector both
# languages must give, so neither drifts. cain/tests/link-auth.test.ts checks the same one.
SIG_VECTOR = {
    "key": "a" * 64, "path": "/card", "body": '{"text": "x"}', "t": 1794686000000,
    "id": "ac5e14e39c2294e982a8a34f4e5beaf9",
    "request": "id=ac5e14e39c2294e982a8a34f4e5beaf9,t=1794686000000,s=aa669cbb6222600a41f35eef346f0aa6b625ee988ad85d2baf455e48ce078b3d",
    "response": "s=cb4516fb923369d50bc4b6ba1331f56ed258c0f9e398ffec6071b4f78b302da2",
}


def test_link_signatures_match_the_vector():
    import sys
    sys.path.insert(0, str(ADDON / "app"))
    from harness.cain_relay import request_id, sign_request, sign_response
    v = SIG_VECTOR
    assert request_id("POST", v["path"], v["body"]) == v["id"]
    assert sign_request(v["key"], "POST", v["path"], v["body"], v["t"]) == (v["id"], v["request"])
    assert sign_response(v["key"], v["id"], 200, '{"id": 4}') == v["response"]


def test_an_answer_the_link_didnt_sign_is_no_answer():
    """Anything holding the link's port while it restarts (Cain's own user can bind it)
    gets the signed request but can't sign an answer: the specialist takes none."""
    import sys
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    sys.path.insert(0, str(ADDON / "app"))
    from harness.cain_relay import CainLink, LinkError

    class Squatter(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _answer(self):
            data = b'{"id": 99, "status": "ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("x-harness-sig", "s=" + "0" * 64)
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
            self._answer()

        def do_GET(self):
            self._answer()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Squatter)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        link = CainLink(lambda: "bot-token", host="127.0.0.1", port=httpd.server_address[1])
        with pytest.raises(LinkError):
            link.card("a card", [], "card")
        assert link.status() is None
    finally:
        httpd.shutdown()
