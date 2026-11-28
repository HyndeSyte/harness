# Changelog

## 0.24.5

- **A Family copy follows its Gmail event every time**, whether you move that day yourself or Harness moves it on a card. A copy knows its event by the event itself (for one day of a repeating event, which day of the series it is), never by its time, so the coffee copy that stayed at 1:45 on Nov 27 now moves with its event.
- **A copy someone changes on Family stays theirs**, even at a time Harness once put there. Harness tells its own late reads from real edits by the copy's version, not by its times, and after two refused writes in an hour it leaves the copy and says so.
- **Harness only takes a copy as its own when it holds exactly what Harness last wrote there, and nothing more.** It compares against its own record of the title and times it wrote, never against the copy. A changed title, start or end, or an alert, a guest, a link, a place, travel time, notes, a status, a repeat or a second event someone added on Family makes the copy theirs: Harness never writes over it or takes it off, and the next digest says once, in one line, that it's yours to keep. Only a short named list of iCloud's own lines is set aside (its stamps, its creator lines, and its default "none" or 15-minute alert); any other line counts as an edit. Harness now writes "busy" on its copies itself, so a fresh copy never reads as edited.
- **Every write to a copy is guarded the same way**, from the sync, a fix card, a take-back or a retry: only over the version that just passed that check, and a new copy never over anything. Harness saves what it is about to write before sending it. If iCloud refuses the write or its answer is lost, Harness reads the copy again and checks it again rather than retrying. If that saved record is missing or unreadable, it leaves the copy alone.
- **A copy someone took off Family stays off.** It is named once in the digest and never made again by itself, even if its Gmail event comes back.
- **Many copies changing at once is called out.** If more than two copies stop matching in one read, or the same unknown line turns up on several, the digest says once that it looks like iCloud changing how it keeps events, not people's edits.
- **A "Take back" card for a copy someone changed** says what changed and, only on your tap, writes Harness's copy over exactly the version it showed.
- **A write whose answer never came back is settled once, carefully.** After an hour, a copy still at the version Harness wrote over, holding exactly what it had, gets one more write; anything else is someone's edit and stays. A copy gets at most 6 such retries in all, then it's left and named.
- **Harness reads the Gmail event again just before it changes a Family copy**, and uses the newest times. For one day of a repeating event it reads that exact day, even after the day was moved, and skips the write if Google answers for another series or day. If the event moves again while the copy is being written, the copy is corrected once, after the same checks pass. If it can't read the event, nothing is written and the digest says so; it tries again at the next read. Only Google saying the event is gone (410) or cancelled counts as deleted; "not found" never does, and three "not found" answers in a row for one copy are named in the digest.
- **Asking to fix a copy gets a card for that copy**, even as a question ("why is the family mirrored event not updating"). If more than one could be meant, Harness asks which. Every copy is offered only when you ask for all of them. Nothing tells you to change a calendar by hand.
- **A fix card does only what it showed.** It checks the whole copy against what Harness last wrote, when it is made and again just before it writes, so a copy whose title or times someone changed is left alone just like one with something added. If the copy or its Gmail event changes before you tap, nothing is written and a fresh card comes instead. A copy is offered off only when Google confirms its event was cancelled or deleted, and the card says which and why.
- **Massages, and every appointment Harness adds for you, get their Family copy.** Drive blocks and busy blocks never go to Family.
- **Drive blocks stay in their dry run until you tap Turn on**, even if you had them on before this update. One card asks once: "Drive blocks: add them to your Gmail calendar from now on?", with how many last week's dry run would have added; if they were on before, it says "Drive blocks were on before this update; tap Turn on to keep them on." Turn on's receipt has Turn off. No setting turns them on; drive_dry_run turns them back off. Keep logging and Turn off each answer with a Turn on button, so the way to turn them on is always on your latest drive blocks message.
- A note from Cain naming a drive block now gets you a card about your drive blocks, marked as from his note.
- The copy you fixed by hand on Nov 27 stays as you left it.

## 0.24.4

- **A tap Harness crosses off stays crossed off**, even when it can't lock its tap journal at that moment, and it never writes the journal without that lock.
- **When reads of its records come and go, the card that taps are waiting still comes once**, and a damaged file beside the tap journal is put aside rather than overwritten, so no tap gets more *Go ahead*s than it should.
- Harness only starts with its tap journal on local storage (ext4 and the like), and its status says whether it can't lock or can't write the journal.
- Event names you wrote stay as written only where Harness itself saved them as yours; any other text gets the full clean-up.

- **The card that taps are waiting comes once for each outage**, even when Harness restarts in the middle of one.
- **A requeued tap always gets a fresh *Go ahead***, even when its count was lost, and a tap stopped for good stays stopped.
- Event names like "Token: pickup" stay as you wrote them when Harness saves a card's words and shows them later.
- Harness won't start with its tap journal on network storage, and never writes a tap down without its lock.

- **When taps wait because Harness can't read part of its records, you get one card saying so**, and that it keeps retrying by itself. Nothing is needed from you.
- **A set-aside tap you put back can get a *Go ahead* again**, and a tap Harness stopped after six listings stays stopped for good.
- A tap of yours that comes in while a set-aside tap is being discarded is never lost.

- **A tap Harness has brought back to you six times stays at six**, however its count is damaged, so it never gets a seventh *Go ahead*.
- **When Harness can't read its list of set-aside taps for a while, it says so** on its status page and in your digest, checks back less often, and finishes the waiting taps as soon as it can read the list again.
- A set-aside tap you discard leaves nothing behind for Harness to act on later.

- **A tap whose calendar couldn't be read during an outage is read again once your calendar answers**, and its card says what Harness found then.
- **A tap Harness can't safely try again says just that**: it was stopped and nothing more is done for it, never that it was brought back several times when it wasn't.
- Your event names show in Harness's cards as you wrote them, even ones like "Token: pickup".
- A tap put aside stays untouched until it's sorted, every tap put off is come back to without a restart, and a tap Harness has listed six times stays at six even if its count is damaged.

- **Every tap Harness put off is come back to without a restart**, even when two wait on different times, and each is finished once.
- **A tap whose listing Harness can't save reads your calendar once**, however many hours it takes to save it, and taps finished one by one after that share one summary card.
- **A tap you discard with the set-aside taps tool is left alone for good.** One you put back that had been started is read on your calendar first and gets a card, never done again by itself.
- A tap's listings are never counted from one again when Harness can't read the count, so its last card still comes. Error details Harness keeps or logs anywhere never hold keys, tokens or passwords.

- **One tap that Harness can't save no longer holds up the others**: the rest are still listed and finished in the same minute, and that tap is tried again on the 1 to 60 minute schedule without reading your calendar again.
- **A tap Harness set aside always gets one card**, and the set-aside taps tool on its command line can now keep a copy of one, discard it for good, or put it back, checked first, so a cleared tap is never acted on twice.
- A tap brought back to you six times gets one last card saying nothing more is done for it, and a copy Harness can't save is set aside with a card instead of being retried forever.
- If Harness can't save anywhere, its status says so. Error details it keeps never hold your keys or web addresses' private parts.

- **A list of taps after a stop comes once**, with one card and one Go ahead per tap, even when Harness can't cross the taps off yet; it only tries crossing them off again, and doesn't read your calendar for them again.
- **A tap listed a second time gets a Go ahead that works**, and after six tries on one card that still can't read your calendar, one last card says nothing more is done for it.
- **The card that asks you to check your calendar is the only one that can**, and what Harness was working on is always kept before the tap is crossed off. A cleanup step it can't read is set aside once and left alone after that.
- If Harness keeps restarting while it can't save, it still keeps its reading schedule and tells you once.

- **When an error inside Harness leaves a change unconfirmed, the card says so plainly**: Harness couldn't confirm whether the change was made, and asks you to check your calendar to see whether it's there. What it was working on is kept in its records so it can be traced.
- **A note that a tap is waiting comes once**, even when Harness can't note that it told you, and even across a restart. A card bringing Go ahead back comes once for each time you use it.
- Harness keeps to its 1, 2, 5, 15, 30 and 60 minute schedule for reading your calendars even when its storage can't be written at all, and a tap's leftover cleanup note that can't be read is finished or reported once, not skipped forever.

- **A tap Harness couldn't finish always gets its card.** The card is saved first and the tap crossed off after, so a stop in between never leaves a tap gone with nothing said. A note that can't be crossed off waits its turn, even across a restart.
- **An error inside Harness on a tap ends after a few tries** with one card saying so, instead of being read every hour. It never says your records couldn't be read when that isn't what happened.
- **A tap Harness can't match to a request says just that**, and that nothing was changed. A part Harness can't tell anything about says it can't tell, never that it may have reached your calendar.
- Harness no longer reads your calendars over and over when it can't note a tap's outcome, and a second card about the same tap (such as a retry card) is never dropped as a repeat.

- **A tap Harness couldn't finish gets its card once, never again and again.** If its note can't be crossed off, the card waits with it and Harness tries again later, after a few minutes and then hourly. Any number of such taps all get their own card.
- **The records and your calendar each get their own tries.** If Harness's records couldn't be read for a while, your calendar still gets its full six reads once they can.
- **A tap Harness can't identify says so once**, with no Go ahead, instead of being read again every hour.
- **A part that was checked and isn't done says just that**, and to ask for it again if you still want it. "May have reached your calendar" is only said when Harness can't tell.
- A card Cain's link turns down now still says what happened (done, not done, or couldn't verify). Setting aside files can accept a lost file that isn't needed, so the rest can finish.

