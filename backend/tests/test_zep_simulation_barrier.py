from types import SimpleNamespace
import json
import threading

import pytest
from flask import Flask

from app.api import simulation as simulation_api
from app import local_runtime
from app.config import Config
from app.models.task import TaskManager
from app.services import preparation_cancellation, preparation_plan
from app.services import simulation_runner as runner_module
from app.services.simulation_manager import SimulationManager, SimulationState, SimulationStatus
from app.services.simulation_runner import (
    RunnerStatus,
    SimulationRunState,
    SimulationRunner,
    SimulationStopPending,
)


@pytest.fixture
def prepared_publication_run(tmp_path, monkeypatch):
    simulation_id = "sim_publication"
    root = tmp_path / "simulations"
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    # The runner only checks existence; executing this file is forbidden.
    (scripts / "run_parallel_simulation.py").write_text("raise AssertionError('must not run')\n")
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 10)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", 5)
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(root))
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(root))
    monkeypatch.setattr(SimulationRunner, "SCRIPTS_DIR", str(scripts))
    for name in (
        "_run_states", "_processes", "_monitor_threads", "_action_queues",
        "_stdout_files", "_stderr_files", "_graph_memory_enabled", "_finalization_locks",
    ):
        monkeypatch.setattr(SimulationRunner, name, {})
    monkeypatch.setattr(SimulationRunner, "_manual_stop_requests", set())
    monkeypatch.setattr(TaskManager, "_instance", None)
    monkeypatch.setattr(preparation_cancellation, "_controllers", {})
    monkeypatch.setattr(runner_module.ZepGraphMemoryManager, "_updaters", {})
    monkeypatch.setattr(runner_module.ZepGraphMemoryManager, "_lock", threading.Lock())

    def forbidden(*args, **kwargs):
        pytest.fail("unexpected child, monitor, graph updater, or local gateway execution")

    monkeypatch.setattr(runner_module.subprocess, "Popen", forbidden)
    monkeypatch.setattr(SimulationRunner, "_monitor_simulation", forbidden)
    monkeypatch.setattr(runner_module.ZepGraphMemoryManager, "create_updater", forbidden)
    monkeypatch.setattr(local_runtime, "get_local_gateway_url", forbidden)
    monkeypatch.setattr(local_runtime, "child_environment", forbidden)
    manager = SimulationManager()
    manager._save_simulation_state(SimulationState(
        simulation_id, "project_publication", "graph_publication",
        status=SimulationStatus.STOPPED, profiles_generated=True, config_generated=True,
    ))
    folder = root / simulation_id
    (folder / "simulation_config.json").write_text(json.dumps({
        "agent_configs": [{"agent_id": 0}],
        "time_config": {"total_simulation_hours": 1, "minutes_per_round": 30},
    }))
    (folder / "reddit_profiles.json").write_text('[{"user_id": 0}]')
    (folder / "twitter_profiles.csv").write_text("user_id,name\n0,Fixture\n")
    SimulationRunner._save_run_state(SimulationRunState(
        simulation_id, runner_status=RunnerStatus.STOPPED,
    ))
    SimulationRunner._run_states.clear()
    yield SimpleNamespace(simulation_id=simulation_id, folder=folder)
    for stream in SimulationRunner._stdout_files.values():
        if stream is not None:
            stream.close()


