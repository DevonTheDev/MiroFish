"""Exact-instance user cancellation through the real worker and bounded cleanup."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading
from uuid import UUID, uuid4

import pytest

from app.config import Config
from test_prompt_trials import trials as trials, request, finished


RESPONSE = {"content": "controlled reply", "refusal": None, "finish_reason": "stop",
            "usage": {"prompt_tokens": None, "completion_tokens": None, "total_tokens": None}}


@pytest.fixture
def controlled(trials, monkeypatch):
    assert hasattr(trials, "cancel_prompt_trial"), "Explicit exact-instance cancellation is required"
    state = type("Controlled", (), {})()
    for name in ("entered", "release", "closing", "close_release", "cancelled", "close_cancelled"):
        setattr(state, name, threading.Event())
    state.close_release.set()
    state.ignore_cancel = state.fail_close = False
    state.model_calls = state.close_calls = state.gateway_calls = 0

    async def close():
        state.close_calls += 1
        state.closing.set()
        try:
            while not state.close_release.is_set():
                await asyncio.sleep(.005)
        except asyncio.CancelledError:
            state.close_cancelled.set()
            raise
        if state.fail_close:
            raise OSError("synthetic close failure")

    async def gateway(owner, _deadline):
        owner.ensure_current()
        state.gateway_calls += 1
        owner.resources.append(close)
        return "http://127.0.0.1:1/v1"

    async def model(owner, _base, _deadline):
        state.model_calls += 1
        state.entered.set()
        try:
            while not state.release.is_set():
                await asyncio.sleep(.005)
        except asyncio.CancelledError:
            state.cancelled.set()
            if not state.ignore_cancel:
                raise
        return "succeeded", RESPONSE.copy()

    monkeypatch.setattr(trials._Run, "gateway", gateway)
    monkeypatch.setattr(trials._Run, "model", model)
    yield state
    state.release.set()
    state.close_release.set()


def target(snapshot):
    run = snapshot["run"]
    return {"instance_id": run["instance_id"], "fingerprint": run["fingerprint"]}


def cancel(trials, snapshot):
    return trials.cancel_prompt_trial(snapshot["run"]["request_id"], target(snapshot))


def test_stop_decides_once_then_waits_for_owned_cleanup_before_admission(trials, controlled):
    accepted = trials.start_prompt_trial(request())
    assert UUID(accepted["run"]["instance_id"]).version == 4
    assert controlled.entered.wait(2)
    controlled.close_release.clear()
    stopping = cancel(trials, accepted)
    assert stopping["run"]["state"] == "running"
    assert stopping["run"]["error_code"] == "user_cancelled"
    assert stopping["run"]["response"] is None
    assert controlled.closing.wait(2)
    for _ in range(5):
        assert cancel(trials, accepted)["run"]["error_code"] == "user_cancelled"
    assert controlled.close_calls == 1 and not controlled.close_cancelled.is_set()
    with pytest.raises(trials.PromptTrialError) as error:
        trials.start_prompt_trial(request())
    assert error.value.code == "already_running"
    controlled.close_release.set()
    result = finished(trials)
    assert result["run"]["state"] == "cancelled"
    assert result["run"]["cleanup"]["state"] == "succeeded"
    assert result["available"] and not trials._closing
    assert controlled.cancelled.is_set()
    owner = trials._manager
    owner.thread.join(2)
    assert not owner.thread.is_alive()
    assert cancel(trials, accepted)["run"] == result["run"]
    controlled.release.set()
    next_run = trials.start_prompt_trial(request())
    assert next_run["run"]["instance_id"] != accepted["run"]["instance_id"]
    assert finished(trials)["run"]["state"] == "succeeded"


def test_late_provider_success_cannot_overwrite_accepted_stop(trials, controlled):
    controlled.ignore_cancel = True
    accepted = trials.start_prompt_trial(request())
    assert controlled.entered.wait(2)
    cancel(trials, accepted)
    result = finished(trials)["run"]
    assert controlled.cancelled.is_set()
    assert (result["state"], result["error_code"], result["response"]) == ("cancelled", "user_cancelled", None)


def test_completed_decision_is_preserved_while_cleanup_is_still_running(trials, controlled):
    controlled.close_release.clear()
    accepted = trials.start_prompt_trial(request())
    assert controlled.entered.wait(2)
    controlled.release.set()
    assert controlled.closing.wait(2)
    before = trials.get_prompt_trials_snapshot()["run"]
    assert before["state"] == "running" and before["response"] == RESPONSE
    after = cancel(trials, accepted)["run"]
    assert after["response"] == RESPONSE and after["error_code"] is None
    assert not controlled.cancelled.is_set() and not controlled.close_cancelled.is_set()
    controlled.close_release.set()
    assert finished(trials)["run"]["state"] == "succeeded"


def test_stop_before_worker_loop_prevents_gateway_and_model_start(trials, controlled, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    actual = trials._Run.worker

    def paused(owner):
        entered.set()
        assert release.wait(2)
        actual(owner)

    monkeypatch.setattr(trials._Run, "worker", paused)
    accepted = trials.start_prompt_trial(request())
    try:
        assert entered.wait(2)
        assert trials._manager.loop is None
        assert cancel(trials, accepted)["run"]["error_code"] == "user_cancelled"
    finally:
        release.set()
    result = finished(trials)["run"]
    assert result["state"] == "cancelled" and result["cleanup"]["state"] == "succeeded"
    assert controlled.gateway_calls == controlled.model_calls == controlled.close_calls == 0


@pytest.mark.parametrize("shutdown_first", [False, True])
def test_shutdown_and_user_stop_preserve_first_reason(trials, controlled, shutdown_first):
    controlled.close_release.clear()
    accepted = trials.start_prompt_trial(request())
    assert controlled.entered.wait(2)
    if not shutdown_first:
        cancel(trials, accepted)
    with ThreadPoolExecutor(1) as pool:
        closing = pool.submit(trials.close_prompt_trials)
        try:
            assert controlled.closing.wait(2)
            cancel(trials, accepted)
            assert trials.get_prompt_trials_snapshot()["run"]["error_code"] == (
                "backend_closing" if shutdown_first else "user_cancelled")
        finally:
            controlled.close_release.set()
        closing.result(timeout=3)
    assert finished(trials)["run"]["state"] == "cancelled"
    assert not controlled.close_cancelled.is_set()


def test_cleanup_failure_overrides_stop_and_quarantines_new_admission(trials, controlled):
    controlled.fail_close = True
    accepted = trials.start_prompt_trial(request())
    assert controlled.entered.wait(2)
    cancel(trials, accepted)
    result = finished(trials)
    assert result["run"]["state"] == "failed"
    assert result["run"]["error_code"] == result["unavailable_code"] == "cleanup_failed"
    assert result["run"]["cleanup"]["state"] == "failed"
    with pytest.raises(trials.PromptTrialError) as error:
        trials.start_prompt_trial(request())
    assert error.value.code == "trials_unavailable"


@pytest.mark.parametrize("changed", ["instance_id", "fingerprint"])
def test_changed_instance_or_fingerprint_cannot_stop_current_trial(trials, controlled, changed):
    accepted = trials.start_prompt_trial(request())
    assert controlled.entered.wait(2)
    wrong = target(accepted)
    wrong[changed] = str(uuid4()) if changed == "instance_id" else "0" * 64
    with pytest.raises(trials.PromptTrialError) as error:
        trials.cancel_prompt_trial(accepted["run"]["request_id"], wrong)
    assert (error.value.code, error.value.status_code, error.value.snapshot) == ("request_conflict", 409, None)
    assert not trials._manager.cancel_requested and not controlled.cancelled.is_set()
    controlled.release.set()
    assert finished(trials)["run"]["state"] == "succeeded"


def test_reused_uuid_and_identical_inputs_still_have_new_server_identity(trials, controlled, monkeypatch):
    monkeypatch.setattr(trials, "_utc", lambda: "2026-10-05T00:00:00+00:00")
    controlled.release.set()
    original = request()
    first = trials.start_prompt_trial(original)
    finished(trials)
    trials._manager.thread.join(2)
    trials.start_prompt_trial(request())
    finished(trials)
    trials._manager.thread.join(2)
    controlled.release.clear()
    third = trials.start_prompt_trial(original)
    assert first["run"]["request_id"] == third["run"]["request_id"]
    assert first["run"]["fingerprint"] == third["run"]["fingerprint"]
    assert first["run"]["started_at"] == third["run"]["started_at"]
    assert first["run"]["instance_id"] != third["run"]["instance_id"]
    with pytest.raises(trials.PromptTrialError) as error:
        cancel(trials, first)
    assert error.value.code == "request_conflict"
    assert not trials._manager.cancel_requested
    cancel(trials, third)
    assert finished(trials)["run"]["state"] == "cancelled"


def test_cancel_unknown_id_never_substitutes_latest(trials, controlled):
    accepted = trials.start_prompt_trial(request())
    with pytest.raises(trials.PromptTrialError) as error:
        trials.cancel_prompt_trial(str(uuid4()), target(accepted))
    assert (error.value.code, error.value.status_code, error.value.snapshot) == ("run_not_found", 404, None)
    assert not trials._manager.cancel_requested
    cancel(trials, accepted)


@pytest.mark.parametrize("changes,code", [({"LOCAL_MODE": False}, "local_mode_required"),
                                         ({"inherited": True}, "trials_unavailable")])
def test_cancel_cloud_or_inherited_process_touches_no_owner_lock(trials, monkeypatch, changes, code):
    assert hasattr(trials, "cancel_prompt_trial")
    if changes.get("inherited"):
        monkeypatch.setattr(trials, "_owner_pid", trials.os.getpid() + 1)
    else:
        monkeypatch.setattr(Config, "LOCAL_MODE", False)
    class Forbidden:
        def __enter__(self):
            pytest.fail("No inherited/cloud lock access")
    monkeypatch.setattr(trials, "_lock", Forbidden())
    with pytest.raises(trials.PromptTrialError) as error:
        trials.cancel_prompt_trial(str(uuid4()), {"instance_id": str(uuid4()), "fingerprint": "0" * 64})
    assert error.value.code == code
    # The shared fixture's final shutdown is independent of the API assertion.
    monkeypatch.setattr(trials, "_lock", threading.Lock())


@pytest.mark.parametrize("bad", [None, [], {}, {"instance_id": str(uuid4())},
    {"instance_id": str(uuid4()), "fingerprint": "f" * 63},
    {"instance_id": str(uuid4()), "fingerprint": "F" * 64},
    {"instance_id": "bad", "fingerprint": "f" * 64},
    {"instance_id": str(uuid4()), "fingerprint": "f" * 64, "force": True}])
def test_cancel_target_requires_exact_canonical_fields(trials, bad):
    assert hasattr(trials, "normalize_cancellation")
    with pytest.raises(trials.PromptTrialError) as error:
        trials.normalize_cancellation(bad)
    assert (error.value.code, error.value.status_code) == ("invalid_request", 400)
