"""Bounded observations of clean saved platform databases, without live services.

Only rollback-format sources without journal/sidecar entries are admitted.
Fingerprints detect ordinary saves; they are neither snapshots nor protection
against a hostile local writer replacing paths between validation and use.
"""
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import unicodedata

from . import simulation_comparison as saved
from ..storage import StoragePathError, storage_path, validate_record_id

MAX_DATABASE_BYTES = 134_217_728
MAX_METADATA_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 2_097_152
MAX_SQLITE_LENGTH = 2_097_152
MAX_OFFSET = 500_000
MAX_LIMIT = 100
DEFAULT_LIMIT = 25
MAX_VM_STEPS = 5_000_000
PROGRESS_STEPS = 1_000
BUSY_TIMEOUT_MS = 100
MAX_ID = 9_223_372_036_854_775_807
POST_FIELDS = ("post_id", "user_id", "original_post_id", "content", "quote_content", "created_at")
COMMENT_FIELDS = ("comment_id", "post_id", "user_id", "content", "created_at")
MAX_SEARCH_ROWS = 50_000
MAX_SEARCH_BYTES = 16_777_216
MAX_QUERY_POINTS = 200
MAX_FOLDED_QUERY = 600
MAX_FOLDED_FIELD = 6_291_456
MAX_FOLDED_TOTAL = 50_331_648
_QUERY_WHITESPACE = frozenset("\u0009\u000a\u000b\u000c\u000d\u001c\u001d\u001e\u001f\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000")


class _Refusal(ValueError):
    def __init__(self, reason):
        self.reason = reason


def _json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":"))


def response_too_large():
    return saved.ComparisonError("response_too_large", "This stored page exceeds the response limit.", 413)


def encode_response(data):
    encoded = _json({"success": True, "data": data})
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise response_too_large()
    return encoded


def _selected_id(value):
    if not isinstance(value, str) or re.fullmatch(r"0|[1-9][0-9]{0,18}", value) is None or int(value) > MAX_ID:
        raise saved.ComparisonError("invalid_selection", "Choose an exact nonnegative saved post ID within the supported range.")
    return value


def _selection(platform, offset, limit, post_id):
    if platform not in saved._PLATFORMS:
        raise saved.ComparisonError("invalid_filters", "Choose Twitter or Reddit explicitly.")
    if type(offset) is not int or not 0 <= offset <= MAX_OFFSET or type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        raise saved.ComparisonError("invalid_pagination", "Offset must be 0–500000 and page size must be 1–100.")
    if post_id is not None:
        _selected_id(post_id)


def parse_saved_posts_query(args):
    values = {}
    for key in args:
        if key not in {"platform", "offset", "limit"} or len(args.getlist(key)) != 1:
            raise saved.ComparisonError("invalid_filters", "Each supported query field must appear once.")
        values[key] = args[key]
    for key, default in (("offset", 0), ("limit", DEFAULT_LIMIT)):
        value = values.get(key)
        if value is None:
            values[key] = default
        elif not isinstance(value, str) or re.fullmatch(r"0|[1-9][0-9]{0,5}", value) is None:
            raise saved.ComparisonError("invalid_pagination", "Use canonical decimal pagination values.")
        else:
            values[key] = int(value)
    _selection(values.get("platform"), values["offset"], values["limit"], None)
    return values


def _search_selection(kind, q, case_sensitive):
    if kind not in {"posts", "comments"} or type(case_sensitive) is not bool:
        raise saved.ComparisonError("invalid_filters", "Choose Posts or Comments and an explicit case option.")
    if (not isinstance(q, str) or not 1 <= len(q) <= MAX_QUERY_POINTS
            or all(character in _QUERY_WHITESPACE for character in q)
            or any(unicodedata.category(character) in {"Cc", "Cs", "Zl", "Zp"} for character in q)):
        raise saved.ComparisonError("invalid_filters", "Enter 1–200 Unicode characters without control characters or line separators.")


