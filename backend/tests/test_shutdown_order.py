"""Owned shutdown dependencies survive lazy construction and normal exit."""

import atexit
from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest

from app.config import Config
from app import local_runtime
from app.local_runtime import gateway
from app.memory.graphiti_engine import GraphitiMemoryEngine
from app.services import simulation_runner as runner_module
from app.utils import zep


@pytest.fixture
def lifecycle(monkeypatch):
    callbacks, events, signal_handlers = [], [], {}
    try:
        from app import shutdown
    except ImportError:
        shutdown = None
    if shutdown is not None:
        monkeypatch.setattr(
            shutdown, "_callbacks", {phase: [] for phase in shutdown._PHASES}
        )
        monkeypatch.setattr(shutdown, "_registered", False)
    monkeypatch.setattr(
        atexit,
        "register",
        lambda fn, *args, **kwargs: callbacks.append((fn, args, kwargs)) or fn,
    )
    monkeypatch.setattr(
        runner_module.signal,
        "signal",
        lambda number, callback: signal_handlers.__setitem__(number, callback),
    )
    monkeypatch.setattr(runner_module.signal, "getsignal", lambda _number: None)
    monkeypatch.setattr(runner_module, "_cleanup_registered", False)
    runner = runner_module.SimulationRunner
    manager = runner_module.ZepGraphMemoryManager
    for name, value in {
        "_cleanup_done": False,
        "_processes": {},
        "_graph_memory_enabled": {},
        "_run_states": {},
    }.items():
        monkeypatch.setattr(runner, name, value)
    monkeypatch.setattr(
        runner, "get_run_state", classmethod(lambda cls, identifier: None)
    )
    for name in ("FLASK_DEBUG", "WERKZEUG_RUN_MAIN", "MIROFISH_LOCAL_GATEWAY_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(Config, "LOCAL_MODE", True)
    monkeypatch.setattr(Config, "validate", lambda: [])
    monkeypatch.setattr(Config, "LLM_MODEL_NAME", "synthetic")
    monkeypatch.setattr(Config, "LLM_BASE_URL", "http://127.0.0.1:12346/v1")
    monkeypatch.setattr(Config, "LOCAL_EMBEDDING_BASE_URL", "http://127.0.0.1:12346/v1")
    monkeypatch.setattr(Config, "LOCAL_REQUEST_TIMEOUT", 2)
    monkeypatch.setattr(local_runtime, "_gateway", None)

    class Gateway:
        def __init__(self, settings):
            self.closed = False

        def start(self):
            return "http://127.0.0.1:12345/v1"

        def close(self):
            self.closed = True
            events.append("gateway-close")

    async def initialize(engine):
        pass

    async def get_graph(engine, identifier):
        owned = local_runtime._gateway
        assert owned is None or not owned.closed
        events.append("memory-read")
        return identifier

    real_close = GraphitiMemoryEngine.close

    async def close(engine):
        events.append("memory-close")
        await real_close(engine)

    monkeypatch.setattr(gateway, "LocalInferenceGateway", Gateway)
    monkeypatch.setattr(GraphitiMemoryEngine, "initialize", initialize)
    monkeypatch.setattr(GraphitiMemoryEngine, "get_graph", get_graph)
    monkeypatch.setattr(GraphitiMemoryEngine, "close", close)
    zep._get_local_client.cache_clear()
    clients = []

    def memory():
        client = zep.get_zep_client()
        if client not in clients:
            clients.append(client)
        return client

    def updater(client=None):
        class Updater:
            def stop(self):
                events.append("updater-drain")
                owned = local_runtime._gateway
                assert owned is None or not owned.closed
                if client is not None:
                    client.graph.get("synthetic-group")

        monkeypatch.setattr(manager, "_updaters", {"synthetic-run": Updater()})

    def exit_handlers():
        errors = []
        for callback, args, kwargs in reversed(callbacks):
            try:
                callback(*args, **kwargs)
            except BaseException as exc:
                errors.append(exc)
        return errors

    yield SimpleNamespace(
        runner=runner,
        manager=manager,
        callbacks=callbacks,
        events=events,
        signals=signal_handlers,
        memory=memory,
        updater=updater,
        exit=exit_handlers,
    )
    for client in clients:
        client.close()
    local_runtime.close_local_gateway()
    zep._get_local_client.cache_clear()


@pytest.mark.parametrize("order", ["runner-first", "memory-first", "gateway-first"])
def test_updater_drains_before_memory_and_gateway_for_each_lazy_order(lifecycle, order):
    state = lifecycle
    if order == "runner-first":
        state.runner.register_cleanup()
        client = state.memory()
    elif order == "memory-first":
        client = state.memory()
        state.runner.register_cleanup()
    else:
        local_runtime.get_local_gateway_url()
        state.runner.register_cleanup()
        client = state.memory()
    state.updater(client)

    assert state.exit() == []
    assert state.manager.get_simulation_ids() == []
    assert state.events == [
        "updater-drain",
        "memory-read",
        "memory-close",
        "gateway-close",
    ]
    assert not client._runner.thread.is_alive()


def test_gateway_only_process_still_drains_before_closing_owned_gateway(lifecycle):
    state = lifecycle
    state.runner.register_cleanup()
    local_runtime.get_local_gateway_url()
    state.updater()
    assert state.exit() == []
    assert state.manager.get_simulation_ids() == []
    assert state.events == ["updater-drain", "gateway-close"]


def test_inherited_gateway_is_never_closed_by_this_process(lifecycle, monkeypatch):
    state = lifecycle
    monkeypatch.setenv("MIROFISH_LOCAL_GATEWAY_URL", "http://127.0.0.1:12345/v1")
    state.runner.register_cleanup()
    client = state.memory()
    state.updater(client)
    assert state.exit() == []
    assert state.manager.get_simulation_ids() == []
    assert state.events == ["updater-drain", "memory-read", "memory-close"]
    assert local_runtime._gateway is None


def test_signal_cleanup_then_exit_does_not_drain_twice(lifecycle):
    state = lifecycle
    state.runner.register_cleanup()
    client = state.memory()
    state.updater(client)
    with pytest.raises(KeyboardInterrupt):
        state.signals[runner_module.signal.SIGTERM](runner_module.signal.SIGTERM)
    assert state.events == ["updater-drain", "memory-read"]
    assert state.exit() == []
    assert state.events == [
        "updater-drain",
        "memory-read",
        "memory-close",
        "gateway-close",
    ]


def test_registration_deduplicates_callbacks_without_dropping_distinct_clients(
    lifecycle,
):
    from app.shutdown import register_shutdown_callback

    events = []

    def simulation():
        events.append("simulations")

    register_shutdown_callback("memory", lambda: events.append("memory-old"))
    register_shutdown_callback("simulations", simulation)
    register_shutdown_callback("gateway", lambda: events.append("gateway"))
    register_shutdown_callback("memory", lambda: events.append("memory-new"))
    register_shutdown_callback("simulations", simulation)
    assert len(lifecycle.callbacks) == 1
    assert lifecycle.exit() == []
    assert events == ["simulations", "memory-new", "memory-old", "gateway"]


def test_shutdown_failure_does_not_skip_later_dependencies(lifecycle):
    from app.shutdown import register_shutdown_callback

    events = []
    first = OSError("simulation cleanup failure")

    def simulations():
        events.append("simulations")
        raise first

    def memory():
        events.append("memory")
        raise ValueError("memory cleanup failure")

    register_shutdown_callback("gateway", lambda: events.append("gateway"))
    register_shutdown_callback("memory", memory)
    register_shutdown_callback("simulations", simulations)
    assert lifecycle.exit() == [first]
    assert events == ["simulations", "memory", "gateway"]
    assert "memory cleanup failure" in " ".join(first.__notes__)


def test_resource_registered_during_drain_is_closed_in_its_later_phase(lifecycle):
    from app.shutdown import register_shutdown_callback

    events = []

    def drain():
        events.append("drain")
        register_shutdown_callback("memory", lambda: events.append("memory"))

    register_shutdown_callback("gateway", lambda: events.append("gateway"))
    register_shutdown_callback("simulations", drain)
    assert lifecycle.exit() == []
    assert events == ["drain", "memory", "gateway"]
    assert len(lifecycle.callbacks) == 1


def test_concurrent_resource_registration_uses_one_dispatcher(lifecycle):
    from app.shutdown import register_shutdown_callback

    events = []
    callbacks = [lambda value=value: events.append(value) for value in range(16)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(
            pool.map(
                lambda callback: register_shutdown_callback("memory", callback),
                callbacks * 2,
            )
        )
    assert len(lifecycle.callbacks) == 1
    assert lifecycle.exit() == []
    assert sorted(events) == list(range(16))


def test_normal_interpreter_exit_uses_dependency_order(tmp_path):
    destination = tmp_path / "exit-order.jsonl"
    script = r"""
import json, sys
from pathlib import Path
from app.shutdown import register_shutdown_callback
path = Path(sys.argv[1])
def record(value):
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value) + "\n")
register_shutdown_callback("simulations", lambda: record("drain"))
register_shutdown_callback("gateway", lambda: record("gateway"))
register_shutdown_callback("memory", lambda: record("memory"))
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(destination)],
        env=dict(os.environ, PYTHON_DOTENV_DISABLED="1"),
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert [json.loads(line) for line in destination.read_text().splitlines()] == [
        "drain",
        "memory",
        "gateway",
    ]
