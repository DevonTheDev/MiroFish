"""Deterministic engine contracts with synthetic Graphiti and an in-memory journal.

Prepared and source-reviewed without execution. These tests call the production
engine methods, but neither initialize Graphiti nor contact a model, gateway, or
Neo4j. The fake driver is a bounded query interpreter, not Cypher/transaction or
installed Graphiti compatibility evidence. See ENGINE-TEST-NOTES.md in the packet.
"""
import asyncio
from collections import Counter
from copy import deepcopy
from functools import wraps
import json
import re
import sys
from types import ModuleType, SimpleNamespace

import pytest

from app.memory.graphiti_engine import GraphitiMemoryEngine
from app.services.graph_build_control import (
    GraphBuildControl, GraphBuildUnresolved, bind_control,
)


WAIT = 3


def async_case(function):
    """Use pytest itself plus stdlib asyncio; no asyncio plugin is required."""
    @wraps(function)
    def run_case(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))
    return run_case


async def bounded(awaitable):
    return await asyncio.wait_for(awaitable, WAIT)


async def owned(control, awaitable):
    # Match the real bridge ContextVar binding without invoking its worker loop.
    with bind_control(control):
        return await bounded(awaitable)


class Gate:
    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def pause(self):
        self.entered.set()
        await bounded(self.release.wait())


class ObservedSemaphore(asyncio.Semaphore):
    def __init__(self, value=1):
        super().__init__(value)
        self.entered = asyncio.Event()

    async def __aenter__(self):
        self.entered.set()
        return await super().__aenter__()


class ObservedLock(asyncio.Lock):
    def __init__(self):
        super().__init__()
        self.entered = asyncio.Event()

    async def __aenter__(self):
        self.entered.set()
        return await super().__aenter__()


class Result:
    def __init__(self, record=None):
        self.record = record

    async def consume(self):
        return None

    async def single(self):
        return self.record


class Transaction:
    def __init__(self, driver):
        self.driver = driver
        self.lock = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        if self.lock is not None:
            self.lock.release()
        return False

    async def run(self, query, **params):
        self.driver.coordination.append((query, dict(params)))
        if query.startswith("MERGE (m:MiroMemoryLock"):
            if self.driver.database_gate is not None:
                await self.driver.database_gate.pause()
            lock = self.driver.database_locks.setdefault(params["id"], asyncio.Lock())
            await bounded(lock.acquire())
            self.lock = lock
            return Result({"graph_id": params["id"]})
        if "RETURN g.graph_id AS id" in query:
            return Result({"id": params["id"]} if params["id"] in self.driver.graphs else None)
        raise AssertionError("Unexpected coordination query: " + query)


