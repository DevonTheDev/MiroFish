"""OASIS's local policy is bounded and never loads recommender weights."""

import ast
import json
import types
from pathlib import Path

import pytest
from app.config import Config


@pytest.mark.parametrize(
    "script,function,method",
    [
        ("run_parallel_simulation.py", "create_model", False),
        ("run_twitter_simulation.py", "_create_model", True),
        ("run_reddit_simulation.py", "_create_model", True),
    ],
)
def test_each_script_uses_local_model_even_when_boost_is_configured(
    monkeypatch, script, function, method
):
    import os

    monkeypatch.setattr(Config, "LOCAL_MODE", True, raising=False)
    monkeypatch.setenv("LLM_BOOST_API_KEY", "secret-not-to-use")
    monkeypatch.setenv("LLM_BOOST_BASE_URL", "https://cloud.invalid/v1")
    tree = ast.parse((Path(__file__).parents[1] / "scripts" / script).read_text())
    node = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == function
    )
    sentinel = object()
    namespace = {
        "Config": Config,
        "create_local_model": lambda: sentinel,
        "os": os,
        "Dict": dict,
        "Any": object,
        "ModelFactory": types.SimpleNamespace(create=lambda **_kwargs: "cloud"),
        "ModelPlatformType": types.SimpleNamespace(OPENAI="openai"),
    }
    exec(compile(ast.Module(body=[node], type_ignores=[]), script, "exec"), namespace)
    args = [types.SimpleNamespace(config={})] if method else [{}]
    assert namespace[function](*args) is sentinel


def test_local_token_counter_never_requires_download_and_counts_unicode():
    from app.local_runtime.oasis import ConservativeTokenCounter

    counter = ConservativeTokenCounter()
    text = "Hello 世界"
    assert counter.decode(counter.encode(text)) == text
    assert counter.count_tokens_from_messages(
        [{"role": "user", "content": text}]
    ) >= len(text.encode("utf-8"))


def test_local_twitter_uses_random_cpu_policy(monkeypatch):
    from app.local_runtime.oasis import platform_for_mode

    monkeypatch.setattr(Config, "LOCAL_MODE", True, raising=False)
    calls = []

    def platform(**kwargs):
        calls.append(kwargs)
        return kwargs

    result = platform_for_mode("twitter", "/tmp/example.db", platform_factory=platform)
    assert result["recsys_type"] == "random"
    assert result["use_openai_embedding"] is False
    assert result["refresh_rec_post_count"] == 2
    assert len(calls) == 1


def test_local_reddit_retains_native_policy(monkeypatch):
    from app.local_runtime.oasis import platform_for_mode

    monkeypatch.setattr(Config, "LOCAL_MODE", True, raising=False)
    assert (
        platform_for_mode("reddit", "unused.db", default_platform="reddit-platform")
        == "reddit-platform"
    )


def test_cloud_twitter_retains_native_policy(monkeypatch):
    from app.local_runtime.oasis import platform_for_mode

    monkeypatch.setattr(Config, "LOCAL_MODE", False, raising=False)
    assert (
        platform_for_mode("twitter", "unused.db", default_platform="twitter-platform")
        == "twitter-platform"
    )


def test_each_script_bounds_local_platform_requests():
    for script in (
        Path(__file__).parents[1].joinpath("scripts").glob("run_*simulation.py")
    ):
        calls = [
            node
            for node in ast.walk(ast.parse(script.read_text()))
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "make"
        ]
        for call in calls:
            concurrency = next(k.value for k in call.keywords if k.arg == "semaphore")
            assert (
                isinstance(concurrency, ast.Call)
                and concurrency.func.id == "simulation_concurrency"
            )


def test_frontend_has_no_automatic_external_font_fetch():
    contents = Path(__file__).parents[2].joinpath("frontend/index.html").read_text()
    assert "fonts.googleapis.com" not in contents
    assert "fonts.gstatic.com" not in contents


