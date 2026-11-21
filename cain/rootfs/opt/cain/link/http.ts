// Cain's link: its local HTTP API's routes (0.12.0, twenty-third round: moved here from main.ts, so a test
// serves exactly what main.ts serves). Since C1 the caller is decided in front of them (main.ts: the
// specialist signs, Cain shows his own key from this machine, root uses its own unix socket), and each
// caller may use only its own routes (auth.ts routeAllowed). The routes are described at the top of main.ts.
import { since } from "../stop";
import { boundedText, type Caller, routeAllowed } from "./auth";
import { noteKey } from "../security/main";
import { type Link, Refusal, SAID_MAX } from "./core";
import type { HcAnswer } from "./healthchecks";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(String);

export interface RouteDeps {
  link: Link;
  toHarness: (path: string, body: unknown) => Promise<boolean>;
  tz?: string;
  hc?: (b: unknown) => Promise<HcAnswer>;          // 0.17.0: keeper.sh hc-check and hc-set (healthchecks.ts)
}

// One request, from a caller already proven: refused unless the route is the caller's.
export function linkRoutes(d: RouteDeps) {
  const { link, toHarness } = d;
  return async (req: Request, url: URL, caller: Caller, raw: string, reqId?: string): Promise<Response> => {
    if (!routeAllowed(caller, url.pathname)) return json({ status: "refused" }, 403);
    if (req.method === "GET" && url.pathname === "/card-of") return json(link.cardInfo(url.searchParams.get("m") ?? ""));
    if (req.method === "GET" && url.pathname === "/cards") return json(await link.cardsFor());
    if (req.method !== "POST") return json({ status: "not found" }, 404);
    if (raw.length > 16384) return json({ status: "too large" }, 413);
    let b: any = {};
    try { b = raw ? JSON.parse(raw) : {}; } catch { return json({ status: "not JSON" }, 400); }
    try {
      switch (url.pathname) {
        case "/card": return json({ id: await link.addCard({ text: String(b.text ?? ""), rows: b.rows ?? [], kind: b.kind, expires: b.expires, req: reqId }) });
        case "/buttons": await link.editButtons(Number(b.card), b.rows ?? []); return json({ status: "ok" });
        case "/answer": await link.followup(String(b.callback ?? ""), String(b.text ?? "")); return json({ status: "ok" });
        case "/relay": { const t = String(b.text ?? "").trim(); if (t) link.relayLine(t); return json({ status: "ok" }); }
        case "/show": return json(await link.showCard(Number(b.id), { item: b.item, question: b.question, replyTo: b.reply_to }));
        case "/ask": return json(await link.ask({ text: String(b.text ?? ""), options: list(b.options),
          item: b.item, question: b.question, replyTo: b.reply_to }));
        case "/ship": return json(await link.ship({ text: String(b.text ?? ""), item: b.item, pr: b.pr, head: b.head, review: b.review, replyTo: b.reply_to }));
        case "/answered": return json(await link.answered({ item: b.item, question: b.question }));
        case "/replied": return json(await link.replied(b.m));
        case "/look": return json(await link.look(b.m));
        case "/reuse": return json(await link.reuseProof(b.m, b.values));
        case "/pc-notice": return json(await link.pcNotice(b.code, b.job, b.id, b.repeat));
        case "/check": return json(link.checkSend({ text: b.text, replyTo: b.reply_to, edit: b.edit }));
        case "/reply": return json(await link.reply({ text: b.text, replyTo: b.reply_to }));
        // keeper.sh key-expiry and key-ack as his own user (0.13.1): the key record is root's.
        case "/key-note": return json(noteKey(String(b.cmd ?? ""), String(b.name ?? ""), String(b.date ?? "")));
        case "/sent": return json(await link.sent(b, { background: true }));
        case "/replay": return json(link.replay(b.days));
        case "/connector": return json(await link.connector({ item: b.item, text: b.text }));
        case "/decision": return json(await link.decision(b));
        // The usage guard's hold from a part of Cain's (round 2): the link decides again and logs it.
        case "/guard-hold": return json(await link.guardHoldFor(b, caller));
        // The heartbeat checks' grace and period at Healthchecks.io (0.17.0): the link holds the key.
        case "/hc": return json(d.hc ? await d.hc(b) : { status: "refused", said: "no key set" });
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

// Root's own unix socket (C1): only root can open it, so being root is the key. What main.ts serves on
// it, and what a test serves on one of its own: the broker's /sent, and the PC job keeper's /reuse and
// /pc-notice (the keeper runs as root). A body larger than any route takes is refused unread.
export function rootFetch(d: RouteDeps, maxBody = 16_384) {
  const routes = linkRoutes(d);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const raw = req.method === "POST" ? await boundedText(req, maxBody) : "";
    if (raw === null) return json({ status: "too large" }, 413);
    return routes(req, url, "root", raw);
  };
}
