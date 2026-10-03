"""Strict HTTP boundary for explicitly requested local readiness work."""

import sys
from types import ModuleType
from uuid import uuid4

from flask import Flask
import pytest

from app import local_runtime
from app.config import Config


@pytest.fixture
def api(monkeypatch):
    from app.api import runtime_bp

    calls = []
    data = {"schema_version": 1, "kind": "mirofish_local_readiness", "run": None}
    service = ModuleType("app.local_runtime.readiness")

    class ReadinessError(Exception):
        def __init__(self, code, status_code, snapshot=None):
            super().__init__("PRIVATE exception details")
            self.code, self.status_code, self.snapshot = code, status_code, snapshot

    service.ReadinessError = ReadinessError
    for name in ("get_readiness_snapshot", "start_readiness_check", "cancel_readiness_check"):
        def call(*args, name=name):
            calls.append((name, args))
            return data
        setattr(service, name, call)
    monkeypatch.setitem(sys.modules, service.__name__, service)
    monkeypatch.setattr(local_runtime, "readiness", service, raising=False)
    app = Flask(__name__)
    app.register_blueprint(runtime_bp, url_prefix="/api/runtime")
    return app.test_client(), service, calls, data


def check(response, status):
    assert response.status_code == status
    assert response.headers["Cache-Control"] == "no-store"
    assert "PRIVATE" not in response.get_data(as_text=True)
    return response.get_json()


def test_passive_get_and_explicit_actions_use_separate_services(api):
    client, _, calls, data = api
    assert check(client.get("/api/runtime/readiness"), 200) == {"success": True, "data": data}
    assert calls == [("get_readiness_snapshot", ())]
    assert check(client.post("/api/runtime/readiness", json={}), 202) == {"success": True, "data": data}
    run_id = str(uuid4())
    assert check(client.post(f"/api/runtime/readiness/{run_id}/cancel", json={}), 200) == {"success": True, "data": data}
    assert calls[-2:] == [("start_readiness_check", ()), ("cancel_readiness_check", (run_id,))]


@pytest.mark.parametrize("method,path", [
    ("get", "/api/runtime/readiness"),
    ("post", "/api/runtime/readiness"),
    ("post", "/api/runtime/readiness/00000000-0000-0000-0000-000000000001/cancel"),
])
@pytest.mark.parametrize("query", ["?unknown=1", "?x=1&x=2", "?", "?%00=secret"])
def test_queries_rejected_before_work_except_empty_query(api, method, path, query):
    client, _, calls, _ = api
    response = getattr(client, method)(path + query, **({"json": {}} if method == "post" else {}))
    if query == "?":
        check(response, 200 if method == "get" or path.endswith("/cancel") else 202)
        assert len(calls) == 1
    else:
        assert check(response, 400)["error_code"] == "invalid_request"
        assert calls == []


@pytest.mark.parametrize("body,content_type", [
    ("", "application/json"), ("{}", "text/plain"), ("{}", None),
    ("null", "application/json"), ("[]", "application/json"),
    ('{"force":true}', "application/json"), ('{"secret":"PRIVATE"}', "application/json"),
    ('{"x":NaN}', "application/json"), ('{"x":Infinity}', "application/json"),
    ("{", "application/json"), ("{}{}", "application/json"),
    (" " * 1025 + "{}", "application/json"), (b"\xff{}", "application/json"),
])
@pytest.mark.parametrize("suffix", ["", "/00000000-0000-0000-0000-000000000001/cancel"])
def test_invalid_bodies_never_start_or_stop(api, body, content_type, suffix):
    client, _, calls, _ = api
    response = client.post("/api/runtime/readiness" + suffix, data=body, content_type=content_type)
    assert check(response, 400)["error_code"] == "invalid_request"
    assert calls == []


def test_small_whitespace_empty_json_is_valid(api):
    client, _, calls, _ = api
    check(client.post("/api/runtime/readiness", data=" \n { } \t", content_type="application/json; charset=utf-8"), 202)
    assert calls == [("start_readiness_check", ())]


@pytest.mark.parametrize("run_id", ["bad", "PRIVATE", "0" * 32, "{00000000-0000-0000-0000-000000000001}", "AAAAAAAA-0000-0000-0000-000000000001"])
def test_noncanonical_ids_are_rejected_before_work(api, run_id):
    client, _, calls, _ = api
    assert check(client.post(f"/api/runtime/readiness/{run_id}/cancel", json={}), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("code,status", [
    ("local_mode_required", 403), ("already_running", 409),
    ("run_not_found", 404), ("readiness_unavailable", 503),
    ("internal_failure", 500),
])
def test_known_service_errors_use_fixed_messages_and_statuses(api, code, status):
    client, service, _, data = api
    def fail():
        raise service.ReadinessError(code, 418, snapshot=data if code == "already_running" else None)
    service.start_readiness_check = fail
    body = check(client.post("/api/runtime/readiness", json={}), status)
    assert body["success"] is False
    assert body["error_code"] == code
    if code == "already_running":
        assert body["data"] == data
    else:
        assert "data" not in body


@pytest.mark.parametrize("kind", ["unknown_service", "ordinary"])
def test_unknown_failures_never_echo_error_or_snapshot(api, kind):
    client, service, _, _ = api
    def fail():
        if kind == "ordinary":
            raise RuntimeError("PRIVATE credentials and model response")
        raise service.ReadinessError("PRIVATE", 418, snapshot={"PRIVATE": "secret"})
    service.get_readiness_snapshot = fail
    assert check(client.get("/api/runtime/readiness"), 500)["error_code"] == "internal_failure"


def test_factory_only_registers_shutdown_and_never_logs_readiness_body(api, monkeypatch):
    import app as app_module
    from app import create_app
    from app.services.simulation_runner import SimulationRunner
    from app.local_runtime import readiness
    calls = []
    logs = []
    from types import SimpleNamespace
    monkeypatch.setattr(app_module, "get_logger", lambda _name: SimpleNamespace(debug=logs.append))
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "DEBUG", True)
    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    monkeypatch.setattr(local_runtime, "configure_local_environment", lambda: None)
    monkeypatch.setattr(readiness, "register_readiness_shutdown", lambda: calls.append("register"), raising=False)
    app = create_app()
    assert calls == ["register"]
    response = app.test_client().post("/api/runtime/readiness", json={"PRIVATE": "secret"})
    check(response, 400)
    assert calls == ["register"]
    assert logs
    assert "PRIVATE" not in " ".join(logs)
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    create_app()
    assert calls == ["register"]


def test_truncated_input_stream_is_safe_invalid_request(api):
    from io import BytesIO
    client, _, calls, _ = api
    response = client.open("/api/runtime/readiness", method="POST", environ_overrides={
        "wsgi.input": BytesIO(b"{"), "CONTENT_LENGTH": "2", "CONTENT_TYPE": "application/json",
    })
    assert check(response, 400)["error_code"] == "invalid_request"
    assert calls == []
