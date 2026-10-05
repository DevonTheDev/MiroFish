"""Run single-platform producers through real SQLite, event logs, and consumers."""

import asyncio
import importlib
import json
import sqlite3
from types import SimpleNamespace

import pytest

from app.config import Config
from app.services.simulation_manager import SimulationManager
from app.services.simulation_runner import (
    RunnerStatus,
    SimulationRunner,
    SimulationRunState,
    ZepGraphMemoryManager,
)


def prepare_run(tmp_path, monkeypatch, platform, *, seeds=True, active_rounds=(0, 2),
                fail_step=None, interrupt_step=None, broken_trace=False):
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", 3)
    pytest.importorskip("camel")
    script = importlib.import_module(f"scripts.run_{platform}_simulation")
    simulation_dir = tmp_path / "sim_progress"
    simulation_dir.mkdir()
    config = {
        "simulation_id": simulation_dir.name,
        "time_config": {"total_simulation_hours": 4, "minutes_per_round": 45},
        "agent_configs": [{"agent_id": 0, "entity_name": "Alice"},
                          {"agent_id": 1, "entity_name": "Bob"}],
        "event_config": {"initial_posts": [
            {"poster_agent_id": 0, "content": "First seed"},
            {"poster_agent_id": 0, "content": "Second seed"},
            {"poster_agent_id": 1, "content": "Unexecuted seed"},
            {"poster_agent_id": 99, "content": "Unknown agent"},
        ] if seeds else []},
    }
    config_path = simulation_dir / "simulation_config.json"
    config_path.write_text(json.dumps(config))
    (simulation_dir / ("twitter_profiles.csv" if platform == "twitter" else "reddit_profiles.json")).write_text("")

    class Agent:
        def __init__(self, agent_id):
            self.agent_id = agent_id

    agents = {index: Agent(index) for index in range(2)}
    graph = SimpleNamespace(get_agent=agents.__getitem__, get_agents=lambda: list(agents.items()))
    database = simulation_dir / f"{platform}_simulation.db"

    class Environment:
        agent_graph = graph
        steps = 0
        closed = False

        async def reset(self):
            with sqlite3.connect(database) as connection:
                connection.executescript("""
                    CREATE TABLE user (user_id INTEGER, agent_id INTEGER, name TEXT, user_name TEXT);
                    INSERT INTO user VALUES (0, 0, 'Alice', 'alice'), (1, 1, 'Bob', 'bob');
                    CREATE TABLE post (post_id INTEGER PRIMARY KEY, user_id INTEGER, content TEXT);
                    CREATE TABLE trace (user_id INTEGER, action TEXT, info TEXT);
                    INSERT INTO trace VALUES (0, 'sign_up', '{}');
                """)
                if broken_trace:
                    connection.execute("DROP TABLE trace")

        async def step(self, actions):
            self.steps += 1
            if self.steps == fail_step:
                raise RuntimeError("Synthetic environment step failed")
            with sqlite3.connect(database) as connection:
                for agent, selected in actions.items():
                    for action in selected if isinstance(selected, list) else [selected]:
                        if isinstance(action, script.ManualAction):
                            content = action.action_args["content"]
                            if content == "Unexecuted seed":
                                continue
                            cursor = connection.execute("INSERT INTO post (user_id, content) VALUES (?, ?)",
                                                        (agent.agent_id, content))
                            action_type, args = "create_post", {"content": content, "post_id": cursor.lastrowid}
                        else:
                            # One selected LLM action can produce more than one trace row.
                            connection.execute("INSERT INTO trace VALUES (?, 'refresh', '{}')", (agent.agent_id,))
                            connection.execute("INSERT INTO trace VALUES (?, 'do_nothing', '{}')", (agent.agent_id,))
                            action_type, args = "like_post", {"post_id": 1}
                        connection.execute("INSERT INTO trace VALUES (?, ?, ?)",
                                           (agent.agent_id, action_type, json.dumps(args)))
            if self.steps == interrupt_step:
                script._shutdown_event.set()

        async def close(self):
            self.closed = True

    env = Environment()

    async def generate_graph(**kwargs):
        return graph

    monkeypatch.setattr(script, f"generate_{platform}_agent_graph", generate_graph)
    monkeypatch.setattr(script.oasis, "make", lambda **kwargs: env)
    monkeypatch.setattr(script, "platform_for_mode", lambda *args, **kwargs: kwargs.get("default_platform"), raising=False)
    monkeypatch.setattr(script, "_shutdown_event", asyncio.Event())
    runner_class = getattr(script, f"{platform.title()}SimulationRunner")
    monkeypatch.setattr(runner_class, "_create_model", lambda self: object())
    monkeypatch.setattr(runner_class, "_get_active_agents_for_round",
                        lambda self, env, hour, round_num: [(0, agents[0])] if round_num in active_rounds else [])
    runner = runner_class(str(config_path), wait_for_commands=True)

    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(SimulationRunner, "_graph_memory_enabled", {simulation_dir.name: True})
    monkeypatch.setattr(SimulationRunner, "_manual_stop_requests", set())
    monkeypatch.setattr(SimulationRunner, "_finalization_locks", {})
    activities, drains = [], []
    updater = SimpleNamespace(add_activity_from_dict=lambda data, source: activities.append((data, source)))
    monkeypatch.setattr(ZepGraphMemoryManager, "get_updater", lambda simulation_id: updater)
    monkeypatch.setattr(ZepGraphMemoryManager, "stop_updater", lambda simulation_id: drains.append(
        (simulation_id, state.runner_status, len(activities), env.closed)
    ))
    state = SimulationRunState(simulation_dir.name, runner_status=RunnerStatus.RUNNING, total_rounds=3)
    setattr(state, f"{platform}_running", True)
    log_path = simulation_dir / platform / "actions.jsonl"
    position = 0

    def consume():
        nonlocal position
        position = SimulationRunner._read_action_log(str(log_path), position, state, platform)
        SimulationRunner._finalize_completed_platforms(state)
        # Repeated polling must neither re-add actions nor drain twice.
        SimulationRunner._read_action_log(str(log_path), position, state, platform)
        SimulationRunner._finalize_completed_platforms(state)

    observed = {}
    original_process = script.IPCHandler.process_commands

    async def observe_wait(handler):
        consume()
        observed.update(status=state.runner_status, env_closed=env.closed,
                        env_status=json.loads((simulation_dir / "env_status.json").read_text())["status"])
        return await original_process(handler)

    monkeypatch.setattr(script.IPCHandler, "process_commands", observe_wait)
    commands_dir = simulation_dir / "ipc_commands"
    commands_dir.mkdir()
    (commands_dir / "close.json").write_text(json.dumps({"command_id": "close", "command_type": "close_env", "args": {}}))
    return SimpleNamespace(runner=runner, env=env, script=script, path=log_path, state=state,
                           observed=observed, activities=activities, drains=drains, consume=consume)


