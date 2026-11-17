// Cain's link: its local HTTP API (0.12.0, twenty-third round: moved here from main.ts unchanged, so a test
// serves exactly the handler main.ts serves, on a port of its own). The routes and their keys are described
// at the top of main.ts.
import { since } from "../stop";
import { type Link, Refusal, SAID_MAX } from "./core";
import { healthBody } from "./watch";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(String);

export interface HttpDeps {
  link: Link;
  keyOk: (header: string) => boolean;                       // the relay key (HMAC of the bot token), compared in constant time
  health: () => unknown;                                    // what /health adds for a keyed caller
  toHarness: (path: string, body: unknown) => Promise<boolean>;
  tz?: string;
  localOnly: ReadonlySet<string>;                           // the routes only Cain's own scripts on this machine may call (main.ts LOCAL_ONLY)
}
export function linkFetch(d: HttpDeps) {
  const { link, toHarness } = d;
  return async (req: Request, server: { requestIP(req: Request): { address: string } | null }): Promise<Response> => {
    const url = new URL(req.url);
    const keyOk = d.keyOk(req.headers.get("x-harness-key") ?? "");
    if (req.method === "GET" && url.pathname === "/health")
      return json(healthBody(keyOk, d.health));
    if (!keyOk) return json({ status: "refused" }, 403);
    const ip = server.requestIP(req)?.address ?? "";
    if (d.localOnly.has(url.pathname) && ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1")
      return json({ status: "refused" }, 403);
    if (req.method === "GET" && url.pathname === "/card-of") return json(link.cardInfo(url.searchParams.get("m") ?? ""));
    if (req.method === "GET" && url.pathname === "/cards") return json(await link.cardsFor());
    if (req.method !== "POST") return json({ status: "not found" }, 404);
    const raw = await req.text();
    if (raw.length > 16384) return json({ status: "too large" }, 413);
    let b: any = {};
    try { b = raw ? JSON.parse(raw) : {}; } catch { return json({ status: "not JSON" }, 400); }
    try {
      switch (url.pathname) {
        case "/card": return json({ id: await link.addCard({ text: String(b.text ?? ""), rows: b.rows ?? [], kind: b.kind, expires: b.expires }) });
        case "/buttons": await link.editButtons(Number(b.card), b.rows ?? []); return json({ status: "ok" });
        case "/answer": await link.followup(String(b.callback ?? ""), String(b.text ?? "")); return json({ status: "ok" });
        case "/relay": { const t = String(b.text ?? "").trim(); if (t) link.relayLine(t); return json({ status: "ok" }); }
        case "/show": return json(await link.showCard(Number(b.id), { item: b.item, question: b.question, replyTo: b.reply_to, checked: b.checked, reason: b.reason }));
        case "/ask": return json(await link.ask({ text: String(b.text ?? ""), options: list(b.options),
          item: b.item, question: b.question, replyTo: b.reply_to }));
        case "/ship": return json(await link.ship({ text: String(b.text ?? ""), item: b.item, pr: b.pr, head: b.head, review: b.review, replyTo: b.reply_to, checked: b.checked }));
        case "/answered": return json(await link.answered({ item: b.item, question: b.question }));
        case "/replied": return json(await link.replied(b.m));
        case "/look": return json(await link.look(b.m));
        case "/reuse": return json(await link.reuseProof(b.m, b.values));
        case "/pc-notice": return json(await link.pcNotice(b.code, b.job, b.id, b.repeat));
        case "/check": return json(link.checkSend({ text: b.text, replyTo: b.reply_to, edit: b.edit }));
        case "/sent": return json(await link.sent(b, { background: true }));
        case "/replay": return json(link.replay(b.days));
        case "/connector": return json(await link.connector({ item: b.item, text: b.text }));
        case "/clock": return json(link.clockReport());
        case "/settle": return json(await link.settleKey({ tap: b.tap, how: b.how, said: b.said }));
        case "/installtaps": return json(await link.installTaps({ how: b.how, said: b.said }));
        case "/recoverlogs": return json(await link.recoverLogs({ said: b.said }));
        case "/reads": return json(await link.probeReads(Number(b.n ?? 20)));
        case "/slowread": return json(link.slowRead());
        case "/failwebhook": return json(link.failWebhook());
        case "/stallread": return json(await link.stallRead(Number(b.seconds ?? 20)));
        case "/stopped": {
          const st = link.stopped();
          return json({ status: "ok", stopped: st.stopped, said: !st.stopped ? "Nothing is stopped."
            : st.at === null ? "Nothing runs: the Stop state can't be read. Tell Dane in one line, and log a Build item."
            : `Everything has been stopped${since(st, d.tz)}: Dane tapped Stop. Only he can turn it back on.` });
        }
        case "/morning": {
          if (list(b.options).length) throw new Refusal("the morning message asks nothing: send each decision with ask");
          const m = await link.morningPost(String(b.text ?? ""));
          await toHarness("/morning-posted", {});
          return json({ status: "posted", ...m });
        }
      }
    } catch (e) {
      if (e instanceof Refusal) return json({ status: "refused", said: e.message.slice(0, SAID_MAX) }, 400);
      return json({ status: "error", said: String(e).slice(0, 200) }, 500);
    }
    return json({ status: "not found" }, 404);
  };
}
