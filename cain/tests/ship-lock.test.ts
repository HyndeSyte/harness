// Wave 1, piece B, second half (Cain 0.8.1): main is locked to the link's deploy key, and
// his Ship tap lands the pull request there itself (link/core.ts, with GitHub faked in
// link-rig.ts; link/merge.ts is tested on its own). Also: the link's own line from
// GitHub on a Ship card, the daily check that GitHub still knows the key, and old Stop
// notices losing a button that no longer does what it says.
import { describe, expect, test } from "bun:test";
import { RESUME, STOP } from "../rootfs/opt/cain/link/core";
import { findToken } from "../rootfs/opt/cain/ship-token";
import { DAY, HOUR, MIN, PR, rig, SHA1, SHA2 } from "./link-rig";

const snap = (m: any) => JSON.parse(JSON.stringify(m));
const tick = () => new Promise((ok) => setTimeout(ok, 5));
const ship = async (r: ReturnType<typeof rig>, head = SHA1, pr = PR) =>
  ((await r.link.ship({ text: "P41: Cain 0.8.1 ready.", item: "P41", pr, head })) as any).message as string;
const card = "P41: Cain 0.8.1 ready.";
const toggle = (label: string, id: string) => [{ type: 1, components: [{ type: 2, style: 2, label, custom_id: id }] }];

