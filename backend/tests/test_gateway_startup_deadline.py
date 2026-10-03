"""Shared startup deadlines never orphan or multiply gateway workers."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
import threading
import time

import httpx
import pytest

from app import local_runtime
from app.config import Config
from app.local_runtime import gateway as module


@pytest.fixture
def shared(monkeypatch):
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "validate", lambda: [])
    monkeypatch.setattr(Config, "LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setattr(local_runtime, "configure_local_environment", lambda: None)
    monkeypatch.setattr(local_runtime, "_gateway", None)
    monkeypatch.setattr(local_runtime, "_gateway_starting", None, raising=False)
    monkeypatch.setattr(local_runtime, "_gateway_lock", threading.Lock())
    monkeypatch.delenv("MIROFISH_LOCAL_GATEWAY_URL", raising=False)
    callbacks = []
    monkeypatch.setattr(local_runtime, "register_shutdown_callback", lambda phase, fn: callbacks.append((phase, fn)))
    yield callbacks
    local_runtime.close_local_gateway()


def new_gateway():
    return module.LocalInferenceGateway(module.GatewaySettings("http://127.0.0.1:9/v1", "http://127.0.0.1:9/v1"))


def test_shared_lock_contention_obeys_absolute_deadline_without_workers(shared):
    before = {thread.ident for thread in threading.enumerate()}
    with local_runtime._gateway_lock:
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            local_runtime.get_local_gateway_url(deadline_monotonic=started + 0.05)
        assert time.monotonic() - started < 0.4
    assert local_runtime._gateway is None
    assert {thread.ident for thread in threading.enumerate()} == before
    assert shared == []


def test_instance_lock_timeout_does_not_close_an_existing_live_gateway(shared):
    url = local_runtime.get_local_gateway_url()
    gateway = local_runtime._gateway
    with gateway._lock:
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            local_runtime.get_local_gateway_url(deadline_monotonic=started + 0.05)
        assert time.monotonic() - started < 0.4
    with httpx.Client(trust_env=False) as client:
        assert client.get(url.removesuffix("/v1") + "/health").status_code == 200
    assert local_runtime._gateway is gateway


def test_expired_deadline_never_constructs_a_gateway(shared, monkeypatch):
    monkeypatch.setattr(module, "LocalInferenceGateway", lambda *_args: pytest.fail("Expired request created a gateway"))
    with pytest.raises(TimeoutError):
        local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() - 1)
    assert shared == []


def test_start_timeout_retains_one_partial_owner_until_cleanup_finishes(shared, monkeypatch):
    entered, cancelled, release = threading.Event(), threading.Event(), threading.Event()
    created = []
    initialize = module.LocalInferenceGateway._initialize

    async def delayed_initialize(self):
        created.append(self)
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
            while not release.is_set():
                await asyncio.sleep(0.005)
            # A late initializer can still allocate an owned HTTP client.
            await initialize(self)

    monkeypatch.setattr(module.LocalInferenceGateway, "_initialize", delayed_initialize)
    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError):
            local_runtime.get_local_gateway_url(deadline_monotonic=started + 0.08)
        assert time.monotonic() - started < 0.4
        assert entered.is_set() and cancelled.wait(1)
        assert local_runtime._gateway is None
        assert local_runtime._gateway_starting is created[0]
        assert shared == [("gateway", local_runtime.close_local_gateway)]
        for _ in range(3):
            with pytest.raises(RuntimeError, match="cleanup"):
                local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() + 0.1)
        assert len(created) == 1
    finally:
        release.set()
        local_runtime.close_local_gateway()
    assert created[0]._client.is_closed
    assert not created[0]._loop_thread.is_alive()
    assert created[0]._loop.is_closed()
    monkeypatch.setattr(module.LocalInferenceGateway, "_initialize", initialize)
    assert local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() + 1).startswith("http://127.0.0.1:")


def test_cleanup_failure_quarantines_owner_and_shutdown_reports_failure(shared, monkeypatch):
    closed = threading.Event()

    class FailingClient:
        async def aclose(self):
            closed.set()
            raise RuntimeError("synthetic close failure")

    async def initialize(self):
        self._client = FailingClient()
        raise ValueError("synthetic initialization failure")

    monkeypatch.setattr(module.LocalInferenceGateway, "_initialize", initialize)
    with pytest.raises(ValueError, match="synthetic initialization failure"):
        local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() + 0.1)
    pending = local_runtime._gateway_starting
    assert closed.wait(1)
    pending._loop_thread.join(1)
    assert not pending._loop_thread.is_alive()
    assert pending._loop.is_closed()
    assert local_runtime._gateway is None
    with pytest.raises(RuntimeError, match="cleanup"):
        local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() + 0.1)
    with pytest.raises(module.GatewayStartupCleanupError, match="cleanup"):
        local_runtime.close_local_gateway()
    assert local_runtime._gateway_starting is pending
    # This synthetic failure is intentionally irrecoverable; do not retry it.
    monkeypatch.setattr(local_runtime, "_gateway_starting", None)


def test_concurrent_callers_share_one_successful_owner(shared):
    with ThreadPoolExecutor(max_workers=6) as pool:
        urls = list(pool.map(lambda _: local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() + 2), range(6)))
    assert len(set(urls)) == 1
    assert local_runtime._gateway_starting is None
    assert shared == [("gateway", local_runtime.close_local_gateway)]


def test_forked_owner_is_refused_before_inherited_locks(shared, monkeypatch):
    gateway = new_gateway()
    gateway._owner_pid = os.getpid() + 1
    monkeypatch.setattr(local_runtime, "_gateway", gateway)
    with local_runtime._gateway_lock, gateway._lock:
        with pytest.raises(RuntimeError, match="inherited"):
            local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() + 0.05)
        local_runtime.close_local_gateway()
        with pytest.raises(RuntimeError, match="inherited"):
            gateway.start(deadline_monotonic=time.monotonic() + 0.05)
        gateway.close()


def test_uncapped_startup_failure_releases_loop_before_returning(monkeypatch):
    gateway = new_gateway()

    async def fail():
        raise ValueError("synthetic initialization failure")

    monkeypatch.setattr(gateway, "_initialize", fail)
    with pytest.raises(ValueError, match="synthetic initialization failure"):
        gateway.start()
    assert not gateway._loop_thread.is_alive()
    assert gateway._loop.is_closed()
    gateway.close()


def test_lock_and_initialization_share_the_same_remaining_budget(shared, monkeypatch):
    entered = threading.Event()

    async def initialize(self):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(module.LocalInferenceGateway, "_initialize", initialize)
    local_runtime._gateway_lock.acquire()
    with ThreadPoolExecutor(max_workers=1) as pool:
        started = time.monotonic()
        pending = pool.submit(local_runtime.get_local_gateway_url, deadline_monotonic=started + 0.15)
        time.sleep(0.09)
        local_runtime._gateway_lock.release()
        with pytest.raises(TimeoutError):
            pending.result(timeout=0.4)
    assert entered.is_set()
    assert time.monotonic() - started < 0.22


def test_slow_failed_start_cleanup_uses_remaining_deadline(shared, monkeypatch):
    closing, release = threading.Event(), threading.Event()

    class DelayedClient:
        async def aclose(self):
            closing.set()
            while not release.is_set():
                await asyncio.sleep(0.005)

    async def initialize(self):
        self._client = DelayedClient()
        raise ValueError("synthetic initialization failure")

    monkeypatch.setattr(module.LocalInferenceGateway, "_initialize", initialize)
    started = time.monotonic()
    try:
        with pytest.raises(ValueError, match="synthetic initialization failure"):
            local_runtime.get_local_gateway_url(deadline_monotonic=started + 0.08)
        assert closing.is_set()
        assert time.monotonic() - started < 0.4
        owner = local_runtime._gateway_starting
        assert owner._loop_thread.is_alive()
        with pytest.raises(module.GatewayStartupCleanupError):
            owner.start(deadline_monotonic=time.monotonic() + 0.08)
    finally:
        release.set()
        local_runtime.close_local_gateway()
    assert owner._loop.is_closed()
    assert not owner._loop_thread.is_alive()


@pytest.mark.parametrize("thread_name", ["local-inference-io", "local-inference-http"])
def test_worker_creation_failure_releases_partial_resources(shared, monkeypatch, thread_name):
    real_start = threading.Thread.start

    def start(thread):
        if thread.name == thread_name:
            raise RuntimeError("synthetic thread creation failure")
        return real_start(thread)

    monkeypatch.setattr(threading.Thread, "start", start)
    with pytest.raises(RuntimeError, match="synthetic thread creation failure"):
        local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() + 1)
    owner = local_runtime._gateway_starting
    assert owner.startup_cleanup_complete
    assert local_runtime._gateway is None
    assert owner._loop.is_closed()
    if owner._client is not None:
        assert owner._client.is_closed
    if owner._server is not None:
        assert owner._server.socket.fileno() == -1
    local_runtime.close_local_gateway()


def test_dead_listener_is_never_returned_as_a_successful_shared_gateway(shared):
    local_runtime.get_local_gateway_url()
    owner = local_runtime._gateway
    owner._server.shutdown()
    owner._server_thread.join(1)
    with pytest.raises(RuntimeError, match="not running"):
        local_runtime.get_local_gateway_url(deadline_monotonic=time.monotonic() + 0.1)
    assert local_runtime._gateway is owner


@pytest.mark.parametrize("deadline", [False, float("nan"), float("inf"), "soon"])
def test_invalid_deadlines_never_construct_an_owner(shared, deadline):
    with pytest.raises(ValueError, match="deadline"):
        local_runtime.get_local_gateway_url(deadline_monotonic=deadline)
    assert local_runtime._gateway is local_runtime._gateway_starting is None
    assert shared == []
