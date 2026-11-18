# Surface

The owner's own app. Piece one is **In motion**: every open thread with its outcome, who has
it, the step it is on, what it waits for, and when it last moved. Nothing on it is written by
an agent at display time: agents write typed data in the record, the exporter copies it into a
signed snapshot, and only code draws it.

Three parts, none of them a Home Assistant App:

- `export/`: reads a checkout of the record and writes a surface-safe, signed snapshot.
- `app/`: an Expo universal app (web first, native later from the same code).
- `worker/`: a Cloudflare Worker that stores and serves the latest snapshot.

## The exporter

It reads `state/PENDING.md` (the open table), `state/holds.json` and `state/notes/<ID>.md` from
a record checkout, and writes
`{version, made_at, threads, excluded_rows, skipped_rows, sig, key_id}`.

```sh
# once: a key pair (keep the private key on the machine that exports, never commit it)
bun run surface/export --keygen <dir>          # writes surface.key, surface.pub, surface.pub.b64

# read what would be exported, signed and written nowhere (no key needed)
bun run surface/export --record <record checkout> --private-terms <terms file> \
  --config <exporter config> --dry-run

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
```

`--put <url>` sends the signed snapshot as a PUT with three headers: `CF-Access-Client-Id` and
`CF-Access-Client-Secret` (the Access service token, checked by Access) and `X-Surface-Publisher`
(checked by the Worker). Their values come only from the environment variables
`SURFACE_ACCESS_CLIENT_ID`, `SURFACE_ACCESS_CLIENT_SECRET` and `SURFACE_PUBLISHER_TOKEN`, never
from flags or files. A missing one stops it with exit 2 before anything is read or sent. So does a
URL that isn't https, carries credentials (`user:pass@`), or whose host isn't exactly
`SURFACE_PUT_HOST`. It never follows a redirect: any 3xx (Access sending the request to sign in, or
anywhere else) is refused with "Access redirected: the service token or its Service Auth policy is
wrong", exit 1, and nothing goes to the redirect's target. It prints the response status and at
most 200 characters of the Worker's own JSON message (no other body, never a header); a 2xx is
exit 0, anything else, or no answer, exit 1. `--put` implies `--strict`.

