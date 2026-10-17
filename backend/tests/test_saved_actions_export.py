"""Strict all-source export contract; execution requires the reviewed finite gate."""

from collections import Counter
from contextlib import ExitStack
import json
import os
from unittest.mock import patch

from saved_actions_export_support import Fixture, Query, action, encoded, event, export, pages, rounds, saved


class QueryAdmissionTests(Fixture):
    def test_exactly_one_lowercase_revision(self):
        revision = self.revision()
        self.assertEqual(export.parse_saved_actions_export_query(Query([("revision", revision)])), {"revision": revision})

    def test_missing_duplicate_or_invalid_revision(self):
        variants = [[], [("revision", "")], [("revision", "a" * 63)], [("revision", "A" * 64)],
                    [("revision", "g" * 64)], [("revision", "a" * 65)],
                    [("revision", "a" * 64), ("revision", "a" * 64)]]
        for pairs in variants:
            with self.subTest(query=pairs):
                self.assert_error("invalid_revision", 400, call=lambda: export.parse_saved_actions_export_query(Query(pairs)))

    def test_filters_pagination_and_unknown_parameters_are_rejected(self):
        for key in ("platform", "agent_id", "round_num", "action_type", "q", "outcome", "case_sensitive", "offset", "limit", "unknown"):
            with self.subTest(key=key):
                args = Query([("revision", "a" * 64), (key, "x")])
                self.assert_error("invalid_filters", 400, call=lambda: export.parse_saved_actions_export_query(args))

    def test_invalid_revision_precedes_storage(self):
        with patch.object(saved, "_paths", side_effect=AssertionError("storage inspected")):
            for value in (None, "", "x", "A" * 64, 1, True):
                with self.subTest(value=value):
                    self.assert_error("invalid_revision", 400, call=lambda: export.read_saved_actions_export(
                        str(self.sim_root), str(self.run_root), self.simulation_id, revision=value))


