"""Runner admission against synthetic preparation owners and disposable files."""

import builtins
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from app.config import Config
from app import local_runtime
from app.models.task import TaskManager, TaskStatus
from app.services import preparation_plan
from app.services import simulation_runner as module
from app.services.simulation_runner import RunnerStatus, SimulationRunner as Runner, SimulationRunState
from app.services.zep_graph_memory_updater import ZepGraphMemoryManager


SIMULATION_ID = "sim_preparation_owner"


@pytest.fixture
def runner(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    folder = root / SIMULATION_ID
    folder.mkdir(parents=True)
    config = folder / "simulation_config.json"
    config.write_text(json.dumps({
        "agent_configs": [{"agent_id": 0}],
        "time_config": {"total_simulation_hours": 8, "minutes_per_round": 30},
    }))
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "run_reddit_simulation.py").write_text("pass\n")
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 10)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", 5)
    monkeypatch.setattr(TaskManager, "_instance", None)
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(root))
    monkeypatch.setattr(Runner, "SCRIPTS_DIR", str(scripts))
    for name in ("_run_states", "_processes", "_monitor_threads", "_action_queues",
                 "_stdout_files", "_stderr_files", "_graph_memory_enabled", "_finalization_locks"):
        monkeypatch.setattr(Runner, name, {})
    monkeypatch.setattr(Runner, "_manual_stop_requests", set())
    monkeypatch.setattr(ZepGraphMemoryManager, "_updaters", {})
    monkeypatch.setattr(ZepGraphMemoryManager, "_lock", threading.Lock())
    monkeypatch.setattr(local_runtime, "child_environment", lambda: {})
    monkeypatch.setattr(Runner, "_sync_simulation_status", lambda *args, **kwargs: None)
    yield SimpleNamespace(root=root, folder=folder, config=config)
    for stream in Runner._stdout_files.values():
        if stream is not None:
            stream.close()


def prepare_task(status=TaskStatus.PENDING, simulation_id=SIMULATION_ID,
                 task_type="simulation_prepare"):
    manager = TaskManager()
    task_id = manager.create_task(task_type, {"simulation_id": simulation_id})
    manager.update_task(task_id, status=status)
    return task_id


def saved_state(status):
    state = SimulationRunState(SIMULATION_ID, runner_status=status)
    Runner._save_run_state(state)
    return state


def snapshot(folder):
    return {path.name: path.read_bytes() for path in folder.iterdir() if path.is_file()}


def synthetic_start(monkeypatch, *, on_spawn=None):
    class Process:
        pid = 12345

        def poll(self):
            return None

    class Monitor:
        def __init__(self, **kwargs):
            self.started = False

        def start(self):
            self.started = True

        def is_alive(self):
            return self.started

    def spawn(*args, **kwargs):
        if on_spawn:
            on_spawn()
        return Process()

    monkeypatch.setattr(module.subprocess, "Popen", spawn)
    monkeypatch.setattr(module.threading, "Thread", Monitor)


@pytest.mark.parametrize("status", [TaskStatus.PENDING, TaskStatus.PROCESSING])
def test_preparation_blocks_start_before_configuration_read_or_spawn(runner, monkeypatch, status):
    previous = saved_state(RunnerStatus.STOPPED)
    prepare_task(status)
    before = snapshot(runner.folder)
    original_open = builtins.open

    def guarded_open(path, *args, **kwargs):
        if Path(path) == runner.config:
            pytest.fail("active preparation must block configuration reads")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", guarded_open)
    monkeypatch.setattr(preparation_plan, "_read_json",
                        lambda *a: pytest.fail("active preparation must block configuration reads"))
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **k: pytest.fail("child spawned"))
    monkeypatch.setattr(ZepGraphMemoryManager, "create_updater",
                        lambda *a, **k: pytest.fail("updater started"))
    with pytest.raises(preparation_plan.PlanningError, match="preparation") as rejected:
        Runner.start_simulation(SIMULATION_ID, platform="reddit",
                                enable_graph_memory_update=True, graph_id="graph_fixture")
    assert rejected.value.code == "preparation_busy"
    assert rejected.value.status_code == 409
    assert Runner._run_states[SIMULATION_ID] is previous
    assert Runner._graph_memory_enabled == Runner._processes == Runner._action_queues == {}
    assert snapshot(runner.folder) == before


