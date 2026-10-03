"""Complete report text files survive interrupted writes without partial readers."""

import builtins
import json
from pathlib import Path
from types import SimpleNamespace

from flask import Flask
import pytest

from app.services import report_agent as module
from app.services.report_agent import Report, ReportManager, ReportOutline, ReportSection, ReportStatus
from app.storage import StoragePathError
from app.utils import persistence
from test_project_report_storage import make_symlink


def report(text, requirement='Fixture'):
    return Report('report_fixture', 'sim_fixture', 'graph_fixture', requirement,
                  ReportStatus.COMPLETED, markdown_content=text, created_at='2026-01-01')


@pytest.fixture(params=['section', 'assembly', 'report'])
def snapshot(request, tmp_path, monkeypatch):
    from app.api.report import report_bp
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(tmp_path / 'reports'))
    kind = request.param
    ReportManager.save_report(report(''))
    app = Flask(__name__)
    app.register_blueprint(report_bp, url_prefix='/api/report')
    client = app.test_client()
    path = tmp_path / 'reports/report_fixture' / ('section_01.md' if kind == 'section' else 'full_report.md')

    def save(message):
        if kind == 'section':
            return ReportManager.save_section('report_fixture', 1, ReportSection('Overview', message))
        if kind == 'assembly':
            return ReportManager.assemble_full_report('report_fixture', ReportOutline(message, 'Summary', []))
        return ReportManager.save_report(report(message, requirement=message))

    def read():
        if kind == 'section':
            sections = ReportManager.get_generated_sections('report_fixture')
            return sections[0]['content'] if sections else None
        if not path.exists():
            return None  # Do not invoke the separate legacy reconstruction writer.
        response = client.get('/api/report/report_fixture/download')
        assert response.status_code == 200
        return response.data.decode('utf-8')

    save('Previous Café')
    return SimpleNamespace(path=path, previous=path.read_bytes(), save=save, read=read, kind=kind)


def intercept_text(monkeypatch, destination, *, write=None, close_error=None, create_error=None):
    """Exercise the same failure against old direct-open and new staged writes."""
    original_open = builtins.open
    original_temporary = persistence.tempfile.NamedTemporaryFile
    handles = []

    class Stream:
        def __init__(self, stream):
            self.stream = stream
        def __getattr__(self, name):
            return getattr(self.stream, name)
        def write(self, text):
            return write(self.stream, text) if write else self.stream.write(text)

    class Managed:
        def __init__(self, stream):
            self.stream = stream
            handles.append(stream)
        def __enter__(self):
            return Stream(self.stream.__enter__())
        def __exit__(self, *args):
            result = self.stream.__exit__(*args)
            if close_error:
                raise close_error
            return result

    def open_file(path, mode='r', *args, **kwargs):
        target = isinstance(path, (str, Path)) and Path(path) == destination and 'w' in mode
        if target and create_error:
            raise create_error
        stream = original_open(path, mode, *args, **kwargs)
        return Managed(stream) if target else stream

    def temporary(**kwargs):
        target = kwargs.get('prefix') == f'.{destination.name}.'
        if target and create_error:
            raise create_error
        stream = original_temporary(**kwargs)
        return Managed(stream) if target else stream

    monkeypatch.setattr(builtins, 'open', open_file)
    monkeypatch.setattr(persistence.tempfile, 'NamedTemporaryFile', temporary)
    return handles


@pytest.mark.parametrize('existing', [True, False])
def test_partial_write_preserves_previous_or_missing_text_for_actual_readers(snapshot, monkeypatch, existing):
    if not existing:
        snapshot.path.unlink()
    observed = []
    original_error = OSError('synthetic text write interruption')
    def interrupted(stream, text):
        stream.write(text[:9]); stream.flush()
        observed.append(snapshot.read())
        raise original_error
    with monkeypatch.context() as patch:
        handles = intercept_text(patch, snapshot.path, write=interrupted)
        with pytest.raises(OSError) as caught:
            snapshot.save('Updated 雪')
        assert caught.value is original_error
    assert all(handle.closed for handle in handles)
    assert observed == [snapshot.previous.decode('utf-8') if existing else None]
    if existing:
        assert snapshot.path.read_bytes() == snapshot.previous
    else:
        assert not snapshot.path.exists()
    assert not list(snapshot.path.parent.glob('*.tmp'))
    snapshot.save('Retry 雪')
    assert 'Retry 雪' in snapshot.read()


def test_successful_text_write_is_invisible_until_closed_replacement(snapshot, monkeypatch):
    observed = []
    def partial_then_complete(stream, text):
        first = text[:9]
        stream.write(first); stream.flush()
        observed.append(snapshot.read())
        return len(first) + stream.write(text[len(first):])
    handles = intercept_text(monkeypatch, snapshot.path, write=partial_then_complete)
    result = snapshot.save('Updated 雪\n\nLine two')
    assert observed == [snapshot.previous.decode('utf-8')]
    assert all(handle.closed for handle in handles)
    assert 'Updated 雪' in snapshot.read()
    if snapshot.kind == 'section':
        assert result == str(snapshot.path)
    elif snapshot.kind == 'assembly':
        assert result == snapshot.path.read_text(encoding='utf-8')
    else:
        assert result is None
    assert not list(snapshot.path.parent.glob('*.tmp'))


