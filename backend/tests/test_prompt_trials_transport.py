"""Prompt trials over their real shared gateway and synthetic loopback HTTP."""

from concurrent.futures import ThreadPoolExecutor
import json
import time

import httpx
import pytest

from app import local_runtime
from app.config import Config
from app.local_runtime import gateway
from test_local_gateway import chat, upstream_server
from test_prompt_trials import finished, request, trials as trials, wait_for


CAP_HEADER = "X-MiroFish-Timeout-Ms"
NULL_USAGE = dict.fromkeys(("prompt_tokens", "completion_tokens", "total_tokens"))
SECRET = "private-provider-secret"


def completion(content="Synthetic answer", *, reason="stop", **message_fields):
    return {"choices": [{"message": {"role": "assistant", "content": content, **message_fields},
                         "finish_reason": reason}]}


def configure(monkeypatch, upstream):
    monkeypatch.setattr(Config, "LLM_BASE_URL", upstream.url)
    monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", upstream.url)


def run_response(trials, monkeypatch, upstream, body):
    configure(monkeypatch, upstream)
    upstream.body = body
    trials.start_prompt_trial(request())
    result = finished(trials)
    assert result["run"]["cleanup"]["state"] == "succeeded"
    assert len(upstream.calls) == 1
    assert upstream.calls[0][0] == "/v1/chat/completions"
    return result["run"]


def assert_failure(run, code, *, state="failed"):
    assert run["state"] == state
    assert run["error_code"] == code
    assert run["response"] is None
    assert run["cleanup"]["state"] == "succeeded"


def capture_gateway_headers(monkeypatch):
    """Observe headers after real HTTP parsing, preserving normal dispatch."""
    observed = []
    original = gateway._Handler.do_POST

    def record(handler):
        observed.append(dict(handler.headers))
        return original(handler)

    monkeypatch.setattr(gateway._Handler, "do_POST", record)
    return observed


@pytest.mark.parametrize("content", [
    "", " \r\n\t ", "<think>private reasoning</think>\nFinal answer  \n",
    "中文 e\u0301 😀\r\n\t\x00\x1b\x7f\u200d\ufeff\uffff\U0010ffff",
])
def test_exact_output_is_preserved_including_empty_and_unicode_scalars(trials, monkeypatch, content):
    with upstream_server() as upstream:
        run = run_response(trials, monkeypatch, upstream, completion(content))
        assert run["state"] == "succeeded"
        assert run["error_code"] is None
        assert run["response"] == {"content": content, "refusal": None, "finish_reason": "stop",
                                   "usage": NULL_USAGE}


@pytest.mark.parametrize("content,reason,refusal,state", [
    ("answer", "stop", "", "succeeded"),
    ("unfinished", "length", None, "truncated"),
    ("", "length", None, "truncated"),
    (None, "stop", "Cannot comply", "refused"),
    ("partial", "length", "Cannot comply", "refused"),
    (None, "content_filter", None, "refused"),
    ("", "content_filter", "", "refused"),
])
def test_length_and_refusal_states_retain_provider_fields(trials, monkeypatch, content, reason, refusal, state):
    with upstream_server() as upstream:
        run = run_response(trials, monkeypatch, upstream, completion(content, reason=reason, refusal=refusal))
        assert run["state"] == state
        assert run["error_code"] is None
        assert run["response"] == {"content": content, "refusal": refusal, "finish_reason": reason,
                                   "usage": NULL_USAGE}


