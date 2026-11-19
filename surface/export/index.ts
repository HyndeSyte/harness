#!/usr/bin/env bun
// bun run surface/export --record <record checkout> --private-terms <file> --out <file> --key <Ed25519 private key PEM>
//   [--config <exporter config JSON>] [--strict]
// bun run surface/export --record <record checkout> --private-terms <file> --dry-run [--config <file>]
// bun run surface/export --record ... --key <private key PEM> --put <url> [--out <file>] [--strict]
//   (the Access and publisher values come from SURFACE_ACCESS_CLIENT_ID, SURFACE_ACCESS_CLIENT_SECRET
//   and SURFACE_PUBLISHER_TOKEN, never from flags or files; the URL's host must be SURFACE_PUT_HOST)
// bun run surface/export --record ... --dry-run [--report <file>]   (the private word list goes to <file>, mode 0600)
// bun run surface/export --verify <file> --pub <public key: PEM or raw base64>
// bun run surface/export --key-match --key <private key PEM> --pub <file or comma-separated raw base64 keys>
// bun run surface/export --keygen <dir>   (writes surface.key, surface.pub, surface.pub.b64)

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { parseKeyList, verifySnapshot } from "../shared/snapshot";
import {
  buildSnapshot,
  configProblem,
  keyId,
  leftoverLine,
  leftoverPlace,
  makeKeyPair,
  makePolicy,
  privateKey,
  rawPublicKey,
  signSnapshot,
  snapshotIdOf,
  strictProblems,
  type Built,
  type ExporterConfig,
} from "./lib";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// The private key (PEM), the public key (PEM) and the public key as raw base64.
const KEY_FILES = ["surface.key", "surface.pub", "surface.pub.b64"];

// The upload's three values, each from the environment only.
export const PUT_ENV = ["SURFACE_ACCESS_CLIENT_ID", "SURFACE_ACCESS_CLIENT_SECRET", "SURFACE_PUBLISHER_TOKEN"] as const;
// The one host --put may send to, from the environment.
export const PUT_HOST_ENV = "SURFACE_PUT_HOST";
export const REDIRECTED = "Access redirected: the service token or its Service Auth policy is wrong";
// How much of the Worker's message is printed.
export const MESSAGE_MAX = 200;
// The first line of the dry run's private report file, which holds words from the record.
export const PRIVATE_REPORT =
  "PRIVATE, not for posting or relaying: words from the record (path:row: field: word). Read them on this machine; never paste, send or relay them anywhere, and delete this file when done.";
// The most the Worker takes (worker/src/index.ts MAX_BYTES): a bigger body is refused before sending.
export const PUT_MAX_BYTES = 512 * 1024;
// How many times a lost response is reconciled by sending the same signed bytes again.
export const RECONCILE_TRIES = 3;
// The uploader's exit codes: its own preflight refused (nothing sent), the server refused, or the
// outcome is unknown (the response was lost and reconciling didn't settle it).
export const EXIT_PREFLIGHT = 2;
export const EXIT_REJECTED = 1;
export const EXIT_UNKNOWN = 3;

const USAGE = `usage:
  bun run surface/export --record <record checkout> --private-terms <file> --out <file> --key <private key PEM>
      [--config <exporter config JSON>] [--strict]
  bun run surface/export --record <record checkout> --private-terms <file> --key <private key PEM> --put <url>
      [--out <file>] [--config <exporter config JSON>] [--strict]
      (with SURFACE_PUT_HOST, SURFACE_ACCESS_CLIENT_ID, SURFACE_ACCESS_CLIENT_SECRET and
      SURFACE_PUBLISHER_TOKEN set; --put implies --strict)
  bun run surface/export --record <record checkout> --private-terms <file> --dry-run [--config <file>] [--strict]
      [--report <file>]   (the private word list, written with mode 0600; without it, counts only)
  bun run surface/export --verify <file> --pub <public key file>
  bun run surface/export --key-match --key <private key PEM> --pub <file or comma-separated raw base64 keys>
  bun run surface/export --keygen <dir>`;

