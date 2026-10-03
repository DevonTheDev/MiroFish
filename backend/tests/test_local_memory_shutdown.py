"""Close every owned local-memory resource when earlier cleanup steps fail."""

import asyncio
import threading

import pytest

from app.memory.graphiti_engine import GraphitiMemoryEngine
from app.memory.local_graphiti import LocalGraphitiClient, _LoopRunner
from test_local_memory_contract import settings
from test_local_memory_integration import URI, client as client


class Resource:
    def __init__(self, name, calls, failures):
        self.name, self.calls, self.failures = name, calls, failures

    async def close(self):
        self.calls.append(self.name)
        if self.name in self.failures:
            raise self.failures[self.name]


@pytest.mark.parametrize(
    "failure", [None, "journal", "graphiti", "driver", "first-http", "second-http"]
)
def test_client_attempts_all_resource_closes_and_surfaces_first_failure(
    monkeypatch, failure
):
    calls = []
    error = OSError(f"synthetic {failure} failure")
    failures = {failure: error} if failure else {}
    database_resource = "driver" if failure == "driver" else "graphiti"

    async def initialize(engine):
        setattr(engine, database_resource, Resource(database_resource, calls, failures))
        engine.http_clients = [
            Resource(name, calls, failures) for name in ("first-http", "second-http")
        ]
        if failure == "journal":

            async def blocked():
                try:
                    await asyncio.Event().wait()
                finally:
                    calls.append("task-finally")

            async def query(*args, **kwargs):
                calls.append("journal")
                raise error

            engine._query = query
            engine._schedule("owned-episode", "group", blocked())
            await asyncio.sleep(0)

    monkeypatch.setattr(GraphitiMemoryEngine, "initialize", initialize)
    client = LocalGraphitiClient(settings(request_timeout=2))
    if failure:
        with pytest.raises(OSError) as caught:
            client.close()
        assert caught.value is error
    else:
        client.close()
    expected_prefix = ["task-finally", "journal"] if failure == "journal" else []
    assert calls == [*expected_prefix, database_resource, "first-http", "second-http"]
    assert not client._runner.thread.is_alive()
    assert client._runner.loop.is_closed()
    before = list(calls)
    client.close()
    assert calls == before
    with pytest.raises(RuntimeError, match="closed"):
        client._call("initialize")


def test_failed_journal_does_not_skip_other_owned_jobs_or_batch_items(monkeypatch):
    calls, queries = [], []
    first_error = OSError("first journal failure")

    async def initialize(engine):
        engine.graphiti = Resource("graphiti", calls, {})
        engine.http_clients = [Resource("http", calls, {})]

        async def blocked():
            await asyncio.Event().wait()

        async def query(statement, **params):
            queries.append((statement, params))
            if len(queries) == 1:
                raise first_error
            return []

        engine._query = query
        engine._schedule("first", "group", blocked())
        engine._schedule("second", "group", blocked())
        engine._schedule("batch", "group", blocked(), kind="batch")

    monkeypatch.setattr(GraphitiMemoryEngine, "initialize", initialize)
    client = LocalGraphitiClient(settings(request_timeout=2))
    with pytest.raises(OSError) as caught:
        client.close()
    assert caught.value is first_error
    assert [params["id"] for _, params in queries] == [
        "first",
        "second",
        "batch",
        "batch",
    ]
    assert all(params["owner"] == client._engine.owner for _, params in queries)
    assert all("canceled" in statement for statement, _ in queries)
    assert calls == ["graphiti", "http"]
    assert not client._runner.thread.is_alive()


def test_multiple_cleanup_errors_keep_first_and_record_secondary_errors(monkeypatch):
    calls = []
    failures = {
        name: OSError(f"failed {name}")
        for name in ("graphiti", "first-http", "second-http")
    }

    async def initialize(engine):
        engine.graphiti = Resource("graphiti", calls, failures)
        engine.http_clients = [
            Resource(name, calls, failures) for name in ("first-http", "second-http")
        ]

    monkeypatch.setattr(GraphitiMemoryEngine, "initialize", initialize)
    client = LocalGraphitiClient(settings(request_timeout=2))
    with pytest.raises(OSError) as caught:
        client.close()
    assert caught.value is failures["graphiti"]
    assert calls == ["graphiti", "first-http", "second-http"]
    notes = " ".join(caught.value.__notes__)
    assert "first-http" in notes and "second-http" in notes
    assert not client._runner.thread.is_alive()


