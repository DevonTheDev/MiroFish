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

## Choose one or both simulation platforms

After graph building, choose **Info Plaza**, **Topic Community**, or **Both**
before entering setup. The choice follows that simulation through preparation,
startup, live activity and agent interviews. Both remains the default; selecting
one environment is useful for a smaller local experiment. The shared graph,
profile/configuration work and model settings still affect resource use.
See [choosing a platform](docs/LOCAL_MODE.md#choose-a-simulation-platform).

## Revisit saved reports

Open **Saved reports** from Home to search earlier saved reports, filter their
saved status, read Markdown without the original simulation/graph/logs, and
download the exact displayed snapshot. Modern and legacy report files are
supported. This view reads local saved files without calling models or starting
new work. See the [saved report library guide](docs/LOCAL_MODE.md#revisit-saved-reports).

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
observed source and exact text download. See [captured report comparison](docs/LOCAL_MODE.md#compare-captured-report-text).

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

Open a simulation in History and choose **Saved activity** to inspect its latest
saved action records. Find a literal phrase in decoded saved content, filter by
saved outcome, platform, round, agent ID or exact action type, and page through
the results. Matching excerpts help locate a record before expanding its original
JSON details or downloading the displayed page. This view reads saved files
without starting a simulation or asking a model.
It distinguishes missing or partial logs from a complete zero-match result and
requires Refresh if files change between pages. See the
[saved activity guide](docs/LOCAL_MODE.md#explore-latest-saved-activity).

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

Use **Find saved text** to search accepted prompts, replies and raw previews
across all local pages of the current records or selected-question view. Matching
is literal and case-insensitive. Source coverage and warnings stay visible;
missing or truncated text may hide a match. Search is local, and downloads still
contain the complete accepted observation.

Choose **Open interview file** to reopen an earlier observation JSON in the
browser. Review the file's saved context before opening its records and exact
questions, including when the original databases are unavailable. File content
is historical and is not checked against the current backend. The same local
text search works on an opened file. See
[opening interview files](docs/LOCAL_MODE.md#open-interview-files).

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
