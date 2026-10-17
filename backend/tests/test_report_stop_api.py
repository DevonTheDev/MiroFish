"""Local report Stop route/lifecycle qualification with real locks and barriers.

These drafts use only synthetic inference, bounded event waits, and temporary
report files. They intentionally reuse the pinned admission harnesses unchanged.
"""

from datetime import datetime, timedelta
from pathlib import Path
from queue import Queue
import threading
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api import report as api
from app.models.task import TaskManager, TaskStatus
from app.services import report_control, saved_reports
from app.services.report_agent import Report, ReportManager, ReportStatus
from app.services.report_control import ReportCancelled, ReportControl
from app.utils.zep_lifecycle import get_graph_readers
from test_report_active_jobs import reports, _accepted
from test_report_active_threads import live_reports, WAIT_SECONDS


REAL_SAVE = ReportManager.save_report


def body(response, status=200):
    assert response.status_code == status, response.get_json()
    assert response.get_json()["success"] is True
    return response.get_json()["data"]


def client_for_routes():
    app = Flask(__name__)
    app.register_blueprint(api.report_bp, url_prefix="/api/report")
    return app.test_client()


@pytest.fixture
def stop_reports(live_reports, monkeypatch, tmp_path):
    """Actual HTTP admission threads and API worker threads; synthetic agent."""
    runtime = live_reports
    monkeypatch.setattr(api.Config, "LOCAL_MODE", True)
    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(tmp_path / "reports"))
    runtime.root = tmp_path / "reports"
    runtime.persisted = []
    runtime.close_entered = threading.Event()
    runtime.close_release = threading.Event()
    runtime.close_release.set()
    runtime.persist_error = None
    runtime.close_error = None
    runtime.client = client_for_routes()

    def save(report):
        runtime.persisted.append(report.to_dict())
        if runtime.persist_error:
            raise OSError(runtime.persist_error)
        REAL_SAVE(report)

    class Agent:
        def __init__(self, *, simulation_id, graph_id, control, terminal_callback,
                     simulation_requirement):
            self.control = control
            self.terminal_callback = terminal_callback
            self.requirement = simulation_requirement
            self.worker = SimpleNamespace(
                simulation_id=simulation_id, graph_id=graph_id,
                thread=threading.current_thread(), release=threading.Event(),
                report_id=None,
            )
            with runtime.guard:
                runtime.workers.append(self.worker)
                if runtime.closing:
                    self.worker.release.set()

        def generate_report(self, *, progress_callback, report_id):
            worker = self.worker
            worker.report_id = report_id
            report = Report(report_id, worker.simulation_id, worker.graph_id,
                            self.requirement, ReportStatus.GENERATING)
            runtime.entered.put(worker)

            def operation():
                assert worker.release.wait(timeout=WAIT_SECONDS * 2)
                if runtime.outcomes.get(worker.simulation_id) == "failed":
                    raise RuntimeError("synthetic admitted operation failed")
                return "returned content"

            try:
                returned = self.control.operation(operation)
                with self.control.commit():
                    try:
                        report.status = ReportStatus.COMPLETED
                        report.markdown_content = returned
                        save(report)
                        self.terminal_callback(report)
                        self.control.finish("completed")
                    except Exception as error:
                        self.control.finish("failed", error)
                        raise
            except Exception as error:
                with self.control.terminal():
                    state = self.control.snapshot()
                    status = state["terminal_status"] or (
                        "cancelled" if state["cancellation_requested"] else "failed")
                    report.status = ReportStatus(status)
                    report.markdown_content = ""
                    report.error = None if status == "cancelled" else str(error)
                    try:
                        save(report)
                        ReportManager.update_progress(report_id, status, 0, f"Report {status}")
                    except Exception as persistence_error:
                        self.control.record_error(persistence_error)
                        report.error = self.control.snapshot()["error"]
                    self.control.finish(status, report.error)
                    self.terminal_callback(report)
            finally:
                runtime.close_entered.set()
                assert runtime.close_release.wait(timeout=WAIT_SECONDS * 2)
                if runtime.close_error:
                    self.control.record_error(runtime.close_error)
            return report

    monkeypatch.setattr(api, "ReportAgent", Agent)
    monkeypatch.setattr(ReportManager, "save_report", save)
    yield runtime
    runtime.close_release.set()


