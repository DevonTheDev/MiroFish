"""Actual isolated Flask route plus real reader and existing recipe download.

Only the named production route functions/decorators are compiled at the
separately released gate. The ordinary application factory stays unimported.
"""

import ast
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Blueprint, Flask, current_app, jsonify, request

from project_input_recipe_support import APP, Fixture, NAME, SCENARIO, SOURCE, recipe, storage
from test_project_input_candidates import candidates

PUBLIC_ERRORS = {
    "invalid_request": (400, "The saved inputs request is not supported."),
    "changed": (409, "Project storage changed during this scan. Try again."),
    "unreadable": (500, "Saved inputs could not be listed."),
}


class CandidateApiTests(Fixture):
    def setUp(self):
        super().setUp()
        source = APP / "api/graph.py"
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        names = {"validate_storage_route_id", "list_project_input_candidates", "export_project_input_recipe"}
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual({node.name for node in functions}, names)
        self.assertEqual(len(functions), 3)
        blueprint = Blueprint("graph_candidates_fixture", __name__)
        self.logger = Mock()
        self.manager = SimpleNamespace(PROJECTS_DIR=str(self.projects),
            _get_project_dir=lambda identifier: storage.storage_path(str(self.projects), storage.validate_record_id(identifier)))
        for name in ("list_projects", "get_project", "get_extracted_text", "create_project", "save_project"):
            setattr(self.manager, name, Mock(side_effect=AssertionError("forbidden project operation")))
        self.namespace = {
            "__name__": "_project_input_candidates_route_fixture", "graph_bp": blueprint,
            "current_app": current_app, "jsonify": jsonify, "request": request,
            "InputRecipeError": recipe.InputRecipeError,
            "read_project_input_recipe": recipe.read_project_input_recipe,
            "InputCandidatesError": candidates.InputCandidatesError,
            "read_project_input_candidates": candidates.read_project_input_candidates,
            "StoragePathError": storage.StoragePathError, "ProjectManager": self.manager, "logger": self.logger,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), self.namespace)
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True)
        self.app.register_blueprint(blueprint, url_prefix="/api/graph")
        self.client = self.app.test_client()

    def listing(self, suffix="", method="GET"):
        return self.client.open("/api/graph/project/input-candidates" + suffix, method=method)

    def assert_failure(self, response, reason):
        status, message = PUBLIC_ERRORS[reason]
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertNotIn("Content-Disposition", response.headers)
        self.assertEqual(response.json, {"success": False, "error_code": "saved_input_candidates_" + reason, "error": message})
        self.assertLess(len(response.data), 1024)
        for private in (str(self.root), SOURCE, "PRIVATE_FAILURE_DETAIL", "private error"):
            self.assertNotIn(private, response.get_data(as_text=True))

    def test_failed_project_is_discovered_then_its_actual_existing_recipe_download_succeeds(self):
        self.assertIsNone(self.metadata["ontology"])
        self.assertEqual(self.metadata["status"], "failed")
        self.metadata["graph_id"] = None
        self.write_metadata()
        self.assertFalse((self.root / "simulations").exists())
        before = {path: path.read_bytes() for path in (self.metadata_path, self.source_path)}
        # A list request must not invoke the recipe or read any source bytes.
        original_open = os.open
        opened = []
        def open_metadata(path, flags):
            opened.append(str(path))
            self.assertEqual(Path(path).name, "project.json")
            self.assertEqual(flags & os.O_ACCMODE, os.O_RDONLY)
            return original_open(path, flags)
        with patch.object(candidates.os, "open", side_effect=open_metadata), patch.dict(self.namespace, {"read_project_input_recipe": Mock(side_effect=AssertionError("recipe read during listing"))}):
            listing = self.listing()
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(len(opened), 1)
        self.assertEqual(listing.headers["Cache-Control"], "no-store")
        self.assertNotIn("Content-Disposition", listing.headers)
        row = listing.json["data"]["items"][0]
        self.assertEqual(row["project_id"], self.project_id)
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["name"], NAME)
        self.assertNotIn("can_export", row)
        downloaded = self.client.get(f'/api/graph/project/{row["project_id"]}/input-recipe')
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.headers["Cache-Control"], "no-store")
        self.assertIn("attachment", downloaded.headers["Content-Disposition"])
        document = json.loads(downloaded.data)
        self.assertEqual(document["source_text"], SOURCE)
        self.assertEqual(document["simulation_requirement"], SCENARIO)
        self.assertEqual(document["source_project_name"], NAME)
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        self.assertEqual(self.logger.mock_calls, [])
        for name in ("list_projects", "get_project", "get_extracted_text", "create_project", "save_project"):
            self.assertEqual(getattr(self.manager, name).mock_calls, [])
        destination = os.environ.get("MIROFISH_CANDIDATE_FIXTURE_DIR")
        if destination:
            # Emit actual route bytes for the frontend workflow gate; the runner
            # supplies one newly created evidence directory, never user storage.
            directory = Path(destination)
            self.assertTrue(directory.is_dir())
            outputs = {"backend-input-candidates.json": listing.data,
                       "backend-input-recipe.json": downloaded.data}
            for name, payload in outputs.items():
                with (directory / name).open("xb") as stream:
                    stream.write(payload)
                with (directory / name).with_suffix(".sha256").open("x") as stream:
                    stream.write(hashlib.sha256(payload).hexdigest() + "  " + name + "\n")

    def test_incomplete_candidate_remains_listed_and_existing_recipe_action_fails(self):
        self.metadata["simulation_requirement"] = None
        self.write_metadata()
        listing = self.listing()
        self.assertEqual(listing.status_code, 200)
        row = listing.json["data"]["items"][0]
        self.assertIsNone(row["scenario_excerpt"])
        response = self.client.get(f'/api/graph/project/{row["project_id"]}/input-recipe')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["error_code"], "input_recipe_incomplete")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertNotIn("Content-Disposition", response.headers)

    def test_unknown_parameters_are_rejected_before_reader_and_cannot_increase_bounds(self):
        reader = Mock(side_effect=AssertionError("invalid request read"))
        self.namespace["read_project_input_candidates"] = reader
        for suffix in ("?limit=1000000", "?cursor=x", "?limit=", "?x=1&x=2", "?refresh=true", "?=x"):
            with self.subTest(suffix=suffix):
                self.assert_failure(self.listing(suffix), "invalid_request")
        self.assertEqual(reader.mock_calls, [])

    def test_success_uses_bounded_encoded_bytes_without_provider_reserialization(self):
        payload = candidates.read_project_input_candidates(str(self.projects))
        reader = Mock(return_value=payload)
        self.namespace["read_project_input_candidates"] = reader
        with patch.object(self.app.json, "dumps", side_effect=AssertionError("reserialized response")):
            response = self.listing()
        self.assertEqual(response.data, payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        reader.assert_called_once_with(str(self.projects))

    def test_known_and_unexpected_failures_are_sanitized_and_never_logged(self):
        for reason in PUBLIC_ERRORS:
            with self.subTest(reason=reason):
                self.namespace["read_project_input_candidates"] = Mock(side_effect=candidates.InputCandidatesError(reason))
                self.assert_failure(self.listing(), reason)
        self.namespace["read_project_input_candidates"] = Mock(side_effect=RuntimeError(str(self.root) + SOURCE + " private error"))
        self.assert_failure(self.listing(), "unreadable")
        self.assertEqual(self.logger.mock_calls, [])

    def test_empty_partial_empty_and_unreadable_remain_distinct(self):
        absent = self.root / "absent"
        self.manager.PROJECTS_DIR = str(absent)
        healthy = self.listing()
        self.assertEqual(healthy.status_code, 200)
        self.assertEqual(healthy.json["data"]["items"], [])
        self.assertFalse(healthy.json["data"]["partial"])
        self.assertFalse(absent.exists())
        absent.mkdir()
        (absent / "irrelevant.file").write_text("ignored")
        partial = self.listing()
        self.assertEqual(partial.json["data"]["items"], [])
        self.assertTrue(partial.json["data"]["partial"])
        self.manager.PROJECTS_DIR = str(self.source_path)
        self.assert_failure(self.listing(), "unreadable")

    def test_route_is_get_only_and_explicitly_registered(self):
        rules = [rule for rule in self.app.url_map.iter_rules() if rule.endpoint.endswith(".list_project_input_candidates")]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0].rule, "/api/graph/project/input-candidates")
        self.assertEqual(rules[0].methods, {"GET", "HEAD", "OPTIONS"})
        self.assertEqual(self.listing(method="POST").status_code, 405)
