"""Real pinned OASIS, CAMEL, loopback inference and SQLite failure contracts."""
import asyncio
import importlib
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'backend/tests'))

@pytest.mark.parametrize('platform', ['twitter', 'reddit', 'parallel'])
@pytest.mark.parametrize('outcome', ['model_error', 'valid_noop', 'valid_no_tool'])
def test_real_agent_failure_prevents_completion_and_valid_empty_results_complete(tmp_path, monkeypatch, platform, outcome):
    pytest.importorskip('camel')
    pytest.importorskip('oasis')
    from app.config import Config
    from app import local_runtime
    from app.services.simulation_runner import SimulationRunner, SimulationRunState, RunnerStatus
    from test_local_gateway import upstream_server

    monkeypatch.chdir(tmp_path)
    (tmp_path / 'log').mkdir()
    with upstream_server() as upstream:
        upstream.status = 404 if outcome == 'model_error' else 200
        upstream.body = {'error': {'message': 'Synthetic local model not found', 'type': 'invalid_request_error', 'code': 'model_not_found'}}
        if outcome == 'valid_noop':
            upstream.body = {'id':'synthetic','object':'chat.completion','created':1,'model':'synthetic-model',
                'choices':[{'index':0,'message':{'role':'assistant','content':None, 'tool_calls':[
                    {'id':'noop','type':'function','function':{'name':'do_nothing','arguments':'{}'}}]}, 'finish_reason':'tool_calls'}],
                'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}
        if outcome == 'valid_no_tool':
            upstream.body = {'id':'synthetic','object':'chat.completion','created':1,'model':'synthetic-model',
                'choices':[{'index':0,'message':{'role':'assistant','content':'I have no action to take.'},'finish_reason':'stop'}],
                'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}
        for field, value in {
            'MEMORY_BACKEND':'local', 'LOCAL_MODE':True, 'LLM_API_KEY':'local',
            'LLM_BASE_URL':upstream.url, 'LOCAL_EMBEDDING_BASE_URL':upstream.url,
            'LLM_MODEL_NAME':'synthetic-missing-model', 'LOCAL_REQUEST_TIMEOUT':5,
            'LOCAL_MAX_ROUNDS':1, 'LOCAL_MAX_CONCURRENCY':1,
        }.items():
            monkeypatch.setattr(Config, field, value)
        monkeypatch.delenv('MIROFISH_LOCAL_GATEWAY_URL', raising=False)
        local_runtime.configure_local_environment()
        script = importlib.import_module(f'scripts.run_{platform}_simulation')
        from oasis.social_agent.agent import SocialAgent
        original_action = SocialAgent.perform_action_by_llm
        action_returns = []
        async def observe_action(agent):
            result = await original_action(agent)
            action_returns.append(result)
            return result
        monkeypatch.setattr(SocialAgent, 'perform_action_by_llm', observe_action)
        models = []
        original_factory = script.create_local_model
        def capture_model():
            model = original_factory()
            models.append(model)
            return model
        monkeypatch.setattr(script, 'create_local_model', capture_model)
        monkeypatch.setattr(script, '_shutdown_event', None)
        folder = tmp_path / 'sim_audit'
        folder.mkdir()
        config = {
            'simulation_id':'sim_audit',
            'time_config': {'total_simulation_hours':1, 'minutes_per_round':60,
                'agents_per_hour_min':1, 'agents_per_hour_max':1,
                'peak_hours':[], 'off_peak_hours':[]},
            'agent_configs':[{'agent_id':0, 'entity_name':'Alice', 'activity_level':1.0, 'active_hours':[0]}],
            'event_config':{'initial_posts':[]},
        }
        path = folder / 'simulation_config.json'
        path.write_text(json.dumps(config))
        if platform in ('twitter', 'parallel'):
            (folder / 'twitter_profiles.csv').write_text('user_id,name,username,user_char,description\n0,Alice,alice,Enjoys books,Local synthetic agent\n')
        if platform in ('reddit', 'parallel'):
            (folder / 'reddit_profiles.json').write_text(json.dumps([{
                'user_id':0,'name':'Alice','username':'alice','persona':'Enjoys books',
                'bio':'Local synthetic agent','mbti':'INTJ','gender':'female','age':30,'country':'US'}]))
        platforms = ['twitter', 'reddit'] if platform == 'parallel' else [platform]
        if platform == 'parallel':
            monkeypatch.setattr(sys, 'argv', ['run_parallel_simulation.py', '--config',str(path),'--max-rounds','1','--no-wait'])
            run = script.main()
        else:
            runner = getattr(script, f'{platform.title()}SimulationRunner')(str(path), wait_for_commands=False)
            run = runner.run(max_rounds=1)
        try:
            if outcome == 'model_error':
                with pytest.raises(Exception, match='Local model server rejected the request'):
                    asyncio.run(run)
            else:
                asyncio.run(run)
            event_sets = {name:[json.loads(line) for line in (folder / name / 'actions.jsonl').read_text().splitlines()] for name in platforms}
            events = event_sets[platforms[0]]
            assert upstream.calls, 'The real agent must actually attempt inference'
            assert len(action_returns) == len(platforms)
            assert all(isinstance(item, BaseException) == (outcome == 'model_error') for item in action_returns)
            assert all(any(item.get('event_type') == 'simulation_end' for item in items) == (outcome != 'model_error') for items in event_sets.values())
            monkeypatch.setattr(SimulationRunner, 'RUN_STATE_DIR', str(tmp_path))
            monkeypatch.setattr(SimulationRunner, '_graph_memory_enabled', {})
            monkeypatch.setattr(SimulationRunner, '_finalization_locks', {})
            monkeypatch.setattr(SimulationRunner, '_run_states', {})
            state = SimulationRunState('sim_audit', runner_status=RunnerStatus.RUNNING, total_rounds=1)
            for name in platforms:
                setattr(state, f'{name}_running', True)
            for name in platforms:
                SimulationRunner._read_action_log(str(folder / name / 'actions.jsonl'), 0, state, name)
            SimulationRunner._finalize_completed_platforms(state)
            assert state.runner_status == (RunnerStatus.RUNNING if outcome == 'model_error' else RunnerStatus.COMPLETED)
        finally:
            for model in models:
                model._client.close()
                asyncio.run(model._async_client.close())
            local_runtime.close_local_gateway()


def write_simulation(folder):
    folder.mkdir()
    config = {
        'simulation_id': folder.name,
        'time_config': {'total_simulation_hours': 1, 'minutes_per_round': 60,
                        'agents_per_hour_min': 1, 'agents_per_hour_max': 1,
                        'peak_hours': [], 'off_peak_hours': []},
        'agent_configs': [{'agent_id': 0, 'entity_name': 'Alice',
                           'activity_level': 1.0, 'active_hours': [0]}],
        'event_config': {'initial_posts': []},
    }
    path = folder / 'simulation_config.json'
    path.write_text(json.dumps(config))
    (folder / 'twitter_profiles.csv').write_text(
        'user_id,name,username,user_char,description\n0,Alice,alice,Enjoys books,Local synthetic agent\n')
    (folder / 'reddit_profiles.json').write_text(json.dumps([{
        'user_id': 0, 'name': 'Alice', 'username': 'alice', 'persona': 'Enjoys books',
        'bio': 'Local synthetic agent', 'mbti': 'INTJ', 'gender': 'female', 'age': 30, 'country': 'US'}]))
    return path


@pytest.mark.parametrize('platform', ['twitter', 'reddit', 'parallel'])
def test_script_process_failure_reaches_real_monitor_as_failed(tmp_path, monkeypatch, platform):
    import os
    import subprocess
    from app.services.simulation_runner import SimulationRunner, SimulationRunState, RunnerStatus
    from test_local_gateway import upstream_server

    pytest.importorskip('oasis')
    folder = tmp_path / 'sim_subprocess'
    config = write_simulation(folder)
    with upstream_server() as upstream:
        upstream.status = 404
        upstream.body = {'error': {'message': 'Synthetic local model not found', 'code': 'model_not_found'}}
        env = dict(os.environ, MEMORY_BACKEND='local', LLM_API_KEY='local',
                   LLM_MODEL_NAME='synthetic-missing', LLM_BASE_URL=upstream.url,
                   LOCAL_EMBEDDING_BASE_URL=upstream.url, LOCAL_REQUEST_TIMEOUT='5',
                   LOCAL_MAX_ROUNDS='1', LOCAL_MAX_CONCURRENCY='1')
        env.pop('MIROFISH_LOCAL_GATEWAY_URL', None)
        with (folder / 'simulation.log').open('w') as output:
            process = subprocess.Popen(
                [sys.executable, str(REPO / 'backend/scripts' / f'run_{platform}_simulation.py'),
                 '--config', str(config), '--max-rounds', '1', '--no-wait'],
                cwd=tmp_path, env=env, stdout=output, stderr=subprocess.STDOUT)
            try:
                process.wait(timeout=40)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        assert upstream.calls, (folder / 'simulation.log').read_text()
        assert process.returncode != 0, (folder / 'simulation.log').read_text()
        selected = ['twitter', 'reddit'] if platform == 'parallel' else [platform]
        for name in selected:
            events = [json.loads(line) for line in (folder / name / 'actions.jsonl').read_text().splitlines()]
            assert not any(event.get('event_type') == 'simulation_end' for event in events)
        state = SimulationRunState(folder.name, runner_status=RunnerStatus.RUNNING, total_rounds=1)
        for name in selected:
            setattr(state, f'{name}_running', True)
        monkeypatch.setattr(SimulationRunner, 'RUN_STATE_DIR', str(tmp_path))
        monkeypatch.setattr(SimulationRunner, '_run_states', {folder.name: state})
        monkeypatch.setattr(SimulationRunner, '_processes', {folder.name: process})
        monkeypatch.setattr(SimulationRunner, '_manual_stop_requests', set())
        monkeypatch.setattr(SimulationRunner, '_graph_memory_enabled', {})
        monkeypatch.setattr(SimulationRunner, '_finalization_locks', {})
        monkeypatch.setattr(SimulationRunner, '_sync_simulation_status', lambda *args, **kwargs: None)
        SimulationRunner._monitor_simulation(folder.name)
        assert state.runner_status == RunnerStatus.FAILED
        assert str(process.returncode) in state.error
        assert not state.twitter_completed and not state.reddit_completed


def test_parallel_main_cancels_and_drains_peer_before_propagating_failure(tmp_path, monkeypatch):
    from types import SimpleNamespace
    pytest.importorskip('oasis')
    script = importlib.import_module('scripts.run_parallel_simulation')
    config = write_simulation(tmp_path / 'sim_parallel_cleanup')
    monkeypatch.setattr(sys, 'argv', ['run_parallel_simulation.py', '--config', str(config), '--no-wait'])
    events = []

    async def run():
        peer_started = asyncio.Event()

        async def fail(*args, **kwargs):
            await peer_started.wait()
            raise RuntimeError('Synthetic platform failure')

        async def peer(*args, **kwargs):
            peer_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0)
                events.append('peer closed')

        monkeypatch.setattr(script, 'run_twitter_simulation', fail)
        monkeypatch.setattr(script, 'run_reddit_simulation', peer)
        with pytest.raises(RuntimeError, match='Synthetic platform failure'):
            await script.main()
        assert events == ['peer closed']
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]

    asyncio.run(run())


