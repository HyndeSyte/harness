// What every seat shares: the call shape, HTTP with a deadline, and error mapping.
import { classifyHttp, SeatError, type Answer, type ErrorKind, type Outbound, type Role } from "../core.ts";

export type SeatInput = {
  brief: Outbound;        // the allowlisted fields only (core.ts outbound), never the whole brief
  role: Role; signal: AbortSignal; maxOutputTokens: number;
  day: string;            // YYYY-MM-DD, for date-dependent prices
  selftest?: boolean;
};
export type SeatAnswer = Answer & {
  model: string; cost_usd: number; tokens?: { input: number; output: number }; searches?: number;
};
export type SeatFn = (input: SeatInput) => Promise<SeatAnswer>;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// Keys never leave in an error message, a log line or the record.
export function scrub(text: string, secrets: (string | undefined)[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join("<key>");
  return t.slice(0, 300);
}

const HTTP_REASON: Partial<Record<ErrorKind, string>> = {
  credit: "out of credit or over a billing limit", auth: "the key was refused", quota: "rate limited",
  transient: "the service had an error", refused: "the service refused the request",
};

export async function postJson(fetcher: Fetch, url: string, headers: Record<string, string>, body: unknown,
  signal: AbortSignal, secrets: (string | undefined)[]): Promise<any> {
  let r: Response;
  try {
    r = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal, redirect: "error" });
  } catch (e) {
    if (signal.aborted) throw new SeatError("timeout", "no answer before the seat's deadline");
    throw new SeatError("transient", scrub(`network: ${(e as Error).message}`, secrets));
  }
  let text = "";
  try { text = await r.text(); } catch (e) {
    if (signal.aborted) throw new SeatError("timeout", "no answer before the seat's deadline");
    throw new SeatError("transient", "the answer was cut off");
  }
  if (r.status >= 400) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j?.error?.message ?? j?.message ?? j?.detail ?? text; if (typeof msg !== "string") msg = JSON.stringify(msg); } catch { /* raw */ }
    // The provider's words only decide the kind; what is kept is the status and a
    // fixed reason, so no echoed brief text or key ends up in the queue or the record.
    const kind = classifyHttp(r.status, `${msg} ${text}`);
    throw new SeatError(kind, `HTTP ${r.status}: ${HTTP_REASON[kind] ?? HTTP_REASON.refused}`);
  }
  try { return JSON.parse(text); } catch { throw new SeatError("bad_output", "the service answered with something that was not JSON"); }
}

// "Answered as" goes next to the model asked for, so a swap is never silent.
export function modelLabel(asked: string, answered?: string): string {
  if (!answered || answered === asked || answered.startsWith(asked) || answered.endsWith(`/${asked}`)) return answered && answered !== asked ? answered : asked;
  return `${asked} (answered as ${answered})`;
}