class MetadataAndCoverageTests(Fixture):
    def test_envelope_is_complete_distinct_and_private(self):
        payload = self.read()
        document = json.loads(payload)
        self.assertEqual(payload, (pages._json(document) + "\n").encode("ascii"))
        expected = {"format", "version", "simulation_id", "source_revision", "observed_at", "context",
                    "availability", "sources", "platform_coverage", "warnings", "order", "scope", "truncated", "record_count", "actions"}
        self.assertEqual(set(document), expected)
        self.assertEqual(document["format"], "mirofish-saved-actions")
        self.assertEqual(document["version"], 1)
        self.assertEqual(document["simulation_id"], self.simulation_id)
        self.assertEqual(document["source_revision"], self.revision())
        self.assertEqual(document["availability"], "complete")
        self.assertEqual(document["scope"], "all_saved_actions")
        self.assertEqual(document["order"], "source_record")
        self.assertIs(document["truncated"], False)
        self.assertEqual(document["record_count"], len(document["actions"]))
        self.assertEqual(document["sources"], ["twitter"])
        self.assertEqual(document["context"]["requested_rounds"], "5")
        self.assertEqual(document["context"]["last_saved_round"], "2")
        self.assertEqual(document["platform_coverage"]["twitter"], {
            "enabled": True, "availability": "complete", "source": "twitter", "recorded_actions": 1})
        self.assertEqual(document["platform_coverage"]["reddit"], {
            "enabled": False, "availability": "unavailable", "source": None, "recorded_actions": None})
        for forbidden in (str(self.root), "PRIVATE_CONFIG_MARKER", "NEVER_EXPORT_CONFIG", "match_preview"):
            self.assertNotIn(forbidden.encode(), payload)

    def test_missing_state(self):
        self.path("state").unlink()
        self.assert_error("simulation_not_found", 404)

    def test_unreadable_invalid_oversized_and_mismatched_state(self):
        for body in (b"invalid", b"[]", b"\xff", encoded({"simulation_id": "other"}), b" " * (saved.MAX_STATE_BYTES + 1)):
            with self.subTest(body_length=len(body)):
                self.write_bytes("state", body)
                self.assert_error("simulation_unreadable", 404)
        self.write_metadata()
        original = saved._open_source
        def unreadable(path):
            if path == str(self.path("state")):
                raise PermissionError("private path")
            return original(path)
        with patch.object(saved, "_open_source", side_effect=unreadable):
            self.assert_error("simulation_unreadable", 404)

    def test_run_status_precedence_and_missing_identity(self):
        self.state["status"] = "running"
        self.run.pop("simulation_id")
        self.write_metadata()
        document = self.document()
        self.assertEqual(document["context"]["status"], "completed")
        self.assertNotIn("run_state_unavailable", self.warnings(document))
        self.state["status"] = "completed"
        self.run["runner_status"] = "running"
        self.write_metadata()
        self.assert_error("simulation_active", 409)

    def test_run_fallback_retains_warning(self):
        for body in (None, b"invalid", b"[]", encoded({"runner_status": "mystery"}),
                     encoded({"runner_status": "completed", "simulation_id": "other"}),
                     b" " * (saved.MAX_STATE_BYTES + 1)):
            with self.subTest(body_length=None if body is None else len(body)):
                if body is None:
                    self.path("run").unlink(missing_ok=True)
                else:
                    self.write_bytes("run", body)
                document = self.document()
                self.assertEqual(document["context"]["status"], "completed")
                self.assertIn("run_state_unavailable", self.warnings(document))

    def test_unreadable_run_and_config_fallback(self):
        original = saved._open_source
        def unreadable(path):
            if path in {str(self.path("run")), str(self.path("config"))}:
                raise PermissionError("private path")
            return original(path)
        with patch.object(saved, "_open_source", side_effect=unreadable):
            self.assertEqual(self.warnings(self.document()), {"run_state_unavailable", "config_unavailable"})

    def test_active_and_nonterminal_statuses_do_not_read_logs(self):
        for status in ("starting", "running", "paused", "stopping", "idle", "created", "preparing", "ready", "unknown"):
            with self.subTest(status=status):
                self.path("run").unlink(missing_ok=True)
                self.state["status"] = status
                self.write_bytes("state", encoded(self.state))
                with patch.object(export, "_read_log", side_effect=AssertionError("log read")):
                    self.assert_error("simulation_active" if status in saved._ACTIVE else "run_not_terminal", 409)

    def test_terminal_statuses_and_partial_run_warning(self):
        for status in ("completed", "stopped", "failed"):
            with self.subTest(status=status):
                self.run["runner_status"] = status
                self.write_metadata()
                document = self.document()
                self.assertEqual(document["context"]["status"], status)
                self.assertEqual("partial_run" in self.warnings(document), status != "completed")

    def test_config_missing_invalid_or_oversized_is_nonblocking(self):
        for body in (None, b"invalid", b"[]", b" " * (saved.MAX_CONFIG_BYTES + 1)):
            with self.subTest(body_length=None if body is None else len(body)):
                if body is None:
                    self.path("config").unlink(missing_ok=True)
                else:
                    self.write_bytes("config", body)
                self.assertIn("config_unavailable", self.warnings(self.document()))

    def test_no_log_is_not_empty_success(self):
        self.path("twitter").unlink()
        self.assert_error("export_incomplete", 422, reason="no_action_logs")

    def test_empty_blank_and_event_only_modern_logs_are_complete(self):
        for rows in ([], [b"\n", b" \t\n"], [event(), event(event_type="simulation_end")]):
            with self.subTest(rows=rows):
                self.write_log("twitter", rows)
                document = self.document()
                self.assertEqual(document["actions"], [])
                self.assertEqual(document["record_count"], 0)
                self.assertEqual(document["platform_coverage"]["twitter"]["availability"], "complete")

    def test_only_literal_false_allows_missing_modern_platform(self):
        for enabled in (True, None, 0, 1, "false", [], {}):
            with self.subTest(enabled=enabled):
                self.state["enable_reddit"] = enabled
                self.write_metadata()
                self.assert_error("export_incomplete", 422, reason="platform_log_missing")
        self.state.pop("enable_reddit")
        self.write_metadata()
        self.assert_error("export_incomplete", 422, reason="platform_log_missing")

    def test_disabled_present_source_is_included_and_warned(self):
        self.write_log("reddit", [action(agent_id=2)])
        document = self.document()
        self.assertEqual(document["sources"], ["twitter", "reddit"])
        self.assertEqual([item["platform"] for item in document["actions"]], ["twitter", "reddit"])
        self.assertIn("platform_not_configured", self.warnings(document))

    def test_unknown_enabled_values_are_serialized_as_null(self):
        self.write_log("reddit", [])
        for value in (None, 0, 1, "false", [], {}):
            with self.subTest(value=value):
                self.state["enable_reddit"] = value
                self.write_metadata()
                self.assertIsNone(self.document()["platform_coverage"]["reddit"]["enabled"])

    def test_modern_precedence_ignores_stale_legacy(self):
        self.write_log("legacy", [action(platform="reddit", agent_id=99), b"invalid\n"])
        self.assertEqual(self.document()["record_count"], 1)
        self.write_log("twitter", [b"invalid\n"])
        self.assert_error("export_incomplete", 422, reason="invalid_records")

    def test_legacy_complete_empty_known_flags(self):
        self.legacy([])
        for twitter, reddit in ((True, False), (False, True), (True, True), (False, False)):
            with self.subTest(twitter=twitter, reddit=reddit):
                self.state.update(enable_twitter=twitter, enable_reddit=reddit)
                self.write_metadata()
                document = self.document()
                self.assertEqual(document["record_count"], 0)
                self.assertEqual(document["sources"], ["legacy"])
                for platform, enabled in (("twitter", twitter), ("reddit", reddit)):
                    self.assertEqual(document["platform_coverage"][platform]["availability"], "complete" if enabled else "unavailable")

    def test_legacy_unknown_requires_valid_platform_evidence(self):
        self.state["enable_twitter"] = None
        self.write_metadata()
        self.legacy([])
        self.assert_error("export_incomplete", 422, reason="platform_coverage_unknown")
        for row in (event(platform="twitter"), action(platform="twitter")):
            with self.subTest(row=row):
                self.write_log("legacy", [row])
                self.assertEqual(self.document()["platform_coverage"]["twitter"]["availability"], "complete")

    def test_legacy_disabled_present_platform_is_included(self):
        self.legacy([action(platform="reddit")])
        document = self.document()
        self.assertIn("platform_not_configured", self.warnings(document))
        self.assertEqual(document["platform_coverage"]["reddit"]["recorded_actions"], 1)

    def test_future_or_blocking_warning_cannot_pass(self):
        original = saved._context
        for code in ("future_warning", "run_not_terminal", "no_action_logs", "platform_log_missing", "source_unreadable", "source_too_large", "invalid_records"):
            with self.subTest(code=code):
                def context(*args, **kwargs):
                    summary, enabled = original(*args, **kwargs)
                    summary["warnings"].append({"code": code})
                    return summary, enabled
                with patch.object(saved, "_context", side_effect=context):
                    with self.assertRaises(saved.ComparisonError):
                        self.read()


