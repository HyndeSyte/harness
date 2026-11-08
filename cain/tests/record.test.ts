import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest, plan, hygiene, frontMatter, type Tree } from "../rootfs/opt/cain/record/core.ts";
import { cycle, nightly, blobSha, type Config } from "../rootfs/opt/cain/record/main.ts";

const note = (id: string, extra = "") => `---\nid: ${id}\ntitle: Soil profile\nsources: [notion:Knowledge]\n${extra}---\n\nBody\n`;
const fakeTree = (files: Record<string, string>): Tree => ({
  read: (p) => files[p] ?? null,
  sha: (p) => (p in files ? blobSha(files[p]) : null),
});

describe("requests", () => {
  test("parse refuses junk and accepts a change", () => {
    expect(parseRequest("nope").error).toBe("not JSON");
    expect(parseRequest(JSON.stringify({ id: "x", from: "cain", kind: "change", summary: "s", ops: [] })).error).toBe("bad id");
    expect(parseRequest(JSON.stringify({ id: "abc123", from: "cain", kind: "change", summary: "s", ops: [] })).error).toContain("1 to 50");
    const ok = parseRequest(JSON.stringify({ id: "abc123", from: "cain", kind: "change", summary: "s", ops: [{ op: "append", path: "areas/farm/decisions.md", text: "x" }] }));
    expect(ok.req?.id).toBe("abc123");
  });

  test("put needs the sha it read; stale writes are conflicts, not overwrites", () => {
    const t = fakeTree({ "areas/farm/open.md": "old\n" });
    const req = (base: string) => ({ id: "r1abcd", from: "cain", kind: "change" as const, summary: "s", ops: [{ op: "put" as const, path: "areas/farm/open.md", content: "new\n", base }] });
    expect(plan(req(blobSha("old\n")), t).state).toBe("ok");
    expect(plan(req("deadbeef"), t)).toMatchObject({ state: "conflict" });
    expect(plan(req("new"), t)).toMatchObject({ state: "conflict" });
  });

  test("rules: where, decisions append-only, notes need id and sources, size", () => {
    const t = fakeTree({ "areas/farm/decisions.md": "a\n" });
    const r = (ops: any[]) => plan({ id: "r1abcd", from: "cain", kind: "change", summary: "s", ops }, t);
    expect(r([{ op: "put", path: ".github/workflows/x.yml", content: "", base: "new" }])).toMatchObject({ state: "rejected" });
    expect(r([{ op: "put", path: "areas/../x", content: "", base: "new" }])).toMatchObject({ state: "rejected" });
    expect(r([{ op: "put", path: "log/requests/x.jsonl", content: "", base: "new" }])).toMatchObject({ state: "rejected" });
    expect(r([{ op: "put", path: "areas/farm/decisions.md", content: "b\n", base: blobSha("a\n") }])).toMatchObject({ state: "rejected" });
    const appended = r([{ op: "append", path: "areas/farm/decisions.md", text: "b" }]);
    expect(appended.state === "ok" && appended.writes.get("areas/farm/decisions.md")).toBe("a\nb\n");
    expect(r([{ op: "put", path: "areas/farm/notes/soil.md", content: "no front matter", base: "new" }])).toMatchObject({ state: "rejected" });
    expect(r([{ op: "put", path: "areas/farm/notes/soil.md", content: note("farm-soil"), base: "new" }]).state).toBe("ok");
    expect(r([{ op: "put", path: "areas/farm/open.md", content: "x".repeat(70_000), base: "new" }])).toMatchObject({ state: "rejected" });
  });

  test("a removal is only allowed as the losing side of a recorded merge", () => {
    const loser = note("soil-2");
    const t = fakeTree({ "areas/farm/notes/soil-2.md": loser, "areas/farm/notes/soil.md": note("soil") });
    const rm = { op: "remove" as const, path: "areas/farm/notes/soil-2.md", base: blobSha(loser), merged_into: "areas/farm/notes/soil.md" };
    expect(plan({ id: "r1abcd", from: "cain", kind: "change", summary: "s", ops: [rm] }, t)).toMatchObject({ state: "rejected" });
    const survivor = note("soil", "replaces:\n  - areas/farm/notes/soil-2.md\n");
    const ok = plan({ id: "r1abcd", from: "cain", kind: "change", summary: "s", ops: [
      { op: "put", path: "areas/farm/notes/soil.md", content: survivor, base: blobSha(note("soil")) }, rm] }, t);
    expect(ok.state).toBe("ok");
  });

  test("front matter lists in both styles", () => {
    expect(frontMatter("---\nid: a\nsources: [x, 'y']\naliases:\n  - b\n---\n")).toMatchObject({ id: "a", sources: ["x", "y"], aliases: ["b"] });
  });
});

