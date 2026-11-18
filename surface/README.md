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
a record checkout, and writes `{version, made_at, threads, sig, key_id}`.

```sh
# once: a key pair (keep the private key on the machine that exports, never commit it)
bun run surface/export --keygen <dir>          # writes surface.key, surface.pub, surface.pub.b64

# each export
bun run surface/export --record <record checkout> --out snapshot.json --key <dir>/surface.key

# check a snapshot
bun run surface/export --verify snapshot.json --pub <dir>/surface.pub
```

What it keeps, per open row: `id`, `title` (the Item's first sentence, at most 140 characters),
`area` (the project folder the Item names, as in `projects/surface`, else `other`), `who`,
`step` (the Next step's first sentence, at most 200 characters), `waits_for` (or null),
`outcome` (Done when), `last_moved` (the newest of Since, the item's notes and its hold, as an
ISO time) and `state` (`running` while a job holds it, `waiting on you` when Who is Dane or
Waits for names him, `at his PC`, else `moving`).

What never leaves the house:

- A row is left out whole when its id or any of its cells mentions money, finance, debt, bank,
  budget, health, therapy, PT, doctor, medication or diagnosis, in any case, as a word or the
  start of one ("banking", "financial", "therapist" and "doctoral" count too).
- Every exported string has email addresses, phone numbers, street addresses, URLs and record
  codes (like P41) replaced by plain words ("an email address", "a link", "another item").
  Only the `id` field keeps a code.

The signature is Ed25519 over the canonical JSON (sorted keys, no whitespace) of
`{version, made_at, threads}`, in base64 as `sig`. `key_id` is the first 16 hex digits of the
SHA-256 of the raw 32-byte public key. The app and the Worker take the public key as those raw
32 bytes in base64 (`surface.pub.b64`); `--verify` takes that or the PEM.

## The app, locally

```sh
bun run surface/dev.ts          # a dev key in surface/.dev, the fixture record exported to
                                # app/public/snapshot.json, the public key in app/.env.local
cd surface/app
bun install
bun run web                     # opens In motion in the browser
```

`bun run surface/dev.ts --record <record checkout>` shows a real record instead of the fixtures.

Its settings, all from `EXPO_PUBLIC_` variables (see `app/src/config.ts`):

- `EXPO_PUBLIC_SURFACE_SNAPSHOT_URL`: where the snapshot is read. Default `/snapshot.json`.
- `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`: the exporter's public key. Without it nothing verifies, and
  the app shows one line saying so and nothing else.
- `EXPO_PUBLIC_SURFACE_TALK_URL`: the Discord DM link behind "Talk to Cain". A placeholder until set.

## Tests

```sh
bun test surface/export surface/worker
cd surface/app && bun run test && bun run typecheck
```

`.github/workflows/surface.yml` runs them on every push and pull request, and builds the web app.
`app/__tests__/fixtures/snapshot.json` is the fixture record as the exporter signed it, so the app's
tests check the exporter's signatures; `bun run surface/app/__tests__/fixtures/make.ts` remakes it
after the exporter changes.

## Deploy

Not deployed yet: there is no Cloudflare account.

**The owner's one step:** create a free Cloudflare account, and tell Cain it exists.

Cain's steps, after that:

1. Make a KV namespace for the snapshot and put its id in `worker/wrangler.toml`.
2. Make the export key pair on the Pi (`--keygen`), keep the private key there only, and put
   `surface.pub.b64` in `worker/wrangler.toml` (`SNAPSHOT_PUBLIC_KEY`) and in the Pages build's
   `EXPO_PUBLIC_SURFACE_PUBLIC_KEY`.
3. Make a Pages project from `app/` (`app/wrangler.toml`): build command
   `bun install && bunx expo export --platform web`, output `dist`, with
   `EXPO_PUBLIC_SURFACE_SNAPSHOT_URL=/snapshot` and `EXPO_PUBLIC_SURFACE_TALK_URL` set to the
   owner's DM link. `app/public/_headers` sets a strict content policy.
4. Give the Pages project its hostname, and deploy the Worker on the route `<that hostname>/snapshot`,
   so the app reads its snapshot from its own origin.
5. Set up Cloudflare Access, as below.
6. Wire the record keeper to run the exporter after each change to the open list and PUT the
   snapshot (a later change to Cain's App, not this one).

### The Access policy

Two Access applications, both self-hosted, made in the Zero Trust dashboard:

- **The app**, on the whole hostname: one Allow rule, the owner's email address only, sign-in by
  one-time PIN. Session length 30 days on his devices. This covers the pages and `GET /snapshot`.
- **The upload**, on `<hostname>/snapshot`: one Service Auth rule allowing only a service token
  made for the exporter. The exporter sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`
  with its PUT; the token lives on the Pi with the private key and nowhere else. Since the more
  specific path wins, the owner's own Allow rule is added here too, so his GET still works.

Behind Access, the Worker still refuses any PUT whose signature doesn't verify against its
public key, an older snapshot than the one it holds, and any field outside the signed ones. It
holds no GitHub token and no record access, and has no way into the home network.
