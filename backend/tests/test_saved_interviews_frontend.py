"""Actual SQLite → Flask → production Axios → compiled Vue/router workflows.

The Vue custom renderer exercises scripts, templates and controls, not a native
browser. The only server is disposable loopback Flask; no simulation is run.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import threading

from flask import request
import pytest
from werkzeug.serving import make_server

from app.api import simulation as api
from app.services import saved_interviews
from app.services.simulation_ipc import SimulationIPCClient
from app.services.simulation_runner import SimulationRunner
from app.utils.llm_client import LLMClient
from test_saved_interviews_api import interview
from test_saved_interviews_api import storage as storage


# The installed OASIS social_platform/schema/trace.sql schema, including its
# composite key and affinities. Named inserts preserve the helper row order.
TRACE_SCHEMA = """
CREATE TABLE trace (
    user_id INTEGER,
    created_at DATETIME,
    action TEXT,
    info TEXT,
    PRIMARY KEY(user_id, created_at, action, info),
    FOREIGN KEY(user_id) REFERENCES user(user_id)
);
"""


def trace_database(path, rows=()):
    connection = sqlite3.connect(path)
    try:
        connection.executescript(TRACE_SCHEMA)
        connection.executemany(
            "INSERT INTO trace (user_id, action, info, created_at) VALUES (?, ?, ?, ?)", rows,
        )
        connection.commit()
    finally:
        connection.close()


def inventory(root):
    """Freeze all saved files/directories except SQLite's permitted sidecars."""
    return {
        str(path.relative_to(root)): "directory" if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if not path.name.endswith(("-wal", "-shm"))
    }


