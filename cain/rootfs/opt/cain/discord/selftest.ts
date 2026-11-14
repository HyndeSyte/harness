// The broker's gate, checked once at each start the new way (C1): the real BrokerSession and
// the real gate (gate-call.ts), with a stand-in server that sends nothing, on a fix ("add-on"),
// two refusals (an em dash; "and 3 more"), a clean reply, and an edit of a message that isn't
// his (a hard refusal). Its own files for the gate's tries and log, so nothing real is touched.
// Prints one line of JSON: {status, said, ms}. With --relay, a failure is also put in Cain's
// relay queue, so he hears.
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(process.env.CAIN_ROOT_TMP ?? tmpdir(), "gate-selftest-"));
process.env.CAIN_GATE_TRIES = join(dir, "tries.json");
process.env.CAIN_GATE_DM = join(dir, "dm.json");
process.env.CAIN_GATE_LOG = join(dir, "gate.jsonl");
const { BrokerSession } = await import("./broker");
const { gateSend } = await import("./gate-call");

const DM = "100000000000000001", MSG = "100000000000000002";
const forwarded: any[] = [], answered: any[] = [];
const session = new BrokerSession({
  toClient: (l) => answered.push(JSON.parse(l)),
  toServer: (l) => { const m = JSON.parse(l); forwarded.push(m); session.fromServer(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "sent (id: 100000000000000003)" }] } })); },
  close: () => {},
  // His DM known, no cards up, none of his replies: as a quiet day looks to the gate.
  gate: (tool, args, s) => gateSend(tool, args, s, { cards: async () => ({ written_at: Date.now(), owner: "100000000000000009", dm: DM, cards: [], sent: [] }),
    cardsFile: () => null, replied: () => new Set(), log: async () => {} }),
  sent: () => {},
  readsOk: () => "",
  outbox: { make: () => ({ dir: "", paths: [] }), drop: () => {} },
  log: () => {},
  session: "selftest",
});

const t0 = performance.now();
const call = (id: number, name: string, args: Record<string, unknown>) =>
  session.fromClient(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
await call(1, "reply", { chat_id: DM, text: "Restarted the add-on." });
await call(2, "reply", { chat_id: DM, text: "Monday \u2014 Friday" });
await call(3, "reply", { chat_id: DM, text: "Two blocks moved and 3 more." });
await call(4, "reply", { chat_id: DM, text: "Done." });
await call(5, "edit_message", { chat_id: DM, message_id: MSG, text: "Done." });
const ms = Math.round((performance.now() - t0) / 5);

const byId = (id: number) => answered.find((a) => a.id === id);
const sentText = (id: number) => forwarded.find((f) => f.id === id)?.params?.arguments?.text;
const problems: string[] = [];
if (sentText(1) !== "Restarted the App.") problems.push(`"add-on" wasn't fixed (sent: ${JSON.stringify(sentText(1))})`);
if (!byId(2)?.result?.isError || forwarded.some((f) => f.id === 2)) problems.push("an em dash wasn't held");
if (!byId(3)?.result?.isError || forwarded.some((f) => f.id === 3)) problems.push(`"and 3 more" wasn't held`);
if (sentText(4) !== "Done.") problems.push("a clean reply didn't go");
if (!byId(5)?.result?.isError || forwarded.some((f) => f.id === 5)) problems.push("an edit of a message that isn't his wasn't refused");

const out = problems.length
  ? { status: "failed", said: `The message gate in the broker failed its self-test: ${problems.join("; ")}.`, ms }
  : { status: "ok", said: `The message gate in the broker passed its self-test: it fixes "add-on" in place, holds back an em dash and "and 3 more", lets a clean reply go, and refuses an edit of a message that isn't his, in about ${ms} ms a send.`, ms };
console.log(JSON.stringify(out));
if (problems.length && process.argv.includes("--relay"))
  try { appendFileSync(process.env.RELAY_QUEUE ?? "/data/relay.queue", JSON.stringify({ text: `${out.said} Every reply now waits on it; log a Build item to fix it. Nothing to tell him unless replies stop going out.` }) + "\n"); } catch { /* the log line above is still there */ }
process.exit(problems.length ? 1 : 0);
