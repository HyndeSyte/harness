// The strict-mode corpus's one outcome function (corpus.test.ts; strict-corpus.json is its expectations).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, makePolicy, strictProblems } from "../lib";
import { tempRecord } from "./temp-record";

const FIX = import.meta.dir;
const policy = makePolicy(readFileSync(join(FIX, "private-terms.txt"), "utf8"), JSON.parse(readFileSync(join(FIX, "exporter.json"), "utf8")));

// A row alone, under --strict: left out on purpose, skipped as malformed, failing (and why), or passing.
export function strictOutcome(raw: string): string {
  const b = buildSnapshot(tempRecord([raw]), policy, new Date("2026-11-18T12:00:00Z"));
  const p = strictProblems(b);
  const why = [
    p.warnings.some((w) => /row skipped/.test(w)) ? "skipped" : "",
    p.warnings.some((w) => /row left out/.test(w)) ? "oversize" : "",
    p.leftovers.length ? "capitalised" : "",
    p.unknown.length ? "unknown" : "",
  ].filter(Boolean);
  if (why.length) return "fail:" + why.join("+");
  if (b.snapshot.excluded_rows) return "excluded";
  return "pass";
}

