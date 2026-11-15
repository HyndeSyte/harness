// Source checks before asks (0.12.0): a status is checked at its source before it drives a
// question to him. The link refuses an ask or a Ship card for an item whose row carries no
// source check newer than its last status change; a check passed with --checked goes to the
// record keeper, which shows it on the row and keeps it in state/checks.json with the row's
// status changes. The keeper also refuses a new Item cell that bundles two statuses.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundledStatus, CHECKS_PATH, openRow, parseChecks, plan, rowHash, statusChanged, type Request, type Tree } from "../rootfs/opt/cain/record/core.ts";
import { cycle } from "../rootfs/opt/cain/record/main.ts";
import { HOUR, keeperHolds, MIN, NOV11_8AM, pendingWith, PR, rig as linkRig, SHA1 } from "./link-rig";
import { A, PENDING, T0, rig as keeperRig } from "./rig.ts";

const CHECKED = "the county's receipt in his mail, read at 9:40 this morning";
const ledger = (o: Record<string, { changed?: number; checked_at?: number; checked?: string }>) => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) out[k] = {
    ...(v.changed !== undefined ? { changed: new Date(v.changed).toISOString() } : {}),
    ...(v.checked_at !== undefined ? { checked: v.checked ?? CHECKED, checked_at: new Date(v.checked_at).toISOString() } : {}) };
  return JSON.stringify(out);
};
const opts = ["Filed", "Not filed", "Not sure"];

describe("the link asks only after a fresh source check", () => {
  test("an ask for an item with no check is refused in one line, and nothing is posted or recorded", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const err = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" }).catch((e) => e);
    expect(String(err.message)).toBe("No source check on this item since its row changed on Nov 9; add --checked with what you checked, where and when.");
    expect(err.message).not.toContain("\n");
    expect(r.posts()).toBe(0);
    expect(r.submitted).toEqual([]);
    // With no row date to go by, it says so without one.
    const bare = linkRig({ unchecked: true });
    await expect(bare.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q1" }))
      .rejects.toThrow("No source check on this item yet; add --checked");
    expect(bare.posts()).toBe(0);
  });

  test("the same ask with --checked goes out, and the check goes to the record keeper", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const out = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED });
    expect(out.status).toBe("posted");
    expect(r.posts()).toBe(1);
    expect(r.submitted).toEqual([{ id: `link-check-p08-${NOV11_8AM}`, from: "cain", kind: "change",
      summary: `Source check on P08 before asking him: ${CHECKED}`, ops: [{ op: "check", item: "P08", text: CHECKED }] }]);
    expect(r.state().checks).toEqual({ P08: { text: CHECKED, at: NOV11_8AM } });
  });

  test("a later ask on the same item, with its status unchanged, needs no new check", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED });
    r.later(10 * MIN);
    // Before the keeper's round (the link's own copy of the check)...
    expect((await r.link.ask({ text: "Was it the land-use one?", options: ["Yes", "No"], item: "P08", question: "Q3" })).status).toBe("held");
    // ...and after it, from the keeper's ledger alone.
    r.setState({ ...r.state(), checks: {} });
    r.files.checks = ledger({ P08: { changed: NOV11_8AM - DAYS(2), checked_at: NOV11_8AM + 1000 } });
    expect((await r.link.ask({ text: "Was it the business one?", options: ["Yes", "No"], item: "P08", question: "Q4" })).status).toBe("held");
    expect(r.submitted.length).toBe(1);
  });

  test("after the row's status changes, the next ask needs a new check", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED });
    r.later(HOUR);
    // The keeper took the check, then stamped a change to the row's Who, Next step or Waits for.
    r.files.checks = ledger({ P08: { checked_at: NOV11_8AM + 1000, changed: NOV11_8AM + 30 * MIN } });
    await expect(r.link.ask({ text: "Is the permit sent?", options: ["Sent", "Not sent"], item: "P08", question: "Q3" }))
      .rejects.toThrow("No source check on this item since its row changed on Nov 11; add --checked");
    const again = await r.link.ask({ text: "Is the permit sent?", options: ["Sent", "Not sent"], item: "P08", question: "Q3",
      checked: "the permit office's portal, read at 9 this morning" });
    expect(["posted", "held"]).toContain(again.status);
    expect(r.submitted.length).toBe(2);
  });

  test("a one-off ask (--item none) needs no check", async () => {
    const r = linkRig({ unchecked: true });
    expect((await r.link.ask({ text: "Lunch at noon?", options: ["Yes", "No"], item: "none" })).status).toBe("posted");
    expect(r.submitted).toEqual([]);
  });

  test("a Ship card follows the same rule", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41"], []) });
    const card = { item: "P41", pr: PR, head: SHA1, text: "Stop stays within reach of your newest message." };
    await expect(r.link.ship(card)).rejects.toThrow("No source check on this item since its row changed on Nov 9; add --checked");
    expect(r.posts()).toBe(0);
    expect(r.submitted).toEqual([]);
    const out = await r.link.ship({ ...card, checked: "the pull request on GitHub, open at that head, read at 8 this morning" });
    expect(out.status).toBe("posted");
    expect(r.submitted.map((q) => q.ops)).toEqual([[{ op: "check", item: "P41", text: "the pull request on GitHub, open at that head, read at 8 this morning" }]]);
  });

  test("a check with an ISO time or a record code, or on two lines, is refused by the link's text rules", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const ask = (checked: string) => r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked });
    await expect(ask("his mail at 2026-11-11T09:40")).rejects.toThrow("a source check can't hold an ISO time");
    await expect(ask("the receipt filed under P08")).rejects.toThrow("a source check can't hold a record code");
    await expect(ask("his mail\nthis morning")).rejects.toThrow("a source check is one line");
    await expect(ask("his mail | the portal")).rejects.toThrow("can't hold |");
    expect(r.posts()).toBe(0);
    expect(r.submitted).toEqual([]);
  });

  test("a held ask whose row changes after its check is dropped unasked", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08", "P11"], []) });
    const first = await r.link.ask({ text: "Lunch at noon?", options: ["Yes", "No"], item: "none" });
    expect((await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED })).status).toBe("held");
    r.later(MIN);
    r.files.checks = ledger({ P08: { checked_at: NOV11_8AM + 1000, changed: NOV11_8AM + 30_000 } });
    r.setState({ ...r.state(), checks: {} });
    await r.link.answered({ item: "none" }).catch(() => {});
    await r.link.releaseHeld();
    expect(r.relayed.join(" ")).toContain("was dropped unasked: its row changed after your source check");
    expect(r.posts()).toBe(1);
    expect(first.status).toBe("posted");
  });

  test("the link refuses a check it can't hand to the record keeper", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []), holds: keeperHolds({}) });
    (r as any).submitted.push = () => { throw new Error("disk full"); };
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }))
      .rejects.toThrow("couldn't be handed to the record keeper");
    expect(r.posts()).toBe(0);
  });
});

