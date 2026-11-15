// Source checks before asks (0.12.0): a status is checked at its source before it drives a
// question to him. The record keeper gives each open row a hidden stable id (matched by item
// code) and a version that goes up only when its content changes; a check counts only while
// the version it checked is the row's version and it is no older than the App's
// source_check_max_days. The link posts an ask or a Ship card for an item only once the
// keeper accepted such a check (a pending one never posts), re-reads the version right before
// posting, takes the buttons off a posted card once the row moves on, refuses a one-off that
// names an open item outright, and holds looser matches until re-declared (round3 tests). The
// keeper also refuses a whole-file write with a row that claims two statuses, whole.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_WAIT_MS, STATUS_CHANGED } from "../rootfs/opt/cain/link/core";
import { bundledStatus, checkedCell, checkTextProblem, CHECKS_PATH, contentChanged, ONE_OFF_AUDIT_PATH, oneOffAudit, oneOffHit, oneOffLoose,
  openRow, parseChecks, parseRequest, plan, repeatsCheck, rowHash, type Checks, type Request, type Tree } from "../rootfs/opt/cain/record/core.ts";
import { cycle } from "../rootfs/opt/cain/record/main.ts";
import { HOUR, MIN, NOV11_8AM, pendingWith, PR, rig as linkRig, SHA1 } from "./link-rig";
import { PENDING, T0, rig as keeperRig } from "./rig.ts";

const CHECKED = "the county.gov receipt in his mail, dated Nov 10, read at 9:40 this morning";
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
      checked_version: v.checked_version, checked_req: v.checked_req ?? seedReq(k) } : {}) };
  return JSON.stringify(out);
};
// The request that carried a seeded check, and its outcome (done) as the keeper wrote it: a tap
// is honoured only once that outcome reads done.
const seedReq = (item: string) => `link-check-${item.toLowerCase()}-seed`;
const seeded = (r: { outcomes: Record<string, { state: string }> }, ...items: string[]) => { for (const i of items) r.outcomes[seedReq(i)] = { state: "done" }; };

