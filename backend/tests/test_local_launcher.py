"""Launcher admission tests; all validation/factory/server boundaries are fakes.

The dotenv cases execute the unchanged Config loader in a disposable project
layout with real python-dotenv. They do not import app's package initializer,
execute Config.validate's gateway import, or start a Flask app or service.
"""

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
REFUSAL = (
    "Local launcher requires MEMORY_BACKEND=local in the loaded configuration. "
    "Update your existing root .env using .env.local.example as a guide; "
    "see docs/LOCAL_MODE.md.\n"
)


def invoke(argv, *, local=False, errors=(), env=None, debug=False,
           entrypoint="main", config=None):
    """Run exact launcher bytes with explicit argv and recorded boundaries."""
    events = []
    settings = config or type("Config", (), {
        "LOCAL_MODE": local,
        "DEBUG": debug,
        "LLM_API_KEY": "dummy-llm-secret-never-echo",
        "ZEP_API_KEY": "dummy-zep-secret-never-echo",
        "validate": staticmethod(lambda: []),
    })

    def validate():
        events.append("validate")
        return list(errors)

    def create_app():
        events.append("create_app")
        return SimpleNamespace(run=lambda **kwargs: events.append(("run", kwargs)))

    app = ModuleType("app")
    app.__path__ = []
    app.create_app = create_app
    config_module = ModuleType("app.config")
    config_module.Config = settings
    stdout, stderr = io.StringIO(), io.StringIO()
    variables = {"PYTHON_DOTENV_DISABLED": "1"}
    variables.update(env or {})
    status = 0
    with (
        patch.dict(sys.modules, {"app": app, "app.config": config_module}),
        patch.object(settings, "validate", side_effect=validate),
        patch.dict(os.environ, variables, clear=True),
        patch.object(sys, "path", list(sys.path)),
        patch.object(sys, "argv", ["run.py", *argv]),
        redirect_stdout(stdout), redirect_stderr(stderr),
    ):
        before_env = dict(os.environ)
        before_config = dict(vars(settings))
        try:
            if entrypoint == "__main__":
                runpy.run_path(str(ROOT / "backend/run.py"), run_name="__main__")
            else:
                namespace = runpy.run_path(str(ROOT / "backend/run.py"),
                                          run_name="launcher_under_test")
                if entrypoint == "main-default":
                    namespace["main"]()
                else:
                    # Deliberately conflicting process argv proves argument
                    # injection does not accidentally consume a test runner CLI.
                    sys.argv = ["test-runner", "--unrelated-runner-option"]
                    namespace["main"](list(argv))
        except SystemExit as exc:
            status = exc.code
        environment_preserved = dict(os.environ) == before_env
        config_preserved = dict(vars(settings)) == before_config
    return SimpleNamespace(status=status, events=events, stdout=stdout.getvalue(),
                           stderr=stderr.getvalue(),
                           environment_preserved=environment_preserved,
                           config_preserved=config_preserved)


