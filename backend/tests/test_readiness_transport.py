"""Reusable doctor probes and bounded readiness requests over real loopback HTTP."""

import concurrent.futures
import copy
import json
import socket
import threading
import time
from types import SimpleNamespace

from openai import OpenAI
import pytest

from test_gateway_metrics import assert_partition, observe_until
from test_local_gateway import chat, gateway_for, gateway_module, upstream_server


CAP_HEADER = "X-MiroFish-Timeout-Ms"
PROBE_IDS = ("json_output", "json_schema", "tool_call", "embedding")
CHAT_BODY = json.dumps({
    "model": "local-model", "messages": [{"role": "user", "content": "synthetic"}],
}).encode()


def request_headers(client, cap_headers=b"", *, length=len(CHAT_BODY)):
    return (f"POST /v1/chat/completions HTTP/1.1\r\n"
            f"Host: {client.base_url.host}:{client.base_url.port}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {length}\r\n").encode() + cap_headers


def read_response(connection):
    chunks = []
    while chunk := connection.recv(65536):
        chunks.append(chunk)
    return b"".join(chunks)


def test_health_advertises_the_supported_deadline_cap_without_forwarding():
    with upstream_server() as upstream, gateway_for(upstream) as (gateway, client):
        response = client.get(str(client.base_url).removesuffix("/v1/") + "/health")
        assert response.json() == {
            "status": "ok", "service": "local-inference-gateway",
            "request_deadline_cap": CAP_HEADER,
        }
        assert gateway_module().DEADLINE_CAP_HEADER == CAP_HEADER
        assert not upstream.calls
        assert gateway.snapshot()["metrics"]["started_requests"] == 0


@pytest.mark.parametrize("cap_headers", [
    b"X-MiroFish-Timeout-Ms: \r\n", b"X-MiroFish-Timeout-Ms: 0\r\n",
    b"X-MiroFish-Timeout-Ms: -1\r\n", b"X-MiroFish-Timeout-Ms: +1\r\n",
    b"X-MiroFish-Timeout-Ms: 1.5\r\n", b"X-MiroFish-Timeout-Ms: 1e3\r\n",
    b"X-MiroFish-Timeout-Ms: 3600001\r\n", b"X-MiroFish-Timeout-Ms: \xb2\r\n",
    b"X-MiroFish-Timeout-Ms: \xd9\xa1\r\n", b"X-MiroFish-Timeout-Ms: 10 \r\n",
    b"X-MiroFish-Timeout-Ms: " + b"9" * 5000 + b"\r\n",
    b"X-MiroFish-Timeout-Ms: 1000,1000\r\n",
    b"X-MiroFish-Timeout-Ms: 1000\r\nx-mirofish-timeout-ms: 1000\r\n",
], ids=["empty", "zero", "negative", "signed", "decimal", "exponent", "over_maximum",
        "latin1_digit", "utf8_digit", "trailing_space", "huge_integer", "joined", "duplicate"])
def test_invalid_caps_fail_safely_before_receiving_a_body(cap_headers):
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=2) as (gateway, client):
        with socket.create_connection((client.base_url.host, client.base_url.port), timeout=0.6) as connection:
            connection.sendall(request_headers(client, cap_headers) + b"\r\n")
            response = read_response(connection)
        assert response.startswith(b"HTTP/1.0 400 ")
        assert json.loads(response.split(b"\r\n\r\n", 1)[1])["error"]["type"] == "local_gateway_error"
        assert not upstream.calls
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["started_requests"] == 0
        assert_partition(metrics)


def test_cap_counts_elapsed_headers_and_rejects_before_reading_body():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=2) as (gateway, client):
        with socket.create_connection((client.base_url.host, client.base_url.port), timeout=0.6) as connection:
            connection.sendall(request_headers(client, b"X-MiroFish-Timeout-Ms: 120\r\n"))
            observe_until(gateway, lambda m: m["admitted_connections"] == 1)
            # The cap is only knowable once HTTP headers have finished parsing.
            time.sleep(0.25)
            started = time.monotonic()
            connection.sendall(b"\r\n")
            assert read_response(connection).startswith(b"HTTP/1.0 408 ")
            assert time.monotonic() - started < 0.3
        assert not upstream.calls
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["started_requests"] == 0


def test_headers_and_incomplete_body_share_the_shortened_lifetime():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=2) as (gateway, client):
        with socket.create_connection((client.base_url.host, client.base_url.port), timeout=0.7) as connection:
            connection.sendall(request_headers(client, b"X-MiroFish-Timeout-Ms: 400\r\n"))
            observe_until(gateway, lambda m: m["admitted_connections"] == 1)
            time.sleep(0.28)
            started = time.monotonic()
            connection.sendall(b"\r\n" + CHAT_BODY[:1])
            assert read_response(connection).startswith(b"HTTP/1.0 408 ")
            assert time.monotonic() - started < 0.3
        assert not upstream.calls
        observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert chat(client).status_code == 200


