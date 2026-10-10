"""Bounded observations of the current platform SQLite interview traces.

Connections use escaped mode=ro URIs: the main database is read-only while
SQLite retains its normal committed-WAL/SHM semantics. This is neither a run
archive nor a cross-platform atomic snapshot. Storage path checks share the
application's protection against descendant aliases, not a filesystem sandbox
against a local process concurrently replacing paths.
"""
from contextlib import closing
from datetime import datetime, timezone
import codecs
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat

from ..storage import StoragePathError, storage_path, validate_record_id

MAX_DATABASE_BYTES = 160 * 1024 * 1024
MAX_WAL_BYTES = 64 * 1024 * 1024
MAX_VM_OPERATIONS = 2_000_000
LOCK_TIMEOUT_SECONDS = 0.25
MAX_PAYLOAD_BYTES = 16 * 1024
MAX_TIMESTAMP_BYTES = 256
MAX_ROWS_PER_PLATFORM = 100
MAX_ROWS_TOTAL = 200
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
# Enough for the bounded identifier, two source summaries, limits and envelope.
_ENVELOPE_RESERVE_BYTES = 8192
_PLATFORMS = ("twitter", "reddit")
_MESSAGES = {
    "invalid_filters": "Choose valid saved interview filters.",
    "invalid_selection": "Choose a valid saved simulation ID.",
    "unsafe_path": "The saved storage path is not safe to read.",
    "interviews_unavailable": "Saved interviews could not be read.",
    "response_too_large": "The saved interview observation exceeds its response limit.",
    "source_changed": "The saved interview source changed. Refresh newest to start a new observation.",
}


class SavedInterviewsError(ValueError):
    def __init__(self, code, status_code=400):
        self.code = code
        self.status_code = status_code
        super().__init__(_MESSAGES[code])


def _agent_id(value):
    if (not isinstance(value, str) or re.fullmatch(r"0|[1-9][0-9]{0,18}", value) is None
            or int(value) > 2**63 - 1):
        return None
    return value


def _selection(platform, agent_id):
    if (platform is not None and platform not in _PLATFORMS
            or agent_id is not None and _agent_id(agent_id) is None):
        raise SavedInterviewsError("invalid_filters")
    return {"platform": platform, "agent_id": agent_id}


def parse_saved_interviews_query(args):
    """Reject unknown, repeated and noncanonical filters before storage reads."""
    if any(key not in {"platform", "agent_id", "window", "before_row", "revision"}
           or len(args.getlist(key)) != 1 for key in args):
        raise SavedInterviewsError("invalid_filters")
    selected = _selection(args.get("platform"), args.get("agent_id"))
    window, before_row, revision = (args.get(key) for key in ("window", "before_row", "revision"))
    _window_selection(selected["platform"], window, before_row, revision)
    return {**selected, **({"window": window, "before_row": before_row, "revision": revision}
                           if window is not None else {})}


