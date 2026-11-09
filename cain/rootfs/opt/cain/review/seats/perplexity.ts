// Perplexity seat: fresh facts, not a judge. Sonar through the Agent API (the
// 2026 replacement for the Sonar chat completions endpoint), with web search and a
// JSON schema. Read 2026-11-08: POST https://api.perplexity.ai/v1/agent, Bearer key,
// model "perplexity/sonar", tools [{type: "web_search"}], response_format
// {type: "json_schema", json_schema: {name, schema}}; usage.cost.total_cost in USD
// (docs.perplexity.ai agent-api quickstart, output-control and models pages).
import { ANSWER_SCHEMA, PERPLEXITY_SEARCH_USD, SeatError, prompt, tokenCost, validateAnswer } from "../core.ts";
import { modelLabel, postJson, type Fetch, type SeatFn } from "./common.ts";

export type PerplexityOptions = { key: string; base?: string; model?: string; fetch?: Fetch };

export function perplexitySeat(o: PerplexityOptions): SeatFn {
  const base = o.base ?? "https://api.perplexity.ai";
  const model = o.model ?? "perplexity/sonar";
  const fetcher = o.fetch ?? fetch;
  return async (input) => {
    const p = prompt(input.brief, input.role === "reviewer" ? "facts" : input.role);
    const body: any = {
      model, input: p.user, instructions: p.system,
      response_format: { type: "json_schema", json_schema: { name: "review", schema: ANSWER_SCHEMA } },
      max_output_tokens: input.maxOutputTokens,
    };
    if (!input.selftest) body.tools = [{ type: "web_search" }];
    const j = await postJson(fetcher, `${base}/v1/agent`, { authorization: `Bearer ${o.key}` }, body, input.signal, [o.key]);
    if (j?.status && !["completed", "succeeded"].includes(String(j.status)))
      throw new SeatError(j.status === "failed" ? "transient" : "bad_output", `the run ended as ${String(j.status).slice(0, 30)}`);
    let text = typeof j?.output_text === "string" ? j.output_text : "";
    if (!text) for (const item of j?.output ?? []) if (item?.type === "message")
      for (const c of item.content ?? []) if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
    const u = j?.usage ?? {};
    const inT = Number(u.input_tokens ?? 0), outT = Number(u.output_tokens ?? 0);
    const searches = Number(u.tool_calls_details?.search_web ?? u.tool_calls_details?.web_search ?? 0);
    // Their own bill first; our price table only when they don't say.
    const billed = Number(u.cost?.total_cost);
    const cost = Number.isFinite(billed) && billed >= 0 ? billed : tokenCost(model, input.day, inT, outT) + searches * PERPLEXITY_SEARCH_USD;
    if (!text.trim()) throw new SeatError("bad_output", "an empty answer", cost);
    const v = validateAnswer(text, true);
    if (!v.answer) throw new SeatError("bad_output", v.error!, cost);
    return { ...v.answer, model: modelLabel(model, j?.model), cost_usd: cost, tokens: { input: inT, output: outT }, searches };
  };
}
