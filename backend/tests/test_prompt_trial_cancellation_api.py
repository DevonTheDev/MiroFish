"""Strict local HTTP admission for one explicit trial-instance stop."""

from io import BytesIO
import json
from uuid import uuid4

import pytest

from test_prompt_trials_api import api as api, check, REQUEST_ID, BASE


PATH = BASE + "/" + REQUEST_ID + "/cancel"
INSTANCE = "c1234567-89ab-4cde-8fab-0123456789ab"
TARGET = {"instance_id": INSTANCE, "fingerprint": "f" * 64}


@pytest.fixture
def cancel_api(api):
    client, service, calls, data = api
    def cancel(*args):
        calls.append(("cancel_prompt_trial", args))
        return data
    service.cancel_prompt_trial = cancel
    return client, service, calls, data


def test_explicit_stop_forwards_only_exact_target_and_returns_no_store_202(cancel_api):
    client, _, calls, data = cancel_api
    for _ in range(2):
        assert check(client.post(PATH, json=TARGET), 202) == {"success": True, "data": data}
    assert calls == [("cancel_prompt_trial", (REQUEST_ID, TARGET))] * 2


@pytest.mark.parametrize("target", [None, [], {}, {"instance_id": INSTANCE},
    {"fingerprint": "f" * 64}, {**TARGET, "force": True}, {**TARGET, "request_id": REQUEST_ID},
    {**TARGET, "instance_id": INSTANCE.upper()}, {**TARGET, "instance_id": True},
    {**TARGET, "instance_id": "bad"}, {**TARGET, "fingerprint": None},
    {**TARGET, "fingerprint": "F" * 64}, {**TARGET, "fingerprint": "f" * 63},
    {**TARGET, "fingerprint": "g" * 64}, {**TARGET, "fingerprint": 3}])
def test_invalid_body_never_reaches_service(cancel_api, target):
    client, _, calls, _ = cancel_api
    raw = json.dumps(target).encode()
    assert check(client.post(PATH, data=raw, content_type="application/json"), 400)["error_code"] == "invalid_request"
    assert calls == []


@pytest.mark.parametrize("raw", [b"", b"{", b"\xff", b'{"instance_id":NaN}',
    json.dumps(TARGET).replace('"fingerprint":', '"instance_id":"duplicate","fingerprint":').encode(),
    b" " * 1025])
def test_malformed_or_oversized_body_is_rejected(cancel_api, raw):
    client, _, calls, _ = cancel_api
    check(client.post(PATH, data=raw, content_type="application/json"), 400)
    assert calls == []


def test_unknown_length_body_cannot_bypass_small_limit(cancel_api):
    client, _, calls, _ = cancel_api
    raw = b" " * 1025
    check(client.open(PATH, method="POST", content_type="application/json",
                      environ_overrides={"wsgi.input": BytesIO(raw), "wsgi.input_terminated": True,
                                         "CONTENT_LENGTH": ""}), 400)
    assert calls == []


@pytest.mark.parametrize("headers", [
    {"Origin": "https://example.invalid"}, {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"}, {"Host": "example.invalid"},
])
def test_foreign_browser_boundary_rejects_before_service(cancel_api, headers):
    client, _, calls, _ = cancel_api
    check(client.post(PATH, json=TARGET, headers=headers), 403)
    assert calls == []


@pytest.mark.parametrize("headers", [{}, {"Origin": "http://localhost"},
                                    {"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Site": "none"}])
def test_existing_local_browser_routes_remain_supported(cancel_api, headers):
    client, _, calls, _ = cancel_api
    check(client.post(PATH, json=TARGET, headers=headers), 202)
    assert calls == [("cancel_prompt_trial", (REQUEST_ID, TARGET))]


@pytest.mark.parametrize("path", [BASE + "/bad/cancel", BASE + "/" + REQUEST_ID.upper() + "/cancel",
                                 PATH + "?force=1", PATH + "?=", PATH + "?&"])
def test_path_and_query_validation_precede_service(cancel_api, path):
    client, _, calls, _ = cancel_api
    check(client.post(path, json=TARGET), 400)
    assert calls == []


@pytest.mark.parametrize("content_type", [None, "text/plain", "application/octet-stream"])
def test_content_type_is_explicit(cancel_api, content_type):
    client, _, calls, _ = cancel_api
    check(client.post(PATH, data=json.dumps(TARGET), content_type=content_type), 400)
    assert calls == []


@pytest.mark.parametrize("code,status", [("request_conflict", 409), ("run_not_found", 404),
    ("local_mode_required", 403), ("trials_unavailable", 503), ("internal_failure", 500)])
def test_service_errors_are_safe_and_do_not_substitute_latest(cancel_api, code, status):
    client, service, calls, _ = cancel_api
    def fail(*args):
        raise service.PromptTrialError(code, status)
    service.cancel_prompt_trial = fail
    body = check(client.post(PATH, json=TARGET), status)
    assert body["error_code"] == code and "data" not in body
    assert calls == []


def test_passive_reads_never_invoke_stop(cancel_api):
    client, _, calls, _ = cancel_api
    client.get(BASE)
    client.get(BASE + "/" + REQUEST_ID)
    assert all(name != "cancel_prompt_trial" for name, _ in calls)
    assert client.get(PATH).status_code == 405


def test_distinct_canonical_instance_is_forwarded_without_rewriting(cancel_api):
    client, _, calls, _ = cancel_api
    target = {"instance_id": str(uuid4()), "fingerprint": "0" * 64}
    check(client.post(PATH, json=target), 202)
    assert calls == [("cancel_prompt_trial", (REQUEST_ID, target))]
