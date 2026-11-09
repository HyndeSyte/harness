// ChatGPT sign-in for the Codex seat, from Dane's phone: a page on the add-on's
// Ingress (<Cain page>/codex) starts `codex login --device-auth` and shows the
// link and the one-time code, so he signs in with no terminal typing.
// Read 2026-11-08 (learn.chatgpt.com/docs/auth): device code sign-in is in beta and
// must first be turned on in ChatGPT's security settings; without it Codex falls
// back to a browser login that can't finish on a headless box. Codes last 15 minutes.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type LoginPhase = "idle" | "starting" | "waiting" | "signed_in" | "failed" | "needs_setting";
export type LoginState = { phase: LoginPhase; url?: string; code?: string; until?: string; message?: string };

export type Proc = { output: (cb: (chunk: string) => void) => void; exited: Promise<number>; kill: () => void };
export type Spawn = (cmd: string[], env: Record<string, string>) => Proc;

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function parseDeviceOutput(raw: string): { url?: string; code?: string; fallback: boolean } {
  const text = raw.replace(ANSI, "");
  const url = text.match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com|auth\.chatgpt\.com)\/[^\s"'<>]*/)?.[0];
  const code = text.match(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/)?.[1];
  // The browser flow (a localhost callback or an authorize link) means device code is off.
  const fallback = !code && /localhost:\d+|127\.0\.0\.1:\d+|oauth\/authorize/i.test(text);
  return { url: code ? url : undefined, code, fallback };
}

export const bunSpawn: Spawn = (cmd, env) => {
  const p = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const listeners: ((c: string) => void)[] = [];
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of s as any) { const t = dec.decode(chunk, { stream: true }); for (const l of listeners) l(t); }
  };
  pump(p.stdout); pump(p.stderr);
  return { output: (cb) => listeners.push(cb), exited: p.exited, kill: () => { try { p.kill(); } catch { /* gone */ } } };
};

export class CodexLogin {
  private st: LoginState = { phase: "idle" };
  private proc?: Proc;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private o: { bin?: string; home: string; spawn?: Spawn; now?: () => Date; limitMs?: number; signedIn?: () => boolean }) {}

  signedIn(): boolean { return this.o.signedIn?.() ?? existsSync(join(this.o.home, "auth.json")); }

  state(): LoginState {
    if (this.st.phase === "idle" && this.signedIn()) return { phase: "signed_in" };
    return { ...this.st };
  }

  start(): LoginState {
    if (this.proc && (this.st.phase === "starting" || this.st.phase === "waiting")) return this.state();
    mkdirSync(this.o.home, { recursive: true, mode: 0o700 });
    // Credentials in a file under /data (Home Assistant's backups keep it), never a keyring.
    writeFileSync(join(this.o.home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CODEX_HOME: this.o.home, HOME: this.o.home, LANG: "C.UTF-8", NO_COLOR: "1" };
    const now = (this.o.now ?? (() => new Date()))();
    const limit = this.o.limitMs ?? 15 * 60_000;
    this.st = { phase: "starting", until: new Date(now.getTime() + limit).toISOString() };
    let seen = "";
    const p = (this.o.spawn ?? bunSpawn)([this.o.bin ?? "codex", "login", "--device-auth"], env);
    this.proc = p;
    p.output((chunk) => {
      seen = (seen + chunk).slice(-8_000);
      const d = parseDeviceOutput(seen);
      if (d.code && d.url && this.st.phase === "starting") this.st = { ...this.st, phase: "waiting", url: d.url, code: d.code };
      else if (d.fallback && this.st.phase === "starting") {
        this.st = { phase: "needs_setting", message: "Device code sign-in is off for this ChatGPT account. In ChatGPT, open Settings, Security, turn on device code sign-in for Codex, then tap Start again." };
        p.kill();
      }
    });
    this.timer = setTimeout(() => { if (this.proc === p) { p.kill(); this.st = { phase: "failed", message: "The code ran out after 15 minutes. Tap Start for a new one." }; } }, limit);
    p.exited.then((code) => {
      clearTimeout(this.timer);
      if (this.proc !== p) return;
      this.proc = undefined;
      if (this.st.phase === "needs_setting" || this.st.phase === "failed") return;
      this.st = code === 0 && this.signedIn() ? { phase: "signed_in", message: "Signed in. Cain's OpenAI reviews use your ChatGPT plan now." }
        : { phase: "failed", message: "The sign-in didn't finish. Tap Start for a new code." };
    });
    return this.state();
  }
}

export const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT sign-in for Cain</title>
<style>
  body { margin: 0; padding: 18px; background: #111; color: #eee; font: 16px system-ui, sans-serif; max-width: 34em; }
  h1 { font-size: 1.25em; } .code { font: 700 2em ui-monospace, monospace; letter-spacing: .08em; margin: .4em 0; }
  a.btn, button { display: inline-block; padding: 12px 18px; border: 0; border-radius: 8px; background: #10a37f; color: #fff; font-weight: 600; font-size: 1em; text-decoration: none; }
  .muted { color: #aaa; }
</style></head>
<body>
<h1>ChatGPT sign-in for Cain's reviews</h1>
<p class="muted">Cain's OpenAI reviewer runs on your ChatGPT plan. Sign in once; it stays signed in.</p>
<div id="box"><p>Checking…</p></div>
<script>
  const box = document.getElementById("box");
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  async function start() { await fetch("codex/start", { method: "POST" }); show(); }
  async function show() {
    let s = {};
    try { s = await (await fetch("codex/state", { cache: "no-store" })).json(); } catch (e) {}
    if (s.phase === "waiting" && /^https:\\/\\//.test(s.url || "")) {
      box.innerHTML = '<p>1. Copy this code:</p><div class="code">' + esc(s.code) + '</div>'
        + '<p>2. <a class="btn" target="_blank" rel="noopener" href="' + esc(s.url) + '">Open ChatGPT sign-in</a></p>'
        + '<p class="muted">Sign in, enter the code, and come back. This page updates by itself.</p>';
    } else if (s.phase === "signed_in") {
      box.innerHTML = '<p>Signed in. Nothing else to do.</p>';
    } else if (s.phase === "starting") {
      box.innerHTML = '<p>Getting a code…</p>';
    } else {
      box.innerHTML = (s.message ? '<p>' + esc(s.message) + '</p>' : '<p>Not signed in.</p>') + '<button id="go">Start sign-in</button>';
      document.getElementById("go").onclick = start;
    }
  }
  show(); setInterval(show, 3000);
</script>
</body></html>
`;

// Routes, behind nginx, which admits only Home Assistant's Ingress proxy.
export async function handle(req: Request, login: CodexLogin): Promise<Response> {
  const path = new URL(req.url).pathname;
  const headers = { "cache-control": "no-store" };
  if (req.method === "GET" && path === "/codex") return new Response(PAGE, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  if (req.method === "GET" && path === "/codex/state") return Response.json(login.state(), { headers });
  if (req.method === "POST" && path === "/codex/start") return Response.json(login.start(), { headers });
  return new Response("not found", { status: 404 });
}
