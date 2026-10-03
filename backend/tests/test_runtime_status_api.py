"""Real Flask route registration and passive/read-only HTTP boundary."""

import os
import socket

import pytest

from app import create_app, local_runtime
from app.config import Config
from test_runtime_status import local_config as local_config


@pytest.fixture
def client(local_config, monkeypatch):
    application = create_app()
    application.testing = True

    def forbidden(*_args, **_kwargs):
        pytest.fail("Status GET attempted a runtime side effect")

    for name in ("get_local_gateway_url", "configure_local_environment", "child_environment", "openai_client_options"):
        monkeypatch.setattr(local_runtime, name, forbidden)
    monkeypatch.setattr(Config, "validate", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    return application.test_client()


def test_registered_route_returns_safe_snapshot_without_environment_changes(client):
    before = dict(os.environ)
    response = client.get("/api/runtime/status")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert set(response.json) == {"success", "data"}
    assert response.json["success"] is True
    assert response.json["data"]["configuration"]["chat_model"] == "本地 <model>"
    assert "PRIVATE" not in response.get_data(as_text=True)
    assert dict(os.environ) == before


def test_query_arguments_are_rejected_before_observation(client, monkeypatch):
    from app.api import runtime
    monkeypatch.setattr(runtime, "get_local_runtime_snapshot", lambda: pytest.fail("Invalid query observed runtime"))
    response = client.get("/api/runtime/status?probe=true")
    assert response.status_code == 400
    assert response.json["success"] is False
    assert response.json["error_code"] == "invalid_query"
    assert response.headers["Cache-Control"] == "no-store"


def test_unexpected_status_error_has_no_sensitive_details(client, monkeypatch):
    from app.api import runtime

    def failed():
        raise RuntimeError("PRIVATE_ERROR /home/person/secret")

    monkeypatch.setattr(runtime, "get_local_runtime_snapshot", failed)
    response = client.get("/api/runtime/status")
    assert response.status_code == 500
    assert response.json["success"] is False
    assert response.json["error_code"] == "runtime_status_unavailable"
    assert response.headers["Cache-Control"] == "no-store"
    assert "PRIVATE_ERROR" not in response.get_data(as_text=True)
    assert "/home/person" not in response.get_data(as_text=True)


def test_runtime_endpoint_does_not_support_mutation_or_remote_browser(client):
    for method in ("post", "put", "patch", "delete"):
        assert getattr(client, method)("/api/runtime/status").status_code == 405
    assert client.get("/api/runtime/status", headers={"Origin": "https://example.org"}).status_code == 403
    assert client.get("/api/runtime/status", headers={"Host": "example.org"}).status_code == 403
