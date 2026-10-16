"""Isolated real-method seam; see README.md for every substitution.

Nothing executes a dependency slice until a released pytest invocation requests
the fixture. Source preparation/import-independent AST review is not a test run.
"""
from __future__ import annotations

import ast
import asyncio
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
import hashlib
import importlib.util
import inspect
from itertools import cycle
import json
import logging
import os
from pathlib import Path
import random
import re
import sys
from threading import Lock
import types
from typing import cast
import warnings

import httpx
from openai import AsyncOpenAI, RateLimitError
from openai.types.chat import ChatCompletion

HERE = Path(__file__).resolve().parent
REPOSITORY = Path(__file__).resolve().parents[3]
SOURCE_ROOT = Path(os.environ.get("MIRO_INTERVIEW_SOURCE_ROOT", REPOSITORY))
MODE = os.environ.get("MIRO_INTERVIEW_EXPECT", "candidate")
PREFIX = "结合你的人设、所有的过往记忆与行动，不调用任何工具直接用文本回复我："


class BackendRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class RoleType(Enum):
    USER = "user"
    ASSISTANT = "assistant"


class VisionDetail(str, Enum):
    AUTO = "auto"
    LOW = "low"
    HIGH = "high"


class ModelProcessingError(Exception):
    pass


class Memory:
    """Declared context-creator replacement; returns the same owned records."""
    def __init__(self, records):
        self.records = records
        self.reads = 0
        self.writes = []

    def get_context(self):
        self.reads += 1
        return self.records, 776


class Persistence:
    """Declared channel/action replacement, retaining the real invocation."""
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.release = None
        self.failure = None

    async def perform_action(self, data, action):
        self.calls.append((data, action))
        self.started.set()
        if self.release is not None:
            await self.release.wait()
        if self.failure is not None:
            raise self.failure
        return {"success": True}


def _package(monkeypatch, name):
    module = types.ModuleType(name)
    module.__path__ = []
    monkeypatch.setitem(sys.modules, name, module)
    if "." in name:
        parent, leaf = name.rsplit(".", 1)
        setattr(sys.modules[parent], leaf, module)
    return module


def _load_source(monkeypatch, name, path, extra=None):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    module.__package__ = name.rpartition(".")[0]
    module.__dict__.update(extra or {})
    monkeypatch.setitem(sys.modules, name, module)
    exec(compile(path.read_text(), str(path), "exec"), module.__dict__)
    if "." in name and name.rpartition(".")[0] in sys.modules:
        setattr(sys.modules[name.rpartition(".")[0]], name.rpartition(".")[2], module)
    return module


