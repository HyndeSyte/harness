// Source checks, third review round (0.12.0): one-off overlaps held until re-declared with a
// reason; the link waits on the keeper's local work only (its outcome before the push), with
// wait timeouts logged and audited; whole-file writes atomic again, with a refused row's check
// pending a rewrite; taps honoured only on a fresh read of the local ledger; the previous
// keeper tolerating the ledger's files (rollback); checks taken and aged only on a
// synchronized clock, by the keeper's own; new hidden ids for codes that come back; refusals
// quoting what they matched, logged for tuning; and a cap on a row's Next step.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_WAIT_MS, closedItems, STATUS_CHANGED } from "../rootfs/opt/cain/link/core";
import { CHECKS_PATH, checkTextProblem, inStep, MAX_NEXT_STEP, ONE_OFF_AUDIT_PATH, openRow, parseChecks, parseRequest, plan, rowHash,
  type Checks, type Plan, type Request, type Tree } from "../rootfs/opt/cain/record/core.ts";
import { clockSynced, cycle } from "../rootfs/opt/cain/record/main.ts";
import * as old from "./fixtures/keeper-0.11.0/core.ts";
import { cycle as oldCycle } from "./fixtures/keeper-0.11.0/main.ts";
import { HOUR, MIN, NOV11_8AM, pendingWith, PR, rig as linkRig, SHA1 } from "./link-rig";
import { PENDING, T0, rig as keeperRig } from "./rig.ts";

const P = "state/PENDING.md";
const DAY = 24 * HOUR;
const CHECKED = "the county.gov receipt in his mail, dated Nov 10, read at 9:40 this morning";
const opts = ["Filed", "Not filed", "Not sure"];
const tree = (files: Record<string, string>): Tree => ({ sha: (p) => (p in files ? "x".repeat(40) : null), read: (p) => files[p] ?? null });

// A small record running requests through plan() one after another, as the keeper does: a
// refusal's own keeper files (the ledger's pending rewrite) are written too.
function record(files: Record<string, string> = { [P]: PENDING }, synced = true) {
  let at = T0.getTime(), n = 0;
  const r = {
    files,
    run(ops: any[], from = "cain"): Plan {
      const req: Request = { id: `cain-test-${++n}`, from, kind: "change", summary: "s", ops };
      const p = plan(req, tree(files), { at: new Date(at), tz: "America/New_York", clockSynced: synced });
      if (p.writes) for (const [k, v] of p.writes) { if (v === null) delete files[k]; else files[k] = v; }
      return p;
    },
    ok(ops: any[], from = "cain") { const p = r.run(ops, from); if (p.state !== "ok") throw new Error(`${p.state}: ${p.reason}`); return p; },
    no(ops: any[], from = "cain") { const p = r.run(ops, from); if (p.state === "ok") throw new Error("went through"); return p.reason; },
    later(ms: number) { at += ms; },
    ledger: (): Checks => parseChecks(files[CHECKS_PATH] ?? null),
    row: (id: string) => openRow(files[P], id)!,
    base: (id: string) => rowHash(openRow(files[P], id)!),
    check(item: string, text: string) { const e = r.ledger()[item]; return { op: "check", item, text, row: e?.id ?? null, version: e?.version ?? 0 }; },
  };
  return r;
}

// The link and a real keeper on a git repo, the keeper's round run whenever the link waits.
function both() {
  const k = keeperRig();
  const l = linkRig({ unchecked: true, pending: PENDING });
  const read = (p: string) => { try { return readFileSync(join(k.cfg.dir, p), "utf8"); } catch { return null; } };
  let n = 0;
  const run = () => {
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify(l.state()));   // the link's state, as the keeper reads it
    for (const q of l.submitted.splice(0)) writeFileSync(join(k.cfg.queue, `${String(++n).padStart(4, "0")}-${q.id}.json`), JSON.stringify(q));
    for (const w of l.waited.splice(0)) writeFileSync(k.cfg.waits!, JSON.stringify(w) + "\n", { flag: "a" });
    expect(cycle(k.cfg).ok).toBe(true);
    sync();
  };
  // The link reads the keeper's local copy and its outcome files, as on the Pi.
  const sync = () => {
    l.files.pending = read(P);
    l.files.checks = read(CHECKS_PATH);
    for (const o of k.log()) l.outcomes[o.id] = { state: o.state, reason: o.reason };
  };
  l.keeper.auto = false;
  l.keeper.onWait = run;
  return { k, l, run, read, sync };
}

