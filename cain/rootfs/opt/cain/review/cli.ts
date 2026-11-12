// review.sh: Cain's way to ask for an outside review and read what came back.
//   submit <brief.json>    queue a brief; prints its id (or "blocked: privacy ...", exit 3)
//   status <id>            the review's state and each seat's state, one line each
//   result <id>            result.json (what goes to the record), once finished
//   useful <id> <seat> <n> how many of that seat's findings Cain adopted (cost per useful finding)
//   spend                  this month per seat: dollars, cap, runs, findings, useful, $ per useful
//   health                 the last nightly seat check
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStop, stoppedWhy } from "../stop.ts";
import { FINAL, LABEL, SEATS, markBlocked, newReview, parseBrief, privacyCheck, resultJson, shownId, type SeatName } from "./core.ts";
import { configFromEnv } from "./config.ts";
import { existsReview, loadReview, saveReview, type Ledger, type Health } from "./runner.ts";

const cfg = configFromEnv();
const usefulFile = process.env.REVIEW_USEFUL ?? join(dirname(cfg.spendFile), "review-useful.jsonl");
const out = (s: string) => console.log(s);
const fail = (s: string, code = 2): never => { console.error(s); process.exit(code); };
const [cmd, a1, a2, a3] = process.argv.slice(2);
const terms = () => { try { return readFileSync(cfg.termsFile, "utf8"); } catch { return null; } };

function money(n: number) { return `$${n.toFixed(2)}`; }

switch (cmd) {
  case "submit": {
    if (!a1) fail("usage: review.sh submit <brief.json>");
    let raw = "";
    try { raw = readFileSync(a1, "utf8"); } catch { fail(`can't read ${a1}`); }
    const p = parseBrief(raw);
    if (!p.brief) fail(`not a brief: ${p.error}`);
    const b = p.brief!;
    if (existsReview(cfg.queueDir, b.id)) fail(`a review with id ${b.id} already exists; use a new id`);
    const r = newReview(b, new Date());
    // The gate runs here first, so Cain hears at once; the runner runs it again before every call.
    const g = privacyCheck(b, terms());
    if (!g.ok) {
      markBlocked(r, g.why, r.created_at);
      r.relayed = true;
      saveReview(cfg.queueDir, r);
      fail(`blocked: privacy (${g.why.join("; ")}). Nothing was sent.`, 3);
    }
    saveReview(cfg.queueDir, r);
    out(b.id);
    // While stopped it's queued all the same, and nothing goes out until he turns it back on.
    const st = readStop();
    if (st.stopped) console.error(`Queued, not sent: ${stoppedWhy(st, "no review is sent")} It goes out by itself once he does.`);
    break;
  }
  case "status": {
    const r = a1 ? loadReview(cfg.queueDir, a1) : null;
    if (!r) fail(`no review ${a1 ?? ""}`.trim(), 1);
    out(`${shownId(r!)}: ${r!.status}${r!.blocked_why ? ` (${r!.blocked_why.join("; ")})` : ""}${r!.record_dir ? `, record ${r!.record_dir}` : ""}, $${r!.cost_usd.toFixed(3)}`);
    for (const s of r!.seats) {
      const who = s.stands_in_for ? `claude for ${s.stands_in_for} (substituted)` : s.seat;
      const what = s.state === "done" ? `${s.verdict}, ${s.findings?.length ?? 0} finding(s), ${s.model}` : s.error ? `${s.error.kind}: ${s.error.detail}. Fix: ${s.error.fix}` : "";
      out(`  ${who}: ${s.state}${what ? `, ${what}` : ""}${s.next_at ? `, next try ${s.next_at}` : ""}`);
    }
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
    out(`${month}: seat, spent / cap, runs, findings, useful, per useful finding`);
    const cap: Record<SeatName, string> = { openai: `${cfg.caps.openaiRuns} runs`, gemini: money(cfg.caps.gemini), perplexity: money(cfg.caps.perplexity), claude: money(cfg.caps.claude) };
    for (const s of SEATS) {
      const r = l[month]?.[s] ?? { usd: 0, runs: 0, findings: 0, searches: 0 };
      const u = useful[s] ?? 0;
      out(`  ${LABEL[s]}: ${money(r.usd)} / ${cap[s]}, ${r.runs} runs, ${r.findings} findings, ${u} useful, ${u ? money(r.usd / u) : "-"}`);
    }
    break;
  }
  case "health": {
    let h: Health = {};
    try { h = JSON.parse(readFileSync(cfg.healthFile, "utf8")); } catch { /* none yet */ }
    for (const s of SEATS) { const x = h[s]; out(`  ${LABEL[s]}: ${!x ? "not checked yet" : x.ok ? `ok (${x.at})` : `${x.kind}: ${x.detail}. Fix: ${x.fix}`}`); }
    break;
  }
  default:
    fail("usage: review.sh submit <brief.json> | status <id> | result <id> | useful <id> <seat> <n> | spend | health");
}
