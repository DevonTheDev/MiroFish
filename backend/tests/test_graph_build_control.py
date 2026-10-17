"""Focused, provider-free graph-build control contract tests.

Prepared without execution. Runtime requires the reviewed qualification release.
"""
from types import SimpleNamespace
import threading

import pytest

from app.services.graph_build_control import (
    GraphBuildControl, GraphBuildStopped, register_control, release_control,
    stop_reason, valid_stop_marker,
)


def project(control, marker=None, status="graph_building"):
    return SimpleNamespace(project_id=control.project_id, graph_build_task_id=control.task_id,
                           graph_id=control.graph_id, graph_build_stop=marker, status=status)


def test_stop_closes_admission_but_retains_admitted_receipt():
    control = GraphBuildControl("proj_one", "task_one")
    with control.operation("allocated graph"):
        control.request_stop()
        assert control.has_pending_receipts()
        with pytest.raises(GraphBuildStopped):
            with control.operation("ontology"):
                pytest.fail("new operation admitted after Stop")
    assert not control.has_pending_receipts()
    assert control.stop_requested


def test_late_loop_receipt_outlives_sync_scope():
    control = GraphBuildControl("proj_one", "task_one")
    with control.operation("bridge"):
        receipt = control.own_receipt("loop operation")
        control.request_stop()
    assert control.has_pending_receipts()
    control.settle_receipt(receipt)
    assert not control.has_pending_receipts()


def test_whole_episode_admission_counts_do_not_infer_success():
    control = GraphBuildControl("proj_one", "task_one")
    control.set_expected_chunks(4)
    assert control.admit_episode("job0")
    assert control.admit_episode("job1")
    control.episode_succeeded("job0")
    control.request_stop()
    assert not control.admit_episode("job2")
    marker = control.marker("requested")
    assert marker["expected_chunks"] == 4
    assert marker["succeeded_chunks"] == 1
    assert marker["unstarted_chunks"] == 2


def test_completed_and_stop_have_one_controller_winner():
    completed = GraphBuildControl("proj_one", "task_one")
    assert completed.claim_completion()
    assert not completed.request_stop()
    stopped = GraphBuildControl("proj_two", "task_two")
    assert stopped.request_stop()
    assert not stopped.claim_completion()


def test_first_write_failure_is_live_fence_without_fictional_marker():
    control = GraphBuildControl("proj_one", "task_one")
    register_control(control)
    try:
        control.request_stop()
        control.persistence_failed(OSError("disk unavailable"))
        assert stop_reason(project(control)) == "graph_build_stop_unresolved"
        assert control.snapshot()["persisted"] is False
        control.mark_requested_persisted()
        assert stop_reason(project(control, control.marker("requested"))) == "graph_build_stopping"
    finally:
        release_control(control)


@pytest.mark.parametrize("change", [
    {"version": 2}, {"version": True}, {"task_id": "task_other"},
    {"graph_id": "graph_other"}, {"state": "unknown"},
    {"succeeded_chunks": -1}, {"unstarted_chunks": True}, {"backend": "cloud"},
])
def test_new_malformed_marker_fails_closed(change):
    control = GraphBuildControl("proj_one", "task_one")
    control.request_stop()
    marker = control.marker("requested") | change
    assert not valid_stop_marker(project(control, marker))
    assert stop_reason(project(control, marker)) == "graph_build_stop_unresolved"


def test_unmarked_legacy_and_stopped_receipt_classification():
    control = GraphBuildControl("proj_one", "task_one")
    assert stop_reason(project(control)) is None
    assert stop_reason(project(control, status="graph_stopped")) == "graph_build_stop_unresolved"
    control.request_stop()
    assert stop_reason(project(control, control.marker("stopped"), "graph_stopped")) == "graph_build_stopped"
