"""Platform admission through real Flask routes and disposable runner artifacts."""

import csv
import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from flask import Flask
import pytest

from app import local_runtime
from app.api import simulation as api
from app.config import Config
from app.models.task import TaskManager
from app.services import preparation_plan
from app.services import simulation_runner as runner_module
from app.services.simulation_manager import SimulationManager, SimulationStatus
from app.services.simulation_runner import SimulationRunner as Runner
from app.services.zep_graph_memory_updater import ZepGraphMemoryManager


MODES = [(True, False, "twitter"), (False, True, "reddit"), (True, True, "parallel")]
INVALID_FLAGS = [None, "false", 0, 1, [], {}, 1.0]


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 10)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", 5)
    monkeypatch.setattr(Config, "OASIS_SIMULATION_DATA_DIR", str(root))
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(root))
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(root))
    for name in ("_run_states", "_processes", "_monitor_threads", "_action_queues",
                 "_stdout_files", "_stderr_files", "_graph_memory_enabled", "_finalization_locks"):
        monkeypatch.setattr(Runner, name, {})
    monkeypatch.setattr(Runner, "_manual_stop_requests", set())
    monkeypatch.setattr(TaskManager, "_instance", None)
    monkeypatch.setattr(ZepGraphMemoryManager, "_updaters", {})
    monkeypatch.setattr(local_runtime, "child_environment", lambda: {})
    monkeypatch.setattr(api.ProjectManager, "get_project", lambda _: SimpleNamespace(graph_id="graph_fixture"))
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    yield SimpleNamespace(root=root, client=app.test_client())
    for stream in Runner._stdout_files.values():
        if stream is not None:
            stream.close()


def create(sandbox, flags=None):
    response = sandbox.client.post("/api/simulation/create", json={
        "project_id": "proj_fixture", **(flags or {}),
    })
    assert response.status_code == 200, response.json
    return response.json["data"]["simulation_id"]


def ready(sandbox, twitter=True, reddit=True, status=SimulationStatus.READY):
    simulation_id = create(sandbox, {"enable_twitter": twitter, "enable_reddit": reddit})
    manager = SimulationManager()
    state = manager.get_simulation(simulation_id)
    state.status = status
    state.config_generated = state.profiles_generated = True
    state.profiles_count = state.entities_count = 1
    manager._save_simulation_state(state)
    folder = sandbox.root / simulation_id
    (folder / "simulation_config.json").write_text(json.dumps({
        "agent_configs": [{"agent_id": 0}],
        "time_config": {"total_simulation_hours": 1, "minutes_per_round": 30},
    }))
    if reddit:
        (folder / "reddit_profiles.json").write_text('[{"user_id": 0, "name": "Agent"}]')
    if twitter:
        with (folder / "twitter_profiles.csv").open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["user_id", "name", "description", "user_char"])
            writer.writeheader()
            writer.writerow({"user_id": 0, "name": "Agent", "description": "Bio", "user_char": "Persona"})
    return simulation_id, folder


def synthetic_process(monkeypatch):
    commands = []

    class Monitor:
        def __init__(self, **kwargs):
            pass

        def start(self):
            pass

        def is_alive(self):
            return False

    def spawn(command, **kwargs):
        commands.append(command)
        return SimpleNamespace(pid=12345, poll=lambda: None)

    monkeypatch.setattr(runner_module.subprocess, "Popen", spawn)
    monkeypatch.setattr(runner_module.threading, "Thread", Monitor)
    return commands


