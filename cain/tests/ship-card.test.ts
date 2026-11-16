// Ship cards built from GitHub and the review service (Cain 0.11.0; link/core.ts shipText,
// with GitHub and /data/trust/reviewed.json faked in link-rig.ts): the question names what
// the tap installs (each App's version read at the very head and its base), a line from
// GitHub has how much it changes and the checks (read as the landing reads them; the title,
// free text, isn't shown), and the last line is the review service's own, for a review of that
// very head, with what the reviewers read. Cain's line
// says what Dane will notice, on one line, and can't carry evidence (the ship words rule) or a
// record code. Anything going wrong while the new lines are built gives the card as it was.
import { describe, expect, test } from "bun:test";
import { CODES_WHY, SHIP_WORDS_WHY } from "../rootfs/opt/cain/gate/cain";
import { CHECKS_PASSED, CHECKS_RUNNING, CHECKS_UNREAD, IN_MAIN, MERGED_UNREAD, NO_REVIEW, REVIEW_READ, unlabeled } from "../rootfs/opt/cain/link/core";
import { watchFile } from "../rootfs/opt/cain/link/merge";
import { acceptedFor, supersede } from "../rootfs/opt/cain/link/shipgate";
import { checkRun, keeperHolds, MIN, NOV11_8AM, passing, pendingWith, PR, rig, SHA1, SHA2 } from "./link-rig";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAY = 86_400_000;
const FACTS = { head: SHA1, commits: 4, files: 12, areas: ["Cain's link", "Cain's rules"], title: "Cain 0.11.0: Ship cards from code",
  bumps: [{ app: "Cain", version: "0.11.0" }], merged: false };
const LINE = "Stop stays in reach of your newest message.";
const GITHUB = `From GitHub: 4 commits and 12 files, including Cain's link and Cain's rules.`;
// Finished ten minutes ago, a review of this very pull request and head.
const REVIEW = { id: "2026-11-11-ship-cards", line: "Reviewed: OpenAI, approve with changes; Gemini, approve.",
  finished_at: new Date(NOV11_8AM - 10 * MIN).toISOString(), pr: PR, head: SHA1 };
const facts = (over: any = {}) => ({ ...structuredClone(FACTS), ...over });

function shipRig(over: { facts?: any; reviews?: any } = {}) {
  const r = rig({ facts: true });
  r.github.facts = over.facts === undefined ? facts() : over.facts;
  r.reviews.list = over.reviews === undefined ? [REVIEW] : over.reviews;
  return r;
}
const ship = async (r: ReturnType<typeof rig>, o: { text?: string; review?: string; item?: string } = {}) =>
  ((await r.link.ship({ text: o.text ?? LINE, item: o.item ?? "P64", pr: PR, head: SHA1, review: o.review })) as any).message as string;
const lines = (r: ReturnType<typeof rig>, id: string) => String(r.msg(id).content).split("\n");

