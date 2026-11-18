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
import { GATE_RECORD_FORMAT, watchAccepted, watchFile } from "../rootfs/opt/cain/link/merge";
import { acceptedFor, supersede, keepWatch, otherLive, takeLock, beat, letGo, LOCK_STALE_MS, CRITICAL_MAX_MS, CRITICAL_SLACK_MS, readGen, genFile, agoWords, gateState, recoverGen, ghHeadRead, githubToken, quarantineRecord, quarantineLog, genRecorded } from "../rootfs/opt/cain/link/shipgate";
import * as gate28 from "../rootfs/opt/cain/link/shipgate";
import { checkRun, keeperHolds, MIN, NOV11_8AM, passing, pendingWith, PR, rig, SHA1, SHA2 } from "./link-rig";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
      // A link in a plugin reply is held too since 0.13.0's second round (it goes through keeper.sh reply), so the
      // code is one of its hits: through the keeper the same words are still held for the code alone.
      const d = q.link.checkSend({ text: "See https://example.com/P64 for details." });
      expect(d).toMatchObject({ would: "refuse", hard: true });
      expect(d.hits.filter((h) => h.rule !== "keeper")).toMatchObject([{ rule: "codes" }]);
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
      writeFileSync(watchFile(dir, head), JSON.stringify({ step: "ship_gate", pr, bound_head: head, accepted_head: accepted, failure: null, gen: 1, format: GATE_RECORD_FORMAT }) + "\n");
    writeFileSync(genFile(dir, 5), "1\n"); writeFileSync(genFile(dir, 6), "1\n");   // twenty-sixth round: generations start at 1
    const r = rig({ facts: true, gateWatch: () => acceptedFor(dir, 5) });
    r.github.facts = facts();
    r.reviews.list = [REVIEW];
    kept(SHA2, SHA2);                                               // the watch accepted the head before a rebase
    kept("3".repeat(40), "3".repeat(40), 6);                        // another pull request's acceptance: not this card's
    kept("4".repeat(40), null);                                     // a watch that accepted nothing: no acceptance
    const refused = r.link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 });
    await expect(refused).rejects.toThrow(`accepted ${SHA2}, not this head`);
    await expect(r.link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 })).rejects.toThrow(`run keeper.sh ship-gate --supersede ${SHA2}`);
    const moved = async () => SHA1;                                 // the pull request's head is the rebased one
    expect(await supersede(dir, "5".repeat(40), moved)).toMatchObject({ ok: false });       // nothing kept for that sha
    expect(await supersede(dir, "4".repeat(40), moved)).toMatchObject({ ok: false });       // it accepted nothing
    expect(await supersede(dir, SHA2, moved)).toEqual({ ok: true, pr: 5 });
    expect(JSON.parse(readFileSync(watchFile(dir, SHA2), "utf8")).superseded.at).toBeString();   // the record stays, marked
    expect(acceptedFor(dir, 5)).toEqual([]);
    kept(SHA1, SHA1);                                               // a new watch of the rebased head accepted it
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
    expect(r.msg(await ship(r)).content).toContain(LINE);
  });
});

describe("twenty-first review: one live acceptance per pull request, and supersede only past the head", () => {
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  test("a watch refuses to accept while another live acceptance of that pull request stands, naming it; after a supersede it accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate21-"));
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), { headNow: (_p, h) => h }).accepted_head).toBe(SHA2);
    expect(otherLive(dir, 5, SHA1)).toEqual([SHA2]);
    const refused = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h });
    expect(refused).toMatchObject({ accepted_head: null, passed: false, failure: "live_acceptance" });
    expect(refused.failure_why).toContain(SHA2);
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);                     // still the one live acceptance
    expect(keepWatch(dir, line("6".repeat(40), 6), watchFile(dir, "6".repeat(40)), { headNow: (_p, h) => h }).accepted_head).toBe("6".repeat(40));   // another pull request's: its own
    expect(await supersede(dir, SHA2, async () => SHA1)).toEqual({ ok: true, pr: 5 });
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h }).accepted_head).toBe(SHA1);
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
  });
  test("supersede refuses while the pull request's head is still the sha being replaced, naming the head, or when the head can't be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate21-"));
    keepWatch(dir, line(SHA2), watchFile(dir, SHA2), { headNow: (_p, h) => h });
    const same = await supersede(dir, SHA2, async () => SHA2);
    expect(same).toMatchObject({ ok: false });
    expect((same as any).why).toContain(`pull request 5's head is still ${SHA2}`);
    expect(await supersede(dir, SHA2, async () => null)).toMatchObject({ ok: false });
    expect(await supersede(dir, SHA2, async () => { throw new Error("down"); })).toMatchObject({ ok: false });
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);
  });
  test("the card reads the single live acceptance; more than one live is refused, naming each", async () => {
    const r = shipRig();
    const r2 = rig({ facts: true, gateWatch: () => [SHA1, SHA2] });
    r2.github.facts = facts();
    r2.reviews.list = [REVIEW];
    await expect(r2.link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 })).rejects.toThrow(`more than one live acceptance (${SHA1}, ${SHA2})`);
    r.github.watched[PR] = SHA1;
    expect(r.msg(await ship(r)).content).toContain(LINE);
  });
});

describe("twenty-second review: one live acceptance per pull request, made true under a per-pull-request lock", () => {
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  test("a second watch of the same pull request finishing while the first holds the lock is never kept as an acceptance", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate22-"));
    let second: any = null;
    const first = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h, beforeWrite: () => { second = keepWatch(dir, line(SHA2), watchFile(dir, SHA2), { headNow: (_p, h) => h, waitMs: 200 }); } });
    expect(first.accepted_head).toBe(SHA1);
    expect(second).toMatchObject({ accepted_head: null, passed: false, failure: "live_acceptance" });
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
    expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);              // the lock is let go
  });
  test("two watches for different heads of one pull request completing together, in two processes: one kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate22-"));
    const mod = join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts");
    const go = Date.now() + 1_500;
    const one = (head: string) => Bun.spawn(["bun", "-e", `const { keepWatch } = await import(${JSON.stringify(mod)});
      const l = ${JSON.stringify(line(head))};
      while (Date.now() < ${go}) {}
      const k = keepWatch(${JSON.stringify(dir)}, l, ${JSON.stringify(watchFile(dir, head))}, { headNow: (_p, h) => h, beforeWrite: () => { const t = Date.now() + 300; while (Date.now() < t) {} } });
      console.log(JSON.stringify({ accepted: k.accepted_head, failure: k.failure }));`], { stdout: "pipe", stderr: "pipe" });
    const ps = [one(SHA1), one(SHA2)];
    const outs = await Promise.all(ps.map(async (p) => { await p.exited; return JSON.parse((await new Response(p.stdout).text()).trim()); }));
    expect(outs.filter((o) => o.accepted).length).toBe(1);
    expect(outs.filter((o) => o.failure === "live_acceptance").length).toBe(1);
    expect(acceptedFor(dir, 5).length).toBe(1);
  }, 30_000);
});

