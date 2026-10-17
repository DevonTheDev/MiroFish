"""One exact local project worker plus retained bridge/batch settlement.

Cloud construction continues to use the existing graph route worker. Stop here
never closes the process-shared local client, gateway, or model server.
"""
from contextlib import nullcontext
import hashlib
import threading
import time

from zep_cloud import BatchAddItem

from ..config import Config
from ..models.project import ProjectManager, ProjectStatus
from ..models.task import TaskManager, TaskStatus
from ..utils.locale import set_locale, t
from ..utils.zep_lifecycle import graph_lifecycle_lock
from ..utils.zep import ZEP_INGESTION_WAIT_TIMEOUT_SECONDS
from .graph_builder import GraphBuilderService
from .text_processor import TextProcessor
from .graph_build_control import (
    GraphBuildStopped, GraphBuildUnresolved, project_build_lock, release_control,
)


STOPPING_MESSAGE = (
    "Stopping after the current graph operation. The current document chunk and "
    "local model requests may finish. Source files and existing graph data will be kept."
)


def _fresh_claim(control):
    project = ProjectManager.get_project(control.project_id)
    if project is None or project.graph_build_task_id != control.task_id:
        raise GraphBuildUnresolved("Local graph-build project/task ownership changed")
    return project


def remember_identity(control, *, graph_id=None, batch_id=None, operation_id=None):
    """Identity-only merge is allowed after Stop for an already admitted call."""
    with project_build_lock(control.project_id):
        project = _fresh_claim(control)
        target_graph = graph_id or project.graph_id
        with graph_lifecycle_lock(target_graph) if target_graph else nullcontext():
            with control.lock:
                for field, value in (("graph_id", graph_id), ("batch_id", batch_id),
                                     ("operation_id", operation_id)):
                    previous = getattr(control, field)
                    if value is not None and previous not in (None, value):
                        raise GraphBuildUnresolved("An admitted operation returned a different identity")
                    if value is not None:
                        setattr(control, field, value)
            if graph_id is not None:
                if project.graph_id not in (None, graph_id):
                    raise GraphBuildUnresolved("Project graph ownership changed")
                project.graph_id = graph_id
            if batch_id is not None:
                project.zep_batch_id = batch_id
            if operation_id is not None:
                project.zep_batch_operation_id = operation_id
            if control.stop_requested and control.requested_persisted:
                project.graph_build_stop = control.marker(
                    "unresolved" if control.unresolved else "requested"
                )
                project.status = ProjectStatus.GRAPH_BUILDING
            try:
                ProjectManager.save_project(project)
            except Exception as error:
                control.record_error("Graph-build identity could not be saved", unresolved=True)
                raise GraphBuildUnresolved("Graph-build identity could not be saved") from error


def persist_stop(control, *, terminal=False):
    """Caller holds project -> graph locks; no wait or provider call happens here."""
    project = _fresh_claim(control)
    if terminal and (not control.worker_done or control.has_pending_receipts() or
                     not control.settlement_done or control.unresolved):
        terminal = False
    state = "stopped" if terminal else "unresolved" if (
        control.unresolved or (control.worker_done and control.has_pending_receipts())
    ) else "requested"
    # Reconcile identities already produced by admitted operations, including
    # a previous identity-file failure. This never admits another mutation.
    if project.graph_id not in (None, control.graph_id):
        raise GraphBuildUnresolved("Project graph ownership changed")
    project.graph_id = control.graph_id
    project.zep_batch_id = control.batch_id or project.zep_batch_id
    project.zep_batch_operation_id = control.operation_id or project.zep_batch_operation_id
    project.graph_build_stop = control.marker(state)
    project.status = ProjectStatus.GRAPH_STOPPED if terminal else ProjectStatus.GRAPH_BUILDING
    if control.error:
        project.error = control.error
    try:
        ProjectManager.save_project(project)
    except Exception as error:
        control.persistence_failed(error)
        raise
    control.mark_requested_persisted()
    if terminal:
        TaskManager().update_task(
            control.task_id, status=TaskStatus.CANCELLED,
            message="Graph build stopped. The graph is incomplete or has not completed final verification.",
            error=control.error,
            result={"project_id": control.project_id, "graph_id": control.graph_id,
                    "graph_build_stop": project.graph_build_stop},
        )
        release_control(control)
    else:
        TaskManager().update_task(
            control.task_id, status=TaskStatus.PROCESSING,
            message=STOPPING_MESSAGE if state == "requested" else
                    "Stop was requested, but completion could not be confirmed. New graph work remains blocked.",
            error=control.error,
        )
    return project


