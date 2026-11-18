// After the web export: Pages needs dist/_headers to apply the content policy, and the policy
// must hold. Fails if dist/_headers is missing, if its Content-Security-Policy, parsed directive
// by directive, doesn't have script-src 'self' alone (no 'unsafe-inline', no 'unsafe-eval'),
// connect-src 'self' and frame-ancestors 'none', or if any .html file under dist has a <script>
// without a src (the policy allows no inline script).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// The policy's directives: name to its list of sources.
export function parseCsp(value) {
  const out = new Map();
  for (const part of value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources);
  }
  return out;
}

export function cspProblems(headersText) {
  const lines = headersText.split(/\r?\n/).filter((l) => /^\s+Content-Security-Policy:/i.test(l));
  if (!lines.length) return ["dist/_headers has no Content-Security-Policy line"];
  const problems = [];
  for (const line of lines) {
    const csp = parseCsp(line.replace(/^\s+Content-Security-Policy:\s*/i, ""));
    const exactly = (name, want) => {
      const got = csp.get(name);
      if (!got) problems.push(`the content policy has no ${name}`);
      else if (got.length !== 1 || got[0] !== want) problems.push(`${name} must be ${want} alone, not: ${got.join(" ")}`);
    };
    exactly("script-src", "'self'");
    exactly("connect-src", "'self'");
    exactly("frame-ancestors", "'none'");
    for (const [name, sources] of csp)
      for (const bad of ["'unsafe-inline'", "'unsafe-eval'"])
        if (name.startsWith("script-src") && sources.includes(bad)) problems.push(`${name} allows ${bad}`);
  }
  return problems;
}

export function inlineScripts(html) {
  return (html.match(/<script\b[^>]*>/gi) ?? []).filter((tag) => !/\ssrc\s*=/i.test(tag));
}

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : /\.html?$/i.test(e.name) ? [join(dir, e.name)] : [],
  );
}

if (import.meta.main) {
  const dist = join(import.meta.dirname, "..", "dist");
  const problems = [];
  const headers = join(dist, "_headers");
  if (!existsSync(headers)) problems.push("dist/_headers is missing");
  else problems.push(...cspProblems(readFileSync(headers, "utf8")));
  const files = existsSync(dist) ? htmlFiles(dist) : [];
  if (!files.length) problems.push("dist has no .html file");
  for (const file of files)
    for (const tag of inlineScripts(readFileSync(file, "utf8")))
      problems.push(`dist/${relative(dist, file)} has an inline script: ${tag}`);
  if (problems.length) {
    for (const p of problems) console.error("dist check: " + p);
    process.exit(1);
  }
  console.log(`dist check: ${files.length} .html file(s) with no inline script; _headers' content policy holds`);
}
