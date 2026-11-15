// The PC job queue (rootfs/opt/cain/pcjobs/): the format, Cain's keeper on a real git
// repo standing in for GitHub, the PC worker against the same repo, and pcjobs.sh.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { allowed, confirmWhy, jobClaimFor, jobFromAsk, jobText, makeJobToken, parseAllowlist, parseJob, parseResult,
  readJobToken, signerOf, stateAfter, type Job } from "../rootfs/opt/cain/pcjobs/core.ts";
import { round, readJobs, readResult, type Config } from "../rootfs/opt/cain/pcjobs/main.ts";
import { finish, next } from "../rootfs/opt/cain/pcjobs/worker.ts";
import { makeToken, publicKey as shipPublicKey, readToken } from "../rootfs/opt/cain/ship-token.ts";
import { publicOf } from "../rootfs/opt/cain/link/shipkey.ts";
import { cleanEnv, sh } from "./rig.ts";

const OPT = resolve(import.meta.dir, "../rootfs/opt/cain");
const REPO = resolve(import.meta.dir, "../..");
const T0 = new Date("2026-11-15T14:00:00.000Z");
const mins = (n: number) => new Date(T0.getTime() + n * 60_000);
const KEYS = generateKeyPairSync("ed25519");
const PUB = publicOf(KEYS.privateKey);
const sign = signerOf(KEYS.privateKey);

const READ = { site: "example.com", action: "read_account_settings", step: "read",
  start_url: "https://example.com/account/settings", done_looks_like: "The settings page is open and its sections are named" };

function job(over: Partial<Job> = {}): Job {
  return { v: 1, id: "j-20261115-abc123", from: "cain", created: T0.toISOString(), expires: mins(24 * 60).toISOString(),
    state: "pending", lease_until: null, ...READ, step: "read", follows: null, owner_go: null, go_token: null, ...over } as Job;
}
const preview = (over: Partial<Job> = {}) => job({ id: "j-20261115-prev01", action: "delete_account", step: "preview",
  start_url: "https://example.com/account/delete", state: "awaiting_owner", ...over });
function confirm(over: Partial<Job> = {}, nowMs = T0.getTime()): Job {
  const claim = jobClaimFor(preview(), nowMs)!;
  return job({ id: "j-20261115-conf01", action: "delete_account", step: "confirm", start_url: "https://example.com/account/delete",
    follows: "j-20261115-prev01", owner_go: "“yes, delete the old example account”", go_token: makeJobToken(claim, sign),
    created: mins(1).toISOString(), ...over });
}

