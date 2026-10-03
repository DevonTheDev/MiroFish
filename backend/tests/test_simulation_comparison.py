"""Saved comparisons read disposable logger output without runtime side effects."""

import builtins
import importlib
import importlib.util
import json
from pathlib import Path

import pytest

from scripts.action_logger import ActionLogger, PlatformActionLogger


def test_reader_module_is_available():
    assert importlib.util.find_spec("app.services.simulation_comparison") is not None, "Saved comparison reader is missing"


@pytest.fixture
def reader():
    name = "app.services.simulation_comparison"
    assert importlib.util.find_spec(name) is not None, "Saved comparison reader is missing"
    return importlib.import_module(name)


@pytest.fixture
def roots(tmp_path):
    return tmp_path / "simulations", tmp_path / "runs"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def saved(roots, simulation_id, *, status="completed", twitter=True, reddit=True):
    simulation_root, run_root = roots
    state = {
        "simulation_id": simulation_id, "project_id": "proj_fixture",
        "graph_id": "graph_fixture", "status": status, "profiles_count": 4,
        "enable_twitter": twitter, "enable_reddit": reddit,
        "current_round": 2, "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-02T00:00:00Z",
    }
    config = {
        "simulation_requirement": "Synthetic scenario", "llm_model": "configured-model",
        "agent_configs": [{"agent_id": value} for value in range(4)],
        "llm_base_url": "https://secret.invalid", "api_key": "fixture-secret",
    }
    run = {
        "simulation_id": simulation_id, "runner_status": status,
        "total_rounds": 10, "current_round": 3,
        "started_at": "2026-01-01T01:00:00Z", "completed_at": "2026-01-02T01:00:00Z",
        "updated_at": "2026-01-02T01:00:00Z", "total_actions_count": 99999,
    }
    write_json(simulation_root / simulation_id / "state.json", state)
    write_json(simulation_root / simulation_id / "simulation_config.json", config)
    write_json(run_root / simulation_id / "run_state.json", run)
    return state, config, run


def modern(roots, simulation_id, platform, actions=()):
    logger = PlatformActionLogger(platform, str(roots[1] / simulation_id))
    logger.log_simulation_start({})
    for round_num, agent_id, action_type, success in actions:
        logger.log_action(round_num, agent_id, "Synthetic agent", action_type,
                          {"secret-content": "must-not-leak"}, "private-result", success)
    logger.log_simulation_end(10, len(actions))
    return Path(logger.log_path)


def pair(roots):
    for simulation_id in ("sim_left", "sim_right"):
        saved(roots, simulation_id)
        modern(roots, simulation_id, "twitter")
        modern(roots, simulation_id, "reddit")


def compare(reader, roots):
    return reader.compare_saved_simulations(*map(str, roots), "sim_left", "sim_right")


def warning_codes(summary):
    return {item["code"] for item in summary["warnings"]}


def test_actual_loggers_count_attempts_and_signed_differences(reader, roots):
    pair(roots)
    modern(roots, "sim_left", "twitter", [(0, 0, "LIKE_POST", False), (2, 0, "CREATE_POST", True)])
    modern(roots, "sim_left", "reddit", [(2, 0, "LIKE_POST", True)])
    modern(roots, "sim_right", "twitter", [(1, 2, "CREATE_POST", False)])
    result = compare(reader, roots)
    left = result["left"]
    assert left["availability"] == "complete"
    assert left["metrics"]["recorded_actions"] == 3
    assert left["metrics"]["rounds_with_actions"] == 2
    assert left["metrics"]["platforms"]["twitter"] == {
        "availability": "complete", "recorded_actions": 2, "active_agents": 1,
    }
    assert result["differences"]["recorded_actions"] == -2
    assert result["differences"]["rounds_with_actions"] == -1
    assert result["differences"]["action_types"] == [
        {"action_type": "CREATE_POST", "left": 1, "right": 1, "difference": 0},
        {"action_type": "LIKE_POST", "left": 2, "right": 0, "difference": -2},
    ]
    assert left["scenario"] == "Synthetic scenario"
    assert left["configured_agents"] == 4
    assert left["requested_rounds"] == 10
    assert left["last_saved_round"] == 3
    serialized = json.dumps(result, allow_nan=False)
    for excluded in ("fixture-secret", "secret.invalid", "must-not-leak", "private-result", "total_actions_count"):
        assert excluded not in serialized


