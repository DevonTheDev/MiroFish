"""Finite, read-only observations of saved project metadata.

These are candidates, not exportability checks or a transactional snapshot.
The configured root is trusted; checks detect ordinary changes, not a hostile
writer restoring every observed stat field. No source or model is loaded.
"""

from datetime import datetime
import json
import os
import re
import stat
import unicodedata

from ..storage import StoragePathError, storage_path, validate_record_id


ENTRY_LIMIT = 256
ROW_LIMIT = 50
METADATA_LIMIT = 1024 * 1024
METADATA_BUDGET = 8 * 1024 * 1024
RESPONSE_LIMIT = 256 * 1024
_SKIP_REASONS = ("unsafe", "missing", "too_large", "invalid", "changed", "unreadable")
_STATUSES = {"created", "ontology_generated", "graph_building", "graph_stopped", "graph_completed", "failed"}
_BIDI_CONTROLS = frozenset("\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})?")
_ERRORS = {
    "invalid_request": (400, "The saved inputs request is not supported."),
    "changed": (409, "Project storage changed during this scan. Try again."),
    "unreadable": (500, "Saved inputs could not be listed."),
}


class InputCandidatesError(ValueError):
    """A fixed public whole-request error without path or metadata details."""
    def __init__(self, reason):
        self.status, self.public_message = _ERRORS[reason]
        self.code = "saved_input_candidates_" + reason
        super().__init__(self.public_message)


class _Skipped(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def _fingerprint(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _identity(value):
    return value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode)


def _observe(root, project_id):
    # storage_path accepts a configured root alias, but rejects descendant
    # aliases/junctions. Do not consult DirEntry caches for race observations.
    directory = storage_path(root, project_id)
    directory_stat = os.lstat(directory)
    if not stat.S_ISDIR(directory_stat.st_mode):
        raise _Skipped("unsafe")
    metadata = storage_path(root, project_id, "project.json")
    metadata_stat = os.lstat(metadata)
    if not stat.S_ISREG(metadata_stat.st_mode) or metadata_stat.st_nlink != 1:
        raise _Skipped("unsafe")
    return (directory, metadata), (directory_stat, metadata_stat)


def _assert_unchanged(root, project_id, paths, observations):
    try:
        current_paths, current = _observe(root, project_id)
    except (StoragePathError, FileNotFoundError, NotADirectoryError, _Skipped):
        raise _Skipped("changed") from None
    if (current_paths != paths
            or any(_fingerprint(before) != _fingerprint(after)
                   for before, after in zip(observations, current))):
        raise _Skipped("changed")


def _read_metadata(root, project_id, paths, observations):
    expected = observations[1]
    descriptor = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(paths[1], flags)
        opened = os.fstat(descriptor)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or _fingerprint(opened) != _fingerprint(expected)):
            raise _Skipped("changed")
        # One unbuffered raw read. The caller has already reserved N+1; no
        # wrapper may read ahead, and short reads/growth are never retried.
        payload = os.read(descriptor, expected.st_size + 1)
        if (len(payload) != expected.st_size
                or _fingerprint(os.fstat(descriptor)) != _fingerprint(expected)):
            raise _Skipped("changed")
        _assert_unchanged(root, project_id, paths, observations)
        return payload
    except (FileNotFoundError, NotADirectoryError):
        raise _Skipped("changed") from None
    except OSError:
        # A positive path change is different from a stable denied/read error.
        # This re-observes stats only, never reads content or refunds allowance.
        try:
            _assert_unchanged(root, project_id, paths, observations)
        except OSError:
            pass
        raise _Skipped("unreadable") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _display(value, scalar_limit, byte_limit):
    if not isinstance(value, str):
        return None, False
    # Invalid scalars anywhere invalidate the display field, even beyond the
    # clipped prefix. Source metadata is already bounded to one MiB.
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        return None, False
    cleaned = "".join(
        " " if unicodedata.category(character) in {"Cc", "Zl", "Zp"}
        or character in _BIDI_CONTROLS else character
        for character in value
    )
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        return None, False
    output = []
    byte_count = 0
    for character in cleaned:
        length = len(character.encode("utf-8"))
        if len(output) == scalar_limit or byte_count + length > byte_limit:
            break
        output.append(character)
        byte_count += length
    result = "".join(output)
    return result, len(result) < len(cleaned)


def _date(value):
    if not isinstance(value, str) or len(value) > 40 or _DATE.fullmatch(value) is None:
        return None
    if len(value) >= 6 and value[-6] in {"+", "-"}:
        if int(value[-5:-3]) > 23 or int(value[-2:]) > 59:
            return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value


def _reject_constant(_value):
    raise ValueError("Non-JSON numeric constant")


