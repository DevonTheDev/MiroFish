"""Portable project/report paths beneath a trusted configured storage root.

Reject descendant aliases as well as escapes: a record must not name another
record through a symlink or junction. These checks are not a filesystem sandbox
against a local process changing paths between validation and use.
"""

from pathlib import Path
import re


class StoragePathError(ValueError):
    """An identifier or descendant path is unsafe for managed storage."""


_RESERVED = {"con", "prn", "aux", "nul"} | {
    f"{prefix}{number}" for prefix in ("com", "lpt") for number in range(1, 10)
}


def validate_record_id(record_id: str) -> str:
    if (
        not isinstance(record_id, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", record_id) is None
        or record_id.lower() in _RESERVED
    ):
        raise StoragePathError("Invalid storage record ID")
    return record_id


def storage_path(root: str, *components: str) -> str:
    """Resolve the trusted root, but reject aliases in any child component."""
    for component in components:
        if (
            not isinstance(component, str)
            or not component
            or component in {".", ".."}
            or component.endswith((".", " "))
            or any(ord(char) < 32 or char in '<>:"/\\|?*' for char in component)
            or component.split(".")[0].lower() in _RESERVED
        ):
            raise StoragePathError("Invalid storage filename")
    try:
        path = Path(root).resolve()
        for component in components:
            path = path / component
            # Resolve also detects Windows junctions and aliases to siblings.
            if path.is_symlink() or path.resolve() != path:
                raise StoragePathError("Linked storage paths are not supported")
        return str(path)
    except (OSError, RuntimeError) as exc:
        raise StoragePathError("Could not resolve storage path safely") from exc
