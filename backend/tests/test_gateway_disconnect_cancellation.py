"""Opt-in abandonment is scoped to one bounded gateway request, over real sockets."""

import asyncio
import concurrent.futures
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import struct
import threading
import time

import pytest

from test_gateway_metrics import assert_partition, observe_until
from test_local_gateway import chat, gateway_for, gateway_module, upstream_server


CANCEL_HEADER = "X-MiroFish-Cancel-On-Disconnect"
CHAT_BODY = json.dumps({
    "model": "local-model", "messages": [{"role": "user", "content": "synthetic"}],
}).encode()


def request(client, *, headers=None, body=True, path="/v1/chat/completions", method="POST", payload=CHAT_BODY):
    connection = socket.create_connection((client.base_url.host, client.base_url.port), timeout=3)
    flags = [(CANCEL_HEADER, "1")] if headers is None else headers
    encoded = "".join(f"{name}: {value}\r\n" for name, value in flags).encode()
    connection.sendall((f"{method} {path} HTTP/1.1\r\n"
                        f"Host: {client.base_url.host}:{client.base_url.port}\r\n"
                        f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n").encode()
                       + encoded + b"\r\n" + (payload if body else b""))
    return connection


def read_response(connection):
    chunks = []
    while chunk := connection.recv(65536):
        chunks.append(chunk)
    return b"".join(chunks)


@contextmanager
def closing_upstream():
    """Observe actual gateway HTTP closure while a synthetic server awaits work."""
    started, closed = threading.Event(), threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            started.set()
            self.connection.settimeout(3)
            try:
                if self.connection.recv(1) == b"":
                    closed.set()
            except ConnectionResetError:
                closed.set()
            except OSError:
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    server.url = f"http://127.0.0.1:{server.server_port}/v1"
    server.started, server.closed = started, closed
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def test_health_advertises_opt_in_without_starting_forward_work():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        health = client.get(str(client.base_url).removesuffix("/v1/") + "/health").json()
        assert health.get("request_disconnect_cancel") == CANCEL_HEADER
        assert gateway_module().DISCONNECT_CANCEL_HEADER == CANCEL_HEADER
        assert not upstream.calls
        assert gateway.snapshot()["metrics"]["started_requests"] == 0


@pytest.mark.parametrize("flags", [
    [(CANCEL_HEADER, "")], [(CANCEL_HEADER, "0")], [(CANCEL_HEADER, "true")],
    [(CANCEL_HEADER, "01")], [(CANCEL_HEADER, "1 ")], [(CANCEL_HEADER, "1,1")],
    [(CANCEL_HEADER, "1"), (CANCEL_HEADER.lower(), "1")],
])
def test_invalid_opt_in_is_rejected_before_reading_body_or_starting_work(flags):
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        with request(client, headers=flags, body=False) as connection:
            connection.settimeout(0.6)
            response = read_response(connection)
        assert response.startswith(b"HTTP/1.0 400 ")
        assert not upstream.calls
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["started_requests"] == 0
        assert_partition(metrics)


@pytest.mark.parametrize("path,method", [("/v1/embeddings", "POST"), ("/v1/models", "GET")])
def test_opt_in_is_rejected_for_routes_without_cancellation_support(path, method):
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        payload = json.dumps({"model": "local-embed", "input": "synthetic"}).encode()
        with request(client, path=path, method=method, payload=payload) as connection:
            assert read_response(connection).startswith(b"HTTP/1.0 400 ")
        assert not upstream.calls
        assert gateway.snapshot()["metrics"]["started_requests"] == 0


def test_opt_in_is_not_forwarded_and_success_does_not_cancel():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        with request(client) as connection:
            assert read_response(connection).startswith(b"HTTP/1.0 200 ")
        assert CANCEL_HEADER.lower() not in {name.lower() for name in upstream.calls[0][2]}
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["succeeded_requests"] == 1
        assert metrics["cancelled_requests"] == 0
        assert_partition(metrics)


def test_cancelled_queued_request_never_reaches_upstream_or_affects_running_request():
    with upstream_server() as upstream, gateway_for(upstream, max_concurrency=1, max_queue=1) as (gateway, client):
        upstream.release.clear()
        try:
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                active = pool.submit(chat, client)
                assert upstream.started.wait(2)
                queued = request(client)
                observe_until(gateway, lambda m: m["queued_requests"] == 1)
                queued.close()
                try:
                    metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 1)
                    assert metrics["cancelled_requests"] == 1
                    assert metrics["queued_requests"] == 0
                    assert metrics["active_requests"] == 1
                    assert len(upstream.calls) == 1
                    assert not active.done()
                    assert_partition(metrics)
                finally:
                    upstream.release.set()
                assert active.result(timeout=2).status_code == 200
            assert chat(client).status_code == 200
            metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
            assert metrics["succeeded_requests"] == 2
            assert metrics["cancelled_requests"] == 1
            assert len(upstream.calls) == 2
            assert_partition(metrics)
        finally:
            upstream.release.set()


