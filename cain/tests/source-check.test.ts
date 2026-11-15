// Source checks before asks (0.12.0): a status is checked at its source before it drives a
// question to him. The record keeper gives each open row a hidden stable id and a version
// that goes up only when its content changes; a check counts only while the version it
// checked is the row's version (never by the clock). The link refuses an ask or a Ship card
// for an item without such a check, re-reads the version right before posting, takes the
// buttons off a posted card once the row moves on, and keeps a one-off from standing in for
// an item's ask. The keeper also refuses a new Item cell that claims two statuses.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_PENDING_MS, STATUS_CHANGED } from "../rootfs/opt/cain/link/core";
import { bundledStatus, checkedCell, checkTextProblem, CHECKS_PATH, contentChanged, openRow, parseChecks, plan, rowHash,
  type Checks, type Request, type Tree } from "../rootfs/opt/cain/record/core.ts";
import { cycle } from "../rootfs/opt/cain/record/main.ts";
import { HOUR, MIN, NOV11_8AM, pendingWith, PR, rig as linkRig, SHA1 } from "./link-rig";
import { PENDING, T0, rig as keeperRig } from "./rig.ts";

const CHECKED = "the county's receipt in his mail, read at 9:40 this morning";
const DAYS = (n: number) => n * 24 * HOUR;
const opts = ["Filed", "Not filed", "Not sure"];
const P = "state/PENDING.md";

// A keeper ledger for the link's tests: id per item, its version, and a check of a version.
const rowId = (item: string) => `r${item.toLowerCase().replace(/[^0-9a-f]/g, "0").padStart(12, "0")}`;
const ledger = (o: Record<string, { version: number; checked_version?: number; changed?: number; checked_at?: number; checked?: string; checked_req?: string }>) => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) out[k] = {
    id: rowId(k), version: v.version, changed: new Date(v.changed ?? NOV11_8AM - DAYS(2)).toISOString(),
    ...(v.checked_version !== undefined ? { checked: v.checked ?? CHECKED, checked_at: new Date(v.checked_at ?? NOV11_8AM - HOUR).toISOString(),
      checked_version: v.checked_version, ...(v.checked_req ? { checked_req: v.checked_req } : {}) } : {}) };
  return JSON.stringify(out);
};

// ---- the record keeper ----
const tree = (files: Record<string, string>): Tree => ({ sha: (p) => (p in files ? "x".repeat(40) : null), read: (p) => files[p] ?? null });
const req = (ops: any[], id = "cain-test-1", from = "cain"): Request => ({ id, from, kind: "change", summary: "s", ops });
// A small record that runs requests through plan() one after another, as the keeper does.
function record(files: Record<string, string> = { [P]: PENDING }, start = T0) {
  let at = start.getTime(), n = 0;
  const r = {
    files,
    run(ops: any[], from = "cain") {
      const p = plan(req(ops, `cain-test-${++n}`, from), tree(files), { at: new Date(at), tz: "America/New_York" });
      if (p.state === "ok") for (const [k, v] of p.writes) { if (v === null) delete files[k]; else files[k] = v; }
      return p;
    },
    ok(ops: any[], from = "cain") { const p = r.run(ops, from); if (p.state !== "ok") throw new Error(`${p.state}: ${p.reason}`); return p; },
    later(ms: number) { at += ms; },
    ledger: (): Checks => parseChecks(files[CHECKS_PATH] ?? null),
    row: (id: string) => openRow(files[P], id)!,
    base: (id: string) => rowHash(openRow(files[P], id)!),
    // A check as the link sends it: the row's id and version as read now.
    check(item: string, text: string) {
      const e = r.ledger()[item];
      return { op: "check", item, text, row: e?.id ?? null, version: e?.version ?? 0 };
    },
    // Every open row's Checked cell is what the ledger says.
    agrees() {
      const L = r.ledger();
      const lines = files[P].split("\n");
      const head = lines.findIndex((l) => l.startsWith("| ID |"));
      const cols = lines[head].split("|").slice(1, -1).map((c) => c.trim());
      const at = cols.indexOf("Checked");
      expect(at).toBeGreaterThan(0);
      for (const line of lines.slice(head + 2)) {
        if (!line.startsWith("|")) break;
        const cs = line.split("|").slice(1, -1).map((c) => c.trim());
        expect(cs[at] ?? "").toBe(checkedCell(L[cs[0]], "America/New_York"));
      }
    },
  };
  return r;
}