export interface IO {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  // Waits between reconciling tries (tests pass one that doesn't wait).
  sleep?: (ms: number) => Promise<void>;
}

const defaultIO: IO = { fetch: (url, init) => fetch(url, init), env: process.env, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// The --put URL's own checks, before any request: https, no credentials in it, its host is
// exactly SURFACE_PUT_HOST, and its path is exactly /snapshot with no query or fragment. Returns a one-line reason, or null.
export function putUrlProblem(raw: string, env: Record<string, string | undefined>): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "--put: not a URL";
  }
  if (u.username || u.password) return "--put: credentials in the URL are refused";
  if (u.protocol !== "https:") return "--put: the URL must be https";
  // Exactly /snapshot: no other path, no query string, no fragment (an empty "?" or "#" included).
  if (u.pathname !== "/snapshot") return "--put: the URL's path must be exactly /snapshot";
  if (u.search || u.hash || raw.includes("?") || raw.includes("#")) return "--put: a query string or fragment in the URL is refused";
  const want = (env[PUT_HOST_ENV] ?? "").trim().toLowerCase();
  if (!want) return `--put needs ${PUT_HOST_ENV} in the environment`;
  if (u.host.toLowerCase() !== want) return `--put: the URL's host is not ${PUT_HOST_ENV}`;
  return null;
}

// Printable, one line, bounded: nothing from the response but the Worker's own JSON message.
const oneLine = (s: string) => s.replace(/[\p{C}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);

// What came of one upload. preflight: refused here, nothing sent. rejected: the server answered
// and refused it (a 4xx, or a redirect from Access). stored: the server answered 2xx with this
// snapshot's identity. unknown: no answer, a 5xx, an answer that can't be read, or a 2xx naming
// another identity; the snapshot may or may not be stored.
export type UploadOutcome =
  | { kind: "preflight"; reason: string }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "stored"; status: number; message: string; id: string }
  | { kind: "unknown"; why: string };

// The uploader's own checks on the body, before anything is sent: its size, and that it verifies
// under its own key with its own identity. Returns a reason, or null.
export async function uploadPreflight(body: string, pub: Uint8Array): Promise<string | null> {
  if (new TextEncoder().encode(body).byteLength > PUT_MAX_BYTES) return `the snapshot is over ${PUT_MAX_BYTES} bytes`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "the snapshot is not JSON";
  }
  if (!(await verifySnapshot(parsed, pub))) return "the snapshot does not verify under its own key";
  return null;
}

// Sends a signed snapshot once: the Access service token's two headers (checked by Access) and the
// publisher header (checked by the Worker). Never follows a redirect, never prints a header.
async function putOnce(url: string, body: string, id: string, io: IO): Promise<UploadOutcome> {
  let res: Response;
  try {
    res = await io.fetch(url, {
      method: "PUT",
      body,
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "CF-Access-Client-Id": io.env.SURFACE_ACCESS_CLIENT_ID!,
        "CF-Access-Client-Secret": io.env.SURFACE_ACCESS_CLIENT_SECRET!,
        "x-surface-publisher": io.env.SURFACE_PUBLISHER_TOKEN!,
      },
    });
  } catch (e: any) {
    return { kind: "unknown", why: `no answer (${oneLine(String(e?.message ?? e))})` };
  }
  if (res.type === "opaqueredirect" || res.redirected || res.status === 0 || (res.status >= 300 && res.status < 400))
    return { kind: "rejected", status: res.status, message: REDIRECTED };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: "unknown", why: `${res.status}, and the answer was cut off` };
  }
  let message = "";
  let gotId: string | undefined;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      message = typeof j.error === "string" ? j.error : typeof j.stored === "string" ? `stored ${j.stored}` : "";
      if (typeof j.id === "string") gotId = j.id;
    }
  } catch {}
  message = oneLine(message);
  if (res.status >= 500) return { kind: "unknown", why: `${res.status}${message ? " " + message : ""}` };
  if (res.status >= 200 && res.status < 300) {
    if (gotId === id) return { kind: "stored", status: res.status, message, id };
    return { kind: "unknown", why: `${res.status}, but the answer names another snapshot` };
  }
  return { kind: "rejected", status: res.status, message };
}