def test_active_cap_expires_releases_slots_and_keeps_timeout_metrics():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=2, max_queue=0) as (gateway, client):
        upstream.release.clear()
        started = time.monotonic()
        response = client.post("chat/completions", content=CHAT_BODY,
                               headers={CAP_HEADER: "150", "Content-Type": "application/json"})
        assert response.status_code == 504
        assert time.monotonic() - started < 0.7
        assert len(upstream.calls) == 1
        assert CAP_HEADER.lower() not in {key.lower() for key in upstream.calls[0][2]}
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["timed_out_requests"] == 1
        assert metrics["active_requests"] == metrics["queued_requests"] == metrics["cancelled_requests"] == 0
        assert_partition(metrics)
        upstream.release.set()
        assert chat(client).status_code == 200


def test_queued_embedding_cap_expires_without_starting_a_second_upstream():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=2, max_queue=1) as (gateway, client):
        upstream.release.clear()
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            first = pool.submit(chat, client)
            assert upstream.started.wait(1)
            started = time.monotonic()
            response = client.post("embeddings", json={"model": "embed", "input": "synthetic"},
                                   headers={CAP_HEADER: "150"})
            assert response.status_code == 504
            assert time.monotonic() - started < 0.7
            assert len(upstream.calls) == 1
            metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 1)
            assert metrics["timed_out_requests"] == metrics["active_requests"] == 1
            assert metrics["queued_requests"] == 0
            assert_partition(metrics)
            upstream.release.set()
            assert first.result(timeout=1).status_code == 200
        assert chat(client).status_code == 200


def test_cap_cannot_extend_the_configured_request_lifetime():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=0.15) as (_, client):
        upstream.delay = 0.6
        started = time.monotonic()
        response = client.post("chat/completions", content=CHAT_BODY,
                               headers={CAP_HEADER: "3600000", "Content-Type": "application/json"})
        assert response.status_code == 504
        assert time.monotonic() - started < 0.5


def test_expired_cap_cannot_start_upstream_after_event_loop_scheduling_delay():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=2) as (gateway, client):
        entered, release = threading.Event(), threading.Event()

        def pause_event_loop():
            entered.set()
            release.wait(1)

        gateway._loop.call_soon_threadsafe(pause_event_loop)
        try:
            assert entered.wait(1)
            with socket.create_connection((client.base_url.host, client.base_url.port), timeout=1) as connection:
                connection.sendall(request_headers(client, b"X-MiroFish-Timeout-Ms: 150\r\n") + b"\r\n" + CHAT_BODY)
                observe_until(gateway, lambda m: m["admitted_connections"] == 1)
                time.sleep(0.25)
                release.set()
                assert read_response(connection).startswith(b"HTTP/1.0 504 ")
        finally:
            release.set()
        assert not upstream.calls
        metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
        assert metrics["timed_out_requests"] == 1
        assert metrics["queued_requests"] == metrics["active_requests"] == 0
        assert_partition(metrics)
        assert chat(client).status_code == 200


def test_response_writing_uses_the_shortened_lifetime():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=2, max_queue=0) as (gateway, client):
        upstream.delay = 0.15
        upstream.body = {"value": "x" * (4 * 1024 * 1024)}
        with socket.socket() as connection:
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            connection.settimeout(1)
            connection.connect((client.base_url.host, client.base_url.port))
            started = time.monotonic()
            connection.sendall(request_headers(client, b"X-MiroFish-Timeout-Ms: 400\r\n") + b"\r\n" + CHAT_BODY)
            assert b"200" in connection.recv(32)
            metrics = observe_until(gateway, lambda m: m["admitted_connections"] == 0)
            assert time.monotonic() - started < 0.9
            assert metrics["succeeded_requests"] == 1
            assert_partition(metrics)
        assert client.get(str(client.base_url).removesuffix("/v1/") + "/health").status_code == 200


def test_capped_clients_share_the_existing_admission_limit_with_uncapped_clients():
    with upstream_server() as upstream, gateway_for(upstream, max_concurrency=1, max_queue=0) as (_, client):
        upstream.release.clear()
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            first = pool.submit(chat, client)
            assert upstream.started.wait(1)
            response = client.post("embeddings", json={"model": "embed", "input": "synthetic"},
                                   headers={CAP_HEADER: "1000"})
            assert response.status_code == 429
            assert len(upstream.calls) == 1
            upstream.release.set()
            assert first.result(timeout=1).status_code == 200


def good_response():
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content='{"ready":true}', tool_calls=[
            SimpleNamespace(function=SimpleNamespace(name="local_check", arguments="{}")),
        ]))], data=[SimpleNamespace(embedding=[1.0, 0.0, 0.0])],
    )


