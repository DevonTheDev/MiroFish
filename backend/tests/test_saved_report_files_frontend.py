"""Actual Flask → Axios → live Vue download → fresh local report-file reader.

Only the disposable loopback app is used. Runtime readers/providers are forbidden
by the existing saved_reports_client fixture; the file half permits no requests.
"""

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


@pytest.mark.parametrize('content_mode', ['file', 'metadata', 'legacy', 'empty', 'unavailable'])
def test_saved_report_observation_export_reopens_without_backend(saved_reports_client, content_mode):
    repo = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    if node is None or not (repo / 'frontend/node_modules/vue/package.json').is_file():
        pytest.skip('Report file workflow needs Node and installed frontend dependencies')
    client, root = saved_reports_client
    save_report('report_new', title='Second literal <img src=x> report', text='Second Café 雪 🐟\n',
                created_at='2026-03-01T12:00:00')
    body = '' if content_mode == 'empty' else '\ufeff# Earlier report\r\n\r\nCafé 雪 🐟 <script>literal</script>\rCR\nLF\r\n'
    old = save_report('report_old', title='Earlier [capital]+ <literal>', text=body,
                      created_at='2026-02-01T12:00:00')
    path = root / 'report_old/full_report.md'
    if content_mode in {'metadata', 'legacy'}:
        path.unlink()
    elif content_mode == 'empty':
        path.write_bytes(b'')
    elif content_mode == 'unavailable':
        path.write_bytes(b'\xffinvalid saved UTF-8')
    if content_mode == 'legacy':
        (root / 'report_old/meta.json').unlink()
        (root / 'report_old/outline.json').unlink()
        (root / 'report_old').rmdir()
        (root / 'report_old.json').write_text(json.dumps(old.to_dict()), encoding='utf-8')
        (root / 'report_old.md').write_bytes(body.encode('utf-8'))
    before, observed = inventory(root), []

    @client.application.before_request
    def record_request():
        observed.append((request.method, request.path, request.headers.get('Accept-Language')))

    server = make_server('127.0.0.1', 0, client.application, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run([
            node, str(repo / 'frontend/tests/fixtures/saved-report-files-backend-smoke.mjs'),
            f'http://127.0.0.1:{server.server_port}', content_mode,
        ], cwd=repo / 'frontend', capture_output=True, text=True, timeout=40)
        assert run.returncode == 0, run.stdout + run.stderr
        assert 'actual Axios/Vue report file round trip passed' in run.stdout
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert len(observed) >= 3, observed
    assert all(method == 'GET' and language == 'en' and path in {
        '/api/report/library/records', '/api/report/library/records/report_old',
        '/api/report/library/records/report_new',
    } for method, path, language in observed)
    assert inventory(root) == before
