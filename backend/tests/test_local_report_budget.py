"""Section-budget regressions through the real loop, LLM client and gateway guard.

The provider completion and tool execution boundaries return finite synthetic
data. No model, gateway server, database or historical checkout is needed.
"""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.config import Config
from app.local_runtime import gateway
from app.services import report_agent as report_module
from app.utils.llm_client import LLMClient
from app.utils.locale import get_language_instruction, get_locale, set_locale
from app.utils.openai_chat_compat import build_chat_completion_kwargs


CHAT_PATH = "/v1/chat/completions"
SEPARATOR = "\n\n---\n\n"
REQUIREMENT = "Describe predicted community responses to a proposed transport policy."
FINAL = "Final Answer: The synthetic community response requires further review."
TOOLS = ("quick_search", "panorama_search", "insight_forge", "interview_agents", "quick_search")


def text_of_length(length, unit="Alpha世界🙂e\u03010123456789"):
    return (unit * (length // len(unit) + 1))[:length]


def tool_response(name):
    return "<tool_call>\n" + json.dumps({
        "name": name, "parameters": {"query": "public response"},
    }) + "\n</tool_call>"


class ReportBudgetFixture(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.multiple(
            Config, LOCAL_MODE=True, LOCAL_MAX_INPUT_CHARS=24000,
            LOCAL_MAX_OUTPUT_TOKENS=2048, LOCAL_REASONING_EFFORT="none",
            LLM_MODEL_NAME="configured-default-is-not-the-instance-model",
        ))
        self.addCleanup(set_locale, get_locale())
        set_locale("en")
        self.previous = [f"## Prior section {index}\n\n" + text_of_length(5000)
                         for index in range(1, 5)]
        self.section = report_module.ReportSection(title="Risks and next steps")
        self.outline = report_module.ReportOutline(
            title="Local policy simulation",
            summary="Compare predicted public reactions and risks.",
            sections=[self.section],
        )
        self.client = LLMClient.__new__(LLMClient)
        self.client.model = "mirofish-local"
        self.client.client = SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=self.completion),
        ))
        self.agent = report_module.ReportAgent(
            "synthetic_graph", "synthetic_sim", REQUIREMENT,
            llm_client=self.client, zep_tools=object(),
        )
        self.enterContext(patch.object(self.agent, "_execute_tool", side_effect=self.tool))
        self.reset()

    def reset(self, outcomes=None, observation_lengths=None):
        self.raw, self.forwarded, self.tool_calls, self.observations = [], [], [], []
        self.outcomes = list(outcomes if outcomes is not None else
                             [*(tool_response(name) for name in TOOLS[:3]), FINAL])
        self.observation_lengths = list(observation_lengths or [1000] * 5)

    def settings(self):
        return gateway.GatewaySettings(
            "http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1",
            max_input_chars=Config.LOCAL_MAX_INPUT_CHARS,
            max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
            reasoning_effort=Config.LOCAL_REASONING_EFFORT,
        )

    def normalize(self, request):
        return gateway._normalize_payload(
            CHAT_PATH, request, max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
            reasoning_effort=Config.LOCAL_REASONING_EFFORT,
        )

    def size(self, request):
        return gateway._input_size(self.normalize(request))

    def envelope(self, messages):
        return build_chat_completion_kwargs(
            model=self.client.model, messages=messages, temperature=0.5, max_tokens=4096,
        )

    def completion(self, **request):
        self.raw.append(deepcopy(request))
        self.assertLessEqual(len(self.raw), 12)
        admitted = (gateway._prepare_payload(CHAT_PATH, request, self.settings())
                    if Config.LOCAL_MODE else deepcopy(request))
        self.forwarded.append(deepcopy(admitted))
        self.assertLessEqual(len(self.forwarded), len(self.outcomes))
        outcome = self.outcomes[len(self.forwarded) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=outcome), finish_reason="stop",
        )])

    def tool(self, name, parameters, report_context=None):
        self.tool_calls.append((name, deepcopy(parameters), report_context))
        index = len(self.tool_calls) - 1
        self.assertLess(index, len(self.observation_lengths))
        result = text_of_length(self.observation_lengths[index], f"Evidence {index}: 世界🙂e\u0301 ")
        self.observations.append(result)
        return result

    def run_section(self, previous=None):
        return self.agent._generate_section_react(
            self.section, self.outline, self.previous if previous is None else previous,
        )

    def cloud_reference(self, previous=None, outcomes=None, observation_lengths=None):
        self.reset(outcomes, observation_lengths)
        with patch.object(Config, "LOCAL_MODE", False):
            answer = self.run_section(previous)
        reference = deepcopy(self.raw)
        self.reset(outcomes, observation_lengths)
        return answer, reference

    def fit(self, messages, previous=None):
        return self.agent._fit_local_section_messages(
            messages, self.previous if previous is None else previous,
            self.section.title, temperature=0.5, max_tokens=4096,
        )

    def initial_messages(self, previous=None):
        _, requests = self.cloud_reference(previous)
        return requests[0]["messages"]

    def with_context(self, messages, context):
        value = deepcopy(messages)
        value[1]["content"] = report_module.SECTION_USER_PROMPT_TEMPLATE.format(
            previous_content=context, section_title=self.section.title,
        )
        return value

    def context(self, messages):
        before, after = report_module.SECTION_USER_PROMPT_TEMPLATE.format(
            previous_content="EXCERPT_SLOT", section_title=self.section.title,
        ).split("EXCERPT_SLOT")
        content = messages[1]["content"]
        self.assertTrue(content.startswith(before) and content.endswith(after))
        return content[len(before):len(content) - len(after)] if after else content[len(before):]

    def assert_only_excerpts_changed(self, reference):
        self.assertEqual(len(self.raw), len(reference))
        for actual, original in zip(self.raw, reference):
            adjusted = deepcopy(actual)
            adjusted["messages"][1] = deepcopy(original["messages"][1])
            self.assertEqual(adjusted, original)
            self.assertLessEqual(self.size(actual), Config.LOCAL_MAX_INPUT_CHARS)
        for index, observation in enumerate(self.observations):
            self.assertIn(observation, self.raw[-1]["messages"][3 + index * 2]["content"])


