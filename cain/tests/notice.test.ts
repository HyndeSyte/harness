// The App's alarms to Dane (rootfs/opt/cain/notice.sh), Cain 0.13.3: no alarm hands him a step;
// the App restarts itself, once, where an alarm used to ask him to; a switch undone safely tells
// Cain, not Dane. Run against a stand-in his bot (alert.sh) and no notice_hook, so nothing leaves.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOTICE = join(import.meta.dir, "../rootfs/opt/cain/notice.sh");
const KINDS = ["breach", "switch-stopped", "switch-blocked", "damaged", "setup", "restart", "switch-restart", "exited", "held",
  "session", "switch-failed", "switch-waits", "waiting", "stalled", "signin", "phone"];
const HARD = ["breach", "switch-stopped", "damaged", "exited", "setup"];
const SELF = ["restart", "switch-blocked", "held", "session", "waiting", "stalled"];
const FORBIDDEN = ["restart the Cain App", "Settings, Apps", "If he isn't back"];

function rig() {
  const d = mkdtempSync(join(tmpdir(), "notice-"));
  const opt = join(d, "opt"); mkdirSync(opt);
  writeFileSync(join(opt, "alert.sh"), `#!/bin/bash\nprintf '%s\\n' "$1" >> "${d}/discord"\n`);
  chmodSync(join(opt, "alert.sh"), 0o755);
  writeFileSync(join(d, "options.json"), "{}");
  return { d, opt };
}
function sh(r: { d: string; opt: string }, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bash", NOTICE, ...args], {
    env: { ...process.env, NOTICE_OPT: r.opt, NOTICE_DATA: r.d, NOTICE_DIR: join(r.d, "notice.d"), NOTICE_PROBED: join(r.d, "probed"),
      NOTICE_PROVEN: join(r.d, "proven"), NOTICE_READ: join(r.d, "read"), RELAY_QUEUE: join(r.d, "relay.queue"),
      NOTICE_OPTIONS: join(r.d, "options.json"), NOTICE_URL: "http://127.0.0.1:9", NOTICE_DAY_S: "999999999", ...env },
  });
  return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const text = (kind: string, cause = "", at = "") => {
  const r = sh(rig(), ["text", kind, cause, at]);
  expect(r.rc).toBe(0);
  const [title, msg] = r.out.split("\n");
  return { title, msg };
};
const discord = (r: { d: string }) => existsSync(join(r.d, "discord")) ? readFileSync(join(r.d, "discord"), "utf8").trim().split("\n") : [];
const state = (r: { d: string }, g: string) => readFileSync(join(r.d, "notice.d", g), "utf8");

describe("no alarm hands Dane a step", () => {
  test("every alarm's text, before and after the App's own restart, names no restart or settings step", () => {
    for (const k of KINDS) for (const at of ["", "1795000000"]) {
      const { title, msg } = text(k, "a cause", at);
      expect(title.length).toBeGreaterThan(0);
      expect(msg.length).toBeGreaterThan(0);
      for (const f of FORBIDDEN) { expect(msg).not.toContain(f); expect(title).not.toContain(f); }
      expect(msg).not.toContain("within an hour");
      expect(msg).not.toContain("within half an hour");
      expect(msg).not.toContain("—");
    }
  });

  test("the backups only in a hard stop's text, after \"A fixed update also brings him back\", never in its first sentence", () => {
    for (const k of KINDS) for (const at of ["", "1795000000"]) {
      const { msg } = text(k, "", at);
      if (HARD.includes(k)) {
        const fix = msg.indexOf("A fixed update also brings him back.");
        expect(fix).toBeGreaterThan(-1);
        expect(msg.indexOf("Settings, System, Backups")).toBeGreaterThan(fix);
        expect(msg.split(". ")[0]).not.toMatch(/restore|backup|Settings/i);
      } else expect(msg).not.toContain("Backups");
    }
  });

  test("after the App's own restart the text says it restarted itself, and what it saw", () => {
    for (const k of SELF) {
      const { msg } = text(k, "", "1795000000");
      expect(msg).toContain("restarted itself at");
    }
    expect(text("stalled", "nothing has gone in for 30 minutes", "1795000000").msg).toContain("(nothing has gone in for 30 minutes)");
  });
});

