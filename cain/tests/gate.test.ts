// The message gate's rules (gate/rules.ts). The shared cases in gate-cases.json are run
// here against rules.ts and by pytest against the Python port (tests/message_rules.py), so
// the two stay equal.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { around, AT, check, DASH_WHY, DASH_WORDS, hostsOnly, LINK_WHY, linkHost, MAX_EXCERPTS, RANGE_WHY, RULES, STATIC_LABELS, verdict, whyOf } from "../rootfs/opt/cain/gate/rules";

const shared = JSON.parse(readFileSync(join(import.meta.dir, "gate-cases.json"), "utf8"));
const rulesOf = (r: ReturnType<typeof check>, result: string) => [...new Set(r.hits.filter((h) => h.result === result).map((h) => h.rule))].sort();

describe("the shared cases", () => {
  for (const c of shared.cases) {
    test(c.name, () => {
      const ctx = c.context ?? {};
      const r = check(c.text, { rules: ctx.rules, buttons: ctx.buttons, known: ctx.known, answersHim: ctx.answers_him, refusable: ctx.refusable });
      expect(r.fixed).toBe(c.fixed ?? c.text);
      expect(rulesOf(r, "fix")).toEqual([...(c.fix ?? [])].sort());
      expect(rulesOf(r, "refuse")).toEqual([...(c.refuse ?? [])].sort());
      expect(rulesOf(r, "unsure")).toEqual([...(c.unsure ?? [])].sort());
      if (c.around) expect(r.hits.map((h) => h.around)).toEqual(c.around);
    });
  }

  test("the static labels are the ones the cases file lists", () => {
    expect([...STATIC_LABELS]).toEqual(shared.static_labels);
  });

  test("every rule is covered both ways", () => {
    for (const rule of RULES) {
      expect(shared.cases.some((c: any) => [...(c.fix ?? []), ...(c.refuse ?? []), ...(c.unsure ?? [])].includes(rule))).toBe(true);
      expect(shared.cases.some((c: any) => !c.fix && !c.refuse && !c.unsure && c.text.length > 0)).toBe(true);
    }
  });
});

