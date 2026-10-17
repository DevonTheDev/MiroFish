"""Finite saved-action projection/HTTP seam; source preparation is not execution.

One 40-record lexical JSONL table and exactly three reader/API scenario groups.
The retained allocation decorator asserts all 23 reader calls and 11 Flask GETs.
Only the six real successful HTTP envelopes are exported, outside the candidate,
to MIRO_NAV_ENVELOPES for the mounted frontend qualification.
"""
import ast
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Blueprint, Flask, current_app, jsonify, request

from saved_posts_support import (APP, PREFIX, Fixture, FixedDatetime, allocation,
                                 storage, _load)


_PAGE_MODULE = PREFIX + ".services.saved_activity"
pages = sys.modules.get(_PAGE_MODULE) or _load(_PAGE_MODULE, "services/saved_activity.py")


def encoded(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      sort_keys=True, separators=(",", ":")).encode("ascii")


def post_token(token):
    return ',"action_args":{"post_id":' + token + '}'


# These are literal JSON source tokens, including float and duplicate-key cases.
# Do not replace them with Python values serialized before the saved-log reader.
PROJECTION_CASES = (
    ("like_integer_zero", "LIKE_POST", post_token("0"), "0"),
    ("dislike_integer_boundary", "DISLIKE_POST", post_token("9007199254740992"), "9007199254740992"),
    ("comment_integer_adjacent", "CREATE_COMMENT", post_token("9007199254740993"), "9007199254740993"),
    ("like_integer_maximum", "LIKE_POST", post_token("9223372036854775807"), "9223372036854775807"),
    ("dislike_string_zero", "DISLIKE_POST", post_token('"0"'), "0"),
    ("comment_string_boundary", "CREATE_COMMENT", post_token('"9007199254740992"'), "9007199254740992"),
    ("like_string_adjacent", "LIKE_POST", post_token('"9007199254740993"'), "9007199254740993"),
    ("dislike_string_maximum", "DISLIKE_POST", post_token('"9223372036854775807"'), "9223372036854775807"),
    ("decoded_integer_negative_zero", "CREATE_COMMENT", post_token("-0"), "0"),
    ("boolean_true", "LIKE_POST", post_token("true"), None),
    ("boolean_false", "LIKE_POST", post_token("false"), None),
    ("integral_float", "LIKE_POST", post_token("1.0"), None),
    ("fractional_float_rounding", "LIKE_POST", post_token("9007199254740993.1"), None),
    ("exponent_float_rounding", "LIKE_POST", post_token("9007199254740993e0"), None),
    ("null_id", "LIKE_POST", post_token("null"), None),
    ("array_id", "LIKE_POST", post_token("[0]"), None),
    ("object_id", "LIKE_POST", post_token('{"post_id":0}'), None),
    ("negative_integer", "LIKE_POST", post_token("-1"), None),
    ("overflow_integer", "LIKE_POST", post_token("9223372036854775808"), None),
    ("negative_string", "LIKE_POST", post_token('"-1"'), None),
    ("positive_sign_string", "LIKE_POST", post_token('"+1"'), None),
    ("leading_space_string", "LIKE_POST", post_token('" 1"'), None),
    ("trailing_space_string", "LIKE_POST", post_token('"1 "'), None),
    ("zero_padded_string", "LIKE_POST", post_token('"00"'), None),
    ("oversized_string_before_conversion", "LIKE_POST", post_token('"' + "9" * 5000 + '"'), None),
    ("overflow_string", "LIKE_POST", post_token('"9223372036854775808"'), None),
    ("non_ascii_digits", "LIKE_POST", post_token('"\\u0661"'), None),
    ("empty_string", "LIKE_POST", post_token('""'), None),
    ("missing_args_and_source_spoofs", "LIKE_POST", ',"referenced_post_id":"0","post_id":0,"new_post_id":0,"quoted_id":0,"comment_id":0,"result":{"post_id":0}', None),
    ("array_args", "LIKE_POST", ',"action_args":[{"post_id":0}]', None),
    ("exponent_string", "LIKE_POST", post_token('"1e1"'), None),
    ("missing_id_and_nested_spoofs", "LIKE_POST", ',"action_args":{"referenced_post_id":"0","new_post_id":0,"quoted_id":0,"comment_id":0,"result":{"post_id":0}}', None),
    ("nested_impostor", "LIKE_POST", ',"action_args":{"details":{"post_id":0}}', None),
    ("unsupported_action", "CREATE_POST", post_token("0"), None),
    ("wrong_case_action", "like_post", post_token("0"), None),
    ("duplicate_id_last_valid", "LIKE_POST", ',"action_args":{"post_id":false,"post_id":9007199254740993}', "9007199254740993"),
    ("duplicate_id_last_invalid", "LIKE_POST", ',"action_args":{"post_id":0,"post_id":false}', None),
    ("decimal_string", "LIKE_POST", post_token('"1.0"'), None),
    ("null_args", "LIKE_POST", ',"action_args":null', None),
    ("string_args", "LIKE_POST", ',"action_args":"post_id:0"', None),
)


