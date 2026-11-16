// The link's landing ledger (0.12.0): one file per Ship tap's idempotency key under
// /data/record-landings, made with an exclusive create, so a tap's landing starts at most once.
// It is the link's alone: the record keeper never writes, reads or cleans this directory.
//
// - claim: the key's file is created exclusively, then the file and the directory are fsynced,
//   before the link's first push attempt for that tap. true the first time, false ever after,
//   null when the ledger can't be written or isn't trusted yet (no landing starts then).
// - settle: once a landing is settled (landed, or not landed), the key's file says so, written
//   whole and fsynced. A settled key is pruned by the link after the retention window
//   (LANDING_KEEP_MS, 30 days); an unsettled one is never pruned.
// - restore: the link keeps a marker outside the ledger (/data/link/landings-marker.json) with the
//   ledger's id and how many keys it has claimed. A ledger whose id differs, whose count is behind
//   the marker's (or the link's state's), or that is missing while the marker isn't, came back
//   from a backup: it isn't trusted (claims answer null) until each of its keys was looked for on
//   the remote main by its head (the landing's token), and settled by what the remote said.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export const LANDING_KEEP_MS = 30 * 86_400_000;
const META = ".ledger.json";

export interface LandingEntry { key: string; pr: string; head: string; at: string; settled?: { how: "landed" | "not landed"; at: string } }
export interface Landings {
  claim(key: string, what: { pr: string; head: string; at: string }): boolean | null;
  settle(key: string, how: "landed" | "not landed", at: string): void;
  entries(): LandingEntry[] | null;
  prune(now: number, keepMs?: number): number;
  // Why the ledger isn't trusted (it came back from a backup), or null when it is.
  untrusted(stateCount?: number): string | null;
  trust(): void;
  count(): number;                // how many keys the ledger has claimed (the link keeps it in its state too)
}

export function keyName(key: string): string { return createHash("sha256").update(key).digest("hex").slice(0, 32); }

// sync: the tests' hook, told of each fsync (the file, then its directory) in order.
export function landingLedger(dir: string, marker: string, o: { sync?: (what: string) => void; log?: (line: string) => void } = {}): Landings {
  const log = o.log ?? (() => {});
  const fsyncPath = (p: string, what: string) => {
    const fd = openSync(p, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    o.sync?.(what);
  };
  const writeDurable = (file: string, text: string) => {
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w");
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    fsyncPath(dirname(file), "dir");
  };
  const readJson = (f: string): any => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
  const meta = (): { id: string; count: number } | null => {
    const j = readJson(join(dir, META));
    return j && typeof j.id === "string" && Number.isInteger(j.count) ? { id: j.id, count: j.count } : null;
  };
  const mark = (): { id: string; count: number } | null => {
    const j = readJson(marker);
    return j && typeof j.id === "string" && Number.isInteger(j.count) ? { id: j.id, count: j.count } : null;
  };
  let trusted: boolean | null = null;   // decided once per process, after a restore once every key was looked for
  const api: Landings = {
    claim(key, what) {
      try {
        if (api.untrusted() !== null) { log("the landing ledger came back from a backup and isn't trusted yet: no landing starts"); return null; }
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${keyName(key)}.json`);
        let fd: number;
        try { fd = openSync(file, "wx"); }
        catch (e: any) {
          if (e?.code === "EEXIST") { log(`landing for tap key ${keyName(key).slice(0, 12)} rejected: one already started for it`); return false; }
          throw e;
        }
        try { writeSync(fd, JSON.stringify({ key, ...what }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
        o.sync?.("file");
        fsyncPath(dir, "dir");
        // The count, in the ledger and in the marker outside it, both durable.
        const m = meta() ?? { id: randomBytes(8).toString("hex"), count: 0 };
        const next = { id: m.id, count: m.count + 1 };
        writeDurable(join(dir, META), JSON.stringify(next) + "\n");
        mkdirSync(dirname(marker), { recursive: true });
        writeDurable(marker, JSON.stringify(next) + "\n");
        return true;
      } catch (e: any) {
        log(`couldn't write the landing ledger (${String(e?.message ?? e).slice(0, 80)}); no landing starts`);
        return null;
      }
    },
    settle(key, how, at) {
      const file = join(dir, `${keyName(key)}.json`);
      const j = readJson(file);
      if (!j || j.settled) return;
      try { writeDurable(file, JSON.stringify({ ...j, settled: { how, at } }) + "\n"); }
      catch (e: any) { log(`couldn't mark landing ${keyName(key).slice(0, 12)} settled: ${String(e?.message ?? e).slice(0, 80)}`); }
    },
    entries() {
      if (!existsSync(dir)) return [];
      try {
        const out: LandingEntry[] = [];
        for (const n of readdirSync(dir).filter((x) => /^[0-9a-f]{32}\.json$/.test(x))) {
          const j = readJson(join(dir, n));
          if (j && typeof j.key === "string" && typeof j.pr === "string" && typeof j.head === "string") out.push(j);
        }
        return out;
      } catch { return null; }
    },
    prune(now, keepMs = LANDING_KEEP_MS) {
      let n = 0;
      for (const e of api.entries() ?? []) {
        const at = e.settled ? Date.parse(e.settled.at) : NaN;
        if (!Number.isFinite(at) || now - at < keepMs) continue;
        try { rmSync(join(dir, `${keyName(e.key)}.json`), { force: true }); n++; } catch { /* the next sweep tries again */ }
      }
      if (n) log(`pruned ${n} settled landing key(s) older than ${Math.round(keepMs / 86_400_000)} days from the landing ledger`);
      return n;
    },
    untrusted(stateCount) {
      if (trusted === true) return null;
      const m = meta(), k = mark();
      let why: string | null = null;
      if (k && !m) why = "the ledger is missing while the link's marker isn't";
      else if (k && m && k.id !== m.id) why = "the ledger's id isn't the one the link's marker holds";
      else if (k && m && m.count < k.count) why = `the ledger has ${m.count} claims, behind the ${k.count} the link's marker holds`;
      else if (stateCount !== undefined && stateCount > (m?.count ?? 0)) why = `the ledger has ${m?.count ?? 0} claims, behind the ${stateCount} the link's state holds`;
      if (!why) { trusted = true; return null; }
      return why;
    },
    trust() {
      const m = meta() ?? { id: randomBytes(8).toString("hex"), count: 0 };
      const k = mark();
      const next = { id: m.id, count: Math.max(m.count, k?.count ?? 0) };
      try {
        mkdirSync(dir, { recursive: true });
        writeDurable(join(dir, META), JSON.stringify(next) + "\n");
        mkdirSync(dirname(marker), { recursive: true });
        writeDurable(marker, JSON.stringify(next) + "\n");
        trusted = true;
      } catch (e: any) { log(`couldn't mark the landing ledger trusted: ${String(e?.message ?? e).slice(0, 80)}`); }
    },
    count() { return meta()?.count ?? 0; },
  };
  return api;
}
