// Remakes snapshot.json, vector.json and snapshot.pub here: the fixture record exported and
// signed by the exporter itself, and a cross-runtime vector (emoji, non-BMP text, an ellipsis)
// signed the same way, with a throwaway key whose private half is never written down.
// The app's tests verify both with its own Ed25519 code: the two runtimes must agree.
// Run from the repo root: bun run surface/app/__tests__/fixtures/make.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ID, PURPOSE_SNAPSHOT, SNAPSHOT_VERSION } from "../../../shared/canonical";
import { areaOf, buildSnapshot, gateFixed, gateId, gateRevision, gateTime, makeKeyPair, makePolicy, privateKey, sanitise, signSnapshot } from "../../../export/lib";

const here = import.meta.dir;
const fix = join(here, "../../../export/fixtures");
const keys = makeKeyPair();
const key = privateKey(keys.privatePem);
const policy = makePolicy(readFileSync(join(fix, "private-terms.txt"), "utf8"), JSON.parse(readFileSync(join(fix, "exporter.json"), "utf8")));
const snapshot = signSnapshot(buildSnapshot(join(fix, "record"), policy, new Date("2026-11-18T10:00:00Z")).snapshot, key, policy);
// Every string goes through the exporter's own gates (signSnapshot signs nothing else). The text is
// lower case, so the proper-noun gate leaves it as written.
const vectorPolicy = makePolicy("not-a-real-term", { owner_names: ["Nobody"], names: [] });
const text = (t: string, max?: number) => sanitise(t, vectorPolicy, max).text;
const vector = signSnapshot(
  {
    version: SNAPSHOT_VERSION,
    app: gateFixed(APP_ID),
    purpose: gateFixed(PURPOSE_SNAPSHOT),
    made_at: gateTime(Date.parse("2026-11-18T10:00:00.000Z")),
    revision: gateRevision(42, "0123456789abcdef0123456789abcdef01234567"),
    threads: [
      {
        id: gateId("P1"),
        title: text("a".repeat(138) + "😀😀😀", 140),
        area: areaOf("nothing", vectorPolicy),
        who: gateFixed("the assistant"),
        step: text("café, 中文, 𝄞 and \u{1F469}‍\u{1F4BB} … \"quoted\" \\ back"),
        waits_for: null,
        outcome: text("é vs é"),
        last_moved: gateTime(Date.parse("2026-11-18T09:00:00.000Z")),
        state: gateFixed("moving"),
      },
    ],
    excluded_rows: 1,
    skipped_rows: 2,
  },
  key,
  vectorPolicy,
);
writeFileSync(join(here, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
writeFileSync(join(here, "vector.json"), JSON.stringify(vector, null, 2) + "\n");
// The app's key list: this key's entry (`<key id>:<raw base64>`).
writeFileSync(join(here, "snapshot.pub"), keys.publicEntry + "\n");
console.log("wrote snapshot.json, vector.json and snapshot.pub");
