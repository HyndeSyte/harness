# Changelog

## 0.19.3

- Cain's background services (the link that carries your taps, the record keeper, the PC job keeper and the others) now start again by themselves after they crash or are stopped, instead of staying down until the App restarts. Each restart is one line in the App's log with its exit code, and one that keeps failing at once waits longer between tries.
- When a drill file can't be written or read, the log now says why (the error, the system call and the file), never what's in the file. What a drill refuses is unchanged.
- A stray folder or link left where a drill file's temp goes is cleared, logged once, instead of failing every install after it.

## 0.19.2

- Cain can accept an update of himself again. Since 0.19.0 every install of Cain was refused with "the drill flags' high-water time can't be kept", because of a mix-up in his App's code. That is fixed.
- His tests now catch that kind of mix-up, so a change with it can't reach a Ship card.

## 0.19.1

- Reviews end by your rule with no card: after the last review round, a change with something serious left is held and Cain tells you in one line. The review service no longer sends you "Ship it with that risk" or "Hold it", and Cain can no longer ask you to grant more review rounds.
- If an old card of either kind is still up, tapping it does nothing but take its buttons off and say it's retired.
- A change held at the last review round can't be shipped through an earlier "Ship it with that risk" tap any more.

## 0.19.0

- A drill flag that was damaged, ran out or named the wrong version no longer turns into a normal install on the next try: every install of Cain is refused until you tap Clear the drill on its message, or arm a new drill.
- A drill tap is now for one App and one version, and an install of another App leaves it alone.
- If Cain can't reach the Keeper when a drill version starts, he keeps the drill mark and asks again for 90 seconds, then stops that start and records it, instead of starting normally. The Keeper rolls it back once it sees it.
- Cain treats a start as the drill only when the Keeper has tied that install to the Home Assistant job that made it.
- Every Ship tap's token now names itself as a Ship approval, and one without that is refused.
- How long Cain's link waits for the Keeper's backup before giving up on a Ship run is a new option, `keeper_accept_min` (default 5 minutes). After a restart the link refuses any Ship run it was in the middle of, and tells the Keeper.
- Keeper cards (the drill, old key, Try again and free space cards) no longer arrive between 10 PM and 7 AM; they come at 7 AM. Drill messages that say an install was refused still come at once.
- A drill tap is now for one Cain version, named on the card: an install of any other version refuses it and tells you to arm it again.
- If the drill flag is damaged, ran out or was already used, nothing is installed and you get one message saying so, instead of a normal install going ahead.
- The drill mark is signed by the link and checked at start, and Cain asks Keeper whether the install really is a drill it is watching before failing on purpose. Otherwise he starts normally and logs why.
- If Keeper doesn't fully accept a drill, or the drill mark can't be written or confirmed, nothing is installed and you get one message.
- Cain now works with the new Keeper App, which checks every install of Cain for 15 minutes and rolls a bad one back by itself from the backup taken just before it.
- Right after Cain starts following an install, the App asks him its liveness line once and tells the Keeper whether he answered. No answer within 10 minutes counts as a failed install.
- If the Keeper rolled Cain back or gave up on a rollback, Cain's bot tells you that in one line, once, after his next start.
- "Ship it with that risk" now reads the Keeper to see whether the rollback is armed, instead of a file nothing wrote. Until both drills have run and you have set the Keeper's two Healthchecks checks, it still reads as not armed, and the card says why.
- Cain's health check for Home Assistant's Watchdog (/health) still only says whether the App is running, so a Discord outage doesn't make the Watchdog restart him. A new readiness check beside it (/ready) answers only while his Discord connection is up, and the Keeper reports it after an install as chat connected or not.
- Two new options: `keeper_url` (already filled in) and `keeper_token` (the same token you give the Keeper for Cain).
- "Ship it with that risk" reads as armed only while the Keeper's heartbeat and alert checks have answered in the last 10 minutes and none of its alerts is stuck, so a Healthchecks outage shows as not armed until it passes.
- One Ship tap starts one Ship run: a second run on the same tap is refused, and Cain's link registers that run's install with the Keeper itself, so nothing writes the Keeper's options any more.
- The Keeper decides on /health (Cain running and alive), not /ready: a Discord outage is reported as "chat not connected", never a reason to roll Cain back.
- A Ship run that installs Cain starts only after the Keeper has made and checked his backup. Meanwhile Cain is told to start the run again in a minute. If the Keeper refuses, doesn't answer, or isn't set up, the Ship run doesn't start and Cain tells you why.
- Cain's link now claims the Keeper's acceptance at the moment the Ship run starts, and logs a line the Ship run must see before it installs. If the run gives up, the Keeper's registration is cancelled.
- Cain's link checks that the Keeper trusts the right Ship key: the key's fingerprint is kept in the repository (`cain/SHIP_KEY_FINGERPRINT`), and you confirm it at the Keeper. Until the fingerprint is filled in by a Build, Ship runs that install Cain are refused, and Cain says why.
- The fingerprint of the link's current Ship key (e8aa4a671281b608, from the link's "Ship key (public)" line in Cain's log) is now filled in, on Dane's word (Nov 25), so normal Ship runs of Cain work once you confirm the key at the Keeper.
- A Ship run that installs Cain starts only while the Keeper's claim has at least 20 minutes left. If less is left, the run doesn't start, the claim is cancelled, and a new Ship card starts again.
- Cain's link now also records your confirm of the Keeper's Ship key from its minute by minute check of the Keeper, and refuses a Keeper whose saved state is older or newer than the one you confirmed.
- If the Keeper's saved state is restored from a backup, Cain's link notices and refuses Ship runs that install Cain until you confirm the Keeper's Ship key again with a fresh code from the Keeper.
- If the Keeper doesn't answer Cain's claim at the start of a Ship run, Cain's link asks once more, and the Keeper answers with the claim it already made, never a second one.
- Cain's link accepts a Keeper restored from a backup once you confirm its Ship key again, ignores a Keeper answer for a confirm it has since replaced, and tells the Keeper when it turns its confirm down. A second Ship run on the same tap is refused, naming when the Keeper's claim runs out.
- When the Keeper still remembers an old Healthchecks key, Cain's bot posts one card naming it. Revoke that key in Healthchecks, then tap the card: only your tap tells the Keeper the key is replaced, and the Keeper won't arm until then.
- The Keeper's confirm code for the Ship key is now printed only when you ask for it there (`key-code`), never by itself at start.
- Your tap on the old Healthchecks key card is now checked to be yours before Cain's link signs anything, and it is tied to the Keeper's current enrollment and a one-time challenge from the Keeper. When the Keeper no longer has the old key to try, the card says the change rests on your tap alone.
- If the Keeper has no room for the backup before installing Cain, the install is refused and the link posts you a card saying so. Nothing installs without the Keeper's rollback: free some space, or choose another way yourself.
- If the Keeper doesn't confirm the start of an install, or a cancel of one, nothing is installed and the link posts you a card with Try again, which brings the Ship card back.
- Keeper answers that arrive out of order no longer look like an older Keeper: the newest one counts and the late one is set aside, with nothing for you to redo.
- Keeper drills: when Cain asks, his link posts you a drill card with Arm the drill. Only your tap arms it, and only for the next install of Cain, which then stops at start or reports a failed check on purpose so the Keeper rolls it back and records the drill. Without your tap every install is a normal one.

## 0.18.1

- A fix-only review round is no longer blocked because the earlier round's findings hold a tool name ending in a date (or a date written as eight digits).
- Everything else is still checked over those findings: an email address, a phone number, an SSN-shaped number, a term from your private list, and any other run of eight or more digits still blocks the round, and a blocked round still doesn't count.
- Your brief is checked as before: an email, phone, account or card number, SSN-shaped number or private term in it still blocks it before anything is sent.
- The earlier findings come only from the review runner's own record of the round before; a brief that tries to carry its own is refused.

## 0.18.0

