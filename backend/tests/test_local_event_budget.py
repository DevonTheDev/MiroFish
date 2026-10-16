"""Local event budgets, real OpenAI SDK objects and synthetic in-process transport.

No model, server or network is needed. The original prompt literals below are a
frozen independent oracle, so every fixed character is checked, not only a few
selected phrases. Fixtures use a 16,000-character brief and ten small entities.
"""
from copy import deepcopy
import hashlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

import httpx
from openai import OpenAI

from app.config import Config
from app.local_runtime import gateway
from app.services import simulation_config_generator as config_module
from app.services.zep_entity_reader import EntityNode
from app.utils.locale import get_language_instruction, get_locale, set_locale
from app.utils.openai_chat_compat import build_chat_completion_kwargs


ORIGINAL_PROMPT = '基于以下模拟需求，生成事件配置。\n\n模拟需求: {simulation_requirement}\n\n{context_truncated}\n\n## 可用实体类型及示例\n{type_info}\n\n## 任务\n请生成事件配置JSON：\n- 提取热点话题关键词\n- 描述舆论发展方向\n- 设计初始帖子内容，**每个帖子必须指定 poster_type（发布者类型）**\n\n**重要**: poster_type 必须从上面的"可用实体类型"中选择，这样初始帖子才能分配给合适的 Agent 发布。\n例如：官方声明应由 Official/University 类型发布，新闻由 MediaOutlet 发布，学生观点由 Student 发布。\n\n返回JSON格式（不要markdown）：\n{{\n    "hot_topics": ["关键词1", "关键词2", ...],\n    "narrative_direction": "<舆论发展方向描述>",\n    "initial_posts": [\n        {{"content": "帖子内容", "poster_type": "实体类型（必须从可用类型中选择）"}},\n        ...\n    ],\n    "reasoning": "<简要说明>"\n}}'
ORIGINAL_SYSTEM = '你是舆论分析专家。返回纯JSON格式。注意 poster_type 必须精确匹配可用实体类型。'
ORIGINAL_SYSTEM_SUFFIX = "{system_prompt}\n\n{language}\nIMPORTANT: The 'poster_type' field value MUST be in English PascalCase exactly matching the available entity types. Only 'content', 'narrative_direction', 'hot_topics' and 'reasoning' fields should use the specified language."
CHAT_PATH = "/v1/chat/completions"
RESPONSE = {"hot_topics": ["transit"], "narrative_direction": "Synthetic discussion",
            "initial_posts": [{"content": "Trial announcement", "poster_type": "Student"}],
            "reasoning": "Synthetic event response"}
FALLBACK = {"hot_topics": [], "narrative_direction": "", "initial_posts": [],
            "reasoning": "使用默认配置"}
DOCUMENT = ("The city council proposes a six-month bus lane trial. Students, commuters "
            "and local organizations are discussing the announcement and its effects.")


