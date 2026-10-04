"""Bounded local preparation planning and explicit saved-artifact reuse.

Passive observations do not construct managers, reconcile saved state, or
initialize graph/model resources. Ownership is process-local, like the runner.
"""

import csv
import io
import json
import math
import os
import re
from contextlib import contextmanager
from datetime import datetime
from threading import Thread
from uuid import uuid4

from ..config import Config
from ..local_runtime.gateway import safe_integer
from ..models.task import TaskManager, TaskStatus
from ..models.project import ProjectManager
from ..storage import StoragePathError, storage_path, validate_record_id
from ..utils.persistence import write_json_atomic
from ..utils.logger import get_logger
from ..utils.locale import get_locale, set_locale
from ..utils.zep_lifecycle import graph_lifecycle_lock, register_graph_reader, unregister_graph_reader
from . import simulation_comparison as saved
from .simulation_manager import SimulationManager, SimulationStatus
from .simulation_runner import SimulationRunner
from .zep_graph_memory_updater import ZepGraphMemoryManager
from .zep_entity_reader import ZepEntityReader

MAX_REQUEST_BYTES = 256 * 1024
MAX_STATE_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
MAX_NODES = 5000
MAX_EDGES = 20000
MAX_CATALOG = 1000
MAX_PREVIEW_BYTES = 4 * 1024 * 1024
_ACTIVE_RUN = {"starting", "running", "paused", "stopping"}
_STATES = {"created", "preparing", "ready", "running", "stopping", "paused", "stopped", "completed", "failed"}
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
logger = get_logger("mirofish.preparation_plan")

_ERRORS = {
    "invalid_request": (400, "Use the supported JSON fields and no query parameters."),
    "invalid_simulation_id": (400, "The simulation ID is invalid."),
    "invalid_selection": (400, "Choose a nonempty, unique cast within the local agent limit."),
    "invalid_profile_mode": (400, "Profile generation must be a JSON boolean."),
    "invalid_concurrency": (400, "Profile concurrency must be an integer within the loaded local limit."),
    "invalid_graph_data": (400, "The graph contains invalid entity data."),
    "local_mode_required": (403, "Local run planning is available only in local mode."),
    "simulation_not_found": (404, "The saved simulation was not found."),
    "project_not_found": (404, "The simulation project was not found."),
    "preparation_busy": (409, "A preparation task still owns this simulation."),
    "run_busy": (409, "The simulation environment must finish before preparation."),
    "updater_busy": (409, "Graph memory updates must finish before preparation."),
    "lifecycle_busy": (409, "Simulation startup or finalization is still in progress."),
    "graph_busy": (409, "This graph is currently being built or updated."),
    "graph_changed": (409, "The project graph changed. Refresh the simulation."),
    "selection_changed": (409, "The selected cast changed. Load the cast again."),
    "existing_preparation": (409, "This simulation already has a saved preparation. Reuse it or create a new simulation."),
    "prepared_unavailable": (409, "The saved preparation is unavailable. It has not been regenerated."),
    "source_changed": (409, "Saved files changed while being read. Refresh and retry."),
    "ownership_unavailable": (409, "Simulation ownership could not be verified."),
    "request_too_large": (413, "The preparation request exceeds 256 KiB."),
    "source_too_large": (413, "A saved preparation source exceeds its size limit."),
    "graph_too_large": (413, "The graph exceeds the local planning scan limit."),
    "catalog_too_large": (413, "The graph has more than 1000 eligible entities."),
    "preview_too_large": (413, "The cast preview exceeds its response limit."),
    "invalid_configuration": (503, "The loaded local limits are invalid. Fix configuration and restart the backend."),
    "preview_unavailable": (503, "The local graph cast could not be loaded."),
    "preparation_unavailable": (500, "The preparation operation is unavailable."),
    "missing_artifacts": (409, "Required preparation files are missing."),
    "invalid_artifacts": (409, "Saved preparation files are invalid."),
    "unsafe_path": (409, "Saved preparation paths are unsafe."),
    "artifact_count_mismatch": (409, "Saved agent and profile counts disagree."),
    "agent_limit_exceeded": (409, "The saved cast exceeds the loaded local agent limit."),
}


