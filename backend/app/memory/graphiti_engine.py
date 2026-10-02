"""Async Graphiti implementation and durable Neo4j ingestion journal."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
import re
from types import SimpleNamespace as Result
import uuid

from zep_cloud import NotFoundError
from zep_cloud.types.api_error import ApiError

from .local_graphiti import (
    LocalEmbeddingReranker,
    decode_cursor,
    encode_cursor,
    decode_ontology,
    encode_ontology,
)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _missing(kind, identifier):
    return NotFoundError(body=ApiError(message=f"Local {kind} not found: {identifier}"))


def _dto(value):
    data = value.model_dump()
    data["uuid_"] = data["uuid"]
    data.setdefault("attributes", {})
    if "fact" in data:
        data["fact_type"] = data.get("name", "")
        data["episode_ids"] = data.get("episodes", [])
    return Result(**data)


class GraphitiMemoryEngine:
    def __init__(self, settings):
        self.settings = settings
        self.owner = str(uuid.uuid4())
        self.driver = self.graphiti = None
        self.http_clients = []
        self.tasks = {}
        self.graph_locks = {}
        self.closed = False

    async def initialize(self):
        # Must precede Graphiti construction; it otherwise enables PostHog telemetry.
        os.environ["GRAPHITI_TELEMETRY_ENABLED"] = "false"
        try:
            import httpx
            from openai import AsyncOpenAI
            from neo4j import AsyncGraphDatabase
            from graphiti_core import Graphiti
            from graphiti_core.driver.neo4j_driver import Neo4jDriver
            from graphiti_core.llm_client.config import LLMConfig
            from graphiti_core.llm_client.openai_generic_client import (
                OpenAIGenericClient,
            )
            from graphiti_core.embedder.openai import (
                OpenAIEmbedder,
                OpenAIEmbedderConfig,
            )
            from graphiti_core.cross_encoder.client import CrossEncoderClient
        except ImportError as exc:
            raise RuntimeError(
                "Local memory dependencies are missing; run uv sync --extra local --locked in backend"
            ) from exc
        self.work_limit = asyncio.Semaphore(self.settings.max_concurrency)

        def http_client(base_url):
            transport = httpx.AsyncClient(
                timeout=self.settings.request_timeout,
                trust_env=False,
                follow_redirects=False,
            )
            client = AsyncOpenAI(
                api_key="local",
                base_url=base_url,
                timeout=self.settings.request_timeout,
                max_retries=0,
                http_client=transport,
            )
            self.http_clients.append(client)
            return client

        llm = OpenAIGenericClient(
            config=LLMConfig(
                api_key="local",
                base_url=self.settings.llm_base_url,
                model=self.settings.llm_model,
                small_model=self.settings.llm_model,
                temperature=0,
                max_tokens=2048,
            ),
            client=http_client(self.settings.llm_base_url),
            max_tokens=2048,
        )
        embedder = OpenAIEmbedder(
            config=OpenAIEmbedderConfig(
                api_key="local",
                base_url=self.settings.embedding_base_url,
                embedding_model=self.settings.embedding_model,
                embedding_dim=self.settings.embedding_dimensions,
            ),
            client=http_client(self.settings.embedding_base_url),
        )
        self.driver = Neo4jDriver(
            self.settings.graph_uri,
            self.settings.graph_user,
            self.settings.graph_password,
            database=self.settings.database,
        )
        if not self.settings.graph_password:
            # Graphiti's driver always constructs a basic-auth tuple. Replace its
            # still-unused connection before its scheduled index task can run.
            original = self.driver.client
            self.driver.client = AsyncGraphDatabase.driver(
                self.settings.graph_uri, auth=None
            )
            await original.close()

        class GraphitiLocalReranker(LocalEmbeddingReranker, CrossEncoderClient):
            pass

        self.graphiti = Graphiti(
            graph_driver=self.driver,
            llm_client=llm,
            embedder=embedder,
            cross_encoder=GraphitiLocalReranker(embedder),
            max_coroutines=self.settings.max_concurrency,
        )
        if self.driver._init_task is not None:
            await self.driver._init_task
        else:
            await self.graphiti.build_indices_and_constraints()
        for label, key in [
            ("MiroMemoryGraph", "graph_id"),
            ("MiroMemoryBatch", "identity"),
            ("MiroMemoryJob", "uuid"),
            ("MiroMemoryClaim", "identity"),
            ("MiroMemoryLock", "graph_id"),
        ]:
            await self._query(
                f"CREATE CONSTRAINT IF NOT EXISTS FOR (n:{label}) REQUIRE n.{key} IS UNIQUE"
            )

    async def _query(self, query, **params):
        records, _, _ = await self.driver.execute_query(query, params=params)
        return [dict(record) for record in records]

    def _lock(self, graph_id):
        return self.graph_locks.setdefault(graph_id, asyncio.Lock())

    @asynccontextmanager
    async def _graph_transaction(self, graph_id):
        # Hold a database write lock for the entire ingestion, including model
        # calls. A second process cannot extract against stale graph state or
        # delete this group halfway through Graphiti's multi-transaction writes.
        # Neo4j releases the lock if this process/connection goes away.
        async with self.driver.transaction() as transaction:
            locked = await transaction.run(
                "MERGE (m:MiroMemoryLock {graph_id:$id}) "
                "SET m.group_id=$id,m.last_owner=$owner RETURN m.graph_id",
                id=graph_id,
                owner=self.owner,
            )
            await locked.consume()
            existing = await transaction.run(
                "MATCH (g:MiroMemoryGraph {graph_id:$id}) RETURN g.graph_id AS id",
                id=graph_id,
            )
            if await existing.single() is None:
                raise _missing("graph", graph_id)
            yield transaction

    async def create_graph(self, graph_id, name, description):
        if not isinstance(graph_id, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{1,128}", graph_id
        ):
            raise ValueError(
                "Local graph IDs must contain 1-128 letters, digits, underscores or hyphens"
            )
        await self._query(
            "MERGE (g:MiroMemoryGraph {graph_id:$id}) ON CREATE SET g.group_id=$id, g.name=$name, g.description=$description, g.created_at=$now",
            id=graph_id,
            name=name,
            description=description,
            now=_now(),
        )
        return await self.get_graph(graph_id)

    async def get_graph(self, graph_id):
        rows = await self._query(
            "MATCH (g:MiroMemoryGraph {graph_id:$id}) RETURN properties(g) AS data",
            id=graph_id,
        )
        if not rows:
            raise _missing("graph", graph_id)
        data = rows[0]["data"]
        data["ontology"] = json.loads(data.get("ontology") or "{}")
        return Result(**data)

    async def set_ontology(self, graph_ids, entities, edges):
        encoded = encode_ontology(entities, edges)
        for graph_id in graph_ids:
            await self.get_graph(graph_id)
        for graph_id in graph_ids:
            async with self._graph_transaction(graph_id):
                await self._query(
                    "MATCH (g:MiroMemoryGraph {graph_id:$id}) SET g.ontology=$ontology",
                    id=graph_id,
                    ontology=encoded,
                )

    async def delete_graph(self, graph_id):
        await self.get_graph(graph_id)
        pending = [
            task
            for task, group, _kind in self.tasks.values()
            if group == graph_id and not task.done()
        ]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        async with (
            self._lock(graph_id),
            self._graph_transaction(graph_id) as transaction,
        ):
            result = await transaction.run(
                "MATCH (n {group_id:$id}) DETACH DELETE n", id=graph_id
            )
            await result.consume()
        return Result(graph_id=graph_id, deleted=True)

    async def page(self, graph_id, kind, limit, cursor):
        from graphiti_core.nodes import EntityNode
        from graphiti_core.edges import EntityEdge

        await self.get_graph(graph_id)
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Local memory page limit must be between 1 and 100")
        last = decode_cursor(cursor, graph_id, kind)
        model = EntityNode if kind == "nodes" else EntityEdge
        values = await model.get_by_group_ids(
            self.driver, [graph_id], limit=limit + 1, uuid_cursor=last
        )
        page = values[:limit]
        headers = {}
        if len(values) > limit:
            headers["zep-next-cursor"] = encode_cursor(graph_id, kind, page[-1].uuid)
        return Result(data=[_dto(value) for value in page], headers=headers)

    async def get_node(self, identifier):
        from graphiti_core.nodes import EntityNode
        from graphiti_core.errors import NodeNotFoundError

        try:
            node = await EntityNode.get_by_uuid(self.driver, identifier)
        except NodeNotFoundError as exc:
            raise _missing("node", identifier) from exc
        await self.get_graph(node.group_id)
        return _dto(node)

    async def get_node_edges(self, identifier):
        from graphiti_core.edges import EntityEdge

        node = await self.get_node(identifier)
        values = await EntityEdge.get_by_node_uuid(self.driver, identifier)
        return [_dto(value) for value in values if value.group_id == node.group_id]

    async def search(self, graph_id, query, limit, scope, reranker):
        from graphiti_core.search.search_config import (
            SearchConfig,
            EdgeSearchConfig,
            EdgeSearchMethod,
            EdgeReranker,
            NodeSearchConfig,
            NodeSearchMethod,
            NodeReranker,
        )

        await self.get_graph(graph_id)
        if scope not in {"nodes", "edges", "both"} or reranker not in {
            "rrf",
            "cross_encoder",
        }:
            raise ValueError("Unsupported local graph search scope or reranker")
        if not isinstance(query, str) or not query.strip() or not 1 <= limit <= 100:
            raise ValueError(
                "A nonempty query and limit between 1 and 100 are required"
            )
        edge_rank = (
            EdgeReranker.rrf if reranker == "rrf" else EdgeReranker.cross_encoder
        )
        node_rank = (
            NodeReranker.rrf if reranker == "rrf" else NodeReranker.cross_encoder
        )
        config = SearchConfig(
            limit=limit,
            edge_config=EdgeSearchConfig(
                search_methods=[
                    EdgeSearchMethod.bm25,
                    EdgeSearchMethod.cosine_similarity,
                ],
                reranker=edge_rank,
            )
            if scope in {"edges", "both"}
            else None,
            node_config=NodeSearchConfig(
                search_methods=[
                    NodeSearchMethod.bm25,
                    NodeSearchMethod.cosine_similarity,
                ],
                reranker=node_rank,
            )
            if scope in {"nodes", "both"}
            else None,
        )
        async with self.work_limit:
            result = await self.graphiti.search_(
                query, config=config, group_ids=[graph_id], driver=self.driver
            )
        return Result(
            nodes=[_dto(v) for v in result.nodes if v.group_id == graph_id],
            edges=[_dto(v) for v in result.edges if v.group_id == graph_id],
        )

    async def _job(self, identifier):
        rows = await self._query(
            "MATCH (j:MiroMemoryJob {uuid:$id}) RETURN properties(j) AS data",
            id=identifier,
        )
        if not rows:
            raise _missing("episode", identifier)
        return rows[0]["data"]

    async def _reserve_job(
        self,
        graph_id,
        data,
        created_at,
        source,
        metadata,
        identifier,
        batch_id=None,
        sequence_index=0,
    ):
        await self.get_graph(graph_id)
        if not isinstance(data, str) or not data.strip():
            raise ValueError("Local memory episodes require nonempty text")
        timestamp = (
            datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            if created_at
            else datetime.now(timezone.utc)
        )
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        body_hash = hashlib.sha256(data.encode()).hexdigest()
        rows = await self._query(
            """MATCH (g:MiroMemoryGraph {graph_id:$graph})
            MERGE (j:MiroMemoryJob {uuid:$id}) ON CREATE SET j.group_id=$graph, j.data=$data,
            j.body_hash=$hash, j.reference_time=$reference, j.source_description=$source,
            j.metadata=$metadata, j.status='queued', j.submitted_owner=$owner, j.batch_id=$batch, j.sequence_index=$sequence, j.created_at=$now
            RETURN properties(j) AS data""",
            graph=graph_id,
            id=identifier,
            data=data,
            hash=body_hash,
            reference=timestamp.isoformat(),
            source=source,
            metadata=_json(metadata),
            batch=batch_id,
            sequence=sequence_index,
            owner=self.owner,
            now=_now(),
        )
        if not rows:
            raise _missing("graph", graph_id)
        job = rows[0]["data"]
        if (
            job["group_id"] != graph_id
            or job["body_hash"] != body_hash
            or job.get("metadata") != _json(metadata)
        ):
            raise ValueError(
                "An existing local ingestion identity has different content"
            )
        return job

    def _schedule(self, key, graph_id, coroutine, kind="episode"):
        current = self.tasks.get(key)
        if current and not current[0].done():
            coroutine.close()
            return
        task = asyncio.create_task(coroutine)
        self.tasks[key] = (task, graph_id, kind)

        def finished(done):
            self.tasks.pop(key, None)
            # All job failures are journaled below; retrieve any final exception.
            if not done.cancelled():
                done.exception()

        task.add_done_callback(finished)

    async def add_episode(self, graph_id, data, created_at, source, metadata):
        async with self._graph_transaction(graph_id):
            return await self._admit_episode(
                graph_id, data, created_at, source, metadata
            )

    async def _admit_episode(self, graph_id, data, created_at, source, metadata):
        # A caller-supplied source timestamp permits safe exact-payload replay.
        identity = (
            _json([graph_id, data, created_at, source, metadata])
            if created_at
            else str(uuid.uuid4())
        )
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
        job = await self._reserve_job(
            graph_id, data, created_at, source, metadata, identifier
        )
        if job["status"] == "queued":
            self._schedule(identifier, graph_id, self._ingest(identifier))
        return Result(
            uuid_=identifier, uuid=identifier, processed=job["status"] == "succeeded"
        )

    async def _ingest(self, identifier):
        try:
            job = await self._job(identifier)
            graph_id = job["group_id"]
            from graphiti_core.nodes import EpisodicNode, EpisodeType

            async with (
                self.work_limit,
                self._lock(graph_id),
                self._graph_transaction(graph_id),
            ):
                job = await self._job(identifier)
                if job["status"] != "queued":
                    return
                claim = await self._query(
                    "MERGE (c:MiroMemoryClaim {identity:$id}) ON CREATE SET c.owner=$owner, c.group_id=$graph RETURN c.owner AS owner",
                    id="job:" + identifier,
                    owner=self.owner,
                    graph=graph_id,
                )
                if claim[0]["owner"] != self.owner:
                    return
                await self._query(
                    "MATCH (j:MiroMemoryJob {uuid:$id}) SET j.status='processing',j.owner=$owner",
                    id=identifier,
                    owner=self.owner,
                )
                graph = await self.get_graph(graph_id)
                entities, edges, mapping = decode_ontology(_json(graph.ontology))
                previous = await self._query(
                    "MATCH (j:MiroMemoryJob {group_id:$graph,status:'succeeded'}) RETURN j.uuid AS uuid ORDER BY j.reference_time DESC LIMIT 5",
                    graph=graph_id,
                )
                episode = EpisodicNode(
                    uuid=identifier,
                    name=job["source_description"] or "MiroFish episode",
                    group_id=graph_id,
                    source=EpisodeType.text,
                    source_description=job["source_description"],
                    content=job["data"],
                    valid_at=datetime.fromisoformat(job["reference_time"]),
                    episode_metadata=json.loads(job["metadata"]),
                )
                await episode.save(self.driver)
                await self.graphiti.add_episode(
                    name=episode.name,
                    episode_body=episode.content,
                    source_description=episode.source_description,
                    reference_time=episode.valid_at,
                    source=EpisodeType.text,
                    group_id=graph_id,
                    uuid=identifier,
                    previous_episode_uuids=[row["uuid"] for row in reversed(previous)],
                    entity_types=entities or None,
                    edge_types=edges or None,
                    edge_type_map=mapping or None,
                )
                await self._query(
                    "MATCH (j:MiroMemoryJob {uuid:$id}) SET j.status='succeeded', j.completed_at=$now",
                    id=identifier,
                    now=_now(),
                )
        except asyncio.CancelledError:
            await self._cancel_episode(identifier)
            raise
        except Exception as exc:
            await self._query(
                "MATCH (j:MiroMemoryJob {uuid:$id}) "
                "WHERE (j.status='queued' AND j.submitted_owner=$owner) "
                "OR (j.status='processing' AND j.owner=$owner) "
                "SET j.status='failed',j.error=$error",
                id=identifier,
                owner=self.owner,
                error=str(exc)[:1000],
            )

    async def _cancel_episode(self, identifier):
        # Do not overwrite a successful job or another client's active claim.
        await self._query(
            "MATCH (j:MiroMemoryJob {uuid:$id}) "
            "WHERE (j.status='queued' AND j.submitted_owner=$owner) "
            "OR (j.status='processing' AND j.owner=$owner) "
            "SET j.status='canceled',j.error='Local ingestion was canceled'",
            id=identifier,
            owner=self.owner,
        )

    async def get_episode(self, identifier):
        job = await self._job(identifier)
        if job["status"] in {"failed", "canceled"}:
            raise RuntimeError(
                f"Local episode {identifier} {job['status']}: {job.get('error', '')}"
            )
        return Result(
            uuid_=identifier,
            uuid=identifier,
            graph_id=job["group_id"],
            processed=job["status"] == "succeeded",
            status=job["status"],
            data=job["data"],
            metadata=json.loads(job["metadata"]),
        )

    async def create_batch(self, metadata):
        async with self._graph_transaction(metadata.get("graph_id")):
            return await self._create_batch(metadata)

    async def _create_batch(self, metadata):
        graph_id = metadata.get("graph_id")
        await self.get_graph(graph_id)
        operation = metadata.get("mirofish_operation_id") or str(uuid.uuid4())
        identity = hashlib.sha256(_json([graph_id, operation]).encode()).hexdigest()
        identifier = str(uuid.uuid4())
        rows = await self._query(
            "MERGE (b:MiroMemoryBatch {identity:$identity}) ON CREATE SET b.batch_id=$id,b.group_id=$graph,b.metadata=$metadata,b.status='draft',b.created_at=$now RETURN b.batch_id AS id",
            identity=identity,
            id=identifier,
            graph=graph_id,
            metadata=_json(metadata),
            now=_now(),
        )
        return await self.get_batch(rows[0]["id"])

    async def get_batch(self, identifier):
        rows = await self._query(
            "MATCH (b:MiroMemoryBatch {batch_id:$id}) RETURN properties(b) AS data",
            id=identifier,
        )
        if not rows:
            raise _missing("batch", identifier)
        data = rows[0]["data"]
        counts = await self._query(
            "MATCH (j:MiroMemoryJob {batch_id:$id}) RETURN j.status AS status,count(j) AS count",
            id=identifier,
        )
        totals = {row["status"]: row["count"] for row in counts}
        total = sum(totals.values())
        complete = totals.get("succeeded", 0)
        data["metadata"] = json.loads(data["metadata"])
        data["progress"] = Result(
            total_items=total,
            succeeded_items=complete,
            failed_items=totals.get("failed", 0),
            percent_complete=complete / total * 100 if total else 0,
        )
        return Result(**data)

    async def add_batch_items(self, identifier, items):
        batch = await self.get_batch(identifier)
        async with self._graph_transaction(batch.group_id):
            return await self._add_batch_items(identifier, items)

    async def _add_batch_items(self, identifier, items):
        batch = await self.get_batch(identifier)
        if batch.status != "draft":
            raise ValueError("Items can only be added to a draft local batch")
        current = await self._query(
            "MATCH (j:MiroMemoryJob {batch_id:$id}) RETURN count(j) AS count",
            id=identifier,
        )
        count = current[0]["count"]
        result = []
        for offset, item in enumerate(items):
            if (
                item.type != "graph_episode"
                or item.data_type != "text"
                or item.graph_id != batch.group_id
            ):
                raise ValueError(
                    "Local batch items must be text episodes belonging to the batch graph"
                )
            metadata = item.metadata or {}
            index = metadata.get("chunk_index", count + offset)
            if not isinstance(index, int) or index < 0:
                raise ValueError("Invalid local batch sequence index")
            job_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{identifier}:{index}"))
            job = await self._reserve_job(
                item.graph_id,
                item.data,
                None,
                item.source_description or "",
                metadata,
                job_id,
                identifier,
                index,
            )
            result.append(self._item(job))
        return result

    @staticmethod
    def _item(job):
        return Result(
            sequence_index=job["sequence_index"],
            episode_uuid=job["uuid"],
            source_uuid=job["uuid"],
            status=job["status"],
            error=job.get("error"),
            metadata=json.loads(job["metadata"]),
        )

    async def list_batch_items(self, identifier, limit, cursor):
        await self.get_batch(identifier)
        if (
            not isinstance(limit, int)
            or not 1 <= limit <= 100
            or (cursor is not None and (not isinstance(cursor, int) or cursor < 0))
        ):
            raise ValueError("Invalid batch pagination")
        offset = cursor or 0
        rows = await self._query(
            "MATCH (j:MiroMemoryJob {batch_id:$id}) RETURN properties(j) AS data ORDER BY j.sequence_index SKIP $offset LIMIT $limit",
            id=identifier,
            offset=offset,
            limit=limit + 1,
        )
        return Result(
            items=[self._item(row["data"]) for row in rows[:limit]],
            next_cursor=offset + limit if len(rows) > limit else None,
        )

    async def list_batches(self, limit, cursor):
        if (
            not isinstance(limit, int)
            or not 1 <= limit <= 100
            or (cursor is not None and (not isinstance(cursor, int) or cursor < 0))
        ):
            raise ValueError("Invalid batch pagination")
        offset = cursor or 0
        rows = await self._query(
            "MATCH (b:MiroMemoryBatch) RETURN b.batch_id AS id ORDER BY b.created_at,b.batch_id SKIP $offset LIMIT $limit",
            offset=offset,
            limit=limit + 1,
        )
        batches = [await self.get_batch(row["id"]) for row in rows[:limit]]
        return Result(
            batches=batches, next_cursor=offset + limit if len(rows) > limit else None
        )

    async def process_batch(self, identifier):
        batch = await self.get_batch(identifier)
        async with self._graph_transaction(batch.group_id):
            return await self._start_batch(identifier)

    async def _start_batch(self, identifier):
        batch = await self.get_batch(identifier)
        if batch.status != "draft":
            return batch
        if not batch.progress.total_items:
            raise ValueError("Cannot process an empty local batch")
        claim = await self._query(
            "MERGE (c:MiroMemoryClaim {identity:$identity}) ON CREATE SET c.owner=$owner,c.group_id=$graph RETURN c.owner AS owner",
            identity="batch:" + identifier,
            owner=self.owner,
            graph=batch.group_id,
        )
        if claim[0]["owner"] == self.owner:
            await self._query(
                "MATCH (b:MiroMemoryBatch {batch_id:$id}) SET b.status='processing',b.owner=$owner",
                id=identifier,
                owner=self.owner,
            )
            self._schedule(
                identifier,
                batch.group_id,
                self._process_batch(identifier),
                kind="batch",
            )
        return await self.get_batch(identifier)

    async def _process_batch(self, identifier):
        try:
            rows = await self._query(
                "MATCH (j:MiroMemoryJob {batch_id:$id}) RETURN j.uuid AS id ORDER BY j.sequence_index",
                id=identifier,
            )
            for row in rows:
                await self._ingest(row["id"])
            batch = await self.get_batch(identifier)
            status = (
                "succeeded"
                if batch.progress.succeeded_items == batch.progress.total_items
                else "failed"
            )
            await self._query(
                "MATCH (b:MiroMemoryBatch {batch_id:$id}) SET b.status=$status",
                id=identifier,
                status=status,
            )
        except asyncio.CancelledError:
            await self._query(
                "MATCH (b:MiroMemoryBatch {batch_id:$id}) SET b.status='canceled'",
                id=identifier,
            )
            raise
        except Exception as exc:
            await self._query(
                "MATCH (b:MiroMemoryBatch {batch_id:$id}) SET b.status='failed',b.error=$error",
                id=identifier,
                error=str(exc)[:1000],
            )

    async def close(self):
        if self.closed:
            return
        self.closed = True
        pending = [
            (key, task, kind)
            for key, (task, _group, kind) in self.tasks.items()
            if not task.done()
        ]
        for _key, task, _kind in pending:
            task.cancel()
        if pending:
            await asyncio.gather(
                *(task for _key, task, _kind in pending), return_exceptions=True
            )
        # A task canceled before its first execution cannot run its finally block.
        # Journal all admitted work explicitly, without touching other owners.
        for key, _task, kind in pending:
            if kind == "episode":
                await self._cancel_episode(key)
            else:
                await self._query(
                    "MATCH (b:MiroMemoryBatch {batch_id:$id,owner:$owner}) "
                    "WHERE b.status='processing' SET b.status='canceled'",
                    id=key,
                    owner=self.owner,
                )
                await self._query(
                    "MATCH (b:MiroMemoryBatch {batch_id:$id,owner:$owner}), (j:MiroMemoryJob {batch_id:$id}) "
                    "WHERE j.status='queued' OR (j.status='processing' AND j.owner=$owner) "
                    "SET j.status='canceled',j.error='Local batch processing was canceled'",
                    id=key,
                    owner=self.owner,
                )
        if self.graphiti is not None:
            await self.graphiti.close()
        elif self.driver is not None:
            await self.driver.close()
        for client in self.http_clients:
            await client.close()
