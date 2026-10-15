"""Recorded creation routes with fake provider boundaries and disposable stores."""

import csv
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from types import SimpleNamespace

import pytest
from flask import Flask

from app.api import simulation as api
from app.services import oasis_profile_generator as module
from app.services.oasis_profile_generator import OasisAgentProfile, OasisProfileGenerator
from app.services.profile_formats import (
    decode_generation_provenance,
    normalize_generation_provenance,
    normalize_profile_provenance,
    normalize_twitter_profile,
)
from app.services.simulation_manager import SimulationManager, SimulationState, SimulationStatus
from app.services.zep_entity_reader import EntityNode
from app.utils.preparation_cancellation import PreparationCancelled


MODEL_ROUTES = ("model_json", "model_recovered_json", "model_partial_fields")
RULE_ROUTES = ("rule_requested", "rule_fallback", "basic_fallback")
HEADERS = ["user_id", "name", "username", "user_char", "description"]


def record(route, length=False):
    value = {"version": 1, "route": route}
    if route in MODEL_ROUTES:
        value["provider_reported_length"] = length
    return value


def entity(index=0):
    return EntityNode(f"entity_{index}", f"Person {index}", ["Person"],
                      f"Summary {index}", {}, related_edges=[], related_nodes=[])


def generator(monkeypatch, responses=()):
    result = object.__new__(OasisProfileGenerator)
    result.client = object()
    result.model_name = "fake-only"
    calls, sleeps = [], []
    pending = iter(responses)

    def completion(_client, **kwargs):
        calls.append(kwargs)
        response = next(pending)
        if isinstance(response, Exception):
            raise response
        content, reason = response
        return SimpleNamespace(choices=[SimpleNamespace(
            finish_reason=reason, message=SimpleNamespace(content=content))])

    monkeypatch.setattr(module, "create_chat_completion", completion)
    monkeypatch.setattr(module, "extract_chat_completion_text",
                        lambda response: response.choices[0].message.content)
    monkeypatch.setattr(module.time, "sleep", sleeps.append)
    monkeypatch.setattr(result, "_build_entity_context", lambda _entity: "Synthetic context")
    monkeypatch.setattr(result, "_print_generated_profile", lambda *_args: None)
    return result, calls, sleeps


@pytest.mark.parametrize("content,reason,route,length", [
    ('{"bio":"Bio","persona":"Persona"}', "stop", "model_json", False),
    ('  {"bio":"Bio","persona":"Persona"} \n', "length", "model_json", True),
    ('{"bio":"Bio","persona":"Persona', "length", "model_recovered_json", True),
    ('prefix {"bio":"Bio","persona":"Persona"}', None, "model_recovered_json", False),
    ('{"bio":"Bio\nline","persona":"Persona"}', "stop", "model_recovered_json", False),
    ('{"bio":"Bio\x01line","persona":"Persona"}', "filter", "model_recovered_json", False),
    ('not json "bio":"Bio" trailing', "stop", "model_partial_fields", False),
    ('not json "persona":"Persona', "length", "model_partial_fields", True),
    ('{}', "stop", "model_json", False),
    ('{"bio":{"text":"Bio"},"persona":["Person","a"]}', "stop", "model_json", False),
    ('{"bio":"Bio","generation_provenance":{"version":1,"route":"basic_fallback"},"_fixed":true}',
     "stop", "model_json", False),
])
def test_records_actual_accepted_branch(monkeypatch, content, reason, route, length):
    gen, calls, sleeps = generator(monkeypatch, [(content, reason)])
    profile = gen.generate_profile_from_entity(entity(), 0)
    assert profile.generation_provenance == record(route, length)
    assert isinstance(profile.bio, str) and isinstance(profile.persona, str)
    assert len(calls) == 1
    assert sleeps == []
    assert "generation_provenance" not in calls[0]["messages"][0]["content"]


