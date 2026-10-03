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
_gateway_lock = threading.Lock()


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


def get_local_gateway_url() -> str:
    """Get this app's single bounded gateway, or the inherited parent gateway."""
    global _gateway
    if not Config.LOCAL_MODE:
        raise ValueError("Local gateway requires MEMORY_BACKEND=local")
    from .gateway import GatewaySettings, LocalInferenceGateway, validate_loopback_url

    # Child processes must reject their own invalid limits too, even when
    # they share an already-running gateway owned by the parent.
    errors = Config.validate()
    if errors:
        raise ValueError("; ".join(errors))
    inherited = os.environ.get(_GATEWAY_ENV)
    if inherited:
        return validate_loopback_url(inherited)
    with _gateway_lock:
        if _gateway is None:
            configure_local_environment()
            _gateway = LocalInferenceGateway(
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
            _gateway.start()
            register_shutdown_callback("gateway", close_local_gateway)
        return _gateway.start()


def close_local_gateway() -> None:
    """Release only a gateway owned by this process, never the parent's one."""
    global _gateway
    with _gateway_lock:
        if _gateway is not None:
            _gateway.close()
            _gateway = None


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
