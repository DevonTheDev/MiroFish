"""Exercise chunk validation through Flask and real temporary project storage."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask

from app.api import graph as graph_api
from app.models.project import ProjectManager, ProjectStatus
from app.models.task import TaskStatus


@pytest.fixture
def build_endpoint(monkeypatch, tmp_path):
    monkeypatch.setattr(ProjectManager, "PROJECTS_DIR", str(tmp_path / "projects"))
    monkeypatch.setattr(graph_api.Config, "LOCAL_MODE", False)
    monkeypatch.setattr(graph_api.Config, "ZEP_API_KEY", "test-key")
    monkeypatch.setattr(graph_api.Config, "DEFAULT_CHUNK_SIZE", 500)
    monkeypatch.setattr(graph_api.Config, "DEFAULT_CHUNK_OVERLAP", 50)
    project = ProjectManager.create_project("Chunk validation")
    project.status = ProjectStatus.ONTOLOGY_GENERATED
    project.ontology = {"entity_types": [], "edge_types": []}
    project.graph_id = "graph-existing"
    project.graph_build_task_id = "task-existing"
    ProjectManager.save_project(project)
    ProjectManager.save_extracted_text(project.project_id, "Source text for a graph")

    events = []
    loaded = []
    control = SimpleNamespace(active=False, batch_status="processing", consumers=[])
    real_get = ProjectManager.get_project
    real_save = ProjectManager.save_project
    real_text = ProjectManager.get_extracted_text

    def get_project(_cls, project_id):
        value = real_get(project_id)
        loaded.append(value)
        return value

    def save_project(_cls, value):
        events.append(("save", value.status))
        real_save(value)

    def get_text(_cls, project_id):
        events.append(("read-text", project_id))
        return real_text(project_id)

    class Tasks:
        def get_task(self, task_id):
            events.append(("get-task", task_id))
            return SimpleNamespace(status=TaskStatus.PROCESSING) if control.active else None

        def create_task(self, _description):
            events.append(("create-task", "task-new"))
            return "task-new"

    class Thread:
        def __init__(self, *, target, daemon):
            self.target = target
            assert daemon is True
            events.append(("thread", "created"))

        def start(self):
            # Background model/cloud work is outside this request-boundary test.
            events.append(("thread", "started"))

    class Builder:
        def __init__(self, **_kwargs):
            events.append(("builder", "created"))

        def get_batch_summary(self, batch_id):
            events.append(("batch-summary", batch_id))
            return SimpleNamespace(status=control.batch_status)

        def delete_graph(self, graph_id):
            events.append(("delete-graph", graph_id))

    def consumers(graph_id):
        events.append(("consumers", graph_id))
        return control.consumers

    monkeypatch.setattr(ProjectManager, "get_project", classmethod(get_project))
    monkeypatch.setattr(ProjectManager, "save_project", classmethod(save_project))
    monkeypatch.setattr(ProjectManager, "get_extracted_text", classmethod(get_text))
    monkeypatch.setattr(graph_api, "TaskManager", Tasks)
    monkeypatch.setattr(graph_api.threading, "Thread", Thread)
    monkeypatch.setattr(graph_api, "GraphBuilderService", Builder)
    monkeypatch.setattr(graph_api, "_active_graph_consumers", consumers)

    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(graph_api.graph_bp, url_prefix="/api/graph")
    client = app.test_client()

    def configure(**changes):
        for key, value in changes.items():
            setattr(project, key, value)
        real_save(project)
        return project.to_dict()

    def post(**payload):
        return client.post("/api/graph/build", json={"project_id": project.project_id, **payload})

    return SimpleNamespace(
        configure=configure,
        post=post,
        read=lambda: real_get(project.project_id),
        metadata=Path(ProjectManager._get_project_meta_path(project.project_id)),
        events=events,
        loaded=loaded,
        control=control,
    )


BOOLEAN_CHUNKS = [
    pytest.param({"chunk_size": True, "chunk_overlap": 0}, "chunk_size", id="size-true"),
    pytest.param({"chunk_size": False, "chunk_overlap": 0}, "chunk_size", id="size-false"),
    pytest.param({"chunk_size": 500, "chunk_overlap": True}, "chunk_overlap", id="overlap-true"),
    pytest.param({"chunk_size": 500, "chunk_overlap": False}, "chunk_overlap", id="overlap-false"),
]

CHUNK_ERRORS = {
    "chunk_size": "chunk_size must be a positive integer",
    "chunk_overlap": "chunk_overlap must satisfy 0 <= chunk_overlap < chunk_size",
}


@pytest.mark.parametrize("payload,field", BOOLEAN_CHUNKS)
@pytest.mark.parametrize("status,force", [
    (ProjectStatus.ONTOLOGY_GENERATED, False),
    (ProjectStatus.FAILED, False),
    (ProjectStatus.GRAPH_COMPLETED, True),
])
def test_boolean_chunks_rejected_without_build_or_project_changes(build_endpoint, payload, field, status, force):
    endpoint = build_endpoint
    before = endpoint.configure(status=status)
    persisted = endpoint.metadata.read_bytes()

    response = endpoint.post(force=force, **payload)

    assert response.status_code == 400, (response.get_json(), endpoint.events, endpoint.read().to_dict())
    assert response.get_json()["success"] is False
    assert response.get_json()["error"] == CHUNK_ERRORS[field]
    assert endpoint.events == []
    assert endpoint.loaded[0].to_dict() == before
    assert endpoint.metadata.read_bytes() == persisted


@pytest.mark.parametrize("chunk_size,chunk_overlap", [(1, 0), (500, 0), (500, 50), (2, 1)])
def test_integer_chunks_start_build_and_persist_exact_values(build_endpoint, chunk_size, chunk_overlap):
    response = build_endpoint.post(chunk_size=chunk_size, chunk_overlap=chunk_overlap)

    assert response.status_code == 200
    assert response.get_json()["data"]["task_id"] == "task-new"
    saved = build_endpoint.read()
    assert (saved.chunk_size, saved.chunk_overlap) == (chunk_size, chunk_overlap)
    assert type(saved.chunk_size) is type(saved.chunk_overlap) is int
    assert saved.status == ProjectStatus.GRAPH_BUILDING
    assert build_endpoint.events[-3:] == [
        ("save", ProjectStatus.GRAPH_BUILDING), ("thread", "created"), ("thread", "started")
    ]


@pytest.mark.parametrize("stored,expected", [((200, 20), (200, 20)), ((0, 0), (500, 50))])
def test_omitted_chunks_keep_existing_project_or_default_fallback(build_endpoint, stored, expected):
    # This deliberately preserves the existing falsy-value fallback, including zero overlap.
    build_endpoint.configure(chunk_size=stored[0], chunk_overlap=stored[1])

    response = build_endpoint.post()

    assert response.status_code == 200
    saved = build_endpoint.read()
    assert (saved.chunk_size, saved.chunk_overlap) == expected


@pytest.mark.parametrize("stored,field", [((True, 50), "chunk_size"), ((500, True), "chunk_overlap")])
def test_omitted_chunk_rejects_persisted_true_before_mutation(build_endpoint, stored, field):
    endpoint = build_endpoint
    before = endpoint.configure(chunk_size=stored[0], chunk_overlap=stored[1])
    persisted = endpoint.metadata.read_bytes()

    response = endpoint.post()

    assert response.status_code == 400
    assert response.get_json()["error"] == CHUNK_ERRORS[field]
    assert endpoint.events == []
    assert endpoint.loaded[0].to_dict() == before
    assert endpoint.metadata.read_bytes() == persisted


@pytest.mark.parametrize("stored", [(False, 50), (500, False), (False, False)])
def test_omitted_persisted_false_keeps_existing_default_fallback(build_endpoint, stored):
    build_endpoint.configure(chunk_size=stored[0], chunk_overlap=stored[1])

    response = build_endpoint.post()

    assert response.status_code == 200
    saved = build_endpoint.read()
    assert (saved.chunk_size, saved.chunk_overlap) == (500, 50)
    assert type(saved.chunk_size) is type(saved.chunk_overlap) is int


@pytest.mark.parametrize("field,value", [
    ("chunk_size", 0), ("chunk_size", -1), ("chunk_size", 1.5),
    ("chunk_size", 500.0), ("chunk_size", "500"), ("chunk_size", None),
    ("chunk_overlap", -1), ("chunk_overlap", 500), ("chunk_overlap", 501),
    ("chunk_overlap", 1.5), ("chunk_overlap", "50"), ("chunk_overlap", None),
])
def test_existing_invalid_chunk_types_and_ranges_still_rejected(build_endpoint, field, value):
    endpoint = build_endpoint
    before = endpoint.configure()
    payload = {"chunk_size": 500, "chunk_overlap": 50, field: value}

    response = endpoint.post(**payload)

    assert response.status_code == 400
    assert response.get_json()["error"] == CHUNK_ERRORS[field]
    assert endpoint.events == []
    assert endpoint.loaded[0].to_dict() == before
    assert endpoint.read().to_dict() == before


@pytest.mark.parametrize("status,force", [
    (ProjectStatus.GRAPH_BUILDING, False),
    (ProjectStatus.GRAPH_BUILDING, True),
    (ProjectStatus.GRAPH_COMPLETED, False),
])
def test_reused_build_ignores_unused_boolean_chunks(build_endpoint, status, force):
    endpoint = build_endpoint
    before = endpoint.configure(status=status)
    persisted = endpoint.metadata.read_bytes()
    endpoint.control.active = True

    response = endpoint.post(force=force, chunk_size=True, chunk_overlap=False)

    assert response.status_code == 200
    assert response.get_json()["data"]["reused"] is True
    assert response.get_json()["data"]["task_id"] == "task-existing"
    assert response.get_json()["data"]["graph_id"] == "graph-existing"
    expected_events = [("get-task", "task-existing")] if status == ProjectStatus.GRAPH_BUILDING else []
    assert endpoint.events == expected_events
    assert endpoint.loaded[0].to_dict() == before
    assert endpoint.metadata.read_bytes() == persisted


@pytest.mark.parametrize("force", [0, 1, "false", None])
def test_force_type_is_validated_before_completed_reuse(build_endpoint, force):
    before = build_endpoint.configure(status=ProjectStatus.GRAPH_COMPLETED)

    response = build_endpoint.post(force=force, chunk_size=True, chunk_overlap=False)

    assert response.status_code == 400
    assert response.get_json()["error"] == "force must be a JSON boolean"
    assert build_endpoint.events == []
    assert build_endpoint.read().to_dict() == before


@pytest.mark.parametrize("force,expected_status", [(False, 409), (True, 400)])
def test_stale_build_reconciliation_stays_before_chunk_validation(build_endpoint, force, expected_status):
    endpoint = build_endpoint
    endpoint.configure(status=ProjectStatus.GRAPH_BUILDING)

    response = endpoint.post(force=force, chunk_size=True, chunk_overlap=False)

    assert response.status_code == expected_status
    if not force:
        assert response.get_json()["recoverable"] is True
    else:
        assert "chunk_size" in response.get_json()["error"]
    assert endpoint.events == [("get-task", "task-existing"), ("save", ProjectStatus.FAILED)]
    saved = endpoint.read()
    assert saved.status == ProjectStatus.FAILED
    assert (saved.chunk_size, saved.chunk_overlap) == (500, 50)
    assert saved.graph_id == "graph-existing"
    assert "no longer present" in saved.error


def test_resumable_batch_is_checked_before_invalid_chunk_rejection(build_endpoint):
    endpoint = build_endpoint
    before = endpoint.configure(
        status=ProjectStatus.GRAPH_BUILDING,
        zep_batch_id="batch-existing",
        zep_batch_operation_id="operation-existing",
    )

    response = endpoint.post(chunk_size=True, chunk_overlap=False)

    assert response.status_code == 400
    assert "chunk_size" in response.get_json()["error"]
    assert endpoint.events == [
        ("get-task", "task-existing"), ("builder", "created"), ("batch-summary", "batch-existing")
    ]
    assert endpoint.read().to_dict() == before


def test_valid_forced_rebuild_preserves_active_graph_consumer_protection(build_endpoint):
    endpoint = build_endpoint
    before = endpoint.configure(status=ProjectStatus.GRAPH_COMPLETED)
    endpoint.control.consumers = ["report:active"]

    response = endpoint.post(force=True, chunk_size=500, chunk_overlap=50)

    assert response.status_code == 409
    assert "report:active" in response.get_json()["error"]
    assert [event[0] for event in endpoint.events] == ["read-text", "consumers"]
    assert endpoint.read().to_dict() == before
