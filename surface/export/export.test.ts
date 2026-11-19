import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySnapshot, canonical, fromBase64, WHO } from "../shared/snapshot";
import { cutCodePoints, signedBytes } from "../shared/canonical";
import {
  areaOf,
  buildSnapshot,
  configProblem,
  fold,
  normalise,
  properNounGate,
  whoOf,
  firstSentence,
  leftoverLine,
  leftoverPlace,
  MATCH_SPAN,
  namesLongNumber,
  riskyPattern,
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
  CALENDAR_WORDS,
  COMMON_WORDS,
  COMMON_WORDS_FILE,
  DEFAULT_STEMS,
  gateFixed,
  NAME_WORDS,
  nextToNumber,
  sanitise,
  snapshotIdOf,
  strictProblems,
  unknownTokens,
  checkSigned,
  withKeyId,
  keyIdOfPrivate,
  dateShaped,
  STEP_MAX,
  TITLE_MAX,
} from "./lib";
import { main, PRIVATE_REPORT, PUT_MAX_BYTES, uploadPreflight } from "./index";
import { SCHEMA, snapshotId } from "../shared/snapshot";
import { gitIn, gitRecord, signableRecord, tempRecord } from "./fixtures/temp-record";
import { keyId, STEM_RULES, namesAccount, namesMoney, gateTokens, inflections, NAME_WORDS_COMMON, recordRevision, parseWordList, parseNameWords } from "./lib";
import { DEFAULT_REPORT, insideGitWorkTree, writePrivate } from "./index";
import { keyList } from "../shared/snapshot";
import { fileProblems } from "../check-casts";
import type { KeyEntry } from "../shared/snapshot";

// A one-key list for a raw public key (the key-list entry the Worker and the app hold).
const entry = (raw: Uint8Array, retired = false): KeyEntry[] => [{ id: keyId(raw), raw, retired }];

const FIX = join(import.meta.dir, "fixtures");
const RECORD = join(FIX, "record");
const TERMS = join(FIX, "private-terms.txt");
const CONFIG = join(FIX, "exporter.json");
const NOW = new Date("2026-11-18T12:00:00Z");
const policy = makePolicy(readFileSync(TERMS, "utf8"), JSON.parse(readFileSync(CONFIG, "utf8")));
const built = buildSnapshot(RECORD, policy, NOW);
const snap = built.snapshot;
const byId = Object.fromEntries(snap.threads.map((t) => [t.id, t]));
// The fixture record without the rows holding an unknown word, which the signer refuses whatever the
// flags (eighth round): what a plain signed export of the fixture uses.
const SIGNABLE = signableRecord();
const signableSnap = buildSnapshot(SIGNABLE, policy, NOW).snapshot;

describe("the open list", () => {
  test("reads the open table and not the Done table", () => {
    const ids = openRows(readFileSync(join(RECORD, "state", "PENDING.md"), "utf8")).map((r) => r.id);
    expect(ids).toContain("P40");
    expect(ids).not.toContain("P30");
    expect(ids).not.toContain("P31");
  });

  test("snapshot shape", () => {
    expect(snap.version).toBe(2);
    expect(snap.app).toBe("harness-surface");
    expect(snap.purpose).toBe("in-motion-snapshot");
    expect(snap.made_at).toBe(NOW.toISOString());
    for (const t of snap.threads)
      expect(Object.keys(t).sort()).toEqual(
        ["area", "id", "last_moved", "outcome", "state", "step", "title", "waits_for", "who"].sort(),
      );
    expect(Object.keys(snap).sort()).toEqual(["app", "excluded_rows", "made_at", "purpose", "revision", "skipped_rows", "threads", "version"]);
    expect(snap.revision).toBeNull();
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
  test("the assistant's, waiting on the owner by its Waits for", () => {
    expect(byId.P45.who).toBe("the assistant");
    expect(byId.P45.state).toBe("waiting on you");
  });
  test("the assistant's, moving", () => {
    expect(byId.P49.who).toBe("the assistant");
    expect(byId.P49.state).toBe("moving");
    expect(byId.P49.waits_for).toBe("The registrar's notice");
  });
  test("every who and every state is covered by the fixtures", () => {
    expect(new Set(snap.threads.map((t) => t.who))).toEqual(
      new Set(["you", "the assistant", "a build job", "a laptop session", "at his PC", "someone"]),
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
    const seg = Reflect.get(Intl, "Segmenter");
    try {
      Reflect.deleteProperty(Intl, "Segmenter");
      expect(cutCodePoints("ab😀😀😀", 4)).toBe("ab😀…");
      expect(cutCodePoints("𝄞".repeat(5), 3)).toBe("𝄞𝄞…");
    } finally {
      Reflect.set(Intl, "Segmenter", seg);
    }
    expect(typeof Reflect.get(Intl, "Segmenter")).toBe("function");
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
    expect(t.who).toBe("the assistant");
    expect(t.title).toBe("your school form, for you to sign.");
    // "Robinsons" is not a listed name, but a capitalised word mid-sentence: the gate takes it.
    expect(t.step).toBe("Put the form where you sees it; ask the someone and someone's sister too.");
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
    expect(replaceNames("ask the Robinsons", policy)).toBe("ask the Robinsons");
    const p = makePolicy("x", { owner_names: ["Al"], names: ["Sam"] });
    expect(replaceNames("Alice, Sammy, Salsa and Al's van; SAM and al", p)).toBe("Alice, Sammy, Salsa and your van; someone and you");
  });
  test("SURFACE_NAMES adds names; the default is none", () => {
    expect(makePolicy("x").names).toEqual([]);
    const p = makePolicy("x", {}, { SURFACE_NAMES: "Kim, Lee", SURFACE_OWNER_NAMES: "Jo" });
    expect(replaceNames("Kim and Lee's dog for Jo", p)).toBe("someone and someone's dog for you");
    expect(() => makePolicy("x", JSON.parse('{"names": "Kim"}'))).toThrow();
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
    expect(isExcluded(p, "PT")).toBe(true);
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
    // P46, P47, P50, P51 by stems, P52 by a term, P53 by the marker, P57 to P76 by money,
    // health and the normal form, P78 to P97 by the fifth round's stems, P98 by a long number.
    expect(snap.excluded_rows).toBe(47);
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
    expect(areaOf("see projects/P41", policy)).toBe("other");
  });
});

describe("signature", () => {
  const keys = makeKeyPair();
  const signed = signSnapshot(signableSnap, privateKey(keys.privatePem), policy);
  const raw = rawPublicKey(keys.publicPem);

  test("key id is the first 16 hex of the public key's sha256", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(signed.key_id).toBe(hex.slice(0, 16));
    expect(rawPublicKey(keys.publicRaw)).toEqual(raw);
  });

  test("a signed snapshot verifies", async () => {
    expect(await verifySnapshot(signed, entry(raw))).toBe(true);
  });

  test("one tampered byte fails", async () => {
    const text = canonical(signed);
    const i = text.indexOf("Pick the school");
    const tampered = JSON.parse(text.slice(0, i) + "p" + text.slice(i + 1));
    expect(await verifySnapshot(tampered, entry(raw))).toBe(false);
    const sigBytes = fromBase64(signed.sig);
    sigBytes[0] ^= 1;
    expect(await verifySnapshot({ ...signed, sig: btoa(String.fromCharCode(...sigBytes)) }, entry(raw))).toBe(false);
  });

  test("another key fails", async () => {
    expect(await verifySnapshot(signed, entry(rawPublicKey(makeKeyPair().publicPem)))).toBe(false);
  });

  test("the command line writes and verifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-"));
    expect(await main(["--keygen", dir])).toBe(0);
    const out = join(dir, "snap.json");
    const run = ["--record", SIGNABLE, "--private-terms", TERMS, "--config", CONFIG];
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
      await main(["--record", SIGNABLE, "--private-terms", TERMS, "--config", CONFIG, "--out", join(dir, "w.json"), "--key", key]);
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
    expect(s.excluded_rows).toBe(47);
  });
});

describe("one canonical form", () => {
  test("signed bytes are the standard UTF-8 of the canonical JSON", () => {
    const s = { version: 2, app: "a", purpose: "p", key_id: "k", made_at: "x", revision: null, threads: [{ title: "café 😀 𝄞 中 …" }], excluded_rows: 0, skipped_rows: 0 };
    const text = canonical(s);
    expect(Array.from(signedBytes(s))).toEqual(Array.from(Buffer.from(text, "utf8")));
  });
  test("the counts are signed", async () => {
    const keys = makeKeyPair();
    const signed = signSnapshot(signableSnap, privateKey(keys.privatePem), policy);
    const raw = rawPublicKey(keys.publicPem);
    expect(await verifySnapshot(signed, entry(raw))).toBe(true);
    expect(await verifySnapshot({ ...signed, excluded_rows: 0 }, entry(raw))).toBe(false);
    const { skipped_rows, ...noCount } = signed;
    expect(await verifySnapshot(noCount, entry(raw))).toBe(false);
  });
});

const capture = async (f: () => Promise<number>) => {
  const err: string[] = [], out: string[] = [];
  const e = console.error, l = console.log;
  console.error = (m: string) => void err.push(String(m));
  console.log = (m: string) => void out.push(String(m));
  try {
    return { code: await f(), err: err.join("\n"), out: out.join("\n") };
  } finally {
    console.error = e;
    console.log = l;
  }
};

describe("who is a fixed word", () => {
  const row = (who: string) => openRows(readFileSync(join(tempRecord([`| P1 | Plain. | ${who} | Go. | | Done. | 2026-11-01 |`]), "state", "PENDING.md"), "utf8"))[0];
  test("any other person is someone; the assistant is the assistant", () => {
    expect(whoOf(row("Kestrel"), undefined, policy.owners)).toBe("someone");
    expect(whoOf(row("Morgan Vale"), undefined, policy.owners)).toBe("someone");
    expect(whoOf(row("Cain"), undefined, policy.owners)).toBe("the assistant");
    expect(whoOf(row("robin"), undefined, policy.owners)).toBe("you");
  });
  test("every exported who is on the shared list, never the Who cell", () => {
    for (const t of snap.threads) expect(WHO as readonly string[]).toContain(t.who);
    expect(byId.P77.who).toBe("someone");
    expect(JSON.stringify(snap)).not.toMatch(/kestrel/i);
  });
});

describe("the area", () => {
  test("only an area on the config's list is exported", () => {
    expect(areaOf("for projects/garden", policy)).toBe("garden");
    expect(areaOf("for projects/Garden", policy)).toBe("garden");
    expect(areaOf("for projects/shed", policy)).toBe("other");
    expect(areaOf("for projects/garden", makePolicy("x"))).toBe("other");
  });
  test("a folder named with a private term or a stem is not exported as an area", () => {
    const p = makePolicy(readFileSync(TERMS, "utf8"), { areas: ["juniper", "banking", "surprise-party", "garden"] });
    expect(areaOf("see projects/juniper", p)).toBe("other");
    expect(areaOf("see projects/banking", p)).toBe("other");
    expect(areaOf("see projects/surprise-party", p)).toBe("other");
    expect(areaOf("see projects/garden", p)).toBe("garden");
    // And the row itself never exports.
    const rec = tempRecord(["| P1 | Tidy projects/juniper. | Cain | Go. | | Done. | 2026-11-01 |"]);
    const b = buildSnapshot(rec, p, NOW);
    expect(b.snapshot.threads.length).toBe(0);
    expect(b.snapshot.excluded_rows).toBe(1);
  });
});

