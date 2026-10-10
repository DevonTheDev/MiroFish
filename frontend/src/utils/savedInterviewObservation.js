// Shared admission rules for saved database reads and their unchanged JSON downloads.
const platforms = ['twitter', 'reddit'], filterKeys = ['platform', 'agent_id']
const limits = { rows_per_platform: 100, rows_total: 200, database_bytes: 167772160, wal_bytes: 67108864, vm_operations_per_platform: 2000000, lock_timeout_seconds: 0.25, payload_bytes: 16384, timestamp_bytes: 256, response_bytes: 4194304 }
const sourceWarnings = ['source_missing', 'source_unreadable', 'database_too_large', 'wal_too_large', 'query_limited', 'row_limit', 'response_limit', 'record_warnings']
const recordWarnings = ['invalid_agent_id', 'missing_timestamp', 'invalid_timestamp', 'timestamp_truncated', 'missing_payload', 'invalid_payload_type', 'invalid_utf8', 'invalid_json', 'invalid_payload_shape', 'invalid_payload_fields', 'missing_prompt', 'missing_response', 'payload_truncated']

export function validSavedInterviewDecimal(value, signed = false) {
  if (typeof value !== 'string' || value.length > 20 || (signed ? /0|-?[1-9][0-9]*/ : /0|[1-9][0-9]*/).exec(value)?.[0] !== value) return false
  const number = BigInt(value)
  return number <= 9223372036854775807n && number >= (signed ? -9223372036854775808n : 0n)
}

// Match backend storage.validate_record_id before trusting a file's selection.
export function validSavedInterviewSelection(selected) {
  if (!savedInterviewExactKeys(selected, ['simulation_id', 'filters'])) return false
  const id = selected.simulation_id
  if (typeof id !== 'string' || !id.length || id.length > 128 || /[^A-Za-z0-9_-]/.test(id) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) return false
  return savedInterviewExactKeys(selected.filters, filterKeys)
    && (selected.filters.platform === null || platforms.includes(selected.filters.platform))
    && (selected.filters.agent_id === null || validSavedInterviewDecimal(selected.filters.agent_id))
}

