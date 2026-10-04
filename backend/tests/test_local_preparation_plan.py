"""Local planning boundaries against disposable files and synthetic owners."""

import json
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api import simulation as api
from app.config import Config
from app.models.project import ProjectManager
from app.models.task import TaskManager
from app.services.simulation_manager import SimulationManager
from app.services.simulation_runner import SimulationRunner
from app.services.zep_graph_memory_updater import ZepGraphMemoryManager


@pytest.fixture
def local(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    projects = tmp_path / "projects"
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 10)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", 5)
    monkeypatch.setattr(Config, "LOCAL_MAX_CONCURRENCY", 1)
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(root))
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(root))
    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(projects))
    from app.services import preparation_cancellation
    monkeypatch.setattr(preparation_cancellation, "_controllers", {})
    monkeypatch.setattr(TaskManager, "_instance", None)
    monkeypatch.setattr(SimulationRunner, "_run_states", {})
    monkeypatch.setattr(SimulationRunner, "_processes", {})
    monkeypatch.setattr(SimulationRunner, "_monitor_threads", {})
    monkeypatch.setattr(ZepGraphMemoryManager, "_updaters", {})
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    return SimpleNamespace(root=root, projects=projects, client=app.test_client())


def write_state(local, **changes):
    folder = local.root / "sim_fixture"
    folder.mkdir(parents=True, exist_ok=True)
    state = dict(simulation_id="sim_fixture", project_id="proj_fixture", graph_id="graph_fixture",
                 status="created", enable_twitter=False, enable_reddit=True,
                 config_generated=False, profiles_generated=False, entities_count=0,
                 profiles_count=0, entity_types=[])
    state.update(changes)
    (folder / "state.json").write_text(json.dumps(state))
    return folder


def write_prepared(local, status="ready"):
    folder = write_state(local, status=status, config_generated=True, profiles_generated=True,
                         entities_count=2, profiles_count=2, entity_types=["Person"])
    (folder / "simulation_config.json").write_text(json.dumps({
        "agent_configs": [{"agent_id": 0, "entity_uuid": "node_a"},
                          {"agent_id": 1, "entity_uuid": "node_b"}],
        "time_config": {"total_simulation_hours": 4, "minutes_per_round": 30},
    }))
    (folder / "reddit_profiles.json").write_text(json.dumps([{"user_id": 0}, {"user_id": 1}]))
    return folder


def plan(local):
    return local.client.get("/api/simulation/sim_fixture/prepare/plan")


def post(local, **changes):
    body = dict(simulation_id="sim_fixture", preparation_mode="prepare",
                selected_entity_ids=["node_a"], use_llm_for_profiles=False)
    body.update(changes)
    return local.client.post("/api/simulation/prepare", json=body)


def test_passive_missing_simulation_creates_no_storage_or_clients(local, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("passive plan constructed a manager or graph client")
    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    monkeypatch.setattr(api, "ZepEntityReader", forbidden)
    response = plan(local)
    assert response.status_code == 404
    assert response.json["error_code"] == "simulation_not_found"
    assert not local.root.exists()


def test_passive_preparing_artifacts_are_not_reconciled(local, monkeypatch):
    folder = write_prepared(local, "preparing")
    before = {p.name: p.read_bytes() for p in folder.iterdir()}
    monkeypatch.setattr(SimulationManager, "__init__", lambda *a: pytest.fail("constructor"))
    response = plan(local)
    assert response.status_code == 200
    data = response.json["data"]
    assert data["status"] == "preparing"
    assert data["can_reuse"] is True
    assert data["can_prepare"] is False
    assert data["limits"] == {"valid": True, "max_agents": 10, "max_selectable_agents": 10,
                              "max_rounds": 5, "max_concurrency": 1, "max_catalog_entities": 1000}
    assert data["prepared"]["info"]["configured_rounds"] == 8
    assert before == {p.name: p.read_bytes() for p in folder.iterdir()}
    assert response.headers["Cache-Control"] == "no-store"


def test_cloud_passive_shape_retains_legacy_workflow(local, monkeypatch):
    write_state(local)
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    data = plan(local).json["data"]
    assert data["mode"] == "cloud"
    assert data["limits"] is None
    assert data["can_prepare"] is data["can_reuse"] is False


@pytest.mark.parametrize("value", [True, 0, -1, 1.2, "5", 2**53])
def test_invalid_caps_are_observed_without_inference(local, monkeypatch, value):
    write_state(local)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", value)
    data = plan(local).json["data"]
    assert data["limits"]["valid"] is False
    assert data["limits"]["max_rounds"] is None
    assert data["can_prepare"] is False


def test_saved_cast_above_loaded_cap_is_not_reusable(local, monkeypatch):
    write_prepared(local)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 1)
    data = plan(local).json["data"]
    assert data["prepared"]["reason_code"] == "agent_limit_exceeded"
    assert data["can_reuse"] is data["can_prepare"] is False