describe("twenty-third review: the gate lock made true", () => {
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  const mod = join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts");
  test("the stale threshold sits well above the bounded critical section", () => {
    expect(CRITICAL_MAX_MS * 4).toBeLessThanOrEqual(LOCK_STALE_MS);
  });
  test("two concurrent stale takeovers in two processes: exactly one proceeds", async () => {
    for (let round = 0; round < 3; round++) {
      const dir = mkdtempSync(join(tmpdir(), "ship-gate23-"));
      const lock = join(dir, "ship-gate-pr-5.lock");
      writeFileSync(lock, JSON.stringify({ pid: 99999, token: "dead-watch", at: "2026-01-01T00:00:00Z" }));
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(lock, old, old);
      const go = Date.now() + 1_500;
      const one = () => Bun.spawn(["bun", "-e", `const { takeLock, letGo } = await import(${JSON.stringify(mod)});
        while (Date.now() < ${go}) {}
        const l = takeLock(${JSON.stringify(lock)}, 300);
        const got = "token" in l;
        if (got) { const t = Date.now() + 1_500; while (Date.now() < t) {} letGo(l); }
        console.log(JSON.stringify({ got }));`], { stdout: "pipe", stderr: "pipe" });
      const ps = [one(), one()];
      const outs = await Promise.all(ps.map(async (p) => { await p.exited; return JSON.parse((await new Response(p.stdout).text()).trim()); }));
      expect(outs.filter((o) => o.got).length).toBe(1);
      expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);      // the taken-over lock is cleared away
      expect(existsSync(lock)).toBe(false);                                            // and the winner let go of its own
    }
  }, 60_000);
  test("a slow live holder is never taken over: its heartbeat keeps the lock fresh past the stale threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate23-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    const holder = Bun.spawn(["bun", "-e", `const { takeLock, beat, letGo } = await import(${JSON.stringify(mod)});
      const l = takeLock(${JSON.stringify(lock)}, 1000);
      console.log("held");
      const t = Date.now() + 4_000;
      while (Date.now() < t) { beat(l); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
      letGo(l);
      console.log("done");`], { stdout: "pipe", stderr: "pipe" });
    while (!existsSync(lock)) await Bun.sleep(20);
    const t0 = Date.now();
    const got = takeLock(lock, 2_500, { staleMs: 1_000 });                         // a stale threshold far under the hold
    expect("miss" in got && got.miss).toBe("held");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_400);
    await holder.exited;
    expect((await new Response(holder.stdout).text()).trim().split("\n")).toEqual(["held", "done"]);
    // A watch kept at the same time as a slow live holder is never an acceptance.
    const h2 = takeLock(lock, 100) as any;
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h, waitMs: 300 })).toMatchObject({ accepted_head: null, passed: false, failure: "live_acceptance" });
    letGo(h2);
  }, 30_000);
  test("an unreadable lock counts as held: it fails by the deadline as lock_unavailable, with a notice, and is never taken over", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate23-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    mkdirSync(lock);                                                                // exists, can't be read as a lock
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    const errs: string[] = [];
    const was = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
    const t0 = Date.now();
    let kept: any;
    try { kept = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h, waitMs: 600 }); } finally { console.error = was; }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(kept).toMatchObject({ accepted_head: null, passed: false, failure: "lock_unavailable" });
    expect(kept.failure_why).toContain("ship-gate-pr-5.lock");
    expect(errs.join("\n")).toContain("couldn't be taken or kept");
    expect(statSync(lock).isDirectory()).toBe(true);                                // left as it was
    expect(acceptedFor(dir, 5)).toMatchObject({ unknown: expect.any(String) });       // twenty-seventh round: tagged, never an empty list
  });
  test("a holder that finds its lock no longer its own writes no acceptance and leaves the other's lock alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate23-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    const kept = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h, beforeWrite: () => { writeFileSync(lock, JSON.stringify({ pid: 1, token: "someone-else", at: "x" })); } });
    expect(kept).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("someone-else");
  });
});

describe("twenty-fourth review: the gate's acceptance write fenced, and the legacy lock taken over", () => {
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  const mod = join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts");
  test("a holder suspended past the stale bound at its write, a takeover, then the first holder resuming: exactly one acceptance commits, in two processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate24-"));
    const sig = join(dir, "suspended");
    const a = Bun.spawn(["bun", "-e", `const { keepWatch } = await import(${JSON.stringify(mod)});
      const { writeFileSync } = await import("node:fs");
      const k = keepWatch(${JSON.stringify(dir)}, ${JSON.stringify(line(SHA1))}, ${JSON.stringify(watchFile(dir, SHA1))},
        { headNow: (_p, h) => h, atWrite: () => { writeFileSync(${JSON.stringify(sig)}, "1"); const t = Date.now() + 2_000; while (Date.now() < t) {} } });
      console.log(JSON.stringify({ accepted: k.accepted_head, failure: k.failure }));`], { stdout: "pipe", stderr: "pipe" });
    const t0 = Date.now();
    while (!existsSync(sig) && Date.now() - t0 < 10_000) await Bun.sleep(10);
    const b = Bun.spawn(["bun", "-e", `const { keepWatch } = await import(${JSON.stringify(mod)});
      const k = keepWatch(${JSON.stringify(dir)}, ${JSON.stringify(line(SHA2))}, ${JSON.stringify(watchFile(dir, SHA2))}, { headNow: (_p, h) => h, staleMs: 400, waitMs: 3_000 });
      console.log(JSON.stringify({ accepted: k.accepted_head, failure: k.failure }));`], { stdout: "pipe", stderr: "pipe" });
    const read = async (p: any) => { await p.exited; return JSON.parse((await new Response(p.stdout).text()).trim()); };
    const [ra, rb] = [await read(a), await read(b)];
    expect(rb.accepted).toBe(SHA2);                                                 // the contender that took over commits
    expect(ra).toEqual({ accepted: null, failure: "lock_unavailable" });            // the resumed holder takes its write back
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);
    expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);
  }, 30_000);
  test("a second write for the same sha is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate24-"));
    const first = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h });
    const before = readFileSync(watchFile(dir, SHA1), "utf8");
    const again = keepWatch(dir, { ...line(SHA1), attempts_seen: ["other"] }, watchFile(dir, SHA1), { headNow: (_p, h) => h });
    expect(again.accepted_head).toBe(SHA1);
    expect(first.accepted_head).toBe(SHA1);
    expect(readFileSync(watchFile(dir, SHA1), "utf8")).toBe(before);
  });
  test("upgrading from the twenty-second round's empty lock file: an old one is taken over with a loud line; the notice names the path and the removal command", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate24-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    writeFileSync(lock, "");                                                        // the earlier round's lock: empty, no token
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    const errs: string[] = [];
    const was = console.error;
    console.error = (...x: unknown[]) => { errs.push(x.join(" ")); };
    let kept: any;
    try { kept = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h, waitMs: 600 }); } finally { console.error = was; }
    expect(kept.accepted_head).toBe(SHA1);
    expect(errs.join("\n")).toContain("took over a watch lock left by an earlier version of the watch, with no holder token");
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
  });
  test("a legacy lock that looks current, and one whose content fails to parse, are never taken over; the notice gives the exact removal command", () => {
    for (const [content, age] of [["", 0], ["{not json", 5 * 60_000]] as const) {
      const dir = mkdtempSync(join(tmpdir(), "ship-gate24-"));
      const lock = join(dir, "ship-gate-pr-5.lock");
      writeFileSync(lock, content);
      const t = new Date(Date.now() - age);
      utimesSync(lock, t, t);
      const was = console.error;
      console.error = () => {};
      let kept: any;
      try { kept = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => h, waitMs: 300 }); } finally { console.error = was; }
      expect(kept).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
      expect(kept.failure_why).toContain(`rm -f ${lock}`);
      expect(readFileSync(lock, "utf8")).toBe(content);
    }
  });
});

describe("twenty-fifth review: acceptances under the lock's generation, the sha-bound check before and after the write, and the head from GitHub", () => {
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  const mod = join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts");
  const echo = { headNow: (_p: number, h: string) => h };
  const quietly = <T>(f: () => T): T => { const was = console.error; console.error = () => {}; try { return f(); } finally { console.error = was; } };
  const out = async (p: any) => { await p.exited; return JSON.parse((await new Response(p.stdout).text()).trim()); };
  const consumer = (dir: string) => Bun.spawn(["bun", "-e", `const { acceptedFor } = await import(${JSON.stringify(mod)}); console.log(JSON.stringify(acceptedFor(${JSON.stringify(dir)}, 5)));`], { stdout: "pipe", stderr: "pipe" });
  const until = async (f: string) => { const t0 = Date.now(); while (!existsSync(f) && Date.now() - t0 < 15_000) await Bun.sleep(10); };

  test("a holder paused after its pre-write check, a taker that publishes, then the holder writing and pausing before its post-write check: the consumer reads exactly one valid acceptance, the taker's, in two processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate25-"));
    const [checked, wrote] = [join(dir, "checked"), join(dir, "wrote")];
    const a = Bun.spawn(["bun", "-e", `const { keepWatch } = await import(${JSON.stringify(mod)});
      const { writeFileSync } = await import("node:fs");
      const spin = (ms) => { const t = Date.now() + ms; while (Date.now() < t) {} };
      const k = keepWatch(${JSON.stringify(dir)}, ${JSON.stringify(line(SHA1))}, ${JSON.stringify(watchFile(dir, SHA1))}, { headNow: (_p, h) => h,
        atWrite: () => { writeFileSync(${JSON.stringify(checked)}, "1"); spin(2_000); },
        afterWrite: () => { writeFileSync(${JSON.stringify(wrote)}, "1"); spin(4_000); } });
      console.log(JSON.stringify({ accepted: k.accepted_head, failure: k.failure, why: k.failure_why }));`], { stdout: "pipe", stderr: "pipe" });
    await until(checked);
    const b = Bun.spawn(["bun", "-e", `const { keepWatch } = await import(${JSON.stringify(mod)});
      const k = keepWatch(${JSON.stringify(dir)}, ${JSON.stringify(line(SHA2))}, ${JSON.stringify(watchFile(dir, SHA2))}, { headNow: (_p, h) => h, staleMs: 400, waitMs: 3_000 });
      console.log(JSON.stringify({ accepted: k.accepted_head, failure: k.failure }));`], { stdout: "pipe", stderr: "pipe" });
    expect(await out(b)).toEqual({ accepted: SHA2, failure: null });                // the taker published
    expect(readGen(dir, 5)).toBe(2);                                                // its takeover moved the generation on (files start at 1)
    await until(wrote);                                                             // the holder has written, and is paused
    expect(JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8"))).toMatchObject({ accepted_head: SHA1, gen: 1 });   // its write is there
    expect(await out(consumer(dir))).toEqual([SHA2]);                              // but only the taker's counts, at once
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);
    const ra = await out(a);
    expect(ra).toMatchObject({ accepted: null, failure: "lock_unavailable" });
    expect(ra.why).toContain("no acceptance stands for this head, and the watch must be run again for it");
    expect(await out(consumer(dir))).toEqual([SHA2]);
  }, 40_000);

  test("a record written under an earlier generation, or with a generation file that can't be read, is no acceptance", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate25-"));
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    expect(JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8")).gen).toBe(1);
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
    writeFileSync(genFile(dir, 5), "2\n");                                          // a takeover moved it on
    expect(acceptedFor(dir, 5)).toEqual([]);
    writeFileSync(genFile(dir, 5), "garbage");
    expect(acceptedFor(dir, 5)).toMatchObject({ unknown: expect.any(String) });       // twenty-seventh round: tagged, never an empty list
    writeFileSync(genFile(dir, 5), "2\n");
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);   // a stale record of the sha: watched again, it counts
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
  });

  test("re-watching a superseded sha while the newer head has no live acceptance is refused, in two processes, and the record stays superseded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate25-"));
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    expect(await supersede(dir, SHA1, async () => SHA2)).toEqual({ ok: true, pr: 5 });
    const go = Date.now() + 1_500;
    const one = () => Bun.spawn(["bun", "-e", `const { keepWatch } = await import(${JSON.stringify(mod)});
      while (Date.now() < ${go}) {}
      const k = keepWatch(${JSON.stringify(dir)}, ${JSON.stringify(line(SHA1))}, ${JSON.stringify(watchFile(dir, SHA1))}, { headNow: (_p, h) => h, waitMs: 3_000 });
      console.log(JSON.stringify({ accepted: k.accepted_head, failure: k.failure }));`], { stdout: "pipe", stderr: "pipe" });
    const rs = await Promise.all([one(), one()].map(out));
    for (const r of rs) expect(r).toEqual({ accepted: null, failure: "superseded" });
    expect(acceptedFor(dir, 5)).toEqual([]);
    expect(JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8")).superseded.at).toBeString();
    // And when the lock is held by another watch, the failure isn't written over the superseded record either.
    writeFileSync(join(dir, "ship-gate-pr-5.lock"), JSON.stringify({ pid: 1, token: "other", gen: 0, at: "x" }));
    expect(quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { ...echo, waitMs: 200 })).failure).toBe("live_acceptance");
    expect(JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8")).superseded.at).toBeString();
  }, 30_000);

  test("an acceptance of a newer head, then a delayed watch of the older head: refused; and an older head is refused against GitHub's head even with no acceptance standing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate25-"));
    const github = { headNow: (_p: number, _h: string) => SHA2 };
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), github).accepted_head).toBe(SHA2);
    const late = quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), github));
    expect(late.accepted_head).toBeNull();
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);
    const dir2 = mkdtempSync(join(tmpdir(), "ship-gate25-"));
    const older = quietly(() => keepWatch(dir2, line(SHA1), watchFile(dir2, SHA1), github));
    expect(older).toMatchObject({ accepted_head: null, failure: "head_not_current" });
    expect(older.failure_why).toContain(`is now ${SHA2}, not ${SHA1}`);
    expect(acceptedFor(dir2, 5)).toEqual([]);
    expect(quietly(() => keepWatch(dir2, line(SHA1), watchFile(dir2, SHA1), { headNow: () => null }))).toMatchObject({ accepted_head: null, failure: "head_not_current" });
    // The head moving between the write and the post-write check takes the acceptance back.
    let n = 0;
    const moving = { headNow: (_p: number, h: string) => (n++ === 0 ? h : SHA2) };
    expect(quietly(() => keepWatch(dir2, line(SHA1), watchFile(dir2, SHA1), moving))).toMatchObject({ accepted_head: null, failure: "head_not_current" });
    expect(acceptedFor(dir2, 5)).toEqual([]);
  });

  test("the Ship card consumes an acceptance only against GitHub's head as it is now: an unreadable head refuses it", async () => {
    const r = shipRig();
    r.github.watched[PR] = SHA1;
    expect(r.msg(await ship(r)).content).toContain(LINE);
    const r2 = shipRig({ facts: null });
    r2.github.watched[PR] = SHA1;
    await expect(ship(r2)).rejects.toThrow("the pull request's head couldn't be read from GitHub, so the Ship gate's watch acceptance can't be checked against it");
    const r3 = shipRig({ facts: null });                                            // no acceptance: as before
    expect(r3.msg(await ship(r3)).content).toContain(LINE);
  });

  test("a token-less JSON lock older than the stale bound is taken over with the warning, in words and with no ISO time; a current one is left with the exact removal command", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate25-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    writeFileSync(lock, JSON.stringify({ pid: 4242, at: "2026-11-01T00:00:00Z" }));
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    const errs: string[] = [];
    const was = console.error;
    console.error = (...x: unknown[]) => { errs.push(x.join(" ")); };
    let kept: any;
    try { kept = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { ...echo, waitMs: 600 }); } finally { console.error = was; }
    expect(kept.accepted_head).toBe(SHA1);
    const warn = errs.find((e) => e.includes("WARNING"))!;
    expect(warn).toContain("took over a watch lock left by an earlier version of the watch, with no holder token");
    expect(warn).toContain("last changed about 5 minutes ago");
    expect(warn).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(readGen(dir, 5)).toBe(1);
    expect(agoWords(90 * 60_000)).toBe("about 2 hours ago");
    const dir2 = mkdtempSync(join(tmpdir(), "ship-gate25-"));
    const lock2 = join(dir2, "ship-gate-pr-5.lock");
    writeFileSync(lock2, JSON.stringify({ pid: 4242, at: "x" }));                   // current (just made)
    const kept2 = quietly(() => keepWatch(dir2, line(SHA1), watchFile(dir2, SHA1), { ...echo, waitMs: 300 }));
    expect(kept2).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(kept2.failure_why).toContain(`remove the lock with: rm -f ${lock2}`);
    expect(JSON.parse(readFileSync(lock2, "utf8"))).toEqual({ pid: 4242, at: "x" });
  });
});

describe("twenty-sixth review: the generation never resets, the card refuses an unknown gate state, and the head read through the real request wrapper", () => {
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  const echo = { headNow: (_p: number, h: string) => h };
  const quietly = <T>(f: () => T): T => { const was = console.error; console.error = () => {}; try { return f(); } finally { console.error = was; } };
  const record = (dir: string, head: string, gen?: number, pr = 5) =>
    writeFileSync(watchFile(dir, head), JSON.stringify({ step: "ship_gate", pr, bound_head: head, accepted_head: head, failure: null, ...(gen === undefined ? {} : { gen, format: GATE_RECORD_FORMAT }) }) + "\n");
  const cardGate = (dir: string) => () => { const st = gateState(dir, 5); return "heads" in st ? st.heads : st; };

  test("a generation file deleted after a takeover, with the taken-over holder's late write never retracted: nothing counts, the watch fails closed, and the recovery rewrites it above every recorded generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate26-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    // The first holder takes the lock: the generation file starts at 1.
    const first = takeLock(lock, 100) as any;
    expect(first.gen).toBe(1);
    expect(readGen(dir, 5)).toBe(1);
    // It stalls past the stale bound; a second watch takes over (generation 2) and keeps its acceptance.
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    expect(quietly(() => keepWatch(dir, line(SHA2), watchFile(dir, SHA2), { ...echo, waitMs: 600 })).accepted_head).toBe(SHA2);
    expect(readGen(dir, 5)).toBe(2);
    // The first holder writes late, under its generation, and dies before its post-check: never retracted.
    record(dir, SHA1, 1);
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);
    // The generation file is deleted (the earlier round's documented recovery): nothing counts, and the state is unknown.
    rmSync(genFile(dir, 5));
    expect(readGen(dir, 5)).toBeNull();
    expect(acceptedFor(dir, 5)).toMatchObject({ unknown: expect.any(String) });       // twenty-seventh round: tagged, never an empty list
    expect(gateState(dir, 5)).toMatchObject({ unknown: expect.stringContaining("--recover-generation 5") });
    expect(watchAccepted(readFileSync(watchFile(dir, SHA1), "utf8"), readGen(dir, 5))).toBeNull();
    // A new watch fails closed rather than starting again at 1 (which would bring the late write back).
    const k = quietly(() => keepWatch(dir, line("7".repeat(40)), watchFile(dir, "7".repeat(40)), { ...echo, waitMs: 300 }));
    expect(k).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(k.failure_why).toContain("--recover-generation 5");
    expect(existsSync(genFile(dir, 5))).toBe(false);
    // The recovery: refused while a lock looks current; then above every recorded generation, and nothing kept before counts.
    writeFileSync(lock, JSON.stringify({ pid: 1, token: "live", gen: 2, at: "x" }));
    expect(recoverGen(dir, 5)).toMatchObject({ ok: false, why: expect.stringContaining("looks to be running") });
    rmSync(lock);
    expect(recoverGen(dir, 5)).toEqual({ ok: true, gen: 3 });
    expect(readFileSync(genFile(dir, 5), "utf8")).toBe("3\n");
    expect(acceptedFor(dir, 5)).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
    // Watched again, the pull request's head counts under the new generation.
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), echo).accepted_head).toBe(SHA2);
    expect(JSON.parse(readFileSync(watchFile(dir, SHA2), "utf8")).gen).toBe(3);
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);
    // An unreadable generation file is recovered the same way.
    writeFileSync(genFile(dir, 5), "garbage");
    expect(gateState(dir, 5)).toMatchObject({ unknown: expect.any(String) });
    expect(recoverGen(dir, 5)).toEqual({ ok: true, gen: 4 });
  });

  test("a legacy record (no generation, or generation 0) counts for nothing, doesn't block the first watch, and the new file starts at 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate26-"));
    record(dir, SHA2);                                                              // from before the generation
    record(dir, "8".repeat(40), 0);                                                 // the twenty-fifth round's generation 0
    expect(watchAccepted(readFileSync(watchFile(dir, SHA2), "utf8"))).toBeNull();
    expect(acceptedFor(dir, 5)).toEqual([]);
    expect(gateState(dir, 5)).toEqual({ heads: [] });
    expect(otherLive(dir, 5, SHA1)).toEqual([]);
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    expect(readGen(dir, 5)).toBe(1);
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
    // A Ship card for this head goes; the legacy acceptance of another head doesn't refuse it.
  });

  test("the Ship card refuses by name when the gate state is unknown: a garbled generation file while another sha's acceptance exists, or a record that doesn't parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate26-"));
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), echo).accepted_head).toBe(SHA2);
    const r = rig({ facts: true, gateWatch: cardGate(dir) });
    r.github.facts = facts();
    r.reviews.list = [REVIEW];
    await expect(ship(r)).rejects.toThrow(`accepted ${SHA2}, not this head`);
    writeFileSync(genFile(dir, 5), "not a number");
    await expect(ship(r)).rejects.toThrow("the Ship gate's state is unknown for this pull request");
    writeFileSync(genFile(dir, 5), "1\n");
    await expect(ship(r)).rejects.toThrow(`accepted ${SHA2}, not this head`);
    writeFileSync(join(dir, `ship-gate-${"9".repeat(40)}.json`), "{garbled");
    await expect(ship(r)).rejects.toThrow("the Ship gate's state is unknown for this pull request");
    // And a watch accepts nothing while the state can't be read.
    expect(await supersede(dir, SHA2, async () => SHA1)).toEqual({ ok: true, pr: 5 });
    expect(quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo))).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
  });

  test("the head read through the real request wrapper against a local server: a head, a 403 rate limit, a 5xx, malformed JSON, a retried 429, and the token sent", async () => {
    const server = Bun.spawn(["bun", "-e", `
      let n429 = 0;
      const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
        const pr = Number(new URL(req.url).pathname.split("/").pop());
        const j = (b, status = 200, headers = {}) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
        if (pr === 1) return j({ head: { sha: "${SHA1.toUpperCase()}" } });
        if (pr === 2) return j({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1800) });
        if (pr === 3) return j({ message: "oops" }, 502);
        if (pr === 4) return j("<html>not json", 200);
        if (pr === 5) return n429++ === 0 ? j({ message: "slow down" }, 429, { "retry-after": "0" }) : j({ head: { sha: "${SHA2}" } });
        if (pr === 6) return j({ message: "Resource not accessible" }, 403);
        if (pr === 7) return req.headers.get("authorization") === "Bearer ghp_testtoken_000000000000000000" ? j({ head: { sha: "${SHA1}" } }) : j({ message: "Bad credentials" }, 401);
        return j({}, 404);
      } });
      console.log(s.port);`], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = server.stdout.getReader();
      const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
      const base = `http://127.0.0.1:${port}`;
      expect(ghHeadRead("o/r", 1, { base })).toBe(SHA1);
      const limited = ghHeadRead("o/r", 2, { base });
      expect(limited).toMatchObject({ miss: "rate_limit" });
      expect((limited as any).wait_ms).toBeGreaterThan(20 * 60_000);
      expect(ghHeadRead("o/r", 3, { base })).toEqual({ miss: "unreadable", why: "GitHub answered with a server error (502)" });
      expect(ghHeadRead("o/r", 4, { base })).toEqual({ miss: "unreadable", why: "GitHub's answer wasn't JSON" });
      expect(ghHeadRead("o/r", 5, { base })).toBe(SHA2);                             // one bounded retry, as Retry-After asked
      expect(ghHeadRead("o/r", 6, { base })).toEqual({ miss: "unreadable", why: "GitHub refused the read (403)" });
      expect(ghHeadRead("o/r", 7, { base })).toMatchObject({ miss: "unreadable" });
      expect(ghHeadRead("o/r", 7, { base, token: "ghp_testtoken_000000000000000000" })).toBe(SHA1);
      expect(githubToken({ SHIP_GATE_GITHUB_TOKEN: "ghp_testtoken_000000000000000000" })).toBe("ghp_testtoken_000000000000000000");
      expect(githubToken({ SHIP_GATE_GITHUB_TOKEN: "bad token; rm -rf" })).toBeUndefined();
      // The watch words a rate limit apart from a moved head, through the same wrapper.
      const dir = mkdtempSync(join(tmpdir(), "ship-gate26-"));
      const k = quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: () => ghHeadRead("o/r", 2, { base }) }));
      expect(k).toMatchObject({ accepted_head: null, failure: "head_not_current" });
      expect(k.failure_why).toContain("GitHub's rate limit stopped the read of the pull request's head");
      expect(k.failure_why).toContain("isn't known to have moved");
      expect(k.failure_why).not.toContain("is now");
      const k2 = quietly(() => keepWatch(dir, line(SHA2), watchFile(dir, SHA2), { headNow: () => ghHeadRead("o/r", 1, { base }) }));
      expect(k2.failure_why).toContain(`is now ${SHA1}, not ${SHA2}`);
    } finally { server.kill(); }
  }, 30_000);
});

