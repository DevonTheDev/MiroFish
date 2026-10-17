"""Finite saved-search contracts. Prepared without importing or executing them.

The actual isolated service and SQLite reader are exercised at the runtime gate.
Each search() checks every fixture file/sidecar before and after the read.
"""
import json
import sqlite3
import unittest
from unittest.mock import patch

from saved_posts_support import Fixture, FixedDatetime, Query, allocation, saved, MAX_ID

RESULT_KEYS = {"state", "reason", "offset", "limit", "count", "matched_count", "has_more", "rows"}


class SavedPostSearchQueryTests(unittest.TestCase):
    @allocation()
    def test_query_admission_32_cases_before_storage(self):
        base = [("platform", "twitter"), ("kind", "posts"), ("q", "needle")]
        cases = []
        for key in ("platform", "kind", "q", "case_sensitive", "offset", "limit"):
            value = dict(base).get(key, {"case_sensitive": "false", "offset": "0", "limit": "25"}.get(key))
            cases.append((base + ([(key, value)] if key in dict(base) else [(key, value), (key, value)]), False))
        cases += [(base + [("extra", "x")], False)]
        cases += [([(key, value) for key, value in base if key != missing], False) for missing in ("platform", "kind", "q")]
        for key, value in (("platform", "both"), ("kind", "all"), ("q", ""), ("q", " \u00a0\u3000"),
                           ("q", "a\n"), ("q", "\ud800"), ("q", "x" * 201), ("case_sensitive", "True"),
                           ("offset", "00"), ("offset", "-1"), ("offset", "500001"), ("limit", "0"),
                           ("limit", "101"), ("limit", "1.0"), ("q", "x\u2028y"), ("q", "x\u0085y")):
            cases.append(([(k, v) for k, v in base if k != key] + [(key, value)], False))
        cases += [(base, True), (base + [("case_sensitive", "true")], True),
                  (base + [("case_sensitive", "false"), ("offset", "500000"), ("limit", "100")], True),
                  ([("platform", "reddit"), ("kind", "comments"), ("q", "😀" * 200)], True),
                  ([("platform", "twitter"), ("kind", "posts"), ("q", "\ufeff")], True),
                  ([("platform", "twitter"), ("kind", "posts"), ("q", " leading and trailing ")], True)]
        self.assertEqual(len(cases), 32)
        with patch.object(saved, "_paths", side_effect=AssertionError("parser reached storage")):
            for index, (items, valid) in enumerate(cases):
                with self.subTest(case=index):
                    if valid:
                        parsed = saved.parse_saved_post_search_query(Query(items))
                        self.assertEqual(parsed["q"], dict(items)["q"])
                        self.assertIs(parsed["case_sensitive"], dict(items).get("case_sensitive", "false") == "true")
                    else:
                        with self.assertRaises(saved.saved.ComparisonError):
                            saved.parse_saved_post_search_query(Query(items))


