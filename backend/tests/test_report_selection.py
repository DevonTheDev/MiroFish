"""Saved report selection across real storage, Flask routes and synthetic chat."""

import json
import os
from pathlib import Path
from queue import Queue
import threading
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api import report as report_api, simulation as simulation_api
from app.models.project import ProjectStatus
from app.models.task import TaskManager, TaskStatus
from app.services.report_agent import Report, ReportAgent, ReportManager, ReportStatus
from app.services.simulation_runner import RunnerStatus
from app.utils.zep_lifecycle import get_graph_readers


@pytest.fixture(params=[False, True], ids=["forward", "reverse"])
def saved(tmp_path, monkeypatch, request):
    root = tmp_path / "configured_reports"
    root.mkdir()
    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(root))
    real_listdir = os.listdir

    def listdir(path):
        entries = real_listdir(path)
        if Path(path) == root:
            return sorted(entries, reverse=request.param)
        return entries

    monkeypatch.setattr(os, "listdir", listdir)

    def save(report_id, created_at, status=ReportStatus.COMPLETED,
             *, legacy=False, simulation_id="sim_selection"):
        report = Report(
            report_id, simulation_id, "graph_selection", "synthetic requirement",
            status, markdown_content=f"Saved content from {report_id}",
            created_at=created_at,
            error="synthetic failure" if status == ReportStatus.FAILED else None,
        )
        if legacy:
            (root / f"{report_id}.json").write_text(json.dumps(report.to_dict()))
        else:
            ReportManager.save_report(report)
        return report

    return SimpleNamespace(root=root, save=save)


@pytest.mark.parametrize("formats", [(False, False), (True, True), (False, True), (True, False)])
@pytest.mark.parametrize("statuses", [
    (ReportStatus.COMPLETED, ReportStatus.COMPLETED),
    (ReportStatus.FAILED, ReportStatus.COMPLETED),
    (ReportStatus.COMPLETED, ReportStatus.FAILED),
    (ReportStatus.COMPLETED, ReportStatus.GENERATING),
    (ReportStatus.COMPLETED, ReportStatus.PENDING),
])
def test_latest_saved_record_is_independent_of_order_format_and_status(saved, formats, statuses):
    older = saved.save("report_a", "2026-01-01", statuses[0], legacy=formats[0])
    newer = saved.save("report_b", "2026-01-02", statuses[1], legacy=formats[1])
    saved.save("report_other", "2027-01-01", simulation_id="sim_other")

    selected = ReportManager.get_report_by_simulation("sim_selection")
    assert selected.report_id == newer.report_id
    assert selected.status == statuses[1]
    assert [r.report_id for r in ReportManager.list_reports("sim_selection")] == [
        newer.report_id, older.report_id,
    ]
    assert ReportManager.get_report(older.report_id).markdown_content == older.markdown_content
    assert ReportManager.get_report_by_simulation("sim_absent") is None
    assert ReportManager.list_reports("sim_absent") == []


@pytest.mark.parametrize("created_at", ["2026-01-01", "", " \t", None, 17, [], {}])
def test_equal_or_unavailable_dates_have_a_stable_id_tiebreaker(saved, created_at):
    saved.save("report_a", created_at)
    saved.save("report_b", created_at, legacy=True)
    assert [r.report_id for r in ReportManager.list_reports("sim_selection")] == [
        "report_b", "report_a",
    ]
    assert ReportManager.get_report_by_simulation("sim_selection").report_id == "report_b"


@pytest.mark.parametrize("unavailable", ["", " \t", None, 17, [], {}])
def test_unavailable_dates_sort_below_recorded_dates(saved, unavailable):
    saved.save("report_z", unavailable, legacy=True)
    saved.save("report_a", "2026-01-01")
    assert [r.report_id for r in ReportManager.list_reports()] == ["report_a", "report_z"]
    assert ReportManager.get_report_by_simulation("sim_selection").report_id == "report_a"
    assert [r.report_id for r in ReportManager.list_reports(limit=1)] == ["report_a"]


def test_blank_dates_and_missing_dates_share_the_id_tiebreaker(saved):
    saved.save("report_z", "")
    saved.save("report_a", " \t", legacy=True)
    missing = saved.save("report_m", None, legacy=True).to_dict()
    del missing["created_at"]
    (saved.root / "report_m.json").write_text(json.dumps(missing))
    assert [r.report_id for r in ReportManager.list_reports()] == [
        "report_z", "report_m", "report_a",
    ]


