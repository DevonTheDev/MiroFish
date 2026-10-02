"""Simulation manager file boundaries with disposable storage and fake inference."""

import csv
import json
from pathlib import Path
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api import simulation as api
from app.services import simulation_manager as module
from app.services.simulation_manager import (
    SimulationManager,
    SimulationState,
    SimulationStatus,
)
from app.storage import StoragePathError


@pytest.fixture
def storage(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(root))
    manager = SimulationManager()
    return manager, root


def save_state(manager, twitter=True, reddit=True):
    state = SimulationState(
        "sim_fixture",
        "proj_fixture",
        "graph_fixture",
        enable_twitter=twitter,
        enable_reddit=reddit,
    )
    manager._save_simulation_state(state)
    return state


def symlink(link, target, directory=False):
    try:
        link.symlink_to(target, target_is_directory=directory)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")


@pytest.mark.parametrize(
    "operation",
    ["get_simulation", "get_simulation_config", "get_run_instructions", "get_profiles"],
)
def test_unknown_reads_create_no_record_directory(storage, operation):
    manager, root = storage
    if operation == "get_profiles":
        with pytest.raises(ValueError):
            manager.get_profiles("sim_missing")
    else:
        getattr(manager, operation)("sim_missing")
    assert list(root.iterdir()) == []


@pytest.mark.parametrize(
    "record_id",
    [
        "",
        ".",
        "..",
        "../outside",
        r"..\outside",
        "/outside",
        "C:\\outside",
        "sim:stream",
        "CON",
        "sim.",
        None,
        10,
    ],
)
def test_invalid_directory_ids_fail_before_mkdir(storage, monkeypatch, record_id):
    manager, _ = storage
    calls = []
    # Never allow vulnerable baseline code to create an invalid/absolute directory.
    monkeypatch.setattr(
        module.os, "makedirs", lambda *args, **kwargs: calls.append(args)
    )
    with pytest.raises(StoragePathError):
        manager._get_simulation_dir(record_id)
    assert calls == []


@pytest.mark.parametrize("cached", [True, False])
@pytest.mark.parametrize("target_kind", ["directory", "state_file"])
def test_cached_and_uncached_state_reads_reject_aliases(
    storage, tmp_path, cached, target_kind
):
    manager, root = storage
    state = save_state(manager)
    folder = root / state.simulation_id
    if target_kind == "directory":
        target = tmp_path / "elsewhere"
        folder.rename(target)
        symlink(folder, target, True)
    else:
        child = folder / "state.json"
        target = tmp_path / "external.json"
        child.rename(target)
        symlink(child, target)
    if not cached:
        manager._simulations.clear()
    with pytest.raises(StoragePathError):
        manager.get_simulation(state.simulation_id)


@pytest.mark.parametrize(
    "filename,operation",
    [
        ("simulation_config.json", "config"),
        ("reddit_profiles.json", "reddit"),
        ("twitter_profiles.csv", "twitter"),
    ],
)
def test_manager_artifact_reads_refuse_linked_files(
    storage, tmp_path, filename, operation
):
    manager, root = storage
    state = save_state(manager)
    external = tmp_path / filename
    external.write_text(
        "user_id,name\n0,fixture\n" if operation == "twitter" else '[{"user_id":0}]'
    )
    symlink(root / state.simulation_id / filename, external)
    with pytest.raises(StoragePathError):
        if operation == "config":
            manager.get_simulation_config(state.simulation_id)
        else:
            manager.get_profiles(state.simulation_id, operation)


def test_state_save_refuses_linked_destination_without_mutating_target(
    storage, tmp_path
):
    manager, root = storage
    state = save_state(manager)
    child = root / state.simulation_id / "state.json"
    external = tmp_path / "external.json"
    child.rename(external)
    before = external.read_bytes()
    symlink(child, external)
    state.error = "would overwrite external"
    with pytest.raises(StoragePathError):
        manager._save_simulation_state(state)
    assert external.read_bytes() == before


def test_list_skips_aliases_and_unrelated_entries(storage):
    manager, root = storage
    state = save_state(manager)
    symlink(root / "alias", root / state.simulation_id, True)
    (root / ".DS_Store").write_text("unrelated")
    (root / "notes.txt").write_text("unrelated")
    assert [item.simulation_id for item in manager.list_simulations()] == [
        state.simulation_id
    ]


@pytest.mark.parametrize(
    "filename",
    ["simulation_config.json", "reddit_profiles.json", "twitter_profiles.csv"],
)
def test_preparation_preflight_rejects_aliases_before_state_changes_or_inference(
    storage, tmp_path, monkeypatch, filename
):
    manager, root = storage
    state = save_state(manager)
    external = tmp_path / filename
    external.write_text("keep")
    symlink(root / state.simulation_id / filename, external)
    before = (root / state.simulation_id / "state.json").read_bytes()

    def must_not_infer(*args, **kwargs):
        pytest.fail("invalid output paths must fail before graph/model work")

    monkeypatch.setattr(module, "ZepEntityReader", must_not_infer)
    with pytest.raises(StoragePathError):
        manager.prepare_simulation(state.simulation_id, "fixture", "synthetic text")
    assert state.status == SimulationStatus.CREATED
    assert (root / state.simulation_id / "state.json").read_bytes() == before
    assert external.read_text() == "keep"


