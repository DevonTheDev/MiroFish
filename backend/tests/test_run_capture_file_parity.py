"""Real saved logs -> SQLite -> Flask exports -> local JavaScript file admission.

The Node side has no server or browser and receives only the downloaded objects.
Its comparison oracle is the production Python comparison returned by Flask.
All source files and databases belong to pytest's disposable temporary directory.
"""

import copy
import itertools
import json
from pathlib import Path
import shutil
import subprocess

from flask import Flask
import pytest

from app.api import run_captures as api
from app.services import run_captures as service
from scripts.action_logger import PlatformActionLogger
from test_run_captures import saved, write_json


REPO = Path(__file__).resolve().parents[2]
CAPTURED_AT = "2026-10-06T12:30:00.123456+00:00"
COMPUTED_AT = "2026-10-07T08:00:00.654321+00:00"

NODE_PARITY = r"""
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

globalThis.fetch = () => { throw new Error('File-only parsing must not call fetch') }
const { parseRunCaptureFile, compareRunCaptureFiles } = await import(pathToFileURL(process.argv[2]))
const input = JSON.parse(readFileSync(process.argv[1], 'utf8'))
const plain = value => JSON.parse(JSON.stringify(value))
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const observations = { accepted: 0, compared: 0, rejected: 0, wire_bytes: [] }
for (const value of input.accepted ?? []) {
  // This is the existing Vue download representation, including well-formed
  // escaping of lone historical surrogates and literal non-ASCII characters.
  const wire = JSON.stringify(value, null, 2)
  const parsed = parseRunCaptureFile(wire)
  const expected = Object.hasOwn(value, 'left')
    ? { kind: 'comparison', captures: [value.left, value.right], generated_at: value.generated_at }
    : { kind: 'capture', captures: [value] }
  assert.deepEqual(plain(parsed), expected)
  // A reopened capture can be downloaded and reopened without rewriting any
  // historical field, including metadata that JavaScript cannot coerce safely.
  for (const capture of parsed.captures) {
    assert.deepEqual(plain(parseRunCaptureFile(JSON.stringify(capture, null, 2))), {
      kind: 'capture', captures: [plain(capture)],
    })
  }
  observations.accepted++
  observations.wire_bytes.push(Buffer.byteLength(wire, 'utf8'))
}
for (const expected of input.comparisons ?? []) {
  const left = freeze(parseRunCaptureFile(JSON.stringify(expected.left)).captures[0])
  const right = freeze(parseRunCaptureFile(JSON.stringify(expected.right)).captures[0])
  const before = JSON.stringify([left, right])
  const computed = compareRunCaptureFiles(left, right, input.generated_at)
  assert.deepEqual(plain(computed), { ...expected, generated_at: input.generated_at })
  assert.equal(JSON.stringify([left, right]), before, 'Comparison mutated a capture')
  assert.deepEqual(plain(parseRunCaptureFile(JSON.stringify(computed, null, 2))), {
    kind: 'comparison', captures: [expected.left, expected.right], generated_at: input.generated_at,
  })
  observations.compared++
}
for (const value of input.rejected ?? []) {
  assert.throws(() => parseRunCaptureFile(JSON.stringify(value, null, 2)))
  observations.rejected++
}
process.stdout.write(JSON.stringify(observations))
"""


@pytest.fixture
def exported_captures(tmp_path, monkeypatch):
    roots = (tmp_path / "uploads" / "run_captures", tmp_path / "states", tmp_path / "runs")
    monkeypatch.setattr(api.SimulationManager, "SIMULATION_DATA_DIR", str(roots[1]))
    monkeypatch.setattr(api.SimulationRunner, "RUN_STATE_DIR", str(roots[2]))
    monkeypatch.setattr(service, "_now", lambda: CAPTURED_AT)
    app = Flask(__name__)
    app.config["UPLOAD_FOLDER"] = str(tmp_path / "uploads")
    app.register_blueprint(api.run_captures_bp, url_prefix="/api/run-captures")
    return app.test_client(), roots


