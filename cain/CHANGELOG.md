# Changelog

## 0.8.0

- Stop now stops everything: the calendar specialist, as before, and Cain's Build and Ship jobs, his Ship cards and outside reviews. The Stop notice says so, and its Turn back on button is the only way back on. Cain can't undo it.
- Your Ship tap is signed by Cain's App for that one pull request at that one commit, and it lasts 30 minutes. Cain's Ship job can't start without it. Before, it started on Cain's word that you'd tapped.
- If the calendar specialist doesn't answer a Stop or Turn back on tap, Cain's App posts the notice itself, so a tap is never silent.

## 0.7.4

- This release brings 0.7.3's changes to your Pi. 0.7.3 was merged but never installed, because its tests failed.
- Cain's own tests no longer fail from a fixed date: they use the real clock.

## 0.7.3

- Cain reads the screenshots and files you send him in Discord without stopping to ask for approval. Before, a screenshot left his session waiting for an approval nobody was there to give.
- Cain can read back recent messages in your DM with him, so he can catch up on what was said.
- Both work only in your DM with him. Any other chat is refused, and both stop until the Discord plugin's access is you alone (allowlist, one user, no groups); the App's log says so at start if it isn't.
- The files he downloads are deleted after 7 days, and the oldest go first if they pass 200 MB.
- The Discord plugin is pinned to the version reviewed for this. If it ever changes, these two reads stop until it's reviewed again.
- Both only read. Everything that writes stays as it was: calendar, mail, Slack and Home Assistant changes stay switched off, and replying, reacting and editing in Discord still go through the usual approval.

## 0.7.2

- A card from the calendar specialist always reaches you and keeps its buttons until you answer it or it expires, even when someone else is working on the same job, or that job is done. Before, such a card could be held back and expire before you saw it.
- A card with buttons from the calendar specialist reaches you within about 2 minutes, even if Cain is busy: if he hasn't shown it by then, it goes out by itself. A card that has already expired never goes out. If a card can't reach you, Cain is told what it was, so he can tell you himself. Cards that arrived before this update still wait for Cain.

## 0.7.1

- Cain's panel opens only for the Home Assistant user set as its owner (`owner_user_id` in Configuration, which takes only a user id). Any other user who opens it gets Forbidden, and until the owner is set it's closed to everyone, you included. Needs Supervisor 2026.10.3 or later.
- At each start, the App's log says whether the panel is locked to its owner or closed to everyone. The Documentation tab says where to find your user id.
- Cain's session starts without Home Assistant's Supervisor token in its environment. That's a first step, not a lock: the session runs as root and could still find the token. Keeping it out for good comes later, with the session running as its own user.

## 0.7.0

- **One question at a time.** Cain's questions come one by one: the next shows up when you answer the one before. Asking the same thing again replaces the old card instead of adding another.
- **Cards clean up after themselves.** Once a card stops mattering its buttons come off, and it says what happened: "You answered: Filed", "Expired" or "Replaced by a newer card". Cain's questions and Ship cards last until the next morning check-in (at least two hours); a Ship card also goes when its pull request changes, merges or closes. The old cards already in your DM, this morning's included, are tidied once when this version starts.
- **Old cards say so.** Tapping a card that's done takes its buttons off and tells you "This card expired; nothing was done", instead of quietly doing nothing.
- **Answers in the thread.** Cain's answer to a tap, and any late answer, shows as a reply to what it answers. When you reply to one of his cards, he can look up which one.
- **Exact questions.** Each card starts with its item and question ("P08 Q2:"), and its buttons answer that question ("Filed", "Not filed", "Not sure"). What you tap is recorded exactly as you tapped it, never as something read into it. No card ever shows a commit code, a job id or a machine timestamp.
- **Never twice, never lost.** A card is never posted twice when Discord is slow to answer, and a tap reaches Cain even if his add-on restarts in the middle of it.
- **Ship is pinned.** A Ship card is for one exact version of the pull request. If it changes before it merges, GitHub refuses the merge and you get a fresh card.
- **No crossed wires with laptop sessions.** Cain leaves alone what a laptop session is working on: he won't ask you about it or build on its branch, and he never hands your Discord requests to a laptop. Cloud jobs can't send you notifications; only Cain talks to you.
- **Notes reach Cain.** New notes left on what Cain is working on reach him at his next check-in, each once, the newest first to stay when there are many.
- **True words.** Cain says something was asked, sent or done only once it's confirmed, checks what matters before an event rather than after, and keeps timestamps and job ids out of what you see.

