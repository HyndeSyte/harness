// Cain 0.19.1: the grant card and the review cap's ship-or-hold card are retired by the owner's review rule
// (R-013 as he changed it on Nov 26, 2026): after the last round, a change with something serious left is
// held and Cain tells him in one line; he is never asked about rounds, risk or cuts. The link posts neither
// card, and a tap on one still up from before writes nothing (no grant, no decision, no hold line).
import { describe, expect, test } from "bun:test";
import { HOLD, RISK } from "../rootfs/opt/cain/link/cap.ts";
import { RETIRED_DECISION, RETIRED_GRANT } from "../rootfs/opt/cain/link/core.ts";
import { keeperHolds, rig } from "./link-rig";

const PR46 = "https://github.com/HyndeSyte/harness/pull/46";
const DEC = { id: "pr-46#3", key: "pr-46", round: 3, serious: 1, topic: "The rollback keeper", finding: "it can lose the way back",
  item: null, pr: PR46, state: "posted" as const, at: "2026-11-26T12:00:00Z" };

// An old card still up from before 0.19.1: a card whose record carries the grant or the decision it was
// for, with that card's own two buttons. Every write the old taps made is a spy that must stay unused.
async function oldCard(kind: "grant" | "decision") {
  const r = rig({ holds: keeperHolds({}) });
  const res: any = await r.link.ask({ text: "Pause the garden plan?", options: ["One", "Two"], item: "none" });
  expect(res.status).toBe("posted");
  const s = r.state();
  const m: any = s.messages[res.message];
  if (kind === "grant") {
    m.grant = { key: "pr-46", rounds: 1, pr: PR46, reason: "The rollback keeper", used: 3, cap: 3, head: "a".repeat(40), decision: null };
    m.q.options = ["Grant 1 more round", "No"];
  } else {
    m.decision = DEC;
    m.q.options = [HOLD, RISK];
  }
  r.setState(s);
  const writes: string[] = [];
  Object.assign((r.link as any).d, {
    grant: () => { writes.push("grant"); return { rec: {}, existed: false }; },
    decided: () => { writes.push("decided"); return { choice: RISK, at: 0, existed: false }; },
    holdLog: () => { writes.push("hold"); },
    armed: () => JSON.stringify({ armed: { cain: "2026-11-26T12:00:00Z" } }),
    rounds: () => ({ format: 1, changes: {} }), grants: () => ({ format: 1, grants: [] }),
  });
  return { r, id: res.message as string, writes };
}

describe("0.19.1: neither card goes out", () => {
  test("Cain's grant card is refused, saying why, and nothing is posted", async () => {
    const r = rig({ holds: keeperHolds({}) });
    await expect(r.link.reviewGrant({ item: "P46", change: PR46, rounds: 1, text: "The rollback keeper" }))
      .rejects.toThrow("grant cards are retired by the owner's review rule at the cap");
    expect(r.posts()).toBe(0);
  });
  test("the cap's decision card is refused, and nothing is posted", async () => {
    const r = rig({ holds: keeperHolds({}) });
    await expect(r.link.decision(DEC)).rejects.toThrow("the review cap's decision card is retired");
    expect(r.posts()).toBe(0);
  });
  test("a decision left waiting on an item's hold is dropped at the next sweep, never posted", async () => {
    const r = rig({ holds: keeperHolds({}) });
    const s = r.state();
    (s as any).decisions = { [DEC.id]: DEC };
    r.setState(s);
    await (r.link as any).retryDecisions();
    expect((r.state() as any).decisions?.[DEC.id]).toBeUndefined();
    expect(r.posts()).toBe(0);
    expect(r.relayed.filter((l) => l.includes("The review cap was reached for pr-46 before this release")).length).toBe(1);
    await (r.link as any).retryDecisions();                                    // dropped once: no second line
    expect(r.relayed.filter((l) => l.includes("before this release")).length).toBe(1);
  });
  test("an ask can't offer shipping with a risk named", async () => {
    const r = rig({ holds: keeperHolds({}) });
    await expect(r.link.ask({ text: "Ship it or hold it?", options: [RISK, HOLD], item: "none" })).rejects.toThrow("shipping with a risk named is retired");
  });
});

describe("0.19.1: a tap on an old card still up writes nothing", () => {
  test("Grant on an old grant card: no grant, its buttons come off with one line, and Cain hears it", async () => {
    const { r, id, writes } = await oldCard("grant");
    const out = await r.tap(r.msg(id), r.ids(id)[0]);
    expect(out).toBe(`refused: ${RETIRED_GRANT}`);
    expect(writes).toEqual([]);
    expect(r.buttons(id)).toEqual([]);
    expect(String(r.msg(id).content)).toContain(RETIRED_GRANT);
    expect(r.state().messages[id]).toMatchObject({ outcome: "expired", why: RETIRED_GRANT });
    const line = r.relayed.find((l) => l.includes("old grant card for pr-46"))!;
    expect(line).toContain('Dane tapped "Grant 1 more round"');
    expect(line).toContain("Nothing to tell him.");
    // Tapped again: a dead tap, still nothing written.
    await r.tap(r.msg(id), `q:${id}:0`);
    expect(writes).toEqual([]);
  });
  test("Ship it with that risk on an old decision card: no decision kept, no hold line, its buttons come off", async () => {
    const { r, id, writes } = await oldCard("decision");
    const out = await r.tap(r.msg(id), r.ids(id)[1]);
    expect(out).toBe(`refused: ${RETIRED_DECISION}`);
    expect(writes).toEqual([]);
    expect(r.buttons(id)).toEqual([]);
    expect(String(r.msg(id).content)).toContain(RETIRED_DECISION);
    expect(r.relayed.find((l) => l.includes("old ship-or-hold card for pr-46"))).toContain(`Dane tapped "${RISK}"`);
    expect(r.ephemerals()).toEqual([]);
  });
  test("Hold it on an old decision card: nothing kept either", async () => {
    const { r, id, writes } = await oldCard("decision");
    await r.tap(r.msg(id), r.ids(id)[0]);
    expect(writes).toEqual([]);
    expect(r.state().messages[id]).toMatchObject({ outcome: "expired", why: RETIRED_DECISION });
  });
  test("an ordinary ask is answered as before", async () => {
    const r = rig({ holds: keeperHolds({}) });
    const res: any = await r.link.ask({ text: "Pause the garden plan?", options: ["One", "Two"], item: "none" });
    await r.tap(r.msg(res.message), r.ids(res.message)[0]);
    expect(String(r.msg(res.message).content)).toContain("You answered: One");
  });
});
