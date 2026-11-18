import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySnapshot, canonical, fromBase64 } from "../shared/snapshot";
import {
  buildSnapshot,
  firstSentence,
  isExcluded,
  makeKeyPair,
  openRows,
  privateKey,
  rawPublicKey,
  signSnapshot,
  strip,
} from "./lib";
import { main } from "./index";

const RECORD = join(import.meta.dir, "fixtures", "record");
const NOW = new Date("2026-11-18T12:00:00Z");
const snap = buildSnapshot(RECORD, NOW);
const byId = Object.fromEntries(snap.threads.map((t) => [t.id, t]));

describe("the open list", () => {
  test("reads the open table and not the Done table", () => {
    const ids = openRows(readFileSync(join(RECORD, "state", "PENDING.md"), "utf8")).map((r) => r.id);
    expect(ids).toContain("P40");
    expect(ids).not.toContain("P30");
    expect(ids).not.toContain("P31");
  });

  test("snapshot shape", () => {
    expect(snap.version).toBe(1);
    expect(snap.made_at).toBe(NOW.toISOString());
    for (const t of snap.threads)
      expect(Object.keys(t).sort()).toEqual(
        ["area", "id", "last_moved", "outcome", "state", "step", "title", "waits_for", "who"].sort(),
      );
  });
});

describe("who and state", () => {
  test("a running build job", () => {
    expect(byId.P40.who).toBe("a build job");
    expect(byId.P40.state).toBe("running");
  });
  test("Dane is you, waiting on you", () => {
    expect(byId.P41.who).toBe("you");
    expect(byId.P41.state).toBe("waiting on you");
  });
  test("Build without a job is a build job, still moving", () => {
    expect(byId.P42.who).toBe("a build job");
    expect(byId.P42.state).toBe("moving");
  });
  test("a laptop holder", () => {
    expect(byId.P43.who).toBe("a laptop session");
    expect(byId.P43.state).toBe("moving");
  });
  test("at his PC", () => {
    expect(byId.P44.who).toBe("at his PC");
    expect(byId.P44.state).toBe("at his PC");
  });
  test("Cain's, waiting on Dane by its Waits for", () => {
    expect(byId.P45.who).toBe("cain");
    expect(byId.P45.state).toBe("waiting on you");
  });
  test("Cain's, moving", () => {
    expect(byId.P49.who).toBe("cain");
    expect(byId.P49.state).toBe("moving");
    expect(byId.P49.waits_for).toBe("The registrar's notice");
  });
  test("every who and every state is covered by the fixtures", () => {
    expect(new Set(snap.threads.map((t) => t.who))).toEqual(
      new Set(["you", "cain", "a build job", "a laptop session", "at his PC"]),
    );
    expect(new Set(snap.threads.map((t) => t.state))).toEqual(
      new Set(["running", "waiting on you", "at his PC", "moving"]),
    );
  });
});

describe("fields", () => {
  test("area from a project folder, else other", () => {
    expect(byId.P40.area).toBe("surface");
    expect(byId.P42.area).toBe("harness");
    expect(byId.P41.area).toBe("other");
  });
  test("title and step are first sentences, capped", () => {
    expect(byId.P40.title).toBe("Surface piece one for projects/surface.");
    const long = "word ".repeat(80) + ". Second.";
    expect(firstSentence(long, 140).length).toBeLessThanOrEqual(140);
    expect(firstSentence("One. Two.", 140)).toBe("One.");
  });
  test("an empty Waits for is null", () => {
    expect(byId.P40.waits_for).toBeNull();
  });
  test("last moved is the newest of Since, notes and the hold", () => {
    expect(byId.P40.last_moved).toBe("2026-11-18T09:40:00.000Z"); // hold renewed
    expect(byId.P41.last_moved).toBe("2026-11-17T18:22:00.000Z"); // newest note
    expect(byId.P44.last_moved).toBe("2026-11-14T00:00:00.000Z"); // Since only
  });
});

