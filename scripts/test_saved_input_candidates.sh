#!/bin/bash
# Existing dependencies only; retains evidence and stops on the first failed command.
set -euo pipefail
CANDIDATE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CANDIDATE_PYTHON=${MIROFISH_TEST_PYTHON:-python3}
CANDIDATE_NODE=${MIROFISH_TEST_NODE:-node}
CANDIDATE_EVIDENCE=$(mktemp -d "${TMPDIR:-/tmp}/mirofish-input-candidates.XXXXXX")
printf 'Saved input candidate evidence: %s\n' "$CANDIDATE_EVIDENCE"
stage() {
  local label="$1"; shift
  printf '%s\n' "$EPOCHREALTIME" > "$CANDIDATE_EVIDENCE/$label.started"
  set +e
  "$@" > "$CANDIDATE_EVIDENCE/$label.log" 2>&1
  local result=$?
  set -e
  printf '%s\n' "$EPOCHREALTIME" > "$CANDIDATE_EVIDENCE/$label.ended"
  printf '%s\n' "$result" > "$CANDIDATE_EVIDENCE/$label.exit"
  cat "$CANDIDATE_EVIDENCE/$label.log"
  if [ "$result" -ne 0 ]; then exit "$result"; fi
}
stage 01-backend timeout --signal=TERM --kill-after=5s 60s env -i PATH="$PATH" LANG=C.UTF-8 "$CANDIDATE_PYTHON" -I -B "$CANDIDATE_ROOT/scripts/test_saved_input_candidates_backend.py" "$CANDIDATE_EVIDENCE"
test -s "$CANDIDATE_EVIDENCE/backend-input-candidates.json"
test -s "$CANDIDATE_EVIDENCE/backend-input-candidates.sha256"
test -s "$CANDIDATE_EVIDENCE/backend-input-recipe.json"
test -s "$CANDIDATE_EVIDENCE/backend-input-recipe.sha256"
cd "$CANDIDATE_ROOT/frontend"
ulimit -t 150
ulimit -f 32768
ulimit -n 256
stage 02-adapter timeout --signal=TERM --kill-after=5s 30s env -i PATH="$PATH" LANG=C.UTF-8 TZ=UTC "$CANDIDATE_NODE" --max-old-space-size=512 --require "$CANDIDATE_ROOT/scripts/project-input-recipes-no-network.cjs" --test --test-concurrency=1 tests/project-input-candidates-api.test.js
stage 03-picker timeout --signal=TERM --kill-after=5s 120s env -i PATH="$PATH" LANG=C.UTF-8 TZ=UTC MIROFISH_CANDIDATE_FIXTURE_DIR="$CANDIDATE_EVIDENCE" "$CANDIDATE_NODE" --max-old-space-size=512 --require "$CANDIDATE_ROOT/scripts/project-input-recipes-no-network.cjs" --experimental-vm-modules --test --test-concurrency=1 tests/saved-input-picker.integration.js
stage 04-home-regressions timeout --signal=TERM --kill-after=5s 120s env -i PATH="$PATH" LANG=C.UTF-8 TZ=UTC MIROFISH_RECIPE_FIXTURE_OUTPUT="$CANDIDATE_EVIDENCE/backend-input-recipe.json" "$CANDIDATE_NODE" --max-old-space-size=512 --require "$CANDIDATE_ROOT/scripts/project-input-recipes-no-network.cjs" --experimental-vm-modules --test --test-concurrency=1 tests/home-input-recipe.integration.js tests/home-start-handoff.test.js
