"""Profile request-budget regressions with real renderers and gateway admission.

Only graph fetches and the SDK completion boundary are mocked. No model, graph
database, server, or optional historical checkout is needed by these tests.
"""
from copy import deepcopy
from contextlib import redirect_stdout
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.config import Config
from app.local_runtime import gateway
from app.services import oasis_profile_generator as profile_module
from app.services import zep_entity_reader as reader_module
from app.utils.locale import get_locale, set_locale
from app.utils.openai_chat_compat import build_chat_completion_kwargs


CHAT_PATH = "/v1/chat/completions"
GOOD_JSON = '{"bio":"Bio","persona":"Persona"}'


def response(content=GOOD_JSON, finish="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=content), finish_reason=finish,
    )])


def unicode_text(length):
    unit = "Alpha世界🙂e\u03010123456789\n"
    return (unit * (length // len(unit) + 1))[:length]


def entity(kind="Person", **overrides):
    values = dict(uuid="person_0", name="Alex", labels=["Entity", kind],
                  summary="A local resident.", attributes={},
                  related_edges=[], related_nodes=[])
    values.update(overrides)
    return reader_module.EntityNode(**values)


def graph_records():
    """Thirty ordinary 100-character facts, not one oversized fixed field."""
    nodes = [
        SimpleNamespace(uuid_="person_0", name="Alex", labels=["Entity", "Person"],
                        summary="A local resident.", attributes={}),
        SimpleNamespace(uuid_="neighbor_0", name="Local forum", labels=["Entity"],
                        summary="A neighborhood discussion group.", attributes={}),
    ]
    edges = []
    for index in range(30):
        fact = (f"Fact {index:02d}: Alex follows local community discussions. "
                "Neighbors share updates about meetings, parks, and public events.")[:100]
        edges.append(SimpleNamespace(
            uuid_=f"edge_{index}", name="PARTICIPATES_IN", fact=fact,
            source_node_uuid="person_0", target_node_uuid="neighbor_0", attributes={},
        ))
    return nodes, edges


def read_graph_entity(nodes, edges):
    reader = reader_module.ZepEntityReader.__new__(reader_module.ZepEntityReader)
    reader.client = object()
    with patch.object(reader_module, "fetch_all_nodes", return_value=nodes), \
            patch.object(reader_module, "fetch_all_edges", return_value=edges):
        result = reader.filter_defined_entities(
            "saved_graph", selected_entity_ids=["person_0"],
            max_nodes=32, max_edges=64,
        )
    if result.filtered_count != 1:
        raise AssertionError("Fixture must reach exactly one selected real entity")
    return result.entities[0]


class ProfileBudgetFixture(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.multiple(
            Config, LOCAL_MODE=True, LOCAL_MAX_INPUT_CHARS=3000,
            LOCAL_MAX_OUTPUT_TOKENS=2048, LOCAL_REASONING_EFFORT="none",
            LOCAL_MAX_AGENTS=10,
        ))
        previous_locale = get_locale()
        self.addCleanup(set_locale, previous_locale)
        set_locale("en")
        self.generator = profile_module.OasisProfileGenerator.__new__(
            profile_module.OasisProfileGenerator)
        self.generator.model_name = "mirofish-local"
        self.generator.zep_client = None
        self.generator.graph_id = "saved_graph"
        self.generator.client = SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=self.completion),
        ))
        self.sleeps = []
        self.enterContext(patch.object(profile_module.time, "sleep", side_effect=self.sleeps.append))
        self.reset_calls()

    def reset_calls(self, outcomes=None):
        self.raw = []
        self.forwarded = []
        self.outcomes = list(outcomes if outcomes is not None else [response()])
        self.sleeps.clear()

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

    def completion(self, **request):
        self.raw.append(deepcopy(request))
        self.assertLessEqual(len(self.raw), 3)
        admitted = (gateway._prepare_payload(CHAT_PATH, request, self.settings())
                    if Config.LOCAL_MODE else deepcopy(request))
        self.forwarded.append(admitted)
        self.assertLessEqual(len(self.forwarded), len(self.outcomes))
        outcome = self.outcomes[len(self.forwarded) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def legacy_request(self, item, context):
        individual = self.generator._is_individual_entity(item.get_entity_type())
        builder = (self.generator._build_individual_persona_prompt if individual
                   else self.generator._build_group_persona_prompt)
        return build_chat_completion_kwargs(
            model=self.generator.model_name,
            messages=[
                {"role": "system", "content": self.generator._get_system_prompt(individual)},
                {"role": "user", "content": builder(
                    item.name, item.get_entity_type(), item.summary, item.attributes, context)},
            ], response_format={"type": "json_object"}, temperature=0.7,
        )

    def fixed_request(self, item):
        # An independent literal insertion removes only the context position;
        # this never calls the new fitted-context override or fitting helper.
        marker = "UNIQUE-CONTEXT-INSERTION-7b18"
        request = self.legacy_request(item, marker)
        prompt = request["messages"][1]["content"]
        self.assertEqual(prompt.count(marker), 1)
        request["messages"][1]["content"] = prompt.replace(marker, "")
        return request

    def generate(self, item, context=None):
        if context is None:
            return self.generator.generate_profile_from_entity(item, 0)
        with patch.object(self.generator, "_build_entity_context", return_value=context):
            return self.generator.generate_profile_from_entity(item, 0)

    def assert_fit(self, item, context, request):
        original = self.legacy_request(item, context)
        fixed = self.fixed_request(item)
        allowance = Config.LOCAL_MAX_INPUT_CHARS - self.size(fixed)
        expected_prefix = context[:min(3000, max(0, allowance))]
        expected = deepcopy(original)
        prompt = expected["messages"][1]["content"]
        self.assertEqual(prompt.count(context[:3000]), 1)
        expected["messages"][1]["content"] = prompt.replace(context[:3000], expected_prefix)
        self.assertEqual(request, expected)
        self.assertEqual(self.size(request), Config.LOCAL_MAX_INPUT_CHARS)
        self.assertEqual(request["messages"][0], original["messages"][0])
        self.assertEqual(request["response_format"], {"type": "json_object"})
        self.assertNotIn("max_tokens", request)
        self.assertNotIn("max_completion_tokens", request)


class LocalProfileBudgetRegression(ProfileBudgetFixture):
    def test_saved_graph_person_at_3000_admits_profile(self):
        nodes, edges = graph_records()
        graph_before = deepcopy((nodes, edges))
        self.assertEqual([len(edge.fact) for edge in edges], [100] * 30)
        item = read_graph_entity(nodes, edges)
        before = deepcopy(item.to_dict())
        context = self.generator._build_entity_context(item)
        self.assertGreater(len(context), 3000)
        self.assertEqual(self.size(self.legacy_request(item, context)), 3956)
        profile = self.generate(item)
        self.assertEqual(profile.generation_provenance,
                         {"version": 1, "route": "model_json", "provider_reported_length": False})
        self.assertEqual(len(self.raw), 1)
        self.assertEqual(len(self.forwarded), 1)
        self.assert_fit(item, context, self.raw[0])
        self.assertEqual(item.to_dict(), before)
        self.assertEqual((nodes, edges), graph_before)

    def test_both_kinds_and_locales_keep_fixed_fields_and_unicode_prefix(self):
        for kind in ("Person", "Organization"):
            for locale in ("zh", "en"):
                with self.subTest(kind=kind, locale=locale):
                    set_locale(locale)
                    self.reset_calls()
                    item = entity(kind, name="Alex 世界🙂", summary="Full summary e\u0301.",
                                  attributes={"地区": "北区🙂", "nested": [1, {"label": "完整"}]},
                                  related_edges=[{"fact": unicode_text(4000)}])
                    before = deepcopy(item.to_dict())
                    context = self.generator._build_entity_context(item)
                    profile = self.generate(item)
                    self.assertEqual(profile.bio, "Bio")
                    self.assertEqual(len(self.forwarded), 1)
                    self.assert_fit(item, context, self.raw[0])
                    self.assertIn(json.dumps(item.attributes, ensure_ascii=False),
                                  self.raw[0]["messages"][1]["content"])
                    self.assertEqual(item.to_dict(), before)

    def test_exact_fit_and_one_character_overflow_use_actual_envelope(self):
        item, context = entity(), unicode_text(3000)
        for model, reasoning in ((" mirofish-local ", "none"), ("mirofish-local", None),
                                 (" GPT-5-local ", "none"), ("gpt-5-local", None)):
            with self.subTest(model=model, reasoning=reasoning):
                self.generator.model_name = model
                Config.LOCAL_REASONING_EFFORT = reasoning
                original = self.legacy_request(item, context)
                original_size = self.size(original)
                Config.LOCAL_MAX_INPUT_CHARS = original_size
                self.reset_calls()
                self.generate(item, context)
                self.assertEqual(self.raw, [original])
                self.assertEqual(gateway._input_size(self.forwarded[0]), original_size)
                Config.LOCAL_MAX_INPUT_CHARS -= 1
                self.reset_calls()
                self.generate(item, context)
                self.assert_fit(item, context, self.raw[0])
                self.assertEqual(len(self.forwarded), 1)
                self.assertEqual(self.forwarded[0]["model"], model.strip())
                self.assertEqual("reasoning_effort" in self.forwarded[0], reasoning is not None)
                self.assertEqual("temperature" in self.raw[0], not model.strip().lower().startswith("gpt-5"))
                self.assertEqual(self.forwarded[0]["max_tokens"], 2048)

    def test_cloud_default_and_already_fitting_requests_remain_exact(self):
        for local, limit, length in ((False, 1000, 4000), (True, 24000, 4000), (True, 3000, 200)):
            with self.subTest(local=local, limit=limit, length=length):
                Config.LOCAL_MODE, Config.LOCAL_MAX_INPUT_CHARS = local, limit
                item, context = entity(), unicode_text(length)
                original = self.legacy_request(item, context)
                self.reset_calls()
                self.generate(item, context)
                self.assertEqual(self.raw, [original])
                self.assertEqual(len(self.forwarded), 1)

    def test_zero_and_one_character_allowances_use_literal_insertion(self):
        for kind in ("Person", "Organization"):
            for allowance in (0, 1):
                with self.subTest(kind=kind, allowance=allowance):
                    item, context = entity(kind), "🙂" + unicode_text(3000)
                    Config.LOCAL_MAX_INPUT_CHARS = self.size(self.fixed_request(item)) + allowance
                    self.reset_calls()
                    profile = self.generate(item, context)
                    self.assertEqual(profile.bio, "Bio")
                    self.assertEqual(len(self.forwarded), 1)
                    self.assert_fit(item, context, self.raw[0])
                    insertion = self.raw[0]["messages"][1]["content"].split("上下文信息:\n", 1)[1].split("\n\n请生成JSON", 1)[0]
                    self.assertEqual(insertion, context[:allowance])
                    self.assertNotIn("无额外上下文", self.raw[0]["messages"][1]["content"])

    def test_originally_absent_context_keeps_placeholder_even_when_unfit(self):
        for kind in ("Person", "Organization"):
            for deficit in (0, 1):
                with self.subTest(kind=kind, deficit=deficit):
                    item = entity(kind)
                    original = self.legacy_request(item, "")
                    Config.LOCAL_MAX_INPUT_CHARS = self.size(original) - deficit
                    self.reset_calls()
                    profile = self.generate(item, "")
                    self.assertEqual(self.raw[0], original)
                    self.assertIn("无额外上下文", self.raw[0]["messages"][1]["content"])
                    self.assertEqual(len(self.raw), 3 if deficit else 1)
                    self.assertEqual(len(self.forwarded), 0 if deficit else 1)
                    self.assertEqual(profile.generation_provenance["route"],
                                     "rule_fallback" if deficit else "model_json")
                    self.assertEqual(self.sleeps, [1, 2, 3] if deficit else [])

    def test_fixed_content_overflow_preserves_original_attempts_and_rule_fallback(self):
        item, context = entity(summary=unicode_text(3200)), unicode_text(3000)
        original = self.legacy_request(item, context)
        before = deepcopy(item.to_dict())
        profile = self.generate(item, context)
        self.assertEqual(profile.generation_provenance, {"version": 1, "route": "rule_fallback"})
        self.assertEqual(len(self.raw), 3)
        self.assertEqual(self.forwarded, [])
        self.assertEqual(self.sleeps, [1, 2, 3])
        for request in self.raw:
            self.assertEqual(request["messages"], original["messages"])
        self.assertEqual(item.to_dict(), before)

    def test_failed_final_recheck_preserves_original_gateway_refusals(self):
        item, context = entity(), unicode_text(3000)
        original = self.legacy_request(item, context)
        fixed = self.fixed_request(item)
        real_counter = gateway._input_size
        proposed_fits = []

        def unexpected_count(value):
            # Invalidate each proposed final rendering while actual original
            # gateway refusals still use the unchanged production counter.
            if isinstance(value, dict) and "messages" in value:
                prompt = value["messages"][1]["content"]
                if prompt not in (original["messages"][1]["content"],
                                  fixed["messages"][1]["content"]):
                    proposed_fits.append(value)
                    return Config.LOCAL_MAX_INPUT_CHARS + 1
            return real_counter(value)

        with patch.object(gateway, "_input_size", side_effect=unexpected_count):
            profile = self.generate(item, context)
        self.assertEqual(profile.generation_provenance, {"version": 1, "route": "rule_fallback"})
        self.assertEqual(len(self.raw), 3)
        self.assertEqual(self.forwarded, [])
        self.assertEqual(self.sleeps, [1, 2, 3])
        self.assertEqual(len(proposed_fits), 3)
        self.assertTrue(all(call["messages"] == original["messages"] for call in self.raw))

    def test_normalization_failure_stays_inside_existing_attempt_behavior(self):
        self.generator.model_name = "forbidden:cloud"
        profile = self.generate(entity(), unicode_text(3000))
        self.assertEqual(profile.generation_provenance, {"version": 1, "route": "rule_fallback"})
        self.assertEqual(len(self.raw), 3)
        self.assertEqual(self.forwarded, [])
        self.assertEqual(self.sleeps, [1, 2, 3])

    def test_batch_fixed_overflow_keeps_rule_route_instead_of_basic_fallback(self):
        item = entity(summary=unicode_text(3200),
                      related_edges=[{"fact": unicode_text(3000)}])
        with patch.object(self.generator, "_print_generated_profile", return_value=None), \
                redirect_stdout(io.StringIO()):
            profiles = self.generator.generate_profiles_from_entities([item], parallel_count=1)
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0].generation_provenance,
                         {"version": 1, "route": "rule_fallback"})
        self.assertEqual(len(self.raw), 3)
        self.assertEqual(self.forwarded, [])
        self.assertEqual(self.sleeps, [1, 2, 3])

    def test_fitted_retries_reuse_messages_and_counted_temperatures(self):
        item, context = entity(), unicode_text(3000)
        self.reset_calls([RuntimeError("mocked transport failure"),
                          response("no usable fields", "length"), response()])
        profile = self.generate(item, context)
        self.assertEqual(profile.generation_provenance,
                         {"version": 1, "route": "model_json", "provider_reported_length": False})
        self.assertEqual(len(self.raw), 3)
        self.assertEqual(len(self.forwarded), 3)
        self.assertEqual(self.sleeps, [1])
        self.assertEqual([call["temperature"] for call in self.raw],
                         [0.7 - index * 0.1 for index in range(3)])
        self.assert_fit(item, context, self.raw[0])
        for call in self.raw:
            self.assertEqual(call["messages"], self.raw[0]["messages"])
            self.assertEqual(self.size(call), 3000)
        self.assertTrue(all(call["max_tokens"] == 2048 for call in self.forwarded))

    def test_gpt5_fitted_retries_omit_temperature_and_keep_output_cap(self):
        self.generator.model_name = " GPT-5-local "
        self.reset_calls([response("no usable fields"), response()])
        profile = self.generate(entity(), unicode_text(3000))
        self.assertEqual(profile.bio, "Bio")
        self.assertEqual(len(self.raw), 2)
        self.assertEqual(self.raw[0], self.raw[1])
        self.assertNotIn("temperature", self.raw[0])
        self.assertTrue(all(gateway._input_size(call) == 3000 for call in self.forwarded))
        self.assertTrue(all(call["max_tokens"] == 2048 for call in self.forwarded))

    def test_per_attempt_assembly_failure_and_message_isolation_are_preserved(self):
        for local in (False, True):
            with self.subTest(local=local):
                Config.LOCAL_MODE = local
                self.reset_calls([RuntimeError("mocked transport failure"), response()])
                actual_system_prompt = self.generator._get_system_prompt
                system_calls = []
                message_objects = []

                def system_prompt(individual):
                    system_calls.append(individual)
                    if len(system_calls) == 1:
                        raise RuntimeError("mocked system-message assembly failure")
                    return actual_system_prompt(individual)

                def completion(**request):
                    message_objects.append(request["messages"])
                    try:
                        return self.completion(**request)
                    finally:
                        # A provider-side mutation of a failed request cannot
                        # leak into the fresh next-attempt message container.
                        request["messages"][0]["content"] = "MUTATED SDK BOUNDARY"
                        request["messages"].append({"role": "user", "content": "UNRELATED"})

                with patch.object(self.generator, "_get_system_prompt", side_effect=system_prompt), \
                        patch.object(self.generator.client.chat.completions, "create", side_effect=completion):
                    profile = self.generate(entity(), unicode_text(3000))
                self.assertEqual(profile.generation_provenance,
                                 {"version": 1, "route": "model_json", "provider_reported_length": False})
                self.assertEqual(len(system_calls), 3)
                self.assertEqual(len(self.raw), 2)
                self.assertEqual(self.sleeps, [1, 2])
                self.assertEqual(self.raw[0]["messages"], self.raw[1]["messages"])
                self.assertIsNot(message_objects[0], message_objects[1])
                self.assertIsNot(message_objects[0][0], message_objects[1][0])
                self.assertEqual(len(self.raw[1]["messages"]), 2)

    def test_existing_local_json_repairs_keep_routes_without_extra_requests(self):
        cases = [
            ('  {"bio":"Bio","persona":"Persona"} \n', "length", "model_json", True),
            ('{"bio":"Bio","persona":"Persona', "length", "model_recovered_json", True),
            ('prefix {"bio":"Bio","persona":"Persona"}', "stop", "model_recovered_json", False),
            ('not json "bio":"Bio" trailing', "stop", "model_partial_fields", False),
        ]
        for content, finish, route, length in cases:
            with self.subTest(route=route, finish=finish):
                self.reset_calls([response(content, finish)])
                profile = self.generate(entity(), unicode_text(3000))
                self.assertEqual(profile.generation_provenance,
                                 {"version": 1, "route": route, "provider_reported_length": length})
                self.assertEqual(len(self.raw), 1)
                self.assertEqual(len(self.forwarded), 1)
                self.assertEqual(self.sleeps, [])

    def test_three_unusable_outputs_retain_existing_rule_fallback(self):
        self.reset_calls([response("no usable fields")] * 3)
        profile = self.generate(entity(), unicode_text(3000))
        self.assertEqual(profile.generation_provenance, {"version": 1, "route": "rule_fallback"})
        self.assertEqual(len(self.forwarded), 3)
        self.assertEqual(self.sleeps, [])
        self.assertTrue(all(gateway._input_size(call) == 3000 for call in self.forwarded))

    def test_template_profile_never_builds_context_or_sends_completion(self):
        with patch.object(self.generator, "_build_entity_context",
                          side_effect=AssertionError("Template retrieval is forbidden")):
            profile = self.generator.generate_profile_from_entity(entity(), 0, use_llm=False)
        self.assertEqual(profile.generation_provenance, {"version": 1, "route": "rule_requested"})
        self.assertEqual(self.raw, [])
        self.assertEqual(self.sleeps, [])


if __name__ == "__main__":
    unittest.main()
