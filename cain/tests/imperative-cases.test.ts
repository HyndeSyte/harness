// Nineteenth round: the specialist's outbox strips from a refused card only the sentences the
// link's own imperative() would refuse it for (harness/app/harness/outbox.py mirrors Q,
// IMPERATIVE_BEFORE and IMPERATIVE_AFTER exactly; tests/test_outbox_round19.py compares the
// sources). Twentieth round: it mirrors the label finder too (VERB, STATIC_LABELS, WITH_LABELS,
// named() and check()'s button rule; tests/test_outbox_round20.py compares the sources), and the
// shared refusal cases run here through check() and the very filter addCard applies, so the two
// agree on which labels a card is refused for, across line breaks and for labels it lacks.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, imperative } from "../rootfs/opt/cain/gate/rules";

const shared: {
  imperative: [string, string, boolean][];
  refusal: { text: string; buttons: string[]; known: string[]; refused: string[] }[];
} = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "tests", "imperative_cases.json"), "utf8"));

function tellsToUse(text: string, label: string): boolean {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "g"))) {
    if (imperative(text, m.index!, m.index! + m[0].length)) return true;
  }
  return false;
}

// What addCard refuses a specialist's card for: check()'s button hits that refuse, in an imperative position.
function refusedFor(text: string, buttons: string[], known: string[]): string[] {
  const w = check(text, { rules: ["button"], buttons, known });
  const hit = w.hits.filter((h) => h.rule === "button" && h.result === "refuse" && h.label && imperative(text, h.at, h.end));
  return [...new Set(hit.map((h) => h.label!))].sort();
}

describe("the shared imperative cases", () => {
  for (const [text, label, want] of shared.imperative) {
    test(`${label} in ${JSON.stringify(text)}`, () => {
      expect(tellsToUse(text, label)).toBe(want);
    });
  }
});

describe("the shared refusal cases (the label finder)", () => {
  for (const c of shared.refusal) {
    test(JSON.stringify(c.text), () => {
      expect(refusedFor(c.text, c.buttons, c.known)).toEqual([...c.refused].sort());
    });
  }
});
