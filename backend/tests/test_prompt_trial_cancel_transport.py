"""Actual Flask stop requests close httpx through the shared loopback gateway."""

from concurrent.futures import ThreadPoolExecutor

from flask import Flask
import httpx
import pytest

from app import local_runtime
from test_local_gateway import chat, upstream_server
from test_prompt_trials import trials as trials, request, finished, wait_for
from test_prompt_trials_transport import configure, completion, capture_gateway_headers


@pytest.fixture
def client(trials):
    from app.api import runtime_bp
    app = Flask(__name__)
    app.register_blueprint(runtime_bp, url_prefix="/api/runtime")
    return app.test_client()


def start(client, value):
    response = client.post("/api/runtime/trials", json=value)
    assert response.status_code == 202
    return response.get_json()["data"]


def stop(client, snapshot):
    run = snapshot["run"]
    response = client.post("/api/runtime/trials/" + run["request_id"] + "/cancel",
                           json={key: run[key] for key in ("instance_id", "fingerprint")})
    assert response.status_code == 202
    assert response.headers["Cache-Control"] == "no-store"
    return response.get_json()["data"]


def test_cancelled_queued_trial_never_reaches_model_and_other_request_survives(trials, client, monkeypatch):
    observed = capture_gateway_headers(monkeypatch)
    with upstream_server() as upstream:
        configure(monkeypatch, upstream)
        upstream.body = completion()
        base = local_runtime.get_local_gateway_url()
        upstream.release.clear()
        with httpx.Client(base_url=base + "/", trust_env=False, timeout=3) as sdk, ThreadPoolExecutor(1) as pool:
            occupied = pool.submit(chat, sdk)
            try:
                assert upstream.started.wait(1)
                accepted = start(client, request(user_prompt="cancel before forwarding this prompt"))
                wait_for(trials, lambda _: local_runtime._gateway.snapshot()["metrics"]["queued_requests"] == 1)
                stopped = stop(client, accepted)
                assert stopped["run"]["error_code"] == "user_cancelled"
                final = finished(trials)
                assert final["run"]["state"] == "cancelled"
                assert final["run"]["response"] is None
                assert final["run"]["cleanup"]["state"] == "succeeded"
                wait_for(trials, lambda _: local_runtime._gateway.snapshot()["metrics"]["queued_requests"] == 0)
                metrics = local_runtime._gateway.snapshot()["metrics"]
                assert metrics["cancelled_requests"] == 1 and metrics["active_requests"] == 1
                assert len(upstream.calls) == 1
                assert any(headers.get("X-MiroFish-Cancel-On-Disconnect") == "1" for headers in observed)
                assert stop(client, accepted)["run"] == final["run"]
            finally:
                upstream.release.set()
            assert occupied.result(timeout=2).status_code == 200
            assert chat(sdk).status_code == 200
        assert len(upstream.calls) == 2
        assert all(body["messages"][0]["content"] == "hello" for _, body, _ in upstream.calls)
        assert all("X-MiroFish-Cancel-On-Disconnect" not in headers for _, _, headers in upstream.calls)


def test_cancel_active_trial_settles_gateway_forward_without_claiming_model_stopped(trials, client, monkeypatch):
    with upstream_server() as upstream:
        configure(monkeypatch, upstream)
        upstream.body = completion()
        upstream.release.clear()
        accepted = start(client, request())
        try:
            assert upstream.started.wait(1)
            stop(client, accepted)
            final = finished(trials)
            assert final["run"]["state"] == "cancelled"
            assert final["run"]["error_code"] == "user_cancelled"
            wait_for(trials, lambda _: local_runtime._gateway.snapshot()["metrics"]["active_requests"] == 0)
            assert local_runtime._gateway.snapshot()["metrics"]["cancelled_requests"] == 1
            # The synthetic provider deliberately keeps working despite the
            # closed transport, so the UI cannot promise that model work stops.
            assert upstream.active == 1 and len(upstream.calls) == 1
        finally:
            upstream.release.set()
        trials._manager.thread.join(2)
        start(client, request(user_prompt="a later explicit request"))
        assert finished(trials)["run"]["state"] == "succeeded"
        assert len(upstream.calls) == 2


def test_completed_trial_ignores_late_stop_without_new_model_work(trials, client, monkeypatch):
    with upstream_server() as upstream:
        configure(monkeypatch, upstream)
        upstream.body = completion()
        accepted = start(client, request())
        final = finished(trials)
        assert stop(client, accepted)["run"] == final["run"]
        assert final["run"]["state"] == "succeeded"
        assert len(upstream.calls) == 1
