"""Real gateway activity through Flask, Axios and the compiled passive view."""

import os
from pathlib import Path
import shutil
import subprocess
import threading

from flask import request
import httpx
import pytest
from werkzeug.serving import make_server

from app import create_app, local_runtime
from app.config import Config
from app.local_runtime.gateway import GatewaySettings, LocalInferenceGateway
from app.services.simulation_runner import SimulationRunner
from test_local_gateway import upstream_server


@pytest.mark.parametrize("local_mode", [True, False])
def test_runtime_monitor_observes_existing_traffic_without_starting_work(monkeypatch, local_mode):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Runtime workflow needs Node and installed frontend dependencies")

    def forbidden(*_args, **_kwargs):
        pytest.fail("Passive status cannot start or configure local resources")

    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    monkeypatch.delenv("MIROFISH_LOCAL_GATEWAY_URL", raising=False)
    for field, value in {
        "MEMORY_BACKEND": "local" if local_mode else "zep",
        "LOCAL_MODE": local_mode,
        "DEBUG": False,
        "LLM_MODEL_NAME": "fixture <script>literal</script>",
        "LOCAL_EMBEDDING_MODEL": "fixture-embedding",
        "LOCAL_EMBEDDING_DIMENSIONS": 768,
        "LOCAL_GRAPH_URI": "bolt://127.0.0.1:17687",
        "LOCAL_GRAPH_USER": "GRAPH_USER_PRIVATE_MARKER",
        "LOCAL_GRAPH_PASSWORD": "GRAPH_PASSWORD_PRIVATE_MARKER",
        "LLM_API_KEY": "CLOUD_KEY_PRIVATE_MARKER",
        "ZEP_API_KEY": "ZEP_KEY_PRIVATE_MARKER",
        "LOCAL_MAX_AGENTS": 10,
        "LOCAL_MAX_ROUNDS": 5,
        "LOCAL_MAX_AGENT_ITERATIONS": 3,
        "LOCAL_MAX_CONCURRENCY": 2,
        "LOCAL_MAX_QUEUE": 8,
        "LOCAL_REQUEST_TIMEOUT": 60,
        "LOCAL_MAX_OUTPUT_TOKENS": 1024,
        "LOCAL_CONTEXT_TOKENS": 8192,
        "LOCAL_MAX_INPUT_CHARS": 24000,
        "LOCAL_REASONING_EFFORT": "none",
    }.items():
        monkeypatch.setattr(Config, field, value)

    with upstream_server() as upstream:
        monkeypatch.setattr(Config, "LLM_BASE_URL", upstream.url)
        monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", upstream.url)
        gateway = LocalInferenceGateway(GatewaySettings(
            llm_base_url=upstream.url, embedding_base_url=upstream.url,
            max_concurrency=1, max_queue=4, request_timeout=5,
            max_output_tokens=512, max_input_chars=12000,
        ))
        base_url = gateway.start()
        monkeypatch.setattr(local_runtime, "_gateway", gateway)
        try:
            with httpx.Client(base_url=base_url + "/", trust_env=False, timeout=5) as client:
                assert client.post("chat/completions", json={
                    "model": "fixture-model", "messages": [{"role": "user", "content": "synthetic"}],
                }).status_code == 200
                assert client.post("embeddings", json={"model": "fixture-model", "input": "synthetic"}).status_code == 200
                assert client.get("models").status_code == 200
                upstream.status = 503
                assert client.get("models").status_code == 502
                # Health and invalid payloads do not enter the forwarding totals.
                assert client.get(base_url.removesuffix("/v1") + "/health").status_code == 200
                assert client.post("chat/completions", json={}).status_code == 400
            assert len(upstream.calls) == 4

            app = create_app()
            for name in ("get_local_gateway_url", "configure_local_environment", "openai_client_options", "child_environment"):
                monkeypatch.setattr(local_runtime, name, forbidden)
            environment_before = dict(os.environ)
            observed = []

            @app.before_request
            def record_request():
                observed.append((request.method, request.path, request.headers.get("Accept-Language")))

            server = make_server("127.0.0.1", 0, app, threaded=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                run = subprocess.run([
                    node, str(repo / "frontend/tests/fixtures/runtime-status-backend-smoke.mjs"),
                    f"http://127.0.0.1:{server.server_port}", "local" if local_mode else "cloud",
                ], cwd=repo / "frontend", capture_output=True, text=True, timeout=30)
                assert run.returncode == 0, run.stdout + run.stderr
                assert "actual Flask/Axios/Vue runtime monitor passed" in run.stdout
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
            assert not thread.is_alive()
            assert len(observed) == 2
            assert all(method == "GET" and path == "/api/runtime/status" and language == "en"
                       for method, path, language in observed)
            assert len(upstream.calls) == 4
            assert dict(os.environ) == environment_before
        finally:
            gateway.close()
