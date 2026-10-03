"""Immutable aggregate captures use disposable real logs and SQLite files."""

import concurrent.futures
import errno
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

import pytest

from scripts.action_logger import PlatformActionLogger


@pytest.fixture
def captures():
    assert importlib.util.find_spec("app.services.run_captures") is not None, "Capture service is missing"
    return importlib.import_module("app.services.run_captures")


@pytest.fixture
def roots(tmp_path):
    return tmp_path / "captures", tmp_path / "simulations", tmp_path / "runs"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def native_link_or_fifo(operation, kind):
    try:
        operation()
    except (AttributeError, NotImplementedError):
        pytest.skip(f"Native {kind} fixture is unsupported")
    except OSError as error:
        if error.errno in {errno.EACCES, errno.EPERM, errno.ENOSYS, errno.ENOTSUP} or getattr(error, "winerror", None) == 1314:
            pytest.skip(f"Native {kind} fixture is unsupported or denied")
        raise


def saved(roots, *, status="completed", actions=1, reddit=False):
    _, simulations, runs = roots
    write_json(simulations / "sim_one" / "state.json", {
        "simulation_id": "sim_one", "status": status,
        "project_id": "project", "graph_id": "graph", "profiles_count": 3,
        "enable_twitter": True, "enable_reddit": reddit,
    })
    write_json(simulations / "sim_one" / "simulation_config.json", {
        "simulation_requirement": "Synthetic scenario", "llm_model": "configured-model",
        "api_key": "private-secret", "llm_base_url": "https://secret.invalid",
    })
    write_json(runs / "sim_one" / "run_state.json", {
        "simulation_id": "sim_one", "runner_status": status, "total_rounds": 10,
        "current_round": 3, "updated_at": "2026-10-03T00:00:00Z",
    })
    logger = PlatformActionLogger("twitter", str(runs / "sim_one"))
    Path(logger.log_path).write_text("")
    logger.log_simulation_start({})
    for number in range(actions):
        logger.log_action(number, number, "Synthetic agent", "POST", {"private": "body"}, "result", False)
    logger.log_simulation_end(10, actions)
    return Path(logger.log_path)


def preview(captures, roots):
    return captures.preview_saved_run(*map(str, roots[1:]), "sim_one")


def create(captures, roots, capture_id="1" * 32, *, label="First run", note="", revision=None):
    revision = revision or preview(captures, roots)["source_revision"]
    return captures.create_run_capture(*map(str, roots), capture_id, "sim_one", revision, label, note)


def test_capture_preserves_saved_observation_after_source_replacement_and_deletion(captures, roots):
    saved(roots, actions=2)
    observed = preview(captures, roots)
    assert not roots[0].exists()
    assert observed["schema_version"] == 1
    assert observed["summary"]["configured_agents"] == "3"
    assert observed["summary"]["requested_rounds"] == "10"
    assert observed["summary"]["metrics"]["recorded_actions"] == 2
    first, created = create(captures, roots, revision=observed["source_revision"])
    assert created is True
    assert set(first) == {"schema_version", "capture_id", "label", "note", "captured_at", "observation"}
    saved(roots, actions=0)
    second, _ = create(captures, roots, "2" * 32, label="Second run")
    shutil.rmtree(roots[1])
    shutil.rmtree(roots[2])
    assert captures.get_run_capture(str(roots[0]), first["capture_id"]) == first
    result = captures.compare_run_captures(str(roots[0]), first["capture_id"], second["capture_id"])
    assert result["differences"]["recorded_actions"] == -2
    assert result["differences"]["platforms"]["reddit"]["recorded_actions"] is None
    encoded = json.dumps(result)
    for secret in ("private-secret", "secret.invalid", '"body"', '"result"', "request_hash", str(roots[0])):
        assert secret not in encoded


def test_replay_precedes_source_access_and_cap_but_conflicting_request_does_not(captures, roots, monkeypatch):
    saved(roots)
    revision = preview(captures, roots)["source_revision"]
    first, _ = create(captures, roots, revision=revision)
    shutil.rmtree(roots[1])
    shutil.rmtree(roots[2])
    monkeypatch.setattr(captures, "MAX_CAPTURES", 1)
    def forbidden(*args, **kwargs):
        pytest.fail("Idempotent replay must not access saved source")
    monkeypatch.setattr(captures, "preview_saved_run", forbidden)
    replayed, created = create(captures, roots, revision=revision)
    assert replayed == first and created is False
    with pytest.raises(captures.RunCaptureError) as error:
        create(captures, roots, label="Different", revision=revision)
    assert (error.value.code, error.value.status_code) == ("capture_conflict", 409)


