// keeper.sh's piece D commands (card, check, replay, connector) reach the right routes on
// Cain's link with the link's key: keeper.sh run for real against a fake link.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEPER = join(import.meta.dir, "../rootfs/opt/cain/keeper.sh");
const ready = !!Bun.which("bash") && !!Bun.which("jq") && !!Bun.which("curl");
const TOKEN = "not-a-real-token.for-the-keeper-test";

describe("keeper.sh against a fake link", () => {
  test.skipIf(!ready)("card, check, replay and connector reach /look, /check, /replay and /connector, keyed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["4242"], groups: {} }));
    const key = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
    const seen: { path: string; keyed: boolean; body: any }[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      const raw = await req.text();
      let body: any;
      try { body = JSON.parse(raw); } catch { body = { not_json: raw }; }   // shown in the diff, never thrown
      seen.push({ path: new URL(req.url).pathname, keyed: req.headers.get("x-harness-key") === key, body });
      return Response.json({ status: "ok" });
    } });
    const env = { ...process.env, CAIN_LINK: `http://127.0.0.1:${server.port}`, CAIN_DISCORD_DIR: dir };
    // Spawned without blocking: the fake link answers from this same process.
    const keeper = async (...args: string[]) => {
      const p = Bun.spawn(["bash", KEEPER, ...args], { env, stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      return { code: await p.exited, out };
    };
    try {
      expect(await keeper("card", "1234567890123456789")).toEqual({ code: 0, out: '{"status":"ok"}' });
      await keeper("check", "--reply-to", "1234567890123456789", "Tap Undo if it's wrong.");
      await keeper("check", "--edit", "99999999999999999", "Fixed.");
      await keeper("replay");
      await keeper("replay", "30");
      await keeper("connector", "--item", "P41", "Installing Harness 0.22.0");
      await keeper("show", "17", "--item", "none");
      expect(seen).toEqual([
        { path: "/look", keyed: true, body: { m: "1234567890123456789" } },
        { path: "/check", keyed: true, body: { text: "Tap Undo if it's wrong.", reply_to: "1234567890123456789" } },
        { path: "/check", keyed: true, body: { text: "Fixed.", edit: "99999999999999999" } },
        { path: "/replay", keyed: true, body: { days: 14 } },
        { path: "/replay", keyed: true, body: { days: 30 } },
        { path: "/connector", keyed: true, body: { item: "P41", text: "Installing Harness 0.22.0" } },
        { path: "/show", keyed: true, body: { item: "none", id: 17 } },
      ]);
      expect(await keeper("check", "--edit")).toMatchObject({ code: 2 }); // a flag needs its value
    } finally { server.stop(true); }
  }, 30_000);

  test.skipIf(!Bun.which("bash"))("selftest runs the message gate's reply hook on its own, with no key and no link", async () => {
    const hooks = join(import.meta.dir, "../rootfs/opt/cain/hooks");
    const p = Bun.spawn(["bash", KEEPER, "selftest"], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CAIN_HOOKS: hooks, CAIN_SETTINGS: join(import.meta.dir, "../rootfs/opt/cain/settings.json"),
        CAIN_DISCORD_DIR: join(tmpdir(), "no-discord-here") } });
    const out = JSON.parse((await new Response(p.stdout).text()).trim());
    expect(await p.exited).toBe(0);
    expect(out).toMatchObject({ status: "ok", said: expect.stringContaining("passed its self-test") });
  }, 60_000);

  test("its link is the local one unless a test moves it, and card goes to /look (the link's /card is the specialist's)", async () => {
    const text = await Bun.file(KEEPER).text();
    expect(text).toContain('link="${CAIN_LINK:-http://127.0.0.1:8097}"');
    expect(text).toContain('card) url="$link/look"; ctx=harness-relay-v1 ;;');
    expect(text).toContain('dir="${CAIN_DISCORD_DIR:-/data/.claude/channels/discord}"');
  });
});