describe("the keeper's ledger: row versions and stable ids", () => {
  test("the first write gives every open row a hidden id at version 1 with no check, whatever its Since date", () => {
    const k = record();
    k.ok([{ op: "row", item: "P44", base: k.base("P44"), set: { "Next step": "Build the fix" } }]);
    const L = k.ledger();
    expect(Object.keys(L).sort()).toEqual(["P11", "P33", "P44"]);
    for (const e of Object.values(L)) { expect(e.id).toMatch(/^r[0-9a-f]{12}$/); expect(e.version).toBe(1); expect(e.checked).toBeUndefined(); }
    expect(new Set(Object.values(L).map((e) => e.id)).size).toBe(3);
    // The ids stay in the ledger: no row shows one.
    for (const e of Object.values(L)) expect(k.files[P]).not.toContain(e.id);
  });

  test("a check adds the Checked column, sets the row's cell and ledger entry, and never bumps its own row", () => {
    const k = record();
    k.ok([k.check("P44", CHECKED)]);
    const text = k.files[P];
    expect(text).toContain("| ID | Item | Who | Next step | Waits for | Done when | Since | Checked |");
    expect(text).toContain("|---|---|---|---|---|---|---|---|");
    expect(k.row("P44")).toBe(`| P44 | Calendar specialist fails his plain commands | Build | Hold the Build until P33 lifts | after P33 | His words find his PT event | Nov 11 | fresh, Nov 11, 2026 8:00 AM: ${CHECKED} |`);
    const e = k.ledger().P44;
    expect(e).toMatchObject({ version: 1, checked: CHECKED, checked_version: 1, checked_at: T0.toISOString(), checked_req: "cain-test-1", by: "cain" });
    // Another check of the same version replaces it, and still bumps nothing.
    k.later(HOUR);
    k.ok([k.check("P44", "the specialist's log, read at 9 this morning")]);
    expect(k.ledger().P44).toMatchObject({ version: 1, checked_version: 1, checked: "the specialist's log, read at 9 this morning" });
    expect(k.files[P].match(/Checked/g)!.length).toBe(1);
    k.agrees();
  });

  test("a content change bumps only that row: any cell but Since and Checked, Item and Done when included", () => {
    const k = record();
    k.ok([k.check("P44", CHECKED), k.check("P11", "the pull request on GitHub, read at 8")]);
    const v = () => Object.fromEntries(Object.entries(k.ledger()).map(([id, e]) => [id, e.version]));
    expect(v()).toEqual({ P11: 1, P33: 1, P44: 1 });
    for (const [col, val, want] of [["Who", "Cain", 2], ["Next step", "Build it", 3], ["Waits for", "Dane", 4], ["Item", "The specialist misreads his commands", 5],
      ["Done when", "His words find the event", 6]] as const) {
      k.ok([{ op: "row", item: "P44", base: k.base("P44"), set: { [col]: val } }]);
      expect(v()).toEqual({ P11: 1, P33: 1, P44: want });
    }
    // Editing P44 left P11's check valid.
    expect(k.ledger().P11).toMatchObject({ version: 1, checked_version: 1 });
    expect(k.row("P11")).toContain("| fresh, ");
    expect(k.row("P44")).toContain("| stale, ");
    k.agrees();
    // Since alone isn't content (a put that changes only it bumps nothing).
    const since = k.files[P].replace("| Nov 7 |", "| Nov 8 |");
    expect(contentChanged(k.files[P], since)).toEqual([]);
  });

  test("a whole-file put with the same cells bumps nothing; one that changes one row bumps only it", () => {
    const k = record();
    k.ok([k.check("P44", CHECKED)]);
    const before = k.ledger();
    // Reformatted: wider spaces, the Checked column left off. Nothing but the column changes.
    const wide = PENDING.replace("| P44 | Calendar specialist fails his plain commands |", "|  P44  |   Calendar specialist   fails his plain commands |");
    const same = k.run([{ op: "put", path: P, content: wide, base: "x".repeat(40) }]);
    expect(same.state).toBe("ok");
    expect(k.ledger()).toEqual(before);
    k.agrees();
    // One row changed: only it goes up.
    const one = k.files[P].replace("| P11 | Calendar: each add-on watches the other | Build | Waiting on Dane (Ship) |", "| P11 | Calendar: each add-on watches the other | Build | Shipped |");
    k.ok([{ op: "put", path: P, content: one, base: "x".repeat(40) }]);
    expect(k.ledger().P11.version).toBe(before.P11.version + 1);
    expect(k.ledger().P44).toEqual(before.P44);
    k.agrees();
  });

  test("the Checked column survives a whole-file put without it, and is never read back as input", () => {
    const k = record();
    k.ok([k.check("P44", CHECKED)]);
    // A writer's put carrying its own words in the Checked cell: they're not taken.
    const forged = k.files[P].replace(/\| fresh, [^|]*\|/, "| fresh, Nov 30, 2026: made up |");
    const p = k.run([{ op: "put", path: P, content: forged.replace("| Nov 10 |", "| Nov 10 |"), base: "x".repeat(40) }]);
    expect(p).toMatchObject({ state: "rejected", reason: "changes nothing" });
    // A put of the old shape (no column) that changes a row: the column comes back, cells from the ledger.
    const noColumn = PENDING.replace("| Waiting on Dane (Ship) |", "| Shipped |");
    k.ok([{ op: "put", path: P, content: noColumn, base: "x".repeat(40) }]);
    expect(k.files[P]).toContain("| Since | Checked |");
    expect(k.row("P44")).toEndWith(`| fresh, Nov 11, 2026 8:00 AM: ${CHECKED} |`);
    k.agrees();
  });

  test("ids are stable: an Item edit and a reorder keep them; a row deleted and added again gets a new one, at version 1 with no check", () => {
    const k = record();
    k.ok([k.check("P44", CHECKED)]);
    const id = k.ledger().P44.id;
    // Rename.
    k.ok([{ op: "row", item: "P44", base: k.base("P44"), set: { Item: "The specialist misreads his commands" } }]);
    expect(k.ledger().P44).toMatchObject({ id, version: 2 });
    // Reorder (P44 first): ids and versions unchanged.
    const lines = k.files[P].split("\n");
    const at11 = lines.findIndex((l) => l.startsWith("| P11 ")), at44 = lines.findIndex((l) => l.startsWith("| P44 "));
    [lines[at11], lines[at44]] = [lines[at44], lines[at11]];
    const before = k.ledger();
    k.ok([{ op: "put", path: P, content: lines.join("\n"), base: "x".repeat(40) }]);
    expect(k.ledger()).toEqual(before);
    // Delete, then add again under the same code: a new id, version 1, no check.
    const gone = k.files[P].split("\n").filter((l) => !l.startsWith("| P44 ")).join("\n");
    k.ok([{ op: "put", path: P, content: gone, base: "x".repeat(40) }]);
    expect(k.ledger().P44).toBeUndefined();
    k.later(MIN);
    k.ok([{ op: "row-add", item: "P44", cells: { Item: "The specialist misreads his commands", Who: "Cain" } }]);
    expect(k.ledger().P44.id).not.toBe(id);
    expect(k.ledger().P44).toMatchObject({ version: 1 });
    expect(k.ledger().P44.checked).toBeUndefined();
    k.agrees();
  });

  test("a check is taken only while the row is the version it read; the op names what moved", () => {
    const k = record();
    k.ok([{ op: "row", item: "P44", base: k.base("P44"), set: { "Next step": "Build the fix" } }]);
    const read = k.check("P44", CHECKED);                       // the link reads version 1
    k.ok([{ op: "row", item: "P44", base: k.base("P44"), set: { "Next step": "Build it now" } }]);   // then the row moves on
    const p = k.run([read]);
    expect(p.state).toBe("rejected");
    if (p.state !== "ok") expect(p.reason).toContain("the row changed since the check was read (it checked version 1, the row is now version 2)");
    // A check made before the ledger knew the row counts only while it still doesn't.
    const fresh = record();
    const unledgered = fresh.check("P44", CHECKED);
    expect(unledgered).toMatchObject({ row: null, version: 0 });
    fresh.ok([{ op: "row", item: "P11", base: fresh.base("P11"), set: { Who: "Cain" } }]);   // any write of the list ledgers every row
    expect(fresh.run([unledgered]).state).toBe("rejected");
    // A check from a row that was deleted and added again doesn't count for the new row.
    const again = record();
    again.ok([again.check("P44", CHECKED)]);
    const old = again.check("P44", "the specialist's log, read at noon");
    again.ok([{ op: "row-close", item: "P44", evidence: "fixed" }]);
    again.ok([{ op: "row-add", item: "P46", cells: { Item: "x", Who: "Cain" } }]);
    expect(again.run([old]).state).toBe("rejected");
  });

  test("check text: dates, ISO times, hashes, job ids and codes are fine; it needs where and when, one line, no |, a cap, and no repeat", () => {
    for (const ok of [CHECKED, "GitHub pull request at 2026-11-11T09:40Z, head a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2, job cse_01ABC, for P08",
      "the county portal, Nov 15", "his Gmail inbox, read 11/15 at 9", "checked on the landlord's site just now"])
      expect(checkTextProblem(ok)).toBeNull();
    expect(checkTextProblem("looked into it")).toContain("says when");
    expect(checkTextProblem("looked into it at 9:40")).toContain("says where");
    expect(checkTextProblem("his mail\nat 9:40")).toContain("one line");
    expect(checkTextProblem("his mail | the portal at 9")).toContain("can't hold |");
    expect(checkTextProblem(`his mail at 9:40 ${"x".repeat(300)}`)).toContain("at most 300");
    const k = record();
    k.ok([k.check("P44", CHECKED)]);
    const p = k.run([k.check("P44", `  ${CHECKED.toUpperCase()} `)]);
    expect(p.state).toBe("rejected");
    if (p.state !== "ok") expect(p.reason).toContain("repeats the row's last check word for word");
    expect(k.run([{ ...k.check("P44", "looked into it"), item: "P44" }]).state).not.toBe("ok");
  });

  test("the Checked cell: the check's day with its year, the time when it shares a day with the row's last change, and fresh or stale", () => {
    const e = { id: "r000000000001", version: 2, changed: "2026-11-12T15:00:00.000Z", checked: "his mail at 9", checked_at: "2026-11-11T14:40:00.000Z", checked_version: 2 };
    expect(checkedCell(e)).toBe("fresh, Nov 11, 2026: his mail at 9");
    expect(checkedCell({ ...e, checked_version: 1 })).toBe("stale, Nov 11, 2026: his mail at 9");
    expect(checkedCell({ ...e, changed: "2026-11-11T13:00:00.000Z" })).toBe("fresh, Nov 11, 2026 9:40 AM: his mail at 9");
    expect(checkedCell({ id: "r000000000001", version: 1, changed: e.changed })).toBe("");
  });

  test("no request writes state/checks.json itself; a check on someone else's item is refused; one on no open row isn't applied", () => {
    expect(plan(req([{ op: "put", path: CHECKS_PATH, content: "{}\n", base: "new" }]), tree({ [P]: PENDING }), { at: T0 }))
      .toMatchObject({ state: "rejected", reason: "state/checks.json: not a place requests may write" });
    const holds = { P44: { holder: "laptop:abc", for: "chat", branches: [], taken: T0.toISOString(), renewed: T0.toISOString() } };
    expect(plan(req([{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }]), tree({ [P]: PENDING }), { at: T0, holds }))
      .toMatchObject({ state: "refused" });
    expect(plan(req([{ op: "check", item: "P99", text: CHECKED, row: null, version: 0 }]), tree({ [P]: PENDING }), { at: T0 }).state).not.toBe("ok");
  });

  test("a one-off ask is kept in the request log and writes nothing", () => {
    const p = plan(req([{ op: "one-off", text: "Lunch at noon?" }]), tree({ [P]: PENDING }), { at: T0 });
    expect(p).toMatchObject({ state: "ok" });
    if (p.state === "ok") expect(p.writes.size).toBe(0);
  });
});