- **A tap is never written off because Harness's own records couldn't be read.** It's kept and read again on the same schedule, and at every start, until the records answer.
- **A tap whose calendar couldn't be read keeps its true card** even if Harness stopped right after deciding that: the next start says again that your calendar couldn't be read, never that Harness didn't get to your tap.
- **A retry card shows what its write will find.** It reads the very events the first card was for, so an event that turned up there in the meantime shows as already there.
- **Nothing asks you to send a request again** after a failure that wasn't yours. A part that isn't done again says why: its write may have reached your calendar, it leaves nothing Harness can read, or your calendar couldn't be read. When a Go ahead can't read your calendar, the same Go ahead comes back on a new card.
- **Why one card has Go ahead and another doesn't:** an add that never showed up in Google across a restore gets none, because an empty spot where Harness writes can't be told apart from an event added and deleted since; a tap whose decision never reached Harness's records gets one, because nothing it leads to ran.
- A card Cain's link turns down twice still reaches you, as a short fixed card with its buttons. Setting aside files names any file left with neither a good copy nor its original, and changes nothing else.

- **A tap whose change is still being carried out is never given up on.** Harness keeps reading it every hour, and at every start, and tells you what came of it once the change has finished. A tap whose calendar can't be read is read after 1, 2, 5, 15, 30 and 60 minutes, then its card says your calendar couldn't be read.
- **A change that didn't all go through says which parts.** Its card names each part that isn't done. Parts that are safe to do again come back on a new card for your approval, written to the same events so nothing is made twice; where Harness can't tell whether an event was added and taken off since, the card asks you to ask for it again.
- **Undo never guesses.** A change recorded before Harness kept each event's version isn't undone automatically: the receipt says so and asks you for the change you want on a new card. A day of a repeating event you edited in any way since (notes, place, guests, reminders) is left alone.
- **A repeating event you deleted is never put back** from a tap's card, and one already there is never added twice.
- **A card Cain's link turns down still reaches you**, with only the sentence that pointed at a missing button taken out, or as a short plain card with its buttons when nothing else would be left.
- Setting aside files that blocked a restore picks up where it left off even if its progress note was cut short, and a delivery mail with a link at a domain like "myaccount" is judged on its content.

