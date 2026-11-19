// The broker's record of what went out (rootfs/opt/cain/discord/spool.ts, from the C1 code
// review and its re-check, R5): kept before it's told to the link, told again until the link
// takes it, across a restart; and nothing dropped quietly: a note the disk refused is held and
// sent, a line that can't be read or a note the link refused is kept aside, and the link hears
// that something went wrong with the next note it takes.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SentSpool } from "../rootfs/opt/cain/discord/spool";
import { tellLink, tellLinkOutcome } from "../rootfs/opt/cain/hooks/discord-sent";

const note = (id: string) => ({ tool: "reply", ids: [id], question: false, call: `call-${id}` });
const noWait = async () => {};

// A link that takes notes (status 200), doesn't answer (throws), or refuses one for good (400).
function link(mode: { down?: boolean; refuse?: string } = {}) {
  const got: any[] = [];
  const post = async (body: string) => {
    if (mode.down) throw new Error("no answer");
    const n = JSON.parse(body);
    if (mode.refuse && n.ids?.includes(mode.refuse)) return new Response("{}", { status: 400 });
    got.push(n);
    return new Response("{}", { status: 200 });
  };
  return { got, post, mode };
}
const spoolAt = () => join(mkdtempSync(join(tmpdir(), "spool-")), "sent-spool.jsonl");
const lines = (p: string) => existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];

