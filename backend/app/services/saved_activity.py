"""Bounded, revision-checked pages of the latest saved action attempts.

Source order is Twitter then Reddit and physical forward line order, or the
legacy combined file when neither modern source exists. Revisions detect
ordinary saves; they do not provide an atomic snapshot or a durable run archive.
"""

from datetime import datetime, timezone
import hashlib
import json
import re
import unicodedata

from . import simulation_comparison as saved
from ..storage import StoragePathError, validate_record_id


MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_OFFSET = 500_000
MAX_LIMIT = 100
MAX_QUERY_LENGTH = 200
MAX_PREVIEW_LENGTH = 240
_PREVIEW_LEADING_CONTEXT = 40
_QUERY_FIELDS = {"platform", "agent_id", "round_num", "action_type", "offset", "limit", "revision",
                 "q", "case_sensitive", "outcome"}
_REVISION_VERSION = "saved-activity-v1"


def _invalid(code, message):
    raise saved.ComparisonError(code, message)


def _decimal_filter(value):
    if value is None:
        return None
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{1,64}", value) is None:
        _invalid("invalid_filters", "Agent and round filters must be nonnegative decimal integers of at most 64 digits.")
    return str(int(value))


def _selection(platform, agent_id, round_num, action_type, offset, limit, revision,
               q=None, case_sensitive=False, outcome=None):
    if platform is not None and platform not in saved._PLATFORMS:
        _invalid("invalid_filters", "Choose a supported saved platform.")
    if action_type is not None and (
        not isinstance(action_type, str) or not action_type.strip()
        or len(action_type) > saved.MAX_ACTION_TYPE_LENGTH
        or any(unicodedata.category(char) in {"Cc", "Zl", "Zp"} for char in action_type)
    ):
        _invalid("invalid_filters", "Action type must be a nonblank label of at most 256 characters without controls.")
    if q is not None and (
        not isinstance(q, str) or not q.strip() or len(q) > MAX_QUERY_LENGTH
        or any(unicodedata.category(char) in {"Cc", "Zl", "Zp"} for char in q)
    ):
        _invalid("invalid_filters", "Search phrase must be nonblank, at most 200 characters, and without controls.")
    if type(case_sensitive) is not bool:
        _invalid("invalid_filters", "Case sensitivity must be true or false.")
    if outcome is not None and outcome not in ("success", "failed", "unknown"):
        _invalid("invalid_filters", "Choose success, failed, or unknown for the saved outcome.")
    filters = {
        "platform": platform, "agent_id": _decimal_filter(agent_id),
        "round_num": _decimal_filter(round_num), "action_type": action_type,
        "q": q, "case_sensitive": case_sensitive, "outcome": outcome,
    }
    if type(offset) is not int or not 0 <= offset <= MAX_OFFSET or type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        _invalid("invalid_pagination", "Offset must be 0–500000 and page size must be 1–100.")
    if revision is not None and (not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{64}", revision) is None):
        _invalid("invalid_revision", "The saved source revision is invalid. Refresh the first page.")
    if offset and revision is None:
        _invalid("revision_required", "A saved source revision is required after the first page. Refresh first.")
    return filters


def parse_saved_activity_query(args):
    """Admit only single, known query values before any storage inspection."""
    if any(key not in _QUERY_FIELDS for key in args):
        _invalid("invalid_filters", "The saved activity query contains an unsupported filter.")
    values = {}
    for key in args:
        if len(args.getlist(key)) != 1:
            code = "invalid_pagination" if key in {"offset", "limit"} else "invalid_revision" if key == "revision" else "invalid_filters"
            _invalid(code, "Each saved activity query field must appear once.")
        values[key] = args[key]
    for key, default in (("offset", 0), ("limit", 50)):
        if key not in values:
            values[key] = default
        elif re.fullmatch(r"[0-9]{1,64}", values[key]) is None:
            _invalid("invalid_pagination", "Offset and page size must be nonnegative decimal integers.")
        else:
            values[key] = int(values[key])
    if "case_sensitive" in values:
        if values["case_sensitive"] not in ("true", "false"):
            _invalid("invalid_filters", "Case sensitivity must be true or false.")
        values["case_sensitive"] = values["case_sensitive"] == "true"
    filters = _selection(*(values.get(key) for key in ("platform", "agent_id", "round_num", "action_type")),
                         values["offset"], values["limit"], values.get("revision"),
                         values.get("q"), values.get("case_sensitive", False), values.get("outcome"))
    return {**values, **filters}


def _json(value):
    # ASCII escaping preserves unusual Unicode, including legacy surrogate
    # escapes, while allowing strict JSON bytes to be measured deterministically.
    return json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":"))


def _source_revision(simulation_id, before):
    """Share the exact v1 fingerprint encoding across saved activity readers."""
    return hashlib.sha256(_json([_REVISION_VERSION, simulation_id, before]).encode("ascii")).hexdigest()


def _first_string_match(row, phrase, case_sensitive):
    """Find within one decoded value at a time, in saved insertion/list order.

    Iterators keep traversal memory proportional to nesting rather than copying
    a flattened payload. The caller folds the phrase once for the whole scan.
    """
    stack = [iter(row.values())]
    while stack:
        try:
            value = next(stack[-1])
        except StopIteration:
            stack.pop()
            continue
        if isinstance(value, str):
            start = (value if case_sensitive else value.casefold()).find(phrase)
            if start >= 0:
                return value, start
        elif isinstance(value, dict):
            stack.append(iter(value.values()))
        elif isinstance(value, list):
            stack.append(iter(value))
    return None


