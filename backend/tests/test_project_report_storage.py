"""Project/report persistence boundaries, using only disposable fixture storage."""

import io
import json
import logging
from pathlib import Path
import shutil

from flask import Flask
import pytest
from werkzeug.datastructures import FileStorage

from app.models.project import ProjectManager
from app.storage import StoragePathError, storage_path, validate_record_id
from app.services.report_agent import (
    Report,
    ReportConsoleLogger,
    ReportLogger,
    ReportManager,
    ReportOutline,
    ReportSection,
    ReportStatus,
)


def make_symlink(link, target, *, target_is_directory=False):
    try:
        link.symlink_to(target, target_is_directory=target_is_directory)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")


@pytest.fixture
def storage(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    reports = tmp_path / "reports"
    projects.mkdir()
    reports.mkdir()
    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(projects))
    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(reports))
    return projects, reports


def make_report(report_id="report_fixture"):
    return Report(
        report_id,
        "sim_fixture",
        "graph_fixture",
        "test requirement",
        ReportStatus.COMPLETED,
        created_at="2026-01-01",
    )


@pytest.mark.parametrize(
    "record_id",
    [
        "",
        ".",
        "..",
        "../outside",
        r"..\outside",
        "/outside",
        "C:\\outside",
        "record:stream",
        "record.",
        "CON",
        "lpt1",
        "x" * 129,
    ],
)
@pytest.mark.parametrize("manager", [ProjectManager, ReportManager])
def test_invalid_deletion_never_reaches_filesystem(
    storage, monkeypatch, manager, record_id
):
    # Never execute malformed deletes, even on the vulnerable baseline.
    mutations = []
    monkeypatch.setattr(shutil, "rmtree", lambda path: mutations.append(path))
    monkeypatch.setattr("os.remove", lambda path: mutations.append(path))
    delete = (
        manager.delete_project if manager is ProjectManager else manager.delete_report
    )
    with pytest.raises(StoragePathError):
        delete(record_id)
    assert mutations == []


@pytest.mark.parametrize("manager", [ProjectManager, ReportManager])
@pytest.mark.parametrize("target_kind", ["outside", "sibling", "missing"])
def test_record_directory_alias_is_rejected(
    storage, tmp_path, monkeypatch, manager, target_kind
):
    root = storage[manager is ReportManager]
    target = tmp_path / "outside" if target_kind == "outside" else root / "real_record"
    if target_kind != "missing":
        target.mkdir()
    make_symlink(root / "linked_record", target, target_is_directory=True)
    mutations = []
    monkeypatch.setattr(shutil, "rmtree", lambda path: mutations.append(path))
    delete = (
        manager.delete_project if manager is ProjectManager else manager.delete_report
    )
    with pytest.raises(StoragePathError):
        delete("linked_record")
    assert mutations == []


@pytest.mark.parametrize("filename", ["project.json", "extracted_text.txt", "files"])
def test_project_child_alias_is_rejected(storage, tmp_path, filename):
    projects, _ = storage
    project = ProjectManager.create_project()
    target = tmp_path / "external"
    target.write_text("fixture data")
    child = projects / project.project_id / filename
    if child.is_dir():
        child.rmdir()
    elif child.exists():
        child.unlink()
    make_symlink(child, target)
    operation = {
        "project.json": ProjectManager.get_project,
        "extracted_text.txt": ProjectManager.get_extracted_text,
        "files": ProjectManager.get_project_files,
    }[filename]
    with pytest.raises(StoragePathError):
        operation(project.project_id)
    assert target.read_text() == "fixture data"


@pytest.mark.parametrize(
    "filename,getter",
    [
        ("meta.json", ReportManager._get_report_path),
        ("full_report.md", ReportManager._get_report_markdown_path),
        ("outline.json", ReportManager._get_outline_path),
        ("progress.json", ReportManager._get_progress_path),
        ("agent_log.jsonl", ReportManager._get_agent_log_path),
        ("console_log.txt", ReportManager._get_console_log_path),
    ],
)
def test_report_file_alias_is_rejected(storage, tmp_path, filename, getter):
    _, reports = storage
    report = make_report()
    ReportManager.save_report(report)
    target = tmp_path / "external"
    target.write_text("fixture data")
    child = reports / report.report_id / filename
    child.unlink(missing_ok=True)
    make_symlink(child, target)
    with pytest.raises(StoragePathError):
        getter(report.report_id)
    assert target.read_text() == "fixture data"


