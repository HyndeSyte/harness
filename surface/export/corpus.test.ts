// The strict-mode regression corpus (surface/README.md, Tests): every row of the fixture record,
// exported alone under --strict's rules, must come out as fixtures/strict-corpus.json says. A row
// added to the fixture needs its line there, so the whole fixture stays a regression corpus. CI runs
// it with the rest of the exporter's tests (bun test surface/export).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openTable } from "./lib";
import { strictOutcome } from "./fixtures/corpus";

const FIX = join(import.meta.dir, "fixtures");
const expected: Record<string, string> = JSON.parse(readFileSync(join(FIX, "strict-corpus.json"), "utf8"));

const rows = openTable(readFileSync(join(FIX, "record", "state", "PENDING.md"), "utf8")).rows;
const keyOf = (cells: Record<string, string>) => cells["id"].trim();

describe("the strict-mode corpus", () => {
  test("covers every fixture row, and nothing else", () => {
    expect(rows.map((r) => keyOf(r.cells)).sort()).toEqual(Object.keys(expected).sort());
  });
  for (const r of rows) {
    const id = keyOf(r.cells);
    test(`${id}: ${expected[id]}`, () => {
      expect([id, strictOutcome(r.raw)]).toEqual([id, expected[id]]);
    });
  }
  test("the sixth round's name rows fail under --strict, at a sentence start and mid-sentence", () => {
    for (const id of ["P103", "P104", "P105", "P106", "P107", "P108"]) expect([id, expected[id]]).toEqual([id, "fail:capitalised"]);
    expect(expected.P109).toBe("pass");
  });
  test("seventh round: an unknown lower-case word fails in every free-text field, not only waits_for", () => {
    // P110 in waits_for, P111 in the title, P112 in the step, P120 an uncased (no-case script) word.
    for (const id of ["P110", "P111", "P112", "P120"]) expect([id, expected[id]]).toEqual([id, "fail:unknown"]);
  });
  test("seventh round: possessives, apostrophe forms, initials and all-caps", () => {
    // A possessive is looked up without its 's (P113 gated, P114 known); a contraction by its base
    // (P114 "We'll", "it's"); initials are one name (P115 "J.R."); all-caps is capitalised (P116
    // "KESTREL" gated, "OK" allowed; P121 "ROBINSONS" gated, "DONE" allowed).
    expect(expected.P113).toBe("fail:capitalised");
    expect(expected.P114).toBe("pass");
    expect(expected.P115).toBe("fail:capitalised");
    expect(expected.P116).toBe("fail:capitalised");
    expect(expected.P121).toBe("fail:capitalised");
  });
  test("seventh round: a month next to a number is a date only with no other name signal", () => {
    // A person cue before it (P117 "Ask May 5 times"), a title (P118 "Mrs. May 12"): gated. Alone
    // beside a number (P119 "on 12 May", P109 "May 5", "3 June"): a date.
    expect(expected.P117).toBe("fail:capitalised");
    expect(expected.P118).toBe("fail:capitalised");
    expect(expected.P119).toBe("pass");
  });
});
