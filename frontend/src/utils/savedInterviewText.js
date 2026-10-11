import { validSavedInterviewObservation } from './savedInterviewObservation.js'

export const SAVED_INTERVIEW_TEXT_MAX_BYTES = 8 * 1024 * 1024
const limitKeys = ['rows_per_platform', 'rows_total', 'database_bytes', 'wal_bytes', 'vm_operations_per_platform', 'lock_timeout_seconds', 'payload_bytes', 'timestamp_bytes', 'response_bytes', 'response_bytes_per_platform']
const invalid = () => { throw new Error('Saved interview text could not be formatted') }

// Present individual values, not a TXT interchange format. The Unicode-aware
// match leaves ordinary surrogate pairs intact and catches lone surrogates
// before Blob/TextEncoder could replace them. Astral format controls are made
// visible as their two UTF-16 units. Escape source backslashes in the same pass.
function visibleValue(value) {
  return value.replace(/\\|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, character => {
    if (character === '\n') return '\n'
    if (character === '\\') return '\\\\'
    if (character === '\r') return '\\r'
    if (character === '\t') return '\\t'
    return character.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  })
}

export function formatSavedInterviewText(data) {
  try {
    if (!validSavedInterviewObservation(data, { simulation_id: data?.simulation_id, filters: data?.filters })) invalid()
    const chunks = [], encoder = new TextEncoder()
    let bytes = 0
    const append = chunk => {
      bytes += encoder.encode(chunk).byteLength
      if (bytes > SAVED_INTERVIEW_TEXT_MAX_BYTES) invalid()
      chunks.push(chunk)
    }
    const scalar = (label, value) => append(`${label}: ${value}\n`)
    const field = (label, value, nullState = 'unavailable or inapplicable') => {
      append(`${label}:\n`)
      if (value === null) append(`[null; ${nullState}]\n`)
      else if (value === '') append('[empty saved string]\n')
      else append('  ' + visibleValue(value).replace(/\n/g, '\n  ') + '\n')
    }
    const warnings = codes => {
      append('warnings:\n')
      append(codes.length ? codes.map(code => `  ${code}\n`).join('') : '[none recorded]\n')
    }

    append('Saved interview observation\n\n')
    append('Scope: all rows in this accepted observation or window, regardless of local search, selected question or page. Other windows are not included.\n')
    append('Saved prompts may include context. Records do not reconstruct conversation sessions, unique respondents, historical names, model versions or conclusions.\n')
    append('Coverage describes the recorded bounded observation. This transcript does not establish authenticity or current availability.\n')
    append('Order follows captured physical row order, not proven chronological order across sources. Repeated answers remain separate rows.\n')
    append('Encoding: fixed English labels; two-space-indented string values preserve ordinary Unicode, spaces and every LF, including empty lines. CR, tab, backslashes, other controls and lone surrogates use visible escapes.\n')
    append('Escapes present individual values; this is not a TXT import or roundtrip format. Indentation and the final LF are report formatting. JSON remains the canonical machine-readable observation.\n')
    append('Null and empty states are unindented markers. Recorded replacement characters, raw previews and truncation warnings are retained; original storage bytes cannot be recovered here.\n\n')

    append('Observation\n')
    scalar('version', data.version)
    field('simulation_id', data.simulation_id)
    field('observed_at', data.observed_at)
    field('platform_filter', data.filters.platform, 'no platform filter')
    field('agent_id_filter', data.filters.agent_id, 'no exact-agent filter')
    scalar('availability', data.availability)
    scalar('record_count', data.records.length)
    scalar('order', data.order)
    if (data.version === 2) {
      append('\nRecorded window\n')
      field('before_row', data.window.before_row, 'newest captured window')
      field('source_revision', data.window.source_revision)
    } else append('\nWindow metadata: not recorded (version 1)\n')

    append('\nRecorded limits\n')
    for (const key of limitKeys) scalar(key, data.limits[key])
    append('\nRecorded sources\nCounts are recorded returned rows, not total source counts; null has_more means unknown or inapplicable, not false.\n')
    for (const [platform, name] of [['twitter', 'Twitter'], ['reddit', 'Reddit']]) {
      const source = data.sources[platform]
      append(`\nSource: ${name}\n`)
      for (const key of ['status', 'returned_count', 'has_more', 'coverage']) scalar(key, source[key])
      warnings(source.warnings)
    }

    append('\nRecords in captured order\n')
    for (const [index, row] of data.records.entries()) {
      append(`\nRecord ${index + 1}\n`)
      scalar('platform', row.platform)
      for (const key of ['record_id', 'row_id', 'agent_id', 'timestamp']) field(key, row[key])
      for (const key of ['payload_kind', 'payload_bytes', 'truncated']) scalar(key, row[key])
      warnings(row.warnings)
      field('saved_prompt', row.prompt)
      field('saved_response', row.response)
      field('raw_preview (not decoded into a question and reply)', row.raw_preview)
    }
    // Each complete escaped field/metadata chunk was counted before assembly.
    // Reject the whole operation on any failure; never return a partial report.
    return chunks.join('')
  } catch { return invalid() }
}