def test_recorded_date_strings_keep_the_existing_lexical_convention(saved):
    # Mixed offsets are deliberately not normalized into a new chronology policy.
    saved.save("report_a", "2026-01-01T10:00:00+10:00")
    saved.save("report_z", "2026-01-01T09:00:00+00:00", legacy=True)
    assert ReportManager.get_report_by_simulation("sim_selection").report_id == "report_a"


@pytest.mark.parametrize("legacy", [False, True])
def test_history_uses_configured_root_and_the_same_latest_record(saved, monkeypatch, legacy):
    saved.save("report_a", "2026-01-01")
    saved.save("report_b", "2026-01-02", ReportStatus.FAILED, legacy=legacy)
    state = SimpleNamespace(
        simulation_id="sim_selection", project_id="project_selection",
        to_dict=lambda: {"simulation_id": "sim_selection", "created_at": "2026-01-01"},
    )
    monkeypatch.setattr(simulation_api, "SimulationManager", lambda: SimpleNamespace(
        list_simulations=lambda: [state], get_simulation_config=lambda _id: None,
    ))
    monkeypatch.setattr(simulation_api.SimulationRunner, "get_run_state", lambda _id: None)
    monkeypatch.setattr(simulation_api.ProjectManager, "get_project", lambda _id: None)
    app = Flask(__name__)
    app.register_blueprint(simulation_api.simulation_bp, url_prefix="/api/simulation")
    response = app.test_client().get("/api/simulation/history")
    assert response.status_code == 200
    assert response.get_json()["data"][0]["report_id"] == "report_b"
    assert simulation_api._get_report_id_for_simulation("sim_absent") is None


def test_selection_and_history_ignore_symlinked_records(saved, tmp_path):
    saved.save("report_a", "2026-01-01")
    outside = tmp_path / "outside"
    outside.mkdir()
    report = Report("report_z", "sim_selection", "graph_selection", "synthetic",
                    ReportStatus.COMPLETED, created_at="2027-01-01")
    (outside / "meta.json").write_text(json.dumps(report.to_dict()))
    try:
        (saved.root / "report_z").symlink_to(outside, target_is_directory=True)
        (saved.root / "report_y.json").symlink_to(outside / "meta.json")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")
    assert ReportManager.get_report_by_simulation("sim_selection").report_id == "report_a"
    assert [r.report_id for r in ReportManager.list_reports()] == ["report_a"]
    assert simulation_api._get_report_id_for_simulation("sim_selection") == "report_a"


@pytest.fixture
def routes(saved, monkeypatch):
    """Real worker, tasks, leases and report storage; inference waits on an event."""
    monkeypatch.setattr(TaskManager, "_instance", None)
    tasks = TaskManager()
    entered = Queue()
    workers = []
    started = threading.Event()
    project = SimpleNamespace(
        graph_id="graph_selection", status=ProjectStatus.GRAPH_COMPLETED,
        simulation_requirement="synthetic requirement",
    )
    state = SimpleNamespace(project_id="project_selection", graph_id=project.graph_id)
    monkeypatch.setattr(report_api, "SimulationManager", lambda: SimpleNamespace(
        get_simulation=lambda _id: state,
    ))
    monkeypatch.setattr(report_api.ProjectManager, "get_project", lambda _id: project)
    monkeypatch.setattr(report_api.SimulationRunner, "get_run_state", lambda _id: SimpleNamespace(
        runner_status=RunnerStatus.COMPLETED,
    ))
    monkeypatch.setattr(report_api.ZepGraphMemoryManager, "get_updater", lambda _id: None)

    class SyntheticAgent:
        def __init__(self, **_kwargs):
            self.worker = SimpleNamespace(thread=threading.current_thread(), release=threading.Event())
            workers.append(self.worker)
            started.set()

        def generate_report(self, *, report_id, progress_callback):
            entered.put(self.worker)
            assert self.worker.release.wait(timeout=10), "synthetic inference was not released"
            return Report(report_id, "sim_selection", "graph_selection", "synthetic",
                          ReportStatus.COMPLETED, markdown_content="Synthetic new report",
                          created_at="2026-02-01")

    monkeypatch.setattr(report_api, "ReportAgent", SyntheticAgent)
    app = Flask(__name__)
    app.register_blueprint(report_api.report_bp, url_prefix="/api/report")
    runtime = SimpleNamespace(client=app.test_client(), tasks=tasks, entered=entered, workers=workers)
    yield runtime
    if tasks.list_tasks():
        assert started.wait(timeout=5), "allocated report worker did not enter inference"
    for worker in workers:
        worker.release.set()
        worker.thread.join(timeout=5)
        assert not worker.thread.is_alive()
    assert get_graph_readers("graph_selection") == []
    assert "sim_selection" not in report_api._active_report_jobs


