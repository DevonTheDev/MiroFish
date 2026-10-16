"""Parallel initialization history uses visible trace rows, not seed requests.

These runner/SQLite/JSONL tests reuse the existing progress fixture. Model,
environment and graph construction are mocked; graph captures prove forwarding,
not acceptance by an external graph service. Failed-step reads cover only rows
visible when the step raises, not later effects of pending manual siblings.
"""

import asyncio
from collections import Counter
import importlib
import json
import sqlite3

import pytest

from test_single_platform_progress import prepare_run, read_events


PLATFORMS = ["twitter", "reddit"]


def action_records(run):
    return [event for event in read_events(run) if "action_type" in event]


def action_signature(action):
    return (action["round"], action["agent_id"], action["action_type"],
            tuple(sorted(action["action_args"].items())))


def prepare_history(tmp_path, monkeypatch, platform, *, seeds=None, mixed=False,
                    active_rounds=(0,), logger=True, seed_error=None,
                    fail_before_persistence=False, read_error=None,
                    close_error=None, write_error=None, total_hours=4,
                    max_rounds=2):
    run = prepare_run(tmp_path, monkeypatch, platform, seeds=False, active_rounds=())
    script = importlib.import_module("scripts.run_parallel_simulation")
    run.parallel = script
    graph = run.env.agent_graph
    agents = dict(graph.get_agents())
    aliases = {**agents, 20: agents[0]}
    monkeypatch.setattr(graph, "get_agent", aliases.__getitem__)
    config = run.runner.config
    config["event_config"]["initial_posts"] = (
        [{"poster_agent_id": 0, "content": "seed"}] if seeds is None else seeds
    )
    config["time_config"]["total_simulation_hours"] = total_hours
    (run.path.parent.parent / "simulation_config.json").write_text(json.dumps(config))
    database = run.path.parent.parent / f"{platform}_simulation.db"
    run.database = database
    run.submissions, run.step_kinds, run.before_steps, run.fetches = [], [], [], []
    run.close_count = 0
    original_reset = run.env.reset

    async def reset():
        await original_reset()
        if mixed:
            with sqlite3.connect(database) as connection:
                connection.execute("INSERT INTO trace VALUES (1, 'follow', ?)",
                                   (json.dumps({"follow_id": 0}),))
                connection.execute("INSERT INTO trace VALUES (1, 'refresh', '{}')")

    async def step(actions):
        run.env.steps += 1
        run.before_steps.append(action_records(run))
        expanded = [(agent, action) for agent, selected in actions.items()
                    for action in (selected if isinstance(selected, list) else [selected])]
        manual = all(isinstance(action, script.ManualAction) for _, action in expanded)
        run.step_kinds.append("seed" if manual else "active")
        if manual:
            run.submissions.append([(agent, action.action_type, dict(action.action_args))
                                    for agent, action in expanded])
            if fail_before_persistence and seed_error is not None:
                raise seed_error
        with sqlite3.connect(database) as connection:
            # Deliberately put Bob's trace before Alice's; configured order is
            # not an execution/completion-order oracle.
            outcomes = sorted(expanded, key=lambda pair: -pair[0].agent_id) if mixed else expanded
            for agent, action in outcomes:
                if manual:
                    content = action.action_args["content"]
                    if content == "no trace or post":
                        continue
                    cursor = connection.execute("INSERT INTO post (user_id, content) VALUES (?, ?)",
                                                (agent.agent_id, content))
                    if content == "committed without trace":
                        continue
                    action_type = "create_post"
                    args = {"post_id": cursor.lastrowid, "content": content}
                else:
                    action_type, args = "do_nothing", {}
                connection.execute("INSERT INTO trace VALUES (?, ?, ?)",
                                   (agent.agent_id, action_type, json.dumps(args)))
            connection.execute("INSERT INTO trace VALUES (0, 'refresh', '{}')")
        # The context has committed before raising: no rollback is assumed.
        if manual and seed_error is not None:
            raise seed_error

    async def close():
        run.close_count += 1
        run.env.closed = True
        if close_error is not None:
            raise close_error

    original_fetch = script.fetch_new_actions_from_db

    def fetch(path, cursor, names, *, strict=False):
        observed = {"cursor": cursor, "strict": strict, "steps": run.env.steps}
        run.fetches.append(observed)
        if read_error is not None:
            raise read_error
        actions, new_cursor = original_fetch(path, cursor, names, strict=strict)
        observed.update(new_cursor=new_cursor, actions=actions)
        return actions, new_cursor

    monkeypatch.setattr(run.env, "reset", reset)
    monkeypatch.setattr(run.env, "step", step)
    monkeypatch.setattr(run.env, "close", close)
    monkeypatch.setattr(script, "make_oasis_environment", lambda **kwargs: run.env)
    monkeypatch.setattr(script, "create_model", lambda *args, **kwargs: object())
    monkeypatch.setattr(script, f"generate_{platform}_agent_graph",
                        getattr(run.script, f"generate_{platform}_agent_graph"))
    monkeypatch.setattr(script, "platform_for_mode", run.script.platform_for_mode)
    monkeypatch.setattr(script, "get_active_agents_for_round",
                        lambda env, config, hour, round_num: [(0, agents[0])]
                        if round_num in active_rounds else [])
    monkeypatch.setattr(script, "_shutdown_event", asyncio.Event())
    monkeypatch.setattr(script, "fetch_new_actions_from_db", fetch)
    run.action_logger = script.PlatformActionLogger(platform, run.runner.simulation_dir) if logger else None
    run.write_calls = []
    if write_error is not None:
        original_log = run.action_logger.log_action

        def log_action(*args, **kwargs):
            run.write_calls.append(kwargs)
            if len(run.write_calls) == 2:
                raise write_error
            return original_log(*args, **kwargs)

        monkeypatch.setattr(run.action_logger, "log_action", log_action)
    run.invoke = lambda: asyncio.run(getattr(script, f"run_{platform}_simulation")(
        config, run.runner.simulation_dir, action_logger=run.action_logger,
        max_rounds=max_rounds,
    ))
    return run