def parse_saved_post_search_query(args):
    values = {}
    for key in args:
        if key not in {"platform", "kind", "q", "case_sensitive", "offset", "limit"} or len(args.getlist(key)) != 1:
            raise saved.ComparisonError("invalid_filters", "Each supported query field must appear once.")
        values[key] = args[key]
    for key, default in (("offset", 0), ("limit", DEFAULT_LIMIT)):
        value = values.get(key)
        if value is None:
            values[key] = default
        elif not isinstance(value, str) or re.fullmatch(r"0|[1-9][0-9]{0,5}", value) is None:
            raise saved.ComparisonError("invalid_pagination", "Use canonical decimal pagination values.")
        else:
            values[key] = int(value)
    case = values.get("case_sensitive", "false")
    if case not in {"true", "false"}:
        raise saved.ComparisonError("invalid_filters", "Match case must be true or false.")
    values["case_sensitive"] = case == "true"
    _selection(values.get("platform"), values["offset"], values["limit"], None)
    _search_selection(values.get("kind"), values.get("q"), values["case_sensitive"])
    return values


def _paths(simulation_root, run_root, simulation_id, platform):
    try:
        database = storage_path(simulation_root, simulation_id, f"{platform}_simulation.db")
        return {"state": storage_path(simulation_root, simulation_id, "state.json"),
                "run": storage_path(run_root, simulation_id, "run_state.json"),
                "database": database, **{suffix: database + "-" + suffix for suffix in ("wal", "shm", "journal")}}
    except StoragePathError:
        raise saved.ComparisonError("unsafe_path", "Saved simulation paths are unsafe.") from None


def _metadata(paths, before, simulation_id):
    context = {"state": "unavailable", "reason": None, "status": None, "partial": False, "warning": None}
    if before["state"] is None:
        context["reason"] = "state_missing"
        return context
    state = saved._metadata(paths["state"], MAX_METADATA_BYTES)
    if state is None or state.get("simulation_id") != simulation_id:
        context["reason"] = "state_unreadable"
        return context
    status = state.get("status")
    if not isinstance(status, str) or status not in saved._STATE_STATUSES:
        context["reason"] = "metadata_status_unknown"
        return context
    if before["run"] is None:
        context["warning"] = "run_state_missing"
    else:
        run = saved._metadata(paths["run"], MAX_METADATA_BYTES)
        if (run is None or run.get("simulation_id") != simulation_id
                or not isinstance(run.get("runner_status"), str)
                or run["runner_status"] not in saved._RUN_STATUSES):
            context["reason"] = "run_state_unreadable"
            return context
        status = run["runner_status"]
    context["status"] = status
    context["partial"] = status in {"stopped", "failed"}
    if status in saved._ACTIVE:
        context["reason"] = "simulation_active"
    elif status not in saved._TERMINAL:
        context["reason"] = "simulation_not_terminal"
    else:
        context["state"] = "available"
    return context


def _admit_database(paths, before):
    if any(before[name] is not None for name in ("wal", "shm", "journal")):
        raise _Refusal("unsupported_journal")
    info = before["database"]
    if info is None:
        raise _Refusal("database_missing")
    if info[0] == "unreadable" or not stat.S_ISREG(info[2]):
        raise _Refusal("source_unreadable")
    if info[3] > MAX_DATABASE_BYTES:
        raise _Refusal("source_too_large")
    try:
        with saved._open_source(paths["database"]) as stream:
            if os.fstat(stream.fileno()).st_size > MAX_DATABASE_BYTES:
                raise _Refusal("source_too_large")
            header = stream.read(100)
    except (OSError, saved._SourceUnreadable):
        raise _Refusal("source_unreadable") from None
    if len(header) != 100 or header[:16] != b"SQLite format 3\0":
        raise _Refusal("unsupported_source")
    if header[18:20] != b"\x01\x01":
        raise _Refusal("unsupported_journal")


def _page(offset, limit, reason):
    return {"state": "unavailable", "reason": reason, "offset": offset, "limit": limit,
            "count": None, "has_more": None, "rows": []}


def _post(reason):
    return {"state": "unavailable", "reason": reason, "row": None}


class _EnvelopeBudget:
    """Exact ASCII envelope accounting; a refused component retains no rows."""
    def __init__(self, data):
        self.data = data
        self.size = len(_json({"success": True, "data": data}))

    def allowance(self, key):
        return MAX_RESPONSE_BYTES - self.size + len(_json(self.data[key]))

    def replace(self, key, value):
        size = len(_json(value))
        if size > self.allowance(key):
            raise _Refusal("response_too_large")
        self.size += size - len(_json(self.data[key]))
        self.data[key] = value


