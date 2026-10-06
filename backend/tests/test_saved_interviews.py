"""Bounded saved-interview reader: real SQLite, adversarial payloads and IO."""
import importlib
import json
from pathlib import Path
import sqlite3
import time
import pytest
from app.services import saved_interviews as reader
from test_saved_interviews_api import database, get, interview, storage


def test_imports_use_candidate_checkout():
    root = Path(__file__).resolve().parents[1]
    assert Path(importlib.import_module("app").__file__).resolve() == root / "app/__init__.py"
    assert Path(reader.__file__).resolve() == root / "app/services/saved_interviews.py"


@pytest.mark.parametrize("raw,kind,warning", [
    (None, "missing", "missing_payload"), ("", "raw", "invalid_json"),
    ("{broken", "raw", "invalid_json"), ("[]", "raw", "invalid_payload_shape"),
    ('"answer"', "raw", "invalid_payload_shape"), ("null", "raw", "invalid_payload_shape"),
    ('{"response":null}', "raw", "invalid_payload_fields"),
    ('{"prompt":42}', "raw", "invalid_payload_fields"),
    ('{"prompt":{},"response":[]}', "raw", "invalid_payload_fields"),
    ('{"prompt":"first","prompt":"second"}', "raw", "invalid_json"),
    ('{"response":NaN}', "raw", "invalid_json"),
    ("[" * 1500 + "]" * 1500, "raw", "invalid_json"),
    (b'\xff{"response":"a"}', "raw", "invalid_utf8"),
    (42, "raw", "invalid_payload_type"), (1.5, "raw", "invalid_payload_type"),
])
def test_bad_payload_is_visible_without_becoming_successful_empty(storage, raw, kind, warning):
    database(storage.twitter, [(0, "interview", raw, "t")])
    data = get(storage, "platform=twitter").json["data"]
    record = data["records"][0]
    assert record["payload_kind"] == kind and warning in record["warnings"]
    assert record["prompt"] is None and record["response"] is None
    assert record["raw_preview"] is None if raw is None else isinstance(record["raw_preview"], str)
    assert record["payload_bytes"] is None if raw is None else record["payload_bytes"] > 0 or raw == ""
    assert data["availability"] == "partial"
    assert data["sources"]["twitter"]["has_more"] is False
    assert data["sources"]["twitter"]["warnings"] == ["record_warnings"]


def test_missing_fields_and_empty_strings_remain_distinct(storage):
    database(storage.twitter, [(0, "interview", "{}", ""), interview(prompt="", response="")])
    data = get(storage, "platform=twitter").json["data"]
    empty, missing = data["records"]
    assert empty["prompt"] == empty["response"] == "" and empty["warnings"] == []
    assert missing["prompt"] is None and missing["response"] is None
    assert missing["payload_kind"] == "structured" and missing["raw_preview"] is None
    assert missing["timestamp"] == "" and missing["warnings"] == ["missing_prompt", "missing_response"]


@pytest.mark.parametrize("agent", [-1, 1.5, "00", "+1", "1.0", "9223372036854775808", "x" * 100000, None, b"0"])
def test_invalid_agent_metadata_remains_null(storage, agent):
    database(storage.twitter, [interview(agent)])
    data = get(storage, "platform=twitter").json["data"]
    assert data["records"][0]["agent_id"] is None
    assert "invalid_agent_id" in data["records"][0]["warnings"]
    assert data["availability"] == "partial"


def test_canonical_stored_text_ids_filter_exactly_without_float_or_padding_coercion(storage):
    database(storage.twitter, [interview("9007199254740993"), interview(9007199254740993),
                               interview("09007199254740993"), interview(9007199254740992.0)])
    data = get(storage, "platform=twitter&agent_id=9007199254740993").json["data"]
    assert len(data["records"]) == 2
    assert [row["agent_id"] for row in data["records"]] == ["9007199254740993"] * 2


@pytest.mark.parametrize("value,warning", [(None, "missing_timestamp"), (7, "invalid_timestamp"), (b"text", "invalid_timestamp")])
def test_invalid_timestamp_is_not_empty_or_stringified(storage, value, warning):
    database(storage.twitter, [interview(timestamp=value)])
    row = get(storage, "platform=twitter").json["data"]["records"][0]
    assert row["timestamp"] is None and warning in row["warnings"]