def test_more_than_ten_thousand_records_are_streamed(reader, roots):
    pair(roots)
    logger = ActionLogger(str(roots[1] / "sim_left" / "actions.jsonl"))
    # The modern logger path is deliberately selected, and there is no UI page cap.
    path = roots[1] / "sim_left" / "twitter" / "actions.jsonl"
    action = {"round": 1, "agent_id": 0, "action_type": "LIKE_POST", "success": False}
    with path.open("w") as stream:
        for number in range(10_025):
            stream.write(json.dumps({**action, "agent_id": number}) + "\n")
    logger.log_action(1, "reddit", 0, "Ignored legacy", "LEGACY_ONLY")
    result = compare(reader, roots)
    assert result["left"]["metrics"]["recorded_actions"] == 10_025
    assert result["left"]["metrics"]["platforms"]["twitter"]["active_agents"] == 10_025


@pytest.mark.parametrize("content", ["", '{"event_type":"round_start","round":0}\n'])
def test_readable_empty_and_event_only_logs_establish_zero(reader, roots, content):
    pair(roots)
    for platform in ("twitter", "reddit"):
        (roots[1] / "sim_left" / platform / "actions.jsonl").write_text(content)
    left = compare(reader, roots)["left"]
    assert left["availability"] == "complete"
    assert left["metrics"]["recorded_actions"] == 0
    assert left["metrics"]["rounds_with_actions"] == 0


def test_missing_enabled_log_is_null_and_only_its_differences_are_disabled(reader, roots):
    pair(roots)
    (roots[1] / "sim_left" / "reddit" / "actions.jsonl").unlink()
    result = compare(reader, roots)
    assert result["left"]["availability"] == "partial"
    assert result["left"]["metrics"]["platforms"]["reddit"]["recorded_actions"] is None
    assert result["differences"]["recorded_actions"] is None
    assert result["differences"]["platforms"]["twitter"]["recorded_actions"] == 0
    assert result["differences"]["platforms"]["reddit"]["recorded_actions"] is None
    assert "platform_log_missing" in warning_codes(result["left"])


def test_disabled_absent_platform_does_not_invent_zero_or_block_completeness(reader, roots):
    pair(roots)
    saved(roots, "sim_left", reddit=False)
    (roots[1] / "sim_left" / "reddit" / "actions.jsonl").unlink()
    left = compare(reader, roots)["left"]
    assert left["availability"] == "complete"
    assert left["metrics"]["platforms"]["reddit"]["recorded_actions"] is None
    assert "platform_log_missing" not in warning_codes(left)


def test_present_disabled_platform_is_counted_and_warned(reader, roots):
    pair(roots)
    saved(roots, "sim_left", reddit=False)
    modern(roots, "sim_left", "reddit", [(1, 0, "POST", False)])
    left = compare(reader, roots)["left"]
    assert left["metrics"]["recorded_actions"] == 1
    assert {"code": "platform_not_configured", "platform": "reddit"} in left["warnings"]


def test_legacy_covers_enabled_platforms_and_requires_explicit_platform(reader, roots):
    pair(roots)
    for platform in ("twitter", "reddit"):
        (roots[1] / "sim_left" / platform / "actions.jsonl").unlink()
    logger = ActionLogger(str(roots[1] / "sim_left" / "actions.jsonl"))
    logger.log_round_start(0, 0, "twitter")
    logger.log_action(0, "twitter", 1, "Synthetic", "CREATE_POST", success=False)
    left = compare(reader, roots)["left"]
    assert left["availability"] == "complete"
    assert left["metrics"]["platforms"]["reddit"]["recorded_actions"] == 0
    assert left["metrics"]["recorded_actions"] == 1
    with Path(logger.log_path).open("a") as stream:
        stream.write('{"agent_id":0,"action_type":"MISSING_PLATFORM"}\n')
    assert compare(reader, roots)["left"]["availability"] == "partial"


