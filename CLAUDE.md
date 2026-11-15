# Working in this repo

Read RELEASING.md first: it says how a change is built and shipped.

## Build and ship sessions never contact the owner

A build or ship session (a cloud session Cain started, or any session working here)
never contacts the owner directly: no PushNotification tool, no messages to Discord,
mail, phone or anywhere else. It reports only in its final message. Cain reads that
report and decides what the owner sees. `.claude/settings.json` denies the
PushNotification tool for the same reason.
