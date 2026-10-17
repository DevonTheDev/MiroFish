"""Source-only draft of cooperative report-stop qualification.

The real ReportAgent planning/ReACT/generation methods, ReportControl, structured
logger, and ReportManager write into pytest temporary directories. Only model,
graph/tool, and deliberately selected race/failure boundaries are synthetic.
Every worker and wait is finite; no provider, simulation, network, or sleep is
used. This module has NOT been imported, collected, or executed for this packet.
"""

from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from app.config import Config
from app.services import report_agent as reports
from app.services.report_control import ReportCancelled, ReportControl


WAIT_SECONDS = 5
FIRST_CONTENT = "FIRST_COMMITTED_SECTION"
SECOND_CONTENT = "SECOND_RETURNED_DRAFT"
LATE_CONTENT = "LATE_OPERATION_RETURN_MUST_NOT_PUBLISH"


def tool_call(name="quick_search"):
    return "<tool_call>" + json.dumps({
        "name": name, "parameters": {"query": "synthetic evidence"},
    }) + "</tool_call>"


def section_script(content):
    return [tool_call(), tool_call("panorama_search"),
            tool_call("insight_forge"), f"Final Answer: {content}"]


class Gate:
    """One explicitly released boundary, never a timing-based pause."""

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()

    def park(self):
        self.entered.set()
        assert self.release.wait(WAIT_SECONDS), "Boundary was not released"

    def reached(self):
        assert self.entered.wait(WAIT_SECONDS), "Worker did not reach boundary"


class Worker:
    def __init__(self, operation):
        self.entered = threading.Event()
        self.done = threading.Event()
        self.result = None
        self.error = None

        def run():
            self.entered.set()
            try:
                self.result = operation()
            except BaseException as error:
                self.error = error
            finally:
                self.done.set()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def joined(self):
        self.thread.join(timeout=WAIT_SECONDS)
        assert not self.thread.is_alive(), "Worker did not finish"
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture
def scenario(monkeypatch, tmp_path):
    """Inject finite dependencies while retaining real report behavior/files."""
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(reports.ReportManager, "REPORTS_DIR", str(tmp_path / "reports"))
    state = SimpleNamespace(
        report_id="report_cooperative_stop", root=tmp_path,
        control=ReportControl(), calls=[], progress=[], terminals=[],
        hooks={}, gates=[], workers=[], console_loggers=[],
        outline={"title": "Synthetic report", "summary": "Synthetic evidence only",
                 "sections": [{"title": "First section"}]},
        responses=section_script(FIRST_CONTENT), json_calls=0, chat_calls=0,
        tool_calls=0, terminal_hook=None, close_error=False,
    )

    def boundary(label, value):
        state.calls.append(label)
        if label in state.hooks:
            return state.hooks[label](value)
        return value

    class Client:
        def chat_json(self, **kwargs):
            state.json_calls += 1
            assert state.json_calls == 1, "Unexpected additional outline operation"
            return boundary("outline_json", deepcopy(state.outline))

        def chat(self, **kwargs):
            state.chat_calls += 1
            assert state.chat_calls <= len(state.responses), "Unexpected model operation"
            return boundary(f"chat_{state.chat_calls}",
                            state.responses[state.chat_calls - 1])

    class Tools:
        def get_simulation_context(self, **kwargs):
            return boundary("planning_context", {
                "graph_statistics": {"total_nodes": 2, "total_edges": 1,
                                     "entity_types": {"Person": 2}},
                "total_entities": 2, "related_facts": ["Synthetic fact"],
            })

        def run(self, **kwargs):
            state.tool_calls += 1
            value = boundary(f"tool_{state.tool_calls}", "SYNTHETIC_TOOL_RESULT")
            return SimpleNamespace(to_text=lambda: value)

        quick_search = run
        panorama_search = run
        insight_forge = run
        interview_agents = run

    original_console = reports.ReportConsoleLogger

    class ConsoleLogger(original_console):
        def __init__(self, report_id):
            super().__init__(report_id)
            state.console_loggers.append(self)
            self.failed_once = False

        def close(self):
            super().close()
            if state.close_error and not self.failed_once:
                self.failed_once = True
                raise OSError("synthetic logger close error")

    def terminal(report):
        if state.terminal_hook:
            state.terminal_hook(report)
        state.terminals.append(deepcopy(report))

    monkeypatch.setattr(reports, "ReportConsoleLogger", ConsoleLogger)
    state.client, state.tools = Client(), Tools()
    state.agent = reports.ReportAgent(
        graph_id="synthetic_graph", simulation_id="synthetic_simulation",
        simulation_requirement="Explain synthetic community behavior",
        llm_client=state.client, zep_tools=state.tools, control=state.control,
        terminal_callback=terminal,
    )

    def gate():
        value = Gate()
        state.gates.append(value)
        return value

    def spawn(operation):
        worker = Worker(operation)
        state.workers.append(worker)
        return worker

    def generate():
        return state.agent.generate_report(
            report_id=state.report_id,
            progress_callback=lambda *args: state.progress.append(args),
        )

    state.gate, state.spawn, state.generate = gate, spawn, generate
    yield state
    # Release every owned barrier even when the assertion under test fails.
    for value in state.gates:
        value.release.set()
    for worker in state.workers:
        worker.thread.join(timeout=WAIT_SECONDS)
        assert not worker.thread.is_alive(), "Test leaked a worker"
    for console in state.console_loggers:
        original_console.close(console)