@pytest.mark.parametrize("row", [
    "not json", "[]", "null", '{"agent_id":NaN}',
    '{"agent_id":0,"action_type":"X","round":true}',
    '{"agent_id":true,"action_type":"X"}',
    '{"agent_id":-1,"action_type":"X"}',
    '{"agent_id":0,"action_type":"X","round":-1}',
    '{"agent_id":0,"action_type":" "}',
    '{"agent_id":0,"action_type":"X","timestamp":42}',
    '{"agent_id":0,"action_type":"X","platform":"reddit"}',
    '{"agent_id":0,"action_type":"X","platform":"unknown"}',
    '{"event_type":"invented_event"}',
])
def test_invalid_rows_are_visible_partial_observations(reader, roots, row):
    pair(roots)
    path = modern(roots, "sim_left", "twitter", [(0, 0, "VALID", False)])
    with path.open("a") as stream:
        stream.write(row + "\n")
    result = compare(reader, roots)
    left = result["left"]
    assert left["availability"] == "partial"
    assert left["metrics"]["recorded_actions"] == 1
    assert left["metrics"]["platforms"]["twitter"]["availability"] == "partial"
    assert result["differences"]["platforms"]["twitter"]["recorded_actions"] is None
    assert result["differences"]["platforms"]["reddit"]["recorded_actions"] == 0
    assert {"code": "invalid_records", "platform": "twitter", "count": 1} in left["warnings"]
    assert result["differences"]["action_types"] == [
        {"action_type": "VALID", "left": 1, "right": 0, "difference": None},
    ]


def test_missing_round_and_unknown_success_count_as_an_attempt(reader, roots):
    pair(roots)
    path = roots[1] / "sim_left" / "twitter" / "actions.jsonl"
    path.write_text('{"agent_id":0,"action_type":"X","success":null}\n')
    left = compare(reader, roots)["left"]
    assert left["metrics"]["recorded_actions"] == 1
    assert left["metrics"]["rounds_with_actions"] == 1


@pytest.mark.parametrize("status", ["starting", "running", "paused", "stopping"])
def test_active_disk_runner_state_is_rejected(reader, roots, status):
    pair(roots)
    _, _, run = saved(roots, "sim_left")
    run["runner_status"] = status
    write_json(roots[1] / "sim_left" / "run_state.json", run)
    with pytest.raises(reader.ComparisonError) as error:
        compare(reader, roots)
    assert (error.value.code, error.value.status_code) == ("simulation_active", 409)


@pytest.mark.parametrize("status", ["failed", "stopped"])
def test_partial_run_status_can_have_complete_saved_logs(reader, roots, status):
    pair(roots)
    saved(roots, "sim_left", status=status)
    left = compare(reader, roots)["left"]
    assert left["status"] == status
    assert left["availability"] == "complete"
    assert "partial_run" in warning_codes(left)


@pytest.mark.parametrize("content", [None, "[]", "not json", '{"runner_status":"invented"}'])
def test_unusable_run_metadata_falls_back_to_terminal_state(reader, roots, content):
    pair(roots)
    path = roots[1] / "sim_left" / "run_state.json"
    path.unlink() if content is None else path.write_text(content)
    left = compare(reader, roots)["left"]
    assert left["status"] == "completed"
    assert left["last_saved_round"] == 2
    assert left["requested_rounds"] is None
    assert left["availability"] == "complete"
    assert "run_state_unavailable" in warning_codes(left)


@pytest.mark.parametrize("status", ["ready", "created", "preparing", "idle"])
def test_no_terminal_evidence_keeps_metrics_unavailable(reader, roots, status):
    pair(roots)
    state, _, run = saved(roots, "sim_left")
    if status == "idle":
        run["runner_status"] = status
        write_json(roots[1] / "sim_left" / "run_state.json", run)
    else:
        state["status"] = status
        write_json(roots[0] / "sim_left" / "state.json", state)
        (roots[1] / "sim_left" / "run_state.json").unlink()
    left = compare(reader, roots)["left"]
    assert left["availability"] == "unavailable"
    assert left["metrics"]["recorded_actions"] is None
    assert "run_not_terminal" in warning_codes(left)


@pytest.mark.parametrize("content", ["null", "[]", "not json", '{"llm_model": NaN}'])
def test_bad_config_keeps_metrics_but_does_not_expose_context(reader, roots, content):
    pair(roots)
    (roots[0] / "sim_left" / "simulation_config.json").write_text(content)
    left = compare(reader, roots)["left"]
    assert left["metrics"]["recorded_actions"] == 0
    assert left["scenario"] == ""
    assert left["configured_model"] is None
    assert "config_unavailable" in warning_codes(left)