def generate(routes, force=False):
    response = routes.client.post("/api/report/generate", json={
        "simulation_id": "sim_selection", "force_regenerate": force,
    })
    assert response.status_code == 200, response.get_json()
    return response.get_json()["data"]


@pytest.mark.parametrize("older_status", [ReportStatus.COMPLETED, ReportStatus.FAILED])
def test_latest_completed_is_reused_without_allocating_a_task_or_worker(saved, routes, older_status):
    saved.save("report_a", "2026-01-01", older_status)
    saved.save("report_b", "2026-01-02", legacy=True)
    result = generate(routes)
    assert result["report_id"] == "report_b"
    assert result["already_generated"] is True
    assert routes.tasks.list_tasks() == []
    assert routes.workers == []
    assert get_graph_readers("graph_selection") == []
    check = routes.client.get("/api/report/check/sim_selection").get_json()["data"]
    assert check["report_id"] == "report_b"
    assert check["interview_unlocked"] is True
    by_simulation = routes.client.get("/api/report/by-simulation/sim_selection").get_json()["data"]
    assert by_simulation["report_id"] == "report_b"
    status = routes.client.post("/api/report/generate/status", json={
        "simulation_id": "sim_selection",
    }).get_json()["data"]
    assert status["report_id"] == "report_b"
    direct = routes.client.get("/api/report/report_a").get_json()["data"]
    assert direct["report_id"] == "report_a"


def test_latest_failed_is_visible_and_deliberate_generation_starts_one_worker(saved, routes):
    saved.save("report_a", "2026-01-01")
    saved.save("report_b", "2026-01-02", ReportStatus.FAILED, legacy=True)
    check = routes.client.get("/api/report/check/sim_selection").get_json()["data"]
    assert check["report_id"] == "report_b"
    assert check["report_status"] == "failed"
    assert check["interview_unlocked"] is False
    by_simulation = routes.client.get("/api/report/by-simulation/sim_selection").get_json()["data"]
    assert by_simulation["report_id"] == "report_b"
    assert by_simulation["status"] == "failed"
    assert routes.tasks.list_tasks() == routes.workers == []
    result = generate(routes)
    worker = routes.entered.get(timeout=5)
    assert result["already_generated"] is False
    assert result["already_running"] is False
    assert len(routes.tasks.list_tasks()) == len(routes.workers) == 1
    assert get_graph_readers("graph_selection") == [result["report_id"]]
    worker.release.set()
    worker.thread.join(timeout=5)
    assert not worker.thread.is_alive()
    assert routes.tasks.get_task(result["task_id"]).status == TaskStatus.COMPLETED
    assert ReportManager.get_report(result["report_id"]).markdown_content == "Synthetic new report"
    assert get_graph_readers("graph_selection") == []


@pytest.mark.parametrize("first_force", [False, True])
@pytest.mark.parametrize("retry_force", [False, True])
def test_active_worker_keeps_ownership_over_completed_saved_reports(saved, routes, first_force, retry_force):
    saved.save("report_a", "2026-01-01")
    saved.save("report_b", "2026-01-02", ReportStatus.FAILED, legacy=True)
    first = generate(routes, first_force)
    assert first["already_generated"] is False
    worker = routes.entered.get(timeout=5)
    # A completed record appearing while inference is parked must not take ownership.
    saved.save("report_c", "2026-01-03")
    retry = generate(routes, retry_force)
    assert retry["already_running"] is True
    assert retry["already_generated"] is False
    assert retry["task_id"] == first["task_id"]
    assert retry["report_id"] == first["report_id"]
    assert worker.thread.is_alive()
    assert len(routes.tasks.list_tasks()) == len(routes.workers) == 1
    assert get_graph_readers("graph_selection") == [first["report_id"]]


