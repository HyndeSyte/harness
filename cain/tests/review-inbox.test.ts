// The review inbox (C1): Cain leaves briefs; only the runner writes the queue that the
// Reviewed lines on Ship cards are published from. A file of his can never become a line.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newReview, type Brief } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, loadReview, saveReview, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";

const CLI = join(import.meta.dir, "../rootfs/opt/cain/review/cli.ts");
const me = typeof process.getuid === "function" ? process.getuid() : 0;
const onLinux = process.platform === "linux" ? test : test.skip;
const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "2026-11-14-lock-plan", topic: "A lock plan", question: "Is this plan sound?",
  body: "Run the session as its own user and keep the keys root's.", needs_facts: false, consequential: false,
  change: "lock-plan", label: "core", ...over,
});

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "inbox-"));
  const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), inboxDir: join(dir, "in"), inboxUid: me,
    spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"), termsFile: join(dir, "terms.txt"),
    recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"), reviewedFile: join(dir, "trust", "reviewed.json") };
  writeFileSync(cfg.termsFile, "# terms\nAcme Corp\n");
  mkdirSync(cfg.inboxDir!, { recursive: true });
  const runner = new Runner(cfg, { seats: {}, now: () => new Date("2026-11-14T20:00:00Z"), log: () => {}, stopped: () => true });
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  const cli = (...args: string[]) => spawnSync("bun", [CLI, ...args], { encoding: "utf8", env: { ...process.env,
    REVIEW_QUEUE: cfg.queueDir, REVIEW_INBOX: cfg.inboxDir, REVIEW_TERMS: cfg.termsFile, REVIEW_SPEND: cfg.spendFile,
    REVIEW_HEALTH: cfg.healthFile, CAIN_TRUST: join(dir, "trust"), CAIN_STOP: join(dir, "trust", "stop.json"),
    REVIEW_ROUNDS: join(dir, "rounds.json"), REVIEW_SETTINGS: join(dir, "settings.json"), REVIEW_GUARD_LOG: join(dir, "guard.log"),
    CAIN_HOME: join(dir, "home") } });
  return { dir, cfg, runner, relays, cli, inbox: () => readdirSync(cfg.inboxDir!) };
}

