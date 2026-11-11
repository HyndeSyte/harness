// git pre-push hook for a laptop session: refuses a push to any branch this Claude
// Code session doesn't hold in Cain's record (state/holds.json on the record's main,
// fetched fresh for every push). Installed through cain/tools/pre-push; see Cain's
// DOCS.md. It guards against accidents, not against someone set on pushing.
//
//   stdin: <local ref> <local sha> <remote ref> <remote sha>, one line per ref pushed
//   env:   CLAUDE_CODE_SESSION_ID (Claude Code sets it), RECORD_CLONE (a clone of the record)
//
// Dane pushing by hand from a terminal has no session id: git push --no-verify skips it.
import { clone, fetch, holdsAt, sessionOf } from "./record-lib.ts";

const refuse = (why: string): never => { console.error(`push refused: ${why}`); process.exit(1); };
const session = sessionOf(undefined);
if (!session) refuse("no Claude Code session id (CLAUDE_CODE_SESSION_ID). A session pushes only branches it holds in the record; Dane pushing by hand can use git push --no-verify.");
const c = clone(process.env.RECORD_CLONE);
if ("error" in c) refuse(`who holds what couldn't be read: ${c.error}`);
const rec = c as Exclude<typeof c, { error: string }>;
if (!fetch(rec)) refuse("who holds what couldn't be read: fetching the record failed");

const holds = holdsAt(rec);
const me = `laptop:${session}`;
const mine = new Set(Object.values(holds).filter((h) => h.holder === me).flatMap((h) => h.branches));
const problems: string[] = [];
for (const line of (await Bun.stdin.text()).split("\n")) {
  const remoteRef = line.trim().split(/\s+/)[2];
  if (!remoteRef) continue;
  const branch = remoteRef.startsWith("refs/heads/") ? remoteRef.slice("refs/heads/".length) : null;
  if (!branch) { problems.push(`${remoteRef} isn't a branch; a session pushes only branches it holds`); continue; }
  if (mine.has(branch)) continue;
  const other = Object.entries(holds).find(([, h]) => h.branches.includes(branch));
  problems.push(other ? `${branch} is held with ${other[0]} by ${other[1].holder}` : `${branch} isn't in any hold of this session (${me})`);
}
if (problems.length)
  refuse(`${problems.join("; ")}. A session takes an item only when Dane asks it to, or when it made the item: then take it naming the branch (record-send.ts), and push once the take comes back done.`);
