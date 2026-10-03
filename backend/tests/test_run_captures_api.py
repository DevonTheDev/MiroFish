"""Actual local capture endpoints over disposable saved logs and SQLite."""

import json
from pathlib import Path
import subprocess
import sys

from flask import Flask
import pytest

from app.api import run_captures as api
from test_simulation_comparison_api import saved as saved, inventory


@pytest.fixture
def captures(saved, tmp_path):
    _client, states, runs = saved
    app = Flask(__name__)
    app.config['UPLOAD_FOLDER'] = str(tmp_path / 'uploads')
    app.register_blueprint(api.run_captures_bp, url_prefix='/api/run-captures')
    return app.test_client(), states, runs, tmp_path / 'uploads' / 'run_captures'


def body_for(client, label='First saved experiment', simulation_id='sim_left'):
    response = client.get('/api/run-captures/preview', query_string={'simulation_id': simulation_id})
    assert response.status_code == 200, response.json
    return {'simulation_id': simulation_id, 'source_revision': response.json['data']['source_revision'],
            'label': label, 'note': 'Observed result only\nNo quality conclusion.'}


def test_save_repeat_run_capture_and_compare_survive_original_source_deletion(captures):
    client, states, runs, root = captures
    first_id, second_id = 'a' * 32, 'b' * 32
    before = inventory(states), inventory(runs)
    first_body = body_for(client)
    first = client.post('/api/run-captures/records/' + first_id, json=first_body)
    assert first.status_code == 201, first.json
    assert (inventory(states), inventory(runs)) == before
    assert first.json['data']['observation']['summary']['metrics']['recorded_actions'] == 2
    assert 'SYNTHETIC_PRIVATE_MARKER' not in first.get_data(as_text=True)
    assert first.headers['Cache-Control'] == 'no-store'

    log = runs / 'sim_left/twitter/actions.jsonl'
    with log.open('a') as stream:
        stream.write(json.dumps({'agent_id': 8, 'round': 3, 'action_type': 'LIKE_POST'}) + '\n')
    stale = client.post('/api/run-captures/records/' + second_id, json=first_body)
    assert stale.status_code == 409
    assert stale.json['error_code'] == 'sources_changed'
    second_body = body_for(client, 'Second saved experiment')
    second = client.post('/api/run-captures/records/' + second_id, json=second_body)
    assert second.status_code == 201, second.json
    for folder in (states / 'sim_left', runs / 'sim_left'):
        for file in folder.rglob('*'):
            if file.is_file():
                file.unlink()

    replay = client.post('/api/run-captures/records/' + first_id, json=first_body)
    assert replay.status_code == 200, replay.json
    assert replay.json == first.json
    compare = client.get('/api/run-captures/compare', query_string={'left': first_id, 'right': second_id})
    assert compare.status_code == 200, compare.json
    data = compare.json['data']
    assert data['left']['capture_id'] == first_id
    assert data['right']['capture_id'] == second_id
    assert data['left']['observation']['summary']['simulation_id'] == data['right']['observation']['summary']['simulation_id']
    assert data['differences']['recorded_actions'] == 1
    assert data['differences']['platforms']['reddit']['recorded_actions'] is None
    listing = client.get('/api/run-captures/records?limit=1').json['data']
    assert listing['total'] == 2 and listing['has_more'] is True
    assert len(listing['captures']) == 1
    assert root.is_dir()


def test_absent_capture_gets_never_create_storage(captures):
    client, _states, _runs, root = captures
    response = client.get('/api/run-captures/records')
    assert response.status_code == 200, response.json
    assert response.json['data']['captures'] == []
    assert response.json['data']['total'] == 0
    assert client.get('/api/run-captures/records/' + 'a' * 32).status_code == 404
    assert client.get('/api/run-captures/compare?left=' + 'a' * 32 + '&right=' + 'b' * 32).status_code == 404
    assert not root.parent.exists()


