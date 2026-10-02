"""Network-realistic gateway contracts; no models or external services required."""

import concurrent.futures
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest


GATEWAY_PATH = Path(__file__).parents[1] / "app/local_runtime/gateway.py"


def gateway_module():
    # Load the independent runtime without importing Flask/configuration.
    assert GATEWAY_PATH.exists(), "The local inference gateway is not implemented"
    name = "mirofish_gateway_under_test"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, GATEWAY_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


class Upstream:
    def __init__(self):
        self.calls = []
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.delay = 0
        self.status = 200
        self.headers = {}
        self.body = {"choices": [{"message": {"content": "local response"}}]}
        self.drip = False
        self.omit_length = False


@contextmanager
def upstream_server():
    state = Upstream()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length)) if length else None
            with state.lock:
                state.calls.append((self.path, payload, dict(self.headers)))
                state.active += 1
                state.peak = max(state.peak, state.active)
            state.started.set()
            try:
                state.release.wait(5)
                time.sleep(state.delay)
                body = state.body if isinstance(state.body, bytes) else json.dumps(state.body).encode()
                self.send_response(state.status)
                self.send_header("Content-Type", "application/json")
                if not state.drip and not state.omit_length:
                    self.send_header("Content-Length", str(len(body)))
                for key, value in state.headers.items():
                    self.send_header(key, value)
                self.end_headers()
                if state.drip:
                    for char in body:
                        self.wfile.write(bytes([char]))
                        self.wfile.flush()
                        time.sleep(0.02)
                else:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with state.lock:
                    state.active -= 1

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    state.url = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        yield state
    finally:
        state.release.set()
        server.shutdown()
        server.server_close()
        thread.join(2)


@contextmanager
def gateway_for(upstream, embedding=None, **settings):
    module = gateway_module()
    gateway = module.LocalInferenceGateway(module.GatewaySettings(
        llm_base_url=upstream.url,
        embedding_base_url=(embedding or upstream).url,
        **settings,
    ))
    base_url = gateway.start()
    try:
        with httpx.Client(base_url=base_url + "/", trust_env=False, timeout=5) as client:
            yield gateway, client
    finally:
        gateway.close()


def chat(client, **kwargs):
    return client.post("chat/completions", json={
        "model": "local-model", "messages": [{"role": "user", "content": "hello"}], **kwargs,
    })


@pytest.mark.parametrize(("url", "expected"), [
    ("http://localhost:11434/v1/", "http://127.0.0.1:11434/v1"),
    ("https://127.0.0.2:443/v1", "https://127.0.0.2:443/v1"),
    ("http://[::1]:8080", "http://[::1]:8080"),
])
def test_only_literal_loopback_urls_are_normalized(url, expected):
    assert gateway_module().validate_loopback_url(url) == expected


@pytest.mark.parametrize("url", [
    "https://api.openai.com/v1", "http://localhost.example/v1", "http://0.0.0.0/v1",
    "http://192.168.1.1/v1", "http://169.254.169.254/v1", "http://127.1/v1",
    "http://2130706433/v1", "http://0177.0.0.1/v1", "http://user:password@localhost/v1",
    "http://127.0.0.1/v1?target=elsewhere", "http://127.0.0.1/v1#fragment",
    "http://127.0.0.1/v1?", "http://127.0.0.1/v1#", "file://localhost/v1",
    "http://localhost:0/v1", "http://localhost:65536/v1", "http://localhost:/v1",
    "http://localhost\n/v1", " http://localhost/v1", "http://localhost./v1",
    "http://[::ffff:127.0.0.1]/v1", "http://[::1%25lo]/v1", "http://localhost/%2e%2e/",
    "http://localhost\\@example.com/v1", "http://localhost/v1/../elsewhere",
])
def test_unsafe_urls_rejected_without_resolving_dns(url, monkeypatch):
    def no_dns(*_args, **_kwargs):
        pytest.fail("URL validation must not resolve DNS")
    monkeypatch.setattr(socket, "getaddrinfo", no_dns)
    with pytest.raises(ValueError):
        gateway_module().validate_loopback_url(url)


