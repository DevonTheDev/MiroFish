# Saved input recipe qualification

Run the bounded recipe suite from a checkout that already has its backend Flask dependencies and frontend dependencies installed. The runner requires a POSIX environment, Bash 5+, GNU `timeout`, Python 3.11+ and a Node version supporting the existing Vue VM-module test helpers. It installs nothing and starts no HTTP server, database or model.

```sh
MIROFISH_TEST_PYTHON="$PWD/backend/.venv/bin/python" bash scripts/test_project_input_recipes.sh
```

Set `MIROFISH_TEST_PYTHON` and `MIROFISH_TEST_NODE` to existing interpreter paths as needed; their defaults are `python3` and `node`. The released qualification used CPython 3.11.17, Node's existing accepted runtime, Vue/compiler 3.5.25, Vue Router 4.6.3 and vue-i18n 11.3.0. This portable wrapper is source-reviewed packaging of those selected stages; it was not itself executed as part of the frozen workspace gate.

The runner creates and prints a fresh temporary evidence directory, retains it after success or failure, records stage output/timing/exit files, and stops at the first failed stage. Backend fixtures run 32 unittest methods through the real reader and the actual extracted GET route/guard with an in-process Flask client. They write the real response to `backend-input-recipe.json`; only after success does the launcher record its SHA-256. That generated response and hash are runtime outputs, never a checked-in success fixture.

The following frontend stages run 31 parser cases, 40 recipe component/API cases and 149 existing regressions. The 22-case Home suite is deliberately named `frontend/tests/home-input-recipe.integration.js`, outside the ordinary `npm test` glob `tests/*.test.js`. Run `npm test` from `frontend` for the normal test selection; use this repository runner for the Home recipe integration selection. Renaming that suite does not change its passed test bodies.

The cross-language case requires `MIROFISH_RECIPE_FIXTURE_OUTPUT`, verifies the generated hash, passes those bytes through the real parser and File adoption, and separately invokes ordinary Start to inspect MainView multipart fields. The explicit integration runner always creates that input first. Do not select the integration file alone without its generated response, substitute handcrafted JSON, or silently skip the case.

The runner selects 252 top-level methods/cases. Backend source additionally contains 68 subtest entries, which are not extra top-level cases. It requires all 32 backend methods without skips. Per-stage timeouts are 60/30/120/120 seconds with five-second forced-stop grace; Python and Node use the resource limits in the scripts. V8's 512 MiB old-space limit is per process, not a native-memory/RSS or aggregate tree limit. Network/process tripwires are supplemental test guards, not an OS security boundary.

The original frozen qualification retained one fixture scheduling failure: the pending-Close case queried before Vue's render. Its one-branch `settle()` correction passed in a targeted continuation, followed by all 149 previously unrun regressions. Combined evidence contains 252 distinct passing cases and the retained failed attempt. Backend/parser/interop passing bodies were not repeated in that continuation.

These tests establish the selected isolated reader/API, native parser and compiled-component behavior. HTTP/model/download calls use explicit facades where documented. They do not qualify the whole application initializer, real HTTP server, live models or Neo4j, browser layout, or native OS save completion.
