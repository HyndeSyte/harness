// The trials' own calls, beside the review seats' adapters (../review/seats/*.ts), which the review-seats
// suite uses as they are with a model override. These are for what a review seat doesn't do: a research
// answer, and a grade in the trials' own JSON shape. Same HTTP helper, same key scrubbing, same Codex
// sandbox (an empty folder, nothing of Cain's in its environment).
//
// Read 2026-11-22: Claude's web search and web fetch tools, web_search_20260209 and web_fetch_20260209
// (no beta header; search $10 per 1,000, fetch billed as tokens only); the Gemini API's generateContent
// with googleSearch grounding (groundingMetadata.groundingChunks[].web.uri); the Perplexity Agent API's
// presets by name ("preset": "fast" and so on, usage.cost.total_cost in USD). The Perplexity field name
// and the Codex model listing could not be read from their docs here; see DOCS.md, Model trials.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatError, tokenCost, CLAUDE_SEARCH_USD, PERPLEXITY_SEARCH_USD } from "../review/core.ts";
import { modelLabel, postJson, type Fetch } from "../review/seats/common.ts";
import { bunExec, classifyCodex, codexSignedIn, type Exec } from "../review/seats/openai.ts";
import { LIMITS, lastJson } from "./core.ts";

export type AskInput = {
  system: string; user: string; maxOut: number; signal: AbortSignal; day: string;
  search?: boolean; fetch?: boolean;       // web search; fetching cited pages (graders)
  schema?: object;                          // a JSON answer in this shape
};
export type AskResult = {
  text: string; json?: any; urls: string[]; model: string; cost_usd: number; billed: boolean;
  tokens: { input: number; output: number }; searches: number;
};
export type AskFn = (model: string, input: AskInput) => Promise<AskResult>;

const uniq = (xs: string[]) => [...new Set(xs.filter((u) => /^https?:\/\//i.test(u)))].slice(0, 40);

// ---- Claude ----
export function claudeAsk(o: { key: string; base?: string; version?: string; fetch?: Fetch }): AskFn {
  const base = o.base ?? "https://api.anthropic.com";
  const fetcher = o.fetch ?? fetch;
  return async (model, input) => {
    const tools: any[] = [];
    if (input.search) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: input.fetch ? LIMITS.gradeSearches : LIMITS.claudeSearches });
    if (input.fetch) tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: LIMITS.gradeFetches, max_content_tokens: LIMITS.fetchTokens });
    const body: any = { model, max_tokens: input.maxOut, system: input.system, messages: [{ role: "user", content: input.user }] };
    if (tools.length) {
      body.tools = tools;
      if (input.schema) body.system += `\nEnd your answer with only a JSON object of this shape, nothing after it: ${JSON.stringify(input.schema)}`;
    } else if (input.schema) body.output_config = { format: { type: "json_schema", schema: input.schema } };
    const headers = { "x-api-key": o.key, "anthropic-version": o.version ?? "2026-10-21" };
    let inT = 0, outT = 0, searches = 0, text = "", answered = "", stop = "";
    const urls: string[] = [];
    for (let round = 0; round < (tools.length ? LIMITS.claudeRounds : 1); round++) {
      const j = await postJson(fetcher, `${base}/v1/messages`, headers, body, input.signal, [o.key]);
      const u = j?.usage ?? {};
      inT += Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      outT += Number(u.output_tokens ?? 0);
      searches += Number(u.server_tool_use?.web_search_requests ?? 0);
      answered = j?.model ?? answered;
      stop = String(j?.stop_reason ?? "");
      const blocks = Array.isArray(j?.content) ? j.content : [];
      for (const b of blocks) {
        if (b?.type === "text") {
          text += b.text ?? "";
          for (const c of Array.isArray(b.citations) ? b.citations : []) if (typeof c?.url === "string") urls.push(c.url);
        }
      }
      if (stop !== "pause_turn") break;
      body.messages = [...body.messages, { role: "assistant", content: blocks }];
    }
    const cost = tokenCost(model, input.day, inT, outT) + searches * CLAUDE_SEARCH_USD;
    if (stop === "refusal") throw new SeatError("refused", "Claude declined", cost);
    if (stop === "max_tokens") throw new SeatError("bad_output", "the answer ran out of room before it finished", cost);
    if (!text.trim()) throw new SeatError("bad_output", "an empty answer", cost);
    const json = input.schema ? lastJson(text) : undefined;
    if (input.schema && !json) throw new SeatError("bad_output", "the answer was not JSON", cost);
    for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) urls.push(m[0]);
    return { text, json, urls: uniq(urls), model: modelLabel(model, answered), cost_usd: cost, billed: false,
      tokens: { input: inT, output: outT }, searches };
  };
}

