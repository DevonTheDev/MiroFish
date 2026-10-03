"""The runtime observation validates an allowlist without starting any service."""

from datetime import datetime
import json
import os
import socket
import threading
import warnings

import pytest

from app import local_runtime
from app.config import Config
from test_local_gateway import gateway_for, upstream_server


@pytest.fixture
def local_config(monkeypatch):
    values = {
        "LOCAL_MODE": True, "MEMORY_BACKEND": "local", "DEBUG": True,
        "LLM_BASE_URL": "http://localhost:11434/v1/", "LLM_MODEL_NAME": "本地 <model>",
        "LOCAL_EMBEDDING_BASE_URL": "http://[::1]:8080/", "LOCAL_EMBEDDING_MODEL": "nomic-embed-text",
        "LOCAL_GRAPH_URI": "bolt://localhost:7687", "LOCAL_EMBEDDING_DIMENSIONS": 768,
        "LOCAL_CONTEXT_TOKENS": 8192, "LOCAL_MAX_AGENTS": 10, "LOCAL_MAX_ROUNDS": 5,
        "LOCAL_MAX_AGENT_ITERATIONS": 3, "LOCAL_REASONING_EFFORT": "none",
        "LOCAL_MAX_CONCURRENCY": 1, "LOCAL_MAX_QUEUE": 32, "LOCAL_REQUEST_TIMEOUT": 180.0,
        "LOCAL_MAX_OUTPUT_TOKENS": 2048, "LOCAL_MAX_INPUT_CHARS": 24000,
        "LLM_API_KEY": "PRIVATE_KEY", "ZEP_API_KEY": "PRIVATE_ZEP",
        "LOCAL_GRAPH_PASSWORD": "PRIVATE_PASSWORD", "LOCAL_GRAPH_USER": "PRIVATE_USER",
        "LOCAL_GRAPH_DATABASE": "PRIVATE_DATABASE", "SECRET_KEY": "PRIVATE_SECRET",
    }
    for name, value in values.items():
        monkeypatch.setattr(Config, name, value)
    monkeypatch.setattr(local_runtime, "_gateway", None)
    monkeypatch.setattr(local_runtime, "_gateway_lock", threading.Lock())
    monkeypatch.delenv("MIROFISH_LOCAL_GATEWAY_URL", raising=False)
    return values


def snapshot():
    from app.local_runtime.status import get_local_runtime_snapshot
    return get_local_runtime_snapshot()


def unavailable_gateway(state):
    return {"state": state, "instance_id": None, "started_at": None,
            "uptime_seconds": None, "limits": None, "metrics": None}