def node_parity(tmp_path, *, accepted=(), comparisons=(), rejected=()):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Capture file parity needs Node; no frontend packages or live services are required")
    fixture = tmp_path / "capture-file-parity.json"
    fixture.write_text(json.dumps({
        "accepted": accepted, "comparisons": comparisons, "rejected": rejected,
        "generated_at": COMPUTED_AT,
    }, ensure_ascii=True), encoding="ascii")
    run = subprocess.run([
        node, "--input-type=module", "-e", NODE_PARITY, str(fixture),
        str(REPO / "frontend/src/utils/runCaptureFiles.js"),
    ], cwd=REPO / "frontend", capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stdout + run.stderr
    result = json.loads(run.stdout)
    assert result["accepted"] == len(accepted)
    assert result["compared"] == len(comparisons)
    assert result["rejected"] == len(rejected)
    assert all(size <= 2 * 1024 * 1024 for size in result["wire_bytes"])
    return result


def prepare_source(roots, *, coverage="complete", names=("POST",), status="completed"):
    # Every capture observes a different saved run of the same simulation.
    # Removing only these fixture source directories prevents stale platform logs.
    for root in roots[1:]:
        shutil.rmtree(root / "sim_one", ignore_errors=True)
    log = saved(roots, actions=0, status=status, reddit=coverage == "missing_platform")
    logger = PlatformActionLogger("twitter", str(roots[2] / "sim_one"))
    for index, name in enumerate(names):
        logger.log_action(index, index // 2, "Synthetic agent", name, {}, None, True)
    if coverage == "partial":
        with log.open("a", encoding="utf-8") as stream:
            stream.write("invalid record\n")
    elif coverage == "unavailable":
        log.unlink()
    return log


def save_export(client, identifier, label="Saved observation"):
    observed = client.get("/api/run-captures/preview", query_string={"simulation_id": "sim_one"})
    assert observed.status_code == 200, observed.json
    response = client.post("/api/run-captures/records/" + identifier, json={
        "simulation_id": "sim_one", "source_revision": observed.json["data"]["source_revision"],
        "label": label, "note": "Synthetic saved observation\nExact historical values only.",
    })
    assert response.status_code == 201, response.json
    # Read the immutable object through the actual export source endpoint, not
    # merely the POST response or a hand-maintained frontend fixture.
    exported = client.get("/api/run-captures/records/" + identifier)
    assert exported.status_code == 200, exported.json
    assert exported.json == response.json
    capture = exported.json["data"]
    service._validate_capture(capture)
    assert len(service._canonical(capture)) <= service.MAX_CAPTURE_BYTES
    return capture


def export_comparison(client, left, right):
    response = client.get("/api/run-captures/compare", query_string={
        "left": left["capture_id"], "right": right["capture_id"],
    })
    assert response.status_code == 200, response.json
    result = response.json["data"]
    assert result["left"] == left and result["right"] == right
    return result


def test_real_zero_and_same_simulation_exports_reopen_without_capture_store(exported_captures, tmp_path):
    client, roots = exported_captures
    prepare_source(roots, names=("POST", "POST"))
    left = save_export(client, "a" * 32, "Two attempts")
    prepare_source(roots, names=())
    right = save_export(client, "b" * 32, "A complete empty observation")
    for root in roots[1:]:
        shutil.rmtree(root)
    pair = export_comparison(client, left, right)
    assert pair["differences"]["recorded_actions"] == -2
    assert right["observation"]["summary"]["metrics"]["recorded_actions"] == 0
    assert pair["differences"]["platforms"]["reddit"]["recorded_actions"] is None
    assert left["observation"]["summary"]["simulation_id"] == right["observation"]["summary"]["simulation_id"]
    assert left["observation"]["source_revision"] != right["observation"]["source_revision"]

    client.application.config["UPLOAD_FOLDER"] = str(tmp_path / "absent-installation")
    assert client.get("/api/run-captures/records/" + left["capture_id"]).status_code == 404
    assert client.get("/api/run-captures/compare", query_string={
        "left": left["capture_id"], "right": right["capture_id"],
    }).status_code == 404
    assert not (tmp_path / "absent-installation").exists()
    node_parity(tmp_path, accepted=[left, right, pair], comparisons=[pair])


@pytest.mark.parametrize("left_coverage,right_coverage", itertools.product(
    ("complete", "partial", "unavailable"), repeat=2,
))
def test_actual_export_comparisons_match_every_aggregate_coverage_pair(
    exported_captures, tmp_path, left_coverage, right_coverage,
):
    client, roots = exported_captures
    prepare_source(roots, coverage=left_coverage, names=("POST", "__proto__", "\ue000"))
    left = save_export(client, "1" * 32)
    prepare_source(roots, coverage=right_coverage, names=("POST", "constructor", "\U00010000", "POST"))
    right = save_export(client, "2" * 32)
    assert left["observation"]["summary"]["availability"] == left_coverage
    assert right["observation"]["summary"]["availability"] == right_coverage
    pair = export_comparison(client, left, right)
    reverse = export_comparison(client, right, left)
    complete = left_coverage == right_coverage == "complete"
    assert pair["differences"]["recorded_actions"] == (1 if complete else None)
    if left_coverage != "unavailable" and right_coverage != "unavailable":
        rows = {row["action_type"]: row for row in pair["differences"]["action_types"]}
        assert rows["constructor"]["left"] == (0 if left_coverage == "complete" else None)
        assert rows["__proto__"]["right"] == (0 if right_coverage == "complete" else None)
    node_parity(tmp_path, accepted=[left, right, pair, reverse], comparisons=[pair, reverse])


@pytest.mark.parametrize("status", ["completed", "stopped", "failed"])
def test_partial_global_coverage_keeps_complete_platform_deltas(exported_captures, tmp_path, status):
    client, roots = exported_captures
    prepare_source(roots, coverage="missing_platform", status=status, names=("POST",))
    left = save_export(client, "3" * 32)
    prepare_source(roots, names=("POST", "POST", "LIKE"))
    right = save_export(client, "4" * 32)
    summary = left["observation"]["summary"]
    assert summary["status"] == status
    assert summary["availability"] == "partial"
    assert summary["metrics"]["platforms"]["twitter"]["availability"] == "complete"
    if status != "completed":
        assert {"code": "partial_run"} in summary["warnings"]
    pair = export_comparison(client, left, right)
    assert pair["differences"]["recorded_actions"] is None
    assert pair["differences"]["platforms"]["twitter"]["recorded_actions"] == 2
    assert pair["differences"]["platforms"]["reddit"]["recorded_actions"] is None
    node_parity(tmp_path, accepted=[left, pair], comparisons=[pair])


def test_literal_names_legacy_surrogates_and_exact_decimal_context_roundtrip(exported_captures, tmp_path):
    client, roots = exported_captures
    names = ["__proto__", "constructor", "hasOwnProperty", "toString", "\ue000", "\U00010000"]
    prepare_source(roots, names=names)
    state_path = roots[1] / "sim_one/state.json"
    state = json.loads(state_path.read_text())
    state.update(project_id=2**70, graph_id="graph\udfff", profiles_count=2**63 + 1)
    write_json(state_path, state)
    write_json(roots[1] / "sim_one/simulation_config.json", {
        "simulation_requirement": "Legacy \ud800 and \udfff context · \U00010000 · <script>literal</script>",
        "llm_model": "historical\ud800model",
    })
    left = save_export(client, "5" * 32, "历史记录 \U00010000")
    summary = left["observation"]["summary"]
    assert summary["project_id"] == str(2**70)
    assert summary["configured_agents"] == str(2**63 + 1)
    assert "\ud800" in summary["scenario"] and "\udfff" in summary["scenario"]
    assert [row["action_type"] for row in summary["metrics"]["action_types"]] == names
    prepare_source(roots, names=())
    right = save_export(client, "6" * 32)
    pair = export_comparison(client, left, right)
    assert [row["action_type"] for row in pair["differences"]["action_types"]] == names
    assert all(row["difference"] == -1 for row in pair["differences"]["action_types"])
    node_parity(tmp_path, accepted=[left, right, pair], comparisons=[pair])


def test_exact_canonical_limit_exports_and_one_byte_overflow(exported_captures, tmp_path):
    client, roots = exported_captures
    captures = []
    for side, identifier in (("L", "7" * 32), ("R", "8" * 32)):
        names = [f"{side}{index:03d}" + "\U00010000" * 252 for index in range(70)]
        prepare_source(roots, names=names)
        config = roots[1] / "sim_one/simulation_config.json"
        write_json(config, {"simulation_requirement": ""})
        observed = client.get("/api/run-captures/preview?simulation_id=sim_one")
        assert observed.status_code == 200, observed.json
        label = "Canonical boundary " + side
        candidate = {
            "schema_version": 1, "capture_id": identifier, "label": label,
            "note": "Synthetic saved observation\nExact historical values only.",
            "captured_at": CAPTURED_AT, "observation": observed.json["data"],
        }
        padding = service.MAX_CAPTURE_BYTES - len(service._canonical(candidate))
        assert padding > 0
        write_json(config, {"simulation_requirement": "x" * padding})
        capture = save_export(client, identifier, label)
        assert len(service._canonical(capture)) == 256 * 1024
        captures.append(capture)
    pair = export_comparison(client, *captures)
    assert len(pair["differences"]["action_types"]) == 140
    assert pair["differences"]["recorded_actions"] == 0

    oversized = copy.deepcopy(captures[1])
    oversized["observation"]["summary"]["scenario"] += "x"
    assert len(service._canonical(oversized)) == 256 * 1024 + 1
    # The schema remains valid, but storage and the local parser must each apply
    # the independent canonical-byte budget, even when UTF-8 downloads are small.
    service._validate_capture(oversized)
    write_json(config, {"simulation_requirement": "x" * (padding + 1)})
    observed = client.get("/api/run-captures/preview?simulation_id=sim_one")
    assert observed.status_code == 200, observed.json
    response = client.post("/api/run-captures/records/" + "9" * 32, json={
        "simulation_id": "sim_one", "source_revision": observed.json["data"]["source_revision"],
        "label": captures[1]["label"], "note": captures[1]["note"],
    })
    assert response.status_code == 413, response.json
    assert response.json["error_code"] == "capture_too_large"
    oversized_pair = copy.deepcopy(pair)
    oversized_pair["right"] = oversized
    result = node_parity(tmp_path, accepted=[*captures, pair], comparisons=[pair],
                         rejected=[oversized, oversized_pair])
    assert result["wire_bytes"][0] < 256 * 1024
    assert result["wire_bytes"][2] > 256 * 1024


def test_comparison_download_rejects_forged_values_nulls_order_and_extra_keys(exported_captures, tmp_path):
    client, roots = exported_captures
    prepare_source(roots, names=("__proto__", "constructor", "\ue000", "\U00010000"))
    left = save_export(client, "a" * 32)
    prepare_source(roots, names=())
    right = save_export(client, "b" * 32)
    pair = export_comparison(client, left, right)
    forged_total = copy.deepcopy(pair)
    forged_total["differences"]["recorded_actions"] += 1
    forged_null = copy.deepcopy(pair)
    forged_null["differences"]["platforms"]["reddit"]["recorded_actions"] = 0
    forged_order = copy.deepcopy(pair)
    forged_order["differences"]["action_types"].reverse()
    forged_type = copy.deepcopy(pair)
    forged_type["differences"]["action_types"][0]["difference"] = 0
    extra_field = {**pair, "source_verified": True}
    same_id = {**pair, "right": left}
    rejected = [forged_total, forged_null, forged_order, forged_type, extra_field, same_id,
                {"success": True, "data": pair}]
    node_parity(tmp_path, accepted=[pair], rejected=rejected)


@pytest.mark.parametrize("coverage", ["complete", "partial"])
def test_actual_flask_exports_complete_compiled_vue_file_workflow(exported_captures, tmp_path, coverage):
    node = shutil.which("node")
    if node is None or not (REPO / "frontend/node_modules/vue/package.json").is_file():
        pytest.skip("Compiled capture-file workflow needs Node and installed frontend dependencies")
    client, roots = exported_captures
    prepare_source(roots, coverage=coverage, names=("__proto__", "constructor", "\ue000", "\U00010000"))
    write_json(roots[1] / "sim_one/simulation_config.json", {
        "simulation_requirement": "Historical \ud800 context <script>literal</script> \U00010000",
    })
    left = save_export(client, "c" * 32, "Literal <img> historical capture")
    prepare_source(roots, names=())
    right = save_export(client, "d" * 32)
    comparison = export_comparison(client, left, right)
    # Removing all backend data before starting Node demonstrates that the view
    # consumes downloaded evidence, without hidden Flask or source dependencies.
    for root in roots:
        shutil.rmtree(root)
    fixture = tmp_path / "capture-file-view-exports.json"
    fixture.write_text(json.dumps({"left": left, "right": right, "comparison": comparison},
                                  ensure_ascii=True), encoding="ascii")
    run = subprocess.run([
        node, str(Path(__file__).with_name("run_capture_file_ui_parity.mjs")), str(fixture),
    ], cwd=REPO / "frontend", capture_output=True, text=True, timeout=45)
    assert run.returncode == 0, run.stdout + run.stderr
    assert "compiled Vue file selection/use/compare/download passed in en and zh" in run.stdout