@pytest.mark.parametrize("status", [TaskStatus.PENDING, TaskStatus.PROCESSING])
def test_preparation_blocks_stop_before_state_or_process_mutation(runner, monkeypatch, status):
    state = saved_state(RunnerStatus.RUNNING)
    prepare_task(status)
    before = snapshot(runner.folder)
    Runner._processes[SIMULATION_ID] = SimpleNamespace(poll=lambda: None)
    monkeypatch.setattr(Runner, "_terminate_process", lambda *a: pytest.fail("process terminated"))
    with pytest.raises(preparation_plan.PlanningError, match="preparation") as rejected:
        Runner.stop_simulation(SIMULATION_ID)
    assert rejected.value.code == "preparation_busy"
    assert rejected.value.status_code == 409
    assert state.runner_status is RunnerStatus.RUNNING
    assert Runner._manual_stop_requests == set()
    assert snapshot(runner.folder) == before


@pytest.mark.parametrize("status", [TaskStatus.PENDING, TaskStatus.PROCESSING])
def test_preparation_blocks_cleanup_before_deletion_or_cache_mutation(runner, status):
    state = saved_state(RunnerStatus.STOPPED)
    (runner.folder / "simulation.log").write_text("existing log")
    prepare_task(status)
    before = snapshot(runner.folder)
    result = Runner.cleanup_simulation_logs(SIMULATION_ID)
    assert result["success"] is False
    assert result["cleaned_files"] == []
    assert "preparation" in result["errors"][0]
    assert Runner._run_states[SIMULATION_ID] is state
    assert snapshot(runner.folder) == before


def test_start_reads_configuration_and_constructs_claim_under_ownership_lock(runner, monkeypatch):
    lock = Runner._finalization_lock(SIMULATION_ID)
    original_open = builtins.open
    original_state = module.SimulationRunState
    original_read_json = preparation_plan._read_json

    def locked_read_json(*args):
        assert lock.locked(), "configuration read must share preparation's lock"
        return original_read_json(*args)

    def locked_open(path, *args, **kwargs):
        if Path(path) == runner.config:
            assert lock.locked(), "configuration read must share preparation's lock"
        return original_open(path, *args, **kwargs)

    def locked_state(*args, **kwargs):
        assert lock.locked(), "run-state construction must follow the locked configuration read"
        return original_state(*args, **kwargs)

    def startup_outside_lock(*args):
        assert lock.acquire(blocking=False), "startup must release the ownership lock"
        try:
            persisted = json.loads((runner.folder / "run_state.json").read_text())
            assert persisted["runner_status"] == "starting"
            assert persisted["total_rounds"] == 5
        finally:
            lock.release()

    monkeypatch.setattr(builtins, "open", locked_open)
    monkeypatch.setattr(preparation_plan, "_read_json", locked_read_json)
    monkeypatch.setattr(module, "SimulationRunState", locked_state)
    monkeypatch.setattr(ZepGraphMemoryManager, "create_updater", startup_outside_lock)
    synthetic_start(monkeypatch, on_spawn=startup_outside_lock)
    state = Runner.start_simulation(SIMULATION_ID, platform="reddit",
                                    enable_graph_memory_update=True, graph_id="graph_fixture")
    assert state.runner_status is RunnerStatus.RUNNING
    assert state.total_rounds == 5
    assert state.reddit_running is True
    assert TaskManager._instance is None


def test_local_start_rejects_held_lock_without_waiting_or_reading_configuration(runner, monkeypatch):
    lock = Runner._finalization_lock(SIMULATION_ID)
    finished = threading.Event()
    outcomes = []

    def start():
        try:
            Runner.start_simulation(SIMULATION_ID, platform="reddit")
        except BaseException as error:
            outcomes.append(error)
        finally:
            finished.set()

    monkeypatch.setattr(preparation_plan, "_read_json", lambda *a: pytest.fail("configuration read"))
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **k: pytest.fail("child spawned"))
    worker = threading.Thread(target=start, daemon=True)
    lock.acquire()
    try:
        worker.start()
        returned_while_locked = finished.wait(1)
    finally:
        lock.release()
        worker.join(2)
    assert returned_while_locked
    assert not worker.is_alive()
    assert len(outcomes) == 1 and isinstance(outcomes[0], preparation_plan.PlanningError)
    assert outcomes[0].code == "lifecycle_busy"
    assert not (runner.folder / "run_state.json").exists()


