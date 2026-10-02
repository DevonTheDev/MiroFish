import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest
from pydantic import BaseModel, Field

from app.memory.local_graphiti import (
    LocalMemorySettings,
    LocalEmbeddingReranker,
    decode_cursor,
    encode_cursor,
    encode_ontology,
    decode_ontology,
)


def settings(**kwargs):
    values = dict(
        graph_uri="bolt://127.0.0.1:7687",
        graph_user="neo4j",
        graph_password="test-only",
        llm_base_url="http://127.0.0.1:11434/v1",
        llm_model="local-model",
        embedding_base_url="http://127.0.0.1:11434/v1",
        embedding_model="nomic-embed-text",
    )
    values.update(kwargs)
    return LocalMemorySettings(**values)


@pytest.mark.parametrize(
    "key,value",
    [
        ("llm_base_url", "https://api.openai.com/v1"),
        ("embedding_base_url", "http://example.com/v1"),
        ("graph_uri", "neo4j+s://example.com"),
        ("llm_model", ""),
        ("embedding_model", ""),
        ("embedding_dimensions", 0),
        ("max_concurrency", 0),
        ("request_timeout", -1),
    ],
)
def test_settings_reject_remote_or_invalid_values(key, value):
    with pytest.raises(ValueError):
        settings(**{key: value})


def test_settings_are_explicit_and_immutable():
    value = settings()
    assert value.database == "neo4j"
    assert value.embedding_dimensions == 768
    with pytest.raises(Exception):
        value.llm_model = "other"
    assert (
        replace(value, llm_base_url="http://[::1]:8080/v1").llm_model == "local-model"
    )


def test_cursors_are_bound_to_graph_and_collection():
    token = encode_cursor("graph_a", "nodes", "uuid-2")
    assert decode_cursor(token, "graph_a", "nodes") == "uuid-2"
    for graph, kind in [("graph_b", "nodes"), ("graph_a", "edges")]:
        with pytest.raises(ValueError):
            decode_cursor(token, graph, kind)
    with pytest.raises(ValueError):
        decode_cursor("not-json", "graph_a", "nodes")


def test_ontology_roundtrip_preserves_types_attributes_and_directions():
    class Person(BaseModel):
        """A person in the source material."""

        role: str | None = Field(None, description="Their role")

    class Knows(BaseModel):
        strength: str | None = Field(None, description="How they know one another")

    encoded = encode_ontology(
        {"Person": Person},
        {
            "KNOWS": (Knows, [SimpleNamespace(source="Person", target="Person")]),
        },
    )
    entities, edges, mapping = decode_ontology(encoded)
    assert entities["Person"].__doc__ == Person.__doc__
    assert entities["Person"].model_fields["role"].description == "Their role"
    assert mapping == {("Person", "Person"): ["KNOWS"]}
    assert (
        edges["KNOWS"].model_fields["strength"].description
        == "How they know one another"
    )


def test_local_reranking_uses_embedding_similarity_without_cloud_or_llm_calls():
    class Embedder:
        async def create_batch(self, strings):
            vectors = {
                "question": [1.0, 0.0],
                "relevant": [1.0, 0.0],
                "other": [0.0, 1.0],
            }
            return [vectors[value] for value in strings]

    reranker = LocalEmbeddingReranker(Embedder())
    assert asyncio.run(reranker.rank("question", ["other", "relevant"])) == [
        ("relevant", 1.0),
        ("other", 0.0),
    ]
    assert asyncio.run(reranker.rank("question", [])) == []


@pytest.mark.parametrize(
    "key,value",
    [
        ("graph_uri", "neo4j://127.0.0.1:7687"),
        ("graph_uri", "bolt://@127.0.0.1:7687"),
        ("llm_base_url", "http://127.0.0.1:0/v1"),
        ("llm_base_url", "http://127.0.0.1/v1?"),
        ("llm_base_url", "http://127.0.0.1/%76%31"),
        ("embedding_dimensions", True),
        ("max_concurrency", 1.5),
        ("request_timeout", True),
        ("llm_model", "gpt-oss:cloud"),
    ],
)
def test_settings_reject_ambiguous_transport_and_limits(key, value):
    with pytest.raises(ValueError):
        settings(**{key: value})


