// Runs the record keeper's own checks on an inbox request before it is sent, so a
// broken rule (a rewritten decisions.md, a stale base, a used id, a bad path, a note
// without front matter, an item someone else holds) shows up at once instead of as
// a rejection minutes later. It judges against the record as the keeper will see it:
// the clone's upstream after a fetch, read from git objects, so line endings and a
// stale checkout don't matter. record-send.ts runs the same checks before it sends.
//
//   bun cain/tools/record-preflight.ts <request.json> <record clone>
//
// Exit 0 and "ok: ..." means the keeper would apply it as things stand now; 3 and
// "waiting: ..." means it would wait behind one of Cain's running jobs.
import { readFileSync } from "node:fs";
import { check, clone, fetch } from "./record-lib.ts";

const [file, dir] = process.argv.slice(2);
if (!file || !dir) { console.error("usage: record-preflight <request.json> <record clone>"); process.exit(2); }

const c = clone(dir);
if ("error" in c) { console.log(`not checked: ${c.error}`); process.exit(1); }
if (!fetch(c)) { console.log("not checked: couldn't fetch the record"); process.exit(1); }
const r = check(readFileSync(file, "utf8"), c);
console.log(r.line);
process.exit(r.state === "ok" ? 0 : r.state === "waiting" ? 3 : 1);