// ---- the record keeper ----
const tree = (files: Record<string, string>): Tree => ({ sha: (p) => (p in files ? "x".repeat(40) : null), read: (p) => files[p] ?? null });
const req = (ops: any[], id = "cain-test-1", from = "cain"): Request => ({ id, from, kind: "change", summary: "s", ops });
// A small record that runs requests through plan() one after another, as the keeper does.
function record(files: Record<string, string> = { [P]: PENDING }, start = T0, maxCheckDays?: number) {
  let at = start.getTime(), n = 0;
  const r = {
    files,
    run(ops: any[], from = "cain") {
      const p = plan(req(ops, `cain-test-${++n}`, from), tree(files), { at: new Date(at), tz: "America/New_York", maxCheckDays, clockSynced: true });
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
        expect(cs[at] ?? "").toBe(checkedCell(L[cs[0]], "America/New_York", maxCheckDays));
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
    expect(k.row("P44")).toBe(`| P44 | Calendar specialist fails his plain commands | Build | Hold the Build until P33 lifts | after P33 | His words find his PT event | Nov 11 | fresh, Nov 11, 2026 8:00 AM, stale after Nov 18: ${CHECKED} |`);
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
    const forged = k.files[P].replace(/\| fresh, [^|]*\|/, "| fresh, Nov 30, 2026, stale after Dec 7: made up |");
    const p = k.run([{ op: "put", path: P, content: forged.replace("| Nov 10 |", "| Nov 10 |"), base: "x".repeat(40) }]);
    expect(p).toMatchObject({ state: "rejected", reason: "changes nothing" });
    // A put of the old shape (no column) that changes a row: the column comes back, cells from the ledger.
    const noColumn = PENDING.replace("| Waiting on Dane (Ship) |", "| Shipped |");
    k.ok([{ op: "put", path: P, content: noColumn, base: "x".repeat(40) }]);
    expect(k.files[P]).toContain("| Since | Checked |");
    expect(k.row("P44")).toEndWith(`| fresh, Nov 11, 2026 8:00 AM, stale after Nov 18: ${CHECKED} |`);
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

  test("check text: dates, ISO times, hashes, job ids and codes are fine; it says when and names a concrete source", () => {
    for (const ok of [CHECKED, "GitHub pull request at 2026-11-11T09:40Z, head a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2, job cse_01ABC, for P08",
      "the county portal, Nov 15", "checked on the landlord's site just now", "areas/home/places.md in the record, read at 9:40",
      "ran `gh pr view 22` at 9:40", "his text from the plumber, Nov 14 at 3 pm", "the receipt mail from county.gov dated Nov 14, read today",
      "the specialist's log, read at 9 this morning"])
      expect(checkTextProblem(ok)).toBeNull();
    expect(checkTextProblem("looked into it")).toContain("says when");
    expect(checkTextProblem("looked into it at 9:40")).toContain("names a concrete source");
    expect(checkTextProblem("his Gmail inbox, read 11/15 at 9")).toContain("names its sender's domain and its date");
    expect(checkTextProblem("his mail\nat 9:40")).toContain("one line");
    expect(checkTextProblem("his mail | the portal at 9")).toContain("can't hold |");
    expect(checkTextProblem(`the portal at 9:40 ${"x".repeat(300)}`)).toContain("at most 300");
    // Vague sources are refused, whatever else the line says.
    for (const vague of ["from memory, the portal showed it filed, Nov 14", "the county portal, checked earlier", "I recall the mail from county.gov on Nov 14",
      "I remember the portal said so at 9:40"])
      expect(checkTextProblem(vague)).toContain("can't rest on");
  });

  test("a repeat: the same words once case, punctuation and digits are set aside, with no later time; a later time is a new check", () => {
    const last = "the county portal, read at 9:40 on Nov 14";
    expect(repeatsCheck(last, "The county portal: read at 9:40 on Nov 14.")).toBe(true);
    expect(repeatsCheck(last, "the county portal, read at 9:41 on Nov 14")).toBe(false);   // a later time
    expect(repeatsCheck(last, "the county portal, read at 10:05 on Nov 14")).toBe(false);
    expect(repeatsCheck(last, "the county portal, read at 9:15 on Nov 14")).toBe(true);    // not later
    expect(repeatsCheck(last, "the county portal and his mail from county.gov, read at 9:40 on Nov 14")).toBe(false);
    expect(repeatsCheck(undefined, last)).toBe(false);
    const k = record();
    k.ok([k.check("P44", CHECKED)]);
    const p = k.run([k.check("P44", `  ${CHECKED.toUpperCase()} `)]);
    expect(p.state).toBe("rejected");
    if (p.state !== "ok") expect(p.reason).toContain(`repeats the row's last check ("${CHECKED}": the same words, no later time)`);
    k.later(HOUR);
    expect(k.run([k.check("P44", CHECKED.replace("9:40", "10:40"))]).state).toBe("ok");
    expect(k.run([{ ...k.check("P44", "looked into it"), item: "P44" }]).state).not.toBe("ok");
  });

  test("the Checked cell: the check's day with its year, the time when it shares a day with the row's last change, and fresh or stale", () => {
    const e = { id: "r000000000001", version: 2, changed: "2026-11-12T15:00:00.000Z", checked: "his mail at 9", checked_at: "2026-11-11T14:40:00.000Z", checked_version: 2 };
    expect(checkedCell(e)).toBe("fresh, Nov 11, 2026, stale after Nov 18: his mail at 9");
    expect(checkedCell({ ...e, checked_version: 1 })).toBe("stale, Nov 11, 2026: his mail at 9");
    expect(checkedCell({ ...e, changed: "2026-11-11T13:00:00.000Z" })).toBe("fresh, Nov 11, 2026 9:40 AM, stale after Nov 18: his mail at 9");
    // The owner's limit (source_check_max_days) shows on the cell.
    expect(checkedCell(e, "America/New_York", 3)).toBe("fresh, Nov 11, 2026, stale after Nov 14: his mail at 9");
    const k = record({ [P]: PENDING }, T0, 3);
    k.ok([k.check("P44", CHECKED)]);
    expect(k.row("P44")).toEndWith(`| fresh, Nov 11, 2026 8:00 AM, stale after Nov 14: ${CHECKED} |`);
    k.agrees();
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

  test("a one-off ask is kept in the request log with its declaration, writes nothing, and is rejected when it names an open item", () => {
    const p = plan(req([{ op: "one-off", text: "Lunch at noon?", not_about_item: true }]), tree({ [P]: PENDING }), { at: T0 });
    expect(p).toMatchObject({ state: "ok" });
    if (p.state === "ok") expect(p.writes.size).toBe(0);
    const raw = (op: any) => JSON.stringify({ id: "cain-oneoff-1", from: "cain", kind: "change", summary: "s", ops: [op] });
    expect(parseRequest(raw({ op: "one-off", text: "Lunch at noon?" })).error).toBe("one-off: needs not_about_item: true, the declaration that it is about no open item");
    expect(parseRequest(raw({ op: "one-off", text: "Lunch at noon?", not_about_item: true })).error).toBeUndefined();
    expect(plan(req([{ op: "one-off", text: "Is p44 sorted?", not_about_item: true }]), tree({ [P]: PENDING }), { at: T0 }))
      .toEqual({ state: "rejected", reason: `one-off: names an open item, P44 ("Calendar specialist fails his plain commands"), matching "p44"; ask it under that item with a source check` });
  });
});

describe("whole-file writes: matched by item code", () => {
  const P12 = "| P12 | Water heater quote | Cain | Call the plumber back | | Quote in hand | Nov 9 |";
  const withP12 = () => PENDING.replace("| P44 |", `${P12}\n| P44 |`);
  const lineOf = (text: string, id: string) => text.split("\n").find((l) => l.startsWith(`| ${id} `))!;
  const allChecked = (k: ReturnType<typeof record>) => {
    k.ok(["P11", "P12", "P33", "P44"].map((id, i) => k.check(id, `the example.org portal page for it, read at 9:${10 + i}`)));
  };

  test("swapped codes: each row's Item changed under its code, so both are bumped and both checks go stale", () => {
    const k = record({ [P]: withP12() });
    allChecked(k);
    const before = k.ledger();
    const t = k.files[P], l11 = lineOf(t, "P11"), l44 = lineOf(t, "P44");
    const swapped = t.replace(l11, "\u0000").replace(l44, l11.replace("| P11 |", "| P44 |")).replace("\u0000", l44.replace("| P44 |", "| P11 |"));
    k.ok([{ op: "put", path: P, content: swapped, base: "x".repeat(40) }]);
    const L = k.ledger();
    expect(L.P11).toMatchObject({ id: before.P11.id, version: 2, checked_version: 1 });
    expect(L.P44).toMatchObject({ id: before.P44.id, version: 2, checked_version: 1 });
    expect(L.P12).toEqual(before.P12);
    expect(k.row("P11")).toContain("| stale, ");
    expect(k.row("P44")).toContain("| stale, ");
    k.agrees();
  });

  test("a duplicate code, or a row without one, refuses the write in one line", () => {
    const k = record({ [P]: withP12() });
    const dup = k.files[P].replace(P12, `${P12}\n${P12.replace("Water heater quote", "Water heater install")}`);
    expect(k.run([{ op: "put", path: P, content: dup, base: "x".repeat(40) }]))
      .toEqual({ state: "rejected", reason: `${P}: P12 is in the open table twice; each item code may hold one row, as the record matches rows by it` });
    const codeless = k.files[P].replace(P12, P12.replace("| P12 |", "|  |"));
    const p = k.run([{ op: "put", path: P, content: codeless, base: "x".repeat(40) }]);
    expect(p.state).toBe("rejected");
    if (p.state !== "ok") expect(p.reason).toStartWith(`${P}: an open row has no item code in its ID cell ("Water heater quote / Cain`);
  });

  test("rename, reorder, delete and recreate in one write: renamed and recreated rows bump, moved ones keep their check, deleted ones leave", () => {
    const k = record({ [P]: withP12() });
    allChecked(k);
    const before = k.ledger();
    const t = k.files[P];
    const l11 = lineOf(t, "P11"), l12 = lineOf(t, "P12"), l33 = lineOf(t, "P33"), l44 = lineOf(t, "P44");
    // One write: P46 new and first, P12 moved but unchanged, P44 renamed, P33 deleted, and P11
    // deleted and written again under its code with a new next step.
    const rows = ["| P46 | Gutter cleaning | Cain | Book it | | Booked | Nov 11 |", l12,
      l44.replace("Calendar specialist fails his plain commands", "The specialist misreads his commands"),
      l11.replace("Waiting on Dane (Ship)", "Shipped")];
    const lines = t.split("\n"), first = lines.indexOf(l11), last = lines.indexOf(l44);
    expect(lines.slice(first, last + 1)).toEqual([l11, l33, l12, l44]);
    const content = [...lines.slice(0, first), ...rows, ...lines.slice(last + 1)].join("\n");
    k.later(MIN);
    k.ok([{ op: "put", path: P, content, base: "x".repeat(40) }]);
    const L = k.ledger();
    expect(Object.keys(L).sort()).toEqual(["P11", "P12", "P44", "P46"]);
    expect(L.P12).toEqual(before.P12);                                                       // moved: same id, version, check
    expect(L.P44).toMatchObject({ id: before.P44.id, version: 2, checked_version: 1 });      // renamed: bumped
    expect(L.P11).toMatchObject({ id: before.P11.id, version: 2, checked_version: 1 });      // recreated with a change: bumped
    expect(L.P46).toMatchObject({ version: 1 });
    expect(L.P46.checked).toBeUndefined();
    expect(k.row("P12")).toContain("| fresh, ");
    k.agrees();
  });
});

describe("one row holds one fact: a whole-file write lands whole or not at all", () => {
  test("any new or changed row that bundles two statuses refuses the whole write, naming each row and its two clauses", () => {
    const k = record();
    const t = k.files[P];
    const content = t
      .replace("Hold the Build until P33 lifts", "First in the build queue")                                     // ordinary edit
      .replace("| Calendar: each add-on watches the other |", "| Lease signed, deposit paid on Nov 2 |")          // an existing row, bundled
      .replace("\n\n## Done", "\n| P45 | Business license filed Nov 3; land-use packet not filed | Cain | | | | Nov 11 |\n\n## Done");   // a new row, bundled
    const p = k.run([{ op: "put", path: P, content, base: "x".repeat(40) }]);
    expect(p.state).toBe("rejected");
    if (p.state !== "ok") expect(p.reason).toBe(`${P} wasn't written (a whole-file write lands whole or not at all): `
      + `P11: its Item bundles two statuses ("Lease signed" and "deposit paid on Nov 2"); `
      + `P45: its Item bundles two statuses ("Business license filed Nov 3" and "land-use packet not filed"). `
      + "One row holds one fact, so give each status its own row. Fix each row named and send the complete file again");
    // Nothing of it landed, the ordinary edit included.
    expect(k.row("P44")).toContain("| Hold the Build until P33 lifts |");
    expect(openRow(k.files[P], "P45")).toBeNull();
    // Fixed and sent whole again: it lands.
    k.ok([{ op: "put", path: P, content: content.replace("Lease signed, deposit paid on Nov 2", "Lease signed").replace("Business license filed Nov 3; land-use packet not filed", "Business license filed Nov 3"), base: "x".repeat(40) }]);
    expect(k.row("P44")).toContain("| First in the build queue |");
    expect(openRow(k.files[P], "P45")).toContain("| Business license filed Nov 3 |");
  });

  test("on the keeper: rejected whole, and Cain hears each row", () => {
    const k = keeperRig();
    const content = PENDING.replace("Hold the Build until P33 lifts", "First in the build queue")
      .replace("\n\n## Done", "\n| P45 | Vendor invoice paid; contractor deposit unpaid | Cain | | | | Nov 11 |\n\n## Done");
    k.cain({ id: "cain-put-1", ops: [{ op: "put", path: P, content, base: k.g("rev-parse", `HEAD:${P}`).trim() }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.outcome("cain-put-1")).toMatchObject({ state: "rejected" });
    expect(k.reason("cain-put-1")).toContain(`P45: its Item bundles two statuses ("Vendor invoice paid" and "contractor deposit unpaid")`);
    expect(openRow(k.upstream(P), "P44")).toContain("| Hold the Build until P33 lifts |");
    expect(openRow(k.upstream(P), "P45")).toBeNull();
    expect(k.relayed()).toContain(`Your record change cain-put-1 ("s") was not applied: rejected, ${P} wasn't written (a whole-file write lands whole or not at all): P45: its Item bundles two statuses`);
  });
});

describe("the one-off audit (a looser match, limited)", () => {
  const pending = pendingWith(["P08"], []).replace("| P08 | Something |", "| P08 | Business-license packet for the county |");
  test("outright: the item code or the whole Item phrase; looser: two distinctive words", () => {
    expect(oneOffHit(pending, "Is p08 sorted?")).toEqual(["P08", "Business-license packet for the county", "p08"]);
    expect(oneOffHit(pending, "Did the business-license packet for the county go in?")?.[0]).toBe("P08");
    expect(oneOffHit(pending, "Is the county business-license packet in?")).toBeNull();
    expect(oneOffHit(pending, "Lunch at noon?")).toBeNull();
    expect(oneOffLoose(pending, "Is the county business-license packet in?").map((h) => h.id)).toEqual(["P08"]);
    expect(oneOffLoose(pending, "Lunch at noon?")).toEqual([]);
  });

  test("the past week's one-offs, matched against the open rows, one line for the week then each hit", () => {
    const now = new Date(T0.getTime() + HOUR);
    const a = oneOffAudit([
      { id: "link-oneoff-1", at: T0.toISOString(), text: "Is the county business-license packet in?" },
      { id: "link-oneoff-2", at: T0.toISOString(), text: "Lunch at noon?" },
      { id: "link-oneoff-0", at: new Date(T0.getTime() - DAYS(8)).toISOString(), text: "County packet business?" },
    ], pending, now);
    expect(a.hits).toEqual([`Nov 11, 2026 (link-oneoff-1): "Is the county business-license packet in?" may be about P08 ("Business-license packet for the county"), shared words: "business", "license", "packet", "county"`]);
    expect(a.text).toContain("Week to Nov 11, 2026: 1 possible match in 2 one-offs; 0 wait timeouts; 0 tap timeouts.");
    expect(a.text).toContain("The guard is limited");
  });

  test("on the keeper: an overlapping one-off needs its reason; each round writes hits to its log, state/one-off-audit.md and the next check-in", () => {
    const k = keeperRig();
    k.cain({ id: "link-oneoff-0", summary: "One-off ask to him: Is the specialist's plain-command fix in?",
      ops: [{ op: "one-off", text: "Is the specialist's plain-command fix in?", not_about_item: true }] });
    k.cain({ id: "link-oneoff-1", summary: "One-off ask to him: Is the specialist's plain-command fix in?",
      ops: [{ op: "one-off", text: "Is the specialist's plain-command fix in?", not_about_item: true, reason: "his question about the phone app, not the calendar item" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.outcome("link-oneoff-0")).toMatchObject({ state: "rejected" });
    expect(k.reason("link-oneoff-0")).toBe(`one-off: its words overlap an open item (P44: "specialist", "plain", "command"); ask it under that item with a source check, or send it again with a one-line reason it is about no open item`);
    expect(k.outcome("link-oneoff-1")).toMatchObject({ state: "done", declared: `his question about the phone app, not the calendar item (overlaps P44: "specialist", "plain", "command")` });
    expect(k.log().find((o) => o.id === "link-oneoff-1")!.declared).toContain("his question about the phone app");
    const audit = k.upstream(ONE_OFF_AUDIT_PATH)!;
    expect(audit).toContain("Week to Nov 11, 2026: 1 possible match in 1 one-off; 0 wait timeouts; 0 tap timeouts.");
    expect(audit).toContain(`(link-oneoff-1): "Is the specialist's plain-command fix in?" may be about P44`);
    expect(audit).toContain(`re-declared about no open item: "his question about the phone app, not the calendar item`);
    // The new hit waits for Cain's next check-in, once.
    expect(readFileSync(k.cfg.checkin!, "utf8")).toContain(`(link-oneoff-1): "Is the specialist's plain-command fix in?" may be about P44`);
    expect(k.subjects(3)).toContain("One-off audit: 1 to look over");
    // No request writes it.
    expect(plan(req([{ op: "put", path: ONE_OFF_AUDIT_PATH, content: "x\n", base: "new" }]), tree({ [P]: PENDING }), { at: T0 }))
      .toMatchObject({ state: "rejected" });
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
describe("the link asks only on an accepted check of the row as it stands", () => {
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

  test("a check the keeper accepts posts, resting on the row's id and version as the keeper took it", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 4 } });
    const out = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED });
    expect(out.status).toBe("posted");
    const id = `link-check-p08-${NOV11_8AM}`;
    expect(r.submitted).toEqual([{ id, from: "cain", kind: "change",
      summary: `Source check on P08 before asking him: ${CHECKED}`, ops: [{ op: "check", item: "P08", text: CHECKED, row: rowId("P08"), version: 4 }] }]);
    expect(r.state().messages[(out as any).message].checked).toEqual({ row: rowId("P08"), version: 4, req: id, gen: 0 });
    // The same check sent again while it still counts (say his line was refused): the accepted one stands.
    await r.link.answered({ item: "P08", question: "Q2" });
    expect((await r.link.ask({ text: "Is the packet filed yet?", options: opts, item: "P08", question: "Q3", checked: CHECKED })).status).toBe("posted");
    expect(r.submitted.length).toBe(1);
  });

  test("a check the keeper rejects posts nothing, and Cain hears why in one line", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 1 } });
    r.keeper.auto = false;
    r.keeper.onWait = () => { for (const q of r.submitted) r.outcomes[q.id] = { state: "rejected", reason: "check P08: the row changed since the check was read (it checked version 1, the row is now version 2); check again" }; };
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }))
      .rejects.toThrow("Nothing was posted: the record keeper said rejected to your source check (check P08: the row changed since the check was read");
    expect(r.posts()).toBe(0);
    expect(Object.keys(r.state().messages ?? {})).toEqual([]);
    expect(r.state().held ?? []).toEqual([]);
    // A Ship card too.
    const s = linkRig({ unchecked: true, pending: pendingWith(["P41"], []) });
    s.keeper.auto = false;
    s.keeper.onWait = () => { for (const q of s.submitted) s.outcomes[q.id] = { state: "conflict", reason: "the record changed" }; };
    await expect(s.link.ship({ item: "P41", pr: PR, head: SHA1, text: "Stop stays within reach of your newest message.",
      checked: "the pull request on GitHub, open at that head, read at 8 this morning" })).rejects.toThrow("Nothing was posted: the record keeper said conflict");
    expect(s.posts()).toBe(0);
  });

  test("no answer within the window posts nothing; a check that lands later lets a retry through without a new one", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 1 } });
    r.keeper.auto = false;
    const start = r.t.now;
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }))
      .rejects.toThrow(`Nothing was posted: the record keeper didn't accept your source check within ${CHECK_WAIT_MS / 1000} seconds`);
    expect(r.t.now - start).toBeGreaterThanOrEqual(CHECK_WAIT_MS);
    expect(r.posts()).toBe(0);
    // The pending copy never posts; once the keeper took it, the retry needs no new check.
    const sent = r.submitted[0];
    r.files.checks = ledger({ P08: { version: 1, checked_version: 1, checked_req: sent.id, checked_at: r.t.now } });
    r.outcomes[sent.id] = { state: "done" };
    expect((await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" })).status).toBe("posted");
    expect(r.submitted.length).toBe(1);
  });

  test("a row change right after the keeper took the check posts nothing (the version is read again before posting)", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 1 } });
    r.keeper.auto = false;
    r.keeper.onWait = () => {
      const q = r.submitted[0];
      r.files.checks = ledger({ P08: { version: 2, checked_version: 1, checked_req: q.id, changed: r.t.now } });
      r.outcomes[q.id] = { state: "done" };
    };
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }))
      .rejects.toThrow("the row changed right after it");
    expect(r.posts()).toBe(0);
  });

  test("a check that can't be handed to the keeper is refused, and nothing is posted (no switch lets it through)", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    (r as any).submitted.push = () => { throw new Error("disk full"); };
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }))
      .rejects.toThrow("Nothing was posted: the source check couldn't be handed to the record keeper (Error: disk full)");
    expect(r.posts()).toBe(0);
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

  test("equal timestamps don't matter: versions do", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08", "P09"], []) });
    // Changed and checked at the same instant: P08's check is of the version before, P09's of this one.
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, changed: NOV11_8AM, checked_at: NOV11_8AM },
      P09: { version: 2, checked_version: 2, changed: NOV11_8AM, checked_at: NOV11_8AM } });
    await expect(r.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q1" })).rejects.toThrow("No source check on this item since");
    expect((await r.link.ask({ text: "Is it sent?", options: ["Sent", "Not sent"], item: "P09", question: "Q1" })).status).toBe("posted");
    // A check stamped after a change it predates still doesn't count.
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, changed: NOV11_8AM, checked_at: NOV11_8AM + HOUR } });
    await expect(r.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q2" })).rejects.toThrow("No source check on this item since");
  });

  test("maximum check age: older than the owner's limit (7 days by default, by the keeper's time) is refused; a fresh one goes out", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08", "P09"], []) });
    r.files.checks = ledger({ P08: { version: 1, checked_version: 1, checked_at: NOV11_8AM - DAYS(8) },
      P09: { version: 1, checked_version: 1, checked_at: NOV11_8AM - DAYS(6) } });
    await expect(r.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q1" }))
      .rejects.toThrow("The source check on this item went stale after Nov 10 (older than 7 days); add --checked");
    expect((await r.link.ask({ text: "Is it sent?", options: ["Sent", "Not sent"], item: "P09", question: "Q1" })).status).toBe("posted");
    // A new check of the aged row goes through.
    await r.link.answered({ item: "P09", question: "Q1" });
    expect((await r.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q1", checked: "the county portal, read at 8 this morning" })).status).toBe("posted");
    // The owner's own limit.
    const s = linkRig({ unchecked: true, maxCheckDays: 3, pending: pendingWith(["P08"], []) });
    s.files.checks = ledger({ P08: { version: 1, checked_version: 1, checked_at: NOV11_8AM - DAYS(4) } });
    await expect(s.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q1" })).rejects.toThrow("(older than 3 days)");
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

  test("check text: dates and codes are fine in it; one without a concrete source, a vague one, or a repeat on a stale row is refused", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, checked: CHECKED } });
    const ask = (checked: string, question = "Q2") => r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question, checked });
    await expect(ask("looked again")).rejects.toThrow("says when it was checked");
    await expect(ask("looked again at 9:40")).rejects.toThrow("names a concrete source");
    await expect(ask("from memory, at 9:40 on the portal")).rejects.toThrow("can't rest on \"from memory\"");
    await expect(ask("his inbox at 9:40")).rejects.toThrow("names its sender's domain and its date");
    await expect(ask("his mail\nthis morning")).rejects.toThrow("one line");
    await expect(ask("his mail | the portal at 9")).rejects.toThrow("can't hold |");
    await expect(ask(CHECKED)).rejects.toThrow(`repeats the row's last one ("${CHECKED}": the same words, no later time)`);
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
});