def cancel(scenario):
    # A broken implementation holding the control over a provider must fail a
    # bounded join rather than permanently blocking pytest's main thread.
    return scenario.spawn(scenario.control.request_cancel).joined()


def folder(scenario):
    return Path(reports.ReportManager._get_report_folder(scenario.report_id))


def read_json(scenario, filename):
    return json.loads((folder(scenario) / filename).read_text(encoding="utf-8"))


def events(scenario):
    return reports.ReportManager.get_agent_log_stream(scenario.report_id)


def content_files(scenario):
    """Snapshot authoritative files; console/diagnostic events are separate."""
    path = folder(scenario)
    return {item.name: item.read_text(encoding="utf-8")
            for item in path.iterdir()
            if item.name == "outline.json" or item.suffix == ".md"}


def assert_cancelled(scenario, result, committed_contents=()):
    assert result.status == reports.ReportStatus.CANCELLED
    assert scenario.control.snapshot()["terminal_status"] == "cancelled"
    assert scenario.terminals[-1].status == reports.ReportStatus.CANCELLED
    meta = read_json(scenario, "meta.json")
    assert meta["status"] == "cancelled"
    assert meta["markdown_content"] == result.markdown_content == ""
    assert reports.ReportManager.get_report(scenario.report_id).markdown_content == ""
    assert not (folder(scenario) / "full_report.md").exists()
    sections = reports.ReportManager.get_generated_sections(scenario.report_id)
    assert len(sections) == len(committed_contents)
    for saved, expected in zip(sections, committed_contents):
        assert expected in saved["content"]
    progress = read_json(scenario, "progress.json")
    assert progress["status"] == "cancelled"
    assert len(progress["completed_sections"]) == len(committed_contents)
    actions = [entry["action"] for entry in events(scenario)]
    assert actions.count("report_cancelled") == 1
    assert "report_complete" not in actions


def test_full_real_local_generation_commits_files_before_completion(scenario, monkeypatch):
    observed = []
    original = reports.ReportLogger.log_report_complete

    def completed(log, **kwargs):
        # This event must not advertise success until all terminal persistence
        # and the exact terminal callback are already visible.
        assert read_json(scenario, "meta.json")["status"] == "completed"
        assert read_json(scenario, "progress.json")["status"] == "completed"
        assert scenario.terminals[-1].status == reports.ReportStatus.COMPLETED
        assert FIRST_CONTENT in (folder(scenario) / "full_report.md").read_text()
        observed.append(True)
        return original(log, **kwargs)

    monkeypatch.setattr(reports.ReportLogger, "log_report_complete", completed)
    result = scenario.generate()
    assert observed == [True]
    assert result.status == reports.ReportStatus.COMPLETED
    assert scenario.control.snapshot()["terminal_status"] == "completed"
    assert scenario.calls == ["planning_context", "outline_json", "chat_1", "tool_1",
                              "chat_2", "tool_2", "chat_3", "tool_3", "chat_4"]
    assert FIRST_CONTENT in result.markdown_content
    assert scenario.agent.console_logger is None
    assert all(log._file_handler is None for log in scenario.console_loggers)