@pytest.mark.parametrize('path', [
    '/records?offset=-1', '/records?offset=501', '/records?limit=0', '/records?limit=51',
    '/records?limit=1&limit=2', '/records?unknown=x', '/records?offset=' + '9' * 100,
    '/preview', '/preview?simulation_id=sim_left&simulation_id=sim_right', '/preview?simulation_id=sim_left&key=x',
    '/records/' + 'a' * 31, '/records/' + 'A' * 32, '/records/' + 'a' * 32 + '?key=x',
    '/compare?left=' + 'a' * 32 + '&right=' + 'a' * 32,
    '/compare?left=' + 'a' * 32, '/compare?left=x&right=y',
    '/compare?left=' + 'a' * 32 + '&right=' + 'b' * 32 + '&right=' + 'c' * 32,
])
def test_bad_query_is_rejected_before_storage(captures, monkeypatch, path):
    client, _states, _runs, root = captures
    def forbidden(*args, **kwargs):
        pytest.fail('Invalid query reached service/storage')
    for method in ('list_run_captures', 'get_run_capture', 'compare_run_captures', 'preview_saved_run'):
        monkeypatch.setattr(api.service, method, forbidden)
    response = client.get('/api/run-captures' + path)
    assert response.status_code == 400
    assert response.json['error_code'] == 'invalid_request'
    assert not root.parent.exists()


@pytest.mark.parametrize('raw,content_type', [
    ('{}', 'text/plain'), ('{}', 'application/json'), ('[]', 'application/json'),
    ('{"simulation_id":"sim_left","source_revision":"x","label":"A","note":"", "label":"B"}', 'application/json'),
    ('{"simulation_id":"sim_left","source_revision":"x","label":"A","note":"", "extra":1}', 'application/json'),
    ('{"simulation_id":"sim_left","source_revision":"x","label":"A","note":NaN}', 'application/json'),
    ('{"simulation_id":"sim_left","source_revision":"x","label":"A","note":1e999}', 'application/json'),
    ('{"simulation_id":"sim_left","source_revision":"x","label":"A"}', 'application/json'),
    ('"' + 'x' * (api.MAX_REQUEST_BYTES + 1) + '"', 'application/json'),
    (b'\xff', 'application/json'),
])
def test_post_body_boundary_rejects_before_core(captures, monkeypatch, raw, content_type):
    client, _states, _runs, root = captures
    monkeypatch.setattr(api.service, 'create_run_capture', lambda *a, **kw: pytest.fail('Invalid body reached core'))
    response = client.post('/api/run-captures/records/' + 'a' * 32, data=raw, content_type=content_type)
    assert response.status_code == 400
    assert response.json['error_code'] == 'invalid_request'
    assert not root.parent.exists()


def test_post_query_and_invalid_id_do_not_read_body_or_core(captures, monkeypatch):
    client, _states, _runs, root = captures
    monkeypatch.setattr(api.service, 'create_run_capture', lambda *a, **kw: pytest.fail('Invalid request reached core'))
    for suffix in ('bad-id', 'a' * 32 + '?extra=1'):
        assert client.post('/api/run-captures/records/' + suffix, json={}).status_code == 400
    assert not root.parent.exists()


def test_safe_error_responses_and_no_mutation_methods(captures, monkeypatch):
    client, _states, _runs, root = captures
    def fail(*args, **kwargs):
        raise OSError('/private/path SYNTHETIC_SECRET')
    monkeypatch.setattr(api.service, 'list_run_captures', fail)
    response = client.get('/api/run-captures/records')
    assert response.status_code == 500 and response.headers['Cache-Control'] == 'no-store'
    assert '/private/path' not in response.get_data(as_text=True)
    assert 'SYNTHETIC_SECRET' not in response.get_data(as_text=True)
    for method in ('put', 'patch', 'delete'):
        assert getattr(client, method)('/api/run-captures/records/' + 'a' * 32).status_code == 405
    assert not root.parent.exists()


