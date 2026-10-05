"""Adversarial HTTP boundaries for local prompt trials, without inference."""

from io import BytesIO
import json
import sys
from types import ModuleType, SimpleNamespace

from flask import Flask, Request
import pytest

from app import local_runtime
from app.config import Config
from test_prompt_trials import trials as trials, finished, forbid_trial_work
from test_local_readiness import synthetic_models


REQUEST_ID = "a1234567-89ab-4cde-8fab-0123456789ab"
BASE = "/api/runtime/trials"
MAX_BODY_BYTES = 32768
ROUTES = [("get", BASE), ("post", BASE), ("get", BASE + "/" + REQUEST_ID)]


def valid_body(**changes):
    value = {
        "request_id": REQUEST_ID,
        "label": "Compare a concise answer",
        "system_prompt": "Answer concisely.",
        "user_prompt": "Explain a local prompt trial.",
        "temperature": 0.5,
        "max_output_tokens": 128,
    }
    return {**value, **changes}


@pytest.fixture
def api(monkeypatch):
    from app.api import runtime_bp

    calls = []
    data = {"schema_version": 1, "kind": "mirofish_local_prompt_trials", "run": None}
    service = ModuleType("app.local_runtime.prompt_trials")

    class PromptTrialError(Exception):
        def __init__(self, code, status_code, snapshot=None):
            super().__init__("PRIVATE credentials, prompt, and response")
            self.code, self.status_code, self.snapshot = code, status_code, snapshot

    service.PromptTrialError = PromptTrialError
    for name in ("get_prompt_trials_snapshot", "start_prompt_trial"):
        def call(*args, name=name):
            calls.append((name, args))
            return data
        setattr(service, name, call)
    # The factory may register cleanup, but neither registration nor GET may run a trial.
    service.register_prompt_trials_shutdown = lambda: None
    monkeypatch.setitem(sys.modules, service.__name__, service)
    monkeypatch.setattr(local_runtime, "prompt_trials", service, raising=False)
    app = Flask(__name__)
    app.register_blueprint(runtime_bp, url_prefix="/api/runtime")
    return app.test_client(), service, calls, data


def check(response, status):
    assert response.status_code == status, response.get_data(as_text=True)
    assert response.headers.get("Cache-Control") == "no-store"
    assert "PRIVATE" not in response.get_data(as_text=True)
    return response.get_json()


def request_route(client, method, path, **kwargs):
    if method == "post" and "data" not in kwargs:
        kwargs.setdefault("json", valid_body())
    return getattr(client, method)(path, **kwargs)


def test_passive_reads_and_explicit_post_call_distinct_services(api):
    client, _, calls, data = api
    assert check(client.get(BASE), 200) == {"success": True, "data": data}
    assert check(client.get(BASE + "/" + REQUEST_ID), 200) == {"success": True, "data": data}
    payload = valid_body()
    for _ in range(2):
        # Replayed POSTs retain 202; deduplication belongs to the service.
        assert check(client.post(BASE, json=payload), 202) == {"success": True, "data": data}
    assert calls == [
        ("get_prompt_trials_snapshot", ()),
        ("get_prompt_trials_snapshot", (REQUEST_ID,)),
        ("start_prompt_trial", (payload,)),
        ("start_prompt_trial", (payload,)),
    ]


