"""The keeper's own Discord connection: it hears presses on its buttons, nothing else.

It identifies with one intent, DIRECT_MESSAGE_REACTIONS, so Discord sends it no
messages at all: only READY, INTERACTION_CREATE for button presses on this bot's
messages, and reactions in DMs (which carry an emoji and ids, never text). Cain's
connection on the same bot hears his messages; this one never does. Cain's plugin
doesn't ask for reactions, so this connection hears them for him.

Plain stdlib: a TLS socket, a minimal WebSocket client (RFC 6455: masked
client frames, ping/pong, close, fragments), and the gateway protocol
(discord.com/developers/docs/events/gateway, v10): Hello (op 10) gives the
heartbeat interval; Identify (op 2) or Resume (op 6); Heartbeat (op 1) and
its ACK (op 11); Reconnect (op 7) and Invalid Session (op 9) start over.
A missed heartbeat ACK means the link is dead: reconnect and resume.
Presses are handed to on_interaction on the reading thread; it must answer
within Discord's 3 seconds, so it should not block on calendar work.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import random
import socket
import ssl
import struct
import threading
import time
from typing import Callable
from urllib.parse import urlsplit

from .net import REDACT

log = logging.getLogger("harness.gateway")

GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HOSTS_SUFFIX = ".discord.gg"
OP_DISPATCH, OP_HEARTBEAT, OP_IDENTIFY, OP_RESUME, OP_RECONNECT = 0, 1, 2, 6, 7
OP_INVALID, OP_HELLO, OP_ACK = 9, 10, 11
# Close codes after which retrying with the same token can't work.
INTENTS = 1 << 13          # DIRECT_MESSAGE_REACTIONS
FATAL = {4004: "token refused", 4010: "invalid shard", 4011: "sharding required",
         4012: "invalid version", 4013: "invalid intents", 4014: "intents not allowed"}


class Closed(Exception):
    def __init__(self, code: int | None = None, reason: str = ""):
        self.code = code
        super().__init__(f"closed {code} {reason}".strip())


class WebSocket:
    """Just enough RFC 6455 for one JSON text stream."""

    def __init__(self, url: str, *, timeout: float = 30, connect=None):
        parts = urlsplit(url)
        if parts.scheme != "wss" or not parts.hostname or not (
                parts.hostname == "gateway.discord.gg" or parts.hostname.endswith(HOSTS_SUFFIX)):
            raise Closed(None, "blocked host")
        self.host = parts.hostname
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        if connect is None:
            raw = socket.create_connection((self.host, 443), timeout=timeout)
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw, server_hostname=self.host)
        else:
            self.sock = connect(self.host)
        self.sock.settimeout(timeout)
        self._buf = b""
        self._send_lock = threading.Lock()
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {self.host}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\nUser-Agent: harness\r\n\r\n")
        self.sock.sendall(req.encode())
        head = self._read_until(b"\r\n\r\n").decode("latin-1")
        lines = head.split("\r\n")
        if not lines[0].startswith("HTTP/1.1 101"):
            raise Closed(None, f"upgrade refused: {lines[0][:60]}")
        want = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        accept = next((l.split(":", 1)[1].strip() for l in lines[1:]
                       if l.lower().startswith("sec-websocket-accept:")), "")
        if accept != want:
            raise Closed(None, "bad accept")
        # From here, silence is normal between heartbeats; a dead link is caught
        # by the missing heartbeat ACK, which closes the socket.
        self.sock.settimeout(None)

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self._buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise Closed(None, "eof")
            self._buf += chunk
            if len(self._buf) > 65536:
                raise Closed(None, "header too long")
        head, self._buf = self._buf.split(marker, 1)
        return head

    def _read(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self._buf)))
            if not chunk:
                raise Closed(None, "eof")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        head = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self._send_lock:
            self.sock.sendall(head + mask + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def close(self, code: int = 1000) -> None:
        try:
            self._send_frame(0x8, struct.pack("!H", code))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def recv_text(self) -> str:
        """The next whole text message; answers pings, raises Closed on close."""
        parts: list[bytes] = []
        while True:
            b1, b2 = self._read(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            if n > 16 * 1024 * 1024:
                raise Closed(None, "frame too large")
            mask = self._read(4) if b2 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                code = struct.unpack("!H", data[:2])[0] if len(data) >= 2 else None
                raise Closed(code, data[2:].decode("utf-8", "replace")[:100])
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x0, 0x2):
                parts.append(data)
                if fin:
                    return b"".join(parts).decode("utf-8")
                continue
            raise Closed(None, f"opcode {opcode}")


class Gateway:
    """Keeps one connection up, forever, in its own thread."""

    def __init__(self, token_fn: Callable[[], str], on_interaction: Callable[[dict], None], *,
                 on_state: Callable[[str], None] | None = None,
                 on_reaction: Callable[[dict], None] | None = None, connect=None,
                 sleep=time.sleep, url: str = GATEWAY):
        self._token_fn = token_fn
        self._on_interaction = on_interaction
        self._on_state = on_state or (lambda s: None)
        self._on_reaction = on_reaction or (lambda d: None)
        self._connect = connect
        self._sleep = sleep
        self._url = url
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.session_id: str | None = None
        self.resume_url: str | None = None
        self.seq: int | None = None
        self.state = "off"
        self.last_ack = 0.0
        self.fatal: str | None = None

    def _set(self, state: str) -> None:
        if state != self.state:
            self.state = state
            try:
                self._on_state(state)
            except Exception as e:            # a bad listener never drops the link
                log.error("gateway: state handler failed: %s", type(e).__name__)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="gateway", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        failures = 0
        while not self._stop.is_set():
            token = self._token_fn()
            if not token:
                self._set("no token")
                self._sleep(30)
                continue
            if self.fatal:
                self._set(f"stopped: {self.fatal}")
                self._sleep(60)
                if self._token_fn() != token:
                    self.fatal = None          # a new token: try again
                continue
            try:
                self._session(token)
                failures = 0
            except Closed as e:
                if e.code in FATAL:
                    self.fatal = FATAL[e.code]
                    log.error("gateway: %s", self.fatal)
                    continue
                if e.code in (4007, 4009):     # bad seq / session timed out: start fresh
                    self.session_id = self.seq = None
                failures += 1
                log.warning("gateway: %s", REDACT(str(e)))
            except Exception as e:             # anything else: never let the thread die
                failures += 1
                log.warning("gateway: %s", type(e).__name__)
            self._set("reconnecting")
            self._sleep(min(60, 2 ** min(failures, 6)) * random.uniform(0.8, 1.2))

    def _session(self, token: str) -> None:
        REDACT.register(token)
        url = self.resume_url if (self.session_id and self.resume_url) else self._url
        if "?" not in url:
            url += "/?v=10&encoding=json"
        ws = WebSocket(url, connect=self._connect)
        stop_beat = threading.Event()
        try:
            hello = json.loads(ws.recv_text())
            if hello.get("op") != OP_HELLO:
                raise Closed(None, "no hello")
            interval = hello["d"]["heartbeat_interval"] / 1000.0
            self.last_ack = time.monotonic()
            beat = threading.Thread(target=self._heartbeat, args=(ws, interval, stop_beat),
                                    name="gateway-beat", daemon=True)
            beat.start()
            if self.session_id:
                ws.send_text(json.dumps({"op": OP_RESUME, "d": {
                    "token": token, "session_id": self.session_id, "seq": self.seq}}))
            else:
                ws.send_text(json.dumps({"op": OP_IDENTIFY, "d": {
                    "token": token, "intents": INTENTS,
                    "properties": {"os": "linux", "browser": "harness", "device": "harness"}}}))
            while not self._stop.is_set():
                msg = json.loads(ws.recv_text())
                op = msg.get("op")
                if msg.get("s") is not None:
                    self.seq = msg["s"]
                if op == OP_ACK:
                    self.last_ack = time.monotonic()
                elif op == OP_HEARTBEAT:
                    ws.send_text(json.dumps({"op": OP_HEARTBEAT, "d": self.seq}))
                elif op == OP_RECONNECT:
                    raise Closed(None, "reconnect asked")
                elif op == OP_INVALID:
                    if not msg.get("d"):
                        self.session_id = self.seq = None
                    self._sleep(random.uniform(1, 5))
                    raise Closed(None, "invalid session")
                elif op == OP_DISPATCH:
                    self._dispatch(msg.get("t"), msg.get("d") or {})
        finally:
            stop_beat.set()
            ws.close(4000 if self.session_id else 1000)

    def _heartbeat(self, ws: WebSocket, interval: float, stop: threading.Event) -> None:
        if stop.wait(interval * random.random()):
            return
        while not stop.is_set():
            if time.monotonic() - self.last_ack > interval * 2 + 5:
                log.warning("gateway: heartbeat not acknowledged; reconnecting")
                try:
                    ws.sock.close()            # unblocks the reader, which reconnects
                except OSError:
                    pass
                return
            try:
                ws.send_text(json.dumps({"op": OP_HEARTBEAT, "d": self.seq}))
            except OSError:
                return
            if stop.wait(interval):
                return

    def _dispatch(self, kind: str | None, data: dict) -> None:
        if kind == "READY":
            self.session_id = data.get("session_id")
            self.resume_url = data.get("resume_gateway_url")
            self._set("ready")
        elif kind == "RESUMED":
            self._set("ready")
        elif kind == "MESSAGE_REACTION_ADD":
            try:
                self._on_reaction(data)
            except Exception as e:
                log.error("gateway: reaction handler failed: %s", type(e).__name__)
        elif kind == "INTERACTION_CREATE":
            try:
                self._on_interaction(data)
            except Exception as e:            # one bad press never drops the link
                log.error("gateway: press handler failed: %s", type(e).__name__)
