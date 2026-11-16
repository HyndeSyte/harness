#!/bin/bash
# Cain's tools for his specialists and for talking to Dane with buttons. Prints JSON.
#   keeper.sh handover [suggestion]      hand his calendar request to the calendar specialist
#                                        (it reads his message itself); answers with card ids
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
#   keeper.sh ask --item P08 [--question Q2] [--reply-to <id>] [--checked "what, where, when"] [--reason "why"] "question" "opt" ...
#                                        ask with up to 5 buttons, one ask open at a time
#                                        ("held" means it goes out when the open one closes);
#                                        his tap comes back relayed
#   --checked (ask and ship, for an item): the source check behind it: one line, at most 300
#                                        characters, no |, saying when and naming a concrete source:
#                                        a mail (sender domain and date), a page or portal, a file
#                                        path, a command or a message ("the receipt from county.gov
#                                        dated Nov 14, read at 9:40 this morning"). Not "memory",
#                                        "earlier" or "I recall", and not a repeat of the row's last
#                                        check. Dates, ISO times, shas, job ids and record codes are
#                                        fine in it: it goes to the record, never to him. The link
#                                        posts an ask or Ship card for an item only on a check of the
#                                        row's current version, no older than source_check_max_days,
#                                        that the record keeper accepted: one passed here goes to the
#                                        keeper and the link waits for its answer (up to 30 seconds).
#                                        --item none needs none, but is refused when it holds an open
#                                        item's code or whole Item phrase, and is written to the
#                                        request log as about no open item. One whose words overlap
#                                        an open item's more loosely answers "needs reason" and posts
#                                        nothing: ask it under that item with --checked, or send it
#                                        again with --reason "<one line on why it is about no open
#                                        item>", which the record keeper logs with it.
#   keeper.sh ship --item P41 --pr <pull request url> --head <full sha> [--review <review id>] [--checked "..."] "text"
#                                        the Ship card (Ship / Not now) for that one head: the text says
#                                        what he'll notice, in one line; the link adds the question, a line
#                                        from GitHub and that review's Reviewed line (none: "No outside review.")
#   keeper.sh answered --item P08 [--question Q2]
#                                        he answered that open ask in words: buttons off
#   keeper.sh replied <message id>       what a message of his replied to, if anything
#   keeper.sh morning "text"             post the one morning message (with Stop)
#   keeper.sh stopped                    whether everything is stopped (Dane's Stop), and since when
#   keeper.sh reads [n]                  n fresh reads of the record keeper's files (default 20), 4 seconds
#                                        apart, the way a tap reads them: p50, p95 and max (it fails loudly,
#                                        exit 2, when p95 is over half the tap_read_ms limit) and whether it
#                                        passes; about 80 seconds
#   keeper.sh slow-read                  the smoke test: the next tap's fresh read is held past its limit,
#                                        so that tap must answer "Busy, tap again." and keep its buttons
#   keeper.sh fail-webhook               the smoke test: the next time a busy tap puts a card's buttons back,
#                                        the interaction's webhook patch is made to fail, so the buttons must
#                                        come back through the fallback (an edit by channel and message id)
#   keeper.sh stall-read [seconds]       the smoke test: a fresh read held that long (default 20), ignoring its
#                                        cancellation; a second read meanwhile must answer busy at once, and a
#                                        journal write to the link's state must still finish ("pass":true)
#   keeper.sh clock                      the clock verdict (the record keeper's, with the source that
#                                        satisfied it, and the box's own), the ledger's generation, whether
#                                        a push or a reset is outstanding, how many rows are pending re-check
#                                        (recheck_pending), whether Ship taps are held, and the last tap's read time
#                                        unresolved_landings (each with the exact settle messages and its age),
#                                        tombstoned_landings (unresolved past 90 days: kept, no longer blocking)
#                                        and landings_by_head (the ledger's reconciliation, one landing per head),
#                                        and install_taps (on, once or off: whether his Ship taps land yet)
#   keeper.sh settle <tap key> landed|not-landed --said <his message id>
#                                        the owner's alone: settles by hand a landing the remote can't
#                                        settle (keeper.sh clock lists it under unresolved_landings, or
#                                        tombstoned_landings past 90 days), on his own message in his DM,
#                                        under a day old, that says exactly "settle <tap key> landed" or
#                                        "settle <tap key> not-landed" for this very key and verdict; the link
#                                        reads that message itself. One message settles one key once (its id
#                                        is consumed); one that says both, or "not landed" as two words, is
#                                        refused with the reason. Copying noise is forgiven: backticks or a
#                                        code fence around it, Unicode spaces, an en or em dash for the
#                                        hyphen, capitals; a refusal shows the text as received, normalised.
#                                        The settle goes to the landing ledger's settle log (fsynced) before
#                                        anything else happens. An audit line goes to the link's log, and
#                                        the usual outcome line follows
#   keeper.sh install-taps on|once|off [--said <his message id>]
#                                        whether his Ship taps land in main, kept in the record keeper's
#                                        install log (off when it is missing or damaged). on only proposes:
#                                        once /data/work/install-tests.json says the smoke test and the
#                                        resilience run passed (each dated, within 7 days) on a full head
#                                        sha, the link sends him the exact line "install taps on <code>"
#                                        (a fresh code, bound to the record's epoch and this start of the
#                                        link); once he sends it, as a new message, on --said <that
#                                        message's id> turns it on (his line is single use, written to the
#                                        landing ledger first, then to the record with an Owner-Line
#                                        trailer). once (Cain's)
#                                        lets exactly one Ship tap land (the pull-the-plug case itself);
#                                        off (Cain's) stops them. Until on, a Ship tap answers that installs
#                                        wait for the post-install tests, and keeps its buttons. Round 16: on
#                                        (with or without --said) is refused until the record keeper's status
#                                        says a fresh fetch verified its consumed set (keeper.sh clock:
#                                        consumed_verified true); nothing is proposed or used up meanwhile
#   keeper.sh recover-logs [--said <his message id>]
#                                        the owner's alone, when the record keeper says it refuses to start
#                                        for a case no rule explains (or asks for his OK). Without --said it only proposes,
#                                        sending him the exact line "recover logs <code>" (bound like the
#                                        install line). keeper.sh recover-logs --said <his message id>: his
#                                        own message in his DM, sent after the proposal (round 16: within
#                                        30 minutes of it by Discord's own times, never the Pi's clock),
#                                        saying exactly that line, single use; the keeper
#                                        moves the damaged log aside and goes on once its rebuild is
#                                        verified against GitHub. Round 15: it works in any keeper state
#                                        (degraded, unverified, GitHub unreachable); a line whose code no
#                                        longer counts (an earlier start, another epoch, used already)
#                                        answers "proposed": he is told the cause in one line,
#                                        with a fresh code at once. Round 16: only a live message counts (one
#                                        after the link's start); one read back from history draws no reply
#                                        and no code. It never marks anything verified: only a fresh fetch
#                                        does. If the Pi's clock is off from Discord's, he is told so
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
hooks="${CAIN_HOOKS:-/opt/cain/hooks}"
cmd="${1:-handover}"; shift || true
# Needs no key and no link: it runs the hook itself.
if [ "$cmd" = selftest ]; then exec bun "$hooks/discord-send.ts" --self-test; fi
case "$cmd" in
  handover|digest|meanings|places) url="http://0fcc2575-harness:8098/$cmd"; ctx=harness-handover-v1 ;;
  show|ask|ship|answered|replied|morning|stopped|check|replay|connector|clock|reads|settle) url="$link/$cmd"; ctx=harness-relay-v1 ;;
  slow-read) url="$link/slowread"; ctx=harness-relay-v1 ;;
  fail-webhook) url="$link/failwebhook"; ctx=harness-relay-v1 ;;
  stall-read) url="$link/stallread"; ctx=harness-relay-v1 ;;
  card) url="$link/look"; ctx=harness-relay-v1 ;;   # the link's /card is the specialist's
  install-taps) url="$link/installtaps"; ctx=harness-relay-v1 ;;
  recover-logs) url="$link/recoverlogs"; ctx=harness-relay-v1 ;;
  *) echo '{"status":"error","said":"unknown command"}'; exit 2 ;;