def test_cloud_start_still_waits_for_ownership_lock(runner, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    lock = Runner._finalization_lock(SIMULATION_ID)
    waiting = threading.Event()
    finished = threading.Event()
    outcomes = []
    original_open = builtins.open

    class ObservedLock:
        def __enter__(self):
            waiting.set()
            lock.acquire()

        def __exit__(self, *args):
            lock.release()

    def observe_open(path, *args, **kwargs):
        if Path(path) == runner.config:
            raise ValueError("configuration read after lock release")
        return original_open(path, *args, **kwargs)

    def start():
        try:
            Runner.start_simulation(SIMULATION_ID, platform="reddit")
        except BaseException as error:
            outcomes.append(error)
        finally:
            finished.set()

    monkeypatch.setattr(Runner, "_finalization_lock", lambda sid: ObservedLock())
    monkeypatch.setattr(builtins, "open", observe_open)
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **k: pytest.fail("child spawned"))
    worker = threading.Thread(target=start, daemon=True)
    lock.acquire()
    try:
        worker.start()
        assert waiting.wait(2), "start never reached the ownership boundary"
        assert not finished.is_set()
    finally:
        lock.release()
        worker.join(2)
    assert not worker.is_alive()
    assert len(outcomes) == 1 and isinstance(outcomes[0], ValueError)
    assert str(outcomes[0]) == "configuration read after lock release"
    assert not (runner.folder / "run_state.json").exists()


@pytest.mark.parametrize("kind", ["oversized", "linked_file", "linked_directory"])
def test_local_start_rejects_unsafe_or_oversized_configuration_before_claim(runner, monkeypatch, kind):
    previous = saved_state(RunnerStatus.STOPPED)
    run_state = (runner.folder / "run_state.json").read_bytes()
    if kind == "oversized":
        with runner.config.open("ab") as stream:
            stream.write(b" " * preparation_plan.MAX_ARTIFACT_BYTES)
    else:
        target = runner.root / "external"
        original = runner.config if kind == "linked_file" else runner.folder
        original.rename(target)
        try:
            original.symlink_to(target, target_is_directory=kind == "linked_directory")
        except (OSError, NotImplementedError):
            pytest.skip("symlinks unavailable")
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **k: pytest.fail("child spawned"))
    with pytest.raises(preparation_plan.PlanningError) as rejected:
        Runner.start_simulation(SIMULATION_ID, platform="reddit")
    assert rejected.value.code == {
        "oversized": "source_too_large", "linked_file": "unsafe_path",
        "linked_directory": "ownership_unavailable",
    }[kind]
    assert Runner._run_states[SIMULATION_ID] is previous
    assert (runner.folder / "run_state.json").read_bytes() == run_state
    assert Runner._processes == Runner._action_queues == Runner._graph_memory_enabled == {}


def test_cloud_config_reader_preserves_legacy_link_and_size_behavior(runner, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    target = runner.root / "external.json"
    runner.config.rename(target)
    try:
        runner.config.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")
    with target.open("ab") as stream:
        stream.write(b" " * preparation_plan.MAX_ARTIFACT_BYTES)
    synthetic_start(monkeypatch)
    state = Runner.start_simulation(SIMULATION_ID, platform="reddit")
    assert state.runner_status is RunnerStatus.RUNNING
    assert state.total_rounds == 16


@pytest.mark.parametrize("kind", ["malformed", "unreadable", "oversized"])
def test_local_start_refuses_unverifiable_run_state_before_configuration(runner, monkeypatch, kind):
    path = runner.folder / "run_state.json"
    path.write_text('{"runner_status":"stopped"}')
    if kind == "malformed":
        path.write_text("{invalid")
    elif kind == "oversized":
        with path.open("ab") as stream:
            stream.write(b" " * preparation_plan.MAX_STATE_BYTES)
    else:
        original_open = preparation_plan.saved._open_source

        def unreadable(source):
            if Path(source) == path:
                raise PermissionError("synthetic unreadable run state")
            return original_open(source)

        monkeypatch.setattr(preparation_plan.saved, "_open_source", unreadable)
    before = snapshot(runner.folder)
    original_read = preparation_plan._read_json

    def read_state_only(source, maximum):
        assert Path(source) != runner.config, "configuration read before verifying ownership"
        return original_read(source, maximum)

    monkeypatch.setattr(preparation_plan, "_read_json", read_state_only)
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **k: pytest.fail("child spawned"))
    with pytest.raises(preparation_plan.PlanningError) as rejected:
        Runner.start_simulation(SIMULATION_ID, platform="reddit")
    assert rejected.value.code == "ownership_unavailable"
    assert rejected.value.status_code == 409
    assert snapshot(runner.folder) == before
    assert Runner._run_states == Runner._processes == Runner._action_queues == {}


