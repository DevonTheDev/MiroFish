"""Real Flask request/response semantics around only the extracted export route.

The full simulation API module is never imported: its unrelated live services
are outside this gate. AST extraction is a qualification harness, not production.
"""

import ast
from datetime import datetime
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Blueprint, Flask, current_app, jsonify, request

from saved_actions_export_support import APP, Fixture, action, export, saved, storage


class ExportApiTests(Fixture):
    def setUp(self):
        super().setUp()
        source = APP / "api/simulation.py"
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name == "export_saved_simulation_actions"]
        self.assertEqual(len(functions), 1)
        blueprint = Blueprint("saved_actions_export_fixture", __name__)
        self.namespace = {
            "__name__": "_saved_actions_export_api_fixture", "simulation_bp": blueprint,
            "current_app": current_app, "jsonify": jsonify, "request": request,
            "ComparisonError": saved.ComparisonError, "StoragePathError": storage.StoragePathError,
            "parse_saved_actions_export_query": export.parse_saved_actions_export_query,
            "read_saved_actions_export": export.read_saved_actions_export,
            "SimulationManager": SimpleNamespace(SIMULATION_DATA_DIR=str(self.sim_root)),
            "SimulationRunner": SimpleNamespace(RUN_STATE_DIR=str(self.run_root)),
            "logger": Mock(),
        }
        isolated = ast.Module(body=functions, type_ignores=[])
        exec(compile(isolated, str(source), "exec"), self.namespace)
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True)
        self.app.register_blueprint(blueprint, url_prefix="/api/simulation")
        self.client = self.app.test_client()

    def request_export(self, query=None, simulation_id=None):
        if query is None:
            query = {"revision": self.revision()}
        return self.client.get(
            f"/api/simulation/{simulation_id or self.simulation_id}/saved-actions/export",
            query_string=query,
        )

    def assert_error_response(self, response, code, status):
        self.assertEqual(response.status_code, status, response.get_data(as_text=True))
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertNotIn("Content-Disposition", response.headers)
        self.assertLess(len(response.data), 4096)
        self.assertEqual(response.json["success"], False)
        self.assertEqual(response.json["error_code"], code)
        self.assertNotIn(str(self.root), response.get_data(as_text=True))
        self.assertNotIn("private path marker", response.get_data(as_text=True))

    def test_success_returns_exact_bytes_without_json_provider_reserialization(self):
        payload = b'{"format":"mirofish-saved-actions","opaque":"\\ud800","integer":9007199254740993}\n'
        reader = Mock(return_value=payload)
        self.namespace["read_saved_actions_export"] = reader
        revision = self.revision()
        with patch.object(self.app.json, "dumps", side_effect=AssertionError("response reserialized")):
            response = self.request_export({"revision": revision})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, payload)
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["Content-Disposition"],
                         f'attachment; filename="{self.simulation_id}-saved-actions-{revision[:12]}.json"')
        reader.assert_called_once_with(str(self.sim_root), str(self.run_root), self.simulation_id, revision=revision)

    def test_real_reader_response_has_matching_identity_and_complete_actions(self):
        rows = [action(agent_id=10**80 + index, text="雪 😀 \ud800", success=None) for index in range(120)]
        rows.extend([rows[-1], rows[-1]])
        self.write_log("twitter", rows)
        class FixedDatetime:
            @staticmethod
            def now(tz):
                return datetime(2026, 10, 17, 0, 0, 0, tzinfo=tz)
        with patch.object(export, "datetime", FixedDatetime):
            response = self.request_export()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data.isascii())
        self.assertTrue(response.data.endswith(b"\n"))
        document = json.loads(response.data)
        self.assertEqual(document["simulation_id"], self.simulation_id)
        self.assertEqual(document["source_revision"], self.revision())
        self.assertEqual(document["record_count"], 122)
        self.assertEqual(len(document["actions"]), 122)
        self.assertEqual(document["scope"], "all_saved_actions")
        self.assertEqual(document["actions"][0]["agent_id"], str(10**80))
        self.assertEqual(document["actions"][-1]["details_json"], document["actions"][-2]["details_json"])
        destination = os.environ.get("MIRO_SAVED_EXPORT_FIXTURE")
        if destination:
            self.assertLessEqual(len(response.data), 2 * 1024**2)
            # The bounded runner supplies one reviewed destination; use exact
            # Flask response bytes for the frontend's mocked-fetch file contract.
            Path(destination).write_bytes(response.data)

    def test_query_rejections_precede_reader(self):
        reader = Mock(side_effect=AssertionError("invalid query reached reader"))
        self.namespace["read_saved_actions_export"] = reader
        cases = [([], "invalid_revision"), ([("revision", "")], "invalid_revision"),
                 ([("revision", "A" * 64)], "invalid_revision"),
                 ([("revision", "a" * 64), ("revision", "b" * 64)], "invalid_revision"),
                 ([("revision", "a" * 64), ("platform", "twitter")], "invalid_filters"),
                 ([("revision", "a" * 64), ("limit", "100")], "invalid_filters"),
                 ([("revision", "a" * 64), ("q", "secret")], "invalid_filters")]
        for query, code in cases:
            with self.subTest(query=query):
                self.assert_error_response(self.request_export(query), code, 400)
        reader.assert_not_called()

    def test_safe_public_errors_have_no_attachment_and_no_cache(self):
        for code, status in (("invalid_selection", 400), ("invalid_revision", 400), ("unsafe_path", 400),
                             ("simulation_not_found", 404), ("simulation_unreadable", 404),
                             ("simulation_active", 409), ("run_not_terminal", 409),
                             ("sources_changed", 409), ("export_too_large", 413)):
            with self.subTest(code=code):
                self.namespace["read_saved_actions_export"] = Mock(side_effect=saved.ComparisonError(code, "Safe refusal.", status))
                self.assert_error_response(self.request_export(), code, status)

    def test_incomplete_error_exposes_bounded_reason_code(self):
        for reason in ("no_action_logs", "platform_log_missing", "platform_coverage_unknown", "source_unreadable", "invalid_records"):
            with self.subTest(reason=reason):
                error = saved.ComparisonError("export_incomplete", "Saved records incomplete.", 422)
                error.reason = reason
                self.namespace["read_saved_actions_export"] = Mock(side_effect=error)
                response = self.request_export()
                self.assert_error_response(response, "export_incomplete", 422)
                self.assertEqual(response.json["reason_code"], reason)

    def test_storage_exception_maps_to_safe_error(self):
        self.namespace["read_saved_actions_export"] = Mock(side_effect=storage.StoragePathError("private path marker"))
        self.assert_error_response(self.request_export(), "unsafe_path", 400)

    def test_unexpected_exception_is_generic_and_not_downloadable(self):
        self.namespace["read_saved_actions_export"] = Mock(side_effect=RuntimeError("private path marker"))
        self.assert_error_response(self.request_export(), "export_unavailable", 500)

    def test_real_reader_incomplete_and_conflict_do_not_download(self):
        revision = self.revision()
        self.write_log("twitter", [b"invalid\n"])
        self.assert_error_response(self.request_export({"revision": revision}), "sources_changed", 409)
        response = self.request_export()
        self.assert_error_response(response, "export_incomplete", 422)
        self.assertEqual(response.json["reason_code"], "invalid_records")

    def test_unsafe_filename_inputs_are_rejected(self):
        for identifier in ("CON", "bad.name", "a" * 129):
            with self.subTest(identifier=identifier):
                self.assert_error_response(self.request_export({"revision": "a" * 64}, identifier), "invalid_selection", 400)
