"""Close app-owned dependencies in order, independent of lazy creation order."""

import atexit
import threading
from typing import Callable


_PHASES = ("readiness", "simulations", "memory", "gateway")
_callbacks: dict[str, list[Callable[[], None]]] = {phase: [] for phase in _PHASES}
_registration_lock = threading.Lock()
_registered = False


def register_shutdown_callback(phase: str, callback: Callable[[], None]) -> None:
    """Register an owned resource once; later dependencies close after producers."""
    global _registered
    if phase not in _callbacks:
        raise ValueError(f"Unknown shutdown phase: {phase}")
    with _registration_lock:
        if callback not in _callbacks[phase]:
            _callbacks[phase].append(callback)
        if not _registered:
            atexit.register(_run_shutdown)
            _registered = True


def _run_shutdown() -> None:
    failures = []
    for phase in _PHASES:
        # Do not hold the registration lock while draining. A producer may
        # obtain a lazy dependency that belongs to a later cleanup phase.
        with _registration_lock:
            callbacks = tuple(reversed(_callbacks[phase]))
        for callback in callbacks:
            try:
                callback()
            except BaseException as exc:
                failures.append(exc)
    if failures:
        first = failures[0]
        for failure in failures[1:]:
            first.add_note(f"Additional application shutdown failure: {failure!r}")
        raise first
