"""Local stand-ins for Cain's link, Anthropic and OpenAI, spoken to over real HTTP.

They implement only what the controller uses, with the semantics that
matter: the link checks each request is signed with the key made from the bot
token, signs its answers (link/auth.ts, Cain 0.12.0), and returns increasing
card ids; the model endpoints return structured output in
each provider's own response shape, with usage.
"""
from __future__ import annotations

import hmac
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _Base(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        return json.loads(self.rfile.read(n) or b"{}")


def _serve(handler_cls, state):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    httpd.state = state
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class LinkState:
    """Cain's link (cain/rootfs/opt/cain/link/main.ts): holds the cards Cain shows."""

    def __init__(self, token):
        from harness.cain_relay import key_for
        self.key = key_for(token)
        self.lock = threading.Lock()
        self.next_card = 1
        self.cards = {}                  # id -> {"text", "rows", "kind"}
        self.answers = []                # (callback, text)
        self.edits = []                  # card ids whose buttons changed
        self.bad_keys = 0
        self.discord = None              # what /health says about its Discord connection

    def with_buttons(self):
        return [(cid, c) for cid, c in sorted(self.cards.items()) if c["rows"]]


class LinkHandler(_Base):
    # The request must be signed (link/auth.ts); every answer is signed back over its id.
    def _ok(self, text=""):
        from harness.cain_relay import _mac
        st: LinkState = self.server.state
        m = re.match(r"^id=([0-9a-f]{32}),t=(d+),s=([0-9a-f]{64})$", self.headers.get("x-harness-sig") or "")
        want = m and _mac(st.key, ["request", self.command.upper(), self.path, m.group(1), m.group(2), text])
        if not m or not hmac.compare_digest(m.group(3), want):
            st.bad_keys += 1
            self._rid = ""
            self._json(403, {"status": "refused"})
            return False
        self._rid = m.group(1)
        return True

    def _json(self, status, obj):
        from harness.cain_relay import sign_response
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if getattr(self, "_rid", ""):
            self.send_header("x-harness-sig", sign_response(self.server.state.key, self._rid, status, data.decode()))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._ok():
            return
        if self.path == "/health":
            st: LinkState = self.server.state
            return self._json(200, {"status": "ok", **({"discord": st.discord}
                                                       if st.discord is not None else {})})
        if self.path.startswith("/card-of"):
            return self._json(200, {"card": None})
        return self._json(404, {"status": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        text = self.rfile.read(n).decode()
        if not self._ok(text):
            return
        st: LinkState = self.server.state
        body = json.loads(text or "{}")
        with st.lock:
            if self.path == "/card":
                cid = st.next_card
                st.next_card += 1
                st.cards[cid] = {"text": body.get("text", ""), "rows": body.get("rows") or [],
                                 "kind": body.get("kind")}
                return self._json(200, {"id": cid})
            if self.path == "/buttons":
                st.cards[int(body["card"])]["rows"] = body.get("rows") or []
                st.edits.append(int(body["card"]))
                return self._json(200, {"status": "ok"})
            if self.path == "/answer":
                st.answers.append((body.get("callback"), body.get("text")))
                return self._json(200, {"status": "ok"})
        return self._json(404, {"status": "not found"})


def _reply_for(user_text: str) -> dict:
    msg = re.search(r"<message>\n(.*)\n</message>", user_text, re.S)
    said = msg.group(1) if msg else ""
    if "automated health check" in said:
        return {"type": "answer", "text": "canary ok"}
    if said.lower().startswith("from now on"):
        return {"type": "rule", "confirm": "ok", "rule": {
            "rule_type": "drafting", "scope": "draft", "field": "length",
            "value": "short", "literal": said}}
    return {"type": "answer", "text": f"echo: {said}"}


class ModelState:
    def __init__(self, key):
        self.key = key
        self.calls = []
        self.lock = threading.Lock()


class AnthropicHandler(_Base):
    def do_GET(self):
        st = self.server.state
        if self.headers.get("x-api-key") != st.key:
            return self._json(401, {"type": "error", "error": {"type": "authentication_error"}})
        return self._json(200, {"id": self.path.rsplit("/", 1)[-1], "type": "model"})

    def do_POST(self):
        st = self.server.state
        if self.headers.get("x-api-key") != st.key or \
                self.headers.get("anthropic-version") != "2023-06-01":
            return self._json(401, {"type": "error", "error": {"type": "authentication_error"}})
        body = self._body()
        with st.lock:
            st.calls.append(body)
        out = _reply_for(body["messages"][0]["content"])
        return self._json(200, {"model": body["model"], "stop_reason": "end_turn",
                                "content": [{"type": "thinking", "thinking": ""},
                                            {"type": "text",
                                             "text": json.dumps({"output": out})}],
                                "usage": {"input_tokens": 1200, "output_tokens": 300}})


class OpenAIHandler(_Base):
    def do_GET(self):
        st = self.server.state
        if self.headers.get("Authorization") != f"Bearer {st.key}":
            return self._json(401, {"error": {"code": "invalid_api_key"}})
        return self._json(200, {"id": self.path.rsplit("/", 1)[-1], "object": "model"})

    def do_POST(self):
        st = self.server.state
        if self.headers.get("Authorization") != f"Bearer {st.key}":
            return self._json(401, {"error": {"code": "invalid_api_key"}})
        body = self._body()
        with st.lock:
            st.calls.append(body)
        out = _reply_for(body["input"])
        return self._json(200, {"model": body["model"], "status": "completed",
                                "output": [{"type": "message", "content": [
                                    {"type": "output_text",
                                     "text": json.dumps({"output": out})}]}],
                                "usage": {"input_tokens": 900, "output_tokens": 200}})


def cain_link(token):
    st = LinkState(token)
    return _serve(LinkHandler, st), st


def anthropic(key):
    st = ModelState(key)
    return _serve(AnthropicHandler, st), st


def openai(key):
    st = ModelState(key)
    return _serve(OpenAIHandler, st), st
