"""Exact-task cancellation and restart barriers, using disposable local artifacts."""

import json

import pytest

from app.api import simulation as api
from app.config import Config
from app.models.task import TaskManager
from app.services import preparation_plan as planner
from app.services.simulation_manager import SimulationManager
from app.services.simulation_runner import SimulationRunner
from test_local_preparation_plan import (
    local as local, graph as graph, threads as threads, post, plan, write_prepared,
)


def cancel(local, task_id, **changes):
    data = {"simulation_id": "sim_fixture", "task_id": task_id}
    data.update(changes)
    return local.client.post("/api/simulation/prepare/cancel", json=data)


def status(local, task_id=None, simulation_id="sim_fixture"):
    body = {"simulation_id": simulation_id}
    if task_id:
        body["task_id"] = task_id
    return local.client.post("/api/simulation/prepare/status", json=body)


def test_admission_returns_before_preflight_and_can_cancel_before_worker(local, graph, threads, monkeypatch):
    _, calls = graph
    response = post(local, selected_entity_ids=["node_2"])
    assert response.status_code == 200
    data = response.json["data"]
    assert calls == [], "graph work must occur only inside the admitted worker"
    assert data["entity_types"] == []
    assert data["preparation_task"]["can_cancel"] is True
    task_id = data["task_id"]
    monkeypatch.setattr(SimulationManager, "__init__", lambda *a: pytest.fail("manager started after cancellation"))
    result = cancel(local, task_id)
    assert result.status_code == 200
    assert result.json["data"]["accepted"] is True
    assert result.json["data"]["preparation_phase"] == "cancelling"
    assert cancel(local, task_id).json["data"]["accepted"] is True
    threads[0].target()
    assert calls == []
    projected = status(local, task_id).json["data"]
    assert projected["status"] == projected["preparation_phase"] == "cancelled"
    assert projected["progress"] < 100
    assert not planner.active_prepare_tasks("sim_fixture")
    marker = json.loads((local.root / "sim_fixture" / "preparation_cancellation.json").read_text())
    assert marker["phase"] == "cancelled"
    assert marker["task_id"] == task_id
    assert set(marker) == {"schema_version", "simulation_id", "task_id", "phase", "requested_at", "updated_at", "progress"}


def test_exact_ids_and_task_type_cannot_mutate_owned_preparation(local, graph, threads):
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    before = {path.name: path.read_bytes() for path in (local.root / "sim_fixture").iterdir()}
    for wrong in ("task_stale", TaskManager().create_task("graph_build", {"simulation_id": "sim_fixture"}),
                  TaskManager().create_task("simulation_prepare", {"simulation_id": "sim_fixture"})):
        assert cancel(local, wrong).status_code == 409
    assert cancel(local, task_id, simulation_id="sim_other").status_code == 409
    assert status(local, task_id, "sim_other").status_code == 409
    assert before == {path.name: path.read_bytes() for path in (local.root / "sim_fixture").iterdir()}
    assert status(local).json["data"]["task_id"] == task_id


@pytest.mark.parametrize("body", ["[]", "null", '{"simulation_id":"sim_fixture","task_id":"x","extra":1}',
    '{"simulation_id":"sim_fixture","task_id":"x","task_id":"y"}',
    '{"simulation_id":"sim_fixture","task_id":NaN}', '{"simulation_id":"sim_fixture","task_id":1e400}'])
def test_cancel_body_is_strict_before_any_resources(local, body):
    response = local.client.post("/api/simulation/prepare/cancel", data=body, content_type="application/json")
    assert response.status_code == 400
    assert TaskManager._instance is None
    assert not local.root.exists()


def test_cancel_body_and_query_limits(local):
    response = local.client.post("/api/simulation/prepare/cancel", data=" " * (16 * 1024) + "{}", content_type="application/json")
    assert response.status_code == 413
    assert local.client.post("/api/simulation/prepare/cancel?x=1", json={}).status_code == 400