export function savedInterviewExactKeys(value, keys) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
export function validSavedInterviewObservation(data, selected) {
  if (!validSavedInterviewSelection(selected)) return false
  const bounded = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max
  const text = (value, max) => value === null || typeof value === 'string' && [...value].length <= max
  const warnings = (value, allowed) => Array.isArray(value) && value.length <= allowed.length && new Set(value).size === value.length && value.every(code => allowed.includes(code))
  const envelopeKeys = ['version', 'simulation_id', 'filters', 'observed_at', 'order', 'limits', 'availability', 'sources', 'records']
  if (data?.version === 2) envelopeKeys.push('window')
  if (!savedInterviewExactKeys(data, envelopeKeys) || ![1, 2].includes(data.version) || data.simulation_id !== selected.simulation_id || data.order !== 'platform_then_row_desc' || typeof data.observed_at !== 'string' || !data.observed_at || data.observed_at.length > 100) return false
  if (data.version === 2 && (selected.filters.platform === null || !savedInterviewExactKeys(data.window, ['before_row', 'source_revision'])
    || data.window.before_row !== null && !validSavedInterviewDecimal(data.window.before_row, true)
    || typeof data.window.source_revision !== 'string' || !/^[0-9a-f]{64}$/.test(data.window.source_revision))) return false
  const expectedLimits = { ...limits, response_bytes_per_platform: selected.filters.platform === null ? 2093056 : 4186112 }
  if (!savedInterviewExactKeys(data.filters, filterKeys) || filterKeys.some(key => data.filters[key] !== selected.filters[key]) || !savedInterviewExactKeys(data.limits, Object.keys(expectedLimits)) || Object.keys(expectedLimits).some(key => data.limits[key] !== expectedLimits[key])) return false
  if (!savedInterviewExactKeys(data.sources, platforms) || !Array.isArray(data.records) || data.records.length > limits.rows_total) return false
  const counts = { twitter: 0, reddit: 0 }, warned = { twitter: false, reddit: false }
  let previousPlatform = -1, previousRow = null
  for (const row of data.records) {
    if (!savedInterviewExactKeys(row, ['platform', 'row_id', 'record_id', 'agent_id', 'timestamp', 'prompt', 'response', 'payload_kind', 'raw_preview', 'payload_bytes', 'truncated', 'warnings']) || !platforms.includes(row.platform) || !validSavedInterviewDecimal(row.row_id, true) || row.record_id !== `${row.platform}:${row.row_id}` || row.agent_id !== null && !validSavedInterviewDecimal(row.agent_id)) return false
    if (selected.filters.platform !== null && row.platform !== selected.filters.platform || selected.filters.agent_id !== null && row.agent_id !== selected.filters.agent_id) return false
    const index = platforms.indexOf(row.platform), rowId = BigInt(row.row_id)
    if (data.version === 2 && data.window.before_row !== null && rowId >= BigInt(data.window.before_row)) return false
    if (index < previousPlatform || index === previousPlatform && rowId >= previousRow) return false
    previousPlatform = index; previousRow = rowId
    if (!text(row.timestamp, limits.timestamp_bytes) || !text(row.prompt, limits.payload_bytes) || !text(row.response, limits.payload_bytes) || !text(row.raw_preview, limits.payload_bytes) || typeof row.truncated !== 'boolean' || !warnings(row.warnings, recordWarnings)) return false
    if (row.payload_kind === 'structured') {
      if (row.raw_preview !== null || !bounded(row.payload_bytes, limits.payload_bytes)) return false
    } else if (row.payload_kind === 'raw') {
      if (row.prompt !== null || row.response !== null || typeof row.raw_preview !== 'string' || !bounded(row.payload_bytes) || !row.warnings.some(code => ['invalid_payload_type', 'invalid_utf8', 'invalid_json', 'invalid_payload_shape', 'invalid_payload_fields', 'payload_truncated'].includes(code))) return false
    } else if (row.payload_kind === 'missing') {
      if (row.prompt !== null || row.response !== null || row.raw_preview !== null || row.payload_bytes !== null) return false
    } else return false
    if (row.agent_id === null && !row.warnings.includes('invalid_agent_id') || row.timestamp === null && !row.warnings.some(code => ['missing_timestamp', 'invalid_timestamp'].includes(code))) return false
    if (row.payload_kind === 'structured' && (row.prompt === null && !row.warnings.includes('missing_prompt') || row.response === null && !row.warnings.includes('missing_response'))) return false
    if (row.payload_kind === 'missing' && !row.warnings.includes('missing_payload') || row.truncated !== row.warnings.some(code => ['timestamp_truncated', 'payload_truncated'].includes(code))) return false
    counts[row.platform]++; warned[row.platform] ||= row.warnings.length > 0
  }
  const coverages = []
  for (const platform of platforms) {
    const item = data.sources[platform], requested = selected.filters.platform === null || selected.filters.platform === platform
    if (!savedInterviewExactKeys(item, ['status', 'returned_count', 'has_more', 'coverage', 'warnings']) || !['available', 'missing', 'unreadable', 'too_large', 'query_limited', 'not_requested'].includes(item.status) || !bounded(item.returned_count, limits.rows_per_platform) || item.returned_count !== counts[platform] || ![true, false, null].includes(item.has_more) || !warnings(item.warnings, sourceWarnings)) return false
    if (!requested) {
      if (item.status !== 'not_requested' || item.coverage !== 'not_requested' || item.returned_count !== 0 || item.has_more !== null || item.warnings.length !== 0) return false
      continue
    }
    if (item.status === 'not_requested' || !['complete', 'partial', 'unavailable'].includes(item.coverage)) return false
    if (['missing', 'too_large'].includes(item.status) && item.returned_count !== 0) return false
    if (item.status === 'available') {
      if (item.has_more === null || item.coverage !== (item.has_more || item.warnings.length ? 'partial' : 'complete') || item.warnings.some(code => !['row_limit', 'response_limit', 'record_warnings'].includes(code))) return false
      if (item.has_more !== item.warnings.some(code => ['row_limit', 'response_limit'].includes(code)) || item.warnings.includes('row_limit') && item.returned_count !== limits.rows_per_platform) return false
    } else {
      const reasons = { missing: ['source_missing'], unreadable: ['source_unreadable'], too_large: ['database_too_large', 'wal_too_large'], query_limited: ['query_limited'] }[item.status]
      if (item.has_more !== null || item.coverage !== (item.returned_count ? 'partial' : 'unavailable') || !item.warnings.some(code => reasons.includes(code)) || item.warnings.some(code => ![...reasons, 'record_warnings'].includes(code))) return false
    }
    if (warned[platform] !== item.warnings.includes('record_warnings')) return false
    coverages.push(item.coverage)
  }
  const availability = coverages.every(value => value === 'complete') ? 'complete' : coverages.some(value => ['complete', 'partial'].includes(value)) ? 'partial' : 'unavailable'
  if (data.availability !== availability) return false
  // The backend accounts for ASCII-escaped JSON; count the same conservative
  // representation before accepting any data into an exportable observation.
  return JSON.stringify({ success: true, data }).replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).length <= limits.response_bytes
}