const DAYS = (n: number) => n * 24 * HOUR;

describe("the record keeper keeps source checks and status changes", () => {
  const tree = (files: Record<string, string>): Tree => ({ sha: (p) => (p in files ? "x".repeat(40) : null), read: (p) => files[p] ?? null });
  const req = (ops: any[], from = "cain"): Request => ({ id: "cain-test-1", from, kind: "change", summary: "s", ops });

  test("a check adds the Checked column once, sets the row's cell and the ledger, and stamps no status change", () => {
    const p = plan(req([{ op: "check", item: "P44", text: CHECKED }]), tree({ "state/PENDING.md": PENDING }), { at: T0 });
    if (p.state !== "ok") throw new Error(p.reason);
    const text = p.writes.get("state/PENDING.md")!;
    expect(text).toContain("| ID | Item | Who | Next step | Waits for | Done when | Since | Checked |");
    expect(text).toContain("|---|---|---|---|---|---|---|---|");
    expect(openRow(text, "P44")).toBe(`| P44 | Calendar specialist fails his plain commands | Build | Hold the Build until P33 lifts | after P33 | His words find his PT event | Nov 11 | Nov 11: ${CHECKED} |`);
    expect(parseChecks(p.writes.get(CHECKS_PATH)!)).toEqual({ P44: { checked: CHECKED, checked_at: T0.toISOString(), by: "cain" } });
    // A second check replaces the cell, and the column stays one.
    const q = plan(req([{ op: "check", item: "P44", text: "the specialist's log, read at noon" }]),
      tree({ "state/PENDING.md": text, [CHECKS_PATH]: p.writes.get(CHECKS_PATH)! }), { at: new Date(T0.getTime() + HOUR) });
    if (q.state !== "ok") throw new Error(q.reason);
    expect(q.writes.get("state/PENDING.md")!.match(/Checked/g)!.length).toBe(1);
    expect(openRow(q.writes.get("state/PENDING.md")!, "P44")).toEndWith("| Nov 11: the specialist's log, read at noon |");
  });

  test("a change to Who, Next step or Waits for is stamped; Item and Done when, or a check, are not", () => {
    const set = (k: string, v: string) => PENDING.replace("| P44 | Calendar specialist fails his plain commands | Build | Hold the Build until P33 lifts | after P33 | His words find his PT event | Nov 11 |",
      ({ Who: `| P44 | Calendar specialist fails his plain commands | ${v} | Hold the Build until P33 lifts | after P33 | His words find his PT event | Nov 11 |`,
         "Next step": `| P44 | Calendar specialist fails his plain commands | Build | ${v} | after P33 | His words find his PT event | Nov 11 |`,
         "Waits for": `| P44 | Calendar specialist fails his plain commands | Build | Hold the Build until P33 lifts | ${v} | His words find his PT event | Nov 11 |`,
         Item: `| P44 | ${v} | Build | Hold the Build until P33 lifts | after P33 | His words find his PT event | Nov 11 |`,
         "Done when": `| P44 | Calendar specialist fails his plain commands | Build | Hold the Build until P33 lifts | after P33 | ${v} | Nov 11 |` } as any)[k]);
    for (const k of ["Who", "Next step", "Waits for"]) expect(statusChanged(PENDING, set(k, "Cain"))).toEqual(["P44"]);
    for (const k of ["Item", "Done when"]) expect(statusChanged(PENDING, set(k, "Something else"))).toEqual([]);
    const p = plan(req([{ op: "row", item: "P44", base: rowHash(openRow(PENDING, "P44")!), set: { "Waits for": "Dane" } }]),
      tree({ "state/PENDING.md": PENDING }), { at: T0 });
    if (p.state !== "ok") throw new Error(p.reason);
    expect(parseChecks(p.writes.get(CHECKS_PATH)!)).toEqual({ P44: { changed: T0.toISOString() } });
  });

  test("no request writes state/checks.json itself", () => {
    const p = plan(req([{ op: "put", path: CHECKS_PATH, content: "{}\n", base: "new" }]), tree({ "state/PENDING.md": PENDING }), { at: T0 });
    expect(p).toMatchObject({ state: "rejected", reason: "state/checks.json: not a place requests may write" });
  });

  test("a check on an item someone else holds is refused, and one on no open row isn't applied", () => {
    const holds = { P44: { holder: A, for: "chat", branches: [], taken: T0.toISOString(), renewed: T0.toISOString() } };
    expect(plan(req([{ op: "check", item: "P44", text: CHECKED }]), tree({ "state/PENDING.md": PENDING }), { at: T0, holds }))
      .toMatchObject({ state: "refused" });
    expect(plan(req([{ op: "check", item: "P99", text: CHECKED }]), tree({ "state/PENDING.md": PENDING }), { at: T0 }).state).not.toBe("ok");
  });
});