def text_of_length(length, unit="Discuss the transit trial and its effects on student travel. "):
    return (unit * (length // len(unit) + 1))[:length]


class EventBudgetFixture(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.multiple(
            Config, LOCAL_MODE=True, LOCAL_MAX_INPUT_CHARS=24000,
            LOCAL_MAX_OUTPUT_TOKENS=2048, LOCAL_REASONING_EFFORT="none",
            LLM_MODEL_NAME="unused-configured-default-with-a-different-length",
        ))
        self.addCleanup(set_locale, get_locale())
        set_locale("zh")
        self.sleep = self.enterContext(patch("time.sleep"))
        self.generator = config_module.SimulationConfigGenerator.__new__(
            config_module.SimulationConfigGenerator)
        self.generator.model_name = "mirofish-local"
        self.generator.client = self.sdk_client()
        self.assertIs(type(self.generator.client), OpenAI)
        self.requirement = text_of_length(16000)
        self.entities = [EntityNode(
            f"student_{i}", f"Student {i+1}", ["Student"],
            "A local student who uses public transport and follows city planning news.", {},
        ) for i in range(10)]
        self.context = self.generator._build_context(self.requirement, DOCUMENT, self.entities)
        self.total_sdk_requests = self.total_custom_requests = self.total_admitted = 0
        self.reset()

    def sdk_client(self, cls=OpenAI):
        # An explicit transport and trust_env=False prevent environmental proxy use.
        http = httpx.Client(transport=httpx.MockTransport(self.transport), trust_env=False)
        client = cls(api_key="synthetic-only", base_url="http://127.0.0.1:9/v1",
                     http_client=http, max_retries=0)
        # Keep SDK metadata deterministic without probing the host via uname.
        client._platform = "Unknown"
        self.addCleanup(client.close)
        return client

    def reset(self, statuses=()):
        self.raw, self.admitted, self.refusals = [], [], []
        self.statuses = list(statuses)
        self.sleep.reset_mock()

    def tearDown(self):
        print("EVENT_REQUEST_COUNTS " + json.dumps({
            "case": self.id(), "sdk_transport_requests": self.total_sdk_requests,
            "custom_completion_calls": self.total_custom_requests,
            "synthetic_admitted_requests": self.total_admitted,
        }, sort_keys=True), flush=True)

    def transport(self, request):
        self.assertEqual(request.method, "POST")
        self.assertEqual(str(request.url), "http://127.0.0.1:9/v1/chat/completions")
        self.total_sdk_requests += 1
        return self.respond(json.loads(request.content))

    def custom_completion(self, **payload):
        self.total_custom_requests += 1
        response = self.respond(payload)
        if response.status_code != 200:
            raise RuntimeError("Synthetic custom-client refusal")
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=json.dumps(RESPONSE)), finish_reason="stop")])

    def respond(self, payload):
        self.raw.append(deepcopy(payload))
        self.assertLessEqual(len(self.raw), 3, "Existing stage owns at most three attempts")
        settings = gateway.GatewaySettings(
            "http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1",
            max_input_chars=Config.LOCAL_MAX_INPUT_CHARS,
            max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
            reasoning_effort=Config.LOCAL_REASONING_EFFORT)
        try:
            admitted = (gateway._prepare_payload(CHAT_PATH, payload, settings)
                        if Config.LOCAL_MODE else deepcopy(payload))
        except gateway._GatewayError as error:
            self.refusals.append(error.status)
            return httpx.Response(error.status, json={"error": {"message": str(error),
                                                                "type": "synthetic_guard"}})
        self.admitted.append(deepcopy(admitted))
        self.total_admitted += 1
        status = self.statuses.pop(0) if self.statuses else 200
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "Synthetic provider error"}})
        return httpx.Response(200, json={
            "id": "synthetic", "object": "chat.completion", "created": 0,
            "model": payload["model"], "choices": [{"index": 0,
                "message": {"role": "assistant", "content": json.dumps(RESPONSE)},
                "finish_reason": "stop"}],
        })

    def prompt(self, sample=None):
        examples = {}
        for entity in self.entities:
            names = examples.setdefault(entity.get_entity_type() or "Unknown", [])
            if len(names) < 3:
                names.append(entity.name)
        info = "\n".join(f"- {kind}: {', '.join(names)}" for kind, names in examples.items())
        return ORIGINAL_PROMPT.format(
            simulation_requirement=self.requirement,
            context_truncated=self.context[:8000] if sample is None else sample,
            type_info=info)

    def system(self):
        return ORIGINAL_SYSTEM_SUFFIX.format(system_prompt=ORIGINAL_SYSTEM,
                                             language=get_language_instruction())

    def envelope(self, prompt=None, attempt=0, system=None):
        return build_chat_completion_kwargs(
            model=self.generator.model_name,
            messages=[{"role": "system", "content": self.system() if system is None else system},
                      {"role": "user", "content": self.prompt() if prompt is None else prompt}],
            response_format={"type": "json_object"}, temperature=0.7 - attempt * 0.1)

    def size(self, prompt=None):
        return gateway._input_size(gateway._normalize_payload(
            CHAT_PATH, self.envelope(prompt),
            max_output_tokens=Config.LOCAL_MAX_OUTPUT_TOKENS,
            reasoning_effort=Config.LOCAL_REASONING_EFFORT))

    def fit(self, renderer=None):
        original = self.prompt()
        return self.generator._fit_local_event_prompt(
            original, self.system(), self.context[:8000], self.prompt if renderer is None else renderer)

    def run_event(self):
        return self.generator._generate_event_config(self.context, self.requirement, self.entities)

    def assert_fit(self, request):
        count = Config.LOCAL_MAX_INPUT_CHARS - self.size(self.prompt(""))
        self.assertGreaterEqual(count, 0)
        self.assertLess(count, len(self.context[:8000]))
        expected = self.envelope(self.prompt(self.context[:8000][:count]))
        self.assertEqual(request, expected)  # Every fixed byte and option, including metadata.
        self.assertEqual(self.size(request["messages"][1]["content"]), Config.LOCAL_MAX_INPUT_CHARS)
        self.assertEqual(self.size(self.prompt(self.context[:8000][:count+1])),
                         Config.LOCAL_MAX_INPUT_CHARS + 1)
        self.assertEqual(request["messages"][1]["content"].split("模拟需求: ", 1)[1]
                         [:len(self.requirement)], self.requirement)
        return count

    def assert_original_fallback(self, statuses):
        self.assertEqual(self.run_event(), FALLBACK)
        self.assertEqual(self.raw, [self.envelope(attempt=i) for i in range(3)])
        self.assertEqual(self.admitted, [])
        self.assertEqual(self.refusals, statuses)
        self.assertEqual(self.sleep.call_args_list, [call(2), call(4), call(6)])


