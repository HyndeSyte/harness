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

// What a pull request changes, for the line the link adds to its Ship card: GitHub's
// count of its commits and files, and the parts it touches that matter most.
export interface Facts { head: string; commits: number; files: number; areas: string[] }
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

export async function facts(d: Pick<MergeDeps, "api">, repo: string, pr: number): Promise<Facts | null> {
  const p = await read(d, `/repos/${repo}/pulls/${pr}`);
  if (!p || p === "missing") return null;
  const names: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const f = await read(d, `/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    if (!Array.isArray(f)) return null;
    names.push(...f.map((x: any) => String(x?.filename ?? "")));
    if (f.length < 100) break;
  }
  return {
    head: String(p.head?.sha ?? "").toLowerCase(),
    commits: Number(p.commits) || 0,
    files: Number(p.changed_files) || names.length,
    areas: AREAS.filter(([re]) => names.some((n) => re.test(n))).map(([, w]) => w),
  };
}

// One answer from GitHub's API, tried twice: its body, "missing" (GitHub says there's no
// such thing), or null (no answer).
async function read(d: Pick<MergeDeps, "api">, path: string): Promise<any | "missing" | null> {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await d.api(path);
      if (r.status === 200 && r.body) return r.body;
      if (r.status === 404) return "missing";
    } catch { /* try once more */ }
  }
  return null;
}

// Fetched over SSH with the deploy key: the pull request's head and main, as GitHub has
// them now, into refs the link keeps for itself.
// A key GitHub refuses, or a host key that isn't GitHub's, won't mend by waiting: those
// end the landing; anything else (the network, a timeout) is tried again.
async function fetchBoth(d: MergeDeps, l: Landing): Promise<Landed | null> {
  const r = await d.git(["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", where(d, l.repo),
    `+refs/pull/${l.pr}/head:refs/ship/pull`, "+refs/heads/main:refs/ship/main"], { ssh: true, timeoutMs: 90_000 });
  if (r.code === 0) return null;
  if (KEY_REFUSED.test(r.err)) return no(DEPLOY_KEY_REFUSED);
  if (HOST_KEY.test(r.err)) return no("GitHub's SSH host key isn't one the link knows, so it won't send anything there");
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

function failedChecks(runs: any[]): Landed | null {
  for (const name of CHECKS) {
    const mine = runs.filter((r) => r?.name === name && r?.app?.id === ACTIONS_APP).sort((a, b) => Number(b.id) - Number(a.id));
    const r = mine[0];
    if (!r) return no(`CI hasn't run ${name} on it`);
    if (r.status !== "completed") return no(`CI is still running ${name} on it`, true);
    if (r.conclusion !== "success") return no(`CI's ${name} check didn't pass on it (${String(r.conclusion ?? "no result")})`);
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
    const checks = await read(d, `/repos/${l.repo}/commits/${l.head}/check-runs?per_page=100`);
    if (checks === "missing") return no("GitHub doesn't have that commit");
    if (!checks || !Array.isArray(checks.check_runs)) return no("GitHub didn't answer about its checks", true);
    const bad = failedChecks(checks.check_runs);
    if (bad) return bad;
  }
  const fetched = await fetchBoth(d, l);
  if (fetched) return fetched;
  // Already in main (an earlier tap landed it, or GitHub says it's merged): nothing to push.
  if (await ancestor(d, l.head, "refs/ship/main")) return { ok: true, already: true };
  if (merged) return no("GitHub says it's merged, but main doesn't have that commit");
  if ((await sha(d, "refs/ship/pull")) !== l.head) return no("its branch moved on since the card: it has newer commits");
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
