# Changelog

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