// ---- Gemini ----
export function geminiAsk(o: { key: string; base?: string; fetch?: Fetch }): AskFn {
  const base = o.base ?? "https://generativelanguage.googleapis.com";
  const fetcher = o.fetch ?? fetch;
  return async (model, input) => {
    const body: any = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.user }] }],
      generationConfig: { maxOutputTokens: input.maxOut },
    };
    if (input.search) body.tools = [{ googleSearch: {} }];
    const j = await postJson(fetcher, `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": o.key }, body, input.signal, [o.key]);
    if (j?.promptFeedback?.blockReason) throw new SeatError("refused", `Gemini blocked it (${String(j.promptFeedback.blockReason).slice(0, 40)})`);
    const cand = j?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((x: any) => typeof x?.text === "string" && !x.thought).map((x: any) => x.text).join("");
    const u = j?.usageMetadata ?? {};
    const inT = Number(u.promptTokenCount ?? 0) + Number(u.toolUsePromptTokenCount ?? 0);
    const outT = Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0);
    const cost = tokenCost(model, input.day, inT, outT);
    if (cand?.finishReason === "MAX_TOKENS") throw new SeatError("bad_output", "the answer ran out of room before it finished", cost);
    if (!text.trim()) throw new SeatError("bad_output", "an empty answer", cost);
    const urls = (cand?.groundingMetadata?.groundingChunks ?? []).map((c: any) => String(c?.web?.uri ?? ""));
    for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) urls.push(m[0]);
    return { text, urls: uniq(urls), model: modelLabel(model, j?.modelVersion), cost_usd: cost, billed: false,
      tokens: { input: inT, output: outT }, searches: (cand?.groundingMetadata?.webSearchQueries ?? []).length };
  };
}

// ---- Perplexity Agent API, by preset ----
// model here is the preset's name (fast, low, medium). The field it goes in is one constant, so a
// refusal from the API (HTTP 400, kept as the call's error) is fixed in one place.
export const PERPLEXITY_PRESET_FIELD = "preset";
export function perplexityAsk(o: { key: string; base?: string; fetch?: Fetch }): AskFn {
  const base = o.base ?? "https://api.perplexity.ai";
  const fetcher = o.fetch ?? fetch;
  return async (preset, input) => {
    const body: any = { [PERPLEXITY_PRESET_FIELD]: preset, input: input.user, instructions: input.system, max_output_tokens: input.maxOut };
    const j = await postJson(fetcher, `${base}/v1/agent`, { authorization: `Bearer ${o.key}` }, body, input.signal, [o.key]);
    if (j?.status && !["completed", "succeeded"].includes(String(j.status)))
      throw new SeatError(j.status === "failed" ? "transient" : "bad_output", `the run ended as ${String(j.status).slice(0, 30)}`);
    let text = typeof j?.output_text === "string" ? j.output_text : "";
    const urls: string[] = [];
    for (const item of j?.output ?? []) {
      if (item?.type === "message") for (const c of item.content ?? []) {
        if (c?.type === "output_text" && typeof c.text === "string" && !j?.output_text) text += c.text;
        for (const a of c?.annotations ?? []) if (typeof a?.url === "string") urls.push(a.url);
      }
      for (const r of item?.results ?? []) if (typeof r?.url === "string") urls.push(r.url);
    }
    for (const s of j?.search_results ?? j?.citations ?? []) urls.push(typeof s === "string" ? s : String(s?.url ?? ""));
    for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) urls.push(m[0]);
    const u = j?.usage ?? {};
    const inT = Number(u.input_tokens ?? 0), outT = Number(u.output_tokens ?? 0);
    const searches = Number(u.tool_calls_details?.search_web ?? u.tool_calls_details?.web_search ?? 0);
    const billedUsd = Number(u.cost?.total_cost);
    const billed = Number.isFinite(billedUsd) && billedUsd >= 0;
    // An unbilled answer is priced from the model it says it ran (an unknown one high), plus searches.
    const cost = billed ? billedUsd : tokenCost(String(j?.model ?? "unknown-preset"), input.day, inT, outT) + searches * PERPLEXITY_SEARCH_USD;
    if (!text.trim()) throw new SeatError("bad_output", "an empty answer", cost);
    return { text, urls: uniq(urls), model: `${preset}${j?.model ? ` (answered as ${String(j.model).slice(0, 60)})` : ""}`, cost_usd: cost, billed,
      tokens: { input: inT, output: outT }, searches };
  };
}

// ---- Codex, for grading: codex exec with the trials' schema, in an empty folder ----
export function codexAsk(o: { home: string; bin?: string; exec?: Exec; scratch?: string }): AskFn {
  const bin = o.bin ?? "codex";
  const exec = o.exec ?? bunExec;
  return async (model, input) => {
    if (!codexSignedIn(o.home)) throw new SeatError("unconfigured", "Codex isn't signed in to ChatGPT yet");
    const tmp = mkdtempSync(join(o.scratch ?? tmpdir(), "codex-trial-"));
    try {
      const work = join(tmp, "work"); mkdirSync(work);
      const home = join(tmp, "home"); mkdirSync(home);
      const out = join(tmp, "answer.txt");
      const cmd = [bin, "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", work, "-o", out, "--json"];
      if (input.schema) { const s = join(tmp, "schema.json"); writeFileSync(s, JSON.stringify(input.schema)); cmd.push("--output-schema", s); }
      if (model) cmd.push("-m", model);
      if (input.search || input.fetch) cmd.push("-c", 'web_search="live"');
      cmd.push(`${input.system}\n\n${input.user}`);
      const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CODEX_HOME: o.home, HOME: home, LANG: "C.UTF-8" };
      let r;
      try { r = await exec(cmd, { env, signal: input.signal }); }
      catch (e) { throw new SeatError(input.signal.aborted ? "timeout" : "transient", `Codex didn't run: ${(e as Error).message.slice(0, 120)}`); }
      if (input.signal.aborted) throw new SeatError("timeout", "no answer before the deadline");
      let answered = "", usage = { input: 0, output: 0 }, problem = "";
      for (const line of r.stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (typeof ev.model === "string") answered = ev.model;
        if (typeof ev?.thread?.model === "string") answered = ev.thread.model;
        if (ev.type === "turn.completed" && ev.usage) usage = {
          input: Number(ev.usage.input_tokens ?? 0) + Number(ev.usage.cached_input_tokens ?? 0),
          output: Number(ev.usage.output_tokens ?? 0) + Number(ev.usage.reasoning_output_tokens ?? 0) };
        if (ev.type === "turn.failed" || ev.type === "error") problem += ` ${ev.error?.message ?? ev.message ?? ""}`;
      }
      if (r.code !== 0 || problem.trim()) {
        const words = `${problem} ${r.stderr}`.trim();
        throw new SeatError(classifyCodex(words), `Codex: ${words.replace(/\s+/g, " ").slice(0, 200) || `exit ${r.code}`}`);
      }
      if (!existsSync(out)) throw new SeatError("bad_output", "Codex finished without a final answer");
      const text = readFileSync(out, "utf8");
      const json = input.schema ? lastJson(text) : undefined;
      if (input.schema && !json) throw new SeatError("bad_output", "Codex's answer was not JSON");
      return { text, json, urls: [], model: answered || model || "Codex default model (ChatGPT plan)", cost_usd: 0, billed: true, tokens: usage, searches: 0 };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  };
}

// Codex's words when the model asked for isn't one the installed CLI (or the plan) offers: that
// configuration is skipped, said so, never retried.
export const CODEX_NO_MODEL = /(model|engine)[^\n]{0,60}(not (found|supported|available|exist)|does not exist|unknown|invalid|unsupported|isn't available|is not available|no access)|unknown model|unsupported model|invalid model/i;