def start(runtime, simulation_id=None):
    options = {} if simulation_id is None else {"simulation_id": simulation_id}
    accepted = runtime.receive(runtime.start_request(**options))
    worker = runtime.entered.get(timeout=WAIT_SECONDS)
    return accepted, worker


def cancel(runtime, accepted, status=202):
    return body(runtime.client.post(f"/api/report/{accepted['report_id']}/cancel"), status)


def progress(runtime, accepted, status=200):
    return body(runtime.client.get(f"/api/report/{accepted['report_id']}/progress"), status)


def assert_cancelling(data, accepted):
    assert {key: data[key] for key in ("report_id", "task_id", "simulation_id")} == {
        key: accepted[key] for key in ("report_id", "task_id", "simulation_id")}
    assert data["status"] == "cancelling"
    assert data["worker_active"] is True
    assert data["cancellation_requested"] is True
    assert data["cancellation_supported"] is True
    assert data["terminal_status"] is None


def test_import_inventory_uses_candidate_sources():
    backend = Path(__file__).resolve().parents[1]
    assert Path(api.__file__).resolve() == backend / "app/api/report.py"
    assert Path(report_control.__file__).resolve() == backend / "app/services/report_control.py"
    assert Path(saved_reports.__file__).resolve() == backend / "app/services/saved_reports.py"


@pytest.mark.parametrize("throws", [False, True])
def test_admitted_operation_can_finish_but_return_and_error_are_retired(throws):
    control = ReportControl()
    entered, release = threading.Event(), threading.Event()
    result = Queue()
    physical_calls = []

    def operation():
        entered.set()
        assert release.wait(timeout=WAIT_SECONDS)
        # An already-admitted compound tool may do more internal work after
        # cancellation. This expected limit is not provider transport abort.
        physical_calls.append("nested call after cancellation")
        if throws:
            raise RuntimeError("late provider error")
        return "late provider text"

    def run():
        try:
            result.put(control.operation(operation))
        except Exception as error:
            result.put(error)

    thread = threading.Thread(target=run)
    thread.start()
    try:
        assert entered.wait(timeout=WAIT_SECONDS)
        assert control.request_cancel()["cancellation_requested"] is True
    finally:
        release.set()
        thread.join(timeout=WAIT_SECONDS)
    assert not thread.is_alive()
    assert isinstance(result.get_nowait(), ReportCancelled)
    assert physical_calls == ["nested call after cancellation"]
    with pytest.raises(ReportCancelled):
        control.operation(lambda: pytest.fail("later operation was admitted"))
    with pytest.raises(ReportCancelled):
        with control.commit():
            pytest.fail("later publication was admitted")


def test_cancel_before_first_file_keeps_exact_task_and_lease(stop_reports):
    runtime = stop_reports
    accepted, worker = start(runtime)
    assert not runtime.root.exists()
    assert_cancelling(cancel(runtime, accepted), accepted)
    assert_cancelling(cancel(runtime, accepted), accepted)
    assert_cancelling(progress(runtime, accepted), accepted)
    assert worker.thread.is_alive()
    assert get_graph_readers(runtime.graph_id) == [accepted["report_id"]]
    assert runtime.tasks.get_task(accepted["task_id"]).status == TaskStatus.PROCESSING
    retry = runtime.receive(runtime.start_request(force=True))
    assert_cancelling(retry, accepted)
    assert retry["already_running"] is True
    runtime.finish(worker)
    retired = progress(runtime, accepted)
    assert retired["status"] == retired["terminal_status"] == "cancelled"
    assert retired["worker_active"] is False
    assert cancel(runtime, accepted, 200)["status"] == "cancelled"
    assert get_graph_readers(runtime.graph_id) == []
    assert not (runtime.root / accepted["report_id"] / "full_report.md").exists()
    assert len(runtime.persisted) == 1
    assert runtime.persisted[0]["markdown_content"] == ""
    assert runtime.persisted[0]["status"] == "cancelled"
    assert ReportManager.get_generated_sections(accepted["report_id"]) == []


