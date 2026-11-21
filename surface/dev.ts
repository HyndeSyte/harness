// Dev only: a key pair in surface/.dev (made once, never committed), the fixture record exported
// and signed into the app's public/snapshot.json, and the public key and that path in the app's
// .env.local. Then: cd surface/app && bun run web
// Run from the repo root: bun run surface/dev.ts
//   [--record <record checkout> --private-terms <file> [--config <exporter config JSON>]]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./export/index";

const here = import.meta.dir;
const dev = join(here, ".dev");
const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const fixtures = join(here, "export/fixtures");
const record = opt("--record", join(fixtures, "record"))!;
// A real record needs the owner's own private terms file: the exporter refuses to run without one.
const terms = opt("--private-terms", opt("--record") ? undefined : join(fixtures, "private-terms.txt"));
const config = opt("--config", opt("--record") ? undefined : join(fixtures, "exporter.json"));
if (!existsSync(join(dev, "surface.key")) || !existsSync(join(dev, "surface.pub.entry"))) await main(["--keygen", dev]);
mkdirSync(join(here, "app/public"), { recursive: true });
const out = join(here, "app/public/snapshot.json");
const code = await main([
  "--record", record,
  ...(terms ? ["--private-terms", terms] : []),
  ...(config ? ["--config", config] : []),
  "--out", out,
  "--key", join(dev, "surface.key"),
]);
if (code) process.exit(code);
// The key-list entry (key id and raw key), the form the app reads.
const pub = readFileSync(join(dev, "surface.pub.entry"), "utf8").trim();
// The deployed app reads the Worker's /snapshot; dev reads the file in public/.
writeFileSync(
  join(here, "app/.env.local"),
  `EXPO_PUBLIC_SURFACE_PUBLIC_KEY=${pub}\nEXPO_PUBLIC_SURFACE_SNAPSHOT_URL=/snapshot.json\n`,
);
console.log("Wrote the app's .env.local. Now: cd surface/app && bun run web");
