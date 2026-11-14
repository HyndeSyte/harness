// Landing a pull request on Dane's Ship tap (wave 1, piece B). main is locked so that
// only the link's deploy key (deploykey.ts) can update it (RELEASING.md); this is the
// one place that key is used. It lands exactly the commit his Ship card was for, as a
// fast-forward of main, after checking:
//   - on GitHub's API: the pull request is open, into main, from a branch of this
//     repository, still at that head, and its pytest, bun and pr checks passed there
//     (GitHub Actions);
//   - over SSH with the deploy key: the pull request's head is that commit, and main
//     is an ancestor of it (so nothing on main is lost, and nothing is merged in);
//   - right before the push: nothing is stopped.
// The push itself is a plain fast-forward, never forced: if main moved meanwhile, git
// refuses it. A push that fails ambiguously (a timeout) is settled by reading main
// again. Nothing here retries a push.
export const ACTIONS_APP = 15368;               // GitHub Actions, the source of the required checks
export const CHECKS = ["pytest", "bun", "pr"] as const;

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
// (0.11.0): for each required check, by its name, its latest runs, each in one answer whose
// count GitHub says and whose list agree, so a judgment never rests on part of them or on a
// list that shifted between pages. The runs, "missing" (GitHub has no such commit), or null
// (no answer, or an answer whose count and list disagree: then nothing is judged).
export async function checkRuns(d: Pick<MergeDeps, "api">, repo: string, head: string): Promise<any[] | "missing" | null> {
  const each = await Promise.all(CHECKS.map((name) =>
    read(d, `/repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`)));
  if (each.some((r) => r === "missing")) return "missing";
  const all: any[] = [];
  for (const r of each) {
    if (!r || !Array.isArray(r.check_runs)) return null;
    const total = Number(r.total_count);
    if (!Number.isInteger(total) || total !== r.check_runs.length) return null;
    all.push(...r.check_runs);
  }
  return all;
}

// Each required check's newest run from GitHub Actions: passed (success only), still
// running, failed (any other conclusion, skipped and neutral too), or not run yet. The one
// judgment for the landing (failedChecks) and the Ship card.
export interface CheckState { name: string; state: "passed" | "running" | "failed" | "missing"; conclusion?: string }
export function judgeChecks(runs: any[]): CheckState[] {
  return CHECKS.map((name): CheckState => {
    const mine = runs.filter((r) => r?.name === name && r?.app?.id === ACTIONS_APP).sort((a, b) => Number(b.id) - Number(a.id));
    const r = mine[0];
    if (!r) return { name, state: "missing" };
    if (r.status !== "completed") return { name, state: "running" };
    if (r.conclusion !== "success") return { name, state: "failed", conclusion: String(r.conclusion ?? "no result") };
    return { name, state: "passed" };
  });
}

// One answer from GitHub's API, tried twice: its body, "missing" (GitHub says there's no
// such thing), or null (no answer). A 403 or 429 (a rate limit, or a refusal) isn't asked
// again: the link shares 60 unauthenticated reads an hour, and asking at once won't mend it.
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
function failedChecks(runs: any[]): Landed | null {
  for (const c of judgeChecks(runs)) {
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
    const runs = await checkRuns(d, l.repo, l.head);
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
