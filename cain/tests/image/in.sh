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
relay() { printf '%s' "$BOT" | bun -e 'const c=require("crypto");let t="";process.stdin.on("data",d=>t+=d).on("end",()=>process.stdout.write(c.createHmac("sha256",t).update("harness-relay-v1").digest("hex")))'; }

prepare() {
  # Each container starts as the run script does: /run/cain, the keys, options 0600.
  "$OPT/c1/lock.sh" run >/dev/null 2>&1 || fail "lock.sh run"
  # The parts of the first start CI can't do for real: the Discord login (a stand-in plugin
  # server that says it connected) and the channel smoke test (the real broker and bridge
  # with the stand-in server, driven by a fake client in place of Claude Code).
  cp /t/stub-smoke.sh "$OPT/c1/smoke.sh" && chmod 0755 "$OPT/c1/smoke.sh"
  export C1_LOGIN_PLUGIN="/t/stub-plugin${STUB_LOGIN_FAIL:+-fail}"
  printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$BOT" "$GH" "$GEM" "$CODEX" "$PEMLINE" "$(relay)" > /needles
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
  for q in cain/.claude/projects/-data-work/leaked.jsonl work/leak-work.txt discord/inbox/leak.txt; do
    [ -f "$D/c1/quarantine/$q" ] || [ -n "$(ls "$D/c1/quarantine/$q".* 2>/dev/null)" ] || fail "not quarantined: $q"
  done
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
plant-connector)
  # The old way recorded a claude.ai connector of his (the run script's connector check): CI has
  # no sign-in, so it can't load under his new rules, and the switch must undo itself.
  install -d -m 0700 $D/c1 && printf 'claude.ai Gmail
' > $D/c1/connectors-before && chmod 0600 $D/c1/connectors-before
  ;;
unplant-connector) rm -f $D/c1/connectors-before ;;
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
*) fail "usage: in.sh points|template|switch [point]|final|legacy-here" ;;
esac
