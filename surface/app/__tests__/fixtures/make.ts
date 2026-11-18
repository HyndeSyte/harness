// Remakes snapshot.json and snapshot.pub here: the fixture record exported and signed by the
// exporter itself, with a throwaway key whose private half is never written down.
// Run from the repo root: bun run surface/app/__tests__/fixtures/make.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, makeKeyPair, privateKey, signSnapshot } from "../../../export/lib";

const here = import.meta.dir;
const keys = makeKeyPair();
const snapshot = signSnapshot(
  buildSnapshot(join(here, "../../../export/fixtures/record"), new Date("2026-11-18T10:00:00Z")),
  privateKey(keys.privatePem),
);
writeFileSync(join(here, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
writeFileSync(join(here, "snapshot.pub"), keys.publicRaw + "\n");
console.log("wrote snapshot.json and snapshot.pub");
