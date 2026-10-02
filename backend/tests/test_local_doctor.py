"""The doctor probes only configured loopback services and synthetic data."""

from types import SimpleNamespace

import pytest


def test_capability_probe_checks_json_tools_and_embedding_dimensions():
    from app.local_runtime.doctor import probe_model_capabilities

    calls = []

    class Completions:
        def create(self, **kwargs):
            calls.append(kwargs)
            message = SimpleNamespace(
                content='{"ready":true}',
                tool_calls=[
                    SimpleNamespace(
                        function=SimpleNamespace(name="local_check", arguments="{}")
                    )
                ],
            )
            return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    client = SimpleNamespace(
        chat=SimpleNamespace(completions=Completions()),
        embeddings=SimpleNamespace(
            create=lambda **kwargs: SimpleNamespace(
                data=[SimpleNamespace(embedding=[1.0, 0.0, 0.0])]
            )
        ),
    )
    result = probe_model_capabilities(
        client, model="test", embedding_model="embed", embedding_dimensions=3
    )
    assert result == [
        "JSON output: OK",
        "JSON schema: OK",
        "Tool calling: OK",
        "Embedding dimensions: 3",
    ]
    assert calls[0]["response_format"] == {"type": "json_object"}
    assert calls[1]["response_format"]["type"] == "json_schema"
    assert calls[2]["tool_choice"]["function"]["name"] == "local_check"


def test_capability_probe_rejects_wrong_embedding_dimensions():
    from app.local_runtime.doctor import check_embedding

    with pytest.raises(ValueError, match="dimensions"):
        check_embedding([1.0, 0.0], 3)


@pytest.mark.parametrize("values", [[], [float("nan")], [float("inf")], ["number"]])
def test_capability_probe_rejects_invalid_embedding(values):
    from app.local_runtime.doctor import check_embedding

    with pytest.raises(ValueError):
        check_embedding(values, len(values))