@pytest.mark.parametrize("stage", [
    "planning_context", "outline_json", "section_chat", "section_tool", "forced_final_chat",
])
@pytest.mark.parametrize("late_error", [False, True], ids=["return", "throw"])
def test_cancel_during_admitted_operation_discards_return_or_error(scenario, stage, late_error):
    parked = scenario.gate()
    label = {"section_chat": "chat_1", "section_tool": "tool_1",
             "forced_final_chat": "chat_6"}.get(stage, stage)
    if stage == "forced_final_chat":
        scenario.responses = [None] * 5 + [f"Final Answer: {LATE_CONTENT}"]

    def hold(value):
        parked.park()
        if late_error:
            raise RuntimeError("late admitted operation failed")
        if stage in {"section_chat", "section_tool", "forced_final_chat"}:
            return LATE_CONTENT
        return value

    scenario.hooks[label] = hold
    worker = scenario.spawn(scenario.generate)
    parked.reached()
    accepted = cancel(scenario)
    assert accepted["cancellation_requested"] is True
    assert accepted["terminal_status"] is None
    assert not worker.done.is_set()
    before_calls = list(scenario.calls)
    before_events = len(events(scenario))
    before_progress = list(scenario.progress)
    parked.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result)
    assert result.error is None
    assert scenario.calls == before_calls
    assert scenario.progress == before_progress
    assert [entry["action"] for entry in events(scenario)[before_events:]] == ["report_cancelled"]
    assert LATE_CONTENT not in json.dumps(content_files(scenario))
    assert LATE_CONTENT not in json.dumps(read_json(scenario, "meta.json"))
    if stage in {"planning_context", "outline_json"}:
        assert result.outline is None
        assert not (folder(scenario) / "outline.json").exists()


def test_cancel_before_forced_final_admission_prevents_sixth_chat(scenario, monkeypatch):
    scenario.responses = [None] * 5 + [f"Final Answer: {LATE_CONTENT}"]
    parked = scenario.gate()
    original = scenario.agent._fit_local_section_messages
    fits = []

    def fit(*args, **kwargs):
        value = original(*args, **kwargs)
        fits.append(True)
        if len(fits) == 6:
            parked.park()
        return value

    monkeypatch.setattr(scenario.agent, "_fit_local_section_messages", fit)
    worker = scenario.spawn(scenario.generate)
    parked.reached()
    cancel(scenario)
    parked.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result)
    assert scenario.chat_calls == 5
    assert scenario.tool_calls == 0


def test_already_queued_call_can_reach_fake_provider_after_acceptance(scenario):
    queued = scenario.gate()
    provider_requests = []

    def dispatch_after_queue(value):
        queued.park()
        # Physical provider invocation is allowed after report admission/cancel.
        provider_requests.append("fake provider request after cancellation")
        return f"Final Answer: {LATE_CONTENT}"

    scenario.hooks["chat_1"] = dispatch_after_queue
    worker = scenario.spawn(scenario.generate)
    queued.reached()
    cancel(scenario)
    assert provider_requests == []
    queued.release.set()
    result = worker.joined()
    assert provider_requests == ["fake provider request after cancellation"]
    assert_cancelled(scenario, result)
    assert scenario.chat_calls == 1
    assert LATE_CONTENT not in json.dumps(events(scenario))