def test_payload_timestamp_and_agent_projections_are_sql_bounded(storage, monkeypatch):
    payload = '{"prompt":"' + "x" * 2_000_000 + '","response":"tail"}'
    database(storage.twitter, [("x" * 500000, "interview", payload, "界" * 200000)])
    original = sqlite3.connect
    received = []
    def bounded_row(cursor, row):
        assert all(not isinstance(value, (str, bytes)) or len(value) <= reader.MAX_PAYLOAD_BYTES for value in row)
        received.append(row)
        return row
    def connect(*args, **kwargs):
        connection = original(*args, **kwargs)
        connection.row_factory = bounded_row
        return connection
    monkeypatch.setattr(sqlite3, "connect", connect)
    data = get(storage, "platform=twitter").json["data"]
    row = data["records"][0]
    assert row["payload_bytes"] == len(payload.encode()) and row["payload_kind"] == "raw"
    assert len(row["raw_preview"].encode()) <= reader.MAX_PAYLOAD_BYTES
    assert len(row["timestamp"].encode()) <= reader.MAX_TIMESTAMP_BYTES
    assert row["truncated"] is True
    assert {"payload_truncated", "timestamp_truncated", "invalid_agent_id"} <= set(row["warnings"])
    assert len(received) > 0


@pytest.mark.parametrize("value", ["代理 😀 café", "\ud800", "</textarea><script>literal</script>"])
def test_unicode_and_escaped_surrogates_are_literal(storage, value):
    database(storage.twitter, [interview(prompt=value, response=value)])
    response = get(storage, "platform=twitter")
    assert response.status_code == 200
    assert response.json["data"]["records"][0]["response"] == value
    assert response.json["data"]["records"][0]["prompt"] == value


def test_blob_json_and_negative_large_row_ids_are_preserved(storage):
    database(storage.twitter)
    conn = sqlite3.connect(storage.twitter)
    try:
        conn.executemany("INSERT INTO trace(rowid,user_id,action,info,created_at) VALUES (?,0,'interview',?,'t')", [
            (-9223372036854775808, b'{"prompt":"a","response":"b"}'),
            (9223372036854775807, b'{"prompt":"c","response":"d"}')])
        conn.commit()
    finally:
        conn.close()
    rows = get(storage, "platform=twitter").json["data"]["records"]
    assert [r["row_id"] for r in rows] == ["9223372036854775807", "-9223372036854775808"]
    assert all(r["payload_kind"] == "structured" for r in rows)


@pytest.mark.parametrize("suffix,maximum,warning", [("", "MAX_DATABASE_BYTES", "database_too_large"),
                                                     ("-wal", "MAX_WAL_BYTES", "wal_too_large")])
def test_oversized_source_is_skipped_before_connect_and_keeps_other_source(storage, monkeypatch, suffix, maximum, warning):
    database(storage.twitter, [interview()])
    database(storage.reddit, [interview(response="healthy")])
    path = Path(str(storage.twitter) + suffix)
    with path.open("ab") as stream:
        stream.truncate(getattr(reader, maximum) + 1)
    original = sqlite3.connect
    opened = []
    def connect(path, *args, **kwargs):
        opened.append(path)
        assert "twitter" not in path
        return original(path, *args, **kwargs)
    monkeypatch.setattr(sqlite3, "connect", connect)
    data = get(storage).json["data"]
    assert len(opened) == 1
    assert data["sources"]["twitter"]["status"] == "too_large"
    assert data["sources"]["twitter"]["has_more"] is None
    assert warning in data["sources"]["twitter"]["warnings"]
    assert [r["response"] for r in data["records"]] == ["healthy"] and data["availability"] == "partial"


