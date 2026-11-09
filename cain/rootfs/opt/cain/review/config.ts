// Where the review service keeps things, and its limits, from the environment the
// run script gives it (the add-on's options). Shared by the runner and review.sh.
import { DEFAULTS, type RunnerConfig } from "./runner.ts";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && v !== "null" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function configFromEnv(env: Record<string, string | undefined> = process.env): RunnerConfig {
  const d = DEFAULTS;
  return {
    queueDir: env.REVIEW_QUEUE ?? "/data/review-queue",
    spendFile: env.REVIEW_SPEND ?? "/data/review-spend.json",
    healthFile: env.REVIEW_HEALTH ?? "/data/review-health.json",
    termsFile: env.REVIEW_TERMS ?? "/data/review-private-terms.txt",
    recordQueue: env.RECORD_QUEUE ?? "/data/record-queue",
    relayFile: env.RELAY_QUEUE ?? "/data/relay.queue",
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
  };
}