@pytest.mark.parametrize("filename,contents", [("simulation_config.json", "[]"),
                                               ("reddit_profiles.json", "{}"),
                                               ("reddit_profiles.json", "[]")])
def test_malformed_artifacts_do_not_become_new_preparation(local, filename, contents):
    folder = write_prepared(local)
    (folder / filename).write_text(contents)
    data = plan(local).json["data"]
    assert data["prepared"]["available"] is False
    assert data["can_prepare"] is data["can_reuse"] is False


def test_missing_saved_artifact_reuse_never_falls_back_to_graph(local, monkeypatch):
    folder = write_prepared(local)
    assert plan(local).json["data"]["can_reuse"] is True
    (folder / "reddit_profiles.json").unlink()
    monkeypatch.setattr(api.ProjectManager, "get_project", lambda *a: pytest.fail("project read"))
    response = local.client.post("/api/simulation/prepare", json={
        "simulation_id": "sim_fixture", "preparation_mode": "reuse"})
    assert response.status_code == 409
    assert response.json["error_code"] == "prepared_unavailable"
    assert TaskManager._instance is None


def test_explicit_reuse_can_reconcile_idle_preparing(local):
    folder = write_prepared(local, "preparing")
    response = local.client.post("/api/simulation/prepare", json={
        "simulation_id": "sim_fixture", "preparation_mode": "reuse"})
    assert response.status_code == 200
    assert response.json["data"]["already_prepared"] is True
    assert json.loads((folder / "state.json").read_text())["status"] == "ready"


def test_active_prepare_blocks_reuse_without_reconciliation(local):
    folder = write_prepared(local, "preparing")
    task_id = TaskManager().create_task("simulation_prepare", {"simulation_id": "sim_fixture"})
    data = plan(local).json["data"]
    assert data["owner"] == {"busy": True, "reason_code": "preparation_busy", "task_id": task_id}
    assert data["can_reuse"] is False
    response = local.client.post("/api/simulation/prepare", json={
        "simulation_id": "sim_fixture", "preparation_mode": "reuse"})
    assert response.status_code == 409
    assert json.loads((folder / "state.json").read_text())["status"] == "preparing"


@pytest.mark.parametrize("changes", [
    {"selected_entity_ids": []}, {"selected_entity_ids": ["node_a", "node_a"]},
    {"selected_entity_ids": [True]}, {"selected_entity_ids": ["x" * 129]},
    {"selected_entity_ids": ["../node"]}, {"selected_entity_ids": [f"node_{i}" for i in range(11)]},
    {"use_llm_for_profiles": "false"}, {"parallel_profile_count": True},
    {"parallel_profile_count": 2}, {"parallel_profile_count": 0},
    {"preparation_mode": "oops"}, {"force_regenerate": False}, {"entity_types": ["Person"]},
    {"unexpected": 1}, {"preparation_mode": None}, {"preparation_mode": []}, {"preparation_mode": {}},
])
def test_invalid_planned_fields_fail_before_graph_or_task(local, monkeypatch, changes):
    write_state(local)
    monkeypatch.setattr(api, "ZepEntityReader", lambda *a: pytest.fail("graph access"))
    response = post(local, **changes)
    assert response.status_code == 400
    assert TaskManager._instance is None


@pytest.mark.parametrize("body", ['[]', 'null', '{"simulation_id":"sim_fixture","x":NaN}',
                                  '{"simulation_id":"sim_fixture","nested":{"x":1e400}}',
                                  '{"simulation_id":"sim_fixture","simulation_id":"other"}'])
def test_local_prepare_rejects_malformed_json_before_legacy_dispatch(local, body):
    response = local.client.post("/api/simulation/prepare", data=body, content_type="application/json")
    assert response.status_code == 400
    assert response.json["error_code"] == "invalid_request"
    assert not local.root.exists()


def test_local_prepare_body_limit_applies_before_new_field_detection(local):
    response = local.client.post("/api/simulation/prepare", data=" " * (256 * 1024) + "{}",
                                 content_type="application/json")
    assert response.status_code == 413
    assert response.json["error_code"] == "request_too_large"
    assert not local.root.exists()