def test_legacy_report_alias_is_rejected_before_any_delete(storage, tmp_path):
    _, reports = storage
    report = make_report()
    legacy = reports / f"{report.report_id}.json"
    legacy.write_text(json.dumps(report.to_dict()))
    external = tmp_path / "external.md"
    external.write_text("keep")
    make_symlink(reports / f"{report.report_id}.md", external)
    with pytest.raises(StoragePathError):
        ReportManager.delete_report(report.report_id)
    assert legacy.exists()
    assert external.read_text() == "keep"


def test_project_roundtrip_upload_listing_and_delete(storage, tmp_path):
    projects, _ = storage
    project = ProjectManager.create_project("fixture")
    uploaded = ProjectManager.save_file_to_project(
        project.project_id, FileStorage(stream=io.BytesIO(b"hello")), "notes.TXT"
    )
    ProjectManager.save_extracted_text(project.project_id, "hello world")
    assert ProjectManager.get_project(project.project_id).name == "fixture"
    assert ProjectManager.get_extracted_text(project.project_id) == "hello world"
    assert uploaded["original_filename"] == "notes.TXT"
    assert Path(uploaded["path"]).read_bytes() == b"hello"
    assert uploaded["saved_filename"].endswith(".txt")
    external = tmp_path / "external.txt"
    external.write_text("outside")
    make_symlink(projects / project.project_id / "files" / "linked.txt", external)
    make_symlink(
        projects / "alias", projects / project.project_id, target_is_directory=True
    )
    (projects / ".DS_Store").write_text("unrelated")
    assert ProjectManager.get_project_files(project.project_id) == [uploaded["path"]]
    assert [p.project_id for p in ProjectManager.list_projects()] == [
        project.project_id
    ]
    assert ProjectManager.delete_project(project.project_id) is True
    assert ProjectManager.delete_project(project.project_id) is False
    assert external.read_text() == "outside"


def test_report_roundtrip_and_legacy_listing(storage, tmp_path):
    _, reports = storage
    report = make_report()
    section = ReportSection("Findings", "Fixture content")
    report.outline = ReportOutline("Report", "Summary", [section])
    ReportManager.save_report(report)
    ReportManager.save_section(report.report_id, 1, section)
    external = tmp_path / "external.md"
    external.write_text("outside")
    make_symlink(reports / report.report_id / "section_02.md", external)
    (reports / report.report_id / "section_notes.md").write_text("unrelated")
    assert [
        s["section_index"]
        for s in ReportManager.get_generated_sections(report.report_id)
    ] == [1]
    text = ReportManager.assemble_full_report(report.report_id, report.outline)
    assert "Fixture content" in text and "outside" not in text
    assert ReportManager.get_report(report.report_id).markdown_content == text
    ReportManager.update_progress(report.report_id, "completed", 100, "done")
    assert ReportManager.get_progress(report.report_id)["progress"] == 100
    legacy = make_report("report_legacy")
    legacy.simulation_id = "sim_legacy"
    (reports / "report_legacy.json").write_text(json.dumps(legacy.to_dict()))
    (reports / "report_legacy.md").write_text("legacy")
    make_symlink(
        reports / "alias", reports / report.report_id, target_is_directory=True
    )
    (reports / ".DS_Store").write_text("unrelated")
    assert {r.report_id for r in ReportManager.list_reports()} == {
        report.report_id,
        legacy.report_id,
    }
    assert (
        ReportManager.get_report_by_simulation("sim_legacy").report_id
        == legacy.report_id
    )
    assert ReportManager.delete_report(report.report_id) is True
    assert ReportManager.delete_report(legacy.report_id) is True
    assert ReportManager.delete_report(legacy.report_id) is False
    assert external.read_text() == "outside"


def test_report_loggers_use_manager_root(storage):
    _, reports = storage
    record_id = "report_logs"
    structured = ReportLogger(record_id)
    structured.log("fixture", "testing", {})
    console = ReportConsoleLogger(record_id)
    try:
        logging.getLogger("mirofish.report_agent").warning("console fixture")
    finally:
        console.close()
    assert Path(structured.log_file_path).parent == reports / record_id
    assert ReportManager.get_agent_log(record_id)["logs"][0]["action"] == "fixture"
    assert "console fixture" in "\n".join(
        ReportManager.get_console_log(record_id)["logs"]
    )