def assert_trace_history(run, result, expected):
    """Candidate oracle also explicitly rejects the old baseline witnesses."""
    assert action_records(run) == expected
    assert run.fetches[0]["cursor"] == 0
    assert run.fetches[0]["strict"] is True
    assert sum(fetch["strict"] for fetch in run.fetches) == 1
    for previous, current in zip(run.fetches, run.fetches[1:]):
        assert current["cursor"] == previous["new_cursor"]
        assert current["strict"] is False  # Preserve the active-round policy.
    assert result.total_actions == len(expected)
    assert read_events(run)[-1]["total_actions"] == len(expected)
    assert result.completed
    assert result.env is run.env and not run.env.closed
    assert run.close_count == 0


def expected_from_fetches(run, active_round):
    return [(0 if index == 0 else active_round, action)
            for index, fetch in enumerate(run.fetches) for action in fetch["actions"]]


def assert_success_records(run, result, active_round=1):
    actions = action_records(run)
    expected = expected_from_fetches(run, active_round)
    assert [(action["round"], {key: action[key] for key in data})
            for action, (_, data) in zip(actions, expected)] == expected
    assert len(actions) == len(expected)
    assert_trace_history(run, result, actions)


def assert_failed_initialization(run, error):
    with pytest.raises(type(error)) as caught:
        run.invoke()
    assert caught.value is error
    assert run.close_count == 1 and run.env.closed
    assert "active" not in run.step_kinds
    assert len(run.fetches) == 1
    assert run.fetches[0]["cursor"] == 0 and run.fetches[0]["strict"] is True
    assert not any(event.get("event_type") == "simulation_end" or
                   (event.get("event_type") == "round_end" and event["round"] == 0)
                   for event in read_events(run))