- When a critical change has used its three outside review rounds and still has something serious, Cain can ask you for more fix rounds on a card: it says what the change does, how many rounds it used and what the last one left, with "Grant 2 more rounds" (1 to 3) and "No".
- Only your tap grants them; Cain's ask alone adds nothing. The rule of three rounds stays, and a grant never lifts the armed rollback that shipping with a risk named needs.
- If a granted round still leaves something serious, the "Hold it" or "Ship it with that risk" card comes to you again for it.
- Cain's review lines now show the raised cap, like "round 4 of 5, 2 granted by Dane on Nov 21".
- Your Grant tap checks everything again before it adds a round: if the change has rounds left by then, a round is running, someone else is working on it, everything is stopped, or its rounds moved on since the card went up, nothing is granted, the card loses its buttons and you see one line saying why.
- One grant card at a time for a change: Cain can't send a second while one is open, and when you grant on one, any other open grant card for that change loses its buttons ("Replaced by a newer grant").
- The file that keeps your grants stays readable by Cain's review lines every time it's written or made again.
- Two taps on a grant card, or the same tap arriving twice, add the rounds once: the second finds the card already answered.
- A grant card holds the pull request's newest commit and the newest decision from when it went up; if either changed by your tap, nothing is granted and you see why.
- A grant card that went out of date, or whose message is gone, no longer blocks a new one: it loses its buttons ("Replaced by a newer card") and the new card goes up.
- If the records can't be read for a moment when you tap Grant, the card stays up and asks you to try again in a minute.
- Cain still knows what the calendar specialist does to restore its history, and how it keeps its clock and tap journal straight across a restart, as the earlier rounds described: nothing about those changed here.

## 0.17.0

- Cain knows the calendar specialist never writes its tap journal without its lock, sends one waiting card per outage even when reads come and go, starts only with its journal on local storage, says "storage" when it can't lock or write its journal, and stops a tap whose count it may have lost until Dane puts it back.

