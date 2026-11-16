// Owner reuse with provenance Cain can't forge: a PC job may carry a value an earlier
// result reported only when its owner_reuse names the Discord message of his yes, and the
// link (link/core.ts reuseProof) finds that message is his recorded "Use it" tap on an ask
// that quoted exactly those values when posted. A reply he typed never counts. The keeper
// (pcjobs/main.ts check) refuses the job otherwise, fail closed, and one tap answers for one
// job across restarts and crashes (main.ts usedReuse: written as pending before the push,
// finalised after, settled from the queue at the start of each round).
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { jobText, parseJob, REUSE_SHAPE, resultText, type Job, type OwnerReuse, type Result } from "../rootfs/opt/cain/pcjobs/core.ts";
import { cleared, linkNotify, noticeTrouble, queuedOf, resendOwed, tell, whatOf, check, fsyncDir, PENDING_STATUS, PUSH_TRIES, pushAnswer, readJobs, reconcileReuse, recordReuse, reuseAnswer, reuseLedger, round, SPENT_WHY, usedReuse, type Config, type ReuseCheck } from "../rootfs/opt/cain/pcjobs/main.ts";
import { DM, rig } from "./link-rig";
import { askValues, PC_NOTICES, pcQueuedWords } from "../rootfs/opt/cain/link/core";
import { linkFetch } from "../rootfs/opt/cain/link/http";

const VALUE = "****plnt";
const ASKED = `Check the account the PC reported, "${VALUE}", in a new job?`;

// One of Cain's asks, posted: its Discord message id.
async function asked(r: ReturnType<typeof rig>, text = ASKED, options = ["Use it", "Don't"]): Promise<string> {
  const a: any = await r.link.ask({ text, options, item: "P08", question: "Q2" });
  expect(a.status).toBe("posted");
  return a.message;
}
const tapOn = (r: ReturnType<typeof rig>, id: string, i: number, over: any = {}) => r.tap(r.msg(id), r.ids(id)[i], over);

describe("the link: only his \"Use it\" tap on an ask that quoted exactly the values is a yes (reuseProof)", () => {
  test("his tap on Use it, the first option of an ask that quoted the value, is his yes, for exactly the values asked", async () => {
    const r = rig();
    const id = await asked(r);
    expect(r.state().messages[id].values).toEqual([VALUE]);                    // the link recorded the values asked
    expect(await tapOn(r, id, 0)).toBe("to Cain");
    expect(await r.link.reuseProof(id, [VALUE])).toEqual({ status: "ok", message: id, via: "tap", ask: id, values: [VALUE] });
    // Exactly the values the ask quoted: no more, no fewer, no other spelling.
    await expect(r.link.reuseProof(id, [VALUE, "https://example.com/account/security"])).rejects.toThrow("aren't exactly the ones that ask quoted");
    await expect(r.link.reuseProof(id, ["****PLNT"])).rejects.toThrow("aren't exactly the ones that ask quoted");
    await expect(r.link.reuseProof(id, ["Use it"])).rejects.toThrow("aren't exactly the ones that ask quoted");
    // Two values asked: both, in either order, but never one alone.
    const two = await asked(r, `Check "${VALUE}" and "https://example.com/account/security" in a new job?`);
    await tapOn(r, two, 0);
    expect(await r.link.reuseProof(two, ["https://example.com/account/security", VALUE])).toMatchObject({ status: "ok", via: "tap" });
    await expect(r.link.reuseProof(two, [VALUE])).rejects.toThrow("aren't exactly the ones that ask quoted");
    await expect(r.link.reuseProof(two, [VALUE, VALUE])).rejects.toThrow("aren't exactly the ones that ask quoted");
  });

  test("a tap on another option, no tap yet, a tap by anyone else, or a first option that isn't Use it is not", async () => {
    const r = rig();
    const no = await asked(r);
    await tapOn(r, no, 1);
    await expect(r.link.reuseProof(no, [VALUE])).rejects.toThrow('tapping "Don\'t", not its first option "Use it"');
    const open = await asked(r, `Check "${VALUE}" now?`);
    await expect(r.link.reuseProof(open, [VALUE])).rejects.toThrow("no tap of his is recorded");
    expect(await tapOn(r, open, 0, { user: { id: "333" } })).toBe("refused: not the owner");
    await expect(r.link.reuseProof(open, [VALUE])).rejects.toThrow("no tap of his is recorded");
    // Answered in words (keeper.sh answered): no tap, so no yes.
    await r.link.answered({ item: "P08", question: "Q2" });
    await expect(r.link.reuseProof(open, [VALUE])).rejects.toThrow("no tap of his is recorded");
    // A first option other than "Use it" doesn't approve a reuse, even tapped.
    const sure = await asked(r, `Check "${VALUE}" in a new job?`, ["Sure", "Don't"]);
    await tapOn(r, sure, 0);
    await expect(r.link.reuseProof(sure, [VALUE])).rejects.toThrow('not its first option "Use it"');
  });

  test("an ask that quoted no value proves nothing, even on his tap", async () => {
    const r = rig();
    const id = await asked(r, `Check the account the PC reported, ${VALUE}, in a new job?`);   // shown, but not quoted
    await tapOn(r, id, 0);
    await expect(r.link.reuseProof(id, [VALUE])).rejects.toThrow("quoted no value when it was posted");
  });

  test("a reply he typed never authorises, even one that quotes the value, replies to the ask or follows it", async () => {
    const r = rig();
    const id = await asked(r);
    const reply = r.his(`Yes, check "${VALUE}"`, id);
    await expect(r.link.reuseProof(reply.id, [VALUE])).rejects.toThrow("only his \"Use it\" tap on your ask approves a reuse, never a message he typed");
    const after = r.his(`go ahead with ${VALUE}`);
    await expect(r.link.reuseProof(after.id, [VALUE])).rejects.toThrow("never a message he typed");
    // Even after his tap on that very ask, his reply's own id isn't the yes: the ask's is.
    await tapOn(r, id, 0);
    await expect(r.link.reuseProof(reply.id, [VALUE])).rejects.toThrow("never a message he typed");
    expect(await r.link.reuseProof(id, [VALUE])).toMatchObject({ status: "ok", via: "tap", ask: id });
    // A message by anyone else, or the bot's own reply, likewise.
    const theirs = r.his(`Yes, check ${VALUE}`, id);
    r.posted[theirs.id].author = { id: "333" };
    await expect(r.link.reuseProof(theirs.id, [VALUE])).rejects.toThrow("never a message he typed");
  });

  test("words after he tapped no are still a no", async () => {
    const r = rig();
    const id = await asked(r);
    await tapOn(r, id, 1);
    const reply = r.his(`fine, "${VALUE}"`, id);
    await expect(r.link.reuseProof(reply.id, [VALUE])).rejects.toThrow("never a message he typed");
    await expect(r.link.reuseProof(id, [VALUE])).rejects.toThrow("not its first option");
  });

  test("a card of the link's, bad ids or values, a pairing with someone else and Discord down all refuse", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: `Moved "${VALUE}".`, rows: [], kind: "reply" });
    const shown = await r.link.show(card, { item: "none" });
    await expect(r.link.reuseProof(shown, [VALUE])).rejects.toThrow("a card of the link's");
    await expect(r.link.reuseProof("12", [VALUE])).rejects.toThrow("needs a Discord message id");
    const early = r.his(`check ${VALUE}`);
    await expect(r.link.reuseProof(early.id, [])).rejects.toThrow("1 to 3 values");
    await expect(r.link.reuseProof(early.id, ["abc"])).rejects.toThrow("1 to 3 values");
    await expect(r.link.reuseProof(early.id, [VALUE, "bbbb", "cccc", "dddd"])).rejects.toThrow("1 to 3 values");
    await expect(r.link.reuseProof(early.id, "x")).rejects.toThrow("1 to 3 values");
    const id = await asked(r);
    await tapOn(r, id, 0);
    const other = rig({ paired: "777" });
    await expect(other.link.reuseProof(id, [VALUE])).rejects.toThrow("paired with someone other");
    r.failing.add(`/channels/${DM}/messages/`);
    await expect(r.link.reuseProof(id, [VALUE])).rejects.toThrow("discord 500");
    r.failing.clear();
    r.refusing.add(`/channels/${DM}/messages/`);
    await expect(r.link.reuseProof(id, [VALUE])).rejects.toThrow();
  });

  test("askValues: the straight-quoted values of an ask, at most three", () => {
    expect(askValues(ASKED)).toEqual([VALUE]);
    expect(askValues(`a "abc" b`)).toEqual([]);
    expect(askValues(`"aaaa" "bbbb" "cccc" "dddd"`)).toEqual([]);
    expect(askValues(`\u201c${VALUE}\u201d`)).toEqual([]);
  });
});

// ---- the keeper -----------------------------------------------------------------------
const T0 = new Date("2026-11-15T14:00:00.000Z");
const MSG = "1300000000000000001";
const READ = { site: "example.com", action: "read_account_settings", step: "read",
  start_url: "https://example.com/account/settings", done_looks_like: "The settings page is open and its state is reported" };
const GO = "“Use it: check the account the PC reported”";
const reuse = (over: Partial<OwnerReuse> = {}): OwnerReuse => ({ values: [VALUE], go: GO, message_id: MSG, ...over });