class LocalEventBudgetRegression(EventBudgetFixture):
    def test_default_16k_brief_fits_both_languages_with_complete_fixed_content(self):
        for language, original_size, prefix in (("zh", 24961, 7039), ("en", 24979, 7021)):
            with self.subTest(language=language):
                set_locale(language)
                self.reset()
                before = deepcopy(self.entities)
                self.assertEqual(self.size(), original_size)
                self.assertEqual(self.run_event(), RESPONSE)
                self.assertEqual(self.assert_fit(self.raw[0]), prefix)
                self.assertEqual(self.entities, before)
                self.assertEqual(len(self.raw), 1)
                self.assertEqual(len(self.admitted), 1)
                self.sleep.assert_not_called()
                print("EVENT_DEFAULT_WITNESS " + json.dumps({
                    "language": language, "requirement_chars": len(self.requirement),
                    "original_normalized_chars": original_size, "retained_context_chars": prefix,
                    "admitted_normalized_chars": gateway._input_size(self.admitted[0]),
                    "request_sha256": hashlib.sha256(json.dumps(self.raw[0], ensure_ascii=False,
                        sort_keys=True).encode()).hexdigest(),
                }, sort_keys=True), flush=True)

    def test_exact_original_boundary_and_one_extra_character(self):
        for overflow in (0, 1):
            with self.subTest(overflow=overflow):
                self.reset()
                self.requirement = text_of_length(15039 + overflow)
                self.context = self.generator._build_context(self.requirement, DOCUMENT, self.entities)
                self.assertEqual(self.size(), 24000 + overflow)
                self.assertEqual(self.run_event(), RESPONSE)
                if overflow:
                    self.assertEqual(self.assert_fit(self.raw[0]), 7999)
                else:
                    self.assertEqual(self.raw, [self.envelope()])

    def test_unicode_and_repeated_slot_text_keep_all_entity_metadata_and_instructions(self):
        self.context = text_of_length(9000, 'same-prefix 报告 "quoted" \\ line\n🙂 e\u0301 ')
        self.requirement = text_of_length(16000, self.context[:120])
        self.entities += [EntityNode("official", "Official 报告 🙂 " * 20,
                                    ["University"], "short summary", {}),
                          EntityNode("unknown", "Unnamed, exact \\ name", ["Entity"], "", {})]
        self.assertEqual(self.run_event(), RESPONSE)
        self.assert_fit(self.raw[0])
        self.assertNotIn("[truncated]", self.raw[0]["messages"][1]["content"])

    def test_zero_and_one_character_allowances_keep_same_markerless_layout(self):
        for count in (0, 1):
            with self.subTest(count=count):
                self.reset()
                limit = self.size(self.prompt("")) + count
                with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", limit):
                    self.assertEqual(self.run_event(), RESPONSE)
                    self.assertEqual(self.assert_fit(self.raw[0]), count)

    def test_already_fitting_empty_and_capped_context_requests_are_identical(self):
        self.requirement = "Short requirement"
        for length in (0, 7999, 8000, 8001):
            with self.subTest(length=length):
                self.reset()
                self.context = text_of_length(length)
                self.assertEqual(self.fit(), self.prompt())
                self.assertEqual(self.run_event(), RESPONSE)
                self.assertEqual(self.raw, [self.envelope()])

    def test_fixed_content_overflow_retains_original_three_refusals_and_fallback(self):
        with patch.object(Config, "LOCAL_MAX_INPUT_CHARS", 1):
            self.assertEqual(self.fit(), self.prompt())
            self.assert_original_fallback([413, 413, 413])

    def test_invalid_model_normalization_retains_original_error_path(self):
        self.generator.model_name = "unsupported:cloud"
        self.assertEqual(self.fit(), self.prompt())
        self.assert_original_fallback([400, 400, 400])

    def test_sizing_and_render_errors_return_original_without_requests(self):
        original = self.prompt()
        normalizer = gateway._normalize_payload
        for failing_call in (1, 3):
            calls = []
            def normalize(*args, **kwargs):
                calls.append(1)
                if len(calls) == failing_call:
                    raise ValueError("Synthetic sizing error")
                return normalizer(*args, **kwargs)
            with self.subTest(failing_call=failing_call), patch.object(
                    gateway, "_normalize_payload", side_effect=normalize):
                self.assertEqual(self.fit(), original)
                self.assertEqual(len(calls), failing_call)
        renderer = Mock(side_effect=ValueError("Synthetic render error"))
        self.assertEqual(self.fit(renderer), original)
        renderer.assert_called_once_with("")
        self.assertEqual(self.raw, [])

    def test_final_recount_failure_retains_original_without_requests(self):
        with patch.object(gateway, "_input_size", side_effect=[24961, 16961, 24001]) as size:
            self.assertEqual(self.fit(), self.prompt())
            self.assertEqual(size.call_count, 3)
        self.assertEqual(self.raw, [])

    def test_actual_model_compatibility_and_configured_normalization_define_exact_fit(self):
        for model, reasoning in (("  mirofish-local-with-a-longer-name  ", "low"),
                                 (" GPT-5.1-mini ", "high"), ("gpt-5", None)):
            with self.subTest(model=model), patch.multiple(
                    Config, LOCAL_REASONING_EFFORT=reasoning, LOCAL_MAX_OUTPUT_TOKENS=71):
                self.reset()
                self.generator.model_name = model
                self.assertEqual(self.run_event(), RESPONSE)
                self.assert_fit(self.raw[0])
                self.assertEqual(self.raw[0]["model"], model)
                self.assertEqual(self.admitted[0]["model"], model.strip())
                self.assertEqual("temperature" in self.raw[0], not model.strip().lower().startswith("gpt-5"))
                self.assertNotIn("max_tokens", self.raw[0])
                self.assertNotIn("max_completion_tokens", self.raw[0])
                self.assertEqual(self.admitted[0]["max_tokens"], 71)
                self.assertEqual(self.admitted[0].get("reasoning_effort"), reasoning)

    def test_provider_retries_keep_temperatures_fitted_prompt_and_captured_language(self):
        self.reset(statuses=(400, 400, 200))
        captured_system = self.system()
        with patch.object(config_module, "get_language_instruction",
                          return_value=get_language_instruction()) as language:
            self.assertEqual(self.run_event(), RESPONSE)
            language.assert_called_once_with()
        fitted = self.raw[0]["messages"][1]["content"]
        self.assert_fit(self.raw[0])
        self.assertEqual(self.raw, [self.envelope(fitted, attempt=i, system=captured_system)
                                   for i in range(3)])
        self.assertEqual([gateway._input_size(x) for x in self.admitted], [24000] * 3)
        self.assertEqual(self.sleep.call_args_list, [call(2), call(4)])

    def test_cloud_request_preserves_original_overbudget_envelope(self):
        with patch.object(Config, "LOCAL_MODE", False), patch.object(
                gateway, "_normalize_payload", side_effect=AssertionError("Cloud must skip sizing")):
            self.assertEqual(self.run_event(), RESPONSE)
            self.assertEqual(self.raw, [self.envelope()])

    def test_custom_and_subclass_clients_preserve_original_refusal_path(self):
        class CustomOpenAI(OpenAI):
            pass
        custom = SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=self.custom_completion)))
        for client in (custom, self.sdk_client(CustomOpenAI)):
            with self.subTest(kind=type(client).__name__):
                self.reset()
                self.generator.client = client
                self.assert_original_fallback([413, 413, 413])

    def test_substituted_completion_without_sdk_client_keeps_original_prompt(self):
        del self.generator.client
        with patch.object(self.generator, "_call_llm_with_retry", return_value=RESPONSE) as completion:
            self.assertEqual(self.run_event(), RESPONSE)
            completion.assert_called_once_with(self.prompt(), self.system())
        self.assertEqual(self.raw, [])

    def test_sizing_failure_keeps_original_three_attempt_refusal_path(self):
        original_normalizer = gateway._normalize_payload
        calls = []
        def normalize(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise ValueError("Synthetic fitter normalization error")
            return original_normalizer(*args, **kwargs)
        with patch.object(gateway, "_normalize_payload", side_effect=normalize):
            self.assert_original_fallback([413, 413, 413])
        self.assertEqual(len(calls), 4)  # One pure sizing attempt, three existing gateway checks.