class Seam:
    """A single finite in-process transport and isolated module namespace."""
    def __init__(self, monkeypatch):
        self.monkeypatch = monkeypatch
        self.wire = []
        self.attempts = []
        self.dispatches = []
        self.frames = []
        self.clients = []
        self.statuses = []
        self.transport_started = asyncio.Event()
        self.transport_release = None
        self.transport_failure = None
        self.config = types.SimpleNamespace(
            LOCAL_MODE=True, LLM_MODEL_NAME="mirofish-local",
            LOCAL_CONTEXT_TOKENS=8192, LOCAL_MAX_OUTPUT_TOKENS=2048,
            LOCAL_MAX_INPUT_CHARS=24000, LOCAL_REASONING_EFFORT="none",
            LOCAL_REQUEST_TIMEOUT=1.0, LOCAL_MAX_CONCURRENCY=2,
        )
        self._install()
        self.previous_profile = sys.getprofile()
        sys.setprofile(self._profile)

    def _profile(self, frame, event, arg):
        if event != "call":
            return
        filename = frame.f_code.co_filename
        name = frame.f_code.co_name
        if filename.endswith("oasis__environment__env.py.txt") and name == "_perform_interview_action":
            target = self.dispatches
        elif filename.endswith("camel__models__openai_compatible_model.py.txt") and name == "_arequest_chat_completion":
            target = self.attempts
        else:
            return
        if any(frame is old for old in self.frames):
            return
        self.frames.append(frame)
        target.append(dict(frame.f_locals))

    def _install(self):
        mp = self.monkeypatch
        manifest = json.loads((HERE / "source-bindings.json").read_text())
        for entry in manifest["sources"]:
            raw = (HERE / entry["file"]).read_bytes()
            assert hashlib.sha256(raw).hexdigest() == entry["slice_sha256"], entry["file"]
        for package in (
            "camel", "camel.agents", "camel.models", "camel.messages",
            "camel.memories", "camel.types", "camel.prompts", "camel.utils",
            "oasis", "oasis.environment", "oasis.social_agent",
            "oasis.social_platform", "oasis.social_platform.config",
            "app", "app.local_runtime",
        ):
            _package(mp, package)
        # Configuration/lifecycle are supplied explicitly; no gateway is started.
        config_module = types.ModuleType("app.config")
        config_module.Config = self.config
        mp.setitem(sys.modules, "app.config", config_module)
        local = sys.modules["app.local_runtime"]
        local.configure_local_environment = lambda: None
        local.get_local_gateway_url = lambda: "http://interview.invalid/v1"
        logger = logging.getLogger("interview-seam")
        logger.disabled = True
        common = dict(
            asyncio=asyncio, logger=logger, agent_log=logger, os=os,
            random=random, cycle=cycle, choice=random.choice, dataclass=dataclass,
            Lock=Lock, cast=cast, Enum=Enum, logging=logging, inspect=inspect,
            warnings=warnings, re=re, json=json,
            observe=lambda **kw: (lambda function: function),
            RoleType=RoleType, OpenAIBackendRole=BackendRole,
            OpenAIVisionDetailType=VisionDetail, RateLimitError=RateLimitError,
            ChatCompletion=ChatCompletion, ModelProcessingError=ModelProcessingError,
            get_current_agent_session_id=lambda: None,
            update_langfuse_trace=lambda **kw: None,
            ActionType=types.SimpleNamespace(INTERVIEW=types.SimpleNamespace(value="interview")),
        )
        by_class = {entry["class"]: entry for entry in manifest["sources"]}

        def load(cls, extra=None):
            item = by_class[cls]
            module = _load_source(mp, item["module"], HERE / item["file"], {**common, **(extra or {})})
            value = getattr(module, cls)
            common[cls] = value
            return value

        self.UnifiedModelType = load("UnifiedModelType")
        sys.modules["camel.types"].UnifiedModelType = self.UnifiedModelType
        self.BaseMessage = load("BaseMessage")
        sys.modules["camel.messages"].BaseMessage = self.BaseMessage
        self.MemoryRecord = load("MemoryRecord")
        self.BaseModelBackend = load("BaseModelBackend")
        self.BaseModelBackend._log_request = lambda model, messages: None
        self.BaseModelBackend._log_response = lambda model, path, result: None
        self.CompatibleModel = load("OpenAICompatibleModel")

        def initialize(model, model_type, model_config_dict=None, api_key=None,
                       url=None, token_counter=None, timeout=None, max_retries=3, **kwargs):
            self.BaseModelBackend.__init__(
                model, model_type, model_config_dict, api_key, url,
                token_counter, timeout, max_retries,
            )
            client = AsyncOpenAI(
                api_key=api_key, base_url=url, timeout=timeout,
                max_retries=max_retries,
                http_client=httpx.AsyncClient(
                    transport=httpx.MockTransport(self._transport),
                    trust_env=False, timeout=timeout,
                ),
            )
            # Fixture-only: bypass the SDK's platform/subprocess probe.
            client._platform = "Unknown"
            model._async_client = client
            model._client = None
            self.clients.append(client)

        self.CompatibleModel.__init__ = initialize
        self.ModelManager = load("ModelManager")
        sys.modules["camel.models"].ModelManager = self.ModelManager
        sys.modules["camel.models"].BaseModelBackend = self.BaseModelBackend
        self.ChatAgent = load("ChatAgent")
        sys.modules["camel.agents"].ChatAgent = self.ChatAgent
        self.ChatAgent._sanitize_messages_for_logging = lambda agent, messages, previous: messages
        self.ChatAgent._handle_batch_response = lambda agent, response: types.SimpleNamespace(
            output_messages=[types.SimpleNamespace(content=response.choices[0].message.content)]
        )
        self.SocialAgent = load("SocialAgent")
        sys.modules["oasis.social_agent"].SocialAgent = self.SocialAgent
        self.OasisEnv = load("OasisEnv")
        self.OasisEnv.__init__ = lambda env, semaphore=2, **kwargs: setattr(
            env, "llm_semaphore", asyncio.Semaphore(semaphore)
        )
        # TextPrompt's actual decorator/class is loaded; only its key parser is substituted.
        sys.modules["camel.utils"].get_prompt_template_key_words = lambda template: set(
            re.findall(r"{(\w+)}", template)
        )
        self.TextPrompt = load("TextPrompt")
        sys.modules["camel.prompts"].TextPrompt = self.TextPrompt
        self.UserInfo = load("UserInfo")
        self.gateway = _load_source(
            mp, "app.local_runtime.gateway",
            SOURCE_ROOT / "backend/app/local_runtime/gateway.py",
        )
        self.policy = _load_source(
            mp, "app.local_runtime.oasis",
            SOURCE_ROOT / "backend/app/local_runtime/oasis.py",
        )
        if MODE == "control":
            @contextmanager
            def no_scope(agent, prompt):
                yield
            mp.setattr(self.policy, "_local_interview_scope", no_scope)
        self.runtime = _load_source(
            mp, "interview_oasis_runtime", SOURCE_ROOT / "backend/scripts/oasis_runtime.py",
        )

    async def _transport(self, request):
        assert request.url.host == "interview.invalid"
        assert request.url.path == "/v1/chat/completions"
        assert len(self.wire) < 4, "finite per-fixture SDK request ceiling exceeded"
        raw = request.content
        payload = json.loads(raw)
        record = {"raw": raw, "payload": payload, "headers": dict(request.headers)}
        self.wire.append(record)
        self.transport_started.set()
        if self.transport_release is not None:
            await self.transport_release.wait()
        if self.transport_failure is not None:
            raise self.transport_failure
        try:
            normalized = self.normalize(payload)
            record["normalized"] = normalized
            record["size"] = self.gateway._input_size(normalized)
            settings = self.gateway.GatewaySettings(
                "http://127.0.0.1:1/v1", "http://127.0.0.1:1/v1",
                max_output_tokens=self.config.LOCAL_MAX_OUTPUT_TOKENS,
                max_input_chars=self.config.LOCAL_MAX_INPUT_CHARS,
                reasoning_effort=self.config.LOCAL_REASONING_EFFORT,
            )
            admitted = self.gateway._prepare_payload("/v1/chat/completions", payload, settings)
            assert admitted == normalized
            code = 200
        except self.gateway._GatewayError as error:
            record["normalization_error"] = str(error)
            code = error.status
        if self.statuses:
            code = self.statuses.pop(0)
        record["status"] = code
        if code != 200:
            return httpx.Response(code, json={"error": {"message": "synthetic refusal", "type": "seam_error"}}, request=request)
        return httpx.Response(200, json={
            "id": "interview-seam", "object": "chat.completion", "created": 1,
            "model": str(payload["model"]),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "Synthetic interview answer"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }, request=request)

    def normalize(self, payload):
        return self.gateway._normalize_payload(
            "/v1/chat/completions", payload,
            max_output_tokens=self.config.LOCAL_MAX_OUTPUT_TOKENS,
            reasoning_effort=self.config.LOCAL_REASONING_EFFORT,
        )

    def size(self, messages, model=None):
        if model is None:
            model = self.model
        return self.gateway._input_size(self.normalize({
            "model": model.model_type, "messages": messages,
            **model.model_config_dict,
        }))

    def make_agent(self, platform="twitter", *, model=None, content=None, agent_id=7):
        if model is None:
            model = self.policy.create_local_model()
        self.model = model
        user = self.UserInfo(
            name="local_reader",
            profile={"other_info": {
                "user_profile": "I am a local resident who follows community news and compares practical effects on everyday life.",
                "gender": "person", "age": 30, "mbti": "INTJ", "country": "example",
            }},
            recsys_type=platform,
        )
        system = self.BaseMessage.make_assistant_message(
            role_name="system", content=user.to_system_message() if content is None else content,
        )
        record = object.__new__(self.MemoryRecord)
        record.message, record.role_at_backend = system, BackendRole.SYSTEM
        memory = Memory([
            record.to_openai_message(),
            {"role": "user", "content": "Please review the current community discussion."},
            {"role": "assistant", "content": "I will compare the concerns expressed by local residents."},
        ])
        agent = object.__new__(self.SocialAgent)
        agent._system_message, agent._memory = system, memory
        agent.model_backend = self.ModelManager(model, scheduling_strategy="random_model")
        agent.interview_record, agent.social_agent_id = False, agent_id
        agent.retry_attempts, agent.retry_delay = 2, 0
        agent.env = types.SimpleNamespace(action=Persistence())
        agent.update_memory = lambda **record: memory.writes.append(record)
        return agent

    def messages(self, agent, prompt):
        return [{
            "role": agent.system_message.role_name,
            "content": agent.system_message.content.split("# RESPONSE FORMAT")[0],
        }, *agent.memory.records, {"role": "user", "content": prompt}]

    def boundary_prompt(self, agent, *, delta=0, history=False, unicode=False):
        retained = self.messages(agent, "")[1:]
        fixed = self.size(retained, agent.model_backend.models[0])
        length = self.config.LOCAL_MAX_INPUT_CHARS - fixed + delta
        prefix = PREFIX
        if history:
            turns = []
            for index in range(6):
                label = "提问者" if index % 2 == 0 else "你"
                content = ("Earlier community question. " if index % 2 == 0 else "Earlier community answer. ")
                turns.append(f"{label}：" + (content * 100)[:1000])
            prefix += "以下是我们之前的对话：\n" + "\n".join(turns) + "\n\n现在我的新问题是："
        assert length >= len(prefix)
        tail = (("𐐷🙂漢" if unicode else "Please assess this detailed community background. ") * length)[:length-len(prefix)]
        return prefix + tail

    def environment(self, semaphore=2):
        return self.runtime.make_oasis_environment(semaphore=semaphore)

    async def interview(self, agent, prompt, env=None):
        return await (env or self.environment())._perform_interview_action(agent, prompt)

    async def close(self):
        sys.setprofile(self.previous_profile)
        self.frames.clear()
        for client in self.clients:
            await client.close()


@contextmanager
def source_scope(seam, agent, prompt):
    """Baseline lacks the hook; used only for ineligible/direct request tests."""
    scope = getattr(seam.policy, "_local_interview_scope", None)
    if scope is None:
        yield
    else:
        with scope(agent, prompt):
            yield

