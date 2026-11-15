// What went out, told to the link durably (the broker's /sent notes: Stop's place and his edit
// allowlist depend on them). Each note is written to the spool, synced, before it's sent, and a
// note the link didn't take is sent again at each flush (every 30 seconds, and at the broker's
// next start), so a broker that dies between Discord's answer and the link's loses nothing (C1
// code review). The link takes the same note twice harmlessly.
// Nothing is dropped quietly (C1 re-check R5):
//   - a note the spool couldn't keep (the disk refused it) is held here and sent all the same,
//     and the next note the link takes says the spool failed, so Cain hears of it;
//   - a line that can't be read (a crash cut it short), or a note the link refused for good, is
//     kept aside in <spool>.bad and said the same way; if even that can't be written, it stays
//     in the spool;
//   - each note starts on a new line, so a line a crash cut short can't run into the next;
//   - the spool is replaced whole: a temp file, synced, renamed, and its folder synced.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { tellLinkOutcome } from "../hooks/discord-sent";

type Post = (body: string, timeoutMs: number) => Promise<Response>;

function syncFolder(p: string): void {
  try { const d = openSync(dirname(p), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not every platform syncs a folder */ }
}

function appendSynced(path: string, text: string): void {
  const fd = openSync(path, "a", 0o640);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

export class SentSpool {
  private held: string[] = [];
  private flushing = false;
  // What went wrong with the spool, told to the link with the next note it takes.
  problem = "";
  constructor(private path: string, private post: Post, private log: (s: string) => void,
              private wait?: (ms: number) => Promise<unknown>) {}

  get heldCount(): number { return this.held.length; }

  add(note: unknown): void {
    const line = JSON.stringify(note);
    try { appendSynced(this.path, "\n" + line + "\n"); }
    catch (e) {
      this.held.push(line);
      this.trouble(`the broker couldn't keep its record of a message that went out (${String(e).slice(0, 80)}); it was held in memory and told to the link`);
    }
  }

  private trouble(what: string): void {
    this.problem = what.slice(0, 300);
    this.log(`ERROR: ${this.problem}`);
  }

  // Kept aside, never dropped: false when even that couldn't be written (it then stays).
  private aside(line: string, why: string): boolean {
    try { appendSynced(`${this.path}.bad`, line + "\n"); }
    catch (e) { this.log(`ERROR: couldn't keep aside ${why} (${String(e).slice(0, 80)}); it stays in the spool`); return false; }
    this.trouble(`${why} in the broker's record of what went out was kept aside in ${this.path}.bad`);
    return true;
  }

  private async send(line: string): Promise<"ok" | "refused" | "unanswered"> {
    const note = JSON.parse(line);
    const told = this.problem;
    const out = await tellLinkOutcome(told ? { ...note, spool_problem: told } : note, this.post, this.wait);
    if (out === "ok" && told && this.problem === told) this.problem = "";
    return out;
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // First what the spool couldn't keep. One the link refused for good is kept aside if it
      // can be; if not, it goes (the link would only refuse it again), said as an error.
      for (let i = 0; i < this.held.length;) {
        const out = await this.send(this.held[i]);
        if (out === "unanswered") { i++; continue; }
        if (out === "refused" && !this.aside(this.held[i], "a note the link refused"))
          this.trouble("a note the link refused couldn't be kept aside either, so it was dropped (the link would only refuse it again)");
        this.held.splice(i, 1);
      }
      let lines: string[];
      try { lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean); }
      catch (e: any) { if (e?.code !== "ENOENT") this.log(`ERROR: couldn't read the broker's record of what went out (${String(e).slice(0, 80)})`); return; }
      const left: string[] = [];
      for (const l of lines) {
        let readable = true;
        try { JSON.parse(l); } catch { readable = false; }
        if (!readable) { if (!this.aside(l, "a line that couldn't be read")) left.push(l); continue; }
        const out = await this.send(l);
        if (out === "unanswered") left.push(l);
        else if (out === "refused" && !this.aside(l, "a note the link refused")) left.push(l);
      }
      // Notes added while this ran stay: only the lines read here are replaced.
      let now: string[] = [];
      try { now = readFileSync(this.path, "utf8").split("\n").filter(Boolean); } catch { /* gone */ }
      const rest = [...left, ...now.slice(lines.length)];
      const tmp = `${this.path}.tmp`;
      const fd = openSync(tmp, "w", 0o640);
      try { writeSync(fd, rest.length ? rest.join("\n") + "\n" : ""); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
      syncFolder(this.path);
    } catch (e) { this.log(`couldn't tell the link what went out: ${String(e).slice(0, 80)}`); }
    finally { this.flushing = false; }
  }
}