@pytest.mark.parametrize("platform", PLATFORMS)
def test_mixed_trace_outcomes_and_consumers(tmp_path, monkeypatch, platform, capsys):
    seeds = [{"poster_agent_id": 20, "content": "duplicate"},
             {"poster_agent_id": 1, "content": "duplicate"},
             {"poster_agent_id": 0, "content": "no trace or post"},
             {"poster_agent_id": 1, "content": "committed without trace"}]
    run = prepare_history(tmp_path, monkeypatch, platform, seeds=seeds, mixed=True,
                          active_rounds=(1,))
    result = run.invoke()
    actions = action_records(run)
    assert_success_records(run, result, active_round=2)
    assert run.step_kinds == ["seed", "active"]
    assert run.before_steps[0] == []
    assert len(run.before_steps[1]) == 3
    assert len(run.submissions) == 1
    assert Counter((agent.agent_id, kind, args["content"])
                   for agent, kind, args in run.submissions[0]) == Counter(
        (0 if post["poster_agent_id"] == 20 else post["poster_agent_id"],
         run.parallel.ActionType.CREATE_POST, post["content"]) for post in seeds)
    assert [(a["round"], a["agent_id"], a["action_type"]) for a in actions] == [
        (0, 1, "FOLLOW"), (0, 1, "CREATE_POST"), (0, 0, "CREATE_POST"), (2, 0, "DO_NOTHING")]
    posts = [a for a in actions if a["action_type"] == "CREATE_POST"]
    assert [(a["agent_name"], a["action_args"]) for a in posts] == [
        ("Bob", {"content": "duplicate", "post_id": 1}),
        ("Alice", {"content": "duplicate", "post_id": 3})]
    with sqlite3.connect(run.database) as connection:
        assert connection.execute("SELECT post_id, user_id, content FROM post ORDER BY post_id").fetchall() == [
            (1, 1, "duplicate"), (2, 1, "committed without trace"), (3, 0, "duplicate")]
        assert connection.execute("SELECT rowid, action FROM trace ORDER BY rowid").fetchall() == [
            (1, "sign_up"), (2, "follow"), (3, "refresh"), (4, "create_post"),
            (5, "create_post"), (6, "refresh"), (7, "do_nothing"), (8, "refresh")]
    assert [(f["cursor"], f["new_cursor"], f["strict"]) for f in run.fetches] == [(0, 6, True), (6, 8, False)]
    assert [(e["round"], e["actions_count"]) for e in read_events(run)
            if e.get("event_type") == "round_end"] == [(0, 3), (1, 0), (2, 1)]
    if platform == "twitter":
        assert "已提交 4 条初始发帖动作" in capsys.readouterr().out
    run.consume()
    run.consume()
    assert getattr(run.state, f"{platform}_actions_count") == 4
    assert run.activities == [(action, platform) for action in actions]
    from app.services.simulation_runner import SimulationRunner
    saved = SimulationRunner.get_all_actions("sim_progress", platform=platform)
    assert Counter((a.round_num, a.agent_id, a.action_type, tuple(sorted(a.action_args.items())))
                   for a in saved) == Counter(map(action_signature, actions))
    timeline = SimulationRunner.get_timeline("sim_progress")
    assert [(item["round_num"], item["total_actions"], item[f"{platform}_actions"], item["action_types"])
            for item in timeline] == [(0, 3, 3, {"FOLLOW": 1, "CREATE_POST": 2}),
                                     (2, 1, 1, {"DO_NOTHING": 1})]


@pytest.mark.parametrize("platform", PLATFORMS)
def test_one_round_cap_without_active_agents(tmp_path, monkeypatch, platform):
    run = prepare_history(tmp_path, monkeypatch, platform, active_rounds=(), max_rounds=1)
    result = run.invoke()
    assert_success_records(run, result)
    assert result.total_rounds == 1 and run.step_kinds == ["seed"]
    assert run.fetches[0]["new_cursor"] == 3
    assert [(e["round"], e["actions_count"]) for e in read_events(run)
            if e.get("event_type") == "round_end"] == [(0, 1), (1, 0)]


@pytest.mark.parametrize("platform", PLATFORMS)
def test_zero_configured_rounds(tmp_path, monkeypatch, platform):
    run = prepare_history(tmp_path, monkeypatch, platform, total_hours=0)
    result = run.invoke()
    assert_success_records(run, result)
    assert result.total_rounds == 0 and run.step_kinds == ["seed"]
    assert run.fetches[0]["new_cursor"] == 3
    assert [e["round"] for e in read_events(run) if e.get("event_type") == "round_end"] == [0]


@pytest.mark.parametrize("platform", PLATFORMS)
def test_no_configured_seeds(tmp_path, monkeypatch, platform):
    run = prepare_history(tmp_path, monkeypatch, platform, seeds=[], active_rounds=())
    result = run.invoke()
    assert_success_records(run, result)
    assert run.step_kinds == [] and run.submissions == []
    assert run.fetches[0]["new_cursor"] == 1 and result.total_actions == 0
    assert all(e["actions_count"] == 0 for e in read_events(run) if e.get("event_type") == "round_end")


