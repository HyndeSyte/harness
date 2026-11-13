// How the link reaches GitHub for landing his Ship taps (merge.ts), as plain functions
// so the tests run them for real: ssh with the deploy key and GitHub's pinned host keys,
// git in the link's own copy, and the daily question whether GitHub still knows the key.
// Nothing else's config, agent or credentials take part.
import { existsSync, mkdirSync } from "node:fs";
import { keyAnswer } from "./merge";
import { runBounded, type Ran } from "./spawn";

export function sshArgs(key: string, knownHosts: string): string[] {
  return ["ssh", "-F", "/dev/null", "-i", key, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
}

export interface GitOpts {
  repoDir: string;                   // the link's own bare copy, made on first use
  ssh: string;                       // GIT_SSH_COMMAND
  home: string;
  path?: string;                     // PATH
  timeoutBin?: string | null;        // timeout(1), which kills git and its ssh together; null: none
}

// git in the link's copy. Under timeout(1) the whole process group goes at the limit,
// ssh included; the runner's own limit, a little later, is the backstop.
export function makeGit(o: GitOpts) {
  const env: Record<string, string> = { PATH: o.path ?? process.env.PATH ?? "/usr/bin:/bin", HOME: o.home,
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  let made = false;
  const bounded = (args: string[], ms: number, e: Record<string, string>) => runBounded(
    o.timeoutBin ? [o.timeoutBin, "-k", "5", String(Math.ceil(ms / 1000)), ...args] : args, e, ms + 10_000);
  return async (args: string[], g: { ssh?: boolean; timeoutMs?: number } = {}): Promise<Ran> => {
    if (!made) {
      // Repeating init on a copy that's there is harmless; one that fails is tried again next time.
      try { mkdirSync(o.repoDir, { recursive: true, mode: 0o700 }); }
      catch (e) { return { code: 1, out: "", err: `the link's copy of the repository couldn't be set up: ${String(e).slice(0, 120)}` }; }
      const init = await bounded(["git", "-C", o.repoDir, "init", "--bare", "--quiet"], 30_000, env);
      if (init.code !== 0) return { code: init.code, out: "", err: `the link's copy of the repository couldn't be set up: ${init.err.trim().slice(0, 120)}` };
      made = true;
    }
    return bounded(["git", "-C", o.repoDir, ...args], g.timeoutMs ?? 60_000, g.ssh ? { ...env, GIT_SSH_COMMAND: o.ssh } : env);
  };
}

// Does GitHub still know the deploy key: "known", "refused", "host key" (GitHub's host key
// isn't one the link knows), or null (no answer: the network, port 22).
export async function keyStatus(ssh: string[], repo: string, home: string): Promise<"known" | "refused" | "host key" | null> {
  const r = await runBounded([...ssh, "-T", "git@github.com"], { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, 30_000)
    .catch(() => null);
  if (!r) return null;
  const said = `${r.out}\n${r.err}`;
  if (/host key verification failed|remote host identification has changed/i.test(said)) return "host key";
  const known = keyAnswer(said, repo);
  return known === true ? "known" : known === false ? "refused" : null;
}

export const timeoutBin = (): string | null => ["/usr/bin/timeout", "/bin/timeout"].find((p) => existsSync(p)) ?? null;