def test_terminal_save_and_task_do_not_retire_until_logger_and_cleanup(stop_reports):
    runtime = stop_reports
    runtime.close_release.clear()
    accepted, worker = start(runtime)
    old_job = api._find_report_job(accepted["report_id"])
    cancel(runtime, accepted)
    worker.release.set()
    try:
        assert runtime.close_entered.wait(timeout=WAIT_SECONDS)
        assert ReportManager.get_report(accepted["report_id"]).status == ReportStatus.CANCELLED
        assert runtime.tasks.get_task(accepted["task_id"]).status == TaskStatus.CANCELLED
        assert_cancelling(cancel(runtime, accepted), accepted)
        assert_cancelling(progress(runtime, accepted), accepted)
        runtime.cache[runtime.simulation_id] = SimpleNamespace(
            report_id="report_older_completed", status=ReportStatus.COMPLETED,
        )
        for query in (
            {"task_id": accepted["task_id"]},
            {"simulation_id": accepted["simulation_id"]},
            {"task_id": accepted["task_id"], "simulation_id": accepted["simulation_id"]},
        ):
            assert_cancelling(body(runtime.client.post(
                "/api/report/generate/status", json=query,
            )), accepted)
        assert_cancelling(runtime.receive(runtime.start_request()), accepted)
        assert get_graph_readers(runtime.graph_id) == [accepted["report_id"]]
    finally:
        runtime.close_release.set()
        runtime.finish(worker)
    fresh, fresh_worker = start(runtime)
    assert fresh["report_id"] != accepted["report_id"]
    assert cancel(runtime, accepted, 200)["worker_active"] is False
    api._release_active_report(old_job)
    api._release_active_report(old_job)
    assert api._find_report_job(fresh["report_id"]) is not None
    assert get_graph_readers(runtime.graph_id) == [fresh["report_id"]]
    assert progress(runtime, fresh)["cancellation_requested"] is False
    runtime.finish(fresh_worker)


@pytest.mark.parametrize("failure", ["operation", "persistence", "logger_close"])
def test_cancelled_failure_retains_exact_task_error_and_releases(stop_reports, failure):
    runtime = stop_reports
    accepted, worker = start(runtime)
    if failure == "operation":
        runtime.outcomes[runtime.simulation_id] = "failed"
    elif failure == "persistence":
        runtime.persist_error = "cancel metadata storage failed"
    else:
        runtime.close_error = "logger close failed"
    cancel(runtime, accepted)
    runtime.finish(worker)
    state = progress(runtime, accepted)
    assert state["status"] == "cancelled"
    assert state["worker_active"] is False
    assert state["error"] == ({"persistence": "cancel metadata storage failed",
                               "logger_close": "logger close failed"}.get(failure))
    assert get_graph_readers(runtime.graph_id) == []
    assert runtime.simulation_id not in api._active_report_jobs


@pytest.mark.parametrize("outcome", ["completed", "failed"])
def test_terminal_winner_is_not_relabelled_by_late_cancel(stop_reports, outcome):
    runtime = stop_reports
    runtime.close_release.clear()
    runtime.outcomes[runtime.simulation_id] = outcome
    accepted, worker = start(runtime)
    worker.release.set()
    try:
        assert runtime.close_entered.wait(timeout=WAIT_SECONDS)
        state = cancel(runtime, accepted, 200)
        assert state["status"] == state["terminal_status"] == outcome
        assert state["worker_active"] is True
        assert state["cancellation_requested"] is False
    finally:
        runtime.close_release.set()
        runtime.finish(worker)
    assert cancel(runtime, accepted, 200)["status"] == outcome
    assert progress(runtime, accepted)["worker_active"] is False
    # The local API must not perform its old second save after the agent returns.
    assert len(runtime.persisted) == 1