def test_finalization_wins_without_creating_marker(local, graph, threads, monkeypatch):
    results = []
    def prepare(self, **kwargs):
        kwargs["begin_finalization"]()
        results.append(cancel(local, task_id).json["data"])
        from app.services.simulation_manager import SimulationStatus
        state = self.get_simulation("sim_fixture")
        state.status = SimulationStatus.READY
        return state
    monkeypatch.setattr(SimulationManager, "prepare_simulation", prepare)
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    threads[0].target()
    assert results[0]["accepted"] is False
    assert results[0]["preparation_phase"] == "finalizing"
    assert cancel(local, task_id).json["data"]["accepted"] is False
    assert not (local.root / "sim_fixture" / "preparation_cancellation.json").exists()


def test_cancellation_wins_finalization_gate(local, graph, threads, monkeypatch):
    from app.utils.preparation_cancellation import PreparationCancelled
    def prepare(self, **kwargs):
        assert cancel(local, task_id).json["data"]["accepted"] is True
        with pytest.raises(PreparationCancelled):
            kwargs["begin_finalization"]()
        kwargs["cancellation_check"]()
    monkeypatch.setattr(SimulationManager, "prepare_simulation", prepare)
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    threads[0].target()
    assert status(local, task_id).json["data"]["status"] == "cancelled"


def test_cancelled_marker_survives_registry_and_task_cleanup(local, graph, threads):
    from app.services import preparation_cancellation as cancellation
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    cancel(local, task_id)
    threads[0].target()
    assert cancellation.get_controller(task_id) is None
    TaskManager._instance = None
    assert cancel(local, task_id).json["data"]["accepted"] is True
    data = plan(local).json["data"]
    assert data["cancellation"] == {"blocked": True, "phase": "cancelled", "task_id": task_id,
                                    "reason_code": "preparation_cancelled"}
    assert data["can_prepare"] is data["can_reuse"] is False
    assert status(local, task_id).json["data"]["status"] == "cancelled"


def marker(local, phase="cancelling"):
    folder = write_prepared(local, "preparing")
    data = {"schema_version": 1, "simulation_id": "sim_fixture", "task_id": "task_fixture",
            "phase": phase, "requested_at": "2026-10-04T10:00:00+00:00",
            "updated_at": "2026-10-04T10:00:00+00:00", "progress": 43}
    path = folder / "preparation_cancellation.json"
    path.write_text(json.dumps(data))
    return path


@pytest.mark.parametrize("cloud", [False, True])
@pytest.mark.parametrize("phase", ["cancelling", "cancelled"])
def test_restart_marker_blocks_prepare_reuse_force_and_start_before_resources(local, monkeypatch, cloud, phase):
    path = marker(local, phase)
    monkeypatch.setattr(Config, "LOCAL_MODE", not cloud)
    monkeypatch.setattr(SimulationManager, "__init__", lambda *a: pytest.fail("manager initialized before marker guard"))
    monkeypatch.setattr(SimulationRunner, "cleanup_simulation_logs", lambda *a: pytest.fail("cleanup ran before marker guard"))
    before = {p.name: p.read_bytes() for p in path.parent.iterdir()}
    for body in ({"simulation_id": "sim_fixture"}, {"simulation_id": "sim_fixture", "force_regenerate": True}):
        assert local.client.post("/api/simulation/prepare", json=body).status_code == 409
    if not cloud:
        assert post(local).status_code == 409
        assert post(local, preparation_mode="reuse", selected_entity_ids=None).status_code == 400
        assert local.client.post("/api/simulation/prepare", json={"simulation_id": "sim_fixture", "preparation_mode": "reuse"}).status_code == 409
    assert local.client.post("/api/simulation/start", json={"simulation_id": "sim_fixture", "force": True}).status_code == 409
    with pytest.raises(planner.PlanningError):
        SimulationRunner.start_simulation("sim_fixture", platform="reddit")
    assert api._check_simulation_prepared("sim_fixture")[0] is False
    data = plan(local).json["data"]
    assert data["can_prepare"] is data["can_reuse"] is False
    assert data["preparation_task"]["preparation_phase"] == ("cancelled" if phase == "cancelled" else "unavailable")
    assert before == {p.name: p.read_bytes() for p in path.parent.iterdir()}


