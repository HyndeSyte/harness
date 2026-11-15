// What the link writes for readers outside it (piece D):
// - /data/trust/cards.json: the cards as the reply hook reads them when the link doesn't
//   answer (core.ts cardsView: no text). Only root writes /data/trust; everyone reads it.
//   Never written inside a save: a save only asks for a write (CardsWriter.soon), and one
//   write about half a second later, whole through a temp file and a rename, carries the
//   state as it is then. The sweep asks too, so it's fresh at least once a minute.
// - /data/work/gate-replay.json: the replay's report, in Cain's own folder.
// And what it reads for the replay and his edit allowlist: Cain's own Claude Code
// transcripts, for which of the bot's messages he sent with the Discord plugin (one bot
// token posts them all), and which of them his reply tool made (seedReplies). They are
// streamed in chunks and the event loop gets a turn often, so a tap is never kept waiting.
import { closeSync, createReadStream, fstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { answerText, sentIds } from "../gate/plugin";
import { CAIN_UID, openOwnedFd } from "../owned";
import { KEEP_MS, writeSynced } from "./auth";
import { cardsView, emptyState, type ReplayReport, type Sent, type State } from "./core";

// Whose transcripts these are (tests set their own user), read at each call.
const transcriptUid = () => Number(process.env.CAIN_TRANSCRIPT_UID ?? CAIN_UID);

export const CARDS_FILE = process.env.CAIN_CARDS ?? "/data/trust/cards.json";
export const REPLAY_FILE = process.env.CAIN_GATE_REPLAY ?? "/data/work/gate-replay.json";
// Cain's own (C1: his home is /data/cain). Each file is opened only if it's a regular file of
// his user's, never through a link (../owned.ts), since he can put anything there.
export const TRANSCRIPTS = process.env.CAIN_TRANSCRIPTS ?? "/data/cain/.claude/projects";
export const CARDS_DELAY_MS = 500;

// The link's state file: read whole, written whole and durably (a temp file synced, renamed,
// its folder synced), in two copies, the second first, each holding which save it is (saveGen),
// as the request log is (C1 re-check N2). So a card the link answered for is on disk before its
// answer is recorded, and one damaged copy loses nothing. Both damaged is never taken quietly for
// a fresh store: they're kept aside (state.json.damaged-<time>), and lost() says so, across
// restarts, for as long as the link remembers a signed request (KEEP_MS): the link tells Cain, and
// a card's request id isn't trusted to find its card meanwhile. A save tells onSave (the cards
// writer) and writes nothing else.
export function stateFile(path: string, onSave: () => void = () => {},
                          write: (path: string, body: string) => void = writeSynced, now = () => Date.now()) {
  let gen = 0, whole = false, lostAt = 0, foundNow = false;
  try { const t = Number(readFileSync(`${path}.lost`, "utf8")); if (Number.isFinite(t) && t > 0) lostAt = t; } catch { /* never lost */ }
  const one = (p: string): State | "absent" | "bad" => {
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? "absent" : "bad"; }
    try {
      const s = JSON.parse(text);
      return s && typeof s === "object" && !Array.isArray(s) && s.cards && typeof s.cards === "object" && s.messages && typeof s.messages === "object" ? s : "bad";
    } catch { return "bad"; }
  };
  return {
    load(): State {
      // After the first look at both copies, the first is read alone while it's whole.
      if (whole) { const s = one(path); if (typeof s === "object") return s; }
      whole = true;
      const a = one(path), b = one(`${path}.2`);
      const good = [a, b].filter((x): x is State => typeof x === "object");
      if (good.length) {
        const best = good.reduce((x, y) => (Number(y.saveGen ?? 0) > Number(x.saveGen ?? 0) ? y : x));
        gen = Math.max(gen, Number(best.saveGen ?? 0));
        if (best !== a) whole = false;                  // the first copy is behind: both are read until a save
        return best;
      }
      if (a === "absent" && b === "absent") return emptyState();
      const t = now();
      for (const p of [path, `${path}.2`]) { try { renameSync(p, `${p}.damaged-${t}`); } catch { /* absent */ } }
      lostAt = t; foundNow = true;
      try { write(`${path}.lost`, String(t)); } catch { /* lost in memory still */ }
      return emptyState();
    },
    save(s: State): void {
      gen += 1;
      s.saveGen = gen;
      const body = JSON.stringify(s);
      try { write(`${path}.2`, body); write(path, body); }
      catch (e) { whole = false; throw e; }             // the copies may differ: read both next time
      whole = true;
      onSave();
    },
    // Found damaged by this process (so the link tells Cain once, not at every restart).
    lostNow(): boolean { return foundNow; },
    lost(): number {
      if (lostAt && now() - lostAt > KEEP_MS) { lostAt = 0; try { rmSync(`${path}.lost`, { force: true }); } catch { /* gone */ } }
      return lostAt;
    },
  };
}