def _match_preview(value, start, case_sensitive):
    """Map only a retained match start back to a bounded original-text excerpt."""
    if not case_sensitive:
        folded_end = 0
        for original_start, char in enumerate(value):
            folded_end += len(char.casefold())
            if folded_end > start:
                start = original_start
                break
    start = max(0, start - _PREVIEW_LEADING_CONTEXT)
    # Expansions can make the original matching span exceed the preview budget.
    # Keep source characters intact even when the bounded excerpt omits its tail.
    return value[start:start + MAX_PREVIEW_LENGTH]


class _PageCollector:
    """Keep only a bounded page; admit counts and cursor positions per source."""

    def __init__(self, filters, offset, limit):
        self.filters, self.offset, self.limit = filters, offset, limit
        self.phrase = filters["q"]
        if self.phrase is not None and not filters["case_sensitive"]:
            self.phrase = self.phrase.casefold()
        self.clear()

    def clear(self):
        self.matched = 0
        self.actions = []
        self.page_bytes = 2  # JSON array brackets
        self.too_large = False
        self.discard()

    def begin(self, source):
        self.discard()
        self.source = source

    def discard(self):
        self.staged_count = self.staged_bytes = 0
        self.staged_actions = []
        self.staged_too_large = False

    def collect(self, row, platform, line_number):
        filters = self.filters
        agent_id, round_num = str(row["agent_id"]), str(row.get("round", 0))
        if (filters["platform"] is not None and platform != filters["platform"]
            or filters["agent_id"] is not None and agent_id != filters["agent_id"]
            or filters["round_num"] is not None and round_num != filters["round_num"]
            or filters["action_type"] is not None and row["action_type"] != filters["action_type"]):
            return
        success = row.get("success") if type(row.get("success")) is bool else None
        outcome = "success" if success is True else "failed" if success is False else "unknown"
        if filters["outcome"] is not None and outcome != filters["outcome"]:
            return
        match = None
        if self.phrase is not None:
            match = _first_string_match(row, self.phrase, filters["case_sensitive"])
            if match is None:
                return
        index = self.matched + self.staged_count
        self.staged_count += 1
        if not self.offset <= index < self.offset + self.limit or self.too_large or self.staged_too_large:
            return
        record = {
            "record_id": f"{self.source}:{line_number}", "platform": platform,
            "agent_id": agent_id, "round_num": round_num,
            "agent_name": saved._text(row.get("agent_name")),
            "timestamp": saved._text(row.get("timestamp")), "action_type": row["action_type"],
            "success": success,
            "match_preview": _match_preview(*match, filters["case_sensitive"]) if match is not None else None,
            "details_json": _json(row),
        }
        byte_count = len(_json(record).encode("ascii")) + bool(self.actions or self.staged_actions)
        if self.page_bytes + self.staged_bytes + byte_count > MAX_PAGE_BYTES:
            self.staged_too_large = True
            self.staged_actions = []
            self.staged_bytes = 0
            return
        self.staged_actions.append(record)
        self.staged_bytes += byte_count

    def commit(self):
        self.matched += self.staged_count
        self.too_large = self.too_large or self.staged_too_large
        if self.too_large:
            self.actions = []
            self.page_bytes = 2
        else:
            self.actions.extend(self.staged_actions)
            self.page_bytes += self.staged_bytes
        self.discard()


def response_too_large():
    return saved.ComparisonError("response_too_large", "This saved page is too large. Choose a smaller page size.", 413)


def read_saved_activity(simulation_root, run_root, simulation_id, *, platform=None,
                        agent_id=None, round_num=None, action_type=None,
                        q=None, case_sensitive=False, outcome=None,
                        offset=0, limit=50, revision=None):
    """Read selected attempts without a manager, runtime cache, or inference."""
    try:
        validate_record_id(simulation_id)
    except StoragePathError:
        raise saved.ComparisonError("invalid_selection", "Choose a valid saved simulation ID.") from None
    filters = _selection(platform, agent_id, round_num, action_type, offset, limit, revision,
                         q, case_sensitive, outcome)
    paths = saved._paths(simulation_root, run_root, simulation_id)
    before = saved._snapshot(paths)
    try:
        source_revision = _source_revision(simulation_id, before)
        if revision is not None and revision != source_revision:
            raise saved.ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409)
        collector = _PageCollector(filters, offset, limit)
        summary = saved._summary(paths, simulation_id, before, collector=collector)
        platform_availability = {name: value["availability"] for name, value in summary["metrics"]["platforms"].items()}
        availability = platform_availability[platform] if platform else summary["availability"]
        if availability == "unavailable":
            collector.clear()
        elif collector.too_large:
            raise response_too_large()
        context = {key: summary[key] for key in (
            "status", "created_at", "updated_at", "started_at", "completed_at",
            "requested_rounds", "last_saved_round",
        )}
        for key in ("requested_rounds", "last_saved_round"):
            context[key] = str(context[key]) if context[key] is not None else None
        result = {
            "simulation_id": simulation_id, "source_revision": source_revision,
            "observed_at": datetime.now(timezone.utc).isoformat(), "context": context,
            "availability": availability, "platform_availability": platform_availability,
            "warnings": summary["warnings"], "filters": filters, "order": "source_record",
            "offset": offset, "limit": limit, "returned_count": len(collector.actions),
            "matched_count": None if availability == "unavailable" else collector.matched,
            "has_more": availability != "unavailable" and offset + len(collector.actions) < collector.matched,
            "actions": collector.actions,
        }
        if len(_json({"success": True, "data": result}).encode("ascii")) > MAX_RESPONSE_BYTES:
            raise response_too_large()
        return result
    finally:
        # Changes supersede ordinary read/limit errors as well as successful scans.
        if saved._snapshot(paths) != before:
            raise saved.ComparisonError("sources_changed", "Saved files changed. Refresh and try again.", 409) from None