class JournalDriver:
    """Recognizes only the engine queries exercised here; unknown queries fail.

    Ownership filters are interpreted from the issued query. Omitting a filter
    therefore changes fake rows too, rather than silently preserving them.
    """
    def __init__(self):
        self.graphs, self.batches, self.jobs, self.claims = {}, {}, {}, {}
        self.queries, self.coordination, self.graph_writes = [], [], []
        self.database_locks = {}
        self.database_gate = None
        self.fail_once = []
        self.closed = 0

    def transaction(self):
        return Transaction(self)

    async def close(self):
        self.closed += 1

    @property
    def status_writes(self):
        return [(q, p) for q, p in self.queries if "SET j.status" in q or "SET b.status" in q]

    async def execute_query(self, query, *, params):
        self.queries.append((query, dict(params)))
        for fragment in tuple(self.fail_once):
            if fragment in query:
                self.fail_once.remove(fragment)
                raise OSError("synthetic journal unavailable: " + fragment)
        rows = self._rows(query, params)
        return rows, None, None

    def _rows(self, query, p):
        if "RETURN properties(g) AS data" in query:
            return [{"data": deepcopy(self.graphs[p["id"]])}]
        if "RETURN properties(b) AS data" in query:
            return [{"data": deepcopy(self.batches[p["id"]])}]
        if "RETURN properties(j) AS data" in query:
            if "{batch_id:$id}" in query:
                return [{"data": deepcopy(job)} for job in self.jobs.values()
                        if job["batch_id"] == p["id"]]
            return [{"data": deepcopy(self.jobs[p["id"]])}]
        if "RETURN j.status AS status,count(j) AS count" in query:
            counts = Counter(j["status"] for j in self.jobs.values() if j["batch_id"] == p["id"])
            return [{"status": state, "count": count} for state, count in counts.items()]
        if "RETURN j.uuid AS id ORDER BY j.sequence_index" in query:
            jobs = sorted((j for j in self.jobs.values() if j["batch_id"] == p["id"]),
                          key=lambda j: j["sequence_index"])
            return [{"id": j["uuid"]} for j in jobs]
        if "RETURN j.uuid AS uuid ORDER BY j.reference_time" in query:
            jobs = [j for j in self.jobs.values()
                    if j["group_id"] == p["graph"] and j["status"] == "succeeded"]
            return [{"uuid": j["uuid"]} for j in jobs[-5:]]
        if query.startswith("MERGE (c:MiroMemoryClaim"):
            identity = p.get("identity", p.get("id"))
            return [{"owner": self.claims.setdefault(identity, p["owner"])}]
        if "SET j.status=" in query:
            for job in self.jobs.values():
                if "{uuid:$id}" in query and job["uuid"] != p["id"]:
                    continue
                if "{batch_id:$id" in query and job["batch_id"] != p["id"]:
                    continue
                if "submitted_owner:$owner" in query and job["submitted_owner"] != p["owner"]:
                    continue
                if "status:'queued'" in query and job["status"] != "queued":
                    continue
                if "NOT j.uuid IN $admitted" in query and job["uuid"] in p["admitted"]:
                    continue
                if "WHERE (j.status='queued'" in query and not (
                    job["status"] == "queued" and job["submitted_owner"] == p["owner"]
                    or job["status"] == "processing" and job.get("owner") == p["owner"]
                ):
                    continue
                self._update(job, query, p, "j")
            return []
        if "SET b.status=" in query:
            batch = self.batches[p["id"]]
            if "WHERE b.status='draft' OR b.owner=$owner" in query:
                if batch["status"] != "draft" and batch.get("owner") != p["owner"]:
                    return []
            self._update(batch, query, p, "b")
            return []
        raise AssertionError("Unexpected journal query: " + query)

    @staticmethod
    def _update(row, query, params, alias):
        match = re.search(r"SET " + alias + r"\.status=(?:'([^']+)'|\$status)", query)
        assert match is not None, query
        row["status"] = match.group(1) or params["status"]
        writes = query.split(" SET ", 1)[1]
        if alias + ".owner=$owner" in writes:
            row["owner"] = params["owner"]
        if alias + ".error=$error" in writes:
            row["error"] = params["error"]
        elif alias + ".error='" in writes:
            row["error"] = re.search(alias + r"\.error='([^']+)'", query).group(1)


class Gateway:
    """Synthetic forwards only; no HTTP server or real shared gateway is used."""
    def __init__(self):
        self.calls = []
        self.closed = 0

    async def forward(self, kind, identifier):
        self.calls.append((kind, identifier))

    async def close(self):
        self.closed += 1


class FakeGraphiti:
    def __init__(self, driver, gateway):
        self.driver, self.gateway = driver, gateway
        self.gates, self.failures, self.calls = {}, {}, []
        self.closed = 0

    async def add_episode(self, **kwargs):
        identifier = kwargs["uuid"]
        self.calls.append(identifier)
        await self.gateway.forward("chat", identifier)
        if identifier in self.gates:
            await self.gates[identifier].pause()
        if identifier in self.failures:
            raise RuntimeError(self.failures[identifier])
        # Both happen after Stop when the first forward was already admitted.
        await self.gateway.forward("embedding", identifier)
        self.driver.graph_writes.append(("graphiti", identifier))

    async def close(self):
        self.closed += 1


