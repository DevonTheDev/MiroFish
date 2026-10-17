#!/bin/bash
# Uses existing dependencies only; retains generated evidence and stops on failure.
set -euo pipefail
RECIPE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
RECIPE_PYTHON=${MIROFISH_TEST_PYTHON:-python3}
RECIPE_NODE=${MIROFISH_TEST_NODE:-node}
RECIPE_EVIDENCE=$(mktemp -d "${TMPDIR:-/tmp}/mirofish-input-recipes.XXXXXX")
printf 'Recipe test evidence: %s\n' "$RECIPE_EVIDENCE"
stage() {
  local label="$1"; shift
  printf '%s\n' "$EPOCHREALTIME" > "$RECIPE_EVIDENCE/$label.started"
  set +e
  "$@" > "$RECIPE_EVIDENCE/$label.log" 2>&1
  local result=$?
  set -e
  printf '%s\n' "$EPOCHREALTIME" > "$RECIPE_EVIDENCE/$label.ended"
  printf '%s\n' "$result" > "$RECIPE_EVIDENCE/$label.exit"
  cat "$RECIPE_EVIDENCE/$label.log"
  if [ "$result" -ne 0 ]; then exit "$result"; fi
}
stage 01-backend timeout --signal=TERM --kill-after=5s 60s env -i PATH="$PATH" LANG=C.UTF-8 "$RECIPE_PYTHON" -I -B "$RECIPE_ROOT/scripts/test_project_input_recipes_backend.py" "$RECIPE_EVIDENCE"
test -s "$RECIPE_EVIDENCE/backend-input-recipe.json"
test -s "$RECIPE_EVIDENCE/backend-input-recipe.sha256"
cd "$RECIPE_ROOT/frontend"
ulimit -t 150
ulimit -f 32768
ulimit -n 256
stage 02-parser timeout --signal=TERM --kill-after=5s 30s env -i PATH="$PATH" LANG=C.UTF-8 TZ=UTC "$RECIPE_NODE" --max-old-space-size=512 --require "$RECIPE_ROOT/scripts/project-input-recipes-no-network.cjs" --test --test-concurrency=1 tests/project-input-recipe-parser.test.js
stage 03-recipe-views timeout --signal=TERM --kill-after=5s 120s env -i PATH="$PATH" LANG=C.UTF-8 TZ=UTC MIROFISH_RECIPE_FIXTURE_OUTPUT="$RECIPE_EVIDENCE/backend-input-recipe.json" "$RECIPE_NODE" --max-old-space-size=512 --require "$RECIPE_ROOT/scripts/project-input-recipes-no-network.cjs" --experimental-vm-modules --test --test-concurrency=1 tests/home-input-recipe.integration.js tests/project-input-recipe-download.test.js
stage 04-regressions timeout --signal=TERM --kill-after=5s 120s env -i PATH="$PATH" LANG=C.UTF-8 TZ=UTC "$RECIPE_NODE" --max-old-space-size=512 --require "$RECIPE_ROOT/scripts/project-input-recipes-no-network.cjs" --experimental-vm-modules --test --test-concurrency=1 tests/home-file-reselection.test.js tests/home-pasted-source.test.js tests/home-start-handoff.test.js tests/home-submission-restoration.test.js tests/history-database-keyboard.test.js tests/history-database-loading.test.js tests/graph-stop-api.test.js tests/graph-stop-control.test.js
