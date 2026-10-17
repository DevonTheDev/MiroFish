"""Saved-input export contract against disposable files, without a live runtime."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
from unittest.mock import patch

from project_input_recipe_support import BLANK, Fixture, NAME, SCENARIO, SOURCE, encoded, recipe


class EligibilityTests(Fixture):
    def test_failed_ontology_exports_complete_inputs_and_only_seven_fields(self):
        before = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        payload = self.read()
        self.assertIs(type(payload), bytes)
        self.assertFalse(payload.startswith(b"\xef\xbb\xbf"))
        value = json.loads(payload)
        self.assertEqual(set(value), {"format", "version", "source_kind", "source_text",
                                     "simulation_requirement", "source_project_name", "captured_at"})
        self.assertEqual(value["format"], "mirofish-project-input-recipe")
        self.assertIs(type(value["version"]), int)
        self.assertEqual(value["version"], 1)
        self.assertEqual(value["source_kind"], "saved_extracted_text")
        self.assertEqual(value["source_text"].encode("utf-8"), self.source_path.read_bytes())
        self.assertEqual(value["simulation_requirement"], SCENARIO)
        self.assertEqual(value["source_project_name"], NAME)
        self.assertIn("雪".encode(), payload)
        self.assertNotIn(b"PRIVATE_", payload)
        self.assertEqual({p.name: p.read_bytes() for p in self.directory.iterdir()}, before)
        self.assertRegex(value["captured_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        parsed = datetime.fromisoformat(value["captured_at"].replace("Z", "+00:00"))
        self.assertEqual(parsed.tzinfo, timezone.utc)
        self.assertEqual(parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z"), value["captured_at"])

    def test_status_ontology_original_files_and_empty_name_are_not_eligibility(self):
        self.metadata.update(name="", status={"not": "a supported status"}, ontology="unusable", files=[])
        self.write_metadata()
        value = self.document()
        self.assertEqual(value["source_project_name"], "")
        self.assertEqual(value["source_text"], SOURCE)

    def test_initial_partial_and_legacy_records_are_not_verified(self):
        variants = [
            {"simulation_requirement": None, "total_text_length": 0},
            {"total_text_length": 0}, {"total_text_length": -1},
            {"simulation_requirement": None},
            {"total_text_length": len(SOURCE) + 1},
        ]
        original = dict(self.metadata)
        for fields in variants:
            with self.subTest(fields=fields):
                self.write_metadata({**original, **fields})
                self.assert_error("incomplete")
        for missing in ("total_text_length", "simulation_requirement"):
            with self.subTest(missing=missing):
                value = dict(original)
                value.pop(missing)
                self.write_metadata(value)
                self.assert_error("incomplete")

    def test_saved_length_uses_code_points_not_utf8_or_utf16(self):
        source = "😀雪e\u0301"
        self.write_source(source)
        self.assertEqual(self.document()["source_text"], source)
        for wrong_length in (len(source.encode("utf-8")), len(source.encode("utf-16-le")) // 2):
            with self.subTest(wrong_length=wrong_length):
                self.metadata["total_text_length"] = wrong_length
                self.write_metadata()
                self.assert_error("incomplete")

    def test_crlf_comparison_never_normalizes_exported_bytes(self):
        source = "line one\r\nline two\r\n"
        self.write_source(source)
        for length in (len(source), len(source.replace("\r\n", "\n"))):
            with self.subTest(length=length):
                self.metadata["total_text_length"] = length
                self.write_metadata()
                self.assertEqual(self.document()["source_text"].encode(), source.encode())
        self.write_source("a\rb")
        self.metadata["total_text_length"] = 2
        self.write_metadata()
        self.assert_error("incomplete")

    def test_shared_blank_set_rejects_source_and_scenario_without_trimming_content(self):
        original = dict(self.metadata)
        for field in ("source", "simulation_requirement"):
            for blank in ("", BLANK):
                with self.subTest(field=field, blank=bool(blank)):
                    self.metadata = dict(original)
                    self.source_path.write_bytes(SOURCE.encode())
                    if field == "source":
                        self.source_path.write_bytes(blank.encode())
                        self.metadata["total_text_length"] = max(1, len(blank))
                    else:
                        self.metadata[field] = blank
                    self.write_metadata()
                    self.assert_error("incomplete")
        self.metadata = dict(original)
        self.write_source(BLANK + "x" + BLANK)
        self.metadata["simulation_requirement"] = BLANK + "y" + BLANK
        self.write_metadata()
        value = self.document()
        self.assertEqual(value["source_text"], BLANK + "x" + BLANK)
        self.assertEqual(value["simulation_requirement"], BLANK + "y" + BLANK)


class ValidationTests(Fixture):
    def test_wrong_metadata_scalar_types_and_identity_are_invalid(self):
        cases = [("project_id", "proj_other"), ("project_id", 1), ("name", None),
                 ("name", []), ("simulation_requirement", True), ("simulation_requirement", {}),
                 ("total_text_length", True), ("total_text_length", "4"), ("total_text_length", 1.5),
                 ("total_text_length", None)]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.write_metadata({**self.metadata, field: value})
                self.assert_error("invalid")

    def test_missing_name_or_project_identity_is_invalid(self):
        for field in ("name", "project_id"):
            with self.subTest(field=field):
                value = dict(self.metadata)
                value.pop(field)
                self.write_metadata(value)
                self.assert_error("invalid")

    def test_malformed_metadata_json_utf8_bom_and_nonobject_roots(self):
        bodies = [b"{", b"\xff", b"\xef\xbb\xbf" + encoded(self.metadata),
                  b"null", b"[]", b"true", b'"scalar"', b"123",
                  encoded(self.metadata)[:-1] + b',"ignored":NaN}']
        for body in bodies:
            with self.subTest(body=body[:12]):
                self.metadata_path.write_bytes(body)
                self.assert_error("invalid")

    def test_nonstandard_json_numbers_and_lone_surrogates_are_invalid(self):
        for field, value in (("total_text_length", float("nan")), ("total_text_length", float("inf")),
                             ("name", "\ud800"), ("simulation_requirement", "\udfff")):
            with self.subTest(field=field, value=repr(value)):
                self.write_metadata({**self.metadata, field: value})
                self.assert_error("invalid")

    def test_source_utf8_is_fatal_and_embedded_bom_is_preserved(self):
        for body in (b"bad\xffutf8", b"\xed\xa0\x80", b"\xf0\x9f\x98"):
            with self.subTest(body=body):
                self.source_path.write_bytes(body)
                self.assert_error("invalid")
        self.write_source("\ufeffvalid 😀\ufeff")
        self.assertEqual(self.document()["source_text"], "\ufeffvalid 😀\ufeff")

    def test_native_json_last_value_wins_then_schema_validation(self):
        base = encoded(self.metadata)
        self.metadata_path.write_bytes(base[:-1] + b',"name":"last","name":"final"}')
        self.assertEqual(self.document()["source_project_name"], "final")
        self.metadata_path.write_bytes(base[:-1] + b',"total_text_length":true}')
        self.assert_error("invalid")


class LimitTests(Fixture):
    def test_metadata_byte_limit_accepts_exact_and_refuses_plus_one(self):
        body = encoded(self.metadata)
        at_limit = body + b" " * (1048576 - len(body))
        self.metadata_path.write_bytes(at_limit)
        self.assertEqual(self.document()["source_text"], SOURCE)
        self.metadata_path.write_bytes(at_limit + b" ")
        self.assert_error("too_large")

    def test_each_utf8_field_limit_accepts_exact_and_refuses_plus_one(self):
        for field, maximum in (("source", 1048576), ("simulation_requirement", 65536), ("name", 1024)):
            with self.subTest(field=field):
                self.metadata.update(name=NAME, simulation_requirement=SCENARIO)
                self.write_source(SOURCE)
                text = "é" * (maximum // 2)
                if field == "source":
                    self.write_source(text)
                else:
                    self.metadata[field] = text
                    self.write_metadata()
                value = self.document()
                recipe_field = {"source": "source_text", "name": "source_project_name"}.get(field, field)
                self.assertEqual(value[recipe_field], text)
                if field == "source":
                    self.write_source(text + "x")
                else:
                    self.metadata[field] = text + "x"
                    self.write_metadata()
                self.assert_error("too_large")

    def test_encoded_escape_expansion_refuses_whole_recipe(self):
        # Each NUL costs one source byte and six serialized JSON bytes.
        self.write_source("x" + "\x00" * 400000)
        self.assertLess(self.source_path.stat().st_size, 1048576)
        self.assert_error("too_large")

    def test_encoded_recipe_boundary_is_checked_after_serialization(self):
        # One initial export measures fixed overhead; canonical timestamps have
        # fixed width. No encoder constants or private formatting helpers reused.
        self.write_source("x")
        overhead = len(self.read()) - 1
        available = 2097152 - overhead
        controls, ascii_count = divmod(available, 6)
        text = "\x00" * controls + "x" * ascii_count
        if not ascii_count:
            text = "\x00" * (controls - 1) + "xxxxxx"
        self.write_source(text)
        self.assertLessEqual(len(text.encode()), 1048576)
        self.assertEqual(len(self.read()), 2097152)
        self.write_source(text + "x")
        self.assert_error("too_large")


class StorageTests(Fixture):
    def test_every_opened_file_read_has_a_limit_plus_one_bound(self):
        original_fdopen = recipe.os.fdopen
        reads = []

        class BoundedStream:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                self.stream.__enter__()
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def fileno(self):
                return self.stream.fileno()

            def read(self, count=-1):
                self_test.assertGreater(count, 0)
                self_test.assertLessEqual(count, 1048577)
                reads.append(count)
                return self.stream.read(count)

        self_test = self
        with patch.object(recipe.os, "fdopen", side_effect=lambda *a, **kw: BoundedStream(original_fdopen(*a, **kw))):
            self.assertEqual(self.document()["source_text"], SOURCE)
        self.assertEqual(len(reads), 3, "Capture reads metadata, source, and metadata again")

    def test_invalid_ids_fail_without_creating_missing_root(self):
        root = self.root / "absent"
        for identifier in ("../outside", "CON", "bad:name", "x" * 129, True):
            with self.subTest(identifier=identifier):
                self.assert_error("unsafe_path", call=lambda: self.read(root=root, project_id=identifier))
        self.assertFalse(root.exists())

    def test_initial_missing_record_metadata_or_source_returns_not_found(self):
        self.assert_error("not_found", call=lambda: self.read(project_id="proj_missing"))
        self.assertFalse((self.projects / "proj_missing").exists())
        self.metadata_path.unlink()
        self.assert_error("not_found")
        self.write_metadata()
        self.source_path.unlink()
        self.assert_error("not_found")

    def test_descendant_links_and_nonregular_files_are_rejected(self):
        for target in (self.metadata_path, self.source_path):
            original = target.read_bytes()
            external = self.root / (target.name + ".external")
            external.write_bytes(original)
            target.unlink()
            self.make_symlink(target, external)
            self.assert_error("unsafe_path")
            self.assertEqual(external.read_bytes(), original)
            target.unlink()
            target.mkdir()
            self.assert_error("unsafe_path")
            target.rmdir()
            target.write_bytes(original)

    def test_record_alias_is_refused_but_configured_root_may_be_relocated(self):
        alias = self.projects / "proj_alias"
        self.make_symlink(alias, self.directory, directory=True)
        self.assert_error("unsafe_path", call=lambda: self.read(project_id="proj_alias"))
        relocated = self.root / "relocated-projects"
        self.make_symlink(relocated, self.projects, directory=True)
        self.assertEqual(self.document(root=relocated)["source_text"], SOURCE)

    def test_hardlinked_source_is_refused_before_reading(self):
        try:
            os.link(self.source_path, self.root / "source-alias.txt")
        except (OSError, NotImplementedError):
            self.skipTest("hardlinks unavailable on this platform")
        with patch.object(recipe, "_read_bounded", side_effect=AssertionError("aliased file opened")):
            self.assert_error("unsafe_path")

    def test_fifo_is_rejected_before_opening(self):
        if not hasattr(os, "mkfifo"):
            self.skipTest("FIFO creation unavailable on this platform")
        self.source_path.unlink()
        os.mkfifo(self.source_path)
        with patch.object(recipe, "_read_bounded", side_effect=AssertionError("nonregular file opened")):
            self.assert_error("unsafe_path")

    def test_ordinary_changes_during_capture_are_conflicts(self):
        original_read = recipe._read_bounded
        changes = ("metadata_progress", "metadata_atomic_same_bytes", "source_rewrite",
                   "source_atomic_same_bytes", "metadata_delete", "source_delete", "directory_replace")
        for change in changes:
            with self.subTest(change=change):
                if self.directory.exists():
                    shutil.rmtree(self.directory)
                self.directory.mkdir()
                self.write_metadata()
                self.source_path.write_bytes(SOURCE.encode())
                triggered = False

                def read_and_change(path, expected_stat, limit):
                    nonlocal triggered
                    result = original_read(path, expected_stat, limit)
                    if Path(path) == self.source_path and not triggered:
                        triggered = True
                        if change == "metadata_progress":
                            self.write_metadata({**self.metadata, "progress": 1})
                        elif change in {"metadata_atomic_same_bytes", "source_atomic_same_bytes"}:
                            destination = self.metadata_path if change.startswith("metadata") else self.source_path
                            staged = self.root / "replacement.tmp"
                            staged.write_bytes(destination.read_bytes())
                            os.replace(staged, destination)
                        elif change == "source_rewrite":
                            self.source_path.write_bytes(b"x" * len(result))
                            now = self.source_path.stat()
                            os.utime(self.source_path, ns=(now.st_atime_ns, now.st_mtime_ns + 1000000000))
                        elif change == "metadata_delete":
                            self.metadata_path.unlink()
                        elif change == "source_delete":
                            self.source_path.unlink()
                        else:
                            moved = self.root / "old-directory"
                            self.directory.rename(moved)
                            shutil.copytree(moved, self.directory)
                    return result

                with patch.object(recipe, "_read_bounded", side_effect=read_and_change):
                    self.assert_error("changed")
                self.assertTrue(triggered)

    def test_unexpected_read_failure_is_sanitized(self):
        with patch.object(recipe, "_read_bounded", side_effect=PermissionError(str(self.root) + " PRIVATE_FAILURE_DETAIL")):
            self.assert_error("unreadable")

