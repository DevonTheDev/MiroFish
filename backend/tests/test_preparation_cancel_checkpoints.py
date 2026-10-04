"""Cooperative preparation boundaries use real services and disposable I/O."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from types import SimpleNamespace

import pytest

from app.config import Config
from app.services import simulation_manager as manager_module
from app.services.oasis_profile_generator import OasisProfileGenerator
from app.services.simulation_config_generator import SimulationConfigGenerator
from app.services.simulation_manager import SimulationManager, SimulationState, SimulationStatus
from app.services.zep_entity_reader import EntityNode, FilteredEntities
from app.utils.preparation_cancellation import PreparationCancelled
from test_local_preparation_plan import graph as graph, local as local, threads as threads


class Cancellation:
    """A deterministic stand-in for the owning controller's atomic gate."""

    def __init__(self):
        self.requested = Event()
        self.lock = Lock()
        self.finalizing = False

    def request(self):
        with self.lock:
            if self.finalizing:
                return False
            self.requested.set()
            return True

    def check(self):
        if self.requested.is_set():
            raise PreparationCancelled()

    def begin_finalization(self):
        with self.lock:
            self.check()
            self.finalizing = True


def entities(count=3):
    return [EntityNode(f"node_{i}", f"Person {i}", ["Person"], f"Summary {i}", {})
            for i in range(count)]


def profile_generator(monkeypatch):
    generator = object.__new__(OasisProfileGenerator)
    monkeypatch.setattr(generator, "_print_generated_profile", lambda *_args: None)
    return generator


@pytest.fixture
def preparation(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "LOCAL_MAX_AGENTS", 20)
    monkeypatch.setattr(Config, "LOCAL_MAX_CONCURRENCY", 1)
    monkeypatch.setattr(SimulationManager, "SIMULATION_DATA_DIR", str(tmp_path))
    manager = SimulationManager()
    state = SimulationState("sim_checkpoints", "proj_synthetic", "graph_synthetic",
                            enable_twitter=False, enable_reddit=True)
    manager._save_simulation_state(state)
    cast = entities()
    reads = []

    class Reader:
        def filter_defined_entities(self, **kwargs):
            reads.append(kwargs)
            return FilteredEntities(cast, {"Person"}, len(cast), len(cast))

    profiles = profile_generator(monkeypatch)
    configuration = object.__new__(SimulationConfigGenerator)
    configuration.model_name = "synthetic"
    configuration.base_url = "http://127.0.0.1/unused"
    configuration.AGENTS_PER_BATCH = 1
    stages = []

    def model_boundary(_prompt, _system_prompt):
        stages.append(len(stages) + 1)
        return {}

    monkeypatch.setattr(configuration, "_call_llm_with_retry", model_boundary)
    monkeypatch.setattr(manager_module, "ZepEntityReader", Reader)
    monkeypatch.setattr(manager_module, "OasisProfileGenerator", lambda **_kw: profiles)
    monkeypatch.setattr(manager_module, "SimulationConfigGenerator", lambda: configuration)
    return SimpleNamespace(manager=manager, state=state, directory=tmp_path / state.simulation_id,
                           cast=cast, reads=reads, profiles=profiles, config=configuration,
                           stages=stages)


def prepare(fixture, **kwargs):
    return fixture.manager.prepare_simulation(
        fixture.state.simulation_id, "Synthetic discussion", "Synthetic source",
        use_llm_for_profiles=False, parallel_profile_count=1, **kwargs)


def assert_cancelled(fixture, profile_count=0):
    saved = json.loads((fixture.directory / "state.json").read_text())
    assert saved["status"] == SimulationStatus.CREATED.value
    assert saved["error"] is None
    assert saved["profiles_generated"] is False
    assert saved["config_generated"] is False
    assert saved["config_reasoning"] == ""
    assert saved["profiles_count"] == profile_count
    assert not (fixture.directory / "simulation_config.json").exists()