def test_admitted_compound_tool_allows_internal_calls_and_late_nonreport_record(scenario, monkeypatch):
    scenario.responses = [tool_call("interview_agents")]
    admitted_tool = scenario.gate()
    late_interview = scenario.gate()
    internal_calls, interview_workers = [], []
    interview_file = scenario.root / "nonreport_interview.json"

    class NestedClient:
        def chat_json(self, *, stage):
            assert scenario.control.snapshot()["cancellation_requested"] is True
            internal_calls.append(stage)
            return {"synthetic": stage}

        def chat(self, *, stage):
            assert scenario.control.snapshot()["cancellation_requested"] is True
            internal_calls.append(stage)
            return "synthetic nested summary"

    nested_client = NestedClient()

    def interview(**kwargs):
        admitted_tool.park()
        # These stand for nested JSON negotiation, selection/question calls and
        # summary work owned by one already-admitted _execute_tool invocation.
        nested_client.chat_json(stage="selection_json")
        nested_client.chat_json(stage="json_format_fallback")
        nested_client.chat_json(stage="questions_json")

        def save_consumed_interview():
            late_interview.park()
            interview_file.write_text(json.dumps({"answer": "late simulation record"}),
                                      encoding="utf-8")

        interview_workers.append(scenario.spawn(save_consumed_interview))
        late_interview.reached()
        internal_calls.append("simulated_ipc_timeout")
        nested_client.chat(stage="summary_chat")
        return SimpleNamespace(to_text=lambda: LATE_CONTENT)

    monkeypatch.setattr(scenario.tools, "interview_agents", interview)
    worker = scenario.spawn(scenario.generate)
    admitted_tool.reached()
    cancel(scenario)
    assert internal_calls == []
    admitted_tool.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result)
    assert internal_calls == ["selection_json", "json_format_fallback", "questions_json",
                              "simulated_ipc_timeout", "summary_chat"]
    assert not interview_file.exists()
    report_files = content_files(scenario)
    report_events = deepcopy(events(scenario))
    late_interview.release.set()
    interview_workers[0].joined()
    assert json.loads(interview_file.read_text())["answer"] == "late simulation record"
    assert content_files(scenario) == report_files
    assert events(scenario) == report_events
    assert LATE_CONTENT not in json.dumps(report_events)
    assert scenario.chat_calls == 1


@pytest.mark.parametrize("boundary", ["outline", "second_section"])
def test_cancel_in_return_to_commit_gap_uses_detached_committed_output(scenario, monkeypatch, boundary):
    parked = scenario.gate()
    drafts = []
    if boundary == "outline":
        original = scenario.agent.plan_outline

        def plan(*args, **kwargs):
            draft = original(*args, **kwargs)
            drafts.append(draft)
            parked.park()  # All operation return/checks succeeded; no commit yet.
            return draft

        monkeypatch.setattr(scenario.agent, "plan_outline", plan)
    else:
        scenario.outline["sections"].append({"title": "Second section"})
        scenario.responses += section_script(SECOND_CONTENT)
        original = scenario.agent._generate_section_react

        def section(**kwargs):
            result = original(**kwargs)
            if kwargs["section_index"] == 2:
                drafts.extend([kwargs["section"], kwargs["outline"]])
                parked.park()
            return result

        monkeypatch.setattr(scenario.agent, "_generate_section_react", section)
    worker = scenario.spawn(scenario.generate)
    parked.reached()
    cancel(scenario)
    # Deliberately mutate both returned drafts and context aliases after stop.
    for draft in drafts:
        draft.title = "UNCOMMITTED_ALIAS_TITLE"
        if isinstance(draft, reports.ReportOutline):
            for section in draft.sections:
                section.content = "UNCOMMITTED_ALIAS_CONTENT"
        else:
            draft.content = "UNCOMMITTED_ALIAS_CONTENT"
    parked.release.set()
    result = worker.joined()
    expected = () if boundary == "outline" else (FIRST_CONTENT,)
    assert_cancelled(scenario, result, expected)
    raw = json.dumps(read_json(scenario, "meta.json")) + json.dumps(content_files(scenario))
    assert "UNCOMMITTED_ALIAS" not in raw
    assert SECOND_CONTENT not in raw
    if boundary == "outline":
        assert result.outline is None
        assert not (folder(scenario) / "outline.json").exists()
    else:
        assert result.outline.sections[0].content == FIRST_CONTENT
        assert result.outline.sections[1].title == "Second section"
        assert result.outline.sections[1].content == ""
        assert read_json(scenario, "outline.json") == read_json(scenario, "meta.json")["outline"]


