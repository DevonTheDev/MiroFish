"""Round observations use the saved reader's admission and revision boundary."""

import builtins
import hashlib
import importlib
import importlib.util
import json
import os

import pytest
from werkzeug.datastructures import MultiDict

from app.services import saved_activity as records
from app.services import simulation_comparison as shared
from scripts.action_logger import ActionLogger, PlatformActionLogger
from test_saved_activity import action, log_path, roots as roots, rows, write_json


def test_round_reader_module_is_available():
    assert importlib.util.find_spec("app.services.saved_activity_rounds") is not None, "Saved round reader is missing"


@pytest.fixture
def reader():
    name = "app.services.saved_activity_rounds"
    assert importlib.util.find_spec(name) is not None, "Saved round reader is missing"
    return importlib.import_module(name)


def read(reader, roots, **kwargs):
    return reader.read_saved_activity_rounds(*map(str, roots), "sim_saved", **kwargs)


def bucket(round_num, success=0, failed=0, unknown=0):
    return {
        "round_num": str(round_num), "count": success + failed + unknown,
        "outcomes": {"success": success, "failed": failed, "unknown": unknown},
        "drilldown_supported": len(str(round_num)) <= 64,
    }


def test_actual_loggers_count_duplicate_attempts_and_only_observed_rounds(reader, roots):
    twitter = PlatformActionLogger("twitter", str(roots[1] / "sim_saved"))
    reddit = PlatformActionLogger("reddit", str(roots[1] / "sim_saved"))
    twitter.log_simulation_start({})
    twitter.log_round_start(9, 9)
    twitter.log_action(10, 1, "PRIVATE_AGENT", "POST", {"secret": "PRIVATE_PAYLOAD"}, success=False)
    twitter.log_action(2, 2, "Saved", "LIKE", success=True)
    twitter.log_action(10, 1, "PRIVATE_AGENT", "POST", success=False)
    twitter.log_simulation_end(100, 3)
    reddit.log_action(2, 0, "Saved", "VOTE", success=True)
    result = read(reader, roots)
    assert set(result) == {
        "simulation_id", "source_revision", "observed_at", "context", "availability",
        "platform_availability", "warnings", "filters", "order", "matched_count",
        "round_count", "outcomes", "rounds",
    }
    assert result["simulation_id"] == "sim_saved"
    assert result["availability"] == "complete"
    assert result["platform_availability"] == {"twitter": "complete", "reddit": "complete"}
    assert result["filters"] == {"platform": None, "round_from": None, "round_to": None}
    assert result["order"] == "round_ascending"
    assert result["rounds"] == [bucket(2, success=2), bucket(10, failed=2)]
    assert (result["matched_count"], result["round_count"]) == (4, 2)
    assert result["outcomes"] == {"success": 2, "failed": 2, "unknown": 0}
    assert result["context"] == {
        "status": "completed", "created_at": "2026-01-01", "updated_at": "2026-01-02",
        "started_at": "2026-01-01", "completed_at": "2026-01-02",
        "requested_rounds": "10", "last_saved_round": "3",
    }
    assert result["observed_at"].endswith("+00:00")
    assert "PRIVATE_" not in json.dumps(result)


def test_exact_boolean_outcomes_missing_round_default_and_numeric_order(reader, roots):
    values = [None, "false", 0, 1, [], {}, False, True]
    rows(roots, values=[action(round=10, success=value) for value in values] + [
        {"agent_id": 0, "action_type": "MISSING_ROUND"},
        action(round=2), action(round=9007199254740993),
    ])
    result = read(reader, roots)
    assert result["rounds"] == [bucket(0, unknown=1), bucket(2, unknown=1),
                               bucket(10, success=1, failed=1, unknown=6),
                               bucket(9007199254740993, unknown=1)]
    assert result["matched_count"] == 11
    assert result["outcomes"] == {"success": 1, "failed": 1, "unknown": 9}


def test_platform_and_inclusive_range_filter_only_admitted_matching_attempts(reader, roots):
    rows(roots, values=[action(round=n, success=True) for n in (0, 2, 10, 11)])
    rows(roots, "reddit", [action(round=n, success=False) for n in (2, 3, 10)])
    result = read(reader, roots, platform="reddit", round_from="0002", round_to="0010")
    assert result["filters"] == {"platform": "reddit", "round_from": "2", "round_to": "10"}
    assert result["rounds"] == [bucket(2, failed=1), bucket(3, failed=1), bucket(10, failed=1)]
    assert result["matched_count"] == 3 and result["outcomes"] == {"success": 0, "failed": 3, "unknown": 0}
    assert read(reader, roots, round_from="10", round_to="10")["rounds"] == [bucket(10, success=1, failed=1)]
    empty = read(reader, roots, round_from="100")
    assert empty["rounds"] == [] and empty["matched_count"] == 0
    assert empty["outcomes"] == {"success": 0, "failed": 0, "unknown": 0}


