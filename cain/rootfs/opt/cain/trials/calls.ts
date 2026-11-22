// The trials' own calls (Cain 0.19.0, first review round). Every request carries its hard ceilings (core.ts
// LIMITS) and goes out through the Wire the runner makes for that one call (guard.ts), so the private-terms
// check reads the final serialized request. The review-seats suite sends each brief with the review
// service's own prompt and answer schema (review/core.ts prompt, ANSWER_SCHEMA), as the seat does, but
// through these adapters, which add the ceilings the seats don't need for real reviews.
//
// Read 2026-11-22 (second review round; DOCS.md "Provider contracts" has the detail and what each page left open):
// - Claude (platform.claude.com, read directly): web_search_20260318 and web_fetch_20260318 are the latest types;
//   max_uses caps each; allowed_callers ["direct"] turns dynamic filtering off; web fetch takes
//   max_content_tokens and allowed_domains and costs only tokens; search is $10 per 1,000 and its results
//   count as input (no documented ceiling on their size); max_tokens covers thinking.
// - Perplexity Agent API (docs.perplexity.ai through search results limited to it): the level goes in
//   `effort` (`preset` read back as an alias); model overrides the level's model; max_steps and
//   max_output_tokens cap a run; the web_search tool's max_tokens caps each call's search context; fetch_url
//   is a tool of its own, left out; usage.cost.total_cost is the bill and usage.tool_calls_details.search_web
//   the searches; the priority tier is 2x the token rates.
// - Codex CLI (openai/codex at its head): exec takes --ignore-user-config (rules in CODEX_HOME/rules still load),
//   -c overrides (web_search="disabled", default_permissions=":read-only", features.daemon_auto_start=false),
//   -C, --ephemeral, --json, -o, --output-schema, -m; it has no output-token or turn setting: exec runs one turn,
//   and model_context_window bounds what it reads.
// - Gemini API (ai.google.dev through search results limited to it): thinkingLevel on Gemini 4 Argon and 3.8
//   Flash (thinkingBudget deprecated on Gemini 4, a 400 beside thinkingLevel); Argon's maxOutputTokens counts
//   thought tokens; grounding is billed per search query on Gemini 3 and newer.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { freshDirs, judgeSelfTest, selfTestPrompt, which, wrap, type Dirs, type Isolation, type IsolationMode, type SandboxSetup } from "./sandbox.ts";
import { ANSWER_SCHEMA, SeatError, prompt, validateAnswer, type Answer, type ErrorKind, type Outbound } from "../review/core.ts";
import { postJson } from "../review/seats/common.ts";
import { classifyCodex } from "../review/seats/openai.ts";
import { GROUNDING_USD, LIMITS, estimateUsd, geminiModel, lastJson, perplexityPrice } from "./core.ts";
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
  codexMode?: IsolationMode;                    // Codex: the isolation the run's self-test proved
};
// bill: the provider's own figure (billed), or tokens at the list price (estimated); null when there is no
// usable figure, so the reservation stands. Codex on the plan has no bill at all ("plan call").
export type Bill = { usd: number; how: "billed" | "estimated" | "plan call" } | null;
// What the answer said about usage: none (no usage block), zero (a usage block showing nothing used), or some.
// Only "zero" (or an HTTP 4xx with no usage) releases a reservation (runner.ts).
export type Usage = "none" | "zero" | "some";
export type AskResult = {
  text: string; json?: any; answer?: Answer; urls: string[]; served: string; bill: Bill;
  tokens: { input: number; output: number }; searches: number; usage?: Usage;
};
export type AskFn = (input: AskInput) => Promise<AskResult>;
export type ValidateFn = (input: Omit<AskInput, "maxOut"> & { maxOut?: number }) => Promise<{ bill: Bill; served?: string; usage?: Usage }>;
export type Provider = { ask: AskFn; validate?: ValidateFn };
export type CodexProvider = Provider & {
  version: (wire: Wire, signal: AbortSignal, mode?: IsolationMode) => Promise<string | null>;
  models: (wire: Wire, signal: AbortSignal, mode?: IsolationMode) => Promise<string[] | null>;
  isolation: (wire: Wire, signal: AbortSignal) => Promise<Isolation>;
};
// An error that carries what the provider said about usage, so a reservation is released only on an
// authoritative zero.
export function withUsage<E extends SeatError>(e: E, usage: Usage): E { (e as any).usage = usage; return e; }
export const usageOf = (e: unknown): Usage => ((e as any)?.usage === "zero" || (e as any)?.usage === "some" ? (e as any).usage : "none");

