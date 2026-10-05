"""One explicit bounded text completion, using the shared local gateway.

Only the latest run is retained in memory. Passive reads never start a worker,
probe a server, open graph memory, or contact the model. Shutdown owns only this
worker and its HTTP client; the shared gateway has a later shutdown phase.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
import threading
import time
import unicodedata
from uuid import UUID, uuid4

from ..config import Config
from ..shutdown import register_shutdown_callback

MAX_BODY_BYTES = 32768
MAX_CANCEL_BODY_BYTES = 1024
MAX_RESPONSE_BYTES = 65536
MAX_OUTPUT_CHARS = 16384
MAX_SAFE_INTEGER = 2**53 - 1
_DEFAULT_BUDGETS = {"gateway_startup_ms": 5000, "request_ms": 60000,
                    "overall_ms": 65000, "cleanup_ms": 10000}
_BUDGETS = dict(_DEFAULT_BUDGETS)
_DRAIN_SECONDS = 1.0
_CONFIG_FIELDS = ("LOCAL_MODE", "LLM_BASE_URL", "LLM_MODEL_NAME", "LOCAL_EMBEDDING_BASE_URL",
                  "LOCAL_MAX_CONCURRENCY", "LOCAL_MAX_QUEUE", "LOCAL_REQUEST_TIMEOUT",
                  "LOCAL_MAX_OUTPUT_TOKENS", "LOCAL_MAX_INPUT_CHARS", "LOCAL_REASONING_EFFORT",
                  "LOCAL_CONTEXT_TOKENS")
_ERROR_MESSAGES = {
    "invalid_request": "The prompt trial request is invalid.",
    "local_mode_required": "Prompt trials require local mode.",
    "already_running": "A prompt trial is already running.",
    "request_conflict": "This request ID already belongs to different inputs.",
    "run_not_found": "This prompt trial is no longer available.",
    "trials_unavailable": "Prompt trials are unavailable until the backend restarts.",
    "invalid_configuration": "The loaded local model configuration is unavailable.",
    "internal_failure": "The prompt trial could not be started.",
}
_owner_pid = os.getpid()
_lock = threading.Lock()
_manager = None
_closing = False
_cleanup_failed = False


class PromptTrialError(Exception):
    def __init__(self, code, status_code, snapshot=None):
        self.code = code if code in _ERROR_MESSAGES else "internal_failure"
        self.status_code, self.snapshot = status_code, snapshot
        super().__init__(_ERROR_MESSAGES[self.code])


class _TrialFailure(Exception):
    def __init__(self, code):
        self.code = code


def _utc():
    return datetime.now(timezone.utc).isoformat()


def _milliseconds(seconds):
    return min(MAX_SAFE_INTEGER, max(0, int(seconds * 1000)))


def _budgets():
    return {key: min(maximum, max(1, value)) if type(value := _BUDGETS.get(key)) is int else maximum
            for key, maximum in _DEFAULT_BUDGETS.items()}


def valid_uuid(value):
    try:
        return type(value) is str and len(value) == 36 and str(UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def _text(value, maximum, *, blank=False, prompt=False):
    if type(value) is not str or len(value) > maximum:
        return False
    # JavaScript trim treats BOM as whitespace. Match that blank-input boundary
    # without stripping or otherwise rewriting any accepted prompt text.
    if not blank and all(char.isspace() or char == "\ufeff" for char in value):
        return False
    return not any((unicodedata.category(char) in ("Cc", "Cs")
                    and not (prompt and char in "\r\n\t")) or
                   (not prompt and unicodedata.category(char).startswith("C")) for char in value)


def normalize_request(value):
    """Canonicalize inputs without consulting mutable loaded configuration."""
    fields = {"request_id", "label", "system_prompt", "user_prompt", "temperature", "max_output_tokens"}
    if (type(value) is not dict or set(value) != fields or not valid_uuid(value["request_id"])
            or not _text(value["label"], 80)
            or not _text(value["system_prompt"], 1000, blank=True, prompt=True)
            or not _text(value["user_prompt"], 4000, prompt=True)
            or type(value["temperature"]) not in (int, float)
            or not 0 <= value["temperature"] <= 1
            or not math.isfinite(value["temperature"])
            or type(value["max_output_tokens"]) is not int
            or not 1 <= value["max_output_tokens"] <= 512):
        raise PromptTrialError("invalid_request", 400)
    result = dict(value)
    result["temperature"] = float(value["temperature"]) or 0.0
    return result


def _fingerprint(value):
    body = {key: item for key, item in value.items() if key != "request_id"}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def normalize_cancellation(value):
    if (type(value) is not dict or set(value) != {"instance_id", "fingerprint"}
            or not valid_uuid(value["instance_id"])
            or type(value["fingerprint"]) is not str or len(value["fingerprint"]) != 64
            or any(char not in "0123456789abcdef" for char in value["fingerprint"])):
        raise PromptTrialError("invalid_request", 400)
    return dict(value)


def _configuration():
    """Validate loaded primitives only; never call Config.validate or probe I/O."""
    from .gateway import GatewaySettings, validate_loopback_url
    from urllib.parse import urlsplit

    try:
        model, reasoning = Config.LLM_MODEL_NAME, Config.LOCAL_REASONING_EFFORT
        if (not _text(model, 256) or model != model.strip() or "://" in model
                or model.lower().endswith((":cloud", "-cloud"))):
            return None
        if reasoning is not None and (not _text(reasoning, 64) or reasoning != reasoning.strip()):
            return None
        for name in ("LOCAL_MAX_CONCURRENCY", "LOCAL_MAX_OUTPUT_TOKENS", "LOCAL_MAX_INPUT_CHARS", "LOCAL_CONTEXT_TOKENS"):
            if type(getattr(Config, name)) is not int or not 1 <= getattr(Config, name) <= MAX_SAFE_INTEGER:
                return None
        if (type(Config.LOCAL_MAX_QUEUE) is not int or not 0 <= Config.LOCAL_MAX_QUEUE <= MAX_SAFE_INTEGER
                or Config.LOCAL_MAX_OUTPUT_TOKENS >= Config.LOCAL_CONTEXT_TOKENS):
            return None
        settings = GatewaySettings(llm_base_url=Config.LLM_BASE_URL,
                                   embedding_base_url=Config.LOCAL_EMBEDDING_BASE_URL,
                                   max_concurrency=Config.LOCAL_MAX_CONCURRENCY, max_queue=Config.LOCAL_MAX_QUEUE,
                                   request_timeout=Config.LOCAL_REQUEST_TIMEOUT,
                                   max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
                                   max_input_chars=Config.LOCAL_MAX_INPUT_CHARS, reasoning_effort=reasoning)
        inherited = os.environ.get("MIROFISH_LOCAL_GATEWAY_URL")
        if inherited and (len(inherited) > 2048 or urlsplit(validate_loopback_url(inherited)).path not in ("", "/v1")):
            return None
        return {"model": model, "reasoning_effort": reasoning, "max_output_tokens": min(512, settings.max_output_tokens)}
    except (TypeError, ValueError, OverflowError):
        return None


def _unavailable(configuration):
    if not Config.LOCAL_MODE:
        return "local_mode_required"
    if _owner_pid != os.getpid():
        return "inherited_process"
    if configuration is None:
        return "invalid_configuration"
    if _cleanup_failed:
        return "cleanup_failed"
    return "backend_closing" if _closing else None


def _snapshot_locked():
    config = _configuration() if Config.LOCAL_MODE else None
    unavailable = _unavailable(config)
    return {"schema_version": 1, "kind": "mirofish_local_prompt_trials", "observed_at": _utc(),
            "mode": "local" if Config.LOCAL_MODE else "cloud", "available": unavailable is None,
            "unavailable_code": unavailable,
            "limits": {"max_body_bytes": MAX_BODY_BYTES, "label_chars": 80, "system_prompt_chars": 1000,
                       "user_prompt_chars": 4000, "max_output_tokens": config["max_output_tokens"] if config else None,
                       "response_bytes": MAX_RESPONSE_BYTES, "retained_output_chars": MAX_OUTPUT_CHARS,
                       **_DEFAULT_BUDGETS},
            "run": (_manager.snapshot() if _manager is not None and Config.LOCAL_MODE
                    and _owner_pid == os.getpid() else None)}


def get_prompt_trials_snapshot(request_id=None):
    if _owner_pid != os.getpid():
        # Do not acquire any locks copied from another process.
        snapshot = _snapshot_locked()
        snapshot["run"] = None
        if request_id is not None:
            raise PromptTrialError("trials_unavailable", 503)
        return snapshot
    with _lock:
        snapshot = _snapshot_locked()
        if request_id is not None and (snapshot["run"] is None or snapshot["run"]["request_id"] != request_id):
            raise PromptTrialError("run_not_found", 404)
        return snapshot


def register_prompt_trials_shutdown():
    if _owner_pid == os.getpid():
        register_shutdown_callback("prompt_trials", close_prompt_trials)


def start_prompt_trial(value):
    global _manager
    if not Config.LOCAL_MODE:
        raise PromptTrialError("local_mode_required", 403)
    if _owner_pid != os.getpid():
        raise PromptTrialError("trials_unavailable", 503)
    value = normalize_request(value)
    fingerprint = _fingerprint(value)
    with _lock:
        # Idempotent reconciliation creates no work and survives changed caps or
        # cleanup quarantine. Cloud/inherited process access still redacts data.
        if _manager is not None and _manager.data["request_id"] == value["request_id"]:
            if _manager.data["fingerprint"] != fingerprint:
                raise PromptTrialError("request_conflict", 409, _snapshot_locked())
            snapshot = _snapshot_locked()
            if snapshot["run"] is None:
                raise PromptTrialError("invalid_configuration", 503)
            return snapshot
        config = _configuration()
        unavailable = _unavailable(config)
        if unavailable is not None:
            raise PromptTrialError("invalid_configuration" if unavailable == "invalid_configuration" else "trials_unavailable", 503)
        if _manager is not None and (_manager.active or _manager.thread.is_alive()):
            raise PromptTrialError("already_running", 409, _snapshot_locked())
        if value["max_output_tokens"] > config["max_output_tokens"]:
            raise PromptTrialError("invalid_request", 400)
        register_prompt_trials_shutdown()
        try:
            candidate = _Run(value, fingerprint, config)
            from .gateway import _input_size
            if _input_size(candidate.payload) > Config.LOCAL_MAX_INPUT_CHARS:
                raise PromptTrialError("invalid_request", 400)
            candidate.thread.start()
        except PromptTrialError:
            raise
        except Exception:
            raise PromptTrialError("internal_failure", 500) from None
        _manager = candidate
        return _snapshot_locked()


def _schedule_cancel(owner, loop, task):
    if loop is not None and task is not None:
        def cancel_operation():
            with _lock:
                if owner.active and not owner.sealed and not owner.cleaning and owner.task is task:
                    task.cancel()
        try:
            loop.call_soon_threadsafe(cancel_operation)
        except RuntimeError:
            pass


def cancel_prompt_trial(request_id, target):
    """Decide one exact instance's outcome, then let its worker finish cleanup."""
    if not Config.LOCAL_MODE:
        raise PromptTrialError("local_mode_required", 403)
    if _owner_pid != os.getpid():
        raise PromptTrialError("trials_unavailable", 503)
    if not valid_uuid(request_id):
        raise PromptTrialError("invalid_request", 400)
    target = normalize_cancellation(target)
    with _lock:
        owner = _manager
        if owner is None or owner.data["request_id"] != request_id:
            raise PromptTrialError("run_not_found", 404)
        if any(owner.data[key] != target[key] for key in ("instance_id", "fingerprint")):
            raise PromptTrialError("request_conflict", 409)
        accepted = owner.active and not owner.sealed and not owner.outcome_decided and not owner.cleaning
        if accepted:
            owner.cancel_requested = True
            owner.decide("cancelled", error_code="user_cancelled")
        loop, task = owner.loop, owner.task
        # A later replacement must not change which run this response describes.
        snapshot = _snapshot_locked()
    if accepted:
        _schedule_cancel(owner, loop, task)
    return snapshot