class PlanningError(ValueError):
    def __init__(self, code):
        self.code = code if code in _ERRORS else "preparation_unavailable"
        self.status_code, message = _ERRORS[self.code]
        super().__init__(message)


def _reject_constant(value):
    raise ValueError("Nonfinite JSON")


def _object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _decode_json(payload):
    return json.loads(payload, parse_constant=_reject_constant, parse_float=saved._finite_float,
                      object_pairs_hook=_object_pairs)


def read_request(request):
    """Bound local bodies before inspecting either new or legacy fields."""
    if request.query_string or request.mimetype != "application/json":
        raise PlanningError("invalid_request")
    if request.content_length is not None and request.content_length > MAX_REQUEST_BYTES:
        raise PlanningError("request_too_large")
    try:
        body = request.stream.read(MAX_REQUEST_BYTES + 1)
        if len(body) > MAX_REQUEST_BYTES:
            raise PlanningError("request_too_large")
        data = _decode_json(body.decode("utf-8"))
        if type(data) is not dict:
            raise ValueError
        return data
    except PlanningError:
        raise
    except Exception:
        raise PlanningError("invalid_request") from None


def _identifier(value):
    try:
        return validate_record_id(value)
    except StoragePathError:
        raise PlanningError("invalid_simulation_id") from None


def limits():
    agents = safe_integer(Config.LOCAL_MAX_AGENTS)
    rounds = safe_integer(Config.LOCAL_MAX_ROUNDS)
    concurrency = safe_integer(Config.LOCAL_MAX_CONCURRENCY)
    return {"valid": all(value is not None for value in (agents, rounds, concurrency)),
            "max_agents": agents, "max_selectable_agents": min(agents, MAX_CATALOG) if agents else None,
            "max_rounds": rounds, "max_concurrency": concurrency, "max_catalog_entities": MAX_CATALOG}


def validate_planned_request(data):
    mode = data.get("preparation_mode")
    allowed = {"simulation_id", "preparation_mode"}
    if mode == "prepare":
        allowed |= {"selected_entity_ids", "use_llm_for_profiles", "parallel_profile_count"}
    if not isinstance(mode, str) or mode not in {"prepare", "reuse"} or set(data) - allowed:
        raise PlanningError("invalid_request")
    simulation_id = _identifier(data.get("simulation_id"))
    if not Config.LOCAL_MODE:
        raise PlanningError("local_mode_required")
    current = limits()
    if not current["valid"]:
        raise PlanningError("invalid_configuration")
    if mode == "reuse":
        return {"simulation_id": simulation_id, "preparation_mode": mode}
    ids = data.get("selected_entity_ids")
    if (type(ids) is not list or not 1 <= len(ids) <= current["max_selectable_agents"]
            or any(not isinstance(value, str) or _ID.fullmatch(value) is None for value in ids)
            or len(set(ids)) != len(ids)):
        raise PlanningError("invalid_selection")
    use_llm = data.get("use_llm_for_profiles")
    if type(use_llm) is not bool:
        raise PlanningError("invalid_profile_mode")
    concurrency = data.get("parallel_profile_count", min(3, current["max_concurrency"], len(ids)))
    if type(concurrency) is not int or not 1 <= concurrency <= current["max_concurrency"]:
        raise PlanningError("invalid_concurrency")
    return {"simulation_id": simulation_id, "preparation_mode": mode,
            "selected_entity_ids": list(ids), "use_llm_for_profiles": use_llm,
            "parallel_profile_count": min(concurrency, len(ids))}