describe("one row holds one fact (limited coverage)", () => {
  test("refused only for two completed-status claims about different subjects, naming both", () => {
    expect(bundledStatus("Business license filed Nov 3; land-use packet not filed").refuse).toEqual(["Business license filed Nov 3", "land-use packet not filed"]);
    expect(bundledStatus("Tax return filed. Refund received").refuse).toEqual(["Tax return filed", "Refund received"]);
    expect(bundledStatus("Lease signed, deposit paid on Nov 2").refuse).toEqual(["Lease signed", "deposit paid on Nov 2"]);
  });

  // Realistic rows, with placeholder names and nothing of the owner's.
  const passes = [
    "Business-license packet filed Nov. 3",           // one claim
    "Is the business-license packet filed?",          // one, as a question
    "Filed and sent",                                 // no subject: no claim
    "License filed Nov 3, sent Nov 5",                // one subject; the second clause has none
    "Upload the signed lease and the paid invoice",   // adjectival: a noun follows each
    "Landlord signed lease copy; deposit paid",       // the first is adjectival
    "Permit filed; permit not sent",                  // the same subject
    "Renew the car registration",
    "Calendar: each App watches the other",
    "Get Example Co's signed W-9 and the filed 1099",
    "Insurance claim: confirmed receipt, waiting on adjuster",
  ];
  test.each(passes)("passes: %s", (item) => { expect(bundledStatus(item).refuse).toBeUndefined(); });
  const refused = [
    "Vendor invoice paid; contractor deposit unpaid",
    "Passport renewed - visa not submitted",
    "Router installed, thermostat not installed",
  ];
  test.each(refused)("refused: %s", (item) => { expect(bundledStatus(item).refuse).toBeDefined(); });

  test("a near miss passes with a warning in the keeper's log; a refusal names the clauses", () => {
    expect(bundledStatus("Permit filed; permit not sent").warn).toContain("2 status words");
    expect(bundledStatus("Renew the car registration").warn).toBeUndefined();
    const t: Tree = { sha: () => "x".repeat(40), read: (p) => (p === P ? PENDING : null) };
    const r = (ops: any[]): Request => ({ id: "cain-test-2", from: "cain", kind: "change", summary: "s", ops });
    expect(plan(r([{ op: "row-add", item: "P45", cells: { Item: "Business license filed Nov 3; land-use packet not filed", Who: "Cain" } }]), t, { at: T0 }))
      .toEqual({ state: "rejected", reason: `P45's Item bundles two statuses ("Business license filed Nov 3" and "land-use packet not filed"); one row holds one fact, so give each its own row` });
    const warned = plan(r([{ op: "row-add", item: "P45", cells: { Item: "Permit filed; permit not sent", Who: "Cain" } }]), t, { at: T0 });
    expect(warned).toMatchObject({ state: "ok", warnings: ["P45's Item may hold two statuses (2 status words, but not two claims about different subjects); let through"] });
  });
});

