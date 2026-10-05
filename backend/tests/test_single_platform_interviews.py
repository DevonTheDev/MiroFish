"""Exercise real command files, single-environment dispatch, SQLite and consumers."""

import asyncio
import importlib
import json
import sqlite3
import time
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api import simulation as api
from app.config import Config
from app.services import simulation_ipc
from app.services.simulation_manager import SimulationManager
from app.services.simulation_runner import SimulationRunner
from app.services.zep_tools import ZepToolsService


def make_single_environment(tmp_path, monkeypatch, platform):
    """Use real scripts and IPC; substitute only model-dependent environment steps."""
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    pytest.importorskip("camel")
    script = importlib.import_module(f"scripts.run_{platform}_simulation")
    simulation_dir = tmp_path / "sim_single"
    simulation_dir.mkdir(exist_ok=True)
    database = simulation_dir / f"{platform}_simulation.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE trace (user_id INTEGER, info TEXT, created_at TEXT, action TEXT)")

    class Agent:
        def __init__(self, agent_id):
            self.agent_id = agent_id

    agents = {index: Agent(index) for index in range(2)}

    class Environment:
        def __init__(self):
            self.actions = []

        async def step(self, actions):
            self.actions.append(actions)
            with sqlite3.connect(database) as connection:
                for agent, action in actions.items():
                    assert action.action_type == script.ActionType.INTERVIEW
                    connection.execute("INSERT INTO trace VALUES (?, ?, ?, ?)", (
                        agent.agent_id,
                        json.dumps({"response": f"{platform} reply from {agent.agent_id}", "prompt": action.action_args["prompt"]}),
                        "2026-10-05T00:00:00", script.ActionType.INTERVIEW.value,
                    ))

    env = Environment()
    handler = script.IPCHandler(str(simulation_dir), env, SimpleNamespace(get_agent=agents.__getitem__))
    handler.update_status("alive")
    # Keep the real file-based client; dispatch its queued command at each wait.
    monkeypatch.setattr(simulation_ipc, "time", SimpleNamespace(
        time=time.monotonic, sleep=lambda delay: asyncio.run(handler.process_commands()),
    ))
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path))
    (simulation_dir / "simulation_config.json").write_text(json.dumps({
        "agent_configs": [{"agent_id": index} for index in agents],
    }))
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    return handler, env, app.test_client()


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
@pytest.mark.parametrize("endpoint", ["batch", "all"])
def test_actual_single_dispatch_reaches_batch_and_all_api_consumers(tmp_path, monkeypatch, platform, endpoint):
    _, env, client = make_single_environment(tmp_path, monkeypatch, platform)
    body = {"simulation_id": "sim_single", "timeout": 2}
    if endpoint == "all":
        body["prompt"] = "What happened?"
    else:
        body["interviews"] = [{"agent_id": index, "prompt": "What happened?"} for index in range(2)]
    response = client.post(f"/api/simulation/interview/{endpoint}", json=body)
    assert response.status_code == 200, response.json
    assert response.json["success"] is True, response.json
    payload = response.json["data"]["result"]
    assert payload["platform"] == platform
    assert payload["platforms"] == [platform]
    assert set(payload["results"]) == {f"{platform}_0", f"{platform}_1"}
    assert payload["interviews_count"] == 2
    assert payload["results"][f"{platform}_1"]["response"] == f"{platform} reply from 1"
    assert all(item["platform"] == platform for item in payload["results"].values())
    assert len(env.actions) == 1


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_actual_single_interview_dispatch_returns_actual_platform(tmp_path, monkeypatch, platform):
    _, env, client = make_single_environment(tmp_path, monkeypatch, platform)
    response = client.post("/api/simulation/interview", json={
        "simulation_id": "sim_single", "agent_id": 0, "prompt": "Question", "timeout": 2,
    })
    assert response.json["success"] is True
    assert response.json["data"]["result"]["platform"] == platform
    assert response.json["data"]["result"]["response"] == f"{platform} reply from 0"
    assert len(env.actions) == 1


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
@pytest.mark.parametrize("status", ["alive", "stopped"])
def test_single_environment_status_reports_actual_available_platform(tmp_path, monkeypatch, platform, status):
    handler, _, client = make_single_environment(tmp_path, monkeypatch, platform)
    handler.update_status(status)
    response = client.post("/api/simulation/env-status", json={"simulation_id": "sim_single"})
    assert response.json["success"] is True
    data = response.json["data"]
    assert data["env_alive"] is (status == "alive")
    assert data["twitter_available"] is (platform == "twitter")
    assert data["reddit_available"] is (platform == "reddit")
    # Match parallel status semantics: availability means an environment exists.
    handler.env = None
    handler.update_status("stopped")
    data = client.post("/api/simulation/env-status", json={"simulation_id": "sim_single"}).json["data"]
    assert data["env_alive"] is False
    assert data["twitter_available"] is False
    assert data["reddit_available"] is False


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
@pytest.mark.parametrize("endpoint", ["", "/batch", "/all"])
def test_opposite_platform_request_never_interviews_single_environment(tmp_path, monkeypatch, platform, endpoint):
    _, env, client = make_single_environment(tmp_path, monkeypatch, platform)
    opposite = "reddit" if platform == "twitter" else "twitter"
    response = client.post(f"/api/simulation/interview{endpoint}", json={
        "simulation_id": "sim_single", "agent_id": 0, "prompt": "Question", "platform": opposite,
        "interviews": [{"agent_id": 0, "prompt": "Question"}], "timeout": 2,
    })
    assert response.json["success"] is False
    assert env.actions == []


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_mixed_batch_is_rejected_before_any_agent_action(tmp_path, monkeypatch, platform):
    _, env, client = make_single_environment(tmp_path, monkeypatch, platform)
    opposite = "reddit" if platform == "twitter" else "twitter"
    response = client.post("/api/simulation/interview/batch", json={
        "simulation_id": "sim_single", "platform": platform, "timeout": 2,
        "interviews": [{"agent_id": 0, "prompt": "Valid"}, {"agent_id": 1, "prompt": "Invalid", "platform": opposite}],
    })
    assert response.json["success"] is False
    assert env.actions == []


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
@pytest.mark.parametrize("override", [None, "actual"])
def test_item_platform_override_precedes_incompatible_batch_default(tmp_path, monkeypatch, platform, override):
    _, env, client = make_single_environment(tmp_path, monkeypatch, platform)
    opposite = "reddit" if platform == "twitter" else "twitter"
    response = client.post("/api/simulation/interview/batch", json={
        "simulation_id": "sim_single", "platform": opposite, "timeout": 2,
        "interviews": [{"agent_id": 0, "prompt": "Question", "platform": platform if override else None}],
    })
    assert response.json["success"] is True, response.json
    assert set(response.json["data"]["result"]["results"]) == {f"{platform}_0"}
    assert len(env.actions) == 1


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
@pytest.mark.parametrize("requested", ["bogus", "", False, ["twitter"]])
def test_direct_command_dispatch_rejects_invalid_platforms(tmp_path, monkeypatch, platform, requested):
    handler, env, _ = make_single_environment(tmp_path, monkeypatch, platform)
    command = {"command_id": "invalid", "command_type": "batch_interview", "args": {
        "platform": requested, "interviews": [{"agent_id": 0, "prompt": "Question"}],
    }}
    (tmp_path / "sim_single" / "ipc_commands" / "invalid.json").write_text(json.dumps(command))
    asyncio.run(handler.process_commands())
    response = json.loads((tmp_path / "sim_single" / "ipc_responses" / "invalid.json").read_text())
    assert response["status"] == "failed"
    assert env.actions == []


