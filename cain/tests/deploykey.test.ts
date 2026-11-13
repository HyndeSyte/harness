// The link's deploy key (link/deploykey.ts): made once, read back from the key itself,
// moved aside and remade when it can't be read, and never printed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployKey, sshTools, type KeyTools } from "../rootfs/opt/cain/link/deploykey.ts";

const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2kD8vC5r3ZbqfJm1oPq8ODp4b7Ez9x0s3n1jQpL2vY";

function fake(over: Partial<KeyTools> = {}): KeyTools & { made: number } {
  const t = {
    made: 0,
    keygen: (path: string) => { t.made++; writeFileSync(path, `PRIVATE ${t.made}\n`, { mode: 0o600 }); writeFileSync(`${path}.pub`, `${PUB} cain-link\n`); },
    pubOf: (path: string) => { const s = readFileSync(path, "utf8"); if (!s.startsWith("PRIVATE")) throw new Error("invalid format"); return PUB; },
    now: () => 1_700_000_000_000,
    ...over,
  };
  return t;
}

describe("the link's deploy key", () => {
  test("made once on first start; its public half is logged, the private half never", () => {
    const dir = mkdtempSync(join(tmpdir(), "dk-"));
    const path = join(dir, "deploy_key");
    const lines: string[] = [];
    const t = fake();
    const k = loadDeployKey(path, (l) => lines.push(l), t);
    expect(k).toEqual({ path, pub: PUB, remade: false });
    expect(lines).toEqual(["made a new deploy key", `deploy key (public): ${PUB} cain-link`]);
    expect(readdirSync(dir).sort()).toEqual(["deploy_key"]);
    expect(lines.join("\n")).not.toContain("PRIVATE");
    // A second start keeps it.
    const again: string[] = [];
    expect(loadDeployKey(path, (l) => again.push(l), t)).toEqual({ path, pub: PUB, remade: false });
    expect(t.made).toBe(1);
    expect(again).toEqual([`deploy key (public): ${PUB} cain-link`]);
  });

  test("a key that can't be read is moved aside and a new one made, and that's said", () => {
    const dir = mkdtempSync(join(tmpdir(), "dk-"));
    const path = join(dir, "deploy_key");
    writeFileSync(path, "garbage", { mode: 0o600 });
    const lines: string[] = [];
    const k = loadDeployKey(path, (l) => lines.push(l), fake());
    expect(k).toMatchObject({ pub: PUB, remade: true });
    expect(existsSync(`${path}.bad-1700000000000`)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("PRIVATE 1\n");
    expect(lines[0]).toContain("the deploy key couldn't be read (Error: invalid format), so it was moved aside and a new one made");
  });

  test("no ssh-keygen: no key, and a Ship tap can't merge", () => {
    const dir = mkdtempSync(join(tmpdir(), "dk-"));
    const lines: string[] = [];
    const k = loadDeployKey(join(dir, "deploy_key"), (l) => lines.push(l), fake({ keygen: () => { throw new Error("ssh-keygen: not found"); } }));
    expect(k).toBeNull();
    expect(lines).toEqual(["no deploy key, so a Ship tap can't merge: Error: ssh-keygen: not found"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  // The real thing, where ssh-keygen keeps key files private (not on Windows).
  test.skipIf(process.platform === "win32" || !Bun.which("ssh-keygen"))("with the real ssh-keygen: an ed25519 key, private to the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "dk-"));
    const path = join(dir, "deploy_key");
    const lines: string[] = [];
    const k = loadDeployKey(path, (l) => lines.push(l), sshTools)!;
    expect(k.pub).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/);
    expect(readFileSync(path, "utf8")).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(Bun.spawnSync(["stat", "-c", "%a", path]).stdout.toString().trim()).toBe("600");
    expect(readdirSync(dir)).toEqual(["deploy_key"]);
    expect(loadDeployKey(path, () => {}, sshTools)!.pub).toBe(k.pub);
  });
});
