"""Finite isolated service checks for exact admitted platform/agent attempts."""

import hashlib
import json
from unittest.mock import patch

from saved_activity_agents_support import (
    BrokenStream, FixedDatetime, Fixture, Query, action, agents, bucket,
    encoded, event, pages, saved,
)


class AgentQueryTests(Fixture):
    def test_only_optional_platform_and_revision_are_admitted(self):
        self.assertEqual(agents.parse_saved_activity_agents_query(Query()), {"platform": None})
        for platform in ("twitter", "reddit"):
            with self.subTest(platform=platform):
                query = Query([("platform", platform), ("revision", "a" * 64)])
                self.assertEqual(agents.parse_saved_activity_agents_query(query),
                                 {"platform": platform, "revision": "a" * 64})

    def test_unknown_record_round_and_pagination_fields_are_rejected(self):
        for field in ("agent_id", "round_num", "round_from", "round_to", "q", "outcome",
                      "action_type", "case_sensitive", "offset", "limit", "sort", "unknown"):
            with self.subTest(field=field), patch.object(saved, "_paths", side_effect=AssertionError("storage reached")):
                self.assert_error("invalid_filters", call=lambda: agents.parse_saved_activity_agents_query(Query([(field, "1")])))

    def test_empty_malformed_and_repeated_query_values_are_rejected(self):
        cases = [([("platform", value)], "invalid_filters")
                 for value in ("", "Twitter", "other", " twitter", "twitter ")]
        cases += [([("revision", value)], "invalid_revision")
                  for value in ("", "a" * 63, "a" * 65, "A" * 64, "g" * 64, " " + "a" * 64)]
        cases += [([("platform", "twitter"), ("platform", "twitter")], "invalid_filters"),
                  ([("revision", "a" * 64), ("revision", "a" * 64)], "invalid_revision")]
        for query, code in cases:
            with self.subTest(query=query):
                self.assert_error(code, call=lambda: agents.parse_saved_activity_agents_query(Query(query)))

    def test_direct_invalid_selection_and_filters_precede_storage(self):
        with patch.object(saved, "_paths", side_effect=AssertionError("storage reached")):
            for platform in ("", "other", True, 0):
                with self.subTest(platform=platform):
                    self.assert_error("invalid_filters", call=lambda: self.read(platform=platform))
            for revision in ("", 42, False, "A" * 64):
                with self.subTest(revision=revision):
                    self.assert_error("invalid_revision", call=lambda: self.read(revision=revision))
            for identifier in ("..", "bad.name", "CON", "a" * 129):
                with self.subTest(identifier=identifier):
                    self.assert_error("invalid_selection", call=lambda: agents.read_saved_activity_agents(
                        str(self.sim_root), str(self.run_root), identifier))