# The frontend consumes this exact order, through JSON.parse of the emitted file.
ENVELOPE_CASES = (
    ("twitter", "LIKE_POST", True, 0, "0"),
    ("reddit", "LIKE_POST", False, 9007199254740992, "9007199254740992"),
    ("twitter", "DISLIKE_POST", None, 9007199254740993, "9007199254740993"),
    ("reddit", "DISLIKE_POST", True, 9223372036854775807, "9223372036854775807"),
    ("twitter", "CREATE_COMMENT", False, "9007199254740993", "9007199254740993"),
    ("reddit", "CREATE_COMMENT", None, "9223372036854775807", "9223372036854775807"),
)


class SavedPostNavigationTests(Fixture):
    """Reuse the retained isolated module loader, storage fixture and counters."""

    def setUp(self):
        super().setUp()
        self.state["enable_reddit"] = True
        self.write_metadata()
        self.write_logs()
        clock = patch.object(pages, "datetime", FixedDatetime)
        clock.start()
        self.addCleanup(clock.stop)

        # Extract only the existing production GET handler, never app startup.
        source = APP / "api/simulation.py"
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name == "get_saved_simulation_actions"]
        self.assertEqual(len(functions), 1)
        blueprint = Blueprint("saved_post_navigation_fixture", __name__)
        namespace = {
            "__name__": "_saved_post_navigation_api_fixture", "simulation_bp": blueprint,
            "request": request, "jsonify": jsonify, "current_app": current_app,
            "ComparisonError": pages.saved.ComparisonError,
            "StoragePathError": storage.StoragePathError, "saved_activity": pages,
            "parse_saved_activity_query": pages.parse_saved_activity_query,
            "read_saved_activity": self.service,
            "SimulationManager": SimpleNamespace(SIMULATION_DATA_DIR=str(self.sim_root)),
            "SimulationRunner": SimpleNamespace(RUN_STATE_DIR=str(self.run_root)),
            "logger": Mock(),
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True)
        self.app.json.ensure_ascii = False
        self.app.register_blueprint(blueprint, url_prefix="/api/simulation")
        self.client = self.app.test_client()

    def log_path(self, platform):
        return self.run_root / self.simulation_id / platform / "actions.jsonl"

    def write_logs(self, twitter=(), reddit=()):
        for platform, rows in (("twitter", twitter), ("reddit", reddit)):
            path = self.log_path(platform)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"".join((row.encode("ascii") if isinstance(row, str) else encoded(row)) + b"\n"
                                      for row in rows))

    def service(self, *args, **kwargs):
        self.reader_calls += 1
        return pages.read_saved_activity(*args, **kwargs)

    def read(self, **kwargs):
        return self.service(str(self.sim_root), str(self.run_root), self.simulation_id, **kwargs)

    def request_activity(self, platform=None):
        self.api_calls += 1
        query = {"limit": 50}
        if platform is not None:
            query["platform"] = platform
        return self.client.get(f"/api/simulation/{self.simulation_id}/saved-actions", query_string=query)

    def assert_http_success(self, response):
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(set(response.json), {"success", "data"})
        self.assertIs(response.json["success"], True)
        self.assertTrue(response.data.isascii())
        return response.json["data"]

    def assert_http_budget_error(self, response):
        self.assertEqual(response.status_code, 413, response.get_data(as_text=True))
        self.assertEqual(response.json["error_code"], "response_too_large")
        self.assertIs(response.json["success"], False)

    @allocation(reads=1, api=0)
    def test_lexical_projection_table(self):
        self.assertEqual(len(PROJECTION_CASES), 40)
        self.assertEqual(len({case[0] for case in PROJECTION_CASES}), 40)
        lines = ['{"round":0,"agent_id":0,"action_type":"' + action + '","success":true' + tail + '}'
                 for _, action, tail, _ in PROJECTION_CASES]
        originals = [json.loads(line) for line in lines]
        self.write_logs(twitter=lines)
        before = self.inventory()
        original_collect = pages._PageCollector.collect
        seen = []

        def observe(collector, row, platform, line_number):
            before_row = encoded(row)
            original_collect(collector, row, platform, line_number)
            self.assertEqual(encoded(row), before_row, "projection mutated the admitted source record")
            seen.append((platform, line_number, before_row))

        with patch.object(pages._PageCollector, "collect", observe), \
                patch.object(pages.saved, "_read_log", wraps=pages.saved._read_log) as scans:
            result = self.read(limit=50)
        self.assertEqual(scans.call_count, 2)
        self.assertEqual(len(seen), 40)
        self.assertEqual(seen, [("twitter", index + 1, encoded(row)) for index, row in enumerate(originals)])
        self.assertEqual((result["matched_count"], result["returned_count"], result["has_more"]), (40, 40, False))
        self.assertEqual(result["availability"], "complete")
        self.assertEqual([row["record_id"] for row in result["actions"]], [f"twitter:{index + 1}" for index in range(40)])
        for index, (name, action, _, expected) in enumerate(PROJECTION_CASES):
            with self.subTest(case=name):
                row = result["actions"][index]
                self.assertIn("referenced_post_id", row)
                self.assertEqual(row["referenced_post_id"], expected)
                if expected is not None:
                    self.assertIs(type(row["referenced_post_id"]), str)
                self.assertEqual(row["action_type"], action)
                self.assertEqual(row["details_json"], encoded(originals[index]).decode("ascii"))
        self.assertEqual(self.inventory(), before)

    @allocation(reads=2, api=1)
    def test_platform_provenance_and_conflict(self):
        twitter = {"agent_id": 0, "action_type": "LIKE_POST", "action_args": {"post_id": 0, "platform": "reddit"}}
        reddit = {"agent_id": 0, "action_type": "LIKE_POST", "action_args": {"post_id": 0, "platform": "twitter"}}
        conflict = {**twitter, "platform": "reddit"}
        self.write_logs(twitter=(twitter, conflict), reddit=(reddit,))
        before = self.inventory()
        with patch.object(pages.saved, "_read_log", wraps=pages.saved._read_log) as scans:
            data = self.read(limit=50)
            selected = self.assert_http_success(self.request_activity("reddit"))
        self.assertEqual(scans.call_count, 4)
        self.assertEqual((data["matched_count"], data["returned_count"]), (2, 2))
        self.assertEqual(data["platform_availability"], {"twitter": "partial", "reddit": "complete"})
        self.assertEqual([(row["record_id"], row["platform"], row["referenced_post_id"])
                          for row in data["actions"]], [("twitter:1", "twitter", "0"), ("reddit:1", "reddit", "0")])
        self.assertEqual([row["details_json"] for row in data["actions"]],
                         [encoded(twitter).decode("ascii"), encoded(reddit).decode("ascii")])
        self.assertEqual((selected["matched_count"], selected["returned_count"]), (1, 1))
        self.assertEqual(selected["actions"], [data["actions"][1]])
        self.assertEqual(selected["filters"]["platform"], "reddit")
        self.assertEqual(self.inventory(), before)

    @allocation(reads=6, api=6)
    def test_six_action_outcome_platform_envelopes(self):
        destination = os.environ.get("MIRO_NAV_ENVELOPES")
        self.assertTrue(destination, "MIRO_NAV_ENVELOPES must name the qualification evidence output")
        output = Path(destination).resolve()
        self.assertFalse(output.is_relative_to(APP.parents[1]), "evidence must be outside the candidate repository")
        self.assertEqual(len(ENVELOPE_CASES), 6)
        raw_envelopes = []
        for index, (platform, action, outcome, source_id, expected_id) in enumerate(ENVELOPE_CASES):
            with self.subTest(case=index, platform=platform, action=action, success=outcome):
                source = {"round": 0, "agent_id": 0, "agent_name": "Saved attempt",
                          "action_type": action, "success": outcome, "action_args": {"post_id": source_id}}
                self.write_logs(**{platform: (source,)})
                before = self.inventory()
                response = self.request_activity(platform)
                data = self.assert_http_success(response)
                self.assertEqual(data["simulation_id"], "sim_A")
                self.assertEqual((data["offset"], data["limit"], data["matched_count"],
                                  data["returned_count"], data["has_more"]), (0, 50, 1, 1, False))
                self.assertEqual(data["filters"], {"platform": platform, "agent_id": None,
                    "round_num": None, "action_type": None, "q": None, "case_sensitive": False, "outcome": None})
                row = data["actions"][0]
                self.assertEqual((row["record_id"], row["platform"], row["action_type"], row["referenced_post_id"]),
                                 (platform + ":1", platform, action, expected_id))
                self.assertIs(row["success"], outcome)
                self.assertIs(type(row["referenced_post_id"]), str)
                self.assertEqual(row["details_json"], encoded(source).decode("ascii"))
                self.assertEqual(response.data, encoded({"success": True, "data": data}))
                self.assertEqual(self.inventory(), before)
                raw_envelopes.append(response.data)
        self.assertEqual((self.reader_calls, self.api_calls), (6, 6))
        output.parent.mkdir(parents=True, exist_ok=True)
        payload = b"[" + b",".join(raw_envelopes) + b"]\n"
        output.write_bytes(payload)
        self.assertEqual(output.read_bytes(), payload)

    @allocation(reads=14, api=4)
    def test_exact_page_envelope_and_flask_budgets(self):
        for name, source_id, expected_id, added_bytes in (
                ("null", True, None, 26),
                ("maximum_string", "9223372036854775807", "9223372036854775807", 43)):
            with self.subTest(case=name):
                self.write_logs(twitter=({"agent_id": 0, "agent_name": "Saved 雪",
                    "action_type": "LIKE_POST", "action_args": {"post_id": source_id}},))
                before = self.inventory()
                data = self.read(platform="twitter", limit=50)
                row = data["actions"][0]
                self.assertEqual(row["referenced_post_id"], expected_id)
                without_projection = {key: value for key, value in row.items() if key != "referenced_post_id"}
                self.assertEqual(len(encoded(row)) - len(encoded(without_projection)), added_bytes)
                page_size = len(encoded(data["actions"]))
                envelope_size = len(encoded({"success": True, "data": data}))
                self.assertEqual(page_size, len(encoded(row)) + 2)

                with patch.object(pages, "MAX_PAGE_BYTES", page_size):
                    self.assertEqual(self.read(platform="twitter", limit=50), data)
                with patch.object(pages, "MAX_PAGE_BYTES", page_size - 1):
                    self.assert_error("response_too_large", 413,
                                      call=lambda: self.read(platform="twitter", limit=50))
                with patch.object(pages, "MAX_RESPONSE_BYTES", envelope_size):
                    self.assertEqual(self.read(platform="twitter", limit=50), data)
                with patch.object(pages, "MAX_RESPONSE_BYTES", envelope_size - 1):
                    self.assert_error("response_too_large", 413,
                                      call=lambda: self.read(platform="twitter", limit=50))

                # One legal JSON whitespace byte makes the real Flask output
                # larger than the reader's compact envelope. Both actual reader
                # calls pass its cap; the route itself enforces this boundary.
                original_dumps = self.app.json.dumps
                def append_space(value, **kwargs):
                    serialized = original_dumps(value, **kwargs)
                    return serialized + " " if value.get("success") is True else serialized

                with patch.object(self.app.json, "dumps", side_effect=append_space) as serializer, \
                        patch.object(pages, "MAX_RESPONSE_BYTES", envelope_size + 1):
                    response = self.request_activity("twitter")
                    self.assertEqual(self.assert_http_success(response), data)
                    self.assertEqual(response.data, encoded({"success": True, "data": data}) + b" ")
                    self.assertEqual(len(response.data), envelope_size + 1)
                    self.assertEqual(serializer.call_count, 1)
                with patch.object(self.app.json, "dumps", side_effect=append_space) as serializer, \
                        patch.object(pages, "MAX_RESPONSE_BYTES", envelope_size):
                    self.assert_http_budget_error(self.request_activity("twitter"))
                    self.assertEqual(serializer.call_count, 2)
                    self.assertIs(serializer.call_args_list[0].args[0]["success"], True)
                    self.assertIs(serializer.call_args_list[1].args[0]["success"], False)
                self.assertEqual(self.inventory(), before)