describe("1. one-offs: an overlap is held until re-declared with a reason; an exact match stays refused", () => {
  const pending = pendingWith(["P08"], []).replace("| P08 | Something |", "| P08 | Business-license packet for the county |");

  test("the keeper: exact match refused quoting what matched; overlap without a reason refused; with one, logged as declared", () => {
    const k = record({ [P]: pending });
    expect(k.no([{ op: "one-off", text: "Is P08 done?", not_about_item: true, reason: "not about it" }]))
      .toBe(`one-off: names an open item, P08 ("Business-license packet for the county"), matching "P08"; ask it under that item with a source check`);
    expect(k.no([{ op: "one-off", text: "Is the county business-license packet in?", not_about_item: true }]))
      .toBe(`one-off: its words overlap an open item (P08: "business", "license", "packet", "county"); ask it under that item with a source check, or send it again with a one-line reason it is about no open item`);
    const p = k.ok([{ op: "one-off", text: "Is the county business-license packet in?", not_about_item: true, reason: "the neighbor's packet he asked about" }]);
    expect(p.declared).toBe(`the neighbor's packet he asked about (overlaps P08: "business", "license", "packet", "county")`);
    expect(p.writes.size).toBe(0);
    const raw = (op: any) => JSON.stringify({ id: "cain-oneoff-1", from: "cain", kind: "change", summary: "s", ops: [op] });
    expect(parseRequest(raw({ op: "one-off", text: "x", not_about_item: true, reason: "a\nb" })).error).toBe("one-off: reason: a cell can't hold | or a new line");
    expect(parseRequest(raw({ op: "one-off", text: "x", not_about_item: true, reason: "y".repeat(201) })).error).toBe("one-off: reason over 200 characters");
    expect(parseRequest(raw({ op: "one-off", text: "x", not_about_item: true, reason: " " })).error).toContain("reason, when given, is one line");
  });

  test("the link: the hold posts nothing and says both ways on; a reason posts it; an exact match is refused even with a reason", async () => {
    const r = linkRig({ unchecked: true, pending });
    const held = await r.link.ask({ text: "Is the county business-license packet in?", options: ["Yes", "No"], item: "none" });
    expect(held.status).toBe("needs reason");
    expect(held.said).toContain(`sharing "business", "license", "packet", "county". Either ask it with --item P08 and a --checked source check, or send it again with --reason`);
    expect(r.posts()).toBe(0);
    expect(r.tuned.map((t) => t.kind)).toEqual(["one-off hold"]);
    await expect(r.link.ask({ text: "Did the business-license packet for the county go in?", options: ["Yes", "No"], item: "none", reason: "something else" }))
      .rejects.toThrow(`matching "business license packet for the county"`);
    expect(r.posts()).toBe(0);
    const out = await r.link.ask({ text: "Is the county business-license packet in?", options: ["Yes", "No"], item: "none", reason: "the neighbor's packet" });
    expect(out.status).toBe("posted");
    expect(r.submitted.at(-1).ops[0]).toEqual({ op: "one-off", text: "Is the county business-license packet in?", not_about_item: true, reason: "the neighbor's packet" });
  });
});