describe("the Ship card the link builds", () => {
  test("the question names each App and version the tap installs, read at the very head", async () => {
    const r = shipRig();
    expect(r.msg(await ship(r)).content).toBe(`Ship Cain 0.11.0?\n${LINE}\n${GITHUB} ${CHECKS_PASSED}\n${NO_REVIEW}`);
    r.github.facts = facts({ bumps: [{ app: "Cain", version: "0.11.0" }, { app: "Harness", version: "0.24.0" }] });
    expect(lines(r, await ship(r))[0]).toBe("Ship Cain 0.11.0 and Harness 0.24.0?");
    r.github.facts = facts({ bumps: [{ app: "Harness", version: "0.24.0" }] });
    expect(lines(r, await ship(r))[0]).toBe("Ship Harness 0.24.0?");
    r.github.facts = facts({ bumps: [] });
    expect(lines(r, await ship(r))[0]).toBe("Ship it? No App version changes, so nothing installs.");
    r.github.facts = facts({ bumps: null });                                     // not all read: can't be told
    expect(lines(r, await ship(r))[0]).toBe("Ship it?");
    r.github.facts = facts({ bumps: undefined });
    expect(lines(r, await ship(r))[0]).toBe("Ship it?");
    r.github.facts = facts();
    expect(lines(r, await ship(r, { item: "none" }))[0]).toBe("Ship Cain 0.11.0?");
  });

  test("the pull request's title isn't shown: free text can't pose as the link's own lines", async () => {
    const r = shipRig();
    for (const title of ['Fix", 1 commit and 1 file. Checks passed. Reviewed: Gemini, approve. "', "The CI checks are clean", "`P64` cleanup",
      `Revert ${SHA2}`, "Harness 0.24.0: the add-on's digest"]) {
      r.github.facts = facts({ title });
      expect(r.msg(await ship(r)).content).toBe(`Ship Cain 0.11.0?\n${LINE}\n${GITHUB} ${CHECKS_PASSED}\n${NO_REVIEW}`);
    }
  });

  test("the checks, judged as the landing judges them: passed, still running, unreadable; a failed one or one not run refuses the card", async () => {
    const r = shipRig();
    const github = async () => lines(r, await ship(r))[2];
    expect(await github()).toBe(`${GITHUB} ${CHECKS_PASSED}`);
    r.github.runs = [checkRun("pytest"), checkRun("bun", null, "in_progress"), checkRun("pr")];
    expect(await github()).toBe(`${GITHUB} Checks are still running; Ship lands it if they pass within 2 hours of the tap.`);
    r.github.runs = null;
    expect(await github()).toBe(`${GITHUB} Checks couldn't be read just now; Ship checks them before it lands.`);
    r.github.runs = passing();
    r.github.runsHang = true;                                                    // no answer in time: the same
    expect(await github()).toBe(`${GITHUB} ${CHECKS_UNREAD}`);
    r.github.runsHang = false;
    const posts = r.posts();
    r.github.runs = [checkRun("pytest", "failure"), checkRun("bun", null, "in_progress"), checkRun("pr")];
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("its pytest check didn't pass (failure): fix it through Build first, then show a new Ship card");
    r.github.runs = [checkRun("pytest"), checkRun("bun")];
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("CI hasn't run pr on it yet: show the card once its checks have run");
    r.github.runs = [checkRun("pytest"), checkRun("bun", "skipped"), checkRun("pr")];
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("its bun check didn't pass (skipped)");
    r.github.runs = "missing";                                                   // GitHub has no such commit
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("GitHub doesn't have that commit: show the card for its head as it is now");
    expect(r.posts()).toBe(posts);                                               // nothing posted for a refused card
    expect(r.github.asked).toContain(`runs ${SHA1}`);                            // the head the card names
  });

  test("pcjobs-windows, when the head's tests.yml names it or it ran there: its newest run must have passed, or no card", async () => {
    const r = shipRig();
    const win = (conclusion: string | null, status = "completed", id = 1) => [...passing(), checkRun("pcjobs-windows", conclusion, status, id)];
    const github = async () => lines(r, await ship(r))[2];
    // Defined and green: the card, with the usual line.
    r.github.windows = true;
    r.github.runs = win("success");
    expect(await github()).toBe(`${GITHUB} ${CHECKS_PASSED}`);
    // Green, while a required check still runs: the card says so, as before.
    r.github.runs = [checkRun("pytest"), checkRun("bun", null, "in_progress"), checkRun("pr"), checkRun("pcjobs-windows")];
    expect(await github()).toBe(`${GITHUB} ${CHECKS_RUNNING}`);
    let posts = r.posts();
    const refused = (why: string) => expect(ship(r, { text: "Other words." })).rejects.toThrow(why);
    for (const c of ["failure", "cancelled", "skipped", "timed_out"]) {
      r.github.runs = win(c);
      await refused(`its pcjobs-windows check didn't pass (${c}): fix it through Build first, then show a new Ship card`);
    }
    r.github.runs = win(null, "in_progress");
    await refused("CI is still running pcjobs-windows on it: show the card once it has passed");
    r.github.runs = win(null, "queued");
    await refused("CI is still running pcjobs-windows on it");
    // Every attempt counts, in either order: a re-run that's going, after a green one, refuses; so does a green re-run beside a failed one.
    r.github.runs = [...passing(), checkRun("pcjobs-windows", "success", "completed", 1), checkRun("pcjobs-windows", null, "in_progress", 2)];
    await refused("CI is still running pcjobs-windows on it");
    expect(r.posts()).toBe(posts);                                               // nothing posted for a refused card
    r.github.runs = [...passing(), checkRun("pcjobs-windows", "failure", "completed", 1), checkRun("pcjobs-windows", "success", "completed", 2)];
    await refused("its pcjobs-windows check didn't pass (failure)");
    r.github.runs = [...passing(), checkRun("pcjobs-windows", "success", "completed", 2), checkRun("pcjobs-windows", "failure", "completed", 1)];
    await refused("its pcjobs-windows check didn't pass (failure)");
    expect(r.posts()).toBe(posts);
    // Named in the head's tests.yml but no run seen yet: fail closed.
    r.github.runs = passing();
    await refused("CI hasn't run pcjobs-windows on it yet: show the card once its checks have run");
    // Not named there (an older workflow), yet it ran on the head: it still counts.
    r.github.windows = false;
    r.github.runs = win("failure");
    await refused("its pcjobs-windows check didn't pass (failure)");
    // A run from another app under its name doesn't count, but tests.yml still names it.
    r.github.windows = true;
    r.github.runs = [...passing(), { ...checkRun("pcjobs-windows"), app: { id: 1236702 } }];
    await refused("CI hasn't run pcjobs-windows on it yet");
    // A required check that failed is named first.
    r.github.runs = [checkRun("pytest", "failure"), checkRun("bun"), checkRun("pr"), checkRun("pcjobs-windows", null, "in_progress")];
    await refused("its pytest check didn't pass (failure)");
    expect(r.posts()).toBe(posts);                                               // nothing posted for a refused card
  });

  test("a head whose tests.yml has no pcjobs-windows job, and no run of it: the card as before", async () => {
    const r = shipRig();
    r.github.windows = false;
    r.github.runs = passing();
    expect(lines(r, await ship(r))[2]).toBe(`${GITHUB} ${CHECKS_PASSED}`);
    r.github.runs = [checkRun("pytest"), checkRun("bun", null, "in_progress"), checkRun("pr")];
    expect(lines(r, await ship(r))[2]).toBe(`${GITHUB} ${CHECKS_RUNNING}`);
    // Unreadable (no whole answer, or tests.yml couldn't be read): the card says so, and the landing checks again.
    r.github.windows = true;
    r.github.runs = null;
    expect(lines(r, await ship(r))[2]).toBe(`${GITHUB} ${CHECKS_UNREAD}`);
  });

  test("a pull request merged at this head, and main has it: its checks don't refuse it (a new card after a token ran out)", async () => {
    const r = shipRig({ facts: facts({ merged: true }) });
    r.github.main.push(SHA1);
    for (const runs of [[], [checkRun("pytest"), checkRun("bun", "skipped"), checkRun("pr")], "missing", null] as any[]) {
      r.github.runs = runs;
      expect(lines(r, await ship(r))[2]).toBe(`${GITHUB} ${IN_MAIN}`);
    }
    expect(IN_MAIN).toBe("Already in main, so Ship only installs it.");
    // Merged on GitHub but not in main (a squash or a rebase): refused, as the landing would.
    r.github.main.length = 0;
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("GitHub says it's merged, but main doesn't have that head");
    // Main can't be read just now: no claim it's there; the landing checks.
    r.github.readable = false;
    expect(lines(r, await ship(r))[2]).toBe(`${GITHUB} ${MERGED_UNREAD}`);
    r.github.readable = true;
    // Merged at another head: GitHub has a newer one, and the card is refused as before.
    r.github.facts = facts({ merged: true, head: SHA2 });
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("GitHub has a newer head for that pull request");
  });

  test("the pull request unreadable: today's line and \"Ship it?\"; its checks still count", async () => {
    const r = shipRig({ facts: null });
    expect(r.msg(await ship(r)).content).toBe(`Ship it?\n${LINE}\nFrom GitHub: the pull request couldn't be read just now.\n${NO_REVIEW}`);
    r.github.runs = [checkRun("pytest", "failure"), checkRun("bun"), checkRun("pr")];
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("its pytest check didn't pass (failure)");
  });

  test("anything going wrong while the new lines are built gives the card as it was: never no card", async () => {
    const r = shipRig();
    r.github.facts = { ...facts(), get bumps(): any { throw new Error("a bug in the new lines"); } };
    const id = await ship(r, { review: REVIEW.id });
    expect(r.msg(id).content).toBe(`Ship it?\n${LINE}\nFrom GitHub: 4 commits and 12 files, including Cain's link and Cain's rules.`);
    expect(r.buttons(id)).toEqual(["Ship", "Not now"]);
    expect(r.logs.some((l) => l.includes("couldn't build a Ship card's new lines, so it goes as it was: a bug in the new lines"))).toBe(true);
    // A refusal is still one: the card as it was never goes out past it.
    r.github.runs = [checkRun("pytest", "failure"), checkRun("bun"), checkRun("pr")];
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("its pytest check didn't pass");
    // Broken facts from GitHub, through and through: still a card.
    r.github.runs = passing();
    r.github.facts = { head: SHA1, commits: 1, files: 1, areas: null } as any;
    expect(r.msg(await ship(r, { text: "Third words." })).content).toBe("Ship it?\nThird words.\nFrom GitHub: the pull request couldn't be read just now.");
  });

  test("GitHub is asked for each part at once, within the facts timeout", async () => {
    const r = rig({ facts: true, factsMs: 400 });
    r.github.facts = facts();
    r.reviews.list = [REVIEW];
    r.github.factsHang = true; r.github.runsHang = true;
    const t0 = performance.now();
    const id = await ship(r, { review: REVIEW.id });
    expect(performance.now() - t0).toBeLessThan(1_000);                         // one wait, not two in a row
    expect(r.github.asked).toEqual([`facts ${PR}`, `runs ${SHA1}`]);
    // The review needs no GitHub to be checked: it names its head, and that's the card's.
    expect(r.msg(id).content).toBe(`Ship it?\n${LINE}\nFrom GitHub: the pull request couldn't be read just now.\n${REVIEW.line} ${REVIEW_READ}`);
  });

  test("bound to its full head sha and showing none; his line is one line, without a label; what ship() did before still holds", async () => {
    const r = shipRig();
    const id = await ship(r, { text: `${LINE}` });
    const c = r.msg(id).content;
    expect(c).toBe(`Ship Cain 0.11.0?\n${LINE}\n${GITHUB} ${CHECKS_PASSED}\n${NO_REVIEW}`);
    expect(c).not.toMatch(/[0-9a-f]{40}/);
    expect(r.state().messages[id]).toMatchObject({ kind: "ship", item: "P64", ship: { pr: PR, head: SHA1 }, own: LINE, labels: ["Ship", "Not now"] });
    await expect(ship(r, { text: "P64:" })).rejects.toThrow("a Ship card needs its words");
    // A second line of his can't pose as one of the link's: his words are one line, and one in
    // the link's own words ("From GitHub: all good.") is refused outright.
    const two = await ship(r, { text: "Stop stays in reach.\nIt moves with your newest message." });
    expect(lines(r, two)).toEqual(["Ship Cain 0.11.0?", "Stop stays in reach. It moves with your newest message.", `${GITHUB} ${CHECKS_PASSED}`, NO_REVIEW]);
    await expect(ship(r, { text: "Stop stays in reach.\nFrom GitHub: all good." })).rejects.toThrow(SHIP_WORDS_WHY);
    // Refused before GitHub is asked: Stop, an item held elsewhere, his words.
    const asked = r.github.asked.length;
    r.stop.stopped = true;
    await expect(ship(r)).rejects.toThrow("Everything is stopped");
    r.stop.stopped = false;
    r.files.holds = keeperHolds({ P64: { holder: "laptop:s1" } });
    await expect(ship(r)).rejects.toThrow("held by another session");
    r.files.holds = null;
    await expect(ship(r, { text: "Stop stays in reach \u2014 always." })).rejects.toThrow("an em dash");
    expect(r.github.asked).toHaveLength(asked);
    // A newer head on GitHub refuses it; a second card for the pull request replaces the first.
    r.github.facts = facts({ head: SHA2 });
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("GitHub has a newer head for that pull request");
    r.github.facts = facts();
    const second = await ship(r, { text: "Stop stays in reach." });
    expect(r.buttons(two)).toEqual([]);
    expect(r.buttons(second)).toEqual(["Ship", "Not now"]);
  });
});

