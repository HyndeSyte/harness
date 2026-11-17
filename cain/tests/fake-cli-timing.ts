// A stand-in for the claude command line in the probe's hook_timing tests (pcjobs.test.ts): it
// prints a session's events as stream-json does and runs the real nav-guard hook for each tool
// call the way Claude Code does, as a child process with the call on its standard input and a
// timeout that starts when the call is printed. Its knobs, from the environment:
//   FAKE_WORKER          the worker file whose nav-guard it runs
//   FAKE_TIMEOUT_MS      the CLI's hook timeout (default 3500)
//   FAKE_DELAY_MS        a wait between printing the call and starting the hook: a slow cold start
//   FAKE_RUN_ON_TIMEOUT  1: a navigation whose hook timed out runs anyway (a CLI that fails open)
// A hook that exits 2 refuses the call (its standard error is the call's error result). One that
// answers nothing in time is left out: the permission layer then decides, refusing a navigation
// (dontAsk, not in the allow list) and running the reading tools it allows.
import { spawn } from "node:child_process";

const prompt = process.argv[2] ?? "";
const env = process.env;
const timeout = Number(env.FAKE_TIMEOUT_MS ?? 3500), delay = Number(env.FAKE_DELAY_MS ?? 0), runOnTimeout = env.FAKE_RUN_ON_TIMEOUT === "1";
const out = (x: unknown) => process.stdout.write(JSON.stringify(x) + "\n");
const res = (id: string, error: boolean, text: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: text }] } });
const CH = "mcp__claude-in-chrome__";
out({ type: "system", subtype: "init", tools: [`${CH}tabs_context_mcp`, `${CH}navigate`], mcp_servers: [{ name: "claude-in-chrome", status: "connected" }], claude_code_version: "2.1.0", session_id: "s" });
const calls: [string, Record<string, unknown>][] = prompt.includes("stalled on purpose") ? [[`${CH}navigate`, { url: "about:blank" }]] : [[`${CH}tabs_context_mcp`, {}]];
const denials: { tool_name: string; tool_use_id: string }[] = [];
let n = 0;
for (const [name, input] of calls) {
  const id = `toolu_${++n}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const start = Date.now();
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  const hook = await new Promise<{ code: number | null; out: string; err: string; timedOut: boolean }>((done) => {
    const p = spawn(process.execPath, [env.FAKE_WORKER!, "nav-guard"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let o = "", e = "", timedOut = false;
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, Math.max(0, timeout - (Date.now() - start)));
    p.stdout!.on("data", (d) => { o += d; });
    p.stderr!.on("data", (d) => { e += d; });
    p.on("close", (code) => { clearTimeout(t); done({ code, out: o, err: e, timedOut }); });
    p.stdin!.end(JSON.stringify({ session_id: "s", tool_use_id: id, tool_name: name, tool_input: input }));
  });
  if (!hook.timedOut && hook.code === 2) { out(res(id, true, `PreToolUse:${name} hook error: ${hook.err.trim()}`)); continue; }
  const allowed = !hook.timedOut && /"permissionDecision":"allow"/.test(hook.out);
  if (name.endsWith("navigate") && !allowed && !(hook.timedOut && runOnTimeout)) {
    denials.push({ tool_name: name, tool_use_id: id });
    out(res(id, true, `Permission to use ${name} has been denied.`));
    continue;
  }
  out(res(id, false, "ran"));
}
out({ type: "result", subtype: "success", result: "done", permission_denials: denials });
