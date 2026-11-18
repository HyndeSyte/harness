// The surface's Worker: PUT /snapshot stores a signed snapshot, GET /snapshot returns the latest.
// Both routes sit behind Cloudflare Access (surface/README.md, Deploy). The Worker holds no
// GitHub token and no record access, and has no way into the home network: it only checks a
// signature and keeps one JSON document in KV.

import { fromBase64, verifySnapshot } from "../../shared/snapshot";

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  SNAPSHOTS: KV;
  // The exporter's Ed25519 public key, raw 32 bytes in base64.
  SNAPSHOT_PUBLIC_KEY: string;
}

const KEY = "latest";
const MAX_BYTES = 512 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function put(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > MAX_BYTES) return json(413, { error: "too large" });
  const text = await request.text();
  if (text.length > MAX_BYTES) return json(413, { error: "too large" });
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "not JSON" });
  }
  let pub: Uint8Array;
  try {
    pub = fromBase64(env.SNAPSHOT_PUBLIC_KEY || "");
  } catch {
    pub = new Uint8Array();
  }
  if (pub.length !== 32) return json(500, { error: "the Worker has no public key configured" });
  if (!(await verifySnapshot(body, pub))) return json(403, { error: "signature does not verify" });
  if (Number.isNaN(Date.parse(body.made_at))) return json(400, { error: "made_at is not a time" });
  const current = await env.SNAPSHOTS.get(KEY);
  if (current) {
    const prev = JSON.parse(current);
    if (Date.parse(prev.made_at) > Date.parse(body.made_at)) return json(409, { error: "older than the stored snapshot" });
  }
  // Store only the signed fields, as received, so nothing unsigned rides along.
  const stored = { version: body.version, made_at: body.made_at, threads: body.threads, sig: body.sig, key_id: body.key_id };
  await env.SNAPSHOTS.put(KEY, JSON.stringify(stored));
  return json(200, { stored: body.made_at });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/snapshot") return json(404, { error: "not found" });
    if (request.method === "PUT") return put(request, env);
    if (request.method === "GET") {
      const current = await env.SNAPSHOTS.get(KEY);
      if (!current) return json(404, { error: "no snapshot yet" });
      return new Response(current, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response(null, { status: 405, headers: { allow: "GET, PUT" } });
  },
};
