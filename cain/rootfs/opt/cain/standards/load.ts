// Dane's standards (registry.md beside this file) for a session's start. Prints the entries
// that apply to a role as a SessionStart hook's added context, which Claude Code puts in front
// of the session: at its start, on resume, after /clear and after every compaction, so a rule
// never fades as the session grows (org-v2 DESIGN 4.F).
//   bun load.ts cain|laptop|specialist|jobs --part <1..PARTS> [--plain]
// Claude Code cuts a hook's added context at 8,000 characters, so the text comes in parts, each
// under PART_MAX and split between entries, one hook per part (the tests keep every role within
// PARTS). Cain's managed settings run the parts for cain; the laptop's user settings run them
// for laptop from its checkout of this repo. --plain prints the text alone; with no --part, the
// whole text.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["invariant", "procedure", "principle"] as const;
export const ROLES = ["all", "cain", "laptop", "specialist", "jobs"] as const;
export const HOME_KINDS = ["role", "journey", "design", "item"] as const;

export interface Entry {
  id: string; title: string; line: number;
  kind?: string; applies?: string[]; home?: string; source?: string; rule?: string;
  enforcedBy?: string; checkedAt?: string;
}

export const REGISTRY = join(import.meta.dir, "registry.md");
export const PART_MAX = 7_500;
export const PARTS = 3;

// Each entry is a "## S-nnn Title" heading and its "- key: value" lines.
export function parse(text: string): Entry[] {
  const out: Entry[] = [];
  let cur: Entry | null = null;
  text.replace(/\r\n/g, "\n").split("\n").forEach((l, i) => {
    const h = /^## (S-\d{3}) (.+)$/.exec(l);
    if (h) { if (cur) out.push(cur); cur = { id: h[1], title: h[2].trim(), line: i + 1 }; return; }
    if (!cur) return;
    const m = /^- ([a-z-]+): (.*)$/.exec(l);
    if (!m) return;
    const [k, v] = [m[1], m[2].trim()];
    if (k === "applies") cur.applies = v.split(",").map((x) => x.trim()).filter(Boolean);
    else if (k === "enforced-by") cur.enforcedBy = v;
    else if (k === "checked-at") cur.checkedAt = v;
    else if (k === "kind" || k === "home" || k === "source" || k === "rule") cur[k] = v;
  });
  if (cur) out.push(cur);
  return out;
}

export const appliesTo = (e: Entry, role: string) => !!e.applies && (e.applies.includes("all") || e.applies.includes(role));

// The text for a role, in parts of at most PART_MAX characters, split between entries.
export function parts(entries: Entry[], role: string): string[] {
  const mine = entries.filter((e) => appliesTo(e, role));
  const out: string[] = [];
  let cur = `Dane's standards, from the one registry (${mine.length} apply here, in ${"$"}{N} parts). Each holds in everything you do. Where something you remember disagrees, this list wins: it is newer.`;
  for (const e of mine) {
    const item = `${e.id} ${e.title} (${e.kind}): ${e.rule}`;
    if (cur.length + 2 + item.length > PART_MAX) { out.push(cur); cur = `Dane's standards, continued:`; }
    cur += `\n\n${item}`;
  }
  out.push(cur);
  return out.map((p) => p.replace("${N}", String(out.length)));
}

export const render = (entries: Entry[], role: string) => parts(entries, role).join("\n\n");

if (import.meta.main) {
  const role = process.argv[2] ?? "";
  if (!ROLES.includes(role as (typeof ROLES)[number]) || role === "all") {
    console.error("usage: load.ts cain|laptop|specialist|jobs [--plain]");
    process.exit(2);
  }
  const all = parts(parse(readFileSync(REGISTRY, "utf8")), role);
  const at = process.argv.indexOf("--part");
  const n = at > 0 ? Number(process.argv[at + 1]) : 0;
  const text = n ? (all[n - 1] ?? "") : all.join("\n\n");
  if (!text) process.exit(0);                       // a part past the end: nothing to add
  console.log(process.argv.includes("--plain") ? text
    : JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
}
