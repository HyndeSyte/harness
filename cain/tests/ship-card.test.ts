// Ship cards built from GitHub and the review service (Cain 0.11.0; link/core.ts shipText,
// with GitHub and /data/trust/reviewed.json faked in link-rig.ts): the question names what
// the tap installs, a line from GitHub has the title, how much it changes and the checks
// (read as the landing reads them), and the last line is the review service's own. Cain's
// line says what Dane will notice and can't carry evidence (the ship words rule). Anything
// going wrong while the new lines are built gives the card as it was, never no card.
import { describe, expect, test } from "bun:test";
import { CHECKS_PASSED, CHECKS_UNREAD } from "../rootfs/opt/cain/link/core";
import { checkRun, keeperHolds, MIN, NOV11_8AM, passing, PR, rig, SHA1, SHA2 } from "./link-rig";

const bump = (from: string, to: string) => `@@ -4,7 +4,7 @@\n name: X\n-version: "${from}"\n+version: "${to}"\n slug: x`;
const FACTS = { head: SHA1, commits: 4, files: 12, areas: ["Cain's link", "Cain's rules"], title: "Cain 0.11.0: Ship cards from code",
  configs: [{ app: "Cain", patch: bump("0.10.0", "0.11.0") }] };
const LINE = "Stop stays in reach of your newest message.";
const GITHUB = `From GitHub: "Cain 0.11.0: Ship cards from code", 4 commits and 12 files, including Cain's link and Cain's rules.`;
// Finished ten minutes ago; the head commit was made an hour ago (link-rig.ts).
const REVIEW = { id: "2026-11-11-ship-cards", line: "Reviewed: OpenAI, approve with changes; Gemini, approve.", finished_at: new Date(NOV11_8AM - 10 * MIN).toISOString() };
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
  test("the question names each App and version the tap installs, from the config.yaml patches", async () => {
    const r = shipRig();
    expect(r.msg(await ship(r)).content).toBe(`P64: Ship Cain 0.11.0?\n${LINE}\n${GITHUB} Checks passed.\nNo outside review.`);
    r.github.facts = facts({ configs: [{ app: "Harness", patch: bump("0.23.0", "0.24.0") }, { app: "Cain", patch: bump("0.10.0", "0.11.0") }] });
    expect(lines(r, await ship(r))[0]).toBe("P64: Ship Cain 0.11.0 and Harness 0.24.0?");
    r.github.facts = facts({ configs: [{ app: "Harness", patch: bump("0.23.0", "0.24.0") }] });
    expect(lines(r, await ship(r))[0]).toBe("P64: Ship Harness 0.24.0?");
    r.github.facts = facts({ configs: [] });
    expect(lines(r, await ship(r))[0]).toBe("P64: Ship it? No App version changes, so nothing installs.");
    r.github.facts = facts({ configs: [{ app: "Cain", patch: bump("0.10.0", "0.11.0") }, { app: "Harness", patch: null }] });
    expect(lines(r, await ship(r))[0]).toBe("P64: Ship it?");                // a patch GitHub left out: can't be told
    r.github.facts = facts();
    expect(lines(r, await ship(r, { item: "none" }))[0]).toBe("Ship Cain 0.11.0?");   // about no item: no label
  });

  test("the title as GitHub has it: one line, quoted, cut with ... at 120 characters", async () => {
    const r = shipRig();
    r.github.facts = facts({ title: "Cain 0.11.0: Ship cards\nfrom   code" });
    expect(lines(r, await ship(r))[2]).toBe(`From GitHub: "Cain 0.11.0: Ship cards from code", 4 commits and 12 files, including Cain's link and Cain's rules. ${CHECKS_PASSED}`);
    const long = `Cain 0.11.0: ${"the card says what installs and whether it passed ".repeat(4)}`;
    r.github.facts = facts({ title: long });
    const title = /^From GitHub: "([^"]*)", 4 commits/.exec(lines(r, await ship(r))[2])![1];
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title).toEndWith("...");
    expect(long.startsWith(title.slice(0, -3))).toBe(true);
    r.github.facts = facts({ title: "Harness 0.24.0: the add-on's digest" });   // the link's own words: fixed as they go
    expect(lines(r, await ship(r))[2]).toStartWith(`From GitHub: "Harness 0.24.0: the App's digest", 4 commits`);
    r.github.facts = facts({ title: "" });
    expect(lines(r, await ship(r))[2]).toBe(`From GitHub: 4 commits and 12 files, including Cain's link and Cain's rules. ${CHECKS_PASSED}`);
  });

  test("the checks, judged as the landing judges them: passed, still running, unreadable; a failed one or one not run refuses the card", async () => {
    const r = shipRig();
    const github = async () => lines(r, await ship(r))[2];
    expect(await github()).toBe(`${GITHUB} Checks passed.`);
    r.github.runs = [checkRun("pytest"), checkRun("bun", null, "in_progress"), checkRun("pr")];
    expect(await github()).toBe(`${GITHUB} Checks are still running; Ship lands it once they pass.`);
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
    expect(r.posts()).toBe(posts);                                               // nothing posted for a refused card
    expect(r.github.asked).toContain(`runs ${SHA1}`);                            // the head the card names
  });

  test("the pull request unreadable: today's line and \"Ship it?\"; its checks still count", async () => {
    const r = shipRig({ facts: null });
    expect(r.msg(await ship(r)).content).toBe(`P64: Ship it?\n${LINE}\nFrom GitHub: the pull request couldn't be read just now.\nNo outside review.`);
    r.github.runs = [checkRun("pytest", "failure"), checkRun("bun"), checkRun("pr")];
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("its pytest check didn't pass (failure)");
  });

  test("anything going wrong while the new lines are built gives the card as it was: never no card", async () => {
    const r = shipRig();
    r.github.facts = { ...facts(), get title(): string { throw new Error("a bug in the new lines"); } };
    const id = await ship(r, { review: REVIEW.id });
    expect(r.msg(id).content).toBe(`P64: Ship it?\n${LINE}\nFrom GitHub: 4 commits and 12 files, including Cain's link and Cain's rules.`);
    expect(r.buttons(id)).toEqual(["Ship", "Not now"]);
    expect(r.logs.some((l) => l.includes("couldn't build a Ship card's new lines, so it goes as it was: a bug in the new lines"))).toBe(true);
    // A refusal is still one: the card as it was never goes out past it.
    r.github.runs = [checkRun("pytest", "failure"), checkRun("bun"), checkRun("pr")];
    await expect(ship(r, { text: "Other words." })).rejects.toThrow("its pytest check didn't pass");
    // Broken facts from GitHub, through and through: still a card.
    r.github.runs = passing();
    r.github.facts = { head: SHA1, commits: 1, files: 1, areas: null } as any;
    expect(r.msg(await ship(r, { text: "Third words." })).content).toBe("P64: Ship it?\nThird words.\nFrom GitHub: the pull request couldn't be read just now.");
  });

  test("GitHub is asked for each part at once, within the facts timeout", async () => {
    const r = rig({ facts: true, factsMs: 400 });
    r.github.facts = facts();
    r.reviews.list = [REVIEW];
    r.github.factsHang = true; r.github.runsHang = true; r.github.madeHang = true;
    const t0 = performance.now();
    const id = await ship(r, { review: REVIEW.id });
    expect(performance.now() - t0).toBeLessThan(1_000);                         // one wait, not three in a row
    expect(r.github.asked).toEqual([`facts ${PR}`, `runs ${SHA1}`, `made ${SHA1}`]);
    expect(r.msg(id).content).toBe(`P64: Ship it?\n${LINE}\nFrom GitHub: the pull request couldn't be read just now.\n${REVIEW.line} Not checked against the newest commit.`);
  });

  test("bound to its full head sha and showing none; his label goes to the question; what ship() did before still holds", async () => {
    const r = shipRig();
    const id = await ship(r, { text: `P64: ${LINE}` });
    const c = r.msg(id).content;
    expect(c).toBe(`P64: Ship Cain 0.11.0?\n${LINE}\n${GITHUB} Checks passed.\nNo outside review.`);
    expect(c).not.toMatch(/[0-9a-f]{40}/);
    expect(r.state().messages[id]).toMatchObject({ kind: "ship", ship: { pr: PR, head: SHA1 }, own: LINE, labels: ["Ship", "Not now"] });
    await expect(ship(r, { text: "P64:" })).rejects.toThrow("a Ship card needs a line saying what he'll notice");
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
    expect(r.buttons(id)).toEqual([]);
    expect(r.buttons(second)).toEqual(["Ship", "Not now"]);
  });
});

