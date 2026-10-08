import { parseBoundedJson } from './boundedJson.js'

export const SAVED_ACTIVITY_FILE_MAX_BYTES = 8 * 1024 * 1024
const invalid = () => { throw new Error('Invalid or unsupported saved activity file') }
const platforms = ['twitter', 'reddit']
const availabilities = ['complete', 'partial', 'unavailable']
const filterKeys = ['platform', 'agent_id', 'round_num', 'action_type', 'q', 'case_sensitive', 'outcome']
const contextTextKeys = ['status', 'created_at', 'updated_at', 'started_at', 'completed_at']
const contextDecimalKeys = ['requested_rounds', 'last_saved_round']
const rootKeys = ['format_version', 'simulation_id', 'source_revision', 'observed_at', 'context', 'availability', 'platform_availability', 'warnings', 'filters', 'order', 'offset', 'limit', 'returned_count', 'matched_count', 'has_more', 'actions']
const rowKeys = ['record_id', 'platform', 'agent_id', 'round_num', 'agent_name', 'timestamp', 'action_type', 'success', 'match_preview', 'details_json']

const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const bounded = (value, maximum, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= maximum
const optionalText = value => value === null || typeof value === 'string'
// Compare the whole match: JavaScript's $ also matches before a final newline.
const decimal = value => typeof value === 'string' && /0|[1-9][0-9]*/.exec(value)?.[0] === value
const laterDecimal = (value, previous) => value.length > previous.length || value.length === previous.length && value > previous
function boundedText(value, maximum) {
  if (typeof value !== 'string' || !value.length) return false
  let length = 0
  for (const _character of value) if (++length > maximum) return false
  return true
}
function actionLabel(value) {
  // Python's strip() treats U+001C–U+001F as whitespace and preserves U+FEFF.
  // Source labels may contain controls; only query labels forbid those below.
  return boundedText(value, 256) && !/^[\p{White_Space}\u001c-\u001f]+$/u.test(value)
}
function queryText(value, maximum) {
  return boundedText(value, maximum) && !/^\p{White_Space}+$/u.test(value) && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
}
function validFilters(filters) {
  return exactKeys(filters, filterKeys)
    && (filters.platform === null || platforms.includes(filters.platform))
    && ['agent_id', 'round_num'].every(key => filters[key] === null || decimal(filters[key]) && filters[key].length <= 64)
    && (filters.action_type === null || queryText(filters.action_type, 256))
    && (filters.q === null || queryText(filters.q, 200))
    && typeof filters.case_sensitive === 'boolean'
    && (filters.outcome === null || ['success', 'failed', 'unknown'].includes(filters.outcome))
}
function validWarning(warning) {
  if (!warning || typeof warning !== 'object' || Array.isArray(warning)) return false
  if (['config_unavailable', 'run_state_unavailable', 'run_not_terminal', 'partial_run', 'no_action_logs'].includes(warning.code)) return exactKeys(warning, ['code'])
  if (['platform_log_missing', 'platform_not_configured'].includes(warning.code)) return exactKeys(warning, ['code', 'platform']) && platforms.includes(warning.platform)
  if (['source_unreadable', 'source_too_large', 'invalid_records'].includes(warning.code)) {
    const keys = ['code']
    if (warning.code === 'invalid_records') {
      keys.push('count')
      if (!bounded(warning.count, 500000, 1)) return false
    }
    if (Object.hasOwn(warning, 'platform')) {
      keys.push('platform')
      if (!platforms.includes(warning.platform)) return false
    }
    return exactKeys(warning, keys)
  }
  return false
}
function validPage(data) {
  if (!exactKeys(data, rootKeys) || data.format_version !== 1 || data.order !== 'source_record') return false
  const id = data.simulation_id
  if (typeof id !== 'string' || id.length < 1 || id.length > 128 || /[^A-Za-z0-9_-]/.test(id) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) return false
  if (typeof data.source_revision !== 'string' || data.source_revision.length !== 64 || /[^a-f0-9]/.test(data.source_revision) || typeof data.observed_at !== 'string') return false
  if (!exactKeys(data.context, [...contextTextKeys, ...contextDecimalKeys]) || !contextTextKeys.every(key => optionalText(data.context[key])) || !contextDecimalKeys.every(key => data.context[key] === null || decimal(data.context[key]))) return false
  if (!validFilters(data.filters) || !availabilities.includes(data.availability) || !exactKeys(data.platform_availability, platforms) || !platforms.every(platform => availabilities.includes(data.platform_availability[platform]))) return false
  // A disabled, missing platform can accompany complete overall coverage. Keep
  // the recorded coverage instead of reconstructing it without source metadata.
  if (data.filters.platform !== null && data.availability !== data.platform_availability[data.filters.platform]) return false
  if (!Array.isArray(data.warnings) || !data.warnings.every(validWarning)) return false
  if (!bounded(data.offset, 500000) || !bounded(data.limit, 100, 1) || !Array.isArray(data.actions) || !bounded(data.returned_count, data.limit) || data.returned_count !== data.actions.length || data.matched_count !== null && !bounded(data.matched_count, 500000) || typeof data.has_more !== 'boolean') return false
  if ((data.availability === 'unavailable') !== (data.matched_count === null) || data.has_more !== (data.matched_count !== null && data.offset + data.returned_count < data.matched_count) || data.returned_count > Math.max(0, (data.matched_count ?? 0) - data.offset)) return false
  // Refused sources contribute neither rows nor matches; oversized pages fail
  // at the producer. A successful page always contains its full recorded slice.
  if (data.returned_count !== Math.min(data.limit, Math.max(0, (data.matched_count ?? 0) - data.offset))) return false
  let previousSource = null, previousLine = null
  const ids = new Set()
  for (const row of data.actions) {
    if (!exactKeys(row, rowKeys) || !platforms.includes(row.platform) || data.platform_availability[row.platform] === 'unavailable' || !decimal(row.agent_id) || !decimal(row.round_num) || !optionalText(row.agent_name) || !optionalText(row.timestamp) || !actionLabel(row.action_type) || ![true, false, null].includes(row.success) || typeof row.details_json !== 'string') return false
    const record = typeof row.record_id === 'string' && /(twitter|reddit|legacy):([1-9][0-9]*)/.exec(row.record_id)
    if (!record || record[0] !== row.record_id || ids.has(row.record_id)) return false
    const [, source, line] = record
    if (source !== 'legacy' && source !== row.platform) return false
    if (previousSource !== null && ((source === 'legacy') !== (previousSource === 'legacy') || source === previousSource && !laterDecimal(line, previousLine) || source !== previousSource && platforms.indexOf(source) <= platforms.indexOf(previousSource))) return false
    ids.add(row.record_id); previousSource = source; previousLine = line
    if (['platform', 'agent_id', 'round_num', 'action_type'].some(key => data.filters[key] !== null && row[key] !== data.filters[key])) return false
    const outcome = row.success === true ? 'success' : row.success === false ? 'failed' : 'unknown'
    if (data.filters.outcome !== null && data.filters.outcome !== outcome) return false
    if (data.filters.q === null ? row.match_preview !== null : !boundedText(row.match_preview, 240)) return false
    // The excerpt and details are recorded evidence. Do not rerun Unicode
    // matching or parse details_json through JavaScript's numeric representation.
  }
  return true
}
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy))
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, frozenCopy(child)])))
  return value
}

// Accept only the current bare version-1 page download. No older producer shape
// is verified, so missing fields are never synthesized or silently defaulted.
export async function readSavedActivityFile(file) {
  try {
    const size = file?.size
    if (!Number.isSafeInteger(size) || size < 0 || size > SAVED_ACTIVITY_FILE_MAX_BYTES || typeof file.arrayBuffer !== 'function') invalid()
    const buffer = await file.arrayBuffer()
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== size || buffer.byteLength > SAVED_ACTIVITY_FILE_MAX_BYTES) invalid()
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
    const data = parseBoundedJson(text, SAVED_ACTIVITY_FILE_MAX_BYTES, 8, invalid, false, 10000)
    if (!validPage(data)) invalid()
    return frozenCopy(data)
  } catch { return invalid() }
}
