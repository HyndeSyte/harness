// A fake Discord, record and clock around Cain's link (link/core.ts), for the tests.
import { emptyState, Link, State } from "../rootfs/opt/cain/link/core";

export const OWNER = "4242", DM = "5151", BOT = "999";
export const NOV11_8AM = Date.UTC(2026, 10, 11, 13, 0);   // Wed Nov 11 2026, 8:00 AM in New York
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const SHA1 = "1".repeat(40), SHA2 = "2".repeat(40);
export const PR = "https://github.com/HyndeSyte/harness/pull/5";

const copy = (o: any) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export function pendingWith(open: string[], done: string[]): string {
  return ["# Pending", "", "## Open", "", "| ID | Item | Who | Next step | Waits for | Done when | Since |", "|---|---|---|---|---|---|---|",
    ...open.map((id) => `| ${id} | Something | Cain | Next | | Done | Nov 9 |`), "", "## Done", "", "| Item | Date |", "|---|---|",
    ...done.map((id) => `| ${id} Something finished | Nov 10 |`), ""].join("\n");
}

export function rig(opts: { paired?: string; now?: number; pending?: string | null; holds?: string | null } = {}) {
  let state: State = emptyState();
  const t = { now: opts.now ?? NOV11_8AM };
  const files: { pending: string | null; holds: string | null } = { pending: opts.pending ?? null, holds: opts.holds ?? null };
  const heads: Record<string, string> = {};
  const calls: any[] = [], relayed: string[] = [], harness: any[] = [], logs: string[] = [];
  const posted: Record<string, any> = {};
  const failing = new Set<string>();             // path prefixes that fail, like "/interactions/" or "PATCH"
  const limited = new Set<string>();             // the same, answered with Discord's rate limit
  let seq = 0, lastId = "", tapped = "";
  const snowflake = (at = t.now) => String(((BigInt(at) - 1420070400000n) << 22n) + BigInt(++seq));
  const rest = async (method: string, path: string, body?: any, auth = true) => {
    calls.push({ method, path, body: copy(body), auth });
    for (const f of failing) if (path.startsWith(f) || `${method} ${path}`.startsWith(f)) throw new Error("discord 500: unavailable");
    for (const f of limited) if (path.startsWith(f) || `${method} ${path}`.startsWith(f)) throw new Error("discord 429: You are being rate limited.");
    if (path === "/oauth2/applications/@me") return { owner: { id: OWNER } };
    if (path === "/users/@me") return { id: BOT };
    if (path === "/users/@me/channels") return { id: DM };
    if (method === "POST" && path === `/channels/${DM}/messages`) {
      const msg = { id: snowflake(), content: body.content, components: body.components ?? [], author: { id: BOT },
        ...(body.message_reference ? { message_reference: body.message_reference } : {}) };
      posted[msg.id] = msg;
      lastId = msg.id;
      return copy(msg);
    }
    if (method === "GET" && path.startsWith(`/channels/${DM}/messages?`))
      return Object.values(posted).sort((a: any, b: any) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).map(copy);
    const one = new RegExp(`^/channels/${DM}/messages/(\\d+)$`).exec(path);
    if (one && method === "GET") return posted[one[1]] ? copy(posted[one[1]]) : { author: { id: OWNER } };
    if (one && method === "PATCH") {
      const m = posted[one[1]];
      if (!m) throw new Error("discord 404: Unknown Message");
      if (body.content !== undefined) m.content = body.content;
      if (body.components !== undefined) m.components = body.components;
      return copy(m);
    }
    if (method === "POST" && path.startsWith("/interactions/") && body?.type === 7 && posted[tapped]) {
      if (body.data.content !== undefined) posted[tapped].content = body.data.content;
      posted[tapped].components = body.data.components;
    }
    return null;
  };
  const deps = {
    rest, load: () => copy(state), save: (s: State) => { state = copy(s); }, now: () => t.now,
    relay: (x: string) => { relayed.push(x); }, toHarness: async (p: string, b: unknown) => { harness.push([p, b]); return true; },
    paired: () => opts.paired ?? OWNER, log: (l: string) => { logs.push(l); },
    record: () => ({ ...files }), head: async (pr: string) => heads[pr] ?? null, tz: "America/New_York",
  };
  let link = new Link(deps);
  const tap = (msg: any, custom_id: string, over: any = {}) => {
    tapped = String(msg.id);
    return link.onInteraction({ type: 3, id: "11", token: "t", application_id: BOT, channel_id: DM, user: { id: OWNER },
      data: { custom_id }, message: copy(msg), ...over });
  };
  // Dane's own message in the DM, optionally a Discord reply to one of the bot's.
  const his = (content: string, replyTo?: string) => {
    const msg = { id: snowflake(), content, components: [], author: { id: OWNER },
      ...(replyTo ? { message_reference: { type: 0, message_id: replyTo, channel_id: DM } } : {}) };
    posted[msg.id] = msg;
    return msg;
  };
  const r = {
    get link() { return link; },
    calls, relayed, harness, posted, logs, files, heads, failing, limited, t, tap, his, snowflake,
    answers: () => calls.filter((c) => c.path.startsWith("/interactions/")).map((c) => c.body.type),
    updates: () => calls.filter((c) => c.path.startsWith("/interactions/") && c.body.type === 7).map((c) => c.body.data),
    ephemerals: () => calls.filter((c) => c.path.startsWith("/webhooks/")).map((c) => c.body),
    last: () => posted[lastId],
    msg: (id: string) => posted[id],
    buttons: (id: string) => (posted[id]?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.label)),
    ids: (id: string) => (posted[id]?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.custom_id)),
    state: () => copy(state) as State,
    setState: (s: State) => { state = copy(s); },
    restart: () => { link = new Link(deps); return link; },
    later: (ms: number) => { t.now += ms; },
  };
  return r;
}