@pytest.fixture
def harness(monkeypatch):
    package = ModuleType("graphiti_core")
    package.__path__ = []
    nodes = ModuleType("graphiti_core.nodes")

    class Episode:
        def __init__(self, **values):
            self.__dict__.update(values)

        async def save(self, driver):
            driver.graph_writes.append(("episode", self.uuid))

    nodes.EpisodicNode = Episode
    nodes.EpisodeType = SimpleNamespace(text="text")
    monkeypatch.setitem(sys.modules, "graphiti_core", package)
    monkeypatch.setitem(sys.modules, "graphiti_core.nodes", nodes)
    engine = GraphitiMemoryEngine(SimpleNamespace())
    engine.owner = "engine_this"
    engine.driver = JournalDriver()
    gateway = Gateway()
    engine.graphiti = FakeGraphiti(engine.driver, gateway)
    return SimpleNamespace(engine=engine, driver=engine.driver, gateway=gateway,
                           graphiti=engine.graphiti)


def build(h, *, count=2, suffix="one", status="draft"):
    control = GraphBuildControl("proj_" + suffix, "task_" + suffix)
    control.graph_id, control.batch_id, control.operation_id = (
        "graph_" + suffix, "batch_" + suffix, "operation_" + suffix,
    )
    control.set_expected_chunks(count)
    h.driver.graphs[control.graph_id] = {"graph_id": control.graph_id, "ontology": "{}"}
    h.driver.batches[control.batch_id] = {
        "batch_id": control.batch_id, "group_id": control.graph_id, "status": status,
        "owner": h.engine.owner if status != "draft" else None,
        "metadata": json.dumps({"mirofish_project_id": control.project_id,
                                "mirofish_graph_build_task_id": control.task_id,
                                "mirofish_operation_id": control.operation_id}),
    }
    identifiers = []
    for index in range(count):
        identifier = "job_" + suffix + "_" + str(index)
        identifiers.append(identifier)
        h.driver.jobs[identifier] = {
            "uuid": identifier, "group_id": control.graph_id, "batch_id": control.batch_id,
            "status": "queued", "submitted_owner": h.engine.owner, "sequence_index": index,
            "source_description": "Synthetic source chunk", "data": "Synthetic body",
            "reference_time": "2026-10-17T00:00:00+00:00", "metadata": "{}",
        }
    return control, identifiers


def schedule(h, control):
    with bind_control(control):
        h.engine._schedule(control.batch_id, control.graph_id,
                           h.engine._process_batch(control.batch_id, control),
                           kind="batch", control=control)
    return h.engine.tasks[control.batch_id][0]


async def callback_finished(task):
    # Registered after the engine callback: observing this proves that its
    # receipt callback ran, including when cancellation preceded the first step.
    finished = asyncio.Event()
    task.add_done_callback(lambda _: finished.set())
    await bounded(finished.wait())


async def clean_tasks(*tasks):
    active = [task for task in tasks if task is not None]
    for task in active:
        if not task.done():
            task.cancel()
    if active:
        await bounded(asyncio.gather(*active, return_exceptions=True))
        # Drain engine completion callbacks before fixture monkeypatch teardown.
        await asyncio.gather(*(callback_finished(task) for task in active))


