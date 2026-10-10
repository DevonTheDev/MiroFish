"""Bounded older windows through the actual saved-only Flask/SQLite route."""
import hashlib
import os
import sqlite3

import pytest
from app.services import saved_interviews as reader
from test_saved_interviews_api import database, get, interview, storage


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_windows_reach_all_205_saved_replies_without_overlap(storage, platform):
    path = getattr(storage, platform)
    database(path, [interview(0, prompt=f"Question {i}", response=f"<literal>reply {i} 雪") for i in range(1, 206)])
    before_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    query = f"platform={platform}&agent_id=0&window=1"
    first = get(storage, query)
    assert first.status_code == 200
    data = first.json["data"]
    assert data["version"] == 2 and data["window"]["before_row"] is None
    revision = data["window"]["source_revision"]
    assert len(revision) == 64
    rows = list(data["records"])
    for expected_count in (100, 5):
        boundary = rows[-1]["row_id"]
        response = get(storage, query + f"&before_row={boundary}&revision={revision}")
        assert response.status_code == 200
        data = response.json["data"]
        assert data["window"] == {"before_row": boundary, "source_revision": revision}
        assert len(data["records"]) == expected_count
        rows.extend(data["records"])
    assert [row["row_id"] for row in rows] == [str(i) for i in range(205, 0, -1)]
    assert rows[-1]["prompt"] == "Question 1" and rows[-1]["response"] == "<literal>reply 1 雪"
    assert data["sources"][platform]["has_more"] is False
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before_hash
    assert get(storage).json["data"]["version"] == 1


def initial(storage, platform="twitter", agent="0"):
    response = get(storage, f"platform={platform}&agent_id={agent}&window=1")
    assert response.status_code == 200
    return response.json["data"]


def older(storage, data, boundary=None, **scope):
    return get(storage, f"platform={scope.get('platform', data['filters']['platform'])}"
               f"&agent_id={scope.get('agent', data['filters']['agent_id'])}&window=1"
               f"&before_row={boundary if boundary is not None else data['records'][-1]['row_id']}"
               f"&revision={data['window']['source_revision']}")


@pytest.mark.parametrize("count", [0, 100])
def test_empty_and_exact_limit_are_exhausted(storage, count):
    database(storage.twitter, [interview(response=str(i)) for i in range(count)])
    data = initial(storage)
    assert len(data["records"]) == count
    assert data["sources"]["twitter"]["has_more"] is False


def test_sparse_signed_extrema_and_exact_agent_filter(storage):
    database(storage.twitter)
    ids = [-2**63, -9007199254740993, -1, 0, 9007199254740993, 2**63 - 1]
    with sqlite3.connect(storage.twitter) as connection:
        for row_id in ids:
            connection.execute("INSERT INTO trace(rowid,user_id,action,info,created_at) VALUES (?,?,?,?,?)",
                               (row_id, *interview(0, response=str(row_id))))
        connection.execute("INSERT INTO trace(rowid,user_id,action,info,created_at) VALUES (?,?,?,?,?)",
                           (1, *interview(1)))
    data = initial(storage)
    assert [r["row_id"] for r in data["records"]] == list(map(str, reversed(ids)))
    for boundary in ids:
        response = older(storage, data, str(boundary))
        assert response.status_code == 200
        assert [r["row_id"] for r in response.json["data"]["records"]] == [str(i) for i in reversed(ids) if i < boundary]


@pytest.mark.parametrize("query", [
    "window=1", "platform=twitter&window=0", "platform=twitter&window=01", "platform=twitter&window=",
    "platform=twitter&window=1&window=1", "platform=twitter&before_row=1", "platform=twitter&revision=" + "a" * 64,
    "platform=twitter&window=1&before_row=1", "platform=twitter&window=1&revision=" + "a" * 64,
    *[f"platform=twitter&window=1&before_row={value}&revision=" + "a" * 64
      for value in ("", "01", "-0", "+1", "1.0", "9223372036854775808", "-9223372036854775809")],
    "platform=twitter&window=1&before_row=1&revision=" + "A" * 64,
    "platform=twitter&window=1&before_row=1&revision=short",
    "platform=twitter&window=1&before_row=1&before_row=1&revision=" + "a" * 64,
    "platform=twitter&window=1&before_row=1&revision=" + "a" * 64 + "&revision=" + "a" * 64,
    "platform=twitter&window=1&offset=1",
])
def test_invalid_window_query_fails_before_connection(storage, monkeypatch, query):
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **kw: pytest.fail("Invalid query opened SQLite"))
    response = get(storage, query)
    assert response.status_code == 400
    assert response.json["error_code"] == "invalid_filters"