describe("one row holds one fact", () => {
  test("an Item cell with two status claims in separate clauses is bundled; one, or none, is not", () => {
    expect(bundledStatus("Business license filed Nov 3; land-use packet not filed")).toEqual(["Business license filed Nov 3", "land-use packet not filed"]);
    expect(bundledStatus("License filed Nov 3, sent Nov 5")).toEqual(["License filed Nov 3", "sent Nov 5"]);
    expect(bundledStatus("Tax return filed. Refund received")).toEqual(["Tax return filed", "Refund received"]);
    expect(bundledStatus("Business-license packet filed Nov. 3")).toBeNull();
    expect(bundledStatus("Is the business-license packet filed?")).toBeNull();
    expect(bundledStatus("Filed and sent")).toBeNull();             // no subject or date: no claim
    expect(bundledStatus("Renew the car registration")).toBeNull();
    expect(bundledStatus("Calendar: each App watches the other")).toBeNull();
  });

  test("the keeper refuses a row-add or row op whose Item bundles two, and takes a single status", () => {
    const t: Tree = { sha: () => "x".repeat(40), read: (p) => (p === "state/PENDING.md" ? PENDING : null) };
    const r = (ops: any[]): Request => ({ id: "cain-test-2", from: "cain", kind: "change", summary: "s", ops });
    expect(plan(r([{ op: "row-add", item: "P45", cells: { Item: "Business license filed Nov 3; land-use packet not filed", Who: "Cain" } }]), t, { at: T0 }))
      .toEqual({ state: "rejected", reason: `P45's Item bundles two statuses ("Business license filed Nov 3" and "land-use packet not filed"); one row holds one fact, so give each its own row` });
    expect(plan(r([{ op: "row", item: "P44", base: rowHash(openRow(PENDING, "P44")!), set: { Item: "Tax return filed. Refund received" } }]), t, { at: T0 }).state).toBe("rejected");
    const ok = plan(r([{ op: "row-add", item: "P45", cells: { Item: "Business license filed Nov 3", Who: "Cain" } }]), t, { at: T0 });
    expect(ok.state).toBe("ok");
    // A new row is its first status: stamped.
    if (ok.state === "ok") expect(parseChecks(ok.writes.get(CHECKS_PATH)!)).toEqual({ P45: { changed: T0.toISOString() } });
  });
});

