"""Run-state snapshots remain readable through ordinary save failures."""

import copy
import json
import threading

import pytest

from app.services.simulation_runner import (
    AgentAction,
    RunnerStatus,
    SimulationRunner as Runner,
    SimulationRunState,
)
from app.storage import StoragePathError
from app.utils import persistence
from test_project_report_storage import make_symlink


@pytest.fixture
def stored(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(root))
    monkeypatch.setattr(Runner, "_run_states", {})
    state = SimulationRunState(
        "sim_fixture", runner_status=RunnerStatus.RUNNING, total_rounds=5
    )
    state.error = "Previous Café"
    Runner._save_run_state(state)
    path = root / state.simulation_id / "run_state.json"
    return state, path, path.read_bytes()


def fail_save(monkeypatch, failure):
    if failure == "serialize":

        def fail(payload, stream, **kwargs):
            stream.write('{"partial":')
            raise OSError("synthetic serialize failure")

        monkeypatch.setattr(persistence.json, "dump", fail)
    elif failure == "create":

        def fail(**kwargs):
            raise PermissionError("synthetic create failure")

        monkeypatch.setattr(persistence.tempfile, "NamedTemporaryFile", fail)
    elif failure == "replace":

        def fail(*args):
            raise PermissionError("synthetic replace failure")

        monkeypatch.setattr(persistence.os, "replace", fail)
    else:
        factory = persistence.tempfile.NamedTemporaryFile

        class BrokenClose:
            def __init__(self, **kwargs):
                self.handle = factory(**kwargs)

            def __enter__(self):
                return self.handle.__enter__()

            def __exit__(self, *args):
                self.handle.__exit__(*args)
                raise OSError("synthetic close failure")

        monkeypatch.setattr(persistence.tempfile, "NamedTemporaryFile", BrokenClose)


@pytest.mark.parametrize("failure", ["serialize", "create", "replace", "close"])
@pytest.mark.parametrize("existing", [True, False])
def test_failed_save_preserves_disk_and_new_object_cache_ownership(
    stored, monkeypatch, failure, existing
):
    previous, path, original = stored
    if not existing:
        path.unlink()
        Runner._run_states.clear()
    incoming = copy.deepcopy(previous)
    incoming.runner_status = RunnerStatus.COMPLETED
    incoming.current_round = 5
    incoming.error = "Updated 雪"
    with monkeypatch.context() as patch:
        fail_save(patch, failure)
        with pytest.raises(OSError, match=f"synthetic {failure} failure"):
            Runner._save_run_state(incoming)

    assert Runner._run_states.get(previous.simulation_id) is (
        previous if existing else None
    )
    if existing:
        assert path.read_bytes() == original
        assert Runner._load_run_state(previous.simulation_id).error == "Previous Café"
    else:
        assert not path.exists()
        assert Runner._load_run_state(previous.simulation_id) is None
    assert list(path.parent.glob("*.tmp")) == []
    Runner._save_run_state(incoming)
    assert Runner.get_run_state(previous.simulation_id) is incoming
    loaded = Runner._load_run_state(previous.simulation_id)
    assert loaded.runner_status == RunnerStatus.COMPLETED and loaded.current_round == 5
    assert loaded.error == "Updated 雪"


def test_fresh_reader_keeps_previous_complete_snapshot_during_serialization(
    stored, monkeypatch
):
    previous, path, original = stored
    incoming = copy.deepcopy(previous)
    incoming.current_round = 2
    incoming.add_action(
        AgentAction(
            2,
            "2026-10-03T00:00:00",
            "twitter",
            0,
            "Agent 零",
            "CREATE_POST",
            {"content": "Café 雪"},
            success=False,
        )
    )
    dump = persistence.json.dump
    observations = []

    def staged(payload, stream, **kwargs):
        stream.write(" ")
        stream.flush()
        observations.append(
            Runner._load_run_state(previous.simulation_id).current_round
        )
        assert path.read_bytes() == original
        assert Runner.get_run_state(previous.simulation_id) is previous
        dump(payload, stream, **kwargs)

    monkeypatch.setattr(persistence.json, "dump", staged)
    Runner._save_run_state(incoming)
    assert observations == [0]
    loaded = Runner._load_run_state(previous.simulation_id)
    assert loaded.current_round == 2 and loaded.twitter_actions_count == 1
    assert loaded.recent_actions[0].to_dict() == incoming.recent_actions[0].to_dict()
    assert json.loads(path.read_text()) == incoming.to_detail_dict()
    assert "雪" in path.read_text()


