"""Bounded graph Stop admission tests; no live provider/database fixtures.

These tests are supplied for later qualification. Source preparation does not
execute them or import the application. Deferred workers and explicit barriers
exercise route/worker races without sleep-based cancellation assertions.
"""

import json
import threading
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api import simulation as api
from app.config import Config
from app.models.project import ProjectManager
from app.models.task import TaskManager
from app.services import graph_build_control as control
from app.services import graph_readiness as readiness
from app.services import preparation_cancellation, preparation_plan as plan
from app.services.simulation_manager import SimulationManager, SimulationStatus
from app.services.simulation_runner import SimulationRunner
from app.services.zep_graph_memory_updater import ZepGraphMemoryManager
from app.utils import zep_lifecycle as lifecycle


SIM = "sim_fixture"
PROJECT = "proj_fixture"
GRAPH = "graph_fixture"
TASK = "build_fixture"
REAL_THREAD = threading.Thread


def forbidden(*args, **kwargs):
    pytest.fail("Blocked graph reached new task, graph/model work, or a state write")


@pytest.fixture
def stores(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    projects = tmp_path / "projects"
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 10)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", 5)
    monkeypatch.setattr(Config, "LOCAL_MAX_CONCURRENCY", 1)
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(root))
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(root))
    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(projects))
    monkeypatch.setattr(TaskManager, "_instance", None)
    monkeypatch.setattr(preparation_cancellation, "_controllers", {})
    monkeypatch.setattr(control, "_registry", {})
    monkeypatch.setattr(control, "_project_locks", {})
    monkeypatch.setattr(lifecycle, "_graph_locks", {})
    monkeypatch.setattr(lifecycle, "_graph_readers", {})
    for name in ("_run_states", "_processes", "_monitor_threads", "_finalization_locks"):
        monkeypatch.setattr(SimulationRunner, name, {})
    monkeypatch.setattr(ZepGraphMemoryManager, "_updaters", {})
    monkeypatch.setattr(api, "ZepEntityReader", forbidden)
    monkeypatch.setattr(plan, "ZepEntityReader", forbidden)
    monkeypatch.setattr(SimulationManager, "prepare_simulation", forbidden)
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    fixture = SimpleNamespace(root=root, projects=projects, app=app, client=app.test_client())
    write_project(fixture)
    write_state(fixture)
    return fixture


def write_project(stores, project_id=PROJECT, **changes):
    folder = stores.projects / project_id
    folder.mkdir(parents=True, exist_ok=True)
    raw = dict(project_id=project_id, name="Synthetic project", graph_id=GRAPH,
               graph_build_task_id=TASK, status="graph_completed",
               simulation_requirement="Compare synthetic reactions")
    raw.update(changes)
    (folder / "project.json").write_text(json.dumps(raw), encoding="utf-8")
    (folder / "extracted_text.txt").write_text("Synthetic document", encoding="utf-8")
    return raw


def write_state(stores, **changes):
    folder = stores.root / SIM
    folder.mkdir(parents=True, exist_ok=True)
    raw = dict(simulation_id=SIM, project_id=PROJECT, graph_id=GRAPH, status="created",
               enable_twitter=False, enable_reddit=True, config_generated=False,
               profiles_generated=False, profiles_count=0, entities_count=0, entity_types=[])
    raw.update(changes)
    (folder / "state.json").write_text(json.dumps(raw), encoding="utf-8")
    return folder


def marker(state="requested", graph_id=GRAPH, task_id=TASK, **changes):
    raw = dict(version=1, backend="local", task_id=task_id, graph_id=graph_id,
               state=state, requested_at="2026-10-17T02:00:00+00:00", phase="ingesting",
               expected_chunks=3, succeeded_chunks=1, unstarted_chunks=1)
    if state == "stopped":
        raw["settled_at"] = "2026-10-17T02:01:00+00:00"
    raw.update(changes)
    return raw


def stop_project(stores, state="requested", project_id=PROJECT, graph_id=GRAPH):
    # Test writers use the same declared lock order as the Stop endpoint.
    with control.project_build_lock(project_id):
        with lifecycle.graph_lifecycle_lock(graph_id):
            return write_project(stores, project_id=project_id, graph_id=graph_id,
                status="graph_stopped" if state == "stopped" else "graph_building",
                graph_build_stop=marker(state, graph_id=graph_id))