def _path(simulation_id, filename, *, run=False):
    root = SimulationRunner.RUN_STATE_DIR if run else SimulationManager.SIMULATION_DATA_DIR
    try:
        return storage_path(root, _identifier(simulation_id), filename)
    except StoragePathError:
        raise PlanningError("unsafe_path") from None


def _read_file(path, maximum):
    try:
        with saved._open_source(path) as stream:
            if os.fstat(stream.fileno()).st_size > maximum:
                raise PlanningError("source_too_large")
            payload = stream.read(maximum + 1)
        if len(payload) > maximum:
            raise PlanningError("source_too_large")
        return payload.decode("utf-8")
    except FileNotFoundError:
        raise PlanningError("missing_artifacts") from None
    except PlanningError:
        raise
    except (OSError, ValueError, UnicodeError):
        raise PlanningError("invalid_artifacts") from None


def _read_json(path, maximum):
    try:
        return _decode_json(_read_file(path, maximum))
    except PlanningError:
        raise
    except (ValueError, RecursionError):
        raise PlanningError("invalid_artifacts") from None


def read_state(simulation_id):
    path = _path(simulation_id, "state.json")
    before = saved._fingerprint(path)
    try:
        state = _read_json(path, MAX_STATE_BYTES)
    except PlanningError as error:
        if error.code == "missing_artifacts":
            raise PlanningError("simulation_not_found") from None
        raise
    if saved._fingerprint(path) != before:
        raise PlanningError("source_changed")
    if (type(state) is not dict or not isinstance(state.get("status", "created"), str)
            or state.get("status", "created") not in _STATES
            or state.get("simulation_id", simulation_id) != simulation_id):
        raise PlanningError("invalid_artifacts")
    if any(key in state and type(state[key]) is not bool
           for key in ("enable_twitter", "enable_reddit", "profiles_generated", "config_generated")):
        raise PlanningError("invalid_artifacts")
    return state


def _configured_rounds(config):
    try:
        timing = config.get("time_config", {})
        hours, minutes = timing.get("total_simulation_hours"), timing.get("minutes_per_round")
        if any(type(value) not in {float, int} or not math.isfinite(value) or value <= 0
               for value in (hours, minutes)):
            return None
        return safe_integer(int(hours * 60 / minutes))
    except (ValueError, TypeError, OverflowError, AttributeError):
        return None


def inspect_artifacts(simulation_id, state, current_limits=None):
    unavailable = lambda code: {"available": False, "reason_code": code, "info": None}
    try:
        twitter, reddit = state.get("enable_twitter", True), state.get("enable_reddit", True)
        if type(twitter) is not bool or type(reddit) is not bool or not (twitter or reddit):
            raise PlanningError("invalid_artifacts")
        names = ["state.json", "simulation_config.json"]
        if reddit:
            names.append("reddit_profiles.json")
        if twitter:
            names.append("twitter_profiles.csv")
        paths = {name: _path(simulation_id, name) for name in names}
        before = saved._snapshot(paths)
        if _read_json(paths["state.json"], MAX_STATE_BYTES) != state:
            raise PlanningError("source_changed")
        config = _read_json(paths["simulation_config.json"], MAX_ARTIFACT_BYTES)
        if (type(config) is not dict or type(config.get("agent_configs")) is not list
                or config.get("simulation_id", simulation_id) != simulation_id):
            raise PlanningError("invalid_artifacts")
        agents = config["agent_configs"]
        if not agents or any(type(agent) is not dict for agent in agents):
            raise PlanningError("invalid_artifacts")
        counts = []
        if reddit:
            profiles = _read_json(paths["reddit_profiles.json"], MAX_ARTIFACT_BYTES)
            if type(profiles) is not list or not profiles or any(type(row) is not dict for row in profiles):
                raise PlanningError("invalid_artifacts")
            counts.append(len(profiles))
        if twitter:
            reader = csv.DictReader(io.StringIO(_read_file(paths["twitter_profiles.csv"], MAX_ARTIFACT_BYTES)))
            if not reader.fieldnames:
                raise PlanningError("invalid_artifacts")
            counts.append(sum(1 for _ in reader))
        if not counts or any(count <= 0 for count in counts):
            raise PlanningError("invalid_artifacts")
        for count in [*counts, state.get("entities_count"), state.get("profiles_count")]:
            if type(count) is not int or count != len(agents):
                raise PlanningError("artifact_count_mismatch")
        maximum = current_limits.get("max_agents") if current_limits else None
        if maximum is not None and len(agents) > maximum:
            raise PlanningError("agent_limit_exceeded")
        if (state.get("config_generated") is not True or state.get("profiles_generated") is not True
                or state.get("status") == "created"):
            raise PlanningError("prepared_unavailable")
        entity_types = state.get("entity_types", [])
        if type(entity_types) is not list or any(not isinstance(value, str) for value in entity_types):
            raise PlanningError("invalid_artifacts")
        if before != saved._snapshot(paths):
            raise PlanningError("source_changed")
        return {"available": True, "reason_code": None, "info": {
            "status": state.get("status"), "entities_count": len(agents), "profiles_count": counts[0],
            "entity_types": entity_types, "config_generated": True, "existing_files": names,
            "configured_rounds": _configured_rounds(config)}}
    except PlanningError as error:
        return unavailable(error.code)
    except (ValueError, OSError, csv.Error, RecursionError):
        return unavailable("invalid_artifacts")


