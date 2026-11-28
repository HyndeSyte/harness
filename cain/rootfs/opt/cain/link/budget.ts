// GitHub's read allowance for the link (Cain 0.19.4). The link reads GitHub's API without a key: GitHub
// allows 60 reads an hour from the Pi's address, and on Nov 27 a day of Ship taps and the link's own
// reads spent the hour, so his Ship tap was refused for a reason that had nothing to do with the change.
// So every read the link makes goes through here:
//   - a file read at a commit (contents?ref=<full sha>) never changes once GitHub has it: its 200 is kept and
//     never read again. A 404 is never kept: GitHub also answers 404 ("No commit found for the ref") for a
//     commit it can't see yet;
//   - the job list of one attempt of a workflow run is kept only when the caller confirms, from a read of
//     that run attempt that was not kept (the run listing, or GET .../runs/{id}/attempts/{n}), that this
//     very attempt number is completed, and every job in the list has finished. The job list alone never
//     decides; the run listing itself is never kept for good, so each card and landing reads a run's
//     current run_attempt afresh (merge.ts windowsAttempts);
//   - every other read carries the ETag GitHub last gave for it (If-None-Match), and a 304 answers from
//     what was kept. GitHub counts a 304 as free only for an authenticated read, so without a key a 304
//     still costs one of the 60: it is counted as asked in the hourly log;
//   - two identical reads at once share one request, and every caller, the first included, gets its own
//     copy of the answer;
//   - each answer's x-ratelimit headers say what is left of the hour, and GitHub's /rate_limit says it on
//     demand. /rate_limit isn't counted against the 60, but it can count against GitHub's secondary
//     limits, so it is read only before a step that spends (a Ship card, his tap's landing, the Ship
//     run's registration: core.ts, ship-pass.ts), never polled in a loop, and its calls are counted on
//     their own. A failed or unreadable /rate_limit is unknown, never a full allowance. Within one reset
//     window the lowest remaining seen stands (an older answer never raises it), and a reset is taken only
//     when it is a plausible time to come (after now, within the hour and a minute);
//   - a tap that is landing or registering holds RUN_ASKS of what is left (hold, in memory): card builds
//     and the card polling see what is left less those holds.
// Nothing else's credentials take part: no token is read or sent here.
export interface Budget { limit: number; remaining: number; reset: number }   // reset: ms since the epoch
export interface ApiAnswer { status: number; body: any; headers: Record<string, string> }
// confirm (an attempt's job list only): asked before the read, true only when a read of that run attempt that wasn't
// kept says that very attempt is completed; only then may the list be kept.
export interface ApiOpts { confirm?: () => boolean | Promise<boolean> }
export type Fetch = (url: string, init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

// What each step reads at most from GitHub's API (merge.ts, ship-pass.ts), counted from the code with
// nothing kept yet and up to 15 workflow runs on the head (tests and surface on push and pull request, the
// pr check, re-runs: a run's job list is one read each), a little room on top. A Ship card: the pull
// request, its files, two config.yaml at the base and two at the head, the three required checks, the
// Windows check's attempts, the head's workflow runs and each one's jobs, and tests.yml at the head: 12
// plus one a run, 27 with 15. His tap's landing: the pull request and the same checks: 7 plus one a run,
// 22 with 15. The Ship run's registration: the pull request, the four config.yaml, the fingerprint and
// the probe at the head: 7 (cain/tests/github-budget.test.ts counts them with 6, 10 and 15 runs).
export const CARD_ASKS = 28;
export const LAND_ASKS = 23;
export const REG_ASKS = 8;
export const RUN_ASKS = LAND_ASKS + REG_ASKS;      // what one tap holds while it lands and registers (hold)
// The card polling (main.ts pullNow) never spends into this: it reads the API only while more than this is left
// after the taps' holds, and stops at it.
export const RESERVE = RUN_ASKS;
export const RESET_SLACK_MS = 5_000;               // waits run this long past GitHub's reset
const RESET_AHEAD_MS = 3_600_000 + 60_000;         // the latest a reset can plausibly be: an hour and a minute from now
export const IMMUTABLE = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/contents\/[^?]+\?ref=[0-9a-f]{40}$/;
export const ATTEMPT_JOBS = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\/attempts\/\d+\/jobs\?/;
// One attempt's job list, whole on this page and every job finished (with the attempt confirmed completed, it can't change).
export const finishedJobs = (body: any): boolean => Array.isArray(body?.jobs) && body.jobs.length > 0 && Number(body.total_count) === body.jobs.length
  && body.jobs.every((j: any) => j?.status === "completed" && typeof j?.conclusion === "string");
const KEEP_MAX = 400;                              // reads kept (each a small JSON answer); the oldest go first
const HOUR = 3_600_000;

// The time GitHub's hour resets, as people say it ("6:12 PM"), in his time zone.
export function resetClock(ms: number, tz = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

// A reset GitHub gave, in ms: taken only when it is a plausible time to come (after now, within an hour and a minute).
export const plausibleReset = (ms: number, now: number): boolean => Number.isFinite(ms) && ms > now && ms <= now + RESET_AHEAD_MS;

// When a step needing `need` reads would have to wait: the reset time (ms), or null when it can go now
// (enough left, the hour already reset, or nothing known: an unknown allowance never holds a step back; it
// is never read as a full one either).
export function shortUntil(b: Budget | null | undefined, need: number, now: number): number | null {
  if (!b || !Number.isFinite(b.remaining) || !Number.isFinite(b.reset)) return null;
  return b.remaining < need && b.reset > now ? b.reset : null;
}

// A read GitHub refused for its rate limit (the registration's wrapper waits once for those, ship-pass.ts): a 429, or a
// 403 with x-ratelimit-remaining 0. Any other failure is an ordinary one.
export const rateRefused = (r: { status: number; headers?: Record<string, string> } | null | undefined): boolean =>
  !!r && (r.status === 429 || (r.status === 403 && String(r.headers?.["x-ratelimit-remaining"] ?? "").trim() === "0"));
// When such a refusal says the hour resets (ms): its x-ratelimit-reset, or a 429's Retry-After; null when neither is plausible.
export function refusedUntil(h: Record<string, string> | undefined, now: number): number | null {
  const reset = Number(h?.["x-ratelimit-reset"]) * 1000;
  if (h?.["x-ratelimit-reset"] !== undefined && plausibleReset(reset, now)) return reset;
  const after = Number(h?.["retry-after"]);
  if (h?.["retry-after"] !== undefined && Number.isInteger(after) && after >= 0 && plausibleReset(now + after * 1000 + 1, now)) return now + after * 1000;
  return null;
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
  api: (path: string, o?: ApiOpts) => Promise<ApiAnswer>;
  // GitHub's /rate_limit now (not counted against the 60; counted on its own), joined with what the answers said: the
  // lowest remaining seen in this reset window, or null (unknown) when nothing plausible is known for it
  rateLimit: () => Promise<Budget | null>;
  seen: () => Budget | null;                       // the same, with no request
  short: (need: number) => number | null;          // shortUntil on what is seen, less the taps' holds
  room: (need: number) => boolean;                 // known, and at least `need` left after the taps' holds (the card polling)
  hold: (key: string, until: number) => void;      // a tap landing or registering holds RUN_ASKS until then (or free)
  free: (key: string) => void;
  held: () => number;                              // what the holds take off now
  // reads sent to GitHub in the last hour (a 304 included), reads answered from what was kept, and /rate_limit calls
  hour: () => { asked: number; kept: number; limits: number };
}

export function makeGithub(o: { fetch?: Fetch; now?: () => number; base?: string; timeoutMs?: number } = {}): Github {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const base = o.base ?? "https://api.github.com";
  const kept = new Map<string, { status: number; body: any }>();          // reads that never change
  const tags = new Map<string, { etag: string; body: any; headers: Record<string, string> }>();
  const flying = new Map<string, Promise<ApiAnswer>>();
  const holds = new Map<string, number>();
  const asked: number[] = [], hits: number[] = [], limits: number[] = [];
  let last: Budget | null = null;
  const trim = () => { const t = now() - HOUR; for (const a of [asked, hits, limits]) while (a.length && a[0] < t) a.shift(); };
  const keep = <V>(m: Map<string, V>, k: string, v: V) => { m.delete(k); m.set(k, v); if (m.size > KEEP_MAX) m.delete(m.keys().next().value as string); };
  // What is known of this reset window: the lowest remaining seen in it. A new window starts only once the last one's
  // reset has passed; an answer from an earlier window, or with a reset that isn't plausible, changes nothing.
  const current = (): Budget | null => (last && last.reset > now() ? { ...last } : null);
  const observe = (b: Budget | null) => {
    if (!b || !plausibleReset(b.reset, now())) return;
    const cur = current();
    if (!cur) { last = b; return; }
    if (b.reset < cur.reset - 60_000) return;                              // an older window's answer: never raises it
    last = { limit: cur.limit, remaining: Math.min(cur.remaining, b.remaining), reset: cur.reset };
  };
  const heldNow = () => { const t = now(); let n = 0; for (const [k, u] of holds) { if (u > t) n++; else holds.delete(k); } return n * RUN_ASKS; };
  const less = (b: Budget | null) => (b ? { ...b, remaining: Math.max(0, b.remaining - heldNow()) } : null);
  const get = (path: string, headers: Record<string, string> = {}) => doFetch(`${base}${path}`, { redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    headers: { accept: "application/vnd.github+json", "user-agent": "cain-link", "x-github-api-version": "2022-11-28", ...headers } });

  async function send(path: string, opts: ApiOpts | undefined): Promise<ApiAnswer> {
    const k = kept.get(path);
    if (k) { hits.push(now()); trim(); return { status: k.status, body: k.body, headers: {} }; }
    // An attempt's job list: whether it may be kept is settled before it is read, so a list read after the attempt was
    // seen completed is final.
    const mayKeep = ATTEMPT_JOBS.test(path) && opts?.confirm ? await Promise.resolve().then(opts.confirm).catch(() => false) === true : false;
    const tag = tags.get(path);
    asked.push(now()); trim();                                             // counted before it is sent: a 304 costs one too
    const r = await get(path, tag ? { "if-none-match": tag.etag } : {});
    const headers = headersOf(r);
    observe(budgetOf(headers));
    if (r.status === 304 && tag) {
      keep(tags, path, tag);
      return { status: 200, body: tag.body, headers: { ...tag.headers, ...headers } };
    }
    const body = await r.json().catch(() => null);
    if ((IMMUTABLE.test(path) && r.status === 200 && body) || (mayKeep && r.status === 200 && finishedJobs(body))) keep(kept, path, { status: r.status, body });
    else if (r.status === 200 && body && headers.etag) keep(tags, path, { etag: headers.etag, body, headers });
    return { status: r.status, body, headers };
  }
  // Every caller gets its own copy, the first one too: nothing a caller changes reaches another or what is kept.
  const own = (a: ApiAnswer): ApiAnswer => ({ status: a.status, body: a.body === null || a.body === undefined ? null : structuredClone(a.body), headers: { ...a.headers } });

  return {
    api(path, opts) {
      let f = flying.get(path);
      if (!f) {
        f = send(path, opts).finally(() => flying.delete(path));
        flying.set(path, f);
      }
      return f.then(own);
    },
    async rateLimit() {
      limits.push(now()); trim();
      try {
        const r = await get("/rate_limit");
        const c = (await r.json().catch(() => null))?.resources?.core;
        const b = { limit: Number(c?.limit), remaining: Number(c?.remaining), reset: Number(c?.reset) * 1000 };
        if (r.status === 200 && [b.limit, b.remaining, b.reset].every((n) => Number.isInteger(n) && n >= 0)) observe(b);
      } catch { /* unknown: what the answers said stands, nothing more */ }
      return current();
    },
    seen: current,
    short: (need) => shortUntil(less(current()), need, now()),
    room: (need) => { const b = less(current()); return !!b && b.remaining >= need; },
    hold: (key, until) => { holds.set(key, until); },
    free: (key) => { holds.delete(key); },
    held: heldNow,
    hour: () => { trim(); return { asked: asked.length, kept: hits.length, limits: limits.length }; },
  };
}

// The card polling's read of one pull request's state (main.ts pullNow): asked at most once every PULL_STATE_EVERY_MS for
// a path, the time kept before it is asked, whatever the answer; and only while more than RESERVE is known to be left after
// the taps' holds, so it stops at the reserve and never spends into it (an unknown hour isn't spent). The body, or null
// (not asked now, or no answer): the caller then reads GitHub's refs, which aren't counted.
export const PULL_STATE_EVERY_MS = 30 * 60_000;
export function pullStateReader(gh: Pick<Github, "api" | "room">, now: () => number = Date.now): (path: string) => Promise<any | null> {
  const asked = new Map<string, number>();
  return async (path) => {
    const at = asked.get(path);
    if (at !== undefined && now() - at < PULL_STATE_EVERY_MS) return null;
    if (!gh.room(RESERVE + 1)) return null;
    asked.set(path, now());
    try { const r = await gh.api(path); return r.status === 200 && r.body ? r.body : null; } catch { return null; }
  };
}