describe("the Reviewed line, from the review service", () => {
  test("a finished review newer than the head commit: its line, as the service gave it", async () => {
    const r = shipRig();
    const id = await ship(r, { review: REVIEW.id });
    expect(r.msg(id).content).toBe(`P64: Ship Cain 0.11.0?\n${LINE}\n${GITHUB} Checks passed.\n${REVIEW.line}`);
    expect(r.github.asked).toEqual([`facts ${PR}`, `runs ${SHA1}`, `made ${SHA1}`]);
  });

  test("refused: a review not finished, with no answers, or unknown; one that finished before the head commit", async () => {
    const r = shipRig({ reviews: [REVIEW, { id: "2026-11-11-empty", line: "", finished_at: REVIEW.finished_at }] });
    for (const id of ["2026-11-11-running", "2026-11-11-empty"])
      await expect(ship(r, { review: id })).rejects.toThrow(`review ${id} isn't finished, or has no answers: show the card once it's done, or leave --review out`);
    r.github.madeAt = Date.parse(REVIEW.finished_at) + 1_000;                   // a commit pushed after the review
    await expect(ship(r, { review: REVIEW.id })).rejects.toThrow(`review ${REVIEW.id} finished before the pull request's newest commit: get a review of the head as it is now`);
    await expect(ship(r, { review: "../etc/x" })).rejects.toThrow("review must be a review's id");
    expect(r.posts()).toBe(0);
    r.github.madeAt = Date.parse(REVIEW.finished_at);                           // the same moment: it counts
    expect(lines(r, await ship(r, { review: REVIEW.id })).at(-1)).toBe(REVIEW.line);
  });

  test("its lines unreadable: refused; the head commit's time unreadable: the line, said as not checked", async () => {
    const r = shipRig({ reviews: null });
    await expect(ship(r, { review: REVIEW.id })).rejects.toThrow("reviews can't be read right now: try again in a minute, or leave --review out");
    expect(r.github.asked).toEqual([]);                                          // GitHub isn't asked for a card that can't go
    r.reviews.list = [REVIEW];
    r.github.madeAt = null;
    expect(lines(r, await ship(r, { review: REVIEW.id })).at(-1)).toBe(`${REVIEW.line} Not checked against the newest commit.`);
  });

  test("none named: \"No outside review.\", and the head commit's time isn't asked for", async () => {
    const r = shipRig();
    expect(lines(r, await ship(r)).at(-1)).toBe("No outside review.");
    expect(r.github.asked).toEqual([`facts ${PR}`, `runs ${SHA1}`]);
  });
});

