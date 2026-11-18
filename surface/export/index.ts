#!/usr/bin/env bun
// bun run surface/export --record <record checkout> --out <file> --key <Ed25519 private key PEM>
// bun run surface/export --verify <file> --pub <public key: PEM or raw base64>
// bun run surface/export --keygen <dir>   (writes surface.key, surface.pub, surface.pub.b64)

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifySnapshot } from "../shared/snapshot";
import { buildSnapshot, makeKeyPair, privateKey, rawPublicKey, signSnapshot } from "./lib";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// The private key (PEM), the public key (PEM) and the public key as raw base64.
const KEY_FILES = ["surface.key", "surface.pub", "surface.pub.b64"];

const USAGE = `usage:
  bun run surface/export --record <record checkout> --out <file> --key <private key PEM>
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
  if (!record || !out || !key) return (console.error(USAGE), 2);
  const snapshot = signSnapshot(buildSnapshot(record), privateKey(readFileSync(key, "utf8")));
  writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Wrote ${snapshot.threads.length} threads to ${out}.`);
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
