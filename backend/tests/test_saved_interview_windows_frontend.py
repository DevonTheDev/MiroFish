"""Actual older-window exports reopen/compare locally with storage removed."""
import sqlite3

from test_saved_interviews_api import interview, storage
from test_saved_interviews_frontend import run_workflow, trace_database


def test_older_window_export_reopens_and_compares_without_storage(storage, monkeypatch):
    trace_database(storage.twitter, [interview(0, prompt="Old unique question" if i == 1 else "Repeated question",
        response=f"<literal> saved reply {i} 雪", timestamp=str(i)) for i in range(1, 206)])
    trace_database(storage.reddit, [interview(response="Reddit saved reply")])
    writer = sqlite3.connect(storage.twitter, check_same_thread=False)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA wal_autocheckpoint=0")
    calls = 0
    def change_before_continuation():
        nonlocal calls
        calls += 1
        if calls == 8:
            writer.execute("INSERT INTO trace(user_id,action,info,created_at) VALUES (?,?,?,?)",
                           interview(response="Appended after export", timestamp="after-export"))
            writer.commit()
    retired = storage.folder.with_name("sim_saved_retired")
    monkeypatch.setenv("MIRO_TEST_WINDOW_STORAGE", str(storage.folder))
    def restore_fixture():
        if retired.exists():
            retired.rename(storage.folder)
    try:
        traffic = run_workflow(storage, monkeypatch, "windows", change_before_continuation,
            helper="saved-interview-windows-backend-check.mjs", expected_statuses=[200] * 7 + [409, 200],
            after_workflow=restore_fixture)
        assert len(traffic) == 9
        assert traffic[0][2] == ""
        assert traffic[1][2] == "platform=twitter&agent_id=0&window=1"
        assert "before_row=106&revision=" in traffic[2][2]
        assert "before_row=6&revision=" in traffic[3][2]
        assert "before_row=" not in traffic[-1][2]
    finally:
        restore_fixture()
        writer.close()
