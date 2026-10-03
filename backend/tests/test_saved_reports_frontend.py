"""Actual saved reports through Flask, Axios and the compiled independent reader."""

import json
from pathlib import Path
import shutil
import subprocess
import threading

from flask import request
import pytest
from werkzeug.serving import make_server

from test_saved_reports_api import inventory, save_report
from test_saved_reports_api import saved_reports_client as saved_reports_client


@pytest.mark.parametrize('content_mode', ['file', 'metadata', 'empty', 'unavailable', 'legacy'])
def test_saved_report_library_http_browser_workflow(saved_reports_client, content_mode):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    if node is None or not (repo / 'frontend/node_modules/vue/package.json').is_file():
        pytest.skip('Saved report workflow needs Node and installed frontend dependencies')
    client, root = saved_reports_client
    save_report('report_new', title='Newest [capital]+ report', created_at='2026-03-01T12:00:00')
    text = '' if content_mode == 'empty' else '# Earlier report\r\n\r\nCafé 雪 🐟 <script>literal</script>\r\n'
    old = save_report('report_old', title='Earlier [capital]+ <literal>', text=text, created_at='2026-02-01T12:00:00')
    body = root / 'report_old/full_report.md'
    if content_mode in {'metadata', 'legacy'}:
        body.unlink()
    elif content_mode == 'empty':
        # An explicitly present empty file is a saved body, not missing data.
        body.write_bytes(b'')
    elif content_mode == 'unavailable':
        body.write_bytes(b'\xffinvalid saved UTF-8')
    if content_mode == 'legacy':
        (root / 'report_old/meta.json').unlink()
        (root / 'report_old/outline.json').unlink()
        (root / 'report_old').rmdir()
        (root / 'report_old.json').write_text(json.dumps(old.to_dict()), encoding='utf-8')
    control = old.to_dict()
    control.update(report_id='report_control', created_at='2026-01-01T12:00:00', simulation_requirement='Other scenario')
    control['outline'] = {'title': 'Separate control', 'summary': 'No matching phrase', 'sections': []}
    (root / 'report_control.json').write_text(json.dumps(control), encoding='utf-8')
    (root / 'report_broken.json').write_text('{broken', encoding='utf-8')
    before = inventory(root)
    observed = []

    @client.application.before_request
    def record_request():
        observed.append((request.method, request.path, request.headers.get('Accept-Language')))

    server = make_server('127.0.0.1', 0, client.application, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run([
            node, str(repo / 'frontend/tests/fixtures/saved-reports-backend-smoke.mjs'),
            f'http://127.0.0.1:{server.server_port}', content_mode,
        ], cwd=repo / 'frontend', capture_output=True, text=True, timeout=30)
        assert run.returncode == 0, run.stdout + run.stderr
        assert 'actual Flask/Axios/Vue saved report library passed' in run.stdout
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert len(observed) >= 4
    assert all(method == 'GET' and (path == '/api/report/library/records' or path == '/api/report/library/records/report_old')
               and language == 'en' for method, path, language in observed)
    assert inventory(root) == before
