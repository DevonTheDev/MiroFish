"""Ordinary pages omit private distinct state; other readers retain full metrics."""

from app.services import saved_activity as activity
from app.services import simulation_comparison as shared
from test_saved_activity import action, roots as roots, rows
from test_simulation_comparison import modern, pair


def summary(roots, **options):
    paths = shared._paths(*map(str, roots), "sim_saved")
    return shared._summary(paths, "sim_saved", shared._snapshot(paths), **options)


def test_opted_out_observations_preserve_admission_counts_without_distinct_state(roots):
    path = rows(roots, values=[action(agent_id=1, round=2), action(agent_id=1, round=2),
                              action(agent_id=2, round=3, action_type="POST")])
    with path.open("a") as stream:
        stream.write("invalid\n")
    observed = shared._read_log(path, "twitter", include_distinct_statistics=False)
    assert observed["agents"] is None and observed["rounds"] is None
    assert observed["counts"] == {"twitter": 3}
    assert observed["types"] == {"LIKE_POST": 2, "POST": 1}
    assert observed["invalid"] == {"twitter": 1}
    assert observed["unknown_invalid"] == 0
    rows(roots, "reddit")
    result = summary(roots, include_distinct_statistics=False)
    assert result["availability"] == "partial"
    assert result["metrics"] == {
        "recorded_actions": 3, "rounds_with_actions": None,
        "platforms": {
            "twitter": {"availability": "partial", "recorded_actions": 3, "active_agents": None},
            "reddit": {"availability": "complete", "recorded_actions": 0, "active_agents": None},
        },
        "action_types": [{"action_type": "LIKE_POST", "count": 2}, {"action_type": "POST", "count": 1}],
    }
    assert result["warnings"] == [{"code": "invalid_records", "platform": "twitter", "count": 1}]


def test_page_entry_point_explicitly_omits_distinct_statistics(roots, monkeypatch):
    rows(roots, values=[action(), action(agent_id=1)])
    rows(roots, "reddit", [action(agent_id=2)])
    original = shared._summary
    options = []
    def observed_summary(*args, **kwargs):
        options.append(kwargs.get("include_distinct_statistics"))
        return original(*args, **kwargs)
    monkeypatch.setattr(shared, "_summary", observed_summary)
    result = activity.read_saved_activity(*map(str, roots), "sim_saved", limit=1)
    assert options == [False]
    assert result["availability"] == "complete"
    assert result["platform_availability"] == {"twitter": "complete", "reddit": "complete"}
    assert result["matched_count"] == 3 and result["returned_count"] == 1 and result["has_more"]
    assert result["actions"][0]["record_id"] == "twitter:1"


def test_default_comparison_retains_distinct_unions_and_signed_differences(roots):
    pair(roots)
    modern(roots, "sim_left", "twitter", [(1, 7, "POST", True), (1, 7, "POST", True), (2, 8, "POST", True)])
    modern(roots, "sim_left", "reddit", [(2, 7, "POST", True), (3, 7, "POST", True)])
    modern(roots, "sim_right", "twitter", [(2, 9, "POST", True)])
    result = shared.compare_saved_simulations(*map(str, roots), "sim_left", "sim_right")
    assert result["left"]["metrics"]["rounds_with_actions"] == 3
    assert result["left"]["metrics"]["platforms"]["twitter"]["active_agents"] == 2
    assert result["left"]["metrics"]["platforms"]["reddit"]["active_agents"] == 1
    assert result["right"]["metrics"]["platforms"]["reddit"] == {
        "availability": "complete", "recorded_actions": 0, "active_agents": 0,
    }
    assert result["differences"]["recorded_actions"] == -4
    assert result["differences"]["rounds_with_actions"] == -2
    assert result["differences"]["platforms"] == {
        "twitter": {"recorded_actions": -2, "active_agents": -1},
        "reddit": {"recorded_actions": -2, "active_agents": -1},
    }


def test_default_summary_distinguishes_empty_from_missing_coverage(roots):
    rows(roots)
    result = summary(roots)
    assert result["availability"] == "partial"
    assert result["metrics"]["recorded_actions"] == result["metrics"]["rounds_with_actions"] == 0
    assert result["metrics"]["platforms"] == {
        "twitter": {"availability": "complete", "recorded_actions": 0, "active_agents": 0},
        "reddit": {"availability": "unavailable", "recorded_actions": None, "active_agents": None},
    }
