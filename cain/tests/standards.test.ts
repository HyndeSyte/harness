// Dane's standards, the one registry (rootfs/opt/cain/standards, org-v2 DESIGN 4.F): every entry
// is well formed and has a home; an invariant names a test that exists and says what it says; a
// procedure names where it's checked; the number of principles (prose nothing checks) never
// rises; nothing private is in it (this repository is public); and each role's text reaches its
// sessions whole, in parts under Claude Code's cut for a hook's added context.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_KINDS, KINDS, PART_MAX, PARTS, parse, parts, REGISTRY, ROLES } from "../rootfs/opt/cain/standards/load";

const REPO = join(import.meta.dir, "../..");
const text = readFileSync(REGISTRY, "utf8");
const entries = parse(text);

describe("each entry", () => {
  test("there are entries, each id once, in order", () => {
    expect(entries.length).toBeGreaterThan(50);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  test("has a kind, who carries it, a home, a source and its rule", () => {
    for (const e of entries) {
      const bad = [
        !KINDS.includes(e.kind as (typeof KINDS)[number]) && "kind",
        !(e.applies?.length && e.applies.every((a) => ROLES.includes(a as (typeof ROLES)[number]))) && "applies",
        !e.source && "source",
        !(e.rule && e.rule.length > 20) && "rule",
      ].filter(Boolean);
      expect([e.id, bad]).toEqual([e.id, []]);
    }
  });

  test("every standard has a home: a role, a journey, a design section or an open item", () => {
    for (const e of entries) {
      const homes = (e.home ?? "").split(";").map((h) => h.trim()).filter(Boolean);
      const ok = homes.length > 0 && homes.every((h) => HOME_KINDS.some((k) => h.startsWith(`${k}:`) && h.length > k.length + 1));
      expect([e.id, e.home, ok]).toEqual([e.id, e.home, true]);
    }
  });

  test("an invariant names the test that fails without it, and that test says it", () => {
    for (const e of entries.filter((x) => x.kind === "invariant")) {
      const refs = (e.enforcedBy ?? "").split(";").map((r) => r.trim()).filter(Boolean);
      expect([e.id, refs.length > 0]).toEqual([e.id, true]);
      for (const r of refs) {
        const m = /^(\S+) "([^"]+)"$/.exec(r);
        expect([e.id, r, !!m]).toEqual([e.id, r, true]);
        const file = join(REPO, m![1]);
        expect([e.id, m![1], existsSync(file)]).toEqual([e.id, m![1], true]);
        expect([e.id, m![2], readFileSync(file, "utf8").includes(m![2])]).toEqual([e.id, m![2], true]);
      }
    }
  });

  test("a procedure names where it's checked", () => {
    for (const e of entries.filter((x) => x.kind === "procedure")) expect([e.id, (e.checkedAt ?? "").length > 5]).toEqual([e.id, true]);
  });
});

describe("the registry as a whole", () => {
  test("the number of principles never rises: a correction becomes a test or a gate, or sharpens an entry", () => {
    const baseline = Number(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/standards/prose-baseline"), "utf8").trim());
    const principles = entries.filter((e) => e.kind === "principle").length;
    expect(principles).toBeLessThanOrEqual(baseline);
  });

  test("nothing private in a public repository, and no em dash", () => {
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);                 // a mail address
    expect(text).not.toMatch(/\+?\d[\d\s().-]{8,}\d/);                     // a phone number
    expect(text).not.toMatch(/https?:\/\//);                               // a link out
  });
});

describe("each role's text reaches its sessions whole", () => {
  for (const role of ["cain", "laptop", "jobs", "specialist"]) {
    test(`${role}: within ${PARTS} parts, each under the cut, every entry that applies in it once`, () => {
      const ps = parts(entries, role);
      expect(ps.length).toBeLessThanOrEqual(PARTS);
      for (const p of ps) expect(p.length).toBeLessThanOrEqual(PART_MAX);
      const all = ps.join("\n");
      for (const e of entries) {
        const there = all.includes(`${e.id} ${e.title} (`);
        expect([e.id, there]).toEqual([e.id, !!e.applies && (e.applies.includes("all") || e.applies.includes(role))]);
      }
    });
  }

  test("the hook's answer: SessionStart's added context, and nothing for a part past the end", () => {
    const run = (...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../rootfs/opt/cain/standards/load.ts"), ...a], { stdout: "pipe" });
    const one = JSON.parse(run("cain", "--part", "1").stdout.toString());
    expect(one.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(one.hookSpecificOutput.additionalContext).toStartWith("Dane's standards");
    const past = run("cain", "--part", String(PARTS + 1));
    expect([past.exitCode, past.stdout.toString()]).toEqual([0, ""]);
    expect(run("everyone").exitCode).toBe(2);
  });
});