def test_cancel_before_final_fence_prevents_assembly(scenario, monkeypatch):
    parked = scenario.gate()
    original_commit = scenario.control.commit
    original_log = reports.ReportLogger.log_section_full_complete
    armed = threading.Event()
    nesting = threading.local()
    assembly_calls = []
    original_assemble = reports.ReportManager.assemble_full_report

    def section_complete(log, **kwargs):
        result = original_log(log, **kwargs)
        armed.set()
        return result

    @contextmanager
    def commit():
        # The section group's nested progress commit must finish first. The
        # next outer acquisition is finalization, outside the actual mutex.
        depth = getattr(nesting, "depth", 0)
        if armed.is_set() and depth == 0:
            armed.clear()
            parked.park()
        with original_commit():
            nesting.depth = depth + 1
            try:
                yield
            finally:
                nesting.depth = depth

    def assemble(*args, **kwargs):
        assembly_calls.append(True)
        return original_assemble(*args, **kwargs)

    monkeypatch.setattr(reports.ReportLogger, "log_section_full_complete", section_complete)
    monkeypatch.setattr(scenario.control, "commit", commit)
    monkeypatch.setattr(reports.ReportManager, "assemble_full_report", assemble)
    worker = scenario.spawn(scenario.generate)
    parked.reached()
    cancel(scenario)
    parked.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result, (FIRST_CONTENT,))
    assert assembly_calls == []


def test_section_commit_that_started_first_finishes_before_cancel_ack(scenario, monkeypatch):
    scenario.outline["sections"].append({"title": "Second section"})
    scenario.responses += section_script(SECOND_CONTENT)
    in_commit, next_section = scenario.gate(), scenario.gate()
    original_log = reports.ReportLogger.log_section_full_complete
    original_section = scenario.agent._generate_section_react

    def log_complete(log, **kwargs):
        if kwargs["section_index"] == 1:
            assert FIRST_CONTENT in reports.ReportManager.get_generated_sections(
                scenario.report_id)[0]["content"]
            in_commit.park()
        return original_log(log, **kwargs)

    def section(**kwargs):
        if kwargs["section_index"] == 2:
            next_section.park()
        return original_section(**kwargs)

    monkeypatch.setattr(reports.ReportLogger, "log_section_full_complete", log_complete)
    monkeypatch.setattr(scenario.agent, "_generate_section_react", section)
    worker = scenario.spawn(scenario.generate)
    in_commit.reached()
    request = scenario.spawn(scenario.control.request_cancel)
    assert request.entered.wait(WAIT_SECONDS)
    assert not request.done.is_set(), "Cancellation acknowledged during section commit"
    in_commit.release.set()
    accepted = request.joined()
    assert accepted["cancellation_requested"] is True
    next_section.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result, (FIRST_CONTENT,))
    assert [entry["section_index"] for entry in events(scenario)
            if entry["action"] == "section_complete"] == [1]
    assert scenario.chat_calls == 4


@pytest.mark.parametrize("failure", ["event", "progress"])
def test_saved_section_survives_later_event_or_progress_failure_then_cancel(scenario, monkeypatch, failure):
    error_handoff = scenario.gate()
    original_finish = scenario.agent._finish_local_report
    original_event = reports.ReportLogger.log_section_full_complete
    original_progress = reports.ReportManager.update_progress

    def finish(*args, **kwargs):
        # The section file committed; its event/progress threw and released the
        # group lock. Cancel now wins before error terminal publication.
        error_handoff.park()
        return original_finish(*args, **kwargs)

    def section_event(*args, **kwargs):
        if failure == "event":
            raise OSError("section event failed after file")
        return original_event(*args, **kwargs)

    def progress(report_id, status, amount, message, **kwargs):
        if failure == "progress" and status == "generating" and amount == 90:
            raise OSError("section progress failed after file")
        return original_progress(report_id, status, amount, message, **kwargs)

    monkeypatch.setattr(scenario.agent, "_finish_local_report", finish)
    monkeypatch.setattr(reports.ReportLogger, "log_section_full_complete", section_event)
    monkeypatch.setattr(reports.ReportManager, "update_progress", progress)
    worker = scenario.spawn(scenario.generate)
    error_handoff.reached()
    saved = reports.ReportManager.get_generated_sections(scenario.report_id)
    assert FIRST_CONTENT in saved[0]["content"]
    cancel(scenario)
    error_handoff.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result, (FIRST_CONTENT,))
    assert result.outline.sections[0].content == FIRST_CONTENT
    assert reports.ReportManager.get_generated_sections(scenario.report_id) == saved
    assert read_json(scenario, "meta.json")["outline"]["sections"][0]["content"] == FIRST_CONTENT
    assert read_json(scenario, "outline.json")["sections"][0]["content"] == FIRST_CONTENT
    assert result.error is None


