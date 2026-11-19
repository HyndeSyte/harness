# Surface

The owner's own app. Piece one is **In motion**: every open thread with its outcome, who has
it, the step it is on, what it waits for, and when it last moved. Nothing on it is written by
an agent at display time: agents write typed data in the record, the exporter copies it into a
signed snapshot, and only code draws it.

Three parts, none of them a Home Assistant App:

- `export/`: reads a checkout of the record and writes a surface-safe, signed snapshot.
- `app/`: an Expo universal app (web first, native later from the same code).
- `worker/`: a Cloudflare Worker that stores (in a Durable Object) and serves the latest snapshot.

## The exporter

It reads `state/PENDING.md` (the open table), `state/holds.json` and `state/notes/<ID>.md` from
a record checkout, and writes
`{version, app, purpose, made_at, threads, excluded_rows, skipped_rows, sig, key_id}`.

```sh
# once: a key pair (keep the private key on the machine that exports, never commit it)
bun run surface/export --keygen <dir>          # writes surface.key, surface.pub, surface.pub.b64

# read what would be exported, signed and written nowhere (no key needed); the private word list
# goes only to the --report file (mode 0600), never to the screen
bun run surface/export --record <record checkout> --private-terms <terms file> \
  --config <exporter config> --dry-run [--report <private file>]

# each export
bun run surface/export --record <record checkout> --private-terms <terms file> \
  --config <exporter config> --out snapshot.json --key <dir>/surface.key [--strict]

# export, sign and upload (--out is optional with --put; --put implies --strict)
SURFACE_PUT_HOST=<app hostname> \
SURFACE_ACCESS_CLIENT_ID=... SURFACE_ACCESS_CLIENT_SECRET=... SURFACE_PUBLISHER_TOKEN=... \
bun run surface/export --record <record checkout> --private-terms <terms file> \
  --config <exporter config> --key <dir>/surface.key --put https://<app hostname>/snapshot

# check a snapshot
bun run surface/export --verify snapshot.json --pub <dir>/surface.pub

# check the exporter's key is among the keys the Worker and the app hold (exit 0 if listed)
bun run surface/export --key-match --key <dir>/surface.key --pub <comma-separated raw base64 keys, or a file>
```

`--put <url>` sends the signed snapshot as a PUT with three headers: `CF-Access-Client-Id` and
`CF-Access-Client-Secret` (the Access service token, checked by Access) and `X-Surface-Publisher`
(checked by the Worker). Their values come only from the environment variables
`SURFACE_ACCESS_CLIENT_ID`, `SURFACE_ACCESS_CLIENT_SECRET` and `SURFACE_PUBLISHER_TOKEN`, never
from flags or files. A missing one stops it with exit 2 before anything is read or sent. So does a
URL that isn't https, carries credentials (`user:pass@`), whose host isn't exactly
`SURFACE_PUT_HOST`, whose path isn't exactly `/snapshot`, or that has a query string or a fragment
(an empty `?` or `#` included). It never follows a redirect: any 3xx (Access sending the request to sign in, or
anywhere else) is refused with "Access redirected: the service token or its Service Auth policy is
wrong", and nothing goes to the redirect's target. It prints the response status and at most 200
characters of the Worker's own JSON message (no other body, never a header). `--put` implies
`--strict`. With `--put` and `--out` the file is written only once the upload is stored, whole (a
temporary file, then a rename), so a failed run, in any mode, writes no file and leaves an existing
one as it was.

**The uploader's three outcomes.** Every upload ends in one of these, named on its last line:

- **Preflight rejection, exit 2: nothing sent.** The URL or environment checks above, a signed body
  over the Worker's 512 KiB limit, or a body that doesn't verify under the exporter's own key.
  (A `--strict` failure stops earlier still, exit 1, also with nothing sent.)
- **Server rejection, exit 1: nothing stored.** A definite answer refusing it: any 4xx (403 from
  Access or the Worker, 409 for an older snapshot, 413, 400) or an Access redirect. It is not retried.
