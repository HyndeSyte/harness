import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  matchesBounded,
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
} from "./lib";
import { main, PRIVATE_REPORT } from "./index";
import { tempRecord } from "./fixtures/temp-record";

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
    expect(s.excluded_rows).toBe(47);
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
    const g = properNounGate("Meet Kestrel on Friday at the Worker. Then Paris's train, OK.", policy.allowWords);
    expect(g.text).toBe("Meet someone on Friday at the Worker. Then someone's train, OK.");
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
  const rec = tempRecord(["| P1 | Return the drill to Kestrel next door, then lunch. | Cain | Ring at noon. | | Drill back. | 2026-11-01 |"]);
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
  test("a dry run prints the leftover words on stderr only, under the private line", async () => {
    const r = await capture(() => main([...run, "--dry-run"]));
    expect(r.code).toBe(0);
    const err = r.err.split("\n");
    const at = err.indexOf(PRIVATE_REPORT);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(err.slice(at + 1).some((l) => /PENDING\.md:5: title: Kestrel$/.test(l))).toBe(true);
    expect(err.slice(0, at).join("\n")).not.toContain("Kestrel");
    expect(r.out).not.toContain("Kestrel");
    expect(JSON.parse(r.out).threads[0].title).toBe("Return the drill to someone next door, then lunch.");
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
    const g = properNounGate("Ottoline wants it. Then Penrose rings. Read it on Monday.", policy.allowWords);
    expect(g.text).toBe("someone wants it. Then someone rings. Read it on Monday.");
    expect(g.words).toEqual(["Ottoline", "Penrose"]);
    expect(properNounGate("Follow-up for Re-Kestrel.", policy.allowWords).words).toEqual(["Re-Kestrel"]);
    expect(properNounGate("Don't wait; Let's go. It’s done.", policy.allowWords).words).toEqual([]);
  });
  test("the bundled list is common words only and the defaults no longer carry the weekdays", () => {
    expect(policy.allowWords.has("monday")).toBe(true);
    expect(policy.allowWords.has("december")).toBe(true);
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
  test("a match runs over at most MATCH_SPAN characters at a time; the whole cell is still checked", () => {
    const seen: number[] = [];
    const spy = { test: (t: string) => (seen.push(t.length), /needle/.test(t)) } as unknown as RegExp;
    const long = "x ".repeat(10000) + "needle";
    expect(matchesBounded(spy, long)).toBe(true);
    expect(Math.max(...seen)).toBeLessThanOrEqual(MATCH_SPAN);
    expect(matchesBounded(/needle/, "x".repeat(MATCH_SPAN - 3) + " needle " + "y".repeat(9000))).toBe(true);
    expect(isExcluded(makePolicy("Juniper"), "a ".repeat(6000) + "Juniper")).toBe(true);
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