@pytest.mark.parametrize("output", ["outline", "section"])
def test_file_commit_survives_its_own_diagnostic_logger_failure(scenario, monkeypatch, output):
    """The output-file callback must precede even ReportManager's own logging."""
    error_handoff = scenario.gate()
    diagnostic_due = threading.Event()
    injected = []
    original_finish = scenario.agent._finish_local_report
    original_info = reports.logger.info
    original_json = reports.write_json_atomic
    original_text = reports.write_text_atomic

    def finish(*args, **kwargs):
        error_handoff.park()
        return original_finish(*args, **kwargs)

    def write_json(path, *args, **kwargs):
        result = original_json(path, *args, **kwargs)
        if output == "outline" and Path(path).name == "outline.json" and not injected:
            diagnostic_due.set()
        return result

    def write_text(path, *args, **kwargs):
        result = original_text(path, *args, **kwargs)
        if output == "section" and Path(path).name == "section_01.md" and not injected:
            diagnostic_due.set()
        return result

    def info(*args, **kwargs):
        if diagnostic_due.is_set():
            diagnostic_due.clear()
            injected.append(output)
            raise OSError(f"diagnostic logger failed after {output} file commit")
        return original_info(*args, **kwargs)

    monkeypatch.setattr(scenario.agent, "_finish_local_report", finish)
    monkeypatch.setattr(reports, "write_json_atomic", write_json)
    monkeypatch.setattr(reports, "write_text_atomic", write_text)
    monkeypatch.setattr(reports.logger, "info", info)
    worker = scenario.spawn(scenario.generate)
    error_handoff.reached()
    assert injected == [output]
    expected = () if output == "outline" else (FIRST_CONTENT,)
    assert (folder(scenario) / "outline.json").exists()
    if output == "section":
        assert FIRST_CONTENT in reports.ReportManager.get_generated_sections(
            scenario.report_id)[0]["content"]
    cancel(scenario)
    error_handoff.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result, expected)
    assert result.error is None
    assert result.outline.title == "Synthetic report"
    assert result.outline.sections[0].content == (FIRST_CONTENT if output == "section" else "")
    assert read_json(scenario, "outline.json") == read_json(scenario, "meta.json")["outline"]


@pytest.mark.parametrize("failure", [None, "assembly", "metadata", "progress", "task", "event"],
                         ids=["complete", "assembly", "metadata", "progress", "task", "event"])
