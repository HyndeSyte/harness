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
  template: { head: string; job: string; body: string; outcomes: Record<string, string>; known: string[] };
  end_to_end: { name: string; html: string; buttons: string[]; known: string[]; first: string;
    refused_first: string[]; outcome: string }[];
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

// Twenty-first round: the specialist's fixed template, every line and each outcome phrase (chosen by enum), is
// refused for no label the link knows: STATIC_LABELS and the specialist's own.
describe("the fixed template's words", () => {
  const t = shared.template;
  for (const line of [t.head, t.job, t.body, ...Object.values(t.outcomes)]) {
    test(JSON.stringify(line), () => {
      expect(refusedFor(line, [], t.known)).toEqual([]);
    });
  }
  test("the outcome phrases are exactly done, not done and couldn't verify", () => {
    expect(Object.keys(t.outcomes).sort()).toEqual(["done", "not_done", "unverified"]);
  });
});

// Twenty-first round: cases built from real differences between the specialist's mirror and the link (a code span
// holding a label, a bold head without terminal punctuation, a label in a link's text). tests/test_outbox_round21.py
// runs each through the specialist's outbox, whose mirror reads the first try as refused here and strips the head
// with its sentence, so the fixed template goes with the card's own buttons; here the link's real check refuses the
// first try for those labels and passes the template the outbox sends, with those buttons (and Stop, which the
// specialist's chat adds to every card with buttons).
describe("refused cards, end to end", () => {
  const t = shared.template;
  for (const c of shared.end_to_end) {
    test(c.name, () => {
      const carried = [...c.buttons, "Stop"];
      expect(refusedFor(c.first, carried, c.known)).toEqual([...c.refused_first].sort());
      const sent = [t.head, t.outcomes[c.outcome], t.body].join("\n");
      expect(refusedFor(sent, carried, c.known)).toEqual([]);
      const w = check(sent, { rules: ["button"], buttons: carried, known: c.known });
      expect(w.hits.filter((h) => h.rule === "button" && h.result === "refuse")).toEqual([]);
    });
  }
});
