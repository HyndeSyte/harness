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
    health = (runc.parent / "cain-web" / "www" / "health-down").as_posix()
    # bun: the probe's self-restart answers as the switch says (on: restart), or STUB_DECISION when set,
    # and notes whether the health page's mark stood when it was asked (second round: decide first).
    (bindir / "bun").write_text("#!/bin/bash\n"
                                'case "$2" in self-restart) ' + note + f'; [ -e {health} ] && echo "health-down at decision" >> {calls.as_posix()}; '
                                '[ -z "${STUB_DECISION:-}" ] || { echo "$STUB_DECISION"; exit 0; }; '
                                'case "$4" in on) echo restart;; off) echo off;; *) echo unknown;; esac; exit 0;; esac\n'
                                'case "$2" in container-id) echo boot:1;; esac; exit 0\n')
    whole = tmp_path / "whole.sh"
    text = whole.read_text()
    # The Supervisor, stubbed after the harness's own stubs: its answer to /addons/self/info (STUB_WATCHDOG
    # true or false as the JSON the Supervisor sends, or STUB_SUP_BODY whole) with STUB_SUP_RC as its
    # status, and its restart call (STUB_RESTART_RC: 0 took it, else refused).
    # Fifth round: STUB_SUP_DOWN_AFTER_RESTART makes the Supervisor unreachable (curl's 7) once the restart
    # call was made; STUB_LOG notes the run script's warnings as "log <text>"; STUB_RESTART_HANG makes the
    # restart call hang in the real /bin/sleep (not the harness's quick stub), for 20 seconds at most.
    down = (tmp_path / "supervisor-down").as_posix()
    stubs = ('bashio::log.warning() { [ -z "${STUB_LOG:-}" ] || echo "log $*" >> ' + calls.as_posix() + '; }\n'
             'bashio::api.supervisor() { echo "supervisor $*" >> ' + calls.as_posix() + '; '
             '[ -z "${STUB_SUP_DOWN_AFTER_RESTART:-}" ] || [ ! -e ' + down + ' ] || return 7; '
             'if [ -n "${STUB_SUP_BODY:-}" ]; then printf "%s" "$STUB_SUP_BODY"; '
             'else printf \'{"result":"ok","data":{"watchdog":%s}}\' "${STUB_WATCHDOG:-true}"; fi; return "${STUB_SUP_RC:-0}"; }\n'
             'bashio::addon.restart() { echo "addon-restart" >> ' + calls.as_posix() + '; : > ' + down + '; '
             '[ -z "${STUB_RESTART_HANG:-}" ] || { echo "restart-asked $(date +%s)" >> ' + calls.as_posix() + '; /bin/sleep 20; '
             'echo "restart-returned" >> ' + calls.as_posix() + '; }; '
             'return "${STUB_RESTART_RC:-0}"; }\n')
    marker = "export C1_PROC_ROOT="
    i = text.index("\n", text.index(marker)) + 1
    whole.write_text(text[:i] + stubs + text[i:])
    for d in (runc / "root-tmp", runc.parent / "cain-web" / "www"):
        d.mkdir(parents=True, exist_ok=True)
    cred = tmp_path / "data" / "cain" / ".claude" / ".credentials.json"
    if signed_in:
        cred.parent.mkdir(parents=True, exist_ok=True)
        cred.write_text('{"x": 1}\n')
    else:
        cred.unlink(missing_ok=True)
    if screen:
        (runc.parent / "cain-web" / "www" / "status.json").write_text('{"screen": "%s"}\n' % screen)
    # The panel's status writer chgrps its file to nogroup; a test runner may not be in that group.
    (bindir / "chgrp").write_text("#!/bin/bash\nexit 0\n")
    (bindir / "chgrp").chmod(0o755)
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
    assert "health-down at decision" not in lines, lines[:40]           # 503 only once the decision is restart
    after = lines[lines.index(asked[0]):]
    assert any(l.startswith("setpriv --reuid=1000") for l in after), lines[:40]   # his session ended
    # The Supervisor's own restart call first (the primary route); here it never stops the App, so after
    # its wait the App takes the exit route.
    assert "addon-restart" in after, lines[:40]
    assert "notice.sh tell exited" not in lines


def test_a_refused_restart_call_takes_the_exit_route_at_once(tmp_path):
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 660}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: False, timeout=15,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1", STUB_RESTART_RC="1",
                                   C1_SELF_STOP_WAIT_S="3600")
    assert not alive, lines[:40]
    assert "addon-restart" in lines and (runc / "self-restart").exists()
    assert (runc.parent / "cain-web" / "www" / "health-down").exists()