describe("his line can't carry evidence: the link adds the checks and the review", () => {
  const WHY = "the link adds the checks and the Reviewed line itself, so leave CI, check and review claims out of your words";
  test("CI, checks and review claims are refused on a Ship card; plain lines pass", async () => {
    const r = shipRig();
    for (const text of ["CI passed.", "All checks are green.", "Reviewed by OpenAI and Gemini.", "Cain 0.11.0 ready. CI passed. Reviewed: OpenAI, approve.",
      "The tests all passed.", "Build succeeded.", "Tests failed once, fixed now.", "The check is red, but it's fine."]) {
      await expect(ship(r, { text })).rejects.toThrow(WHY);
    }
    expect(r.posts()).toBe(0);
    expect(r.reports.filter((x) => x.point === "ship").every((x) => x.did === "refused" && x.hits.some((h: any) => h.rule === "ship words"))).toBe(true);
    for (const text of [LINE, "Stop stays in reach.", "The red Stop moves down with your newest message.", "Build jobs name their branch."])
      expect(await ship(r, { text })).toBeTruthy();
    // Only on a Ship card: an ask may say it.
    expect((await r.link.ask({ text: "P08 Q2: CI passed on the branch. Merge the notes too?", options: ["Yes", "No"], item: "P08", question: "Q2" })).status).toBe("posted");
  });

  test("his line still gives way first within 2,000 characters", async () => {
    const r = shipRig();
    const c: string = r.msg(await ship(r, { text: "word ".repeat(600), review: REVIEW.id })).content;
    expect(c.length).toBeLessThanOrEqual(2000);
    expect(c).toStartWith("P64: Ship Cain 0.11.0?\nword word");
    expect(c).toEndWith(` …\n${GITHUB} Checks passed.\n${REVIEW.line}`);
  });
});