def test_local_start_refuses_busy_updater_lock_before_configuration(runner, monkeypatch):
    lock = ZepGraphMemoryManager._lock
    finished = threading.Event()
    outcomes = []
    config_reads = []
    original_read = preparation_plan._read_json

    def observe_read(path, maximum):
        if Path(path) == runner.config:
            config_reads.append(path)
        return original_read(path, maximum)

    def start():
        try:
            Runner.start_simulation(SIMULATION_ID, platform="reddit")
        except BaseException as error:
            outcomes.append(error)
        finally:
            finished.set()

    monkeypatch.setattr(preparation_plan, "_read_json", observe_read)
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **k: pytest.fail("child spawned"))
    worker = threading.Thread(target=start, daemon=True)
    lock.acquire()
    try:
        worker.start()
        returned_while_locked = finished.wait(1)
    finally:
        lock.release()
        worker.join(2)
    assert returned_while_locked
    assert not worker.is_alive()
    assert len(outcomes) == 1 and isinstance(outcomes[0], preparation_plan.PlanningError)
    assert outcomes[0].code == "ownership_unavailable"
    assert config_reads == []
    assert not (runner.folder / "run_state.json").exists()


def test_local_start_does_not_repeat_legacy_owner_reads(runner, monkeypatch):
    saved_state(RunnerStatus.STOPPED)
    Runner._run_states.clear()
    monkeypatch.setattr(Runner, "get_run_state", lambda *a: pytest.fail("legacy run-state read"))
    monkeypatch.setattr(ZepGraphMemoryManager, "get_updater",
                        lambda *a: pytest.fail("blocking updater read"))
    synthetic_start(monkeypatch)
    state = Runner.start_simulation(SIMULATION_ID, platform="reddit")
    assert state.runner_status is RunnerStatus.RUNNING


@pytest.mark.parametrize("operation", ["start", "stop", "cleanup"])
@pytest.mark.parametrize("owner", ["completed", "failed", "other_simulation", "other_task", "cloud"])
def test_nonowning_tasks_preserve_runner_operations(runner, monkeypatch, operation, owner):
    if owner in {"completed", "failed"}:
        prepare_task(TaskStatus(owner))
    elif owner == "other_simulation":
        prepare_task(simulation_id="sim_elsewhere")
    elif owner == "other_task":
        prepare_task(task_type="graph_build")
    else:
        prepare_task()
        monkeypatch.setattr(Config, "LOCAL_MODE", False)
    if operation == "start":
        synthetic_start(monkeypatch)
        state = Runner.start_simulation(SIMULATION_ID, platform="reddit")
        assert state.runner_status is RunnerStatus.RUNNING
        assert state.total_rounds == (16 if owner == "cloud" else 5)
    elif operation == "stop":
        saved_state(RunnerStatus.RUNNING)
        state = Runner.stop_simulation(SIMULATION_ID)
        assert state.runner_status is RunnerStatus.STOPPED
    else:
        saved_state(RunnerStatus.STOPPED)
        result = Runner.cleanup_simulation_logs(SIMULATION_ID)
        assert result["success"] is True
        assert not (runner.folder / "run_state.json").exists()
        assert runner.config.exists()


@pytest.mark.parametrize("status", [RunnerStatus.STARTING, RunnerStatus.RUNNING,
                                    RunnerStatus.PAUSED, RunnerStatus.STOPPING])
def test_existing_run_claim_still_blocks_start(runner, monkeypatch, status):
    state = saved_state(status)
    before = snapshot(runner.folder)
    monkeypatch.setattr(module.subprocess, "Popen", lambda *a, **k: pytest.fail("child spawned"))
    with pytest.raises(preparation_plan.PlanningError) as rejected:
        Runner.start_simulation(SIMULATION_ID, platform="reddit")
    assert rejected.value.code == "run_busy"
    assert Runner._run_states[SIMULATION_ID] is state
    assert snapshot(runner.folder) == before
    assert TaskManager._instance is None