def test_real_pinned_local_oasis_platform_and_model(tmp_path, monkeypatch):
    """Optional full-extra contract test: real CAMEL, OASIS, SQLite and CPU recsys."""
    import asyncio
    import csv

    pytest.importorskip(
        "camel", reason="install the local extra for pinned-runtime integration"
    )
    from app.local_runtime import configure_local_environment
    from app.local_runtime import oasis as policy

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    configure_local_environment()
    oasis = pytest.importorskip(
        "oasis", reason="install the local extra for pinned-runtime integration"
    )
    monkeypatch.setattr(
        policy, "get_local_gateway_url", lambda: "http://127.0.0.1:12345/v1"
    )
    model = policy.create_local_model()
    assert model._client.api_key == "local"
    assert str(model._client.base_url) == "http://127.0.0.1:12345/v1/"
    assert (
        model.token_limit
        == Config.LOCAL_CONTEXT_TOKENS - Config.LOCAL_MAX_OUTPUT_TOKENS
    )
    profile = tmp_path / "profiles.csv"
    with profile.open("w", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=["username", "description", "user_char"]
        )
        writer.writeheader()
        writer.writerow(
            {
                "username": "Alice",
                "description": "Local test agent",
                "user_char": "Enjoys books",
            }
        )

    async def run():
        graph = await oasis.generate_twitter_agent_graph(
            str(profile),
            model=model,
            available_actions=[
                oasis.ActionType.CREATE_POST,
                oasis.ActionType.DO_NOTHING,
            ],
        )
        db = str(tmp_path / "simulation.db")
        env = oasis.make(
            agent_graph=graph,
            platform=policy.platform_for_mode("twitter", db),
            database_path=db,
            semaphore=policy.simulation_concurrency(),
        )
        await env.reset()
        try:
            agent = graph.get_agent(0)
            await env.step(
                {
                    agent: oasis.ManualAction(
                        action_type=oasis.ActionType.CREATE_POST,
                        action_args={"content": "An offline post"},
                    )
                }
            )
            assert (
                env.platform.db.execute("SELECT content FROM post").fetchone()[0]
                == "An offline post"
            )
            await env.platform.update_rec_table()
            from oasis.social_platform import recsys

            assert recsys.twhin_model is None
            assert recsys.twhin_tokenizer is None
            assert recsys.model is None
            assert env.llm_semaphore._value == Config.LOCAL_MAX_CONCURRENCY
        finally:
            await env.close()
            model._client.close()
            await model._async_client.close()

    asyncio.run(run())


def test_local_limits_are_explicit_and_cloud_limits_unchanged(monkeypatch):
    from app.local_runtime.oasis import limit_rounds, validate_agent_count

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", 5, raising=False)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 10, raising=False)
    assert limit_rounds(None) == 5
    assert limit_rounds(2) == 2
    assert limit_rounds(50) == 5
    validate_agent_count(10)
    with pytest.raises(ValueError, match="LOCAL_MAX_AGENTS"):
        validate_agent_count(11)
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    assert limit_rounds(None) is None
    assert limit_rounds(50) == 50
    validate_agent_count(1000)


def test_all_launchers_apply_local_agent_and_round_caps():
    for script in (
        Path(__file__).parents[1].joinpath("scripts").glob("run_*simulation.py")
    ):
        calls = [
            node.func.id
            for node in ast.walk(ast.parse(script.read_text()))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        ]
        assert "validate_agent_count" in calls, script.name
        assert "limit_rounds" in calls, script.name


@pytest.mark.parametrize(
    "script", ["run_twitter_simulation.py", "run_reddit_simulation.py"]
)
def test_standalone_caps_are_applied_in_run_not_agent_selection(script):
    tree = ast.parse(Path(__file__).parents[1].joinpath("scripts", script).read_text())
    run = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "run"
    )
    names = [
        node.func.id
        for node in ast.walk(run)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    ]
    assert "limit_rounds" in names
    assert "validate_agent_count" in names


