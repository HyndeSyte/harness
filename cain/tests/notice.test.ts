// The App's alarms to Dane (rootfs/opt/cain/notice.sh), Cain 0.13.3: the App restarts itself for
// a stop for a moment and for a move undone safely, so those two texts hand him no step.
import { expect, test } from "bun:test";
import { join } from "node:path";

const NOTICE = join(import.meta.dir, "../rootfs/opt/cain/notice.sh");
const FORBIDDEN = ["restart the Cain App", "Settings, Apps", "If he isn't back"];

test("the restart and switch-restart texts end at \"Nothing for you to do.\" and name no step", () => {
  for (const kind of ["restart", "switch-restart"]) {
    const p = Bun.spawnSync(["bash", NOTICE, "text", kind, "the channel smoke test didn't pass"]);
    expect(p.exitCode).toBe(0);
    const [title, msg] = p.stdout.toString().split("\n");
    expect(title).toBe("Cain is stopped for a moment");
    expect(msg.endsWith("Nothing for you to do.")).toBe(true);
    for (const f of FORBIDDEN) { expect(msg).not.toContain(f); expect(title).not.toContain(f); }
  }
});