def test_absent_reads_never_create_storage(captures, roots):
    assert captures.list_run_captures(str(roots[0])) == {
        "captures": [], "offset": 0, "limit": 20, "total": 0, "has_more": False,
    }
    with pytest.raises(captures.RunCaptureError) as error:
        captures.get_run_capture(str(roots[0]), "1" * 32)
    assert (error.value.code, error.value.status_code) == ("capture_not_found", 404)
    assert not roots[0].exists()


@pytest.mark.parametrize("status", ["idle", "ready", "running", "paused", "starting", "stopping"])
def test_saved_status_must_be_terminal(captures, roots, status):
    saved(roots, status=status)
    with pytest.raises(captures.RunCaptureError) as error:
        preview(captures, roots)
    assert error.value.status_code == 409
    assert not roots[0].exists()


@pytest.mark.parametrize("status", ["stopped", "failed"])
def test_partial_terminal_runs_and_missing_logs_keep_null_semantics(captures, roots, status):
    path = saved(roots, status=status, reddit=True)
    with path.open("a") as stream:
        stream.write("invalid\n")
    first, _ = create(captures, roots)
    saved(roots)
    second, _ = create(captures, roots, "2" * 32)
    result = captures.compare_run_captures(str(roots[0]), first["capture_id"], second["capture_id"])
    summary = first["observation"]["summary"]
    assert summary["status"] == status and summary["availability"] == "partial"
    assert summary["metrics"]["recorded_actions"] == 1
    assert summary["metrics"]["platforms"]["reddit"]["recorded_actions"] is None
    assert result["differences"]["recorded_actions"] is None
    assert result["differences"]["platforms"]["twitter"]["recorded_actions"] is None
    assert {"code": "partial_run"} in summary["warnings"]


def test_pagination_is_stable_and_validated(captures, roots):
    saved(roots)
    for number in range(3):
        create(captures, roots, f"{number:032x}")
    page = captures.list_run_captures(str(roots[0]), offset=1, limit=1)
    assert page["total"] == 3 and page["has_more"] is True
    assert page["captures"][0]["capture_id"] == f"{1:032x}"
    assert set(page["captures"][0]) == {"capture_id", "simulation_id", "label", "captured_at", "status", "availability"}
    for offset, limit in ((-1, 1), (501, 1), (True, 1), (0, 0), (0, 51), (0, True)):
        with pytest.raises(captures.RunCaptureError) as error:
            captures.list_run_captures(str(roots[0]), offset, limit)
        assert error.value.status_code == 400


@pytest.mark.parametrize("label,note", [("", ""), ("  ", ""), ("x" * 121, ""), ("x\n", ""), ("x", "a" * 2001), ("x", "\x00"), ("x", "\ud800"), (True, "")])
def test_invalid_text_fails_before_storage(captures, roots, label, note):
    with pytest.raises(captures.RunCaptureError) as error:
        create(captures, roots, label=label, note=note, revision="a" * 64)
    assert error.value.status_code == 400
    assert not roots[0].exists()


def test_expected_revision_and_root_identity_reject_stale_source(captures, roots, tmp_path):
    saved(roots)
    observed = preview(captures, roots)
    saved(roots, actions=3)
    with pytest.raises(captures.RunCaptureError) as error:
        create(captures, roots, revision=observed["source_revision"])
    assert (error.value.code, error.value.status_code) == ("sources_changed", 409)
    other = tmp_path / "other"
    shutil.copytree(roots[1], other)
    assert captures.preview_saved_run(str(other), str(roots[2]), "sim_one")["source_revision"] != preview(captures, roots)["source_revision"]
    assert not roots[0].exists()