def read_events(run):
    return [json.loads(line) for line in run.path.read_text().splitlines()] if run.path.exists() else []


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_single_run_completes_monitor_before_interview_wait_with_actual_actions(tmp_path, monkeypatch, platform):
    run = prepare_run(tmp_path, monkeypatch, platform)
    run.path.parent.mkdir()
    run.path.write_text('{"event_type":"simulation_end","total_rounds":99}\n')
    completion_boundary = []
    original_end = run.script.PlatformActionLogger.log_simulation_end

    def consume_end_marker(logger, total_rounds, total_actions):
        original_end(logger, total_rounds, total_actions)
        run.consume()
        status_path = run.path.parent.parent / "env_status.json"
        completion_boundary.append((run.state.runner_status, json.loads(status_path.read_text())["status"]))

    monkeypatch.setattr(run.script.PlatformActionLogger, "log_simulation_end", consume_end_marker)
    asyncio.run(run.runner.run(max_rounds=10))
    assert completion_boundary == [(RunnerStatus.COMPLETED, "alive")]
    assert run.observed == {"status": RunnerStatus.COMPLETED, "env_closed": False, "env_status": "alive"}
    events = read_events(run)
    assert events[0]["event_type"] == "simulation_start"
    assert events[0]["total_rounds"] == 3
    actions = [event for event in events if "action_type" in event]
    seed_count = 1 if platform == "twitter" else 2
    assert len(actions) == seed_count + 4
    assert [a["round"] for a in actions] == [0] * seed_count + [1, 1, 3, 3]
    assert all(a["agent_name"] == "Alice" for a in actions)
    assert "Unexecuted seed" not in json.dumps(actions)
    assert "Unknown agent" not in json.dumps(actions)
    assert all(a["action_args"]["post_author_name"] == "Alice" for a in actions if a["action_type"] == "LIKE_POST")
    assert all(a["action_args"]["post_content"] for a in actions if a["action_type"] == "LIKE_POST")
    ends = [event for event in events if event.get("event_type") == "round_end"]
    assert [event["round"] for event in ends] == [0, 1, 2, 3]
    assert [event["actions_count"] for event in ends] == [seed_count, 2, 0, 2]
    assert [event["simulated_hours"] for event in ends] == [0, 0.75, 1.5, 2.25]
    assert events[-1]["event_type"] == "simulation_end"
    assert events[-1]["total_rounds"] == 3
    assert events[-1]["total_actions"] == len(actions)
    assert run.state.current_round == 3
    assert run.state.simulated_hours == 2.25
    assert getattr(run.state, f"{platform}_actions_count") == len(actions)
    assert run.activities == [(action, platform) for action in actions]
    assert run.drains == [("sim_progress", RunnerStatus.STOPPING, len(actions), False)]
    saved = SimulationRunner.get_all_actions("sim_progress", platform=platform)
    assert len(saved) == len(actions)
    assert {action.platform for action in saved} == {platform}
    assert sorted(action.round_num for action in saved) == [0] * seed_count + [1, 1, 3, 3]
    assert run.env.closed


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_empty_single_rounds_still_finish_and_report_elapsed_simulation(tmp_path, monkeypatch, platform):
    run = prepare_run(tmp_path, monkeypatch, platform, seeds=False, active_rounds=())
    asyncio.run(run.runner.run(max_rounds=2))
    assert run.observed["status"] == RunnerStatus.COMPLETED
    assert run.state.current_round == 2
    assert run.state.simulated_hours == 1.5
    assert run.activities == []
    assert run.env.steps == 0
    assert [event["round"] for event in read_events(run) if event.get("event_type") == "round_end"] == [0, 1, 2]


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
@pytest.mark.parametrize("fail_step", [1, 2])
def test_failed_single_step_never_publishes_success_or_waits_and_closes_environment(tmp_path, monkeypatch, platform, fail_step):
    run = prepare_run(tmp_path, monkeypatch, platform, fail_step=fail_step)
    with pytest.raises(RuntimeError, match="Synthetic environment step failed"):
        asyncio.run(run.runner.run())
    events = read_events(run)
    assert events, "A failed run should retain its start and any successful earlier actions"
    assert not any(event.get("event_type") == "simulation_end" for event in events)
    assert not any(event.get("round") == fail_step - 1 and "action_type" in event for event in events)
    run.consume()
    assert run.state.runner_status == RunnerStatus.RUNNING
    assert run.observed == {}
    assert run.env.closed


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
@pytest.mark.parametrize("interrupt_step", [1, 3])
def test_single_shutdown_stops_between_rounds_without_completion_marker(tmp_path, monkeypatch, platform, interrupt_step):
    run = prepare_run(tmp_path, monkeypatch, platform, seeds=False, active_rounds=(0, 1, 2), interrupt_step=interrupt_step)
    asyncio.run(run.runner.run())
    assert run.env.steps == interrupt_step
    events = read_events(run)
    assert not any(event.get("event_type") == "simulation_end" for event in events)
    assert [event["round"] for event in events if event.get("event_type") == "round_end"] == list(range(interrupt_step + 1))
    run.consume()
    assert run.state.runner_status == RunnerStatus.RUNNING
    assert run.observed == {}
    assert run.env.closed


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_missing_trace_table_prevents_single_success(tmp_path, monkeypatch, platform):
    run = prepare_run(tmp_path, monkeypatch, platform, seeds=False, active_rounds=(), broken_trace=True)
    with pytest.raises(sqlite3.OperationalError, match="no such table: trace"):
        asyncio.run(run.runner.run())
    assert not any(event.get("event_type") == "simulation_end" for event in read_events(run))
    assert run.observed == {}
    assert run.env.closed


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_parallel_platform_functions_keep_using_actual_trace_reader(tmp_path, monkeypatch, platform):
    run = prepare_run(tmp_path, monkeypatch, platform, seeds=False)
    parallel = importlib.import_module("scripts.run_parallel_simulation")
    monkeypatch.setattr(parallel, "create_model", lambda *args, **kwargs: object())
    monkeypatch.setattr(parallel, f"generate_{platform}_agent_graph",
                        getattr(run.script, f"generate_{platform}_agent_graph"))
    monkeypatch.setattr(parallel, "platform_for_mode", run.script.platform_for_mode)
    monkeypatch.setattr(parallel, "get_active_agents_for_round",
                        lambda env, config, hour, round_num: run.runner._get_active_agents_for_round(env, hour, round_num))
    monkeypatch.setattr(parallel, "_shutdown_event", asyncio.Event())
    action_logger = parallel.PlatformActionLogger(platform, run.runner.simulation_dir)
    result = asyncio.run(getattr(parallel, f"run_{platform}_simulation")(
        run.runner.config, run.runner.simulation_dir, action_logger=action_logger, max_rounds=3,
    ))
    events = read_events(run)
    actions = [event for event in events if "action_type" in event]
    assert [action["action_type"] for action in actions] == ["DO_NOTHING", "LIKE_POST"] * 2
    assert [action["round"] for action in actions] == [1, 1, 3, 3]
    assert events[-1]["event_type"] == "simulation_end"
    assert result.total_actions == 4
    assert result.env is run.env
    assert not run.env.closed
    run.consume()
    assert run.state.runner_status == RunnerStatus.COMPLETED
    assert len(run.activities) == 4
    asyncio.run(result.env.close())


