"""Pure, allowlisted observations of loaded config and existing gateway activity.

This is not a readiness check. It must never invoke Config.validate (which can
warn), lazy startup, environment setup, the doctor, or model/memory clients.
"""

from datetime import datetime, timezone
import os
import unicodedata
from urllib.parse import urlsplit

from ..config import Config
from . import _GATEWAY_ENV, get_local_gateway_snapshot
from .gateway import GatewaySettings, safe_integer, safe_positive_number, validate_loopback_url


def _bounded_text(value, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        return None
    if any(unicodedata.category(char).startswith("C") for char in value):
        return None
    return value.strip()


def _configuration():
    issues = []

    def issue(field, code):
        issues.append({"field": field, "code": code})

    def integer(name, field):
        value = safe_integer(getattr(Config, name))
        if value is None:
            issue(field, "invalid_positive_integer")
        return value

    def model(name, field):
        value = _bounded_text(getattr(Config, name), 256)
        if value is None or value.lower().endswith((":cloud", "-cloud")):
            issue(field, "invalid_model")
            return None
        return value

    def endpoint(name, field, graph=False):
        try:
            raw = getattr(Config, name)
            if not isinstance(raw, str) or len(raw) > 2048:
                raise ValueError
            value = validate_loopback_url(raw, schemes=("bolt",) if graph else ("http", "https"))
            if len(value) > 2048:
                raise ValueError
            if not graph and urlsplit(value).path not in ("", "/v1"):
                raise ValueError
            return value
        except (TypeError, ValueError):
            issue(field, "invalid_local_endpoint")
            return None

    limits = {
        "max_concurrency": integer("LOCAL_MAX_CONCURRENCY", "gateway_limits.max_concurrency"),
        "max_queue": integer("LOCAL_MAX_QUEUE", "gateway_limits.max_queue"),
        "request_timeout": safe_positive_number(Config.LOCAL_REQUEST_TIMEOUT),
        "max_output_tokens": integer("LOCAL_MAX_OUTPUT_TOKENS", "gateway_limits.max_output_tokens"),
        "max_input_chars": integer("LOCAL_MAX_INPUT_CHARS", "gateway_limits.max_input_chars"),
    }
    if limits["request_timeout"] is None:
        issue("gateway_limits.request_timeout", "invalid_positive_number")
    config = {
        "chat_model": model("LLM_MODEL_NAME", "chat_model"),
        "embedding_model": model("LOCAL_EMBEDDING_MODEL", "embedding_model"),
        "chat_endpoint": endpoint("LLM_BASE_URL", "chat_endpoint"),
        "embedding_endpoint": endpoint("LOCAL_EMBEDDING_BASE_URL", "embedding_endpoint"),
        "graph_endpoint": endpoint("LOCAL_GRAPH_URI", "graph_endpoint", graph=True),
        "embedding_dimensions": integer("LOCAL_EMBEDDING_DIMENSIONS", "embedding_dimensions"),
        "context_tokens": integer("LOCAL_CONTEXT_TOKENS", "context_tokens"),
        "max_agents": integer("LOCAL_MAX_AGENTS", "max_agents"),
        "max_rounds": integer("LOCAL_MAX_ROUNDS", "max_rounds"),
        "max_agent_iterations": integer("LOCAL_MAX_AGENT_ITERATIONS", "max_agent_iterations"),
        "reasoning_effort": None,
        "gateway_limits": limits,
    }
    if Config.LOCAL_REASONING_EFFORT is not None:
        config["reasoning_effort"] = _bounded_text(Config.LOCAL_REASONING_EFFORT, 64)
        if config["reasoning_effort"] is None:
            issue("reasoning_effort", "invalid_reasoning_effort")
    if (limits["max_output_tokens"] is not None and config["context_tokens"] is not None
            and limits["max_output_tokens"] >= config["context_tokens"]):
        issue("gateway_limits.max_output_tokens", "output_exceeds_context")
    # Keep the passive assessment aligned with the actual transport constructor.
    # Only pass sanitized, bounded primitives; never emit exception text.
    if not issues:
        try:
            GatewaySettings(llm_base_url=config["chat_endpoint"], embedding_base_url=config["embedding_endpoint"],
                            reasoning_effort=config["reasoning_effort"], **limits)
        except (TypeError, ValueError, OverflowError):
            issue("gateway", "invalid_gateway_configuration")
    inherited = os.environ.get(_GATEWAY_ENV)
    if inherited:
        try:
            if len(inherited) > 2048:
                raise ValueError
            validate_loopback_url(inherited)
        except (TypeError, ValueError):
            issue("gateway", "invalid_gateway_configuration")
    return {"valid": not issues, "issues": issues, **config}


def get_local_runtime_snapshot() -> dict:
    """Read only loaded Config and this process's already-existing owner."""
    local = bool(Config.LOCAL_MODE)
    return {
        "schema_version": 1,
        "kind": "mirofish_local_runtime_status",
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "mode": "local" if local else "cloud",
        "configuration": _configuration() if local else None,
        "gateway": get_local_gateway_snapshot(),
    }