@pytest.mark.parametrize("contents", ['{}', '[]', '{"x":NaN}', '{"x":1e400}', '{"x":1,"x":2}', ' ' * (16 * 1024 + 1)])
def test_corrupt_marker_fails_closed(local, contents):
    path = marker(local)
    path.write_text(contents)
    data = plan(local).json["data"]
    assert data["cancellation"]["blocked"] is True
    assert data["cancellation"]["phase"] == "unavailable"
    assert data["can_reuse"] is data["can_prepare"] is False
    assert post(local).status_code == 409
    assert status(local).status_code == 409
    assert cancel(local, "task_fixture").status_code == 409


def test_linked_marker_fails_closed_without_reading_target(local, tmp_path):
    path = marker(local)
    path.unlink()
    target = tmp_path / "private"
    target.write_text("secret")
    path.symlink_to(target)
    assert plan(local).json["data"]["cancellation"]["blocked"] is True
    assert post(local).status_code == 409
    assert target.read_text() == "secret"


@pytest.mark.parametrize("failure_at", ["cancel_write", "cancel_state", "terminal_marker", "lease"])
def test_cleanup_uncertainty_retains_exact_owner(local, graph, threads, monkeypatch, failure_at):
    from app.services import preparation_cancellation as cancellation
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    controller = cancellation.get_controller(task_id)
    def broken(*args, **kwargs):
        raise OSError("private storage or lease error")
    if failure_at == "cancel_write":
        monkeypatch.setattr(cancellation, "_write_marker", broken)
        assert cancel(local, task_id).status_code == 409
        assert controller.cancellation_requested is False
    elif failure_at == "lease":
        def prepare(self, **kwargs):
            cancel(local, task_id)
            kwargs["cancellation_check"]()
        monkeypatch.setattr(SimulationManager, "prepare_simulation", prepare)
        monkeypatch.setattr(planner, "unregister_graph_reader", broken)
    else:
        assert cancel(local, task_id).status_code == 200
        if failure_at == "cancel_state":
            monkeypatch.setattr(planner, "write_json_atomic", broken)
        else:
            monkeypatch.setattr(cancellation, "_write_marker", broken)
    threads[0].target()
    assert planner.active_prepare_tasks("sim_fixture")
    assert cancellation.get_controller(task_id) is controller
    projected = status(local, task_id).json["data"]
    assert projected["preparation_phase"] == "unavailable"
    assert projected["status"] in {"pending", "processing"}
    assert projected["can_cancel"] is False
    assert "private" not in str(projected)
    assert post(local).status_code == 409
    if failure_at == "lease":
        from app.utils.zep_lifecycle import unregister_graph_reader
        unregister_graph_reader("graph_fixture", f"prepare:sim_fixture:{task_id}")


def test_async_preflight_failure_has_safe_failed_task_and_no_marker(local, graph, threads):
    _, calls = graph
    response = post(local, selected_entity_ids=["missing_node"])
    assert response.status_code == 200
    assert not calls
    task_id = response.json["data"]["task_id"]
    threads[0].target()
    data = status(local, task_id).json["data"]
    assert data["preparation_phase"] == "failed"
    assert data["error_code"] == "selection_changed"
    assert cancel(local, task_id).json["data"]["accepted"] is False
    assert not (local.root / "sim_fixture" / "preparation_cancellation.json").exists()


def test_explicit_unknown_task_does_not_become_ready(local):
    write_prepared(local)
    assert status(local, "task_missing").status_code == 404
    other_id = TaskManager().create_task("graph_build", {"simulation_id": "sim_fixture"})
    data = status(local, other_id).json["data"]
    assert data["status"] == "pending"
    assert data["already_prepared"] is False


