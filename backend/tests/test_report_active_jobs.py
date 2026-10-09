"""Actual report routes with synthetic inference and deterministic worker control."""

from dataclasses import FrozenInstanceError, replace
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


@pytest.fixture
def reports(monkeypatch):
    """Keep real task/lease behavior; never call models, providers, or disk storage."""
    suffix = uuid.uuid4().hex
    sim = f"sim_{suffix}"
    graph = f"graph_{suffix}"
    project = SimpleNamespace(
        graph_id=graph, status=ProjectStatus.GRAPH_COMPLETED,
        simulation_requirement="synthetic requirement",
    )
    state = SimpleNamespace(project_id="project", graph_id=graph)
    runtime = SimpleNamespace(
        sim=sim, graph=graph, project=project,
        states={sim: state}, projects={"project": project},
        runs={sim: SimpleNamespace(runner_status=RunnerStatus.COMPLETED)},
        updaters={}, cache={}, saved=[], workers=[], agents=[], errors=[],
        stage=None, startup=None, executed=set(), request_threads=[],
    )
    tasks = TaskManager()
    monkeypatch.setattr(tasks, "_tasks", {})
    runtime.tasks = tasks
    original_update = tasks.update_task
    original_complete = tasks.complete_task
    original_fail = tasks.fail_task
    original_locale = report_api.set_locale

    def update_task(task_id, **kwargs):
        if runtime.stage == "initial_update" and kwargs.get("status") == TaskStatus.PROCESSING:
            raise RuntimeError("initial update failed")
        if runtime.stage == "progress" and kwargs.get("progress") == 50:
            raise RuntimeError("progress failed")
        return original_update(task_id, **kwargs)

    def complete_task(*args, **kwargs):
        if runtime.stage == "complete":
            raise RuntimeError("complete failed")
        return original_complete(*args, **kwargs)

    def fail_task(*args, **kwargs):
        if runtime.stage == "secondary":
            raise RuntimeError("failure publication failed")
        return original_fail(*args, **kwargs)

    def set_locale(locale):
        if runtime.stage == "locale":
            raise RuntimeError("locale setup failed")
        original_locale(locale)

    class ParkedThread:
        def __init__(self, *, target, daemon):
            assert daemon is True
            if runtime.startup == "construct":
                raise RuntimeError("thread construction failed")
            self.target = target

        def start(self):
            if runtime.startup == "start":
                raise RuntimeError("thread start failed")
            runtime.workers.append(self.target)

    class Agent:
        def __init__(self, *, simulation_id, **_kwargs):
            runtime.agents.append(simulation_id)
            if runtime.stage == "construct":
                raise RuntimeError("agent construction failed")
            self.simulation_id = simulation_id

        def generate_report(self, *, progress_callback, report_id):
            if runtime.stage in {"generate", "secondary"}:
                raise RuntimeError("generation failed")
            progress_callback("synthetic", 50, "halfway")
            return SimpleNamespace(
                report_id=report_id, simulation_id=self.simulation_id,
                status=(report_api.ReportStatus.FAILED if runtime.stage == "returned_failed"
                        else report_api.ReportStatus.COMPLETED),
                error="synthetic report failure" if runtime.stage == "returned_failed" else None,
            )

    def save_report(report):
        if runtime.stage == "save":
            raise RuntimeError("save failed")
        runtime.saved.append(report)
        runtime.cache[report.simulation_id] = report

    monkeypatch.setattr(report_api, "SimulationManager", lambda: SimpleNamespace(
        get_simulation=runtime.states.get,
    ))
    monkeypatch.setattr(report_api.ProjectManager, "get_project", runtime.projects.get)
    monkeypatch.setattr(report_api.SimulationRunner, "get_run_state", runtime.runs.get)
    monkeypatch.setattr(report_api.ZepGraphMemoryManager, "get_updater", runtime.updaters.get)
    monkeypatch.setattr(report_api.ReportManager, "get_report_by_simulation", runtime.cache.get)
    monkeypatch.setattr(report_api.ReportManager, "save_report", save_report)
    monkeypatch.setattr(report_api, "ReportAgent", Agent)
    # Do not modify the shared threading module: request threads stay real.
    monkeypatch.setattr(report_api, "threading", SimpleNamespace(Thread=ParkedThread))
    monkeypatch.setattr(report_api, "set_locale", set_locale)
    monkeypatch.setattr(tasks, "update_task", update_task)
    monkeypatch.setattr(tasks, "complete_task", complete_task)
    monkeypatch.setattr(tasks, "fail_task", fail_task)
    app = Flask(__name__)
    app.register_blueprint(report_api.report_bp, url_prefix="/api/report")
    runtime.app = app

    def post(force=True, simulation_id=None):
        with app.test_client() as client:
            return client.post("/api/report/generate", json={
                "simulation_id": simulation_id or sim, "force_regenerate": force,
            })

    def run(index=0):
        runtime.executed.add(index)
        try:
            runtime.workers[index]()
        except Exception as error:
            runtime.errors.append(error)

    runtime.post = post
    runtime.run = run
    yield runtime
    for thread in runtime.request_threads:
        if thread.ident is not None:
            thread.join(timeout=5)
        assert not thread.is_alive()
    for index in range(len(runtime.workers)):
        if index not in runtime.executed:
            run(index)
    # Original-code failure runs can leak leases (locale exception); isolate tests.
    for task in tasks.list_tasks():
        metadata = task["metadata"]
        unregister_graph_reader(metadata["graph_id"], metadata["report_id"])
    if hasattr(report_api, "_active_report_jobs"):
        for simulation_id in runtime.states:
            report_api._active_report_jobs.pop(simulation_id, None)


