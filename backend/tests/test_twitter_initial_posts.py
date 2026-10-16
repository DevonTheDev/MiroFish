"""Both Twitter builders preserve eligible initial action occurrences in one step."""

import asyncio
from collections import Counter
import importlib
import sqlite3

import pytest

from test_single_platform_progress import prepare_run, read_events


def prepare_twitter(tmp_path, monkeypatch, builder, posts, *, fail_step=None):
    pytest.importorskip("oasis")
    run = prepare_run(tmp_path, monkeypatch, "twitter", seeds=False,
                      active_rounds=(), fail_step=fail_step)
    run.runner.config["event_config"]["initial_posts"] = posts
    run.runner.wait_for_commands = False
    run.captured = []
    original_step = run.env.step

    async def capture_step(actions):
        run.captured.append(dict(actions))
        await original_step(actions)

    monkeypatch.setattr(run.env, "step", capture_step)
    original_lookup = run.env.agent_graph.get_agent

    def lookup(agent_id):
        if agent_id == -1:
            raise RuntimeError("Synthetic lookup failure")
        if agent_id == 10:
            return original_lookup(0)  # Different IDs resolving to the same agent.
        return original_lookup(agent_id)

    monkeypatch.setattr(run.env.agent_graph, "get_agent", lookup)
    if builder == "standalone":
        run.builder_script = run.script

        async def execute():
            await run.runner.run(max_rounds=1)
            assert run.env.closed
    else:
        parallel = importlib.import_module("scripts.run_parallel_simulation")
        run.builder_script = parallel
        monkeypatch.setattr(parallel, "make_oasis_environment", lambda **kwargs: run.env)
        monkeypatch.setattr(parallel, "create_model", lambda *args, **kwargs: object())
        monkeypatch.setattr(parallel, "generate_twitter_agent_graph", run.script.generate_twitter_agent_graph)
        monkeypatch.setattr(parallel, "platform_for_mode", run.script.platform_for_mode)
        monkeypatch.setattr(parallel, "get_active_agents_for_round", lambda *args: [])
        monkeypatch.setattr(parallel, "_shutdown_event", asyncio.Event())
        logger = parallel.PlatformActionLogger("twitter", run.runner.simulation_dir)

        async def execute():
            result = await parallel.run_twitter_simulation(
                run.runner.config, run.runner.simulation_dir, action_logger=logger, max_rounds=1)
            assert result.env is run.env and result.completed
            assert not run.env.closed  # Successful parallel environments remain available.
            await result.env.close()

    run.execute = execute
    return run


def assert_submitted(run, expected):
    """Check identity, list representation/order and occurrences, not completion order."""
    assert len(run.captured) == (1 if expected else 0)
    assert run.env.steps == (1 if expected else 0)
    if not expected:
        return
    actions = run.captured[0]
    agents = dict(run.env.agent_graph.get_agents())
    assert list(actions) == [agents[agent_id] for agent_id in expected]
    for agent_id, contents in expected.items():
        selected = actions[agents[agent_id]]
        assert isinstance(selected, list) == (len(contents) > 1)
        members = selected if isinstance(selected, list) else [selected]
        assert [action.action_args for action in members] == [{"content": content} for content in contents]
        assert all(action.action_type == run.script.ActionType.CREATE_POST for action in members)


def assert_persisted(run, expected):
    with sqlite3.connect(run.path.parent.parent / "twitter_simulation.db") as connection:
        actual = connection.execute("SELECT user_id, content FROM post").fetchall()
    assert Counter(actual) == Counter((agent_id, content) for agent_id, contents in expected.items()
                                      for content in contents)


