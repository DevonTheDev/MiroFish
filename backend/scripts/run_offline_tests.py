"""Run the installed test suite with synthetic, loopback-only Python networking."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--require-neo4j", action="store_true")
    args, pytest_args = parser.parse_known_args(argv)
    if args.require_neo4j and not os.environ.get("MIRO_TEST_NEO4J_URI"):
        print(
            "MIRO_TEST_NEO4J_URI must name a disposable loopback database; refusing to skip integration tests.",
            file=sys.stderr,
        )
        return 2
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("LLM_", "LOCAL_", "ZEP_", "OPENAI_"))
    }
    env["PYTHONPATH"] = os.pathsep.join(
        [
            str(ROOT / "backend/scripts/offline_guard"),
            str(ROOT / "backend"),
            *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []),
        ]
    )
    env.update(
        MEMORY_BACKEND="zep",
        MIROFISH_OFFLINE_TESTS="1",
        PYTHON_DOTENV_DISABLED="1",
        LLM_API_KEY="",
        OPENAI_API_KEY="",
        ZEP_API_KEY="",
        LANGFUSE_ENABLED="false",
        TRACEROOT_ENABLED="false",
        GRAPHITI_TELEMETRY_ENABLED="false",
        HF_HUB_OFFLINE="1",
        TRANSFORMERS_OFFLINE="1",
        HF_HUB_DISABLE_TELEMETRY="1",
        NO_PROXY="*",
        no_proxy="*",
    )
    env.pop("MIROFISH_OFFLINE_GUARD_ACTIVE", None)
    env.pop("MIROFISH_LOCAL_GATEWAY_URL", None)
    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        env.pop(name, None)
    # sitecustomize import errors otherwise only print a warning and Python
    # continues. Require the installation marker before importing test code.
    bootstrap = (
        "import os,sys; "
        "assert os.environ.get('MIROFISH_OFFLINE_GUARD_ACTIVE') == '1', 'Offline socket guard did not load'; "
        "import pytest; raise SystemExit(pytest.main(sys.argv[1:]))"
    )
    if args.require_neo4j:
        # A separate guarded preflight catches broken optional dependencies
        # without preloading pytest plugins before assertion rewriting starts.
        preflight = (
            "import os; "
            "assert os.environ.get('MIROFISH_OFFLINE_GUARD_ACTIVE') == '1', 'Offline socket guard did not load'; "
            "import camel, oasis, graphiti_core"
        )
        result = subprocess.call([sys.executable, "-c", preflight], cwd=ROOT, env=env)
        if result:
            return result
    return subprocess.call(
        [sys.executable, "-c", bootstrap, *(pytest_args or ["-q"])], cwd=ROOT, env=env
    )


if __name__ == "__main__":
    raise SystemExit(main())
