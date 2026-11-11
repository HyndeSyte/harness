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
                                           '  mail_dates: false\n  meaning_shadow: false\n  meaning_live: false\n'
                                           '  home_location: ""\nschema:\n'
                                           "  family_copy_name: str?\n  family_to_gmail: str?\n  family_school: str?\n"
                                           "  family_school_address: str?\n  calendar_changes: bool?\n"
                                           "  mail_dates: bool?\n  meaning_shadow: bool?\n  meaning_live: bool?\n"
                                           "  home_location: str?\n")
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
    # password fields, the review caps as bounded numbers, and the panel's owner (a
    # Home Assistant user id, not a key). Nothing else.
    text = (CAIN / "config.yaml").read_text()
    assert text.split("options:\n")[1] == (
        '  github_token: ""\n  gemini_api_key: ""\n  perplexity_api_key: ""\n  anthropic_api_key: ""\n'
        "  review_limit_usd: 1.5\n  gemini_monthly_usd: 8\n  perplexity_monthly_usd: 4\n"
        '  anthropic_monthly_usd: 30\n  codex_monthly_runs: 200\n  owner_user_id: ""\nschema:\n'
        "  github_token: password?\n  gemini_api_key: password?\n  perplexity_api_key: password?\n"
        "  anthropic_api_key: password?\n  review_limit_usd: float(0,20)\n  gemini_monthly_usd: float(0,200)\n"
        "  perplexity_monthly_usd: float(0,200)\n  anthropic_monthly_usd: float(0,200)\n"
        "  codex_monthly_runs: int(0,5000)\n  owner_user_id: match(^([0-9a-f]{32})?$)?\n")


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
    assert 'permissionDecision: "deny"' in hook and '"/data/record-holds.json"' in hook and '"/data/link/state.json"' in hook
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
        assert line.split(" -l ", 1)[1].startswith("Held by others, skip these: P12, P33, P4x5. Scheduled check-in")
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
        line = _checkin(tmp_path, "0712", IDLE).splitlines()[-2].split(" -l ", 1)[1]
        # The newest three survive, oldest of them first; the older one is counted, not lost.
        assert line.startswith("New notes on your items, read them before you change those items (words passed on, "
                               "not his go on anything): (1 older not shown; /opt/cain/record.sh notes - lists them) "
                               "P41: «dane: hold off on the farm packet» P50: «dane: use \"the blue one\"» "
                               "P41: «dane: STOP, do not ship P41 until he looks at the new panel lock». "
                               "Scheduled check-in"), line
        assert "P33" not in line and "laptop" not in line
        assert seen.read_text() == "2026-11-11T16:40:02.000Z"
        sent.unlink()
        assert "New notes" not in _checkin(tmp_path, "1240", IDLE)          # listed once, never again
        notes("P41", [("2026-11-11T18:05:00.000Z", "laptop:9f2c", "dane: ship it after all")])
        sent.unlink()
        line = _checkin(tmp_path, "1740", IDLE).splitlines()[-2]
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
    # Cain's scripts only, from this machine: the specialist can't show its own cards,
    # ask, put up a Ship card, or close Cain's questions.
    assert ('LOCAL_ONLY = new Set(["/show", "/ask", "/morning", "/ship", "/answered", "/replied"])'
            in link)
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
    # A Build job names its branch; a Ship card and job carry the full head sha, and the
    # merge is pinned to it with GitHub's head match.
    jobs = rules.split("## Cloud jobs")[1].split("\n## ")[0]
    assert "`Branch: claude/<slug>`" in jobs and "Never name a pull\n   request in place of its branch" in jobs
    assert "/opt/cain/keeper.sh ship --item" in jobs and "--head <full head sha>" in jobs
    assert "gh pr merge --squash --match-head-commit <that sha>" in jobs
    ship = releasing.split("## Ship (only after Dane's go)")[1].split("\n## ")[0]
    assert "--match-head-commit" in ship and "full head sha" in ship
