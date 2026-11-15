// Dane's standards, the one registry (rootfs/opt/cain/standards, org-v2 DESIGN 4.F): every entry
// is well formed and has a home; an invariant names a test that CI runs, by its name, or a gate
// rule with its shared cases; a procedure names where it's checked; the number of principles
// (prose nothing checks) is held to prose-baseline; nothing private is in it (this repository
// is public); each role's text reaches its sessions whole, in parts under Claude Code's cut for
// a hook's added context, with his newer corrections after it; and a load that fails says so.
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_KINDS, incomingOf, KINDS, PART_MAX, PARTS, parse, parts, problems, REGISTRY, ROLES } from "../rootfs/opt/cain/standards/load";

const REPO = join(import.meta.dir, "../..");
const LOAD = join(import.meta.dir, "../rootfs/opt/cain/standards/load.ts");
const text = readFileSync(REGISTRY, "utf8");
const entries = parse(text);
const line = (e: (typeof entries)[number]) => `${e.id} ${e.title} (${e.kind}): ${e.rule}`;

describe("each entry", () => {
  test("there are entries, each id once, in order, and every line of each is a known field, once", () => {
    expect(entries.length).toBeGreaterThan(50);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(problems(text)).toEqual([]);
    // What the check catches: a rule's second line, a field it doesn't know, a field twice.
    const bad = "## S-900 A\n- kind: principle\n- rule: one\n  and a second line\n- note: x\n- kind: invariant\n";
    expect(problems(bad)).toEqual(['S-900, line 4: not a "- key: value" line', 'S-900, line 5: no key "note"', 'S-900, line 6: "kind" twice']);
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

  test("an invariant names what fails without it: a test or test group by its name in a suite CI runs, or a gate rule with its shared cases", () => {
    const cases = JSON.parse(readFileSync(join(import.meta.dir, "gate-cases.json"), "utf8")).cases;
    for (const e of entries.filter((x) => x.kind === "invariant")) {
      const refs = (e.enforcedBy ?? "").split(";").map((r) => r.trim()).filter(Boolean);
      expect([e.id, refs.length > 0]).toEqual([e.id, true]);
      for (const r of refs) {
        const rule = /^cain\/tests\/gate-cases\.json rule "([a-z]+)"$/.exec(r);
        if (rule) {
          const n = cases.filter((c: any) => [...(c.fix ?? []), ...(c.refuse ?? []), ...(c.unsure ?? [])].includes(rule[1])).length;
          expect([e.id, r, n > 0]).toEqual([e.id, r, true]);
          continue;
        }
        const m = /^(\S+) "([^"]{12,})"$/.exec(r);
        expect([e.id, r, !!m]).toEqual([e.id, r, true]);
        const [file, name] = [m![1], m![2]];
        // pytest runs tests/test_*.py, bun test runs cain/tests/*.test.ts
        expect([e.id, file, /^tests\/test_\w+\.py$|^cain\/tests\/[\w-]+\.test\.ts$/.test(file)]).toEqual([e.id, file, true]);
        expect([e.id, file, existsSync(join(REPO, file))]).toEqual([e.id, file, true]);
        const decls = readFileSync(join(REPO, file), "utf8").split(/\r?\n/)
          .filter((l) => (file.endsWith(".py") ? /^\s*def test_/ : /\b(test|it|describe)\(\s*["'`]/).test(l));
        expect([e.id, name, decls.some((l) => l.includes(name))]).toEqual([e.id, name, true]);
      }
    }
  });

  test("a procedure names where it's checked", () => {
    for (const e of entries.filter((x) => x.kind === "procedure")) expect([e.id, (e.checkedAt ?? "").length > 5]).toEqual([e.id, true]);
  });

  test("what the calendar specialist alone carries is checked: its code doesn't read prose", () => {
    for (const e of entries.filter((x) => x.applies?.length === 1 && x.applies[0] === "specialist"))
      expect([e.id, e.kind]).not.toEqual([e.id, "principle"]);
  });
});

describe("the registry as a whole", () => {
  test("the number of principles is prose-baseline's: a correction becomes a test or a gate, or sharpens an entry, and a new principle is a visible change", () => {
    const baseline = Number(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/standards/prose-baseline"), "utf8").trim());
    expect(entries.filter((e) => e.kind === "principle").length).toBe(baseline);
  });

  test("nothing private in a public repository, and no em dash", () => {
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);                 // a mail address
    expect(text).not.toMatch(/\+?\d[\d\s().-]{8,}\d/);                     // a phone number
    expect(text).not.toMatch(/https?:\/\//);                               // a link out
    // Household and health words: the household is "another member of the household".
    expect(text).not.toMatch(/\b(kids?|children|son|daughter|wife|husband|spouse|homework|doctors?|dentist|therapy|medical|diagnos\w*|farm)\b/i);
  });
});

describe("each role's text reaches its sessions whole", () => {
  for (const role of ["cain", "laptop", "jobs"]) {
    test(`${role}: within ${PARTS} parts, each under the cut and naming its number, every entry that applies in it whole, once`, () => {
      const ps = parts(entries, role, { version: "abcd1234" });
      expect(ps.length).toBeLessThanOrEqual(PARTS);
      ps.forEach((p, i) => {
        expect(p.length).toBeLessThanOrEqual(PART_MAX);
        expect(p).toStartWith(`Dane's standards, part ${i + 1} of ${ps.length}, version abcd1234`);
      });
      const all = ps.join("\n");
      for (const e of entries) {
        const applies = !!e.applies && (e.applies.includes("all") || e.applies.includes(role));
        expect([e.id, all.split(`${e.id} ${e.title} (`).length - 1]).toEqual([e.id, applies ? 1 : 0]);
        if (applies) expect(all).toContain(line(e));
      }
    });
  }

  test("his newer corrections come after the entries and win over them, each whole or counted with where to read it, never cut short", () => {
    const path = "/data/record/rules/incoming.md";
    const one = parts(entries, "cain", { incoming: ["2026-11-15: never say Cain is idle when a job runs (truth)"], incomingPath: path });
    const last = one.at(-1)!;
    expect(last).toContain(`His newer corrections (${path}), not in this list yet. They win over it until they're folded in:\n- 2026-11-15: never say Cain is idle`);
    expect(one.join("\n").indexOf("His newer corrections")).toBeGreaterThan(one.join("\n").indexOf(line(entries.filter((e) => e.applies?.includes("all")).at(-1)!)));
    // A long one, its restriction at the end: whole.
    const long = `2026-11-15: ${"a careful rule ".repeat(55)}and never on Sundays.`;
    expect(long.length).toBeGreaterThan(800);
    expect(parts(entries, "cain", { incoming: [long], incomingPath: path }).at(-1)).toContain(`- ${long}`);
    // Too many for the room: whole ones, then how many more and where; never past PARTS or the cut.
    const many = parts(entries, "cain", { incoming: Array.from({ length: 40 }, (_, i) => `correction ${i}: ${"x".repeat(300)}`), incomingPath: path });
    expect(many.length).toBeLessThanOrEqual(PARTS);
    for (const p of many) expect(p.length).toBeLessThanOrEqual(PART_MAX);
    expect(many.at(-1)).toMatch(/\(\d+ more there, too long to show here: read them whole there now\.\)$/);
    for (const l of many.at(-1)!.split("\n").filter((x) => x.startsWith("- correction"))) expect(l.length).toBe(2 + "correction 0: ".length + 300 + (l.match(/correction (\d+)/)![1].length - 1));
    // One too long for any room: said, with where.
    expect(parts(entries, "cain", { incoming: ["x".repeat(9_000)], incomingPath: path }).at(-1))
      .toEndWith(`His newer corrections are in ${path}, not in this list yet, too long to show here: read them whole there now. They win over it until they're folded in.`);
    // A file that couldn't be read is said.
    expect(parts(entries, "cain", { incomingError: "EACCES", incomingPath: path }).at(-1))
      .toEndWith(`His newer corrections couldn't be read (EACCES): read ${path} yourself now. They win over this list until they're folded in.`);
  });

  test("a correction is any list line of the file", () => {
    expect(incomingOf("# Dane's corrections\n\nOne line each.\n- 2026-11-15: one\n* two\n+ three\n12. four\n-not one\n")).toEqual(["2026-11-15: one", "two", "three", "four"]);
  });

  test("the hook's answer: SessionStart's added context, nothing for a part past the end, and the jobs' parts only in a cloud session", () => {
    const run = (env: Record<string, string>, ...a: string[]) =>
      Bun.spawnSync(["bun", LOAD, ...a], { stdout: "pipe", env: { ...process.env, STANDARDS_INCOMING: "none", ...env } });
    const one = JSON.parse(run({}, "cain", "--part", "1").stdout.toString());
    expect(one.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(one.hookSpecificOutput.additionalContext).toStartWith("Dane's standards, part 1 of ");
    const past = run({}, "cain", "--part", String(PARTS + 1));
    expect([past.exitCode, past.stdout.toString()]).toEqual([0, ""]);
    expect(run({}, "everyone").exitCode).toBe(2);
    expect(run({}, "specialist").exitCode).toBe(2);
    expect(run({ CLAUDE_CODE_REMOTE: "true" }, "jobs", "--part", "1").stdout.toString()).toContain("Dane's standards, part 1 of ");
    const { CLAUDE_CODE_REMOTE, ...local } = process.env;
    const laptop = Bun.spawnSync(["bun", LOAD, "jobs", "--part", "1"], { stdout: "pipe", env: { ...local, STANDARDS_INCOMING: "none" } });
    expect(laptop.stdout.toString()).toBe("");
  });

  test("a file of his newer corrections that can't be read is said in the last part; none written yet is nothing", () => {
    const d = mkdtempSync(join(tmpdir(), "incoming-"));
    const lastOf = (incoming: string) => {
      const p = Bun.spawnSync(["bun", LOAD, "cain", "--part", String(PARTS)], { stdout: "pipe", env: { ...process.env, STANDARDS_INCOMING: incoming } });
      return JSON.parse(p.stdout.toString()).hookSpecificOutput.additionalContext as string;
    };
    expect(lastOf(d)).toContain(`His newer corrections couldn't be read (EISDIR): read ${d} yourself now.`);   // a folder, not a file
    expect(lastOf(join(d, "none-yet.md"))).not.toContain("His newer corrections");
  });
});

describe("a load that fails says so, with where to read the list", () => {
  // load.ts reads the registry beside it: a copy of it in a folder of its own stands in.
  const beside = (registry?: string) => {
    const d = mkdtempSync(join(tmpdir(), "standards-"));
    copyFileSync(LOAD, join(d, "load.ts"));
    if (registry !== undefined) writeFileSync(join(d, "registry.md"), registry);
    const run = (...a: string[]) => Bun.spawnSync(["bun", join(d, "load.ts"), ...a], { stdout: "pipe", env: { ...process.env, STANDARDS_INCOMING: "none" } });
    return { d, run };
  };
  const ctx = (p: ReturnType<typeof Bun.spawnSync>) => JSON.parse(p.stdout.toString()).hookSpecificOutput.additionalContext as string;

  test("no registry: part 1 says they didn't load and where to read them; the other parts add nothing", () => {
    const { d, run } = beside();
    const said = ctx(run("cain", "--part", "1"));
    expect(said).toStartWith("Dane's standards didn't load (");
    expect(said).toContain(`Read ${join(d, "registry.md")} yourself now, before you act: the entries that apply to all and to cain.`);
    expect(run("cain", "--part", "2").stdout.toString()).toBe("");
  });

  test("a registry that isn't well formed is said as that, never loaded short", () => {
    const { run } = beside(text.replace(/^(- rule: .*)$/m, "$1\n  a second line"));
    expect(ctx(run("laptop", "--part", "1"))).toContain("registry.md isn't well formed: S-001, line ");
  });

  test(`one too long for its ${PARTS} parts: part ${PARTS} says the rest is only in the file`, () => {
    const big = Array.from({ length: 160 }, (_, i) => `## S-${String(100 + i).padStart(3, "0")} Entry ${i}\n- kind: principle\n- applies: all\n- home: role:Cain\n- source: x\n- rule: ${"a long rule ".repeat(20)}\n`).join("\n");
    const { d, run } = beside(big);
    const said = ctx(run("cain", "--part", String(PARTS)));
    expect(said).toContain(`This list didn't fit in its ${PARTS} parts:`);
    expect(said).toContain(`only in ${join(d, "registry.md")}. Read the rest there now.`);
    expect(said.length).toBeLessThan(8_000);
  });
});

describe("where it's loaded", () => {
  const fallsBack = (command: string, cwd: string) => {
    // bun missing or failing: the hook's own words still reach the session.
    const d = mkdtempSync(join(tmpdir(), "nobun-"));
    writeFileSync(join(d, "bun"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    const p = Bun.spawnSync(["bash", "-c", command], { cwd, stdout: "pipe", env: { ...process.env, PATH: `${d}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: cwd } });
    return JSON.parse(p.stdout.toString()).hookSpecificOutput.additionalContext as string;
  };

  test("this repository's cloud jobs: every part on every start, and words of their own when bun isn't there", () => {
    const project = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
    expect(project.permissions.deny).toContain("PushNotification");
    const [group] = project.hooks.SessionStart;
    expect(project.hooks.SessionStart).toHaveLength(1);
    expect(group.matcher).toBeUndefined();                                  // startup, resume, clear, compact and fork
    expect(group.hooks.map((h: any) => h.command.split(" || ")[0])).toEqual([1, 2, 3].map((n) =>
      `bun "$CLAUDE_PROJECT_DIR/cain/rootfs/opt/cain/standards/load.ts" jobs --part ${n}`));
    if (process.platform !== "win32")
      for (const [i, h] of group.hooks.entries())
        expect(fallsBack(h.command, REPO)).toStartWith(`Part ${i + 1} of the standards (Dane) did not load: read cain/rootfs/opt/cain/standards/registry.md in this repository`);
  });

  test("Cain's: words of his own when bun can't run a part", () => {
    const settings = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/settings.json"), "utf8"));
    if (process.platform === "win32") return;
    for (const [i, h] of settings.hooks.SessionStart[0].hooks.entries())
      expect(fallsBack(h.command, REPO)).toStartWith(`Part ${i + 1} of the standards (Dane) did not load: read /opt/cain/standards/registry.md yourself now`);
  });
});
