"""Saved action pages preserve strict source admission and literal recorded data."""

import builtins
import importlib
import importlib.util
import json
import os
from pathlib import Path

import pytest

from app.services import simulation_comparison as shared
from scripts.action_logger import ActionLogger, PlatformActionLogger


def test_reader_module_is_available():
    assert importlib.util.find_spec("app.services.saved_activity") is not None, "Saved activity reader is missing"


@pytest.fixture
def reader():
    name = "app.services.saved_activity"
    assert importlib.util.find_spec(name) is not None, "Saved activity reader is missing"
    return importlib.import_module(name)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.fixture
def roots(tmp_path):
    roots = tmp_path / "states", tmp_path / "runs"
    write_json(roots[0] / "sim_saved/state.json", {
        "simulation_id": "sim_saved", "status": "completed", "enable_twitter": True,
        "enable_reddit": True, "created_at": "2026-01-01", "current_round": 2,
    })
    write_json(roots[0] / "sim_saved/simulation_config.json", {
        "llm_api_key": "PRIVATE_CONFIG_MARKER", "simulation_requirement": "PRIVATE_PROMPT",
    })
    write_json(roots[1] / "sim_saved/run_state.json", {
        "simulation_id": "sim_saved", "runner_status": "completed", "total_rounds": 10,
        "current_round": 3, "updated_at": "2026-01-02", "started_at": "2026-01-01",
        "completed_at": "2026-01-02",
    })
    return roots


def read(reader, roots, **kwargs):
    return reader.read_saved_activity(*map(str, roots), "sim_saved", **kwargs)


def log_path(roots, source="twitter"):
    return roots[1] / "sim_saved" / ("actions.jsonl" if source == "legacy" else f"{source}/actions.jsonl")


def rows(roots, source="twitter", values=()):
    path = log_path(roots, source)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(value) + "\n" for value in values), encoding="utf-8")
    return path


def action(**extra):
    return {"round": 0, "agent_id": 0, "action_type": "LIKE_POST", **extra}


def test_real_loggers_preserve_attempts_payload_and_allowlisted_context(reader, roots):
    log = PlatformActionLogger("twitter", str(roots[1] / "sim_saved"))
    log.log_simulation_start({})
    log.log_action(0, 0, "Saved agent", "CREATE_POST", {"text": "<script>literal</script>"}, "result", False)
    log.log_simulation_end(1, 1)
    rows(roots, "reddit")
    result = read(reader, roots)
    recorded = json.loads(Path(log.log_path).read_text().splitlines()[1])
    assert result["simulation_id"] == "sim_saved"
    assert result["availability"] == "complete"
    assert result["platform_availability"] == {"twitter": "complete", "reddit": "complete"}
    assert result["order"] == "source_record"
    assert result["filters"] == dict(platform=None, agent_id=None, round_num=None, action_type=None,
                                     q=None, case_sensitive=False, outcome=None)
    assert (result["offset"], result["limit"], result["returned_count"], result["matched_count"], result["has_more"]) == (0, 50, 1, 1, False)
    assert result["actions"] == [{
        "record_id": "twitter:2", "platform": "twitter", "round_num": "0", "agent_id": "0",
        "agent_name": "Saved agent", "timestamp": recorded["timestamp"], "action_type": "CREATE_POST",
        "success": False, "match_preview": None,
        "details_json": json.dumps(recorded, sort_keys=True, separators=(",", ":")),
    }]
    assert result["context"] == {
        "status": "completed", "created_at": "2026-01-01", "updated_at": "2026-01-02",
        "started_at": "2026-01-01", "completed_at": "2026-01-02",
        "requested_rounds": "10", "last_saved_round": "3",
    }
    assert len(result["source_revision"]) == 64
    assert result["observed_at"].endswith("+00:00")
    assert "PRIVATE_" not in json.dumps(result)


