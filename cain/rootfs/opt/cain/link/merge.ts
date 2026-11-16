// Landing a pull request on Dane's Ship tap (wave 1, piece B). main is locked so that
// only the link's deploy key (deploykey.ts) can update it (RELEASING.md); this is the
// one place that key is used. It lands exactly the commit his Ship card was for, as a
// fast-forward of main, after checking:
//   - on GitHub's API: the pull request is open, into main, from a branch of this
//     repository, still at that head, and its pytest, bun and pr checks passed there
//     (GitHub Actions), and pcjobs-windows too whenever the head's tests.yml names it
//     or it ran there (headChecks);
//   - over SSH with the deploy key: the pull request's head is that commit, and main
//     is an ancestor of it (so nothing on main is lost, and nothing is merged in);
//   - right before the push: nothing is stopped.
// The push itself is a plain fast-forward, never forced: if main moved meanwhile, git
// refuses it. A push that fails ambiguously (a timeout) is settled by reading main
// again. Nothing here retries a push.
export const ACTIONS_APP = 15368;               // GitHub Actions, the source of the required checks
export const CHECKS = ["pytest", "bun", "pr"] as const;
// The Windows run of the PC worker's tests (tests.yml). No ruleset requires it (that takes
// admin rights), so the link does: whenever the head's tests.yml names it, or it ran on the
// head, a Ship card waits for every run of it on that very head to pass (judgeChecks), and
// so does the landing.
export const WINDOWS_CHECK = "pcjobs-windows";
const TESTS_YML = ".github/workflows/tests.yml";

export interface Git { code: number; out: string; err: string }
export interface MergeDeps {
  api: (path: string) => Promise<{ status: number; body: any }>;     // GET https://api.github.com<path>
  git: (args: string[], o?: { ssh?: boolean; timeoutMs?: number }) => Promise<Git>;
  stopped: () => boolean;
  remote?: (repo: string) => string;   // where git fetches and pushes; GitHub over SSH unless a test says
}
export interface Landing { repo: string; pr: number; head: string }
export type Landed =
  | { ok: true; already: boolean }
  | { ok: false; why: string; again: boolean; stopped?: boolean };

const no = (why: string, again = false): Landed => ({ ok: false, why, again });
const first = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? "";
export const remote = (repo: string) => `git@github.com:${repo}.git`;
const where = (d: Pick<MergeDeps, "remote">, repo: string) => d.remote?.(repo) ?? remote(repo);

// What GitHub says to the deploy key over SSH (ssh -T git@github.com): it knows the key
// (it greets the repository the key belongs to), it doesn't, or it couldn't be reached.
export function keyAnswer(said: string, repo: string): boolean | null {
  if (said.toLowerCase().includes(`hi ${repo.toLowerCase()}!`)) return true;
  if (/permission denied \(publickey\)/i.test(said)) return false;
  return null;
}

