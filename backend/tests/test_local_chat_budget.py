"""Report-chat budget regressions with the real client and local admission guard.

Saved text, quick-search results and provider responses are synthetic. This test
file is self-contained and does not need a historical checkout or gate runner.
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
MARKER = "\n\n... [报告内容已截断] ..."
QUESTION = "Which findings should I prioritize next?"
ANSWER = "Synthetic answer grounded in the captured text."
TOOL_RESPONSE = '<tool_call>{"name":"quick_search","parameters":{"query":"transit"}}</tool_call>'


def text_of_length(length, unit):
    return (unit * (length // len(unit) + 1))[:length]


class ChatBudgetFixture(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.multiple(
            Config, LOCAL_MODE=True, LOCAL_MAX_INPUT_CHARS=24000,
            LOCAL_MAX_OUTPUT_TOKENS=2048, LOCAL_REASONING_EFFORT="none",
            LLM_MODEL_NAME="configured-default-is-not-the-instance-model",
        ))
        self.addCleanup(set_locale, get_locale())
        set_locale("en")
        self.report = text_of_length(15000, "Saved transit evidence about distinct simulated groups. ")
        self.question = QUESTION
        self.history = [{"role": role, "content": text_of_length(1000, role + " recorded statement. ")}
                        for role in ("user", "assistant", "user", "assistant")]
        self.client = LLMClient.__new__(LLMClient)
        self.client.model = "mirofish-local"
        self.client.client = SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=self.completion)))
        self.agent = report_module.ReportAgent(
            "synthetic_graph", "synthetic_sim",
            text_of_length(3500, "Assess the transit proposal using recorded statements. "),
            llm_client=self.client, zep_tools=SimpleNamespace(quick_search=self.search),
        )
        self.reset()

    def reset(self, outcomes=None):
        self.raw, self.forwarded, self.refusals, self.searches = [], [], [], []
        self.outcomes = list(outcomes if outcomes is not None else [ANSWER])
        self.tool_result = text_of_length(2000, "Recorded observation with full captured wording. ")
        self.after_completion = None
        self.after_search = None

    def values(self):
        return dict(simulation_requirement=self.agent.simulation_requirement,
                    tools_description=self.agent._get_tools_description())

    def sample(self):
        return self.report[:15000] + (MARKER if len(self.report) > 15000 else "")

    def messages(self, report=None, *, extra=()):
        sample = self.sample() if report is None else report
        system = report_module.CHAT_SYSTEM_PROMPT_TEMPLATE.format(
            **self.values(), report_content=sample or "（暂无报告）") + "\n\n" + get_language_instruction()
        return [{"role": "system", "content": system}, *self.history[-10:],
                {"role": "user", "content": self.question}, *extra]

    def envelope(self, messages):
        return build_chat_completion_kwargs(model=self.client.model, messages=messages,
                                            temperature=0.5, max_tokens=4096)

    def normalize(self, request):
        return gateway._normalize_payload(CHAT_PATH, request,
            max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
            reasoning_effort=Config.LOCAL_REASONING_EFFORT)

    def size(self, messages):
        return gateway._input_size(self.normalize(self.envelope(messages)))

    def completion(self, **request):
        self.raw.append(deepcopy(request))
        self.assertLessEqual(len(self.raw), 3)
        settings = gateway.GatewaySettings(
            "http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1",
            max_input_chars=Config.LOCAL_MAX_INPUT_CHARS,
            max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
            reasoning_effort=Config.LOCAL_REASONING_EFFORT)
        try:
            admitted = (gateway._prepare_payload(CHAT_PATH, request, settings)
                        if Config.LOCAL_MODE else deepcopy(request))
        except gateway._GatewayError as error:
            self.refusals.append({"status": error.status, "message": str(error)})
            raise
        self.forwarded.append(deepcopy(admitted))
        self.assertLessEqual(len(self.forwarded), len(self.outcomes))
        outcome = self.outcomes[len(self.forwarded) - 1]
        if self.after_completion:
            self.after_completion(len(self.forwarded))
        if isinstance(outcome, Exception):
            raise outcome
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=outcome), finish_reason="stop")])

    def search(self, **kwargs):
        self.searches.append(deepcopy(kwargs))
        self.assertLessEqual(len(self.searches), 2)
        result = self.tool_result
        if self.after_search:
            self.after_search(len(self.searches))
        return SimpleNamespace(to_text=lambda: result)

    def extra(self, response=TOOL_RESPONSE, result=None):
        return [{"role": "assistant", "content": response}, {"role": "user", "content":
            "[quick_search结果]\n" + (self.tool_result if result is None else result)[:1500]
            + report_module.CHAT_OBSERVATION_SUFFIX}]

    def run_chat(self, *, legacy=False):
        if legacy:
            return self.agent.chat(self.question, self.history)
        return self.agent.chat(self.question, self.history, report_content=self.report)

    def fit(self, messages):
        return self.agent._fit_local_chat_messages(messages, self.sample(), self.values(),
                                                    get_language_instruction())

    def assert_fit(self, actual, canonical):
        """Independent expected length from the real fixed marker envelope."""
        sample = self.sample()
        original = deepcopy(canonical)
        fixed = deepcopy(canonical)
        fixed[0]["content"] = report_module.CHAT_SYSTEM_PROMPT_TEMPLATE.format(
            **self.values(), report_content=MARKER) + "\n\n" + get_language_instruction()
        count = Config.LOCAL_MAX_INPUT_CHARS - self.size(fixed)
        self.assertGreaterEqual(count, 0)
        self.assertLess(count, len(sample))
        expected = deepcopy(fixed)
        expected[0]["content"] = report_module.CHAT_SYSTEM_PROMPT_TEMPLATE.format(
            **self.values(), report_content=sample[:count] + MARKER) + "\n\n" + get_language_instruction()
        self.assertEqual(actual, self.envelope(expected))
        self.assertEqual(self.size(actual["messages"]), Config.LOCAL_MAX_INPUT_CHARS)
        # One additional report character, with the same full marker, must refuse.
        longer = deepcopy(expected)
        longer[0]["content"] = report_module.CHAT_SYSTEM_PROMPT_TEMPLATE.format(
            **self.values(), report_content=sample[:count + 1] + MARKER) + "\n\n" + get_language_instruction()
        self.assertEqual(self.size(longer), Config.LOCAL_MAX_INPUT_CHARS + 1)
        self.assertEqual(actual["messages"][1:], original[1:])
        self.assertEqual(canonical, original)
        return count

    def print_witness(self, label):
        print(label + " " + json.dumps({
            "raw_requests": self.raw, "admitted_requests": self.forwarded,
            "request_charges": [gateway._input_size(self.normalize(x)) for x in self.raw],
            "attempted_chat_completions": len(self.raw),
            "provider_forwarded_chat_completions": len(self.forwarded),
            "quick_search_calls": self.searches, "gateway_refusals": self.refusals,
        }, ensure_ascii=False), flush=True)


class LocalChatBudgetRegression(ChatBudgetFixture):
    def test_default_witness_keeps_largest_report_prefix_and_complete_fixed_content(self):
        canonical = self.messages()
        self.assertEqual(self.size(canonical), 24423)
        history, report = deepcopy(self.history), self.report
        result = self.run_chat()
        self.assertEqual(result, {"response": ANSWER, "tool_calls": [], "sources": []})
        self.assertEqual(self.assert_fit(self.raw[0], canonical), 14558)
        self.assertEqual(self.history, history)
        self.assertEqual(self.report, report)
        self.assertEqual(len(self.raw), 1)
        self.assertEqual(len(self.forwarded), 1)
        self.assertEqual(self.searches, [])
        self.print_witness("CANDIDATE_CHAT_WITNESS")

    def test_exact_boundary_preserves_original_and_one_over_adds_complete_marker(self):
        for overflow in (0, 1):
            with self.subTest(overflow=overflow):
                self.reset()
                self.agent.simulation_requirement = "R" * (3077 + overflow)
                canonical = self.messages()
                self.assertEqual(self.size(canonical), 24000 + overflow)
                if not overflow:
                    self.assertIs(self.fit(canonical), canonical)
                self.run_chat()
                if overflow:
                    self.assertEqual(self.assert_fit(self.raw[0], canonical), 14980)
                else:
                    self.assertEqual(self.raw[0], self.envelope(canonical))

    def test_short_exact_and_preclipped_reports_keep_only_the_captured_prefix(self):
        for length in (14999, 15000, 15001, 17000):
            with self.subTest(length=length):
                self.reset()
                self.report = text_of_length(length, "Recorded report text. ")
                canonical = self.messages()
                self.run_chat()
                self.assertEqual(self.assert_fit(self.raw[0], canonical), 14558)
                self.assertEqual(self.raw[0]["messages"][0]["content"].count(MARKER), 1)
                self.assertEqual(len(self.raw), 1)

    def test_fitting_preclipped_report_keeps_its_existing_marker_and_request(self):
        self.report += "UNSELECTED TAIL"
        self.agent.simulation_requirement = "Brief scenario"
        canonical = self.messages()
        self.assertIs(self.fit(canonical), canonical)
        self.run_chat()
        self.assertEqual(self.raw, [self.envelope(canonical)])
        self.assertNotIn("UNSELECTED TAIL", self.raw[0]["messages"][0]["content"])

    def test_escaped_unicode_prefixes_preserve_fixed_text_in_both_locales(self):
        self.report = text_of_length(17000, '报告 "quoted" \\ line\n🙂 e\u0301 ')
        self.question = 'Explain "报告" \\ and 🙂 e\u0301 without dropping evidence'
        for locale in ("en", "zh"):
            with self.subTest(locale=locale):
                set_locale(locale)
                self.reset()
                canonical = self.messages()
                self.run_chat()
                self.assert_fit(self.raw[0], canonical)
                system = self.raw[0]["messages"][0]["content"]
                self.assertGreater(len(system.encode("utf-8")), len(system))

    def test_zero_and_one_character_prefixes_keep_honest_marker(self):
        for count in (0, 1):
            with self.subTest(count=count):
                self.reset()
                limit = self.size(self.messages(MARKER)) + count
                with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", limit):
                    self.run_chat()
                    self.assertEqual(self.assert_fit(self.raw[0], self.messages()), count)
                    self.assertNotIn("（暂无报告）", self.raw[0]["messages"][0]["content"])

    def test_fixed_content_overflow_retains_original_gateway_refusal(self):
        limit = self.size(self.messages(MARKER)) - 1
        canonical = self.messages()
        with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", limit):
            self.assertIs(self.fit(canonical), canonical)
            with self.assertRaises(gateway._GatewayError) as caught:
                self.run_chat()
        self.assertEqual(caught.exception.status, 413)
        self.assertEqual(self.raw, [self.envelope(canonical)])
        self.assertEqual(self.forwarded, [])
        self.assertEqual(self.searches, [])

    def test_empty_explicit_and_missing_legacy_reports_preserve_placeholder(self):
        self.report = ""
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                self.reset()
                with patch.object(report_module.ReportManager, "get_report_by_simulation", return_value=None) as lookup:
                    with patch.object(gateway, "_normalize_payload", wraps=gateway._normalize_payload) as normalize:
                        self.run_chat(legacy=legacy)
                    self.assertEqual(normalize.call_count, 1)  # Gateway admission only.
                    self.assertEqual(lookup.call_count, int(legacy))
                self.assertEqual(self.raw, [self.envelope(self.messages())])
                self.assertIn("（暂无报告）", self.raw[0]["messages"][0]["content"])

    def test_empty_report_with_large_history_keeps_existing_refusal(self):
        self.report = ""
        self.history = [{"role": "user", "content": "H" * 30000}]
        with self.assertRaises(gateway._GatewayError) as caught:
            self.run_chat()
        self.assertEqual(caught.exception.status, 413)
        self.assertEqual(self.raw, [self.envelope(self.messages())])
        self.assertEqual(self.forwarded, [])

    def test_cloud_request_bypasses_fitting_and_keeps_original_envelope(self):
        canonical = self.messages()
        with patch.object(Config, "LOCAL_MODE", False), patch.object(
                gateway, "_normalize_payload", side_effect=AssertionError("cloud normalized")):
            self.assertIs(self.fit(canonical), canonical)
            self.run_chat()
        self.assertEqual(self.raw, [self.envelope(canonical)])
        self.assertEqual(self.forwarded, self.raw)

    def test_custom_client_and_standard_client_subclass_bypass_fitting(self):
        class ClientSubclass(LLMClient):
            pass
        for client in (SimpleNamespace(), ClientSubclass.__new__(ClientSubclass)):
            with self.subTest(client=type(client).__name__):
                seen = []
                client.chat = lambda **kwargs: seen.append(deepcopy(kwargs)) or ANSWER
                with patch.object(self.agent, "llm", client), patch.object(
                        gateway, "_normalize_payload", side_effect=AssertionError("custom normalized")):
                    canonical = self.messages()
                    self.assertIs(self.fit(canonical), canonical)
                    self.run_chat()
                self.assertEqual(seen, [{"messages": canonical, "temperature": 0.5}])

    def test_all_three_completion_views_preserve_canonical_messages_and_observations(self):
        self.reset([TOOL_RESPONSE, TOOL_RESPONSE, ANSWER])
        original_report, history = self.report, deepcopy(self.history)
        original_messages = self.messages()
        canonical_views, original_samples, normalizations = [], [], []
        fitter = self.agent._fit_local_chat_messages
        real_normalize = gateway._normalize_payload
        def captured(messages, sample, values, instruction):
            canonical_views.append(deepcopy(messages))
            original_samples.append(sample)
            before = deepcopy(messages)
            result = fitter(messages, sample, values, instruction)
            self.assertEqual(messages, before)
            return result
        def normalized(*args, **kwargs):
            normalizations.append(1)
            return real_normalize(*args, **kwargs)
        with patch.object(self.agent, "_fit_local_chat_messages", side_effect=captured), patch.object(
                gateway, "_normalize_payload", side_effect=normalized):
            result = self.run_chat()
        self.assertEqual(len(self.raw), 3)
        self.assertEqual(len(self.forwarded), 3)
        self.assertEqual(len(self.searches), 2)
        self.assertLessEqual(len(normalizations), 12)  # Three fitter checks plus admission per request.
        self.assertEqual(original_samples, [original_report] * 3)
        prefixes = []
        for index in range(3):
            expected = original_messages + self.extra() * index
            self.assertEqual(canonical_views[index], expected)
            prefixes.append(self.assert_fit(self.raw[index], expected))
        self.assertGreater(prefixes[0], prefixes[1])
        self.assertGreater(prefixes[1], prefixes[2])
        self.assertEqual(self.history, history)
        self.assertEqual(self.report, original_report)
        self.assertEqual(result["sources"], ["transit", "transit"])
        self.assertEqual(result["response"], ANSWER)
        self.print_witness("CANDIDATE_CHAT_TOOL_ACCUMULATION")

    def test_later_views_reuse_captured_scenario_tools_language_and_report(self):
        self.reset([TOOL_RESPONSE, TOOL_RESPONSE, ANSWER])
        original = self.messages()
        saved = SimpleNamespace(markdown_content=self.report)
        lookup_calls = []
        def lookup(simulation):
            lookup_calls.append(simulation)
            return saved
        def change(_):
            saved.markdown_content = "A different saved report"
            self.agent.simulation_requirement = "Changed after capture"
            self.agent.tools = {}
            set_locale("zh")
        self.after_search = change
        with patch.object(report_module.ReportManager, "get_report_by_simulation", side_effect=lookup):
            self.run_chat(legacy=True)
        self.assertEqual(lookup_calls, [self.agent.simulation_id])
        for request in self.raw:
            system = request["messages"][0]["content"]
            self.assertNotIn("A different saved report", system)
            self.assertNotIn("Changed after capture", system)
            # Fixed suffix must retain all originally captured tools and language.
            self.assertEqual(system.split("【规则】", 1)[1], original[0]["content"].split("【规则】", 1)[1])
            self.assertEqual(system.split("【已生成的分析报告】", 1)[0], original[0]["content"].split("【已生成的分析报告】", 1)[0])

    def test_same_report_text_elsewhere_is_never_replaced_and_history_limit_stays_ten(self):
        self.report = "REPEATED REPORT TOKEN" * 100
        self.agent.simulation_requirement = self.report
        self.question = self.report
        self.history = [{"role": "user", "content": self.report + str(i)} for i in range(12)]
        canonical = self.messages()
        with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", self.size(self.messages(MARKER)) + 10):
            self.run_chat()
            self.assertEqual(self.assert_fit(self.raw[0], canonical), 10)
        self.assertEqual(self.raw[0]["messages"][1:-1], self.history[-10:])

    def test_actual_gpt5_model_and_nondefault_normalization_control_the_budget(self):
        self.client.model = " gpt-5-mini "
        with patch.multiple(Config, LOCAL_REASONING_EFFORT="high", LOCAL_MAX_OUTPUT_TOKENS=777,
                            LOCAL_MAX_INPUT_CHARS=23000):
            self.run_chat()
            self.assert_fit(self.raw[0], self.messages())
        self.assertEqual(self.raw[0]["model"], " gpt-5-mini ")
        self.assertNotIn("temperature", self.raw[0])
        self.assertNotIn("max_tokens", self.raw[0])
        self.assertEqual(self.raw[0]["max_completion_tokens"], 4096)
        self.assertEqual(self.forwarded[0]["model"], "gpt-5-mini")
        self.assertEqual(self.forwarded[0]["max_completion_tokens"], 777)
        self.assertEqual(self.forwarded[0]["reasoning_effort"], "high")

    def test_fixed_overflow_after_each_tool_keeps_original_accumulation_and_refusal(self):
        for failing_request in (2, 3):
            with self.subTest(failing_request=failing_request):
                self.reset([TOOL_RESPONSE, TOOL_RESPONSE, ANSWER])
                self.agent.simulation_requirement = "R" * 17000
                # Marker-only is 22,942 initially: a 1,500-character observation
                # crosses the limit on request 2; small first output delays to 3.
                self.tool_result = "x" * (100 if failing_request == 3 else 1500)
                first_result = self.tool_result
                if failing_request == 3:
                    self.after_search = lambda index: setattr(self, "tool_result", "y" * 1500)
                original = self.messages()
                with self.assertRaises(gateway._GatewayError) as caught:
                    self.run_chat()
                self.assertEqual(caught.exception.status, 413)
                self.assertEqual(len(self.raw), failing_request)
                self.assertEqual(len(self.forwarded), failing_request - 1)
                expected = original + self.extra(result=first_result)
                if failing_request == 3:
                    expected += self.extra(result="y" * 1500)
                self.assertEqual(self.raw[-1], self.envelope(expected))
                self.assertEqual(len(self.searches), failing_request - 1)

    def test_normalization_error_propagates_without_completion_or_retry(self):
        for model in ("", "forbidden:cloud"):
            with self.subTest(model=model):
                self.reset()
                self.client.model = model
                with self.assertRaises(gateway._GatewayError) as caught:
                    self.run_chat()
                self.assertEqual(caught.exception.status, 400)
                self.assertEqual(self.raw, [])
                self.assertEqual(self.searches, [])

    def test_provider_error_propagates_without_retry(self):
        error = RuntimeError("synthetic provider refusal")
        self.reset([error])
        with self.assertRaisesRegex(RuntimeError, "synthetic provider refusal"):
            self.run_chat()
        self.assertEqual(len(self.raw), 1)
        self.assertEqual(len(self.forwarded), 1)
        self.assertEqual(self.searches, [])

    def test_final_exact_recheck_keeps_original_when_fitted_view_is_unverified(self):
        canonical = self.messages()
        real_normalize = gateway._normalize_payload
        calls = []
        def changed(path, payload, **kwargs):
            normalized = real_normalize(path, payload, **kwargs)
            calls.append(1)
            if len(calls) == 3:
                normalized["unexpected_extra"] = "x" * 24000
            return normalized
        with patch.object(gateway, "_normalize_payload", side_effect=changed):
            self.assertIs(self.fit(canonical), canonical)
        self.assertEqual(len(calls), 3)

    def test_report_binding_is_captured_once_and_explicit_report_skips_lookup(self):
        original = self.report
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                self.reset()
                self.report = original + "EXCLUDED TAIL"
                with patch.object(report_module.ReportManager, "get_report_by_simulation",
                                  return_value=SimpleNamespace(markdown_content=self.report)) as lookup:
                    self.run_chat(legacy=legacy)
                self.assertEqual(lookup.call_count, int(legacy))
                self.assert_fit(self.raw[0], self.messages())
                self.assertNotIn("EXCLUDED TAIL", self.raw[0]["messages"][0]["content"])

    def test_final_normalization_error_propagates_after_exactly_two_tools(self):
        self.reset([TOOL_RESPONSE, TOOL_RESPONSE, ANSWER])
        def invalidate(index):
            if index == 2:
                self.client.model = "forbidden:cloud"
        self.after_search = invalidate
        with self.assertRaises(gateway._GatewayError) as caught:
            self.run_chat()
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(len(self.raw), 2)
        self.assertEqual(len(self.forwarded), 2)
        self.assertEqual(len(self.searches), 2)

    def test_route_keeps_selected_report_and_existing_500_for_fixed_refusal(self):
        from flask import Flask
        from app.api import report as report_api
        app = Flask(__name__)
        app.register_blueprint(report_api.report_bp, url_prefix="/api/report")
        state = SimpleNamespace(project_id="project_chat", graph_id=self.agent.graph_id)
        project = SimpleNamespace(graph_id=self.agent.graph_id,
                                  simulation_requirement=self.agent.simulation_requirement)
        saved = SimpleNamespace(report_id="report_chat", simulation_id=self.agent.simulation_id,
            status=report_module.ReportStatus.COMPLETED, markdown_content=self.report)
        for refused in (False, True):
            with self.subTest(refused=refused):
                self.reset()
                limit = self.size(self.messages(MARKER)) - 1 if refused else 24000
                with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", limit), patch.object(
                        report_api, "SimulationManager", return_value=SimpleNamespace(get_simulation=lambda _: state)), patch.object(
                        report_api.ProjectManager, "get_project", return_value=project), patch.object(
                        report_api.ReportManager, "get_report", return_value=saved) as lookup, patch.object(
                        report_api, "ReportAgent", return_value=self.agent) as construct:
                    response = app.test_client().post("/api/report/chat", headers={"Accept-Language": "en"}, json={
                        "simulation_id": self.agent.simulation_id, "report_id": saved.report_id,
                        "message": self.question, "chat_history": self.history})
                lookup.assert_called_once_with(saved.report_id)
                construct.assert_called_once_with(graph_id=self.agent.graph_id,
                    simulation_id=self.agent.simulation_id, simulation_requirement=self.agent.simulation_requirement)
                self.assertEqual(response.status_code, 500 if refused else 200)
                self.assertEqual(response.get_json()["success"], not refused)
                if refused:
                    self.assertEqual(response.get_json()["error"], "(413, 'Input exceeds the configured local context budget')")
                    self.assertEqual(self.raw, [self.envelope(self.messages())])
                    self.assertEqual(self.forwarded, [])
                else:
                    self.assertEqual(response.get_json()["data"]["response"], ANSWER)
                    self.assert_fit(self.raw[0], self.messages())
                self.assertEqual(len(self.raw), 1)
                self.assertEqual(self.searches, [])

    def test_tool_limits_and_response_cleaning_stay_unchanged(self):
        second_tool = '<tool_call>{"name":"quick_search","parameters":{"query":"ignored"}}</tool_call>'
        response = TOOL_RESPONSE + second_tool + '<tool_result>fabricated evidence</tool_result>'
        clean_response = TOOL_RESPONSE + second_tool
        self.reset([response, response, '<think>private scratch</think>' + ANSWER + '<tool_result>fake</tool_result>'])
        result = self.run_chat()
        self.assertEqual(result["response"], ANSWER)
        self.assertEqual(result["sources"], ["transit", "transit"])
        self.assertEqual(len(self.searches), 2)
        for index, request in enumerate(self.raw):
            canonical = self.messages(extra=self.extra(response=clean_response) * index)
            self.assert_fit(request, canonical)
            self.assertNotIn("fabricated evidence", repr(request))
        self.assertEqual(len(self.raw), 3)