describe("posted asks and Ship cards lose their buttons when the row moves on", () => {
  test("the sweep takes an ask's buttons off ('Status changed, re-check needed') and tells Cain", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = ledger({ P08: { version: 1, checked_version: 1 } });
    seeded(r, "P08");
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
    seeded(r, "P08");
    const id = (await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" }) as any).message;
    r.files.checks = ledger({ P08: { version: 2, checked_version: 1, changed: NOV11_8AM } });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("dead: status changed");
    expect(r.msg(id).content).toEndWith(`\n\n${STATUS_CHANGED}`);
    expect(r.ephemerals().map((b: any) => b.content)).toContain("Its status changed since it was checked, so nothing was done.");
    expect(r.relayed.join(" ")).not.toContain("Dane tapped");
  });

  test("a tap can never land on a card whose check wasn't accepted: an outcome other than done takes it down", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const out = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }) as any;
    expect(out.status).toBe("posted");
    // Say the keeper's outcome for that check reads otherwise now (a restored /data): the card is dead.
    r.outcomes[r.submitted[0].id] = { state: "rejected", reason: "an id that was already used" };
    expect(await r.tap(structuredClone(r.msg(out.message)), r.ids(out.message)[0])).toBe("dead: status changed");
    expect(r.relayed.join(" ")).not.toContain("Dane tapped");
  });

  test("a Ship card too; the keeper's id for a row it first ledgered with the check keeps the card", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41"], []) });
    const out = await r.link.ship({ item: "P41", pr: PR, head: SHA1, text: "Stop stays within reach of your newest message.",
      checked: "the pull request on GitHub, open at that head, read at 8 this morning" }) as any;
    await r.link.sweep();
    expect(r.buttons(out.message)).toEqual(["Ship", "Not now"]);
    const L = JSON.parse(r.files.checks!);
    L.P41 = { ...L.P41, version: 2, changed: new Date(NOV11_8AM).toISOString() };
    r.files.checks = JSON.stringify(L);
    await r.link.sweep();
    expect(r.buttons(out.message)).toEqual([]);
    expect(r.msg(out.message).content).toEndWith(`\n\n${STATUS_CHANGED}`);
  });
});