def test_context_numbers_do_not_coerce_boolean_or_unknown_values(reader, roots):
    pair(roots)
    state, config, run = saved(roots, "sim_left")
    state["profiles_count"] = True
    state["current_round"] = False
    run["current_round"] = False
    run["total_rounds"] = "10"
    write_json(roots[0] / "sim_left" / "state.json", state)
    write_json(roots[1] / "sim_left" / "run_state.json", run)
    left = compare(reader, roots)["left"]
    assert left["configured_agents"] is None
    assert left["last_saved_round"] is None
    assert left["requested_rounds"] is None


@pytest.mark.parametrize("left,right", [("sim_left", "sim_left"), ("../bad", "sim_right"), ("sim_left", "CON"), (None, "sim_right")])
def test_invalid_pair_is_rejected_before_reading_either_side(reader, roots, monkeypatch, left, right):
    pair(roots)
    def forbidden(*args, **kwargs):
        pytest.fail("invalid selection must fail before any file read")
    monkeypatch.setattr(builtins, "open", forbidden)
    with pytest.raises(reader.ComparisonError) as error:
        reader.compare_saved_simulations(*map(str, roots), left, right)
    assert (error.value.code, error.value.status_code) == ("invalid_selection", 400)


@pytest.mark.parametrize("root_index,relative", [
    (0, "state.json"), (0, "simulation_config.json"), (1, "run_state.json"),
    (1, "twitter/actions.jsonl"), (1, "reddit/actions.jsonl"), (1, "actions.jsonl"),
])
def test_all_side_paths_are_preflighted_even_unselected_legacy(reader, roots, monkeypatch, tmp_path, root_index, relative):
    pair(roots)
    alias = roots[root_index] / "sim_right" / relative
    if alias.exists():
        alias.unlink()
    target = tmp_path / "outside.json"
    target.write_text("private fixture")
    alias.symlink_to(target)
    def forbidden(*args, **kwargs):
        pytest.fail("unsafe second side must fail before either side is read")
    monkeypatch.setattr(builtins, "open", forbidden)
    with pytest.raises(reader.ComparisonError) as error:
        compare(reader, roots)
    assert (error.value.code, error.value.status_code) == ("unsafe_path", 400)
    assert str(tmp_path) not in str(error.value)


def test_missing_and_malformed_states_have_safe_errors_and_no_writes(reader, roots):
    pair(roots)
    state = roots[0] / "sim_left" / "state.json"
    state.unlink()
    with pytest.raises(reader.ComparisonError) as error:
        compare(reader, roots)
    assert (error.value.code, error.value.status_code) == ("simulation_not_found", 404)
    state.write_text("sensitive-corrupt-payload")
    with pytest.raises(reader.ComparisonError) as error:
        compare(reader, roots)
    assert (error.value.code, error.value.status_code) == ("simulation_unreadable", 404)
    assert "sensitive" not in str(error.value)


@pytest.mark.parametrize("change", ["append", "replace", "remove", "new_modern"])
def test_changes_during_two_sided_read_are_retryable(reader, roots, monkeypatch, change):
    pair(roots)
    target = roots[1] / "sim_left" / "twitter" / "actions.jsonl"
    if change == "new_modern":
        for platform in ("twitter", "reddit"):
            (roots[1] / "sim_left" / platform / "actions.jsonl").unlink()
        ActionLogger(str(roots[1] / "sim_left" / "actions.jsonl")).log_action(0, "twitter", 0, "Fixture", "X")
    original = builtins.open
    fired = False
    def changing_open(file, *args, **kwargs):
        nonlocal fired
        if str(file).endswith("sim_right/state.json") and not fired:
            fired = True
            if change in ("append", "new_modern"):
                with original(target, "ab") as stream:
                    stream.write(b'{}\n')
            elif change == "replace":
                replacement = target.with_suffix(".replacement")
                replacement.write_bytes(target.read_bytes())
                replacement.replace(target)
            else:
                target.unlink()
        return original(file, *args, **kwargs)
    monkeypatch.setattr(builtins, "open", changing_open)
    with pytest.raises(reader.ComparisonError) as error:
        compare(reader, roots)
    assert fired
    assert (error.value.code, error.value.status_code) == ("sources_changed", 409)


