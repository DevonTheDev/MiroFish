"""Actual Flask routes → Axios source → compiled Vue page, on loopback only."""

import json
from pathlib import Path
import shutil
import subprocess
import threading

from flask import request
import pytest
from werkzeug.serving import make_server

from test_simulation_comparison_api import saved as saved


def test_saved_comparison_crosses_real_http_and_ui_boundaries(saved):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Cross-layer comparison test needs Node and installed frontend dependencies")
    client, state_root, _ = saved
    empty = state_root / "sim_empty"
    empty.mkdir()
    (empty / "state.json").write_text(json.dumps({
        "simulation_id": "sim_empty", "project_id": "project_fixture", "graph_id": "graph_fixture",
        "status": "completed", "enable_twitter": True, "enable_reddit": False,
        "created_at": "2026-01-03T12:00:00", "updated_at": "2026-01-03T12:00:00",
    }))
    observed = []
    @client.application.before_request
    def capture_request():
        observed.append((request.method, request.path, request.headers.get("Accept-Language")))
    server = make_server("127.0.0.1", 0, client.application, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run([
            node, str(repo / "frontend/tests/fixtures/comparison-backend-smoke.mjs"),
            f"http://127.0.0.1:{server.server_port}",
        ], cwd=repo / "frontend", capture_output=True, text=True, timeout=30)
        assert run.returncode == 0, run.stdout + run.stderr
        assert "actual Flask/Axios/Vue comparison passed" in run.stdout
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert len(observed) >= 4
    assert all(method == "GET" and path in {
        "/api/simulation/comparison/candidates", "/api/simulation/comparison",
    } and language == "en" for method, path, language in observed)
