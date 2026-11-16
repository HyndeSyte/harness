#!/bin/bash
# Cain's tools for his specialists and for talking to Dane with buttons. Prints JSON.
#   keeper.sh handover [--message <id>] [--smoke <run id>] [suggestion]
#                                        hand his calendar request to the calendar specialist
#                                        (it reads his message itself); answers with card ids.
#                                        --message: the id in the tag of the message it rests on
#                                        (its last 30 minutes); without it, his newest message.
#                                        --smoke: never makes a request a smoke step's; a handover
#                                        naming the run is an ordinary request (it cites his own
#                                        message), held like any other while a gate is closed
#   keeper.sh fastpath smoke-start      start the post-install smoke run: the specialist issues its
#                                        id (answers with "run") and records every change approved
#                                        while it's live under that id. Run the checklist through the
#                                        normal card path, each change on its card and tapped. A run is
#                                        bound to the specialist's version and ledger, lasts 24 hours,
#                                        gives one Turn on, and ends at Turn on, Turn off, a new
#                                        smoke-start, an update or its expiry; its adds are titled
#                                        "Smoke test: ...". Only a step's own request is the run's: a
#                                        request that just arrives while the run is live is an ordinary
#                                        one, and after an update a closed gate holds it like any other
#   keeper.sh fastpath smoke-step <run id> <step> <gmail|family> <add|move|remove> <YYYY-MM-DD> <title> [HH:MM-HH:MM]
#                                        offer one step of the run with its script (the step: lowercase
#                                        letters, digits, dashes; the title in quotes; times for an add
#                                        or a move). Dane gets a card showing the script with Start step
#                                        N; his tap, within 30 minutes, makes the step's change from the
#                                        script itself, on a card for his Approve. Hand nothing over for
#                                        a step. conformance-gmail and conformance-family take no script
#                                        and run at once: on the run's own test events, an edit, a
#                                        removal and an edit of one day of a series, each sent with a
#                                        version it made out of date, which the calendar must refuse
#                                        with its stale answer and not apply; one that takes any never
#                                        opens its cards, and one that refuses the fresh edit itself gets
#                                        a Test again for Dane and no gate-open
#   keeper.sh fastpath on <run id>       ask for that run's result. The specialist builds every item
#                                        from its own record (event ids, request and read-back times,
#                                        the writes refused for an older version, two listing-lag
#                                        samples per calendar of at most 300 seconds); a run that's
#                                        used, ran out or is from another version is refused, an item
#                                        with no evidence is refused by name, and nothing you
#                                        send as passed counts. A full run goes to Dane on a card
#                                        showing the evidence and every no-card path, with Turn on and
#                                        Keep cards; only his Turn on tap lets his own fresh, clear
#                                        words, a mail date he taps Add to Family on and Family adds
#                                        after the bake-in tap go through without a card, and a Turn
#                                        off button then sits on that card. Until then, every change
#                                        comes on a card. Leftover test events come in one message
#                                        with Take them off
#   keeper.sh fastpath off               every calendar change on a card again; the run is over and
#                                        any Turn on card comes off, so turning on needs a new run
#   keeper.sh fastpath gate-open <gmail|family>
#                                        after an update, that calendar's cards are held (no Approve)
#                                        until the smoke run reads back there a fenced edit of an event
#                                        that was there and an edit of one day of a series. When the run
#                                        can't complete on it, this opens that calendar without the check,
#                                        logged as yours; its held changes come back on fresh cards. Dane's
#                                        Open cards without the check tap does the same. Only on his say
#   keeper.sh fastpath migrate-check [path] [--candidate <path>]
#                                        run a ledger migration on a copy of the ledger file at path
#                                        (the specialist's own path; default its live ledger), never
#                                        the file itself, and print what it found: the schema version,
#                                        no-card paths off, the gate set, open Turn on cards (0
#                                        expected) and rows touched. --candidate: the incoming build's
#                                        own migration, from its source tree (the harness App folder)
#                                        or image path (its /opt/harness), recorded under that build's
#                                        id. Run it before a Ship card for a specialist update: the
#                                        specialist keeps the result in its ledger (by build and the
#                                        copy's checksum), and this writes it to the marker file
#                                        /data/markers/harness-migrate-check.json, which a Ship card for
#                                        the specialist needs (ok, under 24 hours old). An installed
#                                        build with no dry run of its own build id recorded moves
#                                        nothing until one is: this, run then, records it and moves them
#   keeper.sh fastpath migrate-override  only on Dane's say: the installed build moves its records
#                                        without a dry run, logged as yours, still with a backup first
#   keeper.sh digest                     take today's calendar digest for the morning message
#   keeper.sh meanings <file>            send what Dane said kinds of Family events mean: the
#                                        table in areas/family/calendar-meanings.md (rows of
#                                        | kind words | kids/me/school/drive/none | YYYY-MM-DD |)
#                                        or a JSON list of {kind, meaning, said_on}
#   keeper.sh places <file>              send Dane's place book: the table in
#                                        areas/home/places.md (rows of
#                                        | place name | street address, "lat, lon" or skip | YYYY-MM-DD |)
#                                        or a JSON list of {place, address, said_on}
#   Cards and asks name their item: --item <PENDING id, or none>, with --question <id>
#   when the item has more than one; --reply-to <message id> makes it a Discord reply.
#   keeper.sh show <card id> --item P08 [--question Q2] [--reply-to <id>]
#                                        show a specialist's card to Dane, unchanged
#   keeper.sh ask --item P08 [--question Q2] [--reply-to <id>] "question" "opt" ...
#                                        ask with up to 5 buttons, one ask open at a time
#                                        ("held" means it goes out when the open one closes);
#                                        his tap comes back relayed
#   keeper.sh ship --item P41 --pr <pull request url> --head <full sha> [--review <review id>] "text"
#                                        the Ship card (Ship / Not now) for that one head: the text says
#                                        what he'll notice, in one line; the link adds the question, a line
#                                        from GitHub and that review's Reviewed line (none: "No outside review.")
#   keeper.sh answered --item P08 [--question Q2]
#                                        he answered that open ask in words: buttons off
#   keeper.sh replied <message id>       what a message of his replied to, if anything
#   keeper.sh morning "text"             post the one morning message (with Stop)
#   keeper.sh stopped                    whether everything is stopped (Dane's Stop), and since when
#   keeper.sh card <message id>          a message in his DM as Discord has it now: its first words,
#                                        the buttons on it, and what the link knows of it
#   keeper.sh check [--reply-to <id>] [--edit <id>] "text"
#                                        what the message gate does with a reply (or an edit),
#                                        against the cards up now; sends nothing
#   keeper.sh selftest                   the message gate's reply hook, run as Claude Code runs it,
#                                        on a fix, a refusal and a clean reply; sends nothing
#   keeper.sh replay [days]              the gate's rules over his DM (default 14 days), reading only;
#                                        you hear one line when it's done
#   keeper.sh connector --item P41 "what waits"
#                                        the one notice that Claude's Home Assistant connector needs
#                                        him to sign in again, with a button to its settings
set -u
# Moved only for the tests.
dir="${CAIN_DISCORD_DIR:-/data/.claude/channels/discord}"
link="${CAIN_LINK:-http://127.0.0.1:8097}"
# The specialist's address. A test may move it, only with CAIN_KEEPER_TEST=1 as well, and says so
# on stderr (Cain's log): an address left in the environment can't send his requests elsewhere.
harness="http://0fcc2575-harness:8098"
if [ -n "${CAIN_HARNESS:-}" ]; then
  if [ "${CAIN_KEEPER_TEST:-}" = 1 ]; then
    harness="$CAIN_HARNESS"
    echo "keeper.sh: test override in use, the specialist's address is $harness" >&2
  else
    echo "keeper.sh: CAIN_HARNESS ignored: it takes CAIN_KEEPER_TEST=1, for tests only" >&2
  fi