@async_case
@pytest.mark.parametrize("waiting_on", ["semaphore", "graph_lock", "database"])
async def test_stop_wins_admission_after_each_real_engine_coordination_wait(harness, waiting_on):
    h = harness
    control, jobs = build(h, count=1)
    h.engine.work_limit = ObservedSemaphore()
    graph_lock = ObservedLock()
    h.engine.graph_locks[control.graph_id] = graph_lock
    gate = Gate()
    if waiting_on == "semaphore":
        await h.engine.work_limit.acquire()
        entered = h.engine.work_limit.entered
        release = h.engine.work_limit.release
    elif waiting_on == "graph_lock":
        await graph_lock.acquire()
        entered = graph_lock.entered
        release = graph_lock.release
    else:
        h.driver.database_gate = gate
        entered, release = gate.entered, gate.release.set
    with bind_control(control):
        task = asyncio.create_task(h.engine._ingest(jobs[0], control))
    released = False
    try:
        await bounded(entered.wait())
        assert not control._admitted_episodes
        control.request_stop()
        release()
        released = True
        await bounded(task)
        assert not control._admitted_episodes
        assert control.marker("requested")["unstarted_chunks"] == 1
        assert not h.driver.claims
        assert not h.driver.status_writes
        assert not h.driver.graph_writes
        assert not h.gateway.calls
        assert h.driver.jobs[jobs[0]]["status"] == "queued"
    finally:
        if not released:
            release()
        await clean_tasks(task)


@async_case
@pytest.mark.parametrize("episode_fails", [False, True])
async def test_stop_allows_whole_admitted_episode_and_cancels_only_unstarted(harness, episode_fails):
    h = harness
    control, jobs = build(h, status="processing")
    h.engine.work_limit = asyncio.Semaphore(1)
    gate = h.graphiti.gates[jobs[0]] = Gate()
    if episode_fails:
        h.graphiti.failures[jobs[0]] = "synthetic extraction failed"
    task = schedule(h, control)
    try:
        await bounded(gate.entered.wait())
        assert control._admitted_episodes == {jobs[0]}
        control.request_stop()
        assert control.has_pending_receipts()
        gate.release.set()
        await callback_finished(task)
        await bounded(task)
        assert not control.has_pending_receipts()
        assert control.batch_id not in h.engine.tasks
        await owned(control, h.engine.settle_build_batch(control.batch_id, control))
        assert h.graphiti.calls == [jobs[0]]
        assert h.driver.jobs[jobs[1]]["status"] == "canceled"
        assert h.driver.jobs[jobs[0]]["status"] == ("failed" if episode_fails else "succeeded")
        marker = control.marker("requested")
        assert (marker["expected_chunks"], marker["succeeded_chunks"], marker["unstarted_chunks"]) == (
            2, 0 if episode_fails else 1, 1,
        )
        if episode_fails:
            assert "synthetic extraction failed" in control.error
            assert not control.unresolved
        else:
            assert h.gateway.calls == [("chat", jobs[0]), ("embedding", jobs[0])]
            assert ("graphiti", jobs[0]) in h.driver.graph_writes
        assert (h.graphiti.closed, h.gateway.closed, h.driver.closed) == (0, 0, 0)
    finally:
        gate.release.set()
        await clean_tasks(task)


@async_case
async def test_detached_receipt_settles_when_cancelled_before_first_step(harness):
    h = harness
    control, jobs = build(h, status="processing")
    h.engine.work_limit = asyncio.Semaphore(1)
    task = schedule(h, control)
    task.cancel()  # Deliberately no intervening await: the coroutine has not run.
    control.request_stop()
    try:
        assert control.has_pending_receipts()
        assert not h.driver.queries
        await callback_finished(task)
        assert task.cancelled()
        assert control.batch_id not in h.engine.tasks
        assert not control.has_pending_receipts()
        assert not h.graphiti.calls
        await owned(control, h.engine.settle_build_batch(control.batch_id, control))
        assert {h.driver.jobs[j]["status"] for j in jobs} == {"canceled"}
        assert h.driver.batches[control.batch_id]["status"] == "canceled"
    finally:
        await clean_tasks(task)


