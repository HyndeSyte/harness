"""The add-on package keeps the boundary the design promised."""
import re
from pathlib import Path

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
                                           '  mail_dates: false\n  meaning_shadow: false\n  meaning_live: false\nschema:\n'
                                           "  family_copy_name: str?\n  family_to_gmail: str?\n  family_school: str?\n"
                                           "  family_school_address: str?\n  calendar_changes: bool?\n"
                                           "  mail_dates: bool?\n  meaning_shadow: bool?\n  meaning_live: bool?\n")
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
    for risky in ("map", "ports", "host_network", "privileged", "full_access", "docker_api",
                  "devices", "hassio_role", "image"):
        assert risky not in cfg, risky
    assert cfg["ingress"] == "true" and cfg["ingress_port"] == "8099" and cfg["panel_admin"] == "true"
    assert cfg["init"] == "false"
    # Keys (the record keeper's GitHub token, the review runner's three API keys) as
    # password fields, and the review caps as bounded numbers. Nothing else.
    text = (CAIN / "config.yaml").read_text()
    assert text.split("options:\n")[1] == (
        '  github_token: ""\n  gemini_api_key: ""\n  perplexity_api_key: ""\n  anthropic_api_key: ""\n'
        "  review_limit_usd: 1.5\n  gemini_monthly_usd: 8\n  perplexity_monthly_usd: 4\n"
        "  anthropic_monthly_usd: 30\n  codex_monthly_runs: 200\nschema:\n"
        "  github_token: password?\n  gemini_api_key: password?\n  perplexity_api_key: password?\n"
        "  anthropic_api_key: password?\n  review_limit_usd: float(0,20)\n  gemini_monthly_usd: float(0,200)\n"
        "  perplexity_monthly_usd: float(0,200)\n  anthropic_monthly_usd: float(0,200)\n"
        "  codex_monthly_runs: int(0,5000)\n")


def test_cain_writes_the_record_only_through_the_keeper(tmp_path):
    import json, shutil, subprocess
    s = json.loads((CAIN / "rootfs/opt/cain/settings.json").read_text())["permissions"]
    for tool in ("create_or_update_file", "push_files", "delete_file", "create_branch", "merge_pull_request"):
        assert f"mcp__claude_ai_GitHub__{tool}" in s["deny"]
    assert "Bash(/opt/cain/record.sh:*)" in s["allow"]
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "/opt/cain/record.sh submit" in rules and "only through the record keeper" in rules
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert "bun /opt/cain/record/main.ts" in run and "bashio::config 'github_token'" in run
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


def test_cain_versions_agree_and_everything_is_pinned():
    cfg = flat_yaml(CAIN / "config.yaml")
    docker = (CAIN / "Dockerfile").read_text()
    assert f'io.hass.version="{cfg["version"]}"' in docker
    assert f"## {cfg['version']}" in (CAIN / "CHANGELOG.md").read_text()
    base = re.search(r"ARG BUILD_FROM=(\S+)", docker).group(1)
    assert re.fullmatch(r"ghcr\.io/home-assistant/base-debian:trixie-\d{4}\.\d{2}\.\d+", base)
    assert (CAIN / "build.yaml").read_text().count(base) == 2
    assert re.search(r"ARG CLAUDE_VERSION=\d+\.\d+\.\d+$", docker, re.M)
    assert re.search(r"ARG BUN_VERSION=\d+\.\d+\.\d+$", docker, re.M)
    assert "sha256sum -c" in docker and "ENV DISABLE_AUTOUPDATER=1" in docker


def test_cain_terminal_is_reachable_only_through_ingress():
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    assert "allow 172.30.32.2;" in nginx and "deny all;" in nginx
    assert nginx.count("listen ") == 1 and "listen 8099 " in nginx
    term = (CAIN / "rootfs/etc/services.d/terminal/run").read_text()
    assert "--interface 127.0.0.1" in term


def test_cain_start_survives_bashio_errexit():
    # bashio runs with errexit: a command that fails on a clean start (no old
    # session to kill) must not end the script. 0.1.0 and 0.1.1 died here.
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert "kill-session -t cain 2>/dev/null || true" in run


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


def test_cain_signin_page_is_served_from_tmp():
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    assert "location = /signin" in nginx and "alias /tmp/signin.html;" in nginx


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
    status = run.split("printf '{\"signed_in\"")[1].split("> /tmp/status.tmp")[0]
    assert "$screen" not in status and "$last" not in status
    assert status.count("$(flag ") == 4 and '"$state"' in status
    states = {line.split("state=")[1].split(";")[0].strip() for line in run.splitlines() if "state=" in line and "then state=" in line}
    assert states == {"login_needed", "waiting_for_code", "trust_prompt", "first_run_menu", "ready"}
    nginx = (CAIN / "rootfs/etc/nginx/nginx.conf").read_text()
    assert "location = /status {" in nginx and "alias /tmp/status.json;" in nginx


