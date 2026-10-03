"""Actual GET endpoints over disposable saved simulations and real log writers."""

import json
from pathlib import Path
import runpy

from flask import Flask
import pytest

from app.api import simulation as api
from app.services.simulation_manager import SimulationManager, SimulationState, SimulationStatus
from app.services.simulation_runner import SimulationRunner, SimulationRunState, RunnerStatus

PlatformActionLogger = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "scripts/action_logger.py")
)["PlatformActionLogger"]


@pytest.fixture
def saved(tmp_path, monkeypatch):
    state_root, run_root = tmp_path / "simulations", tmp_path / "runs"
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(state_root))
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(run_root))
    monkeypatch.setattr(SimulationRunner, "_run_states", {})
    manager = SimulationManager()
    for name, count, update in (("sim_left", 2, "2026-01-01T12:00:00"),
                                ("sim_right", 4, "2026-01-02T12:00:00")):
        state = SimulationState(name, "project_fixture", "graph_fixture", enable_twitter=True,
                                enable_reddit=False, status=SimulationStatus.COMPLETED,
                                profiles_count=2, created_at=update, updated_at=update)
        manager._save_simulation_state(state)
        config = dict(simulation_requirement=f"Scenario {name}", llm_model="fixture-local-model",
                      llm_api_key="SYNTHETIC_PRIVATE_MARKER", time_config={"minutes_per_round": 30})
        (state_root / name / "simulation_config.json").write_text(json.dumps(config))
        run = SimulationRunState(name, runner_status=RunnerStatus.COMPLETED, total_rounds=3,
                                 current_round=2, started_at=update, updated_at=update, completed_at=update)
        SimulationRunner._save_run_state(run)
        log = PlatformActionLogger("twitter", str(run_root / name))
        for index in range(count):
            log.log_action(round_num=min(index, 2), agent_id=index % 2,
                           agent_name="Fixture", action_type="LIKE_POST" if index == 0 else "CREATE_POST",
                           action_args={"private_text": "SYNTHETIC_PRIVATE_MARKER"}, success=index != 0)
    application = Flask(__name__)
    application.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    return application.test_client(), state_root, run_root


