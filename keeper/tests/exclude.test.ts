// (Keeper 0.1.12) The backup exclusion as the Supervisor applies it: config.yaml's backup_exclude must cover every key path
// Keeper uses in its data folder (the Healthchecks key, its old key, their temporary names, and the backup key store with
// its temporary files) and must not cover the backup check's positive control.
//
// The rule implemented here is the Supervisor's: supervisor/apps/app.py (App._is_excluded_by_filter; supervisor/addons/addon.py
// in earlier releases) builds each file's path as the Supervisor sees it (the App's data folder joined with the path
// relative to it) and tests every pattern with Python's pathlib PurePath.match. For a relative pattern, PurePath.match
// compares the pattern's parts with the path's last parts, right to left, each part by fnmatch (on Linux: case sensitive,
// "*" matching any run of characters within one part, a leading dot included, never a "/"). A pattern with more parts
// than the path doesn't match. A directory that matches is left out with everything under it (securetar's
// atomic_contents_add skips it before walking it), but this test asks more: every file path itself must match.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_EXCLUDE, BACKUP_KEY_SENTINEL, BACKUP_KEY_TMP_PREFIX, BACKUP_KEYS_DIR, CHECK_CONTROL_FILE, KEY_FILE, KEY_TMP_PREFIX, OLD_KEY_FILE, excludedName } from "../rootfs/opt/keeper/core.ts";

// fnmatch for one path part: "*" any run, "?" one character, "[...]" a set; everything else literal.
function fnmatchPart(name: string, pat: string): boolean {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") { const j = pat.indexOf("]", i + 2); if (j < 0) re += "\\["; else { let set = pat.slice(i + 1, j); if (set[0] === "!") set = `^${set.slice(1)}`; re += `[${set.replace(/\\/g, "\\\\")}]`; i = j; } }
    else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s").test(name);
}
// PurePath(path).match(pattern) for a relative pattern (every pattern in backup_exclude is relative).
export function pureMatch(path: string, pattern: string): boolean {
  const parts = path.split("/").filter(Boolean), pats = pattern.split("/").filter(Boolean);
  if (!pats.length || pats.length > parts.length) return false;
  const tail = parts.slice(parts.length - pats.length);
  return pats.every((p, i) => fnmatchPart(tail[i], p));
}
const ORIGIN = "/data/addons/data/0fcc2575_keeper";   // the App's data folder as the Supervisor sees it
const excluded = (patterns: string[], rel: string) => patterns.some((p) => pureMatch(`${ORIGIN}/${rel}`, p));

const config = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
const block = /^backup_exclude:\n((?:\s+- .+\n)+)/m.exec(config)?.[1] ?? "";
const patterns = [...block.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]);

describe("0.1.12 item 2: the exclusion covers the key store, by the Supervisor's own rule", () => {
  test("the rule itself, as PurePath.match answers (right-anchored, part by part)", () => {
    expect(pureMatch("/a/b/hc-key", "hc-key*")).toBe(true);
    expect(pureMatch("/a/b/hc-key", "*/hc-key*")).toBe(true);
    expect(pureMatch("/a/backup-keys/x y", "backup-keys/*")).toBe(true);
    expect(pureMatch("/a/backup-keys/.tmp", "backup-keys/*")).toBe(true);     // fnmatch's "*" takes a leading dot
    expect(pureMatch("/a/backup-keys/x/y", "backup-keys/*")).toBe(false);     // "*" never crosses a "/"
    expect(pureMatch("/a/backup-keys", "backup-keys")).toBe(true);
    expect(pureMatch("/a/xbackup-keys", "backup-keys")).toBe(false);
    expect(pureMatch("x", "a/x")).toBe(false);                                 // more pattern parts than path parts
  });
  test("config.yaml's backup_exclude is the build's own (core.ts BACKUP_EXCLUDE) and names the key store", () => {
    expect(patterns).toEqual(BACKUP_EXCLUDE);
    expect(patterns).toEqual(expect.arrayContaining(["hc-key*", "*/hc-key*", "backup-keys", "backup-keys/*"]));
  });
  test("every key path Keeper uses matches a pattern; the backup check's control doesn't", () => {
    const keyPaths = [
      KEY_FILE, OLD_KEY_FILE, `${KEY_TMP_PREFIX}0a1b2c3d4e5f`, `${KEY_TMP_PREFIX}anything at all`,
      `${KEY_FILE}.1234.abcdefabcdef.tmp`,                                     // the 0.1.7 and 0.1.8 temporary name
      BACKUP_KEYS_DIR,                                                          // the folder itself
      `${BACKUP_KEYS_DIR}/Keeper ship-46-cain-7d7b5f90 0a0b0c0d`,             // a backup's key, named by the backup
      `${BACKUP_KEYS_DIR}/anything`, `${BACKUP_KEYS_DIR}/${BACKUP_KEY_SENTINEL}`,
      `${BACKUP_KEYS_DIR}/${BACKUP_KEY_TMP_PREFIX}0a1b2c3d4e5f`, `${BACKUP_KEYS_DIR}/${BACKUP_KEY_TMP_PREFIX}anything`,
    ];
    for (const p of keyPaths) {
      expect([p, excluded(patterns, p)]).toEqual([p, true]);
      expect([p, patterns.some((x) => pureMatch(p, x))]).toEqual([p, true]);   // and relative to the data folder alone
      expect([p, excludedName(p)]).toEqual([p, true]);                          // core.ts's own check agrees
    }
    for (const p of [CHECK_CONTROL_FILE, "state.json", "options.json", "backup-keys-not", "my-backup-keys.txt"]) {
      expect([p, excluded(patterns, p)]).toEqual([p, false]);
      expect([p, excludedName(p)]).toEqual([p, false]);
    }
  });
  test("without the 0.1.12 patterns the key store would be in Keeper's own backups (the test can fail)", () => {
    const before = ["hc-key*", "*/hc-key*"];
    expect(excluded(before, `${BACKUP_KEYS_DIR}/Keeper ship-46-cain-7d7b5f90 0a0b0c0d`)).toBe(false);
    expect(excluded(before, `${BACKUP_KEYS_DIR}/${BACKUP_KEY_TMP_PREFIX}0a`)).toBe(false);
  });
});
