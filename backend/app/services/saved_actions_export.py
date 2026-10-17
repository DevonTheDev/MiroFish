"""One bounded, strict observation of all latest saved actions; no live services.

The v1 saved-activity revision detects ordinary file changes, not hostile writers
or atomic cross-file snapshots. Only privately encoded output is retained while
each selected source is scanned once. Page and round partial admission is separate.
"""

from datetime import datetime, timezone
import os
import re

from . import simulation_comparison as saved
from .saved_activity import _json, _source_revision
from ..storage import StoragePathError, validate_record_id


MAX_EXPORT_BYTES = 8 * 1024 * 1024
MAX_EXPORT_ACTIONS = 50_000
_ALLOWED_WARNINGS = {"config_unavailable", "run_state_unavailable", "partial_run", "platform_not_configured"}
_CONTEXT_FIELDS = ("status", "created_at", "updated_at", "started_at", "completed_at",
                   "requested_rounds", "last_saved_round")


def _revision(value):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise saved.ComparisonError("invalid_revision", "Choose the current saved observation before downloading.")
    return value


def parse_saved_actions_export_query(args):
    if any(key != "revision" for key in args):
        raise saved.ComparisonError("invalid_filters", "The all-actions download accepts only a saved revision.")
    if len(args.getlist("revision")) != 1:
        raise saved.ComparisonError("invalid_revision", "Exactly one saved revision is required.")
    return {"revision": _revision(args["revision"])}


def _incomplete(reason):
    error = saved.ComparisonError("export_incomplete", "All saved actions could not be read. Inspect or download individual pages instead.", 422)
    error.reason = reason
    raise error


def _too_large():
    raise saved.ComparisonError("export_too_large", "All saved actions exceed the download limits. Download individual pages instead.", 413)


class _ExportCollector:
    """Retain bounded encoded chunks, never a second list of parsed actions."""

    def __init__(self):
        self.chunks = []
        self.byte_count = 2  # Action array brackets; envelope is checked at finish.
        self.count = 0
        self.platform_counts = {platform: 0 for platform in saved._PLATFORMS}

    def collect(self, row, platform, line_number, source):
        if self.count >= MAX_EXPORT_ACTIONS:
            _too_large()
        record = {
            "record_id": f"{source}:{line_number}", "platform": platform,
            "agent_id": str(row["agent_id"]), "round_num": str(row.get("round", 0)),
            "agent_name": saved._text(row.get("agent_name")),
            "timestamp": saved._text(row.get("timestamp")), "action_type": row["action_type"],
            "success": row.get("success") if type(row.get("success")) is bool else None,
            "details_json": _json(row),
        }
        chunk = ("," if self.count else "").encode("ascii") + _json(record).encode("ascii")
        if self.byte_count + len(chunk) > MAX_EXPORT_BYTES:
            _too_large()
        self.chunks.append(chunk)
        self.byte_count += len(chunk)
        self.count += 1
        self.platform_counts[platform] += 1

    def finish(self, envelope):
        # Sorted outer keys, matching canonical _json, with the action array first.
        tail = ("," + _json(envelope)[1:] + "\n").encode("ascii")
        prefix = b'{"actions":['
        if len(prefix) + self.byte_count - 2 + 1 + len(tail) > MAX_EXPORT_BYTES:
            _too_large()
        return b"".join((prefix, *self.chunks, b"]", tail))