@pytest.mark.parametrize("body,code", [
    (b'{"choices":', "model_unavailable"),
    (b'\xff', "model_unavailable"),
    (b'{"value":NaN}', "model_unavailable"),
    (b'{"value":Infinity}', "model_unavailable"),
    (b'{"value":-Infinity}', "model_unavailable"),
    (b'{"choices":[],"choices":[]}', "malformed_response"),
    (b'{"choices":[{"message":{"role":"assistant","content":"first","content":"second"},'
     b'"finish_reason":"stop"}]}', "malformed_response"),
    ([], "malformed_response"),
    ({"choices": []}, "malformed_response"),
    ({"choices": [None]}, "malformed_response"),
    ({"choices": [{"message": None}]}, "malformed_response"),
    ({"choices": completion()["choices"] * 2}, "malformed_response"),
    ({"choices": [{"message": {"role": "assistant"}, "finish_reason": "stop"}]}, "malformed_response"),
    (completion(None), "malformed_response"),
    (completion([{"type": "text", "text": "unsupported"}]), "malformed_response"),
    (completion("answer", role="user"), "malformed_response"),
    (completion("\ud800"), "malformed_response"),
    (completion("\udfff"), "malformed_response"),
    (completion("answer", refusal=123), "malformed_response"),
    (completion("answer", refusal="\ud800"), "malformed_response"),
    (completion("answer", reason=None), "unsupported_completion"),
    (completion("answer", reason="future-reason"), "unsupported_completion"),
    (completion(None, reason="tool_calls", tool_calls=[{"id": "call"}]), "unsupported_completion"),
    (completion("answer", tool_calls=[{"id": "call"}]), "unsupported_completion"),
    (completion("answer", function_call={"name": "execute", "arguments": "{}"}), "unsupported_completion"),
], ids=["incomplete-json", "invalid-utf8", "nan", "infinity", "negative-infinity", "duplicate-root-key",
        "duplicate-message-key", "nonobject", "no-choices", "invalid-choice", "invalid-message", "two-choices",
        "missing-content", "null-content", "content-array", "wrong-role", "high-surrogate", "low-surrogate",
        "nontext-refusal", "surrogate-refusal", "missing-finish", "unknown-finish", "tool-finish", "tool-calls",
        "legacy-function-call"])
def test_malformed_and_unsupported_responses_fail_without_retaining_provider_data(trials, monkeypatch, body, code):
    with upstream_server() as upstream:
        run = run_response(trials, monkeypatch, upstream, body)
        assert_failure(run, code)


@pytest.mark.parametrize("field,value,code", [
    ("tool_calls", False, "malformed_response"),
    ("tool_calls", 0, "malformed_response"),
    ("tool_calls", {}, "malformed_response"),
    ("tool_calls", "", "malformed_response"),
    ("function_call", False, "malformed_response"),
    ("function_call", 0, "malformed_response"),
    ("function_call", "", "malformed_response"),
    ("function_call", [], "malformed_response"),
    ("function_call", {}, "unsupported_completion"),
])
def test_falsey_malformed_call_fields_cannot_be_accepted_as_text(trials, monkeypatch, field, value, code):
    with upstream_server() as upstream:
        run = run_response(trials, monkeypatch, upstream, completion("answer", **{field: value}))
        assert_failure(run, code)


@pytest.mark.parametrize("fields", [{"tool_calls": None}, {"tool_calls": []}, {"function_call": None}])
def test_absent_tool_calls_remain_compatible_with_plain_text(trials, monkeypatch, fields):
    with upstream_server() as upstream:
        run = run_response(trials, monkeypatch, upstream, completion("answer", **fields))
        assert run["state"] == "succeeded"
        assert run["response"]["content"] == "answer"


@pytest.mark.parametrize("omit_length", [False, True], ids=["declared-length", "read-until-eof"])
@pytest.mark.parametrize("extra,expected", [(0, "succeeded"), (1, "failed")], ids=["exact-limit", "one-byte-over"])
def test_response_byte_budget_is_exactly_64_kib(trials, monkeypatch, omit_length, extra, expected):
    body = json.dumps(completion("answer"), separators=(",", ":")).encode()
    body += b" " * (65536 + extra - len(body))
    with upstream_server() as upstream:
        upstream.omit_length = omit_length
        run = run_response(trials, monkeypatch, upstream, body)
        assert run["state"] == expected
        if extra:
            assert_failure(run, "response_too_large")
        else:
            assert run["response"]["content"] == "answer"


@pytest.mark.parametrize("field", ["content", "refusal"])
@pytest.mark.parametrize("extra", [0, 1], ids=["exact-limit", "one-scalar-over"])
def test_retained_text_budget_counts_unicode_scalars_not_utf16_units_or_bytes(trials, monkeypatch, field, extra):
    text = "😀" + "é" * (16383 + extra)
    payload = completion(text) if field == "content" else completion(None, refusal=text)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    assert len(text) == 16384 + extra
    assert len(body) < 65536
    with upstream_server() as upstream:
        run = run_response(trials, monkeypatch, upstream, body)
        if extra:
            assert_failure(run, "response_too_large")
        else:
            assert run["state"] == ("succeeded" if field == "content" else "refused")
            assert run["response"][field] == text


