// Owner reuse with provenance Cain can't forge: a PC job may carry a value an earlier
// result reported only when its owner_reuse names the Discord message of his yes, and the
// link (link/core.ts reuseProof) finds that message is his recorded "Use it" tap on an ask
// that quoted exactly those values when posted. A reply he typed never counts. The keeper
// (pcjobs/main.ts check) refuses the job otherwise, fail closed, and one tap answers for one
// job across restarts (main.ts usedReuse).
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobText, parseJob, REUSE_SHAPE, resultText, type Job, type OwnerReuse, type Result } from "../rootfs/opt/cain/pcjobs/core.ts";
import { check, readJobs, recordReuse, reuseAnswer, usedReuse, type Config, type ReuseCheck } from "../rootfs/opt/cain/pcjobs/main.ts";
import { DM, rig } from "./link-rig";
import { askValues } from "../rootfs/opt/cain/link/core";

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
    recordReuse(cfg, id, first.job.id);                                          // round() records it once the job is pushed
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