def test_partial_new_fields_cannot_fall_through_to_legacy(local):
    write_prepared(local)
    response = local.client.post("/api/simulation/prepare", json={
        "simulation_id": "sim_fixture", "selected_entity_ids": ["node_a"]})
    assert response.status_code == 400


def test_new_prepare_never_silently_reuses_existing_cast(local):
    write_prepared(local)
    response = post(local)
    assert response.status_code == 409
    assert response.json["error_code"] == "existing_preparation"


@pytest.mark.parametrize("filename", ["state.json", "simulation_config.json", "run_state.json"])
def test_present_saved_ids_must_match_requested_simulation(local, filename):
    folder = write_prepared(local)
    path = folder / filename
    raw = json.loads(path.read_text()) if path.exists() else {"runner_status": "stopped"}
    raw["simulation_id"] = "sim_other"
    path.write_text(json.dumps(raw))
    response = plan(local)
    if filename == "state.json":
        assert response.status_code == 409
    else:
        assert response.status_code == 200
        assert response.json["data"]["can_reuse"] is False


def test_false_profile_completion_flag_is_not_ready(local):
    folder = write_prepared(local)
    state = json.loads((folder / "state.json").read_text())
    state["profiles_generated"] = False
    (folder / "state.json").write_text(json.dumps(state))
    assert plan(local).json["data"]["can_reuse"] is False


def test_busy_updater_lock_is_observed_without_waiting(local, monkeypatch):
    write_prepared(local)
    class HeldLock:
        def acquire(self, *, blocking=True):
            assert blocking is False, "passive ownership waited for an updater initialization"
            return False
        def __enter__(self):
            pytest.fail("passive ownership waited on updater lock")
        def __exit__(self, *args):
            pass
    monkeypatch.setattr(ZepGraphMemoryManager, "_lock", HeldLock())
    data = plan(local).json["data"]
    assert data["owner"]["busy"] is True
    assert data["owner"]["reason_code"] == "ownership_unavailable"


@pytest.mark.parametrize("filename", ["simulation_config.json", "reddit_profiles.json"])
def test_oversized_or_linked_artifacts_are_not_read(local, tmp_path, filename):
    folder = write_prepared(local)
    path = folder / filename
    with path.open("wb") as handle:
        handle.truncate(8 * 1024 * 1024 + 1)
    assert plan(local).json["data"]["prepared"]["reason_code"] == "source_too_large"
    path.unlink()
    target = tmp_path / "outside"
    target.write_text("private")
    path.symlink_to(target)
    assert plan(local).json["data"]["prepared"]["reason_code"] == "unsafe_path"


def write_project(local, **changes):
    folder = local.projects / "proj_fixture"
    folder.mkdir(parents=True, exist_ok=True)
    data = {"project_id": "proj_fixture", "graph_id": "graph_fixture", "status": "graph_completed",
            "simulation_requirement": "Compare synthetic reactions"}
    data.update(changes)
    (folder / "project.json").write_text(json.dumps(data))
    (folder / "extracted_text.txt").write_text("Synthetic document")


@pytest.fixture
def graph(local, monkeypatch):
    from app.services.zep_entity_reader import ZepEntityReader
    nodes = [{"uuid": f"node_{index}", "name": f"Person {index}", "summary": "Synthetic summary",
              "labels": ["Entity", "Person"], "attributes": {}} for index in range(15)]
    calls = []
    monkeypatch.setattr(ZepEntityReader, "__init__", lambda self: None)
    def get_nodes(self, graph_id, **kwargs):
        calls.append((graph_id, kwargs))
        return list(nodes)
    monkeypatch.setattr(ZepEntityReader, "get_all_nodes", get_nodes)
    monkeypatch.setattr(ZepEntityReader, "get_all_edges", lambda *a, **k: pytest.fail("preview/template read edges"))
    write_state(local)
    write_project(local)
    return nodes, calls


def preview(local, body=None):
    return local.client.post("/api/simulation/prepare/preview", json=body or {"simulation_id": "sim_fixture"})