@pytest.mark.parametrize("usage,expected", [
    (None, NULL_USAGE), ([], NULL_USAGE), ("server claim", NULL_USAGE),
    ({}, NULL_USAGE),
    ({"prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 2**53 - 1},
     {"prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 2**53 - 1}),
    ({"prompt_tokens": True, "completion_tokens": -1, "total_tokens": 2**53}, NULL_USAGE),
    ({"prompt_tokens": 1.0, "completion_tokens": "2", "total_tokens": None}, NULL_USAGE),
    ({"prompt_tokens": 6, "completion_tokens": {}, "total_tokens": 0, "private": SECRET},
     {"prompt_tokens": 6, "completion_tokens": None, "total_tokens": 0}),
])
def test_only_safe_server_reported_usage_is_retained_without_estimation(trials, monkeypatch, usage, expected):
    body = {**completion(), "usage": usage}
    with upstream_server() as upstream:
        run = run_response(trials, monkeypatch, upstream, body)
        assert run["state"] == "succeeded"
        assert run["response"]["usage"] == expected
        assert SECRET not in json.dumps(run)


@pytest.mark.parametrize("status", [400, 401, 429, 500, 503])
def test_provider_errors_are_redacted_and_never_retried(trials, monkeypatch, status):
    with upstream_server() as upstream:
        upstream.status = status
        upstream.headers = {"Retry-After": "0", "X-Provider-Secret": SECRET}
        run = run_response(trials, monkeypatch, upstream, {"error": {"message": SECRET}})
        assert_failure(run, "model_unavailable")
        snapshot = json.dumps(trials.get_prompt_trials_snapshot())
        assert SECRET not in snapshot
        assert upstream.url not in snapshot


def test_provider_redirect_is_not_followed(trials, monkeypatch):
    with upstream_server() as upstream, upstream_server() as redirect:
        upstream.status = 307
        upstream.headers = {"Location": redirect.url + "/chat/completions?secret=" + SECRET}
        run = run_response(trials, monkeypatch, upstream, {"error": SECRET})
        assert_failure(run, "model_unavailable")
        assert not redirect.calls
        assert SECRET not in json.dumps(trials.get_prompt_trials_snapshot())


@pytest.mark.parametrize("status,body,code", [
    (503, {"error": SECRET}, "gateway_unavailable"),
    (429, {"error": SECRET}, "gateway_busy"),
    (200, {"status": "ok", "service": "local-inference-gateway"}, "gateway_unsupported"),
    (200, {"status": "ok", "service": "local-inference-gateway", "request_deadline_cap": "old-cap"},
     "gateway_unsupported"),
    (200, b'{"status":"ok","status":"ok"}', "gateway_unsupported"),
])
def test_inherited_gateway_errors_and_unsupported_health_never_contact_a_model(trials, monkeypatch, status, body, code):
    with upstream_server() as inherited, upstream_server() as model:
        configure(monkeypatch, model)
        monkeypatch.setenv("MIROFISH_LOCAL_GATEWAY_URL", inherited.url)
        inherited.status, inherited.body = status, body
        trials.start_prompt_trial(request())
        run = finished(trials)["run"]
        assert_failure(run, code)
        assert len(inherited.calls) == 1
        assert inherited.calls[0][:2] == ("/health", None)
        assert not model.calls
        assert local_runtime._gateway is None
        assert SECRET not in json.dumps(trials.get_prompt_trials_snapshot())


def test_inherited_gateway_health_redirect_is_not_followed(trials, monkeypatch):
    with upstream_server() as inherited, upstream_server() as redirect:
        configure(monkeypatch, redirect)
        monkeypatch.setenv("MIROFISH_LOCAL_GATEWAY_URL", inherited.url)
        inherited.status = 307
        inherited.headers = {"Location": redirect.url + "/health"}
        trials.start_prompt_trial(request())
        assert_failure(finished(trials)["run"], "gateway_unavailable")
        assert len(inherited.calls) == 1
        assert not redirect.calls


def test_proxy_and_credentials_are_not_inherited_by_either_transport(trials, monkeypatch):
    observed = capture_gateway_headers(monkeypatch)
    with upstream_server() as upstream, upstream_server() as proxy:
        configure(monkeypatch, upstream)
        upstream.body = completion()
        # Start the shared client with hostile proxies, then restore them after
        # runtime startup clears the environment, before the trial client starts.
        proxy_url = proxy.url.removesuffix("/v1")
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            monkeypatch.setenv(name, proxy_url)
        monkeypatch.setenv("NO_PROXY", "")
        monkeypatch.setenv("no_proxy", "")
        local_runtime.get_local_gateway_url()
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            monkeypatch.setenv(name, proxy_url)
        monkeypatch.setenv("NO_PROXY", "")
        monkeypatch.setenv("no_proxy", "")
        monkeypatch.setenv("OPENAI_API_KEY", SECRET)
        monkeypatch.setenv("LLM_API_KEY", SECRET)
        monkeypatch.setattr(Config, "LLM_API_KEY", SECRET)
        trials.start_prompt_trial(request())
        assert finished(trials)["run"]["state"] == "succeeded"
        assert not proxy.calls
        assert len(upstream.calls) == len(observed) == 1
        incoming = {key.lower(): value for key, value in observed[0].items()}
        outgoing = {key.lower(): value for key, value in upstream.calls[0][2].items()}
        assert "authorization" not in incoming and "cookie" not in incoming
        assert outgoing["authorization"] == "Bearer local"
        assert "cookie" not in outgoing
        assert CAP_HEADER.lower() not in outgoing
        assert SECRET not in json.dumps([observed, upstream.calls, trials.get_prompt_trials_snapshot()])


def test_real_gateway_header_cannot_exceed_the_60_second_trial_cap(trials, monkeypatch):
    observed = capture_gateway_headers(monkeypatch)
    monkeypatch.setattr(Config, "LOCAL_REQUEST_TIMEOUT", 120)
    monkeypatch.setattr(trials, "_BUDGETS", {**trials._BUDGETS, "request_ms": 120000})
    with upstream_server() as upstream:
        run = run_response(trials, monkeypatch, upstream, completion())
        assert run["state"] == "succeeded"
        assert len(observed) == 1
        assert 59000 <= int(observed[0][CAP_HEADER]) <= 60000
        assert trials._manager.budgets["request_ms"] == 60000
        assert trials.get_prompt_trials_snapshot()["limits"]["request_ms"] == 60000


@pytest.mark.parametrize("drip", [False, True], ids=["slow-headers", "slow-body"])
def test_real_model_deadline_covers_the_entire_response_and_does_not_retry(trials, monkeypatch, drip):
    observed = capture_gateway_headers(monkeypatch)
    monkeypatch.setattr(trials, "_BUDGETS", {**trials._BUDGETS, "request_ms": 200})
    with upstream_server() as upstream:
        upstream.drip = drip
        upstream.delay = 0 if drip else .8
        started = time.monotonic()
        run = run_response(trials, monkeypatch, upstream, completion())
        assert_failure(run, "request_timeout", state="timed_out")
        assert time.monotonic() - started < 1.5
        assert 0 < int(observed[0][CAP_HEADER]) <= 200
        assert run["request_duration_ms"] < 1000


def test_queued_trial_expires_before_reaching_model_and_shared_gateway_survives(trials, monkeypatch):
    observed = capture_gateway_headers(monkeypatch)
    monkeypatch.setattr(trials, "_BUDGETS", {**trials._BUDGETS, "request_ms": 250})
    with upstream_server() as upstream:
        configure(monkeypatch, upstream)
        upstream.body = completion()
        base = local_runtime.get_local_gateway_url()
        upstream.release.clear()
        with httpx.Client(base_url=base + "/", trust_env=False, timeout=3) as client, ThreadPoolExecutor(1) as pool:
            occupied = pool.submit(chat, client)
            try:
                assert upstream.started.wait(1)
                trials.start_prompt_trial(request(user_prompt="must never reach the model"))
                wait_for(trials, lambda _: local_runtime._gateway.snapshot()["metrics"]["queued_requests"] == 1)
                run = finished(trials)["run"]
                assert_failure(run, "request_timeout", state="timed_out")
                wait_for(trials, lambda _: local_runtime._gateway.snapshot()["metrics"]["queued_requests"] == 0)
                assert len(upstream.calls) == 1
                capped = [headers for headers in observed if CAP_HEADER in headers]
                assert len(capped) == 1
                assert 0 < int(capped[0][CAP_HEADER]) <= 250
                metrics = local_runtime._gateway.snapshot()["metrics"]
                # The caller's timeout now closes an opted-in connection. It
                # may cancel the queued forward before the gateway's own cap.
                assert metrics["timed_out_requests"] + metrics["cancelled_requests"] == 1
                assert metrics["active_requests"] == 1
            finally:
                upstream.release.set()
            assert occupied.result(timeout=2).status_code == 200
            assert chat(client).status_code == 200
        assert len(upstream.calls) == 2
        assert all(body["messages"][0]["content"] == "hello" for _, body, _ in upstream.calls)


def test_overall_deadline_shortens_the_actual_model_request_cap(trials, monkeypatch):
    observed = capture_gateway_headers(monkeypatch)
    monkeypatch.setattr(trials, "_BUDGETS", {**trials._BUDGETS, "overall_ms": 350, "request_ms": 1000})
    with upstream_server() as upstream:
        configure(monkeypatch, upstream)
        local_runtime.get_local_gateway_url()
        upstream.delay = .8
        upstream.body = completion()
        trials.start_prompt_trial(request())
        run = finished(trials)["run"]
        # The integer millisecond cap can make the gateway expire just before
        # the outer deadline. Either timeout source has the same bounded result.
        assert run["error_code"] in {"overall_timeout", "request_timeout"}
        assert_failure(run, run["error_code"], state="timed_out")
        assert len(upstream.calls) == len(observed) == 1
        assert 0 < int(observed[0][CAP_HEADER]) <= 350
        assert run["elapsed_ms"] < 1000


@pytest.mark.parametrize("configured_limit,effective_limit", [(7, 7), (1024, 512)])
def test_configured_model_and_token_limit_are_fixed_in_the_real_request(trials, monkeypatch, configured_limit, effective_limit):
    with upstream_server() as upstream:
        configure(monkeypatch, upstream)
        monkeypatch.setattr(Config, "LLM_MODEL_NAME", "fixed-local-model")
        monkeypatch.setattr(Config, "LOCAL_MAX_OUTPUT_TOKENS", configured_limit)
        upstream.body = completion()
        assert trials.get_prompt_trials_snapshot()["limits"]["max_output_tokens"] == effective_limit
        with pytest.raises(trials.PromptTrialError) as invalid:
            trials.start_prompt_trial(request(max_output_tokens=effective_limit + 1))
        assert (invalid.value.code, invalid.value.status_code) == ("invalid_request", 400)
        assert trials._manager is None and local_runtime._gateway is None
        assert not upstream.calls
        original = request(max_output_tokens=effective_limit)
        trials.start_prompt_trial(original)
        run = finished(trials)["run"]
        assert run["state"] == "succeeded"
        assert run["configuration"]["model"] == "fixed-local-model"
        assert len(upstream.calls) == 1
        assert upstream.calls[0][1] == {
            "model": "fixed-local-model", "messages": [
                {"role": "system", "content": original["system_prompt"]},
                {"role": "user", "content": original["user_prompt"]}],
            "temperature": .25, "max_tokens": effective_limit, "stream": False, "reasoning_effort": "none",
        }


def test_empty_optional_system_prompt_is_omitted_from_wire_messages(trials, monkeypatch):
    with upstream_server() as upstream:
        configure(monkeypatch, upstream)
        upstream.body = completion()
        original = request(system_prompt="")
        trials.start_prompt_trial(original)
        run = finished(trials)["run"]
        assert run["state"] == "succeeded"
        assert run["request"]["system_prompt"] == ""
        assert len(upstream.calls) == 1
        assert upstream.calls[0][1]["messages"] == [{"role": "user", "content": original["user_prompt"]}]


def test_configuration_change_cannot_retarget_an_inflight_trial(trials, monkeypatch):
    with upstream_server() as upstream:
        configure(monkeypatch, upstream)
        upstream.body = completion()
        upstream.release.clear()
        trials.start_prompt_trial(request())
        try:
            assert upstream.started.wait(1)
            monkeypatch.setattr(Config, "LLM_MODEL_NAME", "different-local-model")
        finally:
            upstream.release.set()
        run = finished(trials)["run"]
        assert_failure(run, "invalid_configuration")
        assert run["configuration"]["model"] == "synthetic-chat"
        assert len(upstream.calls) == 1
        assert upstream.calls[0][1]["model"] == "synthetic-chat"