CASES = [
    pytest.param([], {}, id="empty"),
    pytest.param([{"poster_agent_id": 1, "content": "single"}], {1: ["single"]}, id="single"),
    pytest.param([{"poster_agent_id": 0, "content": "first"}, {"poster_agent_id": 0, "content": "second"}],
                 {0: ["first", "second"]}, id="repeated-owner"),
    pytest.param([{"poster_agent_id": 0, "content": "same"}, {"poster_agent_id": 0, "content": "same"}],
                 {0: ["same", "same"]}, id="identical-occurrences"),
    pytest.param([{"poster_agent_id": 0, "content": "first"}, {"poster_agent_id": 1, "content": "other"},
                  {"poster_agent_id": 0, "content": "last"}], {0: ["first", "last"], 1: ["other"]}, id="interleaved"),
    pytest.param([{"poster_agent_id": 1, "content": "bob"}, {"poster_agent_id": 0, "content": "alice"}],
                 {1: ["bob"], 0: ["alice"]}, id="distinct-owners"),
    pytest.param([{}], {0: [""]}, id="omitted-owner-and-content"),
    pytest.param([{"poster_agent_id": 99}, {"poster_agent_id": 98}], {}, id="all-unknown"),
    pytest.param([{"poster_agent_id": 99}, {"poster_agent_id": 0, "content": "eligible"}],
                 {0: ["eligible"]}, id="unknown-then-valid"),
    pytest.param([{"poster_agent_id": -1}, {"poster_agent_id": 0, "content": "eligible"}],
                 {0: ["eligible"]}, id="lookup-failure-then-valid"),
    pytest.param([{"poster_agent_id": 0, "content": "first"}, {"poster_agent_id": 10, "content": "alias"}],
                 {0: ["first", "alias"]}, id="same-resolved-agent"),
]


@pytest.mark.parametrize("builder", ["standalone", "parallel"])
@pytest.mark.parametrize("posts,expected", CASES)
def test_twitter_seed_submission(tmp_path, monkeypatch, capsys, builder, posts, expected):
    run = prepare_twitter(tmp_path, monkeypatch, builder, posts)
    asyncio.run(run.execute())
    assert_submitted(run, expected)
    assert_persisted(run, expected)
    count = sum(len(contents) for contents in expected.values())
    output = capsys.readouterr().out
    if count:
        assert output.count(f"已提交 {count} 条初始发帖动作") == 1
    else:
        assert "条初始发帖动作" not in output
    if any(post.get("poster_agent_id") in {-1, 98, 99} for post in posts):
        assert ("警告: 无法为Agent" in output) == (builder == "standalone")


@pytest.mark.parametrize("builder", ["standalone", "parallel"])
def test_seed_step_failure_retains_cleanup_and_does_not_report_submission(tmp_path, monkeypatch, capsys, builder):
    posts = [{"content": "first"}, {"content": "second"}]
    run = prepare_twitter(tmp_path, monkeypatch, builder, posts, fail_step=1)
    with pytest.raises(RuntimeError, match="Synthetic environment step failed"):
        asyncio.run(run.execute())
    assert_submitted(run, {0: ["first", "second"]})
    assert_persisted(run, {})
    assert run.env.closed
    assert "条初始发帖动作" not in capsys.readouterr().out
    assert not any(event.get("event_type") == "simulation_end" for event in read_events(run))


@pytest.mark.parametrize("builder", ["standalone", "parallel"])
def test_non_mapping_seed_still_fails_before_step_and_closes(tmp_path, monkeypatch, capsys, builder):
    run = prepare_twitter(tmp_path, monkeypatch, builder, [{"content": "first"}, None])
    with pytest.raises(AttributeError, match="get"):
        asyncio.run(run.execute())
    assert run.captured == [] and run.env.steps == 0
    assert_persisted(run, {})
    assert run.env.closed
    assert "条初始发帖动作" not in capsys.readouterr().out


@pytest.mark.parametrize("builder", ["standalone", "parallel"])
def test_action_construction_failure_keeps_prior_and_later_eligible_posts(tmp_path, monkeypatch, capsys, builder):
    posts = [{"content": "first"}, {"content": "reject"}, {"content": "later"}]
    run = prepare_twitter(tmp_path, monkeypatch, builder, posts)
    original = run.script.ManualAction

    class RejectingAction(original):
        def __init__(self, *, action_type, action_args):
            if action_args["content"] == "reject":
                raise ValueError("Synthetic construction failure")
            super().__init__(action_type=action_type, action_args=action_args)

    monkeypatch.setattr(run.script, "ManualAction", RejectingAction)
    monkeypatch.setattr(run.builder_script, "ManualAction", RejectingAction)
    asyncio.run(run.execute())
    assert_submitted(run, {0: ["first", "later"]})
    assert_persisted(run, {0: ["first", "later"]})
    assert "已提交 2 条初始发帖动作" in capsys.readouterr().out
