"""Small synthetic capability checks; never downloads models or uses cloud APIs."""

from __future__ import annotations

import json
import math


def check_embedding(vector, dimensions: int) -> None:
    if not vector or len(vector) != dimensions:
        raise ValueError(
            f"Embedding dimensions must be {dimensions}; got {len(vector)}"
        )
    if not all(
        type(value) in (float, int) and math.isfinite(value) for value in vector
    ):
        raise ValueError("Embedding values must be finite numbers")


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
    try:
        value = json.loads(response.choices[0].message.content or "")
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "Model did not return usable JSON; choose an instruction/structured-output model"
        ) from exc
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
    if json.loads(response.choices[0].message.content or "") != {"ready": True}:
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
    if json.loads(calls[0].function.arguments or "{}") != {}:
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
