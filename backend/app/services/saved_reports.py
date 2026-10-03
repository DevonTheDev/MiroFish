"""Bounded, read-only discovery and capture of saved report files.

This reader deliberately does not use ReportManager, runtime caches, models, or
other report artifacts. Revisions detect ordinary saves, not hostile local
filesystem races or an atomic transaction spanning multiple saved files.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from ..storage import StoragePathError, storage_path, validate_record_id


MAX_CATALOGUE_ENTRIES = 2000
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_TOTAL_METADATA_BYTES = 64 * 1024 * 1024
MAX_MARKDOWN_BYTES = 8 * 1024 * 1024
MAX_LIST_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_DETAIL_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_QUERY_LENGTH = 200
MAX_OFFSET = 2000
MAX_LIMIT = 50
_STATUSES = ("pending", "planning", "generating", "completed", "failed")
_MESSAGES = {
    "invalid_query": "The saved report query is invalid.",
    "invalid_report_id": "Choose a valid saved report ID.",
    "report_not_found": "This saved report was not found.",
    "metadata_unavailable": "This report's saved metadata is unavailable.",
    "sources_changed": "Saved report files changed. Refresh and try again.",
    "catalogue_too_large": "The saved report catalogue exceeds the supported size.",
    "response_too_large": "The saved report response exceeds the supported size.",
    "library_unavailable": "The saved report library is unavailable.",
}
_STATUS_CODES = {"invalid_query": 400, "invalid_report_id": 400, "report_not_found": 404,
                 "metadata_unavailable": 422, "sources_changed": 409, "catalogue_too_large": 413,
                 "response_too_large": 413, "library_unavailable": 500}


class SavedReportError(ValueError):
    """Only fixed public messages are exposed by the report library API."""

    def __init__(self, code, status_code=None):
        self.code = code
        self.status_code = _STATUS_CODES[code] if status_code is None else status_code
        self.message = _MESSAGES[code]
        super().__init__(self.message)


def _revision_valid(revision):
    if revision is not None and (not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{64}", revision) is None):
        raise SavedReportError("invalid_query")


def _selection(q, status, offset, limit, revision):
    if q is not None:
        if not isinstance(q, str):
            raise SavedReportError("invalid_query")
        q = q.strip() or None
        if q is not None and len(q) > MAX_QUERY_LENGTH:
            raise SavedReportError("invalid_query")
        if q is not None:
            try:
                q.encode("utf-8")
            except UnicodeError:
                raise SavedReportError("invalid_query") from None
    if status is not None and (not isinstance(status, str) or status not in _STATUSES):
        raise SavedReportError("invalid_query")
    if type(offset) is not int or not 0 <= offset <= MAX_OFFSET or type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        raise SavedReportError("invalid_query")
    _revision_valid(revision)
    if offset and revision is None:
        raise SavedReportError("invalid_query")
    return {"q": q, "status": status, "offset": offset, "limit": limit, "revision": revision}


def _query(args, allowed):
    values = {}
    for key in args:
        if key not in allowed or len(args.getlist(key)) != 1 or not isinstance(args[key], str):
            raise SavedReportError("invalid_query")
        values[key] = args[key]
    return values


def parse_library_query(args):
    """Validate a Flask MultiDict before any storage work is attempted."""
    values = _query(args, {"q", "status", "offset", "limit", "revision"})
    for key, default in (("offset", 0), ("limit", 20)):
        value = values.get(key)
        if value is not None and re.fullmatch(r"[0-9]{1,64}", value) is None:
            raise SavedReportError("invalid_query")
        values[key] = default if value is None else int(value)
    return _selection(values.get("q"), values.get("status"), values["offset"], values["limit"], values.get("revision"))


def parse_report_query(args):
    values = _query(args, {"revision"})
    _revision_valid(values.get("revision"))
    return {"revision": values.get("revision")}


def _json(value):
    # ASCII escaping also safely measures arbitrary legacy JSON string values.
    return json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True)


def _digest(value):
    return hashlib.sha256(_json(value).encode("ascii")).hexdigest()


def _check_response(value, maximum):
    # Match the API's compact UTF-8 envelope, including its final newline.
    # Revision digests use their separate stable ASCII serialization above.
    serialized = json.dumps({"success": True, "data": value}, ensure_ascii=False,
                            allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(serialized) + 1 > maximum:
        raise SavedReportError("response_too_large")
    return value


def _fingerprint(info):
    base = (info.st_dev, info.st_ino, info.st_mode)
    # Changes to logs or a newly saved body must not change metadata identity.
    if stat.S_ISDIR(info.st_mode):
        return base
    return (*base, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _linked(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


@dataclass(frozen=True)
class _Observation:
    path: str
    kind: str
    fingerprint: tuple = ()
    size: int = 0

    @property
    def signature(self):
        return self.kind, self.fingerprint


def _observe(root, *parts):
    path = os.path.join(root, *parts)
    try:
        info = os.lstat(path)
        if _linked(info) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            return _Observation(path, "unsafe", _fingerprint(info), info.st_size)
        storage_path(root, *parts)
        return _Observation(path, "directory" if stat.S_ISDIR(info.st_mode) else "file", _fingerprint(info), info.st_size)
    except FileNotFoundError:
        return _Observation(path, "missing")
    except StoragePathError:
        return _Observation(path, "unsafe")
    except (OSError, RuntimeError):
        return _Observation(path, "unreadable")


def _root(root):
    try:
        return str(Path(root).resolve())
    except (OSError, RuntimeError, TypeError, ValueError):
        raise SavedReportError("library_unavailable") from None


def _root_observation(root):
    result = _observe(root)
    if result.kind not in {"directory", "missing"}:
        raise SavedReportError("library_unavailable")
    return result


@dataclass(frozen=True)
class _Source:
    report_id: str
    label: str
    namespace: _Observation
    metadata: _Observation

    @property
    def signature(self):
        return self.report_id, self.label, self.namespace.signature, self.metadata.signature


def _source(root, report_id):
    namespace = _observe(root, report_id)
    if namespace.kind != "missing":
        # Even an unsafe or damaged modern namespace shadows the legacy file.
        meta = (_observe(root, report_id, "meta.json") if namespace.kind == "directory"
                else _Observation(namespace.path, "unsafe" if namespace.kind != "unreadable" else "unreadable", namespace.fingerprint))
        return _Source(report_id, "modern", namespace, meta)
    return _Source(report_id, "legacy", namespace, _observe(root, f"{report_id}.json"))


def _catalogue(root):
    observed_root = _root_observation(root)
    names = []
    if observed_root.kind != "missing":
        try:
            with os.scandir(root) as entries:
                for entry in entries:
                    if len(names) == MAX_CATALOGUE_ENTRIES:
                        raise SavedReportError("catalogue_too_large")
                    names.append(entry.name)
        except OSError:
            raise SavedReportError("library_unavailable") from None
    names.sort()
    ids = set()
    for name in names:
        candidate = name[:-5] if name.endswith(".json") else name
        try:
            ids.add(validate_record_id(candidate))
        except StoragePathError:
            continue
    sources = [_source(root, report_id) for report_id in sorted(ids)]
    signature = observed_root.signature, names, [source.signature for source in sources]
    return signature, sources


def _open_source(path):
    # Nonblocking/no-follow flags also avoid hanging on an accidentally replaced
    # FIFO where supported; lstat/fstat still enforce ordinary regular files.
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    return os.fdopen(os.open(path, flags), "rb")


class _Unavailable(Exception):
    def __init__(self, code):
        self.code = code


def _read_bytes(observation, maximum, budget=None):
    if observation.kind != "file":
        raise _Unavailable("unsafe_path" if observation.kind in {"unsafe", "directory"} else "unreadable")
    if observation.size > maximum:
        raise _Unavailable("too_large")
    try:
        with _open_source(observation.path) as stream:
            before = os.fstat(stream.fileno())
            if _linked(before) or not stat.S_ISREG(before.st_mode):
                raise _Unavailable("unsafe_path")
            if _fingerprint(before) != observation.fingerprint:
                raise SavedReportError("sources_changed")
            allowance = maximum + 1 if budget is None else min(maximum + 1, budget[0] + 1)
            raw = stream.read(allowance)
            if budget is not None:
                budget[0] -= len(raw)
                if budget[0] < 0:
                    raise SavedReportError("catalogue_too_large")
            if _fingerprint(os.fstat(stream.fileno())) != observation.fingerprint:
                raise SavedReportError("sources_changed")
    except OSError:
        raise _Unavailable("unreadable") from None
    if len(raw) > maximum:
        raise _Unavailable("too_large")
    return raw


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate metadata field")
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError("Nonfinite metadata value")


def _optional_string(data, key, default=None):
    value = data.get(key, default)
    if value is not None and not isinstance(value, str):
        raise _Unavailable("metadata_unreadable")
    if value is not None:
        try:
            value.encode("utf-8")
        except UnicodeError:
            # Escaped lone surrogates are accepted by Python's JSON decoder,
            # but cannot be emitted by the application's UTF-8 JSON provider.
            raise _Unavailable("metadata_unreadable") from None
    return value


def _load_metadata(source, budget=None):
    try:
        raw = _read_bytes(source.metadata, MAX_METADATA_BYTES, budget)
    except _Unavailable as exc:
        raise _Unavailable({"too_large": "metadata_too_large", "unsafe_path": "unsafe_path"}.get(exc.code, "metadata_unreadable")) from None
    raw_hash = hashlib.sha256(raw).hexdigest()
    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise _Unavailable("metadata_unreadable") from None
    if not isinstance(data, dict) or not isinstance(data.get("report_id"), str):
        raise _Unavailable("metadata_unreadable")
    if data["report_id"] != source.report_id:
        raise _Unavailable("identity_mismatch")
    simulation_id = _optional_string(data, "simulation_id")
    status = _optional_string(data, "status")
    requirement = _optional_string(data, "simulation_requirement", "")
    outline = data.get("outline")
    if outline is not None and not isinstance(outline, dict):
        raise _Unavailable("metadata_unreadable")
    outline = outline or {}
    title = _optional_string(outline, "title", "")
    summary = _optional_string(outline, "summary", "")
    if requirement is None or title is None or summary is None:
        raise _Unavailable("metadata_unreadable")
    title = title or source.report_id
    record = {
        "report_id": source.report_id, "simulation_id": simulation_id,
        "title": title[:300], "summary_preview": summary[:500], "requirement_preview": requirement[:500],
        "status": status if status in _STATUSES else "unknown",
        "created_at": _optional_string(data, "created_at"), "completed_at": _optional_string(data, "completed_at"),
        "source": source.label,
        "metadata_revision": _digest(["saved-report-metadata-v1", source.signature, raw_hash]),
    }
    return record, (source.report_id, simulation_id or "", title, summary, requirement), data


def list_saved_reports(root, *, q=None, status=None, offset=0, limit=20, revision=None):
    """Page distinct saved reports using only bounded saved metadata reads."""
    selection = _selection(q, status, offset, limit, revision)
    q = selection["q"]
    root = _root(root)
    before, sources = _catalogue(root)
    reasons, records, observations = {}, [], []
    budget = [MAX_TOTAL_METADATA_BYTES]
    phrase = q.casefold() if q is not None else None
    try:
        for source in sources:
            try:
                record, search_values, _ = _load_metadata(source, budget)
            except _Unavailable as exc:
                reasons[exc.code] = reasons.get(exc.code, 0) + 1
                observations.append((source.report_id, exc.code))
                continue
            observations.append((source.report_id, record["metadata_revision"]))
            if ((status is None or record["status"] == status)
                and (phrase is None or any(phrase in value.casefold() for value in search_values))):
                records.append(record)
        source_revision = _digest(["saved-report-catalogue-v1", before, observations])
        if revision is not None and source_revision != revision:
            raise SavedReportError("sources_changed")
        # Stable ID order breaks equal timestamp ties; naive saved times remain
        # literal and are never assigned an invented timezone.
        records.sort(key=lambda row: row["report_id"])
        records.sort(key=lambda row: (bool(row["created_at"]), row["created_at"] or ""), reverse=True)
        matched = len(records)
        page = records[offset:offset + limit]
        result = {
            "source_revision": source_revision, "observed_at": datetime.now(timezone.utc).isoformat(),
            "filters": {"q": q, "status": status}, "offset": offset, "limit": limit,
            "matched_count": matched, "returned_count": len(page), "has_more": offset + len(page) < matched,
            "unavailable_count": sum(reasons.values()),
            "unavailable_reasons": [{"code": code, "count": reasons[code]} for code in sorted(reasons)],
            "reports": page,
        }
        return _check_response(result, MAX_LIST_RESPONSE_BYTES)
    finally:
        if _catalogue(root)[0] != before:
            raise SavedReportError("sources_changed") from None


def _content(root, source, data):
    body = (_observe(root, source.report_id, "full_report.md") if source.label == "modern"
            else _observe(root, f"{source.report_id}.md"))
    label = "full_report.md" if source.label == "modern" else "legacy_markdown"
    result = {"content_source": label, "content_revision": None, "content_bytes": None,
              "markdown_content": None, "content_available": False, "content_error": None}
    try:
        if body.kind == "missing":
            value = data.get("markdown_content")
            result["content_source"] = "metadata" if value is not None else None
            if value is None:
                raise _Unavailable("not_saved")
            if not isinstance(value, str):
                raise _Unavailable("unreadable")
            raw = value.encode("utf-8")
            if len(raw) > MAX_MARKDOWN_BYTES:
                raise _Unavailable("too_large")
        else:
            raw = _read_bytes(body, MAX_MARKDOWN_BYTES)
            value = raw.decode("utf-8")
        result.update(content_revision=hashlib.sha256(raw).hexdigest(), content_bytes=len(raw),
                      markdown_content=value, content_available=True)
    except UnicodeError:
        result["content_error"] = "unreadable"
    except _Unavailable as exc:
        result["content_error"] = "unreadable" if exc.code == "unsafe_path" else exc.code
    # No file is reopened after capture. A changed selected source or metadata
    # still makes the current request conflict, rather than mixing generations.
    current = (_observe(root, source.report_id, "full_report.md") if source.label == "modern"
               else _observe(root, f"{source.report_id}.md"))
    if current.signature != body.signature:
        raise SavedReportError("sources_changed")
    return result


def read_saved_report(root, report_id, *, revision=None):
    """Capture saved Markdown once; valid metadata survives unavailable bodies."""
    try:
        validate_record_id(report_id)
    except StoragePathError:
        raise SavedReportError("invalid_report_id") from None
    _revision_valid(revision)
    root = _root(root)
    root_before = _root_observation(root)
    source = _source(root, report_id)
    if source.label == "legacy" and source.metadata.kind == "missing":
        raise SavedReportError("report_not_found")
    try:
        try:
            record, _, data = _load_metadata(source)
        except _Unavailable:
            raise SavedReportError("metadata_unavailable") from None
        if revision is not None and record["metadata_revision"] != revision:
            raise SavedReportError("sources_changed")
        result = {**record, "observed_at": datetime.now(timezone.utc).isoformat(), **_content(root, source, data)}
        return _check_response(result, MAX_DETAIL_RESPONSE_BYTES)
    finally:
        if (_root_observation(root).signature != root_before.signature
            or _source(root, report_id).signature != source.signature):
            raise SavedReportError("sources_changed") from None