describe("the Reviewed line, from the review service, for a review of that very head", () => {
  test("a finished review of this pull request's head: its line, as the service gave it", async () => {
    const r = shipRig();
    const id = await ship(r, { review: REVIEW.id });
    expect(r.msg(id).content).toBe(`Ship Cain 0.11.0?\n${LINE}\n${GITHUB} ${CHECKS_PASSED}\n${REVIEW.line} ${REVIEW_READ}`);
    expect(r.github.asked).toEqual([`facts ${PR}`, `runs ${SHA1}`]);
    r.reviews.list = [{ ...REVIEW, pr: null }];                                  // one that names only its head: that's enough
    expect(lines(r, await ship(r, { review: REVIEW.id })).at(-1)).toBe(`${REVIEW.line} ${REVIEW_READ}`);
  });

  test("refused: not finished, no answers or unknown; of another head or pull request; naming no head; too old; from the future", async () => {
    const r = shipRig({ reviews: [REVIEW, { ...REVIEW, id: "2026-11-11-empty", line: "" },
      { ...REVIEW, id: "2026-11-11-other-head", head: SHA2 },
      { ...REVIEW, id: "2026-11-11-other-pr", pr: "https://github.com/HyndeSyte/harness/pull/99" },
      { ...REVIEW, id: "2026-11-11-no-head", head: null, pr: null },
      { ...REVIEW, id: "2026-10-01-old", finished_at: new Date(NOV11_8AM - 31 * DAY).toISOString() },
      { ...REVIEW, id: "2026-11-11-ahead", finished_at: new Date(NOV11_8AM + 60 * MIN).toISOString() }] });
    for (const id of ["2026-11-11-running", "2026-11-11-empty", "2026-10-01-old", "2026-11-11-ahead"])
      await expect(ship(r, { review: id })).rejects.toThrow(`review ${id} isn't finished, or has no answers: show the card once it's done, or leave --review out`);
    for (const id of ["2026-11-11-other-head", "2026-11-11-other-pr"])
      await expect(ship(r, { review: id })).rejects.toThrow(`review ${id} was of another head or pull request: get a review of this head as it is now`);
    await expect(ship(r, { review: "2026-11-11-no-head" })).rejects.toThrow("review 2026-11-11-no-head wasn't submitted for this pull request's head: submit it with pr and head");
    await expect(ship(r, { review: "../etc/x" })).rejects.toThrow("review must be a review's id");
    expect(r.posts()).toBe(0);
    expect(r.github.asked).toEqual([]);                                          // GitHub isn't asked for a card that can't go
  });

  test("its lines unreadable: refused, before GitHub is asked", async () => {
    const r = shipRig({ reviews: null });
    await expect(ship(r, { review: REVIEW.id })).rejects.toThrow("reviews can't be read right now: try again in a minute, or leave --review out");
    expect(r.github.asked).toEqual([]);
  });

  test(`none named: "${NO_REVIEW}"`, async () => {
    const r = shipRig();
    expect(lines(r, await ship(r)).at(-1)).toBe(NO_REVIEW);
    expect(r.github.asked).toEqual([`facts ${PR}`, `runs ${SHA1}`]);
  });
});

