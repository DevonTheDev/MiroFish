"""Real Flask dispatch and background threads for process-local report ownership.

Only report inference/storage and simulation/project inputs are synthetic. The
route starts unmodified ``threading.Thread`` workers, with real TaskManager and
graph-reader leases. Events park inference, never worker startup or admission.
"""

from pathlib import Path
from queue import Queue
import threading
from types import SimpleNamespace
import uuid

import pytest
from flask import Flask

from app.api import report as report_api
from app.models.project import ProjectStatus
from app.models.task import TaskManager, TaskStatus
from app.services.simulation_runner import RunnerStatus
from app.utils.zep_lifecycle import get_graph_readers, unregister_graph_reader


WAIT_SECONDS = 5


@pytest.fixture
def live_reports(monkeypatch):
    """Every request and worker finishes before patches or task state restore."""
    assert Path(report_api.__file__).resolve() == (
        Path(__file__).resolve().parents[1] / "app/api/report.py"
    )
    suffix = uuid.uuid4().hex
    simulation_id = f"sim_thread_{suffix}"
    graph_id = f"graph_thread_{suffix}"
    project = SimpleNamespace(
        graph_id=graph_id,
        status=ProjectStatus.GRAPH_COMPLETED,
        simulation_requirement="synthetic thread workflow",
    )
    state = SimpleNamespace(project_id="thread_project", graph_id=graph_id)
    runtime = SimpleNamespace(
        simulation_id=simulation_id,
        graph_id=graph_id,
        states={simulation_id: state},
        runs={simulation_id: SimpleNamespace(runner_status=RunnerStatus.COMPLETED)},
        cache={}, saved=[], workers=[], requests=[], closing=False,
        guard=threading.Lock(), entered=Queue(), outcomes={},
    )
    # Isolate the real singleton, without replacing any TaskManager methods.
    monkeypatch.setattr(TaskManager, "_instance", None)
    runtime.tasks = TaskManager()

    class Agent:
        def __init__(self, *, simulation_id, graph_id, **_kwargs):
            self.worker = SimpleNamespace(
                simulation_id=simulation_id,
                graph_id=graph_id,
                thread=threading.current_thread(),
                release=threading.Event(),
                report_id=None,
            )
            with runtime.guard:
                runtime.workers.append(self.worker)
                if runtime.closing:
                    self.worker.release.set()
            # Observe the public resources at the very first agent operation.
            self.worker.initial_tasks = runtime.tasks.list_tasks()
            self.worker.initial_readers = get_graph_readers(graph_id)

        def generate_report(self, *, progress_callback, report_id):
            worker = self.worker
            worker.report_id = report_id
            runtime.entered.put(worker)
            if not worker.release.wait(timeout=WAIT_SECONDS * 2):
                raise RuntimeError("test did not release synthetic inference")
            if runtime.outcomes.get(worker.simulation_id) == "failed":
                raise RuntimeError("synthetic inference failed")
            progress_callback("synthetic", 50, "halfway")
            return SimpleNamespace(
                report_id=report_id,
                simulation_id=worker.simulation_id,
                status=report_api.ReportStatus.COMPLETED,
                error=None,
            )

    def save_report(report):
        with runtime.guard:
            runtime.saved.append(report)
            runtime.cache[report.simulation_id] = report

    monkeypatch.setattr(report_api, "SimulationManager", lambda: SimpleNamespace(
        get_simulation=runtime.states.get,
    ))
    monkeypatch.setattr(report_api.ProjectManager, "get_project", lambda _id: project)
    monkeypatch.setattr(report_api.SimulationRunner, "get_run_state", runtime.runs.get)
    monkeypatch.setattr(report_api.ZepGraphMemoryManager, "get_updater", lambda _id: None)
    monkeypatch.setattr(report_api.ReportManager, "get_report_by_simulation", runtime.cache.get)
    monkeypatch.setattr(report_api.ReportManager, "save_report", save_report)
    monkeypatch.setattr(report_api, "ReportAgent", Agent)
    assert report_api.threading is threading
    app = Flask(__name__)
    app.register_blueprint(report_api.report_bp, url_prefix="/api/report")

    def start_request(*, simulation_id=simulation_id, force=True, barrier=None):
        result = Queue()

        def request():
            try:
                if barrier is not None:
                    barrier.wait(timeout=WAIT_SECONDS)
                # Flask request contexts and clients are never shared threads.
                with app.test_client() as client:
                    response = client.post("/api/report/generate", json={
                        "simulation_id": simulation_id,
                        "force_regenerate": force,
                    })
                    result.put((response.status_code, response.get_json()))
            except BaseException as error:
                result.put(error)

        thread = threading.Thread(target=request, name="report-test-http", daemon=True)
        runtime.requests.append(thread)
        thread.start()
        return SimpleNamespace(thread=thread, result=result)

    def receive(request):
        request.thread.join(timeout=WAIT_SECONDS)
        assert not request.thread.is_alive(), "HTTP admission waited for inference"
        response = request.result.get(timeout=WAIT_SECONDS)
        if isinstance(response, BaseException):
            raise response
        status, body = response
        assert status == 200, body
        assert body["success"] is True
        return body["data"]

    def finish(worker):
        worker.release.set()
        worker.thread.join(timeout=WAIT_SECONDS)
        assert not worker.thread.is_alive(), "report worker did not finish cleanup"

    runtime.start_request = start_request
    runtime.receive = receive
    runtime.finish = finish
    yield runtime
    with runtime.guard:
        runtime.closing = True
        for worker in runtime.workers:
            worker.release.set()
    for request in runtime.requests:
        request.join(timeout=WAIT_SECONDS)
        assert not request.is_alive(), "request outlived its test"
    for worker in runtime.workers:
        worker.thread.join(timeout=WAIT_SECONDS)
        assert not worker.thread.is_alive(), "worker outlived its test"
    # Keep an intentional regression failure from contaminating later tests.
    # Workers have ended, so this touches no live ownership or implementation
    # registry; a missing cleanup remains visible in each test's assertions.
    for task in runtime.tasks.list_tasks():
        metadata = task["metadata"]
        unregister_graph_reader(metadata["graph_id"], metadata["report_id"])