def test_cancelled_profile_unit_never_generates_fallback_or_progress(tmp_path, monkeypatch):
    generator = profile_generator(monkeypatch)
    cancellation = Cancellation()
    cancellation.request()
    generated, progress = [], []
    monkeypatch.setattr(generator, "generate_profile_from_entity", lambda **kw: generated.append(kw))
    output = tmp_path / "partial.json"
    with pytest.raises(PreparationCancelled):
        generator.generate_profiles_from_entities(
            entities(), cancellation_check=cancellation.check, parallel_count=1,
            progress_callback=lambda *args: progress.append(args), realtime_output_path=str(output))
    assert generated == []
    assert progress == []
    assert not output.exists()


def test_profile_collector_propagates_cancellation_without_fallback(tmp_path, monkeypatch):
    generator = profile_generator(monkeypatch)
    progress = []

    def cancelled_unit(**_kwargs):
        raise PreparationCancelled()

    monkeypatch.setattr(generator, "generate_profile_from_entity", cancelled_unit)
    output = tmp_path / "partial.json"
    with pytest.raises(PreparationCancelled):
        generator.generate_profiles_from_entities(
            entities(1), cancellation_check=lambda: None,
            progress_callback=lambda *args: progress.append(args), realtime_output_path=str(output))
    assert progress == []
    assert not output.exists()


@pytest.mark.parametrize("enabled", [False, True])
def test_partial_profile_storage_failure_propagates_only_for_owned_work(tmp_path, monkeypatch, enabled):
    generator = profile_generator(monkeypatch)
    progress = []
    kwargs = {"cancellation_check": lambda: None} if enabled else {}

    def generate():
        # Opening an existing directory as an output file is an actual I/O failure.
        return generator.generate_profiles_from_entities(
            entities(1), use_llm=False, realtime_output_path=str(tmp_path),
            progress_callback=lambda *args: progress.append(args), **kwargs)

    if enabled:
        with pytest.raises(IsADirectoryError):
            generate()
        assert progress == []
    else:
        assert len(generate()) == 1
        assert len(progress) == 1


@pytest.mark.parametrize("enabled", [False, True])
def test_partial_profile_serialization_failure_retains_original_error(tmp_path, monkeypatch, enabled):
    generator = profile_generator(monkeypatch)
    original = generator.generate_profile_from_entity
    failure = TypeError("Synthetic partial profile serialization failure")
    progress = []

    def broken_serialization():
        raise failure

    def generate(**kwargs):
        profile = original(**kwargs)
        profile.to_reddit_format = broken_serialization
        return profile

    monkeypatch.setattr(generator, "generate_profile_from_entity", generate)
    kwargs = {"cancellation_check": lambda: None} if enabled else {}

    def batch():
        return generator.generate_profiles_from_entities(
            entities(1), use_llm=False, realtime_output_path=str(tmp_path / "partial.json"),
            progress_callback=lambda *args: progress.append(args), **kwargs)

    if enabled:
        with pytest.raises(TypeError, match="Synthetic partial profile serialization failure") as caught:
            batch()
        assert caught.value is failure
        assert failure.preparation_write_uncertain is True
        assert progress == []
    else:
        assert len(batch()) == 1
        assert not hasattr(failure, "preparation_write_uncertain")
        assert len(progress) == 1


def test_profile_unit_propagates_tagged_write_uncertainty(tmp_path, monkeypatch):
    generator = profile_generator(monkeypatch)
    failure = ValueError("Synthetic tagged profile write failure")
    failure.preparation_write_uncertain = True
    progress = []

    def generate(**_kwargs):
        raise failure

    monkeypatch.setattr(generator, "generate_profile_from_entity", generate)
    output = tmp_path / "partial.json"
    with pytest.raises(ValueError, match="Synthetic tagged profile write failure") as caught:
        generator.generate_profiles_from_entities(
            entities(1), use_llm=False, cancellation_check=lambda: None,
            realtime_output_path=str(output), progress_callback=lambda *args: progress.append(args))
    assert caught.value is failure
    assert progress == []
    assert not output.exists()