- **Unknown remote outcome, exit 3.** No answer, a 5xx, an answer cut off, or a 2xx naming another
  snapshot: the request may have been stored with its response lost. The uploader reconciles by the
  snapshot's signed identity (the first 32 hex digits of the SHA-256 of its signed bytes): it sends
  the same signed bytes again, up to 3 tries in all (1 and 2 seconds apart), and the Worker answers
  every PUT with the identity it holds; the same identity already held is a 200 (`already`), so a
  lost response settles as **stored, exit 0**, printing `(snapshot <id>)`. If no try gets an answer,
  it says the snapshot may or may not be stored and exits 3; running the same export again later
  reconciles the same way (a newer snapshot simply replaces it).

A 2xx counts as stored only when it names this snapshot's identity.

`--dry-run` runs every check a real run does (the exit-2 checks: no real owner name, no `names`
list, config JSON that doesn't parse, a missing or empty terms file, a term that doesn't compile)
and the whole pipeline before it prints anything; then it prints the snapshot it would sign on
stdout (gated text only), and on stderr counts only: threads, rows left out and skipped, the
threads per area (`surface 2, garden 1, other 5`: the config's `areas` list is the primary control
on what an area may be), and how many capitalised words were replaced and how many lower-case or
uncased words aren't in the word list. **The words themselves never go to stderr or stdout.** With
`--report <file>` they go to that file alone, written with mode 0600 from the moment it exists (a
new temporary file created exclusively, then renamed over the path), under a first line saying it
is private and never to be relayed: the threads per area, each capitalised word the gate replaced
and each unknown word, with its path, row and field. `--report` goes only with `--dry-run` (else
exit 2). With `--put` or `--out` a dry run is refused (exit 2). With `--strict` a leftover fails it
like a real run, and no snapshot is printed.

