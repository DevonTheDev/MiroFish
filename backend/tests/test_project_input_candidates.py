"""Bounded metadata discovery; execute only in the released isolated fixture gate.

Use real temporary storage. Controlled iterator/open/read seams model ordinary
races and expose bounded work without loading the application or providers.
"""

import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from project_input_recipe_support import Fixture, PREFIX, _load, encoded

candidates = _load(PREFIX + ".services.project_input_candidates", "services/project_input_candidates.py")
REASONS = {"unsafe", "missing", "too_large", "invalid", "changed", "unreadable"}
LIMITS = {"entries": 256, "rows": 50, "metadata_file_bytes": 1048576, "metadata_total_bytes": 8388608}
ROW_KEYS = {"project_id", "name", "name_truncated", "status", "created_at", "updated_at",
            "scenario_excerpt", "scenario_truncated"}


class Scan:
    """A finite controlled scandir stream; only basenames reach production."""
    def __init__(self, names, *, failure=None, after=None):
        self.names = iter(names)
        self.yields = 0
        self.calls = 0
        self.closed = False
        self.failure = failure
        self.after = after

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def __next__(self):
        self.calls += 1
        try:
            name = next(self.names)
        except StopIteration:
            if self.after:
                self.after()
            if self.failure:
                raise self.failure
            raise
        self.yields += 1
        return SimpleNamespace(name=name)


