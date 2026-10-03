"""Saved action files through actual Flask, Axios and the compiled Vue page."""

import json
from pathlib import Path
import shutil
import subprocess
import threading

from flask import request
import pytest
from werkzeug.serving import make_server

from test_simulation_comparison_api import PlatformActionLogger, inventory
from test_simulation_comparison_api import saved as saved
from app.services.simulation_manager import SimulationManager
from app.services.simulation_runner import SimulationRunner


def test_saved_activity_http_ui_pages_conflict_refresh_filters_and_export(saved, monkeypatch):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Cross-layer saved activity test needs Node and installed frontend dependencies")
    client, state_root, run_root = saved
    # Match create_app's real Flask >=2.3 JSON provider configuration.
    client.application.json.ensure_ascii = False
    config_path = state_root / "sim_right/simulation_config.json"
    config = json.loads(config_path.read_text())
    config["llm_api_key"] = "CONFIG_ONLY_PRIVATE_MARKER"
    config_path.write_text(json.dumps(config))
    source_before = inventory(state_root), inventory(run_root)
    observed = []
    appended = False
    expected_sources = source_before

    def forbidden(*args, **kwargs):
        pytest.fail("Saved activity must not construct a manager or use live runner services")

    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    monkeypatch.setattr(SimulationRunner, "get_run_state", forbidden)
    monkeypatch.setattr(SimulationRunner, "start_simulation", forbidden)
    monkeypatch.setattr(SimulationRunner, "stop_simulation", forbidden)

    @client.application.before_request
    def capture_and_replace_between_pages():
        nonlocal appended, expected_sources
        observed.append((request.method, request.path, request.headers.get("Accept-Language")))
        if not appended and request.args.get("offset") == "2":
            # Synthetic writer activity occurs between page requests, not from
            # an endpoint. The accepted old revision must now be rejected.
            PlatformActionLogger("twitter", str(run_root / "sim_right")).log_action(
                round_num=3, agent_id=0, agent_name="Late fixture", action_type="CREATE_POST",
                action_args={"text": "late saved action <script>literal</script>"}, success=False,
            )
            appended = True
            expected_sources = inventory(state_root), inventory(run_root)

    server = make_server("127.0.0.1", 0, client.application, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run([
            node, str(repo / "frontend/tests/fixtures/saved-activity-backend-smoke.mjs"),
            f"http://127.0.0.1:{server.server_port}",
        ], cwd=repo / "frontend", capture_output=True, text=True, timeout=30)
        assert run.returncode == 0, run.stdout + run.stderr
        assert "actual Flask/Axios/Vue saved activity passed" in run.stdout
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert appended
    assert len(observed) >= 5
    assert all(method == "GET" and path == "/api/simulation/sim_right/saved-actions"
               and language == "en" for method, path, language in observed)
    assert (inventory(state_root), inventory(run_root)) == expected_sources
