"""Exact route/persistence ownership with synthetic worker operations.

No provider or database is contacted. Preparation deliberately does not execute
these tests before the coordinator releases the frozen finite packet.
"""
from datetime import datetime
from types import SimpleNamespace
import threading

from flask import Flask
import pytest

from app.api import graph as api
from app.models.project import Project, ProjectManager, ProjectStatus
from app.models.task import TaskManager, TaskStatus
from app.services import local_graph_build as worker
from app.services import graph_build_control as controls
from app.utils import zep_lifecycle as lifecycle
from app.services.graph_build_control import (
    GraphBuildControl, GraphBuildUnresolved, register_control, release_control,
    get_control, stop_reason,
)


@pytest.fixture
def owned_build(monkeypatch, tmp_path):
    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(tmp_path / "projects"))
    monkeypatch.setattr(api.Config, "LOCAL_MODE", True)
    monkeypatch.setattr(TaskManager, "_instance", None)
    monkeypatch.setattr(controls, "_registry", {})
    monkeypatch.setattr(controls, "_project_locks", {})
    monkeypatch.setattr(lifecycle, "_graph_locks", {})
    monkeypatch.setattr(lifecycle, "_graph_readers", {})
    tasks = TaskManager()
    task_id = tasks.create_task("graph_build", {"local_graph_build": True})
    project = Project("proj_stop", "Stop fixture", ProjectStatus.GRAPH_BUILDING,
                      "2026-10-17T00:00:00+00:00", "2026-10-17T00:00:00+00:00",
                      files=[{"filename": "source.txt"}], ontology={"entity_types": []},
                      graph_build_task_id=task_id)
    (tmp_path / "projects" / project.project_id).mkdir(parents=True)
    ProjectManager.save_project(project)
    control = GraphBuildControl(project.project_id, task_id)
    control.client = None
    control.settlement_done = False
    register_control(control)
    app = Flask(__name__)
    app.register_blueprint(api.graph_bp, url_prefix="/api/graph")
    runtime = SimpleNamespace(control=control, project=project, tasks=tasks, client=app.test_client())
    yield runtime
    release_control(control)


def stop(runtime, task_id=None):
    return runtime.client.post(f"/api/graph/project/{runtime.project.project_id}/build/stop",
                               json={"task_id": task_id or runtime.control.task_id})


def load(runtime):
    return ProjectManager.get_project(runtime.project.project_id)


def test_exact_stop_is_idempotent_and_stale_task_cannot_target_replacement(owned_build):
    r = owned_build
    assert stop(r, "task_stale").status_code == 409
    assert not r.control.stop_requested
    first = stop(r)
    assert first.status_code == 202
    requested = load(r).graph_build_stop
    assert requested["task_id"] == r.control.task_id
    assert stop(r).status_code == 202
    assert load(r).graph_build_stop["requested_at"] == requested["requested_at"]
    assert r.tasks.get_task(r.control.task_id).status == TaskStatus.PROCESSING


def test_first_save_failure_keeps_only_live_fence_until_exact_retry(owned_build, monkeypatch):
    r = owned_build
    real_save = ProjectManager.save_project
    monkeypatch.setattr(ProjectManager, "save_project", lambda project: (_ for _ in ()).throw(OSError("synthetic disk failure")))
    response = stop(r)
    assert response.status_code == 503
    assert response.get_json()["data"]["persisted"] is False
    assert load(r).graph_build_stop is None
    assert stop_reason(load(r)) == "graph_build_stop_unresolved"
    monkeypatch.setattr(ProjectManager, "save_project", real_save)
    assert stop(r).status_code == 202
    assert load(r).graph_build_stop["state"] == "requested"
    assert r.control.requested_persisted


def test_late_allocated_id_merges_stop_without_losing_source_or_starting_work(owned_build):
    r = owned_build
    with r.control.operation("allocate graph"):
        assert stop(r).status_code == 202
        worker.remember_identity(r.control, graph_id="graph_late")
    project = load(r)
    assert project.graph_id == project.graph_build_stop["graph_id"] == "graph_late"
    assert project.files == r.project.files
    assert project.ontology == r.project.ontology
    assert project.status == ProjectStatus.GRAPH_BUILDING


def test_failed_identity_write_prevents_create_callback_continuation(owned_build, monkeypatch):
    r = owned_build
    mutated = []
    monkeypatch.setattr(ProjectManager, "save_project", lambda project: (_ for _ in ()).throw(OSError("identity disk failure")))
    with pytest.raises(GraphBuildUnresolved):
        with r.control.operation("allocate graph"):
            worker.remember_identity(r.control, graph_id="graph_never_created")
            mutated.append("create")
    assert mutated == []
    assert r.control.unresolved