def prohibit_effects(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("a rejected platform reached a destructive/resource effect")

    for name in ("stop_simulation", "cleanup_simulation_logs", "_save_run_state"):
        monkeypatch.setattr(Runner, name, forbidden)
    monkeypatch.setattr(SimulationManager, "_save_simulation_state", forbidden)
    monkeypatch.setattr(ZepGraphMemoryManager, "create_updater", forbidden)
    monkeypatch.setattr(runner_module.subprocess, "Popen", forbidden)


def snapshot(folder):
    return {str(path.relative_to(folder)): path.read_bytes()
            for path in folder.rglob("*") if path.is_file()}


@pytest.mark.parametrize("flags,expected", [({}, (True, True)),
    *[({"enable_twitter": twitter, "enable_reddit": reddit}, (twitter, reddit))
      for twitter, reddit, _ in MODES]])
def test_create_persists_exact_selection_and_keeps_omitted_default(sandbox, flags, expected):
    simulation_id = create(sandbox, flags)
    raw = json.loads((sandbox.root / simulation_id / "state.json").read_text())
    assert (raw["enable_twitter"], raw["enable_reddit"]) == expected


@pytest.mark.parametrize("field", ["enable_twitter", "enable_reddit"])
@pytest.mark.parametrize("value", INVALID_FLAGS)
def test_create_rejects_non_boolean_flags_without_persistence(sandbox, field, value):
    response = sandbox.client.post("/api/simulation/create", json={
        "project_id": "proj_fixture", field: value,
    })
    assert response.status_code == 400, response.json
    assert not sandbox.root.exists() or list(sandbox.root.iterdir()) == []


def test_create_rejects_no_enabled_platform_without_persistence(sandbox):
    response = sandbox.client.post("/api/simulation/create", json={
        "project_id": "proj_fixture", "enable_twitter": False, "enable_reddit": False,
    })
    assert response.status_code == 400, response.json
    assert not sandbox.root.exists() or list(sandbox.root.iterdir()) == []


@pytest.mark.parametrize("flags", [(False, False), *[(value, True) for value in INVALID_FLAGS],
                                  *[(True, value) for value in INVALID_FLAGS]])
def test_manager_rejects_invalid_flags_before_saving(sandbox, flags):
    manager = SimulationManager()
    with pytest.raises(ValueError):
        manager.create_simulation("proj_fixture", "graph_fixture", *flags)
    assert list(sandbox.root.iterdir()) == []
    assert manager._simulations == {}


@pytest.mark.parametrize("local", [False, True])
@pytest.mark.parametrize("twitter,reddit,mode", MODES)
def test_create_prepared_reuse_auto_starts_only_enabled_script(sandbox, monkeypatch, local, twitter, reddit, mode):
    monkeypatch.setattr(Config, "LOCAL_MODE", local)
    simulation_id, folder = ready(sandbox, twitter, reddit)
    prepared = sandbox.client.post("/api/simulation/prepare", json={"simulation_id": simulation_id})
    assert prepared.status_code == 200, prepared.json
    assert prepared.json["data"]["already_prepared"] is True
    commands = synthetic_process(monkeypatch)
    response = sandbox.client.post("/api/simulation/start", json={
        "simulation_id": simulation_id, "platform": "auto",
    })
    assert response.status_code == 200, response.json
    assert response.json["data"]["platform"] == mode
    assert response.json["data"]["twitter_running"] is twitter
    assert response.json["data"]["reddit_running"] is reddit
    assert len(commands) == 1
    assert Path(commands[0][1]).name == f"run_{mode}_simulation.py"
    assert (folder / "twitter_profiles.csv").exists() is twitter
    assert (folder / "reddit_profiles.json").exists() is reddit
    assert "platform" not in json.loads((folder / "run_state.json").read_text())


@pytest.mark.parametrize("requested,mode", [(None, "parallel"), ("twitter", "twitter"),
                                           ("reddit", "reddit"), ("parallel", "parallel")])
def test_api_keeps_omitted_parallel_default_and_explicit_enabled_modes(sandbox, monkeypatch, requested, mode):
    simulation_id, _ = ready(sandbox)
    commands = synthetic_process(monkeypatch)
    body = {"simulation_id": simulation_id}
    if requested is not None:
        body["platform"] = requested
    response = sandbox.client.post("/api/simulation/start", json=body)
    assert response.status_code == 200, response.json
    assert response.json["data"]["platform"] == mode
    assert Path(commands[0][1]).name == f"run_{mode}_simulation.py"


@pytest.mark.parametrize("twitter,reddit,requested", [
    (True, False, "reddit"), (False, True, "twitter"),
    (True, False, "parallel"), (False, True, "parallel"),
    (True, True, "unknown"), (True, True, None), (True, True, []), (True, True, {}),
])
def test_api_rejects_disabled_or_invalid_mode_before_force_effects(sandbox, monkeypatch, twitter, reddit, requested):
    simulation_id, folder = ready(sandbox, twitter, reddit, SimulationStatus.COMPLETED)
    (folder / "simulation.log").write_text("keep the previous log")
    before = snapshot(folder)
    prohibit_effects(monkeypatch)
    response = sandbox.client.post("/api/simulation/start", json={
        "simulation_id": simulation_id, "platform": requested,
        "force": True, "enable_graph_memory_update": True,
    })
    assert response.status_code == 400, response.json
    assert snapshot(folder) == before


@pytest.mark.parametrize("updates", [{"enable_twitter": value} for value in INVALID_FLAGS]
                         + [{"enable_reddit": value} for value in INVALID_FLAGS]
                         + [{"enable_twitter": False, "enable_reddit": False}])
@pytest.mark.parametrize("mode", ["auto", "parallel"])
def test_api_rejects_invalid_saved_flags_before_state_mutation(sandbox, monkeypatch, updates, mode):
    simulation_id, folder = ready(sandbox, status=SimulationStatus.COMPLETED)
    path = folder / "state.json"
    raw = json.loads(path.read_text())
    raw.update(updates)
    path.write_text(json.dumps(raw))
    before = snapshot(folder)
    prohibit_effects(monkeypatch)
    response = sandbox.client.post("/api/simulation/start", json={
        "simulation_id": simulation_id, "platform": mode, "force": True,
        "enable_graph_memory_update": True,
    })
    assert response.status_code == 400, response.json
    assert snapshot(folder) == before


@pytest.mark.parametrize("payload", ["null", "[]", "invalid json", '{"simulation_id":"sim_another"}',
                                    '{"enable_twitter":null}', '{"enable_reddit":1}',
                                    '{"enable_twitter":false,"enable_reddit":false}'])
def test_direct_runner_rejects_invalid_saved_metadata_without_effects(sandbox, monkeypatch, payload):
    simulation_id, folder = ready(sandbox)
    (folder / "state.json").write_text(payload)
    before = snapshot(folder)
    prohibit_effects(monkeypatch)
    with pytest.raises(ValueError):
        Runner.start_simulation(simulation_id, platform="parallel",
                                enable_graph_memory_update=True, graph_id="graph_fixture")
    assert snapshot(folder) == before


@pytest.mark.parametrize("payload", ["null", "[]", '{"simulation_id":"sim_another","status":"completed","config_generated":true}'])
def test_api_rejects_invalid_metadata_before_forced_cleanup(sandbox, monkeypatch, payload):
    simulation_id, folder = ready(sandbox)
    (folder / "state.json").write_text(payload)
    before = snapshot(folder)
    prohibit_effects(monkeypatch)
    response = sandbox.client.post("/api/simulation/start", json={
        "simulation_id": simulation_id, "platform": "auto", "force": True,
    })
    assert response.status_code == 400, response.json
    assert snapshot(folder) == before


@pytest.mark.parametrize("manager_metadata", [True, False])
def test_direct_runner_metadata_uses_manager_root_before_relocated_run_root(sandbox, tmp_path, monkeypatch, manager_metadata):
    simulation_id, folder = ready(sandbox, True, False)
    run_root = tmp_path / "relocated_runs"
    run_folder = run_root / simulation_id
    run_folder.mkdir(parents=True)
    (run_folder / "simulation_config.json").write_bytes((folder / "simulation_config.json").read_bytes())
    (run_folder / "state.json").write_text(json.dumps({
        "simulation_id": simulation_id, "enable_twitter": False, "enable_reddit": True,
    }))
    if not manager_metadata:
        (folder / "state.json").unlink()
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(run_root))
    commands = synthetic_process(monkeypatch)
    Runner.start_simulation(simulation_id, platform="auto")
    mode = "twitter" if manager_metadata else "reddit"
    assert Path(commands[0][1]).name == f"run_{mode}_simulation.py"