def test_failed_repairs_retry_and_accepted_attempt_owns_length(monkeypatch):
    gen, calls, sleeps = generator(monkeypatch, [
        ("no usable fields", "length"), ('{"bio":"Second","persona":"Accepted"}', "stop")])
    profile = gen.generate_profile_from_entity(entity(), 0)
    assert profile.bio == "Second"
    assert profile.generation_provenance == record("model_json")
    assert [call["temperature"] for call in calls] == [0.7, 0.6]
    assert sleeps == []  # Failed JSON repair did not enter the broad exception branch.


def test_rule_fallback_records_only_after_existing_attempts(monkeypatch):
    gen, calls, sleeps = generator(monkeypatch, [RuntimeError("fake") for _ in range(3)])
    profile = gen.generate_profile_from_entity(entity(), 0)
    assert profile.generation_provenance == record("rule_fallback")
    assert len(calls) == 3
    assert sleeps == [1, 2, 3]


def test_unaccepted_repair_dictionary_does_not_become_basic_route(monkeypatch):
    gen, calls, sleeps = generator(monkeypatch, [("no fields", "length")] * 3)
    profile = gen.generate_profile_from_entity(entity(), 0)
    assert profile.generation_provenance == record("rule_fallback")
    assert len(calls) == 3 and sleeps == []


def test_rule_requested_never_calls_provider_or_retrieval(monkeypatch):
    gen, calls, _ = generator(monkeypatch)
    monkeypatch.setattr(gen, "_build_entity_context", lambda _: pytest.fail("Unexpected retrieval"))
    profile = gen.generate_profile_from_entity(entity(), 3, use_llm=False)
    assert profile.generation_provenance == record("rule_requested")
    assert calls == []


@pytest.mark.parametrize("route", MODEL_ROUTES + RULE_ROUTES)
def test_closed_metadata_shape_and_copied_records(route):
    value = record(route)
    normalized = normalize_generation_provenance(value)
    assert normalized == value and normalized is not value
    assert decode_generation_provenance(json.dumps(value)) == value
    assert len(json.dumps(value).encode("utf-8")) < 256


INVALID = [None, "", [], 1, True, "null", {"version": True, "route": "rule_requested"},
           {"version": "1", "route": "rule_requested"}, {"version": 2, "route": "rule_requested"},
           {"version": 1, "route": []}, {"version": 1, "route": "new_route"},
           {"version": 1, "route": "model_json"},
           {"version": 1, "route": "model_json", "provider_reported_length": 1},
           {"version": 1, "route": "rule_requested", "provider_reported_length": False},
           {"version": 1, "route": "basic_fallback", "extra": "untrusted"}]


@pytest.mark.parametrize("value", INVALID)
def test_malformed_metadata_is_unknown_without_changing_content(value):
    assert normalize_generation_provenance(value) is None
    row = {"bio": {"text": "Keep exactly"}, "generation_provenance": value}
    projected = normalize_profile_provenance(row)
    assert projected == {**row, "generation_provenance": None}
    assert row["generation_provenance"] == value


@pytest.mark.parametrize("cell", [
    '{"version":1,"version":1,"route":"rule_requested"}',
    '{"version":1,"route":"rule_requested","route":"basic_fallback"}',
    '{"version":1,"route":"rule_requested"}' + ' ' * 219,
    '"' + "中" * 86 + '"',
    "{", "[]", "true", "null", "\ud800",
])
def test_csv_decoder_rejects_duplicate_oversize_and_invalid_cells(cell):
    assert decode_generation_provenance(cell) is None


def test_object_field_never_decodes_csv_text_and_legacy_rows_stay_exact():
    value = record("model_json")
    assert normalize_generation_provenance(json.dumps(value)) is None
    assert normalize_profile_provenance({"bio": "old"}) == {"bio": "old"}
    assert normalize_profile_provenance(17) == 17
    raw = {"description": "Bio", "user_char": "Persona"}
    assert normalize_twitter_profile(raw) == {**raw, "bio": "Bio", "persona": "Persona"}
    assert raw == {"description": "Bio", "user_char": "Persona"}


