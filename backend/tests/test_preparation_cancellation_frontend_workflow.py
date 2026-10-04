"""Real preparation cancellation across Flask, Axios, Vue and disposable files."""

import json
from pathlib import Path
import shutil
import subprocess
import threading
from types import SimpleNamespace

import pytest
from flask import jsonify, request
from werkzeug.serving import make_server

from app import create_app
from app.config import Config
from app.models.project import Project, ProjectManager, ProjectStatus
from app.models.task import TaskManager
from app.services.simulation_manager import SimulationManager, SimulationState
from app.services.simulation_runner import SimulationRunner
from app.services.zep_graph_memory_updater import ZepGraphMemoryManager
from app.services.simulation_config_generator import (
    AgentActivityConfig, PlatformConfig, SimulationConfigGenerator, SimulationParameters,
    TimeSimulationConfig,
)


@pytest.mark.parametrize('scenario', ['cancel', 'lost_response', 'finalizing'])
def test_actual_preparation_cancel_drain_and_finalization(tmp_path, monkeypatch, scenario):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    if node is None or not (repo / 'frontend/node_modules/vue/package.json').is_file():
        pytest.skip('Linked cancellation workflow requires Node and frontend dependencies')
    from app import local_runtime
    from app.local_runtime import prompt_trials, readiness
    from app.services import oasis_profile_generator as profile_module
    from app.services import preparation_cancellation as cancellation
    from app.services import simulation_config_generator as config_module
    from app.services import simulation_runner as runner_module
    from app.services import zep_entity_reader as reader_module
    from app.utils import zep_lifecycle

    root, projects = tmp_path / 'simulations', tmp_path / 'projects'
    for name, value in {
        'LOCAL_MODE': True, 'MEMORY_BACKEND': 'local', 'LOCAL_MAX_AGENTS': 2,
        'LOCAL_MAX_ROUNDS': 3, 'LOCAL_MAX_CONCURRENCY': 1,
        'LLM_API_KEY': 'fixture-local', 'ZEP_API_KEY': 'fixture-graph',
        'OASIS_SIMULATION_DATA_DIR': str(root), 'DEBUG': False,
    }.items():
        monkeypatch.setattr(Config, name, value)
    monkeypatch.setattr(SimulationManager, 'SIMULATION_DATA_DIR', str(root))
    monkeypatch.setattr(SimulationRunner, 'RUN_STATE_DIR', str(root))
    monkeypatch.setattr(ProjectManager, 'PROJECTS_DIR', str(projects))
    monkeypatch.setattr(TaskManager, '_instance', None)
    monkeypatch.setattr(cancellation, '_controllers', {})
    monkeypatch.setattr(cancellation, '_registry_lock', threading.RLock())
    for name in ('_run_states', '_processes', '_monitor_threads', '_finalization_locks'):
        monkeypatch.setattr(SimulationRunner, name, {})
    monkeypatch.setattr(ZepGraphMemoryManager, '_updaters', {})
    monkeypatch.setattr(zep_lifecycle, '_graph_readers', {})
    monkeypatch.setattr(zep_lifecycle, '_graph_locks', {})
    monkeypatch.setattr(SimulationRunner, 'register_cleanup', lambda: None)
    monkeypatch.setattr(readiness, 'register_readiness_shutdown', lambda: None)
    monkeypatch.setattr(prompt_trials, 'register_prompt_trials_shutdown', lambda: None)
    monkeypatch.setattr(SimulationRunner, 'check_env_alive', lambda *_a, **_k: False)
    monkeypatch.setattr(SimulationRunner, 'get_env_status_detail', lambda *_a, **_k: {})
    monkeypatch.delenv('MIROFISH_LOCAL_GATEWAY_URL', raising=False)
    monkeypatch.setattr(local_runtime, '_gateway', None)
    monkeypatch.setattr(local_runtime, '_gateway_starting', None)
    monkeypatch.setattr(local_runtime, '_gateway_lock', threading.Lock())

    def no_child(*_args, **_kwargs):
        raise AssertionError('Cancellation fixture must never launch an OASIS process')

    monkeypatch.setattr(runner_module, 'subprocess', SimpleNamespace(
        Popen=no_child, PIPE=subprocess.PIPE, TimeoutExpired=subprocess.TimeoutExpired,
    ))
    ids = ['node_a', 'node_b']
    nodes = [SimpleNamespace(uuid_=identifier, name=f'Person {identifier} <literal>',
                             labels=['Entity', 'Person'], summary='Synthetic person', attributes={})
             for identifier in ids]
    graph_client = SimpleNamespace(graph=SimpleNamespace(
        node=SimpleNamespace(with_raw_response=SimpleNamespace(
            get_by_graph_id=lambda *_a, **_k: SimpleNamespace(data=nodes, headers={}))),
        edge=SimpleNamespace(with_raw_response=SimpleNamespace(
            get_by_graph_id=lambda *_a, **_k: SimpleNamespace(data=[], headers={}))),
    ))
    monkeypatch.setattr(reader_module, 'get_zep_client', lambda *_a, **_k: graph_client)
    monkeypatch.setattr(profile_module, 'get_zep_client', lambda *_a, **_k: graph_client)
    monkeypatch.setattr(profile_module, 'openai_client_options', lambda *_a, **_k: {})
    monkeypatch.setattr(config_module, 'openai_client_options', lambda *_a, **_k: {})

    def no_inference(*_args, **_kwargs):
        raise AssertionError('Unexpected inference outside a synthetic boundary')

    fake_openai = lambda **_kwargs: SimpleNamespace(chat=SimpleNamespace(
        completions=SimpleNamespace(create=no_inference)))
    monkeypatch.setattr(profile_module, 'OpenAI', fake_openai)
    monkeypatch.setattr(config_module, 'OpenAI', fake_openai)
    monkeypatch.setattr(profile_module.OasisProfileGenerator, '_build_entity_context',
                        lambda *_a, **_k: 'Synthetic context')
    entered_profile, release_profile = threading.Event(), threading.Event()
    entered_final, release_final = threading.Event(), threading.Event()
    calls = {'profiles': [], 'config': 0}

    def llm_profile(self, **kwargs):
        calls['profiles'].append(kwargs['entity_name'])
        if len(calls['profiles']) == 1:
            entered_profile.set()
            assert release_profile.wait(20), 'Synthetic profile gate was not released'
        return {'bio': 'Synthetic profile', 'persona': 'Synthetic persona', 'profession': 'Fixture'}

    monkeypatch.setattr(profile_module.OasisProfileGenerator, '_generate_profile_with_llm', llm_profile)

    def generate_config(self, **kwargs):
        calls['config'] += 1
        return SimulationParameters(
            simulation_id=kwargs['simulation_id'], project_id='proj_fixture', graph_id='graph_fixture',
            simulation_requirement='Synthetic discussion', time_config=TimeSimulationConfig(
                total_simulation_hours=2, minutes_per_round=30),
            agent_configs=[AgentActivityConfig(index, entity.uuid, entity.name, 'Person')
                           for index, entity in enumerate(kwargs['entities'])],
            reddit_config=PlatformConfig('reddit'), llm_model='synthetic-fixture',
            generation_reasoning='Synthetic configuration boundary',
        )

    monkeypatch.setattr(SimulationConfigGenerator, 'generate_config', generate_config)
    real_prepare = SimulationManager.prepare_simulation

    def prepare(self, *args, **kwargs):
        if scenario == 'finalizing':
            close_admission = kwargs['begin_finalization']

            def finalization_gate():
                close_admission()
                entered_final.set()
                assert release_final.wait(20), 'Synthetic finalization gate was not released'

            kwargs['begin_finalization'] = finalization_gate
        return real_prepare(self, *args, **kwargs)

    monkeypatch.setattr(SimulationManager, 'prepare_simulation', prepare)
    project = Project('proj_fixture', 'Synthetic project', ProjectStatus.GRAPH_COMPLETED,
                      '2026-10-04T00:00:00', '2026-10-04T00:00:00',
                      graph_id='graph_fixture', simulation_requirement='Synthetic discussion')
    (projects / project.project_id).mkdir(parents=True)
    ProjectManager.save_project(project)
    (projects / project.project_id / 'extracted_text.txt').write_text('Synthetic document.', encoding='utf-8')
    manager = SimulationManager()
    manager._save_simulation_state(SimulationState('sim_fixture', project.project_id, project.graph_id,
                                                    enable_twitter=False, enable_reddit=True))
    folder = root / 'sim_fixture'
    sentinel = folder / 'actions.jsonl'
    sentinel.write_text('Preserved fixture evidence\n', encoding='utf-8')
    app = create_app()

    @app.get('/api/fixture/state')
    def fixture_state():
        return jsonify(success=True, data={'profile_entered': entered_profile.is_set(),
                                           'final_entered': entered_final.is_set(),
                                           'profiles': len(calls['profiles']), 'config': calls['config']})

    @app.post('/api/fixture/release')
    def fixture_release():
        unit = request.get_json()['unit']
        assert unit in {'profile', 'final'}
        (release_profile if unit == 'profile' else release_final).set()
        return jsonify(success=True, data={})

    server = make_server('127.0.0.1', 0, app, threaded=True)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    try:
        result = subprocess.run([
            node, str(repo / 'frontend/tests/fixtures/preparation-cancellation-backend-smoke.mjs'),
            f'http://127.0.0.1:{server.server_port}', scenario,
        ], cwd=repo / 'frontend', capture_output=True, text=True, timeout=65)
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'actual preparation cancellation workflow passed' in result.stdout
        state = json.loads((folder / 'state.json').read_text())
        if scenario == 'finalizing':
            assert state['status'] == 'ready' and state['config_generated'] is True
            assert len(calls['profiles']) == 2 and calls['config'] == 1
            assert not (folder / 'preparation_cancellation.json').exists()
        else:
            assert state['status'] != 'ready' and state['config_generated'] is False
            assert len(calls['profiles']) == 1 and calls['config'] == 0
            assert not (folder / 'simulation_config.json').exists()
            marker = json.loads((folder / 'preparation_cancellation.json').read_text())
            assert marker['phase'] == 'cancelled' and marker['simulation_id'] == 'sim_fixture'
        assert sentinel.read_text() == 'Preserved fixture evidence\n'
        assert local_runtime._gateway is None
    finally:
        release_profile.set()
        release_final.set()
        for worker in threading.enumerate():
            if worker.name == 'local-prepare-sim_fixture':
                worker.join(5)
                assert not worker.is_alive(), 'Preparation worker did not drain'
        server.shutdown()
        server.server_close()
        serving.join(5)
        local_runtime.close_local_gateway()
    assert not serving.is_alive()
