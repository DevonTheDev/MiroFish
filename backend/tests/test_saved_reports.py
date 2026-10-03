"""The saved report library reads bounded snapshots without generation side effects."""

import hashlib
import importlib
import importlib.util
import json
import os
from pathlib import Path

import pytest
from werkzeug.datastructures import MultiDict


def test_saved_report_reader_exists():
    assert importlib.util.find_spec("app.services.saved_reports") is not None, "Saved report reader is missing"


@pytest.fixture
def reader():
    name = "app.services.saved_reports"
    assert importlib.util.find_spec(name) is not None, "Saved report reader is missing"
    return importlib.import_module(name)


def metadata(report_id="report_one", **overrides):
    return {
        "report_id": report_id, "simulation_id": "sim_saved", "status": "completed",
        "simulation_requirement": "Saved requirement", "created_at": "2026-01-01T12:00:00",
        "completed_at": "2026-01-01T13:00:00", "outline": {"title": "Saved title", "summary": "Saved summary", "sections": []},
        "markdown_content": "# Embedded", **overrides,
    }


def save(root, report_id="report_one", *, legacy=False, body=None, **overrides):
    path = root / (f"{report_id}.json" if legacy else f"{report_id}/meta.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata(report_id, **overrides), ensure_ascii=False), encoding="utf-8")
    if body is not None:
        (root / f"{report_id}.md" if legacy else path.parent / "full_report.md").write_bytes(body)
    return path


def error(reader, code, status, operation):
    with pytest.raises(reader.SavedReportError) as caught:
        operation()
    assert (caught.value.code, caught.value.status_code) == (code, status)
    assert "PRIVATE" not in str(caught.value)
    return caught.value


def inventory(root):
    return {str(p.relative_to(root)): (p.lstat().st_mode, p.read_bytes() if p.is_file() and not p.is_symlink() else None)
            for p in root.rglob("*")}


def test_missing_root_is_empty_and_never_created(reader, tmp_path):
    root = tmp_path / "missing"
    result = reader.list_saved_reports(root)
    assert result["reports"] == []
    assert result["matched_count"] == result["returned_count"] == result["unavailable_count"] == 0
    assert result["has_more"] is False
    assert result["filters"] == {"q": None, "status": None}
    assert (result["offset"], result["limit"]) == (0, 20)
    assert result["observed_at"].endswith("+00:00")
    assert len(result["source_revision"]) == 64
    error(reader, "report_not_found", 404, lambda: reader.read_saved_report(root, "report_one"))
    assert not root.exists()


def test_real_report_manager_records_round_trip_without_read_side_effects(reader, tmp_path, monkeypatch):
    from app.services.report_agent import Report, ReportManager, ReportOutline, ReportStatus
    root = tmp_path / "reports"
    monkeypatch.setattr(ReportManager, "REPORTS_DIR", str(root))
    report = Report("report_earlier", "sim_saved", "graph_missing", "Requirements Café 雪", ReportStatus.COMPLETED,
                    ReportOutline("Saved title", "Saved summary", []), "# Saved\n\nBody", "2026-01-01T12:00:00", "2026-01-01T13:00:00")
    ReportManager.save_report(report)
    report.report_id, report.status = "report_later", ReportStatus.FAILED
    report.created_at, report.markdown_content = "2026-01-02T12:00:00", ""
    ReportManager.save_report(report)
    before = inventory(root)
    monkeypatch.setattr(ReportManager, "get_report", lambda *a, **k: pytest.fail("Generation manager reader called"))
    monkeypatch.setattr(ReportManager, "_ensure_reports_dir", lambda *a, **k: pytest.fail("Reader attempted to create storage"))
    first = reader.list_saved_reports(root, limit=1)
    assert first["matched_count"] == 2 and first["has_more"] is True
    assert first["reports"][0]["report_id"] == "report_later"
    second = reader.list_saved_reports(root, offset=1, limit=1, revision=first["source_revision"])
    row = second["reports"][0]
    assert row == {"report_id": "report_earlier", "simulation_id": "sim_saved", "title": "Saved title", "summary_preview": "Saved summary", "requirement_preview": "Requirements Café 雪", "status": "completed", "created_at": "2026-01-01T12:00:00", "completed_at": "2026-01-01T13:00:00", "source": "modern", "metadata_revision": row["metadata_revision"]}
    detail = reader.read_saved_report(root, row["report_id"], revision=row["metadata_revision"])
    assert detail["markdown_content"] == "# Saved\n\nBody"
    assert detail["content_available"] is True and detail["content_source"] == "full_report.md"
    assert detail["content_error"] is None
    assert detail["content_revision"] == hashlib.sha256(b"# Saved\n\nBody").hexdigest()
    assert detail["content_bytes"] == len(b"# Saved\n\nBody")
    assert inventory(root) == before


def test_search_full_metadata_casefold_literal_and_bounded_previews(reader, tmp_path):
    save(tmp_path, outline={"title": "T" * 400, "summary": "x" * 600 + "Straße [.*]"}, simulation_requirement="R" * 600 + "Needle", markdown_content="body-only-secret")
    for query in ("STRASSE", "[.*]", "needle", "sim_saved", "REPORT_ONE"):
        result = reader.list_saved_reports(tmp_path, q="  " + query + "  ")
        assert result["matched_count"] == 1 and result["filters"]["q"] == query
        row = result["reports"][0]
        assert len(row["title"]) == 300
        assert len(row["summary_preview"]) == len(row["requirement_preview"]) == 500
    assert reader.list_saved_reports(tmp_path, q="body-only-secret")["matched_count"] == 0
    assert reader.list_saved_reports(tmp_path, status="failed")["matched_count"] == 0


def test_unknown_and_missing_status_never_becomes_completed_and_missing_dates_sort_last(reader, tmp_path):
    save(tmp_path, "report_b", status="future-status", created_at="2026-01-01")
    save(tmp_path, "report_a", status=None, created_at="2026-01-01")
    path = save(tmp_path, "report_z", created_at=None, completed_at=None, outline=None, simulation_id=None)
    value = json.loads(path.read_text()); value.pop("status"); path.write_text(json.dumps(value))
    rows = reader.list_saved_reports(tmp_path)["reports"]
    assert [row["report_id"] for row in rows] == ["report_a", "report_b", "report_z"]
    assert {row["status"] for row in rows} == {"unknown"}
    assert rows[-1]["title"] == "report_z" and rows[-1]["created_at"] is None


@pytest.mark.parametrize("modern", ["missing_meta", "corrupt", "identity", "symlink", "non_directory"])
def test_modern_namespace_always_shadows_legacy(reader, tmp_path, modern):
    save(tmp_path, legacy=True, body=b"Old legacy")
    folder = tmp_path / "report_one"
    if modern == "non_directory":
        folder.write_text("not a directory")
    elif modern == "symlink":
        target = tmp_path / "unrelated.target"; target.mkdir()
        folder.symlink_to(target, target_is_directory=True)
    else:
        folder.mkdir()
        if modern == "corrupt": (folder / "meta.json").write_text("{")
        if modern == "identity": (folder / "meta.json").write_text(json.dumps(metadata("other_report")))
    result = reader.list_saved_reports(tmp_path)
    assert result["reports"] == [] and result["unavailable_count"] == 1
    expected = "identity_mismatch" if modern == "identity" else "unsafe_path" if modern in {"symlink", "non_directory"} else "metadata_unreadable"
    assert result["unavailable_reasons"] == [{"code": expected, "count": 1}]
    error(reader, "metadata_unavailable", 422, lambda: reader.read_saved_report(tmp_path, "report_one"))


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("body", [b"", "# Café\r\n雪\r\n\r\n".encode()])
def test_selected_file_preserves_exact_utf8_even_empty_and_never_reads_twice(reader, tmp_path, monkeypatch, legacy, body):
    save(tmp_path, legacy=legacy, body=body)
    original = reader._open_source
    opened = []
    def observe(path):
        opened.append(str(path))
        return original(path)
    monkeypatch.setattr(reader, "_open_source", observe)
    result = reader.read_saved_report(tmp_path, "report_one")
    assert result["markdown_content"].encode() == body
    assert result["content_available"] is True and result["content_bytes"] == len(body)
    assert result["content_revision"] == hashlib.sha256(body).hexdigest()
    assert result["content_source"] == ("legacy_markdown" if legacy else "full_report.md")
    assert len(opened) == len(set(opened)) == 2


@pytest.mark.parametrize("value,expected,available", [("", None, True), ("# Embedded\r\n雪", None, True), (None, "not_saved", False), (42, "unreadable", False), ("\ud800", "unreadable", False)])
def test_embedded_content_and_missing_or_invalid_body(reader, tmp_path, value, expected, available):
    path = save(tmp_path)
    data = metadata(markdown_content=value)
    path.write_text(json.dumps(data), encoding="utf-8")
    result = reader.read_saved_report(tmp_path, "report_one")
    assert result["content_available"] is available and result["content_error"] == expected
    assert result["title"] == "Saved title"
    if available:
        assert result["content_source"] == "metadata" and result["markdown_content"] == value
    else:
        assert result["markdown_content"] is result["content_revision"] is result["content_bytes"] is None


@pytest.mark.parametrize("kind", ["bad_utf8", "symlink", "directory", "fifo", "too_large", "denied"])
def test_explicit_unusable_body_never_falls_back_or_hides_metadata(reader, tmp_path, monkeypatch, kind):
    save(tmp_path)
    path = tmp_path / "report_one/full_report.md"
    if kind == "bad_utf8": path.write_bytes(b"\xff")
    elif kind == "symlink":
        target = tmp_path / "PRIVATE.md"; target.write_text("PRIVATE body"); path.symlink_to(target)
    elif kind == "directory": path.mkdir()
    elif kind == "fifo": os.mkfifo(path)
    elif kind == "too_large":
        path.write_bytes(b"x" * 31); monkeypatch.setattr(reader, "MAX_MARKDOWN_BYTES", 30)
    elif kind == "denied":
        path.write_text("Body")
        original = reader._open_source
        def refuse(filename):
            if str(filename) == str(path): raise PermissionError("PRIVATE path denied")
            return original(filename)
        monkeypatch.setattr(reader, "_open_source", refuse)
    result = reader.read_saved_report(tmp_path, "report_one")
    assert result["content_available"] is False and result["markdown_content"] is None
    assert result["content_error"] == ("too_large" if kind == "too_large" else "unreadable")
    assert result["content_source"] == "full_report.md"
    assert result["title"] == "Saved title"
    assert "PRIVATE" not in json.dumps(result)


def test_listing_never_opens_markdown_logs_outline_or_graph_state(reader, tmp_path, monkeypatch):
    save(tmp_path, body=b"# Selected")
    for name in ("outline.json", "progress.json", "agent_log.jsonl", "console_log.txt"):
        (tmp_path / "report_one" / name).write_text("PRIVATE")
    original = reader._open_source
    def only_metadata(path):
        assert Path(path).name == "meta.json"
        return original(path)
    monkeypatch.setattr(reader, "_open_source", only_metadata)
    assert reader.list_saved_reports(tmp_path)["matched_count"] == 1


@pytest.mark.parametrize("field,value", [("report_id", 2), ("simulation_id", []), ("status", {}), ("created_at", 2), ("completed_at", False), ("simulation_requirement", []), ("outline", []), ("outline", {"title": 2}), ("outline", {"summary": []})])
def test_wrong_metadata_types_are_counted_and_unavailable(reader, tmp_path, field, value):
    save(tmp_path, **{field: value}) if field != "report_id" else (tmp_path / "report_one.json").write_text(json.dumps(metadata(report_id=value)))
    result = reader.list_saved_reports(tmp_path)
    assert result["matched_count"] == 0 and result["unavailable_count"] == 1
    error(reader, "metadata_unavailable", 422, lambda: reader.read_saved_report(tmp_path, "report_one"))


@pytest.mark.parametrize("raw", [b"{", b"[]", b"null", b"\xff", b'{"report_id":"report_one","x":NaN}', b'{"report_id":"report_one","report_id":"other"}', b"[" * 1200 + b"]" * 1200])
def test_malformed_metadata_never_leaks_parser_errors(reader, tmp_path, raw):
    (tmp_path / "report_one.json").write_bytes(raw)
    result = reader.list_saved_reports(tmp_path)
    assert result["unavailable_reasons"] == [{"code": "metadata_unreadable", "count": 1}]
    error(reader, "metadata_unavailable", 422, lambda: reader.read_saved_report(tmp_path, "report_one"))


def test_invalid_names_and_unrelated_files_are_excluded_and_configured_root_can_move(reader, tmp_path):
    root = tmp_path / "actual"; root.mkdir()
    for name in ("CON.json", "../ignored", "bad id.json", "report_one.md", "other.txt"):
        if "/" not in name: (root / name).write_text("not metadata")
    save(root)
    alias = tmp_path / "configured"; alias.symlink_to(root, target_is_directory=True)
    assert reader.list_saved_reports(alias)["matched_count"] == 1
    assert reader.list_saved_reports(alias)["unavailable_count"] == 0
    assert reader.read_saved_report(alias, "report_one")["content_available"] is True


@pytest.mark.parametrize("query", [[("unknown", "x")], [("q", "x"), ("q", "x")], [("limit", "1"), ("limit", "2")], [("limit", "0")], [("limit", "51")], [("limit", " 1")], [("offset", "-1")], [("offset", "2001")], [("offset", "1")], [("q", "x" * 201)], [("status", "unknown")], [("status", "COMPLETED")], [("revision", "A" * 64)], [("revision", "0" * 63)]])
def test_query_parser_strictly_rejects_unknown_duplicate_and_invalid_values(reader, query):
    error(reader, "invalid_query", 400, lambda: reader.parse_library_query(MultiDict(query)))


def test_query_parser_returns_normalized_valid_kwargs_and_detail_only_revision(reader):
    parsed = reader.parse_library_query(MultiDict({"q": "  Café  ", "limit": "050", "offset": "000", "status": "completed"}))
    assert parsed == {"q": "Café", "status": "completed", "offset": 0, "limit": 50, "revision": None}
    assert reader.parse_library_query(MultiDict({"q": " \t "}))["q"] is None
    assert reader.parse_report_query(MultiDict()) == {"revision": None}
    assert reader.parse_report_query(MultiDict({"revision": "a" * 64})) == {"revision": "a" * 64}
    for query in (MultiDict({"q": "text"}), MultiDict({"revision": "bad"}), MultiDict([("revision", "a" * 64)] * 2)):
        error(reader, "invalid_query", 400, lambda: reader.parse_report_query(query))


@pytest.mark.parametrize("selection", [{"q": 2}, {"q": "\ud800"}, {"offset": True}, {"limit": False}, {"status": []}, {"revision": 2}, {"offset": 1}])
def test_direct_library_arguments_are_validated_before_storage(reader, tmp_path, monkeypatch, selection):
    monkeypatch.setattr(reader.os, "scandir", lambda *a, **k: pytest.fail("Invalid query inspected storage"))
    error(reader, "invalid_query", 400, lambda: reader.list_saved_reports(tmp_path, **selection))


@pytest.mark.parametrize("report_id", ["../secret", "a/b", "CON", "", "a" * 129, 1, "report.json"])
def test_invalid_report_ids_rejected_before_storage(reader, tmp_path, monkeypatch, report_id):
    monkeypatch.setattr(reader.os, "lstat", lambda *a, **k: pytest.fail("Invalid ID inspected storage"))
    error(reader, "invalid_report_id", 400, lambda: reader.read_saved_report(tmp_path, report_id))


def test_raw_catalogue_entry_limit_counts_unrelated_entries(reader, tmp_path, monkeypatch):
    for index in range(5): (tmp_path / f"unrelated_{index}.txt").touch()
    monkeypatch.setattr(reader, "MAX_CATALOGUE_ENTRIES", 4)
    error(reader, "catalogue_too_large", 413, lambda: reader.list_saved_reports(tmp_path))


def test_individual_json_size_is_counted_but_aggregate_budget_is_global_error(reader, tmp_path, monkeypatch):
    path = save(tmp_path)
    monkeypatch.setattr(reader, "MAX_METADATA_BYTES", path.stat().st_size - 1)
    result = reader.list_saved_reports(tmp_path)
    assert result["unavailable_reasons"] == [{"code": "metadata_too_large", "count": 1}]
    monkeypatch.setattr(reader, "MAX_METADATA_BYTES", 10000)
    save(tmp_path, "report_two")
    monkeypatch.setattr(reader, "MAX_TOTAL_METADATA_BYTES", path.stat().st_size)
    error(reader, "catalogue_too_large", 413, lambda: reader.list_saved_reports(tmp_path, q="no-match"))


def test_list_and_detail_serialized_envelopes_have_independent_limits(reader, tmp_path, monkeypatch):
    save(tmp_path, body=b"\x00" * 100)
    monkeypatch.setattr(reader, "MAX_LIST_RESPONSE_BYTES", 100)
    error(reader, "response_too_large", 413, lambda: reader.list_saved_reports(tmp_path))
    monkeypatch.setattr(reader, "MAX_DETAIL_RESPONSE_BYTES", 1000)
    error(reader, "response_too_large", 413, lambda: reader.read_saved_report(tmp_path, "report_one"))


def test_revisions_pin_catalogue_metadata_and_skipped_sources_but_allow_fresh_body(reader, tmp_path):
    path = save(tmp_path, body=b"Original")
    broken = tmp_path / "report_bad.json"; broken.write_text("{")
    first = reader.list_saved_reports(tmp_path)
    row = first["reports"][0]
    (path.parent / "full_report.md").write_bytes(b"Fresh\r\n")
    detail = reader.read_saved_report(tmp_path, "report_one", revision=row["metadata_revision"])
    assert detail["markdown_content"] == "Fresh\r\n"
    broken.write_text("[]")
    error(reader, "sources_changed", 409, lambda: reader.list_saved_reports(tmp_path, revision=first["source_revision"]))
    save(tmp_path, outline={"title": "New title", "summary": "Summary"})
    error(reader, "sources_changed", 409, lambda: reader.read_saved_report(tmp_path, "report_one", revision=row["metadata_revision"]))


def test_ordinary_file_change_during_metadata_read_is_conflict(reader, tmp_path, monkeypatch):
    path = save(tmp_path)
    original = reader._open_source
    class ChangingStream:
        def __init__(self, stream): self.stream = stream
        def __enter__(self): return self
        def __exit__(self, *args): self.stream.close()
        def fileno(self): return self.stream.fileno()
        def read(self, maximum):
            result = self.stream.read(maximum)
            path.write_text(json.dumps(metadata(outline={"title": "Changed", "summary": "Changed"})))
            return result
    monkeypatch.setattr(reader, "_open_source", lambda filename: ChangingStream(original(filename)))
    error(reader, "sources_changed", 409, lambda: reader.list_saved_reports(tmp_path))


def test_catalogue_changes_during_scan_and_metadata_changes_during_body_are_conflicts(reader, tmp_path, monkeypatch):
    path = save(tmp_path, body=b"Body")
    original = reader._open_source
    class ChangingStream:
        def __init__(self, stream, filename): self.stream, self.filename = stream, Path(filename)
        def __enter__(self): return self
        def __exit__(self, *args): self.stream.close()
        def fileno(self): return self.stream.fileno()
        def read(self, maximum):
            result = self.stream.read(maximum)
            if self.filename.name == "meta.json": save(tmp_path, "report_new")
            if self.filename.name == "full_report.md": path.write_text(json.dumps(metadata(status="failed")))
            return result
    monkeypatch.setattr(reader, "_open_source", lambda filename: ChangingStream(original(filename), filename))
    error(reader, "sources_changed", 409, lambda: reader.list_saved_reports(tmp_path))
    error(reader, "sources_changed", 409, lambda: reader.read_saved_report(tmp_path, "report_one"))


def test_unreadable_root_has_fixed_safe_error(reader, tmp_path, monkeypatch):
    def refuse(*args, **kwargs): raise PermissionError("PRIVATE filesystem path")
    monkeypatch.setattr(reader.os, "scandir", refuse)
    error(reader, "library_unavailable", 500, lambda: reader.list_saved_reports(tmp_path))


@pytest.mark.parametrize("legacy", [False, True])
def test_utf8_bom_is_preserved_as_saved_content(reader, tmp_path, legacy):
    body = b"\xef\xbb\xbf# Heading\r\n"
    save(tmp_path, legacy=legacy, body=body)
    captured = reader.read_saved_report(tmp_path, "report_one")
    assert captured["markdown_content"].startswith("\ufeff")
    assert captured["markdown_content"].encode("utf-8") == body
    assert captured["content_revision"] == hashlib.sha256(body).hexdigest()


@pytest.mark.parametrize("embedded", [False, True])
def test_content_limit_counts_utf8_bytes_and_accepts_exact_boundary(reader, tmp_path, monkeypatch, embedded):
    content = "雪雪"
    save(tmp_path, markdown_content=content, body=None if embedded else content.encode())
    monkeypatch.setattr(reader, "MAX_MARKDOWN_BYTES", len(content.encode()))
    assert reader.read_saved_report(tmp_path, "report_one")["content_available"] is True
    monkeypatch.setattr(reader, "MAX_MARKDOWN_BYTES", len(content.encode()) - 1)
    result = reader.read_saved_report(tmp_path, "report_one")
    assert result["content_error"] == "too_large" and result["content_available"] is False
    assert result["title"] == "Saved title"


def test_unreadable_and_malformed_metadata_bytes_still_count_against_scan_budget(reader, tmp_path, monkeypatch):
    (tmp_path / "report_bad.json").write_bytes(b"{" * 40)
    save(tmp_path, "report_good")
    monkeypatch.setattr(reader, "MAX_TOTAL_METADATA_BYTES", 40)
    error(reader, "catalogue_too_large", 413, lambda: reader.list_saved_reports(tmp_path, status="failed"))


@pytest.mark.parametrize("kind", ["symlink", "fifo", "directory", "reparse"])
def test_metadata_aliases_and_nonregular_files_are_rejected_without_opening(reader, tmp_path, monkeypatch, kind):
    path = save(tmp_path)
    path.unlink()
    if kind == "symlink":
        external = tmp_path / "PRIVATE.target"; external.write_text(json.dumps(metadata())); path.symlink_to(external)
    elif kind == "fifo": os.mkfifo(path)
    elif kind == "directory": path.mkdir()
    else:
        path.write_text(json.dumps(metadata()))
        original = reader.os.lstat
        def reparse(filename, *args, **kwargs):
            value = original(filename, *args, **kwargs)
            if str(filename) != str(path): return value
            class ReparseStat:
                st_file_attributes = 0x400
                def __getattr__(self, name): return getattr(value, name)
            return ReparseStat()
        monkeypatch.setattr(reader.os, "lstat", reparse)
    monkeypatch.setattr(reader, "_open_source", lambda *args: pytest.fail("Unsafe metadata was opened"))
    result = reader.list_saved_reports(tmp_path)
    assert result["unavailable_reasons"] == [{"code": "unsafe_path", "count": 1}]
    error(reader, "metadata_unavailable", 422, lambda: reader.read_saved_report(tmp_path, "report_one"))


def test_new_modern_namespace_invalidates_legacy_selection_even_when_both_metadata_match(reader, tmp_path):
    save(tmp_path, legacy=True)
    row = reader.list_saved_reports(tmp_path)["reports"][0]
    save(tmp_path)
    error(reader, "sources_changed", 409, lambda: reader.read_saved_report(tmp_path, "report_one", revision=row["metadata_revision"]))
    assert reader.list_saved_reports(tmp_path)["returned_count"] == 1


def test_log_updates_do_not_invalidate_metadata_or_catalogue_revisions(reader, tmp_path):
    path = save(tmp_path)
    first = reader.list_saved_reports(tmp_path)
    row = first["reports"][0]
    (path.parent / "agent_log.jsonl").write_text("unrelated log")
    (path.parent / "full_report.md").write_bytes(b"New saved body")
    assert reader.list_saved_reports(tmp_path, revision=first["source_revision"])["source_revision"] == first["source_revision"]
    assert reader.read_saved_report(tmp_path, "report_one", revision=row["metadata_revision"])["markdown_content"] == "New saved body"


def test_selected_body_changed_while_reading_is_conflict(reader, tmp_path, monkeypatch):
    path = save(tmp_path, body=b"Before").parent / "full_report.md"
    original = reader._open_source
    class ChangingStream:
        def __init__(self, stream): self.stream = stream
        def __enter__(self): return self
        def __exit__(self, *args): self.stream.close()
        def fileno(self): return self.stream.fileno()
        def read(self, maximum):
            data = self.stream.read(maximum)
            path.write_bytes(b"After")
            return data
    monkeypatch.setattr(reader, "_open_source", lambda filename: ChangingStream(original(filename)) if str(filename) == str(path) else original(filename))
    error(reader, "sources_changed", 409, lambda: reader.read_saved_report(tmp_path, "report_one"))


@pytest.mark.parametrize("field", ["simulation_id", "status", "created_at", "completed_at", "simulation_requirement", "title", "summary"])
def test_non_utf8_metadata_is_skipped_without_breaking_unicode_flask_response(reader, tmp_path, field):
    from flask import Flask
    data = metadata("report_bad")
    if field in {"title", "summary"}:
        data["outline"][field] = "bad\ud800"
    else:
        data[field] = "bad\ud800"
    (tmp_path / "report_bad.json").write_text(json.dumps(data), encoding="utf-8")
    save(tmp_path, "report_good")
    result = reader.list_saved_reports(tmp_path)
    assert [row["report_id"] for row in result["reports"]] == ["report_good"]
    assert result["unavailable_reasons"] == [{"code": "metadata_unreadable", "count": 1}]
    app = Flask(__name__)
    app.json.ensure_ascii = False
    with app.app_context():
        response = app.json.response({"success": True, "data": result})
        assert response.status_code == 200
        assert response.json["data"]["reports"][0]["report_id"] == "report_good"
    error(reader, "metadata_unavailable", 422, lambda: reader.read_saved_report(tmp_path, "report_bad"))


def test_large_valid_unicode_content_is_bounded_by_utf8_response_bytes(reader, tmp_path):
    body = ("🐟" * 1_500_000).encode("utf-8")
    save(tmp_path, body=body)
    result = reader.read_saved_report(tmp_path, "report_one")
    assert result["content_bytes"] == 6_000_000
    assert result["markdown_content"].encode("utf-8") == body
    serialized = json.dumps({"success": True, "data": result}, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
    assert len(serialized) < reader.MAX_DETAIL_RESPONSE_BYTES


@pytest.mark.parametrize("detail", [False, True])
def test_response_cap_measures_exact_compact_utf8_envelope_including_newline(reader, tmp_path, monkeypatch, detail):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    fixed = datetime(2026, 1, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(reader, "datetime", SimpleNamespace(now=lambda tz: fixed))
    save(tmp_path, outline={"title": "雪🐟" * 100, "summary": "Control\x00 and newline\n"}, body="雪🐟\x00\r\n".encode())
    operation = (lambda: reader.read_saved_report(tmp_path, "report_one")) if detail else (lambda: reader.list_saved_reports(tmp_path))
    result = operation()
    wire_bytes = len(json.dumps({"success": True, "data": result}, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")) + 1
    cap = "MAX_DETAIL_RESPONSE_BYTES" if detail else "MAX_LIST_RESPONSE_BYTES"
    monkeypatch.setattr(reader, cap, wire_bytes)
    assert operation() == result
    monkeypatch.setattr(reader, cap, wire_bytes - 1)
    error(reader, "response_too_large", 413, operation)