def _accepted(response):
    assert response.status_code == 200, response.get_json()
    body = response.get_json()
    assert body["success"] is True
    return body["data"]


def _same_job(first, second):
    assert {key: second[key] for key in ("simulation_id", "report_id", "task_id")} == {
        key: first[key] for key in ("simulation_id", "report_id", "task_id")
    }
    assert second["status"] == "generating"
    assert second["already_generated"] is False
    assert second["already_running"] is True


@pytest.mark.parametrize("first_force,retry_force", [(False, False), (True, True), (False, True), (True, False)])
def test_active_request_reuses_original_job_for_every_force_pair(reports, first_force, retry_force):
    first = _accepted(reports.post(first_force))
    retry = _accepted(reports.post(retry_force))
    _same_job(first, retry)
    assert len(reports.tasks.list_tasks()) == 1
    assert len(reports.workers) == 1
    assert get_graph_readers(reports.graph) == [first["report_id"]]


def test_explicit_retry_after_lost_response_reuses_pre_first_save_job(reports):
    reports.post()  # The caller never observes this accepted response.
    task = reports.tasks.list_tasks()[0]
    assert reports.agents == [] and reports.saved == []
    retry = _accepted(reports.post())
    assert retry["task_id"] == task["task_id"]
    assert retry["report_id"] == task["metadata"]["report_id"]
    assert len(reports.workers) == 1
    reports.run()
    assert reports.agents == [reports.sim]


def test_concurrent_http_admission_starts_one_worker(reports, monkeypatch):
    barrier = threading.Barrier(2)
    original = report_api.graph_lifecycle_lock
    caller_local = threading.local()

    def coordinated_lock(graph_id):
        if not getattr(caller_local, "at_admission", False):
            caller_local.at_admission = True
            barrier.wait(timeout=5)
        return original(graph_id)

    monkeypatch.setattr(report_api, "graph_lifecycle_lock", coordinated_lock)
    results = []
    errors = []

    def request():
        try:
            results.append(_accepted(reports.post()))
        except Exception as error:
            errors.append(error)

    for _ in range(2):
        thread = threading.Thread(target=request)
        reports.request_threads.append(thread)
        thread.start()
    for thread in reports.request_threads:
        thread.join(timeout=5)
        assert not thread.is_alive()
    monkeypatch.setattr(report_api, "graph_lifecycle_lock", original)
    assert errors == []
    assert len(results) == 2
    assert len({result["report_id"] for result in results}) == 1
    assert len({result["task_id"] for result in results}) == 1
    assert sorted(result["already_running"] for result in results) == [False, True]
    assert len(reports.tasks.list_tasks()) == len(reports.workers) == 1
    assert get_graph_readers(reports.graph) == [results[0]["report_id"]]


def test_active_forced_generation_precedes_old_completed_cache(reports):
    reports.cache[reports.sim] = SimpleNamespace(
        report_id="old_report", status=report_api.ReportStatus.COMPLETED,
    )
    first = _accepted(reports.post(True))
    retry = _accepted(reports.post(False))
    _same_job(first, retry)