class AgentCollectorTests(Fixture):
    def test_tentative_counts_are_invisible_and_discardable(self):
        collector = agents._AgentCollector({"platform": None})
        collector.begin("twitter")
        collector.collect(action(agent_id=0, success=False), "twitter", 3)
        self.assertEqual(collector.rows(), [])
        collector.discard()
        collector.commit()
        self.assertEqual(collector.rows(), [])
        collector.begin("twitter")
        collector.collect(action(agent_id=0, success=True), "twitter", 8)
        collector.commit()
        self.assertEqual(collector.rows(), [bucket("twitter", 0, success=1)])

    def test_begin_discards_prior_tentative_source_without_touching_committed(self):
        collector = agents._AgentCollector({"platform": None})
        collector.begin("first")
        collector.collect(action(), "twitter", 1)
        collector.commit()
        collector.begin("second")
        collector.collect(action(agent_id=2), "twitter", 2)
        collector.begin("third")
        collector.collect(action(agent_id=3, success=False), "reddit", 1)
        collector.commit()
        self.assertEqual(collector.rows(), [bucket("reddit", 3, failed=1), bucket("twitter", 1, unknown=1)])

    def test_repeated_pair_merges_and_platform_selection_precedes_pair_budget(self):
        collector = agents._AgentCollector({"platform": "twitter"})
        with patch.object(agents, "MAX_AGENT_PAIRS", 1):
            for source in ("first", "second"):
                collector.begin(source)
                for index in range(3):
                    collector.collect(action(agent_id=index), "reddit", index + 1)
                collector.collect(action(agent_id=7, success=False), "twitter", 5)
                collector.commit()
        self.assertFalse(collector.too_many_agent_pairs)
        self.assertEqual(collector.rows(), [bucket("twitter", 7, failed=2)])

    def test_union_and_each_map_are_bounded_at_exact_1000_pairs(self):
        collector = agents._AgentCollector({"platform": None})
        collector.begin("first")
        for identifier in range(600):
            collector.collect(action(agent_id=identifier), "twitter", identifier + 1)
        collector.commit()
        collector.begin("second")
        # 600 overlaps plus 400 new pairs fit. Overlap still contributes counts.
        for identifier in range(1000):
            collector.collect(action(agent_id=identifier, success=True), "twitter", identifier + 1)
            self.assertLessEqual(len(collector.agents), 1000)
            self.assertLessEqual(len(collector.staged_agents), 1000)
            self.assertLessEqual(len(collector.agents.keys() | collector.staged_agents.keys()), 1000)
        self.assertEqual((len(collector.agents), len(collector.staged_agents)), (600, 1000))
        self.assertFalse(collector.staged_too_many_agent_pairs)
        collector.commit()
        self.assertEqual(len(collector.rows()), 1000)
        self.assertEqual(sum(row["count"] for row in collector.rows()), 1600)
        collector.begin("third")
        collector.collect(action(agent_id=1000), "twitter", 1)
        self.assertTrue(collector.staged_too_many_agent_pairs)
        self.assertFalse(collector.too_many_agent_pairs)
        self.assertEqual(len(collector.staged_agents), 0)
        collector.commit()
        self.assertTrue(collector.too_many_agent_pairs)

    def test_tentative_overflow_stops_retention_and_discard_erases_it(self):
        collector = agents._AgentCollector({"platform": None})
        with patch.object(agents, "MAX_AGENT_PAIRS", 1):
            collector.begin("first")
            collector.collect(action(agent_id=1), "twitter", 1)
            collector.collect(action(agent_id=2), "twitter", 2)
            for index in range(20):
                collector.collect(action(agent_id=index, success=False), "twitter", index + 3)
            self.assertTrue(collector.staged_too_many_agent_pairs)
            self.assertEqual(sum(sum(counts.values()) for counts in collector.staged_agents.values()), 1)
            collector.discard()
            self.assertFalse(collector.staged_too_many_agent_pairs)
            self.assertFalse(collector.too_many_agent_pairs)
            collector.begin("healthy")
            collector.collect(action(agent_id=9, success=True), "reddit", 1)
            collector.commit()
        self.assertEqual(collector.rows(), [bucket("reddit", 9, success=1)])

    def test_clear_removes_committed_pending_counts_and_both_overflow_flags(self):
        for committed_overflow in (False, True):
            with self.subTest(committed_overflow=committed_overflow):
                collector = agents._AgentCollector({"platform": None})
                with patch.object(agents, "MAX_AGENT_PAIRS", 1):
                    collector.begin("first")
                    collector.collect(action(), "twitter", 1)
                    collector.commit()
                    collector.begin("second")
                    collector.collect(action(agent_id=2), "reddit", 1)
                    if committed_overflow:
                        collector.commit()
                    collector.clear()
                    self.assertEqual((collector.agents, collector.staged_agents, collector.staged_new_pairs), ({}, {}, 0))
                    self.assertFalse(collector.too_many_agent_pairs)
                    self.assertFalse(collector.staged_too_many_agent_pairs)
                    collector.begin("new")
                    collector.collect(action(agent_id=3, success=True), "reddit", 1)
                    collector.commit()
                    self.assertEqual(collector.rows(), [bucket("reddit", 3, success=1)])


