"""Project metadata saves remain readable through ordinary local write failures."""

import json
import logging
from pathlib import Path
import tempfile

import pytest

from app.models import project as module
from app.models.project import ProjectManager
from app.storage import StoragePathError


@pytest.fixture
def project_file(tmp_path, monkeypatch):
    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(tmp_path / "projects"))
    project = ProjectManager.create_project("Previous Café")
    path = Path(ProjectManager._get_project_meta_path(project.project_id))
    return project, path, path.read_bytes()


@pytest.mark.parametrize("existing", [True, False])
def test_partial_serialization_preserves_previous_or_missing_file(
    project_file, monkeypatch, existing
):
    project, path, previous = project_file
    if not existing:
        path.unlink()
    project.name = "Updated"

    def interrupted(payload, stream, **kwargs):
        stream.write('{"partial":')
        raise OSError("interrupted metadata serialization")

    with monkeypatch.context() as patch:
        patch.setattr(module.json, "dump", interrupted)
        with pytest.raises(OSError, match="interrupted metadata serialization"):
            ProjectManager.save_project(project)
    if existing:
        assert path.read_bytes() == previous
        assert ProjectManager.get_project(project.project_id).name == "Previous Café"
    else:
        assert not path.exists()
    assert list(path.parent.glob("*.tmp")) == []
    ProjectManager.save_project(project)
    assert ProjectManager.get_project(project.project_id).name == "Updated"


def test_real_unserializable_field_cannot_truncate_metadata(project_file):
    project, path, previous = project_file
    project.ontology = {"invalid": {1, 2}}
    with pytest.raises(TypeError):
        ProjectManager.save_project(project)
    assert path.read_bytes() == previous
    assert list(path.parent.glob("*.tmp")) == []


def test_reader_sees_old_project_until_complete_replacement(project_file, monkeypatch):
    project, path, previous = project_file
    original_dump = module.json.dump
    observations = []

    def staged_write(payload, stream, **kwargs):
        stream.write(" ")
        stream.flush()
        observations.append(ProjectManager.get_project(project.project_id).name)
        assert path.read_bytes() == previous
        original_dump(payload, stream, **kwargs)

    project.name = "Updated 雪"
    project.graph_id = "graph_fixture"
    project.ontology = {"entity_types": [{"name": "Person"}]}
    monkeypatch.setattr(module.json, "dump", staged_write)
    ProjectManager.save_project(project)
    assert observations == ["Previous Café"]
    restored = ProjectManager.get_project(project.project_id)
    assert restored.name == "Updated 雪"
    assert restored.graph_id == "graph_fixture"
    assert restored.ontology == project.ontology
    assert "雪" in path.read_text(encoding="utf-8")
    assert list(path.parent.glob("*.tmp")) == []


def test_replace_failure_preserves_metadata_and_closes_staged_handle(
    project_file, monkeypatch
):
    project, path, previous = project_file
    handles = []
    original_factory = tempfile.NamedTemporaryFile

    def create(**kwargs):
        handle = original_factory(**kwargs)
        handles.append(handle)
        return handle

    def refuse_replace(source, destination):
        assert Path(source).parent == path.parent
        assert Path(destination) == path
        assert handles[0].closed
        assert json.loads(Path(source).read_text())["name"] == "Updated"
        raise PermissionError("metadata replace denied")

    project.name = "Updated"
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", create)
    monkeypatch.setattr(module.os, "replace", refuse_replace)
    with pytest.raises(PermissionError, match="metadata replace denied"):
        ProjectManager.save_project(project)
    assert path.read_bytes() == previous
    assert list(path.parent.glob("*.tmp")) == []


def test_close_failure_preserves_metadata(project_file, monkeypatch):
    project, path, previous = project_file
    original_factory = tempfile.NamedTemporaryFile
    handles = []

    class FailingClose:
        def __init__(self, **kwargs):
            self.handle = original_factory(**kwargs)
            handles.append(self.handle)

        def __enter__(self):
            return self.handle.__enter__()

        def __exit__(self, *args):
            self.handle.__exit__(*args)
            raise OSError("metadata flush failed")

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", FailingClose)
    with pytest.raises(OSError, match="metadata flush failed"):
        ProjectManager.save_project(project)
    assert handles and all(handle.closed for handle in handles)
    assert path.read_bytes() == previous
    assert list(path.parent.glob("*.tmp")) == []


def test_staging_creation_failure_does_not_touch_previous_metadata(
    project_file, monkeypatch
):
    project, path, previous = project_file

    def refuse_create(**kwargs):
        raise PermissionError("metadata staging denied")

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", refuse_create)
    with pytest.raises(PermissionError, match="metadata staging denied"):
        ProjectManager.save_project(project)
    assert path.read_bytes() == previous
    assert list(path.parent.glob("*.tmp")) == []


def test_failed_outer_save_cannot_remove_a_completed_inner_save(
    project_file, monkeypatch
):
    project, path, _ = project_file
    inner = ProjectManager.get_project(project.project_id)
    project.name = "outer"
    inner.name = "inner completed"
    original_dump = module.json.dump

    def nested_save(payload, stream, **kwargs):
        if payload["name"] == "outer":
            stream.write('{"partial":')
            ProjectManager.save_project(inner)
            raise OSError("outer save failed")
        original_dump(payload, stream, **kwargs)

    monkeypatch.setattr(module.json, "dump", nested_save)
    with pytest.raises(OSError, match="outer save failed"):
        ProjectManager.save_project(project)
    assert ProjectManager.get_project(project.project_id).name == "inner completed"
    assert list(path.parent.glob("*.tmp")) == []


def test_cleanup_error_does_not_mask_original_failure(
    project_file, monkeypatch, caplog
):
    project, path, previous = project_file
    original_unlink = module.os.unlink

    def refuse_cleanup(candidate, *args, **kwargs):
        if str(candidate).endswith(".tmp"):
            raise PermissionError("temporary cleanup denied")
        return original_unlink(candidate, *args, **kwargs)

    def interrupted(payload, stream, **kwargs):
        stream.write("partial")
        raise OSError("original serialization failure")

    logger = getattr(module, "logger", logging.getLogger("mirofish.project"))
    logger.addHandler(caplog.handler)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(module.json, "dump", interrupted)
            patch.setattr(module.os, "unlink", refuse_cleanup)
            with pytest.raises(OSError, match="original serialization failure"):
                ProjectManager.save_project(project)
    finally:
        logger.removeHandler(caplog.handler)
    assert path.read_bytes() == previous
    assert "temporary" in caplog.text.lower()
    remaining = list(path.parent.glob("*.tmp"))
    assert len(remaining) == 1
    remaining[0].unlink()


def test_existing_path_guard_rejects_linked_metadata_before_staging(
    project_file, tmp_path, monkeypatch
):
    project, path, previous = project_file
    external = tmp_path / "external.json"
    path.rename(external)
    try:
        path.symlink_to(external)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")

    def must_not_stage(**kwargs):
        pytest.fail("unsafe metadata path reached staging")

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", must_not_stage)
    with pytest.raises(StoragePathError):
        ProjectManager.save_project(project)
    assert external.read_bytes() == previous


def test_save_to_missing_project_directory_does_not_create_it(project_file):
    project, path, _ = project_file
    project.project_id = "proj_missing"
    with pytest.raises(FileNotFoundError):
        ProjectManager.save_project(project)
    assert not (path.parent.parent / "proj_missing").exists()