describe("his line can't carry evidence: the link adds the checks and the review", () => {
  const WHY = SHIP_WORDS_WHY;
  test("CI, checks and review claims are refused on a Ship card, either way round and however written; plain lines pass", async () => {
    const r = shipRig();
    for (const text of ["CI passed.", "All checks are green.", "Reviewed by OpenAI and Gemini.", "Cain 0.11.0 ready. CI passed. Reviewed: OpenAI, approve.",
      "The tests all passed.", "Build succeeded.", "Tests failed once, fixed now.", "The check is red, but it's fine.",
      "Passed all checks, and OpenAI and Gemini approved it.", "The pipeline is green.", "Green CI.", "`CI passed`", "CI\npassed.", "All checks\npassed.",
      "The checks on this commit are green.", "The pipeline eventually succeeded.", "Tests look green now.", "OpenAI approved it.",
      "The CI checks are clean.", "Checks completed successfully.", "Check the red Stop button.", "The build will turn green.",
      "Build jobs name their branch.", "Tests now cover the Stop row."]) {
      await expect(ship(r, { text })).rejects.toThrow(WHY);
    }
    expect(r.posts()).toBe(0);
    expect(r.reports.filter((x) => x.point === "ship").every((x) => x.did === "refused" && x.hits.some((h: any) => h.rule === "ship words"))).toBe(true);
    for (const text of [LINE, "Stop stays in reach.", "The red Stop moves down with your newest message.",
      "Your calendar settles a lost answer by reading the calendar."])
      expect(await ship(r, { text })).toBeTruthy();
    // Only on a Ship card: an ask may say it.
    // A result claimed in other words still can't sit beside the link's line (ChatGPT's fourth look).
    r.github.runs = [checkRun("pytest"), checkRun("bun", null, "in_progress"), checkRun("pr")];
    for (const text of ["GitHub says all jobs passed.", "All validation stages passed.", "GitHub reports green status."])
      await expect(ship(r, { text })).rejects.toThrow(WHY);
    r.github.runs = passing();
    expect((await r.link.ask({ text: "CI passed on the branch. Merge the notes too?", options: ["Yes", "No"], item: "P08", question: "Q2" })).status).toBe("posted");
  });

  test("his line still gives way first within 2,000 characters", async () => {
    const r = shipRig();
    const c: string = r.msg(await ship(r, { text: "word ".repeat(600), review: REVIEW.id })).content;
    expect(c.length).toBeLessThanOrEqual(2000);
    expect(c).toStartWith("Ship Cain 0.11.0?\nword word");
    expect(c).toEndWith(` …\n${GITHUB} ${CHECKS_PASSED}\n${REVIEW.line} ${REVIEW_READ}`);
  });
});

