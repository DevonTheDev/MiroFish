# Run MiroFish locally without paid APIs

Local mode retains the existing interface, OASIS simulations and reports, while
using your own OpenAI-compatible model server and Graphiti with Neo4j Community.
No OpenAI or Zep account/key is required. Cloud mode remains the default when
`MEMORY_BACKEND` is unset or `zep`.

This is a single-user local setup. It has no API subscription fees, but uses your
PC's RAM, disk, compute and electricity. Small-model accuracy is not equivalent
to a large hosted model. Generated simulations are exploratory, not validated
forecasts or a basis for consequential decisions.

## Choose a simulation platform

In Step 1, after the graph is ready, select **Info Plaza** (Twitter), **Topic
Community** (Reddit), or **Both** before entering environment setup. Both is the
existing default. The choice belongs to the new simulation; create another
simulation from the project to try a different choice. It applies in both local
and cloud mode.

Preparation writes the enabled profile files and platform configuration. The
setup preview chooses Reddit when both are enabled and Twitter for a
simulation that only uses Info Plaza. Twitter preview data retains the biography and
persona from its canonical OASIS CSV; absent optional demographics or topic tags
are not synthesized. The same canonical CSV fields are used while preparation
is in progress and after it finishes.

Start uses the saved platform flags. The running view displays that accepted
selection and only its platform status and activity panels. A legacy server
response without a recognized platform remains observable, with platform details
shown as unavailable. Completion, Stop and report generation still follow the
owned run's status. Agent surveys and report interviews use replies attributed
to the actual environment; an unavailable second platform is not presented as a
participant that failed to answer.

Single-platform runs publish their recorded SQLite actions and round progress
through the same event-log interface as the dual runner, including rounds with
no active agents. Natural completion is published after the existing graph-memory
drain; the environment may remain alive for interviews. A model step or required
trace read that fails does not write a normal completion event. This does not
make an in-flight model request immediately interruptible.

Selecting one environment reduces the number of social environments launched.
It does not promise half the memory, half the generation time, or better model
quality: graph building and other preparation are shared, and inference cost
depends on the cast, rounds, model and hardware. The normal local agent, round,
request and concurrency limits still apply.

API callers may send `platform: "auto"` to `/api/simulation/start`; a successful
reply includes the resolved `data.platform` (`twitter`, `reddit` or `parallel`).
Omitting the field retains the existing `parallel` request default. Explicit
requests for disabled platforms are rejected before restart cleanup or startup.
Creation flags must be booleans and at least one platform must be enabled.
Single-platform batch interview replies use the same `twitter_<id>` or
`reddit_<id>` keys as dual-platform replies, with source platform metadata. An
explicit request for the opposite platform is rejected before interviewing any
agent in that batch.

Local tests cover all three creation/preparation/start choices through real
Flask, production Axios and compiled Vue, plus actual single-platform command
files, SQLite interview replies, report consumption and the installed OASIS
profile loader. The graph/model/process boundaries use synthetic fixtures; the
Vue test host is not a native browser. This does not establish model quality,
measured hardware savings, Windows behavior or a completed live model run.
Aborting a page request retires its observation and does not delete an already
created simulation or stop accepted backend work.

## Plan a small local simulation

After building a graph, Step 2 offers a local preparation planner. Choose a small
cast before generating profiles and configuration, instead of preparing every
eligible entity and discovering afterward that it exceeds your loaded agent
cap. The ordinary cloud preparation workflow remains automatic.

1. Wait for the setup view's existing environment-cleanup check and its passive
   preparation observation. The planner shows loaded agent, round and concurrency
   limits, saved-artifact availability and any current owner. An unknown mode,
   failed observation or invalid limit does not start preparation.
2. Choose **Load cast** to connect to local graph memory and read eligible
   entities. Select exact entities, using their names and types to find them.
   For example, a graph with twenty people can supply a selected two-person cast;
   type filtering alone would still select twenty. Selected IDs remain exact,
   and an empty or over-limit selection cannot start preparation.
3. Choose template or LLM-generated profiles and **Maximum rounds**, then
   **Prepare selected cast**. You can save these draft choices as a cast preset
   before starting generation.
   Template profiles avoid per-agent model generation and embedding/retrieval
   context. Simulation configuration generation still uses the configured model,
   and the simulation itself will use it. LLM profile generation retains its
   existing fallback behavior; the choice is not a quality guarantee.
4. After authoritative profile/configuration completion, review **Maximum
   rounds** and Start. You can change this maximum again before starting. Local
   values begin at one and cannot exceed the loaded
   cap. The effective total is bounded by the configured simulation duration,
   requested maximum and backend cap. This is simulated workload, not an estimate
   of wall-clock time or GPU capacity.

The initial plan observation does not construct graph/model clients, generate
profiles/configuration or reconcile saved state. **Load cast** is a separate
explicit action because cold graph access can start the shared local gateway and
memory client, connect to Neo4j and initialize its indexes/constraints. It does
not run profile/configuration inference. The setup view's manual graph Refresh
is also an explicit graph read. Existing return-to-setup environment cleanup
remains separate from preparation.

An already prepared simulation offers **Reuse saved preparation**. This verifies
the enabled platform files and their counts again, without graph access or model
calls, before loading the existing profiles/configuration. Missing, changing,
unsafe, inconsistent or now-over-cap files fail explicitly; reuse never falls
through to regeneration. A previously completed preparation is not overwritten
with a newly selected cast. Create another simulation through the existing
project flow to prepare a different cast. The saved files do not record the
original template/LLM choice, so the planner does not invent that provenance.

If a final request for saved profiles or configuration fails, setup shows an
error and keeps Start unavailable. Choose **Refresh plan**, then explicitly
choose **Reuse saved preparation** to retry loading the saved files. This
recovery does not regenerate profiles or replace the saved preparation.

Preparation and run ownership are checked again on the backend. A pending or
processing preparation, active run, live process/monitor or retained graph updater
prevents conflicting work. Loading an existing preparation task observes that
task rather than submitting it again. An in-flight task retains ownership until
its final artifact/state writes and graph-reader cleanup have finished. These
guards coordinate one backend process; they are not distributed locks across
multiple backend workers.

The chosen IDs are revalidated against the graph before profile generation.
Missing or no-longer-eligible entities fail rather than being replaced or
expanding the cast. Only selected entities become agents, in the selected order;
other entities may still supply relationship context for LLM profiles. Graph
contents can evolve between observations: this is an exact selection of current
entity IDs, not a frozen historical copy of every graph fact. Navigating away
retires UI observation and queued continuations; it does not cancel an already
accepted backend preparation.

Planning has explicit limits: 5,000 scanned graph nodes, 1,000 eligible catalog
entries, and at most the smaller of 1,000 or the loaded agent cap selected IDs.
LLM profile enrichment admits at most 20,000 graph edges. Oversized catalogs and
graphs are refused rather than shown as complete truncated selections. Preview
names and summaries are bounded text previews with a truncation indicator; IDs
and primary types are not silently changed. Preview responses are limited to
4 MiB. These bounds do not measure available hardware or limit arbitrary
provider-record bytes at the transport layer.

New local planning requests have a 256 KiB body limit and reject duplicate JSON
keys, nonfinite values and unsupported fields. The same body admission bound
also applies to legacy local preparation calls; cloud request parsing retains
its existing behavior. Planned state/run reads are limited to 1 MiB each,
configuration and each enabled profile file to 8 MiB, project metadata to 1 MiB
and extracted project text to 8 MiB. Regular-file/path checks and before/after
fingerprints detect ordinary replacements; they are not a sandbox against a
hostile local filesystem writer. Artifact readiness is a bounded structural
check, not complete validation of every OASIS field.

Local verification uses disposable files, synthetic graph entities and model
boundaries, actual Flask/Axios/compiled Vue routes and the existing preparation
and runner lifecycle tests. Final profile-read checks distinguish failed requests
from successful empty responses and exercise explicit refresh/reuse recovery.
A disposable Neo4j/Graphiti test also verifies that
previewing real stored entities and reading a selected cast add no model or
embedding requests after graph construction. It does not use pretrained weights, private documents
or paid services. Native browser rendering, Windows behavior, real-model quality
and useful simulation outcomes remain unverified.

## Save and reopen a local cast preset

After **Load cast**, choose agents, profile mode and **Maximum rounds**, then
choose **Save cast preset**. The downloaded `mirofish-local-cast-preset.json`
keeps those choices for a later draft or another simulation using the same
exact project and graph. It contains seven fields: format version, kind, project
ID, graph ID, ordered selected entity IDs, the template/LLM choice, and maximum
rounds. It contains no generated profiles, prompts, credentials, platform
settings or simulation artifacts.

In an idle, unprepared local setup, choose **Load cast**, then **Open cast
preset**. Review **File choices** and any compatibility message. Opening only
stages the file; **Apply cast preset** replaces the selected agents, profile
mode and round maximum together. Choose **Prepare selected cast** explicitly
when ready, and Start separately after preparation finishes. File operations
make no API requests, upload no file content, and do not start model work.

The exact project/graph IDs must match the loaded cast. Every selected entity ID
must still be eligible, and the selection and rounds must fit the loaded local
limits. Incompatible presets are refused without changing the draft. IDs are
not matched by name, dropped, reordered or clipped, and an excessive round cap
is not silently reduced. Backend selection, ownership and resource checks still
run again when preparation or execution is explicitly requested. The round cap
bounds later execution; it does not limit configuration-generation calls.

Files are limited to 256 KiB and 1–1,000 unique portable entity IDs, further
restricted by the current loaded agent cap when applied. Admission rejects
malformed UTF-8/JSON, duplicate keys, extra fields, unsupported versions,
invalid types and nonfinite or unsafe numbers. **Clear file preview** dismisses
a staged import. Failed imports preserve the current draft. New files, catalog
replacement, refresh and navigation retire pending reads and old callbacks;
an older file cannot overwrite a newer selection or another simulation.

Save can export valid choices still retained in the current view after
preparation or cancellation. Applying remains unavailable while preparation,
cleanup or a run owns the simulation, and for a cancelled or already prepared
simulation. A refresh loses unsaved draft choices: they are not reconstructed
from saved state, generated configuration or cancellation records. Save a file
before leaving if you need those choices later. For a cancelled preparation,
create a fresh simulation through the project flow, load its current cast and
apply the file there.

A graph ID is an identity, not a frozen copy of historical facts. This preset
restores choices against the loaded graph; fresh preparation uses current graph
content and creates new profiles/configuration. It does not reproduce a prior
model output or authenticate where an imported file came from.

Local tests cover strict file admission, both locales, compiled Vue/router file
and context races, existing prompt-suite parser compatibility, and actual
Flask/Axios workflows that export from one simulation and apply to another.
Those workflows verify no file-operation API calls, exact explicit preparation
inputs, preserved source files and the round cap passed to Start. They use
synthetic graph/model boundaries. Native browser file dialogs/rendering,
Windows and real-model quality remain unverified.

## Cancel local preparation

Step 2 offers **Cancel preparation** for an exact, currently owned task started
through **Prepare selected cast**. This is useful when you chose the wrong cast
or want to stop spending local model time on a preparation. Cloud tasks, older
legacy-local preparation calls and running simulations do not get this action.

1. After the backend acknowledges the planned task, choose **Cancel
   preparation**. The action refers to that task ID and simulation ID; changing
   views does not retarget it to a replacement task.
2. Keep observing while cancellation drains. Queued profiles and later
   configuration stages stop. Work already running may finish, including that
   profile's retrieval work or the current configuration stage's retries and
   fallback. This does not terminate the model server or promise an immediate
   stop to inference already in progress.
3. When the task reports cancellation complete, its completed partial profile
   files remain available for inspection. Start, reuse and regeneration of that
   cancelled simulation are blocked. Return to the project's graph step and
   create another simulation to prepare a new cast. If the current view still
   retains your choices, **Save cast preset** can keep them for that fresh setup.