@pytest.mark.parametrize(
    "filename", ["file.txt:stream", "file.bad\\path", "file.txt.", "file.txt\x00"]
)
def test_upload_extension_must_remain_a_portable_file_component(storage, filename):
    project = ProjectManager.create_project()
    with pytest.raises(StoragePathError):
        ProjectManager.save_file_to_project(
            project.project_id, FileStorage(stream=io.BytesIO(b"hello")), filename
        )
    assert ProjectManager.get_project_files(project.project_id) == []


@pytest.mark.parametrize(
    "prefix,record_id",
    [
        ("graph/project", ".."),
        ("report", ".."),
        ("graph/project", "CON"),
        ("report", "CON"),
    ],
)
def test_invalid_delete_routes_return_client_error(
    storage, monkeypatch, prefix, record_id
):
    from app.api import graph_bp, report_bp

    mutations = []
    monkeypatch.setattr(shutil, "rmtree", lambda path: mutations.append(path))
    app = Flask(__name__)
    app.register_blueprint(graph_bp, url_prefix="/api/graph")
    app.register_blueprint(report_bp, url_prefix="/api/report")
    response = app.test_client().delete(f"/api/{prefix}/{record_id}")
    assert response.status_code == 400
    assert response.json["success"] is False
    assert "traceback" not in response.json
    assert mutations == []


@pytest.mark.parametrize("record_id", [None, 3, True, [], {}, "white space", "é"])
def test_record_ids_reject_non_strings_and_nonportable_characters(record_id):
    with pytest.raises(StoragePathError):
        validate_record_id(record_id)


@pytest.mark.parametrize(
    "component",
    [
        "",
        ".",
        "..",
        "/absolute",
        "a/b",
        r"a\b",
        "a:stream",
        "NUL.txt",
        "COM1.log",
        "trailing ",
        "trailing.",
        "bad\nname",
        "bad?name",
    ],
)
def test_storage_child_components_are_portable(tmp_path, component):
    with pytest.raises(StoragePathError):
        storage_path(str(tmp_path), component)


def test_configured_root_may_be_relocated_with_a_symlink(
    storage, tmp_path, monkeypatch
):
    projects, reports = storage
    for manager, attribute, target in [
        (ProjectManager, "PROJECTS_DIR", projects),
        (ReportManager, "REPORTS_DIR", reports),
    ]:
        alias = tmp_path / (attribute + "_alias")
        make_symlink(alias, target, target_is_directory=True)
        monkeypatch.setattr(manager, attribute, str(alias))
    project = ProjectManager.create_project()
    report = make_report()
    ReportManager.save_report(report)
    assert (
        ProjectManager.get_project(project.project_id).project_id == project.project_id
    )
    assert ReportManager.get_report(report.report_id).report_id == report.report_id
    assert Path(ProjectManager._get_project_dir(project.project_id)).parent == projects
    assert Path(ReportManager._get_report_folder(report.report_id)).parent == reports


@pytest.mark.parametrize("logger_class", [ReportLogger, ReportConsoleLogger])
def test_invalid_logger_id_has_no_storage_side_effects(storage, logger_class):
    _, reports = storage
    with pytest.raises(StoragePathError):
        logger_class("../outside")
    assert list(reports.iterdir()) == []


def test_legacy_json_symlink_is_not_read_or_listed(storage, tmp_path):
    _, reports = storage
    target = tmp_path / "external.json"
    target.write_text(json.dumps(make_report().to_dict()))
    make_symlink(reports / "report_fixture.json", target)
    with pytest.raises(StoragePathError):
        ReportManager.get_report("report_fixture")
    assert ReportManager.list_reports() == []
    assert ReportManager.get_report_by_simulation("sim_fixture") is None


def test_project_text_write_refuses_symlink(storage, tmp_path):
    projects, _ = storage
    project = ProjectManager.create_project()
    target = tmp_path / "external.txt"
    target.write_text("keep")
    make_symlink(projects / project.project_id / "extracted_text.txt", target)
    with pytest.raises(StoragePathError):
        ProjectManager.save_extracted_text(project.project_id, "replacement")
    assert target.read_text() == "keep"


def test_report_section_write_refuses_symlink(storage, tmp_path):
    _, reports = storage
    report = make_report()
    ReportManager.save_report(report)
    target = tmp_path / "external.md"
    target.write_text("keep")
    make_symlink(reports / report.report_id / "section_01.md", target)
    with pytest.raises(StoragePathError):
        ReportManager.save_section(
            report.report_id, 1, ReportSection("title", "replacement")
        )
    assert target.read_text() == "keep"
