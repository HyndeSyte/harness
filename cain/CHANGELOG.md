# Changelog

## 0.12.0

- Cain checks a thing where it lives (your mail, a portal, GitHub) before he asks you about it, and the App now holds him to it: a question or Ship card about one of your open items goes out only once the record has accepted his check of that item as it stands now.
- A check must name a real source (a mail with its sender and date, a page, a file, a command or a message), never "from memory". The App proves a check was recorded, not that the source was read: that part is on Cain's word.
- A check counts for 7 days, by the record's own clock, and only once the box's clock is set right. New option, source_check_max_days, if you want a different limit; nothing to set up.
- If the item changes after the card went up, its buttons come off and it says "Status changed, re-check needed". Your tap counts only after the App looks at the record again and finds the check still good; if it can't look, the tap does nothing and says so.
- What he checked shows on the item's row in your record, with the date it goes stale.
- A one-off question that names one of your open items is held back; one that only sounds like one waits until Cain names the item or says why it isn't, and that reason is kept.
- A change to your whole open list saves whole or not at all: a row that says two different things are done or not done stops all of it, and Cain fixes and resends.
- A row's next step stays short (the current step and its latest check); older history goes in a note on the item.
- If saving the record to GitHub fails, nothing is lost or undone: the box keeps its copy and saves it again a minute later, and a question already out keeps working. Only if the box ever has to start its copy over do questions and taps wait, a few minutes, until it has saved again.
- Your tap is answered right away, and the App then checks the record: taps that can't be confirmed right now do nothing and say why, and the question keeps its buttons: "Busy, tap again" when the record is slow to read (a second and a half unless you change the new tap_read_ms option; nothing to set up), or a note that the box's clock isn't set right just now.
- If saving the record to GitHub keeps failing (over half an hour, or three tries in a row), you get one notice saying why in plain words. After half an hour of that, taps wait until it saves.
- If the box ever has to start its copy over, a tap whose check didn't survive that never counts: you get one line under that question, "Lost to the record's reset, please answer again.", and Cain asks again once he has checked again. A tap whose check survived still counts.
- The box's clock is checked four ways now, the kernel's own flag first (the one that works on your Pi), and GitHub's clock as a backstop. If the clock ever jumps backwards by more than a few seconds, checks made "in the future" stop counting.
- Each tap counts once. If you tap twice, or Discord sends your tap again, the second one just shows what the first did. If the box restarts in the middle of a tap, it finishes that tap afterwards and never does it twice. When a tap is answered "Busy, tap again", the question's buttons work again right away.
- A Ship tap waits while the record has unsaved changes (any of them, not only ones about that card), since a Ship can't be undone. Questions still work meanwhile.
- A Ship tap lands at most once, even if the box restarts in the middle of it, and Cain hears of each tap once.
- If two taps land on one question at the same time, only the first counts; the other just shows what the first did. If Discord won't put a question's buttons back after "Busy, tap again", the App puts them back another way.
- If the App's own saved state is ever damaged, it rebuilds it by itself and tells you once; questions work again without you doing anything.
- If the box ever has to start its copy of the record over, questions asked before that stop working (they say "Record reset since, re-check needed"), and every check from before it is marked pending re-check on your list until Cain checks again, the items with questions out first.
- Right after this install Cain runs a quick test, about twelve minutes, that breaks nothing: a few test questions (tap any answer, or tap an old one when he says so), a harmless Ship card (tap Not now), and one notice that the record isn't saving, which he causes on purpose. For one step he asks you to set source_check_max_days to 0 and then back to 7, the only option you change. He tells you in a line whether it worked. If not, restore the App from the backup taken before the install; nothing else needs undoing.
- If the box restarts in the middle of landing a Ship tap, the App asks GitHub itself whether it landed, never its own copy. If it didn't, you get one line under that card ("The install was interrupted by a restart and did not land; a new card follows.") and Cain shows you a new Ship card. If GitHub can't be reached, nothing new goes out until it can. Shipping something that is already in main pushes nothing and just says so.
- A tap that waits on another tap on the same question for too long answers "Busy, tap again." straight away and does nothing else.
- A tap from before the record had to start over counts afterwards only if the record really took its check again since; otherwise you get the "Lost to the record's reset" line.
- The notice that the record isn't saving now says how long Ship taps have been held. Nothing to set up beyond the smoke test's one option change.
- The smoke test gains one step: it makes Discord's usual way of putting a question's buttons back fail on purpose, and checks they come back anyway.
- After a restore from a backup, the App checks with GitHub what has landed before it ships anything again.
- If GitHub can't be reached to confirm a Ship that a restart cut off, the App keeps asking by itself, a little less often each time. If that lasts (five tries or a quarter of an hour), you get one line under that card ("Landing unconfirmed: main's remote has been unreachable since 9:05 AM, retrying."), and the usual line follows once GitHub answers.
- A tap the box was in the middle of when it restarted is finished afterwards only if the question still holds up the way a fresh tap would. Otherwise you get one line under it ("Your tap was not acted on after a restart; a new card follows.") and Cain asks again once he has checked again. Clock jumps don't change this.
- A Ship tap that the record's restart beats to the push ships nothing, and you get the "Lost to the record's reset" line. Once the push has started, it settles as it really went.
- Shipping something that is already in main now says so on the card ("Already in main, so nothing was pushed") and pushes nothing; installing it is still next.
- If GitHub was unreachable when a restart cut a Ship off, the App asks GitHub about that Ship first once it answers again. If it landed, you get the usual "Shipped" words and Cain installs it, with no new card; only if it didn't land does a new card follow.
- A restart of the record that slips in just before a Ship's push now stops that push too, and you get the "Lost to the record's reset" line.
- If GitHub can never say whether a Ship landed (say main was rewritten), you can settle it yourself: send Cain exactly "settle" with that Ship's tap key and "landed" or "not-landed" (the App gives you both lines ready to copy), and he settles it on that message. A message that names another Ship, says both, or says "not landed" as two words is turned down with the reason, and each message settles one Ship once. Nothing else to set up.
- While such a Ship stays unsettled you get a reminder under its card once a day with those two lines. After 7 days Cain is alerted; after 90 days it is kept on file as a tombstone and no longer stops a new Ship card for the same change.
- A tap's record entry must match what you tapped: each tap now carries what it may do (close that item, start that Ship, or record your answer), and the record checks that, not the wording. If it turns one down, Cain gets the reason and you get one line under the card.
- Taps already used are kept in a log that only grows, so even restoring the App's saved state can't make one count twice. A tap lost that way gets one line under its card asking you to answer again.
- A Ship you settled by hand and later shipped for real shows as one landing, and a record restart during the push never undoes a landing.
- Each button's tap key is saved for good before a question can be tapped, and kept for its whole life (about 100 days). If the App's saved state is ever restored from an older copy, a tap on a question from after that copy gets one line under it asking you to answer again, never a silent "not recognised".
- Even restoring the whole App from a backup can't make a tap count twice: each tap the record used is noted in the record's own history on GitHub, and the App reads it back after a restore.
- A line torn by a power cut in the middle of writing one of its logs is found and cleaned up at the next start, with nothing for you to do. Only if the record keeper finds one of its logs missing does it refuse to start, and Cain tells you in one line.
- When you settle a Ship by hand, the App writes it down first, then acts, so a power cut in between can't settle it twice or half way. Copying the settle line from your phone works even with the backticks, odd spaces, capitals or a long dash it picks up; the key and landed or not-landed must still be right.
- If Cain records a tap the wrong way, the record turns it down without using it up: your answer stands, you get one line saying there is nothing to do, and Cain records it the right way.
- An unsettled Ship gets one line under its card on its first day, then one message listing all of them each day for a week, then once a week.
- Ship taps only install after Cain has finished the tests after this install (he switches them on); until then a Ship tap says installs wait and keeps its buttons.
- After that, Cain offers once, with buttons, a longer resilience run that breaks things on purpose (a stuck save, a restart, a wrong clock, a forced restart of the record, then a restore from your backup and a reinstall). He offers it only once he can see that backup, and you can decline it.