class LocalReportBudgetRegression(ReportBudgetFixture):
    def test_initial_overflow_fits_without_shortening_the_complete_requirement(self):
        self.agent.simulation_requirement = text_of_length(3000)
        answer, reference = self.cloud_reference()
        self.assertEqual(self.size(reference[0]), 24340)
        self.assertEqual(self.run_section(), answer)
        self.assertEqual(len(self.forwarded), 4)
        self.assertIn(self.agent.simulation_requirement, self.raw[0]["messages"][0]["content"])
        self.assert_only_excerpts_changed(reference)

    def test_default_budget_completes_three_tools_after_initial_request_fits(self):
        answer, reference = self.cloud_reference()
        self.assertLessEqual(self.size(reference[0]), 24000)
        self.assertLessEqual(self.size(reference[1]), 24000)
        self.assertGreater(self.size(reference[2]), 24000)
        previous = deepcopy(self.previous)
        self.assertEqual(self.run_section(), answer)
        self.assertEqual(self.previous, previous)
        self.assertEqual(len(self.forwarded), 4)
        self.assertEqual([call[0] for call in self.tool_calls], list(TOOLS[:3]))
        self.assertEqual(self.raw[:2], reference[:2])
        self.assert_only_excerpts_changed(reference)

    def test_both_locales_preserve_complete_unicode_evidence_and_fixed_prompts(self):
        for locale in ("en", "zh"):
            with self.subTest(locale=locale):
                set_locale(locale)
                answer, reference = self.cloud_reference()
                self.assertEqual(self.run_section(), answer)
                self.assert_only_excerpts_changed(reference)
                self.assertIn(REQUIREMENT, self.raw[-1]["messages"][0]["content"])
                self.assertGreater(len(self.context(self.raw[-1]["messages"]).encode("utf-8")),
                                   len(self.context(self.raw[-1]["messages"])))

    def test_canonical_messages_and_original_sections_survive_each_fitted_view(self):
        _, reference = self.cloud_reference()
        canonical = []
        original_fit = self.agent._fit_local_section_messages
        def capture(messages, *args, **kwargs):
            before = deepcopy(messages)
            view = original_fit(messages, *args, **kwargs)
            self.assertEqual(messages, before)
            canonical.append(messages)
            if view is not messages:
                self.assertIsNot(view[1], messages[1])
                for index in [0, *range(2, len(messages))]:
                    self.assertIs(view[index], messages[index])
            return view
        with patch.object(self.agent, "_fit_local_section_messages", side_effect=capture):
            self.run_section()
        self.assertEqual(len({id(value) for value in canonical}), 1)
        self.assertEqual(canonical[-1], reference[-1]["messages"])
        self.assert_only_excerpts_changed(reference)

    def test_common_cap_keeps_short_empty_and_long_section_slots(self):
        previous = ["Short", "", text_of_length(5000), text_of_length(4001), "尾"]
        messages = self.initial_messages(previous)
        fixed = self.size(self.envelope(self.with_context(messages, SEPARATOR * 4)))
        with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", fixed + 5 + 5 + 2 * (7 + 5) + 1 + 5):
            fitted = self.fit(messages, previous)
            self.assertEqual(self.context(fitted).split(SEPARATOR),
                             ["Short", "", previous[2][:7] + "...", previous[3][:7] + "...", "尾"])
            self.assertLessEqual(self.size(self.envelope(fitted)), Config.LOCAL_MAX_INPUT_CHARS)
            self.assertEqual(messages, self.initial_messages(previous))

    def test_zero_and_one_caps_use_markers_without_first_section_placeholder(self):
        previous = ["abcdef" * 20, "", "世界🙂e\u0301" * 20]
        messages = self.initial_messages(previous)
        fixed = self.size(self.envelope(self.with_context(messages, SEPARATOR * 2)))
        for cap, expected in ((0, ["[...]", "", "[...]"]), (1, ["a...", "", "世..."])):
            with self.subTest(cap=cap), patch.object(Config, "LOCAL_MAX_INPUT_CHARS", fixed + 2 * (cap + 5)):
                fitted = self.fit(messages, previous)
                self.assertEqual(self.context(fitted), SEPARATOR.join(expected))
                self.assertNotIn("（这是第一个章节）", self.context(fitted))
                self.assertLessEqual(self.size(self.envelope(fitted)), Config.LOCAL_MAX_INPUT_CHARS)

    def test_completion_marker_disappears_and_charge_remains_conservative(self):
        previous = ["abc", text_of_length(100)]
        messages = self.initial_messages(previous)
        fixed = self.size(self.envelope(self.with_context(messages, SEPARATOR)))
        for cap, expected_first in ((2, "ab..."), (3, "abc"), (4, "abc")):
            with self.subTest(cap=cap), patch.object(Config, "LOCAL_MAX_INPUT_CHARS", fixed + min(3, cap) + cap + 10):
                fitted = self.fit(messages, previous)
                self.assertEqual(self.context(fitted).split(SEPARATOR),
                                 [expected_first, previous[1][:cap] + "..."])

    def test_original_3999_4000_4001_prefixes_and_exact_limit_are_unchanged(self):
        previous = [text_of_length(length) for length in (3999, 4000, 4001)]
        messages = self.initial_messages(previous)
        expected = SEPARATOR.join([previous[0], previous[1], previous[2][:4000] + "..."])
        self.assertEqual(self.context(messages), expected)
        limit = self.size(self.envelope(messages))
        with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", limit):
            self.assertIs(self.fit(messages, previous), messages)
        with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", limit - 1):
            fitted = self.fit(messages, previous)
            self.assertIsNot(fitted, messages)
            self.assertLessEqual(self.size(self.envelope(fitted)), limit - 1)
            parts = self.context(fitted).split(SEPARATOR)
            self.assertEqual(len(parts), 3)
            retained = [part[:-3] for part in parts]
            self.assertEqual(len({len(part) for part in retained}), 1)
            for original, prefix in zip(previous, retained):
                self.assertTrue(original.startswith(prefix))

    def test_cloud_fitting_local_and_nonstandard_clients_keep_original_messages(self):
        messages = self.initial_messages()
        with patch.object(Config, "LOCAL_MODE", False), patch.object(
                gateway, "_normalize_payload", side_effect=AssertionError("cloud normalized")):
            self.assertIs(self.fit(messages), messages)
        self.assertIs(self.fit(messages), messages)
        with patch.object(self.agent, "llm", SimpleNamespace(chat=lambda **kwargs: FINAL)):
            self.assertIs(self.fit(messages), messages)

    def test_actual_instance_model_reasoning_and_nondefault_limits_reach_guard(self):
        for model, reasoning in ((" local-override ", None), (" gpt-5-local ", "low")):
            with self.subTest(model=model), patch.object(self.client, "model", model), patch.multiple(
                    Config, LOCAL_MAX_INPUT_CHARS=11000, LOCAL_MAX_OUTPUT_TOKENS=77,
                    LOCAL_REASONING_EFFORT=reasoning):
                answer, reference = self.cloud_reference()
                self.assertEqual(self.run_section(), answer)
                self.assert_only_excerpts_changed(reference)
                for raw, admitted in zip(self.raw, self.forwarded):
                    self.assertEqual(raw["model"], model)
                    self.assertEqual(admitted["model"], model.strip())
                    key = "max_completion_tokens" if "gpt-5" in model else "max_tokens"
                    self.assertEqual(raw[key], 4096)
                    self.assertEqual(admitted[key], 77)
                    self.assertEqual("temperature" in raw, "gpt-5" not in model)
                    self.assertEqual(admitted.get("reasoning_effort"), reasoning)

    def test_five_tool_rounds_rebudget_the_forced_final_request(self):
        outcomes = [*(tool_response(name) for name in TOOLS), FINAL]
        answer, reference = self.cloud_reference(outcomes=outcomes)
        self.assertEqual(self.run_section(), answer)
        self.assertEqual(len(self.forwarded), 6)
        self.assertEqual(len(self.tool_calls), 5)
        self.assertEqual(self.raw[-1]["messages"][-1],
                         {"role": "user", "content": report_module.REACT_FORCE_FINAL_MSG})
        self.assert_only_excerpts_changed(reference)
        self.assertLess(len(self.context(self.raw[-1]["messages"])),
                        len(self.context(self.raw[-2]["messages"])))

    def test_format_correction_and_minimum_tool_prompt_remain_complete(self):
        scripts = [
            [tool_response(TOOLS[0]) + " Final Answer: premature", *(tool_response(name) for name in TOOLS[:3]), FINAL],
            ["Final Answer: premature", *(tool_response(name) for name in TOOLS[:3]), FINAL],
        ]
        for outcomes in scripts:
            with self.subTest(first=outcomes[0]):
                answer, reference = self.cloud_reference(outcomes=outcomes)
                self.assertEqual(self.run_section(), answer)
                self.assertEqual(len(self.tool_calls), 3)
                # A correction turn shifts observation positions, so compare the
                # entire history without using the ordinary-turn index helper.
                for raw, original in zip(self.raw, reference):
                    adjusted = deepcopy(raw)
                    adjusted["messages"][1] = original["messages"][1]
                    self.assertEqual(adjusted, original)
                    self.assertLessEqual(self.size(raw), 24000)
                for result in self.observations:
                    self.assertTrue(any(result in m["content"] for m in self.raw[-1]["messages"]))

    def test_no_previous_sections_preserve_placeholder_and_original_refusal(self):
        self.agent.simulation_requirement = text_of_length(25000)
        _, reference = self.cloud_reference(previous=[])
        with self.assertRaises(gateway._GatewayError) as error:
            self.run_section(previous=[])
        self.assertEqual(error.exception.status, 413)
        self.assertEqual(self.raw, reference[:1])
        self.assertEqual(self.forwarded, [])
        self.assertIn("（这是第一个章节）", self.context(self.raw[0]["messages"]))

    def test_accumulated_real_evidence_can_exhaust_even_zero_excerpt_budget(self):
        _, reference = self.cloud_reference(observation_lengths=[20000, 1000, 1000])
        with self.assertRaises(gateway._GatewayError) as error:
            self.run_section()
        self.assertEqual(error.exception.status, 413)
        self.assertEqual(len(self.forwarded), 1)
        self.assertEqual(len(self.tool_calls), 1)
        self.assertEqual(self.raw[-1], reference[1])
        self.assertIn(self.observations[0], self.raw[-1]["messages"][-1]["content"])

    def test_final_exact_recheck_refuses_an_unverified_candidate(self):
        self.agent.simulation_requirement = text_of_length(3000)
        messages = self.initial_messages()
        actual_size = gateway._input_size
        calls = []
        def changed_size(value):
            if isinstance(value, dict) and "messages" in value:
                calls.append(value)
                if len(calls) == 3:
                    return 24001
            return actual_size(value)
        with patch.object(gateway, "_input_size", side_effect=changed_size):
            self.assertIs(self.fit(messages), messages)
        self.assertEqual(len(calls), 3)
        with self.assertRaises(gateway._GatewayError):
            self.client.chat(messages, temperature=0.5, max_tokens=4096)
        self.assertEqual(self.forwarded, [])

    def test_normalization_errors_propagate_before_completion(self):
        with patch.object(gateway, "_normalize_payload", side_effect=ValueError("invalid fixture envelope")):
            with self.assertRaisesRegex(ValueError, "invalid fixture envelope"):
                self.run_section()
        self.assertEqual(self.raw, [])

    def test_forced_final_normalization_error_never_becomes_none_fallback(self):
        self.reset([*(tool_response(name) for name in TOOLS), FINAL])
        normalize = gateway._normalize_payload
        def reject_final(path, payload, **kwargs):
            if payload["messages"][-1]["content"] == report_module.REACT_FORCE_FINAL_MSG:
                raise ValueError("forced-final normalization failed")
            return normalize(path, payload, **kwargs)
        with patch.object(gateway, "_normalize_payload", side_effect=reject_final):
            with self.assertRaisesRegex(ValueError, "forced-final normalization failed"):
                self.run_section()
        self.assertEqual(len(self.forwarded), 5)
        self.assertEqual(len(self.tool_calls), 5)

    def test_generate_report_persists_failed_after_genuine_gateway_refusal(self):
        self.agent.simulation_requirement = text_of_length(25000)
        with tempfile.TemporaryDirectory(prefix="report-budget-") as folder, patch.object(
                report_module.ReportManager, "REPORTS_DIR", folder), patch.object(
                self.agent, "plan_outline", return_value=self.outline):
            report = self.agent.generate_report(report_id="report_budget_refusal")
            self.assertEqual(report.status, report_module.ReportStatus.FAILED)
            saved = json.loads((Path(folder) / report.report_id / "meta.json").read_text())
            self.assertEqual(saved["status"], "failed")
            self.assertFalse((Path(folder) / report.report_id / "full_report.md").exists())
            self.assertEqual(self.forwarded, [])

    def test_generate_report_persists_failed_after_fitting_exception(self):
        first = report_module.ReportSection(title="First")
        outline = report_module.ReportOutline("Title", "Summary", [first, self.section])
        self.reset([*(tool_response(name) for name in TOOLS[:3]), FINAL])
        normalize = gateway._normalize_payload
        def reject_second(path, payload, **kwargs):
            if "## First" in payload["messages"][1]["content"]:
                raise ValueError("section fitting failed")
            return normalize(path, payload, **kwargs)
        with tempfile.TemporaryDirectory(prefix="report-budget-") as folder, patch.object(
                report_module.ReportManager, "REPORTS_DIR", folder), patch.object(
                self.agent, "plan_outline", return_value=outline), patch.object(
                gateway, "_normalize_payload", side_effect=reject_second):
            report = self.agent.generate_report(report_id="report_budget_exception")
            self.assertEqual(report.status, report_module.ReportStatus.FAILED)
            self.assertEqual(report.error, "section fitting failed")
            self.assertEqual(len(self.forwarded), 4)
            self.assertEqual(first.content, FINAL.removeprefix("Final Answer: "))
            self.assertEqual(self.section.content, "")
            saved = json.loads((Path(folder) / report.report_id / "meta.json").read_text())
            self.assertEqual(saved["status"], "failed")
            self.assertFalse((Path(folder) / report.report_id / "full_report.md").exists())

    def test_outline_keeps_its_existing_context_and_completion_envelope(self):
        context = {"graph_statistics": {"total_nodes": 4, "total_edges": 3,
                                        "entity_types": {"Person": 4}},
                   "total_entities": 4, "related_facts": [f"Fact {i}" for i in range(12)]}
        self.reset([json.dumps({"title": "Outline", "summary": "Summary",
                                "sections": [{"title": "Section"}]})])
        with patch.object(self.agent, "zep_tools", SimpleNamespace(
                get_simulation_context=lambda **kwargs: context)), patch.object(
                self.agent, "_fit_local_section_messages", side_effect=AssertionError("outline used section fitter")):
            outline = self.agent.plan_outline()
        expected = build_chat_completion_kwargs(
            model=self.client.model,
            messages=[
                {"role": "system", "content": report_module.PLAN_SYSTEM_PROMPT + "\n\n" + get_language_instruction()},
                {"role": "user", "content": report_module.PLAN_USER_PROMPT_TEMPLATE.format(
                    simulation_requirement=REQUIREMENT, total_nodes=4, total_edges=3,
                    entity_types=["Person"], total_entities=4,
                    related_facts_json=json.dumps(context["related_facts"][:10], ensure_ascii=False, indent=2),
                )},
            ], temperature=0.3, max_tokens=4096, response_format={"type": "json_object"},
        )
        self.assertEqual(outline.title, "Outline")
        self.assertEqual(self.raw, [expected])
