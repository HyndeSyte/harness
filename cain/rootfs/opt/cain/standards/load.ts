// Dane's standards (registry.md beside this file) for a session's start. Prints the entries
// that apply to a role as a SessionStart hook's added context, which Claude Code puts in front
// of the session at every start of any kind and after every compaction, so a rule never fades
// as the session grows (org-v2 DESIGN 4.F).
//   bun load.ts cain|laptop|jobs --part <1..PARTS> [--plain]
// Claude Code cuts a hook's added context at 8,000 characters, so the text comes in parts, each
// at most PART_MAX and split between entries, one hook per part; Claude Code gathers every
// SessionStart hook's added context, so all of them arrive (the tests keep every role within
// PARTS). Each part names its number and the registry's version, and stands on its own.
// Cain's managed settings run the parts for cain; the laptop's user settings run them for
// laptop from its checkout of this repo; this repo's project settings run them for cloud jobs.
// His corrections the registry doesn't hold yet (the record's rules/incoming.md: Cain's copy,
// or the laptop's clone) come after the entries, and win over them until they're folded in.
// A registry that can't be read is said in part 1, with where to read it: never silence.
// --plain prints the text alone; with no --part, the whole text.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["invariant", "procedure", "principle"] as const;
export const ROLES = ["all", "cain", "laptop", "specialist", "jobs"] as const;
export const HOME_KINDS = ["role", "journey", "design", "item"] as const;
export const KEYS = ["kind", "applies", "home", "source", "enforced-by", "checked-at", "rule"] as const;

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

// What parse would pass over: in an entry, a line that isn't "- key: value" with a known key,
// or a key given twice. The tests keep this empty, so no part of a rule is dropped unseen.
export function problems(text: string): string[] {
  const out: string[] = [];
  let id = "";
  let seen = new Set<string>();
  text.replace(/\r\n/g, "\n").split("\n").forEach((l, i) => {
    const h = /^## (S-\d{3}) (.+)$/.exec(l);
    if (h) { id = h[1]; seen = new Set(); return; }
    if (!id || !l.trim()) return;
    const m = /^- ([a-z-]+): \S/.exec(l);
    if (!m) out.push(`${id}, line ${i + 1}: not a "- key: value" line`);
    else if (!(KEYS as readonly string[]).includes(m[1])) out.push(`${id}, line ${i + 1}: no key "${m[1]}"`);
    else if (seen.has(m[1])) out.push(`${id}, line ${i + 1}: "${m[1]}" twice`);
    if (m) seen.add(m[1]);
  });
  return out;
}

export const appliesTo = (e: Entry, role: string) => !!e.applies && (e.applies.includes("all") || e.applies.includes(role));

// His corrections the registry doesn't hold yet: the list lines of the record's rules/incoming.md
// ("- ", "* ", "+ " or "1. ").
export const incomingOf = (text: string) => text.replace(/\r\n/g, "\n").split("\n")
  .map((l) => /^(?:[-*+]|\d+\.)\s+(.*\S)\s*$/.exec(l)?.[1] ?? "").filter(Boolean);

export const INCOMING: Record<string, string | undefined> = {
  cain: "/data/record/rules/incoming.md",
  laptop: process.env.RECORD_CLONE ? join(process.env.RECORD_CLONE, "rules/incoming.md") : undefined,
};

export const version = (registry: string) => createHash("sha1").update(registry.replace(/\r\n/g, "\n")).digest("hex").slice(0, 8);

const WINS = "What wins: safety boundaries in code first; then his newest word (what he says now, and his corrections after this list that it doesn't hold yet); then this list; then anything remembered or summarized.";

