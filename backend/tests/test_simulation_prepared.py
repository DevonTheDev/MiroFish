"""Preparation reuse against disposable platform-specific files; no inference."""

import csv
import json

from flask import Flask
import pytest

from app.api import simulation as api
from app.config import Config
from app.services.simulation_manager import (
    SimulationManager,
    SimulationState,
    SimulationStatus,
)


@pytest.fixture
def storage(tmp_path, monkeypatch):
    root = tmp_path / "simulations"
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(root))
    monkeypatch.setattr(Config, "OASIS_SIMULATION_DATA_DIR", str(root))
    return root


def prepare_files(root, twitter=True, reddit=True, status=SimulationStatus.READY):
    manager = SimulationManager()
    state = SimulationState(
        "sim_fixture",
        "proj_fixture",
        "graph_fixture",
        enable_twitter=twitter,
        enable_reddit=reddit,
        status=status,
        config_generated=True,
        profiles_generated=True,
        profiles_count=2,
        entities_count=2,
    )
    manager._save_simulation_state(state)
    folder = root / state.simulation_id
    (folder / "simulation_config.json").write_text('{"agent_configs": []}')
    if reddit:
        (folder / "reddit_profiles.json").write_text(
            json.dumps([{"user_id": 0}, {"user_id": 1}])
        )
    if twitter:
        with (folder / "twitter_profiles.csv").open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["user_id", "name"])
            writer.writeheader()
            writer.writerow({"user_id": 0, "name": "Comma, in name"})
            writer.writerow({"user_id": 1, "name": "Two\nlines"})
    return state, folder


@pytest.mark.parametrize("twitter,reddit", [(True, False), (False, True), (True, True)])
def test_only_enabled_platform_artifacts_are_required(storage, twitter, reddit):
    state, folder = prepare_files(storage, twitter, reddit)
    prepared, info = api._check_simulation_prepared(state.simulation_id)
    assert prepared is True, info
    assert info["profiles_count"] == 2
    expected = {"state.json", "simulation_config.json"}
    if twitter:
        expected.add("twitter_profiles.csv")
    if reddit:
        expected.add("reddit_profiles.json")
    assert set(info["existing_files"]) == expected


@pytest.mark.parametrize("twitter,reddit", [(True, False), (False, True)])
def test_prepare_route_reuses_single_platform_without_new_work(
    storage, monkeypatch, twitter, reddit
):
    state, _ = prepare_files(storage, twitter, reddit)

    def must_not_prepare(*args, **kwargs):
        pytest.fail(
            "already prepared simulations must not read the project or start generation"
        )

    monkeypatch.setattr(api.ProjectManager, "get_project", must_not_prepare)
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    response = app.test_client().post(
        "/api/simulation/prepare", json={"simulation_id": state.simulation_id}
    )
    assert response.status_code == 200, response.json
    assert response.json["data"]["already_prepared"] is True
    assert response.json["data"]["prepare_info"]["profiles_count"] == 2


def test_checker_uses_same_storage_root_as_manager(storage, tmp_path, monkeypatch):
    state, _ = prepare_files(storage)
    monkeypatch.setattr(
        Config, "OASIS_SIMULATION_DATA_DIR", str(tmp_path / "unrelated")
    )
    assert api._check_simulation_prepared(state.simulation_id)[0] is True


@pytest.mark.parametrize(
    "filename",
    [
        "state.json",
        "simulation_config.json",
        "twitter_profiles.csv",
        "reddit_profiles.json",
    ],
)
def test_missing_enabled_artifact_reports_not_prepared(storage, filename):
    state, folder = prepare_files(storage)
    (folder / filename).unlink()
    prepared, info = api._check_simulation_prepared(state.simulation_id)
    assert prepared is False
    assert filename in info["missing_files"]


@pytest.mark.parametrize(
    "filename,contents",
    [
        ("state.json", "[]"),
        ("state.json", "null"),
        ("simulation_config.json", "not json"),
        ("simulation_config.json", "[]"),
        ("reddit_profiles.json", "{}"),
    ],
)
def test_invalid_artifact_shapes_are_not_reported_ready(storage, filename, contents):
    state, folder = prepare_files(storage)
    (folder / filename).write_text(contents)
    prepared, info = api._check_simulation_prepared(state.simulation_id)
    assert prepared is False, info
    assert info["reason"]


@pytest.mark.parametrize(
    "updates",
    [
        {"enable_twitter": "false"},
        {"enable_reddit": 1},
        {"enable_twitter": False, "enable_reddit": False},
        {"config_generated": "true"},
    ],
)
def test_invalid_or_disabled_platform_flags_are_not_ready(storage, updates):
    state, folder = prepare_files(storage)
    path = folder / "state.json"
    data = json.loads(path.read_text())
    data.update(updates)
    path.write_text(json.dumps(data))
    assert api._check_simulation_prepared(state.simulation_id)[0] is False