- Cain knows the calendar specialist sends one waiting card per outage (a restart doesn't send a second), a requeued tap always gets a fresh Go ahead, and the specialist won't start with its tap journal on network storage (its /health says "storage" when it can't lock its journal).

- Cain knows a set-aside tap Dane puts back can get a Go ahead again, a tap stopped after six listings stays stopped, and the calendar specialist sends one card when taps wait because it can't read its list of set-aside taps.

- Cain knows a tap the calendar specialist brought back six times never gets a seventh Go ahead, and that its /health says "waiting" while it can't read its list of set-aside taps (taps from before its last start wait until it can).

- Cain knows a tap the calendar specialist can't safely try again gets one card saying it was stopped, a tap whose calendar read failed is read again once the calendar answers, and the specialist's cards show event names as written.

- Cain knows a tap the calendar specialist put off is come back to without a restart, a discarded set-aside tap is left alone for good, and taps finished one by one after a failed listing share one summary card.

- Cain knows one tap the calendar specialist can't save no longer holds up the others, every tap it sets aside gets one card, and a tap brought back six times gets a last card saying nothing more is done for it.

- Cain knows the calendar specialist's list of taps after a stop comes once, a last card ends a Go ahead that keeps failing, and a cleanup step it can't read is set aside with one card.

- The cases both sides check name their end-to-end cards in one list, and include the specialist's card that asks you to check your calendar when it couldn't confirm a change.

- The cases both sides check now cover cards that say a change isn't done or couldn't be verified, a card turned down twice, and the calendar specialist's new tap wording.

- A card from the calendar specialist that the link turns down still says what happened, in a few fixed words both sides check, and the cases they share now come from real differences between how each reads a card.

- The calendar specialist now reads a card the way the link does in full (the same words for buttons, a button named across a line break, every button the link knows), and a card turned down twice still reaches you as a short fixed card with its buttons.
- Why a specialist's card has Go ahead or not: an add that never showed up in Google across a restore gets none (an empty spot can't be told apart from an event added and deleted since); a tap whose decision never reached the specialist's records gets one (nothing it leads to ran).

- The calendar specialist strips from a card the link turns down only the sentence that told you to use a missing button, using the very same rule the link does, so the rest of the card reaches you.

- When you send a few messages in a row, Cain can tell the calendar specialist which one your calendar request is in, so it acts on that one and not on your newest.
- A slip in Cain's tools can no longer pass a calendar request on by accident: run with nothing, the tool only lists what it does.
- Cain names your message with every calendar request, answers the calendar specialist's questions himself on the same message, and never asks you to repeat a change you already made in words.
- The specialist's address can only be moved by a test, and that is logged.
- Cain says a calendar change is done only when the specialist's read of the calendar shows it, and a note correcting one card no longer replaces the others.
- After the calendar specialist's update, every calendar change comes on a card until a check on your real calendars has passed and you tap Turn on. Cain starts the check and hands each step over on its card; the specialist judges it from its own record, never from what Cain says, and a full one comes to you on a card showing what it saw, with Turn on and Keep cards, and a Turn off button there after.
- When the event changed since its card, nothing is sent and Cain shows the fresh card that follows without handing it over again. Try again and Start again from now on a receipt are your taps; Cain leaves them to you.
- After every update of the calendar specialist, Cain runs the check on your real calendars first: until it has read back on Gmail (or Family) a guarded move and an edit of one day of a repeating event, cards for that calendar wait with no Approve and come back once it's done. If the check can't finish on one, you get Open cards without the check, and Cain can open it only on your say. Each check is good for that build, for a day and for one Turn on, its test events are titled "Smoke test:", and Cain shows the message that offers to take any leftovers off.
- Before a Ship card for a calendar specialist update, Cain runs its update on a copy of its records first, and shows the card only if that came out right.
- Turning the no-card changes off ends the check behind them, so turning them on again takes a new one.
- During the check on your real calendars, only the steps Cain opens for it count as the check. Your own requests that come in meanwhile are held like any other and come back on their own card, never treated as test events.
- The check also makes each calendar prove it turns down an out of date write; one that doesn't stays on hold, and you get a message saying so with the choice to open it anyway.
- Before a Ship card for the calendar specialist, Cain needs a fresh, passing dry run of its update on a copy of its records, kept in a file he checks.
- Each step of the check on your real calendars now starts with your tap on a card that shows exactly what it will do; Cain can't make anything part of the check by himself, and your own requests during it stay yours.
- Before a Ship card for the calendar specialist, Cain rehearses the incoming version's own update on a copy of its records. If an update starts without one, Cain runs it then; he moves its records without it only on your say.
- Cain shows the specialist's messages about held requests, Test again when a calendar and the specialist don't agree on versions, and the daily reminder while requests wait.
- After a calendar specialist update, its records move by themselves once its own rehearsal passes; only a failed one waits, with your Run check. Moving them without a rehearsal is only ever your tap on a card Cain can send you.
- When the specialist can't change a calendar safely, Cain shows its message with your requests ready to copy and Open without protection, and leaves that choice to you; receipts there say Unprotected.
- Cain shows the specialist's Possibly overwritten messages and cards that say Unprotected as they are, and tells you why a calendar request waits when the specialist's records haven't moved yet, pointing to its Run check message.
- On your say, Cain can send you a card to restore the specialist's records from a backup by its version; only your Put them back tap does it, and it takes effect the next time the specialist starts.
- After your Put them back tap, Cain shows the specialist's card asking you to restart it now, and the requests that come back to you ready to copy after the restart.
- When the specialist starts degraded after a move that failed, Cain shows its message with Run check and Put them back and leaves the tap to you.
- On your say, Cain can send you the card that takes the specialist's clock as right when it's behind its records and old backups aren't pruned; only your tap does it.
- The receipt button that takes one Gmail block off without remembering anything is now "Not this time", and Cain's message checks know it by that name.
- After a restore, Cain shows each held request the specialist passes back once, one message each.
- After a restore, Cain shows the specialist's list of your taps from before it, each with Go ahead, and leaves those taps to you.
- Those taps now say whether each was carried out, not carried out, or the specialist can't tell, and one already on your calendar comes with no button.
- A specialist's card that names a button it doesn't carry no longer reaches you: the link holds it back and Cain hears why.
- A tap card the specialist can't safely offer again comes with no Go ahead and says so, and Cain leaves it at that.
- The link now holds back a specialist's card only when it tells you to tap or press a button it doesn't carry; a card that merely mentions one goes out, and one held back still reaches you from the specialist without that sentence.
- After a tap cut off by an error, Cain shows the specialist's note on when it will look at your calendar again, and the card that follows.

## 0.16.0

- Outside reviews now stop at three rounds per piece of work, counted by the review service itself, which Cain can't change. A new id or a replacement pull request for the same work doesn't start the count again, and a fourth round is refused with the count and the rule.
- After the first round, each review checks only the fixes against the earlier findings, and marks each finding serious or follow-up by your rule.
- If the third round still finds something serious, you get one card from the review service itself: what the piece is, the problem in one line, and "Hold it" or "Ship it with that risk" (holding recommended). Cain can't send that card himself or ask you for another round.
- After "Hold it" there's no Ship card for it. After "Ship it with that risk" the Ship card goes only while the App's rollback of a bad install is armed; no release arms it yet, so for now that card is refused and says why.
- Every review and every Build or Ship job carries a label: core, commitment, necessary-fix or other. A usage guard holds "other" work while your plan or a review seat runs below a 25% reserve, and nothing gets around it. Cain lists what it held.
- Your plan's weekly use can't be read on the Pi yet (only the tokens used are recorded, not the allowance), so for now every "other" job and review is held; core, commitment and necessary-fix work runs as before.
- Two new options: `review_round_cap` (3) and `usage_reserve_percent` (25).
- Cain's spend readout now shows the caps the review service really uses, and how many rounds each open piece of work has had.
- Fixes from the first outside review: your tap on the decision card is saved before the card counts as answered, and if saving fails the card stays up and you're told to tap again; a damaged decisions file is set aside, never written over, and raises the App's alarm.
- A third round that never finishes (every reviewer failed, or the App stopped mid-way) still counts, and you get the decision card anyway, saying the last review didn't complete.
- The decision card passes the same checks as every other card, waits while someone else holds its item, and says up front when shipping with the risk can't happen yet because the rollback isn't armed.
- Cain can read the usage guard's log but no longer write it, and the App checks the review files' owners at each start, turning the cap and guard off with one alarm if one is wrong.
- Fixes from the second outside review: if you tap the other answer on a decision card after a restart, the card, Cain and the guard's log all keep your first answer and say so; the usage guard's hold log has a size limit and per-minute limits, with one alarm when they're hit; the alarm for a damaged decisions file names it and the one step that turns answers back on; and the review files' alarm says Ship decisions are paused for every pull request, then clears by itself once the file is right, with no restart.

## 0.15.0

- Cain stays on Discord when the Discord plugin's server stops. The App now starts it again within seconds, every time, and logs why it stopped: its exit code, the signal and its last lines. A message Cain sends in those seconds gets "try again in a few seconds" at once instead of vanishing. On Nov 20 it stopped once and nothing started it again, so Cain was off Discord for 19 minutes.
- If his Discord channel stays down anyway, across 3 restarts of his session or for 10 minutes, the App restarts itself, once per incident, and comes back by itself. It asks Home Assistant to restart it, and only if that doesn't work stops so the Watchdog brings it back. You see each one in the next morning message, with when and why, and hear at once if it happens 3 times in a day or twice for the same reason. Your outside heartbeat check hears each one too, so a restart that never comes back reaches you from outside.
- A restart the App made for itself can no longer make a later real crash go quiet, or make your own Stop look like a self-restart, even in the minutes while that restart is under way. A kill in those minutes, such as running out of memory, now alarms as a crash too.
- If Home Assistant is slow to answer the App's restart request, the App now gives it the same 2 minutes before stopping by itself, so the two restarts don't run into each other.
- The App's page and health check no longer depend on Cain's own start getting far enough: they come up on their own.
- The App's health check now answers Home Assistant's whole internal network, so the Watchdog can't restart it in a loop if Home Assistant checks from an unexpected address, and any refused check shows in the App's log with its address.
- A long first sign-in no longer makes the App restart itself afterwards: the waits start again once you have signed in.
- If the App's page can't start, you hear it ("Cain's App page is down"), and Cain keeps running.
- One switch to turn on, once: Watchdog, on the Cain App's page in Home Assistant (Settings, Apps, Cain). With it on, Home Assistant starts the App again after a crash, a kill or its own restart. Until it's on, the App tells you once and keeps restarting Cain's session instead, since restarting itself would leave it down.
- Alarms no longer ask you to restart the App, open settings or switch anything. Each says what went wrong (the plugin's server, his session, his channel, the App itself) and what the App is doing about it. The Watchdog switch is the one exception, and your Claude sign-in stays yours.
- A first session that signs in but never connects to Discord is restarted within minutes; one waiting for your sign-in is left alone.
- The Cain panel's sign-in terminal opens again (it showed an error since 0.14.0).
- Cain can read his DM's chat id after a restart again, so he can tell you what you should hear first.
- An alarm about a restart loop says it began within a day of an update again, including for 0.14.0's own install.

## 0.14.0

- The App now checks every 5 minutes that Cain's parts are running (his Discord plugin, his session, his Discord connection), and once an hour that his session answers a short check that never reaches you. These are liveness checks: they can say he's alive while a message of yours is lost. The hourly one waits while he's at work on something and for 5 minutes after you write to him, but never more than 2 hours. A turn of his that runs 2 hours without a break tells you "Cain's turn has been running for N minutes".
- When his session keeps exiting early (more than 3 times in 30 minutes, each within 5 minutes of starting), you hear "Cain's session keeps exiting early" on your phone and in Discord. When it keeps ending on its own with an error after running a while (more than 4 times in an hour), you hear "Cain's session keeps ending on its own", which names the model's API or the network as possible causes. When it keeps starting again but no clean stop was recorded (a crash, a kill, a power cut, or a stop that took too long to finish), more than 3 in 30 minutes, more than 6 in 60 minutes, or more than 8 in 24 hours, you hear "Cain's session keeps restarting", which says it is a pattern, not a confirmed crash. A loop slower than all three windows stays under them.
- When the whole App keeps restarting (more than 3 times in 30 minutes), you hear "Cain's App keeps restarting". Your own Stop, Restart or update from Home Assistant doesn't count there, and neither does the restart an update makes. A crash or a kill of the App (for example running out of memory), or a stop that never finished (a power cut), always counts.
- When the App keeps being restarted on request, more than 6 in 60 minutes, or more than 12 in 24 hours, you hear "Cain's App keeps being restarted". It says the stops were requested (a Restart or update from Home Assistant, a backup, an automation, or the Supervisor's watchdog restarting an App that looked unhealthy), to check the Supervisor log for who asked and why, and that if the watchdog asked, the App looked unhealthy to it, and that is what to fix, not the watchdog. Nothing rolls back by itself.
- Every start is also counted together, whatever its kind (requested restarts, restarts with no clean stop recorded, early or error exits of his session, plain starts): more than 8 in 60 minutes, or more than 12 in 24 hours, and you hear "Cain's App keeps starting", with the counts by kind, for example "9 starts in an hour: 5 asked, 3 with no clean stop recorded, 1 plain". A loop that mixes kinds, or paces one kind under its own limits, can no longer stay silent.
- Each of these alarms gives the count, the window, the last exit code and what his session log says last. Only within a day of an update does one also say which update it was and that, if a backup was made before the update, restoring it from Backups undoes the update and any changes since. Nothing rolls back by itself. The long-turn alarm says this may be normal for a long job.
- A new option, `probe_heartbeat_url`: a second check at your outside heartbeat service, pinged only while every liveness check passes. Your Stop doesn't pause it or the App's checks, since Cain keeps answering through a Stop.
- If the folder where the App keeps these checks is ever changed by anything but the App, it stops using it, stops pinging your outside heartbeat check so that one alarms too, and tells you "Cain's probe folder isn't the App's alone", naming the folder with its owner and mode, again each day until it is fixed. Restarting the App sets its own folders up again and fixes what it can above them; if this alarm comes back with the same path, that path needs fixing by hand.
- Claude Code itself stays at the version this App ships with; its fixes arrive with App updates.

## 0.13.5

- Cain can start his Build and Ship jobs again. Since his move to his own user, every one was refused: the record keeper's list of who holds what, which his job check reads, was rewritten readable only by the App's administrator, so the check couldn't read it. The keepers now keep each file's owner and permissions when they rewrite it, so the list, and the review spend and health files his check-ins read, stay readable to him.
- Cain's own read of the record works without his stopgap: the App's image trusts the record's folder for git, which otherwise refuses a folder another user owns.
- How it was checked: a test rewrites the holds list and a review file under a strict setting and shows each keeps its permissions and group; the record and review tests pass.

## 0.13.4

- Cain answers again. Since the switch to his own user on Nov 19, his session restarted every two and a half minutes all day, so your messages reached nothing. Half a minute after each start, the App listed his connectors to its log; listing them starts each one, his Discord link too, and that took his Discord channel away from his running session. The App then saw the channel down and restarted him, and the next listing took it again. The App no longer lists his connectors while he runs as his own user. Nothing they did is lost: the switch had already checked them all.
- You now hear when Cain keeps restarting. Two minutes after each start the App counted his session as running and reset its count of restarts, even with his Discord channel down, so the third-restart alarm to your phone never came. A session now counts as running only while his Discord channel is connected, and restarts for a channel that went down are counted on their own, reset only after ten steady minutes: at the third you hear Cain isn't answering, however late in a session the channel drops.
- How it was checked: a test starts the whole App with his channel down and shows the restarts lead to the alarm (it fails on 0.13.3), that a channel dropping after he counts as running still leads to the alarm, and that a connected channel takes the alarm down with no restart. A second test shows no listing runs while he's on his own user.

## 0.13.3

- The move to Cain's own user no longer fails because his connectors (Gmail, his calendars, GitHub, Canva and the rest) wouldn't load under his new rules. Those rules allowed only one address, and Claude Code checks each connector at its own address, so all of them were refused. Every connector now loads, while only the App's own Discord link may run on the Pi, no other plugin or marketplace can be added, and every write tool stays switched off.
- Before an update that changes Cain's rules ships, Cain checks on the Pi that every connector still loads under them, first proving the check can tell, so this can't slip through again. If the move ever finds a connector missing, the App's log now names every one.
- The "Cain is stopped for a moment" alarms no longer ask you to restart the App if he isn't back in half an hour: the App is already restarting itself. Nothing for you to do.

## 0.13.2

- The move to Cain's own user no longer fails its start-up test of his Discord channel every time. The test's call to Claude Code read the test's message as a second channel name, so Claude Code stopped before it began and the move waited six hours to try again. It now starts properly, and the move can finish on its next try.
- If Claude Code ever stops before starting during that test, the App's log now says so in plain words, with Claude Code's own error, instead of only that the Discord plugin didn't load.

## 0.13.1

- Cain now runs as his own user on the Pi instead of as its administrator. The App's keys (GitHub, the review services', the Discord bot's and the Supervisor's) are out of his reach, and the checks on his messages and your Stop live where he can't change them.
- His Discord replies go through the App, which checks each one before it goes. Discord's "Permission" prompts no longer come to you.
- The calendar App (0.24.2, in the same update) signs what it sends Cain's App with a key Cain can't work out, so nothing can pose as it.
- The first start after the calendar App's update moves him over by itself: the App restarts once, checks the new setup on the Pi (the Discord login, and a test message that goes nowhere), and only then switches. If a check fails he keeps running as before and tries again later, and you hear so; nothing for you to do. If the move ever stops part way, or a safety check of his own user fails after an update, the App stops him and tells you how to get him back: restore both Apps' backups from just before the update.
- If that safety check can't finish (rather than failing), Cain pauses instead of running unchecked, and comes back by himself once it finishes; you hear it's a pause, not a breach.
- Whenever Cain is stopped or paused, for any reason, the App tells you itself, with the way back: in Discord, and as a push to your phone only, again each day until it's fixed. The push comes through a one-time Home Assistant automation (the App's documentation, "If Cain stops"), which can only pass the alarm on to your phone: the App still has no access to Home Assistant itself. The App tests that push every day, and Cain reads the test back, so no one checks it by hand; if it fails, you hear it from his bot. His move waits until that push is shown to work.
- If his session stops on its own, the App starts it again right away instead of stopping, and tells you if it keeps happening.
- The PC chores from 0.12.0 keep working once he runs as his own user: he can queue them and read their results, and the part of the App that talks to your PC's job queue no longer needs the Discord bot's key at all.
- Cain no longer gets stuck behind Claude Code's offer to set up auto mode: the offer is off, and the App types his check-ins and your taps into his session only when his prompt is on screen, empty and steady, never into a question waiting there or into something typed and not yet sent, and it presses Enter only once what it typed sits in his input box. Each tap leaves the App's queue only once it shows in his conversation, so none is lost or sent twice; a long one goes as a file he reads. A tap that can't go in waits its turn, never lost, and check-ins that miss their hour are named in the next one, however many. Nothing is typed into his session after a start until it has passed its safety check. Claude Code's gray suggested prompts are off in his session too.
- When a question sits on Cain's screen, where no one answers it, he can't take your messages until it's answered. The App now closes it with Esc after 5 minutes, and if that doesn't work, starts his session fresh 5 minutes later, so he's back within about 10 minutes and reads what you sent meanwhile. Something left typed in his box gets cleared too, after it's saved for him. You hear only if it keeps coming back.
- If nothing the App types gets into his session for half an hour, you hear "Cain isn't getting messages" from his bot and on your phone, once, and again when it's back. If his screen waits at a sign-in for half an hour, you hear how to sign him in.
- How it was checked: the design went through six rounds of outside review, and tests interrupt the move at every step and check that nothing secret is ever readable by Cain's user.

## 0.13.0

- A dead Pi can now warn you from outside the house: make a free Healthchecks.io account, add a check with a 5 minute period and a grace period of 10 to 15 minutes, and paste its ping URL into heartbeat_url in Cain's App options. The App pings it every 5 minutes, and the service emails or pushes to you itself if the pings stop. Until you do, the morning check-in reminds Cain to bring you that one step. Keep that URL like a key: only the heartbeat itself ever sees it.
- The morning check-in now names a jump in review spending (a day far above a busy week before, at least $1, or over a fifth of a month's cap), the cheapest sign of a stolen key or a runaway loop. It also says when a seat is on pace to pass its monthly cap, and when it has reached it. A review is refused at once when every seat it needs is at its cap.
- On Mondays the morning check-in names a key or token that has been the same for over 90 days, and any morning one within 14 days of an expiry Cain noted. A key that never expires by design can be marked as known until a date, so it stays quiet. The App only keeps a fingerprint of each key, never the key.
- Links in messages from Cain's bot no longer unfold into previews: Cain's own replies with a link now go out through the App with the preview off from the start. Cain can't send you a link that isn't plain https, points to a bare IP address, a disguised (punycode) address or a link shortener, has a password in it, or whose words name a different site than where it leads.
- Card updates keep working even if Discord ever refuses the no-preview setting: the card is updated without it. A tap never fails because of a message's own settings, and an unrelated refusal is never sent twice.
- A reply of Cain's with a link never gets stuck: while the App's link is restarting it goes out at once, and its preview is turned off once the link is back. If one was held and never sent, the next check-in reminds Cain.
- Nothing in the security watch acts on its own: it only tells Cain, and he brings you one thing at a time.

## 0.12.2

- PC jobs run again with Chrome 157: Chrome's own built-in extensions, such as Chrome Web Store Payments, no longer count as an extra extension in the Cain jobs profile. Any extension you or anything else installed still stops runs, as before.
- Extensions other programs put in the Cain jobs Chrome (through the Windows registry, waiting on Chrome's prompt) no longer stop PC jobs while they are off. Only an extension Chrome would actually run counts, plus any extension a Chrome policy installs, which always counts and is named with the policy.
- Google Docs Offline must be off in the Cain jobs Chrome: if it is on, the run stops and names it, with the fix. Turn it off once on that Chrome's extensions page. A new worker command, open-chrome, starts the Cain jobs Chrome with Chrome's default apps disabled. That only stops default apps being installed; what protects you is that a run stops whenever one is on.
- The extension check now reads on and off the way Chrome 157 does: an extension Chrome marks enabled always counts as on, one you removed counts as off, and a setting that doesn't say either way stops the run, named, with the Chrome version that wrote it. An old style number in place of Chrome's list of reasons, or a removed extension Chrome doesn't list as removed, also stops the run.
- A Chrome policy entry that isn't an extension id, or a cloud enrollment or device token (in Chrome's policy, its cloud management key or its enrollment keys), now stops runs, named with where it sits, never the token: policy could then come from somewhere the check doesn't read.
- The extension check is stricter where it was still loose: a removed extension counts as off only when Chrome lists a real reason, never because of the removed list alone; a reason that isn't a plain whole number, or a removed list in an odd shape, stops the run, named. It reads Chrome's registry settings in both the 64 and 32 bit views, looks for enrollment tokens in more places (including Google Update's), and stops the run if a cloud policy cache folder is on the PC, each named with where it sits, never the token. Only Chrome's own install folder under Program Files counts for its built-in extensions, matched folder by folder; a per-user Chrome install never does.
- The extension check closes three more gaps. A registry key counts as missing only when Windows says exactly that; access denied or any message the worker doesn't know stops the run, named. Chrome's built-in extensions count as Chrome's only when their folder really exists inside the Chrome the worker itself starts, after following any shortcut or junction; short 8.3 names and network or device paths never count. Device tokens are found whatever their case, including in a key's default value, and the cloud policy cache is checked under both Program Files folders and in the Cain jobs profile itself.
- dump-extensions now starts with where Chrome is installed, whether machine-wide or just for you, and its version folder, and lists the three policy cache folders it checked.
- Cain times the PC's check ins by his own clock, so a PC clock running fast can't make an old check in look like the worker started.
- Cain no longer counts a PC check in from before he started waiting on a job as the worker having started, even one naming the job, and a job queued again under the same name doesn't count for the one he is waiting on.
- Cain no longer counts a PC check in from just before a job was queued, within the two clocks' margin, as the worker having started, unless that check in names the job.
- The extension check now stops a run when it can't be sure: a setting it doesn't recognise, a Chrome policy it can't read, or a policy that installs any other extension (including through the ExtensionSettings policy), each named. Chrome's own extensions count as Chrome's only when they sit in Chrome's own folder; one elsewhere is named with its folder (your user name left out), so it can be allowed later if it turns out to be Chrome's.
- The PC worker never changes your Chrome profile: it only reads it to decide. If something else is on, the run stops and check-host names it, for you to turn off in that Chrome.
- A new worker command, dump-extensions, lists each extension entry in the Cain jobs profile with numbers and folder kinds (and the folder of a Chrome external component, your user name left out), and Chrome's version, never names, so the setup can be recorded. check-host shows Chrome's version too.
- After installing, run the probe and confirm again at your PC once: the worker changed, so nothing runs until you do.
- The worker's two checks inside each run (before every browser action and after every page read) now refuse to work if a preload setting or the tests' variable is set where they run, like the worker itself.
- Cain now tells you the PC's worker isn't starting for short jobs too: a job that waits out its whole time, or expires without being picked up, while the PC hasn't been heard from in 3 hours. If the PC checked in shortly before the job, Cain waits for it to be picked up, and tells you within 12 hours if it never is, even across a restart of Cain.
- During an outage of the PC job queue you only hear that the queue can't be reached, not also that the PC isn't starting. That line clears only after the queue answers a few times in a row, and if it comes back within a day it says so. Within 12 hours, a PC that seems not to start is still mentioned, marked as not confirmed, and that line keeps being sent until it gets through.
- The Ship gate's follow-ups: its records, quarantine and supersede steps are stricter, a stuck read of GitHub refuses the Ship card by name, and nothing it sets aside is ever deleted.

## 0.12.1

- Cain can read your Microsoft 365 now that it's connected: your OneDrive files and your Outlook mail and calendar.
- He can't send, change or delete anything there. Mail, drafts, calendar events and invitations, mail rules, and adding, moving, renaming or deleting files are switched off for him, the same as sending through Gmail, Slack and Google Calendar.

## 0.12.0

- Cain can now hand chores that need your browser to your PC: a small job queue that a worker on your PC runs in a locked browser session, in a Chrome profile of its own, and Cain reads the short result.
- It does nothing until you set it up once at your PC (the steps are in the pull request and in Cain's docs). Until then nothing changes.
- This version only reads pages, and that is enforced: the PC refuses anything but a fixed set of read-only actions, at the exact addresses your own signed allowlist names. Anything irreversible is refused until the tap card for it comes.
- Results are a few checked facts and a reason code, never page text. Jobs that need you say so plainly: signed out, a captcha, a mail to confirm. One whose outcome is unclear is marked in doubt and never retried without asking you.
- A STOP file on the PC halts it at once, and Cain can see when the PC last checked in and why it isn't taking jobs.
- Before anything runs, you do a supervised probe at your PC. It first checks the browser session can reach Claude in Chrome in the right profile and was given only the reading tools, then orders it to try every denied action (a shell, files, the web, clicking, typing, forms, scripts, console and network reads, uploads, shortcuts, and opening other addresses) and checks each one was refused. Runs stay attended, started by you: this version has no unattended runs at all.
- The browser session can open only the job's own address and a check page the PC serves for each run; anything else, and any browser tool the PC doesn't know, is refused before the browser sees it. If that check can't decide, it refuses. Addresses are compared exactly, so a different path or a query counts as a different page.
- After each run the PC checks where the browser really ended and which tabs it had: a page that wandered off, a redirect your allowlist doesn't name, or an extra tab fails the run. Your allowlist can name a site's own redirects.
- The PC refuses to run if its Chrome profile, Chrome's version, the session's settings, your own Claude settings or the session's environment changed since you confirmed them, if the extension shows up in another Chrome profile, or if another Claude Code is open on the PC. A new Claude in Chrome or Claude Code version stops every run, even ones you start, until you probe again. A hung run is stopped after a set time, leaving Chrome open.
- The PC now checks every address the browser showed during a run, not only where it ended: a page that slips off to somewhere else and comes back before the end fails the run.
- The check page each run opens only works in your dedicated Chrome profile: you bind that profile once at setup, and a run answered from any other profile fails. A Chrome running with Claude in Chrome from another profile stops runs too.
- A run fails if Claude Code changes while it runs, or if the Claude in Chrome version the browser reports isn't the one installed in the profile.
- What leaves the PC is a few typed facts, each checked against a strict list for its kind of job (yes or no, a word from a list, a date, a count, a masked account name, a short plan name). No free text anywhere: a report with anything else fails the run and none of it is kept. The probe plants a "put this in the notes field" trick on a page to check that holds.
- Two locks on the browser tools: Claude Code itself refuses anything but the four reading tools without asking, and opening a page needs the PC's guard to allow it. A tool use the guard has no record of fails the run. The probe checks Claude Code still refuses with the guard deliberately stalled, and every run first checks the guard answers as it should.
- Claude in Chrome found in Edge, Brave or Chromium, or in a browser started without its own folder, stops runs too, and the PC checks the extension's helper really belongs to your dedicated Chrome, step by step.
- The check page's cookie lasts years and is locked down; the probe has you restart that Chrome once to prove it survives, and a cleared cookie says so plainly.
- If Claude Code doesn't report which Claude in Chrome version answered, the PC checks the version in the extension's own files instead. When a new version stops the PC, Cain tells you in one line what to run at the PC.
- The run's tab stays open on a blank page (about:blank; the browser tools it has can't close tabs); the next run reuses it. Cain's docs have a troubleshooting table for every reason a run stops, and for each thing only your PC can show.
- Nothing runs at all, not even a run you start, until the probe has shown Claude Code refusing on its own a page the PC's guard didn't allow. That proof is tied to the exact Claude Code it was seen on: any change to it means probing again.
- Fewer ways for a page to sneak words out: a plan is one word from a fixed list (anything else counts as "other"), a masked account shows at most four letters or digits, and an address in a report must be one your allowlist approved. The probe also tries to pass a token off as a plan name and checks it is refused.
- A failed run leaves only its reason code behind: no address and no values in the result, the heartbeat or the PC's last-run file. Only your own trouble log, off unless you turn it on, keeps the addresses, on the PC.
- The check page never shows the profile's secret any more: the PC checks the cookie itself and the page only says "bound".
- At setup the PC checks the extension's helper is registered where your install file says (a new `check-host` command, and bind-profile), and accepts Chrome starting the helper directly.
- Every run first checks the four reading tools by name and that the reading tools still report page addresses the way the probe saw. When Claude Code doesn't report the extension's version, a run you watch uses the version in the extension's own files instead.
- Signing your allowlist refuses addresses with a query or words like logout, unsubscribe, delete or cancel, unless you mark the entry as reviewed.
- Plain words on what it promises: supervised browsing, every tool call checked, every address the browser shows checked each time. It can't stop a browser from following a redirect or opening a popup on its own; it fails the run afterwards. You accept that once when you confirm the probe (`confirm-profile --accept-boundary`), and the probe shows you a redirect and a popup doing it.
- The profile check now rests on what the PC's own check page saw, not on what the browser session says it read.
- Confirming the probe also needs its planted-trick checks to pass, and it lists which checks ran on your PC and which remain unproven there.
- Stricter setup checks: the extension's helper must be registered the same way in every place Chrome looks (including the 32-bit one), and its helper must come from your dedicated Chrome itself.
- A new Chrome version also asks for a new probe, and a Claude in Chrome update Chrome hasn't switched to yet says "restart the Cain jobs Chrome" plainly. `check-cli` shows which Claude Code the PC was confirmed on against the one installed now.
- The PC worker has its own Claude Code sign-in, in a folder of its own that you sign in once at setup. Your own Claude Code sign-in is never read or copied, so a run can't log your own Claude Code out. Runs, the probe and binding stop plainly until the worker is signed in, and the probe checks its sign-in still works after two sessions in a row.
- Claude Code's records of each session (page text and all) are deleted from the worker's folder after every session: when it ends, fails, times out or is stopped with the STOP file, which now also ends a session that is running. If deleting fails, the run fails with its own reason instead of carrying on. If the worker is killed in the middle of a session, its next start (and `check-cli`) finds what was left and deletes it.
- Signing your allowlist no longer prints a refused address: only the entry's number, the word that matched and the site's host, and nothing of it is saved anywhere.
- The PC reads Claude in Chrome's entry from either of Chrome's two preferences files, says which in `check-host`, and stops with its own reason when neither has it. Any other extension turned on in the Cain jobs profile stops runs too; `check-host` and confirming the probe list the extensions found.
- A Claude in Chrome helper left behind by a Chrome that closed gets its own reason, and the fix is restarting the Cain jobs Chrome.
- Unattended runs are off in code in this version: an install file asking for them is refused. The Task Scheduler step is gone from setup until a later version that can block requests before they leave.
- The browser session can open only web addresses (http and https), never a file, a script address or another browser page, and never your PC or home network (the check page the PC serves for each run is the one exception). Each job opens only its own sites: your allowlist can name them, and an address on any other site is refused before it opens, query and all.
- Nothing in a browser session runs until the PC has checked that session's tools: the guard refuses every call before that.
- On Windows each session runs in a Job Object, so everything it starts ends with it. The PC builds the small helper for this itself; if it can't, runs stop and say so plainly.
- A PC without Windows short file names is fine now: that is logged, not refused.
- The tab check the browser session must keep now fails a run only after three misses in a row for the same check, and the PC's message names the exact tool to call. The probe runs a longer chore across several tabs and records how often it slips.
- Results reach Cain as quoted, labelled lines, and Cain can't queue a new job built from an account or address a page showed.
- The worker's own sign-in sits in its folder on the PC, so that folder is now walled off twice: the four browser tools the session has (tab list, page text, find, page structure) can't read files at all, and both the worker folder and its Claude Code folder are also denied by path to Claude Code and to the PC's guard. Any attempt fails the run with its own reason. The probe plants a page asking to read and send the sign-in file, by path and by name, and confirming needs every attempt refused.
- After every session the worker's Claude Code folder is emptied of everything but its sign-in, its settings file and its empty memory file, whatever Claude Code named it. The probe checks nothing else is left there after its two test sessions.
- When Chrome's two preference files disagree about an extension, the PC stops with its own reason instead of guessing; the secure file wins otherwise.
- Stricter extension rule: only Chrome's own built-in extensions are exempt, extensions installed by policy or from outside count, and only one you turned off yourself counts as off. `check-host` and the probe show each extension's raw fields.
- Fewer false alarms from Windows' coarse clock when the PC checks Claude in Chrome's helper belongs to your Chrome; the probe logs those times across its Chrome restart.
- Setup now has the Cain jobs profile block pop-ups and redirects, and the PC warns (without stopping) if they're allowed.
- New options: `pc_jobs_token` and `pc_jobs_repo`, both for the PC job queue.
- A run you start without `--attended` now does nothing at all: it reads and writes nothing, not even the heartbeat or the queue.
- The PC's last-run file names a failing field only when it is one of the job's own fields; anything else shows as unknown_field. An address the browser session was refused is logged by its site and a fingerprint only, never in full.
- The guard around the worker's own folder also refuses inputs it can't read whole, addresses encoded more than once, and Windows short folder names.
- A page read before the run's check page, or on another tab, fails the run (canary_first, other_tab), and a read whose answer doesn't show its address needs the tab list checked right after it. A new tab must have an address and be seen straight away.
- Every built-in Claude Code tool is now denied by name, file search included, and the probe tries Glob, Grep and Read too. Any tool the session is given beyond the allowed ones stops the run, and the log lists what was expected and what was found.
- If you close the worker mid-run, it ends the browser session first and then cleans up, so nothing the session writes is left behind.
- The PC's guard now refuses every tool that isn't one of the six it knows, by name, on its own, and the probe checks that with tools on no list. A session given any tool it shouldn't have is stopped the moment it starts, before it does anything.
- On Windows, the worker ends the browser session and everything it started, waits until all of it is gone, then cleans up, retrying longer while Windows still holds a file. The probe records how your PC ends processes and passes signals.
- The guard reads every way a Windows path can be written (Git Bash, WSL, file: addresses and more) as one, uses your PC's real short folder names instead of guessing them, and no longer refuses long page text or searches for their size.
- Give the worker folder a name of its own at setup (pc-worker- and six random letters and digits): the guard refuses that name wherever it appears.
- After opening a tab, and after each read on a PC whose reads don't show their address, the guard makes the browser session check its tabs before doing anything else; three misses fail the run, and the probe counts how often an honest job trips it.
- Only a tab the run opened itself, or the one it was handed, counts as the run's; a pop-up never does.
- A refused address is logged only as its site and secret-keyed fingerprints, on the PC, and that log never leaves it.
- Facts in a result are short and plain: no shell characters or symbols can reach Cain in one, and Cain treats them as data only.
- A confirmed probe now holds only for the worker version it was made with: after this update, and every later one, you run the probe and confirm again before jobs run.
- Every allowlist entry now names the exact sites its runs may open (a whole family of subdomains only where you write it that way). An entry without them is refused, so sign your allowlist again with them. The PC takes those sites from your signed entry, never from the job.
- Site names are read the way a browser reads them and checked against a pinned list of public suffixes, so a disguised address (a number standing in for this computer, a look-alike letter, a trailing dot, another site on the same shared host) is refused.
- If a page moves the browser off the job's sites after it opened, the PC refuses to read it there and the run fails, before any of that page reaches the browser session.
- Address parameters stay off unless an entry names the ones it may send.
- The PC's first tool call no longer fails if it comes a moment before the PC has checked the session's tools: it waits up to five seconds, then asks to try again. Only skipped tab checks count toward the three-in-a-row limit.
- Plain words on reported values: Cain refusing a job that repeats one is a safety net, not a guarantee; your signed sites are the real limit. A follow-up job can reuse a reported value only after you say yes to Cain's question. You accept this new wording once when you confirm the probe.
- On Windows the PC finds its compiler only in the Windows folder, rebuilds its helper whenever it changed, checks the helper really sits in its locked job, and says plainly when the compiler is missing or security software blocks it. The probe also ends the helper on purpose and checks nothing it started is left.
- A page read off the job's sites, or one whose answer doesn't say in a structured field which address it was on, now ends the whole browser session at once and the run's report is thrown away. The PC no longer falls back on the tab check for a read it can't place, and never takes the address from page text.
- The PC tells you which site a page moved the tab to when that happens (for example "read_drift:example.org"), on your PC only.
- The check that a session's tools were looked at now uses a token the PC makes for each session, not Claude Code's own session id. A session that asks four times before that check is done is ended, and so is one refused twelve times in all.
- A follow-up job can reuse a value a result reported only after you tap "Use it" on Cain's question quoting it, for exactly the values that question quoted. A reply you type never counts, even one that repeats the value. One tap covers one job, and stays used even after Cain restarts.
- Allowed address parameters now each need a value pattern and a maximum length (like page=[0-9]{1,4}); a name alone is refused when you sign, so sign your allowlist again if it has any. An address with a "#" part is refused, unless your probe shows the PC can drop that part before the browser gets it. Allowed parameters on a site you are signed in to can still leave something behind there.
- Signing writes site names in plain ASCII, the way a browser reads them.
- The probe has new steps, and confirming needs each one: a page that redirects off the job's sites is read and the session must end before its next step, every reading tool must say which address it read in its one exact field, a page that fakes an address in its text, title or layout must never count as placed, the PC must end a stopped session within its time limit, Claude in Chrome must attach in time, and on Windows the helper must build and its Job Object must hold inside any outer job. Whether the redirected page's text was also kept from the session is recorded and picks which of two boundary texts you sign. Whether the session ids agree is only noted now. It also lists the sites a sign-in went through, for your allowlist. You accept new boundary words once more, since what is promised when a page is read off-site changed.
- A Ship card now waits until the PC worker's Windows tests have passed for that exact change, every attempt of them: one that failed blocks it even after a green re-run, so a flaky run needs a new change.
- If a session the PC ended doesn't stop in time, the PC stops taking jobs until you probe again, and says why.
- The PC's page checks now always answer within one fixed time limit, safely under Claude Code's own, even when Claude in Chrome is slow to attach on the first step: they never leave the decision to Claude Code timing out.
- A page answer that repeats its address field, however it is spelled, now always counts as unplaced and ends the session.
- A tap you gave to reuse a value is written down on the Pi before its job is sent, so even if Cain's App stops at the wrong moment the same tap can't be used for a second job.
- The Ship card's Windows check now reads every run and every re-run of the PC worker's tests, across every page GitHub lists, and waits when it can't read them all. Cain can show you what that check would decide for a change without acting on it, and you can watch it once on a fresh change as a last step of your setup.
- Your probe's check that the PC drops an address's "#" part now goes only by what the page itself saw it was opened at.
- A tap you gave to reuse a value is freed only when the Pi can prove its job never reached the PC's queue; if it can't tell (GitHub not answering, the job already taken by your PC), the tap stays used. Sending a job is tried three times before giving up, and the tap record now survives a power cut.
- Claude Code now gives the PC's page checks 40 seconds, up from 30, and the probe measures how long they take to start on your PC, cold and warm, and refuses to confirm if that leaves too little room. Run the probe first thing after restarting the PC.
- The page check now refuses page answers it can't read exactly (a hidden mark at the start, broken characters, numbers too long to keep), and the probe replays what your Claude Code really sends through it. This update needs a new probe and confirmation.
- The Ship card's Windows check now waits when GitHub limits how often it can be read, and the setup step that watches it now starts before the change is sent.
- A tap you gave to reuse a value is now freed only when the Pi has a record that GitHub refused every try at sending its job. If that record is missing, or one try's answer was unclear, the tap stays used for good, even if the job later vanished from the queue. A tap written by the earlier test version counts as used, and you get one message about it.
- When the job queue can't be read properly (a partial copy, its branch gone, an empty queue, an unreadable tap record, a tap it can't settle) or a job from your tap is refused three times, you get one Discord message saying what happened and how to fix it. Other jobs keep going where they safely can.
- The page check now names why it couldn't place a page (for example two address fields, or broken characters), and a run's report lists each such page with its reason.
- The page check's test-only modes (holding, stalling, timing, keeping inputs) now work only inside the probe step that asked for them. In a real run any sign of them makes the check refuse at once.
- The probe's timing check now starts with its held check as the very first, cold session, takes three warm samples and shows their spread. Real runs record how long the page checks took to start, and confirming again is refused if that left less than 4 seconds to spare.
- The probe's check of what Claude Code sends now also covers what the page-reading tools return.
- The Ship card's Windows check now tells a GitHub rate limit apart from a permission problem, and waits as long as GitHub asks. Watching a pull request locks on to the first change pushed after the watch started, and a Ship card for a different change of it is refused.
- Your probe's "#" check page now has a one-time code of its own, and says plainly when the page never reported.
- Your confirmation is now tied to the exact page-check code and pinned settings, not just a version number. This update needs a new probe and confirmation.
- Watching the Ship gate now takes the exact change about to be sent and waits for it; if a different change shows up, or it moves away, the watch says so and accepts nothing. A Ship card refused because an earlier change was accepted names it and the one command that replaces it after a rebase. Each wait for GitHub is at most 15 minutes, and a watch at most 2 hours.
- A send of a job from your tap counts as refused only when GitHub's own answer says so; anything less clear keeps the tap used. A job refused three times is settled at the keeper's next round that reaches GitHub, not at the next restart.
- The once-only messages about the job queue are now only marked sent once Discord has them, and you hear again if the problem clears and comes back. A tap written by the earlier test version whose job is on record now counts as done.
- A run first checks no probe leftovers are lying around and says how to clear them. A run whose page checks start too late now stops at once, and the probe's first timing sample must be taken within five minutes of starting the PC.
- The page check's address rule now looks only at what the reading tool answered, with wide letters folded, and the probe records which address fields your reading tools send. Runs now check Claude in Chrome's and Chrome's versions against the ones your probe saw. This update needs a new probe and confirmation.
- A run now also stops when a page check never starts at all, timed by the PC itself, not only when one starts late.
- The probe's cold timing sample says to use Restart, not Shut down (Windows Fast Startup keeps the PC from counting as freshly started), or to turn Fast Startup off, and shows how long the PC had been up.
- A run no longer touches anything while a probe is running, and a leftover probe setting is named with where it is set and the exact command that removes it.
- Claude in Chrome's version is read from what Chrome actually loaded, and Chrome's from the running program itself. More than one Claude in Chrome version in the profile, an update waiting, or a version that changes during a run stops runs until a new probe.
- The Ship gate keeps one accepted change per pull request, and replacing it works only once a new change has been pushed.
- A tap that can't be settled for three rounds, because a file can't be read or GitHub can't be reached, now gets one message naming the job. The queue's messages are no longer repeated when a problem flickers, or when Discord's answer was lost.
- When the probe finds your reading tools send extra address fields, it lists them and says the page check needs a change, rather than calling it a forged answer.
- Every page check of a run now has its own deadline, however long the run, and only the tool calls the page check covers are timed. A run started without its page-check log is refused at once by name instead of stopping after 36 seconds.
- A held run after a Claude in Chrome update now clears only after a probe taken after the hold, of the versions loaded now; editing the confirmation file doesn't clear it. If the PC can't write that hold, it refuses every run by name until it can.
- Chrome's version is read once per check, its source is recorded, and a different source after a run is named rather than failing the run. An update found after a run is called an update waiting.
- Two Ship gate watches of one pull request finishing together now keep only one accepted change.
- The queue's messages about a job now name it by what it does and on which site, never by its queue id. A message whose delivery wasn't confirmed keeps being retried with the same id until it is. The message about a tap written by the earlier test version that can't be settled now comes on the third round instead of at once. Rounds that can't reach GitHub and can't read the tap record now lead to one message after three.
- When a leftover probe setting's location can't be read, the run says so and gives all three commands that remove it. The probe ends its output with the same hint confirm-profile would give, listing extra address fields by tool.
- A Chrome version that changed during a run now always fails it and holds later runs until a new probe, even when Chrome's version was read a different way; only a different way of reading the same version is a note. Probing after an update now works while runs are held.
- A held run now clears only on the probe's own evidence, checked against what you confirmed; an edited time or evidence file never clears it. If the PC can't keep the hold on disk, it breaks its confirmation instead, so nothing runs until a new probe.
- If reading Chrome's version takes too long, the PC stops with its own reason instead of guessing. A run that stops because a page check started late or never says which call it was.
- Two Ship gate watches can't both take over a lock left by a stopped watch, a slow watch is never taken over, and a lock that can't be read stops the watch with a notice.
- Messages from the queue keeper that an earlier version never delivered are sent after the update, or as one line saying an earlier message could not be delivered. A message Cain's App refuses for good is no longer retried and shows in the keeper's status. A job whose site can't be told is named by when it was queued.
- A Ship gate watch that loses its lock while writing now takes its acceptance back, so only one acceptance of a change is ever kept. A lock left by an earlier version is taken over by itself after a minute, and a lock that can't be read names the command that removes it.
- The PC tells a slow Chrome version check by its own clock, and a failed or unreadable check stops the run by name instead of guessing from another file. The probe now checks your PC's real Chrome listing before you can confirm it.
- If the PC can't keep its note that a version changed, it sets its confirmation aside so nothing runs until a new probe, or stops with its own reason when even that fails. A probe clears that note only when it saw the same or newer versions.
- The PC matches its Chrome profile folder exactly, whatever the quotes, slashes or letter case.
- Queue messages Cain's App turns away as not allowed now stop and show at the top of the keeper's status; messages that hit a passing server error are retried less often, with a count. A job handed over in a shape the keeper can't read is still named, by the time.
- A Ship gate watch that stopped and was taken over can no longer leave a second acceptance standing, even for a moment: each takeover starts a new round, and only acceptances kept in the current round count for a Ship card.
- A change whose acceptance was replaced is never accepted again, and an acceptance only counts for the change's newest commit, checked both when it is kept and when a Ship card reads it.
- The probe's Chrome listing check now always reads a real listing before it can pass.
- When Cain's App turns the keeper's messages away as not allowed, the keeper's status counts every message waiting, they all wait for the fix, and its notice file is only rewritten when something in it changes.
- A held run cleared by a probe when the hold couldn't read Chrome's version is now noted as cleared without a version to compare against.
- The PC reads the Chrome profile folder the same exact way everywhere, so a second profile with a similar folder name can't confuse it.
- Probing after an update works while runs are held: the probe is checked against the versions it read itself, and a hold stops a probe only while its cause is still there. A probe clears a hold only when it saw the same or newer versions.
- A job the keeper can't name by its site is now said to be seen by the keeper at a time, which is what that time is.
- The Ship gate's round counter can no longer go back to the start: if its file goes missing or can't be read, no acceptance counts until it is rewritten with a fresh number above every round recorded, and a new command does that (`keeper.sh ship-gate --recover-generation <number>`). Acceptances kept by earlier test builds of this version no longer count, so the Ship gate watch is run once more after this update.
- A Ship card is refused by name when the Ship gate's own records can't be read, instead of going out as if nothing had been accepted.
- The keeper's warning that Cain's App turned its messages away now stays until the App really answers, even after a restart while the App can't be reached.
- A message the keeper couldn't deliver is tried once per round however many times it comes up, so its slower retries keep their pace.
- The Ship gate's check of the change's newest commit can use a GitHub token when one is handed to it, waits briefly when GitHub asks it to, and says plainly when GitHub's rate limit, not a new commit, is what stopped it. A watch checks first that the tool it reads GitHub with is installed.
- The PC's Chrome listing check only ever accepts a stand-in listing in its own tests; anywhere else it refuses the step.
- A held run is no longer cleared without a version to compare against unless the PC could write down that it did; if it can't, the hold stays and the run says the worker folder can't be written.
- Acceptances kept by earlier test builds of this version now really never count: each kept acceptance carries a format mark, and one without it is ignored, so run the Ship gate watch once more after this update.
- A Ship gate watch gives up cleanly if GitHub is slow or asks it to wait while it holds its lock, so it never holds the lock long enough to be mistaken for a stopped watch, and it says so.
- Rewriting the Ship gate's round counter now takes the gate's lock itself, so it can't cross a watch starting at the same moment.
- One damaged Ship gate record no longer blocks every pull request, only its own, and the refusal names it with a command that sets it aside (`keeper.sh ship-gate --quarantine <sha>`).
- Every GitHub read the Ship gate makes is handled the same way, and a replacement GitHub's rate limit stopped is kept as owed and says so.
- The PC worker won't start if the tests' own setting is found on the PC, and only the tests can turn on their stand-in listing.
- When the PC can't write down a cleared hold, you get one message saying so with the fix, and the run names the right file.
- If Cain's App stops answering the keeper's messages for a while, Cain's own status says how many are waiting and for how long.
- Setting a damaged Ship gate record aside now waits for the gate's lock, so it can never move a fresh acceptance a watch was just writing, and it is only written down once the record has really moved.
- A Ship gate lock file that is damaged can be set aside the same way (`keeper.sh ship-gate --quarantine-lock <number>`), instead of blocking its pull request with no way out.
- The Ship gate watch refuses to start on a Pi whose curl is too old for its time limits, and stops a GitHub read that runs over its time itself.
- A Ship card is refused by name while the replacement of an earlier acceptance is still owed, with how long GitHub asked to wait.
- Without a GitHub token, the Ship gate no longer retries refused page reads, and each refusal says how many reads are left this hour.
- When the PC worker refuses to start because a setting meant only for its tests is found on the PC, you get one message saying so with the fix. It now also refuses to start when something could load test code into it.
- A message for you about the PC waiting while the queue can't be fetched is still recorded and tried every round, and Cain's status warns once nothing has answered for a while.
- A message for you that waited longer than Cain's App remembers what it posted comes once more marked as said again, never as if new.
- A message for you from before the keeper kept its age also comes once more marked as said again, never as if new.
- If jobs wait for hours and your PC's worker hasn't been heard from, you get one message saying so, with the usual cause and where the fix is.
- If the PC job queue on GitHub can't be reached for about half an hour, you get one message saying so, even while other messages still get through.
- The PC worker also refuses to start when Bun's own settings file in your home folder, or a settings-file option, could load test code into it.
- The Ship gate keeps a record it set aside when it can't put it back, and says how to restore it, instead of losing it; a Ship card waits while a record is away.
- A replacement the Ship gate still owed is cleared by itself when the pull request turns out not to have moved, so the card can go.
- Every Ship gate command now refuses by name when the Pi's curl is too old, and says when a failure is on the Pi rather than GitHub.

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
