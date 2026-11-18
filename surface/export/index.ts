#!/usr/bin/env bun
// bun run surface/export --record <record checkout> --private-terms <file> --out <file> --key <Ed25519 private key PEM>
//   [--config <exporter config JSON>] [--strict]
// bun run surface/export --record <record checkout> --private-terms <file> --dry-run [--config <file>]
// bun run surface/export --verify <file> --pub <public key: PEM or raw base64>
// bun run surface/export --keygen <dir>   (writes surface.key, surface.pub, surface.pub.b64)

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifySnapshot } from "../shared/snapshot";
import { buildSnapshot, makeKeyPair, makePolicy, privateKey, rawPublicKey, signSnapshot, type ExporterConfig } from "./lib";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// The private key (PEM), the public key (PEM) and the public key as raw base64.
const KEY_FILES = ["surface.key", "surface.pub", "surface.pub.b64"];

const USAGE = `usage:
  bun run surface/export --record <record checkout> --private-terms <file> --out <file> --key <private key PEM>
      [--config <exporter config JSON>] [--strict]
  bun run surface/export --record <record checkout> --private-terms <file> --dry-run [--config <file>]
  bun run surface/export --verify <file> --pub <public key file>
  bun run surface/export --keygen <dir>`;

export async function main(args: string[]): Promise<number> {
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
  const dryRun = args.includes("--dry-run");
  const strict = args.includes("--strict");
  if (!record || (!dryRun && (!out || !key))) return (console.error(USAGE), 2);
  // Fail closed: no private terms file, or one with no terms, and nothing is written.
  if (!termsFile) return (console.error("--private-terms <file> is required; nothing written.\n" + USAGE), 2);
  if (!existsSync(termsFile)) return (console.error(`${termsFile}: no such private terms file; nothing written.`), 2);
  let config: ExporterConfig = {};
  if (configFile) {
    if (!existsSync(configFile)) return (console.error(`${configFile}: no such config file; nothing written.`), 2);
    config = JSON.parse(readFileSync(configFile, "utf8"));
  }
  let policy;
  try {
    policy = makePolicy(readFileSync(termsFile, "utf8"), config, process.env);
  } catch (e: any) {
    console.error(`${String(e?.message ?? e)}; nothing written.`);
    return 2;
  }
  const built = buildSnapshot(record, policy);
  for (const w of built.warnings) console.error("warning: " + w);
  if (strict && built.warnings.length) {
    console.error(`--strict: ${built.warnings.length} malformed row(s); nothing written.`);
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
  writeFileSync(out!, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Wrote ${snapshot.threads.length} threads to ${out} (${s.excluded_rows} left out, ${s.skipped_rows} skipped).`);
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