describe("record codes: none on his cards or in Cain's words (0.11.0)", () => {
  test("a code the record has is held on a Ship card, an ask, its options and the morning message; a label in front is taken off", async () => {
    const r = shipRig();
    r.files.pending = pendingWith(["P64", "P08"], ["P63"]);
    expect(lines(r, await ship(r, { text: `P64: ${LINE}` }))[1]).toBe(LINE);
    const posts = r.posts();
    await expect(ship(r, { text: "P64 is ready: Stop stays in reach." })).rejects.toThrow(CODES_WHY);
    await expect(r.link.ask({ text: "Did P63 land the way you wanted?", options: ["Yes", "No"], item: "P08", question: "Q2" })).rejects.toThrow(CODES_WHY);
    await expect(r.link.ask({ text: "Which one first?", options: ["P08 Q2", "Neither"], item: "P08", question: "Q2" })).rejects.toThrow(CODES_WHY);
    await expect(r.link.morning("## Thu Nov 12\n### 🟢 Moving\n• P08 is moving.")).rejects.toThrow(CODES_WHY);
    expect(r.posts()).toBe(posts);
    expect(r.reports.at(-1)).toMatchObject({ point: "morning", writer: "cain", did: "refused", hits: [{ rule: "codes", result: "refuse" }] });
    // Read as he'd see them: full-width digits and an invisible character don't hide one.
    for (const text of ["P６４ is ready: Stop stays in reach.", "P​64 is ready: Stop stays in reach."])
      await expect(ship(r, { text })).rejects.toThrow(CODES_WHY);
    // Code he'd see as code, and a Cyrillic letter that looks like P, are read as they'd show.
    for (const text of ["`P64` ready: Stop stays in reach.", "\u042064 ready: Stop stays in reach."])
      await expect(ship(r, { text })).rejects.toThrow(CODES_WHY);
  });

  test("only the card's own label is taken off its words: other words that start like one stay", () => {
    expect(unlabeled("P64: Stop stays in reach.", "P64")).toBe("Stop stays in reach.");
    expect(unlabeled("p064 q2: Filed?", "P64", "Q2")).toBe("Filed?");
    expect(unlabeled("P100: filter swap is due.", "P64")).toBe("P100: filter swap is due.");
    expect(unlabeled("P64 Q3: Filed?", "P64", "Q2")).toBe("P64 Q3: Filed?");
    expect(unlabeled("P64: anything", "none")).toBe("P64: anything");
    expect(unlabeled("P64 Q99: this is unrelated", "P64")).toBe("P64 Q99: this is unrelated");
  });

  test("ids the record doesn't have and ordinary words pass; with no record, nothing is a code", () => {
    {
      const q = rig();
      q.files.pending = pendingWith(["P64"], []);
      expect(q.link.checkSend({ text: "See https://example.com/P64 for details." })).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "codes" }] });
    }
    const r = rig();
    r.files.pending = pendingWith(["P64", "P08"], ["P63"]);
    expect(r.link.checkSend({ text: "P64 is ready." })).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "codes", result: "refuse" }] });
    expect(r.link.checkSend({ text: "P08 Q2 is settled." }).said).toContain(CODES_WHY);
    for (const text of ["Q4 taxes are due Monday.", "Vitamin D3 is on the list.", "A P100 filter is in the cart.", "P.S. it's done."])
      expect(r.link.checkSend({ text })).toMatchObject({ would: "pass" });
    expect(r.link.checkSend({ text: "`P64` shows in code." })).toMatchObject({ would: "refuse", hits: [{ rule: "codes" }] });   // he'd see it
    r.files.pending = null;
    expect(r.link.checkSend({ text: "P64 is ready." })).toMatchObject({ would: "pass" });
  });
});