describe("job format", () => {
  test("a good read job parses, and its text round-trips with fields in order", () => {
    const j = job();
    const r = parseJob(jobText(j));
    expect(r.ok).toBe(true);
    expect(Object.keys(JSON.parse(jobText(j)))[0]).toBe("v");
  });

  test("malformed jobs are refused, each with a reason", () => {
    const bad: [any, RegExp][] = [
      ["{nope", /isn't JSON/],
      [{ ...job(), extra: 1 }, /exactly these fields/],
      [{ ...job(), from: "laptop" }, /only Cain's jobs/],
      [{ ...job(), site: "Example.com" }, /one host name/],
      [{ ...job(), site: "a.com b.com" }, /one host name/],
      [{ ...job(), start_url: "https://other.com/account" }, /on the job's site/],
      [{ ...job(), start_url: "http://example.com/account" }, /https/],
      [{ ...job(), action: "Read Settings" }, /snake_case/],
      [{ ...job(), expires: mins(5).toISOString() }, /15 minutes and 72 hours/],
      [{ ...job(), expires: mins(80 * 60).toISOString() }, /15 minutes and 72 hours/],
      [{ ...job(), state: "claimed" }, /lease_until/],
      [{ ...job(), done_looks_like: "two\nlines" }, /one line/],
      [{ ...job(), owner_go: "\"yes\"" }, /only a confirm job/],
    ];
    for (const [j, why] of bad) {
      const r = parseJob(typeof j === "string" ? j : JSON.stringify(j));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why).toMatch(why);
    }
  });

  test("an irreversible step needs his exact go in quotes and a job token", () => {
    expect(parseJob(jobText(confirm())).ok).toBe(true);
    const noGo = parseJob(jobText(confirm({ owner_go: null })));
    expect(noGo.ok || noGo.why).toMatch(/exact go/);
    const unquoted = parseJob(jobText(confirm({ owner_go: "yes delete it" })));
    expect(unquoted.ok || unquoted.why).toMatch(/exact go/);
    const noToken = parseJob(jobText(confirm({ go_token: null })));
    expect(noToken.ok || noToken.why).toMatch(/job token/);
    const noPrev = parseJob(jobText(confirm({ follows: null })));
    expect(noPrev.ok || noPrev.why).toMatch(/preview job/);
  });

  test("a request names one site and one action", () => {
    const two = jobFromAsk({ ...READ, site: "example.com, example.org" }, T0, "j-20261115-abc123");
    expect(two.ok || two.why).toMatch(/one site/);
    const list = jobFromAsk({ ...READ, site: ["example.com", "example.org"] }, T0, "j-20261115-abc123");
    expect(list.ok || list.why).toMatch(/one site/);
    const acts = jobFromAsk({ ...READ, action: ["a_b_c", "d_e_f"] }, T0, "j-20261115-abc123");
    expect(acts.ok || acts.why).toMatch(/one action/);
    const extra = jobFromAsk({ ...READ, notes: "and also check mail" }, T0, "j-20261115-abc123");
    expect(extra.ok || extra.why).toMatch(/not notes/);
    const ok = jobFromAsk({ ...READ, hours: 2 }, T0, "j-20261115-abc123");
    expect(ok.ok && ok.value.expires).toBe(mins(120).toISOString());
  });

  test("results hold named facts only: no page dumps, no new lines, a defined hand-off", () => {
    const base = { v: 1, id: "j-20261115-abc123", status: "done", finished: T0.toISOString(), final_url: "https://example.com/account",
      facts: { signed_in: "yes", email_shown: "masked" }, handoff: null, reason: null };
    expect(parseResult(JSON.stringify(base)).ok).toBe(true);
    const bad: [any, RegExp][] = [
      [{ ...base, page_text: "..." }, /exactly these fields/],
      [{ ...base, facts: { page: "line one\nline two" } }, /one line/],
      [{ ...base, facts: { page: "x".repeat(121) } }, /120/],
      [{ ...base, facts: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, "x"])) }, /at most 8/],
      [{ ...base, facts: { "Page Text": "x" } }, /snake_case/],
      [{ ...base, handoff: "gave_up" }, /handoff is one of/],
      [{ ...base, status: "failed", handoff: "already_gone" }, /counts as done/],
      [{ ...base, final_url: "javascript:alert(1)" }, /https/],
    ];
    for (const [r, why] of bad) {
      const p = parseResult(JSON.stringify(r));
      expect(p.ok || p.why).toMatch(why);
    }
  });

  test("where a job goes after its result", () => {
    const r = (o: any) => ({ v: 1, id: "j-20261115-abc123", status: "done", finished: T0.toISOString(), final_url: null, facts: {}, handoff: null, reason: null, ...o });
    expect(stateAfter(job(), r({}))).toBe("done");
    expect(stateAfter(job(), r({ handoff: "already_gone" }))).toBe("done");
    expect(stateAfter(job(), r({ status: "failed", handoff: "blocked_captcha" }))).toBe("awaiting_owner");
    expect(stateAfter(job(), r({ status: "failed", handoff: "outcome_unknown" }))).toBe("failed");
    expect(stateAfter(preview({ state: "claimed" }), r({}))).toBe("awaiting_owner");
  });
});

