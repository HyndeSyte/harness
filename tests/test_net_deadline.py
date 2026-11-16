"""0.24.0, fifth round: one total deadline for a calendar write's thread (net.deadline).

Real sockets on the loopback only: a connect that stalls is bounded by what's left of the deadline,
not the request's own timeout, and a server that answers a byte at a time can't keep the thread past
it. No outside host is ever reached.
"""
import socket
import threading
import time

import pytest

from harness import net
from harness.net import TransportError, UrllibTransport


def test_a_stalled_connect_gets_only_what_is_left_of_the_deadline(monkeypatch):
    asked = []

    def stalls(address, timeout=None, *rest, **kw):
        asked.append(timeout)
        time.sleep(min(timeout or 5, 5))
        raise socket.timeout("timed out")
    monkeypatch.setattr(socket, "create_connection", stalls)
    t = UrllibTransport(use_env_proxy=False)
    began = time.monotonic()
    with net.deadline(0.3):
        with pytest.raises(TransportError) as e:
            t.request("PUT", "http://calendar.invalid/x", body=b"x", timeout=20)
    assert time.monotonic() - began < 1.5
    assert asked and asked[0] <= 0.3 and e.value.kind == "timeout"


def test_a_server_answering_a_byte_at_a_time_is_cut_off_at_the_deadline():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    stop = threading.Event()

    def drip():
        conn, _ = srv.accept()
        conn.recv(65536)
        try:
            conn.sendall(b"HTTP/1.1 200 OK\r\n")
            while not stop.is_set():
                conn.sendall(b"X")                   # a header that never ends, a byte each 0.1 s
                time.sleep(0.1)
        except OSError:
            pass
        finally:
            conn.close()
    threading.Thread(target=drip, daemon=True).start()
    t = UrllibTransport(use_env_proxy=False)
    began = time.monotonic()
    try:
        with net.deadline(0.5):
            with pytest.raises(TransportError) as e:
                t.request("PUT", f"http://127.0.0.1:{port}/x", body=b"x", timeout=20)
    finally:
        stop.set()
        srv.close()
    assert e.value.kind == "timeout" and time.monotonic() - began < 2.5


def test_nothing_is_sent_once_the_deadline_has_passed(monkeypatch):
    monkeypatch.setattr(socket, "create_connection", lambda *a, **k: pytest.fail("sent after the deadline"))
    with net.deadline(0):
        with pytest.raises(TransportError):
            UrllibTransport(use_env_proxy=False).request("GET", "http://calendar.invalid/x")


def test_no_deadline_outside_a_write():
    assert net.remaining() is None
    with net.deadline(5):
        assert 0 < net.remaining() <= 5
        with net.deadline(10):
            assert net.remaining() <= 5                  # an inner deadline never extends the outer
    assert net.remaining() is None


def test_a_connect_that_times_out_is_a_timeout_even_with_no_deadline(monkeypatch):
    # Eleventh round: urllib wraps a connect timeout in URLError; it was said as a network failure unless the
    # deadline's timer happened to fire first (a race CI hit).
    def times_out(address, timeout=None, *rest, **kw):
        raise socket.timeout("timed out")
    monkeypatch.setattr(socket, "create_connection", times_out)
    with pytest.raises(TransportError) as e:
        UrllibTransport(use_env_proxy=False).request("PUT", "http://calendar.invalid/x", body=b"x", timeout=20)
    assert e.value.kind == "timeout"