def request(stores, route, **changes):
    if route == "create":
        return stores.client.post("/api/simulation/create", json={"project_id": PROJECT, **changes})
    data = {"simulation_id": SIM}
    if route == "planned":
        data.update(preparation_mode="prepare", selected_entity_ids=["node_a"],
                    use_llm_for_profiles=False, parallel_profile_count=1)
    data.update(changes)
    path = "prepare/preview" if route == "preview" else "prepare"
    return stores.client.post(f"/api/simulation/{path}", json=data)


def files(stores):
    return {str(path.relative_to(stores.root)): path.read_bytes()
            for path in stores.root.rglob("*") if path.is_file()}


@pytest.fixture
def deferred(monkeypatch):
    pending = []
    class DeferredThread:
        def __init__(self, target, **kwargs):
            self.target = target
        def start(self):
            pending.append(self)
    monkeypatch.setattr(plan, "Thread", DeferredThread)
    monkeypatch.setattr(threading, "Thread", DeferredThread)
    return pending


def preview_reader(monkeypatch, inspect=None):
    class Reader:
        def filter_defined_entities(self, **kwargs):
            if inspect:
                inspect(kwargs)
            return SimpleNamespace(filtered_count=1, total_count=1, entity_types={"Person"}, entities=[])
    monkeypatch.setattr(api, "ZepEntityReader", Reader)
    return Reader


@pytest.mark.parametrize("route", ["create", "planned", "preview", "legacy"])
@pytest.mark.parametrize("status,receipt,reason", [
    ("graph_building", marker(), "graph_build_stopping"),
    ("graph_stopped", marker("stopped"), "graph_build_stopped"),
    ("graph_building", marker("unresolved"), "graph_build_stop_unresolved"),
    ("graph_building", [], "graph_build_stop_unresolved"),
    ("graph_building", {}, "graph_build_stop_unresolved"),
    ("graph_building", False, "graph_build_stop_unresolved"),
    ("graph_building", marker(version=99), "graph_build_stop_unresolved"),
    ("graph_building", marker(task_id="foreign_task"), "graph_build_stop_unresolved"),
    ("graph_building", marker(graph_id="foreign_graph"), "graph_build_stop_unresolved"),
    ("graph_stopped", None, "graph_build_stop_unresolved"),
])
def test_existing_marker_rejects_before_new_work(stores, monkeypatch, route, status, receipt, reason):
    write_project(stores, status=status, graph_build_stop=receipt)
    before = files(stores)
    monkeypatch.setattr(SimulationManager, "create_simulation", forbidden)
    monkeypatch.setattr(SimulationManager, "_save_simulation_state", forbidden)
    monkeypatch.setattr(TaskManager, "create_task", forbidden)
    response = request(stores, route)
    assert response.status_code == 409
    assert response.json["error_code"] == reason
    assert response.headers["Cache-Control"] == "no-store"
    assert files(stores) == before
    assert not lifecycle.get_graph_readers(GRAPH)


@pytest.mark.parametrize("route", ["create", "planned", "preview", "legacy"])
@pytest.mark.parametrize("owner", ["selected", "foreign"])
def test_override_checks_selected_project_and_every_graph_owner(stores, monkeypatch, route, owner):
    effective = "graph_override"
    if owner == "selected":
        stop_project(stores, "stopped")
        write_project(stores, project_id="proj_clean", graph_id=effective)
    else:
        # The first owner is clean; rejecting only the first match is unsafe.
        write_project(stores, project_id="proj_clean", graph_id=effective)
        stop_project(stores, "stopped", project_id="proj_partial", graph_id=effective)
        find_owners = ProjectManager.find_projects_by_graph_id
        monkeypatch.setattr(ProjectManager, "find_projects_by_graph_id",
                            lambda graph_id: sorted(find_owners(graph_id), key=lambda project: project.project_id))
    write_state(stores, graph_id=effective)
    response = request(stores, route, **({"graph_id": effective} if route == "create" else {}))
    assert response.status_code == 409
    assert response.json["error_code"] == "graph_build_stopped"
    assert TaskManager._instance is None


