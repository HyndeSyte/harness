// What a laptop session showed him this turn, checked when the turn ends (the registry's S-010,
// S-013 and S-014 on the laptop, where nothing holds a reply back before it shows). A Claude Code
// Stop hook in the laptop's user settings:
//
//   bun cain/tools/reply-check.ts --hook     (the hook's input: transcript_path, stop_hook_active)
//
// It reads the turn's words as he saw them (the session's text since his last message, and the
// recap, question and buttons of its wrap-up box or question card) with the message gate's own
// rules (an em dash, "add-on", a hidden count, machine text) and the codes he can't read: an
// item id the record has (and its question id), a registry or rule number, a build piece's code,
// "wave 1", a commit's short id. Words he can't read keep the session going once, with what they
// were and how to say them, so it sends him the lines again without them. Clean words, a turn
// already kept going by it, or anything that can't be read: nothing, so it never blocks for good.
import { readFileSync } from "node:fs";
import { codesHits, recordItems } from "../rootfs/opt/cain/gate/cain.ts";
import { check, WHY } from "../rootfs/opt/cain/gate/rules.ts";
import { clone, treeAt } from "./record-lib.ts";

const LAPTOP_RULES = ["dash", "app", "count", "machine"] as const;

// The codes only the laptop's words carry: registry and rule numbers, build pieces, waves, and a
// commit's short id (a run of hex with a digit and a letter in it).
const LAPTOP_CODES: [RegExp, string][] = [
  [/(?<![A-Za-z0-9])[SR]-\d{3}(?![0-9])/g, "a registry or rule number"],
  [/(?<![A-Za-z0-9/._-])[CDF]\d{1,2}(?![A-Za-z0-9])/g, "a build piece's code"],
  [/\bwave \d\b/gi, "a build wave"],
  [/(?<![0-9A-Za-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}(?![0-9A-Za-z])/g, "a commit's id"],
];

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
export function unreadable(words: string[], items: ReadonlySet<string> | null): string[] {
  const out: string[] = [];
  for (const w of words) {
    for (const h of check(w, { rules: [...LAPTOP_RULES], refusable: true }).hits) out.push(`"${h.around}" (${WHY[h.rule]})`);
    for (const h of codesHits(w, items)) out.push(`"${h.around}" (a record code he can't read)`);
    const seen = w.replace(/\]\([^)]*\)/g, "]()");                     // a link's target isn't shown
    for (const [re, what] of LAPTOP_CODES) for (const m of seen.matchAll(re)) out.push(`"${m[0]}" (${what})`);
  }
  return [...new Set(out)];
}

if (import.meta.main) {
  const pass = (): never => process.exit(0);
  try {
    const input = JSON.parse(await Bun.stdin.text());
    if (input?.stop_hook_active === true) pass();
    const words = turnWords(readFileSync(String(input?.transcript_path ?? ""), "utf8").split("\n"));
    let items: Set<string> | null = null;
    const c = clone(process.env.RECORD_CLONE);
    if (!("error" in c)) items = recordItems(treeAt(c).read("state/PENDING.md"));
    const found = unreadable(words, items);
    if (!found.length) pass();
    const reason = `What you showed him this turn has words he can't read: ${found.slice(0, 8).join("; ")}${found.length > 8 ? `; and ${found.length - 8} more of the same kinds` : ""}. `
      + "Send him the lines that held them again, said plainly: things named by what they do for him, no codes or ids, no em dashes. Say nothing about this check.";
    console.log(JSON.stringify({ decision: "block", reason }));
  } catch { /* never blocks for good */ }
  pass();
}