def test_pagination_uses_source_and_physical_line_order_without_deduplication(reader, roots):
    identical = action(timestamp="2099-01-01")
    path = rows(roots, "twitter", [identical, identical])
    path.write_text("\n" + path.read_text() + "broken\n" + json.dumps(action(timestamp="1900-01-01")) + "\n")
    rows(roots, "reddit", [action()])
    first = read(reader, roots, limit=2)
    second = read(reader, roots, limit=2, offset=2, revision=first["source_revision"])
    assert [item["record_id"] for item in first["actions"]] == ["twitter:2", "twitter:3"]
    assert [item["record_id"] for item in second["actions"]] == ["twitter:5", "reddit:1"]
    assert first["has_more"] is True and second["has_more"] is False
    assert first["matched_count"] == second["matched_count"] == 4
    assert first["availability"] == second["availability"] == "partial"
    assert first["source_revision"] == second["source_revision"]
    assert read(reader, roots, offset=50, revision=first["source_revision"])["actions"] == []


def test_exact_combined_filters_zero_and_large_decimal_numbers(reader, roots):
    large = int("9" * 64)
    rows(roots, "twitter", [action(agent_id=large, round=large), action(agent_id=large), action()])
    rows(roots, "reddit", [action(agent_id=large, round=large)])
    result = read(reader, roots, platform="twitter", agent_id=str(large), round_num=str(large), action_type="LIKE_POST")
    assert result["matched_count"] == 1
    assert result["actions"][0]["agent_id"] == result["actions"][0]["round_num"] == str(large)
    assert json.loads(result["actions"][0]["details_json"])["agent_id"] == large
    zero = read(reader, roots, agent_id="000", round_num="000", action_type="LIKE_POST")
    assert zero["filters"]["agent_id"] == zero["filters"]["round_num"] == "0"
    assert zero["matched_count"] == 1
    assert read(reader, roots, action_type="like_post")["matched_count"] == 0


@pytest.mark.parametrize("success", [None, "false", 1, [], {}, False, True])
def test_unknown_optional_values_are_literal_without_inventing_success(reader, roots, success):
    original = {"agent_id": 0, "action_type": "X", "agent_name": ["unusual"], "success": success, "result": {"large": 9007199254740993}}
    rows(roots, values=[original])
    result = read(reader, roots)["actions"][0]
    assert result["success"] is (success if type(success) is bool else None)
    assert result["agent_name"] is None and result["timestamp"] is None
    assert result["round_num"] == "0"
    assert json.loads(result["details_json"]) == original


def test_legacy_writer_order_and_modern_precedence(reader, roots):
    logger = ActionLogger(str(log_path(roots, "legacy")))
    logger.log_round_start(0, 0, "twitter")
    logger.log_action(0, "reddit", 1, "Old", "OLD", success=False)
    logger.log_action(1, "twitter", 0, "Old", "OLD")
    legacy = read(reader, roots)
    assert [row["record_id"] for row in legacy["actions"]] == ["legacy:2", "legacy:3"]
    assert legacy["availability"] == "complete"
    rows(roots)
    modern = read(reader, roots)
    assert modern["matched_count"] == 0 and modern["actions"] == []
    assert modern["availability"] == "partial"
    assert modern["source_revision"] != legacy["source_revision"]


@pytest.mark.parametrize("contents,expected", [(None, "unavailable"), ("", "complete"), ('{"event_type":"round_start"}\n', "complete"), ('bad\n', "partial")])
def test_unavailable_empty_and_invalid_sources_are_distinct(reader, roots, contents, expected):
    state_path = roots[0] / "sim_saved/state.json"
    state = json.loads(state_path.read_text())
    state["enable_reddit"] = False
    write_json(state_path, state)
    if contents is not None:
        rows(roots).write_text(contents)
    result = read(reader, roots)
    assert result["availability"] == expected
    assert result["matched_count"] == (None if expected == "unavailable" else 0)
    absent = read(reader, roots, platform="reddit")
    assert absent["availability"] == "unavailable" and absent["matched_count"] is None


@pytest.mark.parametrize("status", ["starting", "running", "paused", "stopping", "idle", "failed", "stopped"])
def test_saved_status_policy(reader, roots, status):
    path = roots[1] / "sim_saved/run_state.json"
    run = json.loads(path.read_text())
    run["runner_status"] = status
    write_json(path, run)
    rows(roots, values=[action()])
    if status in shared._ACTIVE:
        with pytest.raises(shared.ComparisonError) as error:
            read(reader, roots)
        assert (error.value.code, error.value.status_code) == ("simulation_active", 409)
    else:
        result = read(reader, roots)
        assert result["matched_count"] == (None if status == "idle" else 1)
        assert {"code": "run_not_terminal" if status == "idle" else "partial_run"} in result["warnings"]