describe("each part of a name", () => {
  const p = makePolicy("x", { owner_names: ["Robin Ash"], names: ["Morgan Vale"] });
  test("a first name alone, a surname alone", () => {
    expect(replaceNames("ask Morgan today", p)).toBe("ask someone today");
    expect(replaceNames("ask Vale today", p)).toBe("ask someone today");
    expect(replaceNames("for Ash to sign", p)).toBe("for you to sign");
    expect(replaceNames("ask Morgan Vale's sister", p)).toBe("ask someone's sister");
  });
  test("a hyphenated or apostrophe-joined name is one someone", () => {
    expect(replaceNames("ask Ann-Vale today", p)).toBe("ask someone today");
    expect(replaceNames("ask Vale-Smith's dog", p)).toBe("ask someone's dog");
    expect(replaceNames("ask O'Morgan", p)).toBe("ask someone");
    expect(replaceNames("ask Morgan-Vale now", p)).not.toContain("-");
  });
  test("an accented or styled variant is matched by the plain name", () => {
    expect(replaceNames("ask Mórgan and VALÉ", p)).toBe("ask someone and someone");
    expect(replaceNames(normalise("ask \uff2d\uff4f\uff52\uff47\uff41\uff4e"), p)).toBe("ask someone");
    expect(byId.P77.waits_for).toBe("someone's reply");
    expect(byId.P77.title).toBe("Return the drill to someone and someone next door.");
  });
});

describe("the proper-noun gate", () => {
  test("a capitalised word mid-sentence becomes someone; sentence starts and the allow list stay", () => {
    const g = properNounGate("Meet Kestrel on Friday 21 November at the Worker. Then Paris's train, OK.", policy.allowWords);
    expect(g.text).toBe("Meet someone on Friday 21 November at the Worker. Then someone's train, OK.");
    expect(g.words).toEqual(["Kestrel", "Paris's"]);
  });
  test("no capitalised word is left in the fixture snapshot but on the allow list", () => {
    for (const t of snap.threads)
      for (const field of ["title", "step", "waits_for", "outcome"] as const) {
        const g = properNounGate(t[field] ?? "", policy.allowWords);
        expect([t.id, field, g.words]).toEqual([t.id, field, []]);
      }
  });
  test("the fixture's leftovers are named by row, field and word", () => {
    const lines = built.leftovers.map(leftoverLine);
    expect(lines.some((l) => /PENDING\.md:45: title: Kestrel$/.test(l))).toBe(true);
    expect(lines.some((l) => /PENDING\.md:24: step: Robinsons$/.test(l))).toBe(true);
    // The place alone carries no word.
    expect(built.leftovers.map(leftoverPlace).join("\n")).not.toMatch(/Kestrel|Robinsons/);
  });

  const dir = mkdtempSync(join(tmpdir(), "surface-gate-"));
  const key = join(dir, "surface.key");
  const rec = tempRecord(["| P1 | Return the drill to Kestrel next door, then lunch. | Cain | Ring at lunch. | | Drill back. | 2026-11-01 |"]);
  const run = ["--record", rec, "--private-terms", TERMS, "--config", CONFIG];
  test("under --strict a leftover fails the run: exit 1, nothing written, the field and row only, never the word", async () => {
    await capture(() => main(["--keygen", dir]));
    const out = join(dir, "strict.json");
    const r = await capture(() => main([...run, "--strict", "--out", out, "--key", key]));
    expect(r.code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(r.err).toMatch(/PENDING\.md:5: title$/m);
    expect(r.err).not.toContain("Kestrel");
    expect(r.err).not.toContain("drill");
    expect(r.err).not.toContain("next door");
    expect(r.out).toBe("");
  });
  test("without --strict it is replaced and written", async () => {
    const out = join(dir, "plain.json");
    expect((await capture(() => main([...run, "--out", out, "--key", key]))).code).toBe(0);
    const s = JSON.parse(readFileSync(out, "utf8"));
    expect(s.threads[0].title).toBe("Return the drill to someone next door, then lunch.");
  });
  test("a dry run never prints the words: counts only on stderr, the words in a --report file with mode 0600", async () => {
    const r = await capture(() => main([...run, "--dry-run"]));
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("Kestrel");
    expect(r.err).not.toContain(PRIVATE_REPORT);
    expect(r.err).toMatch(/1 capitalised word\(s\) replaced/);
    expect(r.err).toMatch(/--report \[<file>\]/);
    expect(r.out).not.toContain("Kestrel");
    expect(JSON.parse(r.out).threads[0].title).toBe("Return the drill to someone next door, then lunch.");
    const file = join(mkdtempSync(join(tmpdir(), "surface-report-")), "report.txt");
    const w = await capture(() => main([...run, "--dry-run", "--report", file]));
    expect(w.code).toBe(0);
    expect(w.err).not.toContain("Kestrel");
    expect(w.out).not.toContain("Kestrel");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines[0]).toBe(PRIVATE_REPORT);
    expect(lines.some((l) => /PENDING\.md:5: title: Kestrel$/.test(l))).toBe(true);
    // Run again: the file is replaced, still 0600.
    chmodSync(file, 0o644);
    expect((await capture(() => main([...run, "--dry-run", "--report", file]))).code).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  test("--report goes only with --dry-run", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "surface-report-")), "report.txt");
    const r = await capture(() => main([...run, "--report", file, "--out", join(dir, "x.json"), "--key", key]));
    expect(r.code).toBe(2);
    expect(existsSync(file)).toBe(false);
  });
  test("a dry run under --strict fails on a leftover with no word and no snapshot", async () => {
    const r = await capture(() => main([...run, "--dry-run", "--strict"]));
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).not.toContain("Kestrel");
  });
  test("a plain run says only how many words were replaced", async () => {
    const r = await capture(() => main([...run, "--out", join(dir, "count.json"), "--key", key]));
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/1 capitalised word\(s\) replaced/);
    expect(r.err).not.toContain("Kestrel");
  });
});

describe("the config fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-config-"));
  const key = join(dir, "surface.key");
  const write = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name));
  test("its checks", () => {
    expect(configProblem({ owner_names: ["Robin"], names: [] })).toBeNull();
    expect(configProblem({ owner_names: ["owner", "The Owner"], names: [] })).toMatch(/no owner name/);
    expect(configProblem({ names: [] })).toMatch(/no owner name/);
    expect(configProblem({ names: [] }, { SURFACE_OWNER_NAMES: "Robin" })).toBeNull();
    expect(configProblem({ owner_names: ["Robin"] })).toMatch(/"names" is missing/);
    expect(configProblem([])).toMatch(/not a JSON object/);
    expect(replaceNames("the van", makePolicy("x", { owner_names: ["the owner", "Robin"], names: [] }))).toBe("the van");
    expect(configProblem({ owner_names: ["Robin"], names: [], areas: "garden" })).toMatch(/areas/);
  });
  const bad = () => [
    ["no owner", write("noowner.json", '{"owner_names": ["owner"], "names": []}')],
    ["no names", write("nonames.json", '{"owner_names": ["Robin"]}')],
    ["bad JSON", write("bad.json", '{"owner_names": ["Robin"], names: }')],
  ];
  test("a bad config is exit 2 with one clean line, and nothing is written", async () => {
    await capture(() => main(["--keygen", dir]));
    for (const [what, cfg] of bad()) {
      const out = join(dir, "out.json");
      const r = await capture(() => main(["--record", RECORD, "--private-terms", TERMS, "--config", cfg, "--out", out, "--key", key]));
      expect([what, r.code]).toEqual([what, 2]);
      expect(existsSync(out)).toBe(false);
      expect(r.err.split("\n").length).toBe(1);
      expect(r.err).not.toMatch(/\n\s+at /);
    }
    const none = await capture(() => main(["--record", RECORD, "--private-terms", TERMS, "--out", join(dir, "o.json"), "--key", key]));
    expect(none.code).toBe(2);
  });
  test("a bad config with --put makes no network call and writes nothing", async () => {
    for (const [what, cfg] of bad()) {
      let calls = 0;
      const out = join(dir, "put.json");
      const env = {
        SURFACE_PUT_HOST: "surface.example.com",
        SURFACE_ACCESS_CLIENT_ID: "id-example",
        SURFACE_ACCESS_CLIENT_SECRET: "secret-example",
        SURFACE_PUBLISHER_TOKEN: "publisher-example",
      };
      const r = await capture(() =>
        main(["--record", RECORD, "--private-terms", TERMS, "--config", cfg, "--key", key, "--out", out, "--put", "https://surface.example.com/snapshot"], {
          fetch: async () => (calls++, new Response("{}")),
          env,
        }),
      );
      expect([what, r.code, calls, existsSync(out)]).toEqual([what, 2, 0, false]);
    }
  });
});

describe("money and health, in any form", () => {
  test("currency symbols, ISO codes by a number, and amounts", () => {
    for (const t of ["€40 left", "it was $5", "£12", "¥300", "₹500", "USD 120", "120 EUR", "40GBP", "50 dollars", "five quid", "a hundred bucks", "2k euros", "10 pence"])
      expect([t, isExcluded(policy, t)]).toEqual([t, true]);
    for (const t of ["USB stick", "EURO trip planning", "pounds the table", "a few more", "the 2 dogs", "Ten minutes"])
      expect([t, isExcluded(policy, t)]).toEqual([t, false]);
  });
  test("the new stems", () => {
    for (const t of ["got paid", "what is owed", "the mortgage", "credit line", "the lost card", "hospital visit", "after surgery", "ring the GP", "the appointment", "mental load", "psychiatrist", "IRS letter", "dental check", "orthodontist", "periodontal", "dentures", "a tooth", "teeth cleaning"])
      expect([t, isExcluded(policy, t)]).toEqual([t, true]);
  });
  test("every money and health fixture row is left out", () => {
    for (let i = 57; i <= 76; i++) expect([`P${i}`, byId[`P${i}`]]).toEqual([`P${i}`, undefined]);
  });
  test("one normal form: accents, zero-width and bidi characters, full-width letters", () => {
    expect(isExcluded(policy, "Wrap the Jünîper gift")).toBe(true); // a plain term matches its accented variant
    expect(isExcluded(makePolicy("Jünîper"), "wrap the juniper gift")).toBe(true);
    expect(isExcluded(policy, "Ba\u200Bnk run")).toBe(true);
    expect(isExcluded(policy, "the \u202Ebank\u202C run")).toBe(true);
    expect(isExcluded(policy, "the \uff42\uff41\uff4e\uff4b slip")).toBe(true);
    expect(isExcluded(policy, "the ｄｏｃｔｏｒ")).toBe(true);
    expect(fold("MÓRGAN")).toBe("morgan");
    expect(normalise("a\u200Bb\u2066c\u2069\u200Fd\uFEFF")).toBe("abcd");
    expect(JSON.stringify(snap)).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/);
  });
});