@pytest.mark.parametrize('failure', ['close', 'create', 'replace'])
def test_text_io_failure_preserves_previous_file_and_allows_retry(snapshot, monkeypatch, failure):
    error = OSError(f'synthetic text {failure} failure')
    with monkeypatch.context() as patch:
        handles = intercept_text(patch, snapshot.path,
                                 close_error=error if failure == 'close' else None,
                                 create_error=error if failure == 'create' else None)
        if failure == 'replace':
            replace = persistence.os.replace
            def fail_replace(source, destination):
                if Path(destination) == snapshot.path:
                    assert Path(source).parent == snapshot.path.parent
                    assert handles and handles[-1].closed
                    assert 'Updated' in Path(source).read_text(encoding='utf-8')
                    raise error
                return replace(source, destination)
            patch.setattr(persistence.os, 'replace', fail_replace)
        with pytest.raises(OSError) as caught:
            snapshot.save('Updated')
        assert caught.value is error
    assert all(handle.closed for handle in handles)
    assert snapshot.path.read_bytes() == snapshot.previous
    assert not list(snapshot.path.parent.glob('*.tmp'))
    snapshot.save('Retry')
    assert 'Retry' in snapshot.read()


def test_cleanup_failure_does_not_mask_original_text_error(snapshot, monkeypatch, caplog):
    error = OSError('original text error')
    def interrupted(stream, text):
        stream.write(text[:9])
        raise error
    unlink = persistence.os.unlink
    def refuse_cleanup(path, *args, **kwargs):
        if Path(path).name.startswith(f'.{snapshot.path.name}.') and str(path).endswith('.tmp'):
            raise PermissionError('synthetic denied text cleanup')
        return unlink(path, *args, **kwargs)
    module.logger.addHandler(caplog.handler)
    try:
        with monkeypatch.context() as patch:
            intercept_text(patch, snapshot.path, write=interrupted)
            patch.setattr(persistence.os, 'unlink', refuse_cleanup)
            with pytest.raises(OSError) as caught:
                snapshot.save('Updated')
            assert caught.value is error
    finally:
        module.logger.removeHandler(caplog.handler)
    assert snapshot.path.read_bytes() == snapshot.previous
    remaining = list(snapshot.path.parent.glob('*.tmp'))
    assert len(remaining) == 1
    assert 'temporary' in caplog.text.lower()
    remaining[0].unlink()


def test_target_alias_is_rejected_before_text_staging(snapshot, tmp_path, monkeypatch):
    outside = tmp_path / 'outside.md'
    snapshot.path.rename(outside)
    make_symlink(snapshot.path, outside)
    temporary = persistence.tempfile.NamedTemporaryFile
    def reject_text_stage(**kwargs):
        if kwargs.get('prefix') == f'.{snapshot.path.name}.':
            pytest.fail('unsafe Markdown path reached staging')
        return temporary(**kwargs)
    monkeypatch.setattr(persistence.tempfile, 'NamedTemporaryFile', reject_text_stage)
    with pytest.raises(StoragePathError):
        snapshot.save('Updated')
    assert outside.read_bytes() == snapshot.previous


def test_metadata_commit_before_markdown_failure_is_explicitly_not_rolled_back(tmp_path, monkeypatch):
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(tmp_path / 'reports'))
    ReportManager.save_report(report('# Previous', requirement='Previous metadata'))
    path = tmp_path / 'reports/report_fixture/full_report.md'
    previous = path.read_bytes()
    def fail(stream, text):
        stream.write('partial')
        raise OSError('Markdown unavailable')
    intercept_text(monkeypatch, path, write=fail)
    with pytest.raises(OSError, match='Markdown unavailable'):
        ReportManager.save_report(report('# New complete text', requirement='Updated metadata'))
    assert path.read_bytes() == previous
    loaded = ReportManager.get_report('report_fixture')
    assert loaded.simulation_requirement == 'Updated metadata'
    assert loaded.markdown_content == '# New complete text'
    assert json.loads((path.parent / 'meta.json').read_text())['markdown_content'] == '# New complete text'


def test_section_formatting_assembly_order_and_empty_save_behavior_remain(tmp_path, monkeypatch):
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(tmp_path / 'reports'))
    section = ReportSection('Overview', '## Overview\n\nBody Café 雪\n\n### Details\nMore')
    path = Path(ReportManager.save_section('report_fixture', 1, section))
    expected = '## Overview\n\nBody Café 雪\n\n**Details**\n\nMore\n\n'
    assert path.read_text(encoding='utf-8') == expected
    ReportManager.save_section('report_fixture', 2, ReportSection('Second', 'Last'))
    outline = ReportOutline('Report title', 'Summary', [section, ReportSection('Second')])
    assembled = ReportManager.assemble_full_report('report_fixture', outline)
    assert assembled.startswith('# Report title\n\n> Summary')
    assert assembled.index('## Overview') < assembled.index('## Second')
    assert '###' not in assembled
    final = path.parent / 'full_report.md'
    assert final.read_text(encoding='utf-8') == assembled
    ReportManager.save_report(report(''))
    assert final.read_text(encoding='utf-8') == assembled


def test_assembly_does_not_create_a_missing_report_directory(tmp_path, monkeypatch):
    root = tmp_path / 'reports'
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(root))
    with pytest.raises(FileNotFoundError):
        ReportManager.assemble_full_report('report_missing', ReportOutline('Title', 'Summary', []))
    assert not root.exists()
