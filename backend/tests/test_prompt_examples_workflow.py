"""Actual suite replies become explicitly reviewed, offline JSONL examples."""

import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import threading

import pytest
from werkzeug.serving import make_server

from app import create_app, local_runtime
import app as app_module
from app.config import Config
from app.services.simulation_runner import SimulationRunner
from test_prompt_trials_frontend_workflow import synthetic_trial_model


@pytest.mark.parametrize("scenario", ["completed", "truncated"])
def test_actual_suite_report_becomes_reviewed_examples_offline(monkeypatch, tmp_path, scenario, caplog):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Reviewed examples workflow requires Node and installed frontend dependencies")
    from app.local_runtime import prompt_trials, readiness
    import neo4j

    monkeypatch.setattr(neo4j.AsyncGraphDatabase, "driver", lambda *_a, **_k: pytest.fail("Graph access"))
    monkeypatch.setattr(SimulationRunner, "register_cleanup", lambda: None)
    monkeypatch.setattr(readiness, "register_readiness_shutdown", lambda: None)
    monkeypatch.setattr(prompt_trials, "register_prompt_trials_shutdown", lambda: None)
    log_name = "prompt_examples_workflow_test"
    caplog.set_level(logging.DEBUG, logger=log_name)
    monkeypatch.setattr(app_module, "get_logger", lambda _name: logging.getLogger(log_name))
    for name, value in {"_manager": None, "_closing": False, "_cleanup_failed": False,
                        "_owner_pid": os.getpid(), "_lock": threading.Lock()}.items():
        monkeypatch.setattr(prompt_trials, name, value)
    monkeypatch.delenv("MIROFISH_LOCAL_GATEWAY_URL", raising=False)
    monkeypatch.setattr(local_runtime, "_gateway", None)
    monkeypatch.setattr(local_runtime, "_gateway_starting", None)
    monkeypatch.setattr(local_runtime, "_gateway_lock", threading.Lock())
    # These fixed strings are synthetic test sentinels, not credentials.
    for name, value in {
        "MEMORY_BACKEND": "local", "LOCAL_MODE": True, "DEBUG": False,
        "LLM_MODEL_NAME": "fixture-reviewed-examples", "LLM_API_KEY": "unused-test-key",
        "ZEP_API_KEY": "unused-test-key", "LOCAL_EMBEDDING_MODEL": "fixture-embedding",
        "LOCAL_EMBEDDING_DIMENSIONS": 3, "LOCAL_GRAPH_URI": "bolt://127.0.0.1:9",
        "LOCAL_GRAPH_USER": "neo4j", "LOCAL_GRAPH_PASSWORD": "unused-test-password",
        "LOCAL_GRAPH_DATABASE": "neo4j", "LOCAL_MAX_AGENTS": 10,
        "LOCAL_MAX_ROUNDS": 5, "LOCAL_MAX_AGENT_ITERATIONS": 3,
        "LOCAL_MAX_CONCURRENCY": 1, "LOCAL_MAX_QUEUE": 4,
        "LOCAL_REQUEST_TIMEOUT": 5, "LOCAL_MAX_OUTPUT_TOKENS": 512,
        "LOCAL_CONTEXT_TOKENS": 8192, "LOCAL_MAX_INPUT_CHARS": 24000,
        "LOCAL_REASONING_EFFORT": "none",
    }.items():
        monkeypatch.setattr(Config, name, value)

    with synthetic_trial_model(truncated=scenario == "truncated") as (model_url, calls):
        monkeypatch.setattr(Config, "LLM_BASE_URL", model_url)
        monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", model_url)
        app = create_app()
        observed = []

        @app.before_request
        def record_request():
            from flask import request
            observed.append((request.method, request.path))

        server = make_server("127.0.0.1", 0, app, threaded=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        output = tmp_path / "examples.json"
        try:
            result = subprocess.run([
                node, str(repo / "frontend/tests/fixtures/prompt-examples-backend-smoke.mjs"),
                f"http://127.0.0.1:{server.server_port}", scenario, str(output),
            ], cwd=repo / "frontend", capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            assert "actual suite replies reviewed and exported offline" in result.stdout
            expected = 3 if scenario == "completed" else 1
            assert len(calls) == expected
            assert sum(method == "POST" for method, _path in observed) == expected
            assert all(path == "/v1/chat/completions" for path, _body, _headers in calls)
            saved = json.loads(output.read_text())
            assert saved["jsonl"].endswith("\n")
            rows = [json.loads(line) for line in saved["jsonl"].splitlines()]
            assert len(rows) == 2
            assert all(set(row) == {"messages"} for row in rows)
            assert [message["role"] for message in rows[0]["messages"]] == ["user", "assistant"]
            assert [message["role"] for message in rows[1]["messages"]] == ["system", "user", "assistant"]
            assert rows[1]["messages"][0]["content"] == " \t "
            assert rows[0]["messages"][:-1] == calls[0][1]["messages"]
            if scenario == "completed":
                assert rows[1]["messages"][:-1] == calls[1][1]["messages"]
            # Exercise a real installed Transformers consumer with an entirely
            # local synthetic tokenizer/template. This validates message shape
            # and exact text, not a pretrained model's template or training.
            from tokenizers import Tokenizer, models
            from transformers import PreTrainedTokenizerFast
            tokenizer = PreTrainedTokenizerFast(
                tokenizer_object=Tokenizer(models.WordLevel({"[UNK]": 0}, unk_token="[UNK]")),
                unk_token="[UNK]",
                chat_template="{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\\n' }}{% endfor %}",
            )
            for row in rows:
                rendered = tokenizer.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=False)
                assert rendered == "".join(message["role"] + ": " + message["content"] + "\n"
                                           for message in row["messages"])
            review = json.loads(saved["review"])
            assert len(review["examples"]) == 2
            assert [row["messages"] for row in rows] == [item["messages"] for item in review["examples"]]
            assert "UNSELECTED_EXAMPLE_MUST_NOT_EXPORT" not in saved["review"] + saved["jsonl"]
            assert "unused-test-key" not in saved["review"] + saved["jsonl"]
            assert "unused-test-password" not in saved["review"] + saved["jsonl"]
            assert "PROMPT_BODY_PRIVATE" not in caplog.text
            assert "请求: GET /api/runtime/trials" in caplog.text
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
            prompt_trials.close_prompt_trials()
            local_runtime.close_local_gateway()
        assert not thread.is_alive()