def _summary(payload, project_id):
    try:
        metadata = json.loads(payload.decode("utf-8", errors="strict"), parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise _Skipped("invalid") from None
    if not isinstance(metadata, dict) or metadata.get("project_id") != project_id:
        raise _Skipped("invalid")
    name, name_truncated = _display(metadata.get("name"), 120, 512)
    scenario, scenario_truncated = _display(metadata.get("simulation_requirement"), 240, 1024)
    status = metadata.get("status")
    return {
        "project_id": project_id,
        "name": name,
        "name_truncated": name_truncated,
        "status": status if isinstance(status, str) and status in _STATUSES else "unknown",
        "created_at": _date(metadata.get("created_at")),
        "updated_at": _date(metadata.get("updated_at")),
        "scenario_excerpt": scenario,
        "scenario_truncated": scenario_truncated,
    }


def _empty_observation():
    return {
        "items": [], "examined_entries": 0, "returned": 0,
        "metadata_bytes_budgeted": 0, "budget_deferred": 0,
        "skipped": {reason: 0 for reason in _SKIP_REASONS},
        "stop_reason": "end", "directory_changed": False, "partial": False,
        "limits": {"entries": ENTRY_LIMIT, "rows": ROW_LIMIT,
                   "metadata_file_bytes": METADATA_LIMIT, "metadata_total_bytes": METADATA_BUDGET},
    }


def _scan(root, data):
    try:
        resolved = storage_path(root)
        initial = os.lstat(resolved)
    except FileNotFoundError:
        return
    except (OSError, StoragePathError):
        raise InputCandidatesError("unreadable") from None
    if not stat.S_ISDIR(initial.st_mode):
        raise InputCandidatesError("unreadable")
    seen = set()
    try:
        with os.scandir(resolved) as entries:
            while True:
                if data["examined_entries"] == ENTRY_LIMIT:
                    data["stop_reason"] = "entry_limit"
                    break
                if len(data["items"]) == ROW_LIMIT:
                    data["stop_reason"] = "row_limit"
                    break
                if data["metadata_bytes_budgeted"] == METADATA_BUDGET:
                    data["stop_reason"] = "byte_limit"
                    break
                try:
                    entry = next(entries)
                except StopIteration:
                    break
                data["examined_entries"] += 1
                try:
                    project_id = validate_record_id(entry.name)
                    if project_id in seen:
                        raise _Skipped("changed")
                    seen.add(project_id)
                    try:
                        paths, observations = _observe(resolved, project_id)
                    except (FileNotFoundError, NotADirectoryError):
                        raise _Skipped("missing") from None
                    size = observations[1].st_size
                    if size > METADATA_LIMIT:
                        raise _Skipped("too_large")
                    if size < 0:
                        raise _Skipped("invalid")
                    allowance = size + 1
                    if allowance > METADATA_BUDGET - data["metadata_bytes_budgeted"]:
                        data["budget_deferred"] = 1
                        data["stop_reason"] = "byte_limit"
                        break
                    # Charge before open and never refund even failed attempts.
                    data["metadata_bytes_budgeted"] += allowance
                    payload = _read_metadata(resolved, project_id, paths, observations)
                    row = _summary(payload, project_id)
                    _assert_unchanged(resolved, project_id, paths, observations)
                    data["items"].append(row)
                except _Skipped as skipped:
                    data["skipped"][skipped.reason] += 1
                except StoragePathError as error:
                    reason = "unreadable" if isinstance(error.__cause__, OSError) else "unsafe"
                    data["skipped"][reason] += 1
                except OSError:
                    data["skipped"]["unreadable"] += 1
    except OSError:
        # Failure to open/advance/close the root iterator invalidates all rows.
        raise InputCandidatesError("unreadable") from None
    try:
        final_path = storage_path(root)
        final = os.lstat(final_path)
    except (FileNotFoundError, NotADirectoryError):
        raise InputCandidatesError("changed") from None
    except (OSError, StoragePathError):
        raise InputCandidatesError("unreadable") from None
    if final_path != resolved or _identity(final) != _identity(initial):
        raise InputCandidatesError("changed")
    data["directory_changed"] = _fingerprint(final) != _fingerprint(initial)


def read_project_input_candidates(root):
    """Return bounded compact UTF-8 envelope bytes, or one sanitized error."""
    try:
        data = _empty_observation()
        _scan(root, data)
        data["items"].sort(key=lambda row: row["project_id"])
        data["returned"] = len(data["items"])
        data["partial"] = (data["stop_reason"] != "end" or any(data["skipped"].values())
                           or bool(data["budget_deferred"]) or data["directory_changed"])
        payload = json.dumps({"success": True, "data": data}, ensure_ascii=False,
                             allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > RESPONSE_LIMIT:
            raise InputCandidatesError("unreadable")
        return payload
    except InputCandidatesError:
        raise
    except (OSError, StoragePathError, ValueError, UnicodeError, RecursionError):
        raise InputCandidatesError("unreadable") from None
