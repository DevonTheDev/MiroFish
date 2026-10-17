"""Exact process-local ownership for cooperative local graph construction.

Combined locks always run project -> graph lifecycle -> control. Control-only
admission is short and never calls persistence, a provider, or another lock.
Receipts describe application-owned work, not shared gateway or GPU idleness.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import threading
import uuid


class GraphBuildStopped(RuntimeError):
    """A later productive operation lost admission to Stop."""


class GraphBuildUnresolved(RuntimeError):
    """Identity, journal, or settlement cannot be confirmed."""


_current_control = ContextVar("local_graph_build_control", default=None)
_project_locks = {}
_registry = {}
_registry_lock = threading.RLock()


def project_build_lock(project_id):
    with _registry_lock:
        return _project_locks.setdefault(project_id, threading.RLock())


def current_control():
    return _current_control.get()


@contextmanager
def bind_control(control):
    token = _current_control.set(control)
    try:
        yield
    finally:
        _current_control.reset(token)


def register_control(control):
    with _registry_lock:
        existing = _registry.get(control.project_id)
        if existing and existing is not control:
            raise GraphBuildUnresolved("Another local graph build still owns this project")
        _registry[control.project_id] = control


def get_control(project_id, task_id=None):
    with _registry_lock:
        control = _registry.get(project_id)
        return control if control and (task_id is None or control.task_id == task_id) else None


def release_control(control):
    with _registry_lock:
        if _registry.get(control.project_id) is control:
            del _registry[control.project_id]


def _now():
    return datetime.now(timezone.utc).isoformat()


class GraphBuildControl:
    def __init__(self, project_id, task_id):
        self.project_id, self.task_id = project_id, task_id
        self.graph_id = self.batch_id = self.operation_id = None
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.stop_requested = False
        self.requested_at = None
        self.requested_persisted = False
        self.persistence_error = None
        self.error = None
        self._errors = []
        self.unresolved = False
        self.completed = False
        self.worker_done = False
        self.worker_error = None
        self.phase = "queued"
        self.expected_chunks = None
        self._admitted_episodes = set()
        self._succeeded_episodes = set()
        self._receipts = {}

    def request_stop(self):
        with self.changed:
            if self.completed:
                return False
            self.stop_requested = True
            self.requested_at = self.requested_at or _now()
            self.changed.notify_all()
            return True

    def claim_completion(self):
        with self.lock:
            if self.stop_requested:
                return False
            self.completed = True
            return True

    def check_admission(self):
        with self.lock:
            if self.stop_requested:
                raise GraphBuildStopped("Graph build Stop has closed admission")

    def own_receipt(self, kind):
        """Register before scheduling; only actual owner completion settles it."""
        with self.changed:
            receipt = uuid.uuid4().hex
            self._receipts[receipt] = {"kind": kind, "settled": False}
            return receipt

    def settle_receipt(self, receipt, error=None, *, unresolved=False):
        with self.changed:
            self._receipts[receipt]["settled"] = True
            if error is not None:
                self.record_error(error, unresolved=unresolved)
            self.changed.notify_all()

    @contextmanager
    def operation(self, phase, *, settlement=False):
        with self.lock:
            if not settlement:
                self.check_admission()
            self.phase = phase
            receipt = self.own_receipt("worker:" + phase)
        try:
            with bind_control(self):
                yield
        except GraphBuildStopped:
            raise
        except BaseException as error:
            self.record_error(error, unresolved=isinstance(error, GraphBuildUnresolved))
            raise
        finally:
            self.settle_receipt(receipt)

    def admit_episode(self, identifier):
        """Called only after semaphore, graph, and database coordination waits."""
        with self.lock:
            if self.stop_requested:
                return False
            self._admitted_episodes.add(identifier)
            return True

    def admitted_episode_ids(self):
        with self.lock:
            return tuple(self._admitted_episodes)

    def episode_succeeded(self, identifier):
        with self.lock:
            self._succeeded_episodes.add(identifier)

    def set_expected_chunks(self, count):
        if type(count) is not int or count < 0:
            raise ValueError("Expected chunks must be a nonnegative integer")
        with self.lock:
            self.expected_chunks = count

    def record_error(self, error, *, unresolved=False):
        with self.lock:
            message = str(error)[:400] or type(error).__name__
            if message not in self._errors:
                self._errors.append(message)
            # Keep the original operation failure visible when later polling,
            # cancellation or persistence contributes a secondary diagnostic.
            visible = self._errors if len(self._errors) < 3 else [*self._errors[:2], self._errors[-1]]
            self.error = "; ".join(visible)[:1200]
            self.unresolved = self.unresolved or unresolved

    def persistence_failed(self, error):
        with self.changed:
            self.persistence_error = str(error)[:400]
            self.record_error(error)
            self.changed.notify_all()

    def mark_requested_persisted(self):
        with self.changed:
            self.requested_persisted = True
            self.persistence_error = None
            self.changed.notify_all()

    def has_pending_receipts(self):
        with self.lock:
            return any(not value["settled"] for value in self._receipts.values())

    def wait_for_receipts(self):
        with self.changed:
            self.changed.wait_for(lambda: not self.has_pending_receipts())

    def marker(self, state):
        with self.lock:
            result = {
                "version": 1, "backend": "local", "project_id": self.project_id,
                "task_id": self.task_id, "graph_id": self.graph_id, "state": state,
                "requested_at": self.requested_at, "phase": self.phase,
                "expected_chunks": self.expected_chunks,
                "succeeded_chunks": len(self._succeeded_episodes),
                # This is expected minus observed ADMISSIONS, never successes.
                "unstarted_chunks": (None if self.expected_chunks is None else
                                     max(0, self.expected_chunks - len(self._admitted_episodes))),
            }
            if state == "stopped":
                result["settled_at"] = _now()
            if self.error:
                result["error"] = self.error
            return result

    def snapshot(self):
        with self.lock:
            state = ("completed" if self.completed else "unresolved" if
                     self.stop_requested and (self.unresolved or self.persistence_error or
                     (self.worker_done and self.has_pending_receipts())) else
                     "requested" if self.stop_requested else "running")
            return {"project_id": self.project_id, "task_id": self.task_id,
                    "state": state, "persisted": self.requested_persisted,
                    "can_stop": not self.completed and not self.stop_requested,
                    "error": self.error}


def valid_stop_marker(project):
    marker = getattr(project, "graph_build_stop", None)
    if not isinstance(marker, dict):
        return False
    if (type(marker.get("version")) is not int or marker["version"] != 1 or
            marker.get("backend") != "local" or
            marker.get("state") not in {"requested", "stopped", "unresolved"} or
            marker.get("task_id") != project.graph_build_task_id or
            not marker.get("task_id") or marker.get("graph_id") != project.graph_id or
            marker.get("project_id", project.project_id) != project.project_id or
            not isinstance(marker.get("requested_at"), str) or not marker["requested_at"]):
        return False
    for key in ("expected_chunks", "succeeded_chunks", "unstarted_chunks"):
        value = marker.get(key)
        if value is not None and (type(value) is not int or value < 0):
            return False
    status = getattr(project.status, "value", project.status)
    return status == ("graph_stopped" if marker["state"] == "stopped" else "graph_building")


def stop_reason(project):
    """Narrow new-marker policy; ordinary unmarked legacy/cloud stays eligible."""
    control = get_control(project.project_id)
    if control:
        with control.lock:
            state = control.snapshot()
            if control.stop_requested:
                if control.task_id != project.graph_build_task_id or not state["persisted"]:
                    return "graph_build_stop_unresolved"
                if state["state"] == "unresolved":
                    return "graph_build_stop_unresolved"
    marker = getattr(project, "graph_build_stop", None)
    if marker is not None:
        if not valid_stop_marker(project):
            return "graph_build_stop_unresolved"
        return {"requested": "graph_build_stopping", "stopped": "graph_build_stopped",
                "unresolved": "graph_build_stop_unresolved"}[marker["state"]]
    if getattr(project.status, "value", project.status) == "graph_stopped":
        return "graph_build_stop_unresolved"
    return None