def profile(index=0, provenance=None):
    return OasisAgentProfile(index, f"person_{index}", f"Person, {index}",
                             'Bio "quoted"\nline', "Persona\rnext", created_at="2026-01-01",
                             generation_provenance=provenance)


def read_rows(path):
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        return reader.fieldnames, list(reader)


def test_all_serializers_copy_row_metadata_and_keep_legacy_formats(tmp_path):
    gen = object.__new__(OasisProfileGenerator)
    known, unknown = profile(8, record("model_json", True)), profile(20)
    for method in ("to_dict", "to_reddit_format", "to_twitter_format"):
        metadata = getattr(known, method)()["generation_provenance"]
        assert metadata == known.generation_provenance and metadata is not known.generation_provenance
        assert "generation_provenance" not in getattr(unknown, method)()
    old = tmp_path / "old.csv"
    mixed = tmp_path / "mixed.csv"
    gen._save_twitter_csv([unknown], str(old))
    assert read_rows(old)[0] == HEADERS
    gen._save_twitter_csv([known, unknown], str(mixed))
    headers, rows = read_rows(mixed)
    assert headers == HEADERS + ["generation_provenance"]
    assert [row["user_id"] for row in rows] == ["0", "1"]
    assert rows[1]["generation_provenance"] == ""
    assert json.loads(rows[0]["generation_provenance"]) == record("model_json", True)
    assert rows[0]["description"] == 'Bio "quoted" line'
    assert rows[0]["user_char"] == 'Bio "quoted" line Persona next'
    final = tmp_path / "final.json"
    gen._save_reddit_json([known, unknown], str(final))
    saved = json.loads(final.read_text())
    assert saved[0]["generation_provenance"] == record("model_json", True)
    assert "generation_provenance" not in saved[1]
    assert saved[0]["age"] == 30 and saved[0]["mbti"] == "ISTJ"
    assert saved[0]["bio"] == known.bio[:150]


def test_invocation_carriers_are_isolated_in_shared_generator(monkeypatch):
    gen, _, _ = generator(monkeypatch)
    rendezvous = Barrier(2)
    def completion(_client, **kwargs):
        rendezvous.wait(timeout=5)
        prompt = kwargs["messages"][1]["content"]
        text, reason = ('{"bio":"Zero","persona":"P"}', "stop") if "Person 0" in prompt else (
            'not json "bio":"One" trailing', "length")
        return SimpleNamespace(choices=[SimpleNamespace(finish_reason=reason, message=SimpleNamespace(content=text))])
    monkeypatch.setattr(module, "create_chat_completion", completion)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(gen.generate_profile_from_entity, entity(i), i) for i in range(2)]
        profiles = [future.result(timeout=5) for future in futures]
    assert [p.generation_provenance for p in profiles] == [record("model_json"), record("model_partial_fields", True)]


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_out_of_order_preview_keeps_metadata_on_its_row(tmp_path, monkeypatch, platform):
    gen, _, _ = generator(monkeypatch)
    second_saved = Event()
    rows = [profile(0, record("model_json")), profile(1, record("rule_requested"))]
    def generate(entity, user_id, use_llm):
        if user_id == 0:
            assert second_saved.wait(5)
        return rows[user_id]
    monkeypatch.setattr(gen, "generate_profile_from_entity", generate)
    path = tmp_path / ("preview.csv" if platform == "twitter" else "preview.json")
    snapshots = []
    def progress(*_args):
        snapshots.append(read_rows(path)[1] if platform == "twitter" else json.loads(path.read_text()))
        second_saved.set()
    actual = gen.generate_profiles_from_entities(
        [entity(0), entity(1)], parallel_count=2, realtime_output_path=str(path),
        output_platform=platform, progress_callback=progress)
    assert actual == rows
    assert snapshots[0][0]["name"] == rows[1].name
    metadata = snapshots[0][0]["generation_provenance"]
    assert (json.loads(metadata) if platform == "twitter" else metadata) == record("rule_requested")
    if platform == "twitter":
        assert snapshots[0][0]["user_id"] == "0"  # Preview reindexing is intentional.
    assert [p["name"] for p in snapshots[-1]] == [p.name for p in rows]
    final = tmp_path / ("final.csv" if platform == "twitter" else "final.json")
    gen.save_profiles(actual, str(final), platform)
    saved = read_rows(final)[1] if platform == "twitter" else json.loads(final.read_text())
    for i, row in enumerate(saved):
        assert (json.loads(row["generation_provenance"]) if platform == "twitter" else row["generation_provenance"]) == rows[i].generation_provenance


