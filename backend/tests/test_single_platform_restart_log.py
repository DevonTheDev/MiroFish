"""A restarted single environment cannot replay its previous completion log."""

import json
from types import SimpleNamespace

import pytest

from app.services import simulation_runner as module
from app.services.simulation_manager import SimulationStatus
from app.services.simulation_runner import SimulationRunner as Runner, RunnerStatus
from app.utils import persistence
from test_simulation_platform_selection import sandbox, ready  # noqa: F401


@pytest.mark.parametrize('platform', ['twitter', 'reddit'])
def test_single_restart_clears_old_events_before_child_and_monitor(sandbox, monkeypatch, platform):
    simulation_id, folder = ready(sandbox, platform == 'twitter', platform == 'reddit', SimulationStatus.COMPLETED)
    log = folder / platform / 'actions.jsonl'
    log.parent.mkdir()
    log.write_text(json.dumps({'event_type': 'simulation_end', 'total_rounds': 99}) + '\n')
    seen = []

    def spawn(*args, **kwargs):
        seen.append(log.read_bytes())
        assert seen[-1] == b'', 'The child must start against a fresh event stream'
        log.write_text(json.dumps({'event_type': 'round_end', 'round': 1, 'simulated_hours': .5}) + '\n')
        return SimpleNamespace(pid=12345, poll=lambda: None)

    class Monitor:
        def __init__(self, **kwargs):
            pass

        def is_alive(self):
            return False

        def start(self):
            pass  # Real monitor starts on another thread after admission releases.

    monkeypatch.setattr(module.subprocess, 'Popen', spawn)
    monkeypatch.setattr(module.threading, 'Thread', Monitor)
    response = sandbox.client.post('/api/simulation/start', json={'simulation_id': simulation_id, 'platform': 'auto'})
    assert response.status_code == 200, response.json
    assert seen == [b'']
    state = Runner.get_run_state(simulation_id)
    Runner._read_action_log(str(log), 0, state, platform)
    Runner._finalize_completed_platforms(state)
    assert state.runner_status == RunnerStatus.RUNNING
    assert state.current_round == 1
    assert not getattr(state, platform + '_completed')


@pytest.mark.parametrize('platform', ['twitter', 'reddit'])
def test_failed_event_reset_preserves_old_file_and_launches_nothing(sandbox, monkeypatch, platform):
    simulation_id, folder = ready(sandbox, platform == 'twitter', platform == 'reddit', SimulationStatus.COMPLETED)
    log = folder / platform / 'actions.jsonl'
    log.parent.mkdir()
    previous = b'{"event_type":"simulation_end","total_rounds":99}\n'
    log.write_bytes(previous)
    replace = persistence.os.replace
    calls = []

    def fail_reset(source, destination):
        if str(destination) == str(log):
            raise PermissionError('Synthetic event reset failure')
        return replace(source, destination)

    def spawn(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(pid=12345, poll=lambda: None)

    class Monitor:
        def __init__(self, **kwargs):
            pass
        def start(self):
            pass
        def is_alive(self):
            return False

    monkeypatch.setattr(persistence.os, 'replace', fail_reset)
    monkeypatch.setattr(module.subprocess, 'Popen', spawn)
    monkeypatch.setattr(module.threading, 'Thread', Monitor)
    response = sandbox.client.post('/api/simulation/start', json={'simulation_id': simulation_id, 'platform': 'auto'})
    assert response.status_code == 500, response.json
    assert calls == []
    assert log.read_bytes() == previous
    assert list(log.parent.glob('.actions.jsonl.*.tmp')) == []
    assert Runner.get_run_state(simulation_id).runner_status == RunnerStatus.FAILED
    assert simulation_id not in Runner._processes
    assert simulation_id not in Runner._monitor_threads