@pytest.mark.parametrize('platform', ['twitter', 'reddit'])
@pytest.mark.parametrize('interrupted', [False, True])
def test_parallel_platform_failure_or_stop_never_publishes_completion(tmp_path, monkeypatch, platform, interrupted):
    from test_single_platform_progress import prepare_run, read_events
    run = prepare_run(tmp_path, monkeypatch, platform, seeds=False, active_rounds=(0, 1, 2),
                      fail_step=None if interrupted else 1, interrupt_step=1 if interrupted else None)
    parallel = importlib.import_module('scripts.run_parallel_simulation')
    monkeypatch.setattr(parallel, 'make_oasis_environment', lambda **kwargs: run.env)
    monkeypatch.setattr(parallel, 'create_model', lambda *args, **kwargs: object())
    monkeypatch.setattr(parallel, f'generate_{platform}_agent_graph',
                        getattr(run.script, f'generate_{platform}_agent_graph'))
    monkeypatch.setattr(parallel, 'platform_for_mode', run.script.platform_for_mode)
    monkeypatch.setattr(parallel, 'get_active_agents_for_round',
                        lambda env, config, hour, round_num: run.runner._get_active_agents_for_round(env, hour, round_num))
    monkeypatch.setattr(parallel, '_shutdown_event', run.script._shutdown_event)
    logger = parallel.PlatformActionLogger(platform, run.runner.simulation_dir)

    async def check():
        pending = getattr(parallel, f'run_{platform}_simulation')(
            run.runner.config, run.runner.simulation_dir, action_logger=logger, max_rounds=3)
        if interrupted:
            result = await pending
            assert not result.completed
            await result.env.close()
        else:
            with pytest.raises(RuntimeError, match='Synthetic environment step failed'):
                await pending
            assert run.env.closed
        assert not any(event.get('event_type') == 'simulation_end' for event in read_events(run))

    asyncio.run(check())