describe("a Reviewed line in Cain's other words through the link", () => {
  const OLDER = [{ id: "2026-11-10-b", line: "Reviewed: Gemini, approve.", finished_at: "2026-11-10T15:00:00.000Z" },
    { id: "2026-11-09-c", line: "Reviewed: OpenAI, reject.", finished_at: "2026-11-09T15:00:00.000Z" },
    { id: "2026-11-08-d", line: "Reviewed: Perplexity, approve.", finished_at: "2026-11-08T15:00:00.000Z" }];
  test("the exact line passes in an ask and the morning message; an edited one is refused, offering the 3 newest with their ids", async () => {
    const r = rig();
    r.reviews.list = [REVIEW, ...OLDER];
    const morning = await r.link.morningPost(`## Wed Nov 11\n### 🟢 Moving\n• Ship cards are built from code. ${REVIEW.line}`);
    expect(r.msg(morning.message).content).toContain(REVIEW.line);
    expect((await r.link.ask({ text: `P08 Q2: The plan is done. ${OLDER[0].line} Start the build?`, options: ["Start", "Not now"], item: "P08", question: "Q2" })).status).toBe("posted");
    const posts = r.posts();
    const said = await r.link.morning("## Thu Nov 12\n• Done. Reviewed: OpenAI, approve.").catch((e) => String(e.message));
    expect(said).toStartWith('The message gate held this morning message: "Reviewed: OpenAI, approve.": a Reviewed line goes only as the review service gave it, word for word, or not at all (');
    for (const p of [REVIEW, OLDER[0], OLDER[1]]) expect(said).toContain(`review ${p.id}: "${p.line}"`);
    expect(said).not.toContain(OLDER[2].id);
    await expect(r.link.ask({ text: "P08 Q3: Reviewed: Gemini approved it. Ship?", options: ["Yes", "No"], item: "P08", question: "Q3" })).rejects.toThrow("held this ask");
    await expect(r.link.ask({ text: "P08 Q3: Which line?", options: ["Reviewed: Gemini"], item: "P08", question: "Q3" })).rejects.toThrow("held this ask's option");
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

  test("keeper.sh check answers as the hook would: the exact line passes, an edited one is held for good", () => {
    const r = rig();
    r.reviews.list = [REVIEW];
    expect(r.link.checkSend({ text: `Shipped. ${REVIEW.line}` })).toMatchObject({ would: "pass", hits: [] });
    const edited = r.link.checkSend({ text: "Shipped. Reviewed: OpenAI, approve." });
    expect(edited).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "reviewed", result: "refuse" }] });
    expect(edited.said).toContain(`review ${REVIEW.id}: "${REVIEW.line}"`);
    r.reviews.list = null;
    expect(r.link.checkSend({ text: `Shipped. ${REVIEW.line}` })).toMatchObject({ would: "refuse", hard: false, hits: [{ rule: "reviewed", result: "unsure" }] });
  });
});
