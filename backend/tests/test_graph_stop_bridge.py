"""Real loop/future boundary, synthetic coroutine; no model, SDK or database."""
import asyncio
import threading
from concurrent.futures import Future, TimeoutError as FutureTimeout

import pytest

from app.memory import local_graphiti as bridge
from app.memory.local_graphiti import _LoopRunner
from app.services.graph_build_control import GraphBuildControl


WAIT = 3


def test_cancelled_concurrent_future_is_not_loop_cleanup_receipt(monkeypatch):
    runner = _LoopRunner()
    control = GraphBuildControl("proj_bridge", "task_bridge")
    entered = threading.Event()
    cleanup_entered, cleanup_release = threading.Event(), threading.Event()

    class EnteredTimeout(Future):
        def result(self, timeout=None):
            assert entered.wait(WAIT), "Loop coroutine did not enter"
            raise FutureTimeout()

    monkeypatch.setattr(bridge, "Future", EnteredTimeout)

    async def delayed_cleanup():
        try:
            entered.set()
            await asyncio.Event().wait()
        finally:
            cleanup_entered.set()
            while not cleanup_release.is_set():
                await asyncio.sleep(0)

    try:
        with control.operation("test operation"):
            with pytest.raises(TimeoutError):
                runner.call(delayed_cleanup(), timeout=WAIT)
            control.request_stop()
        assert cleanup_entered.wait(WAIT)
        assert control.has_pending_receipts()
        cleanup_release.set()
        completed = threading.Event()
        waiter = threading.Thread(target=lambda: (control.wait_for_receipts(), completed.set()), daemon=True)
        waiter.start()
        assert completed.wait(WAIT)
        waiter.join(WAIT)
        assert not control.has_pending_receipts()
    finally:
        cleanup_release.set()
        runner.close()


def test_loop_receipt_retains_actual_cleanup_error():
    runner = _LoopRunner()
    control = GraphBuildControl("proj_bridge", "task_bridge")

    async def cleanup_error():
        from app.services.graph_build_control import GraphBuildUnresolved
        raise GraphBuildUnresolved("synthetic journal failure")

    try:
        with control.operation("test operation"):
            with pytest.raises(RuntimeError, match="synthetic journal failure"):
                runner.call(cleanup_error(), timeout=WAIT)
        assert not control.has_pending_receipts()
        assert control.unresolved
        assert "synthetic journal failure" in control.error
    finally:
        runner.close()


def test_bridge_cancelled_before_first_loop_step_closes_and_settles(monkeypatch):
    runner = _LoopRunner()
    control = GraphBuildControl("proj_before_step", "task_before_step")
    loop_blocked, release_loop = threading.Event(), threading.Event()
    entered = []

    class ImmediateTimeout(Future):
        def result(self, timeout=None):
            raise FutureTimeout()

    def hold_loop():
        loop_blocked.set()
        assert release_loop.wait(WAIT), "Test did not release the loop barrier"

    async def must_not_enter():
        entered.append(True)

    runner.loop.call_soon_threadsafe(hold_loop)
    coroutine = must_not_enter()
    try:
        assert loop_blocked.wait(WAIT)
        monkeypatch.setattr(bridge, "Future", ImmediateTimeout)
        with control.operation("bridge before first step"):
            with pytest.raises(TimeoutError):
                runner.call(coroutine, timeout=WAIT)
            control.request_stop()
        assert control.has_pending_receipts()
        release_loop.set()
        completed = threading.Event()
        waiter = threading.Thread(target=lambda: (control.wait_for_receipts(), completed.set()), daemon=True)
        waiter.start()
        assert completed.wait(WAIT)
        waiter.join(WAIT)
        assert not waiter.is_alive()
        assert not control.has_pending_receipts()
        assert coroutine.cr_frame is None
        assert entered == []
    finally:
        release_loop.set()
        runner.close()
