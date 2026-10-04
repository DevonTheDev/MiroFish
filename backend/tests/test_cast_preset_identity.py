"""Read-only preview bindings for browser-local cast presets."""

import json

import pytest

from app.models.task import TaskManager
from app.services.simulation_manager import SimulationManager
from app.services import preparation_plan
from test_local_preparation_plan import graph as graph, local as local
from test_local_preparation_plan import preview, write_project


def test_preview_returns_validated_project_graph_and_simulation_without_model_or_state_changes(local, graph, monkeypatch):
    _, calls = graph
    state_path = local.root / "sim_fixture" / "state.json"
    before = state_path.read_bytes()
    monkeypatch.setattr(SimulationManager, "__init__", lambda *a, **k: pytest.fail("manager/model startup"))
    monkeypatch.setattr(preparation_plan, "Thread", lambda *a, **k: pytest.fail("preparation startup"))
    response = preview(local)
    assert response.status_code == 200
    data = response.json["data"]
    assert {key: data.get(key) for key in ("project_id", "graph_id", "simulation_id")} == {
        "project_id": "proj_fixture", "graph_id": "graph_fixture", "simulation_id": "sim_fixture"}
    assert set(data) == {"project_id", "graph_id", "simulation_id", "total_nodes", "eligible_count", "entities", "limits"}
    assert data["eligible_count"] == len(data["entities"]) == 15
    assert data["limits"]["max_selectable_agents"] == 10
    assert response.headers["Cache-Control"] == "no-store"
    assert calls
    assert state_path.read_bytes() == before
    assert TaskManager._instance is None


@pytest.mark.parametrize("changes,code", [
    ({"graph_id": "replacement_graph"}, "graph_changed"),
    ({"project_id": "other_project"}, "invalid_artifacts"),
    ({"status": "graph_building"}, "graph_busy"),
])
def test_preview_never_returns_preset_binding_before_existing_project_lease_checks(local, graph, changes, code):
    _, calls = graph
    write_project(local, **changes)
    response = preview(local)
    assert response.status_code == 409
    assert response.json["error_code"] == code
    assert "data" not in response.json
    assert not calls
    assert TaskManager._instance is None


def test_preview_project_identity_comes_from_the_validated_saved_simulation(local, graph):
    state_path = local.root / "sim_fixture" / "state.json"
    state = json.loads(state_path.read_text())
    state["project_id"] = "second_project"
    state_path.write_text(json.dumps(state))
    project_path = local.projects / "second_project" / "project.json"
    project_path.parent.mkdir()
    project_path.write_text(json.dumps({"project_id": "second_project", "graph_id": "graph_fixture",
                                       "status": "graph_completed", "simulation_requirement": "A new project"}))
    response = preview(local)
    assert response.status_code == 200
    assert response.json["data"].get("project_id") == "second_project"
    assert response.json["data"]["graph_id"] == "graph_fixture"
    assert response.json["data"]["simulation_id"] == "sim_fixture"