def test_sources_remain_byte_identical_and_runtime_services_are_unused(reader, roots, monkeypatch):
    pair(roots)
    from app.services.simulation_manager import SimulationManager
    from app.services.simulation_runner import SimulationRunner
    def forbidden(*args, **kwargs):
        pytest.fail("pure saved reader must not invoke runtime services")
    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    monkeypatch.setattr(SimulationRunner, "get_run_state", forbidden)
    monkeypatch.setattr(SimulationRunner, "start_simulation", forbidden)
    before = {path: path.read_bytes() for root in roots for path in root.rglob("*") if path.is_file()}
    compare(reader, roots)
    reader.list_comparison_candidates(*map(str, roots))
    after = {path: path.read_bytes() for root in roots for path in root.rglob("*") if path.is_file()}
    assert after == before


def test_candidates_are_isolated_allowlisted_and_sorted_by_saved_update(reader, roots):
    for simulation_id, updated in [("sim_z", "2026-04-01T00:00:00Z"), ("sim_a", "2026-04-01T00:00:00Z"), ("sim_bad_date", "bad"), ("sim_new", "2026-04-02T00:00:00+00:00")]:
        _, _, run = saved(roots, simulation_id)
        run["updated_at"] = updated
        write_json(roots[1] / simulation_id / "run_state.json", run)
    (roots[0] / "broken").mkdir()
    (roots[0] / "broken" / "state.json").write_text("broken")
    (roots[0] / "notes.txt").write_text("not a record")
    (roots[0] / "linked").symlink_to(roots[0] / "sim_a", target_is_directory=True)
    result = reader.list_comparison_candidates(*map(str, roots))
    assert [item["simulation_id"] for item in result["candidates"]] == ["sim_new", "sim_a", "sim_z", "sim_bad_date"]
    assert result["skipped_records"] == 2
    assert set(result["candidates"][0]) == {"simulation_id", "project_id", "scenario", "status", "created_at", "updated_at"}


def test_absent_candidate_roots_are_not_created(reader, roots):
    assert reader.list_comparison_candidates(*map(str, roots)) == {"candidates": [], "skipped_records": 0}
    assert not any(root.exists() for root in roots)


@pytest.mark.parametrize("budget,value,contents", [
    ("MAX_LOG_BYTES", 40, '{"agent_id":0,"action_type":"X"}\n' * 2),
    ("MAX_LINE_BYTES", 35, '{"agent_id":0,"action_type":"TOO_LONG_FOR_TEST_LINE"}\n'),
    ("MAX_LOG_RECORDS", 1, '{"event_type":"round_start"}\n' * 2),
])
def test_oversize_source_is_refused_without_partial_counts(reader, roots, monkeypatch, budget, value, contents):
    pair(roots)
    # Keep the other sources empty and readable under the artificial budget.
    for path in roots[1].rglob("actions.jsonl"):
        path.write_text("")
    (roots[1] / "sim_left" / "twitter" / "actions.jsonl").write_text(contents)
    monkeypatch.setattr(reader, budget, value)
    result = compare(reader, roots)
    platform = result["left"]["metrics"]["platforms"]["twitter"]
    assert platform["availability"] == "unavailable"
    assert platform["recorded_actions"] is None
    assert "source_too_large" in warning_codes(result["left"])
    assert result["differences"]["recorded_actions"] is None


def test_per_side_action_type_budget_refuses_instead_of_truncating(reader, roots, monkeypatch):
    pair(roots)
    modern(roots, "sim_left", "twitter", [(0, 0, "A", True)])
    modern(roots, "sim_left", "reddit", [(0, 0, "B", True)])
    monkeypatch.setattr(reader, "MAX_ACTION_TYPES", 1)
    result = compare(reader, roots)
    assert result["left"]["availability"] == "unavailable"
    assert result["left"]["metrics"]["recorded_actions"] is None
    assert result["left"]["metrics"]["action_types"] == []
    assert "source_too_large" in warning_codes(result["left"])


def test_long_action_type_is_invalid_and_absent_type_is_null_on_partial_side(reader, roots):
    pair(roots)
    path = roots[1] / "sim_left" / "twitter" / "actions.jsonl"
    path.write_text(json.dumps({"agent_id": 0, "action_type": "X" * 257}) + "\n")
    modern(roots, "sim_right", "reddit", [(0, 0, "ONLY_RIGHT", True)])
    result = compare(reader, roots)
    assert result["left"]["availability"] == "partial"
    assert result["differences"]["action_types"] == [
        {"action_type": "ONLY_RIGHT", "left": None, "right": 1, "difference": None},
    ]