// A queue copy with one finished read whose result reported the account VALUE.
function queue(extra: Job[] = []): { cfg: Config; jobs: Job[] } {
  const dir = mkdtempSync(join(tmpdir(), "pcjobs-reuse-"));
  mkdirSync(join(dir, "jobs")); mkdirSync(join(dir, "results"));
  const done: Job = { v: 1, id: "j-20261115-done01", from: "cain", created: T0.toISOString(), expires: new Date(T0.getTime() + 86_400_000).toISOString(),
    state: "done", lease_until: null, attempt: "a-0123456789", ...READ, step: "read", follows: null, preview_seen: null, owner_go: null, go_token: null, owner_reuse: null } as Job;
  const r: Result = { v: 1, id: done.id, attempt: "a-0123456789", status: "done", code: "ok", handoff: null, worker_clock: T0.toISOString(),
    final_url: null, facts: { signed_in: true, account: VALUE }, tools: [], attended: true };
  for (const j of [done, ...extra]) writeFileSync(join(dir, "jobs", `${j.id}.json`), jobText(j));
  writeFileSync(join(dir, "results", `${done.id}.json`), resultText(r));
  const cfg: Config = { remote: "", dir, queue: join(dir, "q"), outcomes: join(dir, "o"), branch: "main", pub: "", rand: () => 0.5, used: join(dir, "state", "reuse-used.jsonl") };
  return { cfg, jobs: readJobs(dir) };
}
const ask = (job: any) => JSON.stringify({ from: "cain", job });
const yes: ReuseCheck = () => ({ ok: true, via: "tap" });

describe("the keeper: owner_reuse is taken only with the link's proof", () => {
  test("a job carrying a reported value: refused bare, refused with the old shape, queued once the link finds his yes", () => {
    const { cfg, jobs } = queue();
    expect(jobs.length).toBe(1);
    const carry = { ...READ, done_looks_like: `The settings page for ${VALUE}` };
    const seen: OwnerReuse[] = [];
    const stub = (v: ReturnType<ReuseCheck>): ReuseCheck => (r) => { seen.push(r); return v; };
    // No owner_reuse: the report-value refusal, which now names the message id.
    expect(check({ ...cfg, verifyReuse: yes }, ask(carry), jobs, T0)).toEqual({ why: expect.stringContaining("record his yes as owner_reuse with its Discord message id") });
    // The old shape ({values, go}, Cain's word alone): refused before the link is asked.
    const old = check({ ...cfg, verifyReuse: stub({ ok: true, via: "tap" }) }, ask({ ...carry, owner_reuse: { values: [VALUE], go: GO } }), jobs, T0);
    expect(old).toEqual({ why: `${REUSE_SHAPE}; without his message's id it is refused` });
    expect(seen).toEqual([]);
    for (const bad of [{ message_id: "12" }, { message_id: 1300000000000000001 as any }, { message_id: `${MSG}x` }]) {
      expect(check({ ...cfg, verifyReuse: yes }, ask({ ...carry, owner_reuse: reuse(bad) }), jobs, T0)).toEqual({ why: expect.stringContaining("without his message's id") });
    }
    // The link refuses: so does the keeper, with the link's reason and what reuse needs.
    const refused = check({ ...cfg, verifyReuse: stub({ ok: false, why: "the link says his message doesn't show every value exactly as written" }) },
      ask({ ...carry, owner_reuse: reuse() }), jobs, T0);
    expect(refused).toEqual({ why: "owner_reuse refused: the link says his message doesn't show every value exactly as written. Reuse needs his \"Use it\" tap on your ask that quotes each value; a reply he types never counts" });
    expect(seen).toEqual([reuse()]);
    // A verifier that throws counts as a refusal.
    expect(check({ ...cfg, verifyReuse: () => { throw new Error("boom"); } }, ask({ ...carry, owner_reuse: reuse() }), jobs, T0))
      .toEqual({ why: expect.stringContaining("owner_reuse refused: the link couldn't check it") });
    // The link finds his yes: queued, the job file keeping the message id.
    const ok = check({ ...cfg, verifyReuse: stub({ ok: true, via: "tap" }) }, ask({ ...carry, owner_reuse: reuse() }), jobs, T0);
    expect(ok).toMatchObject({ job: { owner_reuse: reuse(), done_looks_like: carry.done_looks_like } });
    expect(parseJob(jobText((ok as { job: Job }).job)).ok).toBe(true);
  });

  test("one message of his answers for one job: a second job naming it is refused without asking the link", () => {
    const { cfg, jobs } = queue();
    const carry = { ...READ, done_looks_like: `The settings page for ${VALUE}` };
    const first = check({ ...cfg, verifyReuse: yes }, ask({ ...carry, owner_reuse: reuse() }), jobs, T0) as { job: Job };
    let asked = 0;
    const again = check({ ...cfg, verifyReuse: () => { asked++; return { ok: true, via: "tap" }; } }, ask({ ...carry, owner_reuse: reuse() }), [...jobs, first.job], T0);
    expect(again).toEqual({ why: `owner_reuse refused: that tap of his already answered for ${first.job.id}; ask him again for this job` });
    expect(asked).toBe(0);
  });

  test("a reply quoting the value is refused; the tap is accepted once; a second job citing the same tap is refused, across a keeper restart", async () => {
    const r = rig();
    const id = await asked(r);
    const reply = r.his(`Yes, check "${VALUE}"`, id);
    await tapOn(r, id, 0);
    // The keeper's check against the link itself (the rig's), as linkReuse asks it.
    const viaLink = (seen: string[]): ReuseCheck => (x) => { seen.push(x.message_id); return reuseCalls.get(x.message_id) ?? { ok: false, why: "the link couldn't check it" }; };
    const reuseCalls = new Map<string, ReturnType<ReuseCheck>>();
    for (const m of [id, reply.id]) {
      try { reuseCalls.set(m, reuseAnswer(reuse({ message_id: m }), JSON.stringify(await r.link.reuseProof(m, [VALUE])))); }
      catch (e) { reuseCalls.set(m, { ok: false, why: `the link says ${(e as Error).message}` }); }
    }
    const { cfg, jobs } = queue();
    const carry = { ...READ, done_looks_like: `The settings page for ${VALUE}` };
    const seen: string[] = [];
    // His typed reply, even quoting the value: refused.
    expect(check({ ...cfg, verifyReuse: viaLink(seen) }, ask({ ...carry, owner_reuse: reuse({ message_id: reply.id }) }), jobs, T0))
      .toEqual({ why: expect.stringContaining("never a message he typed") });
    // The tap: accepted once.
    const first = check({ ...cfg, verifyReuse: viaLink(seen) }, ask({ ...carry, owner_reuse: reuse({ message_id: id }) }), jobs, T0) as { job: Job };
    expect(first.job.owner_reuse?.message_id).toBe(id);
    recordReuse(cfg, id, first.job.id);                                          // round() writes it (pending before the push, final after)
    // A keeper restart: a fresh copy of the queue without that job file, the same used-tap file. The tap stays spent.
    const fresh = queue();
    const restarted: Config = { ...fresh.cfg, used: cfg.used };
    expect(usedReuse(restarted).get(id)).toBe(first.job.id);
    const n = seen.length;
    expect(check({ ...restarted, verifyReuse: viaLink(seen) }, ask({ ...carry, owner_reuse: reuse({ message_id: id }) }), fresh.jobs, T0))
      .toEqual({ why: `owner_reuse refused: that tap of his already answered for ${first.job.id}; ask him again for this job` });
    expect(seen.length).toBe(n);                                                 // refused before the link is asked
    // The file is only appended to: a torn last line doesn't lose the taps before it.
    appendFileSync(cfg.used!, "{\"m\": \"13");
    expect(usedReuse(restarted).get(id)).toBe(first.job.id);
  });

  test("a link answer that says reply, or any way but tap, is refused by the keeper", () => {
    const { cfg, jobs } = queue();
    const carry = { ...READ, done_looks_like: `The settings page for ${VALUE}` };
    expect(check({ ...cfg, verifyReuse: () => ({ ok: true, via: "reply" }) }, ask({ ...carry, owner_reuse: reuse() }), jobs, T0))
      .toEqual({ why: expect.stringContaining("only his \"Use it\" tap counts, never a message he typed") });
  });

  test("owner_reuse on a job that carries nothing reported is checked all the same", () => {
    const { cfg, jobs } = queue();
    expect(check({ ...cfg, verifyReuse: () => ({ ok: false, why: "the link didn't answer" }) }, ask({ ...READ, owner_reuse: reuse() }), jobs, T0))
      .toEqual({ why: expect.stringContaining("owner_reuse refused: the link didn't answer") });
    expect(check({ ...cfg, verifyReuse: yes }, ask({ ...READ, owner_reuse: null }), jobs, T0)).toMatchObject({ job: { owner_reuse: null } });
  });

  test("the link's answer is read strictly: this message, these values, a known way", () => {
    const r = reuse({ values: [VALUE, "https://example.com/account/security"] });
    const good = { status: "ok", message: MSG, via: "tap", ask: MSG, values: r.values };
    expect(reuseAnswer(r, JSON.stringify(good))).toEqual({ ok: true, via: "tap" });
    for (const bad of [{ ...good, message: "1300000000000000002" }, { ...good, values: [VALUE] }, { ...good, values: [...r.values].reverse() },
      { ...good, via: "said so" }, { ...good, via: "reply" }, { ...good, ask: "1300000000000000000" }, { ...good, status: "posted" }, { status: "refused" }, "not json"])
      expect([bad, reuseAnswer(r, typeof bad === "string" ? bad : JSON.stringify(bad)).ok]).toEqual([bad, false]);
    expect(reuseAnswer(r, JSON.stringify({ status: "refused", said: "that isn't one of his messages in your DM" })))
      .toEqual({ ok: false, why: "the link says that isn't one of his messages in your DM" });
  });
});