describe("the rules", () => {
  test("Nov 10, synthetic: tap Undo in a reply to a receipt without Undo is refused, and says which label", () => {
    const r = check("Tap Undo on the receipt above and it's gone.", { buttons: ["Not mine", "Wrong time", "Just this once", "Stop"] });
    expect(verdict(r)).toBe("refuse");
    expect(r.hits).toMatchObject([{ rule: "button", result: "refuse", label: "Undo" }]);
    expect(verdict(check("each on its own card with Undo", { buttons: ["Stop"] }))).toBe("refuse");
  });

  test("a hit says where, in at most 60 characters on one line", () => {
    const long = `${"Moved the swim lesson to the later slot today, ".repeat(3)}— and ${"then the art class moved too, ".repeat(3)}`;
    const r = check(long);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].around.length).toBeLessThanOrEqual(60);
    expect(r.hits[0].around).toContain("—");
    expect(r.hits[0].around).not.toContain("\n");
    expect(around("a\nb\nc", 2, 3)).toBe("a b c");
  });

  test("each send point's rules: the specialist's cards get no machine rule, tap notes and the link only the fixes", () => {
    expect([...AT.cain]).toEqual([...RULES]);
    expect([...AT.card]).toEqual(["dash", "app", "count", "button"]);
    expect([...AT.answer]).toEqual(["dash", "app"]);
    expect([...AT.link]).toEqual(["dash", "app"]);
    expect(verdict(check("Room 123456789012345678 at 2:00", { rules: AT.card }))).toBe("pass");   // a number from a calendar title
  });

  test("code spans and link targets are never rewritten", () => {
    const text = "See `a — b` and the [linked page](https://example.com/x—y) for it — then the add-on.";
    const r = check(text);
    expect(r.fixed).toBe("See `a — b` and the [linked page](https://example.com/x—y) for it, then the App.");
  });

  test("Cain's words: every em dash is refused, none fixed in place, and the reason says how to say it without one", () => {
    // Fable, round four: ", " still made ranges lists behind markdown, units and words. Only he knows which he meant.
    for (const text of ["Swim is **5** — **6 PM**.", "Swim takes 30 min — 1 hr.", "Week 1 — Week 3 are booked.", "Out Monday morning — Friday evening.",
      "Moved swim — it's at 4:30 now.", "Bake sale—Friday", "Room 4—5 is free.", "Party is 6 PM — 8.", "See https://example.com/a — then reply.", "Done — 3 events moved.",
      "— Bake sale", "Pickup moved —", "All set —.", "Done, — nothing else.", "Moved — — swim."]) {
      const r = check(text, { rules: AT.cain, refusable: true });
      expect(r.hits.map((h) => [h.rule, h.result, h.kept])).toEqual([["dash", "refuse", undefined]]);
      expect(r.fixed).toBe(text);
      expect(whyOf(r.hits[0])).toBe(DASH_WHY);
    }
    expect(DASH_WHY).toBe('an em dash; rewrite it without one, using a comma or a new sentence for a break, "to" or "through" for a range');
    // "add-on" is still fixed in place beside it; code, links, link targets and an en dash are left alone.
    expect(check("Restarted the add-on — all set.", { refusable: true })).toMatchObject({ fixed: "Restarted the App — all set.",
      hits: [{ rule: "app", result: "fix" }, { rule: "dash", result: "refuse" }] });
    expect(check("Run `a — b`, see https://example.com/a—b and [it](https://example.com/c—d); 9 – 11.", { refusable: true }).hits).toEqual([]);
    // The same words from a writer that's never refused: fixed, or kept and flagged.
    expect(check("Moved swim — it's at 4:30 now.").fixed).toBe("Moved swim, it's at 4:30 now.");
  });

  test("in words never refused, a dash becomes a comma only between plain words, two on each side; any other is kept, flagged", () => {
    // The coordinator, round four: a flag costs nothing, so flag generously.
    for (const [text, fixed] of [["Moved the swim lesson — it starts at 4:30 now.", "Moved the swim lesson, it starts at 4:30 now."],
      ["Moved swim—it starts now.", "Moved swim, it starts now."], ["The drop-off moved — it's all set.", "The drop-off moved, it's all set."],
      ["We may — or may not — go home.", "We may, or may not, go home."], ["We march — all of us together.", "We march, all of us together."],
      ["The cat sat — quite still there.", "The cat sat, quite still there."], ["They wed — after many years.", "They wed, after many years."]]) {
      expect(check(text)).toMatchObject({ fixed, hits: text.match(/—/g)!.map(() => ({ rule: "dash", result: "fix" })) });
    }
    for (const text of ["Swim is **5** — **6 PM**.", "Swim is _5_ — _6 PM_.", "Use `5` — `6` for the lanes.", "Swim was ~~5~~ — 6 PM.", "Booked May — 3 nights.", "Open SUN — 6 PM.",
      "Swim takes 30 min — 1 hr.", "Week 1 — Week 3 are booked.", "Out Monday morning — Friday evening.", "Open all morning — until we close.", "Kids aged five — eight are here.",
      "Allow an hour — maybe more though.", "Open from spring — fall each year.", "Rooms A — C are free.", "Gates A1 — B2 are open.", "Its tag is #ready — or not yet.",
      "Costs 5 — ~10 now.", "Moved — swim starts now.", "Moved the swim — done.", "Bake sale—Friday", "Done, — nothing else.", "All set —.", "Pickup moved —\nall set.",
      "**Moved** — swim is at 4:30.", "Meet at the café — it opens soon.", "Swim moved to 4:30 — that works.", "It's Friday — swim day."]) {
      const r = check(text);
      expect(r.hits).toMatchObject([{ rule: "dash", result: "refuse", kept: "range" }]);
      expect(r.fixed).toBe(text);
      expect(whyOf(r.hits[0])).toBe(RANGE_WHY);
    }
  });

  test("the words that keep a dash are the same list on both sides", () => {
    expect([...DASH_WORDS]).toEqual(shared.dash_words);
    expect(new Set(DASH_WORDS).size).toBe(DASH_WORDS.length);
    for (const w of DASH_WORDS) expect(w).toBe(w.toLowerCase());
  });

  test("in words never refused, a dash right after a link (or in one) stays, flagged, since a comma would run into it; so does one before a link", () => {
    // ChatGPT, round four: a dash right after a link became a comma right against the link.
    for (const text of ["See https://example.com/a — then reply.", "See https://example.com/a\u00a0— then reply.", "Open wss://h.example/x — then.", "See www.example.com — then.",
      "See example.com/a — then reply.", "See www.example.com/a—b today.", "See https://example.com/a —.", "See https://example.com/a —\nthen."]) {
      const r = check(text);
      expect(r.hits).toMatchObject([{ rule: "dash", result: "refuse", kept: "link" }]);
      expect(r.fixed).toBe(text);
      expect(whyOf(r.hits[0])).toBe(LINK_WHY);
    }
    // A link is never a plain word: a dash before one, or after a masked one, is kept too, for its own reason.
    expect(check("The notes — https://example.com/a")).toMatchObject({ fixed: "The notes — https://example.com/a", hits: [{ rule: "dash", kept: "range" }] });
    expect(check("Read [the notes](https://example.com/x) — then reply.")).toMatchObject({ hits: [{ rule: "dash", kept: "range" }] });
  });

  test("an em dash with a number, time or date right on both sides, in words never refused, is kept, never read as \"to\", and the reason doesn't call it a range", () => {
    for (const text of ["From 2026 — 2027 it runs.", "Room 4—5 is free.", "Swim moved to 4:30 — 2 blocks shifted.", "Nov 12 — 4:30 PM swim is set.", "Room 4 — 5:30 start.",
      "Sat. 5 — 6 PM", "No. 5 — 6 PM", "Thursday, 12 — 4:30 PM swim is set.", "Dec 3, 12 — 1 PM lunch", "1. 12 — 1 PM", "Swim is 9:30 — 11.",
      "Party is 6 PM — 8.", "At 6 PM — 3, maybe 4 people will arrive.", "Gate 8 — 6:30 PM start", "Dinner at 6 p.m. — 8 guests.", "Done by 6 PM — 3 events moved.",
      // Round three: what " to " once read as a range is held as well, and days, months, noon and midnight count.
      "Swim 9:30 — 10:15.", "6 — 8 PM works.", "from 6 — 8 PM", "Gate:8 — 6:30 PM departure.", "between 5 — 6 PM", "Today:\n5 — 6 PM swim",
      "Swim moved to 4:30 — 2 PM pickup stays.", "Camp runs Monday — Friday.", "Away Nov 12 — Nov 14.", "June — August", "noon — 1 PM", "Open 9 AM — noon.",
      "Away the 5th — 7th.", "Tickets are $5 — $10.", "Down 50% — 60% today."]) {
      const r = check(text);
      expect(r.hits).toMatchObject([{ rule: "dash", result: "refuse" }]);
      expect(r.fixed).toBe(text);                                     // never ", " or " to ": either could change what it says
      expect(whyOf(r.hits[0])).toBe(RANGE_WHY);
    }
    expect(RANGE_WHY).toBe("say it without the dash, as a range in words if it is one");
    expect(check("Swim moved to 4:30 — that works.").fixed).toBe("Swim moved to 4:30 — that works.");   // a time against words: kept too
    expect(check("It's Friday — swim day.").fixed).toBe("It's Friday — swim day.");                 // a day against words: kept too
    expect(whyOf({ rule: "dash", result: "fix" })).toBe("no em dashes");
    expect(whyOf({ rule: "nonsense", result: "refuse" })).toBe("a message rule");
  });

  test("a link in an excerpt keeps only its host, wherever the excerpt starts or ends", () => {
    expect(hostsOnly("See https://github.com/a/b?token=x and https://example.com now.")).toBe("See https://github.com/… and https://example.com now.");
    const text = `${"x".repeat(70)} https://example.com/private/ids/0123456789abcdef0123456789abcdef01234567?key=1 and more words`;
    const r = check(text);
    expect(r.hits).toMatchObject([{ rule: "machine" }]);
    expect(r.hits[0].around).toBe("https://example.com/… and");
    expect(around(text, 100, 110)).not.toContain("private");
  });

  test("a link in an excerpt is its scheme and host alone: no user name, password, port, path, query or fragment; one that can't be read is a link", () => {
    // Nov 14 review: "https://user:secret@example.com/..." kept "user:secret@".
    expect(linkHost("https://user:secret@example.com/private?key=abc")).toBe("https://example.com/…");
    expect(linkHost("https://user:secret@example.com")).toBe("https://example.com/…");
    expect(linkHost("https://a@b@Example.COM:8443/x#frag")).toBe("https://example.com/…");
    expect(linkHost("http://example.com")).toBe("http://example.com");
    expect(linkHost("https://[::1]:80/x")).toBe("https://[::1]/…");
    // ChatGPT, round four: a browser reads "\" as "/", so the authority ends there and what follows is path.
    expect(linkHost("https://public.example\\@secret-token/private")).toBe("https://public.example/…");
    expect(linkHost("https://example.com\\@evil.example/x")).toBe("https://example.com/…");
    expect(linkHost("https://h\\SECRET")).toBe("https://h/…");
    for (const bad of ["https://", "https://user:secret@", "https://exa%mple.com/x", "https://bücher.example/x", "https://ex ample.com", "https://example.com:port/x",
      "https://example.com,", "https://\\SECRET@example.com/x", "https://exa\u200bmple.com/SECRET"])
      expect(linkHost(bad)).toBe("a link");
    // Round three: nothing after the host comes back, parentheses don't end a link, and the scheme is any case.
    for (const tail of ["__", "~~", "!!", "\"x\"", "'x'", "[x]", "x)", "x.", "x,"])
      expect(linkHost(`https://example.com/private?token=${tail}`)).toBe("https://example.com/…");
    expect(hostsOnly("See https://user:p(ss)@example.com/private?key=abc now.")).toBe("See https://example.com/… now.");
    expect(hostsOnly("See https://en.wikipedia.org/wiki/Foo_(bar)?token=X now.")).toBe("See https://en.wikipedia.org/… now.");
    expect(hostsOnly("See HTTPS://user:pw@Host.example/x?key=1 now.")).toBe("See https://host.example/… now.");
    expect(hostsOnly("See Https://example.com/reset?token=X, then.")).toBe("See https://example.com/… then.");
    // The window's edges never cut into a link: it comes out whole, as its host.
    for (const [t, whole] of [["Call https://user:secret@example.com:8443/reset?token=abc today.", "https://example.com/… today."],
      ["Call HTTPS://user:p(se)cret@example.com:8443/reset?token=abc__ today.", "https://example.com/… to"]]) {
      for (let from = 0; from < t.length; from++)
        for (const to of [from + 1, from + 9, t.length]) expect(hostsOnly(t, from, to)).not.toMatch(/user|secret|se\)|8443|reset|token|abc/);
      expect(hostsOnly(t, 10, 20)).toBe("https://example.com/…");
      expect(around(t, 30, 40)).toBe(whole);
    }
    // Round four: a link runs to a space or a line break alone, has any scheme or none ("www.", a domain with a
    // path), and a backslash ends its authority. Each excerpt whole.
    const B = "\\";
    for (const [t, whole] of [
      ["See https://example.com/cb?next=<SECRET> and 3 more.", "See https://example.com/… and 3 more."],
      ["See <https://example.com/x>SECRET and 3 more.", "See <https://example.com/… and 3 more."],
      ["Open wss://h.example/x?token=SECRET and 3 more.", "Open wss://h.example/… and 3 more."],
      ["Open git+ssh://u@host.example:22/r?t=SECRET and 3 more.", "Open git+ssh://host.example/… and 3 more."],
      ["Open WWW.Example.com/reset?token=SECRET and 3 more.", "Open www.example.com/… and 3 more."],
      ["Open www.example.com and 3 more.", "Open www.example.com and 3 more."],
      ["Open example.com/reset?token=SECRET and 3 more.", "Open example.com/… and 3 more."],
      ["Open user:SECRET@example.com/x and 3 more.", "Open example.com/… and 3 more."],
      ["Open bücher.example/x?token=SECRET and 3 more.", "Open a link and 3 more."],
      [`See https://public.example${B}@secret-token/private and 3 more.`, "See https://public.example/… and 3 more."],
      [`Open example.com${B}reset?token=SECRET and 3 more.`, "Open example.com/… and 3 more."],
      ["Open https://example.com\ufeff/SECRET and 3 more.", "Open a link and 3 more."],
      ["Lanes 1.5/2, e.g./i.e. and 4:30/5:00 and 3 more.", "Lanes 1.5/2, e.g./i.e. and 4:30/5:00 and 3 more."],
      // Fable, round four: an IP address with a path, and a domain's trailing dot.
      ["Open 192.168.1.1/admin?pw=SECRET and 3 more.", "Open 192.168.1.1/… and 3 more."],
      ["Open 1.2.3.4:8080/SECRET and 3 more.", "Open 1.2.3.4/… and 3 more."],
      ["Open example.com./SECRET and 3 more.", "Open example.com./… and 3 more."],
      ["Versions 1.2.3.4 and 0.10.0, and 3 more.", "Versions 1.2.3.4 and 0.10.0, and 3 more."],
    ]) {
      const r = check(t, { rules: ["count"] });
      expect(r.hits.map((h) => h.around)).toEqual([whole]);
      expect(around(t, 0, t.length)).toBe(whole);
      expect(hostsOnly(t)).toBe(whole);
    }
  });

  test("a long message is checked quickly, its links found once, with at most MAX_EXCERPTS excerpts and one more per kind", () => {
    // Fable, round four: "a.b" and a dash over and over took 2.7 s at 2,000 characters, 25 s at 4,000.
    const D = "—";
    for (const t of [`a.b${D}`.repeat(5000), D.repeat(20000), `aa bb ${D} cc dd `.repeat(1500), `x.y/a${D}`.repeat(4000), "a@".repeat(10000), "www.".repeat(5000)]) {
      for (const ctx of [{ rules: AT.cain, refusable: true }, { rules: AT.card }]) {
        const t0 = performance.now();
        const r = check(t, ctx);
        expect(performance.now() - t0).toBeLessThan(1000);          // about 25 ms on the builder's laptop; room for a slow box
        expect(r.hits.length).toBeLessThanOrEqual(MAX_EXCERPTS + 10);
      }
    }
    const r = check(`Moved swim ${D} it's at 4:30. `.repeat(40) + "And 3 more.", { rules: AT.cain, refusable: true });
    expect(r.hits.filter((h) => h.rule === "dash")).toHaveLength(MAX_EXCERPTS);
    expect(r.hits.filter((h) => h.rule === "count")).toHaveLength(1);   // a kind past the cap still has its one
    expect(check(`aa bb ${D} cc dd `.repeat(1500), { rules: AT.card }).fixed).toBe("aa bb, cc dd ".repeat(1500));   // every fix made
  });

  test("a verdict: refuse beats fix, fix beats can't tell", () => {
    expect(verdict(check("Moved swim — tap Undo.", { buttons: [] }))).toBe("refuse");
    expect(verdict(check("Moved swim — then art."))).toBe("fix");
    expect(verdict(check("Tap Undo.", { buttons: null }))).toBe("unsure");
    expect(verdict(check("Moved swim to 4:30."))).toBe("pass");
  });
});
