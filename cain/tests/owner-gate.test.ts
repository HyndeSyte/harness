import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cain's panel is a writable terminal into his live session. nginx admits only
// Ingress's requests, and of those only the owner's: owner-gate.sh turns
// owner_user_id into a map, and nginx.conf answers 403 before any location when
// the map says no.
const ROOTFS = join(import.meta.dir, "../rootfs");
const GATE = join(ROOTFS, "opt/cain/owner-gate.sh");
const shipped = (p: string) => readFileSync(join(ROOTFS, p), "utf8").replace(/\r\n/g, "\n");

const OWNER = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const ADMITS_OWNER = `map $http_x_remote_user_id $cain_owner { default 0; "${OWNER}" 1; }\n`;
const ADMITS_NO_ONE = "map $http_x_remote_user_id $cain_owner { default 0; }\n";
const LOCKED = "Cain's panel is locked to its owner";
const UNSET = "No owner_user_id set in Configuration, so Cain's panel answers Forbidden to everyone";
const NOT_AN_ID = "owner_user_id in Configuration isn't a Home Assistant user id, so Cain's panel answers Forbidden to everyone";
// What nginx answers everyone but the owner.
const FORBIDDEN = "Cain's panel opens only for its owner (owner_user_id in this App's Configuration).\n";

const BASH = Bun.which("bash");
const NGINX = Bun.which("nginx") ?? ["/usr/sbin/nginx", "/usr/local/sbin/nginx"].find((p) => existsSync(p)) ?? null;
// CI runs all of these: a real-nginx test skipped there would hide a broken gate.
if (process.env.CI && (!NGINX || !BASH)) throw new Error("owner-gate.test.ts: CI needs bash and nginx for these tests");
if (!BASH) console.warn("owner-gate.test.ts: no bash here, so owner-gate.sh is not run");
if (!NGINX) console.warn("owner-gate.test.ts: nginx not found, so the tests against real nginx are skipped");

// Git Bash on Windows wants forward slashes.
const posix = (p: string) => (process.platform === "win32" ? p.replaceAll("\\", "/") : p);

// The id goes in through the environment and bash hands it to the script, as
// terminal/run does: a Windows command line can't carry every character (a
// newline, say) to Git Bash.
function gate(id: string, out: string) {
  const p = Bun.spawnSync([BASH!, "-c", 'exec "$BASH" "$0" "$OWNER_USER_ID" "$1"', posix(GATE), posix(out)],
                          { env: { ...process.env, OWNER_USER_ID: id }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, said: p.stdout.toString().trim(), err: p.stderr.toString(),
           map: existsSync(out) ? readFileSync(out, "utf8") : null };
}

describe.skipIf(!BASH)("owner-gate.sh", () => {
  let dir = "";
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "owner-gate-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a Home Assistant user id admits that one user, and the log line doesn't show it", () => {
    expect(gate(OWNER, join(dir, "owner.conf"))).toEqual({ code: 0, said: LOCKED, err: "", map: ADMITS_OWNER });
  });

  const refused: [string, string, string][] = [
    ["", "no id", UNSET],
    [OWNER.slice(1), "31 characters", NOT_AN_ID],
    [OWNER + "0", "33 characters", NOT_AN_ID],
    [OWNER.toUpperCase(), "uppercase hex", NOT_AN_ID],
    [`${OWNER}";} server { listen 1;`, "an attempt to add nginx config", NOT_AN_ID],
    [`"${OWNER}"`, "quotes", NOT_AN_ID],
    [`${OWNER} `, "a trailing space", NOT_AN_ID],
    [`${OWNER}\n`, "a trailing newline", NOT_AN_ID],
    [OWNER.slice(0, 31) + "g", "a letter past f", NOT_AN_ID],
  ];
  for (const [id, why, said] of refused) {
    test(`${why} admits no one`, () => {
      const out = join(dir, "owner.conf");
      writeFileSync(out, ADMITS_OWNER);                  // an older map that let the owner in is replaced
      expect(gate(id, out)).toEqual({ code: 0, said, err: "", map: ADMITS_NO_ONE });
    });
  }
});