// The keeper's real check (linkReuse: curl to the link's /reuse, keyed) against the link
// itself in the rig, behind an HTTP front that checks the key as link/main.ts does. The
// keeper's round is synchronous, so its side runs in a child process.
describe("the keeper asks the link over its local API", () => {
  const ready = !!Bun.which("curl");
  test.skipIf(!ready)("his tap passes, a refusal comes back with the link's reason, a wrong key or no link refuses", async () => {
    const TOKEN = "not-a-real-token.for-the-reuse-test";
    const dir = mkdtempSync(join(tmpdir(), "pcjobs-reuse-env-"));
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "wrong.env"), "DISCORD_BOT_TOKEN=some-other-token\n");
    const key = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
    const r = rig();
    const id = await asked(r);
    await tapOn(r, id, 0);
    const hits: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      hits.push(new URL(req.url).pathname);
      if (req.headers.get("x-harness-key") !== key) return Response.json({ status: "refused" }, { status: 403 });
      const b: any = await req.json();
      try { return Response.json(await r.link.reuseProof(b.m, b.values)); }
      catch (e) { return Response.json({ status: "refused", said: (e as Error).message }, { status: 400 }); }
    } });
    const main = join(import.meta.dir, "../rootfs/opt/cain/pcjobs/main.ts");
    const run = async (envFile: string, link: string, m: string, values: string[]) => {
      const code = `const { linkReuse } = await import(${JSON.stringify(main)});
        console.log(JSON.stringify(linkReuse({ link: ${JSON.stringify(link)}, discordEnv: ${JSON.stringify(envFile)} })({ values: ${JSON.stringify(values)}, go: "\\u201cUse it\\u201d", message_id: ${JSON.stringify(m)} })));`;
      const p = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      await p.exited;
      return JSON.parse(out.split("\n").at(-1)!);
    };
    const url = `http://127.0.0.1:${server.port}`;
    try {
      expect(await run(join(dir, ".env"), url, id, [VALUE])).toEqual({ ok: true, via: "tap" });
      expect(await run(join(dir, ".env"), url, id, [`${VALUE}"x\\y`])).toEqual({ ok: false, why: "the link says the values aren't exactly the ones that ask quoted when it was posted" });
      expect(await run(join(dir, "wrong.env"), url, id, [VALUE])).toEqual({ ok: false, why: "the link couldn't check it" });
      expect(await run(join(dir, "none.env"), url, id, [VALUE])).toEqual({ ok: false, why: "no bot token here, so the link can't be asked" });
      expect(hits).toEqual(["/reuse", "/reuse", "/reuse"]);
    } finally { server.stop(true); }
    expect(await run(join(dir, ".env"), url, id, [VALUE])).toEqual({ ok: false, why: "the link didn't answer" });
  }, 30_000);
});