def test_pending_bridge_and_batch_receipts_prevent_terminal_publication(owned_build):
    r = owned_build
    receipt = r.control.own_receipt("loop cleanup")
    assert stop(r).status_code == 202
    r.control.worker_done = True
    r.control.settlement_done = True
    worker.finalize_stop(r.control)
    assert load(r).status == ProjectStatus.GRAPH_BUILDING
    assert load(r).graph_build_stop["state"] == "unresolved"
    assert get_control(r.project.project_id) is r.control
    r.control.settle_receipt(receipt)
    worker.finalize_stop(r.control)
    assert load(r).status == ProjectStatus.GRAPH_STOPPED
    assert r.tasks.get_task(r.control.task_id).status == TaskStatus.CANCELLED
    assert get_control(r.project.project_id) is None
    # Restart-compatible receipt requires no in-memory task or controller.
    r.tasks._tasks.pop(r.control.task_id)
    assert stop(r).get_json()["data"]["state"] == "stopped"


def test_requested_orphan_never_upgrades_to_stopped_or_unlocks_reset(owned_build):
    r = owned_build
    assert stop(r).status_code == 202
    release_control(r.control)
    r.tasks._tasks.pop(r.control.task_id)
    assert stop(r).status_code == 409
    assert r.client.post(f"/api/graph/project/{r.project.project_id}/reset").status_code == 409
    assert r.client.delete(f"/api/graph/project/{r.project.project_id}").status_code == 409
    assert r.client.post("/api/graph/build", json={"project_id": r.project.project_id, "force": True}).status_code == 409
    assert load(r).graph_build_stop["state"] == "requested"


def test_completed_first_remains_completed(owned_build):
    r = owned_build
    project = load(r)
    project.status = ProjectStatus.GRAPH_COMPLETED
    ProjectManager.save_project(project)
    assert r.control.claim_completion()
    result = stop(r)
    assert result.status_code == 200
    assert result.get_json()["data"]["state"] == "completed"
    assert load(r).graph_build_stop is None


def test_terminal_save_failure_retains_requested_marker_until_retry(owned_build, monkeypatch):
    r = owned_build
    assert stop(r).status_code == 202
    r.control.worker_done = r.control.settlement_done = True
    real_save = ProjectManager.save_project
    monkeypatch.setattr(ProjectManager, "save_project", lambda project: (_ for _ in ()).throw(OSError("terminal disk failure")))
    with pytest.raises(OSError):
        worker.finalize_stop(r.control)
    assert load(r).status == ProjectStatus.GRAPH_BUILDING
    assert get_control(r.project.project_id) is r.control
    monkeypatch.setattr(ProjectManager, "save_project", real_save)
    assert stop(r).get_json()["data"]["state"] == "stopped"


def test_ordinary_cloud_has_no_stop_capability(owned_build, monkeypatch):
    r = owned_build
    release_control(r.control)
    monkeypatch.setattr(api.Config, "LOCAL_MODE", False)
    assert stop(r).status_code == 409
    assert load(r).graph_build_stop is None


@pytest.mark.parametrize("payload", [[], ["task"], "task", 7, True, None])
def test_stop_rejects_non_object_json_before_mutating(owned_build, payload):
    r = owned_build
    response = r.client.post(f"/api/graph/project/{r.project.project_id}/build/stop", json=payload)
    assert response.status_code == 400
    assert not r.control.stop_requested
    assert load(r).graph_build_stop is None


def test_failed_worker_with_pending_owned_receipt_remains_observable_and_stoppable(owned_build):
    r = owned_build
    receipt = r.control.own_receipt("detached batch still running")
    error = TimeoutError("synthetic polling timeout")
    r.control.record_error(error)
    r.control.worker_error = error
    worker._publish_failure(r.control, error)
    assert load(r).status == ProjectStatus.GRAPH_BUILDING
    assert r.tasks.get_task(r.control.task_id).status == TaskStatus.PROCESSING
    observed = r.client.get(f"/api/graph/project/{r.project.project_id}").get_json()["data"]
    assert observed["graph_build_control"]["can_stop"] is True
    assert "synthetic polling timeout" in observed["error"]
    assert stop(r).status_code == 202
    r.control.settle_receipt(receipt)
    r.control.worker_done = r.control.settlement_done = True
    worker.finalize_stop(r.control)
    assert load(r).status == ProjectStatus.GRAPH_STOPPED


@pytest.mark.parametrize("historical_status", [ProjectStatus.FAILED, ProjectStatus.GRAPH_BUILDING])
def test_retained_owner_blocks_rebuild_and_removal_before_receipt_settlement(owned_build, monkeypatch, historical_status):
    r = owned_build
    worker.remember_identity(r.control, graph_id="graph_partial")
    project = load(r)
    project.status = historical_status
    ProjectManager.save_project(project)
    receipt = r.control.own_receipt("unsettled batch")
    monkeypatch.setattr(api, "_delete_cloud_graph_if_present", lambda *_: pytest.fail("owned graph deleted"))
    before = load(r).to_dict()
    try:
        for force in (False, True):
            response = r.client.post("/api/graph/build", json={"project_id": project.project_id, "force": force})
            assert response.status_code == 200
            assert response.get_json()["data"]["task_id"] == r.control.task_id
            assert response.get_json()["data"]["reused"] is True
        assert r.client.post(f"/api/graph/project/{project.project_id}/reset").status_code == 409
        assert r.client.delete(f"/api/graph/project/{project.project_id}").status_code == 409
        assert r.client.delete("/api/graph/delete/graph_partial").status_code == 409
        assert load(r).to_dict() == before
    finally:
        r.control.settle_receipt(receipt)
