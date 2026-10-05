"""Real Flask → Vite proxy → Axios/compiled Vue over synthetic local inference."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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


@contextmanager
def synthetic_trial_model(*, delay=0, truncated=False, empty=False, controls=False, gate=None, entered=None):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, payload, dict(self.headers)))
            if entered is not None:
                entered.set()
            if gate is not None:
                gate.wait(15)
            if delay:
                time.sleep(delay)
            prompt = payload["messages"][-1]["content"]
            content = ("" if empty else "\x00\x1b[31m exact controls\n" + prompt if controls
                       else "<think>literal reasoning</think>\n<script>literal reply</script>\n" + prompt)
            body = json.dumps({
                "id": "synthetic-local-trial", "object": "chat.completion", "created": 1,
                "model": payload["model"], "SECRET_UNKNOWN_FIELD": "not retained",
                "choices": [{"index": 0, "finish_reason": "length" if truncated else "stop",
                             "message": {"role": "assistant", "content": content,
                                         "refusal": "" if empty or controls else None}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 9, "total_tokens": 21},
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)
        assert not thread.is_alive()


@pytest.mark.parametrize("scenario", ["succeeded", "truncated", "lost", "leave", "cloud", "empty", "controls",
                                      "reopen", "reopen_offline", "reopen_single",
                                      "suite_builder", "suite_builder_imported", "suite_builder_offline",
                                      "cancel", "cancel_lost"])
def test_real_prompt_trial_workflow(monkeypatch, scenario, caplog):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Prompt trial workflow requires Node and installed frontend dependencies")

    from app.local_runtime import prompt_trials, readiness
    import neo4j

    # No graph connection or simulation cleanup is part of a prompt trial.
    monkeypatch.setattr(neo4j.AsyncGraphDatabase, "driver", lambda *_args, **_kwargs: pytest.fail("Graph access"))
    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    monkeypatch.setattr(readiness, "register_readiness_shutdown", lambda: None)
    monkeypatch.setattr(prompt_trials, "register_prompt_trials_shutdown", lambda: None)
    # Use an independent logger: the app's 'mirofish' parent intentionally
    # disables propagation, which would make a root caplog check vacuous.
    log_name = "prompt_trials_workflow_test"
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

    cancel_case = scenario in {"cancel", "cancel_lost"}
    gate, entered = (threading.Event(), threading.Event()) if cancel_case else (None, None)
    with synthetic_trial_model(delay=1 if scenario == "leave" else 0,
                               truncated=scenario == "truncated", empty=scenario == "empty",
                               controls=scenario == "controls", gate=gate, entered=entered) as (model_url, calls):
        monkeypatch.setattr(Config, "LLM_BASE_URL", model_url)
        monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", model_url)
        app = create_app()
        observed = []

        if cancel_case:
            @app.get("/__test_trial_model/entered")
            def model_entered():
                return {"entered": entered.is_set()}

            @app.post("/__test_trial_model/release")
            def release_model():
                gate.set()
                return {"released": True}

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
                    "prompt-trial-cancellation-backend-smoke.mjs" if cancel_case
                    else "prompt-trials-backend-smoke.mjs")),
                f"http://127.0.0.1:{server.server_port}", scenario,
            ], cwd=repo / "frontend", capture_output=True, text=True, timeout=45)
            assert run.returncode == 0, run.stdout + run.stderr
            assert "actual proxy/Flask/gateway/Axios/Vue prompt trials passed" in run.stdout
            if scenario == "cloud":
                assert calls == []
                assert local_runtime._gateway is None
                assert all(method == "GET" for method, _path in observed)
            else:
                until = time.monotonic() + 10
                snapshot = prompt_trials.get_prompt_trials_snapshot()
                while snapshot["run"]["state"] == "running" and time.monotonic() < until:
                    time.sleep(0.02)
                    snapshot = prompt_trials.get_prompt_trials_snapshot()
                assert snapshot["run"]["state"] == ("truncated" if scenario == "truncated" else "succeeded")
                expected_calls = (2 if cancel_case else 4 if scenario in {"suite_builder", "suite_builder_imported"}
                                  else 3 if scenario in {"reopen", "reopen_single"}
                                  else 2 if scenario in {"succeeded", "reopen_offline", "suite_builder_offline"}
                                  else 1)
                assert len(calls) == expected_calls
                if scenario.startswith("suite_builder"):
                    assert sum(method == "POST" for method, _path in observed) == expected_calls
                assert all(path == "/v1/chat/completions" for path, _body, _headers in calls)
                assert all(body["model"] == "fixture-local-chat" and not body.get("tools")
                           and not body.get("stream", False) for _path, body, _headers in calls)
                assert all("x-mirofish-timeout-ms" not in {key.lower() for key in headers}
                           for _path, _body, headers in calls)
                assert all("x-mirofish-cancel-on-disconnect" not in {key.lower() for key in headers}
                           for _path, _body, headers in calls)
                if cancel_case:
                    assert sum(method == "POST" and path.endswith("/cancel") for method, path in observed) == 1
                    assert sum(method == "POST" and path == "/api/runtime/trials" for method, path in observed) == 2
                assert "SECRET_" not in json.dumps(snapshot)
                gateway = local_runtime._gateway
                assert gateway is not None
                with httpx.Client(trust_env=False, timeout=2) as client:
                    assert client.get(gateway.start().removesuffix("/v1") + "/health").status_code == 200
            assert "PROMPT_BODY_PRIVATE" not in caplog.text
            assert "SECRET_CONFIG_KEY" not in caplog.text
            assert "请求: GET /api/runtime/trials" in caplog.text
        finally:
            if gate is not None:
                gate.set()
            server.shutdown()
            server.server_close()
            thread.join(5)
            prompt_trials.close_prompt_trials()
            local_runtime.close_local_gateway()
        assert not thread.is_alive()