@pytest.mark.parametrize("method,path", ROUTES)
@pytest.mark.parametrize("query", ["?unknown=1", "?x=1&x=2", "?%00=PRIVATE", "?=", "?&"])
def test_queries_rejected_before_service(api, method, path, query):
    client, _, calls, _ = api
    assert check(request_route(client, method, path + query), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("method,path", ROUTES)
def test_empty_query_is_not_a_query_parameter(api, method, path):
    client, _, calls, _ = api
    check(request_route(client, method, path + "?"), 202 if method == "post" else 200)
    assert len(calls) == 1


@pytest.mark.parametrize("request_id", [
    "bad", "PRIVATE", "0" * 32, "{" + REQUEST_ID + "}", REQUEST_ID.upper(),
    "urn:uuid:" + REQUEST_ID, " " + REQUEST_ID, REQUEST_ID + " ",
])
def test_detail_requires_a_canonical_uuid_before_service(api, request_id):
    client, _, calls, _ = api
    assert check(client.get(BASE + "/" + request_id), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("missing", list(valid_body()))
def test_all_exact_fields_are_required(api, missing):
    client, _, calls, _ = api
    payload = valid_body()
    del payload[missing]
    assert check(client.post(BASE, json=payload), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("extra", ["model", "base_url", "api_key", "timeout", "force", "PRIVATE"])
def test_unknown_fields_cannot_change_gateway_configuration(api, extra):
    client, _, calls, _ = api
    assert check(client.post(BASE, json=valid_body(**{extra: "PRIVATE"})), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("field,value", [
    ("request_id", None), ("request_id", True), ("request_id", 1), ("request_id", []),
    ("request_id", REQUEST_ID.upper()), ("request_id", "0" * 32),
    ("request_id", "{" + REQUEST_ID + "}"), ("request_id", " " + REQUEST_ID),
    ("label", None), ("label", False), ("label", 1), ("label", []), ("label", {}),
    ("label", ""), ("label", " \t\r\n"), ("label", "\u00a0\u2003"), ("label", "a" * 81),
    ("system_prompt", None), ("system_prompt", False), ("system_prompt", 1),
    ("system_prompt", []), ("system_prompt", {}), ("system_prompt", "s" * 1001),
    ("user_prompt", None), ("user_prompt", False), ("user_prompt", 1),
    ("user_prompt", []), ("user_prompt", {}), ("user_prompt", ""),
    ("user_prompt", " \t\n\r"), ("user_prompt", "\u00a0\u2003"), ("user_prompt", "u" * 4001),
    ("user_prompt", "\ufeff"), ("user_prompt", " \ufeff\t\ufeff\n "),
    ("temperature", None), ("temperature", True), ("temperature", False),
    ("temperature", "0.5"), ("temperature", []), ("temperature", {}),
    ("temperature", -0.001), ("temperature", 1.001),
    ("max_output_tokens", None), ("max_output_tokens", True), ("max_output_tokens", False),
    ("max_output_tokens", "128"), ("max_output_tokens", []), ("max_output_tokens", {}),
    ("max_output_tokens", 0), ("max_output_tokens", -1), ("max_output_tokens", 513),
    ("max_output_tokens", 1.0), ("max_output_tokens", 10**100),
])
def test_invalid_field_values_never_reach_service(api, field, value):
    client, _, calls, _ = api
    assert check(client.post(BASE, json=valid_body(**{field: value})), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("field", ["label", "system_prompt", "user_prompt"])
@pytest.mark.parametrize("character", ["\x00", "\x01", "\x08", "\x0b", "\x0c", "\x1f", "\x7f", "\x85", "\ud800", "\udfff"])
def test_controls_and_unpaired_surrogates_are_rejected(api, field, character):
    client, _, calls, _ = api
    raw = json.dumps(valid_body(**{field: "safe" + character + "PRIVATE"}))
    assert check(client.post(BASE, data=raw, content_type="application/json"), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("character", ["\t", "\r", "\n"])
def test_label_cannot_contain_prompt_only_whitespace_controls(api, character):
    client, _, calls, _ = api
    assert check(client.post(BASE, json=valid_body(label="before" + character + "after")), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("changes", [
    {"system_prompt": "", "temperature": 0, "max_output_tokens": 1},
    {"system_prompt": " \r\n\t ", "temperature": 1, "max_output_tokens": 512},
    {"label": "a" * 80, "system_prompt": "s" * 1000, "user_prompt": "u" * 4000},
    {"label": "界" * 80, "system_prompt": "🤖" * 1000, "user_prompt": "界" * 4000},
    {"label": "  A useful label  ", "system_prompt": "before\r\n\tafter", "user_prompt": "before\r\n\tafter"},
    {"system_prompt": "\ufeff", "user_prompt": "\ufeffnonblank text\ufeff"},
])
def test_valid_boundaries_and_unicode_are_preserved(api, changes):
    client, _, calls, _ = api
    payload = valid_body(**changes)
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    check(client.post(BASE, data=raw, content_type="application/json; charset=utf-8"), 202)
    assert calls == [("start_prompt_trial", (payload,))]


@pytest.mark.parametrize("raw,content_type", [
    ("", "application/json"), ("{}", "text/plain"), ("{}", None),
    ("{}", "application/problem+json"), ("null", "application/json"),
    ("[]", "application/json"), ("true", "application/json"), ("12", "application/json"),
    ('"PRIVATE"', "application/json"), ("{", "application/json"),
    ("{}{}", "application/json"), ("{} trailing", "application/json"),
    (b"\xff{}", "application/json"), (b"\xef\xbb\xbf{}", "application/json"),
    ('{"user_prompt":"PRIVATE"}'.encode("utf-16"), "application/json"),
])
def test_invalid_json_or_media_type_never_reaches_service(api, raw, content_type):
    client, _, calls, _ = api
    assert check(client.post(BASE, data=raw, content_type=content_type), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("key", ['"label"', '"la\\u0062el"'])
def test_duplicate_keys_including_escaped_collisions_are_rejected(api, key):
    client, _, calls, _ = api
    raw = json.dumps(valid_body())[:-1] + "," + key + ':"PRIVATE"}'
    assert check(client.post(BASE, data=raw, content_type="application/json"), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("field", ["temperature", "max_output_tokens"])
@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"])
def test_nonfinite_numbers_are_rejected_before_service(api, field, constant):
    client, _, calls, _ = api
    payload = valid_body()
    del payload[field]
    raw = json.dumps(payload)[:-1] + ',"' + field + '":' + constant + "}"
    assert check(client.post(BASE, data=raw, content_type="application/json"), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("value", ["[" * 1100 + "0" + "]" * 1100, "9" * 5000])
def test_pathological_json_values_are_safe_invalid_requests(api, value):
    client, _, calls, _ = api
    payload = valid_body()
    del payload["max_output_tokens"]
    raw = json.dumps(payload)[:-1] + ',"max_output_tokens":' + value + "}"
    assert check(client.post(BASE, data=raw, content_type="application/json"), 400)["error_code"] == "invalid_request"
    assert calls == []


class BoundedInput(BytesIO):
    """Detect eager/unbounded body reads as well as their eventual rejection."""

    def __init__(self, content):
        super().__init__(content)
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        assert 0 <= size <= MAX_BODY_BYTES + 1, "Request body was read without a byte bound"
        return super().read(size)

    def readinto(self, buffer):
        self.read_sizes.append(len(buffer))
        assert len(buffer) <= MAX_BODY_BYTES + 1, "Request body was read without a byte bound"
        return super().readinto(buffer)


@pytest.mark.parametrize("length_known", [True, False])
@pytest.mark.parametrize("size,status", [(MAX_BODY_BYTES, 202), (MAX_BODY_BYTES + 1, 400)])
def test_body_byte_cap_with_and_without_content_length(api, length_known, size, status):
    client, _, calls, _ = api
    raw = json.dumps(valid_body()).encode("utf-8")
    stream = BoundedInput(raw + b" " * (size - len(raw)))
    environ = {"wsgi.input": stream, "CONTENT_TYPE": "application/json"}
    if length_known:
        environ["CONTENT_LENGTH"] = str(size)
    else:
        environ.update(CONTENT_LENGTH="", **{"wsgi.input_terminated": True})
    response = client.open(BASE, method="POST", environ_overrides=environ)
    body = check(response, status)
    if status == 400:
        assert body["error_code"] == "invalid_request"
        assert calls == []
        if length_known:
            assert stream.read_sizes == []
    else:
        assert calls == [("start_prompt_trial", (valid_body(),))]
    assert stream.tell() <= MAX_BODY_BYTES + 1


def test_declared_large_body_is_rejected_without_reading(api):
    client, _, calls, _ = api
    stream = BoundedInput(b"PRIVATE")
    response = client.open(BASE, method="POST", environ_overrides={
        "wsgi.input": stream, "CONTENT_LENGTH": "999999999", "CONTENT_TYPE": "application/json",
    })
    assert check(response, 400)["error_code"] == "invalid_request"
    assert stream.read_sizes == []
    assert calls == []


@pytest.mark.parametrize("suffix,headers,status,code", [
    ("?extra=1", {}, 400, "invalid_request"),
    ("", {"Sec-Fetch-Site": "cross-site"}, 403, "local_browser_required"),
    ("", {"Origin": "https://attacker.example"}, 403, "local_browser_required"),
])
def test_invalid_request_metadata_never_reads_prompt_bytes(api, suffix, headers, status, code):
    client, _, calls, _ = api
    stream = BoundedInput(json.dumps(valid_body()).encode("utf-8"))
    response = client.open(BASE + suffix, method="POST", headers=headers, environ_overrides={
        "wsgi.input": stream, "wsgi.input_terminated": True,
        "CONTENT_LENGTH": "", "CONTENT_TYPE": "application/json",
    })
    assert check(response, status)["error_code"] == code
    assert stream.read_sizes == []
    assert calls == []


def test_truncated_input_stream_is_a_safe_invalid_request(api):
    client, _, calls, _ = api
    response = client.open(BASE, method="POST", environ_overrides={
        "wsgi.input": BytesIO(b"{"), "CONTENT_LENGTH": "2", "CONTENT_TYPE": "application/json",
    })
    assert check(response, 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("method,path", ROUTES)
@pytest.mark.parametrize("headers", [
    {"Host": "attacker.example"}, {"Host": "localhost.attacker.example"},
    {"Host": "192.168.1.1"}, {"Host": "0.0.0.0"}, {"Host": "127.1"},
    {"Host": "user@localhost"}, {"Host": "localhost/path"},
    {"Host": "[::ffff:127.0.0.1]"},
    {"Origin": "https://attacker.example"}, {"Origin": "http://192.168.1.1"},
    {"Origin": "null"}, {"Origin": "file://localhost"},
    {"Origin": "http://user@localhost"}, {"Origin": "http://localhost/path"},
    {"Origin": "http://localhost?x=1"}, {"Origin": "http://localhost#fragment"},
    {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
    {"Sec-Fetch-Site": "Same-Origin"}, {"Sec-Fetch-Site": "PRIVATE"},
    {"Sec-Fetch-Site": "same-origin", "Origin": "https://attacker.example"},
    {"Sec-Fetch-Site": "none", "Host": "attacker.example"},
    {"Host": "localhost:5001", "Origin": "http://localhost:3000"},
    {"Host": "localhost", "Origin": "https://localhost"},
    {"Host": "localhost", "Origin": "http://127.0.0.1"},
    {"Host": "localhost", "Origin": "http://[::1]"},
    {"Host": "attacker.example", "X-Forwarded-Host": "localhost", "Forwarded": "host=localhost"},
    {"Host": "localhost:5001", "Origin": "http://localhost:3000", "X-Forwarded-Host": "localhost:3000"},
])
def test_browser_provenance_denials_happen_before_service(api, method, path, headers):
    client, _, calls, _ = api
    response = request_route(client, method, path, headers=headers)
    assert check(response, 403)["error_code"] == "local_browser_required"
    assert calls == []


@pytest.mark.parametrize("method,path", ROUTES)
def test_invalid_host_port_is_rejected_in_request_dispatch(api, method, path):
    client, _, calls, _ = api
    # Werkzeug's test client's cookie bookkeeping rejects this Host before or
    # after dispatch. A request context exercises the Flask boundary directly.
    kwargs = {"json": valid_body()} if method == "post" else {}
    with client.application.test_request_context(
        path, method=method.upper(), headers={"Host": "localhost:65536"}, **kwargs,
    ):
        response = client.application.full_dispatch_request()
    assert check(response, 403)["error_code"] == "local_browser_required"
    assert calls == []


@pytest.mark.parametrize("method,path", ROUTES)
@pytest.mark.parametrize("headers", [
    {}, {"Host": "127.0.0.1:5001"}, {"Host": "[::1]:5001"},
    {"Host": "localhost:5001", "Origin": "http://localhost:5001"},
    {"Host": "localhost", "Origin": "http://localhost:80"},
    {"Host": "LOCALHOST", "Origin": "http://localhost"},
    {"Host": "127.0.0.1", "Origin": "http://127.0.0.1"},
    {"Host": "[::1]", "Origin": "http://[::1]"},
    {"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Site": "same-origin"},
    {"Host": "127.0.0.1:5001", "Origin": "http://localhost:3000", "Sec-Fetch-Site": "same-origin"},
    {"Host": "localhost:5001", "Origin": "http://localhost:3000", "Sec-Fetch-Site": "none"},
    {"X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "https", "Forwarded": "host=attacker.example"},
])
def test_local_cli_same_origin_and_browser_proxy_requests_are_allowed(api, method, path, headers):
    client, _, calls, _ = api
    check(request_route(client, method, path, headers=headers), 202 if method == "post" else 200)
    assert len(calls) == 1


@pytest.mark.parametrize("code,status", [
    ("invalid_request", 400), ("local_browser_required", 403), ("local_mode_required", 403),
    ("already_running", 409), ("request_conflict", 409), ("run_not_found", 404),
    ("trials_unavailable", 503), ("invalid_configuration", 503), ("internal_failure", 500),
])
def test_service_errors_have_fixed_statuses_and_only_conflicts_can_include_data(api, code, status):
    client, service, _, data = api

    def fail(*args):
        raise service.PromptTrialError(code, 418, snapshot=data)

    service.start_prompt_trial = fail
    body = check(client.post(BASE, json=valid_body()), status)
    assert body["success"] is False
    assert body["error_code"] == code
    assert isinstance(body["error"], str) and body["error"]
    if status == 409:
        assert body["data"] == data
    else:
        assert "data" not in body


@pytest.mark.parametrize("method,path", ROUTES)
@pytest.mark.parametrize("kind", ["unknown_service", "ordinary"])
def test_unknown_failures_never_echo_exception_details_or_snapshot(api, method, path, kind):
    client, service, _, _ = api

    def fail(*args):
        if kind == "ordinary":
            raise RuntimeError("PRIVATE credentials and model response /private/path")
        raise service.PromptTrialError("PRIVATE", 418, snapshot={"PRIVATE": "secret"})

    service.get_prompt_trials_snapshot = fail
    service.start_prompt_trial = fail
    body = check(request_route(client, method, path), 500)
    assert body["error_code"] == "internal_failure"
    assert "data" not in body
    assert "/private/path" not in json.dumps(body)


def factory_app(monkeypatch):
    import app as app_module
    from app import create_app
    from app.local_runtime import readiness
    from app.services.simulation_runner import SimulationRunner

    logs = []
    logger = SimpleNamespace(debug=logs.append, info=lambda *args: None)
    monkeypatch.setattr(app_module, "get_logger", lambda *args: logger)
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "DEBUG", True)
    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    monkeypatch.setattr(local_runtime, "configure_local_environment", lambda: None)
    monkeypatch.setattr(readiness, "register_readiness_shutdown", lambda: None)
    return create_app(), logs


def test_factory_zero_queue_is_unavailable_and_repeated_posts_start_nothing(trials, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MAX_QUEUE", 0)
    app, _ = factory_app(monkeypatch)
    client = app.test_client()
    forbid_trial_work(trials, monkeypatch)
    for _ in range(3):
        snapshot = check(client.get(BASE), 200)["data"]
        assert snapshot["available"] is False
        assert snapshot["unavailable_code"] == "invalid_configuration"
        assert snapshot["run"] is None
        assert check(client.post(BASE, json=valid_body()), 503) == {
            "success": False,
            "error_code": "invalid_configuration",
            "error": "The loaded local model configuration is unavailable",
        }
        assert check(client.get(BASE + "/" + REQUEST_ID), 404)["error_code"] == "run_not_found"
        assert trials._manager is None
        assert local_runtime._gateway is None
        assert local_runtime._gateway_starting is None


def test_factory_positive_queue_admits_real_trial(trials, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MAX_QUEUE", 1)
    app, _ = factory_app(monkeypatch)
    monkeypatch.setattr(Config, "DEBUG", False)
    client = app.test_client()
    with synthetic_models(monkeypatch) as models:
        assert check(client.get(BASE), 200)["data"]["available"] is True
        admitted = check(client.post(BASE, json=valid_body()), 202)["data"]
        assert admitted["run"]["request_id"] == REQUEST_ID
        result = finished(trials)
        trials._manager.thread.join(2)
        assert not trials._manager.thread.is_alive()
        assert result["run"]["state"] == "succeeded"
        assert result["run"]["cleanup"]["state"] == "succeeded"
        assert len(models.calls) == 1
        assert local_runtime._gateway.snapshot()["limits"]["max_queue"] == 1
        assert check(client.get(BASE + "/" + REQUEST_ID), 200)["data"]["run"] == result["run"]


@pytest.mark.parametrize("suffix", ["", "/" + REQUEST_ID, "/unknown/subpath"])
def test_factory_does_not_parse_or_log_prompt_bodies_on_trials_prefix(api, monkeypatch, suffix):
    app, logs = factory_app(monkeypatch)

    def forbidden(*args, **kwargs):
        pytest.fail("The request logger parsed a private trial body")

    # The route uses its own bounded parser. The logger must never invoke Flask's
    # eager get_json, even on unsupported methods and unknown trial subpaths.
    monkeypatch.setattr(Request, "get_json", forbidden)
    response = app.test_client().post(BASE + suffix, json=valid_body(user_prompt="PRIVATE prompt"))
    assert response.status_code == (202 if suffix == "" else 404 if suffix.endswith("subpath") else 405)
    assert logs
    assert "PRIVATE" not in " ".join(logs)


@pytest.mark.parametrize("method,path", ROUTES)
@pytest.mark.parametrize("headers", [{"Host": "attacker.example"}, {"Origin": "https://attacker.example"}])
def test_factory_global_browser_denials_are_no_store_before_trial_service(api, monkeypatch, method, path, headers):
    _, _, calls, _ = api
    app, logs = factory_app(monkeypatch)
    response = request_route(app.test_client(), method, path, headers=headers)
    check(response, 403)
    assert calls == []
    assert "PRIVATE" not in " ".join(logs)
