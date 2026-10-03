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
dimension and a finite, nonzero norm required for cosine search. Generated JSON
must use standard JSON values, schema output must preserve boolean types, and
tool arguments must contain real JSON rather than an empty/missing string.
It does not create a graph or download anything, and exits nonzero when a required
capability fails. It is a contract check, not a quality benchmark.

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

### Report-generation log polling

The Step 4 report-generation view keeps at most one pending request per log
stream, so slow responses do not queue duplicate reads at the same cursor.
Changing or clearing the report, or closing the component, cancels its browser
reads and rejects late responses from the old view, even after A→B→A navigation.
Completion stops periodic polling while allowing the already-pending final
console response to finish. Closing the view does not cancel backend report
creation. Local frontend tests cover these reactive/lifecycle paths; a full
browser run with a real model remains a separate integration check.

### Interaction-view request ownership

Step 5 and its parent view scope report, simulation, project, graph and profile
loads to the current report/simulation context. Navigation clears the old display
and conversation state, aborts browser requests and ignores late responses,
including A→B→A navigation. Initial data reads wait for the parent to resolve a
complete context and are not repeated by mounting. Repeated graph refreshes keep
only the latest response and its loading state.

Chat replies stay with the conversation that submitted them when switching agents
or tabs. Changing reports clears that view's conversation cache. Surveys use the
submitted question and profiles even if the form is edited while waiting; repeated
submissions are blocked while the current survey is pending. Closing or replacing
the view also rejects late chat/survey results and errors. Aborting an HTTP request
does not promise cancellation of server-side model inference or interviews.

The local frontend suite executes actual Vue setup scripts with real reactivity,
deferred HTTP boundaries and a linked parent/child test. It also checks optional
API signal/body compatibility. Full browser navigation and real model responses
remain separate runtime checks.

### Simulation post/comment reads

The `/api/simulation/<id>/posts` and `/comments` endpoints resolve their SQLite
files under `SimulationManager.SIMULATION_DATA_DIR`, matching the state manager.
They accept only `twitter` or `reddit` (omission uses the saved platform), reject
unsafe ID components and resolved symlink escapes, and validate `limit` in 0–500
(default 50) plus a nonnegative SQLite-sized `offset`. Invalid input returns 400
rather than selecting another filesystem path or requesting an unlimited page.

Database connections use SQLite `mode=ro` and close even when a query fails. They
still read committed live WAL data; this is a read-only database connection, not
an immutable snapshot or a guarantee about SQLite's auxiliary WAL files. A missing
simulation read creates no directories, and a database removed before opening
is not recreated. Tests use disposable real SQLite files, including failure paths
and symlinks. This hardens these two endpoints; it is not a complete filesystem
sandbox or a security claim about every API route, hostile local processes, or
native Windows behavior.


### Project and report file storage

Project/report managers accept record IDs containing 1–128 ASCII letters,
digits, underscores or hyphens; Windows device names are rejected. Every managed
child path is checked before use, including uploads, extracted text, report
sections, logs and legacy report JSON/Markdown files. Descendant symlinks and
junction aliases are refused, even when they point to a sibling record. The
configured storage root itself may be a symlink for a relocated data directory.
Listings skip unsafe entries rather than following them. Invalid project/report
route IDs return 400 before their handlers run.

Normal saved records, legacy report lookup and generated filenames keep their
formats. Original upload display names are retained; generated filenames must
remain portable components. Report log writers now use the same configured root
as report readers. Local regressions use disposable files and symlinks; malformed
deletes are tested with the destructive operation intercepted. These are scoped
project/report path checks, not authentication, crash-safe saves, a complete API
sandbox, or protection against hostile local filesystem changes between a check
and access. Native Windows behavior remains a separate runtime check.

### Reusing prepared single-platform simulations

The preparation check reads `SimulationManager.SIMULATION_DATA_DIR` and requires
profile files only for the saved enabled platforms. Reddit uses JSON profiles;
Twitter uses CSV rows, including quoted commas/newlines when counting agents.
Dual-platform simulations keep Reddit as the displayed profile-count default.
Legacy states without platform flags still require both platforms. Disabled
platform leftovers are ignored, and `force_regenerate=true` still bypasses reuse.

A valid completed preparation can be reused after the existing ready/running/
completed/stopped/failed states. The existing preparing-to-ready reconciliation
runs only after its required artifacts are present and readable. Invalid boolean
flags, no enabled platform, corrupt/non-object state or config, invalid Reddit
profile envelopes and missing Twitter headers are not reported ready. This is
an artifact/envelope check, not full OASIS schema or model-quality validation.

