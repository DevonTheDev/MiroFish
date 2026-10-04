import { acceptPromptTrialSnapshot, isPromptTrialTerminal } from '../api/promptTrials.js'
import { acceptPromptSuiteDefinition, exportPromptSuiteDefinition } from './promptSuites.js'

const invalid = () => { throw new Error('Invalid prompt trial suite') }
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

// Reuse recorded inputs offline. Runtime readiness and loaded caps belong to
// the later explicit Run; recorded replies never become expected answers.
export function buildPromptSuiteFromTrials(source) {
  try {
    const { name, snapshots, caseIds } = source
    if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 5 ||
      !Array.isArray(caseIds) || caseIds.length !== snapshots.length) return invalid()
    const admitted = Array.from(snapshots, candidate => {
      const snapshot = acceptPromptTrialSnapshot({ success: true, data: candidate })
      if (snapshot.mode !== 'local' || !isPromptTrialTerminal(snapshot.run)) return invalid()
      return snapshot
    })
    const requestIds = new Set(admitted.map(snapshot => snapshot.run.request_id))
    if (requestIds.size !== admitted.length || caseIds.some(id => requestIds.has(id))) return invalid()
    const definition = acceptPromptSuiteDefinition({ schema_version: 1, kind: 'mirofish_local_prompt_suite', name,
      cases: admitted.map((snapshot, index) => ({ case_id: caseIds[index], ...snapshot.run.request, expected_text: null })) })
    // Export validates the complete pretty-printed byte budget before capture.
    const json_text = exportPromptSuiteDefinition(definition)
    return freeze({ definition, json_text })
  } catch { return invalid() }
}
