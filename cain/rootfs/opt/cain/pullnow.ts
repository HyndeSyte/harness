// A pull request now, from GitHub, the one way the link and the review runner both read it (Cain 0.18.1:
// the runner reads a pull request's head here before a round claims a grant of the owner's). GitHub's API
// says whether it's open and its head; when that can't be read (it allows 60 asks an hour without a key),
// the head alone comes from GitHub's own refs. No token: both read only what GitHub shows anyone, and
// null (or a null head) is "can't tell", never a head.
export const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
export type PullNow = { head: string | null; open: boolean | null; merged?: boolean };

// Fifth review: each path on its own, so `review.sh host-read` can exercise both and print what each gave.
export async function pullViaApi(pr: string): Promise<PullNow | null> {
  const m = PULL_URL.exec(pr);
  if (!m) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { redirect: "error",
      headers: { accept: "application/vnd.github+json", "user-agent": "cain-link" }, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const j: any = await r.json();
      const head = String(j?.head?.sha ?? "");
      return { head: /^[0-9a-f]{40}$/.test(head) ? head : null, open: j?.state === "open" ? true : j?.state === "closed" ? false : null,
        merged: j?.merged === true };
    }
  } catch { /* can't tell */ }
  return null;
}
export async function pullViaRefs(pr: string): Promise<PullNow | null> {
  const m = PULL_URL.exec(pr);
  if (!m) return null;
  try {
    const p = Bun.spawn(["git", "-c", "credential.helper=", "ls-remote", `https://github.com/${m[1]}/${m[2]}.git`, `refs/pull/${m[3]}/head`],
      { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", HOME: "/tmp" } });
    const timer = setTimeout(() => p.kill(), 20000);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    const sha = out.trim().split(/\s+/)[0] ?? "";
    return { head: /^[0-9a-f]{40}$/.test(sha) ? sha : null, open: null };
  } catch { return null; }
}
export async function pullNow(pr: string): Promise<PullNow | null> {
  return (await pullViaApi(pr)) ?? (await pullViaRefs(pr));
}
// Fifth review: GitHub's compare of two commits in the pull request's repository, the proof a grant's bound head is
// superseded: "ahead" when head descends from base (base is its ancestor), "behind", "diverged" or "identical" as
// GitHub says; null when it can't be read (no token: 60 asks an hour) or either sha isn't a full one.
export type Compare = "ahead" | "behind" | "diverged" | "identical";
export async function compareHeads(pr: string, base: string, head: string): Promise<Compare | null> {
  const m = PULL_URL.exec(pr);
  if (!m || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/compare/${base}...${head}`, { redirect: "error",
      headers: { accept: "application/vnd.github+json", "user-agent": "cain-link" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const st = String(((await r.json()) as any)?.status ?? "");
    return st === "ahead" || st === "behind" || st === "diverged" || st === "identical" ? st : null;
  } catch { return null; }
}
