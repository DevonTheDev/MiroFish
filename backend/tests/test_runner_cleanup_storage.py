"""Restart cleanup confined to disposable files and synthetic runner ownership."""

import builtins
import json
from pathlib import Path
import threading
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api import simulation as api
from app.services import simulation_runner as module
from app.services.simulation_runner import (
    SimulationRunner as Runner,
    SimulationRunState,
    RunnerStatus,
)
from app.services.simulation_manager import (
    SimulationManager,
    SimulationState,
    SimulationStatus,
)
from app.services.zep_graph_memory_updater import ZepGraphMemoryManager


TARGETS = [
    "run_state.json",
    "simulation.log",
    "stdout.log",
    "stderr.log",
    "twitter_simulation.db",
    "reddit_simulation.db",
    "env_status.json",
    "twitter/actions.jsonl",
    "reddit/actions.jsonl",
]
KEEP = [
    "state.json",
    "simulation_config.json",
    "reddit_profiles.json",
    "twitter_profiles.csv",
    "notes.txt",
]


@pytest.fixture
def storage(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    folder = root / "sim_fixture"
    folder.mkdir(parents=True)
    for name in TARGETS + KEEP:
        path = folder / name
        path.parent.mkdir(exist_ok=True)
        path.write_text("fixture")
    state = SimulationRunState("sim_fixture", runner_status=RunnerStatus.STOPPED)
    updaters = {}
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(root))
    monkeypatch.setattr(Runner, "_run_states", {"sim_fixture": state})
    monkeypatch.setattr(Runner, "_processes", {})
    monkeypatch.setattr(Runner, "_monitor_threads", {})
    monkeypatch.setattr(Runner, "_finalization_locks", {})
    monkeypatch.setattr(
        ZepGraphMemoryManager,
        "get_updater",
        classmethod(lambda cls, sid: updaters.get(sid)),
    )
    return SimpleNamespace(root=root, folder=folder, state=state, updaters=updaters)


def symlink(link, target, directory=False):
    try:
        link.symlink_to(target, target_is_directory=directory)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")


@pytest.mark.parametrize(
    "record_id",
    [
        "",
        ".",
        "..",
        "../outside",
        r"..\outside",
        "__absolute__",
        "CON",
        "sim:stream",
        None,
        42,
    ],
)
def test_invalid_cleanup_ids_never_reach_delete(
    storage, tmp_path, monkeypatch, record_id
):
    if record_id == "__absolute__":
        record_id = str(tmp_path / "outside")
    removed = []
    monkeypatch.setattr(module.os, "remove", lambda path: removed.append(path))
    result = Runner.cleanup_simulation_logs(record_id)
    assert result["success"] is False
    assert result["cleaned_files"] == []
    assert result["errors"]
    assert removed == []
    assert Runner._run_states["sim_fixture"] is storage.state


@pytest.mark.parametrize("kind", ["record", "platform", "file", "missing_link_target"])
def test_alias_preflight_refuses_every_target_before_deleting_anything(
    storage, tmp_path, monkeypatch, kind
):
    folder = storage.folder
    if kind == "record":
        target = tmp_path / "outside"
        folder.rename(target)
        symlink(folder, target, True)
    elif kind == "platform":
        target = tmp_path / "outside"
        (folder / "twitter").rename(target)
        symlink(folder / "twitter", target, True)
    else:
        child = folder / "stderr.log"
        target = tmp_path / "external.log"
        if kind == "file":
            child.rename(target)
        else:
            child.unlink()
        symlink(child, target)
    removed = []
    monkeypatch.setattr(module.os, "remove", lambda path: removed.append(path))
    result = Runner.cleanup_simulation_logs("sim_fixture")
    assert result["success"] is False
    assert result["cleaned_files"] == []
    assert removed == []
    assert Runner._run_states["sim_fixture"] is storage.state


@pytest.mark.parametrize(
    "owner",
    ["process", "monitor", "updater", "starting", "running", "paused", "stopping"],
)
def test_cleanup_refuses_owned_or_unfinished_work(storage, owner):
    if owner == "process":
        Runner._processes["sim_fixture"] = SimpleNamespace(poll=lambda: None)
    elif owner == "monitor":
        Runner._monitor_threads["sim_fixture"] = SimpleNamespace(is_alive=lambda: True)
    elif owner == "updater":
        storage.updaters["sim_fixture"] = object()
    else:
        storage.state.runner_status = RunnerStatus(owner)
    result = Runner.cleanup_simulation_logs("sim_fixture")
    assert result["success"] is False
    assert all((storage.folder / name).exists() for name in TARGETS)
    assert Runner._run_states["sim_fixture"] is storage.state