def test_cancelled_profile_batch_drains_nested_retrieval_before_return(tmp_path, monkeypatch):
    generator = profile_generator(monkeypatch)
    cancellation = Cancellation()
    edge_started, node_started, edge_done, node_done = (Event() for _ in range(4))
    release_edge, release_node = Event(), Event()
    started_profiles, progress, model_calls = [], [], []
    original = generator.generate_profile_from_entity

    def generate(**kwargs):
        started_profiles.append(kwargs["entity"].uuid)
        return original(**kwargs)

    def search(**kwargs):
        if kwargs["scope"] == "edges":
            edge_started.set()
            assert release_edge.wait(5)
            edge_done.set()
            return SimpleNamespace(edges=[])
        node_started.set()
        assert release_node.wait(5)
        node_done.set()
        return SimpleNamespace(nodes=[])

    generator.zep_client = SimpleNamespace(graph=SimpleNamespace(search=search))
    generator.graph_id = "graph_synthetic"
    monkeypatch.setattr(generator, "generate_profile_from_entity", generate)
    monkeypatch.setattr(generator, "_generate_profile_with_llm",
                        lambda **kwargs: model_calls.append(kwargs) or {"persona": "Completed active unit"})
    output = tmp_path / "partial.json"
    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(generator.generate_profiles_from_entities, entities(8),
                             cancellation_check=cancellation.check, parallel_count=1,
                             progress_callback=lambda *args: progress.append(args),
                             realtime_output_path=str(output))
        try:
            assert edge_started.wait(5)
            assert node_started.wait(5)
            assert cancellation.request()
            assert not result.done()
            release_edge.set()
            assert edge_done.wait(5)
            assert not result.done()
        finally:
            release_edge.set()
            release_node.set()
        with pytest.raises(PreparationCancelled):
            result.result(timeout=5)
    assert node_done.is_set()
    assert started_profiles == ["node_0"]
    assert len(model_calls) == 1  # The already running unit may finish normally.
    assert progress == []
    assert not output.exists()


@pytest.mark.parametrize("enabled", [False, True])
def test_ordinary_profile_failure_preserves_fallback_and_input_order(monkeypatch, enabled):
    generator = profile_generator(monkeypatch)
    original = generator.generate_profile_from_entity

    def generate(**kwargs):
        if kwargs["entity"].uuid == "node_1":
            raise ValueError("Synthetic provider failure")
        return original(**kwargs)

    monkeypatch.setattr(generator, "generate_profile_from_entity", generate)
    kwargs = {"cancellation_check": lambda: None} if enabled else {}
    progress = []
    profiles = generator.generate_profiles_from_entities(
        entities(), use_llm=False, progress_callback=lambda current, *_: progress.append(current), **kwargs)
    assert [profile.source_entity_uuid for profile in profiles] == ["node_0", "node_1", "node_2"]
    assert profiles[1].persona == "Summary 1"
    assert progress == [1, 2, 3]


@pytest.mark.parametrize("selected", [False, True])
def test_manager_cancellation_before_graph_work_clears_ready_flags(preparation, selected):
    cancellation = Cancellation()
    cancellation.request()
    preparation.state.profiles_generated = True
    preparation.state.config_generated = True
    preparation.state.config_reasoning = "Old result"
    preparation.state.error = "Old failure"
    kwargs = {"selected_entity_ids": [entity.uuid for entity in preparation.cast]} if selected else {}
    with pytest.raises(PreparationCancelled):
        prepare(preparation, cancellation_check=cancellation.check, **kwargs)
    assert preparation.reads == []
    assert preparation.stages == []
    assert_cancelled(preparation)


@pytest.mark.parametrize("selected", [False, True])
def test_manager_checks_cancel_after_graph_read_before_profile_work(preparation, monkeypatch, selected):
    cancellation = Cancellation()

    class Reader:
        def filter_defined_entities(self, **_kwargs):
            cancellation.request()
            return FilteredEntities(preparation.cast, {"Person"}, 3, 3)

    monkeypatch.setattr(manager_module, "ZepEntityReader", Reader)
    monkeypatch.setattr(manager_module, "OasisProfileGenerator",
                        lambda **_kw: pytest.fail("profiles started after cancelled graph read"))
    kwargs = {"selected_entity_ids": [entity.uuid for entity in preparation.cast]} if selected else {}
    with pytest.raises(PreparationCancelled):
        prepare(preparation, cancellation_check=cancellation.check, **kwargs)
    assert preparation.stages == []
    assert_cancelled(preparation)