@pytest.mark.parametrize("twitter,reddit", [(True, True), (True, False), (False, True)])
def test_preparation_and_roundtrip_use_validated_paths(
    storage, monkeypatch, twitter, reddit
):
    manager, root = storage
    state = save_state(manager, twitter, reddit)
    paths = []

    class Reader:
        def filter_defined_entities(self, **kwargs):
            return SimpleNamespace(
                filtered_count=1, entity_types=["Person"], entities=[object()]
            )

    class Generator:
        def __init__(self, **kwargs):
            pass

        def generate_profiles_from_entities(self, **kwargs):
            assert (
                Path(kwargs["realtime_output_path"]).parent
                == root / state.simulation_id
            )
            return [{"user_id": 0, "name": "fixture"}]

        def save_profiles(self, profiles, file_path, platform):
            path = Path(file_path)
            paths.append(path)
            if platform == "reddit":
                path.write_text(json.dumps(profiles))
            else:
                with path.open("w", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=["user_id", "name"])
                    writer.writeheader()
                    writer.writerows(profiles)

    class ConfigGenerator:
        def generate_config(self, **kwargs):
            return SimpleNamespace(
                to_json=lambda: '{"agent_configs": []}', generation_reasoning="fixture"
            )

    monkeypatch.setattr(module, "ZepEntityReader", Reader)
    monkeypatch.setattr(module, "OasisProfileGenerator", Generator)
    monkeypatch.setattr(module, "SimulationConfigGenerator", ConfigGenerator)
    result = manager.prepare_simulation(
        state.simulation_id, "fixture", "synthetic text"
    )
    assert result.status == SimulationStatus.READY
    expected = ({"reddit_profiles.json"} if reddit else set()) | (
        {"twitter_profiles.csv"} if twitter else set()
    )
    assert {p.name for p in paths} == expected
    assert all(p.parent == root / state.simulation_id for p in paths)
    assert manager.get_simulation_config(state.simulation_id) == {"agent_configs": []}
    if reddit:
        assert manager.get_profiles(state.simulation_id, "reddit") == [
            {"user_id": 0, "name": "fixture"}
        ]
    if twitter:
        assert manager.get_profiles(state.simulation_id, "twitter") == [
            {"user_id": "0", "name": "fixture"}
        ]
    manager._simulations.clear()
    assert manager.get_simulation(state.simulation_id).status == SimulationStatus.READY


def test_config_download_does_not_follow_a_file_alias(storage, tmp_path):
    manager, root = storage
    state = save_state(manager)
    external = tmp_path / "external.json"
    external.write_text('{"fixture":"must not be returned"}')
    symlink(root / state.simulation_id / "simulation_config.json", external)
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    response = app.test_client().get(
        f"/api/simulation/{state.simulation_id}/config/download"
    )
    assert response.status_code == 400
    assert "must not be returned" not in response.get_data(as_text=True)
    assert "traceback" not in response.json


@pytest.mark.parametrize("record_id", ["..", "CON", r"..\outside", "sim:stream"])
def test_config_download_rejects_unsafe_ids(storage, record_id):
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    response = app.test_client().get(f"/api/simulation/{record_id}/config/download")
    assert response.status_code == 400
    assert response.json["success"] is False
    assert "traceback" not in response.json


def test_config_download_and_missing_lookup_remain_compatible(storage):
    manager, root = storage
    state = save_state(manager)
    config = root / state.simulation_id / "simulation_config.json"
    config.write_text('{"agent_configs":[]}')
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    client = app.test_client()
    response = client.get(f"/api/simulation/{state.simulation_id}/config/download")
    try:
        assert response.status_code == 200
        assert response.get_data() == config.read_bytes()
        assert "simulation_config.json" in response.headers["Content-Disposition"]
    finally:
        response.close()
    assert client.get("/api/simulation/sim_missing/config/download").status_code == 404
    assert not (root / "sim_missing").exists()


def test_manager_root_can_be_relocated_with_a_symlink(storage, tmp_path):
    manager, root = storage
    alias = tmp_path / "relocated"
    symlink(alias, root, True)
    manager.SIMULATION_DATA_DIR = str(alias)
    state = manager.create_simulation("proj_fixture", "graph_fixture")
    assert Path(manager._get_simulation_dir(state.simulation_id)).parent == root
    manager._simulations.clear()
    assert manager.get_simulation(state.simulation_id).project_id == "proj_fixture"


def test_path_validation_does_not_disable_normal_state_cache(storage):
    manager, _ = storage
    state = save_state(manager)
    assert manager.get_simulation(state.simulation_id) is state