This checker uses the shared path guard and rejects linked descendants and unsafe
IDs before reading or reconciling files; checking an unknown ID creates no record
directory. These changes do not harden every SimulationManager/SimulationRunner
or IPC path, add concurrency-safe reconciliation, or make saves crash-durable.
Tests use disposable files and Flask requests without inference/background work.

### Simulation manager storage boundaries

SimulationManager uses the shared ID/component checks for state, JSON/CSV
profiles, configuration and generated run-instruction paths. Reads do not create
unknown record directories; only saving a valid state creates its directory.
Path checks run even before a state-cache hit, and listings skip unsafe aliases
or unrelated entries. A configured root symlink remains supported for relocation.

Preparation checks its enabled output paths before changing state or calling
memory/model providers, and validates the paths it supplies to profile/config
writers. The configuration-download endpoint uses the same guarded file path and
returns 400 for unsafe IDs/aliases. Normal single/dual-platform formats and the
existing in-memory state-cache behavior are unchanged.

Tests use disposable files, synthetic preparation providers and real Flask
requests. This covers the manager and config download, not all direct API,
SimulationRunner, script or IPC file access. It is not a full filesystem sandbox,
protection against hostile local path mutation during long-running work, an
atomic/concurrent state-update mechanism, or proof of native Windows behavior.

### Restart cleanup safety

`cleanup_simulation_logs` validates the simulation ID, record directory and every
existing cleanup target before deleting any files. Descendant aliases and non-file
targets refuse the whole cleanup. The deletion list remains the existing run state,
main/stdout/stderr logs, two simulation databases, environment status and each
platform's `actions.jsonl`; preparation metadata, config and profiles are retained.

Cleanup takes the runner's startup/finalization lock without waiting, and refuses
unfinished run states, owned live processes/monitors, retained memory updaters or
failures inspecting current-backend resource owners. It never stops those resources
itself. A caller can retry after normal finalization. Cache removal happens under the same lock only after
all requested deletes succeed, so cleanup cannot erase a newer startup claim.
Ordinary unlink failures can still leave a partial cleanup; the error/file lists
and cached state remain available for retry.

A corrupt or unreadable uncached run-state file can still be cleaned when no
active state was parsed and this backend owns no process, monitor or updater. This
preserves recovery of damaged run files; it does not establish that another
backend or an orphan process has stopped.

These are current-backend ownership checks and scoped path checks, not a
cross-process lock, orphan-process detector, transactional deletion, hostile-local-
filesystem sandbox or native Windows guarantee. Tests intercept malformed deletes,
use disposable positive fixtures and synthetic resource owners, and exercise a
real two-thread startup/cleanup boundary plus the force-restart API failure path.

### Read-only interview history

The interview-history API and public runner reader validate the simulation ID and
all requested database paths before opening either platform. Descendant aliases
are rejected; configured root relocation is supported and unknown records create
no directories or databases. SQLite uses an escaped file URI with `mode=ro`, with
the connection closed even on query failures. Committed data in a live WAL-backed
simulation remains readable. This keeps the main database read-only, without
claiming that SQLite can never require existing WAL/shared-memory sidecar access.

Requests must be JSON objects. `platform` is `twitter`, `reddit` or null/omitted;
`limit` is a JSON integer from 0 to 500 (default 100); `agent_id` is null/omitted or
a nonnegative signed-64-bit integer, including zero. Boolean, fractional and string
numeric values are rejected with HTTP 400 rather than sent to SQLite. Both-platform
results keep descending timestamp order and a total limit. Query/storage read
failures retain the existing logged empty-result behavior.

Malformed/non-object trace info is retained as a raw response rather than ending
processing of later valid entries. Invalid UTF-8 bytes use replacement characters;
empty info keeps its existing empty-object response. Undated rows sort after dated
rows. These checks are limited to interview history, not other runner/IPC paths,
backend-wide authentication, protection against hostile local path mutation or a
native Windows guarantee. Local tests use Flask and disposable SQLite, including
read-only enforcement, closure after errors and live WAL commits, without inference.

### Recoverable project metadata saves

ProjectManager stages each `project.json` beside its destination and replaces the
file only after JSON serialization and handle closure succeed. Progress readers
continue to see the previous complete metadata during a save. Serialization,
close or replacement failures preserve that previous file; a failed first save
leaves no partial final JSON. Each save owns a unique temporary file, so cleanup
of a failed overlapping save cannot remove another save's completed output.