describe("twenty-seventh review: one deadline for the critical section, the record format, recovery under the lock, scoped unreadable records, one request wrapper, and no lossy gate helper", () => {
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  const echo = { headNow: (_p: number, h: string) => h };
  const quietly = <T>(f: () => T): T => { const was = console.error; console.error = () => {}; try { return f(); } finally { console.error = was; } };
  const pauseMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // A local GitHub stand-in that answers every read of pull request 8 with a 429 asking to wait a second.
  const limiter = () => Bun.spawn(["bun", "-e", `
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      const pr = Number(new URL(req.url).pathname.split("/").pop());
      if (pr === 8) return new Response(JSON.stringify({ message: "slow down" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
      return new Response(JSON.stringify({ head: { sha: "${SHA1}" } }), { headers: { "content-type": "application/json" } });
    } });
    console.log(s.port);`], { stdout: "pipe", stderr: "pipe" });
  const portOf = async (p: ReturnType<typeof limiter>) => Number(new TextDecoder().decode((await p.stdout.getReader().read()).value).trim());

  test("the worst case under the lock is at most a quarter of the stale bound", () => {
    expect((CRITICAL_MAX_MS + CRITICAL_SLACK_MS) * 4).toBeLessThanOrEqual(LOCK_STALE_MS);
  });

  test("two rate-limited retries during the head read run the section past its deadline: nothing is accepted, named lock_unavailable, and the lock is held no longer than the bound", async () => {
    const server = limiter();
    try {
      const base = `http://127.0.0.1:${await portOf(server)}`;
      const dir = mkdtempSync(join(tmpdir(), "ship-gate27-"));
      let reads = 0;
      const t0 = Date.now();
      const k = quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { criticalMs: 1_800,
        headNow: (_n, _h, deadline) => { reads++; return ghHeadRead("o/r", 8, { base, deadline }); } }));
      expect(k).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
      expect(k.failure_why).toContain("ran past its 2 second bound before its acceptance was written");
      expect(Date.now() - t0).toBeLessThan(1_800 + CRITICAL_SLACK_MS + 1_000);
      expect(reads).toBe(1);
      expect(acceptedFor(dir, 5)).toEqual([]);
      expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);
    } finally { server.kill(); }
  }, 30_000);

  test("the time running out during the second head read (after the write) takes the acceptance back", async () => {
    const server = limiter();
    try {
      const base = `http://127.0.0.1:${await portOf(server)}`;
      const dir = mkdtempSync(join(tmpdir(), "ship-gate27-"));
      let n = 0;
      const k = quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { criticalMs: 1_800,
        headNow: (_p, h, deadline) => (++n === 1 ? h : ghHeadRead("o/r", 8, { base, deadline })), afterWrite: () => pauseMs(1_000) }));
      expect(n).toBe(2);
      expect(k).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
      expect(k.failure_why).toContain("just after its acceptance was written: it is taken back");
      expect(acceptedFor(dir, 5)).toEqual([]);
      expect(JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8"))).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
      // A head read that answers but leaves the section past its bound takes it back too.
      const dir2 = mkdtempSync(join(tmpdir(), "ship-gate27-"));
      let m = 0;
      const k2 = quietly(() => keepWatch(dir2, line(SHA1), watchFile(dir2, SHA1), { criticalMs: 600,
        headNow: (_p, h) => { if (++m === 2) pauseMs(800); return h; } }));
      expect(k2).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
      expect(acceptedFor(dir2, 5)).toEqual([]);
    } finally { server.kill(); }
  }, 30_000);

  test("a record from before this round at generation 1, beside a generation file holding 1, counts for nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate27-"));
    writeFileSync(genFile(dir, 5), "1\n");
    const pre = JSON.stringify({ step: "ship_gate", pr: 5, bound_head: SHA1, accepted_head: SHA1, failure: null, gen: 1, gen_floor: 1 }) + "\n";
    writeFileSync(watchFile(dir, SHA1), pre);
    expect(watchAccepted(pre, 1)).toBeNull();
    expect(acceptedFor(dir, 5)).toEqual([]);
    expect(gateState(dir, 5)).toEqual({ heads: [] });
    expect(otherLive(dir, 5, SHA2)).toEqual([]);
    // It doesn't stand in the way of a new acceptance, and the new one carries the format.
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), echo).accepted_head).toBe(SHA2);
    expect(JSON.parse(readFileSync(watchFile(dir, SHA2), "utf8"))).toMatchObject({ format: GATE_RECORD_FORMAT, gen: 1 });
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);
    // With no generation file, a record from before this round doesn't make it fail closed, but still raises the floor.
    const dir2 = mkdtempSync(join(tmpdir(), "ship-gate27-"));
    writeFileSync(watchFile(dir2, SHA1), JSON.stringify({ step: "ship_gate", pr: 5, accepted_head: SHA1, gen: 4 }) + "\n");
    expect(genRecorded(dir2, 5)).toEqual({ any: false, max: 4 });
    expect(readGen(dir2, 5)).toBe(0);
  });

  test("the generation recovery holds the gate lock while it writes, takes a stale lock over counting its generation, and fails if anything ends above what it wrote", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate27-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    writeFileSync(watchFile(dir, SHA1), JSON.stringify({ step: "ship_gate", pr: 5, accepted_head: SHA1, gen: 2, format: GATE_RECORD_FORMAT }) + "\n");
    writeFileSync(lock, JSON.stringify({ pid: 1, token: "stalled", gen: 3, at: "x" }));
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    let during: any = null;
    const r = quietly(() => recoverGen(dir, 5, { afterWrite: () => { during = takeLock(lock, 0); } }));
    expect(during).toEqual({ miss: "held" });                                         // a watch can't take the lock meanwhile
    expect(r).toEqual({ ok: true, gen: 4 });                                          // above the stale lock's 3
    expect(readGen(dir, 5)).toBe(4);
    expect(existsSync(lock)).toBe(false);                                             // let go
    // Something ending above what it wrote fails the recovery, naming it, and lets go.
    const r2 = quietly(() => recoverGen(dir, 5, { afterWrite: () => writeFileSync(watchFile(dir, SHA2), JSON.stringify({ step: "ship_gate", pr: 5, accepted_head: SHA2, gen: 9, format: GATE_RECORD_FORMAT }) + "\n") }));
    expect(r2).toMatchObject({ ok: false, why: expect.stringContaining("something moved the pull request's watch generation") });
    expect(existsSync(lock)).toBe(false);
    expect(recoverGen(dir, 5)).toEqual({ ok: true, gen: 10 });
  });

  test("a race: the recovery and two watches taking over the same stale lock at once leave the generation file at or above every generation a lock was made under", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate27-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    writeFileSync(genFile(dir, 5), "1\n");
    writeFileSync(lock, JSON.stringify({ pid: 1, token: "stalled", gen: 1, at: "x" }));
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    const mod = join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts");
    const watcher = Bun.spawn(["bun", "-e", `const { takeLock, letGo } = await import(${JSON.stringify(mod)});
      const l = takeLock(${JSON.stringify(lock)}, 8000, { staleMs: 1000 }); if ("token" in l) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); letGo(l); } console.log(JSON.stringify(l.gen ?? null));`], { stdout: "pipe", stderr: "ignore" });
    const watcher2 = Bun.spawn(["bun", "-e", `const { takeLock, letGo } = await import(${JSON.stringify(mod)});
      const l = takeLock(${JSON.stringify(lock)}, 8000, { staleMs: 1000 }); if ("token" in l) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); letGo(l); } console.log(JSON.stringify(l.gen ?? null));`], { stdout: "pipe", stderr: "ignore" });
    const recovery = Bun.spawn(["bun", "-e", `const { recoverGen } = await import(${JSON.stringify(mod)}); console.log(JSON.stringify(recoverGen(${JSON.stringify(dir)}, 5, { staleMs: 1000, waitMs: 8000 })));`], { stdout: "pipe", stderr: "ignore" });
    const [a, b, c] = await Promise.all([watcher, watcher2, recovery].map(async (p) => JSON.parse((await new Response(p.stdout).text()).trim())));
    const gens = [a, b].filter((g) => typeof g === "number") as number[];
    expect(gens.length).toBe(2);
    const file = readGen(dir, 5)!;
    for (const g of gens) expect(file).toBeGreaterThanOrEqual(g);
    if (c.ok) expect(file).toBeGreaterThanOrEqual(c.gen);
    else expect(c.why).toMatch(/looks to be running|something moved/);
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  test("a garbled record of another pull request doesn't block a first watch; one that can't be told apart is named, set aside by quarantine, and recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate27-"));
    const other = "7".repeat(40), nobody = "6".repeat(40);
    writeFileSync(watchFile(dir, other), `{"step": "ship_gate", "pr": 7, "gen": 12, "accepted_head": "${other}`);  // torn
    expect(genRecorded(dir, 5)).toEqual({ any: false, max: 0 });
    expect(gateState(dir, 5)).toEqual({ heads: [] });
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
    // Pull request 7's own state names its record and the quarantine.
    expect(gateState(dir, 7)).toMatchObject({ unknown: expect.stringContaining(`--quarantine ${other}`) });
    // A garbled record that names no pull request blocks pull request 9's first watch, by name.
    writeFileSync(watchFile(dir, nobody), "{garbled");
    const k = quietly(() => keepWatch(dir, line(SHA2, 9), watchFile(dir, SHA2), echo));
    expect(k).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(k.failure_why).toContain(watchFile(dir, nobody));
    expect(k.failure_why).toContain(`--quarantine ${nobody}`);
    // A record that reads is never set aside; the garbled one is, recorded, and the watch goes.
    expect(quarantineRecord(dir, SHA1)).toMatchObject({ ok: false, why: expect.stringContaining("reads and parses") });
    // Twenty-eighth round: a record that names no pull request is set aside under the lock of the one named with --pr.
    expect(quarantineRecord(dir, nobody)).toMatchObject({ ok: false, why: expect.stringContaining("--pr <number>") });
    expect(k.failure_why).toContain(`--quarantine ${nobody} --pr 9`);
    const q = quarantineRecord(dir, nobody, { pr: 9 });
    expect(q.ok).toBe(true);
    expect(existsSync(watchFile(dir, nobody))).toBe(false);
    expect(JSON.parse(readFileSync(quarantineLog(dir), "utf8").trim())).toMatchObject({ file: watchFile(dir, nobody), pr: 9, gen_max: null });
    expect(keepWatch(dir, line(SHA2, 9), watchFile(dir, SHA2), echo).accepted_head).toBe(SHA2);
    // A quarantined record's generation still raises a later recovery.
    expect(quarantineRecord(dir, other).ok).toBe(true);
    expect(quietly(() => recoverGen(dir, 7))).toEqual({ ok: true, gen: 13 });
  });

  test("the supersede's head read goes through the one wrapper: a rate limit leaves the supersede owed on the record, never a silent no-op; no plain fetch is left in the gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate27-"));
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), echo).accepted_head).toBe(SHA2);
    const owed = await supersede(dir, SHA2, async () => ({ miss: "rate_limit" as const, wait_ms: 125_000 }));
    const owedWhy = String((owed as any).why);
    expect(owed).toMatchObject({ ok: false, owed: true });
    expect(owedWhy).toContain("the supersede is owed");
    expect(owedWhy).toContain("about 3 minutes");
    expect(JSON.parse(readFileSync(watchFile(dir, SHA2), "utf8")).supersede_owed).toEqual({ reason: "rate_limit", wait_minutes: 3 });
    expect(acceptedFor(dir, 5)).toEqual([SHA2]);                                      // still the live acceptance: the card stays refused for other heads
    const failed = await supersede(dir, SHA2, async () => ({ miss: "unreadable" as const, why: "GitHub answered with a server error (502)" }));
    expect(failed).toMatchObject({ ok: false, why: expect.stringContaining("server error (502)") });
    expect((failed as any).owed).toBeUndefined();
    expect(await supersede(dir, SHA2, async () => SHA1)).toEqual({ ok: true, pr: 5 });
    const x = JSON.parse(readFileSync(watchFile(dir, SHA2), "utf8"));
    expect(x.supersede_owed).toBeUndefined();
    expect(x.superseded).toBeTruthy();
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).toContain("ghHeadRead(flag(\"--repo\") ?? SHIP_REPO");
  });

  test("no lossy mapping: the helper tags an unknown gate state, and the card path reads the gate state, never the helper", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate27-"));
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), echo).accepted_head).toBe(SHA2);
    writeFileSync(genFile(dir, 5), "garbled");
    expect(acceptedFor(dir, 5)).toMatchObject({ unknown: expect.stringContaining("--recover-generation 5") });
    expect(otherLive(dir, 5, SHA1)).toMatchObject({ unknown: expect.any(String) });
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    const core = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/core.ts"), "utf8");
    expect(main).toMatch(/gateWatch: \(pr\) => \{[^\n]*gateState\(WATCH_DIR/);
    expect(main).not.toMatch(/acceptedFor|otherLive/);
    expect(core).not.toMatch(/acceptedFor|otherLive|from "\.\/shipgate"/);
  });
});