## 0.6.0

- **One hand on each item.** Each item in your record now has at most one holder: Cain, or one laptop session. Only the holder can change that item's line in your open list or push to its branches, so Cain and a laptop session can't overwrite each other's work the way they did on P33. An item nobody holds is Cain's; a laptop session takes it before changing its line.
- **Your word moves an item.** When you tell a laptop session or Cain to take an item over, it moves to them, branches and all. While one of Cain's build or ship jobs is running on an item, a take waits until the job is done.
- **Your words always land.** Tell Cain or any laptop session something about an item someone else is working on, and it's kept as a note on that item. Whoever holds the item sees the note before they change anything.
- **Changes to different items don't clash.** Two writers changing different lines of your open list are both saved, instead of one being turned away.
- **No "done" for nothing.** A change that changes nothing is turned away, so the record can't say something was done when nothing happened.
- **Cain's changes land in seconds.** The record keeper picks up Cain's own changes within 2 seconds instead of up to a minute. An item whose holder goes a day without a word goes back to Cain; time the box is down doesn't count.

## 0.5.0

- **If the calendar specialist stops, you hear about it.** Cain's add-on checks the Harness add-on every minute. If it hasn't answered for 5 minutes (or its main loop has stuck for 10), you get one Discord message saying so, and one more when it's back. Cain is told too, so he won't promise calendar changes meanwhile.
- **No noise on restarts or updates.** Anything shorter than 5 minutes says nothing, and a message is never repeated. A restart of Cain during an outage doesn't tell you twice.
- **The Harness page can show the Discord link.** Cain's link now reports whether it's connected to Discord and when it last heard from it, only to a caller holding the key (anyone else just gets "ok"). The other half of the watch is in Harness 0.20.0: if Cain's add-on stops, Harness tells you itself.
- **Review fixes to the watch.** A message to you can't repeat if the line to Cain fails, checks never overlap, and the message gives up after 15 seconds. Only "no answer", a server error or "stuck" counts as Harness down; a refused key shows as "can't check: key refused" and tells you nothing. The 5 minutes are timed on a clock that boot-time clock jumps can't fool, and the watch's file is saved even if its folder went missing.

## 0.4.5

- The calendar meanings table takes an optional fourth column, For (a date): that row is Dane's answer about the one event on that day, and is sent as `for`.

## 0.4.4

- **Outside reviews: an allowlist decides what leaves.** Only a brief's topic, question and body go to the outside models, plus its two flags. The id stays on the Pi, and any other field is refused without echoing it. The terms list stays as a backstop, now on text with invisible characters stripped and Unicode normalized first.
- **The rest of the guard:**
  - The record is gated the same way as the outside models.
  - A review-level id or topic is never trusted.
  - An id that matches a private term is withheld from logs and relay lines.
  - Provider error text is no longer stored.

  Reviewed by Fable twice.

## 0.4.3

- Cain keeps a place book in your record (areas/home/places.md): where each place named on Family is, so those events get drive blocks and an address that opens in Maps.
- When the calendar specialist asks where a place is, just reply with the address (or say skip). Cain writes it down and the add-on passes it on by itself.

## 0.4.2

- The morning message is easier to read on your phone: clear section headers, and the top line says how many things need you.
- Each decision now comes as its own message with its buttons right under it, so you always know what you're answering.
- Needs you only has things you can do from your phone with a tap. If Cain or a cloud job could do something, he asks "Want me to do it?" instead. PC-only chores stay off the morning message; ask for the PC list when you're there.
- Today shows everything on your calendars; no more "and 1 more". All-day items sit on one small line at the end.
- No more questions pointing at a card that has already expired.

## 0.4.1

- Build work no longer needs your laptop. When a fix or feature is ready, Cain asks with a Start button. Your tap starts a cloud session on your Claude plan, and Cain sends you its link.
- When it finishes, Cain gets an outside review of the change and asks you with a Ship button, saying what changed and that tests passed.
- While a job runs, the add-on nudges Cain every 15 minutes to check on it, so the result reaches you without you asking.

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