@pytest.mark.parametrize("route", ["/profiles", "/profiles/realtime"])
def test_twitter_profiles_use_configured_manager_root_and_common_aliases(sandbox, monkeypatch, tmp_path, route):
    simulation_id, _ = ready(sandbox, True, False)
    monkeypatch.setattr(Config, "OASIS_SIMULATION_DATA_DIR", str(tmp_path / "unrelated"))
    response = sandbox.client.get(f"/api/simulation/{simulation_id}{route}")
    assert response.status_code == 200, response.json
    profile = response.json["data"]["profiles"][0]
    assert profile["bio"] == profile["description"] == "Bio"
    assert profile["persona"] == profile["user_char"] == "Persona"
    assert "age" not in profile


@pytest.mark.parametrize("mode", ["unknown", None, [], {}, True, 1])
def test_direct_runner_rejects_invalid_mode_before_any_effect(sandbox, monkeypatch, mode):
    simulation_id, folder = ready(sandbox)
    before = snapshot(folder)
    prohibit_effects(monkeypatch)
    with pytest.raises(ValueError, match="platform"):
        Runner.start_simulation(simulation_id, platform=mode,
                                enable_graph_memory_update=True, graph_id="graph_fixture")
    assert snapshot(folder) == before


@pytest.mark.parametrize("local", [False, True])
@pytest.mark.parametrize("twitter,reddit,mode", MODES)
def test_direct_runner_resolves_auto_from_saved_flags(sandbox, monkeypatch, local, twitter, reddit, mode):
    monkeypatch.setattr(Config, "LOCAL_MODE", local)
    simulation_id, _ = ready(sandbox, twitter, reddit)
    commands = synthetic_process(monkeypatch)
    state = Runner.start_simulation(simulation_id, platform="auto")
    assert (state.twitter_running, state.reddit_running) == (twitter, reddit)
    assert Path(commands[0][1]).name == f"run_{mode}_simulation.py"