describe("job tokens", () => {
  const key = shipPublicKey(PUB);
  test("signed with the link's key, they check out, and neither token passes for the other", () => {
    const t = confirm().go_token!;
    const r = readJobToken(t, key, T0.getTime());
    expect(r.ok && r.value.follows).toBe("j-20261115-prev01");
    expect(readToken(t, key, T0.getTime()).ok).toBe(false);   // not a Ship approval
    const ship = makeToken({ v: 1, repo: "HyndeSyte/harness", pr: 1, head: "a".repeat(40), exp: Math.floor(T0.getTime() / 1000) + 3600 }, sign);
    expect(readJobToken(ship, key, T0.getTime()).ok).toBe(false);
  });

  test("an expired, foreign or mismatched token is refused", () => {
    const c = confirm();
    expect(confirmWhy(c, key, [preview(), c], T0.getTime())).toBe("");
    expect(confirmWhy(c, key, [preview(), c], mins(121).getTime())).toMatch(/expired/);
    const other = generateKeyPairSync("ed25519");
    expect(confirmWhy(c, shipPublicKey(publicOf(other.privateKey)), [preview(), c], T0.getTime())).toMatch(/signature/);
    expect(confirmWhy(c, null, [preview(), c], T0.getTime())).toMatch(/no public key/);
    expect(confirmWhy({ ...c, site: "example.org", start_url: "https://example.org/x" }, key, [preview(), c], T0.getTime())).toMatch(/another job/);
    expect(confirmWhy(c, key, [c], T0.getTime())).toMatch(/isn't in the queue/);
    expect(confirmWhy(c, key, [preview({ state: "done" }), c], T0.getTime())).toMatch(/waiting on Dane/);
    const twin = confirm({ id: "j-20261115-conf00", created: T0.toISOString() });
    expect(confirmWhy(c, key, [preview(), twin, c], T0.getTime())).toMatch(/spent once/);
  });

  test("no token is made unless the preview is waiting on him", () => {
    expect(jobClaimFor(preview({ state: "pending" }), T0.getTime())).toBeNull();
    expect(jobClaimFor(job(), T0.getTime())).toBeNull();
  });
});

describe("allowlist", () => {
  test("site, action and step must all match", () => {
    const a = parseAllowlist(JSON.stringify({ v: 1, allow: [{ site: "example.com", action: "read_account_settings", steps: ["read"] }] }));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(allowed(job(), a.value)).toBe(true);
    expect(allowed(job({ site: "example.org" }), a.value)).toBe(false);
    expect(allowed(job({ step: "preview" }), a.value)).toBe(false);
    expect(parseAllowlist("[]").ok).toBe(false);
  });
});

// A queue repo on disk, with Cain's keeper and the PC's clone of it.
function queueRig() {
  const root = mkdtempSync(join(tmpdir(), "pcjobs-"));
  const remote = join(root, "pc-jobs.git");
  sh(["git", "init", "--quiet", "--bare", "-b", "main", remote], root);
  let now = T0;
  writeFileSync(join(root, "ship.pub"), `${PUB}\n`);
  const cfg: Config = { remote, dir: join(root, "pi/pc-jobs"), queue: join(root, "pi/queue"), outcomes: join(root, "pi/outcomes"),
    branch: "main", pub: join(root, "ship.pub"), now: () => now };
  mkdirSync(cfg.queue, { recursive: true });
  let n = 0;
  const ask = (job: unknown, from = "cain") => {
    const rid = `pc-${String(++n).padStart(4, "0")}`;
    writeFileSync(join(cfg.queue, `${rid}.json`), JSON.stringify({ from, job }));
    return rid;
  };
  const outcome = (rid: string) => JSON.parse(readFileSync(join(cfg.outcomes, `${rid}.json`), "utf8"));
  const pc = join(root, "pc/queue");
  const allowFile = join(root, "pc/allowlist.json");
  mkdirSync(join(root, "pc"), { recursive: true });
  const allow = (entries: unknown[]) => writeFileSync(allowFile, JSON.stringify({ v: 1, allow: entries }));
  const clonePc = () => {
    if (!existsSync(pc)) sh(["git", "clone", "--quiet", remote, pc], root);
  };
  const opts = () => ({ queue: pc, allow: allowFile, pub: join(root, "ship.pub"), now: () => now });
  const remoteFile = (path: string) => sh(["git", "show", `main:${path}`], remote);
  return { root, remote, cfg, ask, outcome, clonePc, opts, allow, remoteFile, at: (d: Date) => { now = d; } };
}

describe("Cain's keeper", () => {
  test("writes a good job into the queue repo and refuses malformed ones", () => {
    const q = queueRig();
    const good = q.ask(READ);
    const bad = q.ask({ ...READ, start_url: "https://elsewhere.com/x" });
    const second = q.ask({ ...READ, site: "example.com example.org" });
    const stranger = q.ask(READ, "laptop");
    const r = round(q.cfg);
    expect(r).toEqual({ ok: true, queued: 1, refused: 3 });
    const o = q.outcome(good);
    expect(o.state).toBe("queued");
    const pushed = parseJob(q.remoteFile(`jobs/${o.id}.json`));
    expect(pushed.ok && pushed.value).toMatchObject({ state: "pending", from: "cain", site: "example.com", step: "read" });
    expect(q.outcome(bad)).toMatchObject({ state: "refused", reason: expect.stringContaining("on the job's site") });
    expect(q.outcome(second)).toMatchObject({ state: "refused" });
    expect(q.outcome(stranger)).toMatchObject({ state: "refused", reason: "only Cain's jobs are accepted" });
    expect(readdirSync(q.cfg.queue)).toEqual([]);
    expect(readJobs(q.cfg.dir).map((j) => j.id)).toEqual([o.id]);
  });

  test("refuses an irreversible step without a quoted go and a valid token, and accepts it with them", () => {
    const q = queueRig();
    // A preview, run on the PC, now waiting on Dane.
    q.allow([{ site: "example.com", action: "delete_account", steps: ["preview", "confirm"] }]);
    const p = q.ask({ ...READ, action: "delete_account", step: "preview", start_url: "https://example.com/account/delete" });
    round(q.cfg);
    const pid = q.outcome(p).id;
    q.clonePc();
    expect(next(q.opts()).run?.id).toBe(pid);
    const res = join(q.root, "res.json");
    writeFileSync(res, JSON.stringify({ status: "done", final_url: "https://example.com/account/delete", facts: { confirm_button: "Delete my account" } }));
    expect(finish(q.opts(), pid, res).state).toBe("awaiting_owner");
    round(q.cfg);
    const prev = readJobs(q.cfg.dir).find((j) => j.id === pid)!;
    const token = makeJobToken(jobClaimFor(prev, T0.getTime())!, sign);
    const conf = { ...READ, action: "delete_account", step: "confirm", start_url: "https://example.com/account/delete", follows: pid };
    const noGo = q.ask({ ...conf, go_token: token });
    const unquoted = q.ask({ ...conf, owner_go: "yes", go_token: token });
    const forged = q.ask({ ...conf, owner_go: "\"yes\"", go_token: token.slice(0, -4) + "AAAA" });
    round(q.cfg);
    expect(q.outcome(noGo).reason).toMatch(/exact go/);
    expect(q.outcome(unquoted).reason).toMatch(/exact go/);
    expect(q.outcome(forged).reason).toMatch(/job token refused|job token/);
    const good = q.ask({ ...conf, owner_go: "\"yes, delete it\"", go_token: token });
    round(q.cfg);
    expect(q.outcome(good).state).toBe("queued");
    // The same tap a second time is spent.
    const again = q.ask({ ...conf, owner_go: "\"yes, delete it\"", go_token: token });
    round(q.cfg);
    expect(q.outcome(again).reason).toMatch(/spent once/);
  });

  test("a request stays queued while GitHub can't be reached", () => {
    const q = queueRig();
    const rid = q.ask(READ);
    const r = round({ ...q.cfg, remote: join(q.root, "missing.git") });
    expect(r.ok).toBe(false);
    expect(readdirSync(q.cfg.queue)).toEqual([`${rid}.json`]);
  });
});

describe("the PC worker", () => {
  test("claims the oldest job it may run, refuses off-list and expired ones, and writes a result", () => {
    const q = queueRig();
    q.allow([{ site: "example.com", action: "read_account_settings", steps: ["read"] }]);
    const a = q.ask(READ);
    const off = q.ask({ ...READ, site: "example.org", start_url: "https://example.org/account" });
    const short = q.ask({ ...READ, hours: 0.5 });
    round(q.cfg);
    q.clonePc();
    q.at(mins(40));                                      // the short job has expired by now
    const first = next(q.opts());
    expect(first.run?.id).toBe(q.outcome(a).id);
    expect(first.run?.state).toBe("claimed");
    expect(first.closed.sort()).toEqual([q.outcome(off).id, q.outcome(short).id].sort());
    expect(JSON.parse(q.remoteFile(`results/${q.outcome(off).id}.json`))).toMatchObject({ status: "refused", reason: expect.stringContaining("allowlist") });
    expect(JSON.parse(q.remoteFile(`results/${q.outcome(short).id}.json`)).status).toBe("expired");
    // Claimed already: the next run leaves it alone.
    expect(next(q.opts()).run).toBeNull();
    // A page dump is refused and nothing is written.
    const id = first.run!.id;
    const dump = join(q.root, "dump.json");
    writeFileSync(dump, JSON.stringify({ status: "done", facts: { page: "Account\nName: ...\nEmail: ..." } }));
    expect(() => finish(q.opts(), id, dump)).toThrow(/one line/);
    writeFileSync(dump, JSON.stringify({ status: "done", facts: {}, page_text: "..." }));
    expect(() => finish(q.opts(), id, dump)).toThrow(/only status/);
    const good = join(q.root, "good.json");
    writeFileSync(good, JSON.stringify({ status: "done", final_url: "https://example.com/account/settings", facts: { sections_shown: "Profile, Security, Privacy" } }));
    expect(finish(q.opts(), id, good).state).toBe("done");
    expect(() => finish(q.opts(), id, good)).toThrow(/isn't claimed/);
    // Cain reads it from his copy.
    round(q.cfg);
    const r = readResult(q.cfg.dir, id);
    expect(r && r !== "bad" && r.facts.sections_shown).toBe("Profile, Security, Privacy");
  });

  test("a claim whose lease ran out closes as outcome unknown, never run twice", () => {
    const q = queueRig();
    q.allow([{ site: "example.com", action: "read_account_settings", steps: ["read"] }]);
    const a = q.ask(READ);
    round(q.cfg);
    q.clonePc();
    expect(next(q.opts()).run).not.toBeNull();
    q.at(mins(31));
    const later = next(q.opts());
    expect(later.run).toBeNull();
    expect(later.closed).toEqual([q.outcome(a).id]);
    expect(JSON.parse(q.remoteFile(`results/${q.outcome(a).id}.json`)).handoff).toBe("outcome_unknown");
  });

  test("new jobs pushed by Cain meanwhile don't stop the PC's push", () => {
    const q = queueRig();
    q.allow([{ site: "example.com", action: "read_account_settings", steps: ["read"] }]);
    q.ask(READ);
    round(q.cfg);
    q.clonePc();
    const run = next(q.opts()).run!;
    q.ask(READ);
    round(q.cfg);                                       // Cain's keeper pushes another job
    const res = join(q.root, "r.json");
    writeFileSync(res, JSON.stringify({ status: "done", facts: {} }));
    expect(finish(q.opts(), run.id, res).state).toBe("done");
    expect(readdirSync(join(q.root, "pc/queue/jobs")).length).toBe(2);
  });

  test("a confirm job without a good token is refused on the PC too", () => {
    const q = queueRig();
    q.allow([{ site: "example.com", action: "delete_account", steps: ["preview", "confirm"] }]);
    // Planted straight into the repo, past Cain's keeper.
    const seed = join(q.root, "seed");
    sh(["git", "clone", "--quiet", q.remote, seed], q.root);
    mkdirSync(join(seed, "jobs"), { recursive: true });
    writeFileSync(join(seed, "jobs", "j-20261115-prev01.json"), jobText(preview()));
    const bad = confirm({ go_token: confirm().go_token!.slice(0, -4) + "AAAA" });
    writeFileSync(join(seed, "jobs", `${bad.id}.json`), jobText(bad));
    sh(["git", "add", "-A"], seed);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "plant"], seed);
    sh(["git", "push", "--quiet", "origin", "HEAD:main"], seed);
    q.clonePc();
    const r = next(q.opts());
    expect(r.run).toBeNull();
    expect(r.closed).toEqual([bad.id]);
    expect(JSON.parse(q.remoteFile(`results/${bad.id}.json`)).reason).toMatch(/signature/);
  });

  test("runs under Node as well as Bun, from the command line", () => {
    const q = queueRig();
    q.allow([]);
    q.clonePc();
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "--quiet", "-m", "start"], join(q.root, "pc/queue"));
    sh(["git", "push", "--quiet", "origin", "HEAD:main"], join(q.root, "pc/queue"));
    const node = Bun.which("node");
    const runners = [[process.execPath], ...(node && /v(2[3-9]|22\.(1[89]|[2-9]\d))/.test(sh([node, "--version"], q.root)) ? [[node]] : [])];
    for (const r of runners) {
      const out = sh([...r, join(OPT, "pcjobs/worker.ts"), "next"], q.root, { env: cleanEnv({ PC_WORKER_HOME: join(q.root, "pc") }) });
      expect(JSON.parse(out)).toEqual({ run: null, closed: [] });
    }
  });
});