def test_manager_retains_completed_partial_profiles_and_count(preparation, monkeypatch):
    cancellation = Cancellation()
    entered, release = Event(), Event()
    original = preparation.profiles.generate_profile_from_entity

    def generate(**kwargs):
        if kwargs["entity"].uuid != "node_0":
            entered.set()
            assert release.wait(5)
        return original(**kwargs)

    def progress(stage, _percent, _message, **kwargs):
        if stage == "generating_profiles" and kwargs.get("current") == 1:
            cancellation.request()

    monkeypatch.setattr(preparation.profiles, "generate_profile_from_entity", generate)
    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(prepare, preparation, cancellation_check=cancellation.check,
                             progress_callback=progress)
        try:
            assert cancellation.requested.wait(5)
        finally:
            release.set()
        with pytest.raises(PreparationCancelled):
            result.result(timeout=5)
    profiles = json.loads((preparation.directory / "reddit_profiles.json").read_text())
    assert [profile["name"] for profile in profiles] == ["Person 0"]
    assert preparation.stages == []
    assert_cancelled(preparation, profile_count=1)


@pytest.mark.parametrize("cancel_after", range(1, 6))
@pytest.mark.parametrize("provider_fails", [False, True])
def test_config_cancellation_stops_before_next_stage_with_existing_fallbacks(
    preparation, monkeypatch, cancel_after, provider_fails
):
    cancellation = Cancellation()
    calls = []

    def model_boundary(_prompt, _system_prompt):
        calls.append(len(calls) + 1)
        if len(calls) == cancel_after:
            cancellation.request()
        if provider_fails:
            raise ValueError("Synthetic exhausted provider retry")
        return {}

    monkeypatch.setattr(preparation.config, "_call_llm_with_retry", model_boundary)
    with pytest.raises(PreparationCancelled):
        prepare(preparation, cancellation_check=cancellation.check,
                begin_finalization=cancellation.begin_finalization)
    assert calls == list(range(1, cancel_after + 1))
    assert_cancelled(preparation, profile_count=3)


def test_cancellation_after_config_return_wins_before_final_file(preparation, monkeypatch):
    cancellation = Cancellation()
    original = preparation.config.generate_config

    def finish_config(**kwargs):
        params = original(**kwargs)
        assert cancellation.request()
        return params

    monkeypatch.setattr(preparation.config, "generate_config", finish_config)
    with pytest.raises(PreparationCancelled):
        prepare(preparation, cancellation_check=cancellation.check,
                begin_finalization=cancellation.begin_finalization)
    assert not cancellation.finalizing
    assert_cancelled(preparation, profile_count=3)


def test_finalization_closes_admission_before_config_file_or_ready(preparation):
    cancellation = Cancellation()
    finalization_calls = []
    late_requests = []

    def begin():
        assert not (preparation.directory / "simulation_config.json").exists()
        assert preparation.state.status != SimulationStatus.READY
        cancellation.begin_finalization()
        finalization_calls.append(True)

    def progress(stage, percent, _message, **_kwargs):
        if stage == "generating_config" and percent >= 70:
            late_requests.append(cancellation.request())

    result = prepare(preparation, cancellation_check=cancellation.check,
                     begin_finalization=begin, progress_callback=progress)
    assert finalization_calls == [True]
    assert late_requests == [False, False]
    assert result.status == SimulationStatus.READY
    saved = json.loads((preparation.directory / "simulation_config.json").read_text())
    assert len(saved["agent_configs"]) == 3


