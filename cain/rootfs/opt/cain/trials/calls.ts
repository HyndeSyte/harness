// The trials' own calls (Cain 0.19.0, first review round). Every request carries its hard ceilings (core.ts
// LIMITS) and goes out through the Wire the runner makes for that one call (guard.ts), so the private-terms
// check reads the final serialized request. The review-seats suite sends each brief with the review
// service's own prompt and answer schema (review/core.ts prompt, ANSWER_SCHEMA), as the seat does, but
// through these adapters, which add the ceilings the seats don't need for real reviews.
//
// Read 2026-11-22:
// - Claude (platform.claude.com, web search and web fetch tool pages): web_search_20260318 and
//   web_fetch_20260318 are the latest types; max_uses caps each; allowed_callers ["direct"] turns dynamic
//   filtering off so search results come back as citation blocks; web fetch citations are off unless asked;
//   count_tokens refuses server tools, so the check before any spend is a 16-token call with the tools on.
//   max_tokens covers thinking.
// - Perplexity Agent API (its Python SDK's request and response types; the docs site wasn't reachable from
//   the build): preset is a string field (the presets page names the levels fast, low and medium); model
//   pins a model, and response.model names the one that answered; max_steps (1 to 100) and
//   max_output_tokens cap a run; the web_search tool takes max_tokens; fetch_url is a tool of its own, left
//   out here; output items of type "message" carry output_text parts with annotations, and items of type
//   "search_results" carry the queries; usage.cost.total_cost is the bill in USD.
// - Codex CLI (openai/codex at its current head): `codex debug models` prints the model catalog as one JSON
//   object; exec takes --ignore-user-config (no config.toml, so no MCP servers), -c web_search="disabled",
//   --sandbox read-only, -C, --ephemeral, --json, -o, --output-schema, -m; `codex --version` prints it. It has
//   no output-token or turn setting: exec runs one turn, and model_context_window bounds what it reads.
// - Gemini API (its Python SDK's types): maxOutputTokens and thinkingConfig.thinkingBudget; whether thinking
//   counts inside maxOutputTokens isn't stated, so both are counted at the output price.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWER_SCHEMA, SeatError, prompt, validateAnswer, type Answer, type Outbound } from "../review/core.ts";
import { postJson } from "../review/seats/common.ts";
import { classifyCodex } from "../review/seats/openai.ts";
import { GROUNDING_USD, LIMITS, estimateUsd, lastJson } from "./core.ts";
import { CLAUDE_SEARCH_USD, PERPLEXITY_SEARCH_USD } from "../review/core.ts";
import type { Wire } from "./guard.ts";

export type AskInput = {
  wire: Wire; signal: AbortSignal; day: string; model: string;
  system?: string; user?: string;               // a research answer or a grade
  brief?: Outbound;                             // a review (the review service's prompt and schema)
  maxOut: number; thinking?: number;
  search?: boolean; maxSearches?: number;
  fetch?: boolean; maxFetches?: number; allowedDomains?: string[];
  setting?: string; maxSteps?: number;          // Perplexity preset and steps
  schema?: object;                              // a JSON answer in this shape (grades)
};
// bill: the provider's own figure (billed), or tokens at the list price (estimated); null when there is no
// usable figure, so the reservation stands.
export type Bill = { usd: number; how: "billed" | "estimated" } | null;
export type AskResult = {
  text: string; json?: any; answer?: Answer; urls: string[]; served: string; bill: Bill;
  tokens: { input: number; output: number }; searches: number;
};
export type AskFn = (input: AskInput) => Promise<AskResult>;
export type ValidateFn = (input: Omit<AskInput, "maxOut"> & { maxOut?: number }) => Promise<{ bill: Bill }>;
export type Provider = { ask: AskFn; validate?: ValidateFn };
export type CodexProvider = Provider & {
  version: (wire: Wire, signal: AbortSignal) => Promise<string | null>;
  models: (wire: Wire, signal: AbortSignal) => Promise<string[] | null>;
};