def test_cleanup_does_not_wait_for_an_existing_finalization_lock(storage):
    lock = Runner._finalization_lock("sim_fixture")
    assert lock.acquire(blocking=False)
    results = []
    worker = threading.Thread(
        target=lambda: results.append(Runner.cleanup_simulation_logs("sim_fixture")),
        daemon=True,
    )
    try:
        worker.start()
        worker.join(1)
        returned_while_locked = not worker.is_alive()
    finally:
        # A blocking regression must fail the test rather than hang the suite.
        lock.release()
        worker.join(2)
    assert returned_while_locked
    assert not worker.is_alive()
    assert results[0]["success"] is False
    assert all((storage.folder / name).exists() for name in TARGETS)


def test_failed_ownership_check_fails_closed(storage):
    def unavailable():
        raise OSError("synthetic process lookup failure")

    Runner._processes["sim_fixture"] = SimpleNamespace(poll=unavailable)
    result = Runner.cleanup_simulation_logs("sim_fixture")
    assert result["success"] is False
    assert result["errors"]
    assert all((storage.folder / name).exists() for name in TARGETS)


def test_cleanup_preserves_prepared_artifacts_and_removes_only_known_targets(storage):
    result = Runner.cleanup_simulation_logs("sim_fixture")
    assert result["success"] is True and result["errors"] is None
    assert set(result["cleaned_files"]) == set(TARGETS)
    assert all(not (storage.folder / name).exists() for name in TARGETS)
    assert all((storage.folder / name).read_text() == "fixture" for name in KEEP)
    assert "sim_fixture" not in Runner._run_states
    assert (storage.folder / "twitter").is_dir()
    assert (storage.folder / "reddit").is_dir()



@pytest.mark.parametrize("failure", ["malformed", "unreadable"])
def test_uncached_unreadable_state_remains_recoverable_without_current_owners(
    storage, monkeypatch, failure
):
    Runner._run_states.clear()
    state_path = storage.folder / "run_state.json"
    if failure == "unreadable":
        state_path.write_text(json.dumps({"runner_status": "stopped"}))
        real_open = builtins.open
        attempted_reads = []

        def unreadable_state(path, mode="r", *args, **kwargs):
            if Path(path) == state_path and mode == "r":
                attempted_reads.append(path)
                raise PermissionError("synthetic unreadable run state")
            return real_open(path, mode, *args, **kwargs)

        monkeypatch.setattr(builtins, "open", unreadable_state)
    else:
        state_path.write_text("{invalid json")

    result = Runner.cleanup_simulation_logs("sim_fixture")
    assert result["success"] is True and result["errors"] is None
    assert set(result["cleaned_files"]) == set(TARGETS)
    assert all(not (storage.folder / name).exists() for name in TARGETS)
    assert all((storage.folder / name).read_text() == "fixture" for name in KEEP)
    assert "sim_fixture" not in Runner._run_states
    if failure == "unreadable":
        assert attempted_reads == [str(state_path)]


def test_partial_delete_error_retains_cache_for_retry(storage, monkeypatch):
    real_remove = module.os.remove

    def fail_one(path):
        if Path(path).name == "simulation.log":
            raise PermissionError("locked fixture")
        real_remove(path)

    with monkeypatch.context() as patch:
        patch.setattr(module.os, "remove", fail_one)
        result = Runner.cleanup_simulation_logs("sim_fixture")
    assert result["success"] is False
    assert "simulation.log" not in result["cleaned_files"]
    assert Runner._run_states["sim_fixture"] is storage.state
    assert (storage.folder / "simulation.log").exists()
    retried = Runner.cleanup_simulation_logs("sim_fixture")
    assert retried["success"] is True
    assert retried["cleaned_files"] == ["simulation.log"]
    assert "sim_fixture" not in Runner._run_states


def test_unknown_cleanup_is_noncreating(storage):
    result = Runner.cleanup_simulation_logs("sim_missing")
    assert result["success"] is True
    assert not (storage.root / "sim_missing").exists()


def test_relocated_root_remains_supported(storage, tmp_path, monkeypatch):
    root_alias = tmp_path / "relocated"
    symlink(root_alias, storage.root, True)
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(root_alias))
    assert Runner.cleanup_simulation_logs("sim_fixture")["success"] is True
    assert all((storage.folder / name).exists() for name in KEEP)


