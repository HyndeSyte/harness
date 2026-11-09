// Gemini seat: the Gemini API's generateContent with a JSON schema, and Google
// Search grounding when the brief needs current facts. Paid (prepaid) key only:
// the paid tier doesn't use prompts to improve Google's products.
// Request shape read 2026-11-08 at aistudio.google.com/docs/structured-output
// (REST: generationConfig.responseFormat.text {mimeType, schema}; the SDK name
// responseJsonSchema is the same setting). GEMINI_SCHEMA_FIELD switches between them.
import { ANSWER_SCHEMA, SeatError, prompt, tokenCost, validateAnswer } from "../core.ts";
import { modelLabel, postJson, type Fetch, type SeatFn } from "./common.ts";

export type GeminiOptions = {
  key: string; base?: string; model?: string; bigModel?: string;
  schemaField?: "responseFormat" | "responseJsonSchema"; fetch?: Fetch;
};

export function geminiSeat(o: GeminiOptions): SeatFn {
  const base = o.base ?? "https://generativelanguage.googleapis.com";
  const fetcher = o.fetch ?? fetch;
  return async (input) => {
    const b = input.brief;
    // High-stakes reviews get the flagship; everything else the Flash model.
    const model = input.selftest ? (o.model ?? "gemini-3.8-flash")
      : b.consequential ? (o.bigModel ?? "gemini-4-argon") : (o.model ?? "gemini-3.8-flash");
    const p = prompt(b, input.role);
    const schema = o.schemaField === "responseJsonSchema"
      ? { responseMimeType: "application/json", responseJsonSchema: ANSWER_SCHEMA }
      : { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: ANSWER_SCHEMA } } };
    const body: any = {
      systemInstruction: { parts: [{ text: p.system }] },
      contents: [{ role: "user", parts: [{ text: p.user }] }],
      generationConfig: { maxOutputTokens: input.maxOutputTokens, ...schema },
    };
    if (b.needs_facts && !input.selftest) body.tools = [{ googleSearch: {} }];
    const j = await postJson(fetcher, `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { "x-goog-api-key": o.key }, body, input.signal, [o.key]);
    const cand = j?.candidates?.[0];
    if (j?.promptFeedback?.blockReason) throw new SeatError("refused", `Gemini blocked the brief (${String(j.promptFeedback.blockReason).slice(0, 40)})`);
    const text = (cand?.content?.parts ?? []).filter((x: any) => typeof x?.text === "string" && !x.thought).map((x: any) => x.text).join("");
    const u = j?.usageMetadata ?? {};
    const input_t = Number(u.promptTokenCount ?? 0) + Number(u.toolUsePromptTokenCount ?? 0);
    const output_t = Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0);
    const cost = tokenCost(model, input.day, input_t, output_t);
    if (cand?.finishReason === "MAX_TOKENS") throw new SeatError("bad_output", "the answer ran out of room before it finished", cost);
    if (!text.trim()) throw new SeatError("bad_output", `an empty answer (${String(cand?.finishReason ?? "no reason given").slice(0, 40)})`, cost);
    const v = validateAnswer(text);
    if (!v.answer) throw new SeatError("bad_output", v.error!, cost);
    const searches = (cand?.groundingMetadata?.webSearchQueries ?? []).length;
    return { ...v.answer, model: modelLabel(model, j?.modelVersion), cost_usd: cost,
      tokens: { input: input_t, output: output_t }, searches };
  };
}
