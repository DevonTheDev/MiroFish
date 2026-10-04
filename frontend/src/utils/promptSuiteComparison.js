import { acceptPromptSuiteReport } from './promptSuites.js'

export const PROMPT_SUITE_COMPARISON_MAX_BYTES = 4 * 1024 * 1024
const evaluationInputs = ['system_prompt', 'user_prompt', 'temperature', 'max_output_tokens', 'expected_text']
const captures = new WeakMap()
const invalid = (kind = 'comparison') => { throw new Error(`Invalid prompt suite ${kind}`) }
const bytes = value => new TextEncoder().encode(value).length
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
const detach = value => Array.isArray(value) ? value.map(detach) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, detach(item)])) : value
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function configurations(report) {
  const observed = []
  let missingCases = 0
  for (const row of report.cases) {
    const configuration = row.snapshot?.run?.configuration
    if (!configuration) missingCases++
    else if (!observed.some(item => item.model === configuration.model && item.reasoning_effort === configuration.reasoning_effort)) {
      observed.push({ ...configuration })
    }
  }
  return { observed, missing_cases: missingCases, mixed: observed.length > 1 }
}

function compareRow(caseId, baseline, comparison, baselineRequestIds, comparisonRequestIds) {
  const shared = baseline !== undefined && comparison !== undefined
  const inputChanges = shared ? Object.fromEntries(evaluationInputs.map(key => [key, baseline.input[key] !== comparison.input[key]])) : null
  const sameInputs = shared ? !Object.values(inputChanges).some(Boolean) : null
  // A reused request can appear under a different case ID, including an added
  // or removed case. Membership still joins only by case ID; observation reuse
  // conservatively excludes the shared row's paired findings across the reports.
  const requestIdOverlap = shared
    ? comparisonRequestIds.has(baseline.row.request_id) || baselineRequestIds.has(comparison.row.request_id) : null
  const eligible = shared && sameInputs && baseline.row.status === 'succeeded' && comparison.row.status === 'succeeded' && requestIdOverlap === false
  let transition = null, replyEqual = null, durationDelta = null
  if (eligible) {
    const left = baseline.row.snapshot.run, right = comparison.row.snapshot.run
    replyEqual = left.response.content === right.response.content
    if (left.request_duration_ms !== null && right.request_duration_ms !== null) durationDelta = right.request_duration_ms - left.request_duration_ms
    if (baseline.input.expected_text !== null) {
      const leftMatched = baseline.row.check === 'matched', rightMatched = comparison.row.check === 'matched'
      transition = leftMatched ? (rightMatched ? 'retained_match' : 'lost_match') : (rightMatched ? 'gained_match' : 'retained_mismatch')
    }
  }
  return { case_id: caseId, membership: shared ? 'shared' : baseline ? 'removed' : 'added',
    baseline_position: baseline?.position ?? null, comparison_position: comparison?.position ?? null,
    label_changed: shared ? baseline.input.label !== comparison.input.label : false,
    input_changes: inputChanges, same_inputs: sameInputs, request_id_overlap: requestIdOverlap,
    paired_succeeded: eligible, exact_transition: transition, reply_equal: replyEqual, request_duration_delta_ms: durationDelta }
}

// The only admitted inputs are v1 suite-run reports. Every result belongs to this
// immutable historical capture; later slot edits and returned-object edits cannot
// alter it, and downloads never recalculate findings or query the runtime.
export function comparePromptSuiteReports(baselineSource, comparisonSource, { capturedAt = new Date().toISOString() } = {}) {
  try {
    const baseline = acceptPromptSuiteReport(baselineSource), comparison = acceptPromptSuiteReport(comparisonSource)
    if (baseline.run_id === comparison.run_id || !timestamp(capturedAt)) return invalid()
    const indexed = report => new Map(report.definition.cases.map((input, index) =>
      [input.case_id, { input, row: report.cases[index], position: index + 1 }]))
    const baselineCases = indexed(baseline), comparisonCases = indexed(comparison)
    const requestIds = report => new Set(report.cases.map(row => row.request_id).filter(id => id !== null))
    const baselineRequestIds = requestIds(baseline), comparisonRequestIds = requestIds(comparison)
    const ids = [...comparisonCases.keys(), ...[...baselineCases.keys()].filter(id => !comparisonCases.has(id))]
    const rows = ids.map(id => compareRow(id, baselineCases.get(id), comparisonCases.get(id), baselineRequestIds, comparisonRequestIds))
    const baselineShared = [...baselineCases.keys()].filter(id => comparisonCases.has(id))
    const comparisonShared = [...comparisonCases.keys()].filter(id => baselineCases.has(id))
    const count = predicate => rows.filter(predicate).length
    const report = freeze({ schema_version: 1, kind: 'mirofish_local_prompt_suite_comparison', captured_at: capturedAt,
      baseline, comparison,
      definition_changes: { name: baseline.definition.name !== comparison.definition.name,
        relative_order: baselineShared.some((id, index) => comparisonShared[index] !== id) },
      configuration_summary: { baseline: configurations(baseline), comparison: configurations(comparison) }, rows,
      summary: { baseline_cases: baseline.cases.length, comparison_cases: comparison.cases.length,
        added: count(row => row.membership === 'added'), removed: count(row => row.membership === 'removed'), shared: count(row => row.membership === 'shared'),
        same_inputs: count(row => row.same_inputs === true), paired_succeeded: count(row => row.paired_succeeded),
        evaluated_pairs: count(row => row.exact_transition !== null), gained_matches: count(row => row.exact_transition === 'gained_match'),
        lost_matches: count(row => row.exact_transition === 'lost_match'), retained_matches: count(row => row.exact_transition === 'retained_match'),
        retained_mismatches: count(row => row.exact_transition === 'retained_mismatch'), overlapping_request_pairs: count(row => row.request_id_overlap === true) } })
    const capture = Object.freeze({ toReport: () => detach(report) })
    captures.set(capture, report)
    return capture
  } catch { return invalid() }
}

// JSON already quotes line breaks, tabs, C0 controls and literal backslashes.
// Also quote C1, direction/format controls and Unicode line separators so imported
// text cannot create headings, hide labels or reorder the fixed report structure.
const literalJson = value => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu,
  character => character.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))

export function exportPromptSuiteComparison(capture) {
  try {
    const report = captures.get(capture)
    if (!report) return invalid('comparison export')
    const jsonText = JSON.stringify(report, null, 2)
    const text = ['MiroFish local prompt suite comparison',
      'Recorded observations only. Model and reasoning labels do not verify weights or honored settings.',
      'Request duration excludes startup and cleanup; elapsed time is separate. Hardware and warm-up equivalence are unknown.',
      'Paired findings require unchanged evaluation inputs, two succeeded rows and neither request ID appearing anywhere in the opposite report.',
      'Null means unavailable or inapplicable; zero is a recorded numeric value.',
      `Captured at: ${literalJson(report.captured_at)}`,
      'Definition changes:', literalJson(report.definition_changes),
      'Recorded configuration summary:', literalJson(report.configuration_summary),
      'Case comparison rows:', literalJson(report.rows),
      'Case counts:', literalJson(report.summary),
      'Baseline report (recorded data):', literalJson(report.baseline),
      'Comparison report (recorded data):', literalJson(report.comparison), ''].join('\n')
    if (bytes(jsonText) > PROMPT_SUITE_COMPARISON_MAX_BYTES || bytes(text) > PROMPT_SUITE_COMPARISON_MAX_BYTES) return invalid('comparison export')
    return { json_text: jsonText, text, captured_at: report.captured_at }
  } catch { return invalid('comparison export') }
}