// ---- The keeper's used-tap store, against a real git remote ------------------------------
const WIN = process.platform === "win32";
const git = (args: string[], cwd: string) => { const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(p.stderr.toString()); return p.stdout.toString(); };
// A real queue: a bare repository, the keeper's copies, its request folder, its used-tap file and the notices it sent.
const world = () => {
  const root = mkdtempSync(join(tmpdir(), "pcjobs-tap-"));
  const remote = join(root, "pc-jobs.git");
  git(["init", "--quiet", "--bare", "-b", "main", remote], root);
  const used = join(root, "state", "reuse-used.jsonl");
  const told: string[] = [];
  const cfg = (copy: string, over: Partial<Config> = {}): Config => ({ remote, dir: join(root, copy), queue: join(root, "queue"), outcomes: join(root, "outcomes"),
    branch: "main", pub: "", now: () => T0, used, verifyReuse: yes, pushWaitMs: 10, notify: (c) => { told.push(c); return true; }, ...over });
  mkdirSync(join(root, "queue"), { recursive: true });
  let n = 0;
  const request = (job: any) => { const rid = `pc-${String(++n).padStart(4, "0")}`; writeFileSync(join(root, "queue", `${rid}.json`), ask(job)); return rid; };
  const outcome = (rid: string) => { try { return JSON.parse(readFileSync(join(root, "outcomes", `${rid}.json`), "utf8")); } catch { return null; } };
  const clone = () => { const c = join(root, `look-${++n}`); git(["clone", "--quiet", remote, c], root); return c; };
  const lines = () => readFileSync(used, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // The settled states written (pending lines, push records and answers left out).
  const settles = () => lines().filter((l) => l.state !== "pending").map((l) => l.settled ? `${l.state}:${l.settled}` : l.state);
  const hook = (body: string) => { const h = join(remote, "hooks", "pre-receive"); writeFileSync(h, `#!/bin/sh\n${body}\n`); chmodSync(h, 0o755); return h; };
  const first = () => { request({ ...READ }); expect(round(cfg("pi-1"))).toMatchObject({ ok: true, queued: 1 }); };   // the branch exists first
  // The keeper killed after the push went through, before the answer was written (so only the commit records it).
  const killedMidPush = () => {
    first();
    const rid = request({ ...READ, owner_reuse: reuse() });
    expect(round(cfg("pi-1", { onPushAnswer: () => { throw new Error("killed"); } })).ok).toBe(false);
    const l = reuseLedger({ used }).get(MSG)!;
    expect(l).toMatchObject({ state: "pending", rid, attempts: [{ commit: expect.stringMatching(/^[0-9a-f]{40}$/) }] });
    expect(l.attempts[0].answer).toBeUndefined();
    return { rid, job: l.job, commit: l.commit! };
  };
  // The worker side: a fresh, unrelated history pushed over the branch (a rewrite).
  const rewrite = (files: Record<string, string>) => {
    const pc = clone();
    git(["checkout", "--quiet", "--orphan", "fresh"], pc);
    git(["rm", "-r", "--quiet", "--cached", "."], pc);
    for (const d of ["jobs", "results", "worker"]) rmSync(join(pc, d), { recursive: true, force: true });
    writeFileSync(join(pc, ".gitattributes"), "* text eol=lf\n");
    for (const [f, t] of Object.entries(files)) { mkdirSync(join(pc, f, ".."), { recursive: true }); writeFileSync(join(pc, f), t); }
    git(["add", "-A"], pc);
    git(["commit", "--quiet", "-m", "rewritten"], pc);
    git(["push", "--quiet", "--force", "origin", "HEAD:main"], pc);
  };
  return { root, remote, used, told, cfg, request, outcome, clone, lines, settles, hook, first, killedMidPush, rewrite };
};
// A replay of the same tap, for another job: refused, by the store alone.
const replayRefused = (w: ReturnType<typeof world>, job: string) => {
  expect(check(w.cfg("pi-x"), ask({ ...READ, owner_reuse: reuse() }), [], T0)).toEqual({ why: `owner_reuse refused: that tap of his already answered for ${job}; ask him again for this job` });
};

describe("the used-tap store: written before every push attempt, each answer after, settled at start", () => {
  test("the keeper killed between the push and the finalise: on restart the tap is settled from the queue, and replaying it is refused", () => {
    const w = world();
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    expect(round(w.cfg("pi-1", { afterPush: () => { throw new Error("killed"); } })).ok).toBe(false);
    const [pushed] = readJobs(w.clone());
    expect(pushed.owner_reuse?.message_id).toBe(MSG);
    // On disk: pending, with its job, request, the commit pushed and the remote's answer.
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject({ m: MSG, job: pushed.id, state: "pending", rid, attempts: [{ commit: expect.stringMatching(/^[0-9a-f]{40}$/), answer: "ok" }] });
    expect(w.lines().map((l) => l.ev)).toEqual(["push", "answer"]);
    expect(usedReuse({ used: w.used }).get(MSG)).toBe(pushed.id);                 // a pending tap is spent already
    expect(w.outcome(rid)).toBeNull();
    const again = w.cfg("pi-2");
    expect(round(again)).toMatchObject({ ok: true });
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject({ job: pushed.id, state: "final" });
    expect(w.outcome(rid)).toEqual({ request: rid, state: "queued", id: pushed.id });
    const replay = w.request({ ...READ, owner_reuse: reuse() });
    expect(round(again)).toMatchObject({ ok: true, refused: 1, queued: 0 });
    expect(w.outcome(replay)).toEqual({ request: replay, state: "refused", reason: `owner_reuse refused: that tap of his already answered for ${pushed.id}; ask him again for this job` });
    replayRefused(w, pushed.id);
    expect(readJobs(w.clone()).length).toBe(1);
  });

  test("lines without a state are final; a rolled-back tap is free again", () => {
    const { cfg } = queue();
    mkdirSync(join(cfg.dir, "state"), { recursive: true });
    writeFileSync(cfg.used!, JSON.stringify({ m: MSG, job: "j-20261115-aaaaaa" }) + "\n");
    expect(reuseLedger(cfg).get(MSG)).toMatchObject({ state: "final" });
    recordReuse(cfg, "123456789012345678", "j-20261115-bbbbbb", "pending", "pc-0001", "b".repeat(40));
    expect(usedReuse(cfg).get("123456789012345678")).toBe("j-20261115-bbbbbb");
    recordReuse(cfg, "123456789012345678", "j-20261115-bbbbbb", "rolled_back");
    expect(usedReuse(cfg).has("123456789012345678")).toBe(false);
    expect(usedReuse(cfg).get(MSG)).toBe("j-20261115-aaaaaa");
  });

  test("the remote's answer is read as ok, refused (its words kept) or unknown", () => {
    expect(pushAnswer(0, "", false)).toMatchObject({ answer: "ok" });
    expect(pushAnswer(1, "!\tHEAD:refs/heads/main\t[remote rejected] (pre-receive hook declined)", false)).toMatchObject({ answer: "refused", nonFastForward: false, said: expect.stringContaining("pre-receive hook declined") });
    expect(pushAnswer(1, "!\tHEAD:refs/heads/main\t[rejected] (fetch first)", false)).toMatchObject({ answer: "refused", nonFastForward: true });
    // Not git's porcelain line for the ref (twentieth round): unknown, never refused.
    expect(pushAnswer(1, "! [rejected] HEAD -> main (non-fast-forward)", false)).toMatchObject({ answer: "unknown", nonFastForward: false });
    expect(pushAnswer(null, "", true)).toMatchObject({ answer: "unknown", said: "no answer in time" });
    expect(pushAnswer(128, "fatal: unable to access 'https://github.com/x/y.git/': Connection reset by peer", false)).toMatchObject({ answer: "unknown" });
    expect(pushAnswer(1, "something else entirely", false)).toMatchObject({ answer: "unknown" });
  });

  test("the store's folder is flushed to disk when the store is made (and every folder made for it); a folder that can't be flushed throws", () => {
    const root = mkdtempSync(join(tmpdir(), "pcjobs-fsync-"));
    const used = join(root, "a", "b", "reuse-used.jsonl");
    recordReuse({ used }, MSG, "j-20261115-aaaaaa", "pending", "pc-0001", "a".repeat(40));
    expect(reuseLedger({ used }).get(MSG)).toMatchObject({ state: "pending", commit: "a".repeat(40) });
    if (!WIN) expect(() => fsyncDir(join(root, "missing"))).toThrow();
    expect(() => fsyncDir(join(root, "missing"), "win32")).not.toThrow();      // Windows can't open a folder to flush it
  });
});

describe("nineteenth review: a tap rolls back only on a record that every push of it was refused; absence of evidence keeps it spent", () => {
  test("a job accepted and consumed, then the commit and every record rewritten away, then a restart: spent, never rolled back", () => {
    const w = world();
    const { job, rid } = w.killedMidPush();
    // The worker took the job and wrote its record; then the branch was rewritten without any of it.
    w.rewrite({ "worker/heartbeat.json": "{}\n" });
    expect(round(w.cfg("pi-2")).ok).toBe(true);
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject({ job, state: "final", settled: "spent" });
    expect(w.settles()).toEqual(["final:spent"]);
    expect(w.outcome(rid)).toEqual({ request: rid, state: "refused", reason: `owner_reuse refused: ${SPENT_WHY}` });
    replayRefused(w, job);
    expect(readJobs(w.clone()).some((j) => j.owner_reuse)).toBe(false);          // nothing queued a second time
  });

  test("the report pruned before the restart: spent", () => {
    const w = world();
    const { job } = w.killedMidPush();
    // The worker moved the job into a report, then the report was pruned and the history squashed.
    const pc = w.clone();
    git(["rm", "--quiet", `jobs/${job}.json`], pc);
    mkdirSync(join(pc, "results"), { recursive: true });
    writeFileSync(join(pc, "results", `${job}.json`), JSON.stringify({ id: job, status: "done" }) + "\n");
    git(["add", "-A"], pc); git(["commit", "--quiet", "-m", "report"], pc); git(["push", "--quiet", "origin", "HEAD:main"], pc);
    w.rewrite({});
    expect(round(w.cfg("pi-2")).ok).toBe(true);
    expect(w.settles()).toEqual(["final:spent"]);
    replayRefused(w, job);
  });

  test("a non-fast-forward refusal, then a rebased push that lands, then a restart: landed (final) on the rebased commit alone", () => {
    const w = world();
    w.first();
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    let n = 0;
    const cfg = w.cfg("pi-1", {
      // Before the keeper's first push, the worker pushes a commit of its own: the keeper's is now behind.
      beforePush: () => { if (n++ === 0) { const pc = w.clone(); mkdirSync(join(pc, "worker"), { recursive: true }); writeFileSync(join(pc, "worker", "heartbeat.json"), "{}\n"); git(["add", "-A"], pc); git(["commit", "--quiet", "-m", "beat"], pc); git(["push", "--quiet", "origin", "HEAD:main"], pc); } },
      // Killed after the second (rebased) push went through, before its answer was written.
      onPushAnswer: () => { if (n === 2) throw new Error("killed"); },
    });
    expect(round(cfg).ok).toBe(false);
    const l = reuseLedger({ used: w.used }).get(MSG)!;
    expect(l.attempts.length).toBe(2);
    expect(l.attempts[0]).toMatchObject({ answer: "refused", said: expect.stringMatching(/fetch first|non-fast-forward|rejected/) });
    expect(l.attempts[1].answer).toBeUndefined();
    expect(l.attempts[1].commit).not.toBe(l.attempts[0].commit);                 // the rebased commit, recorded before its push
    // The worker consumes the job: its file goes, so only the rebased commit in the branch shows it landed.
    const pc = w.clone();
    git(["rm", "--quiet", `jobs/${l.job}.json`], pc); git(["commit", "--quiet", "-m", "took it"], pc); git(["push", "--quiet", "origin", "HEAD:main"], pc);
    expect(round(w.cfg("pi-2")).ok).toBe(true);
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject({ job: l.job, state: "final" });
    expect(w.settles()).toEqual(["final"]);
    expect(w.outcome(rid)).toEqual({ request: rid, state: "queued", id: l.job });
  });

  test("three recorded refusals, then a restart: rolled back exactly once, the owner told once, a replay meanwhile refused as pending", () => {
    if (WIN) return;                                                               // the refusing hook is a shell script
    const w = world();
    w.first();
    const count = join(w.root, "pushes");
    const h = w.hook(`echo x >> "${count}"\nexit 1`);
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    expect(round(w.cfg("pi-1")).ok).toBe(false);
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(PUSH_TRIES);
    const pending = reuseLedger({ used: w.used }).get(MSG)!;
    expect(pending.attempts.map((a) => a.answer)).toEqual(["refused", "refused", "refused"]);
    expect(w.told).toEqual(["reuse_push_refused"]);
    // A replay meanwhile: refused with the same pending status.
    expect(check(w.cfg("pi-1"), ask({ ...READ, owner_reuse: reuse() }), [], T0)).toEqual({ why: `owner_reuse refused: that tap of his answered for ${pending.job} and is ${PENDING_STATUS}` });
    rmSync(h);
    // Settled on the very next round of the same keeper (no restart), once its fetch shows none of the commits.
    expect(round(w.cfg("pi-1"))).toMatchObject({ ok: true, queued: 1 });
    const now = reuseLedger({ used: w.used }).get(MSG)!;
    expect(now).toMatchObject({ state: "final" });
    expect(now.job).not.toBe(pending.job);
    expect(w.settles()).toEqual(["rolled_back", "final"]);
    expect(w.outcome(rid)).toEqual({ request: rid, state: "queued", id: now.job });
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.settles().filter((x) => x === "rolled_back").length).toBe(1);
    expect(w.told).toEqual(["reuse_push_refused"]);
    expect(PC_NOTICES.reuse_push_refused).toContain("next round with a successful fetch from GitHub");
  });

  test("one unknown answer among the attempts (a push that timed out): spent, never rolled back", () => {
    if (WIN) return;
    const w = world();
    w.first();
    const count = join(w.root, "pushes");
    // The first push hangs past the keeper's time limit; the others are refused.
    const h = w.hook(`echo x >> "${count}"\n[ "$(wc -l < "${count}")" -ge 2 ] || sleep 3\nexit 1`);
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    expect(round(w.cfg("pi-1", { pushTimeoutMs: 700 })).ok).toBe(false);
    expect(reuseLedger({ used: w.used }).get(MSG)!.attempts.map((a) => a.answer)).toEqual(["unknown", "refused", "refused"]);
    expect(w.told).toEqual([]);                                                    // not every try was refused
    Bun.sleepSync(3_000);
    rmSync(h);
    expect(round(w.cfg("pi-2")).ok).toBe(true);
    expect(w.settles()).toEqual(["final:spent"]);
    expect(w.outcome(rid)).toEqual({ request: rid, state: "refused", reason: `owner_reuse refused: ${SPENT_WHY}` });
  }, 20_000);

  test("the bounded retry: a push refused once goes through on the second try, and the tap is final", () => {
    if (WIN) return;
    const w = world();
    w.first();
    const count = join(w.root, "pushes");
    w.hook(`echo x >> "${count}"\n[ "$(wc -l < "${count}")" -ge 2 ] || exit 1\nexit 0`);
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    expect(round(w.cfg("pi-1"))).toMatchObject({ ok: true, queued: 1 });
    expect(w.settles()).toEqual(["final"]);
    const l = reuseLedger({ used: w.used }).get(MSG)!;
    expect(l.attempts.map((a) => a.answer)).toEqual(["refused", "ok"]);
    expect(w.outcome(rid)).toEqual({ request: rid, state: "queued", id: l.job });
  });

  test("a sync that fails: the round stops and the tap stays pending; once GitHub answers it settles", () => {
    const w = world();
    const { job, rid } = w.killedMidPush();
    const away = `${w.remote}.away`;
    renameSync(w.remote, away);
    expect(round(w.cfg("pi-2")).ok).toBe(false);
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject({ job, state: "pending" });
    expect(check(w.cfg("pi-x"), ask({ ...READ, owner_reuse: reuse() }), [], T0)).toEqual({ why: `owner_reuse refused: that tap of his answered for ${job} and is ${PENDING_STATUS}` });
    renameSync(away, w.remote);
    expect(round(w.cfg("pi-3")).ok).toBe(true);
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject({ job, state: "final" });
    expect(w.outcome(rid)).toEqual({ request: rid, state: "queued", id: job });
  });
});

