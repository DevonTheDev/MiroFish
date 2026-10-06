"""Actual saved-only Flask reads from disposable SQLite, with no live resources."""
import hashlib
import json
import sqlite3
from types import SimpleNamespace
from flask import Flask
import pytest
from app.api import simulation as api
from app.services.simulation_runner import SimulationRunner
from app.services.simulation_manager import SimulationManager


def database(path, rows=()):
    connection = sqlite3.connect(path)
    try:
        connection.execute("CREATE TABLE trace (user_id, action TEXT, info, created_at)")
        connection.executemany("INSERT INTO trace VALUES (?, ?, ?, ?)", rows)
        connection.commit()
    finally:
        connection.close()
    return path


def interview(agent=0, prompt="question", response="answer", timestamp="saved time"):
    return (agent, "interview", json.dumps({"prompt": prompt, "response": response}), timestamp)


@pytest.fixture
def storage(tmp_path, monkeypatch):
    root = tmp_path / "saved roots ?#%"
    folder = root / "sim_saved"
    folder.mkdir(parents=True)
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(root))
    def forbidden(*args, **kwargs):
        pytest.fail("Saved interviews consulted a live or unrelated resource")
    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    for name in ("get_run_state", "get_interview_history", "start_simulation", "stop_simulation"):
        monkeypatch.setattr(SimulationRunner, name, forbidden)
    monkeypatch.setattr(api.ZepEntityReader, "__init__", forbidden)
    monkeypatch.setattr(api.ZepGraphMemoryManager, "__init__", forbidden)
    app = Flask(__name__)
    app.json.ensure_ascii = False
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    return SimpleNamespace(root=root, folder=folder, client=app.test_client(),
                           twitter=folder / "twitter_simulation.db", reddit=folder / "reddit_simulation.db")


def get(storage, query="", simulation_id="sim_saved"):
    return storage.client.get(f"/api/simulation/{simulation_id}/saved-interviews" + ("?" + query if query else ""))


def test_both_platforms_exact_ids_literal_text_and_row_order(storage):
    database(storage.twitter, [interview(0, response="older", timestamp="z"),
                               interview(9223372036854775807, response="<script>literal</script>", timestamp="a")])
    database(storage.reddit, [interview(response="reddit")])
    before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (storage.twitter, storage.reddit)]
    response = get(storage)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json["success"] is True
    data = response.json["data"]
    assert data["version"] == 1 and data["simulation_id"] == "sim_saved"
    assert data["filters"] == {"platform": None, "agent_id": None}
    assert data["order"] == "platform_then_row_desc" and data["availability"] == "complete"
    assert [(r["platform"], r["row_id"], r["agent_id"], r["response"]) for r in data["records"]] == [
        ("twitter", "2", "9223372036854775807", "<script>literal</script>"),
        ("twitter", "1", "0", "older"), ("reddit", "1", "0", "reddit")]
    assert [r["record_id"] for r in data["records"]] == ["twitter:2", "twitter:1", "reddit:1"]
    assert data["sources"]["twitter"] == {"status": "available", "returned_count": 2,
        "has_more": False, "coverage": "complete", "warnings": []}
    assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in (storage.twitter, storage.reddit)] == before
    assert sorted(p.name for p in storage.folder.iterdir()) == ["reddit_simulation.db", "twitter_simulation.db"]


@pytest.mark.parametrize("agent", ["0", "9007199254740993", "9223372036854775807"])
def test_exact_agent_filter(storage, agent):
    database(storage.twitter, [interview(0), interview(9007199254740993), interview(9223372036854775807)])
    response = get(storage, f"platform=twitter&agent_id={agent}")
    assert response.status_code == 200
    data = response.json["data"]
    assert data["filters"] == {"platform": "twitter", "agent_id": agent}
    assert [r["agent_id"] for r in data["records"]] == [agent]
    assert data["availability"] == "complete"
    assert data["sources"]["reddit"] == {"status": "not_requested", "returned_count": 0,
        "has_more": None, "coverage": "not_requested", "warnings": []}


@pytest.mark.parametrize("query", ["platform=", "platform=both", "platform=twitter&platform=twitter",
    "agent_id=", "agent_id=00", "agent_id=01", "agent_id=-1", "agent_id=%2B1", "agent_id=1.0",
    "agent_id=9223372036854775808", "agent_id=0&agent_id=0", "agent_id=%200", "agent_id=１２", "limit=1", "revision=x"])