def test_sparse_large_rounds_stay_exact_and_do_not_widen_record_filter_contract(reader, roots):
    largest_supported = int("9" * 64)
    unsupported = 10 ** 64
    rows(roots, values=[action(round=unsupported), action(round=largest_supported), action(round=0)])
    result = read(reader, roots)
    assert result["rounds"] == [bucket(0, unknown=1), bucket(largest_supported, unknown=1), bucket(unsupported, unknown=1)]
    assert result["round_count"] == 3
    assert read(reader, roots, round_from=str(largest_supported))["rounds"] == result["rounds"][1:]
    with pytest.raises(shared.ComparisonError) as error:
        records.read_saved_activity(*map(str, roots), "sim_saved", round_num=str(unsupported))
    assert error.value.code == "invalid_filters"


def test_legacy_logger_platform_coverage_and_modern_precedence(reader, roots):
    logger = ActionLogger(str(log_path(roots, "legacy")))
    logger.log_round_start(0, 0, "twitter")
    logger.log_action(0, "reddit", 1, "Old", "OLD", success=False)
    logger.log_action(3, "twitter", 0, "Old", "OLD")
    first = read(reader, roots)
    assert first["availability"] == "complete"
    assert first["rounds"] == [bucket(0, failed=1), bucket(3, success=1)]
    assert read(reader, roots, platform="reddit")["rounds"] == [bucket(0, failed=1)]
    rows(roots)
    modern = read(reader, roots)
    assert modern["matched_count"] == 0 and modern["rounds"] == []
    assert modern["availability"] == "partial"
    assert modern["source_revision"] != first["source_revision"]


@pytest.mark.parametrize("contents,availability", [
    (None, "unavailable"), ("", "complete"), ('{"event_type":"round_start"}\n', "complete"),
    ("bad\n", "partial"),
])
def test_missing_empty_event_only_and_malformed_sources_remain_distinct(reader, roots, contents, availability):
    path = roots[0] / "sim_saved/state.json"
    state = json.loads(path.read_text())
    state["enable_reddit"] = False
    write_json(path, state)
    if contents is not None:
        rows(roots).write_text(contents)
    result = read(reader, roots)
    assert result["availability"] == availability
    assert result["matched_count"] == (None if availability == "unavailable" else 0)
    assert result["outcomes"] == {key: None if availability == "unavailable" else 0 for key in ("success", "failed", "unknown")}
    assert result["rounds"] == [] and result["round_count"] == 0
    absent = read(reader, roots, platform="reddit")
    assert absent["availability"] == "unavailable" and absent["matched_count"] is None
    assert absent["outcomes"] == {"success": None, "failed": None, "unknown": None}


@pytest.mark.parametrize("status", ["starting", "running", "paused", "stopping", "idle", "failed", "stopped"])
def test_saved_active_terminal_policy_is_shared(reader, roots, status):
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


@pytest.mark.parametrize("malformed", [
    "not json", "[]", '{"agent_id":NaN}', '{"agent_id":true,"action_type":"X"}',
    '{"agent_id":0,"action_type":"X","round":-1}', '{"agent_id":0,"action_type":" "}',
    '{"agent_id":0,"action_type":"X","timestamp":42}',
    '{"agent_id":0,"action_type":"X","platform":"reddit"}',
    '{"agent_id":0,"action_type":"X","result":1e999}', '{"event_type":[]}',
])
def test_malformed_neighbors_share_strict_saved_admission(reader, roots, malformed):
    path = rows(roots, values=[action(round=4, success=False)])
    with path.open("a") as stream:
        stream.write(malformed + "\n")
    result = read(reader, roots)
    assert result["rounds"] == [bucket(4, failed=1)] and result["matched_count"] == 1
    assert result["availability"] == "partial"
    assert {"code": "invalid_records", "platform": "twitter", "count": 1} in result["warnings"]


