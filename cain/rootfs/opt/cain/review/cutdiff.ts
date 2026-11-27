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

// The allowance, stated: up to CUT_ADD_ALLOWANCE added lines that are imports (a cut can leave an import to tidy),
// lines in test files (a test of the cut's own, or one adjusted for what it removed) or changelog lines (the
// CHANGELOG saying what was cut). Blank lines never count. Anything past it, or any other added line, is new code.
export const CUT_ADD_ALLOWANCE = 40;
export const CUT_DIFF_MAX = 48_000;           // characters of diff sent to the seat; a larger cut isn't a cut
const IMPORT = /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|const\s+\{[^}]*\}\s*=\s*require\(|#include\b|use\s+[\w:]+;)/;
const TESTISH = (path: string) => /(^|\/)tests?\//.test(path) || /\.test\.[a-z]+$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
const CHANGELOG = (path: string) => /(^|\/)CHANGELOG\.md$/.test(path);

export type DiffFile = { path: string; added: string[]; removed: string[] };
export type CutJudgement = { ok: true; reverts: number; allowed: number } | { ok: false; why: string };

// Pure: whether a cut's added lines are all reverts or within the allowance. origin(path): the file's lines where
// the change began (empty when the file didn't exist then).
export function judgeCut(files: DiffFile[], origin: (path: string) => string[]): CutJudgement {
  let reverts = 0, allowed = 0;
  const newCode: string[] = [];
  for (const f of files) {
    const had = new Map<string, number>();
    for (const l of origin(f.path)) { const k = l.trim(); if (k) had.set(k, (had.get(k) ?? 0) + 1); }
    for (const raw of f.added) {
      const k = raw.trim();
      if (!k) continue;
      const n = had.get(k) ?? 0;
      if (n > 0) { had.set(k, n - 1); reverts++; continue; }
      if (IMPORT.test(raw) || TESTISH(f.path) || CHANGELOG(f.path)) { allowed++; continue; }
      newCode.push(`${f.path}: ${k.slice(0, 80)}`);
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

export type CutDerived =
  | { ok: true; diff: string; judged: CutJudgement }
  | { ok: false; kind: "infra" | "refused"; why: string };
export type CutDiffFn = (a: { pr: string; base: string; head: string }) => Promise<CutDerived>;

// Through git: o.repo is the runner's bare copy (made on first use), o.remote the repository to fetch from.
export function gitCutDiff(o: { repo: string; remote: string; timeoutMs?: number }): CutDiffFn {
  const ms = o.timeoutMs ?? 120_000;
  const git = (args: string[]) => spawnSync("git", ["-C", o.repo, ...args], { encoding: "utf8", timeout: ms, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } });
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
      const d = git(["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", base, head]);
      if (d.status !== 0) return { ok: false, kind: "infra", why: `git diff failed: ${(d.stderr || "").slice(0, 120)}` };
      const z = git(["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0", base, head]);
      if (z.status !== 0) return { ok: false, kind: "infra", why: `git diff failed: ${(z.stderr || "").slice(0, 120)}` };
      const mb = git(["merge-base", head, "refs/cut/main"]);
      const start = mb.status === 0 ? mb.stdout.trim() : base;
      const origin = (path: string) => {
        if (!path) return [];
        const s = git(["show", `${start}:${path}`]);
        return s.status === 0 ? s.stdout.split("\n") : [];
      };
      const judged = judgeCut(parseDiff(z.stdout), origin);
      if (d.stdout.length > CUT_DIFF_MAX)
        return { ok: true, diff: d.stdout.slice(0, CUT_DIFF_MAX), judged: { ok: false, why: `the cut diff is over ${CUT_DIFF_MAX} characters, too large to be only a cut` } };
      return { ok: true, diff: d.stdout, judged };
    } catch (e) {
      return { ok: false, kind: "infra", why: `git couldn't be run: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
  };
}