def test_completed_logger_failure_is_visible_without_relabelling(stop_reports):
    runtime = stop_reports
    runtime.close_error = "completed logger close failed"
    accepted, worker = start(runtime)
    runtime.finish(worker)
    state = progress(runtime, accepted)
    assert state["status"] == "completed"
    assert state["error"] == runtime.close_error


def test_exact_old_task_observation_cannot_retarget_new_generation(stop_reports):
    runtime = stop_reports
    old, old_worker = start(runtime)
    cancel(runtime, old)
    runtime.finish(old_worker)
    fresh, fresh_worker = start(runtime)
    response = runtime.client.post("/api/report/generate/status", json={
        "task_id": old["task_id"], "simulation_id": runtime.simulation_id})
    assert body(response)["report_id"] == old["report_id"]
    assert body(response)["status"] == "cancelled"
    assert cancel(runtime, old, 200)["report_id"] == old["report_id"]
    assert progress(runtime, fresh)["cancellation_requested"] is False
    runtime.finish(fresh_worker)


def test_distinct_simulations_cancel_independently_on_shared_graph(stop_reports):
    runtime = stop_reports
    other = runtime.simulation_id + "_other"
    runtime.states[other] = runtime.states[runtime.simulation_id]
    runtime.runs[other] = runtime.runs[runtime.simulation_id]
    first, worker = start(runtime)
    second, second_worker = start(runtime, other)
    cancel(runtime, first)
    assert progress(runtime, second)["cancellation_requested"] is False
    runtime.finish(worker)
    assert get_graph_readers(runtime.graph_id) == [second["report_id"]]
    assert second_worker.thread.is_alive()
    runtime.finish(second_worker)
    assert progress(runtime, second)["status"] == "completed"


def test_prestart_cancel_never_constructs_agent(reports, monkeypatch, tmp_path):
    monkeypatch.setattr(api.Config, "LOCAL_MODE", True)
    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(tmp_path / "reports"))
    monkeypatch.setattr(ReportManager, "save_report", REAL_SAVE)
    monkeypatch.setattr(api, "ReportAgent", lambda **_kwargs: pytest.fail("cancelled initialization began"))
    accepted = _accepted(reports.post())
    client = client_for_routes()
    assert body(client.post(f"/api/report/{accepted['report_id']}/cancel"), 202)["status"] == "cancelling"
    assert not (tmp_path / "reports").exists()
    reports.run()
    assert reports.tasks.get_task(accepted["task_id"]).status == TaskStatus.CANCELLED
    assert ReportManager.get_report(accepted["report_id"]).outline is None
    assert get_graph_readers(reports.graph) == []
    events = ReportManager.get_agent_log_stream(accepted["report_id"])
    assert [event["action"] for event in events] == ["report_cancelled"]


@pytest.mark.parametrize("startup", ["construct", "start"])
def test_local_startup_failure_releases_and_exact_task_is_observable(reports, monkeypatch, startup):
    monkeypatch.setattr(api.Config, "LOCAL_MODE", True)
    reports.startup = startup
    response = reports.post()
    assert response.status_code == 500
    task = reports.tasks.list_tasks()[0]
    assert task["status"] == "failed"
    client = client_for_routes()
    observed = body(client.get(f"/api/report/{task['metadata']['report_id']}/progress"))
    assert observed["status"] == "failed" and observed["worker_active"] is False
    assert observed["error"] == f"thread {'construction' if startup == 'construct' else 'start'} failed"
    assert reports.sim not in api._active_report_jobs
    assert get_graph_readers(reports.graph) == []


