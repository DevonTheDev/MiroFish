"""Self-contained local ontology budget regressions; no model or server needed."""
from copy import deepcopy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.config import Config
from app.local_runtime.gateway import GatewaySettings, _input_size, _prepare_payload
from app.services.ontology_generator import OntologyGenerator, LocalOntologyInputBudgetError
from app.utils.llm_client import LLMClient


def source_text(length):
    unit = "Alpha世界🙂0123456789"
    return (unit * (length // len(unit) + 1))[:length]


class LocalOntologyBudgetRegression(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.multiple(
            Config, LOCAL_MODE=True, LOCAL_MAX_INPUT_CHARS=24000,
            LOCAL_MAX_OUTPUT_TOKENS=2048, LOCAL_REASONING_EFFORT="none",
        ))
        self.attempted = []
        self.forwarded = []
        settings = GatewaySettings(
            "http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1",
            reasoning_effort="none",
        )

        def completion(**payload):
            self.attempted.append(deepcopy(payload))
            self.forwarded.append(_prepare_payload("/v1/chat/completions", payload, settings))
            self.assertEqual(len(self.forwarded), 1, "No extra provider attempts are needed")
            return SimpleNamespace(choices=[SimpleNamespace(
                finish_reason="stop", message=SimpleNamespace(content=json.dumps({
                    "entity_types": [{"name": "Person"}, {"name": "Organization"}],
                    "edge_types": [{"name": "WORKS_FOR", "source_targets": [
                        {"source": "Person", "target": "Organization"}
                    ]}],
                    "analysis_summary": "Mocked source analysis.",
                })),
            )])

        client = LLMClient.__new__(LLMClient)
        client.model = "mirofish-local"
        client.client = SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=completion),
        ))
        self.generator = OntologyGenerator(client)

    def test_24000_character_source_fits_default_local_request_limit(self):
        documents = [source_text(24000)]
        original = deepcopy(documents)
        result = self.generator.generate(documents, "Simulate discussion.", "Keep the regional context.")
        self.assertIn("entity_types", result)
        self.assertEqual(documents, original)
        self.assertEqual(len(self.attempted), 1)
        self.assertEqual(len(self.forwarded), 1)
        self.assertLessEqual(_input_size(self.forwarded[0]), 24000)
        self.assertEqual(self.forwarded[0]["max_tokens"], 2048)
        content = self.attempted[0]["messages"][1]["content"]
        self.assertIn("Simulate discussion.", content)
        self.assertIn("Keep the regional context.", content)
        self.assertIn("【长文本自动分块摘要】", content)
        self.assertNotIn(documents[0], content)
        for chunk in self.generator._collect_document_chunks(documents):
            self.assertIn(f"--- 文档 {chunk['document_index']} / 分块 "
                          f"{chunk['chunk_index']}/{chunk['total_document_chunks']} ---", content)

    def test_oversized_fixed_content_refuses_before_completion(self):
        with self.assertRaises(LocalOntologyInputBudgetError) as caught:
            self.generator.generate(["PRIVATE-SOURCE"], "PRIVATE-REQUIREMENT" + source_text(24000))
        self.assertEqual(caught.exception.reason, "fixed_content")
        self.assertNotIn("PRIVATE", str(caught.exception))
        self.assertEqual(self.attempted, [])
        self.assertEqual(self.forwarded, [])

    def test_minimum_representative_sample_refuses_before_completion(self):
        documents = [source_text(650000)]
        chunks = self.generator._collect_document_chunks(documents)
        self.assertGreater(len(chunks), 60)
        self.assertEqual(len(self.generator._select_representative_chunks(chunks)), 60)
        with self.assertRaises(LocalOntologyInputBudgetError) as caught:
            self.generator.generate(documents, "Simulate discussion.")
        self.assertEqual(caught.exception.reason, "minimum_sample")
        self.assertEqual(self.attempted, [])
        self.assertEqual(self.forwarded, [])