class CandidateReaderTests(Fixture):
    def observe(self, root=None):
        payload = candidates.read_project_input_candidates(str(self.projects if root is None else root))
        self.assertIs(type(payload), bytes)
        self.assertLessEqual(len(payload), 256 * 1024)
        envelope = json.loads(payload.decode("utf-8", errors="strict"))
        self.assertEqual(set(envelope), {"success", "data"})
        self.assertIs(envelope["success"], True)
        data = envelope["data"]
        self.assertEqual(set(data), {"items", "examined_entries", "returned", "metadata_bytes_budgeted",
                                    "budget_deferred", "skipped", "stop_reason", "directory_changed",
                                    "partial", "limits"})
        self.assertEqual(data["limits"], LIMITS)
        self.assertEqual(set(data["skipped"]), REASONS)
        self.assertEqual(data["returned"], len(data["items"]))
        self.assertEqual(data["examined_entries"], data["returned"] + sum(data["skipped"].values()) + data["budget_deferred"])
        self.assertLessEqual(data["examined_entries"], 256)
        self.assertLessEqual(data["returned"], 50)
        self.assertLessEqual(data["metadata_bytes_budgeted"], 8388608)
        self.assertEqual(data["partial"], data["stop_reason"] != "end" or bool(sum(data["skipped"].values()))
                         or bool(data["budget_deferred"]) or data["directory_changed"])
        self.assertEqual([row["project_id"] for row in data["items"]], sorted(row["project_id"] for row in data["items"]))
        for row in data["items"]:
            self.assertEqual(set(row), ROW_KEYS)
        return data

    def error(self, reason, root=None):
        with self.assertRaises(candidates.InputCandidatesError) as caught:
            self.observe(root)
        self.assertEqual(caught.exception.code, "saved_input_candidates_" + reason)
        self.assertNotIn(str(self.root), str(caught.exception))
        return caught.exception

    def add(self, identifier, *, size=None, **fields):
        directory = self.projects / identifier
        directory.mkdir()
        value = dict(self.metadata, project_id=identifier, **fields)
        payload = encoded(value)
        if size is not None:
            self.assertGreaterEqual(size, len(payload))
            payload += b" " * (size - len(payload))
        (directory / "project.json").write_bytes(payload)
        return directory

    def test_failed_pre_simulation_metadata_is_listed_without_source_or_project_loading(self):
        self.source_path.unlink()
        before = self.metadata_path.read_bytes()
        data = self.observe()
        self.assertEqual(data["items"][0]["project_id"], self.project_id)
        self.assertEqual(data["items"][0]["status"], "failed")
        self.assertFalse(data["partial"])
        self.assertEqual(data["metadata_bytes_budgeted"], len(before) + 1)
        self.assertEqual(self.metadata_path.read_bytes(), before)
        self.assertFalse(self.source_path.exists())
        for private in ("PRIVATE_FAILURE_DETAIL", "PRIVATE_GRAPH_ID", "PRIVATE_ORIGINAL_PATH", "ontology", "total_text_length"):
            self.assertNotIn(private, json.dumps(data))

    def test_absent_root_is_empty_and_never_created(self):
        absent = self.root / "absent"
        data = self.observe(absent)
        self.assertEqual(data["items"], [])
        self.assertEqual(data["stop_reason"], "end")
        self.assertEqual(data["examined_entries"], 0)
        self.assertFalse(data["partial"])
        self.assertFalse(absent.exists())

    def test_root_file_and_denied_iteration_are_whole_request_errors(self):
        self.error("unreadable", self.source_path)
        with patch.object(candidates.os, "scandir", side_effect=PermissionError("PRIVATE root")):
            self.error("unreadable")

    def test_iterator_failure_discards_already_built_rows_and_closes_iterator(self):
        scan = Scan([self.project_id], failure=OSError("PRIVATE iteration"))
        with patch.object(candidates.os, "scandir", return_value=scan):
            self.error("unreadable")
        self.assertTrue(scan.closed)

    def test_entry_limit_counts_unsuitable_entries_without_lookahead(self):
        for count in (256, 257):
            with self.subTest(count=count):
                scan = Scan(["invalid.name"] * count)
                with patch.object(candidates.os, "scandir", return_value=scan):
                    data = self.observe()
                self.assertEqual(data["stop_reason"], "entry_limit")
                self.assertEqual(data["skipped"]["unsafe"], 256)
                self.assertEqual(data["metadata_bytes_budgeted"], 0)
                self.assertEqual(scan.calls, 256)
                self.assertTrue(scan.closed)

    def test_actual_end_below_entry_limit_is_observed_even_when_partial(self):
        scan = Scan(["invalid.name"] * 255)
        with patch.object(candidates.os, "scandir", return_value=scan):
            data = self.observe()
        self.assertEqual(data["stop_reason"], "end")
        self.assertEqual(scan.calls, 256)
        self.assertTrue(data["partial"])

    def test_row_limit_bounds_encounter_subset_then_sorts_only_rows(self):
        names = [f"proj_{number:03d}" for number in range(51)]
        for name in names:
            self.add(name)
        for count in (50, 51):
            with self.subTest(count=count):
                scan = Scan(list(reversed(names))[:count])
                with patch.object(candidates.os, "scandir", return_value=scan):
                    data = self.observe()
                self.assertEqual(data["stop_reason"], "row_limit")
                self.assertEqual(data["returned"], 50)
                self.assertEqual(scan.calls, 50)
                self.assertEqual([row["project_id"] for row in data["items"]], names[1:])

    def test_duplicate_yield_is_changed_and_never_read_twice(self):
        scan = Scan([self.project_id, self.project_id])
        original = os.read
        with patch.object(candidates.os, "scandir", return_value=scan), patch.object(candidates.os, "read", wraps=original) as read:
            data = self.observe()
        self.assertEqual(data["returned"], 1)
        self.assertEqual(data["skipped"]["changed"], 1)
        self.assertEqual(read.call_count, 1)

    def test_exact_and_over_metadata_limit(self):
        exact = self.add("proj_exact", size=1048576)
        self.add("proj_over", size=1048577)
        scan = Scan(["proj_over", "proj_exact"])
        with patch.object(candidates.os, "scandir", return_value=scan):
            data = self.observe()
        self.assertEqual(data["skipped"]["too_large"], 1)
        self.assertEqual(data["metadata_bytes_budgeted"], 1048577)
        self.assertEqual([row["project_id"] for row in data["items"]], [exact.name])

    def test_aggregate_limit_reserves_extra_byte_and_defers_without_prefix_read(self):
        names = [f"proj_large_{number}" for number in range(8)]
        for name in names:
            self.add(name, size=1048576)
        original = os.read
        scan = Scan(names)
        with patch.object(candidates.os, "scandir", return_value=scan), patch.object(candidates.os, "read", wraps=original) as read:
            data = self.observe()
        self.assertEqual(data["stop_reason"], "byte_limit")
        self.assertEqual(data["returned"], 7)
        self.assertEqual(data["metadata_bytes_budgeted"], 7 * 1048577)
        self.assertEqual(data["budget_deferred"], 1)
        self.assertEqual(sum(data["skipped"].values()), 0)
        self.assertEqual(read.call_count, 7)
        self.assertEqual(scan.calls, 8)

    def test_exact_aggregate_charge_stops_without_requesting_ninth_entry(self):
        names = [f"proj_fit_{number}" for number in range(8)]
        for name in names:
            self.add(name, size=1048575)
        scan = Scan(names + [self.project_id])
        with patch.object(candidates.os, "scandir", return_value=scan):
            data = self.observe()
        self.assertEqual(data["metadata_bytes_budgeted"], 8388608)
        self.assertEqual(data["returned"], 8)
        self.assertEqual(data["budget_deferred"], 0)
        self.assertEqual(data["stop_reason"], "byte_limit")
        self.assertEqual(scan.calls, 8)

    def test_failed_open_is_charged_and_not_retried_or_refunded(self):
        names = [f"proj_denied_{number}" for number in range(8)]
        for name in names:
            self.add(name, size=1048575)
        scan = Scan(names)
        with patch.object(candidates.os, "scandir", return_value=scan), patch.object(candidates.os, "open", side_effect=PermissionError("PRIVATE denied")) as opened:
            data = self.observe()
        self.assertEqual(data["skipped"]["unreadable"], 8)
        self.assertEqual(data["metadata_bytes_budgeted"], 8388608)
        self.assertEqual(opened.call_count, 8)
        self.assertEqual(data["stop_reason"], "byte_limit")

    def test_growth_after_open_uses_one_raw_reserved_read_and_closes_descriptor(self):
        initial_size = self.metadata_path.stat().st_size
        original_read = os.read
        observed = []
        descriptors = []

        def grow_then_read(descriptor, allowance):
            descriptors.append(descriptor)
            with self.metadata_path.open("ab", buffering=0) as stream:
                stream.write(b" " * 16384)
            payload = original_read(descriptor, allowance)
            observed.append((allowance, len(payload)))
            return payload

        with patch.object(candidates.os, "read", side_effect=grow_then_read), patch.object(candidates.os, "fdopen", side_effect=AssertionError("buffered wrapper forbidden")):
            data = self.observe()
        self.assertEqual(observed, [(initial_size + 1, initial_size + 1)])
        self.assertEqual(data["metadata_bytes_budgeted"], initial_size + 1)
        self.assertEqual(data["skipped"]["changed"], 1)
        with self.assertRaises(OSError):
            os.fstat(descriptors[0])

    def test_opened_descriptor_mismatch_skips_before_read(self):
        original_open = os.open
        other = self.root / "replacement.json"
        other.write_bytes(self.metadata_path.read_bytes())

        def replace_then_open(path, flags):
            os.replace(other, self.metadata_path)
            return original_open(path, flags)

        with patch.object(candidates.os, "open", side_effect=replace_then_open), patch.object(candidates.os, "read", side_effect=AssertionError("changed file read")):
            data = self.observe()
        self.assertEqual(data["skipped"]["changed"], 1)

    def test_symlink_replacement_before_open_is_rejected_without_following_target(self):
        if not hasattr(os, "O_NOFOLLOW"):
            self.skipTest("no-follow open unavailable on this platform")
        original_open = os.open
        target = self.root / "outside.json"
        target.write_bytes(self.metadata_path.read_bytes())
        probe = self.root / "symlink_probe"
        self.make_symlink(probe, target)
        probe.unlink()
        def replace(path, flags):
            self.metadata_path.unlink()
            self.metadata_path.symlink_to(target)
            self.assertTrue(flags & os.O_NOFOLLOW)
            return original_open(path, flags)
        with patch.object(candidates.os, "open", side_effect=replace), patch.object(candidates.os, "read", side_effect=AssertionError("symlink target read")):
            data = self.observe()
        self.assertEqual(data["skipped"]["changed"], 1)

    def test_same_length_in_place_edit_after_read_is_changed(self):
        original_read = os.read
        original = self.metadata_path.read_bytes()
        def edit(descriptor, size):
            payload = original_read(descriptor, size)
            edited = original.replace(b"failed", b"edited", 1)
            self.assertEqual(len(edited), len(original))
            self.metadata_path.write_bytes(edited)
            return payload
        with patch.object(candidates.os, "read", side_effect=edit):
            data = self.observe()
        self.assertEqual(data["skipped"]["changed"], 1)

    def test_directory_change_after_summary_is_checked_before_row_publication(self):
        original = candidates._summary
        def change(payload, identifier):
            row = original(payload, identifier)
            (self.directory / "new_file").write_text("changed membership")
            return row
        with patch.object(candidates, "_summary", side_effect=change):
            data = self.observe()
        self.assertEqual(data["returned"], 0)
        self.assertEqual(data["skipped"]["changed"], 1)

    def test_short_raw_read_is_changed_without_retry(self):
        original_read = os.read
        with patch.object(candidates.os, "read", side_effect=lambda fd, size: original_read(fd, size - 2)) as read:
            data = self.observe()
        self.assertEqual(data["skipped"]["changed"], 1)
        self.assertEqual(read.call_count, 1)

    def test_atomic_replacement_and_disappearance_after_read_are_changed(self):
        original_read = os.read
        before = self.metadata_path.read_bytes()
        for action in ("replace", "remove"):
            with self.subTest(action=action):
                self.metadata_path.write_bytes(before)
                def alter(descriptor, size):
                    payload = original_read(descriptor, size)
                    if action == "replace":
                        other = self.directory / "replacement.json"
                        other.write_bytes(before)
                        os.replace(other, self.metadata_path)
                    else:
                        self.metadata_path.unlink()
                    return payload
                with patch.object(candidates.os, "read", side_effect=alter):
                    data = self.observe()
                self.assertEqual(data["skipped"]["changed"], 1)

    def test_stable_read_error_is_unreadable_and_descriptor_is_closed(self):
        descriptors = []
        def deny(descriptor, size):
            descriptors.append(descriptor)
            raise OSError("PRIVATE I/O failure")
        with patch.object(candidates.os, "read", side_effect=deny):
            data = self.observe()
        self.assertEqual(data["skipped"]["unreadable"], 1)
        with self.assertRaises(OSError):
            os.fstat(descriptors[0])

    def test_metadata_and_directory_symlinks_are_skipped_but_root_alias_is_allowed(self):
        alias = self.root / "root_alias"
        self.make_symlink(alias, self.projects, directory=True)
        self.assertEqual(self.observe(alias)["returned"], 1)
        self.make_symlink(self.projects / "proj_alias", self.directory, directory=True)
        other = self.add("proj_metadata_alias")
        (other / "project.json").unlink()
        self.make_symlink(other / "project.json", self.metadata_path)
        data = self.observe()
        self.assertEqual(data["returned"], 1)
        self.assertEqual(data["skipped"]["unsafe"], 2)

    def test_hardlinked_nonregular_missing_and_invalid_names_count_without_recursion(self):
        self.add("proj_missing")
        (self.projects / "proj_missing/project.json").unlink()
        hard = self.add("proj_hard") / "project.json"
        hard.unlink()
        os.link(self.metadata_path, hard)
        directory = self.add("proj_directory") / "project.json"
        directory.unlink()
        directory.mkdir()
        (self.projects / "plain_file").write_text("irrelevant")
        (self.projects / "bad.name").mkdir()
        data = self.observe()
        self.assertEqual(data["returned"], 0)
        self.assertEqual(data["skipped"]["missing"], 1)
        self.assertEqual(data["skipped"]["unsafe"], 5)
        self.assertEqual(data["metadata_bytes_budgeted"], 0)

    def test_fifo_replacement_is_opened_nonblocking_and_rejected_without_read(self):
        if not hasattr(os, "mkfifo") or not hasattr(os, "O_NONBLOCK"):
            self.skipTest("FIFO/nonblocking open unavailable on this platform")
        original_open = os.open
        flags_seen = []
        def replace(path, flags):
            flags_seen.append(flags)
            self.metadata_path.unlink()
            os.mkfifo(self.metadata_path)
            self.assertTrue(flags & os.O_NONBLOCK)
            if hasattr(os, "O_NOFOLLOW"):
                self.assertTrue(flags & os.O_NOFOLLOW)
            return original_open(path, flags)
        with patch.object(candidates.os, "open", side_effect=replace), patch.object(candidates.os, "read", side_effect=AssertionError("FIFO read")):
            data = self.observe()
        self.assertEqual(len(flags_seen), 1)
        self.assertEqual(data["skipped"]["changed"], 1)

    def test_root_identity_replacement_discards_rows(self):
        def replace_root():
            self.projects.rename(self.root / "old_projects")
            self.projects.mkdir()
        scan = Scan([self.project_id], after=replace_root)
        with patch.object(candidates.os, "scandir", return_value=scan):
            error = self.error("changed")
        self.assertEqual(error.status, 409)

    def test_root_disappearance_discards_rows(self):
        scan = Scan([self.project_id], after=lambda: self.projects.rename(self.root / "gone"))
        with patch.object(candidates.os, "scandir", return_value=scan):
            self.error("changed")

    def test_root_alias_target_change_discards_rows(self):
        alias = self.root / "root_alias"
        self.make_symlink(alias, self.projects, directory=True)
        replacement = self.root / "other_root"
        replacement.mkdir()
        def retarget():
            alias.unlink()
            alias.symlink_to(replacement, target_is_directory=True)
        scan = Scan([self.project_id], after=retarget)
        with patch.object(candidates.os, "scandir", return_value=scan):
            self.error("changed", alias)

    def test_root_membership_change_keeps_individual_row_and_discloses_partial(self):
        scan = Scan([self.project_id], after=lambda: (self.projects / "new_member").write_text("new"))
        with patch.object(candidates.os, "scandir", return_value=scan):
            data = self.observe()
        self.assertEqual(data["returned"], 1)
        self.assertTrue(data["directory_changed"])
        self.assertTrue(data["partial"])
        self.assertEqual(data["stop_reason"], "end")

    def test_invalid_json_unicode_structure_ids_and_depth_are_isolated(self):
        invalid = [b"{", b"\xff", b"[]", b'null', b'{"project_id":"wrong"}',
                   b'{"project_id":"proj_bad","number":NaN}',
                   b'{"project_id":"proj_bad","number":Infinity}',
                   b'{"project_id":"proj_bad","nested":' + b'[' * 2000 + b'0' + b']' * 2000 + b'}']
        for payload in invalid:
            with self.subTest(payload=payload[:70]):
                bad = self.projects / "proj_bad"
                bad.mkdir(exist_ok=True)
                (bad / "project.json").write_bytes(payload)
                data = self.observe()
                self.assertEqual(data["returned"], 1)
                self.assertEqual(data["skipped"]["invalid"], 1)

    def test_unknown_or_nonstring_status_is_unknown_and_duplicate_json_keys_use_last(self):
        for value in ("PRIVATE_NEW_STATUS", None, ["failed"], {"failed": True}, 2):
            with self.subTest(value=value):
                self.metadata["status"] = value
                self.write_metadata()
                self.assertEqual(self.observe()["items"][0]["status"], "unknown")
        self.metadata_path.write_bytes(b'{"project_id":"wrong","project_id":"' + self.project_id.encode() + b'","status":"failed"}')
        self.assertEqual(self.observe()["items"][0]["status"], "failed")

    def test_known_statuses_remain_literal_metadata_without_model_construction(self):
        for status in ("created", "ontology_generated", "graph_building", "graph_stopped", "graph_completed", "failed"):
            with self.subTest(status=status):
                self.metadata["status"] = status
                self.write_metadata()
                self.assertEqual(self.observe()["items"][0]["status"], status)

    def test_display_normalizes_controls_bidi_whitespace_and_clips_scalar_boundaries(self):
        self.metadata.update(name="\x00 A\n\u202e B\u2066\u2029 C\t", simulation_requirement="😀" * 241)
        self.write_metadata()
        row = self.observe()["items"][0]
        self.assertEqual(row["name"], "A B C")
        self.assertFalse(row["name_truncated"])
        self.assertEqual(row["scenario_excerpt"], "😀" * 240)
        self.assertTrue(row["scenario_truncated"])
        self.metadata["name"] = "雪" * 121
        self.write_metadata()
        row = self.observe()["items"][0]
        self.assertEqual(row["name"], "雪" * 120)
        self.assertTrue(row["name_truncated"])
        self.assertLessEqual(len(row["name"].encode()), 512)
        self.assertLessEqual(len(row["scenario_excerpt"].encode()), 1024)

    def test_absent_wrong_type_blank_and_invalid_scalar_display_fields_are_null(self):
        for value in (None, [], {}, 7, "\t\n \u2028\u202e", "visible\ud800", "x" * 500 + "\udfff"):
            with self.subTest(value=repr(value)):
                self.metadata.update(name=value, simulation_requirement=value)
                self.write_metadata()
                row = self.observe()["items"][0]
                self.assertIsNone(row["name"])
                self.assertIsNone(row["scenario_excerpt"])
                self.assertFalse(row["name_truncated"])
                self.assertFalse(row["scenario_truncated"])

    def test_valid_dates_preserve_spelling_and_invalid_dates_are_null(self):
        valid = ["2026-10-17T01:02:03", "2024-02-29T23:59:59.123456Z", "2026-10-17T01:02:03.1+05:30", "2026-10-17T01:02:03-00:00"]
        invalid = ["2026-02-29T01:02:03", "2026-10-17", "2026-10-17 01:02:03", "2026-10-17T24:00:00", "2026-10-17T01:02:60", "2026-10-17T01:02:03+00:60", "2026-10-17T01:02:03+24:00", "2026-10-17T01:02:03.1234567Z", "２０２６-10-17T01:02:03Z", [], None, "x" * 41]
        for value in valid + invalid:
            with self.subTest(value=value):
                self.metadata.update(created_at=value, updated_at=value)
                self.write_metadata()
                row = self.observe()["items"][0]
                self.assertEqual(row["created_at"], value if value in valid else None)
                self.assertEqual(row["updated_at"], value if value in valid else None)

    def test_maximum_literal_escaped_unicode_rows_stay_under_response_cap(self):
        names = ["p" * 124 + f"{number:04d}" for number in range(50)]
        for name in names:
            self.add(name, name='"\\😀' * 100, simulation_requirement='"\\雪😀' * 100)
        scan = Scan(names)
        with patch.object(candidates.os, "scandir", return_value=scan):
            data = self.observe()
        self.assertEqual(data["returned"], 50)
        for row in data["items"]:
            self.assertTrue(row["name_truncated"])
            self.assertTrue(row["scenario_truncated"])

    def test_serialization_invariant_failure_is_sanitized(self):
        with patch.object(candidates.json, "dumps", side_effect=UnicodeError("PRIVATE serialization")):
            self.error("unreadable")