def test_exact_1000_distinct_round_limit_counts_overlap_and_refuses_1001(reader, roots):
    rows(roots, values=[action(round=n) for n in range(1000)])
    path = rows(roots, "reddit", [action(round=n, success=False) for n in range(1000)])
    result = read(reader, roots)
    assert result["round_count"] == 1000 and result["matched_count"] == 2000
    assert result["rounds"][0] == bucket(0, failed=1, unknown=1)
    with path.open("a") as stream:
        stream.write(json.dumps(action(round=1000)) + "\n")
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots)
    assert (error.value.code, error.value.status_code) == ("too_many_rounds", 413)
    assert read(reader, roots, round_from="0", round_to="999")["round_count"] == 1000
    assert read(reader, roots, platform="twitter")["round_count"] == 1000


def test_overflow_in_one_admitted_source_refuses_without_truncating(reader, roots):
    rows(roots, values=[action(round=n) for n in range(1001)])
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots)
    assert (error.value.code, error.value.status_code) == ("too_many_rounds", 413)


@pytest.mark.parametrize("budget,value", [("MAX_LOG_RECORDS", 3), ("MAX_LINE_BYTES", 200), ("MAX_ACTION_TYPES", 1)])
def test_late_refusal_discards_tentative_round_overflow_and_counts(reader, roots, monkeypatch, budget, value):
    rows(roots, values=[action(round=n, success=False) for n in range(3)] + [action(action_type="OTHER", result="x" * 200)])
    rows(roots, "reddit", [action(round=9, success=True)])
    monkeypatch.setattr(reader, "MAX_ROUNDS", 2)
    monkeypatch.setattr(shared, budget, value)
    result = read(reader, roots)
    assert result["rounds"] == [bucket(9, success=1)]
    assert result["matched_count"] == 1 and result["outcomes"] == {"success": 1, "failed": 0, "unknown": 0}
    assert result["platform_availability"]["twitter"] == "unavailable"
    assert {"code": "source_too_large", "platform": "twitter"} in result["warnings"]


def test_late_io_refusal_discards_round_overflow_but_keeps_healthy_source(reader, roots, monkeypatch):
    path = rows(roots, values=[action(round=n, success=False) for n in range(3)])
    rows(roots, "reddit", [action(round=9, success=True)])
    monkeypatch.setattr(reader, "MAX_ROUNDS", 2)
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
            if self.reads == 4:
                raise OSError("PRIVATE_LATE_IO")
            return self.stream.readline(maximum)

    monkeypatch.setattr(shared, "_open_source", lambda source: BrokenStream(original(source)) if str(source) == str(path) else original(source))
    result = read(reader, roots)
    assert result["rounds"] == [bucket(9, success=1)] and result["matched_count"] == 1
    assert {"code": "source_unreadable", "platform": "twitter"} in result["warnings"]


def test_committed_and_staged_buckets_stay_bounded_when_second_source_overflows_then_fails(reader, roots, monkeypatch):
    rows(roots, values=[action(round=n, success=True) for n in range(1000)])
    path = rows(roots, "reddit", [action(round=n, success=False) for n in range(1001)])
    original_open, original_read = shared._open_source, shared._read_log
    largest_committed = largest_staged = 0

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
            if self.reads == 1002:
                raise OSError("PRIVATE_SECOND_SOURCE_FAILURE")
            return self.stream.readline(maximum)

    def observed_read(source, platform, *, on_action=None):
        collector = on_action.__self__
        def observed_collect(*args):
            nonlocal largest_committed, largest_staged
            on_action(*args)
            largest_committed = max(largest_committed, len(collector.rounds))
            largest_staged = max(largest_staged, len(collector.staged_rounds))
            assert len(collector.rounds) <= 1000 and len(collector.staged_rounds) <= 1000
        return original_read(source, platform, on_action=observed_collect)

    monkeypatch.setattr(shared, "_open_source", lambda source: BrokenStream(original_open(source)) if str(source) == str(path) else original_open(source))
    monkeypatch.setattr(shared, "_read_log", observed_read)
    result = read(reader, roots)
    assert (largest_committed, largest_staged) == (1000, 1000)
    assert result["round_count"] == result["matched_count"] == 1000
    assert result["outcomes"] == {"success": 1000, "failed": 0, "unknown": 0}
    assert all(row == bucket(index, success=1) for index, row in enumerate(result["rounds"]))
    assert {"code": "source_unreadable", "platform": "reddit"} in result["warnings"]


