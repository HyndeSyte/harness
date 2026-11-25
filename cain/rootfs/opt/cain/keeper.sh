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
#                                        Open cards without the check tap does the same. Only on his say.
#                                        On a calendar Harness can't protect (it takes stale writes, or
#                                        turns down fresh ones), this only re-sends Dane his Open without
#                                        protection card; opening it there is his tap alone
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
#                                        build rehearses itself on a copy and moves its records with
#                                        no command; only a failed rehearsal waits (Dane has Run
#                                        check). This, run then, rehearses again and moves them on a pass
#   keeper.sh fastpath migrate-override  only on Dane's say: posts him a card to move the records
#                                        without a rehearsal (why it failed, a backup first); they
#                                        move only on his tap, once, for that build. Nothing more
#   keeper.sh fastpath migrate-restore <schema> <build>
#                                        only on Dane's say: posts him a card to put the records back
#                                        from the backup taken at that schema version before that
#                                        build's move (harness-before-s<schema>-<build>-...sqlite);
#                                        his Put them back tap stages it, checked, and it replaces the
#                                        records the next time Harness starts (the ones replaced are
#                                        kept beside them), then they move to the running build again.
#                                        Once staged, Harness takes nothing new and his card asks him
#                                        to restart the App now. A Home Assistant backup is the copy
#                                        off the Pi
#   keeper.sh fastpath migrate-clock     only posts him the card with Use the clock as it is now, when
#                                        Harness's clock is behind its own records and holds backup
#                                        pruning up; the clock is taken as right only on his tap
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
#   keeper.sh ship-gate <full head sha> [--watch]
#                                        the Windows Ship gate read for that head without acting: what it
#                                        would decide and why, the workflow file it read and every
#                                        pcjobs-windows attempt it saw; --watch is the probe's ship_gate step
#   keeper.sh ship-gate --pr <number> --head <full sha> --watch
#                                        the same watch, started before the push, for the exact sha about to
#                                        be pushed: it waits until the pull request's head equals that sha and
#                                        accepts only it, and fails by name (other_head, head_moved) if another
#                                        head appears or the head moves away; kept as ship-gate-<sha>.json
#   keeper.sh ship-gate --supersede <full sha>
#                                        records that the acceptance kept for that sha is replaced (a rebase),
#                                        so a new watch can accept the pull request's new head for its card
#   keeper.sh key-expiry <name> <YYYY-MM-DD|none>
#                                        note when a key the App holds expires (the security watch
#                                        names it 14 days ahead in the morning check-in); names:
#                                        github_token, pc_jobs_token, discord_bot_token, gemini_api_key,
#                                        perplexity_api_key, anthropic_api_key, deploy_key, ship_key
#   keeper.sh key-ack <name> <YYYY-MM-DD>
#                                        a key that never expires by design (the deploy and Ship keys): its
#                                        "same for over 90 days" line stays quiet until that date
#   keeper.sh reply [--reply-to <id>] "text"
#                                        a reply of Cain's that carries a link: the link posts it with its
#                                        preview off from the start (the plugin's reply would unfold it), after
#                                        the same gate rules, and records it as his own reply (he may edit it)
#   keeper.sh link-host <host>           adds a host Cain cites to the gate's list (a link to a host off it
#                                        is only noted in the gate report, never held)
#   keeper.sh connector --item P41 "what waits"
#                                        the one notice that Claude's Home Assistant connector needs
#                                        him to sign in again, with a button to its settings
#   keeper.sh review-grant --item P46 --change <pull request url or change key> --rounds <1-3> "why"
#                                        a card asking him to grant a change at its review-round cap more
#                                        fix rounds: what it does (your line), the rounds it used and what
#                                        the last left (the runner's record), with "Grant <n> more rounds"
#                                        and "No". Only his tap writes the grant; this writes nothing.
#                                        Refused while the change has rounds left, its item is held by
#                                        another holder, or Stop holds
#   keeper.sh drill-arm <exit-on-start|verdict-fail> <version>
#                                        (Keeper 0.1.13) posts Dane the drill card for the Keeper App: his tap on it,
#                                        and only his tap, arms the next install of Cain as a drill that fails on
#                                        purpose that way, so Keeper must roll it back. This sets nothing itself.
#                                        (0.1.14) <version> is the Cain version the drill release carries: the card
#                                        names it, and an install of any other version refuses the flag.
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
# Needs no key and no link: it runs the gate itself, the broker's as his own user (the new
# way), the reply hook as root (the old way).
if [ "$cmd" = selftest ]; then
  if [ "$(head -c 10 "${CAIN_MODE_FILE:-/run/cain/mode}" 2>/dev/null)" = "own" ]; then exec bun /opt/cain/discord/selftest.ts; fi
  exec bun "$hooks/discord-send.ts" --self-test
