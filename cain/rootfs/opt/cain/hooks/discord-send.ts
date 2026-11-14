// Cain's message gate on his own Discord replies and edits (piece D), enforcing since Cain
// 0.10.0: a PreToolUse hook on the plugin's reply and edit_message tools, wired in
// settings.json without "async", so Claude Code waits for it (about 0.3 s a reply; the
// self-test below measures it on the Pi).
//
// What it says, as JSON on stdout with exit 0 (the wiring's `|| true` turns any exit into 0):
//   - nothing: the reply goes as it is;
//   - allow, with the call's whole input and only its text changed: em dashes and
//     "add-on" fixed in place, only when the reply goes to his DM and its input is plain
//     (chat_id, text and reply_to; for an edit, message_id): an allow skips auto mode's own
//     check, so a call carrying anything else (files to attach) gets "send exactly this
//     instead" and then goes through that check. Claude Code's auto mode can refuse an
//     updatedInput that comes without a decision; discord-send.cli.test.ts proves this one
//     against the real CLI;
//   - deny, with what to change: a hidden count, machine text, an em dash between two
//     numbers (or a time and a number) that isn't a clock range, a button the card it
//     answers lacks (or any named button while the cards can't be read), a chat that
//     isn't his DM, or an edit of a message that isn't one of his own replies.
// The cards come first, always (decision F): the link's local route gets 1.5 s, then
// /data/trust/cards.json while it's under 3 minutes old. So every rule runs on every send,
// however slow the link is, and the link's DM id wins over the cached one, rewriting it.
// The cached id counts only when no cards can be had at all: cards that name no DM (the
// link hasn't asked Discord yet, after a new bot token) leave his DM unknown, and a send
// goes, logged, rather than being held against the old bot's DM.
//
// The third try: after two wording refusals for one session and chat within 10 minutes,
// the next try goes as it is, logged "passed after two refusals"; Cain hears it through
// the link (discord-sent.ts). A pass or a fix resets the count. Never for a hard refusal:
// a chat the link says isn't his DM, or an edit of a message that isn't his reply or whose
// owner can't be told. While his DM can't be told the third try goes too, as a clean send
// there does. Counted in /data/work/gate-tries.json; a refusal the count can't be written
// for lets the reply go, logged "passed, tries not counted", since otherwise every try
// would start at zero and the third never come.
//
// It fails open: an error, a crash or a timeout lets the reply go, since silencing Cain is
// worse than one unchecked reply, and discord-sent.ts re-checks what went out.
//
// `bun discord-send.ts --self-test` runs the installed hook command as Claude Code would,
// on a fix, a refusal and a clean reply, and prints one line (the App runs it at start).
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendGate } from "../gate/log";
import { answerText, REPLY_TOOL, SENDS, sentIds } from "../gate/plugin";
import { fixedWhat, type Hit } from "../gate/rules";
import { type CardsView, decideSend, type Decision, type SendCall } from "../gate/send";

export { SENDS };
// Moved only for the tests: the hook runs in the environment Claude Code was started with.
const LINK = process.env.CAIN_LINK ?? "http://127.0.0.1:8097";
const CARDS = process.env.CAIN_CARDS ?? "/data/trust/cards.json";
const ENV = process.env.CAIN_DISCORD_ENV ?? "/data/.claude/channels/discord/.env";
export const TRIES = process.env.CAIN_GATE_TRIES ?? "/data/work/gate-tries.json";
export const DM_FILE = process.env.CAIN_GATE_DM ?? "/data/work/gate-dm.json";
export const STALE_MS = 3 * 60_000;      // a cards file older than this is the link being down
export const LINK_MS = 1_500;            // how long the link gets to answer
export const TRY_MS = 10 * 60_000;       // two refusals within this, and the third try goes
const TRANSCRIPT_TAIL = 2 * 1024 * 1024; // how much of his session's transcript an edit reads back
// Decision A: fixes go out in place. Should Claude Code ever stop applying an allowed
// updatedInput, false makes a fix a refusal that says exactly what to send instead.
export const FIX_IN_PLACE = true;

const SNOWFLAKE = /^\d{15,22}$/;
const id = (v: unknown) => (typeof v === "string" || typeof v === "number") && SNOWFLAKE.test(String(v)) ? String(v) : undefined;

export interface Call extends SendCall { input: Record<string, unknown>; session: string }

