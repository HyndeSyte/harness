// The private-terms check on the wire (Cain 0.19.0, first review round). Every trial and grading call goes
// out through a Wire made for that one call: its fetch checks the final serialized request (every string in
// the JSON body, the system prompt, the rubric, the answer notes, every candidate, tool arguments, and the
// URL) immediately before it is sent, and its exec checks Codex's whole command line, environment and any
// file handed to it. A hit throws PrivacyBlock before anything leaves: fail closed. Retries go through the
// same Wire, so they are checked again.
//
// It also reads what came back for the search queries a provider says it ran (Gemini's webSearchQueries,
// Claude's server tool calls, Perplexity's search results, Codex's events), so the runner can log them and
// check them afterwards. What the check can't cover: text a provider generates itself, such as a query it
// writes from the question. That is checked only after the fact, and a hit raises an alarm.
import { textCheck, SeatError } from "../review/core.ts";
import type { Fetch } from "../review/seats/common.ts";
import type { Exec } from "../review/seats/openai.ts";
import { existsSync, readFileSync, statSync } from "node:fs";

export class PrivacyBlock extends SeatError {
  readonly notSent = true;
  constructor(public why: string[]) { super("refused", `blocked: privacy on the wire (${why.join("; ")}); nothing was sent`); }
}
// Every string in a JSON value, keys included, so an escape can't hide a term.
export function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); stringsOf(x, out); }
  return out;
}
// A protocol constant whose whole value is a dated tool type (web_search_20260318) isn't text of anyone's: it
// is left out, so its date isn't read as an account number. Only a whole string of exactly that shape is.
const PROTOCOL = /^(?:web_search|web_fetch|code_execution|computer|text_editor|bash)_\d{8}$/;
export function wireText(body: unknown): string {
  const keep = (xs: string[]) => xs.filter((x) => !PROTOCOL.test(x)).join("\n");
  if (typeof body !== "string") return keep(stringsOf(body));
  try { return keep(stringsOf(JSON.parse(body))); } catch { return body; }
}

// The search queries (and fetched addresses) a provider's answer says it used.
export function extractQueries(j: any): string[] {
  const q: string[] = [];
  for (const c of Array.isArray(j?.candidates) ? j.candidates : []) for (const s of c?.groundingMetadata?.webSearchQueries ?? []) if (typeof s === "string") q.push(s);
  for (const b of Array.isArray(j?.content) ? j.content : []) {
    if (b?.type === "server_tool_use" && typeof b.input?.query === "string") q.push(b.input.query);
    if (b?.type === "server_tool_use" && typeof b.input?.url === "string") q.push(`fetch ${b.input.url}`);
  }
  for (const it of Array.isArray(j?.output) ? j.output : []) {
    if (it?.type === "search_results") for (const s of it.queries ?? []) if (typeof s === "string") q.push(s);
    if (it?.type === "web_search_call" && typeof it.action?.query === "string") q.push(it.action.query);
  }
  return q;
}
// Codex's JSONL events: the queries it searched, and whether it used any tool at all (it must use none).
const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "patch_apply", "exec_command"]);
export function codexEvents(stdout: string): { queries: string[]; tools: string[] } {
  const queries: string[] = [], tools: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    const it = ev?.item ?? ev?.msg ?? ev;
    const t = String(it?.type ?? "");
    if (CODEX_TOOL_ITEMS.has(t)) { tools.push(t); if (typeof it.query === "string") queries.push(it.query); }
  }
  return { queries, tools };
}

export type Wire = { fetch: Fetch; exec: Exec; queries: string[]; codexTools: string[]; sent: number };
export function makeWire(o: { terms: () => string | null; fetch: Fetch; exec: Exec }): Wire {
  const w: Wire = { queries: [], codexTools: [], sent: 0, fetch: null as any, exec: null as any };
  const check = (text: string) => {
    const c = textCheck(text, o.terms());
    if (!c.ok) throw new PrivacyBlock((c as { why: string[] }).why);
  };
  w.fetch = async (url, init) => {
    check(`${url}\n${wireText(init?.body ?? "")}`);
    w.sent++;
    const r = await o.fetch(url, init);
    try { const j = await r.clone().json(); w.queries.push(...extractQueries(j)); } catch { /* not JSON, or cut off */ }
    return r;
  };
  w.exec = async (cmd, opts) => {
    const files: string[] = [];
    for (const a of cmd) {
      try { if (a.startsWith("/") && a.length < 4096 && existsSync(a) && statSync(a).isFile() && statSync(a).size < 2_000_000) files.push(readFileSync(a, "utf8")); } catch { /* not a file */ }
    }
    check([...cmd, ...Object.values(opts.env), ...files].join("\n"));
    w.sent++;
    const r = await o.exec(cmd, opts);
    const ev = codexEvents(r.stdout);
    w.queries.push(...ev.queries); w.codexTools.push(...ev.tools);
    return r;
  };
  return w;
}