@pytest.mark.parametrize("error_type", [OSError, ValueError])
def test_cancelled_state_storage_failure_propagates_actual_error(preparation, monkeypatch, error_type):
    cancellation = Cancellation()
    cancellation.request()
    failure = error_type("Synthetic cancelled state storage failure")

    def storage_failure(_state):
        raise failure

    monkeypatch.setattr(preparation.manager, "_save_simulation_state", storage_failure)
    with pytest.raises(error_type, match="cancelled state storage failure") as caught:
        prepare(preparation, cancellation_check=cancellation.check)
    assert caught.value is failure
    assert failure.preparation_write_uncertain is True
    assert preparation.state.status == SimulationStatus.CREATED
    assert preparation.state.error is None
    assert preparation.reads == []


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("boundary", ["preparing_state", "profiles_state", "ready_state", "failed_state",
                                      "profiles_file", "config_file"])
def test_manager_tags_only_enabled_persistence_failures(preparation, monkeypatch, enabled, boundary):
    failure = ValueError(f"Synthetic {boundary} write failure")
    original_save = preparation.manager._save_simulation_state

    def fail():
        raise failure

    def save(state):
        matches = {
            "preparing_state": state.status == SimulationStatus.PREPARING and not state.profiles_generated,
            "profiles_state": state.status == SimulationStatus.PREPARING and state.profiles_generated,
            "ready_state": state.status == SimulationStatus.READY,
            "failed_state": state.status == SimulationStatus.FAILED,
        }
        if matches.get(boundary):
            fail()
        return original_save(state)

    monkeypatch.setattr(preparation.manager, "_save_simulation_state", save)
    if boundary == "failed_state":
        monkeypatch.setattr(manager_module, "ZepEntityReader",
                            lambda: (_ for _ in ()).throw(RuntimeError("Synthetic read error")))
    elif boundary == "profiles_file":
        monkeypatch.setattr(preparation.profiles, "save_profiles", lambda **_kwargs: fail())
    elif boundary == "config_file":
        original_config = preparation.config.generate_config

        def config(**kwargs):
            params = original_config(**kwargs)
            params.to_json = fail
            return params

        monkeypatch.setattr(preparation.config, "generate_config", config)

    kwargs = {"cancellation_check": lambda: None} if enabled else {}
    with pytest.raises(ValueError, match=f"Synthetic {boundary} write failure") as caught:
        prepare(preparation, **kwargs)
    assert caught.value is failure
    assert getattr(failure, "preparation_write_uncertain", False) is enabled


def test_cancelled_manager_write_failure_keeps_owner_after_worker_save_succeeds(
    local, graph, threads, monkeypatch
):
    from app.services import preparation_cancellation, preparation_plan
    from test_local_preparation_plan import post

    original_prepare = SimulationManager.prepare_simulation
    failure = ValueError("Synthetic one-time cancelled manager state failure")
    manager_save_attempts = []

    def manager_save(self, state):
        manager_save_attempts.append(state.status)
        assert state.status == SimulationStatus.CREATED
        raise failure

    def cancel_then_prepare(self, **kwargs):
        response = local.client.post("/api/simulation/prepare/cancel", json={
            "simulation_id": "sim_fixture", "task_id": task_id})
        assert response.json["data"]["accepted"] is True
        return original_prepare(self, **kwargs)

    monkeypatch.setattr(SimulationManager, "_save_simulation_state", manager_save)
    monkeypatch.setattr(SimulationManager, "prepare_simulation", cancel_then_prepare)
    response = post(local, selected_entity_ids=["node_2"])
    assert response.status_code == 200
    task_id = response.json["data"]["task_id"]
    owner = preparation_cancellation.get_controller(task_id)
    threads[0].target()

    assert manager_save_attempts == [SimulationStatus.CREATED]
    assert failure.preparation_write_uncertain is True
    assert preparation_cancellation.get_controller(task_id) is owner
    assert owner.phase == "unavailable"
    assert preparation_plan.active_prepare_tasks("sim_fixture")
    # The independent worker save succeeded, but cannot erase earlier uncertainty.
    saved = json.loads((local.root / "sim_fixture" / "state.json").read_text())
    assert saved["status"] == "created"
    assert saved["error"] is None
    assert saved["config_reasoning"] == ""
    marker = json.loads((local.root / "sim_fixture" / "preparation_cancellation.json").read_text())
    assert marker["phase"] == "cancelling"


