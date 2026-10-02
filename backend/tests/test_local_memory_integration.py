"""Opt-in tests against an isolated Neo4j and synthetic loopback model server.

Set MIRO_TEST_NEO4J_URI to a disposable local Neo4j. Only unique test graph groups
are created/deleted. No model downloads, external API or production DATA is used.
"""

import json
from concurrent.futures import ThreadPoolExecutor
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
from types import SimpleNamespace
import uuid

import pytest
from pydantic import BaseModel

from app.memory.local_graphiti import LocalGraphitiClient, LocalMemorySettings
from app.local_runtime.gateway import GatewaySettings, LocalInferenceGateway

URI = os.environ.get("MIRO_TEST_NEO4J_URI")
pytestmark = pytest.mark.skipif(not URI, reason="isolated Neo4j not configured")


@pytest.fixture
def client(monkeypatch):
    pytest.importorskip("graphiti_core")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-used")
    state = SimpleNamespace(
        calls=[], fail=False, typed=False, block=None, started=threading.Event()
    )

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state.calls.append((self.path, body, self.headers.get("Authorization")))
            state.started.set()
            if state.block is not None:
                state.block.wait(10)
            if state.fail:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"synthetic failure"}}')
                return
            if self.path.endswith("/embeddings"):
                texts = (
                    body["input"]
                    if isinstance(body["input"], list)
                    else [body["input"]]
                )
                response = {
                    "object": "list",
                    "data": [
                        {"object": "embedding", "index": i, "embedding": [1.0, 0.0]}
                        for i, _ in enumerate(texts)
                    ],
                    "model": body["model"],
                    "usage": {"prompt_tokens": 1, "total_tokens": 1},
                }
            else:
                schema = body.get("response_format", {}).get("json_schema", {})
                name = schema.get("name", "")
                if name == "ExtractedEntities":
                    output = {
                        "extracted_entities": [
                            {"name": "Alice", "entity_type_id": int(state.typed)},
                            {"name": "Bob", "entity_type_id": int(state.typed)},
                        ]
                    }
                elif name == "ExtractedEdges":
                    output = {
                        "edges": [
                            {
                                "source_entity_name": "Alice",
                                "target_entity_name": "Bob",
                                "relation_type": "KNOWS",
                                "fact": "Alice knows Bob",
                                "valid_at": None,
                                "invalid_at": None,
                            }
                        ]
                    }
                elif name == "NodeResolutions":
                    output = {"entity_resolutions": []}
                elif name == "EdgeDuplicate":
                    output = {"duplicate_facts": [], "contradicted_facts": []}
                elif name == "SummarizedEntities":
                    output = {
                        "summaries": [
                            {"name": "Alice", "summary": "Alice knows Bob"},
                            {"name": "Bob", "summary": "Bob knows Alice"},
                        ]
                    }
                elif name == "EntitySummary":
                    output = {"summary": "A person in this test"}
                else:
                    output = {
                        key: None
                        for key in schema.get("schema", {}).get("properties", {})
                    }
                response = {
                    "id": "local-test",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": json.dumps(output),
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                }
            encoded = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/v1"
    gateway = LocalInferenceGateway(
        GatewaySettings(
            llm_base_url=url,
            embedding_base_url=url,
            request_timeout=20,
            reasoning_effort="none",
        )
    )
    gateway_url = gateway.start()
    settings = LocalMemorySettings(
        graph_uri=URI,
        graph_user="neo4j",
        graph_password="",
        llm_base_url=gateway_url,
        llm_model="synthetic-local",
        embedding_base_url=gateway_url,
        embedding_model="synthetic-embed",
        embedding_dimensions=2,
        request_timeout=20,
    )
    adapter = LocalGraphitiClient(settings)
    groups = []

    def graph():
        graph_id = "miro_test_" + uuid.uuid4().hex
        adapter.graph.create(
            graph_id=graph_id, name="Synthetic graph", description="test"
        )
        groups.append(graph_id)
        return graph_id

    try:
        yield adapter, state, graph, settings
    finally:
        for group in groups:
            try:
                adapter.graph.delete(group)
            except Exception:
                pass
        adapter.close()
        if state.block is not None:
            state.block.set()
        gateway.close()
        server.shutdown()
        server.server_close()
        thread.join(5)


