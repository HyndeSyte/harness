// For the tests: a record in a temporary folder holding only the open rows given.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