def _first_work_registered(runtime, worker, data):
    assert worker.thread is not threading.current_thread()
    assert worker.thread not in runtime.requests
    assert type(worker.thread) is threading.Thread
    assert worker.thread.daemon is True
    assert worker.thread.is_alive()
    assert worker.report_id == data["report_id"]
    assert data["report_id"] in worker.initial_readers
    matching = [task for task in worker.initial_tasks if task["task_id"] == data["task_id"]]
    assert len(matching) == 1
    assert matching[0]["status"] == "processing"
    assert matching[0]["metadata"] == {
        "simulation_id": data["simulation_id"],
        "graph_id": worker.graph_id,
        "report_id": data["report_id"],
    }


def _same_active_job(first, retry):
    for key in ("simulation_id", "task_id", "report_id"):
        assert retry[key] == first[key]
    assert retry["status"] == "generating"
    assert retry["already_generated"] is False
    assert retry["already_running"] is True


def test_simultaneous_http_requests_reuse_one_real_parked_worker(live_reports):
    runtime = live_reports
    start = threading.Barrier(3)
    requests = [runtime.start_request(barrier=start) for _ in range(2)]
    start.wait(timeout=WAIT_SECONDS)
    results = [runtime.receive(request) for request in requests]
    assert len(runtime.tasks.list_tasks()) == 1
    assert results[0]["task_id"] == results[1]["task_id"]
    assert sorted(result["already_running"] for result in results) == [False, True]
    first = next(result for result in results if result["already_running"] is False)
    retry = next(result for result in results if result["already_running"] is True)
    _same_active_job(first, retry)
    worker = runtime.entered.get(timeout=WAIT_SECONDS)
    _first_work_registered(runtime, worker, first)
    assert len(runtime.workers) == 1
    assert runtime.saved == []
    assert get_graph_readers(runtime.graph_id) == [first["report_id"]]
    # This request must finish while actual inference is still blocked. A
    # registry or graph lock held across inference would prevent that progress.
    third = runtime.receive(runtime.start_request(force=False))
    _same_active_job(first, third)
    assert len(runtime.tasks.list_tasks()) == len(runtime.workers) == 1


def test_distinct_simulations_share_graph_with_both_real_workers_alive(live_reports):
    runtime = live_reports
    other = runtime.simulation_id + "_other"
    runtime.states[other] = runtime.states[runtime.simulation_id]
    runtime.runs[other] = runtime.runs[runtime.simulation_id]
    first = runtime.receive(runtime.start_request())
    first_worker = runtime.entered.get(timeout=WAIT_SECONDS)
    _first_work_registered(runtime, first_worker, first)
    # The second HTTP call and its inference must both enter before the first
    # worker is released: neither lifecycle nor registry locks span inference.
    second = runtime.receive(runtime.start_request(simulation_id=other))
    second_worker = runtime.entered.get(timeout=WAIT_SECONDS)
    _first_work_registered(runtime, second_worker, second)
    assert first_worker.thread.is_alive() and second_worker.thread.is_alive()
    assert first["task_id"] != second["task_id"]
    assert first["report_id"] != second["report_id"]
    assert len(runtime.tasks.list_tasks()) == len(runtime.workers) == 2
    assert get_graph_readers(runtime.graph_id) == sorted([
        first["report_id"], second["report_id"],
    ])
    runtime.finish(first_worker)
    assert get_graph_readers(runtime.graph_id) == [second["report_id"]]
    assert second_worker.thread.is_alive()
    _same_active_job(second, runtime.receive(runtime.start_request(simulation_id=other)))
    runtime.finish(second_worker)
    assert get_graph_readers(runtime.graph_id) == []


@pytest.mark.parametrize("outcome", ["completed", "failed"])
def test_real_worker_terminal_cleanup_allows_explicit_forced_job(live_reports, outcome):
    runtime = live_reports
    runtime.outcomes[runtime.simulation_id] = outcome
    first = runtime.receive(runtime.start_request())
    worker = runtime.entered.get(timeout=WAIT_SECONDS)
    _first_work_registered(runtime, worker, first)
    runtime.finish(worker)
    task = runtime.tasks.get_task(first["task_id"])
    assert task.status == TaskStatus(outcome)
    assert get_graph_readers(runtime.graph_id) == []
    if outcome == "completed":
        assert task.result["report_id"] == first["report_id"]
        assert [report.report_id for report in runtime.saved] == [first["report_id"]]
    else:
        assert task.error == "synthetic inference failed"
        assert runtime.saved == []
    runtime.outcomes[runtime.simulation_id] = "completed"
    fresh = runtime.receive(runtime.start_request(force=True))
    assert fresh["task_id"] != first["task_id"]
    assert fresh["report_id"] != first["report_id"]
    fresh_worker = runtime.entered.get(timeout=WAIT_SECONDS)
    _first_work_registered(runtime, fresh_worker, fresh)
    assert get_graph_readers(runtime.graph_id) == [fresh["report_id"]]
    assert len(runtime.tasks.list_tasks()) == len(runtime.workers) == 2
    runtime.finish(fresh_worker)
    assert runtime.tasks.get_task(fresh["task_id"]).status == TaskStatus.COMPLETED
    assert get_graph_readers(runtime.graph_id) == []