## 0.11.0

- Ship cards now say what your tap installs ("Ship Cain 0.11.0?", or that nothing installs), then one line from Cain on what you'll notice.
- Under it, a line from GitHub: how big the change is, the parts that matter most, and whether its checks passed. A change whose checks failed gets no card.
- The last line is the outside review's verdicts as the review service recorded them, for a review of the change as it is now, with a note that the reviewers read Cain's summary of it, not the code; or "No outside review attached." Cain's own words on the card can't speak of checks or reviews.
- When Cain tells you work was reviewed, his Reviewed line is the review service's own, word for word.
- Cards and Cain's messages no longer show item codes: things are named by what they do.
- After this update the App reads back over your DM once more with the new check, posting nothing, and Cain files what it found. Nothing for you to do.

## 0.10.0

- The checks on the words that reach you are on now. "add-on" is fixed as it goes out. Anything else they catch is held back for Cain to rewrite first: an em dash, a list cut short with "and 3 more", a commit or job id, or a button the message doesn't have.
- They were tuned from the read-back over your DM: "two more questions after this" is fine. Every em dash of Cain's is held back for him to rewrite, never fixed: only he knows whether he meant a break (a comma or a new sentence) or a range ("9:30 to 10:15", "Monday through Friday"), and a comma in its place turned ranges into lists wherever the numbers sat behind bold, units or words ("30 min, 1 hr"). In the calendar specialist's cards an em dash gets a comma only between plain words; one near a number, a day, a month, a time of day, a symbol, a single letter or a link stays as it is, and Cain hears of it.
- Every check runs on every reply: Cain's App is asked which cards are up first, for a second and a half at most, so none is skipped. After the bot's token changes, the App asks Discord for your DM again right then, and until it knows, Cain's replies aren't held back as if they were going to someone else.
- The checks can't silence Cain: if he's held back twice within 10 minutes for his wording, his third try goes out as it is, and he hears so and can fix it. Never for a message to anyone but you, or an edit of something that isn't his reply.
- The calendar specialist's cards are never held back, since a held approval or Undo would be lost to you: their wording is fixed, and Cain hears about anything else so he can set it right himself.
- The App's log of what the checks catch keeps short excerpts in which every link is only its site, whatever kind it is: one without "https://" (a "www." address, or a site or an IP address with a path), one with a "<" in it, or one with a backslash before its "@". A long message is checked in a few milliseconds, however it's written.
- Cain can edit only his own replies, never a card or a notice from his App. An edit right after his reply works.
- Stop is within reach: one red Stop sits on the newest plain message from Cain or his App, never on a card or message that asks you something, so it's never next to Ship or Approve. It moves down only when none of the last 5 messages has a Stop, and Discord shows "(edited)" on the messages it moves between. If Discord is down for a while, it moves once Discord answers again, and a message Discord won't let it onto is passed over for the next plain one near the bottom.
- While everything is stopped, that Stop comes off and Turn back on stays near the bottom: the stopped notice is posted again when it's out of reach, at most once an hour, or 10 minutes after the last one once you write. If none is up anywhere, it's posted each minute until one is, even when the App can't read whether things are stopped (it counts that as stopped). After you turn things back on, one Stop shows: the notice's own, until newer messages push it up and the Stop moves down, leaving the notice.
- How it was checked: tests show that a question from Cain, and a reply of his, naming a button the card doesn't have are held back before anything is sent. The calendar specialist's own words are checked by the test scan on every change, and logged by the App as they go out.
- After this update the App reads back over your DM once more with the tuned checks, posting nothing, and Cain files what it found (the calendar specialist's em dashes that stay as they are counted apart from what would be held back) and checks the new behavior himself. Nothing for you to do.

## 0.9.0

- Cain now knows each card's buttons. When the calendar specialist has a card for you, Cain is told which buttons it has, and he can read any message back from Discord to see the buttons on it now, so he won't point you at a button that isn't there.
- The App now checks the words that reach you: no em dashes, Apps not add-ons, nothing hidden behind "and 3 more", no commit or job ids, and no button named that the message doesn't have. For now it only keeps a log on the Pi of what it would have caught. Nothing is held back or changed yet.
- Once after this update, the App reads back over your DM with the same checks, posting nothing, and Cain files what it found. The checks are tuned from that before they're switched on.
- Before you get a Ship card, Cain checks that Home Assistant answers, so your tap is never spent on an install that can't run. If Claude's Home Assistant connector needs you to sign in again, you get one message with a button that opens its settings, and Cain goes ahead by himself once it's back.
- If Harness stops answering, the first message just says so. If it's still down after 30 minutes, one more line says how to restart it.
- Stop is red.

## 0.8.1

- Your Ship tap now ships the change itself, right away: Cain's App puts it in main the moment you tap, and the card says "Shipped" or why not. Then Cain installs it.
- Once main is locked to the App on GitHub (right after this update), nothing else can change main: not Cain, not his cloud jobs, not a laptop session.
- Stop now freezes shipping too: while stopped, nothing lands in main.
- If GitHub doesn't answer when you tap Ship, the card says it's waiting, and it lands by itself as soon as GitHub answers, for up to 2 hours.
- A Ship card carries a line of its own from GitHub: how many commits and files the change has, and whether it touches the parts that matter most.
- An old Stop notice loses its Turn back on button once things are back on, and says so.
- When a laptop session hands a finished change to Cain, he hears at once, so it reaches your Ship card without waiting for a check-in.
- The App's two keys are left out of Home Assistant backups.

## 0.8.0

- Stop now stops Cain's side too: his Build and Ship jobs, his Ship cards and outside reviews, as well as the calendar specialist. The Stop notice says so, and the morning message's button turns into Turn back on. A job already running finishes; nothing new starts.
- Only your Turn back on tap undoes it, and only from a card that's still current. A tap on an old card does nothing and brings a fresh notice with a button that works. Cain has no button or command for it.
- Your Ship tap is now signed by Cain's App, not by Cain, for that one pull request at that one commit, and it lasts 2 hours. Cain's Ship job is checked for it before it starts. Before, that check read the App's own record of your tap, which Cain's session could change. A Ship tap from before a Stop no longer counts. GitHub starts checking it too with the next update.
- If the calendar specialist doesn't answer a Stop or Turn back on tap, Cain's App posts the notice itself, and passes the tap on as soon as the specialist answers again.
- An outside review asked for while stopped waits and goes out once you turn things back on.
- Cain's checks on his cloud jobs and Discord reads now hold when they're slow: a check that times out refuses, instead of letting the call through.

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