def active_prepare_tasks(simulation_id):
    """Look at an existing task owner without creating a task manager."""
    manager = TaskManager._instance
    if manager is None:
        return []
    return [task for task in manager.list_tasks("simulation_prepare")
            if task["metadata"].get("simulation_id") == simulation_id
            and task["status"] in {"pending", "processing"}]


def _peek_updaters():
    lock = ZepGraphMemoryManager._lock
    if not lock.acquire(blocking=False):
        raise PlanningError("ownership_unavailable")
    try:
        return dict(ZepGraphMemoryManager._updaters)
    finally:
        lock.release()


def owner_locked(simulation_id, *, exclude_task_id=None):
    """Caller owns the runner finalization lock; no graph/client startup."""
    tasks = [task for task in active_prepare_tasks(simulation_id) if task["task_id"] != exclude_task_id]
    if tasks:
        return {"busy": True, "reason_code": "preparation_busy", "task_id": tasks[0]["task_id"]}
    reason = None
    if SimulationRunner.has_active_environment(simulation_id):
        reason = "run_busy"
    try:
        if _peek_updaters().get(simulation_id) is not None:
            reason = "updater_busy"
        run = SimulationRunner._run_states.get(simulation_id)
        if run and run.runner_status.value in _ACTIVE_RUN:
            reason = "run_busy"
        path = _path(simulation_id, "run_state.json", run=True)
        if os.path.lexists(path):
            raw = _read_json(path, MAX_STATE_BYTES)
            if (type(raw) is not dict or not isinstance(raw.get("runner_status"), str)
                    or raw.get("runner_status") not in _ACTIVE_RUN | {"idle", "completed", "stopped", "failed"}
                    or raw.get("simulation_id", simulation_id) != simulation_id):
                raise PlanningError("ownership_unavailable")
            if raw.get("runner_status") in _ACTIVE_RUN:
                reason = "run_busy"
    except PlanningError:
        reason = "ownership_unavailable"
    return {"busy": reason is not None, "reason_code": reason, "task_id": None}


@contextmanager
def admission_lock(simulation_id):
    lock = SimulationRunner._finalization_lock(_identifier(simulation_id))
    if not lock.acquire(blocking=False):
        raise PlanningError("lifecycle_busy")
    try:
        yield
    finally:
        lock.release()


def assert_idle_locked(simulation_id, *, exclude_task_id=None):
    owner = owner_locked(simulation_id, exclude_task_id=exclude_task_id)
    if owner["busy"]:
        raise PlanningError(owner["reason_code"])