@pytest.mark.parametrize("failure", [False, True])
def test_connections_are_readonly_bounded_and_closed_on_success_or_sql_failure(storage, monkeypatch, failure):
    database(storage.twitter, [interview()])
    if failure:
        connection = sqlite3.connect(storage.twitter)
        connection.execute("DROP TABLE trace")
        connection.close()
    original = sqlite3.connect
    opened = []
    def connect(path, **kwargs):
        assert path.endswith("?mode=ro") and "immutable" not in path
        assert kwargs == {"uri": True, "timeout": 0.25}
        connection = original(path, **kwargs)
        opened.append(connection)
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            connection.execute("CREATE TABLE should_not_write(value)")
        return connection
    monkeypatch.setattr(sqlite3, "connect", connect)
    response = get(storage, "platform=twitter")
    assert response.status_code == 200
    assert response.json["data"]["sources"]["twitter"]["status"] == ("unreadable" if failure else "available")
    assert len(opened) == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        opened[0].execute("SELECT 1")


def test_connection_failure_is_safe_and_other_platform_survives(storage, monkeypatch):
    database(storage.twitter, [interview()])
    database(storage.reddit, [interview(response="healthy")])
    original = sqlite3.connect
    def connect(path, **kwargs):
        if "twitter" in path:
            raise sqlite3.OperationalError("PRIVATE SQL /private/unsafe.db")
        return original(path, **kwargs)
    monkeypatch.setattr(sqlite3, "connect", connect)
    response = get(storage)
    assert response.status_code == 200
    assert response.json["data"]["sources"]["twitter"]["status"] == "unreadable"
    assert [r["response"] for r in response.json["data"]["records"]] == ["healthy"]
    assert "PRIVATE" not in response.get_data(as_text=True) and "/private" not in response.get_data(as_text=True)


def test_committed_wal_rows_are_visible_without_main_database_writes(storage):
    database(storage.twitter)
    writer = sqlite3.connect(storage.twitter)
    try:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("INSERT INTO trace VALUES (?,?,?,?)", interview(response="committed WAL"))
        writer.commit()
        assert Path(str(storage.twitter) + "-wal").stat().st_size > 0
        main_before = storage.twitter.read_bytes()
        wal_before = Path(str(storage.twitter) + "-wal").read_bytes()
        row = get(storage, "platform=twitter").json["data"]["records"][0]
        assert row["response"] == "committed WAL"
        assert storage.twitter.read_bytes() == main_before
        assert Path(str(storage.twitter) + "-wal").read_bytes() == wal_before
    finally:
        writer.close()


def test_lock_is_bounded_and_healthy_other_source_remains_usable(storage):
    database(storage.twitter, [interview()])
    database(storage.reddit, [interview(response="healthy")])
    writer = sqlite3.connect(storage.twitter)
    try:
        writer.execute("BEGIN EXCLUSIVE")
        started = time.monotonic()
        data = get(storage).json["data"]
        assert time.monotonic() - started < 3
        assert data["sources"]["twitter"]["status"] == "unreadable"
        assert [r["response"] for r in data["records"]] == ["healthy"]
    finally:
        writer.close()


@pytest.mark.parametrize("keep_recent", [False, True])
def test_vm_budget_keeps_observed_rows_and_healthy_source(storage, monkeypatch, keep_recent):
    rows = [(0, "post", "{}", "t")] * 20000
    if keep_recent:
        rows += [interview(response="first"), interview(response="second"), interview(response="third")]
    database(storage.twitter, rows)
    database(storage.reddit, [interview(response="healthy")])
    monkeypatch.setattr(reader, "MAX_VM_OPERATIONS", 5000)
    data = get(storage).json["data"]
    source = data["sources"]["twitter"]
    assert source["status"] == "query_limited" and source["has_more"] is None
    assert source["coverage"] == ("partial" if keep_recent else "unavailable")
    assert "query_limited" in source["warnings"]
    if keep_recent:
        assert [r["response"] for r in data["records"] if r["platform"] == "twitter"] == ["third", "second"]
    assert data["records"][-1]["response"] == "healthy" and data["availability"] == "partial"