@pytest.mark.parametrize("disconnect", ["half_close", "reset"])
def test_already_abandoned_request_is_not_submitted_after_payload_validation(monkeypatch, disconnect):
    module = gateway_module()
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        validated, release, submitted = threading.Event(), threading.Event(), threading.Event()
        prepare, initialize = module._prepare_payload, module._ForwardSubmission.__init__

        def held_validation(*args, **kwargs):
            payload = prepare(*args, **kwargs)
            validated.set()
            assert release.wait(2)
            return payload

        def observed_submission(self, *args, **kwargs):
            submitted.set()
            initialize(self, *args, **kwargs)

        monkeypatch.setattr(module, "_prepare_payload", held_validation)
        monkeypatch.setattr(module._ForwardSubmission, "__init__", observed_submission)
        connection = request(client)
        try:
            assert validated.wait(2)
            if disconnect == "half_close":
                connection.shutdown(socket.SHUT_WR)
            else:
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                connection.close()
        finally:
            release.set()
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        connection.close()
        assert not submitted.is_set(), "Abandonment must be checked before constructing a forward submission"
        assert not upstream.calls
        assert metrics["started_requests"] == 0
        assert_partition(metrics)


@pytest.mark.parametrize("disconnect", ["close", "half_close", "reset"])
def test_opted_in_disconnect_closes_active_http_request(disconnect):
    with closing_upstream() as upstream, gateway_for(upstream, request_timeout=5) as (gateway, client):
        connection = request(client)
        try:
            assert upstream.started.wait(2)
            if disconnect == "half_close":
                connection.shutdown(socket.SHUT_WR)
            elif disconnect == "reset":
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                connection.close()
            else:
                connection.close()
            assert upstream.closed.wait(1), "Abandoned active HTTP request remained open"
            metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
            assert metrics["cancelled_requests"] == metrics["started_requests"] == 1
            assert metrics["active_requests"] == metrics["queued_requests"] == 0
            assert_partition(metrics)
        finally:
            connection.close()


def test_legacy_half_close_still_receives_the_completed_response():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        upstream.release.clear()
        with request(client, headers=[]) as connection:
            connection.shutdown(socket.SHUT_WR)
            assert upstream.started.wait(2)
            upstream.release.set()
            assert read_response(connection).startswith(b"HTTP/1.0 200 ")
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["succeeded_requests"] == 1
        assert not metrics["cancelled_requests"]
        assert_partition(metrics)