def test_a_restart_call_that_hangs_past_its_bound_waits_before_the_exit_route(tmp_path):
    """Fourth round, the third outside review's first finding: a restart call with no answer within its
    bound (124) may still be carried out by the Supervisor, so the App waits the same 2 minutes
    (C1_SELF_STOP_WAIT_S, 4 seconds here) before it takes the exit route, instead of exiting at once.
    The mark holds the time it was written, before the call. Fifth round: the call hangs in the real
    /bin/sleep (the harness's sleep returns at once, so before, the stand-in never hung and the test held
    for a call that answered too); only the timed-out branch (124) logs that the call wasn't answered, and
    the mark is written again just before the wait."""
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 660}\n")
    # The harness's sleep returns at once; this one also notes the waits this test looks for (the KILL's
    # 5 seconds after the TERM, and the self-stop wait, 7 here) and the exit route's 503 mark as it stands.
    # At the KILL's wait it sets the mark back to an old time, so the self-stop wait shows the re-stamp.
    health = runc.parent / "cain-web" / "www" / "health-down"
    mark = runc / "self-restart"
    sleep = bindir / "sleep"
    sleep.write_text(sleep.read_text().replace("exec /bin/sleep 0.05",
                     f'case "$1" in 5|7) echo "sleep $1 health-down=$([ -e {health.as_posix()} ] && echo yes || echo no)" >> {calls.as_posix()};; esac\n'
                     f'case "$1" in 5) [ -e {mark.as_posix()} ] && [ ! -e {mark.as_posix()}.aged ] && {{ echo 1000 > {mark.as_posix()}; : > {mark.as_posix()}.aged; }};; '
                     f'7) echo "mark at wait $(cat {mark.as_posix()})" >> {calls.as_posix()};; esac\n'
                     "exec /bin/sleep 0.05"))
    t0 = time.time()
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: False, timeout=40,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1",
                                   STUB_RESTART_HANG="1", C1_SELF_CALL_S="1", C1_SELF_STOP_WAIT_S="7", STUB_LOG="1")
    assert not alive, lines[:40]
    asked = [l for l in lines if l.startswith("restart-asked ")]
    assert len(asked) == 1, lines[:40]
    asked_at = int(asked[0].split()[1])
    # After the call ran past its bound: the KILL 5 seconds after the TERM, then the full wait, and only
    # then the exit route (its 503 mark not yet there during either wait, and there at the end).
    i = lines.index(asked[0])
    assert "sleep 5 health-down=no" in lines[i:], lines[i:]
    assert "sleep 7 health-down=no" in lines[i:], lines[i:]
    assert lines.index("sleep 5 health-down=no", i) < lines.index("sleep 7 health-down=no", i)
    assert health.exists() and (runc / "self-restart").exists(), lines[:40]
    # The call really hung and was cut off: it never returned, and the whole run took far less than its 20 s.
    assert "restart-returned" not in lines and time.time() - t0 < 20, lines[i:]
    # Only the timed-out branch (124) logs this; the success and refusal branches log otherwise.
    assert any(l.startswith("log The Supervisor didn't answer the restart call within 30 seconds") for l in lines), lines[i:]
    assert not any("took the restart" in l or "refused the restart call" in l for l in lines), lines[i:]
    # The mark was written again after the call, just before the wait (the KILL's wait had set it to 1000).
    at_wait = [l for l in lines if l.startswith("mark at wait ")]
    assert len(at_wait) == 1 and int(at_wait[0].split()[3]) >= asked_at, lines[i:]
    # The exit route then writes the word fallback, which finish needs to take its 3 for a self-restart.
    assert (runc / "self-restart").read_text().split()[1:] == ["fallback"]
    assert "notice.sh tell exited" not in lines


def test_a_restart_call_that_fails_with_the_supervisor_unreachable_is_logged_apart_and_takes_the_fallback(tmp_path):
    """Fifth round follow-up: a failed restart call (not a timeout) with the Supervisor no longer answering
    is logged as unreachable, not as a refusal, and the exit route follows at once with the fallback's
    word in the mark, so the finish script reports it as a self-restart failure ping and halts."""
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 660}\n")
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: False, timeout=30,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1", STUB_RESTART_RC="1",
                                   STUB_SUP_DOWN_AFTER_RESTART="1", C1_SELF_STOP_WAIT_S="3600", STUB_LOG="1")
    assert not alive, lines[:40]
    logs = [l for l in lines if l.startswith("log ")]
    assert any("the Supervisor doesn't answer (unreachable, not a refusal)" in l for l in logs), logs
    assert not any("refused the restart call" in l for l in logs), logs
    assert "sleep 3600" not in lines
    assert (runc / "self-restart").read_text().split()[1:] == ["fallback"]
    assert "notice.sh tell exited" not in lines