describe("nightly check", () => {
  test("finds incomplete notes, shared ids, broken links, likely duplicates", () => {
    const f = new Map(Object.entries({
      "areas/farm/notes/soil-profile.md": note("soil") + "[see](missing.md)",
      "areas/farm/notes/soil-profile-2026.md": note("soil"),
      "areas/farm/notes/bad.md": "no front matter",
      "areas/farm/open.md": "[ok](notes/bad.md)",
    }));
    const kinds = hygiene(f).map((x) => x.kind).sort();
    expect(kinds).toEqual(["broken link", "incomplete note", "possible duplicate", "same id"]);
  });
});

// End to end against a real git repo standing in for GitHub.
function sh(cmd: string[], cwd: string) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

describe("record keeper, end to end", () => {
  let root: string, cfg: Config, seed: string;
  const g = (cwd: string, ...a: string[]) => sh(["git", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", ...a], cwd);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "record-"));
    const remote = join(root, "remote.git");
    sh(["git", "init", "--quiet", "--bare", "-b", "main", remote], root);
    seed = join(root, "seed");
    sh(["git", "-c", "core.autocrlf=false", "clone", "--quiet", "-c", "core.autocrlf=false", remote, seed], root);
    mkdirSync(join(seed, "areas/farm"), { recursive: true });
    writeFileSync(join(seed, "areas/farm/open.md"), "- fence\n");
    g(seed, "add", "-A"); g(seed, "commit", "--quiet", "-m", "seed"); g(seed, "push", "--quiet", "origin", "HEAD:main");
    cfg = { remote, dir: join(root, "pi/record"), queue: join(root, "pi/queue"), outcomes: join(root, "pi/outcomes"),
      relay: join(root, "pi/relay.queue"), branch: "main", hygieneAt: "0230", tz: "America/New_York",
      now: () => new Date("2026-11-08T12:00:00Z") };
    mkdirSync(cfg.queue, { recursive: true });
  });
  const queue = (name: string, req: any) => writeFileSync(join(cfg.queue, name), JSON.stringify(req));
  const upstream = (p: string) => { g(seed, "pull", "--quiet", "origin", "main"); return existsSync(join(seed, p)) ? readFileSync(join(seed, p), "utf8") : null; };

  test("applies, commits and pushes in order; stale and bad requests come back to Cain", () => {
    queue("1.json", { id: "req-001", from: "cain", kind: "change", summary: "Add gate repair", ops: [
      { op: "put", path: "areas/farm/open.md", content: "- fence\n- gate\n", base: blobSha("- fence\n") }] });
    queue("2.json", { id: "req-002", from: "cain", kind: "change", summary: "Stale edit", ops: [
      { op: "put", path: "areas/farm/open.md", content: "- other\n", base: blobSha("- fence\n") }] });
    queue("3.json", { id: "req-003", from: "cain", kind: "change", summary: "Bad place", ops: [
      { op: "put", path: "CLAUDE.md", content: "x", base: "new" }] });
    const r = cycle(cfg);
    expect(r).toEqual({ applied: 3, ok: true });
    expect(upstream("areas/farm/open.md")).toBe("- fence\n- gate\n");
    expect(readdirSync(cfg.queue)).toEqual([]);
    const outcomes = readFileSync(join(seed, "log/requests/2026-11.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).state);
    expect(outcomes).toEqual(["done", "conflict", "rejected"]);
    const relayed = readFileSync(cfg.relay, "utf8");
    expect(relayed).toContain("req-002");
    expect(relayed).toContain("req-003");
    expect(sh(["git", "log", "--format=%s", "-1", "--skip=2"], seed)).toContain("Add gate repair (request req-001, from cain)");
  });

  test("a note from Dane's page in inbox/ goes to Cain and leaves the inbox", () => {
    mkdirSync(join(seed, "inbox"), { recursive: true });
    writeFileSync(join(seed, "inbox/20261108-n1.json"), JSON.stringify({ id: "page-n1", from: "page", kind: "note", summary: "Note on fencing", note: { text: "Gate is done", about: "areas/farm/open.md" } }));
    g(seed, "add", "-A"); g(seed, "commit", "--quiet", "-m", "note"); g(seed, "push", "--quiet", "origin", "HEAD:main");
    cycle(cfg);
    expect(upstream("inbox/20261108-n1.json")).toBeNull();
    expect(readFileSync(cfg.relay, "utf8")).toContain("Dane's page sent a note about areas/farm/open.md (request page-n1). His words, as typed: «Gate is done»");
  });

  test("only page notes in inbox/ reach Cain; nothing in inbox/ speaks for Cain; no id twice", () => {
    mkdirSync(join(seed, "inbox"), { recursive: true });
    writeFileSync(join(seed, "inbox/a.json"), JSON.stringify({ id: "lap-n1", from: "laptop", kind: "note", summary: "s", note: { text: "do X" } }));
    writeFileSync(join(seed, "inbox/b.json"), JSON.stringify({ id: "cain-fake1", from: "page", kind: "note", summary: "s", note: { text: "do Y" } }));
    g(seed, "add", "-A"); g(seed, "commit", "--quiet", "-m", "x"); g(seed, "push", "--quiet", "origin", "HEAD:main");
    queue("1.json", { id: "cain-n2", from: "cain", kind: "note", summary: "s", note: { text: "do Z" } });
    cycle(cfg);
    const heard = existsSync(cfg.relay) ? readFileSync(cfg.relay, "utf8") : "";
    expect(heard).not.toContain("Dane's page sent a note");
    expect(heard).not.toContain("A change Dane made");
    const states = upstream("log/requests/2026-11.jsonl")!.trim().split("\n").map((l) => JSON.parse(l).state);
    expect(states).toEqual(["rejected", "rejected", "rejected"]);
    // The same request again (say the reply to a push was lost): not applied twice.
    const req = { id: "cain-a1", from: "cain", kind: "change", summary: "Add", ops: [{ op: "append", path: "areas/farm/open.md", text: "- hay" }] };
    queue("2.json", req); cycle(cfg);
    queue("3.json", req); cycle(cfg);
    expect(upstream("areas/farm/open.md")).toBe("- fence\n- hay\n");
    expect(readdirSync(cfg.queue)).toEqual([]);
  }, 30_000);

  test("a link committed into the record can't be written through, and half-written files wait", () => {
    queue(".4.json", { id: "cain-tmp1", from: "cain", kind: "change", summary: "s", ops: [{ op: "append", path: "areas/farm/open.md", text: "x" }] });
    expect(cycle(cfg).applied).toBe(0);
    rmSync(join(cfg.queue, ".4.json"));
    // Commit a link (mode 120000) at areas/home/cfg pointing outside the record.
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(root, "target.txt"), outside);
    const blob = g(seed, "hash-object", "-w", join(root, "target.txt"));
    g(seed, "update-index", "--add", "--cacheinfo", `120000,${blob},areas/home/cfg`);
    g(seed, "commit", "--quiet", "-m", "link"); g(seed, "push", "--quiet", "origin", "HEAD:main");
    queue("5.json", { id: "cain-link1", from: "cain", kind: "change", summary: "Through the link", ops: [
      { op: "put", path: "areas/home/cfg/settings.json", content: "{}", base: "new" }] });
    expect(cycle(cfg).ok).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    const last = readFileSync(join(cfg.outcomes, "cain-link1.json"), "utf8");
    expect(JSON.parse(last).state).toBe("rejected");
  });

  test("keeps up when someone else pushed first", () => {
    cycle(cfg);   // makes the Pi's copy
    writeFileSync(join(seed, "areas/farm/decisions.md"), "- 2026-11-08 keep the ram\n");
    g(seed, "add", "-A"); g(seed, "commit", "--quiet", "-m", "laptop"); g(seed, "push", "--quiet", "origin", "HEAD:main");
    queue("1.json", { id: "req-010", from: "cain", kind: "change", summary: "Decision", ops: [
      { op: "append", path: "areas/farm/decisions.md", text: "- 2026-11-08 order hay" }] });
    expect(cycle(cfg).ok).toBe(true);
    expect(upstream("areas/farm/decisions.md")).toBe("- 2026-11-08 keep the ram\n- 2026-11-08 order hay\n");
  });

  test("nightly check writes its report once and tells Cain", () => {
    mkdirSync(join(seed, "areas/farm/notes"), { recursive: true });
    writeFileSync(join(seed, "areas/farm/notes/x.md"), "no front matter\n");
    g(seed, "add", "-A"); g(seed, "commit", "--quiet", "-m", "x"); g(seed, "push", "--quiet", "origin", "HEAD:main");
    expect(nightly(cfg)).toBe(true);
    expect(upstream("state/record-check.md")).toContain("incomplete note");
    const commits = sh(["git", "rev-list", "--count", "HEAD"], seed);
    nightly(cfg);
    g(seed, "pull", "--quiet", "origin", "main");
    expect(sh(["git", "rev-list", "--count", "HEAD"], seed)).toBe(commits);   // unchanged report: no new commit
  });
});
