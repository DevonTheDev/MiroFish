import { acceptPromptSuiteReport, getPromptSuiteCheck, evaluatePromptSuiteCheck } from './promptSuites.js'

export const PROMPT_EXAMPLES_JSONL_MAX_BYTES = 1024 * 1024
export const PROMPT_EXAMPLES_REVIEW_MAX_BYTES = 4 * 1024 * 1024
const sources = new WeakMap(), reviews = new WeakMap(), bundles = new WeakMap()
const invalid = kind => { throw new Error(`Invalid prompt examples ${kind}`) }
const bytes = value => new TextEncoder().encode(value).length
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
const target = value => typeof value === 'string' && value.length <= 32768 && value.trim().length > 0 && Array.from(value).length <= 16384 &&
  bytes(value) <= 65536 && !/[\p{Cc}\p{Cs}]/u.test(value.replace(/[\r\n\t]/g, ''))
const detach = value => Array.isArray(value) ? value.map(detach) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, detach(item)])) : value
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function capture(report) {
  freeze(report)
  return Object.freeze({ toReport: () => detach(report) })
}

// Capture one admitted historical report. Report objects returned for display
// are detached; only factory-owned handles can authorize a later export.
export function capturePromptExampleSource(reportSource) {
  try {
    const report = acceptPromptSuiteReport(reportSource), source = capture(report)
    sources.set(source, report)
    return source
  } catch { return invalid('source') }
}

export function approvePromptExampleTarget(sourceCapture, caseId, targetText, options = {}) {
  try {
    const { reviewedAt = new Date().toISOString() } = options
    const report = sources.get(sourceCapture)
    if (!report || !target(targetText) || !timestamp(reviewedAt)) return invalid('approval')
    const index = report.definition.cases.findIndex(item => item.case_id === caseId)
    if (index < 0) return invalid('approval')
    const input = report.definition.cases[index], row = report.cases[index], check = getPromptSuiteCheck(input)
    // Normalize the check for evaluation without changing the captured v1/v2/v3
    // definition or treating the historical response as an approved target.
    const approved = { case_id: caseId, target_text: targetText, reviewed_at: reviewedAt,
      target_check: evaluatePromptSuiteCheck({ check_kind: check.kind, expected_text: check.expected_text,
        required_fields: check.required_fields }, 'succeeded', targetText),
      captured_reply_equal: row.status === 'succeeded' ? row.snapshot.run.response.content === targetText : null }
    const approval = capture(approved)
    reviews.set(approval, { source: sourceCapture, report: approved })
    return approval
  } catch { return invalid('approval') }
}

function messages(input, targetText) {
  // Match the runtime: only the empty string omits the system message.
  return [...(input.system_prompt === '' ? [] : [{ role: 'system', content: input.system_prompt }]),
    { role: 'user', content: input.user_prompt }, { role: 'assistant', content: targetText }]
}

export function buildPromptExamples(sourceCapture, approvals, options = {}) {
  try {
    const { capturedAt = new Date().toISOString() } = options
    const source = sources.get(sourceCapture)
    if (!source || !timestamp(capturedAt) || !Array.isArray(approvals)) return invalid('bundle')
    const count = approvals.length
    if (!Number.isInteger(count) || count < 1 || count > 5) return invalid('bundle')
    const selected = new Map()
    for (let index = 0; index < count; index++) {
      const review = reviews.get(approvals[index])
      if (!review || review.source !== sourceCapture || selected.has(review.report.case_id)) return invalid('bundle')
      selected.set(review.report.case_id, review.report)
    }
    let lineNumber = 0
    const examples = source.definition.cases.flatMap((input, index) => {
      const review = selected.get(input.case_id)
      return review ? [{ position: index + 1, line_number: ++lineNumber, case_id: input.case_id, reviewed_at: review.reviewed_at,
        target_check: review.target_check, captured_reply_equal: review.captured_reply_equal,
        messages: messages(input, review.target_text), source_input: input, source_row: source.cases[index] }] : []
    })
    const report = { schema_version: 1, kind: 'mirofish_reviewed_prompt_examples', captured_at: capturedAt,
      source_summary: { schema_version: source.schema_version, run_id: source.run_id, suite_name: source.definition.name,
        started_at: source.started_at, finished_at: source.finished_at, status: source.status,
        stop_requested: source.stop_requested, halt_code: source.halt_code, total_case_count: source.cases.length },
      examples,
      notes: [
        'User-approved for export; approval does not establish correctness or authenticated origin.',
        'The historical source check remains separate from the approved target check.',
        'This export performs no training or chat-template application and does not guarantee hardware fit.',
        'Keep held-out evaluations separate from training examples.',
        'Selected prompts and captured replies are present in this review file; inspect before sharing.',
      ] }
    const bundle = capture(report)
    bundles.set(bundle, { source: sourceCapture, report })
    return bundle
  } catch { return invalid('bundle') }
}

// Export only the stored reviewed selection. No runtime queries, automatic
// approvals, model-specific template tokens, training or truncation occur here.
export function exportPromptExamples(bundle) {
  try {
    const stored = bundles.get(bundle)
    if (!stored) return invalid('export')
    const report = stored.report
    const jsonlText = report.examples.map(example => JSON.stringify({ messages: example.messages }) + '\n').join('')
    const reviewJsonText = JSON.stringify(report, null, 2)
    if (bytes(jsonlText) > PROMPT_EXAMPLES_JSONL_MAX_BYTES || bytes(reviewJsonText) > PROMPT_EXAMPLES_REVIEW_MAX_BYTES) return invalid('export')
    return Object.freeze({ jsonl_text: jsonlText, review_json_text: reviewJsonText, captured_at: report.captured_at })
  } catch { return invalid('export') }
}