@async_case
@pytest.mark.parametrize("lost_response", [False, True])
async def test_detached_receipt_survives_process_response_boundary(harness, monkeypatch, lost_response):
    h = harness
    control, jobs = build(h)
    h.engine.work_limit = ObservedSemaphore(0)
    response_gate = Gate()
    original_get_batch = h.engine.get_batch

    async def delayed_response(identifier):
        result = await original_get_batch(identifier)
        if identifier in h.engine.tasks and not response_gate.release.is_set():
            await response_gate.pause()
            if lost_response:
                raise TimeoutError("synthetic process response lost")
        return result

    monkeypatch.setattr(h.engine, "get_batch", delayed_response)
    process_task = batch_task = None
    try:
        with control.operation("process batch"):
            process_task = asyncio.create_task(h.engine.process_batch(control.batch_id))
            await bounded(response_gate.entered.wait())
            batch_task = h.engine.tasks[control.batch_id][0]
            await bounded(h.engine.work_limit.entered.wait())
            control.request_stop()
            assert control.has_pending_receipts()
            response_gate.release.set()
            if lost_response:
                with pytest.raises(TimeoutError, match="process response lost"):
                    await bounded(process_task)
            else:
                assert (await bounded(process_task)).batch_id == control.batch_id
        # The calling operation has returned/failed; detached work still owns a receipt.
        assert control.has_pending_receipts()
        assert not batch_task.done()
        assert not h.gateway.calls
        h.engine.work_limit.release()
        await callback_finished(batch_task)
        await bounded(batch_task)
        assert not control.has_pending_receipts()
        await owned(control, h.engine.settle_build_batch(control.batch_id, control))
        assert {h.driver.jobs[j]["status"] for j in jobs} == {"canceled"}
        assert not control._admitted_episodes
    finally:
        response_gate.release.set()
        h.engine.work_limit.release()
        await clean_tasks(process_task, batch_task)


@async_case
@pytest.mark.parametrize("staged", [0, 2])
async def test_exact_draft_settlement_keeps_unrelated_jobs_and_graph_data(harness, staged):
    h = harness
    control, jobs = build(h, count=staged)
    other, other_jobs = build(h, count=1, suffix="other")
    control.set_expected_chunks(4)  # A partially staged source can have four planned chunks.
    graph_before = deepcopy(h.driver.graphs)
    foreign_before = deepcopy(h.driver.jobs[other_jobs[0]])
    h.driver.graph_writes.append(("preexisting", control.graph_id))
    control.request_stop()
    result = await owned(control, h.engine.settle_build_batch(control.batch_id, control))
    assert result.status == "canceled"
    assert all(h.driver.jobs[j]["status"] == "canceled" for j in jobs)
    assert h.driver.jobs[other_jobs[0]] == foreign_before
    assert h.driver.batches[other.batch_id]["status"] == "draft"
    assert h.driver.graphs == graph_before
    assert h.driver.graph_writes == [("preexisting", control.graph_id)]
    assert not h.driver.coordination
    assert not h.gateway.calls
    assert control.marker("requested")["unstarted_chunks"] == 4


@async_case
async def test_fully_succeeded_batch_is_preserved_when_stop_wins_before_verification(harness):
    h = harness
    control, jobs = build(h, count=1, status="processing")
    h.engine.work_limit = asyncio.Semaphore(1)
    task = schedule(h, control)
    try:
        await callback_finished(task)
        await bounded(task)
        assert h.driver.batches[control.batch_id]["status"] == "succeeded"
        assert not control.completed
        control.request_stop()
        before = deepcopy(h.driver.jobs)
        result = await owned(control, h.engine.settle_build_batch(control.batch_id, control))
        assert result.status == "succeeded"
        assert h.driver.jobs == before
        assert control.marker("requested")["succeeded_chunks"] == 1
        assert not control.has_pending_receipts()
    finally:
        await clean_tasks(task)


@async_case
@pytest.mark.parametrize("field,value", [
    ("batch_id", "batch_other"), ("graph_id", "graph_other"),
    ("project_id", "proj_other"), ("task_id", "task_other"),
    ("operation_id", "operation_other"),
])
async def test_settlement_rejects_each_foreign_build_identity_before_writes(harness, field, value):
    h = harness
    control, _ = build(h, status="processing")
    identifier = control.batch_id
    setattr(control, field, value)
    with pytest.raises(GraphBuildUnresolved, match="exact graph build"):
        await owned(control, h.engine.settle_build_batch(identifier, control))
    assert not h.driver.status_writes


