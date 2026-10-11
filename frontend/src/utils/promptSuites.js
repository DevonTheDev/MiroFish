import { parseBoundedJson as parseJson } from './boundedJson.js'
import { acceptPromptTrialInputs, acceptPromptTrialSnapshot, samePromptTrialRequest } from '../api/promptTrials.js'

export const PROMPT_SUITE_MAX_BYTES = 128 * 1024
export const PROMPT_SUITE_REPORT_MAX_BYTES = 1024 * 1024
export const PROMPT_SUITE_ERROR_CODES = Object.freeze(['invalid_definition', 'read_failed', 'invalid_observation', 'identity_mismatch',
  'backend_unavailable', 'backend_running', 'loaded_cap', 'admission_rejected', 'observation_limit', 'invalid_identity', 'runtime_failed'])
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const invalid = kind => { throw new Error(`Invalid prompt suite ${kind}`) }
const exact = (source, keys) => source !== null && typeof source === 'object' && !Array.isArray(source) &&
  Reflect.ownKeys(source).length === keys.length && keys.every(key => Object.hasOwn(source, key))
const bytes = value => new TextEncoder().encode(value).length
const text = (value, cap, plain = false, required = false) => typeof value === 'string' && Array.from(value).length <= cap &&
  (!required || value.trim().length > 0) && !(plain ? /\p{C}/u : /[\p{Cc}\p{Cs}]/u).test(plain ? value : value.replace(/[\r\n\t]/g, ''))
const definitionKeys = ['schema_version', 'kind', 'name', 'cases']
const caseKeys = ['case_id', 'label', 'system_prompt', 'user_prompt', 'temperature', 'max_output_tokens', 'expected_text']
const checkKinds = ['none', 'exact_text', 'json_object']
const fieldTypes = ['string', 'number', 'boolean', 'object', 'array', 'null']

// Callers pass admitted cases. Legacy expectations retain their exact semantics
// without adding fields to v1 definitions or their exported historical reports.
export function getPromptSuiteCheck(item) {
  return { kind: item.check_kind ?? (item.expected_text === null ? 'none' : 'exact_text'), expected_text: item.expected_text,
    ...(item.check_kind === 'json_fields' ? { required_fields: item.required_fields } : {}) }
}

const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const hasLiteral = rule => Object.hasOwn(rule, 'equals')
const literalTypes = ['string', 'number', 'boolean', 'null']
// JSON quoting is also used for display: format and directional characters must
// not hide labels or reorder the visible requirement and diagnostic text.
const literalText = value => JSON.stringify(value).replace(/[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu,
  character => character.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))

function acceptFieldLiteral(value, type) {
  if (!literalTypes.includes(type) || valueType(value) !== type ||
    (type === 'string' && !text(value, 500)) || (type === 'number' && !Number.isFinite(value))) return invalid('field literal')
  return type === 'number' && value === 0 ? 0 : value
}

export function parsePromptSuiteFieldLiteral(source, type) {
  return acceptFieldLiteral(parseJson(source, 4096, 0, () => invalid('field literal'), true, 1), type)
}

export function formatPromptSuiteRequiredFields(item) {
  return item.required_fields.map(rule => `${JSON.stringify(rule.name)}: ${rule.type}${hasLiteral(rule) ? ` = ${literalText(rule.equals)}` : ''}`).join('\n')
}

// Status and display-only feedback share this path. Reports continue to store
// only the historical check status, never diagnostics derived for the UI.
function checkResult(item, status, content) {
  if (status !== 'succeeded') return { status: 'not_evaluated', failure: null }
  const check = getPromptSuiteCheck(item)
  if (check.kind === 'none') return { status: 'not_requested', failure: null }
  let matched, failure = null
  if (check.kind === 'json_object' || check.kind === 'json_fields') {
    const reply = parseJsonObjectReply(content)
    if (reply === null) failure = { code: 'invalid_object', params: {} }
    else if (check.kind === 'json_fields') {
      for (const rule of check.required_fields) {
        const name = literalText(rule.name)
        if (!Object.hasOwn(reply, rule.name)) failure = { code: 'missing_field', params: { name } }
        else {
          const value = reply[rule.name], actualType = valueType(value)
          if (actualType !== rule.type) failure = { code: 'type_mismatch', params: { name, expectedType: rule.type, actualType } }
          else if (hasLiteral(rule) && value !== rule.equals) {
            const expected = literalText(rule.equals)
            failure = actualType === 'string' && Array.from(value).length > 500
              ? { code: 'literal_mismatch_long_string', params: { name, expected } }
              : { code: 'literal_mismatch', params: { name, expected, actual: literalText(value) } }
          }
        }
        if (failure) break
      }
    }
    matched = failure === null
  } else matched = content === check.expected_text
  return { status: matched ? 'matched' : 'mismatched', failure }
}

