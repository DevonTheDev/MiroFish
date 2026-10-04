import { acceptPromptTrialSnapshot, isPromptTrialTerminal } from '../api/promptTrials.js'
import { parseBoundedJson } from './boundedJson.js'

export const PROMPT_TRIAL_FILE_MAX_BYTES = 512 * 1024
const comparisonKind = 'mirofish_local_prompt_trial_comparison'
const invalid = () => { throw new Error('Invalid prompt trial file') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

// Admission is entirely local and reuses the live fixed-field projection. Saved
// terminal observations remain useful when runtime availability or caps change.
export function parsePromptTrialFile(source) {
  try {
    // UTF-8 needs at least as many bytes as UTF-16 code units. Reject oversized
    // strings before the bounded parser allocates their encoded representation.
    if (typeof source !== 'string' || source.length > PROMPT_TRIAL_FILE_MAX_BYTES) return invalid()
    const raw = parseBoundedJson(source, PROMPT_TRIAL_FILE_MAX_BYTES, 10, invalid, true)
    if (!object(raw)) return invalid()
    let candidates = [raw]
    if (raw.kind === comparisonKind) {
      if (Object.keys(raw).length !== 3 || !['schema_version', 'kind', 'trials'].every(key => Object.hasOwn(raw, key)) ||
        raw.schema_version !== 1 || !Array.isArray(raw.trials) || raw.trials.length !== 2) return invalid()
      candidates = raw.trials
    }
    const snapshots = candidates.map(candidate => {
      const snapshot = acceptPromptTrialSnapshot({ success: true, data: candidate })
      if (snapshot.mode !== 'local' || !isPromptTrialTerminal(snapshot.run)) return invalid()
      return snapshot
    })
    if (new Set(snapshots.map(snapshot => snapshot.run.request_id)).size !== snapshots.length) return invalid()
    return freeze({ source_kind: raw.kind, snapshots })
  } catch { return invalid() }
}