def test_successful_parallel_peer_closes_before_other_failure_is_published():
    from types import SimpleNamespace
    from scripts.oasis_runtime import gather_platforms
    closed = []

    class Env:
        async def close(self):
            await asyncio.sleep(0)
            closed.append(True)

    async def run():
        complete = asyncio.Event()
        async def succeed():
            complete.set()
            return SimpleNamespace(env=Env())
        async def fail():
            await complete.wait()
            await asyncio.sleep(0)
            raise RuntimeError('primary action error')
        with pytest.raises(RuntimeError, match='primary action error'):
            await gather_platforms(succeed(), fail())
        assert closed == [True]

    asyncio.run(run())


def test_repeated_cancellation_drains_environment_close_without_detaching():
    from scripts.oasis_runtime import close_environment

    async def run():
        started, release, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        class Env:
            async def close(self):
                started.set()
                await release.wait()
                closed.set()
        task = asyncio.create_task(close_environment(Env()))
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed.is_set()
        assert not [item for item in asyncio.all_tasks() if item is not asyncio.current_task() and not item.done()]

    asyncio.run(run())


def test_primary_action_error_survives_secondary_record_and_close_errors(caplog):
    from scripts.oasis_runtime import record_after_step, close_environment
    primary = RuntimeError('primary action error')
    class Env:
        async def step(self, actions):
            raise primary
        async def close(self):
            raise ValueError('secondary close failure')

    async def run():
        with pytest.raises(RuntimeError) as caught:
            try:
                async with record_after_step(Env(), {}):
                    raise ValueError('secondary trace failure')
            finally:
                await close_environment(Env(), failure=sys.exc_info()[1])
        assert caught.value is primary
    asyncio.run(run())
    assert 'secondary trace failure' in caplog.text
    assert 'secondary close failure' in caplog.text