export function evaluatePromptSuiteCheck(item, status, content) {
  return checkResult(item, status, content).status
}

export function getPromptSuiteCheckFailure(item, status, content) {
  if (getPromptSuiteCheck(item).kind !== 'json_fields' || !item.required_fields.some(hasLiteral)) return null
  return checkResult(item, status, content).failure
}

function acceptRequiredFields(item, version) {
  if (item.check_kind !== 'json_fields') {
    if (item.required_fields !== null) return invalid('definition')
    return null
  }
  if (!Array.isArray(item.required_fields) || item.required_fields.length < 1 || item.required_fields.length > 10) return invalid('definition')
  const names = new Set()
  return Array.from(item.required_fields, rule => {
    const literal = rule !== null && typeof rule === 'object' && hasLiteral(rule)
    if (!exact(rule, ['name', 'type', ...(version === 4 && literal ? ['equals'] : [])]) ||
      (version === 4 && !literal && 'equals' in rule) || !text(rule.name, 80, true, true) || names.has(rule.name) || !fieldTypes.includes(rule.type)) return invalid('definition')
    names.add(rule.name)
    return { name: rule.name, type: rule.type, ...(literal ? { equals: acceptFieldLiteral(rule.equals, rule.type) } : {}) }
  })
}

export function acceptPromptSuiteDefinition(source) {
  try {
    if (!exact(source, definitionKeys) || ![1, 2, 3, 4].includes(source.schema_version) || source.kind !== 'mirofish_local_prompt_suite' ||
      !text(source.name, 80, true, true) || !Array.isArray(source.cases) || source.cases.length < 1 || source.cases.length > 5) return invalid('definition')
    const explicitCheck = source.schema_version >= 2, withFields = source.schema_version >= 3
    const keys = [...caseKeys, ...(explicitCheck ? ['check_kind'] : []), ...(withFields ? ['required_fields'] : [])]
    const kinds = withFields ? [...checkKinds, 'json_fields'] : checkKinds
    const ids = new Set()
    const cases = Array.from(source.cases, item => {
      if (!exact(item, keys) || !uuid(item.case_id) || ids.has(item.case_id) ||
        !(item.expected_text === null || text(item.expected_text, 500)) ||
        (explicitCheck && (!kinds.includes(item.check_kind) ||
          (item.check_kind === 'exact_text' ? typeof item.expected_text !== 'string' : item.expected_text !== null)))) return invalid('definition')
      ids.add(item.case_id)
      return { case_id: item.case_id, ...acceptPromptTrialInputs(item), ...(explicitCheck ? { check_kind: item.check_kind } : {}), expected_text: item.expected_text,
        ...(withFields ? { required_fields: acceptRequiredFields(item, source.schema_version) } : {}) }
    })
    const result = { schema_version: source.schema_version, kind: 'mirofish_local_prompt_suite', name: source.name, cases }
    if (bytes(JSON.stringify(result)) > PROMPT_SUITE_MAX_BYTES) return invalid('definition')
    return result
  } catch { return invalid('definition') }
}

const parseBoundedJson = (source, maximumBytes, maximumDepth, kind, strictValues = false) =>
  parseJson(source, maximumBytes, maximumDepth, () => invalid(kind), strictValues)

// These limits apply to response format checks only. Legacy import projection
// still accepts ignored fields under the original bounded-parser rules.
function parseJsonObjectReply(content) {
  try {
    const result = parseBoundedJson(content, 64 * 1024, 16, 'JSON object reply', true)
    return result !== null && typeof result === 'object' && !Array.isArray(result) ? result : null
  } catch { return null }
}

export function isPromptSuiteJsonObjectReply(content) {
  return parseJsonObjectReply(content) !== null
}

export function parsePromptSuiteDefinition(source) {
  return acceptPromptSuiteDefinition(parseBoundedJson(source, PROMPT_SUITE_MAX_BYTES, 5, 'definition'))
}

export function parsePromptSuiteReport(source) {
  return acceptPromptSuiteReport(parseBoundedJson(source, PROMPT_SUITE_REPORT_MAX_BYTES, 12, 'report'))
}

export function exportPromptSuiteDefinition(source) {
  const result = JSON.stringify(acceptPromptSuiteDefinition(source), null, 2)
  if (bytes(result) > PROMPT_SUITE_MAX_BYTES) return invalid('definition')
  return result
}