def test_response_budget_is_real_encoded_bytes_and_retains_other_source(storage):
    # Control characters occupy six ASCII bytes per saved literal character;
    # invalid UTF-8 similarly expands in the safe JSON envelope.
    database(storage.twitter, [(0, "interview", b"\xff" * 16384, "t")] * 100)
    database(storage.reddit, [interview(response="healthy")])
    response = get(storage)
    assert response.status_code == 200 and len(response.data) <= 4 * 1024 * 1024
    data = response.json["data"]
    assert data["limits"]["response_bytes_per_platform"] == (4 * 1024 * 1024 - 8192) // 2
    twitter = data["sources"]["twitter"]
    assert 0 < twitter["returned_count"] < 100
    assert twitter["has_more"] is True and "response_limit" in twitter["warnings"]
    assert data["records"][-1]["response"] == "healthy"


def test_final_envelope_limit_and_unexpected_errors_are_safe(storage, monkeypatch):
    monkeypatch.setattr(reader, "MAX_RESPONSE_BYTES", 50)
    response = get(storage)
    assert response.status_code == 413 and response.json["error_code"] == "response_too_large"
    def broken(*args, **kwargs):
        raise RuntimeError("PRIVATE /unsafe/path")
    monkeypatch.setattr(reader, "read_saved_interviews", broken)
    response = get(storage)
    assert response.status_code == 500 and response.json["error_code"] == "interviews_unavailable"
    assert "PRIVATE" not in response.get_data(as_text=True)
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("kind", ["view", "without_rowid", "shadowed_rowids"])
def test_unsupported_schema_never_claims_complete_empty(storage, kind):
    connection = sqlite3.connect(storage.twitter)
    try:
        if kind == "view":
            connection.execute("CREATE VIEW trace AS SELECT 0 AS user_id, 'interview' AS action, '{}' AS info, 't' AS created_at")
        elif kind == "without_rowid":
            connection.execute("CREATE TABLE trace(user_id INTEGER PRIMARY KEY, action, info, created_at) WITHOUT ROWID")
        else:
            connection.execute("CREATE TABLE trace(user_id, action, info, created_at, rowid, _rowid_, oid)")
        connection.commit()
    finally:
        connection.close()
    data = get(storage, "platform=twitter").json["data"]
    assert data["availability"] == "unavailable"
    assert data["sources"]["twitter"]["status"] == "unreadable"


@pytest.mark.parametrize("bad_prefix", [False, True])
def test_truncated_utf8_prefix_omits_only_incomplete_tail_and_warns_real_errors(storage, bad_prefix):
    raw = (b"\xff" if bad_prefix else b"a") + b"a" * (reader.MAX_PAYLOAD_BYTES - 2) + "é".encode()
    database(storage.twitter, [(0, "interview", raw, "a" * 255 + "é")])
    response = get(storage, "platform=twitter")
    assert response.status_code == 200
    row = response.json["data"]["records"][0]
    assert row["timestamp"] == "a" * 255
    assert row["raw_preview"] == ("�" if bad_prefix else "a") + "a" * (reader.MAX_PAYLOAD_BYTES - 2)
    assert ("invalid_utf8" in row["warnings"]) is bad_prefix
    assert row["truncated"] is True
    assert {"timestamp_truncated", "payload_truncated"} <= set(row["warnings"])


@pytest.mark.parametrize("extra", [0, 1])
def test_exact_payload_and_timestamp_byte_limits(storage, extra):
    prefix, suffix = '{"prompt":"","response":"', '"}'
    payload = prefix + "a" * (reader.MAX_PAYLOAD_BYTES - len(prefix + suffix) + extra) + suffix
    database(storage.twitter, [(0, "interview", payload, "t" * (256 + extra))])
    data = get(storage, "platform=twitter").json["data"]
    row = data["records"][0]
    assert row["payload_bytes"] == 16384 + extra
    assert row["payload_kind"] == ("raw" if extra else "structured")
    assert row["truncated"] is bool(extra)
    assert ("payload_truncated" in row["warnings"]) is bool(extra)
    assert ("timestamp_truncated" in row["warnings"]) is bool(extra)
    assert data["limits"]["response_bytes_per_platform"] == 4186112


