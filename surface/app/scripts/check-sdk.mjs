// Offline: the lockfile's expo, react, react-dom and react-native must be one Expo SDK 58 set.
// Expo documents each SDK's set in bundledNativeModules.json inside the expo package itself, so
// this reads the expo version the lockfile resolves, the set that version ships, and checks the
// lockfile resolves exactly those versions. No network. Run after `bun install --frozen-lockfile`.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SDK = 58;
const here = join(import.meta.dirname, "..");
const lock = readFileSync(join(here, "bun.lock"), "utf8");

// bun.lock's packages section: "name": ["name@version", ...]
function locked(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const m = lock.match(new RegExp(`\\n\\s*"${esc}": \\["${esc}@([^"]+)"`));
  if (!m) throw new Error(`bun.lock resolves no ${name}`);
  return m[1];
}

const problems = [];
const expo = locked("expo");
if (Number(expo.split(".")[0]) !== SDK) problems.push(`expo ${expo} is not SDK ${SDK}`);
const installedExpo = JSON.parse(readFileSync(join(here, "node_modules/expo/package.json"), "utf8")).version;
if (installedExpo !== expo) problems.push(`installed expo ${installedExpo} differs from the lockfile's ${expo}`);
const documented = JSON.parse(readFileSync(join(here, "node_modules/expo/bundledNativeModules.json"), "utf8"));
for (const name of ["react", "react-dom", "react-native"]) {
  const want = documented[name];
  const got = locked(name);
  if (!want) problems.push(`expo ${expo} documents no ${name}`);
  else if (got !== want.replace(/^[~^]/, "")) problems.push(`${name} ${got} is not SDK ${SDK}'s ${want}`);
}
if (problems.length) {
  for (const p of problems) console.error("SDK check: " + p);
  process.exit(1);
}
console.log(`SDK ${SDK} set: expo ${expo}, react ${locked("react")}, react-dom ${locked("react-dom")}, react-native ${locked("react-native")}`);