def _window_selection(platform, window, before_row, revision):
    if window is None and before_row is None and revision is None:
        return
    if window != "1" or platform not in _PLATFORMS:
        raise SavedInterviewsError("invalid_filters")
    if before_row is None and revision is None:
        return
    if (not isinstance(before_row, str)
            or re.fullmatch(r"0|-?[1-9][0-9]{0,18}", before_row) is None
            or not -2**63 <= int(before_row) <= 2**63 - 1
            or not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{64}", revision) is None):
        raise SavedInterviewsError("invalid_filters")


def _source_revision(simulation_id, filters, paths):
    # Ordinary saved-file identity, not a content-authenticated archive. SHM is
    # reader bookkeeping and must not invalidate unchanged committed WAL data.
    fingerprints = []
    for suffix in ("", "-wal", "-journal"):
        try:
            info = os.lstat(paths[suffix])
            fingerprint = (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                           info.st_mtime_ns, info.st_ctime_ns)
            # SQLite may create an empty WAL on a read-only open after the last
            # writer closed. It carries no frames; bind every nonempty WAL.
            if suffix == "-wal" and stat.S_ISREG(info.st_mode) and info.st_size == 0:
                fingerprint = None
        except FileNotFoundError:
            fingerprint = None
        except OSError as error:
            fingerprint = ("unreadable", error.errno)
        fingerprints.append((suffix, fingerprint))
    context = [simulation_id, filters, fingerprints]
    return hashlib.sha256(json.dumps(context, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def encode_response(data):
    """One strict ASCII encoding for accounting and the actual HTTP response."""
    return json.dumps({"success": True, "data": data}, ensure_ascii=True,
                      allow_nan=False, separators=(",", ":"))


def _source(status="not_requested", warning=None):
    return {"status": status, "returned_count": 0, "has_more": None,
            "coverage": "not_requested" if status == "not_requested" else "unavailable",
            "warnings": [warning] if warning else []}


def _paths(root, simulation_id, platforms):
    # Complete this pass for every selected main/sidecar path before opening any
    # database. SQLite can access sidecars even when its main URI is read-only.
    return {platform: {suffix: Path(storage_path(root, simulation_id,
            f"{platform}_simulation.db{suffix}"))
            for suffix in ("", "-wal", "-shm", "-journal")}
            for platform in platforms}


def _source_check(paths):
    try:
        database = paths[""].stat()
    except FileNotFoundError:
        return _source("missing", "source_missing")
    except OSError:
        return _source("unreadable", "source_unreadable")
    if not stat.S_ISREG(database.st_mode):
        return _source("unreadable", "source_unreadable")
    if database.st_size > MAX_DATABASE_BYTES:
        return _source("too_large", "database_too_large")
    for suffix in ("-wal", "-shm", "-journal"):
        try:
            sidecar = paths[suffix].stat()
        except FileNotFoundError:
            continue
        except OSError:
            return _source("unreadable", "source_unreadable")
        if not stat.S_ISREG(sidecar.st_mode):
            return _source("unreadable", "source_unreadable")
        if suffix == "-wal" and sidecar.st_size > MAX_WAL_BYTES:
            return _source("too_large", "wal_too_large")
    return None


def _decode(raw, warnings, *, truncated=False):
    try:
        # A byte budget can split a valid codepoint. Leave that trailing prefix
        # pending rather than inventing replacement text or calling it corrupt.
        return codecs.utf_8_decode(raw, "strict", not truncated)[0]
    except UnicodeDecodeError:
        if "invalid_utf8" not in warnings:
            warnings.append("invalid_utf8")
        return codecs.utf_8_decode(raw, "replace", not truncated)[0]


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError("nonfinite constant")


def _record(platform, row):
    row_id, agent, timestamp_type, timestamp_bytes, timestamp_raw, payload_type, payload_bytes, raw = row
    warnings = []
    if isinstance(agent, bytes):
        agent = agent.decode("ascii", errors="replace")
    elif type(agent) is int:
        agent = str(agent)
    agent = _agent_id(agent)
    if agent is None:
        warnings.append("invalid_agent_id")
    timestamp = None
    truncated = False
    if timestamp_type == "null":
        warnings.append("missing_timestamp")
    elif timestamp_type != "text":
        warnings.append("invalid_timestamp")
    else:
        timestamp = _decode(timestamp_raw, warnings, truncated=timestamp_bytes > MAX_TIMESTAMP_BYTES)
        if timestamp_bytes > MAX_TIMESTAMP_BYTES:
            truncated = True
            warnings.append("timestamp_truncated")
    record = {"platform": platform, "row_id": str(row_id), "record_id": f"{platform}:{row_id}",
              "agent_id": agent, "timestamp": timestamp, "prompt": None, "response": None,
              "payload_kind": "missing", "raw_preview": None, "payload_bytes": payload_bytes,
              "truncated": truncated, "warnings": warnings}
    if payload_type == "null":
        warnings.append("missing_payload")
        return record
    # No complete arbitrary info field crosses the SQLite/Python boundary.
    text = _decode(raw, warnings, truncated=payload_bytes > MAX_PAYLOAD_BYTES)
    record.update(payload_kind="raw", raw_preview=text)
    if payload_type not in {"text", "blob"}:
        warnings.append("invalid_payload_type")
        return record
    if payload_bytes > MAX_PAYLOAD_BYTES:
        record["truncated"] = True
        warnings.append("payload_truncated")
        return record
    # Invalid UTF-8 cannot establish a safely decoded structured payload.
    if raw.decode("utf-8", errors="replace").encode("utf-8") != raw:
        return record
    try:
        payload = json.loads(text, object_pairs_hook=_object, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        warnings.append("invalid_json")
        return record
    if not isinstance(payload, dict):
        warnings.append("invalid_payload_shape")
        return record
    if any(key in payload and not isinstance(payload[key], str) for key in ("prompt", "response")):
        warnings.append("invalid_payload_fields")
        return record
    record.update(payload_kind="structured", raw_preview=None,
                  prompt=payload.get("prompt"), response=payload.get("response"))
    for key in ("prompt", "response"):
        if key not in payload:
            warnings.append(f"missing_{key}")
    return record


def _rowid_name(connection):
    # Ordinary physical tables only; reject views/virtual tables and choose an
    # unshadowed SQLite rowid alias. No arbitrary schema text is materialized.
    schema = connection.execute("SELECT type, lower(substr(sql, 1, 32)) FROM sqlite_schema WHERE name = 'trace'").fetchone()
    if schema is None or schema[0] != "table" or "virtual" in schema[1]:
        raise sqlite3.DatabaseError("unsupported trace schema")
    columns = {row[0].lower() for row in connection.execute(
        "SELECT substr(name, 1, 64) FROM pragma_table_xinfo('trace')")}
    for name in ("_rowid_", "rowid", "oid"):
        if name not in columns:
            return name
    raise sqlite3.DatabaseError("unavailable physical rowid")


def _read_platform(platform, paths, agent_id, response_budget, before_row=None):
    checked = _source_check(paths)
    if checked is not None:
        return checked, []
    source = _source("available")
    records = []
    used_bytes = 0
    operations = 0
    interrupted = False
    interval = min(1000, MAX_VM_OPERATIONS)

    def progress():
        nonlocal operations, interrupted
        operations += interval
        interrupted = operations >= MAX_VM_OPERATIONS
        return int(interrupted)

    try:
        with closing(sqlite3.connect(paths[""].as_uri() + "?mode=ro", uri=True,
                                     timeout=LOCK_TIMEOUT_SECONDS)) as connection:
            connection.set_progress_handler(progress, interval)
            connection.execute("PRAGMA query_only = ON")
            connection.execute("PRAGMA trusted_schema = OFF")
            rowid = _rowid_name(connection)
            where = "action = 'interview'"
            params = [MAX_TIMESTAMP_BYTES, MAX_PAYLOAD_BYTES]
            if agent_id is not None:
                # Keep integer identity exact and accept only canonical stored
                # text identities; never coerce floats or padded strings to IDs.
                where += " AND ((typeof(user_id) = 'integer' AND user_id = ?) OR (typeof(user_id) = 'text' AND CAST(user_id AS BLOB) = CAST(? AS BLOB)))"
                params.extend((int(agent_id), agent_id))
            if before_row is not None:
                where += f" AND {rowid} < ?"
                params.append(int(before_row))
            params.append(MAX_ROWS_PER_PLATFORM + 1)
            cursor = connection.execute(f"""
                SELECT {rowid},
                  CASE WHEN typeof(user_id) = 'integer' THEN user_id
                       WHEN typeof(user_id) = 'text' AND length(CAST(user_id AS BLOB)) <= 19
                       THEN substr(CAST(user_id AS BLOB), 1, 19) ELSE NULL END,
                  typeof(created_at), length(CAST(created_at AS BLOB)),
                  CASE WHEN typeof(created_at) = 'text' THEN coalesce(substr(CAST(created_at AS BLOB), 1, ?), X'') ELSE NULL END,
                  typeof(info), length(CAST(info AS BLOB)), coalesce(substr(CAST(info AS BLOB), 1, ?), X'')
                FROM trace WHERE {where} ORDER BY {rowid} DESC LIMIT ?
                """, params)
            while True:
                row = cursor.fetchone()
                if row is None:
                    source["has_more"] = False
                    break
                if len(records) >= MAX_ROWS_PER_PLATFORM:
                    source["has_more"] = True
                    source["warnings"].append("row_limit")
                    break
                record = _record(platform, row)
                size = len(json.dumps(record, ensure_ascii=True, allow_nan=False,
                                      separators=(",", ":")).encode("ascii")) + 1
                if used_bytes + size > response_budget:
                    source["has_more"] = True
                    source["warnings"].append("response_limit")
                    break
                records.append(record)
                used_bytes += size
    except (sqlite3.Error, OSError, ValueError, UnicodeError):
        source["status"] = "query_limited" if interrupted else "unreadable"
        # A read or close failure retires completion and limit claims, including
        # a previously exhausted query; successfully observed rows stay useful.
        source["has_more"] = None
        source["warnings"] = [warning for warning in source["warnings"]
                              if warning not in {"row_limit", "response_limit"}]
        source["warnings"].append("query_limited" if interrupted else "source_unreadable")
    source["returned_count"] = len(records)
    if any(record["warnings"] for record in records):
        source["warnings"].append("record_warnings")
    source["coverage"] = ("complete" if not source["warnings"] else "partial") if (
        source["status"] == "available" or records) else "unavailable"
    return source, records


def read_saved_interviews(run_root, simulation_id, *, platform=None, agent_id=None,
                          window=None, before_row=None, revision=None):
    """Observe current saved trace rows, without managers, profiles or inference."""
    try:
        validate_record_id(simulation_id)
    except StoragePathError:
        raise SavedInterviewsError("invalid_selection") from None
    filters = _selection(platform, agent_id)
    _window_selection(platform, window, before_row, revision)
    platforms = (platform,) if platform else _PLATFORMS
    try:
        paths = _paths(run_root, simulation_id, platforms)
    except StoragePathError:
        raise SavedInterviewsError("unsafe_path") from None
    source_revision = _source_revision(simulation_id, filters, paths[platform]) if window else None
    if revision is not None and revision != source_revision:
        raise SavedInterviewsError("source_changed", 409)
    # Reserve each requested source its own share so a large Twitter payload
    # cannot consume the space needed to retain a healthy Reddit observation.
    budget = max(0, (MAX_RESPONSE_BYTES - _ENVELOPE_RESERVE_BYTES) // len(platforms))
    data = {"version": 2 if window else 1, "simulation_id": simulation_id, "filters": filters,
            "observed_at": datetime.now(timezone.utc).isoformat(), "order": "platform_then_row_desc",
            "limits": {"rows_per_platform": MAX_ROWS_PER_PLATFORM, "rows_total": MAX_ROWS_TOTAL,
                "database_bytes": MAX_DATABASE_BYTES, "wal_bytes": MAX_WAL_BYTES,
                "vm_operations_per_platform": MAX_VM_OPERATIONS, "lock_timeout_seconds": LOCK_TIMEOUT_SECONDS,
                "payload_bytes": MAX_PAYLOAD_BYTES, "timestamp_bytes": MAX_TIMESTAMP_BYTES,
                "response_bytes": MAX_RESPONSE_BYTES, "response_bytes_per_platform": budget},
            "availability": "unavailable", "sources": {p: _source() for p in _PLATFORMS}, "records": []}
    if window:
        data["window"] = {"before_row": before_row, "source_revision": source_revision}
    for name in platforms:
        try:
            source, records = _read_platform(name, paths[name], agent_id, budget, before_row)
        finally:
            # Check after the connection closes, including partial/failed reads.
            if window and _source_revision(simulation_id, filters, paths[name]) != source_revision:
                raise SavedInterviewsError("source_changed", 409)
        data["sources"][name] = source
        data["records"].extend(records)
    coverage = [data["sources"][name]["coverage"] for name in platforms]
    data["availability"] = ("complete" if all(item == "complete" for item in coverage) else
                            "partial" if any(item in {"complete", "partial"} for item in coverage) else "unavailable")
    if len(encode_response(data).encode("ascii")) > MAX_RESPONSE_BYTES:
        raise SavedInterviewsError("response_too_large", 413)
    return data
