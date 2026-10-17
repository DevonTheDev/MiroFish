"""Isolated fixtures: load only reviewed storage/readers, never app initialization."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


APP = Path(__file__).resolve().parents[1] / "app"
PREFIX = "_saved_actions_export_test_app"


def _package(name):
    module = types.ModuleType(name)
    # Empty search paths prevent implicit imports of unreviewed app modules.
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
    _load(PREFIX + ".services.simulation_comparison", "services/simulation_comparison.py")
    _load(PREFIX + ".services.saved_activity", "services/saved_activity.py")
    _load(PREFIX + ".services.saved_activity_rounds", "services/saved_activity_rounds.py")
    _load(PREFIX + ".services.saved_actions_export", "services/saved_actions_export.py")

storage = sys.modules[PREFIX + ".storage"]
saved = sys.modules[PREFIX + ".services.simulation_comparison"]
pages = sys.modules[PREFIX + ".services.saved_activity"]
rounds = sys.modules[PREFIX + ".services.saved_activity_rounds"]
export = sys.modules[PREFIX + ".services.saved_actions_export"]


def action(**changes):
    return {"agent_id": 1, "action_type": "CREATE_POST", "round": 1, **changes}


def event(**changes):
    return {"event_type": "round_start", "round": 1, **changes}


def encoded(row):
    return (json.dumps(row, ensure_ascii=True, allow_nan=False) + "\n").encode("ascii")


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="saved-actions-export-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sim_root = self.root / "simulations"
        self.run_root = self.root / "runs"
        self.simulation_id = "sim_export-1"
        self.state = {
            "simulation_id": self.simulation_id, "status": "completed",
            "enable_twitter": True, "enable_reddit": False,
            "created_at": "2026-10-01T00:00:00Z",
        }
        self.config = {"simulation_requirement": "PRIVATE_CONFIG_MARKER", "api_key": "NEVER_EXPORT_CONFIG"}
        self.run = {"simulation_id": self.simulation_id, "runner_status": "completed",
                    "total_rounds": 5, "current_round": 2}
        self.write_metadata()
        self.write_log("twitter", [action()])

    def path(self, kind):
        if kind in {"state", "config"}:
            return self.sim_root / self.simulation_id / {
                "state": "state.json", "config": "simulation_config.json",
            }[kind]
        base = self.run_root / self.simulation_id
        if kind == "run":
            return base / "run_state.json"
        return base / ("actions.jsonl" if kind == "legacy" else kind + "/actions.jsonl")

    def write_bytes(self, kind, value):
        path = self.path(kind)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
        return path

    def write_metadata(self):
        for name in ("state", "config", "run"):
            self.write_bytes(name, encoded(getattr(self, name)))

    def write_log(self, kind, rows):
        return self.write_bytes(kind, b"".join(row if isinstance(row, bytes) else encoded(row) for row in rows))

    def revision(self):
        paths = saved._paths(str(self.sim_root), str(self.run_root), self.simulation_id)
        return pages._source_revision(self.simulation_id, saved._snapshot(paths))

    def read(self, revision=None, simulation_id=None):
        return export.read_saved_actions_export(
            str(self.sim_root), str(self.run_root), simulation_id or self.simulation_id,
            revision=self.revision() if revision is None else revision,
        )

    def document(self):
        payload = self.read()
        self.assertIs(type(payload), bytes)
        self.assertTrue(payload.endswith(b"\n"))
        self.assertTrue(payload.isascii())
        return json.loads(payload)

    def assert_error(self, code, status, *, reason=None, call=None):
        with self.assertRaises(saved.ComparisonError) as caught:
            (call or self.read)()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.status_code, status)
        if reason is not None:
            self.assertEqual(caught.exception.reason, reason)
        self.assertNotIn(str(self.root), str(caught.exception))
        return caught.exception

    def warnings(self, document):
        return {warning["code"] for warning in document["warnings"]}

    def legacy(self, rows):
        self.path("twitter").unlink(missing_ok=True)
        self.path("reddit").unlink(missing_ok=True)
        self.write_log("legacy", rows)


class Query:
    """Minimal MultiDict protocol for parser-only tests without Flask imports."""
    def __init__(self, items=()):
        self.values = {}
        for key, value in items:
            self.values.setdefault(key, []).append(value)

    def __iter__(self):
        return iter(self.values)

    def __getitem__(self, key):
        return self.values[key][0]

    def get(self, key, default=None):
        return self[key] if key in self.values else default

    def getlist(self, key):
        return self.values.get(key, [])
