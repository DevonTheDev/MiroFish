"""Local model padding is canonicalized without relaxing raw config ownership."""

import socket
import threading

import pytest

from app import local_runtime
from app.config import Config
from test_local_readiness import synthetic_models
from test_prompt_trials import trials as trials, finished, forbid_trial_work, request
from test_prompt_trials_api import BASE, REQUEST_ID, check, factory_app, valid_body


@pytest.mark.parametrize("raw_model", [
    pytest.param("  Org/Local 模型:MiXeD name  ", id="ascii-padding"),
    pytest.param("\u00a0\u2003Org/Local 模型:MiXeD name\u3000", id="unicode-padding"),
])
def test_padded_model_admits_trial_with_canonical_payload_and_metadata(trials, monkeypatch, raw_model):
    canonical = "Org/Local 模型:MiXeD name"
    monkeypatch.setattr(Config, "LLM_MODEL_NAME", raw_model)
    app, _ = factory_app(monkeypatch)
    monkeypatch.setattr(Config, "DEBUG", False)
    client = app.test_client()
    with monkeypatch.context() as passive:
        forbid_trial_work(trials, passive)
        observed = check(client.get(BASE), 200)["data"]
    with synthetic_models(monkeypatch) as models:
        accepted = check(client.post(BASE, json=valid_body()), 202)["data"]["run"]
        assert observed["available"] is True and observed["run"] is None
        assert accepted["configuration"]["model"] == canonical
        result = finished(trials)["run"]
        trials._manager.thread.join(2)
        assert not trials._manager.thread.is_alive()
        assert result["state"] == "succeeded" and result["cleanup"]["state"] == "succeeded"
        assert len(models.calls) == 1
        path, body, headers = models.calls[0]
        assert path == "/v1/chat/completions"
        assert body["model"] == result["configuration"]["model"] == canonical
        assert headers["Authorization"] == "Bearer local"
        assert trials._manager.payload["model"] == canonical
        assert trials._manager.captured["LLM_MODEL_NAME"] == raw_model
        assert Config.LLM_MODEL_NAME == raw_model
        assert check(client.get(BASE + "/" + REQUEST_ID), 200)["data"]["run"] == result


@pytest.mark.parametrize("raw_model,canonical", [
    pytest.param("x" * 256, "x" * 256, id="raw-256"),
    pytest.param(" " + "x" * 254 + " ", "x" * 254, id="padded-raw-256"),
])
def test_model_limit_applies_to_raw_input(trials, monkeypatch, raw_model, canonical):
    monkeypatch.setattr(Config, "LLM_MODEL_NAME", raw_model)
    forbid_trial_work(trials, monkeypatch)
    assert len(raw_model) == 256
    assert trials._configuration()["model"] == canonical
    assert trials.get_prompt_trials_snapshot()["available"] is True
    assert Config.LLM_MODEL_NAME == raw_model


@pytest.mark.parametrize("raw_model", [
    pytest.param(None, id="none"),
    pytest.param(True, id="boolean"),
    pytest.param(1, id="integer"),
    pytest.param({}, id="object"),
    pytest.param([], id="list"),
    pytest.param("", id="empty"),
    pytest.param(" \u00a0\u2003", id="blank"),
    pytest.param("\tmodel", id="leading-tab"),
    pytest.param("model\n", id="trailing-newline"),
    pytest.param("model\x00name", id="internal-control"),
    pytest.param("\x1cmodel", id="strippable-control"),
    pytest.param("\ufeffmodel", id="leading-bom"),
    pytest.param("model\u200bname", id="internal-format"),
    pytest.param("model\ud800", id="surrogate"),
    pytest.param("model\ue000", id="private-use"),
    pytest.param("model\u0378", id="unassigned"),
    pytest.param(" https://example.com/model ", id="padded-url"),
    pytest.param(" MODEL:ClOuD ", id="padded-colon-cloud"),
    pytest.param("\u00a0MODEL-ClOuD\u3000", id="padded-hyphen-cloud"),
    pytest.param("x" * 257, id="raw-257"),
    pytest.param(" " + "x" * 255 + " ", id="padded-raw-257"),
])
def test_invalid_model_rejects_before_worker_or_network(trials, monkeypatch, raw_model):
    monkeypatch.setattr(Config, "LLM_MODEL_NAME", raw_model)
    forbid_trial_work(trials, monkeypatch)
    observed = trials.get_prompt_trials_snapshot()
    assert observed["available"] is False
    assert observed["unavailable_code"] == "invalid_configuration"
    assert observed["run"] is None
    with pytest.raises(trials.PromptTrialError) as error:
        trials.start_prompt_trial(request())
    assert (error.value.code, error.value.status_code) == ("invalid_configuration", 503)
    assert trials._manager is None
    assert local_runtime._gateway is None and local_runtime._gateway_starting is None
    assert Config.LLM_MODEL_NAME == raw_model


@pytest.mark.parametrize("field,changed", [
    pytest.param("LLM_MODEL_NAME", "Org/Model:Tag", id="padding-removed"),
    pytest.param("LLM_MODEL_NAME", "\u00a0Org/Model:Tag\u3000", id="padding-changed"),
    pytest.param("LLM_MODEL_NAME", " Org/Other:Tag ", id="model-changed"),
    pytest.param("LLM_BASE_URL", "http://127.0.0.1:2/v1", id="endpoint-changed"),
])
def test_canonical_model_keeps_raw_config_ownership(trials, monkeypatch, field, changed):
    def forbidden(*args, **kwargs):
        pytest.fail("Ownership validation started a worker or network operation")
    monkeypatch.setattr(threading.Thread, "start", forbidden)
    monkeypatch.setattr(local_runtime, "get_local_gateway_url", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    raw_model = " Org/Model:Tag "
    monkeypatch.setattr(Config, "LLM_MODEL_NAME", raw_model)
    original = request()
    owner = trials._Run(original, trials._fingerprint(original), trials._configuration())
    assert owner.captured["LLM_MODEL_NAME"] == Config.LLM_MODEL_NAME == raw_model
    assert owner.payload["model"] == owner.data["configuration"]["model"] == "Org/Model:Tag"
    owner.ensure_current()
    monkeypatch.setattr(Config, field, changed)
    with pytest.raises(trials._TrialFailure) as error:
        owner.ensure_current()
    assert error.value.code == "invalid_configuration"
    assert owner.captured["LLM_MODEL_NAME"] == raw_model


def test_cloud_mode_does_not_normalize_or_admit_model(trials, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MODE", False)
    monkeypatch.setattr(Config, "LLM_MODEL_NAME", " CLOUD:ClOuD ")
    forbid_trial_work(trials, monkeypatch)
    monkeypatch.setattr(trials, "_configuration", lambda: pytest.fail("Cloud mode inspected local configuration"))
    observed = trials.get_prompt_trials_snapshot()
    assert observed["mode"] == "cloud" and observed["run"] is None
    assert observed["available"] is False and observed["unavailable_code"] == "local_mode_required"
    with pytest.raises(trials.PromptTrialError) as error:
        trials.start_prompt_trial(request())
    assert (error.value.code, error.value.status_code) == ("local_mode_required", 403)
    assert Config.LLM_MODEL_NAME == " CLOUD:ClOuD "
