"""Local stand-ins for Telegram, Anthropic and OpenAI, spoken to over real HTTP.

They implement only what the controller uses, with the semantics that
matter: getUpdates long-polls and confirms by offset; sendMessage returns
increasing message ids; the model endpoints return structured output in
each provider's own response shape, with usage.
"""
from __future__ import annotations

import json
import re
import threading
import time
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


class TelegramState:
    def __init__(self, token, username="example_harness_bot"):
        self.token = token
        self.username = username
        self.lock = threading.Condition()
        self.queue = []                  # pending updates (dicts)
        self.next_update = 1
        self.next_message = 1000
        self.sent = []                   # (chat_id, text, markup, message_id)
        self.edits = []
        self.answers = []
        self.bad_paths = 0

    def push(self, kind, payload):
        with self.lock:
            u = {"update_id": self.next_update, kind: payload}
            self.next_update += 1
            self.queue.append(u)
            self.lock.notify_all()
            return u["update_id"]

    def say(self, user, text, *, chat=None, reply_to=None):
        with self.lock:
            mid = self.next_message
            self.next_message += 1
        m = {"message_id": mid, "from": {"id": user, "is_bot": False},
             "chat": {"id": chat or user, "type": "private"}, "date": int(time.time()),
             "text": text}
        if reply_to:
            m["reply_to_message"] = {"message_id": reply_to}
        self.push("message", m)
        return mid

    def tap(self, user, data, message_id, chat=None):
        self.push("callback_query", {"id": f"cq{self.next_update}", "data": data,
                                     "from": {"id": user, "is_bot": False},
                                     "chat_instance": "x",
                                     "message": {"message_id": message_id,
                                                 "chat": {"id": chat or user,
                                                          "type": "private"}}})


class TelegramHandler(_Base):
    def do_POST(self):
        st: TelegramState = self.server.state
        m = re.fullmatch(r"/bot([^/]+)/(\w+)", self.path)
        if not m or m.group(1) != st.token:
            st.bad_paths += 1
            return self._json(401, {"ok": False, "error_code": 401,
                                    "description": "Unauthorized"})
        method, body = m.group(2), self._body()
        if method == "getUpdates":
            offset = body.get("offset", 0)
            deadline = time.time() + min(float(body.get("timeout", 0)), 5)
            with st.lock:
                if offset:
                    st.queue = [u for u in st.queue if u["update_id"] >= offset]
                while not st.queue and time.time() < deadline:
                    st.lock.wait(timeout=max(0.0, deadline - time.time()))
                out = list(st.queue[:100])
            return self._json(200, {"ok": True, "result": out})
        if method == "sendMessage":
            text = body.get("text", "")
            if not 1 <= len(text) <= 4096:
                return self._json(400, {"ok": False, "error_code": 400,
                                        "description": "Bad Request: message is too long"})
            with st.lock:
                mid = st.next_message
                st.next_message += 1
                st.sent.append((body["chat_id"], text, body.get("reply_markup"), mid))
            return self._json(200, {"ok": True, "result": {"message_id": mid}})
        if method == "editMessageReplyMarkup":
            st.edits.append(body)
            return self._json(200, {"ok": True, "result": True})
        if method == "answerCallbackQuery":
            st.answers.append(body)
            return self._json(200, {"ok": True, "result": True})
        if method == "getMe":
            return self._json(200, {"ok": True, "result": {"id": 1, "is_bot": True,
                                                           "username": st.username}})
        if method == "getWebhookInfo":
            return self._json(200, {"ok": True, "result": {"url": ""}})
        if method == "setMyCommands":
            return self._json(200, {"ok": True, "result": True})
        return self._json(404, {"ok": False, "error_code": 404, "description": "Not Found"})


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


def telegram(token):
    st = TelegramState(token)
    return _serve(TelegramHandler, st), st


def anthropic(key):
    st = ModelState(key)
    return _serve(AnthropicHandler, st), st


def openai(key):
    st = ModelState(key)
    return _serve(OpenAIHandler, st), st