describe("the gate is wired in", () => {
  test("nginx.conf reads the map, and answers 403 before any location", () => {
    const conf = shipped("etc/nginx/nginx.conf");
    const at = (s: string) => conf.indexOf(s);
    const gateLine = `if ($cain_owner != 1) { return 403 ${JSON.stringify(FORBIDDEN)}; }`;
    expect(at("http {")).toBeGreaterThan(-1);
    expect(at("http {")).toBeLessThan(at("include /etc/nginx/owner.conf;"));
    expect(at("include /etc/nginx/owner.conf;")).toBeLessThan(at("server {"));
    expect(at("server {")).toBeLessThan(at(gateLine));
    expect(at(gateLine)).toBeLessThan(conf.search(/^\s*location /m));
    expect(conf).toContain("allow 172.30.32.2;");                          // and still Ingress only
    expect(conf).toContain("deny all;");
  });

  test("the terminal service writes the map from owner_user_id before nginx starts", () => {
    const run = shipped("etc/services.d/terminal/run");
    expect(run).toContain(`owner="$(bashio::config 'owner_user_id'`);
    const write = run.indexOf(`/opt/cain/owner-gate.sh "$owner" /etc/nginx/owner.conf`);
    expect(write).toBeGreaterThan(-1);
    expect(run.search(/nginx_out="\$\(nginx 2>&1\)"/)).toBeGreaterThan(-1);
    expect(write).toBeLessThan(run.search(/nginx_out="\$\(nginx 2>&1\)"/));
  });
});

// terminal/run's gate step as shipped, from reading the options to writing the map,
// run under bash with bashio stubbed and the map in a temp dir. It runs owner-gate.sh
// directly, as the image does, so the script must be executable here too.
const BASHIO_STUBS = [
  'bashio::app.config() { [ -z "${SUPERVISOR_DOWN-}" ]; }',
  'bashio::config() { if [ -n "${SUPERVISOR_DOWN-}" ]; then echo null; else printf "%s" "${OPTION-}"; fi; }',
  'bashio::log.info() { echo "INFO $*"; }',
  'bashio::log.error() { echo "ERROR $*"; }',
].join("\n");

function gateStep(map: string, env: Record<string, string>) {
  const run = shipped("etc/services.d/terminal/run");
  const from = run.indexOf("bashio::app.config");
  const to = run.indexOf("\nfi\n", from);
  if (from < 0 || to < 0) throw new Error("terminal/run no longer has its gate step: update this test");
  const step = run.slice(from, to + 4)
    .replaceAll("/opt/cain/owner-gate.sh", posix(GATE))
    .replaceAll("/etc/nginx/owner.conf", posix(map));
  const p = Bun.spawnSync([BASH!, "-c", `${BASHIO_STUBS}\n${step}`],
                          { env: { ...process.env, OPTION: "", SUPERVISOR_DOWN: "", ...env }, stdout: "pipe", stderr: "pipe" });
  return { log: p.stdout.toString().trim().split("\n"), err: p.stderr.toString().trim(),
           map: existsSync(map) ? readFileSync(map, "utf8") : null };
}

describe.skipIf(!BASH)("terminal/run's gate step", () => {
  let dir = "";
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "gate-step-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("writes the owner's map and says so", () => {
    expect(gateStep(join(dir, "a.conf"), { OPTION: OWNER }))
      .toEqual({ log: [`INFO ${LOCKED}`], err: "", map: ADMITS_OWNER });
  });

  test("when Supervisor can't be read, it says so and admits no one", () => {
    const map = join(dir, "b.conf");
    writeFileSync(map, ADMITS_OWNER);
    expect(gateStep(map, { OPTION: OWNER, SUPERVISOR_DOWN: "1" })).toEqual({
      log: ["ERROR Couldn't read this App's options from Supervisor; the panel stays closed until the next start",
            `INFO ${UNSET}`],
      err: "",
      map: ADMITS_NO_ONE,
    });
  });

  test("when the map can't be written, the old one goes too, so nginx can't start on it", () => {
    const map = join(dir, "c.conf");
    writeFileSync(map, ADMITS_OWNER);
    mkdirSync(`${map}.tmp`);                                // owner-gate.sh can't write its temp file
    const r = gateStep(map, { OPTION: OWNER });
    expect(r.err).toContain(`owner-gate: could not write ${posix(map)}`);   // the script's own refusal
    expect(r).toMatchObject({ log: [`ERROR Could not write ${posix(map)}, so Cain's panel stays closed`], map: null });
  });
});

