"""Malformed JSONL rows cannot invalidate neighboring action-history records."""

import json
from pathlib import Path
import runpy

import pytest

from app.services.simulation_runner import SimulationRunner as Runner
from test_action_history_summaries import action, storage as storage, write_actions


INVALID_ROWS = [
    None, False, 2, 1.5, "agent_id", [], ["agent_id"],
    *[{"agent_id": value} for value in [None, True, False, -1, 0.5, "0", [], {}]],
    *[{"agent_id": 0, "round": value} for value in [None, True, -1, 0.5, "0", [], {}]],
    *[{"agent_id": 0, "timestamp": value} for value in [None, 42, [], {}]],
    *[{"agent_id": 0, "action_type": value} for value in [None, 42, [], {}]],
    {"agent_id": 0, "platform": ["twitter"]},
    {"agent_id": 0, "platform": {"name": "twitter"}},
]


@pytest.mark.parametrize("malformed", INVALID_ROWS)
def test_bad_record_is_skipped_without_losing_neighboring_rows(storage, malformed):
    folder, client = storage
    write_actions(folder, "twitter/actions.jsonl", [action(1), malformed, action(3)])

    rows = Runner.get_all_actions("sim_fixture")
    assert [row.timestamp for row in rows] == [action(3)["timestamp"], action(1)["timestamp"]]
    for endpoint, key in [("timeline", "timeline"), ("agent-stats", "stats")]:
        response = client.get(f"/api/simulation/sim_fixture/{endpoint}")
        assert response.status_code == 200
        (summary,) = response.json["data"][key]
        assert summary["total_actions"] == 2
        assert summary["first_action_time"] == action(1)["timestamp"]
        assert summary["last_action_time"] == action(3)["timestamp"]


def test_partial_json_and_event_rows_still_do_not_interrupt_valid_actions(storage):
    folder, client = storage
    path = write_actions(folder, "reddit/actions.jsonl", [action(1)])
    with path.open("a", encoding="utf-8") as file:
        file.write("{partial\n\n")
        file.write(json.dumps({"event_type": "round_end", "agent_id": 0, "round": []}) + "\n")
        file.write(json.dumps({"round": 3}) + "\n")
        file.write(json.dumps(action(3)) + "\n")
    response = client.get("/api/simulation/sim_fixture/actions")
    assert response.status_code == 200
    assert response.json["data"]["count"] == 2
    assert [row["platform"] for row in response.json["data"]["actions"]] == ["reddit", "reddit"]


def test_missing_optional_fields_keep_defaults_and_round_zero_filter(storage):
    folder, client = storage
    write_actions(folder, "twitter/actions.jsonl", [{"agent_id": 0}])
    response = client.get(
        "/api/simulation/sim_fixture/actions",
        query_string={"platform": "twitter", "agent_id": 0, "round_num": 0},
    )
    assert response.status_code == 200
    (row,) = response.json["data"]["actions"]
    assert row == {
        "round_num": 0, "timestamp": "", "platform": "twitter", "agent_id": 0,
        "agent_name": "", "action_type": "", "action_args": {}, "result": None, "success": True,
    }
    assert Runner.get_timeline("sim_fixture")[0]["total_actions"] == 1
    assert Runner.get_agent_stats("sim_fixture")[0]["total_actions"] == 1


def test_bool_ids_cannot_match_the_zero_or_one_filters(storage):
    folder, client = storage
    write_actions(folder, "twitter/actions.jsonl", [
        action(1, agent=False, round_num=True), action(2, agent=True), action(3, agent=0),
    ])
    response = client.get("/api/simulation/sim_fixture/actions", query_string={"agent_id": 0, "round_num": 0})
    assert response.status_code == 200
    assert [row["timestamp"] for row in response.json["data"]["actions"]] == [action(3)["timestamp"]]
    assert Runner.get_all_actions("sim_fixture", agent_id=1) == []


@pytest.mark.parametrize("layout", ["modern", "legacy"])
def test_real_action_writer_roundtrip_preserves_optional_payloads(storage, layout):
    folder, client = storage
    writers = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "action_logger.py"))
    args = {
        "round_num": 0, "agent_id": 0, "agent_name": "Agent 零", "action_type": "CREATE_POST",
        "action_args": {"content": "line one\nline two", "tags": ["test"]},
        "result": "fixture result", "success": False,
    }
    if layout == "modern":
        writer = writers["PlatformActionLogger"]("twitter", str(folder))
        writer.log_action(**args)
        path = folder / "twitter" / "actions.jsonl"
    else:
        path = folder / "actions.jsonl"
        writer = writers["ActionLogger"](str(path))
        writer.log_action(platform="twitter", **args)
    before = path.read_bytes()

    response = client.get("/api/simulation/sim_fixture/actions", query_string={"agent_id": 0, "round_num": 0})
    assert response.status_code == 200
    (row,) = response.json["data"]["actions"]
    assert row["agent_name"] == args["agent_name"]
    assert row["action_args"] == args["action_args"]
    assert row["result"] == args["result"] and row["success"] is False
    assert row["platform"] == "twitter" and row["round_num"] == row["agent_id"] == 0
    assert row["timestamp"] == json.loads(before)["timestamp"]
    assert path.read_bytes() == before


def test_invalid_modern_rows_never_fall_back_to_stale_legacy(storage):
    folder, _ = storage
    write_actions(folder, "twitter/actions.jsonl", INVALID_ROWS)
    write_actions(folder, "actions.jsonl", [action(1, platform="twitter")])
    assert Runner.get_all_actions("sim_fixture") == []
