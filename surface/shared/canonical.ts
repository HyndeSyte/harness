// The snapshot's one canonical form, used by the exporter, the Worker and the app alike
// (the app's Metro config watches this folder). Plain TypeScript with no runtime imports:
// UTF-8 comes from the standard TextEncoder, which Bun, Workers, browsers and Hermes all have.

// Sorted keys at every level, no whitespace. JSON.stringify writes strings and numbers.
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

// The fields the signature covers, in this order of meaning (the canonical form sorts them).
export const SIGNED_FIELDS = ["version", "made_at", "threads", "excluded_rows", "skipped_rows"] as const;

export type SignedFields = { [K in (typeof SIGNED_FIELDS)[number]]: unknown };

// What the signature covers: exactly the signed fields of the snapshot as received.
export function signedBytes(s: SignedFields): Uint8Array {
  const picked: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) picked[k] = s[k];
  return new TextEncoder().encode(canonical(picked));
}

// Cuts text to at most `max` whole characters; a cut text ends in an ellipsis, counted in the
// limit. Where Intl.Segmenter exists a character is a grapheme cluster, so a joiner sequence
// (a family emoji), a flag or a letter with its combining mark is never split; elsewhere it is
// a code point, so a surrogate pair is never split.
export function cutCodePoints(text: string, max: number): string {
  const points = characters(text);
  if (points.length <= max) return text;
  return points.slice(0, max - 1).join("").trimEnd() + "…";
}

function characters(text: string): string[] {
  const Segmenter = (globalThis as any).Intl?.Segmenter;
  if (typeof Segmenter === "function") {
    const out: string[] = [];
    for (const s of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) out.push(s.segment);
    return out;
  }
  return Array.from(text);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += b === undefined ? "=" : ALPHABET[(n >> 6) & 63];
    out += c === undefined ? "=" : ALPHABET[n & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.trim().replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error("not base64");
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    acc = ((acc << 6) | ALPHABET.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
