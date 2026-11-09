// Claude seat: a fresh Claude with no access to Cain's conversation, on the API
// key from his linked Console org (the plan's monthly API credit). It is the
// fourth seat and the stand-in; it never counts as an independent family.
// Read 2026-11-08 (platform.claude.com): model "claude-opus-5-5", JSON outputs via
// output_config.format {type: "json_schema", schema}; the web search tool
// (web_search_20250305, $10 per 1,000 searches) always cites, and citations can't
// be combined with output_config.format, so a search run asks for JSON in text and
// the answer is checked against the same schema.
import { ANSWER_SCHEMA, CLAUDE_SEARCH_USD, SeatError, prompt, tokenCost, validateAnswer } from "../core.ts";
import { modelLabel, postJson, type Fetch, type SeatFn } from "./common.ts";

export type ClaudeOptions = { key: string; base?: string; model?: string; selftestModel?: string; version?: string; fetch?: Fetch };

export function claudeSeat(o: ClaudeOptions): SeatFn {
  const base = o.base ?? "https://api.anthropic.com";
  const fetcher = o.fetch ?? fetch;
  return async (input) => {
    const model = input.selftest ? (o.selftestModel ?? o.model ?? "claude-opus-5-5") : (o.model ?? "claude-opus-5-5");
    const p = prompt(input.brief, input.role);
    const search = !input.selftest && (input.brief.needs_facts || input.role === "facts-stand-in");
    const body: any = { model, max_tokens: input.maxOutputTokens, system: p.system, messages: [{ role: "user", content: p.user }] };
    if (search) {
      body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
      body.system += `\nEnd your answer with only a JSON object of this shape, nothing after it: ${JSON.stringify(ANSWER_SCHEMA)}`;
    } else {
      body.output_config = { format: { type: "json_schema", schema: ANSWER_SCHEMA } };
    }
    const headers = { "x-api-key": o.key, "anthropic-version": o.version ?? "2026-10-21" };
    let inT = 0, outT = 0, searches = 0, text = "", answered = "", stop = "";
    // A long search turn can pause; it continues by sending the turn back as is.
    for (let round = 0; round < 3; round++) {
      const j = await postJson(fetcher, `${base}/v1/messages`, headers, body, input.signal, [o.key]);
      const u = j?.usage ?? {};
      inT += Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      outT += Number(u.output_tokens ?? 0);
      searches += Number(u.server_tool_use?.web_search_requests ?? 0);
      answered = j?.model ?? answered;
      stop = String(j?.stop_reason ?? "");
      const blocks = Array.isArray(j?.content) ? j.content : [];
      text += blocks.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
      if (stop !== "pause_turn") break;
      body.messages = [...body.messages, { role: "assistant", content: blocks }];
    }
    const cost = tokenCost(model, input.day, inT, outT) + searches * CLAUDE_SEARCH_USD;
    if (stop === "refusal") throw new SeatError("refused", "Claude declined the brief", cost);
    if (stop === "max_tokens") throw new SeatError("bad_output", "the answer ran out of room before it finished", cost);
    if (!text.trim()) throw new SeatError("bad_output", "an empty answer", cost);
    const v = validateAnswer(text, search);
    if (!v.answer) throw new SeatError("bad_output", v.error!, cost);
    return { ...v.answer, model: modelLabel(model, answered), cost_usd: cost, tokens: { input: inT, output: outT }, searches };
  };
}