fi
# Needs no key and no link either: it reads GitHub's public API only, and changes nothing.
if [ "$cmd" = ship-gate ]; then exec bun "${CAIN_LINK_DIR:-/opt/cain/link}/shipgate.ts" "$@"; fi
# Needs no key and no link: the key record is the security watch's own file (never a key in it).
# As his own user (0.13.1) the record is root's, so the link writes the note (its /key-note).
if { [ "$cmd" = key-expiry ] || [ "$cmd" = key-ack ]; } && [ "$(head -c 10 "${CAIN_MODE_FILE:-/run/cain/mode}" 2>/dev/null)" != "own" ]; then
  exec bun "${CAIN_SECURITY:-/opt/cain/security/main.ts}" "$cmd" "$@"
fi
# Needs no key and no link: the gate's list of cited hosts is a file of Cain's own.
if [ "$cmd" = link-host ]; then exec bun "${CAIN_GATE_DIR:-/opt/cain/gate}/hosts.ts" add "$@"; fi
case "$cmd" in
  handover|digest|meanings|places) url="$harness/$cmd"; ctx=harness-handover-v1 ;;
  fastpath) url="$harness/fastpath"; ctx=harness-handover-v1 ;;
  show|ask|ship|answered|replied|morning|stopped|check|reply|replay|connector|review-grant|drill-arm) url="$link/$cmd"; ctx=harness-relay-v1 ;;
  card) url="$link/look"; ctx=harness-relay-v1 ;;   # the link's /card is the specialist's
  key-expiry|key-ack) url="$link/key-note"; ctx=harness-relay-v1 ;;
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
    migrate-clock) [ $# -eq 1 ] || { echo '{"status":"error","said":"fastpath migrate-clock takes nothing more"}'; exit 2; } ;;
    migrate-restore) { [ $# -eq 3 ] && [[ "${2:-}" =~ ^[0-9]{1,4}$ ]] && [[ "${3:-}" =~ ^[0-9A-Za-z._-]{4,64}$ ]]; } \
          || { echo '{"status":"error","said":"fastpath migrate-restore takes the backup'"'"'s schema version and build: fastpath migrate-restore <schema> <build>"}'; exit 2; } ;;
    *) echo '{"status":"error","said":"fastpath takes smoke-start, smoke-step <run id> <step> [script], on <run id>, off, gate-open <gmail|family>, migrate-check [path] [--candidate <path>], migrate-override, migrate-restore <schema> <build> or migrate-clock"}'; exit 2 ;;
  esac
fi
if { [ "$cmd" = meanings ] || [ "$cmd" = places ]; } && [ ! -r "${1:-}" ]; then
  echo '{"status":"error","said":"No table file to send."}'; exit 2
fi
item="" question="" reply_to="" pr="" head="" edit="" review="" message="" smoke="" change="" rounds=""
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
  show|ask|ship|answered|check|reply|connector|review-grant)
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
        --change|--rounds)
          [ $# -ge 2 ] || { jq -nc --arg f "$1" '{status: "error", said: ($f + " needs a value")}'; exit 2; }
          if [ "$1" = --change ]; then change="$2"; else rounds="$2"; fi
          shift 2 ;;
        *) rest+=("$1"); shift ;;
      esac
    done
    set -- ${rest[@]+"${rest[@]}"} ;;
