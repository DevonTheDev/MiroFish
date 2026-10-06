"""Actual local setup routes, preparation files and compiled Vue interactions."""

import json
from pathlib import Path
import shutil
import subprocess
import threading
from types import SimpleNamespace

import pytest
from werkzeug.serving import make_server

from app import create_app
from app.config import Config
from app.models.project import Project, ProjectManager, ProjectStatus
from app.models.task import TaskManager
from app.services.simulation_manager import SimulationManager, SimulationState, SimulationStatus
from app.services.simulation_runner import SimulationRunner, SimulationRunState, RunnerStatus
from app.services.zep_graph_memory_updater import ZepGraphMemoryManager
from app.services.simulation_config_generator import (
    AgentActivityConfig, PlatformConfig, SimulationConfigGenerator, SimulationParameters, TimeSimulationConfig,
)


@pytest.mark.parametrize('scenario', ['template', 'llm', 'reuse', 'reuse_failed', 'cloud',
                                      'reuse_profile_outage', 'reuse_profile_unsuccessful', 'reuse_profile_missing_data'])
def test_local_planner_real_flask_axios_vue_and_saved_artifacts(tmp_path, monkeypatch, scenario):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    if node is None or not (repo / 'frontend/node_modules/vue/package.json').is_file():
        pytest.skip('Local planner workflow requires Node and installed frontend dependencies')

    from app import local_runtime
    from app.local_runtime import prompt_trials, readiness
    from app.api import graph as graph_api
    from app.services import oasis_profile_generator as profile_module
    from app.services import simulation_config_generator as config_module
    from app.services import zep_entity_reader as reader_module
    from app.utils import zep_lifecycle

    root, projects = tmp_path / 'simulations', tmp_path / 'projects'
    local = scenario != 'cloud'
    for name, value in {
        'LOCAL_MODE': local, 'MEMORY_BACKEND': 'local' if local else 'zep',
        'LOCAL_MAX_AGENTS': 2, 'LOCAL_MAX_ROUNDS': 1 if scenario.startswith('reuse') else 3,
        'LOCAL_MAX_CONCURRENCY': 1, 'LLM_API_KEY': 'fixture-local', 'ZEP_API_KEY': 'fixture-graph',
        'OASIS_SIMULATION_DATA_DIR': str(root), 'DEBUG': False,
    }.items():
        monkeypatch.setattr(Config, name, value)
    monkeypatch.setattr(SimulationManager, 'SIMULATION_DATA_DIR', str(root))
    monkeypatch.setattr(SimulationRunner, 'RUN_STATE_DIR', str(root))
    monkeypatch.setattr(ProjectManager, 'PROJECTS_DIR', str(projects))
    monkeypatch.setattr(TaskManager, '_instance', None)
    for name in ('_run_states', '_processes', '_monitor_threads', '_finalization_locks'):
        monkeypatch.setattr(SimulationRunner, name, {})
    monkeypatch.setattr(ZepGraphMemoryManager, '_updaters', {})
    monkeypatch.setattr(zep_lifecycle, '_graph_readers', {})
    monkeypatch.setattr(zep_lifecycle, '_graph_locks', {})
    monkeypatch.setattr(SimulationRunner, 'register_cleanup', lambda: None)
    monkeypatch.setattr(readiness, 'register_readiness_shutdown', lambda: None)
    monkeypatch.setattr(prompt_trials, 'register_prompt_trials_shutdown', lambda: None)
    monkeypatch.delenv('MIROFISH_LOCAL_GATEWAY_URL', raising=False)
    monkeypatch.setattr(local_runtime, '_gateway', None)
    monkeypatch.setattr(local_runtime, '_gateway_starting', None)
    monkeypatch.setattr(local_runtime, '_gateway_lock', threading.Lock())
    monkeypatch.setattr(SimulationRunner, 'check_env_alive', lambda *_a, **_k: False)
    monkeypatch.setattr(SimulationRunner, 'get_env_status_detail', lambda *_a, **_k: {})

    ids = [f'node_{index:02d}' for index in range(12)]
    nodes = [SimpleNamespace(uuid_=identifier, name=f'Person {index:02d} <literal>',
                             labels=['Entity', 'Person'], summary='Synthetic saved entity 雪', attributes={})
             for index, identifier in enumerate(ids)]
    calls = {'nodes': 0, 'edges': 0, 'profile': [], 'context': [], 'config': [], 'start': [], 'graph_view': 0}

    def graph_nodes(graph_id, **_kwargs):
        assert graph_id == 'graph_fixture'
        calls['nodes'] += 1
        return SimpleNamespace(data=nodes, headers={})

    def graph_edges(graph_id, **_kwargs):
        assert graph_id == 'graph_fixture'
        calls['edges'] += 1
        return SimpleNamespace(data=[], headers={})

    graph_client = SimpleNamespace(graph=SimpleNamespace(
        node=SimpleNamespace(with_raw_response=SimpleNamespace(get_by_graph_id=graph_nodes)),
        edge=SimpleNamespace(with_raw_response=SimpleNamespace(get_by_graph_id=graph_edges)),
    ))
    monkeypatch.setattr(reader_module, 'get_zep_client', lambda *_a, **_k: graph_client)
    monkeypatch.setattr(profile_module, 'get_zep_client', lambda *_a, **_k: graph_client)
    monkeypatch.setattr(profile_module, 'openai_client_options', lambda *_a, **_k: {})
    monkeypatch.setattr(config_module, 'openai_client_options', lambda *_a, **_k: {})

    def unexpected_model(*_a, **_k):
        raise AssertionError('Unexpected inference outside the explicit synthetic boundary')

    fake_openai = lambda **_kwargs: SimpleNamespace(chat=SimpleNamespace(
        completions=SimpleNamespace(create=unexpected_model)))
    monkeypatch.setattr(profile_module, 'OpenAI', fake_openai)
    monkeypatch.setattr(config_module, 'OpenAI', fake_openai)

    def profile_context(self, entity):
        calls['context'].append(entity.uuid)
        return 'Synthetic relationship context'

    def llm_profile(self, **kwargs):
        calls['profile'].append(kwargs['entity_name'])
        return {'bio': 'Synthetic LLM profile', 'persona': 'Synthetic persona', 'profession': 'Fixture'}

    monkeypatch.setattr(profile_module.OasisProfileGenerator, '_build_entity_context', profile_context)
    monkeypatch.setattr(profile_module.OasisProfileGenerator, '_generate_profile_with_llm', llm_profile)

    def parameters(simulation_id, selected):
        return SimulationParameters(
            simulation_id=simulation_id, project_id='proj_fixture', graph_id='graph_fixture',
            simulation_requirement='Synthetic discussion', time_config=TimeSimulationConfig(
                total_simulation_hours=2, minutes_per_round=30),
            agent_configs=[AgentActivityConfig(index, identifier, 'Synthetic person', 'Person')
                           for index, identifier in enumerate(selected)],
            reddit_config=PlatformConfig('reddit'), llm_model='synthetic-config-boundary',
            generation_reasoning='Generated at the explicit configuration boundary',
        )

    def generate_config(self, **kwargs):
        selected = [entity.uuid for entity in kwargs['entities']]
        calls['config'].append(selected)
        return parameters(kwargs['simulation_id'], selected)

    monkeypatch.setattr(SimulationConfigGenerator, 'generate_config', generate_config)

    def graph_view(_graph_id):
        calls['graph_view'] += 1
        return {'nodes': [], 'edges': []}

    monkeypatch.setattr(graph_api, 'GraphBuilderService', lambda **_kwargs: SimpleNamespace(get_graph_data=graph_view))

    def start(simulation_id, **kwargs):
        calls['start'].append({'simulation_id': simulation_id, **kwargs})
        maximum = kwargs.get('max_rounds')
        total = min(4, maximum) if maximum is not None else 4
        run = SimulationRunState(simulation_id=simulation_id, runner_status=RunnerStatus.COMPLETED,
                                 total_rounds=total, current_round=total)
        SimulationRunner._save_run_state(run)
        return run

    monkeypatch.setattr(SimulationRunner, 'start_simulation', start)
    project = Project('proj_fixture', 'Synthetic project', ProjectStatus.GRAPH_COMPLETED,
                      '2026-10-04T00:00:00', '2026-10-04T00:00:00',
                      graph_id='graph_fixture', simulation_requirement='Synthetic discussion')
    (projects / project.project_id).mkdir(parents=True)
    ProjectManager.save_project(project)
    (projects / project.project_id / 'extracted_text.txt').write_text('Synthetic document only.', encoding='utf-8')
    manager = SimulationManager()
    state = SimulationState('sim_fixture', project.project_id, project.graph_id,
                            enable_twitter=False, enable_reddit=True)
    if scenario.startswith('reuse'):
        state.status = SimulationStatus.FAILED if scenario == 'reuse_failed' else SimulationStatus.READY
        state.error = 'Previous simulation attempt failed' if scenario == 'reuse_failed' else None
        state.entities_count = state.profiles_count = 2
        state.profiles_generated = state.config_generated = True
        state.entity_types = ['Person']
    manager._save_simulation_state(state)
    folder = root / state.simulation_id
    if scenario.startswith('reuse'):
        (folder / 'simulation_config.json').write_text(parameters(state.simulation_id, ids[:2]).to_json(), encoding='utf-8')
        (folder / 'reddit_profiles.json').write_text(json.dumps([
            {'user_id': 0, 'name': 'Saved one'}, {'user_id': 1, 'name': 'Saved two'}]), encoding='utf-8')
    before = {path.name: path.read_bytes() for path in folder.iterdir()}
    observed = []
    app = create_app()

    @app.before_request
    def observe():
        from flask import jsonify, request
        observed.append((request.method, request.path))
        if (scenario.startswith('reuse_profile_') and request.path.endswith('/profiles/realtime')
                and sum(path.endswith('/profiles/realtime') for _method, path in observed) == 1):
            if scenario == 'reuse_profile_missing_data':
                return jsonify(success=True)
            return jsonify(success=False, error='Synthetic final profile read failure'), (
                503 if scenario == 'reuse_profile_outage' else 200)

    server = make_server('127.0.0.1', 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        process = subprocess.run([
            node, str(repo / 'frontend/tests/fixtures/local-preparation-backend-smoke.mjs'),
            f'http://127.0.0.1:{server.server_port}', scenario,
        ], cwd=repo / 'frontend', capture_output=True, text=True, timeout=60)
        assert process.returncode == 0, process.stdout + process.stderr
        assert 'actual local preparation workflow passed' in process.stdout
        assert len(calls['start']) == 1
        assert calls['start'][0]['max_rounds'] == (None if scenario == 'cloud' else 1 if scenario.startswith('reuse') else 2)
        assert sum(path == '/api/simulation/prepare' for _method, path in observed) == (2 if scenario.startswith('reuse_profile_') else 1)
        if scenario.startswith('reuse_profile_'):
            assert sum(path.endswith('/profiles/realtime') for _method, path in observed) == 2
            assert sum(path.endswith('/config/realtime') for _method, path in observed) == 1
        if scenario.startswith('reuse'):
            assert calls['nodes'] == calls['edges'] == 0
            assert calls['profile'] == calls['context'] == calls['config'] == []
            assert all((folder / name).read_bytes() == content for name, content in before.items()
                       if name != 'state.json')
        else:
            selected = ids if scenario == 'cloud' else ['node_02', 'node_11']
            assert calls['config'] == [selected]
            config = json.loads((folder / 'simulation_config.json').read_text())
            assert [item['entity_uuid'] for item in config['agent_configs']] == selected
            assert [item['agent_id'] for item in config['agent_configs']] == list(range(len(selected)))
            profiles = json.loads((folder / 'reddit_profiles.json').read_text())
            assert len(profiles) == len(selected)
            if scenario == 'template':
                assert calls['profile'] == calls['context'] == []
                assert calls['edges'] == 0
            else:
                assert len(calls['profile']) == len(calls['context']) == len(selected)
        assert local_runtime._gateway is None, 'Synthetic resource boundaries must not start a gateway'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)
        local_runtime.close_local_gateway()
    assert not thread.is_alive()
