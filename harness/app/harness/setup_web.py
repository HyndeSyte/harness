"""The add-on's own settings page, served only through Home Assistant Ingress.

Who can reach it: Supervisor proxies Ingress from 172.30.32.2 and adds
X-Remote-User-Id / -Name / -Display-Name for the logged-in Home Assistant
user, stripping any copies a client sent (supervisor api/ingress.py,
2026.09.3). Anything from another address, or without a user id, gets
403. Ingress does not tell us the user's role, and panel_admin only hides
the sidebar entry, so this page enforces its own rule: the first Home
Assistant user to save settings becomes the only one who can change them.

What it never does: show a key back (only whether each is set, and when),
put a key in a URL, log a request body, or change anything after pairing
without his tap in Telegram -- after pairing, a change becomes a pending
request the controller announces to him as a card.
"""
from __future__ import annotations

import hmac
import html
import logging
import queue
import re
import secrets
import threading
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from .net import REDACT
from .vault import FIELDS, LABELS, Vault, VaultError

log = logging.getLogger("harness.web")

INGRESS_PROXY = "172.30.32.2"
MAX_BODY = 16 * 1024


def _e(s) -> str:
    return html.escape(str(s), quote=True)


class SetupApp:
    """Everything the handler needs, shared across request threads."""

    def __init__(self, vault: Vault, status_box: dict, requests: queue.Queue, *,
                 allowed_peers: tuple[str, ...] = (INGRESS_PROXY,)):
        self.vault = vault
        self.status = status_box
        self.requests = requests
        self.allowed_peers = allowed_peers
        self.csrf = secrets.token_urlsafe(24)
        self.lock = threading.Lock()
        self.pair_code: str | None = None   # shown on the page; only its hash is stored


PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness</title><style>
body{{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;
color:#1b1b1b;background:#fff}}
h1{{font-size:20px}} h2{{font-size:16px;margin-top:28px}}
.ok{{color:#1a7f37}} .no{{color:#b42318}} .muted{{color:#666}}
input[type=password],input[type=text]{{width:100%;padding:8px;box-sizing:border-box;
margin:4px 0 12px}}
button{{padding:8px 14px}} code{{background:#f2f2f2;padding:2px 4px}}
.card{{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}}
@media (prefers-color-scheme: dark){{body{{background:#111;color:#eee}}
.card{{border-color:#333}} code{{background:#222}} .muted{{color:#aaa}}}}
</style></head><body><h1>Harness</h1>{body}</body></html>"""


def render_page(app: SetupApp, user_id: str, user_name: str, flash: str = "") -> str:
    v = app.vault
    st = app.status
    setup = v.setup_user()
    may_edit = setup is None or setup.get("id") == user_id
    owner = v.owner()
    keys = v.key_status()
    parts = []
    if flash:
        parts.append(f'<p class="card">{_e(flash)}</p>')
    parts.append('<div class="card">')
    parts.append(f"<div>Stage <b>{_e(st.get('stage', '?'))}</b> · "
                 f"{'stopped' if st.get('paused') else 'running'}</div>")
    if owner:
        parts.append(f'<div class="ok">Paired with your Telegram account since '
                     f'{_e(owner["paired_at"][:10])}.</div>')
    else:
        parts.append('<div class="no">Not paired yet.</div>')
    if st.get("last_poll"):
        parts.append(f'<div class="muted">Last contact with Telegram: {_e(st["last_poll"][:19])}'
                     ' UTC</div>')
    for note in st.get("notes") or []:
        parts.append(f'<div class="no">⚠ {_e(note)}</div>')
    parts.append("</div>")

    cals = st.get("calendar") or []
    if cals:
        parts.append("<h2>Calendars</h2><div class='card'>")
        for c in cals:
            when = (f'<span class="ok">read {_e(c["ok_at"][:16].replace("T", " "))} UTC</span>'
                    if c.get("ok_at") else '<span class="no">not read yet</span>')
            err = (f' <span class="muted">(last problem: {_e(c["error"])})</span>'
                   if c.get("error") else "")
            parts.append(f"<div>{_e(c['label'])}: {when}{err}</div>")
        parts.append("</div>")
    last = st.get("last_digest") or {}
    if last.get("text"):
        how = "sent to Telegram" if last.get("sent") else "not sent: recorded only, before launch"
        parts.append(f"<h2>Last digest</h2><div class='card'><div class='muted'>"
                     f"{_e((last.get('at') or '')[:16].replace('T', ' '))} UTC · {how}</div>"
                     f"<pre style='white-space:pre-wrap;font:inherit'>"
                     f"{_e(html.unescape(re.sub(r'</?[bi]>', '', last['text'])))}</pre>"
                     "</div>")

    parts.append("<h2>Keys</h2><div class='card'>")
    for f in FIELDS:
        when = keys.get(f)
        mark = (f'<span class="ok">set {_e(when[:10])}</span>' if when
                else '<span class="no">not set</span>')
        parts.append(f"<div>{_e(LABELS[f])}: {mark}</div>")
    parts.append("</div>")

    if not may_edit:
        parts.append(f'<p class="muted">Only {_e(setup.get("name", "the person who set this up"))}'
                     " can change settings here.</p>")
        return PAGE.format(body="".join(parts))

    pending = v.pending()
    if pending:
        parts.append(f'<p class="card">Waiting for your tap in Telegram: replace the '
                     f'{_e(LABELS[pending["field"]])}.</p>')
    note = ("After pairing, a change here is sent to Telegram and only your tap applies it."
            if owner else "Paste each key once. They are stored only on this Pi.")
    parts.append(f"<h2>{'Replace a key' if owner else 'Enter keys'}</h2>"
                 f'<p class="muted">{note}</p>'
                 f'<form method="post" action="save" autocomplete="off">'
                 f'<input type="hidden" name="csrf" value="{_e(app.csrf)}">')
    for f in FIELDS:
        parts.append(f'<label>{_e(LABELS[f])}<input type="password" name="{f}" '
                     f'autocomplete="off" spellcheck="false"></label>')
    parts.append("<button>Save</button></form>")

    if keys.get("telegram_bot_token") and not owner:
        bot = st.get("bot")
        with app.lock:
            code = app.pair_code if v.pairing_active() else None
        parts.append("<h2>Pair with your Telegram</h2>")
        if code and bot:
            link = f"https://t.me/{_e(bot)}?start={_e(code)}"
            parts.append(f'<div class="card">On your phone, open <a href="{link}" '
                         f'target="_blank" rel="noopener">{link}</a> and tap Start. '
                         f'Or send <code>/start {_e(code)}</code> to @{_e(bot)}. '
                         f'<span class="muted">Good for 15 minutes.</span></div>')
        elif code:
            parts.append(f'<div class="card">Send <code>/start {_e(code)}</code> to your bot. '
                         f'<span class="muted">Good for 15 minutes.</span></div>')
        parts.append(f'<form method="post" action="pair"><input type="hidden" name="csrf" '
                     f'value="{_e(app.csrf)}"><button>New pairing code</button></form>')

    if owner or any(keys.values()):
        parts.append('<h2>Start over</h2><form method="post" action="reset">'
                     f'<input type="hidden" name="csrf" value="{_e(app.csrf)}">'
                     '<p class="muted">Forgets the keys and the pairing. Your record (the '
                     'ledger) stays. Type RESET to confirm.</p>'
                     '<input type="text" name="confirm" autocomplete="off">'
                     '<button>Reset</button></form>')
    return PAGE.format(body="".join(parts))


def make_handler(app: SetupApp):
    class Handler(BaseHTTPRequestHandler):
        server_version = "harness"
        sys_version = ""

        def log_message(self, fmt, *args):     # paths only, redacted, no bodies
            log.debug("web %s", REDACT(self.path.split("?", 1)[0]))

        def _who(self) -> tuple[str, str] | None:
            if self.client_address[0] not in app.allowed_peers:
                return None
            uid = self.headers.get("X-Remote-User-Id", "").strip()
            if not uid:
                return None
            name = (self.headers.get("X-Remote-User-Display-Name")
                    or self.headers.get("X-Remote-User-Name") or "a Home Assistant user")
            return uid, name.strip()[:80]

        def _send(self, status: int, body: str = "", location: str | None = None):
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'none'; style-src 'unsafe-inline'; "
                             "form-action 'self'; frame-ancestors 'self'; base-uri 'none'")
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)

        def do_GET(self):
            who = self._who()
            if who is None:
                return self._send(HTTPStatus.FORBIDDEN, "Forbidden")
            path = self.path.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
            if path not in ("", "index.html"):
                return self._send(HTTPStatus.NOT_FOUND, "Not found")
            self._ensure_code()
            flash = ""
            if "?" in self.path:
                flash = parse_qs(self.path.split("?", 1)[1]).get("m", [""])[0][:200]
            return self._send(HTTPStatus.OK, render_page(app, who[0], who[1], flash))

        def _ensure_code(self):
            v = app.vault
            if v.owner() or not v.get("telegram_bot_token"):
                return
            with app.lock:
                if app.pair_code is None or not v.pairing_active():
                    try:
                        app.pair_code = v.new_pairing_code()
                    except VaultError:
                        app.pair_code = None

        def do_POST(self):
            who = self._who()
            if who is None:
                return self._send(HTTPStatus.FORBIDDEN, "Forbidden")
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = 0
            if n <= 0 or n > MAX_BODY:
                return self._send(HTTPStatus.BAD_REQUEST, "Bad request")
            form = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode("utf-8", "replace"),
                                                keep_blank_values=True).items()}
            if not hmac.compare_digest(form.get("csrf", ""), app.csrf):
                return self._send(HTTPStatus.FORBIDDEN, "Stale page; reload and try again.")
            uid, name = who
            if not app.vault.claim_setup_user(uid, name):
                return self._send(HTTPStatus.FORBIDDEN, "Only the person who set this up can "
                                                        "change it.")
            action = self.path.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
            msg = getattr(self, f"_post_{action}", self._post_unknown)(form, name)
            from urllib.parse import quote
            return self._send(HTTPStatus.SEE_OTHER, "", location=f"./?m={quote(msg)}")

        def _post_unknown(self, form, name):
            return "Unknown action."

        def _post_save(self, form, name):
            v = app.vault
            paired = v.owner() is not None
            entered = [f for f in FIELDS if form.get(f, "").strip()]
            if not entered:
                return "Nothing entered."
            if paired and len(entered) > 1:
                return "After pairing, replace one key at a time. Nothing was changed."
            done, errors = [], []
            for f in entered:
                try:
                    if paired:
                        v.request_change(f, form[f], by=name)
                        done.append(f"{LABELS[f]}: sent to Telegram for your approval")
                    else:
                        v.set_key(f, form[f], by=name)
                        done.append(f"{LABELS[f]} saved")
                except VaultError as e:
                    errors.append(str(e))
            return "; ".join(done + errors)

        def _post_pair(self, form, name):
            v = app.vault
            if v.owner():
                return "Already paired."
            if not v.get("telegram_bot_token"):
                return "Enter the bot token first."
            with app.lock:
                app.pair_code = v.new_pairing_code()
            return "New pairing code below."

        def _post_reset(self, form, name):
            if form.get("confirm", "").strip() != "RESET":
                return "Not reset: type RESET to confirm."
            app.requests.put({"type": "reset", "by": name})
            with app.lock:
                app.pair_code = None
            return "Reset requested. Reload in a few seconds."

    return Handler


def serve(app: SetupApp, host: str = "0.0.0.0", port: int = 8099) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    t = threading.Thread(target=httpd.serve_forever, name="setup-web", daemon=True)
    t.start()
    return httpd
