// The Discord plugin's two sending tools as Claude Code names them, and what its answers
// say it made. Shared by the reply hooks (../hooks/discord-send.ts, discord-sent.ts) and
// the link's replay (../link/publish.ts).

export const REPLY_TOOL = "mcp__plugin_discord_discord__reply";
export const EDIT_TOOL = "mcp__plugin_discord_discord__edit_message";
export const SENDS = { [REPLY_TOOL]: "reply", [EDIT_TOOL]: "edit" } as const;

// The plugin's own answers: "sent (id: X)", "sent N parts (ids: X, Y)", "edited (id: X)".
// Only those say which messages it made; any other long number in a result is not proof.
const ONE = /\b(?:sent|edited) \(id: (\d{17,20})\)/g;
const PARTS = /\bsent \d+ parts \(ids: (\d{17,20}(?:,\s*\d{17,20})*)\)/g;
export function sentIds(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(ONE)) out.push(m[1]);
  for (const m of answer.matchAll(PARTS)) out.push(...m[1].split(/,\s*/));
  return out;
}

// A tool's answer as Claude Code hands it to a hook or keeps it in a transcript: a
// string, a list of text blocks, or an object holding one of those.
export function answerText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x: any) => (typeof x === "string" ? x : String(x?.text ?? ""))).join(" ");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("content" in o) return answerText(o.content);
    if ("text" in o) return String(o.text ?? "");
    if ("result" in o) return answerText(o.result);
  }
  return "";
}

// The last line of a message, as he reads it, ends in a question: a lone Stop under it
// would read as an answer.
export function asksSomething(text: string): boolean {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  return /\?["'”’)*_~`]*$/.test(lines[lines.length - 1] ?? "");
}
