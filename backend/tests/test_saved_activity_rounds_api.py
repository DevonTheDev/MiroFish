"""Real GET routes preserve saved observations and safe bounded envelopes."""

import json

import pytest

from app.api import simulation as api
from app.services import simulation_comparison as shared
from scripts.action_logger import PlatformActionLogger
from test_saved_activity import action, roots as roots, rows
from test_saved_activity_api import client as client, inventory


def test_real_logger_round_route_is_readonly_and_drills_at_same_revision(client, roots):
    logger = PlatformActionLogger("twitter", str(roots[1] / "sim_saved"))
    logger.log_round_start(0, 0)
    logger.log_action(0, 0, "PRIVATE_NAME", "POST", {"text": "PRIVATE_ACTION"}, success=False)
    logger.log_action(2, 0, "PRIVATE_NAME", "POST", success=True)
    rows(roots, "reddit")
    before = inventory(roots)
    response = client.get("/api/simulation/sim_saved/saved-action-rounds?platform=twitter&round_from=000&round_to=02")
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.json["success"] is True
    data = response.json["data"]
    assert data["filters"] == {"platform": "twitter", "round_from": "0", "round_to": "2"}
    assert data["matched_count"] == 2 and data["round_count"] == 2
    assert data["outcomes"] == {"success": 1, "failed": 1, "unknown": 0}
    detail = client.get("/api/simulation/sim_saved/saved-actions", query_string={
        "platform": "twitter", "round_num": "0", "outcome": "failed", "offset": "0", "limit": "50",
        "revision": data["source_revision"],
    })
    assert detail.status_code == 200
    assert detail.json["data"]["matched_count"] == 1
    assert detail.json["data"]["source_revision"] == data["source_revision"]
    assert json.loads(detail.json["data"]["actions"][0]["details_json"])["action_args"] == {"text": "PRIVATE_ACTION"}
    assert "PRIVATE_" not in response.get_data(as_text=True)
    assert inventory(roots) == before


@pytest.mark.parametrize("query,code", [
    ("unknown=1", "invalid_filters"), ("round_num=0", "invalid_filters"),
    ("agent_id=0", "invalid_filters"), ("outcome=failed", "invalid_filters"),
    ("q=hello", "invalid_filters"), ("offset=0", "invalid_filters"),
    ("platform=", "invalid_filters"), ("platform=other", "invalid_filters"),
    ("platform=twitter&platform=twitter", "invalid_filters"),
    ("round_from=0&round_from=1", "invalid_filters"), ("round_to=1&round_to=1", "invalid_filters"),
    ("round_from=-1", "invalid_filters"), ("round_to=", "invalid_filters"),
    ("round_from=%EF%BC%91", "invalid_filters"), ("round_to=1.0", "invalid_filters"),
    ("round_from=%2B1", "invalid_filters"), ("round_from=" + "1" * 65, "invalid_filters"),
    ("round_from=10&round_to=2", "invalid_filters"),
    ("revision=", "invalid_revision"), ("revision=" + "A" * 64, "invalid_revision"),
    ("revision=" + "a" * 64 + "&revision=" + "a" * 64, "invalid_revision"),
])
def test_query_rejection_precedes_storage_and_has_safe_error(client, roots, monkeypatch, query, code):
    before = inventory(roots)
    monkeypatch.setattr(shared, "_paths", lambda *args: pytest.fail("Invalid query reached storage"))
    response = client.get("/api/simulation/sim_saved/saved-action-rounds?" + query)
    assert response.status_code == 400, response.get_data(as_text=True)
    assert response.json["success"] is False and response.json["error_code"] == code
    assert str(roots[0]) not in response.get_data(as_text=True)
    assert inventory(roots) == before


def test_revision_change_requires_refresh_and_rejects_old_drilldown(client, roots):
    path = rows(roots, values=[action(round=0, success=False)])
    first_response = client.get("/api/simulation/sim_saved/saved-action-rounds")
    assert first_response.status_code == 200, first_response.get_data(as_text=True)
    first = first_response.json["data"]
    with path.open("a") as stream:
        stream.write(json.dumps(action(round=1)) + "\n")
    for route in ("saved-action-rounds", "saved-actions"):
        stale = client.get(f"/api/simulation/sim_saved/{route}", query_string={"revision": first["source_revision"]})
        assert stale.status_code == 409 and stale.json["error_code"] == "sources_changed"
    fresh = client.get("/api/simulation/sim_saved/saved-action-rounds").json["data"]
    assert fresh["matched_count"] == 2 and fresh["round_count"] == 2
    assert fresh["source_revision"] != first["source_revision"]


def test_missing_state_does_not_create_sources(client, roots):
    before = inventory(roots)
    response = client.get("/api/simulation/sim_missing/saved-action-rounds")
    assert response.status_code == 404
    assert response.json["error_code"] == "simulation_not_found"
    assert inventory(roots) == before
    assert not (roots[0] / "sim_missing").exists() and not (roots[1] / "sim_missing").exists()


def test_round_route_rejects_all_mutating_methods(client):
    for method in ("post", "put", "patch", "delete"):
        assert getattr(client, method)("/api/simulation/sim_saved/saved-action-rounds").status_code == 405


def test_unexpected_failure_returns_safe_error_without_details(client, monkeypatch):
    assert hasattr(api, "read_saved_activity_rounds"), "Saved round API reader is missing"
    def broken(*args, **kwargs):
        raise RuntimeError("PRIVATE_ERROR_MARKER /private/file")
    monkeypatch.setattr(api, "read_saved_activity_rounds", broken)
    response = client.get("/api/simulation/sim_saved/saved-action-rounds")
    assert response.status_code == 500 and response.json["error_code"] == "activity_unavailable"
    assert "PRIVATE_ERROR_MARKER" not in response.get_data(as_text=True)
    assert "/private/file" not in response.get_data(as_text=True)


def test_1001_rounds_error_is_413_with_no_partial_data(client, roots):
    rows(roots, values=[action(round=n) for n in range(1001)])
    response = client.get("/api/simulation/sim_saved/saved-action-rounds")
    assert response.status_code == 413
    assert response.json["error_code"] == "too_many_rounds" and "data" not in response.json


def test_actual_encoded_envelope_is_bounded_after_json_provider(client, roots, monkeypatch):
    assert hasattr(api, "saved_activity_rounds"), "Saved round API module is missing"
    rows(roots, values=[action()])
    monkeypatch.setattr(api.saved_activity_rounds, "MAX_RESPONSE_BYTES", 2000)
    original = client.application.json.dumps
    def expanded(value, **kwargs):
        encoded = original(value, **kwargs)
        return encoded + " " * 2000 if value.get("success") is True else encoded
    monkeypatch.setattr(client.application.json, "dumps", expanded)
    response = client.get("/api/simulation/sim_saved/saved-action-rounds")
    assert response.status_code == 413
    assert response.json["error_code"] == "response_too_large"


def test_unusual_saved_context_strings_use_safe_json_encoding(client, roots):
    path = roots[1] / "sim_saved/run_state.json"
    run = json.loads(path.read_text())
    run["updated_at"] = "\ud800 代理 😀 café"
    path.write_text(json.dumps(run), encoding="utf-8")
    rows(roots, values=[action()])
    response = client.get("/api/simulation/sim_saved/saved-action-rounds")
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.mimetype == "application/json"
    assert response.json["data"]["context"]["updated_at"] == run["updated_at"]
    assert client.application.json.ensure_ascii is False
