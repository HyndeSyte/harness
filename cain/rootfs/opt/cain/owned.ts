// Root reading a file Cain wrote (C1). Cain runs as his own user; root's services read what
// he leaves for them (his record and review requests, his job markers, his session log, his
// transcripts). Read naively, a path he controls could be a symlink to a root file, and root
// would read the key for him. readOwned opens without following a final symlink, then
// checks the file it actually opened: a regular file owned by his user. A file he owns holds
// only what he could write, so nothing root keeps from him can come back through it; a hard
// link to a root file is owned by root and is refused (and the kernel's protected_hardlinks
// stops him making one). Only the opened descriptor is trusted, so a swap between the check
// and the read changes nothing.
//
//   bun owned.ts cat <path> [maxBytes]    print a file he owns, or exit 1 with nothing printed
//   bun owned.ts tail <path> <lines>      its last lines (at most 64 KB read)
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const CAIN_UID = Number(process.env.CAIN_UID ?? 1000);
export const MAX_DEFAULT = 1 << 20;

// O_NOFOLLOW refuses a final symlink; O_NONBLOCK keeps a FIFO he planted from hanging root.
// Both are 0 where the platform has no such flag (Windows, in local tests only).
const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// What a read found: the text, or why there's none.
export type Owned = { ok: true; text: string; size: number } | { ok: false; why: "missing" | "symlink" | "not a file" | "not his" | "too large" | "unreadable" };

function openOwned(path: string, uid: number): { fd: number; size: number } | Exclude<Owned, { ok: true }> {
  let fd: number;
  try { fd = openSync(path, FLAGS); }
  catch (e: any) {
    if (e?.code === "ENOENT") return { ok: false, why: "missing" };
    if (e?.code === "ELOOP") return { ok: false, why: "symlink" };
    return { ok: false, why: "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) { closeSync(fd); return { ok: false, why: "not a file" }; }
    if (st.uid !== uid) { closeSync(fd); return { ok: false, why: "not his" }; }
    return { fd, size: st.size };
  } catch { try { closeSync(fd); } catch { /* closed */ } return { ok: false, why: "unreadable" }; }
}

// An open descriptor on a regular file of uid's, for streaming it (the caller closes it), or null.
export function openOwnedFd(path: string, uid = CAIN_UID): { fd: number; size: number } | null {
  const o = openOwned(path, uid);
  return "fd" in o ? o : null;
}

function readRange(fd: number, from: number, length: number): string {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, from + off);
    if (n <= 0) break;
    off += n;
  }
  return buf.subarray(0, off).toString("utf8");
}

// The whole file, if it's a regular file owned by uid and no larger than maxBytes.
export function readOwned(path: string, uid = CAIN_UID, maxBytes = MAX_DEFAULT): Owned {
  const o = openOwned(path, uid);
  if (!("fd" in o)) return o;
  try {
    if (o.size > maxBytes) return { ok: false, why: "too large" };
    return { ok: true, text: readRange(o.fd, 0, o.size), size: o.size };
  } catch { return { ok: false, why: "unreadable" }; }
  finally { try { closeSync(o.fd); } catch { /* closed */ } }
}

// The end of such a file: its last maxBytes at most, starting at a line.
export function readOwnedTail(path: string, uid = CAIN_UID, maxBytes = 64 * 1024): Owned {
  const o = openOwned(path, uid);
  if (!("fd" in o)) return o;
  try {
    const from = Math.max(0, o.size - maxBytes);
    let text = readRange(o.fd, from, o.size - from);
    if (from > 0) { const nl = text.indexOf("\n"); text = nl >= 0 ? text.slice(nl + 1) : ""; }
    return { ok: true, text, size: o.size };
  } catch { return { ok: false, why: "unreadable" }; }
  finally { try { closeSync(o.fd); } catch { /* closed */ } }
}

if (import.meta.main) {
  const [cmd, path, n] = process.argv.slice(2);
  if (cmd === "cat" && path) {
    const r = readOwned(path, CAIN_UID, Number(n) > 0 ? Number(n) : MAX_DEFAULT);
    if (!r.ok) process.exit(1);
    process.stdout.write(r.text);
  } else if (cmd === "tail" && path) {
    const r = readOwnedTail(path);
    if (!r.ok) process.exit(1);
    const lines = r.text.replace(/\n$/, "").split("\n");
    process.stdout.write(lines.slice(-Math.max(1, Number(n) || 20)).join("\n") + "\n");
  } else {
    console.error("usage: owned.ts cat <path> [maxBytes] | tail <path> <lines>");
    process.exit(2);
  }
}