@pytest.mark.parametrize("override", [None, "clean_override"])
def test_stop_before_graph_allocation_rejects_create_even_with_override(stores, override):
    write_project(stores, graph_id=None, status="graph_building", graph_build_stop=marker(graph_id=None))
    response = request(stores, "create", **({"graph_id": override} if override else {}))
    assert response.status_code == 409
    assert response.json["error_code"] == "graph_build_stopping"


@pytest.mark.parametrize("route", ["create", "legacy"])
def test_tagged_local_graph_remains_blocked_after_server_mode_switch(stores, monkeypatch, route):
    stop_project(stores)
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    response = request(stores, route)
    assert response.status_code == 409
    assert response.json["error_code"] == "graph_build_stopping"
    assert TaskManager._instance is None


@pytest.mark.parametrize("route", ["create", "planned", "preview", "legacy"])
@pytest.mark.parametrize("owner", [PROJECT, "proj_other"])
def test_unpersisted_exact_stop_fence_blocks_all_consumers(stores, route, owner):
    if owner != PROJECT:
        write_project(stores, project_id=owner)
    build = control.GraphBuildControl(owner, TASK)
    build.graph_id = GRAPH
    control.register_control(build)
    build.request_stop()
    build.persistence_failed(OSError("synthetic first marker write failure"))
    response = request(stores, route)
    assert response.status_code == 409
    assert response.json["error_code"] == "graph_build_stop_unresolved"
    assert ProjectManager.get_project(owner).graph_build_stop is None
    assert TaskManager._instance is None


@pytest.mark.parametrize("local_mode", [True, False])
@pytest.mark.parametrize("status", ["created", "graph_building", "failed", "graph_completed"])
def test_unmarked_historical_create_keeps_eligibility_and_override(stores, monkeypatch, local_mode, status):
    monkeypatch.setattr(Config, "LOCAL_MODE", local_mode)
    write_project(stores, status=status)
    response = request(stores, "create", graph_id="graph_legacy_override")
    assert response.status_code == 200
    result = response.json["data"]
    assert result["graph_id"] == "graph_legacy_override"
    assert (stores.root / result["simulation_id"] / "state.json").is_file()


def write_prepared(stores):
    folder = write_state(stores, status="ready", config_generated=True, profiles_generated=True,
                         entities_count=1, profiles_count=1, entity_types=["Person"])
    (folder / "simulation_config.json").write_text(json.dumps({"agent_configs": [{"agent_id": 0}]}))
    (folder / "reddit_profiles.json").write_text(json.dumps([{"user_id": 0}]))


@pytest.mark.parametrize("route,local_mode", [("planned", True), ("legacy", True), ("legacy", False)])
def test_saved_reuse_returns_before_new_graph_gate(stores, monkeypatch, route, local_mode):
    write_prepared(stores)
    stop_project(stores, "stopped")
    monkeypatch.setattr(Config, "LOCAL_MODE", local_mode)
    monkeypatch.setattr(api, "marker_preflight", forbidden)
    monkeypatch.setattr(plan, "marker_preflight", forbidden)
    before = files(stores)
    if route == "planned":
        response = stores.client.post("/api/simulation/prepare", json={
            "simulation_id": SIM, "preparation_mode": "reuse"})
    else:
        response = request(stores, route)
    assert response.status_code == 200
    assert response.json["data"]["already_prepared"] is True
    assert files(stores) == before
    assert TaskManager._instance is None


def test_legacy_forced_regeneration_of_saved_artifacts_is_new_work(stores):
    write_prepared(stores)
    stop_project(stores)
    before = files(stores)
    response = request(stores, "legacy", force_regenerate=True)
    assert response.status_code == 409
    assert response.json["error_code"] == "graph_build_stopping"
    assert files(stores) == before


