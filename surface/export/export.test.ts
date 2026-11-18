import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySnapshot, canonical, fromBase64 } from "../shared/snapshot";
import { cutCodePoints, signedBytes } from "../shared/canonical";
import {
  areaOf,
  buildSnapshot,
  firstSentence,
  isExcluded,
  makeKeyPair,
  makePolicy,
  markedPrivate,
  parseTerms,
  openRows,
  replaceNames,
  privateKey,
  rawPublicKey,
  signSnapshot,
  strip,
} from "./lib";
import { main } from "./index";

const FIX = join(import.meta.dir, "fixtures");
const RECORD = join(FIX, "record");
const TERMS = join(FIX, "private-terms.txt");
const CONFIG = join(FIX, "exporter.json");
const NOW = new Date("2026-11-18T12:00:00Z");
const policy = makePolicy(readFileSync(TERMS, "utf8"), JSON.parse(readFileSync(CONFIG, "utf8")));
const built = buildSnapshot(RECORD, policy, NOW);
const snap = built.snapshot;
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
    expect(Object.keys(snap).sort()).toEqual(["excluded_rows", "made_at", "skipped_rows", "threads", "version"]);
  });
});

describe("who and state", () => {
  test("a running build job", () => {
    expect(byId.P40.who).toBe("a build job");
    expect(byId.P40.state).toBe("running");
  });
  test("the owner (named in config) is you, waiting on you", () => {
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
  test("Cain's, waiting on the owner by its Waits for", () => {
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
  test("cuts count whole code points, never half an emoji", () => {
    const emoji = "a".repeat(138) + "😀😀😀";
    const cut = firstSentence(emoji, 140);
    expect(Array.from(cut).length).toBe(140);
    expect(cut).toBe("a".repeat(138) + "😀…");
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const nonBmp = "𝄞".repeat(300);
    expect(Array.from(cutCodePoints(nonBmp, 200)).length).toBe(200);
    expect(cutCodePoints("𝄞𝄞", 2)).toBe("𝄞𝄞");
  });
  test("a joiner sequence or a flag at the cut is never split", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const flag = "\u{1F1F3}\u{1F1FF}";
    expect(cutCodePoints("ab" + family + family + "cd", 4)).toBe("ab" + family + "…");
    expect(cutCodePoints("ab" + family + "c", 3)).toBe("ab…");
    expect(cutCodePoints("a" + flag + flag + "z", 3)).toBe("a" + flag + "…");
    expect(cutCodePoints("ab" + family, 3)).toBe("ab" + family);
    const cut = firstSentence("a".repeat(138) + family + family + family, 140);
    expect(cut).toBe("a".repeat(138) + family + "…");
  });
  test("without Intl.Segmenter the cut falls back to code points", () => {
    const seg = (Intl as any).Segmenter;
    try {
      delete (Intl as any).Segmenter;
      expect(cutCodePoints("ab😀😀😀", 4)).toBe("ab😀…");
      expect(cutCodePoints("𝄞".repeat(5), 3)).toBe("𝄞𝄞…");
    } finally {
      (Intl as any).Segmenter = seg;
    }
    expect(typeof (Intl as any).Segmenter).toBe("function");
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

describe("names never leave", () => {
  test("the owner's name becomes you or your in every field, still waiting on you", () => {
    const t = byId.P56;
    expect(t.state).toBe("waiting on you");
    expect(t.who).toBe("cain");
    expect(t.title).toBe("your school form, for you to sign.");
    expect(t.step).toBe("Put the form where you sees it; ask the Robinsons and someone's sister too.");
    expect(t.waits_for).toBe("your pick");
    expect(t.outcome).toBe("your form signed and someone told.");
    expect(byId.P41.who).toBe("you");
    expect(byId.P41.waits_for).toBe("your pick");
    expect(byId.P45.state).toBe("waiting on you");
    expect(byId.P45.waits_for).toBe("your OK on the draft");
  });
  test("a listed name becomes someone", () => {
    expect(byId.P54.title).toBe("Ring someone at a phone number about projects/garden, see a link");
  });
  test("no configured name is left anywhere in the snapshot", () => {
    const all = JSON.stringify(snap.threads);
    expect(all).not.toMatch(/(?<![\p{L}])robin(?![\p{L}])/iu);
    expect(all).not.toMatch(/morgan vale/i);
  });
  test("a name inside a longer word is untouched", () => {
    expect(byId.P56.step).toContain("Robinsons");
    const p = makePolicy("x", { owner_names: ["Al"], names: ["Sam"] });
    expect(replaceNames("Alice, Sammy, Salsa and Al's van; SAM and al", p)).toBe("Alice, Sammy, Salsa and your van; someone and you");
  });
  test("SURFACE_NAMES adds names; the default is none", () => {
    expect(makePolicy("x").names).toEqual([]);
    const p = makePolicy("x", {}, { SURFACE_NAMES: "Kim, Lee", SURFACE_OWNER_NAMES: "Jo" });
    expect(replaceNames("Kim and Lee's dog for Jo", p)).toBe("someone and someone's dog for you");
    expect(() => makePolicy("x", { names: "Kim" as any })).toThrow();
  });
});

describe("exclusions", () => {
  const p = policy;
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
      expect(isExcluded(p, t)).toBe(true);
    for (const t of ["embankment", "spending time", "adept", "opt in", "the script", "the current plan", "a parent"])
      expect(isExcluded(p, t)).toBe(false);
  });
  test("the broadened money and health stems", () => {
    for (const t of ["pay the plumber", "Payment due", "the invoice", "Taxes", "rent day", "a loan", "salary review", "car insurance", "a refund", "the doctor", "dentist visit", "a prescription", "therapy", "the clinic", "pharmacy run", "a diagnosis"])
      expect(isExcluded(p, t)).toBe(true);
  });
  test("config adds stems; the defaults stay", () => {
    expect(isExcluded(p, "call the lawyers")).toBe(true);
    expect(isExcluded(makePolicy("x"), "call the lawyers")).toBe(false);
    expect(isExcluded(makePolicy("x"), "the bank")).toBe(true);
  });
  test("a word in the id excludes the row", () => {
    expect(isExcluded(p, "PT3")).toBe(true);
  });
  test("a private term the stems miss leaves the row out whole", () => {
    expect(isExcluded(makePolicy("nothing-here"), "Plan the visit for Juniper at the lake house.")).toBe(false);
    expect(byId.P52).toBeUndefined();
    expect(JSON.stringify(snap)).not.toMatch(/juniper|lake house|cabin/i);
  });
  test("terms are whole-word, any case, with re: for expressions and # for notes", () => {
    const terms = parseTerms("# a note\nJuniper\nre:surprise\\w*\n\n  ");
    expect(terms.length).toBe(2);
    const q = makePolicy("Juniper\nre:surprise\\w*");
    expect(isExcluded(q, "for JUNIPER")).toBe(true);
    expect(isExcluded(q, "junipers")).toBe(false);
    expect(isExcluded(q, "Surprises ahead")).toBe(true);
    expect(isExcluded(q, "unsurprised")).toBe(false);
  });
  test("no terms, or a bad expression, is refused", () => {
    expect(() => parseTerms("")).toThrow();
    expect(() => parseTerms("# only notes\n\n")).toThrow();
    expect(() => parseTerms("re:(")).toThrow();
  });
  test("the private marker is final", () => {
    expect(byId.P53).toBeUndefined();
    expect(JSON.stringify(snap)).not.toMatch(/winter coats/i);
    expect(markedPrivate({ private: "yes" }, "| P9 | Plain |")).toBe(true);
    expect(markedPrivate({ private: "" }, "| P9 | Plain |")).toBe(false);
    expect(markedPrivate({}, "| P9 | Plain #PRIVATE |")).toBe(true);
    expect(markedPrivate({}, "| P9 | not#private |")).toBe(false);
  });
  test("the snapshot counts what it leaves out and skips", () => {
    // P46, P47, P50, P51 by stems, P52 by a term, P53 by the marker.
    expect(snap.excluded_rows).toBe(6);
    // The row with no id and the row with no valid time.
    expect(snap.skipped_rows).toBe(2);
    expect(built.warnings.length).toBe(2);
    for (const w of built.warnings) expect(w).toMatch(/PENDING\.md:\d+: row skipped/);
    expect(built.warnings[0]).toContain("PENDING.md:22:");
    expect(built.warnings[1]).toContain("PENDING.md:23:");
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
  test("identifiers are stripped from every exported field", () => {
    const t = byId.P54;
    expect(t).toBeDefined();
    const { id, ...rest } = t;
    expect(id).toBe("P54");
    for (const [field, value] of Object.entries(rest)) {
      const v = String(value);
      expect([field, v]).not.toEqual([field, expect.stringMatching(/@|555|www\.|https?:|example\.com|Birch Lane|\bP41\b|\bQ12\b/)]);
    }
    expect(t.title).toContain("a phone number");
    expect(t.step).toContain("another item");
    expect(t.step).toContain("an email address");
    expect(t.waits_for).toBe("A reply at an address");
    expect(t.outcome).toContain("a link");
    expect(t.outcome).toContain("another item");
    expect(t.area).toBe("garden");
    expect(areaOf("see projects/P41")).toBe("other");
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
    const run = ["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG];
    expect(await main([...run, "--out", out, "--key", join(dir, "surface.key")])).toBe(0);
    expect(await main(["--verify", out, "--pub", join(dir, "surface.pub")])).toBe(0);
    expect(await main(["--verify", out, "--pub", join(dir, "surface.pub.b64")])).toBe(0);
    const body = readFileSync(out, "utf8");
    writeFileSync(out, body.replace("Back up", "Back uP"));
    expect(await main(["--verify", out, "--pub", join(dir, "surface.pub")])).toBe(1);
  });
});

describe("the command line fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-cli-"));
  const key = join(dir, "surface.key");
  const quiet = <T>(f: () => Promise<T>) => {
    const err = console.error, log = console.log;
    console.error = console.log = () => {};
    return f().finally(() => ((console.error = err), (console.log = log)));
  };
  test("no terms file, a missing one or an empty one writes nothing", async () => {
    await quiet(() => main(["--keygen", dir]));
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "# notes only\n\n");
    for (const [i, terms] of [[], ["--private-terms", join(dir, "nope.txt")], ["--private-terms", empty]].entries()) {
      const out = join(dir, `out${i}.json`);
      expect(await quiet(() => main(["--record", RECORD, ...terms, "--out", out, "--key", key]))).not.toBe(0);
      expect(existsSync(out)).toBe(false);
    }
  });
  test("--strict refuses malformed rows and writes nothing", async () => {
    const out = join(dir, "strict.json");
    const code = await quiet(() =>
      main(["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--strict", "--out", out, "--key", key]),
    );
    expect(code).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });
  test("a malformed row warns with its path and row number", async () => {
    const lines: string[] = [];
    const err = console.error, log = console.log;
    console.error = (m: string) => void lines.push(m);
    console.log = () => {};
    try {
      await main(["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--out", join(dir, "w.json"), "--key", key]);
    } finally {
      console.error = err;
      console.log = log;
    }
    expect(lines.filter((l) => /^warning: .*PENDING\.md:\d+: row skipped/.test(l)).length).toBe(2);
    expect(lines.join("\n")).not.toContain("no valid time.");
  });
  test("a dry run writes nothing and needs no key", async () => {
    const out: string[] = [];
    const err = console.error, log = console.log;
    console.log = (m: string) => void out.push(m);
    console.error = () => {};
    try {
      expect(await main(["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--dry-run"])).toBe(0);
    } finally {
      console.error = err;
      console.log = log;
    }
    const s = JSON.parse(out.join("\n"));
    expect(s.sig).toBeUndefined();
    expect(s.excluded_rows).toBe(6);
  });
});

describe("one canonical form", () => {
  test("signed bytes are the standard UTF-8 of the canonical JSON", () => {
    const s = { version: 1, made_at: "x", threads: [{ title: "café 😀 𝄞 中 …" }], excluded_rows: 0, skipped_rows: 0 };
    const text = canonical(s);
    expect(Array.from(signedBytes(s as any))).toEqual(Array.from(Buffer.from(text, "utf8")));
  });
  test("the counts are signed", async () => {
    const keys = makeKeyPair();
    const signed = signSnapshot(snap, privateKey(keys.privatePem));
    const raw = rawPublicKey(keys.publicPem);
    expect(await verifySnapshot(signed, raw)).toBe(true);
    expect(await verifySnapshot({ ...signed, excluded_rows: 0 }, raw)).toBe(false);
    const { skipped_rows, ...noCount } = signed;
    expect(await verifySnapshot(noCount, raw)).toBe(false);
  });
});
