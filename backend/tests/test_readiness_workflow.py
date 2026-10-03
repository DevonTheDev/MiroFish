"""Explicit browser workflow through real local SDK transport and disposable DB."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
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
from app.config import Config
from app.services.simulation_runner import SimulationRunner


@contextmanager
def synthetic_models(delay=0, invalid_schema=False):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, payload, dict(self.headers)))
            if delay:
                time.sleep(delay)
            if self.path.endswith("/embeddings"):
                result = {"object": "list", "model": payload["model"], "data": [
                    {"object": "embedding", "index": 0, "embedding": [1.0, 0.0, 0.0]},
                ], "usage": {"prompt_tokens": 1, "total_tokens": 1}}
            else:
                message = {"role": "assistant", "content": '{"ready":true}'}
                finish = "stop"
                if invalid_schema and payload.get("response_format", {}).get("type") == "json_schema":
                    message["content"] = '{"ready":1,"PRIVATE":"response"}'
                if payload.get("tools"):
                    message = {"role": "assistant", "content": None, "tool_calls": [
                        {"id": "synthetic", "type": "function", "function": {"name": "local_check", "arguments": "{}"}},
                    ]}
                    finish = "tool_calls"
                result = {"id": "synthetic", "object": "chat.completion", "created": 1,
                          "model": payload["model"], "choices": [{"index": 0, "message": message, "finish_reason": finish}]}
            body = json.dumps(result).encode()
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


@pytest.mark.parametrize("scenario", ["passed", "failed", "cancelled", "leave", "cloud"])
def test_explicit_readiness_workflow(monkeypatch, scenario):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Readiness workflow needs Node and installed frontend dependencies")
    database_uri = os.environ.get("MIRO_TEST_NEO4J_URI")
    if scenario != "cloud" and not database_uri:
        pytest.skip("Readiness workflow needs the disposable loopback Neo4j")

    from app.local_runtime import readiness
    # The service owns a single process-local manager. Each test receives fresh
    # isolated ownership; its cleanup is completed before monkeypatch restores it.
    for name, value in {"_manager": None, "_closing": False, "_cleanup_failed": False,
                        "_owner_pid": os.getpid(), "_lock": threading.Lock()}.items():
        monkeypatch.setattr(readiness, name, value)
    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    monkeypatch.setattr(readiness, "register_readiness_shutdown", lambda: None)
    monkeypatch.delenv("MIROFISH_LOCAL_GATEWAY_URL", raising=False)
    monkeypatch.setattr(local_runtime, "_gateway", None)
    monkeypatch.setattr(local_runtime, "_gateway_starting", None)
    monkeypatch.setattr(local_runtime, "_gateway_lock", threading.Lock())
    for field, value in {
        "MEMORY_BACKEND": "local" if scenario != "cloud" else "zep",
        "LOCAL_MODE": scenario != "cloud", "DEBUG": False,
        "LLM_MODEL_NAME": "fixture <literal>", "LOCAL_EMBEDDING_MODEL": "fixture-embedding",
        "LOCAL_EMBEDDING_DIMENSIONS": 3, "LOCAL_GRAPH_URI": database_uri or "bolt://127.0.0.1:9",
        "LOCAL_GRAPH_USER": "neo4j", "LOCAL_GRAPH_PASSWORD": "PRIVATE_PASSWORD_MARKER",
        "LOCAL_GRAPH_DATABASE": "neo4j", "LLM_API_KEY": "PRIVATE_KEY_MARKER",
        "ZEP_API_KEY": "PRIVATE_ZEP_MARKER", "LOCAL_MAX_AGENTS": 10,
        "LOCAL_MAX_ROUNDS": 5, "LOCAL_MAX_AGENT_ITERATIONS": 3,
        "LOCAL_MAX_CONCURRENCY": 1, "LOCAL_MAX_QUEUE": 4, "LOCAL_REQUEST_TIMEOUT": 5,
        "LOCAL_MAX_OUTPUT_TOKENS": 512, "LOCAL_CONTEXT_TOKENS": 8192,
        "LOCAL_MAX_INPUT_CHARS": 24000, "LOCAL_REASONING_EFFORT": "none",
    }.items():
        monkeypatch.setattr(Config, field, value)

    with synthetic_models(delay=1 if scenario in ("cancelled", "leave") else 0,
                          invalid_schema=scenario == "failed") as (base_url, model_calls):
        monkeypatch.setattr(Config, "LLM_BASE_URL", base_url)
        monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", base_url)
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
                node, str(repo / "frontend/tests/fixtures/local-readiness-backend-smoke.mjs"),
                f"http://127.0.0.1:{server.server_port}", scenario,
            ], cwd=repo / "frontend", capture_output=True, text=True, timeout=40)
            assert run.returncode == 0, run.stdout + run.stderr
            assert "actual Flask/Axios/Vue readiness check passed" in run.stdout
            if scenario == "cloud":
                assert model_calls == []
                assert local_runtime._gateway is None
                assert all(method == "GET" for method, _path in observed)
            else:
                until = time.monotonic() + 10
                data = readiness.get_readiness_snapshot()
                while data["run"]["state"] in ("running", "stopping") and time.monotonic() < until:
                    time.sleep(0.02)
                    data = readiness.get_readiness_snapshot()
                assert data["run"]["state"] == ("passed" if scenario == "leave" else scenario)
                assert "PRIVATE" not in json.dumps(data)
                assert len(model_calls) == (1 if scenario == "cancelled" else 4)
                assert all("x-mirofish-timeout-ms" not in {key.lower() for key in headers}
                           for _path, _body, headers in model_calls)
                # A successful/cancelled diagnostic releases only its own clients.
                gateway = local_runtime._gateway
                assert gateway is not None
                with httpx.Client(trust_env=False, timeout=2) as client:
                    assert client.get(gateway.start().removesuffix("/v1") + "/health").status_code == 200
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
            readiness.close_readiness_manager()
            local_runtime.close_local_gateway()
        assert not thread.is_alive()