def test_request_helpers_are_fresh_and_match_the_unchanged_sync_cli_contract():
    from app.local_runtime import doctor

    assert doctor.PROBE_IDS == PROBE_IDS
    recorded = []

    def create(operation, **kwargs):
        recorded.append((operation, kwargs))
        return good_response()

    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: create("chat", **kwargs))),
        embeddings=SimpleNamespace(create=lambda **kwargs: create("embeddings", **kwargs)),
    )
    expected = [doctor.probe_request(probe_id, model="test", embedding_model="embed") for probe_id in PROBE_IDS]
    results = doctor.probe_model_capabilities(client, model="test", embedding_model="embed", embedding_dimensions=3)
    assert recorded == expected
    assert results == ["JSON output: OK", "JSON schema: OK", "Tool calling: OK", "Embedding dimensions: 3"]
    for probe_id, (operation, kwargs) in zip(PROBE_IDS, expected):
        saved = copy.deepcopy(kwargs)
        if operation == "chat":
            assert kwargs["max_tokens"] == 512
            kwargs["messages"][0]["content"] = "mutated"
            kwargs.get("response_format", kwargs.get("tools", [{}])).clear()
        else:
            kwargs["input"][0] = "mutated"
        assert "extra_headers" not in kwargs and "timeout" not in kwargs
        assert doctor.probe_request(probe_id, model="test", embedding_model="embed") == (operation, saved)


def test_helpers_and_sync_wrapper_validate_real_sdk_envelopes_over_loopback():
    from app.local_runtime import doctor

    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        upstream.body = {
            "choices": [{"message": {"content": '{"ready":true}', "tool_calls": [
                {"id": "synthetic", "type": "function", "function": {"name": "local_check", "arguments": "{}"}},
            ]}}], "data": [{"embedding": [1.0, 0.0, 0.0]}],
        }
        with OpenAI(base_url=str(client.base_url), api_key="local", max_retries=0) as sdk:
            expected = doctor.probe_model_capabilities(sdk, model="test", embedding_model="embed", embedding_dimensions=3)
            direct = []
            for probe_id in PROBE_IDS:
                operation, kwargs = doctor.probe_request(probe_id, model="test", embedding_model="embed")
                create = sdk.chat.completions.create if operation == "chat" else sdk.embeddings.create
                response = create(**kwargs, extra_headers={CAP_HEADER: "1000"}, timeout=1)
                direct.append(doctor.validate_probe_response(probe_id, response, embedding_dimensions=3))
        assert direct == expected
        assert len(upstream.calls) == 8
        assert all(CAP_HEADER.lower() not in {key.lower() for key in headers} for _, _, headers in upstream.calls)


@pytest.mark.parametrize("probe_id,field,value", [
    ("json_output", "content", '{"ready":1}'),
    ("json_output", "content", '{"ready":true,"extra":NaN}'),
    ("json_output", "content", None),
    ("json_schema", "content", '{"ready":1.0}'),
    ("json_schema", "content", '{"ready":true,"extra":0}'),
    ("tool_call", "arguments", "null"), ("tool_call", "arguments", None),
    ("tool_call", "arguments", '{"unexpected":true}'),
    ("tool_call", "name", "unsafe_tool"),
    ("embedding", "embedding", [1.0, 0.0]),
    ("embedding", "embedding", [True, 0.0, 0.0]),
    ("embedding", "embedding", [float("nan"), 0.0, 0.0]),
    ("embedding", "embedding", [float("inf"), 0.0, 0.0]),
    ("embedding", "embedding", [0.0, 0.0, 0.0]),
    ("embedding", "embedding", [1.7e308, 1.7e308, 0.0]),
])
def test_direct_validator_and_sync_wrapper_reject_the_same_invalid_content(probe_id, field, value):
    from app.local_runtime import doctor

    response = good_response()
    target = (response.data[0] if probe_id == "embedding" else
              response.choices[0].message.tool_calls[0].function if probe_id == "tool_call" else
              response.choices[0].message)
    setattr(target, field, value)
    with pytest.raises(ValueError) as direct:
        doctor.validate_probe_response(probe_id, response, embedding_dimensions=3)
    replies = iter(response if current == probe_id else good_response() for current in PROBE_IDS)
    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: next(replies))),
        embeddings=SimpleNamespace(create=lambda **kwargs: next(replies)),
    )
    with pytest.raises(ValueError) as sync:
        doctor.probe_model_capabilities(client, model="test", embedding_model="embed", embedding_dimensions=3)
    assert str(direct.value) == str(sync.value)


@pytest.mark.parametrize("probe_id", PROBE_IDS)
@pytest.mark.parametrize("response", [None, {}, SimpleNamespace(), SimpleNamespace(choices=[], data=[]),
                                      SimpleNamespace(choices=[None], data=[None])])
def test_malformed_envelopes_have_safe_validation_errors(probe_id, response):
    from app.local_runtime import doctor

    with pytest.raises(ValueError):
        doctor.validate_probe_response(probe_id, response, embedding_dimensions=3)


def test_unknown_probe_ids_are_rejected_by_both_helpers():
    from app.local_runtime import doctor

    with pytest.raises(ValueError):
        doctor.probe_request("unknown", model="test", embedding_model="embed")
    with pytest.raises(ValueError):
        doctor.validate_probe_response("unknown", good_response(), embedding_dimensions=3)