def _read_log(path, source, collector, types):
    """Classify every nonblank record strictly within this one source pass."""
    platform = source if source in saved._PLATFORMS else None
    present = set()
    records = total_bytes = line_number = 0
    with saved._open_source(path) as stream:
        if os.fstat(stream.fileno()).st_size > saved.MAX_LOG_BYTES:
            _too_large()
        while True:
            line = stream.readline(saved.MAX_LINE_BYTES + 1)
            if not line:
                break
            line_number += 1
            total_bytes += len(line)
            if len(line) > saved.MAX_LINE_BYTES or total_bytes > saved.MAX_LOG_BYTES:
                _too_large()
            if not line.strip():
                continue
            records += 1
            if records > saved.MAX_LOG_RECORDS:
                _too_large()
            try:
                row = saved._json_object(line.decode("utf-8"))
                row_platform = row.get("platform", platform)
                if (row_platform not in saved._PLATFORMS
                    or platform is not None and row_platform != platform
                    or "round" in row and saved._number(row["round"]) is None
                    or "timestamp" in row and not isinstance(row["timestamp"], str)):
                    _incomplete("invalid_records")
                if "event_type" in row:
                    if (not isinstance(row["event_type"], str)
                        or row["event_type"] not in saved._EVENTS or "action_type" in row):
                        _incomplete("invalid_records")
                    present.add(row_platform)
                    continue
                action_type = row.get("action_type")
                if (saved._number(row.get("agent_id")) is None
                    or not isinstance(action_type, str) or not action_type.strip()
                    or len(action_type) > saved.MAX_ACTION_TYPE_LENGTH):
                    _incomplete("invalid_records")
                types.add(action_type)
                if len(types) > saved.MAX_ACTION_TYPES:
                    _too_large()
                collector.collect(row, row_platform, line_number, source)
                present.add(row_platform)
            except saved.ComparisonError:
                raise
            except (ValueError, RecursionError):
                _incomplete("invalid_records")
    return present


def read_saved_actions_export(simulation_root, run_root, simulation_id, *, revision):
    """Return immutable canonical ASCII bytes only for complete admitted sources."""
    try:
        validate_record_id(simulation_id)
    except StoragePathError:
        raise saved.ComparisonError("invalid_selection", "Choose a valid saved simulation ID.") from None
    _revision(revision)
    paths = saved._paths(simulation_root, run_root, simulation_id)
    before = saved._snapshot(paths)
    try:
        if revision != _source_revision(simulation_id, before):
            raise saved.ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409)
        summary, enabled = saved._context(paths, simulation_id, before)
        status = summary["status"]
        if status in saved._ACTIVE:
            raise saved.ComparisonError("simulation_active", "Active saved simulations cannot be downloaded in full.", 409)
        if status not in saved._TERMINAL:
            raise saved.ComparisonError("run_not_terminal", "A terminal saved observation is required for this download.", 409)
        if status in {"stopped", "failed"}:
            summary["warnings"].append({"code": "partial_run"})
        modern = any(before[name] is not None for name in saved._PLATFORMS)
        selected = ([name for name in saved._PLATFORMS if before[name] is not None] if modern
                    else ["legacy"] if before["legacy"] is not None else [])
        if not selected:
            _incomplete("no_action_logs")
        collector, types, present = _ExportCollector(), set(), set()
        for source in selected:
            try:
                present.update(_read_log(paths[source], source, collector, types))
            except (OSError, saved._SourceUnreadable):
                _incomplete("source_unreadable")
        coverage = {}
        for platform in saved._PLATFORMS:
            flag = enabled[platform] if type(enabled[platform]) is bool else None
            covered = platform in selected if modern else flag is True or platform in present
            if not covered and flag is not False:
                _incomplete("platform_log_missing" if modern else "platform_coverage_unknown")
            if covered and flag is False:
                summary["warnings"].append({"code": "platform_not_configured", "platform": platform})
            coverage[platform] = {
                "enabled": flag, "availability": "complete" if covered else "unavailable",
                "source": (platform if modern else "legacy") if covered else None,
                "recorded_actions": collector.platform_counts[platform] if covered else None,
            }
        if any(warning.get("code") not in _ALLOWED_WARNINGS for warning in summary["warnings"]):
            _incomplete("unclassified_warning")
        context = {key: summary[key] for key in _CONTEXT_FIELDS}
        for key in ("requested_rounds", "last_saved_round"):
            context[key] = str(context[key]) if context[key] is not None else None
        envelope = {
            "format": "mirofish-saved-actions", "version": 1,
            "simulation_id": simulation_id, "source_revision": revision,
            "observed_at": datetime.now(timezone.utc).isoformat(), "context": context,
            "availability": "complete", "sources": selected, "platform_coverage": coverage,
            "warnings": summary["warnings"], "order": "source_record", "scope": "all_saved_actions",
            "truncated": False, "record_count": collector.count,
        }
    finally:
        # Changes supersede ordinary read, malformed, coverage and limit refusals.
        if saved._snapshot(paths) != before:
            raise saved.ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409) from None
    # A later write does not change this already accepted observation's bytes.
    return collector.finish(envelope)
