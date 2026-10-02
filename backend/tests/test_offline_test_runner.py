"""Portable offline verification must fail closed before pytest imports."""

import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "backend/scripts/run_offline_tests.py"
GUARD = ROOT / "backend/scripts/offline_guard"


def guarded_python(code):
    assert (GUARD / "sitecustomize.py").exists(), (
        "Offline socket guard is not implemented"
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = str(GUARD)
    env["MIROFISH_OFFLINE_TESTS"] = "1"
    env.pop("MIROFISH_OFFLINE_GUARD_ACTIVE", None)
    return subprocess.run(
        [sys.executable, "-c", code],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )


@pytest.mark.parametrize(
    "expression",
    [
        "socket.getaddrinfo('example.com',443)",
        "socket.gethostbyname('example.com')",
        "socket.gethostbyname_ex('example.com')",
        "socket.gethostbyaddr('192.0.2.1')",
        "socket.getnameinfo(('192.0.2.1',443),0)",
        "socket.socket().connect(('192.0.2.1',443))",
        "socket.socket().connect_ex(('192.0.2.1',443))",
        "socket.socket(socket.AF_INET,socket.SOCK_DGRAM).sendto(b'test',('192.0.2.1',53))",
    ],
)
def test_offline_guard_rejects_external_network_before_resolution(expression):
    result = guarded_python(f"""import socket
try:
    {expression}
except RuntimeError as error:
    assert "loopback" in str(error)
else:
    raise AssertionError("External network operation was not rejected")
""")
    assert result.returncode == 0, result.stderr


def test_offline_guard_permits_real_loopback_connections():
    result = guarded_python("""import os,socket
assert os.environ['MIROFISH_OFFLINE_GUARD_ACTIVE']=='1'
server=socket.socket();server.bind(('127.0.0.1',0));server.listen()
client=socket.create_connection(server.getsockname(),timeout=2)
connection,_=server.accept();client.sendall(b'local');assert connection.recv(5)==b'local'
client.close();connection.close();server.close()
assert socket.gethostbyname('localhost').startswith('127.')
""")
    assert result.returncode == 0, result.stderr


def test_runner_uses_current_interpreter_clears_credentials_and_preserves_pytest_exit(
    tmp_path,
):
    assert RUNNER.exists(), "Portable offline test runner is not implemented"
    probe = tmp_path / "test_probe.py"
    probe.write_text("""import os,socket

def test_guard():
    assert os.environ['MIROFISH_OFFLINE_GUARD_ACTIVE']=='1'
    assert os.environ.get('OPENAI_API_KEY','')==''
    assert os.environ.get('LLM_API_KEY','')==''
    assert os.environ.get('ZEP_API_KEY','')==''
    assert os.environ['MEMORY_BACKEND']=='zep'
    assert 'LOCAL_GRAPH_PASSWORD' not in os.environ
    assert 'LLM_BASE_URL' not in os.environ
    try: socket.getaddrinfo('example.com',443)
    except RuntimeError: pass
    else: raise AssertionError('unguarded DNS')
""")
    env = os.environ.copy()
    env.update(
        OPENAI_API_KEY="synthetic-key",
        LLM_API_KEY="synthetic-key",
        ZEP_API_KEY="synthetic-key",
        LOCAL_GRAPH_PASSWORD="synthetic-private",
        MEMORY_BACKEND="local",
        LLM_BASE_URL="https://example.com/v1",
    )
    result = subprocess.run(
        [sys.executable, str(RUNNER), str(probe), "-q"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    probe.write_text("def test_failure(): assert False\n")
    result = subprocess.run(
        [sys.executable, str(RUNNER), str(probe), "-q"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 1


def test_ci_mode_refuses_to_silently_skip_database_integration():
    assert RUNNER.exists(), "Portable offline test runner is not implemented"
    env = os.environ.copy()
    env.pop("MIRO_TEST_NEO4J_URI", None)
    result = subprocess.run(
        [sys.executable, str(RUNNER), "--require-neo4j"],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 2
    assert "MIRO_TEST_NEO4J_URI" in result.stderr


def test_required_integration_mode_does_not_hide_broken_optional_runtime(tmp_path):
    assert RUNNER.exists()
    (tmp_path / "oasis.py").write_text(
        "raise ImportError('synthetic broken OASIS runtime')\n"
    )
    probe = tmp_path / "test_probe.py"
    probe.write_text("def test_pass(): pass\n")
    env = os.environ.copy()
    env["PYTHONPATH"] = str(tmp_path)
    env["MIRO_TEST_NEO4J_URI"] = "bolt://127.0.0.1:7687"
    result = subprocess.run(
        [sys.executable, str(RUNNER), "--require-neo4j", str(probe), "-q"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode != 0
    assert "synthetic broken OASIS runtime" in result.stderr


def test_offline_guard_blocks_unconnected_sendmsg():
    import socket

    if not hasattr(socket.socket, "sendmsg"):
        pytest.skip("sendmsg is unavailable on this platform")
    result = guarded_python("""import socket
try:
    socket.socket(socket.AF_INET,socket.SOCK_DGRAM).sendmsg([b'synthetic'],[],0,('192.0.2.1',53))
except RuntimeError as error:
    assert 'loopback' in str(error)
else:
    raise AssertionError('External sendmsg was not rejected')
""")
    assert result.returncode == 0, result.stderr


def test_required_runtime_preflight_does_not_preload_pytest_plugins(tmp_path):
    probe = tmp_path / "test_probe.py"
    probe.write_text("def test_pass(): pass\n")
    env = os.environ.copy()
    env["MIRO_TEST_NEO4J_URI"] = "bolt://127.0.0.1:7687"
    result = subprocess.run(
        [sys.executable, str(RUNNER), "--require-neo4j", str(probe), "-q"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PytestAssertRewriteWarning" not in result.stdout + result.stderr
