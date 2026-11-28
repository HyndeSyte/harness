// GitHub's read allowance for the link (Cain 0.19.4). The link reads GitHub's API without a key: GitHub
// allows 60 reads an hour from the Pi's address, and on Nov 27 a day of Ship taps and the link's own
// reads spent the hour, so his Ship tap was refused for a reason that had nothing to do with the change.
// So every read the link makes goes through here:
//   - a file read at a commit (contents?ref=<full sha>) never changes once GitHub has it: its 200 is kept and
//     never read again. A 404 is never kept: GitHub also answers 404 ("No commit found for the ref") for a
//     commit it can't see yet;
//   - the job list of one attempt of a workflow run is kept whole (lists, merge.ts windowsAttempts) only when its
//     first page was asked after a read of that run attempt, not kept, said that very attempt is completed, every
//     page was read, and every job in it finished. The run listing itself is never kept, so each card and landing
//     reads a run's current run_attempt afresh;
//   - (round 2) conditional reads (If-None-Match, ETags) only when the reads are authenticated (conditional): without
//     a key GitHub counts a 304 like any read, so they would save nothing, and the link has no key;
//   - two identical reads at once share one request, and every caller, the first included, gets its own
//     copy of the answer;
//   - each answer's x-ratelimit headers say what is left of the hour, and GitHub's /rate_limit says it on
//     demand. /rate_limit isn't counted against the 60, but it can count against GitHub's secondary
//     limits, so it is read only before a step that spends (a Ship card, his tap's landing, the Ship
//     run's registration: core.ts, ship-pass.ts), never polled in a loop, and its calls are counted on
//     their own. A failed or unreadable /rate_limit is unknown, never a full allowance. Within one reset
//     window the lowest remaining seen stands (an older answer never raises it), and a reset is taken only
//     when it is a plausible time to come (after now, within the hour and a minute);
//   - (round 2) one reservation book for every consumer (makeBook): a tap or a registration reserves its reads when it
//     starts waiting and keeps them across the reset until it lands, is voided, Stopped or runs out; a card build
//     reserves its reads while it builds. Reservations are covered from what is left in the order they were taken, so
//     two of them never count the same reads. Every read that goes out is charged at once (what is left goes down by
//     one, and so does its consumer's reservation); a kept answer or a shared read in flight isn't. A read whose
//     consumer has nothing left (its own covered reservation, or what no reservation covers) isn't sent: it is
//     answered here as a rate-limit refusal until the reset, so the step waits as for GitHub's own;
// Nothing else's credentials take part: no token is read or sent here.
export interface Budget { limit: number; remaining: number; reset: number }   // reset: ms since the epoch
export interface ApiAnswer { status: number; body: any; headers: Record<string, string> }
// as (round 2): the consumer the read is charged to, a key in the reservation book ("tap:<card>", "pass:<pr>:<head>",
// "card:<pr>:<head>"); none: only what no reservation covers.
export interface ApiOpts { as?: string }
export type Fetch = (url: string, init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

// What each step reads at most from GitHub's API (merge.ts, ship-pass.ts), with nothing kept yet and up to 15
// workflow runs on the head: cain/tests/github-budget.test.ts counts each step's reads exactly with 6, 10 and 15
// runs (a card 18, 22 and 27; a landing 13, 17 and 22; a registration 7), and these are those at 15 runs, plus one. A
// Ship card: the pull request, its files, two config.yaml at the base and two at the head, the three required
// checks, the Windows check's attempts, the head's workflow runs and each one's jobs, and tests.yml at the head.
// His tap's landing: the pull request and the same checks. The Ship run's registration: the pull request, the four
// config.yaml, the fingerprint and the probe at the head. They are what a tap and a registration reserve while they
// wait, and what a card build must find free before it reads.
export const CARD_ASKS = 28;
export const LAND_ASKS = 23;
export const REG_ASKS = 8;
export const RUN_ASKS = LAND_ASKS + REG_ASKS;      // one tap's landing and registration
// The card polling (main.ts pullNow) never spends into this: it reads the API only while more than this is free of
// every reservation, and stops at it.
export const RESERVE = RUN_ASKS;
export const RESET_SLACK_MS = 5_000;               // waits run this long past GitHub's reset
export const SECONDARY_WAIT_MS = 3 * 60_000;       // (round 2) a secondary rate limit with no Retry-After: wait this long
const RESET_AHEAD_MS = 3_600_000 + 60_000;         // the latest a reset can plausibly be: an hour and a minute from now
export const IMMUTABLE = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/contents\/[^?]+\?ref=[0-9a-f]{40}$/;
const KEEP_MAX = 400;                              // reads kept (each a small JSON answer); the oldest go first
const HOUR = 3_600_000;

// The time GitHub's hour resets, as people say it ("6:12 PM"), in his time zone.
export function resetClock(ms: number, tz = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

// A reset GitHub gave, in ms: taken only when it is a plausible time to come (after now, within an hour and a minute).
export const plausibleReset = (ms: number, now: number): boolean => Number.isFinite(ms) && ms > now && ms <= now + RESET_AHEAD_MS;

// When a step needing `need` reads would have to wait: the reset time (ms), or null when it can go now
// (enough left, the hour already reset, or nothing known).
export function shortUntil(b: Budget | null | undefined, need: number, now: number): number | null {
  if (!b || !Number.isFinite(b.remaining) || !Number.isFinite(b.reset)) return null;
  return b.remaining < need && b.reset > now ? b.reset : null;
}

// (round 2) A read GitHub refused for a rate limit, in registration and landing alike: a 429; or a 403 with
// x-ratelimit-remaining 0 (the hour spent), a Retry-After header, or a body naming GitHub's secondary rate limit.
// Any other failure is an ordinary one.
const secondary = (body: any): boolean => {
  let said = "";
  try { said = typeof body === "string" ? body : JSON.stringify(body ?? ""); } catch { said = ""; }
  return /secondary rate limit/i.test(said);
};
export const rateRefused = (r: { status: number; headers?: Record<string, string>; body?: any } | null | undefined): boolean =>
  !!r && (r.status === 429 || (r.status === 403 && (String(r.headers?.["x-ratelimit-remaining"] ?? "").trim() === "0"
    || r.headers?.["retry-after"] !== undefined || secondary(r.body))));
// When to read again after such a refusal (ms): its Retry-After when it has one; the primary reset (x-ratelimit-reset)
// when the hour is spent; SECONDARY_WAIT_MS for a secondary limit with no Retry-After. null when what it gives isn't a
// plausible time to come (the caller can't tell when). The callers' expiry checks apply to this time.
export function refusedUntil(r: { status: number; headers?: Record<string, string>; body?: any } | Record<string, string> | undefined, now: number): number | null {
  const answer = r && typeof (r as any).status === "number" ? r as { status: number; headers?: Record<string, string>; body?: any } : { status: 429, headers: r as Record<string, string> | undefined };
  const h = answer.headers ?? {};
  const ra = h["retry-after"]?.trim();
  if (ra !== undefined) {
    const after = /^\d{1,6}$/.test(ra) ? Number(ra) * 1000 : NaN;
    return Number.isFinite(after) && plausibleReset(now + after + 1, now) ? now + after : null;
  }
  const reset = Number(h["x-ratelimit-reset"]) * 1000;
  if (String(h["x-ratelimit-remaining"] ?? "").trim() === "0") return h["x-ratelimit-reset"] !== undefined && plausibleReset(reset, now) ? reset : null;
  return now + SECONDARY_WAIT_MS;                  // a secondary limit (or a 429 with neither): a bounded wait
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

// (round 2) The one reservation book. seen: what is known left of this hour (null: unknown). A reservation holds n
// reads until a time; reservations are covered from what is left in the order they were first taken (one taken again
// keeps its place and what it has left), so two never count the same reads. spare(key): what that consumer may still
// spend now, its own covered reservation and whatever no reservation covers; null when nothing is known.
export interface Book {
  reserve: (key: string, n: number, until: number) => void;
  release: (key: string) => void;
  spare: (key?: string) => number | null;
  charge: (key?: string) => void;                  // one read went out for this consumer
  reserved: () => Record<string, number>;          // what each reservation has left (the tests and the log)
}
export function makeBook(seen: () => Budget | null, now: () => number): Book {
  const book = new Map<string, { n: number; until: number }>();
  const live = () => { const t = now(); for (const [k, r] of book) if (r.until <= t) book.delete(k); return book; };
  return {
    reserve: (key, n, until) => { const r = live().get(key); if (r) r.until = Math.max(r.until, until); else book.set(key, { n: Math.max(0, n), until }); },
    release: (key) => { book.delete(key); },
    spare: (key) => {
      const b = seen();
      if (!b) return null;
      let left = b.remaining, own = 0;
      for (const [k, r] of live()) { const cover = Math.min(r.n, left); if (k === key) own = cover; left -= cover; }
      return own + left;
    },
    charge: (key) => { const r = key ? live().get(key) : undefined; if (r && r.n > 0) r.n--; },
    reserved: () => Object.fromEntries([...live()].map(([k, r]) => [k, r.n])),
  };
}

export interface Github {
  api: (path: string, o?: ApiOpts) => Promise<ApiAnswer>;
  // GitHub's /rate_limit now (not counted against the 60; counted on its own), joined with what the answers said: the
  // lowest remaining seen in this reset window, or null (unknown) when nothing plausible is known for it
  rateLimit: () => Promise<Budget | null>;
  seen: () => Budget | null;                       // the same, with no request
  book: Book;
  room: (need: number) => boolean;                 // known, and at least `need` free of every reservation (the card polling)
  // (round 2) an attempt's whole job list, kept once it can't change (merge.ts windowsAttempts); a get counts as kept
  lists: { get: (key: string) => any[] | undefined; put: (key: string, jobs: any[]) => void };
  // reads sent to GitHub in the last hour, reads answered from what was kept, and /rate_limit calls
  hour: () => { asked: number; kept: number; limits: number };
}

// conditional: send If-None-Match with the ETag last given (only worth it on authenticated reads, which the link
// doesn't make: without a key GitHub counts a 304 like any read).
export function makeGithub(o: { fetch?: Fetch; now?: () => number; base?: string; timeoutMs?: number; conditional?: boolean } = {}): Github {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const base = o.base ?? "https://api.github.com";
  const kept = new Map<string, { status: number; body: any }>();          // reads that never change
  const whole = new Map<string, any[]>();                                  // attempts' whole job lists
  const tags = new Map<string, { etag: string; body: any; headers: Record<string, string> }>();
  const flying = new Map<string, Promise<ApiAnswer>>();
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
  const book = makeBook(current, now);
  const get = (path: string, headers: Record<string, string> = {}) => doFetch(`${base}${path}`, { redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    headers: { accept: "application/vnd.github+json", "user-agent": "cain-link", "x-github-api-version": "2022-11-28", ...headers } });

  async function send(path: string, opts: ApiOpts | undefined): Promise<ApiAnswer> {
    const k = kept.get(path);
    if (k) { hits.push(now()); trim(); return { status: k.status, body: k.body, headers: {} }; }
    // Nothing left for this consumer: not sent, answered as GitHub's own rate-limit refusal until the reset.
    const b = current(), spare = book.spare(opts?.as);
    if (b && spare !== null && spare < 1)
      return { status: 429, body: { message: "the link's count of GitHub's hour has nothing left for this step" },
        headers: { "x-ratelimit-limit": String(b.limit), "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(b.reset / 1000)), "x-cain-local": "1" } };
    // Charged as it goes out: what is left goes down by one at once, and so does its consumer's reservation.
    book.charge(opts?.as);
    if (last && last.reset > now()) last = { ...last, remaining: Math.max(0, last.remaining - 1) };
    const tag = o.conditional ? tags.get(path) : undefined;
    asked.push(now()); trim();
    const r = await get(path, tag ? { "if-none-match": tag.etag } : {});
    const headers = headersOf(r);
    observe(budgetOf(headers));
    if (r.status === 304 && tag) {
      keep(tags, path, tag);
      return { status: 200, body: tag.body, headers: { ...tag.headers, ...headers } };
    }
    const body = await r.json().catch(() => null);
    if (IMMUTABLE.test(path) && r.status === 200 && body) keep(kept, path, { status: r.status, body });
    else if (o.conditional && r.status === 200 && body && headers.etag) keep(tags, path, { etag: headers.etag, body, headers });
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
    book,
    room: (need) => { const s = book.spare(); return s !== null && s >= need; },
    lists: {
      get: (key) => { const l = whole.get(key); if (l) { hits.push(now()); trim(); return structuredClone(l); } return undefined; },
      put: (key, jobs) => keep(whole, key, structuredClone(jobs)),
    },
    hour: () => { trim(); return { asked: asked.length, kept: hits.length, limits: limits.length }; },
  };
}

// The card polling's read of one pull request's state (main.ts pullNow): asked at most once every PULL_STATE_EVERY_MS for
// a path, the time kept before it is asked, whatever the answer; and only while more than RESERVE is known to be free of
// every reservation, so it stops at the reserve and never spends into it (an unknown hour isn't spent). The body, or null
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