// The call Claude Code is about to make, or null when it isn't one of the two sends.
export function callOf(input: any): Call | null {
  const tool = (SENDS as Record<string, "reply" | "edit">)[String(input?.tool_name ?? "")];
  const t = input?.tool_input;
  if (!tool || !t || typeof t !== "object" || Array.isArray(t)) return null;
  const base = { tool, text: String(t.text ?? ""), chat: id(t.chat_id), input: t as Record<string, unknown>, session: String(input?.session_id ?? "") };
  return tool === "reply" ? { ...base, replyTo: id(t.reply_to) } : { ...base, target: id(t.message_id) };
}

// The only keys a call the hook may pre-approve carries.
const PLAIN: Record<"reply" | "edit", readonly string[]> = { reply: ["chat_id", "text", "reply_to"], edit: ["chat_id", "message_id", "text"] };
export const plainInput = (call: Call) => Object.keys(call.input).every((k) => PLAIN[call.tool].includes(k));

// The cards as of now: the link's answer, else its file if it's fresh, else none.
export async function cardsNow(ask: () => Promise<CardsView | null>, file: () => string | null, now: number):
    Promise<{ cards: CardsView | null; from: "link" | "file" | "none" }> {
  try { const c = await ask(); if (c && Array.isArray(c.cards)) return { cards: c, from: "link" }; } catch { /* the link didn't answer */ }
  try {
    const c = JSON.parse(file() ?? "");
    if (Array.isArray(c?.cards) && typeof c.written_at === "number" && now - c.written_at <= STALE_MS) return { cards: c, from: "file" };
  } catch { /* missing or unreadable */ }
  return { cards: null, from: "none" };
}

// The ids the plugin's reply tool answered with in this session, from the end of its
// transcript (Claude Code hands every hook its path): proof that a message is Cain's own
// reply before the PostToolUse hook's word on it reaches the link. Only a reply call's own
// answer counts; no other text in the transcript does.
export function repliedIn(path: unknown, maxBytes = TRANSCRIPT_TAIL): Set<string> {
  const out = new Set<string>();
  if (typeof path !== "string" || !path) return out;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size, from = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const calls = new Set<string>();
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes(REPLY_TOOL) && !(calls.size && line.includes("tool_result"))) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use" && b.name === REPLY_TOOL) calls.add(String(b.id ?? ""));
        else if (b?.type === "tool_result" && calls.has(String(b.tool_use_id ?? ""))) for (const x of sentIds(answerText(b.content))) out.add(x);
      }
    }
  } catch { /* no transcript: no proof */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
  return out;
}

// -- small files of the hook's own: his DM's id, and the tries --------------------------
function writeWhole(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data));
  renameSync(`${path}.tmp`, path);
}

// His DM's channel id, as the link last said it: so a send can be checked even while the
// link and its file are both unavailable. Unknown means a send passes and is logged, never
// refused; one that differs from it alone is a soft refusal.
export function readDm(path = DM_FILE): string | null {
  try { const d = JSON.parse(readFileSync(path, "utf8"))?.dm; return id(d) ?? null; } catch { return null; }
}
export function keepDm(dm: string | null | undefined, path = DM_FILE): void {
  if (!dm || !id(dm) || readDm(path) === dm) return;
  try { writeWhole(path, { dm, at: Date.now() }); } catch { /* the next send tries again */ }
}

// Wording refusals per session and chat: how many, since when; and the texts let through on
// a third try, so discord-sent.ts can tell a let-through from a bypass.
export interface TryRec { n: number; first: number; released?: { hash: string; at: number }[] }
export type Tries = Record<string, TryRec>;
export const textHash = (text: string) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 32);
export const keyOf = (session: string, chat: string | undefined) => `${session}\n${chat ?? ""}`;

export function readTries(path = TRIES): Tries {
  try { const t = JSON.parse(readFileSync(path, "utf8")); return t && typeof t === "object" && !Array.isArray(t) ? t : {}; } catch { return {}; }
}
// False when the count couldn't be written.
export function writeTries(t: Tries, now: number, path = TRIES): boolean {
  for (const [k, v] of Object.entries(t)) {                   // what's done with goes
    v.released = (v.released ?? []).filter((r) => now - r.at < TRY_MS);
    if (!v.released.length) delete v.released;
    if (v.n === 0 && !v.released) delete t[k];
    else if (now - v.first > 6 * TRY_MS && !v.released) delete t[k];
  }
  try { writeWhole(path, t); return true; } catch { return false; }
}

// Whether the text was let through on a third try just now (for discord-sent.ts).
export function wasReleased(t: Tries, key: string, text: string, now: number): boolean {
  const h = textHash(text);
  return (t[key]?.released ?? []).some((r) => r.hash === h && now - r.at < TRY_MS);
}

