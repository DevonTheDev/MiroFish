"""Action-log layout, complete summaries and time bounds with disposable JSONL."""

from datetime import datetime, timedelta
import json

from flask import Flask
import pytest

from app.api import simulation as api
from app.services.simulation_runner import SimulationRunner as Runner


@pytest.fixture
def storage(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    folder = root / "sim_fixture"
    folder.mkdir(parents=True)
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(root))
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    return folder, app.test_client()


def action(second, *, agent=0, round_num=0, name="fixture", platform=None):
    result = {
        "agent_id": agent,
        "agent_name": name,
        "round": round_num,
        "timestamp": (datetime(2026, 1, 1) + timedelta(seconds=second)).isoformat(),
        "action_type": "CREATE_POST",
        "action_args": {},
        "success": True,
    }
    if platform is not None:
        result["platform"] = platform
    return result


def write_actions(folder, relative, rows):
    path = folder / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return path


@pytest.mark.parametrize(
    "case",
    ["empty", "agent", "round", "other-platform", "events-only", "malformed-only"],
)
def test_modern_layout_does_not_revive_legacy_rows_when_filter_has_no_match(
    storage, case
):
    folder, client = storage
    legacy = action(1, agent=9, round_num=99, name="stale legacy", platform="reddit")
    write_actions(folder, "actions.jsonl", [legacy])
    modern = [] if case in {"empty", "malformed-only"} else [action(5, name="modern")]
    if case == "events-only":
        modern = [{"event_type": "round_start", "round": 0}]
    path = write_actions(folder, "twitter/actions.jsonl", modern)
    if case == "malformed-only":
        path.write_text("{incomplete\n")
    filters = {
        "agent": {"agent_id": 9},
        "round": {"round_num": 99},
        "other-platform": {"platform": "reddit"},
    }.get(case, {})
    assert Runner.get_all_actions("sim_fixture", **filters) == []
    response = client.get("/api/simulation/sim_fixture/actions", query_string=filters)
    assert response.status_code == 200
    assert response.json["data"] == {"count": 0, "actions": []}


def test_legacy_only_layout_keeps_filters_and_pagination(storage):
    folder, _ = storage
    write_actions(
        folder,
        "actions.jsonl",
        [
            action(1, agent=1, round_num=0, platform="reddit"),
            action(3, agent=0, round_num=1, platform="twitter"),
            action(2, agent=0, round_num=0, platform="twitter"),
        ],
    )
    assert [row.timestamp for row in Runner.get_all_actions("sim_fixture")] == [
        action(i)["timestamp"] for i in (3, 2, 1)
    ]
    assert [
        row.round_num
        for row in Runner.get_all_actions("sim_fixture", platform="twitter", agent_id=0)
    ] == [1, 0]
    assert (
        Runner.get_all_actions(
            "sim_fixture", platform="twitter", agent_id=0, round_num=0
        )[0].timestamp
        == action(2)["timestamp"]
    )
    assert (
        Runner.get_actions("sim_fixture", limit=1, offset=1)[0].timestamp
        == action(2)["timestamp"]
    )


def test_modern_logs_merge_with_platform_defaults_and_ignore_legacy(storage):
    folder, _ = storage
    write_actions(folder, "twitter/actions.jsonl", [action(3), action(1)])
    write_actions(folder, "reddit/actions.jsonl", [action(2)])
    write_actions(
        folder, "actions.jsonl", [action(10, name="stale", platform="twitter")]
    )
    rows = Runner.get_all_actions("sim_fixture")
    assert [row.timestamp for row in rows] == [
        action(i)["timestamp"] for i in (3, 2, 1)
    ]
    assert [row.platform for row in rows] == ["twitter", "reddit", "twitter"]
    assert Runner.get_actions("sim_fixture", limit=1, offset=1)[0].platform == "reddit"


@pytest.mark.parametrize("summary", ["timeline", "agent-stats"])
def test_summary_time_bounds_are_earliest_to_latest(storage, summary):
    folder, client = storage
    write_actions(folder, "twitter/actions.jsonl", [action(1), action(3)])
    write_actions(folder, "reddit/actions.jsonl", [action(2)])
    response = client.get(f"/api/simulation/sim_fixture/{summary}")
    assert response.status_code == 200
    key = "timeline" if summary == "timeline" else "stats"
    (row,) = response.json["data"][key]
    assert row["first_action_time"] == action(1)["timestamp"]
    assert row["last_action_time"] == action(3)["timestamp"]
    assert row["total_actions"] == 3
    assert row["twitter_actions"] == 2 and row["reddit_actions"] == 1
    assert row["action_types"] == {"CREATE_POST": 3}


@pytest.fixture
def long_history(storage):
    folder, client = storage
    rows = [action(0, agent=99, round_num=0), action(1, agent=99, round_num=0)]
    rows.extend(action(index, agent=0, round_num=1) for index in range(2, 10004))
    write_actions(folder, "twitter/actions.jsonl", rows)
    return client


def test_timeline_does_not_truncate_old_rounds_before_filtering(long_history):
    response = long_history.get(
        "/api/simulation/sim_fixture/timeline",
        query_string={"start_round": 0, "end_round": 0},
    )
    assert response.status_code == 200
    (row,) = response.json["data"]["timeline"]
    assert row["round_num"] == 0 and row["total_actions"] == 2
    assert row["first_action_time"] == action(0)["timestamp"]
    assert row["last_action_time"] == action(1)["timestamp"]
    all_rounds = Runner.get_timeline("sim_fixture")
    assert sum(row["total_actions"] for row in all_rounds) == 10004


def test_agent_stats_include_older_agents_and_all_action_counts(long_history):
    response = long_history.get("/api/simulation/sim_fixture/agent-stats")
    assert response.status_code == 200
    rows = response.json["data"]["stats"]
    assert [row["agent_id"] for row in rows] == [0, 99]
    assert [row["total_actions"] for row in rows] == [10002, 2]
    assert rows[0]["first_action_time"] == action(2)["timestamp"]
    assert rows[0]["last_action_time"] == action(10003)["timestamp"]


def test_missing_history_is_empty_and_noncreating(storage):
    folder, _ = storage
    assert Runner.get_all_actions("sim_missing") == []
    assert Runner.get_timeline("sim_missing") == []
    assert Runner.get_agent_stats("sim_missing") == []
    assert not (folder.parent / "sim_missing").exists()


@pytest.mark.parametrize("filtered", [True, False])
def test_modern_source_is_not_replaced_by_legacy_if_log_disappears_during_read(
    storage, monkeypatch, filtered
):
    from pathlib import Path

    folder, _ = storage
    path = write_actions(
        folder, "twitter/actions.jsonl", [action(5, agent=0, name="modern")]
    )
    write_actions(
        folder, "actions.jsonl", [action(1, agent=9, name="stale", platform="twitter")]
    )
    original = Runner._read_actions_from_file.__func__

    def disappearing_read(cls, file_path, **kwargs):
        rows = original(cls, file_path, **kwargs)
        if Path(file_path) == path:
            path.unlink()
        return rows

    monkeypatch.setattr(
        Runner, "_read_actions_from_file", classmethod(disappearing_read)
    )
    rows = Runner.get_all_actions("sim_fixture", agent_id=9 if filtered else None)
    assert [row.agent_name for row in rows] == ([] if filtered else ["modern"])