def finalize_stop(control):
    """May be retried for the same claim after a terminal persistence failure."""
    with project_build_lock(control.project_id):
        project = _fresh_claim(control)
        graph_id = control.graph_id or project.graph_id
        with graph_lifecycle_lock(graph_id) if graph_id else nullcontext():
            if not control.requested_persisted:
                return project
            return persist_stop(control, terminal=True)


def _publish_failure(control, error):
    with project_build_lock(control.project_id):
        project = _fresh_claim(control)
        with graph_lifecycle_lock(project.graph_id) if project.graph_id else nullcontext():
            if control.stop_requested:
                TaskManager().update_task(control.task_id, status=TaskStatus.PROCESSING,
                                          message=STOPPING_MESSAGE, error=control.error)
                return
            still_owned = control.has_pending_receipts() or control.unresolved
            project.status = ProjectStatus.GRAPH_BUILDING if still_owned else ProjectStatus.FAILED
            project.error = control.error or str(error)[:1000]
            try:
                ProjectManager.save_project(project)
            except Exception as save_error:
                control.persistence_failed(save_error)
                return
            TaskManager().update_task(
                control.task_id, status=TaskStatus.PROCESSING if still_owned else TaskStatus.FAILED,
                message="Graph build encountered an error; waiting for owned operations" if still_owned else "Graph build failed",
                error=project.error,
            )


def _progress(control, message, progress, detail=None):
    with control.lock:
        if control.stop_requested:
            return  # A late admitted result cannot overwrite Stop presentation.
        TaskManager().update_task(control.task_id, message=message, progress=progress,
                                  progress_detail=detail)


def _build(control, *, graph_name, text, ontology, chunk_size, chunk_overlap, locale):
    set_locale(locale)
    tasks = TaskManager()
    try:
        tasks.update_task(control.task_id, status=TaskStatus.PROCESSING,
                          message="Initializing local graph service")
        with control.operation("initialize"):
            builder = GraphBuilderService(api_key=Config.ZEP_API_KEY)
            control.client = builder.client
        with control.operation("chunk source"):
            _progress(control, t('progress.textChunking'), 5)
            chunks = TextProcessor.split_text(text, chunk_size=chunk_size, overlap=chunk_overlap)
            builder.validate_batch_chunks(chunks, batch_size=350)
            control.set_expected_chunks(len(chunks))
        with control.operation("allocate graph"):
            _progress(control, t('progress.creatingZepGraph'), 10)
            graph_id = builder.create_graph(
                name=graph_name,
                graph_id_callback=lambda value: remember_identity(control, graph_id=value),
            )
        with control.operation("set ontology"):
            _progress(control, t('progress.settingOntology'), 15)
            builder.set_ontology(graph_id, ontology)
        with control.operation("create batch"):
            operation_id = builder.build_operation_id(graph_id, chunks)
            remember_identity(control, operation_id=operation_id)
            batch = builder.client.batch.create(metadata={
                "mirofish_operation_id": operation_id, "graph_id": graph_id,
                "chunk_count": len(chunks), "mirofish_project_id": control.project_id,
                "mirofish_graph_build_task_id": control.task_id,
            })
            if not getattr(batch, "batch_id", None):
                raise GraphBuildUnresolved("Local batch returned no identity")
            remember_identity(control, batch_id=batch.batch_id, operation_id=operation_id)
        for first in range(0, len(chunks), 350):
            with control.operation("stage document chunks"):
                items = [BatchAddItem(
                    type="graph_episode", graph_id=graph_id, data=chunk, data_type="text",
                    source_description="MiroFish source document chunk",
                    metadata={"mirofish_operation_id": operation_id,
                              "chunk_index": first + offset,
                              "chunk_sha256": hashlib.sha256(chunk.encode()).hexdigest()},
                ) for offset, chunk in enumerate(chunks[first:first + 350])]
                details = builder.client.batch.add(batch_id=control.batch_id, items=items)
                if len(details or []) != len(items):
                    raise GraphBuildUnresolved("Local batch staging acknowledgement is incomplete")
                _progress(control, t('progress.addingChunks', count=len(chunks)),
                          15 + int((first + len(items)) / len(chunks) * 40))
        with control.operation("process batch"):
            _progress(control, t('progress.waitingZepProcess'), 55)
            builder.client.batch.process(control.batch_id)
        wait_started = time.monotonic()
        while True:
            if time.monotonic() - wait_started > ZEP_INGESTION_WAIT_TIMEOUT_SECONDS:
                raise TimeoutError("Local batch did not finish within the ingestion wait limit")
            with control.operation("observe batch"):
                summary = builder.client.batch.get(control.batch_id)
            observed = getattr(getattr(summary, "progress", None), "succeeded_items", 0)
            succeeded = observed if type(observed) is int and observed >= 0 else 0
            _progress(control, t('progress.zepProcessing', completed=succeeded,
                                total=len(chunks), pending=max(0, len(chunks) - succeeded),
                                elapsed=int(time.monotonic() - wait_started)),
                      55 + int(min(succeeded / len(chunks), 1) * 35),
                      {"phase": control.phase, "expected_chunks": len(chunks),
                       "succeeded_chunks": succeeded})
            if summary.status == "succeeded":
                break
            if summary.status in {"failed", "canceled", "invalid", "partial"}:
                raise RuntimeError("Local batch ended as " + summary.status)
            with control.changed:
                if not control.stop_requested:
                    control.changed.wait(timeout=3)
        # A journal status is not the detached coroutine's final receipt.
        control.wait_for_receipts()
        if control.unresolved:
            raise GraphBuildUnresolved(control.error or "Batch settlement is unresolved")
        with control.operation("final graph verification"):
            _progress(control, t('progress.fetchingGraphData'), 95)
            graph_data = builder.get_graph_data(graph_id)
        with project_build_lock(control.project_id):
            project = _fresh_claim(control)
            with graph_lifecycle_lock(graph_id):
                control.check_admission()
                project.status = ProjectStatus.GRAPH_COMPLETED
                project.error = None
                ProjectManager.save_project(project)
                # Stop uses the same project/graph locks, so the durable save
                # and the controller winner cannot be crossed by Stop.
                control.claim_completion()
                tasks.update_task(
                    control.task_id, status=TaskStatus.COMPLETED, progress=100,
                    message="Graph build complete", result={
                        "project_id": control.project_id, "graph_id": graph_id,
                        "node_count": graph_data.get("node_count", 0),
                        "edge_count": graph_data.get("edge_count", 0),
                        "chunk_count": len(chunks), "zep_batch_id": control.batch_id,
                    },
                )
    except GraphBuildStopped:
        tasks.update_task(control.task_id, status=TaskStatus.PROCESSING, message=STOPPING_MESSAGE)
    except BaseException as error:
        control.worker_error = error
        control.record_error(error, unresolved=isinstance(error, GraphBuildUnresolved))
        _publish_failure(control, error)