def test_distinct_simulations_on_one_graph_have_distinct_jobs(reports):
    other = reports.sim + "_other"
    reports.states[other] = reports.states[reports.sim]
    reports.runs[other] = reports.runs[reports.sim]
    first = _accepted(reports.post(simulation_id=reports.sim))
    second = _accepted(reports.post(simulation_id=other))
    assert first["task_id"] != second["task_id"]
    assert first["report_id"] != second["report_id"]
    assert len(reports.tasks.list_tasks()) == len(reports.workers) == 2
    assert get_graph_readers(reports.graph) == sorted([first["report_id"], second["report_id"]])


@pytest.mark.parametrize("terminal", ["completed", "failed"])
def test_terminal_task_keeps_ownership_until_worker_finally(reports, monkeypatch, terminal):
    reached_terminal = threading.Event()
    allow_cleanup = threading.Event()
    method = "complete_task" if terminal == "completed" else "fail_task"
    original = getattr(reports.tasks, method)
    if terminal == "failed":
        reports.stage = "returned_failed"

    def publish_then_park(*args, **kwargs):
        original(*args, **kwargs)
        reached_terminal.set()
        assert allow_cleanup.wait(timeout=5)

    monkeypatch.setattr(reports.tasks, method, publish_then_park)
    first = _accepted(reports.post())
    worker = threading.Thread(target=reports.run)
    reports.request_threads.append(worker)
    worker.start()
    try:
        assert reached_terminal.wait(timeout=5)
        assert reports.tasks.get_task(first["task_id"]).status.value == terminal
        _same_job(first, _accepted(reports.post()))
        assert get_graph_readers(reports.graph) == [first["report_id"]]
    finally:
        allow_cleanup.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert get_graph_readers(reports.graph) == []


def test_success_releases_owner_and_preserves_completed_cache_behavior(reports):
    first = _accepted(reports.post())
    reports.run()
    assert reports.tasks.get_task(first["task_id"]).status == TaskStatus.COMPLETED
    assert get_graph_readers(reports.graph) == []
    cached = _accepted(reports.post(False))
    assert cached["report_id"] == first["report_id"]
    assert cached["already_generated"] is True
    assert len(reports.workers) == 1
    fresh = _accepted(reports.post(True))
    assert fresh["report_id"] != first["report_id"]
    assert fresh["task_id"] != first["task_id"]
    assert len(reports.workers) == 2


@pytest.mark.parametrize("stage", ["locale", "initial_update", "construct", "generate", "progress", "save", "complete", "returned_failed"])
def test_worker_failure_releases_claim_and_reader_and_allows_retry(reports, stage):
    reports.stage = stage
    first = _accepted(reports.post())
    reports.run()
    assert get_graph_readers(reports.graph) == []
    assert reports.tasks.get_task(first["task_id"]).status == TaskStatus.FAILED
    reports.stage = None
    fresh = _accepted(reports.post())
    assert fresh["task_id"] != first["task_id"]
    assert fresh["report_id"] != first["report_id"]


def test_secondary_failure_publication_error_still_releases_ownership(reports):
    reports.stage = "secondary"
    first = _accepted(reports.post())
    reports.run()
    assert get_graph_readers(reports.graph) == []
    reports.stage = None
    fresh = _accepted(reports.post())
    assert fresh["task_id"] != first["task_id"]


@pytest.mark.parametrize("log_method", ["error", "exception"])
def test_logging_failure_cannot_skip_worker_cleanup(reports, monkeypatch, log_method):
    reports.stage = "secondary" if log_method == "exception" else "generate"

    def broken_logger(*_args, **_kwargs):
        raise RuntimeError("logging failed")

    monkeypatch.setattr(report_api.logger, log_method, broken_logger)
    first = _accepted(reports.post())
    reports.run()
    assert len(reports.errors) == 1
    assert str(reports.errors[0]) == "logging failed"
    assert get_graph_readers(reports.graph) == []
    assert reports.sim not in report_api._active_report_jobs
    reports.stage = None
    assert _accepted(reports.post())["task_id"] != first["task_id"]


@pytest.mark.parametrize("startup", ["construct", "start"])
def test_startup_failure_fails_allocated_task_and_releases_claim(reports, startup):
    reports.startup = startup
    response = reports.post()
    assert response.status_code == 500
    assert "thread" in response.get_json()["error"]
    allocated = reports.tasks.list_tasks()
    assert len(allocated) == 1
    assert allocated[0]["status"] == "failed"
    assert get_graph_readers(reports.graph) == []
    assert reports.workers == []
    reports.startup = None
    fresh = _accepted(reports.post())
    assert fresh["task_id"] != allocated[0]["task_id"]