fi
hooks="${CAIN_HOOKS:-/opt/cain/hooks}"
usage() { sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
# No command prints this usage: it never hands anything over.
if [ $# -eq 0 ] || [ "$1" = help ] || [ "$1" = --help ] || [ "$1" = -h ]; then usage; exit 2; fi
cmd="$1"; shift
# Needs no key and no link: it runs the hook itself.
if [ "$cmd" = selftest ]; then exec bun "$hooks/discord-send.ts" --self-test; fi
case "$cmd" in
  handover|digest|meanings|places) url="$harness/$cmd"; ctx=harness-handover-v1 ;;
  fastpath) url="$harness/fastpath"; ctx=harness-handover-v1 ;;
  show|ask|ship|answered|replied|morning|stopped|check|replay|connector) url="$link/$cmd"; ctx=harness-relay-v1 ;;
  card) url="$link/look"; ctx=harness-relay-v1 ;;   # the link's /card is the specialist's
  *) echo '{"status":"error","said":"unknown command"}'; exit 2 ;;
esac
if [ "$cmd" = fastpath ]; then
  case "${1:-}" in
    smoke-start|off) ;;
    smoke-step) [[ "${2:-}" =~ ^[0-9a-f]{6,32}$ ]] && [[ "${3:-}" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] \
          || { echo '{"status":"error","said":"fastpath smoke-step takes the run id and a step name: fastpath smoke-step <run id> <step> [script]"}'; exit 2; }
        case "$3" in
          conformance-*) [ $# -eq 3 ] || { echo '{"status":"error","said":"a conformance step takes no script"}'; exit 2; } ;;
          *) { [[ "${4:-}" =~ ^(gmail|family)$ ]] && [[ "${5:-}" =~ ^(add|move|remove)$ ]] \
                 && [[ "${6:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [[ "${7:-}" =~ ^[A-Za-z0-9][A-Za-z0-9\ \'\&.,:-]{0,59}$ ]] \
                 && { [ -z "${8:-}" ] || [[ "$8" =~ ^[0-9]{2}:[0-9]{2}-[0-9]{2}:[0-9]{2}$ ]]; } && [ $# -le 8 ]; } \
               || { echo '{"status":"error","said":"a step takes its script: fastpath smoke-step <run id> <step> <gmail|family> <add|move|remove> <YYYY-MM-DD> <title> [HH:MM-HH:MM]"}'; exit 2; } ;;
        esac ;;
    on) [[ "${2:-}" =~ ^[0-9a-f]{6,32}$ ]] \
          || { echo '{"status":"error","said":"fastpath on takes the smoke run id that fastpath smoke-start gave: fastpath on <run id>"}'; exit 2; } ;;
    gate-open) case "${2:-}" in gmail|family) ;;
                 *) echo '{"status":"error","said":"fastpath gate-open takes gmail or family"}'; exit 2 ;; esac ;;
    migrate-check)
        mc_path="" mc_candidate=""
        if [ "${2:-}" = --candidate ]; then mc_candidate="${3:-}"; [ $# -le 3 ] || mc_candidate="!"
        else mc_path="${2:-}"; if [ "${3:-}" = --candidate ]; then mc_candidate="${4:-}"; [ $# -le 4 ] || mc_candidate="!"; elif [ -n "${3:-}" ]; then mc_candidate="!"; fi
        fi
        { [ -z "$mc_path" ] || [[ "$mc_path" =~ ^/[A-Za-z0-9/._-]{1,255}$ ]]; } \
          || { echo '{"status":"error","said":"fastpath migrate-check takes an absolute ledger path, or none for the live ledger"}'; exit 2; }
        { [ -z "$mc_candidate" ] && { [ "${2:-}" != --candidate ] && [ "${3:-}" != --candidate ]; } || [[ "$mc_candidate" =~ ^/[A-Za-z0-9/._-]{1,255}$ ]]; } \
          || { echo '{"status":"error","said":"--candidate takes the absolute path of the incoming build: its source tree (the harness App folder) or its image path (/opt/harness)"}'; exit 2; } ;;
    migrate-override) [ $# -eq 1 ] || { echo '{"status":"error","said":"fastpath migrate-override takes nothing more"}'; exit 2; } ;;
    *) echo '{"status":"error","said":"fastpath takes smoke-start, smoke-step <run id> <step> [script], on <run id>, off, gate-open <gmail|family>, migrate-check [path] [--candidate <path>] or migrate-override"}'; exit 2 ;;
  esac
fi
if { [ "$cmd" = meanings ] || [ "$cmd" = places ]; } && [ ! -r "${1:-}" ]; then
  echo '{"status":"error","said":"No table file to send."}'; exit 2
fi
item="" question="" reply_to="" pr="" head="" edit="" review="" message="" smoke=""
case "$cmd" in
  handover)
    rest=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --message)
          [ $# -ge 2 ] || { echo '{"status":"error","said":"--message needs a value"}'; exit 2; }
          case "$2" in ''|*[!0-9]*) echo '{"status":"error","said":"--message takes a Discord message id, digits only"}'; exit 2 ;; esac
          message="$2"; shift 2 ;;
        --smoke)
          [ $# -ge 2 ] || { echo '{"status":"error","said":"--smoke needs the smoke run id"}'; exit 2; }
          [[ "$2" =~ ^[0-9a-f]{6,32}$ ]] || { echo '{"status":"error","said":"--smoke takes the smoke run id that fastpath smoke-start gave"}'; exit 2; }
          smoke="$2"; shift 2 ;;
        *) rest+=("$1"); shift ;;
      esac
    done
    set -- ${rest[@]+"${rest[@]}"} ;;
