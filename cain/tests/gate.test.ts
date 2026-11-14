// The message gate's rules (gate/rules.ts). The shared cases in gate-cases.json are run
// here against rules.ts and by pytest against the Python port (tests/message_rules.py), so
// the two stay equal.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { around, AT, check, hostsOnly, linkHost, RANGE_WHY, RULES, STATIC_LABELS, verdict, whyOf } from "../rootfs/opt/cain/gate/rules";

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
      if (c.around) expect(r.hits.map((h) => h.around)).toEqual(c.around);
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

  test("an em dash between two numbers that isn't a clock range is held, and the reason says to say the range in words", () => {
    for (const text of ["From 2026 — 2027 it runs.", "Room 4—5 is free.", "Swim moved to 4:30 — 2 blocks shifted.", "Nov 12 — 4:30 PM swim is set.", "Room 4 — 5:30 start.",
      "Sat. 5 — 6 PM", "No. 5 — 6 PM", "Thursday, 12 — 4:30 PM swim is set.", "Dec 3, 12 — 1 PM lunch", "1. 12 — 1 PM", "Swim is 9:30 — 11."]) {
      const r = check(text);
      expect(r.hits).toMatchObject([{ rule: "dash", result: "refuse" }]);
      expect(r.fixed).toBe(text);                                     // never ", ": a range would read as a list
      expect(whyOf(r.hits[0])).toBe(RANGE_WHY);
    }
    expect(whyOf({ rule: "dash", result: "fix" })).toBe("no em dashes");
    expect(whyOf({ rule: "nonsense", result: "refuse" })).toBe("a message rule");
  });

  test("a link in an excerpt keeps only its host, wherever the excerpt starts or ends", () => {
    expect(hostsOnly("See https://github.com/a/b?token=x and https://example.com now.")).toBe("See https://github.com/… and https://example.com now.");
    const text = `${"x".repeat(70)} https://example.com/private/ids/0123456789abcdef0123456789abcdef01234567?key=1 and more words`;
    const r = check(text);
    expect(r.hits).toMatchObject([{ rule: "machine" }]);
    expect(r.hits[0].around).toBe("https://example.com/… and");
    expect(around(text, 100, 110)).not.toContain("private");
  });

  test("a link in an excerpt is its scheme and host alone: no user name, password, port, path, query or fragment; one that can't be read is a link", () => {
    // Nov 14 review: "https://user:secret@example.com/..." kept "user:secret@".
    expect(linkHost("https://user:secret@example.com/private?key=abc")).toBe("https://example.com/…");
    expect(linkHost("https://user:secret@example.com")).toBe("https://example.com/…");
    expect(linkHost("https://a@b@Example.COM:8443/x#frag")).toBe("https://example.com/…");
    expect(linkHost("http://example.com")).toBe("http://example.com");
    expect(linkHost("https://[::1]:80/x")).toBe("https://[::1]/…");
    expect(linkHost("https://example.com/a?b=1,")).toBe("https://example.com/…,");      // a sentence's own mark stays
    expect(linkHost("https://example.com\\@evil.example/x")).toBe("https://example.com/…");
    for (const bad of ["https://", "https://user:secret@", "https://exa%mple.com/x", "https://bücher.example/x", "https://ex ample.com", "https://example.com:port/x"])
      expect(linkHost(bad)).toBe("a link");
    // The window's edges never cut into a link: it comes out whole, as its host.
    const t = "Call https://user:secret@example.com:8443/reset?token=abc today.";
    for (let from = 0; from < t.length; from++)
      for (const to of [from + 1, from + 9, t.length]) expect(hostsOnly(t, from, to)).not.toMatch(/user|secret|8443|reset|token/);
    expect(hostsOnly(t, 10, 20)).toBe("https://example.com/…");
    expect(around(t, 30, 40)).toBe("https://example.com/… today.");
  });

  test("a verdict: refuse beats fix, fix beats can't tell", () => {
    expect(verdict(check("Moved swim — tap Undo.", { buttons: [] }))).toBe("refuse");
    expect(verdict(check("Moved swim — then art."))).toBe("fix");
    expect(verdict(check("Tap Undo.", { buttons: null }))).toBe("unsure");
    expect(verdict(check("Moved swim to 4:30."))).toBe("pass");
  });
});
