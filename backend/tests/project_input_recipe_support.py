"""Disposable fixtures; importing this file executes only storage and the reader.

Source-prepared only. Execution belongs to the separately approved finite gate.
The application factory and eager app/services initializers are not imported.
"""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest


APP = Path(__file__).resolve().parents[1] / "app"
PREFIX = "_project_input_recipe_test_app"
SOURCE = "\ufeff=== File: original.md ===\r\nCafé 雪 😀 e\u0301\r\n<script>fixture only</script>\x00\t\r\n"
SCENARIO = "Compare community responses.\nKeep Café, 雪, 😀 and an interior \ufeff unchanged."
NAME = "Saved Café 😀"
PUBLIC_ERRORS = {
    "unsafe_path": (400, "The project input path is not supported."),
    "not_found": (404, "Saved project inputs were not found."),
    "incomplete": (409, "Complete saved inputs could not be verified."),
    "changed": (409, "Saved inputs changed during capture. Try downloading again."),
    "too_large": (413, "Saved inputs exceed the input recipe limits."),
    "invalid": (422, "Saved inputs have an unsupported encoding or structure."),
    "unreadable": (500, "Saved inputs could not be read."),
}
BLANK = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _package(name):
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module


def _load(name, relative):
    spec = importlib.util.spec_from_file_location(name, APP / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


if PREFIX not in sys.modules:
    _package(PREFIX)
    _package(PREFIX + ".services")
    _load(PREFIX + ".storage", "storage.py")
    _load(PREFIX + ".services.project_input_recipe", "services/project_input_recipe.py")

storage = sys.modules[PREFIX + ".storage"]
recipe = sys.modules[PREFIX + ".services.project_input_recipe"]


def encoded(value):
    # ASCII escapes deliberately permit malformed Unicode scalar fixtures.
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="project-input-recipe-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = self.root / "projects"
        self.project_id = "proj_recipe-1"
        self.directory = self.projects / self.project_id
        self.directory.mkdir(parents=True)
        self.metadata_path = self.directory / "project.json"
        self.source_path = self.directory / "extracted_text.txt"
        self.metadata = {
            "project_id": self.project_id,
            "name": NAME,
            "simulation_requirement": SCENARIO,
            "total_text_length": len(SOURCE.replace("\r\n", "\n")),
            "status": "failed",
            "ontology": None,
            "error": "PRIVATE_FAILURE_DETAIL",
            "graph_id": "PRIVATE_GRAPH_ID",
            "files": [{"path": "PRIVATE_ORIGINAL_PATH"}],
            "chunk_size": 987,
        }
        self.write_metadata()
        self.source_path.write_bytes(SOURCE.encode("utf-8"))

    def write_metadata(self, value=None):
        self.metadata_path.write_bytes(encoded(self.metadata if value is None else value))

    def write_source(self, value):
        self.source_path.write_bytes(value.encode("utf-8"))
        self.metadata["total_text_length"] = len(value)
        self.write_metadata()

    def read(self, *, root=None, project_id=None):
        return recipe.read_project_input_recipe(
            str(self.projects if root is None else root),
            self.project_id if project_id is None else project_id,
        )

    def document(self, **kwargs):
        payload = self.read(**kwargs)
        self.assertIs(type(payload), bytes)
        self.assertFalse(payload.startswith(b"\xef\xbb\xbf"))
        return json.loads(payload.decode("utf-8", errors="strict"))

    def assert_error(self, short_code, *, call=None):
        status, message = PUBLIC_ERRORS[short_code]
        with self.assertRaises(recipe.InputRecipeError) as caught:
            (self.read if call is None else call)()
        error = caught.exception
        self.assertEqual(error.status, status)
        self.assertEqual(error.code, "input_recipe_" + short_code)
        self.assertEqual(error.public_message, message)
        for private in (str(self.root), "PRIVATE_FAILURE_DETAIL", "PRIVATE_ORIGINAL_PATH", SOURCE):
            self.assertNotIn(private, str(error))
        return error

    def make_symlink(self, link, target, *, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable on this platform")