def test_unowned_saved_nonterminal_is_not_inferred_cancelled(stop_reports):
    runtime = stop_reports
    report = Report("report_unowned", runtime.simulation_id, runtime.graph_id,
                    "saved after another process", ReportStatus.GENERATING)
    REAL_SAVE(report)
    for method, path in (("post", "/cancel"), ("get", "/progress")):
        response = getattr(runtime.client, method)("/api/report/report_unowned" + path)
        assert response.status_code == 409
        data = response.get_json()
        assert data["error_code"] == "no_active_report_job"
        assert data["data"]["worker_active"] is False
        assert data["data"]["cancellation_requested"] is False
    assert runtime.client.post("/api/report/report_missing/cancel").status_code == 404
    assert runtime.client.get("/api/report/report_missing/progress").status_code == 404


def test_cloud_generation_and_duplicate_save_remain_original(live_reports, monkeypatch):
    runtime = live_reports
    monkeypatch.setattr(api.Config, "LOCAL_MODE", False)
    accepted, worker = start(runtime)
    client = client_for_routes()
    response = client.post(f"/api/report/{accepted['report_id']}/cancel")
    assert response.status_code == 409
    assert response.get_json()["error_code"] == "report_cancellation_unsupported"
    assert api._find_report_job(accepted["report_id"]).control is None
    monkeypatch.setattr(ReportManager, "get_progress", lambda _id: {"status": "generating"})
    observation = body(client.get(f"/api/report/{accepted['report_id']}/progress"))
    assert observation["cancellation_supported"] is False
    assert observation["report_id"] == accepted["report_id"]
    runtime.finish(worker)
    assert runtime.tasks.get_task(accepted["task_id"]).status == TaskStatus.COMPLETED
    assert [report.report_id for report in runtime.saved] == [accepted["report_id"]]


def test_cancelled_saved_report_status_and_filter_round_trip(stop_reports):
    runtime = stop_reports
    accepted, worker = start(runtime)
    cancel(runtime, accepted)
    runtime.finish(worker)
    page = saved_reports.list_saved_reports(runtime.root, status="cancelled")
    assert page["matched_count"] == 1
    row = page["reports"][0]
    assert row["status"] == "cancelled"
    assert saved_reports.read_saved_report(runtime.root, accepted["report_id"])["status"] == "cancelled"
    response = runtime.client.get("/api/report/library/records?status=cancelled")
    assert body(response)["reports"][0]["report_id"] == accepted["report_id"]
    assert runtime.client.get("/api/report/library/records?status=not-a-status").status_code == 400


def test_task_cleanup_includes_cancelled_only_after_age(monkeypatch):
    monkeypatch.setattr(TaskManager, "_instance", None)
    tasks = TaskManager()
    old = tasks.create_task("report_generate")
    recent = tasks.create_task("report_generate")
    pending = tasks.create_task("report_generate")
    for task_id in (old, recent):
        tasks.update_task(task_id, status=TaskStatus.CANCELLED)
    for task_id in (old, pending):
        tasks.get_task(task_id).created_at = datetime.now() - timedelta(hours=25)
    tasks.cleanup_old_tasks()
    assert tasks.get_task(old) is None
    assert tasks.get_task(recent).status == TaskStatus.CANCELLED
    assert tasks.get_task(pending).status == TaskStatus.PENDING


@pytest.mark.parametrize("terminal", ["completed", "failed"])
def test_terminal_commit_wins_cancellation_waiting_on_same_fence(terminal):
    control = ReportControl()
    entered, release, cancel_attempted = (threading.Event() for _ in range(3))
    outcomes = Queue()

    def publish():
        with control.commit():
            entered.set()
            assert release.wait(timeout=WAIT_SECONDS)
            control.finish(terminal, "terminal write failed" if terminal == "failed" else None)

    def request_cancel():
        cancel_attempted.set()
        outcomes.put(control.request_cancel())

    publisher = threading.Thread(target=publish)
    canceller = threading.Thread(target=request_cancel)
    publisher.start()
    try:
        assert entered.wait(timeout=WAIT_SECONDS)
        canceller.start()
        assert cancel_attempted.wait(timeout=WAIT_SECONDS)
    finally:
        release.set()
        publisher.join(timeout=WAIT_SECONDS)
        if canceller.ident is not None:
            canceller.join(timeout=WAIT_SECONDS)
    assert not publisher.is_alive() and not canceller.is_alive()
    observed = outcomes.get_nowait()
    assert observed["terminal_status"] == terminal
    assert observed["cancellation_requested"] is False


