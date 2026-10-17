"""Narrow admission policy for graphs tagged by local graph-build Stop.

Historical, unmarked projects keep their existing eligibility. Callers must
not hold a simulation admission/finalization lock while entering or leaving
these scopes. Reader registration, rather than the lifecycle mutex, spans
admitted graph/model work.
"""

from contextlib import ExitStack, contextmanager

from ..models.project import ProjectManager
from ..utils.zep_lifecycle import (
    graph_lifecycle_lock,
    register_graph_reader,
    unregister_graph_reader,
)
from .graph_build_control import project_build_lock, stop_reason


_MESSAGES = {
    "graph_build_stopping": "This local graph build is stopping; new preparation is blocked.",
    "graph_build_stopped": "This local graph build was stopped; the graph is not ready for new preparation.",
    "graph_build_stop_unresolved": "The local graph build Stop could not be confirmed; new preparation is blocked.",
    "graph_busy": "This graph is currently being built or updated.",
}
_UNSET = object()


class GraphReadinessError(ValueError):
    status_code = 409

    def __init__(self, code):
        self.code = code
        super().__init__(_MESSAGES[code])


@contextmanager
def graph_readiness_locks(project, graph_id, *, blocking=True):
    """Lock selected/effective graphs in stable order after the project lock.

    A clean override must not bypass the selected project's marker. Taking
    both graph locks also makes that selected-project fence observation obey
    project -> graph -> controller order when an override differs.
    """
    graph_ids = {value for value in (getattr(project, "graph_id", None), graph_id) if value}
    with ExitStack() as locks:
        for current_id in sorted(graph_ids):
            lock = graph_lifecycle_lock(current_id)
            if not lock.acquire(blocking=blocking):
                raise GraphReadinessError("graph_busy")
            locks.callback(lock.release)
        yield


def assert_graph_ready_locked(project_id, graph_id, *, project=_UNSET):
    """Check selected project and every effective-graph owner under locks.

    The caller owns the selected project lock and its relevant graph locks.
    Owner lookup takes no other project locks, avoiding graph -> project
    inversion. Stop writers serialize their owner marker under this graph
    lock; stop_reason consults the exact process fence under its own lock.
    """
    if project is _UNSET:
        project = ProjectManager.get_project(project_id)
    if project is not None:
        reason = stop_reason(project)
        if reason:
            raise GraphReadinessError(reason)
    if graph_id:
        for owner in ProjectManager.find_projects_by_graph_id(graph_id):
            reason = stop_reason(owner)
            if reason:
                raise GraphReadinessError(reason)
    return project


def marker_preflight(project_id, graph_id):
    """Reject an existing marker without graph reads, task/state mutations."""
    with project_build_lock(project_id):
        project = ProjectManager.get_project(project_id)
        if project is None:
            return None
        with graph_readiness_locks(project, graph_id):
            return assert_graph_ready_locked(project_id, graph_id, project=project)


@contextmanager
def marker_read_lease(project_id, graph_id, reader_id):
    """Admit legacy preview/preparation with only the new marker policy.

    Do not import planned preparation's stricter graph/status predicates here:
    unmarked historical graph mismatches and cloud records remain eligible.
    Once admitted, Stop may win later without revoking this separate reader.
    """
    with project_build_lock(project_id):
        project = ProjectManager.get_project(project_id)
        with graph_readiness_locks(project, graph_id):
            project = assert_graph_ready_locked(project_id, graph_id, project=project)
            if graph_id:
                register_graph_reader(graph_id, reader_id)
    try:
        yield project
    finally:
        if graph_id:
            unregister_graph_reader(graph_id, reader_id)