class ClassificationAndDataTests(Fixture):
    def test_valid_modern_events_allow_missing_platform(self):
        for kind in sorted(saved._EVENTS):
            with self.subTest(kind=kind):
                self.write_log("twitter", [{"event_type": kind}, event(event_type=kind, timestamp="saved", extra={"counter": 0}), action()])
                document = self.document()
                self.assertEqual(document["record_count"], 1)
                self.assertEqual(document["actions"][0]["record_id"], "twitter:3")

    def test_invalid_or_ambiguous_event_records_fail_whole_export(self):
        invalid = [event(event_type="unknown"), event(event_type=None), event(event_type=1),
                   event(event_type=[]), event(event_type={}), event(action_type="CREATE_POST"),
                   event(action_type=None), event(platform=None), event(platform="reddit"),
                   event(platform="other"), event(platform=[]), event(round=-1), event(round=True),
                   event(round=1.0), event(round="1"), event(round=None), event(timestamp=None),
                   event(timestamp=0)]
        for row in invalid:
            with self.subTest(row=row):
                self.write_log("twitter", [action(), row, action(agent_id=2)])
                self.assert_error("export_incomplete", 422, reason="invalid_records")

    def test_legacy_events_require_supported_explicit_platform(self):
        for row in (event(), event(platform=None), event(platform="unknown"), event(platform=[])):
            with self.subTest(row=row):
                self.legacy([row])
                self.assert_error("export_incomplete", 422, reason="invalid_records")

    def test_invalid_actions_fail_whole_export(self):
        invalid = [action(agent_id=-1), action(agent_id=True), action(agent_id="1"), action(agent_id=None),
                   action(round=True), action(round=-1), action(round=1.5), action(timestamp=None),
                   action(action_type=""), action(action_type="  "), action(action_type=None),
                   action(action_type="x" * 257), action(platform=None), action(platform="reddit"), action(platform=[])]
        invalid.append({"action_type": "CREATE_POST"})
        for row in invalid:
            with self.subTest(row=row):
                self.write_log("twitter", [action(), row])
                self.assert_error("export_incomplete", 422, reason="invalid_records")

    def test_nonobject_nonfinite_utf8_parse_and_recursion_failures(self):
        deep = b'{"nested":' + b'[' * 2000 + b'0' + b']' * 2000 + b'}\n'
        for raw in (b"[]\n", b"null\n", b"1\n", b"true\n", b"{broken\n", b"\xff\n",
                    b'{"value":NaN}\n', b'{"value":Infinity}\n', b'{"value":-Infinity}\n', b'{"value":1e9999}\n', deep):
            with self.subTest(raw_length=len(raw)):
                self.write_log("twitter", [action(), raw])
                self.assert_error("export_incomplete", 422, reason="invalid_records")

    def test_more_than_page_limit_preserves_source_order_and_duplicates(self):
        twitter = [action(agent_id=index, timestamp=str(300-index)) for index in range(150)]
        self.write_log("twitter", [b"\n", event(), *twitter, twitter[-1]])
        self.write_log("reddit", [action(agent_id=999, timestamp="0")])
        document = self.document()
        self.assertEqual(document["record_count"], 152)
        self.assertEqual([row["record_id"] for row in document["actions"]],
                         [f"twitter:{line}" for line in range(3, 154)] + ["reddit:1"])
        self.assertEqual(document["actions"][-3]["details_json"], document["actions"][-2]["details_json"])

    def test_large_integer_unicode_unknown_success_and_raw_details_are_preserved(self):
        missing_round = action(agent_id=10**80, success="true", text="雪 😀 \ud800", origin={"custom": "retained"})
        missing_round.pop("round")
        explicit_zero = {**missing_round, "round": 0, "success": False, "agent_name": 4}
        self.write_log("twitter", [missing_round, explicit_zero, action(success=True)])
        payload = self.read()
        self.assertTrue(payload.isascii())
        records = json.loads(payload)["actions"]
        self.assertEqual(records[0]["agent_id"], str(10**80))
        self.assertEqual([row["round_num"] for row in records[:2]], ["0", "0"])
        self.assertEqual([row["success"] for row in records], [None, False, True])
        self.assertIsNone(records[1]["agent_name"])
        self.assertEqual(json.loads(records[0]["details_json"]), missing_round)
        self.assertEqual(json.loads(records[1]["details_json"]), explicit_zero)
        self.assertNotIn("seed", records[0])
        self.assertNotIn("match_preview", records[0])

    def test_legacy_keeps_physical_order_and_source_record_ids(self):
        self.legacy([action(platform="reddit", timestamp="z"), b"\n", event(platform="twitter"), action(platform="twitter", timestamp="a")])
        records = self.document()["actions"]
        self.assertEqual([row["record_id"] for row in records], ["legacy:1", "legacy:4"])
        self.assertEqual([row["platform"] for row in records], ["reddit", "twitter"])

    def test_page_and_round_readers_keep_partial_neighbor_behavior(self):
        self.write_log("twitter", [action(), b"invalid\n", action(round=2)])
        self.assert_error("export_incomplete", 422, reason="invalid_records")
        page = pages.read_saved_activity(str(self.sim_root), str(self.run_root), self.simulation_id)
        overview = rounds.read_saved_activity_rounds(str(self.sim_root), str(self.run_root), self.simulation_id)
        self.assertEqual(page["availability"], "partial")
        self.assertEqual(page["matched_count"], 2)
        self.assertEqual(overview["availability"], "partial")
        self.assertEqual(overview["matched_count"], 2)

    def test_existing_event_skip_policy_is_not_silently_changed(self):
        self.write_log("twitter", [action(), event(platform="reddit", action_type="CREATE_POST")])
        self.assert_error("export_incomplete", 422, reason="invalid_records")
        page = pages.read_saved_activity(str(self.sim_root), str(self.run_root), self.simulation_id)
        overview = rounds.read_saved_activity_rounds(str(self.sim_root), str(self.run_root), self.simulation_id)
        self.assertEqual(page["availability"], "complete")
        self.assertEqual(page["matched_count"], 1)
        self.assertEqual(overview["matched_count"], 1)


