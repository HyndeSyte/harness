// Main's Cain 0.13.0 (the security watch, replies with links through the keeper) brought into the
// own-user build (Cain 0.13.1): the broker's gate holds a plugin reply with a link as the reply hook
// does, and notes it in root's folder; Cain's keeper reaches the key record through the link.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "own-user-013-"));
const before = { t: process.env.CAIN_GATE_TRIES, d: process.env.CAIN_GATE_DM };
process.env.CAIN_GATE_TRIES = join(dir, "tries.json");
process.env.CAIN_GATE_DM = join(dir, "dm.json");
const { gateSend } = await import("../rootfs/opt/cain/discord/gate-call");
const { linkRoutes } = await import("../rootfs/opt/cain/link/http");
const { routeAllowed } = await import("../rootfs/opt/cain/link/auth");
const held = await import("../rootfs/opt/cain/gate/held");
const { readHosts } = await import("../rootfs/opt/cain/gate/hosts");
// Read at import: put back for the files that run after this one (SECURITY_KEYS is read per call).
for (const [k, v] of [["CAIN_GATE_TRIES", before.t], ["CAIN_GATE_DM", before.d]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

const DM = "100000000000000001";
const view = { written_at: Date.now(), owner: "100000000000000009", dm: DM, cards: [], sent: [] };
const deps = (cards: () => Promise<any>, heldFile: string) => ({
  cards, cardsFile: () => null, replied: () => new Set<string>(), log: async () => {}, hosts: () => new Set<string>(), held: heldFile,
});

describe("the broker's gate: a reply with a link, as the reply hook decides it", () => {
  test("held for keeper.sh reply while the link answers, and the hold noted", async () => {
    const f = join(dir, "held-1.json");
    const v = await gateSend("reply", { chat_id: DM, text: "Here it is: https://example.com/page" }, "s1", deps(async () => view, f));
    expect(v.kind).toBe("refuse");
    expect(held.readAt(f)).not.toBeNull();
  });
  test("goes as it is while the link doesn't answer, and nothing is noted", async () => {
    const f = join(dir, "held-2.json");
    const v = await gateSend("reply", { chat_id: DM, text: "Here it is: https://example.com/other" }, "s2", deps(async () => { throw new Error("down"); }, f));
    expect(v.kind).not.toBe("refuse");
    expect(existsSync(f)).toBe(false);
  });
  test("the notes live in root's folder, never in his /data/work", () => {
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/gate/held.ts"), "utf8");
    expect(src).toContain('"/data/link/link-held.json"');
    expect(src).toContain('"/data/link/keeper-reply.json"');
  });
});

describe("the gate's host list, a file of his that root reads", () => {
  test("read as his own files are: never through a symlink", () => {
    const real = join(dir, "real-hosts.txt"), link = join(dir, "hosts-link.txt");
    writeFileSync(real, "example.org\n");
    symlinkSync(real, link);
    expect(readHosts(link).has("example.org")).toBe(false);
  });
});

describe("keeper.sh key-expiry and key-ack as his own user: the link's /key-note", () => {
  test("Cain's route, not the specialist's", () => {
    expect(routeAllowed("cain", "/key-note")).toBe(true);
    expect(routeAllowed("cain", "/reply")).toBe(true);
    expect(routeAllowed("specialist", "/key-note")).toBe(false);
    expect(routeAllowed("specialist", "/reply")).toBe(false);
  });
  test("writes the note on the key record, and refuses a name it doesn't know", async () => {
    process.env.SECURITY_KEYS = join(dir, "keys.json");
    writeFileSync(join(dir, "keys.json"), JSON.stringify({ version: 1, keys: { github_token: { hash: "a".repeat(64), first_seen: "2026-11-01", present: true } } }));
    const route = linkRoutes({ link: {} as any, toHarness: async () => true });
    const post = (b: unknown) => { const raw = JSON.stringify(b); const req = new Request("http://x/key-note", { method: "POST", body: raw });
      return route(req, new URL(req.url), "cain", raw); };
    const ok = await post({ cmd: "key-expiry", name: "github_token", date: "2027-01-31" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("ok");
    expect(readFileSync(join(dir, "keys.json"), "utf8")).toContain("2027-01-31");
    const bad = await (await post({ cmd: "key-expiry", name: "no_such_key", date: "2027-01-31" })).json();
    expect(bad.status).toBe("error");
    const wrong = await (await post({ cmd: "rm", name: "github_token", date: "" })).json();
    expect(wrong.status).toBe("error");
    delete process.env.SECURITY_KEYS;
  });
});
