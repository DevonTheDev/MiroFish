"""SQLite → Flask → production Axios/Vue export → File bytes → local review.

These workflows exercise compiled production scripts/templates and the real
router with a custom Vue renderer, not a native browser. A disposable loopback
Flask server supplies every accepted observation; no live simulation is used.
"""

import json
import sqlite3

import pytest

from test_saved_interviews_api import interview
from test_saved_interviews_api import storage as storage
from test_saved_interviews_frontend import run_workflow, trace_database


HELPER = "saved-interview-files-backend-check.mjs"


def test_interview_file_reopens_actual_export_preserving_exact_questions_and_all_records(storage, monkeypatch):
    prompt = '<script>File question & literal</script>\nCafé 雪 🐟'
    rows = [
        interview(9007199254740993, prompt=prompt, response="Repeated saved reply", timestamp=f"repeat-{i}")
        for i in range(30)
    ]
    rows.extend([
        (9007199254740993, "interview", json.dumps({"prompt": prompt}), "missing-response"),
        interview(9007199254740993, prompt=prompt, response="", timestamp="empty-response"),
        interview(2**63 - 1, prompt=prompt, response="Timestamp-only truncation", timestamp="T" * 300),
        interview(0, prompt=prompt.lower(), response="case difference"),
        interview(0, prompt=prompt + " ", response="space difference"),
        interview(0, prompt=prompt.replace("é", "e\u0301"), response="Unicode difference"),
        interview(0, prompt="", response="empty question"),
        interview(0, prompt="Escaped lone surrogate: \ud800", response="Saved \udfff reply"),
        (0, "interview", json.dumps({"response": "Prompt not saved"}), "missing-prompt"),
        (0, "interview", '<img src=x onerror=alert(1)>{broken', "malformed-raw"),
        interview(0, prompt=prompt, response="X" * 20000, timestamp="payload-truncated"),
        (0, "interview", None, "missing-payload"),
    ])
    trace_database(storage.twitter, rows)
    trace_database(storage.reddit, [
        interview(9007199254740993, prompt=prompt, response="Reddit repeated reply", timestamp="reddit-1"),
        interview(9007199254740993, prompt=prompt, response="Reddit repeated reply", timestamp="reddit-2"),
        interview(0, prompt="", response="Reddit empty question"),
        interview(2**63 - 1, prompt="Reddit-only question", response="Later platform reply"),
    ])
    connection = sqlite3.connect(storage.twitter)
    try:
        connection.execute("UPDATE trace SET rowid = ? WHERE rowid = 1", (-2**63,))
        connection.execute("UPDATE trace SET rowid = ? WHERE rowid = 2", (2**63 - 1,))
        connection.commit()
    finally:
        connection.close()
    observed = run_workflow(storage, monkeypatch, "files-roundtrip", helper=HELPER)
    assert len(observed) == 2, "Only initial live export and explicit return to live may read SQLite"
    assert all(not query for _method, _path, query, _language in observed)


def test_interview_file_reopens_filtered_single_platform_with_exact_large_agent_id(storage, monkeypatch):
    trace_database(storage.twitter, [
        interview(0, response="Unselected Twitter reply"),
        interview(2**63 - 1, prompt="Exact maximum ID", response="Selected Twitter reply"),
    ])
    trace_database(storage.reddit, [interview(2**63 - 1, response="Unselected Reddit reply")])
    observed = run_workflow(storage, monkeypatch, "files-filtered", helper=HELPER)
    assert len(observed) == 1
    assert observed[0][2] == "platform=twitter&agent_id=9223372036854775807"


def test_interview_files_keep_missing_empty_and_corrupt_source_claims_distinct(storage, monkeypatch):
    for simulation_id in ("sim_empty", "sim_corrupt"):
        folder = storage.root / simulation_id
        folder.mkdir()
        trace_database(folder / "twitter_simulation.db")
        if simulation_id == "sim_empty":
            trace_database(folder / "reddit_simulation.db")
        else:
            (folder / "reddit_simulation.db").write_bytes(b"PRIVATE_CORRUPT_DATABASE_CONTENT")
    observed = run_workflow(storage, monkeypatch, "files-states", helper=HELPER)
    assert len(observed) == 3
    assert {path for _method, path, _query, _language in observed} == {
        "/api/simulation/sim_unknown/saved-interviews",
        "/api/simulation/sim_empty/saved-interviews",
        "/api/simulation/sim_corrupt/saved-interviews",
    }


@pytest.mark.parametrize("unhealthy", ["missing", "unreadable"])
def test_interview_file_preserves_partial_coverage_and_bounded_record_pages(storage, monkeypatch, unhealthy):
    trace_database(storage.twitter, [
        interview(0, prompt="Outside exported observation", response="older", timestamp=f"old-{i}")
        for i in range(10)
    ] + [
        interview(9007199254740993, prompt="Limited saved question", response=f"Observed reply {i}", timestamp=f"new-{i}")
        for i in range(100)
    ])
    if unhealthy == "unreadable":
        storage.reddit.write_bytes(b"PRIVATE_CORRUPT_DATABASE_CONTENT")
    observed = run_workflow(storage, monkeypatch, "files-" + unhealthy, helper=HELPER)
    assert len(observed) == 1