def test_invalid_utf8_sql_text_metadata_does_not_break_other_rows(storage):
    database(storage.twitter, [interview(response="healthy")])
    conn = sqlite3.connect(storage.twitter)
    try:
        conn.execute("INSERT INTO trace VALUES(CAST(X'FF' AS TEXT),'interview',CAST(X'FF' AS TEXT),CAST(X'FF' AS TEXT))")
        conn.commit()
    finally:
        conn.close()
    data = get(storage, "platform=twitter").json["data"]
    bad, healthy = data["records"]
    assert bad["agent_id"] is None and bad["timestamp"] == "�" and bad["raw_preview"] == "�"
    assert bad["warnings"].count("invalid_utf8") == 1
    assert healthy["response"] == "healthy" and data["availability"] == "partial"


def test_unshadowed_physical_rowid_alias_is_selected(storage):
    conn = sqlite3.connect(storage.twitter)
    try:
        conn.execute("CREATE TABLE trace(user_id,action,info,created_at,_rowid_)")
        conn.execute("INSERT INTO trace VALUES(0,'interview',?, 't', ?)",
                     (json.dumps({"prompt": "q", "response": "a"}), "x" * 500000))
        conn.commit()
    finally:
        conn.close()
    row = get(storage, "platform=twitter").json["data"]["records"][0]
    assert row["row_id"] == "1" and row["record_id"] == "twitter:1"


@pytest.mark.parametrize("suffix", ["", "-wal", "-shm", "-journal"])
def test_nonfile_database_or_sidecar_is_unreadable_without_open(storage, monkeypatch, suffix):
    if suffix:
        database(storage.twitter, [interview()])
    Path(str(storage.twitter) + suffix).mkdir()
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **k: pytest.fail("nonfile path reached SQLite"))
    data = get(storage, "platform=twitter").json["data"]
    assert data["sources"]["twitter"]["status"] == "unreadable" and data["availability"] == "unavailable"


def test_default_two_million_vm_budget_bounds_nonmatching_scan(storage):
    # A reverse table scan uses approximately three VM operations per row.
    database(storage.twitter, [(0, "post", "{}", "t")] * 750000)
    assert storage.twitter.stat().st_size < 160 * 1024 * 1024
    response = get(storage, "platform=twitter")
    assert response.status_code == 200
    data = response.json["data"]
    assert data["limits"]["vm_operations_per_platform"] == 2_000_000
    assert data["sources"]["twitter"]["status"] == "query_limited"
    assert data["sources"]["twitter"]["has_more"] is None
    assert data["availability"] == "unavailable"


@pytest.mark.parametrize("mode,retained,warning", [
    ("exhausted", 1, None), ("row_limit", 100, "row_limit"),
    ("response_limit", None, "response_limit"),
])
def test_close_failure_retires_completion_claims_but_keeps_observed_rows(storage, monkeypatch, mode, retained, warning):
    if mode == "response_limit":
        rows = [(0, "interview", b"\xff" * 16384, "t")] * 100
    else:
        rows = [interview(response="observed")] * (101 if mode == "row_limit" else 1)
    database(storage.twitter, rows)
    database(storage.reddit, [interview(response="healthy other platform")])
    original = sqlite3.connect
    opened = []
    class FailedClose(sqlite3.Connection):
        def close(self):
            super().close()
            raise sqlite3.OperationalError("PRIVATE close failure /unsafe/path")
    def connect(path, **kwargs):
        if "twitter" in path:
            connection = original(path, factory=FailedClose, **kwargs)
            opened.append(connection)
            return connection
        return original(path, **kwargs)
    monkeypatch.setattr(sqlite3, "connect", connect)
    response = get(storage)
    assert response.status_code == 200
    data = response.json["data"]
    source = data["sources"]["twitter"]
    assert source["status"] == "unreadable" and source["coverage"] == "partial"
    assert source["has_more"] is None
    if retained is not None:
        assert source["returned_count"] == retained
    else:
        assert 0 < source["returned_count"] < 100
        assert "record_warnings" in source["warnings"]
    if warning:
        assert warning not in source["warnings"]
    assert "source_unreadable" in source["warnings"]
    assert len(data["records"]) == source["returned_count"] + 1
    assert data["records"][-1]["response"] == "healthy other platform"
    assert data["sources"]["reddit"]["coverage"] == "complete"
    assert data["availability"] == "partial"
    assert "PRIVATE" not in response.get_data(as_text=True)
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        opened[0].execute("SELECT 1")