// Uploads, and on an unknown outcome (a lost response) reconciles by the signed identity: the same
// signed bytes are sent again, and the Worker answers with the identity it holds (the same snapshot
// already stored is a 200 naming it). Prints one line per try and a last line naming the outcome.
export async function upload(url: string, body: string, id: string, io: IO): Promise<UploadOutcome> {
  const u = new URL(url);
  const where = `PUT ${u.origin}${u.pathname}`;
  const sleep = io.sleep ?? defaultIO.sleep!;
  let out: UploadOutcome = { kind: "unknown", why: "not sent" };
  for (let i = 0; i < RECONCILE_TRIES; i++) {
    if (i > 0) {
      console.error(`${where}: the outcome is unknown; reconciling by sending the same signed snapshot again (${i + 1} of ${RECONCILE_TRIES})`);
      await sleep(1000 * 2 ** (i - 1));
    }
    out = await putOnce(url, body, id, io);
    if (out.kind === "stored") {
      console.log(`${where}: ${out.status}${out.message ? " " + out.message : ""} (snapshot ${id})`);
      return out;
    }
    if (out.kind === "rejected") {
      console.error(`${where}: ${out.status}${out.message ? " " + out.message : ""}`);
      console.error(`upload: server rejection; nothing stored.`);
      return out;
    }
    console.error(`${where}: ${out.why}`);
  }
  console.error(
    `upload: unknown remote outcome: snapshot ${id} may or may not be stored. Run the same export again later; it reconciles by this identity.`,
  );
  return out;
}

