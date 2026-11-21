// Root reading what Cain wrote (rootfs/opt/cain/owned.ts): only a regular file of his user's,
// never through a symlink, never a FIFO that would hang root, never past a size cap.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwned, readOwnedTail } from "../rootfs/opt/cain/owned";

const OWNED = join(import.meta.dir, "../rootfs/opt/cain/owned.ts");
const linux = process.platform === "linux";
const me = typeof process.getuid === "function" ? process.getuid() : 0;
const onLinux = linux ? test : test.skip;
const dir = () => mkdtempSync(join(tmpdir(), "owned-"));

describe("readOwned", () => {
  test("a regular file of his is read whole", () => {
    const f = join(dir(), "req.json");
    writeFileSync(f, '{"id":"cain-1"}');
    expect(readOwned(f, me)).toEqual({ ok: true, text: '{"id":"cain-1"}', size: 15 });
  });

  onLinux("a file another user owns is refused, whatever it holds", () => {
    const f = join(dir(), "req.json");
    writeFileSync(f, "secret");
    expect(readOwned(f, me + 1)).toEqual({ ok: false, why: "not his" });
  });

  onLinux("a symlink is refused, even to a file he could read", () => {
    const d = dir(), target = join(d, "real"), link = join(d, "link");
    writeFileSync(target, "x");
    symlinkSync(target, link);
    expect(readOwned(link, me)).toEqual({ ok: false, why: "symlink" });
  });

  onLinux("a FIFO is refused at once, not waited on", () => {
    const f = join(dir(), "fifo");
    expect(spawnSync("mkfifo", [f]).status).toBe(0);
    const t = Date.now();
    expect(readOwned(f, me)).toEqual({ ok: false, why: "not a file" });
    expect(Date.now() - t).toBeLessThan(2000);
  });

  test("a folder is not a file", () => {
    expect(readOwned(dir(), me).ok).toBe(false);
  });

  test("past the cap, nothing is read", () => {
    const f = join(dir(), "big");
    writeFileSync(f, "y".repeat(100));
    expect(readOwned(f, me, 99)).toEqual({ ok: false, why: "too large" });
    expect(readOwned(f, me, 100).ok).toBe(true);
  });

  test("a missing file says so", () => {
    expect(readOwned(join(dir(), "nope"), me)).toEqual({ ok: false, why: "missing" });
  });
});

describe("readOwnedTail", () => {
  test("the end of a long log, from a whole line", () => {
    const f = join(dir(), "session.log");
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    writeFileSync(f, lines.join("\n") + "\n");
    const r = readOwnedTail(f, me, 64);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text.startsWith("line ")).toBe(true);
      expect(r.text.endsWith("line 1999\n")).toBe(true);
    }
  });

  onLinux("a symlinked log is refused", () => {
    const d = dir(), target = join(d, "real"), link = join(d, "session.log");
    writeFileSync(target, "x\n");
    symlinkSync(target, link);
    expect(readOwnedTail(link, me)).toEqual({ ok: false, why: "symlink" });
  });
});

describe("the command root's shell scripts use", () => {
  const run = (...args: string[]) => spawnSync("bun", [OWNED, ...args], { encoding: "utf8", env: { ...process.env, CAIN_UID: String(me) } });

  test("cat prints a file of his", () => {
    const f = join(dir(), "job");
    writeFileSync(f, "build | a title\n");
    const r = run("cat", f);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("build | a title\n");
  });

  onLinux("cat prints nothing and fails for a symlink", () => {
    const d = dir(), target = join(d, "real"), link = join(d, "job");
    writeFileSync(target, "secret\n");
    symlinkSync(target, link);
    const r = run("cat", link);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  test("tail prints the last lines", () => {
    const f = join(dir(), "log");
    writeFileSync(f, "a\nb\nc\nd\n");
    const r = run("tail", f, "2");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("c\nd\n");
  });
});