const uniq = (xs: string[]) => [...new Set(xs.filter((u) => /^https?:\/\//i.test(u)))].slice(0, 40);
const URLS = /https?:\/\/[^\s)\]>"']+/g;
const withBill = (cost: number | null, how: "billed" | "estimated" = "estimated"): Bill => (cost === null || !Number.isFinite(cost) ? null : { usd: cost, how });
const reviewPrompt = (b: Outbound, role: "reviewer" | "facts") => prompt(b, role);

// ---- Claude ----
export const CLAUDE_SEARCH_TOOL = "web_search_20260318";
export const CLAUDE_FETCH_TOOL = "web_fetch_20260318";
export function claudeTools(i: Pick<AskInput, "search" | "maxSearches" | "fetch" | "maxFetches" | "allowedDomains">): any[] {
  const tools: any[] = [];
  if (i.search) tools.push({ type: CLAUDE_SEARCH_TOOL, name: "web_search", max_uses: i.maxSearches ?? 1, allowed_callers: ["direct"] });
  if (i.fetch) tools.push({ type: CLAUDE_FETCH_TOOL, name: "web_fetch", max_uses: i.maxFetches ?? 1, max_content_tokens: LIMITS.claudeFetchTokens,
    allowed_callers: ["direct"], ...(i.allowedDomains?.length ? { allowed_domains: i.allowedDomains.slice(0, 64) } : {}) });
  return tools;
}
export function claudeProvider(o: { key: string; base?: string; version?: string }): Provider {
  const base = o.base ?? "https://api.anthropic.com";
  const headers = () => ({ "x-api-key": o.key, "anthropic-version": o.version ?? "2026-10-21" });
  const ask: AskFn = async (input) => {
    const tools = claudeTools(input);
    const body: any = { model: input.model, max_tokens: input.maxOut, system: input.system ?? "", messages: [{ role: "user", content: input.user ?? "" }] };
    if (tools.length) {
      body.tools = tools;
      if (input.schema) body.system += `\nEnd your answer with only a JSON object of this shape, nothing after it: ${JSON.stringify(input.schema)}`;
    } else if (input.schema) body.output_config = { format: { type: "json_schema", schema: input.schema } };
    // One request: a paused turn isn't continued, so the steps stay within the tool uses plus one.
    const j = await postJson(input.wire.fetch, `${base}/v1/messages`, headers(), body, input.signal, [o.key]);
    const u = j?.usage;
    const inT = Number(u?.input_tokens ?? 0) + Number(u?.cache_read_input_tokens ?? 0) + Number(u?.cache_creation_input_tokens ?? 0);
    const outT = Number(u?.output_tokens ?? 0);
    const searches = Number(u?.server_tool_use?.web_search_requests ?? 0);
    const est = u && Number.isFinite(inT) && Number.isFinite(outT) && (inT > 0 || outT > 0) ? estimateUsd(input.model, input.day, inT, outT) : null;
    const bill = withBill(est === null ? null : est + searches * CLAUDE_SEARCH_USD);
    const blocks = Array.isArray(j?.content) ? j.content : [];
    let text = ""; const urls: string[] = [];
    for (const b of blocks) if (b?.type === "text") {
      text += b.text ?? "";
      for (const c of Array.isArray(b.citations) ? b.citations : []) if (typeof c?.url === "string") urls.push(c.url);
    }
    const stop = String(j?.stop_reason ?? "");
    const cost = bill?.usd ?? 0;
    if (stop === "refusal") throw new SeatError("refused", "Claude declined", cost);
    if (stop === "max_tokens") throw new SeatError("bad_output", "the answer ran out of room before it finished", cost);
    if (stop === "pause_turn") throw new SeatError("bad_output", "the turn paused at its tool limit before it finished", cost);
    if (!text.trim()) throw new SeatError("bad_output", "an empty answer", cost);
    const json = input.schema ? lastJson(text) : undefined;
    if (input.schema && !json) throw new SeatError("bad_output", "the answer was not JSON", cost);
    for (const m of text.matchAll(URLS)) urls.push(m[0]);
    return { text, json, urls: uniq(urls), served: String(j?.model ?? input.model), bill, tokens: { input: inT, output: outT }, searches };
  };
  // The check before any spend: the same model and tool types, 16 tokens out.
  const validate: ValidateFn = async (input) => {
    const tools = claudeTools(input);
    const body: any = { model: input.model, max_tokens: input.maxOut ?? LIMITS.validateOut, messages: [{ role: "user", content: "Reply with the word ready." }], ...(tools.length ? { tools } : {}) };
    const j = await postJson(input.wire.fetch, `${base}/v1/messages`, headers(), body, input.signal, [o.key]);
    const u = j?.usage;
    return { bill: withBill(u ? estimateUsd(input.model, input.day, Number(u.input_tokens ?? 0), Number(u.output_tokens ?? 0)) : null) };
  };
  return { ask, validate };
}

// ---- Gemini ----
const geminiSchema = (schemaField: "responseFormat" | "responseJsonSchema", schema: object) => schemaField === "responseJsonSchema"
  ? { responseMimeType: "application/json", responseJsonSchema: schema }
  : { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } } };
