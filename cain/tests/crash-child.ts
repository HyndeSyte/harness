// Round 19: a child process for the crash tests: it makes one durable write through the store's own writer and is
// killed (SIGKILL) at the write's crash point, after its bytes are written and before their fsync (at: "write"), or
// after its rename and before the folder's fsync (at: "rename"). The dependent effect (a marker file) comes after the
// write returns, so it must never exist after a kill.
//   bun crash-child.ts <store> <file> <effect file> <write|rename|none>
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AFTER_RENAME, appendLog, crashSpy } from "../rootfs/opt/cain/applog.ts";
import { writeDurable } from "../rootfs/opt/cain/link/core";
import { landingLedger } from "../rootfs/opt/cain/link/landings";
import { realIo, stateFile } from "../rootfs/opt/cain/link/publish";
import { writeAtomic } from "../rootfs/opt/cain/record/main.ts";

const [store, file, effect, at] = process.argv.slice(2);
const kill = () => process.kill(process.pid, "SIGKILL");
crashSpy.on = (f) => {
  if (at === "write" && (f === file || (store === "landing" && f.startsWith(dirname(file)) && !f.includes("#")))) kill();
  if (at === "rename" && f.endsWith(AFTER_RENAME) && (f === file + AFTER_RENAME || store === "landing")) kill();
};
switch (store) {
  case "log": appendLog(file, { t: "rec", n: 2, at: 2 }); break;
  case "atomic": writeAtomic(file, JSON.stringify({ n: 2 }) + "\n"); break;
  case "durable": writeDurable(file, JSON.stringify({ n: 2 }) + "\n"); break;
  case "state": stateFile(file, () => {}, { ...realIo, crash: (w) => { if ((at === "write" && w === "state:after-write") || (at === "rename" && w === "state:after-rename")) kill(); } })
    .save({ messages: {}, n: 2 } as any); break;
  case "landing": landingLedger(dirname(file), `${dirname(file)}-marker.json`).claim("k|2", { pr: "https://github.com/o/r/pull/1", head: "a".repeat(40), at: "2026-11-16T00:00:00.000Z" }); break;
  default: throw new Error(`unknown store ${store}`);
}
writeFileSync(effect, "done");
