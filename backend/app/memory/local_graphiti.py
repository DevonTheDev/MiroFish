"""Local Graphiti/Neo4j memory with the synchronous surface used by MiroFish.

The optional Graphiti package is imported only when constructing a local client.
No cloud credentials, endpoints, telemetry, or implicit model clients are used.
"""

from __future__ import annotations

import asyncio
import base64
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
import json
import math
import threading
from types import SimpleNamespace
from urllib.parse import urlsplit

from pydantic import Field, create_model


@dataclass(frozen=True)
class LocalMemorySettings:
    graph_uri: str
    graph_user: str
    graph_password: str
    llm_base_url: str
    llm_model: str
    embedding_base_url: str
    embedding_model: str
    embedding_dimensions: int = 768
    request_timeout: float = 180.0
    max_concurrency: int = 1
    database: str = "neo4j"

    def __post_init__(self):
        from ..local_runtime.gateway import validate_loopback_url

        for name, schemes in [
            ("graph_uri", ("bolt",)),
            ("llm_base_url", ("http",)),
            ("embedding_base_url", ("http",)),
        ]:
            normalized = validate_loopback_url(getattr(self, name), schemes=schemes)
            allowed_paths = ("",) if name == "graph_uri" else ("", "/v1")
            if urlsplit(normalized).path not in allowed_paths:
                raise ValueError("Local memory endpoint has an unsupported path")
            object.__setattr__(self, name, normalized)
        for name in ("llm_model", "embedding_model", "database"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Local model and database names are required")
            if name != "database" and value.strip().lower().endswith(
                (":cloud", "-cloud")
            ):
                raise ValueError("Cloud model routes cannot be used for local memory")
            object.__setattr__(self, name, value.strip())
        if any(
            type(value) is not int or value < 1
            for value in (self.embedding_dimensions, self.max_concurrency)
        ):
            raise ValueError(
                "Local memory dimensions and concurrency must be positive integers"
            )
        if (
            isinstance(self.request_timeout, bool)
            or not isinstance(self.request_timeout, (int, float))
            or not math.isfinite(self.request_timeout)
            or self.request_timeout <= 0
        ):
            raise ValueError("Local memory timeout must be positive and finite")


def encode_cursor(graph_id: str, kind: str, last: str) -> str:
    return base64.urlsafe_b64encode(
        json.dumps([graph_id, kind, last]).encode()
    ).decode()


def decode_cursor(cursor: str | None, graph_id: str, kind: str) -> str | None:
    if cursor is None:
        return None
    try:
        graph, collection, last = json.loads(base64.urlsafe_b64decode(cursor))
        if graph != graph_id or collection != kind or not isinstance(last, str):
            raise ValueError("Cursor belongs to a different graph or collection")
        return last
    except Exception as exc:
        raise ValueError("Invalid local memory pagination cursor") from exc


def encode_ontology(entities: dict | None, edges: dict | None) -> str:
    def schema(model):
        result = model.model_json_schema()
        result["description"] = model.__doc__ or result.get("description", "")
        return result

    return json.dumps(
        {
            "entities": {
                name: schema(model) for name, model in (entities or {}).items()
            },
            "edges": {
                name: {
                    "schema": schema(model),
                    "pairs": [[pair.source, pair.target] for pair in pairs],
                }
                for name, (model, pairs) in (edges or {}).items()
            },
        }
    )


def decode_ontology(encoded: str | None):
    data = json.loads(encoded or "{}")

    def model(name, schema):
        # MiroFish's ontology generator currently emits optional textual attributes.
        fields = {
            key: (str | None, Field(None, description=value.get("description", key)))
            for key, value in schema.get("properties", {}).items()
        }
        return create_model(name, __doc__=schema.get("description", ""), **fields)

    entities = {
        name: model(name, schema) for name, schema in data.get("entities", {}).items()
    }
    edges, mapping = {}, {}
    for name, definition in data.get("edges", {}).items():
        edges[name] = model(name, definition["schema"])
        for source, target in definition["pairs"]:
            mapping.setdefault((source, target), []).append(name)
    return entities, edges, mapping


class LocalEmbeddingReranker:
    """Semantic cosine reranking using the explicitly configured local embedder.

    This intentionally avoids OpenAI-specific token IDs/logprob assumptions and
    does not download or run an additional cross-encoder model.
    """

    def __init__(self, embedder):
        self.embedder = embedder

    async def rank(self, query: str, passages: list[str]):
        if not passages:
            return []
        vectors = await self.embedder.create_batch([query, *passages])
        if len(vectors) != len(passages) + 1:
            raise ValueError("Local embedder returned an incomplete reranking batch")
        query_vector = vectors[0]

        def cosine(vector):
            if len(vector) != len(query_vector):
                raise ValueError("Local embedding dimensions do not match")
            denominator = math.sqrt(
                sum(x * x for x in vector) * sum(x * x for x in query_vector)
            )
            return (
                sum(a * b for a, b in zip(vector, query_vector)) / denominator
                if denominator
                else 0.0
            )

        return sorted(
            zip(passages, [cosine(v) for v in vectors[1:]]),
            key=lambda pair: pair[1],
            reverse=True,
        )


class _LoopRunner:
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(
            target=self.loop.run_forever, name="MiroFishLocalMemory", daemon=True
        )
        self.thread.start()
        self.closed = False
        self._state_lock = threading.RLock()

    def call(self, coroutine, timeout):
        with self._state_lock:
            if self.closed:
                coroutine.close()
                raise RuntimeError("Local memory client is closed")
            if threading.current_thread() is self.thread:
                coroutine.close()
                raise RuntimeError(
                    "Synchronous local memory calls cannot run on their worker loop"
                )
            future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        try:
            return future.result(timeout=timeout)
        except FutureTimeout as exc:
            future.cancel()
            raise TimeoutError(
                "Local memory operation timed out; do not blindly replay writes"
            ) from exc

    async def _drain(self):
        current = asyncio.current_task()
        pending = [
            task
            for task in asyncio.all_tasks()
            if task is not current and not task.done()
        ]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self.loop.shutdown_asyncgens()

    def close(self):
        with self._state_lock:
            if self.closed:
                return
            self.closed = True
            # Keep the loop alive until cancellation finally blocks have run.
            asyncio.run_coroutine_threadsafe(self._drain(), self.loop).result(
                timeout=10
            )
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join(10)
            if self.thread.is_alive():
                raise RuntimeError("Local memory worker did not stop")
            self.loop.close()


class LocalGraphitiClient:
    """Synchronous application boundary; ingestion runs on one managed local loop."""

    def __init__(self, settings: LocalMemorySettings):
        self.settings = settings
        from .graphiti_engine import GraphitiMemoryEngine

        self._engine = GraphitiMemoryEngine(settings)
        self._closed = False
        self._state_lock = threading.RLock()
        self._runner = _LoopRunner()
        try:
            self._call("initialize")
        except BaseException as error:
            self._closed = True
            try:
                self._close_owned_resources()
            except BaseException as cleanup_error:
                error.add_note(f"Local memory initialization cleanup failed: {cleanup_error!r}")
                for note in getattr(cleanup_error, "__notes__", ()):
                    error.add_note(note)
            raise
        self.graph = _GraphAPI(self)
        self.batch = _BatchAPI(self)

    def _call(self, method, *args, **kwargs):
        with self._state_lock:
            if self._closed:
                raise RuntimeError("Local memory client is closed")
            return self._runner.call(
                getattr(self._engine, method)(*args, **kwargs),
                self.settings.request_timeout,
            )

    def close(self):
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            self._close_owned_resources()

    def _close_owned_resources(self):
        failure = None
        try:
            self._runner.call(self._engine.close(), self.settings.request_timeout)
        except BaseException as exc:
            failure = exc
        try:
            self._runner.close()
        except BaseException as exc:
            if failure is None:
                failure = exc
            else:
                failure.add_note(f"Additional local memory loop shutdown failure: {exc!r}")
        if failure is not None:
            raise failure

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class _GraphAPI:
    def __init__(self, client):
        self.client = client
        self.node = _CollectionAPI(client, "nodes")
        self.edge = _CollectionAPI(client, "edges")
        self.episode = SimpleNamespace(
            get=lambda uuid_: client._call("get_episode", uuid_)
        )

    def create(self, *, graph_id, name, description=""):
        return self.client._call("create_graph", graph_id, name, description)

    def get(self, graph_id):
        return self.client._call("get_graph", graph_id)

    def delete(self, graph_id):
        return self.client._call("delete_graph", graph_id)

    def set_ontology(self, *, graph_ids, entities, edges=None):
        return self.client._call("set_ontology", graph_ids, entities, edges)

    def add(
        self,
        *,
        graph_id,
        type,
        data,
        created_at=None,
        source_description="",
        metadata=None,
    ):
        if type != "text":
            raise ValueError("Local memory currently accepts text episodes only")
        return self.client._call(
            "add_episode",
            graph_id,
            data,
            created_at,
            source_description,
            metadata or {},
        )

    def search(self, *, graph_id, query, limit=10, scope="edges", reranker="rrf"):
        return self.client._call("search", graph_id, query, limit, scope, reranker)


class _CollectionAPI:
    def __init__(self, client, kind, raw=False):
        self.client, self.kind, self.raw = client, kind, raw
        if not raw:
            self.with_raw_response = _CollectionAPI(client, kind, True)

    def get_by_graph_id(self, graph_id, *, limit=100, cursor=None):
        result = self.client._call("page", graph_id, self.kind, limit, cursor)
        return result if self.raw else result.data

    def get(self, *, uuid_):
        return self.client._call("get_node", uuid_)

    def get_edges(self, *, node_uuid):
        return self.client._call("get_node_edges", node_uuid)


class _BatchAPI:
    def __init__(self, client):
        self.client = client

    def create(self, *, metadata):
        return self.client._call("create_batch", metadata)

    def add(self, *, batch_id, items):
        return self.client._call("add_batch_items", batch_id, items)

    def process(self, batch_id):
        return self.client._call("process_batch", batch_id)

    def get(self, batch_id):
        return self.client._call("get_batch", batch_id)

    def list(self, *, limit=100, cursor=None):
        return self.client._call("list_batches", limit, cursor)

    def list_items(self, batch_id, *, limit=100, cursor=None):
        return self.client._call("list_batch_items", batch_id, limit, cursor)
