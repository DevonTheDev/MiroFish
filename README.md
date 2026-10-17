<div align="center">

<img src="./static/image/MiroFish_logo_compressed.jpeg" alt="MiroFish Logo" width="75%"/>

<a href="https://trendshift.io/repositories/16144" target="_blank"><img src="https://trendshift.io/api/badge/repositories/16144" alt="666ghj%2FMiroFish | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

简洁通用的群体智能引擎，预测万物
</br>
<em>A Simple and Universal Swarm Intelligence Engine, Predicting Anything</em>

<a href="https://www.shanda.com/" target="_blank"><img src="./static/image/shanda_logo.png" alt="666ghj%2FMiroFish | Shanda" height="40"/></a>

[![GitHub Stars](https://img.shields.io/github/stars/666ghj/MiroFish?style=flat-square&color=DAA520)](https://github.com/666ghj/MiroFish/stargazers)
[![GitHub Watchers](https://img.shields.io/github/watchers/666ghj/MiroFish?style=flat-square)](https://github.com/666ghj/MiroFish/watchers)
[![GitHub Forks](https://img.shields.io/github/forks/666ghj/MiroFish?style=flat-square)](https://github.com/666ghj/MiroFish/network)
[![Docker](https://img.shields.io/badge/Docker-Build-2496ED?style=flat-square&logo=docker&logoColor=white)](https://hub.docker.com/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/666ghj/MiroFish)

[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white)](http://discord.gg/ePf5aPaHnA)
[![X](https://img.shields.io/badge/X-Follow-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/mirofish_ai)
[![Instagram](https://img.shields.io/badge/Instagram-Follow-E4405F?style=flat-square&logo=instagram&logoColor=white)](https://www.instagram.com/mirofish_ai/)

[English](./README.md) | [中文文档](./README-ZH.md)

</div>

## Local mode: no paid model or memory service

Run this fork on your own PC with Ollama-compatible open-weight models,
Graphiti/Neo4j memory, and bounded consumer-hardware defaults. Start with the
[local setup guide](docs/LOCAL_MODE.md), `.env.local.example`, and
`npm run setup:local`. Existing cloud setup remains available below.

Local preparation also supports [cast presets](docs/LOCAL_MODE.md#save-and-reopen-a-local-cast-preset):
save selected agents, profile mode and a round cap to a small JSON file, then
explicitly apply those choices to a fresh setup on the same project and graph.
Opening a preset does not prepare or start a simulation.

## Find a node or relationship in the graph

The graph search starts in **Nodes** mode and searches full node names. Switch
to **Relationships** to search each loaded relationship's label (`name`), full
fact, type (`fact_type`), source display text or target display text. These five
strings are searched separately. Endpoint text uses the current loaded node name,
then the producer's endpoint name, then its UUID. Relationship UUIDs distinguish
rows but are not searched; attributes, episodes, dates and JSON are not searched.
Display-only fallback text such as Unknown is not indexed.

In **Nodes**, **Displayed type** narrows the list to the exact type printed on each
node result. This is the first label other than `Entity`, or `Entity` when that
value is missing or empty; additional labels remain in node details. Label order,
case and whitespace are preserved. A selected type can find nodes without a name,
including nodes with empty names. When a name is entered, both criteria must match.
**All types** applies no type restriction and, with a blank name, shows no results.
The choices come from the full loaded node list, independent of the name query.

In **Relationships**, **Relationship type** narrows the list to an exact recorded
`fact_type`, independently of the relationship label (`name`). Choices use the
nonempty string types in the full loaded relationship list, preserving source
order, case and whitespace. Missing, null, empty and nonstring types have no
choice but their records remain text-searchable with **All types**. Display-only
`Unknown` is not a type choice; a literal stored `Unknown` is. A selected type
lists matching relationships with a blank query. With text, both criteria must
match. **All types** and blank text show no results.

Name and relationship text matching is literal and case-insensitive; only whitespace
around the query is ignored. Both type selectors use exact, case-sensitive values.
Queries are limited to 200 UTF-16 units.
Matches appear in pages of 20 in current source order, with exact totals and
**Previous**/**Next** controls. Rows show source positions from the original node
or relationship list, including records omitted from the drawing. Relationship
rows show directional endpoints, label/type, available UUID and a fact preview
limited to 160 UTF-16 units plus an ellipsis; the full fact remains searchable.

Selecting a node opens the same details and highlights as clicking its circle.
Selecting a relationship opens that exact individual record, even with duplicate
or missing UUIDs, equal-looking records or repeated references. A self-relation
may highlight the grouped **Self Relations** line, but its search detail shows
only the chosen member and identifies that grouping. A relationship with missing
endpoints opens **Details only** and clears graph highlights. This also works when
the graph has no loaded nodes. Search reads loaded data without verifying its
factual accuracy or making additional requests.

Switching modes clears the query, type and page while retaining the current details
and drawing. Editing or clearing a query or changing the type returns to page one;
editing one criterion keeps the other. Paging and search criteria do not redraw,
pan or change selection, labels or the complete graph JSON export. The mode, query,
type and page survive refreshes of the same identified graph; shrinking results
durably clamp to the last page (or page one when empty). A selected type that
disappears remains a visible choice with zero matches until it returns or the user
changes it. A changed, missing or invalid graph ID, or removing the graph, resets
to **Nodes**, **All types** and a blank query. Refreshed data closes search-opened
details. Resize preserves state; selection waits for the current drawing to be
ready. Stale results and retired graph pointer callbacks cannot select old data.
Mounted tests use real Vue and D3 with a synthetic host; native browser keyboard,
focus behavior, pointer geometry and layout remain unverified.

Resize and data redraws preserve the numerical pan and scale
of the same rendered SVG, including graph-ID changes and empty-node refreshes.
Removing the graph until its SVG unmounts, then loading again starts at identity.
This does not fit the graph or preserve node positions when layout restarts.
An active wheel gesture follows the current root group of its owning SVG, including
while a redraw is queued and after that group is replaced. Late events from a
replaced SVG or unmounted panel cannot update rendered groups; D3 may still update
the old SVG's internal transform before the callback guard runs. This does not
cancel gestures or timers. Focused tests cover completed and active wheel gestures
with the same synthetic host; pan, touch, zoom transitions, native browser geometry
and rendering remain unverified.

The graph header has **Zoom in**, **Zoom out** and **Reset view** buttons. Zoom
steps double or halve the scale around the current viewport center, clamped to
0.1–4. Reset restores viewport translation and scale to identity (x=0, y=0, k=1)
synchronously; it does not fit the graph, restart layout, change selection or
refresh data. Controls wait for a populated drawing with positive viewport size;
zoom steps disable at their bounds, while Reset stays available at identity.
Buttons have English/Chinese accessible labels and a visible focus outline.
Focused synthetic-host tests also cover commands during a retained wheel gesture;
native keyboard activation, focus and visual placement remain unverified.

**Fit graph** synchronously centers the current rendered node positions and fits
their circle markers, including selected strokes, with an inset of up to 24
viewport units. It uses the current drawing's viewport and the same 0.1–4 scale
limits; very large layouts can extend outside the viewport at the minimum scale.
Single or coincident nodes are supported. Invalid positions are ignored; no valid
positions, unsafe arithmetic or a node pinned by an active drag leaves the view
unchanged. Fit measures markers, not labels, links or overlays, and leaves layout,
data, search and selection unchanged. Ongoing force motion may move nodes again.

**Center selected node** is a text button in node details. Selecting a circle or
node search result still leaves the viewport unchanged; this separate action
centers that exact occurrence's current rendered position at the current zoom
scale. It uses the full drawing viewport, so details or other overlays may cover
its center, and ongoing force motion may move the node afterward. Resize keeps
the selection usable after the new drawing completes. A data change leaves
pointer-opened details visible but disables centering until a node is reselected;
search-opened details still close on refresh. Pending/empty drawings, invalid
coordinates or dimensions, unsafe arithmetic and any active node pin leave the
view unchanged. The action preserves data, layout, selection and search, with
English/Chinese text and a visible focus outline. Focused synthetic-host tests
cover current positions, occurrence identity and active wheel continuity;
native browser keyboard, focus and visual placement remain unverified.

**Fit relationship endpoints** is a separate text button in relationship details.
Selecting a line, its label or a relationship search result still leaves the
viewport unchanged. Clicking the button fits both exact current rendered endpoint
markers, including grouped and individually searched self-relations. It uses the
same marker extent, viewport inset and 0.1–4 scale limits as **Fit graph**; very
large endpoint separations can remain clipped at minimum scale. It does not fit
curves, self-loop arcs, labels or pixels hidden by overlays. Ongoing force motion
may move endpoints afterward. Resize retains the selection and enables the action
after the new drawing completes; data changes disable the action in retained
pointer details until reselection, while search-opened details still close. Missing rendered edges
remain **Details only** with a disabled button. Either missing or invalid endpoint,
unsafe arithmetic, invalid dimensions or any active node pin leaves the viewport
unchanged. Layout, data, selection, search, labels and export behavior are retained.
English/Chinese labels and focus styles are included; synthetic-host tests do not
establish native browser keyboard, focus, placement or overlay visibility.

## Download the loaded graph JSON

On the Process screen, **Download loaded graph JSON** downloads the values
currently held for the selected completed project. The file may differ from the
current server graph. Downloading makes no API request and does not change the
graph. Other graph screens do not expose this control.

The file is `mirofish-loaded-graph.json`, containing format
`mirofish-loaded-graph-observation`, format version `1`, project and graph IDs,
`downloaded_at` (the client UTC time of the download attempt), and `graph`.
The backend reads nodes and relationships separately; neither the source nor
this file establishes an atomic snapshot, server revision, or freshness. The
format version describes this file format only. These are decoded JSON values,
not original network bytes or an immutable accepted-response capture. Valid
changes to held values before a click appear in that download; later changes
cannot alter its already serialized body.

All producer fields and additional JSON fields are retained, including literal
temporal strings, ordered labels and episodes, repeated IDs, self-relations and
relationships with missing endpoints. The visualization's filtered or grouped
D3 data is not used. Malformed producer records and non-JSON values fail visibly;
accessors and `toJSON` methods are not invoked. The complete formatted UTF-8 file,
including its envelope and final newline, must fit within 8 MiB (8,388,608 bytes).
An oversized download creates no file and never truncates data. This file limit
does not describe the graph API's capacity.

A refresh suspends downloads. If it fails while a valid source is retained, a
fresh action explicitly says **Refresh failed; download uses the previously
loaded graph.** Its click captures that source's current held values. A successful
replacement, source replacement, departure or unmount retires previous actions.
Navigation suspends downloads when MainView observes its leave, global or update
guard. An earlier registered global guard can delay observation of a same-project
query navigation: the current action remains available while that guard waits,
and an abort before MainView observes it preserves the current action. Download
ownership still checks the committed route, source and current read at every
side-effect boundary.

The browser's download is only initiated; a native file-save completion is not
reported. Successful object URLs are retained until the next download, refresh,
source retirement or unmount, with each attempt cleaning only its own resources.
Synthetic frontend checks cover controls, JSON and ownership; native browser
layout and file-saving behavior remain unverified.

## Expand self-relation details

After opening a grouped **Self Relations** edge, each numbered relation header is
a button with an expanded/collapsed state. Tab to a header and use Enter or Space
to toggle its details; the focused header has a visible outline. Multiple rows
can stay open. Closing the detail panel with **×** resets expanded rows, while
clicking the graph background dismisses the panel and retains their state.

This covers disclosures inside an open panel; selecting SVG graph edges still
uses the existing pointer controls. Row identity still uses its UUID, falling
back to its position when absent, so duplicate UUIDs keep their existing shared
expansion behavior. Mounted tests check rendered semantics and state changes;
the synthetic host does not verify native keyboard activation or focus pixels.

## Choose one or both simulation platforms

When a graph build finishes, setup becomes available after its completed project
and graph ID are loaded. If that final read fails or returns an incomplete result,
choose **Retry loading graph result** inline. This only reloads the saved project
and its graph; it does not rebuild the graph or create a simulation. Graph preview
loading remains independent, so setup can proceed once the saved result is valid.

After graph building, choose **Info Plaza**, **Topic Community**, or **Both**
before entering setup. The choice follows that simulation through preparation,
startup, live activity and agent interviews. Both remains the default; selecting
one environment is useful for a smaller local experiment. The shared graph,
profile/configuration work and model settings still affect resource use.
See [choosing a platform](docs/LOCAL_MODE.md#choose-a-simulation-platform).

If creation succeeds but opening setup is interrupted, choose **Open created
simulation** to reopen that accepted simulation. The retry only navigates to its
existing setup; it does not create another simulation. It remains available while
the same project's graph metadata reload is pending or fails. Choosing a different
project or graph, leaving the view successfully, or reloading the page ends this
in-memory recovery. Existing setup behavior begins after its destination opens.

## Revisit saved reports

After the current report completes in Step 4, **Open saved report** opens its
reader in Saved reports, below the catalogue, with Markdown and observation JSON
downloads. It reads the currently saved data by report ID, even when that report
is not on the first catalogue page. The link does not pin a completion snapshot:
saved metadata or content may still be changing, unavailable, or missing. Existing
catalogue/detail reads start when the destination opens. **Enter Deep Interaction**
remains available.

Open **Saved reports** from Home to search earlier saved reports, filter their
saved status, read Markdown without the original simulation/graph/logs, and
download the exact displayed snapshot. Modern and legacy report files are
supported. This view reads local saved files without calling models or starting
new work. See the [saved report library guide](docs/LOCAL_MODE.md#revisit-saved-reports).

The catalogue's **Open** button moves keyboard focus and requests an immediate
scroll to the reader heading once its navigation commits, while saved content
may still be loading. Later success or error responses do not move focus. A
newer selection, intervening focus change, or observed Close, Refresh, filter
edit or departure cancels the pending handoff. Direct links, browser history and
file imports do not request it. The renderer tests cover focus/scroll requests;
native browser positioning and assistive technology behavior remain unverified.

**Copy saved Markdown**, at the top of the shared reader below the existing
download controls, copies the whole accepted body in Saved reports and Open
report files. It passes the exact saved string to the browser clipboard API,
including whitespace, line endings, Unicode and literal markup, without metadata
or search limits. A nonempty available body can be copied regardless of saved
generation status; the existing 8 MiB body admission limit still applies. Empty
or unavailable bodies cannot be copied. Clipboard access may be unavailable or
denied; Markdown and observation JSON downloads remain available alternatives.
Success is shown only after the clipboard write resolves. Only one write can be
pending at a time, even after closing or replacing the reader. Changing the
accepted source or leaving the reader retires its feedback but cannot cancel an
already submitted write. A pending write has no timeout, queue, fallback or
automatic retry. Search, language changes and an unaccepted replacement file's
selection, loading, preview or cancellation preserve the accepted copy operation.

Use **Download observation JSON** to retain a report's exact accepted text and
recorded context, then choose **Open report files** from Home or the report
library to reopen it locally. Preview the file before opening it, search its
literal text, and capture two observations for comparison. A replacement file
does not replace the current reader until you explicitly open it. The frontend
must already be loaded or served; file review makes no report or model requests.
Recorded dates, status and hashes are historical metadata, unverified against
the current backend. See [opening report files](docs/LOCAL_MODE.md#open-report-files).

Capture opened reports into left/right slots to compare their literal text and
bounded line changes while browsing the library. Each side retains its own
observed source, exact Markdown and observation JSON downloads, even after the
reader changes or closes. Reopen a side's JSON in **Open report files**, including
observations with unavailable text. See [captured report comparison](docs/LOCAL_MODE.md#compare-captured-report-text).

If a report request loses its response, retrying while that report is still
running in the same backend process reopens the existing job. A forced
regeneration also reuses that active job; it can start a new report after the
worker finishes. See [report request retries](docs/LOCAL_MODE.md#retry-a-report-request).

Report Agent chat in Step 5 uses the displayed report's saved text, even when a
newer report exists for the same simulation. Missing, unreadable, incomplete or
mismatched selected reports fail before agent work. API clients can supply
`report_id` to bind a report, or omit it to keep latest-by-simulation selection.
The existing context limit still applies; graph searches and interviews use
current simulation data, not a historical graph snapshot.

In Step 5 Report Agent chat, **Download conversation TXT** saves every displayed
stored turn in the current page session, including displayed error notices. It
uses the stored message text and English field labels, with visible escapes for
control characters. Other agent chats, surveys, unsent input, hidden prompts and
tool metadata are excluded. The complete UTF-8 output must fit within 1 MiB;
larger conversations are refused without shortening them. The download request
does not confirm that the browser saved a file. Chats are not restored after a
reload, and this TXT file cannot resume a conversation.

When a Step 5 agent interview returns text from both platforms, its single reply
shows **Twitter:** and **Reddit:** separately. If only one platform returns text,
that answer appears on its own. Follow-up questions share this conversation:
both labelled answers enter the same prompt once, within the existing six-message
history window. The labels do not create independent platform conversations.

Use **Find agents** in either Step 5 picker to match part of a username, name or
profession. The two searches are independent, ignore case and surrounding query
spaces, and treat punctuation literally. Matching counts and **Clear search**
help you return to the full catalogue. Searching keeps the current conversation
and all survey selections, including selected agents hidden by the search.
The hidden-selection count makes these visible; **Select all N agents** and
**Clear all selections** always apply to the entire catalogue. Searches reset
when the report or simulation context changes. Searching itself starts no
interview or profile reload.

In the survey picker, **Selected only** shows the selected agents that match the
current search. Unchecking an agent removes it from this view. **Clear search**
keeps the view enabled, and the global selection actions still affect every
agent. The view stays enabled when switching tabs and resets off when changing
the report or simulation. View and selection edits during a survey affect future
submissions; the pending survey keeps its submitted targets and question.

With a nonblank survey search and **Selected only** off, **Select matching agents**
adds every matching agent to your current selection. Earlier selections, including
hidden agents, keep their order; new matches are appended in catalogue order.
The action keeps the search and is disabled when no new matches remain. You can
use it while a survey is pending to prepare the next submission.

## Monitor local runtime activity

Open **Runtime monitor** from Home to see loaded model settings, resource limits,
and the backend's shared gateway activity. Refresh manually, enable periodic
refresh, or download the displayed observation as JSON. The monitor is passive:
opening it does not start a gateway, call a model or connect to Neo4j. Gateway
activity is separate from model readiness. Explicitly choose **Run local setup
check** to test the database and required model capabilities with small synthetic
requests, inspect step results, stop remaining checks, or download the result.
See the [local setup check guide](docs/LOCAL_MODE.md#check-local-setup-in-the-app)
and [runtime monitor guide](docs/LOCAL_MODE.md#monitor-local-runtime-activity).

## Reopen local prompt experiments

In **Local prompt trials**, reopen an individual trial or two-trial comparison
JSON, inspect the historical preview and explicitly add it to pins. Compare it
with saved or newly captured replies, download the comparison, or reuse its
prompt before an explicit fresh run. Imports stay separate from current model
readiness and never resume old requests or start inference. See the
[saved trial workflow](docs/LOCAL_MODE.md#reopen-saved-trial-files).

Turn one to five pinned trials into a repeatable suite with **Build suite
definition**. Review the captured prompts and settings, download the definition,
then import it in **Prompt suites** before an explicit run. Recorded replies
are never made into expected answers automatically. This also works with
reopened historical pins while the backend is unavailable. See
[building a suite from pins](docs/LOCAL_MODE.md#build-a-suite-from-pinned-trials).

## Run and pause local prompt suites

Open **Prompt suites** to run a small repeatable set of prompts against your
configured local model and inspect the captured replies and checks. **Pause
scheduling** lets the accepted case finish being observed, then holds the
remaining cases. **Resume scheduling** keeps the same captured inputs and checks
readiness again; **Stop scheduling** ends the sequence. The pause lasts only in
the current page and does not cancel inference or suspend other local work.
See the [prompt-suite pause workflow](docs/LOCAL_MODE.md#pause-and-resume-suite-scheduling).

To retest a smaller set, import a saved run report and review each case's recorded
outcome and check. Choose cases individually or **Select cases needing attention**,
then explicitly use the selected cases as a fresh draft. Original prompts,
settings and checks are preserved; a later Run uses current readiness and new
execution IDs. See [saved-run case reuse](docs/LOCAL_MODE.md#reuse-cases-from-a-saved-run).

## Prepare reviewed local-model examples

Open **Reviewed examples** from Prompt suites or Compare run reports. Load a
saved run, inspect its prompts and recorded outcomes, write or correct assistant
targets, and explicitly approve the examples you want to export. Download
messages JSONL and a matching review report for external local-model experiments.
This page works offline and does not train a model; passing a recorded check does
not automatically approve an example. See the
[reviewed examples guide](docs/LOCAL_MODE.md#prepare-reviewed-prompt-examples).

To continue editing later, choose **Download curation draft**. In a fresh session,
open that draft, inspect its preview and use it to restore all target text.
Approvals are cleared so each exported example gets a fresh explicit review.
The draft includes the full source report and every target, including unapproved
cases; it is separate from the selected training-example downloads.

## Explore saved activity

If Home History cannot load, choose **Retry loading history** after the backend
is available again. The notice stays visible while the retry is pending, and a
successful read restores the latest 20 history cards without starting a run.

Open a simulation in History and choose **Saved activity** to inspect its latest
saved action records. Find a literal phrase in decoded saved content, filter by
saved outcome, platform, round, agent ID or exact action type, and page through
the results. Matching excerpts help locate a record before expanding its original
JSON details or downloading the displayed page. This view reads saved files
without starting a simulation or asking a model.
It distinguishes missing or partial logs from a complete zero-match result and
requires Refresh if files change between pages. See the
[saved activity guide](docs/LOCAL_MODE.md#explore-latest-saved-activity).

In an expanded LIKE_POST, DISLIKE_POST or CREATE_COMMENT record, **Open referenced
saved post** opens the exact recorded post ID on its recorded platform when that
reference is valid. Failed and unknown attempts can also reference a post. The
destination reads the latest saved database and reports missing or unavailable
posts; it does not establish a historical snapshot or that the action succeeded.

Choose **Download all saved actions JSON** from an accepted terminal observation
to save all admitted actions in its observed source set, regardless of the page
or filters. It reads each selected log once and refuses the entire download if
required sources are incomplete, invalid, changed or over the 8 MiB/50,000-action
limits. Source order, repeated attempts and original parsed JSON details are
preserved. This distinct file is for ordinary JSON tools; **Open activity file**
continues to accept page files only. See the
[all-actions download contract](docs/LOCAL_MODE.md#download-all-saved-actions).

Choose **Open activity file** from Home or Saved activity to reopen a downloaded
page in the browser. Preview its recorded context, then open the captured rows
even when the original logs are unavailable. The view keeps the page's filters,
counts and historical coverage visible; a complete source observation does not
mean the file contains every matching action. See
[opening activity files](docs/LOCAL_MODE.md#open-activity-page-files).

Use **Focus this captured page** to narrow opened records by platform and saved
outcome. The local shown count stays separate from the original page counts and
filters. Downloads still contain the complete accepted page, including hidden
rows; the focus cannot retrieve missing records or independently verify outcomes.

From an accepted saved-activity view, open **Activity by round** to see where
recorded attempts and saved failures occur. Select a platform and round range,
then open a round's total or outcome count to inspect its exact records at the
same source revision. Download the accepted aggregate overview as JSON. See
[activity by round](docs/LOCAL_MODE.md#inspect-activity-by-round).

## Reopen saved interviews

Choose **Saved interviews** from a simulation in History to read its current
stored prompts and replies, including separate Twitter and Reddit answers.
Filter by platform or exact agent ID, browse the accepted records, refresh after
new replies, and download the complete accepted observation as JSON. Missing,
damaged and limited sources stay visibly distinct from a successfully empty
result. **Review by saved question** groups the exact complete stored prompts
across both platforms, with all observed answers and per-platform record counts.
Repeated answers remain separate; **All records** also includes incomplete
prompts. These groups do not establish survey batches or participant completeness.
This reads the current platform databases without starting a simulation
or asking a model; it is not an archive of previous runs. See the
[saved interviews guide](docs/LOCAL_MODE.md#reopen-saved-interviews).

Select one platform to enable **Older saved replies**. Each click reads a separate
bounded window below the last returned physical row, preserving the exact agent
filter. **Refresh newest** starts again at the latest replies. A changed database
requires this explicit refresh; windows are never silently combined or replaced.
Observation JSON downloads record the window boundary and source revision and
can be reopened or compared locally alongside older version-1 files.

Use **Find saved text** to search accepted prompts, replies and raw previews
across all local pages of the current records or selected-question view. Matching
is literal and case-insensitive. Source coverage and warnings stay visible;
missing or truncated text may hide a match. Search is local, and **Download
observation JSON/TXT** still includes the complete accepted observation.

Use the separate **Download matching rows TXT** action during a search or in
question mode to save all matching rows across every client page of the loaded
observation/window. It also saves an explicit empty result when nothing matches.
The excerpt records the captured query, exact selected question, source/window
facts and counts, plus the accepted filename for an opened local file. It does
not fetch other windows or establish that the saved source contains no other
matches. Matching TXT uses the same 8 MiB escaped UTF-8 limit as observation TXT;
observation JSON remains the format for reopening or comparing saved evidence.

Choose **Open interview file** to reopen an earlier observation JSON in the
browser. Review the file's saved context before opening its records and exact
questions, including when the original databases are unavailable. File content
is historical and is not checked against the current backend. The same local
text search works on an opened file. See
[opening interview files](docs/LOCAL_MODE.md#open-interview-files).

Choose **Download observation TXT** beside JSON for a readable transcript of
all rows in the accepted live observation or opened file, including version-2
windows. Search, selected question and local page do not narrow this download;
other windows are not fetched or combined. Fixed English file labels preserve
recorded order, exact IDs, filters, limits, source coverage and warning codes.
Null, empty, raw and truncated values remain distinct. Ordinary Unicode and LF
line breaks stay readable; control characters, backslashes and lone surrogates
use visible individual-value escapes. The complete UTF-8 output is limited to
8 MiB and fails as a whole if it cannot be produced. JSON remains the canonical
machine-readable export and only supported import format; TXT has no parser or
full-file roundtrip guarantee. Neither format establishes authenticity, current
availability, conversation sessions or unique respondents. Focused formatter and
compiled-view checks plus a production build cover the feature; native browser
download behavior, responsive wrapping and visual appearance remain unverified.

Choose **Compare interview files** to keep two saved observations open together.
Questions align only when their complete stored prompt text is identical. Inspect
each side's replies, local search and pages independently, with its recorded
filters, source coverage and observation time visible. Matching prompts do not
establish matching people or survey batches; a question missing from one file
may have been outside that observation's captured records. Full downloads retain
all original records. See [comparing interview files](docs/LOCAL_MODE.md#compare-interview-files).

## Compare saved simulations

Open **Compare simulations** in the home history section, or choose a saved
simulation and use its comparison button. The new page compares the **latest
saved run of two distinct simulations**: scenario/configuration context, recorded
activity, platform counts and action types, with right-minus-left differences.
Selections stay in the URL and can be swapped or refreshed. It reads saved files
without starting simulations or making inference requests. Missing or damaged
observations are marked explicitly rather than treated as zero. See the
[comparison guide and limits](docs/LOCAL_MODE.md#compare-latest-saved-simulations).

## Keep and compare run captures

Open **Run captures** in History to preview a saved simulation, give its observed
result a label and note, and explicitly save an immutable aggregate capture.
Capture it again after another run, then compare the two captures even when they
belong to the same simulation or the original logs have been replaced. Browse
earlier captures, inspect their saved context and coverage, and download an
individual capture or the displayed comparison as JSON. This records observed
activity counts without loading models or copying raw posts and credentials.
See the [run capture workflow and limits](docs/LOCAL_MODE.md#keep-and-compare-run-captures).

Choose **Open capture files** to reopen those individual or comparison JSON
downloads in the browser, including when the capture database is unavailable.
Preview a file, choose its left/right slot, and compare two historical captures
or download the result. The file reader keeps the selected data in memory and
recomputes differences from validated counts; it does not verify a file against
the current backend. The frontend must already be loaded or served. See
[opening capture files](docs/LOCAL_MODE.md#open-capture-files).

## ⚡ Overview

**MiroFish** is a next-generation AI prediction engine powered by multi-agent technology. By extracting seed information from the real world (such as breaking news, policy drafts, or financial signals), it automatically constructs a high-fidelity parallel digital world. Within this space, thousands of intelligent agents with independent personalities, long-term memory, and behavioral logic freely interact and undergo social evolution. You can inject variables dynamically from a "God's-eye view" to precisely deduce future trajectories — **rehearse the future in a digital sandbox, and win decisions after countless simulations**.

> You only need to: Upload seed materials (data analysis reports or interesting novel stories) and describe your prediction requirements in natural language</br>
> MiroFish will return: A detailed prediction report and a deeply interactive high-fidelity digital world

### Our Vision

MiroFish is dedicated to creating a swarm intelligence mirror that maps reality. By capturing the collective emergence triggered by individual interactions, we break through the limitations of traditional prediction:

- **At the Macro Level**: We are a rehearsal laboratory for decision-makers, allowing policies and public relations to be tested at zero risk
- **At the Micro Level**: We are a creative sandbox for individual users — whether deducing novel endings or exploring imaginative scenarios, everything can be fun, playful, and accessible

From serious predictions to playful simulations, we let every "what if" see its outcome, making it possible to predict anything.

## 🌐 Live Demo

Welcome to visit our online demo environment and experience a prediction simulation on trending public opinion events we've prepared for you: [mirofish-live-demo](https://666ghj.github.io/mirofish-demo/)

## 📸 Screenshots

<div align="center">
<table>
<tr>
<td><img src="./static/image/Screenshot/运行截图1.png" alt="Screenshot 1" width="100%"/></td>
<td><img src="./static/image/Screenshot/运行截图2.png" alt="Screenshot 2" width="100%"/></td>
</tr>
<tr>
<td><img src="./static/image/Screenshot/运行截图3.png" alt="Screenshot 3" width="100%"/></td>
<td><img src="./static/image/Screenshot/运行截图4.png" alt="Screenshot 4" width="100%"/></td>
</tr>
<tr>
<td><img src="./static/image/Screenshot/运行截图5.png" alt="Screenshot 5" width="100%"/></td>
<td><img src="./static/image/Screenshot/运行截图6.png" alt="Screenshot 6" width="100%"/></td>
</tr>
</table>
</div>

## 🎬 Demo Videos

### 1. Wuhan University Public Opinion Simulation + MiroFish Project Introduction

<div align="center">
<a href="https://www.bilibili.com/video/BV1VYBsBHEMY/" target="_blank"><img src="./static/image/武大模拟演示封面.png" alt="MiroFish Demo Video" width="75%"/></a>

Click the image to watch the complete demo video for prediction using BettaFish-generated "Wuhan University Public Opinion Report"
</div>

### 2. Dream of the Red Chamber Lost Ending Simulation

<div align="center">
<a href="https://www.bilibili.com/video/BV1cPk3BBExq" target="_blank"><img src="./static/image/红楼梦模拟推演封面.jpg" alt="MiroFish Demo Video" width="75%"/></a>

Click the image to watch MiroFish's deep prediction of the lost ending based on hundreds of thousands of words from the first 80 chapters of "Dream of the Red Chamber"
</div>

> **Financial Prediction**, **Political News Prediction** and more examples coming soon...

## 🔄 Workflow

1. **Graph Building**: Seed extraction & Individual/collective memory injection & GraphRAG construction
2. **Environment Setup**: Entity relationship extraction & Persona generation & Agent configuration injection
3. **Simulation**: Choose one social platform or run both in parallel & Auto-parse prediction requirements & Dynamic temporal memory updates
4. **Report Generation**: ReportAgent with rich toolset for deep interaction with post-simulation environment
5. **Deep Interaction**: Chat with any agent in the simulated world & Interact with ReportAgent

## 🚀 Quick Start

### Option 1: Source Code Deployment (Recommended)

#### Prerequisites

| Tool | Version | Description | Check Installation |
|------|---------|-------------|-------------------|
| **Node.js** | 20.19+ (20.x) / 22.12+ | Frontend runtime, includes npm | `node -v` |
| **Python** | 3.11.x | Backend runtime | `python --version` |
| **uv** | Latest | Python package manager | `uv --version` |

#### 1. Configure Environment Variables

```bash
# Copy the example configuration file
cp .env.example .env

# Edit the .env file and fill in the required API keys
```

**Required Environment Variables:**

```env
# LLM API Configuration (supports any LLM API with OpenAI SDK format)
# Recommended: Alibaba Qwen-plus model via Bailian Platform: https://bailian.console.aliyun.com/
# High consumption, try simulations with fewer than 40 rounds first
LLM_API_KEY=your_api_key
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL_NAME=qwen-plus

# Zep Cloud Configuration
# Free monthly quota is sufficient for simple usage: https://app.getzep.com/
ZEP_API_KEY=your_zep_api_key
```

#### 2. Install Dependencies

```bash
# One-click installation of all dependencies (root + frontend + backend)
npm run setup:all
```

Or install step by step:

```bash
# Install Node dependencies (root + frontend)
npm run setup

# Install Python dependencies (backend, auto-creates virtual environment)
npm run setup:backend
```

#### 3. Start Services

```bash
# Start both frontend and backend (run from project root)
npm run dev
```

**Service URLs:**
- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:5001`

**Start Individually:**

```bash
npm run backend   # Start backend only
npm run frontend  # Start frontend only
```

### Option 2: Docker Deployment

```bash
# 1. Configure environment variables (same as source deployment)
cp .env.example .env

# 2. Pull image and start
docker compose up -d
```

Reads `.env` from root directory by default, maps ports `3000 (frontend) / 5001 (backend)`

> Mirror address for faster pulling is provided as comments in `docker-compose.yml`, replace if needed.

## 📬 Join the Conversation

<div align="center">
<img src="./static/image/QQ群.png" alt="QQ Group" width="60%"/>
</div>

&nbsp;

The MiroFish team is recruiting full-time/internship positions. If you're interested in multi-agent simulation and LLM applications, feel free to send your resume to: **mirofish@shanda.com**

## 📄 Acknowledgments

**MiroFish has received strategic support and incubation from Shanda Group!**

MiroFish's simulation engine is powered by **[OASIS (Open Agent Social Interaction Simulations)](https://github.com/camel-ai/oasis)**, We sincerely thank the CAMEL-AI team for their open-source contributions!

## 📈 Project Statistics

<a href="https://github.com/666ghj/MiroFish">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="static/image/star-history-dark.svg" />
   <source media="(prefers-color-scheme: light)" srcset="static/image/star-history-light.svg" />
   <img alt="666ghj/MiroFish Star History Chart" src="static/image/star-history-light.svg" />
 </picture>
</a>

## Reopening local simulation setup

Opening a saved local simulation’s **Env Setup**, or refreshing its setup status, leaves the simulation running. The page checks the selected simulation’s current preparation plan before enabling setup actions.

When that plan identifies a running simulation or retained updater, **Stop this simulation to continue setup** requests the existing Stop action once. The page then checks status again. A Stop acknowledgement alone does not unlock setup: active work, unresolved cleanup, uncertain ownership, invalid local limits, or cancellation can keep it blocked. Refresh checks status without retrying Stop. Saved preparation remains available through explicit **Reuse** once admission permits it.

An active preparation keeps its own progress and cancellation controls. Start and Back into graph setup stay gated while ownership or verification blocks admission; Home remains available. Confirmed cloud entry retains its existing cleanup policy.


### Reuse saved project inputs

An existing selected project or Home history detail can **Download input recipe**. On Home, **Open input recipe** previews the local JSON; **Use these inputs** stages one `reused-project-source.txt` and its editable scenario. Existing draft inputs require Replace/Keep. Start Engine is a separate action that creates a fresh project through the ordinary processing workflow.

Recipes contain the saved normalized aggregate, not original document bytes, ontology, graph or simulation state. History lists simulations, so it is not a catalog of every project; a known project's read-only `/api/graph/project/<project_id>/input-recipe` endpoint can export complete inputs even when ontology generation failed. See [input recipe limits and behavior](docs/LOCAL_MODE.md#saved-project-input-recipes).

### Saved posts and flat comments

Open **Saved simulations → Saved posts**, explicitly choose Twitter or Reddit,
then open a stored post. Posts use descending saved post IDs; comments use
ascending saved comment IDs and match that exact post ID in the selected
platform. Text, quote text, original-post references, null fields and decimal
IDs are preserved. Original text is labeled separately from the saved user's
quote. Related posts are not expanded or merged, and there is no nested reply
schema. Twitter's configured action set does not generate comments; any comment
rows actually stored in its database are still displayed.

These fresh, read-only observations describe returned database rows, not every
attempted action or a complete conversation. Only completed, stopped or failed
saved metadata is admitted; stopped/failed data is labeled partial. Valid
matching run-state metadata takes precedence. Missing run-state permits a
visible fallback to saved simulation status, while present invalid run-state
refuses admission. A missing/unreadable/unsupported source has unknown coverage,
not zero rows. Ordinary changes to metadata, database or sidecars during a read
require explicit Refresh. Separate pages are not stable snapshots, and identical
IDs after restarts do not imply historical identity.

The new `/api/simulation/<simulation_id>/saved-posts` and
`/api/simulation/<simulation_id>/saved-posts/<post_id>` GETs leave the legacy
posts/comments endpoints unchanged. Both require `platform=twitter|reddit` and
accept `offset=0..500000`, `limit=1..100` (default 25). Detail offset pages the
exact post's comments. The UI uses 25 rows and carries platform, list offset,
optional exact post ID and comment offset in its route. Responses are no-store.

The reader admits only ordinary, clean rollback-format SQLite files. Any
`-wal`, `-shm`, or `-journal` entry, even empty, or a WAL-format header makes the
source visibly unavailable before SQLite is opened. It never repairs, copies,
checkpoints or removes source files. Limits are 128 MiB per DB, 1 MiB per
metadata file, 2 MiB for the complete ASCII JSON envelope, 5,000,000 cumulative
SQLite VM instructions checked every 1,000, and a 100 ms busy timeout. Python
3.11's SQLite length limit bounds individual decoded rows/values to 2 MiB;
whole-envelope accounting is incremental and lookahead reads only IDs. Text is
never silently truncated. These protective bounds are not timing guarantees or
whole-database validation. No runtime controls, models or action-log scans are
used by this saved reader.

Saved posts also offers an explicit text search: choose **Posts** or **Comments**,
enter a phrase and Apply. Posts searches each stored content/quote field;
Comments searches stored comments across parent posts on the selected platform.
Matching is literal Unicode casefold by default, with optional **Match case**;
there is no accent removal, wildcard syntax, profile lookup or inferred thread.
Each successful search scans the complete selected table before returning its
25-row page and exact match count. Search refuses the entire result and count
above 50,000 rows, 16 MiB of canonical projected-row JSON, or the existing value,
response and SQLite work limits. These limits do not imply complete discussion
coverage, and Twitter's comment limitation still applies.

Search results open the exact saved post (a comment's recorded parent ID) and
preserve search context for Return. Every page, Refresh and post open reads a
new observation. Editing a search retires its results until Apply; Clear search
or applying an exactly empty phrase returns to ordinary browse. Changing the
platform clears search. See [Local mode](docs/LOCAL_MODE.md#saved-post-and-comment-text-search)
for the query, count and refusal contract.
