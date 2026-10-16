# Isolated local-interview seam

Status: prepared source only; every test and command is unrun. This directory is
part of the repository test suite and needs no private assessment packet, model,
GPU package, OASIS/CAMEL installation, server or simulation. Default admission is
`pytest backend/tests/test_local_interview_budget.py`; use the project's normal
backend PYTHONPATH. OpenAI/httpx/pytest are ordinary existing test dependencies.

The `.py.txt` files are intentionally non-importable source slices. The fixture
checks `source-bindings.json` before compiling them at test execution time.
Each selected function/property/method is copied verbatim, including decorators,
from the exact upstream commit. Bindings record full-source SHA-256, Git blob
SHA-1, source URL, source line range and selected-member SHA-256. Skeletons and
omitted imports are marked as modifications in each file. The selected
`UnifiedModelType` class and `UserInfo` class are complete upstream classes.
`TextPrompt`, `return_prompt_wrapper`, and `wrap_prompt_functions` are the actual
upstream definitions, not a plain-string imitation of a custom template.

The request chain executes the actual checked-in adapter and environment wrapper,
then the pinned bodies of `OasisEnv._perform_interview_action`,
`SocialAgent.perform_interview`, `ChatAgent._aget_model_response`,
`ModelManager.arun`, `BaseModelBackend.arun`, compatible `_arun`, and compatible
`_arequest_chat_completion`. It uses actual pinned ModelManager initialization
and all three ordinary strategies, BaseModelBackend initialization, ChatAgent
system/memory properties, template methods, BaseMessage constructors and
conversion methods, MemoryRecord conversion, and UnifiedModelType. Constructor
profile and returned context are synthetic, source-derived fixtures.

The installed real AsyncOpenAI and httpx serialize every attempted SDK request.
Only httpx.MockTransport handles it. Captured body bytes are decoded and checked
by the actual repository gateway `_normalize_payload`, `_input_size`,
`GatewaySettings`, and `_prepare_payload`. No loopback listener is started.
Fixture-only `client._platform = 'Unknown'` prevents OpenAI's platform probe from
spawning a subprocess. The fixture blocks subprocess/fork/system, new threads,
socket connect/bind/listen and DNS. asyncio's internal socketpair is not an
external network connection. A five-second timeout bounds each async case.

## Explicit substitutions and limits

- Package initializer/import graphs are replaced by temporary modules at the
  original camel/oasis module names; monkeypatch restores them after each case
- The app Config object supplies finite explicit settings. Local lifecycle setup
  is a no-op and gateway discovery returns the fixed MockTransport URL
- SocialAgent and OasisEnv constructors are replaced by fixture state assembly;
  no platform/database/graph is started. Original agent/manager/system object
  identities and the production factory-created local model class are preserved
- CAMEL/OASIS package-level decorators/import side effects, including AgentOps,
  file loggers and model metaclass setup, are omitted. `observe` is a declared
  identity decorator, matching the pinned disabled-instrumentation implementation
- Compatible-model construction attaches a real AsyncOpenAI/AsyncCompletions and
  real httpx.AsyncClient after executing pinned BaseModelBackend.__init__.
  There is no sync SDK client. No async request/retry method is replaced
- The owned memory fixture returns a fixed list and stale finite token count once.
  It records update_memory calls but does not implement retrieval, scoring,
  persistence or memory recomputation. This qualifies request scope and inherited
  invocation counts, not the full CAMEL context-creator implementation
- The persistence channel records the actual inherited action call and supports
  controlled wait/error injection. Success returns a synthetic success flag;
  it does not write a simulation database
- Logging sanitization and response-to-CAMEL conversion are reduced to the one
  synthetic non-tool answer required by the seam. The real OpenAI response class
  and ChatAgent response-type check remain exercised. ModelProcessingError and
  the narrow backend/role/vision/action enum interfaces are fixture substitutes
- TextPrompt's placeholder-name helper is a disclosed regex fixture for the
  single `{name}` template, while the class/decorator/format/custom-template
  method bodies are upstream code. No interpreter or system-information code runs
- `sys.setprofile` observes entry into the unchanged inherited dispatch/request
  functions to count calls and retain request-list references. It does not wrap
  or replace a guarded production/upstream method

No selected dependency body was rewritten to fit the adapter's guards. An exact
ordinary type or descriptor mismatch is a qualification failure. The suite does
not prove complete dependency import, graph construction, live model acceptance,
output equivalence, token/context capacity, latency or hardware performance.
Shared-model overlapping platform calls are stress coverage; ordinary batch
platform dispatch remains sequential with ordinarily separate platform models.

## Copyright and license provenance

Copyright 2023 @ CAMEL-AI.org. All Rights Reserved. (OASIS source)

Copyright 2023-2024 @ CAMEL-AI.org. All Rights Reserved. (CAMEL source)

Selected source is redistributed under Apache License 2.0. Original source
headers are retained, modifications are prominently identified, and complete
upstream licenses are included as `OASIS-LICENSE` and `CAMEL-LICENSE`.
`upstream-notices.json` records read-only inspection of complete, non-truncated
Git trees at OASIS e97a1d83761605a24a7dc91fa4d4e9defffa7e23 and CAMEL
9a64b19e1eab529173da5f18c230064c564aeb5c. Neither tree contains a NOTICE file.
License byte lengths and Git blob hashes match those exact upstream trees.