@pytest.mark.parametrize('platform', ['twitter', 'reddit', 'parallel'])
def test_real_failed_round_keeps_late_successful_sibling_actions(tmp_path, monkeypatch, platform):
    """A real late tool call must persist and be logged before the failure escapes."""
    import sqlite3
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from app.config import Config
    from app import local_runtime
    pytest.importorskip('oasis')
    from oasis.social_agent.agent import SocialAgent

    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            failing = 'alice' in payload['messages'][0]['content'].lower()
            calls.append(failing)
            if failing:
                body = {'error': {'message': 'Synthetic model rejection', 'code': 'model_not_found'}}
            else:
                body = {'id': 'synthetic', 'object': 'chat.completion', 'created': 1, 'model': 'synthetic',
                    'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': None,
                        'tool_calls': [{'id': 'post', 'type': 'function', 'function': {
                            'name': 'create_post', 'arguments': '{"content":"Persisted after sibling failure"}'}}]},
                        'finish_reason': 'tool_calls'}],
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
            raw = json.dumps(body).encode()
            self.send_response(404 if failing else 200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
    thread.start()
    base_url = f'http://127.0.0.1:{server.server_port}/v1'
    for name, value in {'LOCAL_MODE': True, 'MEMORY_BACKEND': 'local', 'LLM_API_KEY': 'local',
                        'LLM_MODEL_NAME': 'synthetic', 'LLM_BASE_URL': base_url,
                        'LOCAL_EMBEDDING_BASE_URL': base_url, 'LOCAL_REQUEST_TIMEOUT': 5,
                        'LOCAL_MAX_ROUNDS': 1, 'LOCAL_MAX_CONCURRENCY': 2,
                        'LOCAL_MAX_AGENT_ITERATIONS': 1}.items():
        monkeypatch.setattr(Config, name, value)
    monkeypatch.delenv('MIROFISH_LOCAL_GATEWAY_URL', raising=False)
    local_runtime.configure_local_environment()
    script = importlib.import_module(f'scripts.run_{platform}_simulation')
    monkeypatch.setattr(script, '_shutdown_event', None)
    folder = tmp_path / 'sim_mixed'
    path = write_simulation(folder)
    config = json.loads(path.read_text())
    config['time_config'].update(agents_per_hour_min=2, agents_per_hour_max=2)
    config['agent_configs'].append({'agent_id': 1, 'entity_name': 'Bob', 'activity_level': 1.0, 'active_hours': [0]})
    path.write_text(json.dumps(config))
    with (folder / 'twitter_profiles.csv').open('a') as handle:
        handle.write('1,Bob,bob,Enjoys books,Local synthetic agent\n')
    profiles = json.loads((folder / 'reddit_profiles.json').read_text())
    profiles.append(dict(profiles[0], user_id=1, name='Bob', username='bob'))
    (folder / 'reddit_profiles.json').write_text(json.dumps(profiles))
    models, envs = [], []
    create_model, create_env = script.create_local_model, script.make_oasis_environment
    def capture_model():
        model = create_model()
        models.append(model)
        return model
    def capture_env(**kwargs):
        env = create_env(**kwargs)
        envs.append(env)
        return env
    monkeypatch.setattr(script, 'create_local_model', capture_model)
    monkeypatch.setattr(script, 'make_oasis_environment', capture_env)
    original_action = SocialAgent.perform_action_by_llm

    async def run():
        failed = asyncio.Event()
        async def delayed_action(agent):
            if agent.social_agent_id == 1:
                await failed.wait()
                await asyncio.sleep(0.02)
            result = await original_action(agent)
            if agent.social_agent_id == 0:
                assert isinstance(result, Exception)
                failed.set()
            return result
        monkeypatch.setattr(SocialAgent, 'perform_action_by_llm', delayed_action)
        with pytest.raises(Exception, match='Local model server rejected the request'):
            if platform == 'parallel':
                monkeypatch.setattr(sys, 'argv', ['run_parallel_simulation.py', '--config', str(path), '--max-rounds', '1', '--no-wait'])
                await script.main()
            else:
                runner = getattr(script, f'{platform.title()}SimulationRunner')(str(path), wait_for_commands=False)
                await runner.run(max_rounds=1)
        for env in envs:
            assert env.platform_task.done()
            with pytest.raises(sqlite3.ProgrammingError, match='closed database'):
                env.platform.db.execute('SELECT 1')
        selected = ['twitter', 'reddit'] if platform == 'parallel' else [platform]
        for name in selected:
            with sqlite3.connect(folder / f'{name}_simulation.db') as connection:
                assert connection.execute('SELECT content FROM post').fetchall() == [('Persisted after sibling failure',)]
            events = [json.loads(line) for line in (folder / name / 'actions.jsonl').read_text().splitlines()]
            assert any(item.get('action_type') == 'CREATE_POST' and item.get('round') == 1 for item in events)
            assert not any(item.get('event_type') in ('simulation_end', 'round_end') and item.get('round', 1) == 1 for item in events)
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]
        for model in models:
            model._client.close()
            await model._async_client.close()

    try:
        asyncio.run(run())
        assert any(calls) and not all(calls)
    finally:
        local_runtime.close_local_gateway()
        server.shutdown()
        server.server_close()
        thread.join(2)