def test_explicit_preview_has_complete_catalog_without_creating_preparation(local, graph):
    nodes, calls = graph
    nodes[0]["name"] = "N" * 300
    nodes[0]["summary"] = "S" * 400
    before = (local.root / "sim_fixture" / "state.json").read_bytes()
    response = preview(local)
    assert response.status_code == 200
    data = response.json["data"]
    assert data["eligible_count"] == data["total_nodes"] == 15
    assert len(data["entities"]) == 15
    assert data["limits"]["max_selectable_agents"] == 10
    item = next(entity for entity in data["entities"] if entity["uuid"] == "node_0")
    assert set(item) == {"uuid", "name", "entity_type", "summary", "text_truncated"}
    assert len(item["name"]) == 256
    assert len(item["summary"]) == 240
    assert item["text_truncated"] is True
    assert calls
    assert TaskManager._instance is None
    assert before == (local.root / "sim_fixture" / "state.json").read_bytes()


def test_preview_busy_owner_is_rejected_before_graph_initialization(local, graph):
    nodes, calls = graph
    TaskManager().create_task("simulation_prepare", {"simulation_id": "sim_fixture"})
    response = preview(local)
    assert response.status_code == 409
    assert response.json["error_code"] == "preparation_busy"
    assert not calls


@pytest.mark.parametrize("kind", ["catalog", "scan"])
def test_preview_rejects_truncated_catalogs(local, graph, kind):
    nodes, _ = graph
    count = 1001 if kind == "catalog" else 5001
    nodes[:] = [{"uuid": f"node_{i}", "name": str(i), "summary": "",
                 "labels": ["Entity", "Person"], "attributes": {}} for i in range(count)]
    response = preview(local)
    assert response.status_code == 413
    assert response.json["error_code"] == ("catalog_too_large" if kind == "catalog" else "graph_too_large")


def test_graph_reference_changes_fail_before_read(local, graph):
    nodes, calls = graph
    write_project(local, graph_id="other_graph")
    response = preview(local)
    assert response.status_code == 409
    assert response.json["error_code"] == "graph_changed"
    assert not calls


@pytest.fixture
def threads(monkeypatch):
    from app.services import preparation_plan as service
    pending = []
    class DeferredThread:
        def __init__(self, target, **kwargs):
            self.target = target
            pending.append(self)
        def start(self):
            pass
    monkeypatch.setattr(service, "Thread", DeferredThread, raising=False)
    return pending


def test_selected_prepare_admission_is_atomic_and_passes_exact_order(local, graph, threads, monkeypatch):
    from app.services.simulation_manager import SimulationStatus
    from app.utils.zep_lifecycle import get_graph_readers
    captured = []
    def prepare(self, **kwargs):
        captured.append(kwargs)
        state = self.get_simulation(kwargs["simulation_id"])
        state.status = SimulationStatus.READY
        return state
    monkeypatch.setattr(SimulationManager, "prepare_simulation", prepare)
    response = post(local, selected_entity_ids=["node_4", "node_1"])
    assert response.status_code == 200
    task_id = response.json["data"]["task_id"]
    assert response.json["data"]["expected_entities_count"] == 2
    assert len(threads) == 1
    assert post(local, selected_entity_ids=["node_2"]).status_code == 409
    assert not get_graph_readers("graph_fixture")
    threads[0].target()
    assert captured[0]["selected_entity_ids"] == ["node_4", "node_1"]
    assert captured[0]["use_llm_for_profiles"] is False
    assert captured[0]["parallel_profile_count"] == 1
    assert TaskManager().get_task(task_id).status.value == "completed"
    assert not get_graph_readers("graph_fixture")


def test_thread_start_failure_releases_task_and_graph_lease(local, graph, threads, monkeypatch):
    from app.services import preparation_plan as service
    from app.utils.zep_lifecycle import get_graph_readers
    class RefusedThread:
        def __init__(self, **kwargs):
            pass
        def start(self):
            raise RuntimeError("private thread failure")
    monkeypatch.setattr(service, "Thread", RefusedThread)
    response = post(local, selected_entity_ids=["node_2"])
    assert response.status_code == 500
    assert "private" not in response.get_data(as_text=True)
    assert not service.active_prepare_tasks("sim_fixture")
    assert not get_graph_readers("graph_fixture")


def test_worker_revalidates_changed_selection_before_model_work(local, graph, threads, monkeypatch):
    from app.services import simulation_manager as manager_module
    nodes, calls = graph
    monkeypatch.setattr(manager_module, "OasisProfileGenerator", lambda *a, **k: pytest.fail("model constructor"))
    response = post(local, selected_entity_ids=["node_2"])
    assert response.status_code == 200
    nodes[:] = [node for node in nodes if node["uuid"] != "node_2"]
    threads[0].target()
    task = TaskManager().get_task(response.json["data"]["task_id"])
    assert task.status.value == "failed"
    assert json.loads((local.root / "sim_fixture" / "state.json").read_text())["status"] == "failed"
    assert len(calls) == 1