describe("nineteenth review: legacy lines and every stop condition are told to the owner once, scoped to the tap where they can be", () => {
  test("an upgrade from a seventeenth-round store (a pending line without a commit): spent, one migration line, the owner told once", () => {
    const w = world();
    w.first();
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    mkdirSync(join(w.root, "state"), { recursive: true });
    writeFileSync(w.used, JSON.stringify({ m: MSG, job: "j-20261115-old017", state: "pending", rid }) + "\n");
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject({ legacy: true });
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.lines().slice(1)).toEqual([{ m: MSG, job: "j-20261115-old017", state: "final", rid, settled: "spent", migrated: "round17_pending" }]);
    expect(w.outcome(rid)).toEqual({ request: rid, state: "refused", reason: `owner_reuse refused: ${SPENT_WHY}` });
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.lines().length).toBe(2);
    expect(w.told).toEqual(["reuse_migrated"]);
    replayRefused(w, "j-20261115-old017");
  });

  test("a shallow copy: only that tap waits (its request too), other requests go on, the owner told once", () => {
    if (WIN) return;                                                               // a file:// address to a Windows path
    const w = world();
    const { job, rid } = w.killedMidPush();
    // The worker consumes the job over a few commits; the keeper's copy is shallow.
    const pc = w.clone();
    git(["rm", "--quiet", `jobs/${job}.json`], pc); git(["commit", "--quiet", "-m", "took it"], pc);
    for (let i = 0; i < 3; i++) { writeFileSync(join(pc, "beat"), `${i}\n`); git(["add", "-A"], pc); git(["commit", "--quiet", "-m", `beat ${i}`], pc); }
    git(["push", "--quiet", "origin", "HEAD:main"], pc);
    git(["clone", "--quiet", "--depth", "1", `file://${w.remote}`, join(w.root, "pi-2")], w.root);
    const other = w.request({ ...READ, start_url: "https://example.com/account/settings" });
    expect(round(w.cfg("pi-2"))).toMatchObject({ ok: true, queued: 1 });
    expect(w.outcome(other)).toMatchObject({ state: "queued" });
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject({ job, state: "pending" });
    expect(existsSync(join(w.root, "queue", `${rid}.json`))).toBe(true);            // its request waits
    expect(round(w.cfg("pi-2")).ok).toBe(true);
    expect(w.told).toEqual(["reuse_shallow"]);
  });

  test("the queue's branch missing, and an empty remote, with a pending tap: the round stops, the owner told once for each", () => {
    const w = world();
    w.killedMidPush();
    const pc = w.clone();
    git(["push", "--quiet", "origin", "HEAD:other"], pc);
    git(["symbolic-ref", "HEAD", "refs/heads/other"], w.remote);
    git(["push", "--quiet", "origin", "--delete", "main"], pc);
    expect(round(w.cfg("pi-2")).ok).toBe(false);
    expect(round(w.cfg("pi-2")).ok).toBe(false);
    expect(w.told).toEqual(["queue_branch_missing"]);
    rmSync(w.remote, { recursive: true, force: true });
    git(["init", "--quiet", "--bare", "-b", "main", w.remote], w.root);
    expect(round(w.cfg("pi-3")).ok).toBe(false);
    expect(round(w.cfg("pi-3")).ok).toBe(false);
    expect(w.told).toEqual(["queue_branch_missing", "queue_empty_pending"]);
    expect(w.settles()).toEqual([]);                                               // still pending: spent
  });

  test("an unreadable store: reuse requests wait, other jobs go on, the owner told once; a replay is refused", () => {
    const w = world();
    w.first();
    mkdirSync(w.used, { recursive: true });                                         // the store can't be read as a file
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    const other = w.request({ ...READ });
    expect(round(w.cfg("pi-1"))).toMatchObject({ ok: true, queued: 1 });
    expect(w.outcome(other)).toMatchObject({ state: "queued" });
    expect(w.outcome(rid)).toBeNull();
    expect(existsSync(join(w.root, "queue", `${rid}.json`))).toBe(true);
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.told).toEqual(["reuse_store_unreadable"]);
    expect(check(w.cfg("pi-1"), ask({ ...READ, owner_reuse: reuse() }), [], T0)).toEqual({ why: expect.stringContaining("can't read its record of used taps") });
    expect(readJobs(w.clone()).some((j) => j.owner_reuse)).toBe(false);
  });

  test("a pending line that can't be settled (a file in the queue copy that can't be read): only that tap waits, the owner told once", () => {
    if (WIN) return;
    const { cfg } = queue();
    const told: string[] = [];
    const c = { ...cfg, notify: (x: string) => { told.push(x); return true; } } as Config;
    recordReuse(c, MSG, "j-20261115-cccccc", "pending", "pc-0009", "c".repeat(40));
    symlinkSync(join(cfg.dir, "nowhere"), join(cfg.dir, "results", "dangling.json"));
    for (let i = 0; i < 2; i++) expect(reconcileReuse(c, [], "d".repeat(40))).toMatchObject({ unsettled: ["j-20261115-cccccc"] });
    expect(reuseLedger(c).get(MSG)).toMatchObject({ state: "pending" });
    expect(told).toEqual(["reuse_unsettled"]);
  });
});

describe("nineteenth review: the keeper's lines to the owner are the link's own fixed words", () => {
  test("each code posts its words through the gate unchanged; an unknown code is refused; every code the keeper sends has words", async () => {
    const r = rig();
    for (const [code, text] of Object.entries(PC_NOTICES)) {
      const a = await r.link.pcNotice(code);
      expect(a.status).toBe("posted");
      expect(r.posted[a.message].content).toBe(text);
      expect(text).not.toMatch(/\u2014|add-on|j-\d{8}/);
    }
    await expect(r.link.pcNotice("Anything else!")).rejects.toThrow("not a PC job keeper notice");
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/pcjobs/main.ts"), "utf8");
    const codes = src.match(/export type PcNotice = ([^;]+);/)![1].match(/"([a-z_]+)"/g)!.map((x) => x.slice(1, -1));
    expect(codes.sort()).toEqual(Object.keys(PC_NOTICES).sort());
  });
});

describe("twentieth review: a push is refused only on git's porcelain line for the ref; landed checks before any rollback", () => {
  test("the porcelain line for the exact ref decides: '!' is refused; a non-zero exit with the ref updated, or no line for it, is unknown", () => {
    const ref = "refs/heads/main";
    // The ref updated, then a failure after it (the tracking ref, a hook's error printed after the update).
    const updated = "To github.com:x/pc-jobs.git\n \tHEAD:refs/heads/main\t1111111..2222222\nDone\nerror: update_ref failed for ref 'refs/remotes/origin/main': cannot lock ref";
    expect(pushAnswer(1, updated, false, ref)).toMatchObject({ answer: "unknown" });
    expect(pushAnswer(1, "To x\n*\tHEAD:refs/heads/main\t[new branch]\nDone\nremote: error: post-receive hook failed", false, ref)).toMatchObject({ answer: "unknown" });
    expect(pushAnswer(1, "To x\n=\tHEAD:refs/heads/main\t[up to date]\nDone", false, ref)).toMatchObject({ answer: "unknown" });
    // A '!' line for another ref, or words that only look like a refusal: unknown.
    expect(pushAnswer(1, "To x\n!\tHEAD:refs/heads/other\t[remote rejected] (pre-receive hook declined)\nDone", false, ref)).toMatchObject({ answer: "unknown" });
    expect(pushAnswer(1, "remote: Permission to x/pc-jobs.git denied\nfatal: unable to access: The requested URL returned error: 403", false, ref)).toMatchObject({ answer: "unknown" });
    expect(pushAnswer(1, "fatal: Authentication failed for 'https://github.com/x/pc-jobs.git/'", false, ref)).toMatchObject({ answer: "unknown" });
    // The '!' line for the ref: refused, and a non-fast-forward told apart.
    expect(pushAnswer(1, "To x\n!\tHEAD:refs/heads/main\t[remote rejected] (protected branch hook declined)\nDone", false, ref)).toMatchObject({ answer: "refused", nonFastForward: false });
    expect(pushAnswer(1, "To x\n!\tHEAD:refs/heads/main\t[rejected] (non-fast-forward)\nDone", false, ref)).toMatchObject({ answer: "refused", nonFastForward: true });
  });

  test("a push that landed but exited non-zero (a post-push failure) is unknown on every try, and the next round finds it landed, never rolled back", () => {
    const w = world();
    w.first();
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    // The real push goes through; then its exit is made a failure, with an error printed after the update.
    const after = (p: { exitCode: number | null; out: string; timedOut: boolean }) => ({ ...p, exitCode: 1, out: `${p.out}\nerror: update_ref failed for ref 'refs/remotes/origin/main': cannot lock ref` });
    expect(round(w.cfg("pi-1", { pushResult: after })).ok).toBe(false);
    const l = reuseLedger({ used: w.used }).get(MSG)!;
    expect(l.attempts.map((a) => a.answer)).toEqual(["unknown", "unknown", "unknown"]);
    expect(w.told).toEqual([]);                                                    // never told as refused
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.settles()).toEqual(["final"]);
    expect(w.lines().some((x) => x.state === "rolled_back")).toBe(false);
    expect(w.outcome(rid)).toEqual({ request: rid, state: "queued", id: l.job });
    replayRefused(w, l.job);
  });

  test("the landed checks run before any rollback, in order (the recorded commit, then any record naming it); an all-refused record never outweighs them", () => {
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/pcjobs/main.ts"), "utf8");
    const body = src.slice(src.indexOf("export function pushSeen"), src.indexOf("function commitsSeen"));
    expect(body.indexOf("commitsSeen(")).toBeGreaterThan(-1);
    expect(body.indexOf("commitsSeen(")).toBeLessThan(body.indexOf("named("));
    expect(body.indexOf("named(")).toBeLessThan(body.indexOf('a.answer === "ok"'));
    const rec = src.slice(src.indexOf("export function reconcileReuse"));
    expect(rec.indexOf("pushSeen(")).toBeLessThan(rec.indexOf("allRefused"));
    // Every attempt recorded refused, yet a worker record in the queue names the job: landed.
    const { cfg } = queue();
    const c = { ...cfg, notify: () => true } as Config;
    const job = "j-20261115-eeeeee", t = { m: MSG, job, state: "pending", rid: "pc-0007" };
    recordReuse(c, MSG, job, "pending", "pc-0007", "e".repeat(40));
    for (const o of [{ ev: "answer", answer: "refused" }, { ev: "push", commit: "e".repeat(40) }, { ev: "answer", answer: "refused" }, { ev: "push", commit: "e".repeat(40) }, { ev: "answer", answer: "refused" }])
      appendFileSync(cfg.used!, JSON.stringify({ ...t, ...o }) + "\n");
    expect(reuseLedger(c).get(MSG)!.attempts.map((a) => a.answer)).toEqual(["refused", "refused", "refused"]);
    mkdirSync(join(cfg.dir, "worker"), { recursive: true });
    writeFileSync(join(cfg.dir, "worker", "taken.json"), JSON.stringify({ took: job }));
    expect(reconcileReuse(c, [], null)).toMatchObject({ finalised: [job], rolledBack: [] });
  });
});

