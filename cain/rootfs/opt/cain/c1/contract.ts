// What may run, and who may call the link, in each of Cain's states (C1 plan 3.12): one table
// that the run script, the link and the tests all read, so the states can't drift apart.
//   A        the old way: Cain as root, as 0.11.0 ran, before the switch
//   B        switching (c1/cutover.sh): the link and Cain's session aren't running
//   C        the new way: Cain as his own user
//   stopped  a damaged or unfinished state: Cain isn't started
// The link's mode is the run script's (LINK_MODE): old in A, own in C, stopped otherwise.
import { lstatSync } from "node:fs";

export type State = "A" | "B" | "C" | "stopped";
export type LinkMode = "old" | "own" | "stopped";

export const RUNS: Record<State, { oldRootSession: boolean; uid1000: "none" | "validation" | "cain"; broker: "none" | "smoke" | "real"; managedFiles: boolean; link: LinkMode | null }> = {
  A: { oldRootSession: true, uid1000: "none", broker: "none", managedFiles: false, link: "old" },
  B: { oldRootSession: false, uid1000: "validation", broker: "smoke", managedFiles: true, link: null },
  C: { oldRootSession: false, uid1000: "cain", broker: "real", managedFiles: true, link: "own" },
  stopped: { oldRootSession: false, uid1000: "none", broker: "none", managedFiles: false, link: "stopped" },
};

// Cain's routes and root's (/sent), as in link/auth.ts; kept here too so this module stands alone.
const CAIN_ROUTES = new Set(["/show", "/ask", "/morning", "/ship", "/answered", "/replied", "/stopped",
  "/look", "/cards", "/check", "/reply", "/key-note", "/replay", "/connector", "/guard-hold", "/review-grant"]);

export interface Asked {
  signed: boolean;        // a signature that verifies with the specialist's key
  relayKey: boolean;      // the old bare header, holding the relay key
  cainKey: boolean;       // Cain's own key
  local: boolean;         // from this machine
  path: string;
}
export type Decision = { caller: "specialist" | "cain" | "root" } | { refuse: 403 | 503 };

// Who the caller is, by the link's mode. The routes each caller may then open are auth.ts's.
export function linkDecides(mode: LinkMode, a: Asked): Decision {
  if (a.signed) return { caller: "specialist" };
  if (a.relayKey) {
    // The relay key opens Cain's routes and /sent from this machine in the old way only (the old
    // root session's keeper.sh and hook). The specialist's bare key: 503, nothing done, always.
    if (mode === "old" && a.local && CAIN_ROUTES.has(a.path)) return { caller: "cain" };
    if (mode === "old" && a.local && a.path === "/sent") return { caller: "root" };
    return { refuse: 503 };
  }
  if (a.cainKey && a.local && mode === "own") return { caller: "cain" };
  return { refuse: 403 };
}

// What section 3.2 lets uid 1000 read (besides the files he owns, which are his): the files
// root writes for him. Everything else readable is a fault, and Cain isn't started.
const ROOT_FOR_HIM = [
  /^\/data\/trust\/[^/]+$/,
  /^\/data\/record\/.+$/,
  /^\/data\/record-outcomes\/[^/]+$/,
  /^\/data\/record-holds\.json$/,
  /^\/data\/review-queue\/[^/]+$/,
  /^\/data\/review-(spend|health|rounds|settings)\.json$/,   // rounds and settings: the round cap's count and the runner's caps (0.16.0)
  /^\/data\/review-(rounds|grants)\.pre-0\.18\.1\.json$/,  // the copies the runner kept before its one-time replay (0.18.1): root:cain 0640, for review.sh sweep-dry-run
  /^\/data\/review-grants\.json$/,                     // the owner's grants of extra review rounds (0.18.0): root:cain 0640, the link writes, he reads
  /^\/data\/review-guard\.log$/,                        // the usage guard's refusals (0.16.0): root:cain 0640, root writes (round 2), he reads
  /^\/data\/review-useful\.jsonl$/,
  /^\/data\/review-private-terms\.txt$/,
  /^\/data\/gate\/[^/]+$/,
  /^\/data\/session\.log$/,
  /^\/data\/discord\/inbox\/[^/]+$/,
  /^\/data\/pc-jobs\/.+$/,                         // the PC job keeper's copy of its queue (no token in it)
  /^\/data\/pc-jobs-outcomes\/[^/]+$/,
  /^\/data\/pc-jobs-reuse-used\.jsonl\.told\.json$/,   // its notice marks; the taps it spent stay root's
  /^\/run\/cain\/keys\/(cain|handover)\.key$/,
  /^\/run\/cain\/(discord\.state|mode)$/,
];
export function readableAllowed(path: string, uid = Number(process.env.C1_CAIN_UID ?? 1000)): boolean {
  try { if (lstatSync(path).uid === uid) return true; } catch { return false; }
  return ROOT_FOR_HIM.some((r) => r.test(path));
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "runs" && a && b && a in RUNS) console.log(String((RUNS as any)[a][b]));
  else { console.error("usage: contract.ts runs <A|B|C|stopped> <oldRootSession|uid1000|broker|managedFiles|link>"); process.exit(2); }
}