def test_snapshot_is_passive_safe_and_has_only_contract_fields(local_config, monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("A passive snapshot invoked a runtime side effect")

    for name in ("get_local_gateway_url", "configure_local_environment", "child_environment", "openai_client_options"):
        monkeypatch.setattr(local_runtime, name, forbidden)
    monkeypatch.setattr(Config, "validate", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    before = dict(os.environ)
    with warnings.catch_warnings(record=True) as observed_warnings:
        data = snapshot()
    assert dict(os.environ) == before
    assert not observed_warnings
    assert set(data) == {"schema_version", "kind", "observed_at", "mode", "configuration", "gateway"}
    assert data["schema_version"] == 1
    assert data["kind"] == "mirofish_local_runtime_status"
    assert datetime.fromisoformat(data["observed_at"]).utcoffset().total_seconds() == 0
    assert data["mode"] == "local"
    assert data["gateway"] == unavailable_gateway("not_running")
    assert data["configuration"] == {
        "valid": True, "issues": [], "chat_model": "本地 <model>", "embedding_model": "nomic-embed-text",
        "chat_endpoint": "http://127.0.0.1:11434/v1", "embedding_endpoint": "http://[::1]:8080",
        "graph_endpoint": "bolt://127.0.0.1:7687", "embedding_dimensions": 768,
        "context_tokens": 8192, "max_agents": 10, "max_rounds": 5, "max_agent_iterations": 3,
        "reasoning_effort": "none", "gateway_limits": {
            "max_concurrency": 1, "max_queue": 32, "request_timeout": 180.0,
            "max_output_tokens": 2048, "max_input_chars": 24000,
        },
    }
    assert "PRIVATE" not in json.dumps(data)


@pytest.mark.parametrize("value", [None, True, 0, -1, 1.5, "secret-number", float("inf"), 2**53, 10**400])
def test_invalid_integers_are_null_with_fixed_issues(local_config, monkeypatch, value):
    for name in ("LOCAL_MAX_AGENTS", "LOCAL_MAX_QUEUE"):
        monkeypatch.setattr(Config, name, value)
    config = snapshot()["configuration"]
    assert config["max_agents"] is None
    assert config["gateway_limits"]["max_queue"] is None
    assert config["valid"] is False
    for field in ("max_agents", "gateway_limits.max_queue"):
        assert {"field": field, "code": "invalid_positive_integer"} in config["issues"]
    json.dumps(config, allow_nan=False)


@pytest.mark.parametrize("value", [None, True, 0, -1, "private-timeout", float("nan"), float("inf"), 10**400])
def test_invalid_timeouts_are_null_and_never_escape_json(local_config, monkeypatch, value):
    monkeypatch.setattr(Config, "LOCAL_REQUEST_TIMEOUT", value)
    config = snapshot()["configuration"]
    assert config["gateway_limits"]["request_timeout"] is None
    assert {"field": "gateway_limits.request_timeout", "code": "invalid_positive_number"} in config["issues"]
    json.dumps(config, allow_nan=False)


@pytest.mark.parametrize("name,field,value,code", [
    ("LLM_BASE_URL", "chat_endpoint", "https://secret@example.com/private", "invalid_local_endpoint"),
    ("LLM_BASE_URL", "chat_endpoint", "http://127.0.0.1/private", "invalid_local_endpoint"),
    ("LOCAL_EMBEDDING_BASE_URL", "embedding_endpoint", "http://localhost/v1?secret", "invalid_local_endpoint"),
    ("LOCAL_GRAPH_URI", "graph_endpoint", "bolt://secret:password@localhost:7687", "invalid_local_endpoint"),
    ("LOCAL_GRAPH_URI", "graph_endpoint", "bolt://localhost:7687/" + "x" * 2048, "invalid_local_endpoint"),
    ("LLM_MODEL_NAME", "chat_model", "private:cloud", "invalid_model"),
    ("LOCAL_EMBEDDING_MODEL", "embedding_model", "PRIVATE-CLOUD ", "invalid_model"),
    ("LLM_MODEL_NAME", "chat_model", "private\nmodel", "invalid_model"),
    ("LLM_MODEL_NAME", "chat_model", "private\ud800model", "invalid_model"),
    ("LLM_MODEL_NAME", "chat_model", "x" * 257, "invalid_model"),
    ("LOCAL_EMBEDDING_MODEL", "embedding_model", {}, "invalid_model"),
    ("LOCAL_REASONING_EFFORT", "reasoning_effort", "private\x7f", "invalid_reasoning_effort"),
    ("LOCAL_REASONING_EFFORT", "reasoning_effort", "private\udfff", "invalid_reasoning_effort"),
    ("LOCAL_REASONING_EFFORT", "reasoning_effort", "x" * 65, "invalid_reasoning_effort"),
])
def test_invalid_text_and_endpoints_are_not_echoed(local_config, monkeypatch, name, field, value, code):
    monkeypatch.setattr(Config, name, value)
    config = snapshot()["configuration"]
    assert config[field] is None
    assert config["valid"] is False
    assert {"field": field, "code": code} in config["issues"]
    assert "private" not in json.dumps(config).lower()


def test_output_equal_to_context_is_invalid_without_changing_loaded_values(local_config, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MAX_OUTPUT_TOKENS", 8192)
    config = snapshot()["configuration"]
    assert config["gateway_limits"]["max_output_tokens"] == 8192
    assert config["valid"] is False
    assert {"field": "gateway_limits.max_output_tokens", "code": "output_exceeds_context"} in config["issues"]


def test_omitted_reasoning_is_valid(local_config, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_REASONING_EFFORT", None)
    config = snapshot()["configuration"]
    assert config["reasoning_effort"] is None
    assert config["valid"] is True


@pytest.mark.parametrize("inherited,valid", [("http://127.0.0.1:12345/v1", True), ("https://private@example.org/secret", False)])
def test_inherited_gateway_is_unknown_and_never_probed(local_config, monkeypatch, inherited, valid):
    monkeypatch.setenv("MIROFISH_LOCAL_GATEWAY_URL", inherited)
    data = snapshot()
    assert data["gateway"] == unavailable_gateway("inherited")
    assert data["configuration"]["valid"] is valid
    if not valid:
        assert {"field": "gateway", "code": "invalid_gateway_configuration"} in data["configuration"]["issues"]
    assert inherited not in json.dumps(data)


def test_busy_owner_is_transitioning_instead_of_waiting(local_config):
    with local_runtime._gateway_lock:
        assert snapshot()["gateway"] == unavailable_gateway("transitioning")


def test_cloud_mode_omits_all_local_and_hosted_configuration(local_config, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    monkeypatch.setattr(Config, "LLM_BASE_URL", "https://private-token@example.org/v1")
    with local_runtime._gateway_lock:
        data = snapshot()
    assert data["mode"] == "cloud"
    assert data["configuration"] is None
    assert data["gateway"] == unavailable_gateway("disabled")
    assert "private" not in json.dumps(data)


def test_owned_actual_limits_are_separate_and_forked_copy_is_unobservable(local_config, monkeypatch):
    with upstream_server() as upstream, gateway_for(upstream, max_concurrency=2, max_queue=0) as (gateway, _client):
        monkeypatch.setattr(local_runtime, "_gateway", gateway)
        data = snapshot()
        assert data["configuration"]["gateway_limits"]["max_concurrency"] == 1
        assert data["gateway"]["limits"]["max_concurrency"] == 2
        assert data["gateway"]["limits"]["max_queue"] == 0
        with gateway._metrics_lock:
            monkeypatch.setattr(gateway, "_owner_pid", -1)
            assert snapshot()["gateway"] == unavailable_gateway("inherited")
            with local_runtime._gateway_lock:
                assert snapshot()["gateway"] == unavailable_gateway("inherited")


def test_actual_unsafe_integer_limits_are_null_without_mutating_settings(local_config, monkeypatch):
    from app.local_runtime.gateway import GatewaySettings, LocalInferenceGateway
    gateway = LocalInferenceGateway(GatewaySettings("http://127.0.0.1:9", "http://127.0.0.1:9", max_queue=2**53))
    monkeypatch.setattr(local_runtime, "_gateway", gateway)
    gateway.start()
    try:
        assert snapshot()["gateway"]["limits"]["max_queue"] is None
        assert gateway.settings.max_queue == 2**53
    finally:
        gateway.close()


def test_unstarted_owner_is_not_running_with_unknown_telemetry(local_config, monkeypatch):
    from app.local_runtime.gateway import GatewaySettings, LocalInferenceGateway
    gateway = LocalInferenceGateway(GatewaySettings("http://127.0.0.1:9", "http://127.0.0.1:9"))
    monkeypatch.setattr(local_runtime, "_gateway", gateway)
    assert snapshot()["gateway"] == unavailable_gateway("not_running")
