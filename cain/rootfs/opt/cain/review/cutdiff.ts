// The cut diff (Cain 0.20.0, round 1 fixes). A cut check reads the diff the runner derives itself, through git,
// from the head the change's last review round reviewed (the runner's record) to the cut head: never a diff or a
// description Cain wrote. The runner keeps its own bare copy of the repository (cutRepo) and fetches main and the
// pull request's head into it; nothing is ever pushed from it.
//
//   - A cut head that doesn't descend from the last-reviewed head is refused: it isn't a cut of what was reviewed.
//   - A cut removes; it adds nothing new. Every line the diff adds must be a revert (a line the file had where the
//     change began, at its merge base with main) or fall in the allowance below. A diff that adds more fails the
//     check, with no seat asked.
//   - git failing (no network, a timeout, a ref GitHub doesn't have yet) is an infrastructure error: the check
//     waits and is tried again with the same inputs, and nothing is consumed.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

// The allowance, stated (round 2 fixes: narrow). Up to CUT_ADD_ALLOWANCE added lines that are:
//   - imports: a pure import statement, on one line (TypeScript `import { a } from "x";`, `import a from "x";`,
//     `import type { a } from "x";`, `import * as a from "x";`; Python `from x import a, b` or `import x`), each name it
//     brings in already used elsewhere in the file at the cut head. A side-effecting import (`import "x";`), a
//     re-export, a require or anything else on the line is new code;
//   - test lines: in a file under the repository's test directories (TEST_DIRS), which no App's image copies (the
//     Cain and Keeper images copy only rootfs, the Harness image only app and rootfs);
//   - changelog lines: in an App's own CHANGELOG.md (CHANGELOGS), the one file each App has.
// Every other added line must be a revert: byte for byte a line the file had at the pull request's merge base with
// main (an empty line aside). Anything past the allowance, or any other added line, is new code: the cut fails with
// no seat asked.
export const CUT_ADD_ALLOWANCE = 40;
export const CUT_DIFF_MAX = 48_000;           // characters of diff sent to the seat; a larger cut isn't a cut
export const CUT_CONTEXT_MAX = 60_000;        // characters of pre-cut context around the deleted hunks
export const CUT_CONTEXT_LINES = 20;
export const TEST_DIRS = ["tests/", "cain/tests/", "keeper/tests/"] as const;
export const CHANGELOGS = ["cain/CHANGELOG.md", "harness/CHANGELOG.md", "keeper/CHANGELOG.md"] as const;
const TESTISH = (path: string) => TEST_DIRS.some((d) => path.startsWith(d)) && !path.includes("/../") && !path.startsWith("../");
const CHANGELOG = (path: string) => (CHANGELOGS as readonly string[]).includes(path);
const TS_IMPORT = /^import\s+(?:type\s+)?(?:(\{[^}]*\})|\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)(?:\s*,\s*(\{[^}]*\}))?)\s+from\s+(["'])[^"'\n]+\5\s*;?\s*$/;
const PY_FROM = /^from\s+[\w.]+\s+import\s+(\(?\s*[\w\s,]+?\s*\)?)\s*$/;
const PY_IMPORT = /^import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*$/;
// The names a pure import line brings in, or null when the line isn't a pure import statement.
export function importNames(line: string): string[] | null {
  const t = line.trim();
  const braces = (b: string) => b.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean)
    .map((x) => x.replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim());
  let m = TS_IMPORT.exec(t);
  if (m) return [...(m[1] ? braces(m[1]) : []), ...(m[2] ? [m[2]] : []), ...(m[3] ? [m[3]] : []), ...(m[4] ? braces(m[4]) : [])];
  m = PY_FROM.exec(t);
  if (m) return m[1].replace(/[()]/g, "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.split(/\s+as\s+/).pop()!.trim());
  m = PY_IMPORT.exec(t);
  if (m) return m[1].split(",").map((x) => x.trim()).map((x) => (x.includes(" as ") ? x.split(/\s+as\s+/).pop()! : x.split(".")[0]).trim());
  return null;
}
const isImportLine = (l: string) => importNames(l) !== null;
const word = (n: string) => new RegExp(`(^|[^\\w$])${n.replace(/[$]/g, "\\$")}([^\\w$]|$)`);

export type DiffFile = { path: string; added: string[]; removed: string[] };
export type CutJudgement = { ok: true; reverts: number; allowed: number } | { ok: false; why: string };

// Pure: whether a cut's added lines are all reverts or within the allowance. origin(path): the file's lines at the
// merge base (empty when the file didn't exist then); after(path): the file's lines at the cut head (for imports).
export function judgeCut(files: DiffFile[], origin: (path: string) => string[], after: (path: string) => string[] = () => []): CutJudgement {
  let reverts = 0, allowed = 0;
  const newCode: string[] = [];
  for (const f of files) {
    const had = new Map<string, number>();
    for (const l of origin(f.path)) if (l !== "") had.set(l, (had.get(l) ?? 0) + 1);
    let rest: string[] | null = null;
    for (const raw of f.added) {
      if (raw === "") continue;
      const n = had.get(raw) ?? 0;
      if (n > 0) { had.set(raw, n - 1); reverts++; continue; }
      if (TESTISH(f.path) || CHANGELOG(f.path)) { allowed++; continue; }
      const names = importNames(raw);
      if (names && names.length) {
        rest ??= after(f.path).filter((l) => !isImportLine(l));
        const unused = names.filter((x) => !rest!.some((l) => word(x).test(l)));
        if (!unused.length) { allowed++; continue; }
        newCode.push(`${f.path}: an import of ${unused.slice(0, 3).join(", ")}, not used in the code left`);
        continue;
      }
      newCode.push(`${f.path}: ${raw.trim().slice(0, 80)}`);
    }
  }
  if (newCode.length) return { ok: false, why: `the cut adds ${newCode.length} line(s) of new code, not only removals and reverts (first: ${newCode[0]})` };
  if (allowed > CUT_ADD_ALLOWANCE) return { ok: false, why: `the cut adds ${allowed} import, test or changelog lines, over the allowance of ${CUT_ADD_ALLOWANCE}` };
  return { ok: true, reverts, allowed };
}

// A unified diff (-U0 or more) read into its files' added and removed lines.
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = null; continue; }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur = { path: p === "/dev/null" ? "" : p.replace(/^b\//, ""), added: [], removed: [] };
      files.push(cur);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (!cur) continue;
    if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

// What the runner derives for a cut check (round 2 fixes): the diff and its judgement, the pre-cut file context around
// every deleted hunk (context), the files at the cut head with their line counts (where the judge's evidence must
// point), and each commit of the cut range (base..head) with its author, committer and message, from which the runner
// checks that the judge's model wrote none of it.
export type CutCommit = { sha: string; author: string; committer: string; message: string };
export type CutDerived =
  | { ok: true; diff: string; judged: CutJudgement; context?: string; headFiles?: Record<string, number>; commits?: CutCommit[] }
  | { ok: false; kind: "infra" | "refused"; why: string };
export type CutDiffFn = (a: { pr: string; base: string; head: string }) => Promise<CutDerived>;

// The environment git runs in: no prompt, no system config, and the runner's GitHub token (when one is configured) as
// an HTTP header through git's own config variables, so it is never on a command line, in a URL or in a log.
export function gitEnv(token?: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return env;
}
// Whether the runner can fetch from the repository at all (checked at the runner's start, shown in review.sh health):
// git ls-remote of main, with the token when there is one. Never prints the token.
export function verifyFetch(o: { remote: string; token?: string; timeoutMs?: number }): { ok: boolean; detail: string } {
  const r = spawnSync("git", ["ls-remote", "--heads", o.remote, "main"], { encoding: "utf8", timeout: o.timeoutMs ?? 60_000, env: gitEnv(o.token) });
  if (r.status === 0 && /^[0-9a-f]{40}\trefs\/heads\/main$/m.test(r.stdout)) return { ok: true, detail: o.token ? "fetches with the runner's GitHub token" : "fetches without a token" };
  const said = (r.stderr || String(r.error ?? "") || `git exit ${r.status}`).replace(/[\r\n]+/g, " ").trim().slice(0, 160);
  return { ok: false, detail: `git can't fetch ${o.remote}${o.token ? " with the runner's GitHub token" : " without a token"} (${said})` };
}

// Through git: o.repo is the runner's bare copy (made on first use), o.remote the repository to fetch from.
export function gitCutDiff(o: { repo: string; remote: string; timeoutMs?: number; token?: string }): CutDiffFn {
  const ms = o.timeoutMs ?? 120_000;
  const env = gitEnv(o.token);
  const git = (args: string[]) => spawnSync("git", ["-C", o.repo, ...args], { encoding: "utf8", timeout: ms, maxBuffer: 64 * 1024 * 1024, env });
  return async ({ pr, base, head }) => {
    const n = /\/pull\/(\d+)$/.exec(pr)?.[1];
    if (!n) return { ok: false, kind: "refused", why: "the cut check names no pull request" };
    if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) return { ok: false, kind: "refused", why: "the heads aren't full shas" };
    try {
      if (!existsSync(o.repo)) {
        mkdirSync(dirname(o.repo), { recursive: true });
        const init = spawnSync("git", ["init", "--bare", "-q", o.repo], { encoding: "utf8", timeout: ms });
        if (init.status !== 0) return { ok: false, kind: "infra", why: `git init failed: ${(init.stderr || "").slice(0, 120)}` };
      }
      const f = git(["fetch", "--no-tags", "-q", o.remote, "+refs/heads/main:refs/cut/main", `+refs/pull/${n}/head:refs/cut/pr-${n}`]);
      if (f.status !== 0) return { ok: false, kind: "infra", why: `git fetch failed: ${(f.stderr || String(f.error ?? "")).trim().slice(0, 160)}` };
      for (const [what, sha] of [["the cut head", head], ["the last-reviewed head", base]] as const)
        if (git(["cat-file", "-e", `${sha}^{commit}`]).status !== 0)
          return { ok: false, kind: "refused", why: `${what} isn't in the repository's pull request history` };
      const anc = git(["merge-base", "--is-ancestor", base, head]);
      if (anc.status === 1) return { ok: false, kind: "refused", why: "the cut head doesn't descend from the head the last review round reviewed" };
      if (anc.status !== 0) return { ok: false, kind: "infra", why: `git merge-base failed: ${(anc.stderr || "").slice(0, 120)}` };
      const run = (args: string[], what: string) => { const x = git(args); if (x.status !== 0) throw new InfraError(`${what} failed: ${(x.stderr || "").slice(0, 120)}`); return x.stdout; };
      const diff = run(["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", base, head], "git diff");
      const zero = run(["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0", base, head], "git diff");
      const context = run(["diff", "--no-color", "--no-ext-diff", "--no-renames", `-U${CUT_CONTEXT_LINES}`, base, head], "git diff");
      const mb = git(["merge-base", head, "refs/cut/main"]);
      if (mb.status !== 0) return { ok: false, kind: "infra", why: "git merge-base with main failed, so a revert can't be checked against where the change began" };
      const start = mb.stdout.trim();
      const lines = (rev: string) => (path: string) => {
        if (!path) return [];
        const s = git(["show", `${rev}:${path}`]);
        return s.status === 0 ? s.stdout.split("\n") : [];
      };
      const judged = judgeCut(parseDiff(zero), lines(start), lines(head));
      // The files at the cut head and their line counts (git grep counts every line of each text file).
      const headFiles: Record<string, number> = {};
      for (const p of run(["ls-tree", "-r", "--name-only", head], "git ls-tree").split("\n").filter(Boolean)) headFiles[p] = 0;
      const counted = git(["grep", "-I", "-c", "-e", "", head, "--"]);
      for (const l of (counted.stdout ?? "").split("\n")) { const m = /^[0-9a-f]{40}:(.+):(\d+)$/.exec(l); if (m && m[1] in headFiles) headFiles[m[1]] = Number(m[2]); }
      const log = run(["log", "--no-color", "--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e", `${base}..${head}`], "git log");
      const commits: CutCommit[] = log.split("\x1e").map((x) => x.replace(/^\n+/, "")).filter(Boolean).map((x) => {
        const [sha, author, committer, ...msg] = x.split("\x1f");
        return { sha: sha.trim(), author: author ?? "", committer: committer ?? "", message: msg.join("\x1f") };
      });
      const ctx = context.length > CUT_CONTEXT_MAX ? context.slice(0, CUT_CONTEXT_MAX) : context;
      if (diff.length > CUT_DIFF_MAX)
        return { ok: true, diff: diff.slice(0, CUT_DIFF_MAX), context: ctx, headFiles, commits, judged: { ok: false, why: `the cut diff is over ${CUT_DIFF_MAX} characters, too large to be only a cut` } };
      return { ok: true, diff, judged, context: ctx, headFiles, commits };
    } catch (e) {
      if (e instanceof InfraError) return { ok: false, kind: "infra", why: e.message };
      return { ok: false, kind: "infra", why: `git couldn't be run: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
  };
}
class InfraError extends Error {}