def get_plan(simulation_id):
    simulation_id = _identifier(simulation_id)
    state = read_state(simulation_id)
    current = limits() if Config.LOCAL_MODE else None
    try:
        with admission_lock(simulation_id):
            owner = owner_locked(simulation_id)
    except PlanningError as error:
        owner = {"busy": True, "reason_code": error.code, "task_id": None}
    prepared = inspect_artifacts(simulation_id, state, current)
    allowed = Config.LOCAL_MODE and current["valid"] and not owner["busy"]
    return {"simulation_id": simulation_id, "mode": "local" if Config.LOCAL_MODE else "cloud",
            "status": state.get("status", "created"), "limits": current, "owner": owner,
            "prepared": prepared, "can_prepare": bool(allowed and not _previously_prepared(state)
                                                      and not prepared["available"]),
            "can_reuse": bool(allowed and prepared["available"])}


def reuse_preparation(simulation_id):
    with admission_lock(simulation_id):
        assert_idle_locked(simulation_id)
        state = read_state(simulation_id)
        prepared = inspect_artifacts(simulation_id, state, limits())
        if not prepared["available"]:
            raise PlanningError("prepared_unavailable")
        if state.get("status") != "ready" or state.get("error") is not None:
            state["status"] = "ready"
            state["error"] = None
            state["updated_at"] = datetime.now().isoformat()
            write_json_atomic(_path(simulation_id, "state.json"), state, logger=logger)
        prepared["info"]["status"] = "ready"
        return {"simulation_id": simulation_id, "status": "ready", "already_prepared": True,
                "prepare_info": prepared["info"]}


def planned_prepare(data):
    options = validate_planned_request(data)
    if options["preparation_mode"] == "reuse":
        return reuse_preparation(options["simulation_id"])
    simulation_id = options["simulation_id"]
    with admission_lock(simulation_id):
        assert_idle_locked(simulation_id)
        state = read_state(simulation_id)
        _validate_platforms(state)
        if _previously_prepared(state):
            raise PlanningError("existing_preparation")
        task_manager = TaskManager()
        task_id = task_manager.create_task("simulation_prepare", metadata={
            "simulation_id": simulation_id, "project_id": state.get("project_id"), "local_planned": True})

    lease = None
    lease_entered = False
    try:
        lease = _graph_lease(state, f"prepare:{simulation_id}:{task_id}")
        project = lease.__enter__()
        lease_entered = True
        selected = _read_entities(state, options["selected_entity_ids"])
        document = _read_document(state)
        current_locale = get_locale()

        def worker():
            set_locale(current_locale)
            failure = None
            result = None
            try:
                task_manager.update_task(task_id, status=TaskStatus.PROCESSING, message="Preparing the selected cast")
                refreshed = read_state(simulation_id)
                _project_for_graph(refreshed)
                if refreshed.get("graph_id") != state.get("graph_id"):
                    raise PlanningError("graph_changed")
                validate_planned_request(options)
                manager = SimulationManager()
                result = manager.prepare_simulation(
                    simulation_id=simulation_id, simulation_requirement=project["simulation_requirement"],
                    document_text=document, selected_entity_ids=options["selected_entity_ids"],
                    use_llm_for_profiles=options["use_llm_for_profiles"],
                    parallel_profile_count=options["parallel_profile_count"],
                    max_graph_nodes=MAX_NODES, max_graph_edges=MAX_EDGES,
                    progress_callback=_progress_callback(task_manager, task_id))
                if result.status == SimulationStatus.FAILED:
                    raise PlanningError("preparation_unavailable")
            except Exception as error:
                failure = _safe_failure(error)
                _save_failure(simulation_id, str(failure))
            finally:
                try:
                    lease.__exit__(None, None, None)
                except Exception:
                    # Keep the pending owner if a graph lease could not be
                    # released; claiming completion would permit unsafe reuse.
                    task_manager.update_task(task_id, error=str(PlanningError("preparation_unavailable")),
                                             message="Preparation cleanup could not finish")
                    return
                # The terminal task status is the ownership release. There
                # must be no state, artifact, or lease writes after this point.
                if failure is not None:
                    task_manager.fail_task(task_id, str(failure))
                else:
                    task_manager.complete_task(task_id, result=result.to_simple_dict())

        thread = Thread(target=worker, name=f"local-prepare-{simulation_id}", daemon=True)
        thread.start()
        return {"simulation_id": simulation_id, "task_id": task_id, "status": "preparing",
                "already_prepared": False, "expected_entities_count": selected.filtered_count,
                "entity_types": sorted(selected.entity_types), "selected_entity_ids": options["selected_entity_ids"]}
    except Exception as error:
        failure = _safe_failure(error)
        if lease_entered:
            try:
                lease.__exit__(None, None, None)
            except Exception:
                task_manager.update_task(task_id, error=str(PlanningError("preparation_unavailable")))
                raise PlanningError("preparation_unavailable") from None
        task_manager.fail_task(task_id, str(failure))
        raise failure from None


