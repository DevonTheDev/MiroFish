"""Passive gateway telemetry using the same real synthetic loopback fixtures."""

import asyncio
import concurrent.futures
from datetime import datetime
import socket
import threading
import time

import httpx
import pytest

from test_local_gateway import chat, gateway_for, gateway_module, upstream_server


METRICS = {
    "admitted_connections", "rejected_connections", "queued_requests", "active_requests",
    "started_requests", "succeeded_requests", "failed_requests", "timed_out_requests",
    "cancelled_requests",
}


def observe_until(gateway, predicate):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        snapshot = gateway.snapshot()
        if predicate(snapshot["metrics"]):
            return snapshot["metrics"]
        time.sleep(0.005)
    pytest.fail(f"Gateway counters did not settle: {gateway.snapshot()['metrics']}")


def assert_partition(metrics):
    assert set(metrics) == METRICS
    assert all(type(value) is int and value >= 0 for value in metrics.values())
    assert metrics["started_requests"] == sum(metrics[name] for name in (
        "queued_requests", "active_requests", "succeeded_requests", "failed_requests",
        "timed_out_requests", "cancelled_requests",
    ))


def test_forward_gauges_and_socket_admission_are_distinct():
    with upstream_server() as upstream, gateway_for(upstream, max_concurrency=1, max_queue=2) as (gateway, client):
        upstream.release.clear()
        with socket.create_connection((client.base_url.host, client.base_url.port)) as headers_only:
            headers_only.sendall(b"GET /health HTTP/1.1\r\n")
            metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 1)
            assert metrics["started_requests"] == metrics["queued_requests"] == metrics["active_requests"] == 0
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                first = pool.submit(chat, client)
                assert upstream.started.wait(2)
                second = pool.submit(client.post, "embeddings", json={"model": "local-embed", "input": "hello"})
                metrics = observe_until(gateway, lambda m: m["queued_requests"] == 1)
                assert metrics["admitted_connections"] == 3
                assert metrics["active_requests"] == 1
                assert metrics["started_requests"] == 2
                assert_partition(metrics)
                assert client.get(str(client.base_url).removesuffix("/v1/") + "/health").status_code == 429
                assert gateway.snapshot()["metrics"]["rejected_connections"] == 1
                upstream.release.set()
                assert first.result().status_code == second.result().status_code == 200
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["succeeded_requests"] == 2
        assert metrics["queued_requests"] == metrics["active_requests"] == 0
        assert_partition(metrics)


def test_health_and_early_protocol_rejection_do_not_count_as_forwards():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        assert client.get(str(client.base_url).removesuffix("/v1/") + "/health").status_code == 200
        assert chat(client, model="forbidden:cloud").status_code == 400
        assert client.get("unknown").status_code == 404
        assert client.get("models").status_code == 200
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["started_requests"] == metrics["succeeded_requests"] == 1
        assert not metrics["failed_requests"]
        assert_partition(metrics)


@pytest.mark.parametrize("body,status", [(b"invalid JSON", 200), ({"error": "private"}, 500)])
def test_invalid_or_rejected_upstream_is_exactly_one_forward_failure(body, status):
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        upstream.body, upstream.status = body, status
        assert chat(client).status_code == 502
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["started_requests"] == metrics["failed_requests"] == 1
        assert_partition(metrics)


def test_coroutine_deadline_is_exactly_one_timeout():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=0.12) as (gateway, client):
        upstream.delay = 0.3
        assert chat(client).status_code == 504
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["started_requests"] == metrics["timed_out_requests"] == 1
        assert metrics["cancelled_requests"] == 0
        assert_partition(metrics)


def test_queued_deadline_never_acquires_upstream_slot():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        upstream.release.clear()
        first = asyncio.run_coroutine_threadsafe(gateway._forward("/v1/models", None, 5), gateway._loop)
        assert upstream.started.wait(2)
        second = asyncio.run_coroutine_threadsafe(gateway._forward("/v1/models", None, 0.05), gateway._loop)
        with pytest.raises(gateway_module()._GatewayError) as error:
            second.result(timeout=2)
        assert error.value.status == 504
        metrics = gateway.snapshot()["metrics"]
        assert metrics["timed_out_requests"] == metrics["active_requests"] == 1
        assert metrics["queued_requests"] == 0
        assert len(upstream.calls) == 1
        assert_partition(metrics)
        upstream.release.set()
        assert first.result(timeout=2)[0] == 200


def test_parallel_observations_preserve_counter_partition():
    with upstream_server() as upstream, gateway_for(upstream, max_concurrency=2, max_queue=12) as (gateway, client):
        upstream.delay = 0.025
        with concurrent.futures.ThreadPoolExecutor(12) as pool:
            pending = [pool.submit(chat, client) for _ in range(12)]
            while not all(future.done() for future in pending):
                metrics = gateway.snapshot()["metrics"]
                assert_partition(metrics)
                assert metrics["active_requests"] <= 2
                assert metrics["admitted_connections"] <= 14
                time.sleep(0.001)
            assert all(future.result().status_code == 200 for future in pending)
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["started_requests"] == metrics["succeeded_requests"] == 12


def test_dead_listener_is_reported_failed_without_probing():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        gateway._server.shutdown()
        gateway._server_thread.join(2)
        assert gateway.snapshot()["state"] == "failed"
        assert gateway.snapshot()["uptime_seconds"] is None
        assert not upstream.calls


def test_closed_uptime_does_not_grow_after_shutdown():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        gateway.close()
        first = gateway.snapshot()["uptime_seconds"]
        time.sleep(0.01)
        assert gateway.snapshot()["uptime_seconds"] == first


