"""Outline-only regressions using the real LLM client and local gateway guard.

Only retrieved context and provider responses are synthetic. This file needs
neither a historical checkout nor the private qualification harness.
"""
from copy import deepcopy
import json
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
VALID_OUTLINE = {"title": "Transit pilot findings", "summary": "Synthetic findings.",
                 "sections": [{"title": "Recorded reactions"}, {"title": "Risks"}]}
FALLBACK_TITLES = ["预测场景与核心发现", "人群行为预测分析", "趋势展望与风险提示"]


def text_of_length(length, unit):
    return (unit * (length // len(unit) + 1))[:length]


class ExplicitFormatError(Exception):
    status_code = 400
    body = {"error": {"param": "response_format", "code": "unsupported_parameter"}}


class OtherParameterError(Exception):
    status_code = 400
    body = {"error": {"param": "model", "code": "unsupported_parameter"}}


class OutlineBudgetFixture(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.multiple(
            Config, LOCAL_MODE=True, LOCAL_MAX_INPUT_CHARS=24000,
            LOCAL_MAX_OUTPUT_TOKENS=2048, LOCAL_REASONING_EFFORT="none",
            LLM_MODEL_NAME="configured-default-is-not-the-instance-model",
        ))
        self.addCleanup(set_locale, get_locale())
        set_locale("en")
        self.context = {
            "graph_statistics": {"total_nodes": 10, "total_edges": 10,
                                 "entity_types": {"Person": 8, "Organization": 2}},
            "total_entities": 10,
            "related_facts": [text_of_length(2000, f"Fact {i}: Residents discuss the transit pilot. ")
                              for i in range(10)],
        }
        self.client = LLMClient.__new__(LLMClient)
        self.client.model = "mirofish-local"
        self.client.client = SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=self.completion),
        ))
        self.agent = report_module.ReportAgent(
            "synthetic_graph", "synthetic_sim",
            text_of_length(3500, "Assess transit pilot groups, rollout and comparisons. "),
            llm_client=self.client,
            zep_tools=SimpleNamespace(get_simulation_context=self.retrieve),
        )
        self.reset()

    def reset(self, outcomes=None):
        self.raw, self.forwarded, self.retrievals, self.progress, self.refusals = [], [], [], [], []
        self.outcomes = list(outcomes if outcomes is not None else [json.dumps(VALID_OUTLINE)])

    def retrieve(self, **kwargs):
        self.retrievals.append(deepcopy(kwargs))
        self.assertEqual(len(self.retrievals), 1)
        return self.context

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

    def values(self):
        statistics = self.context["graph_statistics"]
        return dict(simulation_requirement=self.agent.simulation_requirement,
                    total_nodes=statistics["total_nodes"], total_edges=statistics["total_edges"],
                    entity_types=list(statistics["entity_types"]),
                    total_entities=self.context["total_entities"])

    def messages(self, count=10):
        return [
            {"role": "system", "content": report_module.PLAN_SYSTEM_PROMPT + "\n\n" + get_language_instruction()},
            {"role": "user", "content": report_module.PLAN_USER_PROMPT_TEMPLATE.format(
                **self.values(), related_facts_json=json.dumps(
                    self.context["related_facts"][:10][:count], ensure_ascii=False, indent=2),
            )},
        ]

    def envelope(self, count=10):
        return build_chat_completion_kwargs(
            model=self.client.model, messages=self.messages(count), temperature=0.3,
            max_tokens=4096, response_format={"type": "json_object"},
        )

    def completion(self, **request):
        self.raw.append(deepcopy(request))
        self.assertLessEqual(len(self.raw), 2)
        try:
            admitted = (gateway._prepare_payload(CHAT_PATH, request, self.settings())
                        if Config.LOCAL_MODE else deepcopy(request))
        except gateway._GatewayError as error:
            self.refusals.append({"status": error.status, "message": str(error)})
            raise
        self.forwarded.append(deepcopy(admitted))
        self.assertLessEqual(len(self.forwarded), len(self.outcomes))
        outcome = self.outcomes[len(self.forwarded) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        content, finish = outcome if isinstance(outcome, tuple) else (outcome, "stop")
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=content), finish_reason=finish,
        )])

    def run_outline(self):
        return self.agent.plan_outline(progress_callback=lambda *args: self.progress.append(args))

    def assert_success(self, result, prefix):
        self.assertEqual(result.title, VALID_OUTLINE["title"])
        self.assertEqual(result.summary, VALID_OUTLINE["summary"])
        self.assertEqual([section.title for section in result.sections],
                         [section["title"] for section in VALID_OUTLINE["sections"]])
        self.assertEqual(self.raw[0], self.envelope(prefix))
        self.assertEqual(self.retrievals, [{"graph_id": self.agent.graph_id,
                                         "simulation_requirement": self.agent.simulation_requirement}])
        self.assertEqual([event[1] for event in self.progress], [0, 30, 80, 100])

    def assert_fallback(self, result):
        self.assertEqual(result.title, "未来预测报告")
        self.assertEqual(result.summary, "基于模拟预测的未来趋势与风险分析")
        self.assertEqual([section.title for section in result.sections], FALLBACK_TITLES)
        self.assertEqual(len(self.retrievals), 1)
        self.assertEqual([event[1] for event in self.progress], [0, 30])

    def fit(self, messages):
        return self.agent._fit_local_outline_messages(
            messages, self.context["related_facts"][:10], self.values(),
        )

    def print_witness(self, label):
        print(label + " " + json.dumps({
            "raw_requests": self.raw, "admitted_requests": self.forwarded,
            "request_charges": [self.size(request) for request in self.raw],
            "retrieval_count": len(self.retrievals),
            "attempted_completions": len(self.raw),
            "provider_forwarded_completions": len(self.forwarded),
            "gateway_refusals": self.refusals,
        }, ensure_ascii=False), flush=True)