describe("the synthetic record", () => {
  test("passes --strict with the fixture config, made-up rows only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-synthetic-"));
    await capture(() => main(["--keygen", dir]));
    const out = join(dir, "synthetic.json");
    const run = ["--record", join(FIX, "synthetic"), "--private-terms", TERMS, "--config", CONFIG, "--strict"];
    const r = await capture(() => main([...run, "--out", out, "--key", join(dir, "surface.key")]));
    expect(r.code).toBe(0);
    const s = JSON.parse(readFileSync(out, "utf8"));
    expect(s.threads.map((t: { id: string }) => t.id)).toEqual(["S1", "S2"]);
    expect(s.excluded_rows + s.skipped_rows).toBe(0);
  });
});

describe("fifth round: the gate takes sentence starts too", () => {
  test("a capitalised word at a sentence start is a candidate unless it is a common word or allowed", () => {
    const g = properNounGate("Ottoline wants it. Then Penrose rings. Read it on Monday 23 November.", policy.allowWords);
    expect(g.text).toBe("someone wants it. Then someone rings. Read it on Monday 23 November.");
    expect(g.words).toEqual(["Ottoline", "Penrose"]);
    expect(properNounGate("Follow-up for Re-Kestrel.", policy.allowWords).words).toEqual(["Re-Kestrel"]);
    expect(properNounGate("Don't wait; Let's go. It’s done.", policy.allowWords).words).toEqual([]);
  });
  test("the bundled list is common words only; months and weekdays are not on it", () => {
    expect(policy.allowWords.has("monday")).toBe(false);
    expect(policy.allowWords.has("december")).toBe(false);
    for (const name of ["will", "mark", "bill", "grace", "hope", "rose", "kestrel"]) expect(policy.allowWords.has(name)).toBe(false);
  });
  test("a sentence never ends after Mr, Mrs, Ms, Dr or St", () => {
    expect(firstSentence("Waiting on Mr. Penrose. Then paint.", 140)).toBe("Waiting on Mr. Penrose.");
    for (const a of ["Mrs", "Ms", "Dr", "St", "mr"]) expect(firstSentence(`Ask ${a}. Vale now. More.`, 140)).toBe(`Ask ${a}. Vale now.`);
    expect(firstSentence("Fix it. Dr. Vale.", 140)).toBe("Fix it.");
  });
  test("the fixture rows: a name at a title's start, leading waits_for, after an abbreviation", () => {
    expect(byId.P100.title).toBe("someone wants the ladder back.");
    expect(byId.P101.waits_for).toBe("someone to send the draft");
    expect(byId.P102.title).toBe("Fix the gate, waiting on Mr. someone.");
    const words = built.leftovers.map(leftoverLine);
    expect(words.some((l) => /:68: title: Ottoline$/.test(l))).toBe(true);
    expect(words.some((l) => /:69: waits_for: Thessaly$/.test(l))).toBe(true);
    expect(words.some((l) => /:70: title: Penrose$/.test(l))).toBe(true);
  });

  const dir = mkdtempSync(join(tmpdir(), "surface-start-"));
  const key = join(dir, "surface.key");
  const cases: [string, string, keyof (typeof snap.threads)[number], string][] = [
    ["a name starting the title", "| P1 | Ottoline wants the ladder back. | Cain | Fetch it. | | Ladder returned. | 2026-11-01 |", "title", "someone wants the ladder back."],
    ["a name leading waits_for", "| P1 | Read the draft. | Cain | Read it. | Thessaly to send the draft | Draft read. | 2026-11-01 |", "waits_for", "someone to send the draft"],
    ["a name after an abbreviation", "| P1 | Fix the gate, waiting on Mr. Penrose. | Cain | Ask. | | Gate shut. | 2026-11-01 |", "title", "Fix the gate, waiting on Mr. someone."],
    ["a full-width name mid-sentence", "| P1 | Return the ladder to Ｏｔｔｏｌｉｎｅ today. | Cain | Ask. | | Ladder returned. | 2026-11-01 |", "title", "Return the ladder to someone today."],
    ["an accented name mid-sentence", "| P1 | Return the ladder to Ásta today. | Cain | Ask. | | Ladder returned. | 2026-11-01 |", "title", "Return the ladder to someone today."],
  ];
  for (const [what, row, field, want] of cases) {
    test(`${what}: fails --strict without the word; becomes someone otherwise`, async () => {
      await capture(() => main(["--keygen", dir]));
      const run = ["--record", tempRecord([row]), "--private-terms", TERMS, "--config", CONFIG];
      const out = join(mkdtempSync(join(dir, "case-")), "s.json");
      const r = await capture(() => main([...run, "--strict", "--out", out, "--key", key]));
      expect(r.code).toBe(1);
      expect(existsSync(out)).toBe(false);
      expect(r.err).toMatch(new RegExp(`PENDING\\.md:5: ${field}$`, "m"));
      expect(r.err).not.toMatch(/Ottoline|Thessaly|Penrose|Ásta|Ｏ/);
      expect((await capture(() => main([...run, "--out", out, "--key", key]))).code).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).threads[0][field]).toBe(want);
    });
  }
  test("the gate reads the case-preserved form: normalising doesn't lose a capital", () => {
    expect(normalise("Ｏｔｔｏ")).toBe("Otto");
    expect(properNounGate(normalise("ask Ｏｔｔｏ"), policy.allowWords).words).toEqual(["Otto"]);
  });
});

describe("fifth round: the dry run and failed runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-dry-"));
  const key = join(dir, "surface.key");
  const write = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name));
  const exit2 = () => [
    ["no real owner name", ["--private-terms", TERMS, "--config", write("noowner.json", '{"owner_names": ["owner"], "names": []}')]],
    ["no names list", ["--private-terms", TERMS, "--config", write("nonames.json", '{"owner_names": ["Robin"]}')]],
    ["bad config JSON", ["--private-terms", TERMS, "--config", write("bad.json", "{nope")]],
    ["a missing config", ["--private-terms", TERMS, "--config", join(dir, "nope.json")]],
    ["no config at all", ["--private-terms", TERMS]],
    ["a missing terms file", ["--private-terms", join(dir, "nope.txt"), "--config", CONFIG]],
    ["an empty terms file", ["--private-terms", write("empty.txt", "# notes only\n\n"), "--config", CONFIG]],
    ["no terms flag", ["--config", CONFIG]],
    ["an invalid re: term", ["--private-terms", write("badre.txt", "Juniper\nre:(unclosed\n"), "--config", CONFIG]],
  ] as [string, string[]][];
  test("each exit-2 check runs under --dry-run and prints no snapshot", async () => {
    for (const [what, args] of exit2()) {
      const r = await capture(() => main(["--record", RECORD, ...args, "--dry-run"]));
      expect([what, r.code, r.out]).toEqual([what, 2, ""]);
    }
  });
  test("--dry-run with --put or --out is refused before anything", async () => {
    let calls = 0;
    const io = { fetch: async () => (calls++, new Response("{}")), env: {} };
    const a = await capture(() => main(["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--dry-run", "--put", "https://x.example/snapshot"], io));
    expect([a.code, a.out, calls]).toEqual([2, "", 0]);
    const b = await capture(() => main(["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--dry-run", "--out", join(dir, "x.json")]));
    expect([b.code, b.out, existsSync(join(dir, "x.json"))]).toEqual([2, "", false]);
  });
  test("a failed run, in any mode, writes no file, keeps an existing one and makes no network call", async () => {
    await capture(() => main(["--keygen", dir]));
    const env = {
      SURFACE_PUT_HOST: "surface.example.com",
      SURFACE_ACCESS_CLIENT_ID: "id-example",
      SURFACE_ACCESS_CLIENT_SECRET: "secret-example",
      SURFACE_PUBLISHER_TOKEN: "publisher-example",
    };
    const leftover = tempRecord(["| P1 | Ottoline wants the ladder back. | Cain | Fetch it. | | Done. | 2026-11-01 |"]);
    const runs: [string, string[]][] = [
      ...exit2().map(([w, a]) => [w, ["--record", RECORD, ...a]] as [string, string[]]),
      ["a leftover under --strict", ["--record", leftover, "--private-terms", TERMS, "--config", CONFIG, "--strict"]],
      ["the fixture under --strict", ["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--strict"]],
      ["a bad key", ["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--key-override"]],
      ["no record", ["--record", join(dir, "no-record"), "--private-terms", TERMS, "--config", CONFIG]],
    ];
    for (const [what, args] of runs) {
      for (const put of [false, true]) {
        const fresh = join(dir, "fresh.json");
        const kept = write("kept.json", "earlier\n");
        let calls = 0;
        const io = { fetch: async () => (calls++, new Response("{}")), env };
        const k = what === "a bad key" ? write("bad.key", "not a key") : key;
        const base = args.filter((a) => a !== "--key-override");
        const tail = put ? ["--put", "https://surface.example.com/snapshot"] : [];
        const r1 = await capture(() => main([...base, "--key", k, "--out", fresh, ...tail], io));
        const r2 = await capture(() => main([...base, "--key", k, "--out", kept, ...tail], io));
        expect([what, put, r1.code === 0, r2.code === 0]).toEqual([what, put, false, false]);
        expect([what, put, existsSync(fresh), readFileSync(kept, "utf8"), calls]).toEqual([what, put, false, "earlier\n", 0]);
      }
    }
  });
});

describe("fifth round: the terms file", () => {
  test("an invalid re: line exits 2 naming the line, with no stack trace and nothing written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-terms-"));
    await capture(() => main(["--keygen", dir]));
    const terms = join(dir, "terms.txt");
    writeFileSync(terms, "# note\nJuniper\nre:[unclosed\n");
    const out = join(dir, "o.json");
    const r = await capture(() => main(["--record", RECORD, "--private-terms", terms, "--config", CONFIG, "--out", out, "--key", join(dir, "surface.key")]));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/:3: not a valid regular expression/);
    expect(r.err).not.toContain("unclosed");
    expect(r.err).not.toMatch(/\n\s+at /);
    expect(r.err.split("\n").length).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
  test("a pattern that could backtrack without bound is refused at load", () => {
    for (const bad of ["(a+)+", "(\\w*x)*", "(a|aa)+", "((ab)*)+", "(x{2,})*", "(a)\\1", "(?<n>a)\\k<n>"])
      expect([bad, riskyPattern(bad)]).not.toEqual([bad, null]);
    for (const ok of ["surprise\\w*", "(foo|bar)s?", "a+b+", "[(+*)]+", "(ab)+", "\\(a+\\)+"])
      expect([ok, riskyPattern(ok)]).toEqual([ok, null]);
    expect(() => parseTerms("re:(a+)+$")).toThrow(/:1: .*without bound/);
    expect(() => parseTerms("re:a)|(b")).toThrow(/:1: not a valid regular expression/);
  });
  test("a cell over MATCH_SPAN characters is left out whole; a cell under it is matched whole", () => {
    expect(isExcluded(makePolicy("Juniper"), "a ".repeat(6000) + "Juniper")).toBe(true);
    expect(isExcluded(makePolicy("Juniper"), "a ".repeat(6000))).toBe(true);
    // A term at the very end of a cell just under the cap is found: there are no chunks to fall between.
    const cell = "a ".repeat((MATCH_SPAN - 10) / 2) + "Juniper";
    expect(cell.length).toBeLessThanOrEqual(MATCH_SPAN);
    expect(isExcluded(makePolicy("Juniper"), cell)).toBe(true);
    expect(isExcluded(makePolicy("Juniper"), "a ".repeat((MATCH_SPAN - 10) / 2))).toBe(false);
  });
});

