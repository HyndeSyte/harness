#!/bin/bash
# Inside a container of Cain's image, as root (cain/tests/image/c1.sh starts one per step,
# so a new container is a new PID namespace and a new identity, as after the Supervisor's
# restart). /data is the scenario's fake data, /fp its fingerprints, /t this folder.
#   in.sh points            the switch's kill points
#   in.sh template          a fake /data in 0.11.0's layout, with made-up secrets planted
#   in.sh switch [kill]     this start's switch, as the run script decides it (killed at a
#                           point when given); then, in this same container, what uid 1000
#                           can read, and the old tree, are checked. Prints "rc=<n>".
#   in.sh final             the switch is done: state cut, nothing secret readable, the
#                           planted files quarantined, his folders his, the start's checks pass
#   in.sh <scenario>        the named scenarios below
set -uo pipefail
OPT=/opt/cain
D=/data
fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "[image] $*" >&2; }

# The made-up secrets (values only these tests know).
BOT="MTEST0000000000000000000.GtEsT0.TeStbOtToKeNnOtReAl0000000000000"
GH="ghp_TESTONLY0123456789abcdefABCDEF0123456"
GEM="AIzaTESTONLY0123456789abcdefghijklmnopq"
CODEX="eyJTESTONLY.codex.access.token.0123456789abcdefghij"
PEMLINE="TESTONLYPEMLINE0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL"
# The bot token inside a header, base64-encoded as a tool result would show it.
encoded() { printf 'Authorization: Bot %s' "$BOT" | base64 -w0; }
relay() { printf '%s' "$BOT" | bun -e 'const c=require("crypto");let t="";process.stdin.on("data",d=>t+=d).on("end",()=>process.stdout.write(c.createHmac("sha256",t).update("harness-relay-v1").digest("hex")))'; }

prepare() {
  # Each container starts as the run script does: /run/cain, the keys, options 0600.
  "$OPT/c1/lock.sh" run >/dev/null 2>&1 || fail "lock.sh run"
  # The parts of the first start CI can't do for real: the Discord login (a stand-in plugin
  # server that says it connected) and the channel smoke test (the real broker and bridge
  # with the stand-in server, driven by a fake client in place of Claude Code).
  cp /t/stub-smoke.sh "$OPT/c1/smoke.sh" && chmod 0755 "$OPT/c1/smoke.sh"
  export C1_LOGIN_PLUGIN="/t/stub-plugin${STUB_LOGIN_FAIL:+-fail}"
  printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' "$BOT" "$GH" "$GEM" "$CODEX" "$PEMLINE" "$(relay)" "$(encoded)" > /needles
  chmod 0644 /needles
}

# Nothing of the planted secrets is readable by uid 1000 anywhere a process writes. Its search
# first proves it can see: a control file it can read, holding a planted value, must be found
# (else the check itself is blind), and is then removed.
secret_hits() { setpriv --reuid=1000 --regid=1000 --init-groups grep -rlFa -D skip -f /needles $D /run /tmp /var/tmp /etc /root /home 2>/dev/null; }
secret_free() {
  local hits control=/tmp/c1-control-$$
  printf 'control %s\n' "$GH" > "$control"; chmod 0644 "$control"
  hits="$(secret_hits)"
  rm -f "$control"
  printf '%s\n' "$hits" | grep -qx "$control" || fail "the secret check didn't find its own control file: it can't be trusted"
  hits="$(printf '%s\n' "$hits" | grep -vx "$control" | grep -v '^$')"
  [ -z "$hits" ] || fail "uid 1000 can read a secret: $(printf '%s' "$hits" | head -n 3 | tr '\n' ' ')"
}

uid_procs() {
  local p st ids
  for p in /proc/[0-9]*; do
    st="$(awk '/^State:/{print $2; exit}' "$p/status" 2>/dev/null)"; case "$st" in Z|X|"") continue ;; esac
    ids=" $(awk '/^Uid:/{print $2, $3, $4, $5; exit}' "$p/status" 2>/dev/null) "
    case "$ids" in *" 1000 "*|*" 1001 "*) echo "${p#/proc/} $(tr '\0' ' ' < "$p/cmdline" | cut -c1-80)" ;; esac
  done
}