// Whether a third try may ever let this decision's refusal go: whenever it isn't hard. Hard
// is a chat the link says isn't his DM, and any refusal of an edit's target (not his, or
// not known to be). A chat that differs only from the cached DM id is soft: the cache may
// be stale, and the plugin's own allowlist still holds. So is any refusal while his DM
// can't be told, the "send exactly this instead" of a fix included: a clean send there
// goes, so a third try does too.
export function releasable(d: Decision): boolean {
  return !d.hard;
}

// counted: a refusal that holds only because it was counted toward the third try.
export interface Out { output: Record<string, unknown> | null; did: string; counted?: boolean }
const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const allow = (input: Record<string, unknown>, reason: string) => ({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason, updatedInput: input } });

// What the hook answers for a decision, counting and releasing tries in t (changed in place).
export function act(call: Call, d: Decision, t: Tries, now: number): Out {
  const key = keyOf(call.session, call.chat);
  const rec = t[key] && now - t[key].first <= TRY_MS ? t[key] : (t[key] = { n: 0, first: now, released: t[key]?.released });
  const refuse = (reason: string): Out => {
    if (!releasable(d)) return { output: deny(reason), did: "refused" };
    if (rec.n >= 2) {                                          // the third try: it goes as it is
      t[key] = { n: 0, first: now, released: [...(rec.released ?? []), { hash: textHash(call.text), at: now }] };
      return { output: null, did: "passed after two refusals" };
    }
    if (rec.n === 0) rec.first = now;
    rec.n++;
    return { output: deny(reason), did: "refused", counted: true };
  };
  if (d.would === "refuse") return refuse(d.said);
  // "Send exactly this instead: ..." when the fix can't go out in place.
  if (d.would === "fix" && !(FIX_IN_PLACE && d.chat === "his" && plainInput(call))) return refuse(d.said);
  rec.n = 0;
  if (d.would === "fix")
    return { output: allow({ ...call.input, text: d.fixed }, `The message gate fixed its wording as it went: ${fixedWhat(d.hits as Hit[])}.`), did: "fixed" };
  return { output: null, did: d.chat === "unknown" ? "passed, his DM unknown" : "passed" };
}

// One log line, or null for a clean reply to his DM.
export function entry(call: Call, d: Decision, out: Out, from: string, now: number): Record<string, unknown> | null {
  if (!d.hits.length && out.did === "passed") return null;
  return { at: now, point: call.tool, writer: "cain", cards: from, would: d.would, did: out.did, chat: d.chat, hits: d.hits,
    ...(call.replyTo ? { reply_to: call.replyTo } : {}), ...(call.target ? { message: call.target } : {}) };
}

function linkKey(): string {
  const m = readFileSync(ENV, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m);
  return m ? createHmac("sha256", m[1].trim()).update("harness-relay-v1").digest("hex") : "";
}

async function askLink(): Promise<CardsView | null> {
  const r = await fetch(`${LINK}/cards`, { headers: { "x-harness-key": linkKey() }, signal: AbortSignal.timeout(LINK_MS) });
  return r.ok ? ((await r.json()) as CardsView) : null;
}

// The whole hook, for one input: what it prints (nothing, or one JSON object).
export async function run(raw: string, o: { ask?: () => Promise<CardsView | null>; file?: () => string | null; now?: number } = {}): Promise<string> {
  const input = JSON.parse(raw);
  const call = callOf(input);
  if (!call) return "";
  const now = o.now ?? Date.now();
  const tz = process.env.CHECKIN_TZ ?? "America/New_York";
  const got = await cardsNow(o.ask ?? askLink, o.file ?? (() => { try { return readFileSync(CARDS, "utf8"); } catch { return null; } }), now);
  keepDm(got.cards?.dm);
  // The cached DM id only when there are no cards at all (decideSend).
  const d = decideSend(call, got.cards, { dm: got.cards ? null : readDm(), tz, now,
    ...(call.tool === "edit" ? { replied: repliedIn(input?.transcript_path) } : {}) });
  const tries = readTries();
  let out = act(call, d, tries, now);
  if (!writeTries(tries, now) && out.counted) out = { output: null, did: "passed, tries not counted" };
  const line = entry(call, d, out, got.from, now);
  if (line) await appendGate(line);
  return out.output ? JSON.stringify(out.output) : "";
}

// -- the self-test: the installed command, run as Claude Code runs it ----------------------
const SETTINGS = process.env.CAIN_SETTINGS ?? "/data/work/.claude/settings.json";
const INSTALLED = "/opt/cain/hooks/discord-send.ts";
const RELAY_QUEUE = process.env.RELAY_QUEUE ?? "/data/relay.queue";

