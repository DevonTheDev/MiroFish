"""Actual saved loggers through Flask, Axios and the compiled search view."""

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


def test_saved_content_search_case_outcome_paging_and_page_export(saved, monkeypatch):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Search workflow needs Node and installed frontend dependencies")
    client, state_root, run_root = saved
    client.application.json.ensure_ascii = False
    config_path = state_root / "sim_right/simulation_config.json"
    config = json.loads(config_path.read_text())
    config["llm_api_key"] = "CONFIG_ONLY_PRIVATE_MARKER"
    config_path.write_text(json.dumps(config))
    logger = PlatformActionLogger("twitter", str(run_root / "sim_right"))
    for arguments, result, success, agent, round_num in [
        ({"nested": ["Preface", {"text": "Discuss [topic]+ Straße <script>literal</script>"}]}, None, False, 0, 3),
        ({"number": 123}, {"response": "Later [topic]+ STRASSE"}, True, 1, 3),
        ({}, {"note": "[topic]+ Straße unknown"}, None, 0, 4),
        ({"[topic]+ STRASSE": "Different saved value"}, None, False, 0, 3),
        ({"first": "[topic]+ ", "second": "STRASSE"}, None, False, 0, 3),
    ]:
        logger.log_action(round_num=round_num, agent_id=agent, agent_name="Saved fixture",
                          action_type="CREATE_POST", action_args=arguments, result=result,
                          success=success)
    before = inventory(state_root), inventory(run_root)
    observed = []

    def forbidden(*args, **kwargs):
        pytest.fail("Saved search must not construct managers or call live simulation services")

    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    monkeypatch.setattr(SimulationRunner, "get_run_state", forbidden)
    monkeypatch.setattr(SimulationRunner, "start_simulation", forbidden)
    monkeypatch.setattr(SimulationRunner, "stop_simulation", forbidden)

    @client.application.before_request
    def capture():
        observed.append((request.method, request.path, request.args.to_dict(flat=False)))

    server = make_server("127.0.0.1", 0, client.application, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run([
            node, str(repo / "frontend/tests/fixtures/saved-activity-search-smoke.mjs"),
            f"http://127.0.0.1:{server.server_port}",
        ], cwd=repo / "frontend", capture_output=True, text=True, timeout=35)
        assert run.returncode == 0, run.stdout + run.stderr
        assert "actual Flask/Axios/Vue activity search passed" in run.stdout
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert len(observed) >= 6
    assert all(method == "GET" and path == "/api/simulation/sim_right/saved-actions"
               for method, path, _ in observed)
    assert any(query.get("q") == ["[topic]+ STRASSE"] and query.get("case_sensitive") == ["true"]
               for _, _, query in observed)
    assert any(query.get("outcome") == ["failed"] for _, _, query in observed)
    assert any(query.get("outcome") == ["unknown"] and query.get("agent_id") == ["0"]
               and query.get("round_num") == ["4"] for _, _, query in observed)
    assert (inventory(state_root), inventory(run_root)) == before