@pytest.mark.parametrize('raise_error', [False, True])
def test_checked_step_settles_siblings_during_repeated_cancellation(tmp_path, monkeypatch, raise_error):
    from app.config import Config
    from app.local_runtime.oasis import platform_for_mode
    from scripts.oasis_runtime import make_oasis_environment
    oasis = pytest.importorskip('oasis')
    monkeypatch.setattr(Config, 'LOCAL_MODE', True)

    async def run():
        started, release, settled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        class Failed:
            async def perform_action_by_llm(self):
                error = RuntimeError('failed sibling')
                if raise_error:
                    raise error
                return error
        class Slow:
            async def perform_action_by_llm(self):
                started.set()
                await release.wait()
                settled.set()
        db_path = str(tmp_path / 'step.db')
        env = make_oasis_environment(agent_graph=oasis.AgentGraph(),
                                    platform=platform_for_mode('twitter', db_path),
                                    database_path=db_path, semaphore=2)
        await env.reset()
        task = asyncio.create_task(env.step({Failed(): oasis.LLMAction(), Slow(): oasis.LLMAction()}))
        try:
            await started.wait()
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert settled.is_set()
        finally:
            release.set()
            await env.close()
        assert not [item for item in asyncio.all_tasks() if item is not asyncio.current_task() and not item.done()]

    asyncio.run(run())