# The old tree's contents and owners (not modes: the switch tightens those first).
old_print() { (cd $D && find .claude .claude.json work -printf '%p|%y|%U|%G|%s|%l\n' 2>/dev/null | sort; find .claude .claude.json work -type f -exec sha256sum {} + 2>/dev/null | sort -k2); }

case "${1:-}" in
points) exec "$OPT/c1/cutover.sh" points ;;
template)
  rm -rf "${D:?}"/* "$D"/.[!.]* 2>/dev/null
  chmod 0755 $D
  install -d -m 0755 $D/.claude/projects/-data-work $D/.claude/plugins/cache $D/.claude/channels/discord/inbox $D/work/.claude $D/work/notes $D/trust $D/record/state
  printf '{"github_token": "%s", "gemini_api_key": "%s", "perplexity_api_key": "", "anthropic_api_key": "", "owner_user_id": "x"}\n' "$GH" "$GEM" > $D/options.json
  chmod 0600 $D/options.json
  printf '{"claudeAiOauth": {"accessToken": "sk-ant-oat01-his-own-sign-in-not-a-needle"}}\n' > $D/.claude/.credentials.json; chmod 0600 $D/.claude/.credentials.json
  printf '{"type":"user","message":"hello"}\n{"type":"tool_result","content":"DISCORD_BOT_TOKEN=%s"}\n' "$BOT" > $D/.claude/projects/-data-work/leaked.jsonl
  printf '{"type":"user","message":"a plain day"}\n' > $D/.claude/projects/-data-work/plain.jsonl
  # Past exact copies (C1 review service, theme 3): the token base64-encoded in a transcript, a
  # repository whose history once held a key (taken out since), and a cache of commands' output.
  printf '{"type":"tool_result","content":"%s"}\n' "$(encoded)" > $D/.claude/projects/-data-work/encoded.jsonl
  install -d $D/work/proj $D/.claude/shell-snapshots
  printf 'export SNAP_KEY=%s\n' "$GH" > $D/.claude/shell-snapshots/snapshot-bash.sh
  ( cd $D/work/proj && git init -q && printf 'key %s\n' "$GEM" > conf.txt \
    && git -c user.name=t -c user.email=t@t add . && git -c user.name=t -c user.email=t@t commit -qm one \
    && printf 'nothing\n' > conf.txt && git -c user.name=t -c user.email=t@t commit -qam two ) >/dev/null || fail "the template's repository"

  printf '{}\n' > $D/.claude/settings.json
  printf 'cache\n' > $D/.claude/plugins/cache/x
  printf 'DISCORD_BOT_TOKEN=%s\n' "$BOT" > $D/.claude/channels/discord/.env; chmod 0600 $D/.claude/channels/discord/.env
  printf '{"dmPolicy": "allowlist", "allowFrom": ["100000000000000009"], "groups": {}}\n' > $D/.claude/channels/discord/access.json
  printf 'a picture\n' > $D/.claude/channels/discord/inbox/photo.png
  printf 'the key is %s\n' "$GEM" > $D/.claude/channels/discord/inbox/leak.txt
  printf '{"projects": {"/data/work": {"hasTrustDialogAccepted": true}}}\n' > $D/.claude.json
  cp $OPT/legacy/CLAUDE.md $D/work/CLAUDE.md; cp $OPT/legacy/settings.json $D/work/.claude/settings.json
  printf '{"at": 1}\n' > $D/work/gate-report.jsonl; printf '{}\n' > $D/work/gate-tries.json
  printf 'his notes\n' > $D/work/notes/today.md
  printf 'token %s in a scratch file\n' "$GH" > $D/work/leak-work.txt
  ln -s /data/options.json $D/work/notes/options-link
  printf '{"written_at": 1, "owner": "100000000000000009", "dm": "100000000000000001", "cards": [], "sent": []}\n' > $D/trust/cards.json
  printf '| Item |\n' > $D/record/state/PENDING.md
  install -d -m 0700 $D/link $D/codex
  printf 'ready\n' > $D/link/specialist-signs; chmod 0600 $D/link/specialist-signs
  # The old way's listing of his claude.ai connectors went through (the run script); CI has no
  # sign-in, so it named none.
  install -d -m 0700 $D/c1 && printf 'listed\n' > $D/c1/connectors-before && chmod 0600 $D/c1/connectors-before
  printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$PEMLINE" > $D/link/ship.key; chmod 0600 $D/link/ship.key
  printf '{"tokens": {"access_token": "%s"}}\n' "$CODEX" > $D/codex/auth.json; chmod 0600 $D/codex/auth.json
  : > $D/session.log; : > $D/relay.queue
  old_print > /fp/old.txt
  note "template made"
  ;;
switch)
  prepare
  # The run script's decision for this start (services.d/cain/run): switch while it may.
  state="$("$OPT/c1/state.sh")"; rc=1
  if [ "$state" = fresh ] || [ "$state" = switching ]; then
    for try in 1 2 3; do
      C1_KILL_AT="${2:-}" "$OPT/c1/cutover.sh" 2>>/fp/switch.log; rc=$?
      case "$rc" in 0|2|3|4|137) break ;; esac
      [ "$("$OPT/c1/state.sh")" = fresh ] || break
      bun "$OPT/c1/tools.ts" may-retry $D/c1/failed || break
    done
  elif [ "$state" = cut ]; then rc=0         # already switched (a kill came after the state file)
  else rc="state:$state"; fi
  # Checked in this same container, whatever happened: no planted secret readable by uid 1000
  # once the switch has locked /data (from "locked" on, the only time a process of his can
  # run: before it, 0.11.0's layout is open to others by design and nothing of his runs; an
  # undo leaves the modes locked, so after one it holds too); no process of his left after a
  # switch that went on past validation; before the commit, the old tree as it was.
  at="$(bun "$OPT/c1/tools.ts" journal-check $D/c1/journal 2>/dev/null || true)"
  case "$at" in
    locked|staged|scrubbed|validated|commit|committed) secret_free ;;
    *) if [ "$rc" != 137 ] && [ -f $D/c1/failed ]; then secret_free; fi ;;   # undone: still locked
  esac
  [ ! -f $D/c1/state ] || secret_free
  case "$at:${2:-}" in validated:*|commit:*|committed:*|*:quiesce-1|*:j-validated-0) [ -z "$(uid_procs)" ] || fail "a process of uid 1000 or 1001 outlived the validation: $(uid_procs | head -n 2)" ;; esac
  if [ "$rc" != 0 ] && ! grep -q '^commit ' $D/c1/journal 2>/dev/null && [ ! -f $D/c1/state ]; then
    diff <(old_print) /fp/old.txt >/dev/null || fail "the old tree changed before the commit: $(diff <(old_print) /fp/old.txt | head -n 4 | tr '\n' ' ')"
  fi
  # A container where uid 1000 ran never runs the old way (the run script's check).
  if [ "$rc" = 4 ]; then [ "$(head -c 200 $D/c1/uid1000-ran)" = "$(bun "$OPT/c1/tools.ts" container-id)" ] || fail "exit 4 without this container on record"; fi
  echo "rc=$rc"
  ;;
final)
  prepare
  [ "$("$OPT/c1/state.sh")" = cut ] || fail "not cut over: $("$OPT/c1/state.sh")"
  secret_free
  for q in cain/.claude/projects/-data-work/leaked.jsonl cain/.claude/projects/-data-work/encoded.jsonl work/leak-work.txt work/proj/.git discord/inbox/leak.txt; do
    [ -e "$D/c1/quarantine/$q" ] || [ -n "$(ls -d "$D/c1/quarantine/$q".* 2>/dev/null)" ] || fail "not quarantined: $q"
  done
  [ ! -e $D/cain/.claude/shell-snapshots ] || fail "the shell snapshots came along to his home"
  [ -f $D/work/proj/conf.txt ] || fail "his repository's files didn't stay"
  # The check of his own user, as the start runs it (without the running stack here), with the
  # bot token in a running process of the discord user's (as the broker starts the plugin): it
  # holds, since his user sees the token in no command line and no environment. And it isn't
  # blind: the token's variable in a process of his own is found (C1 review service, themes 4, 8).
  holder() { setpriv --reuid="$1" --regid="$1" --init-groups --no-new-privs env -i PATH=/usr/bin:/bin DISCORD_BOT_TOKEN="$BOT" bash -c 'exec sleep 30' & }
  checked() { "$OPT/as-cain" env C1_CHECK_NO_LINK=1 bun "$OPT/c1/check.ts" | tail -n 1; }
  holder discord; h=$!; sleep 1
  out="$(checked)"; kill "$h" 2>/dev/null; wait "$h" 2>/dev/null
  [ "$(printf '%s' "$out" | jq -r .ok)" = true ] || fail "the check of his own user failed: $out"
  # Its inventory: 35 checks need nothing running, and the 10 of the Supervisor, the sockets and
  # the link make the 45 check.sh requires of a pass (C1_CHECK_MIN). A change here changes both.
  [ "$(printf '%s' "$out" | jq -r .checks)" = 35 ] || fail "the check's inventory isn't 35 without the link: $out"
  grep -q 'MIN="${C1_CHECK_MIN:-45}"' "$OPT/c1/check.sh" || fail "check.sh doesn't require the 45 checks of a pass"
  # His screen, read with the image's own awk (prompt-state.sh, outside review round 10): his input
  # area, with a background task row under it, is ready; the auto mode offer is a dialog; words
  # that only quote a footer, and an empty screen, are neither.
  seen() { printf "$1" | "$OPT/prompt-state.sh"; }
  [ "$(seen '──────\n> \n──────\n  ⏵⏵ auto mode on (shift+tab to cycle)   ● high\n  ● Explore 40s · ↓ to manage\n')" = ready ] \
    || fail "prompt-state: his input area isn't read as ready"
  [ "$(seen '> /auto-mode-setup\n  Teach auto mode about your environment?\n    Continue\n  ←/→ to change · Enter to continue · Esc to cancel\n')" = dialog ] \
    || fail "prompt-state: the auto mode offer isn't read as a dialog"
  [ "$(seen 'Claude said:\n  For shortcuts, press ?\n')" = other ] && [ "$(seen '')" = other ] \
    || fail "prompt-state: words quoting a footer, or an empty screen, read as more than other"
  [ "$(seen '❯ /permissions\n  ? for shortcuts\n')" = other ] \
    || fail "prompt-state: a draft in his input box read as ready"
  holder cain; h=$!; sleep 1
  out="$(checked)"; kill "$h" 2>/dev/null; wait "$h" 2>/dev/null
  printf '%s' "$out" | jq -e '.ok == false and (.failed | any(test("carries the bot token")))' >/dev/null \
    || fail "the check didn't see the token in a process of his own: $out"
  # His own processes carry no rlimit he can raise past 1024 (as-cain's prlimit).
  [ "$("$OPT/as-cain" bash -c 'ulimit -u')" = 1024 ] || fail "his process limit isn't 1024"
  [ -f $D/cain/.claude/projects/-data-work/plain.jsonl ] || fail "his plain transcript didn't come along"
  [ -f $D/work/notes/today.md ] || fail "his notes didn't stay"
  [ "$(stat -c %U:%a $D/work)" = cain:700 ] && [ "$(stat -c %U:%a $D/cain)" = cain:700 ] || fail "his folders aren't his"
  [ -f $D/gate/report.jsonl ] && [ ! -e $D/work/gate-report.jsonl ] || fail "the gate's log didn't move"
  [ -d $D/c1/before/work ] && [ ! -e $D/c1/before/work.tmp ] || fail "the backup copy isn't whole"
  [ ! -e $D/.claude ] && [ -d $D/c1/before/.claude ] || fail "the old home didn't move"
  "$OPT/c1/lock.sh" managed >/dev/null && "$OPT/c1/lock.sh" data >/dev/null && "$OPT/c1/lock.sh" verify || fail "the start's checks don't pass after the switch"
  # And they catch a root file of his that holds a secret.
  printf '%s\n' "$GH" > $D/trust/oops.json; chmod 0644 $D/trust/oops.json
  if "$OPT/c1/lock.sh" verify 2>/dev/null; then fail "verify missed a secret in a file he can read"; fi
  rm -f $D/trust/oops.json
  # His session can't gain another plugin, or the tools of one (C1 code review C1-3): the image's
  # copy of the marketplace lists the Discord plugin alone, so an install of any other of the
  # official plugins fails, and a new session of his still loads only what the seed and Claude
  # Code itself bring.
  mkt="$OPT/plugin-seed/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json"
  [ "$(jq -r '[.plugins[].name] | join(",")' "$mkt")" = discord ] || fail "the seed's marketplace lists more than the Discord plugin"
  other=telegram
  as_him=("$OPT/as-cain" env CLAUDE_CODE_PLUGIN_SEED_DIR="$OPT/plugin-seed" DISABLE_AUTOUPDATER=1)
  if "${as_him[@]}" timeout 120 claude plugin install "$other@claude-plugins-official" > /fp/install.log 2>&1; then
    fail "his session installed $other: $(tail -n 3 /fp/install.log | tr '\n' ' ')"
  fi
  "${as_him[@]}" ANTHROPIC_API_KEY=sk-ant-api03-ci-only-not-a-real-key timeout 120 claude -p --output-format stream-json --verbose --max-turns 1 "ok" > /fp/after.jsonl 2> /fp/after.err || true
  "$OPT/c1/seed-loaded.sh" /fp/after.jsonl || fail "after the install try, his session didn't load the seed's plugin"
  loaded="$(jq -c 'select(.type == "system" and .subtype == "init") | [.plugins[]? | {name, path}]' /fp/after.jsonl | head -n 1)"
  extra="$(jq -r --arg s "$OPT/plugin-seed/" 'select(.type == "system" and .subtype == "init") | .plugins[]? | select(((.path // "") | startswith($s) or . == "builtin") | not) | "\(.name) \(.path)"' /fp/after.jsonl)"
  [ -z "$extra" ] || fail "his session loaded a plugin from outside the image's seed: $extra"
  note "final checks held ($other couldn't be installed; loaded: $loaded)"
  ;;
alarm)
  # The App's alarms with Discord down (C1 second review, must-fixes 1 and 2), on the switched
  # /data: the check of his own user can't finish here (no link runs, so its routes don't answer):
  # a try the start makes again writes nothing, and the last holds his session and tells Dane. His
  # bot can't post (its token is away), yet Home Assistant's webhook (a stand-in on this machine,
  # at the notice_hook option's id) gets the alarm, with the way back, and never sees the hook on
  # a command line. A breach's alarm replaces it in its group, a failed switch's stands beside
  # it, and each comes down when what it's about clears.
  prepare
  [ "$("$OPT/c1/state.sh")" = cut ] || fail "not cut over: $("$OPT/c1/state.sh")"
  hook="imagetest$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cp $D/options.json /fp/options.before
  jq --arg h "$hook" '.notice_hook = $h' /fp/options.before > $D/options.json && chmod 0600 $D/options.json
  mv $D/link/discord.env /fp/discord.env.away
  : > /fp/hook.log; : > /fp/cmdlines
  bun -e 'const fs = require("fs"); Bun.serve({ hostname: "127.0.0.1", port: 18123, async fetch(r) {
    fs.appendFileSync("/fp/hook.log", new URL(r.url).pathname + " " + (await r.text()) + "\n"); return new Response(""); } });' >/dev/null 2>&1 &
  srv=$!
  # Every command line while the alarms go out, to show the hook is on none of them.
  ( while kill -0 "$srv" 2>/dev/null; do cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\0' ' ' >> /fp/cmdlines; sleep 0.05; done ) &
  sleep 1
  export NOTICE_URL=http://127.0.0.1:18123
  # One try, as the start makes its first four: not yet, nothing written. Then the start's fifth.
  C1_VERSION=9.9.9 C1_UNTRIED=retry "$OPT/c1/check.sh" > /fp/check.out 2>&1; rc=$?
  [ "$rc" = 5 ] && [ ! -e $D/c1/check-held ] || fail "a first try that couldn't finish gave $rc, not 5 (try again), or held him"
  C1_VERSION=9.9.9 "$OPT/c1/check.sh" > /fp/check.out 2>&1; rc=$?
  [ "$rc" = 4 ] || fail "a check that couldn't finish gave $rc, not 4 (held): $(tail -n 2 /fp/check.out | tr '\n' ' ')"
  grep -q "held (not a breach)" /fp/check.out || fail "the check didn't say he's held: $(tail -n 1 /fp/check.out)"
  [ "$(cut -d' ' -f1 $D/c1/check-held)" = 9.9.9 ] && grep -q "the link didn't answer" $D/c1/check-held \
    || fail "the hold isn't on record for this version: $(cat $D/c1/check-held 2>/dev/null)"
  grep -q "^/api/webhook/$hook {\"state\":\"on\",\"group\":\"stop\",\"alarm\":\"held\",\"title\":\"Cain is paused\"" /fp/hook.log \
    || fail "Home Assistant didn't get the pause: $(head -c 300 /fp/hook.log)"
  grep -q "This isn't a breach" /fp/hook.log && grep -q "Settings, System, Backups" /fp/hook.log || fail "the pause didn't say what it is and the way back"
  grep -qx "discord 0" $D/c1/notice.d/stop || fail "his bot posted, with its token away"
  "$OPT/notice.sh" tell switch-failed "the smoke test failed" >/dev/null
  "$OPT/notice.sh" tell breach >/dev/null
  grep -q "\"group\":\"stop\",\"alarm\":\"breach\",\"title\":\"Cain is stopped\"" /fp/hook.log || fail "Home Assistant didn't get the breach's alarm"
  "$OPT/notice.sh" clear running >/dev/null
  grep -q "\"state\":\"clear\",\"group\":\"stop\",\"alarm\":\"breach\",\"title\":\"Cain is back\"" /fp/hook.log || fail "the alarm didn't come down"
  [ ! -e $D/c1/notice.d/stop ] && [ -f $D/c1/notice.d/switch ] || fail "clearing the stop took the wrong alarms down"
  "$OPT/notice.sh" clear switched >/dev/null
  [ ! -e $D/c1/notice.d/switch ] || fail "the failed switch's alarm stayed once he switched"
  # The probe: Home Assistant's automation only notes its time, nobody is notified.
  "$OPT/notice.sh" probe >/dev/null 2>&1 || fail "the probe didn't go"
  grep -q "\"state\":\"test\",\"group\":\"probe\",\"alarm\":\"probe\"" /fp/hook.log && [ -s $D/c1/notice-probed ] || fail "the probe isn't in Home Assistant's log or on record"
  sleep 0.2; kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null
  ! grep -qF "$hook" /fp/cmdlines || fail "the hook was on a command line"
  grep -q "18123" /fp/cmdlines || fail "the command lines weren't watched"
  # While it's set, the hook is a secret value like the App's keys: uid 1000 can read it nowhere,
  # by the start's own check (which counts it among them) and by a search of its own.
  command -v flock >/dev/null || fail "no flock in the image: the alarms take its lock"
  mv /fp/discord.env.away $D/link/discord.env
  "$OPT/c1/lock.sh" verify || fail "the start's check doesn't hold with the hook set"
  hits="$(setpriv --reuid=1000 --regid=1000 --init-groups grep -rlF -D skip -e "$hook" $D /run /tmp /var/tmp /etc /root /home 2>/dev/null || true)"
  [ -z "$hits" ] || fail "uid 1000 can read the hook in $(printf '%s' "$hits" | head -n 2 | tr '\n' ' ')"
  # Back as it was, for the final checks.
  cp /fp/options.before $D/options.json && chmod 0600 $D/options.json
  rm -f $D/c1/check-held $D/c1/notice-probed /fp/hook.log
  note "alarms reached Home Assistant with Discord down ($(wc -l < /fp/check.out) lines from the check)"
  ;;
plant-connector)
  # The old way recorded a claude.ai connector of his (the run script's connector check): CI has
  # no sign-in, so it can't load under his new rules, and the switch must undo itself.
  install -d -m 0700 $D/c1 && printf 'listed\nclaude.ai Gmail\n' > $D/c1/connectors-before && chmod 0600 $D/c1/connectors-before
  ;;
unplant-connector) printf 'listed\n' > $D/c1/connectors-before ;;
unlist-connectors) rm -f $D/c1/connectors-before ;;
journal-there) [ -e $D/c1/journal ] && echo yes || echo no ;;
legacy-here)
  # The old root session ran in this container (the run script put it on record): the switch
  # mustn't begin here.
  prepare
  install -d -m 0700 $D/c1
  bun "$OPT/c1/tools.ts" write-state $D/c1/legacy-ran "$(bun "$OPT/c1/tools.ts" container-id)" || fail "legacy-ran"
  "$OPT/c1/cutover.sh" 2>>/fp/switch.log; rc=$?
  [ ! -e $D/c1/journal ] || fail "a journal was begun in the old session's container"
  echo "rc=$rc"
  ;;
*) fail "usage: in.sh points|template|switch [point]|final|alarm|plant-connector|unplant-connector|unlist-connectors|journal-there|legacy-here" ;;
esac
