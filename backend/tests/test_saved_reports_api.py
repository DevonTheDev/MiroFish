"""Saved reports use only guarded local files through the actual Flask routes."""

import hashlib
import json
from datetime import datetime

from flask import Flask
import pytest

from app.api import report as api
from app.services.report_agent import Report, ReportManager, ReportOutline, ReportStatus


def inventory(root):
    return {path.relative_to(root).as_posix(): path.read_bytes()
            for path in root.rglob('*') if path.is_file()}


def save_report(report_id, *, title='Saved capital report', status=ReportStatus.COMPLETED,
                text='# Saved report\r\n\r\nCafé 雪 🐟 <script>literal</script>\r\n',
                created_at='2026-01-01T12:00:00'):
    report = Report(
        report_id=report_id, simulation_id='sim_missing', graph_id='graph_missing',
        simulation_requirement='Inspect literal [capital]+ requirements', status=status,
        outline=ReportOutline(title=title, summary='Saved summary', sections=[]),
        markdown_content=text, created_at=created_at,
        completed_at='2026-01-01T12:01:00' if status == ReportStatus.COMPLETED else '',
    )
    ReportManager.save_report(report)
    return report


@pytest.fixture
def saved_reports_client(tmp_path, monkeypatch):
    root = tmp_path / 'reports'
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(root))

    def forbidden(*_args, **_kwargs):
        pytest.fail('Saved library reached a runtime or legacy report reader')

    for cls in (api.ReportAgent, api.SimulationManager, api.ZepGraphMemoryManager):
        monkeypatch.setattr(cls, '__init__', forbidden)
    for method in ('get_run_state', 'start_simulation', 'stop_simulation'):
        monkeypatch.setattr(api.SimulationRunner, method, forbidden)
    for method in ('get_report', 'list_reports', 'get_report_by_simulation'):
        monkeypatch.setattr(ReportManager, method, forbidden)
    app = Flask(__name__)
    app.json.ensure_ascii = False
    app.register_blueprint(api.report_bp, url_prefix='/api/report')
    return app.test_client(), root


def test_missing_library_is_empty_without_creation(saved_reports_client):
    client, root = saved_reports_client
    response = client.get('/api/report/library/records')
    assert response.status_code == 200, response.json
    assert response.json['data']['reports'] == []
    assert response.json['data']['matched_count'] == 0
    assert response.headers['Cache-Control'] == 'no-store'
    assert not root.exists()


def test_real_saved_reports_browse_and_capture_without_logs_simulation_or_graph(saved_reports_client):
    client, root = saved_reports_client
    old = save_report('report_old')
    save_report('report_new', title='New report', created_at='2026-02-01T12:00:00')
    before = inventory(root)
    response = client.get('/api/report/library/records?limit=1')
    assert response.status_code == 200, response.json
    page = response.json['data']
    assert page['matched_count'] == 2 and page['has_more'] is True
    assert page['reports'][0]['report_id'] == 'report_new'
    second = client.get('/api/report/library/records', query_string={
        'limit': 1, 'offset': 1, 'revision': page['source_revision'],
    })
    assert second.status_code == 200, second.json
    row = second.json['data']['reports'][0]
    assert row['report_id'] == old.report_id
    selected = client.get('/api/report/library/records/report_old', query_string={'revision': row['metadata_revision']})
    assert selected.status_code == 200, selected.json
    data = selected.json['data']
    raw = (root / 'report_old/full_report.md').read_bytes()
    assert data['content_available'] is True
    assert data['markdown_content'].encode('utf-8') == raw
    assert data['content_bytes'] == len(raw)
    assert data['content_revision'] == hashlib.sha256(raw).hexdigest()
    assert data['content_source'] == 'full_report.md'
    assert data['simulation_id'] == 'sim_missing'
    assert selected.headers['Cache-Control'] == 'no-store'
    assert str(root) not in selected.get_data(as_text=True)
    assert inventory(root) == before


@pytest.mark.parametrize('query', [
    'unknown=x', 'q=x&q=y', 'status=', 'status=running', 'offset=-1',
    'offset=1', 'limit=0', 'limit=51', 'limit=1.0', 'revision=wrong',
    'revision=' + 'A' * 64, 'q=' + 'x' * 201,
])
def test_invalid_list_queries_are_rejected_before_read(saved_reports_client, monkeypatch, query):
    client, root = saved_reports_client
    monkeypatch.setattr(api, 'list_saved_reports', lambda *_a, **_k: pytest.fail('invalid query reached storage'))
    response = client.get('/api/report/library/records?' + query)
    assert response.status_code == 400, response.json
    assert response.json['success'] is False and response.json['error_code'] == 'invalid_query'
    assert response.headers['Cache-Control'] == 'no-store'
    assert not root.exists()