def test_invalid_filters_precede_database_open(storage, monkeypatch, query):
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **k: pytest.fail("invalid query opened database"))
    response = get(storage, query)
    assert response.status_code == 400
    assert response.json["success"] is False and response.json["error_code"] == "invalid_filters"
    assert response.headers["Cache-Control"] == "no-store"
    assert str(storage.root) not in response.get_data(as_text=True)


@pytest.mark.parametrize("simulation_id", ["CON", "bad:stream", "a" * 129, ".."])
def test_invalid_id_precedes_database_open(storage, monkeypatch, simulation_id):
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **k: pytest.fail("invalid ID opened database"))
    response = get(storage, simulation_id=simulation_id)
    assert response.status_code == 400 and response.json["error_code"] == "invalid_selection"


def test_missing_empty_corrupt_are_distinct_and_noncreating(storage):
    unknown = get(storage, simulation_id="unknown").json["data"]
    assert unknown["availability"] == "unavailable" and unknown["records"] == []
    assert all(s["status"] == "missing" and s["has_more"] is None for s in unknown["sources"].values())
    assert not (storage.root / "unknown").exists()
    database(storage.twitter)
    storage.reddit.write_bytes(b"PRIVATE not sqlite")
    data = get(storage).json["data"]
    assert data["availability"] == "partial"
    assert data["sources"]["twitter"]["status"] == "available"
    assert data["sources"]["twitter"]["has_more"] is False
    assert data["sources"]["twitter"]["coverage"] == "complete"
    assert data["sources"]["reddit"]["status"] == "unreadable"
    assert data["sources"]["reddit"]["has_more"] is None
    assert "PRIVATE" not in json.dumps(data)


def test_recent_matching_hundred_per_platform_and_more_flag(storage):
    for path in (storage.twitter, storage.reddit):
        database(path, [interview(i % 2, response=str(i)) for i in range(205)])
    data = get(storage, "agent_id=0").json["data"]
    assert len(data["records"]) == 200
    for platform in ("twitter", "reddit"):
        rows = [r for r in data["records"] if r["platform"] == platform]
        assert len(rows) == 100 and rows[0]["response"] == "204" and rows[-1]["response"] == "6"
        source = data["sources"][platform]
        assert source["has_more"] is True and source["coverage"] == "partial"
        assert "row_limit" in source["warnings"]
    assert data["availability"] == "partial"


def test_exactly_hundred_rows_is_complete(storage):
    database(storage.twitter, [interview() for _ in range(100)])
    data = get(storage, "platform=twitter").json["data"]
    assert len(data["records"]) == 100
    assert data["sources"]["twitter"]["has_more"] is False and data["availability"] == "complete"


@pytest.mark.parametrize("kind", ["record", "twitter", "reddit", "reddit-wal", "reddit-shm", "reddit-journal", "broken"])
def test_all_requested_paths_preflight_before_either_source(storage, monkeypatch, tmp_path, kind):
    database(storage.twitter, [interview()])
    database(storage.reddit, [interview()])
    if kind == "record":
        target = tmp_path / "outside"
        storage.folder.rename(target)
        storage.folder.symlink_to(target, target_is_directory=True)
    else:
        path = storage.twitter if kind == "twitter" else storage.reddit
        if "-" in kind:
            path = path.with_name(path.name + "-" + kind.split("-")[1])
        target = tmp_path / "outside.db"
        if path.exists():
            if kind == "broken":
                path.unlink()
            else:
                path.rename(target)
        if kind != "broken" and not target.exists():
            target.write_bytes(b"")
        path.symlink_to(target)
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **k: pytest.fail("unsafe paths opened a database"))
    response = get(storage)
    assert response.status_code == 400 and response.json["error_code"] == "unsafe_path"
    assert str(tmp_path) not in response.get_data(as_text=True)


def test_unrequested_alias_does_not_block_selected_source(storage, tmp_path):
    database(storage.twitter, [interview()])
    storage.reddit.symlink_to(tmp_path / "nonexistent")
    assert get(storage, "platform=twitter").json["data"]["availability"] == "complete"


def test_trusted_root_alias_and_escaped_uri(storage, monkeypatch, tmp_path):
    database(storage.twitter, [interview(response="escaped path")])
    alias = tmp_path / "root alias"
    alias.symlink_to(storage.root, target_is_directory=True)
    monkeypatch.setattr(SimulationRunner, "RUN_STATE_DIR", str(alias))
    assert get(storage, "platform=twitter").json["data"]["records"][0]["response"] == "escaped path"


@pytest.mark.parametrize("method", ["post", "put", "delete", "patch"])
def test_no_mutating_methods(storage, method):
    assert getattr(storage.client, method)("/api/simulation/sim_saved/saved-interviews").status_code == 405