Resource-dependent graph/entity/document preflight now runs inside the planned
worker, so HTTP admission returns the task ID before those checks finish. Invalid
or changed graph selections still fail before profile generation, but these
errors are reported through the task. The initial expected cast count comes from
the submitted unique IDs; authoritative entity details arrive during work.
Static request, mode and resource-cap validation remain admission checks.

There is a final publication boundary after configuration generation. If
cancellation wins that boundary, the task cannot publish a READY preparation.
If finalization has already won, cancellation is too late; the view keeps
observing the normal completion or failure. A request being accepted is distinct
from cancellation having finished. The task keeps ownership until active work,
state/artifact writes and graph-reader cleanup have finished. A cleanup or
durable-outcome failure remains a blocker rather than being reported as success.

An accepted cancellation atomically creates the bounded
`preparation_cancellation.json` record in that simulation's directory. It records
only a schema version, exact task/simulation IDs, cancellation phase, timestamps
and progress. It contains no prompts, profiles or credentials. Readiness,
prepare/reuse, force-regeneration and execution-start paths consult this record,
including direct manager/runner entry points. Changing backend mode does not
make cancelled artifacts runnable. Unsafe or corrupt cancellation records fail
closed. A still-draining cancellation whose live owner is lost
after restart is unavailable/interrupted; it is not reconstructed as a running
task or silently cleared. Normal uncancelled preparations create no persistent
job record in this increment.

The record remains with the cancelled simulation. This feature does not delete
partial files, resume work or provide a marker-removal/recovery operation. Use a
new simulation ID for another attempt. These controls coordinate one backend
process, like existing preparation ownership; they are not distributed locks or
a filesystem sandbox against a hostile local writer.

`POST /api/simulation/prepare/cancel` accepts exactly `simulation_id` and
`task_id`, with no query parameters and a 16 KiB strict JSON body limit. Unknown
fields, duplicate keys, nonfinite values and mismatched task ownership are
refused. Repeating the same accepted request is idempotent. The response
separates acceptance from `preparing`, `cancelling`, `finalizing`, `cancelled`,
`ready`, `failed` and `unavailable` preparation phases. Passive plan/status reads
observe this outcome before inferring readiness from saved files and do not
initialize graph/model resources. An old or unrelated task ID cannot affect a
new task.

The view does not retry a cancellation POST automatically. If its reply is lost,
status observation establishes the current task outcome; an explicit retry uses
the same owned ID only when still allowed. Navigation or HTTP abort retires the
view's observation, without undoing a cancellation already accepted by the
backend. Reload observes the owned task or its persistent block. Partial or late
profile/configuration replies cannot turn a cancelled view into a ready one.

Local tests use real preparation managers, profile pools and configuration-stage
callbacks with synthetic graph/model boundaries. Linked Flask, production Axios
and compiled Vue tests cover drain, a lost successful cancellation reply and a
late request losing to finalization. Files and services are disposable; no model
weights, paid inference or hosted tests are used. Native browser layout, Windows
behavior and real-model cancellation latency remain unverified.

## Revisit saved reports

Choose **Saved reports** on Home, or open `/reports`. This independent library
lets you find every saved report ID, including earlier reports generated for the
same simulation. Search a literal phrase in saved report/simulation IDs, title,
summary or scenario requirement, filter by saved status, and page the matches.
It does not search report bodies. List summaries and requirements are bounded
previews; matching uses the complete admitted metadata strings.

Open a row to read its saved Markdown and download that exact captured UTF-8
snapshot. A simulation, graph or generation log is not needed to open a saved
report here. The reader shows literal wrapped Markdown, including raw HTML and
links as text. It does not execute or fetch anything embedded in a report. The
existing interactive report-generation screen remains available separately.

Saved status is metadata from the last write, not a check that a simulation or
report process is running. Ordering uses saved creation-timestamp text descending
and report ID ascending for ties, with missing timestamps last; historical local
timestamps are not converted to another timezone. **Refresh** starts a new
observation. The library does not poll, construct runtime resources, call models,
connect to graph memory, regenerate sections or modify report files.

The library recognizes modern `reports/<id>/meta.json` records and legacy
`reports/<id>.json` files. A modern namespace takes precedence for the same ID,
even if its metadata cannot be read. Invalid records are skipped with visible
reason counts; the healthy records remain available. The stored report ID must
match its record location. Unknown saved status is shown as unknown.

For modern records, a present `full_report.md` is the content source; otherwise
the reader uses embedded `markdown_content`. For legacy records it first checks
`<id>.md`, then embedded content. A present but unreadable, unsafe or oversized
Markdown file makes content unavailable rather than falling back to another
version. A saved empty body is distinct from unavailable content and can still
be downloaded. Metadata and body writes are independent, so the selected content
source is shown explicitly; the library does not claim a multi-file transaction.

Pagination pins the observed catalog revision, and opening a list row checks
that its metadata revision still matches. A change produces a conflict requiring
Refresh, instead of silently relabeling a different record. The body is captured
freshly when opened. Download reuses those accepted bytes without another server
read. Editing filters, changing the selected report or leaving the page retires
the previous single-report reader/download; late HTTP replies cannot restore them. Aborting
these requests only stops the view's observation.

Reads have explicit limits: 2,000 top-level catalog entries, 8 MiB per metadata
file, 64 MiB of aggregate metadata bytes, 200 query characters, and 1–50 rows per
page (20 by default). The list response is limited to 2 MiB. A selected Markdown
body is limited to 8 MiB and its detail response to 16 MiB. Catalog-wide exhaustion
fails visibly instead of claiming a complete truncated list. Individual invalid
or oversized metadata records contribute to unavailable counts. Title previews
contain at most 300 characters; summary and requirement previews at most 500 each.

Opening an absent library creates no directories. Descendant aliases and
nonregular files are rejected under the configured report root. Source identity
checks catch ordinary replacements during a read, but are not a sandbox against
a hostile local process racing filesystem mutations. The library reads only
saved report storage; no live-state or model-quality conclusion follows from it.

Local tests cover actual saved report files through Flask, Axios and the compiled
Vue/Router view, including older reports without simulation/log files, modern and
legacy sources, metadata-only and empty content, malformed records, bounded reads,
revision conflicts, literal display and exact captured downloads. Network fixtures
are disposable loopback services. Native browser layout/download dialogs and
Windows filesystem behavior still need platform validation.

### Find a passage in an opened report

Use **Find in this report** in the saved-report reader to locate a literal phrase in
its captured text. Matching ignores case by default; enable **Match case** when
capitalization matters. Spaces and punctuation are literal, including characters
that would have special meaning in a regular expression. Windows and Unix line
break styles match one another, so a pasted multiline passage can match without
changing the stored text or its highlight positions. This search covers the
opened body, while the library's catalog search continues to cover metadata.

Matches are highlighted without interpreting Markdown or HTML. **Previous match**
and **Next match** move between matches and wrap at the ends; the current match is
distinct. **Clear find** restores the original text without highlights. Empty bodies
and queries with no matches stay distinguishable from unavailable report content.

A query can contain at most 200 Unicode characters. An oversized paste shows a
limit message and does not run a shortened partial search. At most the first
1,000 non-overlapping matches are retained and highlighted. If more exist, the
reader says so explicitly; navigation then covers those first 1,000 matches.
The complete admitted body remains visible and downloadable, including text
beyond those matches.

Search belongs to the currently opened snapshot. Closing the reader, editing
catalog filters, refreshing, opening another report or leaving the page clears
it; a replacement body also retires earlier matches and pending navigation.
Search makes no extra server requests or model calls, changes no saved files,
and does not alter comparison captures or the exact downloaded Markdown bytes.
Its query and selection are not stored in the URL or browser storage.

### Compare captured report text

Open a saved report, then use the comparison controls to capture it as the left
or right side. Browse to another report and capture the other side. The two
captures stay fixed while you filter, page, open reports or use the library's
Refresh button. Replace or clear a side explicitly, or swap the pair to reverse
the comparison. A full page reload or leaving the library clears this temporary
pair; it is not saved in the URL or browser storage.

Each side shows its own report identity, saved status, observation time, content
source and hashes. You can capture the same report ID twice, including after a
fresh read changes its body. These are independently observed texts: metadata
revisions do not pin body versions, and the pair is not an atomic shared snapshot
or a persistent report-version archive. Saved partial/failed status remains
visible. Unavailable text is unknown, while a saved empty body is a valid empty
document.

The comparison checks exact text equality and shows bounded line changes for
different available bodies. It preserves Unicode and line-ending/trailing-newline
differences. Each visible text preview is limited to 64 KiB of UTF-8. A complete
line diff additionally requires each body to fit 64 KiB and 2,000 logical lines,
at most 1,000,000 comparison cells, and at most 4,000 output rows. Larger different
texts show a limited-comparison state with unknown change counts; they are not
silently presented as a complete truncated diff. Exact equality can still be
reported for larger identical captured texts without building diff rows.

Download either side to retain its exact full captured Markdown, including text
beyond the preview limit. Capturing, comparing, swapping, clearing and downloading
these accepted snapshots make no additional server reads, inference requests or
report writes. Report HTML and links remain literal text. This is textual review,
with no model-quality score or causal interpretation of the differences.

## Monitor local runtime activity

Choose **Runtime monitor** on Home, or open `/runtime`. The English/Chinese page
shows the backend's loaded local model names, validated loopback endpoints,
embedding dimensions and resource limits. It also shows the current gateway
instance's activity when this backend owns that instance. Use **Refresh** for a
new observation, or enable automatic refresh every five seconds after the prior
request finishes. Leaving the page stops its observation requests.

Opening or refreshing this page does not start the gateway, call a model, probe
Neo4j, construct memory, change settings, download anything or run the doctor.
`not_running` is a normal lazy-start state. A running gateway means its transport
has started; it does not prove that the model server or database is reachable,
that a model supports required capabilities, or that a simulation will succeed.
Use **Run local setup check** below, or the explicit doctor command in the setup
instructions, for capability checks.

The monitor separates three kinds of activity:

- **Admitted connections** are sockets using the gateway's admission budget.
  They include header/body reading, health requests and response delivery
- **Queued requests** are validated forwarding tasks waiting for an inference
  slot. **Active requests** have acquired that slot for the upstream operation.
  Chat, embedding and model-list requests use these counters
- **Succeeded, failed, timed out and cancelled** count completed forwarding
  tasks once each. A success requires a complete valid upstream response.
  Malformed requests refused before forwarding do not increment these outcomes.
  Admission rejections count connections, separately from forwarded requests

These gauges are not agent counts or GPU utilization. In particular, subtracting
active requests from admitted connections does not give the queue length.
Timeout/cancellation labels describe the forwarding task's observed result, not
necessarily the HTTP status seen by its caller. Legacy disconnected callers may
retain work until the existing deadline or completion. Prompt trials opt in to
withdrawal on an observed disconnect; their own cleanup can finish before the
gateway notices and drains that forward. An upstream model may keep computing
after either form of cancellation.

Counters belong to one gateway instance and reset when it is replaced. Each
independent backend process has its own owner and budgets. A process using an
inherited gateway cannot inspect that owner's counters here; its values stay
unavailable rather than showing zero. During startup/shutdown, a busy owner can
appear as transitioning. A refresh does not wait for that lifecycle operation.

Loaded configuration and an existing gateway's actual limits are displayed
separately. Editing `.env` does not reconfigure a running instance; restart the
backend after a deliberate configuration change. The configured context limit
is an application budget, not proof of the model server's context capacity.
Validation covers the displayed local settings, not every application setting or
startup requirement. Issues are field/code labels, never raw configuration exceptions.
Cloud mode shows that local monitoring is inapplicable and omits cloud settings.