@pytest.mark.parametrize("overflow_source", ["twitter", "reddit"])
def test_global_type_refusal_clears_committed_and_pending_round_overflow(reader, roots, monkeypatch, overflow_source):
    rows(roots, values=[action(round=n, action_type="A") for n in range(3 if overflow_source == "twitter" else 1)])
    rows(roots, "reddit", [action(round=n + 10, action_type="B") for n in range(3 if overflow_source == "reddit" else 1)])
    monkeypatch.setattr(reader, "MAX_ROUNDS", 2)
    monkeypatch.setattr(shared, "MAX_ACTION_TYPES", 1)
    result = read(reader, roots)
    assert result["availability"] == "unavailable" and result["rounds"] == []
    assert result["round_count"] == 0 and result["matched_count"] is None
    assert result["outcomes"] == {"success": None, "failed": None, "unknown": None}
    assert {"code": "source_too_large"} in result["warnings"]


def test_range_or_platform_filters_do_not_bypass_source_limits(reader, roots, monkeypatch):
    rows(roots, values=[action(round=n) for n in range(4)])
    rows(roots, "reddit", [action(round=9)])
    monkeypatch.setattr(shared, "MAX_LOG_RECORDS", 3)
    result = read(reader, roots, platform="twitter", round_from="3", round_to="3")
    assert result["availability"] == "unavailable" and result["matched_count"] is None
    assert result["rounds"] == []
    assert {"code": "source_too_large", "platform": "twitter"} in result["warnings"]


def test_log_file_budget_refuses_source_before_admitting_zero(reader, roots, monkeypatch):
    rows(roots, values=[action(), action()])
    rows(roots, "reddit")
    monkeypatch.setattr(shared, "MAX_LOG_BYTES", 60)
    result = read(reader, roots)
    assert result["rounds"] == [] and result["matched_count"] == 0
    assert result["platform_availability"]["twitter"] == "unavailable"


def test_response_limit_measures_complete_success_envelope(reader, roots, monkeypatch):
    rows(roots, values=[action(round=10 ** 64)])
    first = read(reader, roots)
    assert reader.MAX_RESPONSE_BYTES == 1024 * 1024
    monkeypatch.setattr(reader, "MAX_RESPONSE_BYTES", 500)
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots)
    assert (error.value.code, error.value.status_code) == ("response_too_large", 413)
    assert first["round_count"] == 1


def test_default_response_budget_refuses_large_observed_rounds_without_truncation(reader, roots):
    rows(roots, values=[action(round=10 ** 1100 + n) for n in range(1000)])
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots)
    assert (error.value.code, error.value.status_code) == ("response_too_large", 413)


def test_revision_is_byte_identical_to_existing_saved_actions(reader, roots):
    rows(roots, values=[action()])
    before = shared._snapshot(shared._paths(*map(str, roots), "sim_saved"))
    expected = hashlib.sha256(json.dumps(["saved-activity-v1", "sim_saved", before],
                                        ensure_ascii=True, allow_nan=False, sort_keys=True,
                                        separators=(",", ":")).encode("ascii")).hexdigest()
    overview = read(reader, roots)
    detail = records.read_saved_activity(*map(str, roots), "sim_saved", revision=overview["source_revision"])
    assert overview["source_revision"] == detail["source_revision"] == expected
    assert read(reader, roots, revision=detail["source_revision"], round_to="0")["source_revision"] == expected


@pytest.mark.parametrize("change", ["append", "replace", "remove", "new_modern", "unselected_legacy", "state", "config", "run"])
def test_stale_revision_rejects_all_six_source_changes_before_reads(reader, roots, monkeypatch, change):
    path = rows(roots, values=[action()])
    revision = read(reader, roots, platform="twitter")["source_revision"]
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
    elif change == "unselected_legacy":
        rows(roots, "legacy", [action(platform="reddit")])
    else:
        metadata = {"state": roots[0] / "sim_saved/state.json", "config": roots[0] / "sim_saved/simulation_config.json", "run": roots[1] / "sim_saved/run_state.json"}[change]
        with metadata.open("a") as stream:
            stream.write("\n")
    monkeypatch.setattr(shared, "_open_source", lambda *args: pytest.fail("Stale revision reached file reads"))
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, revision=revision, platform="twitter")
    assert (error.value.code, error.value.status_code) == ("sources_changed", 409)