def _schema(connection, table, fields):
    # table_list distinguishes ordinary tables from views/virtual/shadow tables;
    # wr=0 avoids changing the pinned rowid-table primary-key convention.
    entry = connection.execute(
        "SELECT type, wr FROM pragma_table_list WHERE schema = 'main' AND name = ?", (table,)
    ).fetchone()
    if entry is None:
        raise _Refusal("table_missing")
    if entry != ("table", 0):
        raise _Refusal("unsupported_schema")
    columns = {}
    for row in connection.execute(f'PRAGMA main.table_xinfo("{table}")'):
        columns[row[1]] = row
    primary = [row for row in columns.values() if row[5]]
    if (any(name not in columns or columns[name][6] != 0 for name in fields)
            or len(primary) != 1 or primary[0][1] != fields[0]
            or primary[0][2].upper() != "INTEGER" or primary[0][5] != 1):
        raise _Refusal("unsupported_schema")


def _id(value, nullable=False):
    if value is None and nullable:
        return None
    if type(value) is not int or not 0 <= value <= MAX_ID:
        raise _Refusal("invalid_row")
    return str(value)


def _text(value):
    if value is None or isinstance(value, str):
        return value
    raise _Refusal("invalid_row")


def _time(value):
    if value is None or isinstance(value, str):
        return value
    if type(value) is int:
        return str(value)
    if type(value) is float and math.isfinite(value):
        return repr(value)
    raise _Refusal("invalid_row")


def _row(values, fields, post_id=None):
    row = dict(zip(fields, values))
    for field in fields:
        if field.endswith("_id"):
            row[field] = _id(row[field], nullable=field in {"user_id", "original_post_id"})
        elif field == "created_at":
            row[field] = _time(row[field])
        else:
            row[field] = _text(row[field])
    if post_id is not None and row["post_id"] != post_id:
        raise _Refusal("invalid_row")
    return row


def _failure(error):
    if isinstance(error, _Refusal):
        return error.reason
    code = getattr(error, "sqlite_errorcode", None)
    if code is not None:
        code &= 255
    if code == sqlite3.SQLITE_INTERRUPT:
        return "query_budget"
    if code in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
        return "database_busy"
    if code == sqlite3.SQLITE_TOOBIG:
        return "response_too_large"
    return "database_unreadable"


def _read_page(connection, table, fields, offset, limit, allowance, post_id=None):
    _schema(connection, table, fields)
    where = " WHERE post_id = ?" if post_id is not None else ""
    params = (int(post_id),) if post_id is not None else ()
    order = "ASC" if table == "comment" else "DESC"
    suffix = f' FROM "{table}"{where} ORDER BY "{fields[0]}" {order}'
    # Only identity is projected for the undisplayed row. Its potentially huge
    # content cannot make an otherwise valid displayed page unavailable.
    extra = connection.execute(f'SELECT "{fields[0]}"{suffix} LIMIT 1 OFFSET ?', params + (offset + limit,)).fetchone()
    page = {"state": "available", "reason": None, "offset": offset, "limit": limit,
            "count": 0, "has_more": extra is not None, "rows": []}
    encoded_size = len(_json(page))
    cursor = connection.execute(f'SELECT {",".join(fields)}{suffix} LIMIT ? OFFSET ?', params + (limit, offset))
    for values in cursor:
        row = _row(values, fields, post_id)
        count = len(page["rows"]) + 1
        encoded_size += len(_json(row)) + (count > 1) + len(str(count)) - len(str(count - 1))
        if encoded_size > allowance:
            raise _Refusal("response_too_large")
        page["rows"].append(row)
        page["count"] = count
    if not page["rows"]:
        page["state"] = "out_of_range" if offset else "empty"
    return page


def _read_components(connection, data, offset, limit, post_id):
    budget = _EnvelopeBudget(data)
    if post_id is None:
        try:
            budget.replace("posts", _read_page(connection, "post", POST_FIELDS, offset, limit, budget.allowance("posts")))
        except (_Refusal, sqlite3.Error, UnicodeError) as error:
            budget.replace("posts", _page(offset, limit, _failure(error)))
        return
    try:
        _schema(connection, "post", POST_FIELDS)
        values = connection.execute(f'SELECT {",".join(POST_FIELDS)} FROM post WHERE post_id = ?', (int(post_id),)).fetchone()
        if values is None:
            budget.replace("post", {"state": "missing", "reason": "post_missing", "row": None})
            return
        budget.replace("post", {"state": "available", "reason": None, "row": _row(values, POST_FIELDS, post_id)})
    except (_Refusal, sqlite3.Error, UnicodeError) as error:
        budget.replace("post", _post(_failure(error)))
        return
    try:
        budget.replace("comments", _read_page(connection, "comment", COMMENT_FIELDS, offset, limit, budget.allowance("comments"), post_id))
    except (_Refusal, sqlite3.Error, UnicodeError) as error:
        budget.replace("comments", _page(offset, limit, _failure(error)))