**Download observation JSON** saves the accepted, dated observation displayed by
the page as `mirofish-local-runtime-status.json`. It makes no second status
request. Refreshing or a refresh failure disables download until a new
observation is accepted; a previous observation retained after failure is marked
stale. The response and download use fixed field lists. They exclude API keys,
graph authentication, inherited gateway addresses, local paths and request or
response content. This is an observation, not continuous telemetry or a permanent
history. The read-only endpoint is `GET /api/runtime/status` with no query
parameters and `Cache-Control: no-store`.

The monitor checks MiroFish's configured loopback boundary; it cannot establish
whether an arbitrary model server delegates work remotely. Keep the model
server's own local-only settings described below. Local tests use synthetic
loopback traffic, real Flask/Axios and compiled Vue views. They do not establish
model quality, GPU performance, native browser layout or Windows behavior.

## Check local setup in the app

Open **Runtime monitor** and use **Run local setup check**. Opening the page or
refreshing either observation does not start diagnostics. This explicit action
checks the currently loaded configuration and installed dependencies, performs a
read-only Neo4j `RETURN 1`, and sends four small synthetic requests through the
same inference gateway used by simulations: JSON output, JSON-schema output,
tool-call formatting, and an embedding with the configured dimensions. The tool
call is inspected as data; no tool is executed.

The check can start the backend's shared gateway and cause an already-installed
model to load and use local CPU/GPU resources. It does not install models,
construct graph memory, add graph data, change settings, or close the shared
gateway. There is one active check per backend process, with no queue of checks.
The page shows each step and retains the latest result until another check
starts or the backend restarts. Cloud mode disables this feature.

**Stop remaining checks** prevents later probes from starting. An active probe
keeps its existing deadline, then the check closes only its own database and
HTTP clients. The page can therefore show **Stopping** before **Cancelled**.
Leaving the page cancels browser observation, while the bounded backend check
continues. Neither browser cancellation nor a transport timeout proves that an
upstream model server has stopped computing. A lost Start response is reconciled
by reading the current check, without automatically submitting another Start.

The default overall probe budget is five minutes: each model probe has at most
60 seconds, the database step 10 seconds, and gateway health five seconds. An
individual probe also uses the remaining overall budget. Owned-client cleanup
has a separate allowance of up to 10 seconds. These are cooperative application
deadlines, with ordinary scheduling and cleanup overhead, not a hard real-time
execution guarantee. A busy shared inference queue consumes the same probe
budget. The gateway's own configured deadline remains an upper limit.

The check requires the gateway's shorter-deadline capability marker. An inherited
older gateway is reported as unsupported before model probes; restart/update its
owning backend. The cap becomes knowable only after complete HTTP headers; an
already-expired cap is then rejected before the body is read or forwarded.
Malformed, duplicated, or lengthening timeout values cannot expand the gateway's
configured request lifetime. The timeout header is never sent upstream.

A passed result means these synthetic capabilities worked at the recorded time.
It does not establish model quality, GPU capacity, useful simulation output, or
that every future prompt/schema will work. Database failure can coexist with
successful model checks, and one failed model capability does not suppress all
remaining diagnostics. A timeout is distinct from an unsupported response.
If owned-client cleanup cannot be confirmed, further checks are disabled until
the backend restarts, avoiding repeated unconfirmed resource ownership.

**Download check JSON** saves the accepted terminal result as
`local_readiness_check.json`, without rerunning a probe. It includes fixed step
states/codes, dates, budgets, and sanitized model names/dimensions. It excludes
model prompts/responses, vectors, API keys, database credentials/name, local
paths, raw exception text, and package/model inventories. Keep the model
server's own local-only settings below: loopback transport alone cannot prove
that an arbitrary server never delegates inference elsewhere.

The HTTP boundary is `GET /api/runtime/readiness`, `POST` to the same path to
start, and `POST /api/runtime/readiness/<run_id>/cancel` to stop remaining checks.
Both actions require an empty JSON object. These endpoints reject query
parameters, caller-supplied prompts/settings/budgets, and noncanonical run IDs,
and send `Cache-Control: no-store`. This is the existing single-user local app,
not a multi-user authentication or remote administration interface.

Local verification uses actual async SDK requests through the gateway with
synthetic loopback responses, a disposable Neo4j database, and actual
Flask/Axios/compiled-Vue interactions. It does not use pretrained model weights,
user documents, paid services, or hosted tests. Native browser layout and Windows
behavior remain unverified.

## Try prompts with your local model

Open **Local prompt trials** from Home or Runtime monitor. This workspace lets
you try short prompts against the backend's configured chat model before building
a graph or running a simulation. Opening or refreshing it only observes the
latest trial; inference starts only when you explicitly choose **Run trial**.

1. Give the trial a label, enter an optional system prompt and a required user
   prompt, then choose a temperature and requested output-token limit.
2. Run the trial and inspect the exact returned text, finish reason, available
   server-reported token counts and observed duration. A provider's length cutoff
   is labeled truncated. An actual empty reply differs from unavailable output;
   model failures, timeouts, refusals and unsupported replies remain explicit.
3. Pin terminal observations while you iterate, then choose two pinned trials to
   compare side by side. Reuse a captured prompt/settings explicitly when useful.
   Reusing a prompt does not itself run it.
4. Download captured trial data before leaving. Downloads include your prompts
   and model replies. They use the already accepted snapshots and do not make
   another inference request.

Pinned trials exist only in the open page's memory, with at most ten retained
snapshots. They remain downloadable if a later request fails or the backend
becomes unavailable. Navigation, reload or closing the page loses them. The backend holds
only its latest trial until another replaces it or the backend restarts. This is
not a persistent experiment library. Downloaded individual and comparison files
can be reopened explicitly using the historical import workflow below.

The captured model name and reasoning policy describe the loaded configuration;
they do not verify particular weight files. Temperature and output tokens are
requested settings, which a model server may handle differently. Reported token
counts are optional provider observations, not independently counted tokens.
Request duration includes shared-queue waiting and transport; overall elapsed
time also includes startup and cleanup. Comparing one or two replies does not
establish model quality, statistical significance or GPU performance.

The page accepts a label up to 80 characters, system text up to 1,000 and user
text up to 4,000. Temperature must be between 0 and 1, and requested output tokens
between 1 and 512, further constrained by the loaded local budget. The gateway's
existing input/context and concurrency limits still apply. One backend process
admits one trial at a time, with no queue of trials; simulations and setup checks
continue to share the same inference gateway budget.

Loaded application budgets require a positive `LOCAL_MAX_QUEUE`. Prompt-trial
status and admission enforce that same bound: an invalid queue setting reports
`invalid_configuration` and refuses a new trial before scheduling its worker.
This is a configuration check, not a model or gateway readiness probe. The normal
backend entry point also validates the configuration before serving requests.

Gateway startup has up to five seconds and the completion request up to sixty,
within an overall sixty-five-second operation budget. Owned-client cleanup has
a separate allowance of ten seconds plus bounded drain overhead. These are
cooperative application deadlines, not a guarantee that a model server or GPU
stops computing. The explicit stop action below applies only to the selected
trial request. Leaving the page stops observation, while an accepted backend request
may continue. A lost Start response is reconciled using its exact request ID,
without automatically repeating inference. If that result has been replaced or
the backend has restarted, it may be unavailable.
An authoritative admission refusal leaves the draft intact for an explicit
refresh before another attempt. For an unresolved lost response, **Release this
observation** clears only the page's observation and reads the latest status;
it does not cancel earlier work or submit another trial. A new inference request
still requires an explicit **Run trial**.

Responses are limited to 64 KiB and accepted reply/refusal text to 16,384
characters. Oversized or malformed output fails explicitly rather than being
silently shortened by the app. Embedded reasoning wrappers remain literal text;
the workbench does not strip them, render generated HTML, execute returned tools
or make a follow-up model call. It never connects to Neo4j, installs a model,
changes settings or selects another model/endpoint. Keep the model server's own
local-only configuration: loopback transport alone cannot prove that a server
does not delegate inference remotely.

The trial page uses the local UI's `/api` proxy. The normal `npm run dev:local`
setup provides this; a separately served production build needs an equivalent
same-origin proxy. Existing API clients retain their configured routing. Trial
endpoints reject ordinary cross-site browser requests and exclude prompt bodies
from the app's request-body logger. Responses are `no-store`, with fixed fields
and safe errors. This protects the scoped browser workflow; it is not
authentication against other native processes on the same computer or a
multi-user remote service. Cloud mode does not expose trial results or run them.

Local verification uses actual Flask, the shared gateway and synthetic loopback
model responses, plus compiled Vue and real Axios requests. It covers request
ownership, lost replies, literal results and exact snapshot downloads. The Vite
proxy's forwarding of supplied Origin/Fetch Metadata is also checked. No real
model weights or GPU, private documents, paid service, hosted test, native
browser-generated headers or Windows behavior is established by these tests.

### Stop waiting for a trial

A confirmed live running result offers **Stop waiting for this trial**. This can
target the current observation after returning to the page, and may affect a
request being observed by another tab or a suite. Historical pins, imported
files and an unconfirmed Start reply cannot establish a cancellable live run.
A lost Start reply must first be reconciled using its exact request ID.

The action captures the request ID, input fingerprint and server-issued instance
ID. An old control cannot switch to a replacement run, even if it reuses the same
request ID and inputs. The first outcome decision wins: a completed or already
decided result stays unchanged. An accepted stop records `user_cancelled` and
stays **Running** while owned cleanup and drain finish. A late model response
cannot replace that decision. Cleanup failure remains a failure and quarantines
the trial runner until the backend restarts.

If the Stop reply is lost, the page reconciles only the exact captured run with
GET requests; it does not repeat Stop or Start automatically. A running result
without the cancellation marker is still unconfirmed. A replaced result or an
unavailable read stays uncertain rather than adopting the latest run. Leaving
the page stops observation only. Starting another trial requires an explicit
**Run trial** after the previous cleanup and worker exit permit admission.

Trial requests opt in to withdrawal from the inference gateway when it observes
their HTTP connection closing. A queued forward is removed when cancellation
wins before dispatch; an active upstream HTTP operation is cooperatively closed.
The model server may continue computing, and an undetected connection failure
can retain work until the original deadline. Trial cleanup may finish before
the gateway notices and drains its forward. This action does not stop or unload
the model server, or promise immediate gateway or GPU capacity.

A cancelled suite case stops further cases, leaves them unattempted, and marks
its checks as not evaluated. A completion that wins the race can still allow the
suite to continue. Use **Stop scheduling** to stop future cases separately.
Cancelled observations can be pinned, downloaded, reopened and reused as inputs.
Older schema-1 files without an instance ID still open, but cannot establish a
live cancellable instance. Older clients that do not recognize `user_cancelled`
cannot open the new cancelled records.

Upgrade the backend, gateway and frontend together. Trials require the gateway's
advertised disconnect-cancellation capability before dispatching a model request;
an older inherited gateway fails explicitly and its owner must be restarted.
The opt-in header is consumed by the gateway and never forwarded to the model.
It is accepted only for chat-completion POSTs. For opted-in requests, closing the
write half of the socket after the request body also means abandonment; legacy
SDK requests without the header retain their previous behavior. Each opted-in
handler retains admission until its actual forwarding task settles or the
original deadline expires, including cancellation before the task first runs.

Local tests cover real sockets for queued and active cancellation, half-close,
cleanup, deadlines and shutdown, plus instance ownership through Flask and
compiled Vue/Axios. Linked tests exercise a lost successful Stop reply, export
and reopen, and a later explicit request. These checks do not establish real
model/GPU cancellation latency, native browser behavior or Windows networking.

### Reopen saved trial files