const terminal = ['succeeded', 'truncated', 'refused', 'failed', 'timed_out', 'cancelled']
const reportKeys = ['schema_version', 'kind', 'run_id', 'definition', 'started_at', 'finished_at', 'status', 'stop_requested', 'halt_code', 'cases']
const rowKeys = ['case_id', 'request_id', 'status', 'check', 'snapshot', 'error_code']
const code = value => value === null || PROMPT_SUITE_ERROR_CODES.includes(value)
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)

export function acceptPromptSuiteReport(source) {
  try {
    if (!exact(source, reportKeys) || ![1, 2, 3, 4].includes(source.schema_version) || source.kind !== 'mirofish_local_prompt_suite_run' || !uuid(source.run_id) ||
      !timestamp(source.started_at) || !(source.finished_at === null || timestamp(source.finished_at)) ||
      !['running', 'completed', 'stopped', 'halted'].includes(source.status) || typeof source.stop_requested !== 'boolean' || !code(source.halt_code)) return invalid('report')
    const definition = acceptPromptSuiteDefinition(source.definition)
    if (source.schema_version !== definition.schema_version || !Array.isArray(source.cases) || source.cases.length !== definition.cases.length ||
      (source.status === 'running') !== (source.finished_at === null) ||
      (source.status === 'halted') !== (source.halt_code !== null) || (source.status === 'stopped' && !source.stop_requested)) return invalid('report')
    const ids = new Set(), cases = Array.from(source.cases, (row, index) => {
      const item = definition.cases[index]
      if (!exact(row, rowKeys) || row.case_id !== item.case_id || !['not_attempted', 'submitting', 'running', 'rejected', 'unknown', ...terminal].includes(row.status) ||
        !code(row.error_code) || !(row.request_id === null || uuid(row.request_id)) ||
        (row.status === 'not_attempted') !== (row.request_id === null) || (row.request_id !== null && ids.has(row.request_id))) return invalid('report')
      if (row.request_id !== null) ids.add(row.request_id)
      const snapshot = row.snapshot === null ? null : acceptPromptTrialSnapshot({ success: true, data: row.snapshot })
      if (snapshot && (!snapshot.run || snapshot.run.request_id !== row.request_id || !samePromptTrialRequest(snapshot.run.request, item))) return invalid('report')
      if ((terminal.includes(row.status) || row.status === 'running') && (!snapshot || snapshot.run.state !== row.status)) return invalid('report')
      if (['not_attempted', 'submitting', 'rejected'].includes(row.status) && snapshot !== null) return invalid('report')
      if (row.status === 'unknown' && snapshot !== null && snapshot.run.state !== 'running') return invalid('report')
      const check = evaluatePromptSuiteCheck(item, row.status, snapshot?.run.response?.content)
      if (row.check !== check) return invalid('report')
      return { case_id: row.case_id, request_id: row.request_id, status: row.status, check, snapshot, error_code: row.error_code }
    })
    if (source.status === 'completed' && cases.some(row => row.status !== 'succeeded')) return invalid('report')
    let unfinished = false
    for (const row of cases) {
      if (unfinished && row.status !== 'not_attempted') return invalid('report')
      if (row.status !== 'succeeded') unfinished = true
    }
    const result = { schema_version: source.schema_version, kind: 'mirofish_local_prompt_suite_run', run_id: source.run_id, definition,
      started_at: source.started_at, finished_at: source.finished_at, status: source.status, stop_requested: source.stop_requested, halt_code: source.halt_code, cases }
    if (bytes(JSON.stringify(result)) > PROMPT_SUITE_REPORT_MAX_BYTES) return invalid('report')
    return result
  } catch { return invalid('report') }
}

export function exportPromptSuiteReport(source) {
  const result = JSON.stringify(acceptPromptSuiteReport(source), null, 2)
  if (bytes(result) > PROMPT_SUITE_REPORT_MAX_BYTES) return invalid('report')
  return result
}

export function summarizePromptSuiteReport(source) {
  const { cases } = acceptPromptSuiteReport(source)
  const count = key => cases.filter(row => row.check === key).length
  return { total: cases.length, attempted: cases.filter(row => row.status !== 'not_attempted').length,
    succeeded: cases.filter(row => row.status === 'succeeded').length, evaluated: count('matched') + count('mismatched'),
    matched: count('matched'), mismatched: count('mismatched'), not_requested: count('not_requested'), not_evaluated: count('not_evaluated') }
}
