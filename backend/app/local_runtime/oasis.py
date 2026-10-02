"""Consumer-sized policies for the pinned CAMEL/OASIS simulation engine."""

from __future__ import annotations

import json

from ..config import Config
from . import configure_local_environment, get_local_gateway_url


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

    class BoundedLocalModel(OpenAICompatibleModel):
        @property
        def token_limit(self):
            return Config.LOCAL_CONTEXT_TOKENS - Config.LOCAL_MAX_OUTPUT_TOKENS

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
