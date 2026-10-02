# Run MiroFish locally without paid APIs

Local mode retains the existing interface, OASIS simulations and reports, while
using your own OpenAI-compatible model server and Graphiti with Neo4j Community.
No OpenAI or Zep account/key is required. Cloud mode remains the default when
`MEMORY_BACKEND` is unset or `zep`.

This is a single-user local setup. It has no API subscription fees, but uses your
PC's RAM, disk, compute and electricity. Small-model accuracy is not equivalent
to a large hosted model. Generated simulations are exploratory, not validated
forecasts or a basis for consequential decisions.

## 1. Install the tools

- Python 3.11, [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Node 20.19+ (20.x) or 22.12+; Node 24 LTS is a straightforward choice
- [Ollama](https://ollama.com/download), or your own compatible local server
- Neo4j Community 5.26, either [native](https://neo4j.com/deployment-center/) or
  through Docker/Podman Compose. The supplied Compose file is memory-only;
  the app and model server run natively so GPU setup is independent of Docker.

On Windows, these commands work in PowerShell once those tools are installed.
No installer or application startup automatically downloads model weights.

## 2. Start a strictly local model server

Set these variables **in the Ollama server's environment**, then restart it:

```sh
# macOS/Linux: stop any existing Ollama app/service before starting this instance
OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 ollama serve
```

PowerShell, in a dedicated terminal after quitting any existing Ollama instance:

```powershell
$env:OLLAMA_NO_CLOUD="1"
$env:OLLAMA_NUM_PARALLEL="1"
$env:OLLAMA_MAX_LOADED_MODELS="1"
ollama serve
```

Putting these variables in MiroFish's `.env` does **not** reconfigure an already
running Ollama service. Ollama must itself have cloud disabled. A loopback URL
alone cannot prove that an arbitrary model server does not forward data elsewhere.
Use a server you control; keep it bound to loopback. See [Ollama local-only mode
and memory controls](https://docs.ollama.com/faq).

In another terminal, deliberately download the selected open-weight models and
create a bounded-context alias:

```sh
ollama pull qwen3.5:4b
ollama pull nomic-embed-text
ollama create mirofish-local -f local/Modelfile
```

The 4B quantized model is approximately 3.4 GB to download; runtime memory is
larger and depends on context, offloading and server version. The embedding model
is approximately 274 MB. These are starting choices, not a promise of speed or
fit on every PC. Both models have Apache-2.0 licenses. Sources:
[Qwen3.5](https://ollama.com/library/qwen3.5),
[Qwen license](https://huggingface.co/Qwen/Qwen3.5-4B),
[Nomic](https://ollama.com/library/nomic-embed-text),
[Nomic license and embedding guidance](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5).

## 3. Start the graph database

From the repository root:

```sh
docker compose -f compose.local.yml up -d
```

It publishes only `127.0.0.1:7474` and `127.0.0.1:7687`, uses a persistent named
volume, and budgets 512 MB maximum heap plus 256 MB page cache. Authentication is
disabled for this **loopback-only, single-user development** database. Never
publish those ports to a LAN or the internet. On shared machines, use an
existing authenticated local Neo4j installation instead and set
`LOCAL_GRAPH_USER`/`LOCAL_GRAPH_PASSWORD` in your untracked `.env`.

Native Neo4j works too: use a dedicated database, keep Bolt on loopback, and
point `LOCAL_GRAPH_URI` at it. Only direct `bolt://` is accepted by app config,
so routing discovery cannot redirect the driver to a remote cluster.

Stopping Compose preserves graph data. Do not use `down -v` unless you intend
to erase that volume. Cloud graphs are not imported into local memory.

## 4. Configure, install and check

```sh
cp .env.local.example .env
npm run setup:local
npm run check:local
npm run dev:local
```

On PowerShell use `Copy-Item .env.local.example .env` in place of `cp`.
If `.env` already contains configuration you need, back it up first. Open
`http://127.0.0.1:3000`. The backend binds to `127.0.0.1:5001` in local mode.

`check:local` checks Neo4j and the model server, then sends only small synthetic
JSON, JSON-schema, tool-call and embedding probes. It checks the actual embedding
dimension. It does not create a graph or download anything, and exits nonzero
when a required capability fails. It is a contract check, not a quality benchmark.

Malformed local numeric limits are reported by setting name before services are
contacted, rather than failing at import with a traceback. Invalid values are
not silently replaced by defaults. Fix every reported local setting and rerun
`npm run check:local`; unused local-only numbers do not block cloud mode.

Use **uv** for the local dependency environment. OASIS 0.2.5 pins Neo4j's Python
driver to 5.23.0, while Graphiti 0.30.2 needs at least 5.26. OASIS and its unstructured dependency also declare Python below 3.12, so this
project pins Python 3.11 even though earlier versions advertised 3.12. The lockfile explicitly
overrides the stale Neo4j transitive pin to 5.28.3. The real pinned OASIS and Graphiti
paths are tested together with this driver. Ordinary `pip install .[local]`
cannot resolve the original contradictory metadata. Do not resolve it by
installing packages in arbitrary order or ignoring all dependencies.

The `local` extra selects CPU-only PyTorch for OASIS on Linux/Windows; the LLM
server can still use its own GPU. Without `local`, the existing PyPI torch route
is preserved; `cloud-gpu` selects that route explicitly. The two extras conflict
intentionally. Keep `--extra local` on `uv run`, or uv may resync a different
set of dependencies. macOS uses its standard torch wheel.

## Resource controls

Start with a short document and a small cast. Local preparation rejects graphs
with more than 10 agents rather than silently dropping entities. Simulations are
capped at 5 rounds by default, including standalone scripts. Change the explicit
limits in `.env` when you have measured your machine.

| Setting | Default | Effect |
| --- | --- | --- |
| `LOCAL_MAX_AGENTS` | 10 | Maximum entities used for a simulation |
| `LOCAL_MAX_ROUNDS` | 5 | Cap for each simulation platform |
| `LOCAL_MAX_AGENT_ITERATIONS` | 3 | Maximum model/tool iterations per agent action |
| `LOCAL_MAX_CONCURRENCY` | 1 | One shared inference budget for all app processes |
| `LOCAL_MAX_QUEUE` | 32 | Bounded waiting requests; overflow returns 429 |
| `LOCAL_REQUEST_TIMEOUT` | 180 | Total gateway request deadline, seconds |
| `LOCAL_CONTEXT_TOKENS` | 8192 | CAMEL context budget, including output reservation |
| `LOCAL_MAX_OUTPUT_TOKENS` | 2048 | Hard outgoing completion cap, including retries |
| `LOCAL_MAX_INPUT_CHARS` | 24000 | Request character guard; not a tokenizer |
| `LOCAL_REASONING_EFFORT` | `none` | Disable Ollama thinking for compact JSON; empty omits |

The model server's actual context must match `local/Modelfile`. Changing the
application setting alone cannot enlarge a model's context. CAMEL uses a
conservative UTF-8 byte estimate to avoid a hidden tokenizer download; tool
schemas and the actual server tokenizer also matter. If context is too small,
reduce document/profile size or raise both settings after checking memory use.

The inference gateway is one process-owned loopback listener passed to simulation
children. Chat, embeddings and memory extraction share its budget. It refuses
remote URLs, redirects, cloud-tag model names, streaming, multimodal requests,
inherited HTTP proxies/cookies and oversized payloads. SDK credentials are the
literal placeholder `local`. Boost-provider settings are ignored in local mode.
A disconnected caller retains its slot until completion/deadline. A model server
may keep computing after transport cancellation, so its own parallel limit is
still necessary. Running multiple independent MiroFish backends creates separate
gateway budgets; run one backend for this preset.

Local Twitter uses OASIS's random recommendation policy instead of its hidden
Twhin-BERT transformer. This changes recommendation semantics intentionally and
avoids an extra weight download/GPU allocation. Reddit retains its existing
non-LLM ranking. The app disables dependency telemetry/tracing and implicit
Hugging Face downloads, and the UI no longer fetches Google Fonts.

## Swap and improve models

- Change the model alias/Modelfile to a smaller, larger or locally fine-tuned
  model, then rerun `check:local` before comparing simulations. JSON-schema output
  and tool calling are required; a chat-only model is insufficient.
- A local llama.cpp OpenAI-compatible server can replace Ollama through
  `LLM_BASE_URL`. Run embeddings on a separate loopback endpoint if needed using
  `LOCAL_EMBEDDING_BASE_URL`. Set `LOCAL_REASONING_EFFORT=` when the server does
  not support that parameter. There is no automatic cloud fallback.
- Tune prompts or LoRA adapters against a fixed small evaluation set before
  increasing concurrency. No fine-tuning or weights download is performed by
  the application. Keep model licenses with redistributed weights/adapters.
- Changing the embedding model/dimension changes vector meaning. Use a fresh
  local graph/database and rebuild uploaded source documents; do not mix old
  and new embedding spaces in one graph.
- Memory uses explicit local extraction and embedding clients and an
  embedding-cosine reranker, with no separate cross-encoder model. It preserves
  per-graph entity/fact/episode provenance, cursor paging, and durable batch
  status. It is not a byte-for-byte Zep Cloud implementation.
- Graceful shutdown cancels ingestion jobs. An abrupt process/PC crash can leave
  a durable job marked processing; it is intentionally not replayed automatically
  because extraction may already have written partial data. Inspect the failure,
  then rebuild a fresh graph from the original document rather than blindly replaying.

## Troubleshooting

- **Connection refused:** start Neo4j and Ollama; confirm ports and loopback URLs.
- **Model not found:** run the explicit pull/create commands; check the alias in
  `.env`. Do not choose a `:cloud` or `-cloud` model.
- **400 mentioning reasoning:** set `LOCAL_REASONING_EFFORT=` and rerun the doctor.
- **JSON/schema/tool check fails:** choose a model/server supporting those
  features; small models can return malformed or truncated structures. The app
  surfaces errors instead of upgrading to a paid provider.
- **429 or timeout:** reduce simultaneous work, use shorter inputs/smaller models,
  or raise the deadline after measuring latency. Do not raise concurrency first.
- **Agent limit:** reduce the input/ontology scope or deliberately raise
  `LOCAL_MAX_AGENTS`. No entities are silently discarded.
- **Unexpected memory usage:** keep Ollama parallelism at one, lower context,
  and allow CPU offload. Loading/unloading a separate embedding model can trade
  speed for memory when `OLLAMA_MAX_LOADED_MODELS=1`.

## Development verification

```sh
cd backend
uv sync --extra local --locked
uv run --extra local --locked python scripts/run_offline_tests.py -q
cd ..
npm test --prefix frontend
npm run build
```

The offline runner clears inherited model/database credentials and provider overrides,
disables implicit model downloads and telemetry, and installs a Python socket/DNS
regression guard before importing pytest. Loopback TCP/UDP and Unix sockets remain
available for the real test fixtures. This is not an OS firewall: native libraries
or non-Python subprocesses require their own isolation. Dependencies and the Neo4j
image must be prepared online first; model weights are never needed for this suite.

Set `MIRO_TEST_NEO4J_URI` to a dedicated disposable loopback database and add
`--require-neo4j` when all integration cases must run. Without that opt-in, database
integration tests are explicitly skipped. From the root, `npm run test:local` runs
the same guarded command with the local dependency extra.

Run these checks locally using Python/pytest and the frontend test/build commands.
This fork does not run its verification suite through GitHub Actions. The existing
upstream release and star-history workflows are separate from these local tests.

Network-realistic gateway tests use synthetic loopback HTTP servers. The optional
Neo4j integration tests use `MIRO_TEST_NEO4J_URI` and a dedicated disposable
local database (see their fixture); never point them at a database with valuable
data. They test real Graphiti extraction against synthetic local model responses,
not model quality. The OASIS integration test uses the actual pinned libraries,
SQLite, and the weight-free local recommendation path.

The local architecture has been tested with these components in a Linux CPU
environment. Windows/macOS installers, actual model quality, GPU performance and
full browser-driven document-to-report generation still need machine-specific
validation. No GPU/RAM fit claim is made without measuring your PC.

MiroFish remains AGPL-3.0. Graphiti and OASIS are Apache-2.0; Neo4j Community is
GPLv3. Review the relevant licenses if you redistribute a packaged deployment.

### Report and chat rendering

Model responses, uploaded-document extracts, reports and interview answers are
untrusted text. The report/chat renderer supports the existing small Markdown
formatting subset, but displays raw HTML literally. It does not turn Markdown
links or images into active browser elements, so generated content cannot load
remote images, frames or styles merely by being displayed. The original report
and chat text remains unchanged in storage and downloads.

Run `npm test --prefix frontend` for rendering regressions, then
`npm run build --prefix frontend` for the local production build. This content boundary is separate from
the model-server trust boundary and is not a general browser/network sandbox.