def test_legacy_missing_platform_flags_still_require_both(storage):
    state, folder = prepare_files(storage)
    path = folder / "state.json"
    data = json.loads(path.read_text())
    data.pop("enable_twitter")
    data.pop("enable_reddit")
    path.write_text(json.dumps(data))
    assert api._check_simulation_prepared(state.simulation_id)[0] is True
    (folder / "twitter_profiles.csv").unlink()
    assert api._check_simulation_prepared(state.simulation_id)[0] is False


@pytest.mark.parametrize("twitter,reddit", [(True, False), (False, True)])
def test_preparing_is_reconciled_only_after_required_artifacts_exist(
    storage, twitter, reddit
):
    state, folder = prepare_files(storage, twitter, reddit, SimulationStatus.PREPARING)
    path = folder / "state.json"
    prepared, info = api._check_simulation_prepared(state.simulation_id)
    assert prepared is True, info
    assert info["status"] == "ready"
    assert json.loads(path.read_text())["status"] == "ready"


@pytest.mark.parametrize(
    "filename", ["state.json", "simulation_config.json", "reddit_profiles.json"]
)
def test_linked_artifacts_cannot_be_read_or_reconciled(storage, tmp_path, filename):
    state, folder = prepare_files(storage, status=SimulationStatus.PREPARING)
    path = folder / filename
    external = tmp_path / filename
    original = path.read_bytes()
    path.rename(external)
    try:
        path.symlink_to(external)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")
    prepared, info = api._check_simulation_prepared(state.simulation_id)
    assert prepared is False, info
    assert external.read_bytes() == original
    if filename != "state.json":
        assert json.loads((folder / "state.json").read_text())["status"] == "preparing"


def test_unknown_readiness_check_creates_no_simulation_directory(storage):
    storage.mkdir()
    assert api._check_simulation_prepared("sim_missing")[0] is False
    assert list(storage.iterdir()) == []


def test_invalid_id_does_not_reconcile_parent_directory(storage):
    state, folder = prepare_files(storage, status=SimulationStatus.PREPARING)
    # Parent is entirely synthetic. Move valid files there to expose '..' lookup.
    for path in folder.iterdir():
        path.rename(storage.parent / path.name)
    before = (storage.parent / "state.json").read_bytes()
    prepared, _ = api._check_simulation_prepared("..")
    assert prepared is False
    assert (storage.parent / "state.json").read_bytes() == before


@pytest.mark.parametrize("twitter,reddit", [(True, False), (False, True)])
def test_disabled_platform_leftovers_are_not_read(storage, twitter, reddit):
    state, folder = prepare_files(storage, twitter, reddit)
    disabled = "reddit_profiles.json" if twitter else "twitter_profiles.csv"
    (folder / disabled).write_text("not a valid profile artifact")
    prepared, info = api._check_simulation_prepared(state.simulation_id)
    assert prepared is True, info
    assert disabled not in info["existing_files"]
    assert info["profiles_count"] == 2


@pytest.mark.parametrize(
    "status", ["ready", "running", "completed", "stopped", "failed"]
)
def test_completed_preparation_is_reused_across_existing_run_statuses(storage, status):
    state, _ = prepare_files(storage, status=SimulationStatus(status))
    assert api._check_simulation_prepared(state.simulation_id)[0] is True


def test_missing_profile_does_not_reconcile_preparing_status(storage):
    state, folder = prepare_files(storage, False, True, SimulationStatus.PREPARING)
    (folder / "reddit_profiles.json").unlink()
    assert api._check_simulation_prepared(state.simulation_id)[0] is False
    assert json.loads((folder / "state.json").read_text())["status"] == "preparing"


def test_force_regenerate_still_bypasses_reuse(storage, monkeypatch):
    state, _ = prepare_files(storage, False, True)
    requested_projects = []

    def missing_project(project_id):
        requested_projects.append(project_id)
        return None  # Stop before inference or a background job starts.

    monkeypatch.setattr(api.ProjectManager, "get_project", missing_project)
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    response = app.test_client().post(
        "/api/simulation/prepare",
        json={
            "simulation_id": state.simulation_id,
            "force_regenerate": True,
        },
    )
    assert response.status_code == 404
    assert requested_projects == [state.project_id]


def test_empty_twitter_file_cannot_supply_profile_header(storage):
    state, folder = prepare_files(storage, True, False)
    (folder / "twitter_profiles.csv").write_text("")
    assert api._check_simulation_prepared(state.simulation_id)[0] is False


def test_directory_is_not_a_configuration_file(storage):
    state, folder = prepare_files(storage)
    path = folder / "simulation_config.json"
    path.unlink()
    path.mkdir()
    prepared, info = api._check_simulation_prepared(state.simulation_id)
    assert prepared is False
    assert info["missing_files"] == ["simulation_config.json"]
