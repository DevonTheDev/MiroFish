"""Real saved loggers through Flask, production Axios and compiled round views."""

import json
from pathlib import Path
import shutil
import subprocess
import threading

from flask import request
import pytest
from werkzeug.serving import make_server

from scripts.action_logger import ActionLogger, PlatformActionLogger
from test_simulation_comparison_api import inventory
from test_simulation_comparison_api import saved as saved
from app.services.simulation_manager import SimulationManager
from app.services.simulation_runner import SimulationRunner


def test_saved_round_overview_exact_drill_export_conflict_refresh_and_availability(saved, monkeypatch):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Round workflow needs Node and installed frontend dependencies")
    client, state_root, run_root = saved
    client.application.json.ensure_ascii = False
    logger = PlatformActionLogger("twitter", str(run_root / "sim_right"))
    for agent, success, text in [
        (1, True, "Round success"),
        (0, False, "Round failure <script>literal</script>"),
        (0, None, "Round unknown"),
    ]:
        logger.log_action(3, agent, "Saved fixture", "CREATE_POST", {"text": text}, success=success)
    logger.log_action(int("9" * 65), 0, "Large saved round", "CREATE_POST", success="false")

    # These are explicit synthetic fixture writes, not endpoint side effects.
    # Preserve the actual saved metadata shape while varying source admission.
    for name in ("sim_legacy", "sim_partial", "sim_empty", "sim_missing"):
        (state_root / name).mkdir()
        (run_root / name).mkdir()
        for root, filename in ((state_root, "state.json"),
                               (state_root, "simulation_config.json"),
                               (run_root, "run_state.json")):
            value = json.loads((root / "sim_right" / filename).read_text())
            if "simulation_id" in value:
                value["simulation_id"] = name
            if filename == "state.json":
                value["enable_reddit"] = name in ("sim_legacy", "sim_partial")
            (root / name / filename).write_text(json.dumps(value))
    legacy = ActionLogger(str(run_root / "sim_legacy/actions.jsonl"))
    legacy.log_action(0, "twitter", 0, "Legacy fixture", "OLD", success=False)
    legacy.log_action(2, "reddit", 1, "Legacy fixture", "OLD", success=True)
    legacy.log_action(2, "twitter", 0, "Legacy fixture", "OLD", success=None)
    partial = PlatformActionLogger("twitter", str(run_root / "sim_partial"))
    partial.log_action(0, 0, "Partial fixture", "CREATE_POST", success=False)
    with Path(partial.log_path).open("a", encoding="utf-8") as stream:
        stream.write("broken neighboring saved row\n")
    empty_path = run_root / "sim_empty/twitter/actions.jsonl"
    empty_path.parent.mkdir()
    empty_path.write_text("")
    def sources():
        # Check content, names and write-sensitive metadata. Reads may update
        # access times, so those are deliberately outside this invariant.
        return tuple((inventory(root), {
            str(path.relative_to(root)): (path.stat().st_ino, path.stat().st_size,
                                         path.stat().st_mtime_ns, path.stat().st_ctime_ns)
            for path in root.rglob("*") if path.is_file()
        }) for root in (state_root, run_root))

    expected_sources = sources()
    observed = []
    appended = False

    def forbidden(*args, **kwargs):
        pytest.fail("Saved rounds must not construct managers or call live runner services")

    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    for name in ("get_run_state", "start_simulation", "stop_simulation"):
        monkeypatch.setattr(SimulationRunner, name, forbidden)

    @client.application.before_request
    def capture_and_append_between_overview_and_drill():
        nonlocal appended, expected_sources
        observed.append((request.method, request.path, request.args.to_dict(flat=False),
                         request.headers.get("Accept-Language")))
        assert sources() == expected_sources, "Read-side source write"
        if (not appended and request.path == "/api/simulation/sim_right/saved-actions"
                and request.args.get("round_num") == "3" and request.args.get("outcome") is None):
            logger.log_action(3, 0, "Late fixture", "CREATE_POST",
                              {"text": "Controlled late saved action"}, success=False)
            appended = True
            after_append = sources()
            assert after_append[0] == expected_sources[0]
            before_runs, after_runs = expected_sources[1][0], after_append[1][0]
            assert before_runs.keys() == after_runs.keys()
            assert {name for name in before_runs if before_runs[name] != after_runs[name]} == {
                "sim_right/twitter/actions.jsonl",
            }
            assert after_runs["sim_right/twitter/actions.jsonl"].startswith(
                before_runs["sim_right/twitter/actions.jsonl"])
            expected_sources = after_append

    # The regression's initial red failure is a missing GET feature, rather
    # than a missing Vue file or an invented substitute response contract.
    baseline = client.get("/api/simulation/sim_right/saved-action-rounds?platform=twitter")
    assert baseline.status_code == 200, f"Saved activity round GET route is missing: {baseline.status_code}"
    assert baseline.json["success"] is True
    server = make_server("127.0.0.1", 0, client.application, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run([
            node, str(repo / "frontend/tests/fixtures/saved-activity-rounds-smoke.mjs"),
            f"http://127.0.0.1:{server.server_port}",
        ], cwd=repo / "frontend", capture_output=True, text=True, timeout=55)
        assert run.returncode == 0, run.stdout + run.stderr
        assert "actual Flask/Axios/Vue saved activity rounds passed" in run.stdout
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert appended, "The controlled writer append must exercise revision conflict"
    assert len(observed) >= 12
    permitted = {f"/api/simulation/{name}/{endpoint}"
                 for name in ("sim_right", "sim_legacy", "sim_partial", "sim_empty", "sim_missing")
                 for endpoint in ("saved-actions", "saved-action-rounds")}
    assert all(method == "GET" and path in permitted for method, path, _, _ in observed)
    assert all(language in (None, "en", "zh") for _, _, _, language in observed)
    assert any(query.get("round_num") == ["3"] and query.get("outcome") == ["failed"]
               and query.get("platform") == ["twitter"] and query.get("offset") == ["0"]
               and query.get("limit") == ["50"] for _, _, query, _ in observed)
    assert sources() == expected_sources
