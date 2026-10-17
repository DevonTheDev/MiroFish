"""Real Flask semantics around only the extracted production GET handler.

The simulation API module and unrelated live services are never imported.
AST parsing/compilation here belongs to the later authorized runtime gate.
"""

import ast
import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Blueprint, Flask, current_app, jsonify, request

from saved_activity_agents_support import APP, FixedDatetime, Fixture, action, agents, bucket, encoded, saved, storage


class AgentApiTests(Fixture):
    def setUp(self):
        super().setUp()
        source = APP / "api/simulation.py"
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name == "get_saved_simulation_action_agents"]
        self.assertEqual(len(functions), 1)
        blueprint = Blueprint("saved_activity_agents_fixture", __name__)
        self.namespace = {
            "__name__": "_saved_activity_agents_api_fixture", "simulation_bp": blueprint,
            "current_app": current_app, "jsonify": jsonify, "request": request,
            "ComparisonError": saved.ComparisonError, "StoragePathError": storage.StoragePathError,
            "saved_activity_agents": agents,
            "parse_saved_activity_agents_query": agents.parse_saved_activity_agents_query,
            "read_saved_activity_agents": agents.read_saved_activity_agents,
            "SimulationManager": SimpleNamespace(SIMULATION_DATA_DIR=str(self.sim_root)),
            "SimulationRunner": SimpleNamespace(RUN_STATE_DIR=str(self.run_root)),
            "logger": Mock(),
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), self.namespace)
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True)
        self.app.json.ensure_ascii = False  # Production handler must override this explicitly.
        self.app.register_blueprint(blueprint, url_prefix="/api/simulation")
        self.client = self.app.test_client()

    def request_agents(self, query=None, simulation_id=None):
        return self.client.get(
            f"/api/simulation/{simulation_id or self.simulation_id}/saved-action-agents",
            query_string=query,
        )

    def assert_error_response(self, response, code, status):
        self.assertEqual(response.status_code, status, response.get_data(as_text=True))
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(set(response.json), {"success", "error", "error_code"})
        self.assertIs(response.json["success"], False)
        self.assertEqual(response.json["error_code"], code)
        self.assertLess(len(response.data), 4096)
        self.assertNotIn(str(self.root), response.get_data(as_text=True))
        self.assertNotIn("PRIVATE_ERROR", response.get_data(as_text=True))
        self.assertNotIn("traceback", response.json)

    def test_real_route_preserves_exact_identity_counts_schema_and_read_only_sources(self):
        self.write_log("twitter", [action(agent_id=9007199254740993, success=False, result="PRIVATE_ACTION"),
                                   action(agent_id=9007199254740993, success=False), action(agent_id=0)])
        self.write_log("reddit", [action(agent_id=9007199254740993, success=True)])
        before = self.inventory()
        revision = self.revision()
        response = self.request_agents({"platform": "twitter", "revision": revision})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(set(response.json), {"success", "data"})
        self.assertIs(response.json["success"], True)
        data = response.json["data"]
        self.assertEqual(data["source_revision"], revision)
        self.assertEqual(data["filters"], {"platform": "twitter"})
        self.assertEqual(data["agents"], [bucket("twitter", 9007199254740993, failed=2), bucket("twitter", 0, unknown=1)])
        self.assertEqual((data["pair_count"], data["matched_count"]), (2, 3))
        self.assertNotIn("PRIVATE_", response.get_data(as_text=True))
        self.assertEqual(self.inventory(), before)

    def test_query_rejection_happens_before_reader_or_storage(self):
        reader = Mock(side_effect=AssertionError("invalid query reached reader"))
        self.namespace["read_saved_activity_agents"] = reader
        cases = [([(field, "1")], "invalid_filters") for field in
                 ("agent_id", "round_num", "round_from", "round_to", "q", "action_type", "outcome", "offset", "limit", "sort")]
        cases += [([("platform", "")], "invalid_filters"), ([("platform", "Twitter")], "invalid_filters"),
                  ([("platform", "twitter"), ("platform", "twitter")], "invalid_filters"),
                  ([("revision", "")], "invalid_revision"), ([("revision", "A" * 64)], "invalid_revision"),
                  ([("revision", "a" * 64), ("revision", "a" * 64)], "invalid_revision")]
        with patch.object(saved, "_paths", side_effect=AssertionError("invalid query reached storage")):
            for query, code in cases:
                with self.subTest(query=query):
                    self.assert_error_response(self.request_agents(query), code, 400)
        reader.assert_not_called()

    def test_optional_query_values_are_forwarded_without_records_filters(self):
        reader = Mock(return_value={"test": "value"})
        self.namespace["read_saved_activity_agents"] = reader
        self.assertEqual(self.request_agents().status_code, 200)
        reader.assert_called_once_with(str(self.sim_root), str(self.run_root), self.simulation_id, platform=None)
        reader.reset_mock()
        revision = "a" * 64
        self.assertEqual(self.request_agents({"platform": "reddit", "revision": revision}).status_code, 200)
        reader.assert_called_once_with(str(self.sim_root), str(self.run_root), self.simulation_id,
                                       platform="reddit", revision=revision)

    def test_expected_service_errors_preserve_status_and_safe_schema(self):
        for code, status in (("invalid_selection", 400), ("invalid_revision", 400), ("unsafe_path", 400),
                             ("simulation_not_found", 404), ("simulation_unreadable", 404),
                             ("simulation_active", 409), ("sources_changed", 409),
                             ("too_many_agent_pairs", 413), ("response_too_large", 413)):
            with self.subTest(code=code):
                self.namespace["read_saved_activity_agents"] = Mock(side_effect=saved.ComparisonError(code, "Safe refusal.", status))
                self.assert_error_response(self.request_agents(), code, status)

    def test_storage_and_unexpected_failures_hide_private_exception_details(self):
        for error, code, status in ((storage.StoragePathError("PRIVATE_ERROR /private/path"), "unsafe_path", 400),
                                    (RuntimeError("PRIVATE_ERROR /private/path"), "activity_unavailable", 500)):
            with self.subTest(code=code):
                self.namespace["read_saved_activity_agents"] = Mock(side_effect=error)
                response = self.request_agents()
                self.assert_error_response(response, code, status)
                self.assertNotIn("/private/path", response.get_data(as_text=True))

    def test_real_pair_limit_refuses_whole_response_and_narrowing_can_still_fail(self):
        self.write_log("twitter", [action(agent_id=value) for value in range(1001)])
        for query in (None, {"platform": "twitter"}):
            with self.subTest(query=query):
                self.assert_error_response(self.request_agents(query), "too_many_agent_pairs", 413)

    def test_actual_response_bytes_accept_exact_budget_and_reject_one_less(self):
        self.namespace["read_saved_activity_agents"] = Mock(return_value={"fixture": "雪"})
        raw = self.app.json.dumps({"success": True, "data": {"fixture": "雪"}},
                                  ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
        with patch.object(agents, "MAX_RESPONSE_BYTES", len(raw)):
            response = self.request_agents()
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, raw)
        with patch.object(agents, "MAX_RESPONSE_BYTES", len(raw) - 1):
            self.assert_error_response(self.request_agents(), "response_too_large", 413)

    def test_actual_utf8_bytes_are_measured_even_when_json_provider_expands_output(self):
        self.namespace["read_saved_activity_agents"] = Mock(return_value={"fixture": "雪" * 20})
        original = self.app.json.dumps
        def expanded(value, **kwargs):
            if value.get("success") is True:
                kwargs["ensure_ascii"] = False
            return original(value, **kwargs)
        text = original({"success": True, "data": {"fixture": "雪" * 20}},
                        ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        self.assertGreater(len(text.encode("utf-8")), len(text))
        with patch.object(self.app.json, "dumps", expanded), patch.object(agents, "MAX_RESPONSE_BYTES", len(text)):
            self.assert_error_response(self.request_agents(), "response_too_large", 413)

    def test_unusual_context_strings_are_ascii_encoded_without_changing_global_provider(self):
        self.run["updated_at"] = "\ud800 代理 😀 café"
        self.write_metadata()
        with patch.object(agents, "datetime", FixedDatetime):
            response = self.request_agents()
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.data.isascii())
        self.assertEqual(json.loads(response.data)["data"]["context"]["updated_at"], self.run["updated_at"])
        self.assertIs(self.app.json.ensure_ascii, False)

    def test_stale_revision_is_409_and_explicit_fresh_read_observes_new_sources(self):
        first = self.request_agents().json["data"]
        with self.path("twitter").open("ab") as stream:
            stream.write(encoded(action(agent_id=7)))
        self.assert_error_response(self.request_agents({"revision": first["source_revision"]}), "sources_changed", 409)
        fresh = self.request_agents().json["data"]
        self.assertEqual((fresh["matched_count"], fresh["pair_count"]), (2, 2))
        self.assertNotEqual(fresh["source_revision"], first["source_revision"])

    def test_unavailable_coverage_is_a_safe_null_observation_and_missing_state_is_404(self):
        self.path("twitter").unlink()
        response = self.request_agents()
        self.assertEqual(response.status_code, 200)
        self.assert_empty(response.json["data"], "unavailable")
        self.assertIn({"code": "no_action_logs"}, response.json["data"]["warnings"])
        before = self.inventory()
        self.assert_error_response(self.request_agents(simulation_id="sim_missing"), "simulation_not_found", 404)
        self.assertEqual(self.inventory(), before)
        self.assertFalse((self.sim_root / "sim_missing").exists())

    def test_route_rejects_all_mutating_methods_without_calling_reader(self):
        reader = Mock(side_effect=AssertionError("mutating method reached reader"))
        self.namespace["read_saved_activity_agents"] = reader
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(f"/api/simulation/{self.simulation_id}/saved-action-agents")
                self.assertEqual(response.status_code, 405)
        reader.assert_not_called()
