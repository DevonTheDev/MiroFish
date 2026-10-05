"""Actual local inference through Flask, Vite, Axios and the compiled suite UI."""

import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

import httpx
import pytest
from werkzeug.serving import make_server

from app import create_app, local_runtime
import app as app_module
from app.config import Config
from app.services.simulation_runner import SimulationRunner
from test_prompt_trials_frontend_workflow import synthetic_trial_model


@pytest.mark.parametrize("scenario", ["sequence", "lost", "unknown", "stop", "leave", "cloud", "truncated", "empty",
                                      "pause_resume", "pause_stop", "pause_lost", "editing", "selection"])
def test_real_prompt_suite_workflow(monkeypatch, scenario, caplog):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Prompt suite workflow requires Node and installed frontend dependencies")

    from app.local_runtime import prompt_trials, readiness
    import neo4j

    monkeypatch.setattr(neo4j.AsyncGraphDatabase, "driver", lambda *_a, **_k: pytest.fail("Graph access"))
    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    monkeypatch.setattr(readiness, "register_readiness_shutdown", lambda: None)
    monkeypatch.setattr(prompt_trials, "register_prompt_trials_shutdown", lambda: None)
    log_name = "prompt_suites_workflow_test"
    caplog.set_level(logging.DEBUG, logger=log_name)
    monkeypatch.setattr(app_module, "get_logger", lambda _name: logging.getLogger(log_name))
    for name, value in {"_manager": None, "_closing": False, "_cleanup_failed": False,
                        "_owner_pid": os.getpid(), "_lock": threading.Lock()}.items():
        monkeypatch.setattr(prompt_trials, name, value)
    monkeypatch.delenv("MIROFISH_LOCAL_GATEWAY_URL", raising=False)
    monkeypatch.setattr(local_runtime, "_gateway", None)
    monkeypatch.setattr(local_runtime, "_gateway_starting", None)
    monkeypatch.setattr(local_runtime, "_gateway_lock", threading.Lock())
    for name, value in {
        "MEMORY_BACKEND": "zep" if scenario == "cloud" else "local",
        "LOCAL_MODE": scenario != "cloud", "DEBUG": False,
        "LLM_MODEL_NAME": "fixture-local-chat", "LLM_API_KEY": "SECRET_CONFIG_KEY",
        "ZEP_API_KEY": "SECRET_ZEP_KEY", "LOCAL_EMBEDDING_MODEL": "fixture-embedding",
        "LOCAL_EMBEDDING_DIMENSIONS": 3, "LOCAL_GRAPH_URI": "bolt://127.0.0.1:9",
        "LOCAL_GRAPH_USER": "neo4j", "LOCAL_GRAPH_PASSWORD": "SECRET_GRAPH_PASSWORD",
        "LOCAL_GRAPH_DATABASE": "neo4j", "LOCAL_MAX_AGENTS": 10,
        "LOCAL_MAX_ROUNDS": 5, "LOCAL_MAX_AGENT_ITERATIONS": 3,
        "LOCAL_MAX_CONCURRENCY": 1, "LOCAL_MAX_QUEUE": 4,
        "LOCAL_REQUEST_TIMEOUT": 5, "LOCAL_MAX_OUTPUT_TOKENS": 512,
        "LOCAL_CONTEXT_TOKENS": 8192, "LOCAL_MAX_INPUT_CHARS": 24000,
        "LOCAL_REASONING_EFFORT": "none",
    }.items():
        monkeypatch.setattr(Config, name, value)

    with synthetic_trial_model(delay=1 if scenario in {"stop", "leave", "unknown", "pause_resume", "pause_stop", "pause_lost", "editing", "selection"} else 0,
                               truncated=scenario == "truncated", empty=scenario == "empty") as (model_url, calls):
        monkeypatch.setattr(Config, "LLM_BASE_URL", model_url)
        monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", model_url)
        app = create_app()
        observed = []

        @app.before_request
        def record_request():
            from flask import request
            observed.append((request.method, request.path))

        server = make_server("127.0.0.1", 0, app, threaded=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            run = subprocess.run([
                node, str(repo / "frontend/tests/fixtures" / (
                    "prompt-suite-editing-backend-smoke.mjs" if scenario == "editing"
                    else "prompt-suite-selection-backend-smoke.mjs" if scenario == "selection"
                    else "prompt-suites-backend-smoke.mjs")),
                f"http://127.0.0.1:{server.server_port}", scenario,
            ], cwd=repo / "frontend", capture_output=True, text=True, timeout=90)
            assert run.returncode == 0, run.stdout + run.stderr
            assert "actual proxy/Flask/gateway/Axios/Vue prompt suites passed" in run.stdout
            if scenario == "cloud":
                assert calls == [] and local_runtime._gateway is None
                assert all(method == "GET" for method, _path in observed)
            else:
                until = time.monotonic() + 10
                snapshot = prompt_trials.get_prompt_trials_snapshot()
                while snapshot["run"]["state"] == "running" and time.monotonic() < until:
                    time.sleep(0.02)
                    snapshot = prompt_trials.get_prompt_trials_snapshot()
                assert snapshot["run"]["state"] == ("truncated" if scenario == "truncated" else "succeeded")
                expected = (2 if scenario == "selection" else 3 if scenario == "editing" else
                            5 if scenario in {"sequence", "lost", "empty", "pause_resume", "pause_lost"} else 1)
                assert len(calls) == expected
                assert sum(method == "POST" for method, _ in observed) == expected
                assert all(path == "/v1/chat/completions" for path, _body, _headers in calls)
                assert all(body["model"] == "fixture-local-chat" and not body.get("tools")
                           and not body.get("stream", False) for _path, body, _headers in calls)
                assert all("x-mirofish-timeout-ms" not in {key.lower() for key in headers}
                           for _path, _body, headers in calls)
                assert "SECRET_" not in json.dumps(snapshot)
                with httpx.Client(trust_env=False, timeout=2) as client:
                    assert client.get(local_runtime._gateway.start().removesuffix("/v1") + "/health").status_code == 200
            assert "PROMPT_BODY_PRIVATE" not in caplog.text
            assert "SECRET_CONFIG_KEY" not in caplog.text
            assert "请求: GET /api/runtime/trials" in caplog.text
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
            prompt_trials.close_prompt_trials()
            local_runtime.close_local_gateway()
        assert not thread.is_alive()
