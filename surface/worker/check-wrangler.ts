// CI: the Worker must have no workers.dev host and no preview URLs, so it answers only on its
// route behind Access. Fails if workers_dev or preview_urls is missing, or anything but false.
// Run: bun surface/worker/check-wrangler.ts [path to wrangler.toml]
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function wranglerProblems(text: string): string[] {
  let config: Record<string, unknown>;
  try {
    config = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    return ["wrangler.toml does not parse"];
  }
  const problems: string[] = [];
  for (const key of ["workers_dev", "preview_urls"]) {
    if (!(key in config)) problems.push(`${key} is missing (it must be false)`);
    else if (config[key] !== false) problems.push(`${key} is ${JSON.stringify(config[key])} (it must be false)`);
  }
  // An environment section can turn either back on.
  for (const [name, v] of Object.entries((config.env ?? {}) as Record<string, Record<string, unknown>>))
    for (const key of ["workers_dev", "preview_urls"])
      if (v && key in v && v[key] !== false) problems.push(`env.${name}.${key} is ${JSON.stringify(v[key])} (it must be false)`);
  return problems;
}

if (import.meta.main) {
  const file = process.argv[2] ?? join(import.meta.dir, "wrangler.toml");
  const problems = wranglerProblems(readFileSync(file, "utf8"));
  if (problems.length) {
    for (const p of problems) console.error(`wrangler check: ${file}: ${p}`);
    process.exit(1);
  }
  console.log(`wrangler check: ${file}: workers_dev and preview_urls are false`);
}
