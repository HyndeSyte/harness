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
`{version, app, purpose, key_id, made_at, revision, threads, excluded_rows, skipped_rows, sig}`.

```sh
# once: a key pair (keep the private key on the machine that exports, never commit it)
bun run surface/export --keygen <dir>   # writes surface.key, surface.pub, surface.pub.b64, surface.pub.entry

# read what would be exported, signed and written nowhere; the private word list goes only to the
# --report file (mode 0600, outside any git work tree), never to the screen; with --key it prints the
# approval flags (--made-at and --approve) for exactly these bytes, and with --report it writes those
# exact signed bytes beside the report (<report>.signed.json, mode 0600)
bun run surface/export --record <record checkout> --private-terms <terms file> \
  --config <exporter config> --dry-run --key <dir>/surface.key [--report [<private file>]]

# each export (the signer refuses an unknown lower-case or uncased word whatever the flags)
bun run surface/export --record <record checkout> --private-terms <terms file> \
  --config <exporter config> --out snapshot.json --key <dir>/surface.key [--strict]

# sign and upload exactly the bytes a dry run showed (--out is optional with --put; --put implies --strict)
SURFACE_PUT_HOST=<app hostname> \
SURFACE_ACCESS_CLIENT_ID=... SURFACE_ACCESS_CLIENT_SECRET=... SURFACE_PUBLISHER_TOKEN=... \
bun run surface/export --record <record checkout> --private-terms <terms file> \
  --config <exporter config> --key <dir>/surface.key --put https://<app hostname>/snapshot \
  --made-at <the dry run's time> --approve <the dry run's digest>

# check a snapshot (one key, PEM or raw, or a key list)
bun run surface/export --verify snapshot.json --pub <dir>/surface.pub

# check the exporter's key is listed, and not retired, in the keys the Worker and the app hold
bun run surface/export --key-match --key <dir>/surface.key --pub <key list, or a file>
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

**The owner approves the bytes he read (seventh round; eighth round: the bytes themselves).** `--put`
needs `--made-at <time>` and `--approve <digest>`, both printed by a dry run run with `--key`: the time
is the dry run's `made_at`, and the digest is the SHA-256 of the exact signed bytes (the snapshot's
identity, below). With `--report` the dry run also writes those exact bytes, the canonical signed JSON
as text, to `<report>.signed.json` beside the report (mode 0600, written atomically, refused inside a
git work tree like the report): `sha256sum` of that file is the digest, so what the owner approves is
what he can read. A dry run prints no approval when the bytes can't be uploaded (the gate or
`--strict` refuses them). The upload builds the snapshot once, at that time, computes its identity,
compares it with `--approve`, signs that same in-memory object and uploads its one serialization,
sending the identical body on every reconciling try; when the identity differs (the record, the
config, the key or the time changed since) it stops with exit 2 and nothing sent: run the dry run again
and read it. Since the Worker refuses a `made_at` more than 24
hours old, an approval is good for a day. Every `--put` needs one, so wiring the record keeper to
upload by itself after each change (Deploy, step 7) needs the owner's decision on how that approval
is given.

**An upload needs a revision (eighth round).** `--put` refuses with exit 2, nothing sent, when the
record's revision can't be signed (The signature, below), naming why: not a git checkout, not the top
of its own work tree, a shallow clone, no upstream branch, not at the upstream's tip, or which path the
exporter reads has changes not committed (`state/PENDING.md`, the holds file, the notes folder, or
anything else under `state/`). The Worker refuses a snapshot without a revision once it holds one, so
nothing would order it.

**The uploader's three outcomes.** Every upload ends in one of these, named on its last line:

- **Preflight rejection, exit 2: nothing sent.** The URL or environment checks above, no record
  revision, a missing or wrong approval (`--made-at` and `--approve`), a signed body over the Worker's
  512 KiB limit, or a body that doesn't verify under the exporter's own key.
  (A `--strict` failure stops earlier still, exit 1, also with nothing sent.)
- **Server rejection, exit 1: nothing stored.** A definite answer refusing it: any 4xx (403 from
  Access or the Worker, 409 when the Worker holds a snapshot that keeps its place, 413, 400) or an
  Access redirect. It is not retried. (Eighth round: a refusal met while reconciling is not this
  outcome; see below.)
- **Unknown remote outcome, exit 3.** No answer, a 5xx, an answer cut off, or a 2xx naming another
  snapshot: the request may have been stored with its response lost. The uploader reconciles by the
  snapshot's signed identity (the SHA-256 of its signed bytes, 64 hex digits): it sends
  the same signed bytes again, up to 3 tries in all (1 and 2 seconds apart), and the Worker answers
  every PUT with the identity it holds; the same identity already held is a 200 (`already`), so a
  lost response settles as **stored, exit 0**, printing `(snapshot <id>)`. If no try gets an answer,
  it says the snapshot may or may not be stored and exits 3; running the same export again later
  reconciles the same way (a newer snapshot simply replaces it). Eighth round: when an earlier try
  ended unknown and a later try is refused (a 409 because a newer snapshot landed since, or any other
  refusal), the first try's outcome is unresolved (it may have been stored, then replaced): the last
  line says so and it exits 3, not 1. A 409 that names this snapshot's own identity as the one held is
  stored, exit 0.

A 2xx counts as stored only when it names this snapshot's identity: success is reported only when the
server says this identity is the one current. A different identity, whatever its `made_at` (equal or
newer included), is never success: a 2xx naming it is exit 3, a 409 naming it exit 1 (exit 3 after an
earlier unknown try).

`--dry-run` runs every check a real run does (the exit-2 checks: no real owner name, no `names`
list, config JSON that doesn't parse, a missing or empty terms file, a term that doesn't compile)
and the whole pipeline before it prints anything; then it prints the snapshot it would sign on
stdout (gated text only; with `--key`, the very object signed, key id included), the approval flags
for those bytes on stderr (with `--key`; without it, a line saying there is no digest), and on stderr counts only: threads, rows left out and skipped, the
threads per area (`surface 2, garden 1, other 5`: the config's `areas` list is the primary control
on what an area may be), and how many capitalised words were replaced and how many lower-case or
uncased words aren't in the word list, and (eighth round) the run-time gate's verdict, checked without
signing: "the gate would refuse to sign: <path>", with no approval printed. **The words themselves
never go to stderr or stdout.** With `--report <file>` they go to that file alone, written with mode 0600 from the moment it exists (a
new temporary file, `<file>.tmp-<pid>-<random>`, created exclusively, then renamed over the path),
under a first line saying it is private and never to be relayed: the approval flags (and the path of
the signed-bytes file), the threads per area, then every strict failure (eighth round): each row
warning, each capitalised word the gate replaced and each unknown word, with its path, row, field and
word, and on the next line a suggested line to add (`allow_words: "<word>"` for the config, or, for a
capitalised bundled name word, a `name-words.txt [common]` line, only if it is an ordinary word too;
a person's name goes in the config's `names`); then each lower-case word known only as a name-word (not
a failure). `--report`
with no file writes `~/surface-dry-run.private.txt`. A report path inside any git work tree (a `.git`
folder or file in its folder or any above it, or git saying so) is refused with exit 2 before anything
is read; the folder is taken as it really is (eighth round: its first existing ancestor resolved with
realpath, so a folder outside any repository that is a link into one is refused), and the temporary
file and the rename use that resolved folder, so the check and the write see the same directory; the absolute path of the report is printed on stderr; the temporary file is removed on any
failure, an exception, an exit or a signal; and `surface/.gitignore` lists the default name and the
temporary-file pattern as a second line. `--report` goes only with `--dry-run` (else exit 2). With `--put` or `--out` a dry run is refused (exit 2). With `--strict` a leftover fails it
like a real run, and no snapshot is printed.

What it keeps: per snapshot, `app` and `purpose` (fixed: `harness-surface` and `in-motion-snapshot`),
`key_id` (the signing key's id) and `revision` (the record's commit, see The signature, or null); per
open row: `id`, `title` (the Item's first sentence, at most 140 code points),
`area` (the project folder the Item names, as in `projects/surface`, when it passes the privacy
checks below and is on the config's `areas` list, else `other`; the name exported is the list's own
entry, never the record's text), `who` (one fixed word: `you`,
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
- **Long cells fail closed.** Every term and pattern runs over a whole cell, never in chunks: a row
  with any cell (or the row's whole line) longer than 4,000 characters, in its normal form or folded,
  is left out whole and counted, with a warning naming its path and row (so `--strict`, and `--put`,
  fail on it). The chunked matcher is gone (seventh round): with every cell capped there is nothing to
  chunk.
- **One normal form.** Before any check, text is put in NFKC form with invisible formatting
  characters taken out (zero-width spaces and joiners, bidi controls, soft hyphens), and matched
  case-folded with accents off: "Jünîper", "ｂａｎｋ" and "ba<zero-width space>nk" are caught by
  "Juniper" and "bank". The strippers and the name replacement run on that same text, and it is
  what is exported.
- **Any row whose cells match a term is left out whole**, every column checked, the id too.
- **Stems.** A row is also left out whole when any cell holds one of the generic money and health
  stems (`STEM_RULES` in `export/lib.ts`), each with its token-boundary rule. Before a stem there is
  never a letter, digit or underscore, so no stem matches inside a word ("after" doesn't hold "er",
  "define" doesn't hold "fine"). Then:
  - **prefix** stems match any word that starts with them ("bank" catches "banking", "therap"
    "therapist"): money, financ, debt, bank, budget, paid, owed, invoice, rent, loan, mortgage, credit,
    salar, insur, refund, health, therap, doctor, appointment, surgery, psychiatr,
    dentist, dental, orthodont, periodont, endodont, denture, tooth, teeth, prescri, clinic, pharmac,
    medic, diagnos, price, quote, deposit, venmo, symptom, vaccin, pregnan, allerg, counsel,
    refill, biopsy, chemo, cancer, rehab, physio, results, urgent care, injur, zelle, cheque, tuition,
    blood, dosag, cardiol, ptsd;
  - **word** stems match only the whole word or the word with one of its listed endings, with no
    letter, digit or underscore after: pay (s, ing, ment, ments, ee, er, roll, check, checks, pal,
    able, out, day, slip), irs, pt, gp (s), mri (s), er, rx, meds, tax (es, ed, ing, able, ation), card
    (s), fee (s), cost (s, ing, ly), cash (ed, es, ing, back), owe (s, d), owing, scan (s, ned, ning,
    ner), pill (s), dose (s, d), sick (ness, er, est, ly), lab (s, work), fine (s, d), check (s, ed,
    ing, book, books, up, ups), wire (s, d), ticket (s, ed, ing), and (eighth round, moved from prefix
    because they matched ordinary words) hospital (s, ised, ized, isation, ization), bill (s, ed, ing,
    ings, able) and mental (ly). So "label", "labor", "checklist", "wireless", "payload", "cardboard",
    "taxi", "costume", "feel", "pillow", "hospitality", "billion", "billow" and "mentality" stay in.
  A stem of two words matches any spaces between them. A test checks every stem against its own word
  (and each ending), against the stem inside a longer word, and each short stem against its false
  positives, and (eighth round) every prefix stem against the common-word lists: none may start an
  ordinary word there but its own plain inflections. Config adds more (`exclude_stems`, each a prefix
  stem); it can't remove these.
- **Long numbers.** A row is left out whole when any cell has a run of four or more digits that
  isn't part of a date (`YYYY-MM-DD`, `M/D/YYYY`, or a year alone, 1900 to 2099): a card's last
  four, an account or a reference number, most phone numbers. A record code (one to three
  letters then one to five digits, like P1040) isn't such a run; a longer one is, so an IBAN written
  without spaces can't pass as a code.
- **Money in any form.** A row is left out whole when any cell has a currency symbol, an ISO
  currency code next to a number ("USD 40", "40EUR"; the common codes in lower case too, "40 usd"), or a number with a currency word
  ("50 dollars", "five quid", "2k euros").
- **Account shapes.** A row is left out whole when any cell has an IBAN (two letters, two check
  digits, then groups of letters and digits, spaced or not, six digits or more in all; any case, so a
  typed lower-case one counts), a card number (13 to 19 digits, with single spaces or hyphens between
  them in groups of any size), a UK sort code (12-34-56) when an account word is in the same cell or it
  isn't shaped like a date (DD-MM-YY, MM-DD-YY or YY-MM-DD: "12-05-26" alone is a date and stays), or a
  word naming an account number (acct, a/c, IBAN, BSB, ABA, routing number, sort code, account no or
  number), a number glued to it included ("acct42"). Every one of these patterns is case-insensitive.
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
- **Names that double as common words.** No word that is also a given name or surname is on the
  bundled common list. The check is against data, not a hand list alone: `export/names/surnames.txt`
  (the U.S. Census Bureau's Census 2000 surnames with at least 2,000 bearers, 13,862 names) and
  `export/names/given-names.txt` (the SSA's baby-name lists, 1880 to 2008, every name that reached 1 in
  20,000 births in some year, 6,380 names), both public-domain U.S. government data, bundled as used.
  Every word of `common-words.txt` found in them (an, back, book, call, check, do, fix, go, he, her,
  new, read, see, so, to, wait, walk, work, you and the like, 47 in all) moved into
  `export/name-words.txt`, beside the hand list (May, June, April, August, Will, Mark, Grace, Rose,
  Hope, Pat, Sue, Jack, Rich, Bob, Cook, Post and the like); a test fails if `common-words.txt` and
  the bundled lists, or `common-words.txt` and `name-words.txt`, share a word, and the code drops any
  that slips in. So "Will brings the drill", "ask May" and "Call the vet" are gated like any name,
  at a sentence start or not: the owner lists the ordinary sentence starts his record uses in
  `allow_words`, which lets a word stand everywhere. `name-words.txt` has two sections: `[common]`
  words are ordinary English words too, known in lower case ("the build will run" passes) and listed
  in the dry run's report; `[names]` words are names in lower case as well, so a lower-case one is an
  unknown word. Months and weekdays are on no list: one stays only next to a number or a date ("May
  5", "on 3 June", "the 3rd of May", "Friday 2026-11-20", "Friday, 20 November"), and only when no
  other name signal is there: a possessive ("May's"), a title before it (Mr, Mrs, Ms, Mx, Miss, Dr,
  Prof, Sir, Dame), a person cue before it (ask, tell, call, text, email, message, ping, meet, thank,
  remind, with, from, dear, hi, hey, cc, and their forms), or a gated or replaced name next to it. So
  "ask May 5 times" and "Mrs. May 12" are gated, "on 12 May" stays.
- **The gate's words.** Words are runs of Unicode letters (with their marks), joined by an apostrophe
  or a hyphen; digits, underscores and everything else split them. A possessive ('s, or ' after s)
  and the contractions ('d, 'll, 're, 've, 'm, n't; can't, won't, shan't) are taken off before a
  lookup, and a possessive name is replaced whole ("James' car" is "someone's car"). A run of initials
  ("J.R.R.") is one word, and a lone capital other than I and A is an initial: both are gated. An
  all-caps word is a capitalised word: "KESTREL" is gated, "OK" and "DONE" stand. "a.m." and "p.m."
  are known.
- **Unknown words.** Every lower-case or uncased word in an exported text that isn't in the word
  list (the allow words, the months and weekdays, `name-words.txt`'s `[common]` words, and the words
  the exporter puts in itself: you, your, someone, a link, an email address and so on), looked up
  with its possessive or contraction off and as an inflection of a known word ("brings", "carried",
  "fixing", "stopped"), is counted and listed in the dry run's `--report` file. Eighth round: a letter
  run touching a digit is looked up by its letters ("zorblat2" by "zorblat"); only a whole record-code
  form (one to three letters then one to five digits, nothing else: "v2", "x86", "p40") is exempt, and a
  number's own letters right after it ("3rd", "20th", "10am") are known. Seventh round: under
  `--strict` (and so `--put`) an unknown word in **any** free-text field (title, step, waits_for,
  outcome) fails the run, named by field and row only. Eighth round: the signer itself refuses one,
  whatever the flags, so a plain `--out` run with an unknown word left is exit 1 with nothing written
  ("the gate refused to sign: <path>"); the owner adds the word to `allow_words` (the report suggests
  the line) or fixes the record. A name written in lower case, or in a script with no case, is caught by the
  names list, the terms file and this check. The owner lists his record's ordinary words in
  `allow_words` from the report. Sentences never end after Mr, Mrs, Ms, Dr or St, so "waiting on Mr.
  Vale" keeps "Mr." and gates the name. The gate runs on the case-preserved normal form (NFKC, so a
  full-width or styled capital is a capital); only the stems, terms and names are matched on the
  case-folded copy. Under `--strict` (and so under `--put`) a gated word fails the run: exit 1,
  nothing written, each one named on stderr by field and row number only, never the word. A plain run
  prints only how many it replaced.
- **The area** is checked too: the private marker, the stems, the terms and money, then the
  config's `areas` list. Anything else is `other`.
- **One pipeline, checked at run time.** Every free text goes through one function, `sanitise` in
  `export/lib.ts` (the normal form, the strippers, the names, the first-sentence cut, the proper-noun
  gate, the cap), which returns a `GatedText`; the id, the times, who, state, area, app, purpose, key
  id and revision each have their own gate (a checked shape or a fixed list). The `GatedText` brand is
  a compile-time aid only. What holds at run time is `checkSigned`, which `signSnapshot` runs on every
  call. Eighth round: the signer never signs the caller's object. It first checks the input's shape
  (closed, before the key id is added; the threads array's index descriptors, enumerable data
  properties with no accessor, before any value is read), then builds a fresh, frozen plain object from
  the validated primitive values, each read once, adds the key id, and `checkSigned` walks that copy,
  which is what is signed. `checkSigned` checks it against a closed schema (exactly the signed fields,
  exactly a thread's fields, exactly a revision's; an unknown field, a missing one, a dynamic or symbol
  key, a getter, a hidden property, a class instance or an extra array property is refused), and checks
  every string by its kind: each free text by running `sanitise` again under this policy with its own
  field's cap (140 for the title, 200 for the step, none for the outcome and waits_for), which must
  return it unchanged, and by the unknown-word check (no remembered set of texts: whatever made the
  string, it passes only on its own merits, so a string sanitised under another policy, or for another
  field, is refused); an area only if it is `other` or on the config's `areas` list (and passes the
  same re-run); who and state only from their fixed lists; the id, times, key id and revision only in
  their shapes. `sanitise` is idempotent (a test runs it on its own output for every field and three
  policies over the fixture and strict corpora). A refusal names the path only, never the value. Area
  names come from the config's list: the exported name is the list's entry, and the config refuses an
  area that isn't a plain folder name. CI's cast check (`surface/check-casts.ts`) fails on `as
  GatedText`, `as unknown as` or the type `any` anywhere in `surface/`, `export/lib.ts` included
  (eighth round), but for one allowed line: `return s as GatedText;` in `mark()`, matched by its exact
  content under the exact line `function mark(s: string): GatedText {` (comments and strings don't
  count).
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

Ed25519 over the canonical JSON (sorted keys, no whitespace, UTF-8 by the standard `TextEncoder`) of
`{version, app, purpose, key_id, made_at, revision, threads, excluded_rows, skipped_rows}`, in base64
as `sig`. Everything but `sig` is signed:

- `version` is 2, the only version the app and the Worker accept: version 1 (no app, purpose or key
  id in its signed bytes) is refused, and a test replays a validly signed version 1 blob to each. The
  version goes up with every change to the signed fields, a thread's fields or a revision's fields: a
  test pins each version to its schema's fingerprint. Version 2 was never deployed, so the seventh
  round settled its fields (key_id and revision joined) in place, with its fingerprint re-pinned.
- `app` (`harness-surface`) and `purpose` (`in-motion-snapshot`) are fixed identifiers, so a later
  command envelope can carry its own purpose under its own key and neither signature can be replayed
  as the other.
- `key_id` is the first 16 hex digits of the SHA-256 of the raw 32-byte public key. Being signed, it
  can't be moved under another listed key's id.
- `revision` is the record's commit when the exporter knows it for certain: `{seq, commit}`, `commit`
  the full hash and `seq` the commit's count of ancestors, itself included (`git rev-list --count`),
  which only grows along a branch. The exporter sets it only when it is a stable property of a commit
  (eighth round): the record checkout is the top of its own git work tree, not a shallow clone
  (`git rev-parse --is-shallow-repository`), HEAD is the tip of the branch's configured upstream
  (`git rev-parse @{upstream}` equals HEAD; no upstream means no revision), and no path the exporter
  reads differs from that commit, untracked or ignored files included: `state/PENDING.md`, the holds
  file `state/holds.json`, the notes folder `state/notes`, and the rest of `state/`. Otherwise it is
  null, a note says why, and `--put` refuses. The Worker orders snapshots by it (below).
  **After a history rewrite that lowers the count** (a force-push that drops commits, a squash), the
  next revision's `seq` is below the one the Worker holds and every upload is 409 "an older record
  revision". The way out is to retire the exporter's key and rotate: make a new key pair, list the new
  key and mark the old `:retired` in both key lists (the Worker's `SNAPSHOT_PUBLIC_KEYS` and the app's
  `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`), redeploy the Worker and Pages, and upload with the new key: the
  Worker replaces a snapshot signed by a key no longer active with the next valid upload, whatever its
  sequence.

The app and the Worker refuse a snapshot with any field outside these and `sig`, or an unknown
version, app or purpose, before they read the signature (the app says "This snapshot is in a format
this app doesn't know" for the last three). The snapshot's **identity** is the SHA-256 of its signed
bytes (64 hex digits): the Worker names it in every answer, and the dry run prints it as the approval
digest.

**Key lists.** The Worker's `SNAPSHOT_PUBLIC_KEYS` and the app's `EXPO_PUBLIC_SURFACE_PUBLIC_KEY` are
key lists: comma-separated entries `<key id>:<raw public key, base64>` (the line `--keygen` prints, in
`surface.pub.entry`), with `:retired` after a key that may no longer sign. Each runtime checks every
entry's id against its key; a list with a malformed entry, a wrong id or an id listed twice is no list
(the Worker refuses every upload with 500, the app every snapshot). A snapshot verifies under the
entry its signed `key_id` names; a retired key's snapshot is refused by both (eighth round: the Worker
answers it with the same 403 message as a bad signature, "signature does not verify under an active
key ...", so its answer doesn't say which keys still count). `--verify` and `--key-match` take a key list, or one key raw or PEM. The canonical
form is one module, `shared/canonical.ts`, imported by the exporter, the Worker and the app (the app's
`metro.config.js` watches `shared/`).

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
- `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`: the key list (The signature, Key lists): the exporter's entry,
  and during a rotation the new one beside it, the old marked `:retired` after. Without it nothing verifies, and the app shows one line saying so and nothing else.
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
bun surface/check-casts.ts
cd surface/worker/workerd && bun install --frozen-lockfile --ignore-scripts && bun test ./suite.workerd.ts
cd surface/app && bun run test && bun run typecheck
```

The exporter's tests include **the strict-mode regression corpus** (`export/corpus.test.ts`):
every row of the fixture record, exported alone under `--strict`'s rules, must come out as
`export/fixtures/strict-corpus.json` says (`pass`, `excluded`, or `fail:` with the reason:
`capitalised`, `unknown`, `skipped`, `oversize`), and a fixture row without a line there fails
it. Rows P103 to P108 put May, June and Will at a sentence start and mid-sentence, and fail. The
seventh round's rows: P110 to P112 and P120 an unknown word in waits_for, the title, the step and an
uncased script; P113 and P114 possessives and contractions; P115 initials; P116 and P121 all-caps;
P117 and P118 a month beside a number with a person cue or a title (gated); P119 a month beside a
number alone (kept). The fixture config's `allow_words` lists the fixture record's ordinary words,
as the owner's would.

**The Worker under workerd** (`worker/workerd/suite.workerd.ts`): the Worker bundled as one module
the way wrangler deploys it, run by Miniflare (pinned, with its own lockfile) in workerd, the runtime
Cloudflare runs, with the real SQLite-backed Durable Object bound as `STORE` and Access's certs served
by an outbound stub. It covers PUT and GET, a concurrent upload race (twenty PUTs at once, and a
newer and an older together in both orders: the newest is always held), the clock bounds, a retired
key's far-ahead snapshot replaced by a valid key, reconciling and an older replay, version 1, and
Access. Its first run found that workerd refuses a main module exporting anything but handlers and
classes: the entry (`worker/src/index.ts`) now exports only the fetch handler and `SnapshotStore`,
everything else lives in `worker/src/worker.ts`, and a test pins the entry's exports.

`.github/workflows/surface.yml` runs them on every push and pull request: the Bun suites, the Worker
config check and the cast check (`surface-bun`), the workerd suite (`surface-workerd`), and the app
(`surface-app`): it checks offline that the lockfile's expo, react, react-dom and react-native are one
SDK 58 set (`app/scripts/check-sdk.mjs`, against expo's own `bundledNativeModules.json`), runs the
app's tests and typecheck, builds the web app, and fails if any `.html` file under `dist` has an
inline script, if `dist/_headers` is missing or its Content-Security-Policy, parsed directive by
directive, lacks `script-src 'self'` alone (no `'unsafe-inline'`, no `'unsafe-eval'`), `connect-src
'self'` or `frame-ancestors 'none'`, or if any file under `dist` holds a snapshot (a `snapshot.json`,
or a signed snapshot inside a file) (`app/scripts/check-dist.mjs`), then keeps that checked `dist` as
the run's artifact (`surface-web-dist`). **The CI artifact is synthetic only:** it is the app's code
and its public settings (the key list and the talk link), built from the repository with no record
and no snapshot in it, and the dist check fails the build if a snapshot ever lands in it. The Worker
check fails if `wrangler.toml` doesn't set both `workers_dev = false` and `preview_urls = false`,
lacks the Durable Object binding and its migration, or configures a KV namespace
(`worker/check-wrangler.ts`). The two deploy jobs, `surface-pages-deploy` and
`surface-worker-deploy` (below), each need `surface-bun`, `surface-app` and `surface-workerd` to pass
on that commit; both are configured but never run until switched on.
**Eighth round's tests.** `sanitise` run on its own output for every field and three policies over the
fixture and strict corpora (and edge cases: a cut, markdown, an ellipsis); the signer refusing an
accessor-backed field, an accessor on an array index (before any read), a string reused across fields,
a string sanitised under another policy and unknown text in each free-text field, and signing a copy a
later change to the caller's object can't touch; the digit rule; the dry run's gate verdict and its
signed-bytes file (its SHA-256 is the approval); the uploaded body's identity equal to `--approve`,
the identical body on every try, and a refusal after an unknown try being exit 3 (a 409 naming this
snapshot, exit 0); the revision's shallow, upstream and dirty-path rules and `--put` refusing without
one; a folder that is a link into a work tree refused; the cast check on `export/lib.ts` with its one
allowed line; a lower-case IBAN, a spaced card number, "acct42", and two-digit dates and versions that
stay; every prefix stem against the common-word lists; the report's suggested lines; the Worker's
mixed revisions both ways, one 403 for a retired key and a bad signature, and a JWK of another type or
algorithm. The workerd suite adds races with revisions, each in both arrival orders, one after the
other and both at once: equal `seq` with different commits (one 200, the other 409 conflict), a
higher `seq` with an older `made_at` (it wins), and the mixed cases (held with a revision and a
candidate without, and the reverse). Since the signer refuses unknown words whatever the flags, the
signing tests use the synthetic record or the fixture record without its unknown-word rows
(`export/fixtures/temp-record.ts`, `signableRecord`), and `--put` tests a record made a git checkout
with an upstream (`gitRecord`).

`app/__tests__/fixtures/snapshot.json` is the fixture record as the exporter signed it (since the
eighth round without its unknown-word rows), and
`vector.json` a cross-runtime vector (an emoji at the cut, non-BMP text, a revision), so the app's
tests check the exporter's signatures; `bun run surface/app/__tests__/fixtures/make.ts` remakes them
(and `snapshot.pub`, the key list) after the exporter changes.

## Deploy

Not deployed yet: there is no Cloudflare account.

**The owner's one step:** create a free Cloudflare account, and tell Cain it exists.

The Worker runs as a route on the app's own Pages hostname, so the app reads `/snapshot` from its
own origin: `connect-src 'self'` holds and there is no CORS. Cloudflare attaches Worker routes only
to a hostname in a zone on the account, so the Pages project is given a custom hostname in such a
zone and that hostname carries the route; `project.pages.dev` keeps serving the pages alone. The
Worker has no `workers.dev` host and no preview URLs (`wrangler.toml`, checked in CI).

**The store is a Durable Object** (`SnapshotStore` in `worker/src/worker.ts`, exported by the entry
`worker/src/index.ts`, bound as `STORE`, SQLite-backed, which the free plan allows). The Worker checks
Access, the publisher header, the signature (under an active key) and the clock bounds, then hands the
snapshot, its identity, its receipt time and the list of active key ids to the one store object, which
reads what it holds and decides in one step under its own lock (`blockConcurrencyWhile`), so two
uploads can't both pass the check. It stores the signed snapshot with its identity, `made_at`,
`key_id`, `revision` and the server's receipt time (`received_at`). The order, seventh round:

1. **The same identity** again is a 200 (`already`), nothing rewritten.
2. **A held snapshot signed by a key no longer active** (retired, or no longer listed) is replaced by
   any valid upload, whatever its `made_at` or revision: so a stolen key's snapshot, however far
   ahead it is dated or numbered, is cleared by retiring that key (the answer says
   `replaced_retired`).
3. **The held snapshot carries a revision and the upload doesn't** (eighth round): 409, "a revision
   is required once the store holds one". It never falls back to `made_at`.
4. **Both carry a revision:** the revision decides. A lower `seq` is 409 ("an older record
   revision"), the same `seq` with another commit is 409 ("another commit at the stored snapshot's
   record revision"), a higher `seq` is written whatever `made_at` says; the same commit falls
   through to `made_at`.
5. **Otherwise (the held snapshot has no revision) `made_at`:** an older one is 409, anything else
   (an equal one too) is written, an upload with a revision included; from then on a revision is
   required.

Every 409 names the identity held. A test runs a newer and an older PUT together with every storage
step yielding, in both orders, and the workerd suite runs twenty at once against the real Durable
Object: the newest is always what's held. There is no KV namespace.

**Pages serves what CI built.** The Pages project is a Direct Upload project (no Git connection,
no build on Cloudflare's side). The `surface-pages-deploy` job in `surface.yml` downloads the
`dist` the `surface-app` job built and checked, runs the dist checks again on those bytes, and
deploys them with `wrangler pages deploy` (pinned). It runs only on a push to `main` with the
repository variable `SURFACE_PAGES_DEPLOY` set to `true` and the secrets `CLOUDFLARE_API_TOKEN`
(a token allowed only to edit Cloudflare Pages on that account) and `CLOUDFLARE_ACCOUNT_ID`; until
then it is skipped. The app's two public settings come from the repository variables
`SURFACE_PUBLIC_KEYS` (the key list) and `SURFACE_TALK_URL` at build time. It also needs the workerd
suite to have passed on that commit.

**The Worker deploys from CI too**, gated the same way: the `surface-worker-deploy` job runs only on a
push to `main` with the repository variable `SURFACE_WORKER_DEPLOY` set to `true`, the secret
`CLOUDFLARE_WORKERS_API_TOKEN` (a token allowed only to edit Workers scripts and routes on that
account) and `CLOUDFLARE_ACCOUNT_ID`, and only after `surface-bun`, `surface-app` and
`surface-workerd` passed on that commit. It runs the Worker config check, refuses a `wrangler.toml`
with a `REPLACE_WITH` placeholder left, and deploys with `wrangler deploy` (pinned). A manual
`wrangler deploy` from a laptop skips those gates: deploy from CI.

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
     `<that hostname>/snapshot` (with `workers_dev = false` and `preview_urls = false`) from CI: make
     a token allowed only to edit Workers scripts and routes, set the secret
     `CLOUDFLARE_WORKERS_API_TOKEN` and the variable `SURFACE_WORKER_DEPLOY=true`, fill in
     `wrangler.toml` (its route and variables; the deploy job refuses a placeholder), and push to
     `main`: the job deploys only after the Bun, app and workerd suites pass on that commit.
2. **One Access application.** In Zero Trust, create one self-hosted, multi-domain Access
   application (so one audience tag) covering the custom hostname whole (the Worker's `/snapshot`
   route included), the Pages production host `project.pages.dev` and its preview wildcard
   `*.project.pages.dev`. Turn on its eager redirect cookie (the app's redirect is then always to
   that one application). Its identity policy: Allow, the owner's email address only, sign-in by
   one-time PIN, session 30 days. Note the team domain and the application's audience tag (AUD),
   and fill in the Worker's settings below.
3. **The keys, the service token, and a synthetic snapshot.** Make the export key pair on the Pi
   (`--keygen`), keep the private key there only, and put its key-list entry (`surface.pub.entry`,
   `<key id>:<raw base64>`) in `worker/wrangler.toml` (`SNAPSHOT_PUBLIC_KEYS`) and in the repository
   variable `SURFACE_PUBLIC_KEYS` (the app's `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`). Check all three hold
   the same key: `bun run surface/export --key-match --key <dir>/surface.key --pub <the Worker's
   value>`, and again with the app's value; each must say the exporter's key is listed and active. In Zero Trust, create a service token for the exporter and add
   a Service Auth policy allowing only it on that same Access application, beside the owner's
   Allow policy. The token's Client ID and secret and the publisher value live on the Pi with the
   private key and nowhere else, in `SURFACE_ACCESS_CLIENT_ID`, `SURFACE_ACCESS_CLIENT_SECRET` and
   `SURFACE_PUBLISHER_TOKEN`, with `SURFACE_PUT_HOST` set to the custom hostname. Then upload the
   synthetic record (made-up rows only), so the Worker holds a synthetic snapshot, never a real
      one, until every check in step 4 passes. First its dry run, which prints the approval flags, then
   the upload with them:
   `bun run surface/export --record surface/export/fixtures/synthetic --private-terms surface/export/fixtures/private-terms.txt --config surface/export/fixtures/exporter.json --key <dir>/surface.key --dry-run`,
   then the same with `--put https://<custom hostname>/snapshot --made-at <time> --approve <digest>`
   in place of `--dry-run`.
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
      `bun run surface/export --record <record> --private-terms <file> --config <file> --key <dir>/surface.key --dry-run --report <private file outside any repository>`
   (or `--report` alone, for `~/surface-dry-run.private.txt`). The owner reads the snapshot it
   prints, the threads per area, and the private report file (the capitalised words replaced, the
   unknown words, and the lower-case words that are also names) before the first upload, and adds
   terms, names, areas and allowed words until nothing on it should stay home and `--strict` passes
   (every unknown word now fails it, in any field); then deletes the report file. The dry run's last
   line on stderr, and the report's second line, give the approval flags for exactly the bytes he
   read. **Dry-run output, the report file above all, is never relayed anywhere**: no chat, no
   Discord, no record item, no pull request, no job report, no agent; it is read on the Pi only.
   Nothing real is uploaded until he says so.
6. **The first real `--put`.** On the Pi, with the four variables set:
      `bun run surface/export --record <record> --private-terms <file> --config <file> --key <dir>/surface.key --put https://<custom hostname>/snapshot --made-at <time> --approve <digest>`,
   with the flags the dry run he read printed, within 24 hours of it. If anything changed since, it
   stops with exit 2 and nothing sent: dry run again and read it. It prints `200 stored <time>
   (snapshot <id>)`; then the owner opens the app.
7. Wire the record keeper to run the exporter with `--put` after each change to the open list (a
   later change to Cain's App, not this one). Every `--put` needs an approval digest now, so this
   step needs the owner's decision first on how later uploads are approved.

**What protects what.** GET `/snapshot` is protected by Access (only the owner's identity gets
through) and by the Worker's own check of Access's assertion (the owner's email, below). The public
key gates PUT only: it proves an upload was signed by the exporter's private key, and does nothing
for who can read.

### Deploy follow-ups

To settle before or during the deploy, beside the checklist above:

- **One public key, checked, and the rotation path.** `--key-match` (step 3) checks the exporter's
  key is among the Worker's `SNAPSHOT_PUBLIC_KEYS` and the app's `SURFACE_PUBLIC_KEYS`. Both hold a
    key list and verify under the entry a snapshot's signed `key_id` names. To rotate: make the new
  pair (`--keygen` into a new folder), add its `surface.pub.entry` beside the old key in both lists
  (Worker variable, then the repository variable and a Pages deploy), check with `--key-match`
  against the new key, switch the exporter to the new private key and upload, then mark the old
  entry `:retired` in both lists (or remove it) and delete the old private key. Tests cover each
  step, including the old key refused once retired or removed.
- **A stolen key.** Mark its entry `:retired` in both lists and deploy: the Worker refuses its
  uploads, the app refuses its snapshots, and whatever it stored, however far ahead dated or
  numbered, is replaced by the next valid upload.
- **The public key gates PUT only.** Without a usable `SNAPSHOT_PUBLIC_KEYS` (malformed, or no active
  key) the Worker refuses PUT (500); GET is gated by Access and the owner's email alone. GET serves
  what it holds; a snapshot held under a key since retired is refused by the app until replaced.
- **An equal `made_at` is accepted.** A PUT whose `made_at` equals the stored one (and no revision
  says otherwise) replaces it; only an older one is 409.
- **workers.dev and previews, on the account.** The `workers_dev` and `preview_urls` checks in CI
  read only `wrangler.toml`; the smoke test (step 4) checks the live account, where the dashboard
  can turn either on whatever the file says.
- **Piece two's writes.** Every write route added in piece two needs a custom header plus an exact
  `Origin` check, beside Access.

### The Worker's settings

All from Worker variables and secrets; none is in the code.

- `SNAPSHOT_PUBLIC_KEYS` (variable): the key list (The signature, Key lists): `<key id>:<raw
  base64>` entries, comma-separated, `:retired` after a key that may no longer sign (one active key,
  except during a rotation).
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

- **GET** needs a valid `Cf-Access-Jwt-Assertion`: signed by one of the team's keys (RS256; eighth
  round: the key is imported only when its JWK says `kty` RSA and `alg` RS256, else 403),
  for that audience, from that issuer, not expired and not before its start (each with 60 seconds
  of leeway for clock skew), and the owner's email. Anything else, a header or payload that isn't
  a JSON object included, is 403.
- **PUT** needs the same assertion check with the exporter's client id (`common_name` or `sub`), the right
  `X-Surface-Publisher` value, a body of at most 512 KiB counted in bytes (else 413), exactly the
  signed fields and `sig` with version 2, the app and the purpose, a signature that verifies under the
  listed entry its signed `key_id` names, that entry not retired (else 403, one message for both since
  the eighth round, so the answer doesn't say which keys still count), a `made_at` no more than 5 minutes ahead of the Worker's clock and no more than 24
  hours behind it (else 400, saying which), and the store's order (above; else 409), that last check
  and the write being one atomic step in the Durable Object. It stores the signed snapshot and the
  time it received it, and every answer names the snapshot identity it holds (`id`): 200 `{stored,
  id, received_at}` (with `replaced_retired` when it cleared a retired key's snapshot), 200 `{stored,
  id, received_at, already: true}` for the same snapshot again, 409 `{error, id, made_at}`.
- A Worker with any Access setting blank refuses every GET and PUT with 503, naming the blank
  setting. A store read or write that
  fails, a stored value that doesn't parse, or signing keys that can't be read return 503, never
  cached. Every response is `cache-control: no-store`.

It holds no GitHub token and no record access, and has no way into the home network.

### Recovering a wedged store

If GET or PUT returns 503 saying the stored snapshot is unreadable, start an empty store. (A snapshot
from a stolen key, dated or numbered far ahead, needs no new store: retire that key, above. One from
the exporter's own key with a wrong revision or clock is cleared the same way, by rotating the key,
or by a new store.) To start an empty store: set the
Worker variable `STORE_NAME` to a new name (`latest-2`, then `latest-3`, ...) in `wrangler.toml` and
deploy the Worker, then upload again. The old object is simply no longer read.

```sh
cd surface/worker
bunx wrangler@4.156.2 deploy
```

The next PUT stores a fresh snapshot; until then GET answers 404 and the app says no snapshot
could be read.

### Runbook (eighth round)

No new routes: each of these uses the key lists, the deploys and the exporter as they are.

**Key compromise** (the exporter's private key, or the machine that holds it, may be in other hands):

1. Make a new key pair on a clean machine: `bun run surface/export --keygen <new dir>`.
2. Retire the old key in **both** key lists: in the Worker's `SNAPSHOT_PUBLIC_KEYS`
   (`worker/wrangler.toml`) and the app's `EXPO_PUBLIC_SURFACE_PUBLIC_KEY` (the repository variable
   `SURFACE_PUBLIC_KEYS`), change the old entry to `<old id>:<old key>:retired` and add the new
   entry. Check with `--key-match --key <new dir>/surface.key --pub <list>` (exit 0).
3. Redeploy the Worker and Pages (Deploy, above: a push to `main` with the deploy jobs on), so both
   refuse the old key: the Worker answers its uploads 403, the app refuses its snapshots.
4. Publish a replacement snapshot with the new key: a dry run with `--key <new dir>/surface.key`, read
   it, then `--put` with its approval. The Worker replaces whatever the old key wrote, however far
   ahead it is dated or numbered (`replaced_retired`).
5. If the upload credentials may be out too, rotate them as well: a new Access service token
   (`SURFACE_ACCESS_CLIENT_ID`, `SURFACE_ACCESS_CLIENT_SECRET`, and the Worker's `PUBLISHER_CLIENT_ID`)
   and a new `PUBLISHER_TOKEN` (`SURFACE_PUBLISHER_TOKEN` on the exporter's side).

**Replay of a captured snapshot into an emptied store.** A signed snapshot is not secret (the owner's
GET returns it), and it still verifies after the store is emptied (a new `STORE_NAME`), so whoever
holds one could try to put it back. Two things bound that. A PUT needs both upload credentials: the
Access service token, checked by Access before the Worker sees anything, and the publisher header,
checked by the Worker, plus the exporter's client id in Access's assertion; a captured snapshot alone
carries neither. And the Worker refuses a `made_at` more than 24 hours old, so even with the
credentials a replay works only within a day of the export. After emptying a store, upload a fresh
snapshot at once: the store then holds a newer revision, and any older one is 409.

**An unreadable stored snapshot** (GET or PUT answers 503 "the stored snapshot is unreadable"): reset
the store by starting an empty one, as in Recovering a wedged store above: set `STORE_NAME` to a new
name in `wrangler.toml` and deploy (`cd surface/worker && bunx wrangler@4.156.2 deploy`, or the deploy
job from `main`). Wrangler has no command that clears one Durable Object's storage in place; the new
name is the reset (the old object is never read again). Deleting every object of the class is a
migration (`deleted_classes`) and is not needed here. The next valid upload fills the new store; until
then GET answers 404.
