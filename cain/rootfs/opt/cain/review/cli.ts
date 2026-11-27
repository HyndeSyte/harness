// review.sh: Cain's way to ask for an outside review and read what came back.
// It runs as Cain's user (C1): it leaves a brief in the inbox and reads the queue, which only
// the runner writes, so a review's state and its Reviewed line can only be the runner's.
//   submit <brief.json>    leave a brief for the runner; prints its id (or "blocked: privacy ...",
//                          exit 3, and nothing is left). The runner takes it within a tick.
//   status <id>            the review's state and each seat's state, one line each
//   result <id>            result.json (what goes to the record), once finished
//   useful <id> <seat> <n> how many of that seat's findings Cain adopted (cost per useful finding)
//   spend                  this month per seat: dollars, the runner's own cap, runs, findings, useful,
//                          $ per useful; then the round count per open change against the round cap
//   guard                  the usage guard's reading now, in two lines (the plan, the seats and the floor)
//   health                 the last nightly seat check
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStop, stoppedWhy } from "../stop.ts";
import { FINAL, LABEL, SEATS, newReview, parseBrief, privacyCheck, resultJson, safeId, shownId, type Brief, type SeatName } from "./core.ts";
import { configFromEnv } from "./config.ts";
import { atCap, existsReview, loadReview, type Ledger, type Health } from "./runner.ts";
import { DEFAULT_ROUND_CAP, admit, admitCut, countedRounds, cutOf, groupOf, lastRound, readRounds } from "./rounds.ts";
import { guard, guardLines, labelOf, postHold, readSettings, readings } from "../guard.ts";

const cfg = configFromEnv();
const usefulFile = process.env.REVIEW_USEFUL ?? join(dirname(cfg.spendFile), "review-useful.jsonl");
const out = (s: string) => console.log(s);
const fail = (s: string, code = 2): never => { console.error(s); process.exit(code); };
const [cmd, a1, a2, a3] = process.argv.slice(2);
const terms = () => { try { return readFileSync(cfg.termsFile, "utf8"); } catch { return null; } };
// Cain 0.16.0: what the runner really uses, as it wrote it (root's file). Never this process's own
// environment, which is Cain's: his caps and round cap would be the defaults, not the App's options.
const settings = () => readSettings(cfg.settingsFile!);
const roundCap = () => settings()?.round_cap ?? DEFAULT_ROUND_CAP;

function money(n: number) { return `$${n.toFixed(2)}`; }