describe("one-off asks", () => {
  const pending = pendingWith(["P08"], []).replace("| P08 | Something |", "| P08 | Business-license packet for the county |");
  test("refused when it names an open item outright (its whole Item phrase); a looser overlap is held until he gives a reason, then goes out, declared and logged", async () => {
    const r = linkRig({ unchecked: true, pending });
    await expect(r.link.ask({ text: "Did the business-license packet for the county go in?", options: ["Yes", "No"], item: "none" }))
      .rejects.toThrow(`This one-off names an open item, P08 ("Business-license packet for the county"), matching "business license packet for the county": ask it with --item P08 and a --checked source check`);
    expect(r.posts()).toBe(0);
    expect(r.submitted).toEqual([]);
    // Shared distinctive words: held, not refused, until he names the item or gives a reason.
    const held = await r.link.ask({ text: "Is the county business-license packet in?", options: ["Yes", "No"], item: "none" });
    expect(held).toEqual({ status: "needs reason", said: `Held, not posted: this one-off's words overlap an open item, P08 ("Business-license packet for the county"), sharing "business", "license", "packet", "county". Either ask it with --item P08 and a --checked source check, or send it again with --reason "<one line on why it is about no open item>", which the record keeper logs.` });
    expect(r.posts()).toBe(0);
    expect(r.submitted).toEqual([]);
    expect((await r.link.ask({ text: "Is the county business-license packet in?", options: ["Yes", "No"], item: "none", reason: "his neighbor's packet, not his" })).status).toBe("posted");
    expect(r.submitted).toEqual([{ id: `link-oneoff-${NOV11_8AM}`, from: "cain", kind: "change", summary: "One-off ask to him: Is the county business-license packet in?",
      ops: [{ op: "one-off", text: "Is the county business-license packet in?", not_about_item: true, reason: "his neighbor's packet, not his" }] }]);
    // No overlap at all: posted with no reason needed.
    await r.link.answered({ item: "none" });
    expect((await r.link.ask({ text: "Lunch at noon?", options: ["Yes", "No"], item: "none" })).status).toBe("posted");
  });
});