@pytest.mark.parametrize("field,value", [
    ("max_concurrency", 0), ("max_concurrency", True), ("max_queue", -1),
    ("request_timeout", 0), ("request_timeout", float("nan")),
    ("max_output_tokens", 0), ("max_input_chars", 0),
])
def test_invalid_budgets_fail_before_listening(field, value):
    module = gateway_module()
    with pytest.raises(ValueError):
        module.LocalInferenceGateway(module.GatewaySettings(
            "http://localhost:11434/v1", "http://localhost:11434/v1", **{field: value}
        ))


def test_default_token_limit_and_metadata_forwarding_use_only_literal_local_auth(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "private-cloud-secret")
    with upstream_server() as upstream, gateway_for(upstream, max_output_tokens=9) as (_, client):
        metadata = {
            "tools": [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}],
            "tool_choice": "auto", "response_format": {"type": "json_object"},
        }
        response = chat(client, **metadata)
        assert response.status_code == 200
        path, payload, headers = upstream.calls[0]
        assert path == "/v1/chat/completions"
        assert payload["max_tokens"] == 9
        assert all(payload[key] == value for key, value in metadata.items())
        assert headers["Authorization"] == "Bearer local"
        assert "private-cloud-secret" not in str(headers)


@pytest.mark.parametrize("limits,expected", [
    ({"max_tokens": 100}, {"max_tokens": 9}),
    ({"max_completion_tokens": 100}, {"max_completion_tokens": 9}),
    ({"max_tokens": 3, "max_completion_tokens": 100}, {"max_tokens": 3, "max_completion_tokens": 9}),
])
def test_each_token_limit_is_clamped(limits, expected):
    with upstream_server() as upstream, gateway_for(upstream, max_output_tokens=9) as (_, client):
        assert chat(client, **limits).status_code == 200
        payload = upstream.calls[0][1]
        for key, value in expected.items():
            assert payload[key] == value