esac
case "$cmd" in
  show|ask|ship|answered|check|connector)
    rest=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --item|--question|--reply-to|--pr|--head|--edit|--review)
          [ $# -ge 2 ] || { jq -nc --arg f "$1" '{status: "error", said: ($f + " needs a value")}'; exit 2; }
          case "$1" in
            --item) item="$2" ;; --question) question="$2" ;; --reply-to) reply_to="$2" ;;
            --pr) pr="$2" ;; --head) head="$2" ;; --edit) edit="$2" ;; --review) review="$2" ;;
          esac
          shift 2 ;;
        *) rest+=("$1"); shift ;;
      esac
    done
    set -- ${rest[@]+"${rest[@]}"} ;;
esac
# The card's item, question and thread, as the link takes them.
meta='def opt($k; $v): if $v == "" then {} else {($k): $v} end; ({item: $it} + opt("question"; $q) + opt("reply_to"; $r))'
owner=$(jq -r '.allowFrom[0] // empty' "$dir/access.json" 2>/dev/null)
# The key is HMAC-SHA256(bot token, context); the token stays in its file.
key=$(ENV_FILE="$dir/.env" CTX="$ctx" bun -e '
const fs = require("fs"), crypto = require("crypto");
let m = null;
try { m = fs.readFileSync(process.env.ENV_FILE, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m); } catch (e) {}
if (!m) process.exit(1);
process.stdout.write(crypto.createHmac("sha256", m[1].trim()).update(process.env.CTX).digest("hex"));
') || { echo '{"status":"error","said":"No bot token here, so the specialist cannot be reached."}'; exit 1; }
umask 077
hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT
printf 'X-Harness-Key: %s\nContent-Type: application/json\n' "$key" > "$hdr"
unset key
case "$cmd" in
  handover) body=$(jq -nc --arg s "${1:-}" --arg p "$owner" --arg m "$message" --arg k "$smoke" \
              '{suggestion: $s, paired: $p} + (if $m == "" then {} else {message: $m} end)
               + (if $k == "" then {} else {smoke_run: $k} end)') ;;
  digest)   body='{}' ;;
  fastpath) case "$1" in
              on) body=$(jq -nc --arg r "$2" '{state: "on", run: $r}') ;;
              smoke-step) body=$(jq -nc --arg r "$2" --arg t "$3" --arg c "${4:-}" --arg k "${5:-}" --arg d "${6:-}" \
                            --arg n "${7:-}" --arg w "${8:-}" '{state: "smoke-step", run: $r, step: $t}
                            + (if $c == "" then {} else {script: ({calendar: $c, kind: $k, day: $d, title: $n}
                               + (if $w == "" then {} else {times: $w} end))} end)') ;;
              gate-open) body=$(jq -nc --arg c "$2" '{state: "gate-open", calendar: $c}') ;;
              migrate-check) body=$(jq -nc --arg p "$mc_path" --arg c "$mc_candidate" '{state: "migrate-check"}
                               + (if $p == "" then {} else {path: $p} end) + (if $c == "" then {} else {candidate: $c} end)') ;;
              *) body=$(jq -nc --arg s "$1" '{state: $s}') ;;
            esac ;;
  meanings)
    # The whole table each time: the specialist stores only what's new.
    if jq -e 'type == "array" or type == "object"' "$1" >/dev/null 2>&1; then
      body=$(jq -c 'if type == "array" then {rows: .} else {rows: (.rows // [])} end' "$1")
    else
      # An optional fourth column (For, a date) makes a row his answer about that one event.
      body=$(awk -F'|' 'NF >= 5 {
          k = $2; m = $3; d = $4; f = (NF >= 6 ? $5 : "")
          gsub(/^[ \t]+|[ \t]+$/, "", k); gsub(/^[ \t]+|[ \t]+$/, "", m); gsub(/^[ \t]+|[ \t]+$/, "", d)
          gsub(/^[ \t]+|[ \t]+$/, "", f)
          if (m ~ /^(kids|me|school|drive|none)$/) print k "\t" m "\t" d "\t" f
        }' "$1" | jq -Rnc '{rows: [inputs | split("\t")
          | {kind: .[0], meaning: .[1], said_on: .[2]} + (if (.[3] // "") != "" then {for: .[3]} else {} end)]}')
    fi ;;
  places)
    # The whole book each time: it replaces what the specialist had.
    if jq -e 'type == "array" or type == "object"' "$1" >/dev/null 2>&1; then
      body=$(jq -c 'if type == "array" then {rows: .} else {rows: (.rows // [])} end' "$1")
    else
      body=$(awk -F'|' 'NF >= 5 {
          p = $2; a = $3; d = $4
          gsub(/^[ \t]+|[ \t]+$/, "", p); gsub(/^[ \t]+|[ \t]+$/, "", a); gsub(/^[ \t]+|[ \t]+$/, "", d)
          if (d ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) print p "\t" a "\t" d
        }' "$1" | jq -Rnc '{rows: [inputs | split("\t") | {place: .[0], address: .[1], said_on: .[2]}]}')
    fi ;;
  show)     body=$(jq -nc --arg i "${1:-}" --arg it "$item" --arg q "$question" --arg r "$reply_to" \
              "$meta"' + {id: ($i | tonumber? // 0)}') ;;
  ask)      text="${1:-}"; shift || true
            body=$(jq -nc --arg t "$text" --arg it "$item" --arg q "$question" --arg r "$reply_to" \
              "$meta"' + {text: $t, options: $ARGS.positional}' --args "$@") ;;
  ship)     body=$(jq -nc --arg t "${1:-}" --arg it "$item" --arg q "" --arg r "$reply_to" --arg p "$pr" --arg h "$head" --arg v "$review" \
              "$meta"' + {text: $t, pr: $p, head: $h} + opt("review"; $v)') ;;
  answered) body=$(jq -nc --arg it "$item" --arg q "$question" --arg r "" "$meta") ;;
  replied)  body=$(jq -nc --arg m "${1:-}" '{m: $m}') ;;
  stopped)  body='{}' ;;
  card)     body=$(jq -nc --arg m "${1:-}" '{m: $m}') ;;
  check)    body=$(jq -nc --arg t "${1:-}" --arg r "$reply_to" --arg e "$edit" \
              '{text: $t} + (if $r == "" then {} else {reply_to: $r} end) + (if $e == "" then {} else {edit: $e} end)') ;;
  replay)   body=$(jq -nc --arg d "${1:-}" '{days: ($d | tonumber? // 14)}') ;;
  connector) body=$(jq -nc --arg t "${1:-}" --arg it "$item" '{item: $it, text: $t}') ;;
  morning)  text="${1:-}"; shift || true
            body=$(jq -nc --arg t "$text" '{text: $t, options: $ARGS.positional}' --args "$@") ;;
esac
out=$(curl -sS -m 45 -H "@$hdr" -d "$body" "$url" 2>&1) \
  || { jq -nc --arg e "$out" '{status: "error", said: ("No answer: " + $e)}'; exit 1; }
echo "$out"
# The migration dry run's marker (ninth round): Cain's rules need it, ok and fresh, before a Ship card
# for the specialist. Rewritten on every migrate-check, so a failed one replaces an older pass.
if [ "$cmd" = fastpath ] && [ "${1:-}" = migrate-check ]; then
  markers="${CAIN_MARKERS:-/data/markers}"
  mkdir -p "$markers" 2>/dev/null
  printf '%s' "$out" | jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{at: $at, ok: (.status == "ok" and (.result.ok // false)), status: .status,
      build: (.result.build // ""), checksum: (.result.checksum // ""), candidate: (.result.candidate // ""),
      result: (.result // {})}' \
    > "$markers/harness-migrate-check.json" 2>/dev/null \
    || jq -nc --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{at: $at, ok: false, status: "unreadable"}' \
         > "$markers/harness-migrate-check.json" 2>/dev/null
fi