@pytest.mark.parametrize("platform", PLATFORMS)
def test_all_unresolvable_seeds(tmp_path, monkeypatch, platform):
    run = prepare_history(tmp_path, monkeypatch, platform,
                          seeds=[{"poster_agent_id": 99, "content": "unknown"}], active_rounds=())
    result = run.invoke()
    assert_success_records(run, result)
    assert run.step_kinds == [] and run.submissions == []
    assert run.fetches[0]["new_cursor"] == 1 and action_records(run) == []


@pytest.mark.parametrize("platform", PLATFORMS)
def test_committed_trace_before_seed_error(tmp_path, monkeypatch, platform):
    error = RuntimeError("seed failed after commit")
    run = prepare_history(tmp_path, monkeypatch, platform, seed_error=error)
    assert_failed_initialization(run, error)
    assert run.step_kinds == ["seed"]
    assert [(a["round"], a["action_args"]) for a in action_records(run)] == [
        (0, {"content": "seed", "post_id": 1})]
    with sqlite3.connect(run.database) as connection:
        assert connection.execute("SELECT post_id FROM post").fetchall() == [(1,)]


@pytest.mark.parametrize("platform", PLATFORMS)
def test_cancelled_seed_before_persistence(tmp_path, monkeypatch, platform):
    error = asyncio.CancelledError("seed cancelled before persistence")
    run = prepare_history(tmp_path, monkeypatch, platform, seed_error=error, fail_before_persistence=True)
    assert_failed_initialization(run, error)
    assert run.step_kinds == ["seed"] and action_records(run) == []
    assert run.fetches[0]["new_cursor"] == 1
    with sqlite3.connect(run.database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM post").fetchone() == (0,)


@pytest.mark.parametrize("platform", PLATFORMS)
def test_required_read_failure_after_seed(tmp_path, monkeypatch, platform):
    error = sqlite3.OperationalError("required initialization trace unavailable")
    run = prepare_history(tmp_path, monkeypatch, platform, read_error=error)
    assert_failed_initialization(run, error)
    assert run.step_kinds == ["seed"] and action_records(run) == []
    with sqlite3.connect(run.database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM post").fetchone() == (1,)


@pytest.mark.parametrize("platform", PLATFORMS)
def test_required_read_failure_without_seeds_or_logger(tmp_path, monkeypatch, platform):
    error = sqlite3.OperationalError("required empty initialization trace unavailable")
    run = prepare_history(tmp_path, monkeypatch, platform, seeds=[], logger=False, read_error=error)
    assert_failed_initialization(run, error)
    assert run.step_kinds == [] and not run.path.exists()


@pytest.mark.parametrize("platform", PLATFORMS)
def test_primary_seed_error_survives_read_and_close_errors(tmp_path, monkeypatch, platform, caplog):
    error = RuntimeError("primary seed error")
    run = prepare_history(tmp_path, monkeypatch, platform, seed_error=error,
                          read_error=sqlite3.OperationalError("secondary trace error"),
                          close_error=RuntimeError("secondary close error"))
    assert_failed_initialization(run, error)
    assert run.step_kinds == ["seed"] and action_records(run) == []
    assert "secondary trace error" in caplog.text
    assert "secondary close error" in caplog.text


@pytest.mark.parametrize("platform", PLATFORMS)
def test_partial_trace_log_write_failure(tmp_path, monkeypatch, platform):
    error = OSError("second trace log append failed")
    run = prepare_history(tmp_path, monkeypatch, platform,
                          seeds=[{"content": "first"}, {"content": "second"}], write_error=error)
    assert_failed_initialization(run, error)
    assert run.step_kinds == ["seed"] and len(run.write_calls) == 2
    assert [(a["round"], a["action_args"]) for a in action_records(run)] == [
        (0, {"content": "first", "post_id": 1})]
    assert run.write_calls[1]["action_args"] == {"content": "second", "post_id": 2}


@pytest.mark.parametrize("platform", PLATFORMS)
def test_no_logger_still_advances_cursor_before_active_read(tmp_path, monkeypatch, platform):
    run = prepare_history(tmp_path, monkeypatch, platform, logger=False)
    result = run.invoke()
    assert run.step_kinds == ["seed", "active"]
    assert [(f["cursor"], f["new_cursor"], f["strict"]) for f in run.fetches] == [(0, 3, True), (3, 5, False)]
    assert [a["action_type"] for a in run.fetches[1]["actions"]] == ["DO_NOTHING"]
    assert result.completed and result.total_actions == 0
    assert result.env is run.env and run.close_count == 0 and not run.env.closed
    assert not run.path.exists()