@pytest.mark.parametrize("wait_for_deadline", [False, True])
def test_admission_waits_for_actual_cleanup_or_original_deadline(monkeypatch, wait_for_deadline):
    with closing_upstream() as upstream, gateway_for(
        upstream, request_timeout=0.6 if wait_for_deadline else 5, max_concurrency=1, max_queue=0,
    ) as (gateway, client):
        forward = gateway._forward
        cleaning, done = threading.Event(), threading.Event()
        release = asyncio.Event()

        async def held_cleanup(*args, **kwargs):
            try:
                return await forward(*args, **kwargs)
            finally:
                cleaning.set()
                await release.wait()
                done.set()

        monkeypatch.setattr(gateway, "_forward", held_cleanup)
        try:
            connection = request(client)
            assert upstream.started.wait(2)
            connection.close()
            assert cleaning.wait(1), "Disconnect never reached coroutine cancellation"
            assert gateway.snapshot()["metrics"]["cancelled_requests"] == 1
            assert not done.is_set()
            if wait_for_deadline:
                observe_until(gateway, lambda m: m["admitted_connections"] == 0)
                assert not done.is_set(), "The synthetic cleanup gate was bypassed"
            else:
                assert gateway.snapshot()["metrics"]["admitted_connections"] == 1
                response = client.get(str(client.base_url).removesuffix("/v1/") + "/health")
                assert response.status_code == 429, "Admission released before underlying task completion"
        finally:
            gateway._loop.call_soon_threadsafe(release.set)
        assert done.wait(2)
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert_partition(metrics)


def test_pre_start_cancellation_settles_only_when_underlying_task_is_done():
    module = gateway_module()
    submission_type = getattr(module, "_ForwardSubmission", None)
    assert submission_type is not None, "Forward submission must track actual task completion"
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        blocked, release, entered = threading.Event(), threading.Event(), threading.Event()

        def hold_loop():
            blocked.set()
            assert release.wait(2)

        async def work():
            entered.set()
            return 200, b"{}"

        gateway._loop.call_soon_threadsafe(hold_loop)
        assert blocked.wait(2)
        try:
            submission = submission_type(gateway._loop, work())
            submission.cancel()
            assert not submission.completion.done()
        finally:
            release.set()
        with pytest.raises(concurrent.futures.CancelledError):
            submission.completion.result(timeout=2)
        assert not entered.is_set()
        assert not upstream.calls


def test_pre_start_disconnect_retains_socket_admission_until_actual_task_callback(monkeypatch):
    module = gateway_module()
    with upstream_server() as upstream, gateway_for(upstream, max_concurrency=1, max_queue=0) as (gateway, client):
        blocked, release, cancellation, submitted = (threading.Event() for _ in range(4))
        cancel, initialize = module._ForwardSubmission.cancel, module._ForwardSubmission.__init__

        def hold_loop():
            blocked.set()
            assert release.wait(2)

        def observed_cancel(submission):
            cancel(submission)
            cancellation.set()

        def observed_submission(self, *args, **kwargs):
            initialize(self, *args, **kwargs)
            submitted.set()

        monkeypatch.setattr(module._ForwardSubmission, "cancel", observed_cancel)
        monkeypatch.setattr(module._ForwardSubmission, "__init__", observed_submission)
        gateway._loop.call_soon_threadsafe(hold_loop)
        assert blocked.wait(2)
        try:
            connection = request(client)
            assert submitted.wait(1)
            connection.close()
            assert cancellation.wait(1)
            metrics = gateway.snapshot()["metrics"]
            assert metrics["admitted_connections"] == 1
            assert metrics["started_requests"] == 0
            assert client.get(str(client.base_url).removesuffix("/v1/") + "/health").status_code == 429
        finally:
            release.set()
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["started_requests"] == 0
        assert_partition(metrics)
        assert not upstream.calls


def test_capped_deadline_expires_while_loop_is_blocked_without_late_dispatch():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=5) as (gateway, client):
        blocked, release = threading.Event(), threading.Event()

        def hold_loop():
            blocked.set()
            assert release.wait(2)

        gateway._loop.call_soon_threadsafe(hold_loop)
        assert blocked.wait(2)
        try:
            started = time.monotonic()
            with request(client, headers=[(CANCEL_HEADER, "1"), ("X-MiroFish-Timeout-Ms", "120")]) as connection:
                response = read_response(connection)
            assert response.startswith(b"HTTP/1.0 504 ")
            assert time.monotonic() - started < 0.6
            observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        finally:
            release.set()
        # A loop barrier follows the already submitted creation/cancellation,
        # then a second barrier follows its task completion callback.
        for _ in range(2):
            asyncio.run_coroutine_threadsafe(asyncio.sleep(0), gateway._loop).result(timeout=2)
        assert not upstream.calls
        metrics = gateway.snapshot()["metrics"]
        assert metrics["started_requests"] == 0
        assert_partition(metrics)