def test_reader_registration_failure_rolls_back_allocated_task(reports, monkeypatch):
    original = report_api.register_graph_reader

    def register_then_fail(graph_id, report_id):
        original(graph_id, report_id)
        raise RuntimeError("reader registration failed")

    monkeypatch.setattr(report_api, "register_graph_reader", register_then_fail)
    response = reports.post()
    assert response.status_code == 500
    assert get_graph_readers(reports.graph) == []
    assert reports.tasks.list_tasks()[0]["status"] == "failed"
    monkeypatch.setattr(report_api, "register_graph_reader", original)
    assert _accepted(reports.post())["status"] == "generating"


def test_stale_or_equal_value_cleanup_cannot_remove_new_owner(reports):
    _accepted(reports.post())
    owner = report_api._active_report_jobs[reports.sim]
    with pytest.raises(FrozenInstanceError):
        owner.report_id = "changed_report"
    equal_value_impostor = replace(owner)
    report_api._release_active_report(equal_value_impostor)
    assert report_api._active_report_jobs[reports.sim] is owner
    # A stale release may not even unregister another owner's matching reader.
    assert get_graph_readers(reports.graph) == [owner.report_id]
    reports.run()
    _accepted(reports.post())
    current = report_api._active_report_jobs[reports.sim]
    report_api._release_active_report(owner)
    report_api._release_active_report(owner)
    assert report_api._active_report_jobs[reports.sim] is current
    assert get_graph_readers(reports.graph) == [current.report_id]


def test_request_locale_error_allocates_no_task_or_reader(reports, monkeypatch):
    def unavailable_locale():
        raise RuntimeError("request locale failed")

    monkeypatch.setattr(report_api, "get_locale", unavailable_locale)
    response = reports.post()
    assert response.status_code == 500
    assert reports.tasks.list_tasks() == []
    assert reports.workers == []
    assert get_graph_readers(reports.graph) == []
    assert reports.sim not in report_api._active_report_jobs


@pytest.mark.parametrize("startup", ["construct", "start"])
def test_startup_failure_with_broken_failure_publication_still_cleans_up(reports, startup):
    reports.stage = "secondary"
    reports.startup = startup
    response = reports.post()
    assert response.status_code == 500
    assert get_graph_readers(reports.graph) == []
    assert reports.sim not in report_api._active_report_jobs
    # A broken TaskManager cannot guarantee a terminal task, but cannot retain
    # ownership or stop a later user request from making progress.
    reports.stage = reports.startup = None
    assert _accepted(reports.post())["already_running"] is False


def test_failed_startup_is_not_observed_as_a_reusable_job(reports, monkeypatch):
    in_start = threading.Event()
    retry_at_lock = threading.Event()
    finish_start = threading.Event()
    original_lock = report_api.graph_lifecycle_lock
    parked_thread = report_api.threading.Thread
    launches = 0

    class FailFirstStart(parked_thread):
        def start(self):
            nonlocal launches
            launches += 1
            if launches == 1:
                in_start.set()
                assert finish_start.wait(timeout=5)
                raise RuntimeError("first start failed")
            super().start()

    def observed_lock(graph_id):
        if threading.current_thread().name == "retry-admission":
            retry_at_lock.set()
        return original_lock(graph_id)

    monkeypatch.setattr(report_api, "threading", SimpleNamespace(Thread=FailFirstStart))
    monkeypatch.setattr(report_api, "graph_lifecycle_lock", observed_lock)
    responses = {}

    def request(key):
        responses[key] = reports.post()

    first = threading.Thread(target=request, args=("first",))
    retry = threading.Thread(target=request, args=("retry",), name="retry-admission")
    reports.request_threads.extend([first, retry])
    first.start()
    try:
        assert in_start.wait(timeout=5)
        retry.start()
        assert retry_at_lock.wait(timeout=5)
    finally:
        finish_start.set()
        first.join(timeout=5)
        if retry.ident is not None:
            retry.join(timeout=5)
    assert not first.is_alive() and not retry.is_alive()
    assert responses["first"].status_code == 500
    accepted = _accepted(responses["retry"])
    assert accepted["already_running"] is False
    assert sorted(task["status"] for task in reports.tasks.list_tasks()) == ["failed", "pending"]
    assert len(reports.workers) == 1
    assert get_graph_readers(reports.graph) == [accepted["report_id"]]