def test_default_start_requests_preserve_newer_claim_during_delayed_cold_load(
    prepared_publication_run, monkeypatch,
):
    run = prepared_publication_run
    # runner_module.threading and threading are the same module object.
    request_thread = threading.Thread
    old_read, release_old, claimed, release_start = (threading.Event() for _ in range(4))
    responses, errors, launches, monitors = {}, {}, [], []
    load = SimulationRunner._load_run_state
    app = Flask(__name__)

    def delayed_load(simulation_id):
        loaded = load(simulation_id)
        if threading.current_thread().name == "request-B" and not old_read.is_set():
            assert loaded.runner_status == RunnerStatus.STOPPED
            old_read.set()
            assert release_old.wait(5), "B's old disk snapshot was not released"
        return loaded

    def child_environment():
        if threading.current_thread().name == "request-A":
            assert SimulationRunner._run_states[run.simulation_id].runner_status == RunnerStatus.STARTING
            assert json.loads((run.folder / "run_state.json").read_text())["runner_status"] == "starting"
            assert not SimulationRunner._processes
            assert not SimulationRunner._monitor_threads
            assert not runner_module.ZepGraphMemoryManager._updaters
            claimed.set()
            assert release_start.wait(5), "A's STARTING claim was not released"
        return {}

    class Process:
        def __init__(self, pid):
            self.pid = pid

        def poll(self):
            return None

    def spawn(*args, **kwargs):
        assert len(launches) < 2, "unexpected third fake launch"
        process = Process(41000 + len(launches))
        launches.append((threading.current_thread().name, process, kwargs["stdout"]))
        return process

    class Monitor:
        def __init__(self, **kwargs):
            assert kwargs["target"] is SimulationRunner._monitor_simulation
            assert kwargs["args"][0] == run.simulation_id
            self.started = False
            monitors.append(self)

        def start(self):
            self.started = True

        def is_alive(self):
            return self.started

    def request_start(name):
        try:
            # Both flags and platform are omitted, exercising the actual defaults.
            with app.test_request_context("/api/simulation/start", method="POST", json={
                "simulation_id": run.simulation_id,
            }):
                response = app.make_response(simulation_api.start_simulation())
                responses[name] = (response.status_code, response.get_json())
        except BaseException as error:
            errors[name] = error

    monkeypatch.setattr(SimulationRunner, "_load_run_state", delayed_load)
    monkeypatch.setattr(local_runtime, "child_environment", child_environment)
    monkeypatch.setattr(runner_module.subprocess, "Popen", spawn)
    monkeypatch.setattr(runner_module.threading, "Thread", Monitor)
    a = request_thread(target=request_start, args=("A",), name="request-A", daemon=True)
    b = request_thread(target=request_start, args=("B",), name="request-B", daemon=True)
    started = []
    try:
        b.start()
        started.append(b)
        assert old_read.wait(5), "B did not read the real STOPPED disk snapshot"
        a.start()
        started.append(a)
        assert claimed.wait(5), "A did not publish STARTING before fake process creation"
        release_old.set()
        b.join(5)
        assert not b.is_alive(), "B did not finish while A was gated"
        assert errors == {}
        assert "B" in responses
        metadata_after_b = json.loads((run.folder / "state.json").read_text())["status"]
        release_start.set()
        a.join(5)
        assert not a.is_alive(), "A did not finish after release"
        assert errors == {}
        observed = [(name, process.pid) for name, process, _ in launches]
        assert len(launches) == 1, f"expected one fake launch; observed {len(launches)} fake launches: {observed}"
        assert responses["A"][0] == 200
        assert responses["A"][1]["data"]["graph_memory_update_enabled"] is False
        assert responses["A"][1]["data"]["force_restarted"] is False
        assert responses["B"][0] == 400
        assert "模拟已在运行或结束处理中" in responses["B"][1]["error"]
        # The route's pre-admission READY projection is a separate existing behavior.
        assert metadata_after_b == "ready"
        assert launches[0][0] == "request-A"
        assert len(monitors) == 1 and monitors[0].started
        assert SimulationRunner._processes == {run.simulation_id: launches[0][1]}
        assert SimulationRunner._monitor_threads == {run.simulation_id: monitors[0]}
    finally:
        release_old.set()
        release_start.set()
        for worker in started:
            worker.join(5)
        for _, _, stream in launches:
            stream.close()
        assert not any(worker.is_alive() for worker in started), "request thread leaked"


