// Where the review service keeps things, and its limits, from the environment the
// run script gives it (the add-on's options). Shared by the runner and review.sh.
import { DEFAULTS, type RunnerConfig } from "./runner.ts";
import { capPaths } from "../capfiles.ts";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && v !== "null" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function configFromEnv(env: Record<string, string | undefined> = process.env): RunnerConfig {
  const d = DEFAULTS;
  return {
    queueDir: env.REVIEW_QUEUE ?? "/data/review-queue",
    inboxDir: env.REVIEW_INBOX ?? "/data/review-inbox",
    spendFile: env.REVIEW_SPEND ?? "/data/review-spend.json",
    spendDaysFile: env.REVIEW_SPEND_DAYS || undefined,
    healthFile: env.REVIEW_HEALTH ?? "/data/review-health.json",
    termsFile: env.REVIEW_TERMS ?? "/data/review-private-terms.txt",
    recordQueue: env.RECORD_QUEUE ?? "/data/record-queue",
    relayFile: env.RELAY_QUEUE ?? "/data/relay.queue",
    reviewedFile: env.CAIN_REVIEWED ?? "/data/trust/reviewed.json",   // ../reviewed.ts
    caps: {
      gemini: num(env.REVIEW_CAP_GEMINI_USD, d.caps.gemini),
      perplexity: num(env.REVIEW_CAP_PERPLEXITY_USD, d.caps.perplexity),
      claude: num(env.REVIEW_CAP_ANTHROPIC_USD, d.caps.claude),
      openaiRuns: num(env.REVIEW_CAP_CODEX_RUNS, d.caps.openaiRuns),
    },
    reviewLimit: num(env.REVIEW_LIMIT_USD, d.reviewLimit),
    timeoutS: { ...d.timeoutS },
    maxOut: { ...d.maxOut },
    models: {
      gemini: env.REVIEW_GEMINI_MODEL || d.models.gemini,
      geminiBig: env.REVIEW_GEMINI_BIG_MODEL || d.models.geminiBig,
      perplexity: env.REVIEW_PERPLEXITY_MODEL || d.models.perplexity,
      claude: env.REVIEW_CLAUDE_MODEL || d.models.claude,
    },
    hourlyS: d.hourlyS,
    tz: env.CHECKIN_TZ ?? d.tz,
    // Cain 0.16.0: set by the run script from the App's options (root's /data/options.json) in the
    // runner's environment only. review.sh, run as Cain, never trusts its own environment for these:
    // it reads what the runner wrote to settingsFile (../guard.ts readSettings).
    roundCap: Math.max(1, Math.floor(num(env.REVIEW_ROUND_CAP, d.roundCap!))) || d.roundCap,
    reservePercent: Math.min(100, num(env.USAGE_RESERVE_PERCENT, d.reservePercent!)),
    // 0.17.0: the week's allowance in tokens (0: not set), the same way: the runner writes it for the rest.
    weeklyAllowance: Math.floor(num(env.PLAN_WEEKLY_ALLOWANCE_TOKENS, d.weeklyAllowance!)),
    // Round 2 of its review fixes: when the allowance was set and how it was worked out (the App's
    // options plan_allowance_set_on and plan_allowance_derivation), written beside it for review.sh guard.
    allowanceSetOn: /^\d{4}-\d{2}-\d{2}$/.test(env.PLAN_ALLOWANCE_SET_ON ?? "") ? env.PLAN_ALLOWANCE_SET_ON : d.allowanceSetOn,
    allowanceDerivation: (env.PLAN_ALLOWANCE_DERIVATION ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300) || d.allowanceDerivation,
    // Round 2: the cap's and guard's paths are constants (../capfiles.ts), overridden only in test mode.
    roundsFile: capPaths(env).rounds,
    settingsFile: capPaths(env).settings,
    guardLog: capPaths(env).guardLog,
  };
}
