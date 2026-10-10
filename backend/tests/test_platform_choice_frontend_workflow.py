"""Real Flask → production Axios → compiled Vue platform-choice workflows.

Storage, creation, local planning/preparation, profiles, status and report HTTP
routes are real. Graph data, model outputs, process startup and report inference
are explicit synthetic boundaries; this does not run OASIS or a model server.
"""

import csv
import json
from pathlib import Path
import shutil
import subprocess
import threading
import time
from types import SimpleNamespace

import pytest
from werkzeug.serving import make_server

from app import create_app
from app.config import Config
from app.models.project import Project, ProjectManager, ProjectStatus
from app.models.task import TaskManager
from app.services.report_agent import Report, ReportManager, ReportStatus
from app.services.simulation_config_generator import (
    AgentActivityConfig, PlatformConfig, SimulationConfigGenerator,
    SimulationParameters, TimeSimulationConfig,
)
from app.services.simulation_manager import SimulationManager, SimulationStatus
from app.services.simulation_runner import SimulationRunner, SimulationRunState, RunnerStatus
from app.services.zep_graph_memory_updater import ZepGraphMemoryManager


@pytest.mark.parametrize('platform', ['twitter', 'reddit', 'parallel'])
def test_platform_choice_real_flask_axios_vue_and_saved_artifacts(tmp_path, monkeypatch, platform):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    if node is None or not (repo / 'frontend/node_modules/vue/package.json').is_file():
        pytest.skip('Platform workflow requires Node and installed frontend dependencies')

    from app import local_runtime
    from app.local_runtime import prompt_trials, readiness
    from app.api import graph as graph_api, report as report_api
    from app.services import oasis_profile_generator as profile_module
    from app.services import simulation_config_generator as config_module
    from app.services import zep_entity_reader as reader_module
    from app.utils import zep_lifecycle

    root, projects, reports = (tmp_path / name for name in ('simulations', 'projects', 'reports'))
    enabled = ['twitter', 'reddit'] if platform == 'parallel' else [platform]
    flags = {'enable_twitter': 'twitter' in enabled, 'enable_reddit': 'reddit' in enabled}
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
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(reports))
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

    selected_ids = ['node_00', 'node_01']
    nodes = [SimpleNamespace(uuid_=identifier, name=f'Person {index}',
                             labels=['Entity', 'Person'], summary='Synthetic entity 雪', attributes={})
             for index, identifier in enumerate(selected_ids)]
    calls = {'nodes': 0, 'edges': 0, 'profile': [], 'context': [], 'config': [], 'start': [], 'report': []}

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
        return {'bio': 'Platform fixture bio 雪', 'persona': 'Platform fixture persona <literal>',
                'profession': 'Fixture', 'interested_topics': ['Synthetic topic']}

    monkeypatch.setattr(profile_module.OasisProfileGenerator, '_build_entity_context', profile_context)
    monkeypatch.setattr(profile_module.OasisProfileGenerator, '_generate_profile_with_llm', llm_profile)

    def generate_config(self, **kwargs):
        actual_flags = {name: kwargs[name] for name in flags}
        assert actual_flags == flags
        assert all(type(value) is bool for value in actual_flags.values())
        selected = [entity.uuid for entity in kwargs['entities']]
        calls['config'].append(selected)
        return SimulationParameters(
            simulation_id=kwargs['simulation_id'], project_id='proj_fixture', graph_id='graph_fixture',
            simulation_requirement='Synthetic discussion',
            time_config=TimeSimulationConfig(total_simulation_hours=2, minutes_per_round=30),
            agent_configs=[AgentActivityConfig(index, identifier, f'Person {index}', 'Person')
                           for index, identifier in enumerate(selected)],
            twitter_config=PlatformConfig('twitter') if flags['enable_twitter'] else None,
            reddit_config=PlatformConfig('reddit') if flags['enable_reddit'] else None,
            llm_model='synthetic-config-boundary', generation_reasoning='Synthetic model result',
        )

    monkeypatch.setattr(SimulationConfigGenerator, 'generate_config', generate_config)
    monkeypatch.setattr(graph_api, 'GraphBuilderService', lambda **_kwargs: SimpleNamespace(
        get_graph_data=lambda _graph_id: {'nodes': [], 'edges': []}))

    def start(simulation_id, **kwargs):
        # Isolate process/model ownership here. Runner script selection has a
        # separate direct-runner test; this checks the real HTTP resolution.
        calls['start'].append({'simulation_id': simulation_id, **kwargs})
        assert kwargs['platform'] == platform
        assert kwargs['max_rounds'] == 2
        saved = SimulationManager().get_simulation(simulation_id)
        assert saved.status == SimulationStatus.READY
        assert {name: getattr(saved, name) for name in flags} == flags
        for name in enabled:
            folder = root / simulation_id / name
            folder.mkdir()
            (folder / 'actions.jsonl').write_text(json.dumps({
                'round_num': 1, 'timestamp': '2026-10-05T00:00:00', 'agent_id': 0,
                'agent_name': 'Synthetic participant', 'action_type': 'CREATE_POST',
                'action_args': {'content': f'{name} synthetic action'}, 'success': True,
            }) + '\n', encoding='utf-8')
        run = SimulationRunState(simulation_id=simulation_id, runner_status=RunnerStatus.RUNNING,
                                 total_rounds=2, current_round=2,
                                 twitter_completed=True, reddit_completed=True)
        SimulationRunner._save_run_state(run)
        return run

    monkeypatch.setattr(SimulationRunner, 'start_simulation', start)

    class SyntheticReportAgent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def generate_report(self, *, progress_callback, report_id):
            calls['report'].append({'report_id': report_id, **self.kwargs})
            return Report(report_id=report_id, status=ReportStatus.COMPLETED,
                          markdown_content='Synthetic report model boundary', **self.kwargs)

    monkeypatch.setattr(report_api, 'ReportAgent', SyntheticReportAgent)
    project = Project('proj_fixture', 'Synthetic project', ProjectStatus.GRAPH_COMPLETED,
                      '2026-10-05T00:00:00', '2026-10-05T00:00:00',
                      graph_id='graph_fixture', simulation_requirement='Synthetic discussion')
    (projects / project.project_id).mkdir(parents=True)
    ProjectManager.save_project(project)
    (projects / project.project_id / 'extracted_text.txt').write_text('Synthetic document.', encoding='utf-8')
    observed, status_reads = [], 0
    app = create_app()

    @app.before_request
    def observe():
        nonlocal status_reads
        from flask import request
        # The bounded local planner deliberately reads request.stream itself.
        # Do not consume its body in instrumentation before production does.
        body = request.get_json(silent=True) if request.path in {
            '/api/simulation/create', '/api/simulation/start', '/api/report/generate',
        } else None
        observed.append((request.method, request.path, body))
        # Simulate process finalization in its persisted state. Status routes
        # and serializers remain production code, including absent mode data.
        if request.path.endswith('/run-status'):
            status_reads += 1
            if status_reads >= 3:
                run = SimulationRunner.get_run_state(request.view_args['simulation_id'])
                run.runner_status = RunnerStatus.COMPLETED
                SimulationRunner._save_run_state(run)

    server = make_server('127.0.0.1', 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        process = subprocess.run([
            node, str(repo / 'frontend/tests/fixtures/platform-choice-backend-smoke.mjs'),
            f'http://127.0.0.1:{server.server_port}', platform,
        ], cwd=repo / 'frontend', capture_output=True, text=True, timeout=60)
        assert process.returncode == 0, process.stdout + process.stderr
        assert 'actual platform choice workflow passed' in process.stdout
        assert len(calls['start']) == 1
        simulation_id = calls['start'][0]['simulation_id']
        folder = root / simulation_id
        assert calls['config'] == [selected_ids]
        assert len(calls['profile']) == len(calls['context']) == 2
        assert sorted(path.name for path in folder.glob('*profiles*')) == sorted(
            ['twitter_profiles.csv' if name == 'twitter' else 'reddit_profiles.json' for name in enabled])
        if flags['enable_twitter']:
            with (folder / 'twitter_profiles.csv').open(encoding='utf-8', newline='') as handle:
                rows = list(csv.DictReader(handle))
            assert len(rows) == 2
            assert rows[0]['description'] == 'Platform fixture bio 雪'
            assert 'Platform fixture persona <literal>' in rows[0]['user_char']
        if flags['enable_reddit']:
            rows = json.loads((folder / 'reddit_profiles.json').read_text())
            assert len(rows) == 2
            assert rows[0]['bio'] == 'Platform fixture bio 雪'
            assert rows[0]['persona'] == 'Platform fixture persona <literal>'
        config = json.loads((folder / 'simulation_config.json').read_text())
        assert [item['entity_uuid'] for item in config['agent_configs']] == selected_ids
        for name in ['twitter', 'reddit']:
            assert bool(config[name + '_config']) == (name in enabled)
        created = [body for method, path, body in observed if path == '/api/simulation/create']
        assert created == [{'project_id': project.project_id, 'graph_id': project.graph_id, **flags}]
        assert all(type(created[0][name]) is bool for name in flags)
        assert sum(path == '/api/simulation/prepare' for _, path, _ in observed) == 1
        assert sum(path == '/api/simulation/start' for _, path, _ in observed) == 1
        assert sum(path == '/api/report/generate' for _, path, _ in observed) == 1
        assert len(calls['report']) == 1
        assert calls['report'][0]['simulation_id'] == simulation_id
        saved_report = ReportManager.get_report(calls['report'][0]['report_id'])
        assert saved_report.status == ReportStatus.COMPLETED
        assert saved_report.markdown_content == 'Synthetic report model boundary'
        assert local_runtime._gateway is None, 'Synthetic boundaries must not start a model gateway'
    finally:
        # A report's model result is earlier than save/task/final lease cleanup.
        # Drain that actual ownership before monkeypatch and tmp_path teardown,
        # including when a later frontend assertion fails.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            tasks = TaskManager().list_tasks(task_type='report_generate')
            if all(task['status'] in {'completed', 'failed'} for task in tasks) and not zep_lifecycle.get_graph_readers('graph_fixture'):
                break
            time.sleep(0.01)
        assert all(task['status'] in {'completed', 'failed'} for task in tasks)
        assert not zep_lifecycle.get_graph_readers('graph_fixture')
        server.shutdown()
        server.server_close()
        thread.join(5)
        local_runtime.close_local_gateway()
    assert not thread.is_alive()


@pytest.mark.parametrize('platform,failing_platform', [
    ('twitter', None), ('reddit', None), ('parallel', None),
    ('parallel', 'reddit'), ('parallel', 'twitter'),
])
def test_actual_script_interviews_reach_vue_survey(tmp_path, monkeypatch, platform, failing_platform):
    """No fabricated response keys: HTTP executes real IPC/script/SQLite code."""
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    if node is None or not (repo / 'frontend/node_modules/vue/package.json').is_file():
        pytest.skip('Platform survey requires Node and installed frontend dependencies')
    from test_single_platform_interviews import make_single_environment, make_parallel_environment
    from app.services.oasis_profile_generator import OasisAgentProfile, OasisProfileGenerator
    from app.services.simulation_manager import SimulationState

    if platform == 'parallel':
        _, environments, client = make_parallel_environment(tmp_path, monkeypatch, failing_platform)
    else:
        _, environment, client = make_single_environment(tmp_path, monkeypatch, platform)
        environments = {platform: environment}
    monkeypatch.setattr(Config, 'OASIS_SIMULATION_DATA_DIR', str(tmp_path))
    state = SimulationState('sim_single', 'proj_fixture', 'graph_fixture',
                            enable_twitter=platform != 'reddit', enable_reddit=platform != 'twitter')
    SimulationManager()._save_simulation_state(state)
    profiles = [OasisAgentProfile(index, f'person_{index}', f'Person {index}',
                                  'Synthetic bio', 'Synthetic persona') for index in range(2)]
    # Invoke the actual canonical writer without constructing an inference client.
    writer = object.__new__(OasisProfileGenerator)
    for enabled_platform in environments:
        filename = 'twitter_profiles.csv' if enabled_platform == 'twitter' else 'reddit_profiles.json'
        writer.save_profiles(profiles, str(tmp_path / 'sim_single' / filename), platform=enabled_platform)
    server = make_server('127.0.0.1', 0, client.application, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        process = subprocess.run([
            node, str(repo / 'frontend/tests/fixtures/platform-choice-backend-smoke.mjs'),
            f'http://127.0.0.1:{server.server_port}', platform, 'survey', failing_platform or '',
        ], cwd=repo / 'frontend', capture_output=True, text=True, timeout=60)
        assert process.returncode == 0, process.stdout + process.stderr
        assert 'actual platform survey and saved export workflow passed' in process.stdout
        for environment in environments.values():
            assert len(environment.actions) == 1
            assert len(environment.actions[0]) == 2
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)
    assert not thread.is_alive()