@pytest.mark.parametrize("extra", [
    {"stream": True}, {"max_tokens": -1}, {"max_tokens": True}, {"max_tokens": "999"},
    {"n": 2}, {"messages": [{"role": "user", "content": "x" * 300}]},
    {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/image"}}]}]},
])
def test_unbounded_or_unsupported_inputs_never_reach_upstream(extra):
    with upstream_server() as upstream, gateway_for(upstream, max_input_chars=200) as (_, client):
        assert chat(client, **extra).status_code in (400, 413)
        assert upstream.calls == []


def test_embeddings_models_and_health_are_routed_to_the_correct_local_target():
    with upstream_server() as llm, upstream_server() as embed, gateway_for(llm, embed) as (_, client):
        llm.body = {"object": "list", "data": [{"id": "local-model"}]}
        embed.body = {"data": [{"embedding": [0.1, 0.2]}]}
        response = client.post("embeddings", json={"model": "local-embed", "input": ["a", "b"]})
        assert response.json() == embed.body
        assert client.get("models").json() == llm.body
        assert client.get(str(client.base_url).removesuffix("/v1/") + "/health").json()["status"] == "ok"
        assert [call[0] for call in llm.calls] == ["/v1/models"]
        assert [call[0] for call in embed.calls] == ["/v1/embeddings"]


@pytest.mark.parametrize("method,path", [
    ("POST", "models"), ("GET", "chat/completions"), ("DELETE", "models"),
    ("PUT", "embeddings"), ("POST", "responses"), ("POST", "chat/completions?url=http://example.com"),
])
def test_unrecognized_paths_and_methods_cannot_proxy(method, path):
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        assert client.request(method, path, json={}).status_code in (400, 404, 405)
        assert not upstream.calls


def test_redirects_never_follow_or_escape_the_gateway():
    with upstream_server() as upstream, upstream_server() as destination, gateway_for(upstream) as (_, client):
        upstream.status = 307
        upstream.headers["Location"] = destination.url + "/chat/completions"
        response = chat(client)
        assert response.status_code == 502
        assert "location" not in response.headers
        assert not destination.calls


def test_environment_proxies_and_incoming_credentials_are_ignored(monkeypatch):
    with upstream_server() as upstream, upstream_server() as proxy:
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            monkeypatch.setenv(key, proxy.url)
        monkeypatch.setenv("NO_PROXY", "")
        monkeypatch.setenv("no_proxy", "")
        with gateway_for(upstream) as (_, client):
            response = client.post("chat/completions", headers={"Authorization": "Bearer incoming-secret"},
                                   json={"model": "local-model", "messages": [{"role": "user", "content": "hi"}]})
            assert response.status_code == 200
            assert upstream.calls[0][2]["Authorization"] == "Bearer local"
            assert not proxy.calls


def test_queue_is_bounded_and_chat_embeddings_share_a_single_budget():
    with upstream_server() as upstream, gateway_for(upstream, max_concurrency=1, max_queue=0) as (_, client):
        upstream.release.clear()
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            first = pool.submit(chat, client)
            assert upstream.started.wait(2)
            response = client.post("embeddings", json={"model": "local-embed", "input": "second"})
            assert response.status_code == 429
            assert response.headers["Retry-After"] == "1"
            assert upstream.peak == 1
            upstream.release.set()
            assert first.result().status_code == 200


def test_clients_in_distinct_processes_share_the_same_inference_budget():
    with upstream_server() as upstream, gateway_for(upstream, max_concurrency=1, max_queue=4) as (_, client):
        upstream.delay = 0.12
        script = """
import json, sys, urllib.request
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
request = urllib.request.Request(sys.argv[1], data=json.dumps({'model':'local-embed','input':'hello'}).encode(), headers={'Content-Type':'application/json'})
with opener.open(request, timeout=5) as response:
    assert response.status == 200
"""
        children = [subprocess.Popen([sys.executable, "-c", script, str(client.base_url) + "embeddings"],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
        for child in children:
            stdout, stderr = child.communicate(timeout=8)
            assert child.returncode == 0, (stdout, stderr)
        assert len(upstream.calls) == 4
        assert upstream.peak == 1


def test_timeout_releases_capacity_and_hides_upstream_error_details():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=0.1) as (_, client):
        upstream.delay = 0.3
        response = chat(client)
        assert response.status_code == 504
        upstream.delay = 0
        upstream.status = 500
        upstream.body = {"error": "secret prompt and local filepath"}
        response = chat(client)
        assert response.status_code == 502
        assert "secret prompt" not in response.text
        upstream.status = 200
        assert chat(client).status_code == 200


def test_slow_drip_response_has_a_total_deadline():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=0.12) as (_, client):
        upstream.drip = True
        started = time.monotonic()
        assert chat(client).status_code == 504
        assert time.monotonic() - started < 0.5


def test_large_wire_requests_and_upstream_responses_are_bounded():
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        response = client.post("chat/completions", content=b"x" * (1024 * 1024 + 1))
        assert response.status_code == 413
        assert not upstream.calls
        upstream.body = b"x" * (8 * 1024 * 1024 + 1)
        assert chat(client).status_code == 502


def test_server_can_close_idempotently_and_reject_new_connections():
    with upstream_server() as upstream:
        module = gateway_module()
        gateway = module.LocalInferenceGateway(module.GatewaySettings(upstream.url, upstream.url))
        base_url = gateway.start()
        assert gateway.start() == base_url
        with httpx.Client(trust_env=False) as client:
            assert client.get(base_url.removesuffix("/v1") + "/health").status_code == 200
            gateway.close()
            gateway.close()
            with pytest.raises(httpx.ConnectError):
                client.get(base_url + "/models")
            with pytest.raises(RuntimeError):
                gateway.start()


def test_alternate_loopback_protocols_require_explicit_allowlist():
    module = gateway_module()
    assert module.validate_loopback_url("bolt://localhost:7687", schemes=("bolt", "neo4j")) == "bolt://127.0.0.1:7687"
    with pytest.raises(ValueError):
        module.validate_loopback_url("bolt://localhost:7687")


@pytest.mark.parametrize("payload", [
    {"input": "x" * 300}, {"input": ["x" * 100] * 3}, {"input": list(range(300))},
    {"input": [[1] * 100] * 3}, {"input": {"url": "http://example.com/data"}},
])
def test_embedding_input_limit_includes_batches_and_token_arrays(payload):
    with upstream_server() as upstream, gateway_for(upstream, max_input_chars=200) as (_, client):
        assert client.post("embeddings", json={"model": "local-embed", **payload}).status_code in (400, 413)
        assert not upstream.calls


@pytest.mark.parametrize("body,headers", [
    (b"not json", {}),
    (b"{}", {"Content-Type": "text/html"}),
    (b"{}", {"Content-Encoding": "gzip"}),
])
def test_invalid_response_bodies_and_compression_are_rejected(body, headers):
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        upstream.body = body
        upstream.headers.update(headers)
        assert chat(client).status_code == 502


def test_unknown_length_response_is_size_capped_before_returning_to_caller():
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        upstream.body = b" " * (8 * 1024 * 1024 + 1)
        # Omitting content length without slow dripping exercises streaming cap.
        upstream.omit_length = True
        assert chat(client).status_code == 502


def test_tools_and_tool_result_messages_keep_their_structured_fields():
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        messages = [
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "call_a", "type": "function", "function": {"name": "look_up", "arguments": "{}"}}]},
            {"role": "tool", "content": "result", "tool_call_id": "call_a"},
        ]
        assert chat(client, messages=messages).status_code == 200
        assert upstream.calls[0][1]["messages"] == messages


