"""Installed-dependency fallback: real pure saved reader over synthetic local HTTP.

This deliberately does NOT claim Flask/API-route coverage. No application/model
imports, installations, provider calls, or existing storage are involved.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
from urllib.parse import parse_qs, urlsplit

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
SOURCE = Path(os.environ.get('MIRO_REPORT_FILES_SOURCE_ROOT', str(REPO)))
for name, directory in (('app', SOURCE / 'backend/app'), ('app.services', SOURCE / 'backend/app/services')):
    package = types.ModuleType(name)
    package.__path__ = [str(directory)]
    sys.modules[name] = package
reader = importlib.import_module('app.services.saved_reports')


def network_guard(event, args):
    if event in {'socket.connect', 'socket.bind'}:
        address = args[1]
        if not isinstance(address, tuple) or not ipaddress.ip_address(address[0]).is_loopback:
            raise AssertionError('Only disposable loopback test networking is permitted')
    if event == 'socket.getaddrinfo' and args[0] not in {'127.0.0.1', 'localhost'}:
        raise AssertionError('External DNS forbidden')


sys.addaudithook(network_guard)
mode = sys.argv[1]
assert mode in {'file', 'metadata', 'legacy', 'empty', 'unavailable'}
requests = []
with tempfile.TemporaryDirectory(prefix='miro-report-files-workflow-') as temporary:
    root = Path(temporary)
    old_body = '' if mode == 'empty' else '\ufeff# Earlier report\r\n\r\nCafé 雪 🐟 <script>literal</script>\rCR\nLF\r\n'

    def save(record_id, text, title, created):
        metadata = dict(report_id=record_id, simulation_id='Original <sim> Café 雪',
                        status='completed', created_at=created, completed_at='Recorded completion <tag>',
                        outline=dict(title=title, summary='Summary Café <tag>', sections=[]),
                        simulation_requirement='Literal [capital]+ requirement', markdown_content=text)
        folder = root / record_id
        folder.mkdir()
        (folder / 'meta.json').write_text(json.dumps(metadata), encoding='utf-8')
        (folder / 'full_report.md').write_bytes(text.encode('utf-8'))
        return metadata

    old = save('report_old', old_body, 'Earlier [capital]+ <literal>', '2026-02-01T12:00:00')
    save('report_new', 'Second Café 雪 🐟\n', 'Second literal <img src=x> report', '2026-03-01T12:00:00')
    body_path = root / 'report_old/full_report.md'
    if mode in {'metadata', 'legacy'}:
        body_path.unlink()
    elif mode == 'unavailable':
        body_path.write_bytes(b'\xffinvalid saved UTF-8')
    if mode == 'legacy':
        (root / 'report_old/meta.json').unlink()
        (root / 'report_old').rmdir()
        (root / 'report_old.json').write_text(json.dumps(old), encoding='utf-8')
        (root / 'report_old.md').write_bytes(old_body.encode('utf-8'))

    def inventory():
        return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in root.rglob('*') if path.is_file()}
    before = inventory()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            url = urlsplit(self.path)
            requests.append((self.command, url.path, self.headers.get('Accept-Language')))
            assert self.headers.get('Accept-Language') == 'en'
            query = {key: values[0] for key, values in parse_qs(url.query).items()}
            assert all(len(values) == 1 for values in parse_qs(url.query).values())
            if url.path == '/api/report/library/records':
                for key in ('offset', 'limit'):
                    if key in query:
                        query[key] = int(query[key])
                data = reader.list_saved_reports(str(root), **query)
            else:
                assert url.path in {'/api/report/library/records/report_old', '/api/report/library/records/report_new'}
                data = reader.read_saved_report(str(root), url.path.rsplit('/', 1)[1], **query)
            raw = (json.dumps({'success': True, 'data': data}, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run = subprocess.run(['node', str(REPO / 'frontend/tests/fixtures/saved-report-files-backend-smoke.mjs'),
                              f'http://127.0.0.1:{server.server_port}', mode], cwd=REPO / 'frontend',
                             capture_output=True, text=True, timeout=40)
        print(run.stdout, end='')
        print(run.stderr, end='', file=sys.stderr)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert inventory() == before, 'Saved source files changed'
    assert 'flask' not in sys.modules
    assert not any(name.startswith(('app.services.report_agent', 'app.services.simulation_', 'openai', 'oasis', 'camel')) for name in sys.modules)
    if run.returncode == 0:
        assert len(requests) >= 3, requests
        print(json.dumps({'mode': mode, 'source_root': str(SOURCE), 'transport': 'stdlib loopback HTTP; not Flask',
                          'requests': requests, 'source_files_unchanged': True, 'application_model_runtime_imports': False}))
    sys.exit(run.returncode)