class BoundAndOnePassTests(Fixture):
    def test_fixed_limits(self):
        self.assertEqual(export.MAX_EXPORT_BYTES, 8_388_608)
        self.assertEqual(export.MAX_EXPORT_ACTIONS, 50_000)

    def test_exact_and_one_over_complete_file_byte_limit(self):
        collector = export._ExportCollector()
        collector.collect(action(text="雪\ud800"), "twitter", 1, "twitter")
        base = {"context": {"created_at": ""}, "record_count": 1}
        initial = collector.finish(base)
        padding = export.MAX_EXPORT_BYTES - len(initial)
        self.assertGreater(padding, 0)
        exact = {"context": {"created_at": "x" * padding}, "record_count": 1}
        payload = collector.finish(exact)
        self.assertEqual(len(payload), export.MAX_EXPORT_BYTES)
        self.assertTrue(payload.endswith(b"\n"))
        self.assertEqual(len(json.loads(payload)["actions"]), 1)
        over = {"context": {"created_at": "x" * (padding + 1)}, "record_count": 1}
        self.assert_error("export_too_large", 413, call=lambda: collector.finish(over))

    def test_single_oversized_candidate_refuses_before_finish(self):
        collector = export._ExportCollector()
        self.assert_error("export_too_large", 413,
                          call=lambda: collector.collect(action(text="x" * export.MAX_EXPORT_BYTES), "twitter", 1, "twitter"))

    def test_action_count_guard_independent_of_output_bytes(self):
        # A controlled serializer makes each candidate tiny. Production byte and
        # count constants stay unchanged; this is not a 50k real-file claim.
        collector = export._ExportCollector()
        with patch.object(export, "_json", return_value="{}"):
            for index in range(export.MAX_EXPORT_ACTIONS):
                collector.collect(action(), "twitter", index + 1, "twitter")
            self.assert_error("export_too_large", 413,
                              call=lambda: collector.collect(action(), "twitter", 50_001, "twitter"))

    def test_input_log_line_record_and_global_type_budgets(self):
        cases = [
            ("MAX_LOG_BYTES", 16, [action()], None),
            ("MAX_LINE_BYTES", 16, [action()], None),
            ("MAX_LOG_RECORDS", 2, [event(), event(), action()], None),
            ("MAX_ACTION_TYPES", 1, [action(action_type="ONE")], [action(action_type="TWO")]),
        ]
        for name, value, twitter, reddit in cases:
            with self.subTest(limit=name):
                self.write_log("twitter", twitter)
                if reddit is None:
                    self.path("reddit").unlink(missing_ok=True)
                else:
                    self.write_log("reddit", reddit)
                with patch.object(saved, name, value):
                    self.assert_error("export_too_large", 413)

    def test_blank_lines_cost_input_bytes_and_physical_line_budget(self):
        self.write_log("twitter", [b" " * 40 + b"\n"])
        with patch.object(saved, "MAX_LINE_BYTES", 40):
            self.assert_error("export_too_large", 413)
        self.write_log("twitter", [b"\n"] * 40)
        with patch.object(saved, "MAX_LOG_BYTES", 39):
            self.assert_error("export_too_large", 413)

    def test_events_and_blanks_do_not_consume_output_count(self):
        self.write_log("twitter", [b"\n", event()] * 30 + [action()])
        with patch.object(export, "MAX_EXPORT_ACTIONS", 1):
            self.assertEqual(self.document()["record_count"], 1)

    def test_one_metadata_pass_one_scan_no_page_summary_or_runtime(self):
        self.write_log("reddit", [action(agent_id=2)])
        self.write_log("legacy", [action(platform="twitter")])
        revision = self.revision()
        with ExitStack() as stack:
            paths = stack.enter_context(patch.object(saved, "_paths", wraps=saved._paths))
            snapshot = stack.enter_context(patch.object(saved, "_snapshot", wraps=saved._snapshot))
            context = stack.enter_context(patch.object(saved, "_context", wraps=saved._context))
            metadata = stack.enter_context(patch.object(saved, "_metadata", wraps=saved._metadata))
            opened = stack.enter_context(patch.object(saved, "_open_source", wraps=saved._open_source))
            scans = stack.enter_context(patch.object(export, "_read_log", wraps=export._read_log))
            stack.enter_context(patch.object(saved, "_summary", side_effect=AssertionError("summary called")))
            stack.enter_context(patch.object(pages, "read_saved_activity", side_effect=AssertionError("page called")))
            self.read(revision=revision)
        self.assertEqual(paths.call_count, 1)
        self.assertEqual(snapshot.call_count, 2)
        self.assertEqual(context.call_count, 1)
        self.assertEqual(metadata.call_count, 3)
        self.assertEqual(scans.call_count, 2)
        counts = Counter(call.args[0] for call in opened.call_args_list)
        self.assertEqual(counts, {str(self.path(name)): 1 for name in ("state", "config", "run", "twitter", "reddit")})


