// OpenAI seat: OpenAI's own Codex CLI, signed in with Dane's ChatGPT plan, run
// non-interactively. Read 2026-11-08 (learn.chatgpt.com/docs/non-interactive-mode,
// /docs/cli/reference, /docs/auth): `codex exec` with --ephemeral,
// --skip-git-repo-check, --sandbox read-only, -C <dir>, --output-schema <file>,
// -o <file>, --json (JSONL events; turn.completed carries usage); -c key=value for
// config (web_search = "live" for current facts); auth in $CODEX_HOME/auth.json.
// It runs in an empty folder with nothing of Cain's in its environment: no keys,
// no record, no home.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWER_SCHEMA, SeatError, prompt, validateAnswer } from "../core.ts";
import { type SeatFn } from "./common.ts";

export type Exec = (cmd: string[], o: { env: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ code: number; stdout: string; stderr: string }>;

export const bunExec: Exec = async (cmd, o) => {
  const p = Bun.spawn(cmd, { env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = () => { try { p.kill("SIGKILL"); } catch { /* gone */ } };
  o.signal.addEventListener("abort", kill, { once: true });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  o.signal.removeEventListener("abort", kill);
  return { code, stdout, stderr };
};

export type CodexOptions = { bin?: string; home: string; model?: string; exec?: Exec; scratch?: string };

export function codexSignedIn(home: string): boolean {
  return existsSync(join(home, "auth.json"));
}

// What went wrong, from Codex's own words.
export function classifyCodex(text: string): "auth" | "quota" | "transient" {
  const t = text.toLowerCase();
  if (/not logged in|log ?in again|please (re-?)?login|unauthori[sz]ed|\b401\b|refresh token|token (has )?expired|sign in/.test(t)) return "auth";
  if (/usage limit|rate limit|\b429\b|quota|too many requests|limit reached/.test(t)) return "quota";
  return "transient";
}

export function codexSeat(o: CodexOptions): SeatFn {
  const bin = o.bin ?? "codex";
  const exec = o.exec ?? bunExec;
  return async (input) => {
    if (!codexSignedIn(o.home)) throw new SeatError("unconfigured", "Codex isn't signed in to ChatGPT yet");
    const tmp = mkdtempSync(join(o.scratch ?? tmpdir(), "codex-review-"));
    try {
      const work = join(tmp, "work"); mkdirSync(work);
      const home = join(tmp, "home"); mkdirSync(home);
      const schema = join(tmp, "schema.json"), out = join(tmp, "answer.json");
      writeFileSync(schema, JSON.stringify(ANSWER_SCHEMA));
      const p = prompt(input.brief, input.role === "facts" ? "facts" : input.role);
      const cmd = [bin, "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", work,
        "--output-schema", schema, "-o", out, "--json"];
      if (o.model) cmd.push("-m", o.model);
      if (input.brief.needs_facts && !input.selftest) cmd.push("-c", 'web_search="live"');
      cmd.push(`${p.system}\n\n${p.user}`);
      const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CODEX_HOME: o.home, HOME: home, LANG: "C.UTF-8" };
      let r;
      try { r = await exec(cmd, { env, signal: input.signal }); }
      catch (e) { throw new SeatError(input.signal.aborted ? "timeout" : "transient", `Codex didn't run: ${(e as Error).message.slice(0, 120)}`); }
      if (input.signal.aborted) throw new SeatError("timeout", "no answer before the seat's deadline");
      let model = "", usage = { input: 0, output: 0 }, problem = "";
      for (const line of r.stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (typeof ev.model === "string") model = ev.model;
        if (typeof ev?.thread?.model === "string") model = ev.thread.model;
        if (ev.type === "turn.completed" && ev.usage) usage = {
          input: Number(ev.usage.input_tokens ?? 0) + Number(ev.usage.cached_input_tokens ?? 0),
          output: Number(ev.usage.output_tokens ?? 0) + Number(ev.usage.reasoning_output_tokens ?? 0) };
        if (ev.type === "turn.failed" || ev.type === "error") problem += ` ${ev.error?.message ?? ev.message ?? ""}`;
      }
      if (r.code !== 0 || problem.trim()) {
        const words = `${problem} ${r.stderr}`.trim();
        throw new SeatError(classifyCodex(words), `Codex: ${words.replace(/\s+/g, " ").slice(0, 200) || `exit ${r.code}`}`);
      }
      if (!existsSync(out)) throw new SeatError("bad_output", "Codex finished without a final answer");
      const v = validateAnswer(readFileSync(out, "utf8"));
      if (!v.answer) throw new SeatError("bad_output", v.error!);
      return { ...v.answer, model: model || o.model || "Codex default model (ChatGPT plan)", cost_usd: 0, tokens: usage };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}
