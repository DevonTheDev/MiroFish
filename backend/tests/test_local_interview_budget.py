"""Default offline admission for the narrow local interview repair.

Prepared without execution. No heavyweight OASIS/CAMEL import is required.
Every model response is synthetic and every SDK request uses MockTransport.
"""
import asyncio
from contextlib import nullcontext
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import types

import httpx
from openai import APIConnectionError, APIStatusError, NOT_GIVEN
import pytest

from interview_seam.harness import MODE, PREFIX, Seam, source_scope


@pytest.fixture
def seam(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("The interview seam cannot start processes, threads, or network I/O")
    for owner, name in (
        (subprocess, "Popen"), (os, "system"), (threading.Thread, "start"),
        (socket.socket, "connect"), (socket.socket, "connect_ex"),
        (socket.socket, "bind"), (socket.socket, "listen"), (socket, "getaddrinfo"),
    ):
        monkeypatch.setattr(owner, name, forbidden)
    if hasattr(os, "fork"):
        monkeypatch.setattr(os, "fork", forbidden)
    value = Seam(monkeypatch)
    try:
        yield value
    finally:
        asyncio.run(asyncio.wait_for(value.close(), timeout=5.0))


async def refused(awaitable, status=413):
    with pytest.raises(APIStatusError) as caught:
        await awaitable
    assert caught.value.status_code == status


async def unchanged(seam, agent, prompt, *, invoke=None):
    """Compare inherited SDK body bytes with the exercised adapter path."""
    messages = seam.messages(agent, prompt)
    model = agent.model_backend.models[0]
    before = len(seam.wire)
    await refused(seam.CompatibleModel._arequest_chat_completion(model, messages))
    baseline = seam.wire[-1]["raw"]
    if invoke is None:
        await refused(seam.interview(agent, prompt))
    else:
        await refused(invoke(messages))
    assert seam.wire[-1]["raw"] == baseline
    assert len(seam.wire) == before + 2


@pytest.mark.parametrize("platform", ["twitter", "reddit"])
def test_source_bound_witness_and_sdk_body(seam, platform):
    async def run():
        agent = seam.make_agent(platform)
        prompt = seam.boundary_prompt(agent, history=True)
        original = seam.messages(agent, prompt)
        expected_original = seam.size(original)
        assert type(agent.model_backend.models[0].model_type) is seam.UnifiedModelType
        if platform == "twitter":
            assert len(agent.system_message.content) == 459
            assert expected_original == 24476
            assert len(prompt) == 23312
        assert len(prompt.split("现在我的新问题是：", 1)[0]) > 6000
        assert seam.size(original[1:]) == 24000
        await refused(seam.CompatibleModel._arequest_chat_completion(seam.model, original))
        baseline = seam.wire[-1]
        assert baseline["size"] == expected_original
        if MODE == "candidate":
            result = await seam.interview(agent, prompt)
            assert result["success"] is True
            assert result["prompt"][-1]["content"] == prompt
            assert len(result["prompt"]) == len(original)
            assert seam.wire[-1]["size"] == 24000
            assert seam.wire[-1]["payload"]["messages"] == original[1:]
            inherited = seam.attempts[-1]["messages"]
            for retained, owned in zip(inherited[:-1], agent.memory.records):
                assert retained is owned
            assert inherited[-1] is result["prompt"][-1]
            assert agent.env.action.calls == [(
                {"prompt": prompt, "response": "Synthetic interview answer"}, "interview"
            )]
        else:
            await refused(seam.interview(agent, prompt))
            assert seam.wire[-1]["raw"] == baseline["raw"]
            assert agent.env.action.calls == []
        assert len(seam.dispatches) == 1
        assert len(seam.wire) == len(seam.attempts) == 2
        assert agent.memory.reads == 1
        assert agent.memory.writes == []
        assert seam.model._async_client.max_retries == 0
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("case", ["original_exact", "original_over_one", "candidate_exact", "candidate_over_one", "irreducible"])
def test_budget_boundaries_keep_all_content(seam, case):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        duplicate = seam.size(seam.messages(agent, prompt)) - 24000
        if case == "original_exact":
            prompt = prompt[:-duplicate]
        elif case == "original_over_one":
            prompt = prompt[:-(duplicate - 1)]
        elif case == "candidate_over_one":
            prompt += "x"
        elif case == "irreducible":
            prompt = PREFIX + "x" * 24000
        original = seam.messages(agent, prompt)
        original_size = seam.size(original)
        if case in ("candidate_over_one", "irreducible"):
            await unchanged(seam, agent, prompt)
        else:
            result = await seam.interview(agent, prompt)
            assert result["content"] == "Synthetic interview answer"
            assert seam.wire[-1]["payload"]["messages"] == (original if case == "original_exact" else original[1:])
            assert seam.wire[-1]["size"] <= 24000
            if case == "original_exact":
                await seam.CompatibleModel._arequest_chat_completion(seam.model, original)
                assert seam.wire[-2]["raw"] == seam.wire[-1]["raw"]
            elif case == "original_over_one":
                assert original_size == 24001
            else:
                assert seam.wire[-1]["size"] == 24000
        assert len(seam.dispatches) == 1
        assert agent.memory.reads == 1
        assert agent.memory.writes == []
        assert len(seam.wire) == (2 if case in ("original_exact", "candidate_over_one", "irreducible") else 1)
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_unicode_actual_model_output_cap_and_reasoning(seam):
    async def run():
        seam.config.LLM_MODEL_NAME = "  local-🙂-model  "
        seam.config.LOCAL_MAX_OUTPUT_TOKENS = 37
        seam.config.LOCAL_REASONING_EFFORT = "low"
        seam.config.LOCAL_MAX_INPUT_CHARS = 1400
        agent = seam.make_agent()
        seam.model.model_config_dict["max_tokens"] = 91
        prompt = seam.boundary_prompt(agent, unicode=True)
        assert "🙂" in prompt and "𐐷" in prompt
        await seam.interview(agent, prompt)
        captured = seam.wire[0]
        assert captured["size"] == 1400
        assert captured["payload"]["max_tokens"] == 91
        assert captured["normalized"]["max_tokens"] == 37
        assert captured["normalized"]["reasoning_effort"] == "low"
        assert captured["normalized"]["model"] == "local-🙂-model"
        assert seam.size(captured["payload"]["messages"]) == captured["size"]
        assert len(seam.wire) == 1
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_interior_tool_records_are_retained_by_identity(seam):
    async def run():
        agent = seam.make_agent()
        assistant = {
            "role": "assistant", "content": None,
            "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "read_feed", "arguments": "{}"}}],
        }
        tool = {"role": "tool", "tool_call_id": "call_1", "content": "Complete local feed"}
        agent.memory.records.extend([assistant, tool])
        prompt = seam.boundary_prompt(agent)
        await seam.interview(agent, prompt)
        selected = seam.attempts[-1]["messages"]
        assert selected[-3] is assistant and selected[-2] is tool
        assert "tools" not in seam.wire[0]["payload"]
        assert len(seam.wire) == 1
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_fixed_owned_content_over_budget_preserves_refusal(seam):
    async def run():
        agent = seam.make_agent(content="Complete owned persona. " * 1100)
        prompt = PREFIX + "Keep this whole question"
        assert seam.size(seam.messages(agent, prompt)[1:]) > 24000
        await unchanged(seam, agent, prompt)
        assert agent.memory.reads == 1
        assert agent.env.action.calls == []
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_pinned_textprompt_custom_template_is_unchanged(seam):
    async def run():
        profile = seam.UserInfo(profile={"name": "A complete custom persona"})
        content = profile.to_custom_system_message(seam.TextPrompt("{name}: follow every instruction"))
        assert type(content) is seam.TextPrompt
        agent = seam.make_agent(content=content)
        prompt = seam.boundary_prompt(agent)
        await unchanged(seam, agent, prompt)
        assert agent.system_message.content is content
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("kind", ["plain_full", "split_marker"])
def test_plain_owned_custom_content_and_split_marker(seam, kind):
    async def run():
        content = "A complete custom plain-string persona with all instructions"
        if kind == "split_marker":
            content += "# RESPONSE FORMAT\nAn instruction after the marker"
        agent = seam.make_agent(content=content)
        prompt = seam.boundary_prompt(agent)
        if kind == "plain_full":
            await seam.interview(agent, prompt)
            assert seam.wire[0]["payload"]["messages"][0]["content"] == content
            assert len(seam.wire) == 1
        else:
            await unchanged(seam, agent, prompt)
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("case", [
    "cloud", "direct", "wrong_owner", "wrong_model", "manager_subclass",
    "agent_subclass", "model_subclass", "agent_method", "manager_method",
    "model_method", "custom_strategy", "record_enabled",
])
def test_ineligible_ownership_and_implementation_are_byte_identical(seam, case):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        model = seam.model
        invoke = None
        if case == "cloud":
            seam.config.LOCAL_MODE = False
        elif case == "direct":
            invoke = lambda messages: model.arun(messages)
        elif case == "wrong_owner":
            other = seam.make_agent(model=model, content="Another agent's complete persona")
            async def invoke(messages):
                with source_scope(seam, other, prompt):
                    return await model.arun(messages)
        elif case == "wrong_model":
            other_model = seam.policy.create_local_model()
            async def invoke(messages):
                with source_scope(seam, agent, prompt):
                    return await other_model.arun(messages)
        elif case == "manager_subclass":
            agent.model_backend.__class__ = type("CustomManager", (seam.ModelManager,), {})
        elif case == "agent_subclass":
            agent.__class__ = type("CustomAgent", (seam.SocialAgent,), {})
        elif case == "model_subclass":
            model.__class__ = type("CustomModel", (type(model),), {})
        elif case == "agent_method":
            agent.perform_interview = types.MethodType(seam.SocialAgent.perform_interview, agent)
        elif case == "manager_method":
            agent.model_backend.arun = types.MethodType(seam.ModelManager.arun, agent.model_backend)
        elif case == "model_method":
            model._arun = types.MethodType(seam.CompatibleModel._arun, model)
        elif case == "custom_strategy":
            agent.model_backend.scheduling_strategy = lambda: model
        elif case == "record_enabled":
            agent.interview_record = True
        await unchanged(seam, agent, prompt, invoke=invoke)
        if case == "record_enabled":
            assert len(agent.memory.writes) == 1  # inherited pre-request write; refusal prevents response write
        else:
            assert agent.memory.writes == []
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("change", ["first_role", "first_content", "first_metadata", "second_content", "last_role", "last_content", "last_metadata"])
def test_message_boundaries_are_not_guessed(seam, change):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        messages = seam.messages(agent, prompt)
        if change == "first_role":
            messages[0]["role"] = "developer"
        elif change == "first_content":
            messages[0]["content"] += "changed"
        elif change == "first_metadata":
            messages[0]["name"] = "persona"
        elif change == "second_content":
            messages[1] = {**messages[1], "content": messages[1]["content"] + "changed"}
        elif change == "last_role":
            messages[-1]["role"] = "assistant"
        elif change == "last_content":
            messages[-1]["content"] += "changed"
        else:
            messages[-1]["name"] = "question"
        await refused(seam.CompatibleModel._arequest_chat_completion(seam.model, messages))
        baseline = seam.wire[-1]["raw"]
        with source_scope(seam, agent, prompt):
            await refused(seam.model._arequest_chat_completion(messages))
        assert seam.wire[-1]["raw"] == baseline
        assert seam.attempts[-1]["messages"] is messages
        assert len(seam.wire) == 2
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("tools", [None, [], [{"type": "function", "function": {"name": "read_feed", "parameters": {"type": "object"}}}]])
def test_hook_tools_none_empty_and_schema_are_distinct(seam, tools):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        messages = seam.messages(agent, prompt)
        with source_scope(seam, agent, prompt):
            if tools is None:
                await seam.model._arequest_chat_completion(messages, tools)
                assert seam.attempts[-1]["messages"] is not messages
            else:
                await refused(seam.model._arequest_chat_completion(messages, tools))
                assert seam.attempts[-1]["messages"] is messages
        assert len(seam.wire) == 1
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("key,value", [
    ("tools", []), ("tools", [{"type": "function", "function": {"name": "x"}}]),
    ("extra_body", {"custom": "preserve"}), ("extra_headers", {"X-Seam": "preserve"}),
    ("extra_query", {"fixture": "preserve"}), ("timeout", 0.5),
    ("stream", False), ("temperature", 0.0), ("reasoning_effort", "low"),
])
def test_configuration_additions_are_passed_through(seam, key, value):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        seam.model.model_config_dict[key] = value
        await unchanged(seam, agent, prompt)
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("kind", ["create_instance", "resource_wrapper", "client_wrapper"])
def test_custom_sdk_boundary_is_byte_identical(seam, kind):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        client = seam.model._async_client
        resource = client.chat.completions
        if kind == "create_instance":
            resource.create = resource.create
        elif kind == "resource_wrapper":
            client.chat.completions = types.SimpleNamespace(create=resource.create)
        else:
            seam.model._async_client = types.SimpleNamespace(chat=client.chat)
        await unchanged(seam, agent, prompt)
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("kind", ["sentinel", "custom_int", "nonfinite", "nonjson", "custom_dict", "custom_model", "invalid_model", "invalid_output", "duplicate_model", "duplicate_messages"])
def test_unsupported_values_preserve_request_or_original_error(seam, kind):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        messages = seam.messages(agent, prompt)
        if kind == "sentinel":
            seam.model.model_config_dict["max_tokens"] = NOT_GIVEN
        elif kind == "custom_int":
            seam.model.model_config_dict["max_tokens"] = type("Number", (int,), {})(2048)
        elif kind == "nonfinite":
            seam.model.model_config_dict["max_tokens"] = float("nan")
        elif kind == "nonjson":
            messages[2]["content"] = object()
        elif kind == "custom_dict":
            messages[2] = type("Message", (dict,), {})(messages[2])
        elif kind == "custom_model":
            seam.model.model_type = type("Model", (str,), {})("mirofish-local")
        elif kind == "invalid_model":
            seam.model.model_type = seam.UnifiedModelType("   ")
        elif kind == "invalid_output":
            seam.model.model_config_dict["max_tokens"] = True
        elif kind == "duplicate_model":
            seam.model.model_config_dict["model"] = "duplicate"
        else:
            seam.model.model_config_dict["messages"] = messages
        outcomes = []
        for scoped in (False, True):
            try:
                with source_scope(seam, agent, prompt) if scoped else nullcontext():
                    result = await (seam.model._arequest_chat_completion(messages) if scoped else
                                    seam.CompatibleModel._arequest_chat_completion(seam.model, messages))
                outcomes.append(("success", type(result)))
            except Exception as error:
                outcomes.append((type(error), str(error)))
        assert outcomes[0] == outcomes[1]
        assert seam.attempts[-1]["messages"] is messages
        assert len(seam.attempts) == 2
        assert len(seam.wire) in (0, 2)
        if seam.wire:
            assert seam.wire[0]["raw"] == seam.wire[1]["raw"]
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("failure_at", [1, 2])
def test_sizing_exception_or_final_recount_failure_is_unchanged(seam, monkeypatch, failure_at):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        original = seam.gateway._normalize_payload
        calls = 0
        def fail_once(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == failure_at:
                raise ValueError("synthetic sizing failure")
            return original(*args, **kwargs)
        monkeypatch.setattr(seam.gateway, "_normalize_payload", fail_once)
        await refused(seam.interview(agent, prompt))
        assert seam.wire[0]["payload"]["messages"] == seam.messages(agent, prompt)
        assert len(seam.wire) == 1
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("change", ["system_object", "system_content", "memory", "manager", "backend", "owner_binding"])
def test_changed_binding_while_waiting_masks_repair(seam, change):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        env = seam.environment(semaphore=0)
        task = asyncio.create_task(seam.interview(agent, prompt, env))
        await asyncio.sleep(0)
        assert not seam.wire and len(seam.dispatches) == 1
        if change == "system_object":
            agent._system_message = seam.BaseMessage.make_assistant_message("system", agent.system_message.content)
        elif change == "system_content":
            agent._system_message.content += "changed"
        elif change == "memory":
            agent._memory = type(agent.memory)(agent.memory.records)
        elif change == "manager":
            agent.model_backend = seam.ModelManager(seam.model)
        elif change == "backend":
            agent.model_backend.models[0] = seam.policy.create_local_model()
            agent.model_backend.models_cycle = iter(agent.model_backend.models)
            agent.model_backend.scheduling_strategy = agent.model_backend.round_robin
        else:
            agent.perform_interview = types.MethodType(seam.SocialAgent.perform_interview, agent)
        env.llm_semaphore.release()
        await refused(task)
        assert len(seam.wire) == 1
        assert len(seam.wire[0]["payload"]["messages"]) == 5
        assert agent.memory.reads == 1
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_shared_model_overlapping_platform_stress_isolated(seam):
    async def run():
        one = seam.make_agent("twitter", agent_id=1)
        two = seam.make_agent("reddit", model=seam.model, agent_id=2)
        prompts = [seam.boundary_prompt(one), seam.boundary_prompt(two)]
        seam.transport_release = asyncio.Event()
        tasks = [asyncio.create_task(seam.interview(agent, prompt)) for agent, prompt in zip((one, two), prompts)]
        for _ in range(20):
            if len(seam.wire) == 2:
                break
            await asyncio.sleep(0)
        assert len(seam.wire) == 2, "both mock requests must overlap before releasing transport"
        seam.transport_release.set()
        results = await asyncio.gather(*tasks)
        assert [result["user_id"] for result in results] == [1, 2]
        assert {record["payload"]["messages"][-1]["content"] for record in seam.wire} == set(prompts)
        assert all(record["size"] == 24000 for record in seam.wire)
        assert [one.memory.reads, two.memory.reads] == [1, 1]
        assert len(one.env.action.calls) == len(two.env.action.calls) == 1
        assert len(seam.dispatches) == 2
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_nested_ineligible_scope_masks_then_restores_outer(seam):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        messages = seam.messages(agent, prompt)
        with source_scope(seam, agent, prompt):
            outer = seam.policy._interview_scope.get()
            async def unsupported_interview(received):
                assert seam.policy._interview_scope.get() is None
                assert received == prompt
                return await seam.model.arun(messages)
            unsupported = types.SimpleNamespace(perform_interview=unsupported_interview)
            await refused(seam.interview(unsupported, prompt))
            assert seam.policy._interview_scope.get() is outer
            await seam.model.arun(messages)
        assert seam.policy._interview_scope.get() is None
        assert [record["status"] for record in seam.wire] == [413, 200]
        assert len(seam.wire) == 2
        assert len(seam.dispatches) == 1
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_nested_eligible_dispatch_restores_outer_owner(seam):
    async def run():
        outer_agent = seam.make_agent(agent_id=11)
        inner_agent = seam.make_agent(model=seam.model, content="Owned inner persona", agent_id=12)
        outer_prompt = seam.boundary_prompt(outer_agent)
        inner_prompt = seam.boundary_prompt(inner_agent)
        with source_scope(seam, outer_agent, outer_prompt):
            outer = seam.policy._interview_scope.get()
            result = await seam.interview(inner_agent, inner_prompt)
            assert result["user_id"] == 12
            assert seam.policy._interview_scope.get() is outer
            await seam.model.arun(seam.messages(outer_agent, outer_prompt))
        assert seam.policy._interview_scope.get() is None
        assert len(seam.dispatches) == 1
        assert len(seam.wire) == 2
        assert [record["payload"]["messages"][-1]["content"] for record in seam.wire] == [inner_prompt, outer_prompt]
        assert all(record["size"] == 24000 for record in seam.wire)
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_changed_manager_during_provider_wait_is_rechecked_on_retry(seam):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        seam.statuses[:] = [429]
        seam.transport_release = asyncio.Event()
        task = asyncio.create_task(seam.interview(agent, prompt))
        await seam.transport_started.wait()
        agent.model_backend = seam.ModelManager(seam.model)
        seam.transport_release.set()
        await refused(task)
        assert [record["status"] for record in seam.wire] == [429, 413]
        assert len(seam.wire[0]["payload"]["messages"]) == 4
        assert len(seam.wire[1]["payload"]["messages"]) == 5
        assert len(seam.dispatches) == agent.memory.reads == 1
        assert agent.env.action.calls == []
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("after_reset", [False, True])
def test_inherited_detached_child_task_cannot_use_scope(seam, after_reset):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        messages = seam.messages(agent, prompt)
        gate = asyncio.Event()
        async def detached():
            await gate.wait()
            await refused(seam.model.arun(messages))
        with source_scope(seam, agent, prompt):
            task = asyncio.create_task(detached())
            if not after_reset:
                gate.set()
                await task
        if after_reset:
            gate.set()
            await task
        assert seam.policy._interview_scope.get() is None
        assert len(seam.wire) == 1
        assert seam.attempts[0]["messages"] is messages
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("phase", ["semaphore", "request", "persistence"])
def test_cancellation_restores_scope_and_preserves_inherited_counts(seam, phase):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        env = seam.environment(semaphore=0 if phase == "semaphore" else 1)
        if phase == "request":
            seam.transport_release = asyncio.Event()
        if phase == "persistence":
            agent.env.action.release = asyncio.Event()
        observed = []
        async def action():
            try:
                await seam.interview(agent, prompt, env)
            finally:
                observed.append(seam.policy._interview_scope.get())
        task = asyncio.create_task(action())
        if phase == "semaphore":
            await asyncio.sleep(0)
        elif phase == "request":
            await seam.transport_started.wait()
        else:
            await agent.env.action.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert observed == [None]
        assert len(seam.dispatches) == 1
        assert len(seam.wire) == (0 if phase == "semaphore" else 1)
        assert agent.memory.reads == (0 if phase == "semaphore" else 1)
        assert len(agent.env.action.calls) == (1 if phase == "persistence" else 0)
        assert agent.memory.writes == []
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))