def _search_page(offset, limit, reason):
    return {**_page(offset, limit, reason), "matched_count": None}


def _read_search(connection, kind, q, case_sensitive, offset, limit, allowance):
    """Validate the whole selected table, retaining only one matching page."""
    table, fields = ("post", POST_FIELDS) if kind == "posts" else ("comment", COMMENT_FIELDS)
    _schema(connection, table, fields)
    order = "DESC" if kind == "posts" else "ASC"
    suffix = f' FROM "{table}" ORDER BY "{fields[0]}" {order}'
    # Admit cardinality without decoding a 50001st row's potentially huge text.
    if connection.execute(f'SELECT "{fields[0]}"{suffix} LIMIT 1 OFFSET ?', (MAX_SEARCH_ROWS,)).fetchone() is not None:
        raise _Refusal("search_limit")
    needle = q if case_sensitive else q.casefold()
    if not case_sensitive and len(needle) > MAX_FOLDED_QUERY:
        raise _Refusal("search_limit")
    page = {"state": "available", "reason": None, "offset": offset, "limit": limit,
            "count": 0, "matched_count": 0, "has_more": False, "rows": []}
    row_bytes = folded_points = scanned = matched = 0
    # A future match can shorten false to true by one byte. Stage against
    # that lower bound, then check exact counters/flags/state at successful EOF.
    staged_bytes = len(_json(page)) - 1
    text_fields = ("content", "quote_content") if kind == "posts" else ("content",)
    cursor = connection.execute(f'SELECT {",".join(fields)}{suffix} LIMIT ?', (MAX_SEARCH_ROWS,))
    for values in cursor:
        scanned += 1
        if scanned > MAX_SEARCH_ROWS:
            raise _Refusal("search_limit")
        row = _row(values, fields)
        size = len(_json(row))
        row_bytes += size
        if row_bytes > MAX_SEARCH_BYTES:
            raise _Refusal("search_limit")
        matches = False
        for field in text_fields:
            text = row[field]
            if text is None:
                continue
            if case_sensitive:
                matches |= needle in text
            else:
                folded = text.casefold()
                points = len(folded)
                folded_points += points
                if points > MAX_FOLDED_FIELD or folded_points > MAX_FOLDED_TOTAL:
                    raise _Refusal("search_limit")
                matches |= needle in folded
                del folded
        if not matches:
            continue
        matched += 1
        if offset < matched <= offset + limit:
            count = len(page["rows"]) + 1
            staged_bytes += size + (count > 1) + len(str(count)) - len(str(count - 1))
            if staged_bytes > allowance:
                raise _Refusal("response_too_large")
            page["rows"].append(row)
            page["count"] = count
    # Nothing is accepted until EOF, including count width and final state.
    page["matched_count"] = matched
    page["has_more"] = offset + page["count"] < matched
    if not page["rows"]:
        page["state"] = "out_of_range" if offset else "empty"
    if len(_json(page)) > allowance:
        raise _Refusal("response_too_large")
    return page


