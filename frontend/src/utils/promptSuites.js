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

export function acceptPromptSuiteDefinition(source) {
  try {
    if (!exact(source, definitionKeys) || source.schema_version !== 1 || source.kind !== 'mirofish_local_prompt_suite' ||
      !text(source.name, 80, true, true) || !Array.isArray(source.cases) || source.cases.length < 1 || source.cases.length > 5) return invalid('definition')
    const ids = new Set()
    const cases = Array.from(source.cases, item => {
      if (!exact(item, caseKeys) || !uuid(item.case_id) || ids.has(item.case_id) ||
        !(item.expected_text === null || text(item.expected_text, 500))) return invalid('definition')
      ids.add(item.case_id)
      return { case_id: item.case_id, ...acceptPromptTrialInputs(item), expected_text: item.expected_text }
    })
    const result = { schema_version: 1, kind: 'mirofish_local_prompt_suite', name: source.name, cases }
    if (bytes(JSON.stringify(result)) > PROMPT_SUITE_MAX_BYTES) return invalid('definition')
    return result
  } catch { return invalid('definition') }
}

// JSON.parse silently overwrites duplicate keys. This bounded parser rejects them,
// including escaped aliases, before schema admission. Depth is capped before recursion.
function parseBoundedJson(source, maximumBytes, maximumDepth, kind) {
  try {
    if (typeof source !== 'string' || bytes(source) > maximumBytes) return invalid(kind)
    let cursor = 0
    const whitespace = () => { while (/[\t\n\r ]/.test(source[cursor] ?? '\0')) cursor++ }
    function string() {
      const start = cursor++
      while (cursor < source.length) {
        const character = source[cursor++]
        if (character === '\\') cursor++
        else if (character === '"') return JSON.parse(source.slice(start, cursor))
      }
      return invalid(kind)
    }
    function value(depth) {
      if (depth > maximumDepth) return invalid(kind)
      whitespace()
      if (source[cursor] === '"') return string()
      if (source[cursor] === '{' || source[cursor] === '[') {
        const array = source[cursor++] === '[', end = array ? ']' : '}', result = array ? [] : Object.create(null), keys = new Set()
        whitespace()
        if (source[cursor] === end) { cursor++; return result }
        while (cursor < source.length) {
          whitespace()
          if (array) result.push(value(depth + 1))
          else {
            if (source[cursor] !== '"') return invalid(kind)
            const key = string()
            if (keys.has(key)) return invalid(kind)
            keys.add(key); whitespace()
            if (source[cursor++] !== ':') return invalid(kind)
            result[key] = value(depth + 1)
          }
          whitespace()
          if (source[cursor] === end) { cursor++; return result }
          if (source[cursor++] !== ',') return invalid(kind)
        }
        return invalid(kind)
      }
      const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor))?.[0]
      if (!token) return invalid(kind)
      cursor += token.length
      return JSON.parse(token)
    }
    const result = value(0); whitespace()
    if (cursor !== source.length) return invalid(kind)
    return result
  } catch { return invalid(kind) }
}

export function parsePromptSuiteDefinition(source) {
  return acceptPromptSuiteDefinition(parseBoundedJson(source, PROMPT_SUITE_MAX_BYTES, 4, 'definition'))
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
    if (!exact(source, reportKeys) || source.schema_version !== 1 || source.kind !== 'mirofish_local_prompt_suite_run' || !uuid(source.run_id) ||
      !timestamp(source.started_at) || !(source.finished_at === null || timestamp(source.finished_at)) ||
      !['running', 'completed', 'stopped', 'halted'].includes(source.status) || typeof source.stop_requested !== 'boolean' || !code(source.halt_code)) return invalid('report')
    const definition = acceptPromptSuiteDefinition(source.definition)
    if (!Array.isArray(source.cases) || source.cases.length !== definition.cases.length ||
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
      const check = row.status !== 'succeeded' ? 'not_evaluated' : item.expected_text === null ? 'not_requested' :
        snapshot.run.response.content === item.expected_text ? 'matched' : 'mismatched'
      if (row.check !== check) return invalid('report')
      return { case_id: row.case_id, request_id: row.request_id, status: row.status, check, snapshot, error_code: row.error_code }
    })
    if (source.status === 'completed' && cases.some(row => row.status !== 'succeeded')) return invalid('report')
    let unfinished = false
    for (const row of cases) {
      if (unfinished && row.status !== 'not_attempted') return invalid('report')
      if (row.status !== 'succeeded') unfinished = true
    }
    const result = { schema_version: 1, kind: 'mirofish_local_prompt_suite_run', run_id: source.run_id, definition,
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