- **Cain's handover acts on the message you meant.** When you send a few messages in a row, Cain names the one your calendar request is in, and Harness acts on that one (from the last 30 minutes), not on whatever you sent last. The same message handed over again gets its own answer, never the answer to another message.
- **Details Cain spells out are used, with your tap.** A request where Cain passes on the event (a date from an email, or what you asked, spelled out) is no longer turned down as too old after 2 minutes. It comes on a card, and your Approve is the go.
- **No card asks you to say it again.** When Cain passed details and something is still unclear, the question goes to Cain first.
- **Two changes in one message, a card each,** when they need your tap, so you can approve one and not the other.
- **A reply that didn't fit is tidied or run once more by itself,** and if it fails twice the message says what happens next.
- **"What does that card mean?" gets an answer.** Harness reads its own recent cards and explains, and never takes the question for a change.
- **The kids' dates from your mail go on Family, never your Gmail.** School, teacher, coach and the kids' doctor mail get a card naming the Family calendar, with Add to Family and Skip. When only the sender looks like a school, the card offers Family and Skip, never your Gmail. With calendar changes off, there's no Add button, and a line says why. Your own dates still go on Gmail, and the message now says "on your Gmail calendar".
- **Done means the calendar shows it.** After every change and every Undo, the days it touched are read again. It's Done only when the calendar shows it as asked; otherwise the receipt says "Not confirmed" and what the calendar shows instead, and it's never written again on its own. A read that disagrees is read once more a few seconds later.
- **Not seen isn't not done.** A change the calendar doesn't show yet is read again about 30 seconds and 2 minutes later, then once more after a longer window, by its own id. You get "Confirmed" once it shows, "Not seen yet" in between, and "Not found" only after the longer window; if it shows up later still, "Done after all" with Undo. Asking for the same add again first looks for the first one, so it's never added twice.
- **A write can't hang or land twice.** Each write ends by itself within 45 seconds, however slowly the calendar answers, and is settled by reading. If several are stuck at once, new changes wait on a card that says writes are paused, and come back on a fresh card once writes resume. A change offered again keeps its first event id, and if the first write lands late after all, you get "Done after all" with Undo and the newer card comes off.
- **A move or removal is never sent over a change since its card.** Just before writing, the event is read again. If anything the card showed changed since (its time, end, notes, location, guests, organiser, whether it shows as busy, or the series's repeat), or its version moved on, nothing is sent: the receipt says "Not applied", what changed and what it shows now, and one fresh card follows with it as it is. A second card on another day of the same repeating event still goes through, guarded by the version just read, and the write keeps every other day's changes as the calendar has them. If a calendar turns a write down while a read gives back the very version that was sent, you get one plain "Not applied" saying the calendar refused its safety check, with Try again for a new card from a fresh read.
- **One fresh card per change, then your call.** If the fresh card is stale too, its receipt says what changed on the event since your card and offers Start again from now, which makes a new card from the event as it is now.
- **A day that comes back as the whole series isn't written.** The receipt says the calendar returned the whole series for that day, nothing changed, and to tell Cain whether you mean that day or the whole series.
- **A write of yours that landed late is found first.** If the calendar already shows a change because your earlier approval's write went through late, you get "Done after all" with its Undo, once, never a second event or a second Done. A late "Done after all" quotes your request, says when you asked and how it was approved, says how old the request is when that's more than a day. If you'd declined the card that offered it again, it's titled "Applied despite your Decline": a plain add still as it was written is taken off again by itself and the same receipt says how that went (off, turned down with Undo kept, or still being read), and anything else comes with Undo first, good for 30 days. A late write takes every open card for the same change off, including the fresh card after a refusal.
- **A removal or move changes exactly the event its card names,** and for a repeating event the card says whether it's that day only or the whole series. Undo puts back exactly that.
- **Already there is never silent.** Asking to add the very same event (same calendar, title, start and end, all day or not, repeating or not) adds nothing, and the receipt names the event that's there with an Add anyway button. Something only like it (another end time, one day of a series, a similar name) comes on a card naming it, with Add anyway and Leave it, and nothing is added until you tap.
- **After every update, cards wait for the check after installing, calendar by calendar.** Until the check has read back on Gmail (or Family) a guarded move of an event that was there and an edit of one day of a repeating event, a card for that calendar says it's waiting, with no Approve, and nothing changes; once it's done there, each waiting change comes back on a fresh card for your tap. If a calendar refuses the safety check on an unchanged event during the check, you're told edits there are blocked and why, with Open cards without the check (kept in the log). Every new build counts as an update, even of the same version, and a change to any file the App ships (its code, the Dockerfile, its settings file or its start scripts) makes a new build. The check is good for this build only, for 24 hours, and for one Turn on; its test events are titled "Smoke test:" and any left over come in one message with Take them off, found even when a step sat near midnight or was a repeating event.
- **Each step of the check starts with your tap.** Cain offers each step with exactly what it will do (which calendar, add, move or remove, the test title and day), on a card with Start step 1, 2 and on. Your tap makes that step's change from that script, never from a message, on a card for your Approve. A request of yours handed over while the check runs is always your own, held with your title, never a test.
- **The check only owns its own steps.** Only a step you start for the check is part of it. Your own requests, dates from your mail and Family adds that come in while the check is running are held like any other until that calendar is open, keep their own titles, are never taken off with the test events, and come back on a card of their own. A waiting change comes back saying how long it waited; one whose day has passed comes back as a "Dropped" receipt instead; when more than three come back at once, one message saying so comes first.
- **A calendar must prove it refuses an out of date write, of every kind.** During the check, Harness writes only to its own test events: an edit, a removal and an edit of one day of a series, each sent with a version it made out of date itself. Each counts only when the calendar turns it down the way it says it does and a read shows it wasn't applied; any other answer keeps that calendar waiting. If it takes only the out of date removal, removals there stay waiting even after Open cards without the check. The check runs again after every update.
- **A calendar Harness can't change safely is never a dead end.** If a calendar takes an out of date edit, or turns down even an edit sent with the version it had just given, you get one message saying in plain words that Harness can't change that calendar safely and that you can make changes there by hand. Each request waiting for it is passed back in that message as a line ready to copy, and any held later comes the same way at once. Open without protection lets Harness change it anyway, each change read and compared just before it's written but sent without the calendar's own version check, and every receipt there then says Unprotected. Test again is there too when the calendar turned down the fresh edit.
- **Calendars that give only weak versions work.** Their versions are compared loosely when Harness reads, and a change there is read and compared just before it's written instead of relying on a version check the calendar can't do.
- **Held requests are told when they're held.** The first request held on a calendar brings one message saying changes there are held for now, why, and what lets them through. While any wait, one reminder a day gives the count, and a held request gets a reminder on its day. Only an add whose day has passed is dropped, with a receipt; a move or removal comes back on a card.
- **A calendar that stops protecting is closed again, for a real reason.** One that passed the check closes again only when a change it took altered the event and kept the same version; the message names that change. A change that altered nothing never closes it.
- **No endless retries on a calendar opened without the check.** If such a calendar turns a change down while the event hadn't changed, the first receipt quotes your request and offers Start again from now once, later ones offer nothing, and one message says edits there can't be applied safely and the likely cause.
- **An update rehearses moving your records by itself.** When an update starts, Harness rehearses moving your records on a copy of them, and if that passes it keeps a copy of your records and moves them at once, with nothing for you or Cain to do. A rehearsal only counts for the exact version and state of your records it was made on, and for a day. Only if the rehearsal fails do calendar changes wait, and you get one message saying why with a Run check button that tries the rehearsal again. Moving them without a rehearsal is your tap alone, on a card that says it's unrehearsed, why the rehearsal failed and that a copy is kept first. Repeated attempts don't pile up copies, and the oldest copy is kept until a later update has run a day.
- **Only three things go through without a tap,** and all are off after every update until the check after installing has passed, as Harness's own record of it shows (each step's event, when it was asked and read back), and you tap Turn on on the card that shows that evidence and lists each path; a Turn off button then stays on that card: your own newest message, under 2 minutes old, with nothing from Cain, one change and no open-ended day; a date from your mail you tapped Add to Family on; and Family adds after your stop-checking tap. Until then, every change comes on a card. Each is checked again at the moment it's written, and if you send another message while it's being written, the receipt says so, keeps Undo, and that message is taken as a correction of it. Anything else comes on a card that quotes your message, says how old it is and how many you sent after it, spells out the change, and marks anything that came from Cain as "from Cain".
- **Days in your words are counted from when you sent them, by your own clock,** even across a daylight saving change, so "tomorrow" sent just before midnight is the right day, and the card and receipt show how a word like "Friday" was read. "Next Friday", "Friday" sent on a Friday, "the 16th" sent on the 16th and "tonight" sent after midnight come on a card.
- **A correction replaces only the card it corrects.** Other cards from the same message stay, and a tap and a replacement can never both count. When it could be one of several cards, or it's not clear, a card asks which. A note that changes none of them comes on its own card quoting it; they stay, and Approve asks once more, and says so if the card ran out or was replaced in between. A note on a message whose cards you declined or let run out brings it back on a new card.
- **What the last version left is swept once** when this one starts: open cards lose their buttons, a change it was writing is read back and said as done or not confirmed (never written again), and one message lists what was replaced, with Propose again to bring each back on a card of its own. One the calendar already shows is said as confirmed, and an old one is called done only if the calendar made its event after your approval.
- **A question Cain doesn't answer in 10 minutes comes to you,** on a card that quotes what's already known, even after a restart.
- **Nothing is done twice.** When a request runs again, what the calendar shows as done is shown as done, something still being written counts as in progress for 2 minutes, and anything not done is offered again on a card.
- **Mail is read as data, never as instructions,** and never changes a calendar without your tap.
- **Every change sent without the calendar's version check says Unprotected,** on its card before your tap and on its receipt after, whether you opened that calendar without protection or the event only gave a weak version. Open without protection says plainly that edits made at the same time by someone else can be overwritten or deleted, and it opens that one calendar only.
- **A possible lost update is told.** After a change sent without the version check, Harness reads it back, and if anything your change didn't touch changed too, you get a Possibly overwritten message with each value before and after.
- **No loop of closing and reopening.** A calendar you opened without protection, and any change sent without the version check, never closes that calendar's cards again. A change the calendar doesn't show afterwards still says Not confirmed and is counted for the next check.
- **Moving your records is safer.** The copy and the backup are taken with SQLite's own online backup, checked (integrity and row counts) before anything moves, and everything else that writes your records waits while they move in one step, so a stop in the middle leaves them as they were with the backup beside them, and the next start moves them again.
- **A wait is never silent.** If the rehearsal fails, its message is sent again until it reaches you, a reminder comes once a day, and Harness's page shows the wait.
- **Backups follow run time, not the clock.** The oldest backup stays until Harness has actually run a day on the new version, and nothing is deleted while the clock looks wrong.
- **Put your records back by version.** A backup can be restored by its schema version and build, on your tap (Put them back) or from the App's command line; it takes effect the next time Harness starts and is moved to the running version again. A Home Assistant backup before installing is the copy off the device.
- **The check after installing records more.** It records whether each calendar gives strong or weak versions, and on Family whether a change sent with no version check is taken, before the no-card paths can turn on.
- **Putting your records back is safe at any moment.** Your Put them back tap (or the command line, which now refuses while Harness runs) only stages the backup; Harness swaps it in at its next start, before it opens the records, moving the old records and their log aside together, and a stop in the middle is finished at the next start.
- **After Put them back, one card asks you to restart Harness now,** saying how old the backup is and what's set aside (held requests, untapped buttons, writes still being confirmed, changes you could undo). Until the restart nothing new is taken, and after it the requests held in the records set aside come back to you ready to copy.
- **A move that fails or is cut short doesn't stop Harness starting.** It runs degraded, its page and Cain's health check say so, and you get one message with Run check and Put them back. A full disk is said plainly before anything is copied.
- **When the clock is behind Harness's own records,** its page names the record holding up backup pruning, and one card offers Use the clock as it is now.
- **Fewer false Possibly overwritten messages.** The check after installing learns which fields each calendar rewrites by itself, and only those are left out; someone's real edit is still told.
- **The check's write test on Family uses an event far in the past with no alarm,** titled as safe to delete, and removes it before it records the result.
- **Taps are never lost.** A tap is saved beside your records before Cain's link is told it was taken, and its answer comes once what it did is saved. A tap caught by a restart is taken when Harness is back, or you're told it wasn't; a tap made while a restore waits for the restart gets the restart ask at once.
- **Putting your records back survives a power cut.** Each step of the swap is written to disk before the next, and a start after a cut at any point finishes it without repeating a step. Harness never opens your records beside a log that isn't theirs: it starts degraded and says why instead.
- **The command line restore and Harness can't step on each other.** They share one lock, so a start waits for a restore being staged; when Harness runs degraded without its records, a restore can be staged without stopping it.
- **Held requests in the records set aside all come back, once each,** even ones only in their log, one message per request after the restart. Older sets aside are cleared after that, the latest kept.
- **A move that had finished before a stop is seen as finished,** so the next start is normal instead of waiting for your Run check.
- **Possibly overwritten is told for a time zone or all-day change by someone else,** and for a real note or description removed, even on a calendar that tidies fields by itself.
- **The check's write test event gets a fresh address each time** and is only ever created where nothing is; if it can't be shown gone, each start tries again and Harness's page shows it until it's gone.
- **The receipt card's third button is now "Not this time"** (it was "Just this once"): it takes that one block off and remembers nothing.
- **Mail you've said no to is skipped,** starting with Amazon's Subscribe & Save delivery management mail (its cutoffs and delivery changes). An order's return window still comes through. More kinds can be added by name in /data/mail_skip.json, no update needed.
- **A tap that can't be saved is turned down at once,** with a note that nothing changed, never left waiting.
- **A tap is never done twice across a restore.** After your records are put back from a backup, taps from before it aren't carried out by themselves: one message lists them, then a card each with Go ahead, if you still want it.
- **A turned-down tap is told once,** even when Harness restarts before it can tell you, and a tap while Harness runs without its records is answered on the spot.
- **Two restores in a row bring back every held request, once each.** A set of records put aside is cleared only after its own requests came back.
- **Amazon's skipped mail is only Subscribe & Save delivery management.** Prime, Audible and Kindle renewals, an order's new delivery date and its return window all come through. Harness's page counts the mail it skipped, with sender, subject and the rule, and if mail_skip.json has a mistake it's ignored whole and the page says why.
- **A restore whose own note can't be read moves nothing.** Harness starts degraded and its page lists the files beside your records. A restore refused for a file that isn't its own can be sorted from the App's command line, which moves just those files aside after you type yes.
- **No button is dead after a restore is staged.** A card with buttons waits, and after the restart its words come back once, without the buttons that belonged to the records set aside. A tap meanwhile is answered that Harness is waiting to restart.
- **A start that waited for a restore being staged goes on by itself** once the staging is done; its page shows the wait.
- **While a restore is staged, Harness's page still shows its loop and its clock check,** so a stuck Harness never looks like one waiting to restart.
- **Possibly overwritten is told for a removed repeat exception in another time zone,** and time zones some calendars write by other names (Windows or older names) are no longer told as someone else's edit.
- **After a restore, Harness looks at your calendar before offering a tap again.** A tap whose change is already on your calendar is marked done with no button, so nothing is added twice. Each tap from before the restore says plainly whether it was carried out, not carried out, or Harness can't tell, and Go ahead reads your calendar again before it does anything.
- **Every tap from before a restore is listed,** the newest ten with a Go ahead each and any older ones in a second message by time, with how many were in each state.
- **A tap that went through but couldn't be noted down says so,** instead of being ignored.
- **A restore held up by a stray file goes on by itself once the file is gone,** and the command line that moves stray files aside only ever moves the restore's own stray log files, checking each copy first. If Harness can't tell you it started without its records, its page says the note wasn't delivered.
- **A Subscribe & Save advert at the bottom of an ordinary Amazon delivery mail no longer hides it.** Only a mail that says Subscribe & Save at the top or in its subject is skipped, and mail_skip.json has size limits (50 kinds, 20 words a list).
- **A tap cut off by an error is never called turned down.** If something goes wrong after Harness began acting on your tap, it says it can't tell yet whether it went through, keeps it, and reads your calendar for it at its next start before doing anything with it; nothing is done twice.
- **Add anyway and Undo are looked for on your calendar too.** After a restore, an Add anyway already there isn't added a second time, and an Undo already done isn't done again. A kind of tap Harness can't look for on your calendar gets no Go ahead once it may have run, and its card says so.
- **A change you deleted since isn't put back.** If the calendar shows an event Harness added was taken off afterwards, its card says so, with no Go ahead. For a change of several parts, the card says which parts are there, and Go ahead does only the rest.
- **Every tap card after a restore is pointed to, never promised a button.** A tap whose time can't be read still gets its card, marked "time unknown".
- **Subscribe & Save mail that opens with a greeting is still skipped,** and a word like "deals" in it no longer counts as an advert; an ordinary order mail with a real offer in it still comes through.
- **Setting stray files aside from the command line takes back a copy that fails,** a full disk included, says why and leaves everything as it was.
- **A message held through a restore makes no promise it can't keep,** and one whose time had already passed says so.
- **A tap cut off by an error is read again within minutes, not only at the next start.** Harness looks at your calendar for it about a minute later, tells you once when it will look again if it can't tell yet, and gives it its card once it can.
- **A tap cut off before Harness took it gets its button back.** If the error came before your approval was recorded, nothing ran, and its card says so with Go ahead. One Harness was still carrying out is followed to the end before its card comes, never dropped.
- **Undo never overwrites an edit of yours.** It only acts on an event still in the version your change left it in; one you edited since is left alone, and its card says it changed. An Undo already done is said as what it leaves: the event gone, back, or as it was.
- **An event gone from where Harness added it is never added again from a tap's card.** On Google (deleted, or not found) and on Family alike, the card says Harness can't tell whether it was added and taken off since, with no Go ahead. The "since taken off" rule now covers Family as well as Gmail.
- **Go ahead only for taps Harness knows how to look for.** Any other kind of tap, including one a later version adds, gets no Go ahead once it may have run.
- **Two removals on one card are each checked on their own,** so one being gone never makes the other look done.
- **Go ahead on a change that's partly there re-reads your calendar just before it runs,** and only for that one run.
- **Add anyway never adds blind.** If your calendar can't be read to check first, nothing is added; if the second event turns out to be there already, the receipt says nothing was written.
- **No card of Harness's points you at a button that isn't on it,** and if Cain's link turns one down for that, it still reaches you without that sentence.
- **Setting stray files aside picks up where it stopped** if a removal fails partway, without copying anything twice.
- **Subscribe & Save mail is still skipped when its first line reads like a greeting,** and an unsubscribe or privacy link no longer makes an ordinary mail look like an advert.