export async function selfTest(settingsPath = SETTINGS): Promise<{ status: "ok" | "failed"; said: string; ms: number }> {
  const fail = (why: string, ms = 0) => ({ status: "failed" as const, said: `The message gate's reply hook failed its self-test: ${why}`, ms });
  let command = "";
  try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const e = (s?.hooks?.PreToolUse ?? []).find((x: any) => x?.matcher === "mcp__plugin_discord_discord__reply");
    const h = e?.hooks?.[0];
    if (!h) return fail("it isn't wired on the reply tool in Cain's settings.");
    if (h.async) return fail("it's wired to run in the background, so it can't hold anything back.");
    if (!(Number(h.timeout) > 0 && Number(h.timeout) <= 5)) return fail("its timeout isn't 5 seconds or less.");
    command = String(h.command ?? "");
    if (command !== `bun ${INSTALLED} || true`) return fail(`its command is "${command.slice(0, 80)}".`);
  } catch (e) { return fail(`Cain's settings can't be read (${String(e).slice(0, 60)}).`); }
  // Run from where this file is: on the Pi that's the installed path itself.
  const here = (process.env.CAIN_SELFTEST_HOOK ?? import.meta.path).replaceAll("\\", "/");
  const cmd = here === INSTALLED ? command : command.replace(INSTALLED, `'${here}'`);
  const dir = mkdtempSync(join(tmpdir(), "gate-selftest-"));
  try {
    writeFileSync(join(dir, "dm.json"), JSON.stringify({ dm: "1300000000000000500", at: Date.now() }));
    const env = { ...process.env, CAIN_GATE_TRIES: join(dir, "tries.json"), CAIN_GATE_DM: join(dir, "dm.json"),
      CAIN_GATE_LOG: join(dir, "gate.jsonl"), CAIN_CARDS: join(dir, "none.json"), CAIN_LINK: "http://127.0.0.1:9" };
    const one = async (text: string) => {
      const input = { session_id: "self-test", hook_event_name: "PreToolUse", tool_name: "mcp__plugin_discord_discord__reply",
        tool_input: { chat_id: "1300000000000000500", text } };
      const t0 = performance.now();
      const p = Bun.spawn(["bash", "-c", cmd], { stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe", stderr: "ignore", env });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return { out: out.trim(), ms: performance.now() - t0 };
    };
    const fix = await one("Moved swim — it's at 4:30 now.");
    const held = await one("Two blocks moved and 3 more.");
    const clean = await one("Moved swim to 4:30.");
    const ms = Math.round((fix.ms + held.ms + clean.ms) / 3);
    const parse = (s: string) => { try { return JSON.parse(s)?.hookSpecificOutput ?? null; } catch { return null; } };
    const f = parse(fix.out), h = parse(held.out);
    const fixOk = FIX_IN_PLACE ? f?.permissionDecision === "allow" && f?.updatedInput?.text === "Moved swim, it's at 4:30 now."
      && f?.updatedInput?.chat_id === "1300000000000000500"
      : f?.permissionDecision === "deny" && String(f?.permissionDecisionReason).includes("Moved swim, it's at 4:30 now.");
    if (!fixOk) return fail(`an em dash wasn't fixed (it answered "${fix.out.slice(0, 120)}").`, ms);
    if (h?.permissionDecision !== "deny" || !String(h?.permissionDecisionReason).includes("and 3 more"))
      return fail(`"and 3 more" wasn't held back (it answered "${held.out.slice(0, 120)}").`, ms);
    if (clean.out !== "") return fail(`a clean reply didn't pass silently (it answered "${clean.out.slice(0, 120)}").`, ms);
    return { status: "ok", said: `The message gate's reply hook passed its self-test: it fixes em dashes in place, holds back "and 3 more" and lets a clean reply go, in about ${ms} ms a reply.`, ms };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    const r = await selfTest();
    console.log(JSON.stringify(r));
    if (r.status !== "ok" && process.argv.includes("--relay")) {
      try { appendFileSync(RELAY_QUEUE, JSON.stringify({ text: `${r.said} Until it's fixed your replies go out unchecked. Log it as a Build item; nothing to tell him.` }) + "\n"); }
      catch { /* the log line above still says it */ }
    }
    process.exit(r.status === "ok" ? 0 : 1);
  }
  try {
    const out = await run(await Bun.stdin.text());
    if (out) process.stdout.write(out);
  } catch { /* fail open: the reply goes */ }
  process.exit(0);
}