def wait_episode(adapter, identifier):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        episode = adapter.graph.episode.get(uuid_=identifier)
        if episode.processed:
            return episode
        time.sleep(0.05)
    pytest.fail("synthetic local ingestion did not finish")


def test_local_graph_metadata_and_ontology_survive_another_client(client):
    adapter, state, graph, settings = client
    group = graph()

    class Person(BaseModel):
        role: str | None = None

    adapter.graph.set_ontology(
        graph_ids=[group], entities={"Person": Person}, edges=None
    )
    other = LocalGraphitiClient(settings)
    try:
        assert other.graph.get(group).name == "Synthetic graph"
        assert "Person" in other.graph.get(group).ontology["entities"]
        assert state.calls == [], "metadata reads must not invoke inference"
    finally:
        other.close()


def test_real_graphiti_ingestion_and_search_keep_groups_isolated(client, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    adapter, state, graph, _settings = client
    first, second = graph(), graph()
    episode = adapter.graph.add(
        graph_id=first,
        type="text",
        data="Alice knows Bob.",
        metadata={"test": "source"},
    )
    completed = wait_episode(adapter, episode.uuid_)
    assert completed.metadata == {"test": "source"}
    nodes = adapter.graph.node.get_by_graph_id(first, limit=100)
    edges = adapter.graph.edge.get_by_graph_id(first, limit=100)
    assert {node.name for node in nodes} == {"Alice", "Bob"}
    assert any(edge.fact == "Alice knows Bob" for edge in edges)
    assert all(edge.episodes == [episode.uuid_] for edge in edges)
    assert adapter.graph.node.get_by_graph_id(second, limit=100) == []
    result = adapter.graph.search(
        graph_id=first, query="Alice", scope="edges", limit=5, reranker="rrf"
    )
    assert result.edges
    assert (
        adapter.graph.search(
            graph_id=second, query="Alice", scope="edges", limit=5
        ).edges
        == []
    )
    page = adapter.graph.node.with_raw_response.get_by_graph_id(first, limit=1)
    assert len(page.data) == 1 and page.headers["zep-next-cursor"]
    page2 = adapter.graph.node.with_raw_response.get_by_graph_id(
        first, limit=1, cursor=page.headers["zep-next-cursor"]
    )
    assert page.data[0].uuid_ != page2.data[0].uuid_
    with pytest.raises(ValueError):
        adapter.graph.node.with_raw_response.get_by_graph_id(
            second, limit=1, cursor=page.headers["zep-next-cursor"]
        )
    assert adapter.graph.node.get(uuid_=nodes[0].uuid_).group_id == first
    assert adapter.graph.node.get_edges(node_uuid=nodes[0].uuid_)
    assert state.calls and all(auth == "Bearer local" for _, _, auth in state.calls)
    assert all(
        body.get("reasoning_effort") == "none" and body.get("max_tokens", 2048) <= 2048
        for path, body, _ in state.calls
        if path.endswith("/chat/completions")
    )
    assert all(
        client.max_retries == 0
        and not client._client.follow_redirects
        and not client._client._trust_env
        for client in adapter._engine.http_clients
    )
    assert {body["model"] for _, body, _ in state.calls} <= {
        "synthetic-local",
        "synthetic-embed",
    }


def test_batch_journal_is_idempotent_and_exposes_completion(client):
    adapter, _state, graph, _settings = client
    group = graph()
    metadata = {"graph_id": group, "mirofish_operation_id": "same-operation"}
    batch = adapter.batch.create(metadata=metadata)
    assert adapter.batch.create(metadata=metadata).batch_id == batch.batch_id
    item = SimpleNamespace(
        type="graph_episode",
        graph_id=group,
        data_type="text",
        data="Alice knows Bob.",
        metadata={"chunk_index": 0},
        source_description="Synthetic source",
    )
    first = adapter.batch.add(batch_id=batch.batch_id, items=[item])
    assert (
        adapter.batch.add(batch_id=batch.batch_id, items=[item])[0].episode_uuid
        == first[0].episode_uuid
    )
    assert len(adapter.batch.list_items(batch.batch_id).items) == 1
    adapter.batch.process(batch.batch_id)
    wait_episode(adapter, first[0].episode_uuid)
    deadline = time.monotonic() + 5
    while (
        adapter.batch.get(batch.batch_id).status == "processing"
        and time.monotonic() < deadline
    ):
        time.sleep(0.01)
    assert adapter.batch.get(batch.batch_id).status == "succeeded"
    assert adapter.batch.get(batch.batch_id).progress.succeeded_items == 1
    adapter.batch.process(batch.batch_id)
    assert len(adapter.batch.list_items(batch.batch_id).items) == 1


def test_local_model_failure_is_visible_and_never_marked_processed(client):
    adapter, state, graph, _settings = client
    group = graph()
    state.fail = True
    episode = adapter.graph.add(graph_id=group, type="text", data="Synthetic failure")
    with pytest.raises(RuntimeError, match="failed"):
        wait_episode(adapter, episode.uuid_)


def test_typed_ontology_is_applied_to_real_extracted_nodes(client):
    adapter, state, graph, _settings = client
    group = graph()
    state.typed = True

    class Person(BaseModel):
        """A person mentioned by the source."""

        role: str | None = None

    adapter.graph.set_ontology(graph_ids=[group], entities={"Person": Person})
    episode = adapter.graph.add(graph_id=group, type="text", data="Alice knows Bob.")
    wait_episode(adapter, episode.uuid_)
    assert all(
        "Person" in node.labels for node in adapter.graph.node.get_by_graph_id(group)
    )
    assert adapter.graph.search(
        graph_id=group, query="Alice", scope="nodes", reranker="cross_encoder"
    ).nodes


def test_concurrent_exact_replays_only_ingest_once(client):
    adapter, state, graph, settings = client
    group = graph()
    other = LocalGraphitiClient(settings)
    try:

        def submit(index):
            target = adapter if index % 2 else other
            return target.graph.add(
                graph_id=group,
                type="text",
                data="Alice knows Bob.",
                created_at="2026-01-01T00:00:00Z",
            ).uuid_

        with ThreadPoolExecutor(max_workers=8) as pool:
            identifiers = list(pool.map(submit, range(8)))
        assert len(set(identifiers)) == 1
        wait_episode(adapter, identifiers[0])
        assert len(adapter.graph.node.get_by_graph_id(group)) == 2
        assert (
            sum(
                body.get("response_format", {}).get("json_schema", {}).get("name")
                == "ExtractedEntities"
                for _, body, _ in state.calls
            )
            == 1
        )
    finally:
        other.close()


def test_delete_waits_for_another_client_ingestion_then_removes_all_group_data(client):
    adapter, state, graph, settings = client
    group = graph()
    state.block = threading.Event()
    other = LocalGraphitiClient(settings)
    try:
        adapter.graph.add(graph_id=group, type="text", data="Alice knows Bob.")
        assert state.started.wait(5)
        with ThreadPoolExecutor(max_workers=1) as pool:
            deleting = pool.submit(other.graph.delete, group)
            time.sleep(0.15)
            try:
                assert not deleting.done(), (
                    "deletion must serialize with active ingestion from another client"
                )
            finally:
                state.block.set()
            assert deleting.result(timeout=15).deleted
        rows = other._runner.call(
            other._engine._query(
                "MATCH (n {group_id:$id}) RETURN count(n) AS total", id=group
            ),
            10,
        )
        assert rows[0]["total"] == 0
    finally:
        state.block.set()
        other.close()


def test_batch_rejects_cross_graph_items_and_supports_paging(client):
    adapter, _state, graph, _settings = client
    group, other = graph(), graph()
    batch = adapter.batch.create(
        metadata={"graph_id": group, "mirofish_operation_id": "paging"}
    )

    def item(index, target=group):
        return SimpleNamespace(
            type="graph_episode",
            data_type="text",
            graph_id=target,
            data="Text " + str(index),
            metadata={"chunk_index": index},
            source_description="",
        )

    with pytest.raises(ValueError):
        adapter.batch.add(batch_id=batch.batch_id, items=[item(0, other)])
    assert adapter.batch.list_items(batch.batch_id).items == []
    adapter.batch.add(batch_id=batch.batch_id, items=[item(0), item(1)])
    page = adapter.batch.list_items(batch.batch_id, limit=1)
    assert page.items[0].sequence_index == 0 and page.next_cursor == 1
    page2 = adapter.batch.list_items(batch.batch_id, limit=1, cursor=page.next_cursor)
    assert page2.items[0].sequence_index == 1 and page2.next_cursor is None
    with pytest.raises(ValueError):
        adapter.batch.add(
            batch_id=batch.batch_id,
            items=[SimpleNamespace(**{**item(0).__dict__, "data": "different"})],
        )


def test_close_cancels_pending_jobs_and_stops_worker(client):
    adapter, state, graph, settings = client
    group = graph()
    state.block = threading.Event()
    episode = adapter.graph.add(graph_id=group, type="text", data="Alice knows Bob.")
    assert state.started.wait(5)
    adapter.close()
    adapter.close()
    assert not adapter._runner.thread.is_alive()
    with pytest.raises(RuntimeError, match="closed"):
        adapter.graph.get(group)
    other = LocalGraphitiClient(settings)
    try:
        with pytest.raises(RuntimeError, match="canceled"):
            other.graph.episode.get(uuid_=episode.uuid_)
        other.graph.delete(group)
    finally:
        state.block.set()
        other.close()


def test_existing_builder_and_entity_reader_use_local_protocol(client):
    from app.services.graph_builder import GraphBuilderService
    from app.services.zep_entity_reader import ZepEntityReader

    adapter, state, graph, _settings = client
    group = graph()
    state.typed = True
    builder = GraphBuilderService.__new__(GraphBuilderService)
    builder.client = adapter
    builder.set_ontology(
        group,
        {
            "entity_types": [
                {
                    "name": "Person",
                    "description": "A person",
                    "attributes": [{"name": "role", "description": "Their role"}],
                }
            ],
            "edge_types": [
                {
                    "name": "KNOWS",
                    "source_targets": [{"source": "Person", "target": "Person"}],
                    "attributes": [],
                }
            ],
        },
    )
    submission = builder.add_text_batches(group, ["Alice knows Bob."])
    for identifier in submission.episode_uuids:
        wait_episode(adapter, identifier)
    assert builder._wait_for_batch(submission) == submission.episode_uuids
    data = builder.get_graph_data(group)
    assert data["node_count"] == 2 and data["edge_count"] == 1
    assert data["edges"][0]["source_node_name"] == "Alice"
    assert data["edges"][0]["target_node_name"] == "Bob"
    reader = ZepEntityReader.__new__(ZepEntityReader)
    reader.client = adapter
    defined = reader.filter_defined_entities(group)
    assert defined.filtered_count == 2 and defined.entity_types == {"Person"}
    assert all(entity.related_edges for entity in defined.entities)


def test_batch_admission_serializes_with_process_across_clients(client):
    import asyncio

    adapter, _state, graph, settings = client
    group = graph()
    batch = adapter.batch.create(
        metadata={"graph_id": group, "mirofish_operation_id": "admission-race"}
    )

    def item(index):
        return SimpleNamespace(
            type="graph_episode",
            data_type="text",
            graph_id=group,
            data="Alice knows Bob.",
            metadata={"chunk_index": index},
            source_description="test",
        )

    adapter.batch.add(batch_id=batch.batch_id, items=[item(0)])
    other = LocalGraphitiClient(settings)
    entered, release = threading.Event(), threading.Event()
    reserve = adapter._engine._reserve_job

    async def paused(*args, **kwargs):
        entered.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        return await reserve(*args, **kwargs)

    adapter._engine._reserve_job = paused
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            adding = pool.submit(
                adapter.batch.add, batch_id=batch.batch_id, items=[item(1)]
            )
            assert entered.wait(5)
            processing = pool.submit(other.batch.process, batch.batch_id)
            time.sleep(0.15)
            try:
                assert not processing.done(), (
                    "process must wait for complete batch admission"
                )
            finally:
                release.set()
            added = adding.result(timeout=10)
            processing.result(timeout=10)
        wait_episode(other, added[0].episode_uuid)
        deadline = time.monotonic() + 5
        while (
            other.batch.get(batch.batch_id).status == "processing"
            and time.monotonic() < deadline
        ):
            time.sleep(0.02)
        final = other.batch.get(batch.batch_id)
        assert final.status == "succeeded"
        assert final.progress.total_items == final.progress.succeeded_items == 2
        with pytest.raises(ValueError, match="draft"):
            other.batch.add(batch_id=batch.batch_id, items=[item(2)])
    finally:
        release.set()
        adapter._engine._reserve_job = reserve
        other.close()


def test_close_cancels_queued_remainder_of_owned_batch(client):
    adapter, state, graph, settings = client
    group = graph()
    batch = adapter.batch.create(
        metadata={"graph_id": group, "mirofish_operation_id": "cancel-batch"}
    )
    items = [
        SimpleNamespace(
            type="graph_episode",
            data_type="text",
            graph_id=group,
            data="Alice knows Bob.",
            metadata={"chunk_index": index},
            source_description="test",
        )
        for index in range(2)
    ]
    adapter.batch.add(batch_id=batch.batch_id, items=items)
    state.block = threading.Event()
    adapter.batch.process(batch.batch_id)
    assert state.started.wait(5)
    adapter.close()
    other = LocalGraphitiClient(settings)
    try:
        assert other.batch.get(batch.batch_id).status == "canceled"
        assert [
            item.status for item in other.batch.list_items(batch.batch_id).items
        ] == ["canceled", "canceled"]
        other.graph.delete(group)
    finally:
        state.block.set()
        other.close()


@pytest.mark.parametrize("failure", ["error", "cancel"])
def test_waiting_replay_cannot_overwrite_another_clients_active_job(client, failure):
    import asyncio
    from contextlib import asynccontextmanager

    adapter, state, graph, settings = client
    group = graph()
    state.block = threading.Event()
    episode = adapter.graph.add(graph_id=group, type="text", data="Alice knows Bob.")
    assert state.started.wait(5)
    other = LocalGraphitiClient(settings)
    entered = threading.Event()

    @asynccontextmanager
    async def unavailable_lock(_group):
        entered.set()
        if failure == "error":
            raise RuntimeError("Synthetic waiting-client lock failure")
        await asyncio.Event().wait()
        yield

    other._engine._graph_transaction = unavailable_lock

    async def launch():
        other._engine._schedule(
            episode.uuid_, group, other._engine._ingest(episode.uuid_)
        )

    try:
        other._runner.call(launch(), 5)
        assert entered.wait(5)
        if failure == "error":
            deadline = time.monotonic() + 5
            while other._engine.tasks and time.monotonic() < deadline:
                time.sleep(0.01)
            assert not other._engine.tasks
        other.close()
        assert adapter.graph.episode.get(uuid_=episode.uuid_).status == "processing"
    finally:
        state.block.set()
        other.close()
    assert wait_episode(adapter, episode.uuid_).processed