// The text for a role, in parts of at most PART_MAX characters, split between entries; his
// newer corrections after them: in the last part, or one of their own while there are fewer
// than PARTS, each whole or not at all, then how many more and where; never cut short, and never
// a part past PARTS. A file of them that couldn't be read is said, with where to read it.
export function parts(entries: Entry[], role: string, o: { incoming?: string[]; incomingPath?: string; incomingError?: string; version?: string } = {}): string[] {
  const mine = entries.filter((e) => appliesTo(e, role));
  const v = o.version ? `, version ${o.version}` : "";
  const head = (n: number) => n === 1
    ? `Dane's standards, part 1 of \u0000${v}: the one registry (${REGISTRY}), ${mine.length} entries for this session. Each holds in everything you do. ${WINS}`
    : `Dane's standards, part ${n} of \u0000${v}, continued:`;
  const out: string[] = [];
  let cur = head(1);
  const add = (item: string) => {
    if (cur.length + 2 + item.length > PART_MAX) { out.push(cur); cur = head(out.length + 1); }
    cur += `\n\n${item}`;
  };
  for (const e of mine) add(`${e.id} ${e.title} (${e.kind}): ${e.rule}`);
  const file = o.incomingPath ?? "the record's rules/incoming.md";
  let block = "";
  if (o.incomingError) block = `His newer corrections couldn't be read (${o.incomingError}): read ${file} yourself now. They win over this list until they're folded in.`;
  else if (o.incoming?.length) {
    // Room: what's left of this part when it's the last there can be, else a part of its own.
    const room = (out.length + 1 >= PARTS ? PART_MAX - cur.length - 2 : PART_MAX - head(PARTS).length - 2) - 100;
    block = `His newer corrections (${file}), not in this list yet. They win over it until they're folded in:`;
    let left = 0;
    for (const c of o.incoming) {
      const line = `\n- ${c}`;
      if (block.length + line.length > room) { left++; continue; }   // whole, or not at all
      block += line;
    }
    if (left === o.incoming.length) block = `His newer corrections are in ${file}, not in this list yet, too long to show here: read them whole there now. They win over it until they're folded in.`;
    else if (left) block += `\n(${left} more there, too long to show here: read them whole there now.)`;
  }
  if (block) {
    // In the last part there can be, a line that won't fit whole gives way to a short one that
    // still names the file (the part stays under Claude Code's cut).
    if (out.length + 1 >= PARTS && cur.length + 2 + block.length > PART_MAX) block = `His newer corrections: read ${file} now. They win over this list.`;
    if (out.length + 1 >= PARTS) cur += `\n\n${block}`;
    else add(block);
  }
  out.push(cur);
  return out.map((p) => p.replace("\u0000", String(out.length)));
}

export const render = (entries: Entry[], role: string) => parts(entries, role).join("\n\n");

if (import.meta.main) {
  const role = process.argv[2] ?? "";
  if (!ROLES.includes(role as (typeof ROLES)[number]) || role === "all" || role === "specialist") {
    console.error("usage: load.ts cain|laptop|jobs --part <n> [--plain]");
    process.exit(2);
  }
  const at = process.argv.indexOf("--part");
  const n = at > 0 ? Number(process.argv[at + 1]) : 0;
  const say = (text: string): never => {
    if (text) console.log(process.argv.includes("--plain") ? text
      : JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
    process.exit(0);
  };
  // The project's parts are for cloud jobs (Claude Code marks their sessions CLAUDE_CODE_REMOTE);
  // a laptop session started inside this repo carries the laptop's own (its user settings).
  if (role === "jobs" && process.env.CLAUDE_CODE_REMOTE !== "true") say("");
  let all: string[] = [];
  try {
    const text = readFileSync(REGISTRY, "utf8");
    const bad = problems(text);
    if (bad.length) throw new Error(`registry.md isn't well formed: ${bad[0]}`);
    const path = process.env.STANDARDS_INCOMING ?? INCOMING[role];
    let incoming: string[] = [];
    let incomingError = "";
    if (path && path !== "none") {
      try { incoming = incomingOf(readFileSync(path, "utf8")); }
      catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") incomingError = String((e as NodeJS.ErrnoException)?.code ?? e); }
    }
    all = parts(parse(text), role, { incoming, incomingPath: path, incomingError, version: version(text) });
  } catch (e) {
    say(n > 1 ? "" : `Dane's standards didn't load (${String((e as Error)?.message ?? e).slice(0, 200)}). Read ${REGISTRY} yourself now, before you act: the entries that apply to all and to ${role}. That they didn't load is a defect to report.`);
  }
  if (!n) say(all.join("\n\n"));
  let text = all[n - 1] ?? "";                      // a part past the end: nothing to add
  if (n === PARTS && all.length > PARTS)
    text += `\n\nThis list didn't fit in its ${PARTS} parts: ${all.length - PARTS} more part(s) of it are only in ${REGISTRY}. Read the rest there now.`;
  say(text);
}