def test_surrogate_escaped_saved_context_has_valid_ascii_json(captures):
    client, states, _runs, _root = captures
    path = states / 'sim_left/simulation_config.json'
    path.write_text(json.dumps({'simulation_requirement': 'legacy \ud800 text'}))
    response = client.get('/api/run-captures/preview?simulation_id=sim_left')
    assert response.status_code == 200, response.json
    assert response.get_data().isascii()
    assert response.json['data']['summary']['scenario'] == 'legacy \ud800 text'


def test_app_factory_registers_capture_routes_and_skips_body_logging(captures, monkeypatch):
    from app import create_app
    from app.config import Config
    from app.services.simulation_runner import SimulationRunner
    import app as app_module
    from types import SimpleNamespace
    seen = []
    monkeypatch.setattr(SimulationRunner, 'register_cleanup', lambda: None)
    monkeypatch.setattr(Config, 'LOCAL_MODE', False)
    fake = SimpleNamespace(debug=lambda value: seen.append(value), info=lambda *a: None)
    monkeypatch.setattr(app_module, 'get_logger', lambda *a: fake)
    app = create_app()
    app.config['UPLOAD_FOLDER'] = str(Path(captures[3]).parent)
    result = app.test_client().post('/api/run-captures/records/' + 'a' * 32, json={'label': 'SYNTHETIC_PRIVATE_NOTE'})
    assert result.status_code == 400
    assert any('/api/run-captures/records/' in item for item in seen)
    assert all('SYNTHETIC_PRIVATE_NOTE' not in item for item in seen)


@pytest.mark.parametrize('path,raw,content_type', [
    ('/recover', 'null', 'application/json'), ('/recover', '[]', 'application/json'),
    ('/recover', '{"path":"elsewhere"}', 'application/json'),
    ('/recover', '{}', 'text/plain'), ('/recover?force=true', '{}', 'application/json'),
])
def test_recovery_requires_explicit_empty_json_before_storage(captures, monkeypatch, path, raw, content_type):
    client, _states, _runs, root = captures
    monkeypatch.setattr(api.service, 'recover_run_captures', lambda *a: pytest.fail('Invalid recovery reached storage'))
    response = client.post('/api/run-captures' + path, data=raw, content_type=content_type)
    assert response.status_code == 400
    assert not root.parent.exists()


def test_recovery_of_absent_store_never_creates_files(captures):
    client, _states, _runs, root = captures
    response = client.post('/api/run-captures/recover', json={})
    assert response.status_code == 200, response.json
    assert response.json == {'success': True, 'data': {'recovered': False}}
    assert not root.parent.exists()
    assert client.get('/api/run-captures/recover').status_code == 405


def test_explicit_recovery_restores_committed_capture_after_crashed_transaction(captures):
    client, states, runs, root = captures
    capture_id = 'a' * 32
    first = client.post('/api/run-captures/records/' + capture_id, json=body_for(client))
    assert first.status_code == 201, first.json
    # Crash only a disposable writer after dirty pages have spilled; the normal
    # SQLite rollback journal, rather than a synthetic exception, drives recovery.
    script = '''
import os, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA cache_size = 1')
connection.execute('BEGIN IMMEDIATE')
connection.execute('UPDATE captures SET payload = zeroblob(150000)')
os._exit(0)
'''
    run = subprocess.run([sys.executable, '-c', script, str(root / 'run_captures.sqlite3')],
                         capture_output=True, text=True, timeout=10)
    assert run.returncode == 0, run.stdout + run.stderr
    before = inventory(root), inventory(states), inventory(runs)
    response = client.get('/api/run-captures/records/' + capture_id)
    assert response.status_code == 503, response.json
    assert response.json['error_code'] == 'capture_recovery_required'
    assert (inventory(root), inventory(states), inventory(runs)) == before
    response = client.post('/api/run-captures/recover', json={})
    assert response.status_code == 200, response.json
    assert response.json['data'] == {'recovered': True}
    assert client.get('/api/run-captures/records/' + capture_id).json == first.json
    assert (inventory(states), inventory(runs)) == before[1:]
    after = inventory(root)
    response = client.post('/api/run-captures/recover', json={})
    assert response.status_code == 200 and response.json['data'] == {'recovered': False}
    assert inventory(root) == after