// ---- Cain's link ----
describe("the link asks only on a check of the row as it stands", () => {
  test("an ask for an item with no check is refused in one line; nothing is posted or recorded", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const err = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" }).catch((e) => e);
    expect(String(err.message)).toBe("No source check on this item yet; add --checked with what you checked, where and when.");
    expect(r.posts()).toBe(0);
    expect(r.submitted).toEqual([]);
    // A row with a stale check: the refusal says when it changed.
    r.files.checks = ledger({ P08: { version: 3, checked_version: 2, changed: NOV11_8AM - DAYS(1) } });
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" }))
      .rejects.toThrow("No source check on this item since its row changed on Nov 10; add --checked");
  });

  test("with --checked it goes out, and the check goes to the keeper with the row's id and version as read", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 4 } });
    const out = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED });
    expect(out.status).toBe("posted");
    expect(r.submitted).toEqual([{ id: `link-check-p08-${NOV11_8AM}`, from: "cain", kind: "change",
      summary: `Source check on P08 before asking him: ${CHECKED}`, ops: [{ op: "check", item: "P08", text: CHECKED, row: rowId("P08"), version: 4 }] }]);
    expect(r.state().checks).toEqual({ P08: { text: CHECKED, at: NOV11_8AM, row: rowId("P08"), version: 4, req: `link-check-p08-${NOV11_8AM}` } });
    expect(r.state().messages[(out as any).message].checked).toEqual({ row: rowId("P08"), version: 4, req: `link-check-p08-${NOV11_8AM}` });
  });

  test("a later ask on the same version needs no new check, from the keeper's ledger alone; after a change it does", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 2, checked_version: 2 } });
    expect((await r.link.ask({ text: "Was it the land-use one?", options: ["Yes", "No"], item: "P08", question: "Q3" })).status).toBe("posted");
    expect(r.submitted).toEqual([]);
    r.files.checks = ledger({ P08: { version: 3, checked_version: 2, changed: NOV11_8AM } });
    await expect(r.link.ask({ text: "Is the permit sent?", options: ["Sent", "Not sent"], item: "P08", question: "Q4" }))
      .rejects.toThrow("No source check on this item since its row changed on Nov 11; add --checked");
  });

  test("equal timestamps and clock steps don't matter: only versions do", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08", "P09"], []) });
    // Changed and checked at the same instant: P08's check is of the version before, P09's of this one.
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, changed: NOV11_8AM, checked_at: NOV11_8AM },
      P09: { version: 2, checked_version: 2, changed: NOV11_8AM, checked_at: NOV11_8AM } });
    await expect(r.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q1" })).rejects.toThrow("No source check on this item since");
    expect((await r.link.ask({ text: "Is it sent?", options: ["Sent", "Not sent"], item: "P09", question: "Q1" })).status).toBe("posted");
    // A check stamped after a change it predates (the clock stepped back) still doesn't count; one
    // stamped before the change of its own version (stepped forward) still does.
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, changed: NOV11_8AM, checked_at: NOV11_8AM + DAYS(1) },
      P09: { version: 2, checked_version: 2, changed: NOV11_8AM, checked_at: NOV11_8AM - DAYS(1) } });
    await r.link.answered({ item: "P09", question: "Q1" });
    await expect(r.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q2" })).rejects.toThrow("No source check on this item since");
    r.later(-DAYS(3));
    expect((await r.link.ask({ text: "Is it sent yet?", options: ["Sent", "Not sent"], item: "P09", question: "Q2" })).status).toBe("posted");
  });

  test("a row change between the read and the post refuses the ask (the version is read again right before posting)", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 1 } });
    // While the check goes into the keeper's queue, another change to the row lands.
    (r as any).submitted.push = (q: any) => { r.files.checks = ledger({ P08: { version: 2, changed: NOV11_8AM } }); return Array.prototype.push.call(r.submitted, q); };
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }))
      .rejects.toThrow("its row changed after your source check");
    expect(r.posts()).toBe(0);
  });

  test("a delayed delivery the keeper rejects: the link's copy is purged and Cain is told", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08", "P09"], []) });
    r.files.checks = ledger({ P08: { version: 1 } });
    expect((await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED })).status).toBe("posted");
    const sent = r.submitted[0];
    // The row moved on before the keeper's round; the keeper (its real rules) rejects the check.
    const k = record({ [P]: pendingWith(["P08"], []) });
    k.ok([{ op: "row", item: "P08", base: k.base("P08"), set: { Who: "Dane" } }]);
    const read = { ...sent.ops[0], row: k.ledger().P08.id, version: 1 };
    k.ok([{ op: "row", item: "P08", base: k.base("P08"), set: { Who: "Cain" } }]);
    const p = k.run([read]);
    expect(p.state).toBe("rejected");
    r.outcomes[sent.id] = { state: "rejected", reason: p.state !== "ok" ? p.reason : "" };
    r.files.checks = ledger({ P08: { version: 2, changed: NOV11_8AM } });
    await r.link.sweep();
    expect(r.state().checks).toEqual({});
    expect(r.relayed.join(" ")).toContain("Your source check on P08 wasn't recorded: the record keeper said rejected, check P08: the row changed since the check was read");
    // Its card came off, and the next ask needs a new check.
    expect(r.msg((Object.keys(r.state().messages))[0]).content).toContain(STATUS_CHANGED);
    await expect(r.link.ask({ text: "Is it filed now?", options: opts, item: "P08", question: "Q3" })).rejects.toThrow("No source check on this item");
  });

  test("a check the keeper hasn't settled counts only until it times out; then it's purged and Cain is told", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const first = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED });
    expect(first.status).toBe("posted");
    r.later(CHECK_PENDING_MS - 1000);
    expect((await r.link.ask({ text: "Was it the land-use one?", options: ["Yes", "No"], item: "P08", question: "Q3" })).status).toBe("held");
    r.later(2000);
    await expect(r.link.ask({ text: "Was it the business one?", options: ["Yes", "No"], item: "P08", question: "Q4" })).rejects.toThrow("No source check on this item yet");
    expect(r.state().checks).toEqual({});
    expect(r.relayed.join(" ")).toContain(`Your source check on P08 wasn't recorded within ${CHECK_PENDING_MS / 60_000} minutes, so it no longer counts`);
  });

  test("a held ask whose row changes after its check is dropped unasked", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08", "P11"], []) });
    r.files.checks = ledger({ P08: { version: 1, checked_version: 1 } });
    await r.link.ask({ text: "Lunch at noon?", options: ["Yes", "No"], item: "none" });
    expect((await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" })).status).toBe("held");
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, changed: NOV11_8AM } });
    await r.link.answered({ item: "none" }).catch(() => {});
    await r.link.releaseHeld();
    expect(r.relayed.join(" ")).toContain("was dropped unasked: its row changed after your source check");
    expect(r.posts()).toBe(1);
  });

  test("check text: dates and codes are fine in it; one without where or when, or repeated word for word, is refused", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, checked: CHECKED } });
    const ask = (checked: string, question = "Q2") => r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question, checked });
    await expect(ask("looked again")).rejects.toThrow("says when it was checked");
    await expect(ask("looked again at 9:40")).rejects.toThrow("says where it was checked");
    await expect(ask("his mail\nthis morning")).rejects.toThrow("one line");
    await expect(ask("his mail | the portal at 9")).rejects.toThrow("can't hold |");
    await expect(ask(CHECKED)).rejects.toThrow("repeats the row's last one word for word");
    expect(r.posts()).toBe(0);
    expect((await ask("county portal at 2026-11-11T09:40, receipt for P08")).status).toBe("posted");
  });

  test("a Ship card follows the same rule", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41"], []) });
    const card = { item: "P41", pr: PR, head: SHA1, text: "Stop stays within reach of your newest message." };
    await expect(r.link.ship(card)).rejects.toThrow("No source check on this item yet; add --checked");
    expect(r.posts()).toBe(0);
    const out = await r.link.ship({ ...card, checked: "the pull request on GitHub, open at that head, read at 8 this morning" });
    expect(out.status).toBe("posted");
    expect(r.submitted.map((q) => q.ops)).toEqual([[{ op: "check", item: "P41", text: "the pull request on GitHub, open at that head, read at 8 this morning", row: null, version: 0 }]]);
  });

  test("the link refuses a check it can't hand to the keeper, unless the App's warn-only switch is on", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    (r as any).submitted.push = () => { throw new Error("disk full"); };
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }))
      .rejects.toThrow("the source check couldn't be handed to the record keeper (Error: disk full)");
    expect(r.posts()).toBe(0);
    const w = linkRig({ unchecked: true, warnOnly: true, pending: pendingWith(["P08"], []) });
    (w as any).submitted.push = () => { throw new Error("disk full"); };
    expect((await w.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED })).status).toBe("posted");
    expect(w.logs.join(" ")).toContain("warning: the source check couldn't be handed to the record keeper");
    // Without a check at all, warn-only refuses as before.
    await w.link.answered({ item: "P08", question: "Q2" });
    await expect(w.link.ask({ text: "Is it sent?", options: ["Sent", "Not sent"], item: "P08", question: "Q3" })).rejects.toThrow("No source check");
  });
});