// A grounding redirect names its provider: its page's domain (the chunk's title) stands in for it.
export function groundingUrls(cand: any): string[] {
  const out: string[] = [];
  for (const c of cand?.groundingMetadata?.groundingChunks ?? []) {
    const uri = String(c?.web?.uri ?? ""), title = String(c?.web?.title ?? "").trim();
    if (/grounding-api-redirect|vertexaisearch/.test(uri)) { if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) out.push(`https://${title}`); }
    else if (uri) out.push(uri);
  }
  return out;
}
export function geminiProvider(o: { key: string; base?: string; schemaField?: "responseFormat" | "responseJsonSchema" }): Provider {
  const base = o.base ?? "https://generativelanguage.googleapis.com";
  const field = o.schemaField ?? "responseFormat";
  const call = async (input: AskInput, maxOut: number, system: string, user: string, schema?: object) => {
    const body: any = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxOut, thinkingConfig: { thinkingBudget: input.thinking ?? LIMITS.geminiThinking }, ...(schema ? geminiSchema(field, schema) : {}) },
    };
    if (input.search) body.tools = [{ googleSearch: {} }];
    return postJson(input.wire.fetch, `${base}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, { "x-goog-api-key": o.key }, body, input.signal, [o.key]);
  };
  const billOf = (j: any, input: AskInput) => {
    const u = j?.usageMetadata;
    if (!u) return { bill: null as Bill, inT: 0, outT: 0 };
    const inT = Number(u.promptTokenCount ?? 0) + Number(u.toolUsePromptTokenCount ?? 0);
    const outT = Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0);
    const est = estimateUsd(input.model, input.day, inT, outT);
    const grounded = input.search && !!j?.candidates?.[0]?.groundingMetadata;
    return { bill: withBill(est === null ? null : est + (grounded ? GROUNDING_USD : 0)), inT, outT };
  };
  const ask: AskFn = async (input) => {
    const p = input.brief ? reviewPrompt(input.brief, "reviewer") : { system: input.system ?? "", user: input.user ?? "" };
    const j = await call(input, input.maxOut, p.system, p.user, input.brief ? ANSWER_SCHEMA : input.schema);
    if (j?.promptFeedback?.blockReason) throw new SeatError("refused", `Gemini blocked it (${String(j.promptFeedback.blockReason).slice(0, 40)})`);
    const cand = j?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((x: any) => typeof x?.text === "string" && !x.thought).map((x: any) => x.text).join("");
    const { bill, inT, outT } = billOf(j, input);
    const cost = bill?.usd ?? 0;
    if (cand?.finishReason === "MAX_TOKENS") throw new SeatError("bad_output", "the answer ran out of room before it finished", cost);
    if (!text.trim()) throw new SeatError("bad_output", "an empty answer", cost);
    const urls = groundingUrls(cand);
    for (const m of text.matchAll(URLS)) urls.push(m[0]);
    let answer: Answer | undefined; let json: any;
    if (input.brief) { const v = validateAnswer(text); if (!v.answer) throw new SeatError("bad_output", v.error!, cost); answer = v.answer; }
    else if (input.schema) { json = lastJson(text); if (!json) throw new SeatError("bad_output", "the answer was not JSON", cost); }
    return { text, json, answer, urls: uniq(urls), served: String(j?.modelVersion ?? input.model), bill, tokens: { input: inT, output: outT },
      searches: (cand?.groundingMetadata?.webSearchQueries ?? []).length };
  };
  // The check before any spend: the same model and generation settings, 16 tokens out. A model Google
  // doesn't serve answers 404; settings it won't take answer 400.
  const validate: ValidateFn = async (input) => {
    const full = { ...input, maxOut: input.maxOut ?? LIMITS.validateOut } as AskInput;
    const j = await call(full, full.maxOut, "Reply with the word ready.", "ready?");
    return { bill: billOf(j, full).bill };
  };
  return { ask, validate };
}

// ---- Perplexity Agent API ----
export const PERPLEXITY_PRESET_FIELD = "preset";
export function perplexityProvider(o: { key: string; base?: string }): Provider {
  const base = o.base ?? "https://api.perplexity.ai";
  const ask: AskFn = async (input) => {
    const p = input.brief ? reviewPrompt(input.brief, "facts") : { system: input.system ?? "", user: input.user ?? "" };
    const body: any = { input: p.user, instructions: p.system, max_output_tokens: input.maxOut, max_steps: input.maxSteps ?? LIMITS.perplexitySteps,
      tools: input.search ? [{ type: "web_search", max_tokens: LIMITS.perplexitySearchTokens }] : [] };
    if (input.setting) body[PERPLEXITY_PRESET_FIELD] = input.setting;
    if (input.model) body.model = input.model;
    if (input.brief) body.response_format = { type: "json_schema", json_schema: { name: "review", schema: ANSWER_SCHEMA } };
    const j = await postJson(input.wire.fetch, `${base}/v1/agent`, { authorization: `Bearer ${o.key}` }, body, input.signal, [o.key]);
    const served = typeof j?.model === "string" ? j.model : "";
    const u = j?.usage;
    const inT = Number(u?.input_tokens ?? 0), outT = Number(u?.output_tokens ?? 0);
    const searches = Number(u?.tool_calls_details?.web_search?.invocation ?? u?.tool_calls_details?.search_web?.invocation ?? u?.tool_calls_details?.web_search ?? 0) || 0;
    const billed = Number(u?.cost?.total_cost);
    let bill: Bill = null;
    if (Number.isFinite(billed) && billed >= 0 && u?.cost?.total_cost !== null && u?.cost?.total_cost !== undefined) bill = { usd: billed, how: "billed" };
    else if (u && served) { const est = estimateUsd(served, input.day, inT, outT); bill = withBill(est === null ? null : est + searches * PERPLEXITY_SEARCH_USD); }
    if (j?.status && !["completed", "succeeded"].includes(String(j.status)))
      throw new SeatError(j.status === "failed" ? "transient" : "bad_output", `the run ended as ${String(j.status).slice(0, 30)}`, bill?.usd ?? 0);
    let text = ""; const urls: string[] = [];
    for (const item of Array.isArray(j?.output) ? j.output : []) {
      if (item?.type === "message") for (const c of item.content ?? []) {
        if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
        for (const a of c?.annotations ?? []) if (typeof a?.url === "string") urls.push(a.url);
      }
      if (item?.type === "search_results") for (const r of item.results ?? []) if (typeof r?.url === "string") urls.push(r.url);
    }
    if (!text && typeof j?.output_text === "string") text = j.output_text;
    for (const m of text.matchAll(URLS)) urls.push(m[0]);
    const cost = bill?.usd ?? 0;
    if (!text.trim()) throw new SeatError("bad_output", "an empty answer", cost);
    let answer: Answer | undefined;
    if (input.brief) { const v = validateAnswer(text, true); if (!v.answer) throw new SeatError("bad_output", v.error!, cost); answer = v.answer; }
    return { text, answer, urls: uniq(urls), served: served || input.model || `preset ${input.setting ?? ""}`.trim(), bill, tokens: { input: inT, output: outT }, searches };
  };
  return { ask };
}

// ---- Codex: codex exec in a fresh, empty folder, with nothing of Cain's ----
// No repository, no /data path, no config.toml (so no MCP servers), web search off, a read-only sandbox,
// an environment of PATH, CODEX_HOME (its sign-in), HOME (an empty folder) and LANG only, and the prompt as
// its one argument. It must use no tool: any tool event in its stream fails the call.
export class CodexToolUse extends SeatError {
  constructor(tools: string[]) { super("refused", `Codex used a tool (${[...new Set(tools)].join(", ")}); its answer isn't kept`); }
}
export const CODEX_NO_MODEL = /(model|engine)[^\n]{0,60}(not (found|supported|available|exist)|does not exist|unknown|invalid|unsupported|isn't available|is not available|no access)|unknown model|unsupported model|invalid model/i;
export function codexBase(o: { bin: string; work: string; out: string; schema?: string; model?: string }): string[] {
  const cmd = [o.bin, "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--sandbox", "read-only", "-C", o.work, "-o", o.out, "--json",
    "-c", 'web_search="disabled"', "-c", 'approval_policy="never"', "-c", `model_context_window=${LIMITS.codexContextWindow}`];
  if (o.schema) cmd.push("--output-schema", o.schema);
  if (o.model) cmd.push("-m", o.model);
  return cmd;
}
export function codexProvider(o: { home: string; bin?: string; scratch?: string; signedIn?: (home: string) => boolean }): CodexProvider {
  const bin = o.bin ?? "codex";
  const signedIn = o.signedIn ?? ((h: string) => existsSync(join(h, "auth.json")));
  const env = (home: string) => ({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CODEX_HOME: o.home, HOME: home, LANG: "C.UTF-8" });
  const fresh = () => {
    const tmp = mkdtempSync(join(o.scratch ?? tmpdir(), "codex-trial-"));
    const work = join(tmp, "work"); mkdirSync(work);
    const home = join(tmp, "home"); mkdirSync(home);
    return { tmp, work, home };
  };
  const ask: AskFn = async (input) => {
    if (!signedIn(o.home)) throw new SeatError("unconfigured", "Codex isn't signed in to ChatGPT yet");
    const { tmp, work, home } = fresh();
    try {
      const out = join(tmp, "answer.txt");
      const schemaObj = input.brief ? ANSWER_SCHEMA : input.schema;
      let schema: string | undefined;
      if (schemaObj) { schema = join(tmp, "schema.json"); writeFileSync(schema, JSON.stringify(schemaObj)); }
      // A review is sent with the review prompt, but with no search: Codex runs with no network here.
      const p = input.brief ? reviewPrompt({ ...input.brief, needs_facts: false }, "reviewer") : { system: input.system ?? "", user: input.user ?? "" };
      const cmd = [...codexBase({ bin, work, out, schema, model: input.model || undefined }), `${p.system}\nUse no tools and run no commands: everything you need is below.\n\n${p.user}`];
      let r;
      try { r = await input.wire.exec(cmd, { env: env(home), signal: input.signal }); }
      catch (e) { if (e instanceof SeatError) throw e; throw new SeatError(input.signal.aborted ? "timeout" : "transient", `Codex didn't run: ${(e as Error).message.slice(0, 120)}`); }
      if (input.signal.aborted) throw new SeatError("timeout", "no answer before the deadline");
      let served = "", usage = { input: 0, output: 0 }, problem = "";
      for (const line of r.stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (typeof ev.model === "string") served = ev.model;
        if (typeof ev?.thread?.model === "string") served = ev.thread.model;
        if (ev.type === "turn.completed" && ev.usage) usage = {
          input: Number(ev.usage.input_tokens ?? 0) + Number(ev.usage.cached_input_tokens ?? 0),
          output: Number(ev.usage.output_tokens ?? 0) + Number(ev.usage.reasoning_output_tokens ?? 0) };
        if (ev.type === "turn.failed" || ev.type === "error") problem += ` ${ev.error?.message ?? ev.message ?? ""}`;
      }
      if (r.code !== 0 || problem.trim()) {
        const words = `${problem} ${r.stderr}`.trim();
        throw new SeatError(CODEX_NO_MODEL.test(words) ? "refused" : classifyCodex(words), `Codex: ${words.replace(/\s+/g, " ").slice(0, 200) || `exit ${r.code}`}`);
      }
      if (input.wire.codexTools.length) throw new CodexToolUse(input.wire.codexTools);
      if (!existsSync(out)) throw new SeatError("bad_output", "Codex finished without a final answer");
      const text = readFileSync(out, "utf8");
      let answer: Answer | undefined; let json: any;
      if (input.brief) { const v = validateAnswer(text); if (!v.answer) throw new SeatError("bad_output", v.error!); answer = v.answer; }
      else if (input.schema) { json = lastJson(text); if (!json) throw new SeatError("bad_output", "Codex's answer was not JSON"); }
      // The ChatGPT plan: no dollars, one run.
      return { text, json, answer, urls: [], served: served || input.model || "Codex default model", bill: { usd: 0, how: "billed" }, tokens: usage, searches: 0 };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  };
  const version = async (wire: Wire, signal: AbortSignal) => {
    const { tmp, home } = fresh();
    try { const r = await wire.exec([bin, "--version"], { env: env(home), signal }); return r.code === 0 ? (r.stdout.trim().split("\n")[0] ?? "").slice(0, 80) || null : null; }
    catch { return null; } finally { rmSync(tmp, { recursive: true, force: true }); }
  };
  // Best effort: the catalog `codex debug models` prints, or null when it can't be read.
  const models = async (wire: Wire, signal: AbortSignal) => {
    const { tmp, home } = fresh();
    try {
      const r = await wire.exec([bin, "debug", "models"], { env: env(home), signal });
      if (r.code !== 0) return null;
      return modelsFromCatalog(JSON.parse(r.stdout));
    } catch { return null; } finally { rmSync(tmp, { recursive: true, force: true }); }
  };
  return { ask, version, models };
}
// Model names from the catalog's JSON, whatever its nesting: every slug, id or model field, and the keys of
// a models map.
export function modelsFromCatalog(j: any): string[] | null {
  const out = new Set<string>();
  const walk = (v: any, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const k of ["slug", "id", "model", "name"]) if (typeof v[k] === "string" && /^[a-z0-9][\w.:-]{1,60}$/i.test(v[k])) out.add(v[k]);
    for (const [k, x] of Object.entries(v)) {
      if (k === "models" && x && typeof x === "object" && !Array.isArray(x)) for (const name of Object.keys(x)) out.add(name);
      walk(x, depth + 1);
    }
  };
  walk(j, 0);
  return out.size ? [...out] : null;
}
