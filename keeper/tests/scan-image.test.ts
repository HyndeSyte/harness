// Keeper 0.1.18: the App's own container image in its backup. A file there Keeper can't open (xz, as Debian's apt logs are; a
// name that says archive with other bytes; a layer past the nesting budget) is searched as raw bytes and counted as unopened,
// never failed. Everywhere else (the App's data, its options, a lookalike image.tar elsewhere) the scan still fails closed.
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { KEY_NAME } from "../rootfs/opt/keeper/core.ts";
import { MAX_DEPTH, SCAN_VERSION, inImage, scanBackup } from "../rootfs/opt/keeper/scan.ts";

const enc = (x: string) => new TextEncoder().encode(x);
const CTL = "keeper-control-0123456789abcdef01234567";
const KEY = "planted-value-aaaaaaaaaa";
const hdr = (name: string, size: number) => {
  const h = new Uint8Array(512);
  const put = (x: string, off: number) => h.set(enc(x), off);
  put(name, 0); put("0000600\0", 100); put("0000000\0", 108); put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124); put("00000000000\0", 136); put("        ", 148); put("0", 156);
  put("ustar\0", 257); put("00", 263);
  put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
};
const cat = (...p: Uint8Array[]) => { const out = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of p) { out.set(x, o); o += x.length; } return out; };
const member = (name: string, body: string | Uint8Array) => {
  const data = typeof body === "string" ? enc(body) : body;
  return cat(hdr(name, data.length), data, new Uint8Array((512 - (data.length % 512)) % 512));
};
const END = new Uint8Array(1024);
const tar = (...m: Uint8Array[]) => cat(...m, END);
const XZ = (extra = "") => cat(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), enc(`compressed bytes${extra}`));
const data = () => [member("./addon.json", "{}"), member("./data/state.json", "{\"format\":1}"), member("./data/backup-check-control", `${CTL}\n`)];
// the App's image as `docker save` writes it: a layer blob holding the base image's files
const image = (...files: Uint8Array[]) => member("./image.tar", tar(member("blobs/sha256/9d99ae806a30", tar(...files))));
const backup = (...app: Uint8Array[]) => tar(member("./backup.json", "{\"protected\":false}"), member("./0fcc2575_keeper.tar.gz", gzipSync(tar(...app))));
const scan = (b: Uint8Array) => scanBackup(b, KEY_NAME, [KEY], { control: CTL });

describe("Keeper 0.1.18: files in the App's own image that Keeper can't open", () => {
  test("an xz file in an image layer passes, counted as unopened", async () => {
    const r = await scan(backup(image(member("var/log/apt/eipp.log.xz", XZ()), member("etc/os-release", "ID=debian")), ...data()));
    expect(r.why).toBe("");
    expect(r.ok).toBe(true);
    expect(r.unopened).toBe(1);
    expect(r.control).toBe(1);
  });
  test("a key value in an unopened image file's raw bytes is still found", async () => {
    const r = await scan(backup(image(member("var/log/apt/eipp.log.xz", XZ(KEY))), ...data()));
    expect(r.ok).toBe(false);
    expect(r.why).toContain("key material");
  });
  test("a name that says archive with other bytes, in the image, passes unopened", async () => {
    const r = await scan(backup(image(member("usr/share/thing.zip.tar", "not a tar at all")), ...data()));
    expect(r.ok).toBe(true);
    expect(r.unopened).toBe(1);
  });
  test("a gzip in the image that isn't a tar inside (a changelog.gz) is opened and searched, not counted as unopened", async () => {
    const r = await scan(backup(image(member("usr/share/doc/x/changelog.gz", gzipSync(enc("plain text"))), member("var/log/apt/eipp.log.xz", XZ())), ...data()));
    expect(r.ok).toBe(true);
    expect(r.unopened).toBe(1);
    const k = await scan(backup(image(member("usr/share/doc/x/changelog.gz", gzipSync(enc(`text ${KEY}`)))), ...data()));
    expect(k.ok).toBe(false);
  });
  test("past the nesting budget inside the image: read as raw bytes, not failed", async () => {
    let deep: Uint8Array = member("f.txt", "x");
    for (let i = 0; i < MAX_DEPTH + 2; i++) deep = member(`n${i}.tar`, tar(deep));
    const r = await scan(backup(image(deep), ...data()));
    expect(r.why).toBe("");
    expect(r.ok).toBe(true);
    expect(r.unopened).toBeGreaterThan(0);
  });
  test("outside the image nothing changed: xz in the App's data fails", async () => {
    const r = await scan(backup(member("./data/log.xz", XZ()), ...data()));
    expect(r.ok).toBe(false);
    expect(r.why).toContain("xz-compressed");
  });
  test("an image.tar that isn't the App archive's own top-level member still fails", async () => {
    const inData = await scan(backup(member("./data/image.tar", tar(member("a.xz", XZ()))), ...data()));
    expect(inData.ok).toBe(false);
    expect(inData.why).toContain("xz-compressed");
    const atTop = await scan(tar(member("./backup.json", "{\"protected\":false}"), member("./image.tar", tar(member("a.xz", XZ()))),
      member("./0fcc2575_keeper.tar.gz", gzipSync(tar(...data())))));
    expect(atTop.ok).toBe(false);
    expect(atTop.why).toContain("xz-compressed");
  });
  test("the image path rule and the scan version", () => {
    expect(inImage("0fcc2575_keeper.tar.gz:./image.tar:blobs/sha256/9d:var/log/apt/eipp.log.xz")).toBe(true);
    expect(inImage("./0fcc2575_keeper.tar.gz:image.tar:x")).toBe(true);
    expect(inImage("0fcc2575_keeper.tar.gz:./image.tar")).toBe(false);
    expect(inImage("0fcc2575_keeper.tar.gz:./data/image.tar:x")).toBe(false);
    expect(inImage("./image.tar:x")).toBe(false);
    expect(SCAN_VERSION).toBe(4);
  });
});
