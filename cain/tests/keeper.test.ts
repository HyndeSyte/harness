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
  test.skipIf(!ready)("card, check, replay, connector and ship reach /look, /check, /replay, /connector and /ship, keyed", async () => {
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
      // The Ship card (0.11.0): --review goes through to /ship; left out, there's none.
      const pr = "https://github.com/HyndeSyte/harness/pull/64", head = "a".repeat(40);
      await keeper("ship", "--item", "P64", "--pr", pr, "--head", head, "--review", "2026-11-14-ship-cards", "Stop stays in reach.");
      await keeper("ship", "--item", "P64", "--pr", pr, "--head", head, "Stop stays in reach.");
      expect(seen).toEqual([
        { path: "/look", keyed: true, body: { m: "1234567890123456789" } },
        { path: "/check", keyed: true, body: { text: "Tap Undo if it's wrong.", reply_to: "1234567890123456789" } },
        { path: "/check", keyed: true, body: { text: "Fixed.", edit: "99999999999999999" } },
        { path: "/replay", keyed: true, body: { days: 14 } },
        { path: "/replay", keyed: true, body: { days: 30 } },
        { path: "/connector", keyed: true, body: { item: "P41", text: "Installing Harness 0.22.0" } },
        { path: "/show", keyed: true, body: { item: "none", id: 17 } },
        { path: "/ship", keyed: true, body: { item: "P64", text: "Stop stays in reach.", pr, head, review: "2026-11-14-ship-cards" } },
        { path: "/ship", keyed: true, body: { item: "P64", text: "Stop stays in reach.", pr, head } },
      ]);
      expect(await keeper("ship", "--item", "P64", "--review")).toMatchObject({ code: 2 });   // a flag needs its value
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

  test("ship takes --review and sends it as review, only when given (read here too, for where jq is missing)", async () => {
    const text = (await Bun.file(KEEPER).text()).replace(/\r\n/g, "\n");
    expect(text).toContain("--item|--question|--reply-to|--pr|--head|--edit|--review)");
    expect(text).toContain('--review) review="$2" ;;');
    expect(text).toMatch(/ship\)\s+body=\$\(jq -nc [^\n]*--arg v "\$review" \\\n\s+"\$meta"' \+ \{text: \$t, pr: \$p, head: \$h\} \+ opt\("review"; \$v\)'\) ;;/);
    expect(text).toContain("keeper.sh ship --item P41 --pr <pull request url> --head <full sha> [--review <review id>]");
  });

  test.skipIf(!ready)("handover passes the message it rests on, and no command prints usage, handing nothing over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["4242"], groups: {} }));
    const key = createHmac("sha256", TOKEN).update("harness-handover-v1").digest("hex");
    const seen: { path: string; keyed: boolean; body: any }[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      seen.push({ path: new URL(req.url).pathname, keyed: req.headers.get("x-harness-key") === key, body: JSON.parse(await req.text()) });
      return Response.json({ status: "card" });
    } });
    const env = { ...process.env, CAIN_HARNESS: `http://127.0.0.1:${server.port}`, CAIN_KEEPER_TEST: "1", CAIN_DISCORD_DIR: dir };
    const keeper = async (...args: string[]) => {
      const p = Bun.spawn(["bash", KEEPER, ...args], { env, stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      const err = (await new Response(p.stderr).text()).trim();
      return { code: await p.exited, out, err };
    };
    try {
      await keeper("handover", "--message", "1439000000000000002", "Wednesday drop-off at 8:15 from now on");
      await keeper("handover", "Dentist Thu Nov 12 2 PM, from the office's email");
      await keeper("handover");
      expect(seen).toEqual([
        { path: "/handover", keyed: true, body: { suggestion: "Wednesday drop-off at 8:15 from now on", paired: "4242", message: "1439000000000000002" } },
        { path: "/handover", keyed: true, body: { suggestion: "Dentist Thu Nov 12 2 PM, from the office's email", paired: "4242" } },
        { path: "/handover", keyed: true, body: { suggestion: "", paired: "4242" } },
      ]);
      const none = await keeper();
      expect(none.code).toBe(2);
      expect(none.out).toContain("keeper.sh handover [--message <id>] [suggestion]");
      expect(await keeper("handover", "--message")).toMatchObject({ code: 2 });          // a flag needs its value
      expect(await keeper("handover", "--message", "P31")).toMatchObject({ code: 2 });   // digits only
      expect(seen.length).toBe(3);                                                        // none of those handed over
      // Cain's answer to a question the specialist sent him: a note on the same message.
      await keeper("handover", "--message", "1439000000000000002", "It's the 8:00 drop-off, on his Gmail");
      expect(seen[3]).toEqual({ path: "/handover", keyed: true,
        body: { suggestion: "It's the 8:00 drop-off, on his Gmail", paired: "4242", message: "1439000000000000002" } });
      // The override is in use only with the test flag, and says so.
      expect((await keeper("handover", "--message", "1439000000000000002")).err).toContain("test override in use");
      expect(seen.length).toBe(5);
    } finally { server.stop(true); }
  }, 30_000);

  test.skipIf(!ready)("the specialist's address moves only with the test flag, and an ignored one is logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["4242"], groups: {} }));
    let hits = 0;
    const server = Bun.serve({ port: 0, fetch() { hits++; return Response.json({ status: "card" }); } });
    const base = { ...process.env, CAIN_HARNESS: `http://127.0.0.1:${server.port}`, CAIN_DISCORD_DIR: dir };
    delete (base as any).CAIN_KEEPER_TEST;
    try {
      const p = Bun.spawn(["bash", KEEPER, "handover", "--message", "1439000000000000002"],
        { env: base, stdout: "pipe", stderr: "pipe" });
      const err = (await new Response(p.stderr).text()).trim();
      await p.exited;
      expect(hits).toBe(0);                          // not sent to the address in the environment
      expect(err).toContain("CAIN_HARNESS ignored");
      const text = (await Bun.file(KEEPER).text()).replace(/\r\n/g, "\n");
      expect(text).toContain('harness="http://0fcc2575-harness:8098"');
      expect(text).toContain('if [ "${CAIN_KEEPER_TEST:-}" = 1 ]; then');
    } finally { server.stop(true); }
  }, 30_000);
});