describe("fifth round: stems and long numbers", () => {
  const stems: [string, string][] = [
    ["bill", "the water bill"], ["fee", "a late fee"], ["cost", "the cost"], ["price", "price it"], ["quote", "a quote"],
    ["deposit", "the deposit"], ["venmo", "Venmo them"], ["cash", "some cash"], ["owe", "what we owe"],
    ["symptom", "the symptoms"], ["scan", "the scan"], ["mri", "an MRI"], ["blood", "blood test"],
    ["vaccin", "the vaccination"], ["pregnan", "pregnancy class"], ["allerg", "an allergy"], ["pill", "the pills"],
    ["dose", "second dose"], ["sick", "sick note"], ["counsel", "counselling"],
  ];
  test("each new stem leaves its text out", () => {
    for (const [stem, text] of stems) expect([stem, isExcluded(policy, text)]).toEqual([stem, true]);
  });
  test("each new stem's fixture row is left out", () => {
    for (let i = 78; i <= 97; i++) expect([`P${i}`, byId[`P${i}`]]).toEqual([`P${i}`, undefined]);
  });
  test("a run of four or more digits that isn't a date leaves the row out", () => {
    expect(namesLongNumber("the card ending 4421")).toBe(true);
    expect(namesLongNumber("ref 12345")).toBe(true);
    expect(namesLongNumber("call +1 555 201 7788")).toBe(true);
    expect(namesLongNumber("ending ４４２１")).toBe(true);
    for (const t of ["on 2026-11-18", "by 11/20/2026", "in 2026", "since 1999", "at 7:30, 3 boxes", "after P1040", "row p12345"])
      expect([t, namesLongNumber(t)]).toEqual([t, false]);
    expect(byId.P98).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain("4421");
  });
  test("a row with only dates in it is kept", () => {
    expect(byId.P99.title).toBe("Move the skip to 11/20/2026, then 2026-11-21.");
    expect(byId.P99.step).toBe("Ring on 2026-11-19 in 2026.");
  });
});

describe("sixth round: names that double as common words", () => {
  test("the bundled list shares no word with the name list, and months and weekdays are off it", () => {
    const inFile = COMMON_WORDS_FILE.map((w) => w.toLowerCase());
    expect(inFile.filter((w) => NAME_WORDS.has(w))).toEqual([]);
    expect(inFile.filter((w) => CALENDAR_WORDS.includes(w))).toEqual([]);
    for (const w of ["may", "june", "april", "august", "will", "mark", "grace", "rose", "hope", "pat", "sue", "jack", "rich", "bob", "cook"]) {
      expect([w, NAME_WORDS.has(w)]).toEqual([w, true]);
      expect([w, COMMON_WORDS.includes(w), policy.allowWords.has(w)]).toEqual([w, false, false]);
    }
  });
  test("May, June and Will are gated at a sentence start and mid-sentence", () => {
    for (const t of ["May sends the forms.", "Ask May now.", "June has it.", "Give it to June.", "Will brings it.", "Lend it to Will."])
      expect([t, properNounGate(t, policy.allowWords).words.length]).toEqual([t, 1]);
  });
  test("a month or weekday stays only next to a number or a date", () => {
    const keep = ["Lunch on May 5.", "on 3 June", "the 3rd of May", "Friday 2026-11-20", "Friday, 20 November", "June 2026", "2026-11-20, Friday"];
    for (const t of keep) expect([t, properNounGate(t, new Set(["lunch"])).words]).toEqual([t, []]);
    const gate = ["Ask May.", "on Friday", "June said so", "May's car"];
    for (const t of gate) expect([t, properNounGate(t, policy.allowWords).words.length]).toEqual([t, 1]);
    expect(nextToNumber("x May 5", 2, 3)).toBe(true);
    expect(nextToNumber("x May y", 2, 3)).toBe(false);
  });
  test("the fixture rows P103 to P108 are someone; P109 keeps its dates", () => {
    expect(byId.P103.title).toBe("someone sends the school forms back.");
    expect(byId.P104.title).toBe("Ask someone about the school forms.");
    expect(byId.P107.title).toBe("someone brings the drill over.");
    expect(byId.P108.title).toBe("Lend the drill to someone.");
    expect(byId.P109.title).toBe("Plan a lunch out on May 5.");
    expect(byId.P109.step).toBe("Book a table for 3 June.");
  });
});

describe("sixth round: unknown words", () => {
  test("lower-case and uncased words not in the word list are listed; capitals, numbers and known words are not", () => {
    expect(unknownTokens("the zorblat quillon at 7:30 with someone's 中文 Ladder", policy.vocabulary)).toEqual(["zorblat", "quillon", "中文"]);
    expect(unknownTokens("you and your pick, a link, an email address", policy.vocabulary)).toEqual([]);
  });
  test("seventh round: the dry run's report lists them; --strict fails on them in every field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-unknown-"));
    await capture(() => main(["--keygen", dir]));
    const rec = tempRecord(["| P1 | Sort the tools. | Cain | Sort the zorblat. | the zorblat crew | Done. | 2026-11-01 |"]);
    const run = ["--record", rec, "--private-terms", TERMS, "--config", CONFIG];
    const r = await capture(() => main([...run, "--strict", "--out", join(dir, "o.json"), "--key", join(dir, "surface.key")]));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown word: .*PENDING\.md:5: waits_for$/m);
    expect(r.err).toMatch(/unknown word: .*PENDING\.md:5: step$/m);
    expect(r.err).not.toContain("zorblat");
    const b = buildSnapshot(rec, policy, NOW);
    expect(strictProblems(b).unknown.map((u) => u.field).sort()).toEqual(["step", "waits_for"]);
    const report = join(mkdtempSync(join(tmpdir(), "surface-unknown-report-")), "report.txt");
    expect((await capture(() => main([...run, "--dry-run", "--report", report]))).code).toBe(0);
    expect(readFileSync(report, "utf8")).toMatch(/PENDING\.md:5: waits_for: zorblat/);
    // The same word in the step alone now fails --strict too.
    const step = tempRecord(["| P1 | Sort the tools. | Cain | Sort the zorblat. | | Done. | 2026-11-01 |"]);
    expect(strictProblems(buildSnapshot(step, policy, NOW)).unknown.map((u) => u.field)).toEqual(["step"]);
    for (const [cell, field] of [["| P1 | Sort the zorblat. | Cain | Sort it. | | Done. | 2026-11-01 |", "title"], ["| P1 | Sort it. | Cain | Sort it. | | The zorblat is done. | 2026-11-01 |", "outcome"]] as const)
      expect([field, strictProblems(buildSnapshot(tempRecord([cell]), policy, NOW)).unknown.map((u) => u.field)]).toEqual([field, [field]]);
  });
});

describe("seventh round: the name gate's tokens", () => {
  test("tokens are runs of Unicode letters; digits and underscores split them", () => {
    expect(gateTokens("abc_def x86 café-crème O'Neill naïve").map((t) => t.text)).toEqual(["abc", "def", "x", "café-crème", "O'Neill", "naïve"]);
    expect(gateTokens("x86")[0].touchesDigit).toBe(true);
  });
  test("possessives and apostrophe forms are taken off before a lookup", () => {
    const forms = (t: string) => gateTokens(t)[0].forms;
    expect(forms("Robin's")).toEqual(["robin's", "robin"]);
    expect(forms("James’s")).toEqual(["james's", "james"]);
    expect(forms("don't")).toEqual(["don't", "do"]);
    expect(forms("can't")).toEqual(["can't", "can"]);
    expect(forms("we'll")).toEqual(["we'll", "we"]);
    expect(forms("they're")).toEqual(["they're", "they"]);
    expect(gateTokens("James' car")[0]).toMatchObject({ text: "James'", possessive: true });
    expect(properNounGate("ask James' crew", policy.allowWords).text).toBe("ask someone's crew");
    expect(properNounGate("Thessaly's crew", policy.allowWords).text).toBe("someone's crew");
    expect(unknownTokens("the garden's gate, it's done", policy.vocabulary)).toEqual([]);
  });
  test("initials are one name; a lone capital other than I and A is an initial", () => {
    expect(properNounGate("ask J.R.R. today", policy.allowWords)).toEqual({ text: "ask someone today", words: ["J.R.R."] });
    expect(properNounGate("ask J. today", policy.allowWords).words).toEqual(["J"]);
    expect(properNounGate("I think A plan works", policy.allowWords).words).toEqual([]);
    expect(properNounGate("at 9 a.m. or 5 P.M.", policy.allowWords).words).toEqual([]);
  });
  test("an all-caps word is capitalised: gated unless allowed", () => {
    expect(properNounGate("for KESTREL now", policy.allowWords).words).toEqual(["KESTREL"]);
    expect(properNounGate("OK, DONE, THE GATE", policy.allowWords).words).toEqual([]);
    expect(properNounGate("KESTREL'S drill", policy.allowWords).text).toBe("someone's drill");
  });
  test("a lower-case word may be an inflection of a known one", () => {
    expect(inflections("brings")).toContain("bring");
    expect(inflections("carried")).toContain("carry");
    expect(inflections("fixing")).toContain("fix");
    expect(inflections("stopped")).toContain("stop");
    expect(unknownTokens("it sorts and sorted the tools", policy.vocabulary)).toEqual([]);
  });
  test("a month or weekday next to a number is a date only when no other name signal is present", () => {
    const allow = policy.allowWords;
    for (const t of ["on May 5", "on 3 June", "Friday, 20 November", "the 3rd of May", "May 5 and 6"])
      expect([t, properNounGate(t, allow).words]).toEqual([t, []]);
    for (const t of ["ask May 5 times", "with June 3 days early", "Mrs. May 12 sent it", "Dr June 2", "Kestrel May 5", "May Kestrel 5", "May's 5 forms"])
      expect([t, properNounGate(t, allow).words.includes(t.match(/May|June/)![0]) || properNounGate(t, allow).words.some((w) => /^(May|June)/.test(w))]).toEqual([t, true]);
  });
  test("a lower-case [common] name-word is known, and reported as name-like; a [names] one is unknown", () => {
    expect(NAME_WORDS_COMMON.has("will")).toBe(true);
    expect(NAME_WORDS.has("doug") && !NAME_WORDS_COMMON.has("doug")).toBe(true);
    expect(unknownTokens("the job will run", policy.vocabulary)).toEqual([]);
    expect(unknownTokens("ask doug", policy.vocabulary)).toEqual(["doug"]);
    expect(sanitise("the job will run", policy).nameLike).toEqual(["will"]);
  });
});

