// The record keeper's rules, with no I/O, so they can be tested on their own.
// Every change to Cain's record (the private org repo) arrives as a small JSON
// "request". The keeper is the record's one writer: it applies requests one at a
// time, in order, and only when they still fit the record as it stands.

export type Op =
  | { op: "put"; path: string; content: string; base: string }        // base: blob sha, or "new"
  | { op: "append"; path: string; text: string }                      // add lines at the end
  | { op: "remove"; path: string; base: string; merged_into: string } // only as part of a merge

export type Request = {
  id: string;          // unique; the receipt Dane or Cain can look up
  from: string;        // cain | page | laptop | specialist:<name>
  kind: "change" | "note";
  summary: string;     // one line, becomes the commit message
  ops?: Op[];          // kind "change"
  note?: { text: string; about?: string };  // kind "note": Dane's words from his page, for Cain
};

export type Outcome = {
  id: string; from: string; kind: string; summary: string;
  state: "done" | "conflict" | "rejected" | "relayed";
  reason?: string; at: string; commit?: string;
};

// Where requests may write. log/ and inbox/ belong to the keeper itself; code,
// workflows and the repo's own settings are never written through requests.
// reviews/ holds outside-model reviews (written by the review runner, as Cain).
const WRITABLE = /^(areas|state|archive|rules|projects|reviews)\/[A-Za-z0-9._ \/&()-]+$/;
const APPEND_ONLY = /(^|\/)decisions\.md$/i;