describe("end to end: the link and the record keeper on a real git repo", () => {
  test("refused, checked, recorded on the row and in the log, reused, then needed again after a status change", () => {
    const k = keeperRig();
    const l = linkRig({ unchecked: true, pending: PENDING });
    const read = (p: string) => { try { return readFileSync(join(k.cfg.dir, p), "utf8"); } catch { return null; } };
    // The keeper's copy is what the link reads; requests the link hands over go in its queue.
    let n = 0;
    const run = async () => {
      for (const q of l.submitted.splice(0)) writeFileSync(join(k.cfg.queue, `${String(++n).padStart(4, "0")}-${q.id}.json`), JSON.stringify(q));
      expect(cycle(k.cfg).ok).toBe(true);
      l.files.pending = read("state/PENDING.md");
      l.files.checks = read(CHECKS_PATH);
    };
    return (async () => {
      const ask = (q: string, checked?: string) => l.link.ask({ text: "Is the specialist fixed?", options: ["Fixed", "Not fixed"], item: "P44", question: q, ...(checked ? { checked } : {}) });
      await expect(ask("Q1")).rejects.toThrow("No source check on this item since its row changed on Nov 11");
      expect((await ask("Q1", "the specialist's log, read at 8 this morning")).status).toBe("posted");
      k.at(new Date(T0.getTime() + MIN));
      await run();
      expect(k.states(`link-check-p44-${NOV11_8AM}`)).toEqual(["done"]);
      expect(openRow(k.upstream("state/PENDING.md"), "P44")).toEndWith("| Nov 11: the specialist's log, read at 8 this morning |");
      expect(parseChecks(k.upstream(CHECKS_PATH)).P44).toMatchObject({ checked: "the specialist's log, read at 8 this morning", checked_at: new Date(T0.getTime() + MIN).toISOString() });
      // From the ledger alone, a later ask within the same status passes.
      l.setState({ ...l.state(), checks: {} });
      l.later(5 * MIN);
      expect(["posted", "held"]).toContain((await ask("Q2")).status);
      // Cain moves the row on (its Next step): the keeper stamps it, and the next ask needs a new check.
      k.at(new Date(T0.getTime() + 10 * MIN));
      k.cain({ id: "cain-next-1", ops: [{ op: "row", item: "P44", base: rowHash(openRow(read("state/PENDING.md"), "P44")!), set: { "Next step": "Build the fix" } }] });
      await run();
      expect(k.states("cain-next-1")).toEqual(["done"]);
      expect(openRow(read("state/PENDING.md"), "P44")).toContain("| Build the fix |");
      expect(openRow(read("state/PENDING.md"), "P44")).toEndWith("| Nov 11: the specialist's log, read at 8 this morning |");   // row ops keep it
      l.later(10 * MIN);
      await expect(ask("Q3")).rejects.toThrow("No source check on this item since its row changed on Nov 11");
      expect(["posted", "held"]).toContain((await ask("Q3", "the specialist's log again, read at 8:20")).status);
      // A row-add that bundles two statuses is refused there too.
      k.cain({ id: "cain-add-1", ops: [{ op: "row-add", item: "P45", cells: { Item: "Business license filed Nov 3; land-use packet not filed", Who: "Cain" } }] });
      await run();
      expect(k.outcome("cain-add-1")).toMatchObject({ state: "rejected" });
      expect(k.reason("cain-add-1")).toContain("bundles two statuses");
    })();
  }, 60_000);
});