class LocalOutlineBudgetRegression(OutlineBudgetFixture):
    def test_default_budget_keeps_nine_complete_facts_and_all_fixed_content(self):
        original = deepcopy(self.context)
        requirement = self.agent.simulation_requirement
        self.assertEqual(self.size(self.envelope(10)), 24712)
        self.assertEqual(self.size(self.envelope(9)), 22706)
        self.assertEqual(self.size(self.envelope(0)), 4652)
        with patch.object(self.agent, "_fit_local_section_messages",
                          side_effect=AssertionError("outline used the section fitter")):
            self.assert_success(self.run_outline(), 9)
        self.assertEqual(self.context, original)
        self.assertEqual(self.agent.simulation_requirement, requirement)
        self.assertEqual(len(self.raw), 1)
        self.assertEqual(len(self.forwarded), 1)
        self.print_witness("CANDIDATE_OUTLINE_WITNESS")

    def test_exact_limit_keeps_original_ten_fact_request(self):
        self.agent.simulation_requirement = self.agent.simulation_requirement[:2788]
        messages = self.messages()
        self.assertEqual(self.size(self.envelope()), 24000)
        self.assertIs(self.fit(messages), messages)
        self.assert_success(self.run_outline(), 10)
        self.assertEqual(len(self.forwarded), 1)

    def test_one_over_limit_omits_only_last_complete_fact(self):
        self.agent.simulation_requirement = self.agent.simulation_requirement[:2789]
        self.assertEqual(self.size(self.envelope()), 24001)
        self.assert_success(self.run_outline(), 9)
        self.assertEqual(self.size(self.raw[0]), 21995)

    def test_largest_prefix_uses_only_the_original_first_ten(self):
        self.context["related_facts"] = [text_of_length(4000, f"Fact {i}. ") for i in range(12)]
        self.assert_success(self.run_outline(), 4)
        self.assertLessEqual(self.size(self.envelope(4)), 24000)
        self.assertGreater(self.size(self.envelope(5)), 24000)

    def test_escaped_unicode_facts_keep_order_and_verbatim_content_in_both_locales(self):
        self.context["related_facts"] = [text_of_length(2500, f'Fact {i}: "世界🙂" \\ \n e\u0301 ')
                                         for i in range(10)]
        original = deepcopy(self.context)
        for locale in ("en", "zh"):
            with self.subTest(locale=locale):
                set_locale(locale)
                self.reset()
                expected = max(count for count in range(11)
                               if self.size(self.envelope(count)) <= 24000)
                self.assertLess(expected, 10)
                self.assertGreater(expected, 0)
                self.assert_success(self.run_outline(), expected)
                self.assertEqual(self.context, original)
                self.assertGreater(len(self.raw[0]["messages"][1]["content"].encode("utf-8")),
                                   len(self.raw[0]["messages"][1]["content"]))

    def test_oversized_first_fact_requires_empty_prefix_without_skipping_ahead(self):
        self.context["related_facts"] = ["A" * 25000, "Small later fact."]
        original = deepcopy(self.context)
        self.assert_success(self.run_outline(), 0)
        self.assertEqual(self.context, original)
        self.assertEqual(len(self.forwarded), 1)

    def test_fixed_content_overflow_preserves_original_refusal_with_facts(self):
        self.agent.simulation_requirement = "R" * 22849
        self.assertEqual(self.size(self.envelope(0)), 24001)
        original = self.envelope()
        with self.assertLogs(report_module.logger, "ERROR") as logged:
            self.assert_fallback(self.run_outline())
        self.assertIn("Input exceeds", "\n".join(logged.output))
        self.assertEqual(self.raw, [original])
        self.assertEqual(self.forwarded, [])

    def test_no_facts_preserves_success_and_fixed_content_refusal_without_sizing(self):
        self.context["related_facts"] = []
        for length, succeeds in ((3500, True), (22849, False)):
            with self.subTest(length=length):
                self.agent.simulation_requirement = "R" * length
                self.reset()
                with patch.object(gateway, "_normalize_payload", wraps=gateway._normalize_payload) as normalize:
                    result = self.run_outline()
                self.assertEqual(normalize.call_count, 1)  # The actual guard only.
                self.assertEqual(self.raw, [self.envelope(0)])
                if succeeds:
                    self.assert_success(result, 0)
                else:
                    self.assert_fallback(result)
                    self.assertEqual(self.size(self.raw[0]), 24001)
                    self.assertEqual(self.forwarded, [])
        messages = self.messages(0)
        with patch.object(gateway, "_normalize_payload", side_effect=AssertionError("no-fact sizing")):
            self.assertIs(self.fit(messages), messages)

    def test_cloud_bypasses_sizing_and_preserves_original_request(self):
        with patch.object(Config, "LOCAL_MODE", False), patch.object(
                gateway, "_normalize_payload", side_effect=AssertionError("cloud sizing")):
            messages = self.messages()
            self.assertIs(self.fit(messages), messages)
            self.assert_success(self.run_outline(), 10)
        self.assertEqual(len(self.forwarded), 1)

    def test_custom_client_and_llm_subclass_bypass_sizing(self):
        custom_calls = []
        custom = SimpleNamespace(chat_json=lambda **kwargs: (custom_calls.append(deepcopy(kwargs))
                                                            or deepcopy(VALID_OUTLINE)))
        with patch.object(self.agent, "llm", custom), patch.object(
                gateway, "_normalize_payload", side_effect=AssertionError("custom sizing")):
            messages = self.messages()
            self.assertIs(self.fit(messages), messages)
            result = self.run_outline()
        self.assertEqual(result.title, VALID_OUTLINE["title"])
        self.assertEqual(custom_calls, [{"messages": self.messages(), "temperature": 0.3}])
        self.assertEqual(len(self.retrievals), 1)
        self.assertEqual(self.raw, [])

        class AlternateClient(LLMClient):
            pass

        subclass = AlternateClient.__new__(AlternateClient)
        subclass.model, subclass.client = self.client.model, self.client.client
        self.reset()
        with patch.object(self.agent, "llm", subclass), patch.object(
                gateway, "_normalize_payload", wraps=gateway._normalize_payload) as normalize:
            self.assert_fallback(self.run_outline())
        self.assertEqual(normalize.call_count, 1)
        self.assertEqual(self.raw, [self.envelope()])
        self.assertEqual(self.forwarded, [])

    def test_already_fitting_request_retains_identity_and_original_envelope(self):
        self.context["related_facts"] = ["One complete fact.", "Another complete fact."]
        messages = self.messages()
        before = deepcopy(messages)
        self.assertIs(self.fit(messages), messages)
        self.assertEqual(messages, before)
        self.assert_success(self.run_outline(), 2)
        self.assertEqual(len(self.forwarded), 1)

    def test_fitted_view_does_not_mutate_canonical_messages_or_fixed_values(self):
        messages, values = self.messages(), self.values()
        before_messages, before_values = deepcopy(messages), deepcopy(values)
        view = self.agent._fit_local_outline_messages(messages, self.context["related_facts"][:10], values)
        self.assertIsNot(view, messages)
        self.assertIs(view[0], messages[0])
        self.assertIsNot(view[1], messages[1])
        self.assertEqual(view, self.messages(9))
        self.assertEqual(messages, before_messages)
        self.assertEqual(values, before_values)

    def test_actual_model_and_nondefault_normalization_settings_bind_the_envelope(self):
        self.client.model = "  gpt-5-local  "
        with patch.multiple(Config, LOCAL_MAX_OUTPUT_TOKENS=333, LOCAL_REASONING_EFFORT="medium"):
            self.assert_success(self.run_outline(), 9)
            request = self.raw[0]
            self.assertEqual(request["model"], self.client.model)
            self.assertNotEqual(request["model"], Config.LLM_MODEL_NAME)
            self.assertNotIn("temperature", request)
            self.assertNotIn("max_tokens", request)
            self.assertEqual(request["max_completion_tokens"], 4096)
            self.assertEqual(self.forwarded[0]["model"], "gpt-5-local")
            self.assertEqual(self.forwarded[0]["max_completion_tokens"], 333)
            self.assertEqual(self.forwarded[0]["reasoning_effort"], "medium")
            self.assertEqual(self.forwarded[0], self.normalize(request))
            self.assertLessEqual(self.size(self.envelope(9)), 24000)
            self.assertGreater(self.size(self.envelope(10)), 24000)

    def test_json_envelope_counts_before_the_existing_capability_retry(self):
        self.agent.simulation_requirement = self.agent.simulation_requirement[:2808]
        self.assertEqual(self.size(self.envelope()), 24020)
        without_json = self.envelope()
        without_json.pop("response_format")
        self.assertEqual(self.size(without_json), 23990)
        self.reset([ExplicitFormatError("unsupported response_format"), json.dumps(VALID_OUTLINE)])
        self.assert_success(self.run_outline(), 9)
        self.assertEqual(len(self.raw), 2)
        self.assertEqual(len(self.forwarded), 2)
        expected_retry = deepcopy(self.raw[0])
        expected_retry.pop("response_format")
        self.assertEqual(self.raw[1], expected_retry)
        self.assertEqual(self.size(self.raw[0]) - self.size(self.raw[1]), 30)
        self.assertEqual(len(self.retrievals), 1)

    def test_provider_error_uses_existing_fallback_without_retry(self):
        for error in (RuntimeError("Synthetic provider failure"), OtherParameterError("Unsupported model")):
            with self.subTest(error=type(error).__name__):
                self.reset([error])
                self.assert_fallback(self.run_outline())
                self.assertEqual(self.raw, [self.envelope(9)])
                self.assertEqual(len(self.forwarded), 1)

    def test_parse_and_length_errors_use_existing_single_attempt_fallback(self):
        for outcome in ("not JSON", (json.dumps(VALID_OUTLINE), "length"), "[]"):
            with self.subTest(outcome=outcome):
                self.reset([outcome])
                self.assert_fallback(self.run_outline())
                self.assertEqual(self.raw, [self.envelope(9)])
                self.assertEqual(len(self.forwarded), 1)

    def test_fitting_normalization_error_reaches_existing_fallback_before_completion(self):
        with patch.object(gateway, "_normalize_payload", side_effect=ValueError("Synthetic normalization error")):
            with self.assertLogs(report_module.logger, "ERROR") as logged:
                self.assert_fallback(self.run_outline())
        self.assertIn("Synthetic normalization error", "\n".join(logged.output))
        self.assertEqual(self.raw, [])
        self.assertEqual(self.forwarded, [])

    def test_retrieval_failure_retains_its_existing_precompletion_error_boundary(self):
        with patch.object(self.agent.zep_tools, "get_simulation_context", side_effect=ValueError("Retrieval failed")):
            with self.assertRaisesRegex(ValueError, "Retrieval failed"):
                self.run_outline()
        self.assertEqual(self.raw, [])
        self.assertEqual([event[1] for event in self.progress], [0])


if __name__ == "__main__":
    unittest.main()