describe("twentieth review: the once-only notices, delivered and kept beside the store", () => {
  // A link that answers as given, call by call: true is "posted", false no answer.
  const counting = (answers: boolean[]) => { const calls: string[] = []; return { calls, notify: (c: string) => { calls.push(c); return answers[Math.min(calls.length - 1, answers.length - 1)]; } }; };

  test("a failed link post is tried again next round, and told once when it succeeds; the mark is a file of its own beside the store", () => {
    const w = world();
    w.first();
    mkdirSync(w.used, { recursive: true });                                         // the store can't be read
    const n = counting([false, true]);
    const cfg = () => w.cfg("pi-1", { notify: n.notify as any });
    const told = `${w.used}.told.json`;
    expect(round(cfg()).ok).toBe(true);
    expect(n.calls).toEqual(["reuse_store_unreadable"]);
    const first = JSON.parse(readFileSync(told, "utf8")).told.store;
    expect(first).toMatchObject({ posted: false });                                 // not marked: the link didn't acknowledge it (its id kept)
    expect(round(cfg()).ok).toBe(true);
    expect(n.calls).toEqual(["reuse_store_unreadable", "reuse_store_unreadable"]);
    expect(JSON.parse(readFileSync(told, "utf8")).told.store).toEqual({ id: first.id, posted: true, clear: 0, code: "reuse_store_unreadable" });   // marked once the link said posted, same id
    expect(round(cfg()).ok).toBe(true);
    expect(n.calls.length).toBe(2);
  });

  test("an unreadable store across three rounds: told once", () => {
    const w = world();
    w.first();
    mkdirSync(w.used, { recursive: true });
    for (let i = 0; i < 3; i++) expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.told).toEqual(["reuse_store_unreadable"]);
  });

  test("a condition seen clear is forgotten, so its coming back is told again", () => {
    const w = world();
    w.first();
    mkdirSync(w.used, { recursive: true });
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.told).toEqual(["reuse_store_unreadable"]);
    rmSync(w.used, { recursive: true, force: true });                               // readable again (no store yet)
    for (let i = 0; i < 3; i++) expect(round(w.cfg("pi-1")).ok).toBe(true);        // clear for three rounds in a row
    expect(JSON.parse(readFileSync(`${w.used}.told.json`, "utf8")).told).toEqual({});
    mkdirSync(w.used, { recursive: true });                                         // and broken again
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.told).toEqual(["reuse_store_unreadable", "reuse_store_unreadable"]);
  });

  test("a keeper ahead of the link: a code it has no words for posts the generic line naming it", async () => {
    const r = rig();
    const a = await r.link.pcNotice("queue_new_condition");
    expect(a.status).toBe("posted");
    expect(r.posted[a.message].content).toBe("Your PC job keeper reported a stop condition the App does not know, code queue_new_condition, see troubleshooting in pc-jobs.md.");
    // Only a plain code: no words, record codes or long strings from the keeper reach Discord.
    for (const bad of ["P64", "has space", "x".repeat(41), "", "a-b"]) await expect(r.link.pcNotice(bad)).rejects.toThrow("not a PC job keeper notice");
    expect(r.posted[(await r.link.pcNotice("constructor")).message].content).toContain("code constructor,");   // a name every object has is still just a code
  });

  test.skipIf(!Bun.which("curl"))("the keeper marks a notice told only on the link's posted answer, over its local API, an unknown code included", async () => {
    const TOKEN = "not-a-real-token.for-the-notice-test";
    const dir = mkdtempSync(join(tmpdir(), "pcjobs-notice-"));
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    const key = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
    const r = rig();
    let up = false;
    const server = Bun.serve({ port: 0, async fetch(req) {
      if (req.headers.get("x-harness-key") !== key) return Response.json({ status: "refused" }, { status: 403 });
      if (!up) return Response.json({ status: "refused", said: "busy" }, { status: 503 });
      const b: any = await req.json();
      try { return Response.json(await r.link.pcNotice(b.code, b.job, b.id)); }
      catch (e) { return Response.json({ status: "refused", said: (e as Error).message }, { status: 400 }); }
    } });
    const main = join(import.meta.dir, "../rootfs/opt/cain/pcjobs/main.ts");
    const used = join(dir, "state", "used.jsonl");
    const run = async (code: string) => {
      const src = `const { tell } = await import(${JSON.stringify(main)});
        tell({ used: ${JSON.stringify(used)}, link: "http://127.0.0.1:${server.port}", discordEnv: ${JSON.stringify(join(dir, ".env"))} }, ${JSON.stringify(code)});`;
      await Bun.spawn(["bun", "-e", src], { stdout: "pipe", stderr: "pipe" }).exited;
    };
    const told = () => { try { return JSON.parse(readFileSync(`${used}.told.json`, "utf8")); } catch { return null; } };
    try {
      await run("queue_new_condition");
      expect(told().told.queue_new_condition).toMatchObject({ posted: false });     // the link didn't post it: not marked
      up = true;
      await run("queue_new_condition");
      expect(told().told.queue_new_condition).toMatchObject({ posted: true });
      const n = Object.keys(r.posted).length;
      await run("queue_new_condition");
      expect(Object.keys(r.posted).length).toBe(n);                                 // told once
    } finally { server.stop(true); }
  }, 30_000);
});

describe("twentieth review: a round-17 pending line gets the record check before it is finalised", () => {
  test("an upgrade where a worker record in the queue names the old line's job: landed, not spent, and nobody told", () => {
    const w = world();
    w.first();
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    // The older keeper's push did land: the queue holds a report naming its job.
    const pc = w.clone();
    mkdirSync(join(pc, "results"), { recursive: true });
    writeFileSync(join(pc, "results", "j-20261115-old017.json"), JSON.stringify({ id: "j-20261115-old017", status: "done" }) + "\n");
    git(["add", "-A"], pc); git(["commit", "--quiet", "-m", "report"], pc); git(["push", "--quiet", "origin", "HEAD:main"], pc);
    mkdirSync(join(w.root, "state"), { recursive: true });
    writeFileSync(w.used, JSON.stringify({ m: MSG, job: "j-20261115-old017", state: "pending", rid }) + "\n");
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.lines().slice(1)).toEqual([{ m: MSG, job: "j-20261115-old017", state: "final", rid, migrated: "round17_pending" }]);
    expect(w.outcome(rid)).toEqual({ request: rid, state: "queued", id: "j-20261115-old017" });
    expect(w.told).toEqual([]);
    replayRefused(w, "j-20261115-old017");
  });
});

describe("twentieth review: after a third refused push, the tap settles on the next round", () => {
  test("refused again on the next round: rolled back and tried again, the owner still told once; a replay meanwhile is refused as pending", () => {
    if (WIN) return;                                                               // the refusing hook is a shell script
    const w = world();
    w.first();
    const h = w.hook("exit 1");
    const rid = w.request({ ...READ, owner_reuse: reuse() });
    expect(round(w.cfg("pi-1")).ok).toBe(false);
    const first = reuseLedger({ used: w.used }).get(MSG)!;
    expect(check(w.cfg("pi-1"), ask({ ...READ, owner_reuse: reuse() }), [], T0)).toEqual({ why: `owner_reuse refused: that tap of his answered for ${first.job} and is ${PENDING_STATUS}` });
    expect(PENDING_STATUS).toContain("next round with a successful fetch from GitHub");
    expect(round(w.cfg("pi-1")).ok).toBe(false);                                    // settled (rolled back), then refused again
    expect(w.settles()).toEqual(["rolled_back"]);
    expect(w.told).toEqual(["reuse_push_refused"]);
    rmSync(h);
    expect(round(w.cfg("pi-1"))).toMatchObject({ ok: true, queued: 1 });
    expect(w.settles()).toEqual(["rolled_back", "rolled_back", "final"]);
    expect(w.outcome(rid)).toMatchObject({ state: "queued" });
    expect(w.told).toEqual(["reuse_push_refused"]);
  });
});

