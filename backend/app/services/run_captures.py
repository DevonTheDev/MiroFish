"""Bounded, immutable aggregate observations of terminal saved run files.

The saved terminal status is an observation, not proof that a process exited.
No live runner, provider, or graph is consulted. Fingerprints detect ordinary
concurrent saves, not hostile local filesystem changes or an atomic snapshot.
Payload digests detect corruption; they are not an authenticity guarantee.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import unicodedata

from ..storage import StoragePathError, storage_path, validate_record_id
from . import simulation_comparison as comparison


MAX_CAPTURE_BYTES = 256 * 1024
MAX_CAPTURES = 500
MAX_DATABASE_BYTES = 160 * 1024 * 1024
_APPLICATION_ID = 0x4D465243
_SCHEMA_VERSION = 1
_DATABASE_NAME = "run_captures.sqlite3"
_HEX32 = re.compile(r"[0-9a-f]{32}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_AVAILABILITY = {"complete", "partial", "unavailable"}
_PLATFORMS = ("twitter", "reddit")
_TERMINAL = {"completed", "stopped", "failed"}
_CONTEXT_NUMBERS = ("configured_agents", "requested_rounds", "last_saved_round")
_SUMMARY_KEYS = {
    "simulation_id", "project_id", "graph_id", "scenario", "configured_model",
    "configured_agents", "status", "created_at", "updated_at", "started_at",
    "completed_at", "requested_rounds", "last_saved_round", "availability",
    "warnings", "metrics",
}
_WARNINGS = {
    "config_unavailable", "run_state_unavailable", "partial_run", "no_action_logs",
    "source_unreadable", "source_too_large", "invalid_records",
    "platform_not_configured", "platform_log_missing",
}
_SCHEMA_SQL = """CREATE TABLE captures (
    capture_id TEXT PRIMARY KEY NOT NULL,
    request_hash TEXT NOT NULL,
    payload BLOB NOT NULL,
    payload_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL
)"""
_COLUMNS = [
    (0, "capture_id", "TEXT", 1, None, 1),
    (1, "request_hash", "TEXT", 1, None, 0),
    (2, "payload", "BLOB", 1, None, 0),
    (3, "payload_hash", "TEXT", 1, None, 0),
    (4, "captured_at", "TEXT", 1, None, 0),
]


class RunCaptureError(ValueError):
    """An allowlisted public message, stable code, and HTTP status."""

    def __init__(self, code, status_code, message):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _invalid_store():
    return RunCaptureError("capture_storage_invalid", 500, "Saved capture storage is invalid.")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _capture_id(value):
    if not isinstance(value, str) or _HEX32.fullmatch(value) is None:
        raise RunCaptureError("invalid_capture_id", 400, "Choose a valid capture ID.")
    return value


def _simulation_id(value):
    try:
        return validate_record_id(value)
    except StoragePathError:
        raise RunCaptureError("invalid_simulation_id", 400, "Choose a valid saved simulation.") from None


def _valid_unicode(value):
    try:
        value.encode("utf-8")
    except UnicodeError:
        return False
    return True


def _text_fields(label, note):
    if (not isinstance(label, str) or not isinstance(note, str)
            or not 1 <= len(label) <= 120 or not label.strip() or len(note) > 2000
            or not _valid_unicode(label) or not _valid_unicode(note)
            or any(unicodedata.category(char) == "Cc" for char in label)
            or any(unicodedata.category(char) == "Cc" and char not in "\n\t" for char in note)):
        raise RunCaptureError("invalid_capture_text", 400, "Use a label of 1–120 characters and a note of at most 2000 characters without control characters.")


def _canonical(value):
    return json.dumps(value, allow_nan=False, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":")).encode("ascii")


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _request_digest(simulation_id, source_revision, label, note):
    return _digest(_canonical({"simulation_id": simulation_id,
        "source_revision": source_revision, "label": label, "note": note}))


def _source_snapshot(simulation_root, run_root, paths):
    roots = {}
    for name, root in (("simulations", simulation_root), ("runs", run_root)):
        resolved = storage_path(root)
        roots[name] = {"path": resolved, "identity": comparison._fingerprint(resolved)}
    return {"roots": roots, "files": comparison._snapshot(paths)}


def preview_saved_run(simulation_root, run_root, simulation_id):
    """Read an allowlisted, revision-bound observation without writing files."""
    _simulation_id(simulation_id)
    try:
        paths = comparison._paths(simulation_root, run_root, simulation_id)
        before = _source_snapshot(simulation_root, run_root, paths)
        try:
            summary = comparison._summary(paths, simulation_id, before["files"])
            if summary["status"] not in _TERMINAL:
                raise RunCaptureError("run_not_terminal", 409, "Only terminal saved runs can be captured.")
            for key in _CONTEXT_NUMBERS:
                if summary[key] is not None:
                    summary[key] = str(summary[key])
            # The established reader keeps string IDs. Retain numeric context
            # IDs losslessly as decimal text without changing its public API.
            state = comparison._metadata(paths["state"], comparison.MAX_STATE_BYTES)
            if state is None:
                raise RunCaptureError("simulation_unreadable", 404, "A saved simulation could not be read.")
            for key in ("project_id", "graph_id"):
                value = state.get(key)
                if type(value) is int and value >= 0:
                    summary[key] = str(value)
        finally:
            if _source_snapshot(simulation_root, run_root, paths) != before:
                raise RunCaptureError("sources_changed", 409, "Saved files changed. Refresh and try again.") from None
    except comparison.ComparisonError as error:
        raise RunCaptureError(error.code, error.status_code, str(error)) from None
    except StoragePathError:
        raise RunCaptureError("unsafe_path", 400, "Saved simulation paths are unsafe.") from None
    observation = {
        "schema_version": 1, "source_revision": _digest(_canonical({"snapshot": before, "summary": summary})),
        "observed_at": _now(), "summary": summary,
    }
    try:
        _validate_observation(observation)
        encoded = _canonical(observation)
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise RunCaptureError("simulation_unreadable", 404, "A saved simulation could not be read.") from None
    if len(encoded) > MAX_CAPTURE_BYTES:
        raise RunCaptureError("capture_too_large", 413, "The saved observation exceeds the capture size limit.")
    return observation


def _keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("Unexpected object fields")


def _string(value, *, nullable=False):
    if nullable and value is None:
        return
    # Saved JSON can contain escaped surrogates. Keep that historical text
    # losslessly with ASCII JSON; newly entered labels/notes are stricter.
    if not isinstance(value, str):
        raise ValueError("Invalid text")


def _timestamp(value):
    _string(value)
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        raise ValueError("Expected UTC timestamp")


def _count(value, *, nullable=False):
    if nullable and value is None:
        return
    if type(value) is not int or not 0 <= value <= 2 * comparison.MAX_LOG_RECORDS:
        raise ValueError("Invalid bounded count")


def _validate_observation(value):
    _keys(value, {"schema_version", "source_revision", "observed_at", "summary"})
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ValueError("Invalid version")
    if not isinstance(value["source_revision"], str) or not _HEX64.fullmatch(value["source_revision"]):
        raise ValueError("Invalid revision")
    _timestamp(value["observed_at"])
    summary = value["summary"]
    _keys(summary, _SUMMARY_KEYS)
    validate_record_id(summary["simulation_id"])
    if summary["status"] not in _TERMINAL or summary["availability"] not in _AVAILABILITY:
        raise ValueError("Invalid saved status")
    for key in ("project_id", "graph_id", "configured_model", "created_at", "updated_at", "started_at", "completed_at"):
        _string(summary[key], nullable=True)
    _string(summary["scenario"])
    for key in _CONTEXT_NUMBERS:
        if summary[key] is not None and (not isinstance(summary[key], str) or not _DECIMAL.fullmatch(summary[key])):
            raise ValueError("Invalid context count")
    warnings = summary["warnings"]
    if not isinstance(warnings, list) or len(warnings) > 32:
        raise ValueError("Invalid warnings")
    for warning in warnings:
        if (not isinstance(warning, dict) or not {"code"} <= warning.keys()
                or not warning.keys() <= {"code", "platform", "count"}
                or warning["code"] not in _WARNINGS):
            raise ValueError("Invalid warning")
        if "platform" in warning and warning["platform"] not in _PLATFORMS:
            raise ValueError("Invalid warning platform")
        if "count" in warning:
            _count(warning["count"])
            if warning["code"] != "invalid_records" or warning["count"] == 0:
                raise ValueError("Invalid warning count")
        elif warning["code"] == "invalid_records":
            raise ValueError("Missing warning count")
    metrics = summary["metrics"]
    _keys(metrics, {"recorded_actions", "rounds_with_actions", "platforms", "action_types"})
    _keys(metrics["platforms"], _PLATFORMS)
    for name in ("recorded_actions", "rounds_with_actions"):
        _count(metrics[name], nullable=True)
    for platform in metrics["platforms"].values():
        _keys(platform, {"availability", "recorded_actions", "active_agents"})
        if platform["availability"] not in _AVAILABILITY:
            raise ValueError("Invalid platform availability")
        for name in ("recorded_actions", "active_agents"):
            _count(platform[name], nullable=True)
            if (platform[name] is None) != (platform["availability"] == "unavailable"):
                raise ValueError("Missing platform count")
        if platform["availability"] != "unavailable" and platform["active_agents"] > platform["recorded_actions"]:
            raise ValueError("Invalid active agent count")
    types = metrics["action_types"]
    if not isinstance(types, list) or len(types) > comparison.MAX_ACTION_TYPES:
        raise ValueError("Invalid action types")
    names = []
    for item in types:
        _keys(item, {"action_type", "count"})
        _string(item["action_type"])
        if not item["action_type"].strip() or len(item["action_type"]) > comparison.MAX_ACTION_TYPE_LENGTH:
            raise ValueError("Invalid action name")
        _count(item["count"])
        if item["count"] == 0:
            raise ValueError("Invalid action count")
        names.append(item["action_type"])
    if names != sorted(set(names)):
        raise ValueError("Invalid action ordering")
    if summary["availability"] == "unavailable":
        if metrics != comparison._unavailable_metrics():
            raise ValueError("Unavailable aggregate has counts")
    else:
        if metrics["recorded_actions"] is None or metrics["rounds_with_actions"] is None:
            raise ValueError("Missing aggregate count")
        if (sum(item["count"] for item in types) != metrics["recorded_actions"]
                or sum(item["recorded_actions"] or 0 for item in metrics["platforms"].values()) != metrics["recorded_actions"]
                or metrics["rounds_with_actions"] > metrics["recorded_actions"]):
            raise ValueError("Inconsistent aggregate counts")
        if summary["availability"] == "complete" and any(item["availability"] == "partial" for item in metrics["platforms"].values()):
            raise ValueError("Inconsistent aggregate availability")


def _validate_capture(value):
    _keys(value, {"schema_version", "capture_id", "label", "note", "captured_at", "observation"})
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ValueError("Invalid version")
    _capture_id(value["capture_id"])
    _text_fields(value["label"], value["note"])
    _timestamp(value["captured_at"])
    _validate_observation(value["observation"])


def _storage_paths(capture_root):
    try:
        supplied = Path(capture_root)
        root = storage_path(str(supplied.parent), supplied.name)
        if os.path.lexists(root) and not stat.S_ISDIR(os.lstat(root).st_mode):
            raise StoragePathError("Invalid root")
        paths = [storage_path(root, _DATABASE_NAME + suffix) for suffix in ("", "-journal", "-wal", "-shm")]
        for path in paths:
            try:
                info = os.lstat(path)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise StoragePathError("Invalid database file")
            if info.st_size > MAX_DATABASE_BYTES:
                raise RunCaptureError("capture_storage_full", 507, "Saved capture storage exceeds its size limit.")
            if path.endswith(("-wal", "-shm")):
                raise _invalid_store()
        return root, paths[0]
    except (OSError, StoragePathError, TypeError, ValueError) as error:
        if isinstance(error, RunCaptureError):
            raise
        raise RunCaptureError("unsafe_capture_path", 400, "Saved capture storage paths are unsafe.") from None


def _database_error(error):
    code = getattr(error, "sqlite_errorcode", None)
    if code == sqlite3.SQLITE_READONLY_ROLLBACK:
        result = RunCaptureError("capture_recovery_required", 503,
            "Saved capture storage needs rollback recovery. Explicitly recover the interrupted save.")
        # The API exposes only the fixed code/message. Explicit Save may
        # recover only this exact SQLite condition, never generic I/O errors.
        result._sqlite_errorcode = code
        return result
    if code is not None:
        code &= 255
    if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
        return RunCaptureError("capture_storage_busy", 503, "Saved capture storage is busy. Try again.")
    if code == sqlite3.SQLITE_FULL:
        return RunCaptureError("capture_storage_full", 507, "Saved capture storage exceeds its size limit.")
    if code in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB, sqlite3.SQLITE_SCHEMA, sqlite3.SQLITE_ERROR, sqlite3.SQLITE_TOOBIG):
        return _invalid_store()
    return RunCaptureError("capture_storage_unavailable", 500, "Saved capture storage is unavailable.")


def _schema(connection, *, initialize=False, allow_empty=False):
    application_id = connection.execute("PRAGMA application_id").fetchone()[0]
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    # Our schema has exactly two objects. Bound foreign/corrupt schema reads
    # instead of collecting or sorting arbitrary sqlite_master contents.
    schema = sorted(connection.execute("SELECT type, name, tbl_name, sql FROM sqlite_master LIMIT 3").fetchall(),
                    key=lambda item: item[1])
    if application_id == version == 0 and not schema:
        if initialize:
            connection.execute(_SCHEMA_SQL)
            connection.execute(f"PRAGMA application_id = {_APPLICATION_ID}")
            connection.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
            return True
        if allow_empty:
            return False
    if (application_id != _APPLICATION_ID or version != _SCHEMA_VERSION
            or schema != [
                ("table", "captures", "captures", _SCHEMA_SQL),
                ("index", "sqlite_autoindex_captures_1", "captures", None),
            ]
            or connection.execute("PRAGMA table_info(captures)").fetchall() != _COLUMNS):
        raise _invalid_store()
    return True


@contextmanager
def _connection(capture_root, *, write=False, allow_empty=False, recover=False):
    root, path = _storage_paths(capture_root)
    if not write and not os.path.exists(path):
        if recover:
            raise _invalid_store()
        yield None
        return
    connection = None
    try:
        if write:
            os.makedirs(root, mode=0o700, exist_ok=True)
            # An exclusive creation avoids SQLite's platform-dependent default
            # permissions. Existing files are never replaced or chmodded.
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
            except FileExistsError:
                pass
            else:
                os.close(fd)
        _, path = _storage_paths(capture_root)
        # Even mode=ro can create WAL sidecars. Refuse an incompatible header
        # before SQLite opens it; never change a foreign database's journal mode.
        with comparison._open_source(path) as stream:
            header = stream.read(100)
        if header and (len(header) != 100 or header[:16] != b"SQLite format 3\x00"
                       or header[18:20] != b"\x01\x01"):
            raise _invalid_store()
        # SQLite can recover a hot journal before SQL-level schema checks.
        # Any writable opening of an existing database must first establish
        # this dedicated store's identity from its bounded on-disk header.
        # Offsets/endianness: https://www.sqlite.org/fileformat.html
        if ((recover and not header) or ((write or recover) and header and (
                int.from_bytes(header[60:64], "big") != _SCHEMA_VERSION
                or int.from_bytes(header[68:72], "big") != _APPLICATION_ID))):
            raise _invalid_store()
        uri = Path(path).as_uri() + ("?mode=rw" if write or recover else "?mode=ro")
        connection = sqlite3.connect(uri, uri=True, timeout=2.0, isolation_level=None)
        connection.execute("PRAGMA busy_timeout = 2000")
        connection.execute("PRAGMA trusted_schema = OFF")
        connection.execute("PRAGMA temp_store = MEMORY")
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_CAPTURE_BYTES + 16384)
        if connection.execute("PRAGMA journal_mode").fetchone()[0] != "delete":
            raise _invalid_store()
        if write:
            connection.execute("BEGIN IMMEDIATE")
            _schema(connection, initialize=True)
            page_size = connection.execute("PRAGMA page_size").fetchone()[0]
            max_pages = MAX_DATABASE_BYTES // page_size
            actual_limit = connection.execute(f"PRAGMA max_page_count = {max_pages}").fetchone()[0]
            if actual_limit > max_pages:
                raise RunCaptureError("capture_storage_full", 507, "Saved capture storage exceeds its size limit.")
        else:
            connection.execute("PRAGMA query_only = ON")
            connection.execute("BEGIN")
            if not _schema(connection, allow_empty=allow_empty):
                yield None
                return
        yield connection
        if write:
            connection.commit()
    except sqlite3.Error as error:
        raise _database_error(error) from None
    except (OSError, comparison._SourceUnreadable):
        raise RunCaptureError("capture_storage_unavailable", 500, "Saved capture storage is unavailable.") from None
    finally:
        if connection is not None:
            try:
                try:
                    if connection.in_transaction:
                        connection.rollback()
                finally:
                    connection.close()
            except sqlite3.Error as error:
                raise _database_error(error) from None


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate key")
        value[key] = item
    return value


def _decode(row):
    capture_id, request_hash, payload, payload_hash, captured_at = row
    try:
        if (not isinstance(payload, bytes) or len(payload) > MAX_CAPTURE_BYTES
                or not isinstance(request_hash, str) or not _HEX64.fullmatch(request_hash)
                or not isinstance(payload_hash, str) or not _HEX64.fullmatch(payload_hash)
                or _digest(payload) != payload_hash):
            raise ValueError("Invalid capture encoding")
        value = json.loads(payload, object_pairs_hook=_unique_object,
                           parse_constant=comparison._reject_constant,
                           parse_float=comparison._finite_float)
        _validate_capture(value)
        if value["capture_id"] != capture_id or value["captured_at"] != captured_at or _canonical(value) != payload:
            raise ValueError("Capture index mismatch")
        observation = value["observation"]
        if request_hash != _request_digest(observation["summary"]["simulation_id"],
                                          observation["source_revision"], value["label"], value["note"]):
            raise ValueError("Capture request mismatch")
        return value
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        raise _invalid_store() from None


def _find(connection, capture_id, request_hash=None):
    if connection is None:
        return None
    row = connection.execute("SELECT capture_id, request_hash, payload, payload_hash, captured_at FROM captures WHERE capture_id = ?", (capture_id,)).fetchone()
    if row is None:
        return None
    value = _decode(row)
    if request_hash is not None and row[1] != request_hash:
        raise RunCaptureError("capture_conflict", 409, "This capture ID was already used for a different request.")
    return value


def _validate_retained_records(connection):
    if connection is None:
        return
    if connection.execute("SELECT COUNT(*) FROM captures").fetchone()[0] > MAX_CAPTURES:
        raise _invalid_store()
    for row in connection.execute("SELECT capture_id, request_hash, payload, payload_hash, captured_at FROM captures"):
        _decode(row)


def recover_run_captures(capture_root):
    """Explicitly let SQLite roll back an interrupted save, without sources.

    Missing/healthy stores are read-only no-ops. Only SQLite's precise
    read-only-rollback error admits an existing-file writable opening. SQLite
    finishes rollback before validation; committed corruption is then refused,
    never repaired or reported as successful recovery.
    """
    try:
        with _connection(capture_root) as connection:
            _validate_retained_records(connection)
        return {"recovered": False}
    except RunCaptureError as error:
        if getattr(error, "_sqlite_errorcode", None) != sqlite3.SQLITE_READONLY_ROLLBACK:
            raise
    with _connection(capture_root, recover=True) as connection:
        _validate_retained_records(connection)
    return {"recovered": True}


def create_run_capture(capture_root, simulation_root, run_root, capture_id,
                       simulation_id, source_revision, label, note=""):
    """Persist once; identical ID/request replays without touching source logs."""
    _capture_id(capture_id)
    _simulation_id(simulation_id)
    _text_fields(label, note)
    if not isinstance(source_revision, str) or not _HEX64.fullmatch(source_revision):
        raise RunCaptureError("invalid_source_revision", 400, "Preview the saved run before capturing it.")
    request_hash = _request_digest(simulation_id, source_revision, label, note)
    try:
        with _connection(capture_root, allow_empty=True) as connection:
            existing = _find(connection, capture_id, request_hash)
    except RunCaptureError as error:
        if getattr(error, "_sqlite_errorcode", None) != sqlite3.SQLITE_READONLY_ROLLBACK:
            raise
        recover_run_captures(capture_root)
        with _connection(capture_root) as connection:
            existing = _find(connection, capture_id, request_hash)
    if existing is not None:
        return existing, False
    observation = preview_saved_run(simulation_root, run_root, simulation_id)
    if observation["source_revision"] != source_revision:
        raise RunCaptureError("sources_changed", 409, "Saved files changed. Refresh and try again.")
    value = {"schema_version": 1, "capture_id": capture_id, "label": label,
             "note": note, "captured_at": _now(), "observation": observation}
    payload = _canonical(value)
    if len(payload) > MAX_CAPTURE_BYTES:
        raise RunCaptureError("capture_too_large", 413, "The saved observation exceeds the capture size limit.")
    with _connection(capture_root, write=True) as connection:
        existing = _find(connection, capture_id, request_hash)
        if existing is not None:
            return existing, False
        if connection.execute("SELECT COUNT(*) FROM captures").fetchone()[0] >= MAX_CAPTURES:
            raise RunCaptureError("capture_limit_reached", 409, "The saved capture limit has been reached.")
        connection.execute("INSERT INTO captures (capture_id, request_hash, payload, payload_hash, captured_at) VALUES (?, ?, ?, ?, ?)",
                           (capture_id, request_hash, payload, _digest(payload), value["captured_at"]))
    return value, True


def get_run_capture(capture_root, capture_id):
    _capture_id(capture_id)
    with _connection(capture_root) as connection:
        value = _find(connection, capture_id)
        if value is None:
            raise RunCaptureError("capture_not_found", 404, "The saved capture was not found.")
        return value


def list_run_captures(capture_root, offset=0, limit=20):
    if type(offset) is not int or not 0 <= offset <= 500 or type(limit) is not int or not 1 <= limit <= 50:
        raise RunCaptureError("invalid_pagination", 400, "Use an offset from 0–500 and a limit from 1–50.")
    with _connection(capture_root) as connection:
        if connection is None:
            return {"captures": [], "offset": offset, "limit": limit, "total": 0, "has_more": False}
        total = connection.execute("SELECT COUNT(*) FROM captures").fetchone()[0]
        if total > MAX_CAPTURES:
            raise _invalid_store()
        # Sort only bounded index fields, never the potentially 256 KiB JSON
        # documents. All selected documents are read in this same snapshot.
        rows = connection.execute("SELECT capture_id FROM captures ORDER BY captured_at DESC, capture_id ASC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        result = []
        for row in rows:
            capture = _find(connection, row[0])
            if capture is None:
                raise _invalid_store()
            summary = capture["observation"]["summary"]
            result.append({**{key: capture[key] for key in ("capture_id", "label", "captured_at")},
                           **{key: summary[key] for key in ("simulation_id", "status", "availability")}})
        return {"captures": result, "offset": offset, "limit": limit, "total": total,
                "has_more": offset + len(result) < total}


def compare_run_captures(capture_root, left_id, right_id):
    _capture_id(left_id)
    _capture_id(right_id)
    if left_id == right_id:
        raise RunCaptureError("invalid_selection", 400, "Choose two distinct saved captures.")
    with _connection(capture_root) as connection:
        left, right = _find(connection, left_id), _find(connection, right_id)
        if left is None or right is None:
            raise RunCaptureError("capture_not_found", 404, "The saved capture was not found.")
        return {"schema_version": 1, "left": left, "right": right,
                "differences": comparison._differences(left["observation"]["summary"], right["observation"]["summary"]),
                "generated_at": _now()}
