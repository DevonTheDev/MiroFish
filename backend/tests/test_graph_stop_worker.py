"""Actual local worker and settlement threads, with finite synthetic operations."""
from types import SimpleNamespace
import threading

import pytest

from app.models.project import ProjectManager, ProjectStatus
from app.api import graph as api
from app.models.task import TaskStatus
from app.services import local_graph_build as worker
from app.services.graph_build_control import GraphBuildUnresolved, get_control, release_control
from test_graph_stop_api import owned_build, stop, load


PHASES = ["initialize", "chunk", "create", "ontology", "batch-create", "batch-add", "process", "read"]
WAIT = 3


@pytest.fixture
def worker_build(owned_build, monkeypatch):
    r = owned_build
    r.events = []
    r.stop_at = None
    r.raise_at = None
    r.settlement_failure = False
    r.stop_response = None
    r.observe_failure = False
    r.progress_updates = []
    update_task = r.tasks.update_task
    def record_update(task_id, **kwargs):
        r.progress_updates.append(dict(kwargs))
        return update_task(task_id, **kwargs)
    monkeypatch.setattr(r.tasks, "update_task", record_update)

    def performed(phase):
        r.events.append(phase)
        if r.stop_at == phase:
            r.stop_response = stop(r)
        if r.raise_at == phase:
            raise RuntimeError("synthetic operation failure: " + phase)

    class Client:
        def __init__(self):
            self.batch = SimpleNamespace(create=self.create, add=self.add, process=self.process, get=self.get)

        def create(self, *, metadata):
            r.control.remember_identity(batch_id="batch_worker", operation_id=metadata["mirofish_operation_id"])
            performed("batch-create")
            return SimpleNamespace(batch_id="batch_worker")

        def add(self, *, batch_id, items):
            performed("batch-add")
            return [SimpleNamespace() for _ in items]

        def process(self, batch_id):
            performed("process")

        def get(self, batch_id):
            if r.observe_failure:
                r.control.record_error("synthetic provider primary failure")
                r.stop_response = stop(r)
                return SimpleNamespace(status="canceled")
            return SimpleNamespace(status="succeeded")

        def _call(self, method, batch_id, control):
            assert method == "settle_build_batch"
            r.events.append("settlement")
            if r.settlement_failure:
                raise GraphBuildUnresolved("synthetic final journal failure")

        def close(self):
            pytest.fail("Stop closed the process-shared client")

    class Builder:
        def __init__(self, **_kwargs):
            self.client = Client()
            performed("initialize")

        def validate_batch_chunks(self, chunks, **_kwargs):
            assert chunks == ["first chunk", "second chunk"]

        def create_graph(self, *, name, graph_id_callback):
            graph_id_callback("graph_worker")
            performed("create")
            return "graph_worker"

        def set_ontology(self, graph_id, ontology):
            performed("ontology")

        def build_operation_id(self, graph_id, chunks):
            return "operation_worker"

        def get_graph_data(self, graph_id):
            performed("read")
            return {"node_count": 1, "edge_count": 0}

    def chunks(*_args, **_kwargs):
        performed("chunk")
        return ["first chunk", "second chunk"]

    monkeypatch.setattr(worker, "GraphBuilderService", Builder)
    monkeypatch.setattr(worker.TextProcessor, "split_text", chunks)

    def launch():
        worker.launch_local_build(r.control, graph_name="fixture", text="source",
                                  ontology=r.project.ontology, chunk_size=500,
                                  chunk_overlap=50, locale="en")
        r.control.worker.join(WAIT)
        r.control.settlement_worker.join(WAIT)
        assert not r.control.worker.is_alive()
        assert not r.control.settlement_worker.is_alive()
    r.launch = launch
    yield r
    for name in ("worker", "settlement_worker"):
        thread = getattr(r.control, name, None)
        if thread:
            thread.join(WAIT)
            assert not thread.is_alive()


