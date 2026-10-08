"""Synthetic saved-page fixtures from the actual pure production reader.

No application startup, Flask listener, model provider, or existing user storage
is involved. Node consumes the observations, then invokes the real live export.
"""

import hashlib
import importlib
import json
from pathlib import Path
import sys
import tempfile
import types


REPO = Path(__file__).resolve().parents[3]
for name, directory in (("app", REPO / "backend/app"),
                        ("app.services", REPO / "backend/app/services")):
    package = types.ModuleType(name)
    package.__path__ = [str(directory)]
    sys.modules[name] = package


def deny_network(event, _args):
    if event.startswith("socket."):
        raise AssertionError("The pure saved-reader fixture must not use networking")


sys.addaudithook(deny_network)
reader = importlib.import_module("app.services.saved_activity")


def inventory(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file()}


with tempfile.TemporaryDirectory(prefix="miro-activity-file-workflow-") as temporary:
    root = Path(temporary)
    states, runs = root / "states", root / "runs"

    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=True), encoding="utf-8")

    def metadata(simulation):
        write(states / simulation / "state.json", {
            "simulation_id": simulation, "status": "completed",
            "enable_twitter": True, "enable_reddit": True,
            "created_at": "Original timestamp <tag> Café 雪 \ud800",
        })
        write(states / simulation / "simulation_config.json", {
            "llm_api_key": "PRIVATE_CONFIG_MUST_NOT_APPEAR",
        })
        write(runs / simulation / "run_state.json", {
            "simulation_id": simulation, "runner_status": "completed",
            "current_round": 8, "total_rounds": 9,
        })

    def log(simulation, platform, rows=(), extra=""):
        path = runs / simulation / platform / "actions.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row, ensure_ascii=True) + "\n" for row in rows) + extra,
                        encoding="utf-8")

    huge_id = int("9" * 80)
    huge_round = int("8" * 79)
    filtered_id = 900719925474099312345678901234
    duplicate = {
        "agent_id": filtered_id, "round": 7, "action_type": " CREATE_POST ",
        "success": False, "agent_name": "<img src=x onerror=alert(1)> Café 雪",
        "action_args": {"text": "Straße Café 雪 🐟"},
    }
    rows = [
        {"agent_id": huge_id, "round": huge_round, "action_type": "POST", "success": True,
         "agent_name": "Lone high \ud800 and low \udfff",
         "timestamp": "not a parsed date <script>literal()</script>",
         "action_args": {"text": "<script>literal()</script> Straße Café 雪 🐟 \ud800", "large": huge_id}},
        duplicate, duplicate,
        {"agent_id": 0, "action_type": "UNKNOWN_FLAG", "success": "true",
         "action_args": {"nested": ["Original Straße string"]}},
    ]
    metadata("sim_workflow")
    log("sim_workflow", "twitter", rows)
    log("sim_workflow", "reddit", [{"agent_id": 3, "round": 8, "action_type": "COMMENT", "success": True}])
    metadata("sim_partial")
    log("sim_partial", "twitter", [duplicate], extra="{malformed saved line}\n")
    metadata("sim_empty")
    log("sim_empty", "twitter")
    log("sim_empty", "reddit")
    metadata("sim_unavailable")
    source_before = inventory(root)

    def read(simulation, **kwargs):
        return reader.read_saved_activity(str(states), str(runs), simulation, **kwargs)

    full = read("sim_workflow", limit=100)
    revision = full["source_revision"]
    observations = {
        "full": full,
        "nonzero": read("sim_workflow", offset=1, limit=1, revision=revision),
        "beyond": read("sim_workflow", offset=50, limit=10, revision=revision),
        "filtered": read("sim_workflow", platform="twitter", agent_id=str(filtered_id),
                         round_num="7", action_type=" CREATE_POST ", q="STRASSE", outcome="failed"),
        "partial": read("sim_partial"),
        "empty": read("sim_empty"),
        "unavailable": read("sim_unavailable"),
    }
    assert full["availability"] == "complete" and full["matched_count"] == 5
    assert full["actions"][0]["agent_id"] == str(huge_id)
    assert full["actions"][0]["round_num"] == str(huge_round)
    assert "\\ud800" in full["actions"][0]["details_json"]
    assert observations["nonzero"]["has_more"] and observations["nonzero"]["returned_count"] == 1
    assert observations["filtered"]["matched_count"] == 2
    assert observations["filtered"]["actions"][0]["match_preview"] == "Straße Café 雪 🐟"
    assert observations["partial"]["availability"] == "partial"
    assert observations["empty"]["availability"] == "complete" and observations["empty"]["matched_count"] == 0
    assert observations["unavailable"]["matched_count"] is None
    assert source_before == inventory(root), "Production saved reader mutated its source files"
    assert "flask" not in sys.modules and "app.services.simulation_runner" not in sys.modules
    assert "PRIVATE_CONFIG_MUST_NOT_APPEAR" not in json.dumps(observations)
    print(json.dumps({"observations": observations, "source_files_unchanged": True,
                      "no_application_startup": True}, ensure_ascii=True))