@pytest.mark.parametrize('query', ['q=x', 'revision=', 'revision=x', 'revision=' + 'a' * 64 + '&revision=' + 'b' * 64])
def test_invalid_detail_queries_precede_reader(saved_reports_client, monkeypatch, query):
    client, root = saved_reports_client
    monkeypatch.setattr(api, 'read_saved_report', lambda *_a, **_k: pytest.fail('invalid query reached storage'))
    response = client.get('/api/report/library/records/report_missing?' + query)
    assert response.status_code == 400 and response.json['error_code'] == 'invalid_query'
    assert not root.exists()


@pytest.mark.parametrize('record_id', ['CON', 'report.bad', 'report%3Fbad', 'a' * 129])
def test_invalid_report_ids_return_safe_structured_error(saved_reports_client, record_id):
    client, root = saved_reports_client
    response = client.get('/api/report/library/records/' + record_id)
    assert response.status_code == 400, response.json
    assert response.json['error_code'] == 'invalid_report_id'
    assert str(root) not in response.get_data(as_text=True)
    assert not root.exists()


def test_metadata_replacement_conflicts_and_corrupt_entry_does_not_hide_healthy(saved_reports_client):
    client, root = saved_reports_client
    save_report('report_healthy')
    original = client.get('/api/report/library/records').json['data']
    row = original['reports'][0]
    path = root / 'report_healthy/meta.json'
    metadata = json.loads(path.read_text())
    metadata['outline']['title'] = 'Changed saved title'
    path.write_text(json.dumps(metadata), encoding='utf-8')
    conflict = client.get('/api/report/library/records/report_healthy', query_string={'revision': row['metadata_revision']})
    assert conflict.status_code == 409 and conflict.json['error_code'] == 'sources_changed'
    (root / 'report_broken.json').write_text('{broken', encoding='utf-8')
    before = inventory(root)
    result = client.get('/api/report/library/records').json['data']
    assert len(result['reports']) == 1 and result['reports'][0]['title'] == 'Changed saved title'
    assert result['unavailable_count'] == 1
    assert sum(item['count'] for item in result['unavailable_reasons']) == 1
    assert inventory(root) == before


def test_present_invalid_body_remains_unavailable_without_hidden_fallback(saved_reports_client):
    client, root = saved_reports_client
    save_report('report_saved', text='Embedded metadata is valid')
    (root / 'report_saved/full_report.md').write_bytes(b'\xffinvalid UTF8')
    before = inventory(root)
    response = client.get('/api/report/library/records/report_saved')
    assert response.status_code == 200, response.json
    data = response.json['data']
    assert data['content_available'] is False and data['content_error'] == 'unreadable'
    assert data['markdown_content'] is data['content_revision'] is data['content_bytes'] is None
    assert inventory(root) == before


@pytest.mark.parametrize('field', [
    'outline.title', 'outline.summary', 'simulation_requirement',
    'simulation_id', 'created_at', 'completed_at',
])
def test_non_utf8_metadata_string_does_not_break_healthy_unicode_catalog(saved_reports_client, field):
    client, root = saved_reports_client
    save_report('report_healthy', title='Healthy café 雪')
    damaged = save_report('report_damaged').to_dict()
    if '.' in field:
        first, second = field.split('.')
        damaged[first][second] = 'bad\ud800'
    else:
        damaged[field] = 'bad\ud800'
    (root / 'report_damaged/meta.json').write_text(json.dumps(damaged), encoding='utf-8')
    before = inventory(root)
    response = client.get('/api/report/library/records')
    assert response.status_code == 200, response.json
    data = response.json['data']
    assert [row['report_id'] for row in data['reports']] == ['report_healthy']
    assert data['reports'][0]['title'] == 'Healthy café 雪'
    assert data['unavailable_reasons'] == [{'code': 'metadata_unreadable', 'count': 1}]
    selected = client.get('/api/report/library/records/report_damaged')
    assert selected.status_code == 422 and selected.json['error_code'] == 'metadata_unavailable'
    assert inventory(root) == before


