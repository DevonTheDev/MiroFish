"""Local mode is explicit, credential-free and never inherits cloud routes."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.config import Config


ROOT = Path(__file__).resolve().parents[1]


def load_config(**variables):
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("LLM_", "LOCAL_", "ZEP_", "MEMORY_", "OPENAI_"))
    }
    env.update(PYTHONPATH=str(ROOT), PYTHON_DOTENV_DISABLED="1", **variables)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            'import json; from app.config import Config; print(json.dumps({"errors":Config.validate(),"key":Config.LLM_API_KEY,"url":Config.LLM_BASE_URL,"model":Config.LLM_MODEL_NAME,"local":getattr(Config,"LOCAL_MODE",False)}))',
        ],
        env=env,
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def test_local_mode_needs_no_cloud_keys():
    result = load_config(MEMORY_BACKEND="local")
    assert result["errors"] == []
    assert result["local"] is True
    assert result["key"] == "local"
    assert result["url"] == "http://127.0.0.1:11434/v1"


def test_cloud_mode_keeps_existing_required_keys():
    result = load_config()
    assert result["local"] is False
    assert len(result["errors"]) == 2
    assert result["url"] == "https://api.openai.com/v1"


@pytest.mark.parametrize(
    "name,value",
    [
        ("LLM_BASE_URL", "https://api.openai.com/v1"),
        ("LOCAL_EMBEDDING_BASE_URL", "http://example.org/v1"),
        ("LOCAL_GRAPH_URI", "neo4j://example.org:7687"),
        ("LOCAL_MAX_CONCURRENCY", "0"),
        ("LOCAL_MAX_OUTPUT_TOKENS", "-1"),
    ],
)
def test_local_mode_rejects_unsafe_or_invalid_configuration(name, value):
    result = load_config(
        MEMORY_BACKEND="local",
        LLM_API_KEY="ignored",
        ZEP_API_KEY="ignored",
        **{name: value},
    )
    assert result["errors"]


def test_unknown_backend_fails_instead_of_falling_back_to_cloud():
    assert load_config(MEMORY_BACKEND="locla", LLM_API_KEY="x", ZEP_API_KEY="x")[
        "errors"
    ]


def test_local_llm_client_ignores_real_keys_and_rejects_remote_override(monkeypatch):
    from app import local_runtime
    from app.utils.llm_client import LLMClient

    monkeypatch.setattr(Config, "LOCAL_MODE", True, raising=False)
    monkeypatch.setattr(
        local_runtime, "get_local_gateway_url", lambda: "http://127.0.0.1:12345/v1"
    )
    client = LLMClient(api_key="cloud-secret")
    assert client.client.api_key == "local"
    assert str(client.client.base_url) == "http://127.0.0.1:12345/v1/"
    client.client.close()
    with pytest.raises(ValueError, match="local"):
        LLMClient(base_url="https://api.openai.com/v1")


def test_local_memory_consumers_do_not_require_zep_key(monkeypatch):
    from app.services import graph_builder, zep_entity_reader, zep_tools

    monkeypatch.setattr(Config, "LOCAL_MODE", True, raising=False)
    monkeypatch.setattr(Config, "ZEP_API_KEY", None)
    sentinel = object()
    for module in (graph_builder, zep_entity_reader, zep_tools):
        monkeypatch.setattr(
            module, "get_zep_client", lambda *_args, **_kwargs: sentinel
        )
    assert graph_builder.GraphBuilderService().client is sentinel
    assert zep_entity_reader.ZepEntityReader().client is sentinel
    assert zep_tools.ZepToolsService().client is sentinel


def test_local_environment_disables_downloads_and_tracing(monkeypatch):
    from app import local_runtime

    monkeypatch.setattr(Config, "LOCAL_MODE", True, raising=False)
    monkeypatch.setenv("LANGFUSE_ENABLED", "true")
    local_runtime.configure_local_environment()
    assert os.environ["LANGFUSE_ENABLED"] == "false"
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["GRAPHITI_TELEMETRY_ENABLED"] == "false"


def test_local_web_app_rejects_remote_origin_and_rebinding_host(monkeypatch):
    from app import create_app

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    app = create_app()
    client = app.test_client()
    assert client.get("/health", headers={"Host": "evil.example"}).status_code == 403
    assert (
        client.get("/health", headers={"Origin": "https://evil.example"}).status_code
        == 403
    )
    response = client.get("/health", headers={"Origin": "http://127.0.0.1:3000"})
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:3000"


def test_simultaneous_memory_consumers_share_one_local_client(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import time
    from app.utils import zep
    from app.memory import local_graphiti
    from app import local_runtime

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "validate", lambda: [])
    monkeypatch.setattr(
        local_runtime, "get_local_gateway_url", lambda: "http://127.0.0.1:12345/v1"
    )
    calls = []

    class Client:
        def __init__(self, settings):
            calls.append(settings)
            time.sleep(0.05)

        def close(self):
            pass

    monkeypatch.setattr(local_graphiti, "LocalGraphitiClient", Client)
    zep._get_local_client.cache_clear()
    try:
        with ThreadPoolExecutor(max_workers=4) as executor:
            clients = list(executor.map(lambda _: zep.get_zep_client(), range(4)))
        assert len(calls) == 1
        assert all(client is clients[0] for client in clients)
    finally:
        zep._get_local_client.cache_clear()


@pytest.mark.parametrize("requested", [True, 1.5, "10"])
def test_local_start_api_rejects_non_integer_rounds(monkeypatch, requested):
    from app import create_app

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    response = (
        create_app()
        .test_client()
        .post(
            "/api/simulation/start",
            json={"simulation_id": "sim_unused", "max_rounds": requested},
        )
    )
    assert response.status_code == 400
    assert "integer" in response.json["error"]
