// The link's Ship key (wave 1, piece B): an Ed25519 key that signs Dane's Ship taps,
// made on first start in the link's own folder. Only the link is meant to read it:
// Cain's tools are denied it, and once his session runs as its own user it can't
// reach it at all. Its public half goes where the RemoteTrigger hook reads it, and
// into the log, for the copy GitHub checks against on main (.github/ship.pub).
//
// Written whole or not at all. A key that can't be read is moved aside and a new one
// made, so Ship taps are signed again at once; the new public half then has to reach
// main before GitHub takes them (RELEASING.md, "If the Ship key is remade").
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ShipKey { key: KeyObject; pub: string; remade: boolean }

export function publicOf(k: KeyObject): string {
  return createPublicKey(k).export({ format: "der", type: "spki" }).toString("base64");
}

function make(keyPath: string): void {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(`${keyPath}.tmp`, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  renameSync(`${keyPath}.tmp`, keyPath);
}

function read(keyPath: string): KeyObject {
  const k = createPrivateKey(readFileSync(keyPath));
  if (k.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  return k;
}

export function loadShipKey(keyPath: string, pubPath: string, log: (line: string) => void, now = Date.now): ShipKey | null {
  try {
    let remade = false;
    if (!existsSync(keyPath)) { make(keyPath); log("made a new Ship key"); }
    let k: KeyObject;
    try { k = read(keyPath); }
    catch (e) {
      const aside = `${keyPath}.bad-${now()}`;
      renameSync(keyPath, aside);
      make(keyPath);
      k = read(keyPath);
      remade = true;
      log(`the Ship key couldn't be read (${String(e).slice(0, 60)}), so it was moved aside and a new one made`);
    }
    const pub = publicOf(k);
    let have = "";
    try { have = readFileSync(pubPath, "utf8").trim(); } catch { /* none yet */ }
    if (have !== pub) {
      writeFileSync(`${pubPath}.tmp`, `${pub}\n`, { mode: 0o644 });
      renameSync(`${pubPath}.tmp`, pubPath);
    }
    log(`Ship key (public): ${pub}`);
    return { key: k, pub, remade };
  } catch (e) {
    log(`no Ship key, so Ship taps carry no token: ${String(e).slice(0, 100)}`);
    return null;
  }
}