def test_settings_canonicalize_localhost_without_dns():
    value = settings(
        graph_uri="bolt://localhost:7687", llm_base_url="http://localhost:8080/v1/"
    )
    assert value.graph_uri == "bolt://127.0.0.1:7687"
    assert value.llm_base_url == "http://127.0.0.1:8080/v1"


def test_engine_constructor_failure_does_not_leak_loop_thread(monkeypatch):
    import threading
    from app.memory import graphiti_engine
    from app.memory.local_graphiti import LocalGraphitiClient

    def fail(_settings):
        raise RuntimeError("construction failed")

    monkeypatch.setattr(graphiti_engine, "GraphitiMemoryEngine", fail)
    before = {thread.ident for thread in threading.enumerate()}
    with pytest.raises(RuntimeError, match="construction failed"):
        LocalGraphitiClient(settings())
    assert {thread.ident for thread in threading.enumerate()} == before


def test_optional_dependency_failure_closes_loop_thread(monkeypatch):
    import threading
    from app.memory import graphiti_engine
    from app.memory.local_graphiti import LocalGraphitiClient

    async def fail(_self):
        raise RuntimeError("optional Graphiti dependency missing")

    monkeypatch.setattr(graphiti_engine.GraphitiMemoryEngine, "initialize", fail)
    before = {thread.ident for thread in threading.enumerate()}
    with pytest.raises(RuntimeError, match="dependency missing"):
        LocalGraphitiClient(settings())
    assert {thread.ident for thread in threading.enumerate()} == before


def test_close_waits_for_inflight_api_call_and_rejects_new_work(monkeypatch):
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor
    from app.memory import graphiti_engine
    from app.memory.local_graphiti import LocalGraphitiClient

    entered, release = threading.Event(), threading.Event()

    class Engine:
        def __init__(self, _settings):
            self.closed = False

        async def initialize(self):
            pass

        async def work(self):
            entered.set()
            while not release.is_set():
                await asyncio.sleep(0.01)
            assert not self.closed
            return "finished"

        async def close(self):
            self.closed = True

    monkeypatch.setattr(graphiti_engine, "GraphitiMemoryEngine", Engine)
    client = LocalGraphitiClient(settings(request_timeout=2))
    with ThreadPoolExecutor(max_workers=2) as pool:
        working = pool.submit(client._call, "work")
        assert entered.wait(1)
        closing = pool.submit(client.close)
        time.sleep(0.05)
        try:
            assert not closing.done()
        finally:
            release.set()
        assert working.result(timeout=2) == "finished"
        closing.result(timeout=2)
    assert not client._runner.thread.is_alive()
    with pytest.raises(RuntimeError, match="closed"):
        client._call("work")


def test_runner_close_drains_cancellation_finally_blocks():
    import threading
    from concurrent.futures import ThreadPoolExecutor, CancelledError
    from app.memory.local_graphiti import _LoopRunner

    entered, cleaned = threading.Event(), threading.Event()

    async def blocked():
        try:
            entered.set()
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    runner = _LoopRunner()
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(runner.call, blocked(), 2)
        assert entered.wait(1)
        runner.close()
        with pytest.raises(CancelledError):
            pending.result(timeout=1)
    assert cleaned.is_set() and not runner.thread.is_alive()


@pytest.mark.parametrize("started", [False, True])
def test_graceful_close_journals_even_not_started_or_initial_lookup_jobs(started):
    from app.memory.graphiti_engine import GraphitiMemoryEngine

    async def scenario():
        engine = GraphitiMemoryEngine(settings())
        entered = asyncio.Event()
        writes = []

        async def job(_identifier):
            entered.set()
            await asyncio.Event().wait()

        async def query(statement, **params):
            writes.append((statement, params))
            return []

        engine._job, engine._query = job, query
        engine._schedule("test-id", "test-group", engine._ingest("test-id"))
        if started:
            await asyncio.wait_for(entered.wait(), 1)
        await engine.close()
        assert any(
            "canceled" in statement and params.get("id") == "test-id"
            for statement, params in writes
        )

    asyncio.run(scenario())