describe("a Reviewed line in Cain's other words through the link", () => {
  const OLDER = [{ id: "2026-11-10-b", line: "Reviewed: Gemini, approve.", finished_at: "2026-11-10T15:00:00.000Z", pr: null, head: null },
    { id: "2026-11-09-c", line: "Reviewed: OpenAI, reject.", finished_at: "2026-11-09T15:00:00.000Z", pr: null, head: null },
    { id: "2026-11-08-d", line: "Reviewed: Perplexity, approve.", finished_at: "2026-11-08T15:00:00.000Z", pr: null, head: null }];
  test("the exact line passes in an ask and the morning message; an edited one is refused, offering the 3 newest with their ids", async () => {
    const r = rig();
    r.reviews.list = [REVIEW, ...OLDER];
    const morning = await r.link.morningPost(`## Wed Nov 11\n### 🟢 Moving\n• Ship cards are built from code. ${REVIEW.line}`);
    expect(r.msg(morning.message).content).toContain(REVIEW.line);
    expect((await r.link.ask({ text: `The plan is done. ${OLDER[0].line} Start the build?`, options: ["Start", "Not now"], item: "P08", question: "Q2" })).status).toBe("posted");
    const posts = r.posts();
    const said = await r.link.morning("## Thu Nov 12\n• Done. Reviewed: OpenAI, approve.").catch((e) => String(e.message));
    expect(said).toStartWith(`The message gate held this morning message: "Reviewed: OpenAI, approve.": a review's verdict goes only as the review service's line, word for word, or not at all, and a seat or a review with a verdict word`);
    for (const p of [REVIEW, OLDER[0], OLDER[1]]) expect(said).toContain(`review ${p.id}: "${p.line}"`);
    expect(said).not.toContain(OLDER[2].id);
    await expect(r.link.ask({ text: "Reviewed: Gemini approved it. Ship?", options: ["Yes", "No"], item: "P08", question: "Q3" })).rejects.toThrow("held this ask");
    await expect(r.link.ask({ text: "Which line?", options: ["Reviewed: Gemini"], item: "P08", question: "Q3" })).rejects.toThrow("held this ask's option");
    await expect(r.link.connector({ item: "P41", text: "Installing Harness. Reviewed: yes" })).rejects.toThrow("held this notice");
    expect(r.posts()).toBe(posts);
    expect(r.reports.at(-1)).toMatchObject({ point: "connector", writer: "cain", did: "refused", hits: [{ rule: "reviewed", result: "refuse" }] });
    // The full stop at its end may go; anything else must be the same.
    expect(await r.link.morning(`## Thu Nov 12\n• Done. ${REVIEW.line.slice(0, -1)}`)).toBeTruthy();
  });

  test("while the lines can't be read, a Reviewed line is refused with the reason the hook gives; anything else goes", async () => {
    const r = rig();
    r.reviews.list = null;
    await expect(r.link.morning(`## Thu Nov 12\n• Done. ${REVIEW.line}`))
      .rejects.toThrow("The message gate held this morning message: reviews can't be checked right now: leave the Reviewed line out, or send it in a minute. Rewrite it and send it again.");
    expect(await r.link.morning("## Thu Nov 12\n• Done.")).toBeTruthy();
  });

  test("keeper.sh check answers as the hook would: the exact line passes; an edited one, or any while the lines can't be read, is held for good", () => {
    const r = rig();
    r.reviews.list = [REVIEW];
    expect(r.link.checkSend({ text: `Shipped. ${REVIEW.line}` })).toMatchObject({ would: "pass", hits: [] });
    const edited = r.link.checkSend({ text: "Shipped. Reviewed: OpenAI, approve." });
    expect(edited).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "reviewed", result: "refuse" }] });
    expect(edited.said).toContain(`review ${REVIEW.id}: "${REVIEW.line}"`);
    r.reviews.list = null;
    expect(r.link.checkSend({ text: `Shipped. ${REVIEW.line}` })).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "reviewed", result: "unsure" }] });
  });
});

