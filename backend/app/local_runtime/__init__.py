"""Local inference lifecycle, shared by the web app and OASIS subprocesses.

Nothing starts at import time. The backend owns one gateway and passes its
loopback address to children; standalone simulation scripts own their gateway.
"""

from __future__ import annotations

import os
import threading

from ..config import Config
from ..shutdown import register_shutdown_callback

_GATEWAY_ENV = "MIROFISH_LOCAL_GATEWAY_URL"
_gateway = None
_gateway_starting = None
_gateway_lock = threading.Lock()


def get_local_gateway_snapshot() -> dict:
    """Observe an existing owner without starting it or waiting on lifecycle I/O."""
    from .gateway import unavailable_gateway_snapshot

    if not Config.LOCAL_MODE:
        return unavailable_gateway_snapshot("disabled")
    if os.environ.get(_GATEWAY_ENV):
        return unavailable_gateway_snapshot("inherited")
    # An inherited owner has no live serving threads in this process. Its
    # module lock may also have been copied while locked in another thread.
    owner = _gateway or _gateway_starting
    if owner is not None and owner._owner_pid != os.getpid():
        return unavailable_gateway_snapshot("inherited")
    if not _gateway_lock.acquire(blocking=False):
        return unavailable_gateway_snapshot("transitioning")
    try:
        owner = _gateway or _gateway_starting
    finally:
        _gateway_lock.release()
    return unavailable_gateway_snapshot("not_running") if owner is None else owner.snapshot()


def configure_local_environment() -> None:
    """Disable dependency telemetry, implicit downloads and inherited proxies."""
    if not Config.LOCAL_MODE:
        return
    for name, value in {
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "GRAPHITI_TELEMETRY_ENABLED": "false",
        "LANGFUSE_ENABLED": "false",
        "TRACEROOT_ENABLED": "false",
        "OTEL_SDK_DISABLED": "true",
        "ANONYMIZED_TELEMETRY": "false",
        "NO_PROXY": "*",
        "no_proxy": "*",
    }.items():
        os.environ[name] = value
    # CAMEL 0.2.78 constructs both sync/async clients from the same kwargs, so
    # it cannot accept separate httpx clients. Clear proxy inheritance before
    # importing it; our direct SDK clients also set trust_env=False explicitly.
    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        os.environ.pop(name, None)


def get_local_gateway_url(*, deadline_monotonic: float | None = None) -> str:
    """Get the shared gateway within an optional absolute monotonic deadline.

    Failed partial starts remain owned for shutdown. No later caller can create
    another worker until their cleanup has been confirmed.
    """
    global _gateway, _gateway_starting
    if not Config.LOCAL_MODE:
        raise ValueError("Local gateway requires MEMORY_BACKEND=local")
    from .gateway import (
        GatewaySettings, GatewayStartupCleanupError, LocalInferenceGateway,
        _startup_lock, _startup_timeout, validate_loopback_url,
    )

    _startup_timeout(deadline_monotonic)

    # Child processes must reject their own invalid limits too, even when
    # they share an already-running gateway owned by the parent.
    errors = Config.validate()
    if errors:
        raise ValueError("; ".join(errors))
    inherited = os.environ.get(_GATEWAY_ENV)
    if inherited:
        return validate_loopback_url(inherited)
    owner = _gateway or _gateway_starting
    if owner is not None and getattr(owner, "_owner_pid", os.getpid()) != os.getpid():
        raise RuntimeError("An inherited local inference gateway cannot be started")
    with _startup_lock(_gateway_lock, deadline_monotonic):
        if _gateway is None:
            if _gateway_starting is not None:
                if not _gateway_starting.startup_cleanup_complete:
                    raise GatewayStartupCleanupError("Local gateway startup cleanup did not finish")
                _gateway_starting = None
            configure_local_environment()
            owner = LocalInferenceGateway(
                GatewaySettings(
                    llm_base_url=Config.LLM_BASE_URL,
                    embedding_base_url=Config.LOCAL_EMBEDDING_BASE_URL,
                    max_concurrency=Config.LOCAL_MAX_CONCURRENCY,
                    max_queue=Config.LOCAL_MAX_QUEUE,
                    request_timeout=Config.LOCAL_REQUEST_TIMEOUT,
                    max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
                    max_input_chars=Config.LOCAL_MAX_INPUT_CHARS,
                    reasoning_effort=Config.LOCAL_REASONING_EFFORT,
                )
            )
            # Register before any workers start, including partial failures.
            register_shutdown_callback("gateway", close_local_gateway)
            _gateway_starting = owner
            url = owner.start() if deadline_monotonic is None else owner.start(deadline_monotonic=deadline_monotonic)
            _gateway = owner
            _gateway_starting = None
            return url
        return _gateway.start() if deadline_monotonic is None else _gateway.start(deadline_monotonic=deadline_monotonic)


def close_local_gateway() -> None:
    """Release only a gateway owned by this process, never the parent's one."""
    global _gateway, _gateway_starting
    owner = _gateway or _gateway_starting
    if owner is not None and getattr(owner, "_owner_pid", os.getpid()) != os.getpid():
        return
    with _gateway_lock:
        if _gateway is not None:
            _gateway.close()
            _gateway = None
        if _gateway_starting is not None:
            _gateway_starting.close()
            _gateway_starting = None


def child_environment() -> dict[str, str]:
    """Ensure child processes share the web app's global inference budget."""
    configure_local_environment()
    env = os.environ.copy()
    if Config.LOCAL_MODE:
        env[_GATEWAY_ENV] = get_local_gateway_url()
    return env


def openai_client_options(base_url: str | None = None) -> dict:
    """Override only local SDK transports; keep cloud client behavior intact."""
    if not Config.LOCAL_MODE:
        return {}
    import httpx
    from .gateway import validate_loopback_url

    if base_url is not None:
        try:
            validate_loopback_url(base_url)
        except ValueError as exc:
            raise ValueError(
                "Remote model overrides are forbidden in local mode"
            ) from exc
    return {
        "api_key": "local",
        "base_url": get_local_gateway_url(),
        "timeout": Config.LOCAL_REQUEST_TIMEOUT,
        "max_retries": 0,
        "http_client": httpx.Client(trust_env=False, follow_redirects=False),
    }
