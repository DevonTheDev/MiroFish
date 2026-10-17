"""Prepared, unrun Saved posts fixtures; runtime loads only storage and the two named readers.

Each @allocation is a finite source-accounted service/API invocation budget.
Fixture setup SQL is disposable authoring data, never a product read. No app,
conftest, manager, runner, model, network client or background task is imported.
"""
from datetime import datetime
from functools import wraps
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest

APP = Path(__file__).resolve().parents[1] / "app"
PREFIX = "_saved_posts_test_app"
MAX_ID = 9223372036854775807
POST_SCHEMA = """CREATE TABLE post (
 post_id INTEGER PRIMARY KEY, user_id INTEGER, content TEXT,
 original_post_id INTEGER, quote_content TEXT, created_at DATETIME,
 num_likes INTEGER DEFAULT 0, num_dislikes INTEGER DEFAULT 0,
 num_shares INTEGER DEFAULT 0)"""
COMMENT_SCHEMA = """CREATE TABLE comment (
 comment_id INTEGER PRIMARY KEY, post_id INTEGER, user_id INTEGER,
 content TEXT, created_at DATETIME, num_likes INTEGER DEFAULT 0,
 num_dislikes INTEGER DEFAULT 0)"""
POST_KEYS = {"post_id", "user_id", "original_post_id", "content", "quote_content", "created_at"}
COMMENT_KEYS = {"comment_id", "post_id", "user_id", "content", "created_at"}
PAGE_KEYS = {"state", "reason", "offset", "limit", "count", "has_more", "rows"}
ENVELOPE_KEYS = {"simulation_id", "platform", "post_id", "observed_at", "metadata", "database", "posts", "post", "comments"}


def _load(name, relative):
    spec = importlib.util.spec_from_file_location(name, APP / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


if PREFIX not in sys.modules:
    for name in (PREFIX, PREFIX + ".services"):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    _load(PREFIX + ".storage", "storage.py")
    _load(PREFIX + ".services.simulation_comparison", "services/simulation_comparison.py")
    _load(PREFIX + ".services.saved_posts", "services/saved_posts.py")
storage = sys.modules[PREFIX + ".storage"]
saved = sys.modules[PREFIX + ".services.saved_posts"]


def allocation(*, reads=0, api=0):
    """Assert declared call counts at the future gate, not just in its ledger."""
    def decorate(method):
        @wraps(method)
        def run(self):
            self.reader_calls = self.api_calls = 0
            method(self)
            self.assertEqual(self.reader_calls, reads, "reader allocation drift")
            self.assertEqual(self.api_calls, api, "Flask allocation drift")
        run.saved_posts_allocation = {"reads": reads, "api": api}
        return run
    return decorate


class FixedDatetime:
    @staticmethod
    def now(tz):
        return datetime(2026, 10, 17, 12, 0, 0, tzinfo=tz)


class Query:
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
        self.temp = tempfile.TemporaryDirectory(prefix="saved-posts-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sim_root, self.run_root = self.root / "simulations # ? café", self.root / "runs"
        self.simulation_id = "sim_A"
        self.state = {"simulation_id": self.simulation_id, "status": "completed", "enable_twitter": True, "enable_reddit": False}
        self.run = {"simulation_id": self.simulation_id, "runner_status": "completed"}
        self.reader_calls = self.api_calls = 0
        self.write_metadata()
        self.make_database("twitter")
        self.make_database("reddit")

    def path(self, kind="twitter"):
        if kind == "state":
            return self.sim_root / self.simulation_id / "state.json"
        if kind == "run":
            return self.run_root / self.simulation_id / "run_state.json"
        return self.sim_root / self.simulation_id / (kind + "_simulation.db")

    def write_metadata(self):
        for kind, value in (("state", self.state), ("run", self.run)):
            path = self.path(kind)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value), encoding="utf-8")

    def make_database(self, platform, *, post_schema=POST_SCHEMA, comment_schema=COMMENT_SCHEMA):
        path = self.path(platform)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        connection = sqlite3.connect(path)
        try:
            for schema in (post_schema, comment_schema):
                if schema:
                    connection.execute(schema)
            connection.commit()
        finally:
            connection.close()
        return path

    def sql(self, statement, values=(), platform="twitter", many=False):
        connection = sqlite3.connect(self.path(platform))
        try:
            getattr(connection, "executemany" if many else "execute")(statement, values)
            connection.commit()
        finally:
            connection.close()

    def post(self, post_id=1, *, platform="twitter", user_id=0, content="saved text", original_post_id=None, quote_content=None, created_at="raw stored time"):
        self.sql("INSERT INTO post (post_id,user_id,content,original_post_id,quote_content,created_at) VALUES (?,?,?,?,?,?)",
                 (post_id, user_id, content, original_post_id, quote_content, created_at), platform)

    def comment(self, comment_id=1, post_id=1, *, platform="twitter", user_id=0, content="saved comment", created_at=None):
        self.sql("INSERT INTO comment (comment_id,post_id,user_id,content,created_at) VALUES (?,?,?,?,?)",
                 (comment_id, post_id, user_id, content, created_at), platform)

    def service(self, *args, **kwargs):
        self.reader_calls += 1
        return saved.read_saved_posts(*args, **kwargs)

    def read(self, platform="twitter", **kwargs):
        return self.service(str(self.sim_root), str(self.run_root), self.simulation_id, platform=platform, **kwargs)

    def inventory(self):
        """Bounded chunk hashes also cover sparse 128 MiB fixtures without copies."""
        result = {}
        for path in sorted(self.root.rglob("*")):
            relative = str(path.relative_to(self.root))
            if path.is_symlink():
                result[relative] = ("link", str(path.readlink()))
            elif path.is_file():
                digest = hashlib.sha256()
                with path.open("rb") as stream:
                    while chunk := stream.read(65536):
                        digest.update(chunk)
                stat = path.stat()
                result[relative] = ("file", stat.st_size, stat.st_mtime_ns, digest.hexdigest())
            elif path.is_dir():
                result[relative] = ("directory",)
        return result

    def assert_page(self, page, state, *, reason=None, ids=None, id_key="post_id", has_more=False):
        self.assertEqual(set(page), PAGE_KEYS)
        self.assertEqual((page["state"], page["reason"]), (state, reason))
        if state == "unavailable":
            self.assertEqual(page["rows"], [])
            self.assertIsNone(page["count"])
            self.assertIsNone(page["has_more"])
        else:
            self.assertEqual(page["count"], len(page["rows"]))
            self.assertIs(page["has_more"], has_more)
        if ids is not None:
            self.assertEqual([row[id_key] for row in page["rows"]], ids)

    def assert_error(self, code, status=400, call=None):
        with self.assertRaises(saved.saved.ComparisonError) as caught:
            (call or self.read)()
        self.assertEqual((caught.exception.code, caught.exception.status_code), (code, status))
        self.assertNotIn(str(self.root), str(caught.exception))
        return caught.exception
