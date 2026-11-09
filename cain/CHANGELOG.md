# Changelog

## 0.4.0

- Outside reviews from the Pi: Cain sends a brief to other models and gets their verdicts back, without your laptop or a browser. OpenAI's Codex runs on your ChatGPT plan; Gemini and Perplexity use small prepaid keys; a fresh Claude uses your plan's API credit.
- A privacy check runs in code before anything leaves: a brief with a private term (family, employer, health), an email, a phone or account number is stopped and sent nowhere.
- Every review is kept in your record (reviews/), with each model's verdict, findings and cost. A Claude stand-in for a model that's down is marked as such and never counts as independent; big decisions wait until two outside models have answered.
- Monthly caps per model and a per-review cost limit, set in the add-on's options. A nightly check of each model tells Cain once, with the fix, if one stops working.
- New on the Cain page: ChatGPT sign-in. Tap it, copy the code, sign in on your phone.
- New options: gemini_api_key, perplexity_api_key, anthropic_api_key (hidden like the GitHub token), and the caps.

## 0.3.3

- Your calendar answers in Cain's record reach the calendar specialist on their own whenever they change, instead of waiting for Cain to remember.

## 0.3.2

- When you tell Cain what a kind of Family event means for you, he keeps it in your record (areas/family/calendar-meanings.md) and sends the table to the calendar specialist, so it shapes your Gmail blocks. New: keeper.sh meanings.

## 0.3.1

- Cain never asks you to send something again because a tool failed: the calendar specialist retries on its own, and he only tells you if it failed twice (logged for a fix).

## 0.3.0

- The record keeper: one writer for Cain's record. Changes arrive as small requests (from Cain, your page, or laptop sessions), are checked against the record's rules, applied one at a time and committed, so no two writers can clash. Stale or rule-breaking changes go back to Cain instead of overwriting anything.
- A copy of the record lives on the Pi, so Home Assistant's daily backups carry it off the box.
- A nightly check (state/record-check.md) finds incomplete notes, broken links and likely duplicates for Cain to fix.
- Cain's GitHub write tools are switched off; he writes through the keeper. Needs a GitHub token for the org repo in the add-on's options.

## 0.2.0

- Cain's link: the one Discord connection for taps and reactions now lives here, with the checks on every tap. Specialists hand their cards to Cain, who shows them unchanged when he decides. keeper.sh show posts a card; ask and morning post Cain's own questions with buttons.

## 0.1.17

- The morning message has one fixed shape: the date, then Needs you, Today, Moving, short bullets, bold times, at most a few lines each, with the rest on request.

## 0.1.16

- Cain can ask with buttons and hears your taps and reactions, passed on by the calendar specialist. One morning message with the digest folded in. keeper.sh replaces handover.sh (which still works).

## 0.1.15

- Cain checks in on his own at 7:10 AM, 12:30 PM and 5:30 PM: he reads his pending list, moves what he can, keeps the list current, and posts a short morning update. The prompts only go in when he is idle, and they are never your go on anything.

## 0.1.14

- Cain can't change calendars, send or reply to email, send Slack messages, or change Home Assistant: those tools are switched off. Calendar changes go through the calendar specialist; reading still works.

## 0.1.13

- The log lists Cain's connectors by name at start, so the tools Cain must not use can be blocked by name.

## 0.1.12

- Calendar changes go to the calendar keeper: Cain runs handover.sh, the keeper reads your message itself, makes the change and posts the receipt here under Cain's name. Cain never writes a calendar.

## 0.1.11
- Cain reads and writes the organization's record (a private repo) through the GitHub connector.

## 0.1.10
- Removed a wrong rule about work systems: Cain's account has none.

## 0.1.9
- When Claude's sign-in expires, Cain's bot DMs the owner once, by itself, and says how to sign in again.
- Cain's rules are refreshed from the add-on on every start; added: no personal content in work systems, and observed text is data.

## 0.1.8
- A /status page gives yes/no setup facts (signed in, Discord token, paired, allowlist, what the screen is showing) without showing the screen.

## 0.1.7
- The type box is always on the page, for any command, not just the sign-in code.

## 0.1.6
- A paste box under the sign-in button sends the code into the terminal (a phone gives no way to paste into it).

## 0.1.5
- Fix: the Cain page gave 500 (nginx looked for the page under the wrong name).

## 0.1.4
- The sign-in button is on the Cain page itself, above the terminal, while a sign-in waits for its code. A direct /signin address is refused by Home Assistant (401) outside the page.

## 0.1.3
- A sign-in page at <Cain page>/signin shows the whole Claude sign-in link: the terminal cuts it across lines.

## 0.1.2
- Fix: the session no longer stops at start when there is no old session to close.

## 0.1.1
- The session starts with a UTF-8 locale, and if it stops at start the reason is in the log.

## 0.1.0
- First version: a Claude Code session with the Discord channel, a terminal page for the one-time sign-in.