@pytest.mark.parametrize("filename", ["run_captures.sqlite3", "run_captures.sqlite3-journal", "run_captures.sqlite3-wal", "run_captures.sqlite3-shm"])
@pytest.mark.parametrize("kind", ["symlink", "directory", "fifo"])
def test_unsafe_database_and_sidecars_are_refused(captures, roots, tmp_path, filename, kind):
    roots[0].mkdir()
    path = roots[0] / filename
    target = tmp_path / "outside"
    target.write_text("untouched")
    if kind == "symlink":
        native_link_or_fifo(lambda: path.symlink_to(target), "symlink")
    elif kind == "directory":
        path.mkdir()
    else:
        native_link_or_fifo(lambda: os.mkfifo(path), "FIFO")
    with pytest.raises(captures.RunCaptureError) as error:
        captures.list_run_captures(str(roots[0]))
    assert error.value.code == "unsafe_capture_path"
    assert str(tmp_path) not in str(error.value)
    assert target.read_text() == "untouched"


def test_database_corruption_and_foreign_schema_fail_closed(captures, roots):
    roots[0].mkdir()
    db = roots[0] / "run_captures.sqlite3"
    db.write_bytes(b"private-corrupt-database")
    with pytest.raises(captures.RunCaptureError) as error:
        captures.list_run_captures(str(roots[0]))
    assert error.value.code == "capture_storage_invalid"
    assert "private" not in str(error.value)
    db.unlink()
    with sqlite3.connect(db) as connection:
        connection.execute("CREATE TABLE unrelated (id TEXT)")
    before = db.read_bytes()
    saved(roots)
    with pytest.raises(captures.RunCaptureError):
        create(captures, roots)
    assert db.read_bytes() == before


def test_concurrent_creators_obey_cap_and_primary_key(captures, roots, monkeypatch):
    saved(roots)
    revision = preview(captures, roots)["source_revision"]
    monkeypatch.setattr(captures, "MAX_CAPTURES", 2)
    def attempt(number):
        try:
            return create(captures, roots, f"{number:032x}", revision=revision)[1]
        except captures.RunCaptureError as error:
            return error.code
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(attempt, [1, 1, 1, 2, 3, 4]))
    assert sum(result is True for result in results) == 2
    assert set(results).issubset({True, False, "capture_limit_reached"})
    assert captures.list_run_captures(str(roots[0]))["total"] == 2