class LauncherTests(unittest.TestCase):
    def assert_refused(self, result):
        self.assertEqual(result.status, 1, result.events)
        self.assertEqual(result.events, [])
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, REFUSAL)
        self.assertTrue(result.environment_preserved)
        self.assertTrue(result.config_preserved)

    def assert_started(self, result, *, host, port=5001, debug=False):
        self.assertEqual(result.status, 0, result.stderr)
        self.assertEqual(result.events, ["validate", "create_app", (
            "run", {"host": host, "port": port, "debug": debug, "threaded": True}
        )])
        self.assertEqual(result.stdout + result.stderr, "")

    def test_required_cloud_main_entrypoint_refuses(self):
        # Baseline evidence uses its supported __main__ route so a failure must
        # expose fake startup, rather than merely a missing main(argv) signature.
        result = invoke(["--require-local"], entrypoint="__main__", env={
            "MEMORY_BACKEND": "zep", "LLM_API_KEY": "dummy-cloud-key",
            "ZEP_API_KEY": "dummy-zep-key",
        })
        self.assert_refused(result)

    def test_required_cloud_callable_refuses(self):
        self.assert_refused(invoke(["--require-local"]))

    def test_required_unset_mode_refuses(self):
        self.assert_refused(invoke(["--require-local"], env={}))

    def test_required_empty_mode_refuses(self):
        self.assert_refused(invoke(["--require-local"], env={"MEMORY_BACKEND": ""}))

    def test_required_unknown_mode_refuses(self):
        self.assert_refused(invoke(["--require-local"],
                                  env={"MEMORY_BACKEND": "locla-private-sentinel"}))

    def test_refusal_precedes_missing_cloud_credentials(self):
        self.assert_refused(invoke(["--require-local"],
                                  errors=["LLM_API_KEY 未配置", "ZEP_API_KEY 未配置"]))

    def test_required_local_uses_loopback_and_existing_run_options(self):
        self.assert_started(invoke(["--require-local"], local=True, debug=True,
                                  env={"FLASK_HOST": "0.0.0.0", "FLASK_PORT": "5099"}),
                            host="127.0.0.1", port=5099, debug=True)

    def test_required_local_validation_failures_are_preserved(self):
        for error in ("LOCAL_MAX_AGENTS must be a positive integer",
                      "LLM_BASE_URL: A valid literal loopback URL is required"):
            with self.subTest(error=error):
                result = invoke(["--require-local"], local=True, errors=[error])
                self.assertEqual(result.status, 1)
                self.assertEqual(result.events, ["validate"])
                self.assertEqual(result.stderr, "")
                self.assertEqual(result.stdout,
                                 f"配置错误:\n  - {error}\n\n请检查 .env 文件中的配置\n")

    def test_required_local_main_entrypoint_starts(self):
        self.assert_started(invoke(["--require-local"], local=True,
                                  entrypoint="__main__"), host="127.0.0.1")

    def test_required_local_main_entrypoint_validation_status(self):
        result = invoke(["--require-local"], local=True, errors=["invalid limit"],
                        entrypoint="__main__")
        self.assertEqual(result.status, 1)
        self.assertEqual(result.events, ["validate"])

    def test_generic_cloud_uses_default_host(self):
        self.assert_started(invoke([]), host="0.0.0.0")

    def test_generic_cloud_honors_host_port_debug(self):
        self.assert_started(invoke([], debug=True, env={
            "FLASK_HOST": "192.0.2.9", "FLASK_PORT": "5055",
        }), host="192.0.2.9", port=5055, debug=True)

    def test_generic_local_uses_loopback(self):
        self.assert_started(invoke([], local=True, env={"FLASK_HOST": "0.0.0.0"}),
                            host="127.0.0.1")

    def test_generic_validation_failures_are_preserved(self):
        for error in ("LLM_API_KEY 未配置", "MEMORY_BACKEND must be 'zep' or 'local'"):
            with self.subTest(error=error):
                result = invoke([], errors=[error])
                self.assertEqual(result.status, 1)
                self.assertEqual(result.events, ["validate"])
                self.assertIn(error, result.stdout)
                self.assertEqual(result.stderr, "")

    def test_no_argument_main_uses_process_argv(self):
        self.assert_refused(invoke(["--require-local"], entrypoint="main-default"))

    def test_no_argument_main_preserves_generic_start(self):
        self.assert_started(invoke([], entrypoint="main-default"), host="0.0.0.0")

    def test_generic_main_entrypoint_starts(self):
        self.assert_started(invoke([], entrypoint="__main__"), host="0.0.0.0")

    def test_invalid_cli_is_rejected_before_boundaries(self):
        for argv in (
            ["--require-lcoal"], ["--require-loc"], ["--require-local=true"],
            ["--require-local=false"], ["--require-local", "false"],
            ["unexpected"], ["--require-local", "--unknown"],
        ):
            with self.subTest(argv=argv):
                result = invoke(argv)
                self.assertEqual(result.status, 2)
                self.assertEqual(result.events, [])
                self.assertEqual(result.stdout, "")
                self.assertIn("error:", result.stderr)
                self.assertNotIn(REFUSAL, result.stderr)

    def test_invalid_cli_main_entrypoint_status(self):
        result = invoke(["--require-loc"], entrypoint="__main__")
        self.assertEqual(result.status, 2)
        self.assertEqual(result.events, [])

    def test_help_exits_without_validation_or_startup(self):
        result = invoke(["--help"])
        self.assertEqual(result.status, 0)
        self.assertEqual(result.events, [])
        self.assertIn("--require-local", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_repeated_flag_still_refuses_cloud(self):
        self.assert_refused(invoke(["--require-local", "--require-local"]))

    def test_repeated_flag_admits_local(self):
        self.assert_started(invoke(["--require-local", "--require-local"], local=True),
                            host="127.0.0.1")

    def test_guard_reads_effective_config_not_current_environment(self):
        self.assert_refused(invoke(["--require-local"], env={"MEMORY_BACKEND": "local"}))
        self.assert_started(invoke(["--require-local"], local=True,
                                  env={"MEMORY_BACKEND": "zep"}), host="127.0.0.1")

    def test_refusal_does_not_echo_or_mutate_configuration(self):
        result = invoke(["--require-local"], env={
            "MEMORY_BACKEND": "private-mode-sentinel",
            "LLM_API_KEY": "dummy-llm-secret-never-echo",
            "ZEP_API_KEY": "dummy-zep-secret-never-echo",
            "LLM_BASE_URL": "https://private-endpoint.invalid/private-path",
        })
        self.assert_refused(result)
        for sentinel in ("private-mode", "dummy-llm", "dummy-zep", "private-endpoint"):
            self.assertNotIn(sentinel, result.stdout + result.stderr)

    def test_package_local_script_requires_exact_flag(self):
        scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
        self.assertEqual(scripts["backend:local"],
                         "cd backend && uv run --extra local --locked python run.py --require-local")

    def test_package_other_launch_scripts_remain_unchanged(self):
        scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
        self.assertEqual(scripts["dev:local"],
                         'concurrently --kill-others -n "backend,frontend" -c "green,cyan" '
                         '"npm run backend:local" "npm run frontend:local"')
        self.assertEqual(scripts["backend"], "cd backend && uv run python run.py")
        self.assertEqual(scripts["dev"],
                         'concurrently --kill-others -n "backend,frontend" -c "green,cyan" '
                         '"npm run backend" "npm run frontend"')
        self.assertEqual(scripts["frontend:local"],
                         "cd frontend && npm run dev -- --host 127.0.0.1")
        self.assertEqual(scripts["check:local"],
                         "cd backend && uv run --extra local --locked python scripts/local_doctor.py --probe")


class DotenvPrecedenceTests(unittest.TestCase):
    assert_refused = LauncherTests.assert_refused
    assert_started = LauncherTests.assert_started

    def check_loaded_config(self, *, shell_mode, dotenv_text, expected_local):
        config_bytes = (ROOT / "backend/app/config.py").read_bytes()
        variables = {"LLM_API_KEY": "dummy-cloud-key", "ZEP_API_KEY": "dummy-zep-key"}
        if shell_mode is not None:
            variables["MEMORY_BACKEND"] = shell_mode
        if dotenv_text is None:
            variables["PYTHON_DOTENV_DISABLED"] = "1"
        with tempfile.TemporaryDirectory(prefix="miro-launch-dotenv-") as directory:
            root = Path(directory)
            config_path = root / "backend/app/config.py"
            config_path.parent.mkdir(parents=True)
            config_path.write_bytes(config_bytes)
            dotenv_path = root / ".env"
            if dotenv_text is not None:
                dotenv_path.write_text(dotenv_text, encoding="utf-8")
            app = ModuleType("app")
            app.__path__ = []
            with patch.dict(os.environ, variables, clear=True), patch.dict(sys.modules, {"app": app}):
                spec = importlib.util.spec_from_file_location("app.config", config_path)
                module = importlib.util.module_from_spec(spec)
                with patch.dict(sys.modules, {"app.config": module}):
                    spec.loader.exec_module(module)
                    self.assertIs(module.Config.LOCAL_MODE, expected_local)
                    self.assertEqual(module.Config.MEMORY_BACKEND,
                                     "local" if expected_local else "zep")
                    loaded_env = dict(os.environ)
                    result = invoke(["--require-local"], config=module.Config, env=loaded_env)
                    self.assertEqual(dict(os.environ), loaded_env)
            self.assertEqual(config_path.read_bytes(), config_bytes)
            if dotenv_text is None:
                self.assertFalse(dotenv_path.exists())
            else:
                self.assertEqual(dotenv_path.read_text(encoding="utf-8"), dotenv_text)
            if expected_local:
                self.assert_started(result, host="127.0.0.1")
            else:
                self.assert_refused(result)
            self.assertTrue(result.environment_preserved)
            self.assertTrue(result.config_preserved)

    def test_root_dotenv_zep_overrides_shell_local_and_refuses(self):
        self.check_loaded_config(shell_mode="local", dotenv_text="MEMORY_BACKEND=zep\n",
                                 expected_local=False)

    def test_root_dotenv_local_overrides_shell_zep_and_admits(self):
        self.check_loaded_config(shell_mode="zep", dotenv_text='MEMORY_BACKEND=" LOCAL "\n',
                                 expected_local=True)

    def test_disabled_dotenv_preserves_shell_local_and_admits(self):
        self.check_loaded_config(shell_mode="local", dotenv_text=None, expected_local=True)

    def test_disabled_dotenv_with_absent_mode_defaults_zep_and_refuses(self):
        self.check_loaded_config(shell_mode=None, dotenv_text=None, expected_local=False)


if __name__ == "__main__":
    unittest.main()
