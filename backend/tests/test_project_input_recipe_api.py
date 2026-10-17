"""Real Flask semantics for the actual route decorator and before-request guard.

This fixture extracts the two named functions from production graph.py, retaining
their decorators. It does not import the full application, register unrelated
blueprints, run middleware from create_app, or claim live-model coverage.
"""

import ast
from datetime import datetime
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Blueprint, Flask, current_app, jsonify, request

from project_input_recipe_support import APP, Fixture, NAME, PUBLIC_ERRORS, SCENARIO, SOURCE, recipe, storage


class RecipeApiTests(Fixture):
    def setUp(self):
        super().setUp()
        source = APP / "api/graph.py"
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        names = {"validate_storage_route_id", "export_project_input_recipe"}
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual({node.name for node in functions}, names)
        self.assertEqual(len(functions), 2)
        blueprint = Blueprint("graph_recipe_fixture", __name__)
        self.logger = Mock()
        manager = SimpleNamespace(
            PROJECTS_DIR=str(self.projects),
            _get_project_dir=lambda identifier: storage.storage_path(str(self.projects), storage.validate_record_id(identifier)),
            get_project=Mock(side_effect=AssertionError("unbounded project read")),
            get_extracted_text=Mock(side_effect=AssertionError("unbounded source read")),
        )
        self.namespace = {
            "__name__": "_project_input_recipe_route_fixture", "graph_bp": blueprint,
            "current_app": current_app, "jsonify": jsonify, "request": request,
            "InputRecipeError": recipe.InputRecipeError,
            "read_project_input_recipe": recipe.read_project_input_recipe,
            "StoragePathError": storage.StoragePathError,
            "ProjectManager": manager, "logger": self.logger,
        }
        # Compile/execute only during the separately authorized runtime gate.
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), self.namespace)
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True)
        self.app.register_blueprint(blueprint, url_prefix="/api/graph")
        self.client = self.app.test_client()

    def request_export(self, identifier=None, *, method="GET"):
        identifier = self.project_id if identifier is None else identifier
        return self.client.open(f"/api/graph/project/{identifier}/input-recipe", method=method)

    def assert_error_response(self, response, reason):
        status, message = PUBLIC_ERRORS[reason]
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertNotIn("Content-Disposition", response.headers)
        self.assertEqual(response.json, {"success": False, "error_code": "input_recipe_" + reason, "error": message})
        self.assertLess(len(response.data), 1024)
        for forbidden in (str(self.root), SOURCE, "PRIVATE_FAILURE_DETAIL", "PRIVATE_ORIGINAL_PATH", "private read failure"):
            self.assertNotIn(forbidden, response.get_data(as_text=True))

    def test_real_service_output_becomes_the_frontend_interoperability_fixture(self):
        class FixedDatetime:
            @staticmethod
            def now(tz):
                return datetime(2026, 10, 17, 12, 34, 56, 789000, tzinfo=tz)

        with patch.object(recipe, "datetime", FixedDatetime):
            response = self.request_export()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["Content-Disposition"], 'attachment; filename="mirofish-project-input-recipe.json"')
        self.assertFalse(response.data.startswith(b"\xef\xbb\xbf"))
        document = json.loads(response.data)
        self.assertEqual(document["source_text"].encode("utf-8"), self.source_path.read_bytes())
        self.assertEqual(document["simulation_requirement"], SCENARIO)
        self.assertEqual(document["source_project_name"], NAME)
        self.assertEqual(document["captured_at"], "2026-10-17T12:34:56.789Z")
        self.assertEqual(self.logger.mock_calls, [])
        destination = os.environ.get("MIROFISH_RECIPE_FIXTURE_OUTPUT")
        if destination:
            # One exact runner-owned destination; the frontend consumes these
            # actual bytes, never a separately hand-authored successful recipe.
            Path(destination).write_bytes(response.data)

    def test_success_returns_exact_bytes_without_json_provider_reserialization(self):
        payload = b'{"format":"route-byte-sentinel","source_text":"literal\\r\\n"}'
        reader = Mock(return_value=payload)
        self.namespace["read_project_input_recipe"] = reader
        with patch.object(self.app.json, "dumps", side_effect=AssertionError("response reserialized")):
            response = self.request_export()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, payload)
        reader.assert_called_once_with(str(self.projects), self.project_id)

    def test_every_known_failure_is_fixed_sanitized_and_not_downloadable(self):
        for reason in PUBLIC_ERRORS:
            with self.subTest(reason=reason):
                self.namespace["read_project_input_recipe"] = Mock(side_effect=recipe.InputRecipeError(reason))
                self.assert_error_response(self.request_export(), reason)
        self.assertEqual(self.logger.mock_calls, [])

    def test_unexpected_failure_never_exposes_exception_body_or_source_logs(self):
        self.namespace["read_project_input_recipe"] = Mock(side_effect=RuntimeError(str(self.root) + SOURCE + " private read failure"))
        self.assert_error_response(self.request_export(), "unreadable")
        self.assertEqual(self.logger.mock_calls, [])

    def test_unsafe_id_is_sanitized_by_reader_and_route_methods_are_read_only(self):
        for identifier in ("CON", "bad.name", "x" * 129):
            with self.subTest(identifier=identifier):
                self.assert_error_response(self.request_export(identifier), "unsafe_path")
        self.assertEqual(self.request_export(method="POST").status_code, 405)
        rules = [rule for rule in self.app.url_map.iter_rules() if rule.endpoint.endswith(".export_project_input_recipe")]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0].rule, "/api/graph/project/<project_id>/input-recipe")
        self.assertEqual(rules[0].methods, {"GET", "HEAD", "OPTIONS"})

    def test_real_reader_missing_incomplete_invalid_and_oversized_errors_have_no_partial_recipe(self):
        self.source_path.unlink()
        self.assert_error_response(self.request_export(), "not_found")
        self.source_path.write_bytes(b"partial")
        self.assert_error_response(self.request_export(), "incomplete")
        self.source_path.write_bytes(b"\xff")
        self.assert_error_response(self.request_export(), "invalid")
        self.source_path.write_bytes(b"x" * 1048577)
        self.assert_error_response(self.request_export(), "too_large")
        self.assertEqual(self.logger.mock_calls, [])

    def test_existing_guard_still_checks_other_project_endpoints(self):
        # Directly reuse the real guard under another endpoint. No substitute
        # graph endpoint is registered or counted as route coverage.
        with self.app.test_request_context("/api/graph/project/CON"):
            request.url_rule = SimpleNamespace(endpoint="graph_recipe_fixture.get_project")
            request.view_args = {"project_id": "CON"}
            response, status = self.namespace["validate_storage_route_id"]()
            self.assertEqual(status, 400)
            self.assertFalse(response.json["success"])