describe("his Ship tap lands it in main", () => {
  test("at once: his card says it's landing, then that it shipped; Cain hears once, with the token", async () => {
    const r = rig();
    const id = await ship(r);
    r.github.hold = true;
    const tapping = r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await tick();
    expect(r.updates().at(-1)).toEqual({ content: `${card}\n\nYou tapped Ship: landing it in main now.`, components: [], allowed_mentions: { parse: [] } });
    expect(r.relayed).toEqual([]);
    r.go();
    await tapping;
    expect(r.github.landings).toEqual([{ pr: PR, head: SHA1 }]);
    expect(r.msg(id).content).toBe(`${card}\n\nShipped: it's in main as of 8:00 AM. Installing it is next.`);
    expect(r.buttons(id)).toEqual([]);
    expect(r.relayed).toHaveLength(1);
    expect(r.relayed[0]).toContain("The link landed it: main has that commit now. Ship token: ship1.");
    expect(r.relayed[0]).toContain("start the Ship job now to install it");
    expect(findToken(r.relayed[0])).not.toBeNull();
  });

  test("one that doesn't land says why, on his card and to Cain, with no token", async () => {
    const r = rig();
    const id = await ship(r);
    r.github.answers.push({ ok: false, why: "CI's pytest check didn't pass on it (failure)", again: false });
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    expect(r.msg(id).content).toBe(`${card}\n\nNot shipped: CI's pytest check didn't pass on it (failure). Nothing changed in main.`);
    expect(r.relayed[0]).toContain("The link didn't land it: CI's pytest check didn't pass on it (failure). Nothing changed in main, and there's no Ship token.");
    expect(findToken(r.relayed[0])).toBeNull();
    expect(r.github.main).toEqual([]);
  });

  test("while GitHub doesn't answer it's tried again, and lands by itself once GitHub does", async () => {
    const r = rig();
    const id = await ship(r);
    r.github.answers.push({ ok: false, why: "GitHub didn't answer about the pull request", again: true });
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    expect(r.msg(id).content).toBe(`${card}\n\nYou tapped Ship. Waiting on GitHub: it lands as soon as GitHub answers.`);
    expect(r.relayed).toHaveLength(1);
    expect(r.relayed[0]).toContain("keeps trying for up to 2 hours and lands it by itself");
    expect(findToken(r.relayed[0])).toBeNull();
    r.later(MIN);
    await r.link.sweep();
    expect(r.github.landings).toHaveLength(1);              // its next try is 2 minutes after the first
    r.later(2 * MIN);
    await r.link.sweep();
    expect(r.github.landings).toHaveLength(2);
    expect(r.msg(id).content).toBe(`${card}\n\nShipped: it's in main as of 8:03 AM. Installing it is next.`);
    expect(r.relayed).toHaveLength(2);
    expect(findToken(r.relayed[1])).not.toBeNull();
  });

  test("after 2 hours without GitHub it's given up, and says so", async () => {
    const r = rig();
    const id = await ship(r);
    for (let i = 0; i < 30; i++) r.github.answers.push({ ok: false, why: "the link couldn't fetch it from GitHub (timed out)", again: true });
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    for (let i = 0; i < 10; i++) { r.later(15 * MIN); await r.link.sweep(); }
    expect(r.msg(id).content).toBe(`${card}\n\nNot shipped: the link couldn't fetch it from GitHub (timed out), for 2 hours. Nothing changed in main.`);
    expect(r.relayed).toHaveLength(2);                        // waiting, then given up: nothing in between
    expect(r.relayed[1]).toContain("didn't land it: the link couldn't fetch it from GitHub (timed out), for 2 hours");
    const tries = r.github.landings.length;
    r.later(HOUR);
    await r.link.sweep();
    expect(r.github.landings).toHaveLength(tries);          // given up means no more tries
  });

  test("Stop ends a landing that's waiting on GitHub, and one under way checks Stop before it pushes", async () => {
    const r = rig();
    const morning = await r.link.morning("## Fri Nov 13");
    const id = await ship(r);
    r.github.answers.push({ ok: false, why: "GitHub didn't answer about its checks", again: true });
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.msg(id).content).toBe(`${card}\n\nYou tapped Ship, but everything was stopped before it landed, so nothing shipped.`);
    expect(r.relayed.at(-1)).toContain("Everything is stopped: after he taps Turn back on, ask again with a new Ship card.");
    r.later(HOUR);
    await r.link.sweep();
    expect(r.github.landings).toHaveLength(1);

    const r2 = rig();
    const m2 = await r2.link.morning("## Fri Nov 13");
    const id2 = await ship(r2);
    r2.github.hold = true;
    const tapping = r2.tap(snap(r2.msg(id2)), r2.ids(id2)[0]);
    await tick();
    await r2.tap(snap(r2.msg(m2)), STOP);
    r2.go();
    await tapping;
    expect(r2.github.main).toEqual([]);
    expect(r2.msg(id2).content).toBe(`${card}\n\nYou tapped Ship, but everything was stopped before it landed, so nothing shipped.`);
  });

  test("one that landed just before his Stop says so, and waits to be installed", async () => {
    const r = rig();
    const morning = await r.link.morning("## Fri Nov 13");
    const id = await ship(r);
    r.github.hold = true;
    r.github.answers.push({ ok: true, already: false });
    const tapping = r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await tick();
    await r.tap(snap(r.msg(morning)), STOP);
    r.go();
    await tapping;
    expect(r.msg(id).content).toBe(`${card}\n\nShipped: it's in main as of 8:00 AM. Installing it waits until you turn things back on.`);
    const said = r.relayed.at(-1)!;
    expect(said).toContain("Everything is stopped now, so there's no Ship token and it isn't installed");
    expect(said).toContain("show a new Ship card for the same pull request and head");
    expect(findToken(said)).toBeNull();
  });

  test("a landing the link was cut off from is settled from main by the sweep", async () => {
    const r = rig();
    const id = await ship(r);
    r.github.hold = true;
    void r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await tick();
    r.restart();                                             // the add-on restarted mid-landing
    r.github.hold = false;
    r.later(4 * MIN);
    await r.link.sweep();
    expect(r.github.landings).toHaveLength(1);
    r.later(2 * MIN);
    await r.link.sweep();
    expect(r.github.landings).toHaveLength(2);
    expect(r.msg(id).content).toBe(`${card}\n\nShipped: it's in main as of 8:06 AM. Installing it is next.`);
    expect(findToken(r.relayed.at(-1)!)).not.toBeNull();
  });

  test("one landing at a time: a second tap waits for the first to settle", async () => {
    const r = rig();
    const PR6 = "https://github.com/HyndeSyte/harness/pull/6";
    const a = await ship(r, SHA1);
    const b = await ship(r, SHA2, PR6);
    r.github.hold = true;
    const tapA = r.tap(snap(r.msg(a)), r.ids(a)[0]);
    await tick();
    const tapB = r.tap(snap(r.msg(b)), r.ids(b)[0]);
    await tick();
    expect(r.github.landings).toHaveLength(1);
    r.go();
    await tapA;
    await tapB;
    expect(r.github.landings).toEqual([{ pr: PR, head: SHA1 }, { pr: PR6, head: SHA2 }]);
    expect(r.github.main).toEqual([SHA1, SHA2]);
  });
});

