#!/usr/bin/env bun
// bun run surface/export --record <record checkout> --private-terms <file> --out <file> --key <Ed25519 private key PEM>
//   [--config <exporter config JSON>] [--strict]
// bun run surface/export --record <record checkout> --private-terms <file> --dry-run [--config <file>]
// bun run surface/export --record ... --key <private key PEM> --put <url> [--out <file>] [--strict]
//   (the Access and publisher values come from SURFACE_ACCESS_CLIENT_ID, SURFACE_ACCESS_CLIENT_SECRET
//   and SURFACE_PUBLISHER_TOKEN, never from flags or files; the URL's host must be SURFACE_PUT_HOST)
// bun run surface/export --record ... --dry-run [--key <private key PEM>] [--report [<file>]]
//   (the private word list goes to <file>, mode 0600, outside any git work tree; with --key it prints
//   the approval digest --put needs)
// bun run surface/export --record ... --key ... --put <url> --made-at <time> --approve <digest>
// bun run surface/export --verify <file> --pub <public key: PEM, raw base64, or a key list>
// bun run surface/export --key-match --key <private key PEM> --pub <file or key list>
// bun run surface/export --keygen <dir>   (writes surface.key, surface.pub, surface.pub.b64, surface.pub.entry)

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createPublicKey, randomBytes } from "node:crypto";
import { isIsoTime } from "../shared/canonical";
import { keyList, verifyVerdict, type KeyEntry } from "../shared/snapshot";
import {
  buildSnapshot,
  configProblem,
  keyId,
  keyIdOfPrivate,
  leftoverLine,
  leftoverPlace,
  makeKeyPair,
  makePolicy,
  privateKey,
  rawPublicKey,
  recordRevision,
  signSnapshot,
  snapshotIdOf,
  strictProblems,
  withKeyId,
  type Built,
  type ExporterConfig,
} from "./lib";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// The private key (PEM), the public key (PEM), the public key as raw base64, and its key-list entry
// (`<key id>:<raw base64>`, what the Worker's and the app's key lists hold).
const KEY_FILES = ["surface.key", "surface.pub", "surface.pub.b64", "surface.pub.entry"];
// The dry run's report file when --report names none: in the home folder (refused, like any path,
// when that is inside a git work tree). surface/.gitignore lists the name and the temporary files.
export const DEFAULT_REPORT = "surface-dry-run.private.txt";

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
// The most the Worker takes (worker/src/worker.ts MAX_BYTES): a bigger body is refused before sending.
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
      [--config <exporter config JSON>] [--strict] [--made-at <time>]
  bun run surface/export --record <record checkout> --private-terms <file> --key <private key PEM> --put <url>
      --made-at <time> --approve <digest> [--out <file>] [--config <exporter config JSON>]
      (with SURFACE_PUT_HOST, SURFACE_ACCESS_CLIENT_ID, SURFACE_ACCESS_CLIENT_SECRET and
      SURFACE_PUBLISHER_TOKEN set; --put implies --strict; the time and digest are the dry run's)
  bun run surface/export --record <record checkout> --private-terms <file> --dry-run [--config <file>] [--strict]
      [--key <private key PEM>]   (prints the approval digest --put needs)
      [--report [<file>]]   (the private word list, mode 0600, outside any git work tree; without a
      file, ~/${DEFAULT_REPORT}; without --report, counts only)
  bun run surface/export --verify <file> --pub <public key: PEM, raw base64 or a key list>
  bun run surface/export --key-match --key <private key PEM> --pub <file or key list>
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
export async function uploadPreflight(body: string, pub: KeyEntry): Promise<string | null> {
  if (new TextEncoder().encode(body).byteLength > PUT_MAX_BYTES) return `the snapshot is over ${PUT_MAX_BYTES} bytes`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "the snapshot is not JSON";
  }
  if ((await verifyVerdict(parsed, [pub])) !== "ok") return "the snapshot does not verify under its own key";
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
  } catch (e) {
    return { kind: "unknown", why: `no answer (${oneLine(e instanceof Error ? e.message : String(e))})` };
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

// A flag's value, or undefined when the flag is missing; "" when it is there with no value.
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
}

