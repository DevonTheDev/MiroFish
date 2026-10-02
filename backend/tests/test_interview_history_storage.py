"""Interview history reads use disposable SQLite with no inference or IPC."""

import json
import sqlite3
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api import simulation as api
from app.services.simulation_runner import SimulationRunner as Runner


def create_database(path, rows):
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE trace (user_id INTEGER, action TEXT, info, created_at)"
        )
        connection.executemany("INSERT INTO trace VALUES (?, ?, ?, ?)", rows)
    connection.close()


@pytest.fixture
def storage(tmp_path, monkeypatch):
    root = tmp_path / "simulation roots ?#%"
    folder = root / "sim_fixture"
    folder.mkdir(parents=True)
    twitter = folder / "twitter_simulation.db"
    reddit = folder / "reddit_simulation.db"
    create_database(
        twitter,
        [
            (
                0,
                "interview",
                json.dumps({"response": "newest", "prompt": "q1"}),
                "2026-01-03",
            ),
            (
                1,
                "interview",
                json.dumps({"response": "older", "prompt": "q2"}),
                "2026-01-01",
            ),
            (0, "post", "{}", "2026-01-04"),
        ],
    )
    create_database(
        reddit,
        [
            (0, "interview", json.dumps({"response": "middle"}), "2026-01-02"),
        ],
    )
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(root))
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix="/api/simulation")
    return SimpleNamespace(
        root=root,
        folder=folder,
        twitter=twitter,
        reddit=reddit,
        client=app.test_client(),
    )


def post(storage, **overrides):
    return storage.client.post(
        "/api/simulation/interview/history",
        json={"simulation_id": "sim_fixture", **overrides},
    )


def symlink(link, target, directory=False):
    try:
        link.symlink_to(target, target_is_directory=directory)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")


def test_both_platforms_are_merged_sorted_and_globally_limited(storage):
    response = post(storage, limit=2)
    assert response.status_code == 200
    assert response.json["data"]["count"] == 2
    assert [row["response"] for row in response.json["data"]["history"]] == [
        "newest",
        "middle",
    ]
    assert [row["platform"] for row in response.json["data"]["history"]] == [
        "twitter",
        "reddit",
    ]


@pytest.mark.parametrize(
    "platform,expected",
    [(None, ["newest", "middle"]), ("twitter", ["newest"]), ("reddit", ["middle"])],
)
def test_agent_zero_and_platform_filtering(storage, platform, expected):
    response = post(storage, agent_id=0, platform=platform)
    assert response.status_code == 200
    assert [row["response"] for row in response.json["data"]["history"]] == expected


@pytest.mark.parametrize("limit", [0, 500])
def test_limit_boundaries_remain_supported(storage, limit):
    response = post(storage, limit=limit)
    assert response.status_code == 200
    assert response.json["data"]["count"] == (0 if limit == 0 else 3)


@pytest.mark.parametrize(
    "field,value",
    [
        ("simulation_id", "../outside"),
        ("simulation_id", "/outside"),
        ("simulation_id", r"..\outside"),
        ("simulation_id", "CON"),
        ("simulation_id", "sim:stream"),
        ("simulation_id", 12),
        ("platform", "../outside"),
        ("platform", "both"),
        ("platform", ""),
        ("platform", 1),
        ("limit", -1),
        ("limit", 501),
        ("limit", True),
        ("limit", 1.5),
        ("limit", "100"),
        ("limit", None),
        ("agent_id", -1),
        ("agent_id", 2**63),
        ("agent_id", False),
        ("agent_id", 1.5),
        ("agent_id", "0"),
    ],
)
def test_invalid_arguments_are_rejected_before_any_database_read(
    storage, monkeypatch, field, value
):
    reads = []
    monkeypatch.setattr(
        Runner,
        "_get_interview_history_from_db",
        classmethod(lambda cls, **kwargs: reads.append(kwargs) or []),
    )
    response = post(storage, **{field: value})
    assert response.status_code == 400
    assert response.json["success"] is False
    assert reads == []


@pytest.mark.parametrize("body", [[], [1], "text", 4, True, None])
def test_non_object_request_bodies_are_rejected(storage, body):
    response = storage.client.post(
        "/api/simulation/interview/history",
        data=json.dumps(body),
        content_type="application/json",
    )
    assert response.status_code == 400
    assert response.json["success"] is False


def test_malformed_json_request_is_a_client_error(storage):
    response = storage.client.post(
        "/api/simulation/interview/history",
        data="{invalid",
        content_type="application/json",
    )
    assert response.status_code == 400


@pytest.mark.parametrize("kind", ["record", "twitter", "reddit", "broken"])
def test_aliases_are_preflighted_before_reading_either_platform(
    storage, tmp_path, monkeypatch, kind
):
    if kind == "record":
        target = tmp_path / "outside"
        storage.folder.rename(target)
        symlink(storage.folder, target, True)
    else:
        path = storage.twitter if kind == "twitter" else storage.reddit
        target = tmp_path / "outside.db"
        if kind == "broken":
            path.unlink()
        else:
            path.rename(target)
        symlink(path, target)
    reads = []
    monkeypatch.setattr(
        Runner,
        "_get_interview_history_from_db",
        classmethod(lambda cls, **kwargs: reads.append(kwargs) or []),
    )
    response = post(storage)
    assert response.status_code == 400
    assert reads == []