// Text that ends up in Cain's terminal: one line, no control characters, short.
export function clean(s: unknown, max = 160): string {
  let t = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0)!;
    t += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? " " : ch;
  }
  t = t.replace(/ {2,}/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
const okPath = (p: string) => WRITABLE.test(p) && !p.includes("..") && !p.includes("//") && !p.endsWith("/");
const NOTE = /^areas\/[^/]+\/notes\/.+\.md$/;
export const MAX_BYTES = 60_000;   // Notion pages died of size; nothing here grows that big

export function parseRequest(raw: string): { req?: Request; error?: string } {
  let j: any;
  try { j = JSON.parse(raw); } catch { return { error: "not JSON" }; }
  if (!j || typeof j !== "object") return { error: "not an object" };
  if (typeof j.id !== "string" || !/^[A-Za-z0-9._:-]{6,80}$/.test(j.id)) return { error: "bad id" };
  if (typeof j.from !== "string" || !j.from) return { error: "missing from" };
  if (j.kind !== "change" && j.kind !== "note") return { error: "kind must be change or note" };
  if (typeof j.summary !== "string" || !j.summary.trim() || j.summary.length > 200) return { error: "summary must be one short line" };
  // From here the request is identifiable, so errors keep it (its id and sender
  // go into the log and the reply).
  const req = j as Request;
  if (j.kind === "note") {
    if (!j.note || typeof j.note.text !== "string" || !j.note.text.trim()) return { req, error: "note needs text" };
    return { req };
  }
  if (!Array.isArray(j.ops) || j.ops.length === 0 || j.ops.length > 50) return { req, error: "change needs 1 to 50 ops" };
  for (const o of j.ops) {
    if (!o || typeof o.path !== "string") return { req, error: "op without a path" };
    if (!["put", "append", "remove"].includes(o.op)) return { req, error: "unknown op" };
    if (!okPath(o.path)) return { req, error: `${clean(o.path, 80)}: not a place requests may write` };
    if (o.op === "put" && (typeof o.content !== "string" || typeof o.base !== "string")) return { req, error: `put ${o.path}: needs content and base` };
    if (o.op === "put" && o.content.trim() === "") return { req, error: `put ${o.path}: empty content; removing a file is only done as part of a merge` };
    if (o.op === "append" && (typeof o.text !== "string" || !o.text.trim())) return { req, error: `append ${o.path}: needs text` };
    if (o.op === "remove" && (typeof o.base !== "string" || typeof o.merged_into !== "string" || !okPath(o.merged_into))) return { req, error: `remove ${o.path}: needs base and an allowed merged_into` };
  }
  return { req };
}

// What the keeper needs to know about the record as it stands.
export interface Tree {
  sha(path: string): string | null;      // git blob sha, or null if absent
  read(path: string): string | null;
  isDir?(path: string): boolean;
}

// Checks a change against the record and returns the files to write, or why not.
// "conflict" means the record moved on since the writer read it: Cain redoes it.
// "rejected" means the change breaks a rule: it would never be right.
export function plan(req: Request, tree: Tree):
  { state: "ok"; writes: Map<string, string | null> } | { state: "conflict" | "rejected"; reason: string } {
  const writes = new Map<string, string | null>();   // null = delete
  const current = (p: string) => writes.has(p) ? writes.get(p)! : tree.read(p);
  for (const o of req.ops ?? []) {
    const p = o.path;
    if (!okPath(p)) return { state: "rejected", reason: `${clean(p, 80)}: not a place requests may write` };
    if (tree.isDir?.(p)) return { state: "rejected", reason: `${p}: is a folder` };
    if (o.op === "put") {
      if (APPEND_ONLY.test(p) && tree.read(p) !== null) return { state: "rejected", reason: `${p}: decisions are only ever added to` };
      const have = tree.sha(p);
      if (o.base === "new" ? have !== null : o.base !== have)
        return { state: "conflict", reason: `${p}: changed since it was read` };
      if (NOTE.test(p)) {
        const why = noteProblem(o.content);
        if (why) return { state: "rejected", reason: `${p}: ${why}` };
      }
      writes.set(p, o.content);
    } else if (o.op === "append") {
      if (NOTE.test(p) && current(p) === null) return { state: "rejected", reason: `${p}: a new note is made with put, with its front matter` };
      const before = current(p) ?? "";
      const sep = before === "" || before.endsWith("\n") ? "" : "\n";
      writes.set(p, before + sep + o.text.replace(/\n*$/, "\n"));
    } else if (o.op === "remove") {
      if (tree.sha(p) !== o.base) return { state: "conflict", reason: `${p}: changed since it was read` };
      writes.set(p, null);
    }
    const w = writes.get(p);
    if (w && Buffer.byteLength(w) > MAX_BYTES) return { state: "rejected", reason: `${p}: over ${MAX_BYTES / 1000} KB; split it into topics` };
  }
  // A removal is only ever the losing side of a merge: the survivor must exist
  // after this change and say, in its replaces field, that it absorbed the loser.
  for (const o of req.ops ?? []) {
    if (o.op !== "remove") continue;
    const survivor = current(o.merged_into);
    if (!survivor) return { state: "rejected", reason: `${o.path}: merged_into ${o.merged_into} doesn't exist` };
    if (!frontMatter(survivor).replaces.includes(o.path))
      return { state: "rejected", reason: `${o.path}: ${o.merged_into} must list it under replaces` };
  }
  return { state: "ok", writes };
}

export function frontMatter(text: string): { id?: string; title?: string; sources: string[]; replaces: string[]; aliases: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = { sources: [] as string[], replaces: [] as string[], aliases: [] as string[] } as any;
  if (!m) return out;
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (["sources", "replaces", "aliases"].includes(key)) {
        if (v.startsWith("[")) out[key] = v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        else if (v) out[key] = [v.replace(/^["']|["']$/g, "")];
      } else if (v) out[key] = v.replace(/^["']|["']$/g, "");
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && Array.isArray(out[key])) out[key].push(item[1].trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

function noteProblem(text: string): string | null {
  const fm = frontMatter(text);
  if (!fm.id) return "a note needs an id";
  if (fm.sources.length === 0) return "a note needs at least one source";
  return null;
}

// ---- Nightly hygiene: deterministic checks only. Judgment goes to Cain. ----

export type Finding = { kind: string; path: string; detail: string };

// files: the text of what's checked; exists: every path in the record (and every
// folder), so links to anything in it count as good.
export function hygiene(files: Map<string, string>, exists: Set<string> = new Set(files.keys())): Finding[] {
  const out: Finding[] = [];
  const known = new Set(exists);
  for (const p of exists) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) known.add(parts.slice(0, i).join("/")); }
  const ids = new Map<string, string>();
  const titles: { path: string; words: Set<string> }[] = [];
  for (const [path, text] of files) {
    if (!path.endsWith(".md")) continue;
    if (Buffer.byteLength(text) > MAX_BYTES) out.push({ kind: "too big", path, detail: `${Math.round(Buffer.byteLength(text) / 1000)} KB` });
    if (NOTE.test(path)) {
      const fm = frontMatter(text);
      const why = noteProblem(text);
      if (why) out.push({ kind: "incomplete note", path, detail: why });
      if (fm.id) {
        if (ids.has(fm.id)) out.push({ kind: "same id", path, detail: `also used by ${ids.get(fm.id)}` });
        else ids.set(fm.id, path);
      }
      const t = (fm.title ?? path.split("/").pop()!.replace(/\.md$/, "")).toLowerCase();
      titles.push({ path, words: new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2)) });
    }
    // Relative links that point nowhere.
    for (const m of text.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)/g)) {
      let rel = m[1];
      try { rel = decodeURIComponent(rel); } catch { /* keep it as written */ }
      const target = resolve(path, rel.split(":")[0]);   // file.md:12 line suffixes
      if (!known.has(target)) out.push({ kind: "broken link", path, detail: clean(m[1], 80) });
    }
  }
  // Likely duplicates: titles that share most of their words, within an area.
  for (let i = 0; i < titles.length; i++) for (let j = i + 1; j < titles.length; j++) {
    const a = titles[i], b = titles[j];
    if (a.path.split("/")[1] !== b.path.split("/")[1] || a.words.size === 0 || b.words.size === 0) continue;
    const shared = [...a.words].filter((w) => b.words.has(w)).length;
    if (shared / Math.min(a.words.size, b.words.size) >= 0.8 && shared >= 2)
      out.push({ kind: "possible duplicate", path: a.path, detail: b.path });
  }
  return out;
}

function resolve(from: string, rel: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

export function hygieneReport(f: Finding[], day: string): string {
  if (f.length === 0) return `# Record check\n\n${day}: nothing found.\n`;
  const rows = f.map((x) => `| ${x.kind} | ${x.path} | ${x.detail.replace(/\|/g, "/")} |`).join("\n");
  return `# Record check\n\n${day}: ${f.length} to look at. Cain fixes these and reports what he did.\n\n| What | File | Detail |\n| --- | --- | --- |\n${rows}\n`;
}
