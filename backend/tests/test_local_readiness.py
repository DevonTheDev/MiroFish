"""Managed readiness uses synthetic loopback inference and an owned read-only driver."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import importlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import uuid

import pytest

from app.config import Config
from app import local_runtime, shutdown


STEPS = ("configuration", "dependencies", "database", "gateway", "json_output",
         "json_schema", "tool_call", "embedding", "cleanup")
TERMINAL = {"passed", "failed", "cancelled", "timed_out"}


@pytest.fixture
def readiness(monkeypatch):
    path = Path(__file__).parents[1] / "app/local_runtime/readiness.py"
    assert path.exists(), "Managed local readiness service is not implemented"
    service = importlib.import_module("app.local_runtime.readiness")
    monkeypatch.setattr(service, "_manager", None)
    monkeypatch.setattr(service, "_closing", False)
    monkeypatch.setattr(service, "_cleanup_failed", False)
    monkeypatch.setattr(service, "_owner_pid", os.getpid())
    monkeypatch.setattr(service, "_lock", threading.Lock())
    monkeypatch.setattr(service, "_installed_version", lambda package: "1.0")
    monkeypatch.setattr(shutdown, "_callbacks", {phase: [] for phase in shutdown._PHASES})
    monkeypatch.setattr(shutdown, "_registered", True)
    settings = {
        "MEMORY_BACKEND": "local", "LOCAL_MODE": True, "LLM_API_KEY": "local", "DEBUG": False,
        "LLM_MODEL_NAME": "synthetic-chat", "LOCAL_EMBEDDING_MODEL": "synthetic-embedding",
        "LLM_BASE_URL": "http://127.0.0.1:1/v1", "LOCAL_EMBEDDING_BASE_URL": "http://127.0.0.1:1/v1",
        "LOCAL_EMBEDDING_DIMENSIONS": 3, "LOCAL_GRAPH_URI": "bolt://127.0.0.1:1",
        "LOCAL_GRAPH_DATABASE": "private-database", "LOCAL_GRAPH_USER": "private-user",
        "LOCAL_GRAPH_PASSWORD": "private-password", "LOCAL_REQUEST_TIMEOUT": 2,
        "LOCAL_REASONING_EFFORT": "none", "LOCAL_MAX_CONCURRENCY": 1, "LOCAL_MAX_QUEUE": 4,
        "LOCAL_MAX_OUTPUT_TOKENS": 512, "LOCAL_MAX_INPUT_CHARS": 24000,
        "LOCAL_CONTEXT_TOKENS": 8192, "LOCAL_MAX_AGENTS": 10, "LOCAL_MAX_ROUNDS": 5,
        "LOCAL_MAX_AGENT_ITERATIONS": 3,
    }
    for name, value in settings.items():
        monkeypatch.setattr(Config, name, value)
    monkeypatch.delenv("MIROFISH_LOCAL_GATEWAY_URL", raising=False)
    monkeypatch.setattr(local_runtime, "_gateway", None)
    yield service
    service.close_readiness_manager()
    local_runtime.close_local_gateway()


def wait_for(service, predicate, timeout=4):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        snapshot = service.get_readiness_snapshot()
        if predicate(snapshot):
            return snapshot
        time.sleep(0.005)
    pytest.fail("Readiness did not reach the expected bounded state")


def finished(service, timeout=4):
    return wait_for(service, lambda value: value["run"] and value["run"]["state"] in TERMINAL, timeout)


def step(snapshot, identifier):
    return next(value for value in snapshot["run"]["steps"] if value["id"] == identifier)


@pytest.fixture
def database(monkeypatch):
    from neo4j import AsyncGraphDatabase
    state = SimpleNamespace(calls=[], sessions=[], closed=0, close_error=False, close_wait=None,
                            query_delay=0, result=1, query_error=False, driver_options=None)

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def run(self, query):
            state.calls.append(query)
            if state.query_delay:
                await asyncio.sleep(state.query_delay)
            if state.query_error:
                raise RuntimeError("private-password bolt://private-user@host private-database")
            return self

        async def single(self, **kwargs):
            return {"ready": state.result}

    class Driver:
        def session(self, **kwargs):
            state.sessions.append(kwargs)
            return Session()

        async def close(self):
            state.closed += 1
            if state.close_wait:
                while not state.close_wait.is_set():
                    await asyncio.sleep(0.005)
            if state.close_error:
                raise RuntimeError("private-password private-user private-database")

    def create(uri, **kwargs):
        state.driver_options = (uri, kwargs)
        return Driver()

    monkeypatch.setattr(AsyncGraphDatabase, "driver", create)
    return state


@contextmanager
def synthetic_models(monkeypatch):
    state = SimpleNamespace(calls=[], entered=threading.Event(), release=threading.Event(),
                            delay=0, status=200, invalid_schema=False, invalid_embedding=False)
    state.release.set()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state.calls.append((self.path, payload, dict(self.headers)))
            state.entered.set()
            state.release.wait(3)
            time.sleep(state.delay)
            if "embeddings" in self.path:
                body = {"data": [{"embedding": [0, 0, 0] if state.invalid_embedding else [1, 0, 0],
                                  "index": 0, "object": "embedding"}], "object": "list", "model": "synthetic"}
            else:
                message = {"role": "assistant", "content": '{"ready":true}'}
                if state.invalid_schema and payload.get("response_format", {}).get("type") == "json_schema":
                    message["content"] = '{"ready":1,"secret":"private-password"}'
                if payload.get("tools"):
                    message.update(content=None, tool_calls=[{"id": "synthetic-call", "type": "function",
                                   "function": {"name": "local_check", "arguments": "{}"}}])
                body = {"id": "synthetic", "object": "chat.completion", "created": 0,
                        "model": "synthetic", "choices": [{"index": 0, "message": message, "finish_reason": "stop"}]}
            if state.status != 200:
                body = {"error": {"message": "private-password private-user private-database", "type": "synthetic"}}
            raw = json.dumps(body).encode()
            try:
                self.send_response(state.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    worker.start()
    url = f"http://127.0.0.1:{server.server_port}/v1"
    monkeypatch.setattr(Config, "LLM_BASE_URL", url)
    monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", url)
    try:
        yield state
    finally:
        state.release.set()
        server.shutdown()
        server.server_close()
        worker.join(2)


def test_passive_get_and_registration_create_no_manager_or_clients(readiness, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Passive observation attempted work")
    monkeypatch.setattr(Config, "validate", forbidden)
    monkeypatch.setattr(local_runtime, "get_local_gateway_url", forbidden)
    monkeypatch.setattr(readiness.threading, "Thread", forbidden)
    for _ in range(3):
        snapshot = readiness.get_readiness_snapshot()
        assert snapshot["run"] is None
        assert snapshot["available"] is True
    readiness.register_readiness_shutdown()
    readiness.register_readiness_shutdown()
    assert readiness._manager is None
    assert shutdown._callbacks["readiness"] == [readiness.close_readiness_manager]


def test_cloud_guards_are_passive_and_refuse_actions(readiness, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    monkeypatch.setattr(Config, "validate", lambda: pytest.fail("Cloud validation"))
    assert readiness.get_readiness_snapshot()["unavailable_code"] == "local_mode_required"
    for action in (readiness.start_readiness_check, lambda: readiness.cancel_readiness_check(str(uuid.uuid4()))):
        with pytest.raises(readiness.ReadinessError) as error:
            action()
        assert (error.value.code, error.value.status_code) == ("local_mode_required", 403)
    assert readiness._manager is None


def test_success_uses_real_sdk_shared_gateway_and_read_only_owned_database(readiness, database, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        accepted = readiness.start_readiness_check()
        result = finished(readiness)
        assert result["run"]["id"] == accepted["run"]["id"]
        assert result["run"]["state"] == "passed"
        assert [value["id"] for value in result["run"]["steps"]] == list(STEPS)
        assert all(value["state"] == "passed" and value["code"] == "ok" for value in result["run"]["steps"])
        assert len(models.calls) == 4
        assert all("X-MiroFish-Timeout-Ms" not in headers for _, _, headers in models.calls)
        assert database.calls[0].text == "RETURN 1 AS ready"
        assert 0 < database.calls[0].timeout <= 10
        assert database.sessions == [{"database": "private-database", "default_access_mode": "READ"}]
        options = database.driver_options[1]
        assert options["max_connection_pool_size"] == 1
        assert options["max_transaction_retry_time"] == 0
        assert options["auth"] == ("private-user", "private-password")
        assert database.closed == 1
        assert local_runtime._gateway is not None
        encoded = json.dumps(result)
        assert len(encoded) < 65536
        assert all(secret not in encoded for secret in ("private-user", "private-password", "private-database", "Return a JSON"))
        result["run"]["steps"][0]["state"] = "malicious"
        assert readiness.get_readiness_snapshot()["run"]["steps"][0]["state"] == "passed"


def test_concurrent_starts_admit_exactly_one_and_stop_holds_admission(readiness, database, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        models.release.clear()
        barrier = threading.Barrier(8)
        def start():
            barrier.wait()
            try:
                return readiness.start_readiness_check()
            except readiness.ReadinessError as error:
                return error
        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda _: start(), range(8)))
        accepted = [value for value in results if isinstance(value, dict)]
        assert len(accepted) == 1
        assert all(value.code == "already_running" and value.snapshot["run"]["id"] == accepted[0]["run"]["id"]
                   for value in results if not isinstance(value, dict))
        assert models.entered.wait(2)
        stopped = readiness.cancel_readiness_check(accepted[0]["run"]["id"])
        assert stopped["run"]["state"] == "stopping"
        with pytest.raises(readiness.ReadinessError, match="already"):
            readiness.start_readiness_check()
        models.release.set()
        result = finished(readiness)
        assert result["run"]["state"] == "cancelled"
        assert len(models.calls) == 1
        assert step(result, "embedding")["code"] == "stopped"
        assert database.closed == 1
        assert readiness.cancel_readiness_check(result["run"]["id"])["run"]["state"] == "cancelled"
        with pytest.raises(readiness.ReadinessError) as error:
            readiness.cancel_readiness_check(str(uuid.uuid4()))
        assert error.value.code == "run_not_found"


def test_cleanup_blocks_new_admission_and_failure_disables_until_restart(readiness, database, monkeypatch):
    database.close_wait = threading.Event()
    database.close_error = True
    with synthetic_models(monkeypatch):
        readiness.start_readiness_check()
        wait_for(readiness, lambda value: value["run"]["current_step"] == "cleanup")
        with pytest.raises(readiness.ReadinessError) as error:
            readiness.start_readiness_check()
        assert error.value.code == "already_running"
        database.close_wait.set()
        result = finished(readiness)
        assert result["run"]["state"] == "failed"
        assert step(result, "cleanup")["code"] == "cleanup_failed"
        assert result["available"] is False
        assert result["unavailable_code"] == "cleanup_failed"
        with pytest.raises(readiness.ReadinessError) as error:
            readiness.start_readiness_check()
        assert error.value.code == "readiness_unavailable"


def test_invalid_configuration_and_dependencies_skip_resources_safely(readiness, database, monkeypatch):
    monkeypatch.setattr(Config, "validate", lambda: ["private-password private-user private-database"])
    readiness.start_readiness_check()
    result = finished(readiness)
    assert result["run"]["state"] == "failed"
    assert step(result, "configuration")["code"] == "invalid_configuration"
    assert step(result, "database")["code"] == "prerequisite_failed"
    assert database.calls == []
    assert local_runtime._gateway is None
    assert "private-" not in json.dumps(result)


def test_database_failure_does_not_skip_model_diagnostics(readiness, database, monkeypatch):
    database.query_error = True
    with synthetic_models(monkeypatch) as models:
        readiness.start_readiness_check()
        result = finished(readiness)
        assert result["run"]["state"] == "failed"
        assert step(result, "database")["code"] == "database_unavailable"
        assert len(models.calls) == 4
        assert database.closed == 1
        assert "private-" not in json.dumps(result)


@pytest.mark.parametrize("invalid", [True, "1", None])
def test_database_requires_an_actual_integer_one(readiness, database, monkeypatch, invalid):
    database.result = invalid
    with synthetic_models(monkeypatch):
        readiness.start_readiness_check()
        result = finished(readiness)
        assert step(result, "database")["code"] == "invalid_database_response"


def test_capability_validation_failure_continues_other_probes(readiness, database, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        models.invalid_schema = True
        models.invalid_embedding = True
        readiness.start_readiness_check()
        result = finished(readiness)
        assert result["run"]["state"] == "failed"
        assert step(result, "json_schema")["code"] == "capability_unsupported"
        assert step(result, "tool_call")["state"] == "passed"
        assert step(result, "embedding")["code"] == "embedding_invalid"
        assert len(models.calls) == 4
        assert "private-" not in json.dumps(result)


def test_shutdown_without_manager_rejects_later_starts(readiness):
    readiness.close_readiness_manager()
    assert readiness.get_readiness_snapshot()["unavailable_code"] == "backend_closing"
    with pytest.raises(readiness.ReadinessError) as error:
        readiness.start_readiness_check()
    assert error.value.code == "readiness_unavailable"
    assert readiness._manager is None


def test_inherited_process_never_touches_inherited_lock(readiness, monkeypatch):
    class ForbiddenLock:
        def __enter__(self):
            pytest.fail("Inherited lock acquired")
    monkeypatch.setattr(readiness, "_owner_pid", -1)
    monkeypatch.setattr(readiness, "_lock", ForbiddenLock())
    assert readiness.get_readiness_snapshot()["unavailable_code"] == "inherited_process"
    for action in (readiness.start_readiness_check, lambda: readiness.cancel_readiness_check(str(uuid.uuid4()))):
        with pytest.raises(readiness.ReadinessError) as error:
            action()
        assert error.value.code == "readiness_unavailable"
    readiness.register_readiness_shutdown()
    readiness.close_readiness_manager()


def test_missing_dependency_fails_without_importing_or_probing_optional_clients(readiness, database, monkeypatch):
    checked = []
    def missing(package):
        checked.append(package)
        raise RuntimeError("private-password private-user private-database")
    monkeypatch.setattr(readiness, "_installed_version", missing)
    readiness.start_readiness_check()
    result = finished(readiness)
    assert checked == ["camel-ai"]
    assert step(result, "dependencies")["code"] == "dependency_unavailable"
    assert step(result, "gateway")["code"] == "prerequisite_failed"
    assert database.driver_options is None
    assert local_runtime._gateway is None
    assert "private-" not in json.dumps(result)


def test_database_timeout_does_not_abort_model_diagnostics(readiness, database, monkeypatch):
    monkeypatch.setattr(readiness, "_BUDGETS", {**readiness._BUDGETS, "database_step_ms": 30})
    database.query_delay = 1
    with synthetic_models(monkeypatch) as models:
        readiness.start_readiness_check()
        result = finished(readiness)
        assert result["run"]["state"] == "timed_out"
        assert step(result, "database")["code"] == "step_timeout"
        assert step(result, "embedding")["state"] == "passed"
        assert len(models.calls) == 4
        assert database.closed == 1


def test_model_timeout_is_bounded_by_outer_and_gateway_caps(readiness, database, monkeypatch):
    monkeypatch.setattr(readiness, "_BUDGETS", {**readiness._BUDGETS, "model_step_ms": 70})
    with synthetic_models(monkeypatch) as models:
        models.delay = 0.3
        started = time.monotonic()
        readiness.start_readiness_check()
        result = finished(readiness)
        assert time.monotonic() - started < 2
        assert result["run"]["state"] == "timed_out"
        assert all(step(result, identifier)["code"] == "step_timeout" for identifier in STEPS[4:8])
        assert database.closed == 1
        until = time.monotonic() + 1
        while time.monotonic() < until and local_runtime._gateway.snapshot()["metrics"]["active_requests"]:
            time.sleep(0.005)
        metrics = local_runtime._gateway.snapshot()["metrics"]
        assert metrics["active_requests"] == metrics["queued_requests"] == 0
        assert metrics["timed_out_requests"] == 4


def test_overall_budget_stops_later_steps_and_includes_bounded_cleanup(readiness, database, monkeypatch):
    monkeypatch.setattr(readiness, "_BUDGETS", {**readiness._BUDGETS, "overall_ms": 30})
    database.query_delay = 1
    readiness.start_readiness_check()
    result = finished(readiness)
    assert result["run"]["state"] == "timed_out"
    assert step(result, "database")["code"] == "budget_exhausted"
    assert step(result, "gateway")["code"] == "budget_exhausted"
    assert step(result, "cleanup")["state"] == "passed"
    assert database.closed == 1
    assert local_runtime._gateway is None


def test_shutdown_cancels_active_model_and_drains_owned_clients_before_gateway(readiness, database, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        models.release.clear()
        readiness.start_readiness_check()
        assert models.entered.wait(2)
        owner = readiness._manager
        shared = local_runtime._gateway
        started = time.monotonic()
        readiness.close_readiness_manager()
        assert time.monotonic() - started < 1.5
        result = readiness.get_readiness_snapshot()
        assert result["run"]["state"] == "cancelled"
        assert result["unavailable_code"] == "backend_closing"
        assert not owner.thread.is_alive()
        assert owner.http.is_closed and owner.client.is_closed()
        assert database.closed == 1
        assert shared.snapshot()["state"] == "running"
        assert len(models.calls) == 1


def test_cleanup_timeout_is_bounded_and_disables_admission(readiness, database, monkeypatch):
    monkeypatch.setattr(readiness, "_BUDGETS", {**readiness._BUDGETS, "cleanup_ms": 40})
    database.close_wait = threading.Event()
    with synthetic_models(monkeypatch):
        readiness.start_readiness_check()
        result = finished(readiness)
        assert result["unavailable_code"] == "cleanup_failed"
        assert result["run"]["state"] == "failed"
        assert step(result, "cleanup")["code"] == "cleanup_failed"
        assert readiness._manager.http.is_closed
        assert readiness._manager.client.is_closed()
        assert database.closed == 1


def test_accepted_configuration_is_not_relabelled_during_run(readiness, database, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        models.release.clear()
        first = readiness.start_readiness_check()
        assert models.entered.wait(2)
        monkeypatch.setattr(Config, "LLM_MODEL_NAME", "later-chat")
        monkeypatch.setattr(Config, "LOCAL_EMBEDDING_MODEL", "later-embedding")
        monkeypatch.setattr(Config, "LOCAL_EMBEDDING_DIMENSIONS", 42)
        models.release.set()
        result = finished(readiness)
        assert result["run"]["configuration"] == first["run"]["configuration"]
        assert result["run"]["state"] == "passed"
        assert [payload["model"] for _, payload, _ in models.calls] == ["synthetic-chat"] * 3 + ["synthetic-embedding"]


def test_unsupported_inherited_gateway_skips_all_model_probes(readiness, database, monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            raw = b'{"status":"ok","service":"local-inference-gateway","secret":"private-password"}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    worker.start()
    monkeypatch.setenv("MIROFISH_LOCAL_GATEWAY_URL", f"http://127.0.0.1:{server.server_port}/v1")
    try:
        readiness.start_readiness_check()
        result = finished(readiness)
        assert step(result, "gateway")["code"] == "gateway_unsupported"
        assert step(result, "json_output")["code"] == "prerequisite_failed"
        assert result["run"]["state"] == "failed"
        assert local_runtime._gateway is None
        assert "private-" not in json.dumps(result)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(2)


def test_new_run_retires_previous_terminal_result(readiness, database, monkeypatch):
    with synthetic_models(monkeypatch):
        first = readiness.start_readiness_check()
        finished(readiness)
        readiness._manager.thread.join(1)
        second = readiness.start_readiness_check()
        assert second["run"]["id"] != first["run"]["id"]
        with pytest.raises(readiness.ReadinessError) as error:
            readiness.cancel_readiness_check(first["run"]["id"])
        assert error.value.code == "run_not_found"
        assert finished(readiness)["run"]["state"] == "passed"


def test_shutdown_during_cleanup_does_not_interrupt_remaining_owned_closes(readiness, database, monkeypatch):
    database.close_wait = threading.Event()
    with synthetic_models(monkeypatch):
        readiness.start_readiness_check()
        wait_for(readiness, lambda value: value["run"]["current_step"] == "cleanup")
        timer = threading.Timer(0.05, database.close_wait.set)
        timer.start()
        readiness.close_readiness_manager()
        timer.join(1)
        result = readiness.get_readiness_snapshot()
        assert step(result, "cleanup")["state"] == "passed"
        assert result["run"]["state"] == "cancelled"
        assert database.closed == 1
        assert readiness._manager.http.is_closed


def test_forced_shutdown_terminal_has_no_unfinished_steps(readiness, database, monkeypatch):
    monkeypatch.setattr(readiness, "_BUDGETS", {**readiness._BUDGETS, "cleanup_ms": 10})
    monkeypatch.setattr(readiness, "_DRAIN_SECONDS", 0.01)
    entered, release = threading.Event(), threading.Event()
    # A pathological synchronous provider cannot be force-killed by Python.
    # The bounded shutdown must quarantine it and expose a valid terminal result.
    def stuck_version(package):
        entered.set()
        release.wait(3)
        return "1.0"
    monkeypatch.setattr(readiness, "_installed_version", stuck_version)
    readiness.start_readiness_check()
    assert entered.wait(1)
    try:
        started = time.monotonic()
        readiness.close_readiness_manager()
        assert time.monotonic() - started < 0.6
        result = readiness.get_readiness_snapshot()
        assert result["run"]["state"] == "failed"
        assert result["unavailable_code"] == "cleanup_failed"
        assert all(value["state"] not in ("pending", "running") for value in result["run"]["steps"])
        assert step(result, "dependencies")["code"] == "stopped"
        with pytest.raises(readiness.ReadinessError):
            readiness.start_readiness_check()
    finally:
        release.set()
        readiness._manager.thread.join(2)
    assert database.driver_options is None


def test_stop_during_database_retains_captured_auth_and_skips_gateway(readiness, database, monkeypatch):
    database.query_delay = 0.15
    first = readiness.start_readiness_check()
    wait_for(readiness, lambda value: value["run"]["current_step"] == "database")
    monkeypatch.setattr(Config, "LOCAL_GRAPH_USER", "later-user")
    monkeypatch.setattr(Config, "LOCAL_GRAPH_PASSWORD", "later-password")
    monkeypatch.setattr(Config, "LOCAL_GRAPH_DATABASE", "later-database")
    readiness.cancel_readiness_check(first["run"]["id"])
    result = finished(readiness)
    assert result["run"]["state"] == "cancelled"
    assert database.driver_options[1]["auth"] == ("private-user", "private-password")
    assert database.sessions[0]["database"] == "private-database"
    assert local_runtime._gateway is None


def test_late_gateway_response_cannot_construct_unowned_sdk_after_cleanup(readiness, database, monkeypatch):
    import httpx
    from contextlib import asynccontextmanager
    monkeypatch.setattr(readiness, "_BUDGETS", {**readiness._BUDGETS, "gateway_step_ms": 20})
    monkeypatch.setattr(local_runtime, "get_local_gateway_url", lambda **kwargs: "http://127.0.0.1:1/v1")
    original_client = httpx.AsyncClient
    class LateHealthClient(original_client):
        @asynccontextmanager
        async def stream(self, *args, **kwargs):
            until = time.monotonic() + 0.08
            while time.monotonic() < until:
                try:
                    await asyncio.sleep(0.005)
                except asyncio.CancelledError:
                    pass
            yield httpx.Response(200, json={"status": "ok", "service": "local-inference-gateway",
                                          "request_deadline_cap": "X-MiroFish-Timeout-Ms"})
    monkeypatch.setattr(httpx, "AsyncClient", LateHealthClient)
    readiness.start_readiness_check()
    result = finished(readiness)
    assert result["run"]["state"] == "timed_out"
    assert readiness._manager.http.is_closed
    assert readiness._manager.client is None
    assert step(result, "cleanup")["state"] == "passed"


def test_queued_probe_timeout_never_reaches_model_and_cancellation_stops_later_probes(readiness, database, monkeypatch):
    import httpx
    monkeypatch.setattr(readiness, "_BUDGETS", {**readiness._BUDGETS, "model_step_ms": 100})
    with synthetic_models(monkeypatch) as models:
        url = local_runtime.get_local_gateway_url()
        models.release.clear()
        with ThreadPoolExecutor(1) as pool, httpx.Client(trust_env=False) as client:
            occupied = pool.submit(client.post, url + "/chat/completions", json={
                "model": "synthetic-chat", "messages": [{"role": "user", "content": "synthetic occupancy"}]})
            try:
                assert models.entered.wait(1)
                accepted = readiness.start_readiness_check()
                wait_for(readiness, lambda value: value["run"]["current_step"] == "json_output")
                readiness.cancel_readiness_check(accepted["run"]["id"])
                result = finished(readiness)
                assert result["run"]["state"] == "cancelled"
                assert step(result, "json_output")["code"] == "step_timeout"
                assert step(result, "json_schema")["code"] == "stopped"
                assert len(models.calls) == 1
                until = time.monotonic() + 1
                while time.monotonic() < until and local_runtime._gateway.snapshot()["metrics"]["queued_requests"]:
                    time.sleep(0.005)
                metrics = local_runtime._gateway.snapshot()["metrics"]
                assert metrics["active_requests"] == 1
                assert metrics["queued_requests"] == 0
            finally:
                models.release.set()
            assert occupied.result(timeout=1).status_code == 200


def test_sdk_close_failure_still_closes_http_and_database_without_leaking_errors(readiness, database, monkeypatch, caplog):
    import openai
    async def failed_close(client):
        raise RuntimeError("private-password private-user private-database")
    monkeypatch.setattr(openai.AsyncOpenAI, "close", failed_close)
    with synthetic_models(monkeypatch):
        readiness.start_readiness_check()
        result = finished(readiness)
        assert result["run"]["state"] == "failed"
        assert result["unavailable_code"] == "cleanup_failed"
        assert readiness._manager.http.is_closed
        assert database.closed == 1
        assert "private-" not in json.dumps(result)
        assert "private-" not in caplog.text


@pytest.mark.parametrize("name,value", [
    ("LLM_MODEL_NAME", "private-password\nsecret"),
    ("LOCAL_EMBEDDING_MODEL", "private-password" * 100),
    ("LOCAL_EMBEDDING_DIMENSIONS", 10 ** 100),
    ("LOCAL_GRAPH_URI", "bolt://private-user:private-password@127.0.0.1:7687/private-database"),
])
def test_invalid_raw_configuration_is_never_reflected(readiness, database, monkeypatch, name, value):
    monkeypatch.setattr(Config, name, value)
    readiness.start_readiness_check()
    result = finished(readiness)
    assert step(result, "configuration")["code"] == "invalid_configuration"
    assert result["run"]["state"] == "failed"
    assert database.driver_options is None
    assert "private-" not in json.dumps(result)
    assert len(json.dumps(result)) < 65536


def test_cleanup_ignoring_cancellation_has_bounded_drain_and_permanent_quarantine(readiness, database, monkeypatch):
    from neo4j import AsyncGraphDatabase
    monkeypatch.setattr(readiness, "_BUDGETS", {**readiness._BUDGETS, "cleanup_ms": 20})
    monkeypatch.setattr(readiness, "_DRAIN_SECONDS", 0.02)
    create = AsyncGraphDatabase.driver
    calls = []
    def with_stubborn_close(*args, **kwargs):
        driver = create(*args, **kwargs)
        async def close():
            calls.append("close")
            while True:
                try:
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    pass
        driver.close = close
        return driver
    monkeypatch.setattr(AsyncGraphDatabase, "driver", with_stubborn_close)
    with synthetic_models(monkeypatch):
        started = time.monotonic()
        readiness.start_readiness_check()
        result = finished(readiness)
        assert time.monotonic() - started < 1.5
        readiness._manager.thread.join(1)
        assert not readiness._manager.thread.is_alive()
        assert result["unavailable_code"] == "cleanup_failed"
        assert step(result, "cleanup")["code"] == "cleanup_failed"
        assert all(value["state"] not in ("pending", "running") for value in result["run"]["steps"])
        assert calls == ["close"]
        assert readiness._manager.http.is_closed
        with pytest.raises(readiness.ReadinessError) as error:
            readiness.start_readiness_check()
        assert error.value.code == "readiness_unavailable"


def test_shutdown_cancel_rechecks_cleanup_after_cross_thread_transition(readiness, database, monkeypatch):
    database.query_delay = 0.12
    database.close_wait = threading.Event()
    readiness.start_readiness_check()
    wait_for(readiness, lambda value: value["run"]["current_step"] == "database")
    owner = readiness._manager
    schedule = owner.loop.call_soon_threadsafe
    captured = []
    queued = threading.Event()
    def delay_cancel(callback, *args, **kwargs):
        captured.append((callback, args, kwargs))
        queued.set()
    monkeypatch.setattr(owner.loop, "call_soon_threadsafe", delay_cancel)
    with ThreadPoolExecutor(1) as pool:
        closing = pool.submit(readiness.close_readiness_manager)
        try:
            assert queued.wait(1)
            wait_for(readiness, lambda value: value["run"]["current_step"] == "cleanup")
            for callback, args, kwargs in captured:
                schedule(callback, *args, **kwargs)
            time.sleep(0.03)
            database.close_wait.set()
            closing.result(timeout=2)
        finally:
            database.close_wait.set()
    result = readiness.get_readiness_snapshot()
    assert result["run"]["state"] == "cancelled"
    assert step(result, "cleanup")["state"] == "passed"
    assert result["unavailable_code"] == "backend_closing"
    assert database.closed == 1


def test_stop_accepted_at_step_boundary_prevents_next_probe(readiness, database, monkeypatch):
    update = readiness._Run.update_step
    stopped = []
    def cancel_before_admission(owner, identifier, state, code=None, duration=None):
        if identifier == "json_output" and state == "running":
            stopped.append(readiness.cancel_readiness_check(owner.data["id"]))
        return update(owner, identifier, state, code, duration)
    monkeypatch.setattr(readiness._Run, "update_step", cancel_before_admission)
    with synthetic_models(monkeypatch) as models:
        readiness.start_readiness_check()
        result = finished(readiness)
        assert stopped[0]["run"]["state"] == "stopping"
        assert result["run"]["state"] == "cancelled"
        assert models.calls == []
        assert step(result, "json_output")["code"] == "stopped"
        assert step(result, "cleanup")["state"] == "passed"
