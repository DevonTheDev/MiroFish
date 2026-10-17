"""Finite source-only draft. Do not collect or execute before runtime release.

Expanded cases are the explicit subTest IDs below; @allocation budgets include
all product-reader calls (including expected refusals), excluding setup SQLite.
"""
import json
import os
import sqlite3
from unittest.mock import patch

from saved_posts_support import (Fixture, FixedDatetime, Query, allocation, saved,
    MAX_ID, POST_SCHEMA, COMMENT_SCHEMA, POST_KEYS, COMMENT_KEYS, ENVELOPE_KEYS)


class SavedPostsTests(Fixture):
    @allocation(reads=4)
    def test_exact_platform_rows_and_flat_relationships(self):
        for platform in ("twitter", "reddit"):
            self.post(MAX_ID, platform=platform, user_id=9007199254740993, original_post_id=0, quote_content=platform)
            self.comment(MAX_ID, MAX_ID, platform=platform, user_id=9007199254740993)
            self.comment(0, 0, platform=platform, content="belongs only to original")
            with self.subTest(platform=platform):
                data = self.read(platform)
                self.assertEqual(set(data), ENVELOPE_KEYS)
                self.assertEqual(data["platform"], platform)
                self.assertEqual(set(data["posts"]["rows"][0]), POST_KEYS)
                self.assertEqual(data["posts"]["rows"][0]["user_id"], "9007199254740993")
                detail = self.read(platform, post_id=str(MAX_ID))
                self.assertEqual(detail["post"]["row"]["original_post_id"], "0")
                self.assertEqual(detail["post"]["row"]["quote_content"], platform)
                self.assert_page(detail["comments"], "available", ids=[str(MAX_ID)], id_key="comment_id")
                self.assertEqual(set(detail["comments"]["rows"][0]), COMMENT_KEYS)
                self.assertEqual(detail["comments"]["rows"][0]["post_id"], str(MAX_ID))
                self.assertNotIn("original", json.dumps(detail["comments"]))

    @allocation(reads=1)
    def test_zero_ids_nulls_quote_repost_and_unusual_saved_fields(self):
        for row in (
            dict(post_id=0, user_id=None, content=None, original_post_id=None, quote_content=None, created_at=None),
            dict(post_id=1, content="copied original", original_post_id=0, quote_content="quote by user 0"),
            dict(post_id=2, content="", original_post_id=0, quote_content=None),
            dict(post_id=3, content="neutral", original_post_id=None, quote_content="unusual saved combination"),
        ):
            self.post(**row)
        rows = self.read()["posts"]["rows"]
        self.assertEqual([row["post_id"] for row in rows], ["3", "2", "1", "0"])
        self.assertEqual(rows[-1], dict(post_id="0", user_id=None, content=None, original_post_id=None, quote_content=None, created_at=None))
        self.assertEqual((rows[1]["content"], rows[1]["original_post_id"], rows[1]["quote_content"]), ("", "0", None))
        self.assertEqual(rows[2]["quote_content"], "quote by user 0")

    @allocation(reads=1)
    def test_stored_numeric_times_are_lossless_text_not_dates(self):
        for index, value in enumerate((MAX_ID, 1.25, "2020? raw\ntime", None)):
            self.post(index, created_at=value)
        rows = self.read()["posts"]["rows"]
        self.assertEqual([row["created_at"] for row in reversed(rows)], [str(MAX_ID), "1.25", "2020? raw\ntime", None])

    @allocation(reads=12)
    def test_missing_columns_views_and_noninteger_or_composite_keys_refuse(self):
        schemas = {
            "missing_quote": POST_SCHEMA.replace("quote_content TEXT,", ""),
            "missing_reference": POST_SCHEMA.replace("original_post_id INTEGER,", ""),
            "missing_user": POST_SCHEMA.replace("user_id INTEGER,", ""),
            "missing_time": POST_SCHEMA.replace("created_at DATETIME,", ""),
            "text_primary_key": POST_SCHEMA.replace("post_id INTEGER PRIMARY KEY", "post_id TEXT PRIMARY KEY"),
            "not_primary_key": POST_SCHEMA.replace("post_id INTEGER PRIMARY KEY", "post_id INTEGER"),
            "composite_primary_key": POST_SCHEMA.replace("post_id INTEGER PRIMARY KEY", "post_id INTEGER").replace("num_shares INTEGER DEFAULT 0)", "num_shares INTEGER DEFAULT 0, PRIMARY KEY(post_id,user_id))"),
            "without_rowid": POST_SCHEMA + " WITHOUT ROWID",
            "view": "CREATE VIEW post AS SELECT 1 AS post_id, 0 AS user_id, NULL AS original_post_id, 'text' AS content, NULL AS quote_content, NULL AS created_at",
            "virtual_table": "CREATE VIRTUAL TABLE post USING fts5(post_id,user_id,original_post_id,content,quote_content,created_at)",
            "missing_table": None,
            "generated_rendered_field": POST_SCHEMA.replace("quote_content TEXT", "quote_content TEXT GENERATED ALWAYS AS (content) VIRTUAL"),
        }
        for case, schema in schemas.items():
            with self.subTest(case=case):
                self.make_database("twitter", post_schema=schema)
                self.assert_page(self.read()["posts"], "unavailable", reason="table_missing" if schema is None else "unsupported_schema")

    @allocation(reads=5)
    def test_comments_empty_missing_unsupported_corrupt_and_missing_post_are_distinct(self):
        self.post()
        self.assert_page(self.read(post_id="1")["comments"], "empty", ids=[])
        self.sql("DROP TABLE comment")
        self.assert_page(self.read(post_id="1")["comments"], "unavailable", reason="table_missing")
        self.sql("CREATE VIEW comment AS SELECT 1 AS comment_id")
        data = self.read(post_id="1")
        self.assertEqual(data["post"]["state"], "available")
        self.assert_page(data["comments"], "unavailable", reason="unsupported_schema")
        self.sql("DROP VIEW comment")
        self.sql(COMMENT_SCHEMA)
        self.comment(content=b"invalid blob")
        self.assert_page(self.read(post_id="1")["comments"], "unavailable", reason="invalid_row")
        missing = self.read(post_id="99")
        self.assertEqual(missing["post"], {"state": "missing", "reason": "post_missing", "row": None})
        self.assert_page(missing["comments"], "unavailable", reason="post_unavailable")

    @allocation(reads=7)
    def test_invalid_returned_post_row_refuses_entire_page(self):
        cases = {"negative_id": ("post_id", -1), "negative_user": ("user_id", -1),
                 "fractional_user": ("user_id", 0.5), "text_user": ("user_id", "bad"),
                 "negative_original": ("original_post_id", -1), "blob_content": ("content", b"bad"),
                 "blob_quote": ("quote_content", b"bad")}
        for case, (field, value) in cases.items():
            with self.subTest(case=case):
                self.make_database("twitter")
                self.post(2)
                self.post(1, content="would otherwise be readable")
                self.sql(f"UPDATE post SET {field}=? WHERE post_id=2", (value,))
                self.assert_page(self.read()["posts"], "unavailable", reason="invalid_row")

    @allocation(reads=3)
    def test_validation_is_page_scoped_and_does_not_claim_whole_database(self):
        self.post(3)
        self.post(2, user_id=-1)
        self.post(1)
        self.assert_page(self.read(limit=1)["posts"], "available", ids=["3"], has_more=True)
        self.assert_page(self.read(limit=1, offset=1)["posts"], "unavailable", reason="invalid_row")
        self.assert_page(self.read(limit=1, offset=2)["posts"], "available", ids=["1"])

    @allocation(reads=5)
    def test_unique_id_order_pages_empty_and_positive_offset(self):
        self.assert_page(self.read()["posts"], "empty", ids=[])
        for value in (0, 4, 2):
            self.post(value, content="repeated", created_at=1)
            self.comment(value, 4, content="repeated", created_at=1)
        self.assert_page(self.read(limit=2)["posts"], "available", ids=["4", "2"], has_more=True)
        self.assert_page(self.read(limit=2, offset=2)["posts"], "available", ids=["0"])
        self.assert_page(self.read(limit=2, offset=3)["posts"], "out_of_range", ids=[])
        self.assert_page(self.read(post_id="4", limit=2)["comments"], "available", ids=["0", "2"], id_key="comment_id", has_more=True)

    @allocation(reads=3)
    def test_default_and_endpoint_page_sizes_and_maximum_offset(self):
        self.sql("INSERT INTO post (post_id,content) VALUES (?,?)", [(value, "text") for value in range(101)], many=True)
        for case, kwargs, count in (("default", {}, 25), ("maximum_limit", {"limit": 100}, 100),
                                    ("maximum_offset", {"limit": 1, "offset": 500000}, 0)):
            with self.subTest(case=case):
                page = self.read(**kwargs)["posts"]
                self.assertEqual(page["count"], count)
                self.assertEqual(page["state"], "available" if count else "out_of_range")

    @allocation(reads=2)
    def test_id_only_lookahead_does_not_decode_huge_undisplayed_text(self):
        self.post(2, content="visible small post")
        self.post(1, content="x" * (2097152 + 1))
        self.assert_page(self.read(limit=1)["posts"], "available", ids=["2"], has_more=True)
        self.assert_page(self.read(limit=1, offset=1)["posts"], "unavailable", reason="response_too_large")

    @allocation(reads=15)
    def test_direct_selection_rejects_before_paths(self):
        cases = [dict(post_id=value) for value in ("", "00", "-1", "+1", "1.0", "1e1", "9223372036854775808", 1)]
        cases += [dict(platform=value) for value in ("", "Twitter", "../outside")]
        cases += [dict(offset=value) for value in (-1, 500001)] + [dict(limit=value) for value in (0, 101)]
        with patch.object(saved, "_paths", side_effect=AssertionError("invalid selection reached storage")):
            for index, values in enumerate(cases):
                with self.subTest(case=index, values=values):
                    code = "invalid_selection" if "post_id" in values else "invalid_filters" if "platform" in values else "invalid_pagination"
                    self.assert_error(code, call=lambda: self.read(**values))

    @allocation()
    def test_query_rejects_duplicate_unknown_and_noncanonical_fields(self):
        cases = [([(field, "1")], "invalid_filters") for field in ("q", "post_id", "revision", "sort")]
        cases += [([(field, value), (field, value)], "invalid_filters") for field, value in (("platform", "twitter"), ("offset", "0"), ("limit", "25"))]
        cases += [([("platform", "twitter"), (field, value)], "invalid_pagination") for field, value in
                  (("offset", "00"), ("offset", "-1"), ("offset", "500001"), ("offset", "1.0"), ("limit", "0"), ("limit", "101"), ("limit", ""))]
        cases += [([], "invalid_filters"), ([("platform", "Twitter")], "invalid_filters")]
        for index, (pairs, code) in enumerate(cases):
            with self.subTest(case=index):
                self.assert_error(code, call=lambda: saved.parse_saved_posts_query(Query(pairs)))
        self.assertEqual(saved.parse_saved_posts_query(Query([("platform", "reddit")])), {"platform": "reddit", "offset": 0, "limit": 25})

    @allocation(reads=6)
    def test_unsafe_record_ids_are_rejected_before_paths(self):
        for value in ("..", "../other", "CON", "lpt1", "sim:stream", "sim_A."):
            with self.subTest(simulation_id=value), patch.object(saved, "_paths", side_effect=AssertionError("unsafe ID reached paths")):
                self.assert_error("invalid_selection", call=lambda: self.service(str(self.sim_root), str(self.run_root), value, platform="twitter"))

    @allocation(reads=4)
    def test_symlink_paths_are_refused_without_opening_sqlite(self):
        for kind in ("state", "run", "twitter", "simulation_directory"):
            with self.subTest(kind=kind):
                target = self.root / ("outside_" + kind)
                source = self.path(kind) if kind != "simulation_directory" else self.path("state").parent
                source.rename(target)
                source.symlink_to(target, target_is_directory=kind == "simulation_directory")
                try:
                    with patch.object(saved.sqlite3, "connect", side_effect=AssertionError("symlink connected")):
                        self.assert_error("unsafe_path")
                finally:
                    source.unlink()
                    target.rename(source)

    @allocation(reads=6)
    def test_any_sidecar_entry_is_refused_before_connect_and_unchanged(self):
        for suffix in ("wal", "shm", "journal"):
            for kind in ("empty_file", "directory"):
                with self.subTest(suffix=suffix, kind=kind):
                    path = self.path().with_name(self.path().name + "-" + suffix)
                    path.touch() if kind == "empty_file" else path.mkdir()
                    before = self.inventory()
                    with patch.object(saved.sqlite3, "connect", side_effect=AssertionError("unsupported journal connected")):
                        self.assert_page(self.read()["posts"], "unavailable", reason="unsupported_journal")
                    self.assertEqual(self.inventory(), before)
                    path.unlink() if kind == "empty_file" else path.rmdir()

    @allocation(reads=5)
    def test_header_and_nonregular_source_refusals_are_not_empty(self):
        original = self.path().read_bytes()
        cases = {"short": b"SQLite format 3\0", "bad_magic": b"x" * 100,
                 "wal_write": original[:18] + b"\x02\x01" + original[20:],
                 "wal_read": original[:18] + b"\x01\x02" + original[20:]}
        for case, payload in cases.items():
            with self.subTest(case=case):
                self.path().write_bytes(payload)
                with patch.object(saved.sqlite3, "connect", side_effect=AssertionError("unsupported header connected")):
                    self.assert_page(self.read()["posts"], "unavailable", reason="unsupported_journal" if case.startswith("wal_") else "unsupported_source")
        self.path().unlink()
        self.path().mkdir()
        with patch.object(saved.sqlite3, "connect", side_effect=AssertionError("directory connected")):
            self.assert_page(self.read()["posts"], "unavailable", reason="source_unreadable")

    @allocation(reads=2)
    def test_missing_database_and_state_create_nothing(self):
        self.path().unlink()
        before = self.inventory()
        self.assert_page(self.read()["posts"], "unavailable", reason="database_missing")
        self.assertEqual(self.inventory(), before)
        data = self.service(str(self.sim_root), str(self.run_root), "sim_missing", platform="reddit")
        self.assertEqual(data["metadata"]["reason"], "state_missing")
        self.assertEqual(self.inventory(), before)

    @allocation(reads=6)
    def test_run_state_precedence_terminal_partial_and_active(self):
        cases = (("running", "completed", "available", False), ("completed", "running", "unavailable", False),
                 ("completed", "stopped", "available", True), ("completed", "failed", "available", True),
                 ("ready", "completed", "available", False), ("completed", "idle", "unavailable", False))
        for state, run, availability, partial in cases:
            with self.subTest(state=state, run=run):
                self.state["status"], self.run["runner_status"] = state, run
                self.write_metadata()
                data = self.read()
                self.assertEqual(data["metadata"]["status"], run)
                self.assertEqual(data["metadata"]["state"], availability)
                self.assertIs(data["metadata"]["partial"], partial)
                self.assertIsNone(data["metadata"]["warning"])

    @allocation(reads=8)
    def test_absent_run_fallback_and_all_active_nonterminal_states(self):
        self.path("run").unlink()
        for status in ("completed", "starting", "running", "paused", "stopping", "created", "preparing", "ready"):
            with self.subTest(status=status):
                self.state["status"] = status
                self.path("state").write_text(json.dumps(self.state))
                data = self.read()
                self.assertEqual(data["metadata"]["warning"], "run_state_missing")
                self.assertEqual(data["metadata"]["reason"], None if status == "completed" else "simulation_active" if status in ("starting", "running", "paused", "stopping") else "simulation_not_terminal")

    @allocation(reads=7)
    def test_present_bad_run_never_silently_falls_back(self):
        cases = {"malformed": b"{", "array": b"[]", "unknown": b'{"simulation_id":"sim_A","runner_status":"mystery"}',
                 "mismatch": b'{"simulation_id":"sim_B","runner_status":"completed"}',
                 "missing_id": b'{"runner_status":"completed"}', "missing_status": b'{"simulation_id":"sim_A"}', "invalid_utf8": b"\xff"}
        for case, value in cases.items():
            with self.subTest(case=case):
                self.path("run").write_bytes(value)
                with patch.object(saved.sqlite3, "connect", side_effect=AssertionError("bad run admitted")):
                    data = self.read()
                self.assertEqual(data["metadata"]["reason"], "run_state_unreadable")
                self.assertIsNone(data["metadata"]["warning"])
                self.assert_page(data["posts"], "unavailable", reason="metadata_unavailable")

    @allocation(reads=3)
    def test_valid_matching_state_remains_required(self):
        for case, value in (("malformed", b"{"), ("mismatch", b'{"simulation_id":"other","status":"completed"}'),
                            ("unknown_status", b'{"simulation_id":"sim_A","status":"mystery"}')):
            with self.subTest(case=case):
                self.path("state").write_bytes(value)
                with patch.object(saved.sqlite3, "connect", side_effect=AssertionError("bad state admitted")):
                    data = self.read()
                self.assertEqual(data["metadata"]["reason"], "metadata_status_unknown" if case == "unknown_status" else "state_unreadable")

    @allocation(reads=1)
    def test_metadata_only_admission_never_scans_actions_or_instantiates_runtime(self):
        self.post(platform="reddit")  # enable_reddit=False must not redirect or erase rows.
        forbidden = ("_paths", "_read_log", "_context")
        with patch.multiple(saved.saved, **{name: lambda *a, **k: self.fail("activity helper used") for name in forbidden}):
            data = self.read("reddit")
        self.assert_page(data["posts"], "available", ids=["1"])

    @allocation(reads=2)
    def test_mode_ro_one_transaction_length_limit_timeout_and_close(self):
        original, opened, statements, limits = sqlite3.connect, [], [], []
        class InspectConnection(sqlite3.Connection):
            def setlimit(connection, category, limit):
                limits.append((category, limit))
                return super().setlimit(category, limit)
        def connect(database_uri, **kwargs):
            self.assertTrue(database_uri.endswith("?mode=ro"))
            self.assertNotIn("immutable", database_uri)
            self.assertNotIn("nolock", database_uri)
            self.assertEqual(kwargs, {"uri": True, "timeout": 0.1})
            connection = original(database_uri, **kwargs, factory=InspectConnection)
            connection.set_trace_callback(statements.append)
            opened.append(connection)
            return connection
        self.post()
        before = self.inventory()
        with patch.object(saved.sqlite3, "connect", connect):
            self.read()
            self.read(post_id="1")
        self.assertEqual(len(opened), 2)
        self.assertEqual(statements.count("BEGIN"), 2)
        self.assertEqual(limits, [(sqlite3.SQLITE_LIMIT_LENGTH, 2097152)] * 2)
        self.assertFalse(any("journal_mode" in statement.lower() for statement in statements))
        for connection in opened:
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute("SELECT 1")
        self.assertEqual(self.inventory(), before)

    @allocation(reads=1)
    def test_failure_after_connect_still_closes_and_preserves_sources(self):
        original, opened = sqlite3.connect, []
        class BrokenConnection(sqlite3.Connection):
            def execute(connection, statement, parameters=()):
                if statement == "BEGIN":
                    raise sqlite3.OperationalError("PRIVATE_ERROR /private/source")
                return super().execute(statement, parameters)
        def connect(*args, **kwargs):
            connection = original(*args, **kwargs, factory=BrokenConnection)
            opened.append(connection)
            return connection
        before = self.inventory()
        with patch.object(saved.sqlite3, "connect", connect):
            self.assert_page(self.read()["posts"], "unavailable", reason="database_unreadable")
        self.assertEqual(len(opened), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            opened[0].execute("SELECT 1")
        self.assertEqual(self.inventory(), before)

    @allocation(reads=6)
    def test_each_observed_source_change_discards_the_whole_observation(self):
        original = saved._read_components
        self.post()
        for kind in ("state", "run", "database", "wal", "shm", "journal"):
            with self.subTest(kind=kind):
                def changed(*args):
                    original(*args)
                    path = self.path("twitter" if kind == "database" else kind) if kind not in ("wal", "shm", "journal") else self.path().with_name(self.path().name + "-" + kind)
                    with path.open("ab") as stream:
                        stream.write(b" " if kind in ("state", "run", "database") else b"")
                with patch.object(saved, "_read_components", changed):
                    self.assert_error("sources_changed", 409)
                if kind in ("wal", "shm", "journal"):
                    self.path().with_name(self.path().name + "-" + kind).unlink()

    @allocation(reads=2)
    def test_fresh_request_can_observe_changed_saved_data_without_revision(self):
        self.post(content="first observation")
        before = self.read()
        self.sql("UPDATE post SET content='later observation' WHERE post_id=1")
        after = self.read()
        self.assertEqual(before["posts"]["rows"][0]["content"], "first observation")
        self.assertEqual(after["posts"]["rows"][0]["content"], "later observation")
        self.assertNotIn("revision", after)
        self.assertNotIn("source_revision", after)

    @allocation(reads=2)
    def test_database_size_cap_is_inclusive_and_one_byte_over_refuses(self):
        with self.path().open("r+b") as stream:
            stream.truncate(134217728)
        self.assert_page(self.read()["posts"], "empty", ids=[])
        with self.path().open("ab") as stream:
            stream.write(b"x")
        with patch.object(saved.sqlite3, "connect", side_effect=AssertionError("oversized database connected")):
            self.assert_page(self.read()["posts"], "unavailable", reason="source_too_large")

    @allocation(reads=4)
    def test_both_metadata_size_caps_are_inclusive(self):
        for kind in ("state", "run"):
            for size in (1048576, 1048577):
                with self.subTest(kind=kind, size=size):
                    self.write_metadata()
                    payload = self.path(kind).read_bytes()
                    self.path(kind).write_bytes(payload + b" " * (size - len(payload)))
                    data = self.read()
                    self.assertEqual(data["metadata"]["state"], "available" if size == 1048576 else "unavailable")
                    if size > 1048576:
                        self.assertEqual(data["metadata"]["reason"], "state_unreadable" if kind == "state" else "run_state_unreadable")

    @allocation()
    def test_exact_ascii_complete_envelope_budget(self):
        data = {"literal": "雪\ud800\n<svg onload=alert(1)>"}
        expected = json.dumps({"success": True, "data": data}, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":"))
        with patch.object(saved, "MAX_RESPONSE_BYTES", len(expected)):
            self.assertEqual(saved.encode_response(data), expected)
            self.assertTrue(saved.encode_response(data).isascii())
        with patch.object(saved, "MAX_RESPONSE_BYTES", len(expected) - 1):
            self.assert_error("response_too_large", 413, call=lambda: saved.encode_response(data))

    @allocation(reads=2)
    def test_large_returned_page_and_single_comment_refuse_without_truncation(self):
        self.post(2, content="x" * 1100000)
        self.post(1, content="y" * 1100000)
        self.assert_page(self.read()["posts"], "unavailable", reason="response_too_large")
        self.sql("DELETE FROM post")
        self.post(1)
        self.comment(content="z" * 2097153)
        data = self.read(post_id="1", limit=1)
        self.assertEqual(data["post"]["state"], "available")
        self.assert_page(data["comments"], "unavailable", reason="response_too_large")

    @allocation(reads=1)
    def test_progress_budget_is_cumulative_and_uses_exact_fixed_limits(self):
        self.assertEqual((saved.MAX_VM_STEPS, saved.PROGRESS_STEPS, saved.BUSY_TIMEOUT_MS), (5000000, 1000, 100))
        original, callbacks = sqlite3.connect, []
        class ProbeConnection(sqlite3.Connection):
            def set_progress_handler(connection, callback, interval):
                self.assertEqual(interval, 1000)
                callbacks.append(callback)
                # Keep this probe deterministic; real interrupt is tested below.
                return super().set_progress_handler(None, 0)
        with patch.object(saved.sqlite3, "connect", lambda *a, **k: original(*a, **k, factory=ProbeConnection)):
            self.read()
        self.assertEqual(len(callbacks), 1)
        self.assertEqual([callbacks[0]() for _ in range(4999)], [0] * 4999)
        self.assertEqual(callbacks[0](), 1)
        self.assertEqual(callbacks[0](), 1)

    @allocation(reads=1)
    def test_real_sqlite_budget_interrupt_has_unknown_coverage(self):
        self.sql("INSERT INTO post (post_id,content) VALUES (?,?)", [(value, "text") for value in range(2000)], many=True)
        with patch.object(saved, "MAX_VM_STEPS", 1000):
            self.assert_page(self.read(offset=1000)["posts"], "unavailable", reason="query_budget")

    @allocation(reads=1)
    def test_real_exclusive_lock_has_unknown_coverage_and_no_source_write(self):
        connection = sqlite3.connect(self.path())
        try:
            connection.execute("BEGIN EXCLUSIVE")
            before = self.inventory()
            data = self.read()
            self.assert_page(data["posts"], "unavailable", reason="database_busy")
            self.assertEqual(self.inventory(), before)
        finally:
            connection.rollback()
            connection.close()

    @allocation(reads=4)
    def test_comments_require_rendered_fields_and_integer_primary_key(self):
        cases = {"missing_user": COMMENT_SCHEMA.replace("user_id INTEGER,", ""),
                 "missing_content": COMMENT_SCHEMA.replace("content TEXT,", ""),
                 "missing_time": COMMENT_SCHEMA.replace("created_at DATETIME,", ""),
                 "wrong_primary_key": COMMENT_SCHEMA.replace("comment_id INTEGER PRIMARY KEY", "comment_id TEXT PRIMARY KEY")}
        for case, schema in cases.items():
            with self.subTest(case=case):
                self.make_database("twitter", comment_schema=schema)
                self.post()
                data = self.read(post_id="1")
                self.assertEqual(data["post"]["state"], "available")
                self.assert_page(data["comments"], "unavailable", reason="unsupported_schema")

    @allocation(reads=5)
    def test_invalid_returned_comments_preserve_post_and_discard_component(self):
        cases = {"negative_comment_id": ("comment_id", -1), "negative_user": ("user_id", -1),
                 "text_user": ("user_id", "invalid"), "blob_content": ("content", b"invalid"),
                 "blob_time": ("created_at", b"invalid")}
        for case, (field, value) in cases.items():
            with self.subTest(case=case):
                self.make_database("twitter")
                self.post()
                self.comment(1)
                self.comment(2, content="valid later comment")
                self.sql(f"UPDATE comment SET {field}=? WHERE comment_id=1", (value,))
                data = self.read(post_id="1")
                self.assertEqual(data["post"]["state"], "available")
                self.assert_page(data["comments"], "unavailable", reason="invalid_row")

    @allocation(reads=3)
    def test_metadata_and_database_open_failures_remain_unknown(self):
        original = saved.saved._open_source
        for kind in ("state", "run", "twitter"):
            with self.subTest(kind=kind):
                def refuse(path):
                    if str(path) == str(self.path(kind)):
                        raise PermissionError("PRIVATE_ERROR")
                    return original(path)
                with patch.object(saved.saved, "_open_source", refuse):
                    data = self.read()
                if kind in ("state", "run"):
                    self.assertEqual(data["metadata"]["reason"], "state_unreadable" if kind == "state" else "run_state_unreadable")
                    self.assert_page(data["posts"], "unavailable", reason="metadata_unavailable")
                else:
                    self.assert_page(data["posts"], "unavailable", reason="source_unreadable")