@pytest.mark.parametrize("phase", PHASES)
def test_worker_stops_between_admitted_operations_and_retains_partial_inputs(worker_build, phase):
    r = worker_build
    r.stop_at = phase
    r.launch()
    assert r.stop_response.status_code == 202
    productive = [event for event in r.events if event != "settlement"]
    assert productive == PHASES[:PHASES.index(phase) + 1]
    saved = load(r)
    assert saved.status == ProjectStatus.GRAPH_STOPPED
    assert saved.files == r.project.files
    assert saved.ontology == r.project.ontology
    assert saved.graph_build_task_id == r.control.task_id
    assert r.tasks.get_task(r.control.task_id).status == TaskStatus.CANCELLED


def test_stop_before_worker_entry_never_initializes_client(worker_build):
    r = worker_build
    assert stop(r).status_code == 202
    r.launch()
    assert r.events == []
    assert load(r).status == ProjectStatus.GRAPH_STOPPED


def test_successful_worker_publishes_completion_and_later_stop_loses(worker_build):
    r = worker_build
    r.launch()
    assert r.events == PHASES
    observed_progress = [item["progress"] for item in r.progress_updates if "progress" in item]
    assert all(value in observed_progress for value in (5, 10, 15, 55, 95, 100))
    assert len({item.get("message") for item in r.progress_updates}) >= 5
    assert load(r).status == ProjectStatus.GRAPH_COMPLETED
    assert stop(r).get_json()["data"]["state"] == "completed"


def test_admitted_operation_failure_is_visible_alongside_stop(worker_build):
    r = worker_build
    r.stop_at = r.raise_at = "ontology"
    r.launch()
    saved = load(r)
    assert saved.status == ProjectStatus.GRAPH_STOPPED
    assert "synthetic operation failure: ontology" in saved.graph_build_stop["error"]
    assert "batch-create" not in r.events


def test_settlement_journal_failure_never_publishes_stopped(worker_build):
    r = worker_build
    r.stop_at = "batch-add"
    r.settlement_failure = True
    r.launch()
    saved = load(r)
    assert saved.status == ProjectStatus.GRAPH_BUILDING
    assert saved.graph_build_stop["state"] == "unresolved"
    assert r.tasks.get_task(r.control.task_id).status == TaskStatus.PROCESSING
    assert stop(r).get_json()["data"]["state"] == "unresolved"


def test_primary_episode_error_survives_stop_during_admitted_poll(worker_build):
    r = worker_build
    r.observe_failure = True
    r.launch()
    marker = load(r).graph_build_stop
    assert marker["state"] == "stopped"
    assert marker["error"].startswith("synthetic provider primary failure")
    assert "Local batch ended as canceled" in marker["error"]


def test_settlement_thread_start_failure_keeps_started_worker_owned(owned_build, monkeypatch):
    r = owned_build
    release_control(r.control)
    project = load(r)
    project.status = ProjectStatus.ONTOLOGY_GENERATED
    project.graph_build_task_id = None
    ProjectManager.save_project(project)
    ProjectManager.save_extracted_text(project.project_id, "source")
    entered, release = threading.Event(), threading.Event()
    real_thread = threading.Thread

    def productive(control, **_options):
        with control.operation("synthetic admitted operation"):
            entered.set()
            assert release.wait(WAIT)

    class FailsSecondStart:
        def __init__(self, **options):
            self.thread = real_thread(**options)
            self.settlement = options["name"].startswith("MiroFishGraphSettlement-")
        @property
        def ident(self):
            return self.thread.ident
        def start(self):
            if self.settlement:
                raise RuntimeError("synthetic settlement thread start failure")
            self.thread.start()
        def join(self, timeout=None):
            self.thread.join(timeout)
        def is_alive(self):
            return self.thread.is_alive()

    monkeypatch.setattr(worker, "_build", productive)
    monkeypatch.setattr(worker.threading, "Thread", FailsSecondStart)
    active = None
    try:
        response = r.client.post("/api/graph/build", json={"project_id": project.project_id})
        assert response.status_code == 500
        assert entered.wait(WAIT)
        active = get_control(project.project_id)
        assert active is not None and active.worker.is_alive()
        assert active.unresolved and active.has_pending_receipts()
        response = stop(r, active.task_id)
        assert response.status_code == 202
        assert response.get_json()["data"]["state"] == "unresolved"
        assert load(r).status == ProjectStatus.GRAPH_BUILDING
    finally:
        release.set()
        if active:
            active.worker.join(WAIT)
            assert not active.worker.is_alive()
            release_control(active)