def test_cleanup_serializes_against_a_new_start_claim(storage, monkeypatch):
    entered_delete = threading.Event()
    release_delete = threading.Event()
    claimed = threading.Event()
    real_remove = module.os.remove
    replacement = SimulationRunState("sim_fixture", runner_status=RunnerStatus.STARTING)
    results = []

    def pause_delete(path):
        if Path(path).name == "run_state.json":
            entered_delete.set()
            assert release_delete.wait(2), "test cleanup was not released"
        real_remove(path)

    def claim_start():
        with Runner._finalization_lock("sim_fixture"):
            Runner._run_states["sim_fixture"] = replacement
            claimed.set()

    monkeypatch.setattr(module.os, "remove", pause_delete)
    cleaner = threading.Thread(
        target=lambda: results.append(Runner.cleanup_simulation_logs("sim_fixture"))
    )
    starter = threading.Thread(target=claim_start)
    cleaner.start()
    try:
        assert entered_delete.wait(2)
        assert Runner._finalization_lock("sim_fixture").locked()
        starter.start()
        assert not claimed.wait(0.05), "start claim overtook destructive cleanup"
    finally:
        release_delete.set()
        cleaner.join(2)
        if starter.ident is not None:
            starter.join(2)
    assert not cleaner.is_alive() and not starter.is_alive()
    assert results[0]["success"] is True
    assert Runner._run_states["sim_fixture"] is replacement


def test_force_restart_cannot_start_after_unsafe_cleanup(
    storage, tmp_path, monkeypatch
):
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(storage.root))
    manager = SimulationManager()
    state = SimulationState(
        "sim_fixture",
        "proj_fixture",
        "graph_fixture",
        status=SimulationStatus.COMPLETED,
        config_generated=True,
    )
    manager._save_simulation_state(state)
    (storage.folder / "simulation_config.json").write_text("{}")
    (storage.folder / "reddit_profiles.json").write_text('[{"user_id":0}]')
    (storage.folder / "twitter_profiles.csv").write_text("user_id,name\n0,fixture\n")
    outside = tmp_path / "outside-actions"
    (storage.folder / "twitter").rename(outside)
    symlink(storage.folder / "twitter", outside, True)
    removed = []
    monkeypatch.setattr(module.os, "remove", lambda path: removed.append(path))
    monkeypatch.setattr(
        Runner,
        "start_simulation",
        lambda **kwargs: pytest.fail("must not start after unsafe cleanup"),
    )
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    response = app.test_client().post(
        "/api/simulation/start",
        json={
            "simulation_id": "sim_fixture",
            "force": True,
            "enable_graph_memory_update": False,
        },
    )
    assert response.status_code == 500
    assert "Failed to clean" in response.json["error"]
    assert removed == []
    assert (outside / "actions.jsonl").read_text() == "fixture"
    assert (
        json.loads((storage.folder / "state.json").read_text())["status"] == "completed"
    )


def test_non_file_target_is_rejected_before_other_files_are_deleted(storage):
    target = storage.folder / "stderr.log"
    target.unlink()
    target.mkdir()
    result = Runner.cleanup_simulation_logs("sim_fixture")
    assert result["success"] is False
    assert result["cleaned_files"] == []
    assert all((storage.folder / name).exists() for name in TARGETS)
    assert Runner._run_states["sim_fixture"] is storage.state


def test_owned_work_is_rejected_even_if_directory_was_removed(storage, tmp_path):
    storage.folder.rename(tmp_path / "moved")
    Runner._processes["sim_fixture"] = SimpleNamespace(poll=lambda: None)
    assert Runner.cleanup_simulation_logs("sim_fixture")["success"] is False
    assert Runner._run_states["sim_fixture"] is storage.state


@pytest.mark.parametrize(
    "status",
    [
        RunnerStatus.STOPPED,
        RunnerStatus.COMPLETED,
        RunnerStatus.FAILED,
        RunnerStatus.IDLE,
    ],
)
def test_unowned_terminal_or_idle_states_can_be_cleaned(storage, status):
    storage.state.runner_status = status
    Runner._processes["sim_fixture"] = SimpleNamespace(poll=lambda: 0)
    Runner._monitor_threads["sim_fixture"] = SimpleNamespace(is_alive=lambda: False)
    assert Runner.cleanup_simulation_logs("sim_fixture")["success"] is True
    lock = Runner._finalization_lock("sim_fixture")
    assert lock.acquire(blocking=False)
    lock.release()


def test_ownership_refusal_releases_its_lock_for_a_later_retry(storage):
    storage.updaters["sim_fixture"] = object()
    assert Runner.cleanup_simulation_logs("sim_fixture")["success"] is False
    storage.updaters.clear()
    assert Runner.cleanup_simulation_logs("sim_fixture")["success"] is True