@pytest.mark.parametrize("mode", ["twitter", "reddit", "parallel"])
def test_direct_runner_keeps_legacy_explicit_config_only_modes(sandbox, monkeypatch, mode):
    simulation_id, folder = ready(sandbox)
    (folder / "state.json").unlink()
    commands = synthetic_process(monkeypatch)
    Runner.start_simulation(simulation_id, platform=mode)
    assert Path(commands[0][1]).name == f"run_{mode}_simulation.py"


def test_direct_auto_requires_persisted_metadata(sandbox, monkeypatch):
    simulation_id, folder = ready(sandbox)
    (folder / "state.json").unlink()
    before = snapshot(folder)
    prohibit_effects(monkeypatch)
    with pytest.raises(ValueError, match="auto"):
        Runner.start_simulation(simulation_id, platform="auto")
    assert snapshot(folder) == before


@pytest.mark.parametrize("local", [False, True])
def test_runner_rechecks_saved_flags_under_existing_admission(sandbox, monkeypatch, local):
    monkeypatch.setattr(Config, "LOCAL_MODE", local)
    simulation_id, folder = ready(sandbox)
    original_lock = Runner._finalization_lock(simulation_id)
    path = folder / "state.json"

    @contextmanager
    def changed_at_admission(*args):
        with original_lock:
            raw = json.loads(path.read_text())
            raw["enable_reddit"] = False
            path.write_text(json.dumps(raw))
            yield

    if local:
        monkeypatch.setattr(preparation_plan, "admission_lock", changed_at_admission)
    else:
        monkeypatch.setattr(Runner, "_finalization_lock", changed_at_admission)
    prohibit_effects(monkeypatch)
    with pytest.raises(ValueError, match="disabled"):
        Runner.start_simulation(simulation_id, platform="reddit")
    assert not (folder / "run_state.json").exists()


@pytest.mark.parametrize("mode", ["twitter", "reddit", "parallel", "auto"])
def test_missing_legacy_saved_flags_keep_dual_defaults(sandbox, monkeypatch, mode):
    simulation_id, folder = ready(sandbox)
    path = folder / "state.json"
    raw = json.loads(path.read_text())
    del raw["enable_twitter"], raw["enable_reddit"]
    path.write_text(json.dumps(raw))
    commands = synthetic_process(monkeypatch)
    response = sandbox.client.post("/api/simulation/start", json={"simulation_id": simulation_id, "platform": mode})
    assert response.status_code == 200, response.json
    assert Path(commands[0][1]).name == f"run_{'parallel' if mode == 'auto' else mode}_simulation.py"
