"""Per-file replacement for paths already validated by their owning manager."""

import json
import logging
import os
from pathlib import Path
import tempfile
from typing import Any, Callable, TextIO


def _write_atomic(
    path: str,
    serialize: Callable[[TextIO], Any],
    *,
    logger: logging.Logger,
    format_name: str,
) -> None:
    """Serialize beside an existing parent, close, then replace the final file.

    This creates no parent directories or locks and adds no path validation.
    It is not a multi-file transaction or a power-loss durability guarantee.
    """
    destination = Path(path)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary_path = stream.name
            serialize(stream)
        os.replace(temporary_path, destination)
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.warning(
                    f"Could not remove temporary {format_name} file %s",
                    temporary_path,
                    exc_info=True,
                )


def write_json_atomic(path: str, payload: Any, *, logger: logging.Logger) -> None:
    """Preserve the existing UTF-8, unescaped Unicode and indented JSON format."""
    _write_atomic(
        path,
        lambda stream: json.dump(payload, stream, ensure_ascii=False, indent=2),
        logger=logger,
        format_name="JSON",
    )


def write_text_atomic(path: str, text: str, *, logger: logging.Logger) -> None:
    """Replace a complete UTF-8 text file without changing its content/newlines."""
    _write_atomic(
        path,
        lambda stream: stream.write(text),
        logger=logger,
        format_name="text",
    )