@pytest.mark.parametrize("status", [
    RunnerStatus.STARTING, RunnerStatus.RUNNING, RunnerStatus.PAUSED, RunnerStatus.STOPPING,
])
def test_cloud_start_rejects_current_active_status(prepared_publication_run, status):
    run = prepared_publication_run
    state = SimulationRunState(run.simulation_id, runner_status=status)
    SimulationRunner._save_run_state(state)
    before = (run.folder / "run_state.json").read_bytes()
    with pytest.raises(ValueError, match="模拟已在运行或结束处理中"):
        SimulationRunner.start_simulation(run.simulation_id)
    assert SimulationRunner._run_states[run.simulation_id] is state
    assert (run.folder / "run_state.json").read_bytes() == before
    assert not SimulationRunner._processes


def test_local_start_rejects_persisted_starting_with_cold_cache(
    prepared_publication_run, monkeypatch,
):
    run = prepared_publication_run
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    SimulationRunner._save_run_state(SimulationRunState(
        run.simulation_id, runner_status=RunnerStatus.STARTING,
    ))
    SimulationRunner._run_states.clear()
    before = (run.folder / "run_state.json").read_bytes()
    with pytest.raises(preparation_plan.PlanningError) as rejected:
        SimulationRunner.start_simulation(run.simulation_id)
    assert rejected.value.code == "run_busy"
    assert SimulationRunner._run_states == {}
    assert (run.folder / "run_state.json").read_bytes() == before
    assert not SimulationRunner._processes


def test_manual_stop_surfaces_graph_ingestion_failure(monkeypatch):
    state = SimulationRunState(
        simulation_id="sim-1",
        runner_status=RunnerStatus.RUNNING,
    )
    saved = []
    monkeypatch.setattr(
        SimulationRunner,
        "get_run_state",
        classmethod(lambda _cls, _simulation_id: state),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_save_run_state",
        classmethod(lambda _cls, value: saved.append(value.runner_status)),
    )
    monkeypatch.setattr(
        runner_module.ZepGraphMemoryManager,
        "stop_updater",
        classmethod(
            lambda _cls, _simulation_id: (_ for _ in ()).throw(
                RuntimeError("ingestion incomplete")
            )
        ),
    )
    SimulationRunner._processes.pop("sim-1", None)
    SimulationRunner._graph_memory_enabled["sim-1"] = True

    try:
        with pytest.raises(RuntimeError, match="ingestion incomplete"):
            SimulationRunner.stop_simulation("sim-1")

        assert state.runner_status == RunnerStatus.FAILED
        assert "ingestion incomplete" in state.error
        assert saved[-1] == RunnerStatus.FAILED
    finally:
        SimulationRunner._graph_memory_enabled.pop("sim-1", None)
        SimulationRunner._manual_stop_requests.discard("sim-1")


