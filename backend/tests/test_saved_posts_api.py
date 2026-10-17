"""Future runtime: real Flask routes around the exact three production functions.

AST extraction omits app initialization and substitutes only storage-root holders,
logger and the saved-reader namespace. The actual saved reader is used unless a
case explicitly injects a safe adapter error/serialization boundary.
"""
import ast
import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Blueprint, Flask, current_app, jsonify, request

from saved_posts_support import APP, Fixture, FixedDatetime, allocation, saved, storage, MAX_ID, ENVELOPE_KEYS


class SavedPostsApiTests(Fixture):
    def setUp(self):
        super().setUp()
        source = APP / "api/simulation.py"
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        names = {"_saved_posts_response", "get_saved_simulation_posts", "get_saved_simulation_post"}
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual({node.name for node in functions}, names)
        blueprint = Blueprint("saved_posts_fixture", __name__)
        self.reader_namespace = SimpleNamespace(parse_saved_posts_query=saved.parse_saved_posts_query,
            read_saved_posts=self.service, encode_response=saved.encode_response)
        namespace = {"__name__": "_saved_posts_api_fixture", "simulation_bp": blueprint,
            "request": request, "jsonify": jsonify, "current_app": current_app,
            "ComparisonError": saved.saved.ComparisonError, "StoragePathError": storage.StoragePathError,
            "saved_posts": self.reader_namespace,
            "SimulationManager": SimpleNamespace(SIMULATION_DATA_DIR=str(self.sim_root)),
            "SimulationRunner": SimpleNamespace(RUN_STATE_DIR=str(self.run_root)), "logger": Mock()}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True)
        self.app.json.ensure_ascii = False
        self.app.register_blueprint(blueprint, url_prefix="/api/simulation")
        self.client = self.app.test_client()

    def request_posts(self, query=None, post_id=None, simulation_id=None, method="get"):
        self.api_calls += 1
        url = f"/api/simulation/{simulation_id or self.simulation_id}/saved-posts"
        if post_id is not None:
            url += "/" + post_id
        return getattr(self.client, method)(url, query_string={"platform": "twitter"} if query is None else query)

    def assert_error_response(self, response, code, status):
        self.assertEqual(response.status_code, status, response.get_data(as_text=True))
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertEqual(set(response.json), {"success", "error", "error_code"})
        self.assertIs(response.json["success"], False)
        self.assertEqual(response.json["error_code"], code)
        self.assertLess(len(response.data), 4096)
        self.assertNotIn(str(self.root), response.get_data(as_text=True))
        self.assertNotIn("PRIVATE_", response.get_data(as_text=True))
        self.assertNotIn("traceback", response.json)

    @allocation(reads=2, api=2)
    def test_real_list_and_detail_envelopes_exact_ids_no_store_and_unchanged_sources(self):
        self.post(MAX_ID, user_id=9007199254740993, original_post_id=0, content="<img src=x onerror=alert(1)>\n雪", quote_content="saved quote")
        self.comment(MAX_ID, MAX_ID, content="literal [link](javascript:alert(1))")
        before = self.inventory()
        for post_id in (None, str(MAX_ID)):
            with self.subTest(post_id=post_id), patch.object(saved, "datetime", FixedDatetime):
                response = self.request_posts(post_id=post_id)
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                self.assertEqual(response.headers.get("Cache-Control"), "no-store")
                self.assertEqual(set(response.json), {"success", "data"})
                self.assertEqual(set(response.json["data"]), ENVELOPE_KEYS)
                self.assertEqual(response.json["data"]["post_id"], post_id)
                self.assertEqual(response.json["data"]["simulation_id"], self.simulation_id)
                self.assertEqual(response.json["data"]["platform"], "twitter")
                self.assertTrue(response.data.isascii())
                self.assertIn(b"9007199254740993", response.data)
                self.assertEqual(response.data, saved.encode_response(response.json["data"]).encode("ascii"))
        self.assertEqual(self.inventory(), before)
        self.assertIs(self.app.json.ensure_ascii, False)

    @allocation(api=8)
    def test_query_rejections_precede_reader_and_storage(self):
        reader = Mock(side_effect=AssertionError("invalid query reached reader"))
        self.reader_namespace.read_saved_posts = reader
        cases = (([], "invalid_filters"), ([("platform", "twitter"), ("platform", "reddit")], "invalid_filters"),
                 ([("platform", "twitter"), ("revision", "old")], "invalid_filters"),
                 ([("platform", "twitter"), ("limit", "0")], "invalid_pagination"),
                 ([("platform", "twitter"), ("limit", "101")], "invalid_pagination"),
                 ([("platform", "twitter"), ("offset", "500001")], "invalid_pagination"),
                 ([("platform", "twitter"), ("offset", "00")], "invalid_pagination"),
                 ([("platform", "../other")], "invalid_filters"))
        for index, (query, code) in enumerate(cases):
            with self.subTest(case=index):
                self.assert_error_response(self.request_posts(query), code, 400)
        reader.assert_not_called()

    @allocation(reads=4, api=4)
    def test_detail_id_rejections_precede_storage(self):
        with patch.object(saved, "_paths", side_effect=AssertionError("invalid post ID reached paths")):
            for post_id in ("00", "-1", "1.0", "9223372036854775808"):
                with self.subTest(post_id=post_id):
                    self.assert_error_response(self.request_posts(post_id=post_id), "invalid_selection", 400)

    @allocation(api=2)
    def test_route_forwards_only_explicit_platform_pagination_and_exact_post_id(self):
        reader = Mock(return_value={"fixture": "response"})
        self.reader_namespace.read_saved_posts = reader
        self.assertEqual(self.request_posts({"platform": "reddit"}).status_code, 200)
        reader.assert_called_once_with(str(self.sim_root), str(self.run_root), self.simulation_id,
                                       post_id=None, platform="reddit", offset=0, limit=25)
        reader.reset_mock()
        self.assertEqual(self.request_posts({"platform": "twitter", "offset": "500000", "limit": "100"}, post_id=str(MAX_ID)).status_code, 200)
        reader.assert_called_once_with(str(self.sim_root), str(self.run_root), self.simulation_id,
                                       post_id=str(MAX_ID), platform="twitter", offset=500000, limit=100)

    @allocation(api=7)
    def test_expected_service_and_storage_errors_use_fixed_safe_schema(self):
        cases = (("invalid_selection", 400), ("invalid_filters", 400), ("invalid_pagination", 400),
                 ("unsafe_path", 400), ("sources_changed", 409), ("response_too_large", 413))
        for code, status in cases:
            with self.subTest(code=code):
                self.reader_namespace.read_saved_posts = Mock(side_effect=saved.saved.ComparisonError(code, "Safe refusal.", status))
                self.assert_error_response(self.request_posts(), code, status)
        self.reader_namespace.read_saved_posts = Mock(side_effect=storage.StoragePathError("PRIVATE_PATH"))
        self.assert_error_response(self.request_posts(), "unsafe_path", 400)

    @allocation(api=1)
    def test_unexpected_exception_does_not_leak_path_or_traceback(self):
        self.reader_namespace.read_saved_posts = Mock(side_effect=RuntimeError("PRIVATE_ERROR /private/source"))
        self.assert_error_response(self.request_posts(), "posts_unavailable", 500)

    @allocation(api=2)
    def test_complete_serialized_ascii_envelope_cap_is_inclusive(self):
        data = {"fixture": "雪\ud800"}
        self.reader_namespace.read_saved_posts = Mock(return_value=data)
        expected = json.dumps({"success": True, "data": data}, ensure_ascii=True, sort_keys=True, allow_nan=False, separators=(",", ":")).encode("ascii")
        with patch.object(saved, "MAX_RESPONSE_BYTES", len(expected)):
            response = self.request_posts()
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, expected)
        with patch.object(saved, "MAX_RESPONSE_BYTES", len(expected) - 1):
            self.assert_error_response(self.request_posts(), "response_too_large", 413)

    @allocation(reads=2, api=2)
    def test_missing_and_oversized_sources_are_unavailable_not_empty_or_truncated(self):
        self.path().unlink()
        missing = self.request_posts()
        self.assertEqual(missing.status_code, 200)
        self.assert_page(missing.json["data"]["posts"], "unavailable", reason="database_missing")
        self.make_database("twitter")
        self.post(content="x" * 2097153)
        huge = self.request_posts({"platform": "twitter", "limit": "1"})
        self.assertEqual(huge.status_code, 200)
        self.assert_page(huge.json["data"]["posts"], "unavailable", reason="response_too_large")
        self.assertLess(len(huge.data), 4096)

    @allocation(reads=1, api=1)
    def test_ordinary_change_conflict_is_409_without_partial_observation(self):
        original = saved._read_components
        def change(*args):
            original(*args)
            with self.path("state").open("ab") as stream:
                stream.write(b" ")
        with patch.object(saved, "_read_components", change):
            self.assert_error_response(self.request_posts(), "sources_changed", 409)

    @allocation(api=8)
    def test_mutating_methods_are_rejected_for_both_routes(self):
        reader = Mock(side_effect=AssertionError("mutating request reached reader"))
        self.reader_namespace.read_saved_posts = reader
        for post_id in (None, "0"):
            for method in ("post", "put", "patch", "delete"):
                with self.subTest(post_id=post_id, method=method):
                    self.assertEqual(self.request_posts(post_id=post_id, method=method).status_code, 405)
        reader.assert_not_called()