class SavedPostSearchTests(Fixture):
    def search(self, *, immutable=True, **kwargs):
        before = self.inventory()
        self.reader_calls += 1
        original_connect, connections = saved.sqlite3.connect, []
        owner = self
        class ProbeConnection(sqlite3.Connection):
            closed = False
            def close(connection):
                connection.closed = True
                return super().close()
            def setlimit(connection, category, limit):
                owner.assertEqual((category, limit), (sqlite3.SQLITE_LIMIT_LENGTH, 2097152))
                return super().setlimit(category, limit)
            def set_progress_handler(connection, callback, interval):
                owner.assertEqual(interval, 1000)
                return super().set_progress_handler(callback, interval)
        def connect(database, **options):
            self.assertTrue(database.endswith("?mode=ro"))
            self.assertEqual(options, {"uri": True, "timeout": 0.1})
            connection = original_connect(database, **options, factory=ProbeConnection)
            statements = []
            connection.set_trace_callback(statements.append)
            connections.append((connection, statements))
            return connection
        try:
            with patch.object(saved, "datetime", FixedDatetime), patch.object(saved.sqlite3, "connect", connect):
                return saved.read_saved_post_search(str(self.sim_root), str(self.run_root), self.simulation_id,
                    **({"platform": "twitter", "kind": "posts", "q": "needle"} | kwargs))
        finally:
            for connection, statements in connections:
                self.assertTrue(connection.closed)
                self.assertEqual(statements.count("BEGIN"), 1)
                self.assertIn("PRAGMA query_only = ON", statements)
                self.assertFalse(any(statement.upper().startswith(("INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "VACUUM", "ATTACH")) for statement in statements))
            if immutable:
                self.assertEqual(self.inventory(), before)

    def results(self, data, *, ids=(), count=None, state="available", reason=None):
        self.assertEqual(set(data), {"simulation_id", "platform", "observed_at", "metadata", "database", "search", "results"})
        self.assertEqual(set(data["search"]), {"kind", "q", "case_sensitive"})
        page = data["results"]
        self.assertEqual(set(page), RESULT_KEYS)
        self.assertEqual((page["state"], page["reason"]), (state, reason))
        self.assertEqual([r["comment_id" if data["search"]["kind"] == "comments" else "post_id"] for r in page["rows"]], list(ids))
        if state == "unavailable":
            self.assertEqual((page["count"], page["matched_count"], page["has_more"]), (None, None, None))
        else:
            self.assertEqual(page["matched_count"], count)
            self.assertEqual(page["count"], min(page["limit"], max(0, count - page["offset"])))
            self.assertEqual(page["count"], len(ids))
            self.assertIs(page["has_more"], page["offset"] + page["count"] < count)
        return page

    @allocation(reads=4)
    def test_field_kind_platform_separation_and_orphan_comments(self):
        self.post(3, content="needle", quote_content="needle")
        self.post(2, content="hay", quote_content="needle")
        self.post(1, content="nee", quote_content="dle")
        self.comment(1, 999, content="needle")
        self.post(1, platform="reddit", content="needle reddit")
        self.results(self.search(), ids=("3", "2"), count=2)
        self.results(self.search(kind="comments"), ids=("1",), count=1)
        self.results(self.search(platform="reddit"), ids=("1",), count=1)
        self.sql("DROP TABLE post")
        data = self.search(kind="comments")
        self.results(data, ids=("1",), count=1)
        self.assertEqual(data["results"]["rows"][0]["post_id"], "999")

    @allocation(reads=8)
    def test_literal_casefold_without_normalization_or_field_concatenation(self):
        self.post(8, content="Straße")
        self.post(7, content="ß")
        self.post(6, content="%_ ' <svg onload=x> [link](javascript:x)")
        self.post(5, content="é")
        self.post(4, content="\ufeff")
        self.post(3, content="foo", quote_content="bar")
        self.post(2, content=None, quote_content="QUOTE")
        for query, sensitive, ids in (("STRASSE", False, ("8",)), ("s", False, ("8", "7", "6")),
                                      ("STRASSE", True, ()), ("%_ '", False, ("6",)),
                                      ("e\u0301", False, ()), ("\ufeff", False, ("4",)),
                                      ("foobar", False, ()), ("quote", False, ("2",))):
            self.results(self.search(q=query, case_sensitive=sensitive), ids=ids, count=len(ids), state="available" if ids else "empty")

    @allocation(reads=4)
    def test_match_deduplication_order_and_complete_count_before_pagination(self):
        for value in range(10):
            self.post(value, content="needle needle" if value % 2 == 0 else "hay", quote_content="needle" if value == 8 else None)
        for offset, ids in ((0, ("8", "6")), (2, ("4", "2")), (4, ("0",)), (500000, ())):
            self.results(self.search(offset=offset, limit=2), ids=ids, count=5, state="available" if ids else "out_of_range")

    @allocation(reads=3)
    def test_empty_zero_and_late_matches_after_requested_page(self):
        self.results(self.search(), count=0, state="empty")
        self.post(9, content="hay")
        self.results(self.search(offset=25), count=0, state="out_of_range")
        self.post(8, content="needle")
        self.post(1, content="needle")
        self.results(self.search(limit=1), ids=("8",), count=2)

    @allocation(reads=2)
    def test_signed64_nullable_quote_and_comment_parent_semantics(self):
        self.post(MAX_ID, user_id=None, original_post_id=0, content=None, quote_content="needle", created_at=9007199254740993)
        self.comment(MAX_ID, MAX_ID, user_id=None, content="needle", created_at=1.25)
        post = self.search()
        self.results(post, ids=(str(MAX_ID),), count=1)
        self.assertEqual(post["results"]["rows"][0], {"post_id": str(MAX_ID), "user_id": None,
            "original_post_id": "0", "content": None, "quote_content": "needle", "created_at": "9007199254740993"})
        comment = self.search(kind="comments")
        self.results(comment, ids=(str(MAX_ID),), count=1)
        self.assertEqual(comment["results"]["rows"][0]["created_at"], "1.25")
        self.assertEqual(comment["results"]["rows"][0]["post_id"], str(MAX_ID))

    @allocation(reads=2)
    def test_50000_rows_and_50001st_id_only_refusal(self):
        self.assertEqual(saved.MAX_SEARCH_ROWS, 50000)
        self.sql("INSERT INTO post(post_id,content) VALUES (?,?)", ((i, "needle") for i in range(1, 50001)), many=True)
        self.results(self.search(limit=1), ids=("50000",), count=50000)
        self.post(0, content="x" * 2097153)
        self.results(self.search(limit=1), state="unavailable", reason="search_limit")

    @allocation(reads=5)
    def test_canonical_row_byte_boundary_and_fold_work_refusals(self):
        self.assertEqual((saved.MAX_SEARCH_BYTES, saved.MAX_FOLDED_QUERY, saved.MAX_FOLDED_FIELD, saved.MAX_FOLDED_TOTAL),
                         (16777216, 600, 6291456, 50331648))
        rows = [{"post_id": str(i), "user_id": None, "original_post_id": None, "content": "", "quote_content": None, "created_at": None} for i in range(1, 10)]
        base = sum(len(json.dumps(r, ensure_ascii=True, sort_keys=True, separators=(",", ":"))) for r in rows)
        remaining = 16777216 - base
        sizes = [remaining // 9] * 9
        sizes[-1] += remaining % 9
        self.sql("INSERT INTO post(post_id,content) VALUES (?,?)", ((i, "雪" * (size // 6) + "x" * (size % 6)) for i, size in enumerate(sizes, 1)), many=True)
        self.results(self.search(q="not present"), count=0, state="empty")
        self.sql("UPDATE post SET content=content || 'x' WHERE post_id=1")
        self.results(self.search(q="not present"), state="unavailable", reason="search_limit")
        self.sql("DELETE FROM post")
        self.post(2, content="ß")
        self.post(1, content="ß")
        for name, bound in (("MAX_FOLDED_FIELD", 1), ("MAX_FOLDED_TOTAL", 3), ("MAX_FOLDED_QUERY", 1)):
            with patch.object(saved, name, bound):
                self.results(self.search(q="ß", limit=1), state="unavailable", reason="search_limit")

    @allocation(reads=5)
    def test_complete_envelope_value_and_final_count_byte_boundaries(self):
        self.post(999, content="needle")
        initial = self.search(limit=1)
        encoded = saved.encode_response(initial)
        padding = 2097152 - len(encoded)
        self.sql("UPDATE post SET content=? WHERE post_id=999", ("needle" + "x" * padding,))
        exact = self.search(limit=1)
        self.results(exact, ids=("999",), count=1)
        self.assertEqual(len(saved.encode_response(exact)), 2097152)
        self.sql("UPDATE post SET content=content || 'x' WHERE post_id=999")
        self.results(self.search(limit=1), state="unavailable", reason="response_too_large")
        self.sql("UPDATE post SET content=? WHERE post_id=999", ("needle" + "x" * padding,))
        self.post(1, content="needle")
        # has_more switches false -> true (one byte smaller), so a 2-digit
        # completed count recovers that byte; 3 digits must exceed the cap.
        self.sql("INSERT INTO post(post_id,content) VALUES (?,?)", ((i, "needle") for i in range(10, 109)), many=True)
        self.results(self.search(limit=1), state="unavailable", reason="response_too_large")
        self.sql("DELETE FROM post")
        self.post(1, content="needle" + "x" * 2097153)
        self.results(self.search(), state="unavailable", reason="response_too_large")

    @allocation(reads=4)
    def test_malformed_nonmatching_and_late_rows_discard_staged_results(self):
        self.post(9, content="needle")
        self.post(1, content=sqlite3.Binary(b"not a text value"))
        self.results(self.search(limit=1), state="unavailable", reason="invalid_row")
        self.sql("DELETE FROM post WHERE post_id=1")
        self.post(-1, content="hay")
        self.results(self.search(limit=1), state="unavailable", reason="invalid_row")
        self.sql("DELETE FROM post WHERE post_id=-1")
        self.post(1, content="hay", created_at=sqlite3.Binary(b"invalid time"))
        self.results(self.search(limit=1), state="unavailable", reason="invalid_row")
        self.sql("UPDATE post SET content=CAST(x'80' AS TEXT),created_at=NULL WHERE post_id=1")
        self.results(self.search(limit=1), state="unavailable", reason="database_unreadable")

    @allocation(reads=8)
    def test_admission_lock_vm_changes_and_fresh_observations(self):
        self.path().unlink()
        self.results(self.search(), state="unavailable", reason="database_missing")
        self.make_database("twitter")
        sidecar = self.path().with_name(self.path().name + "-wal")
        sidecar.write_bytes(b"")
        with patch.object(saved.sqlite3, "connect", side_effect=AssertionError("sidecar reached connect")):
            self.results(self.search(), state="unavailable", reason="unsupported_journal")
        sidecar.unlink()
        lock = sqlite3.connect(self.path())
        try:
            lock.execute("BEGIN EXCLUSIVE")
            self.results(self.search(), state="unavailable", reason="database_busy")
        finally:
            lock.rollback(); lock.close()
        self.sql("INSERT INTO post(post_id,content) VALUES (?,?)", ((i, "needle") for i in range(1000)), many=True)
        with patch.object(saved, "MAX_VM_STEPS", 1000):
            self.results(self.search(), state="unavailable", reason="query_budget")
        original = saved._read_search
        def change(*args, **kwargs):
            page = original(*args, **kwargs)
            self.path("state").write_text(json.dumps(self.state) + " ", encoding="utf-8")
            return page
        with patch.object(saved, "_read_search", change):
            self.assert_error("sources_changed", 409, call=lambda: self.search(immutable=False))
        self.sql("DELETE FROM post")
        self.post(1, content="needle before")
        before = self.search()
        self.sql("UPDATE post SET content='needle after' WHERE post_id=1")
        after = self.search()
        self.assertNotEqual(before["results"]["rows"][0]["content"], after["results"]["rows"][0]["content"])
        self.run["runner_status"] = "failed"
        self.write_metadata()
        partial = self.search()
        self.assertTrue(partial["metadata"]["partial"])
        self.results(partial, ids=("1",), count=1)