def read_saved_post_search(simulation_root, run_root, simulation_id, *, platform, kind, q,
                           case_sensitive=False, offset=0, limit=DEFAULT_LIMIT):
    """Search one saved table in a fresh, bounded, read-only observation."""
    try:
        validate_record_id(simulation_id)
    except StoragePathError:
        raise saved.ComparisonError("invalid_selection", "Choose a valid saved simulation ID.") from None
    _selection(platform, offset, limit, None)
    _search_selection(kind, q, case_sensitive)
    paths = _paths(simulation_root, run_root, simulation_id, platform)
    before = saved._snapshot(paths)
    metadata = _metadata(paths, before, simulation_id)
    data = {"simulation_id": simulation_id, "platform": platform,
            "observed_at": datetime.now(timezone.utc).isoformat(), "metadata": metadata,
            "database": {"state": "unavailable", "reason": "metadata_unavailable"},
            "search": {"kind": kind, "q": q, "case_sensitive": case_sensitive},
            "results": _search_page(offset, limit, "metadata_unavailable")}
    connection = None
    if metadata["state"] == "available":
        try:
            _admit_database(paths, before)
            if before != saved._snapshot(paths):
                raise saved.ComparisonError("sources_changed", "Saved sources changed. Refresh to read again.", 409)
            connection = sqlite3.connect(Path(paths["database"]).as_uri() + "?mode=ro", uri=True, timeout=BUSY_TIMEOUT_MS / 1000)
            connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_SQLITE_LENGTH)
            steps = 0
            def progress():
                nonlocal steps
                steps += PROGRESS_STEPS
                return int(steps >= MAX_VM_STEPS)
            connection.set_progress_handler(progress, PROGRESS_STEPS)
            connection.execute("PRAGMA query_only = ON")
            connection.execute("BEGIN")
            data["database"] = {"state": "available", "reason": None}
            budget = _EnvelopeBudget(data)
            try:
                budget.replace("results", _read_search(connection, kind, q, case_sensitive, offset, limit, budget.allowance("results")))
            except (_Refusal, sqlite3.Error, UnicodeError) as error:
                budget.replace("results", _search_page(offset, limit, _failure(error)))
        except (_Refusal, sqlite3.Error, OSError) as error:
            reason = _failure(error)
            data["database"] = {"state": "unavailable", "reason": reason}
            data["results"] = _search_page(offset, limit, reason)
        finally:
            if connection is not None:
                connection.close()
    if before != saved._snapshot(paths):
        raise saved.ComparisonError("sources_changed", "Saved sources changed. Refresh to read again.", 409)
    encode_response(data)
    return data


def read_saved_posts(simulation_root, run_root, simulation_id, *, platform, offset=0, limit=DEFAULT_LIMIT, post_id=None):
    """Read a fresh page, or exact post and flat comments, in one transaction."""
    try:
        validate_record_id(simulation_id)
    except StoragePathError:
        raise saved.ComparisonError("invalid_selection", "Choose a valid saved simulation ID.") from None
    _selection(platform, offset, limit, post_id)
    paths = _paths(simulation_root, run_root, simulation_id, platform)
    before = saved._snapshot(paths)
    metadata = _metadata(paths, before, simulation_id)
    data = {"simulation_id": simulation_id, "platform": platform, "post_id": post_id,
            "observed_at": datetime.now(timezone.utc).isoformat(), "metadata": metadata,
            "database": {"state": "unavailable", "reason": "metadata_unavailable"},
            "posts": _page(offset, limit, "metadata_unavailable") if post_id is None else None,
            "post": _post("metadata_unavailable") if post_id is not None else None,
            "comments": _page(offset, limit, "post_unavailable") if post_id is not None else None}
    connection = None
    if metadata["state"] == "available":
        try:
            _admit_database(paths, before)
            # Recheck admission fingerprints immediately before the connection;
            # the final check still owns/discards the complete observation.
            if before != saved._snapshot(paths):
                raise saved.ComparisonError("sources_changed", "Saved sources changed. Refresh to read again.", 409)
            connection = sqlite3.connect(Path(paths["database"]).as_uri() + "?mode=ro", uri=True, timeout=BUSY_TIMEOUT_MS / 1000)
            connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_SQLITE_LENGTH)
            steps = 0
            def progress():
                nonlocal steps
                steps += PROGRESS_STEPS
                return int(steps >= MAX_VM_STEPS)
            connection.set_progress_handler(progress, PROGRESS_STEPS)
            connection.execute("PRAGMA query_only = ON")
            connection.execute("BEGIN")
            data["database"] = {"state": "available", "reason": None}
            _read_components(connection, data, offset, limit, post_id)
        except (_Refusal, sqlite3.Error, OSError) as error:
            reason = _failure(error)
            data["database"] = {"state": "unavailable", "reason": reason}
            if post_id is None:
                data["posts"] = _page(offset, limit, reason)
            else:
                data["post"] = _post(reason)
                data["comments"] = _page(offset, limit, "post_unavailable")
        finally:
            if connection is not None:
                connection.close()
    if before != saved._snapshot(paths):
        raise saved.ComparisonError("sources_changed", "Saved sources changed. Refresh to read again.", 409)
    encode_response(data)
    return data
