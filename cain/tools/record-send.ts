// Sends a request to Cain's record keeper from a laptop session and waits for what
// happened to it. It stamps who sent it (from: laptop:<session id>), runs the
// keeper's own checks first (record-preflight) and sends nothing they'd turn away,
// puts it in the record's inbox as <UTC>-<session>-<random>.json, then watches
// log/requests for its outcome, up to 3 minutes, and prints it. Act on a hold only
// once its take has printed "done".
//
//   bun cain/tools/record-send.ts <request.json> [--record <clone>] [--session <id>] [--wait <seconds>]
//   bun cain/tools/record-send.ts --row <item> [--record <clone>]
//       prints an open row's base (the hash a row edit needs), then the row
//
// The clone of the record comes from RECORD_CLONE and the session from
// CLAUDE_CODE_SESSION_ID (Claude Code sets it in every Bash command), unless given.
// Exit: 0 done; 1 refused, conflict or rejected, or not sent; 2 usage; 3 still waiting.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { clean, openRow, rowHash, PENDING_PATH, type Outcome } from "../rootfs/opt/cain/record/core.ts";
import { args, check, clone, fetch, send, sessionOf, treeAt, waitFor } from "./record-lib.ts";

const a = args(process.argv.slice(2), ["record", "session", "wait", "row"]);
const stop = (line: string, code: number): never => { console.log(line); process.exit(code); };
const c = clone(a.record ?? process.env.RECORD_CLONE);
if ("error" in c) stop(c.error, 2);
const rec = c as Exclude<typeof c, { error: string }>;

if (a.row) {
  if (!fetch(rec)) stop("couldn't fetch the record", 1);
  const line = openRow(treeAt(rec).read(PENDING_PATH), a.row);
  if (line === null) stop(`${a.row}: no single open row in ${PENDING_PATH}`, 1);
  stop(`${rowHash(line!)}\n${line}`, 0);
}

const session = sessionOf(a.session);
if (!session) stop("no session id: run this from a Claude Code session (CLAUDE_CODE_SESSION_ID), or pass --session <id>", 2);
const file = a._[0];
if (!file) stop("usage: record-send <request.json> [--record <clone>] [--session <id>] [--wait <seconds>] | --row <item>", 2);
let req: any;
try { req = JSON.parse(readFileSync(file, "utf8")); } catch { stop("not sent: the request isn't JSON", 1); }
if (!req || typeof req !== "object" || Array.isArray(req)) stop("not sent: the request isn't a JSON object", 1);

// Who sent it is the tool's to say, not the request's.
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const rand = randomBytes(3).toString("hex");
req.from = `laptop:${session}`;
if (typeof req.id !== "string" || !req.id) req.id = `laptop-${stamp}-${session!.slice(0, 8)}-${rand}`;
const raw = JSON.stringify(req, null, 1) + "\n";

if (!fetch(rec)) stop("not sent: couldn't fetch the record", 1);
const r = check(raw, rec);
if (r.state !== "ok" && r.state !== "waiting") stop(`not sent: ${r.line}`, 1);
const name = `${stamp}-${session}-${rand}.json`;
const s = send(rec, name, raw, `Inbox: ${clean(req.summary, 120)} (${req.id})`);
if ("error" in s) stop(`not sent: ${s.error}`, 1);
console.log(`sent ${req.id} as inbox/${name}`);

const said = (o: Outcome) => `${o.state}${o.reason ? `: ${o.reason}` : ""}`;
const waitS = Number(a.wait ?? 180);
const seen = await waitFor(rec, req.id, waitS * 1000, (o) => console.log(`${said(o)}. Don't act on it until it says done.`));
const last = seen[seen.length - 1];
if (!last) stop(`no outcome yet after ${waitS} seconds; it's in the inbox, and the keeper reads the inbox every minute`, 3);
if (last!.state === "waiting") stop(`still waiting after ${waitS} seconds; its outcome will be in log/requests (record-holds.ts shows it)`, 3);
stop(said(last!), last!.state === "done" || last!.state === "relayed" ? 0 : 1);