export async function main(args: string[], io: IO = defaultIO): Promise<number> {
  const keygen = arg(args, "--keygen");
  if (keygen) {
    const k = makeKeyPair();
    mkdirSync(keygen, { recursive: true });
    const [privFile, pemFile, rawFile] = KEY_FILES.map((f) => join(keygen, f));
    writeFileSync(privFile, k.privatePem, { mode: 0o600 });
    chmodSync(privFile, 0o600);
    writeFileSync(pemFile, k.publicPem);
    writeFileSync(rawFile, k.publicRaw + "\n");
    console.log(`Wrote a key pair in ${keygen}. The public key (raw, base64), for the app and the Worker:`);
    console.log(k.publicRaw);
    return 0;
  }
  const verify = arg(args, "--verify");
  if (verify) {
    const pub = arg(args, "--pub");
    if (!pub) return (console.error(USAGE), 2);
    const ok = await verifySnapshot(JSON.parse(readFileSync(verify, "utf8")), rawPublicKey(readFileSync(pub, "utf8")));
    console.log(ok ? "verified" : "NOT verified");
    return ok ? 0 : 1;
  }
  if (args.includes("--key-match")) return keyMatch(args);
  const record = arg(args, "--record");
  const out = arg(args, "--out");
  const key = arg(args, "--key");
  const termsFile = arg(args, "--private-terms");
  const configFile = arg(args, "--config");
  const putUrl = arg(args, "--put");
  const dryRun = args.includes("--dry-run");
  const report = arg(args, "--report");
  if (args.includes("--report") && (!report || report.startsWith("--"))) return (console.error(USAGE), 2);
  if (report && !dryRun) return (console.error("--report goes only with --dry-run; nothing written.\n" + USAGE), 2);
  // --put implies --strict: nothing leaves with a malformed row or a capitalised word left.
  const strict = args.includes("--strict") || args.includes("--put");
  // A dry run writes and sends nothing, so --put and --out don't go with it.
  if (dryRun && args.includes("--put")) return (console.error("--put and --dry-run don't go together; nothing sent.\n" + USAGE), 2);
  if (dryRun && args.includes("--out")) return (console.error("--out and --dry-run don't go together; nothing written.\n" + USAGE), 2);
  if (args.includes("--put") && (!putUrl || putUrl.startsWith("--"))) return (console.error(USAGE), 2);
  if (!record || (!dryRun && (!key || (!out && !putUrl)))) return (console.error(USAGE), 2);
  if (putUrl) {
    // Every value the upload needs is checked before anything is read or sent.
    const bad = putUrlProblem(putUrl, io.env);
    if (bad) return (console.error(`${bad}; upload: preflight rejection, nothing sent.`), EXIT_PREFLIGHT);
    const missing = PUT_ENV.filter((k) => !(io.env[k] ?? "").trim());
    if (missing.length) {
      console.error(`--put needs ${missing.join(", ")} in the environment; upload: preflight rejection, nothing sent.`);
      return EXIT_PREFLIGHT;
    }
  }
  // Every check below runs the same in a dry run. Fail closed: no private terms file, or one with
  // no terms, and nothing is written or printed.
  if (!termsFile) return (console.error("--private-terms <file> is required; nothing written.\n" + USAGE), 2);
  if (!existsSync(termsFile)) return (console.error(`${termsFile}: no such private terms file; nothing written.`), 2);
  // The config fails closed too: it must parse, name the owner and carry `names`.
  let config: unknown = {};
  if (configFile) {
    if (!existsSync(configFile)) return (console.error(`${configFile}: no such config file; nothing written.`), 2);
    try {
      config = JSON.parse(readFileSync(configFile, "utf8"));
    } catch {
      return (console.error(`${configFile}: not valid JSON; nothing written.`), 2);
    }
  }
  const problem = configProblem(config, io.env);
  if (problem) return (console.error(`${problem}; nothing written.`), 2);
  let policy;
  try {
    policy = makePolicy(readFileSync(termsFile, "utf8"), config as ExporterConfig, io.env);
  } catch (e: any) {
    console.error(`${String(e?.message ?? e)}; nothing written.`);
    return 2;
  }
  let signingKey;
  if (!dryRun) {
    try {
      signingKey = privateKey(readFileSync(key!, "utf8"));
    } catch {
      return (console.error(`${key}: not a readable Ed25519 private key; nothing written.`), 2);
    }
  }
  // The whole pipeline runs before anything is printed, written or sent.
  let built;
  try {
    built = buildSnapshot(record, policy);
  } catch (e: any) {
    // Never the record's text: only our own message about its shape, or that it couldn't be read.
    const own = /^PENDING\.md has no open table/.test(String(e?.message)) ? String(e.message) : "the record could not be read (state/PENDING.md, state/holds.json or a note)";
    console.error(`${own}; nothing written.`);
    return 1;
  }
  const s = built.snapshot;
  const problems = strictProblems(built);
  if (strict && (problems.warnings.length || problems.leftovers.length || problems.waitsUnknown.length)) {
    for (const w of problems.warnings) console.error("warning: " + w);
    // The field and the row number only, never the word.
    for (const l of problems.leftovers) console.error("capitalised word not on the allow list: " + leftoverPlace(l));
    for (const l of problems.waitsUnknown) console.error("unknown word in waits_for: " + leftoverPlace(l));
    console.error(
      `--strict: ${problems.warnings.length} row warning(s), ${problems.leftovers.length} capitalised word(s) not on the allow list, ` +
        `${problems.waitsUnknown.length} unknown word(s) in waits_for; nothing written.` +
        (problems.leftovers.length || problems.waitsUnknown.length ? " A dry run with --report lists the words privately." : ""),
    );
    return 1;
  }
  for (const w of built.warnings) console.error("warning: " + w);
  if (dryRun) {
    // For the owner to read before the first upload: exactly what would be signed.
    console.log(JSON.stringify(s, null, 2));
    console.error(`Dry run: ${s.threads.length} threads, ${s.excluded_rows} rows left out, ${s.skipped_rows} skipped. Nothing written.`);
    // Per area, the config's areas list being the primary control on what an area may be.
    console.error(`Dry run, threads per area: ${areaLine(built)}.`);
    console.error(
      `Dry run: ${built.leftovers.length} capitalised word(s) replaced, ${built.unknowns.length} lower-case or uncased word(s) not in the word list.`,
    );
    // The words themselves never go to stderr or stdout: only to a private file, on request.
    if (report) {
      try {
        writePrivate(report, reportText(built));
      } catch {
        console.error(`${report}: the private report could not be written; nothing written.`);
        return 2;
      }
      console.error(`Dry run: the private word list is in ${report} (mode 0600). Never relay it.`);
    } else if (built.leftovers.length || built.unknowns.length) {
      console.error("Dry run: pass --report <file> to write the words to a private file (mode 0600).");
    }
    return 0;
  }
  if (built.leftovers.length)
    console.error(`${built.leftovers.length} capitalised word(s) replaced by "someone"; a dry run with --report lists them privately.`);
  const snapshot = signSnapshot(s, signingKey!);
  const body = JSON.stringify(snapshot, null, 2) + "\n";
  // With --put the file is written only once the upload is stored, so a failed run leaves it as it was.
  if (putUrl) {
    const own = rawPublicKey(createPublicKey(signingKey!).export({ format: "pem", type: "spki" }).toString());
    const pre = await uploadPreflight(body, own);
    if (pre) {
      console.error(`--put: ${pre}; upload: preflight rejection, nothing sent.`);
      return EXIT_PREFLIGHT;
    }
    const result = await upload(putUrl, body, snapshotIdOf(s), io);
    if (result.kind === "rejected") return EXIT_REJECTED;
    if (result.kind !== "stored") return EXIT_UNKNOWN;
  }
  if (out) {
    writeWhole(out, body);
    console.log(`Wrote ${snapshot.threads.length} threads to ${out} (${s.excluded_rows} left out, ${s.skipped_rows} skipped).`);
  }
  return 0;
}