def test_platform_completion_does_not_publish_terminal_success_before_barrier(
    monkeypatch, tmp_path
):
    simulation_id = "sim-1"
    sim_dir = tmp_path / simulation_id / "twitter"
    sim_dir.mkdir(parents=True)
    log_path = sim_dir / "actions.jsonl"
    log_path.write_text(
        '{"event_type":"simulation_end","total_rounds":1,"total_actions":0}\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(tmp_path))
    state = SimulationRunState(
        simulation_id=simulation_id,
        runner_status=RunnerStatus.RUNNING,
        twitter_running=True,
    )

    SimulationRunner._read_action_log(str(log_path), 0, state, "twitter")

    assert state.twitter_completed is True
    assert state.runner_status == RunnerStatus.RUNNING


def test_manual_stop_timeout_leaves_monitor_owned_state_stopping(monkeypatch):
    state = SimulationRunState(
        simulation_id="sim-timeout",
        runner_status=RunnerStatus.RUNNING,
    )

    class Monitor:
        def join(self, timeout):
            assert timeout >= 30

        def is_alive(self):
            return True

    monkeypatch.setattr(
        SimulationRunner,
        "get_run_state",
        classmethod(lambda _cls, _simulation_id: state),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_save_run_state",
        classmethod(lambda _cls, _state: None),
    )
    SimulationRunner._monitor_threads["sim-timeout"] = Monitor()
    SimulationRunner._processes.pop("sim-timeout", None)
    SimulationRunner._graph_memory_enabled.pop("sim-timeout", None)

    try:
        with pytest.raises(TimeoutError, match="仍在停止中"):
            SimulationRunner.stop_simulation("sim-timeout")
        assert state.runner_status == RunnerStatus.STOPPING
    finally:
        SimulationRunner._monitor_threads.pop("sim-timeout", None)
        SimulationRunner._manual_stop_requests.discard("sim-timeout")


def test_failed_ingestion_finalization_can_be_retried(monkeypatch):
    state = SimulationRunState(
        simulation_id="sim-retry",
        runner_status=RunnerStatus.FAILED,
        error="first drain timed out",
    )
    monkeypatch.setattr(
        SimulationRunner,
        "get_run_state",
        classmethod(lambda _cls, _simulation_id: state),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_save_run_state",
        classmethod(lambda _cls, _state: None),
    )
    monkeypatch.setattr(
        runner_module.ZepGraphMemoryManager,
        "get_updater",
        classmethod(lambda _cls, _simulation_id: object()),
    )
    monkeypatch.setattr(
        runner_module.ZepGraphMemoryManager,
        "stop_updater",
        classmethod(lambda _cls, _simulation_id: None),
    )
    SimulationRunner._graph_memory_enabled["sim-retry"] = True
    SimulationRunner._monitor_threads.pop("sim-retry", None)

    try:
        result = SimulationRunner.stop_simulation("sim-retry")
        assert result.runner_status == RunnerStatus.STOPPED
        assert result.error is None
    finally:
        SimulationRunner._graph_memory_enabled.pop("sim-retry", None)
        SimulationRunner._manual_stop_requests.discard("sim-retry")


def test_stop_api_keeps_pending_finalization_out_of_failed_state(monkeypatch):
    simulation = SimpleNamespace(status=SimulationStatus.STOPPING, error=None)
    saved = []
    monkeypatch.setattr(
        simulation_api.SimulationRunner,
        "stop_simulation",
        classmethod(
            lambda _cls, _simulation_id: (_ for _ in ()).throw(
                SimulationStopPending("still draining")
            )
        ),
    )
    monkeypatch.setattr(
        simulation_api,
        "SimulationManager",
        lambda: SimpleNamespace(
            get_simulation=lambda _simulation_id: simulation,
            _save_simulation_state=lambda state: saved.append(state.status),
        ),
    )

    app = Flask(__name__)
    with app.test_request_context(
        "/api/simulation/stop",
        method="POST",
        json={"simulation_id": "sim-pending"},
    ):
        response, status = simulation_api.stop_simulation()

    assert status == 202
    assert response.get_json()["pending"] is True
    assert simulation.status == SimulationStatus.STOPPING
    assert saved == []


@pytest.mark.parametrize(
    "field",
    ["force", "enable_graph_memory_update"],
)
def test_simulation_start_rejects_string_booleans(field):
    app = Flask(__name__)
    with app.test_request_context(
        "/api/simulation/start",
        method="POST",
        json={"simulation_id": "sim-1", field: "false"},
    ):
        response, status = simulation_api.start_simulation()

    assert status == 400
    assert "JSON boolean" in response.get_json()["error"]


def test_force_restart_does_not_continue_while_old_ingestion_is_pending(monkeypatch):
    simulation = SimpleNamespace(
        simulation_id="sim-1",
        project_id="proj-1",
        graph_id="graph-1",
        status=SimulationStatus.STOPPING,
    )
    cleanup_called = []
    monkeypatch.setattr(
        simulation_api,
        "SimulationManager",
        lambda: SimpleNamespace(
            get_simulation=lambda _simulation_id: simulation,
            _save_simulation_state=lambda _state: None,
        ),
    )
    monkeypatch.setattr(
        simulation_api,
        "_check_simulation_prepared",
        lambda _simulation_id: (True, {}),
    )
    monkeypatch.setattr(
        simulation_api.SimulationRunner,
        "get_run_state",
        classmethod(
            lambda _cls, _simulation_id: SimpleNamespace(
                runner_status=RunnerStatus.STOPPING
            )
        ),
    )
    monkeypatch.setattr(
        simulation_api.SimulationRunner,
        "stop_simulation",
        classmethod(
            lambda _cls, _simulation_id: (_ for _ in ()).throw(
                SimulationStopPending("still draining")
            )
        ),
    )
    monkeypatch.setattr(
        simulation_api.SimulationRunner,
        "cleanup_simulation_logs",
        classmethod(
            lambda _cls, _simulation_id: cleanup_called.append(True)
        ),
    )
    monkeypatch.setattr(
        simulation_api.ZepGraphMemoryManager,
        "get_updater",
        classmethod(lambda _cls, _simulation_id: object()),
    )

    app = Flask(__name__)
    with app.test_request_context(
        "/api/simulation/start",
        method="POST",
        json={"simulation_id": "sim-1", "force": True},
    ):
        response, status = simulation_api.start_simulation()

    assert status == 409
    assert response.get_json()["pending"] is True
    assert cleanup_called == []


def test_monitor_start_failure_terminates_the_spawned_process(monkeypatch, tmp_path):
    simulation_id = "sim-start-failure"
    sim_dir = tmp_path / "runs" / simulation_id
    scripts_dir = tmp_path / "scripts"
    sim_dir.mkdir(parents=True)
    scripts_dir.mkdir()
    (sim_dir / "simulation_config.json").write_text(
        json.dumps({
            "time_config": {
                "total_simulation_hours": 1,
                "minutes_per_round": 60,
            }
        }),
        encoding="utf-8",
    )
    (scripts_dir / "run_twitter_simulation.py").write_text("pass\n", encoding="utf-8")

    class Process:
        pid = 123

        def poll(self):
            return None

    class BrokenThread:
        def __init__(self, **_kwargs):
            pass

        def start(self):
            raise RuntimeError("monitor failed")

    terminated = []
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(tmp_path / "runs"))
    monkeypatch.setattr(SimulationRunner, "SCRIPTS_DIR", str(scripts_dir))
    monkeypatch.setattr(runner_module.subprocess, "Popen", lambda *_args, **_kwargs: Process())
    monkeypatch.setattr(runner_module.threading, "Thread", BrokenThread)
    monkeypatch.setattr(
        SimulationRunner,
        "_terminate_process",
        classmethod(lambda _cls, _process, sim_id: terminated.append(sim_id)),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_sync_simulation_status",
        classmethod(lambda _cls, *_args, **_kwargs: None),
    )

    try:
        with pytest.raises(RuntimeError, match="monitor failed"):
            SimulationRunner.start_simulation(
                simulation_id,
                platform="twitter",
                enable_graph_memory_update=False,
            )
        assert terminated == [simulation_id]
        assert simulation_id not in SimulationRunner._processes
        assert simulation_id not in SimulationRunner._action_queues
        assert simulation_id not in SimulationRunner._stdout_files
    finally:
        SimulationRunner._run_states.pop(simulation_id, None)
        SimulationRunner._processes.pop(simulation_id, None)
        SimulationRunner._action_queues.pop(simulation_id, None)
        SimulationRunner._stdout_files.pop(simulation_id, None)
        SimulationRunner._stderr_files.pop(simulation_id, None)
        SimulationRunner._graph_memory_enabled.pop(simulation_id, None)