class AgentServiceTests(Fixture):
    def test_exact_response_schema_context_and_private_payload_exclusion(self):
        self.write_log("twitter", [action(agent_id=7, success=False, agent_name="PRIVATE_NAME", result="PRIVATE_ACTION"),
                                   action(agent_id=7, success=False), event(agent_id=999)])
        self.write_log("reddit", [action(agent_id=7, success=True)])
        before = self.inventory()
        with patch.object(agents, "datetime", FixedDatetime):
            result = self.read()
        self.assertEqual(set(result), {"simulation_id", "source_revision", "observed_at", "context", "availability",
                                      "platform_availability", "warnings", "filters", "order", "matched_count",
                                      "pair_count", "outcomes", "agents"})
        self.assertEqual(result["simulation_id"], self.simulation_id)
        self.assertEqual(result["source_revision"], self.revision())
        self.assertEqual(result["observed_at"], "2026-10-17T12:00:00+00:00")
        self.assertEqual(result["filters"], {"platform": None})
        self.assertEqual(result["order"], "failed_desc_total_desc_platform_agent")
        self.assertEqual(result["agents"], [bucket("twitter", 7, failed=2), bucket("reddit", 7, success=1)])
        self.assertEqual((result["matched_count"], result["pair_count"]), (3, 2))
        self.assertEqual(result["outcomes"], {"success": 1, "failed": 2, "unknown": 0})
        self.assertEqual(result["context"], {
            "status": "completed", "created_at": self.state["created_at"], "updated_at": self.run["updated_at"],
            "started_at": self.run["started_at"], "completed_at": self.run["completed_at"],
            "requested_rounds": "5", "last_saved_round": "2",
        })
        self.assertNotIn("PRIVATE_", json.dumps(result))
        self.assertNotIn("configured_agents", result["context"])
        self.assertEqual(self.inventory(), before)

    def test_only_exact_booleans_classify_success_and_repeated_attempts_count(self):
        values = [None, "false", "true", 0, 1, [], {}, False, True]
        repeated = action(agent_id=0, success=False)
        self.write_log("twitter", [action(agent_id=0, success=value) for value in values]
                       + [action(agent_id=0), repeated, repeated])
        result = self.read()
        self.assertEqual(result["agents"], [bucket("twitter", 0, success=1, failed=3, unknown=8)])
        self.assertEqual(result["matched_count"], 12)

    def test_fixed_order_prioritizes_failed_then_total_then_platform_then_exact_id(self):
        self.write_log("twitter", [action(agent_id=99, success=False)] * 2
                       + [action(agent_id=10, success=False), action(agent_id=10), action(agent_id=10)]
                       + [action(agent_id=2, success=False), action(agent_id=2)]
                       + [action(agent_id=9007199254740993), action(agent_id=9007199254740992),
                          action(agent_id=10), action(agent_id=0)])
        self.write_log("reddit", [action(agent_id=0, success=False), action(agent_id=0),
                                  action(agent_id=1), action(agent_id=1), action(agent_id=1)])
        result = self.read()
        self.assertEqual(result["agents"], [
            bucket("twitter", 99, failed=2), bucket("twitter", 10, failed=1, unknown=3),
            bucket("twitter", 2, failed=1, unknown=1), bucket("reddit", 0, failed=1, unknown=1),
            bucket("reddit", 1, unknown=3), bucket("twitter", 0, unknown=1),
            bucket("twitter", 9007199254740992, unknown=1), bucket("twitter", 9007199254740993, unknown=1),
        ])
        self.write_log("twitter", [action(agent_id=value) for value in (9007199254740993, 10, 9007199254740992, 2)])
        self.assertEqual([row["agent_id"] for row in self.read(platform="twitter")["agents"]],
                         ["2", "10", "9007199254740992", "9007199254740993"])

    def test_zero_64_digit_and_65_digit_source_ids_remain_exact(self):
        supported, unsupported = int("9" * 64), 10 ** 64
        self.write_log("twitter", [action(agent_id=value) for value in (unsupported, supported, 0)])
        result = self.read()
        self.assertEqual(result["agents"], [bucket("twitter", 0, unknown=1), bucket("twitter", supported, unknown=1),
                                            bucket("twitter", unsupported, unknown=1)])
        self.assertEqual(self.details(agent_id=str(supported))["matched_count"], 1)
        self.assert_error("invalid_filters", call=lambda: self.details(agent_id=str(unsupported)))

    def test_invalid_ids_do_not_create_unknown_agent_or_change_admitted_counts(self):
        invalid = [action(agent_id=value) for value in (True, False, -1, 1.0, "1", None, [], {})]
        missing = action()
        del missing["agent_id"]
        self.write_log("twitter", [action(agent_id=0, success=False), *invalid, missing])
        result = self.read()
        self.assertEqual(result["agents"], [bucket("twitter", 0, failed=1)])
        self.assertEqual(result["availability"], "partial")
        self.assertIn({"code": "invalid_records", "platform": "twitter", "count": 9}, result["warnings"])

    def test_malformed_neighbors_keep_shared_action_and_event_admission(self):
        cases = [b"not json\n", b"[]\n", b'{"agent_id":NaN}\n', b"\xff\n",
                 encoded(action(round=-1)), encoded(action(round=True)), encoded(action(action_type=" ")),
                 encoded(action(timestamp=42)), encoded(action(platform="reddit")),
                 b'{"agent_id":0,"action_type":"X","result":1e999}\n', encoded(event(event_type=[]))]
        for malformed in cases:
            with self.subTest(malformed=malformed):
                self.write_log("twitter", [event(), action(agent_id=4, success=True), malformed])
                result = self.read()
                self.assertEqual(result["agents"], [bucket("twitter", 4, success=1)])
                self.assertEqual(result["availability"], "partial")
                self.assertIn({"code": "invalid_records", "platform": "twitter", "count": 1}, result["warnings"])

    def test_selected_platform_retains_source_identity_and_only_matching_pairs(self):
        self.write_log("twitter", [action(agent_id=7, success=False)])
        self.write_log("reddit", [action(agent_id=7, success=True), action(agent_id=8)])
        whole = self.read()
        selected = self.read(platform="reddit", revision=whole["source_revision"])
        self.assertEqual(selected["source_revision"], whole["source_revision"])
        self.assertEqual(selected["filters"], {"platform": "reddit"})
        self.assertEqual(selected["agents"], [bucket("reddit", 7, success=1), bucket("reddit", 8, unknown=1)])
        self.assertEqual(selected["outcomes"], {"success": 1, "failed": 0, "unknown": 1})
        self.assertEqual(selected["matched_count"], 2)

    def test_complete_partial_and_unavailable_empty_coverage_are_distinct(self):
        for contents, availability in ((b"", "complete"), (b" \n\t\n", "complete"),
                                       (encoded(event()), "complete"), (b"bad\n", "partial"), (None, "unavailable")):
            with self.subTest(contents=contents):
                if contents is None:
                    self.path("twitter").unlink(missing_ok=True)
                else:
                    self.write_bytes("twitter", contents)
                result = self.read()
                self.assert_empty(result, availability)
                if availability == "partial":
                    self.assertIn({"code": "invalid_records", "platform": "twitter", "count": 1}, result["warnings"])
                if availability == "unavailable":
                    self.assertIn({"code": "no_action_logs"}, result["warnings"])
                self.assert_empty(self.read(platform="reddit"), "unavailable")

    def test_missing_expected_platform_keeps_healthy_selected_coverage_complete(self):
        self.state["enable_reddit"] = True
        self.write_metadata()
        all_platforms = self.read()
        self.assertEqual(all_platforms["availability"], "partial")
        self.assertIn({"code": "platform_log_missing", "platform": "reddit"}, all_platforms["warnings"])
        self.assertEqual(self.read(platform="twitter")["availability"], "complete")
        self.assert_empty(self.read(platform="reddit"), "unavailable")

    def test_stopped_and_failed_warn_without_redefining_complete_log_coverage(self):
        for status in ("completed", "stopped", "failed"):
            with self.subTest(status=status):
                self.run["runner_status"] = status
                self.write_metadata()
                result = self.read()
                self.assertEqual(result["context"]["status"], status)
                self.assertEqual(result["availability"], "complete")
                self.assertEqual(result["matched_count"], 1)
                self.assertEqual({"code": "partial_run"} in result["warnings"], status != "completed")

    def test_active_and_nonterminal_sources_keep_shared_policy(self):
        for status in ("starting", "running", "paused", "stopping", "idle"):
            with self.subTest(status=status):
                self.run["runner_status"] = status
                self.write_metadata()
                if status in saved._ACTIVE:
                    self.assert_error("simulation_active", 409)
                else:
                    result = self.read()
                    self.assert_empty(result, "unavailable")
                    self.assertIn({"code": "run_not_terminal"}, result["warnings"])

    def test_missing_unreadable_and_mismatched_metadata_keep_existing_semantics(self):
        for contents, code in ((None, "simulation_not_found"), (b"bad", "simulation_unreadable"),
                               (encoded({"simulation_id": "different"}), "simulation_unreadable")):
            with self.subTest(contents=contents):
                if contents is None:
                    self.path("state").unlink(missing_ok=True)
                else:
                    self.write_bytes("state", contents)
                self.assert_error(code, 404)
                self.write_metadata()
        self.write_bytes("run", b"bad")
        self.path("config").unlink()
        result = self.read()
        self.assertEqual(result["context"]["status"], "completed")
        self.assertEqual(result["availability"], "complete")
        self.assertIn({"code": "run_state_unavailable"}, result["warnings"])
        self.assertIn({"code": "config_unavailable"}, result["warnings"])

    def test_legacy_platform_separation_and_modern_source_precedence(self):
        self.legacy([event(platform="twitter"), action(platform="reddit", agent_id=7, success=False),
                     action(platform="twitter", agent_id=7, success=True)])
        legacy = self.read()
        self.assertEqual(legacy["agents"], [bucket("reddit", 7, failed=1), bucket("twitter", 7, success=1)])
        self.assertEqual(legacy["availability"], "complete")
        self.state["enable_reddit"] = True
        self.write_metadata()
        self.write_log("twitter", [])
        modern = self.read()
        self.assert_empty(modern, "partial")
        self.assertNotEqual(modern["source_revision"], legacy["source_revision"])

    def test_exact_1000_distinct_pairs_and_one_over_refuse_without_prefix(self):
        self.assertEqual((agents.MAX_AGENT_PAIRS, agents.MAX_RESPONSE_BYTES), (1000, 1048576))
        self.write_log("twitter", [action(agent_id=value, success=False) for value in range(1000)]
                       + [action(agent_id=0, success=False)] * 3)
        result = self.read()
        self.assertEqual((result["pair_count"], result["matched_count"]), (1000, 1003))
        self.assertEqual(result["agents"][0], bucket("twitter", 0, failed=4))
        with self.path("twitter").open("ab") as stream:
            stream.write(encoded(action(agent_id=1000)))
        self.assert_error("too_many_agent_pairs", 413)
        self.assert_error("too_many_agent_pairs", 413, call=lambda: self.read(platform="twitter"))

    def test_pair_budget_spans_platforms_even_when_ids_overlap(self):
        self.write_log("twitter", [action(agent_id=value) for value in range(500)])
        self.write_log("reddit", [action(agent_id=value) for value in range(500)])
        self.assertEqual(self.read()["pair_count"], 1000)
        with self.path("reddit").open("ab") as stream:
            stream.write(encoded(action(agent_id=500)))
        self.assert_error("too_many_agent_pairs", 413)
        self.assertEqual(self.read(platform="twitter")["pair_count"], 500)
        self.assertEqual(self.read(platform="reddit")["pair_count"], 501)

    def test_late_source_limit_refusal_discards_tentative_counts_and_overflow(self):
        for budget, value in (("MAX_LOG_RECORDS", 3), ("MAX_LINE_BYTES", 180), ("MAX_ACTION_TYPES", 1)):
            with self.subTest(budget=budget):
                self.write_log("twitter", [action(agent_id=value, success=False) for value in range(3)]
                               + [action(agent_id=3, action_type="OTHER", result="x" * 200)])
                self.write_log("reddit", [action(agent_id=9, success=True)])
                with patch.object(agents, "MAX_AGENT_PAIRS", 2), patch.object(saved, budget, value):
                    result = self.read()
                self.assertEqual(result["agents"], [bucket("reddit", 9, success=1)])
                self.assertEqual(result["matched_count"], 1)
                self.assertEqual(result["platform_availability"]["twitter"], "unavailable")
                self.assertIn({"code": "source_too_large", "platform": "twitter"}, result["warnings"])

    def test_late_io_after_overflow_discards_source_but_keeps_healthy_source(self):
        path = self.write_log("twitter", [action(agent_id=value, success=False) for value in range(3)])
        self.write_log("reddit", [action(agent_id=9, success=True)])
        original = saved._open_source
        def opened(source):
            stream = original(source)
            return BrokenStream(stream, 4) if str(source) == str(path) else stream
        with patch.object(agents, "MAX_AGENT_PAIRS", 2), patch.object(saved, "_open_source", opened):
            result = self.read()
        self.assertEqual(result["agents"], [bucket("reddit", 9, success=1)])
        self.assertEqual(result["outcomes"], {"success": 1, "failed": 0, "unknown": 0})
        self.assertIn({"code": "source_unreadable", "platform": "twitter"}, result["warnings"])
        self.assertNotIn("PRIVATE_LATE_IO", json.dumps(result))

    def test_second_source_overflow_and_late_failure_keep_committed_1000_pairs(self):
        self.write_log("twitter", [action(agent_id=value, success=True) for value in range(1000)])
        path = self.write_log("reddit", [action(agent_id=value, success=False) for value in range(3)])
        original = saved._open_source
        with patch.object(saved, "_open_source", lambda source: BrokenStream(original(source), 4)
                          if str(source) == str(path) else original(source)):
            result = self.read()
        self.assertEqual((result["pair_count"], result["matched_count"]), (1000, 1000))
        self.assertEqual(result["outcomes"], {"success": 1000, "failed": 0, "unknown": 0})
        self.assertTrue(all(row["platform"] == "twitter" for row in result["agents"]))
        self.assertIn({"code": "source_unreadable", "platform": "reddit"}, result["warnings"])

    def test_global_type_refusal_clears_committed_or_tentative_overflow(self):
        for overflow_source in ("twitter", "reddit"):
            with self.subTest(overflow_source=overflow_source):
                self.write_log("twitter", [action(agent_id=value, action_type="A")
                               for value in range(3 if overflow_source == "twitter" else 1)])
                self.write_log("reddit", [action(agent_id=value, action_type="B")
                               for value in range(3 if overflow_source == "reddit" else 1)])
                with patch.object(agents, "MAX_AGENT_PAIRS", 2), patch.object(saved, "MAX_ACTION_TYPES", 1):
                    result = self.read()
                self.assert_empty(result, "unavailable")
                self.assertIn({"code": "source_too_large"}, result["warnings"])

    def test_platform_selection_does_not_bypass_global_or_source_admission(self):
        self.write_log("twitter", [action(agent_id=1, action_type="A")])
        self.write_log("reddit", [action(agent_id=2, action_type="B")])
        with patch.object(saved, "MAX_ACTION_TYPES", 1):
            self.assert_empty(self.read(platform="twitter"), "unavailable")
        self.write_log("twitter", [action(agent_id=value) for value in range(4)])
        with patch.object(saved, "MAX_LOG_RECORDS", 3):
            self.assert_empty(self.read(platform="twitter"), "unavailable")

    def test_file_byte_refusal_prevents_prefix_admission(self):
        self.write_log("twitter", [action(), action()])
        self.write_log("reddit", [])
        with patch.object(saved, "MAX_LOG_BYTES", 60):
            result = self.read()
        self.assert_empty(result, "partial")
        self.assertEqual(result["platform_availability"], {"twitter": "unavailable", "reddit": "complete"})
        self.assertIn({"code": "source_too_large", "platform": "twitter"}, result["warnings"])

    def test_summary_omits_distinct_statistics_and_scans_each_source_once(self):
        self.write_log("reddit", [action(agent_id=3)])
        original_summary, original_read = saved._summary, saved._read_log
        with patch.object(saved, "_summary", wraps=original_summary) as summary, \
                patch.object(saved, "_read_log", wraps=original_read) as reads:
            result = self.read()
        summary.assert_called_once()
        self.assertIs(summary.call_args.kwargs["include_distinct_statistics"], False)
        self.assertIsInstance(summary.call_args.kwargs["collector"], agents._AgentCollector)
        self.assertEqual(reads.call_count, 2)
        self.assertEqual([call.args[1] for call in reads.call_args_list], ["twitter", "reddit"])
        self.assertTrue(all(call.kwargs["include_distinct_statistics"] is False for call in reads.call_args_list))
        self.assertEqual(result["pair_count"], 2)

    def test_complete_ascii_encoded_success_envelope_exact_boundary(self):
        self.run["updated_at"] = "\ud800 代理 😀 café"
        self.write_metadata()
        with patch.object(agents, "datetime", FixedDatetime):
            result = self.read()
            payload = pages._json({"success": True, "data": result}).encode("ascii")
            self.assertGreater(len(payload), len(pages._json(result).encode("ascii")))
            self.assertTrue(payload.isascii())
            with patch.object(agents, "MAX_RESPONSE_BYTES", len(payload)):
                self.assertEqual(self.read(), result)
            with patch.object(agents, "MAX_RESPONSE_BYTES", len(payload) - 1):
                self.assert_error("response_too_large", 413)
        self.assertEqual(result["context"]["updated_at"], self.run["updated_at"])

    def test_default_one_mib_cap_refuses_1000_large_exact_ids(self):
        self.write_log("twitter", [action(agent_id=10 ** 1100 + index) for index in range(1000)])
        self.assert_error("response_too_large", 413)

    def test_revision_is_identical_to_existing_records_and_rounds(self):
        before = saved._snapshot(saved._paths(str(self.sim_root), str(self.run_root), self.simulation_id))
        expected = hashlib.sha256(json.dumps(["saved-activity-v1", self.simulation_id, before],
                                             ensure_ascii=True, allow_nan=False, sort_keys=True,
                                             separators=(",", ":")).encode("ascii")).hexdigest()
        overview = self.read()
        detail = self.details(revision=overview["source_revision"])
        round_view = self.round_overview(revision=overview["source_revision"])
        self.assertEqual(overview["source_revision"], expected)
        self.assertEqual(detail["source_revision"], expected)
        self.assertEqual(round_view["source_revision"], expected)

    def test_each_exact_pair_and_outcome_count_agrees_with_same_revision_details(self):
        for platform in ("twitter", "reddit"):
            self.write_log(platform, [action(agent_id=identifier, success=outcome)
                           for identifier in (0, 7, 9007199254740992, 9007199254740993, int("9" * 64))
                           for outcome in (False, False, True, "false", None)])
        overview = self.read()
        for row in overview["agents"]:
            for outcome in (None, "success", "failed", "unknown"):
                with self.subTest(platform=row["platform"], agent_id=row["agent_id"], outcome=outcome):
                    detail = self.details(platform=row["platform"], agent_id=row["agent_id"], outcome=outcome,
                                          offset=0, limit=50, revision=overview["source_revision"])
                    expected = row["count"] if outcome is None else row["outcomes"][outcome]
                    self.assertEqual(detail["matched_count"], expected)
                    self.assertEqual(detail["source_revision"], overview["source_revision"])
                    self.assertTrue(all(item["agent_id"] == row["agent_id"] and item["platform"] == row["platform"]
                                        for item in detail["actions"]))

    def test_overview_success_does_not_waive_detail_page_budget(self):
        # Each line remains admitted; the first 50 full record details exceed 2 MiB.
        self.write_log("twitter", [action(agent_id=7, success=False, result="x" * 50000)] * 50)
        overview = self.read()
        self.assertEqual(overview["agents"], [bucket("twitter", 7, failed=50)])
        self.assert_error("response_too_large", 413, call=lambda: self.details(
            platform="twitter", agent_id="7", revision=overview["source_revision"], limit=50))
        self.assertEqual(self.details(platform="twitter", agent_id="7", revision=overview["source_revision"], limit=1)["matched_count"], 50)

    def test_all_source_fingerprints_reject_old_revision_before_scanning(self):
        for change in ("append", "replace", "remove", "new_modern", "unselected_legacy", "state", "config", "run"):
            with self.subTest(change=change):
                self.path("reddit").unlink(missing_ok=True)
                self.path("legacy").unlink(missing_ok=True)
                path = self.write_log("twitter", [action()])
                self.write_metadata()
                revision = self.read(platform="twitter")["source_revision"]
                if change == "append":
                    with path.open("ab") as stream:
                        stream.write(b"{}\n")
                elif change == "replace":
                    replacement = path.with_suffix(".replacement")
                    replacement.write_bytes(path.read_bytes())
                    replacement.replace(path)
                elif change == "remove":
                    path.unlink()
                elif change == "new_modern":
                    self.write_log("reddit", [])
                elif change == "unselected_legacy":
                    self.write_log("legacy", [action(platform="reddit")])
                else:
                    with self.path(change).open("ab") as stream:
                        stream.write(b" ")
                with patch.object(saved, "_summary", side_effect=AssertionError("stale revision reached scan")):
                    self.assert_error("sources_changed", 409, call=lambda: self.read(platform="twitter", revision=revision))

    def test_final_source_change_supersedes_success_pair_cap_and_response_cap(self):
        original = saved._summary
        def changed(*args, **kwargs):
            result = original(*args, **kwargs)
            with self.path("config").open("ab") as stream:
                stream.write(b" ")
            return result
        for mode in ("success", "pair_cap", "response_cap"):
            with self.subTest(mode=mode):
                self.write_log("twitter", [action(agent_id=1), action(agent_id=2)])
                with patch.object(saved, "_summary", changed), \
                        patch.object(agents, "MAX_AGENT_PAIRS", 1 if mode == "pair_cap" else 1000), \
                        patch.object(agents, "MAX_RESPONSE_BYTES", 1 if mode == "response_cap" else 1048576):
                    self.assert_error("sources_changed", 409)

    def test_final_source_change_supersedes_metadata_and_active_refusal(self):
        original = saved._summary
        def changed(*args, **kwargs):
            try:
                return original(*args, **kwargs)
            finally:
                with self.path("config").open("ab") as stream:
                    stream.write(b" ")
        for mode in ("metadata", "active"):
            with self.subTest(mode=mode):
                self.write_metadata()
                if mode == "metadata":
                    self.write_bytes("state", b"bad")
                else:
                    self.run["runner_status"] = "running"
                    self.write_metadata()
                with patch.object(saved, "_summary", changed):
                    self.assert_error("sources_changed", 409)

    def test_unavailable_coverage_precedes_overview_specific_pair_refusal(self):
        # A source becomes globally unavailable after the collector saw overflow.
        self.write_log("twitter", [action(agent_id=1, action_type="A"), action(agent_id=2, action_type="A")])
        self.write_log("reddit", [action(agent_id=3, action_type="B")])
        with patch.object(agents, "MAX_AGENT_PAIRS", 1), patch.object(saved, "MAX_ACTION_TYPES", 1):
            result = self.read(platform="twitter")
        self.assert_empty(result, "unavailable")


