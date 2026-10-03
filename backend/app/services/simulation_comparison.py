"""Read the latest saved run per simulation without invoking simulation services.

Counts describe recorded attempts, including unsuccessful attempts. File
fingerprints detect ordinary concurrent saves; this is not an atomic filesystem
snapshot or a sandbox against a hostile local writer.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import json
import math
import os
import stat

from ..storage import StoragePathError, storage_path, validate_record_id


MAX_STATE_BYTES = 1024 * 1024
MAX_CONFIG_BYTES = 8 * 1024 * 1024
MAX_LOG_BYTES = 64 * 1024 * 1024
MAX_LINE_BYTES = 1024 * 1024
MAX_LOG_RECORDS = 250_000
MAX_ACTION_TYPES = 256
MAX_ACTION_TYPE_LENGTH = 256

_PLATFORMS = ("twitter", "reddit")
_ACTIVE = {"starting", "running", "paused", "stopping"}
_TERMINAL = {"completed", "stopped", "failed"}
_RUN_STATUSES = _ACTIVE | _TERMINAL | {"idle"}
_STATE_STATUSES = _RUN_STATUSES | {"created", "preparing", "ready"}
_EVENTS = {"round_start", "round_end", "simulation_start", "simulation_end"}


class ComparisonError(ValueError):
    """A safe public error with a stable code and HTTP status."""

    def __init__(self, code, message, status_code=400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class _SourceUnreadable(ValueError):
    pass


class _SourceTooLarge(ValueError):
    pass


def _paths(simulation_root, run_root, simulation_id):
    try:
        return {
            "state": storage_path(simulation_root, simulation_id, "state.json"),
            "config": storage_path(simulation_root, simulation_id, "simulation_config.json"),
            "run": storage_path(run_root, simulation_id, "run_state.json"),
            "twitter": storage_path(run_root, simulation_id, "twitter", "actions.jsonl"),
            "reddit": storage_path(run_root, simulation_id, "reddit", "actions.jsonl"),
            "legacy": storage_path(run_root, simulation_id, "actions.jsonl"),
        }
    except StoragePathError:
        raise ComparisonError("unsafe_path", "Saved simulation paths are unsafe.") from None


def _fingerprint(path):
    try:
        info = os.lstat(path)
        return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                info.st_mtime_ns, info.st_ctime_ns)
    except FileNotFoundError:
        return None
    except OSError as error:
        return ("unreadable", error.errno)


def _snapshot(paths):
    return {name: _fingerprint(path) for name, path in paths.items()}


def _open_source(path):
    # Never block on a named pipe or follow a last-component link introduced
    # after preflight. Ancestor paths still follow the documented local-writer
    # limitation of storage_path.
    def opener(filename, flags):
        return os.open(filename, flags | getattr(os, "O_NONBLOCK", 0)
                       | getattr(os, "O_NOFOLLOW", 0))

    stream = open(path, "rb", opener=opener)
    try:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise _SourceUnreadable()
    except BaseException:
        stream.close()
        raise
    return stream


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Nonfinite JSON number")
    return number


def _reject_constant(value):
    raise ValueError("Nonfinite JSON number")


def _json_object(value):
    result = json.loads(value, parse_constant=_reject_constant, parse_float=_finite_float)
    if not isinstance(result, dict):
        raise ValueError("Expected JSON object")
    return result


def _metadata(path, maximum):
    try:
        with _open_source(path) as stream:
            if os.fstat(stream.fileno()).st_size > maximum:
                return None
            payload = stream.read(maximum + 1)
        if len(payload) > maximum:
            return None
        return _json_object(payload.decode("utf-8"))
    except (OSError, ValueError, RecursionError):
        return None


def _text(value, default=None):
    return value if isinstance(value, str) else default


def _number(value):
    return value if type(value) is int and value >= 0 else None


def _state(paths, simulation_id, before):
    if before["state"] is None:
        raise ComparisonError("simulation_not_found", "A saved simulation was not found.", 404)
    state = _metadata(paths["state"], MAX_STATE_BYTES)
    if state is None or state.get("simulation_id") != simulation_id:
        raise ComparisonError("simulation_unreadable", "A saved simulation could not be read.", 404)
    return state


def _context(paths, simulation_id, before):
    state = _state(paths, simulation_id, before)
    config = _metadata(paths["config"], MAX_CONFIG_BYTES)
    run = _metadata(paths["run"], MAX_STATE_BYTES)
    if (run is not None and (
        not isinstance(run.get("runner_status"), str)
        or run["runner_status"] not in _RUN_STATUSES
        or run.get("simulation_id", simulation_id) != simulation_id
    )):
        run = None
    status = run["runner_status"] if run is not None else state.get("status")
    if not isinstance(status, str) or status not in _STATE_STATUSES:
        status = "unknown"
    warnings = []
    if config is None:
        warnings.append({"code": "config_unavailable"})
    if run is None:
        warnings.append({"code": "run_state_unavailable"})
    config = config or {}
    run = run or {}
    summary = {
        "simulation_id": simulation_id,
        "project_id": _text(state.get("project_id")),
        "graph_id": _text(state.get("graph_id")),
        "scenario": _text(config.get("simulation_requirement"), ""),
        "configured_model": _text(config.get("llm_model")),
        "configured_agents": _number(state.get("profiles_count")),
        "status": status,
        "created_at": _text(state.get("created_at")),
        "updated_at": _text(run.get("updated_at"), _text(state.get("updated_at"))),
        "started_at": _text(run.get("started_at")),
        "completed_at": _text(run.get("completed_at")),
        "requested_rounds": _number(run.get("total_rounds")),
        "last_saved_round": _number(run.get("current_round", state.get("current_round"))),
        "availability": "unavailable",
        "warnings": warnings,
        "metrics": _unavailable_metrics(),
    }
    enabled = {platform: state.get("enable_" + platform) for platform in _PLATFORMS}
    return summary, enabled


def _unavailable_metrics():
    return {
        "recorded_actions": None,
        "rounds_with_actions": None,
        "platforms": {
            platform: {"availability": "unavailable", "recorded_actions": None, "active_agents": None}
            for platform in _PLATFORMS
        },
        "action_types": [],
    }


def _observations():
    return {
        "counts": Counter(), "types": Counter(), "rounds": set(),
        "agents": {platform: set() for platform in _PLATFORMS},
        "invalid": Counter(), "unknown_invalid": 0,
    }


def _invalid(observations, platform):
    if platform in _PLATFORMS:
        observations["invalid"][platform] += 1
    else:
        observations["unknown_invalid"] += 1


def _read_log(path, platform, *, on_action=None):
    """Read once, returning bounded observations or refusing the whole source."""
    observations = _observations()
    records = total_bytes = line_number = 0
    with _open_source(path) as stream:
        if os.fstat(stream.fileno()).st_size > MAX_LOG_BYTES:
            raise _SourceTooLarge()
        while True:
            line = stream.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            line_number += 1
            total_bytes += len(line)
            if len(line) > MAX_LINE_BYTES or total_bytes > MAX_LOG_BYTES:
                raise _SourceTooLarge()
            if not line.strip():
                continue
            records += 1
            if records > MAX_LOG_RECORDS:
                raise _SourceTooLarge()
            try:
                row = _json_object(line.decode("utf-8"))
            except (ValueError, RecursionError):
                _invalid(observations, platform)
                continue
            row_platform = row.get("platform", platform)
            affected = platform or (row_platform if row_platform in _PLATFORMS else None)
            if "event_type" in row:
                if isinstance(row["event_type"], str) and row["event_type"] in _EVENTS:
                    if row_platform in _PLATFORMS and (platform is None or row_platform == platform):
                        observations["counts"].setdefault(row_platform, 0)
                else:
                    _invalid(observations, affected)
                continue
            action_type = row.get("action_type")
            round_num = row.get("round", 0)
            agent_id = row.get("agent_id")
            if (
                row_platform not in _PLATFORMS
                or (platform is not None and row_platform != platform)
                or _number(agent_id) is None or _number(round_num) is None
                or ("timestamp" in row and not isinstance(row["timestamp"], str))
                or not isinstance(action_type, str) or not action_type.strip()
                or len(action_type) > MAX_ACTION_TYPE_LENGTH
            ):
                _invalid(observations, affected)
                continue
            observations["counts"][row_platform] += 1
            observations["agents"][row_platform].add(agent_id)
            observations["rounds"].add(round_num)
            observations["types"][action_type] += 1
            if len(observations["types"]) > MAX_ACTION_TYPES:
                raise _SourceTooLarge()
            if on_action is not None:
                on_action(row, row_platform, line_number)
    return observations


def _summary(paths, simulation_id, before, *, collector=None):
    """Apply saved-source admission, optionally collecting admitted action pages.

    A collector stages each source independently: a late read/limit failure must
    discard its rows and cursor contribution. Global type refusal clears every
    source. The ordinary comparison path does not create or retain payloads.
    """
    summary, enabled = _context(paths, simulation_id, before)
    status = summary["status"]
    if status in _ACTIVE:
        raise ComparisonError("simulation_active", "Active simulations cannot be compared.", 409)
    if status not in _TERMINAL:
        summary["warnings"].append({"code": "run_not_terminal"})
        return summary
    if status in {"stopped", "failed"}:
        summary["warnings"].append({"code": "partial_run"})

    modern = any(before[platform] is not None for platform in _PLATFORMS)
    selected = [platform for platform in _PLATFORMS if before[platform] is not None] if modern else (
        ["legacy"] if before["legacy"] is not None else []
    )
    if not selected:
        summary["warnings"].append({"code": "no_action_logs"})
        return summary

    metrics = summary["metrics"]
    types, rounds = Counter(), set()
    readable = False
    global_partial = False
    for source in selected:
        platform = source if source in _PLATFORMS else None
        warning_scope = {"platform": platform} if platform else {}
        if collector is not None:
            collector.begin(source)
        try:
            observations = (_read_log(paths[source], platform) if collector is None else
                            _read_log(paths[source], platform, on_action=collector.collect))
        except (OSError, _SourceUnreadable):
            if collector is not None:
                collector.discard()
            summary["warnings"].append({"code": "source_unreadable", **warning_scope})
            global_partial = True
            continue
        except _SourceTooLarge:
            if collector is not None:
                collector.discard()
            summary["warnings"].append({"code": "source_too_large", **warning_scope})
            global_partial = True
            continue
        readable = True
        types.update(observations["types"])
        if len(types) > MAX_ACTION_TYPES:
            # This is a per-side response budget, including both platforms.
            summary["warnings"].append({"code": "source_too_large"})
            summary["metrics"] = _unavailable_metrics()
            if collector is not None:
                collector.clear()
            return summary
        if collector is not None:
            collector.commit()
        rounds.update(observations["rounds"])
        covered = [platform] if platform else [
            name for name in _PLATFORMS
            if enabled[name] is True or name in observations["counts"] or name in observations["invalid"]
        ]
        unknown_invalid = observations["unknown_invalid"]
        if unknown_invalid:
            summary["warnings"].append({"code": "invalid_records", "count": unknown_invalid})
            global_partial = True
        for name in covered:
            invalid = observations["invalid"][name]
            if invalid:
                summary["warnings"].append({"code": "invalid_records", "platform": name, "count": invalid})
            if enabled[name] is False:
                summary["warnings"].append({"code": "platform_not_configured", "platform": name})
            metrics["platforms"][name] = {
                "availability": "partial" if invalid or unknown_invalid else "complete",
                "recorded_actions": observations["counts"][name],
                "active_agents": len(observations["agents"][name]),
            }
        global_partial = global_partial or bool(observations["invalid"])

    for platform in _PLATFORMS:
        if metrics["platforms"][platform]["availability"] == "unavailable" and enabled[platform] is not False:
            global_partial = True
            if modern and before[platform] is None:
                summary["warnings"].append({"code": "platform_log_missing", "platform": platform})
    if readable:
        summary["availability"] = "partial" if global_partial else "complete"
        metrics["recorded_actions"] = sum(value["recorded_actions"] or 0 for value in metrics["platforms"].values())
        metrics["rounds_with_actions"] = len(rounds)
        metrics["action_types"] = [{"action_type": name, "count": types[name]} for name in sorted(types)]
    return summary


def _differences(left, right):
    complete = left["availability"] == right["availability"] == "complete"
    left_metrics, right_metrics = left["metrics"], right["metrics"]
    result = {
        name: right_metrics[name] - left_metrics[name] if complete else None
        for name in ("recorded_actions", "rounds_with_actions")
    }
    result["platforms"] = {}
    for platform in _PLATFORMS:
        left_platform = left_metrics["platforms"][platform]
        right_platform = right_metrics["platforms"][platform]
        comparable = left_platform["availability"] == right_platform["availability"] == "complete"
        result["platforms"][platform] = {
            name: right_platform[name] - left_platform[name] if comparable else None
            for name in ("recorded_actions", "active_agents")
        }
    left_types = {item["action_type"]: item["count"] for item in left_metrics["action_types"]}
    right_types = {item["action_type"]: item["count"] for item in right_metrics["action_types"]}
    result["action_types"] = []
    for name in sorted(left_types.keys() | right_types.keys()):
        left_count = left_types.get(name, 0 if left["availability"] == "complete" else None)
        right_count = right_types.get(name, 0 if right["availability"] == "complete" else None)
        result["action_types"].append({
            "action_type": name, "left": left_count, "right": right_count,
            "difference": right_count - left_count if complete else None,
        })
    return result


def compare_saved_simulations(simulation_root, run_root, left_id, right_id):
    """Compare two distinct simulations, preserving unavailable observations."""
    try:
        validate_record_id(left_id)
        validate_record_id(right_id)
        if left_id == right_id:
            raise StoragePathError("Duplicate selection")
    except StoragePathError:
        raise ComparisonError("invalid_selection", "Choose two distinct valid simulations.") from None

    # Both sides and every potential source must pass before either is read.
    left_paths = _paths(simulation_root, run_root, left_id)
    right_paths = _paths(simulation_root, run_root, right_id)
    left_before, right_before = _snapshot(left_paths), _snapshot(right_paths)
    try:
        left = _summary(left_paths, left_id, left_before)
        right = _summary(right_paths, right_id, right_before)
    finally:
        # A disappearing metadata file may have raised an ordinary missing or
        # unreadable error. The same retryable snapshot rule applies on failure.
        if _snapshot(left_paths) != left_before or _snapshot(right_paths) != right_before:
            raise ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409) from None
    return {
        "left": left, "right": right, "differences": _differences(left, right),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _saved_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (ValueError, OverflowError, OSError):
        return None


def list_comparison_candidates(simulation_root, run_root):
    """List safe saved metadata, isolating unreadable records from healthy ones."""
    candidates, skipped = [], 0
    try:
        root = storage_path(simulation_root)
        with os.scandir(root) as entries:
            names = []
            for entry in entries:
                if entry.is_symlink():
                    skipped += 1
                elif entry.is_dir(follow_symlinks=False):
                    names.append(entry.name)
    except FileNotFoundError:
        return {"candidates": [], "skipped_records": 0}
    except (OSError, StoragePathError):
        raise ComparisonError("simulation_unreadable", "Saved simulations could not be listed.", 404) from None
    for name in sorted(names):
        try:
            validate_record_id(name)
            paths = _paths(simulation_root, run_root, name)
            before = _snapshot(paths)
            summary, _ = _context(paths, name, before)
            if _snapshot(paths) != before:
                raise ComparisonError("sources_changed", "Saved files changed.", 409)
            candidates.append({key: summary[key] for key in (
                "simulation_id", "project_id", "scenario", "status", "created_at", "updated_at"
            )})
        except (StoragePathError, ComparisonError):
            skipped += 1
    candidates.sort(key=lambda item: (
        _saved_time(item["updated_at"]) is None,
        -(_saved_time(item["updated_at"]) or 0), item["simulation_id"],
    ))
    return {"candidates": candidates, "skipped_records": skipped}
