# shellcheck shell=bash
# The version of Cain installed now (Cain 0.19.3), as the Supervisor answers it (/addons/self/info, which
# every App may read). Sourced by the App's start (services.d/cain/run), which runs installed_version_lookup
# in the background before the link starts. The link registers a Ship install with the keeper App from it,
# never from main's config.yaml (link/ship-pass.ts cainInstalled).
#
# - The Supervisor's token never reaches a command line, a trace or a log: curl reads its Authorization
#   header from stdin (-H @-, fed by printf, a shell builtin), xtrace is off, and the answer's body is only
#   ever given to jq, never printed.
# - Every call is bounded (--connect-timeout, --max-time) and so is the whole lookup
#   (INSTALLED_LOOKUP_LIMIT seconds, 60), so it never holds up the start or lingers.
# - The file lives only in /run/cain (cleared at every container start), is removed first thing, is written
#   atomically (a temp file, then a rename) and holds only a version shaped like config.yaml's (X.Y.Z).
#   A missing, empty, null, HTML or otherwise malformed answer writes nothing.
# - While it runs, <file>.pending is there, so the link waits for it a few seconds before falling back.

installed_version_valid() { [[ "${1:-}" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$ ]]; }

# installed_version_lookup [dir]: the token is bashio's own unexported copy, read here and never exported.
installed_version_lookup() {
  { set +x; } 2>/dev/null
  local dir="${1:-/run/cain}" limit="${INSTALLED_LOOKUP_LIMIT:-60}" pause="${INSTALLED_LOOKUP_PAUSE:-5}"
  local out="$dir/installed-version" api="${__BASHIO_SUPERVISOR_API:-http://supervisor}" body v left max start
  rm -f "$out" "$out.tmp" 2>/dev/null || true
  : > "$out.pending" 2>/dev/null || true
  start=$SECONDS
  while :; do
    left=$(( limit - (SECONDS - start) ))
    [ "$left" -ge 2 ] || break
    max=$(( left < 10 ? left : 10 ))
    body="$(printf 'Authorization: Bearer %s\n' "${__BASHIO_SUPERVISOR_TOKEN:-}" \
      | curl -sS --fail --connect-timeout 3 --max-time "$max" -H @- "$api/addons/self/info" 2>/dev/null)" || body=""
    v="$(printf '%s' "$body" | jq -r 'if (type == "object") and .result == "ok" and ((.data.version | type) == "string") then .data.version else empty end' 2>/dev/null)" || v=""
    body=""
    if installed_version_valid "$v"; then
      { printf '%s\n' "$v" > "$out.tmp" && chmod 0644 "$out.tmp" && mv -f "$out.tmp" "$out"; } 2>/dev/null && break
      rm -f "$out.tmp" 2>/dev/null || true
    fi
    left=$(( limit - (SECONDS - start) ))
    [ "$left" -gt "$pause" ] || break
    sleep "$pause"
  done
  rm -f "$out.pending" 2>/dev/null || true
}
