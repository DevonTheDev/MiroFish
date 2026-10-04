"""Owned local-preparation cancellation; only accepted requests persist a marker.

No graph, model, manager, or runner resources are initialized by observation.
The simulation admission lock protects registration and terminal release, while
one controller lock arbitrates cancellation versus final publication.
"""

from datetime import datetime, timezone
import json
import os
from threading import Event, RLock

from ..config import Config
from ..models.task import TaskManager
from ..utils.preparation_cancellation import PreparationCancelled
from ..utils.persistence import write_json_atomic
from ..utils.logger import get_logger

MAX_CANCEL_BYTES = 16 * 1024
MARKER_NAME = "preparation_cancellation.json"
_controllers = {}
_registry_lock = RLock()
logger = get_logger("mirofish.preparation_cancellation")


def _planner():
    from . import preparation_plan
    return preparation_plan


def _now():
    return datetime.now(timezone.utc).isoformat()


def _task(task_id):
    manager = TaskManager._instance
    return manager.get_task(task_id) if manager is not None else None


def _planned(task):
    return bool(task and task.task_type == "simulation_prepare"
                and task.metadata.get("local_planned") is True)


def read_request(request):
    planner = _planner()
    if request.query_string or request.mimetype != "application/json":
        raise planner.PlanningError("invalid_request")
    if request.content_length is not None and request.content_length > MAX_CANCEL_BYTES:
        raise planner.PlanningError("cancellation_request_too_large")
    try:
        body = request.stream.read(MAX_CANCEL_BYTES + 1)
        if len(body) > MAX_CANCEL_BYTES:
            raise planner.PlanningError("cancellation_request_too_large")
        data = planner._decode_json(body.decode("utf-8"))
        if type(data) is not dict or set(data) != {"simulation_id", "task_id"}:
            raise ValueError
        planner._identifier(data["simulation_id"])
        planner._identifier(data["task_id"])
        return data
    except planner.PlanningError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise planner.PlanningError("invalid_request") from None


def read_marker(simulation_id, *, run=False):
    """Return a validated bounded marker, failing closed on any uncertainty."""
    planner = _planner()
    try:
        path = planner._path(simulation_id, MARKER_NAME, run=run)
        if not os.path.lexists(path):
            return None
        before = planner.saved._fingerprint(path)
        marker = planner._read_json(path, MAX_CANCEL_BYTES)
        if planner.saved._fingerprint(path) != before:
            raise ValueError
        fields = {"schema_version", "simulation_id", "task_id", "phase", "requested_at", "updated_at", "progress"}
        if (type(marker) is not dict or set(marker) != fields
                or type(marker["schema_version"]) is not int or marker["schema_version"] != 1
                or marker["simulation_id"] != simulation_id
                or marker["phase"] not in {"cancelling", "cancelled"}
                or type(marker["progress"]) is not int or not 0 <= marker["progress"] <= 100):
            raise ValueError
        planner._identifier(marker["task_id"])
        for field in ("requested_at", "updated_at"):
            if not isinstance(marker[field], str) or len(marker[field]) > 64:
                raise ValueError
            if datetime.fromisoformat(marker[field]).tzinfo is None:
                raise ValueError
        return marker
    except (planner.PlanningError, ValueError, TypeError, KeyError, OSError):
        raise planner.PlanningError("cancellation_unavailable") from None


def assert_not_blocked(simulation_id, *, run=False):
    if read_marker(simulation_id, run=run) is not None:
        raise _planner().PlanningError("preparation_cancelled")


def _write_marker(marker):
    planner = _planner()
    if len(json.dumps(marker, allow_nan=False).encode("utf-8")) > MAX_CANCEL_BYTES:
        raise planner.PlanningError("cancellation_unavailable")
    write_json_atomic(planner._path(marker["simulation_id"], MARKER_NAME), marker, logger=logger)


class PreparationController:
    def __init__(self, simulation_id, task_id):
        self._simulation_id = simulation_id
        self._task_id = task_id
        self._lock = RLock()
        self._cancelled = Event()
        self.phase = "preparing"
        self.marker = None
        self.error_code = None

    @property
    def simulation_id(self):
        return self._simulation_id

    @property
    def task_id(self):
        return self._task_id

    @property
    def cancellation_requested(self):
        return self._cancelled.is_set()

    def checkpoint(self):
        with self._lock:
            if self._cancelled.is_set():
                raise PreparationCancelled()
            if self.phase == "unavailable":
                raise _planner().PlanningError("cancellation_unavailable")

    def begin_finalization(self):
        with self._lock:
            self.checkpoint()
            self.phase = "finalizing"

    def request_cancel(self):
        with self._lock:
            if self._cancelled.is_set():
                return True
            if self.phase != "preparing":
                return False
            task = _task(self.task_id)
            stamp = _now()
            marker = {"schema_version": 1, "simulation_id": self.simulation_id,
                      "task_id": self.task_id, "phase": "cancelling", "requested_at": stamp,
                      "updated_at": stamp, "progress": task.progress if task else 0}
            try:
                if read_marker(self.simulation_id) is not None:
                    raise _planner().PlanningError("cancellation_unavailable")
                _write_marker(marker)
            except Exception:
                self.block()
                raise _planner().PlanningError("cancellation_unavailable") from None
            self.marker = marker
            self._cancelled.set()
            self.phase = "cancelling"
            return True

    def block(self):
        with self._lock:
            self.phase = "unavailable"
            self.error_code = "cancellation_unavailable"

    def finish_marker(self):
        with self._lock:
            task = _task(self.task_id)
            if read_marker(self.simulation_id) != self.marker:
                raise _planner().PlanningError("cancellation_unavailable")
            marker = dict(self.marker, phase="cancelled", updated_at=_now(),
                          progress=task.progress if task else self.marker["progress"])
            _write_marker(marker)
            self.marker = marker