def _report_service(monkeypatch):
    service = object.__new__(ZepToolsService)
    profiles = [{"username": "alice", "bio": "Bio"}]
    monkeypatch.setattr(service, "_load_agent_profiles", lambda simulation_id: profiles)
    monkeypatch.setattr(service, "_select_agents_for_interview", lambda **kwargs: (profiles, [0], "Relevant participant"))
    monkeypatch.setattr(service, "_generate_interview_summary", lambda **kwargs: "Summary")
    return service


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_actual_single_batch_report_has_only_available_platform(tmp_path, monkeypatch, platform):
    _, env, _ = make_single_environment(tmp_path, monkeypatch, platform)
    service = _report_service(monkeypatch)
    result = service.interview_agents("sim_single", "Perspective", custom_questions=["Question"])
    assert result.interviewed_count == 1
    assert result.interviews[0].response == f"【{platform.title()}平台回答】\n{platform} reply from 0"
    assert len(env.actions) == 1


def test_legacy_report_payload_retains_both_platform_sections(monkeypatch):
    service = _report_service(monkeypatch)
    monkeypatch.setattr(SimulationRunner, "interview_agents_batch", lambda **kwargs: {
        "success": True, "result": {"results": {"twitter_0": {"response": "Legacy reply"}}},
    })
    result = service.interview_agents("sim_legacy", "Perspective", custom_questions=["Question"])
    assert result.interviews[0].response == "【Twitter平台回答】\nLegacy reply\n\n【Reddit平台回答】\n（该平台未获得回复）"


@pytest.mark.parametrize("platform", [None, "twitter", "reddit"])
def test_parallel_dispatch_preserves_existing_platform_routing(tmp_path, monkeypatch, platform):
    twitter, twitter_env, _ = make_single_environment(tmp_path, monkeypatch, "twitter")
    reddit, reddit_env, client = make_single_environment(tmp_path, monkeypatch, "reddit")
    script = importlib.import_module("scripts.run_parallel_simulation")
    handler = script.ParallelIPCHandler(
        str(tmp_path / "sim_single"), twitter_env, twitter.agent_graph, reddit_env, reddit.agent_graph,
    )
    handler.update_status("alive")
    monkeypatch.setattr(simulation_ipc, "time", SimpleNamespace(
        time=time.monotonic, sleep=lambda delay: asyncio.run(handler.process_commands()),
    ))
    response = client.post("/api/simulation/interview/batch", json={
        "simulation_id": "sim_single", "platform": platform, "timeout": 2,
        "interviews": [{"agent_id": 0, "prompt": "Question"}],
    })
    assert response.json["success"] is True, response.json
    expected = [platform] if platform else ["twitter", "reddit"]
    payload = response.json["data"]["result"]
    assert set(payload["results"]) == {f"{item}_0" for item in expected}
    assert payload["interviews_count"] == len(expected)
    assert len(twitter_env.actions) == int("twitter" in expected)
    assert len(reddit_env.actions) == int("reddit" in expected)
    assert "platform" not in payload  # Preserve the legacy parallel envelope.
    if platform is None:
        report = _report_service(monkeypatch).interview_agents("sim_single", "Perspective", custom_questions=["Question"])
        assert report.interviews[0].response == "【Twitter平台回答】\ntwitter reply from 0\n\n【Reddit平台回答】\nreddit reply from 0"
