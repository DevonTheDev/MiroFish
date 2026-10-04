"""Real suite exports become fresh drafts, then reopen in an offline comparison view."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import threading

import pytest
from werkzeug.serving import make_server

from app import create_app, local_runtime
import app as app_module
from app.config import Config
from app.services.simulation_runner import SimulationRunner


@contextmanager
def comparison_model(*, truncated, json_checks=False):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, payload))
            candidate = payload["model"] == "fixture-candidate"
            prompt = payload["messages"][-1]["content"]
            number = int(prompt.rsplit(" ", 1)[1])
            reply = ("yes" if candidate else "no") if number == 1 else (
                "no" if candidate else "yes") if number == 2 else "<script>literal 雪 reply</script>"
            if json_checks:
                reply = {
                    1: '{"ok":true}' if candidate else '```json\n{"ok":true}\n```',
                    2: '{"value":1e400}' if candidate else '{"value":1}',
                    3: ' {"b":[true,null],"a":"<script>literal 雪</script>"} ' if candidate
                    else '{"a":"<script>literal 雪</script>","b":[true,null]}',
                    4: "yes",
                }[number]
            body = json.dumps({
                "id": "fixture-comparison", "object": "chat.completion", "created": 1,
                "model": payload["model"],
                "choices": [{"index": 0, "finish_reason": "length" if candidate and truncated else "stop",
                             "message": {"role": "assistant", "content": reply, "refusal": None}}],
                "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10},
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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


@pytest.mark.parametrize("scenario", ["completed", "truncated", "json_completed", "json_truncated"])
def test_generated_suite_reports_reopen_and_compare_without_network(monkeypatch, scenario, caplog):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Comparison workflow requires Node and installed frontend dependencies")

    from app.local_runtime import prompt_trials, readiness
    import neo4j

    monkeypatch.setattr(neo4j.AsyncGraphDatabase, "driver", lambda *_a, **_k: pytest.fail("Graph access"))
    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    monkeypatch.setattr(readiness, "register_readiness_shutdown", lambda: None)
    monkeypatch.setattr(prompt_trials, "register_prompt_trials_shutdown", lambda: None)
    log_name = "prompt_suite_comparison_workflow"
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
        "MEMORY_BACKEND": "local", "LOCAL_MODE": True, "DEBUG": False,
        "LLM_MODEL_NAME": "fixture-baseline", "LLM_API_KEY": "SECRET_CONFIG_KEY",
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

    json_checks = scenario.startswith("json_")
    truncated = scenario.endswith("truncated")
    case_count = 4 if json_checks else 3
    with comparison_model(truncated=truncated, json_checks=json_checks) as (model_url, calls):
        monkeypatch.setattr(Config, "LLM_BASE_URL", model_url)
        monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", model_url)
        app = create_app()
        observed = []

        @app.before_request
        def record_request():
            from flask import request
            observed.append((request.method, request.path))

        @app.post("/api/fixture/comparison-config")
        def change_synthetic_configuration():
            from flask import request
            # Test-only route emulates an explicit local configuration change
            # after the first suite finishes; it is never registered in product.
            recover = (request.get_json(silent=True) or {}).get("recover") is True
            snapshot = prompt_trials.get_prompt_trials_snapshot()
            assert snapshot["run"]["state"] == ("truncated" if recover else "succeeded")
            assert not recover or truncated
            prompt_trials._manager.thread.join(5)
            assert not prompt_trials._manager.thread.is_alive()
            local_runtime.close_local_gateway()
            monkeypatch.setattr(Config, "LLM_MODEL_NAME", "fixture-recovery" if recover else "fixture-candidate")
            return {"success": True}

        server = make_server("127.0.0.1", 0, app, threaded=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run([
                node, str(repo / "frontend/tests/fixtures/prompt-suite-comparison-backend-smoke.mjs"),
                f"http://127.0.0.1:{server.server_port}", scenario,
            ], cwd=repo / "frontend", capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            assert "actual suite exports imported and compared offline" in result.stdout
            expected = 2 * case_count + (1 if truncated else 0)
            assert len(calls) == expected
            assert sum(method == "POST" and path == "/api/runtime/trials" for method, path in observed) == expected
            assert all(path == "/v1/chat/completions" for path, _body in calls)
            expected_models = (["fixture-baseline"] * case_count + ["fixture-candidate"] *
                               (1 if truncated else case_count) + (["fixture-recovery"] * case_count if truncated else []))
            assert [body["model"] for _path, body in calls] == expected_models
            assert all("response_format" not in body and "tools" not in body and
                       "check_kind" not in body and "expected_text" not in body for _path, body in calls)
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
