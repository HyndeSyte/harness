// Round 13: whether his Ship taps land in main (install taps), as framed, fsynced records in an
// append-only log the record keeper owns (/data/record-install.log, ../applog.ts). The link appends to it
// (it is the one that sees his line and his taps); the keeper counts it in its high-water marks, and
// after a restore that lost records it appends an off record itself. Read by folding the records in order:
//   {t: "flag", how: "on" | "once" | "off", by: "owner" | "cain" | "keeper", at, said?, head?, why?}
//   {t: "once-used", kid, at}     the one Ship tap a once allowed, appended before the landing ledger's
//                                 first write for it; the flag is off after it
// A missing, unreadable or corrupt log (a bad or torn record anywhere) reads as off. Only the owner's
// own line turns it on (by: "owner", with his consumed message id and the tests' head).
import { existsSync, readFileSync } from "node:fs";
import { appendLog, readLog } from "./applog";

export type InstallHow = "on" | "once" | "off";
export interface InstallState { how: InstallHow; why: string; records: number; onceUsed: string[]; head?: string }

export function installState(file: string | undefined): InstallState {
  if (!file) return { how: "off", why: "no install log here", records: 0, onceUsed: [] };
  let r;
  try { r = readLog<any>(file, { repair: false }); }
  catch (e) { return { how: "off", why: `the install log can't be read (${(e as Error).message.slice(0, 80)})`, records: 0, onceUsed: [] }; }
  if (r.missing) return { how: "off", why: "no install log yet", records: 0, onceUsed: [] };
  if (r.bad || r.torn) return { how: "off", why: "the install log has a damaged record", records: r.records.length, onceUsed: [] };
  let how: InstallHow = "off", why = "never switched on", head: string | undefined;
  const onceUsed: string[] = [];
  for (const x of r.records) {
    if (x?.t === "flag" && (x.how === "on" || x.how === "once" || x.how === "off")) {
      // On counts only from the owner's own line with the tests' head.
      if (x.how === "on" && !(x.by === "owner" && typeof x.said === "string" && /^[0-9a-f]{40}$/.test(String(x.head ?? "")))) continue;
      how = x.how; why = `${x.how} since ${typeof x.at === "string" ? x.at : "?"}${x.why ? ` (${x.why})` : ""}`;
      head = x.how === "on" ? x.head : undefined;
    } else if (x?.t === "once-used" && typeof x.kid === "string") {
      onceUsed.push(x.kid);
      if (how === "once") { how = "off"; why = `the one Ship tap install-taps once allowed was used (${x.kid})`; }
    }
  }
  return { how, why, records: r.records.length, onceUsed, ...(head ? { head } : {}) };
}

export function appendInstall(file: string, rec: Record<string, unknown>): void { appendLog(file, rec); }

// The post-install tests' result file (/data/work/install-tests.json), which Cain writes from the smoke
// test and the resilience run: {"head": "<full sha the tests ran on>", "smoke": {"pass": true, "at": ISO},
// "resilience": {"pass": true, "at": ISO}}. Checked by machine: both passed, both dated within the last
// 7 days and not in the future, the head a full sha. Returns the head, or why it doesn't pass.
export const RESULTS_FRESH_MS = 7 * 86_400_000;
export function installResults(file: string | undefined, now: number): { head: string } | { why: string } {
  if (!file || !existsSync(file)) return { why: "the post-install tests' result file isn't there yet (/data/work/install-tests.json)" };
  let j: any;
  try { j = JSON.parse(readFileSync(file, "utf8")); } catch { return { why: "the post-install tests' result file isn't valid JSON" }; }
  const head = String(j?.head ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return { why: "the post-install tests' result file doesn't name a full head sha" };
  for (const part of ["smoke", "resilience"] as const) {
    const p = j?.[part];
    if (p?.pass !== true) return { why: `the post-install tests' result file doesn't say the ${part === "smoke" ? "smoke test" : "resilience run"} passed` };
    const at = Date.parse(String(p.at ?? ""));
    if (!Number.isFinite(at) || at > now + 5 * 60_000 || now - at > RESULTS_FRESH_MS)
      return { why: `the ${part === "smoke" ? "smoke test" : "resilience run"}'s result is undated, in the future, or over 7 days old` };
  }
  return { head };
}