def close_prompt_trials():
    global _closing, _cleanup_failed
    if _owner_pid != os.getpid():
        return
    with _lock:
        _closing = True
        owner = _manager
        if owner is None or not owner.active:
            return
        owner.cancel_requested = True
        owner.decide("cancelled", error_code="backend_closing")
        loop, task = owner.loop, owner.task
    _schedule_cancel(owner, loop, task)
    if owner.thread is threading.current_thread():
        return
    # Startup is a bounded synchronous shared-owner operation; allow it to
    # finish before awaiting the owned asynchronous resource cleanup.
    owner.thread.join((owner.budgets["gateway_startup_ms"] + owner.budgets["cleanup_ms"]) / 1000
                      + _DRAIN_SECONDS + .25)
    if owner.thread.is_alive():
        with _lock:
            _cleanup_failed = True
            owner.sealed = True
            owner.finish(cleanup_failed=True)


def _valid_unicode(value):
    return type(value) is str and not any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def _parse_completion(value):
    if type(value) is not dict or type(value.get("choices")) is not list or len(value["choices"]) != 1:
        raise _TrialFailure("malformed_response")
    choice = value["choices"][0]
    if type(choice) is not dict or type(choice.get("message")) is not dict:
        raise _TrialFailure("malformed_response")
    message, reason = choice["message"], choice.get("finish_reason")
    tool_calls, function_call = message.get("tool_calls"), message.get("function_call")
    if (tool_calls is not None and type(tool_calls) is not list
            or function_call is not None and type(function_call) is not dict):
        raise _TrialFailure("malformed_response")
    if tool_calls or function_call is not None or reason not in ("stop", "length", "content_filter"):
        raise _TrialFailure("unsupported_completion")
    if message.get("role") != "assistant":
        raise _TrialFailure("malformed_response")
    content, refusal = message.get("content"), message.get("refusal")
    for text in (content, refusal):
        if text is not None and not _valid_unicode(text):
            raise _TrialFailure("malformed_response")
        if text is not None and len(text) > MAX_OUTPUT_CHARS:
            raise _TrialFailure("response_too_large")
    refused = reason == "content_filter" or bool(refusal)
    if not refused and type(content) is not str:
        raise _TrialFailure("malformed_response")
    usage = value.get("usage")
    usage = usage if type(usage) is dict else {}
    counts = {key: item if type(item := usage.get(key)) is int and 0 <= item <= MAX_SAFE_INTEGER else None
              for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
    return ("refused" if refused else "truncated" if reason == "length" else "succeeded"), {
        "content": content, "refusal": refusal, "finish_reason": reason, "usage": counts}


def _strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError
            result[key] = value
        return result
    def invalid(_value):
        raise ValueError
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid)