describe("the link's own line on a Ship card, from GitHub", () => {
  test("how much it changes and the parts that matter most; a newer head on GitHub refuses the card", async () => {
    const r = rig({ facts: true });
    r.github.facts = { head: SHA1, commits: 2, files: 9, areas: ["Cain's link", "Cain's rules", "GitHub's workflows"] };
    const id = await ship(r);
    expect(r.msg(id).content).toBe(`${card}\nFrom GitHub: 2 commits and 9 files, including Cain's link, Cain's rules and GitHub's workflows.`);
    r.github.facts = { head: SHA1, commits: 1, files: 1, areas: [] };
    expect(r.msg(await ship(r)).content).toBe(`${card}\nFrom GitHub: 1 commit and 1 file.`);
    r.github.facts = null;
    expect(r.msg(await ship(r)).content).toBe(`${card}\nFrom GitHub: the pull request couldn't be read just now.`);
    r.github.facts = { head: SHA2, commits: 3, files: 4, areas: [] };
    await expect(ship(r)).rejects.toThrow("GitHub has a newer head for that pull request");
  });

  test("a card for a head already in main stays up, so his tap can give the token to install it", async () => {
    const r = rig();
    const id = await ship(r);
    r.pulls[PR] = { head: SHA1, open: false, merged: true };
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Ship", "Not now"]);
    r.github.main.push(SHA1);
    r.github.answers.push({ ok: true, already: true });
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    expect(r.relayed.at(-1)).toContain("The link landed it: main has that commit now (it was there already). Ship token: ship1.");
    // Closed without landing, or landed at another head: taken off.
    const r2 = rig();
    const c = await ship(r2);
    r2.pulls[PR] = { head: SHA2, open: false, merged: true };
    await r2.link.sweep();
    expect(r2.buttons(c)).toEqual([]);
    expect(r2.relayed.at(-1)).toContain("was taken off: the pull request was merged or closed");
  });
});

describe("GitHub still knows the deploy key", () => {
  test("checked once a day; Cain hears once when it's gone, and once when it's back", async () => {
    const r = rig({ keyCheck: true });
    await r.link.sweep();
    expect(r.state().key).toEqual({ checked: r.t.now });
    r.github.key = false;
    r.later(DAY - MIN);
    await r.link.sweep();
    expect(r.relayed.filter((l) => l.includes("deploy key"))).toEqual([]);
    r.later(2 * MIN);
    await r.link.sweep();
    expect(r.relayed.filter((l) => l.includes("deploy key"))).toHaveLength(1);
    expect(r.relayed.at(-1)).toContain("GitHub no longer knows the link's deploy key, so his Ship taps can't land anything in main.");
    r.later(DAY + MIN);
    await r.link.sweep();
    expect(r.relayed.filter((l) => l.includes("deploy key"))).toHaveLength(1);
    r.github.key = null;                                     // GitHub didn't answer: nothing said
    r.later(DAY + MIN);
    await r.link.sweep();
    expect(r.relayed.filter((l) => l.includes("deploy key"))).toHaveLength(1);
    r.github.key = true;
    await r.link.sweep();
    expect(r.relayed.at(-1)).toContain("GitHub knows the link's deploy key again");
  });
});

describe("old Stop notices", () => {
  test("lose a button that no longer does what it says, and say what changed since", async () => {
    const r = rig();
    const morning = await r.link.morning("## Fri Nov 13");
    await r.tap(snap(r.msg(morning)), STOP);
    await r.link.addCard({ text: "Stopped. I won't start anything new.", rows: toggle("Turn back on", RESUME), kind: "stopped" });
    const stopped = r.last().id;
    await r.tap(snap(r.msg(stopped)), RESUME);
    await r.link.addCard({ text: "Resumed.", rows: toggle("Stop", STOP), kind: "resumed" });
    const resumed = r.last().id;
    expect(r.buttons(stopped)).toEqual([]);
    expect(r.msg(stopped).content).toEndWith("\n\nTurned back on since.");
    expect(r.buttons(resumed)).toEqual(["Stop"]);
    expect(r.buttons(morning)).toEqual(["Stop"]);
    await r.tap(snap(r.msg(resumed)), STOP);
    await r.link.addCard({ text: "Stopped.", rows: toggle("Turn back on", RESUME), kind: "stopped" });
    expect(r.buttons(resumed)).toEqual([]);
    expect(r.msg(resumed).content).toEndWith("\n\nStopped again since.");
    expect(r.buttons(r.last().id)).toEqual(["Turn back on"]);
  });
});
