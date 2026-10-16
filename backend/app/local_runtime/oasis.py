"""Consumer-sized policies for the pinned CAMEL/OASIS simulation engine."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import lru_cache
from inspect import getattr_static
import json
import math
from types import MethodType

from ..config import Config
from . import configure_local_environment, get_local_gateway_url


@dataclass(frozen=True, eq=False)
class _InterviewScope:
    agent: object
    manager: object
    backends: tuple
    system: object
    memory: object
    role: str
    content: str
    prompt: str
    task: object


_interview_scope = ContextVar("local_oasis_interview", default=None)


def _method_bindings(cls, names):
    return tuple((name, getattr_static(cls, name)) for name in names)


def _uses_implementation(value, cls, bindings):
    return type(value) is cls and all(
        name not in vars(value) and getattr_static(cls, name) is method
        for name, method in bindings
    )


@lru_cache(maxsize=1)
def _interview_implementations():
    # Loaded only for a local interview, after local telemetry policy is set.
    # Dependency versions are pinned; retain their original method identities.
    from camel.agents.chat_agent import ChatAgent
    from camel.messages import BaseMessage
    from camel.models.model_manager import ModelManager
    from camel.types import UnifiedModelType
    from oasis.social_agent.agent import SocialAgent
    from openai import AsyncOpenAI
    from openai.resources.chat.completions import AsyncCompletions

    agent_methods = (
        ("perform_interview", SocialAgent.perform_interview),
        ("_aget_model_response", ChatAgent._aget_model_response),
        ("system_message", getattr_static(ChatAgent, "system_message")),
        ("memory", getattr_static(ChatAgent, "memory")),
    )
    manager_methods = _method_bindings(
        ModelManager, ("arun", "round_robin", "random_model", "always_first")
    )
    return (SocialAgent, ModelManager, BaseMessage, UnifiedModelType,
            agent_methods, manager_methods, AsyncOpenAI, AsyncCompletions,
            AsyncCompletions.create)


def _capture_interview_scope(agent, prompt):
    (agent_type, manager_type, message_type, _, agent_methods,
     manager_methods, *_) = _interview_implementations()
    if type(prompt) is not str or not _uses_implementation(
        agent, agent_type, agent_methods
    ):
        return None
    manager = agent.model_backend
    if not _uses_implementation(manager, manager_type, manager_methods):
        return None
    strategy = manager.scheduling_strategy
    if (type(strategy) is not MethodType or strategy.__self__ is not manager
            or not any(strategy.__func__ is method
                       for _, method in manager_methods[1:])):
        return None
    system = agent.system_message
    task = asyncio.current_task()
    if (type(system) is not message_type or type(system.role_name) is not str
            or type(system.content) is not str or system.role_name != "system"
            or agent.interview_record is not False or task is None
            or type(manager.models) is not list or not manager.models):
        return None
    return _InterviewScope(
        agent, manager, tuple(manager.models), system, agent.memory,
        system.role_name, system.content, prompt, task,
    )


@contextmanager
def _local_interview_scope(agent, interview_prompt):
    """Own this dispatched interview only, masking an outer scope if ineligible."""
    scope = None
    if Config.LOCAL_MODE:
        try:
            scope = _capture_interview_scope(agent, interview_prompt)
        except Exception:
            # An unsupported binding must leave the inherited action unchanged.
            pass
    token = _interview_scope.set(scope)
    try:
        yield
    finally:
        _interview_scope.reset(token)


def _scope_still_owned(scope, model):
    current = _capture_interview_scope(scope.agent, scope.prompt)
    return (
        current is not None and current.task is scope.task
        and current.manager is scope.manager and current.system is scope.system
        and current.memory is scope.memory and current.role == scope.role
        and current.content == scope.content
        and len(current.backends) == len(scope.backends)
        and all(before is after for before, after
                in zip(scope.backends, current.backends))
        and any(backend is model for backend in scope.backends)
        and scope.manager.current_model is model
    )


def _plain_json(value):
    """Reject callbacks, sentinels and custom containers before sizing/equality."""
    kind = type(value)
    if kind in (str, int, bool, type(None)):
        return True
    if kind is float:
        return math.isfinite(value)
    if kind is list:
        return all(_plain_json(item) for item in value)
    if kind is dict:
        return all(type(key) is str and _plain_json(item)
                   for key, item in value.items())
    return False


def _select_interview_messages(model, messages, tools):
    """Remove one exact duplicate only in the recoverable complete-envelope interval."""
    scope = _interview_scope.get()
    if not Config.LOCAL_MODE or scope is None or tools is not None:
        return messages
    try:
        if not _scope_still_owned(scope, model):
            return messages
        (_, _, _, model_type, _, _, client_type, completions_type,
         create_method) = _interview_implementations()
        client = model._async_client
        if (type(client) is not client_type or not _uses_implementation(
                client.chat.completions, completions_type,
                (("create", create_method),))):
            return messages
        config = model.model_config_dict
        if (type(config) is not dict or not _plain_json(config)
                or tuple(config) != ("max_tokens",)
                or type(config["max_tokens"]) is not int or config["max_tokens"] <= 0
                or type(model.model_type) not in (str, model_type)
                or type(messages) is not list or len(messages) < 3
                or not all(type(message) is dict for message in messages)
                or not _plain_json(messages)):
            return messages
        for message in messages[:2]:
            if (set(message) != {"role", "content"}
                    or message["role"] != scope.role
                    or message["content"] != scope.content):
                return messages
        if (set(messages[-1]) != {"role", "content"}
                or messages[-1]["role"] != "user"
                or messages[-1]["content"] != scope.prompt):
            return messages
        if (type(Config.LOCAL_MAX_INPUT_CHARS) is not int
                or Config.LOCAL_MAX_INPUT_CHARS <= 0
                or type(Config.LOCAL_MAX_OUTPUT_TOKENS) is not int
                or Config.LOCAL_MAX_OUTPUT_TOKENS <= 0
                or (Config.LOCAL_REASONING_EFFORT is not None
                    and type(Config.LOCAL_REASONING_EFFORT) is not str)):
            return messages
        from .gateway import _input_size, _normalize_payload

        def size(items):
            return _input_size(_normalize_payload(
                "/v1/chat/completions",
                {"model": model.model_type, "messages": items,
                 "max_tokens": config["max_tokens"]},
                max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
                reasoning_effort=Config.LOCAL_REASONING_EFFORT,
            ))

        if size(messages) <= Config.LOCAL_MAX_INPUT_CHARS:
            return messages
        candidate = messages[1:]
        if size(candidate) <= Config.LOCAL_MAX_INPUT_CHARS:
            return candidate
    except Exception:
        # Only shaping is guarded. Provider exceptions/cancellation stay outside.
        pass
    return messages


class ConservativeTokenCounter:
    """Download-free UTF-8 byte estimate, intentionally conservative for text.

    This is not the model's tokenizer. It reserves message framing space and
    avoids CAMEL's implicit tiktoken download. The server owns its actual context
    limit; tool schemas also consume context and can require a larger preset.
    """

    def encode(self, text: str) -> list[int]:
        return list(text.encode("utf-8"))

    def decode(self, token_ids: list[int]) -> str:
        return bytes(token_ids).decode("utf-8", errors="replace")

    def count_tokens_from_messages(self, messages: list[dict]) -> int:
        return len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) + 32 * len(
            messages
        )


def create_local_model():
    """Use explicit local transport and separate input/output context budgets."""
    if not Config.LOCAL_MODE:
        raise ValueError("Local model requires MEMORY_BACKEND=local")
    configure_local_environment()
    # Import after disabling telemetry and proxy inheritance. CAMEL's factory
    # uses this same backend for OPENAI_COMPATIBLE_MODEL, but its default
    # token_limit incorrectly uses the output max_tokens as the context size.
    from camel.models.openai_compatible_model import OpenAICompatibleModel

    inherited_request = OpenAICompatibleModel._arequest_chat_completion

    class BoundedLocalModel(OpenAICompatibleModel):
        @property
        def token_limit(self):
            return Config.LOCAL_CONTEXT_TOKENS - Config.LOCAL_MAX_OUTPUT_TOKENS

        async def _arequest_chat_completion(self, messages, tools=None):
            if (_uses_implementation(self, BoundedLocalModel, model_methods)
                    and OpenAICompatibleModel._arequest_chat_completion
                    is inherited_request):
                messages = _select_interview_messages(self, messages, tools)
            return await super()._arequest_chat_completion(messages, tools)

    model_methods = _method_bindings(
        BoundedLocalModel, ("arun", "_arun", "_arequest_chat_completion")
    )

    return BoundedLocalModel(
        model_type=Config.LLM_MODEL_NAME,
        api_key="local",
        url=get_local_gateway_url(),
        model_config_dict={"max_tokens": Config.LOCAL_MAX_OUTPUT_TOKENS},
        token_counter=ConservativeTokenCounter(),
        timeout=Config.LOCAL_REQUEST_TIMEOUT,
        max_retries=0,
    )


def simulation_concurrency() -> int:
    return Config.LOCAL_MAX_CONCURRENCY if Config.LOCAL_MODE else 30


def platform_for_mode(
    platform: str, database_path: str, *, default_platform=None, platform_factory=None
):
    """Avoid Twitter's hidden transformer download/GPU use in local mode.

    Random recommendations deliberately trade semantic ranking for predictable
    CPU-only resource use. Reddit retains OASIS's existing inexpensive policy.
    """
    if not Config.LOCAL_MODE or platform != "twitter":
        return default_platform
    if platform_factory is None:
        from oasis.social_platform.platform import Platform

        platform_factory = Platform
    return platform_factory(
        db_path=database_path,
        recsys_type="random",
        refresh_rec_post_count=2,
        max_rec_post_len=2,
        following_post_count=3,
        use_openai_embedding=False,
    )


def limit_rounds(requested: int | None) -> int | None:
    if not Config.LOCAL_MODE:
        return requested
    if requested is not None and type(requested) is not int:
        raise ValueError("max_rounds must be an integer or omitted")
    if requested is None or requested <= 0:
        return Config.LOCAL_MAX_ROUNDS
    return min(requested, Config.LOCAL_MAX_ROUNDS)


def validate_agent_count(count: int) -> None:
    if Config.LOCAL_MODE and count > Config.LOCAL_MAX_AGENTS:
        raise ValueError(
            f"This graph has {count} agents; local mode allows {Config.LOCAL_MAX_AGENTS}. "
            "Use a smaller graph or explicitly increase LOCAL_MAX_AGENTS in .env."
        )


def configure_agent_limits(agent_graph) -> None:
    """CAMEL otherwise allows an unbounded model/tool loop within one action."""
    if Config.LOCAL_MODE:
        for _, agent in agent_graph.get_agents():
            agent.max_iteration = Config.LOCAL_MAX_AGENT_ITERATIONS