class _Run:
    def __init__(self, value, fingerprint, config):
        self.budgets = _budgets()
        self.started = time.monotonic()
        self.deadline = self.started + self.budgets["overall_ms"] / 1000
        self.captured = {name: getattr(Config, name) for name in _CONFIG_FIELDS}
        self.gateway_environment = os.environ.get("MIROFISH_LOCAL_GATEWAY_URL")
        self.data = {"request_id": value["request_id"], "instance_id": str(uuid4()),
                     "fingerprint": fingerprint, "state": "running",
                     "started_at": _utc(), "finished_at": None, "elapsed_ms": 0, "request_duration_ms": None,
                     "request": {key: item for key, item in value.items() if key != "request_id"},
                     "configuration": {key: config[key] for key in ("model", "reasoning_effort")},
                     "response": None, "error_code": None,
                     "cleanup": {"state": "pending", "duration_ms": None}}
        messages = ([{"role": "system", "content": value["system_prompt"]}] if value["system_prompt"] else [])
        messages.append({"role": "user", "content": value["user_prompt"]})
        self.payload = {"model": config["model"], "messages": messages,
            "temperature": value["temperature"], "max_tokens": value["max_output_tokens"], "stream": False}
        self.active, self.sealed, self.cleaning, self.cancel_requested = True, False, False, False
        self.outcome_decided = False
        self.outcome = "failed"
        self.loop = self.task = self.http = None
        self.resources, self.pending = [], set()
        self.thread = threading.Thread(target=self.worker, name="local-prompt-trial", daemon=True)

    def snapshot(self):
        result = deepcopy(self.data)
        if self.active and not self.sealed:
            result["elapsed_ms"] = _milliseconds(time.monotonic() - self.started)
        return result

    def ensure_current(self):
        if self.cleaning or self.sealed or self.cancel_requested or _closing:
            raise asyncio.CancelledError
        if any(getattr(Config, key) != value for key, value in self.captured.items()) or os.environ.get("MIROFISH_LOCAL_GATEWAY_URL") != self.gateway_environment:
            raise _TrialFailure("invalid_configuration")
        if time.monotonic() >= self.deadline:
            raise _TrialFailure("overall_timeout")

    def decide(self, state, *, error_code=None, response=None):
        """First locked decision wins; caller must hold the service lock."""
        if not self.sealed and not self.outcome_decided:
            self.outcome_decided = True
            self.outcome = state
            self.data.update(error_code=error_code, response=response)

    def publish(self, state, *, error_code=None, response=None):
        with _lock:
            self.decide(state, error_code=error_code, response=response)

    async def bounded(self, operation, seconds):
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

    async def gateway(self, deadline):
        import httpx
        from . import get_local_gateway_url
        from .gateway import DEADLINE_CAP_HEADER, DISCONNECT_CANCEL_HEADER, validate_loopback_url

        self.ensure_current()
        base = validate_loopback_url(get_local_gateway_url(deadline_monotonic=deadline))
        self.ensure_current()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        self.http = httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                      headers={"Accept-Encoding": "identity", "Accept": "application/json"})
        self.resources.append(self.http.aclose)
        raw = await self.read_response("GET", base.rstrip("/").removesuffix("/v1") + "/health", deadline, maximum=8192)
        try:
            health = _strict_json(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise _TrialFailure("gateway_unsupported") from None
        if (type(health) is not dict or health.get("status") != "ok"
                or health.get("service") != "local-inference-gateway"
                or health.get("request_deadline_cap") != DEADLINE_CAP_HEADER
                or health.get("request_disconnect_cancel") != DISCONNECT_CANCEL_HEADER):
            raise _TrialFailure("gateway_unsupported")
        self.ensure_current()
        return base.rstrip("/")

    async def read_response(self, method, url, deadline, *, maximum=MAX_RESPONSE_BYTES, **kwargs):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        async with self.http.stream(method, url, timeout=remaining, **kwargs) as response:
            if response.status_code != 200:
                if response.status_code in (408, 504):
                    raise TimeoutError
                raise _TrialFailure("gateway_busy" if response.status_code == 429 else
                                    "gateway_unavailable" if method == "GET" else "model_unavailable")
            if (response.headers.get("Content-Encoding", "identity").lower() != "identity"
                    or response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"):
                raise _TrialFailure("malformed_response" if method == "POST" else "gateway_unsupported")
            declared = response.headers.get("Content-Length")
            if declared is not None and (not declared.isascii() or not declared.isdecimal() or len(declared) > 10 or int(declared) > maximum):
                raise _TrialFailure("response_too_large")
            raw = bytearray()
            async for chunk in response.aiter_raw():
                if len(raw) + len(chunk) > maximum:
                    raise _TrialFailure("response_too_large")
                raw.extend(chunk)
            return bytes(raw)

    async def model(self, base, deadline):
        from .gateway import DEADLINE_CAP_HEADER, DISCONNECT_CANCEL_HEADER
        self.ensure_current()
        raw = await self.read_response("POST", base.removesuffix("/v1") + "/v1/chat/completions", deadline,
                                       json=self.payload, headers={
                                           DEADLINE_CAP_HEADER: str(max(1, math.floor((deadline - time.monotonic()) * 1000))),
                                           DISCONNECT_CANCEL_HEADER: "1",
                                       })
        self.ensure_current()
        try:
            return _parse_completion(_strict_json(raw))
        except (ValueError, UnicodeError, RecursionError):
            raise _TrialFailure("malformed_response") from None

    async def cleanup(self):
        self.cleaning = True
        started = time.monotonic()
        with _lock:
            if not self.sealed:
                self.data["cleanup"]["state"] = "running"
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
                        task.exception()
                for task in pending:
                    task.cancel()
                self.pending = pending
            except asyncio.CancelledError:
                for task in all_tasks:
                    task.cancel()
                self.pending = all_tasks
                okay = False
        with _lock:
            if not self.sealed:
                self.data["cleanup"] = {"state": "succeeded" if okay else "failed",
                                        "duration_ms": _milliseconds(time.monotonic() - started)}
        return okay

    async def execute(self):
        phase, request_started = "startup", None
        try:
            self.ensure_current()
            startup_deadline = min(self.deadline, time.monotonic() + self.budgets["gateway_startup_ms"] / 1000)
            base = await self.bounded(self.gateway(startup_deadline), startup_deadline - time.monotonic())
            phase, request_started = "request", time.monotonic()
            deadline = min(self.deadline, request_started + self.budgets["request_ms"] / 1000)
            outcome, response = await self.bounded(self.model(base, deadline), deadline - time.monotonic())
            if time.monotonic() > deadline:
                raise TimeoutError
            self.publish(outcome, response=response)
        except asyncio.CancelledError:
            self.publish("cancelled", error_code="backend_closing")
        except _TrialFailure as exc:
            self.publish("timed_out" if exc.code == "overall_timeout" else "failed", error_code=exc.code)
        except TimeoutError:
            code = "overall_timeout" if time.monotonic() >= self.deadline else "startup_timeout" if phase == "startup" else "request_timeout"
            self.publish("timed_out", error_code=code)
        except Exception as exc:
            import httpx
            if isinstance(exc, httpx.TimeoutException):
                self.publish("timed_out", error_code="startup_timeout" if phase == "startup" else "request_timeout")
            else:
                self.publish("failed", error_code="gateway_unavailable" if phase == "startup" else "model_unavailable")
        finally:
            if request_started is not None:
                with _lock:
                    if not self.sealed:
                        self.data["request_duration_ms"] = _milliseconds(time.monotonic() - request_started)
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
            self.data["cleanup"]["state"] = "failed"
            self.data["error_code"] = "cleanup_failed"
            self.outcome = "failed"
        # Wall clocks may move backwards; durations use the monotonic clock and
        # the displayed terminal timestamp never precedes its recorded start.
        self.data.update(state=self.outcome, finished_at=max(self.data["started_at"], _utc()),
                         elapsed_ms=_milliseconds(time.monotonic() - self.started))
        self.active = False

    def worker(self):
        okay = False
        try:
            loop = asyncio.new_event_loop()
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