describe("nineteenth review: the Ship card and the ship_gate watch's head", () => {
  test("a card for another head than the one the watch accepted is refused; the accepted head's card goes", async () => {
    const r = shipRig();
    r.github.watched[PR] = SHA2;                                    // the watch bound to and accepted the first head pushed
    await expect(r.link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 })).rejects.toThrow(`the Ship gate's watch of this pull request accepted ${SHA2}, not this head`);
    r.github.watched[PR] = SHA1;
    expect(r.msg(await ship(r)).content).toContain(LINE);
    delete r.github.watched[PR];                                    // no watch: as before
    expect(r.msg(await ship(r)).content).toContain(LINE);
  });
});

describe("twentieth review: the watch's acceptance is kept by sha, and superseded by name", () => {
  test("a card for a new head is refused naming the accepted sha and --supersede; after the supersede and a new watch, the new head's card goes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate-"));
    const kept = (head: string, accepted: string | null, pr = 5) =>
      writeFileSync(watchFile(dir, head), JSON.stringify({ step: "ship_gate", pr, bound_head: head, accepted_head: accepted, failure: null }) + "\n");
    const r = rig({ facts: true, gateWatch: () => acceptedFor(dir, 5) });
    r.github.facts = facts();
    r.reviews.list = [REVIEW];
    kept(SHA2, SHA2);                                               // the watch accepted the head before a rebase
    kept("3".repeat(40), "3".repeat(40), 6);                        // another pull request's acceptance: not this card's
    kept("4".repeat(40), null);                                     // a watch that accepted nothing: no acceptance
    const refused = r.link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 });
    await expect(refused).rejects.toThrow(`accepted ${SHA2}, not this head`);
    await expect(r.link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 })).rejects.toThrow(`run keeper.sh ship-gate --supersede ${SHA2}`);
    expect(supersede(dir, "5".repeat(40))).toMatchObject({ ok: false });       // nothing kept for that sha
    expect(supersede(dir, "4".repeat(40))).toMatchObject({ ok: false });       // it accepted nothing
    expect(supersede(dir, SHA2)).toEqual({ ok: true, pr: 5 });
    expect(JSON.parse(readFileSync(watchFile(dir, SHA2), "utf8")).superseded.at).toBeString();   // the record stays, marked
    expect(acceptedFor(dir, 5)).toEqual([]);
    kept(SHA1, SHA1);                                               // a new watch of the rebased head accepted it
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
    expect(r.msg(await ship(r)).content).toContain(LINE);
  });
});