def _settle_after_worker(control, worker):
    worker.join()
    with control.changed:
        control.worker_done = True
        control.changed.notify_all()
    try:
        if control.stop_requested and control.requested_persisted:
            finalize_stop(control)  # requested/unresolved until every receipt settles
        control.wait_for_receipts()
        if control.stop_requested:
            if control.batch_id and control.client:
                try:
                    with control.operation("settle batch journal", settlement=True):
                        control.client._call("settle_build_batch", control.batch_id, control)
                except BaseException as error:
                    control.record_error(error, unresolved=True)
                control.wait_for_receipts()
            control.settlement_done = True
            finalize_stop(control)
        else:
            # Serialize final release against an exact Stop arriving as the
            # worker exits. Never remove a newly latched in-process fence.
            with project_build_lock(control.project_id):
                stop_arrived = control.stop_requested
                if not stop_arrived and not control.unresolved and not control.persistence_error:
                    if control.worker_error is not None:
                        _publish_failure(control, control.worker_error)
                    if not control.persistence_error:
                        release_control(control)
            if stop_arrived:
                _settle_after_worker(control, worker)
    except BaseException as error:
        control.persistence_failed(error)
        TaskManager().update_task(
            control.task_id, status=TaskStatus.PROCESSING,
            message="Graph build settlement could not be confirmed", error=control.error,
        )


def launch_local_build(control, **options):
    control.client = None
    control.settlement_done = False
    control.remember_identity = lambda **identity: remember_identity(control, **identity)
    worker = threading.Thread(target=_build, kwargs={"control": control, **options}, daemon=True,
                              name="MiroFishGraphBuild-" + control.task_id)
    control.worker = worker
    settlement = threading.Thread(target=_settle_after_worker, args=(control, worker), daemon=True,
                                  name="MiroFishGraphSettlement-" + control.task_id)
    control.settlement_worker = settlement
    worker.start()
    try:
        settlement.start()
    except BaseException:
        control.record_error("Local graph settlement worker could not start", unresolved=True)
        raise
