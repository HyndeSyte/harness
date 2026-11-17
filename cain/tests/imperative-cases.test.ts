// Nineteenth round: the specialist's outbox strips from a refused card only the sentences the
// link's own imperative() would refuse it for (harness/app/harness/outbox.py mirrors Q,
// IMPERATIVE_BEFORE and IMPERATIVE_AFTER exactly; tests/test_outbox_round19.py compares the
// sources). Both sides run these shared cases, so the two agree.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { imperative } from "../rootfs/opt/cain/gate/rules";

const cases: [string, string, boolean][] = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "tests", "imperative_cases.json"), "utf8"));

function tellsToUse(text: string, label: string): boolean {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "g"))) {
    if (imperative(text, m.index!, m.index! + m[0].length)) return true;
  }
  return false;
}

describe("the shared imperative cases", () => {
  for (const [text, label, want] of cases) {
    test(`${label} in ${JSON.stringify(text)}`, () => {
      expect(tellsToUse(text, label)).toBe(want);
    });
  }
});