def _previously_prepared(state):
    return (state.get("config_generated") is True
            or state.get("status") in {"ready", "running", "paused", "stopping", "completed", "stopped"})


def _validate_platforms(state):
    twitter, reddit = state.get("enable_twitter", True), state.get("enable_reddit", True)
    if type(twitter) is not bool or type(reddit) is not bool or not (twitter or reddit):
        raise PlanningError("invalid_artifacts")


def _project_for_graph(state):
    try:
        project_id = validate_record_id(state.get("project_id"))
        graph_id = state.get("graph_id")
        if not isinstance(graph_id, str) or _ID.fullmatch(graph_id) is None:
            raise PlanningError("graph_changed")
        path = ProjectManager._get_project_meta_path(project_id)
        project = _read_json(path, MAX_STATE_BYTES)
    except StoragePathError:
        raise PlanningError("unsafe_path") from None
    except PlanningError as error:
        if error.code == "missing_artifacts":
            raise PlanningError("project_not_found") from None
        raise
    if type(project) is not dict or project.get("project_id", project_id) != project_id:
        raise PlanningError("invalid_artifacts")
    if project.get("graph_id") != graph_id:
        raise PlanningError("graph_changed")
    if project.get("status") == "graph_building":
        raise PlanningError("graph_busy")
    if not isinstance(project.get("simulation_requirement"), str) or not project["simulation_requirement"].strip():
        raise PlanningError("invalid_request")
    return project


def _read_document(state):
    try:
        return _read_file(ProjectManager._get_project_text_path(state["project_id"]), MAX_ARTIFACT_BYTES)
    except PlanningError as error:
        if error.code == "missing_artifacts":
            return ""
        raise


@contextmanager
def _graph_lease(state, reader_id):
    graph_id = state.get("graph_id")
    if not isinstance(graph_id, str) or _ID.fullmatch(graph_id) is None:
        raise PlanningError("graph_changed")
    lock = graph_lifecycle_lock(graph_id)
    if not lock.acquire(blocking=False):
        raise PlanningError("graph_busy")
    try:
        project = _project_for_graph(state)
        if any(updater.graph_id == graph_id for updater in _peek_updaters().values()):
            raise PlanningError("graph_busy")
        register_graph_reader(graph_id, reader_id)
    finally:
        lock.release()
    try:
        yield project
    finally:
        # Never called while holding a simulation finalization lock.
        unregister_graph_reader(graph_id, reader_id)