def test_final_commit_selects_completed_or_failed_before_unlocking(scenario, monkeypatch, failure):
    in_terminal_commit = scenario.gate()
    original_assemble = reports.ReportManager.assemble_full_report
    original_save = reports.ReportManager.save_report
    original_progress = reports.ReportManager.update_progress
    original_event = reports.ReportLogger.log_report_complete

    def assemble(*args, **kwargs):
        result = original_assemble(*args, **kwargs)
        in_terminal_commit.park()  # A real full_report.md already exists.
        if failure == "assembly":
            raise OSError("terminal assembly failed after writing")
        return result

    def save(report):
        if failure == "metadata" and report.status == reports.ReportStatus.COMPLETED:
            raise OSError("terminal metadata failed")
        return original_save(report)

    def progress(report_id, status, amount, message, **kwargs):
        if failure == "progress" and status == "completed":
            raise OSError("terminal progress failed")
        return original_progress(report_id, status, amount, message, **kwargs)

    def terminal(report):
        if failure == "task" and report.status == reports.ReportStatus.COMPLETED:
            raise OSError("terminal task failed")

    def event(log, **kwargs):
        if failure == "event":
            raise OSError("terminal completion event failed")
        return original_event(log, **kwargs)

    scenario.terminal_hook = terminal
    monkeypatch.setattr(reports.ReportManager, "assemble_full_report", assemble)
    monkeypatch.setattr(reports.ReportManager, "save_report", save)
    monkeypatch.setattr(reports.ReportManager, "update_progress", progress)
    monkeypatch.setattr(reports.ReportLogger, "log_report_complete", event)
    worker = scenario.spawn(scenario.generate)
    in_terminal_commit.reached()
    request = scenario.spawn(scenario.control.request_cancel)
    assert request.entered.wait(WAIT_SECONDS)
    assert not request.done.is_set(), "Cancellation bypassed terminal commit mutex"
    in_terminal_commit.release.set()
    result, observed = worker.joined(), request.joined()
    expected = "failed" if failure else "completed"
    assert result.status.value == expected
    assert observed["terminal_status"] == expected
    assert observed["cancellation_requested"] is False
    assert scenario.terminals[-1].status.value == expected
    assert read_json(scenario, "meta.json")["status"] == expected
    assert read_json(scenario, "progress.json")["status"] == expected
    assert (folder(scenario) / "full_report.md").exists()
    assert reports.ReportManager.get_report(scenario.report_id).status.value == expected
    actions = [entry["action"] for entry in events(scenario)]
    assert "report_cancelled" not in actions
    assert actions.count("report_complete") == (0 if failure else 1)
    if failure:
        assert "terminal" in result.error
        assert "terminal" in observed["error"]


@pytest.mark.parametrize("action", ["llm_response", "tool_result", "section_content"])
def test_content_bearing_event_checks_fence_after_return_check(scenario, monkeypatch, action):
    if action == "tool_result":
        target_method = "log_tool_result"
    elif action == "section_content":
        target_method = "log_section_content"
    else:
        target_method = "log_llm_response"
    original = getattr(reports.ReportLogger, target_method)
    between_check_and_log = scenario.gate()
    reached_once = []

    def delayed(log, *args, **kwargs):
        if not reached_once:
            reached_once.append(True)
            between_check_and_log.park()
        return original(log, *args, **kwargs)

    monkeypatch.setattr(reports.ReportLogger, target_method, delayed)
    worker = scenario.spawn(scenario.generate)
    between_check_and_log.reached()
    before = len(events(scenario))
    cancel(scenario)
    between_check_and_log.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result)
    assert [entry["action"] for entry in events(scenario)[before:]] == ["report_cancelled"]


@pytest.mark.parametrize("boundary", ["outline", "tool"])
def test_distinct_cancellation_exception_escapes_generic_fallbacks(scenario, monkeypatch, boundary):
    def cancelled(**kwargs):
        raise ReportCancelled("synthetic cancellation sentinel")

    if boundary == "outline":
        monkeypatch.setattr(scenario.client, "chat_json", cancelled)
        operation = scenario.agent.plan_outline
    else:
        monkeypatch.setattr(scenario.tools, "quick_search", cancelled)
        operation = lambda: scenario.agent._execute_tool("quick_search", {"query": "test"})
    with pytest.raises(ReportCancelled, match="synthetic cancellation sentinel"):
        operation()
    assert scenario.control.snapshot()["terminal_status"] is None