@pytest.mark.parametrize("strict", [False, True])
def test_trace_read_failure_closes_connection_and_retains_default_error_policy(tmp_path, monkeypatch, strict):
    from scripts import simulation_trace

    database = tmp_path / "broken.db"
    database.touch()
    connections = []

    def connect(path):
        connection = sqlite3.connect(path)
        connections.append(connection)
        return connection

    monkeypatch.setattr(simulation_trace, "sqlite3", SimpleNamespace(connect=connect))
    if strict:
        with pytest.raises(sqlite3.OperationalError, match="no such table: trace"):
            simulation_trace.fetch_new_actions_from_db(str(database), 0, {}, strict=True)
    else:
        assert simulation_trace.fetch_new_actions_from_db(str(database), 0, {}) == ([], 0)
    assert len(connections) == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
        connections[0].execute("SELECT 1")


@pytest.mark.parametrize("strict", [False, True])
@pytest.mark.parametrize("read_failure", [False, True])
def test_trace_close_failure_preserves_default_policy_and_original_read_error(tmp_path, monkeypatch, strict, read_failure):
    from scripts import simulation_trace

    database = tmp_path / "trace.db"
    database.touch()
    read_error = sqlite3.OperationalError("original read failure")

    class Connection:
        def cursor(self):
            if read_failure:
                raise read_error
            return SimpleNamespace(execute=lambda *args: None, fetchall=lambda: [])

        def close(self):
            raise RuntimeError("secondary close failure")

    monkeypatch.setattr(simulation_trace, "sqlite3", SimpleNamespace(connect=lambda path: Connection()))
    if not strict:
        assert simulation_trace.fetch_new_actions_from_db(str(database), 0, {}) == ([], 0)
    elif read_failure:
        with pytest.raises(sqlite3.OperationalError, match="original read failure") as caught:
            simulation_trace.fetch_new_actions_from_db(str(database), 0, {}, strict=True)
        assert caught.value is read_error
    else:
        with pytest.raises(RuntimeError, match="secondary close failure"):
            simulation_trace.fetch_new_actions_from_db(str(database), 0, {}, strict=True)