def test_cancellation_is_preserved_after_attempting_remaining_closes():
    async def scenario():
        calls = []
        cancelled = asyncio.CancelledError("synthetic close cancellation")
        engine = GraphitiMemoryEngine(settings())
        engine.graphiti = Resource("graphiti", calls, {"graphiti": cancelled})
        engine.http_clients = [Resource("http", calls, {})]
        with pytest.raises(asyncio.CancelledError) as caught:
            await engine.close()
        assert caught.value is cancelled
        assert calls == ["graphiti", "http"]

    asyncio.run(scenario())


@pytest.mark.parametrize("loop_failure", [False, True])
def test_constructor_retains_initialization_error_after_cleanup_errors(
    monkeypatch, loop_failure
):
    calls = []
    original = ValueError("original initialization failure")
    cleanup = OSError("synthetic graph cleanup failure")

    async def initialize(engine):
        engine.graphiti = Resource("graphiti", calls, {"graphiti": cleanup})
        engine.http_clients = [Resource("http", calls, {})]
        raise original

    monkeypatch.setattr(GraphitiMemoryEngine, "initialize", initialize)
    if loop_failure:
        real_close = _LoopRunner.close

        def close_then_fail(runner):
            real_close(runner)
            raise RuntimeError("synthetic loop cleanup failure")

        monkeypatch.setattr(_LoopRunner, "close", close_then_fail)
    before = {thread.ident for thread in threading.enumerate()}
    with pytest.raises(ValueError) as caught:
        LocalGraphitiClient(settings(request_timeout=2))
    assert caught.value is original
    assert calls == ["graphiti", "http"]
    assert {thread.ident for thread in threading.enumerate()} == before
    assert "graph cleanup failure" in " ".join(caught.value.__notes__)
    if loop_failure:
        assert "loop cleanup failure" in " ".join(cleanup.__notes__)
        assert "loop cleanup failure" in " ".join(caught.value.__notes__)


def test_loop_cleanup_error_does_not_replace_earlier_engine_close_error(monkeypatch):
    calls = []
    error = OSError("original engine close failure")

    async def initialize(engine):
        engine.graphiti = Resource("graphiti", calls, {"graphiti": error})
        engine.http_clients = [Resource("http", calls, {})]

    real_close = _LoopRunner.close

    def close_then_fail(runner):
        real_close(runner)
        raise RuntimeError("later loop close failure")

    monkeypatch.setattr(GraphitiMemoryEngine, "initialize", initialize)
    monkeypatch.setattr(_LoopRunner, "close", close_then_fail)
    client = LocalGraphitiClient(settings(request_timeout=2))
    with pytest.raises(OSError) as caught:
        client.close()
    assert caught.value is error
    assert "later loop close failure" in " ".join(error.__notes__)
    assert calls == ["graphiti", "http"]
    assert not client._runner.thread.is_alive()


def test_loop_cleanup_failure_alone_is_still_surfaced(monkeypatch):
    calls = []
    error = RuntimeError("loop close failure")

    async def initialize(engine):
        engine.graphiti = Resource("graphiti", calls, {})
        engine.http_clients = [Resource("http", calls, {})]

    real_close = _LoopRunner.close

    def close_then_fail(runner):
        real_close(runner)
        raise error

    monkeypatch.setattr(GraphitiMemoryEngine, "initialize", initialize)
    monkeypatch.setattr(_LoopRunner, "close", close_then_fail)
    adapter = LocalGraphitiClient(settings(request_timeout=2))
    with pytest.raises(RuntimeError) as caught:
        adapter.close()
    assert caught.value is error
    assert calls == ["graphiti", "http"]
    assert not adapter._runner.thread.is_alive()


@pytest.mark.skipif(not URI, reason="isolated Neo4j not configured")
def test_real_driver_and_http_clients_close_after_journal_failure(client, monkeypatch):
    adapter, _model_state, _graph, _settings = client
    engine = adapter._engine
    driver = engine.driver.client
    http_clients = list(engine.http_clients)
    assert not driver._closed
    assert all(not resource.is_closed() for resource in http_clients)
    error = OSError("synthetic cancellation journal failure")

    async def failed_journal(_identifier):
        raise error

    async def admit():
        async def pending():
            await asyncio.Event().wait()

        engine._schedule("synthetic-shutdown-job", "no-graph-writes", pending())
        await asyncio.sleep(0)

    monkeypatch.setattr(engine, "_cancel_episode", failed_journal)
    adapter._runner.call(admit(), 5)
    with pytest.raises(OSError) as caught:
        adapter.close()
    assert caught.value is error
    assert driver._closed
    assert all(resource.is_closed() for resource in http_clients)
    assert adapter._runner.loop.is_closed()
    assert not adapter._runner.thread.is_alive()
