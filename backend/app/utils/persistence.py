"""Per-file JSON replacement for paths already validated by their owning manager."""

import json
import logging
import os
from pathlib import Path
import tempfile
from typing import Any


def write_json_atomic(path: str, payload: Any, *, logger: logging.Logger) -> None:
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
            json.dump(payload, stream, ensure_ascii=False, indent=2)
        os.replace(temporary_path, destination)
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.warning(
                    "Could not remove temporary JSON file %s",
                    temporary_path,
                    exc_info=True,
                )
