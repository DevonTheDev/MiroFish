import { parseBoundedJson } from './boundedJson.js'

export const RUN_CAPTURE_FILE_MAX_BYTES = 2 * 1024 * 1024
const MAX_CAPTURE_BYTES = 256 * 1024
const MAX_COUNT = 500000
const platforms = ['twitter', 'reddit']
const availability = new Set(['complete', 'partial', 'unavailable'])
const terminal = new Set(['completed', 'stopped', 'failed'])
const warningCodes = new Set(['config_unavailable', 'run_state_unavailable', 'partial_run', 'no_action_logs', 'source_unreadable', 'source_too_large', 'invalid_records', 'platform_not_configured', 'platform_log_missing'])
const summaryKeys = ['simulation_id', 'project_id', 'graph_id', 'scenario', 'configured_model', 'configured_agents', 'status', 'created_at', 'updated_at', 'started_at', 'completed_at', 'requested_rounds', 'last_saved_round', 'availability', 'warnings', 'metrics']
const admitted = new WeakSet()
const invalid = () => { throw new Error('Invalid run capture file') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Python str.strip includes these separators, but excludes U+FEFF. Historical
// action names use that policy too, and may otherwise contain controls/surrogates.
const nonblank = value => /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(value)
const codepoints = value => [...value].length

function keys(value, expected) {
  if (!object(value) || Object.keys(value).length !== expected.length || !expected.every(key => Object.hasOwn(value, key))) invalid()
}
function string(value, nullable = false) {
  if (typeof value !== 'string' && !(nullable && value === null)) invalid()
}
function count(value, nullable = false) {
  if (!(nullable && value === null) && (!Number.isInteger(value) || value < 0 || value > MAX_COUNT)) invalid()
}
function timestamp(value) {
  // Admit the UTC spellings exported by Python/JavaScript, without Date.parse's
  // rollover dates or datetime.fromisoformat's unrelated week/compact forms.
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|\+00:00)$/.exec(value)
  if (!match) invalid()
  const [, year, month, day, hour, minute, second] = match.map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) invalid()
}
function codepointOrder(left, right) {
  const a = Array.from(left, char => char.codePointAt(0)), b = Array.from(right, char => char.codePointAt(0))
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

// Only called after schema admission. Key order has no effect on byte length.
// Python ensure_ascii also escapes DEL, and astral characters use TWO \uXXXX
// escapes. Count UTF-16 units here, without allocating a second encoded payload.
function canonicalBytes(value) {
  if (typeof value === 'string') {
    let size = 2
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i)
      size += unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit) ? 2 : unit < 32 || unit >= 127 ? 6 : 1
      if (size > MAX_CAPTURE_BYTES) return size
    }
    return size
  }
  if (value === null) return 4
  if (typeof value === 'number') return String(value).length
  const entries = Array.isArray(value) ? value : Object.entries(value)
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, entry) => sum + (Array.isArray(value) ? canonicalBytes(entry) : canonicalBytes(entry[0]) + 1 + canonicalBytes(entry[1])), 0)
}