// Real nginx (GitHub's Ubuntu runners have it), running the shipped nginx.conf with
// only what a test machine needs swapped in: a free localhost port, 127.0.0.1 in
// place of the Ingress proxy, and pid, logs, temp files, the page's files and the
// two upstreams in a temp dir. The gate itself is never touched, so removing it
// from nginx.conf fails these tests.
const BUILT = NGINX ? Bun.spawnSync([NGINX, "-V"], { stdout: "pipe", stderr: "pipe" }).stderr.toString() : "";
const TEMP_PATHS = ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"].filter((t) => !BUILT.includes(`--without-http_${t}_module`));

function render(dir: string, port: number, upstream: number, health = { port: 0, from: "127.0.0.0/30" }): string {
  let conf = shipped("etc/nginx/nginx.conf");
  // A swap that finds nothing fails, so this never quietly tests some other config.
  const swap = (from: RegExp, to: string) => {
    if (!from.test(conf)) throw new Error(`nginx.conf no longer matches ${from}: update this test`);
    conf = conf.replace(new RegExp(from.source, from.flags + "g"), to);
  };
  swap(/^pid .*;$/m, `pid ${dir}/nginx.pid;`);
  swap(/^error_log .*;$/m, `error_log ${dir}/error.log warn;`);
  swap(/^http \{$/m, `http {\n${TEMP_PATHS.map((t) => `  ${t}_temp_path ${dir}/${t};`).join("\n")}`);
  swap(/listen \d+ default_server;/, `listen 127.0.0.1:${port} default_server;`);
  swap(/allow 172\.30\.32\.2;/, "allow 127.0.0.1;");
  swap(/include \/etc\/nginx\/owner\.conf;/, `include ${dir}/owner.conf;`);
  swap(/root \/opt\/cain;/, `root ${dir}/www;`);
  // The Supervisor's health server (Cain 0.15.0, port 8098), kept and tested below (second round: it
  // was stripped here untested): on its own free port, the Supervisor's address the given one, and its
  // mark in the temp dir. Third round: the hassio network (172.30.32.0/23) stands in as the given
  // range, and the note of each refused /health (health-miss.log) is kept in the temp dir.
  swap(/listen 8098;/, `listen 127.0.0.1:${health.port};`);
  swap(/172\.30\.32\.0\/23 1;/, `${health.from} 1;`);
  swap(/allow 172\.30\.32\.0\/23;/, "allow 127.0.0.0/8;");
  swap(/access_log \/run\/cain-web\/health-miss\.log /, `access_log ${dir}/health-miss.log `);
  // Fourth round: the note of each /health 200 (time and address, for probe-drill.sh 7's gate) too.
  swap(/access_log \/run\/cain-web\/health-ok\.log /, `access_log ${dir}/health-ok.log `);
  swap(/if \(-f \/run\/cain-web\/www\/health-down\)/, `if (-f ${dir}/health-down)`);
  // Cain 0.19.0: the link's gateway mark (link/health-gate.ts) on /ready.
  swap(/if \(!-f \/run\/cain-web\/www\/health-gateway\)/, `if (!-f ${dir}/health-gateway)`);
  swap(/^user nobody nogroup;$/m, "");
  // Root's pages (C1: /run/cain-web/www) and the upstreams (C1: unix sockets only nginx's workers and
  // root can open) are moved into the temp dir and onto the stand-in's port.
  swap(/alias \/run\/cain-web\/www\/([\w.-]+);/, `alias ${dir}/$1;`);
  swap(/proxy_pass http:\/\/unix:\/run\/cain-web\/upstream\/[\w.-]+\.sock;/, `proxy_pass http://127.0.0.1:${upstream};`);
  return conf;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = s.port!;
  await s.stop(true);
  return port;
}

// A request written by hand, for what fetch won't send: two copies of a header, or
// a WebSocket upgrade. Resolves with the status code nginx answers.
function raw(port: number, target: string, headers: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let got = "";
    sock.setEncoding("utf8");
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error(`no answer from nginx: ${JSON.stringify(got)}`)); });
    sock.on("connect", () => sock.write([`GET ${target} HTTP/1.1`, "Host: 127.0.0.1", ...headers, "", ""].join("\r\n")));
    sock.on("data", (d) => {
      got += d;
      if (got.includes("\r\n")) { sock.destroy(); resolve(Number(got.split(" ")[1])); }
    });
    sock.on("error", reject);
  });
}
const UPGRADE = ["Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13",
                 "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="];

