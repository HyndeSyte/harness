// CI: the Worker must have no workers.dev host and no preview URLs, so it answers only on its
// route behind Access. Fails if workers_dev or preview_urls is missing, or anything but false. The
// store must be the Durable Object: the STORE binding to SnapshotStore with its migration, and no
// KV namespace.
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
  const bindings = ((config.durable_objects as any)?.bindings ?? []) as { name?: string; class_name?: string }[];
  if (!bindings.some((b) => b.name === "STORE" && b.class_name === "SnapshotStore"))
    problems.push("the Durable Object binding STORE to SnapshotStore is missing");
  const migrations = (config.migrations ?? []) as { new_sqlite_classes?: string[]; new_classes?: string[] }[];
  if (!migrations.some((m) => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])].includes("SnapshotStore")))
    problems.push("no migration creates the SnapshotStore class");
  if ("kv_namespaces" in config) problems.push("a KV namespace is configured; the store is the Durable Object");
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
  console.log(`wrangler check: ${file}: workers_dev and preview_urls are false; the store is the Durable Object`);
}
