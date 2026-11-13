// The link's deploy key (wave 1, piece B): once main is locked to it (RELEASING.md),
// the only key that can update main, and only the link uses it, to land a pull
// request on Dane's Ship tap (merge.ts). An SSH ed25519 key, made on first start in the
// link's own folder by ssh-keygen and never printed. Its public half goes into the log,
// from where it's added to the repository as a deploy key with write access.
//
// Written whole or not at all. A key that can't be read is moved aside and a new one
// made; Ship taps can't merge until its public half is added on GitHub and the old one
// deleted there (RELEASING.md, "If the deploy key is remade"). Home Assistant's backups
// leave it out (config.yaml, backup_exclude), so a restored Pi makes a new one.
import { existsSync, renameSync, rmSync } from "node:fs";

// made: a new key this start (a first start, a restored Pi, or a remade one), which GitHub
// doesn't know yet; remade: the old one couldn't be read.
export interface DeployKey { path: string; pub: string; made: boolean; remade: boolean }

export interface KeyTools {
  keygen: (path: string) => void;         // writes path (0600) and path.pub, or throws
  pubOf: (path: string) => string;        // the public half, read from the private key, or throws
  now: () => number;
}

const PUB = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;

function run(args: string[]): string {
  const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  if (p.exitCode !== 0) throw new Error(`${args[0]}: ${p.stderr.toString().trim().slice(0, 100) || `exit ${p.exitCode}`}`);
  return p.stdout.toString();
}

export const sshTools: KeyTools = {
  keygen: (path) => { run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "cain-link", "-f", path]); },
  pubOf: (path) => {
    const pub = run(["ssh-keygen", "-y", "-f", path]).trim().split(/\s+/).slice(0, 2).join(" ");
    if (!PUB.test(pub)) throw new Error("not an ed25519 key");
    return pub;
  },
  now: Date.now,
};

function make(path: string, t: KeyTools): void {
  const tmp = `${path}.new`;
  rmSync(tmp, { force: true });
  rmSync(`${tmp}.pub`, { force: true });
  t.keygen(tmp);
  t.pubOf(tmp);                            // a key that can't be read back isn't put in place
  renameSync(tmp, path);
  rmSync(`${tmp}.pub`, { force: true });   // the public half is always read from the key itself
}

export function loadDeployKey(path: string, log: (line: string) => void, t: KeyTools = sshTools): DeployKey | null {
  try {
    let remade = false, made = false;
    if (!existsSync(path)) { make(path, t); made = true; log("made a new deploy key"); }
    let pub: string;
    try { pub = t.pubOf(path); }
    catch (e) {
      renameSync(path, `${path}.bad-${t.now()}`);
      make(path, t);
      pub = t.pubOf(path);
      remade = made = true;
      log(`the deploy key couldn't be read (${String(e).slice(0, 60)}), so it was moved aside and a new one made`);
    }
    log(`deploy key (public): ${pub} cain-link`);
    return { path, pub, made, remade };
  } catch (e) {
    log(`no deploy key, so a Ship tap can't merge: ${String(e).slice(0, 100)}`);
    return null;
  }
}
