// Home Assistant first (piece D): the Ship procedure checks Home Assistant's connector
// before it installs (RELEASING.md), and Cain checks it before he shows a Ship card and
// before he starts a Ship run (CLAUDE.md). A lapse reaches Dane only when he must sign
// in again, as one notice with a link button, never a button to report back.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const releasing = readFileSync(join(import.meta.dir, "../../RELEASING.md"), "utf8").replace(/\r\n/g, "\n");
const rules = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/CLAUDE.md"), "utf8").replace(/\r\n/g, "\n");
const section = (text: string, heading: string) => text.split(heading)[1].split("\n## ")[0];

describe("RELEASING.md", () => {
  const ship = section(releasing, "## Ship (only after Dane's go)");

  test("the Ship steps check Home Assistant before the install, and stop with one line if it can't be reached", () => {
    const check = ship.indexOf("Check Home Assistant first");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(ship.indexOf("In Home Assistant: check for App updates"));
    expect(ship.indexOf("Check `main` contains that commit")).toBeLessThan(check);
    expect(ship).toContain("`Home Assistant connector: needs signing in again` (or `no answer`)");
    expect(ship).toContain("install nothing, change nothing");
  });

  test("the Ship card's words come from code (0.11.0), and a handed-over pull request is reviewed by the service first", () => {
    const flat = ship.replace(/\s+/g, " ");
    for (const must of ["The link builds that card itself", "names each App and version the tap installs", "read at that very head and at the pull request's base",
      "read the way the landing reads them", "a check that failed or hasn't run yet refuses the card", "\"Already in main, so Ship only installs it.\"", "each required check's latest runs in one whole answer",
      "the review service's own Reviewed line for the review Cain names", "must be a review of that very pull request and head",
      "\"No outside review attached.\"", "Cain's own line says only what Dane will notice", "No card shows a record code",
      "\"The reviewers read Cain's summary of the change, not the code.\"", "the pull request's title isn't shown"])
      expect(flat).toContain(must);
    expect(flat).not.toContain("finished before the head commit");
    const build = section(releasing, "## Build (a branch and a pull request)").replace(/\s+/g, " ");
    expect(build).toContain("gets an outside review of the diff through his review service");
    expect(build).not.toContain("that CI passed, and how it was reviewed");
    expect(build).toContain("Dane's Ship card doesn't show it");
  });

  test("a section says what happens when the connector lapses, with no report-back tap", () => {
    const lapse = section(releasing, "## If Home Assistant's connector lapses");
    for (const must of ["before he\nshows a Ship card", "again before he starts a Ship run", "each 15-minute cloud job check",
      "whose\n  only button opens Claude's connector settings", "It asks nothing\n  back", "new Ship card for the same pull request and head",
      "only once Home Assistant answers again", "One installer"])
      expect(lapse).toContain(must);
    expect(lapse).not.toMatch(/Reconnected|tap .* when|let .* know/);
  });
});