def test_actual_unserializable_action_preserves_previous_snapshot(stored):
    previous, path, original = stored
    incoming = copy.deepcopy(previous)
    incoming.add_action(
        AgentAction(0, "", "twitter", 0, "", "CREATE_POST", {"bad": {1, 2}})
    )
    with pytest.raises(TypeError):
        Runner._save_run_state(incoming)
    assert path.read_bytes() == original
    assert Runner.get_run_state(previous.simulation_id) is previous
    assert list(path.parent.glob("*.tmp")) == []


def test_failed_outer_save_keeps_successful_inner_snapshot(stored, monkeypatch):
    previous, path, _ = stored
    outer, inner = copy.deepcopy(previous), copy.deepcopy(previous)
    outer.error, inner.error = "outer", "inner"
    dump = persistence.json.dump

    def nested(payload, stream, **kwargs):
        if payload["error"] == "outer":
            stream.write("partial")
            Runner._save_run_state(inner)
            raise OSError("outer save failed")
        dump(payload, stream, **kwargs)

    monkeypatch.setattr(persistence.json, "dump", nested)
    with pytest.raises(OSError, match="outer save failed"):
        Runner._save_run_state(outer)
    assert Runner.get_run_state(previous.simulation_id) is inner
    assert Runner._load_run_state(previous.simulation_id).error == "inner"
    assert list(path.parent.glob("*.tmp")) == []


def test_shared_mutable_object_is_not_rolled_back_on_save_failure(stored, monkeypatch):
    state, path, original = stored
    state.error = "Unsaved in memory"
    fail_save(monkeypatch, "serialize")
    with pytest.raises(OSError):
        Runner._save_run_state(state)
    assert Runner.get_run_state(state.simulation_id) is state
    assert state.error == "Unsaved in memory"
    assert path.read_bytes() == original
    assert Runner._load_run_state(state.simulation_id).error == "Previous Café"


@pytest.mark.parametrize(
    "record_id", ["../escape", "x/y", "x\\y", "", "CON", "a" * 129]
)
def test_invalid_run_id_is_rejected_before_creating_storage(stored, record_id):
    _, path, original = stored
    with pytest.raises(StoragePathError):
        Runner._save_run_state(SimulationRunState(record_id))
    assert path.read_bytes() == original
    assert set(Runner._run_states) == {"sim_fixture"}
    assert sorted(item.name for item in path.parent.parent.iterdir()) == ["sim_fixture"]
    assert not (path.parent.parent.parent / "escape").exists()


@pytest.mark.parametrize("alias", ["directory", "file", "dangling-file"])
def test_descendant_alias_is_rejected_before_staging(
    stored, tmp_path, monkeypatch, alias
):
    previous, path, original = stored
    target = tmp_path / "outside"
    target.mkdir()
    outside_file = target / "run_state.json"
    if alias != "dangling-file":
        outside_file.write_text("outside fixture")
    if alias == "directory":
        record_id = "sim_alias"
        make_symlink(path.parent.parent / record_id, target, target_is_directory=True)
    else:
        record_id = previous.simulation_id
        path.unlink()
        make_symlink(path, outside_file)

    def forbidden(**kwargs):
        pytest.fail("staging started before storage validation")

    monkeypatch.setattr(persistence.tempfile, "NamedTemporaryFile", forbidden)
    with pytest.raises(StoragePathError):
        Runner._save_run_state(SimulationRunState(record_id))
    assert Runner.get_run_state(previous.simulation_id) is previous
    if alias == "dangling-file":
        assert not outside_file.exists()
    else:
        assert outside_file.read_text() == "outside fixture"
    if alias == "directory":
        assert path.read_bytes() == original