def test_worker_inference_holds_neither_admission_lock(reports, monkeypatch):
    generating = threading.Event()
    finish_generation = threading.Event()
    original_agent = report_api.ReportAgent

    class ParkedAgent(original_agent):
        def generate_report(self, **kwargs):
            generating.set()
            assert finish_generation.wait(timeout=5)
            return super().generate_report(**kwargs)

    monkeypatch.setattr(report_api, "ReportAgent", ParkedAgent)
    first = _accepted(reports.post())
    worker = threading.Thread(target=reports.run)
    reports.request_threads.append(worker)
    worker.start()
    try:
        assert generating.wait(timeout=5)
        # Both locks are required by this request. It must finish while the
        # worker is inside generation, rather than waiting for its result.
        retry_done = threading.Event()
        replies = []

        def retry():
            replies.append(reports.post())
            retry_done.set()

        request = threading.Thread(target=retry)
        reports.request_threads.append(request)
        request.start()
        assert retry_done.wait(timeout=5)
        _same_job(first, _accepted(replies[0]))
    finally:
        finish_generation.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert reports.errors == []
    assert get_graph_readers(reports.graph) == []


def test_active_claim_on_different_validated_graph_rejects_without_new_job(reports):
    first = _accepted(reports.post())
    other_graph = reports.graph + "_new"
    reports.project.graph_id = other_graph
    reports.states[reports.sim].graph_id = other_graph
    response = reports.post()
    assert response.status_code == 409
    assert "graph" in response.get_json()["error"].lower()
    assert len(reports.tasks.list_tasks()) == len(reports.workers) == 1
    assert get_graph_readers(reports.graph) == [first["report_id"]]
    assert get_graph_readers(other_graph) == []


@pytest.mark.parametrize("invalid", ["force", "active_run", "updater", "failed_run", "missing_run", "missing_project", "unfinished_graph", "missing_graph", "old_graph", "missing_requirement"])
def test_existing_validation_still_precedes_active_reuse(reports, invalid):
    first = _accepted(reports.post())
    force = True
    expected = 409
    if invalid == "force":
        force, expected = "true", 400
    elif invalid == "active_run":
        reports.runs[reports.sim].runner_status = RunnerStatus.RUNNING
    elif invalid == "updater":
        reports.updaters[reports.sim] = object()
    elif invalid == "failed_run":
        reports.runs[reports.sim].runner_status = RunnerStatus.FAILED
    elif invalid == "missing_run":
        reports.runs.pop(reports.sim)
    elif invalid == "missing_project":
        reports.projects.clear()
        expected = 404
    elif invalid == "unfinished_graph":
        reports.project.status = "not_completed"
    elif invalid == "missing_graph":
        reports.project.graph_id = None
        expected = 400
    elif invalid == "old_graph":
        reports.states[reports.sim].graph_id = "older_graph"
    elif invalid == "missing_requirement":
        reports.project.simulation_requirement = ""
        expected = 400
    response = reports.post(force)
    assert response.status_code == expected
    assert response.get_json()["success"] is False
    assert len(reports.tasks.list_tasks()) == len(reports.workers) == 1
    assert get_graph_readers(reports.graph) == [first["report_id"]]


@pytest.mark.parametrize("changed", ["simulation", "project", "graph", "run", "updater"])
def test_under_lock_revalidation_precedes_active_reuse(reports, monkeypatch, changed):
    first = _accepted(reports.post())
    original = report_api.graph_lifecycle_lock
    changed_once = False

    def mutate_before_lock(graph_id):
        nonlocal changed_once
        if not changed_once:
            changed_once = True
            if changed == "simulation":
                reports.states.pop(reports.sim)
            elif changed == "project":
                reports.projects.clear()
            elif changed == "graph":
                reports.project.graph_id = "replacement_graph"
            elif changed == "run":
                reports.runs[reports.sim].runner_status = RunnerStatus.FAILED
            elif changed == "updater":
                reports.updaters[reports.sim] = object()
        return original(graph_id)

    monkeypatch.setattr(report_api, "graph_lifecycle_lock", mutate_before_lock)
    response = reports.post()
    assert response.status_code == 409
    assert len(reports.tasks.list_tasks()) == len(reports.workers) == 1
    assert get_graph_readers(reports.graph) == [first["report_id"]]
