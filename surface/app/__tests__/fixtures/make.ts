// Remakes snapshot.json, vector.json and snapshot.pub here: the fixture record exported and
// signed by the exporter itself, and a cross-runtime vector (emoji, non-BMP text, an ellipsis)
// signed the same way, with a throwaway key whose private half is never written down.
// The app's tests verify both with its own Ed25519 code: the two runtimes must agree.
// Run from the repo root: bun run surface/app/__tests__/fixtures/make.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, firstSentence, makeKeyPair, makePolicy, privateKey, signSnapshot } from "../../../export/lib";

const here = import.meta.dir;
const fix = join(here, "../../../export/fixtures");
const keys = makeKeyPair();
const key = privateKey(keys.privatePem);
const policy = makePolicy(readFileSync(join(fix, "private-terms.txt"), "utf8"), JSON.parse(readFileSync(join(fix, "exporter.json"), "utf8")));
const snapshot = signSnapshot(buildSnapshot(join(fix, "record"), policy, new Date("2026-11-18T10:00:00Z")).snapshot, key);
const vector = signSnapshot(
  {
    version: 1,
    made_at: "2026-11-18T10:00:00.000Z",
    threads: [
      {
        id: "P1",
        title: firstSentence("a".repeat(138) + "😀😀😀", 140),
        area: "other",
        who: "the assistant",
        step: "Café, 中文, 𝄞 and \u{1F469}‍\u{1F4BB} … \"quoted\" \\ back",
        waits_for: null,
        outcome: "é vs é",
        last_moved: "2026-11-18T09:00:00.000Z",
        state: "moving",
      },
    ],
    excluded_rows: 1,
    skipped_rows: 2,
  },
  key,
);
writeFileSync(join(here, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
writeFileSync(join(here, "vector.json"), JSON.stringify(vector, null, 2) + "\n");
writeFileSync(join(here, "snapshot.pub"), keys.publicRaw + "\n");
console.log("wrote snapshot.json, vector.json and snapshot.pub");