// A brief waiting in the inbox for the runner.
const inboxFile = (id: string) => (cfg.inboxDir && safeId(id) ? join(cfg.inboxDir, `${id}.json`) : "");
const waiting = (id: string) => { const f = inboxFile(id); return !!f && existsSync(f); };
// The brief's own fields, nothing else, written whole: a temp name the runner skips, then renamed.
function leave(b: Brief): void {
  const f = inboxFile(b.id);
  if (!f) fail("no inbox for review briefs");
  mkdirSync(cfg.inboxDir!, { recursive: true });
  const tmp = join(cfg.inboxDir!, `.${b.id}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(b), { mode: 0o640 });
  renameSync(tmp, f);
}

switch (cmd) {
  case "submit": {
    if (!a1) fail("usage: review.sh submit <brief.json>");
    let raw = "";
    try { raw = readFileSync(a1, "utf8"); } catch { fail(`can't read ${a1}`); }
    const p = parseBrief(raw);
    if (!p.brief) fail(`not a brief: ${p.error}`);
    const b = p.brief!;
    if (existsReview(cfg.queueDir, b.id) || waiting(b.id)) fail(`a review with id ${b.id} already exists; use a new id`);
    // The gate runs here first, so Cain hears at once and nothing is left; the runner runs it
    // again before every call.
    const g = privacyCheck(b, terms());
    if (!g.ok) fail(`blocked: privacy (${g.why.join("; ")}). Nothing was sent.`, 3);
    // A seat whose monthly cap is reached runs nothing until the month turns (the runner
    // checks before every call). A review whose seats are all there is refused here, at once,
    // and nothing is left (Cain 0.13.0, read here from the spend file his group may read).
    let ledger: Ledger = {};
    try { ledger = JSON.parse(readFileSync(cfg.spendFile, "utf8")); } catch { /* none yet */ }
    const month = new Date().toLocaleDateString("en-CA", { timeZone: cfg.tz }).slice(0, 7);
    const seats = new Set(newReview(b, new Date()).seats.map((s) => s.seat));
    const capped = [...seats].filter((s) => atCap(ledger, month, settings()?.caps ?? cfg.caps, s));
    if (capped.length && capped.length === seats.size)
      fail(`blocked: the monthly cap is reached for ${capped.map((s) => LABEL[s]).join(", ")}. Nothing was queued; raise the cap in the App's options if wanted, or wait for the month to turn.`, 3);
    // The round cap and the usage guard, here first so he hears at once (the runner decides again when
    // it takes the brief, and its answer is the one that counts).
    const rounds = readRounds(cfg.roundsFile!);
    if (!rounds) fail("blocked: the review rounds file can't be read, so no round can be counted. Nothing was queued; log it as a Build item.", 3);
    // Cain 0.20.0: a cut check isn't a round (rounds.ts admitCut).
    const a = b.kind === "cut-check" ? admitCut(rounds!, b, roundCap()) : admit(rounds!, b, roundCap());
    if (!a.ok) fail(a.why, 3);
    const label = labelOf(b.label)!;
    // Round 2: the guard's log is root's (0640); a refusal here goes to the link, which decides again and
    // logs it. Not reached: still refused, and said so.
    const what = b.kind === "cut-check" ? `cut check ${b.id} (${(a as any).key})` : `review ${b.id} (${(a as any).key}, round ${(a as any).round})`;
    const gv = guard(label, what, { settingsFile: cfg.settingsFile!, spendFile: cfg.spendFile, tz: cfg.tz, now: new Date() });
    if (!gv.ok) {
      const h = await postHold(label, what);
      fail(`held by the usage guard: it's labelled ${label}, and ${gv.why}. Core, commitment and necessary-fix work still run; ${h.logged
        ? "this is on the guard's log (review.sh guard)" : `the hold could not be logged (${h.why})`}. Nothing was queued.`, 3);
    }
    leave(b);
    out(b.id);
    if (capped.length) console.error(`Queued, but ${capped.map((s) => LABEL[s]).join(", ")} won't run: its monthly cap is reached.`);
    // While stopped it's queued all the same, and nothing goes out until he turns it back on.
    const st = readStop();
    if (st.stopped) console.error(`Queued, not sent: ${stoppedWhy(st, "no review is sent")} It goes out by itself once he does.`);
    break;
  }
  case "status": {
    const r = a1 ? loadReview(cfg.queueDir, a1) : null;
    if (!r && a1 && waiting(a1)) { out(`${a1}: waiting for the runner to take it (within a minute)`); break; }
    if (!r) fail(`no review ${a1 ?? ""}`.trim(), 1);
    out(`${shownId(r!)}: ${r!.status}${r!.blocked_why ? ` (${r!.blocked_why.join("; ")})` : ""}${r!.record_dir ? `, record ${r!.record_dir}` : ""}, $${r!.cost_usd.toFixed(3)}`);
    for (const s of r!.seats) {
      const who = s.stands_in_for ? `claude for ${s.stands_in_for} (substituted)` : s.seat;
      const what = s.state === "done" ? `${s.verdict}, ${s.findings?.length ?? 0} finding(s), ${s.model}` : s.error ? `${s.error.kind}: ${s.error.detail}. Fix: ${s.error.fix}` : "";
      out(`  ${who}: ${s.state}${what ? `, ${what}` : ""}${s.next_at ? `, next try ${s.next_at}` : ""}`);
    }
    // Which round of the change's cap it is (0.20.0: the cap is the rule's, never raised), or its cut check.
    if (r!.kind === "cut-check") out(`  ${r!.change ?? "the change"}: its cut check (not a round)`);
    else if (r!.change && r!.round) out(`  ${r!.change}: round ${r!.round} of ${r!.cap ?? roundCap()}${r!.round_kind === "fixes" ? " (fix-only)" : " (full)"}`);
    break;
  }
  case "result": {
    const r = a1 ? loadReview(cfg.queueDir, a1) : null;
    if (!r) fail(`no review ${a1 ?? ""}`.trim(), 1);
    if (!FINAL.includes(r!.status)) fail(`${r!.id} is ${r!.status}; no result yet`, 1);
    out(resultJson(r!).trimEnd());
    break;
  }
  case "useful": {
    const r = a1 ? loadReview(cfg.queueDir, a1) : null;
    if (!r) fail(`no review ${a1 ?? ""}`.trim(), 1);
    const seat = r!.seats.find((s) => s.key === a2 || s.seat === a2);
    const n = Number(a3);
    if (!seat || seat.state !== "done") fail(`${a2} didn't answer review ${a1}`);
    if (!Number.isInteger(n) || n < 0 || n > (seat!.findings?.length ?? 0)) fail(`useful must be 0 to ${seat!.findings?.length ?? 0}`);
    appendFileSync(usefulFile, JSON.stringify({ id: r!.id, key: seat!.key, seat: seat!.seat, month: (r!.finished_at ?? r!.created_at).slice(0, 7), useful: n }) + "\n");
    out("noted");
    break;
  }
  case "spend": {
    let l: Ledger = {};
    try { l = JSON.parse(readFileSync(cfg.spendFile, "utf8")); } catch { /* none yet */ }
    const month = new Date().toLocaleDateString("en-CA", { timeZone: cfg.tz }).slice(0, 7);
    const useful: Record<string, number> = {};
    if (existsSync(usefulFile)) {
      const latest = new Map<string, any>();   // the last word per review and seat counts
      for (const line of readFileSync(usefulFile, "utf8").split("\n")) { try { const j = JSON.parse(line); latest.set(`${j.id}/${j.key}`, j); } catch { /* skip */ } }
      for (const j of latest.values()) if (j.month === month) useful[j.seat] = (useful[j.seat] ?? 0) + j.useful;
    }
    const st = settings();
    const caps = st?.caps ?? null;
    out(`${month}: seat, spent / cap, runs, findings, useful, per useful finding`);
    if (!caps) out("  (the runner hasn't written its caps yet, so caps show as ?: it writes them at each start)");
    const cap: Record<SeatName, string> = caps
      ? { openai: `${caps.openaiRuns} runs`, gemini: money(caps.gemini), perplexity: money(caps.perplexity), claude: money(caps.claude) }
      : { openai: "? runs", gemini: "?", perplexity: "?", claude: "?" };
    for (const s of SEATS) {
      const r = l[month]?.[s] ?? { usd: 0, runs: 0, findings: 0, searches: 0 };
      const u = useful[s] ?? 0;
      out(`  ${LABEL[s]}: ${money(r.usd)} / ${cap[s]}, ${r.runs} runs, ${r.findings} findings, ${u} useful, ${u ? money(r.usd / u) : "-"}`);
    }
    // The round count per open change: one with a round in the last 30 days.
    const rounds = readRounds(cfg.roundsFile!);
    const capN = roundCap();
    if (!rounds) { out(`Review rounds (cap ${capN}): the rounds file can't be read`); break; }
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const seen = new Set<string>();
    const open: string[] = [];
    for (const key of Object.keys(rounds.changes).sort()) {
      const group = groupOf(rounds, key);
      const head = group[group.length - 1];
      if (seen.has(head)) continue;
      group.forEach((k) => seen.add(k));
      const done = countedRounds(rounds, key);
      if (!done.length || done[done.length - 1].at < since) continue;
      const atCapNow = done.length >= capN;
      const last = lastRound(rounds, key);
      const cut = cutOf(rounds, key);
      const left = atCapNow && last.state === "answered" ? `, ${last.serious} serious left` : atCapNow && last.state === "lost" ? ", its last round lost" : "";
      open.push(`  ${group.join(" + ")}: ${done.length} of ${capN} round${capN === 1 ? "" : "s"}${atCapNow ? ", at the cap" : ""}${left}${cut ? `, cut check ${cut.state}` : ""}`);
    }
    out(`Review rounds (cap ${capN}, the runner's${st ? "" : " default: its settings aren't written yet"}):`);
    out(open.length ? open.join("\n") : "  no open changes");
    break;
  }
  case "guard": {
    const [a, b] = guardLines(readings({ settingsFile: cfg.settingsFile!, spendFile: cfg.spendFile, tz: cfg.tz, now: new Date() }), new Date());
    out(a); out(b);
    break;
  }
  case "health": {
    let h: Health = {};
    try { h = JSON.parse(readFileSync(cfg.healthFile, "utf8")); } catch { /* none yet */ }
    for (const s of SEATS) { const x = h[s]; out(`  ${LABEL[s]}: ${!x ? "not checked yet" : x.ok ? `ok (${x.at})` : `${x.kind}: ${x.detail}. Fix: ${x.fix}`}`); }
    break;
  }
  default:
    fail("usage: review.sh submit <brief.json> | status <id> | result <id> | useful <id> <seat> <n> | spend | guard | health");
}