def test_shutdown_terminates_producer_before_tail_read_and_updater_drain(
    monkeypatch,
):
    simulation_id = "sim-shutdown-order"
    state = SimulationRunState(
        simulation_id=simulation_id,
        runner_status=RunnerStatus.RUNNING,
    )
    events = []

    class Process:
        pid = 123
        stopped = False

        def poll(self):
            return 0 if self.stopped else None

    process = Process()

    class Monitor:
        alive = True

        def join(self, timeout):
            assert timeout >= 30
            events.extend(["tail-read", "updater-drain"])
            state.runner_status = RunnerStatus.STOPPED
            SimulationRunner._graph_memory_enabled.pop(simulation_id, None)
            self.alive = False

        def is_alive(self):
            return self.alive

    monkeypatch.setattr(
        SimulationRunner,
        "get_run_state",
        classmethod(lambda _cls, _simulation_id: state),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_save_run_state",
        classmethod(lambda _cls, _state: None),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_sync_simulation_status",
        classmethod(lambda _cls, *_args, **_kwargs: None),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_terminate_process",
        classmethod(
            lambda _cls, proc, _simulation_id, **_kwargs: (
                events.append("producer-terminate"),
                setattr(proc, "stopped", True),
            )
        ),
    )
    monkeypatch.setattr(
        runner_module.ZepGraphMemoryManager,
        "get_simulation_ids",
        classmethod(lambda _cls: [simulation_id]),
    )
    updater = object()
    monkeypatch.setattr(
        runner_module.ZepGraphMemoryManager,
        "get_updater",
        classmethod(lambda _cls, _simulation_id: updater),
    )

    SimulationRunner._cleanup_done = False
    SimulationRunner._processes[simulation_id] = process
    SimulationRunner._monitor_threads[simulation_id] = Monitor()
    SimulationRunner._graph_memory_enabled[simulation_id] = True
    try:
        SimulationRunner.cleanup_all_simulations()
        assert events == [
            "producer-terminate",
            "tail-read",
            "updater-drain",
        ]
        assert state.runner_status == RunnerStatus.STOPPED
    finally:
        SimulationRunner._cleanup_done = False
        SimulationRunner._processes.pop(simulation_id, None)
        SimulationRunner._monitor_threads.pop(simulation_id, None)
        SimulationRunner._graph_memory_enabled.pop(simulation_id, None)
        SimulationRunner._manual_stop_requests.discard(simulation_id)