describe("twenty-first review: bounded waits with a notice, three clear rounds, and notice ids the link deduplicates on", () => {
  test("a legacy pending line whose record can't be read: told once after three rounds, naming the job and the code", () => {
    if (WIN) return;
    const { cfg } = queue();
    const sent: { code: string; n?: any }[] = [];
    const c = { ...cfg, queue: mkdtempSync(join(tmpdir(), "pcjobs-q-")), notify: (code: string, n?: any) => { sent.push({ code, n }); return true; } } as Config;
    mkdirSync(dirname(c.used!), { recursive: true });
    writeFileSync(c.used!, JSON.stringify({ m: MSG, job: "j-20261115-legacy", state: "pending", rid: "pc-0009" }) + "\n");
    symlinkSync(join(cfg.dir, "nowhere"), join(cfg.dir, "results", "dangling.json"));
    writeFileSync(join(c.queue, "pc-0009.json"), ask({ ...READ }));                // its request, still waiting: what the job does
    for (let i = 0; i < 2; i++) reconcileReuse(c, [], "d".repeat(40));
    expect(sent).toEqual([]);                                                       // two rounds: still waiting, nobody told
    for (let i = 0; i < 3; i++) reconcileReuse(c, [], "d".repeat(40));
    expect(sent.map((x) => x.code)).toEqual(["reuse_record_unreadable"]);           // the third round tells, once
    expect(sent[0].n.job).toEqual({ site: "example.com", action: "read_account_settings" });   // by what it does, never its id
    expect(sent[0].n.id).toMatch(/^[0-9a-f]{24}$/);
    expect(reuseLedger(c).get(MSG)).toMatchObject({ state: "pending" });
  });

  test("a third-refusal settle whose rounds can't fetch: told once after three rounds, naming the job; the status says next round with a successful fetch", () => {
    if (WIN) return;
    const w = world();
    w.first();
    const h = w.hook("exit 1");
    w.request({ ...READ, owner_reuse: reuse() });
    const sent: { code: string; job?: any }[] = [];
    const cfg = () => w.cfg("pi-1", { notify: ((code: string, n?: any) => { sent.push({ code, job: n?.job }); return true; }) as any });
    expect(round(cfg()).ok).toBe(false);                                            // three refused pushes
    const job = { site: "example.com", action: "read_account_settings" };
    expect(reuseLedger({ used: w.used }).get(MSG)).toMatchObject(job);               // the ledger keeps what the job does
    expect(sent).toEqual([{ code: "reuse_push_refused", job }]);                     // twenty-third round: named too
    const away = `${w.remote}.away`;
    renameSync(w.remote, away);
    for (let i = 0; i < 2; i++) expect(round(cfg()).ok).toBe(false);
    expect(sent.length).toBe(1);
    expect(round(cfg()).ok).toBe(false);
    expect(sent.slice(1)).toEqual([{ code: "reuse_fetch_failed", job }]);
    for (let i = 0; i < 2; i++) expect(round(cfg()).ok).toBe(false);
    expect(sent.length).toBe(2);                                                    // once
    renameSync(away, w.remote);
    rmSync(h);
    expect(round(cfg())).toMatchObject({ ok: true, queued: 1 });                    // the next round with a fetch settles it
    expect(PENDING_STATUS).toContain("next round with a successful fetch");
  });

  test("a flapping condition is told once; a mark goes only after three clear rounds in a row", () => {
    const w = world();
    w.first();
    for (const broken of [true, false, true, false, false, true, false]) {
      if (broken) mkdirSync(w.used, { recursive: true }); else rmSync(w.used, { recursive: true, force: true });
      expect(round(w.cfg("pi-1")).ok).toBe(true);
    }
    expect(w.told).toEqual(["reuse_store_unreadable"]);
    for (let i = 0; i < 2; i++) expect(round(w.cfg("pi-1")).ok).toBe(true);        // three clear in a row now
    mkdirSync(w.used, { recursive: true });
    expect(round(w.cfg("pi-1")).ok).toBe(true);
    expect(w.told).toEqual(["reuse_store_unreadable", "reuse_store_unreadable"]);
  });

  test("a post whose acknowledgement was lost is sent again with the same notice id, and the link doesn't post it twice", async () => {
    const r = rig();
    const sent: any[] = [];
    let lose = true;
    const w = world();
    w.first();
    mkdirSync(w.used, { recursive: true });
    const notify = ((code: string, n?: any) => {
      sent.push(n.id);
      // The link posts it; its answer is lost on the first try.
      const p = r.link.pcNotice(code, n.job, n.id);
      void p;
      if (lose) { lose = false; return false; }
      return true;
    }) as any;
    expect(round(w.cfg("pi-1", { notify })).ok).toBe(true);
    await Bun.sleep(50);
    expect(round(w.cfg("pi-1", { notify })).ok).toBe(true);
    await Bun.sleep(50);
    expect(sent.length).toBe(2);
    expect(sent[1]).toBe(sent[0]);                                                  // the same id
    const lines = Object.values(r.posted).filter((m: any) => m.content === PC_NOTICES.reuse_store_unreadable);
    expect(lines.length).toBe(1);                                                   // posted once
    const again = await r.link.pcNotice("reuse_store_unreadable", undefined, sent[0]);
    expect(again).toMatchObject({ status: "posted", duplicate: true });
    // The job is named by what it does, with the code; never by its queue id.
    const named = await r.link.pcNotice("reuse_fetch_failed", { site: "example.com", action: "read_account_settings" }, "e".repeat(24));
    expect(r.posted[named.message].content).toBe(`${PC_NOTICES.reuse_fetch_failed} (It is the job to read account settings on example.com, code reuse_fetch_failed.)`);
    for (const bad of ["j-20261115-abcdef", "P64", { site: "example.com", action: "read_account_settings", id: "j-20261115-abcdef" }, { site: "Example Com", action: "x" }])
      await expect(r.link.pcNotice("reuse_fetch_failed", bad, "f".repeat(24))).rejects.toThrow("never by its queue id");
    await expect(r.link.pcNotice("reuse_fetch_failed", undefined, "not hex")).rejects.toThrow("not a PC job keeper notice id");
  });
});

describe("twenty-second review: the job named by what it does, a lost acknowledgement kept until confirmed, and an unreadable store counted on a failed fetch", () => {
  test.skipIf(!Bun.which("curl"))("end to end: the keeper's tell, the link's route, the gate's rules: the line names the job by its site and action, posts, and is not refused", async () => {
    const TOKEN = "not-a-real-token.for-the-notice-test";
    const dir = mkdtempSync(join(tmpdir(), "pcjobs-notice22-"));
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    const key = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
    const r = rig();
    const bodies: any[] = [];
    // The link's own HTTP handler (link/http.ts linkFetch, what link/main.ts serves), on a port of its own.
    const handler = linkFetch({ link: r.link, keyOk: (h) => h === key, health: () => ({}), toHarness: async () => true });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req, srv) { bodies.push(await req.clone().json()); return handler(req, srv); } });
    const main = join(import.meta.dir, "../rootfs/opt/cain/pcjobs/main.ts");
    const used = join(dir, "state", "used.jsonl");
    try {
      const src = `const { tell } = await import(${JSON.stringify(main)});
        tell({ used: ${JSON.stringify(used)}, link: "http://127.0.0.1:${server.port}", discordEnv: ${JSON.stringify(join(dir, ".env"))} }, "reuse_fetch_failed", "fetch:${MSG}",
          { site: "example.com", action: "read_account_settings" });`;
      await Bun.spawn(["bun", "-e", src], { stdout: "pipe", stderr: "pipe" }).exited;
      expect(bodies.length).toBe(1);
      expect(bodies[0]).toEqual({ code: "reuse_fetch_failed", id: expect.stringMatching(/^[0-9a-f]{24}$/), job: { site: "example.com", action: "read_account_settings" } });
      const marks = JSON.parse(readFileSync(`${used}.told.json`, "utf8")).told;
      expect(marks[`fetch:${MSG}`]).toMatchObject({ posted: true });                 // the link answered posted
      const lines = Object.values(r.posted).map((m: any) => m.content as string);
      const line = lines.find((t) => t.startsWith(PC_NOTICES.reuse_fetch_failed))!;
      expect(line).toBe(`${PC_NOTICES.reuse_fetch_failed} (It is the job to read account settings on example.com, code reuse_fetch_failed.)`);
      expect(line).not.toMatch(/j-\d{8}-[a-z0-9]{6}/);
      expect(line).not.toContain(bodies[0].id);                                     // the notice id stays in the payload
      expect(r.reports).toEqual([]);                                                // the gate's rules: nothing to fix or hold
      // An id in the words would be refused by the gate's machine-text rule.
      await expect(r.link.pcNotice("reuse_fetch_failed", "j-20261115-abcdef", "a".repeat(24))).rejects.toThrow("never by its queue id");
    } finally { server.stop(true); }
  }, 30_000);

  test("a post whose acknowledgement was lost, three clear rounds, then a recurrence: one post, one id", () => {
    const w = world();
    w.first();
    const ids: string[] = [];
    const postedIds = new Set<string>();
    let lose = true;
    // The link: deduplicates on the id; the first answer is lost after it posted.
    const notify = ((_code: string, n?: any) => {
      ids.push(n.id);
      postedIds.add(n.id);
      if (lose) { lose = false; return false; }
      return true;
    }) as any;
    mkdirSync(w.used, { recursive: true });
    expect(round(w.cfg("pi-1", { notify })).ok).toBe(true);                        // told; the answer lost
    rmSync(w.used, { recursive: true, force: true });
    for (let i = 0; i < 3; i++) expect(round(w.cfg("pi-1", { notify })).ok).toBe(true);   // three clear rounds
    mkdirSync(w.used, { recursive: true });
    expect(round(w.cfg("pi-1", { notify })).ok).toBe(true);                        // it comes back
    expect(postedIds.size).toBe(1);                                                 // one post
    expect(new Set(ids).size).toBe(1);                                              // one id, sent again until confirmed
    expect(ids.length).toBe(2);
  });

  test("rounds that can't fetch and can't read the tap store count: the store's own notice after three, once", () => {
    if (WIN) return;
    const w = world();
    w.first();
    const away = `${w.remote}.away`;
    renameSync(w.remote, away);
    mkdirSync(w.used, { recursive: true });                                         // the store can't be read
    for (let i = 0; i < 2; i++) expect(round(w.cfg("pi-1")).ok).toBe(false);
    expect(w.told).toEqual([]);
    expect(round(w.cfg("pi-1")).ok).toBe(false);
    expect(w.told).toEqual(["reuse_store_unreadable"]);
    for (let i = 0; i < 2; i++) expect(round(w.cfg("pi-1")).ok).toBe(false);
    expect(w.told).toEqual(["reuse_store_unreadable"]);
    renameSync(away, w.remote);
    expect(round(w.cfg("pi-1")).ok).toBe(true);                                    // fetches again: the store's own path takes over, still once
    expect(w.told).toEqual(["reuse_store_unreadable"]);
  });
});