@async_case
@pytest.mark.parametrize("owner", [None, "engine_foreign"])
async def test_settlement_refuses_non_draft_without_exact_engine_owner(harness, owner):
    h = harness
    control, _ = build(h, status="processing")
    h.driver.batches[control.batch_id]["owner"] = owner
    with pytest.raises(GraphBuildUnresolved, match="another local owner"):
        await owned(control, h.engine.settle_build_batch(control.batch_id, control))
    assert not h.driver.status_writes


@async_case
@pytest.mark.parametrize("status,submitted_owner", [
    ("processing", "engine_this"), ("queued", "engine_foreign"),
    ("succeeded", "engine_foreign"), ("unknown", "engine_this"),
])
async def test_settlement_keeps_unconfirmed_or_foreign_job_unresolved(harness, status, submitted_owner):
    h = harness
    control, jobs = build(h, count=2, status="processing")
    job = h.driver.jobs[jobs[1]]
    job.update(status=status, submitted_owner=submitted_owner)
    before = deepcopy(job)
    control.request_stop()
    with pytest.raises(GraphBuildUnresolved, match="unconfirmed or foreign"):
        await owned(control, h.engine.settle_build_batch(control.batch_id, control))
    assert h.driver.jobs[jobs[0]]["status"] == "canceled"
    assert job == before
    assert h.driver.batches[control.batch_id]["status"] == "processing"
    assert not any("SET b.status" in query for query, _ in h.driver.queries)
    assert not h.gateway.calls


@async_case
async def test_admitted_job_still_queued_is_not_relabeled_as_never_started(harness):
    h = harness
    control, jobs = build(h, count=2, status="processing")
    # Exact state after winning admission but before a claim/status journal is
    # confirmed. The row can still say queued; the controller has stronger evidence.
    assert control.admit_episode(jobs[0])
    control.request_stop()
    before = deepcopy(h.driver.jobs[jobs[0]])
    with pytest.raises(GraphBuildUnresolved, match="unconfirmed or foreign"):
        await owned(control, h.engine.settle_build_batch(control.batch_id, control))
    assert h.driver.jobs[jobs[0]] == before
    assert h.driver.jobs[jobs[1]]["status"] == "canceled"
    assert h.driver.batches[control.batch_id]["status"] == "processing"
    assert control.marker("requested")["unstarted_chunks"] == 1
    assert not h.gateway.calls


@async_case
@pytest.mark.parametrize("status,owner,expected", [
    ("succeeded", "engine_this", "succeeded"),
    ("queued", "engine_foreign", "queued"),
    ("processing", "engine_foreign", "processing"),
    ("queued", "engine_this", "canceled"),
    ("processing", "engine_this", "canceled"),
])
async def test_cancel_episode_preserves_success_and_foreign_ownership(harness, status, owner, expected):
    h = harness
    _, jobs = build(h, count=1)
    job = h.driver.jobs[jobs[0]]
    job.update(status=status, owner=owner, submitted_owner=owner)
    await bounded(h.engine._cancel_episode(jobs[0]))
    assert job["status"] == expected


@async_case
@pytest.mark.parametrize("fragment", ["SET j.status='canceled'", "SET b.status='canceled'"])
async def test_settlement_journal_failure_is_explicit_unresolved(harness, fragment):
    h = harness
    control, _ = build(h, count=1)
    control.request_stop()
    h.driver.fail_once.append(fragment)
    with pytest.raises(GraphBuildUnresolved, match="journal could not be saved"):
        await owned(control, h.engine.settle_build_batch(control.batch_id, control))
    assert not h.gateway.calls


