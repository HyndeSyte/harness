// In the CI image test, in place of Claude Code for the channel smoke test: runs the real
// bridge (/opt/cain/discord/bridge.ts) as Cain's user against the smoke broker's socket, does
// what Claude Code does (initialize, then one reply tool call to his DM), and exits 0 when the
// reply's answer comes back without an error. Root runs this; the bridge runs as cain.
const sock = process.argv[2] ?? "/run/cain/smoke.sock";
const dm = process.argv[3] ?? "100000000000000001";
const bridge = Bun.spawn(["/opt/cain/as-cain", "env", `CAIN_DISCORD_SOCK=${sock}`, "bun", "/opt/cain/discord/bridge.ts"],
  { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const send = (o: unknown) => { bridge.stdin.write(JSON.stringify(o) + "\n"); bridge.stdin.flush(); };
const answers = new Map<number, any>();
(async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const c of bridge.stdout) {
    buf += dec.decode(c, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); if (typeof m.id === "number") answers.set(m.id, m); } catch { /* not JSON */ }
    }
  }
})();
const wait = async (id: number) => { for (let i = 0; i < 300; i++) { if (answers.has(id)) return answers.get(id); await Bun.sleep(100); } return null; };
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } } });
const init = await wait(1);
if (!init?.result) { console.error(`[fake-claude] no initialize answer: ${JSON.stringify(init)}`); process.exit(1); }
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reply", arguments: { chat_id: dm, text: "ok" } } });
const r = await wait(2);
bridge.kill();
if (!r?.result || r.result.isError) { console.error(`[fake-claude] the reply didn't go: ${JSON.stringify(r).slice(0, 300)}`); process.exit(1); }
console.error("[fake-claude] the reply went through the bridge and the broker's gate");
process.exit(0);