class SavedReaderCompatibilityTests(Fixture):
    def test_existing_records_keep_search_pagination_outcomes_and_exact_ids(self):
        exact = 9007199254740993
        self.write_log("twitter", [action(agent_id=exact, success=False, result="Needle"),
                                   action(agent_id=exact, success=False, result="needle"),
                                   action(agent_id=exact, success=True, result="needle"),
                                   action(agent_id=7, result="needle")])
        first = self.details(agent_id=str(exact), q="NEEDLE", outcome="failed", limit=1)
        self.assertEqual((first["matched_count"], first["returned_count"], first["has_more"]), (2, 1, True))
        second = self.details(agent_id=str(exact), q="NEEDLE", outcome="failed", limit=1, offset=1,
                              revision=first["source_revision"])
        self.assertEqual(second["actions"][0]["record_id"], "twitter:2")
        self.assertEqual(second["actions"][0]["agent_id"], str(exact))
        self.assertFalse(second["has_more"])
        self.assert_error("revision_required", call=lambda: self.details(offset=1))

    def test_existing_rounds_merge_platforms_and_preserve_inclusive_range(self):
        self.write_log("twitter", [action(agent_id=7, round=2, success=False), action(agent_id=8, round=10)])
        self.write_log("reddit", [action(agent_id=7, round=2, success=True)])
        result = self.round_overview(round_from="0002", round_to="02")
        self.assertEqual(result["filters"], {"platform": None, "round_from": "2", "round_to": "2"})
        self.assertEqual(result["rounds"], [{"round_num": "2", "count": 2,
                                          "outcomes": {"success": 1, "failed": 1, "unknown": 0},
                                          "drilldown_supported": True}])
        self.assertEqual(result["order"], "round_ascending")

    def test_existing_readers_keep_source_rollback_and_stale_revision_refusal(self):
        self.write_log("twitter", [action(agent_id=1), action(agent_id=2), action(agent_id=3)])
        self.write_log("reddit", [action(agent_id=9, round=7, success=False)])
        with patch.object(saved, "MAX_LOG_RECORDS", 2):
            detail, round_view = self.details(), self.round_overview()
        self.assertEqual(detail["matched_count"], 1)
        self.assertEqual(detail["actions"][0]["platform"], "reddit")
        self.assertEqual(round_view["rounds"][0]["round_num"], "7")
        revision = detail["source_revision"]
        with self.path("config").open("ab") as stream:
            stream.write(b" ")
        for read in (self.details, self.round_overview):
            with self.subTest(reader=read.__name__):
                self.assert_error("sources_changed", 409, call=lambda: read(revision=revision))