In **Local prompt trials**, select a downloaded individual trial JSON or a
two-trial comparison JSON. Review the filename, recorded observation and full
captured details, then explicitly add the imported trials to pins. Selecting a
file only previews it. You can compare imported trials with one another or with
a newly pinned observation and download the existing comparison format again.

All imported entries are labeled historical file data. Recorded model names,
request IDs, fingerprints, timing and token usage are not authenticated by this
check. Their captured availability and resource limits do not describe the
current backend. Imports never restore live request ownership, poll an old ID,
select a model, or start inference. Opening the page still performs its existing
passive status read; file review remains available if that read fails.

**Reuse prompt and settings** copies only the captured inputs/settings into the editor.
A later explicit **Run trial** uses a fresh request ID and checks current backend
readiness and output-token limits. Changing model weights or configuration
remains a separate local setup action. Importing a file claiming an available
backend cannot make Run available while the current backend is unavailable.

Files are limited to **512 KiB UTF-8** before and after reading, with a JSON depth
limit of 10. Supported files are the existing schema-v1 individual snapshot or
an exact schema-v1 comparison wrapper containing two distinct trial IDs. Each
trial must have a valid terminal observation: succeeded, truncated, refused,
failed, timed out or cancelled. Historical unavailable/cleanup-failed captures
remain reviewable. Running/empty observations, cloud records, API envelopes,
suite reports, malformed UTF-8, BOMs, duplicate decoded keys, nonfinite numbers
and invalid Unicode are refused. Unknown snapshot fields are discarded by the
same fixed-field admission used for live observations; endpoints and raw errors
are never imported.

Imported and live pins share the existing ten-entry limit. Adding a file is
atomic: if any imported ID is already pinned or the whole file would exceed the
limit, none of its entries are added and existing pins stay intact. Remove an
existing pin explicitly before replacing an observation with the same ID. A new
file selection, **Discard preview** or navigation retires earlier file reads and previews.
Invalid files leave the draft, pins and live observation unchanged. Pins still
last only in the open page; download them before navigation or reload. No
automatic browser storage or backend archive is introduced.

Local tests cover strict file boundaries, both languages, literal replies,
atomic pin admission and stale callbacks. Actual Flask/Vite/gateway/Axios/Vue
tests download real synthetic trial observations, reopen their comparison in a
fresh view, compare/export while offline, and explicitly run reused inputs with
a fresh ID. No real model weights, inference quality, native browser file or
download dialogs, or Windows behavior are established by these checks.

### Build a suite from pinned trials

Use the separate suite builder in **Local prompt trials** to turn experiments
you want to repeat into a reusable definition. It accepts both newly pinned
observations and explicitly imported historical pins.

1. Enter a suite name and select one to five pins in the builder. This selection
   is separate from the two-pin comparison selection. Cases follow the displayed
   pin order, regardless of the order in which you checked them
2. Choose **Build suite definition** and inspect each captured label, full system
   and user prompt, temperature and requested output-token limit
3. Download the definition, open **Prompt suites**, import and explicitly adopt
   it, then edit any checks you need. **Run selected cases once** remains a separate
   explicit action that checks current backend readiness and output-token caps

The definition copies exact admitted inputs/settings. It does not include model
configuration, historical replies, outcomes, request IDs or imported filenames.
Every case starts with its check disabled (`expected_text: null`); a model's
recorded reply never silently becomes an expected answer. Failed or truncated
terminal trials can still supply valid inputs for another experiment. The
configured model for the later run is determined by the current local backend,
not by a historical pin.

Each Build assigns fresh, distinct case IDs and freezes the captured definition.
Repeated downloads preserve those IDs and bytes. Rebuilding explicitly creates
new IDs, so reuse the same definition when you want report comparison to match
the same cases across runs. Changing the suite name or selected pins retires the
old preview/download; removing or replacing a selected pin cannot keep a stale
selection. Adding or removing an unrelated pin does not rewrite a built result.

Building and downloading make no runtime requests and remain available if the
current backend observation is stale or unavailable. They do not start inference,
restore an old request, select a model or save an archive. The existing v1 suite
schema, trial input bounds and **128 KiB UTF-8 definition limit** apply; invalid
selections fail together without truncation or a partial definition. The file
contains selected prompts and settings. It is kept only in page memory until
you download it; leaving or reloading discards the builder.

Local tests cover the pure conversion, literal previews, both languages, separate
selection ownership, stale controls and download cleanup. Actual Flask, Vite,
gateway, Axios and compiled Vue tests create trials, build/download a definition,
import it through the existing suite editor and explicitly run it with new
request IDs. Historical-import and offline-download paths are covered too. No
real weights, model quality, native browser/file-picker behavior or Windows
behavior is established by these checks.

## Run repeatable prompt suites

Open **Prompt suites** from Home, Runtime monitor or Local prompt trials. Define
a small set of repeatable cases for the configured local model, run them once in
order, and inspect each exact reply. The suite uses the same bounded trial API
and shared inference gateway as the single-prompt workbench.

1. Name the suite and add one to five cases. Each case has a label, optional
   system prompt, required user prompt, temperature and output-token request
2. Optionally enable a check and choose **Exact text**, **JSON object** or
   **JSON fields**.
   Exact text is case-sensitive and preserves whitespace, line endings,
   reasoning wrappers and empty strings. An enabled blank exact expectation
   explicitly expects an empty reply. JSON object checks whether the entire
   reply is a directly parseable object; it needs no expected text. JSON fields
   also requires named top-level properties with their chosen JSON types. Leaving
   the check disabled means no automated comparison
3. Choose **Run selected cases once**. The page freezes the included cases and runs them
   sequentially. A successful reply that fails its selected check is an ordinary
   mismatch, so the next case still runs
4. Inspect the captured outcomes and download the run report. Change the draft
   and explicitly run again when ready; the new run replaces the displayed
   report only after its readiness check succeeds

Use **Duplicate case** to make a prompt variant beside its source, then edit the
copy. The label, exact system/user prompts, settings and selected checks are
copied, including enabled empty-text expectations and JSON-field rules. The copy
gets a fresh case ID and independent rule rows. Its label is initially unchanged;
rename it when that helps distinguish the variant. Incomplete draft fields can
be copied, but the existing validation still controls export and Run. A suite
still has at most five cases; a failed ID allocation leaves the draft unchanged.

Use **Move up** or **Move down** to choose the next run's case order. Moving keeps
the case's existing ID and contents, while a duplicate is a new case for report
comparison. Repeated definition downloads keep those IDs and the selected order.
All three controls edit only the draft and remain useful while the backend is
unavailable. They perform no readiness read or inference request. Editing during
a running or paused suite does not change its captured definition or scheduled
cases; Resume continues that original run. Export the edited definition or
choose a later explicit Run to use the changes. As with the rest of the draft,
navigation/reload loses unsaved edits.

Use **Include in next run** to choose a smaller experiment without deleting other
draft cases. Initial, imported, newly added and duplicated cases start included.
Moving a case preserves its membership; removing it removes that membership.
The selected/total count describes the next run, not an already captured run.
At least one case must be included. The suite name and included cases must pass
the existing definition checks, and included output requests must fit the
current backend budget. Incomplete or over-budget excluded cases do not block a
valid selection. The five-case limit still applies to the entire draft.

**Download selected definition** saves only the included cases, in their current
order, as `local_prompt_suite_selection.json`. It keeps their exact IDs, inputs,
checks and schema version and uses the ordinary definition format. It makes no
runtime request and remains available offline when the selected definition is
valid. **Download full definition** still includes every draft case and
requires the whole draft to be valid. A run report contains only the captured
selection; excluded draft cases are absent, not recorded as failed or unattempted.
Report comparison shows a case present on only one side as added/removed and
does not produce a paired finding for it. Review which file you export: the full
definition includes excluded prompts.

Selection is kept only in the open page. Importing either definition file starts
with every imported case included; the file has no selection flags. An invalid
or discarded import preview leaves the current selection alone. Changing
checkboxes does not make a model/readiness request, stop scheduling, or change a
running or paused capture. Resume continues its original selected cases, even if
the future draft currently has none included. Use the existing Stop scheduling
control to prevent further cases in that captured run.

The selected definition is validated before the first model request, including each
case's requested output tokens against the observed local cap. Opening the page
and Refresh only read status. A running trial in this or another tab prevents
admission. Between cases the controller waits one normal polling interval and
checks latest status again. A race with another caller, or a backend worker that
has not finished exiting, can still reject admission; that halts the suite
without retrying the POST.

Only a confirmed successful reply receives its selected check. Refusal,
truncation, timeout, runtime failure or an unknown result halts later selected cases,
which remain **not attempted**. Those outcomes are not counted as mismatches or
successful checks. A lost Start response is reconciled by its exact request ID,
with no repeated inference request. If observation then fails, explicit
reconciliation may fill in the last result, but does not resume remaining cases.
Another run always requires another explicit action and a new readiness check.

**Stop scheduling** prevents any further case from starting. It does not cancel
an accepted backend request; the page may continue observing that case until its
result is available. Leaving the page retires its requests, timers and queued
continuations, while accepted backend computation may continue. The existing
per-case startup, request and cleanup budgets still apply; a five-case sequence
can take several minutes. Cases share the gateway budget with simulations and
setup checks, and are never submitted in parallel by this controller.

Use **Download full definition** to keep every draft case's exact inputs and expectations. To
reuse one, select its JSON file, review the validated preview, then explicitly
apply the imported definition. Importing never runs it. Invalid, oversized or
unsupported files leave the current draft intact. Definitions have a fixed
versioned schema, one to five unique case IDs and a 128 KiB UTF-8 file limit;
duplicate object keys, unknown fields, endpoints, model overrides and captured
result files are refused by the definition input. Use the separate saved-run
reuse input described below for a captured run report. Existing trial text/settings bounds apply, suite names
use up to 80 characters, and an enabled expected reply has up to 500 characters.

Definitions and reports from version 1 remain supported and retain their v1
shape when imported, exported or run. Choosing JSON object in the editor
explicitly promotes that draft to version 2, preserving its case IDs, inputs and
other expectations. Each v2 case has `check_kind` (`none`, `exact_text` or
`json_object`) and `expected_text`: a string for exact checks, null otherwise.
Switching modes later does not downgrade the draft. Its captured run report uses
the same version. Imported check outcomes are recomputed from captured replies;
a report whose claimed outcome disagrees is rejected.

**JSON object** accepts `{}`, nested objects/arrays and surrounding JSON
whitespace. Property order and whitespace do not affect validity. It rejects
top-level arrays, primitives or null, Markdown fences, reasoning wrappers,
trailing prose, duplicate decoded keys (including escaped aliases), malformed
syntax, nonfinite parsed numbers such as `1e400`, and decoded unpaired surrogate
characters in keys or values. The whole reply is limited to 64 KiB UTF-8 and
value depth 16, with the root at depth 0. It never repairs or rewrites the
captured reply. These are bounded format checks, not required-field/schema
validation, numeric-precision checks or judgments of the answer's meaning.
The check runs locally on the captured text; it does not add JSON mode, tool
calls or provider-specific response-format settings to the model request.

The separate **run report** contains the captured definition, per-case request
identities, accepted trial observations, selected check outcomes and unattempted
cases. It is limited to 1 MiB UTF-8 and records historical observations. The
separate reuse action below copies its definition without resuming its requests.
Downloads use captured page memory and remain available after a later status
failure. Draft edits and imports do not rewrite the existing report. These files
contain your prompts, expectations and model replies; choose their destination
accordingly. There is no automatic browser storage or backend suite archive.
Reloading, navigation or closing the page loses its in-memory suite observation.

Exact reply checks are simple literal comparisons. JSON object checks test object
format; JSON fields additionally tests the explicitly named top-level types.
Neither judges semantic
correctness, model quality, statistical significance, speed on your GPU or
whether the model server honored every requested setting. Each trial retains
its observed configured model name and provider-reported usage separately; those
labels do not authenticate particular weights. Keep the model server itself
configured for local inference, as described above.