@pytest.mark.parametrize("budget,value", [("MAX_LOG_RECORDS", 2), ("MAX_ACTION_TYPES", 1), ("MAX_LINE_BYTES", 100)])
def test_late_source_refusal_rolls_back_rows_counts_and_offset(reader, roots, monkeypatch, budget, value):
    rows(roots, values=[action(), action(), action(action_type="OTHER", result="x" * 100)])
    rows(roots, "reddit", [action(agent_id=10), action(agent_id=11)])
    monkeypatch.setattr(shared, budget, value)
    first = read(reader, roots, limit=1)
    assert first["matched_count"] == 2
    assert first["actions"][0]["agent_id"] == "10"
    second = read(reader, roots, offset=1, limit=1, action_type="LIKE_POST", revision=first["source_revision"])
    assert second["matched_count"] == 2
    assert [row["record_id"] for row in second["actions"]] == ["reddit:2"]
    assert second["platform_availability"]["twitter"] == "unavailable"


def test_late_io_failure_rolls_back_source(reader, roots, monkeypatch):
    path = rows(roots, values=[action(), action()])
    rows(roots, "reddit", [action(agent_id=2), action(agent_id=3)])
    original = shared._open_source
    class BrokenStream:
        def __init__(self, stream):
            self.stream, self.reads = stream, 0
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.stream.close()
        def fileno(self):
            return self.stream.fileno()
        def readline(self, maximum):
            self.reads += 1
            if self.reads == 2:
                raise OSError("private source failure")
            return self.stream.readline(maximum)
    monkeypatch.setattr(shared, "_open_source", lambda source: BrokenStream(original(source)) if str(source) == str(path) else original(source))
    result = read(reader, roots)
    assert result["matched_count"] == 2
    assert [row["record_id"] for row in result["actions"]] == ["reddit:1", "reddit:2"]
    assert {"code": "source_unreadable", "platform": "twitter"} in result["warnings"]


def test_combined_type_budget_invalidates_all_collected_records(reader, roots, monkeypatch):
    rows(roots, values=[action(action_type="A")])
    rows(roots, "reddit", [action(action_type="B")])
    monkeypatch.setattr(shared, "MAX_ACTION_TYPES", 1)
    result = read(reader, roots)
    assert result["availability"] == "unavailable"
    assert result["matched_count"] is None and result["actions"] == []
    assert result["returned_count"] == 0 and result["has_more"] is False


def test_global_type_refusal_clears_earlier_page_overflow(reader, roots, monkeypatch):
    rows(roots, values=[action(action_type="A", result="x" * 1000)])
    rows(roots, "reddit", [action(action_type="B")])
    monkeypatch.setattr(reader, "MAX_PAGE_BYTES", 500)
    monkeypatch.setattr(shared, "MAX_ACTION_TYPES", 1)
    result = read(reader, roots)
    assert result["availability"] == "unavailable" and result["actions"] == []
    assert result["matched_count"] is None
    assert {"code": "source_too_large"} in result["warnings"]


@pytest.mark.parametrize("row", [
    'not json', '[]', '{"agent_id":NaN}', '{"agent_id":true,"action_type":"X"}',
    '{"agent_id":0,"action_type":"X","round":-1}', '{"agent_id":0,"action_type":" "}',
    '{"agent_id":0,"action_type":"X","timestamp":42}', '{"agent_id":0,"action_type":"X","platform":"reddit"}',
    '{"agent_id":0,"action_type":"X","result":1e999}', '{"event_type":[]}',
])
def test_explorer_and_comparison_share_strict_validation(reader, roots, row):
    path = rows(roots, values=[action()])
    with path.open("a") as stream:
        stream.write(row + "\n")
    result = read(reader, roots)
    assert result["matched_count"] == 1
    assert result["availability"] == "partial"
    assert {"code": "invalid_records", "platform": "twitter", "count": 1} in result["warnings"]


@pytest.mark.parametrize("root_index,relative", [(0, "state.json"), (0, "simulation_config.json"), (1, "run_state.json"), (1, "twitter/actions.jsonl"), (1, "reddit/actions.jsonl"), (1, "actions.jsonl")])
def test_all_paths_are_preflighted_before_any_read(reader, roots, monkeypatch, tmp_path, root_index, relative):
    rows(roots)
    path = roots[root_index] / "sim_saved" / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    outside = tmp_path / "outside"
    outside.write_text("private")
    try:
        path.symlink_to(outside)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"Native symlink fixture is unsupported: {error}")
    monkeypatch.setattr(builtins, "open", lambda *args, **kwargs: pytest.fail("Unsafe source reached reading"))
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots)
    assert (error.value.code, error.value.status_code) == ("unsafe_path", 400)