def _safe_failure(error):
    if isinstance(error, PlanningError):
        return error
    message = str(error)
    if message in {"Graph nodes exceed configured limit", "Graph edges exceed configured limit"}:
        return PlanningError("graph_too_large")
    if message == "Selected entities are unavailable or ineligible":
        return PlanningError("selection_changed")
    if message == "Graph entity records are invalid":
        return PlanningError("invalid_graph_data")
    if message == "Selected entity count exceeds configured limit":
        return PlanningError("invalid_selection")
    return PlanningError("preparation_unavailable")


def _read_entities(state, selected_ids=None):
    try:
        result = ZepEntityReader().filter_defined_entities(
            graph_id=state["graph_id"], enrich_with_edges=False,
            selected_entity_ids=selected_ids, max_nodes=MAX_NODES)
        if result.total_count > MAX_NODES:
            raise PlanningError("graph_too_large")
        return result
    except Exception as error:
        failure = _safe_failure(error)
        if failure.code == "preparation_unavailable":
            failure = PlanningError("preview_unavailable")
        raise failure from None


def preview_cast(data):
    if set(data) != {"simulation_id"}:
        raise PlanningError("invalid_request")
    simulation_id = _identifier(data["simulation_id"])
    if not Config.LOCAL_MODE:
        raise PlanningError("local_mode_required")
    current = limits()
    if not current["valid"]:
        raise PlanningError("invalid_configuration")
    with admission_lock(simulation_id):
        assert_idle_locked(simulation_id)
        state = read_state(simulation_id)
        _validate_platforms(state)
    # Preview has a read lease, not a simulation_prepare task to poll.
    with _graph_lease(state, f"preview:{simulation_id}:{uuid4().hex}"):
        filtered = _read_entities(state)
        if filtered.filtered_count > MAX_CATALOG:
            raise PlanningError("catalog_too_large")
        entities = []
        seen = set()
        for entity in filtered.entities:
            entity_type = entity.get_entity_type()
            if (not isinstance(entity.uuid, str) or _ID.fullmatch(entity.uuid) is None or entity.uuid in seen
                    or not isinstance(entity.name, str) or not isinstance(entity.summary, str)
                    or not isinstance(entity_type, str) or not entity_type.strip() or len(entity_type) > 128):
                raise PlanningError("invalid_graph_data")
            seen.add(entity.uuid)
            entities.append({"uuid": entity.uuid, "name": entity.name[:256], "entity_type": entity_type,
                             "summary": entity.summary[:240],
                             "text_truncated": len(entity.name) > 256 or len(entity.summary) > 240})
        entities.sort(key=lambda item: (item["name"], item["uuid"]))
        result = {"simulation_id": simulation_id, "graph_id": state["graph_id"],
                  "total_nodes": filtered.total_count, "eligible_count": filtered.filtered_count,
                  "entities": entities, "limits": current}
        if len(json.dumps(result, ensure_ascii=True, allow_nan=False).encode("utf-8")) > MAX_PREVIEW_BYTES:
            raise PlanningError("preview_too_large")
        return result


def _save_failure(simulation_id, message):
    try:
        manager = SimulationManager()
        state = manager.get_simulation(simulation_id)
        if state:
            state.status = SimulationStatus.FAILED
            state.error = message
            manager._save_simulation_state(state)
    except Exception:
        logger.warning("Could not persist preparation failure for %s", simulation_id)


def _progress_callback(task_manager, task_id):
    stages = {"reading": (0, 20), "generating_profiles": (20, 70),
              "generating_config": (70, 90), "copying_scripts": (90, 100)}
    def update(stage, progress, message, **kwargs):
        start, end = stages.get(stage, (0, 100))
        task_manager.update_task(task_id, progress=int(start + (end - start) * progress / 100),
                                 message=message, progress_detail={
            "current_stage": stage, "current_stage_name": stage,
            "stage_index": list(stages).index(stage) + 1 if stage in stages else 1,
            "total_stages": 4, "stage_progress": progress,
            "current_item": kwargs.get("current", 0), "total_items": kwargs.get("total", 0),
            "item_description": message})
    return update