function validateCapture(value) {
  keys(value, ['schema_version', 'capture_id', 'label', 'note', 'captured_at', 'observation'])
  if (value.schema_version !== 1 || typeof value.capture_id !== 'string' || !/^[0-9a-f]{32}$/.test(value.capture_id)) invalid()
  string(value.label); string(value.note)
  if (codepoints(value.label) < 1 || codepoints(value.label) > 120 || !nonblank(value.label) || codepoints(value.note) > 2000 ||
      /\p{Cs}/u.test(value.label) || /\p{Cs}/u.test(value.note) || /[\u0000-\u001f\u007f-\u009f]/u.test(value.label) || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value.note)) invalid()
  timestamp(value.captured_at)
  const observation = value.observation
  keys(observation, ['schema_version', 'source_revision', 'observed_at', 'summary'])
  if (observation.schema_version !== 1 || typeof observation.source_revision !== 'string' || !/^[0-9a-f]{64}$/.test(observation.source_revision)) invalid()
  timestamp(observation.observed_at)
  const summary = observation.summary
  keys(summary, summaryKeys)
  if (typeof summary.simulation_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(summary.simulation_id) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(summary.simulation_id) || !terminal.has(summary.status) || !availability.has(summary.availability)) invalid()
  for (const name of ['project_id', 'graph_id', 'configured_model', 'created_at', 'updated_at', 'started_at', 'completed_at']) string(summary[name], true)
  string(summary.scenario)
  for (const name of ['configured_agents', 'requested_rounds', 'last_saved_round']) if (summary[name] !== null && (typeof summary[name] !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(summary[name]))) invalid()
  if (!Array.isArray(summary.warnings) || summary.warnings.length > 32) invalid()
  for (const warning of summary.warnings) {
    if (!object(warning) || !Object.hasOwn(warning, 'code') || !warningCodes.has(warning.code) || Object.keys(warning).some(key => !['code', 'platform', 'count'].includes(key))) invalid()
    if (Object.hasOwn(warning, 'platform') && !platforms.includes(warning.platform)) invalid()
    if (Object.hasOwn(warning, 'count')) {
      count(warning.count)
      if (warning.code !== 'invalid_records' || warning.count === 0) invalid()
    } else if (warning.code === 'invalid_records') invalid()
  }
  const metrics = summary.metrics
  keys(metrics, ['recorded_actions', 'rounds_with_actions', 'platforms', 'action_types'])
  keys(metrics.platforms, platforms)
  count(metrics.recorded_actions, true); count(metrics.rounds_with_actions, true)
  for (const platform of Object.values(metrics.platforms)) {
    keys(platform, ['availability', 'recorded_actions', 'active_agents'])
    if (!availability.has(platform.availability)) invalid()
    for (const name of ['recorded_actions', 'active_agents']) {
      count(platform[name], true)
      if ((platform[name] === null) !== (platform.availability === 'unavailable')) invalid()
    }
    if (platform.availability !== 'unavailable' && platform.active_agents > platform.recorded_actions) invalid()
  }
  if (!Array.isArray(metrics.action_types) || metrics.action_types.length > 256) invalid()
  let previous = null
  for (const item of metrics.action_types) {
    keys(item, ['action_type', 'count']); string(item.action_type); count(item.count)
    if (!nonblank(item.action_type) || codepoints(item.action_type) > 256 || item.count === 0 || (previous !== null && codepointOrder(previous, item.action_type) >= 0)) invalid()
    previous = item.action_type
  }
  if (summary.availability === 'unavailable') {
    if (metrics.recorded_actions !== null || metrics.rounds_with_actions !== null || metrics.action_types.length || Object.values(metrics.platforms).some(platform => platform.availability !== 'unavailable')) invalid()
  } else {
    if (metrics.recorded_actions === null || metrics.rounds_with_actions === null || metrics.rounds_with_actions > metrics.recorded_actions ||
        metrics.action_types.reduce((sum, item) => sum + item.count, 0) !== metrics.recorded_actions ||
        Object.values(metrics.platforms).reduce((sum, item) => sum + (item.recorded_actions ?? 0), 0) !== metrics.recorded_actions ||
        (summary.availability === 'complete' && Object.values(metrics.platforms).some(item => item.availability === 'partial'))) invalid()
  }
  if (canonicalBytes(value) > MAX_CAPTURE_BYTES) invalid()
}