def test_trailing_bytes_do_not_extend_the_original_deadline_or_cancel_a_connected_peer():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=0.25) as (gateway, client):
        upstream.release.clear()
        try:
            with request(client) as connection:
                assert upstream.started.wait(2)
                connection.sendall(b"unexpected trailing bytes")
                assert read_response(connection).startswith(b"HTTP/1.0 504 ")
            metrics = observe_until(gateway, lambda m: m["admitted_connections"] == m["active_requests"] == 0)
            assert metrics["started_requests"] == 1
            assert metrics["timed_out_requests"] + metrics["cancelled_requests"] == 1
            assert_partition(metrics)
        finally:
            upstream.release.set()


def test_disconnect_and_shutdown_settle_metrics_without_releasing_twice():
    with closing_upstream() as upstream, gateway_for(upstream) as (gateway, client):
        connection = request(client)
        assert upstream.started.wait(2)
        connection.close()
        gateway.close()
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["cancelled_requests"] == 1
        assert metrics["active_requests"] == metrics["queued_requests"] == 0
        assert_partition(metrics)
        assert gateway.snapshot()["state"] == "closed"


def test_shutdown_refuses_late_submission_before_constructing_a_coroutine(monkeypatch):
    module = gateway_module()
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        submit = getattr(gateway, "_submit_forward", None)
        assert submit is not None, "Opt-in submissions need a boundary shared with shutdown"
        closing, release, constructed = threading.Event(), threading.Event(), threading.Event()
        shutdown, forward = gateway._server.shutdown, gateway._forward

        def held_shutdown():
            closing.set()
            assert release.wait(2)
            shutdown()

        def observed_forward(*args, **kwargs):
            constructed.set()
            return forward(*args, **kwargs)

        monkeypatch.setattr(gateway._server, "shutdown", held_shutdown)
        monkeypatch.setattr(gateway, "_forward", observed_forward)
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            closed = pool.submit(gateway.close)
            try:
                assert closing.wait(2)
                with pytest.raises(module._GatewayError) as error:
                    submit("/v1/chat/completions", json.loads(CHAT_BODY), 1, deadline=time.monotonic() + 1)
                assert error.value.status == 503
                assert not constructed.is_set()
            finally:
                release.set()
            closed.result(timeout=2)
        assert gateway._loop.is_closed()
        assert not upstream.calls


def test_accepted_submission_creation_runs_before_shutdown_takes_its_task_snapshot(monkeypatch):
    module = gateway_module()
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        submit = getattr(gateway, "_submit_forward", None)
        assert submit is not None, "Opt-in submissions need a boundary shared with shutdown"
        blocked, release, closing, created = (threading.Event() for _ in range(4))
        start, shutdown = module._ForwardSubmission._start, gateway._shutdown

        def hold_loop():
            blocked.set()
            assert release.wait(2)

        def observed_start(self, coroutine):
            start(self, coroutine)
            created.set()

        def queued_shutdown():
            closing.set()
            return observed_shutdown()

        async def observed_shutdown():
            assert created.is_set(), "Shutdown ran before an accepted forward was owned by a task"
            await shutdown()

        monkeypatch.setattr(module._ForwardSubmission, "_start", observed_start)
        monkeypatch.setattr(gateway, "_shutdown", queued_shutdown)
        gateway._loop.call_soon_threadsafe(hold_loop)
        assert blocked.wait(2)
        submission = submit("/v1/chat/completions", json.loads(CHAT_BODY), 5, deadline=time.monotonic() + 5)
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            closed = pool.submit(gateway.close)
            try:
                assert closing.wait(2)
            finally:
                release.set()
            closed.result(timeout=2)
        assert submission.completion.done()
        assert gateway._loop.is_closed()
        assert_partition(gateway.snapshot()["metrics"])