def inventory(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def test_candidates_and_comparison_are_read_only_and_match_real_logs(saved, monkeypatch):
    client, state_root, run_root = saved
    before = inventory(state_root), inventory(run_root)
    def forbidden(*args, **kwargs):
        pytest.fail("Comparison must not construct a manager, use cached runs, or start execution")
    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    monkeypatch.setattr(SimulationRunner, "get_run_state", forbidden)
    monkeypatch.setattr(SimulationRunner, "start_simulation", forbidden)
    candidates = client.get("/api/simulation/comparison/candidates")
    assert candidates.status_code == 200
    assert candidates.json["success"] is True
    assert [item["simulation_id"] for item in candidates.json["data"]["candidates"]] == ["sim_right", "sim_left"]
    response = client.get("/api/simulation/comparison", query_string={"left": "sim_left", "right": "sim_right"})
    assert response.status_code == 200, response.json
    data = response.json["data"]
    assert data["left"]["metrics"]["recorded_actions"] == 2
    assert data["right"]["metrics"]["recorded_actions"] == 4
    assert data["differences"]["recorded_actions"] == 2
    assert data["differences"]["rounds_with_actions"] == 1
    assert data["differences"]["platforms"]["twitter"]["active_agents"] == 0
    assert data["left"]["metrics"]["platforms"]["reddit"]["recorded_actions"] is None
    assert "SYNTHETIC_PRIVATE_MARKER" not in response.get_data(as_text=True)
    assert (inventory(state_root), inventory(run_root)) == before


@pytest.mark.parametrize("query", [
    {}, {"left": "sim_left"}, {"right": "sim_right"},
    {"left": "sim_left", "right": "sim_left"},
    {"left": "../outside", "right": "sim_right"},
    {"left": "sim_left", "right": "C:\\outside"},
    [("left", "sim_left"), ("left", "sim_right"), ("right", "sim_right")],
])
def test_invalid_selection_has_safe_client_error_without_creating_records(saved, query, monkeypatch):
    client, state_root, run_root = saved
    before = inventory(state_root), inventory(run_root)
    monkeypatch.setattr(api, "compare_saved_simulations", lambda *args: pytest.fail("Invalid IDs reached storage"))
    response = client.get("/api/simulation/comparison", query_string=query)
    assert response.status_code == 400
    assert response.json["success"] is False
    assert response.json["error_code"] == "invalid_selection"
    assert str(state_root.parent) not in response.get_data(as_text=True)
    assert (inventory(state_root), inventory(run_root)) == before


def test_missing_saved_simulation_is_404_without_a_new_directory(saved):
    client, state_root, run_root = saved
    response = client.get("/api/simulation/comparison?left=sim_left&right=sim_missing")
    assert response.status_code == 404
    assert response.json["error_code"] == "simulation_not_found"
    assert not (state_root / "sim_missing").exists()
    assert not (run_root / "sim_missing").exists()


def test_active_saved_run_returns_retryable_conflict(saved):
    client, _, run_root = saved
    path = run_root / "sim_right/run_state.json"
    run = json.loads(path.read_text())
    run["runner_status"] = "running"
    path.write_text(json.dumps(run))
    response = client.get("/api/simulation/comparison?left=sim_left&right=sim_right")
    assert response.status_code == 409
    assert response.json["error_code"] == "simulation_active"


@pytest.mark.parametrize("path", ["/api/simulation/comparison", "/api/simulation/comparison/candidates"])
def test_comparison_endpoints_reject_mutating_methods(saved, path):
    client, _, _ = saved
    assert client.post(path, json={"left": "sim_left", "right": "sim_right"}).status_code == 405


def test_empty_archive_lists_no_candidates_without_creating_root(tmp_path, monkeypatch):
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path / "absent"))
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(tmp_path / "absent-runs"))
    application = Flask(__name__)
    application.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    response = application.test_client().get("/api/simulation/comparison/candidates")
    assert response.status_code == 200
    assert response.json["data"] == {"candidates": [], "skipped_records": 0}
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("endpoint,helper", [
    ("/api/simulation/comparison?left=sim_left&right=sim_right", "compare_saved_simulations"),
    ("/api/simulation/comparison/candidates", "list_comparison_candidates"),
])
def test_unexpected_reader_failure_does_not_expose_private_details(saved, monkeypatch, endpoint, helper):
    def fail(*args):
        raise RuntimeError("PRIVATE_EXCEPTION_FIXTURE /private/file")
    monkeypatch.setattr(api, helper, fail)
    response = saved[0].get(endpoint)
    assert response.status_code == 500
    assert response.json["error_code"] == "comparison_unavailable"
    assert "PRIVATE_EXCEPTION_FIXTURE" not in response.get_data(as_text=True)
    assert "/private/file" not in response.get_data(as_text=True)


def test_one_corrupt_candidate_does_not_hide_healthy_choices(saved):
    client, state_root, _ = saved
    broken = state_root / "sim_broken"
    broken.mkdir()
    (broken / "state.json").write_text("{broken")
    response = client.get("/api/simulation/comparison/candidates")
    assert response.status_code == 200
    assert len(response.json["data"]["candidates"]) == 2
    assert response.json["data"]["skipped_records"] == 1


@pytest.mark.parametrize("kind", ["empty", "missing"])
def test_empty_and_missing_logs_remain_distinct_at_http_boundary(saved, kind):
    client, _, run_root = saved
    path = run_root / "sim_left/twitter/actions.jsonl"
    if kind == "empty":
        path.write_text("")
    else:
        path.unlink()
    response = client.get("/api/simulation/comparison?left=sim_left&right=sim_right")
    assert response.status_code == 200
    data = response.json["data"]
    assert data["left"]["metrics"]["recorded_actions"] == (0 if kind == "empty" else None)
    assert data["differences"]["recorded_actions"] == (4 if kind == "empty" else None)
