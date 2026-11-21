// Cain's review runner: outside-model reviews from the Pi. Started by the add-on's
// run script, like the record keeper. Its keys come from the add-on's options in
// its own environment only; they are read once, removed from the environment, and
// never printed. Codex (the OpenAI seat) gets an environment with none of them.
import { mkdirSync, rmSync } from "node:fs";
import { pinSocket } from "../pinned.ts";
import { readStop } from "../stop.ts";
import { configFromEnv } from "./config.ts";
import { Runner, type RunnerDeps } from "./runner.ts";
import type { DecisionRec } from "./rounds.ts";
import { claudeSeat } from "./seats/claude.ts";
import { geminiSeat } from "./seats/gemini.ts";
import { codexSeat, codexSignedIn } from "./seats/openai.ts";
import { perplexitySeat } from "./seats/perplexity.ts";
import { CodexLogin, handle } from "./signin.ts";

const log = (m: string) => console.log(`[review] ${m}`);

if (import.meta.main) {
  const env = process.env;
  const keys = { gemini: env.REVIEW_GEMINI_KEY || "", perplexity: env.REVIEW_PERPLEXITY_KEY || "", anthropic: env.REVIEW_ANTHROPIC_KEY || "" };
  for (const k of ["REVIEW_GEMINI_KEY", "REVIEW_PERPLEXITY_KEY", "REVIEW_ANTHROPIC_KEY"]) delete env[k];
  const cfg = configFromEnv();
  const codexHome = env.CODEX_HOME_DIR ?? "/data/codex";
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });

  const seats: RunnerDeps["seats"] = {
    openai: codexSeat({ home: codexHome, model: env.REVIEW_CODEX_MODEL || undefined }),
  };
  if (keys.gemini) seats.gemini = geminiSeat({ key: keys.gemini, model: cfg.models.gemini, bigModel: cfg.models.geminiBig,
    schemaField: env.GEMINI_SCHEMA_FIELD === "responseJsonSchema" ? "responseJsonSchema" : "responseFormat" });
  if (keys.perplexity) seats.perplexity = perplexitySeat({ key: keys.perplexity, model: cfg.models.perplexity });
  if (keys.anthropic) seats.claude = claudeSeat({ key: keys.anthropic, model: cfg.models.claude, selftestModel: "claude-haiku-5-5",
    version: env.ANTHROPIC_VERSION_HEADER || undefined });

  // The owner's decision card at the review cap (Cain 0.16.0): through the link's root socket (only
  // root can open it), which builds the card's words itself and files his tap.
  const linkSock = env.CAIN_LINK_SOCK ?? "/run/cain/link.sock";
  const postDecision = async (d: DecisionRec): Promise<string | null> => {
    const res = await fetch("http://link/decision", { method: "POST", unix: linkSock, headers: { "content-type": "application/json" },
      body: JSON.stringify(d), signal: AbortSignal.timeout(45_000) } as any);
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && j?.status === "posted" && typeof j.message === "string") return j.message;
    log(`the link didn't post the decision card for ${d.key}: ${String(j?.said ?? j?.status ?? res.status).slice(0, 160)}`);
    return null;
  };
  const runner = new Runner(cfg, {
    seats, log, postDecision,
    stopped: () => readStop().stopped,
    unavailable: (s) => (s === "openai" && !codexSignedIn(codexHome) ? { kind: "unconfigured", detail: "Codex isn't signed in to ChatGPT yet" } : null),
  });
  log(`seats: ${(["openai", "gemini", "perplexity", "claude"] as const).map((s) => `${s} ${runner.unavailable(s) ? "off" : "on"}`).join(", ")}`);
  // The Reviewed lines, rebuilt from the queue: a restart loses none (../reviewed.ts).
  runner.publishReviewed();
  // The cap and caps it really uses, for review.sh and the Build hook (run as Cain).
  try { runner.writeSettings(); } catch (e) { log(`couldn't write its settings for review.sh: ${(e as Error).message}`); }

  // The ChatGPT sign-in page, reached as <Cain page>/codex through nginx. On a unix socket
  // only nginx's workers and root can open (C1): a TCP port could be taken by Cain's user while
  // this restarts, and a page of his would be served in the panel as this one.
  const login = new CodexLogin({ home: codexHome });
  try {
    const sock = env.REVIEW_SOCK ?? "/run/cain-web/upstream/codex.sock";
    if (env.REVIEW_PORT) Bun.serve({ hostname: "127.0.0.1", port: Number(env.REVIEW_PORT), fetch: (req) => handle(req, login) });
    else {
      try { rmSync(sock, { force: true }); } catch { /* none */ }
      Bun.serve({ unix: sock, fetch: (req) => handle(req, login) });
      pinSocket(sock);                                 // root:nogroup 0770, as ttyd's (../pinned.ts)
    }
  } catch (e) { log(`sign-in page didn't start: ${(e as Error).message}`); }

  const checkAt = env.REVIEW_CHECK_AT ?? "0300";
  let lastCheck = "", lastTry = 0;
  while (true) {
    try { await runner.tick(); } catch (e) { log(`tick error: ${(e as Error).message}`); }
    const now = new Date();
    const hm = now.toLocaleTimeString("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit" }).replace(":", "");
    const day = now.toLocaleDateString("en-CA", { timeZone: cfg.tz });
    if (hm >= checkAt && lastCheck !== day && Date.now() - lastTry > 3_600_000) {
      lastTry = Date.now();
      try { await runner.selftest(); lastCheck = day; log("nightly seat check done"); }
      catch (e) { log(`nightly seat check didn't finish: ${(e as Error).message}`); }
    }
    await Bun.sleep(Number(env.REVIEW_INTERVAL_S ?? 15) * 1000);
  }
}