describe("the App restarts itself, once, before Dane hears", () => {
  test("an alarm it deals with itself reaches no one, and is due its restart only after its window", () => {
    for (const [k, g] of [["held", "stop"], ["session", "session"], ["waiting", "screen"], ["stalled", "deliver"], ["restart", "stop"], ["switch-blocked", "stop"]]) {
      const r = rig();
      expect(sh(r, ["tell", k, "why"]).rc).toBe(0);
      expect(discord(r)).toEqual([]);
      expect(state(r, g)).toContain(`kind ${k}`);
      // Within its window: nothing due.
      expect(sh(r, ["restart-due"]).rc).toBe(1);
      expect(sh(r, ["tick"]).rc).toBeLessThan(2);
      expect(discord(r)).toEqual([]);
    }
  });

  test("the windows: 30 minutes for a switch or restart, an hour for the others", () => {
    const src = readFileSync(NOTICE, "utf8");
    expect(src).toContain('WINDOW_S="${NOTICE_WINDOW_S:-3600}"');
    expect(src).toContain('SWITCH_WINDOW_S="${NOTICE_SWITCH_WINDOW_S:-1800}"');
    expect(src).toContain('window_of() { case "$1" in restart|switch-blocked) echo "$SWITCH_WINDOW_S" ;; *) echo "$WINDOW_S" ;; esac; }');
  });

  test("past its window it's due once; raised again after the restart and still on, Dane hears it said that way", () => {
    const r = rig(); const now = { NOTICE_WINDOW_S: "0", NOTICE_SWITCH_WINDOW_S: "0" };
    sh(r, ["tell", "held"], now);
    const due = sh(r, ["restart-due"], now);
    expect(due.rc).toBe(0);
    expect(due.out.trim()).toBe("stop");
    expect(sh(r, ["restart-due"], now).rc).toBe(1);   // once
    expect(discord(r)).toEqual([]);
    // After the restart (a new container, a moment later) it's raised again, and stands: Dane hears, once.
    Bun.sleepSync(1100);
    sh(r, ["tell", "held"], now);
    sh(r, ["tick"], now);
    const said = discord(r);
    expect(said.length).toBe(1);
    expect(said[0]).toContain("Cain is still paused");
    expect(said[0]).toContain("restarted itself at");
    sh(r, ["tick"], now); sh(r, ["tell", "held"], now);
    expect(discord(r).length).toBe(1);
    expect(sh(r, ["restart-due"], now).rc).toBe(1);   // never a second restart
    // It clears: "Cain is back" to Dane, since he heard of it.
    sh(r, ["clear", "running"], now);
    expect(discord(r).at(-1)).toBe("Cain is running again.");
  });

  test("not raised again after the restart: forgotten, nothing to Dane", () => {
    const r = rig(); const now = { NOTICE_WINDOW_S: "0" };
    sh(r, ["tell", "stalled", "nothing has gone in"], now);
    // Marked restarted a moment before: no tell since.
    expect(sh(r, ["restart-due"], now).rc).toBe(0);
    Bun.sleepSync(1100);
    sh(r, ["tick"], now);
    expect(discord(r)).toEqual([]);
    expect(existsSync(join(r.d, "notice.d", "deliver"))).toBe(false);
  });

  test("a restart the Supervisor didn't take is unmarked, and due again", () => {
    const r = rig(); const now = { NOTICE_WINDOW_S: "0" };
    sh(r, ["tell", "session"], now);
    expect(sh(r, ["restart-due"], now).out.trim()).toBe("session");
    expect(sh(r, ["restart-due"], now).rc).toBe(1);
    sh(r, ["restart-undo", "session"], now);
    expect(sh(r, ["restart-due"], now).out.trim()).toBe("session");
  });

  test("cleared within its window: nothing to Dane, nothing due", () => {
    const r = rig();
    sh(r, ["tell", "waiting"]);
    sh(r, ["clear", "screen"]);
    expect(discord(r)).toEqual([]);
    expect(sh(r, ["restart-due"], { NOTICE_WINDOW_S: "0" }).rc).toBe(1);
  });

  test("a hard stop still reaches Dane at once, with the backups", () => {
    const r = rig();
    sh(r, ["tell", "breach"]);
    expect(discord(r).length).toBe(1);
    expect(discord(r)[0]).toContain("A fixed update also brings him back. To get him back now, restore two backups");
    expect(sh(r, ["restart-due"], { NOTICE_WINDOW_S: "0", NOTICE_SWITCH_WINDOW_S: "0" }).rc).toBe(1);
  });

  test("the run script's watcher asks the Supervisor, and unmarks a restart it didn't take", () => {
    const run = readFileSync(join(import.meta.dir, "../rootfs/etc/services.d/cain/run"), "utf8");
    const loop = run.slice(run.indexOf("self_restart() {"), run.indexOf("if [ \"$mode\" = old ]; then\n  # 0.11.0's start"));
    expect(loop).toContain('due="$("$OPT/notice.sh" restart-due)" && [ -n "$due" ] && self_restart "$due"');
    expect(loop).toContain("bashio::addon.restart");
    expect(loop).toContain('"$OPT/notice.sh" restart-undo $groups');
  });
});

describe("a switch undone safely tells Cain, not Dane", () => {
  test("one line in the relay queue for his morning update, once per cause, and no alarm", () => {
    const r = rig();
    expect(sh(r, ["tell", "switch-restart", "the channel smoke test didn't pass"]).rc).toBe(0);
    sh(r, ["tell", "switch-restart", "the channel smoke test didn't pass"]);
    sh(r, ["tick"]);
    expect(discord(r)).toEqual([]);
    expect(existsSync(join(r.d, "notice.d", "stop"))).toBe(false);
    const q = readFileSync(join(r.d, "relay.queue"), "utf8").trim().split("\n");
    expect(q.length).toBe(1);
    const line = JSON.parse(q[0]).text;
    expect(line).toContain("morning update");
    expect(line).toContain("(the channel smoke test didn't pass)");
    expect(line).toContain("The App told Dane nothing");
    // He runs again: a later undone switch is told afresh.
    sh(r, ["clear", "running"]);
    sh(r, ["tell", "switch-restart", "the channel smoke test didn't pass"]);
    expect(readFileSync(join(r.d, "relay.queue"), "utf8").trim().split("\n").length).toBe(2);
  });
});