def register(simulation_id, task_id):
    controller = PreparationController(simulation_id, task_id)
    with _registry_lock:
        if task_id in _controllers or any(item.simulation_id == simulation_id for item in _controllers.values()):
            raise _planner().PlanningError("preparation_busy")
        _controllers[task_id] = controller
    return controller


def unregister(controller):
    """Call only after the task is terminal under the simulation admission lock."""
    with _registry_lock:
        if _controllers.get(controller.task_id) is controller:
            del _controllers[controller.task_id]


def get_controller(task_id):
    with _registry_lock:
        return _controllers.get(task_id)


def _live_for_simulation(simulation_id):
    with _registry_lock:
        return next((item for item in _controllers.values() if item.simulation_id == simulation_id), None)


def _projection(simulation_id, task_id, *, task=None, controller=None, marker=None):
    phase = "unavailable"
    state = "processing"
    progress = task.progress if task else marker["progress"] if marker else 0
    detail = task.progress_detail if task else {}
    message = task.message if task else "Preparation is unavailable. Create another simulation to try again."
    error_code = None
    requested = marker is not None
    can_cancel = False
    if task:
        state = task.status.value
        outcome = (task.result or {}).get("preparation_outcome")
        phase = ("cancelled" if outcome == "cancelled" else "ready" if state == "completed"
                 else "failed" if state == "failed" else "unavailable")
        error_code = (task.result or {}).get("error_code")
    if marker:
        phase = "cancelled" if marker["phase"] == "cancelled" else "unavailable"
    if controller:
        with controller._lock:
            phase = controller.phase
            requested = controller.cancellation_requested
            can_cancel = phase == "preparing" and not requested and Config.LOCAL_MODE
            error_code = controller.error_code or error_code
            if phase == "unavailable" and state not in {"pending", "processing"}:
                state = "processing"
    if phase == "cancelled":
        state, message = "cancelled", "Preparation cancelled. Partial files were kept; create another simulation to try again."
    elif phase == "cancelling":
        message = "Cancelling preparation after current work finishes."
    elif phase == "unavailable":
        error_code = error_code or "cancellation_unavailable"
        message = "Preparation cleanup is unavailable. Create another simulation to try again."
    result = {"simulation_id": simulation_id, "task_id": task_id, "status": state,
              "progress": progress, "message": message, "progress_detail": detail,
              "already_prepared": False, "preparation_phase": phase, "can_cancel": can_cancel,
              "cancellation_requested": requested}
    if error_code:
        result["error_code"] = error_code if error_code in _planner()._ERRORS else "preparation_unavailable"
    return result


def observe(simulation_id=None, task_id=None):
    """Return only an exact planned task, active simulation owner, or saved marker."""
    planner = _planner()
    task = _task(task_id) if task_id else None
    if task_id and task and simulation_id is not None and task.metadata.get("simulation_id") != simulation_id:
        raise planner.PlanningError("preparation_task_mismatch")
    if task_id:
        controller = get_controller(task_id)
        if controller and simulation_id is not None and controller.simulation_id != simulation_id:
            raise planner.PlanningError("preparation_task_mismatch")
        if controller:
            simulation_id = controller.simulation_id
        elif _planned(task):
            simulation_id = task.metadata.get("simulation_id")
    else:
        controller = _live_for_simulation(simulation_id)
        if controller:
            task_id = controller.task_id
            task = _task(task_id)
    if simulation_id is None:
        return None
    marker = read_marker(simulation_id)
    if marker and task_id and marker["task_id"] != task_id:
        raise planner.PlanningError("preparation_task_mismatch")
    if marker:
        task_id = marker["task_id"]
    if controller or _planned(task) or marker:
        return _projection(simulation_id, task_id, task=task if _planned(task) else None,
                           controller=controller, marker=marker)
    return None


def cancellation_state(simulation_id):
    try:
        marker = read_marker(simulation_id)
    except _planner().PlanningError:
        return {"blocked": True, "phase": "unavailable", "task_id": None,
                "reason_code": "cancellation_unavailable"}
    if marker:
        projection = observe(simulation_id)
        return {"blocked": True, "phase": projection["preparation_phase"],
                "task_id": marker["task_id"], "reason_code": "preparation_cancelled"}
    controller = _live_for_simulation(simulation_id)
    if controller and controller.phase == "unavailable":
        return {"blocked": True, "phase": "unavailable", "task_id": controller.task_id,
                "reason_code": "cancellation_unavailable"}
    return {"blocked": False, "phase": None, "task_id": None, "reason_code": None}


def cancel(data):
    planner = _planner()
    if not Config.LOCAL_MODE:
        raise planner.PlanningError("local_mode_required")
    simulation_id, task_id = data["simulation_id"], data["task_id"]
    controller = get_controller(task_id)
    task = _task(task_id)
    if controller:
        # Registration is exclusive to planned tasks. Its immutable identity
        # remains authoritative if a partially terminal task record is evicted.
        if controller.simulation_id != simulation_id:
            raise planner.PlanningError("preparation_task_mismatch")
        accepted = controller.request_cancel()
        return {"accepted": accepted, **observe(simulation_id, task_id)}
    marker = read_marker(simulation_id)
    if marker and marker["task_id"] == task_id:
        return {"accepted": True, **observe(simulation_id, task_id)}
    if _planned(task) and task.metadata.get("simulation_id") == simulation_id:
        return {"accepted": False, **observe(simulation_id, task_id)}
    raise planner.PlanningError("preparation_task_mismatch")
