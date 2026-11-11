// Runs the record keeper's own checks on an inbox request before it is sent, so a
// broken rule (a rewritten decisions.md, a stale base, a used id, a bad path, a note
// without front matter) shows up at once instead of as a rejection minutes later.
// It judges against the record as the keeper will see it: the clone's upstream after
// a fetch, read from git objects, so line endings and a stale checkout don't matter.
//
//   bun cain/tools/record-preflight.ts <request.json> <record clone>
//
// Exit 0 and "ok: ..." means the keeper would apply it as things stand now.
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseRequest, plan, type Tree } from "../rootfs/opt/cain/record/core.ts";

const [file, dir] = process.argv.slice(2);
if (!file || !dir) { console.error("usage: record-preflight <request.json> <record clone>"); process.exit(2); }

const git = (...args: string[]): string | null => {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
};
const finish = (line: string, ok: boolean): never => { console.log(line); process.exit(ok ? 0 : 1); };

if (git("fetch", "-q") === null) finish("not checked: couldn't fetch the record", false);
const ref = "@{u}";
const kind = (p: string) => git("cat-file", "-t", `${ref}:${p}`)?.trim() ?? null;
const read = (p: string) => (kind(p) === "blob" ? git("cat-file", "blob", `${ref}:${p}`) : null);
const tree: Tree = {
  read,
  sha: (p) => (kind(p) === "blob" ? git("rev-parse", `${ref}:${p}`)!.trim() : null),
  isDir: (p) => kind(p) === "tree",
};

// The same order the keeper uses (record/main.ts): size, shape, sender, id, then the plan.
if (statSync(file).size > 1_000_000) finish("rejected: over 1 MB", false);
const { req, error } = parseRequest(readFileSync(file, "utf8"));
if (error || !req) finish(`rejected: ${error}`, false);
if (req!.from === "cain" || req!.id.startsWith("cain-")) finish("rejected: requests in inbox/ can't speak for Cain", false);
const logs = (git("ls-tree", "--name-only", ref, "log/requests/") ?? "").split("\n").filter((n) => n.endsWith(".jsonl"));
for (const f of logs)
  for (const line of (git("cat-file", "blob", `${ref}:${f}`) ?? "").split("\n")) {
    let id: unknown;
    try { id = JSON.parse(line).id; } catch { continue; }
    if (id === req!.id) finish("rejected: an id that was already used", false);
  }
if (req!.kind === "note") finish("ok: a note for Cain", true);
const out = plan(req!, tree);
if (out.state === "ok") finish(`ok: writes ${[...out.writes.keys()].join(", ")}`, true);
finish(`${out.state}: ${out.reason}`, false);