def test_worker_ownership_lasts_through_failure_save_and_lease_cleanup(local, graph, threads, monkeypatch):
    from app.services import preparation_plan as service
    calls = []
    def fail(self, **kwargs):
        raise RuntimeError("private model error")
    monkeypatch.setattr(SimulationManager, "prepare_simulation", fail)
    original_save = SimulationManager._save_simulation_state
    def save(self, state):
        if state.status.value == "failed":
            assert service.active_prepare_tasks(state.simulation_id)
            calls.append("failed_state")
        return original_save(self, state)
    monkeypatch.setattr(SimulationManager, "_save_simulation_state", save)
    response = post(local, selected_entity_ids=["node_2"])
    assert response.status_code == 200
    original_release = service.unregister_graph_reader
    def release(graph_id, reader_id):
        assert service.active_prepare_tasks("sim_fixture")
        calls.append("release_graph")
        original_release(graph_id, reader_id)
    monkeypatch.setattr(service, "unregister_graph_reader", release)
    threads[0].target()
    assert calls == ["failed_state", "release_graph"]
    assert not service.active_prepare_tasks("sim_fixture")
    task = TaskManager().get_task(response.json["data"]["task_id"])
    assert "private" not in task.error


def test_create_app_logger_does_not_parse_local_prepare_body(local, monkeypatch):
    from app import create_app
    from flask import Request
    write_prepared(local)
    app = create_app()
    original = Request.get_json
    def no_prepare_parse(self, *args, **kwargs):
        if self.path in {"/api/simulation/prepare", "/api/simulation/prepare/preview"}:
            pytest.fail("request logger parsed a bounded preparation body")
        return original(self, *args, **kwargs)
    monkeypatch.setattr(Request, "get_json", no_prepare_parse)
    response = app.test_client().post("/api/simulation/prepare", json={
        "simulation_id": "sim_fixture", "preparation_mode": "reuse"})
    assert response.status_code == 200


@pytest.mark.parametrize("force", [False, True])
def test_old_local_prepare_payload_cannot_overlap_new_owner(local, force):
    folder = write_prepared(local)
    TaskManager().create_task("simulation_prepare", {"simulation_id": "sim_fixture", "local_planned": True})
    before = (folder / "state.json").read_bytes()
    response = local.client.post("/api/simulation/prepare", json={
        "simulation_id": "sim_fixture", "force_regenerate": force})
    assert response.status_code == 409
    assert response.json["error_code"] == "preparation_busy"
    assert (folder / "state.json").read_bytes() == before


def test_local_start_does_not_rewrite_state_while_prepare_owns_it(local, monkeypatch):
    folder = write_prepared(local, "completed")
    TaskManager().create_task("simulation_prepare", {"simulation_id": "sim_fixture"})
    before = (folder / "state.json").read_bytes()
    monkeypatch.setattr(SimulationRunner, "start_simulation", lambda **kw: pytest.fail("start reached runner"))
    response = local.client.post("/api/simulation/start", json={"simulation_id": "sim_fixture", "max_rounds": 1})
    assert response.status_code == 409
    assert response.json["error_code"] == "preparation_busy"
    assert (folder / "state.json").read_bytes() == before


def test_local_legacy_checker_does_not_reconcile_active_preparation(local):
    folder = write_prepared(local, "preparing")
    TaskManager().create_task("simulation_prepare", {"simulation_id": "sim_fixture"})
    before = (folder / "state.json").read_bytes()
    assert api._check_simulation_prepared("sim_fixture")[0] is False
    assert (folder / "state.json").read_bytes() == before


def test_manager_revalidates_selected_cast_before_clearing_saved_flags(local, graph):
    folder = write_state(local, profiles_generated=True, config_reasoning="Keep previous partial work")
    before = (folder / "state.json").read_bytes()
    manager = SimulationManager()
    with pytest.raises(ValueError, match="unavailable or ineligible"):
        manager.prepare_simulation("sim_fixture", "Synthetic requirements", "Synthetic document",
                                   selected_entity_ids=["missing_node"], use_llm_for_profiles=False,
                                   parallel_profile_count=1, max_graph_nodes=5000, max_graph_edges=20000)
    assert (folder / "state.json").read_bytes() == before


