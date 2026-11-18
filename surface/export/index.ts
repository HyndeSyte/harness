#!/usr/bin/env bun
// bun run surface/export --record <record checkout> --private-terms <file> --out <file> --key <Ed25519 private key PEM>
//   [--config <exporter config JSON>] [--strict]
// bun run surface/export --record <record checkout> --private-terms <file> --dry-run [--config <file>]
// bun run surface/export --record ... --key <private key PEM> --put <url> [--out <file>] [--strict]
//   (the Access and publisher values come from SURFACE_ACCESS_CLIENT_ID, SURFACE_ACCESS_CLIENT_SECRET
//   and SURFACE_PUBLISHER_TOKEN, never from flags or files; the URL's host must be SURFACE_PUT_HOST)
// bun run surface/export --verify <file> --pub <public key: PEM or raw base64>
// bun run surface/export --keygen <dir>   (writes surface.key, surface.pub, surface.pub.b64)

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifySnapshot } from "../shared/snapshot";
import { buildSnapshot, configProblem, makeKeyPair, makePolicy, privateKey, rawPublicKey, signSnapshot, type ExporterConfig } from "./lib";

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

const USAGE = `usage:
  bun run surface/export --record <record checkout> --private-terms <file> --out <file> --key <private key PEM>
      [--config <exporter config JSON>] [--strict]
  bun run surface/export --record <record checkout> --private-terms <file> --key <private key PEM> --put <url>
      [--out <file>] [--config <exporter config JSON>] [--strict]
      (with SURFACE_PUT_HOST, SURFACE_ACCESS_CLIENT_ID, SURFACE_ACCESS_CLIENT_SECRET and
      SURFACE_PUBLISHER_TOKEN set; --put implies --strict)
  bun run surface/export --record <record checkout> --private-terms <file> --dry-run [--config <file>]
  bun run surface/export --verify <file> --pub <public key file>
  bun run surface/export --keygen <dir>`;

export interface IO {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
}

const defaultIO: IO = { fetch: (url, init) => fetch(url, init), env: process.env };

// The --put URL's own checks, before any request: https, no credentials in it, and its host is
// exactly SURFACE_PUT_HOST. Returns a one-line reason, or null.
export function putUrlProblem(raw: string, env: Record<string, string | undefined>): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "--put: not a URL";
  }
  if (u.username || u.password) return "--put: credentials in the URL are refused";
  if (u.protocol !== "https:") return "--put: the URL must be https";
  const want = (env[PUT_HOST_ENV] ?? "").trim().toLowerCase();
  if (!want) return `--put needs ${PUT_HOST_ENV} in the environment`;
  if (u.host.toLowerCase() !== want) return `--put: the URL's host is not ${PUT_HOST_ENV}`;
  return null;
}

// Printable, one line, bounded: nothing from the response but the Worker's own JSON message.
const oneLine = (s: string) => s.replace(/[\p{C}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);

// Sends a signed snapshot: the Access service token's two headers (checked by Access) and the
// publisher header (checked by the Worker). Never follows a redirect, never prints a header, and
// prints the status and at most 200 characters of the Worker's JSON message.
async function upload(url: string, body: string, io: IO): Promise<number> {
  const u = new URL(url);
  const where = `PUT ${u.origin}${u.pathname}`;
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
    console.error(`${where}: no answer (${oneLine(String(e?.message ?? e))})`);
    return 1;
  }
  if (res.type === "opaqueredirect" || res.redirected || res.status === 0 || (res.status >= 300 && res.status < 400)) {
    console.error(`${where}: ${res.status} ${REDIRECTED}; nothing stored.`);
    return 1;
  }
  const text = await res.text().catch(() => "");
  let message = "";
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object")
      message = typeof j.error === "string" ? j.error : typeof j.stored === "string" ? `stored ${j.stored}` : "";
  } catch {}
  message = oneLine(message);
  const ok = res.status >= 200 && res.status < 300;
  (ok ? console.log : console.error)(`${where}: ${res.status}${message ? " " + message : ""}`);
  return ok ? 0 : 1;
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
  const record = arg(args, "--record");
  const out = arg(args, "--out");
  const key = arg(args, "--key");
  const termsFile = arg(args, "--private-terms");
  const configFile = arg(args, "--config");
  const putUrl = arg(args, "--put");
  const dryRun = args.includes("--dry-run");
  // --put implies --strict: nothing leaves with a malformed row or a capitalised word left.
  const strict = args.includes("--strict") || args.includes("--put");
  if (args.includes("--put") && (!putUrl || putUrl.startsWith("--"))) return (console.error(USAGE), 2);
  if (putUrl && dryRun) return (console.error("--put and --dry-run don't go together; nothing sent.\n" + USAGE), 2);
  if (!record || (!dryRun && (!key || (!out && !putUrl)))) return (console.error(USAGE), 2);
  if (putUrl) {
    // Every value the upload needs is checked before anything is read or sent.
    const bad = putUrlProblem(putUrl, io.env);
    if (bad) return (console.error(`${bad}; nothing sent.`), 2);
    const missing = PUT_ENV.filter((k) => !(io.env[k] ?? "").trim());
    if (missing.length) {
      console.error(`--put needs ${missing.join(", ")} in the environment; nothing sent.`);
      return 2;
    }
  }
  // Fail closed: no private terms file, or one with no terms, and nothing is written.
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
  const built = buildSnapshot(record, policy);
  for (const w of built.warnings) console.error("warning: " + w);
  // A capitalised word the gate replaced is named (field, row number and the word only) under
  // --strict, where it fails the run, and in a dry run, for the owner to read.
  if (strict || dryRun) for (const l of built.leftovers) console.error("capitalised: " + l);
  if (strict && (built.warnings.length || built.leftovers.length)) {
    console.error(
      `--strict: ${built.warnings.length} malformed row(s), ${built.leftovers.length} capitalised word(s) not on the allow list; nothing written.`,
    );
    return 1;
  }
  const s = built.snapshot;
  if (dryRun) {
    // For the owner to read before the first upload: exactly what would be signed.
    console.log(JSON.stringify(s, null, 2));
    console.error(`Dry run: ${s.threads.length} threads, ${s.excluded_rows} rows left out, ${s.skipped_rows} skipped. Nothing written.`);
    return 0;
  }
  const snapshot = signSnapshot(s, privateKey(readFileSync(key!, "utf8")));
  const body = JSON.stringify(snapshot, null, 2) + "\n";
  if (out) {
    writeFileSync(out, body);
    console.log(`Wrote ${snapshot.threads.length} threads to ${out} (${s.excluded_rows} left out, ${s.skipped_rows} skipped).`);
  }
  if (putUrl) return upload(putUrl, body, io);
  return 0;
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