describe("exclusions", () => {
  test("a money row and a health row never appear", () => {
    expect(byId.P46).toBeUndefined(); // budget
    expect(byId.P47).toBeUndefined(); // PT
    expect(byId.P50).toBeUndefined(); // bank
    expect(byId.P51).toBeUndefined(); // Doctoral: a prefix of doctor
    const all = JSON.stringify(snap).toLowerCase();
    for (const w of ["budget", "bank", "pt session", "doctor"]) expect(all).not.toContain(w);
  });
  test("whole words and prefixes, any case", () => {
    for (const t of ["MONEY", "Finances", "financial", "debts", "Banking", "budgeting", "healthcare", "therapist", "pt", "PT", "doctors", "medication", "medical", "diagnosis", "diagnosed"])
      expect(isExcluded(t)).toBe(true);
    for (const t of ["embankment", "spending time", "adept", "opt in", "the script"])
      expect(isExcluded(t)).toBe(false);
  });
  test("a word in the id excludes the row", () => {
    expect(isExcluded("PT3")).toBe(true);
  });
});

describe("strippers", () => {
  test("urls, emails, phones, addresses and record codes", () => {
    expect(strip("see https://example.com/a?b=1 now")).toBe("see a link now");
    expect(strip("see www.example.com")).toBe("see a link");
    expect(strip("mail someone@example.org today")).toBe("mail an email address today");
    expect(strip("call +1 555 201 7788 soon")).toBe("call a phone number soon");
    expect(strip("call (555) 201-7788")).toBe("call a phone number");
    expect(strip("fence at 12 Elm Street.")).toBe("fence at an address.");
    expect(strip("after P41 and Q7")).toBe("after another item and another item");
  });
  test("leaves dates, times and plain numbers", () => {
    expect(strip("on 2026-11-18 at 7:30, 3 boxes")).toBe("on 2026-11-18 at 7:30, 3 boxes");
  });
  test("nothing stripped leaks into the fixture snapshot", () => {
    const all = JSON.stringify(snap.threads.map(({ id, ...rest }) => rest));
    expect(all).not.toMatch(/https?:|@example|555|Elm Street|\bP4\d\b|\bQ7\b/);
  });
});

describe("signature", () => {
  const keys = makeKeyPair();
  const signed = signSnapshot(snap, privateKey(keys.privatePem));
  const raw = rawPublicKey(keys.publicPem);

  test("key id is the first 16 hex of the public key's sha256", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(signed.key_id).toBe(hex.slice(0, 16));
    expect(rawPublicKey(keys.publicRaw)).toEqual(raw);
  });

  test("a signed snapshot verifies", async () => {
    expect(await verifySnapshot(signed, raw)).toBe(true);
  });

  test("one tampered byte fails", async () => {
    const text = canonical(signed);
    const i = text.indexOf("Pick the school");
    const tampered = JSON.parse(text.slice(0, i) + "p" + text.slice(i + 1));
    expect(await verifySnapshot(tampered, raw)).toBe(false);
    const sigBytes = fromBase64(signed.sig);
    sigBytes[0] ^= 1;
    expect(await verifySnapshot({ ...signed, sig: btoa(String.fromCharCode(...sigBytes)) }, raw)).toBe(false);
  });

  test("another key fails", async () => {
    expect(await verifySnapshot(signed, rawPublicKey(makeKeyPair().publicPem))).toBe(false);
  });

  test("the command line writes and verifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-"));
    expect(await main(["--keygen", dir])).toBe(0);
    const out = join(dir, "snap.json");
    expect(await main(["--record", RECORD, "--out", out, "--key", join(dir, "surface.key")])).toBe(0);
    expect(await main(["--verify", out, "--pub", join(dir, "surface.pub")])).toBe(0);
    expect(await main(["--verify", out, "--pub", join(dir, "surface.pub.b64")])).toBe(0);
    const body = readFileSync(out, "utf8");
    writeFileSync(out, body.replace("Back up", "Back uP"));
    expect(await main(["--verify", out, "--pub", join(dir, "surface.pub")])).toBe(1);
  });
});