describe("twenty-third review: notice marks never leave the owner untold, permanent refusals capped, every job named, through the link's real handler", () => {
  const TOKEN = "not-a-real-token.for-the-notice-test-23";
  const key = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
  const serve = (r: ReturnType<typeof rig>) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: linkFetch({ link: r.link, keyOk: (h) => h === key, health: () => ({}), toHarness: async () => true }) });
    return server;
  };
  const envFile = () => { const d = mkdtempSync(join(tmpdir(), "pcjobs-env23-")); writeFileSync(join(d, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`); return join(d, ".env"); };

  test.skipIf(!Bun.which("curl"))("end to end through the link's real HTTP handler: posted, already posted, and refused, as the keeper reads them", async () => {
    const r = rig();
    const server = serve(r);
    try {
      const url = `http://127.0.0.1:${server.port}/pc-notice`;
      const post = (b: unknown, k = key) => fetch(url, { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", "x-harness-key": k } });
      const id = "a".repeat(24);
      const first = await post({ code: "reuse_fetch_failed", id, job: { site: "example.com", action: "read_account_settings" } });
      expect(first.status).toBe(200);
      const one = await first.json();
      expect(one).toEqual({ status: "posted", message: expect.any(String) });
      const again = await post({ code: "reuse_fetch_failed", id, job: { site: "example.com", action: "read_account_settings" } });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ status: "posted", message: one.message, duplicate: true });     // already posted: the same message
      const bad = await post({ code: "reuse_fetch_failed", id: "b".repeat(24), job: "j-20261115-abcdef" });
      expect(bad.status).toBe(400);
      expect((await bad.json()).status).toBe("refused");
      expect((await post({ code: "reuse_fetch_failed" }, "0".repeat(64))).status).toBe(403);
      // The keeper's own send, over curl, in its own process (its curl call is synchronous), reads each answer as it must.
      const main = join(import.meta.dir, "../rootfs/opt/cain/pcjobs/main.ts");
      const src = `const { linkNotify } = await import(${JSON.stringify(main)});
        const n = linkNotify({ link: "http://127.0.0.1:${server.port}", discordEnv: ${JSON.stringify(envFile())} });
        const job = { site: "example.com", action: "read_account_settings" };
        console.log(JSON.stringify([n("reuse_fetch_failed", { id: "c".repeat(24), job }), n("reuse_fetch_failed", { id: "c".repeat(24), job }),
          n("reuse_fetch_failed", { id: "d".repeat(24), job: { site: "Example Com", action: "x" } }), n("reuse_fetch_failed", { id: "e".repeat(24), job: { queued: "2026-11-15T14:05:00Z" } })]));`;
      const child = Bun.spawn(["bun", "-e", src], { stdout: "pipe", stderr: "pipe" });
      await child.exited;
      expect(JSON.parse((await new Response(child.stdout).text()).trim())).toEqual([true, true, "refused", true]);   // posted, already posted, refused, posted
      const lines = Object.values(r.posted).map((m: any) => m.content as string);
      expect(lines).toContain(`${PC_NOTICES.reuse_fetch_failed} (It is a PC browser job queued at Nov 15, 9:05 AM, code reuse_fetch_failed.)`);
      expect(r.reports).toEqual([]);                                                // the gate's rules: nothing to fix or hold
      expect(linkNotify({ link: "http://127.0.0.1:1", discordEnv: envFile() })("reuse_fetch_failed", { id: "f".repeat(24) })).toBe(false);   // no answer: passing
    } finally { server.stop(true); }
  }, 30_000);

  test("upgrading a notice file from the previous keeper: each per-record mark gets its code and job, an unknown one goes as the generic line, logged", () => {
    const w = world();
    w.first();
    const used = w.used;
    mkdirSync(dirname(used), { recursive: true });
    const M2 = "1300000000000000099";
    writeFileSync(used, [JSON.stringify({ m: MSG, job: "j-20261115-legacy", state: "pending", rid: "pc-0009", site: "example.com", action: "read_account_settings" }),
      JSON.stringify({ m: M2, job: "j-20261114-other1", state: "pending", rid: "pc-0010" })].join("\n") + "\n");
    const id = (c: string) => c.repeat(24);
    writeFileSync(`${used}.told.json`, JSON.stringify({ v: 2, told: {
      [`record:${MSG}`]: { id: id("1"), posted: false, clear: 0 },
      [`fetch:${M2}`]: { id: id("2"), posted: false, clear: 0 },
      "weird:x": { id: id("3"), posted: false, clear: 0 },
      store: { id: id("4"), posted: true, clear: 0 },
    }, waits: {} }));
    const sent: { code: string; id: string; job?: any }[] = [];
    const logs: string[] = [];
    const was = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try { resendOwed(w.cfg("pi-1", { notify: ((code: string, n?: any) => { sent.push({ code, id: n.id, job: n.job }); return true; }) as any })); }
    finally { console.log = was; }
    expect(sent).toEqual([
      { code: "reuse_record_unreadable", id: id("1"), job: { site: "example.com", action: "read_account_settings" } },
      { code: "reuse_fetch_failed", id: id("2"), job: { queued: "2026-11-14" } },        // no site and action anywhere: when it was queued
      { code: "notice_undelivered", id: id("3"), job: undefined },
    ]);
    expect(logs.join("\n")).toContain("was never delivered and its code can't be told");
    const file = JSON.parse(readFileSync(`${used}.told.json`, "utf8"));
    expect(file.v).toBe(3);
    expect(file.told.store).toMatchObject({ code: "reuse_store_unreadable", posted: true });
    for (const k of [`record:${MSG}`, `fetch:${M2}`, "weird:x"]) expect(file.told[k].posted).toBe(true);
    expect(PC_NOTICES.notice_undelivered).toContain("could not be delivered");
    // Once migrated, nothing is sent again.
    const more: string[] = [];
    resendOwed(w.cfg("pi-1", { notify: ((c: string) => { more.push(c); return true; }) as any }));
    expect(more).toEqual([]);
  });

  test("a permanent refusal by the link is capped: never sent again, logged loudly, shown on the keeper's status until it clears", () => {
    const w = world();
    w.first();
    const calls: string[] = [];
    const notify = ((c: string) => { calls.push(c); return "refused"; }) as any;
    mkdirSync(w.used, { recursive: true });                                         // the store can't be read
    const logs: string[] = [];
    const was = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      expect(round(w.cfg("pi-1", { notify })).ok).toBe(true);
      expect(round(w.cfg("pi-1", { notify })).ok).toBe(true);
    } finally { console.log = was; }
    expect(calls).toEqual(["reuse_store_unreadable"]);                              // once, never again
    expect(logs.join("\n")).toContain("ERROR: the link refused notice reuse_store_unreadable for good");
    expect(noticeTrouble({ used: w.used })).toEqual([expect.stringContaining("the link refused a notice for Dane for good (reuse_store_unreadable)")]);
    for (const l of noticeTrouble({ used: w.used })) { expect(l).not.toMatch(/j-\d{8}-[a-z0-9]{6}/); expect(l).not.toMatch(/[0-9a-f]{24}/); }
    rmSync(w.used, { recursive: true, force: true });
    for (let i = 0; i < 3; i++) expect(round(w.cfg("pi-1", { notify })).ok).toBe(true);
    expect(noticeTrouble({ used: w.used })).toEqual([]);                            // cleared after three clear rounds
    expect(calls).toEqual(["reuse_store_unreadable"]);
  });

  test("every caller names the job by its site and action, or when it was queued; a string is a logged error, never a refusal or an unnamed line", () => {
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/pcjobs/main.ts"), "utf8");
    const calls = [...main.matchAll(/\b(tell|waited)\(cfg, ([^;]*?)\);/g)].map((m) => m[2]).filter((a) => !a.startsWith("code, key"));
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const a of calls) {
      const tapNotice = !/^"reuse_store_unreadable"|^empty \?/.test(a);                  // the store and the queue's branch aren't about a job
      if (tapNotice) expect(a).toMatch(/, whatOf\(cfg, (l|t)\)$/);
    }
    const w = world();
    w.first();
    const sent: any[] = [];
    const logs: string[] = [];
    const cfg = w.cfg("pi-1", { notify: ((code: string, n?: any) => { sent.push({ code, job: n?.job }); return true; }) as any });
    const was = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      tell(cfg, "reuse_fetch_failed", "fetch:s1", "j-20261115-abcdef" as any);
      tell(cfg, "reuse_fetch_failed", "fetch:s2", { site: "Bad Site", action: "x" } as any);
    } finally { console.log = was; }
    expect(sent).toEqual([{ code: "reuse_fetch_failed", job: { queued: "2026-11-15" } }, { code: "reuse_fetch_failed", job: undefined }]);
    expect(logs.filter((l) => l.includes("error: notice reuse_fetch_failed was given its job")).length).toBe(2);
    // No site and action anywhere: the job file's created time, else the day in its id.
    expect(whatOf(cfg, { job: "j-20261113-zzzzzz" })).toEqual({ queued: "2026-11-13" });
    mkdirSync(join(cfg.dir, "jobs"), { recursive: true });
    writeFileSync(join(cfg.dir, "jobs", "j-20261113-yyyyyy.json"), JSON.stringify({ created: "2026-11-13T19:05:07.123Z" }));
    expect(queuedOf(cfg, "j-20261113-yyyyyy")).toEqual({ queued: "2026-11-13T19:05:07Z" });
    expect(pcQueuedWords("2026-11-13T19:05:07Z")).toBe("a PC browser job queued at Nov 13, 2:05 PM");
    expect(pcQueuedWords("2026-11-13")).toBe("a PC browser job queued on Nov 13");
    expect(pcQueuedWords("j-20261113-yyyyyy")).toBeNull();
    void cleared;
  });
});