def test_cancel_winning_during_thread_start_failure_is_finalized(local, graph, monkeypatch):
    from app.services import preparation_cancellation as cancellation
    ids = []
    class RefusedThread:
        def __init__(self, **kwargs):
            pass
        def start(self):
            task_id = plan(local).json["data"]["preparation_task"]["task_id"]
            ids.append(task_id)
            assert cancel(local, task_id).json["data"]["accepted"] is True
            raise RuntimeError("thread could not start")
    monkeypatch.setattr(planner, "Thread", RefusedThread)
    assert post(local, selected_entity_ids=["node_2"]).status_code == 500
    assert status(local, ids[0]).json["data"]["status"] == "cancelled"
    assert cancellation.get_controller(ids[0]) is None
    assert not planner.active_prepare_tasks("sim_fixture")


def test_cancel_marker_tampering_during_drain_retains_owner(local, graph, threads):
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    assert cancel(local, task_id).status_code == 200
    path = local.root / "sim_fixture" / "preparation_cancellation.json"
    path.write_text('{"task_id":"task_other"}')
    threads[0].target()
    assert planner.active_prepare_tasks("sim_fixture")
    assert path.read_text() == '{"task_id":"task_other"}'


@pytest.mark.parametrize("point", ["lease", "entities", "document"])
def test_cancellation_checks_each_preflight_boundary(local, graph, threads, monkeypatch, point):
    from contextlib import contextmanager
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    monkeypatch.setattr(SimulationManager, "__init__", lambda *a: pytest.fail("manager after preflight cancellation"))
    if point == "lease":
        original = planner._graph_lease
        @contextmanager
        def lease(*args):
            with original(*args) as project:
                assert cancel(local, task_id).json["data"]["accepted"]
                yield project
        monkeypatch.setattr(planner, "_graph_lease", lease)
    else:
        name = "_read_entities" if point == "entities" else "_read_document"
        original = getattr(planner, name)
        def read(*args):
            result = original(*args)
            assert cancel(local, task_id).json["data"]["accepted"]
            return result
        monkeypatch.setattr(planner, name, read)
    threads[0].target()
    assert status(local, task_id).json["data"]["preparation_phase"] == "cancelled"
    assert json.loads((local.root / "sim_fixture" / "state.json").read_text())["status"] == "created"


def test_failure_cleanup_closes_cancel_admission(local, graph, threads, monkeypatch):
    task_id = post(local, selected_entity_ids=["missing_node"]).json["data"]["task_id"]
    original = planner._save_failure
    results = []
    def save(*args):
        results.append(cancel(local, task_id).json["data"])
        return original(*args)
    monkeypatch.setattr(planner, "_save_failure", save)
    threads[0].target()
    assert results[0]["accepted"] is False
    assert results[0]["preparation_phase"] == "finalizing"
    assert status(local, task_id).json["data"]["preparation_phase"] == "failed"


def test_failure_state_write_uncertainty_retains_owner(local, graph, threads, monkeypatch):
    task_id = post(local, selected_entity_ids=["missing_node"]).json["data"]["task_id"]
    def broken(*args):
        raise OSError("private state error")
    monkeypatch.setattr(SimulationManager, "_save_simulation_state", broken)
    threads[0].target()
    assert planner.active_prepare_tasks("sim_fixture")
    assert status(local, task_id).json["data"]["preparation_phase"] == "unavailable"


def test_cancel_cloud_rejected_and_logger_never_parses_bounded_body(local, monkeypatch):
    from app import create_app
    from flask import Request
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    app = create_app()
    original = Request.get_json
    def guarded(self, *args, **kwargs):
        if self.path == "/api/simulation/prepare/cancel":
            pytest.fail("logger parsed cancellation request")
        return original(self, *args, **kwargs)
    monkeypatch.setattr(Request, "get_json", guarded)
    response = app.test_client().post("/api/simulation/prepare/cancel", json={"simulation_id": "sim_fixture", "task_id": "task_fixture"})
    assert response.status_code == 403
    assert TaskManager._instance is None
    assert not local.root.exists()