def test_request_logs_do_not_echo_prompts_or_paths(capsys):
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        assert chat(client, messages=[{"role": "user", "content": "PRIVATE PROMPT MARKER"}]).status_code == 200
        assert client.get("PRIVATE PATH MARKER").status_code == 404
    captured = capsys.readouterr()
    assert "PRIVATE" not in captured.out + captured.err


def test_json_request_content_type_is_required_to_prevent_browser_form_submission():
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        response = client.post("chat/completions", headers={"Content-Type": "text/plain"},
                               content=json.dumps({"messages": [{"role": "user", "content": "hi"}]}))
        assert response.status_code == 415
        assert not upstream.calls


def test_origin_and_host_validation_reject_cross_site_loopback_requests():
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        for headers in ({"Origin": "https://attacker.example"}, {"Host": "attacker.example"}):
            response = client.post("chat/completions", headers=headers,
                                   json={"model": "local-model", "messages": [{"role": "user", "content": "hi"}]})
            assert response.status_code == 403
        assert not upstream.calls


def test_close_while_requests_are_running_cancels_gateway_workers():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=5) as (gateway, client):
        upstream.release.clear()
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending = pool.submit(chat, client)
            assert upstream.started.wait(2)
            started = time.monotonic()
            gateway.close()
            assert time.monotonic() - started < 1
            with pytest.raises(httpx.TransportError):
                pending.result(timeout=2)
            upstream.release.set()


def test_cookie_state_never_persists_or_crosses_local_model_endpoints():
    with upstream_server() as llm, upstream_server() as embedding, gateway_for(llm, embedding) as (_, client):
        llm.headers["Set-Cookie"] = "private_llm_session=SECRET; Path=/"
        embedding.headers["Set-Cookie"] = "private_embed_session=OTHER; Path=/"
        assert chat(client).status_code == 200
        assert client.post("embeddings", json={"model": "local-embed", "input": "embedding"}).status_code == 200
        assert chat(client).status_code == 200
        assert client.post("embeddings", json={"model": "local-embed", "input": "again"}).status_code == 200
        for _, _, headers in llm.calls + embedding.calls:
            assert "Cookie" not in headers


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_nonstandard_json_constants_in_responses_are_rejected(constant):
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        upstream.body = ('{"data": [{"embedding": [' + constant + ']}]}').encode()
        response = client.post("embeddings", json={"model": "local-embed", "input": "valid"})
        assert response.status_code == 502
        assert "invalid JSON" in response.json()["error"]["message"]