describe("twenty-eighth review: the quarantine under the gate lock, curl's limits enforced from this side, an owed supersede on the card, lock files set aside, the bound said as it is, and the unauthenticated quota", () => {
  const g = gate28 as any;
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  const echo = { headNow: (_p: number, h: string) => h };
  const quietly = <T>(f: () => T): T => { const was = console.error; console.error = () => {}; try { return f(); } finally { console.error = was; } };
  const pauseMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const garbled = (pr: number, gen: number) => `{"step": "ship_gate", "pr": ${pr}, "gen": ${gen}, "accepted_head": "torn`;
  const valid = (head: string, pr = 5, gen = 1) => JSON.stringify({ step: "ship_gate", pr, bound_head: head, accepted_head: head, failure: null, gen, gen_floor: gen, format: GATE_RECORD_FORMAT }) + "\n";
  const logLines = (dir: string) => { try { return readFileSync(quarantineLog(dir), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // A curl that ignores its time limit (and says it is 7.29 when asked), counting its calls.
  // Twenty-ninth round: the wrapper checks curl's version before any read, so the stub that is to be killed says 8.5.0.
  const slowCurl = (version = "7.29.0") => {
    const d = mkdtempSync(join(tmpdir(), "slow-curl-"));
    writeFileSync(join(d, "curl"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "curl ${version} (x86_64-pc-linux-gnu)"; exit 0; fi\necho x >> ${JSON.stringify(join(d, "calls"))}\nexec sleep 30\n`, { mode: 0o755 });
    return { dir: d, bin: join(d, "curl"), calls: () => { try { return readFileSync(join(d, "calls"), "utf8").trim().split("\n").length; } catch { return 0; } } };
  };

  test("the quarantine takes the gate lock: a current lock refuses it, and a record a watch rewrote between the check and the rename is put back, never set aside", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    const f = watchFile(dir, SHA1);
    writeFileSync(f, garbled(5, 3));
    // A watch holding the lock: the quarantine refuses, and changes nothing.
    writeFileSync(genFile(dir, 5), "3\n");
    const held = takeLock(join(dir, "ship-gate-pr-5.lock"), 0);
    expect("token" in held).toBe(true);
    expect(g.quarantineRecord(dir, SHA1)).toMatchObject({ ok: false, why: expect.stringContaining("looks to be running") });
    expect(readFileSync(f, "utf8")).toBe(garbled(5, 3));
    letGo(held as any);
    // A watch writes a valid acceptance just before the rename: what was moved parses, so it is put back.
    let called = false;
    const r = g.quarantineRecord(dir, SHA1, { beforeRename: () => { called = true; writeFileSync(f, valid(SHA1, 5, 3)); } });
    expect(called).toBe(true);
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining("put back") });
    expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({ accepted_head: SHA1, gen: 3 });
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
    expect(logLines(dir)).toEqual([]);
    expect(readdirSync(dir).some((n) => n.includes(".quarantined-"))).toBe(false);
    // The generation logged is that of the contents actually moved, not the ones first read.
    writeFileSync(f, garbled(5, 3));
    const r2 = g.quarantineRecord(dir, SHA1, { beforeRename: () => writeFileSync(f, garbled(5, 7)) });
    expect(r2.ok).toBe(true);
    expect(logLines(dir)).toEqual([expect.objectContaining({ file: f, pr: 5, gen_max: 7 })]);
    expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);                 // let go
  });

  test("a rename that fails leaves no log entry and the record where it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    const f = watchFile(dir, SHA1);
    writeFileSync(f, garbled(5, 2));
    const r = g.quarantineRecord(dir, SHA1, { rename: () => { throw new Error("EBUSY"); } });
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining("couldn't be set aside") });
    expect(logLines(dir)).toEqual([]);
    expect(readFileSync(f, "utf8")).toBe(garbled(5, 2));
    expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);
  });

  test("a curl that ignores its time limit is killed from this side at the deadline plus a small margin; a try under one second is skipped, never handed to curl", () => {
    const c = slowCurl("8.5.0");
    const t0 = Date.now();
    const r = g.ghGet("/repos/o/r/pulls/8", { base: "http://127.0.0.1:9", curl: c.bin, deadline: t0 + 2_000 });
    const took = Date.now() - t0;
    expect(r).toEqual({ miss: "deadline" });
    expect(c.calls()).toBe(1);
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(2_000 + g.CURL_KILL_MARGIN_MS + 600);
    // Under a second left: skipped as the deadline, curl never started.
    expect(g.ghGet("/repos/o/r/pulls/8", { base: "http://127.0.0.1:9", curl: c.bin, deadline: Date.now() + 900 })).toEqual({ miss: "deadline" });
    expect(c.calls()).toBe(1);
    // The head read under the lock with that curl: nothing accepted, named as the bound, the lock let go in time.
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    const t1 = Date.now();
    const k = quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { criticalMs: 2_500,
      headNow: (n, _h, deadline) => g.ghHeadRead("o/r", n, { base: "http://127.0.0.1:9", curl: c.bin, deadline }) }));
    expect(k).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(Date.now() - t1).toBeLessThan(2_500 + g.CURL_KILL_MARGIN_MS + 1_000);
    expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);
  }, 20_000);

  test("curl older than 7.32 refuses the watch at its start, by name", async () => {
    const c = slowCurl();
    expect(g.curlVersion(c.bin)).toEqual([7, 29, 0]);
    expect(g.curlVersionOk([7, 29, 0])).toBe(false);
    expect(g.curlVersionOk([7, 32, 0])).toBe(true);
    expect(g.curlVersionOk([8, 5, 0])).toBe(true);
    expect(g.curlRefusal(null)).toContain("curl isn't installed");
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    const p = Bun.spawn(["bun", join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts"), "--pr", "5", "--head", SHA1, "--watch", "--dir", dir],
      { env: { ...process.env, PATH: `${c.dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => p.kill(), 15_000);
    const err = await new Response(p.stderr).text();
    clearTimeout(killer);
    expect(await p.exited).toBe(1);
    expect(err).toContain("curl 7.29.0 is older than 7.32");
    expect(c.calls()).toBe(0);
  }, 20_000);

  test("the Ship card treats an acceptance with an owed supersede as not current, naming the owed supersede and its wait", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), echo).accepted_head).toBe(SHA2);
    const owed = await supersede(dir, SHA2, async () => ({ miss: "rate_limit" as const, wait_ms: 125_000 }));
    expect(owed).toMatchObject({ ok: false, owed: true });
    const st = gateState(dir, 5) as any;
    expect(st.owed).toContain(`--supersede ${SHA2}`);
    expect(st.owed).toContain("about 3 minutes");
    const cardGate = () => { const x = gateState(dir, 5) as any; return "heads" in x ? (x.owed ? { owed: x.owed } : x.heads) : x; };
    const r = rig({ facts: true, gateWatch: cardGate });
    r.github.facts = facts();
    r.reviews.list = [REVIEW];
    await expect(ship(r)).rejects.toThrow("waiting on a supersede");
    await expect(ship(r)).rejects.toThrow("about 3 minutes");
    // The link's own reader maps it the same way.
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main).toMatch(/gateWatch: \(pr\) => \{[^\n]*st\.owed \? \{ owed: st\.owed \}/);
    // Once it goes through, the card reads the gate as usual.
    expect(await supersede(dir, SHA2, async () => SHA1)).toEqual({ ok: true, pr: 5 });
    expect(gateState(dir, 5)).toEqual({ heads: [] });
  });

  test("a lock file that doesn't parse, and a takeover's leftover that doesn't, are named with their quarantine and set aside under the lock, their generations counted", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    writeFileSync(genFile(dir, 5), "6\n");
    writeFileSync(lock, `{"pid": 1, "token": "x", "gen": 4`);
    writeFileSync(`${lock}.stale-abc`, `{"pid": 2, "gen": 9, "tok`);
    expect(genRecorded(dir, 5).blocker).toContain("--quarantine-lock 5");
    const k = quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { ...echo, waitMs: 200 }));
    expect(k).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(k.failure_why).toContain("--quarantine-lock 5");
    const q = g.quarantineLock(dir, 5);
    expect(q.ok).toBe(true);
    expect(q.moved.length).toBe(2);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.stale-abc`)).toBe(false);
    expect(logLines(dir).map((l) => l.gen_max).sort()).toEqual([4, 9]);
    expect(genRecorded(dir, 5).blocker).toBeUndefined();
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    expect(quietly(() => recoverGen(dir, 5))).toEqual({ ok: true, gen: 10 });           // above the leftover's 9
    // Nothing that doesn't parse: nothing changed.
    expect(g.quarantineLock(dir, 5)).toMatchObject({ ok: false, why: expect.stringContaining("fails to parse") });
  });

  test("the deadline is checked before each record is parsed: past it the gate's reading stops as late, never as a reading", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    expect(gateState(dir, 5, Date.now() - 1)).toMatchObject({ unknown: expect.stringContaining("ran out"), late: true });
    expect(gateState(dir, 5, Date.now() + 60_000)).toEqual({ heads: [SHA1] });
  });

  test("a holder stalled past the stale threshold is taken over, and the takeover fences its later write and its take-back", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    const lock = join(dir, "ship-gate-pr-5.lock");
    let taker: any = null;
    const a = quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { ...echo, staleMs: 300, criticalMs: 8_000,
      atWrite: () => { pauseMs(500); taker = takeLock(lock, 2_000, { staleMs: 300 }); } }));
    expect("token" in taker).toBe(true);
    expect(taker.gen).toBe(2);                                                      // the takeover moved the generation on
    expect(a).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(a.failure_why).toContain("was taken over while this watch was keeping its acceptance");
    expect(acceptedFor(dir, 5)).toEqual([]);                                        // the stalled holder's write counts for nothing
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe(taker.token);         // and it never let go of the taker's lock
    letGo(taker);
    // The taker's own acceptance, written after the stalled holder's take-back, stands.
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    expect(acceptedFor(dir, 5)).toEqual([SHA1]);
  });

  test("a watch's exclusive create injected between the recovery's rename and its own create: the recovery fails, or writes above that watch's generation, and the watch's acceptance is not current", () => {
    const stale = (dir: string) => {
      const lock = join(dir, "ship-gate-pr-5.lock");
      writeFileSync(genFile(dir, 5), "1\n");
      writeFileSync(lock, JSON.stringify({ pid: 1, token: "stalled", gen: 1, at: "x" }));
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(lock, old, old);
      return lock;
    };
    // The watch keeps its acceptance and lets go before the recovery's create: the recovery writes above it.
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    stale(dir);
    let w: any = null;
    const r = quietly(() => recoverGen(dir, 5, { afterTakeover: () => { w = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo); } } as any));
    expect(w.accepted_head).toBe(SHA1);
    const wGen = JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8")).gen;
    expect(r.ok).toBe(true);
    expect((r as any).gen).toBeGreaterThan(wGen);
    expect(acceptedFor(dir, 5)).toEqual([]);
    // The watch still holds the lock at the recovery's create: the recovery fails and changes nothing.
    const dir2 = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    const lock2 = stale(dir2);
    let holder: any = null;
    const r2 = quietly(() => recoverGen(dir2, 5, { waitMs: 300, afterTakeover: () => { holder = takeLock(lock2, 0); } } as any));
    expect("token" in holder).toBe(true);
    expect(r2).toMatchObject({ ok: false, why: expect.stringContaining("looks to be running") });
    expect(readGen(dir2, 5)).toBe(2);                                               // twenty-ninth round: its takeover moved it on
    expect(acceptedFor(dir2, 5)).toEqual([]);
    letGo(holder);
  });

  test("without a token a page read is never retried and every refusal says how many reads are left; with one it is retried as before", async () => {
    const server = Bun.spawn(["bun", "-e", `
      let n = 0;
      const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
        if (new URL(req.url).pathname === "/count") return new Response(String(n));
        n++;
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "content-type": "application/json", "retry-after": "1", "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" } });
      } });
      console.log(s.port);`], { stdout: "pipe", stderr: "pipe" });
    try {
      const port = Number(new TextDecoder().decode((await server.stdout.getReader().read()).value).trim());
      const base = `http://127.0.0.1:${port}`;
      const count = async () => Number(await (await fetch(`${base}/count`)).text());
      g.resetQuota();
      expect(g.quotaNote({})).toContain("isn't known yet");
      expect(g.pageRetries({})).toBe(0);
      const r = g.ghPage("/repos/o/r/actions/runs", { base, env: {} });
      expect(r.status).toBe(403);
      expect(await count()).toBe(1);
      expect(g.quotaNote({})).toBe(" (reads without a GitHub token: 0 of 60 left this hour)");
      const token = { SHIP_GATE_GITHUB_TOKEN: "t".repeat(40) };
      expect(g.pageRetries(token)).toBe(2);
      expect(g.quotaNote(token)).toBe("");
      g.ghPage("/repos/o/r/actions/runs", { base, env: token });
      expect(await count()).toBe(4);
      // The watch's printed refusal carries it.
      const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts"), "utf8");
      expect(src).toContain("failure_why: why,");
      expect(src).toContain("${r.owed ? quotaNote() : \"\"}");
    } finally { server.kill(); }
  }, 20_000);

  test("the recovery deletes temporary generation files a cut-off write left behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate28-"));
    writeFileSync(genFile(dir, 5), "2\n");
    const left = `${genFile(dir, 5)}.tmp-123-abcd`;
    writeFileSync(left, "9\n");
    expect(quietly(() => recoverGen(dir, 5))).toEqual({ ok: true, gen: 3 });
    expect(existsSync(left)).toBe(false);
  });

  test("the bound is said as it is: the acceptance window, not lock holding", () => {
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts"), "utf8");
    expect(src).toContain("what is bounded is the acceptance window");
    expect(src).toContain("the holding is unbounded");
  });
});

