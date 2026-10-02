"""Prepared simulation-state persistence with real readers and disposable files."""

import copy
import json
from pathlib import Path
import tempfile

import pytest

from app.services import simulation_manager as module
from app.services.simulation_manager import (
    SimulationManager,
    SimulationState,
    SimulationStatus,
)


@pytest.fixture
def stored(tmp_path, monkeypatch):
    monkeypatch.setattr(
        SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path / "simulations")
    )
    manager = SimulationManager()
    state = manager.create_simulation("proj_fixture", "graph_fixture")
    state.config_reasoning = "Previous Café"
    manager._save_simulation_state(state)
    path = Path(manager._get_simulation_path(state.simulation_id, "state.json"))
    return manager, state, path, path.read_bytes()


def inject_failure(monkeypatch, failure):
    if failure == "serialize":

        def interrupted(payload, stream, **kwargs):
            stream.write('{"partial":')
            raise OSError("synthetic serialize failure")

        monkeypatch.setattr(module.json, "dump", interrupted)
    elif failure == "create":

        def refuse(**kwargs):
            raise PermissionError("synthetic create failure")

        monkeypatch.setattr(tempfile, "NamedTemporaryFile", refuse)
    elif failure == "replace":

        def refuse(source, destination):
            raise PermissionError("synthetic replace failure")

        monkeypatch.setattr(module.os, "replace", refuse)
    else:
        original_factory = tempfile.NamedTemporaryFile

        class BrokenClose:
            def __init__(self, **kwargs):
                self.handle = original_factory(**kwargs)

            def __enter__(self):
                return self.handle.__enter__()

            def __exit__(self, *args):
                self.handle.__exit__(*args)
                raise OSError("synthetic close failure")

        monkeypatch.setattr(tempfile, "NamedTemporaryFile", BrokenClose)


@pytest.mark.parametrize("failure", ["serialize", "create", "replace", "close"])
@pytest.mark.parametrize("existing", [True, False])
def test_failed_save_preserves_file_and_does_not_publish_new_cached_object(
    stored, monkeypatch, failure, existing
):
    manager, old, path, previous = stored
    if not existing:
        path.unlink()
        manager._simulations.clear()
    incoming = copy.deepcopy(old)
    incoming.config_reasoning = "Updated 雪"
    incoming.status = SimulationStatus.READY
    with monkeypatch.context() as patch:
        inject_failure(patch, failure)
        with pytest.raises(OSError, match=f"synthetic {failure} failure"):
            manager._save_simulation_state(incoming)
    assert manager._simulations.get(old.simulation_id) is (old if existing else None)
    if existing:
        assert path.read_bytes() == previous
        assert (
            SimulationManager().get_simulation(old.simulation_id).config_reasoning
            == "Previous Café"
        )
    else:
        assert not path.exists()
        assert SimulationManager().get_simulation(old.simulation_id) is None
    assert list(path.parent.glob("*.tmp")) == []
    manager._save_simulation_state(incoming)
    assert manager.get_simulation(old.simulation_id) is incoming
    restored = SimulationManager().get_simulation(old.simulation_id)
    assert restored.status == SimulationStatus.READY
    assert restored.config_reasoning == "Updated 雪"
    assert list(path.parent.glob("*.tmp")) == []


def test_another_manager_reads_previous_complete_state_during_save(stored, monkeypatch):
    manager, old, path, previous = stored
    incoming = copy.deepcopy(old)
    incoming.profiles_generated = True
    incoming.profiles_count = 3
    incoming.config_reasoning = "New snapshot"
    original_dump = module.json.dump
    observed = []

    def serialize(payload, stream, **kwargs):
        stream.write(" ")
        stream.flush()
        observed.append(
            SimulationManager().get_simulation(old.simulation_id).config_reasoning
        )
        assert path.read_bytes() == previous
        assert manager.get_simulation(old.simulation_id) is old
        original_dump(payload, stream, **kwargs)

    monkeypatch.setattr(module.json, "dump", serialize)
    manager._save_simulation_state(incoming)
    assert observed == ["Previous Café"]
    assert manager.get_simulation(old.simulation_id) is incoming
    fresh = SimulationManager().get_simulation(old.simulation_id)
    assert fresh.profiles_generated and fresh.profiles_count == 3
    assert fresh.config_reasoning == "New snapshot"


def test_normal_state_save_still_creates_a_new_record_directory(stored):
    manager, _, path, _ = stored
    state = SimulationState(
        "sim_new", "proj_fixture", "graph_fixture", enable_reddit=False
    )
    manager._save_simulation_state(state)
    created = path.parent.parent / "sim_new" / "state.json"
    assert json.loads(created.read_text())["enable_reddit"] is False
    assert manager.get_simulation("sim_new") is state
    assert SimulationManager().get_simulation("sim_new").enable_reddit is False


def test_failure_does_not_roll_back_an_already_shared_mutable_state(
    stored, monkeypatch
):
    manager, state, path, previous = stored
    state.config_reasoning = "Unsaved in memory"
    inject_failure(monkeypatch, "serialize")
    with pytest.raises(OSError, match="synthetic serialize failure"):
        manager._save_simulation_state(state)
    assert manager.get_simulation(state.simulation_id) is state
    assert state.config_reasoning == "Unsaved in memory"
    assert path.read_bytes() == previous
    assert (
        SimulationManager().get_simulation(state.simulation_id).config_reasoning
        == "Previous Café"
    )