esac
if { [ "$cmd" = meanings ] || [ "$cmd" = places ]; } && [ ! -r "${1:-}" ]; then
  echo '{"status":"error","said":"No table file to send."}'; exit 2
fi
item="" question="" reply_to="" pr="" head="" edit="" review="" checked="" reason="" said=""
case "$cmd" in
  show|ask|ship|answered|check|connector|settle|install-taps|recover-logs)
    rest=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --item|--question|--reply-to|--pr|--head|--edit|--review|--checked|--reason|--said)
          [ $# -ge 2 ] || { jq -nc --arg f "$1" '{status: "error", said: ($f + " needs a value")}'; exit 2; }
          case "$1" in
            --item) item="$2" ;; --question) question="$2" ;; --reply-to) reply_to="$2" ;;
            --pr) pr="$2" ;; --head) head="$2" ;; --edit) edit="$2" ;; --review) review="$2" ;;
            --checked) checked="$2" ;; --reason) reason="$2" ;; --said) said="$2" ;;
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
  handover) body=$(jq -nc --arg s "${1:-}" --arg p "$owner" '{suggestion: $s, paired: $p}') ;;
  digest)   body='{}' ;;
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
              --arg c "$checked" --arg w "$reason" "$meta"' + {text: $t, options: $ARGS.positional} + opt("checked"; $c) + opt("reason"; $w)' --args "$@") ;;
  ship)     body=$(jq -nc --arg t "${1:-}" --arg it "$item" --arg q "" --arg r "$reply_to" --arg p "$pr" --arg h "$head" --arg v "$review" \
              --arg c "$checked" "$meta"' + {text: $t, pr: $p, head: $h} + opt("review"; $v) + opt("checked"; $c)') ;;
  answered) body=$(jq -nc --arg it "$item" --arg q "$question" --arg r "" "$meta") ;;
  replied)  body=$(jq -nc --arg m "${1:-}" '{m: $m}') ;;
  stopped)  body='{}' ;;
  clock)    body='{}' ;;
  slow-read) body='{}' ;;
  fail-webhook) body='{}' ;;
  stall-read) body=$(jq -nc --arg n "${1:-20}" '{seconds: ($n | tonumber? // 20)}') ;;
  reads)    body=$(jq -nc --arg n "${1:-20}" '{n: ($n | tonumber? // 20)}') ;;
  card)     body=$(jq -nc --arg m "${1:-}" '{m: $m}') ;;
  check)    body=$(jq -nc --arg t "${1:-}" --arg r "$reply_to" --arg e "$edit" \
              '{text: $t} + (if $r == "" then {} else {reply_to: $r} end) + (if $e == "" then {} else {edit: $e} end)') ;;
  replay)   body=$(jq -nc --arg d "${1:-}" '{days: ($d | tonumber? // 14)}') ;;
  settle)   body=$(jq -nc --arg t "${1:-}" --arg h "${2:-}" --arg s "$said" '{tap: $t, how: $h, said: $s}') ;;
  install-taps) body=$(jq -nc --arg h "${1:-}" --arg s "$said" '{how: $h} + (if $s == "" then {} else {said: $s} end)') ;;
  recover-logs) body=$(jq -nc --arg s "$said" '{said: $s}') ;;
  connector) body=$(jq -nc --arg t "${1:-}" --arg it "$item" '{item: $it, text: $t}') ;;
  morning)  text="${1:-}"; shift || true
            body=$(jq -nc --arg t "$text" '{text: $t, options: $ARGS.positional}' --args "$@") ;;
esac
wait=45; [ "$cmd" = reads ] && wait=240; [ "$cmd" = stall-read ] && wait=150   # the reads are spread over more than a keeper round
out=$(curl -sS -m "$wait" -H "@$hdr" -d "$body" "$url" 2>&1) \
  || { jq -nc --arg e "$out" '{status: "error", said: ("No answer: " + $e)}'; exit 1; }
echo "$out"
# The reads fail loudly: p95 over half the tap read limit (or a busy read) is a failure, said on its
# own line and in the exit status.
if [ "$cmd" = reads ] && [ "$(printf '%s' "$out" | jq -r '.pass // empty' 2>/dev/null)" = false ]; then
  printf '%s' "$out" | jq -r '.fail // "FAIL: the reads did not pass"' >&2
  exit 2
fi
