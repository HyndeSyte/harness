// GitHub's read allowance for the link (Cain 0.19.3). The link reads GitHub's API without a key: GitHub
// allows 60 reads an hour from the Pi's address, and on Nov 27 a day of Ship taps and the link's own
// reads spent the hour, so his Ship tap was refused for a reason that had nothing to do with the change.
// So every read the link makes goes through here:
//   - a file read at a commit (contents?ref=<full sha>) never changes: it is kept and never read again
//     (its 404 too: a file absent at a commit stays absent). So does the job list of one attempt of a
//     workflow run once every job in it has finished (a re-run is a new attempt, read anew);
//   - every other read carries the ETag GitHub last gave for it (If-None-Match), and a 304 answers from
//     what was kept. GitHub counts a 304 as free only for an authenticated read, so without a key this
//     saves GitHub's work, not the hour; it is ready for a key all the same;
//   - two identical reads at once share one request;
//   - each answer's x-ratelimit headers say what is left of the hour, and GitHub's /rate_limit, which
//     GitHub doesn't count, says it on demand: before a Ship card is built, when his tap lands, and before
//     the Ship run's registration (core.ts, ship-pass.ts). When what a step needs isn't left, it waits for
//     the hour's reset by itself and says when (clock, in his time zone).
// Nothing else's credentials take part: no token is read or sent here.
export interface Budget { limit: number; remaining: number; reset: number }   // reset: ms since the epoch
export interface ApiAnswer { status: number; body: any; headers: Record<string, string> }
export type Fetch = (url: string, init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

// What each step reads at most from GitHub's API (merge.ts, ship-pass.ts), counted from the code with a
// little room. A Ship card: the pull request, its files, two config.yaml at the base and two at the head,
// the three required checks, the Windows check's attempts, the head's workflow runs and their jobs, and
// tests.yml at the head. His tap's landing: the pull request and the same checks. The Ship run's
// registration: the pull request, the config.yaml versions, the fingerprint and the probe at the head
// (after a card and a landing the files at the head come from the kept reads).
// Counted with nothing kept yet and six workflow runs on the head (tests and surface on push and pull
// request, the pr check once or more): a card 18, a landing 13, a registration 8.
export const CARD_ASKS = 20;
export const LAND_ASKS = 14;
export const REG_ASKS = 8;
export const RUN_ASKS = LAND_ASKS + REG_ASKS;      // what his tap needs left: the landing, then the Ship run's registration
export const RESERVE = CARD_ASKS + RUN_ASKS;       // the link's background reads never go below this: it is his taps'
export const RESET_SLACK_MS = 5_000;               // waits run this long past GitHub's reset
export const IMMUTABLE = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/contents\/[^?]+\?ref=[0-9a-f]{40}$/;
export const ATTEMPT_JOBS = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\/attempts\/\d+\/jobs\?/;
// One attempt's job list, whole on this page and every job finished: it can't change any more.
export const finishedJobs = (body: any): boolean => Array.isArray(body?.jobs) && body.jobs.length > 0 && Number(body.total_count) === body.jobs.length
  && body.jobs.every((j: any) => j?.status === "completed" && typeof j?.conclusion === "string");
const KEEP_MAX = 400;                              // reads kept (each a small JSON answer); the oldest go first
const HOUR = 3_600_000;

// The time GitHub's hour resets, as people say it ("6:12 PM"), in his time zone.
export function resetClock(ms: number, tz = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

// When a step needing `need` reads would have to wait: the reset time (ms), or null when it can go now
// (enough left, the hour already reset, or nothing known: an unknown allowance never holds anything back).
export function shortUntil(b: Budget | null | undefined, need: number, now: number): number | null {
  if (!b || !Number.isFinite(b.remaining) || !Number.isFinite(b.reset)) return null;
  return b.remaining < need && b.reset > now ? b.reset : null;
}

function headersOf(r: Response): Record<string, string> {
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return h;
}
function budgetOf(h: Record<string, string>): Budget | null {
  if (h["x-ratelimit-resource"] && h["x-ratelimit-resource"] !== "core") return null;
  const limit = Number(h["x-ratelimit-limit"]), remaining = Number(h["x-ratelimit-remaining"]), reset = Number(h["x-ratelimit-reset"]);
  return h["x-ratelimit-remaining"] !== undefined && [limit, remaining, reset].every((n) => Number.isInteger(n) && n >= 0) ? { limit, remaining, reset: reset * 1000 } : null;
}

export interface Github {
  api: (path: string) => Promise<ApiAnswer>;
  rateLimit: () => Promise<Budget | null>;         // GitHub's /rate_limit now (not counted); the last seen when it can't be read
  seen: () => Budget | null;                       // what the last answer's headers said, with no request
  short: (need: number) => number | null;          // shortUntil on what was last seen
  hour: () => { asked: number; kept: number };     // reads sent to GitHub in the last hour, and reads answered from what was kept
}

export function makeGithub(o: { fetch?: Fetch; now?: () => number; base?: string; timeoutMs?: number } = {}): Github {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const base = o.base ?? "https://api.github.com";
  const kept = new Map<string, { status: number; body: any }>();          // reads that never change
  const tags = new Map<string, { etag: string; body: any; headers: Record<string, string> }>();
  const flying = new Map<string, Promise<ApiAnswer>>();
  const asked: number[] = [], hits: number[] = [];
  let last: Budget | null = null;
  const trim = () => { const t = now() - HOUR; while (asked.length && asked[0] < t) asked.shift(); while (hits.length && hits[0] < t) hits.shift(); };
  const keep = <V>(m: Map<string, V>, k: string, v: V) => { m.delete(k); m.set(k, v); if (m.size > KEEP_MAX) m.delete(m.keys().next().value as string); };
  const note = (h: Record<string, string>) => { const b = budgetOf(h); if (b) last = b; };
  const get = (path: string, headers: Record<string, string> = {}) => doFetch(`${base}${path}`, { redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    headers: { accept: "application/vnd.github+json", "user-agent": "cain-link", "x-github-api-version": "2022-11-28", ...headers } });

  async function send(path: string): Promise<ApiAnswer> {
    const k = kept.get(path);
    if (k) { hits.push(now()); trim(); return { status: k.status, body: structuredClone(k.body), headers: {} }; }
    const tag = tags.get(path);
    asked.push(now()); trim();
    const r = await get(path, tag ? { "if-none-match": tag.etag } : {});
    const headers = headersOf(r);
    note(headers);
    if (r.status === 304 && tag) {
      keep(tags, path, tag);
      return { status: 200, body: structuredClone(tag.body), headers: { ...tag.headers, ...headers } };
    }
    const body = await r.json().catch(() => null);
    if ((IMMUTABLE.test(path) && ((r.status === 200 && body) || r.status === 404))
        || (ATTEMPT_JOBS.test(path) && r.status === 200 && finishedJobs(body))) keep(kept, path, { status: r.status, body });
    else if (r.status === 200 && body && headers.etag) keep(tags, path, { etag: headers.etag, body, headers });
    return { status: r.status, body: body === null ? null : structuredClone(body), headers };
  }

  return {
    api(path) {
      const f = flying.get(path);
      if (f) return f.then((a) => ({ ...a, body: a.body === null ? null : structuredClone(a.body) }));
      const p = send(path).finally(() => flying.delete(path));
      flying.set(path, p);
      return p;
    },
    async rateLimit() {
      try {
        const r = await get("/rate_limit");
        note(headersOf(r));
        const c = (await r.json().catch(() => null))?.resources?.core;
        const b = { limit: Number(c?.limit), remaining: Number(c?.remaining), reset: Number(c?.reset) * 1000 };
        if (r.status === 200 && [b.limit, b.remaining, b.reset].every((n) => Number.isInteger(n) && n >= 0)) last = b;
      } catch { /* the last seen stands */ }
      return last && last.reset > now() ? { ...last } : last ? { ...last, remaining: last.limit } : null;
    },
    seen: () => (last ? { ...last } : null),
    short: (need) => shortUntil(last, need, now()),
    hour: () => { trim(); return { asked: asked.length, kept: hits.length }; },
  };
}
