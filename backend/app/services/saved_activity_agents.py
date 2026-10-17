"""Bounded exact platform/agent observations of admitted saved attempts.

Each source is tentative until the shared reader admits it. Counts include
repeated attempts; they do not assess an agent or describe prediction quality.
"""

from datetime import datetime, timezone
import re

from . import simulation_comparison as saved
from .saved_activity import _json, _source_revision
from ..storage import StoragePathError, validate_record_id


MAX_AGENT_PAIRS = 1000
MAX_RESPONSE_BYTES = 1024 * 1024
_QUERY_FIELDS = {"platform", "revision"}
_OUTCOMES = ("success", "failed", "unknown")
_ORDER = "failed_desc_total_desc_platform_agent"


def _selection(platform, revision):
    if platform is not None and platform not in saved._PLATFORMS:
        raise saved.ComparisonError("invalid_filters", "Choose a supported saved platform.")
    if revision is not None and (not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{64}", revision) is None):
        raise saved.ComparisonError("invalid_revision", "The saved source revision is invalid. Refresh the overview.")
    return {"platform": platform}


def parse_saved_activity_agents_query(args):
    """Reject unknown, repeated and invalid fields before storage inspection."""
    if any(key not in _QUERY_FIELDS for key in args):
        raise saved.ComparisonError("invalid_filters", "The saved agent query contains an unsupported filter.")
    values = {}
    for key in args:
        if len(args.getlist(key)) != 1:
            code = "invalid_revision" if key == "revision" else "invalid_filters"
            raise saved.ComparisonError(code, "Each saved agent query field must appear once.")
        values[key] = args[key]
    filters = _selection(values.get("platform"), values.get("revision"))
    return {**values, **filters}


class _AgentCollector:
    """Bound committed, tentative and combined distinct pairs by one cap."""

    def __init__(self, filters):
        self.platform = filters["platform"]
        self.clear()

    def clear(self):
        self.agents = {}
        self.too_many_agent_pairs = False
        self.discard()

    def begin(self, source):
        self.discard()

    def discard(self):
        self.staged_agents = {}
        self.staged_new_pairs = 0
        self.staged_too_many_agent_pairs = False

    def collect(self, row, platform, line_number):
        if (self.platform is not None and platform != self.platform
            or self.too_many_agent_pairs or self.staged_too_many_agent_pairs):
            return
        # The shared scanner alone admits the nonnegative integer and platform.
        pair = (platform, row["agent_id"])
        if pair not in self.staged_agents:
            if pair not in self.agents:
                if len(self.agents) + self.staged_new_pairs >= MAX_AGENT_PAIRS:
                    # Finish source validation. Refusal must discard this flag
                    # together with all counts from this tentative source.
                    self.staged_too_many_agent_pairs = True
                    return
                self.staged_new_pairs += 1
            self.staged_agents[pair] = {name: 0 for name in _OUTCOMES}
        success = row.get("success")
        outcome = "success" if success is True else "failed" if success is False else "unknown"
        self.staged_agents[pair][outcome] += 1

    def commit(self):
        self.too_many_agent_pairs = self.too_many_agent_pairs or self.staged_too_many_agent_pairs
        if not self.too_many_agent_pairs:
            for pair, counts in self.staged_agents.items():
                committed = self.agents.setdefault(pair, {name: 0 for name in _OUTCOMES})
                for name in _OUTCOMES:
                    committed[name] += counts[name]
        self.discard()

    def rows(self):
        def order(item):
            (platform, agent_id), counts = item
            return (-counts["failed"], -sum(counts.values()), saved._PLATFORMS.index(platform), agent_id)

        result = []
        for (platform, agent_id), counts in sorted(self.agents.items(), key=order):
            decimal = str(agent_id)
            result.append({
                "platform": platform, "agent_id": decimal,
                "count": sum(counts.values()), "outcomes": counts,
                "drilldown_supported": len(decimal) <= 64,
            })
        return result


def response_too_large():
    return saved.ComparisonError("response_too_large", "This saved agent overview is too large. Choose one platform or return to Saved activity for a supported exact ID.", 413)


def read_saved_activity_agents(simulation_root, run_root, simulation_id, *, platform=None, revision=None):
    """Observe recorded attempts without loading profiles or live services."""
    try:
        validate_record_id(simulation_id)
    except StoragePathError:
        raise saved.ComparisonError("invalid_selection", "Choose a valid saved simulation ID.") from None
    filters = _selection(platform, revision)
    paths = saved._paths(simulation_root, run_root, simulation_id)
    before = saved._snapshot(paths)
    try:
        source_revision = _source_revision(simulation_id, before)
        if revision is not None and revision != source_revision:
            raise saved.ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409)
        collector = _AgentCollector(filters)
        summary = saved._summary(paths, simulation_id, before, collector=collector,
                                 include_distinct_statistics=False)
        platform_availability = {name: value["availability"] for name, value in summary["metrics"]["platforms"].items()}
        availability = platform_availability[platform] if platform else summary["availability"]
        unavailable = availability == "unavailable"
        if unavailable:
            collector.clear()
        elif collector.too_many_agent_pairs:
            raise saved.ComparisonError("too_many_agent_pairs", "This saved agent overview exceeds 1000 platform/agent pairs. Choose one platform or return to Saved activity for a supported exact ID.", 413)
        context = {key: summary[key] for key in (
            "status", "created_at", "updated_at", "started_at", "completed_at",
            "requested_rounds", "last_saved_round",
        )}
        for key in ("requested_rounds", "last_saved_round"):
            context[key] = str(context[key]) if context[key] is not None else None
        agents = collector.rows()
        outcomes = {name: None if unavailable else sum(row["outcomes"][name] for row in agents) for name in _OUTCOMES}
        result = {
            "simulation_id": simulation_id, "source_revision": source_revision,
            "observed_at": datetime.now(timezone.utc).isoformat(), "context": context,
            "availability": availability, "platform_availability": platform_availability,
            "warnings": summary["warnings"], "filters": filters, "order": _ORDER,
            "matched_count": None if unavailable else sum(row["count"] for row in agents),
            "pair_count": len(agents), "outcomes": outcomes, "agents": agents,
        }
        if len(_json({"success": True, "data": result}).encode("ascii")) > MAX_RESPONSE_BYTES:
            raise response_too_large()
        return result
    finally:
        # Source changes supersede both success and ordinary read/cap errors.
        if saved._snapshot(paths) != before:
            raise saved.ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409) from None