def test_worker_and_collection_replacements_record_basic_fallback(monkeypatch):
    gen, _, _ = generator(monkeypatch)
    monkeypatch.setattr(gen, "_build_entity_context", lambda _: (_ for _ in ()).throw(RuntimeError("retrieval")))
    profiles = gen.generate_profiles_from_entities([entity()], parallel_count=1)
    assert profiles[0].generation_provenance == record("basic_fallback")
    def failed_progress(*_args):
        raise RuntimeError("collection progress")
    profiles = gen.generate_profiles_from_entities([entity()], use_llm=False, parallel_count=1,
                                                   progress_callback=failed_progress)
    assert profiles[0].generation_provenance == record("basic_fallback")


def test_constructed_fallback_is_discarded_at_existing_cancellation_checkpoint(monkeypatch, tmp_path):
    gen, _, _ = generator(monkeypatch)
    constructed = []
    real_profile = module.OasisAgentProfile
    def construct(*args, **kwargs):
        result = real_profile(*args, **kwargs)
        constructed.append(result)
        return result
    monkeypatch.setattr(module, "OasisAgentProfile", construct)
    monkeypatch.setattr(gen, "generate_profile_from_entity", lambda **_: (_ for _ in ()).throw(ValueError("fake")))
    def cancellation():
        if constructed:
            raise PreparationCancelled()
    path = tmp_path / "partial.json"
    with pytest.raises(PreparationCancelled):
        gen.generate_profiles_from_entities([entity()], parallel_count=1,
            realtime_output_path=str(path), cancellation_check=cancellation)
    assert constructed[0].generation_provenance == record("basic_fallback")
    assert not path.exists()


@pytest.mark.parametrize("owned", [False, True])
def test_storage_failure_keeps_existing_callback_dependent_behavior(monkeypatch, tmp_path, owned):
    gen, _, _ = generator(monkeypatch)
    options = {"cancellation_check": lambda: None} if owned else {}
    def run():
        return gen.generate_profiles_from_entities([entity()], use_llm=False, parallel_count=1,
                                                   realtime_output_path=str(tmp_path), **options)
    if owned:
        with pytest.raises(IsADirectoryError):
            run()
    else:
        assert run()[0].generation_provenance == record("rule_requested")


@pytest.fixture
def readers(tmp_path, monkeypatch):
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path))
    manager = SimulationManager()
    state = SimulationState("sim_provenance", "proj_synthetic", "graph_synthetic",
                            status=SimulationStatus.READY, entities_count=3,
                            enable_reddit=True, enable_twitter=True)
    manager._save_simulation_state(state)
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    return manager, tmp_path / state.simulation_id, app.test_client()


