"""Local prompt trials own one bounded request and retain only its latest result."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib
import json
import os
from pathlib import Path
import socket
import threading
import time
from uuid import uuid4

import pytest

from app import local_runtime, shutdown
from app.config import Config
from test_local_readiness import synthetic_models


@pytest.fixture
def trials(monkeypatch):
    assert (Path(__file__).parents[1] / "app/local_runtime/prompt_trials.py").exists(), "Prompt trial service is missing"
    service = importlib.import_module("app.local_runtime.prompt_trials")
    for name, value in {"_manager": None, "_closing": False, "_cleanup_failed": False,
                        "_owner_pid": os.getpid(), "_lock": threading.Lock()}.items():
        monkeypatch.setattr(service, name, value)
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
        "LOCAL_MAX_OUTPUT_TOKENS": 256, "LOCAL_MAX_INPUT_CHARS": 24000,
        "LOCAL_CONTEXT_TOKENS": 8192, "LOCAL_MAX_AGENTS": 10, "LOCAL_MAX_ROUNDS": 5,
        "LOCAL_MAX_AGENT_ITERATIONS": 3,
    }
    for name, value in settings.items():
        monkeypatch.setattr(Config, name, value)
    monkeypatch.delenv("MIROFISH_LOCAL_GATEWAY_URL", raising=False)
    monkeypatch.setattr(local_runtime, "_gateway", None)
    monkeypatch.setattr(local_runtime, "_gateway_starting", None)
    yield service
    service.close_prompt_trials()
    local_runtime.close_local_gateway()


def request(**changes):
    return {"request_id": str(uuid4()), "label": "First attempt", "system_prompt": "Be brief.\n",
            "user_prompt": "Synthetic prompt", "temperature": 0.25, "max_output_tokens": 32, **changes}


def wait_for(service, predicate, timeout=4):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        result = service.get_prompt_trials_snapshot()
        if predicate(result):
            return result
        time.sleep(0.005)
    pytest.fail("Prompt trial did not reach its bounded state")


def finished(service, timeout=4):
    return wait_for(service, lambda value: value["run"] and value["run"]["state"] != "running", timeout)


def test_passive_snapshot_starts_nothing_and_is_detached(trials, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Passive observation attempted work")
    monkeypatch.setattr(Config, "validate", forbidden)
    monkeypatch.setattr(local_runtime, "get_local_gateway_url", forbidden)
    monkeypatch.setattr(trials.threading, "Thread", forbidden)
    value = trials.get_prompt_trials_snapshot()
    assert value["kind"] == "mirofish_local_prompt_trials"
    assert value["available"] is True and value["run"] is None
    assert value["limits"]["max_output_tokens"] == 256
    trials.register_prompt_trials_shutdown()
    assert shutdown._callbacks["prompt_trials"] == [trials.close_prompt_trials]
    assert trials._manager is None


def forbid_trial_work(trials, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid configuration attempted validation I/O, a worker, a gateway, or a socket")
    monkeypatch.setattr(Config, "validate", forbidden)
    monkeypatch.setattr(local_runtime, "get_local_gateway_url", forbidden)
    monkeypatch.setattr(trials.threading, "Thread", forbidden)
    monkeypatch.setattr(socket.socket, "__init__", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "bind", forbidden)


@pytest.mark.parametrize("queue", [0, -1, True, False, 1.0, "1", None, 2**53])
def test_invalid_loaded_queue_rejects_trials_without_starting_work(trials, monkeypatch, queue):
    monkeypatch.setattr(Config, "LOCAL_MAX_QUEUE", queue)
    forbid_trial_work(trials, monkeypatch)
    original = request()
    for payload in (original, original, request()):
        snapshot = trials.get_prompt_trials_snapshot()
        assert snapshot["available"] is False
        assert snapshot["unavailable_code"] == "invalid_configuration"
        assert snapshot["run"] is None
        with pytest.raises(trials.PromptTrialError) as error:
            trials.start_prompt_trial(payload)
        assert (error.value.code, error.value.status_code) == ("invalid_configuration", 503)
        assert trials._manager is None
        assert local_runtime._gateway is None
        assert local_runtime._gateway_starting is None


def test_real_request_has_exact_text_local_policy_and_no_database(trials, monkeypatch):
    from neo4j import AsyncGraphDatabase
    monkeypatch.setattr(AsyncGraphDatabase, "driver", lambda *a, **k: pytest.fail("No graph connection allowed"))
    with synthetic_models(monkeypatch) as models:
        original = request()
        accepted = trials.start_prompt_trial(original)
        result = finished(trials)
        run = result["run"]
        assert accepted["run"]["request_id"] == original["request_id"]
        assert run["state"] == "succeeded" and run["error_code"] is None
        assert run["response"] == {"content": '{"ready":true}', "refusal": None, "finish_reason": "stop",
                                   "usage": {"prompt_tokens": None, "completion_tokens": None, "total_tokens": None}}
        assert run["cleanup"]["state"] == "succeeded"
        assert 0 <= run["request_duration_ms"] <= run["elapsed_ms"]
        assert run["configuration"] == {"model": "synthetic-chat", "reasoning_effort": "none"}
        assert len(models.calls) == 1
        path, body, headers = models.calls[0]
        assert path == "/v1/chat/completions"
        assert body == {"model": "synthetic-chat", "messages": [{"role": "system", "content": original["system_prompt"]},
                         {"role": "user", "content": original["user_prompt"]}], "temperature": .25,
                         "max_tokens": 32, "stream": False, "reasoning_effort": "none"}
        assert headers["Authorization"] == "Bearer local"
        assert "X-MiroFish-Timeout-Ms" not in headers
        assert not any(secret in json.dumps(result) for secret in ("private-password", "private-user", Config.LLM_BASE_URL))
        run["request"]["label"] = "mutated"
        assert trials.get_prompt_trials_snapshot()["run"]["request"]["label"] == original["label"]


def test_lost_response_replay_and_single_active_run(trials, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        models.release.clear()
        original = request(temperature=0)
        accepted = trials.start_prompt_trial(original)
        assert models.entered.wait(2)
        replay = trials.start_prompt_trial({**original, "temperature": 0.0})
        assert replay["run"]["fingerprint"] == accepted["run"]["fingerprint"]
        for changed, code in [({**original, "label": "different"}, "request_conflict"), (request(), "already_running")]:
            with pytest.raises(trials.PromptTrialError) as error:
                trials.start_prompt_trial(changed)
            assert (error.value.code, error.value.status_code) == (code, 409)
        models.release.set()
        completed = finished(trials)
        monkeypatch.setattr(Config, "LOCAL_MAX_OUTPUT_TOKENS", 1)
        monkeypatch.setattr(trials, "_cleanup_failed", True)
        assert trials.start_prompt_trial(original)["run"] == completed["run"]
        assert len(models.calls) == 1


def test_completed_replacement_makes_old_id_unavailable(trials, monkeypatch):
    with synthetic_models(monkeypatch):
        first, second = request(), request()
        trials.start_prompt_trial(first)
        finished(trials)
        trials.start_prompt_trial(second)
        finished(trials)
        with pytest.raises(trials.PromptTrialError) as error:
            trials.get_prompt_trials_snapshot(first["request_id"])
        assert error.value.code == "run_not_found"
        assert trials.get_prompt_trials_snapshot(second["request_id"])["run"]["request_id"] == second["request_id"]


@pytest.mark.parametrize("changes", [{"LOCAL_MODE": False}, {"LLM_BASE_URL": "https://example.com/v1"},
                                    {"LLM_MODEL_NAME": "model:cloud"}])
def test_cloud_redacts_while_changed_remote_config_preserves_prior_local_result(trials, monkeypatch, changes):
    with synthetic_models(monkeypatch):
        original = request()
        trials.start_prompt_trial(original)
        prior = finished(trials)["run"]
        for name, value in changes.items():
            monkeypatch.setattr(Config, name, value)
        if changes.get("LOCAL_MODE") is False:
            assert trials.get_prompt_trials_snapshot()["run"] is None
        else:
            snapshot = trials.get_prompt_trials_snapshot()
            assert snapshot["run"] == prior
            assert snapshot["available"] is False
            assert snapshot["unavailable_code"] == "invalid_configuration"
            assert trials.start_prompt_trial(original)["run"] == prior
            assert trials.get_prompt_trials_snapshot(original["request_id"])["run"] == prior
        with pytest.raises(trials.PromptTrialError):
            trials.start_prompt_trial(request())


def test_inherited_process_never_touches_inherited_lock(trials, monkeypatch):
    class ForbiddenLock:
        def __enter__(self):
            pytest.fail("Inherited lock touched")
    monkeypatch.setattr(trials, "_owner_pid", os.getpid() + 1)
    monkeypatch.setattr(trials, "_lock", ForbiddenLock())
    class InheritedOwner:
        def snapshot(self):
            pytest.fail("Inherited owner touched")
    monkeypatch.setattr(trials, "_manager", InheritedOwner())
    assert trials.get_prompt_trials_snapshot()["unavailable_code"] == "inherited_process"
    trials.close_prompt_trials()
    trials.register_prompt_trials_shutdown()
    with pytest.raises(trials.PromptTrialError) as error:
        trials.start_prompt_trial(request())
    assert error.value.code == "trials_unavailable"


def test_thread_start_failure_preserves_latest_and_retries_safely(trials, monkeypatch):
    with synthetic_models(monkeypatch):
        original = request()
        trials.start_prompt_trial(original)
        prior = finished(trials)
        with monkeypatch.context() as patch:
            patch.setattr(threading.Thread, "start", lambda *_: (_ for _ in ()).throw(RuntimeError("PRIVATE")))
            with pytest.raises(trials.PromptTrialError) as error:
                trials.start_prompt_trial(request())
            assert error.value.code == "internal_failure" and "PRIVATE" not in str(error.value)
        assert trials.get_prompt_trials_snapshot()["run"] == prior["run"]
        trials.start_prompt_trial(request())
        assert finished(trials)["run"]["state"] == "succeeded"


@pytest.mark.parametrize("reason,content,refusal,state", [
    ("stop", "", None, "succeeded"), ("stop", "<think>exact</think>\nreply", None, "succeeded"),
    ("length", "partial", None, "truncated"), ("content_filter", None, None, "refused"),
    ("stop", None, "No thanks", "refused"),
])
def test_completion_keeps_exact_text_and_provider_finish_reason(trials, reason, content, refusal, state):
    raw = {"choices": [{"message": {"role": "assistant", "content": content, "refusal": refusal},
                         "finish_reason": reason}], "usage": {"prompt_tokens": 0, "completion_tokens": 2, "total_tokens": 2}}
    outcome, response = trials._parse_completion(raw)
    assert outcome == state
    assert response == {"content": content, "refusal": refusal, "finish_reason": reason,
                        "usage": {"prompt_tokens": 0, "completion_tokens": 2, "total_tokens": 2}}


@pytest.mark.parametrize("message,reason,code", [
    ({"role": "assistant"}, "stop", "malformed_response"),
    ({"role": "assistant", "content": None}, "stop", "malformed_response"),
    ({"role": "assistant", "content": []}, "stop", "malformed_response"),
    ({"role": "assistant", "content": "x", "tool_calls": [{"id": "x"}]}, "stop", "unsupported_completion"),
    ({"role": "assistant", "content": "x"}, "tool_calls", "unsupported_completion"),
    ({"role": "assistant", "content": "x"}, "unknown", "unsupported_completion"),
    ({"role": "assistant", "content": "x" * 16385}, "stop", "response_too_large"),
    ({"role": "assistant", "refusal": "x" * 16385}, "content_filter", "response_too_large"),
    ({"role": "assistant", "content": "\ud800"}, "stop", "malformed_response"),
])
def test_unsupported_or_malformed_completions_are_explicit_failures(trials, message, reason, code):
    with pytest.raises(trials._TrialFailure) as error:
        trials._parse_completion({"choices": [{"message": message, "finish_reason": reason}]})
    assert error.value.code == code


@pytest.mark.parametrize("usage", [None, [], {"prompt_tokens": True, "completion_tokens": -1, "total_tokens": 2**53},
                                  {"prompt_tokens": 1.0, "completion_tokens": "2", "total_tokens": float("nan")}])
def test_unknown_or_invalid_usage_is_null_never_invented_zero(trials, usage):
    _, response = trials._parse_completion({"choices": [{"message": {"role": "assistant", "content": "ok"},
                                                        "finish_reason": "stop"}], "usage": usage})
    assert response["usage"] == {"prompt_tokens": None, "completion_tokens": None, "total_tokens": None}


def test_latest_replay_survives_invalid_new_limit_without_revalidating_work(trials, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        original = request()
        trials.start_prompt_trial(original)
        prior = finished(trials)["run"]
        monkeypatch.setattr(Config, "LOCAL_MAX_OUTPUT_TOKENS", None)
        assert trials.start_prompt_trial(original)["run"] == prior
        assert len(models.calls) == 1


def test_concurrent_admission_is_one_worker_with_no_queue(trials, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        models.release.clear()
        barrier = threading.Barrier(8)
        def start():
            barrier.wait()
            try:
                return trials.start_prompt_trial(request())["run"]["request_id"]
            except trials.PromptTrialError as error:
                return error.code
        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda _: start(), range(8)))
        assert results.count("already_running") == 7
        assert models.entered.wait(1)
        assert len(models.calls) == 1
        models.release.set()
        finished(trials)


def test_shutdown_cancels_model_then_closes_owned_http_without_closing_gateway(trials, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        models.release.clear()
        trials.start_prompt_trial(request())
        assert models.entered.wait(2)
        gateway, owner = local_runtime._gateway, trials._manager
        started = time.monotonic()
        trials.close_prompt_trials()
        assert time.monotonic() - started < 1.5
        result = trials.get_prompt_trials_snapshot()
        assert result["run"]["state"] == "cancelled"
        assert result["run"]["error_code"] == "backend_closing"
        assert result["run"]["cleanup"]["state"] == "succeeded"
        assert owner.http.is_closed and not owner.thread.is_alive()
        assert gateway.snapshot()["state"] == "running"


def test_shutdown_before_worker_setup_cannot_dispatch_model(trials, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    worker = trials._Run.worker
    def delayed(owner):
        entered.set()
        release.wait(2)
        worker(owner)
    monkeypatch.setattr(trials._Run, "worker", delayed)
    with synthetic_models(monkeypatch) as models:
        trials.start_prompt_trial(request())
        assert entered.wait(1)
        with ThreadPoolExecutor(1) as pool:
            closing = pool.submit(trials.close_prompt_trials)
            until = time.monotonic() + 1
            while not trials._closing and time.monotonic() < until:
                time.sleep(.005)
            release.set()
            closing.result(timeout=2)
        assert trials.get_prompt_trials_snapshot()["run"]["state"] == "cancelled"
        assert models.calls == [] and local_runtime._gateway is None


def test_cleanup_is_admission_boundary_and_shutdown_never_interrupts_closes(trials, monkeypatch):
    import httpx
    close = httpx.AsyncClient.aclose
    entered, release = threading.Event(), threading.Event()
    calls = []
    async def delayed(client):
        await close(client)
        calls.append("close")
        entered.set()
        while not release.is_set():
            await asyncio.sleep(.005)
    with synthetic_models(monkeypatch):
        # Start shared gateway before replacing only the trial client's close.
        local_runtime.get_local_gateway_url()
        monkeypatch.setattr(httpx.AsyncClient, "aclose", delayed)
        original = request()
        trials.start_prompt_trial(original)
        assert entered.wait(2)
        assert trials.get_prompt_trials_snapshot()["run"]["state"] == "running"
        with pytest.raises(trials.PromptTrialError) as error:
            trials.start_prompt_trial(request())
        assert error.value.code == "already_running"
        with ThreadPoolExecutor(1) as pool:
            closing = pool.submit(trials.close_prompt_trials)
            time.sleep(.03)
            release.set()
            closing.result(timeout=2)
        result = trials.get_prompt_trials_snapshot()["run"]
        assert result["cleanup"]["state"] == "succeeded"
        assert calls == ["close"]
        assert trials._manager.http.is_closed
        # Completion already observed before shutdown is preserved through cleanup.
        assert result["state"] == "succeeded"
    monkeypatch.setattr(httpx.AsyncClient, "aclose", close)


@pytest.mark.parametrize("stubborn", [False, True])
def test_cleanup_failure_attempts_every_close_and_quarantines_new_admission(trials, monkeypatch, stubborn):
    monkeypatch.setattr(trials, "_BUDGETS", {**trials._BUDGETS, "cleanup_ms": 20})
    monkeypatch.setattr(trials, "_DRAIN_SECONDS", .02)
    gateway = trials._Run.gateway
    calls = []
    async def add_closes(owner, deadline):
        result = await gateway(owner, deadline)
        async def fails():
            calls.append("failed")
            if not stubborn:
                raise RuntimeError("PRIVATE")
            while True:
                try:
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    pass
        async def succeeds():
            calls.append("succeeded")
        owner.resources.extend([succeeds, fails])
        return result
    monkeypatch.setattr(trials._Run, "gateway", add_closes)
    with synthetic_models(monkeypatch):
        started = time.monotonic()
        original = request()
        trials.start_prompt_trial(original)
        result = finished(trials)
        trials._manager.thread.join(1)
        assert time.monotonic() - started < 1.5
        assert not trials._manager.thread.is_alive()
        assert trials._manager.http.is_closed
        assert set(calls) == {"failed", "succeeded"}
        assert result["unavailable_code"] == "cleanup_failed"
        assert result["run"]["error_code"] == "cleanup_failed"
        assert result["run"]["state"] == "failed"
        assert result["run"]["cleanup"]["state"] == "failed"
        assert "PRIVATE" not in json.dumps(result)
        assert trials.start_prompt_trial(original)["run"] == result["run"]
        with pytest.raises(trials.PromptTrialError) as error:
            trials.start_prompt_trial(request())
        assert error.value.code == "trials_unavailable"


def test_bounded_startup_lock_and_no_model_work(trials, monkeypatch):
    monkeypatch.setattr(trials, "_BUDGETS", {**trials._BUDGETS, "gateway_startup_ms": 40})
    with local_runtime._gateway_lock:
        started = time.monotonic()
        trials.start_prompt_trial(request())
        result = finished(trials)
        assert time.monotonic() - started < .8
        assert result["run"]["state"] == "timed_out"
        assert result["run"]["error_code"] == "startup_timeout"
        assert result["run"]["request_duration_ms"] is None
        assert local_runtime._gateway is None


def test_shutdown_order_closes_trials_before_shared_gateway_even_registered_last(trials):
    events = []
    for phase in reversed(shutdown._PHASES):
        shutdown.register_shutdown_callback(phase, lambda phase=phase: events.append(phase))
    shutdown._run_shutdown()
    assert events.index("prompt_trials") < events.index("gateway")


def test_new_run_respects_loaded_output_cap_without_starting_a_worker(trials, monkeypatch):
    monkeypatch.setattr(trials.threading, "Thread", lambda **kwargs: pytest.fail("Invalid limit started a worker"))
    with pytest.raises(trials.PromptTrialError) as error:
        trials.start_prompt_trial(request(max_output_tokens=257))
    assert error.value.code == "invalid_request"
    assert trials._manager is None


def test_empty_system_prompt_is_optional_and_not_sent_as_a_message(trials, monkeypatch):
    with synthetic_models(monkeypatch) as models:
        original = request(system_prompt="")
        trials.start_prompt_trial(original)
        result = finished(trials)
        assert result["run"]["request"]["system_prompt"] == ""
        assert models.calls[0][1]["messages"] == [{"role": "user", "content": original["user_prompt"]}]


def test_success_retains_empty_refusal_and_output_control_characters(trials):
    text = "<think>literal</think>\x00\x1b\n"
    state, response = trials._parse_completion({"choices": [{"message": {
        "role": "assistant", "content": text, "refusal": ""}, "finish_reason": "stop"}]})
    assert state == "succeeded"
    assert response["content"] == text and response["refusal"] == ""


def test_force_sealed_shutdown_snapshot_cannot_change_when_stalled_worker_resumes(trials, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(trials, "_BUDGETS", {**trials._BUDGETS, "gateway_startup_ms": 10, "cleanup_ms": 10})
    monkeypatch.setattr(trials, "_DRAIN_SECONDS", .01)
    def stalled(**kwargs):
        entered.set()
        release.wait(2)
        return "http://127.0.0.1:1/v1"
    monkeypatch.setattr(local_runtime, "get_local_gateway_url", stalled)
    trials.start_prompt_trial(request())
    assert entered.wait(1)
    try:
        trials.close_prompt_trials()
        sealed = trials.get_prompt_trials_snapshot()["run"]
        assert sealed["error_code"] == "cleanup_failed"
        assert sealed["state"] == "failed"
    finally:
        release.set()
        trials._manager.thread.join(2)
    assert trials.get_prompt_trials_snapshot()["run"] == sealed
    assert trials._manager.http is None


def test_wall_clock_rollback_keeps_terminal_timestamp_consistent(trials, monkeypatch):
    ticks = iter(["2026-10-03T22:00:00+00:00", "2026-10-03T21:59:00+00:00"])
    monkeypatch.setattr(trials, "_utc", lambda: next(ticks))
    value = request()
    owner = trials._Run(value, trials._fingerprint(value), trials._configuration())
    owner.finish()
    assert owner.data["finished_at"] >= owner.data["started_at"]
    assert owner.data["elapsed_ms"] >= 0


def test_cancellation_resistant_late_health_cannot_start_model_after_cleanup(trials, monkeypatch):
    from contextlib import asynccontextmanager
    import httpx
    monkeypatch.setattr(trials, "_BUDGETS", {**trials._BUDGETS, "gateway_startup_ms": 20})
    monkeypatch.setattr(local_runtime, "get_local_gateway_url", lambda **kwargs: "http://127.0.0.1:1/v1")
    calls = []
    class LateHealthClient(httpx.AsyncClient):
        @asynccontextmanager
        async def stream(self, method, url, **kwargs):
            calls.append(method)
            until = time.monotonic() + .08
            while time.monotonic() < until:
                try:
                    await asyncio.sleep(.005)
                except asyncio.CancelledError:
                    pass
            raw = json.dumps({"status": "ok", "service": "local-inference-gateway",
                              "request_deadline_cap": "X-MiroFish-Timeout-Ms",
                              "request_disconnect_cancel": "X-MiroFish-Cancel-On-Disconnect"}).encode()
            yield httpx.Response(200, headers={"Content-Type": "application/json"}, stream=httpx.ByteStream(raw))
    monkeypatch.setattr(httpx, "AsyncClient", LateHealthClient)
    trials.start_prompt_trial(request())
    result = finished(trials)
    assert result["run"]["state"] == "timed_out"
    assert result["run"]["error_code"] == "startup_timeout"
    assert result["run"]["request_duration_ms"] is None
    assert result["run"]["response"] is None
    assert result["run"]["cleanup"]["state"] == "succeeded"
    assert trials._manager.http.is_closed
    assert calls == ["GET"]


def test_public_budgets_cannot_be_increased_by_internal_overrides(trials, monkeypatch):
    monkeypatch.setattr(trials, "_BUDGETS", {key: 999999999 for key in trials._DEFAULT_BUDGETS})
    assert trials._budgets() == trials._DEFAULT_BUDGETS
