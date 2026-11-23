// (Keeper 0.1.9) The backup check's scan: a Home Assistant backup archive (an outer tar holding backup.json and one
// "<slug>.tar.gz" per App, unencrypted when made without a password) read member by member, nested tars and gzip
// opened, every member's name checked against the key file names and every member's bytes searched for the needles
// (the key values, their fingerprints, the sentinel). Pure: core.ts and the tests call it with bytes.
import { gunzipSync } from "node:zlib";

export interface ScanResult { ok: boolean; why: string; members: number; names: string[]; found: string[] }

function* tarMembers(buf: Uint8Array): Generator<{ name: string; data: Uint8Array }> {
  let off = 0, longName = "";
  const dec = new TextDecoder();
  const str = (a: number, n: number) => { const b = buf.subarray(a, a + n); const z = b.indexOf(0); return dec.decode(z >= 0 ? b.subarray(0, z) : b); };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("a tar header's size can't be read");
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(off + 345, 155);
    let name = longName || (prefix ? `${prefix}/${str(off, 100)}` : str(off, 100));
    longName = "";
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = dec.decode(data).replace(/\0+$/, ""); continue; }
    if (type === "x" || type === "g") {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(data));
      if (m && type === "x") longName = m[1];
      continue;
    }
    yield { name, data };
  }
}
const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const isTar = (b: Uint8Array) => b.length >= 512 && new TextDecoder().decode(b.subarray(257, 262)) === "ustar";

// names: a member whose path matches is a finding; needles: any found in a member's bytes (or its name) is a finding.
export function scanBackup(bytes: Uint8Array, names: RegExp, needles: string[]): ScanResult {
  const found: string[] = [], seen: string[] = [];
  let members = 0;
  const enc = new TextEncoder();
  const pats = needles.filter((n) => n.length >= 8).map((n) => ({ n, b: Buffer.from(enc.encode(n)) }));
  const walk = (buf: Uint8Array, where: string, depth: number) => {
    if (depth > 4) throw new Error("the archive nests too deep");
    let b = buf;
    if (isGzip(b)) b = gunzipSync(b);
    if (!isTar(b)) {
      const B = Buffer.from(b.buffer, b.byteOffset, b.length);
      for (const p of pats) if (B.includes(p.b)) found.push(`${where || "the archive"} holds a key value, a key's fingerprint or the sentinel`);
      return;
    }
    for (const m of tarMembers(b)) {
      members++;
      const path = `${where}${where ? ":" : ""}${m.name}`;
      seen.push(path);
      if (names.test(m.name.replace(/^\.\//, ""))) found.push(`${path} is a key file's name`);
      walk(m.data, path, depth + 1);
    }
  };
  try { walk(bytes, "", 0); } catch (e) { return { ok: false, why: `the backup couldn't be read: ${String((e as Error)?.message ?? e).slice(0, 80)}`, members, names: seen, found }; }
  if (!members) return { ok: false, why: "the backup holds no files Keeper could read", members, names: seen, found };
  if (found.length) return { ok: false, why: `the backup holds key material: ${[...new Set(found)].slice(0, 5).join("; ")}`, members, names: seen, found };
  return { ok: true, why: "", members, names: seen, found };
}