def test_unknown_simulation_is_noncreating(storage):
    response = post(storage, simulation_id="sim_unknown")
    assert response.status_code == 200
    assert response.json["data"] == {"count": 0, "history": []}
    assert not (storage.root / "sim_unknown").exists()


def test_configured_root_relocation_remains_supported(storage, tmp_path, monkeypatch):
    alias = tmp_path / "root-alias"
    symlink(alias, storage.root, True)
    monkeypatch.setattr(Runner, "RUN_STATE_DIR", str(alias))
    assert post(storage).json["data"]["count"] == 3


def test_database_connection_is_read_only_and_closed_after_success(
    storage, monkeypatch
):
    original = sqlite3.connect
    opened = []

    def connect(*args, **kwargs):
        connection = original(*args, **kwargs)
        opened.append(connection)
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            connection.execute("CREATE TABLE must_not_write (value)")
        return connection

    with monkeypatch.context() as patch:
        patch.setattr(sqlite3, "connect", connect)
        try:
            assert post(storage, platform="twitter").json["data"]["count"] == 2
            assert len(opened) == 1
            with pytest.raises(sqlite3.ProgrammingError, match="closed"):
                opened[0].execute("SELECT 1")
        finally:
            for connection in opened:
                connection.close()


def test_query_failure_closes_connection_and_returns_empty_history(
    storage, monkeypatch
):
    original = sqlite3.connect
    opened = []

    class BrokenCursor(sqlite3.Cursor):
        def execute(self, *args, **kwargs):
            raise sqlite3.OperationalError("synthetic read failure")

    class BrokenConnection(sqlite3.Connection):
        def cursor(self):
            return super().cursor(factory=BrokenCursor)

    def connect(*args, **kwargs):
        connection = original(*args, **kwargs, factory=BrokenConnection)
        opened.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, "connect", connect)
    try:
        assert post(storage, platform="twitter").json["data"]["history"] == []
        assert len(opened) == 1
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            opened[0].execute("SELECT 1")
    finally:
        for connection in opened:
            connection.close()


def test_database_removed_between_check_and_open_is_not_recreated(storage, monkeypatch):
    original = sqlite3.connect

    def removed_before_connect(*args, **kwargs):
        storage.twitter.unlink()
        return original(*args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", removed_before_connect)
    assert post(storage, platform="twitter").json["data"]["history"] == []
    assert not storage.twitter.exists()


@pytest.mark.parametrize(
    "malformed", ['["value"]', '"text"', "42", "null", "{broken", b"\xff"]
)
def test_malformed_trace_payload_does_not_discard_following_valid_rows(
    storage, malformed
):
    with sqlite3.connect(storage.twitter) as connection:
        connection.execute(
            "INSERT INTO trace VALUES (0, 'interview', ?, '2026-01-05')", (malformed,)
        )
    connection.close()
    response = post(storage, platform="twitter")
    assert response.status_code == 200
    rows = response.json["data"]["history"]
    assert len(rows) == 3
    expected = (
        malformed.decode("utf-8", errors="replace")
        if isinstance(malformed, bytes)
        else malformed
    )
    assert rows[0]["response"] == {"raw": expected}
    assert rows[0]["prompt"] == ""
    assert [row["response"] for row in rows[1:]] == ["newest", "older"]


def test_missing_trace_timestamp_does_not_break_merged_sort(storage):
    with sqlite3.connect(storage.reddit) as connection:
        connection.execute(
            "INSERT INTO trace VALUES (0, 'interview', ?, NULL)",
            (json.dumps({"response": "undated"}),),
        )
    connection.close()
    response = post(storage)
    assert response.status_code == 200
    assert [row["response"] for row in response.json["data"]["history"]] == [
        "newest",
        "middle",
        "older",
        "undated",
    ]


def test_live_wal_commits_remain_visible(storage):
    connection = sqlite3.connect(storage.twitter)
    try:
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        connection.execute(
            "INSERT INTO trace VALUES (0, 'interview', ?, '2026-01-06')",
            (json.dumps({"response": "live"}),),
        )
        connection.commit()
        response = post(storage, platform="twitter")
        assert response.status_code == 200
        assert response.json["data"]["history"][0]["response"] == "live"
    finally:
        connection.close()


def test_default_limit_bounds_the_merged_history(storage):
    with sqlite3.connect(storage.twitter) as connection:
        connection.executemany(
            "INSERT INTO trace VALUES (0, 'interview', ?, '2026-01-10')",
            [(json.dumps({"response": f"answer {index}"}),) for index in range(105)],
        )
    connection.close()
    assert post(storage).json["data"]["count"] == 100
    assert post(storage, limit=500).json["data"]["count"] == 108


def test_largest_sqlite_agent_id_is_accepted(storage):
    response = post(storage, agent_id=2**63 - 1)
    assert response.status_code == 200
    assert response.json["data"] == {"count": 0, "history": []}


@pytest.mark.parametrize("info", [None, "", "{}"])
def test_empty_trace_info_preserves_legacy_empty_response(storage, info):
    with sqlite3.connect(storage.twitter) as connection:
        connection.execute(
            "INSERT INTO trace VALUES (0, 'interview', ?, '2026-01-10')", (info,)
        )
    connection.close()
    response = post(storage, platform="twitter")
    assert response.status_code == 200
    row = response.json["data"]["history"][0]
    assert row["response"] == {}
    assert row["prompt"] == ""
