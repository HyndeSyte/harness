// What a laptop session showed him this turn, checked when the turn ends (the registry's S-010,
// S-013 and S-014 on the laptop). Nothing holds a laptop reply back before it shows, so this is a
// correction after the fact: words he can't read keep the session going once, to say those lines
// again plainly. A Claude Code Stop hook in the laptop's user settings:
//
//   bun cain/tools/reply-check.ts --hook     (the hook's input: transcript_path, stop_hook_active)
//
// It reads the turn's words as he saw them (the session's text since his last message, and the
// recap, question and buttons of its wrap-up box or question card) with the message gate's own
// rules (an em dash, "add-on", a hidden count, machine text) and the codes it can tell apart from
// ordinary words: an item id his record has (and its question id), a number of the registry's
// entries or of the record's rule files, "wave" and a number, a commit's short id. A build
// piece's letter and number (C1, D3) is left to the standards themselves: the same letters are
// vitamins, vertebrae and part numbers. Clean words, a turn it already kept going, or anything
// that can't be read: nothing, so it never blocks for good.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { codesHits, recordItems } from "../rootfs/opt/cain/gate/cain.ts";
import { check, WHY } from "../rootfs/opt/cain/gate/rules.ts";
import { clone, git, treeAt } from "./record-lib.ts";

const LAPTOP_RULES = ["dash", "app", "count", "machine"] as const;
const REGISTRY = join(import.meta.dir, "../rootfs/opt/cain/standards/registry.md");

// The numbers that are codes here: the registry's entries (S-062) and the record's rule files
// (R-004), each only as it exists, so "R-134a" or "S-300" pass.
export function knownNumbers(registry: string | null, ruleFiles: string[]): Set<string> {
  const out = new Set<string>();
  for (const m of (registry ?? "").matchAll(/^## (S-\d{3}) /gm)) out.add(m[1]);
  for (const f of ruleFiles) { const m = /(?:^|\/)(R-\d{3})-/.exec(f); if (m) out.add(m[1]); }
  return out;
}

// The end of a transcript, where this turn is: its last TAIL bytes, from the first whole line
// (a long session's transcript runs to hundreds of megabytes, and this runs at every turn's end).
export const TAIL = 16 * 1024 * 1024;
export function tailLines(path: string, max = TAIL): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - max);
    const buf = Buffer.alloc(size - from);
    let got = 0;
    while (got < buf.length) {                         // a read can come back short
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    return from > 0 ? lines.slice(1) : lines;
  } finally { closeSync(fd); }
}

const WAVE = /\bwave \d\b/gi;
const COMMIT = /(?<![0-9A-Za-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}(?![0-9A-Za-z])/g;
const NUMBER = /(?<![A-Za-z0-9])[SR]-\d{3}(?![A-Za-z0-9])/g;

// The words of this turn as he saw them: everything shown after his last message.
export function turnWords(lines: string[]): string[] {
  const rows: any[] = [];
  for (const l of lines) { try { rows.push(JSON.parse(l)); } catch { /* not a row */ } }
  const his = (o: any) => o?.type === "user" && o?.message?.role === "user" && !o?.isMeta
    && (typeof o.message.content === "string" ? o.message.content.trim().length > 0
      : Array.isArray(o.message.content) && o.message.content.some((c: any) => c?.type === "text" && String(c.text ?? "").trim()));
  let start = 0;
  rows.forEach((o, i) => { if (his(o)) start = i + 1; });
  const out: string[] = [];
  for (const o of rows.slice(start)) {
    if (o?.type !== "assistant" || !Array.isArray(o?.message?.content)) continue;
    for (const c of o.message.content) {
      if (c?.type === "text" && typeof c.text === "string") out.push(c.text);
      if (c?.type !== "tool_use" || !c.input) continue;
      const name = String(c.name ?? "");
      if (name.endsWith("wrap_up")) {
        for (const k of ["recap", "ask"]) if (typeof c.input[k] === "string") out.push(c.input[k]);
        for (const a of Array.isArray(c.input.actions) ? c.input.actions : []) if (typeof a?.label === "string") out.push(a.label);
      }
      if (name === "AskUserQuestion" && Array.isArray(c.input.questions))
        for (const q of c.input.questions) {
          if (typeof q?.question === "string") out.push(q.question);
          for (const op of Array.isArray(q?.options) ? q.options : []) for (const k of ["label", "description"]) if (typeof op?.[k] === "string") out.push(op[k]);
        }
    }
  }
  return out;
}

// What in those words he can't read, each as a short excerpt with why.
export function unreadable(words: string[], items: ReadonlySet<string> | null, numbers: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const w of words) {
    for (const h of check(w, { rules: [...LAPTOP_RULES], refusable: true }).hits) out.push(`"${h.around}" (${WHY[h.rule]})`);
    for (const h of codesHits(w, items)) out.push(`"${h.around}" (a record code he can't read)`);
    const seen = w.replace(/\]\([^)]*\)/g, "]()");                     // a link's target isn't shown
    for (const m of seen.matchAll(NUMBER)) if (numbers.has(m[0])) out.push(`"${m[0]}" (a registry or rule number)`);
    for (const m of seen.matchAll(WAVE)) out.push(`"${m[0]}" (a build wave)`);
    for (const m of seen.matchAll(COMMIT)) out.push(`"${m[0]}" (a commit's id)`);
  }
  return [...new Set(out)];
}

if (import.meta.main) {
  const pass = (): never => process.exit(0);
  try {
    const input = JSON.parse(await Bun.stdin.text());
    if (input?.stop_hook_active === true) pass();
    const words = turnWords(tailLines(String(input?.transcript_path ?? "")));
    let items: Set<string> | null = null;
    let rules: string[] = [];
    const c = clone(process.env.RECORD_CLONE);
    if (!("error" in c)) {
      items = recordItems(treeAt(c).read("state/PENDING.md"));
      rules = (git(c.dir, ["ls-tree", "--name-only", c.ref, "rules/"]) ?? "").split("\n").filter(Boolean);
    }
    let registry: string | null = null;
    try { registry = readFileSync(REGISTRY, "utf8"); } catch { /* none beside it */ }
    const found = unreadable(words, items, knownNumbers(registry, rules));
    if (!found.length) pass();
    const reason = `What you showed him this turn has words he can't read: ${found.slice(0, 8).join("; ")}${found.length > 8 ? `; and ${found.length - 8} more of the same kinds` : ""}. `
      + "Send him the lines that held them again, said plainly: things named by what they do for him, no codes or ids, no em dashes. "
      + "If one is an ordinary word where it stands (a part number, a vitamin), leave it and add nothing. Say nothing about this check.";
    console.log(JSON.stringify({ decision: "block", reason }));
  } catch { /* never blocks for good */ }
  pass();
}
