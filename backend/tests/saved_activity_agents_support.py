"""Isolated fixtures: load only storage and saved readers, never app startup."""

from datetime import datetime
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest


APP = Path(__file__).resolve().parents[1] / "app"
PREFIX = "_saved_activity_agents_test_app"


def _package(name):
    module = types.ModuleType(name)
    module.__path__ = []  # Do not discover/import other application modules.
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
    _load(PREFIX + ".services.saved_activity_agents", "services/saved_activity_agents.py")

storage = sys.modules[PREFIX + ".storage"]
saved = sys.modules[PREFIX + ".services.simulation_comparison"]
pages = sys.modules[PREFIX + ".services.saved_activity"]
rounds = sys.modules[PREFIX + ".services.saved_activity_rounds"]
agents = sys.modules[PREFIX + ".services.saved_activity_agents"]


def action(**changes):
    return {"agent_id": 1, "action_type": "CREATE_POST", "round": 1, **changes}


def event(**changes):
    return {"event_type": "round_start", "round": 1, **changes}


def encoded(row):
    return (json.dumps(row, ensure_ascii=True, allow_nan=False) + "\n").encode("ascii")


def bucket(platform, agent_id, *, success=0, failed=0, unknown=0):
    decimal = str(agent_id)
    return {
        "platform": platform, "agent_id": decimal,
        "count": success + failed + unknown,
        "outcomes": {"success": success, "failed": failed, "unknown": unknown},
        "drilldown_supported": len(decimal) <= 64,
    }


class FixedDatetime:
    @staticmethod
    def now(tz):
        return datetime(2026, 10, 17, 12, 0, 0, tzinfo=tz)


class Query:
    """The MultiDict protocol used by the parser, without a Flask dependency."""
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


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="saved-activity-agents-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sim_root = self.root / "simulations"
        self.run_root = self.root / "runs"
        self.simulation_id = "sim_agents-1"
        self.state = {
            "simulation_id": self.simulation_id, "status": "completed",
            "enable_twitter": True, "enable_reddit": False,
            "created_at": "2026-10-01T00:00:00Z", "profiles_count": 9000,
        }
        self.config = {"simulation_requirement": "PRIVATE_CONFIG", "api_key": "PRIVATE_KEY"}
        self.run = {
            "simulation_id": self.simulation_id, "runner_status": "completed",
            "total_rounds": 5, "current_round": 2,
            "updated_at": "2026-10-02T00:00:00Z", "started_at": "2026-10-01T01:00:00Z",
            "completed_at": "2026-10-02T00:00:00Z",
        }
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
        for kind in ("state", "config", "run"):
            self.write_bytes(kind, encoded(getattr(self, kind)))

    def write_log(self, kind, rows):
        return self.write_bytes(kind, b"".join(row if isinstance(row, bytes) else encoded(row) for row in rows))

    def legacy(self, rows):
        self.path("twitter").unlink(missing_ok=True)
        self.path("reddit").unlink(missing_ok=True)
        return self.write_log("legacy", rows)

    def revision(self):
        paths = saved._paths(str(self.sim_root), str(self.run_root), self.simulation_id)
        return pages._source_revision(self.simulation_id, saved._snapshot(paths))

    def read(self, **kwargs):
        return agents.read_saved_activity_agents(str(self.sim_root), str(self.run_root), self.simulation_id, **kwargs)

    def details(self, **kwargs):
        return pages.read_saved_activity(str(self.sim_root), str(self.run_root), self.simulation_id, **kwargs)

    def round_overview(self, **kwargs):
        return rounds.read_saved_activity_rounds(str(self.sim_root), str(self.run_root), self.simulation_id, **kwargs)

    def assert_error(self, code, status=400, call=None):
        with self.assertRaises(saved.ComparisonError) as caught:
            (call or self.read)()
        self.assertEqual((caught.exception.code, caught.exception.status_code), (code, status))
        self.assertNotIn(str(self.root), str(caught.exception))
        return caught.exception

    def inventory(self):
        return {str(path.relative_to(self.root)): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()}

    def assert_empty(self, result, availability):
        self.assertEqual(result["availability"], availability)
        self.assertEqual(result["agents"], [])
        self.assertEqual(result["pair_count"], 0)
        value = None if availability == "unavailable" else 0
        self.assertEqual(result["matched_count"], value)
        self.assertEqual(result["outcomes"], dict.fromkeys(("success", "failed", "unknown"), value))


class BrokenStream:
    """Keep source fingerprints stable while raising a deterministic late read error."""
    def __init__(self, stream, fail_on):
        self.stream, self.fail_on, self.reads = stream, fail_on, 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stream.close()

    def fileno(self):
        return self.stream.fileno()

    def readline(self, maximum):
        self.reads += 1
        if self.reads == self.fail_on:
            raise OSError("PRIVATE_LATE_IO")
        return self.stream.readline(maximum)