describe("end to end: the link and the record keeper on a real git repo", () => {
  test("refused, checked, accepted, recorded on the row and in the log, reused, then needed again after a change; a one-off is logged and audited", () => {
    const k = keeperRig();
    const l = linkRig({ unchecked: true, pending: PENDING });
    const read = (p: string) => { try { return readFileSync(join(k.cfg.dir, p), "utf8"); } catch { return null; } };
    let n = 0;
    // The keeper's round, as it runs every 2 seconds while the link waits.
    const run = () => {
      writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify(l.state()));   // the link's state, as the keeper reads it
      for (const q of l.submitted.splice(0)) writeFileSync(join(k.cfg.queue, `${String(++n).padStart(4, "0")}-${q.id}.json`), JSON.stringify(q));
      expect(cycle(k.cfg).ok).toBe(true);
      l.files.pending = read(P);
      l.files.checks = read(CHECKS_PATH);
      for (const o of k.log()) l.outcomes[o.id] = { state: o.state, reason: o.reason };
    };
    l.keeper.auto = false;
    l.keeper.onWait = run;
    return (async () => {
      const ask = (q: string, checked?: string) => l.link.ask({ text: "Is the specialist fixed?", options: ["Fixed", "Not fixed"], item: "P44", question: q, ...(checked ? { checked } : {}) });
      await expect(ask("Q1")).rejects.toThrow("No source check on this item yet");
      // One clock on the box: the link's never reads earlier than the keeper's.
      k.at(new Date(T0.getTime() + MIN)); l.later(MIN);
      const q1 = await ask("Q1", "the specialist's log, read at 8 this morning") as any;
      expect(q1.status).toBe("posted");
      const req = l.state().messages[q1.message].checked.req;
      expect(k.states(req)).toEqual(["done"]);
      expect(openRow(k.upstream(P), "P44")).toEndWith("| fresh, Nov 11, 2026 8:01 AM, stale after Nov 18: the specialist's log, read at 8 this morning |");
      expect(parseChecks(k.upstream(CHECKS_PATH)).P44).toMatchObject({ version: 1, checked_version: 1, checked: "the specialist's log, read at 8 this morning", checked_req: req });
      await l.link.sweep();
      expect(l.buttons(q1.message)).toEqual(["Fixed", "Not fixed"]);   // the keeper's id for the row keeps the card
      // From the ledger alone, a later ask on the same version passes.
      l.later(5 * MIN);
      expect((await ask("Q2")).status).toBe("held");
      // Cain moves the row on: its version goes up, the posted card comes off, the held ask is dropped.
      k.at(new Date(T0.getTime() + 10 * MIN));
      k.cain({ id: "cain-next-1", ops: [{ op: "row", item: "P44", base: rowHash(openRow(read(P), "P44")!), set: { "Next step": "Build the fix" } }] });
      run();
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
      // A one-off goes into the request log, and the keeper's audit flags its overlap with P44.
      await l.link.answered({ item: "P44", question: "Q3" });
      expect((await l.link.ask({ text: "Is the specialist's plain-command fix in?", options: ["Yes", "No"], item: "none" })).status).toBe("needs reason");
      expect((await l.link.ask({ text: "Is the specialist's plain-command fix in?", options: ["Yes", "No"], item: "none",
        reason: "his question about the phone app" })).status).toBe("posted");
      run();
      expect(k.log().filter((o) => o.summary === "One-off ask to him: Is the specialist's plain-command fix in?").map((o) => o.state)).toEqual(["done"]);
      expect(k.upstream(ONE_OFF_AUDIT_PATH)).toContain("may be about P44");
      // A row-add that bundles two statuses is refused there too.
      k.cain({ id: "cain-add-1", ops: [{ op: "row-add", item: "P45", cells: { Item: "Business license filed Nov 3; land-use packet not filed", Who: "Cain" } }] });
      run();
      expect(k.outcome("cain-add-1")).toMatchObject({ state: "rejected" });
      expect(k.reason("cain-add-1")).toContain("bundles two statuses");
    })();
  }, 60_000);
});