## 0.24.3

- **Telling Cain about a change to your calendar works again.** Since 0.24.1, every calendar request crashed before Claude was asked, and the message wrongly blamed Claude's reply. "I cancelled PT today" on Nov 19 was one of them. Finding which Gmail calendar is yours now happens before the request is handed off, and a failed lookup no longer stops the request.
- A crash on our side is called a bug in the calendar specialist, never a bad reply from Claude.
- A retry that runs within seconds is no longer announced. You hear only how it turned out, so a "running it once more" note can't arrive after the answer. A retry after a ten-minute timeout is still announced.

## 0.24.2

- The calendar App now signs everything it sends to Cain's App, with a key of its own, and takes an answer only when Cain's App signed it. Nothing changes for you.
- A card that waits through an outage goes out once, even when its first try got through but the answer didn't.
- A message that can't reach Cain's App for 7 days is dropped rather than risk it going out twice, and the morning digest counts it.
- Install it together with Cain 0.13.1, Cain first. Until it's in, its cards wait at Cain's App; none is lost.

## 0.24.1

- **A block made before Harness could read its address now gets it, with its drives.** On the next read, an event you go to whose block has no address or no drive blocks gets both, the same as a new one: the street address on the block and "Busy (drive there)" and "Busy (drive back)" around it, sized from the real drive. Thursday's school event is the first one this fixes.
- **An event you go to at school gets its drives** when its location has a street address (the school's name on one line and the address on the next included). Before, an event at school never got drives, and nothing said so.
- **A drive block you deleted stays deleted,** and one that's already there isn't written again. If you put a drive on Gmail yourself, Harness doesn't add a second one beside it.
- **A missing drive is never quiet.** An event you go to that's left without its drive blocks is named in the morning digest by its day and time, and in Harness's log by its title and day.
- **A school run is the drive only at school.** When an event at school ends as your pickup starts (or starts as your drop-off ends, within 15 minutes), the run is the drive, and no "Busy (drive there)" or "Busy (drive back)" is added beside it; one Harness wrote there before comes off, and the digest says so once ("removed the drive back for" its time). An event anywhere else keeps its drives, even right before a pickup, and if a drive crosses the run the digest names that event's time so you can sort it out. A drive Cain put on your calendar at your word counts as the drive too.
- **An event at another place is never taken for school by its name.** A school concert at a theatre or a trip listed under the school keeps its drives when its address isn't the school's. The school's address written another way ("St" or "Street", with or without the zip code) still counts as school. When only the event's name puts it at school (it has no address of its own), a drive left off for the school run is named in the digest: "left off: assumed at school".
- **An event is treated as online only when its place is a link or empty,** or only says online: then it gets no drive, and the digest says "no drive: online" with its time. A title like "Online safety evening" in the school hall, a "Virtual Reality Lab, Room 4" or a club called Zoom at a street keeps its drives. A Meet link in the notes of an event that has a room or a street doesn't count either. A place that only says webinar, livestream, Teams or Meet is online; "Meet at the gate" isn't.
- **A school event with only a room's name drives to the school and says so.** A room, a hall, the gym or no place at all gets the school's address from your place book or from the school address in Harness's settings, its drives, and a digest line saying the school's address was assumed. A place of its own that nothing knows (a leisure centre, say), or a short name that isn't a room or a class (a pub, a church, "Grandma's"), isn't sent to the school: the digest says its drive is missing.
- **A missing drive anywhere in the day is named,** not only the first or last one: a drive home from the middle of the day, or the drive on to the next event when that one can't be found. A drive still waiting for its lookup is named once it has waited three reads of its own, even while others get through and across a restart, or once the event is within a day. An online event between two others is no stop: the one before it gets its drive home.
- **Only a real drive of yours counts.** A test drive, a food drive, Google Drive or a driving lesson on your calendar doesn't stop a drive block ("Drive to 12 Oak Drive" still counts as a drive). A short drive of yours near an event doesn't take the place of a longer one, and when a drive of yours is taken as one, the digest says "left off: covered by your" and its title, so a wrong match shows.
- **Two calendars that look like yours are named in the digest,** with one message saying so: nothing that needs your calendar is done until one is removed. The calendar holding Harness's own blocks stays yours if a second appears, and the digest names both and the one in use. A new setting, his_calendar, names your calendar outright when you want to. If your calendar stops being read, Harness stops and tells you rather than use another.
- **No false "couldn't look up the drive" line** for a drive left off on purpose: one a school run or a drive already on your calendar covers, one you skipped, one held online, or one already behind you.

## 0.24.0

- **Your own appointments get drive blocks.** An appointment on your Gmail calendar with a street address gets "Busy (drive there)" and "Busy (drive back)" around it, sized from the real drive and rounded up to the quarter hour, just like the Family events you go to. Back to back, the drive goes straight from the first place to the next, and only the last one goes home. They move and go with the appointment.
- **Each appointment's drives get a card with Undo,** with the morning digest, when they're added or moved. Undo takes them off and keeps them off for that appointment.
- **Skipped on purpose:** blocks Harness made, "Busy" holds, events shown as free, all-day events, invitations someone else organized, calls, telehealth and anything online, and events with no location.
- **A location with the place's name on one line and the street address on the next is read as that address,** so its block gets the address and its drives. A suite number or a town written without commas no longer cuts the address short.
- **A drive that can't be found is never left off quietly.** The digest still names the day and time, even beside another problem, and you get one card saying the day, the time and why (no usable address, or the lookup failed), with Skip. If you're already being asked where that place is, that question is the card: never two for one event.
- **Calls are left alone:** an appointment whose location is a phone number, or whose title or location names a phone call, gets no drive blocks and no card.
- **A town that starts like "Suite" or "Floor" (Sterling, Florence) keeps its town,** so those addresses are looked up and kept as they are.
- **Fewer false alarms and gaps:** many new addresses at once are looked up over the next reads without a "lookup failed" card; an appointment right after one that can't be placed still gets its drive from home; a read of Gmail that's cut short keeps that day's drives as they were; a place you skipped stops being named in the digest; and once the place book has your answer, a drive that then can't be looked up gets its card.
- **Repeating appointments:** each week of a series gets its own drives. Moving one week moves its drives, cancelling one takes them off, and editing the whole series never leaves two sets of drives on a day.
- **Calls, read better:** a place that's only a phone number gets no drives in any of its usual shapes (a tel: link, an extension, a country code, letters like 1-800-FLOWERS, or a dial-in with its PIN). A street address wins over the title, so an outing called "Curtain call" at a theater keeps its drives.
- **When Gmail can't be read in full,** only your own appointments' drives stay as they are. A Family event that moves or is cancelled meanwhile takes its drives with it, and after a day without a full read the digest says so.
- **An appointment beside a Family event that's never judged** no longer waits for good: after a day, or a day before it starts if that's sooner, it gets its drives from home, and they're worked out again once the judgment lands.
- **The nearest drives are looked up first,** and one still waiting within a day is named in the digest and gets its card.
- **No impossible drive from home:** when the place before an appointment can't be found, the drive from home is used only if you can get home and leave in time without crossing another drive; otherwise the digest names it and you get a card.
- **Harness's own blocks are never taken for your appointments,** even if it loses its records: anything titled exactly like one of its blocks, one it has a record of, or a drive block it finds on your Gmail by its mark gets no drives. A timed appointment Harness put on your Gmail from your mail is yours, so it gets drive blocks when it has a street address. Drive blocks carry no guests and send no updates.
- **A new setting, own_drive_days,** says how many days ahead your own appointments get drive blocks. It starts at 3, so you can check a few real ones first, then widen it (up to 60).
- **A dry run first: a new setting, own_drive_dry_run, starts on.** While it's on, the drives your own appointments would get are only written to Harness's log, with each appointment's day and time, never to your Gmail, and no card goes out for them. Nothing on your Gmail changes because of them: Family events' drives come out exactly as they would without your appointments, and nothing the dry run counts carries over once you turn it off. The morning digest says how many drive blocks would have been written and how many appointments would have lost theirs. The dry run looks your appointments' drives up on the map, under the same limits as live use, so its log lines carry real times; what it finds is kept apart, and the Family events' drives and lookups come out exactly as the last version's. The log also gets each download's status and a short fixed list of headers (never a redirect's address or a cookie, and the ETag only as a short fingerprint), a failed download names only the server, never the calendar's secret address, and a few anonymised examples (titles and places replaced) of a split, a cancelled week and a moved week are kept in Harness's data folder: at most 3 of each, none older than 14 days, any left by an earlier version removed when the dry run starts, and all of them removed when you turn it off.
- **Your appointments' drives only come off when your calendar clearly says so:** a week taken out of a series, a series ended before it, or an appointment that no longer needs a drive. One that's just missing from a read keeps its drives until two full reads in a row agree, and nothing else that day changes until then.
- **Nothing is written on a read that's cut short.** Your drives stay exactly as they are, busy, and nothing is added, moved or removed for your appointments until a full read.
- **Odd changes wait for you.** If your calendar comes back much smaller than before, or more than three appointments lose their drives at once, you get one card listing them by day and time, with Take them off and Keep them. Nothing comes off until you tap Take them off, and only drives still exactly as the card listed them: one that changed since stays, and the digest names it. A tap more than 3 days old isn't acted on: the card asks again. A one-off bad read sends no card: the same smaller calendar has to show on two reads at least 2 hours apart first (a "not modified" answer counts), or the oddity has to last a day. If your calendar is back to normal by the time you tap, nothing comes off.
- **Splitting a repeating appointment ("this and following")** keeps its drives when it's clear which new series replaces the old one (one ends, one starts, same title): each week's drives go to the same week, even with a week missing, and weeks past the old series' end are simply new. If it isn't clear (including when the weeks don't line up one clear way), or many weeks move by more than 2 hours or to a new place, the card asks you first, and the new weeks wait for your answer.
- **Drives put back just as you were last told** don't send another card.
- **Events you declined or marked as maybe get no drives.**
- **When Gmail isn't read in full, a Family event's drives still go on.** Your own appointment's place isn't used for them until a full read confirms it. If one of them crosses a drive kept for your own appointment, both stay busy, the digest says so, and you get a card when that event is within a day.
- **A drive left off within a day of its event always gets its card,** with the reason, straight away.
- **The digest says when your Gmail calendar hasn't been downloaded in full for more than 6 hours.**
- **If Harness loses its records, or gets an older copy back, it doesn't double your blocks.** It finds the blocks it made on your Gmail and takes them back, and an exact duplicate comes off. If two of its blocks fit the same spot, it takes neither and the digest says so. Blocks without its mark are never touched.
- **A new setting, remove_all_blocks, starts off.** On, the drive blocks Harness made around your own appointments come off your Gmail (Family events' blocks stay), except ones you edited (each is read again just before it goes, and one whose title or times differ stays), which the digest names, and nothing new is written while it stays on. With the dry run on it only logs what it would remove. Off again, they're written as before.
- **Nothing new is written to the Family calendar.**

## 0.23.0

- **Nothing asks you to check the calendar or send something again.** When a change's answer is lost, or it can't be read back, Harness reads the calendar itself a minute later. If it went through, you get the usual receipt with Undo, and Undo puts all of it back, even after a restart cut the write short. If it didn't, it's written once more, only over the very version it was first written over, and if it still didn't go through you're told so plainly. If the event was changed on the calendar in the meantime, even back to how it was, it's left as it is and you're told so. If half of it went through, the rest is finished, or that half is put back.
- **When a read can't tell, you hear once.** Reads come each minute for the first hour, every 15 minutes for the rest of the day, then hourly. After an hour, one line says it isn't confirmed yet and is still being checked, and the receipt follows once it's known. Once the event is over or a week has passed, one line says it couldn't be confirmed, and the reads stop. The morning digest says "not confirmed yet, still checking".
- **A Family add iCloud answered but a read doesn't find** is written once more at the same address, so never as a second event, and if it's still not there you're told so plainly. Another event found at its address isn't called added, and a read with no event in it is read again. An add iCloud answered that reads never confirm keeps its Undo on the line that says so.
- **An undo cut short by a restart finishes by itself,** Family adds included, or says it's already undone. An undo the calendar turns down says so, with Undo, and is never sent again on its own. One whose answer was lost is read before anything is said, even when iCloud can't be reached or turns its second try down: gone is undone, still there is said with Undo, and changed since is left as it is and said so. Its second try counts only once its delete goes out. Each Undo tap is tried afresh.
- **Undo leaves alone what you changed since,** a Gmail add you moved or added a note or a guest to, and a change you made before Harness read its write back: a note or an alert you added or took away, travel time, or a repeating event's time zone.
- **What you send while stopped, and an Undo you tap while stopped, comes back after Turn back on,** one card each, with Do it now and Drop it. Drop it is final. Do it now on an Undo holds even if Harness restarts right then. While stopped, nothing is written or said about a Family add; its reads wait for Turn back on.
- **A failure that isn't yours is retried once by itself,** whether or not Cain is in front. A change Harness was writing when it updated isn't written again, so it can't be made twice.
- **A block Google said it wrote but never had is written once more,** not taken as you removing it. A block that was on your calendar and is later gone is yours removed, and stays off. Blocks from before this version count as having been on your calendar.
- **A Family add whose Approve tap came back before it went in comes back as its own card.**

## 0.22.0

- **A receipt comes only once your calendar shows the change.** "Added to your Gmail", "From your mail, on your calendar" and "Added to the Family calendar" now go out after a read of the calendar finds it as it was written, not when Google or iCloud only says the write worked. If three reads don't find it, or for an add or a date from your mail half an hour passes without one that does, one card says it was written but not confirmed, with its Undo, and the next morning digest names it.
- **Tap replies say what will happen:** "Thanks. I'll put Swim on your calendar as yours."
- **Receipts read as notices:** "Added to your Gmail: Busy (family), Fri Nov 20, 1:00 PM to 3:00 PM, for Swim on Family. Nothing to do if that's right; tap a button only if it's wrong."
- **No message names a button it doesn't have.** Turning on Family adds brings your event's card back by itself, and a stop or a restart no longer asks you to send something again.
- **Changes that wait past the day's limit are each named,** by block and day, never counted.
- **Stop is red** on every card and on the digest.
- **If Cain is down, the first message just says so.** If he's still down after 30 minutes, one more line says how to restart him: Settings > Apps > Cain > Restart.
- **No codes:** a refused Family add says iCloud turned it down, and its receipt has no job number.

## 0.21.3

- **The Resumed notice no longer asks you to send things again.** It says plainly that what you sent while stopped wasn't acted on.

## 0.21.2

- **The Harness no longer marks the same Family events to be judged again every few seconds.** One already waiting to be judged again is marked once, so its log stays readable and the Pi stops writing its database over and over.
- **If judging Family events stops on an unexpected problem, it tries again at the next calendar read,** not every few seconds with a warning each time.

## 0.21.1

- **You hear right away when only you can fix something.** If Gmail turns down Harness's app password or wants you to sign in on the web, iCloud turns down its app-specific password, Google turns down its service account key, or your Gmail calendar isn't shared with Harness any more, you get one message as soon as a second try confirms it. It says what stopped, since when, what it costs you, and how to fix it from your phone, down to tapping Approve on the Discord message that follows. You get it once per outage. If a new key is turned down too, you hear again.
- **If something else stops, you hear once it has kept failing for six hours.** That's Gmail, iCloud or Google not answering, Claude turning Harness's requests down, or the Pi's clock being off. Messages go out on the quarter hour, with everything that's down then in one, so a home internet outage is one message. A message that hasn't gone out yet only says what's still down, and is dropped if everything in it works again.
- **The morning digest names everything that's down,** your email included, once it has failed twice or for an hour: "Email from Gmail: not working since Sun Nov 8 at 4:53 PM; Gmail refused the app password". When one you knew about works again, the next digest says so in one line. There's no separate "it's back" message.
- **Plain words:** no error codes, and "Claude" where messages used to say "the engine".
- **The Harness log notes a failed email read,** once an hour at most unless the reason changes, and never with what Gmail said.

## 0.21.0

- **Your plain calendar commands just work.** Say "move PT to 11:30" or "no drop-off today" and it's done straight away, with one receipt and an Undo button: "Moved PT to 11:30 to 12:30 today (Gmail and Family)", "Took off today's 8:00 drop-off". No Approve tap.
- **Your words find the event.** "PT" finds "PT - Clinic" and "physical therapy" finds "PT", on Gmail or Family. The Family copy of a Gmail event moves or comes off with it, in the same change, and Undo puts both back. The school drop-off and pickup are found on your Gmail calendar, however you name them.
- **Asked once, by name, only when it's unclear.** When two events fit what you said, or none does, you're asked which, naming them, and nothing changes until you answer. A note from Cain now reaches a question that's waiting for it.
- **Plain words, nothing else.** Cards and receipts read like "11:30 to 12:30 today": no date stamps, no job numbers, no expiry line. Your tap's reply says what will happen, and "Done" comes only once the calendar reads back the change.
- **A long or dictated message is just you.** Only real signs of a paste get a tap now: a quoted line, an email's header lines, a forward, a link, a phone number, or words written to you ("your appointment", "please arrive").
- **A tap for the big ones.** A change still waits for your tap when it would give an event a new length you didn't say, take off three or more events at once, or end a series.
- **Every part, or exactly what failed.** If one part can't be done, the rest still is, and the receipt says which part wasn't and why. It never says "Nothing changed" when something did.
- **Only what you named.** When one word fits two different events ("PT" at 4:00 and "PT - Clinic"), when your words are only part of a name and something nearby fits them better, or when what you named is only on the other calendar, you're asked instead of it being changed. A receipt names the event by its own title.
- **Buttons come off when they lapse.** Each card tells Cain when its buttons stop working, so once Cain 0.7.0 is in, an expired Approve or Undo is taken off instead of sitting there for days.
- **Appointments from your mail are real appointments.** One the email gives a time for is now busy, so work and Family see it, at the street address that email gave, or another email about it (same sender, day and time). Timed appointments already on your calendar are made busy too, and only their own emails are looked up again for the address. The next digest names each one made busy. A rescheduling email moves it, with the new email's address. Deadlines, last days, classes and other notices stay free. One you've changed stays yours.

## 0.20.0

- **If Cain's add-on stops, you hear about it.** This add-on checks Cain's every minute. If Cain hasn't answered for 5 minutes, you get one Discord message saying so, sent straight from here since Cain is the one that's down. It tells you Stop and the buttons won't work until Cain is back. When Cain answers again you get one more message, also straight from here.
- **No noise on restarts or updates.** Anything shorter than 5 minutes says nothing, and a message is never repeated. If Discord can't take it, it's tried again a minute later. A restart of this add-on during an outage doesn't tell you twice.
- **Discord on the Harness page.** A new Discord section shows whether the Discord link (held by Cain's add-on) is connected, when it last heard from Discord, and whether Cain is answering, with when you were told.
- **Cain can now check this add-on too** (Cain 0.5.0): it answers a keyed health check while its main loop is turning.
- **Review fixes to the watch.** The "Cain is back" message now comes straight from here, so it can't sit unshown. Cain's Discord connection being down for 5 minutes counts as Cain down, and the message says so. A restart during an outage no longer breaks the Harness page, a failed check or send can't stop the main loop, the 5 minutes are timed on a clock that boot-time clock jumps can't fool, and a busy loop isn't mistaken for a stuck one.

## 0.19.13

- A dated row from Cain's record (`for`: the event's day) is Dane's answer about that one event: the Family event with exactly those words on that day gets what he said, as if he had answered its card, whatever the judge thinks. Other events with those words still go to the judge, with the row as an example. No question is asked about an event he already answered this way.

## 0.19.12

- **Self-healing judgments.** Each read, any judgment that never had an active answer of his in front of it is made again, if one fits the event now. Once it has seen his answer, it never triggers again. Before this, an answer that arrived "already known", or after the event was judged, never reached the judgment (the Nov 21 turkey harvest).
- **The no-block line says whether the judge saw his answer or never saw it.**

## 0.19.11

- **The Telegram code is gone.** Telegram was replaced by Discord on Nov 7, and the bot is deleted. Removed: the long poll, the Telegram API client, /start pairing and deeplinks, and the Telegram token field on the setup page. Shared message shapes moved to chat.py. The ledger is unchanged, and a leftover token in the vault is ignored and dropped on the next write. Stop, Turn back on, cards and Undo all run through Discord as before.
- **A request's calendar read counts against its 10-minute deadline** (P9). The model's retries get only the time left, so a slow read can't push a request past its deadline mid-retry. A failed request logs its reason, attempts and run time, and a read over 20 seconds is logged.

## 0.19.10

- The no-block line also counts his own answers for the event's words, by state (active, overruled). That tells a judge that ignored his answer apart from an answer that never arrived or was overruled.
- Each table of his answers Cain sends is logged: rows, new and already known.

## 0.19.9

- A Family event in the next 30 days that gets no block now says why in the log, once, and again only when the reason changes. The reasons:
  - he answered no;
  - judged as nothing for him;
  - not backed by one of his answers;
  - the judge wasn't sure.

  Each comes with the judgment's counts. Prompted by the Nov 21 turkey harvest, which had his answer and no block, with nothing saying why.

## 0.19.8

- Drive blocks are rounded up to whole quarter hours (Dane, Nov 9): a 66-minute drive shows as 75, so the drive there starts on the quarter hour and never cuts it fine. Exactly 15, 30 and so on stay as they are. The choice between going home and driving straight on uses the rounded times too.

## 0.19.7

- Family events that only name a place ("Funky's Skate Center") now get their drive blocks and address too. The place is looked up by its name on the map, only near home, and only if the map's name really matches. Your block then shows the place's name and street address, so it opens in Google Maps.
- Cain also keeps a place book for you: each place name once, with its street address. Your word wins over the map, so nicknames, typos and private places ("HMLC", "Grandma's") work too.
- When an event you go to is at a place neither your book nor the map knows, Cain asks you once: "Where is HMLC? (for Skating HMLC, Fri Nov 20)". Reply with the address, or tap Skip. Each place is asked once; a place you skip is never asked again unless you bring it up.
- Only the event's place goes to the map, never its title or notes, and each name goes out once. A place in your book, or one you skipped, isn't looked up at all.
- Events you go to now get their drive and address even when the judgment didn't say where the event is, as long as Family has its street address. Events judged to be at home or school still don't.
- Events at a place you add later get their drives on the next read, with no restart.

## 0.19.6

- Family events you go to yourself now get their drive time on your Gmail, as separate blocks: "Busy (drive there)" ending when the event starts, and "Busy (drive back)" starting when it ends. The event's own block keeps its real start and end, so you can still see when it begins.
- Drives start and end at home, unless two events on the same day are too close to go home between them. Then it's one drive straight from the first to the second, and no drive home after the first.
- The event's block now carries its street address, so tapping it on your phone opens Google Maps. Only the street address goes on it, never a name or note from Family. Calls and links get no address and no drive.
- New setting `home_location`: your home, as map coordinates ("38.5, -78.5") or a street address. Empty leaves drive blocks off.
- If a drive time can't be found, that drive block is left off and your digest names the event's day and time.
- Undo on an event takes its drive blocks off with it, right away. Events already on your Gmail still get their drives, and an event you're driving someone to never gets a second set.

## 0.19.5

- No more "and N more": the digest, the mail-dates note and the Family notes name every item, so nothing is hidden behind a count you can't open on your phone.

## 0.19.4

- Events judged before your answers counted are judged again, once, with your answers in view (the Dec 15 dentist was one). A few cents of Claude calls.

## 0.19.3

- Your answers about Family events are used again. One you gave Cain could be set aside by an old setting that was only loaded after the day you said it, as with the Dec 15 dentist. Your answer now always wins over an old setting, and answers set aside that way are back in use.

## 0.19.2

- An appointment or event from your mail now lands at its time, for an hour, with your usual reminder, instead of as an all-day note. It stays free, so nothing reaches work. Deadlines and last days stay all-day, with no reminder.
- Ones already on your calendar move to their time once, unless you've changed them.
- The calendar-meaning shadow log now says why each difference happened (sure or unsure, how certain, whether one of your answers backed it), so a miss like the Dec 15 dentist one can be traced.

## 0.19.1

- Cheaper Claude calls: the fixed instructions sent with every call are now marked for Anthropic's prompt cache, so a run of calls (judging your Family events, reading dates from mail) pays full price for them once, then a tenth. Nothing you see changes.

## 0.19.0

- New, off by default: `meaning_live`. When on, the blocks on your Gmail come from what each Family event was judged to mean, not from title words. Switch it off and the old title rules are back exactly as they were.
- Blocks it's sure of (backed by your own answers) are "Busy (...)". Kids or driving in the next 48 hours that it isn't sure of get "Maybe busy (...)", shown free, so work never sees it.
- When it can't tell and it changes your next two weeks, Cain shows you one question with buttons ("are you watching the kids?", "does it tie you up?"). At most three open, one per kind of event, never the same one twice. Your tap is remembered for that kind of event; "Depends" means it asks each time.
- Each new block gets a card with Not mine, Wrong time and Just this once. Removing a block by hand on Google still just removes it.
- What you tell Cain a kind of Family event means is kept in your record and sent here, so it counts too.
- Questions and Undo cost no model calls.

## 0.18.1

- Shadow scoring: school runs use the same fixed drive windows as today (the first pass showed 86 timing-only differences), and the difference list shows misses first, one line per event with a count, so a series can't crowd out what matters.

## 0.18.0

- New, off by default: `meaning_shadow`. Claude judges what each Family event (last and next 60 days) means for you as typed obligations (you're there, you drive, you have the kids, farm coverage, she's away, can't do anything), and plain code turns those into the blocks today's code would write. Shadow only: nothing is written to any calendar. The blocks it would give are scored against today's title rules, in one log line with up to 20 differences, and on the add-on page. At most 10 calls a run, 60 a day, and $3 a month on its own spend line. Your rules and the two title settings are its first examples.

## 0.17.1

- Fixed: "this ties me up" (a rule about what a Family event means) crashed the card and left the request hanging for 10 minutes. A crash while finishing a request now ends it at once.
- With Cain in front, a request that fails for a reason that isn't yours (a timeout, a restart, a bug, a model hiccup) runs once more on its own, from the same message; after an update, recent failures get that one retry too. You are never asked to send it again. A change from a retry still waits for your tap.

## 0.17.0

- Cain is the gatekeeper. This add-on no longer has its own Discord connection and never posts to you itself: every card goes to Cain's link, which holds it until Cain shows it, unchanged. Taps on its cards come back from the link. Only Stop's notices and the 7:40 digest fallback go straight out.

## 0.16.0

- Cain posts through the keeper: questions with buttons, and one morning update with the calendar digest folded in (with Stop). If Cain hasn't posted it by 7:40, the digest goes out on its own.
- Your taps on Cain's questions and your reactions to his messages reach Cain. The keeper's connection now also hears reactions in your DM (only reactions: still never your messages).

## 0.15.1

- The log notes each handover from Cain: what happened and how long it took, so the 20-second target can be measured. Never your words.

## 0.15.0

- The calendar keeper moves to Discord. With a Discord bot token set, it talks only in your DM with Cain, under Cain's name, and Telegram goes quiet.
- You ask Cain in plain words. Cain hands the request over without passing your words; the keeper reads your newest message (from the last 2 minutes) itself, makes the change, and posts the receipt with Undo. Questions go back to Cain to answer.
- A card to tap comes up when the words may not be yours: an edited or forwarded message, an attachment, a reply to something that isn't yours, or anything resting on Cain's suggestion.
- A Stop button sits on every set of buttons and on the morning digest; Turn back on replaces it while stopped. Both work even if Cain is down.
- At the move, changes still undoable are posted again with Undo, and open Telegram questions are closed with a note.

## 0.14.1

- Fix: the Discord connection stopped right after connecting, because it reached the main record from its own thread. The keeper now keeps its own small record, and the connection keeps going if anything else goes wrong.

## 0.14.0

- First step to Discord: the keeper connects to Discord with Cain's bot (a "Discord bot token" field on this page) and hears presses on its own buttons only. It posts one test card to your DM; a tap on it proves the link. Every press is checked: you, in your DM, on the card exactly as posted (a card changed after posting is refused), once, before it expires. Telegram is unchanged until the move is done.

## 0.13.4

- A date from mail counts as already on your calendar when a word matches in another form:
  a "Skate Center" trip is the "Skating" outing you already have.

## 0.13.3

- Left out of dates from mail: offers and memberships to claim (even marked "action
  required"), the standard "report damage within N days" in a delivery email, and a lender
  asking for proof of insurance. The last 30 days are read again.

## 0.13.2

- What's already on your calendar is checked on Family as well as Gmail, and a date with a time
  counts as there when anything starts at that time, whatever it's called: a booking for a
  session you have as "Therapy", or a school event copied to Gmail as "Busy (family)".
- Bills, statements and loan or card payments are left out (they're on autopay), unless the
  email says a payment failed, is past due or must be made by hand. Renewals that happen on
  their own are left out; a yearly subscription you could cancel stays. The routine "fill out
  your forms" in a booking is left out.
- The last 30 days are read again under these rules.

## 0.13.1

- A date that moves follows the email: when a new email says an appointment or deadline was
  rescheduled, the entry from mail moves to the new day instead of a second one being added.
- An entry you moved yourself (in your calendar, or by telling the harness) isn't added again
  when the new confirmation arrives. A second, separate appointment with the same place is
  still its own entry.

## 0.13.0

- "Again" reads your calendar instead of asking. When you name something that's on your Gmail
  calendar, the events with those words are given with your message, so "coffee with Sam
  again next week" takes the day, time and place from the last one.
- Your own plans go on your Gmail calendar without a question; the kids and the household go on
  Family.
- A series can repeat every two, three or four weeks, and can go on with no end date when you
  say "going forward".

## 0.12.4

- A day something doesn't happen (no class, a break, closed) isn't carried from mail.
- A date already on your Gmail calendar that day, entered by you or copied from Family, isn't
  added again from mail.

## 0.12.3

- Fixes from checking the first month against the inbox. One thing in several emails (two notes
  about one service appointment, three about one insurance renewal) is one entry. Payments that
  happen on their own, monthly subscription renewals and expiring promo credits are left out.
  School and group updates and loan servicing mail are now read, so registration deadlines and
  loan dates aren't missed.
- When these rules change, what was found but not written is let go and the last 30 days are
  read again under the new rules. Nothing already on the calendar is touched.

## 0.12.2

- Each date found in mail is named in the add-on log, with the subject it came from, and what's
  found but not yet written is listed again at each start. The log stays on the Pi.

## 0.12.1

- Mail is checked every 5 minutes, not every 30, so a date from new mail lands within minutes.
- A backlog reads straight through: when a read stops at its cap with mail left, the next one
  starts at once. The spend per email and the daily caps are unchanged.

## 0.12.0

- Dates from your mail: with a Gmail app password on the add-on page, the harness reads your
  inbox read-only (nothing marked read, moved or deleted) and finds the dates you have to act
  on: return windows, deadlines, renewals, appointments. Each one goes on your Gmail calendar
  as a free all-day entry with no reminder, so it shows in Outlook and never reaches work. One
  message per batch, with one Undo.
- Only mail that looks like an order, bill, renewal, appointment or deadline is read past its
  subject. What the engine pulls out is checked and cleaned here; no link reaches a calendar.
- Until the mail_dates option is on, dates are found and named in the digest, not written.
- Google's email about a failed run of the work holds script becomes a digest line.
- The log says whether each read of your Gmail calendar came straight from Google.

## 0.11.0

- Your Gmail calendar is read straight from Google for the days ahead, not from the secret
  address's copy, which Google can serve an hour late. Copies to Family and blocks on Gmail
  follow what's really there. If Google can't be reached, the old copy is used.
- The digest says what wasn't done in plain words: what you asked, when, and why, in place of
  a job number.
- A rule's receipt says how many events on Family it covers in the next two months.
- A reply to the digest is taken as your own words, with no Approve tap: the digest's text
  never reaches the engine.
- The work-hours shadow mirror is retired. The work holds script does that job.

## 0.10.1

- After a change, a rule or an Undo, Family is read again at once, so Gmail and work follow
  in a minute or two instead of up to half an hour.
- A block that's no longer needed because of something you said, with its event still on
  Family, comes off on that read.
- An event taken off Family gets its second look two minutes later, not at the next usual read.
  Many gone at once still wait for the usual reads: that's the guard against a bad read.
- The digest's question about new Family events says to ignore the ones that don't affect you,
  so the list of rules stays short. One rule can cover a person: "Anything with Pat means I
  have the kids".

## 0.10.0

- Say what a Family event means for you, by its name: "Pat dentist means I have the kids",
  "Lee - Doctor is mine", "School Day is a school day", or that one means nothing. Gmail, and
  work from there, follow it from the next read. One receipt and one Undo, like any change.
- A rule goes by words, so emoji and names in front don't matter. The most words win.
- Your own Family events get "Busy (family)" on Gmail, unless Gmail already has you busy then.
- The digest names Family events coming up in the next two weeks with no rule yet, five at
  most, until you say what they mean.
- The add-on's title settings still work. A rule you say comes first.

## 0.9.1

- Undo checks every calendar before it writes anything, so it no longer undoes one calendar and
  stops on the other.
- Undoing a change after a later change to the same event offers one button that undoes both,
  newest first, instead of calling the later change someone else's.
- A day of a Gmail series isn't put back once its series is gone, and an event already back
  doesn't block the rest of an undo.

## 0.9.0

- Say what should change on the Family or Gmail calendar and it's done, with no tap: take days
  off, end a series, move one day or event, add an event or a series. One receipt and one Undo.
  Off until the new `calendar_changes` option is on.
- It finds the event on a fresh read, keeps every other line of it, guards against someone's edit
  in between, and reads each write back. Nothing that may be pasted goes without a tap.
- A day taken off that comes back, from any app, gets a line in the digest.

## 0.8.2

- A school run now comes off only for what really stops it. An event during the trip to school does. An event after drop-off doesn't, so going on to an appointment keeps the run.
- With the school's address in `family_school_address`, an event within three hours of a run counts if you can't drive between it and the school in time. Drive times come from OpenStreetMap's free services, which get the street address and nothing else from the event.
- An event with no street address is taken as nearby, and the digest says so. If a drive time can't be looked up, the run stays and the digest says so.

## 0.8.1

- School runs are 45 minutes: 15 each way and 15 to spare. Drop-off starts 30 minutes before the start and ends 15 after. Pickup starts 15 minutes before the end and ends 30 after. Blocks already on Gmail move to match.

## 0.8.0

- School runs on your Gmail calendar. Name the Family events that mean a school day in `family_school`, and each gets a drop-off and a pickup block, 15 minutes either side of the start and of the end, with no tap. They follow Family: a closed day has no blocks and a moved start moves them.
- A real event of yours in the way means no block for that run, and it comes back if the event goes. A "Busy" hold, a block from here, or an all-day event other than a stay doesn't count. If your Gmail calendar can't be read, school runs don't change and the digest says so.
- Up to 100 changes a day to Gmail, up from 30, so the first school runs go on in one go.

## 0.7.4

- The reason moved hand copies stayed put: the repeat lines in an event's time zone block, there for its clock changes, counted as the event repeating. Now only the event's own lines count. A real repeat or a guest still means it's left alone.
- Copies given up on, still exactly as they were, get one more try after this update.

## 0.7.3

- 0.7.2 didn't get moved hand copies going: iCloud's copy still failed a safety check. Comparing an event with what was just read now ignores line order and the server's own X- lines.
- When a hand copy is refused, the log gives the reason in property names only, never what they say.
- Copies given up on, still exactly as they were, get one more try after this update.
- The digest names a copy once a day, even if it's given up on twice.

## 0.7.2

- Copies now follow a move on Gmail when iCloud reports an event's version differently in a list than it does when asked directly. They could stop following with no word.
- The digest names any copy it stops following, by word and date, and says why, so a stale copy doesn't go unnoticed. It also says when the daily limit holds changes back, part of Family can't be read, or a read goes wrong.
- A note or place added to a copy on Family now means it's left alone, rather than rebuilt without them.
- A hand copy already off from Gmail when taken over now moves to match, only if it has the copy's exact title and length and no note. Anything else is left alone and named.
- Copies it gave up on by mistake, still exactly as they were, are followed again once after this update.

## 0.7.1

- Several appointments cancelled together now come off Family, after about three hours. They could
  stay there for good, held as a bad read. Your own events stay while your Gmail calendar reads oddly.
- `/status` says when copying has stopped for a kind of event.
- Corrected: blocks on your Gmail calendar do carry your default reminders. Google applies them,
  and a service account can't turn them off. The sharing option's name is corrected too.

## 0.7.0

- The Family events you name in the add-on's settings put a block on your Gmail calendar, with no
  tap. It moves when they move and goes when they go. Your title and the times only, marked private,
  with no guests, reminders or emails.
- It needs a Google service account key, entered like any other, and your Gmail calendar shared with
  that account. A test event goes on Gmail and comes off before the first block.
- It changes only blocks it wrote. One you edit is left alone, and one you remove isn't put back.

## 0.6.1

- A computer lab class on your Gmail calendar now goes on Family as "Name - Computer Lab".

## 0.6.0

- Family stays true to your Gmail calendar, with no tap. Your first name in the add-on's settings
  turns it on; adds must be on, and your Gmail calendar's secret iCal address entered.
  Plain code does it after each read. No model sees any of it, and /stop stops it.
- Appointments go on as "Name - PT", "Name - Doctor", "Name - Dentist" and the like: fixed words
  and times, never text from Gmail. Calls, meetings, "Busy" and someone else's invite stay off.
- A hotel stay becomes one block for the whole trip, with the city, flight times and numbers when
  the flights match a strict pattern, and "Name - away" when they don't.
- A copy follows its event. If it moves, the copy moves. If it's cancelled, the copy comes off
  after two good reads in a row. Many gone at once is held back as a bad read.
- Events you copied by hand are taken over rather than doubled, if they carry your first name.
  They stay as they are until the event changes on Gmail. An event with other people on it, a
  repeating one, or anyone else's stays as it is.
- A copy someone edits on Family is left alone for good. A copy gone from two good reads in a row
  isn't put back, and after two of a kind it stops copying that kind.
- At most 12 changes a day. If Gmail or Family can't be read, or too much looks gone at once,
  nothing changes. With more than one Gmail calendar entered, it does nothing. The morning digest
  says what changed, in counts, and any problem.
- None of this counts toward adds skipping the tap, and adds you ask for work as before.

## 0.5.1

- A standing rule now needs your tap. A correction, or anything pasted that looks like one,
  stays unused until you tap *Keep rule* on a card showing its exact text, and only a kept
  rule reaches a prompt. An unanswered card drops the rule after 7 days.
- Rules saved by earlier versions were never tapped, so they stop being used until you decide.
  Each gets a card, again each week. Adds can't start skipping the tap while any rule waits,
  and if they already skip it, the tap comes back and the thread says why.
- The cards are honest about alerts: a real test showed adds alert family phones with
  notifications on for the Family calendar. The card asking to stop checking says so, and
  says an alert can arrive with nothing approved first. It asks only whether adds were wrong.
- A tap on that card during `/stop` changes nothing, reads nothing, and the card still works
  after `/resume`.
- `/checkadds` with that card open closes it like *keep checking*, and says so.
- While adds skip the tap, a long or several-line message gets a card, and so does any message
  in the 30 minutes after one, or sent as a reply.
- More address shapes are stopped: any URL scheme, `[evil.com/x]`, `.evil.com`, and wide or
  look-alike dots. A word:word or a phone number gets a card.
- A saved rule a card can't show exactly is retired with a notice. Every other saved rule,
  including one waiting on a clash, gets a card. A clash nobody answers is dropped after 7 days.

## 0.5.0

- The app can now write to one calendar. It can add one event to iCloud Family
  from a message, and undo that add. This is the first change to the world the app
  can make at this stage. It is off until you turn it on with a tap. The stage stays
  S1, and calendar holds and the work mirror stay locked.
- Say "add dentist Tuesday 3pm". A card shows the exact event in your local time.
  One tap creates one event, with no invitees, alarm or repeat. The reply carries
  iCloud's answer and an Undo button.
- Undo deletes only that event, once, and refuses if someone changed it.
- If iCloud's answer is lost the app says it doesn't know, tells you to check the
  calendar, and never retries. A failed write, rejected password or wrong calendar
  name stays in `/status` and the digest until a write succeeds. `/stop` blocks adds
  and undos.
- Apple ID, app-specific password and calendar address go on the add-on page. The
  app talks to one more host: the iCloud host in that address.
- Plain code checks every proposal. An event over 24 hours or over a year ahead, or a
  title or location with a link in it, is refused in words. A time written with an
  offset your zone doesn't have at that moment, or a suspected duplicate, puts a warning
  on the card.
- After 10 adds and 14 days, whichever is later, with no undo and no failed or unknown
  write, the app asks you, with the whole record, whether to stop checking each add. The
  card lasts 3 days and asks again at most once a week. Your tap re-reads the record first,
  and nothing changes if it moved. Only your tap changes that. Any warning, more than 5 such
  adds in a day, another add at the same start, or a long or several-line message still gets
  a card.
- `/checkadds` brings the Approve tap back at once. So does an undo, a failed or unknown
  write, an add with no Undo, or a change to the credentials, the policy or the model. The app says why, and
  only a fresh full count can ask again. `/status` and the digest say when adds skip the tap.

## 0.4.0

- Work-hours mirror, shadow only. When mirror settings are entered on the add-on
  page, plain code works out which personal blocks would be copied to the work
  calendar, records that in its own table, and adds one line to the morning
  digest. It writes nothing to any calendar. With no mirror settings, nothing
  changes: no table rows, no digest line.
- The planner behind it (work days, hours, look-ahead, quiet hours, which
  calendars count, titles to skip, Family rules, "Busy" titles) ships with it.
  The calendar write it would feed is registered for S2 only and nothing calls
  it in this release.

## 0.3.0

- The iCloud Family calendar in the morning digest. Home Assistant pushes a
  minimized copy (title, start, end) every 30 minutes to a listener on the add-on's
  internal network; the harness stores it and lists it as Family context. It never
  counts a Family event as an overlap or acts on it.
- The digest is never Clear while the Family calendar is missing: nothing received
  yet, not updated for two hours, not about today, or Home Assistant can't read it,
  each said plainly. A refused push is named; wrong-key pushes are counted in the
  next digest even when good pushes keep arriving.
- The listener takes a key only in a 30-minute window (at first start, or from a
  button on the add-on page), checks the sender's address before starting a
  thread, and handles at most two connections at once.
- Several calendars are listed in time order.
- A calendar named by its address shows the name with spaces, not "first[.]last".

## 0.2.0

- Today's calendar in the morning digest, read-only, from your calendars' secret
  iCal addresses (entered on the add-on page like the keys). Overlaps are marked;
  a calendar that couldn't be read, or an event it couldn't place, is named.
- The add-on page shows each calendar's last read and the last digest, including
  the ones recorded but not sent before the start date.
- Links from instrument cards open the chat with the card's title.

## 0.1.0

- First release for stage S1: a private Telegram thread, answers and drafts,
  typed rules with undo, a daily digest and canary, receipts for every job.
  Zero effects: it cannot change anything outside itself.