def test_a_refused_restart_call_still_exits_at_once(tmp_path):
    """A definite refusal (any code but 124) takes the exit route with no wait, even with a long one set."""
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 660}\n")
    t0 = time.time()
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: False, timeout=30,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1", STUB_RESTART_RC="2",
                                   C1_SELF_STOP_WAIT_S="3600")
    assert not alive and time.time() - t0 < 30, lines[:40]
    assert "addon-restart" in lines and (runc / "self-restart").exists()
    assert "sleep 3600" not in lines
    assert (runc / "self-restart").read_text().split()[1:] == ["fallback"]


@pytest.mark.parametrize("decision,switch", [("wait", "true"), ("off", "false"), ("unknown", "true")])
def test_the_health_page_stays_200_after_a_wait_off_or_unknown_decision(tmp_path, decision, switch):
    """Second round, the outside review's first finding: the health page's 503 (nginx answers it while
    the mark is there) is set only on a restart decision, so after a wait, off or unknown the mark is
    gone: a mark left by anything before is cleared at the decision, and none is set before it."""
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"down {int(time.time()) - 660}\n")
    health = runc.parent / "cain-web" / "www" / "health-down"
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: bool(_self_calls(l)) and sum("new-session" in x for x in l) >= 2,
                                   timeout=30, C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_CHANNEL_DOWN_S="1",
                                   STUB_WATCHDOG=switch, STUB_DECISION=decision, C1_SELF_RETRY_S="3600")
    assert alive, err
    assert _self_calls(lines), lines[:40]
    assert "health-down at decision" not in lines, lines[:40]
    assert not health.exists(), lines[:40]
    assert not (runc / "self-restart").exists() and "addon-restart" not in lines


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
                                   STUB_SUP_BODY="", STUB_SUP_RC="1", C1_SELF_RETRY_S="0")
    assert alive, err
    asked = _self_calls(lines)
    assert asked and all(a.split()[4] == "unknown" for a in asked), lines[:40]


def _switch(tmp_path, body, rc=0, sleep_s=0):
    """watchdog_switch (and run_bounded) from the run script, alone, against a stubbed Supervisor."""
    import subprocess
    from test_addon import CAIN, _run_fns
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    fns = _run_fns(run, "run_bounded() {", "# His screen waits on the owner's one-time sign-in")
    script = ("nap() { sleep \"$1\"; }\n"
              f"bashio::api.supervisor() {{ sleep {sleep_s}; printf '%s' \"$BODY\"; return {rc}; }}\n"
              f"export TMPDIR={tmp_path.as_posix()}\n" + fns + "\nwatchdog_switch\n")
    r = subprocess.run(["bash", "-c", script], env={**os.environ, "BODY": body}, capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


def test_the_switch_reads_only_a_successful_strict_answer(tmp_path):
    """Second round, the sixth finding: the switch reads on only from the Supervisor's own JSON with
    result ok and a boolean data.watchdog; an error body that contains the word true, a failed call,
    a string "true", text, or no answer is unknown."""
    _needs_posix()
    ok = lambda v: '{"result":"ok","data":{"watchdog":%s,"slug":"cain"}}' % v
    assert _switch(tmp_path, ok("true")) == "on"
    assert _switch(tmp_path, ok("false")) == "off"
    assert _switch(tmp_path, '{"result":"error","message":"it is true that the watchdog failed"}') == "unknown"
    assert _switch(tmp_path, '{"result":"error","message":"true"}', rc=1) == "unknown"
    assert _switch(tmp_path, ok("true"), rc=1) == "unknown"              # the call itself failed
    assert _switch(tmp_path, "true") == "unknown"
    assert _switch(tmp_path, ok('"true"')) == "unknown"
    assert _switch(tmp_path, '<html>502 true gateway</html>') == "unknown"
    assert _switch(tmp_path, "") == "unknown"


def test_a_connected_channel_never_restarts_the_app(tmp_path):
    _needs_posix()
    calls, stop, bindir, runc = _start(tmp_path)
    runc.mkdir(parents=True, exist_ok=True)
    (runc / "discord.state").write_text(f"connected {int(time.time()) - 3600}\n")
    # Waits for the second clear: it follows "clear switched" in the same turn of the loop.
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: "notice.sh clear selfrestart" in l,
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


def test_the_sign_in_wait_reads_the_screen_the_panels_real_writer_keeps(tmp_path):
    """Second round, the second finding: the "screen" key waiting_signin reads is the one the panel's
    status loop writes, and nothing is pre-written here: his screen shows the code prompt, the real
    writer keeps "waiting_for_code", and his session is never restarted for its channel."""
    _needs_posix()
    from test_addon import CAIN
    run = (CAIN / "rootfs/etc/services.d/cain/run").read_text()
    writer = run[run.index("printf '{\"signed_in\""):run.index("/run/cain-web/www/status.json || true")]
    assert '"screen": "%s"' in writer and "/run/cain-web/www/status.tmp" in writer
    reader = run[run.index("waiting_signin() {"):run.index("self_exit() {")]
    assert "jq -r '.screen // empty' /run/cain-web/www/status.json" in reader
    for state in ("login_needed", "waiting_for_code", "first_run_menu", "trust_prompt"):
        assert f"state={state}" in run and state in reader
    # $CRED is set for both ways of running before the loop reads it.
    assert run.count("  CRED=/data/") == 2 and run.index("  CRED=/data/") < run.index("waiting_signin() {")
    as_cain = ('case "$*" in *capture-pane*) printf "Paste code here if prompted\\n"; exit 0;; esac\n' + _session_up(tmp_path))
    calls, stop, bindir, runc = _start(tmp_path, as_cain=as_cain, signed_in=True)
    status = runc.parent / "cain-web" / "www" / "status.json"
    assert not status.exists()
    alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: False, timeout=8,
                                   C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_FIRST_CONNECT_S="1", C1_SELF_RESTART_S="1")
    assert alive, err
    import json
    assert json.loads(status.read_text())["screen"] == "waiting_for_code"
    assert sum("new-session" in l for l in lines) == 1, lines[:40]
    assert not _self_calls(lines) and not any(l.startswith("setpriv --reuid=1000") for l in lines), lines[:40]


