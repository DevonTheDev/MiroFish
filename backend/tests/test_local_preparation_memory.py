"""Planner reads actual Graphiti/Neo4j entities without new inference."""

import json
from pathlib import Path

import pytest

from test_local_memory_integration import URI, client  # noqa: F401

pytestmark = pytest.mark.skipif(not URI, reason='isolated Neo4j not configured')


def test_planner_real_local_graph_preview_and_selected_reader_are_inference_free(request, tmp_path, monkeypatch):
    from app.config import Config
    from app.models.project import Project, ProjectManager, ProjectStatus
    from app.models.task import TaskManager
    from app.services import graph_builder, preparation_plan, zep_entity_reader
    from app.services.simulation_manager import SimulationManager, SimulationState
    from app.services.simulation_runner import SimulationRunner
    from app.services.zep_graph_memory_updater import ZepGraphMemoryManager
    from app.utils.zep_lifecycle import get_graph_readers

    adapter, model, graph, _settings = request.getfixturevalue('client')
    monkeypatch.setattr(Config, 'LOCAL_MODE', True)
    monkeypatch.setattr(Config, 'LOCAL_MAX_AGENTS', 1)
    monkeypatch.setattr(Config, 'LOCAL_MAX_ROUNDS', 5)
    monkeypatch.setattr(Config, 'LOCAL_MAX_CONCURRENCY', 1)
    monkeypatch.setattr(SimulationManager, 'SIMULATION_DATA_DIR', str(tmp_path / 'simulations'))
    monkeypatch.setattr(SimulationRunner, 'RUN_STATE_DIR', str(tmp_path / 'simulations'))
    monkeypatch.setattr(ProjectManager, 'PROJECTS_DIR', str(tmp_path / 'projects'))
    monkeypatch.setattr(TaskManager, '_instance', None)
    monkeypatch.setattr(SimulationRunner, '_run_states', {})
    monkeypatch.setattr(SimulationRunner, '_processes', {})
    monkeypatch.setattr(SimulationRunner, '_monitor_threads', {})
    monkeypatch.setattr(ZepGraphMemoryManager, '_updaters', {})
    constructions = []

    def memory(*_args, **_kwargs):
        constructions.append(True)
        return adapter

    monkeypatch.setattr(graph_builder, 'get_zep_client', memory)
    monkeypatch.setattr(zep_entity_reader, 'get_zep_client', memory)
    group = graph()
    model.typed = True
    builder = graph_builder.GraphBuilderService()
    builder.set_ontology(group, {'entity_types': [{'name': 'Person', 'description': 'A person', 'attributes': []}],
                                 'edge_types': []})
    submission = builder.add_text_batches(group, ['Alice knows Bob.'])
    assert len(builder._wait_for_batch(submission, timeout=45)) == 1
    project = Project('proj_planner', 'Synthetic planner', ProjectStatus.GRAPH_COMPLETED,
                      '2026-10-04T00:00:00', '2026-10-04T00:00:00', graph_id=group,
                      simulation_requirement='Synthetic discussion')
    (Path(ProjectManager.PROJECTS_DIR) / project.project_id).mkdir(parents=True)
    ProjectManager.save_project(project)
    manager = SimulationManager()
    state = SimulationState('sim_planner', project.project_id, group,
                            enable_twitter=False, enable_reddit=True)
    manager._save_simulation_state(state)
    state_path = Path(SimulationManager.SIMULATION_DATA_DIR) / state.simulation_id / 'state.json'
    original = state_path.read_bytes()
    inference_count = len(model.calls)
    construction_count = len(constructions)

    observed = preparation_plan.get_plan(state.simulation_id)
    assert observed['can_prepare'] is True and observed['can_reuse'] is False
    assert len(constructions) == construction_count
    preview = preparation_plan.preview_cast({'simulation_id': state.simulation_id})
    assert preview['eligible_count'] == 2
    assert preview['limits']['max_selectable_agents'] == 1
    assert [entity['name'] for entity in preview['entities']] == ['Alice', 'Bob']
    assert {entity['entity_type'] for entity in preview['entities']} == {'Person'}
    selected_id = preview['entities'][1]['uuid']
    selected = zep_entity_reader.ZepEntityReader().filter_defined_entities(
        graph_id=group, selected_entity_ids=[selected_id], enrich_with_edges=False,
        max_nodes=5000, max_edges=20000,
    )
    assert [entity.uuid for entity in selected.entities] == [selected_id]
    assert [entity.name for entity in selected.entities] == ['Bob']
    assert selected.filtered_count == 1 and selected.total_count == 2
    assert len(model.calls) == inference_count
    assert state_path.read_bytes() == original
    assert json.loads(original)['status'] == 'created'
    assert get_graph_readers(group) == []
