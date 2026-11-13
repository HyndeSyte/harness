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

  test("the message gate: buttons named only from the card that has them, look first, the replay filed", () => {
    const gate = section(rules, "## The message gate");
    for (const must of ["only report", "/data/work/gate-report.jsonl", "Name a button to him only in a reply to the card that has it",
      "/opt/cain/keeper.sh card <message id>", "/opt/cain/keeper.sh check", "/data/work/gate-replay.json",
      "projects/org-v2/gate-replay-<YYYY-MM-DD>.md", "through the record keeper", "Nothing to tell him"])
      expect(gate).toContain(must);
  });
});