describe("posted asks and Ship cards lose their buttons when the row moves on", () => {
  test("the sweep takes an ask's buttons off ('Status changed, re-check needed') and tells Cain", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 1, checked_version: 1 } });
    const id = (await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" }) as any).message;
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(opts);                       // nothing moved: it stays
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, changed: NOV11_8AM } });
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toEndWith(`\n\n${STATUS_CHANGED}`);
    expect(r.relayed.join(" ")).toContain(`P08's row changed after the source check it rested on, so its buttons came off ("${STATUS_CHANGED}")`);
  });

  test("a tap on one before the sweep is refused with that reason", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 1, checked_version: 1 } });
    const id = (await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" }) as any).message;
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, changed: NOV11_8AM } });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("dead: status changed");
    expect(r.msg(id).content).toEndWith(`\n\n${STATUS_CHANGED}`);
    expect(r.ephemerals().map((b: any) => b.content)).toContain("Its status changed since it was checked, so nothing was done.");
    expect(r.relayed.join(" ")).not.toContain("Dane tapped");
  });

  test("a Ship card too; and a check the keeper took from an unledgered row keeps its card", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41"], []) });
    const out = await r.link.ship({ item: "P41", pr: PR, head: SHA1, text: "Stop stays within reach of your newest message.",
      checked: "the pull request on GitHub, open at that head, read at 8 this morning" }) as any;
    const sent = r.submitted[0];
    // The keeper takes the check: the row gets its id at version 1 with that check.
    r.outcomes[sent.id] = { state: "done" };
    r.files.checks = ledger({ P41: { version: 1, checked_version: 1, checked_req: sent.id } });
    await r.link.sweep();
    expect(r.buttons(out.message)).toEqual(["Ship", "Not now"]);
    r.files.checks = ledger({ P41: { version: 2, checked_version: 1, checked_req: sent.id, changed: NOV11_8AM } });
    await r.link.sweep();
    expect(r.buttons(out.message)).toEqual([]);
    expect(r.msg(out.message).content).toEndWith(`\n\n${STATUS_CHANGED}`);
  });
});

