# Cain 0.19.2: the run script's background loops (services.d/cain/run), sourced there. The run script runs
# under bashio, which sets errexit, so a loop written "while true; do bun x.ts; sleep 5; done" ended its
# subshell the first time its child exited non-zero (a crash, or a SIGTERM's 143) and that service stayed
# down until the App restarted. keep_running never lets its child's exit end the loop:
#
#   keep_running <name> <pause seconds> <command> [args...]
#
# runs the command again and again, <pause> seconds apart. A non-zero exit is logged once, with its code
# (and the signal, for 129 and up), and the wait before the next start. One that comes within
# KEEP_QUICK_S (30) seconds of its start counts as quick: each quick exit in a row doubles the wait, up
# to KEEP_MAX_S (300), so a child that can't start doesn't spin; a run that lasted longer, or a clean
# exit, puts the wait back to <pause>. A clean exit (0) isn't logged: several of these are periodic
# jobs that end by design. The loop itself keeps the default for SIGTERM (a subshell drops the run
# script's traps), so the App's own stop still ends it.
keep_running() {
  local name="$1" pause="$2" rc started took wait quick=0 why
  shift 2
  while true; do
    started=$SECONDS
    rc=0
    "$@" || rc=$?
    took=$(( SECONDS - started ))
    wait=$pause
    if [ "$rc" -ne 0 ] && [ "$took" -lt "${KEEP_QUICK_S:-30}" ]; then
      quick=$(( quick + 1 ))
      local i=1
      while [ "$i" -lt "$quick" ] && [ "$wait" -lt "${KEEP_MAX_S:-300}" ]; do wait=$(( wait * 2 )); i=$(( i + 1 )); done
      if [ "$wait" -gt "${KEEP_MAX_S:-300}" ]; then wait=${KEEP_MAX_S:-300}; fi
    else
      quick=0
    fi
    if [ "$rc" -ne 0 ]; then
      why="exit code $rc"
      if [ "$rc" -gt 128 ]; then why="$why, signal $(( rc - 128 ))"; fi
      if [ "$quick" -gt 1 ]; then why="$why, $quick quick exits in a row"; fi
      keep_running_log "Cain's $name stopped ($why): starting it again in $wait seconds"
    fi
    sleep "$wait" || true
  done
}
keep_running_log() {
  if declare -F bashio::log.warning >/dev/null 2>&1; then bashio::log.warning "$1" || true
  else printf '[cain] %s\n' "$1" >&2 || true; fi
}