def test_chat_prompt_uses_latest_saved_report_text(saved):
    older = saved.save("report_a", "2026-01-01")
    newer = saved.save("report_b", "2026-01-02", legacy=True)
    prompts = []

    def synthetic_chat(*, messages, **_kwargs):
        prompts.append(messages)
        return "Synthetic answer"

    agent = ReportAgent(
        "graph_selection", "sim_selection", "synthetic requirement",
        llm_client=SimpleNamespace(chat=synthetic_chat), zep_tools=SimpleNamespace(),
    )
    result = agent.chat("Summarize the saved report")
    assert result["response"] == "Synthetic answer"
    assert len(prompts) == 1
    assert newer.markdown_content in prompts[0][0]["content"]
    assert older.markdown_content not in prompts[0][0]["content"]


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("bad_simulation", ["sim_selection", "sim_unrelated"])
@pytest.mark.parametrize("valid_status", [ReportStatus.FAILED, ReportStatus.GENERATING])
@pytest.mark.parametrize("damage", ["json", "required_field", "status", "object", "outline", "read"])
def test_history_alone_tolerates_unreadable_records(
    saved, routes, legacy, bad_simulation, valid_status, damage,
):
    saved.save("report_a", "2026-01-01")
    saved.save("report_b", "2026-01-02", valid_status, legacy=not legacy)
    broken = saved.save("report_z", "2027-01-01", legacy=legacy,
                        simulation_id=bad_simulation).to_dict()
    path = saved.root / ("report_z.json" if legacy else "report_z/meta.json")
    if damage == "json":
        path.write_text('{"report_id":')
    elif damage == "read":
        path.unlink()
        path.mkdir()  # A real per-record open failure, independent of user permissions.
        if legacy:
            # Legacy enumeration admits ordinary files only; use a modern unreadable
            # metadata file to exercise the same read error for this layout.
            path.rmdir()
            path = saved.root / "report_z" / "meta.json"
            path.mkdir(parents=True)
    else:
        if damage == "required_field":
            del broken["graph_id"]
        elif damage == "status":
            broken["status"] = "invalid_status"
        elif damage == "object":
            broken = []
        elif damage == "outline":
            broken["outline"] = {"title": "Broken", "summary": "Broken", "sections": ["invalid"]}
        path.write_text(json.dumps(broken))

    errors = (OSError, ValueError, KeyError, TypeError, AttributeError)
    with pytest.raises(errors):
        ReportManager.get_report("report_z")
    with pytest.raises(errors):
        ReportManager.get_report_by_simulation("sim_selection")
    with pytest.raises(errors):
        ReportManager.list_reports("sim_selection")
    assert ReportManager.get_report("report_a").status == ReportStatus.COMPLETED
    for endpoint in ("by-simulation/sim_selection", "check/sim_selection"):
        assert routes.client.get(f"/api/report/{endpoint}").status_code == 500
    assert routes.client.post("/api/report/generate", json={
        "simulation_id": "sim_selection",
    }).status_code == 500
    assert routes.tasks.list_tasks() == routes.workers == []
    assert simulation_api._get_report_id_for_simulation("sim_selection") == "report_b"


def test_chat_does_not_fallback_past_unreadable_newer_report(saved):
    older = saved.save("report_a", "2026-01-01")
    saved.save("report_b", "2026-01-02", legacy=True)
    (saved.root / "report_b.json").write_text('{"report_id":')
    prompts = []

    def synthetic_chat(*, messages, **_kwargs):
        prompts.append(messages)
        return "Synthetic answer without saved context"

    agent = ReportAgent(
        "graph_selection", "sim_selection", "synthetic requirement",
        llm_client=SimpleNamespace(chat=synthetic_chat), zep_tools=SimpleNamespace(),
    )
    assert agent.chat("Summarize")['response'] == "Synthetic answer without saved context"
    assert len(prompts) == 1
    assert older.markdown_content not in prompts[0][0]["content"]


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("bad_simulation", ["sim_selection", "sim_unrelated"])
@pytest.mark.parametrize("loaded_id", [17, None, [], {}])
def test_history_alone_skips_non_string_report_ids_at_equal_dates(
    saved, legacy, bad_simulation, loaded_id,
):
    saved.save("report_a", "2026-01-01")
    saved.save("report_b", "2026-01-02", ReportStatus.FAILED, legacy=not legacy)
    broken = saved.save("report_z", "2026-01-02", legacy=legacy,
                        simulation_id=bad_simulation).to_dict()
    broken["report_id"] = loaded_id
    path = saved.root / ("report_z.json" if legacy else "report_z/meta.json")
    path.write_text(json.dumps(broken))

    # Direct-ID access keeps its existing deserialization behavior.
    assert ReportManager.get_report("report_z").report_id == loaded_id
    assert simulation_api._get_report_id_for_simulation("sim_selection") == "report_b"
    with pytest.raises(TypeError):
        ReportManager.get_report_by_simulation("sim_selection")
    with pytest.raises(TypeError):
        ReportManager.list_reports("sim_selection")