@pytest.mark.parametrize('flags,expected', [([], ['twitter', 'reddit']),
                                          (['--twitter-only', '--reddit-only'], ['twitter'])])
def test_parallel_persistent_completion_publishes_after_ipc_ready(tmp_path, monkeypatch, flags, expected):
    from types import SimpleNamespace
    pytest.importorskip('oasis')
    script = importlib.import_module('scripts.run_parallel_simulation')
    path = write_simulation(tmp_path / 'sim_ready')
    monkeypatch.setattr(sys, 'argv', ['run_parallel_simulation.py', '--config', str(path), *flags])
    called, closed, markers = [], [], []
    class Env:
        def __init__(self, platform):
            self.platform = platform
        async def close(self):
            closed.append(self.platform)
    def make_run(platform):
        async def run(*args, **kwargs):
            called.append(platform)
            assert kwargs['publish_completion'] is False
            return SimpleNamespace(env=Env(platform), agent_graph=object(), completed=True,
                                   total_actions=0, total_rounds=1)
        return run
    monkeypatch.setattr(script, 'run_twitter_simulation', make_run('twitter'))
    monkeypatch.setattr(script, 'run_reddit_simulation', make_run('reddit'))
    original_end = script.PlatformActionLogger.log_simulation_end
    def publish(logger, *args):
        assert json.loads((path.parent / 'env_status.json').read_text())['status'] == 'alive'
        markers.append(True)
        original_end(logger, *args)
    monkeypatch.setattr(script.PlatformActionLogger, 'log_simulation_end', publish)
    async def finish(_handler):
        return False
    monkeypatch.setattr(script.ParallelIPCHandler, 'process_commands', finish)
    asyncio.run(script.main())
    assert called == expected
    assert closed == expected
    assert len(markers) == len(expected)
    assert json.loads((path.parent / 'env_status.json').read_text())['status'] == 'stopped'


def test_parallel_unexpected_incomplete_result_fails_after_peer_cleanup(tmp_path, monkeypatch):
    from types import SimpleNamespace
    pytest.importorskip('oasis')
    script = importlib.import_module('scripts.run_parallel_simulation')
    path = write_simulation(tmp_path / 'sim_incomplete')
    monkeypatch.setattr(sys, 'argv', ['run_parallel_simulation.py', '--config', str(path), '--no-wait'])
    closed = []
    class Env:
        async def close(self):
            closed.append(True)
    async def incomplete(*args, **kwargs):
        return script.PlatformSimulation()
    async def complete(*args, **kwargs):
        return SimpleNamespace(env=Env(), agent_graph=object(), completed=True, total_rounds=1, total_actions=0)
    monkeypatch.setattr(script, 'run_twitter_simulation', incomplete)
    monkeypatch.setattr(script, 'run_reddit_simulation', complete)
    with pytest.raises(RuntimeError, match='did not complete'):
        asyncio.run(script.main())
    assert closed == [True]
    for name in ('twitter', 'reddit'):
        events = (path.parent / name / 'actions.jsonl')
        assert not events.exists() or 'simulation_end' not in events.read_text()
