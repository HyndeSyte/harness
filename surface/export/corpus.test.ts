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
    expect(expected.P110).toBe("fail:waits_for");
  });
});