// "surface 2, garden 1, other 5": the exported threads per area.
export function areaLine(b: Built): string {
  const parts = Object.entries(b.areas)
    .sort(([a], [b2]) => (a === "other" ? 1 : b2 === "other" ? -1 : a.localeCompare(b2)))
    .map(([a, n]) => `${a} ${n}`);
  return parts.length ? parts.join(", ") : "none";
}

// The dry run's private report: the warning line, then each word with its place.
export function reportText(b: Built): string {
  const lines = [PRIVATE_REPORT, "", `threads per area: ${areaLine(b)}`, "", "capitalised words the gate replaced:"];
  for (const l of b.leftovers) lines.push(leftoverLine(l));
  lines.push("", "lower-case or uncased words not in the word list:");
  for (const l of b.unknowns) lines.push(leftoverLine(l));
  return lines.join("\n") + "\n";
}

// Written with mode 0600 from the moment it exists: a new temporary file beside it (created
// exclusively, so nothing is written through a link), then renamed over the path.
export function writePrivate(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Prints the private key's key id and whether it is among the given public keys (the Worker's
// SNAPSHOT_PUBLIC_KEYS and the app's EXPO_PUBLIC_SURFACE_PUBLIC_KEY): exit 0 if it is, 1 if not.
function keyMatch(args: string[]): number {
  const key = arg(args, "--key");
  const pub = arg(args, "--pub");
  if (!key || !pub) return (console.error(USAGE), 2);
  let mine: string;
  try {
    const k = privateKey(readFileSync(key, "utf8"));
    mine = keyId(rawPublicKey(createPublicKey(k).export({ format: "pem", type: "spki" }).toString()));
  } catch {
    return (console.error(`${key}: not a readable Ed25519 private key`), 2);
  }
  const text = existsSync(pub) ? readFileSync(pub, "utf8") : pub;
  const listed = text.includes("BEGIN") ? [rawPublicKey(text)] : parseKeyList(text.replace(/\s+/g, ","));
  const ids = listed.map(keyId);
  console.log(`exporter key ${mine}; listed: ${ids.join(", ") || "none"}`);
  if (ids.includes(mine)) return (console.log("key match: the exporter's key is listed"), 0);
  console.error("key match: the exporter's key is NOT listed");
  return 1;
}

// Written whole or not at all: a temporary file beside it, then a rename.
function writeWhole(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    },
  );
}