const uniq = (xs: string[]) => [...new Set(xs.filter((u) => /^https?:\/\//i.test(u)))].slice(0, 40);
const URLS = /https?:\/\/[^\s)\]>"']+/g;
const withBill = (cost: number | null, how: "billed" | "estimated" = "estimated"): Bill => (cost === null || !Number.isFinite(cost) ? null : { usd: cost, how });
const reviewPrompt = (b: Outbound, role: "reviewer" | "facts") => prompt(b, role);
const tokenUsage = (present: boolean, inT: number, outT: number, extra = 0): Usage => (!present ? "none" : inT + outT + extra > 0 ? "some" : "zero");

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
  const read = (j: any, input: { model: string; day: string }) => {
    const u = j?.usage;
    const inT = Number(u?.input_tokens ?? 0) + Number(u?.cache_read_input_tokens ?? 0) + Number(u?.cache_creation_input_tokens ?? 0);
    const outT = Number(u?.output_tokens ?? 0);
    const searches = Number(u?.server_tool_use?.web_search_requests ?? 0) || 0;
    const ok = !!u && Number.isFinite(inT) && Number.isFinite(outT);
    const usage = tokenUsage(ok, inT, outT, searches);
    const est = ok ? estimateUsd(input.model, input.day, inT, outT) : null;
    return { inT, outT, searches, usage, bill: usage === "zero" ? { usd: 0, how: "estimated" as const } : withBill(est === null ? null : est + searches * CLAUDE_SEARCH_USD) };
  };
  const ask: AskFn = async (input) => {
    const tools = claudeTools(input);
    const body: any = { model: input.model, max_tokens: input.maxOut, system: input.system ?? "", messages: [{ role: "user", content: input.user ?? "" }] };
    if (tools.length) {
      body.tools = tools;
      if (input.schema) body.system += `\nEnd your answer with only a JSON object of this shape, nothing after it: ${JSON.stringify(input.schema)}`;
    } else if (input.schema) body.output_config = { format: { type: "json_schema", schema: input.schema } };
    // One request: a paused turn isn't continued, so the steps stay within the tool uses plus one.
    const j = await postJson(input.wire.fetch, `${base}/v1/messages`, headers(), body, input.signal, [o.key]);
    const { inT, outT, searches, usage, bill } = read(j, input);
    const blocks = Array.isArray(j?.content) ? j.content : [];
    let text = ""; const urls: string[] = [];
    for (const b of blocks) if (b?.type === "text") {
      text += b.text ?? "";
      for (const c of Array.isArray(b.citations) ? b.citations : []) if (typeof c?.url === "string") urls.push(c.url);
    }
    const stop = String(j?.stop_reason ?? "");
    const cost = bill?.usd ?? 0;
    const fail = (kind: ErrorKind, why: string) => withUsage(new SeatError(kind, why, cost), usage);
    if (stop === "refusal") throw fail("refused", "Claude declined");
    if (stop === "max_tokens") throw fail("bad_output", "the answer ran out of room before it finished");
    if (stop === "pause_turn") throw fail("bad_output", "the turn paused at its tool limit before it finished");
    if (!text.trim()) throw fail("bad_output", "an empty answer");
    const json = input.schema ? lastJson(text) : undefined;
    if (input.schema && !json) throw fail("bad_output", "the answer was not JSON");
    for (const m of text.matchAll(URLS)) urls.push(m[0]);
    return { text, json, urls: uniq(urls), served: String(j?.model ?? input.model), bill, tokens: { input: inT, output: outT }, searches, usage };
  };
  // The check before any spend, from the installed build: the same model, the suite's tool paths (web search
  // max_uses 1, and the grader's fetch where the suite uses it), a tiny output cap.
  const validate: ValidateFn = async (input) => {
    const tools = claudeTools(input);
    const body: any = { model: input.model, max_tokens: input.maxOut ?? LIMITS.validateOut, messages: [{ role: "user", content: "Reply with the word ready." }], ...(tools.length ? { tools } : {}) };
    const j = await postJson(input.wire.fetch, `${base}/v1/messages`, headers(), body, input.signal, [o.key]);
    const r = read(j, input);
    return { bill: r.bill, served: String(j?.model ?? input.model), usage: r.usage };
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
// The generation settings a model gets: maxOutputTokens, and only the thinking field its docs say it takes
// (core.ts GEMINI_MODELS): thinkingLevel on the Gemini 4 and 3.8 models (sending thinkingBudget with it is a
// 400 there), thinkingBudget only where a model is listed with one.
export function geminiGeneration(model: string, maxOut: number): any {
  const g = geminiModel(model);
  return { maxOutputTokens: maxOut, thinkingConfig: "level" in g.thinking ? { thinkingLevel: g.thinking.level } : { thinkingBudget: g.thinking.budget } };
}
export function geminiProvider(o: { key: string; base?: string; schemaField?: "responseFormat" | "responseJsonSchema" }): Provider {
  const base = o.base ?? "https://generativelanguage.googleapis.com";
  const field = o.schemaField ?? "responseFormat";
  const call = async (input: AskInput, maxOut: number, system: string, user: string, schema?: object) => {
    const body: any = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { ...geminiGeneration(input.model, maxOut), ...(schema ? geminiSchema(field, schema) : {}) },
    };
    if (input.search) body.tools = [{ googleSearch: {} }];
    return postJson(input.wire.fetch, `${base}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, { "x-goog-api-key": o.key }, body, input.signal, [o.key]);
  };
  const billOf = (j: any, input: AskInput) => {
    const u = j?.usageMetadata;
    if (!u) return { bill: null as Bill, inT: 0, outT: 0, usage: "none" as Usage };
    const inT = Number(u.promptTokenCount ?? 0) + Number(u.toolUsePromptTokenCount ?? 0);
    const outT = Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0);
    const usage = tokenUsage(true, inT, outT);
    const est = estimateUsd(input.model, input.day, inT, outT);
    // Grounding on Gemini 3 and newer is billed per search query the model ran (the free share is ignored here).
    const queries = input.search ? (j?.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? []).length : 0;
    return { bill: usage === "zero" ? { usd: 0, how: "estimated" as const } : withBill(est === null ? null : est + queries * GROUNDING_USD), inT, outT, usage };
  };
  const ask: AskFn = async (input) => {
    const p = input.brief ? reviewPrompt(input.brief, "reviewer") : { system: input.system ?? "", user: input.user ?? "" };
    const j = await call(input, input.maxOut, p.system, p.user, input.brief ? ANSWER_SCHEMA : input.schema);
    const { bill, inT, outT, usage } = billOf(j, input);
    const cost = bill?.usd ?? 0;
    const fail = (kind: ErrorKind, why: string) => withUsage(new SeatError(kind, why, cost), usage);
    if (j?.promptFeedback?.blockReason) throw fail("refused", `Gemini blocked it (${String(j.promptFeedback.blockReason).slice(0, 40)})`);
    const cand = j?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((x: any) => typeof x?.text === "string" && !x.thought).map((x: any) => x.text).join("");
    if (cand?.finishReason === "MAX_TOKENS") throw fail("bad_output", "the answer ran out of room before it finished");
    if (!text.trim()) throw fail("bad_output", "an empty answer");
    const urls = groundingUrls(cand);
    for (const m of text.matchAll(URLS)) urls.push(m[0]);
    let answer: Answer | undefined; let json: any;
    if (input.brief) { const v = validateAnswer(text); if (!v.answer) throw fail("bad_output", v.error!); answer = v.answer; }
    else if (input.schema) { json = lastJson(text); if (!json) throw fail("bad_output", "the answer was not JSON"); }
    return { text, json, answer, urls: uniq(urls), served: String(j?.modelVersion ?? input.model), bill, tokens: { input: inT, output: outT },
      searches: (cand?.groundingMetadata?.webSearchQueries ?? []).length, usage };
  };
  // The check before any spend: the same model and generation settings, a tiny output. A model Google
  // doesn't serve answers 404; settings it won't take answer 400.
  const validate: ValidateFn = async (input) => {
    const full = { ...input, maxOut: input.maxOut ?? LIMITS.validateOut } as AskInput;
    const j = await call(full, full.maxOut, "Reply with the word ready.", "ready?");
    const b = billOf(j, full);
    return { bill: b.bill, served: String(j?.modelVersion ?? input.model), usage: b.usage };
  };
  return { ask, validate };
}

// ---- Perplexity Agent API ----
// The level goes in `effort` (the Agent API's field for it); a response may name it `effort` or, as an alias,
// `preset`. The fast level is priced at the priority rate (core.ts perplexityPrice).
export const PERPLEXITY_LEVEL_FIELD = "effort";
export function perplexityProvider(o: { key: string; base?: string }): Provider {
  const base = o.base ?? "https://api.perplexity.ai";
  const send = (input: AskInput, body: any) => postJson(input.wire.fetch, `${base}/v1/agent`, { authorization: `Bearer ${o.key}` }, body, input.signal, [o.key]);
  const readBill = (j: any, input: AskInput, served: string) => {
    const u = j?.usage;
    const inT = Number(u?.input_tokens ?? 0), outT = Number(u?.output_tokens ?? 0);
    const det = u?.tool_calls_details ?? {};
    const searches = Number(det?.search_web?.invocation ?? det?.web_search?.invocation ?? det?.search_web ?? det?.web_search ?? 0) || 0;
    const billed = Number(u?.cost?.total_cost);
    const usage = tokenUsage(!!u, inT, outT, searches + (Number.isFinite(billed) ? billed : 0));
    let bill: Bill = null;
    if (Number.isFinite(billed) && billed >= 0 && u?.cost?.total_cost !== null && u?.cost?.total_cost !== undefined) bill = { usd: billed, how: "billed" };
    else if (u && served) {
      const p = perplexityPrice(served, input.setting);
      bill = { usd: (inT * p.in + outT * p.out) / 1e6 + searches * PERPLEXITY_SEARCH_USD, how: "estimated" };
    }
    if (usage === "zero") bill = { usd: 0, how: bill?.how ?? "estimated" };
    return { inT, outT, searches, usage, bill };
  };
  const ask: AskFn = async (input) => {
    const p = input.brief ? reviewPrompt(input.brief, "facts") : { system: input.system ?? "", user: input.user ?? "" };
    const body: any = { input: p.user, instructions: p.system, max_output_tokens: input.maxOut, max_steps: input.maxSteps ?? LIMITS.perplexitySteps,
      tools: input.search ? [{ type: "web_search", max_tokens: LIMITS.perplexitySearchTokens }] : [] };
    if (input.setting) body[PERPLEXITY_LEVEL_FIELD] = input.setting;
    if (input.model) body.model = input.model;
    if (input.brief) body.response_format = { type: "json_schema", json_schema: { name: "review", schema: ANSWER_SCHEMA } };
    const j = await send(input, body);
    const served = typeof j?.model === "string" ? j.model : "";
    const { inT, outT, searches, usage, bill } = readBill(j, input, served || input.model);
    const cost = bill?.usd ?? 0;
    const fail = (kind: ErrorKind, why: string) => withUsage(new SeatError(kind, why, cost), usage);
    if (j?.status && !["completed", "succeeded"].includes(String(j.status))) throw fail(j.status === "failed" ? "transient" : "bad_output", `the run ended as ${String(j.status).slice(0, 30)}`);
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
    if (!text.trim()) throw fail("bad_output", "an empty answer");
    let answer: Answer | undefined;
    if (input.brief) { const v = validateAnswer(text, true); if (!v.answer) throw fail("bad_output", v.error!); answer = v.answer; }
    const level = String(j?.effort ?? j?.preset ?? input.setting ?? "");
    return { text, answer, urls: uniq(urls), served: served || input.model || `level ${level}`.trim(), bill, tokens: { input: inT, output: outT }, searches, usage };
  };
  // The check before any spend: one tiny call per level with the pinned model and no owner text, through the
  // same tool path (web search, smallest context) when the configuration searches. The served model comes back.
  const validate: ValidateFn = async (input) => {
    const full = input as AskInput;
    const body: any = { input: "Reply with the word ready.", max_output_tokens: input.maxOut ?? LIMITS.validateOut, max_steps: 1,
      tools: input.search ? [{ type: "web_search", max_tokens: LIMITS.perplexityValidateSearchTokens }] : [] };
    if (input.setting) body[PERPLEXITY_LEVEL_FIELD] = input.setting;
    if (input.model) body.model = input.model;
    const j = await send(full, body);
    const served = typeof j?.model === "string" ? j.model : "";
    const r = readBill(j, full, served || input.model);
    return { bill: r.bill, served, usage: r.usage };
  };
  return { ask, validate };
}

// ---- Codex: codex exec through the isolation wrapper (sandbox.ts), with nothing of Cain's ----
// No repository, no /data path, no config.toml (so no MCP servers), web search off, the read-only permissions
// profile, an exec policy forbidding every command, the shared daemon off, an isolated CODEX_HOME holding a
// copy of only auth.json, and the prompt as its one argument. Under bubblewrap it also has no shell, no /data
// and its own /proc. It must use no tool: any tool event in its stream fails the call. It runs only with the
// mode the run's self-test proved (input.codexMode); without one it isn't started.
export class CodexToolUse extends SeatError {
  constructor(tools: string[]) { super("refused", `Codex used a tool (${[...new Set(tools)].join(", ")}); its answer isn't kept`); }
}
export const CODEX_NO_MODEL = /(model|engine)[^\n]{0,60}(not (found|supported|available|exist)|does not exist|unknown|invalid|unsupported|isn't available|is not available|no access)|unknown model|unsupported model|invalid model/i;
// Every invocation: the shared daemon off (a root-level override, so it reaches every subcommand).
export const CODEX_ROOT = ["-c", "features.daemon_auto_start=false"];
export function codexArgs(o: { work: string; out: string; schema?: string; model?: string }): string[] {
  const cmd = [...CODEX_ROOT, "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "-C", o.work, "-o", o.out, "--json",
    "-c", 'web_search="disabled"', "-c", 'approval_policy="never"', "-c", 'default_permissions=":read-only"', "-c", `model_context_window=${LIMITS.codexContextWindow}`];
  if (o.schema) cmd.push("--output-schema", o.schema);
  if (o.model) cmd.push("-m", o.model);
  return cmd;
}
export function codexProvider(o: { home: string; bin?: string; bwrap?: string | null; scratch?: string; signedIn?: (home: string) => boolean }): CodexProvider {
  const bin = o.bin ?? "codex";
  const signedIn = o.signedIn ?? ((h: string) => existsSync(join(h, "auth.json")));
  const setup = (): SandboxSetup => ({ realHome: o.home, scratch: o.scratch });
  const codexBin = () => which(bin);
  const bwrapBin = () => (o.bwrap === null ? null : which(o.bwrap ?? "bwrap"));
  const envFor = (mode: IsolationMode, d: Dirs, extra: Record<string, string> = {}): Record<string, string> => mode === "bwrap"
    ? { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...extra }
    : { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CODEX_HOME: d.codexHome, HOME: d.home, LANG: "C.UTF-8", ...extra };
  const launch = (mode: IsolationMode, d: Dirs, args: string[]) => {
    const cb = codexBin();
    if (!cb) throw new SeatError("unconfigured", "the Codex binary isn't installed");
    const bw = bwrapBin();
    if (mode === "bwrap" && !bw) throw new SeatError("refused", "bubblewrap isn't installed");
    return wrap(mode, { ...d, bwrap: bw ?? "bwrap", codexBin: cb }, mode === "rules" ? args : args);
  };
  const ask: AskFn = async (input) => {
    if (!input.codexMode) throw new SeatError("refused", "Codex isn't isolated this run (its self-test didn't pass), so it isn't started");
    if (!signedIn(o.home)) throw new SeatError("unconfigured", "Codex isn't signed in to ChatGPT yet");
    const d = freshDirs(setup());
    try {
      const out = join(d.io, "answer.txt");
      const schemaObj = input.brief ? ANSWER_SCHEMA : input.schema;
      let schema: string | undefined;
      if (schemaObj) { schema = join(d.io, "schema.json"); writeFileSync(schema, JSON.stringify(schemaObj)); }
      // A review is sent with the review prompt, but with no search: Codex runs with no tools here.
      const p = input.brief ? reviewPrompt({ ...input.brief, needs_facts: false }, "reviewer") : { system: input.system ?? "", user: input.user ?? "" };
      const args = [...codexArgs({ work: d.work, out, schema, model: input.model || undefined }), `${p.system}\nUse no tools and run no commands: everything you need is below.\n\n${p.user}`];
      let r;
      try { r = await input.wire.exec(launch(input.codexMode, d, args), { env: envFor(input.codexMode, d), signal: input.signal, handed: schema ? [schema] : [] } as any); }
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
      // The ChatGPT plan: no bill at all. It counts as one call against the seat's call allowance, never as dollars.
      return { text, json, answer, urls: [], served: served || input.model || "Codex default model", bill: { usd: 0, how: "plan call" }, tokens: usage, searches: 0 };
    } finally { d.done(); }
  };
  // The sandbox self-test (sandbox.ts): bubblewrap first when installed, then Codex's own rules.
  const isolation = async (wire: Wire, signal: AbortSignal): Promise<Isolation> => {
    const at = new Date().toISOString();
    if (!signedIn(o.home)) return { ok: false, mode: "none", detail: "Codex isn't signed in to ChatGPT yet", at };
    if (!codexBin()) return { ok: false, mode: "none", detail: "the Codex binary isn't installed", at };
    const modes: IsolationMode[] = bwrapBin() ? ["bwrap", "rules"] : ["rules"];
    const why: string[] = [];
    for (const mode of modes) {
      const d = freshDirs(setup());
      try {
        const letters = (n: number) => [...randomBytes(n)].map((b) => "abcdefghijklmnop"[b % 16]).join("");
        const k1 = `trialcanary${letters(12)}`, k2 = `trialcanary${letters(12)}`;
        const key = join(d.tmp, "planted-key.txt");
        writeFileSync(key, k1, { mode: 0o644 });
        const out = join(d.io, "answer.txt");
        const args = [...codexArgs({ work: d.work, out }), selfTestPrompt(key, process.pid)];
        const r = await wire.exec(launch(mode, d, args), { env: envFor(mode, d, { TRIAL_CANARY: k2 }), signal, handed: [] } as any);
        const answer = existsSync(out) ? readFileSync(out, "utf8") : "";
        const j = judgeSelfTest({ ...r, answer }, [k1, k2, "REVIEW_", "SUPERVISOR_TOKEN", "TRIALS_BUDGET"]);
        if (j.ok) return { ok: true, mode, detail: j.detail, at };
        why.push(`${mode}: ${j.detail}`);
      } catch (e) { why.push(`${mode}: ${(e as Error).message.slice(0, 160)}`); }
      finally { d.done(); }
    }
    return { ok: false, mode: "none", detail: why.join("; "), at };
  };
  const tool = async (wire: Wire, signal: AbortSignal, mode: IsolationMode, sub: string[]) => {
    const d = freshDirs(setup());
    try { const env = envFor(mode, d); return await wire.exec(launch(mode, d, [...CODEX_ROOT, ...sub]), { env, signal, handed: [] } as any); }
    finally { d.done(); }
  };
  const version = async (wire: Wire, signal: AbortSignal, mode: IsolationMode = "rules") => {
    try { const r = await tool(wire, signal, mode, ["--version"]); return r.code === 0 ? (r.stdout.trim().split("\n")[0] ?? "").slice(0, 80) || null : null; }
    catch { return null; }
  };
  // Best effort: the catalog `codex debug models` prints, or null when it can't be read.
  const models = async (wire: Wire, signal: AbortSignal, mode: IsolationMode = "rules") => {
    try { const r = await tool(wire, signal, mode, ["debug", "models"]); if (r.code !== 0) return null; return modelsFromCatalog(JSON.parse(r.stdout)); }
    catch { return null; }
  };
  return { ask, version, models, isolation };
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
