#!/bin/bash
# What Cain's screen shows, as one word, from tmux's capture of it on standard input. The panel's
# /status (the run script) and the App's way out of a question no one answers (unstick.sh) read
# it here, the same way:
#   login_needed      his Claude sign-in ran out: he signs in again on the panel
#   waiting_for_code  a sign-in waits for its code to be pasted
#   trust_prompt      Claude Code asks whether to trust his folder
#   first_run_menu    Claude Code's first-run or sign-in menus
#   ready             his prompt (prompt-state.sh), whether he's working or not
#   dialog            a screen waiting for an answer (prompt-state.sh)
#   unknown           anything else, an empty capture included
# Always prints one of these and exits 0.
screen=$(cat)
last=$(printf '%s\n' "$screen" | tail -n 30)
at=$(printf '%s\n' "$screen" | "${PROMPT_STATE:-/opt/cain/prompt-state.sh}" 2>/dev/null) || at=other
state=unknown
if printf '%s\n' "$last" | tail -n 12 | grep -Eqi 'run /login|token has expired|authentication_error|invalid api key|not logged in'; then state=login_needed
elif printf '%s' "$last" | grep -Eqi 'paste.*code'; then state=waiting_for_code
elif printf '%s' "$last" | grep -Eqi 'do you trust|trust the files'; then state=trust_prompt
elif printf '%s' "$last" | grep -Eqi 'select login|login method|choose the text style|dark mode'; then state=first_run_menu
elif [ "$at" = ready ]; then state=ready
elif [ "$at" = dialog ]; then state=dialog
fi
echo "$state"
