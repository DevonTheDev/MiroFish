"""Report JSON readers retain complete snapshots during saves and failures."""

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace

from flask import Flask
import pytest

from app.services import report_agent as module
from app.services.report_agent import Report, ReportManager, ReportOutline, ReportSection, ReportStatus
from app.storage import StoragePathError


def report(message, *, outline=None, markdown=""):
    return Report("report_fixture", "sim_fixture", "graph_fixture", message,
                  ReportStatus.COMPLETED, outline=outline, markdown_content=markdown,
                  created_at="2026-01-01")


@pytest.fixture(params=["meta", "outline", "progress"])
def snapshot(request, tmp_path, monkeypatch):
    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(tmp_path / "reports"))
    kind = request.param
    path = tmp_path / "reports/report_fixture" / f"{kind}.json"

    def save(message):
        if kind == "meta":
            ReportManager.save_report(report(message))
        elif kind == "outline":
            ReportManager.save_outline("report_fixture", ReportOutline(message, "Summary", [ReportSection("Section")]))
        else:
            ReportManager.update_progress("report_fixture", "generating", 35, message,
                                          current_section="Section", completed_sections=["Introduction"])

    def read():
        if kind == "meta":
            return ReportManager.get_report("report_fixture").simulation_requirement
        if kind == "progress":
            return ReportManager.get_progress("report_fixture")["message"]
        return json.loads(path.read_text(encoding="utf-8"))["title"]

    save("Previous Café")
    return SimpleNamespace(path=path, previous=path.read_bytes(), save=save, read=read)


@pytest.mark.parametrize("existing", [True, False])
def test_unserializable_field_preserves_previous_or_missing_json(snapshot, existing):
    if not existing:
        snapshot.path.unlink()
    with pytest.raises(TypeError):
        snapshot.save({"not serializable"})
    if existing:
        assert snapshot.path.read_bytes() == snapshot.previous
        assert snapshot.read() == "Previous Café"
    else:
        assert not snapshot.path.exists()
    assert not list(snapshot.path.parent.glob("*.tmp"))
    snapshot.save("Updated 雪")
    assert snapshot.read() == "Updated 雪"


def test_reader_observes_last_complete_json_during_serialization(snapshot, monkeypatch):
    original = json.dump
    observations = []

    def serialize(payload, stream, **kwargs):
        stream.write(" ")
        stream.flush()
        observations.append(snapshot.read())
        assert snapshot.path.read_bytes() == snapshot.previous
        original(payload, stream, **kwargs)

    monkeypatch.setattr(json, "dump", serialize)
    snapshot.save("Updated 雪")
    assert observations == ["Previous Café"]
    assert snapshot.read() == "Updated 雪"
    assert "雪" in snapshot.path.read_text(encoding="utf-8")
    assert not list(snapshot.path.parent.glob("*.tmp"))


def test_failed_replace_preserves_previous_json_and_closes_staging(snapshot, monkeypatch):
    factory = tempfile.NamedTemporaryFile
    handles = []

    def create(**kwargs):
        handle = factory(**kwargs)
        handles.append(handle)
        return handle

    def refuse(source, destination):
        assert Path(source).parent == snapshot.path.parent
        assert Path(destination) == snapshot.path
        assert handles and handles[-1].closed
        assert "Updated" in Path(source).read_text(encoding="utf-8")
        raise PermissionError("report replace denied")

    with monkeypatch.context() as patch:
        patch.setattr(tempfile, "NamedTemporaryFile", create)
        patch.setattr(module.os, "replace", refuse)
        with pytest.raises(PermissionError, match="report replace denied"):
            snapshot.save("Updated")
    assert snapshot.path.read_bytes() == snapshot.previous
    assert snapshot.read() == "Previous Café"
    assert not list(snapshot.path.parent.glob("*.tmp"))
    snapshot.save("Retry")
    assert snapshot.read() == "Retry"


def test_path_guard_rejects_linked_json_before_staging(snapshot, tmp_path, monkeypatch):
    outside = tmp_path / "outside.json"
    snapshot.path.rename(outside)
    try:
        snapshot.path.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")

    def refuse_stage(**kwargs):
        pytest.fail("unsafe report path reached staging")

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", refuse_stage)
    with pytest.raises(StoragePathError):
        snapshot.save("Updated")
    assert outside.read_bytes() == snapshot.previous


def test_progress_endpoint_stays_readable_during_an_update(tmp_path, monkeypatch):
    from app.api.report import report_bp

    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(tmp_path / "reports"))
    ReportManager.update_progress("report_fixture", "generating", 20, "Previous")
    app = Flask(__name__)
    app.register_blueprint(report_bp, url_prefix="/api/report")
    client = app.test_client()
    original = json.dump
    observed = []

    def serialize(payload, stream, **kwargs):
        stream.write('{"status":')
        stream.flush()
        response = client.get("/api/report/report_fixture/progress")
        observed.append(response.status_code)
        assert response.status_code == 200
        assert response.json["data"]["progress"] == 20
        stream.seek(0)
        stream.truncate()
        original(payload, stream, **kwargs)

    monkeypatch.setattr(json, "dump", serialize)
    ReportManager.update_progress("report_fixture", "generating", 75, "Updated")
    assert observed == [200]
    assert client.get("/api/report/report_fixture/progress").json["data"]["progress"] == 75


def test_later_outline_failure_preserves_that_file_but_is_not_a_bundle_transaction(tmp_path, monkeypatch):
    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(tmp_path / "reports"))
    old = report("Previous", outline=ReportOutline("Old outline", "Summary", []), markdown="# Previous")
    ReportManager.save_report(old)
    folder = tmp_path / "reports/report_fixture"
    old_outline = (folder / "outline.json").read_bytes()
    original = json.dump

    def serialize(payload, stream, **kwargs):
        if payload.get("title") == "New outline":
            stream.write('{"partial":')
            raise OSError("outline interrupted")
        original(payload, stream, **kwargs)

    monkeypatch.setattr(json, "dump", serialize)
    incoming = report("Updated", outline=ReportOutline("New outline", "Summary", []), markdown="# Updated")
    with pytest.raises(OSError, match="outline interrupted"):
        ReportManager.save_report(incoming)
    assert ReportManager.get_report("report_fixture").simulation_requirement == "Updated"
    assert (folder / "outline.json").read_bytes() == old_outline
    assert (folder / "full_report.md").read_text() == "# Previous"
    assert not list(folder.glob("*.tmp"))
