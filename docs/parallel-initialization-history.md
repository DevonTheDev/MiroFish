# Parallel initialization history

Twitter and Reddit runs started through `backend/scripts/run_parallel_simulation.py`
record initialization actions from the OASIS SQLite trace. After the optional seed
step, each platform reads the trace once from cursor zero in strict mode and emits
the unfiltered records under round 0. Later active rounds start after that returned
cursor. This happens even when there are no eligible seeds, no active agents, a
one-round cap, or zero configured rounds.

With an action logger and successful initialization reconciliation, each unfiltered
trace row read in that phase is emitted once in round 0. Repeated content remains
separate action occurrences, with trace identity and arguments such as `post_id`.
Rowid order is observed insertion order, not configured seed order or a promise
about concurrent completion order. Reset-time `sign_up` and `refresh` rows advance
the cursor without producing action records; other initialization traces remain
in round 0. Counts reflect successful logger calls. Without a logger, the cursor
still advances and the returned logged-action total stays zero.

This is trace-backed history, not a transaction or per-request success guarantee.
OASIS can commit a post before its separately committed trace. A request with no
trace does not create a history record, even if a post was committed. Conversely,
the existing logger `success` default is not evidence of atomic post/trace
persistence. There is no recovery of old logs, deduplication across restarts, or
post-table reconciliation.

Strict initialization reads propagate required database read, connection, and
close errors. Strict mode does not fully validate payloads: invalid JSON becomes
empty arguments, and optional context-enrichment failures remain suppressed by
the shared reader. Active-round reads retain their existing non-strict policy.

If the seed step raises, its original exception or cancellation remains primary.
The existing failure helper first permits a read of trace rows then visible, and
the existing outer cleanup closes the environment. A recording or close failure
does not replace that primary error. A successful seed step followed by a required
read or logger write failure fails the run. Earlier successful JSONL appends may
remain; no successful round-zero end or simulation-end marker is emitted.

A failed manual step may leave sibling actions pending in the pinned OASIS
dispatcher. The failure-time snapshot does not promise complete eventual sibling
history. This change does not alter dispatch, cancellation, retries, or cleanup
ownership. Normal completion continues to retain the environment for interviews.

Live monitoring, saved actions, and timeline consumers use the corrected producer
rows without schema changes. Graph forwarding is separate from graph acceptance:
the actual graph updater filters `DO_NOTHING`, and a captured forwarding callback
does not prove external graph persistence.

The regression suite is `backend/tests/test_parallel_initial_history.py`: twelve
mocked runner/SQLite/JSONL scenarios for each platform. It reuses the progress
fixture, checks trace identity/cursors and downstream readers, and covers empty
initialization, caps, cancellation, primary/secondary errors, partial log writes,
and calls without a logger. It does not qualify a full installed OASIS runtime or
rerun the separately accepted seed multiplicity dispatcher qualification.