@pytest.mark.parametrize("stage", ["locale", "initial_update", "construct"])
def test_local_initialization_failure_publishes_exact_failed_outcome(reports, monkeypatch, tmp_path, stage):
    monkeypatch.setattr(api.Config, "LOCAL_MODE", True)
    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(tmp_path / "reports"))
    monkeypatch.setattr(ReportManager, "save_report", REAL_SAVE)
    reports.stage = stage
    accepted = _accepted(reports.post())
    reports.run()
    state = body(client_for_routes().get(f"/api/report/{accepted['report_id']}/progress"))
    assert state["status"] == "failed"
    assert state["worker_active"] is False
    assert state["error"]
    assert get_graph_readers(reports.graph) == []


def test_task_callback_failure_is_recovered_without_resaving_report(stop_reports, monkeypatch):
    runtime = stop_reports
    accepted, worker = start(runtime)
    monkeypatch.setattr(api, "_publish_local_task", lambda *_args: (_ for _ in ()).throw(
        RuntimeError("terminal task callback failed")))
    cancel(runtime, accepted)
    runtime.finish(worker)
    state = progress(runtime, accepted)
    assert state["status"] == "cancelled"
    assert state["error"] == "terminal task callback failed"
    assert state["worker_active"] is False
    assert len(runtime.persisted) == 1


def test_saved_progress_details_survive_authoritative_live_and_terminal_observation(stop_reports, monkeypatch):
    runtime = stop_reports
    accepted, worker = start(runtime)
    details = {
        "current_section": "Earlier section", "completed_sections": ["Committed section"],
        "updated_at": "2026-10-16T01:02:03", "report_id": "report_wrong",
        "task_id": "task_wrong", "simulation_id": "sim_wrong", "status": "completed",
        "terminal_status": "completed", "worker_active": False,
        "cancellation_requested": False, "cancellation_supported": False,
    }
    monkeypatch.setattr(ReportManager, "get_progress", lambda _id: dict(details))
    assert_cancelling(cancel(runtime, accepted), accepted)
    live = progress(runtime, accepted)
    assert_cancelling(live, accepted)
    for key in ("current_section", "completed_sections", "updated_at"):
        assert live[key] == details[key]
    runtime.finish(worker)
    # Exact terminal task precedence must preserve the old optional detail
    # fields, while rejecting stale file identity, success, and capability.
    terminal = progress(runtime, accepted)
    assert terminal["status"] == terminal["terminal_status"] == "cancelled"
    assert terminal["worker_active"] is False
    assert terminal["cancellation_requested"] is True
    assert terminal["cancellation_supported"] is True
    for key in ("report_id", "task_id", "simulation_id"):
        assert terminal[key] == accepted[key]
    for key in ("current_section", "completed_sections", "updated_at"):
        assert terminal[key] == details[key]


def test_unreadable_saved_progress_does_not_hide_live_or_exact_terminal_task(stop_reports, monkeypatch):
    runtime = stop_reports
    accepted, worker = start(runtime)

    def unavailable(_report_id):
        raise OSError("synthetic progress read failed")

    monkeypatch.setattr(ReportManager, "get_progress", unavailable)
    assert_cancelling(cancel(runtime, accepted), accepted)
    assert_cancelling(progress(runtime, accepted), accepted)
    runtime.finish(worker)
    terminal = progress(runtime, accepted)
    assert terminal["status"] == "cancelled"
    assert terminal["worker_active"] is False
    assert terminal["error"] is None