@pytest.mark.parametrize("kind", ["directory", "fifo"])
def test_nonregular_logs_are_unavailable_without_blocking(reader, roots, kind):
    path = log_path(roots)
    path.parent.mkdir(parents=True)
    if kind == "directory":
        path.mkdir()
    else:
        if not hasattr(os, "mkfifo"):
            pytest.skip("Native FIFO fixture is unsupported")
        try:
            os.mkfifo(path)
        except (OSError, NotImplementedError) as error:
            pytest.skip(f"Native FIFO fixture is unsupported: {error}")
    result = read(reader, roots)
    assert result["availability"] == "unavailable"
    assert {"code": "source_unreadable", "platform": "twitter"} in result["warnings"]


@pytest.mark.parametrize("relative", ["sim_alias", "sim_saved/twitter"])
def test_descendant_directory_aliases_are_rejected(reader, roots, tmp_path, relative):
    target = tmp_path / "elsewhere"
    target.mkdir()
    alias = roots[1] / relative
    try:
        alias.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"Native symlink fixture is unsupported: {error}")
    simulation_id = "sim_alias" if relative == "sim_alias" else "sim_saved"
    with pytest.raises(shared.ComparisonError) as error:
        reader.read_saved_activity(*map(str, roots), simulation_id)
    assert error.value.code == "unsafe_path"


@pytest.mark.parametrize("change", ["append", "replace", "remove", "new_modern", "metadata"])
def test_revision_rejects_changed_sources_before_reading(reader, roots, monkeypatch, change):
    path = rows(roots, values=[action(), action()])
    first = read(reader, roots, limit=1)
    if change == "append":
        with path.open("a") as stream:
            stream.write("{}\n")
    elif change == "replace":
        replacement = path.with_suffix(".replacement")
        replacement.write_bytes(path.read_bytes())
        replacement.replace(path)
    elif change == "remove":
        path.unlink()
    elif change == "new_modern":
        rows(roots, "reddit")
    else:
        (roots[0] / "sim_saved/simulation_config.json").write_text("{}")
    monkeypatch.setattr(shared, "_open_source", lambda *args: pytest.fail("Stale revision reached file reads"))
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, offset=1, revision=first["source_revision"])
    assert (error.value.code, error.value.status_code) == ("sources_changed", 409)


@pytest.mark.parametrize("failure", [False, True])
def test_revision_changes_during_success_or_error_take_precedence(reader, roots, monkeypatch, failure):
    path = rows(roots, values=[action()])
    original = shared._open_source
    changed = False
    def changing_open(source):
        nonlocal changed
        if not changed:
            changed = True
            with path.open("a") as stream:
                stream.write("{}\n")
            if failure:
                raise OSError("private path")
        return original(source)
    monkeypatch.setattr(shared, "_open_source", changing_open)
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots)
    assert (error.value.code, error.value.status_code) == ("sources_changed", 409)


@pytest.mark.parametrize("budget", ["MAX_PAGE_BYTES", "MAX_RESPONSE_BYTES"])
def test_output_budgets_refuse_without_truncating(reader, roots, monkeypatch, budget):
    rows(roots, values=[action(result="x" * 1000)])
    monkeypatch.setattr(reader, budget, 500)
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots)
    assert (error.value.code, error.value.status_code) == ("response_too_large", 413)


def test_oversized_refused_source_does_not_poison_healthy_page(reader, roots, monkeypatch):
    rows(roots, values=[action(result="x" * 1000), action()])
    rows(roots, "reddit", [action()])
    monkeypatch.setattr(reader, "MAX_PAGE_BYTES", 500)
    monkeypatch.setattr(shared, "MAX_LOG_RECORDS", 1)
    result = read(reader, roots)
    assert [row["record_id"] for row in result["actions"]] == ["reddit:1"]


