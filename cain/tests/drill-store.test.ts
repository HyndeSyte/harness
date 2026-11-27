// Cain 0.19.2: the link's drill store is the drill's own (link/drill.ts linkDrillStore, as main.ts builds it). From 0.19.0 main.ts
// imported fileStore from both ./drill and ./watch; Bun binds the later one without checking, so the drill got the watch's store
// ({load, save}: no highWater) and every install of Cain was refused ("the drill flags' high-water time can't be kept").
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillDeps, linkDrillStore } from "../rootfs/opt/cain/link/drill";

const MAIN = join(import.meta.dir, "../rootfs/opt/cain/link/main.ts");

describe("the link's drill store (Cain 0.19.2)", () => {
  test("is the drill's store, with highWater, refused, storeRefused and recordNonce", () => {
    const dir = mkdtempSync(join(tmpdir(), "drill-store-"));
    const store = linkDrillStore({}, join(dir, "trust"), join(dir, "link"), Date.now);
    for (const k of ["highWater", "refused", "storeRefused", "recordNonce"] as const) expect(typeof store[k]).toBe("function");
  });

  test("with no flag file, spend on a temp folder answers mode null", () => {
    const dir = mkdtempSync(join(tmpdir(), "drill-store-"));
    const env = { CAIN_DRILL_FLAG: join(dir, "trust", "keeper-drill.json") };
    const lines: string[] = [];
    const drill = drillDeps(linkDrillStore(env, join(dir, "trust"), join(dir, "link"), Date.now), () => null, Date.now, (l) => lines.push(l));
    expect(drill.spend("0.19.2")).toEqual({ mode: null });
    expect(lines.join("\n")).not.toContain("high-water");
  });

  test("main.ts builds it with linkDrillStore and imports the watch's store under its own name", () => {
    const src = readFileSync(MAIN, "utf8");
    expect(src).toMatch(/const drillStore = linkDrillStore\(/);
    expect(src).toMatch(/fileStore as watchFileStore[^\n]*from "\.\/watch"/);
  });
});
