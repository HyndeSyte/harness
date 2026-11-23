// The research grader's cited pages, fetched by the runner (Cain 0.19.0, sixth round). No grader has a provider-side
// fetch tool any more: the runner fetches the exact pages cited in a question's answer notes (core.ts noteFetchUrls:
// query strings and fragments stripped, non-HTML paths left out), and puts their text in the grading prompt, so what a
// grader reads is the prompt and nothing else.
//
// Each page: fetched with redirects handled here, never followed by the fetch itself. Every hop must stay on the cited
// host, over https (or the cited scheme), with its path inside the cited path's prefix (the cited path itself, or below
// it); a hop's query string is stripped before it is followed. At most MAX_HOPS hops. Only an HTML answer is read
// (Content-Type text/html or application/xhtml+xml); its body is read to at most MAX_BYTES, stripped to text (scripts,
// styles and tags out, entities decoded, whitespace folded) and cut to PAGE_TEXT_CHARS. Anything else is "not read",
// with the reason, and the grader is told so.
import { PAGE_TEXT_CHARS, fetchableUrl, type CitedPage } from "./core.ts";

export const MAX_HOPS = 5;
export const MAX_BYTES = 2 * 1024 * 1024;
export type PageFetch = (url: string, init: { method: string; redirect: "manual"; signal?: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

const prefixOf = (path: string) => path.replace(/\/+$/, "") || "/";
// Whether a hop stays on the cited page: the same host and scheme, and its path the cited path or below it.
export function hopAllowed(cited: URL, hop: URL): boolean {
  if (hop.protocol !== cited.protocol || hop.host.toLowerCase() !== cited.host.toLowerCase() || hop.username || hop.password) return false;
  const pre = prefixOf(cited.pathname);
  return pre === "/" ? true : hop.pathname === pre || hop.pathname.startsWith(`${pre}/`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "..." };
// An HTML page as plain text.
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; }
      return ENTITIES[e.toLowerCase()] ?? " ";
    })
    .replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function readCapped(r: Response, max: number): Promise<string> {
  if (!r.body) return (await r.text()).slice(0, max);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = []; let n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    parts.push(value); n += value.length;
  }
  try { await reader.cancel(); } catch { /* done */ }
  return new TextDecoder().decode(Buffer.concat(parts).subarray(0, max));
}

// One cited page, as the grader reads it.
export async function fetchCitedPage(url: string, fetchFn: PageFetch, signal?: AbortSignal): Promise<CitedPage> {
  const start = fetchableUrl(url);
  if (!start) return { url, why: "not an HTML page that can be read" };
  const cited = new URL(start);
  let cur = cited;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let r: Response;
    try { r = await fetchFn(cur.toString(), { method: "GET", redirect: "manual", signal, headers: { accept: "text/html,application/xhtml+xml" } }); }
    catch (e) { return { url: start, why: `it couldn't be fetched (${String((e as Error)?.message ?? e).slice(0, 80)})` }; }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      try { await r.body?.cancel(); } catch { /* none */ }
      if (!loc) return { url: start, why: `a redirect with no address (HTTP ${r.status})` };
      let next: URL;
      try { next = new URL(loc, cur); } catch { return { url: start, why: "a redirect to an address that can't be read" }; }
      next.search = ""; next.hash = "";
      if (!hopAllowed(cited, next)) return { url: start, why: "it redirected off the cited host or path, so it wasn't followed" };
      cur = next;
      continue;
    }
    if (r.status !== 200) { try { await r.body?.cancel(); } catch { /* none */ } return { url: start, why: `HTTP ${r.status}` }; }
    const type = (r.headers.get("content-type") ?? "").toLowerCase();
    if (!/^\s*(text\/html|application\/xhtml\+xml)\b/.test(type)) { try { await r.body?.cancel(); } catch { /* none */ } return { url: start, why: "not HTML, so it was skipped" }; }
    const text = htmlToText(await readCapped(r, MAX_BYTES)).slice(0, PAGE_TEXT_CHARS);
    return text ? { url: start, text } : { url: start, why: "the page had no text" };
  }
  return { url: start, why: `more than ${MAX_HOPS} redirects` };
}