describe("long cells fail closed", () => {
  test("a cell longer than the chunk size leaves the row out, and fails --strict", async () => {
    const long = "word ".repeat(MATCH_SPAN / 4);
    const rec = tempRecord([`| P1 | ${long} | Cain | Go. | | Done. | 2026-11-01 |`]);
    const b = buildSnapshot(rec, policy, NOW);
    expect(b.snapshot.threads.length).toBe(0);
    expect(b.snapshot.excluded_rows).toBe(1);
    expect(b.warnings).toEqual([expect.stringMatching(/PENDING\.md:5: row left out, a cell longer than 4000 characters/)]);
    expect(isExcluded(makePolicy("Juniper"), "a ".repeat(6000))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "surface-long-"));
    await capture(() => main(["--keygen", dir]));
    const r = await capture(() => main(["--record", rec, "--private-terms", TERMS, "--config", CONFIG, "--strict", "--out", join(dir, "o.json"), "--key", join(dir, "surface.key")]));
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "o.json"))).toBe(false);
  });
  test("seventh round: no chunks: a plain term is capped at PLAIN_TERM_MAX, and a cell is matched whole", () => {
    expect(() => makePolicy("y".repeat(2001))).toThrow(/:1: a term longer than 2000/);
    expect(() => makePolicy("y".repeat(2000))).not.toThrow();
    const term = "straddling-term-" + "q".repeat(500);
    // Where the old chunks would have split it: found, since the whole cell is matched.
    const cell = "a ".repeat(1700) + term + " b";
    expect(cell.length).toBeLessThanOrEqual(MATCH_SPAN);
    expect(isExcluded(makePolicy(term), cell)).toBe(true);
  });
});

describe("sixth round: more stems", () => {
  const cases: [string, string][] = [
    ["meds", "the meds"], ["rx", "an Rx"], ["refill", "refill it"], ["biopsy", "the biopsy"], ["chemo", "chemo day"],
    ["cancer", "cancer ward"], ["rehab", "rehab visit"], ["physio", "physiotherapy"], ["lab", "the lab"], ["results", "the results"],
    ["er", "the ER"], ["urgent care", "urgent  care run"], ["injur", "the injury"], ["zelle", "Zelle it"], ["wire", "wire it"],
    ["cheque", "the cheque"], ["check", "check in"], ["tuition", "tuition"], ["fine", "a fine"], ["ticket", "the ticket"],
  ];
  test("each leaves its text out", () => {
    for (const [stem, text] of cases) {
      expect(DEFAULT_STEMS).toContain(stem);
      expect([stem, isExcluded(policy, text)]).toEqual([stem, true]);
    }
    expect(isExcluded(policy, "urgent matters")).toBe(false);
  });
  test("the dry run gives the threads per area", async () => {
    const r = await capture(() => main(["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--dry-run"]));
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/threads per area: garden 1, harness 1, surface 1, other \d+\./);
    expect(built.areas.surface).toBe(1);
  });
});

describe("seventh round: the gate at run time", () => {
  const keys = makeKeyPair();
  const key = privateKey(keys.privatePem);
  const signedOf = () => withKeyId(signableSnap, keyIdOfPrivate(key));
  // A deep copy of the pipeline's object, to tamper with (JSON.parse's result is untyped).
  const copy = (): ReturnType<typeof JSON.parse> => JSON.parse(JSON.stringify(signableSnap));
  test("the fixture's signed object passes the walk, and signing runs it on every call", () => {
    expect(() => checkSigned(signedOf(), policy)).not.toThrow();
    expect(signableSnap.threads.length).toBeGreaterThan(10);
  });
  test("a string that skipped the pipeline is refused by signSnapshot itself, naming the path only", () => {
    const tampered = copy();
    tampered.threads[0].title = "Raw text from Kestrel " + Math.random();
    expect(() => signSnapshot(tampered, key, policy)).toThrow(/snapshot\.threads\[0\]\.title: a string that did not pass/);
    try {
      signSnapshot(tampered, key, policy);
    } catch (e) {
      expect(String(e)).not.toContain("Kestrel");
    }
  });
  test("a string that sanitising again leaves unchanged passes, though sanitise never returned it", () => {
    const t = copy();
    t.threads[0].outcome = "the gate is shut " + Math.floor(Math.random() * 1000) + " times over";
    expect(() => signSnapshot(t, key, policy)).not.toThrow();
  });
  test("unknown fields, dynamic keys, symbol keys, getters and class instances are refused", () => {
    type Loose = ReturnType<typeof JSON.parse>;
    const cases: [string, (s: Loose) => void, RegExp][] = [
      ["a field on the snapshot", (s) => void (s.note = "hello"), /snapshot\.note: a field outside the schema/],
      ["a field on a thread", (s) => void (s.threads[0].extra = "x"), /threads\[0\]\.extra: a field outside the schema/],
      ["a dynamic key", (s) => void (s.threads[0]["k" + Date.now()] = "x"), /a field outside the schema/],
      ["a symbol key", (s) => void (s.threads[0][Symbol("x")] = "x"), /a symbol key/],
      ["a getter", (s) => void Object.defineProperty(s.threads[0], "title", { get: () => "x", enumerable: true }), /not a plain field/],
      ["a hidden field", (s) => void Object.defineProperty(s.threads[0], "hidden", { value: "x", enumerable: false }), /not a plain field/],
      ["a missing field", (s) => void delete s.threads[0].step, /threads\[0\]\.step: missing/],
      ["a class instance", (s) => void (s.threads[0] = Object.assign(Object.create({ x: 1 }), s.threads[0])), /not a plain object/],
      ["an extra array property", (s) => void Object.assign(s.threads, { extra: 1 }), /snapshot\.threads: a field outside the schema/],
      ["an area off the list", (s) => void (s.threads[0].area = "kitchen"), /area: not on the areas list/],
      ["an unknown who", (s) => void (s.threads[0].who = "Kestrel"), /who: not a fixed word/],
      ["a bad id", (s) => void (s.threads[0].id = "not an id"), /id: not a record code/],
      ["a bad time", (s) => void (s.threads[0].last_moved = "yesterday"), /last_moved: not a time/],
      ["a bad revision", (s) => void (s.revision = { seq: 1, commit: "abc", extra: 1 }), /snapshot\.revision/],
      ["a bad version", (s) => void (s.version = 1), /snapshot\.version/],
    ];
    for (const [name, change, why] of cases) {
      const t = copy();
      change(t);
      const outcome = () => {
        try {
          signSnapshot(t, key, policy);
          return "signed";
        } catch (e) {
          return String(e);
        }
      };
      expect([name, outcome()]).toEqual([name, expect.stringMatching(why)]);
    }
  });
  test("an area comes from the config's list, never the record's text", () => {
    expect(areaOf("Work on projects/Garden today", policy)).toBe("garden");
    expect(areaOf("Work on projects/kitchen today", policy)).toBe("other");
    expect(configProblem({ owner_names: ["Robin"], names: [], areas: ["My Garden"] })).toMatch(/an area must be a plain folder name/);
    expect(configProblem({ owner_names: ["Robin"], names: [], areas: ["other"] })).toMatch(/an area must be/);
    const word: string = "anything else";
    expect(() => gateFixed(word)).toThrow();
  });
  test("sanitise is the whole pipeline: normal form, strippers, names, cut, gate", () => {
    const r = sanitise("Ask Ｍｏｒｇａｎ at https://example.com about P41. Then more.", policy, 140);
    expect(r.text).toBe("Ask someone at a link about another item.");
  });
});

describe("seventh round: the cast check (CI)", () => {
  test("no forbidden cast or any outside the sanitiser module", async () => {
    const { castProblems } = await import("../check-casts");
    expect(castProblems(join(import.meta.dir, ".."))).toEqual([]);
  });
});

describe("sixth round: the signed version follows the schema", () => {
  // Each version's schema fingerprint. A change to the signed fields, a thread's fields or a
  // revision's fields changes the fingerprint, so it fails here until the version is bumped and a
  // line added (version 2 was never deployed, so the seventh round settled it in place).
  const KNOWN: Record<number, string> = {
    1: "c21887ca052ccae6", // no app or purpose
    2: "e63f824979560014", // app and purpose (sixth round), key_id and revision (seventh round)
  };
  test("this version's schema is the one pinned for it", async () => {
    const fp = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical({ signed: SCHEMA.signed, thread: SCHEMA.thread, revision: SCHEMA.revision }))),
    );
    const hex = Array.from(fp, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    expect([SCHEMA.version, hex]).toEqual([SCHEMA.version, KNOWN[SCHEMA.version]]);
    expect(new Set(Object.values(KNOWN)).size).toBe(Object.keys(KNOWN).length);
  });
  test("an unknown version, app or purpose doesn't verify, signed or not", async () => {
    const keys = makeKeyPair();
    const signed = signSnapshot(signableSnap, privateKey(keys.privatePem), policy);
    const raw = rawPublicKey(keys.publicPem);
    expect(await verifySnapshot(signed, entry(raw))).toBe(true);
    for (const over of [{ version: 1 }, { version: 3 }, { app: "other-app" }, { purpose: "command" }])
      expect([over, await verifySnapshot({ ...signed, ...over }, entry(raw))]).toEqual([over, false]);
  });
  test("the key id is inside the signed bytes: moved under another listed key's id, it doesn't verify", async () => {
    const a = makeKeyPair();
    const b = makeKeyPair();
    const signed = signSnapshot(signableSnap, privateKey(a.privatePem), policy);
    const both = [...entry(rawPublicKey(a.publicPem)), ...entry(rawPublicKey(b.publicPem))];
    expect(await verifySnapshot(signed, both)).toBe(true);
    expect(await verifySnapshot({ ...signed, key_id: both[1].id }, both)).toBe(false);
  });
  test("the identity is the SHA-256 of the signed bytes, the same in the exporter and shared code", async () => {
    const signed = withKeyId(snap, "0123456789abcdef");
    expect(snapshotIdOf(signed)).toBe(await snapshotId(signed));
    expect(snapshotIdOf(signed)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sixth round: key match", () => {
  test("--key-match says whether the exporter's key is listed and active (seventh round: ids and retired)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-keymatch-"));
    await capture(() => main(["--keygen", dir]));
    const mine = readFileSync(join(dir, "surface.pub.entry"), "utf8").trim();
    const other = makeKeyPair().publicEntry;
    const key = join(dir, "surface.key");
    expect(mine).toMatch(/^[0-9a-f]{16}:[A-Za-z0-9+/]+=*$/);
    expect((await capture(() => main(["--key-match", "--key", key, "--pub", `${other},${mine}`]))).code).toBe(0);
    expect((await capture(() => main(["--key-match", "--key", key, "--pub", join(dir, "surface.pub.entry")]))).code).toBe(0);
    expect((await capture(() => main(["--key-match", "--key", key, "--pub", join(dir, "surface.pub")]))).code).toBe(0);
    expect((await capture(() => main(["--key-match", "--key", key, "--pub", join(dir, "surface.pub.b64")]))).code).toBe(0);
    const no = await capture(() => main(["--key-match", "--key", key, "--pub", other]));
    expect(no.code).toBe(1);
    expect(no.err).toContain("NOT listed");
    const retired = await capture(() => main(["--key-match", "--key", key, "--pub", `${other},${mine}:retired`]));
    expect(retired.code).toBe(1);
    expect(retired.err).toContain("RETIRED");
    // An id that isn't its key's own, or a malformed entry: the list doesn't parse.
    const wrongId = "0000000000000000:" + mine.split(":")[1];
    expect((await capture(() => main(["--key-match", "--key", key, "--pub", wrongId]))).code).toBe(2);
    expect((await capture(() => main(["--key-match", "--key", key, "--pub", `${mine},garbage`]))).code).toBe(2);
  });
});