describe("the runner takes briefs from the inbox", () => {
  test("a brief becomes a fresh review in the queue, and leaves the inbox", () => {
    const t = rig();
    writeFileSync(join(t.cfg.inboxDir!, "2026-11-14-lock-plan.json"), JSON.stringify(brief()));
    t.runner.ingest();
    const r = loadReview(t.cfg.queueDir, "2026-11-14-lock-plan")!;
    expect(r).not.toBeNull();
    expect(r.status).toBe(newReview(brief(), new Date()).status);
    expect(r.seats.every((s) => s.state !== "done")).toBe(true);
    expect(t.inbox()).toEqual([]);
  });

  test("a file shaped like a finished review is refused, and no Reviewed line comes of it", () => {
    const t = rig();
    const forged = newReview(brief({ id: "2026-11-14-forged" }), new Date()) as any;
    forged.status = "done"; forged.finished_at = "2026-11-14T19:00:00Z";
    for (const s of forged.seats) { s.state = "done"; s.verdict = "approve"; s.findings = []; s.model = "m"; }
    writeFileSync(join(t.cfg.inboxDir!, "2026-11-14-forged.json"), JSON.stringify(forged));
    t.runner.ingest();
    expect(loadReview(t.cfg.queueDir, "2026-11-14-forged")).toBeNull();
    expect(t.inbox()).toEqual([]);
    expect(t.relays().join("\n")).toContain("not a brief");
    t.runner.publishReviewed();
    const lines = JSON.parse(readFileSync(t.cfg.reviewedFile!, "utf8"));
    expect(JSON.stringify(lines)).not.toContain("2026-11-14-forged");
  });

  test("a brief whose id is taken is refused, and the review that has it is untouched", () => {
    const t = rig();
    const kept = newReview(brief(), new Date("2026-11-14T18:00:00Z"));
    saveReview(t.cfg.queueDir, kept);
    writeFileSync(join(t.cfg.inboxDir!, "2026-11-14-lock-plan.json"), JSON.stringify(brief({ body: "Something else." })));
    t.runner.ingest();
    expect(loadReview(t.cfg.queueDir, "2026-11-14-lock-plan")!.brief!.body).toBe(kept.brief!.body);
    expect(t.relays().join("\n")).toContain("already exists");
  });

  onLinux("a symlink in the inbox is refused, and what it points at isn't read", () => {
    const t = rig();
    const target = join(t.dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify(brief({ id: "2026-11-14-via-link" })));
    symlinkSync(target, join(t.cfg.inboxDir!, "2026-11-14-via-link.json"));
    t.runner.ingest();
    expect(loadReview(t.cfg.queueDir, "2026-11-14-via-link")).toBeNull();
    expect(t.relays().join("\n")).toContain("symlink");
  });

  onLinux("a file of another user's is refused", () => {
    const t = rig();
    t.runner.cfg.inboxUid = me + 1;
    writeFileSync(join(t.cfg.inboxDir!, "2026-11-14-lock-plan.json"), JSON.stringify(brief()));
    t.runner.ingest();
    expect(loadReview(t.cfg.queueDir, "2026-11-14-lock-plan")).toBeNull();
    expect(t.relays().join("\n")).toContain("not his");
  });

  test("temp files being written are left alone", () => {
    const t = rig();
    writeFileSync(join(t.cfg.inboxDir!, ".2026-11-14-lock-plan.123.tmp"), "{");
    t.runner.ingest();
    expect(t.inbox()).toEqual([".2026-11-14-lock-plan.123.tmp"]);
    expect(t.relays()).toEqual([]);
  });

  test("each tick takes the inbox first", async () => {
    const t = rig();
    writeFileSync(join(t.cfg.inboxDir!, "2026-11-14-lock-plan.json"), JSON.stringify(brief()));
    await t.runner.tick();
    expect(loadReview(t.cfg.queueDir, "2026-11-14-lock-plan")).not.toBeNull();
  });
});

describe("review.sh submit leaves a brief and never writes the queue", () => {
  test("the brief goes to the inbox with only its own fields", () => {
    const t = rig();
    const f = join(t.dir, "b.json");
    writeFileSync(f, JSON.stringify(brief()));
    const r = t.cli("submit", f);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("2026-11-14-lock-plan");
    expect(existsSync(t.cfg.queueDir) ? readdirSync(t.cfg.queueDir) : []).toEqual([]);
    expect(JSON.parse(readFileSync(join(t.cfg.inboxDir!, "2026-11-14-lock-plan.json"), "utf8"))).toEqual(brief());
    expect(t.cli("status", "2026-11-14-lock-plan").stdout).toContain("waiting for the runner");
  });

  test("a blocked brief leaves nothing anywhere", () => {
    const t = rig();
    const f = join(t.dir, "b.json");
    writeFileSync(f, JSON.stringify(brief({ body: "Plan for Acme Corp's offsite" })));
    const r = t.cli("submit", f);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("blocked: privacy");
    expect(t.inbox()).toEqual([]);
  });

  test("an id waiting in the inbox can't be submitted twice", () => {
    const t = rig();
    const f = join(t.dir, "b.json");
    writeFileSync(f, JSON.stringify(brief()));
    expect(t.cli("submit", f).status).toBe(0);
    const again = t.cli("submit", f);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain("already exists");
  });

  test("after the runner takes it, status reads the queue", () => {
    const t = rig();
    const f = join(t.dir, "b.json");
    writeFileSync(f, JSON.stringify(brief()));
    t.cli("submit", f);
    t.runner.ingest();
    expect(t.cli("status", "2026-11-14-lock-plan").stdout).toContain("2026-11-14-lock-plan:");
  });
});