describe("one-off asks", () => {
  test("a one-off that reads as an open item is refused, naming it; every one-off goes into the request log", async () => {
    const pending = pendingWith(["P08"], []).replace("| P08 | Something |", "| P08 | Business-license packet for the county |");
    const r = linkRig({ unchecked: true, pending });
    await expect(r.link.ask({ text: "Is the county business-license packet in?", options: ["Yes", "No"], item: "none" }))
      .rejects.toThrow(`This one-off reads as being about P08 ("Business-license packet for the county"): ask it with --item P08 and a --checked source check`);
    expect(r.posts()).toBe(0);
    expect(r.submitted).toEqual([]);
    expect((await r.link.ask({ text: "Lunch at noon?", options: ["Yes", "No"], item: "none" })).status).toBe("posted");
    expect(r.submitted).toEqual([{ id: `link-oneoff-${NOV11_8AM}`, from: "cain", kind: "change", summary: "One-off ask to him: Lunch at noon?",
      ops: [{ op: "one-off", text: "Lunch at noon?" }] }]);
  });
});

describe("end to end: the link and the record keeper on a real git repo", () => {
  test("refused, checked, recorded on the row and in the log, reused, then needed again after a change; a one-off is logged", () => {
    const k = keeperRig();
    const l = linkRig({ unchecked: true, pending: PENDING });
    const read = (p: string) => { try { return readFileSync(join(k.cfg.dir, p), "utf8"); } catch { return null; } };
    let n = 0;
    const run = async () => {
      for (const q of l.submitted.splice(0)) writeFileSync(join(k.cfg.queue, `${String(++n).padStart(4, "0")}-${q.id}.json`), JSON.stringify(q));
      expect(cycle(k.cfg).ok).toBe(true);
      l.files.pending = read(P);
      l.files.checks = read(CHECKS_PATH);
      for (const o of k.log()) l.outcomes[o.id] = { state: o.state, reason: o.reason };
    };
    return (async () => {
      const ask = (q: string, checked?: string) => l.link.ask({ text: "Is the specialist fixed?", options: ["Fixed", "Not fixed"], item: "P44", question: q, ...(checked ? { checked } : {}) });
      await expect(ask("Q1")).rejects.toThrow("No source check on this item yet");
      const q1 = await ask("Q1", "the specialist's log, read at 8 this morning") as any;
      expect(q1.status).toBe("posted");
      k.at(new Date(T0.getTime() + MIN));
      await run();
      expect(k.states(`link-check-p44-${NOV11_8AM}`)).toEqual(["done"]);
      expect(openRow(k.upstream(P), "P44")).toEndWith("| fresh, Nov 11, 2026 8:01 AM: the specialist's log, read at 8 this morning |");
      expect(parseChecks(k.upstream(CHECKS_PATH)).P44).toMatchObject({ version: 1, checked_version: 1, checked: "the specialist's log, read at 8 this morning" });
      await l.link.sweep();
      expect(l.buttons(q1.message)).toEqual(["Fixed", "Not fixed"]);   // the keeper's id for the row keeps the card
      expect(l.state().checks).toEqual({});
      // From the ledger alone, a later ask on the same version passes.
      l.later(5 * MIN);
      expect((await ask("Q2")).status).toBe("held");
      // Cain moves the row on: its version goes up, the posted card comes off, the held ask is dropped.
      k.at(new Date(T0.getTime() + 10 * MIN));
      k.cain({ id: "cain-next-1", ops: [{ op: "row", item: "P44", base: rowHash(openRow(read(P), "P44")!), set: { "Next step": "Build the fix" } }] });
      await run();
      expect(k.states("cain-next-1")).toEqual(["done"]);
      expect(parseChecks(read(CHECKS_PATH)).P44).toMatchObject({ version: 2, checked_version: 1 });
      expect(openRow(read(P), "P44")).toContain("| Build the fix |");
      expect(openRow(read(P), "P44")).toContain("| stale, Nov 11, 2026 8:01 AM: the specialist's log");
      await l.link.sweep();
      expect(l.buttons(q1.message)).toEqual([]);
      expect(l.relayed.join(" ")).toContain("was dropped unasked: its row changed after your source check");
      l.later(10 * MIN);
      await expect(ask("Q3")).rejects.toThrow("No source check on this item since its row changed on Nov 11");
      expect((await ask("Q3", "the specialist's log again, read at 8:20")).status).toBe("posted");
      // A one-off goes into the request log.
      await l.link.answered({ item: "P44", question: "Q3" });
      expect((await l.link.ask({ text: "Lunch at noon?", options: ["Yes", "No"], item: "none" })).status).toBe("posted");
      await run();
      expect(k.log().filter((o) => o.summary === "One-off ask to him: Lunch at noon?").map((o) => o.state)).toEqual(["done"]);
      // A row-add that bundles two statuses is refused there too.
      k.cain({ id: "cain-add-1", ops: [{ op: "row-add", item: "P45", cells: { Item: "Business license filed Nov 3; land-use packet not filed", Who: "Cain" } }] });
      await run();
      expect(k.outcome("cain-add-1")).toMatchObject({ state: "rejected" });
      expect(k.reason("cain-add-1")).toContain("bundles two statuses");
    })();
  }, 60_000);
});