@pytest.mark.parametrize("filename,budget", [("state.json", "MAX_STATE_BYTES"), ("simulation_config.json", "MAX_CONFIG_BYTES"), ("run_state.json", "MAX_STATE_BYTES")])
def test_metadata_is_bounded(reader, roots, monkeypatch, filename, budget):
    pair(roots)
    root = roots[1] if filename == "run_state.json" else roots[0]
    path = root / "sim_left" / filename
    content = json.loads(path.read_text())
    content["oversize"] = "X" * 5000
    write_json(path, content)
    monkeypatch.setattr(reader, budget, 1500)
    if filename == "state.json":
        with pytest.raises(reader.ComparisonError) as error:
            compare(reader, roots)
        assert error.value.code == "simulation_unreadable"
    else:
        left = compare(reader, roots)["left"]
        expected = "run_state_unavailable" if filename == "run_state.json" else "config_unavailable"
        assert expected in warning_codes(left)
        assert left["metrics"]["recorded_actions"] == 0


def test_existing_unreadable_source_is_unavailable_with_safe_warning(reader, roots):
    pair(roots)
    path = roots[1] / "sim_left" / "twitter" / "actions.jsonl"
    path.unlink()
    path.mkdir()
    left = compare(reader, roots)["left"]
    assert left["metrics"]["platforms"]["twitter"]["recorded_actions"] is None
    assert "source_unreadable" in warning_codes(left)


@pytest.mark.parametrize("field,value", [("event_type", {}), ("event_type", []), ("event_type", "unknown_event"), ("event_type", None), ("event_type", False), ("platform", {}), ("platform", []), ("action_type", {})])
def test_untrusted_nested_row_fields_never_raise(reader, roots, field, value):
    pair(roots)
    row = {"agent_id": 0, "action_type": "X", field: value}
    path = roots[1] / "sim_left" / "twitter" / "actions.jsonl"
    path.write_text(json.dumps(row) + "\n")
    result = compare(reader, roots)
    assert result["left"]["availability"] == "partial"
    assert "invalid_records" in warning_codes(result["left"])


@pytest.mark.parametrize("field,root_index,value", [("runner_status", 1, []), ("runner_status", 1, {}), ("status", 0, [])])
def test_malformed_status_values_remain_safe_metadata(reader, roots, field, root_index, value):
    pair(roots)
    path = roots[root_index] / "sim_left" / ("run_state.json" if root_index else "state.json")
    content = json.loads(path.read_text())
    content[field] = value
    write_json(path, content)
    if not root_index:
        (roots[1] / "sim_left" / "run_state.json").unlink()
    left = compare(reader, roots)["left"]
    assert "run_state_unavailable" in warning_codes(left)
    assert left["status"] == ("completed" if root_index else "unknown")


def test_state_replacement_while_opening_gets_retryable_error(reader, roots, monkeypatch):
    pair(roots)
    original = builtins.open
    target = roots[0] / "sim_left" / "state.json"
    fired = False
    def changing_open(file, *args, **kwargs):
        nonlocal fired
        if str(file) == str(target) and not fired:
            fired = True
            target.unlink()
        return original(file, *args, **kwargs)
    monkeypatch.setattr(builtins, "open", changing_open)
    with pytest.raises(reader.ComparisonError) as error:
        compare(reader, roots)
    assert (error.value.code, error.value.status_code) == ("sources_changed", 409)


def test_legacy_event_platform_establishes_zero_without_enabled_flags(reader, roots):
    pair(roots)
    state, _, _ = saved(roots, "sim_left")
    state.pop("enable_twitter")
    state["enable_reddit"] = False
    write_json(roots[0] / "sim_left" / "state.json", state)
    for platform in ("twitter", "reddit"):
        (roots[1] / "sim_left" / platform / "actions.jsonl").unlink()
    logger = ActionLogger(str(roots[1] / "sim_left" / "actions.jsonl"))
    logger.log_round_start(0, 0, "twitter")
    left = compare(reader, roots)["left"]
    assert left["availability"] == "complete"
    assert left["metrics"]["platforms"]["twitter"]["recorded_actions"] == 0