describe("Cain's rules", () => {
  const jobs = section(rules, "## Cloud jobs (building, without his laptop)");

  test("he checks Home Assistant before the Ship card and before the Ship run", () => {
    const build = jobs.indexOf("- Build finished with a pull request");
    expect(jobs.indexOf("check Home Assistant first", build)).toBeLessThan(jobs.indexOf("keeper.sh ship --item", build));
    const landed = jobs.indexOf("- Landed (");
    expect(jobs.indexOf("check Home Assistant first", landed)).toBeLessThan(jobs.indexOf("RemoteTrigger `run` on Ship", landed));
  });

  test("a lapse: its own marker, a re-check at each nudge, one notice only when sign-in is needed", () => {
    const first = jobs.split("- Home Assistant first.")[1];
    for (const must of ["your read-only connector", "/data/jobs/connector-<item>", "`connector | <item> | <pull request url> | <full head sha>`",
      "Only when the connector says it must be signed in again", "/opt/cain/keeper.sh connector --item <item>",
      "No answer, or a passing\n       error: tell him nothing", "At each cloud job check, read Home Assistant again", "`touch` the file",
      "while his token is\n       good (2 hours from his tap)", "new Ship card for the\n       same pull request and head",
      "A new Ship card\n       goes out only once Home Assistant answers again", "Never ask him to check anything"])
      expect(first).toContain(must);
    expect(jobs).toContain("A `connector` file isn't a\n   job");
    expect(jobs).not.toContain("Reconnected");
  });

  test("a Ship run that ends on the connector's line is handled the same way", () => {
    expect(jobs).toContain("If it ends with `Home Assistant connector: needs signing in again` (or `no\n     answer`), nothing was installed");
  });

  test("the message gate: it acts, buttons named only from the card that has them, look first, the replay filed", () => {
    const gate = section(rules, "## The message gate").replace(/\s+/g, " ");
    for (const must of ["They act", "/data/gate/report.jsonl", "\"The message gate held this:\"", "don't mention the gate to him",
      "third try goes as it is", "Send only to his DM, and edit only your own replies", "is refused every time, and no third try lets it through",
      "An edit straight after your reply is fine", "an edit is held too: send it as a new reply instead, or edit in a minute",
      "If the edit is held, send a one-line correction as a new reply instead", "The gate refuses every em dash of yours, so never write one", "for a range use \"to\" or \"through\"", "A specialist's card is never refused",
      "Name a button to him only in a reply to the card that has it", "/opt/cain/keeper.sh card <message id>", "/opt/cain/keeper.sh check",
      "/opt/cain/keeper.sh selftest", "/data/gate/replay.json", "projects/org-v2/gate-replay-<YYYY-MM-DD>.md", "through the record keeper",
      "check the gate end to end", "Nothing to tell him"])
      expect(gate).toContain(must);
    expect(gate).not.toContain("only report");
    expect(gate).not.toContain("anything else is refused every time");   // the edit that waits isn't refused for good
  });

  test("after a restart, before he has written, his DM's chat id is read from the published cards", () => {
    expect(rules.replace(/\s+/g, " ")).toContain("After a restart, before he has written, his DM's chat id is `dm` in /data/trust/cards.json: use it to tell him what he should hear (the install line after a Ship) instead of waiting for his next message.");
  });

  test("Ship cards built from code (0.11.0): the card names its review, his line says only what he'll notice, the link builds the rest", () => {
    const build = jobs.slice(jobs.indexOf("- Build finished with a pull request"));
    const flat = build.replace(/\s+/g, " ");
    expect(build).toContain('`/opt/cain/keeper.sh ship --item <its PENDING id> --pr <pull request url> --head <full head sha> --review <the review id> "<what he\'ll notice, in one line>"`');
    for (const must of ["through the review service", "Your line says only what he'll notice", "the question (which Apps and versions the tap installs)",
      "whether its checks passed", "that review's Reviewed line", "Your line holds no check, test, build or CI words, no GitHub, job, status or result words (passed, green, success), and no review, verdict or AI names: the link refuses them",
      "a check failed or hasn't run yet", "a review of another head", "A new head needs a new review of it and a new Ship card"])
      expect(flat).toContain(must);
    expect(flat.indexOf("through the review service")).toBeLessThan(flat.indexOf("keeper.sh ship --item"));
    expect(jobs).not.toContain("CI passed. Reviewed:");
    // Step 5: a handed-over pull request gets a review from the service before its card.
    expect(jobs.split("5. A laptop session hands you")[1].replace(/\s+/g, " ")).toContain("get an outside review of its diff through the review service "
      + "before the Ship card, even if it was reviewed elsewhere: only a service review's line goes on the card");
    // Fixes go back with the item, so the fixed head comes back the way it first came: Cain hears
    // at once (Nov 15, a re-handoff as a note waited most of a day for a check-in).
    const step5 = jobs.split("5. A laptop session hands you")[1].replace(/\s+/g, " ");
    expect(step5).toContain("If the review calls for fixes, they go with the branch (`/opt/cain/record.sh holds`): "
      + "- The pass brought it: the branch is yours with the item, so run Build on it with the fixes, as for your own pull request. "
      + "- A laptop session kept it");
    expect(step5).toContain("pass the item back to that session with the findings in a note, in one request. It passes the item "
      + "to you again with the new head, and you hear at once.");
    // A hold doesn't prove its session will run again: the way on when it goes quiet.
    expect(step5).toContain("If that session goes quiet, its holds lapse after a day; then take the item with its branch and fix it through Build.");
    expect(step5).not.toContain("so that session is live");
  });

  test("a Reviewed line is the relay's, word for word, and the gate refuses any other", () => {
    const reviews = section(rules, "## Outside reviews").replace(/\s+/g, " ");
    expect(reviews).toContain('end with its Reviewed line exactly as the relay gave it ("Say it as: Reviewed: OpenAI, approve with changes; Gemini, approve."), '
      + "word for word. The gate refuses any other Reviewed line");
    const gate = section(rules, "## The message gate").replace(/\s+/g, " ");
    for (const must of ["a Reviewed line only as the review service gave it", "A Reviewed line goes out only as the review service gave it",
      "On a Ship card your line may claim no checks or review: the link adds those",
      "never give a review's outcome in any words but the service's line"])
      expect(gate).toContain(must);
  });

  test("Stop: within reach of his newest message, never on a card that asks something, and off while stopped", () => {
    const stop = section(rules, "## Stop");
    for (const must of ["the link\nputs it on the newest plain message", "never on an ask, a Ship card or a specialist's card",
      "none of the newest 5 bot messages carries a Stop", "The moving Stop comes off meanwhile", "never ask him to"])
      expect(stop).toContain(must);
  });

  test("no record codes to him (0.11.0): things named by what they do, cards without labels, the gate holds the codes", () => {
    const flat = rules.replace(/\s+/g, " ");
    // The standard itself lives in his standards now (the registry's S-013, 0.13.0); these pages
    // keep how Cain carries it out.
    const registry = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/standards/registry.md"), "utf8").replace(/\r\n/g, "\n");
    const s013 = registry.split("## S-013 ")[1].split("\n## ")[0];
    expect(s013).toContain("Nothing he reads carries a record or build code");
    expect(s013).toContain("Each thing is named by what it does for him");
    for (const must of ["go with it as data, never in its words",
      "A record code (an item id your record has, like P64, or \"P08 Q2\") is held every time, and no third try lets it through", "\"head\": \"<its full head sha>\""])
      expect(flat).toContain(must);
    expect(flat).not.toContain("its text starts with them");
    expect(rules).not.toMatch(/"P\d+ Q\d+: [A-Z]/);                       // no example card's words start with a label
    expect(rules).not.toContain("<id> <Q id>:");
  });
});