class RevisionAndStorageTests(Fixture):
    def test_before_read_revision_mismatch_does_not_read_metadata_or_logs(self):
        with patch.object(saved, "_context", side_effect=AssertionError("metadata read")), \
                patch.object(export, "_read_log", side_effect=AssertionError("log read")), \
                patch.object(saved, "_snapshot", wraps=saved._snapshot) as snapshots:
            self.assert_error("sources_changed", 409, call=lambda: self.read(revision="0" * 64))
        self.assertEqual(snapshots.call_count, 2)

    def test_ordinary_mutations_supersede_success_invalid_and_size_refusals(self):
        for mode in ("success", "invalid", "oversized"):
            for mutation in ("append", "replace", "remove", "new_modern", "new_legacy", "metadata"):
                with self.subTest(mode=mode, mutation=mutation):
                    self.path("reddit").unlink(missing_ok=True)
                    self.path("legacy").unlink(missing_ok=True)
                    self.write_log("twitter", [action()] if mode != "invalid" else [b"invalid\n"])
                    revision = self.revision()
                    original = export._read_log
                    changed = False
                    def scan(*args, **kwargs):
                        nonlocal changed
                        try:
                            return original(*args, **kwargs)
                        finally:
                            if not changed:
                                changed = True
                                target = self.path("twitter")
                                if mutation == "append":
                                    with target.open("ab") as handle:
                                        handle.write(b"\n")
                                elif mutation == "replace":
                                    replacement = target.with_name("replacement.jsonl")
                                    replacement.write_bytes(encoded(action(agent_id=7)))
                                    os.replace(replacement, target)
                                elif mutation == "remove":
                                    target.unlink()
                                elif mutation == "new_modern":
                                    self.write_log("reddit", [])
                                elif mutation == "new_legacy":
                                    self.write_log("legacy", [])
                                else:
                                    self.write_bytes("config", encoded({"changed": True}))
                    with ExitStack() as stack:
                        stack.enter_context(patch.object(export, "_read_log", side_effect=scan))
                        finish = stack.enter_context(patch.object(export._ExportCollector, "finish", side_effect=AssertionError("download bytes assembled")))
                        if mode == "oversized":
                            stack.enter_context(patch.object(saved, "MAX_LOG_BYTES", 1))
                        self.assert_error("sources_changed", 409, call=lambda: self.read(revision=revision))
                        finish.assert_not_called()
                    self.assertTrue(changed)

    def test_changed_source_supersedes_late_io_failure(self):
        revision = self.revision()
        def failing_scan(*args, **kwargs):
            self.path("twitter").unlink()
            raise OSError("private path marker")
        with patch.object(export, "_read_log", side_effect=failing_scan):
            self.assert_error("sources_changed", 409, call=lambda: self.read(revision=revision))

    def test_change_during_metadata_failure_is_still_conflict(self):
        revision = self.revision()
        original = saved._context
        def missing_state(*args, **kwargs):
            self.path("state").unlink()
            return original(*args, **kwargs)
        with patch.object(saved, "_context", side_effect=missing_state):
            self.assert_error("sources_changed", 409, call=lambda: self.read(revision=revision))

    def test_mutation_after_final_observation_does_not_rewrite_accepted_bytes(self):
        revision = self.revision()
        original = saved._snapshot
        count = 0
        def snapshot(paths):
            nonlocal count
            count += 1
            captured = original(paths)
            if count == 2:
                self.write_log("twitter", [action(agent_id=99), action(agent_id=100)])
            return captured
        with patch.object(saved, "_snapshot", side_effect=snapshot):
            document = json.loads(self.read(revision=revision))
        self.assertEqual(count, 2)
        self.assertEqual(document["source_revision"], revision)
        self.assertEqual(document["record_count"], 1)
        self.assertEqual(document["actions"][0]["agent_id"], "1")
        self.assertNotEqual(self.revision(), revision)

    def test_unsafe_and_reserved_ids_refuse_before_paths(self):
        for identifier in ("../sim", "sim/x", "sim\\x", "sim.bad", "CON", "nul", "LPT9", "a" * 129, "", None, 1):
            with self.subTest(identifier=identifier), patch.object(saved, "_paths", side_effect=AssertionError("paths constructed")):
                self.assert_error("invalid_selection", 400, call=lambda: export.read_saved_actions_export(
                    str(self.sim_root), str(self.run_root), identifier, revision="a" * 64))

    def test_descendant_alias_and_final_symlink_are_rejected(self):
        original = self.path("twitter")
        target = self.root / "outside.jsonl"
        target.write_bytes(encoded(action()))
        original.unlink()
        original.symlink_to(target)
        self.assert_error("unsafe_path", 400, call=lambda: self.read(revision="a" * 64))
        original.unlink()
        original.parent.rmdir()
        alternate = self.root / "other-platform"
        alternate.mkdir()
        (alternate / "actions.jsonl").write_bytes(encoded(action()))
        original.parent.symlink_to(alternate, target_is_directory=True)
        self.assert_error("unsafe_path", 400, call=lambda: self.read(revision="a" * 64))

    def test_final_component_replacement_is_not_followed_and_conflicts(self):
        revision = self.revision()
        original = saved._open_source
        target = self.root / "outside.jsonl"
        target.write_bytes(encoded(action(agent_id=99)))
        def replace(path):
            if path == str(self.path("twitter")):
                self.path("twitter").unlink()
                self.path("twitter").symlink_to(target)
            return original(path)
        with patch.object(saved, "_open_source", side_effect=replace), \
                patch.object(export._ExportCollector, "collect", side_effect=AssertionError("symlink was followed")):
            self.assert_error("sources_changed", 409, call=lambda: self.read(revision=revision))

    def test_nonregular_sources_refuse_without_blocking(self):
        path = self.path("twitter")
        path.unlink()
        path.mkdir()
        self.assert_error("export_incomplete", 422, reason="source_unreadable")
        path.rmdir()
        os.mkfifo(path)
        self.assert_error("export_incomplete", 422, reason="source_unreadable")

    def test_disabled_unreadable_source_cannot_leave_downloadable_neighbor(self):
        self.write_log("reddit", [action()])
        self.write_log("legacy", [action(platform="twitter")])
        original = saved._open_source
        def unreadable(path):
            if path == str(self.path("reddit")):
                raise PermissionError("private path")
            return original(path)
        with patch.object(saved, "_open_source", side_effect=unreadable), \
                patch.object(export._ExportCollector, "finish", side_effect=AssertionError("partial file created")):
            self.assert_error("export_incomplete", 422, reason="source_unreadable")

    def test_late_read_failure_discards_private_prefix(self):
        original = saved._open_source
        class FailingStream:
            def __init__(self, stream):
                self.stream = stream
                self.reads = 0
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def fileno(self):
                return self.stream.fileno()
            def readline(self, size):
                self.reads += 1
                if self.reads > 1:
                    raise OSError("private path marker")
                return self.stream.readline(size)
        def open_source(path):
            stream = original(path)
            return FailingStream(stream) if path == str(self.path("twitter")) else stream
        with patch.object(saved, "_open_source", side_effect=open_source), \
                patch.object(export._ExportCollector, "finish", side_effect=AssertionError("partial file created")):
            self.assert_error("export_incomplete", 422, reason="source_unreadable")

    def test_unchanged_success_does_not_modify_storage(self):
        before = {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.document()
        after = {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(after, before)
