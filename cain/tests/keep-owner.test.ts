// Cain 0.13.5: the keepers' rewrites keep a file's owner, group and mode. On Nov 19, the first
// day Cain ran as his own user, lock.sh set /data/record-holds.json root:cain 0640, the record
// keeper's next rewrite made a fresh file under umask 027 (root:root 0640), and his RemoteTrigger
// hook could no longer read the holds: every Build and Ship run of his was refused.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../rootfs/opt/cain/record/main.ts";
import { reviewFile, saveReview } from "../rootfs/opt/cain/review/runner.ts";

const posix = process.platform !== "win32";

function underUmask<T>(mask: number, f: () => T): T {
  const before = process.umask(mask);
  try { return f(); } finally { process.umask(before); }
}

describe("a keeper's rewrite keeps the file's owner, group and mode", () => {
  test.skipIf(!posix)("the record keeper's holds copy stays readable by his group", () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-owner-"));
    const file = join(dir, "record-holds.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o640);
    const before = statSync(file);
    underUmask(0o077, () => writeAtomic(file, JSON.stringify({ holds: { P1: { holder: "cain", branches: [] } } })));
    const after = statSync(file);
    expect(after.mode & 0o777).toBe(0o640);          // under umask 077 a fresh file would be 0600
    expect(after.gid).toBe(before.gid);
    expect(after.uid).toBe(before.uid);
    expect(JSON.parse(readFileSync(file, "utf8")).holds.P1.holder).toBe("cain");
  });

  test.skipIf(!posix)("a new file is written as before", () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-owner-"));
    const file = join(dir, "new.json");
    underUmask(0o027, () => writeAtomic(file, "{}"));
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  test.skipIf(!posix)("the review runner keeps a review file's group and mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-owner-"));
    const review = { id: "keep-owner-1", topic: "t", question: "q", body: "b", status: "done" } as any;
    const file = reviewFile(dir, review.id);
    writeFileSync(file, "{}");
    chmodSync(file, 0o660);
    const before = statSync(file);
    saveReview(dir, review);
    const after = statSync(file);
    expect(after.mode & 0o777).toBe(0o660);
    expect(after.gid).toBe(before.gid);
    expect(JSON.parse(readFileSync(file, "utf8")).id).toBe("keep-owner-1");
  });
});