Local verification exercises the actual Flask API, Vite proxy, shared gateway,
Axios client and compiled Vue route with synthetic loopback replies. It checks
sequential call counts, exact/JSON-format/required-field matches and mismatches, empty replies,
truncation, lost responses, explicit reconciliation, Stop, navigation and captured
exports. Pure contract tests also cover strict imports, JSON byte/depth/Unicode
boundaries, mixed-version compatibility and bounded polling. Saved-run reuse is
also exercised by reopening the actual editor, adopting an exported run's cases,
explicitly running them with new execution IDs and comparing the two reports.
Case-organization tests cover both languages, exact copies across all three
schemas, independent check rules, capacity/boundary controls and retired event
handlers. The linked workflow exports an edited definition, imports it into a
fresh editor and runs its selected order, then confirms that draft edits during
Pause do not change the captured run resumed afterward.
Selection tests cover full/subset validation and exports, numeric budget checks,
membership through case editing/imports, and retired handlers in both languages.
The linked API workflow excludes an incomplete over-budget draft case, runs only
two chosen cases in their selected order, changes future membership during Pause,
and confirms the captured run and exported subset remain unchanged.
No real model
weights, GPU quality/performance, native browser rendering/headers or Windows
behavior is established by these tests.

### Pause and resume suite scheduling

During a captured run, choose **Pause scheduling** to hold future cases. If a
case is already accepted or its Start response is uncertain, the page continues
its existing exact-request observation until the outcome is known. The display
distinguishes a pending pause from **Paused**. A failed, refused, truncated or
unknown case still halts the suite; a successful final case completes normally.

Once paused, this controller has no polling or scheduling timer and issues no
trial requests. **Resume scheduling** waits the normal between-case interval,
then checks current backend availability and all captured output-token limits
before submitting the next unattempted case. A failed readiness check leaves the
suite paused with an error so you can retry Resume explicitly. A changed cap may
require **Stop scheduling** and a new suite with smaller requests.

Resume retains the same run, case order, prompts, checks and preallocated request
identities. Editing or importing another draft while paused does not change those
captured cases. New Run and Refresh remain disabled while the suite is paused;
Stop stays available and permanently ends its remaining scheduling. Repeated or
retired controls cannot launch another copy of a case. Stop also remains available
during a new run's initial readiness checks. Its control belongs to that attempt;
a retired control from an earlier run cannot stop a later one.

Pause does not cancel an accepted inference, unload the model or suspend work
started elsewhere. Leaving or reloading the page discards its ability to resume.
Downloaded run reports keep their existing v1/v2/v3 format: a paused capture is
an unfinished `running` observation with no finish time and remaining cases
marked `not_attempted`. These files contain no restart checkpoint; reopening a
report for comparison or case reuse does not resume its execution.

Local tests cover pending admission and observation, readiness races, exact-ID
reconciliation, paused exports, retry, Stop, disposal and stale controls. Deliberate
replays of retained Stop handlers verify ownership across later runs; they do not
establish a normal browser click sequence that triggers the old behavior. Actual
Flask, Vite, gateway, Axios and compiled Vue tests count synthetic local model
requests through pause/resume and verify that later draft edits never change the
captured run. No real weights, GPU performance, native browser or Windows behavior
is established by these checks.

### Require JSON fields

Choose **JSON fields** to check whether a local model's reply contains the
structured information your next step needs. Add one to ten required top-level
field names and choose a JSON type for each: string, number, boolean, object,
array or null. New rows begin blank; complete them before Run or definition
export becomes available. For example, requiring `answer` as string and `ok`
as boolean accepts `{"answer":"yes","ok":true}` and rejects a missing `ok`
or the string `"true"`. Additional properties are allowed.

The entire reply must first pass the same bounded, strict JSON-object check
described above. Each required property must be present on that object. A required
null means an explicitly present null value, not an absent key. False, zero and
empty strings retain their own types. Object excludes arrays and null; object
and array requirements do not constrain their contents. There are no nested
paths, full schema rules, integer subtype, range checks, regexes or semantic
judgments. Number means a finite parsed JSON number and retains JavaScript
numeric precision limits; this does not verify the original number token exactly.

Names contain 1–80 Unicode codepoints, must not be all whitespace, and use the
existing plain-name rule excluding Unicode category C: controls, format marks,
surrogates, private-use and unassigned characters. Accepted case, Unicode and
outer spaces remain exact; names are shown quoted so spaces are visible. Dots,
brackets and names such as `__proto__` are literal property names, not paths or
object behavior. Duplicate decoded names are refused. A rule for `a.b` requires
that literal top-level key, not a nested `b` inside `a`.

Choosing JSON fields explicitly promotes the draft to version 3, preserving its
case IDs, inputs and prior checks. Each v3 case has `required_fields`: an ordered
array of `{name,type}` for `json_fields`, or null for every other kind. JSON fields
uses `expected_text: null`. Switching modes clears inapplicable rule data and
does not downgrade the draft. Versions 1 and 2 remain supported with their
existing shapes and exported bytes. Choosing only JSON object in a v1 draft
still promotes it to v2.

Captured definitions clone and freeze their rule data. Later editor changes do
not change an active run, captured report or imported preview. Rule checks run
only on a confirmed successful response; a mismatch continues to the next case,
while truncation and other runtime failures retain the existing halt behavior.
Imported reports recompute these checks from captured replies and reject a
contradictory claimed outcome. Importing a saved run preserves all captured rules
and case IDs without restoring its execution state.

These checks run locally after the reply. They do not insert requirements into
the prompt or enable a model response-format option. Include the desired output
in your own prompt, then use the checks to compare observed results. Local tests
exercise all six types, literal/prototype-like names, strict reply boundaries,
nested capture isolation, stale rule handlers, both languages and actual
Flask/Vite/gateway run → export → reuse → fresh run → offline comparison.

### Reuse cases from a saved run

In **Prompt suites**, choose the separate **Import saved run report** file input when
you have a captured run JSON rather than a standalone definition. Review the
historical run ID, recorded status/times, attempted count and every captured case,
including its **Recorded outcome** and **Recorded check**. All cases start
selected. Keep them all and choose **Use captured cases as draft**, or choose a
subset and use **Use selected cases as draft**. Selecting the file or changing
preview checkboxes changes neither the draft nor the current run.

**Select cases needing attention** selects recorded check mismatches and any case
without a confirmed successful outcome, including failures, refusals, truncation,
cancellation, unknown results and cases not yet attempted. Successful unchecked
replies are not selected by this shortcut. The actual recorded labels remain
visible: an unconfirmed or unattempted case is not relabeled as a failed check.
The shortcut is a convenience for retesting, not a judgment of answer quality.
Review the selected/total count and adjust individual checkboxes as needed.
If no cases qualify, the selection is empty and Apply is disabled; **Select all**
restores the full selection. At least one case must be selected.

The action copies only the selected original cases, in their captured order:
suite name, case IDs, exact prompts, settings, check kinds, expectations and any
required-field rules are preserved. It keeps the original v1/v2/v3 schema even
when the subset no longer uses a newer check kind. Every copied case starts
included in the editor. Unselected cases stay in the source report but are absent
from this new draft and its definition download. You can edit or remove copied
cases and download an ordinary definition. Keeping case IDs lets later report
comparison match the same cases across experiments; absent cases are shown as
added or removed, rather than paired failures.

Historical results, request identities, running state, reconciliation ownership
and model configuration are never restored into the current controller. A source
file labeled running, stopped or halted is a historical observation; importing it
does not read those old requests or resume them. The current page's captured run,
including an active or unresolved run, stays untouched. A later **Run selected cases once**
explicitly starts the chosen draft from its first case, checks current readiness
and token caps, uses the currently configured model and generates new run/request
IDs. A historical report does not establish that the present server is ready.

Run files are limited to 1 MiB before and after reading, require valid UTF-8, and
use the supported v1/v2/v3 report admission. Duplicate keys, excessive nesting,
invalid identities, contradictory check outcomes, BOMs and unsupported file kinds
are refused before any cases are copied. The whole report must pass admission,
including cases you would leave unselected. A valid definition embedded in an
invalid report is not extracted. The original definition input keeps its separate
128 KiB limit and contract and has no outcome-based preview controls.

Both file inputs share one preview. Selecting another file retires the earlier
read and preview; Discard, failed reads and invalid files leave the draft and
current run intact. Preview and adoption make no runtime requests. Opening the
page still performs its existing passive readiness read, and starting a new run
still requires an explicit action. Navigation retires pending file work. Nothing
is saved to browser storage or a backend archive.

Local tests cover every admitted recorded outcome, all three schemas, both
languages, empty selection, exact subset exports and stale preview/Apply controls.
The linked Flask, gateway, Axios and compiled-Vue workflow checks that importing
and selecting historical cases leaves a paused run unchanged, then explicitly
executes only the adopted subset with new request identities. Synthetic local
responses verify that workflow; native browser behavior and real-model quality
remain unverified.

## Prepare reviewed prompt examples

Open **Reviewed examples** from Prompt suites or Compare run reports
(`/prompt-examples`). This separate offline page helps turn a few captured
prompts into explicitly reviewed examples for later local-model experiments.
It reads one downloaded v1/v2/v3 suite-run report using the existing strict
1 MiB importer. It does not query runtime status, run inference, start training,
download weights, or write a backend archive.

1. Select a saved run, inspect its preview, then explicitly use it. Import alone
   does not replace the accepted work. A failed or canceled replacement keeps
   that work with a visible notice
2. Review each case's exact system/user prompts, recorded outcome, reply and
   original check. Every assistant target starts empty and unapproved. For a
   succeeded source, **Copy recorded reply** fills only the draft; you can also
   write a corrected target. Other outcomes, including unattempted cases, accept
   manually authored targets while keeping their source outcome visible
3. Choose **Approve this target for export** for each desired case. Editing or
   copying a target retires its approval and any built bundle. Approval means
   inclusion of that exact target, not certification that it is correct
4. Build one to five approved examples, inspect the captured result, and download
   its messages JSONL and review JSON. Both downloads use the same captured
   selection and time. Removing approval or replacing the accepted source
   requires building again

Targets must be nonblank before approval. Target text uses at most 16,384
Unicode codepoints and 64 KiB UTF-8, and contains no control or surrogate
characters except CR, LF and tab. Empty and whitespace-only targets can be saved
in a curation draft without being eligible for approval. Accepted
prompts and targets remain exact: whitespace, Unicode, tags and reasoning
wrappers are not trimmed or rewritten. A succeeded response can still be empty,
contain unsupported controls, or be incorrect; it must become a valid reviewed
target before inclusion.

The **Recorded reply check** remains historical. The target's check is computed
separately against the original case's exact-text/JSON requirements. A target
that does not match those requirements can still be explicitly approved. These
bounded checks do not judge meaning. Equality with a recorded reply is available
only when that source succeeded; otherwise it is inapplicable. Repeated content
under different case IDs is retained, not silently deduplicated. Inspect repeated
prompts for duplicate or conflicting targets.

Each JSONL record contains only a `messages` array with an optional system message,
a user message and the approved assistant target. An exactly empty system prompt
is omitted, matching the real trial request; a whitespace-only system prompt is
preserved. Records follow source-case order, use LF separators and end with LF.
Labels, IDs, model names, generation settings and checks are not inserted into
the trainer messages. The companion review JSON contains selected cases only:
their source inputs and recorded observations, target messages/checks, review
times, original positions and JSONL line numbers. Deselected prompts and replies
are excluded. Recorded model labels and run identities are unauthenticated
historical claims.