def test_byte_limit_continues_from_last_retained_row_and_zero_rows_are_explicit(storage, monkeypatch):
    database(storage.twitter, [interview(response=f"reply {i}") for i in range(10)])
    monkeypatch.setattr(reader, "_ENVELOPE_RESERVE_BYTES", reader.MAX_RESPONSE_BYTES - 1000)
    data = initial(storage)
    assert 0 < len(data["records"]) < 10
    assert data["sources"]["twitter"]["warnings"] == ["response_limit"]
    following = older(storage, data).json["data"]
    assert int(following["records"][0]["row_id"]) == int(data["records"][-1]["row_id"]) - 1
    monkeypatch.setattr(reader, "_ENVELOPE_RESERVE_BYTES", reader.MAX_RESPONSE_BYTES)
    zero = initial(storage)
    assert zero["records"] == [] and zero["sources"]["twitter"]["has_more"] is True
    assert zero["sources"]["twitter"]["warnings"] == ["response_limit"]


@pytest.mark.parametrize("change", ["append", "replace", "remove", "journal_add", "journal_change", "journal_remove", "checkpoint"])
def test_ordinary_source_change_invalidates_continuation(storage, change):
    database(storage.twitter, [interview()])
    journal = storage.twitter.with_name(storage.twitter.name + "-journal")
    writer = sqlite3.connect(storage.twitter)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("INSERT INTO trace VALUES (?,?,?,?)", interview(response="WAL reply"))
        writer.commit()
        if change in {"journal_change", "journal_remove"}:
            journal.write_bytes(b"\0" * 512)
        data = initial(storage)
        if change == "append":
            writer.execute("INSERT INTO trace VALUES (?,?,?,?)", interview(response="new")); writer.commit()
        elif change == "checkpoint":
            writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        elif change == "replace":
            replacement = database(storage.folder / "replacement.db", [interview(response="replacement")])
            os.replace(replacement, storage.twitter)
        elif change == "remove":
            storage.twitter.unlink()
        elif change == "journal_remove":
            journal.unlink()
        else:
            journal.write_bytes(b"changed")
        response = older(storage, data)
        assert response.status_code == 409
        assert response.json["error_code"] == "source_changed"
        assert response.headers["Cache-Control"] == "no-store"
    finally:
        writer.close()


@pytest.mark.parametrize("writer_open", [True, False])
def test_repeated_unchanged_wal_windows_and_reader_shm_are_stable(storage, writer_open, monkeypatch):
    database(storage.twitter, [interview(response=str(i)) for i in range(205)])
    writer = sqlite3.connect(storage.twitter)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("INSERT INTO trace VALUES (?,?,?,?)", interview(response="wal")); writer.commit()
    if not writer_open:
        writer.close()
    snapshots = []
    original_revision = reader._source_revision
    def inspect_revision(simulation_id, filters, paths):
        snapshots.append({suffix: None if not path.exists() else (path.stat().st_size, path.stat().st_ino, path.stat().st_mtime_ns, path.stat().st_ctime_ns) for suffix, path in paths.items()})
        return original_revision(simulation_id, filters, paths)
    monkeypatch.setattr(reader, "_source_revision", inspect_revision)
    try:
        response = get(storage, "platform=twitter&agent_id=0&window=1")
        assert snapshots[0][""] == snapshots[1][""], snapshots
        assert response.status_code == 200, str(snapshots)
        data = response.json["data"]
        for _ in range(3):
            assert older(storage, data).status_code == 200
            assert initial(storage)["window"]["source_revision"] == data["window"]["source_revision"]
        assert older(storage, data, agent="1").status_code == 409
        assert older(storage, data, platform="reddit").status_code == 409
        if not writer_open:
            with sqlite3.connect(storage.twitter) as appender:
                appender.execute("INSERT INTO trace VALUES (?,?,?,?)", interview(response="first committed frame"))
                appender.commit()
                assert older(storage, data).status_code == 409
    finally:
        if writer_open:
            writer.close()


def test_mutation_after_connection_close_wins_over_partial_result(storage, monkeypatch):
    database(storage.twitter, [interview()])
    original = sqlite3.connect
    connections = []
    class ChangedOnClose(sqlite3.Connection):
        def close(self):
            super().close()
            connections.append("closed")
            with original(storage.twitter) as writer:
                writer.execute("INSERT INTO trace VALUES (?,?,?,?)", interview(response="changed"))
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **kw: original(*a, **kw, factory=ChangedOnClose))
    response = get(storage, "platform=twitter&window=1")
    assert connections == ["closed"]
    assert response.status_code == 409 and response.json["error_code"] == "source_changed"


@pytest.mark.parametrize("state", ["missing", "unreadable", "query_limited"])
def test_unavailable_windows_do_not_claim_continuation(storage, monkeypatch, state):
    if state == "unreadable":
        storage.twitter.write_bytes(b"not SQLite")
    elif state == "query_limited":
        database(storage.twitter, [interview()]); monkeypatch.setattr(reader, "MAX_VM_OPERATIONS", 1)
    data = initial(storage)
    assert data["sources"]["twitter"]["status"] == state
    assert data["sources"]["twitter"]["has_more"] is None