@pytest.mark.parametrize("failure", ["metadata", "progress", "event"])
def test_cancellation_persistence_errors_are_returned_and_other_writes_attempted(scenario, monkeypatch, failure):
    parked = scenario.gate()
    original_save = reports.ReportManager.save_report
    original_progress = reports.ReportManager.update_progress
    original_event = reports.ReportLogger.log
    attempts = []

    def context(value):
        parked.park()
        return value

    def save(report):
        if report.status == reports.ReportStatus.CANCELLED:
            attempts.append("metadata")
            if failure == "metadata":
                raise OSError("cancel metadata disk failure")
        return original_save(report)

    def progress(report_id, status, amount, message, **kwargs):
        if status == "cancelled":
            attempts.append("progress")
            if failure == "progress":
                raise OSError("cancel progress disk failure")
        return original_progress(report_id, status, amount, message, **kwargs)

    def event(log, action, stage, details, *args, **kwargs):
        if action == "report_cancelled":
            attempts.append("event")
            if failure == "event":
                raise OSError("cancel event disk failure")
        return original_event(log, action, stage, details, *args, **kwargs)

    scenario.hooks["planning_context"] = context
    monkeypatch.setattr(reports.ReportManager, "save_report", save)
    monkeypatch.setattr(reports.ReportManager, "update_progress", progress)
    monkeypatch.setattr(reports.ReportLogger, "log", event)
    worker = scenario.spawn(scenario.generate)
    parked.reached()
    cancel(scenario)
    parked.release.set()
    result = worker.joined()
    assert result.status == reports.ReportStatus.CANCELLED
    assert attempts == ["metadata", "progress", "event"]
    assert f"{failure} persistence failed" in result.error
    assert result.error == scenario.control.snapshot()["error"]
    assert scenario.terminals[-1].error == result.error
    assert scenario.agent.console_logger is None
    assert "report_complete" not in [entry["action"] for entry in events(scenario)]
    assert not (folder(scenario) / "full_report.md").exists()
    if failure != "metadata":
        assert read_json(scenario, "meta.json")["status"] == "cancelled"
    else:
        assert read_json(scenario, "meta.json")["status"] == "pending"
    if failure != "progress":
        assert read_json(scenario, "progress.json")["status"] == "cancelled"


def test_logger_close_failure_keeps_cancelled_outcome_and_surfaces_error(scenario):
    parked = scenario.gate()

    def context(value):
        parked.park()
        return value

    scenario.hooks["planning_context"] = context
    scenario.close_error = True
    worker = scenario.spawn(scenario.generate)
    parked.reached()
    cancel(scenario)
    parked.release.set()
    result = worker.joined()
    assert_cancelled(scenario, result)
    assert "Report logger cleanup failed: synthetic logger close error" in result.error
    assert scenario.terminals[-1].error == result.error
    assert scenario.control.snapshot()["error"] == result.error
    assert scenario.agent.console_logger is None
    assert all(log._file_handler is None for log in scenario.console_loggers)


@pytest.mark.parametrize("local_mode", [False, True], ids=["cloud", "local_uncontrolled"])
def test_no_control_generation_retains_existing_path(scenario, monkeypatch, local_mode):
    monkeypatch.setattr(Config, "LOCAL_MODE", local_mode)
    scenario.agent.control = None

    def forbidden(*args, **kwargs):
        raise AssertionError("No-control generation entered local stop path")

    monkeypatch.setattr(scenario.agent, "_generate_report_controlled", forbidden)
    result = scenario.generate()
    assert result.status == reports.ReportStatus.COMPLETED
    assert scenario.terminals == []  # Existing path leaves task publication to API.
    assert scenario.control.snapshot() == {
        "cancellation_requested": False, "terminal_status": None, "error": None,
    }
    assert FIRST_CONTENT in result.markdown_content
    assert scenario.chat_calls == 4 and scenario.tool_calls == 3
    assert read_json(scenario, "meta.json")["status"] == "completed"
    assert [entry["action"] for entry in events(scenario)].count("report_complete") == 1
    assert scenario.agent.console_logger is None


def test_precancelled_generation_runs_no_operation_or_initialization(scenario):
    cancel(scenario)
    assert not folder(scenario).exists()
    result = scenario.generate()
    assert result.status == reports.ReportStatus.CANCELLED
    assert scenario.calls == []
    assert scenario.progress == []
    assert scenario.console_loggers == []
    assert scenario.agent.report_logger is not None
    assert [entry["action"] for entry in events(scenario)] == ["report_cancelled"]
    assert scenario.terminals[-1].status == reports.ReportStatus.CANCELLED
    assert read_json(scenario, "meta.json")["status"] == "cancelled"
    assert read_json(scenario, "progress.json")["status"] == "cancelled"
    assert result.outline is None
    assert not (folder(scenario) / "outline.json").exists()
    assert not (folder(scenario) / "full_report.md").exists()
