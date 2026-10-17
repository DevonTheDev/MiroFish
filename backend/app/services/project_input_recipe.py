"""Bounded observations of saved inputs; never a project/graph restore.

The configured root is trusted. Observation checks detect ordinary concurrent
changes, not hostile local races or writers that restore all stat observations.
"""

from datetime import datetime, timezone
import json
import os
import stat

from ..storage import StoragePathError, storage_path, validate_record_id


METADATA_LIMIT = SOURCE_LIMIT = 1024 * 1024
RECIPE_LIMIT = 2 * 1024 * 1024
SCENARIO_LIMIT = 64 * 1024
NAME_LIMIT = 1024
BLANK_CHARACTERS = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_ERRORS = {
    "unsafe_path": (400, "The project input path is not supported."),
    "not_found": (404, "Saved project inputs were not found."),
    "incomplete": (409, "Complete saved inputs could not be verified."),
    "changed": (409, "Saved inputs changed during capture. Try downloading again."),
    "too_large": (413, "Saved inputs exceed the input recipe limits."),
    "invalid": (422, "Saved inputs have an unsupported encoding or structure."),
    "unreadable": (500, "Saved inputs could not be read."),
}


class InputRecipeError(ValueError):
    def __init__(self, reason):
        self.status, self.public_message = _ERRORS[reason]
        self.code = "input_recipe_" + reason
        super().__init__(self.public_message)


def _fingerprint(observation):
    return (observation.st_dev, observation.st_ino, observation.st_mode,
            observation.st_nlink, observation.st_size,
            observation.st_mtime_ns, observation.st_ctime_ns)


def _observe(root, project_id):
    project_id = validate_record_id(project_id)
    paths = {
        "directory": storage_path(root, project_id),
        "metadata": storage_path(root, project_id, "project.json"),
        "source": storage_path(root, project_id, "extracted_text.txt"),
    }
    observations = {}
    for kind, path in paths.items():
        value = os.lstat(path)
        if kind == "directory":
            supported = stat.S_ISDIR(value.st_mode)
        else:
            supported = stat.S_ISREG(value.st_mode) and value.st_nlink == 1
        if not supported:
            raise InputRecipeError("unsafe_path")
        observations[kind] = value
    return paths, observations


def _read_bounded(path, expected_stat, limit):
    # O_NONBLOCK avoids blocking if an ordinary replacement becomes a FIFO.
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or _fingerprint(opened) != _fingerprint(expected_stat):
            raise InputRecipeError("changed")
        if opened.st_size > limit:
            raise InputRecipeError("too_large")
        payload = stream.read(limit + 1)
        if len(payload) > limit:
            raise InputRecipeError("too_large")
        if (_fingerprint(os.fstat(stream.fileno())) != _fingerprint(opened)
                or _fingerprint(os.lstat(path)) != _fingerprint(opened)):
            raise InputRecipeError("changed")
        return payload


def _capture(root, project_id):
    try:
        paths, observations = _observe(root, project_id)
    except StoragePathError:
        raise InputRecipeError("unsafe_path") from None
    except FileNotFoundError:
        raise InputRecipeError("not_found") from None
    try:
        metadata = _read_bounded(paths["metadata"], observations["metadata"], METADATA_LIMIT)
        source = _read_bounded(paths["source"], observations["source"], SOURCE_LIMIT)
        repeated = _read_bounded(paths["metadata"], observations["metadata"], METADATA_LIMIT)
        final_paths, final_observations = _observe(root, project_id)
        if (metadata != repeated or paths != final_paths
                or any(_fingerprint(value) != _fingerprint(final_observations[kind])
                       for kind, value in observations.items())):
            raise InputRecipeError("changed")
        return metadata, source
    except (FileNotFoundError, NotADirectoryError, StoragePathError):
        raise InputRecipeError("changed") from None
    except InputRecipeError as exc:
        if exc.code == "input_recipe_unsafe_path":
            raise InputRecipeError("changed") from None
        raise
    except OSError:
        # For an ordinary replacement that made open/read fail, report a changed
        # observation. A stable permission/I/O failure remains an unreadable 500.
        try:
            current_paths, current = _observe(root, project_id)
        except (OSError, StoragePathError, InputRecipeError):
            raise InputRecipeError("changed") from None
        if (current_paths != paths or any(_fingerprint(value) != _fingerprint(current[kind])
                                         for kind, value in observations.items())):
            raise InputRecipeError("changed") from None
        raise


def _bounded_scalar(value, limit):
    if not isinstance(value, str):
        raise InputRecipeError("invalid")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise InputRecipeError("invalid") from None
    if len(encoded) > limit:
        raise InputRecipeError("too_large")
    return value


def _reject_constant(_value):
    raise ValueError("Non-JSON numeric constant")


def read_project_input_recipe(root, project_id):
    """Return the complete UTF-8 recipe or one sanitized error; never write."""
    try:
        metadata_bytes, source_bytes = _capture(root, project_id)
        try:
            metadata = json.loads(metadata_bytes.decode("utf-8", errors="strict"), parse_constant=_reject_constant)
            source = source_bytes.decode("utf-8", errors="strict")
        except (ValueError, UnicodeError, RecursionError):
            raise InputRecipeError("invalid") from None
        if not isinstance(metadata, dict) or metadata.get("project_id") != project_id:
            raise InputRecipeError("invalid")
        name = _bounded_scalar(metadata.get("name"), NAME_LIMIT)
        scenario = metadata.get("simulation_requirement")
        length = metadata.get("total_text_length")
        if scenario is None or "total_text_length" not in metadata:
            raise InputRecipeError("incomplete")
        scenario = _bounded_scalar(scenario, SCENARIO_LIMIT)
        if type(length) is not int:
            raise InputRecipeError("invalid")
        if (length <= 0 or not scenario.strip(BLANK_CHARACTERS)
                or not source.strip(BLANK_CHARACTERS)
                or (len(source) != length and len(source.replace("\r\n", "\n")) != length)):
            raise InputRecipeError("incomplete")
        # Keep the raw decoded source unchanged, including CRLF and field BOMs.
        recipe = {
            "format": "mirofish-project-input-recipe", "version": 1,
            "source_kind": "saved_extracted_text", "source_text": source,
            "simulation_requirement": scenario, "source_project_name": name,
            "captured_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        encoded = json.dumps(recipe, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > RECIPE_LIMIT:
            raise InputRecipeError("too_large")
        return encoded
    except InputRecipeError:
        raise
    except OSError:
        raise InputRecipeError("unreadable") from None
