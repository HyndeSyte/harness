// What the link writes for readers outside it (piece D):
// - /data/trust/cards.json: the cards as the reply hook reads them when the link doesn't
//   answer (core.ts cardsView: no text). Only root writes /data/trust; everyone reads it.
//   Never written inside a save: a save only asks for a write (CardsWriter.soon), and one
//   write about half a second later, whole through a temp file and a rename, carries the
//   state as it is then. The sweep asks too, so it's fresh at least once a minute.
// - /data/work/gate-replay.json: the replay's report, in Cain's own folder.
// And what it reads for the replay: Cain's own Claude Code transcripts, for which of the
// bot's messages he sent with the Discord plugin (one bot token posts them all). They are
// streamed in chunks and the event loop gets a turn often, so a tap is never kept waiting.
import { createReadStream, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { answerText, sentIds } from "../gate/plugin";
import { cardsView, emptyState, type ReplayReport, type Sent, type State } from "./core";

export const CARDS_FILE = process.env.CAIN_CARDS ?? "/data/trust/cards.json";
export const REPLAY_FILE = process.env.CAIN_GATE_REPLAY ?? "/data/work/gate-replay.json";
export const TRANSCRIPTS = process.env.CAIN_TRANSCRIPTS ?? "/data/.claude/projects";
export const CARDS_DELAY_MS = 500;

// The link's state file: read whole, written whole through a rename. A save tells onSave
// (the cards writer) and writes nothing else.
export function stateFile(path: string, onSave: () => void = () => {}) {
  return {
    load(): State {
      try { return JSON.parse(readFileSync(path, "utf8")); } catch { return emptyState(); }
    },
    save(s: State): void {
      writeFileSync(`${path}.tmp`, JSON.stringify(s), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      onSave();
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
// his transcripts changed since a time: the tool's input text, and the ids in its answer.
// Only lines that name the plugin's tools, or answer one of those calls, are parsed.
export async function readTranscripts(root: string, since: number): Promise<Sent> {
  const ids = new Set<string>(), texts = new Set<string>();
  let dirs: string[] = [];
  try { dirs = readdirSync(root).map((d) => join(root, d)); } catch { return { ids, texts }; }
  for (const dir of dirs) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)); } catch { continue; }
    for (const f of files) {
      try { if (statSync(f).mtimeMs < since) continue; } catch { continue; }
      const sends = new Set<string>();
      const take = (line: Buffer) => {
        if (!line.includes(NAME) && !(sends.size && line.includes(RESULT) && [...sends].some((s) => line.includes(s)))) return;
        let o: any;
        try { o = JSON.parse(line.toString("utf8")); } catch { return; }
        const content = o?.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b?.type === "tool_use" && SEND.test(String(b.name ?? ""))) {
            sends.add(String(b.id ?? ""));
            const t = String(b.input?.text ?? "").trim();
            if (t) texts.add(t);
          } else if (b?.type === "tool_result" && sends.has(String(b.tool_use_id ?? ""))) {
            sends.delete(String(b.tool_use_id));
            for (const id of sentIds(answerText(b.content))) ids.add(id);
          }
        }
      };
      let parts: Buffer[] = [], held = 0, skipping = false, read = 0;
      try {
        for await (const chunk of createReadStream(f, { highWaterMark: 64 * 1024 })) {
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
  return { ids, texts };
}