describe.skipIf(!NGINX || !BASH)(`Cain's panel behind real nginx${NGINX ? "" : " (skipped: nginx not found)"}`, () => {
  // What the owner gets from each location. /codex and /tty/ are proxied to a stand-in
  // for the review runner and ttyd, which notes every request that reaches it.
  const PAGES: [string, string][] = [
    ["/", "the Cain page"],
    ["/signin", "the sign-in link"],
    ["/status", '{"ready":true}'],
    ["/codex", "upstream /codex"],
    ["/tty/", "upstream /tty/"],
  ];
  const reached: string[] = [];
  const running: { proc: Subprocess; dir: string }[] = [];
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let owned = 0;     // owner_user_id set to OWNER
  let unowned = 0;   // owner_user_id empty
  let foreign = 0;   // the health server's Supervisor at another address

  const healthOf = new Map<number, { port: number; dir: string }>();
  async function start(owner: string, from = "127.0.0.0/30"): Promise<number> {
    const dir = mkdtempSync(join(tmpdir(), "cain-nginx-"));
    chmodSync(dir, 0o755);                               // readable by nginx's workers, should they run as another user
    const port = await freePort();
    const hp = await freePort();
    healthOf.set(port, { port: hp, dir });
    expect(gate(owner, join(dir, "owner.conf")).code).toBe(0);
    mkdirSync(join(dir, "www"));
    writeFileSync(join(dir, "www/index.html"), "the Cain page");
    writeFileSync(join(dir, "signin.html"), "the sign-in link");
    writeFileSync(join(dir, "status.json"), '{"ready":true}');
    writeFileSync(join(dir, "health-gateway"), "1\n");     // the link's gateway is connected (0.19.0)
    writeFileSync(join(dir, "nginx.conf"), render(dir, port, upstream!.port!, { port: hp, from }));
    const proc = Bun.spawn([NGINX!, "-p", dir, "-c", join(dir, "nginx.conf"), "-e", join(dir, "error.log"),
                            "-g", "daemon off;"], { stdout: "ignore", stderr: "pipe" });
    running.push({ proc, dir });
    for (let i = 0; i < 100 && proc.exitCode === null; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); return port; } catch { await Bun.sleep(50); }
    }
    proc.kill("SIGKILL");
    await proc.exited;
    const log = existsSync(join(dir, "error.log")) ? readFileSync(join(dir, "error.log"), "utf8") : "";
    throw new Error(`nginx did not start:\n${log}${await new Response(proc.stderr).text()}`);
  }

  async function stopAll() {
    for (const { proc, dir } of running.splice(0)) {
      proc.kill("SIGTERM");
      const stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!stopped) { proc.kill("SIGKILL"); await proc.exited; }
      rmSync(dir, { recursive: true, force: true });
    }
    await upstream?.stop(true);
    upstream = undefined;
  }

  beforeAll(async () => {
    try {
      upstream = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(req, server) {
          const path = new URL(req.url).pathname;
          reached.push(path);
          if (req.headers.get("upgrade") === "websocket" && server.upgrade(req)) return;  // ttyd's terminal
          return new Response(`upstream ${path}`);
        },
        websocket: { message() {} },
      });
      owned = await start(OWNER);
      unowned = await start("");
      foreign = await start(OWNER, "127.0.0.2/32");      // the network somewhere else: 127.0.0.1 isn't in it
    } catch (e) {
      await stopAll();
      throw e;
    }
  });
  afterAll(stopAll);                                    // runs even when a test fails

  async function get(port: number, path: string, user?: string) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: user ? { "X-Remote-User-Id": user } : {} });
    return { path, status: res.status, body: await res.text() };
  }

  test("its owner gets every page, the terminal included", async () => {
    reached.length = 0;
    for (const [path, body] of PAGES) expect(await get(owned, path, OWNER)).toEqual({ path, status: 200, body });
    expect(reached).toEqual(["/codex", "/tty/"]);
  });

  test("another Home Assistant user gets 403 everywhere, and nothing reaches the terminal", async () => {
    reached.length = 0;
    for (const [path] of PAGES) expect(await get(owned, path, OTHER)).toEqual({ path, status: 403, body: FORBIDDEN });
    expect(reached).toEqual([]);
  });

  test("a request with no user at all gets 403 everywhere", async () => {
    reached.length = 0;
    for (const [path] of PAGES) expect(await get(owned, path)).toEqual({ path, status: 403, body: FORBIDDEN });
    expect(reached).toEqual([]);
  });

  test("with no owner set, the owner's id gets 403 everywhere too", async () => {
    reached.length = 0;
    for (const [path] of PAGES) expect(await get(unowned, path, OWNER)).toEqual({ path, status: 403, body: FORBIDDEN });
    expect(reached).toEqual([]);
  });

  test("a second, lowercase copy of the user header gets 403, whichever id comes first", async () => {
    reached.length = 0;
    for (const [first, second] of [[OTHER, OWNER], [OWNER, OTHER]]) {
      expect(await raw(owned, "/tty/", [`X-Remote-User-Id: ${first}`, `x-remote-user-id: ${second}`])).toBe(403);
    }
    expect(reached).toEqual([]);
  });

  test("the terminal's WebSocket opens for its owner, and for no one else", async () => {
    reached.length = 0;
    expect(await raw(owned, "/tty/ws", [`X-Remote-User-Id: ${OTHER}`, ...UPGRADE])).toBe(403);
    expect(await raw(owned, "/tty/ws", UPGRADE)).toBe(403);
    expect(reached).toEqual([]);
    expect(await raw(owned, "/tty/ws", [`X-Remote-User-Id: ${OWNER}`, ...UPGRADE])).toBe(101);
    expect(reached).toEqual(["/tty/ws"]);
  });

  // The Supervisor's health check (Cain 0.15.0, second round), as shipped: 200 while well, 503 once the
  // run script's mark is there, 404 on every other path, and 404 for anyone but the Supervisor.
  test("the health check answers the Supervisor only: 200, then 503 with the mark, 404 elsewhere", async () => {
    const h = healthOf.get(owned)!;
    const at = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => [r.status, (await r.text()).trim()]);
    expect(await at(h.port, "/health")).toEqual([200, "ok"]);
    writeFileSync(join(h.dir, "health-down"), "");
    expect(await at(h.port, "/health")).toEqual([503, "a self-restart is due"]);
    rmSync(join(h.dir, "health-down"));
    expect(await at(h.port, "/health")).toEqual([200, "ok"]);
    for (const path of ["/", "/status", "/signin", "/tty/", "/health/x", "/healthz", "/ready/x", "/readyz"]) expect([path, (await at(h.port, path))[0]]).toEqual([path, 404]);
    // Not on the network (127.0.0.2/32 in this config): 404 even for /health and /ready, mark or none.
    const f = healthOf.get(foreign)!;
    expect((await at(f.port, "/health"))[0]).toBe(404);
    expect((await at(f.port, "/ready"))[0]).toBe(404);
    writeFileSync(join(f.dir, "health-down"), "");
    expect((await at(f.port, "/health"))[0]).toBe(404);
  });

  // Cain 0.19.0 (first review fix): /health is liveness (it no longer depends on Discord's gateway) and /ready, beside it,
  // is readiness: 200 only while the link's gateway mark is there, 503 otherwise.
  test("/health is liveness and /ready readiness: the gateway mark moves /ready alone", async () => {
    const h = healthOf.get(owned)!;
    const at = (path: string) => fetch(`http://127.0.0.1:${h.port}${path}`).then(async (r) => [r.status, (await r.text()).trim()]);
    expect(await at("/ready")).toEqual([200, "ready"]);
    rmSync(join(h.dir, "health-gateway"));
    expect(await at("/ready")).toEqual([503, "Discord's gateway isn't connected"]);
    expect(await at("/health")).toEqual([200, "ok"]);
    writeFileSync(join(h.dir, "health-down"), "");
    expect(await at("/health")).toEqual([503, "a self-restart is due"]);
    rmSync(join(h.dir, "health-down"));
    writeFileSync(join(h.dir, "health-gateway"), "1\n");
    expect(await at("/ready")).toEqual([200, "ready"]);
    expect(await at("/health")).toEqual([200, "ok"]);
  });

  // Third round: the whole hassio network gets the answer (127.0.0.0/30 stands in for 172.30.32.0/23):
  // the Supervisor's usual address and another address in the range get 200, one outside it 404, and
  // each refused /health is noted with its address for the run script's once-a-minute log line.
  test.skipIf(process.platform !== "linux")("the health check answers every address on the network, 404 outside it, and notes each 404's address", async () => {
    const h = healthOf.get(owned)!;
    const from = (local: string, path: string) => new Promise<number>((resolve, reject) => {
      const sock = connect({ port: h.port, host: "127.0.0.1", localAddress: local });
      let got = "";
      sock.setEncoding("utf8");
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error(`no answer from nginx: ${JSON.stringify(got)}`)); });
      sock.on("connect", () => sock.write([`GET ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", "", ""].join("\r\n")));
      sock.on("data", (d) => { got += d; if (got.includes("\r\n")) { sock.destroy(); resolve(Number(got.split(" ")[1])); } });
      sock.on("error", reject);
    });
    const miss = join(h.dir, "health-miss.log");
    writeFileSync(miss, "");
    expect(await from("127.0.0.1", "/health")).toBe(200);
    expect(await from("127.0.0.2", "/health")).toBe(200);
    expect(await from("127.0.0.9", "/health")).toBe(404);
    expect(await from("127.0.0.2", "/healthz")).toBe(404);
    expect(await from("127.0.0.2", "/")).toBe(404);
    let noted = "";
    for (let i = 0; i < 40 && !noted.includes("127.0.0.9"); i++) { await Bun.sleep(50); noted = readFileSync(miss, "utf8"); }
    expect(noted.split("\n").filter(Boolean)).toEqual(["127.0.0.9"]);   // only /health's 404s, with the address
    // Fourth round: each /health 200 is noted with its time (epoch seconds) and address; 404s and other
    // paths are not.
    const ok = join(h.dir, "health-ok.log");
    writeFileSync(ok, "");
    const t0 = Math.floor(Date.now() / 1000);
    expect(await from("127.0.0.2", "/health")).toBe(200);
    expect(await from("127.0.0.9", "/health")).toBe(404);
    expect(await from("127.0.0.2", "/healthz")).toBe(404);
    let oks: string[] = [];
    for (let i = 0; i < 40 && oks.length < 1; i++) { await Bun.sleep(50); oks = readFileSync(ok, "utf8").split("\n").filter(Boolean); }
    expect(oks.length).toBe(1);
    const [at, addr] = oks[0].split(" ");
    expect(addr).toBe("127.0.0.2");
    expect(Math.abs(Number(at) - t0)).toBeLessThan(5);
  });
});