def test_shutdown_drain_failure_remains_failed_and_retryable(monkeypatch):
    simulation_id = "sim-shutdown-failure"
    state = SimulationRunState(
        simulation_id=simulation_id,
        runner_status=RunnerStatus.RUNNING,
    )
    updater = object()

    monkeypatch.setattr(
        SimulationRunner,
        "get_run_state",
        classmethod(lambda _cls, _simulation_id: state),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_save_run_state",
        classmethod(lambda _cls, _state: None),
    )
    monkeypatch.setattr(
        SimulationRunner,
        "_sync_simulation_status",
        classmethod(lambda _cls, *_args, **_kwargs: None),
    )
    monkeypatch.setattr(
        runner_module.ZepGraphMemoryManager,
        "get_simulation_ids",
        classmethod(lambda _cls: [simulation_id]),
    )
    monkeypatch.setattr(
        runner_module.ZepGraphMemoryManager,
        "get_updater",
        classmethod(lambda _cls, _simulation_id: updater),
    )
    monkeypatch.setattr(
        runner_module.ZepGraphMemoryManager,
        "stop_updater",
        classmethod(
            lambda _cls, _simulation_id: (_ for _ in ()).throw(
                RuntimeError("drain incomplete")
            )
        ),
    )

    SimulationRunner._cleanup_done = False
    SimulationRunner._graph_memory_enabled[simulation_id] = True
    SimulationRunner._monitor_threads.pop(simulation_id, None)
    SimulationRunner._processes.pop(simulation_id, None)
    try:
        SimulationRunner.cleanup_all_simulations()
        assert state.runner_status == RunnerStatus.FAILED
        assert "drain incomplete" in state.error
        assert SimulationRunner._graph_memory_enabled[simulation_id] is True
        assert SimulationRunner._cleanup_done is False
    finally:
        SimulationRunner._cleanup_done = False
        SimulationRunner._graph_memory_enabled.pop(simulation_id, None)
        SimulationRunner._manual_stop_requests.discard(simulation_id)


