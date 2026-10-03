"""Real saved-only HTTP requests, with runtime and filesystem side-effect guards."""

import json

from flask import Flask
import pytest

from app.api import simulation as api
from app.services.simulation_manager import SimulationManager
from app.services.simulation_runner import SimulationRunner
from app.services import simulation_comparison as shared
from scripts.action_logger import PlatformActionLogger
from test_saved_activity import roots as roots, rows, action


@pytest.fixture
def client(roots, monkeypatch):
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(roots[0]))
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(roots[1]))
    def forbidden(*args, **kwargs):
        pytest.fail("Saved activity reached a runtime service")
    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    for method in ("get_run_state", "get_all_actions", "get_actions", "start_simulation", "stop_simulation"):
        monkeypatch.setattr(SimulationRunner, method, forbidden)
    monkeypatch.setattr(api.ZepEntityReader, "__init__", forbidden)
    monkeypatch.setattr(api.ZepGraphMemoryManager, "__init__", forbidden)
    application = Flask(__name__)
    # Match create_app's provider configuration instead of Flask's ASCII default.
    application.json.ensure_ascii = False
    application.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    return application.test_client()


def inventory(roots):
    return {str(path): path.read_bytes() for root in roots for path in root.rglob("*") if path.is_file()}


def test_actual_logger_get_is_readonly_and_returns_exact_saved_payload(client, roots):
    log = PlatformActionLogger("twitter", str(roots[1] / "sim_saved"))
    log.log_action(0, 0, "HTTP fixture", "POST", {"text": "literal private action"}, success=False)
    rows(roots, "reddit")
    before = inventory(roots)
    response = client.get("/api/simulation/sim_saved/saved-actions?agent_id=000&round_num=0&limit=1")
    assert response.status_code == 200, response.json
    data = response.json["data"]
    assert response.json["success"] is True
    assert data["filters"]["agent_id"] == "0"
    assert data["actions"][0]["success"] is False
    assert json.loads(data["actions"][0]["details_json"])["action_args"] == {"text": "literal private action"}
    assert "PRIVATE_CONFIG_MARKER" not in response.get_data(as_text=True)
    assert inventory(roots) == before


@pytest.mark.parametrize("query,code", [
    ("unknown=1", "invalid_filters"), ("platform=", "invalid_filters"), ("platform=other", "invalid_filters"),
    ("agent_id=0&agent_id=1", "invalid_filters"), ("round_num=-1", "invalid_filters"),
    ("agent_id=1.0", "invalid_filters"), ("agent_id=%2B1", "invalid_filters"),
    ("round_num=", "invalid_filters"), ("action_type=%00", "invalid_filters"),
    ("action_type=%0AX", "invalid_filters"), ("action_type=%7F", "invalid_filters"),
    ("limit=1&limit=2", "invalid_pagination"), ("offset=-1", "invalid_pagination"),
    ("offset=500001", "invalid_pagination"), ("limit=0", "invalid_pagination"),
    ("limit=101", "invalid_pagination"), ("limit=1.0", "invalid_pagination"),
    ("limit=%2B1", "invalid_pagination"), ("offset=1", "revision_required"),
    ("revision=", "invalid_revision"), ("revision=" + "A" * 64, "invalid_revision"),
    ("revision=" + "a" * 64 + "&revision=" + "a" * 64, "invalid_revision"),
])
def test_query_rejection_precedes_all_reads(client, roots, monkeypatch, query, code):
    before = inventory(roots)
    monkeypatch.setattr(shared, "_paths", lambda *args: pytest.fail("Invalid query reached storage"))
    response = client.get("/api/simulation/sim_saved/saved-actions?" + query)
    assert response.status_code == 400
    assert response.json["error_code"] == code
    assert str(roots[0]) not in response.get_data(as_text=True)
    assert inventory(roots) == before


def test_revision_pins_pages_until_explicit_fresh_request(client, roots):
    path = rows(roots, values=[action(), action()])
    first = client.get("/api/simulation/sim_saved/saved-actions?limit=1").json["data"]
    with path.open("a") as stream:
        stream.write(json.dumps(action()) + "\n")
    stale = client.get("/api/simulation/sim_saved/saved-actions", query_string={"offset": 1, "limit": 1, "revision": first["source_revision"]})
    assert stale.status_code == 409 and stale.json["error_code"] == "sources_changed"
    fresh = client.get("/api/simulation/sim_saved/saved-actions?limit=1").json["data"]
    assert fresh["matched_count"] == 3 and fresh["source_revision"] != first["source_revision"]


def test_missing_state_is_safe_and_does_not_create_storage(client, roots):
    response = client.get("/api/simulation/sim_missing/saved-actions")
    assert response.status_code == 404
    assert response.json["error_code"] == "simulation_not_found"
    assert not (roots[0] / "sim_missing").exists()
    assert not (roots[1] / "sim_missing").exists()


def test_mutating_methods_are_rejected(client):
    for method in ("post", "put", "patch", "delete"):
        assert getattr(client, method)("/api/simulation/sim_saved/saved-actions").status_code == 405


def test_unexpected_failure_has_safe_error_envelope(client, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("PRIVATE_ERROR_MARKER /private/file")
    monkeypatch.setattr(api, "read_saved_activity", broken)
    response = client.get("/api/simulation/sim_saved/saved-actions")
    assert response.status_code == 500
    assert response.json["error_code"] == "activity_unavailable"
    assert "PRIVATE_ERROR_MARKER" not in response.get_data(as_text=True)
    assert "/private/file" not in response.get_data(as_text=True)


def test_final_flask_encoded_envelope_is_bounded(client, roots, monkeypatch):
    import app.services.saved_activity as reader
    rows(roots, values=[action(result="界" * 100)])
    monkeypatch.setattr(reader, "MAX_RESPONSE_BYTES", 500)
    response = client.get("/api/simulation/sim_saved/saved-actions")
    assert response.status_code == 413
    assert response.json["error_code"] == "response_too_large"


@pytest.mark.parametrize("text", ["\ud800", "代理 😀 café"])
def test_actual_json_provider_preserves_saved_unicode_and_escaped_surrogates(client, roots, text):
    original = action(agent_name=text, result={"literal": text})
    rows(roots, values=[original])
    response = client.get("/api/simulation/sim_saved/saved-actions")
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.mimetype == "application/json"
    assert response.json["data"]["actions"][0]["agent_name"] == text
    assert json.loads(response.json["data"]["actions"][0]["details_json"]) == original
    assert client.application.json.ensure_ascii is False
