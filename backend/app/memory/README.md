# Local memory compatibility boundary

`LocalGraphitiClient` implements the synchronous graph and batch methods used by
MiroFish while running Graphiti 0.30.2 asynchronously against one Neo4j database.
Cloud mode does not import or initialize Graphiti. Construct a client only with
explicit `LocalMemorySettings`; the application factory supplies the shared local
inference gateway as both model base URLs.

## Behavior

- Each graph ID is a Graphiti `group_id`. Metadata, ontology, jobs, batch identities,
  entities, facts, episode provenance, searches and opaque cursors retain that ID.
  Deletion removes only the selected group. Node lookups retain their actual group.
- MiroFish's optional text ontology attributes are reconstructed as Pydantic models,
  including entity labels, descriptions and directional edge-type mappings.
- The LLM and embedder use explicit local OpenAI-compatible HTTP clients, with
  environment proxies, redirects, SDK retries and inherited API keys disabled.
  `cross_encoder` search requests use cosine reranking through the same local
  embedder; no extra model is downloaded. Graphiti telemetry is disabled.
- Direct `bolt://` loopback connections avoid cluster-routing to another host.
  An empty graph password selects no authentication, for the loopback-only local
  database setup. Inference URLs are canonicalized literal loopback addresses.
- Ingestion is bounded by configured concurrency. A Neo4j-held group lock serializes
  extraction and deletion across clients/processes, including Graphiti's multiple
  transactions. It is released automatically on connection loss.
- Batch operation IDs and chunk indexes have durable identities. Exact replays
  reuse them; conflicting content is rejected. Successful episodes are marked
  processed only after Graphiti finishes. Model failures are visible, not empty
  successful graphs. There is no automatic retry of partially completed writes.
- `close()` waits for in-flight synchronous API calls, cancels pending ingestion,
  drains cancellation cleanup, closes drivers/HTTP clients, and stops its loop.
  The application registers this method for normal process shutdown.

## Failure and recovery limits

Graphiti's extraction is **not one atomic database transaction**. A model error or
cancellation may leave partial episode/entity data in the selected graph; the job
journal still reports failure/cancellation. After an abrupt process kill, queued or
processing jobs can remain nonterminal. Their durable IDs permit diagnosis, but
this version does not guess that an interrupted write is safe to replay or resume.
The application reports its ingestion deadline; rebuilding a failed project graph
is the explicit recovery path. Read operations never initiate a replay.

The adapter is the subset needed by the current application, not a general Zep SDK
replacement. Cloud-only features in the separate Zep integration-validation script
(such as episode search and cloud filters) are outside this interface.

An explicit client close attempts every owned cancellation-journal update and
graph/HTTP resource close even when an earlier step fails. The first failure is
still raised after cleanup attempts, with later failures attached as exception
notes. Initialization failures retain their original cause if teardown also fails;
worker-loop shutdown is still attempted. Close remains terminal and idempotent, and does
not replay failed writes. A journal failure can leave job status uncertain; hard
deadlines, unresponsive cleanup and process termination can still interrupt cleanup.
Normal application exit drains simulation producers/updaters before closing local
memory, then closes the gateway owned by this process. Lazy client construction
does not change that order; an inherited parent gateway is never closed here.

## Verification

Fast tests do not require a graph database or downloaded models:

```sh
PYTHONPATH=backend python backend/scripts/run_offline_tests.py -q \
  backend/tests/test_local_memory_contract.py backend/tests/test_local_memory_shutdown.py
```

For the integration tests, install the local dependency extra (`uv sync --extra local --locked` in `backend`), start a
**disposable, unauthenticated, loopback-only Neo4j 5.26+ database**, and run:

```sh
MIRO_TEST_NEO4J_URI=bolt://127.0.0.1:7687 PYTHONPATH=backend \
  python backend/scripts/run_offline_tests.py -q \
  backend/tests/test_local_memory_integration.py backend/tests/test_local_memory_shutdown.py
```

These tests use actual Graphiti/Neo4j, the actual bounded inference gateway, and a
synthetic local OpenAI model server. They only create/delete uniquely named test
groups. They cover extraction, typed ontology, provenance, isolated search,
pagination, real application consumers, durable batches, concurrent replay,
cross-client deletion, failure reporting and shutdown. They do not measure the
quality, memory usage or latency of real downloaded model weights.
Shutdown failure tests also check actual driver/HTTP closed state after an injected
journal error; synthetic-resource cases cover partial initialization and secondary
cleanup errors. The one real-driver case is skipped without the disposable Neo4j.