@pytest.mark.parametrize("failure", ["success", "read", "round_limit", "response_limit"])
def test_final_changed_source_supersedes_success_and_read_or_limit_failures(reader, roots, monkeypatch, failure):
    path = rows(roots, values=[action(round=0), action(round=1)])
    original = shared._summary
    if failure == "round_limit":
        monkeypatch.setattr(reader, "MAX_ROUNDS", 1)
    elif failure == "response_limit":
        monkeypatch.setattr(reader, "MAX_RESPONSE_BYTES", 1)

    def changed_summary(*args, **kwargs):
        result = original(*args, **kwargs)
        with path.open("a") as stream:
            stream.write("{}\n")
        if failure == "read":
            raise shared.ComparisonError("simulation_unreadable", "PRIVATE_ERROR", 404)
        return result

    monkeypatch.setattr(shared, "_summary", changed_summary)
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots)
    assert (error.value.code, error.value.status_code) == ("sources_changed", 409)


@pytest.mark.parametrize("root_index,relative", [(0, "state.json"), (0, "simulation_config.json"), (1, "run_state.json"), (1, "twitter/actions.jsonl"), (1, "reddit/actions.jsonl"), (1, "actions.jsonl")])
def test_every_source_is_preflighted_including_unselected_and_legacy(reader, roots, monkeypatch, tmp_path, root_index, relative):
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
        read(reader, roots, platform="twitter")
    assert (error.value.code, error.value.status_code) == ("unsafe_path", 400)


@pytest.mark.parametrize("kind", ["directory", "fifo"])
def test_nonregular_sources_are_unavailable_without_blocking(reader, roots, kind):
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
    assert result["availability"] == "unavailable" and result["matched_count"] is None
    assert {"code": "source_unreadable", "platform": "twitter"} in result["warnings"]


@pytest.mark.parametrize("simulation_id", ["../outside", "CON", "x/y", "", None])
def test_invalid_id_fails_before_storage(reader, roots, monkeypatch, simulation_id):
    monkeypatch.setattr(shared, "_paths", lambda *args: pytest.fail("Invalid ID reached storage"))
    with pytest.raises(shared.ComparisonError) as error:
        reader.read_saved_activity_rounds(*map(str, roots), simulation_id)
    assert error.value.code == "invalid_selection"


@pytest.mark.parametrize("kwargs,code", [
    ({"platform": "Twitter"}, "invalid_filters"), ({"platform": ""}, "invalid_filters"),
    ({"round_from": "-1"}, "invalid_filters"), ({"round_from": "１"}, "invalid_filters"),
    ({"round_from": "1" * 65}, "invalid_filters"), ({"round_from": True}, "invalid_filters"),
    ({"round_to": ""}, "invalid_filters"), ({"round_to": "1.0"}, "invalid_filters"),
    ({"round_to": "+1"}, "invalid_filters"), ({"round_to": 1}, "invalid_filters"),
    ({"round_from": "10", "round_to": "2"}, "invalid_filters"),
    ({"revision": "F" * 64}, "invalid_revision"), ({"revision": ""}, "invalid_revision"),
])
def test_invalid_direct_selection_fails_before_storage(reader, roots, monkeypatch, kwargs, code):
    monkeypatch.setattr(shared, "_paths", lambda *args: pytest.fail("Invalid request reached storage"))
    with pytest.raises(shared.ComparisonError) as error:
        read(reader, roots, **kwargs)
    assert (error.value.code, error.value.status_code) == (code, 400)


def test_query_parser_canonicalizes_only_allowed_fields(reader):
    revision = "a" * 64
    assert reader.parse_saved_activity_rounds_query(MultiDict([
        ("platform", "reddit"), ("round_from", "000"), ("round_to", "0002"), ("revision", revision),
    ])) == {"platform": "reddit", "round_from": "0", "round_to": "2", "revision": revision}
    assert reader.parse_saved_activity_rounds_query(MultiDict()) == {"platform": None, "round_from": None, "round_to": None}


def test_metadata_allowlist_exact_decimals_and_terminal_state_fallback(reader, roots):
    path = roots[1] / "sim_saved/run_state.json"
    run = json.loads(path.read_text())
    run["total_rounds"], run["current_round"] = 9007199254740993, False
    write_json(path, run)
    result = read(reader, roots)
    assert result["context"]["requested_rounds"] == "9007199254740993"
    assert result["context"]["last_saved_round"] is None
    path.unlink()
    rows(roots, values=[action()])
    fallback = read(reader, roots)
    assert fallback["context"]["status"] == "completed"
    assert fallback["context"]["requested_rounds"] is None
    assert fallback["context"]["last_saved_round"] == "2"
    assert fallback["matched_count"] == 1
    assert {"code": "run_state_unavailable"} in fallback["warnings"]
