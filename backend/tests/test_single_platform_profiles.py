"""The realtime preview and final Twitter artifacts share the OASIS contract."""

import asyncio
import csv
import json
from types import SimpleNamespace

import pytest

from app.services.oasis_profile_generator import OasisAgentProfile, OasisProfileGenerator
from app.services.simulation_manager import SimulationManager
from app.services.zep_tools import ZepToolsService
from app.storage import StoragePathError


def test_twitter_normalization_preserves_raw_fields_and_only_adds_available_aliases():
    from app.services.profile_formats import normalize_twitter_profile

    raw = {"name": "Alice", "description": "Bio", "user_char": "Persona", "custom": "raw"}
    assert normalize_twitter_profile(raw) == {**raw, "bio": "Bio", "persona": "Persona"}
    assert raw == {"name": "Alice", "description": "Bio", "user_char": "Persona", "custom": "raw"}
    assert normalize_twitter_profile({"name": "Alice"}) == {"name": "Alice"}


def test_twitter_normalization_retains_explicit_empty_common_fields_and_literal_topics():
    from app.services.profile_formats import normalize_twitter_profile

    raw = {"bio": "", "persona": None, "description": "Old", "user_char": "Old",
           "interested_topics": "__import__('os').environ.clear()"}
    assert normalize_twitter_profile(raw) == raw


def _generate_realtime_profiles(tmp_path, monkeypatch):
    generator = object.__new__(OasisProfileGenerator)
    profiles = [
        OasisAgentProfile(user_id=0, user_name="alice", name="Alice", bio="A short bio", persona="A long persona"),
        OasisAgentProfile(user_id=1, user_name="bob", name="Bob", bio="B short bio", persona="B long persona",
                          age=30, profession="Researcher", interested_topics=["policy"]),
    ]
    monkeypatch.setattr(generator, "generate_profile_from_entity", lambda entity, user_id, use_llm: profiles[user_id])
    monkeypatch.setattr(generator, "_print_generated_profile", lambda *args: None)
    entities = [SimpleNamespace(name=p.name, get_entity_type=lambda: "Person") for p in profiles]
    path = tmp_path / "twitter_profiles.csv"
    snapshots = []

    def capture(*args):
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            snapshots.append((reader.fieldnames, list(reader)))

    generated = generator.generate_profiles_from_entities(
        entities, use_llm=False, parallel_count=1, realtime_output_path=str(path),
        output_platform="twitter", progress_callback=capture,
    )
    return generator, generated, path, snapshots


def test_heterogeneous_realtime_profiles_match_final_canonical_csv(tmp_path, monkeypatch):
    generator, generated, path, snapshots = _generate_realtime_profiles(tmp_path, monkeypatch)
    final_path = tmp_path / "final.csv"
    generator.save_profiles(generated, str(final_path), platform="twitter")
    assert path.read_bytes() == final_path.read_bytes()
    assert len(snapshots[-1][1]) == 2
    assert all(headers == ["user_id", "name", "username", "user_char", "description"] for headers, _ in snapshots)


def test_realtime_twitter_csv_is_accepted_by_installed_oasis(tmp_path, monkeypatch):
    pytest.importorskip("camel")
    from app.config import Config
    from app.local_runtime import configure_local_environment

    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    configure_local_environment()
    oasis = pytest.importorskip("oasis")
    from camel.models import StubModel
    from camel.types import ModelType

    _, _, path, _ = _generate_realtime_profiles(tmp_path, monkeypatch)
    graph = asyncio.run(oasis.generate_twitter_agent_graph(
        str(path), model=StubModel(ModelType.STUB), available_actions=[oasis.ActionType.INTERVIEW],
    ))
    assert graph.get_agent(0).user_info.name == "alice"
    assert graph.get_agent(1).user_info.description == "B short bio"
    assert graph.get_agent(1).user_info.profile["other_info"]["user_profile"] == "B short bio B long persona"


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_report_profiles_follow_configured_storage_root(tmp_path, monkeypatch, platform):
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path))
    directory = tmp_path / "sim_profiles"
    directory.mkdir()
    if platform == "reddit":
        expected = [{"username": "alice", "bio": "Reddit bio"}]
        (directory / "reddit_profiles.json").write_text(json.dumps(expected))
    else:
        (directory / "twitter_profiles.csv").write_text("name,username,description,user_char\nAlice,alice,Twitter bio,Persona\n")
        expected = [{"name": "Alice", "realname": "Alice", "username": "alice", "description": "Twitter bio",
                     "user_char": "Persona", "bio": "Twitter bio", "persona": "Persona"}]
    service = object.__new__(ZepToolsService)
    assert service._load_agent_profiles("sim_profiles") == expected


def test_report_profile_loader_retains_reddit_preference_and_csv_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path))
    directory = tmp_path / "sim_profiles"
    directory.mkdir()
    (directory / "twitter_profiles.csv").write_text("name,description,user_char\nAlice,Bio,Persona\n")
    reddit = directory / "reddit_profiles.json"
    reddit.write_text('[{"username":"preferred"}]')
    service = object.__new__(ZepToolsService)
    assert service._load_agent_profiles("sim_profiles") == [{"username": "preferred"}]
    reddit.write_text("invalid json")
    assert service._load_agent_profiles("sim_profiles")[0]["bio"] == "Bio"


@pytest.mark.parametrize("kind", ["identifier", "directory", "twitter_file", "reddit_file"])
def test_report_profile_loader_rejects_unsafe_paths(tmp_path, monkeypatch, kind):
    root = tmp_path / "root"
    root.mkdir()
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(root))
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "twitter_profiles.csv").write_text("name,description\nPrivate,Secret\n")
    (outside / "reddit_profiles.json").write_text('[{"bio":"Secret"}]')
    simulation_id = "sim_profiles"
    if kind == "identifier":
        simulation_id = "../outside"
    elif kind == "directory":
        (root / simulation_id).symlink_to(outside, target_is_directory=True)
    else:
        (root / simulation_id).mkdir()
        filename = "twitter_profiles.csv" if kind == "twitter_file" else "reddit_profiles.json"
        (root / simulation_id / filename).symlink_to(outside / filename)
    with pytest.raises(StoragePathError):
        object.__new__(ZepToolsService)._load_agent_profiles(simulation_id)


def test_report_profile_loader_missing_record_does_not_create_it(tmp_path, monkeypatch):
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path))
    assert object.__new__(ZepToolsService)._load_agent_profiles("sim_missing") == []
    assert list(tmp_path.iterdir()) == []