The existing ID/path guards, UTF-8 JSON format and propagated save errors remain.
Saving a missing project does not create its directory. Ordinary failures clean
up temporary files; a denied cleanup is logged without masking the original
error, and an abrupt exit may leave a temporary file. The in-memory Project,
including its updated timestamp, is not rolled back on failure.

The project save path covers metadata, with simulation state covered below; it
does not cover uploads, extracted text or report state; runner state is covered
below. It is per-file
replacement, not a multi-file transaction,
concurrent-edit lock, power-loss durability or a hostile-local-filesystem sandbox.
Local tests use disposable files, real project readers and injected I/O failures;
native Windows behavior remains a separate runtime check.

### Recoverable simulation preparation state

SimulationManager now uses the same staged JSON writer for `state.json`. A reader
using another manager sees the previous complete file until the save finishes;
serialization, staging, close or replacement failure preserves that file. A failed
first save leaves no partial final JSON. A distinct new state object enters this
manager's cache only after replacement succeeds, and a normal retry can recover.

The manager still creates a directory when explicitly saving a valid new state.
Reads remain noncreating, and existing path/alias validation precedes staging.
Already-shared mutable state objects and their timestamps are not rolled back on
failure: the current manager can retain unsaved in-memory edits while a fresh
manager reads the previous disk snapshot. JSON fields and formatting are unchanged.

This shares the project writer's cleanup and per-file limits; it adds no concurrent
edit lock, multi-file transaction, crash durability or native Windows guarantee.
Tests cover cache ownership, fresh readers, first saves and retries with disposable
files. Existing project-save and both managers' path-boundary tests also run.

### Complete action-history summaries

Per-platform action logs take precedence over the legacy root `actions.jsonl`.
If either modern log exists when a read starts, an empty platform/agent/round
filter cannot revive old legacy rows. The legacy-only layout still works, with
its existing filtering, pagination and descending timestamp order. The source
choice is retained if a modern log disappears during the read.

Round timelines and agent statistics now aggregate the complete action history,
including older rounds/agents beyond 10,000 actions. Their first/last action times
are the minimum/maximum under the existing timestamp ordering, rather than being
reversed by descending traversal. Ordinary action-list pagination and count/type
formulas are unchanged. Local tests exercise the Flask endpoints with disposable
JSONL logs, including 10,004 actions and a controlled log-removal case.

These readers still load full histories and do not take an atomic snapshot across
files. This does not add universal runner path validation, full log-schema validation,
constant-memory paging, timestamp/timezone normalization or native filesystem
validation. Model calls and simulation execution are not involved in these tests.

### Malformed action-history records

History reads skip individual non-object JSON values and records whose agent ID
or round is not a nonnegative integer (including booleans). Timestamp and action
type keys must be strings, and the effective platform after the existing default
is applied must be a string. A malformed row cannot break sorting/grouping of the
valid actions before and after it. Existing event lines and incomplete JSON lines
remain skipped; invalid rows are left untouched on disk.

Missing optional keys retain their previous defaults. In particular, a missing
round is consistently treated as round zero when filtering as well as when
returning the action. Optional action payloads/results and success values are
preserved. Both the modern and legacy logger output formats remain supported.

These checks apply to the history reader, not the separate live-ingestion parser
or the complete action schema. They do not validate timestamp syntax, normalize
timezones, repair logs, bound memory usage, or suppress filesystem/UTF-8 errors.
Local tests use actual log writers, disposable JSONL files and Flask queries;
no model or gameplay execution is involved.

### Recoverable runner-state snapshots

SimulationRunner now stages `run_state.json` beside its destination, closes the
complete JSON and then replaces the previous snapshot. Uncached readers keep
seeing the last complete status while a save is in progress. Serialization,
staging, close or replacement failures preserve the previous file, and a failed
first save leaves no partial final JSON. A distinct new state object enters the
runner cache only after replacement succeeds; ordinary retries remain possible.

The save validates the simulation ID and existing descendant path/alias boundary
before creating a valid new run directory or staging its file. Configured storage
root relocation remains supported. Existing JSON fields, Unicode formatting,
process ownership/finalization locks and run-state loading are unchanged. Already
shared mutable state objects are not rolled back when persistence fails.

This is a per-file snapshot, not a concurrent state-version lock, a transaction
with preparation metadata or a power-loss guarantee. It does not add validation
to every runner read/API path or protect against hostile local filesystem changes
between validation and use. Local tests cover actual readers/cache behavior,
partial writes, nested saves, retries and storage aliases with disposable files;
native Windows and live simulation processes remain separate validation work.