@async_case
async def test_batch_processing_journal_failure_never_schedules_detached_work(harness):
    h = harness
    control, _ = build(h, count=1)
    h.driver.fail_once.append("SET b.status='processing'")
    with pytest.raises(GraphBuildUnresolved, match="journal could not be saved"):
        with control.operation("process batch"):
            await bounded(h.engine.process_batch(control.batch_id))
    assert control.unresolved
    assert not h.engine.tasks
    assert not h.gateway.calls


@async_case
@pytest.mark.parametrize("fragment", [
    "SET j.status='processing'", "SET j.status='succeeded'", "SET b.status=$status",
])
async def test_detached_journal_failure_retained_after_task_map_removal(harness, fragment):
    h = harness
    control, jobs = build(h, status="processing")
    h.engine.work_limit = asyncio.Semaphore(1)
    h.driver.fail_once.append(fragment)
    task = schedule(h, control)
    try:
        await callback_finished(task)
        with pytest.raises(GraphBuildUnresolved, match="journal could not be saved"):
            await bounded(task)
        assert control.batch_id not in h.engine.tasks
        assert not control.has_pending_receipts()
        assert control.unresolved
        assert "journal could not be saved" in control.error
        if fragment != "SET b.status=$status":
            assert jobs[1] not in control._admitted_episodes
            assert h.driver.jobs[jobs[1]]["status"] == "queued"
    finally:
        await clean_tasks(task)


@async_case
async def test_batch_cancellation_journal_failure_retained_by_detached_receipt(harness):
    h = harness
    control, jobs = build(h, status="processing")
    h.engine.work_limit = asyncio.Semaphore(1)
    gate = h.graphiti.gates[jobs[0]] = Gate()
    task = schedule(h, control)
    try:
        await bounded(gate.entered.wait())
        h.driver.fail_once.append("SET b.status='canceled'")
        task.cancel()
        await callback_finished(task)
        with pytest.raises(GraphBuildUnresolved, match="journal could not be saved"):
            await bounded(task)
        assert control.unresolved
        assert "journal could not be saved" in control.error
        assert control.batch_id not in h.engine.tasks
        assert not control.has_pending_receipts()
    finally:
        gate.release.set()
        await clean_tasks(task)


@async_case
async def test_stopping_one_build_leaves_other_build_and_queued_forward_independent(harness):
    h = harness
    stopped, first_jobs = build(h, status="processing")
    other, other_jobs = build(h, count=1, suffix="other", status="processing")
    h.engine.work_limit = asyncio.Semaphore(2)
    gate = h.graphiti.gates[first_jobs[0]] = Gate()
    unrelated_gate = Gate()

    async def already_queued_embedding():
        await unrelated_gate.pause()
        await h.gateway.forward("unrelated embedding", "queued_before_stop")

    first = schedule(h, stopped)
    queued = asyncio.create_task(already_queued_embedding())
    second = None
    try:
        await bounded(gate.entered.wait())
        await bounded(unrelated_gate.entered.wait())
        stopped.request_stop()
        second = schedule(h, other)
        await callback_finished(second)
        await bounded(second)
        assert h.driver.jobs[other_jobs[0]]["status"] == "succeeded"
        assert h.driver.batches[other.batch_id]["status"] == "succeeded"
        assert not other.stop_requested
        gate.release.set()
        await callback_finished(first)
        await bounded(first)
        await owned(stopped, h.engine.settle_build_batch(stopped.batch_id, stopped))
        assert not stopped.has_pending_receipts()
        assert not queued.done()  # A settled build is not a gateway-idle claim.
        unrelated_gate.release.set()
        await bounded(queued)
        assert ("unrelated embedding", "queued_before_stop") in h.gateway.calls
        assert (h.graphiti.closed, h.gateway.closed, h.driver.closed) == (0, 0, 0)
    finally:
        gate.release.set()
        unrelated_gate.release.set()
        await clean_tasks(first, second, queued)