@pytest.mark.parametrize("reasoning_effort", ["", " ", 1, False, {}])
def test_configured_reasoning_effort_is_none_or_a_nonempty_string(reasoning_effort):
    module = gateway_module()
    with pytest.raises(ValueError):
        module.GatewaySettings("http://localhost:11434/v1", "http://localhost:11434/v1",
                               reasoning_effort=reasoning_effort)


def test_configured_reasoning_effort_overrides_both_effort_fields():
    with upstream_server() as upstream, gateway_for(upstream, reasoning_effort="none") as (_, client):
        assert chat(client).status_code == 200
        assert upstream.calls[-1][1]["reasoning_effort"] == "none"
        assert chat(client, reasoning_effort="high", reasoning={"effort": "high", "summary": "auto"}).status_code == 200
        assert upstream.calls[-1][1]["reasoning_effort"] == "none"
        assert upstream.calls[-1][1]["reasoning"] == {"effort": "none", "summary": "auto"}
        assert client.post("embeddings", json={"model": "local-embed", "input": "hi"}).status_code == 200
        assert "reasoning_effort" not in upstream.calls[-1][1]


def test_unconfigured_reasoning_effort_preserves_existing_request_fields():
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        assert chat(client).status_code == 200
        assert "reasoning_effort" not in upstream.calls[-1][1]
        assert chat(client, reasoning_effort="low", reasoning={"effort": "low"}).status_code == 200
        assert upstream.calls[-1][1]["reasoning_effort"] == "low"
        assert upstream.calls[-1][1]["reasoning"] == {"effort": "low"}


def test_nonobject_nested_reasoning_cannot_override_configured_effort():
    with upstream_server() as upstream, gateway_for(upstream, reasoning_effort="none") as (_, client):
        assert chat(client, reasoning="high").status_code == 400
        assert not upstream.calls


@pytest.mark.parametrize("model", [None, "", " ", 123, "qwen3.5:cloud", "gpt-oss:120b-cloud", "Qwen3.5:Cloud "])
@pytest.mark.parametrize("endpoint", ["chat/completions", "embeddings"])
def test_models_must_be_named_and_cannot_use_obvious_cloud_routes(model, endpoint):
    with upstream_server() as upstream, gateway_for(upstream) as (_, client):
        payload = {"messages": [{"role": "user", "content": "hi"}]} if endpoint == "chat/completions" else {"input": "hi"}
        if model is not None:
            payload["model"] = model
        assert client.post(endpoint, json=payload).status_code == 400
        assert not upstream.calls


def test_slow_response_reader_cannot_extend_total_request_deadline():
    with upstream_server() as upstream, gateway_for(upstream, request_timeout=0.4, max_queue=0) as (_, client):
        upstream.delay = 0.2
        upstream.body = {"value": "x" * (4 * 1024 * 1024)}
        host = client.base_url.host
        port = client.base_url.port
        with socket.socket() as slow_client:
            slow_client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            slow_client.settimeout(2)
            slow_client.connect((host, port))
            body = json.dumps({"model": "local-model", "messages": [{"role": "user", "content": "hi"}]}).encode()
            slow_client.sendall((f"POST /v1/chat/completions HTTP/1.1\r\nHost: {host}:{port}\r\n"
                                 f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body)
            assert b"200" in slow_client.recv(32)
            # Leave the response unread beyond the remaining lifetime, but less
            # than a fresh request_timeout added after the upstream response.
            time.sleep(0.28)
            assert client.get(str(client.base_url).removesuffix("/v1/") + "/health").status_code == 200
