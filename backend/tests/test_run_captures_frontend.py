"""Persistent captures through actual Flask, Axios and compiled Vue on loopback."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import threading

from flask import request
import pytest
from werkzeug.serving import make_server

from app.api import simulation_bp
from test_run_captures_api import captures as captures
from test_simulation_comparison_api import saved as saved, inventory


@pytest.mark.parametrize('mode', ['complete', 'partial', 'lost-response', 'recovery'])
def test_actual_capture_rerun_compare_and_reopen_workflow(captures, mode):
    client, states, runs, root = captures
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    if node is None or not (repo / 'frontend/node_modules/vue/package.json').is_file():
        pytest.skip('Capture workflow needs Node and installed frontend dependencies')
    app = client.application
    app.register_blueprint(simulation_bp, url_prefix='/api/simulation')
    log = runs / 'sim_left/twitter/actions.jsonl'
    if mode == 'partial':
        with log.open('a') as stream:
            stream.write('{broken\n')
    observed = []

    @app.before_request
    def inspect_request():
        observed.append((request.method, request.path, request.headers.get('Accept-Language')))
        if request.path.startswith('/api/'):
            request.environ['capture_source_inventory'] = inventory(states), inventory(runs)

    @app.after_request
    def inspect_response(response):
        if request.path.startswith('/api/'):
            assert request.environ['capture_source_inventory'] == (inventory(states), inventory(runs))
        return response

    @app.post('/__test/rerun')
    def rerun():
        log.write_text('\n'.join(json.dumps({'agent_id': index, 'round': index // 2,
                                           'action_type': 'CREATE_POST', 'success': False})
                                 for index in range(5)) + '\n')
        return {'success': True}

    @app.post('/__test/remove-originals')
    def remove_originals():
        shutil.rmtree(states / 'sim_left')
        shutil.rmtree(runs / 'sim_left')
        return {'success': True}

    @app.post('/__test/crash-writer')
    def crash_writer():
        script = '''
import os, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA cache_size = 1')
connection.execute('BEGIN IMMEDIATE')
connection.execute('UPDATE captures SET payload = zeroblob(150000)')
os._exit(0)
'''
        result = subprocess.run([sys.executable, '-c', script, str(root / 'run_captures.sqlite3')],
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stdout + result.stderr
        return {'success': True}

    server = make_server('127.0.0.1', 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run([
            node, str(repo / 'frontend/tests/fixtures/run-captures-backend-smoke.mjs'),
            f'http://127.0.0.1:{server.server_port}', mode,
        ], cwd=repo / 'frontend', capture_output=True, text=True, timeout=45)
        assert run.returncode == 0, run.stdout + run.stderr
        assert 'actual Flask/Axios/Vue saved run captures passed' in run.stdout
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert not thread.is_alive()
    capture_posts = [(method, path) for method, path, _ in observed if method == 'POST' and path.startswith('/api/')]
    expected_posts = [('POST', '/api/run-captures/records/' + 'a' * 32),
                      ('POST', '/api/run-captures/records/' + 'b' * 32)]
    if mode == 'recovery':
        expected_posts.append(('POST', '/api/run-captures/recover'))
    assert capture_posts == expected_posts
    assert all(language == 'en' for _, path, language in observed if path.startswith('/api/'))
    assert root.is_dir()
    assert not (states / 'sim_left').exists()
    assert not (runs / 'sim_left').exists()
