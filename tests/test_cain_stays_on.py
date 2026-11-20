"""Cain 0.15.0, "Cain stays on Discord": the whole start (services.d/cain/run) on the fake /data of
test_addon.py's harness, for the App restarting itself (B) and the channel watchdog for a first
session (D). The probe's own decisions and marks are tested in cain/tests/stays-on.test.ts; here the
run script's side: when it asks, what it does with each answer, and that it never exits with the
Supervisor's watchdog switch off."""
import os
import shutil
import time

import pytest

from test_addon import _run_whole, _session_up, _whole_start


def _needs_posix():
    if not shutil.which("bash") or not shutil.which("jq") or os.name == "nt":
        pytest.skip("needs bash, jq and a POSIX process model")


def _start(tmp_path, as_cain=None, signed_in=True, screen=None):
    calls, stop, bindir, runc = _whole_start(tmp_path, **{"as-cain": as_cain or _session_up(tmp_path), "c1/check.sh": "exit 0"})
    note = f'echo "$(basename "$0") $*" >> {calls.as_posix()}'
    # bun: the probe's self-restart answers as the switch says (on: restart); everything else as before.
    (bindir / "bun").write_text("#!/bin/bash\n"
                                'case "$2" in self-restart) ' + note + '; case "$4" in on) echo restart;; off) echo off;; *) echo unknown;; esac; exit 0;; esac\n'
                                'case "$2" in container-id) echo boot:1;; esac; exit 0\n')
    whole = tmp_path / "whole.sh"
    text = whole.read_text()
    first, rest = text.split("\n", 1)
    whole.write_text(first + '\nbashio::api.supervisor() { echo "${STUB_WATCHDOG:-true}"; }\n' + rest)
    for d in (runc / "root-tmp", runc.parent / "cain-web" / "www"):
        d.mkdir(parents=True, exist_ok=True)
    if signed_in:
        cred = tmp_path / "data" / "cain" / ".claude" / ".credentials.json"
        cred.parent.mkdir(parents=True, exist_ok=True)
        cred.write_text('{"x": 1}\n')
    if screen:
        (runc.parent / "cain-web" / "www" / "status.json").write_text('{"screen": "%s"}\n' % screen)
    return calls, stop, bindir, runc


def _self_calls(lines):
    return [l for l in lines if l.startswith("bun ") and " self-restart " in l]


def test_a_channel_down_10_minutes_restarts_the_app_once_with_the_switch_on(tmp_path):
    """His channel went down 11 minutes ago and stays down: the App asks the probe, the switch is on,
    and it restarts itself: his session ended, the run script exits on an error (3) for the
    Supervisor's watchdog, the health URL says 503, and no "stopped" alarm (it told its own)."""
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 660}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: False, timeout=15,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1", STUB_WATCHDOG="true")
    assert not alive, lines[:40]
    asked = _self_calls(lines)
    assert len(asked) == 1 and asked[0].split()[2:4] == ["self-restart", "channel-down"] and asked[0].split()[4] == "on", lines[:40]
    assert "his Discord channel has been down 11 minutes" in asked[0]
    assert (runc / "self-restart").exists()
    assert (runc.parent / "cain-web" / "www" / "health-down").exists()
    assert any(l.startswith("setpriv --reuid=1000") for l in lines[lines.index(asked[0]):]), lines[:40]   # his session ended
    assert "notice.sh tell exited" not in lines


def test_three_session_restarts_with_the_channel_down_restart_the_app(tmp_path):
    """The channel down 100 seconds (under the 10 minutes): his session is restarted for it 3 times,
    and with the channel still down after the third the App restarts itself."""
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 100}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: False, timeout=40,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1", STUB_WATCHDOG="true")
    assert not alive, lines[:60]
    asked = _self_calls(lines)
    assert len(asked) == 1 and asked[0].split()[3] == "channel-restarts", lines[:60]
    starts = [i for i, l in enumerate(lines) if "new-session" in l]
    assert len(starts) == 4 and starts[-1] < lines.index(asked[0]), lines[:60]
    assert "notice.sh tell channel his session's Discord channel has been down" in " ".join(lines)
    assert (runc / "self-restart").exists()


def test_with_the_switch_off_the_app_never_exits_and_keeps_restarting_his_session(tmp_path):
    """The Supervisor's watchdog switch is off: a restart would leave the App down, so it stays up,
    restarts his session instead, and asks again only after its minute."""
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 660}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: sum("new-session" in x for x in l) >= 4,
                                   timeout=40, C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1",
                                   STUB_WATCHDOG="false", C1_SELF_RETRY_S="3600")
    assert alive, err
    asked = _self_calls(lines)
    assert len(asked) == 1 and asked[0].split()[4] == "off", lines[:40]
    assert sum("new-session" in l for l in lines) >= 4
    assert not (runc / "self-restart").exists()


def test_a_supervisor_that_doesnt_answer_is_unknown_and_the_app_stays_up(tmp_path):
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 660}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: sum("new-session" in x for x in l) >= 3,
                                   timeout=40, C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1",
                                   STUB_WATCHDOG="null", C1_SELF_RETRY_S="0")
    assert alive, err
    asked = _self_calls(lines)
    assert asked and all(a.split()[4] == "unknown" for a in asked), lines[:40]


def test_a_connected_channel_never_restarts_the_app(tmp_path):
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"connected {int(time.time()) - 3600}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: "notice.sh clear switched" in l,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1")
    assert alive, err
    assert not _self_calls(lines) and sum("new-session" in l for l in lines) == 1, lines[:40]
    assert "notice.sh clear selfrestart" in lines


# -- D: the channel watchdog for a first session ------------------------------------------------------
def test_a_signed_in_first_session_that_never_connects_is_restarted_within_minutes(tmp_path):
    """No channel state at all in this container (the broker never saw a connection): a session that
    is signed in is restarted after C1_FIRST_CONNECT_S (3 minutes on the Pi; 1 second here)."""
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path, signed_in=True)
    assert not (runc / "discord.state").exists()
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: sum("new-session" in x for x in l) >= 2,
                                   timeout=30, C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_FIRST_CONNECT_S="1")
    assert alive, err
    assert sum("new-session" in l for l in lines) >= 2, lines[:40]
    assert any(l.startswith("setpriv --reuid=1000") for l in lines), lines[:40]


def test_a_first_session_waiting_on_the_owners_sign_in_is_never_restarted(tmp_path):
    """Not signed in yet (no Claude credentials), or his screen waits at the sign-in: never restarted,
    however long, and the App never restarts itself for it."""
    _needs_posix()
    for signed_in, screen in ((False, None), (True, "waiting_for_code")):
        sub = tmp_path / f"case-{signed_in}"
        sub.mkdir()
        as_cain = ('case "$*" in *capture-pane*) printf "Paste code here if prompted\\n"; exit 0;; esac\n'
                   + _session_up(sub)) if screen else None
        calls, stop, bindir, runc = _start(sub, as_cain=as_cain, signed_in=signed_in, screen=screen)
        alive, lines, err = _run_whole(sub, calls, stop, bindir, until=lambda l: sum("new-session" in x for x in l) >= 2,
                                       timeout=6, C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_FIRST_CONNECT_S="1",
                                       C1_SELF_RESTART_S="1")
        assert alive, err
        assert sum("new-session" in l for l in lines) == 1, (signed_in, lines[:40])
        assert not _self_calls(lines) and not any(l.startswith("setpriv --reuid=1000") for l in lines), (signed_in, lines[:40])
