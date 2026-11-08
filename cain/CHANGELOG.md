# Changelog

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
