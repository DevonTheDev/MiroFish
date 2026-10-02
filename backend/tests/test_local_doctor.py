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


def capability_client(*, json_content='{"ready":true}', schema_content='{"ready":true}', arguments='{}'):
    replies = iter([
        SimpleNamespace(content=json_content),
        SimpleNamespace(content=schema_content),
        SimpleNamespace(tool_calls=[SimpleNamespace(function=SimpleNamespace(
            name='local_check', arguments=arguments))]),
    ])
    return SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs:
            SimpleNamespace(choices=[SimpleNamespace(message=next(replies))]))),
        embeddings=SimpleNamespace(create=lambda **kwargs:
            SimpleNamespace(data=[SimpleNamespace(embedding=[1.0, 0.0, 0.0])])),
    )


@pytest.mark.parametrize('value', ['1', '1.0'])
def test_schema_probe_requires_a_boolean_not_python_numeric_equality(value):
    from app.local_runtime.doctor import probe_model_capabilities

    with pytest.raises(ValueError, match='schema'):
        probe_model_capabilities(capability_client(schema_content='{"ready":' + value + '}'),
                                 model='test', embedding_model='embed', embedding_dimensions=3)


@pytest.mark.parametrize('constant', ['NaN', 'Infinity', '-Infinity'])
def test_json_probe_rejects_nonstandard_numeric_constants(constant):
    from app.local_runtime.doctor import probe_model_capabilities

    with pytest.raises(ValueError, match='JSON'):
        probe_model_capabilities(capability_client(json_content='{"ready":true,"extra":' + constant + '}'),
                                 model='test', embedding_model='embed', embedding_dimensions=3)


@pytest.mark.parametrize('arguments', ['', None])
def test_tool_probe_does_not_treat_missing_json_as_empty_arguments(arguments):
    from app.local_runtime.doctor import probe_model_capabilities

    with pytest.raises(ValueError, match='arguments'):
        probe_model_capabilities(capability_client(arguments=arguments),
                                 model='test', embedding_model='embed', embedding_dimensions=3)


@pytest.mark.parametrize('values', [[0.0, 0.0], [-0.0, 0.0], [1.7e308, 1.7e308]])
def test_embedding_probe_requires_a_finite_nonzero_cosine_norm(values):
    from app.local_runtime.doctor import check_embedding

    with pytest.raises(ValueError, match='norm'):
        check_embedding(values, 2)


@pytest.mark.parametrize('values', [None, 1.0, {1.0, 2.0}, {1.0: 2.0, 3.0: 4.0}])
def test_embedding_probe_rejects_non_array_shapes_with_a_useful_error(values):
    from app.local_runtime.doctor import check_embedding

    with pytest.raises(ValueError, match='Embedding'):
        check_embedding(values, 2)


@pytest.mark.parametrize('values', [[1e308, 0.0], [1e-300, 0.0], (0.6, 0.8)])
def test_embedding_norm_check_does_not_overflow_or_underflow_valid_vectors(values):
    from app.local_runtime.doctor import check_embedding

    check_embedding(values, 2)


def test_embedding_integer_outside_double_precision_has_a_validation_error():
    from app.local_runtime.doctor import check_embedding

    with pytest.raises(ValueError, match='finite numbers'):
        check_embedding([10 ** 400], 1)


def test_tool_argument_json_allows_ordinary_whitespace():
    from app.local_runtime.doctor import probe_model_capabilities

    result = probe_model_capabilities(capability_client(arguments=' \n{ }\t'),
                                      model='test', embedding_model='embed', embedding_dimensions=3)
    assert 'Tool calling: OK' in result
