// For the tests: a record in a temporary folder holding only the open rows given; the fixture record
// without the rows the signer refuses; and a record made a git checkout with an upstream branch.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempRecord(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "surface-record-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  const head =
    "| ID | Item | Who | Next step | Waits for | Done when | Since |\n|----|------|-----|-----------|-----------|-----------|-------|\n";
  writeFileSync(join(dir, "state", "PENDING.md"), "# Pending\n\n" + head + rows.join("\n") + "\n");
  return dir;
}

// The fixture record copied, without its rows that hold an unknown lower-case or uncased word (the
// strict corpus marks them "unknown"): since the eighth round the signer refuses such a word whatever
// the flags, so a plain export of the whole fixture can't be signed. Every other row stays (the
// excluded and skipped rows, and the capitalised words the gate replaces).
export function signableRecord(): string {
  const fix = import.meta.dir;
  const corpus: Record<string, string> = JSON.parse(readFileSync(join(fix, "strict-corpus.json"), "utf8"));
  const drop = new Set(Object.entries(corpus).filter(([, v]) => v.includes("unknown")).map(([k]) => k));
  const dir = mkdtempSync(join(tmpdir(), "surface-signable-"));
  cpSync(join(fix, "record"), dir, { recursive: true });
  const p = join(dir, "state", "PENDING.md");
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => {
    const id = /^\|\s*([A-Za-z]{1,3}\d+)\s*\|/.exec(l)?.[1];
    return !id || !drop.has(id);
  });
  writeFileSync(p, lines.join("\n"));
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

// Makes a record folder a git checkout whose branch tracks an upstream (a bare repository beside it)
// at its tip, so the exporter can sign a revision. Returns the folder.
export function gitRecord(dir: string): string {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "record");
  const bare = mkdtempSync(join(tmpdir(), "surface-upstream-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  return dir;
}
// A copy of a record folder as a git checkout with an upstream (gitRecord).
export function gitRecordFrom(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), "surface-gitrecord-"));
  cpSync(src, dir, { recursive: true });
  return gitRecord(dir);
}
export { git as gitIn };