def run_workflow(storage, monkeypatch, mode, before_request=None, *, helper="saved-interviews-backend-check.mjs",
                 expected_statuses=None, after_workflow=None):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None or not (repo / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Saved interviews workflow needs Node and installed frontend dependencies")
    # The dependency environment is shared with the baseline checkout. Fail if
    # editable-package resolution silently exercises that checkout instead.
    assert Path(api.__file__).resolve() == repo / "backend/app/api/simulation.py"
    assert Path(saved_interviews.__file__).resolve() == repo / "backend/app/services/saved_interviews.py"

    def forbidden(*args, **kwargs):
        pytest.fail("Saved interview browsing invoked inference, IPC or a live runner")

    for name in ("interview_agent", "interview_agents_batch", "interview_all_agents",
                 "has_active_environment", "check_env_alive", "get_env_status_detail",
                 "close_simulation_env", "_get_interview_history_from_db"):
        monkeypatch.setattr(SimulationRunner, name, forbidden)
    monkeypatch.setattr(SimulationIPCClient, "__init__", forbidden)
    monkeypatch.setattr(LLMClient, "__init__", forbidden)
    monkeypatch.setattr(api, "optimize_interview_prompt", forbidden)
    original_connect = sqlite3.connect
    connections = []
    statements = []

    class ObservedConnection(sqlite3.Connection):
        workflow_closed = False

        def close(self):
            super().close()
            self.workflow_closed = True

    def read_only_connect(database, *args, **kwargs):
        assert kwargs.get("uri") is True
        assert kwargs.get("timeout") == 0.25
        assert isinstance(database, str) and database.startswith("file:")
        assert database.endswith("?mode=ro") and "immutable" not in database
        assert "%3F%23%25" in database, "The real storage root requires escaped SQLite URI paths"
        connection = original_connect(database, *args, **kwargs, factory=ObservedConnection)
        connection.set_trace_callback(statements.append)
        connections.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, "connect", read_only_connect)
    observed = []
    returned = []

    @storage.client.application.before_request
    def capture_request():
        observed.append((request.method, request.path, request.query_string.decode("ascii"),
                         request.headers.get("Accept-Language")))
        if before_request:
            before_request()

    @storage.client.application.after_request
    def capture_response(response):
        returned.append((response.status_code, response.headers.get("Cache-Control"), len(response.get_data())))
        return response

    before = inventory(storage.root)
    server = make_server("127.0.0.1", 0, storage.client.application, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run([
            node, str(repo / "frontend/tests/helpers" / helper),
            f"http://127.0.0.1:{server.server_port}", mode,
        ], cwd=repo / "frontend", capture_output=True, text=True, timeout=45,
            env={**os.environ, "NPM_CONFIG_OFFLINE": "true", "NPM_CONFIG_UPDATE_NOTIFIER": "false"})
        assert run.returncode == 0, run.stdout + run.stderr
        assert f"actual Flask/Axios/Vue saved interviews {mode} passed" in run.stdout
        print(run.stdout.strip())
        print(f"candidate Flask API: {api.__file__}")
        print(f"candidate saved reader: {saved_interviews.__file__}")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        if after_workflow:
            after_workflow()
    assert not thread.is_alive()
    assert observed
    assert all(method == "GET" and path.endswith("/saved-interviews") and language == "en"
               for method, path, _query, language in observed)
    assert [status for status, _cache, _size in returned] == (expected_statuses or [200] * len(returned))
    assert all(cache_control == "no-store" and size <= 4 * 1024 * 1024
               for status, cache_control, size in returned)
    assert len(observed) == len(returned)
    assert connections and all(connection.workflow_closed for connection in connections)
    # SQLite traces the table-valued pragma as an internal comment as well.
    unexpected_sql = [sql for sql in statements
                      if not sql.lstrip().upper().startswith(("SELECT ", "PRAGMA "))
                      and sql != "-- PRAGMA table_xinfo='trace'"]
    assert statements and not unexpected_sql, unexpected_sql
    assert inventory(storage.root) == before
    assert not (storage.root / "sim_unknown").exists()
    return observed


def test_saved_interviews_reopen_filters_refresh_wal_and_exact_download(storage, monkeypatch):
    literal = '<script>saved & literal</script>\nCafé 雪 🐟'
    trace_database(storage.twitter, [
        interview(0, prompt=literal, response="Twitter zero reply", timestamp="z-saved"),
        interview(2**63 - 1, prompt="Largest agent", response="Twitter signed64 max reply", timestamp="a-saved"),
    ])
    trace_database(storage.reddit, [interview(0, prompt=literal, response="Reddit zero reply")])
    writer = sqlite3.connect(storage.twitter, check_same_thread=False)
    try:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("INSERT INTO trace (user_id, action, info, created_at) VALUES (?, ?, ?, ?)",
                       interview(0, response="Committed WAL reply", timestamp="WAL-first"))
        writer.commit()
        assert storage.twitter.with_name(storage.twitter.name + "-wal").stat().st_size > 0
        unfiltered_reads = 0

        def append_at_refresh():
            nonlocal unfiltered_reads
            if request.path.endswith("/sim_saved/saved-interviews") and not request.args:
                unfiltered_reads += 1
                if unfiltered_reads == 3:
                    # A controlled external writer commits between observations.
                    # The endpoint must see it without mutating the main DB.
                    writer.execute("INSERT INTO trace (user_id, action, info, created_at) VALUES (?, ?, ?, ?)",
                                   interview(0, response="Refreshed WAL reply", timestamp="WAL-refresh"))
                    writer.commit()

        observed = run_workflow(storage, monkeypatch, "reopen", append_at_refresh)
        assert unfiltered_reads == 3
        assert any(query == "platform=twitter&agent_id=9223372036854775807&window=1"
                   for _method, _path, query, _language in observed)
        assert any(query == "platform=reddit&agent_id=0&window=1"
                   for _method, _path, query, _language in observed)
    finally:
        writer.close()


def test_saved_interviews_missing_empty_corrupt_and_route_replacement(storage, monkeypatch):
    for simulation_id in ("sim_empty", "sim_corrupt"):
        folder = storage.root / simulation_id
        folder.mkdir()
        trace_database(folder / "twitter_simulation.db")
        if simulation_id == "sim_empty":
            trace_database(folder / "reddit_simulation.db")
        else:
            (folder / "reddit_simulation.db").write_bytes(b"PRIVATE_CORRUPT_DATABASE_CONTENT")
    observed = run_workflow(storage, monkeypatch, "states")
    assert {path for _method, path, _query, _language in observed} == {
        "/api/simulation/sim_unknown/saved-interviews",
        "/api/simulation/sim_empty/saved-interviews",
        "/api/simulation/sim_corrupt/saved-interviews",
    }


def test_saved_interviews_row_payload_bounds_literal_raw_and_complete_export(storage, monkeypatch):
    rows = [interview(0, response=f"Twitter bounded reply {i}", timestamp=f"saved-{i}") for i in range(101)]
    rows.extend([
        (0, "interview", None, "missing-payload"),
        interview(0, prompt="", response="", timestamp="explicitly-empty"),
        (0, "interview", '<img src=x onerror=alert(1)>{broken', "raw-literal"),
        (0, "interview", "雪" * 6000, "truncated-payload"),
    ])
    trace_database(storage.twitter, rows)
    trace_database(storage.reddit, [
        interview(0, response=f"Reddit bounded reply {i}", timestamp=f"saved-{i}") for i in range(101)
    ])
    observed = run_workflow(storage, monkeypatch, "bounds")
    assert len(observed) == 1


def test_saved_interviews_response_budget_keeps_both_sources_and_exports_coverage(storage, monkeypatch):
    # Invalid UTF-8 expands under safe ASCII JSON serialization. Each source has
    # enough legitimate trace rows to reach the response budget before row 100.
    for path in (storage.twitter, storage.reddit):
        trace_database(path, [(0, "interview", b"\x80" * 16384, f"saved-{i}") for i in range(40)])
    observed = run_workflow(storage, monkeypatch, "budget")
    assert len(observed) == 1


def test_saved_questions_exact_prompt_preserves_physical_records_and_full_download(storage, monkeypatch):
    prompt = '<script>Question & literal</script>\nCafé 雪 🐟'
    rows = [
        interview(9007199254740993, prompt=prompt, response="Repeated Twitter reply", timestamp=f"repeat-{i}")
        for i in range(30)
    ]
    rows.extend([
        (9007199254740993, "interview", json.dumps({"prompt": prompt}), "missing-response"),
        interview(9007199254740993, prompt=prompt, response="", timestamp="empty-response"),
        interview(2**63 - 1, prompt=prompt, response="Timestamp-only truncation reply", timestamp="T" * 300),
        interview(0, prompt=prompt.lower(), response="case difference"),
        interview(0, prompt=prompt + " ", response="space difference"),
        interview(0, prompt="Interview instruction: " + prompt, response="prefix difference"),
        interview(0, prompt=prompt.replace("é", "e\u0301"), response="Unicode difference"),
        interview(0, prompt="", response="empty prompt Twitter reply"),
        (0, "interview", json.dumps({"response": "Prompt absent"}), "missing-prompt"),
        (0, "interview", '<img src=x onerror=alert(1)>{broken', "raw-literal"),
        interview(0, prompt=prompt, response="X" * 20000, timestamp="incomplete-payload"),
        (0, "interview", None, "missing-payload"),
    ])
    trace_database(storage.twitter, rows)
    trace_database(storage.reddit, [
        interview(9007199254740993, prompt=prompt, response="Repeated Reddit reply", timestamp="reddit-first"),
        interview(9007199254740993, prompt=prompt, response="Repeated Reddit reply", timestamp="reddit-second"),
        (9007199254740993, "interview", json.dumps({"prompt": prompt}), "reddit-missing-response"),
        interview(0, prompt="", response="empty prompt Reddit reply"),
        interview(2**63 - 1, prompt="Reddit-only question beyond first page", response="Later platform reply"),
    ])
    connection = sqlite3.connect(storage.twitter)
    try:
        connection.execute("UPDATE trace SET rowid = ? WHERE rowid = 1", (-2**63,))
        connection.execute("UPDATE trace SET rowid = ? WHERE rowid = 2", (2**63 - 1,))
        connection.commit()
    finally:
        connection.close()
    observed = run_workflow(storage, monkeypatch, "questions", helper="saved-question-backend-check.mjs")
    assert len(observed) == 1


@pytest.mark.parametrize("unhealthy", ["missing", "unreadable"])
def test_saved_questions_keep_limited_source_context_without_inferring_completeness(storage, monkeypatch, unhealthy):
    trace_database(storage.twitter, [
        interview(0, prompt="Outside the bounded observation", response="older", timestamp=f"old-{i}")
        for i in range(10)
    ] + [
        interview(9007199254740993, prompt="Limited repeated question", response=f"Observed reply {i}", timestamp=f"saved-{i}")
        for i in range(100)
    ])
    if unhealthy == "unreadable":
        storage.reddit.write_bytes(b"PRIVATE_CORRUPT_DATABASE_CONTENT")
    observed = run_workflow(storage, monkeypatch, "questions-" + unhealthy, helper="saved-question-backend-check.mjs")
    assert len(observed) == 1
