"""Four bounded groups around the actual production Flask search adapter."""
import ast
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Blueprint, Flask, current_app, jsonify, request

from saved_posts_support import APP, Fixture, FixedDatetime, allocation, saved, storage, MAX_ID


class SavedPostSearchApiTests(Fixture):
    def setUp(self):
        super().setUp()
        source = APP / "api/simulation.py"
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "get_saved_simulation_post_search"]
        self.assertEqual(len(functions), 1)
        blueprint = Blueprint("saved_post_search_fixture", __name__)
        self.reader_namespace = SimpleNamespace(parse_saved_post_search_query=saved.parse_saved_post_search_query,
            read_saved_post_search=self.service_search, encode_response=saved.encode_response)
        namespace = {"__name__": "_saved_post_search_api_fixture", "simulation_bp": blueprint,
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

    def service_search(self, *args, **kwargs):
        self.reader_calls += 1
        return saved.read_saved_post_search(*args, **kwargs)

    def get_search(self, query=None, simulation_id=None):
        self.api_calls += 1
        before = self.inventory()
        response = self.client.get(f"/api/simulation/{simulation_id or self.simulation_id}/saved-post-search",
            query_string={"platform": "twitter", "kind": "posts", "q": "needle"} if query is None else query)
        self.assertEqual(self.inventory(), before)
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertEqual(response.mimetype, "application/json")
        return response

    def assert_error_response(self, response, code, status):
        self.assertEqual(response.status_code, status)
        self.assertEqual(set(response.json), {"success", "error", "error_code"})
        self.assertIs(response.json["success"], False)
        self.assertEqual(response.json["error_code"], code)
        self.assertLess(len(response.data), 4096)
        self.assertNotIn("PRIVATE_", response.get_data(as_text=True))
        self.assertNotIn(str(self.root), response.get_data(as_text=True))

    @allocation(reads=2, api=2)
    def test_exact_get_envelope_ascii_serialization_and_no_store(self):
        self.post(MAX_ID, content="needle 雪 <svg onload=x>", quote_content="literal")
        with patch.object(saved, "datetime", FixedDatetime):
            response = self.get_search()
            zero = self.get_search({"platform": "twitter", "kind": "comments", "q": "needle"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, saved.encode_response(response.json["data"]).encode("ascii"))
        self.assertTrue(response.data.isascii())
        self.assertEqual(response.json["data"]["results"]["rows"][0]["post_id"], str(MAX_ID))
        self.assertEqual(zero.json["data"]["results"]["matched_count"], 0)
        self.assertEqual(zero.json["data"]["results"]["state"], "empty")
        self.assertIs(self.app.json.ensure_ascii, False)

    @allocation(reads=1, api=6)
    def test_strict_query_and_identity_rejection_before_storage(self):
        base = [("platform", "twitter"), ("kind", "posts"), ("q", "needle")]
        with patch.object(saved, "_paths", side_effect=AssertionError("invalid request reached storage")):
            for query, code in (([], "invalid_filters"), (base + [("q", "again")], "invalid_filters"),
                                (base + [("post_id", "1")], "invalid_filters"),
                                (base + [("limit", "101")], "invalid_pagination"),
                                ([("platform", "twitter"), ("kind", "posts"), ("q", " \u3000")], "invalid_filters")):
                self.assert_error_response(self.get_search(query), code, 400)
            self.assert_error_response(self.get_search(simulation_id="con"), "invalid_selection", 400)

    @allocation(api=6)
    def test_safe_refusal_and_error_serialization_without_private_leakage(self):
        for error, code, status in ((saved.saved.ComparisonError("sources_changed", "Refresh to read again.", 409), "sources_changed", 409),
                                    (saved.saved.ComparisonError("response_too_large", "This page is too large.", 413), "response_too_large", 413),
                                    (storage.StoragePathError("PRIVATE_PATH"), "unsafe_path", 400),
                                    (RuntimeError("PRIVATE_FAILURE"), "posts_unavailable", 500)):
            self.reader_namespace.read_saved_post_search = Mock(side_effect=error)
            self.assert_error_response(self.get_search(), code, status)
        data = {"fixture": "雪"}
        self.reader_namespace.read_saved_post_search = Mock(return_value=data)
        expected = saved.encode_response(data)
        with patch.object(saved, "MAX_RESPONSE_BYTES", len(expected)):
            response = self.get_search()
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, expected.encode("ascii"))
        with patch.object(saved, "MAX_RESPONSE_BYTES", len(expected) - 1):
            self.assert_error_response(self.get_search(), "response_too_large", 413)

    @allocation(reads=4, api=4)
    def test_two_platforms_and_kinds_keep_exact_ids_and_filters(self):
        for platform in ("twitter", "reddit"):
            self.post(MAX_ID, platform=platform, content=" Needle ")
            self.comment(MAX_ID, MAX_ID, platform=platform, content=" Needle ")
            for kind in ("posts", "comments"):
                response = self.get_search({"platform": platform, "kind": kind, "q": " Needle ", "case_sensitive": "true", "limit": "1"})
                self.assertEqual(response.status_code, 200)
                data = response.json["data"]
                self.assertEqual(data["platform"], platform)
                self.assertEqual(data["search"], {"kind": kind, "q": " Needle ", "case_sensitive": True})
                self.assertEqual(data["results"]["matched_count"], 1)
                self.assertEqual(data["results"]["rows"][0]["post_id"], str(MAX_ID))