export async function main(args: string[], io: IO = defaultIO): Promise<number> {
  const keygen = arg(args, "--keygen");
  if (keygen) {
    const k = makeKeyPair();
    mkdirSync(keygen, { recursive: true });
    const [privFile, pemFile, rawFile, entryFile] = KEY_FILES.map((f) => join(keygen, f));
    writeFileSync(privFile, k.privatePem, { mode: 0o600 });
    chmodSync(privFile, 0o600);
    writeFileSync(pemFile, k.publicPem);
    writeFileSync(rawFile, k.publicRaw + "\n");
    writeFileSync(entryFile, k.publicEntry + "\n");
    console.log(`Wrote a key pair in ${keygen}. Its key-list entry (key id and raw public key), for the app and the Worker:`);
    console.log(k.publicEntry);
    return 0;
  }
  const verify = arg(args, "--verify");
  if (verify) {
    const pub = arg(args, "--pub");
    if (!pub) return (console.error(USAGE), 2);
    const keys = await keysFrom(existsSync(pub) ? readFileSync(pub, "utf8") : pub);
    if (!keys) return (console.error(`${pub}: not a public key or a key list`), 2);
    const verdict = await verifyVerdict(JSON.parse(readFileSync(verify, "utf8")), keys);
    console.log(verdict === "ok" ? "verified" : verdict === "retired" ? "NOT verified: signed by a retired key" : "NOT verified");
    return verdict === "ok" ? 0 : 1;
  }
  if (args.includes("--key-match")) return keyMatch(args);
  const record = arg(args, "--record");
  const out = arg(args, "--out");
  const key = arg(args, "--key");
  const termsFile = arg(args, "--private-terms");
  const configFile = arg(args, "--config");
  const putUrl = arg(args, "--put");
  const dryRun = args.includes("--dry-run");
  const reportFlag = flagValue(args, "--report");
  const madeAtFlag = flagValue(args, "--made-at");
  const approve = flagValue(args, "--approve");
  if (reportFlag !== undefined && !dryRun) return (console.error("--report goes only with --dry-run; nothing written.\n" + USAGE), 2);
  // --put implies --strict: nothing leaves with a malformed row, a capitalised word or an unknown word left.
  const strict = args.includes("--strict") || args.includes("--put");
  // A dry run writes and sends nothing, so --put and --out don't go with it.
  if (dryRun && args.includes("--put")) return (console.error("--put and --dry-run don't go together; nothing sent.\n" + USAGE), 2);
  if (dryRun && args.includes("--out")) return (console.error("--out and --dry-run don't go together; nothing written.\n" + USAGE), 2);
  if (dryRun && approve !== undefined) return (console.error("--approve goes only with --put; nothing written.\n" + USAGE), 2);
  if (args.includes("--put") && (!putUrl || putUrl.startsWith("--"))) return (console.error(USAGE), 2);
  if (!record || (!dryRun && (!key || (!out && !putUrl)))) return (console.error(USAGE), 2);
  if (madeAtFlag !== undefined && !isIsoTime(madeAtFlag))
    return (console.error("--made-at: not a time as the dry run prints it (like 2026-11-19T10:00:00.000Z); nothing written."), 2);
  if (putUrl) {
    // Every value the upload needs is checked before anything is read or sent.
    const bad = putUrlProblem(putUrl, io.env);
    if (bad) return (console.error(`${bad}; upload: preflight rejection, nothing sent.`), EXIT_PREFLIGHT);
    const missing = PUT_ENV.filter((k) => !(io.env[k] ?? "").trim());
    if (missing.length) {
      console.error(`--put needs ${missing.join(", ")} in the environment; upload: preflight rejection, nothing sent.`);
      return EXIT_PREFLIGHT;
    }
    // The owner approves the exact bytes the dry run showed him: its time and its digest.
    if (!approve || !/^[0-9a-f]{64}$/.test(approve) || !madeAtFlag) {
      console.error(
        "--put needs --made-at <time> and --approve <digest>, both printed by a dry run with --key (the digest is the SHA-256 of the exact signed bytes); upload: preflight rejection, nothing sent.",
      );
      return EXIT_PREFLIGHT;
    }
  }
  // The dry run's report path, checked before anything is read: never inside a git work tree.
  let report: string | undefined;
  if (reportFlag !== undefined) {
    report = resolve(reportFlag || join(process.env.HOME || homedir(), DEFAULT_REPORT));
    if (insideGitWorkTree(report)) {
      console.error(`${report}: inside a git work tree; the private report goes outside any repository. Nothing written.`);
      return 2;
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
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}; nothing written.`);
    return 2;
  }
  let signingKey;
  if (key) {
    try {
      signingKey = privateKey(readFileSync(key, "utf8"));
    } catch {
      return (console.error(`${key}: not a readable Ed25519 private key; nothing written.`), 2);
    }
  }
  // The record's revision, when git can say it for certain (it then orders uploads in the Worker).
  const rev = recordRevision(record);
  if (!rev.revision) console.error(`note: no record revision in the snapshot (${rev.why}); the Worker orders it by made_at.`);
  // The whole pipeline runs before anything is printed, written or sent.
  let built;
  try {
    built = buildSnapshot(record, policy, madeAtFlag ? new Date(madeAtFlag) : new Date(), rev.revision);
  } catch (e) {
    // Never the record's text: only our own message about its shape, or that it couldn't be read.
    const msg = e instanceof Error ? e.message : String(e);
    const own = /^PENDING\.md has no open table/.test(msg) ? msg : "the record could not be read (state/PENDING.md, state/holds.json or a note)";
    console.error(`${own}; nothing written.`);
    return 1;
  }
  const s = built.snapshot;
  const problems = strictProblems(built);
  if (strict && (problems.warnings.length || problems.leftovers.length || problems.unknown.length)) {
    for (const w of problems.warnings) console.error("warning: " + w);
    // The field and the row number only, never the word.
    for (const l of problems.leftovers) console.error("capitalised word not on the allow list: " + leftoverPlace(l));
    for (const l of problems.unknown) console.error("unknown word: " + leftoverPlace(l));
    console.error(
      `--strict: ${problems.warnings.length} row warning(s), ${problems.leftovers.length} capitalised word(s) not on the allow list, ` +
        `${problems.unknown.length} unknown word(s); nothing written.` +
        (problems.leftovers.length || problems.unknown.length ? " A dry run with --report lists the words privately." : ""),
    );
    return 1;
  }
  for (const w of built.warnings) console.error("warning: " + w);
  // The approval digest: the identity of the exact bytes that would be signed (needs the key id).
  const digest = signingKey ? snapshotIdOf(withKeyId(s, keyIdOfPrivate(signingKey))) : null;
  if (dryRun) {
    // For the owner to read before the first upload: exactly what would be signed.
    console.log(JSON.stringify(signingKey ? withKeyId(s, keyIdOfPrivate(signingKey)) : s, null, 2));
    console.error(`Dry run: ${s.threads.length} threads, ${s.excluded_rows} rows left out, ${s.skipped_rows} skipped. Nothing written.`);
    // Per area, the config's areas list being the primary control on what an area may be.
    console.error(`Dry run, threads per area: ${areaLine(built)}.`);
    console.error(
      `Dry run: ${built.leftovers.length} capitalised word(s) replaced, ${built.unknowns.length} lower-case or uncased word(s) not in the word list.`,
    );
    const approval = digest ? approvalLine(s.made_at, digest) : null;
    // The words themselves never go to stderr or stdout: only to a private file, on request.
    if (report) {
      try {
        writePrivate(report, reportText(built, approval));
      } catch {
        console.error(`${report}: the private report could not be written; nothing written.`);
        return 2;
      }
      console.error(`Dry run: the private word list is in ${report} (mode 0600). Never relay it; delete it when done.`);
    } else if (built.leftovers.length || built.unknowns.length) {
      console.error("Dry run: pass --report [<file>] to write the words to a private file (mode 0600).");
    }
    if (approval) console.error(`Dry run: to upload exactly these bytes once you have read them, add: ${approval}`);
    else console.error("Dry run: no approval digest without --key (the signed bytes hold the key id).");
    return 0;
  }
  if (built.leftovers.length)
    console.error(`${built.leftovers.length} capitalised word(s) replaced by "someone"; a dry run with --report lists them privately.`);
  if (putUrl && digest !== approve) {
    console.error(
      "--put: these signed bytes are not the ones approved (the record, the config, the key or the time changed since the dry run); run the dry run again and read it. Upload: preflight rejection, nothing sent.",
    );
    return EXIT_PREFLIGHT;
  }
  let snapshot;
  try {
    snapshot = signSnapshot(s, signingKey!, policy);
  } catch (e) {
    // The run-time gate names the path only.
    console.error(`the gate refused to sign: ${e instanceof Error ? e.message : String(e)}; nothing written.`);
    return 1;
  }
  const body = JSON.stringify(snapshot, null, 2) + "\n";
  // With --put the file is written only once the upload is stored, so a failed run leaves it as it was.
  if (putUrl) {
    const own: KeyEntry = { id: keyIdOfPrivate(signingKey!), raw: rawPublicKey(publicPem(signingKey!)), retired: false };
    const pre = await uploadPreflight(body, own);
    if (pre) {
      console.error(`--put: ${pre}; upload: preflight rejection, nothing sent.`);
      return EXIT_PREFLIGHT;
    }
    const result = await upload(putUrl, body, snapshotIdOf(snapshot), io);
    if (result.kind === "rejected") return EXIT_REJECTED;
    if (result.kind !== "stored") return EXIT_UNKNOWN;
  }
  if (out) {
    writeWhole(out, body);
    console.log(`Wrote ${snapshot.threads.length} threads to ${out} (${s.excluded_rows} left out, ${s.skipped_rows} skipped).`);
  }
  return 0;
}

// The flags that make --put sign exactly the bytes the dry run showed.
export const approvalLine = (madeAt: string, digest: string) => `--made-at ${madeAt} --approve ${digest}`;

const publicPem = (k: ReturnType<typeof privateKey>) => createPublicKey(k).export({ format: "pem", type: "spki" }).toString();

// A key list, or one key (PEM or raw base64) as a one-entry list.
async function keysFrom(text: string): Promise<KeyEntry[] | null> {
  const t = text.trim();
  if (t.includes("BEGIN") || /^[A-Za-z0-9+/]+={0,2}$/.test(t)) {
    try {
      const raw = rawPublicKey(t);
      return [{ id: keyId(raw), raw, retired: false }];
    } catch {
      return null;
    }
  }
  return keyList(t.replace(/\s+/g, ","));
}

// Whether a path is inside a git work tree: a .git (folder or file) in its folder or any above it, or
// git itself saying so. The folder is taken as it really is (links resolved).
export function insideGitWorkTree(path: string): boolean {
  let dir = dirname(resolve(path));
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    dir = realpathSync(dir);
  } catch {}
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) break;
  }
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

// "surface 2, garden 1, other 5": the exported threads per area.
export function areaLine(b: Built): string {
  const parts = Object.entries(b.areas)
    .sort(([a], [b2]) => (a === "other" ? 1 : b2 === "other" ? -1 : a.localeCompare(b2)))
    .map(([a, n]) => `${a} ${n}`);
  return parts.length ? parts.join(", ") : "none";
}

// The dry run's private report: the warning line, the approval flags, then each word with its place.
export function reportText(b: Built, approval: string | null = null): string {
  const lines = [PRIVATE_REPORT, ""];
  lines.push(approval ? `to upload exactly the bytes this dry run printed: ${approval}` : "no approval digest (the dry run had no --key)", "");
  lines.push(`threads per area: ${areaLine(b)}`, "", "capitalised words the gate replaced:");
  for (const l of b.leftovers) lines.push(leftoverLine(l));
  lines.push("", "lower-case or uncased words not in the word list (each fails --strict):");
  for (const l of b.unknowns) lines.push(leftoverLine(l));
  lines.push("", "lower-case words that are also names (name-words.txt [common]; not a failure):");
  for (const l of b.nameLike) lines.push(leftoverLine(l));
  return lines.join("\n") + "\n";
}

// The temporary files this run made and hasn't renamed yet: removed on any failure, an exception, an
// exit or a signal (SIGINT, SIGTERM, SIGHUP).
const pendingTemps = new Set<string>();
const removeTemps = () => {
  for (const t of pendingTemps) rmSync(t, { force: true });
  pendingTemps.clear();
};
let cleanupInstalled = false;
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", removeTemps);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(sig, () => {
      removeTemps();
      process.exit(130);
    });
}
// A new temporary name beside the path: `<path>.tmp-<pid>-<random>` (surface/.gitignore lists the
// pattern), created exclusively with the given mode, so nothing is written through a link or over
// another run's file. Only a file this run created is ever removed.
function writeTemp(path: string, text: string, mode: number): string {
  installCleanup();
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "wx", mode);
  pendingTemps.add(tmp);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  return tmp;
}
function renameOver(tmp: string, path: string) {
  try {
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    pendingTemps.delete(tmp);
  }
}

// Written with mode 0600 from the moment it exists: a new temporary file beside it, then renamed over
// the path. On any failure the temporary file is removed.
export function writePrivate(path: string, text: string) {
  let tmp: string | undefined;
  try {
    tmp = writeTemp(path, text, 0o600);
    renameOver(tmp, path);
  } catch (e) {
    if (tmp) {
      rmSync(tmp, { force: true });
      pendingTemps.delete(tmp);
    }
    throw e;
  }
}

// Prints the private key's key id and the key list's entries, and whether the key is listed and not
// retired (the Worker's SNAPSHOT_PUBLIC_KEYS and the app's EXPO_PUBLIC_SURFACE_PUBLIC_KEY): exit 0 if
// it is listed and active, 1 if not (retired, or not listed), 2 for a list that doesn't parse.
async function keyMatch(args: string[]): Promise<number> {
  const key = arg(args, "--key");
  const pub = arg(args, "--pub");
  if (!key || !pub) return (console.error(USAGE), 2);
  let mine: string;
  try {
    mine = keyIdOfPrivate(privateKey(readFileSync(key, "utf8")));
  } catch {
    return (console.error(`${key}: not a readable Ed25519 private key`), 2);
  }
  const listed = await keysFrom(existsSync(pub) ? readFileSync(pub, "utf8") : pub);
  if (!listed) {
    console.error("key match: the key list doesn't parse (each entry <key id>:<base64>[:retired], ids matching their keys)");
    return 2;
  }
  console.log(`exporter key ${mine}; listed: ${listed.map((e) => e.id + (e.retired ? " (retired)" : "")).join(", ") || "none"}`);
  const hit = listed.find((e) => e.id === mine);
  if (hit && !hit.retired) return (console.log("key match: the exporter's key is listed and active"), 0);
  console.error(hit ? "key match: the exporter's key is listed as RETIRED" : "key match: the exporter's key is NOT listed");
  return 1;
}

// Written whole or not at all: a temporary file beside it, then a rename.
function writeWhole(path: string, text: string) {
  let tmp: string | undefined;
  try {
    tmp = writeTemp(path, text, 0o644);
    renameOver(tmp, path);
  } catch (e) {
    if (tmp) {
      rmSync(tmp, { force: true });
      pendingTemps.delete(tmp);
    }
    throw e;
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
