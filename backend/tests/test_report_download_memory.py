"""Metadata-only report downloads do not leave temporary Markdown files."""

import json
import tempfile

from flask import Flask
import pytest

from app.api import report as module
from app.services.report_agent import ReportManager
from test_project_report_storage import make_report, make_symlink


@pytest.fixture
def download(tmp_path, monkeypatch):
    reports = tmp_path / 'reports'
    reports.mkdir()
    scratch = tmp_path / 'download-temp'
    scratch.mkdir()
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(reports))
    monkeypatch.setattr(tempfile, 'tempdir', str(scratch))
    app = Flask(__name__)
    app.register_blueprint(module.report_bp, url_prefix='/api/report')
    return app.test_client(), reports, scratch


def metadata_only(reports, text, legacy=False):
    report = make_report()
    report.markdown_content = text
    if legacy:
        path = reports / 'report_fixture.json'
        path.write_text(json.dumps(report.to_dict()), encoding='utf-8')
    else:
        ReportManager.save_report(report)
        path = reports / 'report_fixture/meta.json'
        markdown = reports / 'report_fixture/full_report.md'
        if markdown.exists():
            markdown.unlink()
    return path


@pytest.mark.parametrize('legacy', [False, True])
@pytest.mark.parametrize('text', ['# Report\n\nComplete text\n', '# Café 雪 🐟\n', ''])
def test_repeated_metadata_downloads_keep_utf8_content_without_creating_files(download, legacy, text):
    client, reports, scratch = download
    metadata = metadata_only(reports, text, legacy)
    before = metadata.read_bytes()
    original_files = sorted(str(path.relative_to(reports)) for path in reports.rglob('*'))
    for _ in range(3):
        response = client.get('/api/report/report_fixture/download')
        assert response.status_code == 200
        assert response.data == text.encode('utf-8')
        assert response.headers['Content-Disposition'] == 'attachment; filename=report_fixture.md'
        assert response.mimetype == 'text/markdown'
        assert response.content_length == len(text.encode('utf-8'))
        response.close()
    assert list(scratch.iterdir()) == []
    assert metadata.read_bytes() == before
    assert sorted(str(path.relative_to(reports)) for path in reports.rglob('*')) == original_files


@pytest.mark.parametrize('method,headers,expected_status,expected', [
    ('HEAD', {}, 200, b''),
    ('GET', {'Range': 'bytes=2-5'}, 206, b'cdef'),
    # The existing broad API error handler maps an unsatisfiable range to 500.
    ('GET', {'Range': 'bytes=100-120'}, 500, None),
])
def test_metadata_download_retains_head_and_range_handling(download, method, headers, expected_status, expected):
    client, reports, scratch = download
    metadata_only(reports, 'abcdefghij')
    response = client.open('/api/report/report_fixture/download', method=method, headers=headers)
    assert response.status_code == expected_status
    if expected is not None:
        assert response.data == expected
    if expected_status == 206:
        assert response.headers['Content-Range'] == 'bytes 2-5/10'
    if method == 'HEAD':
        assert response.content_length == 10
    response.close()
    assert list(scratch.iterdir()) == []


def test_existing_markdown_file_keeps_precedence_over_embedded_metadata(download):
    client, reports, scratch = download
    metadata_only(reports, '# New metadata text')
    path = reports / 'report_fixture/full_report.md'
    path.write_text('# Existing file 雪', encoding='utf-8')
    response = client.get('/api/report/report_fixture/download')
    assert response.status_code == 200
    assert response.data == '# Existing file 雪'.encode('utf-8')
    response.close()
    assert path.read_text(encoding='utf-8') == '# Existing file 雪'
    assert list(scratch.iterdir()) == []


def test_failed_response_setup_leaves_no_temporary_file_and_can_retry(download, monkeypatch):
    client, reports, scratch = download
    metadata_only(reports, '# Report')
    with monkeypatch.context() as patch:
        def unavailable(*args, **kwargs):
            raise OSError('synthetic response setup error')
        patch.setattr(module, 'send_file', unavailable)
        response = client.get('/api/report/report_fixture/download')
        assert response.status_code == 500
        response.close()
    assert list(scratch.iterdir()) == []
    response = client.get('/api/report/report_fixture/download')
    assert response.status_code == 200
    assert response.data == b'# Report'
    response.close()


def test_missing_report_remains_404_without_created_storage(download):
    client, reports, scratch = download
    response = client.get('/api/report/report_missing/download')
    assert response.status_code == 404
    assert list(reports.iterdir()) == list(scratch.iterdir()) == []


def test_markdown_alias_is_rejected_instead_of_falling_back_to_metadata(download, tmp_path):
    client, reports, scratch = download
    metadata_only(reports, '# Safe metadata')
    outside = tmp_path / 'outside.md'
    outside.write_text('outside content')
    make_symlink(reports / 'report_fixture/full_report.md', outside)
    response = client.get('/api/report/report_fixture/download')
    assert response.status_code == 500
    assert b'outside content' not in response.data
    assert outside.read_text() == 'outside content'
    assert list(scratch.iterdir()) == []