def test_valid_new_run_creates_its_directory_under_relocated_root(
    stored, tmp_path, monkeypatch
):
    _, path, _ = stored
    relocated = tmp_path / "root-alias"
    make_symlink(relocated, path.parent.parent, target_is_directory=True)
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(relocated))
    state = SimulationRunState("sim_new", runner_status=RunnerStatus.STARTING)
    Runner._save_run_state(state)
    assert (
        json.loads((path.parent.parent / "sim_new" / "run_state.json").read_text())[
            "runner_status"
        ]
        == "starting"
    )
    assert Runner.get_run_state("sim_new") is state


def test_delayed_cold_load_returns_newer_published_state(stored, monkeypatch):
    previous, path, _ = stored
    previous.runner_status = RunnerStatus.STOPPED
    Runner._save_run_state(previous)
    Runner._run_states.clear()
    load = Runner._load_run_state
    current = SimulationRunState(previous.simulation_id, runner_status=RunnerStatus.STARTING)

    def delayed_load(simulation_id):
        loaded = load(simulation_id)
        assert loaded.runner_status == RunnerStatus.STOPPED
        Runner._save_run_state(current)
        return loaded

    monkeypatch.setattr(Runner, "_load_run_state", delayed_load)
    assert Runner.get_run_state(previous.simulation_id) is current
    assert Runner._run_states[previous.simulation_id] is current
    assert json.loads(path.read_text())["runner_status"] == "starting"


def test_cold_getter_caches_loaded_state_and_warm_getter_reuses_it(stored, monkeypatch):
    previous, _, _ = stored
    Runner._run_states.clear()
    current = Runner.get_run_state(previous.simulation_id)
    assert current is not previous
    assert current.to_detail_dict() == previous.to_detail_dict()
    assert Runner._run_states[previous.simulation_id] is current

    def unexpected_load(_simulation_id):
        pytest.fail("warm cache attempted a disk load")

    monkeypatch.setattr(Runner, "_load_run_state", unexpected_load)
    assert Runner.get_run_state(previous.simulation_id) is current


@pytest.mark.parametrize("missing", [True, False], ids=["missing", "unreadable"])
def test_cold_getter_does_not_cache_missing_or_unreadable_state(stored, missing):
    previous, path, _ = stored
    Runner._run_states.clear()
    if missing:
        path.unlink()
    else:
        path.write_text("{invalid JSON", encoding="utf-8")
    assert Runner.get_run_state(previous.simulation_id) is None
    assert previous.simulation_id not in Runner._run_states


def test_cold_getter_completes_while_caller_holds_finalization_lock(stored, monkeypatch):
    previous, _, _ = stored
    Runner._run_states.clear()
    monkeypatch.setattr(Runner, "_finalization_locks", {})
    results, errors = [], []

    def read_under_lock():
        try:
            with Runner._finalization_lock(previous.simulation_id):
                results.append(Runner.get_run_state(previous.simulation_id))
        except BaseException as error:
            errors.append(error)

    reader = threading.Thread(target=read_under_lock, name="getter-held-lock", daemon=True)
    reader.start()
    try:
        reader.join(timeout=5)
        assert not reader.is_alive(), "getter blocked under the existing non-reentrant lock"
    finally:
        # If a future getter wrongly re-acquires this lock, release the fixture's
        # lock so the bounded regression does not leave a blocked worker behind.
        if reader.is_alive():
            Runner._finalization_lock(previous.simulation_id).release()
            reader.join(timeout=5)
    assert errors == []
    assert len(results) == 1
    assert results[0] is Runner._run_states[previous.simulation_id]
    assert results[0].runner_status == previous.runner_status