// What a pull request changes, for the lines the link builds its Ship card from: GitHub's
// count of its commits and files, the parts it touches that matter most, and (0.11.0) its
// title and what the tap installs.
export interface Facts {
  head: string; commits: number; files: number; areas: string[];
  title?: string;
  bumps?: Bump[] | null;             // what the tap installs (bumpsAt); null: it can't be told
  merged?: boolean;                  // GitHub says it's merged (its head is in main)
}
export interface Bump { app: string; version: string }
const APP_CONFIGS: [string, string][] = [["Cain", "cain/config.yaml"], ["Harness", "harness/config.yaml"]];
const SHA = /^[0-9a-f]{40}$/;
// At most this many pages of a pull request's files are read, for the parts it touches: the
// Apps' versions don't come from them, so a cut list costs only a part not named.
const FILE_PAGES = 3;
const AREAS: [RegExp, string][] = [
  [/^cain\/rootfs\/opt\/cain\/link\//, "Cain's link"],
  [/^cain\/rootfs\/opt\/cain\/hooks\//, "Cain's hooks"],
  [/^cain\/rootfs\/opt\/cain\/settings\.json$/, "Cain's permissions"],
  [/^cain\/rootfs\/opt\/cain\/CLAUDE\.md$/, "Cain's rules"],
  [/^cain\/rootfs\/opt\/cain\/(ship-token|stop)\.ts$/, "Ship and Stop"],
  [/^\.github\//, "GitHub's workflows"],
  [/^(cain|harness)\/Dockerfile$/, "an App's image"],
  [/^RELEASING\.md$/, "the release rules"],
];

// head: the commit the Ship card names. The Apps' versions are read at that very commit (and
// at the pull request's base), never from the pull request's files, which can change between
// two reads; without a head, at the head GitHub gives.
export async function facts(d: Pick<MergeDeps, "api">, repo: string, pr: number, head?: string): Promise<Facts | null> {
  const p = await read(d, `/repos/${repo}/pulls/${pr}`);
  if (!p || p === "missing") return null;
  const at = (head && SHA.test(head.toLowerCase()) ? head : String(p.head?.sha ?? "")).toLowerCase();
  const base = String(p.base?.sha ?? "").toLowerCase();
  const [names, bumps] = await Promise.all([fileNames(d, repo, pr), bumpsAt(d, repo, base, at).catch(() => null)]);
  if (!names) return null;
  return {
    head: String(p.head?.sha ?? "").toLowerCase(),
    commits: Number(p.commits) || 0,
    files: Number(p.changed_files) || names.length,
    areas: AREAS.filter(([re]) => names.some((n) => re.test(n))).map(([, w]) => w),
    title: typeof p.title === "string" ? p.title : "",
    bumps,
    merged: p.merged === true,
  };
}

// The names of a pull request's files, up to FILE_PAGES pages; null when GitHub doesn't answer.
async function fileNames(d: Pick<MergeDeps, "api">, repo: string, pr: number): Promise<string[] | null> {
  const names: string[] = [];
  for (let page = 1; page <= FILE_PAGES; page++) {
    const f = await read(d, `/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    if (!Array.isArray(f)) return null;
    names.push(...f.map((x: any) => String(x?.filename ?? "")));
    if (f.length < 100) break;
  }
  return names;
}

// What the tap installs (0.11.0): each App whose config.yaml version at the head differs from
// its version at the pull request's base, both read at those very commits, Cain first; []
// when none differs. null when any of it can't be read: then what installs can't be told,
// and the card never says nothing does. An App with no config.yaml at the head installs nothing.
export async function bumpsAt(d: Pick<MergeDeps, "api">, repo: string, base: string, head: string): Promise<Bump[] | null> {
  if (!SHA.test(base) || !SHA.test(head)) return null;
  const got = await Promise.all(APP_CONFIGS.flatMap(([, path]) => [versionAt(d, repo, path, base), versionAt(d, repo, path, head)]));
  if (got.some((v) => v === null)) return null;
  const out: Bump[] = [];
  APP_CONFIGS.forEach(([app], i) => {
    const before = got[2 * i], after = got[2 * i + 1];
    if (after !== "none" && after !== before) out.push({ app, version: after as string });
  });
  return out;
}

// An App's version in its config.yaml at one commit: the version, "none" (no such file
// there), or null (GitHub didn't answer, or the file has no version line it can read).
const VERSION_LINE = /^version:[ \t]*(["']?)([0-9]+(?:\.[0-9]+){1,3})\1[ \t]*(?:#.*)?$/m;
async function versionAt(d: Pick<MergeDeps, "api">, repo: string, path: string, sha: string): Promise<string | "none" | null> {
  const r = await read(d, `/repos/${repo}/contents/${path}?ref=${sha}`);
  if (r === "missing") return "none";
  if (!r || typeof r.content !== "string" || r.encoding !== "base64") return null;
  const m = VERSION_LINE.exec(Buffer.from(r.content, "base64").toString("utf8"));
  return m ? m[2] : null;
}

// A commit's check runs as GitHub has them, read one way for the landing and the Ship card
// (0.11.0): for each required check, by its name, GitHub Actions' latest runs of it, whole: a
// longer list is read page by page, and kept only when every page gives the same total, no
// run comes twice, and the pages add up to that total. So a judgment never rests on part of
// the runs, or on a list that shifted while it was read. The runs, "missing" (GitHub has no
// such commit), or null (no answer, or a list that isn't whole: then nothing is judged).
const RUN_PAGES = 10;                 // 1,000 runs of one check: past that it can't be judged, and the landing waits
async function runsOf(d: Pick<MergeDeps, "api">, repo: string, head: string, name: string, filter: "latest" | "all" = "latest"): Promise<any[] | "missing" | null> {
  return pagesOf(d, (page) => `/repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&app_id=${ACTIONS_APP}&filter=${filter}&per_page=100&page=${page}`, "check_runs");
}
// One listing of GitHub's, followed page by page until it is whole (0.12.0, shared by every
// listing the checks read): each page gives the same total, no item comes twice, and the
// pages add up to that total. A page that fails, a total that shifts, a short page before the
// total is reached, or more than RUN_PAGES pages: null, so nothing is judged on part of it.
// "missing" only when the very first page says there's no such thing.
async function pagesOf(d: Pick<MergeDeps, "api">, path: (page: number) => string, key: string): Promise<any[] | "missing" | null> {
  const got: any[] = [];
  let total: number | null = null;
  for (let page = 1; page <= RUN_PAGES; page++) {
    const r = await read(d, path(page));
    if (r === "missing") return page === 1 ? "missing" : null;
    if (!r || !Array.isArray(r[key])) return null;
    const t = Number(r.total_count);
    if (!Number.isInteger(t) || t < 0 || (total !== null && t !== total)) return null;
    total = t;
    got.push(...r[key]);
    if (got.length >= total || r[key].length < 100) break;
  }
  const ids = new Set(got.map((x) => x?.id));
  return got.length === total && ids.size === got.length ? got : null;
}

// Every attempt of pcjobs-windows GitHub lists for the head (0.12.0, seventeenth round), read two
// ways and joined, so neither listing alone decides:
//   - the head's check runs of that name from GitHub Actions with filter=all (every attempt,
//     not only the newest), every page;
//   - GitHub Actions' workflow runs for the head, every page, and for each run every attempt
//     (1 to its run_attempt), that attempt's jobs, every page; a job named pcjobs-windows is
//     an attempt (a job's id is its check run's id, so the two listings join by id).
// Any listing that isn't whole, a page that fails, or more than ATTEMPT_LISTS attempt listings:
// null, and the gate holds. trace, when given, gets every path read, for the dry run.
const ATTEMPT_LISTS = 30;
export interface WindowsAttempt { id: number; name: string; status: string; conclusion: string | null; head_sha: string; app: { id: number }; run_id?: number; run_attempt?: number; via: string[] }
export async function windowsAttempts(d: Pick<MergeDeps, "api">, repo: string, head: string): Promise<WindowsAttempt[] | "missing" | null> {
  const checks = await runsOf(d, repo, head, WINDOWS_CHECK, "all");
  if (checks === "missing") return "missing";
  if (checks === null) return null;
  const runs = await pagesOf(d, (page) => `/repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=${page}`, "workflow_runs");
  if (runs === null || runs === "missing") return null;
  const out = new Map<number, WindowsAttempt>();
  // Failed over still going over passed: where the two listings disagree on an attempt, the worse reading stands.
  const rank = (z: { status: string; conclusion: string | null }) => z.status !== "completed" ? 1 : z.conclusion === "success" ? 0 : 2;
  const add = (x: any, via: string, extra: Partial<WindowsAttempt> = {}) => {
    const id = Number(x?.id);
    if (!Number.isFinite(id)) return;
    const prev = out.get(id);
    const a: WindowsAttempt = { id, name: String(x?.name ?? ""), status: String(x?.status ?? ""), conclusion: x?.conclusion ?? null,
      head_sha: String(x?.head_sha ?? ""), app: { id: Number(x?.app?.id ?? extra.app?.id) }, ...extra, via: [...(prev?.via ?? []), via] };
    out.set(id, prev && rank(prev) >= rank(a) ? { ...prev, ...extra, status: prev.status, conclusion: prev.conclusion, via: a.via } : prev ? { ...prev, ...a } : a);
  };
  for (const c of checks) if (c?.name === WINDOWS_CHECK && c?.app?.id === ACTIONS_APP) add(c, "check_runs");
  let lists = 0;
  for (const r of runs) {
    if (r?.head_sha !== head) continue;
    const n = Number(r?.run_attempt ?? 1);
    if (!Number.isInteger(n) || n < 1) return null;
    for (let a = 1; a <= n; a++) {
      if (++lists > ATTEMPT_LISTS) return null;
      const jobs = await pagesOf(d, (page) => `/repos/${repo}/actions/runs/${r.id}/attempts/${a}/jobs?per_page=100&page=${page}`, "jobs");
      if (jobs === null || jobs === "missing") return null;
      for (const j of jobs) if (j?.name === WINDOWS_CHECK)
        add({ ...j, head_sha: j?.head_sha ?? head }, `run ${r.id} attempt ${a}`, { app: { id: ACTIONS_APP }, run_id: Number(r.id), run_attempt: a });
    }
  }
  return [...out.values()];
}
export async function checkRuns(d: Pick<MergeDeps, "api">, repo: string, head: string): Promise<any[] | "missing" | null> {
  const each = await Promise.all(CHECKS.map((name) => runsOf(d, repo, head, name)));
  if (each.some((r) => r === "missing")) return "missing";
  if (each.some((r) => r === null)) return null;
  return (each as any[][]).flat();
}

// The head's checks as a Ship card and the landing judge them: the required checks' runs
// (checkRuns), pcjobs-windows's runs read the same way, and whether the head's tests.yml names
// pcjobs-windows at all. Any mention of it there counts (fail closed: a renamed or commented
// job still makes the card wait for a run under that name). windows: it must pass, since
// tests.yml names it or it ran on the head. "missing" or null as for checkRuns; null too
// when tests.yml can't be read, so nothing is judged without knowing whether it's defined.
export interface HeadChecks { runs: any[]; windows: boolean }
export async function headChecks(d: Pick<MergeDeps, "api">, repo: string, head: string): Promise<HeadChecks | "missing" | null> {
  const h = await headDetail(d, repo, head);
  return h === "missing" || h === null ? h : h.checks;
}
// The same reading with what it rests on, for the dry run and the probe's ship_gate step
// (shipGate, below): the workflow file read at the head (named: it names pcjobs-windows;
// absent: the head has no tests.yml) and every Windows attempt seen.
export interface HeadDetail { checks: HeadChecks; workflow: { file: string; read: "named" | "not_named" | "absent" }; attempts: WindowsAttempt[] }
export async function headDetail(d: Pick<MergeDeps, "api">, repo: string, head: string): Promise<HeadDetail | "missing" | null> {
  const [req, win, yml] = await Promise.all([checkRuns(d, repo, head), windowsAttempts(d, repo, head), read(d, `/repos/${repo}/contents/${TESTS_YML}?ref=${head}`)]);
  if (req === "missing" || win === "missing") return "missing";
  if (req === null || win === null || yml === null) return null;
  let named = false;
  if (yml !== "missing") {
    if (typeof yml.content !== "string" || yml.encoding !== "base64") return null;
    named = Buffer.from(yml.content, "base64").toString("utf8").includes(WINDOWS_CHECK);
  }
  // A Windows run for another commit (a stale head) isn't this head's run: it is left out, so
  // it can neither pass the head nor count as having run there (0.12.0). Only a run whose
  // head_sha is this very head counts.
  const mine = win.filter((r) => r?.head_sha === head);
  const ran = mine.some((r) => r?.name === WINDOWS_CHECK && r?.app?.id === ACTIONS_APP);
  return { checks: { runs: [...req, ...mine], windows: named || ran },
    workflow: { file: TESTS_YML, read: yml === "missing" ? "absent" : named ? "named" : "not_named" }, attempts: mine };
}

// Each required check's newest run from GitHub Actions: passed (success only), still
// running, failed (any other conclusion, skipped, neutral and cancelled too), or not run
// yet; with windows, pcjobs-windows after them, judged stricter (0.12.0): every attempt of it
// GitHub lists on the head counts, in whatever order they come, so one still going holds it
// and one that didn't pass refuses it even beside a green re-run. A flaky Windows run needs a
// new commit. The one judgment for the landing (failedChecks) and the Ship card.
export interface CheckState { name: string; state: "passed" | "running" | "failed" | "missing"; conclusion?: string }
export function judgeChecks(runs: any[], windows = false): CheckState[] {
  const names: string[] = windows ? [...CHECKS, WINDOWS_CHECK] : [...CHECKS];
  return names.map((name): CheckState => {
    const mine = runs.filter((r) => r?.name === name && r?.app?.id === ACTIONS_APP).sort((a, b) => Number(b.id) - Number(a.id));
    const r = mine[0];
    if (!r) return { name, state: "missing" };
    if (name === WINDOWS_CHECK) {
      const bad = mine.find((x) => x.status === "completed" && x.conclusion !== "success");
      if (bad) return { name, state: "failed", conclusion: String(bad.conclusion ?? "no result") };
      if (mine.some((x) => x.status !== "completed")) return { name, state: "running" };
      return { name, state: "passed" };
    }
    if (r.status !== "completed") return { name, state: "running" };
    if (r.conclusion !== "success") return { name, state: "failed", conclusion: String(r.conclusion ?? "no result") };
    return { name, state: "passed" };
  });
}

// One answer from GitHub's API, tried twice: its body, "missing" (GitHub says there's no
// such thing), or null (no answer). A 403 or 429 (a rate limit, or a refusal) isn't asked
// again: the link shares 60 unauthenticated reads an hour, and asking at once won't mend it.
// It is a failed page (null), whatever its body holds: the listing isn't whole, and the landing,
// the Ship card and the gate's report all hold on it.
async function read(d: Pick<MergeDeps, "api">, path: string): Promise<any | "missing" | null> {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await d.api(path);
      if (r.status === 200 && r.body) return r.body;
      if (r.status === 404) return "missing";
      if (r.status === 403 || r.status === 429) return null;
    } catch { /* try once more */ }
  }
  return null;
}

// Fetched over SSH with the deploy key: main as GitHub has it now, and the very commit
// his card was for (by its sha, so no ref that lags behind can stand in for it), into
// refs the link keeps for itself. A key GitHub refuses, a host key that isn't GitHub's,
// a commit GitHub doesn't have, or one that fails the link's check won't mend by
// waiting: those end the landing. Anything else (the network, a timeout) is tried again.
async function fetchBoth(d: MergeDeps, l: Landing, withHead: boolean): Promise<Landed | null> {
  const r = await d.git(["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", where(d, l.repo),
    ...(withHead ? [`+${l.head}:refs/ship/pull`] : []), "+refs/heads/main:refs/ship/main"], { ssh: true, timeoutMs: 90_000 });
  if (r.code === 0) return null;
  if (KEY_REFUSED.test(r.err)) return no(DEPLOY_KEY_REFUSED);
  if (HOST_KEY.test(r.err)) return no("GitHub's SSH host key isn't one the link knows, so it won't send anything there");
  if (/not our ref|unadvertised object|couldn't find remote ref|no such remote ref/i.test(r.err)) return no("GitHub doesn't have that commit");
  if (/fsck|is corrupt|bad object|missing (blob|tree|commit)/i.test(r.err)) return no("what GitHub sent failed the link's check (fsck), so it won't land it");
  return no(`the link couldn't fetch it from GitHub (${first(r.err) || `git exit ${r.code}`})`, true);
}
const KEY_REFUSED = /permission denied \(publickey\)|denied to deploy key|ERROR: Repository not found/i;
const HOST_KEY = /host key verification failed|remote host identification has changed/i;
const DEPLOY_KEY_REFUSED = "GitHub refused the link's deploy key, so shipping needs its key set up again";

async function sha(d: MergeDeps, ref: string): Promise<string> {
  const r = await d.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.out.trim() : "";
}

async function ancestor(d: MergeDeps, a: string, b: string): Promise<boolean> {
  return (await d.git(["merge-base", "--is-ancestor", a, b])).code === 0;
}

// Whether main has this commit now: true, false, or null when GitHub can't be read.
export async function inMain(d: MergeDeps, repo: string, head: string): Promise<boolean | null> {
  const r = await d.git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", where(d, repo), "+refs/heads/main:refs/ship/main"],
    { ssh: true, timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  if (!(await sha(d, head))) return false;
  return ancestor(d, head, "refs/ship/main");
}

// The first check, in order, that keeps it from landing.
export function failedChecks(h: HeadChecks): Landed | null {
  for (const c of judgeChecks(h.runs, h.windows)) {
    if (c.state === "missing") return no(`CI hasn't run ${c.name} on it`);
    if (c.state === "running") return no(`CI is still running ${c.name} on it`, true);
    if (c.state === "failed") return no(`CI's ${c.name} check didn't pass on it (${c.conclusion})`);
  }
  return null;
}

export async function land(d: MergeDeps, l: Landing): Promise<Landed> {
  const repo = l.repo.toLowerCase();
  const pull = await read(d, `/repos/${l.repo}/pulls/${l.pr}`);
  if (pull === "missing") return no("GitHub has no such pull request");
  if (!pull) return no("GitHub didn't answer about the pull request", true);
  const merged = pull.merged === true;
  if (!merged) {
    if (pull.state !== "open") return no("the pull request was closed");
    if (String(pull.base?.ref ?? "") !== "main") return no("it isn't a pull request into main");
    if (String(pull.head?.repo?.full_name ?? "").toLowerCase() !== repo) return no("its branch isn't in this repository");
    if (String(pull.head?.sha ?? "").toLowerCase() !== l.head) return no("its branch moved on since the card: it has newer commits");
    const runs = await headChecks(d, l.repo, l.head);
    if (runs === "missing") return no("GitHub doesn't have that commit");
    if (!runs) return no("GitHub didn't answer about its checks", true);
    const bad = failedChecks(runs);
    if (bad) return bad;
  }
  const fetched = await fetchBoth(d, l, !merged);
  if (fetched) return fetched;
  // Already in main (an earlier tap landed it, or GitHub says it's merged): nothing to push.
  if (await ancestor(d, l.head, "refs/ship/main")) return { ok: true, already: true };
  if (merged) return no("GitHub says it's merged, but main doesn't have that commit");
  if ((await sha(d, "refs/ship/pull")) !== l.head) return no("GitHub sent something other than the commit his card was for");
  if (!(await ancestor(d, "refs/ship/main", l.head)))
    return no("main moved on since its branch was made: the branch needs main merged in, then a new Ship card");
  if (d.stopped()) return { ok: false, why: "everything is stopped", again: false, stopped: true };
  const push = await d.git(["push", "--porcelain", "--no-verify", where(d, l.repo), `${l.head}:refs/heads/main`], { ssh: true, timeoutMs: 90_000 });
  if (push.code === 0) return { ok: true, already: false };
  // Did it land anyway (the answer was lost)? main says.
  if ((await inMain(d, l.repo, l.head)) === true) return { ok: true, already: false };
  const said = `${push.out}\n${push.err}`;
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(said))
    return no("main moved on while it was landing: the branch needs main merged in, then a new Ship card");
  if (KEY_REFUSED.test(said) || /read.only|key is not/i.test(said)) return no(DEPLOY_KEY_REFUSED);
  if (/rule violation|protected branch|GH0\d\d/i.test(said)) return no(`GitHub refused it (${first(push.err)})`);
  return no(`the push to GitHub failed (${first(push.err) || `git exit ${push.code}`})`, true);
}

// ---- The Windows gate, read without acting: the dry run and the probe's ship_gate step ----------
// The very reading the landing and the Ship card make (headDetail, judgeChecks, failedChecks),
// for one head, with nothing posted, landed or written to GitHub: what the gate would decide
// ("accept": a card and a landing may go on; "hold": it waits, as for a check still running or
// GitHub not answering; "refuse": it won't), and why, with the workflow file it read and every
// Windows attempt it saw. Run by keeper.sh ship-gate (shipgate.ts) against the real repository.
export type GateDecision = "accept" | "hold" | "refuse";
export interface GateReport { head: string; at: string; decision: GateDecision; why: string; windows: CheckState["state"] | "not_required" | null;
  workflow: HeadDetail["workflow"] | null; attempts: { id: number; status: string; conclusion: string | null; run_id?: number; run_attempt?: number; via: string[] }[] }
// A rate-limit page (HTTP 403 or 429) anywhere in the reading counts as a failed page (0.12.0,
// eighteenth round): the report holds, whatever the rest of the reading said, and never accepts.
export const RATE_LIMITED = [403, 429];
export async function gateReport(d: Pick<MergeDeps, "api">, repo: string, head: string, now = () => new Date()): Promise<GateReport> {
  const at = now().toISOString();
  if (!SHA.test(head)) return { head, at, decision: "refuse", why: "that isn't a full commit sha", windows: null, workflow: null, attempts: [] };
  let limited = false;
  const seen: Pick<MergeDeps, "api"> = { api: async (path) => { const r = await d.api(path); if (RATE_LIMITED.includes(r.status)) limited = true; return r; } };
  const h = await headDetail(seen, repo, head);
  if (limited) return { head, at, decision: "hold", why: "GitHub's rate limit (HTTP 403 or 429) stopped a page of the reading, so nothing is judged on it", windows: null, workflow: null, attempts: [] };
  if (h === "missing") return { head, at, decision: "refuse", why: "GitHub doesn't have that commit", windows: null, workflow: null, attempts: [] };
  if (h === null) return { head, at, decision: "hold", why: "GitHub didn't answer about its checks, or a listing wasn't whole", windows: null, workflow: null, attempts: [] };
  const w = h.checks.windows ? judgeChecks(h.checks.runs, true).find((c) => c.name === WINDOWS_CHECK)!.state : "not_required";
  const bad = failedChecks(h.checks);
  const attempts = h.attempts.map((a) => ({ id: a.id, status: a.status, conclusion: a.conclusion, ...(a.run_id ? { run_id: a.run_id, run_attempt: a.run_attempt } : {}), via: a.via }));
  if (!bad || bad.ok) return { head, at, decision: "accept", why: w === "passed" ? "every required check passed, and every pcjobs-windows attempt on it passed" : "every required check passed; pcjobs-windows isn't named in its tests.yml and never ran on it", windows: w, workflow: h.workflow, attempts };
  return { head, at, decision: bad.again ? "hold" : "refuse", why: bad.why, windows: w, workflow: h.workflow, attempts };
}
// The probe's ship_gate step: the gate's reports for one candidate head, taken over time from
// just after its push until its Windows run has finished. It passes only when the gate was seen
// not accepting (hold or refuse) while a Windows attempt was still going, never accepted while
// any attempt was going or had failed, and accepted at the end, once every attempt it saw had
// passed. Every attempt seen in any report is listed.
export interface ShipGateLine { step: "ship_gate"; head: string; workflow: HeadDetail["workflow"] | null; reports: GateReport[]; attempts_seen: number[];
  refused_while_pending: boolean; accepted_early: boolean; accepted_after_pass: boolean; passed: boolean }
export function judgeShipGate(head: string, reports: GateReport[]): ShipGateLine {
  const going = (r: GateReport) => r.attempts.some((a) => a.status !== "completed");
  const failed = (r: GateReport) => r.attempts.some((a) => a.status === "completed" && a.conclusion !== "success");
  const refused_while_pending = reports.some((r) => going(r) && r.decision !== "accept");
  const accepted_early = reports.some((r) => r.decision === "accept" && (going(r) || failed(r) || r.windows !== "passed"));
  const last = reports.at(-1);
  const accepted_after_pass = !!last && last.decision === "accept" && last.windows === "passed" && last.attempts.length > 0
    && last.attempts.every((a) => a.status === "completed" && a.conclusion === "success");
  const attempts_seen = [...new Set(reports.flatMap((r) => r.attempts.map((a) => a.id)))].sort((a, b) => a - b);
  return { step: "ship_gate", head, workflow: [...reports].reverse().find((r) => r.workflow)?.workflow ?? null, reports, attempts_seen,
    refused_while_pending, accepted_early, accepted_after_pass, passed: refused_while_pending && !accepted_early && accepted_after_pass };
}
// Watches one head: a report now, then one every everyMs until the gate accepts, refuses for
// good, or untilMs passes; the line is judged on every report taken.
export async function watchShipGate(d: Pick<MergeDeps, "api">, repo: string, head: string, o: { everyMs: number; untilMs: number; sleep?: (ms: number) => Promise<void>; now?: () => Date; each?: (r: GateReport) => void }): Promise<ShipGateLine> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const now = o.now ?? (() => new Date());
  const t0 = now().getTime();
  const reports: GateReport[] = [];
  while (true) {
    const r = await gateReport(d, repo, head, now);
    reports.push(r);
    o.each?.(r);
    // A run not listed yet (just after the push) is watched on; a failed attempt settles it.
    const settled = r.decision === "accept" || r.windows === "failed" || (r.decision === "refuse" && r.windows !== "missing");
    if (settled || now().getTime() - t0 + o.everyMs > o.untilMs) break;
    await sleep(o.everyMs);
  }
  return judgeShipGate(head, reports);
}