@pytest.mark.parametrize("route,local_mode", [("planned", True), ("legacy", True), ("legacy", False)])
def test_worker_recheck_rejects_stop_after_http_admission_without_erasing_artifacts(
        stores, monkeypatch, deferred, route, local_mode):
    monkeypatch.setattr(Config, "LOCAL_MODE", local_mode)
    folder = write_state(stores, profiles_generated=True, config_reasoning="Keep partial saved work")
    artifact = folder / "reddit_profiles.json"
    artifact.write_text('[{"user_id": 0}]')
    if route == "legacy":
        preview_reader(monkeypatch)
    response = request(stores, route)
    assert response.status_code == 200
    assert len(deferred) == 1
    task_id = response.json["data"]["task_id"]
    stop_project(stores)
    deferred[0].target()
    task = TaskManager().get_task(task_id)
    assert task.status.value == "failed"
    assert task.result["error_code"] == "graph_build_stopping"
    saved = json.loads((folder / "state.json").read_text())
    assert saved["status"] == "failed"
    assert saved["profiles_generated"] is True
    assert saved["config_reasoning"] == "Keep partial saved work"
    assert artifact.read_text() == '[{"user_id": 0}]'
    assert not plan.active_prepare_tasks(SIM)
    assert not lifecycle.get_graph_readers(GRAPH)


@pytest.mark.parametrize("route", ["planned", "legacy"])
def test_simulation_ownership_is_rechecked_after_marker_preflight(stores, monkeypatch, route):
    module = plan if route == "planned" else api
    original = module.marker_preflight
    competing = []
    def claim_after_preflight(project_id, graph_id):
        project = original(project_id, graph_id)
        with plan.admission_lock(SIM):
            competing.append(TaskManager().create_task("simulation_prepare", {"simulation_id": SIM}))
        return project
    monkeypatch.setattr(module, "marker_preflight", claim_after_preflight)
    response = request(stores, route)
    assert response.status_code == 409
    assert response.json["error_code"] == "preparation_busy"
    assert [task["task_id"] for task in TaskManager().list_tasks("simulation_prepare")] == competing


def test_legacy_preview_stop_recheck_is_not_swallowed(stores, monkeypatch, deferred):
    original = api.marker_preflight
    def stop_after_preflight(project_id, graph_id):
        project = original(project_id, graph_id)
        stop_project(stores)
        return project
    monkeypatch.setattr(api, "marker_preflight", stop_after_preflight)
    before = files(stores)
    response = request(stores, "legacy")
    assert response.status_code == 409
    assert response.json["error_code"] == "graph_build_stopping"
    tasks = TaskManager().list_tasks("simulation_prepare")
    assert len(tasks) == 1 and tasks[0]["status"] == "failed"
    assert not deferred
    assert files(stores) == before
    assert not lifecycle.get_graph_readers(GRAPH)


@pytest.mark.parametrize("route", ["planned", "legacy"])
def test_preflight_and_lease_admission_do_not_hold_simulation_lock(stores, monkeypatch, deferred, route):
    calls = []
    original = readiness.stop_reason
    def inspect(project):
        assert not SimulationRunner._finalization_lock(SIM).locked()
        assert control.project_build_lock(PROJECT)._is_owned()
        assert lifecycle.graph_lifecycle_lock(GRAPH)._is_owned()
        calls.append(project.project_id)
        return original(project)
    monkeypatch.setattr(readiness, "stop_reason", inspect)
    if route == "legacy":
        preview_reader(monkeypatch)
    else:
        monkeypatch.setattr(plan, "_read_entities", lambda *args: None)
    def prepare(self, **kwargs):
        assert lifecycle.get_graph_readers(GRAPH)
        assert not SimulationRunner._finalization_lock(SIM).locked()
        assert not lifecycle.graph_lifecycle_lock(GRAPH)._is_owned()
        assert not control.project_build_lock(PROJECT)._is_owned()
        state = self.get_simulation(SIM)
        state.status = SimulationStatus.READY
        return state
    monkeypatch.setattr(SimulationManager, "prepare_simulation", prepare)
    response = request(stores, route)
    assert response.status_code == 200
    deferred[0].target()
    assert calls
    assert TaskManager().get_task(response.json["data"]["task_id"]).status.value == "completed"
    assert not lifecycle.get_graph_readers(GRAPH)


