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

# export, sign and upload (--out is optional with --put)
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
from flags or files. A missing one stops it with exit 2 before anything is read or sent. It prints
the response status and the Worker's message (never a header value); a 2xx is exit 0, anything
else, or no answer, exit 1.

What it keeps, per open row: `id`, `title` (the Item's first sentence, at most 140 code points),
`area` (the project folder the Item names, as in `projects/surface`, else `other`), `who`,
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
- **Any row whose cells match a term is left out whole**, every column checked, the id too.
- **Stems.** A row is also left out whole when any cell has a word starting with one of the
  generic money and health stems in the code: money, financ, debt, bank, budget, pay, invoice,
  tax, rent, loan, salar, insur, refund, health, therap, pt, doctor, dentist, prescri, clinic,
  pharmac, medic, diagnos ("banking", "therapist", "payment" and "taxi" count too). Config adds
  more; it can't remove these.
- **The private marker is final.** A row carrying the tag `#private` in any cell, or a
  `Private` column whose cell is `yes`, `y`, `true`, `x` or `private`, never exports, whatever
  else it says.
- **Identifiers are stripped.** Every exported string has email addresses, phone numbers,
  street addresses, URLs and record codes (like P41) replaced by plain words ("an email
  address", "a link", "another item"); an area that is itself an identifier becomes `other`.
  Only the `id` field keeps a code.
- **Names never leave.** Who and state are worked out first, from the names as written. Then in
  every exported text (`title`, `step`, `waits_for`, `outcome`) each of the owner's configured
  names becomes "you" (its possessive, "<name>'s", becomes "your"), and each name in `names`
  becomes "someone" ("someone's"): whole word, any case, so a name inside a longer word is left
  alone.
- **Counts.** `excluded_rows` (left out on purpose) and `skipped_rows` (no valid id or Since
  time) are signed with the snapshot; the app shows one line "N items not shown". Each skipped
  row is a warning on stderr with its path and row number (never its text); `--strict` makes
  any skipped row an error, and nothing is written.

### Config

`--config <file>`, a JSON file, and the environment add to the generic defaults:

```json
{ "owner_names": ["<the owner's first name>"], "names": ["<other people's names>"], "exclude_stems": ["<more stems>"] }
```

or `SURFACE_OWNER_NAMES`, `SURFACE_NAMES` and `SURFACE_EXCLUDE_STEMS`, comma-separated. The code
knows the owner only by the role word ("owner", "the owner"); the owner's own name and other
people's names (`names`, empty by default) live in this config on the machine that exports, never
in the repository. Tests use made-up values only
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

What it shows when the read fails: a redirect or a blocked request (an expired Access session)
is one line, "Sign in again", whose control reloads the whole page so Access can sign the owner
in; any other failure is "No snapshot could be read". A snapshot dated ahead of the device's
clock says so, never a negative age. A who or state the app doesn't know is a plain "other"
label, never dropped.

## Tests

```sh
bun test surface/export surface/worker
cd surface/app && bun run test && bun run typecheck
```

`.github/workflows/surface.yml` runs them on every push and pull request, checks offline that the
lockfile's expo, react, react-dom and react-native are one SDK 58 set (`app/scripts/check-sdk.mjs`,
against expo's own `bundledNativeModules.json`), builds the web app, and fails if
`dist/index.html` has an inline script or `dist/_headers` is missing (`app/scripts/check-dist.mjs`).
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
zone and that hostname carries the route; `project.pages.dev` keeps serving the pages alone.

### The checklist, in order

1. **The Pages project and the Worker first, so the hostnames exist.** Nothing is uploaded yet,
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
     `<that hostname>/snapshot`.
2. **The Access applications.** In Zero Trust, create self-hosted Access applications for the
   Pages host `project.pages.dev`, its preview wildcard `*.project.pages.dev` (every preview
   deployment), and the custom hostname with its `/snapshot` path. Each has one identity policy:
   Allow, the owner's email address only, sign-in by one-time PIN, session 30 days. Note the team
   domain and each application's audience tag (AUD), and fill in the Worker's settings below.
3. **Smoke test.** For each of those hostnames, and `/snapshot` on each, a request with no
   cookie must get a redirect to Access (302 to `<team>.cloudflareaccess.com`) or a 403, never a
   200: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<hostname>/snapshot`.
   Stop if any says 200.
4. **Dry run on the real record, read by the owner.** On the Pi, with the owner's private terms
   file and config:
   `bun run surface/export --record <record> --private-terms <file> --config <file> --dry-run`.
   The owner reads the whole output before the first upload, and adds terms and names until
   nothing on it should stay home. Nothing is uploaded until he says so.
5. **The service token and its Service Auth policy.** In Zero Trust, create a service token for
   the exporter, and add a Service Auth policy allowing only it to the `/snapshot` application,
   beside the owner's Allow policy. Make the export key pair on the Pi (`--keygen`), keep the
   private key there only, and put `surface.pub.b64` in `worker/wrangler.toml`
   (`SNAPSHOT_PUBLIC_KEY`) and in the Pages build's `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`. The token's
   Client ID and secret and the publisher value live on the Pi with the private key and nowhere
   else, in `SURFACE_ACCESS_CLIENT_ID`, `SURFACE_ACCESS_CLIENT_SECRET` and
   `SURFACE_PUBLISHER_TOKEN`.
6. **The first `--put`.** On the Pi, with those three variables set:
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
- `ACCESS_TEAM_DOMAIN` (variable): `https://<team>.cloudflareaccess.com`. The Worker fetches the
  team's signing keys from `<team domain>/cdn-cgi/access/certs` (cached ten minutes) and requires
  the assertion's issuer to be this domain.
- `ACCESS_AUD` (variable): the audience tag of the Access application that covers `/snapshot`
  (comma-separated if more than one).
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
