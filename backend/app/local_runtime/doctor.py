"""Small synthetic capability checks; never downloads models or uses cloud APIs."""

from __future__ import annotations

import json
import math


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


def probe_model_capabilities(
    client, *, model: str, embedding_model: str, embedding_dimensions: int
) -> list[str]:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "user", "content": "Return a JSON object with ready set to true."}
        ],
        response_format={"type": "json_object"},
        max_tokens=512,
    )
    value = _parse_json(response.choices[0].message.content, "JSON output")
    if not isinstance(value, dict) or value.get("ready") is not True:
        raise ValueError("JSON capability check failed: expected ready=true")
    response = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "user",
                "content": "Return ready=true following the supplied JSON schema.",
            }
        ],
        response_format={
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
        max_tokens=512,
    )
    value = _parse_json(response.choices[0].message.content, "JSON schema")
    if not isinstance(value, dict) or set(value) != {"ready"} or value["ready"] is not True:
        raise ValueError(
            "JSON schema capability check failed; Graphiti requires schema-constrained output"
        )
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Call local_check with no arguments."}],
        tools=[
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
        tool_choice={"type": "function", "function": {"name": "local_check"}},
        max_tokens=512,
    )
    calls = response.choices[0].message.tool_calls or []
    if not calls or calls[0].function.name != "local_check":
        raise ValueError(
            "Model did not return a tool call; OASIS requires tool-calling support"
        )
    if _parse_json(calls[0].function.arguments, "Tool arguments") != {}:
        raise ValueError("Model returned unexpected capability-check tool arguments")
    response = client.embeddings.create(
        model=embedding_model, input=["Local capability check"]
    )
    if len(response.data) != 1:
        raise ValueError("Embedding server returned an incomplete batch")
    check_embedding(response.data[0].embedding, embedding_dimensions)
    return [
        "JSON output: OK",
        "JSON schema: OK",
        "Tool calling: OK",
        f"Embedding dimensions: {embedding_dimensions}",
    ]
