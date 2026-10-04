"""A real exported cast preset applies to a fresh setup before explicit work."""

from pathlib import Path
import subprocess

import pytest

from app.services.simulation_manager import SimulationManager, SimulationState
from test_local_preparation_frontend_workflow import (
    test_local_planner_real_flask_axios_vue_and_saved_artifacts as _run_preparation_workflow,
)


@pytest.mark.parametrize('scenario', ['template', 'llm'])
def test_cast_preset_export_import_then_explicit_preparation_and_round_limit(
    tmp_path, monkeypatch, scenario,
):
    """Reuse the established real Flask/graph/profile/config fixture and assertions.

    Its destination simulation still generates the same exact selected profiles
    and configuration. The additional source simulation is used only to choose
    and export a draft, and must retain its original files byte for byte.
    """
    repo = Path(__file__).resolve().parents[2]
    run = subprocess.run
    exercised = []

    def cast_driver(command, **kwargs):
        assert Path(command[1]).name == 'local-preparation-backend-smoke.mjs'
        assert not exercised, 'The linked workflow should own exactly one Node driver'
        exercised.append(True)
        manager = SimulationManager()
        destination = manager.get_simulation('sim_fixture')
        source = SimulationState(
            'sim_preset_source', destination.project_id, destination.graph_id,
            enable_twitter=destination.enable_twitter,
            enable_reddit=destination.enable_reddit,
        )
        manager._save_simulation_state(source)
        folder = Path(manager.SIMULATION_DATA_DIR) / source.simulation_id
        before = {path.name: path.read_bytes() for path in folder.iterdir()}
        replacement = [command[0], str(repo / 'frontend/tests/fixtures/cast-preset-backend-smoke.mjs'),
                       *command[2:]]
        result = run(replacement, **kwargs)
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'actual cast preset workflow passed' in result.stdout
        assert {path.name: path.read_bytes() for path in folder.iterdir()} == before
        return result

    monkeypatch.setattr(subprocess, 'run', cast_driver)
    _run_preparation_workflow(tmp_path, monkeypatch, scenario)
    assert exercised == [True]
