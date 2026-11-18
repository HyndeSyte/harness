// The hosts Cain normally cites, for the gate's links rule (gate/cain.ts LINK_HOSTS): the
// built-in list and one file the owner's chief of staff extends (Cain 0.13.0, second round).
// A link to a host off the list is never held, only noted in the gate report.
//   bun hosts.ts add <host>     keeper.sh link-host <host>: adds one, says what the list holds
//   bun hosts.ts list           the list as the gate reads it
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { LINK_HOSTS, readHostList } from "./cain";

export const HOSTS_FILE = process.env.CAIN_LINK_HOSTS ?? "/data/work/link-hosts.txt";

export function readHosts(path = HOSTS_FILE): Set<string> {
  let text: string | null = null;
  try { text = readFileSync(path, "utf8"); } catch { /* none added yet */ }
  return readHostList(text);
}

// One host added: lower case, a name with a dot, no scheme, path or port.
export function addHost(raw: string, path = HOSTS_FILE): { ok: boolean; said: string } {
  const h = String(raw ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!/^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(h) || h.split(".").some((l) => l.startsWith("xn--")))
    return { ok: false, said: "A host is a plain name like example.com: no scheme, path, port or punycode." };
  if (readHosts(path).has(h)) return { ok: true, said: `${h} is on the list already.` };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${h}\n`);
  return { ok: true, said: `Added ${h}: links to it (and under it) no longer note the gate report.` };
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "add") {
    const r = addHost(arg ?? "");
    console.log(JSON.stringify({ status: r.ok ? "ok" : "error", said: r.said }));
    process.exit(r.ok ? 0 : 2);
  }
  if (cmd === "list") { console.log([...readHosts()].sort().join("\n")); process.exit(0); }
  console.error(`usage: hosts.ts add <host> | list   (built in: ${LINK_HOSTS.length} hosts)`);
  process.exit(2);
}
