# Harness controller

A small deterministic program that owns one private Telegram thread, keeps the
ledger, and holds the only keys that can change anything. Models are engines: they
read what they are handed and return an answer or a typed proposal. They never hold
a credential.

This repository is also a Home Assistant add-on repository. The add-on lives in
`harness/`, and its Python package in `harness/app/harness`. It uses only the
standard library.

## Invariants

Each invariant has tests. The security checks are also mutation-tested: every
check is broken on purpose, one at a time, and the suite must fail.

| # | Invariant | Where |
|---|---|---|
| 1 | Only the paired account, in its private chat, can start anything. Strangers, groups, bots, forwards, edits and unknown commands are refused, and a refused message's text is never stored. | `telegram.decide` |
| 2 | The Telegram offset advances only in the same transaction that records the updates it confirms. Ids are scoped by the bot's id: a new token starts a new offset instead of confirming the new bot's updates away. After six quiet days the poll asks for the earliest update, because Telegram re-randomizes ids after a week. | `ledger.ingest`, `telegram.poll_once`, `controller` |
| 3 | A tap approves exactly one card, once. It must come from his account and chat, on that exact message, unexpired, with the same parameter hash and policy version. The approval is consumed before any remote call. | `approvals` |
| 4 | Choices (undo a rule, pick a side in a conflict, confirm a settings change) are bound the same way, in their own table and with their own prefix. One tap per card. | `choices` |
| 5 | Effects are default-deny and staged. Before S2 the model can't even express a proposal, because the shape is not in its schema. | `effects`, `prompts`, `schema` |
| 6 | Model output has a closed set of shapes, and anything else fails closed. The provider's structured output is a convenience; the parser is the boundary. | `schema.parse_output` |
| 7 | The controller decides every character he can tap. Model text is escaped. Its links (any host, IP or `tg://`), bare domains and IPs are defanged, and its `/commands` and `@mentions` are made inert. Messages never exceed Telegram's limit or break its markup. | `render` |
| 8 | Every job ends in a receipt, and the reply that reports it is written in the same transaction. A Telegram outage delays a reply but never loses it, and a late reply says when it was written. | `ledger`, `runner`, `outbox` |
| 9 | Time: "still working" at 3 minutes, failed at 10. A late reply is billed, recorded and discarded. A restart fails orphaned work loudly. There is no silent failover between models. | `runner` |
| 10 | Spend is counted from each response's usage, and the monthly budget is checked before every call. Prepaid balances are not an instant cutoff. | `engines`, `runner` |
| 11 | Corrections become typed, scoped rules with an Undo button. Overlapping conflicts are quarantined, never guessed. No rule can touch authority. | `rules` |
| 12 | The digest is plain code. "Clear" requires evidence: fresh inputs, a passing canary through the real model path, and config unchanged since a stated date. Nothing proactive is sent before `proactive_from`; that check lives in the sender, not a prompt. | `digest`, `daily` |
| 13 | If the controller can't reach Telegram for longer than Telegram keeps messages, the thread says continuity is unknown. | `controller` |
| 14 | Pairing binds the account that sends a one-time code. It is write-once, and changing a key after pairing needs his tap in Telegram. | `vault`, `controller` |
| 15 | The settings page answers only Home Assistant's Ingress proxy, for a logged-in user. The first user to save becomes its only editor. It never shows a key back. | `setup_web` |
| 16 | Secrets never reach a log line, an error message or a URL he sees. The Supervisor token is removed from the process environment at start. | `net`, `__main__` |
| 17 | Work content is stopped at the door, before it is stored or sent to a model. This is defense in depth, not a guarantee. | `ingress_filter` |
| 18 | Calendars are read, never written: a GET of a Google secret iCal address, and nothing else is accepted as an address. The address is a secret like a key. | `calendar_feed`, `vault` |
| 19 | An unread calendar is never an empty day. Each calendar is its own input; one that wasn't read today is named, and events whose repeat pattern isn't understood are counted, not dropped. | `calendar_feed`, `ical`, `digest` |
| 20 | A link from an instrument card opens a conversation and nothing else. Its title is decoded strictly, cleaned and escaped; it never starts an action or reaches a model by itself. | `deeplink`, `commands` |
| 21 | The Family calendar arrives only as a push from Home Assistant, on its own internal port, never by asking Home Assistant. A push must come from Home Assistant's address, carry the pinned key, match schema 1 exactly, be recent and newer than the last. It is stored and listed, nothing more: Family events never mark an overlap, and the digest is never Clear while Family is missing. | `family`, `daily` |

## Run the tests

    python3 -m pytest -q

## Status

Stage S1: zero effects; read-only calendars (Google, and iCloud Family pushed in by
Home Assistant) in the morning digest. See
`harness/CHANGELOG.md`.
