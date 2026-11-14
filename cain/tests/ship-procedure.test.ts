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
    for (const must of ["They act", "/data/work/gate-report.jsonl", "\"The message gate held this:\"", "don't mention the gate to him",
      "third try goes as it is", "Send only to his DM, and edit only your own replies", "is refused every time, and no third try lets it through",
      "An edit straight after your reply is fine", "an edit is held too: send it as a new reply instead, or edit in a minute",
      "If the edit is held, send a one-line correction as a new reply instead", "say it without the dash, as a range in words if it is one", "A specialist's card is never refused",
      "Name a button to him only in a reply to the card that has it", "/opt/cain/keeper.sh card <message id>", "/opt/cain/keeper.sh check",
      "/opt/cain/keeper.sh selftest", "/data/work/gate-replay.json", "projects/org-v2/gate-replay-<YYYY-MM-DD>.md", "through the record keeper",
      "check the gate end to end", "Nothing to tell him"])
      expect(gate).toContain(must);
    expect(gate).not.toContain("only report");
    expect(gate).not.toContain("anything else is refused every time");   // the edit that waits isn't refused for good
  });

  test("after a restart, before he has written, his DM's chat id is read from the published cards", () => {
    expect(rules.replace(/\s+/g, " ")).toContain("After a restart, before he has written, his DM's chat id is `dm` in /data/trust/cards.json: use it to tell him what he should hear (the install line after a Ship) instead of waiting for his next message.");
  });

  test("Stop: within reach of his newest message, never on a card that asks something, and off while stopped", () => {
    const stop = section(rules, "## Stop");
    for (const must of ["the link\nputs it on the newest plain message", "never on an ask, a Ship card or a specialist's card",
      "none of the newest 5 bot messages carries a Stop", "The moving Stop comes off meanwhile", "never ask him to"])
      expect(stop).toContain(must);
  });
});
