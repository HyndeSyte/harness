// The message gate's rules (gate/rules.ts), in report mode in this release. The shared
// cases in gate-cases.json are run here against rules.ts and by pytest against the
// Python port (tests/message_rules.py), so the two stay equal.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { around, AT, check, RULES, STATIC_LABELS, verdict } from "../rootfs/opt/cain/gate/rules";

const shared = JSON.parse(readFileSync(join(import.meta.dir, "gate-cases.json"), "utf8"));
const rulesOf = (r: ReturnType<typeof check>, result: string) => [...new Set(r.hits.filter((h) => h.result === result).map((h) => h.rule))].sort();

describe("the shared cases", () => {
  for (const c of shared.cases) {
    test(c.name, () => {
      const ctx = c.context ?? {};
      const r = check(c.text, { rules: ctx.rules, buttons: ctx.buttons, known: ctx.known, answersHim: ctx.answers_him });
      expect(r.fixed).toBe(c.fixed ?? c.text);
      expect(rulesOf(r, "fix")).toEqual([...(c.fix ?? [])].sort());
      expect(rulesOf(r, "refuse")).toEqual([...(c.refuse ?? [])].sort());
      expect(rulesOf(r, "unsure")).toEqual([...(c.unsure ?? [])].sort());
    });
  }

  test("the static labels are the ones the cases file lists", () => {
    expect([...STATIC_LABELS]).toEqual(shared.static_labels);
  });

  test("every rule is covered both ways", () => {
    for (const rule of RULES) {
      expect(shared.cases.some((c: any) => [...(c.fix ?? []), ...(c.refuse ?? []), ...(c.unsure ?? [])].includes(rule))).toBe(true);
      expect(shared.cases.some((c: any) => !c.fix && !c.refuse && !c.unsure && c.text.length > 0)).toBe(true);
    }
  });
});

describe("the rules", () => {
  test("Nov 10, synthetic: tap Undo in a reply to a receipt without Undo is refused, and says which label", () => {
    const r = check("Tap Undo on the receipt above and it's gone.", { buttons: ["Not mine", "Wrong time", "Just this once", "Stop"] });
    expect(verdict(r)).toBe("refuse");
    expect(r.hits).toMatchObject([{ rule: "button", result: "refuse", label: "Undo" }]);
    expect(verdict(check("each on its own card with Undo", { buttons: ["Stop"] }))).toBe("refuse");
  });

  test("a hit says where, in at most 60 characters on one line", () => {
    const long = `${"Moved the swim lesson to the later slot today, ".repeat(3)}— and ${"then the art class moved too, ".repeat(3)}`;
    const r = check(long);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].around.length).toBeLessThanOrEqual(60);
    expect(r.hits[0].around).toContain("—");
    expect(r.hits[0].around).not.toContain("\n");
    expect(around("a\nb\nc", 2, 3)).toBe("a b c");
  });

  test("each send point's rules: the specialist's cards get no machine rule, tap notes and the link only the fixes", () => {
    expect([...AT.cain]).toEqual([...RULES]);
    expect([...AT.card]).toEqual(["dash", "app", "count", "button"]);
    expect([...AT.answer]).toEqual(["dash", "app"]);
    expect([...AT.link]).toEqual(["dash", "app"]);
    expect(verdict(check("Room 123456789012345678 at 2:00", { rules: AT.card }))).toBe("pass");   // a number from a calendar title
  });

  test("code spans and link targets are never rewritten", () => {
    const text = "See `a — b` and [the page](https://example.com/x—y) — then the add-on.";
    const r = check(text);
    expect(r.fixed).toBe("See `a — b` and [the page](https://example.com/x—y), then the App.");
  });

  test("a verdict: refuse beats fix, fix beats can't tell", () => {
    expect(verdict(check("Moved swim — tap Undo.", { buttons: [] }))).toBe("refuse");
    expect(verdict(check("Moved swim — then art."))).toBe("fix");
    expect(verdict(check("Tap Undo.", { buttons: null }))).toBe("unsure");
    expect(verdict(check("Moved swim to 4:30."))).toBe("pass");
  });
});
