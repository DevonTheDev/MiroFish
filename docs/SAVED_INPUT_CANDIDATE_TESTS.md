# Saved input candidate checks

Run the focused checks from the repository root with:

```sh
bash scripts/test_saved_input_candidates.sh
```

Use installed frontend dependencies and a Python 3.11 environment containing Flask and its ordinary dependencies. The POSIX wrapper requires Bash, `timeout` and Python resource limits. Set `MIROFISH_TEST_PYTHON` and `MIROFISH_TEST_NODE` to installed interpreter paths if needed. It does not install packages, start the application, use a provider, launch a browser or contact the network. It reuses the existing `scripts/project-input-recipes-no-network.cjs` fixture guard.

The wrapper creates a new temporary evidence directory, prints its location, retains logs/exit codes/timestamps and stops at the first failing command. Backend fixtures use disposable storage and generate the actual candidate-list and existing recipe-download response bytes with SHA-256 files. The Vue workflow consumes those exact bytes; the source/scenario checks are not a hand-built lookalike payload.

The finite command selects 128 cases:

- 42 isolated backend metadata-reader/API cases
- 31 isolated bounded fetch/validation cases
- 21 actual Vue picker/Home cases, including generated failed-project discovery → existing recipe download → explicit local recipe adoption
- 34 existing Home import/Replace/Start cases

The fixture-dependent picker suite uses `.integration.js`, matching the established Home recipe convention, so default `frontend` `npm test` does not require pre-generated backend fixture files. The wrapper provides `MIROFISH_CANDIDATE_FIXTURE_DIR` to that suite and `MIROFISH_RECIPE_FIXTURE_OUTPUT` to the existing Home integration. The adapter suite remains a normal `.test.js` file.

Reader coverage includes 256-entry, 50-row, 1 MiB per-metadata and 8 MiB reserved-read bounds; one unbuffered N+1 read; malformed neighbors; unsafe paths; ordinary file/root changes; exact skip/partial disclosures; and sanitized no-store API outcomes. Metadata discovery does not claim export eligibility. The actual failed/pre-simulation workflow also verifies that an incomplete candidate can appear but fail through the existing recipe endpoint.

UI coverage exercises late promises, refresh, Close/reopen, same-ID observations, committed route objects, false→true Home availability before Vue teardown, Start ownership, retained callbacks, download cleanup and focus ownership. The existing recipe reader/parser/downloader and Start flow remain the source of their existing guarantees. Display validation preserves valid U+FEFF format scalars while rejecting Unicode whitespace/control sequences that the reader normalizes.

The qualification evidence for this change supports 128 distinct passing cases across an initial gate and a narrow corrective gate. The initial gate's generated cross-language workflow caught an adapter whitespace mismatch; that failure was preserved, the adapter was corrected, and the affected cases plus previously unrun Home regressions passed. This repository-local convenience wrapper was source-reviewed and packaged afterward; it was not executed as a new qualification run.

These are isolated Flask/reader and real Vue script/template/router/custom-renderer checks. They do not establish native tab order, browser CSS layout, successful file saving, a full Vite bundle, live application/provider behavior, hostile-writer atomicity or a stalled-filesystem time guarantee. Platform-specific skipped filesystem cases must be reported rather than described as passing.
