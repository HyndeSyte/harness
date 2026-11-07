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
                                           '  mail_dates: false\nschema:\n'
                                           "  family_copy_name: str?\n  family_to_gmail: str?\n  family_school: str?\n"
                                           "  family_school_address: str?\n  calendar_changes: bool?\n"
                                           "  mail_dates: bool?\n")
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
                  "devices", "hassio_role", "image", "options", "schema"):
        assert risky not in cfg, risky
    assert cfg["ingress"] == "true" and cfg["ingress_port"] == "8099" and cfg["panel_admin"] == "true"
    assert cfg["init"] == "false"


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