describe("what went out reaches the link", () => {
  test("kept before it's sent, and gone from the spool once the link takes it", async () => {
    const p = spoolAt(), l = link(), logs: string[] = [];
    const s = new SentSpool(p, l.post, (x) => logs.push(x), noWait);
    s.add(note("111"));
    expect(lines(p).length).toBe(1);
    await s.flush();
    expect(l.got.map((n) => n.ids[0])).toEqual(["111"]);
    expect(lines(p)).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("the link down: kept, and sent at the broker's next start", async () => {
    const p = spoolAt(), l = link({ down: true });
    const s = new SentSpool(p, l.post, () => {}, noWait);
    s.add(note("222"));
    await s.flush();
    expect(lines(p).length).toBe(1);
    l.mode.down = false;
    await new SentSpool(p, l.post, () => {}, noWait).flush();      // a new broker, after a restart
    expect(l.got.map((n) => n.ids[0])).toEqual(["222"]);
    expect(lines(p)).toEqual([]);
  });
});

describe("nothing dropped quietly (C1 re-check R5)", () => {
  test("a note the disk refused is held and sent all the same, and the link hears the spool failed", async () => {
    const d = mkdtempSync(join(tmpdir(), "spool-"));
    writeFileSync(join(d, "not-a-folder"), "x");
    const p = join(d, "not-a-folder", "sent-spool.jsonl");          // can't be written: its folder is a file
    const l = link(), logs: string[] = [];
    const s = new SentSpool(p, l.post, (x) => logs.push(x), noWait);
    s.add(note("333"));
    expect(s.heldCount).toBe(1);
    expect(logs.some((x) => x.startsWith("ERROR:"))).toBe(true);
    await s.flush();
    expect(l.got.map((n) => n.ids[0])).toEqual(["333"]);
    expect(l.got[0].spool_problem).toMatch(/couldn't keep its record/);
    expect([s.heldCount, s.problem]).toEqual([0, ""]);              // told once
    s.add(note("334"));
    await s.flush();
    expect(l.got[1].spool_problem).toMatch(/couldn't keep its record/);   // still failing: told again
  });

  test("a line a crash cut short is kept aside, never runs into the next note, and the link hears of it", async () => {
    const p = spoolAt(), l = link(), logs: string[] = [];
    writeFileSync(p, '{"tool":"reply","ids":["44');                  // no end: the broker died mid-write
    const s = new SentSpool(p, l.post, (x) => logs.push(x), noWait);
    s.add(note("445"));
    await s.flush();
    expect(l.got.map((n) => n.ids[0])).toEqual(["445"]);
    expect(l.got[0].spool_problem).toMatch(/couldn't be read/);
    expect(readFileSync(`${p}.bad`, "utf8")).toBe('{"tool":"reply","ids":["44\n');
    expect(lines(p)).toEqual([]);
    expect(logs.some((x) => x.startsWith("ERROR:"))).toBe(true);
  });

  test("a note the link refused for good is kept aside, not sent every 30 seconds forever", async () => {
    const p = spoolAt(), l = link({ refuse: "555" });
    const s = new SentSpool(p, l.post, () => {}, noWait);
    s.add(note("555"));
    await s.flush();
    expect(lines(p)).toEqual([]);
    expect(lines(`${p}.bad`).map((x) => JSON.parse(x).ids[0])).toEqual(["555"]);
    s.add(note("556"));
    await s.flush();
    expect(l.got.map((n) => [n.ids[0], /refused/.test(n.spool_problem ?? "")])).toEqual([["556", true]]);
  });

  test("a held note the link refused is kept aside too, and never sent again", async () => {
    const d = mkdtempSync(join(tmpdir(), "spool-"));
    writeFileSync(join(d, "not-a-folder"), "x");
    const p = join(d, "not-a-folder", "sent-spool.jsonl");          // nothing can be written there, .bad included
    const l = link({ refuse: "777" }), logs: string[] = [];
    const s = new SentSpool(p, l.post, (x) => logs.push(x), noWait);
    s.add(note("777"));
    await s.flush();
    expect(s.heldCount).toBe(0);
    expect(logs.some((x) => /dropped/.test(x))).toBe(true);
    await s.flush();
    expect(l.got).toEqual([]);
  });

  test("a held note goes into the spool once the disk takes it again, so a restart while the link is down doesn't lose it", async () => {
    const d = mkdtempSync(join(tmpdir(), "spool-"));
    const p = join(d, "later", "sent-spool.jsonl");           // its folder isn't there yet: the disk refuses
    const l = link({ down: true });
    const s = new SentSpool(p, l.post, () => {}, noWait);
    s.add(note("881"));
    await s.flush();                                           // the link down, the disk still refusing
    expect(s.heldCount).toBe(1);
    mkdirSync(join(d, "later"));                               // the disk takes writes again; the link is still down
    await s.flush();
    expect([s.heldCount, lines(p).length]).toEqual([0, 1]);
    l.mode.down = false;
    await new SentSpool(p, l.post, () => {}, noWait).flush();     // a new broker, after a restart
    expect(l.got.map((n) => n.ids[0])).toEqual(["881"]);
  });

  test("if the spool can't be read again after sending, it's left as it is: a note added meanwhile survives", async () => {
    const p = spoolAt();
    let reads = 0;
    const read = (path: string) => { reads++; if (reads === 2) throw new Error("EIO"); return readFileSync(path, "utf8"); };
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const got: string[] = [], logs: string[] = [];
    const post = async (body: string) => { await slow; got.push(JSON.parse(body).ids[0]); return new Response("{}", { status: 200 }); };
    const s = new SentSpool(p, post, (x) => logs.push(x), noWait, read);
    s.add(note("991"));
    const f = s.flush();
    s.add(note("992"));                                        // while the flush waits on the link
    release();
    await f;
    expect(lines(p).map((x) => JSON.parse(x).ids[0])).toEqual(["991", "992"]);   // nothing replaced
    expect(logs.some((x) => /left as it is/.test(x))).toBe(true);
    await s.flush();
    expect(lines(p)).toEqual([]);
    expect(got).toEqual(["991", "991", "992"]);                // 991 told again: harmless
  });

  test("notes added while a flush waits on the link stay for the next", async () => {
    const p = spoolAt();
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const got: string[] = [];
    const post = async (body: string) => { await slow; got.push(JSON.parse(body).ids[0]); return new Response("{}", { status: 200 }); };
    const s = new SentSpool(p, post, () => {}, noWait);
    s.add(note("661"));
    const f = s.flush();
    s.add(note("662"));
    release();
    await f;
    expect(lines(p).map((x) => JSON.parse(x).ids[0])).toEqual(["662"]);
    await s.flush();
    expect(got).toEqual(["661", "662"]);
    expect(lines(p)).toEqual([]);
  });
});

describe("how a try at the link went", () => {
  test("taken, refused for good, or unanswered after every try", async () => {
    const answer = (status: number) => async () => new Response("{}", { status });
    expect(await tellLinkOutcome(note("1"), answer(200), noWait)).toBe("ok");
    expect(await tellLinkOutcome(note("1"), answer(400), noWait)).toBe("refused");
    expect(await tellLinkOutcome(note("1"), answer(503), noWait)).toBe("unanswered");
    expect(await tellLinkOutcome(note("1"), answer(429), noWait)).toBe("unanswered");
    expect(await tellLinkOutcome(note("1"), async () => { throw new Error("x"); }, noWait)).toBe("unanswered");
    expect(await tellLink(note("1") as any, answer(200), noWait)).toBe(true);
    expect(await tellLink(note("1") as any, answer(400), noWait)).toBe(false);
  });
});