def test_a_sign_in_longer_than_the_10_minutes_then_a_normal_connect_restarts_nothing(tmp_path):
    """Second round, the second finding: a first sign-in that takes longer than the App's 10 minutes
    (scaled: 3 seconds here, the first-connect wait 2) used to restart the App on the first tick after
    it, before the connect wait applied. Now the 10 minutes and the connect wait start again when the
    screen stops waiting, and a channel that connects within the wait restarts nothing."""
    _needs_posix()
    import threading
    calls, stop, bindir, runc = _start(tmp_path, signed_in=False)
    runc.mkdir(parents=True, exist_ok=True)
    cred = tmp_path / "data" / "cain" / ".claude" / ".credentials.json"

    def owner_signs_in_then_it_connects():
        time.sleep(5)                                                      # longer than the scaled 10 minutes
        cred.parent.mkdir(parents=True, exist_ok=True)
        cred.write_text('{"x": 1}\n')
        time.sleep(1)                                                      # within the scaled connect wait
        (runc / "discord.state").write_text(f"connected {int(time.time())}\n")

    t = threading.Thread(target=owner_signs_in_then_it_connects)
    t.start()
    try:
        alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: False, timeout=11,
                                       C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_FIRST_CONNECT_S="2",
                                       C1_SELF_RESTART_S="3", C1_CHANNEL_DOWN_S="1")
    finally:
        t.join()
    assert alive, err
    assert not _self_calls(lines), lines[:40]
    assert sum("new-session" in l for l in lines) == 1, lines[:40]
    assert not any(l.startswith("setpriv --reuid=1000") for l in lines), lines[:40]
    assert not (runc / "self-restart").exists()


def test_without_a_connect_after_the_sign_in_the_wait_still_ends(tmp_path):
    """The same long sign-in, but his channel never connects: his session is restarted once the
    connect wait from the sign-in's end has passed, and nothing sooner."""
    _needs_posix()
    import threading
    calls, stop, bindir, runc = _start(tmp_path, signed_in=False)
    cred = tmp_path / "data" / "cain" / ".claude" / ".credentials.json"
    signed = {}

    def owner_signs_in():
        time.sleep(4)
        cred.parent.mkdir(parents=True, exist_ok=True)
        cred.write_text('{"x": 1}\n')
        signed["at"] = time.time()

    t = threading.Thread(target=owner_signs_in)
    t.start()
    try:
        alive, lines, err = _run_whole(tmp_path, calls, stop, bindir, until=lambda l: sum("new-session" in x for x in l) >= 2,
                                       timeout=20, C1_CHECK_FIRST_S="0", C1_RUNNING_S="0", C1_FIRST_CONNECT_S="2",
                                       C1_SELF_RESTART_S="600")
    finally:
        t.join()
    assert alive, err
    assert sum("new-session" in l for l in lines) >= 2, lines[:40]
    assert time.time() - signed["at"] >= 2
