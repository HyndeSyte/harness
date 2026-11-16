// The Windows Ship gate, read without acting (0.12.0, seventeenth round): keeper.sh ship-gate.
// For one head of this repository it makes the very reading the landing and the Ship card make
// (merge.ts gateReport) and prints what the gate would decide and why, with the workflow file it
// read and every pcjobs-windows attempt it saw. It reads GitHub's public API only, without a key
// (the link's own 60 reads an hour from this address are shared with it), and changes nothing:
// no card, no landing, nothing written to GitHub.
//   bun shipgate.ts <full head sha>            one report, now (the dry run)
//   bun shipgate.ts <full head sha> --watch    the probe's ship_gate step: a report now, then one
//                                              every --every minutes (default 10) for up to --hours
//                                              (default 2), judged (merge.ts judgeShipGate), and
//                                              kept in /data/work/ship-gate-<head>.json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gateReport, watchShipGate, type MergeDeps } from "./merge";

export const SHIP_REPO = "HyndeSyte/harness";
async function api(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`https://api.github.com${path}`, { redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { accept: "application/vnd.github+json", "user-agent": "cain-link", "x-github-api-version": "2022-11-28" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const head = (args[0] ?? "").toLowerCase();
  const repo = flag("--repo") ?? SHIP_REPO;
  const d: Pick<MergeDeps, "api"> = { api };
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    console.error("usage: shipgate.ts <full head sha> [--watch [--every <minutes>] [--hours <hours>] [--out <file>]] [--repo owner/name]");
    process.exit(2);
  }
  if (!args.includes("--watch")) {
    console.log(JSON.stringify(await gateReport(d, repo, head), null, 2));
  } else {
    const every = Math.min(Math.max(Number(flag("--every") ?? 10), 2), 60) * 60_000;
    const hours = Math.min(Math.max(Number(flag("--hours") ?? 2), 0.1), 6) * 3_600_000;
    const out = flag("--out") ?? `/data/work/ship-gate-${head}.json`;
    const line = await watchShipGate(d, repo, head, { everyMs: every, untilMs: hours,
      each: (r) => console.log(JSON.stringify({ at: r.at, decision: r.decision, why: r.why, windows: r.windows, attempts: r.attempts.length })) });
    try { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(line, null, 2) + "\n"); } catch { /* printed below anyway */ }
    console.log(JSON.stringify({ step: line.step, head, passed: line.passed, refused_while_pending: line.refused_while_pending,
      accepted_early: line.accepted_early, accepted_after_pass: line.accepted_after_pass, attempts_seen: line.attempts_seen, kept: out }, null, 2));
  }
}