def test_external_cancellation_counts_active_and_queued_work_once():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        upstream.release.clear()
        pending = [asyncio.run_coroutine_threadsafe(gateway._forward("/v1/models", None, 5), gateway._loop) for _ in range(2)]
        assert upstream.started.wait(2)
        observe_until(gateway, lambda m: m["queued_requests"] == 1)
        for future in pending:
            future.cancel()
        metrics = observe_until(gateway, lambda m: m["cancelled_requests"] == 2)
        assert metrics["admitted_connections"] == metrics["queued_requests"] == metrics["active_requests"] == 0
        assert_partition(metrics)
        upstream.release.set()


def test_shutdown_cancels_forwarded_work_and_publishes_closed():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        upstream.release.clear()
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending = pool.submit(chat, client)
            assert upstream.started.wait(2)
            gateway.close()
            with pytest.raises(httpx.TransportError):
                pending.result(timeout=2)
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["cancelled_requests"] == metrics["started_requests"] == 1
        assert_partition(metrics)
        assert gateway.snapshot()["state"] == "closed"
        upstream.release.set()


def test_snapshot_has_instance_lifetime_and_is_independent_of_lifecycle_lock():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        first = gateway.snapshot()
        assert first["state"] == "running"
        assert datetime.fromisoformat(first["started_at"]).utcoffset().total_seconds() == 0
        assert first["instance_id"]
        assert first["uptime_seconds"] >= 0
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            with gateway._lock:
                snapshot = pool.submit(gateway.snapshot).result(timeout=0.5)
        assert snapshot["instance_id"] == first["instance_id"]
        assert snapshot["uptime_seconds"] >= first["uptime_seconds"]
        assert snapshot["limits"] == {
            "max_concurrency": 1, "max_queue": 32, "request_timeout": 180.0,
            "max_output_tokens": 2048, "max_input_chars": 24000,
        }
        snapshot["metrics"]["active_requests"] = 999
        assert gateway.snapshot()["metrics"]["active_requests"] == 0
    with upstream_server() as upstream, gateway_for(upstream) as (replacement, _client):
        assert replacement.snapshot()["instance_id"] != first["instance_id"]
        assert not replacement.snapshot()["metrics"]["started_requests"]


def test_starting_closing_and_failed_are_published_without_lifecycle_wait(monkeypatch):
    module = gateway_module()
    gateway = module.LocalInferenceGateway(module.GatewaySettings("http://127.0.0.1:9", "http://127.0.0.1:9"))
    entered, release = threading.Event(), threading.Event()

    async def failed_initialize():
        entered.set()
        while not release.is_set():
            await asyncio.sleep(0.005)
        raise RuntimeError("synthetic initialization failure")

    monkeypatch.setattr(gateway, "_initialize", failed_initialize)
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        pending = pool.submit(gateway.start)
        try:
            assert entered.wait(2)
            assert gateway.snapshot()["state"] == "starting"
        finally:
            release.set()
        with pytest.raises(RuntimeError, match="synthetic initialization failure"):
            pending.result(timeout=2)
    assert gateway.snapshot()["state"] == "failed"

    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        shutdown = gateway._server.shutdown
        entered.clear()
        release.clear()

        def delayed_shutdown():
            entered.set()
            assert release.wait(2)
            shutdown()

        monkeypatch.setattr(gateway._server, "shutdown", delayed_shutdown)
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending = pool.submit(gateway.close)
            try:
                assert entered.wait(2)
                assert gateway.snapshot()["state"] == "closing"
            finally:
                release.set()
            pending.result(timeout=2)
        assert gateway.snapshot()["state"] == "closed"


def test_event_loop_creation_failure_publishes_failed(monkeypatch):
    module = gateway_module()
    gateway = module.LocalInferenceGateway(module.GatewaySettings("http://127.0.0.1:9", "http://127.0.0.1:9"))

    def failed_loop():
        raise RuntimeError("synthetic event loop failure")

    monkeypatch.setattr(module.asyncio, "new_event_loop", failed_loop)
    with pytest.raises(RuntimeError, match="synthetic event loop failure"):
        gateway.start()
    assert gateway.snapshot()["state"] == "failed"
    assert gateway.snapshot()["started_at"] is None
    assert gateway.snapshot()["uptime_seconds"] is None


def test_snapshot_during_normal_close_never_invents_thread_failure(monkeypatch):
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, _client):
        checking, release, closing = threading.Event(), threading.Event(), threading.Event()
        is_alive, set_state = gateway._loop_thread.is_alive, gateway._set_state

        def delayed_liveness():
            checking.set()
            assert release.wait(2)
            return is_alive()

        def observed_state(state):
            if state == "closing":
                closing.set()
            set_state(state)

        monkeypatch.setattr(gateway._loop_thread, "is_alive", delayed_liveness)
        monkeypatch.setattr(gateway, "_set_state", observed_state)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            observation = pool.submit(gateway.snapshot)
            try:
                assert checking.wait(2)
                shutdown = pool.submit(gateway.close)
                assert closing.wait(2)
                # Give shutdown time to expose an incorrectly unlocked check.
                # A correctly synchronized snapshot briefly holds this close.
                try:
                    shutdown.result(timeout=0.2)
                except concurrent.futures.TimeoutError:
                    pass
            finally:
                release.set()
            assert observation.result(timeout=2)["state"] in {"running", "closing", "closed"}
            shutdown.result(timeout=2)
