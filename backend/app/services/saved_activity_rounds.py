"""Bounded round observations from the latest admitted saved action attempts.

Each source remains tentative until the shared saved-reader protocol admits it.
Revisions detect ordinary file changes; they are not a durable run archive or
an atomic filesystem snapshot.
"""

from datetime import datetime, timezone
import re

from . import simulation_comparison as saved
from .saved_activity import _json, _source_revision
from ..storage import StoragePathError, validate_record_id


MAX_ROUNDS = 1000
MAX_RESPONSE_BYTES = 1024 * 1024
_QUERY_FIELDS = {"platform", "round_from", "round_to", "revision"}
_OUTCOMES = ("success", "failed", "unknown")


def _decimal_bound(value):
    if value is None:
        return None
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{1,64}", value) is None:
        raise saved.ComparisonError("invalid_filters", "Round bounds must be nonnegative decimal integers of at most 64 digits.")
    return str(int(value))


def _selection(platform, round_from, round_to, revision):
    if platform is not None and platform not in saved._PLATFORMS:
        raise saved.ComparisonError("invalid_filters", "Choose a supported saved platform.")
    lower, upper = _decimal_bound(round_from), _decimal_bound(round_to)
    if lower is not None and upper is not None and int(lower) > int(upper):
        raise saved.ComparisonError("invalid_filters", "The first round must not exceed the last round.")
    if revision is not None and (not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{64}", revision) is None):
        raise saved.ComparisonError("invalid_revision", "The saved source revision is invalid. Refresh the overview.")
    return {"platform": platform, "round_from": lower, "round_to": upper}


def parse_saved_activity_rounds_query(args):
    """Reject unknown, repeated and invalid fields before storage inspection."""
    if any(key not in _QUERY_FIELDS for key in args):
        raise saved.ComparisonError("invalid_filters", "The saved round query contains an unsupported filter.")
    values = {}
    for key in args:
        if len(args.getlist(key)) != 1:
            code = "invalid_revision" if key == "revision" else "invalid_filters"
            raise saved.ComparisonError(code, "Each saved round query field must appear once.")
        values[key] = args[key]
    filters = _selection(*(values.get(key) for key in ("platform", "round_from", "round_to", "revision")))
    return {**values, **filters}


class _RoundCollector:
    """Retain at most 1000 committed and 1000 tentative matching buckets."""

    def __init__(self, filters):
        self.platform = filters["platform"]
        self.lower = int(filters["round_from"]) if filters["round_from"] is not None else None
        self.upper = int(filters["round_to"]) if filters["round_to"] is not None else None
        self.clear()

    def clear(self):
        self.rounds = {}
        self.too_many_rounds = False
        self.discard()

    def begin(self, source):
        self.discard()

    def discard(self):
        self.staged_rounds = {}
        self.staged_new_rounds = 0
        self.staged_too_many_rounds = False

    def collect(self, row, platform, line_number):
        round_num = row.get("round", 0)
        if (self.platform is not None and platform != self.platform
            or self.lower is not None and round_num < self.lower
            or self.upper is not None and round_num > self.upper
            or self.too_many_rounds or self.staged_too_many_rounds):
            return
        if round_num not in self.staged_rounds:
            if round_num not in self.rounds:
                if len(self.rounds) + self.staged_new_rounds >= MAX_ROUNDS:
                    # Keep scanning for admission failures; this source's
                    # overflow must vanish if the shared reader refuses it.
                    self.staged_too_many_rounds = True
                    return
                self.staged_new_rounds += 1
            self.staged_rounds[round_num] = {name: 0 for name in _OUTCOMES}
        success = row.get("success")
        outcome = ("success" if success is True else "failed" if success is False else "unknown")
        self.staged_rounds[round_num][outcome] += 1

    def commit(self):
        self.too_many_rounds = self.too_many_rounds or self.staged_too_many_rounds
        if not self.too_many_rounds:
            for round_num, counts in self.staged_rounds.items():
                committed = self.rounds.setdefault(round_num, {name: 0 for name in _OUTCOMES})
                for name in _OUTCOMES:
                    committed[name] += counts[name]
        self.discard()

    def rows(self):
        result = []
        for round_num in sorted(self.rounds):
            decimal = str(round_num)
            counts = self.rounds[round_num]
            result.append({
                "round_num": decimal, "count": sum(counts.values()), "outcomes": counts,
                "drilldown_supported": len(decimal) <= 64,
            })
        return result


def response_too_large():
    return saved.ComparisonError("response_too_large", "This saved round overview is too large. Choose a narrower round range.", 413)


def read_saved_activity_rounds(simulation_root, run_root, simulation_id, *, platform=None,
                               round_from=None, round_to=None, revision=None):
    """Observe saved rounds without running actions, managers or inference."""
    try:
        validate_record_id(simulation_id)
    except StoragePathError:
        raise saved.ComparisonError("invalid_selection", "Choose a valid saved simulation ID.") from None
    filters = _selection(platform, round_from, round_to, revision)
    paths = saved._paths(simulation_root, run_root, simulation_id)
    before = saved._snapshot(paths)
    try:
        source_revision = _source_revision(simulation_id, before)
        if revision is not None and revision != source_revision:
            raise saved.ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409)
        collector = _RoundCollector(filters)
        summary = saved._summary(paths, simulation_id, before, collector=collector)
        platform_availability = {name: value["availability"] for name, value in summary["metrics"]["platforms"].items()}
        availability = platform_availability[platform] if platform else summary["availability"]
        unavailable = availability == "unavailable"
        if unavailable:
            collector.clear()
        elif collector.too_many_rounds:
            raise saved.ComparisonError("too_many_rounds", "This saved round overview exceeds 1000 observed rounds. Choose a narrower round range.", 413)
        context = {key: summary[key] for key in (
            "status", "created_at", "updated_at", "started_at", "completed_at",
            "requested_rounds", "last_saved_round",
        )}
        for key in ("requested_rounds", "last_saved_round"):
            context[key] = str(context[key]) if context[key] is not None else None
        rounds = collector.rows()
        outcomes = {name: None if unavailable else sum(row["outcomes"][name] for row in rounds) for name in _OUTCOMES}
        result = {
            "simulation_id": simulation_id, "source_revision": source_revision,
            "observed_at": datetime.now(timezone.utc).isoformat(), "context": context,
            "availability": availability, "platform_availability": platform_availability,
            "warnings": summary["warnings"], "filters": filters, "order": "round_ascending",
            "matched_count": None if unavailable else sum(row["count"] for row in rounds),
            "round_count": len(rounds), "outcomes": outcomes, "rounds": rounds,
        }
        if len(_json({"success": True, "data": result}).encode("ascii")) > MAX_RESPONSE_BYTES:
            raise response_too_large()
        return result
    finally:
        # Changes supersede ordinary read/limit errors as well as success.
        if saved._snapshot(paths) != before:
            raise saved.ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409) from None