describe("2. the link waits on the keeper's local work only", () => {
  test("the keeper writes the outcome once its local commit and ledger are made, before the push", () => {
    const k = keeperRig();
    let seen: any = null, upstreamHad = true;
    k.cfg.beforePush = () => {
      seen = k.outcome("link-check-p44-1");
      upstreamHad = parseChecks(k.upstream(CHECKS_PATH)).P44 !== undefined;
      // The ledger the link reads is the keeper's local copy, already written.
      seen.local = parseChecks(readFileSync(join(k.cfg.dir, CHECKS_PATH), "utf8")).P44?.checked;
    };
    k.cain({ id: "link-check-p44-1", summary: "check", ops: [{ op: "check", item: "P44", text: "the specialist's log, read at 8", row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(seen).toMatchObject({ state: "done", local: "the specialist's log, read at 8" });
    expect(Number.isFinite(seen.round_ms)).toBe(true);
    expect(upstreamHad).toBe(false);                       // GitHub didn't have it yet
    expect(k.outcome("link-check-p44-1")).toMatchObject({ state: "done" });
  });

  test("a slow push doesn't refuse a valid question", async () => {
    const { k, l } = both();
    // The push takes twice the link's whole wait.
    k.cfg.beforePush = () => { l.later(2 * CHECK_WAIT_MS); };
    const out = await l.link.ask({ text: "Is the specialist fixed?", options: ["Fixed", "Not fixed"], item: "P44", question: "Q1", checked: "the specialist's log, read at 8 this morning" });
    expect(out.status).toBe("posted");
    expect(l.waited).toEqual([]);
  }, 30_000);

  test("a slow local round still refuses, and the timeout is logged with the round's time and counted in the audit", async () => {
    const { k, l, run } = both();
    // The keeper gets to the request only after the link gave up.
    l.keeper.onWait = () => {};
    await expect(l.link.ask({ text: "Is the specialist fixed?", options: ["Fixed", "Not fixed"], item: "P44", question: "Q1", checked: "the specialist's log, read at 8 this morning" }))
      .rejects.toThrow(`Nothing was posted: the record keeper didn't accept your source check within ${CHECK_WAIT_MS / 1000} seconds`);
    expect(l.posts()).toBe(0);
    const id = l.submitted[0].id;
    expect(l.waited).toEqual([{ id, at: new Date(l.t.now).toISOString(), waited_ms: CHECK_WAIT_MS }]);
    expect(l.tuned.map((t) => t.kind)).toEqual(["wait"]);
    k.at(new Date(T0.getTime() + MIN));
    run();
    expect(k.outcome(id)).toMatchObject({ state: "done" });
    // A one-off makes the next round write the audit, which counts the timeout with its round's time.
    k.cain({ id: "link-oneoff-1", summary: "One-off ask to him: Lunch at noon?", ops: [{ op: "one-off", text: "Lunch at noon?", not_about_item: true }] });
    run();
    const audit = k.upstream(ONE_OFF_AUDIT_PATH)!;
    expect(audit).toContain("0 possible matches in 1 one-off; 1 wait timeout; 0 tap timeouts.");
    expect(audit).toMatch(new RegExp(`\\(${id}\\): the link gave up waiting after 30 seconds and posted nothing; the keeper's local round for it took [0-9.]+ seconds`));
    expect(readFileSync(k.cfg.checkin!, "utf8")).toContain(`(${id}): the link gave up waiting`);
  }, 30_000);
});

describe("3. whole-file writes are atomic; a refused row's check is pending a rewrite until written cleanly and checked again", () => {
  test("refused whole, naming each row; the existing row's check is marked pending, so asks and checks on it are refused", () => {
    const k = record();
    k.ok([k.check("P11", "the example.org portal page, read at 9:10")]);
    const content = k.files[P].replace("| Calendar: each add-on watches the other |", "| Lease signed, deposit paid on Nov 2 |")
      .replace("Hold the Build until P33 lifts", "First in the build queue");
    const why = k.no([{ op: "put", path: P, content, base: "x".repeat(40) }]);
    expect(why).toBe(`${P} wasn't written (a whole-file write lands whole or not at all): P11: its Item bundles two statuses ("Lease signed" and "deposit paid on Nov 2"). One row holds one fact, so give each status its own row. Fix each row named and send the complete file again`);
    expect(k.row("P44")).toContain("| Hold the Build until P33 lifts |");      // nothing of it landed
    expect(k.row("P11")).toContain("| Calendar: each add-on watches the other |");
    expect(k.ledger().P11.pending_rewrite).toBe(`request cain-test-2, ${T0.toISOString()}: its Item bundles two statuses ("Lease signed" and "deposit paid on Nov 2")`);
    expect(k.row("P11")).toEndWith("| pending rewrite: a whole-file write of this row was refused; write it cleanly, then check it again |");
    // A new check isn't taken while it's pending.
    expect(k.no([k.check("P11", "the example.org portal page, read at 9:30")])).toContain("check P11: the row is pending a rewrite");
    // Written cleanly: the pending mark goes with the new version, and a new check is taken.
    k.ok([{ op: "row", item: "P11", base: k.base("P11"), set: { Item: "Lease signed" } }]);
    expect(k.ledger().P11).toMatchObject({ version: 2 });
    expect(k.ledger().P11.pending_rewrite).toBeUndefined();
    k.ok([k.check("P11", "the example.org portal page, read at 9:40")]);
    expect(k.row("P11")).toContain("| fresh, ");
  });

  test("the link refuses an ask on a row pending a rewrite, saying why; a posted card on it loses its buttons", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const L = { P08: { id: "r000000000008", version: 1, changed: new Date(NOV11_8AM - DAY).toISOString(), checked: CHECKED,
      checked_at: new Date(NOV11_8AM - HOUR).toISOString(), checked_version: 1, checked_req: "link-check-p08-seed" } };
    r.files.checks = JSON.stringify(L);
    r.outcomes["link-check-p08-seed"] = { state: "done" };
    const out = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2" }) as any;
    expect(out.status).toBe("posted");
    r.files.checks = JSON.stringify({ P08: { ...L.P08, pending_rewrite: `request cain-x, 2026-11-11: its Item bundles two statuses ("a filed" and "b sent")` } });
    await r.link.sweep();
    expect(r.buttons(out.message)).toEqual([]);
    expect(r.msg(out.message).content).toEndWith(`\n\n${STATUS_CHANGED}`);
    await r.link.answered({ item: "P08", question: "Q2" }).catch(() => {});
    await expect(r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q3", checked: "the county portal, read at 10" }))
      .rejects.toThrow(`This item's row is pending a rewrite: a whole-file write of it was refused (request cain-x, 2026-11-11: its Item bundles two statuses ("a filed" and "b sent"))`);
  });

  test("on the keeper: the refusal and the ledger's pending mark are committed together", () => {
    const k = keeperRig();
    k.cain({ id: "link-check-p11-1", ops: [{ op: "check", item: "P11", text: "the example.org portal page, read at 9:10", row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const content = k.upstream(P)!.replace("| Calendar: each add-on watches the other |", "| Router installed, thermostat not installed |");
    k.cain({ id: "cain-put-1", ops: [{ op: "put", path: P, content, base: k.g("rev-parse", `HEAD:${P}`).trim() }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.outcome("cain-put-1")).toMatchObject({ state: "rejected" });
    expect(k.reason("cain-put-1")).toContain(`P11: its Item bundles two statuses ("Router installed" and "thermostat not installed")`);
    expect(parseChecks(k.upstream(CHECKS_PATH)).P11.pending_rewrite).toContain("cain-put-1");
    expect(openRow(k.upstream(P), "P11")).toContain("| Calendar: each add-on watches the other |");
    expect(k.relayed()).toContain(`Your record change cain-put-1 ("s") was not applied: rejected, ${P} wasn't written`);
  });
});

describe("4. a tap is honoured only on a fresh read of the local ledger", () => {
  const posted = async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const out = await r.link.ask({ text: "Is the packet filed?", options: opts, item: "P08", question: "Q2", checked: CHECKED }) as any;
    expect(out.status).toBe("posted");
    return { r, id: out.message as string };
  };

  test("a ledger read failure at tap time rejects with the status-changed reason; the card keeps its buttons", async () => {
    for (const fail of ["record", "outcome", "no ledger", "bad ledger", "no outcome"] as const) {
      const { r, id } = await posted();
      const keep = { checks: r.files.checks, outcomes: { ...r.outcomes } };
      if (fail === "record") r.fails.record = true;
      else if (fail === "outcome") r.fails.outcome = true;
      else if (fail === "no ledger") r.files.checks = null;
      else if (fail === "bad ledger") r.files.checks = "{not json";
      else for (const k of Object.keys(r.outcomes)) delete r.outcomes[k];
      expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: status unreadable");
      expect(r.ephemerals().map((b: any) => b.content)).toEqual(["Its status changed since it was checked, so nothing was done."]);
      expect(r.relayed.join(" ")).not.toContain("Dane tapped");
      expect(r.buttons(id)).toEqual(opts);
      // The sweep doesn't take buttons off on a failed read; once it reads, the tap counts.
      await r.link.sweep();
      expect(r.buttons(id)).toEqual(opts);
      r.fails.record = false; r.fails.outcome = false; r.files.checks = keep.checks; Object.assign(r.outcomes, keep.outcomes);
      expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).not.toContain("refused");
      expect(r.relayed.join(" ")).toContain("Dane tapped");
    }
  });

  test("an outcome other than done, or another row id or version, rejects and takes the buttons off", async () => {
    const { r, id } = await posted();
    const L = JSON.parse(r.files.checks!);
    r.files.checks = JSON.stringify({ P08: { ...L.P08, id: "r0000000000ff" } });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("dead: status changed");
    expect(r.buttons(id)).toEqual([]);
  });

  test("a reorder of the table does not reject: table position is never used (the link and a real keeper)", async () => {
    const { k, l, run, read } = both();
    const out = await l.link.ask({ text: "Is the specialist fixed?", options: ["Fixed", "Not fixed"], item: "P44", question: "Q1", checked: "the specialist's log, read at 8 this morning" }) as any;
    expect(out.status).toBe("posted");
    const before = parseChecks(read(CHECKS_PATH));
    // Cain puts the list back with P44 first.
    const lines = read(P)!.split("\n");
    const a = lines.findIndex((x) => x.startsWith("| P11 ")), b = lines.findIndex((x) => x.startsWith("| P44 "));
    [lines[a], lines[b]] = [lines[b], lines[a]];
    k.cain({ id: "cain-reorder-1", ops: [{ op: "put", path: P, content: lines.join("\n"), base: k.g("-C", k.cfg.dir, "rev-parse", `HEAD:${P}`).trim() }] });
    run();
    expect(k.outcome("cain-reorder-1")).toMatchObject({ state: "done" });
    expect(read(P)!.indexOf("| P44 ")).toBeLessThan(read(P)!.indexOf("| P11 "));
    expect(parseChecks(read(CHECKS_PATH))).toEqual(before);
    await l.link.sweep();
    expect(l.buttons(out.message)).toEqual(["Fixed", "Not fixed"]);
    expect(await l.tap(structuredClone(l.msg(out.message)), l.ids(out.message)[0])).not.toContain("refused");
    expect(l.relayed.join(" ")).toContain("Dane tapped");
  }, 30_000);
});

describe("6. rollback: the keeper as of main tolerates the ledger's files", () => {
  test("its plan reads and edits a list with the Checked column, and never trips on checks.json or the audit file", () => {
    const k = record();
    k.ok([k.check("P44", CHECKED)]);
    k.ok([{ op: "one-off", text: "Lunch at noon?", not_about_item: true }]);
    const files = { ...k.files, [ONE_OFF_AUDIT_PATH]: "# One-off audit\n\nWeek to Nov 11, 2026: 0 possible matches in 1 one-off; 0 wait timeouts.\n" };
    expect(files[P]).toContain("| Since | Checked |");
    const t: old.Tree = { sha: (p) => (p in files ? "x".repeat(40) : null), read: (p) => (files as any)[p] ?? null };
    const req = (ops: any[]): old.Request => ({ id: "laptop-old-1", from: "cain", kind: "change", summary: "s", ops });
    const edit = old.plan(req([{ op: "row", item: "P44", base: rowHash(openRow(files[P], "P44")!), set: { "Next step": "Build it" } }]), t, { at: T0 });
    expect(edit.state).toBe("ok");
    if (edit.state === "ok") {
      const text = edit.writes.get(P)!;
      expect(old.openRow(text, "P44")).toContain("| Build it |");
      expect(old.openRow(text, "P44")).toContain("| fresh, Nov 11, 2026 8:00 AM");   // left as it was: the old keeper ignores it
      expect(edit.writes.has(CHECKS_PATH)).toBe(false);
    }
    expect(old.plan(req([{ op: "row-add", item: "P46", cells: { Item: "Gutter cleaning", Who: "Cain" } }]), t, { at: T0 }).state).toBe("ok");
    expect(old.plan(req([{ op: "row-close", item: "P11", evidence: "shipped" }]), t, { at: T0 }).state).toBe("ok");
    expect(old.plan(req([{ op: "put", path: P, content: files[P].replace("| Nov 7 |", "| Nov 6 |"), base: "x".repeat(40) }]), t, { at: T0 }).state).toBe("ok");
    expect(old.hygiene(new Map(Object.entries(files).filter(([p]) => p.endsWith(".md"))))).toEqual([]);
    // The link's reading of the list (closed items) is untouched by the column.
    expect(closedItems(files[P]).has("P06")).toBe(true);
    // Requests only the new link sends are rejected by it, harmlessly.
    expect(old.parseRequest(JSON.stringify({ id: "link-check-p44-9", from: "cain", kind: "change", summary: "s",
      ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] })).error).toBe("op without a path");
  });

  test("its round runs on the record as this version leaves it, and this version, back again, gives rows it changed a new version", async () => {
    const k = keeperRig();
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    k.cain({ id: "link-oneoff-1", summary: "One-off ask to him: Lunch at noon?", ops: [{ op: "one-off", text: "Lunch at noon?", not_about_item: true }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.upstream(ONE_OFF_AUDIT_PATH)).not.toBeNull();
    const ledgered = parseChecks(k.upstream(CHECKS_PATH));
    // Rolled back: the old keeper edits P44 and rejects a queued check, without error.
    const base = rowHash(openRow(readFileSync(join(k.cfg.dir, P), "utf8"), "P44")!);
    k.cain({ id: "cain-old-1", ops: [{ op: "row", item: "P44", base, set: { "Next step": "Build it" } }] });
    k.cain({ id: "link-check-p44-2", ops: [{ op: "check", item: "P44", text: "the specialist's log, read at 9", row: ledgered.P44.id, version: 1 }] });
    expect(oldCycle(k.cfg as any).ok).toBe(true);
    expect(k.states("cain-old-1")).toEqual(["done"]);
    expect(k.states("link-check-p44-2")).toEqual(["rejected"]);
    expect(openRow(k.upstream(P), "P44")).toContain("| Build it |");
    expect(parseChecks(k.upstream(CHECKS_PATH))).toEqual(ledgered);          // ignored, untouched
    // Forward again: the ledger's hash shows P44 changed outside it; the link won't rest on the
    // old check, and the keeper's next round gives P44 its new version.
    const l = linkRig({ unchecked: true, pending: k.upstream(P) });
    l.files.checks = k.upstream(CHECKS_PATH);
    expect(inStep(ledgered.P44, k.upstream(P), "P44")).toBe(false);
    await expect(l.link.ask({ text: "Is it fixed?", options: ["Fixed", "Not fixed"], item: "P44", question: "Q1" }))
      .rejects.toThrow("This item's row was changed outside the record keeper since its check");
    expect(cycle(k.cfg).ok).toBe(true);
    expect(parseChecks(k.upstream(CHECKS_PATH)).P44).toMatchObject({ id: ledgered.P44.id, version: 2, checked_version: 1 });
    expect(k.subjects(1)[0]).toBe("Source checks: P44 changed outside the keeper");
  });
});

describe("7. checks are taken and aged only on a synchronized clock, the keeper's own", () => {
  test("unsynchronized: the check is refused and nothing ages; synchronized: it is taken with the keeper's stale_after", () => {
    const k = record({ [P]: PENDING }, false);
    expect(k.no([k.check("P44", CHECKED)])).toBe("check P44: the keeper's clock isn't synchronized yet, so no source check can be dated; try again in a few minutes");
    const s = record();
    s.ok([s.check("P44", CHECKED)]);
    expect(s.ledger().P44).toMatchObject({ checked_at: T0.toISOString(), stale_after: new Date(T0.getTime() + 7 * DAY).toISOString() });
  });

  test("on the keeper: a check past its stale_after is aged by its own clock, only while synchronized; the link honours the mark whatever its clock says", async () => {
    const k = keeperRig();
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    k.synced.ok = false;
    k.running(new Date(T0.getTime() + 8 * DAY));
    k.cain({ id: "link-check-p44-2", ops: [{ op: "check", item: "P44", text: "the specialist's log, read at 9", row: parseChecks(k.upstream(CHECKS_PATH)).P44.id, version: 1 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("link-check-p44-2")).toContain("the keeper's clock isn't synchronized yet");
    expect(parseChecks(k.upstream(CHECKS_PATH)).P44.aged).toBeUndefined();
    k.synced.ok = true;
    expect(cycle(k.cfg).ok).toBe(true);
    const e = parseChecks(k.upstream(CHECKS_PATH)).P44;
    expect(e.aged).toBe(new Date(T0.getTime() + 8 * DAY).toISOString());
    expect(openRow(k.upstream(P), "P44")).toContain("| stale, Nov 11, 2026");
    expect(k.subjects(1)[0]).toBe("Source checks: P44 aged out");
    // A link whose clock is behind (still on the check's day) refuses it all the same.
    const l = linkRig({ unchecked: true, pending: k.upstream(P), now: T0.getTime() + HOUR });
    l.files.checks = k.upstream(CHECKS_PATH);
    await expect(l.link.ask({ text: "Is it fixed?", options: ["Fixed", "Not fixed"], item: "P44", question: "Q1" })).rejects.toThrow("source check");
    expect(l.posts()).toBe(0);
  });

  test("the box's own reading is a yes or a no, never an error", () => {
    expect(typeof clockSynced()).toBe("boolean");
  });
});

describe("8. a code that comes back gets a new hidden id", () => {
  test("closed then written again with the same Item, and deleted then written again: each time a new id", () => {
    const k = record();
    k.ok([k.check("P44", CHECKED)]);
    const first = k.ledger().P44.id;
    const line = openRow(PENDING, "P44")!;
    // Closed (row-close), then a whole-file write puts it back in Open, identical Item text.
    k.later(MIN);
    k.ok([{ op: "row-close", item: "P44", evidence: "fixed" }]);
    expect(k.ledger().P44).toBeUndefined();
    k.later(MIN);
    k.ok([{ op: "put", path: P, content: k.files[P].replace("\n\n## Done", `\n${line}\n\n## Done`), base: "x".repeat(40) }]);
    const second = k.ledger().P44;
    expect(second.id).not.toBe(first);
    expect(second).toMatchObject({ version: 1 });
    expect(second.checked).toBeUndefined();
    // Deleted in one write, added again in a later one with the same text.
    k.later(MIN);
    k.ok([{ op: "put", path: P, content: k.files[P].split("\n").filter((l) => !l.startsWith("| P44 ")).join("\n"), base: "x".repeat(40) }]);
    k.later(MIN);
    k.ok([{ op: "put", path: P, content: k.files[P].replace("\n\n## Done", `\n${line}\n\n## Done`), base: "x".repeat(40) }]);
    expect(new Set([first, second.id, k.ledger().P44.id]).size).toBe(3);
    // A check read on the old row never lands on the new one.
    expect(k.no([{ op: "check", item: "P44", text: "the specialist's log, read at 9", row: first, version: 1 }])).toContain("of a new row");
  });

  test("the same check applied again (a lost push) gives a row the ledger didn't know the same id", () => {
    const req: Request = { id: "link-check-p44-7", from: "cain", kind: "change", summary: "s", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] };
    const a = plan(req, tree({ [P]: PENDING }), { at: T0, clockSynced: true });
    const b = plan(req, tree({ [P]: PENDING }), { at: new Date(T0.getTime() + MIN), clockSynced: true });
    if (a.state !== "ok" || b.state !== "ok") throw new Error("not ok");
    expect(parseChecks(a.writes.get(CHECKS_PATH)!).P44.id).toBe(parseChecks(b.writes.get(CHECKS_PATH)!).P44.id);
  });
});

describe("9. every refusal quotes what it matched, and is logged for tuning", () => {
  test("the vague word, the mail word, the repeated check, the bundled clauses, the overlapping words", async () => {
    expect(checkTextProblem("the county portal, checked earlier")).toContain(`can't rest on "earlier"`);
    expect(checkTextProblem("his Gmail inbox, read 11/15 at 9")).toContain(`a source check of a mail ("Gmail")`);
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    await expect(r.link.ask({ text: "Is it filed?", options: opts, item: "P08", question: "Q1", checked: "I remember the portal at 9:40" })).rejects.toThrow(`"I remember"`);
    expect(r.tuned).toEqual([{ at: new Date(NOV11_8AM).toISOString(), kind: "check", item: "P08", said: expect.stringContaining(`"I remember"`) }]);
    const k = record();
    expect(k.no([{ op: "row-add", item: "P45", cells: { Item: "Tax return filed. Refund received", Who: "Cain" } }])).toContain(`("Tax return filed" and "Refund received")`);
  });
});

describe("10. a row's Next step holds the current step: capped, history goes to a note", () => {
  const long = (n: number) => `Step: ${"x".repeat(n - 6)}`;
  test("a row-add or row edit over the cap is refused, pointing to the note op; one already over may shrink, never grow", () => {
    const k = record();
    expect(k.no([{ op: "row-add", item: "P45", cells: { Item: "Gutter cleaning", Who: "Cain", "Next step": long(MAX_NEXT_STEP + 1) } }]))
      .toBe(`P45's Next step is ${MAX_NEXT_STEP + 1} characters, over ${MAX_NEXT_STEP} ("Step: ${"x".repeat(44)}..."): keep the current step and its latest source check there, and move the dated history into a note on the item (the note op)`);
    k.ok([{ op: "row-add", item: "P45", cells: { Item: "Gutter cleaning", Who: "Cain", "Next step": long(MAX_NEXT_STEP) } }]);
    expect(k.no([{ op: "row", item: "P45", base: k.base("P45"), set: { "Next step": long(MAX_NEXT_STEP + 1) } }])).toContain("move the dated history into a note on the item");
    // A row already over the cap (written before it): it may shrink, still over, but not grow.
    const over = k.files[P].replace(long(MAX_NEXT_STEP), long(MAX_NEXT_STEP + 300));
    k.files[P] = over;
    k.ok([{ op: "row", item: "P45", base: k.base("P45"), set: { "Next step": long(MAX_NEXT_STEP + 100) } }]);
    expect(k.no([{ op: "row", item: "P45", base: k.base("P45"), set: { "Next step": long(MAX_NEXT_STEP + 101) } }])).toContain("over 800");
    // A whole-file write that grows one past the cap is refused whole.
    const grown = k.files[P].replace("Hold the Build until P33 lifts", long(MAX_NEXT_STEP + 5));
    expect(k.no([{ op: "put", path: P, content: grown, base: "x".repeat(40) }])).toStartWith(`${P} wasn't written (a whole-file write lands whole or not at all): P44's Next step is ${MAX_NEXT_STEP + 5} characters`);
    // The note op takes the history.
    k.ok([{ op: "note", item: "P45", text: "Nov 3: called them; Nov 5: quote in" }]);
  });

  test("Cain's rules say where history goes", () => {
    const rules = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/CLAUDE.md"), "utf8");
    expect(rules).toContain("A row's Next step holds the current step and its latest source check; dated history goes in a note on the item");
  });
});

describe("5 and 11. the docs say what is mechanical, and the smoke test's two paths", () => {
  test("DOCS.md and Cain's rules", () => {
    const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md");
    for (const t of [docs, rules]) {
      expect(t).toContain("deliberately vague");
      expect(t).toContain("commit hashes");
    }
    expect(docs).toContain("proves a check was recorded, not that the source was read");
    expect(docs).toContain("ignores state/checks.json");
    expect(docs).toContain("Resting on Cain's recorded attestation");
    expect(rules).toContain("not that the source was read");
  });
});

void PR; void SHA1; void existsSync;