function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy))
  if (object(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, frozenCopy(child)])))
  return value
}
function admitCapture(value) {
  if (object(value) && admitted.has(value)) return value
  validateCapture(value)
  const result = frozenCopy(value)
  admitted.add(result)
  return result
}
function differences(leftCapture, rightCapture) {
  const left = leftCapture.observation.summary, right = rightCapture.observation.summary
  const complete = left.availability === 'complete' && right.availability === 'complete'
  const leftMetrics = left.metrics, rightMetrics = right.metrics
  const result = {
    recorded_actions: complete ? rightMetrics.recorded_actions - leftMetrics.recorded_actions : null,
    rounds_with_actions: complete ? rightMetrics.rounds_with_actions - leftMetrics.rounds_with_actions : null,
    platforms: {}, action_types: [],
  }
  for (const name of platforms) {
    const a = leftMetrics.platforms[name], b = rightMetrics.platforms[name]
    const comparable = a.availability === 'complete' && b.availability === 'complete'
    result.platforms[name] = { recorded_actions: comparable ? b.recorded_actions - a.recorded_actions : null, active_agents: comparable ? b.active_agents - a.active_agents : null }
  }
  const a = new Map(leftMetrics.action_types.map(item => [item.action_type, item.count]))
  const b = new Map(rightMetrics.action_types.map(item => [item.action_type, item.count]))
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort(codepointOrder)) {
    const leftCount = a.has(name) ? a.get(name) : left.availability === 'complete' ? 0 : null
    const rightCount = b.has(name) ? b.get(name) : right.availability === 'complete' ? 0 : null
    result.action_types.push({ action_type: name, left: leftCount, right: rightCount, difference: complete ? rightCount - leftCount : null })
  }
  return result
}
function equal(left, right) {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
}

function integerTokens(source) {
  // boundedJson protects syntax/duplicates/depth. This second linear scan only
  // retains Python's int-vs-float distinction, lost by JavaScript JSON numbers.
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '"') {
      while (++i < source.length && source[i] !== '"') if (source[i] === '\\') i++
    } else if (source[i] === '-' || /[0-9]/.test(source[i])) {
      while (i < source.length && /[0-9eE.+-]/.test(source[i])) {
        if (/[eE.]/.test(source[i])) invalid()
        i++
      }
      i--
    }
  }
}

export function parseRunCaptureFile(source) {
  try {
    if (typeof source !== 'string' || source.length > RUN_CAPTURE_FILE_MAX_BYTES || /\p{Cs}/u.test(source)) invalid()
    const raw = parseBoundedJson(source, RUN_CAPTURE_FILE_MAX_BYTES, 10, invalid)
    integerTokens(source)
    if (!object(raw)) invalid()
    if (Object.hasOwn(raw, 'capture_id')) return Object.freeze({ kind: 'capture', captures: Object.freeze([admitCapture(raw)]) })
    keys(raw, ['schema_version', 'left', 'right', 'differences', 'generated_at'])
    if (raw.schema_version !== 1) invalid()
    timestamp(raw.generated_at)
    const left = admitCapture(raw.left), right = admitCapture(raw.right)
    if (left.capture_id === right.capture_id || !equal(raw.differences, differences(left, right))) invalid()
    return Object.freeze({ kind: 'comparison', captures: Object.freeze([left, right]), generated_at: raw.generated_at })
  } catch { return invalid() }
}

export async function readRunCaptureFile(file) {
  try {
    const size = file?.size
    if (!Number.isInteger(size) || size < 0 || size > RUN_CAPTURE_FILE_MAX_BYTES || typeof file.arrayBuffer !== 'function') invalid()
    const buffer = await file.arrayBuffer()
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== size || buffer.byteLength > RUN_CAPTURE_FILE_MAX_BYTES) invalid()
    return parseRunCaptureFile(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer))
  } catch { return invalid() }
}

export function compareRunCaptureFiles(left, right, generatedAt = new Date().toISOString()) {
  try {
    timestamp(generatedAt)
    const a = admitCapture(left), b = admitCapture(right)
    if (a.capture_id === b.capture_id) invalid()
    return Object.freeze({ schema_version: 1, left: a, right: b, differences: frozenCopy(differences(a, b)), generated_at: generatedAt })
  } catch { return invalid() }
}