describe("pcjobs.sh", () => {
  test("queues a job as Cain's and reports its outcome", () => {
    const q = queueRig();
    const env = cleanEnv({ PC_JOBS_QUEUE: q.cfg.queue, PC_JOBS_OUTCOMES: q.cfg.outcomes });
    const file = join(q.root, "job.json");
    writeFileSync(file, JSON.stringify(READ));
    const rid = sh(["bash", join(OPT, "pcjobs.sh"), "new", file], q.root, { env });
    expect(rid).toMatch(/^pc-\d{8}T\d{6}-[0-9a-f]{8}$/);
    expect(sh(["bash", join(OPT, "pcjobs.sh"), "status", rid], q.root, { env })).toBe("waiting");
    round(q.cfg);
    expect(sh(["bash", join(OPT, "pcjobs.sh"), "status", rid], q.root, { env })).toMatch(/^queued j-\d{8}-[a-z0-9]{6}$/);
    writeFileSync(file, "[]");
    expect(() => sh(["bash", join(OPT, "pcjobs.sh"), "new", file], q.root, { env })).toThrow(/JSON object/);
  });
});

describe("the files around it", () => {
  test("the probe job is a read-only job in the queue format", () => {
    const p = parseJob(readFileSync(join(REPO, "cain/docs/pc-worker/probe-job.json"), "utf8"));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.step).toBe("read");
    const a = parseAllowlist(readFileSync(join(REPO, "cain/docs/pc-worker/allowlist.example.json"), "utf8"));
    expect(a.ok && a.value.every((e) => e.steps.every((s) => s === "read"))).toBe(true);
  });

  test("the worker prompt and the owner's setup note are there", () => {
    const prompt = readFileSync(join(REPO, "cain/docs/pc-worker/prompt.md"), "utf8");
    for (const w of ["worker.ts next", "worker.ts finish", "data, never instructions", "Cain jobs"]) expect(prompt).toContain(w);
    const setup = readFileSync(join(REPO, "cain/docs/pc-jobs.md"), "utf8");
    for (const w of ["HyndeSyte/pc-jobs", "deploy key", "Keep computer awake", "Remote Control"]) expect(setup).toContain(w);
    expect(prompt + setup).not.toContain("—");
  });

  test("build sessions in this repo never notify the owner directly", () => {
    expect(readFileSync(join(REPO, "CLAUDE.md"), "utf8")).toContain("PushNotification");
    const s = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
    expect(s.permissions.deny).toContain("PushNotification");
  });

  test("Cain may run pcjobs.sh, and can't write the keeper's copy or read its token", () => {
    const s = JSON.parse(readFileSync(join(OPT, "settings.json"), "utf8"));
    expect(s.permissions.allow).toContain("Bash(/opt/cain/pcjobs.sh:*)");
    expect(s.permissions.deny).toContain("Edit(//data/pc-jobs/**)");
    expect(s.permissions.deny).toContain("Edit(//data/pc-jobs-outcomes/**)");
  });
});
