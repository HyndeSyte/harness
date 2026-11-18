// The snapshot's canonical form: sorted keys at every level, no whitespace. The same rule as
// surface/shared/snapshot.ts, which the exporter signs with; a test here checks a snapshot the
// exporter signed, so the two can't drift apart unnoticed.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    if (out === undefined) throw new Error("canonical: value has no JSON form");
    return out;
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// base64 without atob, which React Native doesn't always have.
export function fromBase64(text: string): Uint8Array {
  const clean = text.trim().replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error("not base64");
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    acc = (acc << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// UTF-8 by hand: TextEncoder is missing from some React Native builds and from jsdom.
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}
