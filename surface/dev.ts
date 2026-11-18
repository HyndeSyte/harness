// Dev only: a key pair in surface/.dev (made once, never committed), the fixture record exported
// and signed into the app's public/snapshot.json, and the public key in the app's .env.local.
// Then: cd surface/app && bun run web
// Run from the repo root: bun run surface/dev.ts [--record <record checkout>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./export/index";

const here = import.meta.dir;
const dev = join(here, ".dev");
const args = process.argv.slice(2);
const record = args.includes("--record") ? args[args.indexOf("--record") + 1] : join(here, "export/fixtures/record");
if (!existsSync(join(dev, "surface.key"))) await main(["--keygen", dev]);
mkdirSync(join(here, "app/public"), { recursive: true });
const out = join(here, "app/public/snapshot.json");
const code = await main(["--record", record, "--out", out, "--key", join(dev, "surface.key")]);
if (code) process.exit(code);
const pub = readFileSync(join(dev, "surface.pub.b64"), "utf8").trim();
writeFileSync(join(here, "app/.env.local"), `EXPO_PUBLIC_SURFACE_PUBLIC_KEY=${pub}\n`);
console.log("Wrote the app's .env.local. Now: cd surface/app && bun run web");