@pytest.mark.parametrize("graph_memory", [False, True])
@pytest.mark.parametrize("drain_failure", [False, True])
@pytest.mark.parametrize("manual_stop", [False, True])
def test_completed_platforms_finalize_while_interview_process_stays_alive(
    monkeypatch, tmp_path, graph_memory, drain_failure, manual_stop
):
    simulation_id = "sim-interview-alive"
    sim_dir = tmp_path / simulation_id
    for platform in ("twitter", "reddit"):
        log_dir = sim_dir / platform
        log_dir.mkdir(parents=True)
        (log_dir / "actions.jsonl").write_text(
            '{"event_type":"simulation_end","total_rounds":1}\n',
            encoding="utf-8",
        )
    state = SimulationRunState(
        simulation_id=simulation_id,
        runner_status=RunnerStatus.STOPPING if manual_stop else RunnerStatus.RUNNING,
        twitter_running=True,
        reddit_running=True,
    )
    process = SimpleNamespace(returncode=None)
    process.poll = lambda: process.returncode
    drains = []
    observations = []

    def drain(_simulation_id):
        drains.append((process.poll(), state.runner_status))
        if drain_failure:
            raise RuntimeError("ingestion incomplete")

    def observe_live_process(_seconds):
        observations.append((state.runner_status, state.error))
        # Keep the child alive for two monitor passes, then let it exit normally.
        if len(observations) == 2:
            process.returncode = 0

    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(SimulationRunner, "get_run_state", lambda _sid: state)
    monkeypatch.setattr(SimulationRunner, "_save_run_state", lambda _state: None)
    monkeypatch.setattr(SimulationRunner, "_sync_simulation_status", lambda *_args: None)
    monkeypatch.setattr(runner_module.time, "sleep", observe_live_process)
    monkeypatch.setattr(runner_module.ZepGraphMemoryManager, "stop_updater", drain)
    monkeypatch.setitem(SimulationRunner._processes, simulation_id, process)
    monkeypatch.setitem(SimulationRunner._graph_memory_enabled, simulation_id, graph_memory)
    monkeypatch.setattr(
        SimulationRunner, "_manual_stop_requests",
        {simulation_id} if manual_stop else set(),
    )

    SimulationRunner._monitor_simulation(simulation_id)

    expected = (
        RunnerStatus.FAILED if graph_memory and drain_failure
        else RunnerStatus.STOPPED if manual_stop else RunnerStatus.COMPLETED
    )
    interim = RunnerStatus.STOPPING if manual_stop else expected
    assert [status for status, _error in observations] == [interim, interim]
    exit_code_at_drain = 0 if manual_stop else None
    assert drains == (
        [(exit_code_at_drain, RunnerStatus.STOPPING)] if graph_memory else []
    )
    assert state.runner_status == expected
    if graph_memory and drain_failure:
        assert "ingestion incomplete" in state.error
        assert SimulationRunner._graph_memory_enabled[simulation_id] is True
    else:
        assert state.error is None
        assert not SimulationRunner._graph_memory_enabled.get(simulation_id, False)


def test_completion_waits_for_expected_platform_even_before_its_log_exists(
    monkeypatch, tmp_path
):
    state = SimulationRunState(
        simulation_id="sim-platform-delayed",
        runner_status=RunnerStatus.RUNNING,
        twitter_completed=True,
        reddit_running=True,
    )
    log_dir = tmp_path / state.simulation_id / "twitter"
    log_dir.mkdir(parents=True)
    (log_dir / "actions.jsonl").write_text("", encoding="utf-8")
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(tmp_path))

    assert SimulationRunner._check_all_platforms_completed(state) is False