def test_selected_template_workflow_still_generates_configuration(local, graph, threads, monkeypatch):
    from app.services import simulation_manager as manager_module
    calls = []
    class Profiles:
        def __init__(self, **kwargs):
            pass
        def generate_profiles_from_entities(self, entities, use_llm, **kwargs):
            assert use_llm is False
            calls.append(("profiles", [entity.uuid for entity in entities]))
            return [{"user_id": index} for index, entity in enumerate(entities)]
        def save_profiles(self, profiles, file_path, platform):
            assert platform == "reddit"
            with open(file_path, "w") as stream:
                json.dump(profiles, stream)
    class Configuration:
        def generate_config(self, entities, **kwargs):
            calls.append(("configuration", [entity.uuid for entity in entities]))
            config = {"agent_configs": [{"agent_id": index, "entity_uuid": entity.uuid}
                                        for index, entity in enumerate(entities)],
                      "time_config": {"total_simulation_hours": 3, "minutes_per_round": 30}}
            return SimpleNamespace(to_json=lambda: json.dumps(config), generation_reasoning="Synthetic configuration")
    monkeypatch.setattr(manager_module, "OasisProfileGenerator", Profiles)
    monkeypatch.setattr(manager_module, "SimulationConfigGenerator", Configuration)
    response = post(local, selected_entity_ids=["node_9", "node_3"])
    assert response.status_code == 200
    threads[0].target()
    assert calls == [("profiles", ["node_9", "node_3"]), ("configuration", ["node_9", "node_3"])]
    assert TaskManager().get_task(response.json["data"]["task_id"]).status.value == "completed"
    data = plan(local).json["data"]
    assert data["can_reuse"] is True
    assert data["prepared"]["info"]["entities_count"] == 2


def test_legacy_local_early_failure_releases_claim(local):
    from app.services import preparation_plan as service
    write_state(local)
    response = local.client.post("/api/simulation/prepare", json={"simulation_id": "sim_fixture"})
    assert response.status_code == 404
    assert not service.active_prepare_tasks("sim_fixture")


def test_cloud_planned_mode_is_unsupported_without_storage_work(local, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    response = post(local)
    assert response.status_code == 403
    assert response.json["error_code"] == "local_mode_required"
    assert not local.root.exists()


def test_reuse_reconciles_failed_preparation_without_rewriting_historical_run(local):
    folder = write_prepared(local, "failed")
    path = folder / "state.json"
    state = json.loads(path.read_text())
    state["error"] = "Old preparation error"
    path.write_text(json.dumps(state))
    run = folder / "run_state.json"
    run.write_text(json.dumps({"simulation_id": "sim_fixture", "runner_status": "failed", "error": "Old run error"}))
    before = run.read_bytes()
    response = local.client.post("/api/simulation/prepare", json={
        "simulation_id": "sim_fixture", "preparation_mode": "reuse"})
    assert response.status_code == 200
    assert response.json["data"]["prepare_info"]["status"] == "ready"
    state = json.loads(path.read_text())
    assert state["status"] == "ready"
    assert state["error"] is None
    assert run.read_bytes() == before


@pytest.mark.parametrize("key,value", [("config_generated", "false"), ("profiles_generated", 1),
                                       ("enable_reddit", "true")])
def test_invalid_saved_flags_cannot_admit_new_generation(local, key, value):
    write_state(local, **{key: value})
    response = post(local)
    assert response.status_code == 409
    assert response.json["error_code"] == "invalid_artifacts"
    assert TaskManager._instance is None


@pytest.mark.parametrize("operation", ["start", "stop"])
def test_local_start_preserves_runner_admission_error_code(local, monkeypatch, operation):
    from app.services.preparation_plan import PlanningError
    write_prepared(local)
    def refuse(*args, **kwargs):
        raise PlanningError("lifecycle_busy")
    monkeypatch.setattr(SimulationRunner, f"{operation}_simulation", refuse)
    response = local.client.post(f"/api/simulation/{operation}", json={"simulation_id": "sim_fixture", "max_rounds": 1})
    assert response.status_code == 409
    assert response.json["error_code"] == "lifecycle_busy"


def test_no_content_length_request_read_is_still_bounded():
    from app.services.preparation_plan import read_request, PlanningError, MAX_REQUEST_BYTES
    class Stream:
        def read(self, count):
            assert count == MAX_REQUEST_BYTES + 1
            return b" " * count
    with pytest.raises(PlanningError) as failure:
        read_request(SimpleNamespace(query_string=b"", mimetype="application/json",
                                     content_length=None, stream=Stream()))
    assert failure.value.code == "request_too_large"