@pytest.mark.parametrize("failure", ["rate_then_ok", "rate_exhausted", "provider_500", "transport", "persistence"])
def test_inherited_retry_errors_and_persistence_counts(seam, failure):
    async def run():
        agent = seam.make_agent()
        prompt = seam.boundary_prompt(agent)
        if failure == "rate_then_ok":
            seam.statuses[:] = [429, 200]
            await seam.interview(agent, prompt)
        elif failure == "rate_exhausted":
            seam.statuses[:] = [429, 429]
            from interview_seam.harness import ModelProcessingError
            with pytest.raises(ModelProcessingError):
                await seam.interview(agent, prompt)
        elif failure == "provider_500":
            seam.statuses[:] = [500]
            await refused(seam.interview(agent, prompt), 500)
        elif failure == "transport":
            seam.transport_failure = httpx.ConnectError("synthetic transport failure")
            with pytest.raises(APIConnectionError):
                await seam.interview(agent, prompt)
        else:
            error = RuntimeError("synthetic persistence error")
            agent.env.action.failure = error
            with pytest.raises(RuntimeError) as caught:
                await seam.interview(agent, prompt)
            assert caught.value is error
        count = 2 if failure.startswith("rate_") else 1
        assert len(seam.wire) == len(seam.attempts) == count
        assert len(seam.dispatches) == agent.memory.reads == 1
        assert agent.memory.writes == []
        assert len(agent.env.action.calls) == (1 if failure in ("rate_then_ok", "persistence") else 0)
        assert seam.policy._interview_scope.get() is None
    asyncio.run(asyncio.wait_for(run(), timeout=5.0))

