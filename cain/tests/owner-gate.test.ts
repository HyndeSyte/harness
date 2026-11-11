import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const BASH = Bun.which("bash");
const NGINX = Bun.which("nginx") ?? ["/usr/sbin/nginx", "/usr/local/sbin/nginx"].find((p) => existsSync(p)) ?? null;
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
    const gateLine = "if ($cain_owner = 0) { return 403; }";
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
    expect(write).toBeLessThan(run.search(/^nginx /m));
  });
});

// Real nginx (GitHub's Ubuntu runners have it), running the shipped nginx.conf with
// only what a test machine needs swapped in: a free localhost port, 127.0.0.1 in
// place of the Ingress proxy, and pid, logs, temp files, the page's files and the
// two upstreams in a temp dir. The gate itself is never touched, so removing it
// from nginx.conf fails these tests.
const BUILT = NGINX ? Bun.spawnSync([NGINX, "-V"], { stdout: "pipe", stderr: "pipe" }).stderr.toString() : "";
const TEMP_PATHS = ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"].filter((t) => !BUILT.includes(`--without-http_${t}_module`));

function render(dir: string, port: number, upstream: number): string {
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
  swap(/alias \/tmp\/([\w.-]+);/, `alias ${dir}/$1;`);
  swap(/proxy_pass http:\/\/127\.0\.0\.1:\d+;/, `proxy_pass http://127.0.0.1:${upstream};`);
  return conf;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = s.port!;
  await s.stop(true);
  return port;
}

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

  async function start(owner: string): Promise<number> {
    const dir = mkdtempSync(join(tmpdir(), "cain-nginx-"));
    chmodSync(dir, 0o755);                               // readable by nginx's workers, should they run as another user
    const port = await freePort();
    expect(gate(owner, join(dir, "owner.conf")).code).toBe(0);
    mkdirSync(join(dir, "www"));
    writeFileSync(join(dir, "www/index.html"), "the Cain page");
    writeFileSync(join(dir, "signin.html"), "the sign-in link");
    writeFileSync(join(dir, "status.json"), '{"ready":true}');
    writeFileSync(join(dir, "nginx.conf"), render(dir, port, upstream!.port!));
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
      upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
        const path = new URL(req.url).pathname;
        reached.push(path);
        return new Response(`upstream ${path}`);
      } });
      owned = await start(OWNER);
      unowned = await start("");
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
    for (const [path] of PAGES) expect(await get(owned, path, OTHER)).toMatchObject({ path, status: 403 });
    expect(reached).toEqual([]);
  });

  test("a request with no user at all gets 403 everywhere", async () => {
    reached.length = 0;
    for (const [path] of PAGES) expect(await get(owned, path)).toMatchObject({ path, status: 403 });
    expect(reached).toEqual([]);
  });

  test("with no owner set, the owner's id gets 403 everywhere too", async () => {
    reached.length = 0;
    for (const [path] of PAGES) expect(await get(unowned, path, OWNER)).toMatchObject({ path, status: 403 });
    expect(reached).toEqual([]);
  });
});
