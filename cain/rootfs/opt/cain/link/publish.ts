// What the link writes for readers outside it (piece D):
// - /data/trust/cards.json: the cards as the reply hook reads them when the link doesn't
//   answer (core.ts cardsView: no text). Only root writes /data/trust; everyone reads it.
//   Written whole through a temp file and a rename, on every save and after each sweep.
// - /data/work/gate-replay.json: the replay's report, in Cain's own folder.
// And what it reads for the replay: Cain's own Claude Code transcripts, for which of the
// bot's messages he sent with the Discord plugin (one bot token posts them all).
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cardsView, type ReplayReport, type Sent, type State } from "./core";

export const CARDS_FILE = process.env.CAIN_CARDS ?? "/data/trust/cards.json";
export const REPLAY_FILE = process.env.CAIN_GATE_REPLAY ?? "/data/work/gate-replay.json";
export const TRANSCRIPTS = process.env.CAIN_TRANSCRIPTS ?? "/data/.claude/projects";

function whole(path: string, text: string, mode: number, dirMode?: number): void {
  mkdirSync(dirname(path), { recursive: true, ...(dirMode ? { mode: dirMode } : {}) });
  writeFileSync(`${path}.tmp`, text, { mode });
  renameSync(`${path}.tmp`, path);
}

export function publishCards(s: State, now: number, path = CARDS_FILE): void {
  whole(path, JSON.stringify(cardsView(s, now)), 0o644, 0o755);
}

export function writeReplayReport(r: ReplayReport, path = REPLAY_FILE): string {
  whole(path, JSON.stringify(r, null, 1), 0o644);
  return path;
}

const SEND = /plugin_discord_discord__(reply|edit_message)$/;
const ID = /(?<!\d)\d{17,20}(?!\d)/g;

// The ids and exact texts of what Cain sent with the plugin's reply and edit tools, from
// his transcripts changed since a time: the tool's input text, the message an edit names,
// and the ids in the tool's answer.
export function readTranscripts(root: string, since: number): Sent {
  const ids = new Set<string>(), texts = new Set<string>();
  let dirs: string[] = [];
  try { dirs = readdirSync(root).map((d) => join(root, d)); } catch { return { ids, texts }; }
  for (const dir of dirs) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)); } catch { continue; }
    for (const f of files) {
      let text: string;
      try { if (statSync(f).mtimeMs < since) continue; text = readFileSync(f, "utf8"); } catch { continue; }
      const sends = new Set<string>();
      for (const line of text.split("\n")) {
        if (!line.includes("plugin_discord_discord__") && !line.includes("tool_result")) continue;
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        const content = o?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (b?.type === "tool_use" && SEND.test(String(b.name ?? ""))) {
            sends.add(String(b.id ?? ""));
            const t = String(b.input?.text ?? "").trim();
            if (t) texts.add(t);
            if (b.input?.message_id) ids.add(String(b.input.message_id));
          } else if (b?.type === "tool_result" && sends.has(String(b.tool_use_id ?? ""))) {
            const out = typeof b.content === "string" ? b.content
              : Array.isArray(b.content) ? b.content.map((x: any) => String(x?.text ?? "")).join(" ") : "";
            for (const m of out.matchAll(ID)) ids.add(m[0]);
          }
        }
      }
    }
  }
  return { ids, texts };
}