def test_default_page_budget_can_be_recovered_by_smaller_page(reader, roots):
    rows(roots, values=[action(result="x" * 750000)] * 3)
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, limit=3)
    assert error.value.code == "response_too_large"
    result = read(reader, roots, limit=1)
    assert result["matched_count"] == 3 and result["returned_count"] == 1
    assert result["has_more"] is True
    assert len(result["actions"][0]["details_json"]) > 750000


def test_page_bound_does_not_reject_large_rows_outside_the_selected_page(reader, roots, monkeypatch):
    rows(roots, values=[action(result="x" * 1000), action()])
    monkeypatch.setattr(reader, "MAX_PAGE_BYTES", 500)
    revision = read(reader, roots, action_type="ABSENT")["source_revision"]
    result = read(reader, roots, offset=1, limit=1, revision=revision)
    assert result["actions"][0]["record_id"] == "twitter:2"
    assert result["matched_count"] == 2


def test_metadata_rounds_remain_exact_and_noninteger_rounds_stay_unknown(reader, roots):
    path = roots[1] / "sim_saved/run_state.json"
    run = json.loads(path.read_text())
    run["total_rounds"], run["current_round"] = 9007199254740993, False
    write_json(path, run)
    result = read(reader, roots)
    assert result["context"]["requested_rounds"] == "9007199254740993"
    assert result["context"]["last_saved_round"] is None


def test_missing_run_uses_terminal_state_without_fabricated_requested_rounds(reader, roots):
    (roots[1] / "sim_saved/run_state.json").unlink()
    rows(roots, values=[action()])
    result = read(reader, roots)
    assert result["context"]["status"] == "completed"
    assert result["context"]["requested_rounds"] is None
    assert result["context"]["last_saved_round"] == "2"
    assert result["matched_count"] == 1
    assert {"code": "run_state_unavailable"} in result["warnings"]


def test_revision_includes_absent_unselected_legacy_source(reader, roots):
    rows(roots, values=[action()])
    first = read(reader, roots)
    rows(roots, "legacy", [action(platform="reddit")])
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, revision=first["source_revision"])
    assert error.value.code == "sources_changed"
    fresh = read(reader, roots)
    assert [row["record_id"] for row in fresh["actions"]] == ["twitter:1"]


def test_log_byte_budget_refuses_entire_source(reader, roots, monkeypatch):
    rows(roots, values=[action(), action()])
    rows(roots, "reddit")
    monkeypatch.setattr(shared, "MAX_LOG_BYTES", 60)
    result = read(reader, roots)
    assert result["actions"] == [] and result["matched_count"] == 0
    assert result["platform_availability"]["twitter"] == "unavailable"
    assert {"code": "source_too_large", "platform": "twitter"} in result["warnings"]


@pytest.mark.parametrize("simulation_id", ["../outside", "CON", "x/y", "", None])
def test_invalid_id_fails_before_storage(reader, roots, monkeypatch, simulation_id):
    monkeypatch.setattr(shared, "_paths", lambda *args: pytest.fail("Invalid ID reached storage"))
    with pytest.raises(shared.ComparisonError) as error:
        reader.read_saved_activity(*map(str, roots), simulation_id)
    assert error.value.code == "invalid_selection"


@pytest.mark.parametrize("kwargs,code", [
    ({"platform": "Twitter"}, "invalid_filters"), ({"agent_id": "-1"}, "invalid_filters"),
    ({"agent_id": "１"}, "invalid_filters"), ({"agent_id": "1" * 65}, "invalid_filters"),
    ({"round_num": True}, "invalid_filters"), ({"action_type": "\nX"}, "invalid_filters"),
    ({"action_type": " "}, "invalid_filters"), ({"action_type": "X" * 257}, "invalid_filters"),
    ({"offset": -1}, "invalid_pagination"), ({"offset": 500001}, "invalid_pagination"),
    ({"limit": 0}, "invalid_pagination"), ({"limit": 101}, "invalid_pagination"),
    ({"limit": True}, "invalid_pagination"), ({"offset": 1}, "revision_required"),
    ({"revision": "F" * 64}, "invalid_revision"), ({"revision": ""}, "invalid_revision"),
])
def test_service_admission_rejects_invalid_requests_before_storage(reader, roots, monkeypatch, kwargs, code):
    monkeypatch.setattr(shared, "_paths", lambda *args: pytest.fail("Invalid request reached storage"))
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, **kwargs)
    assert (error.value.code, error.value.status_code) == (code, 400)