def test_preflight_read_failure_after_accepted_cancel_still_finishes_cancelled(local, graph, threads, monkeypatch):
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    def failed_read(*args):
        assert cancel(local, task_id).json["data"]["accepted"] is True
        raise planner.PlanningError("preview_unavailable")
    monkeypatch.setattr(planner, "_read_entities", failed_read)
    threads[0].target()
    assert status(local, task_id).json["data"]["preparation_phase"] == "cancelled"
    assert not planner.active_prepare_tasks("sim_fixture")


def test_terminal_result_failure_retains_unavailable_ownership(local, graph, threads, monkeypatch):
    from app.services.simulation_manager import SimulationStatus
    def prepare(self, **kwargs):
        kwargs["begin_finalization"]()
        def result():
            raise ValueError("private serialization error")
        from types import SimpleNamespace
        return SimpleNamespace(status=SimulationStatus.READY, to_simple_dict=result)
    monkeypatch.setattr(SimulationManager, "prepare_simulation", prepare)
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    threads[0].target()
    assert planner.active_prepare_tasks("sim_fixture")
    assert status(local, task_id).json["data"]["preparation_phase"] == "unavailable"


def test_direct_runner_checks_its_artifact_root_when_relocated(local, monkeypatch, tmp_path):
    marker(local, "cancelled")
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path / "different_manager_root"))
    from app.services import simulation_runner as runner_module
    monkeypatch.setattr(runner_module.subprocess, "Popen", lambda *a, **k: pytest.fail("cancelled runner spawned"))
    with pytest.raises(planner.PlanningError) as error:
        SimulationRunner.start_simulation("sim_fixture", platform="reddit")
    assert error.value.code == "preparation_cancelled"


def test_terminal_task_update_uncertainty_keeps_controller_as_owner(local, graph, threads, monkeypatch):
    from app.services.simulation_manager import SimulationStatus
    def prepare(self, **kwargs):
        kwargs["begin_finalization"]()
        state = self.get_simulation("sim_fixture")
        state.status = SimulationStatus.READY
        return state
    monkeypatch.setattr(SimulationManager, "prepare_simulation", prepare)
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    manager = TaskManager()
    original = manager.complete_task
    def complete(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("completion uncertainty")
    monkeypatch.setattr(manager, "complete_task", complete)
    threads[0].target()
    assert planner.active_prepare_tasks("sim_fixture")
    data = status(local, task_id).json["data"]
    assert data["preparation_phase"] == "unavailable"
    assert data["status"] in {"pending", "processing"}
    assert plan(local).json["data"]["owner"]["busy"] is True


def test_accepted_cancel_stays_idempotent_after_uncertain_terminal_task_cleanup(local, graph, threads, monkeypatch):
    from app.services import preparation_cancellation as cancellation
    from app.models.task import TaskStatus
    task_id = post(local, selected_entity_ids=["node_2"]).json["data"]["task_id"]
    assert cancel(local, task_id).json["data"]["accepted"] is True
    manager = TaskManager()
    original_update = manager.update_task
    def uncertain_update(*args, **kwargs):
        original_update(*args, **kwargs)
        if kwargs.get("status") == TaskStatus.COMPLETED:
            raise RuntimeError("terminal task publication was uncertain")
    monkeypatch.setattr(manager, "update_task", uncertain_update)
    threads[0].target()
    assert cancellation.get_controller(task_id) is not None
    manager.cleanup_old_tasks(max_age_hours=0)
    assert manager.get_task(task_id) is None
    marker_path = local.root / "sim_fixture" / "preparation_cancellation.json"
    before = marker_path.read_bytes()
    assert cancel(local, task_id, simulation_id="sim_other").status_code == 409
    assert cancel(local, "task_other").status_code == 409
    response = cancel(local, task_id)
    assert response.status_code == 200
    assert response.json["data"]["accepted"] is True
    assert response.json["data"]["preparation_phase"] == "unavailable"
    assert response.json["data"]["task_id"] == task_id
    assert planner.active_prepare_tasks("sim_fixture")
    assert before == marker_path.read_bytes()