@pytest.mark.parametrize("local", [False, True])
@pytest.mark.parametrize("callbacks", [False, True])
@pytest.mark.parametrize("phase", ["cancelling", "cancelled", "corrupt"])
def test_direct_manager_refuses_cancellation_markers_before_resource_work(
    preparation, monkeypatch, local, callbacks, phase
):
    from app.services.preparation_plan import PlanningError

    monkeypatch.setattr(Config, "LOCAL_MODE", local)
    marker = {"schema_version": 1, "simulation_id": preparation.state.simulation_id,
              "task_id": "task_synthetic", "phase": phase, "progress": 25,
              "requested_at": "2026-10-04T10:00:00+00:00",
              "updated_at": "2026-10-04T10:00:00+00:00"}
    path = preparation.directory / "preparation_cancellation.json"
    path.write_text(json.dumps(marker))
    original_state = (preparation.directory / "state.json").read_bytes()
    original_marker = path.read_bytes()
    kwargs = {"cancellation_check": lambda: None, "begin_finalization": lambda: None} if callbacks else {}
    with pytest.raises(PlanningError) as error:
        prepare(preparation, **kwargs)
    assert error.value.code == ("cancellation_unavailable" if phase == "corrupt" else "preparation_cancelled")
    assert preparation.reads == []
    assert preparation.stages == []
    assert (preparation.directory / "state.json").read_bytes() == original_state
    assert path.read_bytes() == original_marker


def test_live_cancellation_signal_takes_precedence_over_its_marker(preparation):
    cancellation = Cancellation()
    cancellation.request()
    path = preparation.directory / "preparation_cancellation.json"
    path.write_text(json.dumps({"schema_version": 1, "simulation_id": preparation.state.simulation_id,
        "task_id": "task_synthetic", "phase": "cancelling", "progress": 0,
        "requested_at": "2026-10-04T10:00:00+00:00", "updated_at": "2026-10-04T10:00:00+00:00"}))
    with pytest.raises(PreparationCancelled):
        prepare(preparation, cancellation_check=cancellation.check)
    assert_cancelled(preparation)
    assert json.loads(path.read_text())["phase"] == "cancelling"


def test_cancellation_accepted_during_marker_check_remains_clean_cancellation(preparation, monkeypatch):
    from app.services import preparation_cancellation

    cancellation = Cancellation()
    original = preparation_cancellation.assert_not_blocked

    def marker_check(simulation_id):
        (preparation.directory / "preparation_cancellation.json").write_text(json.dumps({
            "schema_version": 1, "simulation_id": simulation_id, "task_id": "task_synthetic",
            "phase": "cancelling", "progress": 0, "requested_at": "2026-10-04T10:00:00+00:00",
            "updated_at": "2026-10-04T10:00:00+00:00"}))
        cancellation.request()
        original(simulation_id)

    monkeypatch.setattr(preparation_cancellation, "assert_not_blocked", marker_check)
    with pytest.raises(PreparationCancelled):
        prepare(preparation, cancellation_check=cancellation.check)
    assert preparation.reads == []
    assert_cancelled(preparation)


@pytest.mark.parametrize("local", [False, True])
def test_default_manager_calls_keep_legacy_dependency_keywords(preparation, monkeypatch, local):
    monkeypatch.setattr(Config, "LOCAL_MODE", local)
    original_profiles = preparation.profiles.generate_profiles_from_entities
    original_config = preparation.config.generate_config
    calls = []

    def generate_profiles(**kwargs):
        assert "cancellation_check" not in kwargs
        calls.append("profiles")
        return original_profiles(**kwargs)

    def generate_config(**kwargs):
        assert "progress_callback" not in kwargs
        calls.append("config")
        return original_config(**kwargs)

    monkeypatch.setattr(preparation.profiles, "generate_profiles_from_entities", generate_profiles)
    monkeypatch.setattr(preparation.config, "generate_config", generate_config)
    assert prepare(preparation).status == SimulationStatus.READY
    assert calls == ["profiles", "config"]
