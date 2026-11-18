// After the web export: the content policy (script-src 'self') allows no inline script, and
// Pages needs dist/_headers to apply it. Fails if dist/index.html has a <script> without a src,
// or if dist/_headers is missing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "dist");
const problems = [];
if (!existsSync(join(dist, "_headers"))) problems.push("dist/_headers is missing");
const html = readFileSync(join(dist, "index.html"), "utf8");
for (const tag of html.match(/<script\b[^>]*>/gi) ?? [])
  if (!/\ssrc\s*=/i.test(tag)) problems.push(`dist/index.html has an inline script: ${tag}`);
if (problems.length) {
  for (const p of problems) console.error("dist check: " + p);
  process.exit(1);
}
console.log("dist check: no inline script, _headers present");