def test_manual_stop_can_close_completed_interview_environment(monkeypatch):
    simulation_id = "sim-close-interviews"
    state = SimulationRunState(
        simulation_id=simulation_id,
        runner_status=RunnerStatus.COMPLETED,
        twitter_completed=True,
        reddit_completed=True,
    )
    process = SimpleNamespace(returncode=None)
    process.poll = lambda: process.returncode
    monkeypatch.setattr(SimulationRunner, "get_run_state", lambda _sid: state)
    monkeypatch.setattr(SimulationRunner, "_save_run_state", lambda _state: None)
    monkeypatch.setattr(SimulationRunner, "_sync_simulation_status", lambda *_args: None)
    monkeypatch.setattr(
        SimulationRunner, "_terminate_process",
        lambda _process, _sid: setattr(process, "returncode", 0),
    )
    monkeypatch.setitem(SimulationRunner._processes, simulation_id, process)

    result = SimulationRunner.stop_simulation(simulation_id)

    assert result.runner_status == RunnerStatus.STOPPED
    assert process.poll() == 0


def test_force_restart_stops_completed_live_environment_before_cleanup(monkeypatch):
    simulation_id = "sim-restart-interviews"
    state = SimpleNamespace(status=SimulationStatus.COMPLETED)
    run_state = SimpleNamespace(runner_status=RunnerStatus.COMPLETED)
    cleanup_called = []
    monkeypatch.setattr(
        simulation_api, "SimulationManager",
        lambda: SimpleNamespace(get_simulation=lambda _sid: state),
    )
    monkeypatch.setattr(simulation_api, "_check_simulation_prepared", lambda _sid: (True, {}))
    monkeypatch.setattr(SimulationRunner, "get_run_state", lambda _sid: run_state)
    monkeypatch.setitem(
        SimulationRunner._processes, simulation_id, SimpleNamespace(poll=lambda: None),
    )
    monkeypatch.setattr(
        SimulationRunner, "stop_simulation",
        lambda _sid: (_ for _ in ()).throw(SimulationStopPending("still stopping interviews")),
    )
    monkeypatch.setattr(
        SimulationRunner, "cleanup_simulation_logs",
        lambda _sid: cleanup_called.append(True) or {"success": True},
    )

    app = Flask(__name__)
    with app.test_request_context(
        "/api/simulation/start", method="POST",
        json={"simulation_id": simulation_id, "force": True},
    ):
        response, status = simulation_api.start_simulation()

    assert cleanup_called == []
    assert status == 409
    assert response.get_json()["pending"] is True


@pytest.mark.parametrize("process_exited", [False, True])
def test_direct_start_rejects_completed_but_owned_interview_environment(
    monkeypatch, tmp_path, process_exited
):
    simulation_id = "sim-duplicate-interviews"
    sim_dir = tmp_path / simulation_id
    sim_dir.mkdir()
    (sim_dir / "simulation_config.json").write_text("{}", encoding="utf-8")
    state = SimulationRunState(simulation_id=simulation_id, runner_status=RunnerStatus.COMPLETED)
    saved = []
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(SimulationRunner, "get_run_state", lambda _sid: state)
    monkeypatch.setattr(SimulationRunner, "_save_run_state", lambda value: saved.append(value))
    monkeypatch.setitem(
        SimulationRunner._processes, simulation_id,
        SimpleNamespace(poll=lambda: 0 if process_exited else None),
    )
    monkeypatch.setitem(
        SimulationRunner._monitor_threads, simulation_id,
        SimpleNamespace(is_alive=lambda: True),
    )
    monkeypatch.setattr(
        runner_module.subprocess, "Popen",
        lambda *_args, **_kwargs: pytest.fail("duplicate child must not start"),
    )

    with pytest.raises(ValueError, match="运行或结束处理"):
        SimulationRunner.start_simulation(simulation_id)

    assert saved == []