export async function publishCards(s: State, now: number, path = CARDS_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await writeFile(`${path}.tmp`, JSON.stringify(cardsView(s, now)), { mode: 0o644 });
  await rename(`${path}.tmp`, path);
}

// One pending write at a time, of the state as it is when the write happens.
export class CardsWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private read: () => State, private path = CARDS_FILE, private delayMs = CARDS_DELAY_MS,
              private log: (line: string) => void = () => {}) {}

  soon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => publishCards(this.read(), Date.now(), this.path))
        .catch((e) => this.log(`couldn't publish the cards: ${String(e).slice(0, 80)}`));
    }, this.delayMs);
  }

  // Settles once a write asked for now has happened (for the tests).
  async settled(): Promise<void> {
    while (this.timer) await new Promise((ok) => setTimeout(ok, this.delayMs));
    await this.writing;
  }
}

export function writeReplayReport(r: ReplayReport, path = REPLAY_FILE): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(r, null, 1), { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
  return path;
}

const SEND = /plugin_discord_discord__(reply|edit_message)$/;
export { sentIds };

const MAX_LINE = 4 * 1024 * 1024;         // a longer line is skipped, never buffered
const YIELD_BYTES = 256 * 1024;           // the event loop gets a turn at least this often
const NAME = Buffer.from("plugin_discord_discord__"), RESULT = Buffer.from("tool_result");
const turn = () => new Promise<void>((ok) => setTimeout(ok, 0));

// The ids and exact texts of what Cain sent with the plugin's reply and edit tools, from
// his transcripts changed since a time: the tool's input text, and the ids in its answer;
// and apart, the ids his reply tool answered with (a message he only edited isn't his reply:
// it may be one the link posted). Only lines that name the plugin's tools, or answer one of
// those calls, are parsed.
export async function readTranscripts(root: string, since: number): Promise<Sent> {
  const ids = new Set<string>(), texts = new Set<string>(), replies = new Set<string>();
  let dirs: string[] = [];
  try { dirs = readdirSync(root).map((d) => join(root, d)); } catch { return { ids, texts, replies }; }
  for (const dir of dirs) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)); } catch { continue; }
    for (const f of files) {
      const owned = openOwnedFd(f, transcriptUid());
      if (!owned) continue;
      try { if (fstatSync(owned.fd).mtimeMs < since) { closeSync(owned.fd); continue; } } catch { try { closeSync(owned.fd); } catch { /* closed */ } continue; }
      const sends = new Map<string, boolean>();       // the plugin's send calls not answered yet: a reply?
      const take = (line: Buffer) => {
        if (!line.includes(NAME) && !(sends.size && line.includes(RESULT) && [...sends.keys()].some((s) => line.includes(s)))) return;
        let o: any;
        try { o = JSON.parse(line.toString("utf8")); } catch { return; }
        const content = o?.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          const m = b?.type === "tool_use" ? SEND.exec(String(b.name ?? "")) : null;
          if (m) {
            sends.set(String(b.id ?? ""), m[1] === "reply");
            const t = String(b.input?.text ?? "").trim();
            if (t) texts.add(t);
          } else if (b?.type === "tool_result" && sends.has(String(b.tool_use_id ?? ""))) {
            const reply = sends.get(String(b.tool_use_id));
            sends.delete(String(b.tool_use_id));
            for (const id of sentIds(answerText(b.content))) { ids.add(id); if (reply) replies.add(id); }
          }
        }
      };
      let parts: Buffer[] = [], held = 0, skipping = false, read = 0;
      try {
        for await (const chunk of createReadStream("", { fd: owned.fd, highWaterMark: 64 * 1024, autoClose: true })) {
          const buf = chunk as Buffer;
          let pos = 0;
          for (let nl = buf.indexOf(10, pos); nl !== -1; nl = buf.indexOf(10, pos)) {   // only the new chunk is searched
            if (!skipping && held + (nl - pos) <= MAX_LINE) take(held ? Buffer.concat([...parts, buf.subarray(pos, nl)]) : buf.subarray(pos, nl));
            parts = []; held = 0; skipping = false; pos = nl + 1;
          }
          if (pos < buf.length && !skipping) {
            if (held + buf.length - pos > MAX_LINE) { parts = []; held = 0; skipping = true; }   // too long: skip to its end
            else { parts.push(Buffer.from(buf.subarray(pos))); held += buf.length - pos; }
          }
          read += buf.length;
          if (read >= YIELD_BYTES) { read = 0; await turn(); }
        }
        if (!skipping && held) take(Buffer.concat(parts));
      } catch { /* a file that can't be read is left out */ }
      await turn();
    }
  }
  return { ids, texts, replies };
}

// His edit allowlist, seeded from his transcripts changed since a time (at the link's start,
// then every 6 hours): the ids his reply tool answered with, never an edit's, which can be of
// a message the link posted. How many were added.
export async function seedReplies(link: { seedSent(ids: Iterable<string>): number }, root: string, since: number): Promise<number> {
  const sent = await readTranscripts(root, since);
  return link.seedSent(sent.replies ?? []);
}
