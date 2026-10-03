"""Explicit, bounded local capability checks with passive, redacted observations.

One owned async worker is admitted at a time. A stop request only prevents later
checks; shutdown additionally cancels owned awaits. Neither path closes the
process-shared inference gateway. Optional clients are imported only by a run.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from importlib.metadata import version as _installed_version
import math
import os
import threading
import time
from uuid import uuid4

from ..config import Config
from ..shutdown import register_shutdown_callback


STEP_IDS = ("configuration", "dependencies", "database", "gateway", "json_output",
            "json_schema", "tool_call", "embedding", "cleanup")
RUN_STATES = ("running", "stopping", "passed", "failed", "cancelled", "timed_out")
STEP_STATES = ("pending", "running", "passed", "failed", "timed_out", "skipped")
STEP_CODES = (
    "ok", "invalid_configuration", "dependency_unavailable", "database_unavailable",
    "invalid_database_response", "gateway_unavailable", "gateway_unsupported", "gateway_busy",
    "model_unavailable", "capability_unsupported", "embedding_invalid", "step_timeout",
    "budget_exhausted", "prerequisite_failed", "stopped", "cleanup_failed", "internal_failure",
)
_DEFAULT_BUDGETS = {"overall_ms": 300000, "model_step_ms": 60000,
                    "database_step_ms": 10000, "gateway_step_ms": 5000, "cleanup_ms": 10000}
# Internal test injection may lower these values, never increase public budgets.
_BUDGETS = dict(_DEFAULT_BUDGETS)
_DRAIN_SECONDS = 1.0
_PACKAGES = ("camel-ai", "camel-oasis", "graphiti-core", "neo4j", "openai")
_CONFIG_FIELDS = (
    "MEMORY_BACKEND", "LOCAL_MODE", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL_NAME",
    "LOCAL_EMBEDDING_BASE_URL", "LOCAL_EMBEDDING_MODEL", "LOCAL_EMBEDDING_DIMENSIONS",
    "LOCAL_GRAPH_URI", "LOCAL_GRAPH_USER", "LOCAL_GRAPH_PASSWORD", "LOCAL_GRAPH_DATABASE",
    "LOCAL_MAX_AGENT_ITERATIONS", "LOCAL_MAX_AGENTS", "LOCAL_MAX_ROUNDS", "LOCAL_MAX_CONCURRENCY",
    "LOCAL_MAX_QUEUE", "LOCAL_REQUEST_TIMEOUT", "LOCAL_REASONING_EFFORT", "LOCAL_MAX_OUTPUT_TOKENS",
    "LOCAL_CONTEXT_TOKENS", "LOCAL_MAX_INPUT_CHARS", "DEBUG", "ZEP_API_KEY",
)
_GATEWAY_FIELDS = ("LOCAL_MODE", "LLM_BASE_URL", "LOCAL_EMBEDDING_BASE_URL",
                   "LOCAL_MAX_CONCURRENCY", "LOCAL_MAX_QUEUE", "LOCAL_REQUEST_TIMEOUT",
                   "LOCAL_MAX_OUTPUT_TOKENS", "LOCAL_MAX_INPUT_CHARS", "LOCAL_REASONING_EFFORT")
_ERROR_MESSAGES = {
    "local_mode_required": "Local readiness requires local mode.",
    "already_running": "A local readiness check is already running or stopping.",
    "run_not_found": "The local readiness check was not found.",
    "readiness_unavailable": "Local readiness is unavailable until the backend restarts.",
    "internal_failure": "The local readiness check could not be started.",
}
_owner_pid = os.getpid()
_lock = threading.Lock()
_manager = None
_closing = False
_cleanup_failed = False


class ReadinessError(Exception):
    """Fixed safe service errors; never retain a dependency exception."""

    def __init__(self, code, status_code, snapshot=None):
        self.code = code if code in _ERROR_MESSAGES else "internal_failure"
        self.status_code = status_code
        self.snapshot = snapshot
        super().__init__(_ERROR_MESSAGES[self.code])


class _ProbeFailure(Exception):
    def __init__(self, code):
        self.code = code


def _utc():
    return datetime.now(timezone.utc).isoformat()


def _milliseconds(seconds):
    return min(2**53 - 1, max(0, int(seconds * 1000)))


def _budgets():
    return {key: min(maximum, max(1, value)) if type(value := _BUDGETS.get(key)) is int else maximum
            for key, maximum in _DEFAULT_BUDGETS.items()}


def _unavailable():
    if not Config.LOCAL_MODE:
        return "local_mode_required"
    if _owner_pid != os.getpid():
        return "inherited_process"
    if _cleanup_failed:
        return "cleanup_failed"
    return "backend_closing" if _closing else None


def _snapshot_locked():
    unavailable = _unavailable()
    return {
        "schema_version": 1, "kind": "mirofish_local_readiness", "observed_at": _utc(),
        "mode": "local" if Config.LOCAL_MODE else "cloud",
        "available": unavailable is None, "unavailable_code": unavailable,
        "run": _manager.snapshot() if _manager is not None and Config.LOCAL_MODE else None,
    }


def get_readiness_snapshot():
    """Observe existing scalars only; never create a manager or validate config."""
    if _owner_pid != os.getpid():
        return {"schema_version": 1, "kind": "mirofish_local_readiness", "observed_at": _utc(),
                "mode": "local" if Config.LOCAL_MODE else "cloud", "available": False,
                "unavailable_code": "inherited_process" if Config.LOCAL_MODE else "local_mode_required",
                "run": None}
    with _lock:
        return _snapshot_locked()


def _guard_process():
    if not Config.LOCAL_MODE:
        raise ReadinessError("local_mode_required", 403)
    if _owner_pid != os.getpid():
        raise ReadinessError("readiness_unavailable", 503)


def register_readiness_shutdown():
    """Register ownership only, without work or optional imports."""
    if _owner_pid == os.getpid():
        register_shutdown_callback("readiness", close_readiness_manager)


def start_readiness_check():
    """Admit one explicit check; retain only the latest completed run."""
    global _manager
    _guard_process()
    with _lock:
        if _unavailable() is not None:
            raise ReadinessError("readiness_unavailable", 503, _snapshot_locked())
        if _manager is not None and (_manager.active or _manager.thread.is_alive()):
            raise ReadinessError("already_running", 409, _snapshot_locked())
        register_readiness_shutdown()
        try:
            candidate = _Run()
            candidate.thread.start()
        except Exception:
            raise ReadinessError("internal_failure", 500) from None
        _manager = candidate
        return _snapshot_locked()


def cancel_readiness_check(run_id):
    """Prevent subsequent probes; an already-running bounded probe may finish."""
    _guard_process()
    with _lock:
        if _manager is None or _manager.data["id"] != run_id:
            raise ReadinessError("run_not_found", 404)
        if _manager.active:
            _manager.data["cancel_requested"] = True
            _manager.data["state"] = "stopping"
        return _snapshot_locked()


def close_readiness_manager():
    """Permanently stop admission and bound cancellation, cleanup and drain."""
    global _closing, _cleanup_failed
    # In a fork the inherited lock, thread and event loop must not be touched.
    if _owner_pid != os.getpid():
        return
    with _lock:
        _closing = True
        owner = _manager
        if owner is None or not owner.active:
            return
        owner.data["cancel_requested"] = True
        owner.data["state"] = "stopping"
        loop, task = owner.loop, owner.task
        cleaning = owner.data["current_step"] == "cleanup"
    if loop is not None and task is not None and not cleaning:
        def cancel_operation():
            # The worker can enter cleanup between the caller's observation and
            # this event-loop callback. Never cancel already-started cleanup.
            with _lock:
                if (owner.active and owner.task is task and not owner.cleaning
                        and owner.data["current_step"] != "cleanup"):
                    task.cancel()
        try:
            loop.call_soon_threadsafe(cancel_operation)
        except RuntimeError:
            pass
    if owner.thread is threading.current_thread():
        return
    owner.thread.join(owner.budgets["cleanup_ms"] / 1000 + _DRAIN_SECONDS + 0.25)
    if owner.thread.is_alive():
        with _lock:
            _cleanup_failed = True
            owner.sealed = True
            owner.finish(cleanup_failed=True)


class _Run:
    def __init__(self):
        from .status import _configuration

        self.budgets = _budgets()
        self.started = time.monotonic()
        self.deadline = self.started + self.budgets["overall_ms"] / 1000
        captured = {name: getattr(Config, name) for name in _CONFIG_FIELDS}
        self.config = type("CapturedReadinessConfig", (Config,), captured)
        self.gateway_environment = os.environ.get("MIROFISH_LOCAL_GATEWAY_URL")
        try:
            projection = _configuration()
        except Exception:
            projection = {}
        self.config_valid = projection.get("valid") is True
        self.data = {
            "id": str(uuid4()), "state": "running", "started_at": _utc(), "finished_at": None,
            "elapsed_ms": 0, "current_step": None, "budget": dict(self.budgets),
            "configuration": {key: projection.get(key) for key in
                              ("chat_model", "embedding_model", "embedding_dimensions")},
            "cancel_requested": False,
            "steps": [{"id": identifier, "state": "pending", "code": None, "duration_ms": None}
                      for identifier in STEP_IDS],
        }
        self.steps = {step["id"]: step for step in self.data["steps"]}
        self.active = True
        self.sealed = False
        self.loop = self.task = None
        self.resources = []
        self.cleaning = False
        self.pending = set()
        self.client = self.http = None
        self.thread = threading.Thread(target=self.worker, name="local-readiness", daemon=True)

    def snapshot(self):
        result = deepcopy(self.data)
        if self.active and not self.sealed:
            result["elapsed_ms"] = _milliseconds(time.monotonic() - self.started)
        return result

    def stopped(self):
        with _lock:
            if self.data["cancel_requested"] or _closing:
                return "stopped"
        return "budget_exhausted" if time.monotonic() >= self.deadline else None

    def update_step(self, identifier, state, code=None, duration=None):
        with _lock:
            if self.sealed:
                return False
            if state == "running" and identifier != "cleanup":
                # Step admission and its visible running state are one atomic
                # decision relative to a concurrent accepted stop request.
                if self.data["cancel_requested"] or _closing or time.monotonic() >= self.deadline:
                    return False
            self.steps[identifier].update(state=state, code=code, duration_ms=duration)
            self.data["current_step"] = identifier if state == "running" else None
            return True

    def skip_pending(self, reason):
        with _lock:
            if self.sealed:
                return
            for step in self.data["steps"]:
                if step["state"] == "pending" and step["id"] != "cleanup":
                    step.update(state="skipped", code=reason, duration_ms=0)

    async def bounded(self, operation, seconds):
        """Cancellation-resistant dependencies cannot turn wait_for into infinity."""
        task = asyncio.create_task(operation)
        self.pending.add(task)
        try:
            done, _ = await asyncio.wait({task}, timeout=max(0, seconds))
            if not done:
                task.cancel()
                raise TimeoutError
            return task.result()
        except asyncio.CancelledError:
            task.cancel()
            raise
        finally:
            if task.done():
                self.pending.discard(task)

    async def run_step(self, identifier, operation, limit):
        reason = self.stopped()
        if reason:
            self.skip_pending(reason)
            return False
        started = time.monotonic()
        deadline = min(self.deadline, started + limit)
        if not self.update_step(identifier, "running"):
            self.skip_pending(self.stopped() or "stopped")
            return False
        state, code = "passed", "ok"
        try:
            await self.bounded(operation(deadline), deadline - time.monotonic())
            if time.monotonic() > deadline:
                raise TimeoutError
        except asyncio.CancelledError:
            self.update_step(identifier, "skipped", "stopped", _milliseconds(time.monotonic() - started))
            raise
        except TimeoutError:
            state, code = "timed_out", "budget_exhausted" if time.monotonic() >= self.deadline else "step_timeout"
        except _ProbeFailure as exc:
            state, code = "failed", exc.code
        except Exception as exc:
            state, code = "failed", self.error_code(identifier, exc)
            if code == "step_timeout":
                state = "timed_out"
        self.update_step(identifier, state, code, _milliseconds(time.monotonic() - started))
        return state == "passed"

    def error_code(self, identifier, error):
        if identifier == "configuration":
            return "invalid_configuration"
        if identifier == "dependencies":
            return "dependency_unavailable"
        if identifier == "database":
            return "database_unavailable"
        status = getattr(error, "status_code", None)
        if type(status) is int:
            if status in (408, 504):
                return "step_timeout"
            if status == 429:
                return "gateway_busy"
            if status in (400, 422):
                return "embedding_invalid" if identifier == "embedding" else "capability_unsupported"
        if isinstance(error, (self.openai.APITimeoutError, self.httpx.TimeoutException)):
            return "step_timeout"
        return "gateway_unavailable" if identifier == "gateway" else "model_unavailable"

    async def configuration(self, deadline):
        if not self.config_valid or self.config.validate():
            raise _ProbeFailure("invalid_configuration")

    async def dependencies(self, deadline):
        for package in _PACKAGES:
            _installed_version(package)
        import httpx
        import neo4j
        import openai
        self.httpx, self.neo4j, self.openai = httpx, neo4j, openai

    async def database(self, deadline):
        remaining = max(0.001, deadline - time.monotonic())
        auth = ((self.config.LOCAL_GRAPH_USER, self.config.LOCAL_GRAPH_PASSWORD)
                if self.config.LOCAL_GRAPH_PASSWORD else None)
        driver = self.neo4j.AsyncGraphDatabase.driver(
            self.config.LOCAL_GRAPH_URI, auth=auth, max_connection_pool_size=1,
            connection_timeout=remaining, connection_acquisition_timeout=remaining,
            max_transaction_retry_time=0,
        )
        self.resources.append(driver.close)
        async with driver.session(database=self.config.LOCAL_GRAPH_DATABASE,
                                  default_access_mode=self.neo4j.READ_ACCESS) as session:
            result = await session.run(self.neo4j.Query("RETURN 1 AS ready", timeout=remaining))
            record = await result.single(strict=True)
            value = record["ready"] if record is not None else None
            if type(value) is not int or value != 1:
                raise _ProbeFailure("invalid_database_response")

    async def gateway(self, deadline):
        from . import get_local_gateway_url
        from .gateway import DEADLINE_CAP_HEADER, validate_loopback_url

        if (any(getattr(Config, key) != getattr(self.config, key) for key in _GATEWAY_FIELDS)
                or os.environ.get("MIROFISH_LOCAL_GATEWAY_URL") != self.gateway_environment):
            raise _ProbeFailure("invalid_configuration")
        base_url = validate_loopback_url(get_local_gateway_url(deadline_monotonic=deadline))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        self.http = self.httpx.AsyncClient(trust_env=False, follow_redirects=False)
        self.resources.append(self.http.aclose)
        url = base_url.rstrip("/").removesuffix("/v1") + "/health"
        async with self.http.stream("GET", url, timeout=remaining) as response:
            if response.status_code != 200:
                raise _ProbeFailure("gateway_unavailable")
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > 8192:
                    raise _ProbeFailure("gateway_unsupported")
        try:
            import json
            health = json.loads(raw)
            supported = (isinstance(health, dict) and health.get("status") == "ok"
                         and health.get("service") == "local-inference-gateway"
                         and health.get("request_deadline_cap") == DEADLINE_CAP_HEADER)
        except (ValueError, UnicodeError):
            supported = False
        if not supported:
            raise _ProbeFailure("gateway_unsupported")
        # A cancellation-resistant health response must not create a new owner
        # after cleanup has captured the resources it must close.
        if self.cleaning or self.sealed or time.monotonic() >= deadline:
            raise TimeoutError
        self.client = self.openai.AsyncOpenAI(api_key="local", base_url=base_url, max_retries=0,
                                             http_client=self.http, timeout=self.budgets["model_step_ms"] / 1000)
        self.resources.append(self.client.close)

    async def model(self, identifier, deadline):
        from .doctor import probe_request, validate_probe_response
        from .gateway import DEADLINE_CAP_HEADER

        operation, kwargs = probe_request(identifier, model=self.config.LLM_MODEL_NAME,
                                           embedding_model=self.config.LOCAL_EMBEDDING_MODEL)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        kwargs.update(timeout=remaining, extra_headers={DEADLINE_CAP_HEADER: str(max(1, math.floor(remaining * 1000)))})
        create = self.client.chat.completions.create if operation == "chat" else self.client.embeddings.create
        response = await create(**kwargs)
        try:
            validate_probe_response(identifier, response, embedding_dimensions=self.config.LOCAL_EMBEDDING_DIMENSIONS)
        except Exception:
            raise _ProbeFailure("embedding_invalid" if identifier == "embedding" else "capability_unsupported") from None

    async def cleanup(self):
        self.cleaning = True
        started = time.monotonic()
        self.update_step("cleanup", "running")
        # Begin every close even if another resource fails; no shared gateway close.
        async def close(resource):
            try:
                await resource()
                return True
            except BaseException:
                return False

        tasks = {asyncio.create_task(close(resource)) for resource in reversed(self.resources)}
        for task in self.pending:
            if not task.done():
                task.cancel()
        all_tasks = tasks | self.pending
        okay = True
        if all_tasks:
            try:
                done, pending = await asyncio.wait(all_tasks, timeout=self.budgets["cleanup_ms"] / 1000)
                okay = not pending
                for task in done:
                    if task in tasks:
                        okay = task.result() is True and okay
                    elif not task.cancelled():
                        task.exception()  # Consume late errors without logging their content.
                for task in pending:
                    task.cancel()
                self.pending = pending
            except asyncio.CancelledError:
                for task in all_tasks:
                    task.cancel()
                self.pending = all_tasks
                okay = False
        self.update_step("cleanup", "passed" if okay else "failed", "ok" if okay else "cleanup_failed",
                         _milliseconds(time.monotonic() - started))
        return okay

    async def execute(self):
        try:
            valid = await self.run_step("configuration", self.configuration, self.budgets["overall_ms"] / 1000)
            if valid:
                valid = await self.run_step("dependencies", self.dependencies, self.budgets["overall_ms"] / 1000)
            if valid:
                await self.run_step("database", self.database, self.budgets["database_step_ms"] / 1000)
                ready = await self.run_step("gateway", self.gateway, self.budgets["gateway_step_ms"] / 1000)
                if ready:
                    for identifier in STEP_IDS[4:8]:
                        await self.run_step(identifier, lambda deadline, identifier=identifier: self.model(identifier, deadline),
                                            self.budgets["model_step_ms"] / 1000)
            self.skip_pending(self.stopped() or "prerequisite_failed")
        except asyncio.CancelledError:
            self.skip_pending("stopped")
        except Exception:
            with _lock:
                current = self.data["current_step"]
            if current:
                self.update_step(current, "failed", "internal_failure", 0)
            self.skip_pending("prerequisite_failed")
        return await self.cleanup()

    async def drain(self):
        pending = {task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()}
        for task in pending:
            task.cancel()
        if not pending:
            return True
        done, pending = await asyncio.wait(pending, timeout=_DRAIN_SECONDS)
        for task in done:
            if not task.cancelled():
                task.exception()
        return not pending

    def finish(self, cleanup_failed=False):
        global _cleanup_failed
        if cleanup_failed:
            _cleanup_failed = True
            self.steps["cleanup"].update(state="failed", code="cleanup_failed", duration_ms=0)
        for step in self.data["steps"]:
            if step["state"] in ("pending", "running") and step["id"] != "cleanup":
                step.update(state="skipped", code="stopped" if self.data["cancel_requested"] else "prerequisite_failed",
                            duration_ms=0)
        states = [step["state"] for step in self.data["steps"]]
        if cleanup_failed or self.steps["cleanup"]["state"] != "passed":
            state = "failed"
        elif self.data["cancel_requested"]:
            state = "cancelled"
        elif "timed_out" in states or any(step["code"] == "budget_exhausted" for step in self.data["steps"]):
            state = "timed_out"
        elif all(value == "passed" for value in states):
            state = "passed"
        else:
            state = "failed"
        self.data.update(state=state, current_step=None, finished_at=_utc(),
                         elapsed_ms=_milliseconds(time.monotonic() - self.started))
        self.active = False

    def worker(self):
        okay = False
        try:
            loop = asyncio.new_event_loop()
            # Dependency exception representations may contain credentials or URLs.
            loop.set_exception_handler(lambda *_args: None)
            asyncio.set_event_loop(loop)
            with _lock:
                self.loop = loop
                self.task = loop.create_task(self.execute())
            okay = loop.run_until_complete(self.task)
            okay = loop.run_until_complete(self.drain()) and okay
        except BaseException:
            okay = False
        finally:
            if self.loop is not None:
                self.loop.close()
            with _lock:
                if not self.sealed:
                    self.finish(cleanup_failed=not okay)