What it keeps, per open row: `id`, `title` (the Item's first sentence, at most 140 code points),
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
  file, or one with no terms, stops the exporter before it writes anything.
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
  periodont, endodont, denture, tooth, teeth, prescri, clinic, pharmac, medic, diagnos
  ("banking", "therapist", "payment", "cardboard" and "taxi" count too). Config adds more; it
  can't remove these.
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
- **The proper-noun gate.** After that, in every exported text, any capitalised word that
  doesn't start a sentence and isn't on the allow list (weekdays, months, "I", "OK", and the
  config's `allow_words`: the product and place words the owner lists) becomes "someone". Under
  `--strict` (and so under `--put`) such a word fails the run: exit 1, nothing written, each one
  named on stderr by row number, field and the word alone. `--dry-run` lists them for the owner
  to read.
- **The area** is checked too: the private marker, the stems, the terms and money, then the
  config's `areas` list. Anything else is `other`.
- **Counts.** `excluded_rows` (left out on purpose) and `skipped_rows` (no valid id or Since
  time) are signed with the snapshot; the app shows one line "N items not shown". Each skipped
  row is a warning on stderr with its path and row number (never its text); `--strict` makes
  any skipped row an error, and nothing is written.

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
`TextEncoder`) of `{version, made_at, threads, excluded_rows, skipped_rows}`, in base64 as
`sig`. `key_id` is the first 16 hex digits of the SHA-256 of the raw 32-byte public key. The app
and the Worker take the public key as those raw 32 bytes in base64 (`surface.pub.b64`);
`--verify` takes that or the PEM. The canonical form is one module, `shared/canonical.ts`,
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
- `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`: the exporter's public key. Without it nothing verifies, and
  the app shows one line saying so and nothing else.
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

`.github/workflows/surface.yml` runs them on every push and pull request, checks offline that the
lockfile's expo, react, react-dom and react-native are one SDK 58 set (`app/scripts/check-sdk.mjs`,
against expo's own `bundledNativeModules.json`), builds the web app, and fails if any `.html`
file under `dist` has an inline script, or if `dist/_headers` is missing or its
Content-Security-Policy, parsed directive by directive, lacks `script-src 'self'` alone (no
`'unsafe-inline'`, no `'unsafe-eval'`), `connect-src 'self'` or `frame-ancestors 'none'`
(`app/scripts/check-dist.mjs`). It also fails if the Worker's `wrangler.toml` doesn't set both
`workers_dev = false` and `preview_urls = false` (`worker/check-wrangler.ts`).
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

The store is KV for piece one. KV is eventually consistent, so the "no older snapshot" check can
race; the store moves to a Durable Object with piece two, before the first real upload.

### The checklist, in order

1. **The Pages project and the Worker first, so the hostnames exist.** Nothing real is uploaded,
   and nothing can be read: the Worker answers 503 to every request until its Access settings are
   filled in, and the app's own pages hold no data.
   - Make a KV namespace for the snapshot and put its id in `worker/wrangler.toml`.
   - Make a Pages project from `surface/app` (`app/wrangler.toml`), output `dist`, with this exact
     build command:
     `bun install --frozen-lockfile --ignore-scripts && bun scripts/check-sdk.mjs && bunx expo export --platform web && bun scripts/check-dist.mjs`
     (the install, the SDK set check, the web export, then the dist check, which reads what the
     export wrote). Set `EXPO_PUBLIC_SURFACE_TALK_URL` to the owner's DM link; the snapshot URL
     defaults to `/snapshot`. `app/public/_headers` sets a strict content policy.
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
   `worker/wrangler.toml` (`SNAPSHOT_PUBLIC_KEY`) and in the Pages build's
   `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`. In Zero Trust, create a service token for the exporter and add
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
   `bun run surface/export --record <record> --private-terms <file> --config <file> --dry-run`.
   The owner reads the whole output and the capitalised words it lists before the first upload,
   and adds terms, names, areas and allowed words until nothing on it should stay home. Nothing
   real is uploaded until he says so, and not before the store has moved to a Durable Object
   (piece two).
6. **The first real `--put`.** On the Pi, with the four variables set:
   `bun run surface/export --record <record> --private-terms <file> --config <file> --key <dir>/surface.key --put https://<custom hostname>/snapshot`.
   It prints `200 stored <time>`; then the owner opens the app.
7. Wire the record keeper to run the exporter with `--put` after each change to the open list (a
   later change to Cain's App, not this one).

**What protects what.** GET `/snapshot` is protected by Access (only the owner's identity gets
through) and by the Worker's own check of Access's assertion (the owner's email, below). The public
key gates PUT only: it proves an upload was signed by the exporter's private key, and does nothing
for who can read.

### The Worker's settings

All from Worker variables and secrets; none is in the code.

- `SNAPSHOT_PUBLIC_KEY` (variable): the exporter's public key, raw 32 bytes in base64.
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
  assertion's `common_name`, and only that may PUT.
- `PUBLISHER_TOKEN` (secret): the value `--put` sends in `X-Surface-Publisher` (the exporter's
  `SURFACE_PUBLISHER_TOKEN`).

What it checks:

- **GET** needs a valid `Cf-Access-Jwt-Assertion`: signed by one of the team's keys (RS256),
  for that audience, from that issuer, not expired and not before its start (each with 60 seconds
  of leeway for clock skew), and the owner's email. Anything else, a header or payload that isn't
  a JSON object included, is 403.
- **PUT** needs the same assertion check with the exporter's `common_name`, the right
  `X-Surface-Publisher` value, a signature that verifies against `SNAPSHOT_PUBLIC_KEY`, a body of
  at most 512 KiB counted in bytes (else 413), a `made_at` no more than 5 minutes ahead of the
  Worker's clock (else 400, saying so), and a snapshot no older than the one it holds (else 409).
  It stores only the signed fields.
- A Worker with any Access setting blank refuses every GET and PUT with 503, naming the blank
  setting. A KV read or write that
  fails, a stored value that doesn't parse, or signing keys that can't be read return 503, never
  cached. Every response is `cache-control: no-store`.

It holds no GitHub token and no record access, and has no way into the home network.

### Recovering a wedged `latest`

If GET or PUT returns 503 saying the stored snapshot is unreadable, or a snapshot dated in the
future (from a wrong clock) blocks every newer upload with 409, delete the one KV entry and
upload again:

```sh
cd surface/worker
bunx wrangler kv key delete latest --binding SNAPSHOTS --remote
```

The next PUT stores a fresh snapshot; until then GET answers 404 and the app says no snapshot
could be read.
