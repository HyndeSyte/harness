// The switch to the new way (C1 plan 3.12) and its contract: the journal's rules, the retry
// limit, who may call the link in each state, what uid 1000 may read, the backup's manifest,
// the secret values searched for, and the keys (the old relay key signs nothing).
import { describe, expect, test } from "bun:test";
import { chmodSync, lutimesSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { type LinkMode, linkDecides, RUNS } from "../rootfs/opt/cain/c1/contract";
import { filesUnder, holding, journalStep, manifest, mayRetry, readableFiles, secretValues } from "../rootfs/opt/cain/c1/tools";
import { checkRequest, CAIN_ROUTES, SIG_CONTEXT, signRequest } from "../rootfs/opt/cain/link/auth";

const posix = process.platform !== "win32";
const T = "2026-11-14T12:00:00Z";
const CID = "0b8a5f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b:123456";

describe("the journal", () => {
  test("its steps, each once and in order, give the last one", () => {
    expect(journalStep(`begin ${CID} ${T}\n`)).toBe("begin");
    expect(journalStep(`begin ${CID} ${T}\nlocked ${T}\nstaged ${T}\nscrubbed 2 0 ${T}\nvalidated ${T}\ncommit ${T}\n`)).toBe("commit");
    expect(journalStep(`begin ${CID} ${T}\nlocked ${T}\nstaged ${T}\nscrubbed 0 0 ${T}\nvalidated ${T}\ncommit ${T}\ncommitted ${T}\n`)).toBe("committed");
  });
  test("anything else is bad, and the state is then stopped", () => {
    expect(journalStep("")).toBe("bad");
    expect(journalStep(`locked ${T}\n`)).toBe("bad");                                   // no begin
    expect(journalStep(`begin ${CID} ${T}\nstaged ${T}\n`)).toBe("bad");               // a step skipped
    expect(journalStep(`begin ${CID} ${T}\nlocked ${T}\nlocked ${T}\n`)).toBe("bad");  // twice
    expect(journalStep(`begin ${CID} ${T}\ncommit now\n`)).toBe("bad");                 // no time
    expect(journalStep(`begin ${CID} ${T}\nrm -rf / ${T}\n`)).toBe("bad");
  });
});

describe("tries", () => {
  const at = (h: number) => new Date(Date.parse(T) + h * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  test("three failures wait six hours from the last, across restarts (the file is on /data)", () => {
    expect(mayRetry("", Date.parse(T))).toBe(true);
    expect(mayRetry(`${at(0)} x\n${at(1)} y\n`, Date.parse(at(1)))).toBe(true);
    const three = `${at(0)} x\n${at(1)} y\n${at(2)} z\n`;
    expect(mayRetry(three, Date.parse(at(7)))).toBe(false);
    expect(mayRetry(three, Date.parse(at(8)))).toBe(true);
  });
});

describe("the contract (3.12): one answer per state and caller", () => {
  const base = { signed: false, relayKey: false, cainKey: false, local: false, path: "/card" };
  const modes: LinkMode[] = ["old", "own", "stopped"];
  test("a signed request is the specialist's in every state", () => {
    for (const m of modes) expect(linkDecides(m, { ...base, signed: true })).toEqual({ caller: "specialist" });
  });
  test("the specialist's bare key: 503 and nothing done, in every state, for every route", () => {
    for (const m of modes) for (const path of ["/card", "/buttons", "/answer", "/relay", "/card-of", "/show", "/sent"])
      expect(linkDecides(m, { ...base, relayKey: true, path })).toEqual({ refuse: 503 });
  });
  test("the relay key from this machine opens Cain's routes and /sent only in the old way", () => {
    for (const path of CAIN_ROUTES) {
      expect(linkDecides("old", { ...base, relayKey: true, local: true, path })).toEqual({ caller: "cain" });
      expect(linkDecides("own", { ...base, relayKey: true, local: true, path })).toEqual({ refuse: 503 });
      expect(linkDecides("stopped", { ...base, relayKey: true, local: true, path })).toEqual({ refuse: 503 });
    }
    expect(linkDecides("old", { ...base, relayKey: true, local: true, path: "/sent" })).toEqual({ caller: "root" });
    expect(linkDecides("old", { ...base, relayKey: true, local: true, path: "/card" })).toEqual({ refuse: 503 });
  });
  test("Cain's own key opens his routes from this machine, in the new way only", () => {
    expect(linkDecides("own", { ...base, cainKey: true, local: true, path: "/ask" })).toEqual({ caller: "cain" });
    expect(linkDecides("own", { ...base, cainKey: true, local: false, path: "/ask" })).toEqual({ refuse: 403 });
    expect(linkDecides("old", { ...base, cainKey: true, local: true, path: "/ask" })).toEqual({ refuse: 403 });
    expect(linkDecides("stopped", { ...base, cainKey: true, local: true, path: "/ask" })).toEqual({ refuse: 403 });
  });
  test("nothing proven: refused", () => {
    for (const m of modes) expect(linkDecides(m, { ...base, local: true })).toEqual({ refuse: 403 });
  });
  test("what runs in each state", () => {
    expect(RUNS.A).toMatchObject({ oldRootSession: true, uid1000: "none", link: "old" });
    expect(RUNS.B).toMatchObject({ oldRootSession: false, uid1000: "validation", broker: "smoke", link: null });
    expect(RUNS.C).toMatchObject({ oldRootSession: false, uid1000: "cain", broker: "real", link: "own" });
    expect(RUNS.stopped).toMatchObject({ oldRootSession: false, uid1000: "none", link: "stopped" });
  });
});

describe("the keys (3.9)", () => {
  const TOKEN = "test-bot-token-1234567890";
  const K_LEGACY = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
  const K_SIGN = createHmac("sha256", TOKEN).update(SIG_CONTEXT).digest("hex");
  test("the vectors both languages share (tests/test_c1_transition.py)", () => {
    expect(K_LEGACY).toBe("636dcdfdc711234bb9fbc23475329e9e677ff695800ccea0035729b2ed4c1f43");
    expect(K_SIGN).toBe("c04290ba7e3e31a6ec5a22a087eb898518b103206b9ec54b604d976972306b73");
  });
  test("a request signed with the old key, captured from an old Harness, is refused", () => {
    const now = 1_794_686_000_000;
    const h = signRequest(K_LEGACY, "POST", "/card", '{"text":"x"}', now);
    expect(checkRequest(h, K_SIGN, "POST", "/card", '{"text":"x"}', now)).toBeNull();
    expect(checkRequest(signRequest(K_SIGN, "POST", "/card", '{"text":"x"}', now), K_SIGN, "POST", "/card", '{"text":"x"}', now)).not.toBeNull();
  });
});

describe("the secret values searched for", () => {
  test("the token and its relay key, the App's keys, the Ship and deploy keys line by line, the ChatGPT sign-in", () => {
    const d = mkdtempSync(join(tmpdir(), "c1-secrets-"));
    mkdirSync(join(d, "link")); mkdirSync(join(d, "codex"));
    writeFileSync(join(d, "link/discord.env"), "DISCORD_BOT_TOKEN=test-bot-token-1234567890\n");
    writeFileSync(join(d, "options.json"), JSON.stringify({ github_token: "ghp_abcdefghijklmnopqrstuvwxyz0123", gemini_api_key: "", timezone: "America/New_York" }));
    const body = "Q".repeat(64);
    writeFileSync(join(d, "link/ship.key"), `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`);
    writeFileSync(join(d, "codex/auth.json"), JSON.stringify({ tokens: { access_token: "z".repeat(40), note: "short" } }));
    const v = secretValues(d, join(d, "no-s6"));
    expect(v).toContain("test-bot-token-1234567890");
    expect(v).toContain(createHmac("sha256", "test-bot-token-1234567890").update("harness-relay-v1").digest("hex"));
    expect(v).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(v).toContain(body);
    expect(v).toContain("z".repeat(40));
    expect(v).not.toContain("America/New_York");
    expect(v.some((x) => x.startsWith("-----"))).toBe(false);
    expect(v).toContain(createHmac("sha256", "test-bot-token-1234567890").update("harness-link-sign-v2").digest("hex"));   // K_sign
    expect(v).not.toContain(createHmac("sha256", "test-bot-token-1234567890").update("harness-handover-v1").digest("hex"));   // his by design
  });
  test("fail closed: a source that can't be read or parsed stops the search, it never shrinks it (C1-4)", () => {
    const base = () => {
      const d = mkdtempSync(join(tmpdir(), "c1-secrets-"));
      mkdirSync(join(d, "link"));
      writeFileSync(join(d, "link/discord.env"), "DISCORD_BOT_TOKEN=test-bot-token-1234567890\n");
      writeFileSync(join(d, "options.json"), JSON.stringify({ github_token: "ghp_abcdefghijklmnopqrstuvwxyz0123" }));
      return d;
    };
    let d = base();
    writeFileSync(join(d, "options.json"), '{"github_token": "ghp_abcdefghijklmnopqrstuvwxyz0123"');   // cut short
    expect(() => secretValues(d, join(d, "no-s6"))).toThrow(/options.json/);
    d = base();
    rmSync(join(d, "options.json"));
    expect(() => secretValues(d, join(d, "no-s6"))).toThrow(/options.json/);
    d = base();
    rmSync(join(d, "link/discord.env"));
    expect(() => secretValues(d, join(d, "no-s6"))).toThrow(/bot token/);
    d = base();
    mkdirSync(join(d, "codex")); writeFileSync(join(d, "codex/auth.json"), "{oops");
    expect(() => secretValues(d, join(d, "no-s6"))).toThrow(/codex/);
  });
  test("a file holding one is found, one without isn't", () => {
    const d = mkdtempSync(join(tmpdir(), "c1-scan-"));
    writeFileSync(join(d, "a.jsonl"), `{"x": "before ${"s3cret-value-abcdefgh"} after"}\n`);
    writeFileSync(join(d, "b.jsonl"), "nothing here\n");
    expect(holding(["s3cret-value-abcdefgh", ""], [join(d, "a.jsonl"), join(d, "b.jsonl")])).toEqual([join(d, "a.jsonl")]);
  });
});

describe.skipIf(!posix || process.getuid?.() === 0)("a folder that can't be listed stops the check (C1-4; POSIX, not as root)", () => {
  test("readable and the scan's own listing both throw, never skip it", () => {
    const d = mkdtempSync(join(tmpdir(), "c1-eacces-"));
    chmodSync(d, 0o755);
    mkdirSync(join(d, "nested")); writeFileSync(join(d, "nested/secret"), "x"); chmodSync(join(d, "nested"), 0o000);
    try {
      expect(() => readableFiles([d])).toThrow();
      expect(() => filesUnder([d])).toThrow();
    } finally { chmodSync(join(d, "nested"), 0o755); }
  });
});

describe.skipIf(!posix)("what uid 1000 can read, by owners and modes (POSIX)", () => {
  test("a file open to others under folders he can search; nothing behind a closed folder", () => {
    const d = mkdtempSync(join(tmpdir(), "c1-read-"));
    chmodSync(d, 0o755);
    mkdirSync(join(d, "open")); chmodSync(join(d, "open"), 0o755);
    mkdirSync(join(d, "closed")); chmodSync(join(d, "closed"), 0o700);
    writeFileSync(join(d, "open/yes"), "x"); chmodSync(join(d, "open/yes"), 0o644);
    writeFileSync(join(d, "open/no"), "x"); chmodSync(join(d, "open/no"), 0o600);
    writeFileSync(join(d, "closed/hidden"), "x"); chmodSync(join(d, "closed/hidden"), 0o644);
    const got = readableFiles([d]);
    expect(got).toContain(join(d, "open/yes"));
    expect(got).not.toContain(join(d, "open/no"));
    expect(got).not.toContain(join(d, "closed/hidden"));
  });
});

describe.skipIf(!posix)("the backup's manifest (POSIX)", () => {
  const tree = (link: string, mode = 0o644) => {
    const d = mkdtempSync(join(tmpdir(), "c1-tree-"));
    writeFileSync(join(d, "one"), "same"); writeFileSync(join(d, "two"), "same");
    chmodSync(join(d, "one"), mode);
    symlinkSync(link, join(d, "pointer"));
    lutimesSync(join(d, "pointer"), 1_700_000_000, 1_700_000_000);
    for (const f of ["one", "two", ""]) utimesSync(join(d, f), 1_700_000_000, 1_700_000_000);
    return d;
  };
  test("links to different files with the same content differ", () => {
    expect(manifest(tree("one"))).not.toEqual(manifest(tree("two")));
  });
  test("a link out of the tree is kept as a link, not followed", () => {
    expect(manifest(tree("/etc/hostname")).some((e) => e.includes("/etc/hostname"))).toBe(true);
  });
  test("the same files with another mode differ; the same everything is the same", () => {
    expect(manifest(tree("one", 0o600))).not.toEqual(manifest(tree("one", 0o644)));
    expect(manifest(tree("one"))).toEqual(manifest(tree("one")));
  });
});