esac
# The card's item, question and thread, as the link takes them.
meta='def opt($k; $v): if $v == "" then {} else {($k): $v} end; ({item: $it} + opt("question"; $q) + opt("reply_to"; $r))'
# As his own user (the new way, /run/cain/mode "own"), he has no token: his keys are the two
# root writes for him at each start, his own for the link and the handover key the calendar
# specialist checks, and his DM's owner comes from the link's cards file. The old way (as
# root) derives them from the token, as 0.11.0 did.
keys="${CAIN_KEYS:-/run/cain/keys}"
if [ "$(head -c 10 "${CAIN_MODE_FILE:-/run/cain/mode}" 2>/dev/null)" = "own" ]; then
  owner=$(jq -r '.owner // empty' "${CAIN_CARDS:-/data/trust/cards.json}" 2>/dev/null)
  if [ "$ctx" = harness-handover-v1 ]; then kf="$keys/handover.key"; else kf="$keys/cain.key"; fi
  key=$(head -c 200 "$kf" 2>/dev/null) && [ -n "$key" ] \
    || { echo '{"status":"error","said":"This start has no key for the link or the specialist yet; try again in a minute."}'; exit 1; }
else
  owner=$(jq -r '.allowFrom[0] // empty' "$dir/access.json" 2>/dev/null)
  # The key is HMAC-SHA256(bot token, context); the token stays in its file.
  key=$(ENV_FILE="$dir/.env" CTX="$ctx" bun -e '
const fs = require("fs"), crypto = require("crypto");
let m = null;
try { m = fs.readFileSync(process.env.ENV_FILE, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m); } catch (e) {}
if (!m) process.exit(1);
process.stdout.write(crypto.createHmac("sha256", m[1].trim()).update(process.env.CTX).digest("hex"));
') || { echo '{"status":"error","said":"No bot token here, so the specialist cannot be reached."}'; exit 1; }
fi
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
              migrate-restore) body=$(jq -nc --arg r "$2 $3" '{state: "migrate-restore", restore: $r}') ;;
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
  reply)    body=$(jq -nc --arg t "${1:-}" --arg r "$reply_to" '{text: $t} + (if $r == "" then {} else {reply_to: $r} end)') ;;
  replay)   body=$(jq -nc --arg d "${1:-}" '{days: ($d | tonumber? // 14)}') ;;
  key-expiry|key-ack) body=$(jq -nc --arg c "$cmd" --arg n "${1:-}" --arg d "${2:-}" '{cmd: $c, name: $n, date: $d}') ;;
  connector) body=$(jq -nc --arg t "${1:-}" --arg it "$item" '{item: $it, text: $t}') ;;
  drill-arm)
    case "${1:-}" in exit-on-start|verdict-fail) ;; *) echo '{"status":"error","said":"drill-arm takes exit-on-start or verdict-fail, then the Cain version"}'; exit 2 ;; esac
    [[ "${2:-}" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$ ]] || { echo '{"status":"error","said":"drill-arm takes the Cain version the drill release carries, like 0.19.1"}'; exit 2; }
    body=$(jq -nc --arg m "$1" --arg v "$2" '{mode: $m, version: $v}') ;;
  review-grant)
    [[ "$rounds" =~ ^[1-3]$ ]] || { echo '{"status":"error","said":"--rounds takes 1, 2 or 3"}'; exit 2; }
    [ -n "$change" ] || { echo '{"status":"error","said":"--change takes the pull request url or the change key"}'; exit 2; }
    body=$(jq -nc --arg t "${1:-}" --arg it "$item" --arg c "$change" --arg n "$rounds" --arg r "$reply_to" \
      '{item: $it, change: $c, rounds: ($n | tonumber), text: $t} + (if $r == "" then {} else {reply_to: $r} end)') ;;
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