@pytest.mark.parametrize('detail', [False, True])
def test_unexpected_io_error_does_not_expose_paths(saved_reports_client, monkeypatch, detail):
    client, root = saved_reports_client

    def fail(*_args, **_kwargs):
        raise OSError(str(root / 'private-path-marker'))

    monkeypatch.setattr(api, 'read_saved_report' if detail else 'list_saved_reports', fail)
    response = client.get('/api/report/library/records' + ('/report_saved' if detail else ''))
    assert response.status_code == 500 and response.json['error_code'] == 'library_unavailable'
    assert str(root) not in response.get_data(as_text=True)
    assert 'private-path-marker' not in response.get_data(as_text=True)
    assert response.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('method', ['POST', 'PUT', 'PATCH', 'DELETE'])
@pytest.mark.parametrize('path', ['/api/report/library/records', '/api/report/library/records/report_saved'])
def test_library_routes_have_no_mutation_method(saved_reports_client, method, path):
    client, root = saved_reports_client
    response = client.open(path, method=method)
    assert response.status_code == 405
    assert not root.exists()


@pytest.mark.parametrize('path', ['/api/report/library/records', '/api/report/library/records/report_saved'])
def test_options_advertises_only_read_methods(saved_reports_client, path):
    client, root = saved_reports_client
    response = client.options(path)
    assert response.status_code == 200
    assert set(response.headers['Allow'].replace(' ', '').split(',')) == {'GET', 'HEAD', 'OPTIONS'}
    assert not root.exists()


def test_existing_report_named_library_keeps_its_original_routes(tmp_path, monkeypatch):
    root = tmp_path / 'reports'
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(root))
    report = save_report('library')
    app = Flask(__name__)
    app.register_blueprint(api.report_bp, url_prefix='/api/report')
    client = app.test_client()
    before = inventory(root)
    response = client.get('/api/report/library')
    assert response.status_code == 200 and response.json['data']['report_id'] == report.report_id
    download = client.get('/api/report/library/download')
    assert download.status_code == 200
    assert download.data == (root / 'library/full_report.md').read_bytes()
    download.close()
    selected = client.get('/api/report/library/records/library')
    assert selected.status_code == 200 and selected.json['data']['report_id'] == 'library'
    assert inventory(root) == before
    # This is the pre-existing explicit deletion API, using disposable records.
    assert client.delete('/api/report/library').status_code == 200
    assert not (root / 'library').exists()


@pytest.mark.parametrize('debug,ensure_ascii', [(False, False), (True, True)])
def test_utf8_envelope_budget_matches_actual_bytes_in_all_flask_modes(
    saved_reports_client, monkeypatch, debug, ensure_ascii,
):
    client, root = saved_reports_client
    client.application.debug = debug
    client.application.json.ensure_ascii = ensure_ascii
    class FixedClock:
        @staticmethod
        def now(tz):
            return datetime(2026, 1, 1, tzinfo=tz)
    monkeypatch.setattr(api.saved_reports, 'datetime', FixedClock)
    save_report('report_unicode', text='🐟' * 1000)
    response = client.get('/api/report/library/records/report_unicode')
    assert response.status_code == 200
    exact_bytes = len(response.data)
    assert b'\\ud83d' not in response.data
    assert response.json['data']['markdown_content'] == '🐟' * 1000
    monkeypatch.setattr(api.saved_reports, 'MAX_DETAIL_RESPONSE_BYTES', exact_bytes)
    accepted = client.get('/api/report/library/records/report_unicode')
    assert accepted.status_code == 200 and len(accepted.data) == exact_bytes
    monkeypatch.setattr(api.saved_reports, 'MAX_DETAIL_RESPONSE_BYTES', exact_bytes - 1)
    rejected = client.get('/api/report/library/records/report_unicode')
    assert rejected.status_code == 413 and rejected.json['error_code'] == 'response_too_large'
    assert (root / 'report_unicode/full_report.md').read_bytes() == ('🐟' * 1000).encode()


def test_final_api_byte_guard_rejects_oversized_service_result(saved_reports_client, monkeypatch):
    client, root = saved_reports_client
    monkeypatch.setattr(api, 'list_saved_reports', lambda *_a, **_k: {'text': 'x' * 400})
    monkeypatch.setattr(api.saved_reports, 'MAX_LIST_RESPONSE_BYTES', 200)
    response = client.get('/api/report/library/records')
    assert response.status_code == 413 and response.json['error_code'] == 'response_too_large'
    assert not root.exists()
