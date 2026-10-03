"""Small synthetic capability checks; never downloads models or uses cloud APIs."""

from __future__ import annotations

import json
import math


PROBE_IDS = ("json_output", "json_schema", "tool_call", "embedding")


def _parse_json(value, capability: str):
    """Validate the generated JSON text, not just its surrounding API envelope."""
    def reject_constant(_value):
        raise ValueError("Nonstandard JSON numeric constant")

    if not isinstance(value, str):
        raise ValueError(f"{capability} capability check did not return JSON text")
    try:
        return json.loads(value, parse_constant=reject_constant)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{capability} capability check returned invalid JSON") from exc


def check_embedding(vector, dimensions: int) -> None:
    if not isinstance(vector, (list, tuple)) or not vector or len(vector) != dimensions:
        actual = len(vector) if isinstance(vector, (list, tuple)) else "a non-array value"
        raise ValueError(f"Embedding dimensions must be {dimensions}; got {actual}")
    try:
        finite = all(
            type(value) in (float, int) and math.isfinite(value) for value in vector
        )
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError("Embedding values must be finite numbers")
    # Neo4j cosine vectors require a finite, nonzero double-precision L2 norm.
    # hypot avoids falsely overflowing/underflowing by squaring coordinates.
    norm = math.hypot(*vector)
    if norm == 0 or not math.isfinite(norm):
        raise ValueError("Embedding cosine norm must be finite and nonzero")


def probe_request(probe_id: str, *, model: str, embedding_model: str) -> tuple[str, dict]:
    """Build an independent synthetic request for a sync or async OpenAI client."""
    if probe_id == "json_output":
        return "chat", {
            "model": model,
            "messages": [
                {"role": "user", "content": "Return a JSON object with ready set to true."}
            ],
            "response_format": {"type": "json_object"},
            "max_tokens": 512,
        }
    if probe_id == "json_schema":
        return "chat", {
            "model": model,
            "messages": [
                {"role": "user", "content": "Return ready=true following the supplied JSON schema."}
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "LocalReady",
                    "schema": {
                        "type": "object",
                        "properties": {"ready": {"type": "boolean"}},
                        "required": ["ready"],
                        "additionalProperties": False,
                    },
                },
            },
            "max_tokens": 512,
        }
    if probe_id == "tool_call":
        return "chat", {
            "model": model,
            "messages": [{"role": "user", "content": "Call local_check with no arguments."}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "local_check",
                        "description": "A harmless local capability check",
                        "parameters": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": False,
                        },
                    },
                }
            ],
            "tool_choice": {"type": "function", "function": {"name": "local_check"}},
            "max_tokens": 512,
        }
    if probe_id == "embedding":
        return "embeddings", {"model": embedding_model, "input": ["Local capability check"]}
    raise ValueError("Unknown local capability probe")


def validate_probe_response(probe_id: str, response, *, embedding_dimensions: int) -> str:
    """Validate model contents and return only a fixed, safe capability summary."""
    if probe_id not in PROBE_IDS:
        raise ValueError("Unknown local capability probe")
    try:
        if probe_id == "json_output":
            value = _parse_json(response.choices[0].message.content, "JSON output")
            if not isinstance(value, dict) or value.get("ready") is not True:
                raise ValueError("JSON capability check failed: expected ready=true")
            return "JSON output: OK"
        if probe_id == "json_schema":
            value = _parse_json(response.choices[0].message.content, "JSON schema")
            if not isinstance(value, dict) or set(value) != {"ready"} or value["ready"] is not True:
                raise ValueError(
                    "JSON schema capability check failed; Graphiti requires schema-constrained output"
                )
            return "JSON schema: OK"
        if probe_id == "tool_call":
            calls = response.choices[0].message.tool_calls or []
            if not calls or calls[0].function.name != "local_check":
                raise ValueError(
                    "Model did not return a tool call; OASIS requires tool-calling support"
                )
            if _parse_json(calls[0].function.arguments, "Tool arguments") != {}:
                raise ValueError("Model returned unexpected capability-check tool arguments")
            return "Tool calling: OK"
        if len(response.data) != 1:
            raise ValueError("Embedding server returned an incomplete batch")
        check_embedding(response.data[0].embedding, embedding_dimensions)
        return f"Embedding dimensions: {embedding_dimensions}"
    except (AttributeError, IndexError, KeyError, TypeError):
        raise ValueError("Local capability check returned a malformed response") from None


def probe_model_capabilities(
    client, *, model: str, embedding_model: str, embedding_dimensions: int
) -> list[str]:
    """Run the original synchronous CLI checks without imposing transport options."""
    results = []
    for probe_id in PROBE_IDS:
        operation, kwargs = probe_request(probe_id, model=model, embedding_model=embedding_model)
        create = client.chat.completions.create if operation == "chat" else client.embeddings.create
        response = create(**kwargs)
        results.append(validate_probe_response(probe_id, response, embedding_dimensions=embedding_dimensions))
    return results