What it keeps, per open row: `id`, `title` (the Item's first sentence, at most 140 code points),
`app` and `purpose` (fixed: `harness-surface` and `in-motion-snapshot`, see The signature),
`area` (the project folder the Item names, as in `projects/surface`, when it passes the privacy
checks below and is on the config's `areas` list, else `other`), `who` (one fixed word: `you`,
`the assistant`, `a build job`, `a laptop session`, `at his PC`, or `someone` for any other person;
never the Who cell itself),
`step` (the Next step's first sentence, at most 200 code points), `waits_for` (or null),
`outcome` (Done when), `last_moved` (the newest of Since, the item's notes and its hold, as an
ISO time) and `state` (`running` while a job holds it, `waiting on you` when Who is the owner or
Waits for names the owner, `at his PC`, else `moving`). Cuts count whole characters: grapheme
clusters where `Intl.Segmenter` exists (Bun has it), so a joiner sequence like a family emoji, a
flag or a letter with its accent is never split; code points elsewhere, so a surrogate pair never
is.

### Privacy: it fails closed

- **The private terms file is required** (`--private-terms <file>`). One term a line; a line
  starting `re:` is a regular expression; a line starting `#` is a note. Every term matches any
  case, as a whole word. It has the same shape as the owner's review privacy list. A missing
  file, or one with no terms, stops the exporter before it writes anything. Every term is
  compiled when the file is loaded: a `re:` line that isn't a valid regular expression, or one
  that could backtrack without bound (a quantified group holding a quantifier or an alternation,
  like `(a+)+` or `(a|aa)*`, or a backreference), or a plain term longer than 2,000 characters,
  exits 2 naming the line number only, never the term, with no stack trace.
- **Long cells fail closed.** A term runs over at most 4,000 characters at a time. A row with any
  cell (or the row's whole line) longer than that, in its normal form or folded, is left out whole
  and counted, with a warning naming its path and row (so `--strict`, and `--put`, fail on it):
  it is never matched in chunks a pattern could straddle. The chunked matcher stays as a second
  line, its chunks overlapping by more than the longest plain term (at least 400 characters), and
  a test puts a term across a chunk boundary.
- **One normal form.** Before any check, text is put in NFKC form with invisible formatting
  characters taken out (zero-width spaces and joiners, bidi controls, soft hyphens), and matched
  case-folded with accents off: "Jünîper", "ｂａｎｋ" and "ba<zero-width space>nk" are caught by
  "Juniper" and "bank". The strippers and the name replacement run on that same text, and it is
  what is exported.
- **Any row whose cells match a term is left out whole**, every column checked, the id too.
- **Stems.** A row is also left out whole when any cell has a word starting with one of the
  generic money and health stems in the code: money, financ, debt, bank, budget, pay, paid, owed,
  invoice, tax, rent, loan, mortgage, credit, card, salar, insur, refund, irs, health, therap, pt,
  doctor, gp, appointment, hospital, surgery, mental, psychiatr, dentist, dental, orthodont,
  periodont, endodont, denture, tooth, teeth, prescri, clinic, pharmac, medic, diagnos, bill,
  fee, cost, price, quote, deposit, venmo, cash, owe, symptom, scan, mri, blood, vaccin, pregnan,
  allerg, pill, dose, sick, counsel, meds, rx, refill, biopsy, chemo, cancer, rehab, physio, lab,
  results, er, urgent care, injur, zelle, wire, cheque, check, tuition, fine, ticket ("banking",
  "therapist", "payment", "cardboard" and "taxi" count too, and so do "feel", "costume", "pillow",
  "label", "errand" and "checklist": a stem is a word start, so it leaves out more than it must; a
  stem of two words matches any spaces between them). Config adds more; it can't remove these.
- **Long numbers.** A row is left out whole when any cell has a run of four or more digits that
  isn't part of a date (`YYYY-MM-DD`, `M/D/YYYY`, or a year alone, 1900 to 2099): a card's last
  four, an account or a reference number, most phone numbers. A record code (one to three
  letters then digits, like P1040) isn't such a run.
- **Money in any form.** A row is left out whole when any cell has a currency symbol, an ISO
  currency code next to a number ("USD 40", "40EUR"), or a number with a currency word ("50
  dollars", "five quid", "2k euros").
- **The private marker is final.** A row carrying the tag `#private` in any cell, or a
  `Private` column whose cell is `yes`, `y`, `true`, `x` or `private`, never exports, whatever
  else it says.
- **Identifiers are stripped.** Every exported string has email addresses, phone numbers,
  street addresses, URLs and record codes (like P41) replaced by plain words ("an email
  address", "a link", "another item"); an area that is itself an identifier becomes `other`.
  Only the `id` field keeps a code.
- **Names never leave.** Who and state are worked out first, from the names as written. Then in
  every exported text (`title`, `step`, `waits_for`, `outcome`) each part of a configured name
  (first, last) is replaced on its own, whole word, any case, any accent: the owner's become
  "you" ("<name>'s" becomes "your"), everyone in `names` "someone" ("someone's"). A word joined
  to a name part by a hyphen or an apostrophe goes with it, so a double name is one "someone",
  never "someone-X", and a full name written out is one "someone". A name inside a longer word
  is left alone.
- **The proper-noun gate.** After that, in every exported text, every capitalised word, at the
  start of a sentence or not, becomes "someone" unless it is on the allow list: the bundled
  common English words (`export/common-words.txt`: function words, pronouns, common imperative
  and ordinary verbs, a few hundred), "I", "OK", and the config's
  `allow_words` (the product, place and ordinary words the owner lists; a record's sentence-start
  nouns like "Fence" or "Ladder" go here). A hyphenated word stays only when the whole of it or
  each part is listed.
- **Names that double as common words.** No word that is also a common given name or surname is
  on the bundled list (`export/name-words.txt` lists them: May, June, April, August, Will, Mark,
  Grace, Rose, Hope, Pat, Sue, Jack, Rich, Bob, Cook, Post and the like; a test keeps the two lists
  apart, and the code drops any that slips in). So "Will brings the drill" and "ask May" are
  gated like any name, at a sentence start or not. Months and weekdays are on no list: one stays
  only next to a number or a date ("May 5", "on 3 June", "the 3rd of May", "Friday 2026-11-20",
  "Friday, 20 November"); alone ("on Friday", "ask May") it is gated. The owner can still list
  any of these words in `allow_words`, which then lets it stand everywhere.
- **Unknown words.** Every lower-case or uncased word in an exported text that isn't in the word
  list (the allow words, the months and weekdays, and the words the exporter puts in itself:
  you, your, someone, a link, an email address and so on) is counted, and listed in the dry run's
  `--report` file. Under `--strict` (and so `--put`) an unknown word in `waits_for` fails the run,
  named by field and row only: waits_for is the field most likely to carry a lower-case name. Sentences never end after Mr, Mrs, Ms, Dr or St, so "waiting on Mr. Vale"
  keeps "Mr." and gates the name. The gate runs on the case-preserved normal form (NFKC, so a
  full-width or styled capital is a capital); only the stems, terms and names are matched on the
  case-folded copy. So a name written in lower case, or in a script with no case, is caught only
  by the names list and the terms file. Under `--strict` (and so under `--put`) a gated word
  fails the run: exit 1, nothing written, each one named on stderr by field and row number
  only, never the word. A plain run prints only how many it replaced. `--dry-run` lists the
  words on stderr only, under a first line saying the list is private and not for posting.
- **The area** is checked too: the private marker, the stems, the terms and money, then the
  config's `areas` list. Anything else is `other`.
- **One pipeline, gated strings only.** Every free text goes through one function, `sanitise` in
  `export/lib.ts` (the normal form, the strippers, the names, the first-sentence cut, the
  proper-noun gate, the cap), which returns a `GatedText`; the id, the times, who, state, area, app
  and purpose each have their own gate (a checked shape or a fixed list). `signSnapshot` walks the
  whole signed object and refuses any string that isn't a `GatedText`, naming its path only, so a
  field added later can't skip the pipeline; a test walks the fixture's signed object the same way.
- **Counts.** `excluded_rows` (left out on purpose) and `skipped_rows` (no valid id or Since
  time) are signed with the snapshot; the app shows one line "N items not shown". Each skipped
  or oversized row is a warning on stderr with its path and row number (never its text);
  `--strict` makes any of them an error, and nothing is written.

### Config

`--config <file>`, a JSON file, and the environment add to the generic defaults:

```json
{
  "owner_names": ["<the owner's first name>", "<his surname>"],
  "names": ["<other people's names>"],
  "exclude_stems": ["<more stems>"],
  "areas": ["<project folders that may be shown>"],
  "allow_words": ["<product and place words that may stay capitalised>"]
}
```

or `SURFACE_OWNER_NAMES`, `SURFACE_NAMES` and `SURFACE_EXCLUDE_STEMS`, comma-separated. The code
knows the owner only by the role word ("owner", "the owner"); the owner's own name and other
people's names live in this config on the machine that exports, never in the repository.

The config fails closed: exit 2, before anything is read, written or sent, when it doesn't parse
(one line, no stack trace), when no real owner name is configured (the role words alone don't
count), or when `names` is missing. `"names": []` is allowed and means no one else is named in
the record; with no `areas` every area is `other`. Each part of a listed name is replaced wherever it stands as a
word, so a name part that is also a common word ("Rose", "Van") is replaced in its common use too. Tests use made-up values only
(`export/fixtures/exporter.json`, `export/fixtures/private-terms.txt`).

### The signature

Ed25519 over the canonical JSON (sorted keys, no whitespace, UTF-8 by the standard
`TextEncoder`) of `{version, app, purpose, made_at, threads, excluded_rows, skipped_rows}`, in base64
as `sig`. `app` (`harness-surface`) and `purpose` (`in-motion-snapshot`) are fixed identifiers inside
the signed bytes, so a later command envelope can carry its own purpose under its own key and
neither signature can be replayed as the other. `version` is 2, and it goes up with every change to
the signed fields or a thread's fields: a test pins each version to its schema's fingerprint, so a
schema change fails until the version is bumped. The app and the Worker refuse any version, app or
purpose they don't know before they read the signature (the app says "This snapshot is in a format
this app doesn't know"). `key_id` is the first 16 hex digits of the SHA-256 of the raw 32-byte public key. The app
and the Worker take public keys as those raw 32 bytes in base64 (`surface.pub.b64`), a
comma-separated list of them, and verify under the one whose key id the snapshot names (the
rotation path, below); `--verify` takes one key, raw or PEM. The canonical form is one module, `shared/canonical.ts`,
imported by the exporter, the Worker and the app (the app's `metro.config.js` watches
`shared/`).

## The app, locally

```sh
bun run surface/dev.ts          # a dev key in surface/.dev, the fixture record exported to
                                # app/public/snapshot.json, its path and the public key in
                                # app/.env.local
cd surface/app
bun install
bun run web                     # opens In motion in the browser
```

`bun run surface/dev.ts --record <record checkout> --private-terms <file> --config <file>` shows a
real record instead of the fixtures.

Its settings, all from `EXPO_PUBLIC_` variables (see `app/src/config.ts`):

- `EXPO_PUBLIC_SURFACE_SNAPSHOT_URL`: where the snapshot is read. Default `/snapshot`, the
  Worker's route on the app's own hostname. Dev sets `/snapshot.json`.
- `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`: the exporter's public key, or a comma-separated list during a
  rotation. Without it nothing verifies, and the app shows one line saying so and nothing else.
- `EXPO_PUBLIC_SURFACE_TALK_URL`: the Discord DM link behind "Talk to Cain". A placeholder until set.

What it shows when the read fails, each as one line: an opaque redirect, a 3xx, a 401 or a
redirect flag (an expired Access session) is "Sign in again", whose control reloads the whole page
so Access can sign the owner in; a fetch that throws with no HTTP answer (offline, DNS, a timeout)
is "Offline." with a Retry control that fetches again; a 403 from the Worker itself (its JSON
message) is "This account is not allowed to read the snapshot.", with no reload; any other failure
is "No snapshot could be read". A snapshot dated ahead of the device's
clock says so, never a negative age. A who or state the app doesn't know is a plain "other"
label, never dropped.

## Tests

```sh
bun test surface/export surface/worker surface/app/scripts
bun surface/worker/check-wrangler.ts
cd surface/app && bun run test && bun run typecheck
```

The exporter's tests include **the strict-mode regression corpus** (`export/corpus.test.ts`):
every row of the fixture record, exported alone under `--strict`'s rules, must come out as
`export/fixtures/strict-corpus.json` says (`pass`, `excluded`, or `fail:` with the reason:
`capitalised`, `waits_for`, `skipped`, `oversize`), and a fixture row without a line there fails
it. Rows P103 to P108 put May, June and Will at a sentence start and mid-sentence, and fail.

`.github/workflows/surface.yml` runs them on every push and pull request, checks offline that the
lockfile's expo, react, react-dom and react-native are one SDK 58 set (`app/scripts/check-sdk.mjs`,
against expo's own `bundledNativeModules.json`), builds the web app, and fails if any `.html`
file under `dist` has an inline script, or if `dist/_headers` is missing or its
Content-Security-Policy, parsed directive by directive, lacks `script-src 'self'` alone (no
`'unsafe-inline'`, no `'unsafe-eval'`), `connect-src 'self'` or `frame-ancestors 'none'`
(`app/scripts/check-dist.mjs`), then keeps that checked `dist` as the run's artifact
(`surface-web-dist`). It also fails if the Worker's `wrangler.toml` doesn't set both
`workers_dev = false` and `preview_urls = false`, lacks the Durable Object binding and its
migration, or configures a KV namespace (`worker/check-wrangler.ts`). Its `surface-pages-deploy`
job deploys that artifact to Pages (below); it is configured but never runs until switched on.
`app/__tests__/fixtures/snapshot.json` is the fixture record as the exporter signed it, and
`vector.json` a cross-runtime vector (an emoji at the cut, non-BMP text), so the app's tests check
the exporter's signatures; `bun run surface/app/__tests__/fixtures/make.ts` remakes them after the
exporter changes.

## Deploy

Not deployed yet: there is no Cloudflare account.

**The owner's one step:** create a free Cloudflare account, and tell Cain it exists.

The Worker runs as a route on the app's own Pages hostname, so the app reads `/snapshot` from its
own origin: `connect-src 'self'` holds and there is no CORS. Cloudflare attaches Worker routes only
to a hostname in a zone on the account, so the Pages project is given a custom hostname in such a
zone and that hostname carries the route; `project.pages.dev` keeps serving the pages alone. The
Worker has no `workers.dev` host and no preview URLs (`wrangler.toml`, checked in CI).

**The store is a Durable Object** (`SnapshotStore` in `worker/src/index.ts`, bound as `STORE`,
SQLite-backed, which the free plan allows). The Worker checks Access, the publisher header and the
signature, then hands the snapshot and its identity to the one store object, which reads what it
holds and writes the candidate in one step under its own lock (`blockConcurrencyWhile`), so two
uploads can't both pass the "no older snapshot" check: an older one is 409 naming the identity
held, the same identity again is a 200 with nothing rewritten, and anything else is written. A
test runs a newer and an older PUT together with every storage step yielding, in both orders, and
the newer is always what's held. There is no KV namespace any more.

**Pages serves what CI built.** The Pages project is a Direct Upload project (no Git connection,
no build on Cloudflare's side). The `surface-pages-deploy` job in `surface.yml` downloads the
`dist` the `surface-app` job built and checked, runs the dist checks again on those bytes, and
deploys them with `wrangler pages deploy` (pinned). It runs only on a push to `main` with the
repository variable `SURFACE_PAGES_DEPLOY` set to `true` and the secrets `CLOUDFLARE_API_TOKEN`
(a token allowed only to edit Cloudflare Pages on that account) and `CLOUDFLARE_ACCOUNT_ID`; until
then it is skipped. The app's two public settings come from the repository variables
`SURFACE_PUBLIC_KEYS` and `SURFACE_TALK_URL` at build time.

### The checklist, in order

1. **The Pages project and the Worker first, so the hostnames exist.** Nothing real is uploaded,
   and nothing can be read: the Worker answers 503 to every request until its Access settings are
   filled in, and the app's own pages hold no data.
   - The Worker's Durable Object needs no setup beyond `wrangler.toml` (its binding and the `v1`
     migration are there); `wrangler deploy` creates it.
   - Make a Direct Upload Pages project named `surface` (no Git connection, so Cloudflare never
     builds it). Make a Cloudflare API token allowed only "Cloudflare Pages: Edit" on the account,
     and in GitHub set the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the
     variables `SURFACE_TALK_URL` (the owner's DM link), `SURFACE_PUBLIC_KEYS` (step 3) and
     `SURFACE_PAGES_DEPLOY=true`. The next push to `main` deploys CI's checked build; re-run the
     `surface` workflow on `main` to deploy without a new commit. The snapshot URL defaults to
     `/snapshot`; `app/public/_headers` sets a strict content policy.
   - Give the Pages project its custom hostname, and deploy the Worker on the route
     `<that hostname>/snapshot` (with `workers_dev = false` and `preview_urls = false`).
2. **One Access application.** In Zero Trust, create one self-hosted, multi-domain Access
   application (so one audience tag) covering the custom hostname whole (the Worker's `/snapshot`
   route included), the Pages production host `project.pages.dev` and its preview wildcard
   `*.project.pages.dev`. Turn on its eager redirect cookie (the app's redirect is then always to
   that one application). Its identity policy: Allow, the owner's email address only, sign-in by
   one-time PIN, session 30 days. Note the team domain and the application's audience tag (AUD),
   and fill in the Worker's settings below.
3. **The keys, the service token, and a synthetic snapshot.** Make the export key pair on the Pi
   (`--keygen`), keep the private key there only, and put `surface.pub.b64` in
   `worker/wrangler.toml` (`SNAPSHOT_PUBLIC_KEYS`) and in the repository variable
   `SURFACE_PUBLIC_KEYS` (the app's `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`). Check all three hold the same
   key: `bun run surface/export --key-match --key <dir>/surface.key --pub <the Worker's value>`,
   and again with the app's value; each must say the exporter's key is listed. In Zero Trust, create a service token for the exporter and add
   a Service Auth policy allowing only it on that same Access application, beside the owner's
   Allow policy. The token's Client ID and secret and the publisher value live on the Pi with the
   private key and nowhere else, in `SURFACE_ACCESS_CLIENT_ID`, `SURFACE_ACCESS_CLIENT_SECRET` and
   `SURFACE_PUBLISHER_TOKEN`, with `SURFACE_PUT_HOST` set to the custom hostname. Then upload the
   synthetic record (made-up rows only), so the Worker holds a synthetic snapshot, never a real
   one, until every check in step 4 passes:
   `bun run surface/export --record surface/export/fixtures/synthetic --private-terms surface/export/fixtures/private-terms.txt --config surface/export/fixtures/exporter.json --key <dir>/surface.key --put https://<custom hostname>/snapshot`.
4. **Smoke test.** Anonymous requests to every hostname, each at `/` and `/snapshot`: the custom
   hostname, `project.pages.dev`, a preview deployment's `<hash>.project.pages.dev`, and the
   Worker's `surface-snapshot.<account>.workers.dev`. Each Access-covered one must get a redirect
   to Access (302 to `<team>.cloudflareaccess.com`) or a 403, never a 200:
   `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<hostname>/snapshot`. The
   `workers.dev` host must not answer at all (no such host, or Cloudflare's own error, never the
   Worker). Then a real browser with a fresh profile: open the custom hostname, sign in by PIN,
   and the synthetic snapshot draws (two rows). Stop if any check fails; nothing real is uploaded
   until all pass.
5. **Dry run on the real record, read by the owner.** On the Pi, with the owner's private terms
   file and config:
   `bun run surface/export --record <record> --private-terms <file> --config <file> --dry-run --report <private file>`.
   The owner reads the snapshot it prints, the threads per area, and the private report file (the
   capitalised words replaced and the unknown words) before the first upload, and adds terms,
   names, areas and allowed words until nothing on it should stay home; then deletes the report
   file. **Dry-run output, the report file above all, is never relayed anywhere**: no chat, no
   Discord, no record item, no pull request, no job report, no agent; it is read on the Pi only.
   Nothing real is uploaded until he says so.
6. **The first real `--put`.** On the Pi, with the four variables set:
   `bun run surface/export --record <record> --private-terms <file> --config <file> --key <dir>/surface.key --put https://<custom hostname>/snapshot`.
   It prints `200 stored <time>`; then the owner opens the app.
7. Wire the record keeper to run the exporter with `--put` after each change to the open list (a
   later change to Cain's App, not this one).

**What protects what.** GET `/snapshot` is protected by Access (only the owner's identity gets
through) and by the Worker's own check of Access's assertion (the owner's email, below). The public
key gates PUT only: it proves an upload was signed by the exporter's private key, and does nothing
for who can read.

### Deploy follow-ups

To settle before or during the deploy, beside the checklist above:

- **One public key, checked, and the rotation path.** `--key-match` (step 3) checks the exporter's
  key is among the Worker's `SNAPSHOT_PUBLIC_KEYS` and the app's `SURFACE_PUBLIC_KEYS`. Both hold a
  comma-separated list and verify under the key a snapshot's `key_id` names. To rotate: make the
  new pair (`--keygen` into a new folder), add its `surface.pub.b64` beside the old key in both
  lists (Worker variable, then the repository variable and a Pages deploy), check with
  `--key-match` against the new key, switch the exporter to the new private key and upload, then
  remove the old key from both lists and delete the old private key. Tests cover each step,
  including the old key refused once removed.
- **The public key gates PUT only.** Without a usable `SNAPSHOT_PUBLIC_KEYS` the Worker refuses PUT
  (500); GET is gated by Access and the owner's email alone.
- **An equal `made_at` is accepted.** A PUT whose `made_at` equals the stored one replaces it;
  only an older one is 409.
- **workers.dev and previews, on the account.** The `workers_dev` and `preview_urls` checks in CI
  read only `wrangler.toml`; the smoke test (step 4) checks the live account, where the dashboard
  can turn either on whatever the file says.
- **Piece two's writes.** Every write route added in piece two needs a custom header plus an exact
  `Origin` check, beside Access.

### The Worker's settings

All from Worker variables and secrets; none is in the code.

- `SNAPSHOT_PUBLIC_KEYS` (variable): the exporter's public keys, raw 32 bytes each in base64,
  comma-separated (one, except during a rotation).
- `STORE_NAME` (variable, default `latest`): the store object's name; a new name starts an empty
  store (Recovering, below).
- `ACCESS_TEAM_DOMAIN` (variable): `https://<team>.cloudflareaccess.com` (given without
  `https://`, or with `http://`, it is normalised to that form). The Worker fetches the team's
  signing keys from `<team domain>/cdn-cgi/access/certs` (cached ten minutes) and requires the
  assertion's issuer to be the full https form. A key id the fetched set lacks is remembered for a
  minute and refused with 403 without fetching again, so the key set is fetched at most once a
  minute for unknown keys.
- `ACCESS_AUD` (variable): the audience tag of the one Access application (comma-separated if
  more than one).
- `OWNER_EMAIL` (secret): the one identity whose assertion may GET.
- `PUBLISHER_CLIENT_ID` (secret): the exporter's service token Client ID; Access puts it in the
  assertion's `common_name` (or, on some assertions, `sub`), and only that may PUT. The Worker
  compares whichever is a non-empty string, `common_name` first, in constant time, and refuses
  with 403 when neither is.
- `PUBLISHER_TOKEN` (secret): the value `--put` sends in `X-Surface-Publisher` (the exporter's
  `SURFACE_PUBLISHER_TOKEN`).

What it checks:

- **GET** needs a valid `Cf-Access-Jwt-Assertion`: signed by one of the team's keys (RS256),
  for that audience, from that issuer, not expired and not before its start (each with 60 seconds
  of leeway for clock skew), and the owner's email. Anything else, a header or payload that isn't
  a JSON object included, is 403.
- **PUT** needs the same assertion check with the exporter's client id (`common_name` or `sub`), the right
  `X-Surface-Publisher` value, a known version, app and purpose and a signature that verifies
  under the listed key its `key_id` names, a body of at most 512 KiB counted in bytes (else 413),
  a `made_at` no more than 5 minutes ahead of the Worker's clock (else 400, saying so), and a
  snapshot no older than the one it holds (else 409), that last check and the write being one
  atomic step in the Durable Object. It stores only the signed fields, and every answer names the
  snapshot identity it holds (`id`): 200 `{stored, id}`, 200 `{stored, id, already: true}` for the
  same snapshot again, 409 `{error, id}`.
- A Worker with any Access setting blank refuses every GET and PUT with 503, naming the blank
  setting. A store read or write that
  fails, a stored value that doesn't parse, or signing keys that can't be read return 503, never
  cached. Every response is `cache-control: no-store`.

It holds no GitHub token and no record access, and has no way into the home network.

### Recovering a wedged store

If GET or PUT returns 503 saying the stored snapshot is unreadable, or a snapshot dated in the
future (from a wrong clock) blocks every newer upload with 409, start an empty store: set the
Worker variable `STORE_NAME` to a new name (`latest-2`, then `latest-3`, ...) in `wrangler.toml` and
deploy the Worker, then upload again. The old object is simply no longer read.

```sh
cd surface/worker
bunx wrangler@4.156.2 deploy
```

The next PUT stores a fresh snapshot; until then GET answers 404 and the app says no snapshot
could be read.