describe("sixth round: the uploader's preflight", () => {
  test("refuses a body over the Worker's limit, or one that doesn't verify under its own key", async () => {
    const keys = makeKeyPair();
    const signed = signSnapshot(signableSnap, privateKey(keys.privatePem), policy);
    const raw = rawPublicKey(keys.publicPem);
    const body = JSON.stringify(signed);
    expect(await uploadPreflight(body, entry(raw)[0])).toBeNull();
    expect(await uploadPreflight(body + " ".repeat(PUT_MAX_BYTES), entry(raw)[0])).toMatch(/over/);
    expect(await uploadPreflight(JSON.stringify({ ...signed, excluded_rows: 0 }), entry(raw)[0])).toMatch(/does not verify/);
    expect(await uploadPreflight(body, entry(rawPublicKey(makeKeyPair().publicPem))[0])).toMatch(/does not verify/);
  });
});

describe("seventh round: the record's revision (eighth round: a stable property of a commit)", () => {
  const git = gitIn;
  // A record checkout whose branch tracks an upstream at its tip.
  const repo = () => gitRecord(tempRecord(["| P1 | Sort the tools. | Cain | Sort them. | | Done. | 2026-11-01 |"]));
  const commitAll = (rec: string, msg: string) => {
    git(rec, "add", "-A");
    git(rec, "commit", "-q", "-m", msg);
  };
  test("a clean checkout at its upstream's tip gives {seq, commit}; the next pushed commit a higher seq", () => {
    const rec = repo();
    const one = recordRevision(rec).revision!;
    expect(one.seq).toBe(1);
    expect(one.commit).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(rec, "state", "holds.json"), "{}");
    commitAll(rec, "two");
    // Committed but not pushed: not the upstream's tip.
    expect(recordRevision(rec)).toEqual({ revision: null, why: "the record is not at its upstream branch's tip" });
    git(rec, "push", "-q");
    const two = recordRevision(rec).revision!;
    expect(two.seq).toBe(2);
    expect(two.commit).not.toBe(one.commit);
  });
  test("each path the exporter reads, dirty, untracked or ignored, means no revision, naming the path", () => {
    const cases: [string, (rec: string) => void, string][] = [
      ["PENDING.md edited", (rec) => writeFileSync(join(rec, "state", "PENDING.md"), "changed\n"), "state/PENDING.md has changes not committed"],
      ["a new holds file", (rec) => writeFileSync(join(rec, "state", "holds.json"), "{}"), "the holds file (state/holds.json) has changes not committed"],
      ["a new note", (rec) => (mkdirSync(join(rec, "state", "notes"), { recursive: true }), writeFileSync(join(rec, "state", "notes", "P1.md"), "x")), "the notes folder (state/notes) has changes not committed"],
      ["an ignored holds file", (rec) => {
        writeFileSync(join(rec, ".gitignore"), "state/holds.json\n");
        commitAll(rec, "ignore");
        git(rec, "push", "-q");
        writeFileSync(join(rec, "state", "holds.json"), "{}");
      }, "the holds file (state/holds.json) has changes not committed"],
      ["another file under state/", (rec) => writeFileSync(join(rec, "state", "other.md"), "x"), "state/ has changes not committed"],
    ];
    for (const [what, change, why] of cases) {
      const rec = repo();
      change(rec);
      expect([what, recordRevision(rec)]).toEqual([what, { revision: null, why }]);
    }
  });
  test("no upstream, a shallow clone, a folder inside another repository, or no git: null, with the reason", () => {
    const local = tempRecord(["| P1 | Sort the tools. | Cain | Sort them. | | Done. | 2026-11-01 |"]);
    git(local, "init", "-q");
    commitAll(local, "one");
    expect(recordRevision(local)).toEqual({ revision: null, why: "the record's branch has no upstream branch configured" });
    // A shallow clone of a record with two commits, its upstream at its tip.
    const src = repo();
    writeFileSync(join(src, "state", "holds.json"), "{}");
    commitAll(src, "two");
    git(src, "push", "-q");
    const bare = git(src, "config", "remote.origin.url");
    const shallow = join(mkdtempSync(join(tmpdir(), "surface-shallow-")), "rec");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${bare}`, shallow], { stdio: "ignore" });
    expect(recordRevision(shallow)).toEqual({ revision: null, why: "the record is a shallow clone" });
    expect(recordRevision(RECORD).revision).toBeNull();
    expect(recordRevision(tempRecord(["| P1 | x | Cain | x | | x | 2026-11-01 |"])).revision).toBeNull();
  });
  test("the revision is signed: it is in the signed bytes and the exporter's output", async () => {
    const rec = repo();
    const dir = mkdtempSync(join(tmpdir(), "surface-rev-"));
    await capture(() => main(["--keygen", dir]));
    const out = join(dir, "o.json");
    expect((await capture(() => main(["--record", rec, "--private-terms", TERMS, "--config", CONFIG, "--out", out, "--key", join(dir, "surface.key")]))).code).toBe(0);
    const s = JSON.parse(readFileSync(out, "utf8"));
    expect(s.revision).toEqual(recordRevision(rec).revision);
    const keys = await keyList(readFileSync(join(dir, "surface.pub.entry"), "utf8"));
    expect(await verifySnapshot(s, keys)).toBe(true);
    expect(await verifySnapshot({ ...s, revision: { ...s.revision, seq: s.revision.seq + 1 } }, keys)).toBe(false);
  });
  test("--put refuses with no revision: exit 2, nothing sent, the reason named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-rev-put-"));
    await capture(() => main(["--keygen", dir]));
    const env = {
      SURFACE_PUT_HOST: "surface.example.com",
      SURFACE_ACCESS_CLIENT_ID: "id-example",
      SURFACE_ACCESS_CLIENT_SECRET: "secret-example",
      SURFACE_PUBLISHER_TOKEN: "publisher-example",
    };
    const dirty = repo();
    writeFileSync(join(dirty, "state", "holds.json"), "{}");
    for (const [rec, why] of [
      [tempRecord(["| P1 | Sort the tools. | Cain | Sort them. | | Done. | 2026-11-01 |"]), /not a git checkout|not the top of its own git work tree/],
      [dirty, /the holds file \(state\/holds\.json\) has changes not committed/],
    ] as const) {
      let calls = 0;
      const r = await capture(() =>
        main(["--record", rec, "--private-terms", TERMS, "--config", CONFIG, "--key", join(dir, "surface.key"), "--put", "https://surface.example.com/snapshot", "--made-at", NOW.toISOString(), "--approve", "0".repeat(64)], {
          fetch: async () => (calls++, new Response("{}")),
          env,
        }),
      );
      expect(r.code).toBe(2);
      expect(calls).toBe(0);
      expect(r.err).toMatch(/--put: no record revision can be signed/);
      expect(r.err).toMatch(why);
    }
  });
});

describe("seventh round: the dry-run report's path", () => {
  const run = ["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--dry-run"];
  test("a path inside any git work tree is refused before anything is read", async () => {
    const inRepo = join(import.meta.dir, "fixtures", "report.private.txt");
    const r = await capture(() => main([...run, "--report", inRepo]));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/inside a git work tree/);
    expect(r.out).toBe("");
    expect(existsSync(inRepo)).toBe(false);
    // A folder that is a work tree by its .git file alone counts too.
    const fake = mkdtempSync(join(tmpdir(), "surface-fakegit-"));
    writeFileSync(join(fake, ".git"), "gitdir: /nowhere\n");
    expect(insideGitWorkTree(join(fake, "sub", "report.txt"))).toBe(true);
    expect(insideGitWorkTree(join(mkdtempSync(join(tmpdir(), "surface-nogit-")), "report.txt"))).toBe(false);
  });
  test("the absolute path is printed on stderr; --report alone uses the default name in the home folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-report-abs-"));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const r = await capture(() => main([...run, "--report", "rel.txt"]));
      expect(r.code).toBe(0);
      expect(r.err).toContain(`the private word list is in ${join(realpathSync(dir), "rel.txt")}`);
    } finally {
      process.chdir(prev);
    }
    const home = mkdtempSync(join(tmpdir(), "surface-home-"));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await capture(() => main([...run, "--report"]));
      expect(r.code).toBe(0);
      expect(existsSync(join(home, DEFAULT_REPORT))).toBe(true);
      expect(statSync(join(home, DEFAULT_REPORT)).mode & 0o777).toBe(0o600);
    } finally {
      process.env.HOME = oldHome;
    }
  });
  test("the default name and the temporary-file pattern are in surface/.gitignore", () => {
    const ignore = readFileSync(join(import.meta.dir, "..", ".gitignore"), "utf8");
    expect(ignore).toContain(DEFAULT_REPORT);
    expect(ignore).toContain("*.tmp-*");
  });
  test("a failed write leaves no temporary file behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-report-fail-"));
    // The target is a folder: the rename over it fails after the temporary file is written.
    const target = join(dir, "is-a-folder");
    mkdirSync(join(target, "x"), { recursive: true });
    const r = await capture(() => main([...run, "--report", target]));
    expect(r.code).toBe(2);
    expect(readdirSync(dir)).toEqual(["is-a-folder"]);
    expect(() => writePrivate(target, "x")).toThrow();
    expect(readdirSync(dir)).toEqual(["is-a-folder"]);
  });
});

describe("seventh round: every stem's token boundary", () => {
  // One example each stem must catch, by its rule.
  const hit = (r: (typeof STEM_RULES)[number]) =>
    r.mode === "prefix" ? `the ${r.stem}xyz here` : `the ${r.stem}${r.endings[0] ?? ""} here`;
  test("each stem catches its own word (and, for a word stem, each listed ending)", () => {
    for (const r of STEM_RULES) {
      expect([r.stem, isExcluded(policy, hit(r))]).toEqual([r.stem, true]);
      expect([r.stem, isExcluded(policy, `the ${r.stem} here`)]).toEqual([r.stem, true]);
      if (r.mode === "word") for (const e of r.endings) expect([r.stem + e, isExcluded(policy, `x ${r.stem}${e} y`)]).toEqual([r.stem + e, true]);
    }
  });
  test("no stem matches inside a word, and a word stem never matches a longer word", () => {
    for (const r of STEM_RULES) {
      expect([r.stem, isExcluded(policy, `the q${r.stem} here`)]).toEqual([r.stem, false]);
      if (r.mode === "word") expect([r.stem, isExcluded(policy, `the ${r.stem}qz here`)]).toEqual([r.stem, false]);
    }
  });
  test("the short stems' false positives stay in", () => {
    const fine: [string, string[]][] = [
      ["er", ["after", "error", "errand", "her"]],
      ["rx", ["rxjs"]],
      ["lab", ["label", "labor", "collab", "labrador"]],
      ["fine", ["define", "finely", "refine"]],
      ["check", ["checklist", "checkpoint", "recheck"]],
      ["wire", ["wireless", "haywire"]],
      ["ticket", ["ticketless", "sticket"]],
      ["pt", ["ptarmigan", "opt"]],
      ["pay", ["payload"]],
      ["card", ["cardboard", "discard"]],
      ["tax", ["taxi", "syntax"]],
      ["cost", ["costume"]],
      ["fee", ["feel", "feed", "coffee"]],
      ["pill", ["pillow"]],
      ["scan", ["scandal"]],
      ["sick", ["sickle"]],
      ["owe", ["owen", "bowel", "flowers"]],
    ];
    for (const [stem, words] of fine) {
      expect(STEM_RULES.find((r) => r.stem === stem)?.mode).toBe("word");
      for (const w of words) expect([stem, w, isExcluded(policy, `see the ${w} today`)]).toEqual([stem, w, false]);
    }
  });
});

describe("seventh round: account shapes and money", () => {
  test("an IBAN, spaced or not, even shaped like a record code", () => {
    for (const t of ["GB82 WEST 1234 5698 7654 32", "DE89370400440532013000", "pay to FR14 2004 1010 0505 0001 3M02 606"])
      expect([t, namesAccount(t) || namesLongNumber(t)]).toEqual([t, true]);
    expect(namesAccount("DE89370400440532013000")).toBe(true);
    expect(namesAccount("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isExcluded(policy, "the DE89370400440532013000 one")).toBe(true);
  });
  test("a card number in groups of any size", () => {
    for (const t of ["4111 1111 1111 1111", "4111-1111-1111-1111", "411 111 111 111 1111", "4111111111111111"])
      expect([t, namesAccount(t)]).toEqual([t, true]);
  });
  test("account words and a sort code", () => {
    for (const t of ["acct ending soon", "the a/c details", "IBAN later", "routing number please", "sort code next", "account no. is on it", "12-34-56"])
      expect([t, namesAccount(t)]).toEqual([t, true]);
    for (const t of ["account for it", "on 2026-11-20", "the gate at 7:30", "P41 and P42", "projects/garden"])
      expect([t, namesAccount(t)]).toEqual([t, false]);
  });
  test("currency amounts: symbols, codes in either case for the common ones, words", () => {
    for (const t of ["£5", "40 usd", "eur 12", "USD 40", "40EUR", "50 dollars", "five quid", "2k euros"]) expect([t, namesMoney(t)]).toEqual([t, true]);
    for (const t of ["try 3 times", "php 8 upgrade", "5 boxes"]) expect([t, namesMoney(t)]).toEqual([t, false]);
  });
});

describe("seventh round: the cast check", () => {
  test("comments, strings, templates and regular expressions don't count; code does", () => {
    const ok = [
      "// any as unknown as\nconst a = 1;",
      "const s = 'any as GatedText';",
      'const s = "as unknown as";',
      "const t = `any ${1 + 2} any`;",
      "const r = /any|as unknown as/g;",
      "const c = company;",
      "x.any = 1;",
      "/* any */ const z = a / b / c;",
    ];
    for (const src of ok) expect([src, fileProblems("f.ts", src)]).toEqual([src, []]);
    const bad: [string, string][] = [
      ["let x: any = 1;", "the type any"],
      ["const y = x as any;", "the type any"],
      ["const y = x as unknown as T;", "as unknown as"],
      ["const g = s as GatedText;", "as GatedText"],
      ["const t = `${x as any}`;", "the type any"],
      ["function f(a: any[]) {}", "the type any"],
    ];
    for (const [src, what] of bad) expect([src, fileProblems("f.ts", src)]).toEqual([src, [`f.ts:1: ${what}`]]);
  });
});

describe("seventh round: the common words against the bundled name lists", () => {
  const listOf = (f: string) => new Set(parseWordList(readFileSync(join(import.meta.dir, "names", f), "utf8")));
  const surnames = listOf("surnames.txt");
  const given = listOf("given-names.txt");
  test("the bundled lists are the sizes the README gives, lower case, one a line", () => {
    expect(surnames.size).toBe(13862);
    expect(given.size).toBe(6380);
    for (const w of [...surnames, ...given].slice(0, 2000)) expect(w).toMatch(/^[a-z' -]+$/);
  });
  test("no word of common-words.txt is in them: every overlap is in name-words.txt", () => {
    const inFile = COMMON_WORDS_FILE.map((w) => w.toLowerCase());
    expect(inFile.filter((w) => surnames.has(w) || given.has(w))).toEqual([]);
    for (const w of ["to", "do", "he", "you", "call", "check", "fix", "work", "will", "may"]) {
      expect([w, surnames.has(w) || given.has(w) || NAME_WORDS.has(w)]).toEqual([w, true]);
      expect([w, NAME_WORDS.has(w), policy.allowWords.has(w) && !JSON.parse(readFileSync(CONFIG, "utf8")).allow_words.map(fold).includes(w)]).toEqual([w, true, false]);
    }
  });
  test("name-words.txt has its two sections, and a word before them is refused", () => {
    expect(NAME_WORDS_COMMON.has("to")).toBe(true);
    expect(NAME_WORDS.has("doug") && !NAME_WORDS_COMMON.has("doug")).toBe(true);
    expect(() => parseNameWords("stray\n[names]\nx")).toThrow(/before the first/);
    expect(parseNameWords("[names]\na b\n[common]\nc").common).toEqual(new Set(["c"]));
  });
});

// --- eighth round ---------------------------------------------------------------------------------

describe("eighth round: sanitise is idempotent, and the signer re-runs it with each field's cap", () => {
  // Every free-text cell of the fixture record (the fixture corpus, every row of which is the strict
  // corpus) and the synthetic record, under three policies.
  const cellsOf = (rec: string) =>
    openRows(readFileSync(join(rec, "state", "PENDING.md"), "utf8")).flatMap((r) => [r.item, r.next, r.waits ?? "", r.done_when]);
  const corpus = [...cellsOf(RECORD), ...cellsOf(join(FIX, "synthetic"))].filter(Boolean);
  const strictRows: Record<string, string> = JSON.parse(readFileSync(join(FIX, "strict-corpus.json"), "utf8"));
  const policies: [string, ReturnType<typeof makePolicy>][] = [
    ["the fixture config", policy],
    ["the owner only", makePolicy(readFileSync(TERMS, "utf8"), { owner_names: ["Robin"], names: [] })],
    ["more allowed words and names", makePolicy(readFileSync(TERMS, "utf8"), { owner_names: ["Robin"], names: ["Kestrel", "Ottoline"], allow_words: ["Penrose", "zorblat"] })],
  ];
  test("sanitising its own output returns it unchanged, for every field and policy, over the fixture and strict corpora", () => {
    expect(corpus.length).toBeGreaterThan(200);
    expect(Object.keys(strictRows).length).toBeGreaterThan(50);
    const fields: [string, number | undefined][] = [["title", TITLE_MAX], ["step", STEP_MAX], ["outcome", undefined], ["waits_for", undefined]];
    const bad: string[] = [];
    for (const [pname, p] of policies)
      for (const [field, max] of fields)
        for (const cell of corpus) {
          const once = sanitise(cell, p, max).text;
          const twice = sanitise(once, p, max).text;
          if (twice !== once) bad.push(`${pname}: ${field}: ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`);
        }
    expect(bad).toEqual([]);
  });
  test("edge cases: a cut text, markdown, a name next to a sentence end, an abbreviation", () => {
    const edges = [
      "word ".repeat(80) + "end.",
      "Fix **the** _gate_ for Morgan Vale. Then more.",
      "Waiting on Mr. Vale. Then Dr. Penrose.",
      "a_b_c_d and `x` and *y*",
      "Ask Ｍｏｒｇａｎ at https://example.com about P41.",
      // A cut whose last kept character is a space, and an ellipsis inside the text.
      "abcd abcd abcd abc defg hijk lmno",
      "wait… then go. Then more.",
      "a… b",
    ];
    for (const [, p] of policies)
      for (const max of [TITLE_MAX, STEP_MAX, 20, 19, 21, undefined])
        for (const e of edges) {
          const once = sanitise(e, p, max).text;
          expect([e, max, sanitise(once, p, max).text]).toEqual([e, max, once]);
        }
  });
});

describe("eighth round: the signer signs a plain copy of validated values", () => {
  const keys = makeKeyPair();
  const key = privateKey(keys.privatePem);
  const copy = (): ReturnType<typeof JSON.parse> => JSON.parse(JSON.stringify(signableSnap));
  const outcome = (s: unknown, p = policy) => {
    try {
      signSnapshot(s as typeof signableSnap, key, p);
      return "signed";
    } catch (e) {
      return String(e instanceof Error ? e.message : e);
    }
  };
  test("an accessor-backed field (a getter that returns a different string on each read) is refused", () => {
    const t = copy();
    let n = 0;
    Object.defineProperty(t.threads[0], "title", { get: () => (n++ === 0 ? "Sort the tools." : "Raw text from Kestrel"), enumerable: true });
    expect(outcome(t)).toMatch(/snapshot\.threads\[0\]\.title: not a plain field/);
    // On the snapshot itself, and an array index backed by an accessor: refused before any value is read.
    const u = copy();
    let reads = 0;
    const first = u.threads[0];
    Object.defineProperty(u.threads, "0", { get: () => (reads++, first), enumerable: true, configurable: true });
    expect(outcome(u)).toMatch(/snapshot\.threads\[0\]: not a plain field/);
    expect(reads).toBe(0);
    const v = copy();
    Object.defineProperty(v, "made_at", { get: () => signableSnap.made_at, enumerable: true });
    expect(outcome(v)).toMatch(/snapshot\.made_at: not a plain field/);
  });
  test("a string reused across fields (an outcome-length string passed as a title) is refused", () => {
    const long = sanitise("Sort the tools and the bins and the shelves in the garage, " + "then sort the tools again, ".repeat(8) + "and done.", policy).text;
    expect(long.length).toBeGreaterThan(TITLE_MAX);
    const t = copy();
    t.threads[0].outcome = long;
    expect(outcome(t)).toBe("signed");
    t.threads[0].title = long;
    expect(outcome(t)).toMatch(/snapshot\.threads\[0\]\.title: a string that did not pass the sanitise pipeline/);
  });
  test("a string sanitised under another policy is refused", () => {
    const config = JSON.parse(readFileSync(CONFIG, "utf8"));
    const other = makePolicy(readFileSync(TERMS, "utf8"), { ...config, allow_words: [...config.allow_words, "Kestrel"] });
    const text = sanitise("Return the drill to Kestrel.", other).text;
    expect(text).toBe("Return the drill to Kestrel.");
    const t = copy();
    t.threads[0].outcome = text;
    expect(outcome(t, other)).toBe("signed");
    expect(outcome(t)).toMatch(/snapshot\.threads\[0\]\.outcome: a string that did not pass the sanitise pipeline/);
  });
  test("unknown lower-case or uncased text is refused in every free-text field, whatever the flags", () => {
    for (const [field, text] of [["title", "Sort the zorblat."], ["step", "Sort the zorblat."], ["outcome", "The zorblat is sorted."], ["waits_for", "the zorblat"], ["title", "Sort the 中文."]] as const) {
      const t = copy();
      t.threads[0][field] = text;
      expect([field, sanitise(text, policy, field === "title" ? TITLE_MAX : field === "step" ? STEP_MAX : undefined).text]).toEqual([field, text]);
      expect([field, outcome(t)]).toEqual([field, `snapshot.threads[0].${field}: an unknown lower-case or uncased word (not in the word list)`]);
    }
    // And the command line, without --strict: exit 1, nothing written, the place only.
  });
  test("the plain run without --strict refuses a record with an unknown word: exit 1, nothing written, no word printed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-unknown-sign-"));
    await capture(() => main(["--keygen", dir]));
    const rec = tempRecord(["| P1 | Sort the tools. | Cain | Sort the zorblat. | | Done. | 2026-11-01 |"]);
    const out = join(dir, "o.json");
    const r = await capture(() => main(["--record", rec, "--private-terms", TERMS, "--config", CONFIG, "--out", out, "--key", join(dir, "surface.key")]));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the gate refused to sign: snapshot\.threads\[0\]\.step: an unknown lower-case or uncased word/);
    expect(r.err).not.toContain("zorblat");
    expect(existsSync(out)).toBe(false);
  });
  test("the caller's object is never what is signed: changing it afterwards changes nothing signed", async () => {
    const t = copy();
    const signed = signSnapshot(t, key, policy);
    t.threads[0].title = "changed";
    expect(signed.threads[0].title).not.toBe("changed");
    expect(await verifySnapshot(signed, entry(rawPublicKey(keys.publicPem)))).toBe(true);
    // A proxy that answers differently each time it is read is read once, then checked as copied.
    let n = 0;
    const thread = copy().threads[0];
    const proxied = new Proxy(thread, {
      getOwnPropertyDescriptor(target, k) {
        const d = Reflect.getOwnPropertyDescriptor(target, k);
        if (k === "title" && d) return { ...d, value: n++ === 0 ? thread.title : "Raw text from Kestrel" };
        return d;
      },
    });
    const p = copy();
    p.threads[0] = proxied;
    // Its shape check saw the clean title; the copy took the other one, and the gate, walking the
    // copy, refuses it: what is checked is what would be signed.
    expect(outcome(p)).toMatch(/snapshot\.threads\[0\]\.title: a string that did not pass the sanitise pipeline/);
  });
});

describe("eighth round: the unknown-word check and digits", () => {
  test("a token touching a digit is looked up by its letters; only a whole record-code form is exempt", () => {
    expect(unknownTokens("see v2 and x86 and p40 and ab12345", policy.vocabulary)).toEqual([]);
    expect(unknownTokens("the zorblat2 and 9quillon and abc123def", policy.vocabulary)).toEqual(["zorblat", "quillon", "abc", "def"]);
    // Four letters then digits is not a code form.
    expect(unknownTokens("abcd12", policy.vocabulary)).toEqual(["abcd"]);
    // A number's own letters right after it: dates and times.
    expect(unknownTokens("on the 3rd and the 20th at 10am or 5pm", policy.vocabulary)).toEqual([]);
    expect(unknownTokens("the th", policy.vocabulary)).toEqual(["th"]);
  });
  test("the dry run reports unknown words and does not sign; the gate's verdict is named, with no approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-dry-gate-"));
    await capture(() => main(["--keygen", dir]));
    const rec = tempRecord(["| P1 | Sort the tools. | Cain | Sort the zorblat2. | | Done. | 2026-11-01 |"]);
    const r = await capture(() => main(["--record", rec, "--private-terms", TERMS, "--config", CONFIG, "--dry-run", "--key", join(dir, "surface.key")]));
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/1 lower-case or uncased word\(s\) not in the word list/);
    expect(r.err).toMatch(/the gate would refuse to sign: snapshot\.threads\[0\]\.step: an unknown/);
    expect(r.err).toMatch(/no approval digest: these bytes can't be uploaded/);
    expect(r.err).not.toContain("zorblat");
    expect(JSON.parse(r.out).sig).toBeUndefined();
  });
});

describe("eighth round: the approval digest is of bytes the owner can read", () => {
  test("a dry run with --key and --report writes the exact signed bytes beside the report (0600); the digest is their SHA-256", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-bytes-"));
    await capture(() => main(["--keygen", dir]));
    const report = join(mkdtempSync(join(tmpdir(), "surface-bytes-report-")), "report.txt");
    const run = ["--record", join(FIX, "synthetic"), "--private-terms", TERMS, "--config", CONFIG, "--dry-run", "--key", join(dir, "surface.key"), "--report", report];
    const r = await capture(() => main(run));
    expect(r.code).toBe(0);
    const approve = /--approve ([0-9a-f]{64})/.exec(r.err)![1];
    const bytesFile = `${report}.signed.json`;
    expect(statSync(bytesFile).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(bytesFile);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(approve);
    // They are the canonical signed JSON, as text: the signed fields with the key id.
    const parsed = JSON.parse(bytes.toString("utf8"));
    expect(parsed.key_id).toBe(keyId(rawPublicKey(readFileSync(join(dir, "surface.pub"), "utf8"))));
    expect(parsed.sig).toBeUndefined();
    expect(canonical(parsed)).toBe(bytes.toString("utf8"));
    expect(readFileSync(report, "utf8")).toContain(bytesFile);
  });
});

describe("eighth round: a private file's directory is resolved before the work-tree check", () => {
  test("a directory outside any repository that is a symlink into a work tree is refused, for the report and for writePrivate", async () => {
    const repo = mkdtempSync(join(tmpdir(), "surface-wt-"));
    gitIn(repo, "init", "-q");
    mkdirSync(join(repo, "inner"));
    const outside = mkdtempSync(join(tmpdir(), "surface-link-"));
    const link = join(outside, "linked");
    symlinkSync(join(repo, "inner"), link);
    expect(insideGitWorkTree(join(link, "report.txt"))).toBe(true);
    expect(insideGitWorkTree(join(link, "not-yet", "report.txt"))).toBe(true);
    expect(() => writePrivate(join(link, "report.txt"), "private\n")).toThrow(/inside a git work tree/);
    expect(readdirSync(join(repo, "inner"))).toEqual([]);
    const r = await capture(() => main(["--record", RECORD, "--private-terms", TERMS, "--config", CONFIG, "--dry-run", "--report", join(link, "report.txt")]));
    expect(r.code).toBe(2);
    expect(readdirSync(join(repo, "inner"))).toEqual([]);
    // A real directory outside any repository is fine, and the file lands there.
    const plain = join(mkdtempSync(join(tmpdir(), "surface-plain-")), "report.txt");
    writePrivate(plain, "private\n");
    expect(statSync(plain).mode & 0o777).toBe(0o600);
  });
});

describe("eighth round: the cast check reads the sanitiser module too", () => {
  test("lib.ts passes with only mark()'s line allowed; any other cast there fails", () => {
    const lib = readFileSync(join(import.meta.dir, "lib.ts"), "utf8");
    const path = ["export", "lib.ts"].join("/");
    expect(fileProblems(path, lib)).toEqual([]);
    const lines = lib.split("\n");
    const at = lines.indexOf("  return s as GatedText;");
    expect(lines[at - 1]).toBe("function mark(s: string): GatedText {");
    // Another brand cast, an as unknown as, an any: each fails, at its line.
    for (const [extra, what] of [["const x = y as GatedText;", "as GatedText"], ["const x = y as unknown as string;", "as unknown as"], ["let z: any = 1;", "the type any"]]) {
      const src = lib + "\n" + extra + "\n";
      expect(fileProblems(path, src)).toEqual([`${path}:${lines.length + 1}: ${what}`]);
    }
    // The allowed line anywhere but under mark()'s head fails too.
    expect(fileProblems(path, lib + "\nfunction other(s: string): GatedText {\n  return s as GatedText;\n}\n")).toEqual([`${path}:${lines.length + 2}: as GatedText`]);
    // And another file gets no allowance at all.
    expect(fileProblems("export/other.ts", "function mark(s: string): GatedText {\n  return s as GatedText;\n}\n")).toEqual(["export/other.ts:2: as GatedText"]);
  });
});

describe("eighth round: money and account gates", () => {
  test("a lower-case IBAN, a spaced card number, acct glued to a number, a sort code with a cue or not date-shaped", () => {
    for (const t of [
      "gb82 west 1234 5698 7654 32",
      "pay into gb82west12345698765432",
      "card 4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "acct42",
      "ACCT 99",
      "sort code 12-05-26",
      "acct 01-02-03",
      "40-50-60",
      "99-32-11",
    ])
      expect([t, namesAccount(t)]).toEqual([t, true]);
  });
  test("two-digit dates and versions don't exclude", () => {
    for (const t of ["on 12-05-26", "due 01-12-26", "from 26-11-19", "11-30-26 in the US form", "version 1.2.3", "v10.12.03", "release 2-1-0"])
      expect([t, namesAccount(t)]).toEqual([t, false]);
    expect(dateShaped(12, 5, 26)).toBe(true);
    expect(dateShaped(26, 11, 19)).toBe(true);
    expect(dateShaped(40, 50, 60)).toBe(false);
  });
  test("prefix stems match no ordinary word on the common-word lists; the ones that did are words with endings", () => {
    const words = [...new Set([...COMMON_WORDS_FILE, ...NAME_WORDS_COMMON].map(fold))];
    for (const r of STEM_RULES)
      if (r.mode === "prefix") {
        const s = fold(r.stem);
        // The stem's own plain inflections are what it is for ("banks").
        const own = new Set(["", "s", "es", "ed", "ing", "er", "ers"].map((e) => s + e));
        expect([r.stem, words.filter((w) => w.startsWith(s) && !own.has(w))]).toEqual([r.stem, []]);
      }
    for (const ordinary of ["hospitality", "billion", "billow", "billiards", "mentality"]) expect([ordinary, isExcluded(policy, ordinary)]).toEqual([ordinary, false]);
    for (const health of ["hospital", "hospitals", "bill", "bills", "billing", "mental", "mentally"]) expect([health, isExcluded(policy, health)]).toEqual([health, true]);
  });
  test("the dry-run report lists every strict failure with its field, the word and a suggested line", async () => {
    const rec = tempRecord([
      "| P1 | Return the drill to Kestrel. | Cain | Sort the zorblat. | | Done. | 2026-11-01 |",
      "| P2 | Ask Will about it. | Cain | Ask. | | Done. | 2026-11-01 |",
      "| bad | No id. | Cain | Go. | | Done. | 2026-11-01 |",
    ]);
    const report = join(mkdtempSync(join(tmpdir(), "surface-suggest-")), "report.txt");
    expect((await capture(() => main(["--record", rec, "--private-terms", TERMS, "--config", CONFIG, "--dry-run", "--report", report]))).code).toBe(0);
    const text = readFileSync(report, "utf8");
    const lines = text.split("\n");
    const after = (re: RegExp) => lines[lines.findIndex((l) => re.test(l)) + 1];
    expect(text).toMatch(/strict failures: 4/);
    expect(after(/PENDING\.md:5: title: Kestrel$/)).toBe('  suggest: allow_words: "Kestrel"');
    expect(after(/PENDING\.md:5: step: zorblat$/)).toBe('  suggest: allow_words: "zorblat"');
    expect(after(/PENDING\.md:6: title: Will$/)).toMatch(/^  suggest: name-words\.txt \[common\]: will /);
    expect(text).toMatch(/PENDING\.md:7: row skipped, no valid id/);
  });
});