The JSONL layout follows the conversational messages format documented by
[Hugging Face TRL](https://huggingface.co/docs/trl/dataset_formats). A particular
trainer and tokenizer still need their own compatible
[chat-template setup](https://huggingface.co/docs/trl/sft_trainer). No template
tokens or training configuration are supplied here, and five reviewed cases do
not establish training sufficiency, model improvement or consumer-GPU fit. Keep
training examples separate from independent held-out evaluation cases.

JSONL is limited to 1 MiB and review JSON to 4 MiB, refused rather than truncated.
The files include selected prompts, targets and, in the review file, recorded
replies; choose their destination accordingly. There is no automatic browser
storage or merge. Leaving or reloading the page loses its in-memory review;
download a curation draft first to recover its target text explicitly later.
A captured reviewed-example download remains byte-identical on repeated use,
and retired controls cannot export a replacement source or target.

Local verification covers all supported report versions, historical outcomes,
selection identity, target boundaries, immutable capture, both languages and
production-cached Vue handlers. Actual Flask/Vite/gateway/Axios suite runs are
exported and reviewed with HTTP, fetch, sockets and runtime methods blocked during
the review stage. Downloaded records also pass a real installed Transformers
consumer with a synthetic local tokenizer/template. No pretrained-model template,
actual training, weights, GPU performance, native browser dialogs or Windows
behavior is established by these checks.

### Save and reopen a curation draft

Choose **Download curation draft** to save the current source and every target,
including targets that are empty, unfinished or unapproved. No approved examples
or built JSONL bundle are required. The file is `prompt_example_curation.draft.json`.
It captures the current text on that explicit click; later edits need another
download. It does not save anything to browser storage or a backend archive.

In a fresh session, use **Open curation draft**, inspect its preview and choose
**Use this draft**. The preview shows the recorded draft time, source and every
target as literal text. Reading or previewing a file does not replace accepted
work. A failed or canceled import retains the current targets, approvals and
reviewed bundle. Report and draft selections share the same import ownership:
a late file read or an old Use/Cancel button cannot replace a newer selection.

Using a draft restores all target text in original source-case order, but every
target is **unapproved** and no reviewed bundle is restored. Recheck each target,
choose **Approve this target for export**, then build/download the selected
examples as usual. Historical reply/check fields remain separate from the target
check. This is editable work recovery, not an imported approval or an inference
resume. It makes no runtime request, loads no model and starts no training.

A draft contains **the full imported source report and all target text**, including
source prompts/replies for cases omitted from selected JSONL/review exports.
Review its contents and choose its destination accordingly. The selected-example
review JSON remains selected-only; it is a different format and cannot be opened
as a curation draft. The original suite-run report input also remains separate.

The draft format is `schema_version: 1`, `kind: mirofish_prompt_example_draft`,
with `captured_at`, `source_report` and an ordered `targets` array containing
exactly `case_id` / `target_text` for every source case. It has no approval fields.
The file is bounded to 4 MiB of strict UTF-8 JSON and depth 14. The embedded source
is independently checked under the existing suite-report 1 MiB/depth-12 rules
before its known-field projection. Invalid source observations, duplicate or
escaped-alias keys, nonfinite numbers, lone surrogates, extra fields, reordered or
missing target IDs and oversized values are refused. Recognized source fields
and target strings are preserved; ignored snapshot fields are not carried forward.

Each draft target has the same text limits as an approvable target, except that
empty/whitespace text is allowed. There is no trimming, truncation or automatic
repair. Recorded historical replies retain their existing source rules, which
can allow controls that are unsuitable in an edited target. A failed draft
download keeps the current work for correction and an explicit retry. A cleanup
error can occur after a download starts, so check the download destination before
retrying. Retired source/row handlers cannot download replacement content. Cleanup
of temporary object URLs and anchors is attempted independently on every path.

Local tests execute the real compiled Vue view/router in both languages with
production handler caching. They cover strict file contracts, cross-kind import
races, fresh-session target recovery, reapproval, literal text and download
cleanup. The linked workflow captures real disposable local model replies, then
blocks network/runtime access before draft download, reopening and final JSONL
export. A local synthetic tokenizer checks those messages; this does not validate
native browser dialogs, Windows, actual training or model quality.

## Compare exported prompt-suite runs

From **Prompt suites**, open **Compare run reports** (`/prompt-suite-comparison`).
This separate page works with two exported run reports in browser memory. It
does not read runtime status, start inference, reconcile a request, or save an
archive. It can be used after changing a local model and repeating a saved suite.

1. Select a baseline run report and a comparison run report. Review each preview,
   then explicitly use it in its slot. Selecting a file alone does not replace
   an accepted report or run a comparison
2. Choose **Compare reports** to capture the selected pair. Inspect recorded
   outcomes, check transitions, replies, model settings and request timings
3. Download the captured JSON/TXT comparison. Clear or replace a slot, or swap
   the direction, before making another explicit comparison

Cases match only by their stable case ID. Added/removed cases and changed
prompts, settings or expectations remain visible. A paired finding requires
identical system/user prompts, temperature, output-token request, check kind,
expectation and required-field mapping,
two recorded successful outcomes, and request IDs absent from the opposite
report. Names and labels do
not substitute for identity; label changes are displayed separately. Different
run IDs are required. A shared case is flagged as an overlap if either of its
request IDs appears anywhere in the opposite report, including under a different
case ID, and is excluded from paired findings.
The order flag considers only shared cases; it does not call an insertion a move.

A check can be gained, lost or retained only when that pair has the same enabled
check, expectation and required-field mapping. A disabled check differs from expecting an empty reply.
Two valid JSON objects can both pass their format check while their literal
replies differ. A change between exact text, JSON object and JSON fields is a
changed input, so it does not produce a paired check finding. Older checks are
normalized internally for comparison with equivalent v2/v3 cases.
Unknown, running, rejected, not-attempted, truncated, refused and failed outcomes
are preserved, with unavailable findings shown as unavailable rather than zero.
The page does not infer coverage from the report's overall status: a halted run
may contain a later reconciled successful observation.

Request-duration differences are comparison minus baseline, only for eligible
pairs with two recorded durations. Zero is a valid duration; a missing duration
is not zero. Overall elapsed time is shown separately because it includes startup
and cleanup. Configurations are shown per case, with a warning for multiple
observed model/reasoning settings in one report. These are recorded configuration
labels, not authenticated weights or proof the server followed them. Hardware,
warm-up and other workload conditions are unknown. No pass rate, overall winner,
accuracy, throughput or statistically significant speed claim is produced.

Imports are limited to 1 MiB each and require valid UTF-8, supported v1/v2/v3 report
structure and identities. Duplicate keys, excessive nesting and malformed
captures are rejected before fixed-field projection. A failed or canceled
replacement retains the accepted historical slot and comparison. An accepted
replacement, Clear or Swap retires the old result. Navigation retires pending
reads and loses page memory; reports are not put in URLs or browser storage.

Each comparison export is limited to 4 MiB of UTF-8, refused rather than
truncated, and contains the two sanitized captures plus derived findings. TXT
uses fixed labels and quoted literal values, escaping control/format characters.
An export failure keeps the valid screen result. Downloading uses its captured
bytes and time; comparison bundles are reports, not supported import files.
The files contain prompts and replies, so choose their destination accordingly.
Comparing two v1 reports preserves the v1 comparison export. When the highest
input version is v2, the comparison is v2: rows use `check_transition` instead of
`exact_transition`, and `input_changes` includes `check_kind`. These versioned
exports retain the original accepted run reports.

If either input is v3, the comparison is v3 and also records
`input_changes.required_fields`. Adding, removing, renaming or changing a field's
type makes evaluation inputs different and excludes paired findings. Rule order
has no checking meaning, so reordering the same name/type mapping alone keeps
the pair eligible; the captured arrays retain their original order. Older checks
have no field requirements and can pair with equivalent v3 cases whose
`required_fields` is null. Both sides display their captured rules literally.

Local tests import actual suite exports generated through Flask, the shared
gateway, a synthetic loopback model, Axios and the compiled suite editor. The
comparison then runs with the proxy closed and HTTP/fetch/socket tripwires.
Additional compiled Vue tests cover both languages, partial results, invalid
files, stale file/action ownership and download cleanup. This validates the
scoped offline workflow, not an operating-system firewall, real model quality,
GPU performance, native browser dialogs/layout or Windows behavior.

## Explore latest saved activity

In History, open a saved simulation and choose **Saved activity**. The dedicated
route `/simulation/<id>/activity` reads its latest saved run without mounting the
execution screen, restarting a simulation, preparing an environment, querying
graphs or calling a model. The page is available in English and Chinese.

1. Browse recorded attempts, including unsuccessful attempts. Expand a row to
   read its parsed saved record as literal canonical JSON text. Unknown success
   stays unknown. A missing round uses the existing round-zero default; the JSON
   details preserve the original field's absence.
2. Enter a literal phrase to find saved content, optionally enable case-sensitive
   matching, and filter by the saved outcome: succeeded, failed or unknown. You
   can combine these with platform, round number, agent ID and exact action type.
   Apply the filters to read matching attempts. Round and agent zero are valid;
   repeated identical records remain separate attempts.
3. Choose a page size and use First, Previous and Next. Rows follow the saved
   file order: Twitter then Reddit, each in forward line order, or the legacy
   combined file's order. Recorded timestamps are labels, not a merged chronology.
4. Use **Download this page JSON** to save the exact displayed observation,
   including filters, page/count metadata, source revision, warnings and rows.
   It exports this page only, not every matching record. Numeric identifiers are
   decimal strings; original JSON details remain text to preserve large integers.

Phrase search checks individual decoded JSON string values, including nested
action arguments/results and any saved name, type or timestamp. It does not
search property names, numbers, booleans or null, or join separate values into a
phrase. A stored string that contains JSON stays text; it is not parsed again.
Punctuation is literal. The same row counts once even when the phrase
occurs repeatedly or in several fields. Modern logs may omit a platform string,
so use the platform filter to select a platform reliably.

By default search uses Unicode casefold substring matching: for example,
`STRASSE` matches `Straße`. There is no accent removal or Unicode normalization,
so differently normalized spellings may differ. Casefold expansions also permit
a partial match within one original character, such as `s` within `ß` → `ss`.
Case-sensitive mode searches the original text exactly. Nonblank phrases retain
their spaces and accept up to 200 Unicode code points, without control or line
separator characters. An empty search box leaves content unrestricted;
whitespace-only phrases are rejected.

Each content match shows an excerpt from its first matching saved string, in
parsed object/list traversal order. It preserves original characters and shows
at most 240 code points with up to 40 before the match. Long matches, including
casefold expansions, may extend beyond the excerpt; expand the saved JSON for
the full record. Excerpts are literal text, not rendered markup. Outcomes use
only the saved boolean `success` flag: `true` means succeeded, `false` means
failed, and absent/null/nonboolean values mean unknown. Some simulation writers
use the logger's default success flag, so these labels do not independently
verify whether an action executed successfully.

Applied filters, page and revision stay in the URL for reload and Back/Forward.
Editing filters retires earlier rows and export controls. Pages remain tied to
the observed files: if an append, replacement, removal or newly appearing source
changes them, the page asks for **Refresh**. Refresh reads current files from the
first page. A revision is an observation fingerprint, not a permanent run ID or
archive; restarting the same simulation can replace its files.

Availability is separate from the saved run status. Missing sources are
unavailable, while readable empty files can establish zero matches. Malformed
rows leave valid neighbors visible as partial observations. Counts describe valid
matching rows from admitted sources; a source refused for a limit or read failure
contributes neither rows nor pagination positions. Filtering an absent platform
does not invent a complete zero. Modern logs take precedence over legacy leftovers.
Saved active states return a conflict, and absent terminal evidence leaves action
observations unavailable. Saved status does not verify current process ownership.

The read-only API is `GET /api/simulation/<id>/saved-actions`, with optional
`platform`, `agent_id`, `round_num`, `action_type`, `q`, `case_sensitive`,
`outcome`, `offset`, `limit` and `revision`. Omit `q` for no content filter;
`case_sensitive` accepts only `true` or `false` and defaults to `false`.
`outcome` accepts `success`, `failed` or `unknown`, or can be omitted for any.
The echoed filters include the whole applied selection. Each row's
`match_preview` is null without a phrase and a bounded original-text excerpt
when the phrase matched; page downloads retain both the filters and excerpts.
Repeated/unknown/invalid parameters are errors. Page size is 1–100 (default 50),
offset is at most 500,000, decimal ID/round filters accept at most 64 digits, and an
action-type filter accepts at most 256 characters. Later pages require the accepted
revision. The existing live `/actions` endpoint retains its previous behavior.

The saved-reader file/path and log budgets described below also apply here.
Retained encoded action-page data is limited to 2 MiB and the JSON response to
4 MiB. An oversized response is refused rather than truncated; choose a smaller
page size, down to one, or narrow the filters. A single oversized record may
still be too large for this view. File fingerprints detect ordinary concurrent changes,
including changes during failed reads; they do not provide an atomic filesystem
snapshot or protection from hostile local filesystem mutation. Full configuration
and its credentials are excluded. Expanded records and downloads intentionally
contain the saved action payloads you chose to inspect.

Search scans the same bounded saved sources on each request; it does not build a
persistent index or call a model. Casefold/find avoids regex pattern evaluation,
and preview mapping is performed only for retained page rows. Large archives can
still take time to read. The local tests cover actual saved loggers, decoded
Unicode/casefold behavior, source refusal and revision conflicts, compiled Vue
controls and a real Flask/Axios/view/export workflow. They do not establish native
browser layout, Windows behavior or real-model quality.

Local tests cover actual log writers, file admission, filters, pagination,
revision conflicts and current-page exports. A loopback integration runs the real
Flask route, production Axios client and compiled Vue view, including a change
between pages followed by Refresh. The Vue test renderer exercises scripts,
templates and routing; native browser layout/download dialogs and Windows storage
behavior remain separate platform checks. No model weights or paid services are
used.

## Inspect activity by round

Open **Activity by round** from an accepted **Saved activity** result. The
dedicated `/simulation/<id>/activity/rounds` page groups the latest saved action
attempts by their recorded round, without mounting the execution screen or
calling models. It carries the selected platform and accepted source revision.
The overview covers all attempts within its own platform and round-range
selection; the record page's phrase, agent, action-type and outcome filters are
separate selections.

1. Choose both platforms or one platform, and optionally enter inclusive
   **From round** and **To round** bounds. Round zero is valid. Apply keeps the
   accepted revision; **Refresh** reads current files using the URL's applied
   filters and starts a new observation.
2. Read the observed attempt totals and saved succeeded, failed and unknown
   counts. Rounds appear in numeric ascending order, with 25 rows shown at a
   time. Table paging stays within the accepted overview and does not reread
   files. Only rounds containing matching admitted records appear; omitted
   rounds are not invented zeroes or proof that those rounds never ran.
3. Choose a positive total or outcome count to open the existing saved-record
   view with that exact round, platform, optional outcome and source revision.
   This is a path to the recorded evidence, not an explanation of why a count
   changed. If files change before drilldown, the record view asks for Refresh.
4. **Download overview JSON** exports all rows of the accepted overview,
   including filters, totals, coverage, warnings, saved context, observation time
   and revision. It is independent of the current local table page. Editing
   filters or leaving the view retires the old result and export controls.

Outcome counts use only the exact saved boolean success flag; missing, null or
nonboolean flags are unknown. They do not independently verify successful
execution. Duplicate records remain separate attempts, and a missing round keeps
the existing round-zero default. Partial observations contain only valid matching
records from admitted sources. Unavailable observations have unknown totals;
admitted empty sources can establish observed zero. Saved status does not verify
current process ownership, and source revisions are observation fingerprints,
not durable run IDs or an archive.

The read-only API is `GET /api/simulation/<id>/saved-action-rounds`, accepting only
single `platform`, `round_from`, `round_to` and `revision` values. Bounds accept
up to 64 ASCII decimal digits and are normalized as strings, with the lower bound
no greater than the upper. Stored rounds longer than 64 digits remain visible and
exportable, but their record links are disabled because the existing record
filter cannot represent them. Numeric ordering does not use JavaScript floating
point conversion. No agent lists, action-type dictionaries or raw action payloads
are added to this response.

An overview admits at most 1,000 distinct matching rounds and at most 1 MiB of
encoded response data. It refuses an oversized overview rather than silently
truncating it; narrow the round bounds for a smaller selection. Sparse large
round numbers consume one bucket each, without allocating intervening rounds.
The existing saved-reader file, line, record and action-type budgets still apply
to whole sources before filtering. A source refused late contributes no tentative
counts or tentative overview-overflow error. Modern sources keep precedence over
legacy leftovers, and file changes supersede ordinary read or size failures.
The shared reader also retains its existing bounded agent/round sets; this is not
a constant-memory scan.

Local tests exercise real saved loggers, source admission, revision-compatible
drilldown, and a real Flask/Axios/compiled-Vue workflow through export, a changed
source conflict and Refresh. The page renders literal English/Chinese text and
rejects stale or malformed responses. These checks do not certify native browser
layout/download dialogs, Windows storage behavior or real-model quality. The
existing live timeline endpoint, immutable run captures and execution controls
retain their own workflows.

## Compare latest saved simulations

Use **Compare simulations** in the homepage history section, or the comparison
button in a saved simulation's details. Select two distinct simulation IDs to
inspect their latest saved runs side by side. The route `/compare?left=...&right=...`
keeps the pair through reload and browser Back/Forward; **Swap** reverses it and
**Refresh** reads current saved files. Selection changes clear the previous
comparison before loading another. The page is available in English and Chinese.

The workflow reads existing saved files only. It does not start simulations,
generate reports, load a model or make inference requests. Restarting a simulation
replaces its run files, so this compares the latest saved run under each distinct
ID, not multiple historical attempts under one ID. To keep observations before
restarting and compare repeated runs of the same simulation, use
[Run captures](#keep-and-compare-run-captures).

The page shows saved scenario, configured model/profile count, requested rounds,
last saved round, saved status/timestamps, and these observed metrics:

- Recorded actions, including unsuccessful attempts
- Distinct round numbers containing recorded actions, rather than completed rounds
- Recorded actions and distinct active-agent counts separately for Twitter and Reddit
- Action-type counts and signed differences, consistently **right minus left**

Saved configuration is context, not proof of the model or platform actually used.
Agent IDs are not matched across simulations. Differences describe recorded
activity; they do not establish causal effects, prediction accuracy, model quality
or a better outcome. A stopped or failed run can still have readable recorded logs;
its saved status stays visible. Saved status does not establish current process
ownership. Saved starting/running/paused/stopping states return a retryable conflict
instead of a comparison.

Data availability is separate from run status. Missing sources produce unavailable
values (an em dash); a readable empty source can establish zero. Damaged rows are
counted and reported, while valid neighboring observations remain visible as
partial data. Global differences require complete observations on both sides.
Per-platform differences may still be available when that platform is complete
on both sides. An absent action type on an incomplete side is unavailable, not
zero. Unknown platforms are never counted as Reddit.

Modern per-platform logs take precedence over the legacy combined log, even when
the modern log is empty or damaged. Configured disabled platforms with no log do
not prevent an otherwise complete comparison, but their own values remain
unavailable. Missing/malformed configuration or run metadata is visibly qualified;
without saved terminal status evidence, observations are unavailable.

The reader validates both selected paths beneath the configured storage roots,
rejects descendant symlinks/aliases and returns only allowlisted context and
aggregate counts. It does not return model credentials, raw action arguments,
post text or raw results. It checks file fingerprints before/after inspection;
ordinary replacement, deletion or modification triggers a **Refresh and retry**
conflict rather than a mixed comparison. These checks are not a filesystem-wide
atomic snapshot or protection against hostile local path mutation.

Resource limits are explicit: state/run JSON is limited to 1 MiB, configuration
JSON to 8 MiB, each selected log to 64 MiB and 250,000 nonblank records, and each
line to 1 MiB. Each side supports at most 256 action types; action labels longer
than 256 characters are invalid rows. Over-limit sources are refused and marked
unavailable rather than silently truncated. The comparison does not repair or
rewrite existing files.

The two read-only APIs are `GET /api/simulation/comparison/candidates` and
`GET /api/simulation/comparison?left=<id>&right=<id>`. A missing/invalid pair is a
client error, missing simulations return 404, and active/changing saved sources
return 409 with stable error codes. The UI can retry while retaining the pair.

Local verification covers real log writers, disposable saved files and actual
Flask routes. A cross-layer test runs the production Axios client/interceptors
and compiled Vue page against those routes on loopback, checking the visible
counts, swapped differences, missing observations and GET-only requests. It needs
Node and the installed frontend dependencies, otherwise it explicitly skips.
The custom Vue renderer exercises scripts/templates and routing; native browser
layout, keyboard interaction, and native Windows storage behavior remain separate
platform checks. No model weights or paid services are used by these tests.

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
| `LOCAL_MAX_QUEUE` | 32 | Positive integer; bounded waiting requests, overflow returns 429 |
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
Legacy disconnected callers retain work until completion/deadline; prompt trials
use the scoped opt-in withdrawal described above. A model server may keep
computing after transport cancellation, so its own parallel limit is still
necessary. Running multiple independent MiroFish backends creates separate
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
- **Model action fails during a simulation:** a model exception returned by the
  pinned OASIS agent now fails the run instead of producing normal completion.
  Already-started actions settle before that error is surfaced; their persisted
  partial results remain. A valid no-tool response or an empty round can still
  complete with zero actions; valid `DO_NOTHING` actions also remain successful.
  Use **Runtime monitor → Run local setup check** to check the loaded model
  configuration before starting again.
  This does not replay failed work, roll back prior actions, or guarantee that
  the model server stops computing when its HTTP connection closes.
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

Simulation failure checks also run the actual Twitter, Reddit and dual-platform
scripts against synthetic loopback model responses. They exercise the pinned
agent/step boundary, real subprocess exits and the normal monitor's failed state,
alongside valid no-tool and `DO_NOTHING` responses.

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

### Reopen saved interviews

Open a simulation in History and choose **Saved interviews**, or open
`/simulation/<simulation_id>/interviews` directly. The page reads the current
Twitter and Reddit SQLite interview traces without loading a model, starting a
runner, or requiring a report, graph, profiles or simulation configuration.
Choose a platform or enter an exact agent ID, then Apply. Agent zero is valid;
IDs remain decimal strings so large signed-64-bit identifiers keep their exact
identity. Refresh observes newly committed replies, including committed WAL
data from a running environment.

Each platform has its own source status and coverage. A successful empty source
is different from a missing, unreadable or limited one. Accepted records retain
their platform, physical row ID, saved timestamp, prompt and reply. The page
renders these as literal text and distinguishes missing fields from empty text.
Malformed or oversized payloads have a bounded raw preview and warnings. Records
appear Twitter first, then Reddit, in descending SQLite row order within each
platform; this is not a reconstructed conversation or a timestamp chronology.
Stored prompts may already include earlier context. No historical agent names,
model versions or batch boundaries are inferred.

The page shows 25 accepted records at a time. **Download observation JSON**
exports every accepted record and its source/limit metadata, including records
on other local pages, without reading storage again. Editing a filter, changing
the selected simulation or refreshing retires the previous result and download.
A download failure preserves the accepted observation for another attempt; check
existing downloads first because a file may already have been saved.

The separate GET endpoint
`/api/simulation/<simulation_id>/saved-interviews` accepts only optional
`platform=twitter|reddit` and canonical decimal `agent_id` values from `0` through
`9223372036854775807`. Unknown, repeated, signed, padded or blank query values
are rejected. Every response uses `Cache-Control: no-store`. Each requested
platform returns at most 100 rows (200 combined), with a 160 MiB main-database
limit, 64 MiB WAL limit, two-million-operation SQLite budget and 0.25-second lock
timeout. Payload previews are limited to 16 KiB and saved timestamps to 256 bytes,
with UTF-8-safe cuts. The 4 MiB response budget reserves 8 KiB for its envelope
and divides the remaining bytes equally between requested platforms, so one
large source cannot use the other source's allowance. Returned counts describe
retained rows, not matched totals; additional-row availability can be unknown.

All requested main and sidecar paths are validated before either database opens.
Escaped `mode=ro` connections protect the main database, with normal SQLite
WAL/shared-memory behavior; no missing directories or databases are created.
Each platform is observed separately, not as an atomic cross-platform snapshot.
These are the current databases, which a force restart can replace, not retained
archives of earlier runs. The legacy interview-history endpoint below keeps its
existing contract.

Local verification uses real SQLite, Flask, production Axios and compiled Vue
templates/router, including WAL refresh, partial sources, bounds, exact exports
and stale request/download ownership. Native browser layout, download dialogs,
Windows behavior and live model interaction are not verified by these tests.

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
previous version. Downloads without a separate Markdown file serve the embedded
text as an in-memory UTF-8 attachment, including legacy flat JSON reports, without
leaving temporary files. Existing `.md` files retain download precedence and
append-only logs keep their existing behavior. This does not add
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
guards apply to the Step2 component's received simulation ID; parent route
ownership is described below. Local tests execute the actual Vue
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
report generation already accepted by the server. Backend finalization rules
are unchanged. Local tests execute actual Vue setup
and reactivity with controlled replies and loopback HTTP cancellation. Browser
rendering, real model runs and native OS process behavior remain unverified here.

### Simulation parent navigation

The setup and running parent views follow the current route's simulation ID,
including repeated A-to-B-to-A navigation. A different selection clears the old
project, graph and log state, retires its requests and supplies the new ID to its
child. Late metadata/graph replies cannot replace the new selection. A new running
selection reads its own round query; query-only navigation keeps the current run's
settings.

Start, Back and leaving a view retire the old view's pending work. A late setup
environment check cannot issue a new close/stop request after Start has moved to
the running screen. Back from a running view retains the existing graceful-close
and force-stop fallback, admits one pending cleanup action and navigates only
while that action still owns the view. Graph refresh timers and loading state
belong to the current selection and request.

Requests already accepted by the backend may still complete after HTTP
cancellation; this does not undo an already-submitted close/stop. Local tests use
the actual Vue Router and compiled parent/child templates with controlled replies,
plus loopback HTTP cancellation. Native browser interaction and real model runs
remain unverified.

## Keep and compare run captures

Open **Run captures** from History, or from a saved simulation's History details.
This dedicated `/captures` page lets you preserve aggregate observations before
another run replaces the simulation's latest files. The page is available in
English and Chinese.

1. Choose a saved simulation and explicitly **Preview** its current observation.
   Inspect its saved status, source timestamps, configuration context, counts,
   completeness and warnings. Only saved completed/stopped/failed states can be
   captured; a missing readable log remains unavailable, while an admitted empty
   log can establish zero.
2. Enter a label and optional note, then choose **Save capture**. The backend
   checks the source revision again and creates a new immutable record. If the
   source changed after Preview, refresh the preview before saving. Saving does
   not run, stop, prepare or repair the simulation.
3. Run the simulation again through the normal execution workflow, then return
   here and save another observation. Earlier captures remain readable if the
   original latest files or simulation directory are later replaced or removed.
4. Browse the capture library, open an individual capture, or choose left and
   right captures. Two different capture IDs may refer to the same simulation.
   Compare recorded actions, rounds with actions, per-platform activity and
   active-agent counts, plus action types. Differences are always **right minus
   left**, with the same partial/unavailable rules as latest-run comparison.
5. Download an individual capture or the accepted comparison as JSON. Downloads
   contain exactly the displayed accepted objects, including their label/note,
   captured and observed timestamps, source revision, saved context and warnings.
   Refreshing the source simulation cannot rewrite an earlier capture.

A capture is an observation of saved files, not a replayable run archive or proof
that a process has exited. A saved terminal state can coexist with an interview
process. **Saved status** stays visibly qualified. The configured model and
scenario reflect saved configuration at observation time; they do not certify
which model or settings actually executed. Counts include unsuccessful recorded
attempts. Agent IDs are not matched between captures, and differences do not
establish causation, prediction accuracy, model quality or a better outcome.
Source fingerprints detect ordinary saves during reading and between Preview
and Save, rather than supplying an atomic multi-file filesystem snapshot or a
content-authenticity signature. Warnings about unreadable run metadata and
fallback saved status remain part of the capture.

Only allowlisted context and aggregates are stored. Raw posts, action arguments,
results, full configuration, model credentials and simulation SQLite databases
are excluded. Labels and notes are user text and are displayed literally.
Captured scenario text and configured model names remain saved context, so treat
exports as containing the context and notes you chose to preserve.

The dedicated local SQLite store is
`<configured UPLOAD_FOLDER>/run_captures/run_captures.sqlite3`, outside individual
simulation directories. Read requests do not create it. Explicit Save creates
storage and uses a transaction to add a record; existing captures are never
updated. It provides no edit, delete or file-import operation and holds at most
500 captures, each at most 256 KiB of encoded JSON. Labels allow
1–120 Unicode code points and must be nonblank; notes allow up to 2,000. Both
reject invalid Unicode/control characters, with newline/tab allowed in notes.
Oversized observations are refused without truncation. Existing source limits
(state/run metadata, configuration and logs) still apply. Library pages contain
1–50 captures, with 20 shown by default.

Save requests use a unique capture ID and an immutable request body. Repeating
the same ID/body returns its existing saved record, including after source files
change or the library reaches capacity. Different contents under that ID are a
conflict. The UI submits once, then checks that ID after an ambiguous response;
it never automatically retries a write. An explicit retry retains the same ID
and body. A pending ID stays in the URL so a reload can look it up, but unsaved
form text is not recovered after reload. Leaving a page or aborting HTTP does not
undo a save already accepted by the backend. Check a pending capture before
starting a separate save if its outcome was uncertain.

The API is under `/api/run-captures`: `GET /preview?simulation_id=...`,
`GET /records?offset=0&limit=20`, `GET /records/<capture_id>`,
`POST /records/<capture_id>`, `GET /compare?left=...&right=...`, and
`POST /recover` with an empty JSON object.
Capture IDs are 32 lowercase hexadecimal characters. Save POST accepts exactly
`simulation_id`, `source_revision`, `label` and `note`, with a 16 KiB body limit.
Unknown/repeated query parameters, duplicate JSON keys and invalid types are
rejected. Responses are strict JSON and marked `no-store`; request-body debug
logging excludes these endpoints. There are no model/provider requests.

Path checks cover the capture directory, database and potential journal/WAL/shared
memory sidecars; linked or nonregular descendants are refused. Reads use a
read-only SQLite connection, writes use rollback-journal transactions and a
two-second SQLite lock wait. A WAL-formatted store is refused before connecting,
so a read does not create its WAL/shared-memory files. The database file/page
budget is 160 MiB. The storage schema and capture JSON are validated before use. These
checks do not protect against a hostile local process replacing paths during
access, and they do not turn the whole app into a multi-user storage service.
Keep a separate backup of captures that matter to you.

If an interrupted write left a SQLite rollback journal, reads report that
recovery is required and leave the files unchanged. Choose **Recover interrupted
save** to explicitly let SQLite restore committed pages, then refresh the saved
observations. This works without the original simulation files. It creates no
capture, and an absent or healthy store needs no recovery. Retrying an existing
Save request can perform the same narrow recovery before its idempotency check.
There is no automatic recovery POST or automatic save retry. Recovery requires
this store's application/schema header and refuses foreign or WAL databases;
it is not a general database repair tool. SQLite restores pages and removes its
hot journal before record validation can run, so previously committed corruption
may still be reported after an authorized rollback has changed those files.
If the recovery response is lost, read again to check availability; leaving the
page does not undo rollback already performed by SQLite.

Local validation exercises real saved log writers, disposable SQLite storage,
source changes and deletion, idempotent recovery, concurrency, corruption and
read-only paths. The real Flask API, production Axios wrappers and compiled Vue
page are exercised together for capture → rerun → capture → compare → reopen,
including partial observations, a lost successful response, and explicit recovery
after a real disposable writer process crashes. Native browser
layout/download dialogs, Windows storage behavior and real-model quality remain
unverified; no pretrained weights or hosted tests are used.

## Open capture files

Choose **Open capture files** on Run captures, or open `/capture-files` while
the frontend is served. This separate page reads the version-1 individual and
comparison JSON downloads produced by Run captures. It remains usable when the
capture database or original simulation files are unavailable. The frontend must
already be loaded or served; this does not install or cache the whole app for
offline use.

1. Select one JSON file and inspect its preview. Its file name is shown as a
   local label, alongside the capture label/note, captured and observed times,
   saved status, source revision, configuration context, coverage and warnings.
2. Explicitly use an individual capture on the left or right. A comparison
   download previews both embedded captures and its historical generation time;
   choose **Use both captures** to accept the pair. Cancel or an invalid file
   leaves previously accepted captures intact.
3. Read either side on its own, or compare two different capture IDs. They may
   describe the same simulation. Swap or clear the slots as needed. Differences
   are recomputed **right minus left** from the admitted observations.
4. Download an accepted capture or the current locally computed comparison.
   Captured/observed times and saved context are preserved. A new comparison has
   a new UTC generation time and uses the existing version-1 comparison shape.

Every imported observation is labelled historical and unverified against the
current backend. A capture ID or source revision does not authenticate a file
that someone may have edited. Saved configured models/settings do not establish
current readiness or which model actually executed. The reader displays file
names, notes, context and action names as literal text; it does not follow IDs as
links or load source simulations. Comparison results retain the interpretation
limits of saved run captures above.

Known zero remains distinct from unavailable data. Partial observations can
display their observed counts, but aggregate and action-type differences require
complete coverage on both sides. An absent action type is zero only on a complete
side. Per-platform differences independently require complete platform coverage
on both sides. Recorded differences in an imported comparison must exactly match
the values recomputed from its captures before that file is accepted.

Only current version-1 capture exports are admitted. API response envelopes,
other export types, unknown fields/versions, duplicate object keys, malformed
UTF-8, inconsistent counts and altered comparison differences are rejected.
Each selected file is limited to 2 MiB, with JSON nesting at most 10 levels; each
capture must also fit the existing 256 KiB canonical ASCII JSON limit. Captures
allow at most 256 action types of 256 Unicode code points each, 32 warnings, and
counts up to 500,000. New labels/notes follow the capture-store text rules;
historical saved context retains valid JSON escapes losslessly. Capture,
observation and comparison times use extended UTC ISO dates with seconds and an
optional fractional second, as emitted by the producer.

The page retains at most two accepted captures and one pending file preview in
memory. It makes no API/model requests and writes neither browser storage nor
the capture database, including when changing its display language. Leaving or
reloading the page clears its selections. A late file read or an obsolete
control cannot replace a newer selection or download an earlier pair. At most
one download object URL is retained; it is released on the next state change,
replacement download or departure from the page.

Local validation covers actual Python/Flask/SQLite exports read by the JavaScript
parser, comparison parity, bounds and malformed input, plus compiled Vue/router
workflows with delayed file reads, stale controls, literal text, downloads and
both languages. Native browser file pickers, layout and download dialogs remain
unverified. No model, provider, database import or restore operation is involved.