describe("twenty-ninth review: every takeover moves the generation on, the quarantine never deletes what it moved, an owed supersede cleared on an unchanged head, curl checked by the wrapper for every read, and the deadline re-checked after the write", () => {
  const g = gate28 as any;
  const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
    accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
  const echo = { headNow: (_p: number, h: string) => h };
  const quietly = <T>(f: () => T): T => { const was = console.error; console.error = () => {}; try { return f(); } finally { console.error = was; } };
  const pauseMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const garbled = (pr: number, gen: number) => `{"step": "ship_gate", "pr": ${pr}, "gen": ${gen}, "accepted_head": "torn`;
  const valid = (head: string, pr = 5, gen = 1) => JSON.stringify({ step: "ship_gate", pr, bound_head: head, accepted_head: head, failure: null, gen, gen_floor: gen, format: GATE_RECORD_FORMAT }) + "\n";
  const logLines = (dir: string) => { try { return readFileSync(quarantineLog(dir), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // A curl stub: its version line, then what it prints and how it exits (or sleeps past any limit).
  const stubCurl = (version: string, body = "", exit: number | "sleep" = 0) => {
    const d = mkdtempSync(join(tmpdir(), "stub-curl-"));
    writeFileSync(join(d, "out"), body);
    writeFileSync(join(d, "curl"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "curl ${version} (x86_64-pc-linux-gnu)"; exit 0; fi\necho x >> ${JSON.stringify(join(d, "calls"))}\ncat ${JSON.stringify(join(d, "out"))}\n${exit === "sleep" ? "exec sleep 30" : `exit ${exit}`}\n`, { mode: 0o755 });
    return { dir: d, bin: join(d, "curl"), calls: () => { try { return readFileSync(join(d, "calls"), "utf8").trim().split("\n").length; } catch { return 0; } } };
  };
  const cardOf = (dir: string) => () => { const x = gateState(dir, 5) as any; return "heads" in x ? (x.owed ? { owed: x.owed } : x.heads) : x; };

  test("a holder stalled past the stale bound that writes after a quarantine's takeover and dies before its take-back leaves nothing kept: the next watch of that head reads the head again", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate29-"));
    writeFileSync(genFile(dir, 5), "1\n");
    let q: any = null;
    expect(() => quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { ...echo, staleMs: 300, criticalMs: 8_000,
      atWrite: () => {
        // Past its last fence check, the holder stalls; a garbled record of the pull request is quarantined meanwhile,
        // taking the stale lock over.
        pauseMs(500);
        writeFileSync(watchFile(dir, SHA2), garbled(5, 1));
        q = g.quarantineRecord(dir, SHA2, { staleMs: 300 });
      },
      afterWrite: () => { throw new Error("the holder dies before its take-back"); } }))).toThrow("dies before its take-back");
    expect(q.ok).toBe(true);
    expect(readGen(dir, 5)).toBe(2);                                                // the quarantine's takeover moved it on
    expect(JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8")).gen).toBe(1);     // the stalled holder's late write
    expect(acceptedFor(dir, 5)).toEqual([]);
    let reads = 0;
    const next = keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { headNow: (_p, h) => { reads++; return h; } });
    expect(reads).toBeGreaterThan(0);                                               // read again, never returned as kept
    expect(next).toMatchObject({ accepted_head: SHA1, gen: 2 });
  });

  test("the lock-file quarantine moving the pull request's lock aside moves the generation on too", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate29-"));
    writeFileSync(genFile(dir, 5), "3\n");
    writeFileSync(join(dir, "ship-gate-pr-5.lock"), `{"pid": 1, "token": "x", "gen": 3`);
    expect(g.quarantineLock(dir, 5).ok).toBe(true);
    expect(readGen(dir, 5)).toBe(4);
  });

  test("a put-back that fails never deletes: a fresh record at the destination between the rename and the restore leaves the moved one under its quarantine name, logged with its generations and the failure, with the restore command", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate29-"));
    const f = watchFile(dir, SHA1);
    writeFileSync(f, garbled(5, 3));
    writeFileSync(genFile(dir, 5), "3\n");
    let as = "";
    const r = g.quarantineRecord(dir, SHA1, { rename: (from: string, to: string) => {
      as = to;
      writeFileSync(from, valid(SHA1, 5, 3));      // a watch rewrote it just before the rename: what is moved parses
      renameSync29(from, to);
      writeFileSync(from, valid(SHA1, 5, 3).replace(`"gen":3`, `"gen":3,"fresh":true`)); // and a fresh record stands there before the restore
    } });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("couldn't be put back");
    expect(r.why).toContain(`mv -n ${as} ${f}`);
    expect(existsSync(as)).toBe(true);                                              // never deleted
    expect(JSON.parse(readFileSync(as, "utf8"))).toMatchObject({ accepted_head: SHA1, gen: 3 });
    expect(logLines(dir)).toEqual([expect.objectContaining({ file: f, as, pr: 5, gen_max: 3, put_back_failed: expect.stringContaining("a newer file now stands") })]);
    expect(JSON.parse(readFileSync(f, "utf8")).fresh).toBe(true);
  });

  test("the card refuses while a record is away from its path: during the quarantine's rename, and after a quarantine cut off before its log entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate29-"));
    // A live acceptance of another head stands; its record is set aside mid-quarantine.
    expect(keepWatch(dir, line(SHA2), watchFile(dir, SHA2), echo).accepted_head).toBe(SHA2);
    const f = watchFile(dir, SHA2);
    writeFileSync(f, readFileSync(f, "utf8").replace(/\}\s*$/, ""));             // torn: the quarantine's to set aside
    let during: any = null;
    const r0 = g.quarantineRecord(dir, SHA2, { rename: (from: string, to: string) => {
      writeFileSync(from, valid(SHA2, 5, readGen(dir, 5)!));                        // rewritten whole by a watch: it will be put back
      renameSync29(from, to);
      during = cardOf(dir)();
    } });
    expect(r0.why).toContain("put back");
    expect(during).toMatchObject({ unknown: expect.stringContaining("is at work") });
    const r = rig({ facts: true, gateWatch: () => during });
    r.github.facts = facts();
    r.reviews.list = [REVIEW];
    await expect(ship(r)).rejects.toThrow("state is unknown");
    // A quarantine cut off between its rename and its log entry: the card stays refused, with the restore.
    const as = `${f}.quarantined-pr5-abcd1234`;                                       // 0.12.2: the name carries the pull request
    renameSync29(f, as);
    const st = gateState(dir, 5) as any;
    expect(st.unknown).toContain(`mv -n ${as} ${f}`);
    const r2 = rig({ facts: true, gateWatch: cardOf(dir) });
    r2.github.facts = facts();
    r2.reviews.list = [REVIEW];
    await expect(ship(r2)).rejects.toThrow("without being recorded or put back");
    renameSync29(as, f);
    expect(gateState(dir, 5)).toEqual({ heads: [SHA2] });
  });

  test("an owed supersede re-run while the head is unchanged clears the mark under the lock, logged, and the card then passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate29-"));
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    expect(await supersede(dir, SHA1, async () => ({ miss: "rate_limit" as const, wait_ms: 60_000 }))).toMatchObject({ ok: false, owed: true });
    expect((gateState(dir, 5) as any).owed).toBeDefined();
    const again = await quietly(() => supersede(dir, SHA1, async () => SHA1));
    expect(again).toMatchObject({ ok: false, cleared: true, why: expect.stringContaining("no longer owed: head unchanged") });
    const rec = JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8"));
    expect(rec.supersede_owed).toBeUndefined();
    expect(rec.owed_cleared).toMatchObject({ why: "no longer owed: head unchanged" });
    expect(gateState(dir, 5)).toEqual({ heads: [SHA1] });
    expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);
    const r = rig({ facts: true, gateWatch: cardOf(dir) });
    r.github.facts = facts();
    r.reviews.list = [REVIEW];
    expect(lines(r, await ship(r))[0]).toBe("Ship Cain 0.11.0?");
    // With no owed mark, the head unchanged still refuses as before.
    expect(await supersede(dir, SHA1, async () => SHA1)).toEqual({ ok: false, why: expect.stringContaining("supersede only once a new head has been pushed") });
  });

  test("the supersede and a page read with an unsupported curl refuse by name, naming the local cause, never as GitHub not answering", async () => {
    const old = stubCurl("7.29.0", "HTTP/1.1 200 OK\r\n\r\n{}");
    const page = g.ghPage("/repos/o/r/actions/runs", { base: "http://127.0.0.1:9", env: {}, curl: old.bin });
    expect(page).toMatchObject({ miss: "local", why: expect.stringContaining("older than 7.32") });
    await expect(g.pageApi({ base: "http://127.0.0.1:9", env: {}, curl: old.bin })("/repos/o/r/actions/runs")).rejects.toThrow("older than 7.32");
    expect(old.calls()).toBe(0);                                                    // no read is made at all
    const dir = mkdtempSync(join(tmpdir(), "ship-gate29-"));
    expect(keepWatch(dir, line(SHA1), watchFile(dir, SHA1), echo).accepted_head).toBe(SHA1);
    const s = await supersede(dir, SHA1, async (n) => ghHeadRead("o/r", n, { base: "http://127.0.0.1:9", curl: old.bin }));
    expect(s.ok).toBe(false);
    expect((s as any).why).toContain("older than 7.32");
    expect((s as any).why).toContain("the cause is on the Pi");
    expect((s as any).why).not.toContain("didn't answer");
    // A curl that fails on an option it doesn't know is named as that.
    const bad = stubCurl("8.5.0", "", 48);
    expect(g.ghPage("/x", { base: "http://127.0.0.1:9", env: {}, curl: bad.bin })).toMatchObject({ miss: "local", why: expect.stringContaining("an option it doesn't know") });
    // The command refuses at its start, by name.
    const p = Bun.spawn(["bun", join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts"), "--supersede", SHA1, "--dir", dir],
      { env: { ...process.env, PATH: `${old.dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const err = await new Response(p.stderr).text();
    expect(await p.exited).toBe(1);
    expect(err).toContain("curl 7.29.0 is older than 7.32");
    expect(old.calls()).toBe(0);
  }, 20_000);

  test("a write that finishes past the window is voided under the same generation and reported as the deadline, without another read of GitHub", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-gate29-"));
    let reads = 0;
    const k = quietly(() => keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { criticalMs: 1_500, headNow: (_p, h) => { reads++; return h; },
      afterWrite: () => pauseMs(1_700) }));
    expect(k).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(k.failure_why).toContain("just after its acceptance was written");
    expect(reads).toBe(1);
    expect(acceptedFor(dir, 5)).toEqual([]);
    expect(readGen(dir, 5)).toBe(1);
  });

  test("a killed curl's partial output, or a failed curl's, is never parsed as a page", () => {
    const page = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ head: { sha: SHA1 } })}`;
    const slow = stubCurl("8.5.0", page, "sleep");
    const r = g.ghGet("/repos/o/r/pulls/5", { base: "http://127.0.0.1:9", curl: slow.bin, deadline: Date.now() + 1_500 });
    expect(r).toEqual({ miss: "deadline" });
    expect(g.ghHeadRead("o/r", 5, { base: "http://127.0.0.1:9", curl: slow.bin, maxS: 1 })).not.toBe(SHA1);
    const failed = stubCurl("8.5.0", page, 7);
    expect(g.ghGet("/repos/o/r/pulls/5", { base: "http://127.0.0.1:9", curl: failed.bin })).toEqual({ miss: "no_answer" });
  }, 20_000);
});
const renameSync29 = (a: string, b: string) => require("node:fs").renameSync(a, b);