def test_cain_tells_the_owner_once_when_its_signin_expires():
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert 'state" = login_needed ] && [ ! -f /data/alerted-login ]' in run
    assert "touch /data/alerted-login" in run and "rm -f /data/alerted-login" in run
    alert = (CAIN / "rootfs/opt/cain/alert.sh").read_text()
    code = "\n".join(l for l in alert.splitlines() if not l.strip().startswith("#"))
    # The token is only written to a private header file, then dropped.
    assert code.count("$token") == 2 and "umask 077" in code and "unset token" in code
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
    assert f'url="http://0fcc2575-harness:{handover.PORT}/$cmd"' in code
    assert 'url="http://127.0.0.1:8097/$cmd"; ctx=harness-relay-v1' in code
    for route in ("handover", "digest"):
        assert f"/{route}" in handover.ROUTES
    # Nothing of his is passed: only Cain's own suggestion and who Cain is paired with.
    assert "{suggestion: $s, paired: $p}" in code
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "/opt/cain/keeper.sh handover" in rules and "never change a calendar yourself" in rules
    assert "exec /opt/cain/keeper.sh handover" in (CAIN / "rootfs/opt/cain/handover.sh").read_text()
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert "cp /opt/cain/settings.json /data/work/.claude/settings.json" in run


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


def _checkin(tmp_path, now, screen):
    import os
    import shutil
    import subprocess
    bash = shutil.which("bash")
    if not bash:
        import pytest
        pytest.skip("no bash")
    stub = tmp_path / "bin"
    stub.mkdir(exist_ok=True)
    (stub / "tmux").write_text(
        "#!/bin/bash\n"
        'if [ "$2" = capture-pane ]; then printf "%s\n" "$STUB_SCREEN"; exit 0; fi\n'
        'printf "%s\n" "$*" >> "$STUB_SENT"\n', newline="\n")
    (stub / "tmux").chmod(0o755)
    sent = tmp_path / "sent.txt"
    env = dict(os.environ, PATH=f"{stub}{os.pathsep}{os.environ['PATH']}",
               CHECKIN_DIR=str(tmp_path / "done"), CHECKIN_NOW=now, CHECKIN_DAY="2026-11-08",
               STUB_SCREEN=screen, STUB_SENT=str(sent))
    script = (CAIN / "rootfs/opt/cain/checkin.sh").read_text().replace("\r\n", "\n")
    subprocess.run([bash, "-c", script], env=env, check=True, timeout=20)
    return sent.read_text() if sent.exists() else ""


IDLE = "> \n  ? for shortcuts            auto mode on"


def test_checkin_fires_once_in_its_hour_and_only_when_cain_is_idle(tmp_path):
    out = _checkin(tmp_path, "0712", IDLE)
    assert "morning" in out and "Not a message from Dane" in out and "Enter" in out
    assert _checkin(tmp_path, "0730", IDLE) == out                 # once a day per slot
    assert "1230" in _checkin(tmp_path, "1240", IDLE).splitlines()[-2]


def test_checkin_waits_while_cain_works_or_outside_its_hours(tmp_path):
    assert _checkin(tmp_path, "0712", IDLE + "\n  esc to interrupt") == ""
    assert _checkin(tmp_path, "0815", IDLE) == ""                  # the hour has passed
    assert _checkin(tmp_path, "0300", IDLE) == ""
    assert _checkin(tmp_path, "0712", "Do you trust the files in this folder?") == ""


def test_cain_checks_in_on_his_own_record():
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert "/opt/cain/checkin.sh" in run
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "## Check-ins" in rules and "state/PENDING.md" in rules
    assert "never his go on anything" in rules
    assert " tzdata " in (CAIN / "Dockerfile").read_text()


def test_taps_and_reactions_reach_cain_with_the_relay_key():
    import sys
    sys.path.insert(0, str(ADDON / "app"))
    from harness import cain_relay
    link = (CAIN / "rootfs/opt/cain/link/main.ts").read_text(encoding="utf-8")
    assert f'key("{cain_relay.KEY_CONTEXT.decode()}")' in link and "timingSafeEqual" in link
    assert f"?? {cain_relay.PORT})" in link and cain_relay.HOST == "0fcc2575-cain"
    # Cain's scripts only, from this machine: the specialist can't show its own cards.
    assert 'LOCAL_ONLY = new Set(["/show", "/ask", "/morning"])' in link
    from harness import handover
    assert f'key("{handover.KEY_CONTEXT.decode()}")' in link
    assert 'toHarness("/press"' in (CAIN / "rootfs/opt/cain/link/core.ts").read_text(encoding="utf-8")
    assert "http://0fcc2575-harness:8098" in link
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    assert "bun /opt/cain/link/main.ts" in run
    assert not re.search(r"^ports", (CAIN / "config.yaml").read_text(), re.M)


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
    try:
        out = _checkin(tmp_path, "0712", IDLE)
    finally:
        del os.environ["RELAY_QUEUE"]
    assert "Relayed by the add-on" in out and 'tapped "Yes"' in out and "morning" not in out
    assert q.read_text().strip() == '{"text": "second"}'


def test_cains_morning_update_folds_in_the_digest():
    rules = (CAIN / "rootfs/opt/cain/CLAUDE.md").read_text(encoding="utf-8")
    assert "/opt/cain/keeper.sh digest" in rules and '/opt/cain/keeper.sh morning "text"' in rules
    assert "ONE message" in rules and "Relayed by the add-on" in rules
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
    assert "bun /opt/cain/review/main.ts" in run
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
    assert "proxy_pass http://127.0.0.1:8096;" in block
    assert nginx.count("listen ") == 1 and "allow 172.30.32.2;" in nginx      # still Ingress only
    page = (CAIN / "rootfs/opt/cain/index.html").read_text()
    assert 'href="codex"' in page and 'href="/codex' not in page
    main = (CAIN / "rootfs/opt/cain/review/main.ts").read_text(encoding="utf-8")
    assert 'hostname: "127.0.0.1"' in main and "8096" in main
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