def test_saved_payload_digest_and_schema_are_validated(captures, roots):
    saved(roots)
    first, _ = create(captures, roots)
    db = roots[0] / "run_captures.sqlite3"
    with sqlite3.connect(db) as connection:
        connection.execute("UPDATE captures SET payload_hash = ?", ("0" * 64,))
    with pytest.raises(captures.RunCaptureError) as error:
        captures.get_run_capture(str(roots[0]), first["capture_id"])
    assert error.value.code == "capture_storage_invalid"
    malformed = {**first, "unexpected": "private-data"}
    payload = json.dumps(malformed, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    with sqlite3.connect(db) as connection:
        connection.execute("UPDATE captures SET payload = ?, payload_hash = ?", (payload, hashlib.sha256(payload).hexdigest()))
    with pytest.raises(captures.RunCaptureError) as error:
        captures.list_run_captures(str(roots[0]))
    assert error.value.code == "capture_storage_invalid"


def test_get_list_and_compare_are_byte_preserving_read_only(captures, roots, monkeypatch):
    saved(roots)
    first, _ = create(captures, roots)
    second, _ = create(captures, roots, "2" * 32)
    before = {path: path.read_bytes() for root in roots for path in root.rglob("*") if path.is_file()}
    connect = sqlite3.connect
    connections = []
    def observed_connect(database, *args, **kwargs):
        assert "mode=ro" in database and kwargs.get("uri") is True
        result = connect(database, *args, **kwargs)
        connections.append(database)
        return result
    monkeypatch.setattr(sqlite3, "connect", observed_connect)
    captures.get_run_capture(str(roots[0]), first["capture_id"])
    captures.list_run_captures(str(roots[0]))
    captures.compare_run_captures(str(roots[0]), first["capture_id"], second["capture_id"])
    assert connections
    after = {path: path.read_bytes() for root in roots for path in root.rglob("*") if path.is_file()}
    assert after == before


def test_log_and_metadata_budgets_refuse_sources_without_truncated_counts(captures, roots, monkeypatch):
    path = saved(roots, actions=2)
    monkeypatch.setattr(captures.comparison, "MAX_LOG_BYTES", 16)
    value, _ = create(captures, roots)
    summary = value["observation"]["summary"]
    assert summary["availability"] == "unavailable"
    assert summary["metrics"]["recorded_actions"] is None
    assert {"code": "source_too_large", "platform": "twitter"} in summary["warnings"]
    monkeypatch.setattr(captures.comparison, "MAX_STATE_BYTES", 5)
    with pytest.raises(captures.RunCaptureError) as error:
        preview(captures, roots)
    assert error.value.code == "simulation_unreadable"
    assert path.exists()


def test_oversize_capture_is_refused_without_storage_creation(captures, roots, monkeypatch):
    saved(roots)
    monkeypatch.setattr(captures, "MAX_CAPTURE_BYTES", 100)
    with pytest.raises(captures.RunCaptureError) as error:
        preview(captures, roots)
    assert error.value.code == "capture_too_large"
    assert not roots[0].exists()


def test_numeric_context_ids_and_large_hints_are_lossless_strings(captures, roots):
    saved(roots)
    path = roots[1] / "sim_one" / "state.json"
    state = json.loads(path.read_text())
    state.update(project_id=2 ** 100, graph_id=0, profiles_count=2 ** 100)
    write_json(path, state)
    summary = preview(captures, roots)["summary"]
    assert summary["project_id"] == summary["configured_agents"] == str(2 ** 100)
    assert summary["graph_id"] == "0"
    state.update(project_id=True, graph_id=-1, profiles_count=True)
    write_json(path, state)
    summary = preview(captures, roots)["summary"]
    assert summary["project_id"] is summary["graph_id"] is summary["configured_agents"] is None


def test_revision_includes_read_outcome_and_changed_files(captures, roots, monkeypatch):
    saved(roots)
    revision = preview(captures, roots)["source_revision"]
    original = captures.comparison._metadata
    def temporarily_unreadable(path, maximum):
        return None if path.endswith("simulation_config.json") else original(path, maximum)
    monkeypatch.setattr(captures.comparison, "_metadata", temporarily_unreadable)
    assert preview(captures, roots)["source_revision"] != revision
    monkeypatch.setattr(captures.comparison, "_metadata", original)
    original_summary = captures.comparison._summary
    def changing_summary(*args, **kwargs):
        result = original_summary(*args, **kwargs)
        (roots[2] / "sim_one" / "run_state.json").unlink()
        return result
    monkeypatch.setattr(captures.comparison, "_summary", changing_summary)
    with pytest.raises(captures.RunCaptureError) as error:
        preview(captures, roots)
    assert error.value.code == "sources_changed"


def test_no_live_runner_or_manager_is_consulted(captures, roots, monkeypatch):
    from app.services.simulation_manager import SimulationManager
    from app.services.simulation_runner import SimulationRunner
    def forbidden(*args, **kwargs):
        pytest.fail("Saved captures must not inspect live runtime ownership")
    monkeypatch.setattr(SimulationManager, "__init__", forbidden)
    monkeypatch.setattr(SimulationRunner, "get_run_state", forbidden)
    monkeypatch.setattr(SimulationRunner, "start_simulation", forbidden)
    saved(roots)
    create(captures, roots)


def test_saved_source_unicode_is_ascii_escaped_but_human_text_is_exact(captures, roots):
    saved(roots)
    path = roots[1] / "sim_one" / "simulation_config.json"
    write_json(path, {"simulation_requirement": "\ud800"})
    value, _ = create(captures, roots, label="  原样  ", note="note\n\t原样")
    assert value["label"] == "  原样  "
    assert value["note"] == "note\n\t原样"
    assert value["observation"]["summary"]["scenario"] == "\ud800"
    assert captures.get_run_capture(str(roots[0]), value["capture_id"]) == value


@pytest.mark.parametrize("bad", ["../x", "A" * 32, "0" * 31, True, None])
def test_invalid_ids_fail_before_any_read(captures, roots, monkeypatch, bad):
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid input must fail before a storage connection")
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    with pytest.raises(captures.RunCaptureError) as error:
        captures.get_run_capture(str(roots[0]), bad)
    assert error.value.code == "invalid_capture_id"


def test_root_symlinks_are_refused(captures, roots, tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    native_link_or_fifo(lambda: roots[0].symlink_to(target, target_is_directory=True), "symlink")
    with pytest.raises(captures.RunCaptureError) as error:
        captures.list_run_captures(str(roots[0]))
    assert error.value.code == "unsafe_capture_path"


def test_database_hardlinks_are_refused(captures, roots, tmp_path):
    saved(roots)
    create(captures, roots)
    native_link_or_fifo(lambda: os.link(roots[0] / "run_captures.sqlite3", tmp_path / "hardlink.sqlite3"), "hardlink")
    with pytest.raises(captures.RunCaptureError) as error:
        captures.list_run_captures(str(roots[0]))
    assert error.value.code == "unsafe_capture_path"


def test_special_characters_in_storage_directory_use_escaped_uri(captures, roots, tmp_path):
    special_roots = (tmp_path / "percent%hash#" / "captures", *roots[1:])
    saved(special_roots)
    value, _ = create(captures, special_roots)
    assert captures.get_run_capture(str(special_roots[0]), value["capture_id"]) == value


def test_source_reads_happen_without_a_write_lock(captures, roots, monkeypatch):
    saved(roots)
    create(captures, roots)
    original = captures.comparison._read_log
    def check_lock(*args, **kwargs):
        with sqlite3.connect(roots[0] / "run_captures.sqlite3", timeout=0) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.rollback()
        return original(*args, **kwargs)
    monkeypatch.setattr(captures.comparison, "_read_log", check_lock)
    create(captures, roots, "2" * 32)


def test_insert_and_commit_failures_rollback_without_reporting_success(captures, roots, monkeypatch):
    saved(roots)
    first, _ = create(captures, roots)
    connect = sqlite3.connect
    for phase in ("insert", "commit"):
        class FailingConnection(sqlite3.Connection):
            def execute(self, statement, *args, **kwargs):
                if phase == "insert" and statement.startswith("INSERT INTO captures"):
                    super().execute(statement, *args, **kwargs)
                    raise sqlite3.OperationalError("private-insert-failure")
                return super().execute(statement, *args, **kwargs)
            def commit(self):
                if phase == "commit":
                    raise sqlite3.OperationalError("private-commit-failure")
                return super().commit()
        def failing_connect(*args, **kwargs):
            return connect(*args, **kwargs, factory=FailingConnection)
        monkeypatch.setattr(sqlite3, "connect", failing_connect)
        with pytest.raises(captures.RunCaptureError) as error:
            create(captures, roots, "2" * 32)
        assert "private" not in str(error.value)
        monkeypatch.setattr(sqlite3, "connect", connect)
        assert captures.list_run_captures(str(roots[0]))["total"] == 1
        assert captures.get_run_capture(str(roots[0]), first["capture_id"]) == first


@pytest.mark.parametrize("numbers,expected_count", [((1, 1, 2, 3, 4), 2), ((1, 1, 1, 1, 1), 1)])
def test_independent_processes_obey_capacity_and_same_request_idempotency(captures, roots, numbers, expected_count):
    saved(roots)
    revision = preview(captures, roots)["source_revision"]
    script = """
import json, sys
from app.services import run_captures as c
c.MAX_CAPTURES = 2
try:
    capture, created = c.create_run_capture(*sys.argv[1:4], sys.argv[4], 'sim_one', sys.argv[5], 'First run', '')
    print(json.dumps({'created': created}))
except c.RunCaptureError as error:
    print(json.dumps({'code': error.code}))
"""
    processes = [subprocess.Popen([sys.executable, "-c", script, *map(str, roots), f"{number:032x}", revision], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for number in numbers]
    results = []
    for process in processes:
        stdout, stderr = process.communicate(timeout=20)
        assert process.returncode == 0, stderr
        results.append(json.loads(stdout))
    assert sum(item.get("created") is True for item in results) == expected_count
    assert all(item.get("code") in (None, "capture_limit_reached") for item in results)
    if expected_count == 1:
        assert sum(item.get("created") is False for item in results) == 4
    assert captures.list_run_captures(str(roots[0]))["total"] == expected_count


def test_read_only_rejects_wal_before_sqlite_can_create_sidecars(captures, roots):
    saved(roots)
    create(captures, roots)
    db = roots[0] / "run_captures.sqlite3"
    with sqlite3.connect(db) as connection:
        assert connection.execute("PRAGMA journal_mode = WAL").fetchone()[0] == "wal"
    connection.close()
    before = {path.name: path.read_bytes() for path in roots[0].iterdir()}
    with pytest.raises(captures.RunCaptureError) as error:
        captures.list_run_captures(str(roots[0]))
    assert error.value.code == "capture_storage_invalid"
    assert {path.name: path.read_bytes() for path in roots[0].iterdir()} == before


@pytest.mark.parametrize("mutate", [
    lambda value: value["observation"]["summary"]["metrics"].update(recorded_actions=True),
    lambda value: value["observation"]["summary"]["metrics"].update(recorded_actions=99),
    lambda value: value["observation"]["summary"]["metrics"]["platforms"]["reddit"].update(recorded_actions=0),
    lambda value: value["observation"]["summary"].update(status=[]),
    lambda value: value["observation"]["summary"].update(configured_agents=3),
    lambda value: value["observation"]["summary"].update(warnings=[{"code": "unknown"}]),
    lambda value: value["observation"]["summary"]["metrics"].update(action_types=[{"action_type": "POST", "count": 1}, {"action_type": "POST", "count": 1}]),
])
def test_digest_matched_semantically_corrupt_captures_are_refused(captures, roots, mutate):
    saved(roots)
    value, _ = create(captures, roots)
    mutate(value)
    payload = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    with sqlite3.connect(roots[0] / "run_captures.sqlite3") as connection:
        connection.execute("UPDATE captures SET payload = ?, payload_hash = ?", (payload, hashlib.sha256(payload).hexdigest()))
    with pytest.raises(captures.RunCaptureError) as error:
        captures.get_run_capture(str(roots[0]), value["capture_id"])
    assert error.value.code == "capture_storage_invalid"


def test_corrupt_request_hash_is_refused_even_when_valid_hex(captures, roots):
    saved(roots)
    value, _ = create(captures, roots)
    with sqlite3.connect(roots[0] / "run_captures.sqlite3") as connection:
        connection.execute("UPDATE captures SET request_hash = ?", ("a" * 64,))
    with pytest.raises(captures.RunCaptureError) as error:
        captures.get_run_capture(str(roots[0]), value["capture_id"])
    assert error.value.code == "capture_storage_invalid"


def test_real_database_busy_error_is_bounded_safe_and_rolls_back(captures, roots):
    saved(roots)
    create(captures, roots)
    with sqlite3.connect(roots[0] / "run_captures.sqlite3") as blocker:
        blocker.execute("BEGIN IMMEDIATE")
        with pytest.raises(captures.RunCaptureError) as error:
            create(captures, roots, "2" * 32)
        assert (error.value.code, error.value.status_code) == ("capture_storage_busy", 503)
    assert captures.list_run_captures(str(roots[0]))["total"] == 1


def test_existing_database_file_size_limit_is_enforced_before_connect(captures, roots, monkeypatch):
    saved(roots)
    create(captures, roots)
    db = roots[0] / "run_captures.sqlite3"
    monkeypatch.setattr(captures, "MAX_DATABASE_BYTES", db.stat().st_size - 1)
    def forbidden(*args, **kwargs):
        pytest.fail("Oversized store must fail before SQLite connects")
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    with pytest.raises(captures.RunCaptureError) as error:
        captures.list_run_captures(str(roots[0]))
    assert (error.value.code, error.value.status_code) == ("capture_storage_full", 507)


def test_sqlite_page_limit_rolls_back_full_database(captures, roots, monkeypatch):
    saved(roots)
    create(captures, roots)
    db = roots[0] / "run_captures.sqlite3"
    monkeypatch.setattr(captures, "MAX_DATABASE_BYTES", db.stat().st_size)
    config = roots[1] / "sim_one" / "simulation_config.json"
    write_json(config, {"simulation_requirement": "X" * 40_000})
    with pytest.raises(captures.RunCaptureError) as error:
        create(captures, roots, "2" * 32)
    assert (error.value.code, error.value.status_code) == ("capture_storage_full", 507)
    assert captures.list_run_captures(str(roots[0]))["total"] == 1


def test_initial_database_cannot_exceed_page_limit(captures, roots, monkeypatch):
    saved(roots)
    monkeypatch.setattr(captures, "MAX_DATABASE_BYTES", 4096)
    with pytest.raises(captures.RunCaptureError) as error:
        create(captures, roots)
    assert error.value.code == "capture_storage_full"
    assert (roots[0] / "run_captures.sqlite3").stat().st_size <= 4096


def test_schema_tampering_is_rejected_without_mutating_database(captures, roots):
    saved(roots)
    create(captures, roots)
    db = roots[0] / "run_captures.sqlite3"
    with sqlite3.connect(db) as connection:
        connection.execute("CREATE TRIGGER dangerous AFTER INSERT ON captures BEGIN DELETE FROM captures; END")
    before = db.read_bytes()
    with pytest.raises(captures.RunCaptureError) as error:
        create(captures, roots, "2" * 32)
    assert error.value.code == "capture_storage_invalid"
    assert db.read_bytes() == before


def test_empty_legacy_without_enable_flags_keeps_established_partial_semantics(captures, roots):
    saved(roots)
    (roots[2] / "sim_one" / "twitter" / "actions.jsonl").unlink()
    (roots[2] / "sim_one" / "actions.jsonl").write_text("")
    state_path = roots[1] / "sim_one" / "state.json"
    state = json.loads(state_path.read_text())
    del state["enable_twitter"], state["enable_reddit"]
    write_json(state_path, state)
    value, _ = create(captures, roots)
    summary = value["observation"]["summary"]
    assert summary["availability"] == "partial"
    assert summary["metrics"]["recorded_actions"] == 0
    assert summary["metrics"]["platforms"]["twitter"]["recorded_actions"] is None


def crash_with_hot_journal(database):
    script = """
import os, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA cache_size=1')
connection.execute('BEGIN IMMEDIATE')
connection.execute('UPDATE captures SET payload=?', (b'X' * 200000,))
os._exit(0)
"""
    result = subprocess.run([sys.executable, "-c", script, str(database)], timeout=10)
    assert result.returncode == 0
    journal = Path(str(database) + "-journal")
    assert journal.is_file() and journal.read_bytes()[:8] == bytes.fromhex("d9d505f920a163d7")


def test_hot_journal_get_does_not_write_and_identical_save_recovers_without_source(captures, roots, monkeypatch):
    saved(roots)
    revision = preview(captures, roots)["source_revision"]
    first, _ = create(captures, roots, revision=revision)
    crash_with_hot_journal(roots[0] / "run_captures.sqlite3")
    before = {path.name: path.read_bytes() for path in roots[0].iterdir()}
    for read in (
        lambda: captures.get_run_capture(str(roots[0]), first["capture_id"]),
        lambda: captures.list_run_captures(str(roots[0])),
        lambda: captures.compare_run_captures(str(roots[0]), first["capture_id"], "2" * 32),
    ):
        with pytest.raises(captures.RunCaptureError) as error:
            read()
        assert (error.value.code, error.value.status_code) == ("capture_recovery_required", 503)
        assert {path.name: path.read_bytes() for path in roots[0].iterdir()} == before
    shutil.rmtree(roots[1])
    shutil.rmtree(roots[2])
    monkeypatch.setattr(captures, "MAX_CAPTURES", 1)
    replay, created = create(captures, roots, revision=revision)
    assert replay == first and created is False
    assert captures.get_run_capture(str(roots[0]), first["capture_id"]) == first
    assert not (roots[0] / "run_captures.sqlite3-journal").exists()


def test_new_capture_save_recovers_hot_journal_then_checks_source(captures, roots):
    saved(roots)
    first, _ = create(captures, roots)
    crash_with_hot_journal(roots[0] / "run_captures.sqlite3")
    second, created = create(captures, roots, "2" * 32)
    assert created is True
    assert captures.get_run_capture(str(roots[0]), first["capture_id"]) == first
    assert captures.get_run_capture(str(roots[0]), second["capture_id"]) == second


@pytest.mark.parametrize("offset,replacement", [(60, 2), (68, 0)])
def test_save_never_recovers_hot_journal_when_header_identity_is_wrong(captures, roots, offset, replacement):
    saved(roots)
    revision = preview(captures, roots)["source_revision"]
    create(captures, roots, revision=revision)
    crash_with_hot_journal(roots[0] / "run_captures.sqlite3")
    with (roots[0] / "run_captures.sqlite3").open("r+b") as stream:
        stream.seek(offset)
        stream.write(replacement.to_bytes(4, "big"))
    before = {path.name: path.read_bytes() for path in roots[0].iterdir()}
    for action in (lambda: create(captures, roots, revision=revision),
                   lambda: captures.recover_run_captures(str(roots[0]))):
        with pytest.raises(captures.RunCaptureError) as error:
            action()
        assert error.value.code == "capture_storage_invalid"
        assert {path.name: path.read_bytes() for path in roots[0].iterdir()} == before


def test_generic_readonly_failure_does_not_trigger_writable_recovery(captures, roots, monkeypatch):
    saved(roots)
    revision = preview(captures, roots)["source_revision"]
    create(captures, roots, revision=revision)
    before = {path.name: path.read_bytes() for path in roots[0].iterdir()}
    connect = sqlite3.connect
    class ReadOnlyFailure(sqlite3.Connection):
        def execute(self, statement, *args, **kwargs):
            if statement == "PRAGMA journal_mode":
                error = sqlite3.OperationalError("private-readonly-error")
                error.sqlite_errorcode = sqlite3.SQLITE_READONLY
                raise error
            return super().execute(statement, *args, **kwargs)
    def fail_read_only(database, *args, **kwargs):
        assert "mode=ro" in database, "General errors must not open a writable recovery connection"
        return connect(database, *args, **kwargs, factory=ReadOnlyFailure)
    monkeypatch.setattr(sqlite3, "connect", fail_read_only)
    with pytest.raises(captures.RunCaptureError) as error:
        create(captures, roots, revision=revision)
    assert error.value.code == "capture_storage_unavailable"
    assert {path.name: path.read_bytes() for path in roots[0].iterdir()} == before


def test_explicit_recovery_needs_no_simulation_and_validates_retained_records(captures, roots):
    saved(roots)
    first, _ = create(captures, roots)
    second, _ = create(captures, roots, "2" * 32)
    crash_with_hot_journal(roots[0] / "run_captures.sqlite3")
    shutil.rmtree(roots[1])
    shutil.rmtree(roots[2])
    assert captures.recover_run_captures(str(roots[0])) == {"recovered": True}
    assert captures.get_run_capture(str(roots[0]), first["capture_id"]) == first
    assert captures.get_run_capture(str(roots[0]), second["capture_id"]) == second
    assert captures.recover_run_captures(str(roots[0])) == {"recovered": False}


def test_explicit_recovery_is_read_only_and_creates_nothing_when_absent_or_healthy(captures, roots, monkeypatch):
    assert captures.recover_run_captures(str(roots[0])) == {"recovered": False}
    assert not roots[0].exists()
    saved(roots)
    create(captures, roots)
    before = {path.name: path.read_bytes() for path in roots[0].iterdir()}
    connect = sqlite3.connect
    def read_only_connect(database, *args, **kwargs):
        assert "mode=ro" in database
        return connect(database, *args, **kwargs)
    monkeypatch.setattr(sqlite3, "connect", read_only_connect)
    assert captures.recover_run_captures(str(roots[0])) == {"recovered": False}
    assert {path.name: path.read_bytes() for path in roots[0].iterdir()} == before


def test_explicit_recovery_does_not_claim_to_repair_corrupt_committed_payloads(captures, roots):
    saved(roots)
    create(captures, roots)
    db = roots[0] / "run_captures.sqlite3"
    with sqlite3.connect(db) as connection:
        connection.execute("UPDATE captures SET payload_hash = ?", ("0" * 64,))
    crash_with_hot_journal(db)
    with pytest.raises(captures.RunCaptureError) as error:
        captures.recover_run_captures(str(roots[0]))
    assert error.value.code == "capture_storage_invalid"
    # SQLite must finish its rollback before record validation can run.
    assert not Path(str(db) + "-journal").exists()
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT payload_hash FROM captures").fetchone()[0] == "0" * 64
