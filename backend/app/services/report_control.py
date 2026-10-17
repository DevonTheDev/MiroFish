"""Process-local cooperative retirement of one accepted report workflow.

The fence controls report operations and publication. It cannot abort an already
admitted provider/tool operation or roll back its non-report side effects.
"""

from contextlib import contextmanager
import threading


class ReportCancelled(Exception):
    """An accepted cancellation retired further report work/publication."""


class ReportControl:
    """One immutable job's admission, publication, and terminal arbitration."""

    def __init__(self):
        self._lock = threading.RLock()
        self._cancellation_requested = False
        self._terminal_status = None
        self._error = None

    def check(self):
        with self._lock:
            if self._cancellation_requested:
                raise ReportCancelled("Report cancellation requested")

    def operation(self, operation, *args, **kwargs):
        # Admission is the check under the mutex. A racing cancellation may
        # precede the physical call, but this is still the admitted operation.
        self.check()
        try:
            result = operation(*args, **kwargs)
        except Exception:
            self.check()
            raise
        self.check()
        return result

    @contextmanager
    def commit(self):
        """Serialize ordinary report publication with cancellation acceptance."""
        with self._lock:
            self.check()
            yield

    @contextmanager
    def terminal(self):
        """Permit terminal cancellation/error writes under the same mutex."""
        with self._lock:
            yield

    def request_cancel(self):
        """Accept once unless completed/failed already owns final publication."""
        with self._lock:
            if self._terminal_status is None:
                self._cancellation_requested = True
            return self.snapshot()

    def finish(self, status, error=None):
        """Select the terminal owner before releasing its publication fence."""
        if status not in {"completed", "failed", "cancelled"}:
            raise ValueError("Invalid report terminal status")
        with self._lock:
            if self._terminal_status is None:
                if self._cancellation_requested and status != "cancelled":
                    raise ReportCancelled("Report cancellation requested")
                self._terminal_status = status
            if error is not None:
                self.record_error(error)
            return self._terminal_status

    def record_error(self, error):
        with self._lock:
            message = str(error)
            if message and message != self._error:
                self._error = f"{self._error}; {message}" if self._error else message

    def snapshot(self):
        with self._lock:
            return {
                "cancellation_requested": self._cancellation_requested,
                "terminal_status": self._terminal_status,
                "error": self._error,
            }