### Ordered normal shutdown

The app registers one ordered exit callback for its owned resources: first stop
simulations and drain their graph updaters, then close local memory clients, then
close the inference gateway owned by this process. Lazy initialization no longer
allows a later-created client or gateway to close ahead of the updater that needs
it. Children using an inherited gateway address do not close the parent's gateway.
Distinct memory clients are all retained for cleanup, while repeated registration
of the same callback is ignored.

Existing signal cleanup still runs first when invoked, and its completed runner
cleanup remains a no-op during the exit fallback. A cleanup failure does not skip
attempts for later owned resources; the first error retains secondary failure
notes. This coordinates normal Python exit, whose standard
[atexit callbacks run in reverse registration order](https://docs.python.org/3.11/library/atexit.html).
It does not recover from a hard kill, force an unresponsive producer to drain, or
guarantee that interrupted graph writes completed successfully.

Local tests exercise the actual registrations, shared client and runner/updater
cleanup with synthetic resources, plus a separate Python interpreter exiting
normally. They cover lazy creation order, gateway-only use, inherited gateways,
signal-before-exit cleanup and failed callbacks. No OS signal is sent, and these
tests do not run models or live simulation subprocesses.

### Complete report file snapshots

Report metadata (`meta.json`), outline and progress updates now use the existing
same-directory JSON staging helper. Readers see the previous complete file until
the replacement succeeds. A failed serialization or replacement preserves that
file, and a failed first save leaves no partial final JSON. In particular, progress
polling no longer reads a temporarily truncated file during an ordinary update.
The existing ID/path checks, directory creation, fields and Unicode formatting remain.

Section Markdown saves, assembled reports and the full Markdown file written by
`save_report` use the same closed-file replacement lifecycle. An interrupted write
keeps the previous `.md` file available to section readers and downloads; a failed
first save leaves no partial final text. Formatting and section ordering remain.

Each file is independent. A later outline or Markdown failure does not roll back
already saved report metadata. In particular, `get_report` may return new complete
Markdown embedded in `meta.json` while the separate `.md` file still contains its
previous version. The download endpoint's legacy reconstruction of a missing
Markdown file and append-only logs keep their existing behavior. This does not add
multi-file transactions, writer version locks, power-loss durability or protection
against hostile local path changes. Local tests exercise real report readers,
downloads and the Flask progress endpoint during writes, failed first/repeated
saves, retry and path aliases using disposable files. Native Windows and live
model generation remain unverified.

### Preparation view request lifetime

Step2 ties preparation startup and status/profile/config reads to its current
mounted simulation. Changing that simulation or leaving the component retires
the old requests and aborts their HTTP observation. Late responses cannot restart
timers, overwrite the current display or emit an old completion/error. Polls in
the same stream do not overlap. The final prepared-data load waits for any current
read before requesting a fresh snapshot, checking ownership after every await.

A generated config while preparation is still running is a preview. The view
waits for confirmed preparation readiness and the final data load before enabling
the next step. Terminal completion/failure stops remaining polls; a completed
mounted view keeps its data and normal custom/automatic round selection.

Aborting HTTP does not cancel preparation already running on the backend. These
guards apply to the Step2 component's received simulation ID, not every parent
route or the separate Step3 simulation screen. Local tests execute the actual Vue
setup/reactivity with deferred replies and verify cancellation through real Axios
requests to a disposable loopback server. Browser rendering and model execution
remain separate validation work.

### Simulation view request lifetime

Step3 binds start/stop/report actions and status/detail reads to the mounted
simulation and run. Leaving, changing simulation or explicitly restarting retires
the previous requests. Late replies cannot restart timers, replace the new run's
display or navigate to an old report. Each polling stream and action allows one
pending request at a time; normal startup payloads and report generation from a
completed view remain supported.

Terminal runner status stops ordinary polling and requests a fresh final action
snapshot after any older detail request settles. A failed final detail read is
best-effort and does not reverse the terminal status. While the run remains
nonterminal, pending or unsuccessful Stop requests keep polling active; a pending
response alone does not clear an already observed failure. An accepted Stop can reflect recovery
from an older failed-status snapshot, with a new final detail refresh; older
refreshes cannot publish over that recovery.

HTTP cancellation does not stop backend simulation, stopping/finalization work or
report generation already accepted by the server. The parent route's ID handling
and backend finalization rules are unchanged. Local tests execute actual Vue setup
and reactivity with controlled replies and loopback HTTP cancellation. Browser
rendering, real model runs and native OS process behavior remain unverified here.