@pytest.mark.parametrize("local_mode", [True, False])
def test_legacy_unmarked_mismatched_building_graph_keeps_historical_behavior(
        stores, monkeypatch, deferred, local_mode):
    monkeypatch.setattr(Config, "LOCAL_MODE", local_mode)
    write_project(stores, graph_id="different_project_graph", status="graph_building")
    observed = []
    def inspect_preview(kwargs):
        readers = lifecycle.get_graph_readers(GRAPH)
        assert any(value.startswith("legacy-preview:") for value in readers)
        assert not lifecycle.graph_lifecycle_lock(GRAPH)._is_owned()
        observed.append("preview")
    preview_reader(monkeypatch, inspect_preview)
    def prepare(self, **kwargs):
        assert any(value.startswith("legacy-prepare:") for value in lifecycle.get_graph_readers(GRAPH))
        assert not lifecycle.graph_lifecycle_lock(GRAPH)._is_owned()
        observed.append("prepare")
        # A separately admitted preparation is allowed to finish after Stop.
        stop_project(stores, graph_id="different_project_graph")
        assert lifecycle.get_graph_readers(GRAPH)
        state = self.get_simulation(SIM)
        state.status = SimulationStatus.READY
        return state
    monkeypatch.setattr(SimulationManager, "prepare_simulation", prepare)
    response = request(stores, "legacy")
    assert response.status_code == 200
    assert not lifecycle.get_graph_readers(GRAPH)
    deferred[0].target()
    assert observed == ["preview", "prepare"]
    assert TaskManager().get_task(response.json["data"]["task_id"]).status.value == "completed"
    assert not lifecycle.get_graph_readers(GRAPH)


def test_marker_reader_registration_survives_stop_and_is_released_on_error(stores):
    with pytest.raises(RuntimeError, match="synthetic read failure"):
        with readiness.marker_read_lease(PROJECT, GRAPH, "reader_fixture"):
            assert lifecycle.get_graph_readers(GRAPH) == ["reader_fixture"]
            assert not lifecycle.graph_lifecycle_lock(GRAPH)._is_owned()
            stop_project(stores)
            assert lifecycle.get_graph_readers(GRAPH) == ["reader_fixture"]
            raise RuntimeError("synthetic read failure")
    assert not lifecycle.get_graph_readers(GRAPH)
    with pytest.raises(readiness.GraphReadinessError) as rejected:
        with readiness.marker_read_lease(PROJECT, GRAPH, "reader_later"):
            pytest.fail("Stop admitted a later reader")
    assert rejected.value.code == "graph_build_stopping"


def test_create_save_wins_before_stop_then_fresh_preparation_is_denied(stores, monkeypatch):
    entered_save = threading.Event()
    release_save = threading.Event()
    stop_blocked = threading.Event()
    stopped = threading.Event()
    outcomes = []
    failures = []
    original = SimulationManager._save_simulation_state

    def blocked_save(self, state):
        assert control.project_build_lock(PROJECT)._is_owned()
        assert lifecycle.graph_lifecycle_lock(GRAPH)._is_owned()
        entered_save.set()
        assert release_save.wait(2), "test did not release the create-save barrier"
        return original(self, state)

    def create():
        try:
            outcomes.append(stores.app.test_client().post("/api/simulation/create", json={"project_id": PROJECT}))
        except BaseException as error:
            failures.append(error)

    def stop():
        try:
            lock = control.project_build_lock(PROJECT)
            acquired = lock.acquire(blocking=False)
            if acquired:
                lock.release()
            assert not acquired, "simulation save released the selected-project claim early"
            stop_blocked.set()
            stop_project(stores)
            stopped.set()
        except BaseException as error:
            failures.append(error)
            stop_blocked.set()

    monkeypatch.setattr(SimulationManager, "_save_simulation_state", blocked_save)
    creator = REAL_THREAD(target=create, daemon=True)
    stopper = REAL_THREAD(target=stop, daemon=True)
    try:
        creator.start()
        assert entered_save.wait(2)
        stopper.start()
        assert stop_blocked.wait(2)
        assert not stopped.is_set()
    finally:
        release_save.set()
        creator.join(2)
        if stopper.ident is not None:
            stopper.join(2)
    assert not failures
    assert not creator.is_alive() and not stopper.is_alive()
    assert outcomes[0].status_code == 200
    assert stopped.is_set()
    simulation_id = outcomes[0].json["data"]["simulation_id"]
    assert (stores.root / simulation_id / "state.json").is_file()
    response = stores.client.post("/api/simulation/prepare", json={"simulation_id": simulation_id})
    assert response.status_code == 409
    assert response.json["error_code"] == "graph_build_stopping"