@pytest.mark.parametrize("platform", ["reddit", "twitter"])
def test_saved_reopen_readers_isolate_malformed_metadata(readers, platform):
    manager, folder, client = readers
    valid = record("model_recovered_json", True)
    if platform == "reddit":
        path = folder / "reddit_profiles.json"
        rows = [{"user_id": 0, "bio": "valid", "generation_provenance": valid},
                {"user_id": 1, "bio": "legacy"},
                {"user_id": 2, "bio": "invalid", "generation_provenance": {**valid, "extra": "bad"}}]
        path.write_text(json.dumps(rows))
    else:
        path = folder / "twitter_profiles.csv"
        with path.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=HEADERS + ["generation_provenance"])
            writer.writeheader()
            for i, value in enumerate([json.dumps(valid), "", '{"version":1,"route":"rule_requested"}' + ' ' * 219]):
                writer.writerow({"user_id": i, "description": f"Bio {i}", "user_char": f"Persona {i}",
                                 "generation_provenance": value})
    before = path.read_bytes()
    fresh = SimulationManager()
    loaded = fresh.get_profiles("sim_provenance", platform)
    response = client.get(f"/api/simulation/sim_provenance/profiles/realtime?platform={platform}")
    assert response.status_code == 200
    data = response.json["data"]
    assert data["profiles"] == loaded and data["count"] == 3
    assert data["file_exists"] is True and data["is_generating"] is False
    assert data["status"] == "ready"
    assert loaded[0]["generation_provenance"] == valid
    assert loaded[1].get("generation_provenance") is None
    assert loaded[2]["generation_provenance"] is None
    assert path.read_bytes() == before


def test_whole_file_decode_failure_and_non_row_values_keep_existing_semantics(readers):
    manager, folder, client = readers
    path = folder / "reddit_profiles.json"
    path.write_text("[")
    with pytest.raises(json.JSONDecodeError):
        manager.get_profiles("sim_provenance", "reddit")
    data = client.get("/api/simulation/sim_provenance/profiles/realtime?platform=reddit").json["data"]
    assert data["profiles"] == [] and data["file_exists"] is True
    path.write_text('[17,null,{"bio":"readable","generation_provenance":false}]')
    assert manager.get_profiles("sim_provenance", "reddit") == [17, None, {"bio": "readable", "generation_provenance": None}]
    path.write_text('{"old":"top-level shape"}')
    assert manager.get_profiles("sim_provenance", "reddit") == {"old": "top-level shape"}


@pytest.mark.parametrize("twitter,reddit", [(True, False), (False, True), (True, True)])
def test_metadata_does_not_change_ready_artifact_criteria(tmp_path, monkeypatch, twitter, reddit):
    from test_simulation_prepared import prepare_files
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path))
    state, folder = prepare_files(tmp_path, twitter, reddit)
    if reddit:
        path = folder / "reddit_profiles.json"
        rows = json.loads(path.read_text())
        rows[0]["generation_provenance"] = record("rule_requested")
        rows[1]["generation_provenance"] = {"version": 99, "route": "untrusted"}
        path.write_text(json.dumps(rows))
    if twitter:
        path = folder / "twitter_profiles.csv"
        headers, rows = read_rows(path)
        with path.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=headers + ["generation_provenance"])
            writer.writeheader()
            for index, row in enumerate(rows):
                writer.writerow({**row, "generation_provenance": json.dumps(record("rule_requested")) if index == 0 else "invalid"})
    prepared, info = api._check_simulation_prepared(state.simulation_id)
    assert prepared is True and info["profiles_count"] == 2


def test_accepted_preview_keeps_its_record_when_later_cancelled(tmp_path, monkeypatch):
    gen, _, _ = generator(monkeypatch)
    path = tmp_path / "partial.json"
    cancelled = Event()
    def check():
        if cancelled.is_set():
            raise PreparationCancelled()
    with pytest.raises(PreparationCancelled):
        gen.generate_profiles_from_entities([entity()], use_llm=False, parallel_count=1,
            realtime_output_path=str(path), cancellation_check=check,
            progress_callback=lambda *_: cancelled.set())
    assert json.loads(path.read_text())[0]["generation_provenance"] == record("rule_requested")