def test_real_camel_and_app_sdk_share_bounded_local_transport(monkeypatch):
    import asyncio

    pytest.importorskip(
        "camel", reason="install the local extra for pinned-runtime integration"
    )
    from app import local_runtime
    from app.local_runtime import oasis as policy
    from app.utils.llm_client import LLMClient
    from app.local_runtime.gateway import LocalInferenceGateway, GatewaySettings
    from test_local_gateway import upstream_server

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LLM_MODEL_NAME", "synthetic-local")
    with upstream_server() as upstream:
        upstream.body = {
            "id": "synthetic",
            "object": "chat.completion",
            "created": 1,
            "model": "synthetic-local",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": '{"ready":true}'},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        gateway = LocalInferenceGateway(
            GatewaySettings(
                upstream.url,
                upstream.url,
                max_output_tokens=128,
                reasoning_effort="none",
            )
        )
        base_url = gateway.start()
        monkeypatch.setattr(local_runtime, "get_local_gateway_url", lambda: base_url)
        monkeypatch.setattr(policy, "get_local_gateway_url", lambda: base_url)
        model = policy.create_local_model()
        app_client = LLMClient()
        try:
            assert app_client.chat_json(
                [{"role": "user", "content": "Return JSON"}]
            ) == {"ready": True}
            response = asyncio.run(
                model.arun([{"role": "user", "content": "Return JSON"}])
            )
            assert response.choices[0].message.content == '{"ready":true}'
            assert len(upstream.calls) == 2
            for _, payload, headers in upstream.calls:
                assert payload["max_tokens"] == 128
                assert payload["reasoning_effort"] == "none"
                assert headers["Authorization"] == "Bearer local"
        finally:
            app_client.client.close()
            model._client.close()
            asyncio.run(model._async_client.close())
            gateway.close()


def test_local_agent_tool_loops_have_a_finite_iteration_budget(monkeypatch):
    from app.local_runtime.oasis import configure_agent_limits

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENT_ITERATIONS", 3, raising=False)
    agents = [
        types.SimpleNamespace(max_iteration=None),
        types.SimpleNamespace(max_iteration=None),
    ]
    graph = types.SimpleNamespace(get_agents=lambda: enumerate(agents))
    configure_agent_limits(graph)
    assert [agent.max_iteration for agent in agents] == [3, 3]
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    configure_agent_limits(graph)
    assert [agent.max_iteration for agent in agents] == [3, 3]


@pytest.mark.parametrize("requested", [0, -1, None, 99])
def test_runner_cannot_bypass_local_round_cap_with_unlimited_sentinel(
    tmp_path, monkeypatch, requested
):
    from app.services import simulation_runner

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LOCAL_MAX_ROUNDS", 5)
    monkeypatch.setattr(
        simulation_runner.SimulationRunner, "RUN_STATE_DIR", str(tmp_path)
    )
    simulation = tmp_path / "sim_test"
    simulation.mkdir()
    (simulation / "simulation_config.json").write_text(
        json.dumps(
            {
                "time_config": {"total_simulation_hours": 72, "minutes_per_round": 30},
                "agent_configs": [],
            }
        )
    )
    captured = {}

    class StopBeforeSpawn(Exception):
        pass

    def state(**kwargs):
        captured.update(kwargs)
        raise StopBeforeSpawn

    monkeypatch.setattr(simulation_runner, "SimulationRunState", state)
    with pytest.raises(StopBeforeSpawn):
        simulation_runner.SimulationRunner.start_simulation(
            "sim_test", max_rounds=requested
        )
    assert captured["total_rounds"] == 5


@pytest.mark.parametrize("requested", [True, 1.5, "10"])
def test_local_round_helper_rejects_ambiguous_types(monkeypatch, requested):
    from app.local_runtime.oasis import limit_rounds

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    with pytest.raises(ValueError, match="integer"):
        limit_rounds(requested)
